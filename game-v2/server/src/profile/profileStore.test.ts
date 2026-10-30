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
if (process.env.DATABASE_URL) {
  contract('postgres', async () => {
    const { PostgresProfileStore } = await import('./PostgresProfileStore.js');
    return { store: await PostgresProfileStore.create(process.env.DATABASE_URL!), done: () => {} };
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
