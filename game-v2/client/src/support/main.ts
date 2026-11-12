/**
 * The donation page (client/support.html): choose an amount, pay with PayPal's own buttons, see a thank-you.
 * It is on the game's origin, so the session the game keeps (localStorage authToken) says who is signed in. The lobby
 * decides everything that matters (api.ts); card and PayPal details are typed into PayPal's frames, never this page.
 */

import { PRIVACY_URL, REFUNDS_URL } from '../ui/join/legalLinks';
import { rankLine, amountText, lobbySupport, dollars, readAmount, sdkUrl, type SupportConfig } from './api';

const api = lobbySupport();
const root = document.getElementById('support-root')!;
/** Where the game is: /play on the live site, the page root on the dev client */
const GAME_URL = (import.meta as any).env?.DEV ? '/' : '/play';
/** A pilot's donations on the website (site/src/routes/mine.ts). The dev client has no website on its origin: no link */
const HISTORY_URL = (import.meta as any).env?.DEV ? '' : '/account/donations';
(document.getElementById('back-link') as HTMLAnchorElement | null)?.setAttribute('href', GAME_URL);

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  const { class: cls, ...rest } = props;
  if (cls) e.className = cls;
  Object.assign(e, rest);
  e.append(...kids);
  return e;
}

function token(): string | null {
  try { return localStorage.getItem('authToken') || null; } catch { return null; }
}

function loadPayPal(cfg: SupportConfig): Promise<any> {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = sdkUrl(cfg.clientId, cfg.currency);
    s.onload = () => ((window as any).paypal ? resolve((window as any).paypal) : reject(new Error('no paypal')));
    s.onerror = () => reject(new Error('blocked'));
    document.head.append(s);
  });
}

function showUnavailable(): void {
  root.replaceChildren(el('p', {}, 'Donations are unavailable right now. Thank you for wanting to help: please try again later.'));
}

function showThanks(amount: number, linked: boolean, username: string | null): void {
  root.replaceChildren(el('div', { class: 'thanks' },
    el('h2', {}, 'Thank you!'),
    el('p', {}, `Your donation of ${dollars(amount)} went through.`),
    el('p', { class: 'note' }, linked && username ? `It has been added to ${username}'s account. We've sent a thank-you to your inbox.` : "It wasn't linked to an account."),
    ...(linked && HISTORY_URL ? [el('p', {}, el('a', { href: HISTORY_URL }, 'See your donations'))] : []),
    el('p', {}, el('a', { href: GAME_URL }, 'Back to the game'))));
}

async function start(): Promise<void> {
  const cfg = await api.config(token());
  if (!cfg.enabled) { showUnavailable(); return; }
  // (A stale session shows as not signed in, and then no token is sent with the order)
  const session = cfg.account ? token() : null;
  let chosen: number | null = cfg.presets.includes(500) ? 500 : cfg.presets[0] ?? null;

  const error = el('div', { class: 'error', hidden: true });
  error.setAttribute('role', 'alert');
  const fail = (text: string) => { error.textContent = text; error.hidden = false; };
  const clear = () => { error.hidden = true; };

  const custom = el('input', { type: 'text', inputMode: 'decimal', placeholder: 'Other', autocomplete: 'off' });
  custom.setAttribute('aria-label', 'Another amount in dollars');
  const presets = cfg.presets.map((p) => {
    const b = el('button', { type: 'button' }, dollars(p));
    b.addEventListener('click', () => { chosen = p; custom.value = ''; clear(); mark(); });
    return { p, b };
  });
  const mark = () => { for (const { p, b } of presets) b.setAttribute('aria-pressed', String(chosen === p)); };
  custom.addEventListener('input', () => { chosen = null; clear(); mark(); });
  mark();

  /** The amount as chosen now (cents), or null after showing why not */
  const amount = (): number | null => {
    if (chosen !== null) return chosen;
    const r = readAmount(custom.value, cfg.min, cfg.max);
    if ('error' in r) { fail(r.error); return null; }
    return r.minor;
  };

  const who = el('div', { class: 'who' });
  if (cfg.account) {
    who.append('Donating as ', el('b', {}, cfg.account.username), '.');
    if (cfg.total > 0) who.append(el('br'), `You've donated ${dollars(cfg.total)} in total. Thank you!`);
    if (HISTORY_URL) who.append(' ', el('a', { href: HISTORY_URL }, 'Your donations'));
    const rank = rankLine(cfg.total, cfg.contributorAt);
    if (rank) who.append(el('br'), rank);
  } else {
    who.append("You're not signed in, so your donation won't be linked to an account. To link it, ",
      el('a', { href: GAME_URL }, 'sign in to the game'), ' in this browser first, then reload this page.');
  }
  // (Beside the amount: a guest can't earn the rank)
  const guestNote = cfg.account ? null : el('p', { class: 'note guest-rank' }, "The contributor rank needs a signed-in account: a guest donation can't be linked to one.");

  const buttons = el('div', { id: 'paypal-buttons' });
  root.replaceChildren(
    ...(cfg.sandbox ? [el('div', { class: 'sandbox' }, 'Test mode: no real money is taken')] : []),
    el('p', { class: 'label' }, `Amount (${cfg.currency})`),
    el('div', { class: 'amounts' }, ...presets.map((x) => x.b)),
    el('div', { class: 'custom' }, '$', custom),
    ...(guestNote ? [guestNote] : []),
    who, error, buttons,
    el('p', { class: 'note' }, 'Payment is handled by PayPal. Your card and PayPal details never reach our server.'),
    el('p', { class: 'note' }, 'Donations are voluntary; refunds are discretionary. ',
      el('a', { href: PRIVACY_URL, target: '_blank', rel: 'noopener' }, 'Privacy'), ' · ', el('a', { href: REFUNDS_URL, target: '_blank', rel: 'noopener' }, 'Donations and refunds')));

  let paypal: any;
  try { paypal = await loadPayPal(cfg); } catch {
    buttons.remove();
    fail("PayPal couldn't be loaded. Check your connection or ad blocker, then reload this page.");
    return;
  }
  paypal.Buttons({
    onClick: (_data: unknown, actions: any) => { clear(); return amount() === null ? actions.reject() : actions.resolve(); },
    createOrder: async () => {
      const minor = amount();
      if (minor === null) throw new Error('no amount');
      const r = await api.create(session, amountText(minor));
      if (!r.success || !r.orderId) { fail(r.error || 'The donation could not be started. Nothing was charged.'); throw new Error('create failed'); }
      return r.orderId;
    },
    onApprove: async (data: { orderID: string }, actions: any) => {
      const r = await api.capture(data.orderID);
      if (r.success && typeof r.amount === 'number') { showThanks(r.amount, r.linked === true, cfg.account?.username ?? null); return; }
      // (A declined card: PayPal lets them pick another)
      if (r.declined && actions?.restart) return actions.restart();
      fail(r.error || "We couldn't confirm the payment. If you were charged, please get in touch.");
    },
    onCancel: () => fail('Payment cancelled. Nothing was charged.'),
    // (Errors already explained above keep their message)
    onError: () => { if (error.hidden) fail('Something went wrong with PayPal. Nothing was recorded. Please try again.'); },
  }).render(buttons);
}

void start().catch(() => showUnavailable());
