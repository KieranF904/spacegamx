/**
 * @contract lobby.newsletter.routes
 * owns:       consent to the email newsletter, per account: whether they were asked, what they said, when and where;
 *             the answer a sign-up carries; the owner's counts. Sends nothing: there is no newsletter yet
 * needs:      UserStore (sessions, the account count), ConsentStore, accounts/RateLimiter + utils
 * invariants: an account that was never asked reads as not asked and not consenting — server-browser/src/newsletter/newsletter.test.ts
 *             a sign-up records exactly what its form sent, and one that sent nothing is left not asked — server-browser/src/newsletter/newsletter.test.ts
 *             an answer changes only the session's own account; no session is a 401 — server-browser/src/newsletter/newsletter.test.ts
 *             only a real yes or no (a boolean) is taken, and only from the prompt or the settings — server-browser/src/newsletter/newsletter.test.ts
 *             only a caller with LOBBY_ADMIN_SECRET reads the counts, and they hold no address — server-browser/src/newsletter/newsletter.test.ts
 * extend:     a new route is one case in handle(); a new place to ask is one ConsentVia
 *
 *   POST /newsletter/get { token }                     -> { success, newsletter, asked, at, via }
 *   POST /newsletter/set { token, newsletter, via }    -> { success, newsletter, asked: true, at, via }
 *        `newsletter` must be true or false; `via` is 'prompt' (the website's one-time question) or 'settings' (the
 *        account page). The account is the session's, whatever else the body says.
 *   POST /admin/newsletter {}                          -> { success, accounts, consented, declined, notAsked }
 *        `Authorization: Bearer <LOBBY_ADMIN_SECRET>` (the website's admin panel; nginx doesn't pass /admin/ through).
 *        Counts only: no names, no addresses.
 *
 * Sign-up: the lobby's entry hands /auth/register's body to signedUp() once the account exists (../index.ts). The
 * website calls these from its own server with the visitor's session; nginx does not expose /newsletter/.
 */

import http from 'http';
import path from 'path';
import type { UserStore } from '../accounts/types.js';
import { safeEqual } from '../accounts/utils.js';
import { RateLimiter } from '../accounts/RateLimiter.js';
import { createConsentStore } from './index.js';
import type { ConsentRecord, ConsentStore, ConsentVia } from './types.js';

type Json = (res: http.ServerResponse, status: number, body: unknown) => void;
type Body = (req: http.IncomingMessage) => Promise<any>;

/** Newsletter calls per address a minute */
export const IP_LIMIT = 60;
const SLOW_DOWN = 'Too many requests. Wait a minute and try again.';
const OFF = 'This is unavailable right now';

/** An account's answer as it is told: never asked reads as not asked, not consenting */
export interface ConsentState { newsletter: boolean; asked: boolean; at: number | null; via: ConsentVia | null }

const NOT_ASKED: ConsentState = { newsletter: false, asked: false, at: null, via: null };
const view = (r: ConsentRecord | null): ConsentState => (r ? { newsletter: r.newsletter, asked: r.newsletter_asked, at: r.newsletter_at, via: r.newsletter_via } : { ...NOT_ASKED });

function bodyStatus(err: unknown): number {
  return (err as { status?: unknown })?.status === 413 ? 413 : 400;
}

export class NewsletterRoutes {
  private perIp: RateLimiter;

  private constructor(readonly store: ConsentStore | null, private users: UserStore, private sendJson: Json, private parseJson: Body,
    private ipOf: (req: http.IncomingMessage) => string, private adminSecret: string, private now: () => number) {
    this.perIp = new RateLimiter(IP_LIMIT, 60_000, 10_000, now);
  }

  /** (Tests pass their own store and clock) */
  static async create(users: UserStore, sendJson: Json, parseJson: Body, ipOf: (req: http.IncomingMessage) => string,
    opts: { store?: ConsentStore; adminSecret: string; dataDir: string; now?: () => number }): Promise<NewsletterRoutes> {
    let store: ConsentStore | null = opts.store ?? null;
    // (No consent records is better than no lobby: sign-in mustn't go down because this table can't be made)
    if (!store) {
      try { store = await createConsentStore(users, path.join(opts.dataDir, 'newsletter.json')); } catch (err) { console.error('[Newsletter] off:', (err as Error).message); }
    }
    return new NewsletterRoutes(store, users, sendJson, parseJson, ipOf, opts.adminSecret, opts.now ?? Date.now);
  }

  /** An account's answer (not asked, while the records can't be read: nobody is taken to have consented) */
  async state(userId: number): Promise<ConsentState> {
    if (!this.store) return { ...NOT_ASKED };
    try { return view(await this.store.get(userId)); } catch (err) { console.error('[Newsletter] reading an answer failed:', err); return { ...NOT_ASKED }; }
  }

  /**
   * A new account, with what its sign-up form sent for `newsletter`. true or false: the form asked, so that is the
   * answer (via 'signup'). Anything else (an older client that sent nothing): left not asked, never taken as a yes.
   */
  async signedUp(userId: number, answer: unknown): Promise<void> {
    if (!this.store || typeof answer !== 'boolean') return;
    try { await this.store.set(userId, answer, 'signup', this.now()); } catch (err) { console.error('[Newsletter] recording a sign-up answer failed:', err); }
  }

  /** Handles /newsletter/* and /admin/newsletter (true when it did) */
  async handle(req: http.IncomingMessage, res: http.ServerResponse, url: string): Promise<boolean> {
    if (req.method !== 'POST') return false;
    if (url === '/admin/newsletter') { await this.report(req, res); return true; }
    if (url !== '/newsletter/get' && url !== '/newsletter/set') return false;
    if (!this.perIp.hit(this.ipOf(req))) { this.sendJson(res, 429, { success: false, error: SLOW_DOWN }); return true; }
    if (!this.store) { this.sendJson(res, 503, { success: false, error: OFF }); return true; }
    let body: any;
    try { body = await this.parseJson(req); } catch (err) { this.sendJson(res, bodyStatus(err), { success: false, error: 'Invalid request' }); return true; }
    const token = typeof body?.token === 'string' ? body.token : '';
    const user = token ? await this.users.validateSession(token) : null;
    if (!user) { this.sendJson(res, 401, { success: false, error: 'Invalid or expired session' }); return true; }
    try {
      if (url === '/newsletter/get') {
        this.sendJson(res, 200, { success: true, ...view(await this.store.get(user.id)) });
        return true;
      }
      // (A real yes or no only: "true", 1 or a missing field is not consent and not a refusal)
      if (typeof body.newsletter !== 'boolean') { this.sendJson(res, 400, { success: false, error: 'Say yes or no' }); return true; }
      if (body.via !== 'prompt' && body.via !== 'settings') { this.sendJson(res, 400, { success: false, error: 'Invalid request' }); return true; }
      const row = await this.store.set(user.id, body.newsletter, body.via, this.now());
      console.log(`[Newsletter] ${user.username} said ${row.newsletter ? 'yes' : 'no'} (${row.newsletter_via})`);
      this.sendJson(res, 200, { success: true, ...view(row) });
    } catch (err) {
      console.error('[Newsletter] failed:', err);
      this.sendJson(res, 500, { success: false, error: 'Something went wrong. Try again in a moment.' });
    }
    return true;
  }

  /** The owner's counts (the website's admin panel asks for them): how many said yes, said no, or haven't been asked */
  private async report(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const given = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!this.adminSecret || !safeEqual(given, this.adminSecret)) { this.sendJson(res, 403, { success: false, error: 'Forbidden' }); return; }
    if (!this.store) { this.sendJson(res, 503, { success: false, error: OFF }); return; }
    try {
      const [{ consented, declined }, accounts] = await Promise.all([this.store.counts(), this.users.getUserCount()]);
      this.sendJson(res, 200, { success: true, accounts, consented, declined, notAsked: Math.max(0, accounts - consented - declined) });
    } catch (err) {
      console.error('[Newsletter] report failed:', err);
      this.sendJson(res, 500, { success: false, error: 'The counts could not be read' });
    }
  }

  forgetUser(userId: number): void {
    void this.store?.forgetUser(userId).catch((err) => console.error('[Newsletter] forgetting a deleted account failed:', err));
  }

  async close(): Promise<void> {
    await this.store?.close();
  }
}
