import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type http from 'http';
import { JsonUserStore } from '../accounts/JsonUserStore.js';
import { InboxRoutes } from '../inbox/routes.js';
import { JsonMessageStore } from '../inbox/JsonMessageStore.js';
import { ActivityRoutes } from '../activity/routes.js';
import { JsonActivityStore } from '../activity/JsonActivityStore.js';
import { AdminChatRoutes, FRESH_MS, GIVE_UP_MS, SENDS_PER_MIN, TEXT_MAX } from './routes.js';
import { JsonAdminChatStore } from './JsonAdminChatStore.js';
import { ADMIN_MESSAGES_SCHEMA, PostgresAdminChatStore } from './PostgresAdminChatStore.js';

// (JsonUserStore seeds a dev admin only with DEV_AUTH=1: server-browser/src/accounts/devAuth.ts)
process.env.DEV_AUTH = '1';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'lobby-adminchat-'));
  dirs.push(dir);
  return dir;
}

const SECRET = 'sssh';
const ONLINE = [{ name: 'Ash', guest: false, since: 100 }, { name: 'Guest_12', guest: true, since: 200 }];

/** Accounts (admin "boss", pilots "Ash" and "mallory"), the inbox and the admin chat routes, wired as the lobby's entry wires them */
async function setup(opts: { file?: string } = {}) {
  const users = new JsonUserStore(join(tmp(), 'users.json'));
  const reg = async (name: string) => { const r = await users.register(name, `${name}@example.com`, 'password1'); if (!r.success) throw new Error(r.error); return r; };
  const boss = await reg('boss');
  await users.setAdmin(boss.user.id, true);
  const ash = await reg('Ash');
  await reg('mallory');
  const store = new JsonAdminChatStore(opts.file ?? null);
  let clock = 1_000_000;
  let body: object = {};
  let out: { status: number; body: any } = { status: 0, body: null };
  const send = (_: unknown, status: number, b: any) => { out = { status, body: b }; };
  const inbox = await InboxRoutes.create(users, send, async () => body, () => '10.0.0.1', { store: new JsonMessageStore(null), adminSecret: SECRET, dataDir: tmp() });
  const chat = await AdminChatRoutes.create(users, send, async () => body, { store, adminSecret: SECRET, dataDir: tmp(), now: () => clock, toInbox: (id, subject, text) => inbox.systemMessage(id, subject, text) });
  const call = async (url: string, b: object, auth: string | null = SECRET) => {
    body = b;
    out = { status: 0, body: null };
    const req = { method: 'POST', headers: auth !== null ? { authorization: `Bearer ${auth}` } : {} } as unknown as http.IncomingMessage;
    return (await chat.handle(req, {} as http.ServerResponse, url)) ? out : null;
  };
  /** A game server asking, as server/src/adminChatLink.ts does */
  const poll = async (server: string, extra: object = {}) => (await call('/admin/chat/poll', { server, online: ONLINE, replies: [], failed: [], ack: 0, ...extra }))!.body;
  const mail = async (token: string) => { body = { token }; await inbox.handle({ method: 'POST', headers: {} } as unknown as http.IncomingMessage, {} as http.ServerResponse, '/inbox/list'); return out.body.messages as any[]; };
  return { users, store, chat, call, poll, mail, ashToken: ash.token, tick: (ms: number) => { clock += ms; }, now: () => clock };
}

describe('admin chat: who may call', () => {
  it('every route needs the admin secret', async () => {
    const t = await setup();
    for (const url of ['/admin/chat/poll', '/admin/chat/state', '/admin/chat/send', '/admin/chat/inbox']) {
      for (const auth of [null, '', 'wrong']) expect((await t.call(url, { actor: 'boss', server: 'S', text: 'x', to: 'Ash' }, auth))!.status, url).toBe(403);
    }
    expect(await t.store.list({ limit: 10 })).toEqual([]);
  });

  it('a send, a read or an inbox message must name a real admin who is not banned', async () => {
    const t = await setup();
    await t.poll('AUS Main');
    for (const actor of ['Ash', 'mallory', 'nobody', '', undefined, 5]) {
      expect((await t.call('/admin/chat/send', { actor, server: 'AUS Main', text: 'hi' }))!.status, String(actor)).toBe(403);
      expect((await t.call('/admin/chat/state', { actor }))!.status).toBe(403);
      expect((await t.call('/admin/chat/inbox', { actor, to: 'Ash', text: 'hi' }))!.status).toBe(403);
    }
    const boss = (await t.users.getUserByUsername('boss'))!;
    await t.users.setBan(boss.id, t.now() + 3_600_000 + Date.now(), 'x', 'owner');
    expect((await t.call('/admin/chat/send', { actor: 'boss', server: 'AUS Main', text: 'hi' }))!.status).toBe(403);
    expect((await t.poll('AUS Main')).messages).toEqual([]);
  });

  it('other paths are left to the rest of the lobby', async () => {
    const t = await setup();
    expect(await t.call('/admin/chat/other', {})).toBeNull();
    expect(await t.call('/admin/ban', {})).toBeNull();
    expect(await t.call('/chat/send', {})).toBeNull();
  });
});

describe('admin chat: who is on', () => {
  it('each server tells its roster; the admin sees it while the server keeps asking', async () => {
    const t = await setup();
    await t.poll('AUS Main');
    await t.poll('Local dev', { online: [] });
    let s = (await t.call('/admin/chat/state', { actor: 'boss' }))!.body;
    expect(s.servers).toEqual([{ name: 'AUS Main', fresh: true, online: ONLINE }, { name: 'Local dev', fresh: true, online: [] }]);
    t.tick(FRESH_MS + 1);
    s = (await t.call('/admin/chat/state', { actor: 'boss' }))!.body;
    expect(s.servers.map((x: any) => [x.fresh, x.online.length])).toEqual([[false, 0], [false, 0]]);
  });

  it('a roster is cleaned: names cut and control characters dropped, junk entries skipped', async () => {
    const t = await setup();
    await t.poll('AUS Main', { online: [{ name: 'A\u0000sh<script>', guest: 'yes', since: 'x' }, { name: '' }, null, 5, { name: 'x'.repeat(100), guest: true, since: 7 }] });
    const s = (await t.call('/admin/chat/state', { actor: 'boss' }))!.body;
    expect(s.servers[0].online).toEqual([{ name: 'A sh<script>', guest: false, since: t.now() }, { name: 'x'.repeat(40), guest: true, since: 7 }]);
  });
});

describe('admin chat: sending', () => {
  it('to everyone on a server: handed to that server only, logged with who, where and when', async () => {
    const t = await setup();
    await t.poll('AUS Main');
    await t.poll('EU West');
    const r = (await t.call('/admin/chat/send', { actor: 'BOSS', server: 'AUS Main', text: '  Restart in five  ' }))!;
    expect(r.body).toEqual({ success: true, id: 1 });
    expect((await t.poll('EU West')).messages).toEqual([]);
    expect((await t.poll('AUS Main')).messages).toEqual([{ id: 1, kind: 'all', admin: 'boss', text: 'Restart in five' }]);
    expect(await t.store.list({ limit: 10 })).toEqual([{ id: 1, at: t.now(), server: 'AUS Main', direction: 'out', admin: 'boss', pilot: '', body: 'Restart in five', status: 'queued' }]);
  });

  it('a private message goes only when that pilot is on that server, under the name as the server has it', async () => {
    const t = await setup();
    await t.poll('AUS Main');
    await t.poll('EU West', { online: [{ name: 'Bree', guest: false, since: 1 }] });
    expect((await t.call('/admin/chat/send', { actor: 'boss', server: 'AUS Main', to: 'ash', text: 'Hi' }))!.body).toEqual({ success: true, id: 1 });
    expect((await t.poll('AUS Main')).messages).toEqual([{ id: 1, kind: 'pm', admin: 'boss', to: 'Ash', text: 'Hi' }]);
    for (const [server, to] of [['AUS Main', 'Bree'], ['EU West', 'Ash'], ['AUS Main', 'Nobody']]) {
      const r = (await t.call('/admin/chat/send', { actor: 'boss', server, to, text: 'Hi' }))!;
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ success: false, offline: true, error: `${to} is not online on ${server}` });
    }
    expect((await t.poll('EU West')).messages).toEqual([]);
    expect(await t.store.list({ limit: 10 })).toHaveLength(1);
  });

  it('a message is handed over until the server says it has it, then never again, and is marked sent', async () => {
    const t = await setup();
    await t.poll('AUS Main');
    await t.call('/admin/chat/send', { actor: 'boss', server: 'AUS Main', text: 'one' });
    await t.call('/admin/chat/send', { actor: 'boss', server: 'AUS Main', to: 'Ash', text: 'two' });
    expect((await t.poll('AUS Main')).messages.map((m: any) => m.id)).toEqual([1, 2]);
    expect((await t.poll('AUS Main')).messages.map((m: any) => m.id)).toEqual([1, 2]);
    expect((await t.poll('AUS Main', { ack: 1 })).messages.map((m: any) => m.id)).toEqual([2]);
    expect((await t.poll('AUS Main', { ack: 2 })).messages).toEqual([]);
    expect((await t.poll('AUS Main', { ack: 2 })).messages).toEqual([]);
    expect((await t.store.list({ limit: 10 })).map((m) => m.status)).toEqual(['sent', 'sent']);
  });

  it('a private message whose pilot had gone by the time it arrived is marked failed; a server cannot mark another server\'s', async () => {
    const t = await setup();
    await t.poll('AUS Main');
    await t.poll('EU West');
    await t.call('/admin/chat/send', { actor: 'boss', server: 'AUS Main', to: 'Ash', text: 'still there?' });
    await t.call('/admin/chat/send', { actor: 'boss', server: 'AUS Main', text: 'all' });
    await t.poll('EU West', { ack: 9, failed: [1, 2] });
    expect((await t.store.list({ limit: 10 })).map((m) => m.status)).toEqual(['queued', 'queued']);
    await t.poll('AUS Main', { ack: 2, failed: [1] });
    expect((await t.store.list({ limit: 10 })).map((m) => m.status)).toEqual(['failed', 'sent']);
  });

  it('nothing can be sent to a server that is not connected, or to an empty one; one that stops asking has its messages given up on', async () => {
    const t = await setup();
    expect((await t.call('/admin/chat/send', { actor: 'boss', server: 'Nowhere', text: 'x' }))!.status).toBe(409);
    expect((await t.call('/admin/chat/send', { actor: 'boss', text: 'x' }))!.status).toBe(409);
    await t.poll('Empty', { online: [] });
    expect((await t.call('/admin/chat/send', { actor: 'boss', server: 'Empty', text: 'x' }))!.body.error).toBe('Nobody is on Empty right now');
    await t.poll('AUS Main');
    await t.call('/admin/chat/send', { actor: 'boss', server: 'AUS Main', text: 'lost' });
    t.tick(GIVE_UP_MS + 1);
    expect((await t.call('/admin/chat/send', { actor: 'boss', server: 'AUS Main', text: 'x' }))!.body.error).toBe("AUS Main isn't connected right now");
    const s = (await t.call('/admin/chat/state', { actor: 'boss' }))!.body;
    expect(s.messages.map((m: any) => m.status)).toEqual(['failed']);
    expect((await t.poll('AUS Main')).messages).toEqual([]);
  });

  it('empty or over-long text is refused, never cut; control characters are dropped', async () => {
    const t = await setup();
    await t.poll('AUS Main');
    for (const text of ['', '   ', undefined, 5, 'x'.repeat(TEXT_MAX + 1)]) expect((await t.call('/admin/chat/send', { actor: 'boss', server: 'AUS Main', text }))!.status).toBe(400);
    expect((await t.call('/admin/chat/send', { actor: 'boss', server: 'AUS Main', text: 'x'.repeat(TEXT_MAX) }))!.status).toBe(200);
    await t.call('/admin/chat/send', { actor: 'boss', server: 'AUS Main', text: 'a\u0000\nb<script>' });
    expect((await t.poll('AUS Main')).messages.at(-1).text).toBe('a b<script>');
  });

  it('limits how many an admin sends a minute', async () => {
    const t = await setup();
    await t.poll('AUS Main');
    for (let i = 0; i < SENDS_PER_MIN; i++) expect((await t.call('/admin/chat/send', { actor: 'boss', server: 'AUS Main', text: `m${i}` }))!.status).toBe(200);
    expect((await t.call('/admin/chat/send', { actor: 'boss', server: 'AUS Main', text: 'one more' }))!.status).toBe(429);
    expect((await t.call('/admin/chat/inbox', { actor: 'Boss', to: 'Ash', text: 'one more' }))!.status).toBe(429);
    expect((await t.poll('AUS Main')).messages).toHaveLength(SENDS_PER_MIN);
    t.tick(61_000);
    await t.poll('AUS Main', { ack: 999 });
    expect((await t.call('/admin/chat/send', { actor: 'boss', server: 'AUS Main', text: 'later' }))!.status).toBe(200);
  });
});

describe('admin chat: replies and the log', () => {
  it("a pilot's private reply is kept in the admin log, and the conversation reads oldest first", async () => {
    const t = await setup();
    await t.poll('AUS Main');
    await t.call('/admin/chat/send', { actor: 'boss', server: 'AUS Main', to: 'Ash', text: 'Hi Ash' });
    await t.call('/admin/chat/send', { actor: 'boss', server: 'AUS Main', text: 'Hello everyone' });
    await t.call('/admin/chat/send', { actor: 'boss', server: 'AUS Main', to: 'Guest_12', text: 'Hi guest' });
    t.tick(2000);
    await t.poll('AUS Main', { ack: 3, replies: [{ from: 'Ash', guest: false, to: 'boss', text: 'hello <b>back</b>', at: 5 }] });
    const all = (await t.call('/admin/chat/state', { actor: 'boss', server: 'AUS Main' }))!.body.messages;
    expect(all.map((m: any) => [m.direction, m.pilot, m.text, m.status])).toEqual([
      ['out', 'Ash', 'Hi Ash', 'sent'], ['out', '', 'Hello everyone', 'sent'], ['out', 'Guest_12', 'Hi guest', 'sent'], ['in', 'Ash', 'hello <b>back</b>', 'received'],
    ]);
    expect(all.at(-1)).toMatchObject({ admin: 'boss', server: 'AUS Main', at: t.now() });
    // (One pilot's conversation: theirs, and what was said to everyone there; not another pilot's)
    const withAsh = (await t.call('/admin/chat/state', { actor: 'boss', server: 'AUS Main', with: 'ASH' }))!.body.messages;
    expect(withAsh.map((m: any) => m.text)).toEqual(['Hi Ash', 'Hello everyone', 'hello <b>back</b>']);
  });

  it('junk replies are skipped: no sender, no admin name, no text; long text is cut', async () => {
    const t = await setup();
    await t.poll('AUS Main', { replies: [{ from: '', to: 'boss', text: 'x' }, { from: 'Ash', to: 'not a name!', text: 'x' }, { from: 'Ash', to: 'boss', text: '  ' }, null, 'x',
      { from: 'Ash', to: 'boss', text: 'y'.repeat(1000) }] });
    const rows = await t.store.list({ limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0].body.length).toBe(TEXT_MAX);
  });

  it('nothing of it reaches the activity feed: admins read private replies in the admin log only', async () => {
    const t = await setup();
    const activityStore = new JsonActivityStore(null);
    let out: any = null;
    let body: object = {};
    const activity = await ActivityRoutes.create(t.users, (_, status, b) => { out = { status, body: b }; }, async () => body, () => '10.0.0.9', { store: activityStore, adminSecret: SECRET, dataDir: tmp() });
    await t.poll('AUS Main');
    await t.call('/admin/chat/send', { actor: 'boss', server: 'AUS Main', to: 'Ash', text: 'a private word' });
    await t.poll('AUS Main', { ack: 1, replies: [{ from: 'Ash', guest: false, to: 'boss', text: 'a private answer', at: 5 }] });
    const boss = await t.users.login('boss', 'password1');
    if (!boss.success) throw new Error('login');
    body = { token: boss.token };
    await activity.handle({ method: 'POST', headers: {} } as unknown as http.IncomingMessage, { setHeader() {} } as unknown as http.ServerResponse, '/activity/read');
    expect(out.status).toBe(200);
    expect(JSON.stringify(out.body)).not.toMatch(/private word|private answer/);
    // (And the admin chat's own source never touches the feed's store or routes)
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'routes.ts'), 'utf8');
    expect(src).not.toMatch(/from '\.\.\/activity\//);
  });

  it('is kept across a restart, newest rows only', async () => {
    const file = join(tmp(), 'admin-messages.json');
    const store = new JsonAdminChatStore(file, 3);
    for (let i = 1; i <= 5; i++) await store.add({ at: i, server: 'S', direction: 'out', admin: 'boss', pilot: 'Ash', body: `m${i}`, status: 'sent' });
    await store.close();
    const again = new JsonAdminChatStore(file, 3);
    expect((await again.list({ limit: 10 })).map((m) => m.body)).toEqual(['m3', 'm4', 'm5']);
    expect((await again.add({ at: 6, server: 'S', direction: 'in', admin: 'boss', pilot: 'Ash', body: 'm6', status: 'received' })).id).toBe(6);
  });
});

describe('admin chat: a pilot who is offline', () => {
  it('the message can be left in their in-game inbox instead, and is logged as such', async () => {
    const t = await setup();
    const r = (await t.call('/admin/chat/inbox', { actor: 'boss', to: 'ash', text: 'Sorry I missed you' }))!;
    expect(r.body).toEqual({ success: true });
    const mail = await t.mail(t.ashToken);
    expect(mail).toHaveLength(1);
    expect(mail[0]).toMatchObject({ from: 'system', subject: 'A message from boss (admin)', body: 'Sorry I missed you', readAt: null });
    expect(await t.store.list({ limit: 10 })).toMatchObject([{ server: '', direction: 'out', admin: 'boss', pilot: 'Ash', body: 'Sorry I missed you', status: 'inbox' }]);
    // (It shows in that pilot's conversation on any server)
    expect((await t.call('/admin/chat/state', { actor: 'boss', server: 'AUS Main', with: 'Ash' }))!.body.messages).toHaveLength(1);
  });

  it('a guest, or a name with no account, has no inbox', async () => {
    const t = await setup();
    for (const to of ['Guest_12', 'nobody', '']) expect((await t.call('/admin/chat/inbox', { actor: 'boss', to, text: 'hi' }))!.status).toBe(404);
    expect((await t.call('/admin/chat/inbox', { actor: 'boss', to: 'Ash', text: '' }))!.status).toBe(400);
    expect(await t.store.list({ limit: 10 })).toEqual([]);
  });
});

describe('admin chat in Postgres', () => {
  it('the migration only adds: IF NOT EXISTS statements, the same ones schema.sql has', async () => {
    const queries: string[] = [];
    await PostgresAdminChatStore.create({ query: async (sql: string) => { queries.push(sql); return { rows: [] }; } });
    expect(queries).toEqual(ADMIN_MESSAGES_SCHEMA);
    for (const sql of ADMIN_MESSAGES_SCHEMA) { expect(sql).toMatch(/^CREATE (TABLE|INDEX) IF NOT EXISTS /); expect(sql).not.toContain(';'); }
    const squash = (s: string) => s.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').replace(/\s*([(),])\s*/g, '$1').trim();
    const schemaSql = squash(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../schema.sql'), 'utf8'));
    for (const sql of ADMIN_MESSAGES_SCHEMA) expect(schemaSql).toContain(squash(sql));
    await expect(PostgresAdminChatStore.create({ query: async () => { throw new Error('permission denied'); } })).rejects.toThrow(/schema\.sql/);
  });

  it('reads one conversation oldest first, with parameters, never text in the SQL', async () => {
    const queries: { sql: string; params: any[] }[] = [];
    const row = { id: '2', at: '9', server: 'S', direction: 'in', admin: 'boss', pilot: 'Ash', body: "o'hara; DROP", status: 'received' };
    const pool = { query: async (sql: string, params: any[] = []) => { queries.push({ sql, params }); return { rows: sql.startsWith('SELECT') ? [row, { ...row, id: '1' }] : sql.startsWith('INSERT') ? [row] : [] }; } };
    const store = await PostgresAdminChatStore.create(pool);
    expect((await store.list({ server: 'S', pilot: 'ASH', limit: 50 })).map((m) => m.id)).toEqual([1, 2]);
    const q = queries.at(-1)!;
    expect(q.params).toEqual(['S', 'ash', 50]);
    expect(q.sql).not.toContain('ash');
    await store.add({ at: 9, server: 'S', direction: 'in', admin: 'boss', pilot: 'Ash', body: "o'hara; DROP", status: 'received' });
    expect(queries.at(-1)!.sql).not.toContain('hara');
    await store.setStatus([1, 2], 'sent');
    expect(queries.at(-1)!.params).toEqual([[1, 2], 'sent']);
  });
});
