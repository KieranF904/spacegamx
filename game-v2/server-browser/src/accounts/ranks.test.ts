import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type http from 'http';
import { JsonUserStore } from './JsonUserStore.js';
import { AccountRoutes, applyOwners } from './routes.js';
import { DeletedAccounts } from './DeletedAccounts.js';
import { PostgresUserStore, OWNER_COLUMN } from './PostgresUserStore.js';

/** The owner rank: owner > admin > pilot (routes.ts rankRefusal) */

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function newStore() {
  const dir = mkdtempSync(join(tmpdir(), 'lobby-ranks-'));
  dirs.push(dir);
  const file = join(dir, 'users.json');
  return { file, store: new JsonUserStore(file) };
}

async function routes(s: JsonUserStore, opts: { ownerUsernames?: string; deleted?: DeletedAccounts } = {}) {
  let body: object = {};
  let out: { status: number; body: any } = { status: 0, body: null };
  const r = await AccountRoutes.create((_, status, b) => { out = { status, body: b }; }, async () => body, () => '127.0.0.1', { store: s, adminSecret: 'sssh', ...opts });
  return async (url: string, b: object, auth: string | undefined = 'sssh') => {
    body = b;
    const req = { method: 'POST', headers: auth ? { authorization: `Bearer ${auth}` } : {} } as unknown as http.IncomingMessage;
    await r.handle(req, {} as http.ServerResponse, url);
    return out;
  };
}

/** A lobby with an owner (boss), an admin (mod), another admin (mod2) and a pilot (ace) */
async function cast(opts: { deleted?: DeletedAccounts } = {}) {
  const { store: s, file } = newStore();
  const ids: Record<string, number> = {};
  const tokens: Record<string, string> = {};
  for (const n of ['boss', 'mod', 'mod2', 'ace']) {
    const r = await s.register(n, `${n}@example.com`, 'pw-12345');
    if (!r.success) throw new Error(r.error);
    ids[n] = r.user.id;
    tokens[n] = r.token;
  }
  await s.setOwner(ids.boss, true);
  await s.setAdmin(ids.mod, true);
  await s.setAdmin(ids.mod2, true);
  return { s, file, ids, tokens, call: await routes(s, opts) };
}

describe('owner rank: the stores', () => {
  it('JSON: is_owner defaults to false, is set and kept across a restart', async () => {
    const { store: s, file } = newStore();
    const r = await s.register('kier', 'kier@example.com', 'pw-12345');
    if (!r.success) throw new Error(r.error);
    expect(r.user.is_owner).toBe(false);
    await s.setOwner(r.user.id, true);
    expect((await s.getUserById(r.user.id))?.is_owner).toBe(true);
    await s.close();
    const again = new JsonUserStore(file);
    expect((await again.getUserByUsername('KIER'))?.is_owner).toBe(true);
    await again.close();
  });

  it('JSON: records from before the rank read as not owners', async () => {
    const { store: s, file } = newStore();
    await s.register('old', 'old@example.com', 'pw-12345');
    await s.close();
    const raw = JSON.parse(readFileSync(file, 'utf-8'));
    for (const u of raw.users) delete u.is_owner;
    writeFileSync(file, JSON.stringify(raw));
    const again = new JsonUserStore(file);
    expect((await again.getUserByUsername('old'))?.is_owner).toBe(false);
    await again.close();
  });

  it('Postgres: adds the is_owner column to a database from before it, and not twice', async () => {
    const sql: string[] = [];
    let has = false;
    const pool = {
      async query(q: string) {
        sql.push(q);
        if (q.includes('information_schema')) return { rows: [{ users: true, owner: has }] };
        if (q === OWNER_COLUMN) has = true;
        return { rows: [] };
      },
      async connect() { throw new Error('unused'); },
      async end() {},
    };
    const store = new PostgresUserStore(pool);
    await store.upgrade();
    expect(sql.filter((q) => q === OWNER_COLUMN)).toHaveLength(1);
    await store.upgrade();
    expect(sql.filter((q) => q === OWNER_COLUMN)).toHaveLength(1);
    // schema.sql has the same statement (a fresh database gets it there)
    expect(readFileSync(join(__dirname, '../../schema.sql'), 'utf-8')).toMatch(/ALTER TABLE users ADD COLUMN IF NOT EXISTS is_owner\s+BOOLEAN NOT NULL DEFAULT FALSE/);
  });

  it('Postgres: reads and writes is_owner', async () => {
    const sql: { q: string; p?: unknown[] }[] = [];
    const pool = {
      async query(q: string, p?: unknown[]) {
        sql.push({ q, p });
        return { rows: [{ id: '3', username: 'kier', email: 'k@x.io', is_admin: false, is_owner: true, created_at: new Date(0), banned_until: null, ban_reason: null, banned_by: null }] };
      },
      async connect() { throw new Error('unused'); },
      async end() {},
    };
    const store = new PostgresUserStore(pool);
    expect((await store.getUserById(3))?.is_owner).toBe(true);
    expect(sql[0].q).toMatch(/is_owner/);
    await store.setOwner(3, true);
    expect(sql[1]).toEqual({ q: 'UPDATE users SET is_owner = $1 WHERE id = $2', p: [true, 3] });
  });
});

describe('owner rank: the lobby', () => {
  it('an owner passes every admin check: validate, account and the admin list say admin', async () => {
    const { tokens, call } = await cast();
    expect((await call('/auth/validate', { token: tokens.boss })).body).toMatchObject({ success: true, isAdmin: true, isOwner: true });
    expect((await call('/auth/validate', { token: tokens.mod })).body).toMatchObject({ isAdmin: true, isOwner: false });
    expect((await call('/auth/account', { token: tokens.boss })).body).toMatchObject({ isAdmin: true, isOwner: true });
    expect((await call('/admin/user', { username: 'boss' })).body.user).toMatchObject({ isAdmin: true, isOwner: true });
    // An owner can act as an admin on the lobby's behalf
    expect((await call('/admin/ban', { username: 'ace', until: null, reason: 'x', by: 'boss', actor: 'boss' })).status).toBe(200);
  });

  it("an admin can't grant or revoke admin, or ban, unban or delete an admin or the owner", async () => {
    const { s, ids, call } = await cast();
    const grant = await call('/admin/set-admin', { username: 'ace', isAdmin: true, actor: 'mod' });
    expect(grant.status).toBe(403);
    expect(grant.body.error).toMatch(/Only the owner/);
    expect((await s.getUserById(ids.ace))?.is_admin).toBe(false);
    expect((await call('/admin/set-admin', { username: 'mod2', isAdmin: false, actor: 'mod' })).status).toBe(403);
    const banAdmin = await call('/admin/ban', { username: 'mod2', until: null, reason: 'x', by: 'mod', actor: 'mod' });
    expect(banAdmin.status).toBe(403);
    expect(banAdmin.body.error).toMatch(/only the owner can ban an admin/);
    const banOwner = await call('/admin/ban', { username: 'boss', until: null, reason: 'x', by: 'mod', actor: 'mod' });
    expect(banOwner.status).toBe(403);
    expect((await s.getUserById(ids.boss))?.banned_until).toBeNull();
    expect((await s.getUserById(ids.mod2))?.banned_until).toBeNull();
    expect((await call('/admin/delete', { username: 'ace', actor: 'mod' })).status).toBe(403);
    expect(await s.getUserById(ids.ace)).not.toBeNull();
    await s.setBan(ids.mod2, Date.now() + 60_000, 'x', 'boss');
    expect((await call('/admin/unban', { username: 'mod2', actor: 'mod' })).status).toBe(403);
    // Moderation of pilots stays theirs
    expect((await call('/admin/ban', { username: 'ace', until: null, reason: 'spam', by: 'mod', actor: 'mod' })).status).toBe(200);
    expect((await call('/admin/unban', { username: 'ace', actor: 'mod' })).status).toBe(200);
  });

  it('the owner can grant and revoke admin, ban an admin and delete accounts', async () => {
    const deleted = new DeletedAccounts(null);
    const { s, ids, call } = await cast({ deleted });
    expect((await call('/admin/set-admin', { username: 'ace', isAdmin: true, actor: 'boss' })).body.user).toMatchObject({ isAdmin: true, isOwner: false });
    expect((await call('/admin/set-admin', { username: 'ace', isAdmin: false, actor: 'boss' })).body.user.isAdmin).toBe(false);
    const ban = await call('/admin/ban', { username: 'mod2', until: null, reason: 'rogue', by: 'boss', actor: 'boss' });
    expect(ban.status).toBe(200);
    expect(ban.body.user.ban).toMatchObject({ until: null, reason: 'rogue', by: 'boss' });
    expect((await call('/admin/unban', { username: 'mod2', actor: 'boss' })).status).toBe(200);
    const del = await call('/admin/delete', { username: 'ace', actor: 'boss' });
    expect(del.body).toMatchObject({ success: true, id: ids.ace, username: 'ace' });
    expect(await s.getUserById(ids.ace)).toBeNull();
    expect(deleted.recent()).toEqual([ids.ace]); // the game servers delete the profile too
  });

  it("nobody bans, demotes or deletes the owner through the tools, the owner included", async () => {
    const { s, ids, call } = await cast();
    for (const [url, b] of [
      ['/admin/ban', { username: 'boss', until: null, reason: 'x', by: 'boss' }],
      ['/admin/set-admin', { username: 'boss', isAdmin: false }],
      ['/admin/delete', { username: 'boss' }],
    ] as const) {
      expect((await call(url, b)).status).toBe(403);
      expect((await call(url, { ...b, actor: 'boss' })).status).toBe(403);
    }
    expect(await s.getUserById(ids.boss)).toMatchObject({ is_owner: true, banned_until: null });
  });

  it("an actor who isn't an admin (or doesn't exist, or is banned) is refused", async () => {
    const { s, ids, call } = await cast();
    expect((await call('/admin/ban', { username: 'mod', until: null, reason: 'x', by: 'ace', actor: 'ace' })).body.error).toBe('Only an admin can do that');
    expect((await call('/admin/unban', { username: 'ace', actor: 'nobody' })).status).toBe(403);
    await s.setBan(ids.mod, Date.now() + 60_000, 'x', 'boss');
    expect((await call('/admin/set-admin', { username: 'ace', isAdmin: true, actor: 'mod' })).status).toBe(403);
  });

  it("the secret's set-owner makes and unmakes the owner; never on a user's behalf, never without the secret", async () => {
    const { s, ids, call } = await cast();
    const made = await call('/admin/set-owner', { username: 'ace', isOwner: true });
    expect(made.body.user).toMatchObject({ username: 'ace', isOwner: true, isAdmin: true });
    expect((await s.getUserById(ids.ace))?.is_owner).toBe(true);
    expect((await call('/admin/set-owner', { username: 'ace', isOwner: false })).body.user.isOwner).toBe(false);
    expect((await call('/admin/set-owner', { username: 'mod', isOwner: true, actor: 'boss' })).status).toBe(403);
    expect((await call('/admin/set-owner', { username: 'mod', isOwner: true }, 'wrong')).status).toBe(403);
    expect((await call('/admin/set-owner', { username: 'mod', isOwner: true }, '')).status).toBe(403);
    expect((await s.getUserById(ids.mod))?.is_owner).toBe(false);
    // The secret alone (an older game server, no actor) still grants admin
    expect((await call('/admin/set-admin', { username: 'ace', isAdmin: true })).body.user.isAdmin).toBe(true);
  });

  it('OWNER_USERNAMES makes the named accounts owners at start (case and spaces aside; unknown names skipped)', async () => {
    const { store: s } = newStore();
    for (const n of ['kier', 'other', 'third']) await s.register(n, `${n}@example.com`, 'pw-12345');
    const call = await routes(s, { ownerUsernames: ' KIER , ghost,third ' });
    expect((await s.getUserByUsername('kier'))?.is_owner).toBe(true);
    expect((await s.getUserByUsername('third'))?.is_owner).toBe(true);
    expect((await s.getUserByUsername('other'))?.is_owner).toBe(false);
    expect((await call('/admin/user', { username: 'kier' })).body.user.isOwner).toBe(true);
    // (Again: nothing changes, nothing breaks)
    expect(await applyOwners(s, 'kier,ghost')).toEqual(['kier']);
  });

  it('OWNER_USERNAMES is read from the environment at lobby start', async () => {
    const { store: s } = newStore();
    await s.register('envboss', 'envboss@example.com', 'pw-12345');
    const before = process.env.OWNER_USERNAMES;
    process.env.OWNER_USERNAMES = 'envboss';
    try {
      await routes(s);
      expect((await s.getUserByUsername('envboss'))?.is_owner).toBe(true);
    } finally {
      if (before === undefined) delete process.env.OWNER_USERNAMES; else process.env.OWNER_USERNAMES = before;
    }
  });
});
