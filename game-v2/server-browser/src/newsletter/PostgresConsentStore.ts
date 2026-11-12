/**
 * PostgresConsentStore: newsletter consent in the `newsletter_consent` table (../../schema.sql), sharing the accounts'
 * pool. The table is made at start when it's missing (as schema.sql would), so a deploy needn't re-apply the schema.
 * The `users` table is not touched: an account with no row here has not been asked.
 */

import type { ConsentRecord, ConsentStore, ConsentVia } from './types.js';

interface PgPool {
  query(sql: string, params?: any[]): Promise<{ rows: any[] }>;
}

/** schema.sql's statements for newsletter consent (run at start: IF NOT EXISTS, so an existing database only gains the table) */
export const NEWSLETTER_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS newsletter_consent (
    user_id          BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    newsletter       BOOLEAN NOT NULL DEFAULT FALSE,
    newsletter_asked BOOLEAN NOT NULL DEFAULT FALSE,
    newsletter_at    BIGINT,
    newsletter_via   TEXT
  )`,
];

const COLUMNS = 'user_id, newsletter, newsletter_asked, newsletter_at, newsletter_via';
const VIAS = ['signup', 'prompt', 'settings'];

const toRecord = (r: any): ConsentRecord => ({
  user_id: Number(r.user_id), newsletter: r.newsletter === true, newsletter_asked: r.newsletter_asked === true,
  newsletter_at: r.newsletter_at === null || r.newsletter_at === undefined ? null : Number(r.newsletter_at),
  newsletter_via: VIAS.includes(r.newsletter_via) ? r.newsletter_via as ConsentVia : null,
});

export class PostgresConsentStore implements ConsentStore {
  constructor(private pool: PgPool) {}

  static async create(pool: PgPool): Promise<PostgresConsentStore> {
    try {
      for (const sql of NEWSLETTER_SCHEMA) await pool.query(sql);
    } catch (e) {
      throw new Error(`The "newsletter_consent" table is missing and this database user can't make it: run server-browser/schema.sql as the tables' owner (${e})`);
    }
    return new PostgresConsentStore(pool);
  }

  async get(userId: number): Promise<ConsentRecord | null> {
    const r = await this.pool.query(`SELECT ${COLUMNS} FROM newsletter_consent WHERE user_id = $1`, [userId]);
    return r.rows[0] ? toRecord(r.rows[0]) : null;
  }

  async set(userId: number, newsletter: boolean, via: ConsentVia, at: number): Promise<ConsentRecord> {
    const r = await this.pool.query(
      `INSERT INTO newsletter_consent (user_id, newsletter, newsletter_asked, newsletter_at, newsletter_via) VALUES ($1, $2, TRUE, $3, $4)
       ON CONFLICT (user_id) DO UPDATE SET newsletter = EXCLUDED.newsletter, newsletter_asked = TRUE, newsletter_at = EXCLUDED.newsletter_at, newsletter_via = EXCLUDED.newsletter_via
       RETURNING ${COLUMNS}`,
      [userId, newsletter, at, via]);
    return r.rows[0] ? toRecord(r.rows[0]) : { user_id: userId, newsletter, newsletter_asked: true, newsletter_at: at, newsletter_via: via };
  }

  async counts(): Promise<{ consented: number; declined: number }> {
    const r = await this.pool.query(
      `SELECT COUNT(*) FILTER (WHERE newsletter) AS consented, COUNT(*) FILTER (WHERE newsletter_asked AND NOT newsletter) AS declined FROM newsletter_consent`);
    return { consented: Number(r.rows[0]?.consented ?? 0), declined: Number(r.rows[0]?.declined ?? 0) };
  }

  /** (The table's ON DELETE CASCADE does it) */
  async forgetUser(): Promise<void> {}

  /** (The pool is the accounts') */
  async close(): Promise<void> {}
}
