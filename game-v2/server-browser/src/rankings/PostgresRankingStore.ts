/**
 * PostgresRankingStore: the rows in the `ranking_rows` table (../../schema.sql), sharing the accounts' pool. One row per
 * account; the two boards' numbers are jsonb. The table is made at start when it's missing (as schema.sql would).
 */
import { cleanStats, type RankRecord } from './board.js';
import type { RankingStore } from './types.js';

interface PgPool { query(sql: string, params?: any[]): Promise<{ rows: any[] }> }

/** schema.sql's statements for the rankings (run at start: IF NOT EXISTS) */
export const RANKINGS_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ranking_rows (
    user_id    BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    week       BIGINT NOT NULL,
    weekly     JSONB NOT NULL DEFAULT '{}',
    all_time   JSONB NOT NULL DEFAULT '{}',
    updated_at BIGINT NOT NULL
  )`,
];

const toRecord = (r: any): RankRecord => ({ userId: Number(r.user_id), name: String(r.name), week: Number(r.week), weekly: cleanStats(r.weekly), allTime: cleanStats(r.all_time) });

export class PostgresRankingStore implements RankingStore {
  constructor(private pool: PgPool) {}

  static async create(pool: PgPool): Promise<PostgresRankingStore> {
    try {
      for (const sql of RANKINGS_SCHEMA) await pool.query(sql);
    } catch (e) {
      throw new Error(`The "ranking_rows" table is missing and this database user can't make it: run server-browser/schema.sql as the tables' owner (${e})`);
    }
    return new PostgresRankingStore(pool);
  }

  async get(userIds: number[]): Promise<Map<number, RankRecord>> {
    const ids = [...new Set(userIds)];
    if (!ids.length) return new Map();
    const r = await this.pool.query('SELECT user_id, name, week, weekly, all_time FROM ranking_rows WHERE user_id = ANY($1::bigint[])', [ids]);
    return new Map(r.rows.map((row) => [Number(row.user_id), toRecord(row)]));
  }

  async all(): Promise<RankRecord[]> {
    return (await this.pool.query('SELECT user_id, name, week, weekly, all_time FROM ranking_rows')).rows.map(toRecord);
  }

  async put(rows: RankRecord[]): Promise<void> {
    const now = Date.now();
    for (const r of rows) {
      await this.pool.query(
        `INSERT INTO ranking_rows (user_id, name, week, weekly, all_time, updated_at) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)
         ON CONFLICT (user_id) DO UPDATE SET name = $2, week = $3, weekly = $4::jsonb, all_time = $5::jsonb, updated_at = $6`,
        [r.userId, r.name, r.week, JSON.stringify(r.weekly), JSON.stringify(r.allTime), now]);
    }
  }

  async forgetUser(userId: number): Promise<void> {
    await this.pool.query('DELETE FROM ranking_rows WHERE user_id = $1', [userId]);
  }

  async close(): Promise<void> {}
}
