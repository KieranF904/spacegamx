import { describe, it, expect } from 'vitest';
import type { Ctx } from '../app.js';
import { Router } from '../http.js';
import { httpPlayerLobby, type Inbox, type MyDonations, type PlayerLobby } from '../playerLobby.js';
import { inboxPage, messagePage, myDonationsPage } from '../views/mine.js';
import type { PageCtx } from '../views/layout.js';
import { registerMine } from './mine.js';
import type { RouteEnv } from './env.js';

const page = { siteName: 'Space Game', user: { id: 7, username: 'alice', isAdmin: false }, csrf: 'csrf-tok', path: '/account/inbox', live: null, origin: 'http://x' } as PageCtx;

const DONATIONS: MyDonations = { currency: 'USD', total: 1250, contributorAt: 1000, donations: [
  { id: 3, amount: 400, currency: 'USD', status: 'PENDING', at: Date.UTC(2026, 10, 12), reference: null },
  { id: 2, amount: 750, currency: 'USD', status: 'COMPLETED', at: Date.UTC(2026, 10, 11), reference: 'CAP2' },
  { id: 1, amount: 500, currency: 'USD', status: 'COMPLETED', at: Date.UTC(2026, 10, 10), reference: 'CAP1' },
] };
const INBOX: Inbox = { unread: 1, messages: [
  { id: 12, from: 'system', subject: 'Thank you for supporting the game', body: 'Your donation of $7.50 came through.\n\nSecond <b>paragraph</b>', important: false, createdAt: Date.UTC(2026, 10, 11), readAt: null },
  { id: 9, from: 'boss', subject: 'Old <i>news</i>', body: 'Read already', important: true, createdAt: Date.UTC(2026, 10, 1), readAt: Date.UTC(2026, 10, 2) },
] };

/** The routes with a fake lobby that knows two sessions, called as the app's router would */
function setup() {
  const calls: string[] = [];
  const boxes: Record<string, Inbox> = { 'tok-alice': structuredClone(INBOX), 'tok-bob': { unread: 0, messages: [{ id: 50, from: 'boss', subject: "Bob's own", body: 'x', important: false, createdAt: 1, readAt: 2 }] } };
  const lobby: PlayerLobby = {
    donations: async (token, ip) => { calls.push(`donations ${token} ${ip}`); return token === 'tok-alice' ? DONATIONS : token === 'tok-bob' ? { currency: 'USD', total: 0, contributorAt: 1000, donations: [] } : null; },
    inbox: async (token) => { calls.push(`inbox ${token}`); return boxes[token] ?? null; },
    markRead: async (token, _ip, id) => { calls.push(`read ${token} ${id}`); return true; },
    remove: async (token, _ip, id) => { calls.push(`delete ${token} ${id}`); return true; },
  };
  const router = new Router<Ctx>();
  let out: { status: number; body: string; location?: string } = { status: 0, body: '' };
  const env = {
    router, cfg: { lobbyUrl: 'http://lobby' },
    page: (_ctx: Ctx, status: number, body: unknown) => { out = { status, body: String(body) }; },
    notFound: (_ctx: Ctx, what: string) => { out = { status: 404, body: `no ${what}` }; },
  } as unknown as RouteEnv;
  registerMine(env, lobby);
  const go = async (method: 'GET' | 'POST', path: string, token: string | null) => {
    out = { status: 0, body: '' };
    const res = { writeHead: (status: number, headers: Record<string, string>) => { out = { status, body: '', location: headers.Location ?? headers.location }; }, end: () => {}, setHeader: () => {} };
    const user = token === 'tok-alice' ? { id: 7, username: 'alice', isAdmin: false } : token === 'tok-bob' ? { id: 8, username: 'bob', isAdmin: false } : null;
    const ctx = { req: {}, res, path, ip: '9.9.9.9', token: user ? token : null, user, page: { ...page, user, path } } as unknown as Ctx;
    const m = router.match(method, path);
    if (!m || m === 'method') return { status: m === 'method' ? 405 : 404, body: '' } as typeof out;
    await m.handler(ctx, m.params);
    return out;
  };
  return { go, calls };
}

describe('account pages: routes', () => {
  it('signed out, every page goes to sign in and nothing is asked of the lobby', async () => {
    const t = setup();
    for (const [method, path] of [['GET', '/account/donations'], ['GET', '/account/inbox'], ['GET', '/account/inbox/12'], ['POST', '/account/inbox/read-all'], ['POST', '/account/inbox/12/delete']] as const) {
      const r = await t.go(method, path, null);
      expect(r.status, path).toBe(303);
      expect(r.location).toBe(`/signin?next=${encodeURIComponent(path)}`);
    }
    expect(t.calls).toEqual([]);
  });

  it("a pilot's donations are asked for with their own session and address, and shown", async () => {
    const t = setup();
    const r = await t.go('GET', '/account/donations', 'tok-alice');
    expect(r.status).toBe(200);
    expect(t.calls).toEqual(['donations tok-alice 9.9.9.9']);
    expect(r.body).toContain('$12.50');
    expect(r.body).toContain('$7.50');
    const bob = await t.go('GET', '/account/donations', 'tok-bob');
    expect(bob.body).toContain('No donations yet');
    expect(bob.body).not.toContain('$7.50');
  });

  it('the inbox lists their messages; opening an unread one marks it read, a read one does not', async () => {
    const t = setup();
    const list = await t.go('GET', '/account/inbox', 'tok-alice');
    expect(list.status).toBe(200);
    expect(list.body).toContain('Thank you for supporting the game');
    expect(list.body).toContain('href="/account/inbox/12"');
    const open = await t.go('GET', '/account/inbox/12', 'tok-alice');
    expect(open.status).toBe(200);
    expect(open.body).toContain('Your donation of $7.50 came through.');
    expect(t.calls).toContain('read tok-alice 12');
    t.calls.length = 0;
    await t.go('GET', '/account/inbox/9', 'tok-alice');
    expect(t.calls).toEqual(['inbox tok-alice']);
  });

  it("another pilot's message id, or a made-up one, is not found and nothing is marked", async () => {
    const t = setup();
    for (const path of ['/account/inbox/50', '/account/inbox/999', '/account/inbox/abc', '/account/inbox/-1', '/account/inbox/0']) {
      expect((await t.go('GET', path, 'tok-alice')).status, path).toBe(404);
    }
    expect(t.calls.filter((c) => c.startsWith('read'))).toEqual([]);
    expect((await t.go('GET', '/account/inbox/50', 'tok-bob')).status).toBe(200);
  });

  it('mark all read and delete act on the session\'s inbox and go back to it', async () => {
    const t = setup();
    expect(await t.go('POST', '/account/inbox/read-all', 'tok-alice')).toMatchObject({ status: 303, location: '/account/inbox' });
    expect(await t.go('POST', '/account/inbox/12/delete', 'tok-alice')).toMatchObject({ status: 303, location: '/account/inbox' });
    await t.go('POST', '/account/inbox/abc/delete', 'tok-alice');
    expect(t.calls).toEqual(['read tok-alice all', 'delete tok-alice 12']);
  });

  it('a lobby that is not answering gives a 503 page, not an error', async () => {
    const t = setup();
    const router = new Router<Ctx>();
    let status = 0;
    registerMine({ router, cfg: { lobbyUrl: 'http://lobby' }, page: (_c: Ctx, s: number) => { status = s; }, notFound: () => { status = 404; } } as unknown as RouteEnv,
      { donations: async () => null, inbox: async () => null, markRead: async () => false, remove: async () => false });
    const ctx = { res: {}, path: '/account/donations', ip: '', token: 't', user: { id: 1, username: 'a', isAdmin: false }, page } as unknown as Ctx;
    await (router.match('GET', '/account/donations') as any).handler(ctx, {});
    expect(status).toBe(503);
    await (router.match('GET', '/account/inbox') as any).handler(ctx, {});
    expect(status).toBe(503);
    expect(t.calls).toEqual([]);
  });
});

describe('account pages: views', () => {
  it('donations: total, a row each with date, amount and status, and a way to donate', () => {
    const p = String(myDonationsPage(page, DONATIONS));
    expect(p).toContain('$12.50');
    for (const s of ['$4.00', '$7.50', '$5.00', 'Pending', 'Completed', 'CAP2', '11 Nov 2026', 'href="/support.html"']) expect(p).toContain(s);
    expect(String(myDonationsPage(page, { currency: 'USD', total: 0, contributorAt: 1000, donations: [] }))).toContain('No donations yet');
    // (Where they stand with the contributor rank, from their total)
    expect(p).toContain('You have the contributor rank.');
    expect(String(myDonationsPage(page, { currency: 'USD', total: 0, contributorAt: 1000, donations: [] }))).toContain('Anybody who donates $10 USD or more in total receives the contributor rank.');
    expect(String(myDonationsPage(page, { ...DONATIONS, total: 250 }))).not.toContain('more to reach');
    expect(String(myDonationsPage(page, { ...DONATIONS, total: 1000 }))).toContain('You have the contributor rank.');
    expect(String(myDonationsPage(page, { ...DONATIONS, contributorAt: 0 }))).not.toContain('contributor rank');
    expect(String(myDonationsPage(page, null))).toContain('be read right now');
  });

  it('inbox: unread marked, text escaped, a mark-all form with the CSRF field only when something is unread', () => {
    const p = String(inboxPage(page, INBOX));
    expect(p).toContain('<strong>Thank you for supporting the game</strong>');
    expect((p.match(/data-unread/g) ?? []).length).toBe(1);
    expect(p).toContain('Inbox (1)');
    expect(p).toContain('The game');
    expect(p).not.toContain('<i>news</i>');
    expect(p).toContain('action="/account/inbox/read-all"');
    expect(p).toContain('value="csrf-tok"');
    const read = String(inboxPage(page, { unread: 0, messages: [INBOX.messages[1]] }));
    expect(read).not.toContain('read-all');
    expect(read).not.toContain('data-unread');
    expect(String(inboxPage(page, { unread: 0, messages: [] }))).toContain('No messages');
    expect(String(inboxPage(page, null))).toContain('be read right now');
  });

  it('a message: its paragraphs as plain text, with a delete form', () => {
    const p = String(messagePage(page, INBOX.messages[0]));
    expect(p).toContain('Your donation of $7.50 came through.');
    expect(p).not.toContain('<b>paragraph</b>');
    expect(p).toContain('&lt;b&gt;paragraph&lt;/b&gt;');
    expect(p).toContain('action="/account/inbox/12/delete"');
    expect(p).toContain('value="csrf-tok"');
  });
});

describe('account pages: the lobby calls', () => {
  function fake(answer: (path: string, body: any) => { status?: number; json: unknown } | Error) {
    const calls: { url: string; body: any; headers: Record<string, string> }[] = [];
    const f = async (url: string, init: { headers: Record<string, string>; body: string }) => {
      const body = JSON.parse(init.body);
      calls.push({ url, body, headers: init.headers });
      const a = answer(url.replace('http://lobby', ''), body);
      if (a instanceof Error) throw a;
      return { status: a.status ?? 200, json: async () => a.json };
    };
    return { api: httpPlayerLobby('http://lobby', f as any), calls };
  }

  it('each call sends only the session token (and the visitor\'s address), to the right place', async () => {
    const t = fake((path) => ({ json: path === '/donations/mine' ? { success: true, currency: 'USD', total: 500, contributorAt: 1000, donations: [{ id: 1, amount: 500, currency: 'USD', status: 'COMPLETED', at: 5, reference: 'CAP1', payer: 'x' }] }
      : path === '/inbox/list' ? { success: true, unread: 1, unreadImportant: 0, messages: [{ id: 3, from: 'system', subject: 's', body: 'b', important: false, createdAt: 4, readAt: null }] } : { success: true, changed: 1 } }));
    expect(await t.api.donations('tok', '1.2.3.4')).toEqual({ currency: 'USD', total: 500, contributorAt: 1000, donations: [{ id: 1, amount: 500, currency: 'USD', status: 'COMPLETED', at: 5, reference: 'CAP1' }] });
    expect(await t.api.inbox('tok', '1.2.3.4')).toEqual({ unread: 1, messages: [{ id: 3, from: 'system', subject: 's', body: 'b', important: false, createdAt: 4, readAt: null }] });
    expect(await t.api.markRead('tok', '1.2.3.4', 3)).toBe(true);
    expect(await t.api.markRead('tok', '1.2.3.4', 'all')).toBe(true);
    expect(await t.api.remove('tok', '1.2.3.4', 3)).toBe(true);
    expect(t.calls.map((c) => [c.url, c.body])).toEqual([
      ['http://lobby/donations/mine', { token: 'tok' }], ['http://lobby/inbox/list', { token: 'tok' }], ['http://lobby/inbox/read', { token: 'tok', id: 3 }],
      ['http://lobby/inbox/read', { token: 'tok', all: true }], ['http://lobby/inbox/delete', { token: 'tok', id: 3 }],
    ]);
    for (const c of t.calls) {
      expect(c.headers['X-Forwarded-For']).toBe('1.2.3.4');
      expect(c.headers).not.toHaveProperty('Authorization'); // (never the admin secret: the pilot's own session only)
    }
  });

  it('a refusal, nonsense or no answer reads as null or false, never a throw', async () => {
    for (const answer of [{ status: 401, json: { success: false } }, { json: { success: true } }, { json: 'nope' }, new Error('down')]) {
      const t = fake(() => answer as any);
      expect(await t.api.donations('tok', '')).toBeNull();
      expect(await t.api.inbox('tok', '')).toBeNull();
    }
    const down = fake(() => new Error('down'));
    expect(await down.api.markRead('tok', '', 1)).toBe(false);
    expect(await down.api.remove('tok', '', 1)).toBe(false);
  });
});
