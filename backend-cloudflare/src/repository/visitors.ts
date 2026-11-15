import type { Sql } from "../db";

export interface VisitInput {
  site: "app" | "marketing"; visitorId: string; idSource: "first_party" | "fingerprint";
  ip: string | null; city: string | null; country: string | null; device: string; browser: string | null; os: string | null;
}

/**
 * Upsert keyed by (site, visitor). `visits` only increases when the previous activity is older than 30 minutes — so a
 * visitor clicking around (or a script replaying the same id) cannot inflate the count; it counts SESSIONS.
 */
export async function upsertVisit(sql: Sql, v: VisitInput): Promise<{ visits: number; firstSeen: string; inserted: boolean }> {
  const rows = await sql<{ visits: number; firstSeen: string; inserted: boolean }[]>`
    insert into visitors (site, visitor_id, id_source, last_ip, city, country, device, browser, os)
    values (${v.site}, ${v.visitorId}, ${v.idSource}, ${v.ip}, ${v.city}, ${v.country}, ${v.device}, ${v.browser}, ${v.os})
    on conflict (site, visitor_id) do update set
      visits    = visitors.visits + case when visitors.last_seen < now() - interval '30 minutes' then 1 else 0 end,
      last_seen = now(),
      last_ip   = coalesce(excluded.last_ip, visitors.last_ip),
      city      = coalesce(excluded.city, visitors.city),
      country   = coalesce(excluded.country, visitors.country),
      device    = excluded.device,
      browser   = coalesce(excluded.browser, visitors.browser),
      os        = coalesce(excluded.os, visitors.os)
    returning visits, first_seen::text as "firstSeen", (xmax = 0) as inserted`;
  return rows[0]!;
}

/** Right-to-erasure: removes this visitor everywhere (a Fingerprint id is the same on both sites). Returns rows deleted. */
export async function eraseVisitor(sql: Sql, visitorId: string): Promise<number> {
  const rows = await sql<{ n: string }[]>`with d as (delete from visitors where visitor_id = ${visitorId} returning 1) select count(*)::text as n from d`;
  return parseInt(rows[0]?.n ?? "0", 10);
}

/** Retention: the daily cron calls this. Returns rows removed. */
export async function purgeOldVisitors(sql: Sql, days: number): Promise<number> {
  const d = Math.max(1, Math.min(3650, Math.floor(days) || 90));
  const rows = await sql<{ n: string }[]>`with d as (delete from visitors where last_seen < now() - make_interval(days => ${d}) returning 1) select count(*)::text as n from d`;
  return parseInt(rows[0]?.n ?? "0", 10);
}

export interface VisitorSummary {
  days: number;
  bySite: { site: string; uniqueVisitors: number; newVisitors: number; returningVisitors: number; sessions: number }[];
  topCities: { city: string; visitors: number }[];
  topCountries: { country: string; visitors: number }[];
  devices: { device: string; visitors: number }[];
  browsers: { browser: string; visitors: number }[];
}

export async function visitorSummary(sql: Sql, days: number): Promise<VisitorSummary> {
  const d = Math.max(1, Math.min(365, Math.floor(days) || 30));
  const [bySite, cities, countries, devices, browsers] = await Promise.all([
    sql<{ site: string; u: string; n: string; r: string; s: string }[]>`
      select site, count(*)::text as u,
             count(*) filter (where first_seen >= now() - make_interval(days => ${d}))::text as n,
             count(*) filter (where first_seen < now() - make_interval(days => ${d}))::text as r,
             coalesce(sum(visits), 0)::text as s
      from visitors where last_seen >= now() - make_interval(days => ${d}) group by site order by site`,
    sql<{ k: string; n: string }[]>`select city as k, count(*)::text as n from visitors where last_seen >= now() - make_interval(days => ${d}) and city is not null group by 1 order by count(*) desc, 1 limit 10`,
    sql<{ k: string; n: string }[]>`select country as k, count(*)::text as n from visitors where last_seen >= now() - make_interval(days => ${d}) and country is not null group by 1 order by count(*) desc, 1 limit 10`,
    sql<{ k: string; n: string }[]>`select device as k, count(*)::text as n from visitors where last_seen >= now() - make_interval(days => ${d}) and device is not null group by 1 order by count(*) desc, 1`,
    sql<{ k: string; n: string }[]>`select browser as k, count(*)::text as n from visitors where last_seen >= now() - make_interval(days => ${d}) and browser is not null group by 1 order by count(*) desc, 1 limit 8`,
  ]);
  const num = (x: string) => parseInt(x, 10);
  return {
    days: d,
    bySite: bySite.map((r) => ({ site: r.site, uniqueVisitors: num(r.u), newVisitors: num(r.n), returningVisitors: num(r.r), sessions: num(r.s) })),
    topCities: cities.map((r) => ({ city: r.k, visitors: num(r.n) })),
    topCountries: countries.map((r) => ({ country: r.k, visitors: num(r.n) })),
    devices: devices.map((r) => ({ device: r.k, visitors: num(r.n) })),
    browsers: browsers.map((r) => ({ browser: r.k, visitors: num(r.n) })),
  };
}
