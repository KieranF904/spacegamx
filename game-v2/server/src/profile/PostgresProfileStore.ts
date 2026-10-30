/**
 * PostgresProfileStore: profiles as jsonb rows in the `profiles` table
 * (schema.sql). Enabled alongside PostgresUserStore by
 * USER_STORE_BACKEND=postgres and DATABASE_URL.
 *
 * Like PostgresUserStore, 'pg' is loaded only when this backend is used.
 */

import type { ProfileStore } from './ProfileStore.js';

interface PgPool {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

export class PostgresProfileStore implements ProfileStore {
  private constructor(private pool: PgPool) {}

  static async create(connectionString: string): Promise<PostgresProfileStore> {
    const moduleName = 'pg';
    const pg: any = await import(moduleName);
    const store = new PostgresProfileStore(new pg.Pool({ connectionString }) as PgPool);
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
    return store;
  }

  async load(userId: number): Promise<unknown | null> {
    const r = await this.pool.query('SELECT data FROM profiles WHERE user_id = $1', [userId]);
    return r.rows[0]?.data ?? null;
  }

  async save(userId: number, profile: unknown): Promise<void> {
    const version = (profile as { version?: number }).version ?? 0;
    await this.pool.query(
      `INSERT INTO profiles (user_id, version, data, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (user_id) DO UPDATE SET version = EXCLUDED.version, data = EXCLUDED.data, updated_at = now()`,
      [userId, version, JSON.stringify(profile)],
    );
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
    await this.pool.end();
  }
}
