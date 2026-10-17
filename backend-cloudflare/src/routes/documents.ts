import { Hono } from "hono";
import type { Env } from "../config";
import type { Sql } from "../db";
import type { TenantContext } from "../auth/supabase";
import { requireAuth } from "../middleware/auth";
import { uploadBytes, downloadBytes, buildStorageKey, signDownloadToken, verifyDownloadToken } from "../storage";
import {
  createDocument, getDocumentById, listDocumentsByTenant, updateDocumentFields, findDuplicateDocument,
  softDeleteDocument, restoreDocument,
} from "../repository/documents";
import { appendAuditLog, listAuditLogForEntity } from "../repository/auditLog";
import { createAnomaly } from "../repository/anomalies";
import { processDocument, parseOcrLines } from "../pipelines/ocr";
import { finalizeOcrResult } from "../queue/consumer";
import { apiError } from "../http";

export const documentRoutes = new Hono<{ Bindings: Env; Variables: { sql: Sql; tenant: TenantContext } }>();

documentRoutes.use("*", requireAuth);

// POST /documents/upload — mirrors HandleUpload, with one real
// architecture change: OCR happens in the browser before this request
// is even made (frontend/src/ocr/), and the extracted lines travel
// alongside the file as the `ocr_lines` form field. This runs
// processDocument() synchronously right here instead of enqueuing onto
// OCR_QUEUE — there's no Lambda round trip to wait on anymore, just
// regex extraction, so there's no reason to make this async. If
// `ocr_lines` is missing/malformed (old client, unsupported browser,
// tampered request), this still succeeds — the document just lands
// with ocrAvailable: false for manual correction, same graceful
// degradation as the WhatsApp/email ingestion paths in webhooks.ts.
documentRoutes.post("/upload", async (c) => {
  const form = await c.req.formData();
  const file = form.get("file");
  const docType = (form.get("doc_type") as string) || "INVOICE";
  if (!(file instanceof File)) return apiError(c, 400, "VALIDATION_ERROR", 'file is required (multipart field "file")');
  if (file.size > 15 * 1024 * 1024) return apiError(c, 400, "VALIDATION_ERROR", "file exceeds 15MB limit");

  const tenant = c.get("tenant");
  const sql = c.get("sql");
  const doc = await createDocument(sql, {
    tenantId: tenant.tenantId,
    docType,
    originalFilename: file.name,
    storageKey: "", // filled in right after, once we know documentId
    mimeType: file.type || "application/octet-stream",
    fileSizeBytes: file.size,
    ingestChannel: "WEB_UPLOAD",
  });

  const storageKey = buildStorageKey(tenant.tenantId, doc.documentId, file.name);
  await uploadBytes(c.env, storageKey, await file.arrayBuffer(), file.type);
  await sql`update documents set storage_key = ${storageKey} where document_id = ${doc.documentId}`;

  const lines = parseOcrLines(form.get("ocr_lines") as string | null);
  const result = processDocument(lines ?? []);
  await finalizeOcrResult(c.env, sql, tenant.tenantId, doc.documentId, result);

  const updatedDoc = await getDocumentById(sql, tenant.tenantId, doc.documentId);
  return c.json({ ...(updatedDoc ?? doc), storageKey }, 201);
});

// GET /documents — mirrors HandleList's filters + pagination.
documentRoutes.get("/", async (c) => {
  const q = c.req.query();
  const limit = Math.min(parseInt(q.limit ?? "50", 10) || 50, 200);
  const offset = parseInt(q.offset ?? "0", 10) || 0;
  const rows = await listDocumentsByTenant(c.get("sql"), c.get("tenant").tenantId, {
    status: q.status, docType: q.doc_type, gstPortalStatus: q.gst_status, fromDate: q.from_date, toDate: q.to_date, limit, offset,
  });
  return c.json({ documents: rows, limit, offset });
});

documentRoutes.get("/:id", async (c) => {
  const doc = await getDocumentById(c.get("sql"), c.get("tenant").tenantId, c.req.param("id"));
  if (!doc) return apiError(c, 404, "NOT_FOUND", "document not found");
  return c.json(doc);
});

// GET /documents/:id/download-url — mirrors HandleDownloadURL. Instead
// of an S3 presigned URL, this issues our own short-lived signed token
// (see storage.ts) for the streaming route below.
documentRoutes.get("/:id/download-url", async (c) => {
  const doc = await getDocumentById(c.get("sql"), c.get("tenant").tenantId, c.req.param("id"));
  if (!doc) return apiError(c, 404, "NOT_FOUND", "document not found");
  const { token, exp } = await signDownloadToken(c.env, doc.storageKey);
  return c.json({ url: `/api/v1/documents/${doc.documentId}/download?token=${token}&exp=${exp}` });
});

documentRoutes.get("/:id/download", async (c) => {
  const doc = await getDocumentById(c.get("sql"), c.get("tenant").tenantId, c.req.param("id"));
  if (!doc) return apiError(c, 404, "NOT_FOUND", "document not found");
  const token = c.req.query("token") ?? "";
  const exp = parseInt(c.req.query("exp") ?? "0", 10);
  if (!(await verifyDownloadToken(c.env, doc.storageKey, token, exp))) return apiError(c, 403, "FORBIDDEN", "invalid or expired download link");
  const bytes = await downloadBytes(c.env, doc.storageKey);
  if (!bytes) return apiError(c, 404, "NOT_FOUND", "file missing from storage");
  return new Response(bytes, { headers: { "Content-Type": doc.mimeType, "Content-Disposition": `attachment; filename="${doc.originalFilename}"` } });
});

// PATCH /documents/:id/correct — mirrors HandleCorrect: one audit-log
// row per changed field, then flips manually_corrected. Also re-checks
// for a duplicate now that the human-corrected vendor/invoice number is
// authoritative.
documentRoutes.patch("/:id/correct", async (c) => {
  const tenant = c.get("tenant");
  const sql = c.get("sql");
  const documentId = c.req.param("id");
  const existing = await getDocumentById(sql, tenant.tenantId, documentId);
  if (!existing) return apiError(c, 404, "NOT_FOUND", "document not found");

  const { reason, ...fields } = await c.req.json();
  const patchable = ["vendorName", "vendorAddress", "documentDate", "invoiceNumber", "rawTotalAmount", "taxAmount", "taxIdentifier"] as const;
  for (const key of patchable) {
    if (fields[key] !== undefined && String(fields[key]) !== String((existing as any)[key] ?? "")) {
      await appendAuditLog(sql, {
        tenantId: tenant.tenantId, entityType: "DOCUMENT", entityId: documentId, action: "FIELD_CORRECTED",
        fieldName: key, oldValue: String((existing as any)[key] ?? ""), newValue: String(fields[key]), reason, actorEmail: tenant.ownerEmail,
      });
    }
  }

  const updated = await updateDocumentFields(sql, tenant.tenantId, documentId, { ...fields, manuallyCorrected: true, correctedBy: tenant.ownerEmail });

  if (updated.vendorName) {
    const dup = await findDuplicateDocument(sql, tenant.tenantId, updated.vendorName, updated.invoiceNumber, updated.rawTotalAmount ? parseFloat(updated.rawTotalAmount) : null, updated.documentDate, documentId);
    if (dup) {
      await createAnomaly(sql, {
        tenantId: tenant.tenantId, documentId, anomalyType: "DUPLICATE_INVOICE", severity: "MEDIUM",
        description: `Possible duplicate of document ${dup.documentId} (same vendor/invoice number)`,
        suggestedAction: "Confirm this isn't a duplicate submission before it's counted twice",
      });
    }
  }
  return c.json(updated);
});

documentRoutes.get("/:id/audit-log", async (c) => {
  const rows = await listAuditLogForEntity(c.get("sql"), c.get("tenant").tenantId, "DOCUMENT", c.req.param("id"));
  return c.json({ auditLog: rows });
});

// DELETE /:id — soft delete. Restorable for
// RETENTION.DOCUMENT_TRASH_GRACE_DAYS (src/retention.ts) via the restore
// route below; the R2 object and the row itself are only actually
// removed by the cron purge sweep once that window passes (src/purge.ts).
documentRoutes.delete("/:id", async (c) => {
  const tenant = c.get("tenant");
  const sql = c.get("sql");
  const id = c.req.param("id");
  const doc = await softDeleteDocument(sql, tenant.tenantId, id);
  if (!doc) return apiError(c, 404, "NOT_FOUND", "document not found");
  await appendAuditLog(sql, { tenantId: tenant.tenantId, entityType: "DOCUMENT", entityId: id, action: "DELETED", actorEmail: tenant.ownerEmail });
  return c.json({ status: "DELETED" });
});

documentRoutes.post("/:id/restore", async (c) => {
  const tenant = c.get("tenant");
  const sql = c.get("sql");
  const id = c.req.param("id");
  const doc = await restoreDocument(sql, tenant.tenantId, id);
  if (!doc) return apiError(c, 404, "NOT_FOUND", "document not found, or not currently in trash");
  await appendAuditLog(sql, { tenantId: tenant.tenantId, entityType: "DOCUMENT", entityId: id, action: "RESTORED", actorEmail: tenant.ownerEmail });
  return c.json(doc);
});
