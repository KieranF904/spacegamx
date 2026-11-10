/**
 * PostgresProfileStore: profiles as jsonb rows in the `profiles` table
 * (schema.sql). Enabled alongside PostgresUserStore by
 * USER_STORE_BACKEND=postgres and DATABASE_URL.
 *
 * Like PostgresUserStore, 'pg' is loaded only when this backend is used.
 */

import type { ProfileStore } from './ProfileStore.js';
import { LEASE_MS, type LeaseResult, type ProfileLeases } from './lease.js';

export interface PgPool {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

export class PostgresProfileStore implements ProfileStore, ProfileLeases {
  private constructor(private pool: PgPool) {}

  static async create(connectionString: string): Promise<PostgresProfileStore> {
    const moduleName = 'pg';
    const pg: any = await import(moduleName);
    const pool = new pg.Pool({ connectionString });
    // An idle client dropping (Postgres restart) emits 'error'; unhandled it would crash the process. The pool reconnects on the next query.
    pool.on('error', (err: Error) => console.error('[profiles] postgres pool error:', err.message));
    return PostgresProfileStore.setup(pool as PgPool);
  }

  /** Make the tables (if missing) on a pool */
  static async setup(pool: PgPool): Promise<PostgresProfileStore> {
    const store = new PostgresProfileStore(pool);
    // Same definition as schema.sql, so a database set up before profiles existed still works
    await store.pool.query(`CREATE TABLE IF NOT EXISTS profiles (
      user_id    BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      version    INTEGER NOT NULL,
      data       JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await store.pool.query(`CREATE TABLE IF NOT EXISTS game_docs (
      key        TEXT PRIMARY KEY,
      data       JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await store.pool.query(`CREATE TABLE IF NOT EXISTS profile_leases (
      user_id    BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      holder     TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    )`);
    return store;
  }

  // One game server per account: a row says who holds it and until when (the database's clock, so servers need not agree on the time)

  async claimLease(userId: number, serverId: string, ttlMs = LEASE_MS): Promise<LeaseResult> {
    // (One statement: the insert or the takeover happens only if the row is free, ours or expired)
    const r = await this.pool.query(
      `INSERT INTO profile_leases (user_id, holder, expires_at) VALUES ($1, $2, now() + $3 * interval '1 millisecond')
       ON CONFLICT (user_id) DO UPDATE SET holder = EXCLUDED.holder, expires_at = EXCLUDED.expires_at
       WHERE profile_leases.holder = EXCLUDED.holder OR profile_leases.expires_at < now()
       RETURNING holder`,
      [userId, serverId, ttlMs]);
    if (r.rows.length) return { ok: true };
    const cur = await this.pool.query('SELECT holder FROM profile_leases WHERE user_id = $1', [userId]);
    return { ok: false, holder: String(cur.rows[0]?.holder ?? 'another server') };
  }

  async renewLeases(userIds: number[], serverId: string, ttlMs = LEASE_MS): Promise<number[]> {
    if (!userIds.length) return [];
    const r = await this.pool.query(
      `UPDATE profile_leases SET expires_at = now() + $3 * interval '1 millisecond'
       WHERE user_id = ANY($1) AND holder = $2 RETURNING user_id`,
      [userIds, serverId, ttlMs]);
    return r.rows.map((row) => Number(row.user_id));
  }

  async releaseLease(userId: number, serverId: string): Promise<void> {
    await this.pool.query('DELETE FROM profile_leases WHERE user_id = $1 AND holder = $2', [userId, serverId]);
  }

  async load(userId: number): Promise<unknown | null> {
    const r = await this.pool.query('SELECT data FROM profiles WHERE user_id = $1', [userId]);
    return r.rows[0]?.data ?? null;
  }

  /** Saves of one account go one at a time, newest last (the pool would otherwise run them side by side, in any order) */
  private writing = new Map<number, Promise<unknown>>();

  save(userId: number, profile: unknown): Promise<void> {
    const prev = this.writing.get(userId) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(() => this.write(userId, profile));
    this.writing.set(userId, run);
    void run.catch(() => {}).then(() => { if (this.writing.get(userId) === run) this.writing.delete(userId); });
    return run;
  }

  private async write(userId: number, profile: unknown): Promise<void> {
    const version = (profile as { version?: number }).version ?? 0;
    await this.pool.query(
      `INSERT INTO profiles (user_id, version, data, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (user_id) DO UPDATE SET version = EXCLUDED.version, data = EXCLUDED.data, updated_at = now()`,
      [userId, version, JSON.stringify(profile)],
    );
  }

  async delete(userId: number): Promise<void> {
    await this.writing.get(userId)?.catch(() => {});
    await this.pool.query('DELETE FROM profiles WHERE user_id = $1', [userId]);
  }

  async loadDoc(key: string): Promise<unknown | null> {
    const r = await this.pool.query('SELECT data FROM game_docs WHERE key = $1', [key]);
    return r.rows[0]?.data ?? null;
  }

  async saveDoc(key: string, doc: unknown): Promise<void> {
    await this.pool.query(
      `INSERT INTO game_docs (key, data, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [key, JSON.stringify(doc)],
    );
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.writing.values()]);
    await this.pool.end();
  }
}
