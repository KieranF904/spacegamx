/**
 * The admin panel's Chat tab over real HTTP (port 0), with a fake lobby for accounts and a fake admin-chat lobby:
 * who may use it, what is sent on, and what the page shows.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'http';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createApp, type Ctx } from '../app.js';
import { loadConfig } from '../config.js';
import { httpAdminChat, type AdminChatApi, type ChatState, type SendResult } from '../adminChat.js';
import { Router } from '../http.js';
import type { Lobby, LobbyUser } from '../lobby.js';
import type { PilotSource } from '../pilots.js';
import { JsonSiteStore } from '../store/JsonSiteStore.js';
import { Uploads } from '../uploads.js';
import { RateLimiter } from '../security.js';
import { adminChatPage, chatLog, onlineList, pickServer } from '../views/adminChat.js';
import type { PageCtx } from '../views/layout.js';
import { registerAdminChat, CHAT_SEND_RULE } from './adminChat.js';
import type { RouteEnv } from './env.js';

const STATE: ChatState = {
  servers: [{ name: 'AUS Main', fresh: true, online: [{ name: 'Ash', guest: false, since: Date.UTC(2026, 10, 12, 9) }, { name: 'Guest_<b>12', guest: true, since: Date.UTC(2026, 10, 12, 10) }] }, { name: 'EU West', fresh: false, online: [] }],
  messages: [
    { id: 1, at: Date.UTC(2026, 10, 12, 10, 1), server: 'AUS Main', direction: 'out', admin: 'boss', pilot: 'Ash', text: 'Hi Ash', status: 'sent' },
    { id: 2, at: Date.UTC(2026, 10, 12, 10, 2), server: 'AUS Main', direction: 'in', admin: 'boss', pilot: 'Ash', text: 'hello <script>alert(1)</script>', status: 'received' },
    { id: 3, at: Date.UTC(2026, 10, 12, 10, 3), server: 'AUS Main', direction: 'out', admin: 'boss', pilot: '', text: 'Restart soon', status: 'queued' },
    { id: 4, at: Date.UTC(2026, 10, 12, 10, 4), server: 'AUS Main', direction: 'out', admin: 'boss', pilot: 'Gone', text: 'still there?', status: 'failed' },
  ],
};

/** The site's two fakes: accounts (an admin "boss", a pilot "vega") and the admin-chat lobby, which records what it is asked */
class Fakes implements AdminChatApi {
  users = [{ id: 1, username: 'boss', isAdmin: true }, { id: 2, username: 'vega', isAdmin: false }];
  tokens = new Map<string, number>();
  calls: unknown[][] = [];
  next: SendResult = { ok: true };
  down = false;
  private pub(u: { id: number; username: string; isAdmin: boolean }): LobbyUser { return { id: u.id, username: u.username, isAdmin: u.isAdmin, isOwner: false }; }
  lobby = {
    login: async (username: string) => { const u = this.users.find((x) => x.username === username)!; const t = `tok-${u.username}`.padEnd(32, 'x'); this.tokens.set(t, u.id); return { ok: true as const, token: t, user: this.pub(u) }; },
    validate: async (token: string) => { const u = this.users.find((x) => x.id === this.tokens.get(token)); return u ? this.pub(u) : null; },
    logout: async () => {},
    newsletterCounts: async () => null,
  } as unknown as Lobby;
  async state(actor: string, q: { server?: string; with?: string }) { this.calls.push(['state', actor, q.server ?? '', q.with ?? '']); return this.down ? null : STATE; }
  async send(actor: string, server: string, to: string, text: string) { this.calls.push(['send', actor, server, to, text]); return this.next; }
  async inbox(actor: string, to: string, text: string) { this.calls.push(['inbox', actor, to, text]); return this.next; }
}

const pilots: PilotSource = { async card() { return null; }, async rankings() { return { week: 1, weekly: {}, allTime: {} }; }, async live() { return null; } };

let server: http.Server;
let base = '';
let dir = '';
let store: JsonSiteStore;
const fakes = new Fakes();
let skew = 0;

class Browser {
  jar = new Map<string, string>();
  csrf = '';
  async req(path: string, init: { method?: string; form?: Record<string, string>; noCsrf?: boolean; json?: boolean } = {}) {
    const headers: Record<string, string> = { cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ') };
    if (init.json) headers.accept = 'application/json';
    let body: string | undefined;
    if (init.form) { headers['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams({ ...(init.noCsrf ? {} : { _csrf: this.csrf }), ...init.form }).toString(); }
    const r = await fetch(base + path, { method: init.method, headers, body, redirect: 'manual' });
    for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const [k, v] = kv.split('='); if (/Max-Age=0/.test(c)) this.jar.delete(k); else this.jar.set(k, v); }
    const text = await r.text();
    const m = /<meta name="csrf-token" content="([^"]+)"/.exec(text);
    if (m) this.csrf = m[1];
    return { status: r.status, text, location: r.headers.get('location') ?? '' };
  }
  page(path: string) { return this.req(path); }
  post(path: string, form: Record<string, string>, json = false) { return this.req(path, { method: 'POST', form, json }); }
  async signin(name: string) { await this.page('/signin'); skew += 3_600_000; await this.post('/signin', { username: name, password: 'pw', next: '/' }); await this.page('/'); return this; }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'site-chat-'));
  store = new JsonSiteStore(join(dir, 'site.json'));
  const cfg = { ...loadConfig({ SITE_SECRET: 'test-secret', SITE_DATA_DIR: dir, GAME_MODE: 'link', GAME_URL: 'http://game.example', LOBBY_ADMIN_SECRET: 'sssh' } as NodeJS.ProcessEnv) };
  const app = createApp({ cfg, store, lobby: fakes.lobby, pilots, uploads: new Uploads(dir), limiter: new RateLimiter(() => Date.now() + skew), adminChat: fakes });
  server = http.createServer((q, s) => void app.handle(q, s));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  cfg.origin = base;
});
afterAll(async () => { server.close(); await store.close(); rmSync(dir, { recursive: true, force: true }); });

describe('admin chat on the website: who may use it', () => {
  it('signed out goes to sign in; a pilot gets "not found"; nothing is asked of the lobby', async () => {
    const out = new Browser();
    expect((await out.page('/admin/chat')).location).toBe('/signin?next=%2Fadmin%2Fchat');
    const pilot = await new Browser().signin('vega');
    for (const path of ['/admin/chat', '/admin/chat/feed?server=AUS%20Main']) expect((await pilot.page(path)).status, path).toBe(404);
    for (const path of ['/admin/chat/send', '/admin/chat/inbox']) {
      expect((await pilot.post(path, { server: 'AUS Main', with: 'Ash', text: 'hi' })).status, path).toBe(404);
      expect((await pilot.post(path, { server: 'AUS Main', with: 'Ash', text: 'hi' }, true)).status, path).toBe(404);
    }
    expect(fakes.calls).toEqual([]);
  });

  it('a post without the CSRF token is refused, even from an admin', async () => {
    const admin = await new Browser().signin('boss');
    for (const path of ['/admin/chat/send', '/admin/chat/inbox']) {
      expect((await admin.req(path, { method: 'POST', form: { server: 'AUS Main', with: 'Ash', text: 'hi' }, noCsrf: true })).status).toBe(403);
    }
    expect(fakes.calls.filter((c) => c[0] !== 'state')).toEqual([]);
  });
});

describe('admin chat on the website: the page', () => {
  it('shows who is on, guests marked, each a link to their conversation, with names and messages escaped', async () => {
    const admin = await new Browser().signin('boss');
    fakes.calls.length = 0;
    const r = await admin.page('/admin/chat');
    expect(r.status).toBe(200);
    expect(fakes.calls[0]).toEqual(['state', 'boss', '', '']);
    expect(r.text).toContain('2 on AUS Main');
    expect(r.text).toContain('href="/admin/chat?server=AUS%20Main&amp;with=Ash"');
    expect(r.text).toContain('guest · on since');
    expect(r.text).toContain('Guest_&lt;b&gt;12');
    expect(r.text).not.toContain('Guest_<b>12');
    expect(r.text).toContain('hello &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(r.text).not.toContain('<script>alert(1)</script>');
    expect(r.text).toContain('data-feed="/admin/chat/feed?server=AUS%20Main"');
    expect(r.text).toMatch(/<form method="post" action="\/admin\/chat\/send"[^>]*>\s*<input type="hidden" name="_csrf" value="[^"]+">/);
    // (The Chat tab is in the admin nav, and the Activity page links to it)
    expect(r.text).toContain('<a href="/admin/chat" aria-current="page">Chat</a>');
  });

  it("a pilot's conversation: the private note, their lines, and for one who is not on, the inbox offer instead of a live box", async () => {
    const admin = await new Browser().signin('boss');
    const on = (await admin.page('/admin/chat?server=AUS%20Main&with=Ash')).text;
    expect(on).toContain('A private message: only they see it.');
    expect(on).toContain('placeholder="Message Ash"');
    expect(on).not.toContain('is not online');
    const off = (await admin.page('/admin/chat?server=AUS%20Main&with=Gone')).text;
    expect(off).toContain('<b>Gone</b> is not online on AUS Main.');
    expect(off).toContain('action="/admin/chat/inbox"');
    expect(off).toMatch(/id="chat-text"[^>]* disabled/);
  });

  it('the feed gives the two fragments as HTML for the refresh, uncached', async () => {
    const admin = await new Browser().signin('boss');
    const r = await admin.page('/admin/chat/feed?server=AUS%20Main&with=Ash');
    expect(r.status).toBe(200);
    const d = JSON.parse(r.text);
    expect(Object.keys(d).sort()).toEqual(['log', 'online']);
    expect(d.online).toContain('2 on AUS Main');
    expect(d.log).toContain('Hi Ash');
    expect(d.log).not.toContain('<script>');
  });

  it('a lobby that is not answering gives a 503 page and feed, not an error', async () => {
    const admin = await new Browser().signin('boss');
    fakes.down = true;
    try {
      const page = await admin.page('/admin/chat');
      expect(page.status).toBe(503);
      expect(page.text).toContain("The lobby isn't answering");
      expect((await admin.page('/admin/chat/feed')).status).toBe(503);
    } finally { fakes.down = false; }
  });
});

describe('admin chat on the website: sending', () => {
  it("to everyone or to one pilot, as the signed-in admin: the name comes from the session, never the form", async () => {
    const admin = await new Browser().signin('boss');
    fakes.calls.length = 0;
    const all = await admin.post('/admin/chat/send', { server: 'AUS Main', with: '', text: '  Restart soon  ', actor: 'someoneelse', username: 'vega' });
    expect(all).toMatchObject({ status: 303, location: '/admin/chat?server=AUS%20Main' });
    const one = await admin.post('/admin/chat/send', { server: 'AUS Main', with: 'Ash', text: 'Hi Ash' }, true);
    expect(one.status).toBe(200);
    expect(JSON.parse(one.text)).toEqual({ ok: true });
    expect(fakes.calls).toEqual([['send', 'boss', 'AUS Main', '', 'Restart soon'], ['send', 'boss', 'AUS Main', 'Ash', 'Hi Ash']]);
  });

  it('a pilot who is not online: the page says so, and the message can go to their inbox instead', async () => {
    const admin = await new Browser().signin('boss');
    fakes.calls.length = 0;
    fakes.next = { ok: false, error: 'Gone is not online on AUS Main', offline: true, status: 409 };
    try {
      const js = await admin.post('/admin/chat/send', { server: 'AUS Main', with: 'Gone', text: 'hello?' }, true);
      expect(js.status).toBe(400);
      expect(JSON.parse(js.text)).toEqual({ ok: false, error: 'Gone is not online on AUS Main', offline: true });
      const plain = await admin.post('/admin/chat/send', { server: 'AUS Main', with: 'Gone', text: 'hello?' });
      expect(plain.location).toBe('/admin/chat?server=AUS%20Main&with=Gone&why=offline');
      expect((await admin.page(plain.location)).text).toContain('They are not online, so it was not sent.');
    } finally { fakes.next = { ok: true }; }
    await admin.post('/admin/chat/inbox', { server: 'AUS Main', with: 'Gone', text: 'Sorry I missed you' });
    expect(fakes.calls.at(-1)).toEqual(['inbox', 'boss', 'Gone', 'Sorry I missed you']);
  });

  it('empty or over-long text never reaches the lobby', async () => {
    const admin = await new Browser().signin('boss');
    fakes.calls.length = 0;
    expect((await admin.post('/admin/chat/send', { server: 'AUS Main', with: '', text: '   ' })).location).toContain('why=empty');
    expect((await admin.post('/admin/chat/send', { server: 'AUS Main', with: '', text: 'x'.repeat(301) }, true)).status).toBe(400);
    expect(fakes.calls).toEqual([]);
  });

  it('only fixed lines are shown after a redirect: nothing from the address', async () => {
    const admin = await new Browser().signin('boss');
    const r = await admin.page('/admin/chat?server=AUS%20Main&why=%3Cscript%3Ex');
    expect(r.text).not.toContain('<script>x');
    expect(r.text).toMatch(/data-chat-error hidden/);
  });

  it('limits how many an admin sends a minute', async () => {
    const admin = await new Browser().signin('boss');
    skew += 3_600_000;
    fakes.calls.length = 0;
    let last = { status: 0, text: '' };
    for (let i = 0; i <= CHAT_SEND_RULE.limit; i++) last = await admin.post('/admin/chat/send', { server: 'AUS Main', with: '', text: `m${i}` }, true);
    expect(last.status).toBe(429);
    expect(JSON.parse(last.text).error).toContain('Too many messages');
    expect(fakes.calls.filter((c) => c[0] === 'send')).toHaveLength(CHAT_SEND_RULE.limit);
  });
});

describe('admin chat: views and the lobby calls', () => {
  const ctx = { siteName: 'Space Game', user: { id: 1, username: 'boss', isAdmin: true }, csrf: 'csrf-tok', path: '/admin/chat', live: null, origin: 'http://x' } as PageCtx;

  it('picks the server asked for if it is known, else the first connected one', () => {
    expect(pickServer(STATE, 'EU West')).toBe('EU West');
    expect(pickServer(STATE, 'Nowhere')).toBe('AUS Main');
    expect(pickServer(STATE, '')).toBe('AUS Main');
    expect(pickServer({ servers: [], messages: [] }, 'x')).toBe('');
    expect(pickServer(null, 'x')).toBe('');
  });

  it('the log reads oldest first and marks what is still sending or was not delivered', () => {
    const log = String(chatLog(STATE.messages, ''));
    expect(log.indexOf('Hi Ash')).toBeLessThan(log.indexOf('still there?'));
    expect(log).toContain('to everyone');
    expect(log).toContain('sending');
    expect(log).toContain('not delivered: they had left');
    expect(log).toContain('class="chat-line chat-in"');
    expect(String(chatLog([], 'Ash'))).toContain('Nothing said with Ash yet.');
  });

  it('a server that is not connected shows no roster and no way to send', () => {
    expect(String(onlineList(STATE.servers, 'EU West', ''))).toContain("EU West isn't connected right now.");
    expect(String(onlineList([], '', ''))).toContain('No game server is connected right now.');
    const page = String(adminChatPage(ctx, { state: STATE, server: 'EU West', pilot: '' }));
    expect(page).toMatch(/id="chat-text"[^>]* disabled/);
    expect(page).toContain('name="_csrf" value="csrf-tok"');
  });

  it("the site's calls carry the admin secret and the admin's name, and read the answers defensively", async () => {
    const seen: { url: string; auth: string; body: any }[] = [];
    let answer: { status: number; json: unknown } | Error = { status: 200, json: { success: true, servers: [{ name: 'S', fresh: true, online: [{ name: 'Ash', guest: true, since: 5 }, { nope: 1 }] }, 'junk'], messages: [{ id: 1, at: 2, server: 'S', direction: 'in', admin: 'boss', pilot: 'Ash', text: 'hi', status: 'received', extra: 'x' }, null] } };
    const f = async (url: string, init: { headers: Record<string, string>; body: string }) => { seen.push({ url, auth: init.headers.Authorization, body: JSON.parse(init.body) }); if (answer instanceof Error) throw answer; const a = answer; return { status: a.status, json: async () => a.json }; };
    const api = httpAdminChat('http://lobby', 'sssh', f as any);
    expect(await api.state('boss', { server: 'S', with: 'Ash' })).toEqual({ servers: [{ name: 'S', fresh: true, online: [{ name: 'Ash', guest: true, since: 5 }] }], messages: [{ id: 1, at: 2, server: 'S', direction: 'in', admin: 'boss', pilot: 'Ash', text: 'hi', status: 'received' }] });
    expect(seen[0]).toEqual({ url: 'http://lobby/admin/chat/state', auth: 'Bearer sssh', body: { actor: 'boss', server: 'S', with: 'Ash' } });
    answer = { status: 200, json: { success: true, id: 4 } };
    expect(await api.send('boss', 'S', '', 'hello')).toEqual({ ok: true });
    expect(seen.at(-1)!.body).toEqual({ actor: 'boss', server: 'S', text: 'hello' });
    expect(await api.inbox('boss', 'Ash', 'later')).toEqual({ ok: true });
    expect(seen.at(-1)).toMatchObject({ url: 'http://lobby/admin/chat/inbox', body: { actor: 'boss', to: 'Ash', text: 'later' } });
    answer = { status: 409, json: { success: false, offline: true, error: 'Ash is not online on S' } };
    expect(await api.send('boss', 'S', 'Ash', 'x')).toEqual({ ok: false, error: 'Ash is not online on S', offline: true, status: 409 });
    for (const bad of [new Error('down'), { status: 200, json: 'nonsense' }, { status: 403, json: { success: false } }]) {
      answer = bad as any;
      expect(await api.state('boss', {})).toBeNull();
      expect((await api.send('boss', 'S', '', 'x')).ok).toBe(false);
    }
    // (With no secret set nothing is asked at all)
    const before = seen.length;
    const off = httpAdminChat('http://lobby', '', f as any);
    expect(await off.state('boss', {})).toBeNull();
    expect((await off.send('boss', 'S', '', 'x')).ok).toBe(false);
    expect(seen.length).toBe(before);
  });

  it('the secret is never in anything sent to a browser', () => {
    const page = String(adminChatPage(ctx, { state: STATE, server: 'AUS Main', pilot: 'Ash' }));
    expect(page).not.toContain('sssh');
    const here = dirname(fileURLToPath(import.meta.url));
    for (const file of ['../views/adminChat.ts', '../../public/site.js']) expect(readFileSync(join(here, file), 'utf8')).not.toMatch(/adminSecret|LOBBY_ADMIN_SECRET|Bearer/);
  });

  it('the routes are the four and nothing else', () => {
    const router = new Router<Ctx>();
    registerAdminChat({ router, cfg: { lobbyUrl: 'http://lobby', lobbyAdminSecret: '' } } as unknown as RouteEnv, fakes);
    expect(router.match('GET', '/admin/chat')).not.toBeNull();
    expect(router.match('GET', '/admin/chat/feed')).not.toBeNull();
    expect(router.match('GET', '/admin/chat/send')).toBe('method');
    expect(router.match('POST', '/admin/chat/poll')).toBeNull();
  });
});
