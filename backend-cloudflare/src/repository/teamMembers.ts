import type { Sql } from "../db";

export interface TeamMemberRow {
  teamMemberId: string;
  tenantId: string;
  invitedEmail: string;
  role: string;
  status: string;
  inviteToken: string | null;
  invitedAt: string;
  acceptedAt: string | null;
}

const SELECT = `
  team_member_id as "teamMemberId", tenant_id as "tenantId", invited_email as "invitedEmail",
  role, status, invite_token as "inviteToken", invited_at as "invitedAt", accepted_at as "acceptedAt"
`;

export async function inviteTeamMember(sql: Sql, tenantId: string, email: string, role: string, inviteToken: string): Promise<TeamMemberRow> {
  const rows = await sql.unsafe<TeamMemberRow[]>(
    `insert into team_members (tenant_id, invited_email, role, invite_token) values ($1,$2,$3,$4)
     on conflict (tenant_id, invited_email) do update set role = excluded.role, status = 'INVITED', invite_token = excluded.invite_token, revoked_at = null
     returning ${SELECT}`,
    [tenantId, email, role, inviteToken],
  );
  return rows[0]!;
}

export async function listTeamMembers(sql: Sql, tenantId: string): Promise<TeamMemberRow[]> {
  return sql.unsafe<TeamMemberRow[]>(`select ${SELECT} from team_members where tenant_id = $1 order by invited_at desc`, [tenantId]);
}

export async function getByInviteToken(sql: Sql, token: string): Promise<TeamMemberRow | null> {
  const rows = await sql.unsafe<TeamMemberRow[]>(`select ${SELECT} from team_members where invite_token = $1 and status = 'INVITED'`, [token]);
  return rows[0] ?? null;
}

export async function acceptInvite(sql: Sql, teamMemberId: string): Promise<void> {
  await sql`update team_members set status = 'ACTIVE', accepted_at = now(), invite_token = null where team_member_id = ${teamMemberId}`;
}

export async function revokeTeamMember(sql: Sql, tenantId: string, teamMemberId: string): Promise<void> {
  await sql`update team_members set status = 'REVOKED', revoked_at = now() where tenant_id = ${tenantId} and team_member_id = ${teamMemberId}`;
}

export async function countActiveOrPending(sql: Sql, tenantId: string): Promise<number> {
  const rows = await sql<{ count: string }[]>`
    select count(*)::text from team_members where tenant_id = ${tenantId} and status in ('INVITED','ACTIVE')
  `;
  return parseInt(rows[0]!.count, 10);
}

export async function findActiveOrPendingForEmail(sql: Sql, tenantId: string, email: string): Promise<TeamMemberRow | null> {
  const rows = await sql.unsafe<TeamMemberRow[]>(
    `select ${SELECT} from team_members
     where tenant_id = $1 and invited_email = $2 and status in ('INVITED','ACTIVE')
     limit 1`,
    [tenantId, email],
  );
  return rows[0] ?? null;
}
