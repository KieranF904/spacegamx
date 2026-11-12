/**
 * A signed-in pilot's own pages (signed out: to sign in and back). Everything is read from the lobby with the pilot's
 * own session (playerLobby.ts), so it is their account's and nobody else's.
 *   GET  /account/donations          their donations (date, amount, status) and total
 *   GET  /account/inbox              their inbox, the same one the game shows; unread marked
 *   GET  /account/inbox/:id          one message; opening it marks it read (in the game too)
 *   POST /account/inbox/read-all     mark everything read
 *   POST /account/inbox/:id/delete   delete a message (as the game's Delete)
 */

import type { Ctx } from '../app.js';
import { redirect } from '../http.js';
import { httpPlayerLobby, type PlayerLobby } from '../playerLobby.js';
import { inboxPage, messagePage, myDonationsPage } from '../views/mine.js';
import type { RouteEnv } from './env.js';

/** A message id from the path, or null */
function idOf(v: string): number | null {
  return /^\d{1,15}$/.test(v) && Number(v) > 0 ? Number(v) : null;
}

export function registerMine(env: RouteEnv, lobby: PlayerLobby = httpPlayerLobby(env.cfg.lobbyUrl)): void {
  /** The visitor's session token, or null after sending them to sign in */
  function session(ctx: Ctx): string | null {
    if (ctx.user && ctx.token) return ctx.token;
    redirect(ctx.res, `/signin?next=${encodeURIComponent(ctx.path)}`);
    return null;
  }

  env.router.get('/account/donations', async (ctx) => {
    const token = session(ctx);
    if (!token) return;
    const d = await lobby.donations(token, ctx.ip);
    env.page(ctx, d ? 200 : 503, myDonationsPage(ctx.page, d));
  });

  env.router.get('/account/inbox', async (ctx) => {
    const token = session(ctx);
    if (!token) return;
    const box = await lobby.inbox(token, ctx.ip);
    env.page(ctx, box ? 200 : 503, inboxPage(ctx.page, box));
  });

  env.router.get('/account/inbox/:id', async (ctx, p) => {
    const token = session(ctx);
    if (!token) return;
    const id = idOf(p.id);
    const box = id === null ? null : await lobby.inbox(token, ctx.ip);
    // (Only a message in this pilot's own list: another account's id is "not found")
    const m = box?.messages.find((x) => x.id === id);
    if (!m) { env.notFound(ctx, 'message'); return; }
    if (m.readAt === null) await lobby.markRead(token, ctx.ip, m.id);
    env.page(ctx, 200, messagePage(ctx.page, m));
  });

  env.router.post('/account/inbox/read-all', async (ctx) => {
    const token = session(ctx);
    if (!token) return;
    await lobby.markRead(token, ctx.ip, 'all');
    redirect(ctx.res, '/account/inbox');
  });

  env.router.post('/account/inbox/:id/delete', async (ctx, p) => {
    const token = session(ctx);
    if (!token) return;
    const id = idOf(p.id);
    if (id !== null) await lobby.remove(token, ctx.ip, id);
    redirect(ctx.res, '/account/inbox');
  });
}
