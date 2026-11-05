import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readdirSync, rmSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { JsonProfileStore, BACKUP_DAYS } from './JsonProfileStore.js';
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

describe('JSON profile store: data safety (docs/audits/server-robustness.md)', () => {
  const tmp = () => mkdtempSync(join(tmpdir(), 'profiles-'));

  it("a file it can't read (not a broken one) is an error, and is left where it is", async () => {
    const dir = tmp();
    // (A folder where the file should be: reading it fails with EISDIR, like EACCES or EMFILE would)
    mkdirSync(join(dir, '5.json'));
    const store = new JsonProfileStore(dir);
    await expect(store.load(5)).rejects.toThrow();
    expect(readdirSync(dir)).toEqual(['5.json']);
    rmSync(dir, { recursive: true, force: true });
  });

  it('a save that fails says so, and leaves the last good save whole', async () => {
    const dir = tmp();
    const store = new JsonProfileStore(dir);
    await store.save(6, { version: 1, credits: 1 });
    // (The temp file can't be made: a folder is in its way... simplest: make the target a folder after a good save)
    rmSync(join(dir, '6.json'));
    mkdirSync(join(dir, '6.json'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(store.save(6, { version: 1, credits: 2 })).rejects.toThrow();
    err.mockRestore();
    // Nothing half written is left lying about, and the queue still works afterwards
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    rmSync(join(dir, '6.json'), { recursive: true });
    await store.save(6, { version: 1, credits: 3 });
    expect(await store.load(6)).toEqual({ version: 1, credits: 3 });
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps a daily copy (the last BACKUP_DAYS), and loads it when the save is broken', async () => {
    const dir = tmp();
    let now = Date.parse('2026-01-01T12:00:00Z');
    const store = new JsonProfileStore(dir, () => now);
    for (let day = 0; day < BACKUP_DAYS + 3; day++) {
      await store.save(8, { version: 1, credits: day });
      await store.save(8, { version: 1, credits: day + 0.5 });
      now += 24 * 3600_000;
    }
    const copies = readdirSync(join(dir, 'backups', '8'));
    expect(copies.length).toBe(BACKUP_DAYS);
    // Each day's copy is the save from before that day's first write
    const newest = copies.sort().at(-1)!;
    expect(JSON.parse(readFileSync(join(dir, 'backups', '8', newest), 'utf-8')).credits).toBe(BACKUP_DAYS + 1.5);
    // Corrupt: kept aside, and the newest copy comes back instead of a fresh start
    writeFileSync(join(dir, '8.json'), '{"version":1,"cred');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await store.load(8)).toEqual({ version: 1, credits: BACKUP_DAYS + 1.5 });
    err.mockRestore();
    expect(readdirSync(dir).some((f) => f.startsWith('8.json.broken-'))).toBe(true);
    // Deleting the account takes its copies too
    await store.delete(8);
    expect(existsSync(join(dir, 'backups', '8'))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('a broken rankings file is kept aside, not replaced by the next save', async () => {
    const dir = tmp();
    writeFileSync(join(dir, '_rankings.json'), '{oops');
    const store = new JsonProfileStore(dir);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await store.loadDoc('rankings')).toBeNull();
    err.mockRestore();
    await store.saveDoc('rankings', { a: 1 });
    expect(readdirSync(dir).some((f) => f.startsWith('_rankings.json.broken-'))).toBe(true);
    expect(await store.loadDoc('rankings')).toEqual({ a: 1 });
    rmSync(dir, { recursive: true, force: true });
  });
});
