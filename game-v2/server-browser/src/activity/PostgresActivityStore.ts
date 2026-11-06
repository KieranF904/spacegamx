/**
 * PostgresActivityStore: the activity feed in the `activity` table (../../schema.sql), sharing the accounts' pool.
 * The table is made at start when it's missing. Each server keeps its newest KEEP_PER_SERVER rows: the older ones are
 * pruned after an insert, at most once a minute per server (so the cap can be passed briefly, never by much).
 */

import { KEEP_PER_SERVER, MAX_SERVERS, type ActivityEvent, type ActivityQuery, type ActivityStore, type NewActivity } from './types.js';

interface PgPool {
  query(sql: string, params?: any[]): Promise<{ rows: any[] }>;
}

/** schema.sql's statements for the feed (run at start: IF NOT EXISTS) */
export const ACTIVITY_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS activity (
    id      BIGSERIAL PRIMARY KEY,
    at      BIGINT NOT NULL,
    server  TEXT NOT NULL,
    type    TEXT NOT NULL,
    player  TEXT NOT NULL DEFAULT '',
    other   TEXT NOT NULL DEFAULT '',
    detail  TEXT NOT NULL DEFAULT ''
  )`,
  'CREATE INDEX IF NOT EXISTS idx_activity_server ON activity(server, id DESC)',
  'CREATE INDEX IF NOT EXISTS idx_activity_player ON activity(lower(player), id DESC)',
];

const COLUMNS = 'id, at, server, type, player, other, detail';
const PRUNE_EVERY_MS = 60_000;

export class PostgresActivityStore implements ActivityStore {
  private pruned = new Map<string, number>();
  private known: Set<string> | null = null;

  constructor(private pool: PgPool, private keep = KEEP_PER_SERVER, private now: () => number = Date.now) {}

  static async create(pool: PgPool): Promise<PostgresActivityStore> {
    try {
      for (const sql of ACTIVITY_SCHEMA) await pool.query(sql);
    } catch (e) {
      throw new Error(`The activity feed's "activity" table is missing and this database user can't make it: run server-browser/schema.sql as the tables' owner (${e})`);
    }
    return new PostgresActivityStore(pool);
  }

  private async servers(): Promise<Set<string>> {
    if (!this.known) this.known = new Set((await this.pool.query('SELECT DISTINCT server FROM activity')).rows.map((r) => String(r.server)));
    return this.known;
  }

  async add(events: NewActivity[]): Promise<ActivityEvent[]> {
    const known = await this.servers();
    const ok = events.filter((e) => known.has(e.server) || (known.size < MAX_SERVERS && known.add(e.server)));
    if (!ok.length) return [];
    const r = await this.pool.query(
      `INSERT INTO activity (at, server, type, player, other, detail)
       SELECT * FROM unnest($1::bigint[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[])
       RETURNING ${COLUMNS}`,
      [ok.map((e) => e.at), ok.map((e) => e.server), ok.map((e) => e.type), ok.map((e) => e.player), ok.map((e) => e.other), ok.map((e) => e.detail)]);
    for (const server of new Set(ok.map((e) => e.server))) await this.prune(server);
    return r.rows.map(toEvent).sort((a, b) => a.id - b.id);
  }

  private async prune(server: string): Promise<void> {
    const t = this.now();
    if (t - (this.pruned.get(server) ?? -Infinity) < PRUNE_EVERY_MS) return;
    this.pruned.set(server, t);
    await this.pool.query(
      `DELETE FROM activity WHERE server = $1 AND id <= (SELECT id FROM activity WHERE server = $1 ORDER BY id DESC OFFSET $2 LIMIT 1)`,
      [server, this.keep]);
  }

  async list(q: ActivityQuery): Promise<ActivityEvent[]> {
    const where: string[] = [];
    const params: any[] = [];
    const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
    if (q.after !== undefined) where.push(`id > ${p(q.after)}`);
    if (q.before !== undefined) where.push(`id < ${p(q.before)}`);
    if (q.server) where.push(`server = ${p(q.server)}`);
    if (q.type) where.push(`type = ${p(q.type)}`);
    if (q.player) { const v = p(q.player.toLowerCase()); where.push(`(lower(player) = ${v} OR lower(other) = ${v})`); }
    for (const w of (q.search ?? '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8)) {
      // (A word, matched as text: % and _ in it are literal)
      where.push(`lower(player || ' ' || other || ' ' || type || ' ' || detail) LIKE ${p(`%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)}`);
    }
    const r = await this.pool.query(
      `SELECT ${COLUMNS} FROM activity ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ${p(q.limit)}`, params);
    return r.rows.map(toEvent);
  }

  async facets(): Promise<{ servers: string[]; types: string[] }> {
    const [s, t] = await Promise.all([
      this.pool.query('SELECT DISTINCT server FROM activity ORDER BY server'),
      this.pool.query('SELECT DISTINCT type FROM activity ORDER BY type'),
    ]);
    return { servers: s.rows.map((r) => String(r.server)), types: t.rows.map((r) => String(r.type)) };
  }

  /** (The pool is the accounts': they close it) */
  async close(): Promise<void> {}
}

function toEvent(r: any): ActivityEvent {
  return { id: Number(r.id), at: Number(r.at), server: r.server, type: r.type, player: r.player, other: r.other, detail: r.detail };
}
