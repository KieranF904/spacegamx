import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type http from 'http';
import { JsonUserStore } from '../accounts/JsonUserStore.js';
import { AccountRoutes } from '../accounts/routes.js';
import { InboxRoutes, BODY_MAX, SUBJECT_MAX, IP_LIMIT, SEND_LIMIT, BROADCAST_LIMIT, cleanText } from './routes.js';
import { JsonMessageStore } from './JsonMessageStore.js';
import { MESSAGES_SCHEMA, PostgresMessageStore } from './PostgresMessageStore.js';

// (These count the dev admin the store seeds: only with DEV_AUTH=1, server-browser/src/accounts/devAuth.ts)
process.env.DEV_AUTH = '1';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'lobby-inbox-'));
  dirs.push(dir);
  return dir;
}

/** Accounts (admin "boss", pilots "alice" and "bob") and the inbox's routes, called like the lobby does */
async function setup(opts: { file?: string } = {}) {
  const users = new JsonUserStore(join(tmp(), 'users.json'));
  const reg = async (name: string) => {
    const r = await users.register(name, `${name}@example.com`, 'password1');
    if (!r.success) throw new Error(r.error);
    return r;
  };
  const boss = await reg('boss');
  await users.setAdmin(boss.user.id, true);
  const alice = await reg('alice');
  const bob = await reg('bob');
  const store = new JsonMessageStore(opts.file ?? null);
  let body: object = {};
  let ip = '10.0.0.1';
  let out: { status: number; body: any } = { status: 0, body: null };
  const inbox = await InboxRoutes.create(users, (_, status, b) => { out = { status, body: b }; }, async () => body, () => ip,
    { store, adminSecret: 'sssh', dataDir: tmp() });
  const call = async (url: string, b: object, o: { from?: string; auth?: string } = {}) => {
    body = b;
    ip = o.from ?? `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
    const req = { method: 'POST', headers: o.auth !== undefined ? { authorization: `Bearer ${o.auth}` } : {} } as unknown as http.IncomingMessage;
    out = { status: 0, body: null };
    const handled = await inbox.handle(req, {} as http.ServerResponse, url);
    return handled ? out : null;
  };
  return { users, store, inbox, call, boss: boss.token, alice: alice.token, bob: bob.token, aliceId: alice.user.id, bossId: boss.user.id };
}

describe('player inbox', () => {
  it('an admin sends to a player by username (any case); they list it newest first with an unread count, then mark it read', async () => {
    const t = await setup();
    expect((await t.call('/inbox/send', { token: t.boss, to: 'ALICE', subject: 'Hello', body: 'First' }))!.body).toEqual({ success: true, sent: 1, to: 'alice' });
    await new Promise((r) => setTimeout(r, 2));
    await t.call('/inbox/send', { token: t.boss, to: 'alice', subject: 'Again', body: 'Second', important: false });
    const list = (await t.call('/inbox/list', { token: t.alice }))!;
    expect(list.status).toBe(200);
    expect(list.body.unread).toBe(2);
    expect(list.body.unreadImportant).toBe(1);
    expect(list.body.messages.map((m: any) => m.subject)).toEqual(['Again', 'Hello']);
    expect(list.body.messages[1]).toMatchObject({ from: 'boss', body: 'First', important: true, readAt: null });

    const read = (await t.call('/inbox/read', { token: t.alice, id: list.body.messages[1].id }))!;
    expect(read.body).toEqual({ success: true, changed: 1, unread: 1, unreadImportant: 0 });
    const all = (await t.call('/inbox/read', { token: t.alice, all: true }))!;
    expect(all.body).toMatchObject({ changed: 1, unread: 0 });
    const after = (await t.call('/inbox/list', { token: t.alice }))!.body;
    expect(after.messages.every((m: any) => typeof m.readAt === 'number')).toBe(true);
  });

  it("a player can't read, mark or delete another player's mail", async () => {
    const t = await setup();
    await t.call('/inbox/send', { token: t.boss, to: 'alice', subject: 'Private', body: 'For alice only' });
    const id = (await t.call('/inbox/list', { token: t.alice }))!.body.messages[0].id;
    expect((await t.call('/inbox/list', { token: t.bob }))!.body).toMatchObject({ messages: [], unread: 0 });
    expect((await t.call('/inbox/read', { token: t.bob, id }))!.body).toMatchObject({ changed: 0 });
    expect((await t.call('/inbox/delete', { token: t.bob, id }))!.body).toMatchObject({ changed: 0 });
    expect((await t.call('/inbox/read', { token: t.bob, all: true }))!.body).toMatchObject({ changed: 0 });
    // Still unread and there for alice
    expect((await t.call('/inbox/list', { token: t.alice }))!.body).toMatchObject({ unread: 1, messages: [{ id, readAt: null }] });
  });

  it('needs a valid session; a non-admin can neither send nor see what was sent', async () => {
    const t = await setup();
    expect((await t.call('/inbox/list', {}))!.status).toBe(401);
    expect((await t.call('/inbox/list', { token: 'nope' }))!.status).toBe(401);
    const send = (await t.call('/inbox/send', { token: t.alice, to: 'bob', subject: 'Hi', body: 'Spoofed admin mail' }))!;
    expect(send).toEqual({ status: 403, body: { success: false, error: 'Only an admin can do that' } });
    expect((await t.call('/inbox/send', { token: t.alice, everyone: true, body: 'x' }))!.status).toBe(403);
    expect((await t.call('/inbox/sent', { token: t.alice }))!.status).toBe(403);
    expect((await t.call('/inbox/list', { token: t.bob }))!.body.messages).toEqual([]);
  });

  it('a banned player is refused', async () => {
    const t = await setup();
    await t.users.setBan(t.aliceId, Date.now() + 60_000, 'spam', 'boss');
    expect((await t.call('/inbox/list', { token: t.alice }))!.status).toBe(403);
  });

  it('sends to everyone: one copy per account; the sent list counts recipients and reads', async () => {
    const t = await setup();
    const r = (await t.call('/inbox/send', { token: t.boss, everyone: true, subject: 'Server restart', body: 'Tonight at 8' }))!;
    expect(r.body).toEqual({ success: true, sent: 4, to: '*' }); // (boss, alice, bob and the seeded dev admin)
    for (const tok of [t.alice, t.bob, t.boss]) expect((await t.call('/inbox/list', { token: tok }))!.body).toMatchObject({ unread: 1, unreadImportant: 1 });
    // "everyone" as a recipient name, when no account has it
    expect((await t.call('/inbox/send', { token: t.boss, to: 'everyone', body: 'Second' }))!.body).toMatchObject({ to: '*' });
    const id = (await t.call('/inbox/list', { token: t.alice }))!.body.messages.find((m: any) => m.subject === 'Server restart').id;
    await t.call('/inbox/read', { token: t.alice, id });
    const sent = (await t.call('/inbox/sent', { token: t.boss }))!.body.sent;
    expect(sent).toHaveLength(2);
    expect(sent.find((s: any) => s.subject === 'Server restart')).toMatchObject({ to: '*', from: 'boss', recipients: 4, read: 1 });
    expect(sent.find((s: any) => s.body === 'Second')).toMatchObject({ subject: 'A message from boss', read: 0 });
  });

  it('delete hides the message from its player (counted as read in the sent list)', async () => {
    const t = await setup();
    await t.call('/inbox/send', { token: t.boss, to: 'alice', subject: 'Bye', body: 'Delete me' });
    const id = (await t.call('/inbox/list', { token: t.alice }))!.body.messages[0].id;
    expect((await t.call('/inbox/delete', { token: t.alice, ids: [id, 'junk', -1] }))!.body).toEqual({ success: true, changed: 1, unread: 0, unreadImportant: 0 });
    expect((await t.call('/inbox/list', { token: t.alice }))!.body.messages).toEqual([]);
    expect((await t.call('/inbox/sent', { token: t.boss }))!.body.sent[0]).toMatchObject({ recipients: 1, read: 1 });
    expect((await t.call('/inbox/delete', { token: t.alice }))!.status).toBe(400);
  });

  it('refuses an unknown recipient, an empty message and an over-long subject or body; stores plain text as sent', async () => {
    const t = await setup();
    expect((await t.call('/inbox/send', { token: t.boss, to: 'nobody', body: 'x' }))!).toEqual({ status: 404, body: { success: false, error: 'No account "nobody"' } });
    expect((await t.call('/inbox/send', { token: t.boss, to: 'alice', body: '   ' }))!.status).toBe(400);
    expect((await t.call('/inbox/send', { token: t.boss, to: 'alice', body: 'x'.repeat(BODY_MAX + 1) }))!.status).toBe(400);
    expect((await t.call('/inbox/send', { token: t.boss, to: 'alice', subject: 's'.repeat(SUBJECT_MAX + 1), body: 'x' }))!.status).toBe(400);
    expect((await t.call('/inbox/send', { token: t.boss, to: 'alice', subject: 's'.repeat(SUBJECT_MAX), body: 'x'.repeat(BODY_MAX) }))!.status).toBe(200);
    const html = '<img src=x onerror=alert(1)> & "quotes"';
    await t.call('/inbox/send', { token: t.boss, to: 'alice', subject: `Sub\nject\u0007${html}`, body: `Line 1\r\nLine 2 ${html}\u0000` });
    const m = (await t.call('/inbox/list', { token: t.alice }))!.body.messages[0];
    expect(m.subject).toBe(`Sub ject${html}`);
    expect(m.body).toBe(`Line 1\nLine 2 ${html}`);
    expect(cleanText('a‮b', false)).toBe('ab');
  });

  it('limits inbox calls per address, and sends per admin (lower to everyone)', async () => {
    const t = await setup();
    for (let i = 0; i < IP_LIMIT; i++) expect((await t.call('/inbox/list', { token: t.alice }, { from: '10.9.9.9' }))!.status).toBe(200);
    expect((await t.call('/inbox/list', { token: t.alice }, { from: '10.9.9.9' }))!.status).toBe(429);
    expect((await t.call('/inbox/list', { token: t.alice }, { from: '10.9.9.8' }))!.status).toBe(200);

    for (let i = 0; i < BROADCAST_LIMIT; i++) expect((await t.call('/inbox/send', { token: t.boss, everyone: true, body: `b${i}` }))!.status).toBe(200);
    expect((await t.call('/inbox/send', { token: t.boss, everyone: true, body: 'one too many' }))!.status).toBe(429);
    for (let i = BROADCAST_LIMIT; i < SEND_LIMIT; i++) expect((await t.call('/inbox/send', { token: t.boss, to: 'bob', body: `m${i}` }))!.status).toBe(200);
    expect((await t.call('/inbox/send', { token: t.boss, to: 'bob', body: 'one too many' }))!.status).toBe(429);
  });

  it("the game servers' /admin/mail: the secret, an admin actor (or none: from system)", async () => {
    const t = await setup();
    expect((await t.call('/admin/mail', { actor: 'boss', to: 'alice', body: 'hi' }))!.status).toBe(403);
    expect((await t.call('/admin/mail', { actor: 'boss', to: 'alice', body: 'hi' }, { auth: 'wrong' }))!.status).toBe(403);
    expect((await t.call('/admin/mail', { actor: 'bob', to: 'alice', body: 'hi' }, { auth: 'sssh' }))!.status).toBe(403);
    expect((await t.call('/admin/mail', { actor: 'boss', to: 'alice', body: 'From chat' }, { auth: 'sssh' }))!.body).toEqual({ success: true, sent: 1, to: 'alice' });
    expect((await t.call('/admin/mail', { to: 'alice', body: 'Maintenance' }, { auth: 'sssh' }))!.status).toBe(200);
    const msgs = (await t.call('/inbox/list', { token: t.alice }))!.body.messages;
    expect(msgs.map((m: any) => [m.from, m.important])).toEqual(expect.arrayContaining([['boss', true], ['system', false]]));
    // Other routes aren't the inbox's
    expect(await t.call('/admin/users', {}, { auth: 'sssh' })).toBeNull();
    expect(await t.call('/auth/login', {})).toBeNull();
  });

  it('keeps the messages in a JSON file across restarts, and forgets a deleted account\'s mail', async () => {
    const file = join(tmp(), 'messages.json');
    const t = await setup({ file });
    await t.call('/inbox/send', { token: t.boss, to: 'alice', subject: 'Kept', body: 'Still here' });
    await t.store.close();
    const again = new JsonMessageStore(file);
    expect((await again.list(t.aliceId, 10)).messages[0]).toMatchObject({ subject: 'Kept', from_name: 'boss', read_at: null });
    await again.forgetUser(t.aliceId);
    expect((await again.list(t.aliceId, 10)).messages).toEqual([]);
    await again.close();
    expect(JSON.parse(readFileSync(file, 'utf8')).messages).toEqual([]);
  });

  it('a deleted account takes its mail with it (the accounts tell the inbox)', async () => {
    const t = await setup();
    const accounts = await AccountRoutes.create(() => {}, async () => ({ token: t.alice, password: 'password1' }), () => '10.1.1.1', { store: t.users, adminSecret: 'sssh' });
    accounts.onAccountDeleted = (id) => t.inbox.forgetUser(id);
    await t.call('/inbox/send', { token: t.boss, to: 'alice', body: 'x' });
    await accounts.handle({ method: 'POST', headers: {} } as unknown as http.IncomingMessage, {} as http.ServerResponse, '/auth/delete-account');
    await new Promise((r) => setTimeout(r, 0));
    expect((await t.store.list(t.aliceId, 10)).messages).toEqual([]);
  });
});

describe('PostgresMessageStore', () => {
  /** A pool that records its queries and answers from a script */
  function fakePool(answer: (sql: string, params: any[]) => any[] = () => []) {
    const queries: { sql: string; params: any[] }[] = [];
    return { queries, query: async (sql: string, params: any[] = []) => { queries.push({ sql, params }); return { rows: answer(sql, params) }; } };
  }

  it('makes its table at start, and scopes every read and change to the one player', async () => {
    const pool = fakePool((sql) => (sql.startsWith('SELECT COUNT') ? [{ unread: 2, important: 1 }] : sql.startsWith('SELECT id') ? [{ id: '7', user_id: '3', from_user_id: null, from_name: 'system', subject: 's', body: 'b', important: false, batch: 'x', sent_to: 'a', created_at: '5', read_at: null, archived_at: null }] : []));
    const store = await PostgresMessageStore.create(pool);
    expect(pool.queries.map((q) => q.sql)).toEqual(MESSAGES_SCHEMA);
    const page = await store.list(3, 10);
    expect(page).toMatchObject({ unread: 2, unreadImportant: 1, messages: [{ id: 7, user_id: 3, created_at: 5, read_at: null }] });
    await store.markRead(3, [7]);
    await store.markRead(3, 'all');
    await store.archive(3, [7]);
    for (const q of pool.queries.slice(MESSAGES_SCHEMA.length)) {
      expect(q.sql).toMatch(/WHERE user_id = \$1/);
      expect(q.params[0]).toBe(3);
    }
  });

  it('sends one row per distinct recipient in one statement', async () => {
    const pool = fakePool((sql, params) => (sql.startsWith('INSERT') ? params[0].map((id: number) => ({ id })) : []));
    const store = await PostgresMessageStore.create(pool);
    const r = await store.send([1, 2, 2, 3], { from_user_id: 1, from_name: 'boss', subject: 's', body: 'b', important: true, sent_to: '*' });
    expect(r.count).toBe(3);
    const insert = pool.queries.find((q) => q.sql.startsWith('INSERT'))!;
    expect(insert.params[0]).toEqual([1, 2, 3]);
    expect(insert.sql).toMatch(/unnest\(\$1::bigint\[\]\)/);
  });
});
