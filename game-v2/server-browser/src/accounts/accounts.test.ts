import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type http from 'http';
import { JsonUserStore } from './JsonUserStore.js';
import { AccountRoutes } from './routes.js';
import { BAN_FOREVER } from './utils.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function store() {
  const dir = mkdtempSync(join(tmpdir(), 'lobby-'));
  dirs.push(dir);
  return { file: join(dir, 'users.json'), store: new JsonUserStore(join(dir, 'users.json')) };
}

/** The routes, called as nginx or a game server would (no real sockets) */
async function routes(s: JsonUserStore, secret = 'sssh') {
  let body: object = {};
  let out: { status: number; body: any } = { status: 0, body: null };
  const r = await AccountRoutes.create((_, status, b) => { out = { status, body: b }; }, async () => body, () => '127.0.0.1', { store: s, adminSecret: secret });
  return async (url: string, b: object, auth?: string) => {
    body = b;
    const req = { method: 'POST', headers: auth ? { authorization: `Bearer ${auth}` } : {} } as unknown as http.IncomingMessage;
    await r.handle(req, {} as http.ServerResponse, url);
    return out;
  };
}

describe('lobby bans', () => {
  it('a banned account can\'t sign in or validate until the ban ends; unbanning lets it back', async () => {
    const { store: s } = store();
    const reg = await s.register('rowdy', 'rowdy@example.com', 'pw');
    if (!reg.success) throw new Error(reg.error);
    const id = reg.user.id;
    expect(reg.user.banned_until).toBeNull();

    await s.setBan(id, Date.now() + 60_000, 'griefing', 'boss');
    const login = await s.login('rowdy', 'pw');
    expect(login.success).toBe(false);
    expect(!login.success && login.error).toMatch(/banned until .* UTC: griefing/);
    // A wrong password doesn't say the name is banned
    const wrong = await s.login('rowdy', 'nope');
    expect(!wrong.success && wrong.error).toBe('Invalid username or password');
    // Their old session: the lobby refuses it, saying why
    const call = await routes(s);
    const v = await call('/auth/validate', { token: reg.token });
    expect(v.status).toBe(403);
    expect(v.body.error).toMatch(/griefing/);

    // For good
    await s.setBan(id, BAN_FOREVER, 'cheating', 'boss');
    const perm = await s.login('rowdy', 'pw');
    expect(!perm.success && perm.error).toBe('This account is banned permanently: cheating');

    await s.setBan(id, null, '', '');
    expect((await s.login('rowdy', 'pw')).success).toBe(true);
    expect((await call('/auth/validate', { token: reg.token })).body.success).toBe(true);
    const back = await s.getUserById(id);
    expect([back?.banned_until, back?.ban_reason, back?.banned_by]).toEqual([null, null, null]);
  });

  it('an ended ban is no ban', async () => {
    const { store: s } = store();
    const reg = await s.register('brief', 'brief@example.com', 'pw');
    if (!reg.success) throw new Error(reg.error);
    await s.setBan(reg.user.id, Date.now() - 1, 'spam', 'boss');
    expect((await s.login('brief', 'pw')).success).toBe(true);
    const call = await routes(s);
    expect((await call('/auth/validate', { token: reg.token })).body.success).toBe(true);
    const list = await call('/admin/users', { search: 'brief' }, 'sssh');
    expect(list.body.users[0].ban).toBeNull();
  });

  it('reads records from before bans, and keeps bans across a restart', async () => {
    const { file, store: s } = store();
    await s.register('old', 'old@example.com', 'pw');
    await s.close();
    // Strip the ban fields, as an old file would be
    const raw = JSON.parse(readFileSync(file, 'utf-8'));
    for (const u of raw.users) { delete u.banned_until; delete u.ban_reason; delete u.banned_by; }
    writeFileSync(file, JSON.stringify(raw));
    const again = new JsonUserStore(file);
    const old = await again.getUserByUsername('OLD');
    expect(old?.banned_until).toBeNull();
    expect((await again.login('old', 'pw')).success).toBe(true);
    await again.setBan(old!.id, BAN_FOREVER, 'x', 'boss');
    await again.close();
    expect((await new JsonUserStore(file).login('old', 'pw')).success).toBe(false);
  });
});

describe('lobby admin endpoints', () => {
  it('need the secret', async () => {
    const { store: s } = store();
    const call = await routes(s);
    expect((await call('/admin/users', {})).status).toBe(403);
    expect((await call('/admin/users', {}, 'wrong')).status).toBe(403);
    expect((await call('/admin/users', {}, 'sssh')).status).toBe(200);
    // No secret configured: off entirely
    const off = await routes(s, '');
    expect((await off('/admin/users', {}, '')).status).toBe(403);
  });

  it('list and search by prefix, a page at a time, with no emails or credentials', async () => {
    const { store: s } = store();
    for (const n of ['alpha', 'alpine', 'beta']) await s.register(n, `${n}@example.com`, 'pw');
    const call = await routes(s);
    const al = await call('/admin/users', { search: 'AL' }, 'sssh');
    expect(al.body.users.map((u: any) => u.username)).toEqual(['alpha', 'alpine']);
    expect(al.body.total).toBe(2);
    const page = await call('/admin/users', { offset: 1, limit: 2 }, 'sssh');
    expect(page.body.users).toHaveLength(2);
    expect(page.body.total).toBe(4); // (and the seeded admin)
    const text = JSON.stringify(page.body);
    expect(text).not.toMatch(/email|password|salt|@example/);
  });

  it('set admin, ban (timed or for good) and unban by username', async () => {
    const { store: s } = store();
    await s.register('pilot', 'pilot@example.com', 'pw');
    const call = await routes(s);
    expect((await call('/admin/set-admin', { username: 'Pilot', isAdmin: true }, 'sssh')).body.user.isAdmin).toBe(true);
    expect((await s.getUserByUsername('pilot'))?.is_admin).toBe(true);

    const until = Date.now() + 3_600_000;
    const ban = await call('/admin/ban', { username: 'pilot', until, reason: 'rude', by: 'boss' }, 'sssh');
    expect(ban.body.user.ban).toEqual({ until, reason: 'rude', by: 'boss' });
    const perm = await call('/admin/ban', { username: 'pilot', until: null, reason: 'ruder', by: 'boss' }, 'sssh');
    expect(perm.body.user.ban).toEqual({ until: null, reason: 'ruder', by: 'boss' });
    expect((await call('/admin/ban', { username: 'pilot', until: Date.now() - 5 }, 'sssh')).status).toBe(400);
    expect((await call('/admin/unban', { username: 'pilot' }, 'sssh')).body.user.ban).toBeNull();
    expect((await call('/admin/ban', { username: 'nobody', until: null }, 'sssh')).status).toBe(404);
  });
});

describe('lobby account management', () => {
  async function pilot() {
    const { file, store: s } = store();
    const reg = await s.register('ace', 'ace@example.com', 'old-pw');
    if (!reg.success) throw new Error(reg.error);
    return { file, s, token: reg.token, id: reg.user.id, call: await routes(s) };
  }

  it('shows the account (email included) only for a live session', async () => {
    const { token, call } = await pilot();
    const me = await call('/auth/account', { token });
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ success: true, username: 'ace', email: 'ace@example.com', isAdmin: false });
    expect(JSON.stringify(me.body)).not.toMatch(/salt|hash/);
    expect((await call('/auth/account', { token: 'nope' })).status).toBe(401);
    expect((await call('/auth/account', {})).status).toBe(401);
  });

  it('changes the password with the old one, ending the other sessions but not this one', async () => {
    const { s, token, call } = await pilot();
    const other = await s.login('ace', 'old-pw');
    if (!other.success) throw new Error(other.error);
    expect((await call('/auth/change-password', { token, password: 'wrong', newPassword: 'x' })).status).toBe(401);
    expect((await call('/auth/change-password', { token, password: 'old-pw', newPassword: '' })).status).toBe(400);
    const ok = await call('/auth/change-password', { token, password: 'old-pw', newPassword: 'new-pw' });
    expect(ok.body.success).toBe(true);
    expect((await s.login('ace', 'old-pw')).success).toBe(false);
    expect((await s.login('ace', 'new-pw')).success).toBe(true);
    expect(await s.validateSession(token)).not.toBeNull();
    expect(await s.validateSession(other.token)).toBeNull();
  });

  it('changes the email (valid, not someone else\'s) with the password', async () => {
    const { s, token, call } = await pilot();
    await s.register('bob', 'bob@example.com', 'pw');
    expect((await call('/auth/change-email', { token, password: 'old-pw', email: 'BOB@example.com' })).body.error).toBe('Email already registered');
    expect((await call('/auth/change-email', { token, password: 'old-pw', email: 'nope' })).status).toBe(400);
    expect((await call('/auth/change-email', { token, password: 'bad', email: 'a@b.cd' })).status).toBe(401);
    const ok = await call('/auth/change-email', { token, password: 'old-pw', email: ' New@Example.com ' });
    expect(ok.body).toEqual({ success: true, email: 'new@example.com' });
    // Signs in by the new email
    expect((await s.login('new@example.com', 'old-pw')).success).toBe(true);
  });

  it('signs out everywhere', async () => {
    const { s, token, call } = await pilot();
    const other = await s.login('ace', 'old-pw');
    if (!other.success) throw new Error(other.error);
    const r = await call('/auth/logout-all', { token });
    expect(r.body).toEqual({ success: true, ended: 2 });
    expect(await s.validateSession(token)).toBeNull();
    expect(await s.validateSession(other.token)).toBeNull();
  });

  it('deletes the account for good with the password, and persists it', async () => {
    const { file, s, token, id, call } = await pilot();
    expect((await call('/auth/delete-account', { token, password: 'nah' })).status).toBe(401);
    expect(await s.getUserById(id)).not.toBeNull();
    const r = await call('/auth/delete-account', { token, password: 'old-pw' });
    expect(r.body).toEqual({ success: true, id });
    expect(await s.getUserById(id)).toBeNull();
    expect(await s.validateSession(token)).toBeNull();
    await s.close();
    expect((await new JsonUserStore(file).login('ace', 'old-pw')).success).toBe(false);
    // The name is free again
    expect((await new JsonUserStore(file).register('ace', 'ace@example.com', 'pw')).success).toBe(true);
  });

  it('a banned account can\'t manage itself', async () => {
    const { s, token, id, call } = await pilot();
    await s.setBan(id, BAN_FOREVER, 'spam', 'boss');
    expect((await call('/auth/account', { token })).status).toBe(403);
    expect((await call('/auth/delete-account', { token, password: 'old-pw' })).status).toBe(403);
    expect(await s.getUserById(id)).not.toBeNull();
  });
});

describe('lobby registration', () => {
  it('a name is taken whatever its case', async () => {
    const { store: s } = store();
    expect((await s.register('Dusty', 'd1@example.com', 'pw')).success).toBe(true);
    const again = await s.register('Dusty', 'd2@example.com', 'pw');
    expect(!again.success && again.error).toBe('Username already taken');
    expect((await s.register('dUSTY', 'd3@example.com', 'pw')).success).toBe(false);
    expect((await s.register('Other', 'D1@Example.com', 'pw')).success).toBe(false); // email too
  });
});
