/**
 * The email newsletter's consent on the website, over real HTTP (port 0) with a fake lobby: the sign-up form's choice,
 * the one-time question for accounts that were never asked, and the account page's setting.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'http';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import type { Lobby, LobbyUser } from './lobby.js';
import { HttpLobby } from './lobby.js';
import type { PilotSource } from './pilots.js';
import { JsonSiteStore } from './store/JsonSiteStore.js';
import { Uploads } from './uploads.js';
import { RateLimiter } from './security.js';
import { safeBack } from './routes/newsletter.js';
import { NEWSLETTER_MISSING, NEWSLETTER_NO, NEWSLETTER_QUESTION, NEWSLETTER_YES, newsletterChoice, newsletterCountsLine, newsletterPrompt, newsletterSetting, readChoice } from './views/newsletter.js';
import type { PageCtx } from './views/layout.js';

interface FakeUser { id: number; username: string; email: string; password: string; newsletter: boolean; asked: boolean; via: string | null }

/** The lobby's accounts and newsletter answers, as far as the site uses them; `calls` is what it was asked to change */
class FakeLobby {
  users: FakeUser[] = [];
  tokens = new Map<string, number>();
  calls: unknown[][] = [];
  failSet = false;
  private n = 0;
  /** An account from before anyone was asked */
  old(username: string): FakeUser {
    const u: FakeUser = { id: this.users.length + 1, username, email: `${username}@x.io`, password: 'pw', newsletter: false, asked: false, via: null };
    this.users.push(u);
    return u;
  }
  private pub(u: FakeUser): LobbyUser { return { id: u.id, username: u.username, isAdmin: false, isOwner: false, newsletterAsked: u.asked }; }
  private session(u: FakeUser) { const t = `tok${++this.n}`.padEnd(32, 'x'); this.tokens.set(t, u.id); return { ok: true as const, token: t, user: this.pub(u) }; }
  private by(token: string) { return this.users.find((u) => u.id === this.tokens.get(token)) ?? null; }
  async login(username: string, password: string) {
    const u = this.users.find((x) => x.username === username);
    return u && u.password === password ? this.session(u) : { ok: false as const, error: 'Invalid username or password', status: 401 };
  }
  async register(username: string, email: string, password: string, _ip: string, newsletter?: boolean) {
    this.calls.push(['register', username, newsletter]);
    if (this.users.some((u) => u.username === username)) return { ok: false as const, error: 'Username already taken', status: 400 };
    const u = this.old(username);
    Object.assign(u, { email, password });
    if (typeof newsletter === 'boolean') Object.assign(u, { newsletter, asked: true, via: 'signup' });
    return this.session(u);
  }
  async validate(token: string) { const u = this.by(token); return u ? this.pub(u) : null; }
  async logout(token: string) { this.tokens.delete(token); }
  async account(token: string) {
    const u = this.by(token);
    return u ? { ok: true as const, account: { ...this.pub(u), email: u.email, createdAt: '2026-10-01T00:00:00Z', newsletter: u.newsletter } } : { ok: false as const, error: 'x', status: 401 };
  }
  async setNewsletter(token: string, newsletter: boolean, via: 'prompt' | 'settings', ip: string) {
    const u = this.by(token);
    this.calls.push(['setNewsletter', u?.username ?? null, newsletter, via, ip]);
    if (!u || this.failSet) return { ok: false as const, error: 'x', status: u ? 500 : 401 };
    Object.assign(u, { newsletter, asked: true, via });
    return { ok: true as const };
  }
  async newsletterCounts() {
    const yes = this.users.filter((u) => u.newsletter).length, no = this.users.filter((u) => u.asked && !u.newsletter).length;
    return { accounts: this.users.length, consented: yes, declined: no, notAsked: this.users.length - yes - no };
  }
}

const pilots: PilotSource = { async card() { return null; }, async rankings() { return { week: 1, weekly: {}, allTime: {} }; }, async live() { return null; } };

let server: http.Server;
let base = '';
let dir = '';
let store: JsonSiteStore;
const lobby = new FakeLobby();
/** (Each sign-up from a different time, so the site's own sign-up limit never bites) */
let skew = 0;

/** A browser: keeps cookies, knows the page's CSRF token */
class Browser {
  jar = new Map<string, string>();
  csrf = '';
  async req(path: string, init: { method?: string; form?: Record<string, string>; noCsrf?: boolean } = {}) {
    const headers: Record<string, string> = { cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ') };
    let body: string | undefined;
    if (init.form) { headers['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams({ ...(init.noCsrf ? {} : { _csrf: this.csrf }), ...init.form }).toString(); }
    const r = await fetch(base + path, { method: init.method, headers, body, redirect: 'manual' });
    for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const [k, v] = kv.split('='); if (/Max-Age=0/.test(c)) this.jar.delete(k); else this.jar.set(k, v); }
    const text = await r.text();
    const m = /<meta name="csrf-token" content="([^"]+)"/.exec(text);
    if (m) this.csrf = m[1];
    return { status: r.status, text, location: r.headers.get('location') ?? '', setCookie: r.headers.getSetCookie() };
  }
  page(path: string) { return this.req(path); }
  post(path: string, form: Record<string, string>) { return this.req(path, { method: 'POST', form }); }
  async signin(name: string) { await this.page('/signin'); skew += 3_600_000; return this.post('/signin', { username: name, password: 'pw', next: '/' }); }
  async register(name: string, extra: Record<string, string>) { await this.page('/register'); skew += 3_600_000; return this.post('/register', { username: name, email: `${name}@x.io`, password: 'password1', next: '/', ...extra }); }
}

const PROMPT = 'class="notice notice-ok newsletter-prompt"';

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'site-news-'));
  store = new JsonSiteStore(join(dir, 'site.json'));
  const cfg = { ...loadConfig({ SITE_SECRET: 'test-secret', SITE_DATA_DIR: dir, GAME_MODE: 'link', GAME_URL: 'http://game.example' } as NodeJS.ProcessEnv) };
  const app = createApp({ cfg, store, lobby: lobby as unknown as Lobby, pilots, uploads: new Uploads(dir), limiter: new RateLimiter(() => Date.now() + skew) });
  server = http.createServer((q, s) => void app.handle(q, s));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  cfg.origin = base;
});
afterAll(async () => { server.close(); await store.close(); rmSync(dir, { recursive: true, force: true }); });

describe('newsletter: signing up on the website', () => {
  it('the form asks yes or no with nothing picked, in a labelled radio group', async () => {
    const page = (await new Browser().page('/register')).text;
    expect(page).toContain(`<legend>${NEWSLETTER_QUESTION}</legend>`);
    expect(page).toContain(NEWSLETTER_YES);
    expect(page).toContain(NEWSLETTER_NO);
    expect((page.match(/type="radio" name="newsletter"/g) ?? []).length).toBe(2);
    expect(page).not.toMatch(/name="newsletter"[^>]*checked/);
    expect(page).not.toMatch(/type="checkbox"[^>]*newsletter/);
    // (The sign-in form doesn't ask)
    expect((await new Browser().page('/signin')).text).not.toContain('name="newsletter"');
  });

  it('without a choice no account is made: the form comes back saying so, with what was typed', async () => {
    const b = new Browser();
    for (const extra of [{}, { newsletter: '' }, { newsletter: 'on' }, { newsletter: 'true' }, { newsletter: '1' }]) {
      const r = await b.register('nochoice', extra as Record<string, string>);
      expect(r.status).toBe(400);
      expect(r.text).toContain(`${NEWSLETTER_MISSING}.`);
      expect(r.text).toContain('value="nochoice"');
      expect(r.text).not.toMatch(/name="newsletter"[^>]*checked/);
    }
    expect(lobby.users.some((u) => u.username === 'nochoice')).toBe(false);
    expect(lobby.calls.filter((c) => c[0] === 'register')).toEqual([]);
  });

  it('yes and no are passed on as they were chosen, and such an account is never asked again', async () => {
    const yes = new Browser(), no = new Browser();
    expect((await yes.register('yesser', { newsletter: 'yes' })).status).toBe(303);
    expect((await no.register('noer', { newsletter: 'no' })).status).toBe(303);
    expect(lobby.calls.filter((c) => c[0] === 'register')).toEqual([['register', 'yesser', true], ['register', 'noer', false]]);
    expect(lobby.users.find((u) => u.username === 'yesser')).toMatchObject({ newsletter: true, asked: true, via: 'signup' });
    expect(lobby.users.find((u) => u.username === 'noer')).toMatchObject({ newsletter: false, asked: true, via: 'signup' });
    for (const b of [yes, no]) expect((await b.page('/')).text).not.toContain(PROMPT);
  });

  it('a choice survives another error on the form', async () => {
    const b = new Browser();
    const r = await b.register('yesser', { newsletter: 'no' });
    expect(r.status).toBe(400);
    expect(r.text).toContain('Username already taken');
    expect(r.text).toMatch(/value="no" required checked/);
    expect(r.text).not.toMatch(/value="yes" required checked/);
  });
});

describe('newsletter: the one-time question', () => {
  it('an account that was never asked sees it on any page; a visitor who is not signed in never does', async () => {
    lobby.old('veteran');
    const b = new Browser();
    expect((await b.page('/')).text).not.toContain(PROMPT);
    await b.signin('veteran');
    for (const path of ['/', '/updates', '/account', '/account/inbox']) {
      const text = (await b.page(path)).text;
      expect(text, path).toContain(PROMPT);
      expect(text).toContain(`<input type="hidden" name="back" value="${path}">`);
    }
    const text = (await b.page('/')).text;
    expect(text).toContain(`<button class="btn" type="submit" name="newsletter" value="yes">${NEWSLETTER_YES}</button>`);
    expect(text).toContain(`<button class="btn" type="submit" name="newsletter" value="no">${NEWSLETTER_NO}</button>`);
    expect(text).toMatch(/newsletter-prompt[\s\S]*name="_csrf" value="[^"]+"/);
  });

  it('just carrying on changes nothing: they are asked again', async () => {
    const b = new Browser();
    await b.signin('veteran');
    await b.page('/updates');
    await b.page('/account');
    expect(lobby.users.find((u) => u.username === 'veteran')).toMatchObject({ asked: false, newsletter: false });
    expect((await b.page('/')).text).toContain(PROMPT);
  });

  it('"Ask me later" hides it for this browser session only, and records nothing', async () => {
    const b = new Browser();
    await b.signin('veteran');
    await b.page('/updates');
    const r = await b.post('/account/newsletter/later', { back: '/updates' });
    expect(r).toMatchObject({ status: 303, location: '/updates' });
    expect(r.setCookie.find((c) => c.startsWith('nl_later='))).not.toMatch(/Max-Age|Expires/i);
    expect((await b.page('/')).text).not.toContain(PROMPT);
    expect(lobby.users.find((u) => u.username === 'veteran')).toMatchObject({ asked: false });
    expect(lobby.calls.filter((c) => c[0] === 'setNewsletter')).toEqual([]);
    // (A new browser session: asked again)
    const next = new Browser();
    await next.signin('veteran');
    expect((await next.page('/')).text).toContain(PROMPT);
  });

  it('Yes: recorded as consent from the prompt, back to the page they were on, and not asked again', async () => {
    const b = new Browser();
    await b.signin('veteran');
    await b.page('/updates');
    const r = await b.post('/account/newsletter/answer', { newsletter: 'yes', back: '/updates' });
    expect(r).toMatchObject({ status: 303, location: '/updates?ok=newsletter-on' });
    expect(lobby.users.find((u) => u.username === 'veteran')).toMatchObject({ newsletter: true, asked: true, via: 'prompt' });
    const after = (await b.page(r.location)).text;
    expect(after).not.toContain(PROMPT);
    expect(after).toContain('signed up to the email newsletter');
  });

  it('No thanks: recorded as asked and declined, and not asked again', async () => {
    lobby.old('decliner');
    const b = new Browser();
    await b.signin('decliner');
    const r = await b.post('/account/newsletter/answer', { newsletter: 'no', back: '/' });
    expect(r.location).toBe('/?ok=newsletter-off');
    expect(lobby.users.find((u) => u.username === 'decliner')).toMatchObject({ newsletter: false, asked: true, via: 'prompt' });
    expect((await b.page('/')).text).not.toContain(PROMPT);
    // (And on another browser, or a later visit: the answer is the account's)
    const other = new Browser();
    await other.signin('decliner');
    expect((await other.page('/')).text).not.toContain(PROMPT);
  });

  it('an answer that is neither yes nor no changes nothing', async () => {
    lobby.old('vague');
    const b = new Browser();
    await b.signin('vague');
    for (const newsletter of ['', 'maybe', 'on', 'true']) await b.post('/account/newsletter/answer', { newsletter, back: '/' });
    expect(lobby.users.find((u) => u.username === 'vague')).toMatchObject({ asked: false });
    expect((await b.page('/')).text).toContain(PROMPT);
  });

  it('needs the CSRF token and a session: another site, or a signed-out visitor, changes nothing', async () => {
    lobby.old('target');
    const b = new Browser();
    await b.signin('target');
    await b.page('/');
    const before = lobby.calls.length;
    expect((await b.req('/account/newsletter/answer', { method: 'POST', form: { newsletter: 'yes', back: '/' }, noCsrf: true })).status).toBe(403);
    expect((await b.req('/account/newsletter/set', { method: 'POST', form: { newsletter: 'yes' }, noCsrf: true })).status).toBe(403);
    const out = new Browser();
    await out.page('/');
    expect((await out.post('/account/newsletter/answer', { newsletter: 'yes', back: '/' })).location).toBe('/signin?next=/account');
    expect((await out.post('/account/newsletter/set', { newsletter: 'yes' })).location).toBe('/signin?next=/account');
    expect(lobby.calls.length).toBe(before);
    expect(lobby.users.find((u) => u.username === 'target')).toMatchObject({ asked: false, newsletter: false });
  });

  it("an answer is the signed-in account's own: nothing in the form can name another", async () => {
    lobby.old('mallory');
    const b = new Browser();
    await b.signin('mallory');
    await b.page('/');
    await b.post('/account/newsletter/answer', { newsletter: 'yes', back: '/', username: 'target', userId: '1', token: 'tok1xxxxxxxxxxxxxxxxxxxxxxxxxxxx' });
    expect(lobby.calls.at(-1)!.slice(0, 4)).toEqual(['setNewsletter', 'mallory', true, 'prompt']);
    expect(lobby.users.find((u) => u.username === 'target')).toMatchObject({ asked: false, newsletter: false });
  });

  it('only goes back to a page on this site', () => {
    for (const ok of ['/', '/updates', '/account', '/updates/first-light']) expect(safeBack(ok)).toBe(ok);
    for (const bad of ['//evil.example', 'https://evil.example', '/\\evil.example', 'javascript:alert(1)', '', undefined, 5, '/a b', '/account/newsletter/answer']) expect(safeBack(bad)).toBe('/');
  });
});

describe('newsletter: the account page setting', () => {
  it('shows what it is and one button to change it; turning it on and off is saved as a settings change', async () => {
    lobby.old('toggler');
    const b = new Browser();
    await b.signin('toggler');
    let page = (await b.page('/account')).text;
    expect(page).toContain('<h2 id="nl-h">Email newsletter</h2>');
    expect(page).toContain('You can change this any time.');
    expect(page).toContain("you haven't chosen yet");
    expect(page).toContain('>Turn on</button>');

    expect((await b.post('/account/newsletter/set', { newsletter: 'yes' })).location).toBe('/account?ok=newsletter-on#newsletter');
    expect(lobby.users.find((u) => u.username === 'toggler')).toMatchObject({ newsletter: true, asked: true, via: 'settings' });
    page = (await b.page('/account')).text;
    expect(page).toContain('<b>On</b>');
    expect(page).toContain('>Turn off</button>');
    expect(page).toContain('<input type="hidden" name="newsletter" value="no">');
    expect(page).not.toContain(PROMPT);

    await b.post('/account/newsletter/set', { newsletter: 'no' });
    expect(lobby.users.find((u) => u.username === 'toggler')).toMatchObject({ newsletter: false, asked: true, via: 'settings' });
    page = (await b.page('/account')).text;
    expect(page).toContain('<b>Off</b>');
    expect(page).toContain('>Turn on</button>');
  });

  it('a lobby that fails to save says nothing was changed by leaving it as it was', async () => {
    lobby.old('unlucky');
    const b = new Browser();
    await b.signin('unlucky');
    await b.page('/account');
    lobby.failSet = true;
    try {
      const r = await b.post('/account/newsletter/set', { newsletter: 'yes' });
      expect(r.status).toBe(303);
      expect((await b.page('/account')).text).toContain('>Turn on</button>');
    } finally {
      lobby.failSet = false;
    }
  });
});

describe('newsletter: views and the lobby calls', () => {
  const ctx = { siteName: 'Space Game', user: { id: 7, username: 'alice', isAdmin: false }, csrf: 'csrf-tok', path: '/up"dates<x>', live: null, origin: 'http://x' } as PageCtx;

  it('the choice: nothing picked unless they picked it', () => {
    expect(String(newsletterChoice())).not.toContain('checked');
    expect(String(newsletterChoice(null))).not.toContain('checked');
    expect((String(newsletterChoice(true)).match(/checked/g) ?? []).length).toBe(1);
    expect(String(newsletterChoice(false))).toMatch(/value="no" required checked/);
    expect(readChoice('yes')).toBe(true);
    expect(readChoice('no')).toBe(false);
    for (const none of [undefined, null, '', 'on', 'true', true, 1]) expect(readChoice(none)).toBeNull();
  });

  it('the prompt and the setting carry the CSRF field and escape what they show', () => {
    const prompt = String(newsletterPrompt(ctx));
    expect(prompt).toContain('name="_csrf" value="csrf-tok"');
    expect(prompt).not.toContain('<x>');
    expect(prompt).toContain('value="/up&quot;dates&lt;x&gt;"');
    expect(prompt).not.toMatch(/autofocus|checked/);
    const setting = String(newsletterSetting(ctx, { newsletter: false, asked: true }, '<b>oops</b>'));
    expect(setting).toContain('name="_csrf" value="csrf-tok"');
    expect(setting).not.toContain('<b>oops</b>');
  });

  it('the admin line is counts only', () => {
    const line = String(newsletterCountsLine({ accounts: 10, consented: 3, declined: 2, notAsked: 5 }));
    expect(line).toContain('<b>3</b> signed up, <b>2</b> said no, <b>5</b> not asked yet (of 10 accounts)');
    expect(line).not.toContain('@');
    expect(newsletterCountsLine(null)).toBe('');
  });

  it("the site's calls to the lobby: the answer as a boolean with the session's own token, and the flags read back", async () => {
    const seen: { path: string; body: any; auth?: string }[] = [];
    const answers: Record<string, object> = {
      '/auth/register': { success: true, token: 'tok' }, '/auth/validate': { success: true, id: 4, username: 'a', isAdmin: false, isOwner: false, newsletterAsked: false },
      '/auth/account': { success: true, id: 4, username: 'a', email: 'a@x.io', isAdmin: false, isOwner: false, createdAt: 'c', newsletter: true, newsletterAsked: true },
      '/newsletter/set': { success: true }, '/admin/newsletter': { success: true, accounts: 9, consented: 4, declined: 3, notAsked: 2 },
    };
    const srv = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (d) => { raw += d; });
      req.on('end', () => { seen.push({ path: req.url ?? '', body: JSON.parse(raw || '{}'), auth: req.headers.authorization }); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(answers[req.url ?? ''] ?? { success: false })); });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    try {
      const l = new HttpLobby(`http://127.0.0.1:${(srv.address() as { port: number }).port}`, 'sssh');
      await l.register('a', 'a@x.io', 'pw', '1.2.3.4', true);
      await l.register('b', 'b@x.io', 'pw', '1.2.3.4', false);
      await l.register('c', 'c@x.io', 'pw', '1.2.3.4');
      const regs = seen.filter((s) => s.path === '/auth/register').map((s) => s.body);
      expect(regs[0]).toMatchObject({ newsletter: true });
      expect(regs[1]).toMatchObject({ newsletter: false });
      expect(regs[2]).not.toHaveProperty('newsletter');
      expect(await l.validate('tok')).toMatchObject({ id: 4, newsletterAsked: false });
      expect((await l.account('tok') as any).account).toMatchObject({ newsletter: true, newsletterAsked: true });
      expect(await l.setNewsletter('tok', false, 'settings', '1.2.3.4')).toEqual({ ok: true });
      const set = seen.find((s) => s.path === '/newsletter/set')!;
      expect(set.body).toEqual({ token: 'tok', newsletter: false, via: 'settings' });
      expect(set.auth).toBeUndefined();
      expect(await l.newsletterCounts()).toEqual({ accounts: 9, consented: 4, declined: 3, notAsked: 2 });
      expect(seen.find((s) => s.path === '/admin/newsletter')!.auth).toBe('Bearer sssh');
      expect(await new HttpLobby('http://127.0.0.1:1', '').newsletterCounts()).toBeNull();
    } finally {
      await new Promise((r) => srv.close(() => r(null)));
    }
  });
});
