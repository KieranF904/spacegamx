/**
 * PostgresDonationStore: donations in the `donations` table (../../schema.sql), sharing the accounts' pool.
 * The table is made at start when it's missing (as schema.sql would), so a deploy needn't re-apply the schema.
 */

import type { AccountTotal, DonationRecord, DonationStatus, DonationStore } from './types.js';

interface PgPool {
  query(sql: string, params?: any[]): Promise<{ rows: any[] }>;
}

/** schema.sql's statements for donations (run at start: IF NOT EXISTS, so an existing database only gains the table) */
export const DONATIONS_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS donations (
    id              BIGSERIAL PRIMARY KEY,
    user_id         BIGINT REFERENCES users(id) ON DELETE SET NULL,
    amount          BIGINT NOT NULL,
    currency        TEXT NOT NULL,
    paypal_order_id TEXT NOT NULL UNIQUE,
    capture_id      TEXT UNIQUE,
    status          TEXT NOT NULL,
    created_at      BIGINT NOT NULL,
    completed_at    BIGINT
  )`,
  'CREATE INDEX IF NOT EXISTS idx_donations_user ON donations(user_id, status)',
];

const COLUMNS = 'id, user_id, amount, currency, paypal_order_id, capture_id, status, created_at, completed_at';
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

const toRecord = (r: any): DonationRecord => ({
  id: Number(r.id), user_id: num(r.user_id), amount: Number(r.amount), currency: String(r.currency), paypal_order_id: String(r.paypal_order_id),
  capture_id: r.capture_id === null || r.capture_id === undefined ? null : String(r.capture_id), status: String(r.status) as DonationStatus,
  created_at: Number(r.created_at), completed_at: num(r.completed_at),
});

export class PostgresDonationStore implements DonationStore {
  constructor(private pool: PgPool) {}

  static async create(pool: PgPool): Promise<PostgresDonationStore> {
    try {
      for (const sql of DONATIONS_SCHEMA) await pool.query(sql);
    } catch (e) {
      throw new Error(`The "donations" table is missing and this database user can't make it: run server-browser/schema.sql as the tables' owner (${e})`);
    }
    return new PostgresDonationStore(pool);
  }

  async create(row: { user_id: number | null; amount: number; currency: string; paypal_order_id: string; created_at: number }): Promise<DonationRecord> {
    const r = await this.pool.query(
      `INSERT INTO donations (user_id, amount, currency, paypal_order_id, status, created_at) VALUES ($1, $2, $3, $4, 'CREATED', $5) RETURNING ${COLUMNS}`,
      [row.user_id, row.amount, row.currency, row.paypal_order_id, row.created_at]);
    return toRecord(r.rows[0]);
  }

  async byOrder(orderId: string): Promise<DonationRecord | null> {
    const r = await this.pool.query(`SELECT ${COLUMNS} FROM donations WHERE paypal_order_id = $1`, [orderId]);
    return r.rows[0] ? toRecord(r.rows[0]) : null;
  }

  async complete(orderId: string, capture: { capture_id: string; amount: number; currency: string; at: number }): Promise<{ row: DonationRecord; first: boolean } | null> {
    // (One statement: two capture answers at once can't both complete it)
    // (`first`: the statement that changed the row, so only one caller ever gets it)
    const r = await this.pool.query(
      `UPDATE donations SET status = 'COMPLETED', capture_id = $2, amount = $3, currency = $4, completed_at = $5 WHERE paypal_order_id = $1 AND status <> 'COMPLETED' RETURNING id`,
      [orderId, capture.capture_id, capture.amount, capture.currency, capture.at]);
    const row = await this.byOrder(orderId);
    return row ? { row, first: r.rows.length > 0 } : null;
  }

  async setStatus(orderId: string, status: 'PENDING' | 'FAILED'): Promise<void> {
    await this.pool.query(`UPDATE donations SET status = $2 WHERE paypal_order_id = $1 AND status <> 'COMPLETED'`, [orderId, status]);
  }

  async totalFor(userId: number, currency: string): Promise<number> {
    const r = await this.pool.query(`SELECT COALESCE(SUM(amount), 0) AS total FROM donations WHERE user_id = $1 AND status = 'COMPLETED' AND currency = $2`, [userId, currency]);
    return Number(r.rows[0]?.total ?? 0);
  }

  async forUser(userId: number, limit: number): Promise<DonationRecord[]> {
    const r = await this.pool.query(`SELECT ${COLUMNS} FROM donations WHERE user_id = $1 AND status <> 'CREATED' ORDER BY id DESC LIMIT $2`, [userId, limit]);
    return r.rows.map(toRecord);
  }

  async recent(limit: number): Promise<DonationRecord[]> {
    const r = await this.pool.query(`SELECT ${COLUMNS} FROM donations WHERE status <> 'CREATED' ORDER BY id DESC LIMIT $1`, [limit]);
    return r.rows.map(toRecord);
  }

  async totals(currency: string, limit: number): Promise<AccountTotal[]> {
    const r = await this.pool.query(
      `SELECT user_id, SUM(amount) AS total, COUNT(*) AS count FROM donations WHERE status = 'COMPLETED' AND currency = $1 GROUP BY user_id ORDER BY total DESC LIMIT $2`,
      [currency, limit]);
    return r.rows.map((row) => ({ user_id: num(row.user_id), total: Number(row.total), count: Number(row.count) }));
  }

  async pruneUnpaid(before: number): Promise<number> {
    const r = await this.pool.query(`DELETE FROM donations WHERE status = 'CREATED' AND created_at < $1 RETURNING id`, [before]);
    return r.rows.length;
  }

  /** (The table's ON DELETE SET NULL does it) */
  async forgetUser(): Promise<void> {}

  /** (The pool is the accounts') */
  async close(): Promise<void> {}
}
