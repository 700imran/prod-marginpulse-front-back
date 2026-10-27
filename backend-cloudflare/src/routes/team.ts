import { Hono } from "hono";
import type { Env } from "../config";
import type { Sql } from "../db";
import type { TenantContext } from "../auth/supabase";
import { requireAuth } from "../middleware/auth";
import { inviteTeamMember, listTeamMembers, getByInviteToken, revokeTeamMember, countActiveOrPending, findActiveOrPendingForEmail, acceptInvite } from "../repository/teamMembers";
import { generateToken } from "../security/random";
import { sendTeamInvite } from "../email";
import { rateLimit } from "../middleware/rateLimit";
import { pickValid } from "../security/validate";
import { publicMember } from "../repository/teamMembers";

export const teamRoutes = new Hono<{ Bindings: Env; Variables: { sql: Sql; tenant: TenantContext } }>();

teamRoutes.use("*", requireAuth);

const MAX_TEAM_MEMBERS = 10; // matches the Go original's plan-tier-agnostic cap

teamRoutes.get("/", async (c) => {
  const items = await listTeamMembers(c.get("sql"), c.get("tenant").tenantId);
  return c.json(items.map(publicMember));
});

teamRoutes.post("/invite", rateLimit("team-invite", 10, 3600), async (c) => {
  // OWNER can never be granted by invitation (privilege-escalation guard); email is format-checked.
  const { email, role } = pickValid(await c.req.json().catch(() => null), {
    email: { t: "str", max: 254, pattern: /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']{2,}$/ },
    role: { t: "enum", values: ["ADMIN", "MEMBER", "VIEWER"] },
  }) as { email: string; role?: string };
  if (!email) return c.json({ error: "email is required" }, 400);

  const tenant = c.get("tenant");
  const sql = c.get("sql");
  const count = await countActiveOrPending(sql, tenant.tenantId);
  if (count >= MAX_TEAM_MEMBERS) return c.json({ error: "Team member limit reached" }, 400);

  const existing = await findActiveOrPendingForEmail(sql, tenant.tenantId, email);
  if (existing) return c.json({ error: "This email already has a pending or active invitation" }, 409);

  const token = generateToken();
  const member = await inviteTeamMember(sql, tenant.tenantId, email, role || "VIEWER", token);
  await sendTeamInvite(c.env, member.invitedEmail, tenant.businessName, token, member.role);
  return c.json(publicMember(member), 201);
});

// POST /team/accept-invite — Supabase Auth handles the sign-up/sign-in
// itself; this just links an already-authenticated Supabase user to the
// pending invite record once they land back on the app with a token.
teamRoutes.post("/accept-invite", rateLimit("accept-invite", 20, 3600), async (c) => {
  const { token } = pickValid(await c.req.json().catch(() => null), { token: { t: "str", max: 128, pattern: /^[A-Za-z0-9_-]+$/ } }) as { token: string };
  const member = await getByInviteToken(c.get("sql"), token);
  if (!member) return c.json({ error: "invite not found, expired or already used" }, 404);
  // The signed-in user must BE the invited person — a leaked link alone is not enough.
  if (member.invitedEmail.toLowerCase() !== c.get("tenant").ownerEmail.toLowerCase()) {
    return c.json({ error: "invite not found, expired or already used" }, 404);
  }
  await acceptInvite(c.get("sql"), member.tenantId, member.teamMemberId);
  return c.json({ status: "ACTIVE" });
});

teamRoutes.post("/:id/revoke", async (c) => {
  const tenantId = c.get("tenant").tenantId;
  const id = c.req.param("id");
  await revokeTeamMember(c.get("sql"), tenantId, id);
  const items = await listTeamMembers(c.get("sql"), tenantId);
  const updated = items.find((m) => m.teamMemberId === id);
  if (!updated) return c.json({ error: "team member not found" }, 404);
  return c.json(publicMember(updated));
});
