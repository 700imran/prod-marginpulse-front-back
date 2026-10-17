import { Hono } from "hono";
import type { Env } from "../config";
import type { Sql } from "../db";
import type { TenantContext } from "../auth/supabase";
import { requireAuth } from "../middleware/auth";
import { createTaxIdentifier, listTaxIdentifiers, getTaxIdentifierById, setPrimaryTaxIdentifier, deleteTaxIdentifier, updateTaxIdentifierVerification } from "../repository/taxIdentifiers";
import { reserveForOperation } from "../billing/guard";
import { apiError } from "../http";

export const taxIdentifierRoutes = new Hono<{ Bindings: Env; Variables: { sql: Sql; tenant: TenantContext } }>();

taxIdentifierRoutes.use("*", requireAuth);

taxIdentifierRoutes.get("/", async (c) => {
  const items = await listTaxIdentifiers(c.get("sql"), c.get("tenant").tenantId);
  return c.json(items);
});

// POST /tax-identifiers — creates then immediately queues async
// verification, mirrors HandleCreateTaxIdentifier. The UNIQUE(tenant_id,
// id_type, id_value) constraint in schema.sql does what
// ErrDuplicateTaxIdentifier's guard-item check did in Dynamo — a
// duplicate insert fails with Postgres error code 23505.
taxIdentifierRoutes.post("/", async (c) => {
  const { id_type: idType, id_value: idValue, label } = await c.req.json();
  if (!idType || !idValue) return apiError(c, 400, "VALIDATION_ERROR", "id_type and id_value are required");

  const tenant = c.get("tenant");
  const sql = c.get("sql");
  const tenantId = tenant.tenantId;
  let item;
  try {
    item = await createTaxIdentifier(sql, tenantId, idType, idValue, label ?? null);
  } catch (e: any) {
    if (e?.code === "23505") return apiError(c, 409, "CONFLICT", `${idType} ${idValue} is already on file for this account`);
    throw e;
  }

  const jobId = crypto.randomUUID();
  const reservation = await reserveForOperation(sql, tenant, "TAX_IDENTIFIER_VERIFY", jobId);
  if (!reservation.ok) {
    // The identifier record itself is created either way (it's the
    // person's own data, free to store) — only the paid verification
    // call is gated. It stays PENDING until they have credits to spend
    // on /reverify.
    return c.json({ ...item, verification_status: "PENDING", credits_error: "Not enough usage credits to verify right now — retry from the reverify action once your balance refills." }, 201);
  }
  await c.env.TAX_IDENTIFIER_QUEUE.send({
    task: "verify_tax_identifier", job_id: jobId, args: { tenant_id: tenantId, tax_identifier_id: item.taxIdentifierId },
    credit_reservation: { tenant_id: tenantId, operation: "TAX_IDENTIFIER_VERIFY", amount: reservation.amount },
  });
  return c.json(item, 201);
});

taxIdentifierRoutes.post("/:id/reverify", async (c) => {
  const tenant = c.get("tenant");
  const sql = c.get("sql");
  const tenantId = tenant.tenantId;
  const id = c.req.param("id");
  const item = await getTaxIdentifierById(sql, tenantId, id);
  if (!item) return apiError(c, 404, "NOT_FOUND", "tax identifier not found");

  const jobId = crypto.randomUUID();
  const reservation = await reserveForOperation(sql, tenant, "TAX_IDENTIFIER_VERIFY", jobId);
  if (!reservation.ok) {
    return apiError(c, 402, "INSUFFICIENT_CREDITS", "Not enough usage credits for a verification call this billing period", { credits_remaining: reservation.balanceAfter });
  }

  await updateTaxIdentifierVerification(sql, id, "PENDING", null, null, null);
  await c.env.TAX_IDENTIFIER_QUEUE.send({
    task: "verify_tax_identifier", job_id: jobId, args: { tenant_id: tenantId, tax_identifier_id: id },
    credit_reservation: { tenant_id: tenantId, operation: "TAX_IDENTIFIER_VERIFY", amount: reservation.amount },
  });
  return c.json({ status: "PENDING" }, 202);
});

taxIdentifierRoutes.post("/:id/set-primary", async (c) => {
  const tenantId = c.get("tenant").tenantId;
  const id = c.req.param("id");
  const existing = await getTaxIdentifierById(c.get("sql"), tenantId, id);
  if (!existing) return apiError(c, 404, "NOT_FOUND", "tax identifier not found");

  await setPrimaryTaxIdentifier(c.get("sql"), tenantId, id);
  const updated = await getTaxIdentifierById(c.get("sql"), tenantId, id);
  return c.json(updated);
});

taxIdentifierRoutes.delete("/:id", async (c) => {
  const tenantId = c.get("tenant").tenantId;
  const id = c.req.param("id");
  const existing = await getTaxIdentifierById(c.get("sql"), tenantId, id);
  if (!existing) return apiError(c, 404, "NOT_FOUND", "tax identifier not found");

  await deleteTaxIdentifier(c.get("sql"), tenantId, id);
  return c.body(null, 204);
});
