import { Hono } from "hono";
import type { Env } from "../config";
import type { Sql } from "../db";
import type { TenantContext } from "../auth/supabase";
import { requireAuth } from "../middleware/auth";
import { inviteTeamMember, listTeamMembers, getByInviteToken, revokeTeamMember, countActiveOrPending, findActiveOrPendingForEmail, acceptInvite } from "../repository/teamMembers";
import { generateToken } from "../security/random";
import { setPrivilegedContext } from "../security/tenantContext";
import { sendTeamInvite } from "../email";
import { apiError } from "../http";

export const teamRoutes = new Hono<{ Bindings: Env; Variables: { sql: Sql; tenant: TenantContext } }>();

teamRoutes.use("*", requireAuth);

const MAX_TEAM_MEMBERS = 10; // matches the Go original's plan-tier-agnostic cap

teamRoutes.get("/", async (c) => {
  const items = await listTeamMembers(c.get("sql"), c.get("tenant").tenantId);
  return c.json(items);
});

teamRoutes.post("/invite", async (c) => {
  const { email, role } = await c.req.json();
  if (!email) return apiError(c, 400, "VALIDATION_ERROR", "email is required");

  const tenant = c.get("tenant");
  const sql = c.get("sql");
  const count = await countActiveOrPending(sql, tenant.tenantId);
  if (count >= MAX_TEAM_MEMBERS) return apiError(c, 400, "VALIDATION_ERROR", "Team member limit reached");

  const existing = await findActiveOrPendingForEmail(sql, tenant.tenantId, email);
  if (existing) return apiError(c, 409, "CONFLICT", "This email already has a pending or active invitation");

  const token = generateToken();
  const member = await inviteTeamMember(sql, tenant.tenantId, email, role || "VIEWER", token);
  await sendTeamInvite(c.env, member.invitedEmail, tenant.businessName, token, member.role);
  return c.json(member, 201);
});

// POST /team/accept-invite — Supabase Auth handles the sign-up/sign-in
// itself; this just links an already-authenticated Supabase user to the
// pending invite record once they land back on the app with a token.
teamRoutes.post("/accept-invite", async (c) => {
  const { token } = await c.req.json();
  const sql = c.get("sql");
  // The invite being redeemed belongs to the *inviter's* tenant, not the
  // accepting (already-authenticated) user's own tenant — that's the
  // whole point of an invite. Authorization here comes from possessing
  // the unguessable token itself (security/random.ts's generateToken),
  // not from a tenant_id match, so this briefly needs the same
  // system-context bypass the webhook lookups use.
  await setPrivilegedContext(sql, { system: true });
  const member = await getByInviteToken(sql, token);
  if (!member) {
    await setPrivilegedContext(sql, { system: false });
    return apiError(c, 404, "NOT_FOUND", "invite not found or already used");
  }
  await acceptInvite(sql, member.teamMemberId);
  await setPrivilegedContext(sql, { system: false });
  return c.json({ status: "ACTIVE" });
});

teamRoutes.post("/:id/revoke", async (c) => {
  const tenantId = c.get("tenant").tenantId;
  const id = c.req.param("id");
  await revokeTeamMember(c.get("sql"), tenantId, id);
  const items = await listTeamMembers(c.get("sql"), tenantId);
  const updated = items.find((m) => m.teamMemberId === id);
  if (!updated) return apiError(c, 404, "NOT_FOUND", "team member not found");
  return c.json(updated);
});
