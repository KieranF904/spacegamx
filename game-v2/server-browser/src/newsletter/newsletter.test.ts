import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type http from 'http';
import { JsonUserStore } from '../accounts/JsonUserStore.js';
import { AccountRoutes } from '../accounts/routes.js';
import { NewsletterRoutes } from './routes.js';
import { JsonConsentStore } from './JsonConsentStore.js';
import { NEWSLETTER_SCHEMA, PostgresConsentStore } from './PostgresConsentStore.js';

// (JsonUserStore seeds a dev admin only with DEV_AUTH=1: server-browser/src/accounts/devAuth.ts)
process.env.DEV_AUTH = '1';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'lobby-newsletter-'));
  dirs.push(dir);
  return dir;
}

/** The accounts and the newsletter routes wired as the lobby's entry wires them (server-browser/src/index.ts) */
async function setup(opts: { file?: string; users?: JsonUserStore } = {}) {
  const users = opts.users ?? new JsonUserStore(join(tmp(), 'users.json'));
  const store = new JsonConsentStore(opts.file ?? null);
  let clock = 5_000;
  let body: object = {};
  let out: { status: number; body: any } = { status: 0, body: null };
  const send = (_: unknown, status: number, b: any) => { out = { status, body: b }; };
  let n = 0;
  const ip = () => `10.2.${Math.floor(++n / 250)}.${n % 250}`;
  const accounts = await AccountRoutes.create(send, async () => body, ip, { store: users, adminSecret: 'sssh' });
  const news = await NewsletterRoutes.create(users, send, async () => body, ip, { store, adminSecret: 'sssh', dataDir: tmp(), now: () => clock });
  accounts.onRegistered = (user, b) => news.signedUp(user.id, b.newsletter);
  accounts.accountExtra = async (user) => { const s = await news.state(user.id); return { newsletter: s.newsletter, newsletterAsked: s.asked }; };
  accounts.validateExtra = async (user) => ({ newsletterAsked: (await news.state(user.id)).asked });
  const call = async (url: string, b: object, auth?: string) => {
    body = b;
    out = { status: 0, body: null };
    const req = { method: 'POST', headers: auth !== undefined ? { authorization: `Bearer ${auth}` } : {} } as unknown as http.IncomingMessage;
    const handled = (await news.handle(req, {} as http.ServerResponse, url)) || (await accounts.handle(req, {} as http.ServerResponse, url));
    return handled ? out : null;
  };
  /** Sign up through /auth/register, with whatever else the form sent */
  const signUp = async (name: string, extra: object = {}) => {
    const r = (await call('/auth/register', { username: name, email: `${name}@example.com`, password: 'password1', ...extra }))!;
    if (!r.body.success) throw new Error(r.body.error);
    const id = (await users.getUserByUsername(name))!.id;
    return { token: r.body.token as string, id };
  };
  return { users, store, news, call, signUp, tick: (ms: number) => { clock += ms; } };
}

const NOT_ASKED = { newsletter: false, asked: false, at: null, via: null };

describe('newsletter consent: existing accounts', () => {
  it('an account from before this existed reads as not asked and not consenting, wherever it is read', async () => {
    // (Made straight in the store, as every account already there was: no sign-up answer of any kind)
    const users = new JsonUserStore(join(tmp(), 'users.json'));
    const old = await users.register('veteran', 'veteran@example.com', 'password1');
    if (!old.success) throw new Error(old.error);
    const t = await setup({ users });
    expect((await t.call('/newsletter/get', { token: old.token }))!.body).toEqual({ success: true, ...NOT_ASKED });
    expect(await t.news.state(old.user.id)).toEqual(NOT_ASKED);
    expect((await t.call('/auth/account', { token: old.token }))!.body).toMatchObject({ username: 'veteran', newsletter: false, newsletterAsked: false });
    expect((await t.call('/auth/validate', { token: old.token }))!.body).toMatchObject({ id: old.user.id, newsletterAsked: false });
  });

  it('the migration only adds a table: IF NOT EXISTS, run at every start, the same statement schema.sql has, and users is untouched', async () => {
    const queries: string[] = [];
    const pool = { query: async (sql: string) => { queries.push(sql); return { rows: [] }; } };
    await PostgresConsentStore.create(pool);
    await PostgresConsentStore.create(pool);
    expect(queries).toEqual([...NEWSLETTER_SCHEMA, ...NEWSLETTER_SCHEMA]);
    for (const sql of NEWSLETTER_SCHEMA) {
      expect(sql).toMatch(/^CREATE TABLE IF NOT EXISTS newsletter_consent /);
      expect(sql).not.toMatch(/ALTER|DROP|TRUNCATE|UPDATE users|INSERT/i);
      expect(sql).not.toContain(';');
    }
    expect(NEWSLETTER_SCHEMA[0]).toMatch(/user_id\s+BIGINT PRIMARY KEY REFERENCES users\(id\) ON DELETE CASCADE/);
    expect(NEWSLETTER_SCHEMA[0]).toMatch(/newsletter\s+BOOLEAN NOT NULL DEFAULT FALSE/);
    expect(NEWSLETTER_SCHEMA[0]).toMatch(/newsletter_asked\s+BOOLEAN NOT NULL DEFAULT FALSE/);
    const squash = (s: string) => s.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').replace(/\s*([(),])\s*/g, '$1').trim();
    const schemaSql = squash(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../schema.sql'), 'utf8'));
    for (const sql of NEWSLETTER_SCHEMA) expect(schemaSql).toContain(squash(sql));
    await expect(PostgresConsentStore.create({ query: async () => { throw new Error('permission denied'); } })).rejects.toThrow(/schema\.sql/);
  });

  it('Postgres: an account with no row is not asked; an answer is one upsert for that account; counts come from the rows', async () => {
    const queries: { sql: string; params: any[] }[] = [];
    const pool = { query: async (sql: string, params: any[] = []) => {
      queries.push({ sql, params });
      if (sql.startsWith('INSERT')) return { rows: [{ user_id: String(params[0]), newsletter: params[1], newsletter_asked: true, newsletter_at: String(params[2]), newsletter_via: params[3] }] };
      if (sql.startsWith('SELECT COUNT')) return { rows: [{ consented: '4', declined: '2' }] };
      return { rows: [] };
    } };
    const store = await PostgresConsentStore.create(pool);
    expect(await store.get(7)).toBeNull();
    expect(await store.set(7, true, 'prompt', 99)).toEqual({ user_id: 7, newsletter: true, newsletter_asked: true, newsletter_at: 99, newsletter_via: 'prompt' });
    const insert = queries.find((q) => q.sql.startsWith('INSERT'))!;
    expect(insert.sql).toMatch(/ON CONFLICT \(user_id\) DO UPDATE/);
    expect(insert.params).toEqual([7, true, 99, 'prompt']);
    expect(await store.counts()).toEqual({ consented: 4, declined: 2 });
    for (const q of queries.slice(NEWSLETTER_SCHEMA.length)) expect(q.sql).not.toMatch(/\busers\b(?!\()/);
  });
});

describe('newsletter consent: sign-up', () => {
  it('records exactly what the form sent: yes is yes, no is no, both asked, via signup', async () => {
    const t = await setup();
    const yes = await t.signUp('yesser', { newsletter: true });
    const no = await t.signUp('noer', { newsletter: false });
    expect(await t.news.state(yes.id)).toEqual({ newsletter: true, asked: true, at: 5000, via: 'signup' });
    expect(await t.news.state(no.id)).toEqual({ newsletter: false, asked: true, at: 5000, via: 'signup' });
    expect((await t.call('/auth/validate', { token: no.token }))!.body.newsletterAsked).toBe(true);
  });

  it('a sign-up that sent no answer (an old client) still makes the account, left not asked: neither answer is assumed', async () => {
    const t = await setup();
    const old = await t.signUp('oldclient');
    expect(await t.news.state(old.id)).toEqual(NOT_ASKED);
    expect((await t.call('/auth/validate', { token: old.token }))!.body.newsletterAsked).toBe(false);
  });

  it('anything that is not a real yes or no is not an answer', async () => {
    const t = await setup();
    let i = 0;
    for (const newsletter of ['true', 'on', 'yes', 1, 0, null, {}, [], 'false']) {
      const a = await t.signUp(`odd${i++}`, { newsletter });
      expect(await t.news.state(a.id), JSON.stringify(newsletter)).toEqual(NOT_ASKED);
    }
  });

  it('a sign-up that fails records nothing, and a failing record never fails the sign-up', async () => {
    const t = await setup();
    await t.signUp('taken', { newsletter: true });
    const dup = (await t.call('/auth/register', { username: 'taken', email: 'other@example.com', password: 'password1', newsletter: true }))!;
    expect(dup.body.success).toBe(false);
    expect(await t.store.counts()).toEqual({ consented: 1, declined: 0 });
    t.store.set = async () => { throw new Error('disk full'); };
    const r = (await t.call('/auth/register', { username: 'unlucky', email: 'unlucky@example.com', password: 'password1', newsletter: true }))!;
    expect(r.body.success).toBe(true);
  });

  it('signing in never records an answer', async () => {
    const t = await setup();
    const a = await t.signUp('quiet');
    await t.call('/auth/login', { username: 'quiet', password: 'password1', newsletter: true });
    expect(await t.news.state(a.id)).toEqual(NOT_ASKED);
  });
});

describe('newsletter consent: answering later', () => {
  it('the prompt: yes or no sets the answer and marks them asked', async () => {
    const t = await setup();
    const a = await t.signUp('alice'), b = await t.signUp('bob');
    t.tick(1000);
    expect((await t.call('/newsletter/set', { token: a.token, newsletter: true, via: 'prompt' }))!.body).toEqual({ success: true, newsletter: true, asked: true, at: 6000, via: 'prompt' });
    expect((await t.call('/newsletter/set', { token: b.token, newsletter: false, via: 'prompt' }))!.body).toEqual({ success: true, newsletter: false, asked: true, at: 6000, via: 'prompt' });
    expect((await t.call('/newsletter/get', { token: a.token }))!.body).toMatchObject({ newsletter: true, asked: true });
    expect((await t.call('/auth/validate', { token: b.token }))!.body.newsletterAsked).toBe(true);
  });

  it('not answering changes nothing: reading it leaves them not asked', async () => {
    const t = await setup();
    const a = await t.signUp('alice');
    await t.call('/newsletter/get', { token: a.token });
    await t.call('/auth/account', { token: a.token });
    await t.call('/auth/validate', { token: a.token });
    expect(await t.news.state(a.id)).toEqual(NOT_ASKED);
  });

  it('the setting: on and off any number of times, the last one kept with when and where', async () => {
    const t = await setup();
    const a = await t.signUp('alice', { newsletter: true });
    t.tick(10);
    await t.call('/newsletter/set', { token: a.token, newsletter: false, via: 'settings' });
    expect(await t.news.state(a.id)).toEqual({ newsletter: false, asked: true, at: 5010, via: 'settings' });
    t.tick(10);
    await t.call('/newsletter/set', { token: a.token, newsletter: true, via: 'settings' });
    expect(await t.news.state(a.id)).toEqual({ newsletter: true, asked: true, at: 5020, via: 'settings' });
    expect((await t.call('/auth/account', { token: a.token }))!.body).toMatchObject({ newsletter: true, newsletterAsked: true });
  });

  it("an answer is the session's own: naming another account changes nothing of theirs", async () => {
    const t = await setup();
    const a = await t.signUp('alice', { newsletter: false }), b = await t.signUp('bob');
    await t.call('/newsletter/set', { token: b.token, newsletter: true, via: 'settings', userId: a.id, user_id: a.id, username: 'alice', id: a.id });
    expect(await t.news.state(a.id)).toMatchObject({ newsletter: false, via: 'signup' });
    expect(await t.news.state(b.id)).toMatchObject({ newsletter: true, via: 'settings' });
    expect((await t.call('/newsletter/get', { token: b.token, userId: a.id }))!.body).toMatchObject({ newsletter: true });
  });

  it('no session (a guest has none), or a stale one: 401 and nothing recorded', async () => {
    const t = await setup();
    for (const body of [{}, { token: '' }, { token: 'not-a-session' }, { token: 7 }]) {
      expect((await t.call('/newsletter/get', body))!.status).toBe(401);
      expect((await t.call('/newsletter/set', { ...body, newsletter: true, via: 'prompt' }))!.status).toBe(401);
    }
    expect(await t.store.counts()).toEqual({ consented: 0, declined: 0 });
  });

  it('only a real yes or no, and only from the prompt or the settings', async () => {
    const t = await setup();
    const a = await t.signUp('alice');
    for (const body of [{ via: 'prompt' }, { newsletter: 'true', via: 'prompt' }, { newsletter: 1, via: 'prompt' }, { newsletter: null, via: 'settings' },
      { newsletter: true }, { newsletter: true, via: 'signup' }, { newsletter: true, via: 'admin' }, { newsletter: false, via: '' }]) {
      expect((await t.call('/newsletter/set', { token: a.token, ...body }))!.status, JSON.stringify(body)).toBe(400);
    }
    expect(await t.news.state(a.id)).toEqual(NOT_ASKED);
  });

  it('is kept across a restart, and goes with a deleted account', async () => {
    const file = join(tmp(), 'newsletter.json');
    const t = await setup({ file });
    const a = await t.signUp('alice', { newsletter: true });
    await t.store.close();
    const again = new JsonConsentStore(file);
    expect(await again.get(a.id)).toMatchObject({ newsletter: true, newsletter_asked: true, newsletter_via: 'signup' });
    expect(readFileSync(file, 'utf8')).not.toContain('@'); // (no addresses here: they stay with the account)
    await again.forgetUser(a.id);
    expect(await again.get(a.id)).toBeNull();
  });
});

describe('newsletter consent: the owner', () => {
  it('counts who said yes, who said no and who has not been asked, for a caller with the admin secret only', async () => {
    const t = await setup();
    await t.signUp('y1', { newsletter: true });
    await t.signUp('y2', { newsletter: true });
    await t.signUp('n1', { newsletter: false });
    const later = await t.signUp('later');
    await t.signUp('never');
    await t.call('/newsletter/set', { token: later.token, newsletter: false, via: 'prompt' });
    expect((await t.call('/admin/newsletter', {}))!.status).toBe(403);
    expect((await t.call('/admin/newsletter', {}, 'wrong'))!.status).toBe(403);
    expect((await t.call('/admin/newsletter', { token: later.token }))!.status).toBe(403);
    const r = (await t.call('/admin/newsletter', {}, 'sssh'))!;
    const accounts = await t.users.getUserCount();
    // (The seeded dev admin was never asked either)
    expect(r.body).toEqual({ success: true, accounts, consented: 2, declined: 2, notAsked: accounts - 4 });
    expect(JSON.stringify(r.body)).not.toMatch(/@|y1|later/);
  });

  it('other paths are left to the rest of the lobby', async () => {
    const t = await setup();
    const req = { method: 'POST', headers: {} } as unknown as http.IncomingMessage;
    expect(await t.news.handle(req, {} as http.ServerResponse, '/newsletter/other')).toBe(false);
    expect(await t.news.handle(req, {} as http.ServerResponse, '/auth/login')).toBe(false);
    expect(await t.news.handle({ method: 'GET', headers: {} } as unknown as http.IncomingMessage, {} as http.ServerResponse, '/newsletter/get')).toBe(false);
  });
});
