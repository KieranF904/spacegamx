import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type http from 'http';
import { JsonUserStore } from '../accounts/JsonUserStore.js';
import { FriendRoutes, REQUEST_LIMIT, STATUS_LIMIT } from './routes.js';
import { JsonFriendStore } from './JsonFriendStore.js';
import { FRIENDS_SCHEMA, PostgresFriendStore } from './PostgresFriendStore.js';
import { emptyLists, importDoc, MAX_PENDING, request, respond, unfriend, type Lists } from './lists.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'lobby-friends-'));
  dirs.push(dir);
  return dir;
}

const SECRET = 'sssh';

/** Accounts ash, bree, cole, dax and the friends routes, called like the lobby does */
async function setup(opts: { file?: string } = {}) {
  const users = new JsonUserStore(join(tmp(), 'users.json'));
  const ids: Record<string, number> = {};
  for (const name of ['ash', 'bree', 'cole', 'dax']) {
    const r = await users.register(name, `${name}@example.com`, 'password1');
    if (!r.success) throw new Error(r.error);
    ids[name] = r.user.id;
  }
  const clock = { t: 1_000_000 };
  const store = new JsonFriendStore(opts.file ?? null, users);
  let body: unknown = {};
  let out: { status: number; body: any } = { status: 0, body: null };
  const routes = await FriendRoutes.create(users, (_, status, b) => { out = { status, body: b }; }, async () => body,
    { store, adminSecret: SECRET, dataDir: tmp(), now: () => clock.t });
  const call = async (action: string, b: unknown, auth: string | null = SECRET) => {
    body = b;
    const req = { method: 'POST', headers: auth !== null ? { authorization: `Bearer ${auth}` } : {} } as unknown as http.IncomingMessage;
    out = { status: 0, body: null };
    const handled = await routes.handle(req, {} as http.ServerResponse, `/admin/friends/${action}`);
    return handled ? out : null;
  };
  return { users, store, routes, call, ids, clock };
}

const names = (l: { name: string }[]) => l.map((e) => e.name);

describe('friends lists (pure)', () => {
  const lists = (...ids: number[]): Lists => new Map(ids.map((i) => [i, emptyLists()]));
  it('requests, a crossed request accepting itself, decline, removal, and the waiting cap', () => {
    const l = lists(1, 2, 3);
    expect(request(l, 1, 1)).toBe('self');
    expect(request(l, 1, 2)).toBe('sent');
    expect(request(l, 1, 2)).toBe('pending');
    expect(request(l, 2, 1)).toBe('accepted');
    expect(l.get(1)!.friends).toEqual([2]);
    expect(l.get(2)!.friends).toEqual([1]);
    expect(request(l, 3, 1)).toBe('sent');
    expect(respond(l, 1, 3, false)).toBe(false);
    expect(l.get(3)!.out).toEqual([]);
    expect(unfriend(l, 2, 1)).toBe(true);
    expect(l.get(1)!.friends).toEqual([]);
    const crowd = lists(1, ...Array.from({ length: MAX_PENDING + 1 }, (_, i) => 100 + i));
    for (let i = 0; i < MAX_PENDING; i++) expect(request(crowd, 100 + i, 1)).toBe('sent');
    expect(request(crowd, 100 + MAX_PENDING, 1)).toBe('busy');
  });
});

describe('friends routes', () => {
  it('only with the admin secret', async () => {
    const t = await setup();
    expect((await t.call('get', { userId: t.ids.ash }, null))!.status).toBe(403);
    expect((await t.call('get', { userId: t.ids.ash }, 'wrong'))!.status).toBe(403);
    expect((await t.call('get', { userId: t.ids.ash }))!.status).toBe(200);
    // Not ours: left for the other routes
    const req = { method: 'POST', headers: {} } as unknown as http.IncomingMessage;
    expect(await t.routes.handle(req, {} as http.ServerResponse, '/admin/users')).toBe(false);
  });

  it('a secret-less lobby (production with none set) refuses everything', async () => {
    const users = new JsonUserStore(join(tmp(), 'users.json'));
    let status = 0;
    const routes = await FriendRoutes.create(users, (_, s) => { status = s; }, async () => ({ userId: 1 }), { store: new JsonFriendStore(null, users), adminSecret: '', dataDir: tmp() });
    await routes.handle({ method: 'POST', headers: { authorization: 'Bearer ' } } as unknown as http.IncomingMessage, {} as http.ServerResponse, '/admin/friends/get');
    expect(status).toBe(403);
  });

  it('request by name (any case), accept, and both see the other; then remove', async () => {
    const t = await setup();
    const sent = (await t.call('request', { userId: t.ids.ash, name: 'BREE' }))!.body;
    expect(sent).toMatchObject({ success: true, result: 'sent', other: { id: t.ids.bree, name: 'bree' } });
    expect(names(sent.me.outgoing)).toEqual(['bree']);
    expect(names(sent.them.incoming)).toEqual(['ash']);
    const ok = (await t.call('respond', { userId: t.ids.bree, name: 'ash', accept: true }))!.body;
    expect(ok.result).toBe('accepted');
    expect(names(ok.me.friends)).toEqual(['ash']);
    expect(names(ok.them.friends)).toEqual(['bree']);
    const got = (await t.call('get', { userId: t.ids.ash }))!.body;
    expect(got).toEqual({ success: true, status: 'online', friends: [{ id: t.ids.bree, name: 'bree' }], incoming: [], outgoing: [] });
    expect((await t.call('request', { userId: t.ids.ash, name: 'bree' }))!.body.result).toBe('already');
    expect((await t.call('remove', { userId: t.ids.bree, name: 'ash' }))!.body.result).toBe('unfriended');
    expect((await t.call('get', { userId: t.ids.ash }))!.body.friends).toEqual([]);
    // Decline, and a request that has gone
    await t.call('request', { userId: t.ids.cole, name: 'ash' });
    expect((await t.call('respond', { userId: t.ids.ash, name: 'cole', accept: false }))!.body.result).toBe('declined');
    expect((await t.call('respond', { userId: t.ids.ash, name: 'cole', accept: true }))!.body.result).toBe('gone');
  });

  it('checks ids, names and statuses; unknown names and yourself', async () => {
    const t = await setup();
    expect((await t.call('get', { userId: 'x' }))!.status).toBe(400);
    expect((await t.call('get', { userId: -3 }))!.status).toBe(400);
    expect((await t.call('get', { userId: 9999 }))!.status).toBe(404);
    expect((await t.call('request', { userId: t.ids.ash, name: { a: 1 } }))!.status).toBe(400);
    expect((await t.call('request', { userId: t.ids.ash, name: 'nobody' }))!.body.result).toBe('unknown');
    expect((await t.call('request', { userId: t.ids.ash, name: 'Ash' }))!.body.result).toBe('self');
    expect((await t.call('status', { userId: t.ids.ash, status: 'gone fishing' }))!.status).toBe(400);
    expect((await t.call('status', { userId: t.ids.ash, status: 'invisible' }))!.body).toEqual({ success: true, status: 'invisible' });
    expect((await t.call('get', { userId: t.ids.ash }))!.body.status).toBe('invisible');
    expect((await t.call('nope', { userId: t.ids.ash }))!.status).toBe(404);
  });

  it('limits per account (whichever server asks): requests and status changes', async () => {
    const t = await setup();
    for (let i = 0; i < REQUEST_LIMIT; i++) expect((await t.call('request', { userId: t.ids.ash, name: `nobody${i}` }))!.status).toBe(200);
    const r = (await t.call('request', { userId: t.ids.ash, name: 'bree' }))!;
    expect(r.status).toBe(429);
    expect(r.body.limited).toBe(true);
    // Someone else isn't limited by Ash
    expect((await t.call('request', { userId: t.ids.cole, name: 'bree' }))!.status).toBe(200);
    t.clock.t += 10 * 60_000;
    expect((await t.call('request', { userId: t.ids.ash, name: 'bree' }))!.status).toBe(200);
    for (let i = 0; i < STATUS_LIMIT; i++) await t.call('status', { userId: t.ids.dax, status: i % 2 ? 'away' : 'busy' });
    expect((await t.call('status', { userId: t.ids.dax, status: 'online' }))!.status).toBe(429);
  });

  it('a deleted account leaves every list', async () => {
    const t = await setup();
    await t.call('request', { userId: t.ids.ash, name: 'bree' });
    await t.call('respond', { userId: t.ids.bree, name: 'ash', accept: true });
    await t.call('request', { userId: t.ids.cole, name: 'bree' });
    await t.users.deleteUser(t.ids.bree);
    await t.routes.forgetUser(t.ids.bree);
    expect(await t.store.get(t.ids.bree)).toBeNull();
    expect(await t.store.get(t.ids.ash)).toEqual({ status: 'online', friends: [], in: [], out: [] });
    expect(await t.store.get(t.ids.cole)).toEqual({ status: 'online', friends: [], in: [], out: [] });
  });

  it('the JSON file keeps them across a restart', async () => {
    const file = join(tmp(), 'friends.json');
    const t = await setup({ file });
    await t.call('request', { userId: t.ids.ash, name: 'bree' });
    await t.call('status', { userId: t.ids.bree, status: 'busy' });
    await t.store.close();
    expect(JSON.parse(readFileSync(file, 'utf-8')).accounts[t.ids.bree]).toEqual({ status: 'busy', friends: [], in: [t.ids.ash], out: [] });
    const again = new JsonFriendStore(file, t.users);
    expect(await again.get(t.ids.bree)).toEqual({ status: 'busy', friends: [], in: [t.ids.ash], out: [] });
  });
});

describe('importing a game server\'s old friends document', () => {
  it('merges friendships, requests and statuses; deleted accounts skipped; idempotent', async () => {
    const t = await setup();
    const { ash, bree, cole, dax } = t.ids;
    // Dax already has friends here, and a status of his own
    await t.call('status', { userId: dax, status: 'busy' });
    const doc = {
      [ash]: { name: 'ash', status: 'away', friends: [bree, 777], in: [], out: [cole] },
      [bree]: { name: 'bree', status: 'online', friends: [ash], in: [], out: [] },
      [cole]: { name: 'cole', status: 'invisible', friends: [], in: [ash], out: [] },
      [dax]: { name: 'dax', status: 'away', friends: [], in: [], out: [] },
      777: { name: 'gone', status: 'online', friends: [ash], in: [], out: [] },
    };
    const first = (await t.call('import', { accounts: doc }))!.body;
    expect(first).toEqual({ success: true, friends: 1, requests: 1, skipped: 1 });
    const view = async (id: number) => (await t.call('get', { userId: id }))!.body;
    expect(await view(ash)).toMatchObject({ status: 'away', friends: [{ id: bree, name: 'bree' }], outgoing: [{ id: cole, name: 'cole' }] });
    expect(await view(bree)).toMatchObject({ friends: [{ id: ash, name: 'ash' }] });
    expect(await view(cole)).toMatchObject({ status: 'invisible', incoming: [{ id: ash, name: 'ash' }] });
    expect((await view(dax)).status).toBe('busy');
    const before = JSON.stringify(await Promise.all([ash, bree, cole, dax].map((id) => t.store.get(id))));
    const second = (await t.call('import', { accounts: doc }))!.body;
    expect(second).toEqual({ success: true, friends: 0, requests: 0, skipped: 1 });
    expect(JSON.stringify(await Promise.all([ash, bree, cole, dax].map((id) => t.store.get(id))))).toBe(before);
    expect((await t.call('import', { accounts: [1, 2] }))!.status).toBe(400);
  });

  it('importDoc never goes past the caps', () => {
    const l: Lists = new Map([[1, emptyLists()], [2, emptyLists()]]);
    l.get(2)!.in = Array.from({ length: MAX_PENDING }, (_, i) => 100 + i);
    const r = importDoc(l, new Map([[1, { status: 'online', friends: [], in: [], out: [2] }]]), new Set([1, 2]), new Set());
    expect(r.requests).toBe(0);
  });
});

describe('PostgresFriendStore', () => {
  function fakePool(rows: Map<number, any> = new Map()) {
    const queries: { sql: string; params: any[] }[] = [];
    return {
      queries, rows,
      async query(sql: string, params: any[] = []) {
        queries.push({ sql, params });
        if (sql.startsWith('SELECT user_id')) return { rows: [...rows.values()].filter((r) => (Array.isArray(params[0]) ? params[0] : [params[0]]).includes(r.user_id)) };
        if (sql.startsWith('INSERT INTO friend_lists')) {
          rows.set(params[0], { user_id: String(params[0]), status: params[1], friends: params[2].map(String), incoming: params[3].map(String), outgoing: params[4].map(String) });
          rows.get(params[0]).user_id = params[0];
        }
        if (sql.startsWith('SELECT id, username')) return { rows: params[0].map((id: number) => ({ id: String(id), username: `u${id}` })) };
        return { rows: [] };
      },
    };
  }

  it('makes its table, reads bigint arrays as numbers, writes only changed rows, and forgets an account everywhere', async () => {
    const pool = fakePool();
    const store = await PostgresFriendStore.create(pool);
    expect(pool.queries.map((q) => q.sql)).toEqual(FRIENDS_SCHEMA);
    expect(await store.get(1)).toBeNull();
    expect(await store.update([1, 2], (l) => request(l, 1, 2))).toBe('sent');
    expect(await store.get(2)).toEqual({ status: 'online', friends: [], in: [1], out: [] });
    const writes = () => pool.queries.filter((q) => q.sql.startsWith('INSERT')).length;
    expect(writes()).toBe(2);
    await store.update([1, 3], () => 'nothing');
    expect(writes()).toBe(2);
    expect(await store.names([1, 2])).toEqual(new Map([[1, 'u1'], [2, 'u2']]));
    await store.forgetUser(1);
    const sqls = pool.queries.slice(-2).map((q) => q.sql.trim().split(/\s+/).slice(0, 2).join(' '));
    expect(sqls).toEqual(['DELETE FROM', 'UPDATE friend_lists']);
  });
});
