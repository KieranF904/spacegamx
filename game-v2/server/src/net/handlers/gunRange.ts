/**
 * @contract server.net.handlers.gun-range
 * owns:       the gun range's two messages: going in (gunRangeEnter, from a berth) and picking the weapon (gunRangeWeapon)
 * needs:      HandlerRegistry (net/dispatch.ts), ServerCtx (gunRange)
 * invariants: the types it registers are pinned — server/src/golden/clientMessages.json
 * extend:     a new gun range message is one t.on here and a member of common network/gunRangeProtocol.ts
 *
 * Leaving has no message: X (interact) at the door, net/handlers/flight.ts handleInteract asks the range first.
 */
import type { HandlerRegistry } from '../dispatch.js';

export function registerGunRangeHandlers(t: HandlerRegistry): void {
  t.on('gunRangeEnter', (ctx, conn) => {
    ctx.gunRange.enter(conn);
  });
  t.on('gunRangeWeapon', (ctx, conn, msg) => {
    ctx.gunRange.pick(conn, typeof msg.model === 'string' ? msg.model : '');
  });
}
