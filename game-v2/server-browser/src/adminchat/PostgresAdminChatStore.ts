/**
 * PostgresAdminChatStore: the admin message log in the `admin_messages` table (../../schema.sql), sharing the accounts'
 * pool. The table is made at start when it's missing (as schema.sql would), so a deploy needn't re-apply the schema.
 */

import { KEEP, type AdminChatStore, type AdminMessageRecord, type Direction, type MessageStatus, type NewAdminMessage } from './types.js';

interface PgPool {
  query(sql: string, params?: any[]): Promise<{ rows: any[] }>;
}

/** schema.sql's statements for the admin message log (run at start: IF NOT EXISTS, so an existing database only gains the table) */
export const ADMIN_MESSAGES_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS admin_messages (
    id        BIGSERIAL PRIMARY KEY,
    at        BIGINT NOT NULL,
    server    TEXT NOT NULL,
    direction TEXT NOT NULL,
    admin     TEXT NOT NULL,
    pilot     TEXT NOT NULL DEFAULT '',
    body      TEXT NOT NULL,
    status    TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_admin_messages_pilot ON admin_messages(lower(pilot), id DESC)',
];

const COLUMNS = 'id, at, server, direction, admin, pilot, body, status';
const toRecord = (r: any): AdminMessageRecord => ({
  id: Number(r.id), at: Number(r.at), server: String(r.server), direction: String(r.direction) as Direction, admin: String(r.admin),
  pilot: String(r.pilot), body: String(r.body), status: String(r.status) as MessageStatus,
});

export class PostgresAdminChatStore implements AdminChatStore {
  private adds = 0;

  constructor(private pool: PgPool, private keep = KEEP) {}

  static async create(pool: PgPool): Promise<PostgresAdminChatStore> {
    try {
      for (const sql of ADMIN_MESSAGES_SCHEMA) await pool.query(sql);
    } catch (e) {
      throw new Error(`The "admin_messages" table is missing and this database user can't make it: run server-browser/schema.sql as the tables' owner (${e})`);
    }
    return new PostgresAdminChatStore(pool);
  }

  async add(row: NewAdminMessage): Promise<AdminMessageRecord> {
    const r = await this.pool.query(
      `INSERT INTO admin_messages (at, server, direction, admin, pilot, body, status) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${COLUMNS}`,
      [row.at, row.server, row.direction, row.admin, row.pilot, row.body, row.status]);
    // (The log keeps its newest rows, as the activity feed does: trimmed now and then, not on every message)
    if (++this.adds % 200 === 0) {
      void this.pool.query('DELETE FROM admin_messages WHERE id <= (SELECT MAX(id) FROM admin_messages) - $1', [this.keep]).catch((err) => console.error('[AdminChat] trimming the log failed:', err));
    }
    return toRecord(r.rows[0]);
  }

  async setStatus(ids: number[], status: MessageStatus): Promise<void> {
    if (!ids.length) return;
    await this.pool.query('UPDATE admin_messages SET status = $2 WHERE id = ANY($1::bigint[])', [ids, status]);
  }

  async list(q: { server?: string; pilot?: string; limit: number }): Promise<AdminMessageRecord[]> {
    const where: string[] = [], params: any[] = [];
    if (q.server) { params.push(q.server); where.push(`(server = $${params.length} OR server = '')`); }
    if (q.pilot !== undefined) { params.push(q.pilot.toLowerCase()); where.push(`(lower(pilot) = $${params.length} OR (pilot = '' AND server <> ''))`); }
    params.push(q.limit);
    const r = await this.pool.query(`SELECT ${COLUMNS} FROM admin_messages ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT $${params.length}`, params);
    return r.rows.map(toRecord).reverse();
  }

  /** (The pool is the accounts') */
  async close(): Promise<void> {}
}
