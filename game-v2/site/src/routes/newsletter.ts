/**
 * The email newsletter's consent on the website (signed-in accounts only; the lobby keeps the answer and takes it for
 * the session's own account: server-browser/src/newsletter). All POST, so all behind the site's CSRF check.
 *   POST /account/newsletter/answer { newsletter: yes|no, back }   the one-time question's answer (via 'prompt')
 *   POST /account/newsletter/later  { back }                       not now: hidden for this browser session, still not asked
 *   POST /account/newsletter/set    { newsletter: yes|no }         the account page's setting (via 'settings')
 * Sign-up asks in the form itself (app.ts auth, views/newsletter.ts newsletterChoice).
 */

import type { Ctx } from '../app.js';
import { redirect, str } from '../http.js';
import { cookie } from '../security.js';
import { readChoice } from '../views/newsletter.js';
import type { RouteEnv } from './env.js';

/** The cookie that holds the question back until the browser is closed ("Ask me later") */
export const LATER_COOKIE = 'nl_later';

/** A path on this site to go back to (never another site's address) */
export function safeBack(v: unknown): string {
  const s = typeof v === 'string' ? v : '';
  return /^\/(?![/\\])[^\s\\]{0,300}$/.test(s) && !s.startsWith('/account/newsletter') ? s : '/';
}

/** The path with the note to show after the redirect (?ok=...), before any #fragment */
function withOk(to: string, ok: string): string {
  const [path, hash] = to.split('#');
  return `${path}${path.includes('?') ? '&' : '?'}ok=${ok}${hash ? `#${hash}` : ''}`;
}

export function registerNewsletter(env: RouteEnv): void {
  /** The visitor's session token, or null after sending them to sign in */
  function session(ctx: Ctx): string | null {
    if (ctx.user && ctx.token) return ctx.token;
    redirect(ctx.res, '/signin?next=/account');
    return null;
  }

  async function save(ctx: Ctx, via: 'prompt' | 'settings', back: string): Promise<void> {
    const token = session(ctx);
    if (!token) return;
    const f = await env.fields(ctx);
    const answer = readChoice(str(f.newsletter, 8));
    const to = via === 'prompt' ? safeBack(f.back) : back;
    // (No answer is no change: they stay as they were, asked or not)
    if (answer === null) { redirect(ctx.res, to); return; }
    const r = await env.lobby.setNewsletter(token, answer, via, ctx.ip);
    // (The cached session says "not asked": dropped, so the question goes away at once)
    env.forgetSession(token);
    redirect(ctx.res, withOk(to, r.ok ? (answer ? 'newsletter-on' : 'newsletter-off') : 'newsletter-failed'));
  }

  env.router.post('/account/newsletter/answer', (ctx) => save(ctx, 'prompt', '/'));
  env.router.post('/account/newsletter/set', (ctx) => save(ctx, 'settings', '/account#newsletter'));

  env.router.post('/account/newsletter/later', async (ctx) => {
    if (!session(ctx)) return;
    const f = await env.fields(ctx);
    // (A session cookie: gone when the browser closes, so the next visit asks again. Nothing is recorded)
    env.setCookie(ctx, cookie(LATER_COOKIE, '1', { secure: env.cfg.secureCookies }));
    redirect(ctx.res, safeBack(f.back));
  });
}
