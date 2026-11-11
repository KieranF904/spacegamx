/**
 * @contract client.ui.guest-banner
 * owns:       the guest's banner in the top right (title, rules, time left, a Register button that opens the form in place) and,
 *             for a guest past their 3 days, the one screen that asks them to register to play on; sends convertGuest
 * needs:      DOM (optional: with none every call does nothing), guestBannerModel, the hooks Game gives it (send, the lobby's
 *             register, what to do once registered); @space-game/common (types)
 * invariants: an expired guest is told to register to keep playing — client/src/ui/guest/guestBannerModel.test.ts
 * extend:     the words are guestBannerModel.ts; the server's side is net/handlers/guestAccount.ts. No prompts or popups while a
 *             guest plays (the banner is always there, the form opens only when asked); the lobby's account is made once: a
 *             refused move of the pilot is retried with the same session, not a second account
 */

import type { ClientMessage, ServerGuestStatusMessage, ServerGuestConvertedMessage } from '@space-game/common';
import { guestBannerModel } from './guestBannerModel';

export interface GuestHooks {
  send(msg: ClientMessage): void;
  /** The lobby makes the account (POST /auth/register) */
  register(username: string, email: string, password: string): Promise<{ success: boolean; token?: string; username?: string; error?: string }>;
  /** The pilot is the account's now (the token to join with from now on) */
  registered(token: string, username: string): void;
  /** Leave the game (an expired guest who won't register) */
  leave(): void;
}

let hooks: GuestHooks | null = null;
let status: ServerGuestStatusMessage | null = null;
let receivedAt = 0;
let root: HTMLDivElement | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let formOpen = false;
let busy = false;
let error = '';
/** The lobby made the account but the move of the pilot was refused: tried again with this, not with a second account */
let made: { token: string; username: string } | null = null;

export function initGuestBanner(h: GuestHooks): void { hooks = h; }

/** The server's word on the guest's time (join, again if it changes) */
export function onGuestStatus(msg: ServerGuestStatusMessage): void {
  if (typeof document === 'undefined') return;
  status = msg;
  receivedAt = Date.now();
  if (msg.state === 'expired') formOpen = true;
  if (!timer) timer = setInterval(() => { if (!formOpen) paint(); }, 30_000);
  paint();
}

/** The answer to the move of the pilot into the new account */
export function onGuestConverted(msg: ServerGuestConvertedMessage): void {
  busy = false;
  if (msg.success && made) {
    hooks?.registered(made.token, made.username);
    hideGuestBanner();
    return;
  }
  error = msg.error || 'Could not register. Try again.';
  paint();
}

/** No guest in play (left, or registered): nothing shown */
export function hideGuestBanner(): void {
  status = null; made = null; formOpen = false; busy = false; error = '';
  if (timer) clearInterval(timer);
  timer = null;
  root?.remove();
  root = null;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, css: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.style.cssText = css;
  if (text !== undefined) e.textContent = text;
  return e;
}

const FONT = 'font:12px system-ui,sans-serif;';
const FIELD = `${FONT}width:100%;box-sizing:border-box;margin-top:6px;padding:5px 7px;background:#0b1220;color:#e5ecf6;border:1px solid #3b4a63;border-radius:4px;`;
const BUTTON = `${FONT}font-weight:600;padding:5px 12px;background:#2563eb;color:#fff;border:0;border-radius:4px;cursor:pointer;`;
const QUIET = `${FONT}padding:5px 12px;background:transparent;color:#a9b7cc;border:1px solid #3b4a63;border-radius:4px;cursor:pointer;`;

function paint(): void {
  if (!status || typeof document === 'undefined') return;
  const m = guestBannerModel(status, receivedAt, Date.now());
  const keep = document.activeElement && root?.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.field : undefined;
  // (The typed values survive a repaint: the clock repaints every half minute)
  const typed: Record<string, string> = {};
  root?.querySelectorAll<HTMLInputElement>('input[data-field]').forEach((i) => { typed[i.dataset.field!] = i.value; });
  root?.remove();

  const box = el('div', `background:#101a2c;color:#e5ecf6;border:1px solid ${m.urgent ? '#fbbf24' : '#3b4a63'};border-radius:8px;padding:10px 12px;width:min(260px,92vw);box-sizing:border-box;box-shadow:0 4px 18px rgba(0,0,0,.45);${FONT}`);
  box.setAttribute('role', 'status');
  box.append(el('div', 'font-weight:700;margin-bottom:3px', m.title), el('div', 'color:#a9b7cc;margin-bottom:8px', m.detail));

  if (!formOpen) {
    const b = el('button', BUTTON, 'Register');
    b.type = 'button';
    b.onclick = () => { formOpen = true; paint(); };
    box.append(b);
  } else {
    box.append(form(typed, !m.expired));
  }

  // A guest past their 3 days: a screen over the game, so the only thing to do is register (or leave)
  if (m.expired) {
    root = el('div', 'position:fixed;inset:0;z-index:8950;display:flex;align-items:center;justify-content:center;background:rgba(3,7,14,.82)');
    box.style.width = 'min(340px,92vw)';
    root.append(box);
  } else {
    root = el('div', 'position:fixed;top:calc(205px + env(safe-area-inset-top,0px));right:15px;z-index:8900');
    root.append(box);
  }
  document.body.appendChild(root);
  if (keep) root.querySelector<HTMLInputElement>(`input[data-field="${keep}"]`)?.focus();
}

function form(typed: Record<string, string>, canClose: boolean): HTMLFormElement {
  const f = document.createElement('form');
  const field = (name: string, type: string, label: string, auto: string) => {
    const i = el('input', FIELD);
    i.type = type; i.placeholder = label; i.autocomplete = auto as AutoFill; i.dataset.field = name; i.value = typed[name] ?? '';
    i.setAttribute('aria-label', label);
    return i;
  };
  // (After a refused move the account exists: only the move is tried again)
  if (made) {
    f.append(el('div', 'color:#a9b7cc;margin-bottom:6px', `Account ${made.username} is made. Your pilot has not moved yet.`));
  } else {
    f.append(field('username', 'text', 'Account name', 'username'), field('email', 'email', 'Email', 'email'), field('password', 'password', 'Password (8+ characters)', 'new-password'));
  }
  if (error) f.append(el('div', 'color:#fca5a5;margin-top:6px', error));
  const row = el('div', 'display:flex;gap:8px;margin-top:8px;flex-wrap:wrap');
  const go = el('button', BUTTON, busy ? 'Working...' : made ? 'Try again' : 'Create account');
  go.type = 'submit';
  go.disabled = busy;
  row.append(go);
  if (canClose) {
    const x = el('button', QUIET, 'Not now');
    x.type = 'button';
    x.onclick = () => { formOpen = false; error = ''; paint(); };
    row.append(x);
  } else {
    const leave = el('button', QUIET, 'Leave');
    leave.type = 'button';
    leave.onclick = () => hooks?.leave();
    row.append(leave);
  }
  f.append(row);
  f.onsubmit = (e) => {
    e.preventDefault();
    const v = (n: string) => (f.querySelector<HTMLInputElement>(`input[data-field="${n}"]`)?.value ?? '').trim();
    void submit(v('username'), v('email'), (f.querySelector<HTMLInputElement>('input[data-field="password"]')?.value ?? ''));
  };
  return f;
}

async function submit(username: string, email: string, password: string): Promise<void> {
  if (busy || !hooks) return;
  error = '';
  busy = true;
  paint();
  if (!made) {
    const r = await hooks.register(username, email, password);
    if (!r.success || !r.token) { busy = false; error = r.error || 'Could not make the account.'; paint(); return; }
    made = { token: r.token, username: r.username ?? username };
  }
  hooks.send({ type: 'convertGuest', token: made.token });
}
