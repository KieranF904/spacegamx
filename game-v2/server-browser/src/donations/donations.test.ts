import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type http from 'http';
import { JsonUserStore } from '../accounts/JsonUserStore.js';
import { AccountRoutes } from '../accounts/routes.js';
import { CONTRIBUTOR_AT, thankYouMessage, moneyText, DonationRoutes, CREATE_LIMIT, MAX_AMOUNT, MIN_AMOUNT, parseAmount } from './routes.js';
import { JsonDonationStore } from './JsonDonationStore.js';
import { InboxRoutes } from '../inbox/routes.js';
import { JsonMessageStore } from '../inbox/JsonMessageStore.js';
import { DONATIONS_SCHEMA, PostgresDonationStore } from './PostgresDonationStore.js';
import { PayPalClient, PayPalError, minorToValue, paypalConfig, valueToMinor } from './paypal.js';

// (JsonUserStore seeds a dev admin only with DEV_AUTH=1: server-browser/src/accounts/devAuth.ts)
process.env.DEV_AUTH = '1';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'lobby-donations-'));
  dirs.push(dir);
  return dir;
}

// (Made-up values: nothing here is a real key)
const SECRET = 'fake-secret-do-not-leak';
const CLIENT_ID = 'fake-client-id';

/**
 * A stand-in for PayPal's API: the token endpoint and Orders v2 (create, capture, get). No test here touches the network.
 * `next` sets how the next capture goes.
 */
function fakePayPal() {
  const calls: { method: string; url: string; headers: Record<string, string>; body: any }[] = [];
  const orders = new Map<string, { value: string; currency: string; custom_id?: string; captured: boolean; captureStatus: string }>();
  const state = {
    tokens: 0,
    expiresIn: 3600,
    /** What a capture does: 'ok', a capture status ('PENDING', 'DECLINED'), an error issue, 'down' (HTTP 500) or 'throw' */
    next: 'ok' as string,
    /** PayPal's own idea of the captured amount, when it differs from what was asked */
    captureValue: null as string | null,
  };
  const reply = (status: number, json: unknown) => ({ status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(json) });
  const orderJson = (id: string) => {
    const o = orders.get(id)!;
    return {
      id, status: o.captured && o.captureStatus === 'COMPLETED' ? 'COMPLETED' : o.captured ? 'APPROVED' : 'CREATED',
      // (PayPal sends the payer too: the lobby must not keep any of it)
      payer: { email_address: 'payer@example.com', name: { given_name: 'Pat', surname: 'Payer' }, payer_id: 'PAYER123' },
      purchase_units: [{ payments: o.captured ? { captures: [{ id: `CAP-${id}`, status: o.captureStatus, amount: { currency_code: o.currency, value: state.captureValue ?? o.value }, custom_id: o.custom_id }] } : undefined }],
    };
  };
  const fetchFn = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    const path = url.replace(/^https:\/\/[^/]+/, '');
    const isForm = init.headers['Content-Type'] === 'application/x-www-form-urlencoded';
    calls.push({ method: init.method, url, headers: init.headers, body: init.body && !isForm ? JSON.parse(init.body) : init.body });
    if (path === '/v1/oauth2/token') {
      if (init.headers.Authorization !== `Basic ${Buffer.from(`${CLIENT_ID}:${SECRET}`).toString('base64')}`) return reply(401, { error: 'invalid_client' });
      state.tokens++;
      return reply(200, { access_token: `tok-${state.tokens}`, expires_in: state.expiresIn });
    }
    if (init.headers.Authorization !== `Bearer tok-${state.tokens}`) return reply(401, { name: 'AUTHENTICATION_FAILURE' });
    if (init.method === 'POST' && path === '/v2/checkout/orders') {
      const body = JSON.parse(init.body!);
      const id = `ORDER${String(orders.size + 1).padStart(4, '0')}`;
      const u = body.purchase_units[0];
      orders.set(id, { value: u.amount.value, currency: u.amount.currency_code, custom_id: u.custom_id, captured: false, captureStatus: '' });
      return reply(201, { id, status: 'CREATED' });
    }
    const m = /^\/v2\/checkout\/orders\/([^/]+)(\/capture)?$/.exec(path);
    if (m && orders.has(m[1])) {
      const o = orders.get(m[1])!;
      if (!m[2]) return reply(200, orderJson(m[1]));
      if (o.captured) return reply(422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_ALREADY_CAPTURED' }], debug_id: 'dbdb01' });
      const next = state.next;
      if (next === 'throw') throw new Error(`socket hang up (Authorization: ${init.headers.Authorization})`);
      if (next === 'down') return reply(500, { name: 'INTERNAL_SERVER_ERROR', debug_id: 'dbdb02' });
      if (next === 'lost') { o.captured = true; o.captureStatus = 'COMPLETED'; throw new Error('timeout'); }
      if (next === 'INSTRUMENT_DECLINED' || next === 'ORDER_NOT_APPROVED') return reply(422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: next }], debug_id: 'dbdb03' });
      o.captured = true;
      o.captureStatus = next === 'ok' ? 'COMPLETED' : next;
      return reply(201, orderJson(m[1]));
    }
    return reply(404, { name: 'RESOURCE_NOT_FOUND' });
  };
  const count = (what: 'token' | 'create' | 'capture' | 'get') => calls.filter((c) =>
    what === 'token' ? c.url.endsWith('/v1/oauth2/token')
      : what === 'create' ? c.method === 'POST' && c.url.endsWith('/v2/checkout/orders')
      : what === 'capture' ? c.url.endsWith('/capture')
      : c.method === 'GET').length;
  return { calls, orders, state, fetchFn, count };
}

/** Accounts ("alice", "bob"), a fake PayPal and the donation routes, called like the lobby does */
async function setup(opts: { file?: string; off?: boolean } = {}) {
  const users = new JsonUserStore(join(tmp(), 'users.json'));
  const reg = async (name: string) => {
    const r = await users.register(name, `${name}@example.com`, 'password1');
    if (!r.success) throw new Error(r.error);
    return r;
  };
  const alice = await reg('alice');
  const bob = await reg('bob');
  const store = new JsonDonationStore(opts.file ?? null);
  const pp = fakePayPal();
  let clock = 1_000_000;
  const paypal = opts.off ? null : new PayPalClient({ env: 'sandbox', clientId: CLIENT_ID, secret: SECRET }, pp.fetchFn, () => clock);
  let body: object = {};
  let ip = '10.0.0.1';
  let out: { status: number; body: any } = { status: 0, body: null };
  // (The inbox as the lobby wires it: server-browser/src/index.ts)
  const send = (_: unknown, status: number, b: any) => { out = { status, body: b }; };
  const inbox = await InboxRoutes.create(users, send, async () => body, () => ip, { store: new JsonMessageStore(null), adminSecret: 'sssh', dataDir: tmp() });
  const thanked: { userId: number; amount: number; currency: string; crossed: boolean }[] = [];
  const routes = await DonationRoutes.create(users, send, async () => body, () => ip,
    { store, paypal, adminSecret: 'sssh', dataDir: tmp(), now: () => clock,
      onCompleted: async (d) => { thanked.push(d); const m = thankYouMessage(d.amount, d.currency, d.crossed); await inbox.systemMessage(d.userId, m.subject, m.body); } });
  /** A pilot's inbox, read the way the game reads it (POST /inbox/list) */
  const mail = async (token: string) => {
    body = { token }; ip = `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`; out = { status: 0, body: null };
    await inbox.handle({ method: 'POST', headers: {} } as unknown as http.IncomingMessage, {} as http.ServerResponse, '/inbox/list');
    return out.body as { messages: any[]; unread: number; unreadImportant: number };
  };
  let n = 0;
  const call = async (url: string, b: object, o: { from?: string; auth?: string } = {}) => {
    body = b;
    ip = o.from ?? `10.1.${Math.floor(++n / 250)}.${n % 250}`;
    const req = { method: 'POST', headers: o.auth !== undefined ? { authorization: `Bearer ${o.auth}` } : {} } as unknown as http.IncomingMessage;
    out = { status: 0, body: null };
    const handled = await routes.handle(req, {} as http.ServerResponse, url);
    return handled ? out : null;
  };
  /** Make an order and return its id */
  const order = async (amount: unknown, token?: string) => {
    const r = (await call('/donations/create', { amount, ...(token ? { token } : {}) }))!;
    if (r.status !== 200) throw new Error(`create: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.orderId as string;
  };
  return { users, store, routes, pp, call, order, thanked, mail, inbox, tick: (ms: number) => { clock += ms; }, alice: alice.token, bob: bob.token, aliceId: alice.user.id, bobId: bob.user.id };
}

describe('donation amounts', () => {
  it('reads dollars as whole cents, and refuses anything that is not a plain amount with at most two decimals', () => {
    expect(parseAmount('5')).toBe(500);
    expect(parseAmount('7.5')).toBe(750);
    expect(parseAmount(' 12.34 ')).toBe(1234);
    expect(parseAmount(3)).toBe(300);
    expect(parseAmount(0.07)).toBe(7);
    for (const bad of ['5.001', '-5', '1e3', '5,00', '$5', '', ' ', 'abc', '.5', '5.', null, undefined, NaN, Infinity, -1, 1.005, {}, [5], true]) expect(parseAmount(bad)).toBeNull();
  });

  it('cents and PayPal decimal strings convert both ways without rounding', () => {
    expect(minorToValue(500)).toBe('5.00');
    expect(minorToValue(1905)).toBe('19.05');
    expect(minorToValue(7)).toBe('0.07');
    expect(valueToMinor('19.05')).toBe(1905);
    expect(valueToMinor('5')).toBe(500);
    expect(valueToMinor('5.5')).toBe(550);
    for (const bad of ['5.555', '-1.00', 'x', '', 5, null]) expect(valueToMinor(bad)).toBeNull();
  });

  it('an amount outside the limits, with too many decimals or in another currency makes no order', async () => {
    const t = await setup();
    const bads: object[] = [
      { amount: '0.99' }, { amount: (MIN_AMOUNT - 1) / 100 }, { amount: String(MAX_AMOUNT / 100 + 0.01) }, { amount: '100000' },
      { amount: '5.001' }, { amount: '-5' }, { amount: 'lots' }, {}, { amount: null }, { amount: '5', currency: 'GBP' },
    ];
    for (const b of bads) {
      const r = (await t.call('/donations/create', { token: t.alice, ...b }))!;
      expect(r.status, JSON.stringify(b)).toBe(400);
      expect(r.body.success).toBe(false);
    }
    expect(t.pp.count('create')).toBe(0);
    expect(await t.store.recent(10)).toEqual([]);
    // (The edges are allowed)
    expect((await t.call('/donations/create', { amount: MIN_AMOUNT / 100 }))!.status).toBe(200);
    expect((await t.call('/donations/create', { amount: String(MAX_AMOUNT / 100), currency: 'usd' }))!.status).toBe(200);
  });
});

describe('making an order', () => {
  it("ties the order to the session's account on this side, and answers with the order id only", async () => {
    const t = await setup();
    const r = (await t.call('/donations/create', { token: t.alice, amount: '7.50', userId: t.bobId, custom_id: String(t.bobId) }))!;
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true, orderId: 'ORDER0001' });
    expect(await t.store.byOrder('ORDER0001')).toMatchObject({ user_id: t.aliceId, amount: 750, currency: 'USD', status: 'CREATED', capture_id: null });
    const sent = t.pp.calls.find((c) => c.url.endsWith('/v2/checkout/orders'))!;
    expect(sent.url).toBe('https://api-m.sandbox.paypal.com/v2/checkout/orders');
    expect(sent.body.intent).toBe('CAPTURE');
    expect(sent.body.purchase_units).toHaveLength(1);
    // (PayPal is told the amount and a fixed description: nothing that says which account it is)
    expect(sent.body.purchase_units[0]).toEqual({ amount: { currency_code: 'USD', value: '7.50' }, description: 'Support Space Game' });
    expect(sent.body.purchase_units[0]).not.toHaveProperty('custom_id');
    const told = JSON.stringify(sent.body);
    for (const ours of ['alice', 'alice@example.com', t.alice]) expect(told).not.toContain(ours);
    expect(Object.keys(sent.body).sort()).toEqual(['application_context', 'intent', 'purchase_units']);
    expect(sent.body.application_context.shipping_preference).toBe('NO_SHIPPING');
    expect(sent.headers['PayPal-Request-Id']).toBeTruthy();
    // (Nothing is paid yet: no total)
    expect(await t.routes.donatedTotal(t.aliceId)).toBe(0);
  });

  it('a token that is not a session is refused rather than made a guest donation', async () => {
    const t = await setup();
    const r = (await t.call('/donations/create', { token: 'not-a-session', amount: '5' }))!;
    expect(r.status).toBe(401);
    expect(t.pp.count('create')).toBe(0);
  });

  it('limits orders per address', async () => {
    const t = await setup();
    for (let i = 0; i < CREATE_LIMIT; i++) expect((await t.call('/donations/create', { amount: '3' }, { from: '9.9.9.9' }))!.status).toBe(200);
    expect((await t.call('/donations/create', { amount: '3' }, { from: '9.9.9.9' }))!.status).toBe(429);
    expect(t.pp.count('create')).toBe(CREATE_LIMIT);
    expect((await t.call('/donations/create', { amount: '3' }, { from: '9.9.9.8' }))!.status).toBe(200);
  });

  it("PayPal being down makes no row and says nothing was charged", async () => {
    const t = await setup();
    t.pp.fetchFn = async () => { throw new Error('ECONNREFUSED'); };
    const down = new PayPalClient({ env: 'sandbox', clientId: CLIENT_ID, secret: SECRET }, t.pp.fetchFn);
    const users = t.users;
    let out: any = null;
    const routes = await DonationRoutes.create(users, (_, status, b) => { out = { status, body: b }; }, async () => ({ amount: '5' }), () => '1.1.1.1',
      { store: t.store, paypal: down, adminSecret: 'sssh', dataDir: tmp() });
    await routes.handle({ method: 'POST', headers: {} } as unknown as http.IncomingMessage, {} as http.ServerResponse, '/donations/create');
    expect(out.status).toBe(502);
    expect(out.body.error).toMatch(/Nothing was charged/);
    expect(await t.store.recent(10)).toEqual([]);
  });
});

describe('capturing an order', () => {
  it('records the donation from what PayPal says it captured, once, however often capture is called', async () => {
    const t = await setup();
    const id = await t.order('7.50', t.alice);
    const first = (await t.call('/donations/capture', { orderId: id }))!;
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ success: true, amount: 750, currency: 'USD', linked: true });
    expect(await t.store.byOrder(id)).toMatchObject({ user_id: t.aliceId, amount: 750, status: 'COMPLETED', capture_id: `CAP-${id}` });
    expect(await t.routes.donatedTotal(t.aliceId)).toBe(750);

    const again = (await t.call('/donations/capture', { orderId: id }))!;
    expect(again.body).toEqual(first.body);
    // (The second call never reached PayPal, and nothing was added)
    expect(t.pp.count('capture')).toBe(1);
    expect(await t.routes.donatedTotal(t.aliceId)).toBe(750);
    expect(await t.store.recent(10)).toHaveLength(1);
  });

  it('two capture calls at once ask PayPal once', async () => {
    const t = await setup();
    const id = await t.order('5', t.alice);
    const store = t.store, routes = t.routes;
    const outs: any[] = [];
    const mk = () => DonationRoutes.create(t.users, (_, status, b) => { outs.push({ status, body: b }); }, async () => ({ orderId: id }), () => '2.2.2.2', { store, paypal: (routes as any).paypal, adminSecret: 'sssh', dataDir: tmp() });
    const r = await mk();
    const req = { method: 'POST', headers: {} } as unknown as http.IncomingMessage;
    await Promise.all([r.handle(req, {} as http.ServerResponse, '/donations/capture'), r.handle(req, {} as http.ServerResponse, '/donations/capture')]);
    expect(outs.map((o) => o.status)).toEqual([200, 200]);
    expect(t.pp.count('capture')).toBe(1);
    expect(await t.routes.donatedTotal(t.aliceId)).toBe(500);
  });

  it("ignores an amount, an account or a status the capture call claims", async () => {
    const t = await setup();
    const id = await t.order('3', t.alice);
    // (Bob calls capture for Alice's order, claiming it's his and bigger)
    const r = (await t.call('/donations/capture', { orderId: id, token: t.bob, userId: t.bobId, amount: '500', currency: 'USD', status: 'COMPLETED', captureId: 'MINE' }))!;
    expect(r.body).toEqual({ success: true, amount: 300, currency: 'USD', linked: true });
    expect(await t.store.byOrder(id)).toMatchObject({ user_id: t.aliceId, amount: 300, currency: 'USD', capture_id: `CAP-${id}` });
    expect(await t.routes.donatedTotal(t.bobId)).toBe(0);
    expect(await t.routes.donatedTotal(t.aliceId)).toBe(300);
  });

  it("when PayPal's captured amount differs from what was asked, PayPal's is the one recorded", async () => {
    const t = await setup();
    const id = await t.order('10', t.alice);
    t.pp.state.captureValue = '9.00';
    expect((await t.call('/donations/capture', { orderId: id }))!.body).toMatchObject({ success: true, amount: 900 });
    expect(await t.routes.donatedTotal(t.aliceId)).toBe(900);
  });

  it('an order this lobby did not make is refused without asking PayPal', async () => {
    const t = await setup();
    for (const orderId of ['SOMEONEELSES1', '', 'x', '../../v1/oauth2/token', 5, null]) {
      const r = (await t.call('/donations/capture', { orderId }))!;
      expect([400, 404]).toContain(r.status);
    }
    expect(t.pp.calls).toHaveLength(0);
  });

  it('records nothing as paid when the capture is not COMPLETED', async () => {
    const t = await setup();
    const cases: [string, number, string][] = [
      ['PENDING', 202, 'PENDING'], ['DECLINED', 402, 'FAILED'], ['INSTRUMENT_DECLINED', 402, 'CREATED'],
      ['ORDER_NOT_APPROVED', 409, 'CREATED'], ['down', 502, 'CREATED'], ['throw', 502, 'CREATED'],
    ];
    for (const [next, status, rowStatus] of cases) {
      const id = await t.order('5', t.alice);
      t.pp.state.next = next;
      const r = (await t.call('/donations/capture', { orderId: id }))!;
      expect(r.status, next).toBe(status);
      expect(r.body.success, next).toBe(false);
      expect(r.body.error, next).toBeTruthy();
      const row = (await t.store.byOrder(id))!;
      expect(row.status, next).toBe(rowStatus);
      expect(row.capture_id, next).toBeNull();
    }
    expect(await t.routes.donatedTotal(t.aliceId)).toBe(0);
    expect(await t.store.totals('USD', 10)).toEqual([]);
  });

  it('a capture whose answer was lost is recorded on the retry, from the order as PayPal has it', async () => {
    const t = await setup();
    const id = await t.order('20', t.alice);
    t.pp.state.next = 'lost';
    expect((await t.call('/donations/capture', { orderId: id }))!.status).toBe(502);
    expect(await t.routes.donatedTotal(t.aliceId)).toBe(0);
    const retry = (await t.call('/donations/capture', { orderId: id }))!;
    expect(retry.body).toEqual({ success: true, amount: 2000, currency: 'USD', linked: true });
    expect(t.pp.count('get')).toBe(1);
    expect(await t.routes.donatedTotal(t.aliceId)).toBe(2000);
  });

  it('a pending payment counts once PayPal completes it and capture is asked again', async () => {
    const t = await setup();
    const id = await t.order('5', t.alice);
    t.pp.state.next = 'PENDING';
    expect((await t.call('/donations/capture', { orderId: id }))!.body.pending).toBe(true);
    t.pp.orders.get(id)!.captureStatus = 'COMPLETED';
    expect((await t.call('/donations/capture', { orderId: id }))!.body).toMatchObject({ success: true, amount: 500 });
    expect(await t.routes.donatedTotal(t.aliceId)).toBe(500);
  });

  it('a guest donation is recorded with no account, and nothing about the payer is kept', async () => {
    const file = join(tmp(), 'donations.json');
    const t = await setup({ file });
    const id = await t.order('5');
    expect(t.pp.calls.find((c) => c.url.endsWith('/v2/checkout/orders'))!.body.purchase_units[0]).not.toHaveProperty('custom_id');
    expect((await t.call('/donations/capture', { orderId: id }))!.body).toEqual({ success: true, amount: 500, currency: 'USD', linked: false });
    const row = (await t.store.byOrder(id))!;
    expect(row).toMatchObject({ user_id: null, amount: 500, status: 'COMPLETED' });
    expect(Object.keys(row).sort()).toEqual(['amount', 'capture_id', 'completed_at', 'created_at', 'currency', 'id', 'paypal_order_id', 'status', 'user_id']);
    await t.store.close();
    const saved = readFileSync(file, 'utf8');
    for (const personal of ['payer@example.com', 'Payer', 'PAYER123', SECRET, 'tok-']) expect(saved).not.toContain(personal);
    // (And it is still there after a restart)
    expect(await new JsonDonationStore(file).byOrder(id)).toMatchObject({ status: 'COMPLETED', amount: 500 });
  });
});

describe('the support page and the owner', () => {
  it('config gives the public client id, the limits and who a donation is credited to, never the secret', async () => {
    const t = await setup();
    await t.call('/donations/capture', { orderId: await t.order('5', t.alice) });
    await t.call('/donations/capture', { orderId: await t.order('3', t.alice) });
    await t.order('20', t.alice); // (never paid: doesn't count)
    const mine = (await t.call('/donations/config', { token: t.alice }))!;
    expect(mine.status).toBe(200);
    expect(mine.body).toEqual({ success: true, enabled: true, clientId: CLIENT_ID, sandbox: true, currency: 'USD', min: MIN_AMOUNT, max: MAX_AMOUNT, presets: [300, 500, 1000, 2000], account: { username: 'alice' }, total: 800, contributorAt: 1000 });
    expect((await t.call('/donations/config', {}))!.body).toMatchObject({ account: null, total: 0 });
    expect((await t.call('/donations/config', { token: 'stale' }))!.body).toMatchObject({ account: null, total: 0 });
    expect(JSON.stringify(mine.body)).not.toContain(SECRET);
  });

  it('the report is for a caller with the admin secret: the newest donations and a total per account', async () => {
    const t = await setup();
    await t.call('/donations/capture', { orderId: await t.order('5', t.alice) });
    await t.call('/donations/capture', { orderId: await t.order('10', t.alice) });
    await t.call('/donations/capture', { orderId: await t.order('3', t.bob) });
    await t.call('/donations/capture', { orderId: await t.order('20') });
    await t.order('7', t.bob); // (never paid)
    expect((await t.call('/admin/donations', {}))!.status).toBe(403);
    expect((await t.call('/admin/donations', {}, { auth: 'wrong' }))!.status).toBe(403);
    expect((await t.call('/admin/donations', { token: t.alice }))!.status).toBe(403);
    const r = (await t.call('/admin/donations', {}, { auth: 'sssh' }))!;
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ success: true, enabled: true, currency: 'USD', total: 3800, count: 4 });
    expect(r.body.accounts).toEqual([
      { userId: null, username: null, total: 2000, count: 1 },
      { userId: t.aliceId, username: 'alice', total: 1500, count: 2 },
      { userId: t.bobId, username: 'bob', total: 300, count: 1 },
    ]);
    expect(r.body.recent.map((d: any) => [d.username, d.amount, d.status])).toEqual([[null, 2000, 'COMPLETED'], ['bob', 300, 'COMPLETED'], ['alice', 1000, 'COMPLETED'], ['alice', 500, 'COMPLETED']]);
  });

  it("a deleted account's donations stay on record without the account", async () => {
    const t = await setup();
    await t.call('/donations/capture', { orderId: await t.order('5', t.alice) });
    t.routes.forgetUser(t.aliceId);
    await new Promise((r) => setTimeout(r, 0));
    expect(await t.routes.donatedTotal(t.aliceId)).toBe(0);
    expect(await t.store.totals('USD', 10)).toEqual([{ user_id: null, total: 500, count: 1 }]);
  });

  it('orders nobody paid are dropped after a week; paid ones never', async () => {
    const t = await setup();
    const paid = await t.order('5', t.alice);
    await t.call('/donations/capture', { orderId: paid });
    const unpaid = await t.order('5', t.alice);
    t.tick(8 * 24 * 60 * 60_000);
    await t.order('3');
    await new Promise((r) => setTimeout(r, 0));
    expect(await t.store.byOrder(unpaid)).toBeNull();
    expect(await t.store.byOrder(paid)).toMatchObject({ status: 'COMPLETED' });
  });
});

describe("a pilot's own history", () => {
  it('lists only the session\'s own donations, newest first, with the total; never the unpaid orders or another account', async () => {
    const t = await setup();
    await t.call('/donations/capture', { orderId: await t.order('5', t.alice) });
    await t.call('/donations/capture', { orderId: await t.order('7.50', t.alice) });
    await t.order('20', t.alice); // (never paid)
    await t.call('/donations/capture', { orderId: await t.order('3', t.bob) });
    await t.call('/donations/capture', { orderId: await t.order('10') }); // (a guest's)
    const pendingId = await t.order('4', t.alice);
    t.pp.state.next = 'PENDING';
    await t.call('/donations/capture', { orderId: pendingId });

    const mine = (await t.call('/donations/mine', { token: t.alice }))!;
    expect(mine.status).toBe(200);
    expect(mine.body).toMatchObject({ success: true, currency: 'USD', total: 1250 });
    expect(mine.body.donations.map((d: any) => [d.amount, d.status, d.reference])).toEqual([[400, 'PENDING', null], [750, 'COMPLETED', 'CAP-ORDER0002'], [500, 'COMPLETED', 'CAP-ORDER0001']]);
    expect(Object.keys(mine.body.donations[0]).sort()).toEqual(['amount', 'at', 'currency', 'id', 'reference', 'status']);
    // (Asking for someone else's changes nothing: the session decides)
    const bobs = (await t.call('/donations/mine', { token: t.bob, userId: t.aliceId, username: 'alice', account: t.aliceId }))!;
    expect(bobs.body.total).toBe(300);
    expect(bobs.body.donations.map((d: any) => d.amount)).toEqual([300]);
  });

  it('no session, or one that is not valid, is a 401 with no rows', async () => {
    const t = await setup();
    await t.call('/donations/capture', { orderId: await t.order('5', t.alice) });
    for (const body of [{}, { token: '' }, { token: 'not-a-session' }, { token: 5 }, { userId: t.aliceId }]) {
      const r = (await t.call('/donations/mine', body))!;
      expect(r.status).toBe(401);
      expect(r.body).not.toHaveProperty('donations');
    }
  });

  it('is still readable while PayPal is off', async () => {
    const t = await setup({ off: true });
    expect((await t.call('/donations/mine', { token: t.alice }))!.body).toMatchObject({ success: true, total: 0, donations: [] });
  });
});

describe('the thank-you message', () => {
  const settle = () => new Promise((r) => setTimeout(r, 5));

  it('a completed donation puts one thank-you in the donor\'s inbox, read through the game\'s own inbox call', async () => {
    const t = await setup();
    await t.call('/donations/capture', { orderId: await t.order('7.50', t.alice) });
    await settle();
    const box = await t.mail(t.alice);
    expect(box.unread).toBe(1);
    expect(box.unreadImportant).toBe(0);
    expect(box.messages).toHaveLength(1);
    expect(box.messages[0]).toMatchObject({ from: 'system', subject: 'Thank you for supporting the game', important: false, readAt: null });
    expect(box.messages[0].body).toContain('$7.50');
    expect((await t.mail(t.bob)).messages).toEqual([]);
  });

  it('capturing again, twice at once, or after a restart never sends a second one', async () => {
    const t = await setup();
    const id = await t.order('5', t.alice);
    const req = { method: 'POST', headers: {} } as unknown as http.IncomingMessage;
    // (Two capture calls at once, on routes that share nothing but the store and PayPal: as two lobby requests would)
    const outs: number[] = [];
    const twin = await DonationRoutes.create(t.users, (_, status) => { outs.push(status); }, async () => ({ orderId: id }), () => '3.3.3.3',
      { store: t.store, paypal: (t.routes as any).paypal, adminSecret: 'sssh', dataDir: tmp(), onCompleted: (d) => { t.thanked.push(d); } });
    await Promise.all([twin.handle(req, {} as http.ServerResponse, '/donations/capture'), twin.handle(req, {} as http.ServerResponse, '/donations/capture'), t.call('/donations/capture', { orderId: id })]);
    await t.call('/donations/capture', { orderId: id });
    await t.call('/donations/capture', { orderId: id });
    await settle();
    expect(t.thanked).toEqual([{ userId: t.aliceId, amount: 500, currency: 'USD', crossed: false }]);
  });

  it('the store gives `first` to one completion only', async () => {
    const store = new JsonDonationStore(null);
    await store.create({ user_id: 1, amount: 500, currency: 'USD', paypal_order_id: 'O1', created_at: 1 });
    const cap = { capture_id: 'C1', amount: 500, currency: 'USD', at: 2 };
    const all = await Promise.all([store.complete('O1', cap), store.complete('O1', cap), store.complete('O1', cap)]);
    expect(all.map((r) => r!.first)).toEqual([true, false, false]);
    expect(await store.complete('NOPE', cap)).toBeNull();
  });

  it('a guest donation, or one that did not complete, sends none', async () => {
    const t = await setup();
    await t.call('/donations/capture', { orderId: await t.order('5') });
    for (const next of ['PENDING', 'DECLINED', 'INSTRUMENT_DECLINED', 'ORDER_NOT_APPROVED', 'down', 'throw']) {
      const id = await t.order('5', t.alice);
      t.pp.state.next = next;
      await t.call('/donations/capture', { orderId: id });
    }
    await settle();
    expect(t.thanked).toEqual([]);
    expect((await t.mail(t.alice)).messages).toEqual([]);
  });

  it('a payment held as pending is thanked once, when it completes', async () => {
    const t = await setup();
    const id = await t.order('5', t.alice);
    t.pp.state.next = 'PENDING';
    await t.call('/donations/capture', { orderId: id });
    expect(t.thanked).toHaveLength(0);
    t.pp.orders.get(id)!.captureStatus = 'COMPLETED';
    await t.call('/donations/capture', { orderId: id });
    await t.call('/donations/capture', { orderId: id });
    await settle();
    expect(t.thanked).toHaveLength(1);
    expect((await t.mail(t.alice)).messages).toHaveLength(1);
  });

  it('a thank-you that fails never fails the capture', async () => {
    const t = await setup();
    const id = await t.order('5', t.alice);
    let out: any = null;
    const r = await DonationRoutes.create(t.users, (_, status, b) => { out = { status, body: b }; }, async () => ({ orderId: id }), () => '4.4.4.4',
      { store: t.store, paypal: (t.routes as any).paypal, adminSecret: 'sssh', dataDir: tmp(), onCompleted: async () => { throw new Error('inbox down'); } });
    await r.handle({ method: 'POST', headers: {} } as unknown as http.IncomingMessage, {} as http.ServerResponse, '/donations/capture');
    await settle();
    expect(out).toMatchObject({ status: 200, body: { success: true, amount: 500 } });
    expect(await t.routes.donatedTotal(t.aliceId)).toBe(500);
  });

  it('is short and plain, names the amount and promises nothing', () => {
    const m = thankYouMessage(1905, 'USD');
    expect(m.subject).toBe('Thank you for supporting the game');
    expect(m.body).toContain('$19.05');
    expect(m.body).not.toMatch(/perk|reward|bonus|unlock/i);
    expect(m.body.length).toBeLessThan(300);
    expect(thankYouMessage(1905, 'USD', true).body.length).toBeLessThan(700);
    expect(moneyText(500, 'USD')).toBe('$5');
    expect(moneyText(550, 'EUR')).toBe('5.50 EUR');
  });

  it('an account that is gone gets no message and nothing throws', async () => {
    const t = await setup();
    expect(await t.inbox.systemMessage(999_999, 'Hi', 'There')).toBe(false);
  });
});

describe('the contributor rank by donating', () => {
  const settle = () => new Promise((r) => setTimeout(r, 5));
  const pay = async (t: Awaited<ReturnType<typeof setup>>, amount: string, token?: string) => t.call('/donations/capture', { orderId: await t.order(amount, token) });
  const rankMail = async (t: Awaited<ReturnType<typeof setup>>, token: string) => (await t.mail(token)).messages.filter((m) => /contributor rank/.test(m.body));

  it('the line is $10 in all', () => {
    expect(CONTRIBUTOR_AT).toBe(1000);
  });

  it('below the line: no rank, nothing told to the game servers, a plain thank-you', async () => {
    const t = await setup();
    await pay(t, '9.99', t.alice);
    await settle();
    expect(await t.routes.earnsContributor(t.aliceId)).toBe(false);
    expect(t.routes.newContributors()).toEqual([]);
    expect(t.thanked).toEqual([{ userId: t.aliceId, amount: 999, currency: 'USD', crossed: false }]);
    expect(await rankMail(t, t.alice)).toEqual([]);
  });

  it('one donation of $10 or more earns it: the servers are told and the thank-you says so, with the real key', async () => {
    const t = await setup();
    await pay(t, '20', t.alice);
    await settle();
    expect(await t.routes.earnsContributor(t.aliceId)).toBe(true);
    expect(await t.routes.earnsContributor(t.bobId)).toBe(false);
    expect(t.routes.newContributors()).toEqual([t.aliceId]);
    expect(t.thanked).toEqual([{ userId: t.aliceId, amount: 2000, currency: 'USD', crossed: true }]);
    const mail = await rankMail(t, t.alice);
    expect(mail).toHaveLength(1);
    expect(mail[0].body).toContain('$20');
    expect(mail[0].body).toContain('press F6');
    expect(mail[0].subject).toBe('Thank you for supporting the game');
  });

  it('exactly $10 earns it', async () => {
    const t = await setup();
    await pay(t, '10', t.alice);
    await settle();
    expect(await t.routes.earnsContributor(t.aliceId)).toBe(true);
    expect(t.thanked[0].crossed).toBe(true);
  });

  it('small donations add up: the one that crosses the line is the one that says so, and later ones do not', async () => {
    const t = await setup();
    await pay(t, '3', t.alice);
    await pay(t, '3', t.alice);
    await settle();
    expect(await t.routes.earnsContributor(t.aliceId)).toBe(false);
    expect(t.routes.newContributors()).toEqual([]);
    await pay(t, '4', t.alice);
    await settle();
    expect(await t.routes.earnsContributor(t.aliceId)).toBe(true);
    await pay(t, '50', t.alice);
    await settle();
    expect(t.thanked.map((d) => d.crossed)).toEqual([false, false, true, false]);
    const box = await t.mail(t.alice);
    expect(box.messages).toHaveLength(4);
    const withRank = box.messages.filter((m) => /contributor rank/.test(m.body));
    expect(withRank).toHaveLength(1);
    expect(withRank[0].body).toContain('$4');
  });

  it('a guest donation never earns it for anyone, however large', async () => {
    const t = await setup();
    await pay(t, '500');
    await settle();
    expect(t.routes.newContributors()).toEqual([]);
    expect(await t.routes.earnsContributor(t.aliceId)).toBe(false);
    expect(t.thanked).toEqual([]);
  });

  it('a payment that did not complete earns nothing', async () => {
    const t = await setup();
    for (const next of ['PENDING', 'DECLINED', 'down']) {
      const id = await t.order('50', t.alice);
      t.pp.state.next = next;
      await t.call('/donations/capture', { orderId: id });
    }
    await settle();
    expect(await t.routes.earnsContributor(t.aliceId)).toBe(false);
    expect(t.routes.newContributors()).toEqual([]);
  });

  it('a capture replayed or made twice at once grants once and sends one message with the rank paragraph', async () => {
    const t = await setup();
    const id = await t.order('10', t.alice);
    const req = { method: 'POST', headers: {} } as unknown as http.IncomingMessage;
    const twin = await DonationRoutes.create(t.users, () => {}, async () => ({ orderId: id }), () => '3.3.3.3',
      { store: t.store, paypal: (t.routes as any).paypal, adminSecret: 'sssh', dataDir: tmp(), onCompleted: (d) => { t.thanked.push(d); } });
    await Promise.all([twin.handle(req, {} as http.ServerResponse, '/donations/capture'), twin.handle(req, {} as http.ServerResponse, '/donations/capture'), t.call('/donations/capture', { orderId: id })]);
    await t.call('/donations/capture', { orderId: id });
    await settle();
    expect(t.thanked).toEqual([{ userId: t.aliceId, amount: 1000, currency: 'USD', crossed: true }]);
  });

  it('two different donations finishing at the same moment: exactly one is the crossing one', async () => {
    const t = await setup();
    const a = await t.order('6', t.alice), b = await t.order('6', t.alice);
    const req = { method: 'POST', headers: {} } as unknown as http.IncomingMessage;
    let n = 0;
    const both = await DonationRoutes.create(t.users, () => {}, async () => ({ orderId: n++ === 0 ? a : b }), () => '3.3.3.4',
      { store: t.store, paypal: (t.routes as any).paypal, adminSecret: 'sssh', dataDir: tmp(), onCompleted: (d) => { t.thanked.push(d); } });
    await Promise.all([both.handle(req, {} as http.ServerResponse, '/donations/capture'), both.handle(req, {} as http.ServerResponse, '/donations/capture')]);
    await settle();
    expect(t.thanked.map((d) => d.crossed).sort()).toEqual([false, true]);
    expect(both.newContributors()).toEqual([t.aliceId]);
  });

  it('the servers are told for a minute; after that the support page being opened tells them again (a missed grant heals)', async () => {
    const t = await setup();
    await pay(t, '10', t.alice);
    await pay(t, '5', t.bob);
    expect(t.routes.newContributors()).toEqual([t.aliceId]);
    t.tick(61_000);
    expect(t.routes.newContributors()).toEqual([]);
    await t.call('/donations/config', { token: t.bob });
    await t.call('/donations/config', {});
    expect(t.routes.newContributors()).toEqual([]);
    const cfg = (await t.call('/donations/config', { token: t.alice }))!.body;
    expect(cfg).toMatchObject({ total: 1000, contributorAt: 1000 });
    expect(t.routes.newContributors()).toEqual([t.aliceId]);
    // (Still earned, however long ago: nothing here ever takes it back)
    t.tick(365 * 24 * 60 * 60_000);
    expect(await t.routes.earnsContributor(t.aliceId)).toBe(true);
  });

  it("a game server checking a session is told the account earns the rank (and nothing for one that doesn't)", async () => {
    const t = await setup();
    await pay(t, '10', t.alice);
    let body: object = {};
    let out: any = null;
    const accounts = await AccountRoutes.create((_, status, b) => { out = { status, body: b }; }, async () => body, () => '127.0.0.1', { store: t.users, adminSecret: 'sssh' });
    // (As the lobby wires it: server-browser/src/index.ts)
    accounts.validateExtra = async (user) => ((await t.routes.earnsContributor(user.id)) ? { donorContributor: true } : {});
    const validate = async (token: string) => { body = { token }; await accounts.handle({ method: 'POST', headers: {} } as unknown as http.IncomingMessage, {} as http.ServerResponse, '/auth/validate'); return out; };
    expect((await validate(t.alice)).body).toMatchObject({ success: true, id: t.aliceId, username: 'alice', isAdmin: false, donorContributor: true });
    expect((await validate(t.bob)).body).not.toHaveProperty('donorContributor');
    // (The extra can't replace what validate itself says, and its failing doesn't fail the sign-in)
    accounts.validateExtra = async () => ({ id: 999, isAdmin: true, isOwner: true, success: false, username: 'boss' });
    expect((await validate(t.bob)).body).toEqual({ success: true, id: t.bobId, username: 'bob', isAdmin: false, isOwner: false });
    accounts.validateExtra = async () => { throw new Error('donations down'); };
    expect((await validate(t.bob))).toMatchObject({ status: 200, body: { success: true, id: t.bobId } });
  });

  it('the history says where the line is', async () => {
    const t = await setup();
    await pay(t, '4', t.alice);
    expect((await t.call('/donations/mine', { token: t.alice }))!.body).toMatchObject({ total: 400, contributorAt: 1000 });
  });

  it('the rank paragraph is only in the crossing message, and promises nothing else', () => {
    expect(thankYouMessage(500, 'USD').body).not.toMatch(/contributor/);
    expect(thankYouMessage(500, 'USD', false).body).not.toMatch(/contributor/);
    const m = thankYouMessage(1000, 'USD', true);
    expect(m.body).toContain('You now have the contributor rank.');
    expect(m.body).toContain('press F6');
    expect(m.body.split('\n\n')).toHaveLength(3);
  });
});

describe('donations switched off', () => {
  it('without PayPal keys every call answers 503, PayPal is never called and the report still reads', async () => {
    const t = await setup({ off: true });
    expect(t.routes.enabled).toBe(false);
    for (const [url, body] of [['/donations/config', { token: t.alice }], ['/donations/create', { amount: '5' }], ['/donations/capture', { orderId: 'ORDER0001' }]] as const) {
      const r = (await t.call(url, body))!;
      expect(r.status, url).toBe(503);
      expect(r.body).toMatchObject({ success: false, enabled: false });
    }
    expect(t.pp.calls).toHaveLength(0);
    expect((await t.call('/admin/donations', {}, { auth: 'sssh' }))!.body).toMatchObject({ success: true, enabled: false, total: 0 });
    // (Other paths are left to the rest of the lobby)
    expect(await t.call('/donations/other', {})).toBeNull();
    expect(await t.call('/auth/login', {})).toBeNull();
  });

  it('no keys, or keys for the wrong PayPal, means no client (and the reason never holds a value)', () => {
    const none = () => ({});
    const keys = { PAYPAL_CLIENT_ID: CLIENT_ID, PAYPAL_CLIENT_SECRET: SECRET };
    expect(paypalConfig({}, none).config).toBeNull();
    expect(paypalConfig({ PAYPAL_CLIENT_ID: CLIENT_ID }, none).config).toBeNull();
    expect(paypalConfig({ ...keys, PAYPAL_ENV: 'sandbox' }, none).config).toEqual({ env: 'sandbox', clientId: CLIENT_ID, secret: SECRET });
    expect(paypalConfig({ ...keys }, none).config?.env).toBe('sandbox');
    expect(paypalConfig({ ...keys, PAYPAL_ENV: 'LIVE', NODE_ENV: 'production' }, none).config?.env).toBe('live');
    // (Test keys on the live box, live keys on a dev machine, a typo: all off)
    for (const env of [{ ...keys, PAYPAL_ENV: 'sandbox', NODE_ENV: 'production' }, { ...keys, NODE_ENV: 'production' }, { ...keys, PAYPAL_ENV: 'live' }, { ...keys, PAYPAL_ENV: 'prod' }]) {
      const r = paypalConfig(env, none);
      expect(r.config).toBeNull();
      expect(r.reason).toBeTruthy();
      expect(r.reason).not.toContain(SECRET);
      expect(r.reason).not.toContain(CLIENT_ID);
    }
  });

  it('outside production the keys may come from the git-ignored .env; production never reads it', () => {
    const file = () => ({ PAYPAL_ENV: 'sandbox', PAYPAL_CLIENT_ID: CLIENT_ID, PAYPAL_CLIENT_SECRET: SECRET });
    expect(paypalConfig({}, file).config).toEqual({ env: 'sandbox', clientId: CLIENT_ID, secret: SECRET });
    let read = false;
    expect(paypalConfig({ NODE_ENV: 'production' }, () => { read = true; return file(); }).config).toBeNull();
    expect(read).toBe(false);
  });
});

describe('the PayPal client', () => {
  it('asks for a token once and reuses it until it is about to expire', async () => {
    const pp = fakePayPal();
    let clock = 0;
    const client = new PayPalClient({ env: 'sandbox', clientId: CLIENT_ID, secret: SECRET }, pp.fetchFn, () => clock);
    const make = () => client.createOrder({ amountMinor: 500, currency: 'USD', description: 'd', brand: 'b', requestId: 'r' });
    await Promise.all([make(), make()]);
    await make();
    expect(pp.count('token')).toBe(1);
    clock += 3600_000 - 30_000;
    await make();
    expect(pp.count('token')).toBe(2);
    // (The secret goes to the token endpoint only, the token to the API only)
    for (const c of pp.calls) {
      const isToken = c.url.endsWith('/v1/oauth2/token');
      expect(c.headers.Authorization.startsWith(isToken ? 'Basic ' : 'Bearer ')).toBe(true);
      expect(JSON.stringify(c.body ?? '')).not.toContain(SECRET);
    }
  });

  it('a token PayPal stops taking is replaced once and the call retried', async () => {
    const pp = fakePayPal();
    const client = new PayPalClient({ env: 'sandbox', clientId: CLIENT_ID, secret: SECRET }, pp.fetchFn);
    await client.createOrder({ amountMinor: 500, currency: 'USD', description: 'd', brand: 'b', requestId: 'r' });
    pp.state.tokens++; // (PayPal now only takes a newer token)
    await client.createOrder({ amountMinor: 500, currency: 'USD', description: 'd', brand: 'b', requestId: 'r2' });
    expect(pp.count('token')).toBe(2);
    expect(pp.orders.size).toBe(2);
  });

  it('live keys call the live API, sandbox keys the sandbox', async () => {
    const pp = fakePayPal();
    await new PayPalClient({ env: 'live', clientId: CLIENT_ID, secret: SECRET }, pp.fetchFn).getOrder('X').catch(() => {});
    expect(pp.calls.every((c) => c.url.startsWith('https://api-m.paypal.com/'))).toBe(true);
  });

  it('an error never carries the secret, the token or a request header', async () => {
    const pp = fakePayPal();
    const errors: unknown[] = [];
    // Wrong secret: PayPal refuses the token
    await new PayPalClient({ env: 'sandbox', clientId: CLIENT_ID, secret: 'wrong-secret-value' }, pp.fetchFn).getOrder('X').catch((e) => errors.push(e));
    // The network throws an error that quotes the request
    const throwing = async (_url: string, init: { headers: Record<string, string> }) => { throw new Error(`failed: ${JSON.stringify(init.headers)}`); };
    await new PayPalClient({ env: 'sandbox', clientId: CLIENT_ID, secret: SECRET }, throwing as any).getOrder('X').catch((e) => errors.push(e));
    // PayPal answers with an error body that echoes things back
    const echo = async (url: string, init: { headers: Record<string, string> }) => url.endsWith('/token')
      ? { status: 200, ok: true, text: async () => JSON.stringify({ access_token: 'tok-secret-token', expires_in: 60 }) }
      : { status: 400, ok: false, text: async () => JSON.stringify({ name: `BAD ${init.headers.Authorization}`, message: init.headers.Authorization, details: [{ issue: 'SOME_ISSUE', description: SECRET }], debug_id: 'abc123' }) };
    await new PayPalClient({ env: 'sandbox', clientId: CLIENT_ID, secret: SECRET }, echo as any).getOrder('X').catch((e) => errors.push(e));
    expect(errors).toHaveLength(3);
    for (const e of errors) {
      expect(e).toBeInstanceOf(PayPalError);
      const text = `${(e as Error).message} ${JSON.stringify(e)} ${(e as Error).stack}`;
      for (const hidden of [SECRET, 'wrong-secret-value', 'tok-secret-token', 'Basic ', 'Bearer ', Buffer.from(`${CLIENT_ID}:${SECRET}`).toString('base64')]) expect(text).not.toContain(hidden);
    }
    expect((errors[2] as PayPalError).issue).toBe('SOME_ISSUE');
    expect((errors[1] as PayPalError).status).toBe(0);
  });
});

describe('donations in Postgres', () => {
  function fakePool(answer: (sql: string, params: any[]) => any[] = () => []) {
    const queries: { sql: string; params: any[] }[] = [];
    return { queries, query: async (sql: string, params: any[] = []) => { queries.push({ sql, params }); return { rows: answer(sql, params) }; } };
  }

  it('the migration only adds: IF NOT EXISTS statements, run at every start, the same ones schema.sql has', async () => {
    // (A database that already has the lobby's tables and rows: the statements are all it gets)
    const pool = fakePool();
    await PostgresDonationStore.create(pool);
    await PostgresDonationStore.create(pool);
    expect(pool.queries.map((q) => q.sql)).toEqual([...DONATIONS_SCHEMA, ...DONATIONS_SCHEMA]);
    for (const sql of DONATIONS_SCHEMA) {
      expect(sql).toMatch(/^CREATE (TABLE|INDEX) IF NOT EXISTS /);
      expect(sql).not.toContain(';'); // (one statement each)
    }
    const table = DONATIONS_SCHEMA[0];
    expect(table).toMatch(/user_id\s+BIGINT REFERENCES users\(id\) ON DELETE SET NULL/);
    expect(table).toMatch(/paypal_order_id\s+TEXT NOT NULL UNIQUE/);
    expect(table).toMatch(/capture_id\s+TEXT UNIQUE/);
    const squash = (s: string) => s.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').replace(/\s*([(),])\s*/g, '$1').trim();
    const schemaSql = squash(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../schema.sql'), 'utf8'));
    for (const sql of DONATIONS_SCHEMA) expect(schemaSql).toContain(squash(sql));
  });

  it("a database user who can't make the table gets told what to run", async () => {
    await expect(PostgresDonationStore.create({ query: async () => { throw new Error('permission denied'); } })).rejects.toThrow(/schema\.sql/);
  });

  it('completing an order never touches a row that is already COMPLETED, and totals count COMPLETED rows only', async () => {
    const row = { id: '4', user_id: '3', amount: '500', currency: 'USD', paypal_order_id: 'O1', capture_id: 'C1', status: 'COMPLETED', created_at: '5', completed_at: '6' };
    const pool = fakePool((sql) => (sql.startsWith('SELECT COALESCE') ? [{ total: '1500' }] : sql.startsWith('SELECT id') ? [row] : sql.startsWith('SELECT user_id') ? [{ user_id: null, total: '700', count: '2' }] : []));
    const store = await PostgresDonationStore.create(pool);
    const { row: done, first } = (await store.complete('O1', { capture_id: 'C1', amount: 500, currency: 'USD', at: 6 }))!;
    expect(first).toBe(false); // (the UPDATE changed nothing: it was already COMPLETED)
    expect(done).toEqual({ id: 4, user_id: 3, amount: 500, currency: 'USD', paypal_order_id: 'O1', capture_id: 'C1', status: 'COMPLETED', created_at: 5, completed_at: 6 });
    const update = pool.queries.find((q) => q.sql.startsWith('UPDATE'))!;
    expect(update.sql).toMatch(/WHERE paypal_order_id = \$1 AND status <> 'COMPLETED'/);
    expect(await store.totalFor(3, 'USD')).toBe(1500);
    expect(await store.totals('USD', 10)).toEqual([{ user_id: null, total: 700, count: 2 }]);
    await store.setStatus('O1', 'FAILED');
    await store.pruneUnpaid(1);
    for (const q of pool.queries.slice(DONATIONS_SCHEMA.length)) {
      if (/SUM\(amount\)/.test(q.sql)) expect(q.sql).toMatch(/status = 'COMPLETED'/);
      if (/^(UPDATE|DELETE)/.test(q.sql)) expect(q.sql).toMatch(/status (<> 'COMPLETED'|= 'CREATED')/);
    }
  });
});
