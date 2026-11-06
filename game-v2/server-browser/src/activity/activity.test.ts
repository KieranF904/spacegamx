import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type http from 'http';
import { JsonUserStore } from '../accounts/JsonUserStore.js';
import { AccountRoutes } from '../accounts/routes.js';
import { ActivityRoutes, CALLS_PER_MIN, INGEST_MAX, LOBBY_NAME } from './routes.js';
import { JsonActivityStore } from './JsonActivityStore.js';
import { ACTIVITY_SCHEMA, PostgresActivityStore } from './PostgresActivityStore.js';
import { MAX_SERVERS } from './types.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'lobby-activity-'));
  dirs.push(dir);
  return dir;
}

const SECRET = 'game-servers-secret';

/** Accounts (admin "boss", pilot "alice"), the feed's routes, called like the lobby does */
async function setup(opts: { store?: JsonActivityStore } = {}) {
  const users = new JsonUserStore(join(tmp(), 'users.json'));
  const reg = async (name: string) => {
    const r = await users.register(name, `${name}@example.com`, 'password1');
    if (!r.success) throw new Error(r.error);
    return r;
  };
  const boss = await reg('boss');
  await users.setAdmin(boss.user.id, true);
  const alice = await reg('alice');
  const store = opts.store ?? new JsonActivityStore(null);
  let body: unknown = {};
  let out: { status: number; body: any } = { status: 0, body: null };
  const routes = await ActivityRoutes.create(users, (_, status, b) => { out = { status, body: b }; }, async () => body, () => '10.0.0.1',
    { store, adminSecret: SECRET, dataDir: tmp(), live: () => ['Local dev'] });
  const call = async (url: string, b: unknown, auth?: string) => {
    body = b;
    const req = { method: 'POST', headers: auth !== undefined ? { authorization: `Bearer ${auth}` } : {} } as unknown as http.IncomingMessage;
    out = { status: 0, body: null };
    return (await routes.handle(req, {} as http.ServerResponse, url)) ? out : null;
  };
  const ingest = (server: string, events: unknown[], auth = SECRET) => call('/admin/activity/ingest', { server, events }, auth);
  const read = (token: string, q: object = {}) => call('/activity/read', { token, ...q });
  return { users, store, routes, call, ingest, read, boss: boss.token, alice: alice.token, bossId: boss.user.id };
}

const ev = (type: string, player: string, detail = '', other = '') => ({ at: Date.now(), type, player, detail, other });

describe('activity ingest (game servers)', () => {
  it('refuses a call without the shared secret, or with a wrong one, and stores nothing', async () => {
    const t = await setup();
    expect((await t.call('/admin/activity/ingest', { server: 'Fake', events: [ev('join', 'mallory')] }))!.status).toBe(403);
    expect((await t.ingest('Fake', [ev('join', 'mallory')], 'guess'))!.status).toBe(403);
    expect((await t.ingest('Fake', [ev('join', 'mallory')], ''))!.status).toBe(403);
    expect(await t.store.list({ limit: 10 })).toEqual([]);
  });

  it('is off without a secret (production with none set)', async () => {
    const users = new JsonUserStore(join(tmp(), 'users.json'));
    let status = 0;
    const r = await ActivityRoutes.create(users, (_, s) => { status = s; }, async () => ({ server: 'X', events: [] }), () => '', { store: new JsonActivityStore(null), adminSecret: '', dataDir: tmp() });
    await r.handle({ method: 'POST', headers: { authorization: 'Bearer ' } } as unknown as http.IncomingMessage, {} as http.ServerResponse, '/admin/activity/ingest');
    expect(status).toBe(403);
  });

  it("can't pose as the lobby; skips bad events and cleans the rest", async () => {
    const t = await setup();
    expect((await t.ingest(LOBBY_NAME, [ev('signin', 'alice')]))!.status).toBe(400);
    expect((await t.ingest('lobby', [ev('signin', 'alice')]))!.status).toBe(400);
    const r = (await t.ingest('Local dev', [
      ev('join', 'alice', 'Joined'),
      { type: 'DROP TABLE', player: 'x' },
      { type: 'level', player: 'a\u0000b\nc'.padEnd(200, 'z'), detail: 'x'.repeat(500), at: 1 },
      null,
    ]))!;
    expect(r.body).toEqual({ success: true, stored: 2 });
    const [level, join] = await t.store.list({ limit: 10 });
    expect(join).toMatchObject({ server: 'Local dev', type: 'join', player: 'alice', detail: 'Joined' });
    expect(level.player).toHaveLength(40);
    expect(level.player.startsWith('a b c')).toBe(true);
    expect(level.detail).toHaveLength(200);
    // (A stamp far from the lobby's clock is replaced by its own)
    expect(Math.abs(level.at - Date.now())).toBeLessThan(5000);
  });

  it('limits batch size and calls per server', async () => {
    const t = await setup();
    expect((await t.ingest('Local dev', Array.from({ length: INGEST_MAX + 1 }, () => ev('join', 'a'))))!.status).toBe(413);
    for (let i = 0; i < CALLS_PER_MIN; i++) expect((await t.ingest('Local dev', [ev('join', 'a')]))!.status).toBe(200);
    expect((await t.ingest('Local dev', [ev('join', 'a')]))!.status).toBe(429);
    // (Another server has its own allowance)
    expect((await t.ingest('AUS Main', [ev('join', 'a')]))!.status).toBe(200);
  });
});

describe('activity read (the admin panel)', () => {
  it('needs an admin session: none is 401, a pilot or a banned admin 403 (with feed: true)', async () => {
    const t = await setup();
    await t.ingest('Local dev', [ev('join', 'alice')]);
    expect((await t.read(''))!).toMatchObject({ status: 401, body: { success: false, feed: true } });
    expect((await t.read('not-a-token'))!.status).toBe(401);
    expect((await t.read(t.alice))!).toMatchObject({ status: 403, body: { feed: true } });
    expect((await t.read(t.alice))!.body.events).toBeUndefined();
    // (The shared secret is no way in: it's only for sending)
    expect((await t.call('/activity/read', {}, SECRET))!.status).toBe(401);
    await t.users.setBan(t.bossId, Date.now() + 60_000, 'test', 'x');
    expect((await t.read(t.boss))!.status).toBe(403);
  });

  it('answers an admin newest first, with filters, a search, live updates (after) and the facets', async () => {
    const t = await setup();
    await t.ingest('Local dev', [ev('join', 'alice', 'Joined as a guest'), ev('death', 'alice', 'Destroyed by Scrap Mite'), ev('trade', 'bob', 'Traded 3 items', 'alice')]);
    await t.ingest('AUS Main', [ev('boss_kill', 'carol', 'Killed The Maw')]);
    const all = (await t.read(t.boss))!.body;
    expect(all).toMatchObject({ success: true, feed: true, live: ['Local dev'], servers: ['AUS Main', 'Local dev'] });
    expect(all.types).toEqual(['boss_kill', 'death', 'join', 'trade']);
    expect(all.events.map((e: any) => e.type)).toEqual(['boss_kill', 'trade', 'death', 'join']);
    const ids = all.events.map((e: any) => e.id);
    expect([...ids].sort((a: number, b: number) => b - a)).toEqual(ids);

    const types = async (q: object) => (await t.read(t.boss, q))!.body.events.map((e: any) => e.type);
    expect(await types({ server: 'AUS Main' })).toEqual(['boss_kill']);
    expect(await types({ type: 'death' })).toEqual(['death']);
    // (A pilot on either side)
    expect(await types({ player: 'ALICE' })).toEqual(['trade', 'death', 'join']);
    expect(await types({ search: 'scrap mite' })).toEqual(['death']);
    expect(await types({ search: 'maw carol' })).toEqual(['boss_kill']);
    expect(await types({ after: ids[1] })).toEqual(['boss_kill']);
    expect(await types({ before: ids[1] })).toEqual(['death', 'join']);
    expect(await types({ limit: 2 })).toEqual(['boss_kill', 'trade']);
  });

  it("the lobby's own events (sign-in, sign-out, registration) go in as the Lobby, never a password or token", async () => {
    const t = await setup();
    let body: any = {};
    const accounts = await AccountRoutes.create(() => {}, async () => body, () => '10.0.0.9', { store: t.users, adminSecret: SECRET });
    accounts.onActivity = (type, player, detail, other) => t.routes.record(type, player, detail, other);
    const post = async (url: string, b: object) => { body = b; await accounts.handle({ method: 'POST', headers: {} } as unknown as http.IncomingMessage, {} as http.ServerResponse, url); };
    await post('/auth/register', { username: 'dave', email: 'd@example.com', password: 'password1' });
    await post('/auth/login', { username: 'alice', password: 'password1' });
    await post('/auth/logout', { token: t.alice });
    await new Promise((r) => setTimeout(r, 0));
    const events = await t.store.list({ limit: 10, server: LOBBY_NAME });
    expect(events.map((e) => [e.type, e.player])).toEqual([['signout', 'alice'], ['signin', 'alice'], ['register', 'dave']]);
    expect(JSON.stringify(events)).not.toMatch(/password1|d@example\.com|tok/i);
  });

  it('CORS: only the allowed origins get an answer they can read', async () => {
    const t = await setup();
    const headers = new Map<string, string>([['Access-Control-Allow-Origin', '*']]);
    const res = { setHeader: (k: string, v: string) => headers.set(k, v), removeHeader: (k: string) => headers.delete(k) } as unknown as http.ServerResponse;
    const req = (origin: string) => ({ headers: { origin } }) as unknown as http.IncomingMessage;
    t.routes.cors(req('https://space.brotherk3d.com'), res, '/activity/read');
    expect(headers.get('Access-Control-Allow-Origin')).toBe('https://space.brotherk3d.com');
    t.routes.cors(req('https://evil.example'), res, '/activity/read');
    expect(headers.has('Access-Control-Allow-Origin')).toBe(false);
    // (The rest of the lobby is left as it was)
    headers.set('Access-Control-Allow-Origin', '*');
    t.routes.cors(req('https://evil.example'), res, '/list');
    expect(headers.get('Access-Control-Allow-Origin')).toBe('*');
  });
});

describe('activity storage', () => {
  it('keeps at most N events per server (oldest go first), each server its own', async () => {
    const store = new JsonActivityStore(null, 5);
    await store.add(Array.from({ length: 12 }, (_, i) => ({ at: i, server: 'A', type: 'join', player: `p${i}`, other: '', detail: '' })));
    await store.add([{ at: 0, server: 'B', type: 'join', player: 'b', other: '', detail: '' }]);
    const a = await store.list({ server: 'A', limit: 100 });
    expect(a.map((e) => e.player)).toEqual(['p11', 'p10', 'p9', 'p8', 'p7']);
    expect((await store.list({ server: 'B', limit: 100 })).length).toBe(1);
  });

  it("refuses servers past MAX_SERVERS (the store can't be grown by names)", async () => {
    const store = new JsonActivityStore(null);
    for (let i = 0; i < MAX_SERVERS + 5; i++) await store.add([{ at: 0, server: `s${i}`, type: 'join', player: 'x', other: '', detail: '' }]);
    expect((await store.facets()).servers).toHaveLength(MAX_SERVERS);
  });

  it('is kept in its file across a restart (ids carry on)', async () => {
    const file = join(tmp(), 'activity.json');
    const a = new JsonActivityStore(file, 100, 0);
    await a.add([{ at: 1, server: 'A', type: 'join', player: 'x', other: '', detail: 'hi' }]);
    await a.close();
    const b = new JsonActivityStore(file);
    expect(await b.list({ limit: 10 })).toMatchObject([{ id: 1, player: 'x', detail: 'hi' }]);
    expect((await b.add([{ at: 2, server: 'A', type: 'leave', player: 'x', other: '', detail: '' }]))[0].id).toBe(2);
  });
});

describe('PostgresActivityStore', () => {
  function fakePool(answer: (sql: string, params: any[]) => any[] = () => []) {
    const queries: { sql: string; params: any[] }[] = [];
    return { queries, query: async (sql: string, params: any[] = []) => { queries.push({ sql, params }); return { rows: answer(sql, params) }; } };
  }

  it('makes its table at start; inserts a batch in one statement, then prunes the server past the cap', async () => {
    const pool = fakePool((sql, params) => (sql.startsWith('INSERT') ? params[0].map((at: number, i: number) => ({ id: String(i + 1), at: String(at), server: params[1][i], type: params[2][i], player: params[3][i], other: params[4][i], detail: params[5][i] })) : []));
    const store = await PostgresActivityStore.create(pool);
    expect(pool.queries.map((q) => q.sql)).toEqual(ACTIVITY_SCHEMA);
    const out = await store.add([{ at: 5, server: 'AUS Main', type: 'join', player: 'a', other: '', detail: 'd' }, { at: 6, server: 'AUS Main', type: 'leave', player: 'a', other: '', detail: '' }]);
    expect(out).toMatchObject([{ id: 1, at: 5, type: 'join' }, { id: 2, at: 6, type: 'leave' }]);
    expect(pool.queries.filter((q) => q.sql.startsWith('INSERT'))).toHaveLength(1);
    const prune = pool.queries.find((q) => q.sql.startsWith('DELETE'))!;
    expect(prune.params).toEqual(['AUS Main', 5000]);
  });

  it('filters with parameters only (a search is text, never SQL)', async () => {
    const pool = fakePool();
    const store = await PostgresActivityStore.create(pool);
    await store.list({ after: 3, server: 'AUS Main', type: 'death', player: 'Alice', search: "50%_off'; DROP TABLE users;--", limit: 20 });
    const q = pool.queries.at(-1)!;
    expect(q.sql).not.toMatch(/DROP|Alice|AUS Main/);
    expect(q.params).toEqual([3, 'AUS Main', 'death', 'alice', '%50\\%\\_off\';%', '%drop%', '%table%', '%users;--%', 20]);
  });
});
