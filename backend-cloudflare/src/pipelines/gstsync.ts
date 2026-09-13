// Port of internal/pipelines/gstsync/gstsync.go. The Go version cached
// its auth token on a long-lived singleton struct; a Worker isolate can
// be evicted at any time, so this module-level cache is a best-effort
// warm-isolate optimization, not a guarantee — the 401-triggers-refetch
// logic below is what actually keeps this correct either way.
import type { Env } from "../config";

let cachedToken: string | null = null;

async function getAuthToken(env: Env): Promise<string> {
  const resp = await fetch(`${env.GST_API_BASE_URL}/authenticate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: env.GST_API_USERNAME,
      client_id: env.GST_API_CLIENT_ID,
      client_secret: env.GST_API_CLIENT_SECRET,
    }),
  });
  if (!resp.ok) throw new Error(`GST auth failed: HTTP ${resp.status}`);
  const body = (await resp.json()) as { auth_token: string };
  cachedToken = body.auth_token;
  return body.auth_token;
}

export async function fetchGSTR2B(env: Env, gstin: string, returnPeriod: string): Promise<Record<string, any>> {
  let token = cachedToken ?? (await getAuthToken(env));

  const doFetch = (tok: string) =>
    fetch(`${env.GST_API_BASE_URL}/returns/gstr2b?gstin=${gstin}&ret_period=${returnPeriod}&day_limit=30`, {
      headers: { "auth-token": tok },
    });

  let resp = await doFetch(token);
  if (resp.status === 401) {
    token = await getAuthToken(env);
    resp = await doFetch(token);
  }
  if (!resp.ok) throw new Error(`GSTR-2B fetch failed: HTTP ${resp.status}`);
  return resp.json();
}

export interface SupplierInvoice {
  invoiceNumber: string;
  invoiceDate: string;
  taxableValue: number;
  igst: number;
  cgst: number;
  sgst: number;
}
export interface Supplier {
  tradeName: string;
  invoices: SupplierInvoice[];
}

const asStr = (v: unknown): string => (typeof v === "string" ? v : "");
const asNum = (v: unknown): number => (typeof v === "number" ? v : 0);

export function parseGSTR2BSuppliers(gstr2bJSON: Record<string, any>): Record<string, Supplier> {
  const result: Record<string, Supplier> = {};
  const b2b: any[] = gstr2bJSON?.data?.docdata?.b2b ?? [];
  for (const supplier of b2b) {
    const gstin = asStr(supplier?.ctin).toUpperCase();
    if (!gstin) continue;
    const invoices: SupplierInvoice[] = (supplier?.inv ?? []).map((inv: any) => ({
      invoiceNumber: asStr(inv?.inum),
      invoiceDate: asStr(inv?.idt),
      taxableValue: asNum(inv?.txval),
      igst: asNum(inv?.igst),
      cgst: asNum(inv?.cgst),
      sgst: asNum(inv?.sgst),
    }));
    result[gstin] = { tradeName: asStr(supplier?.trdnm), invoices };
  }
  return result;
}

export interface InternalVendor {
  documentId: string;
  vendorName: string;
  taxIdentifier: string;
  rawTotalAmount: number;
  invoiceNumber: string;
}
export interface VerificationResult {
  documentId: string;
  gstPortalStatus: "PENDING" | "NOT_FILED" | "MISMATCH" | "FILED";
  itcRisk: number;
  note: string;
}

// Exact port of CrossVerifyVendors's decision tree — no GSTIN -> PENDING;
// GSTIN not filed -> NOT_FILED; filed but this invoice missing -> MISMATCH;
// both present -> FILED.
export function crossVerifyVendors(internalVendors: InternalVendor[], portalSuppliers: Record<string, Supplier>): VerificationResult[] {
  return internalVendors.map((vendor) => {
    const gstin = vendor.taxIdentifier.trim().toUpperCase();
    if (!gstin) {
      return { documentId: vendor.documentId, gstPortalStatus: "PENDING", itcRisk: vendor.rawTotalAmount, note: "No GSTIN extracted from invoice" };
    }
    const supplier = portalSuppliers[gstin];
    if (!supplier) {
      return { documentId: vendor.documentId, gstPortalStatus: "NOT_FILED", itcRisk: vendor.rawTotalAmount, note: `GSTIN ${gstin} not found in GSTR-2B for this period` };
    }
    const portalInvoiceNumbers = new Set(supplier.invoices.map((i) => i.invoiceNumber));
    if (vendor.invoiceNumber && !portalInvoiceNumbers.has(vendor.invoiceNumber)) {
      return { documentId: vendor.documentId, gstPortalStatus: "MISMATCH", itcRisk: vendor.rawTotalAmount, note: `Invoice ${vendor.invoiceNumber} not found in GSTR-2B although supplier GSTIN is filed` };
    }
    return { documentId: vendor.documentId, gstPortalStatus: "FILED", itcRisk: 0, note: "Verified on GST portal" };
  });
}
