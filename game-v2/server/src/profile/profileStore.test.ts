import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { JsonProfileStore } from './JsonProfileStore.js';
import { MemoryProfileStore, type ProfileStore } from './ProfileStore.js';

/** The contract every backend meets (the Postgres one runs this too when DATABASE_URL is set) */
function contract(name: string, make: () => Promise<{ store: ProfileStore; done: () => void }>) {
  describe(`${name} profile store`, () => {
    it('loads null for a new account, then what was saved', async () => {
      const { store, done } = await make();
      expect(await store.load(1)).toBeNull();
      await store.save(1, { version: 1, credits: 42 });
      expect(await store.load(1)).toEqual({ version: 1, credits: 42 });
      await store.close();
      done();
    });

    it('deletes a save for good (and deleting nothing is fine)', async () => {
      const { store, done } = await make();
      await store.save(3, { version: 1, credits: 7 });
      await store.save(4, { version: 1, credits: 8 });
      await store.delete(3);
      await store.delete(3);
      await store.delete(99);
      expect(await store.load(3)).toBeNull();
      expect(await store.load(4)).toEqual({ version: 1, credits: 8 });
      await store.close();
      done();
    });

    it('deletes a save for good (and deleting nothing is fine)', async () => {
      const { store, done } = await make();
      await store.save(3, { version: 1, credits: 7 });
      await store.save(4, { version: 1, credits: 8 });
      await store.delete(3);
      await store.delete(3);
      await store.delete(99);
      expect(await store.load(3)).toBeNull();
      expect(await store.load(4)).toEqual({ version: 1, credits: 8 });
      await store.close();
      done();
    });

    it('the newest save wins when saves overlap', async () => {
      const { store, done } = await make();
      const writes = [1, 2, 3, 4, 5].map((n) => store.save(2, { version: 1, credits: n }));
      await Promise.all(writes);
      expect(await store.load(2)).toEqual({ version: 1, credits: 5 });
      await store.close();
      done();
    });
  });
}

contract('memory', async () => ({ store: new MemoryProfileStore(), done: () => {} }));
contract('JSON', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'profiles-'));
  return { store: new JsonProfileStore(dir), done: () => rmSync(dir, { recursive: true, force: true }) };
});
// (Needs a scratch database with server-browser/schema.sql applied: profiles belong to accounts, so the test adds a few)
if (process.env.DATABASE_URL) {
  contract('postgres', async () => {
    const { PostgresProfileStore } = await import('./PostgresProfileStore.js');
    const moduleName = 'pg';
    const pg: any = await import(moduleName);
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    const ids = [1, 2, 3, 4, 9];
    await pool.query('DELETE FROM profiles WHERE user_id = ANY($1)', [ids]);
    for (const id of ids) {
      await pool.query(
        `INSERT INTO users (id, username, email, password_hash, salt) VALUES ($1::bigint, 'profile-test-' || $1::text, 'profile-test-' || $1::text || '@example.com', 'x', 'x') ON CONFLICT (id) DO NOTHING`,
        [id]);
    }
    // (Explicit ids don't move the id sequence: keep it ahead of them)
    await pool.query("SELECT setval(pg_get_serial_sequence('users', 'id'), (SELECT max(id) FROM users))");
    // (The test accounts stay for the next run; delete them with the scratch database)
    return { store: await PostgresProfileStore.create(process.env.DATABASE_URL!), done: () => void pool.end() };
  });
}

describe('JSON profile store', () => {
  it('moves an unreadable file aside instead of locking the pilot out', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'profiles-'));
    writeFileSync(join(dir, '9.json'), '{ not json');
    const store = new JsonProfileStore(dir);
    expect(await store.load(9)).toBeNull();
    expect(readdirSync(dir).some((f) => f.startsWith('9.json.broken-'))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
