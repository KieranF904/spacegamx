/**
 * The site's routes over real HTTP (port 0), with a fake lobby, fake pilot data,
 * and a JSON store in a temp folder.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'http';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import type { AdminUser, Lobby, LobbyUser } from './lobby.js';
import type { PilotSource } from './pilots.js';
import { JsonSiteStore } from './store/JsonSiteStore.js';
import { Uploads } from './uploads.js';
import { RateLimiter } from './security.js';

interface FakeUser { id: number; username: string; email: string; password: string; isAdmin: boolean; isOwner?: boolean }

/** (The account "admin" is the owner; the ranks' rules are the lobby's own, tested there: this records what it's asked) */
class FakeLobby implements Lobby {
  users: FakeUser[] = [{ id: 1, username: 'admin', email: 'a@x.io', password: 'admin', isAdmin: true, isOwner: true }];
  calls: unknown[][] = [];
  tokens = new Map<string, number>();
  private n = 0;
  private session(u: FakeUser) { const t = `tok${++this.n}`.padEnd(32, 'x'); this.tokens.set(t, u.id); return { ok: true as const, token: t, user: this.pub(u) }; }
  private pub(u: FakeUser): LobbyUser { return { id: u.id, username: u.username, isAdmin: u.isAdmin, isOwner: !!u.isOwner }; }
  private by(token: string) { const id = this.tokens.get(token); return this.users.find((u) => u.id === id) ?? null; }
  async login(username: string, password: string) {
    const u = this.users.find((x) => x.username.toLowerCase() === username.toLowerCase());
    return u && u.password === password ? this.session(u) : { ok: false as const, error: 'Invalid username or password', status: 401 };
  }
  async register(username: string, email: string, password: string) {
    if (this.users.some((u) => u.username.toLowerCase() === username.toLowerCase())) return { ok: false as const, error: 'Username already taken', status: 400 };
    const u = { id: Math.max(...this.users.map((x) => x.id)) + 1, username, email, password, isAdmin: false };
    this.users.push(u);
    return this.session(u);
  }
  async validate(token: string) { const u = this.by(token); return u ? this.pub(u) : null; }
  async logout(token: string) { this.tokens.delete(token); }
  async account(token: string) { const u = this.by(token); return u ? { ok: true as const, account: { ...this.pub(u), email: u.email, createdAt: '2026-10-01T00:00:00Z' } } : { ok: false as const, error: 'x', status: 401 }; }
  async changePassword(token: string, password: string, next: string) {
    const u = this.by(token);
    if (!u || u.password !== password) return { ok: false as const, error: 'That password is wrong', status: 401 };
    u.password = next;
    for (const [t, id] of this.tokens) if (id === u.id && t !== token) this.tokens.delete(t);
    return { ok: true as const };
  }
  async changeEmail(token: string, password: string, email: string) {
    const u = this.by(token);
    if (!u || u.password !== password) return { ok: false as const, error: 'That password is wrong', status: 401 };
    u.email = email; return { ok: true as const, email };
  }
  async logoutAll(token: string) { const u = this.by(token)!; let n = 0; for (const [t, id] of this.tokens) if (id === u.id) { this.tokens.delete(t); n++; } return { ok: true as const, ended: n }; }
  async deleteAccount(token: string, password: string) {
    const u = this.by(token);
    if (!u || u.password !== password) return { ok: false as const, error: 'That password is wrong', status: 401 };
    this.users = this.users.filter((x) => x !== u);
    return { ok: true as const, id: u.id };
  }
  private admin(u: FakeUser): AdminUser { return { id: u.id, username: u.username, isAdmin: u.isAdmin, isOwner: !!u.isOwner, createdAt: '', ban: null }; }
  async findUser(username: string) { const u = this.users.find((x) => x.username.toLowerCase() === username.toLowerCase()); return u ? this.admin(u) : null; }
  async listUsers() { return { ok: true as const, users: this.users.map((u) => this.admin(u)), total: this.users.length }; }
  async ban(username: string, ...rest: unknown[]) { this.calls.push(['ban', username, ...rest]); const u = this.users.find((x) => x.username === username)!; return { ok: true as const, user: this.admin(u) }; }
  async unban(username: string, actor?: string) { this.calls.push(['unban', username, actor]); const u = this.users.find((x) => x.username === username)!; return { ok: true as const, user: this.admin(u) }; }
  async setAdmin(username: string, on: boolean, actor: string) {
    this.calls.push(['setAdmin', username, on, actor]);
    const u = this.users.find((x) => x.username === username);
    if (!u) return { ok: false as const, error: `No account "${username}"`, status: 404 };
    u.isAdmin = on;
    return { ok: true as const, user: this.admin(u) };
  }
  async deleteUser(username: string, actor: string) {
    this.calls.push(['deleteUser', username, actor]);
    const u = this.users.find((x) => x.username === username);
    if (!u) return { ok: false as const, error: `No account "${username}"`, status: 404 };
    this.users = this.users.filter((x) => x !== u);
    return { ok: true as const, id: u.id };
  }
}

const pilots: PilotSource = {
  async card(id) { return id === 2 ? { level: 9, xp: 1, credits: 5, shipName: 'Stubborn', ships: 1, stats: { kills: 3, bosses: 1, quests: 0, mined: 0, earned: 0, crafted: 0, deaths: 0 }, systemsVisited: 2, ribbons: 0, ribbonIds: [], bossKills: {}, since: null, lastFlown: null } : null; },
  async rankings() { return { week: 1, weekly: {}, allTime: { kills: [{ userId: '2', name: 'vega', value: 3 }] } }; },
  async live() { return { players: 2, ships: 10, at: Date.now(), fresh: true }; },
};

let server: http.Server;
let base = '';
let dir = '';
const lobby = new FakeLobby();
let store: JsonSiteStore;

/** A browser: keeps cookies, knows the page's CSRF token */
class Browser {
  jar = new Map<string, string>();
  csrf = '';
  async req(path: string, init: RequestInit & { form?: Record<string, string>; json?: unknown } = {}) {
    const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
    headers.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    let body = init.body;
    if (init.form) { headers['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams({ _csrf: this.csrf, ...init.form }).toString(); }
    if (init.json !== undefined) { headers['content-type'] = 'application/json'; headers.accept = 'application/json'; headers['x-csrf-token'] ??= this.csrf; body = JSON.stringify(init.json); }
    const r = await fetch(base + path, { ...init, headers, body, redirect: 'manual' });
    for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const [k, v] = kv.split('='); if (/Max-Age=0/.test(c)) this.jar.delete(k); else this.jar.set(k, v); }
    const text = await r.text();
    const m = /<meta name="csrf-token" content="([^"]+)"/.exec(text);
    if (m) this.csrf = m[1];
    return { status: r.status, text, location: r.headers.get('location') ?? '', headers: r.headers };
  }
  async page(path: string) { return this.req(path); }
  async signin(name: string, pw: string) { await this.page('/signin'); return this.req('/signin', { method: 'POST', form: { username: name, password: pw, next: '/' } }); }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'site-'));
  store = new JsonSiteStore(join(dir, 'site.json'));
  const cfg = { ...loadConfig({ SITE_SECRET: 'test-secret', SITE_DATA_DIR: dir, GAME_MODE: 'link', GAME_URL: 'http://game.example' } as NodeJS.ProcessEnv) };
  const app = createApp({ cfg, store, lobby, pilots, uploads: new Uploads(dir), limiter: new RateLimiter() });
  server = http.createServer((q, s) => void app.handle(q, s));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  cfg.origin = base;
});
afterAll(async () => { server.close(); await store.close(); rmSync(dir, { recursive: true, force: true }); });

describe('site routes', () => {
  it('pages render with security headers; the session cookie is HttpOnly', async () => {
    const b = new Browser();
    const home = await b.page('/');
    expect(home.status).toBe(200);
    expect(home.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(home.headers.get('x-frame-options')).toBe('DENY');
    expect(home.text).toContain('2 pilots online');
    for (const p of ['/updates', '/guides', '/suggestions', '/pilots', '/signin', '/register', '/rss.xml']) expect((await b.page(p)).status, p).toBe(200);
    expect((await b.page('/nope')).status).toBe(404);
    const r = await b.signin('admin', 'admin');
    expect(r.status).toBe(303);
    expect(r.headers.getSetCookie().find((c) => c.startsWith('sg_session='))).toMatch(/HttpOnly; Max-Age=/);
  });

  it('guides: the list, one guide with its contents and neighbours, an unknown one is a 404', async () => {
    const b = new Browser();
    const list = await b.page('/guides');
    expect(list.status).toBe(200);
    expect(list.text).toContain('Getting started');
    expect(list.text).toContain('href="/guides/energy-and-ports"');
    const one = await b.page('/guides/energy-and-ports');
    expect(one.status).toBe(200);
    expect(one.text).toContain('<h2 id="banks">');
    expect(one.text).toContain('href="#banks"');
    expect(one.text).toContain('Previous');
    expect(one.text).not.toContain('TODO');
    expect((await b.page('/guides/nope')).status).toBe(404);
    expect((await b.page('/guides/..%2f..%2fREVIEW')).status).toBe(404);
  });

  it('register, comment (escaped), suggest, vote once, shout with limits', async () => {
    const admin = new Browser();
    await admin.signin('admin', 'admin');
    await admin.page('/admin/posts/new');
    const made = await admin.req('/admin/posts', { method: 'POST', form: { title: 'First light', body: 'Hello **pilots**', tags: 'news', status: 'published' } });
    expect(made.status).toBe(303);

    const v = new Browser();
    await v.page('/register');
    expect((await v.req('/register', { method: 'POST', form: { username: 'vega', email: 'v@x.io', password: 'pw', next: '/updates/first-light' } })).location).toBe('/updates/first-light?ok=registered');
    await v.page('/updates/first-light');
    const c = await v.req('/updates/first-light/comments', { method: 'POST', form: { body: 'nice <script>alert(1)</script>' } });
    expect(c.status).toBe(303);
    const post = await v.page('/updates/first-light');
    expect(post.text).toContain('nice &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(post.text).not.toContain('<script>alert(1)</script>');

    // Without the CSRF token, or from another site: refused
    const forged = await fetch(`${base}/updates/first-light/comments`, { method: 'POST', headers: { cookie: [...v.jar].map(([k, x]) => `${k}=${x}`).join('; '), 'content-type': 'application/x-www-form-urlencoded' }, body: 'body=forged', redirect: 'manual' });
    expect(forged.status).toBe(403);
    expect((await v.req('/shoutbox', { method: 'POST', json: { text: 'hi' }, headers: { origin: 'https://evil.example' } })).status).toBe(403);

    await v.page('/suggestions');
    expect((await v.req('/suggestions', { method: 'POST', form: { title: 'Name my ships', body: 'please' } })).status).toBe(303);
    const s = (await store.listSuggestions({ sort: 'top' }))[0];
    expect(s.votes).toBe(1); // you back your own

    const o = new Browser();
    await o.page('/register');
    await o.req('/register', { method: 'POST', form: { username: 'orrin', email: 'o@x.io', password: 'pw' } });
    await o.page('/suggestions');
    expect(JSON.parse((await o.req(`/suggestions/${s.id}/vote`, { method: 'POST', json: { on: true } })).text)).toEqual({ votes: 2, voted: true });
    expect(JSON.parse((await o.req(`/suggestions/${s.id}/vote`, { method: 'POST', json: { on: true } })).text).votes).toBe(2);
    expect(JSON.parse((await o.req(`/suggestions/${s.id}/vote`, { method: 'POST', json: { on: false } })).text).votes).toBe(1);
    // Anonymous: no
    expect((await new Browser().req(`/suggestions/${s.id}/vote`, { method: 'POST', json: { on: true } })).status).toBe(403);

    // Admin: status and reply; voting closes when declined
    await admin.page('/admin/suggestions');
    await admin.req(`/admin/suggestions/${s.id}`, { method: 'POST', form: { status: 'declined', reply: 'Not this time' } });
    expect((await store.getSuggestion(s.id))).toMatchObject({ status: 'declined', reply: 'Not this time', replyBy: 'admin' });
    expect((await o.req(`/suggestions/${s.id}/vote`, { method: 'POST', json: { on: true } })).status).toBe(409);

    // Shoutbox: length, rate limit, admin delete
    expect((await o.req('/shoutbox', { method: 'POST', json: { text: 'x'.repeat(281) } })).status).toBe(400);
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await o.req('/shoutbox', { method: 'POST', json: { text: `hello ${i}` } })).status);
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses).toContain(429);
    const last = (await store.recentShouts(10)).pop()!;
    expect((await o.req(`/shoutbox/${last.id}/delete`, { method: 'POST', json: {} })).status).toBe(404); // not an admin
    await admin.page('/');
    expect((await admin.req(`/shoutbox/${last.id}/delete`, { method: 'POST', json: {} })).status).toBe(200);
    expect((await store.recentShouts(10)).some((x) => x.id === last.id)).toBe(false);
  });

  it('admin pages are hidden from pilots and need sign-in', async () => {
    expect((await new Browser().page('/admin')).location).toBe('/signin?next=%2Fadmin');
    const p = new Browser();
    await p.signin('vega', 'pw');
    expect((await p.page('/admin')).status).toBe(404);
    expect((await p.page('/admin/tokens')).status).toBe(404);
  });

  it('API: tokens from the admin panel, upsert by slug, uploads, drafts hidden', async () => {
    const admin = new Browser();
    await admin.signin('admin', 'admin');
    await admin.page('/admin/tokens');
    const made = await admin.req('/admin/tokens', { method: 'POST', form: { name: 'cli' } });
    const token = /value="(sgs_[^"]+)"/.exec(made.text)![1];
    expect((await store.listTokens()).some((t) => t.hash === token)).toBe(false); // only a hash is kept

    const api = (path: string, init: RequestInit = {}) => fetch(base + path, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers as object) } });
    expect((await fetch(`${base}/api/v1/me`, { headers: { authorization: 'Bearer sgs_wrong' } })).status).toBe(401);
    expect(await (await api('/api/v1/me')).json()).toMatchObject({ name: 'admin (cli)', via: 'token' });

    const first = await api('/api/v1/posts', { method: 'POST', body: JSON.stringify({ title: 'From the terminal', body: 'v1', status: 'draft', tags: ['cli'] }) });
    expect(first.status).toBe(201);
    expect((await fetch(`${base}/updates/from-the-terminal`)).status).toBe(404); // a draft
    const again = await api('/api/v1/posts', { method: 'POST', body: JSON.stringify({ title: 'From the terminal', body: 'v2', status: 'published' }) });
    expect(again.status).toBe(200);
    expect((await again.json()).created).toBe(false);
    const page = await fetch(`${base}/updates/from-the-terminal`);
    expect(await page.text()).toContain('v2');
    expect((await api('/api/v1/posts/from-the-terminal', { method: 'PATCH', body: JSON.stringify({ status: 'draft' }) })).status).toBe(200);
    expect((await fetch(`${base}/updates/from-the-terminal`)).status).toBe(404);

    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
    const up = await api('/api/v1/uploads', { method: 'POST', body: png, headers: { 'content-type': 'image/png' } });
    const { url } = await up.json();
    expect(url).toMatch(/^\/uploads\/[a-f0-9]{24}\.png$/);
    const got = await fetch(base + url);
    expect(got.headers.get('content-type')).toBe('image/png');
    expect((await api('/api/v1/uploads', { method: 'POST', body: '<svg onload=alert(1)>', headers: { 'content-type': 'image/svg+xml' } })).status).toBe(400);

    // A token can't act as a browser session (no cookies, no pages)
    expect((await api('/api/v1/posts/from-the-terminal', { method: 'DELETE' })).status).toBe(200);
    await admin.page('/admin/tokens');
    const id = (await store.listTokens())[0].id;
    await admin.req(`/admin/tokens/${id}/revoke`, { method: 'POST', form: {} });
    expect((await api('/api/v1/me')).status).toBe(401);
  });

  it('account: change password and email, delete (with confirmation) unsigns content', async () => {
    const b = new Browser();
    await b.page('/register');
    await b.req('/register', { method: 'POST', form: { username: 'dusty', email: 'd@x.io', password: 'pw' } });
    await b.page('/account');
    expect((await b.req('/account/password', { method: 'POST', form: { password: 'pw', newPassword: 'a', repeat: 'b' } })).text).toContain('don&#39;t match');
    expect((await b.req('/account/password', { method: 'POST', form: { password: 'pw', newPassword: 'pw2', repeat: 'pw2' } })).location).toBe('/account?ok=password');
    expect((await b.req('/account/email', { method: 'POST', form: { password: 'pw2', email: 'new@x.io' } })).location).toBe('/account?ok=email');
    await b.page('/suggestions');
    await b.req('/suggestions', { method: 'POST', form: { title: 'Dusty idea here' } });
    expect((await b.req('/account/delete', { method: 'POST', form: { confirm: 'wrong', password: 'pw2' } })).text).toContain('Type your pilot name');
    expect((await b.req('/account/delete', { method: 'POST', form: { confirm: 'DUSTY', password: 'pw2' } })).location).toBe('/?ok=deleted');
    expect(b.jar.has('sg_session')).toBe(false);
    const s = (await store.listSuggestions({ sort: 'new' })).find((x) => x.title === 'Dusty idea here')!;
    expect([s.authorId, s.authorName, s.votes]).toEqual([null, 'a former pilot', 0]);
  });

  it('comments on an image: checked against the post, shown with a thumbnail and a count, hidden ones gone', async () => {
    const admin = new Browser();
    await admin.signin('admin', 'admin');
    await admin.page('/admin/posts/new');
    const body = 'Look:\n\n![The sun, old and new](/uploads/aaaa00.png)\n\n![The moon](/uploads/bbbb00.png)\n\n[![A linked one](/uploads/cccc00.png)](https://example.com/)';
    expect((await admin.req('/admin/posts', { method: 'POST', form: { title: 'Pictures', body, tags: 'news', status: 'published' } })).status).toBe(303);

    const v = new Browser();
    await v.page('/register');
    await v.req('/register', { method: 'POST', form: { username: 'pixel', email: 'p@x.io', password: 'pw', next: '/updates/pictures' } });
    const page = await v.page('/updates/pictures');
    expect(page.text).toContain('<span class="pic"><img src="/uploads/aaaa00.png"');
    expect(page.text).not.toContain('<span class="pic"><img src="/uploads/cccc00.png"'); // inside a link: left alone
    expect(page.text).toContain('data-image-form'); // the form the viewer shows
    expect(page.text).not.toContain('pic-count');

    // With the form (no script): stored on the image, and the post shows it
    expect((await v.req('/updates/pictures/comments', { method: 'POST', form: { body: 'Lovely sun', image: '/uploads/aaaa00.png' } })).status).toBe(303);
    const post = (await store.getPostBySlug('pictures'))!;
    let list = await store.listComments(post.id);
    expect(list.map((c) => [c.body, c.image])).toEqual([['Lovely sun', '/uploads/aaaa00.png']]);
    const shown = await v.page('/updates/pictures');
    expect(shown.text).toContain('data-image="/uploads/aaaa00.png"');
    expect(shown.text).toContain('class="c-thumb"');
    expect(shown.text).toContain('1 comment on this image');

    // An image that isn't in the post, or is inside a link: a comment on the post
    await v.req('/updates/pictures/comments', { method: 'POST', form: { body: 'Wrong one', image: '/uploads/zzzz00.png' } });
    await v.req('/updates/pictures/comments', { method: 'POST', form: { body: 'Linked one', image: '/uploads/cccc00.png' } });
    list = await store.listComments(post.id);
    expect(list.map((c) => [c.body, c.image])).toEqual([['Lovely sun', '/uploads/aaaa00.png'], ['Wrong one', null], ['Linked one', null]]);

    // With script: JSON back, with the list item; same limits (4 a minute) and the same sign-in rule
    const json = await v.req('/updates/pictures/comments', { method: 'POST', json: { body: 'Moon <b>too</b>', image: '/uploads/bbbb00.png' } });
    expect(json.status).toBe(200);
    const made = JSON.parse(json.text);
    expect(made.item).toContain(`id="c${made.id}"`);
    expect(made.item).toContain('data-image="/uploads/bbbb00.png"');
    expect(made.item).toContain('On the image: The moon');
    expect(made.item).not.toContain('<b>');
    const slow = await v.req('/updates/pictures/comments', { method: 'POST', json: { body: 'One too many', image: '/uploads/bbbb00.png' } });
    expect(slow.status).toBe(429);
    expect(JSON.parse(slow.text).error).toMatch(/too fast|going a bit fast/);
    expect((await new Browser().req('/updates/pictures/comments', { method: 'POST', json: { body: 'Hi' } })).status).toBe(403); // no session cookie, no token
    const anon = new Browser();
    await anon.page('/updates/pictures');
    expect((await anon.req('/updates/pictures/comments', { method: 'POST', json: { body: 'Hi', image: '/uploads/aaaa00.png' } })).status).toBe(401);
    expect((await anon.page('/updates/pictures')).text).toContain('to comment.'); // the viewer's form is the sign-in prompt

    // Moderation: hidden ones are not shown, the badge counts only what is
    await admin.page('/admin/comments');
    const adminList = await admin.page('/admin/comments');
    expect(adminList.text).toContain('class="mod-image"');
    expect(adminList.text).toContain('On an image: The sun, old and new');
    const sun = list[0];
    expect((await admin.req(`/admin/comments/${sun.id}/hide`, { method: 'POST', form: { back: '/admin/comments' } })).status).toBe(303);
    const after = await anon.page('/updates/pictures');
    expect(after.text).not.toContain('Lovely sun');
    expect(after.text.match(/class="pic-count"/g)).toHaveLength(1); // only the moon's
  });

  it("owner-only pages and actions refuse admins: tokens, publishing, admin rank, deleting accounts", async () => {
    lobby.users.push({ id: 900, username: 'mod', email: 'm@x.io', password: 'pw', isAdmin: true }, { id: 901, username: 'target', email: 't@x.io', password: 'pw', isAdmin: false });
    const mod = new Browser();
    await mod.signin('mod', 'pw');
    // Moderation stays theirs
    expect((await mod.page('/admin')).status).toBe(200);
    expect((await mod.page('/admin/comments')).status).toBe(200);
    const pilots = await mod.page('/admin/pilots');
    expect(pilots.status).toBe(200);
    expect(pilots.text).not.toContain('Make admin');
    expect(pilots.text).toContain('<span class="pill pill-admin">owner</span>');
    expect((await mod.req('/admin/pilots/ban', { method: 'POST', form: { username: 'target', days: '1', reason: 'spam' } })).status).toBe(303);
    expect(lobby.calls.at(-1)).toEqual(['ban', 'target', expect.any(Number), 'spam', 'mod', 'mod']);
    // The owner's: refused, saying so
    const tokens = await mod.page('/admin/tokens');
    expect(tokens.status).toBe(403);
    expect(tokens.text).toContain('Owner only');
    expect((await mod.page('/admin')).text).not.toContain('href="/admin/tokens"');
    expect((await mod.req('/admin/tokens', { method: 'POST', form: { name: 'sneaky' } })).status).toBe(403);
    expect((await store.listTokens()).some((t) => t.name === 'sneaky')).toBe(false);
    const live = await mod.req('/admin/posts', { method: 'POST', form: { title: 'Mod news', body: 'hi', tags: '', status: 'published' } });
    expect(live.status).toBe(403);
    expect(live.text).toContain('Only the owner can publish');
    const draft = await mod.req('/admin/posts', { method: 'POST', form: { title: 'Mod draft', body: 'hi', tags: '', status: 'draft' } });
    expect(draft.status).toBe(303);
    const id = Number(/\/admin\/posts\/(\d+)/.exec(draft.location)![1]);
    expect((await mod.req(`/admin/posts/${id}/publish`, { method: 'POST', form: {} })).status).toBe(403);
    expect((await store.getPost(id))?.status).toBe('draft');
    expect((await mod.req(`/admin/posts/${id}`, { method: 'POST', form: { title: 'Mod draft', body: 'hi', tags: '', status: 'published' } })).status).toBe(403);
    expect((await mod.req('/admin/pilots/admin', { method: 'POST', form: { username: 'target', on: '1' } })).status).toBe(403);
    expect((await mod.req('/admin/pilots/delete', { method: 'POST', form: { username: 'target' } })).status).toBe(403);
    expect(lobby.calls.some((c) => c[0] === 'setAdmin' || c[0] === 'deleteUser')).toBe(false);
    expect(lobby.users.find((u) => u.username === 'target')?.isAdmin).toBe(false);
    // The API, on a mod's lobby session: drafts yes, publishing no
    const session = await lobby.login('mod', 'pw');
    const api = (path: string, init: RequestInit = {}) => fetch(base + path, { ...init, headers: { authorization: `Bearer ${session.ok ? session.token : ''}`, 'content-type': 'application/json' } });
    expect((await api('/api/v1/posts', { method: 'POST', body: JSON.stringify({ title: 'Api mod', body: 'x', status: 'published' }) })).status).toBe(403);
    expect((await api('/api/v1/posts', { method: 'POST', body: JSON.stringify({ title: 'Api mod', body: 'x', status: 'draft' }) })).status).toBe(201);
    expect((await api('/api/v1/posts/api-mod', { method: 'PATCH', body: JSON.stringify({ status: 'published' }) })).status).toBe(403);
    expect((await store.getPostBySlug('api-mod'))?.status).toBe('draft');

    // The owner can do all of it
    const owner = new Browser();
    await owner.signin('admin', 'admin');
    expect((await owner.page('/admin/pilots')).text).toContain('Make admin');
    expect((await owner.req(`/admin/posts/${id}/publish`, { method: 'POST', form: {} })).status).toBe(303);
    expect((await store.getPost(id))?.status).toBe('published');
    expect((await owner.req('/admin/pilots/admin', { method: 'POST', form: { username: 'target', on: '1' } })).location).toContain('ok=promoted');
    expect(lobby.calls.at(-1)).toEqual(['setAdmin', 'target', true, 'admin']);
    expect((await owner.req('/admin/pilots/delete', { method: 'POST', form: { username: 'target' } })).location).toContain('ok=accountdeleted');
    expect(lobby.calls.at(-1)).toEqual(['deleteUser', 'target', 'admin']);
    expect(lobby.users.some((u) => u.username === 'target')).toBe(false);
    // And the account page says owner
    expect((await owner.page('/account')).text).toContain('<span class="gold">owner</span>');
  });

  it('pilot pages and Play (link mode redirects; no token in the URL)', async () => {
    const page = await new Browser().page('/pilots/vega');
    expect(page.text).toContain('Stubborn');
    expect((await new Browser().page('/pilots/<script>')).status).toBe(404);
    const play = await new Browser().page('/play');
    expect(play.status).toBe(302);
    expect(play.location).toBe('http://game.example');
  });
});
