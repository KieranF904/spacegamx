/**
 * The JSON -> Postgres migration tool. The database part runs only when MIGRATE_TEST_DATABASE_URL names a scratch
 * database (it EMPTIES users, sessions, profiles and game_docs there):
 *   MIGRATE_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/spacetest npx vitest run scripts/db
 */
import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { JsonUserStore } from '../../server-browser/src/accounts/JsonUserStore.js';
import { DeletedAccounts } from '../../server-browser/src/accounts/DeletedAccounts.js';
import {
  RefusedError, canonical, loadJsonSource, loadNormaliser, planMigration, schemaStatements, verify, writePlan,
} from './migrateJsonToPostgres.js';

// (The lobby seeds its dev admin only with DEV_AUTH=1: the test makes one to show the tool never does)
process.env.DEV_AUTH = '1';
const SCHEMA = readFileSync(join(__dirname, '../../server-browser/schema.sql'), 'utf-8');

/** A data folder like the VPS's: alice (id 2) with a save, bob (id 3) deleted after playing, an admin (id 1) */
async function makeData(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'pg-migrate-test-'));
  const store = new JsonUserStore(join(dir, 'lobby', 'users.json')); // (seeds admin/admin outside production: id 1)
  const alice = await store.register('alice', 'Alice@Example.com', 'correct horse 1');
  const bob = await store.register('bob', 'bob@example.com', 'battery staple 2');
  if (!alice.success || !bob.success) throw new Error('register failed');
  await store.setBan(alice.user.id, Date.now() + 60_000, 'test', 'admin');
  await store.setBan(alice.user.id, null, '', '');
  await store.deleteUser(bob.user.id);
  await store.close();
  new DeletedAccounts(join(dir, 'lobby', 'deleted-accounts.json')).add(bob.user.id);
  mkdirSync(join(dir, 'profiles'));
  writeFileSync(join(dir, 'profiles', `${alice.user.id}.json`), JSON.stringify({ version: 1, credits: 1234, xp: 5, zeta: { b: 1, a: [1, 'é', null] } }));
  writeFileSync(join(dir, 'profiles', `${bob.user.id}.json`), JSON.stringify({ version: 1, credits: 9 })); // (an orphan)
  writeFileSync(join(dir, 'profiles', '_rankings.json'), JSON.stringify({ week: '2026-W44', weekly: {}, allTime: { [alice.user.id]: 3 } }));
  writeFileSync(join(dir, 'profiles', '2.json.bak-by-hand'), '{}');
  return dir;
}

describe('migration tool: offline parts', () => {
  it('applies the schema DDL but never its seed admin account', () => {
    const { ddl, dropped } = schemaStatements(SCHEMA);
    expect(ddl.some((s) => /^CREATE TABLE IF NOT EXISTS users\b/.test(s))).toBe(true);
    expect(ddl.some((s) => /^CREATE TABLE IF NOT EXISTS profiles\b/.test(s))).toBe(true);
    expect(ddl.some((s) => /INSERT/i.test(s))).toBe(false);
    // (The schema seeds no accounts; were one added, it would be dropped, never applied)
    expect(dropped).toEqual([]);
    expect(schemaStatements(SCHEMA + "\nINSERT INTO users (username) VALUES ('x');\n").dropped).toEqual(['INSERT INTO users']);
    // (CRLF checkouts too)
    expect(schemaStatements(SCHEMA.replace(/\r?\n/g, '\r\n')).ddl).toEqual(ddl);
  });

  it('compares JSON values whatever the key order', () => {
    expect(canonical({ b: 1, a: { d: [1, { y: 1, x: 2 }], c: null } })).toBe(canonical({ a: { c: null, d: [1, { x: 2, y: 1 }] }, b: 1 }));
    expect(canonical({ a: [1, 2] })).not.toBe(canonical({ a: [2, 1] }));
  });

  it('reads through the stores from a copy: the source is left exactly as it was, and no admin is seeded', async () => {
    const dir = await makeData();
    const before = (sub: string) => readdirSync(join(dir, sub)).sort().map((f) => `${f}:${readFileSync(join(dir, sub, f), 'utf-8')}`);
    const lobby = before('lobby');
    const profiles = before('profiles');
    // An accounts file with no admin: the lobby would seed admin/admin outside production; the tool never does
    const file = join(dir, 'lobby', 'users.json');
    const raw = JSON.parse(readFileSync(file, 'utf-8'));
    raw.users = raw.users.filter((u: { username: string }) => u.username !== 'admin');
    writeFileSync(file, JSON.stringify(raw));
    const lobbyNoAdmin = before('lobby');
    const src = await loadJsonSource(dir);
    expect(src.users.map((u) => u.username)).toEqual(['alice']);
    expect(src.nextUserId).toBe(4);
    expect(src.deletedIds).toEqual([3]);
    expect(before('lobby')).toEqual(lobbyNoAdmin);
    expect(before('profiles')).toEqual(profiles);
    expect(lobby).not.toEqual(lobbyNoAdmin);
    const plan = planMigration(src);
    expect(plan.profiles.map(([id]) => id)).toEqual([2]);
    expect(plan.skipped.join('; ')).toMatch(/profiles of accounts that no longer exist: 3/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('leaves expired sessions behind', async () => {
    const dir = await makeData();
    const src = await loadJsonSource(dir);
    const live = src.sessions.length;
    src.sessions.push({ token: 'old', user_id: 2, expires_at: 1 });
    expect(planMigration(src).sessions).toHaveLength(live);
    rmSync(dir, { recursive: true, force: true });
  });
});

const url = process.env.MIGRATE_TEST_DATABASE_URL;
describe.skipIf(!url)('migration tool: against a scratch database', () => {
  it('copies accounts, sessions, profiles and docs with their ids; sign-in works; ids are not reused; re-runs are refused unless --replace', async () => {
    const dir = await makeData();
    const src = await loadJsonSource(dir);
    const plan = planMigration(src);
    const res = await writePlan(plan, { databaseUrl: url!, schemaSql: SCHEMA, replace: true });
    expect(res.written).toEqual({ users: 2, sessions: 1, profiles: 1, game_docs: 1 }); // (alice's session; bob's went with him)
    expect(res.nextUserId).toBe(4);

    const checks = await verify(url!, plan, src, loadNormaliser(join(__dirname, '../../data')));
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    expect(checks.find((c) => c.name === 'profile 2')?.detail).toMatch(/after migrateProfile deep-equal/);

    const { PostgresUserStore } = await import('../../server-browser/src/accounts/PostgresUserStore.js');
    const store = await PostgresUserStore.create(url!);
    try {
      // The same password signs in (the hash and salt came across untouched); a wrong one doesn't
      const ok = await store.login('alice', 'correct horse 1');
      expect(ok.success && ok.user.id).toBe(2);
      expect((await store.login('alice@example.com', 'wrong')).success).toBe(false);
      expect((await store.login('admin', 'admin')).success).toBe(true);
      // A new account takes nextUserId, never bob's id
      const carol = await store.register('carol', 'carol@example.com', 'another one 3');
      expect(carol.success && carol.user.id).toBe(4);
    } finally {
      await store.close();
    }

    // A second run without --replace is refused; a dry run changes nothing; --replace re-syncs
    await expect(writePlan(plan, { databaseUrl: url!, schemaSql: SCHEMA })).rejects.toBeInstanceOf(RefusedError);
    const dry = await writePlan(plan, { databaseUrl: url!, schemaSql: SCHEMA, replace: true, dryRun: true });
    expect(dry.before.users).toBe(3); // (carol still there: the dry run rolled back)
    const again = await writePlan(plan, { databaseUrl: url!, schemaSql: SCHEMA, replace: true });
    expect(again.before.users).toBe(3);
    expect(again.written.users).toBe(2);
    expect((await verify(url!, plan, src, null)).filter((c) => !c.ok)).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
    expect(existsSync(dir)).toBe(false);
  }, 60_000);
});
