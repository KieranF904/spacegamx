/**
 * @contract lobby.donations.routes
 * owns:       donations through PayPal: making an order for a checked amount, capturing it, the record of each one
 *             against the account that made it, an account's total and own history, the owner's report, and the
 *             thank-you's wording (the inbox sends it: ../index.ts); who has donated enough for the contributor rank
 *             (CONTRIBUTOR_AT), told to the game servers, which grant it
 * needs:      UserStore (sessions, usernames), DonationStore, ./paypal (PayPalClient, PayPalError), accounts/RateLimiter + utils
 * invariants: an amount outside the limits, with more than two decimals or in another currency makes no order — server-browser/src/donations/donations.test.ts
 *             the account credited is the session that made the order, whatever the capture call claims — server-browser/src/donations/donations.test.ts
 *             a donation is recorded only from PayPal's capture answer, and only when it is COMPLETED — server-browser/src/donations/donations.test.ts
 *             capturing the same order twice records and counts it once — server-browser/src/donations/donations.test.ts
 *             a guest's donation is recorded with no account — server-browser/src/donations/donations.test.ts
 *             without PayPal keys every /donations/ call answers 503 and PayPal is never called — server-browser/src/donations/donations.test.ts
 *             only a caller with LOBBY_ADMIN_SECRET reads the report — server-browser/src/donations/donations.test.ts
 *             a pilot reads only their own donations, by their session; no session is a 401 — server-browser/src/donations/donations.test.ts
 *             a donation that completes for an account is thanked exactly once; a guest's or an unfinished one never — server-browser/src/donations/donations.test.ts
 *             an account earns the contributor rank when its completed donations reach CONTRIBUTOR_AT, a guest's never count, and exactly one donation is the crossing one — server-browser/src/donations/donations.test.ts
 * extend:     a new route is one case in handle(); a perk asks donatedTotal(accountId)
 *
 *   POST /donations/config  { token? }
 *        -> { success, enabled: true, clientId, sandbox, currency, min, max, presets, account: { username } | null, total }
 *        What the support page needs: PayPal's public client id, the limits (minor units), and who a donation would be
 *        credited to. `total` is what that account has given so far (minor units; 0 for a guest).
 *   POST /donations/create  { token?, amount }   -> { success, orderId }
 *        `amount` is dollars ("5", "7.50" or a number). With a token the order is tied to that account here, in the
 *        lobby's own row; a token that isn't a session is refused (401) rather than quietly making a guest donation.
 *   POST /donations/capture { orderId }          -> { success, amount, currency, linked }
 *        Only for an order this lobby made. The amount, currency and status come from PayPal's answer, never from the
 *        caller. An order already recorded answers the same without asking PayPal again.
 *   POST /donations/mine    { token }            -> { success, currency, total, donations: [{ id, amount, currency, status, at, reference }] }
 *        The session's own donations, newest first (not the orders nobody paid). `reference` is PayPal's transaction
 *        id, as on the donor's PayPal receipt. Works while PayPal is off. No session: 401.
 *   POST /admin/donations   {}                   -> { success, enabled, currency, total, count, recent: [...], accounts: [...] }
 *        `Authorization: Bearer <LOBBY_ADMIN_SECRET>` (the website's admin panel; nginx doesn't pass /admin/ through).
 *
 * No cookies: like /auth/* the session token rides in the body, so another site can't act as a signed-in pilot.
 * Nothing about the payer is kept (see types.ts), and no card or PayPal login detail ever reaches this server.
 */

import crypto from 'crypto';
import http from 'http';
import path from 'path';
import type { UserStore } from '../accounts/types.js';
import { safeEqual } from '../accounts/utils.js';
import { RateLimiter } from '../accounts/RateLimiter.js';
import { createDonationStore } from './index.js';
import { PayPalClient, PayPalError, paypalConfig, type CaptureResult } from './paypal.js';
import type { DonationRecord, DonationStore } from './types.js';

type Json = (res: http.ServerResponse, status: number, body: unknown) => void;
type Body = (req: http.IncomingMessage) => Promise<any>;
type Out = { status: number; body: Record<string, unknown> };
/** Called once for each donation that completes for an account (never for a guest's): the lobby sends the thank-you */
export type OnCompleted = (donation: { userId: number; amount: number; currency: string; crossed: boolean }) => void | Promise<void>;

export const CURRENCY = 'USD';
/** Smallest and largest single donation, and the amounts the page offers (minor units: cents) */
export const MIN_AMOUNT = 100;
export const MAX_AMOUNT = 50_000;
export const PRESETS = [300, 500, 1000, 2000];
/**
 * An account whose completed donations add up to this much (cents, all of them together) has the contributor rank.
 * The lobby only says who qualifies: the game server grants it (server/src/game/ContributorNotes.ts grantDonor).
 */
export const CONTRIBUTOR_AT = 1000;
/** How long a newly qualified account stays in the game servers' heartbeat answers (they ask every 10 s) */
const ANNOUNCE_MS = 60_000;
/** Donation calls per address a minute, and orders made per address per 10 minutes */
export const IP_LIMIT = 40;
export const CREATE_LIMIT = 8;
/** Orders nobody paid are dropped after this long (PayPal has let them lapse well before) */
const UNPAID_KEEP_MS = 7 * 24 * 60 * 60_000;
const PRUNE_EVERY_MS = 24 * 60 * 60_000;
const RECENT_MAX = 100;
const MINE_MAX = 100;
const ACCOUNTS_MAX = 200;
const BRAND = 'Space Game';
const SLOW_DOWN = 'Too many requests. Wait a minute and try again.';
const OFF = 'Donations are unavailable right now';

/**
 * Dollars, as the page sends them, to whole cents: a number or a plain decimal string with at most two decimals.
 * Null for anything else (a negative, an exponent, three decimals, text).
 */
export function parseAmount(v: unknown): number | null {
  const s = typeof v === 'number' && Number.isFinite(v) ? String(v) : typeof v === 'string' ? v.trim() : '';
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

function bodyStatus(err: unknown): number {
  return (err as { status?: unknown })?.status === 413 ? 413 : 400;
}

export class DonationRoutes {
  private perIp: RateLimiter;
  private creates: RateLimiter;
  /** Captures under way, by order id: a double click waits for the first */
  private capturing = new Map<string, Promise<Out>>();
  private prunedAt = 0;
  /** Accounts that just qualified for the contributor rank, and until when the game servers are told */
  private announced = new Map<number, number>();
  /** Completions under way, by account: one at a time, so two donations at once can't both look like the crossing one */
  private completing = new Map<number, Promise<unknown>>();

  private constructor(readonly store: DonationStore | null, private paypal: PayPalClient | null, private users: UserStore, private sendJson: Json,
    private parseJson: Body, private ipOf: (req: http.IncomingMessage) => string, private adminSecret: string, private now: () => number,
    private onCompleted: OnCompleted | null) {
    this.perIp = new RateLimiter(IP_LIMIT, 60_000, 10_000, now);
    this.creates = new RateLimiter(CREATE_LIMIT, 10 * 60_000, 10_000, now);
  }

  /**
   * (Tests pass their own store, PayPal client and clock.) `paypal` left out: made from the environment's keys, and
   * null (donations off, the lobby still starts) when there are none.
   */
  static async create(users: UserStore, sendJson: Json, parseJson: Body, ipOf: (req: http.IncomingMessage) => string,
    opts: { store?: DonationStore; paypal?: PayPalClient | null; adminSecret: string; dataDir: string; now?: () => number; onCompleted?: OnCompleted }): Promise<DonationRoutes> {
    let store: DonationStore | null = opts.store ?? null;
    // (No donations is better than no lobby)
    if (!store) {
      try { store = await createDonationStore(users, path.join(opts.dataDir, 'donations.json')); } catch (err) { console.error('[Donations] off:', (err as Error).message); }
    }
    let paypal = opts.paypal;
    if (paypal === undefined) {
      const { config, reason } = paypalConfig();
      paypal = config ? new PayPalClient(config) : null;
      console.log(config ? `[Donations] on (PayPal ${config.env})` : `[Donations] off: ${reason}`);
    }
    return new DonationRoutes(store, paypal, users, sendJson, parseJson, ipOf, opts.adminSecret, opts.now ?? Date.now, opts.onCompleted ?? null);
  }

  /** Taking donations (keys set, records can be kept) */
  get enabled(): boolean {
    return !!this.store && !!this.paypal;
  }

  /**
   * What an account has donated in total, in cents (completed donations only). For perks: ask this, never the page.
   * 0 for an account that hasn't, and while the records can't be read.
   */
  async donatedTotal(accountId: number): Promise<number> {
    if (!this.store) return 0;
    return this.store.totalFor(accountId, CURRENCY);
  }

  /** Do this account's completed donations earn the contributor rank (false while the records can't be read) */
  async earnsContributor(accountId: number): Promise<boolean> {
    try { return (await this.donatedTotal(accountId)) >= CONTRIBUTOR_AT; } catch { return false; }
  }

  /**
   * Accounts that qualified in the last minute, for the game servers' heartbeat answer: a pilot who is on gets the rank
   * without signing in again. Telling a server twice does nothing (its grant is once per account).
   */
  newContributors(): number[] {
    const t = this.now();
    for (const [id, until] of this.announced) if (until <= t) this.announced.delete(id);
    return [...this.announced.keys()];
  }

  /** Handles /donations/* and /admin/donations (true when it did) */
  async handle(req: http.IncomingMessage, res: http.ServerResponse, url: string): Promise<boolean> {
    if (req.method !== 'POST') return false;
    if (url === '/admin/donations') { await this.report(req, res); return true; }
    if (!url.startsWith('/donations/')) return false;
    const action = url.slice('/donations/'.length);
    if (action !== 'config' && action !== 'create' && action !== 'capture' && action !== 'mine') return false;
    if (!this.perIp.hit(this.ipOf(req))) { this.sendJson(res, 429, { success: false, error: SLOW_DOWN }); return true; }
    const store = this.store, paypal = this.paypal;
    // (A pilot's own history needs the records only, not PayPal)
    if (action === 'mine') { await this.mine(req, res); return true; }
    if (!store || !paypal) { this.sendJson(res, 503, { success: false, enabled: false, error: OFF }); return true; }
    let body: any;
    try { body = await this.parseJson(req); } catch (err) { this.sendJson(res, bodyStatus(err), { success: false, error: 'Invalid request' }); return true; }

    let out: Out;
    try {
      out = action === 'config' ? await this.config(store, paypal, body)
        : action === 'create' ? await this.createOrder(store, paypal, body, this.ipOf(req))
        : await this.capture(store, paypal, body);
    } catch (err) {
      // (Only a message this file or paypal.ts made: neither holds a key)
      console.error(`[Donations] ${action} failed:`, err instanceof PayPalError ? err.message : err);
      out = { status: 500, body: { success: false, error: 'Something went wrong. Try again in a moment.' } };
    }
    this.sendJson(res, out.status, out.body);
    return true;
  }

  /** The session a call names: null for none (a guest), 'bad' for a token that isn't a session */
  private async account(body: any): Promise<{ id: number; username: string } | null | 'bad'> {
    const token = typeof body?.token === 'string' ? body.token : '';
    if (!token) return null;
    const user = await this.users.validateSession(token);
    return user ? { id: user.id, username: user.username } : 'bad';
  }

  private async config(store: DonationStore, paypal: PayPalClient, body: any): Promise<Out> {
    const who = await this.account(body);
    const account = who && who !== 'bad' ? who : null;
    const total = account ? await store.totalFor(account.id, CURRENCY) : 0;
    // (A grant that was missed, say a restart between the payment and the heartbeat: the page being opened tells the servers again)
    if (account && total >= CONTRIBUTOR_AT) this.announced.set(account.id, this.now() + ANNOUNCE_MS);
    return {
      status: 200,
      body: {
        success: true, enabled: true, clientId: paypal.clientId, sandbox: paypal.env === 'sandbox', currency: CURRENCY, min: MIN_AMOUNT, max: MAX_AMOUNT, presets: PRESETS,
        account: account ? { username: account.username } : null,
        total, contributorAt: CONTRIBUTOR_AT,
      },
    };
  }

  private async createOrder(store: DonationStore, paypal: PayPalClient, body: any, ip: string): Promise<Out> {
    if (typeof body?.currency === 'string' && body.currency.toUpperCase() !== CURRENCY) return { status: 400, body: { success: false, error: 'Donations are in dollars (USD) only' } };
    const amount = parseAmount(body?.amount);
    if (amount === null) return { status: 400, body: { success: false, error: 'Enter an amount in dollars, like 5 or 7.50' } };
    if (amount < MIN_AMOUNT || amount > MAX_AMOUNT) {
      return { status: 400, body: { success: false, error: `Choose an amount from $${MIN_AMOUNT / 100} to $${MAX_AMOUNT / 100}` } };
    }
    const who = await this.account(body);
    if (who === 'bad') return { status: 401, body: { success: false, error: 'Your session has expired. Sign in to the game again, or reload this page to donate without an account.' } };
    if (!this.creates.hit(ip)) return { status: 429, body: { success: false, error: SLOW_DOWN } };

    if (this.now() - this.prunedAt > PRUNE_EVERY_MS) {
      this.prunedAt = this.now();
      void store.pruneUnpaid(this.now() - UNPAID_KEEP_MS).catch((err) => console.error('[Donations] pruning unpaid orders failed:', err));
    }
    let order: { id: string };
    try {
      order = await paypal.createOrder({
        amountMinor: amount, currency: CURRENCY,
        description: `Support ${BRAND}`, brand: BRAND, requestId: crypto.randomUUID(),
      });
    } catch (err) {
      if (!(err instanceof PayPalError)) throw err;
      console.error('[Donations] making an order failed:', err.message);
      return { status: 502, body: { success: false, error: "PayPal couldn't be reached. Nothing was charged. Try again in a moment." } };
    }
    // (The account is tied to the order here, on this side: the capture call can't change it)
    await store.create({ user_id: who ? who.id : null, amount, currency: CURRENCY, paypal_order_id: order.id, created_at: this.now() });
    return { status: 200, body: { success: true, orderId: order.id } };
  }

  private async capture(store: DonationStore, paypal: PayPalClient, body: any): Promise<Out> {
    const orderId = typeof body?.orderId === 'string' ? body.orderId : '';
    if (!/^[A-Za-z0-9-]{6,64}$/.test(orderId)) return { status: 400, body: { success: false, error: 'Which order?' } };
    const running = this.capturing.get(orderId);
    if (running) return running;
    const job = this.captureOnce(store, paypal, orderId).finally(() => this.capturing.delete(orderId));
    this.capturing.set(orderId, job);
    return job;
  }

  private async captureOnce(store: DonationStore, paypal: PayPalClient, orderId: string): Promise<Out> {
    const row = await store.byOrder(orderId);
    if (!row) return { status: 404, body: { success: false, error: 'That order was not made here' } };
    if (row.status === 'COMPLETED') return thanks(row);

    let result: CaptureResult;
    try {
      result = await paypal.captureOrder(orderId);
    } catch (err) {
      if (!(err instanceof PayPalError)) throw err;
      if (err.issue === 'ORDER_ALREADY_CAPTURED') {
        // (Captured on an earlier call whose answer was lost: read what PayPal recorded)
        try { result = await paypal.getOrder(orderId); } catch (e) {
          if (!(e instanceof PayPalError)) throw e;
          console.error('[Donations] reading a captured order failed:', e.message);
          return { status: 502, body: { success: false, error: "We couldn't confirm the payment with PayPal. Try again in a moment." } };
        }
      } else if (err.issue === 'INSTRUMENT_DECLINED') {
        return { status: 402, body: { success: false, declined: true, error: 'PayPal declined that payment method. Nothing was charged. Try another one.' } };
      } else if (err.issue === 'ORDER_NOT_APPROVED') {
        return { status: 409, body: { success: false, error: "That payment wasn't approved. Nothing was charged." } };
      } else {
        console.error('[Donations] capture failed:', err.message);
        return { status: 502, body: { success: false, error: "We couldn't confirm the payment with PayPal. Try again in a moment." } };
      }
    }

    const c = result.capture;
    if (result.orderStatus === 'COMPLETED' && c && c.status === 'COMPLETED') {
      const done = await this.completeInTurn(store, row.user_id, orderId, { capture_id: c.id, amount: c.amount, currency: c.currency, at: this.now() });
      if (done?.row.status === 'COMPLETED') return thanks(done.row);
      return { status: 500, body: { success: false, error: 'Your payment went through but we could not record it. Please get in touch.' } };
    }
    if (c && c.status === 'PENDING') {
      await store.setStatus(orderId, 'PENDING');
      return { status: 202, body: { success: false, pending: true, error: 'PayPal is still checking this payment. It will count once PayPal completes it.' } };
    }
    if (c && (c.status === 'DECLINED' || c.status === 'FAILED')) {
      await store.setStatus(orderId, 'FAILED');
      return { status: 402, body: { success: false, declined: true, error: 'PayPal declined the payment. Nothing was charged.' } };
    }
    return { status: 409, body: { success: false, error: "That payment hasn't been completed. Nothing was charged." } };
  }

  /** A pilot's own donations: the session's account only, whatever else the call says */
  private async mine(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.store) { this.sendJson(res, 503, { success: false, error: OFF }); return; }
    let body: any;
    try { body = await this.parseJson(req); } catch (err) { this.sendJson(res, bodyStatus(err), { success: false, error: 'Invalid request' }); return; }
    const who = await this.account(body);
    if (!who || who === 'bad') { this.sendJson(res, 401, { success: false, error: 'Invalid or expired session' }); return; }
    try {
      const [rows, total] = await Promise.all([this.store.forUser(who.id, MINE_MAX), this.store.totalFor(who.id, CURRENCY)]);
      this.sendJson(res, 200, {
        success: true, currency: CURRENCY, total, contributorAt: CONTRIBUTOR_AT,
        // (`reference`: PayPal's transaction id, the one on the donor's own PayPal receipt)
        donations: rows.map((d) => ({ id: d.id, amount: d.amount, currency: d.currency, status: d.status, at: d.completed_at ?? d.created_at, reference: d.capture_id })),
      });
    } catch (err) {
      console.error('[Donations] reading a history failed:', err);
      this.sendJson(res, 500, { success: false, error: 'The donations could not be read' });
    }
  }

  /**
   * Complete an order's row and, for the one call that completed it (`first`), do what happens once per donation: work
   * out whether it took the account to the contributor rank, tell the game servers, and send the thank-you. An
   * account's completions run one after another, so "the donation that crossed the line" is exactly one of them.
   */
  private async completeInTurn(store: DonationStore, userId: number | null, orderId: string, capture: { capture_id: string; amount: number; currency: string; at: number }) {
    if (userId === null) return store.complete(orderId, capture);
    const run = async () => {
      const done = await store.complete(orderId, capture);
      if (!done?.first || done.row.status !== 'COMPLETED' || done.row.user_id === null) return done;
      let crossed = false;
      try {
        const total = await store.totalFor(done.row.user_id, CURRENCY);
        const counted = done.row.currency === CURRENCY ? done.row.amount : 0;
        crossed = total >= CONTRIBUTOR_AT && total - counted < CONTRIBUTOR_AT;
        if (total >= CONTRIBUTOR_AT) this.announced.set(done.row.user_id, this.now() + ANNOUNCE_MS);
      } catch (err) {
        console.error('[Donations] reading a total failed:', err);
      }
      this.thank(done.row, crossed);
      return done;
    };
    const turn = (this.completing.get(userId) ?? Promise.resolve()).catch(() => {}).then(run);
    this.completing.set(userId, turn);
    try { return await turn; } finally { if (this.completing.get(userId) === turn) this.completing.delete(userId); }
  }

  /** The thank-you for a completed donation (best effort: a failure here never fails the capture) */
  private thank(row: DonationRecord, crossed: boolean): void {
    if (!this.onCompleted || row.user_id === null) return;
    try {
      void Promise.resolve(this.onCompleted({ userId: row.user_id, amount: row.amount, currency: row.currency, crossed })).catch((err) => console.error('[Donations] the thank-you failed:', err));
    } catch (err) {
      console.error('[Donations] the thank-you failed:', err);
    }
  }

  /** The owner's view: the newest donations and each account's total (the website's admin panel asks for it) */
  private async report(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const given = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!this.adminSecret || !safeEqual(given, this.adminSecret)) { this.sendJson(res, 403, { success: false, error: 'Forbidden' }); return; }
    if (!this.store) { this.sendJson(res, 503, { success: false, error: OFF }); return; }
    try {
      const [recent, totals] = await Promise.all([this.store.recent(RECENT_MAX), this.store.totals(CURRENCY, ACCOUNTS_MAX)]);
      const names = new Map<number, string>();
      for (const id of new Set([...recent, ...totals].map((r) => r.user_id))) {
        if (id === null) continue;
        const u = await this.users.getUserById(id);
        if (u) names.set(id, u.username);
      }
      const name = (id: number | null) => (id === null ? null : names.get(id) ?? null);
      this.sendJson(res, 200, {
        success: true, enabled: this.enabled, currency: CURRENCY,
        total: totals.reduce((n, t) => n + t.total, 0), count: totals.reduce((n, t) => n + t.count, 0),
        recent: recent.map((d) => ({ id: d.id, userId: d.user_id, username: name(d.user_id), amount: d.amount, currency: d.currency, status: d.status, orderId: d.paypal_order_id, captureId: d.capture_id, createdAt: d.created_at, completedAt: d.completed_at })),
        accounts: totals.map((t) => ({ userId: t.user_id, username: name(t.user_id), total: t.total, count: t.count })),
      });
    } catch (err) {
      console.error('[Donations] report failed:', err);
      this.sendJson(res, 500, { success: false, error: 'The donations could not be read' });
    }
  }

  forgetUser(userId: number): void {
    void this.store?.forgetUser(userId).catch((err) => console.error('[Donations] forgetting a deleted account failed:', err));
  }

  async close(): Promise<void> {
    await this.store?.close();
  }
}

/** Minor units as written: "$5", "$7.50" (other currencies: "7.50 EUR") */
export function moneyText(minor: number, currency: string): string {
  const whole = Math.floor(minor / 100), part = minor % 100;
  const text = part ? `${whole}.${String(part).padStart(2, '0')}` : String(whole);
  return currency === 'USD' ? `$${text}` : `${text} ${currency}`;
}

/**
 * The inbox message a donor gets (plain text). `crossed`: this donation took their total to CONTRIBUTOR_AT, so it also
 * says they have the contributor rank and how to open its tools (F6: client/src/ui/ContributorPanel.ts).
 */
export function thankYouMessage(amount: number, currency: string, crossed = false): { subject: string; body: string } {
  const parts = [
    `Your donation of ${moneyText(amount, currency)} came through. Thank you: it goes towards keeping the servers running and the game growing.`,
    ...(crossed ? [`You now have the contributor rank. In the game, press F6 to open the contributor notes: mark the world with notes and suggestions, see other people's ideas and give feedback. Shift+F6 shows the notes on their own. If you were signed in when you donated, the tools turn on within a few seconds; otherwise they are there next time you sign in.`] : []),
    'You can see your donations on the website, on your account page.',
  ];
  return { subject: 'Thank you for supporting the game', body: parts.join('\n\n') };
}

function thanks(row: DonationRecord): Out {
  return { status: 200, body: { success: true, amount: row.amount, currency: row.currency, linked: row.user_id !== null } };
}
