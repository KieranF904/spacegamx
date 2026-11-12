/**
 * @contract server.net.handlers.gun-range
 * owns:       the gun range's messages: going in (gunRangeEnter, from a berth), picking the weapon (gunRangeWeapon)
 *             and an admin's pick of a library ship (gunRangeShip: the module refuses anyone else)
 * needs:      HandlerRegistry (net/dispatch.ts), ServerCtx (gunRange)
 * invariants: the types it registers are pinned — server/src/golden/clientMessages.json
 * extend:     a new gun range message is one t.on here and a member of common network/gunRangeProtocol.ts
 *
 * Leaving has no message, nor has going to another room: X (interact) at a door, net/handlers/flight.ts handleInteract asks the range first.
 */
import type { HandlerRegistry } from '../dispatch.js';

export function registerGunRangeHandlers(t: HandlerRegistry): void {
  t.on('gunRangeEnter', (ctx, conn) => {
    ctx.gunRange.enter(conn);
  });
  t.on('gunRangeWeapon', (ctx, conn, msg) => {
    ctx.gunRange.pick(conn, typeof msg.model === 'string' ? msg.model : '', msg.mods);
  });
  t.on('gunRangeShip', (ctx, conn, msg) => {
    ctx.gunRange.pickShip(conn, msg.ship);
  });
}
