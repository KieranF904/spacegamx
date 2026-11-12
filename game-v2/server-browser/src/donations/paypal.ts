/**
 * @contract lobby.donations.paypal
 * owns:       the lobby's calls to PayPal's REST API (Orders v2): the keys and which PayPal they're for, the OAuth token
 *             (kept until just before it expires), making an order, capturing it, reading it back
 * needs:      fetch (injectable), process.env PAYPAL_ENV / PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET; outside production
 *             the same three names from the git-ignored game-v2/.env
 * invariants: no keys, or keys for the wrong PayPal (sandbox in production, live outside it), means no client — server-browser/src/donations/donations.test.ts
 *             the token is asked for once and reused until it expires — server-browser/src/donations/donations.test.ts
 *             an error never carries the secret, the token or a request header — server-browser/src/donations/donations.test.ts
 *             the amount goes to PayPal as dollars with two decimals, from whole cents — server-browser/src/donations/donations.test.ts
 *             an order carries the amount and a fixed description, and nothing about the account — server-browser/src/donations/donations.test.ts
 * extend:     a new PayPal call is one method on PayPalClient using api()
 */
/**
 * The secret is read here, from the environment, and goes nowhere else: it is sent to PayPal's token endpoint only, and
 * no error or log line made here includes it (errors carry PayPal's status, error name and debug id, which aren't
 * secret). The client id is public: the support page gets it from /donations/config to load PayPal's buttons.
 *
 * Which PayPal: PAYPAL_ENV is 'sandbox' (test money) or 'live'. Production only takes 'live' and everything else only
 * takes 'sandbox', so test keys can't be mistaken for real donations and a dev server can't take real money.
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

export type PayPalEnv = 'sandbox' | 'live';

export interface PayPalConfig {
  env: PayPalEnv;
  clientId: string;
  secret: string;
}

const BASE: Record<PayPalEnv, string> = {
  sandbox: 'https://api-m.sandbox.paypal.com',
  live: 'https://api-m.paypal.com',
};

/** How long one call to PayPal may take */
const TIMEOUT_MS = 15_000;
/** The token is dropped this long before PayPal says it expires */
const TOKEN_MARGIN_MS = 60_000;

/** The three PAYPAL_* lines of game-v2/.env (never the file's other keys) */
function dotEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const file = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../.env'), 'utf8');
    for (const name of ['PAYPAL_ENV', 'PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET']) {
      const v = new RegExp(`^${name}=(.*)$`, 'm').exec(file)?.[1]?.trim().replace(/^(['"])(.*)\1$/, '$2');
      if (v) out[name] = v;
    }
  } catch { /* no .env */ }
  return out;
}

/**
 * The keys, or why donations are off (a reason safe to log: it never includes a value).
 * (Tests pass their own environment and file)
 */
export function paypalConfig(env: Record<string, string | undefined> = process.env, file: () => Record<string, string> = dotEnv): { config: PayPalConfig | null; reason: string } {
  const production = env.NODE_ENV === 'production';
  let src = { PAYPAL_ENV: env.PAYPAL_ENV, PAYPAL_CLIENT_ID: env.PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET: env.PAYPAL_CLIENT_SECRET };
  // (Local dev: the keys stay in the git-ignored .env, never in the tracked dev.env)
  if (!production && (!src.PAYPAL_CLIENT_ID || !src.PAYPAL_CLIENT_SECRET)) {
    const f = file();
    src = { PAYPAL_ENV: src.PAYPAL_ENV || f.PAYPAL_ENV, PAYPAL_CLIENT_ID: src.PAYPAL_CLIENT_ID || f.PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET: src.PAYPAL_CLIENT_SECRET || f.PAYPAL_CLIENT_SECRET };
  }
  const clientId = (src.PAYPAL_CLIENT_ID ?? '').trim(), secret = (src.PAYPAL_CLIENT_SECRET ?? '').trim();
  if (!clientId || !secret) return { config: null, reason: 'PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are not set' };
  const mode = (src.PAYPAL_ENV ?? '').trim().toLowerCase() || 'sandbox';
  if (mode !== 'sandbox' && mode !== 'live') return { config: null, reason: 'PAYPAL_ENV must be "sandbox" or "live"' };
  if (production && mode !== 'live') return { config: null, reason: 'production only takes live PayPal keys (PAYPAL_ENV=live)' };
  if (!production && mode !== 'sandbox') return { config: null, reason: 'live PayPal keys are only used in production' };
  return { config: { env: mode, clientId, secret }, reason: '' };
}

/** PayPal said no, or couldn't be reached. `status` 0: no answer (timeout, network). Never carries a key or token */
export class PayPalError extends Error {
  constructor(readonly status: number, readonly code: string, readonly issue: string, readonly debugId: string) {
    super(`PayPal ${status || 'unreachable'}${code ? ` ${code}` : ''}${issue ? ` (${issue})` : ''}${debugId ? ` debug_id ${debugId}` : ''}`);
    this.name = 'PayPalError';
  }
}

/** What an order's capture came to, read from PayPal's own answer */
export interface CaptureResult {
  orderId: string;
  /** The order's status ('COMPLETED' once captured) */
  orderStatus: string;
  /** Null when the answer holds no capture */
  capture: { id: string; status: string; amount: number; currency: string } | null;
}

type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ status: number; ok: boolean; text(): Promise<string> }>;

/** Whole cents as PayPal's decimal string ("5.00") */
export function minorToValue(minor: number): string {
  return `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, '0')}`;
}

/** PayPal's decimal string as whole cents, or null when it isn't a plain amount with up to two decimals */
export function valueToMinor(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{1,9}(\.\d{1,2})?$/.test(value)) return null;
  const [whole, frac = ''] = value.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

function captureOf(order: any): CaptureResult {
  const c = order?.purchase_units?.[0]?.payments?.captures?.[0];
  const amount = valueToMinor(c?.amount?.value);
  const currency = typeof c?.amount?.currency_code === 'string' ? c.amount.currency_code.toUpperCase() : '';
  return {
    orderId: String(order?.id ?? ''),
    orderStatus: String(order?.status ?? ''),
    capture: c && typeof c.id === 'string' && c.id && amount !== null && currency ? { id: c.id, status: String(c.status ?? ''), amount, currency } : null,
  };
}

export class PayPalClient {
  private token: { value: string; until: number } | null = null;
  private asking: Promise<string> | null = null;

  constructor(private cfg: PayPalConfig, private fetchFn: FetchFn = fetch as unknown as FetchFn, private now: () => number = Date.now) {}

  get env(): PayPalEnv { return this.cfg.env; }
  /** Public by design: the browser needs it to load PayPal's buttons */
  get clientId(): string { return this.cfg.clientId; }

  /** A new order to capture `amountMinor` (whole cents). `requestId` makes a retry the same order */
  async createOrder(o: { amountMinor: number; currency: string; description: string; brand: string; requestId: string }): Promise<{ id: string; status: string }> {
    // (The amount and a fixed description only: nothing about the account goes to PayPal. Which account an order is for
    // is kept on this side, in the lobby's own row: routes.ts)
    const unit: Record<string, unknown> = { amount: { currency_code: o.currency, value: minorToValue(o.amountMinor) }, description: o.description };
    const r = await this.api('POST', '/v2/checkout/orders', {
      intent: 'CAPTURE',
      purchase_units: [unit],
      // (Nothing is posted: PayPal needn't ask for an address)
      application_context: { shipping_preference: 'NO_SHIPPING', user_action: 'PAY_NOW', brand_name: o.brand },
    }, o.requestId);
    if (typeof r?.id !== 'string' || !r.id) throw new PayPalError(502, 'NO_ORDER_ID', '', '');
    return { id: r.id, status: String(r.status ?? '') };
  }

  /** Take the money for an order its payer approved */
  async captureOrder(orderId: string): Promise<CaptureResult> {
    return captureOf(await this.api('POST', `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {}, `capture-${orderId}`));
  }

  /** An order as PayPal has it now */
  async getOrder(orderId: string): Promise<CaptureResult> {
    return captureOf(await this.api('GET', `/v2/checkout/orders/${encodeURIComponent(orderId)}`));
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.now() < this.token.until) return this.token.value;
    // (Calls that arrive together share the one request)
    this.asking ??= (async () => {
      try {
        const basic = Buffer.from(`${this.cfg.clientId}:${this.cfg.secret}`).toString('base64');
        const r = await this.send('POST', '/v1/oauth2/token', { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' }, 'grant_type=client_credentials');
        if (typeof r.json?.access_token !== 'string' || !r.json.access_token) throw new PayPalError(r.status, 'NO_TOKEN', '', '');
        const life = Number(r.json.expires_in) > 0 ? Number(r.json.expires_in) * 1000 : 0;
        this.token = { value: r.json.access_token, until: this.now() + Math.max(0, life - TOKEN_MARGIN_MS) };
        return this.token.value;
      } finally {
        this.asking = null;
      }
    })();
    return this.asking;
  }

  private async api(method: 'GET' | 'POST', path: string, body?: unknown, requestId?: string): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = { Authorization: `Bearer ${await this.accessToken()}`, 'Content-Type': 'application/json' };
      if (requestId) headers['PayPal-Request-Id'] = requestId;
      try {
        return (await this.send(method, path, headers, body === undefined ? undefined : JSON.stringify(body))).json;
      } catch (err) {
        // (A token PayPal no longer takes: ask for a new one, once)
        if (attempt === 0 && err instanceof PayPalError && err.status === 401) { this.token = null; continue; }
        throw err;
      }
    }
  }

  /** One request. Throws PayPalError for no answer or a non-2xx one; the error is built from PayPal's body only */
  private async send(method: string, path: string, headers: Record<string, string>, body?: string): Promise<{ status: number; json: any }> {
    let status = 0, text = '';
    try {
      const res = await this.fetchFn(BASE[this.cfg.env] + path, { method, headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
      status = res.status;
      text = await res.text();
    } catch {
      // (The thrown error isn't passed on: it can hold the request)
      throw new PayPalError(0, 'UNREACHABLE', '', '');
    }
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (status < 200 || status >= 300) {
      // (Only PayPal's plain error names and its debug id are kept: anything else in the body is dropped, not trimmed)
      const word = (v: unknown) => (typeof v === 'string' && /^[A-Za-z_]{1,48}$/.test(v) ? v : '');
      const hex = (v: unknown) => (typeof v === 'string' && /^[a-f0-9]{6,32}$/i.test(v) ? v : '');
      throw new PayPalError(status, word(json?.name ?? json?.error), word(json?.details?.[0]?.issue), hex(json?.debug_id));
    }
    return { status, json };
  }
}
