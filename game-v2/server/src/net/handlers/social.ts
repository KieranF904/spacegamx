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
