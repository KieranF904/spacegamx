/**
 * The admin panel's Chat tab (admins and the owner only): talk to pilots who are in the game, from the website.
 *   GET  /admin/chat[?server=&with=]        who is on, and the conversation (with everyone on a server, or one pilot)
 *   GET  /admin/chat/feed[?server=&with=]   JSON { online, log } (HTML fragments): the page's refresh, every few seconds
 *   POST /admin/chat/send  { server, with?, text }   to everyone on the server, or privately to `with`
 *   POST /admin/chat/inbox { with, text }            left in an offline pilot's in-game inbox instead
 * The posts are behind the site's CSRF check. Everything goes through the lobby with the admin secret, here on the
 * server (../adminChat.ts); the lobby checks the admin's name again and logs each message with it.
 */

import type { Ctx } from '../app.js';
import { httpAdminChat, type AdminChatApi, type SendResult } from '../adminChat.js';
import { redirect, sendJson, str } from '../http.js';
import { adminChatPage, chatLog, onlineList, pickServer, CHAT_TEXT_MAX } from '../views/adminChat.js';
import type { RouteEnv } from './env.js';

/** Sends an admin may make a minute from the site (the lobby has its own limit too) */
export const CHAT_SEND_RULE = { limit: 30, windowMs: 60_000 };

/** Why a send didn't go, for the page after a redirect (fixed lines: nothing from the request is shown) */
const WHY: Record<string, string> = {
  offline: 'They are not online, so it was not sent.',
  slow: 'Too many messages sent lately. Wait a minute and try again.',
  empty: 'Write a message first.',
  failed: 'It could not be sent. Try again in a moment.',
  noinbox: 'It could not be left in an inbox: only an account has one.',
};

function wantsJson(ctx: Ctx): boolean {
  return String(ctx.req.headers.accept ?? '').includes('application/json');
}

const here = (server: string, pilot: string, why = '') =>
  `/admin/chat?server=${encodeURIComponent(server)}${pilot ? `&with=${encodeURIComponent(pilot)}` : ''}${why ? `&why=${why}` : ''}`;

export function registerAdminChat(env: RouteEnv, api: AdminChatApi = httpAdminChat(env.cfg.lobbyUrl, env.cfg.lobbyAdminSecret)): void {
  const asked = (ctx: Ctx) => ({ server: str(ctx.url.searchParams.get('server'), 64), pilot: str(ctx.url.searchParams.get('with'), 40).trim() });

  env.router.get('/admin/chat', async (ctx) => {
    const admin = env.requireAdmin(ctx);
    if (!admin) return;
    const a = asked(ctx);
    // (Which servers there are first, so the conversation asked for is the right server's)
    const first = await api.state(admin.username, { server: a.server, with: a.pilot });
    const server = pickServer(first, a.server);
    const state = first && server !== a.server ? await api.state(admin.username, { server, with: a.pilot }) : first;
    env.page(ctx, state ? 200 : 503, adminChatPage(ctx.page, { state, server, pilot: a.pilot, error: WHY[str(ctx.url.searchParams.get('why'), 12)] }));
  });

  env.router.get('/admin/chat/feed', async (ctx) => {
    const admin = env.requireAdmin(ctx);
    if (!admin) return;
    const a = asked(ctx);
    const state = await api.state(admin.username, { server: a.server, with: a.pilot });
    if (!state) { sendJson(ctx.res, 503, { error: 'unavailable' }); return; }
    sendJson(ctx.res, 200, { online: String(onlineList(state.servers, a.server, a.pilot)), log: String(chatLog(state.messages, a.pilot)) }, { 'Cache-Control': 'no-store' });
  });

  async function post(ctx: Ctx, kind: 'send' | 'inbox'): Promise<void> {
    const admin = env.requireAdmin(ctx);
    if (!admin) return;
    const f = await env.fields(ctx);
    const server = str(f.server, 64), pilot = str(f.with, 40).trim(), text = str(f.text, CHAT_TEXT_MAX + 1).trim();
    const answer = (r: SendResult, why: string) => {
      if (wantsJson(ctx)) sendJson(ctx.res, r.ok ? 200 : r.status === 429 ? 429 : 400, r.ok ? { ok: true } : { ok: false, error: r.error, offline: r.offline === true });
      else redirect(ctx.res, here(server, pilot, r.ok ? '' : why));
    };
    if (!text) return answer({ ok: false, error: WHY.empty, status: 400 }, 'empty');
    if (text.length > CHAT_TEXT_MAX) return answer({ ok: false, error: `The message is too long (${CHAT_TEXT_MAX} characters at most).`, status: 400 }, 'failed');
    if (env.limited(ctx, `adminchat:${admin.id}`, CHAT_SEND_RULE)) return answer({ ok: false, error: WHY.slow, status: 429 }, 'slow');
    const r = kind === 'send' ? await api.send(admin.username, server, pilot, text) : await api.inbox(admin.username, pilot, text);
    answer(r, r.ok ? '' : r.status === 429 ? 'slow' : kind === 'inbox' ? 'noinbox' : r.offline ? 'offline' : 'failed');
  }

  env.router.post('/admin/chat/send', (ctx) => post(ctx, 'send'));
  env.router.post('/admin/chat/inbox', (ctx) => post(ctx, 'inbox'));
}
