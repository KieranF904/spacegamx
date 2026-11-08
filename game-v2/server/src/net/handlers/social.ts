/**
 * @contract server.net.handlers.social
 * owns:       friends, status and private-message handlers forwarding to game/social/Social.ts
 * needs:      HandlerRegistry (net/dispatch.ts), ServerCtx, ClientConnection, the game modules reached through ctx;
 *             @space-game/common
 * invariants: the types it registers are part of the pinned dispatched set — server/src/golden/structure.test.ts
 * extend:     a new social message is a t.on line forwarding to Social, which checks every field
 */

/**
 * Friends, status and private messages: each message forwards to game/social/Social.ts, which checks every field.
 */
import type { HandlerRegistry } from '../dispatch.js';

export function registerSocialHandlers(t: HandlerRegistry): void {
  t.on('whisper', (ctx, conn, msg) => { ctx.social.whisper(conn, msg.to, msg.text); });
  t.on('friendRequest', (ctx, conn, msg) => { ctx.social.request(conn, msg.name); });
  t.on('friendRespond', (ctx, conn, msg) => { ctx.social.respond(conn, msg.name, msg.accept); });
  t.on('friendRemove', (ctx, conn, msg) => { ctx.social.remove(conn, msg.name); });
  t.on('setStatus', (ctx, conn, msg) => { ctx.social.setStatus(conn, msg.status); });
}
