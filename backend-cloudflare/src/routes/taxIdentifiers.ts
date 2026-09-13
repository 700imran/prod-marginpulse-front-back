import { Hono } from "hono";
import type { Env } from "../config";
import type { Sql } from "../db";
import type { TenantContext } from "../auth/supabase";
import { requireAuth } from "../middleware/auth";
import { createTaxIdentifier, listTaxIdentifiers, getTaxIdentifierById, setPrimaryTaxIdentifier, deleteTaxIdentifier, updateTaxIdentifierVerification } from "../repository/taxIdentifiers";

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
  if (!idType || !idValue) return c.json({ error: "id_type and id_value are required" }, 400);

  const tenantId = c.get("tenant").tenantId;
  let item;
  try {
    item = await createTaxIdentifier(c.get("sql"), tenantId, idType, idValue, label ?? null);
  } catch (e: any) {
    if (e?.code === "23505") return c.json({ error: `${idType} ${idValue} is already on file for this account` }, 409);
    throw e;
  }
  await c.env.TAX_IDENTIFIER_QUEUE.send({ task: "verify_tax_identifier", job_id: crypto.randomUUID(), args: { tenant_id: tenantId, tax_identifier_id: item.taxIdentifierId } });
  return c.json(item, 201);
});

taxIdentifierRoutes.post("/:id/reverify", async (c) => {
  const tenantId = c.get("tenant").tenantId;
  const id = c.req.param("id");
  const item = await getTaxIdentifierById(c.get("sql"), tenantId, id);
  if (!item) return c.json({ error: "tax identifier not found" }, 404);

  await updateTaxIdentifierVerification(c.get("sql"), id, "PENDING", null, null, null);
  await c.env.TAX_IDENTIFIER_QUEUE.send({ task: "verify_tax_identifier", job_id: crypto.randomUUID(), args: { tenant_id: tenantId, tax_identifier_id: id } });
  return c.json({ status: "PENDING" }, 202);
});

taxIdentifierRoutes.post("/:id/set-primary", async (c) => {
  const tenantId = c.get("tenant").tenantId;
  const id = c.req.param("id");
  const existing = await getTaxIdentifierById(c.get("sql"), tenantId, id);
  if (!existing) return c.json({ error: "tax identifier not found" }, 404);

  await setPrimaryTaxIdentifier(c.get("sql"), tenantId, id);
  const updated = await getTaxIdentifierById(c.get("sql"), tenantId, id);
  return c.json(updated);
});

taxIdentifierRoutes.delete("/:id", async (c) => {
  const tenantId = c.get("tenant").tenantId;
  const id = c.req.param("id");
  const existing = await getTaxIdentifierById(c.get("sql"), tenantId, id);
  if (!existing) return c.json({ error: "tax identifier not found" }, 404);

  await deleteTaxIdentifier(c.get("sql"), tenantId, id);
  return c.body(null, 204);
});
