import { Hono } from "hono";
import type { Env } from "../config";
import type { Sql } from "../db";
import type { TenantContext } from "../auth/supabase";
import { requireAuth } from "../middleware/auth";
import { getDocumentById } from "../repository/documents";
import { generateCollectionScript } from "../pipelines/insights";
import { apiError } from "../http";

export const commsRoutes = new Hono<{ Bindings: Env; Variables: { sql: Sql; tenant: TenantContext } }>();

commsRoutes.use("*", requireAuth);

// GET /comms/generate-reminder?document_id=&issue_type=
commsRoutes.get("/generate-reminder", async (c) => {
  const documentId = c.req.query("document_id") ?? "";
  const issueType = c.req.query("issue_type") || "GST_PORTAL_MISMATCH";
  if (!documentId) return apiError(c, 400, "VALIDATION_ERROR", "document_id is required");

  const doc = await getDocumentById(c.get("sql"), c.get("tenant").tenantId, documentId);
  if (!doc) return apiError(c, 404, "NOT_FOUND", "document not found");

  const script = generateCollectionScript(
    doc.vendorName || "Vendor",
    doc.invoiceNumber ?? "",
    doc.rawTotalAmount ? parseFloat(doc.rawTotalAmount) : 0,
    doc.documentDate ?? "",
    issueType,
  );
  return c.json({ script });
});
