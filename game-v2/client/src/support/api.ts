/**
 * @contract client.support.api
 * owns:       the donation page's calls to the lobby (/donations/config, create, capture), its reading of a typed
 *             amount, how money is written, and the address PayPal's script is loaded from
 * needs:      fetch (injectable), ../network/lobby (LOBBY_URL); the lobby's server-browser/src/donations/routes.ts
 * invariants: a lobby that is off, unreachable or answers nonsense gives "unavailable" and never throws — client/src/support/api.test.ts
 *             a session token is sent only when there is one — client/src/support/api.test.ts
 *             an amount is read as whole cents within the limits or refused with a reason — client/src/support/api.test.ts
 *             PayPal's script address carries the public client id and nothing else of ours — client/src/support/api.test.ts
 *             the rank line says "have it" at or past the threshold and the exact amount still to go below it — client/src/support/api.test.ts
 * extend:     a new lobby call is one method on SupportApi
 */
/**
 * The page only ever holds PayPal's public client id (the lobby hands it over). The lobby checks every amount again and
 * decides who a donation is credited to from the session token: nothing computed here is trusted there.
 */

import { LOBBY_URL } from '../network/lobby';

export interface SupportConfig {
  enabled: true;
  clientId: string;
  /** PayPal's test side: no real money moves */
  sandbox: boolean;
  currency: string;
  /** Minor units (cents) */
  min: number;
  max: number;
  presets: number[];
  /** Who a donation is credited to; null: nobody is signed in */
  account: { username: string } | null;
  /** What that account has given so far (cents) */
  total: number;
  /** The total (cents) at which an account has the contributor rank; 0: the lobby didn't say */
  contributorAt: number;
}

export type ConfigResult = SupportConfig | { enabled: false };

export interface CallResult {
  success: boolean;
  error?: string;
  orderId?: string;
  amount?: number;
  currency?: string;
  linked?: boolean;
  declined?: boolean;
  pending?: boolean;
}

export interface SupportApi {
  config(token: string | null): Promise<ConfigResult>;
  create(token: string | null, amount: string): Promise<CallResult>;
  capture(orderId: string): Promise<CallResult>;
}

const UNREACHABLE = "Can't reach the server. Check your connection and try again.";

export function lobbySupport(f: typeof fetch = fetch, base: string = LOBBY_URL): SupportApi {
  const post = async (action: string, body: Record<string, unknown>): Promise<any> => {
    const r = await f(`${base}/donations/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return await r.json();
  };
  const withToken = (token: string | null, rest: Record<string, unknown> = {}) => (token ? { token, ...rest } : rest);
  const call = async (action: string, body: Record<string, unknown>): Promise<CallResult> => {
    try {
      const j = await post(action, body);
      if (j && typeof j === 'object' && typeof j.success === 'boolean') return j as CallResult;
    } catch { /* below */ }
    return { success: false, error: UNREACHABLE };
  };
  return {
    async config(token) {
      try {
        const j = await post('config', withToken(token));
        const ok = j && j.success === true && j.enabled === true && typeof j.clientId === 'string' && j.clientId && typeof j.currency === 'string'
          && Number.isFinite(j.min) && Number.isFinite(j.max) && Array.isArray(j.presets);
        if (!ok) return { enabled: false };
        return {
          enabled: true, clientId: j.clientId, sandbox: j.sandbox === true, currency: j.currency, min: j.min, max: j.max,
          presets: j.presets.filter((p: unknown) => typeof p === 'number' && Number.isFinite(p)),
          account: j.account && typeof j.account.username === 'string' ? { username: j.account.username } : null,
          total: Number.isFinite(j.total) ? j.total : 0,
          contributorAt: Number.isFinite(j.contributorAt) && j.contributorAt > 0 ? j.contributorAt : 0,
        };
      } catch {
        return { enabled: false };
      }
    },
    create: (token, amount) => call('create', withToken(token, { amount })),
    capture: (orderId) => call('capture', { orderId }),
  };
}

/** Pence as it's written: "$5", "$7.50" */
export function dollars(minor: number): string {
  const whole = Math.floor(minor / 100), cents = minor % 100;
  return `$${whole.toLocaleString('en-US')}${cents ? `.${String(cents).padStart(2, '0')}` : ''}`;
}

/** Pence as the lobby takes an amount: "7.50" */
export function amountText(minor: number): string {
  return `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, '0')}`;
}

/** Said to a signed-in pilot whose total has earned the contributor rank ('' below it: the page's own words say what earns it; '' when the lobby gave no threshold) */
export function rankLine(total: number, contributorAt: number): string {
  if (!(contributorAt > 0)) return '';
  return total >= contributorAt ? 'You have the contributor rank.' : '';
}

/** What someone typed, as whole cents within the limits, or why not */
export function readAmount(text: string, min: number, max: number): { minor: number } | { error: string } {
  const s = text.trim().replace(/^\$\s*/, '');
  if (!s) return { error: 'Enter an amount.' };
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(s)) return { error: 'Enter an amount in dollars, like 5 or 7.50.' };
  const [whole, frac = ''] = s.split('.');
  const minor = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  if (minor < min) return { error: `The smallest donation is ${dollars(min)}.` };
  if (minor > max) return { error: `The largest single donation is ${dollars(max)}.` };
  return { minor };
}

/** Where PayPal's buttons are loaded from: PayPal's own site, with the public client id */
export function sdkUrl(clientId: string, currency: string): string {
  const q = new URLSearchParams({ 'client-id': clientId, currency, intent: 'capture', components: 'buttons' });
  return `https://www.paypal.com/sdk/js?${q}`;
}
