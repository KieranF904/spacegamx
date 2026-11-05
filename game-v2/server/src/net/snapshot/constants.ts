/**
 * The snapshot path's tuning: how often and how far things are sent (moved verbatim from GameServer).
 */

/** Projectiles and loot further than this aren't sent at all */
export const SNAP_PROJECTILE_RANGE = 12000;
export const SNAP_POD_RANGE = 3000;
/**
 * The furthest a client sees ships, by the old 40 km view circle's exit (the focus grid replaced the circle, net/cells/FocusCells.ts):
 * combat effects reach this far, and SimLod wakes ships past it. Well past the furthest flight zoom (about 24 km
 * across half a 1080p screen).
 */
export const SHIP_VIEW_OUT = 48000;
/** Ships past the view go to the system map this often (ticks) */
export const MAP_DOTS_TICKS = 60;
/** Messages that can wait for the next frame (see Outbox.lazy), and for how many ticks at most */
export const LAZY_TYPES = new Set(['damage', 'projectileHit', 'partDestroyed', 'contact', 'detonation', 'ignite', 'stationFire']);
export const LAZY_TICKS = 2;
/**
 * Coalescing (CAPS.COALESCE, with PACKED: PackedLink.ts): a frame with nothing urgent waits up to this many ticks for
 * the next, and they go as one WebSocket message. The client is told it (netCaps.hold) and widens its interpolation
 * delay by as much. 3 ticks (one snapshot) halves an idle client's messages at most; 6 merges more for 50 ms more delay
 */
export const COALESCE_TICKS = 3;

/** Combat effects (hits, damage numbers, parts blown off) only go to clients this near them */
export const FX_RANGE = SHIP_VIEW_OUT;
/** Debris a client was told to work out itself waits this long (plus twice its ping) for its confirmation, then goes as any ship does */
export const DEBRIS_ACK_TICKS = 30;
