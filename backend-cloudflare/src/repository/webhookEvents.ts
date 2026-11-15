import type { Sql } from "../db";

/** true = first time we see this event; false = duplicate delivery. */
export async function claimWebhookEvent(sql: Sql, source: string, eventId: string): Promise<boolean> {
  const r = await sql`insert into webhook_events (source, event_id) values (${source}, ${eventId}) on conflict do nothing returning event_id`;
  return r.length > 0;
}
export async function releaseWebhookEvent(sql: Sql, source: string, eventId: string): Promise<void> {
  await sql`delete from webhook_events where source = ${source} and event_id = ${eventId}`;
}
