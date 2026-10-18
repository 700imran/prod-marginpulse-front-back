// The assistant's entire capability surface. The model never executes
// anything: it picks from THIS list and supplies arguments, and the Worker
// runs the same tenant-scoped, credit-metered, audit-logged code the REST
// routes use. Adding a tool means updating WORKFLOW.md's scope list first.
//
// Rules every tool follows:
//   - No tool takes a tenant id (or any identity) as an argument. Tenant and
//     user always come from the authenticated request context.
//   - Arguments are validated here, by us, regardless of what the model sent.
//   - "read" tools return data that is sanitized before the model sees it
//     (see service.ts / sanitize.ts). "mutating" tools never run from a
//     model call: they only PREPARE a proposal (validated args + a summary
//     written by us, not by the model); execution needs a confirmation token.
import type { Env } from "../config";
import type { Sql } from "../db";
import type { TenantContext } from "../auth/supabase";
import { buildDashboardSummary } from "../pipelines/dashboard";
import { listByGSTStatus, searchDocumentsByInvoiceOrVendor, getDocumentById } from "../repository/documents";
import { listAnomalies } from "../repository/anomalies";
import { requestGstSync } from "../actions/gst";
import { trashDocument, untrashDocument } from "../actions/documents";
import { operationCost } from "../billing/pricing";
import { RETENTION } from "../retention";
import { cleanString } from "./sanitize";

export interface ToolContext {
  env: Env;
  sql: Sql;
  tenant: TenantContext;
}

export interface JsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties: false;
}

export class ToolArgError extends Error {}

export type ExecuteResult =
  | { ok: true; message: string; data?: Record<string, unknown> }
  | { ok: false; code: "INSUFFICIENT_CREDITS" | "VALIDATION_ERROR" | "NOT_FOUND"; message: string; details?: Record<string, unknown> };

export type PrepareResult = { ok: true; args: Record<string, unknown>; summary: string } | { ok: false; message: string };

export interface ReadTool {
  kind: "read";
  name: string;
  description: string;
  inputSchema: JsonSchema;
  run(ctx: ToolContext, args: Record<string, unknown>): Promise<unknown>;
}

export interface MutatingTool {
  kind: "mutating";
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /** Validates args against current state and writes the human-facing summary. Never changes data. */
  prepare(ctx: ToolContext, args: Record<string, unknown>): Promise<PrepareResult>;
  /** Only ever called from POST /assistant/confirm with a verified, unspent token. */
  execute(ctx: ToolContext, args: Record<string, unknown>): Promise<ExecuteResult>;
}

export type AssistantTool = ReadTool | MutatingTool;

// --- argument helpers ------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function optEnum<T extends string>(args: Record<string, unknown>, key: string, allowed: readonly T[]): T | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) throw new ToolArgError(`${key} must be one of: ${allowed.join(", ")}`);
  return v as T;
}
function reqString(args: Record<string, unknown>, key: string, min: number, max: number): string {
  const v = args[key];
  if (typeof v !== "string") throw new ToolArgError(`${key} is required`);
  const t = v.trim();
  if (t.length < min || t.length > max) throw new ToolArgError(`${key} must be ${min}-${max} characters`);
  return t;
}
function reqUuid(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || !UUID.test(v.trim())) throw new ToolArgError(`${key} must be a document id (UUID) — look it up with get_document_status first`);
  return v.trim().toLowerCase();
}
function optInt(args: Record<string, unknown>, key: string, min: number, max: number, dflt: number): number {
  const v = args[key];
  if (v === undefined || v === null) return dflt;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new ToolArgError(`${key} must be an integer ${min}-${max}`);
  return v;
}

const num = (v: string | null | undefined) => parseFloat(v ?? "0") || 0;

// --- Phase 1: read-only ----------------------------------------------------

const getDashboardSummary: ReadTool = {
  kind: "read",
  name: "get_dashboard_summary",
  description: "Current headline numbers: documents uploaded, reconciled, open anomalies, GST mismatches, and ITC (input tax credit) at risk, plus the vendors causing GST problems.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async run({ env, sql, tenant }) {
    // includeInsight:false — no nested paid LLM call / second credit charge.
    const s = await buildDashboardSummary(sql, env, tenant, { includeInsight: false });
    return { summaryMetrics: s.summaryMetrics, itcAtRiskInr: s.itcAtRisk, gstProblemVendors: s.gstProblemVendors };
  },
};

const listGstMismatches: ReadTool = {
  kind: "read",
  name: "list_gst_mismatches",
  description: "Invoices with a GST problem: NOT_FILED (vendor hasn't filed it on the GST portal) or MISMATCH (details differ from the portal). Largest tax amounts first, max 10.",
  inputSchema: {
    type: "object",
    properties: { status: { type: "string", enum: ["NOT_FILED", "MISMATCH"], description: "Omit to include both." } },
    additionalProperties: false,
  },
  async run({ sql, tenant }, args) {
    const status = optEnum(args, "status", ["NOT_FILED", "MISMATCH"] as const);
    const statuses = status ? [status] : (["NOT_FILED", "MISMATCH"] as const);
    const docs = (await Promise.all(statuses.map((s) => listByGSTStatus(sql, tenant.tenantId, s)))).flat();
    docs.sort((a, b) => num(b.taxAmount) - num(a.taxAmount));
    return {
      totalCount: docs.length,
      totalTaxAtRiskInr: docs.reduce((sum, d) => sum + num(d.taxAmount), 0),
      showing: Math.min(docs.length, 10),
      invoices: docs.slice(0, 10).map((d) => ({
        documentId: d.documentId, vendorName: d.vendorName, invoiceNumber: d.invoiceNumber,
        documentDate: d.documentDate, taxAmountInr: num(d.taxAmount), gstStatus: d.gstPortalStatus,
      })),
    };
  },
};

const getDocumentStatus: ReadTool = {
  kind: "read",
  name: "get_document_status",
  description: "Look up documents by invoice number or vendor name (partial match) and report processing, reconciliation and GST status. Max 5 results.",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string", description: "Invoice number or vendor name, 2-80 characters." } },
    required: ["query"],
    additionalProperties: false,
  },
  async run({ sql, tenant }, args) {
    const query = reqString(args, "query", 2, 80);
    const docs = await searchDocumentsByInvoiceOrVendor(sql, tenant.tenantId, query, 5);
    return {
      matches: docs.length,
      documents: docs.map((d) => ({
        documentId: d.documentId, vendorName: d.vendorName, invoiceNumber: d.invoiceNumber, documentDate: d.documentDate,
        totalAmountInr: num(d.rawTotalAmount), taxAmountInr: num(d.taxAmount),
        processingStatus: d.processingStatus, gstPortalStatus: d.gstPortalStatus,
        reconciled: d.processingStatus === "RECONCILED", reconciliationReason: d.reconciliationReason,
        manuallyCorrected: d.manuallyCorrected,
      })),
    };
  },
};

const listRecentAnomalies: ReadTool = {
  kind: "read",
  name: "list_recent_anomalies",
  description: "Recent reconciliation anomalies (things needing review), newest first. Defaults to OPEN ones.",
  inputSchema: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["OPEN", "RESOLVED", "DISMISSED"] },
      limit: { type: "integer", minimum: 1, maximum: 10 },
    },
    additionalProperties: false,
  },
  async run({ sql, tenant }, args) {
    const status = optEnum(args, "status", ["OPEN", "RESOLVED", "DISMISSED"] as const) ?? "OPEN";
    const limit = optInt(args, "limit", 1, 10, 5);
    const rows = await listAnomalies(sql, tenant.tenantId, status, limit, 0);
    return {
      anomalies: rows.map((a) => ({
        anomalyId: a.anomalyId, type: a.anomalyType, severity: a.severity, status: a.status,
        description: a.description, suggestedAction: a.suggestedAction, documentId: a.documentId, createdAt: a.createdAt,
      })),
    };
  },
};

// --- Phase 2: reversible mutations (proposal + confirmation only) -----------

const syncGst: MutatingTool = {
  kind: "mutating",
  name: "sync_gst",
  description: "Propose syncing GST portal data (GSTR-2B) for the account's registered GSTIN. This costs usage credits and only runs after the user confirms. `period` is MMYYYY (e.g. 072026); omit for the default period.",
  inputSchema: {
    type: "object",
    properties: { period: { type: "string", pattern: "^(0[1-9]|1[0-2])[0-9]{4}$" } },
    additionalProperties: false,
  },
  async prepare({ tenant }, args) {
    let period = "";
    // "" means "default period" — it's what a no-period proposal stores in its
    // token, so re-validation at confirm time must accept it round-trip.
    if (args.period !== undefined && args.period !== null && args.period !== "") {
      period = reqString(args, "period", 6, 6);
      if (!/^(0[1-9]|1[0-2])\d{4}$/.test(period)) throw new ToolArgError("period must be MMYYYY, e.g. 072026");
    }
    if (!tenant.gstinNumber) return { ok: false, message: "No GSTIN is registered for this account, so a GST sync isn't possible." };
    const label = period ? `${period.slice(0, 2)}/${period.slice(2)}` : "the default period";
    return { ok: true, args: { period }, summary: `Sync GST portal data for ${label} — this will use ${operationCost("GST_SYNC")} credits.` };
  },
  async execute(ctx, args) {
    const period = typeof args.period === "string" ? args.period : "";
    const r = await requestGstSync(ctx.env, ctx.sql, ctx.tenant, period);
    if (r.ok) return { ok: true, message: `GST sync started. ${r.creditsReserved} credits used; ${r.creditsRemaining} remaining.`, data: { jobId: r.jobId, creditsRemaining: r.creditsRemaining } };
    if (r.reason === "NO_GSTIN") return { ok: false, code: "VALIDATION_ERROR", message: "No GSTIN is registered for this account." };
    return { ok: false, code: "INSUFFICIENT_CREDITS", message: "Not enough usage credits for a GST sync this billing period.", details: { credits_remaining: r.creditsRemaining } };
  },
};

function describeDoc(d: { vendorName: string | null; invoiceNumber: string | null; originalFilename: string }): string {
  const parts = [d.vendorName && cleanString(d.vendorName, 60), d.invoiceNumber && `invoice ${cleanString(d.invoiceNumber, 40)}`].filter(Boolean);
  return parts.length ? parts.join(", ") : cleanString(d.originalFilename, 60);
}

const softDeleteDocumentTool: MutatingTool = {
  kind: "mutating",
  name: "soft_delete_document",
  description: "Propose moving one document to trash (restorable for 30 days). Needs the document's id — look it up first with get_document_status. Only runs after the user confirms.",
  inputSchema: { type: "object", properties: { document_id: { type: "string" } }, required: ["document_id"], additionalProperties: false },
  async prepare({ sql, tenant }, args) {
    const id = reqUuid(args, "document_id");
    const doc = await getDocumentById(sql, tenant.tenantId, id);
    if (!doc) return { ok: false, message: "That document wasn't found." };
    if (doc.deletedAt) return { ok: false, message: "That document is already in the trash." };
    return { ok: true, args: { document_id: id }, summary: `Move to trash: ${describeDoc(doc)}. You can restore it for ${RETENTION.DOCUMENT_TRASH_GRACE_DAYS} days.` };
  },
  async execute({ sql, tenant }, args) {
    const id = reqUuid(args, "document_id");
    const doc = await trashDocument(sql, tenant, id, "via assistant: soft_delete_document");
    return doc ? { ok: true, message: "Moved to trash. You can restore it from the trash within the grace period." } : { ok: false, code: "NOT_FOUND", message: "Document not found or already in trash." };
  },
};

const restoreDocumentTool: MutatingTool = {
  kind: "mutating",
  name: "restore_document",
  description: "Propose restoring one document from the trash. Needs the document's id. Only runs after the user confirms.",
  inputSchema: { type: "object", properties: { document_id: { type: "string" } }, required: ["document_id"], additionalProperties: false },
  async prepare({ sql, tenant }, args) {
    const id = reqUuid(args, "document_id");
    const doc = await getDocumentById(sql, tenant.tenantId, id);
    if (!doc) return { ok: false, message: "That document wasn't found." };
    if (!doc.deletedAt) return { ok: false, message: "That document isn't in the trash." };
    return { ok: true, args: { document_id: id }, summary: `Restore from trash: ${describeDoc(doc)}.` };
  },
  async execute({ sql, tenant }, args) {
    const id = reqUuid(args, "document_id");
    const doc = await untrashDocument(sql, tenant, id, "via assistant: restore_document");
    return doc ? { ok: true, message: "Document restored." } : { ok: false, code: "NOT_FOUND", message: "Document not found or not in the trash." };
  },
};

export const READ_TOOLS: ReadTool[] = [getDashboardSummary, listGstMismatches, getDocumentStatus, listRecentAnomalies];
export const MUTATING_TOOLS: MutatingTool[] = [syncGst, softDeleteDocumentTool, restoreDocumentTool];

export function mutationsEnabled(env: Pick<Env, "ASSISTANT_MUTATIONS_ENABLED">): boolean {
  return env.ASSISTANT_MUTATIONS_ENABLED === "true";
}

/** The tools a given deployment actually exposes: Phase 2 stays dark until the flag is flipped. */
export function activeTools(env: Pick<Env, "ASSISTANT_MUTATIONS_ENABLED">): AssistantTool[] {
  return mutationsEnabled(env) ? [...READ_TOOLS, ...MUTATING_TOOLS] : [...READ_TOOLS];
}

// Capabilities that must NEVER exist as tools (WORKFLOW.md, "Never exposed").
// Not used to gate anything at runtime — absence from the registry is the
// enforcement — it exists so tests (and reviewers) have a single list to
// assert against, and so the system prompt can name them.
export const FORBIDDEN_CAPABILITY_PATTERNS: RegExp[] = [
  /delete.*(account|tenant)|(account|tenant).*delete/i,
  /purge/i,
  /bank/i,
  /tax_?identifier|gstin|pan\b/i,
  /credit|wallet|billing|ledger|purchase|top_?up/i,
  /admin/i,
];
