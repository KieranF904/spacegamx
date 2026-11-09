/**
 * A pg pool in memory for tests: understands only the statements PostgresProfileStore sends
 * (profiles, game_docs, profile_leases), with its own clock standing in for the database's now().
 * Shared by every "server" in a test, as one database is.
 */

import type { PgPool } from './PostgresProfileStore.js';

export class FakePgPool implements PgPool {
  profiles = new Map<number, unknown>();
  docs = new Map<string, unknown>();
  leases = new Map<number, { holder: string; until: number }>();
  /** The database's clock (ms) */
  clock = 1_000_000;
  /** Set to make every query fail (the database is unreachable) */
  down = false;
  log: string[] = [];

  async query(sql: string, params: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
    if (this.down) throw new Error('connection refused');
    const q = sql.replace(/\s+/g, ' ').trim();
    this.log.push(q.slice(0, 40));
    if (q.startsWith('CREATE TABLE')) return { rows: [] };
    if (q.startsWith('SELECT data FROM profiles')) {
      const d = this.profiles.get(params[0] as number);
      return { rows: d === undefined ? [] : [{ data: JSON.parse(d as string) }] };
    }
    if (q.startsWith('INSERT INTO profiles')) { this.profiles.set(params[0] as number, params[2]); return { rows: [] }; }
    if (q.startsWith('DELETE FROM profiles')) { this.profiles.delete(params[0] as number); return { rows: [] }; }
    if (q.startsWith('SELECT data FROM game_docs')) {
      const d = this.docs.get(params[0] as string);
      return { rows: d === undefined ? [] : [{ data: JSON.parse(d as string) }] };
    }
    if (q.startsWith('INSERT INTO game_docs')) { this.docs.set(params[0] as string, params[1]); return { rows: [] }; }
    if (q.startsWith('INSERT INTO profile_leases')) {
      const [id, holder, ttl] = params as [number, string, number];
      const cur = this.leases.get(id);
      if (cur && cur.holder !== holder && cur.until >= this.clock) return { rows: [] }; // the WHERE of the upsert
      this.leases.set(id, { holder, until: this.clock + ttl });
      return { rows: [{ holder }] };
    }
    if (q.startsWith('SELECT holder FROM profile_leases')) {
      const cur = this.leases.get(params[0] as number);
      return { rows: cur ? [{ holder: cur.holder }] : [] };
    }
    if (q.startsWith('UPDATE profile_leases')) {
      const [ids, holder, ttl] = params as [number[], string, number];
      const rows: Record<string, unknown>[] = [];
      for (const id of ids) {
        const cur = this.leases.get(id);
        if (cur && cur.holder === holder) { cur.until = this.clock + ttl; rows.push({ user_id: id }); }
      }
      return { rows };
    }
    if (q.startsWith('DELETE FROM profile_leases')) {
      const [id, holder] = params as [number, string];
      if (this.leases.get(id)?.holder === holder) this.leases.delete(id);
      return { rows: [] };
    }
    throw new Error(`FakePgPool: unknown statement ${q}`);
  }

  async end(): Promise<void> {}
}
