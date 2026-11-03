/**
 * The snapshot path's tuning: how often and how far things are sent (moved verbatim from GameServer).
 */

/** A pilot's own ship is resent at least this often, even when its prediction is spot on */
export const SELF_SAFETY_TICKS = 120;
/** Projectiles and loot further than this aren't sent at all */
export const SNAP_PROJECTILE_RANGE = 12000;
export const SNAP_POD_RANGE = 3000;
/**
 * A client's view of the ships: those within SHIP_VIEW_IN come into it, and leave
 * past SHIP_VIEW_OUT (the gap stops one at the edge flickering in and out). Both
 * are well past the furthest flight zoom (about 24 km across half a 1080p screen).
 * Party members and your target are always in view.
 */
export const SHIP_VIEW_IN = 40000;
export const SHIP_VIEW_OUT = 48000;
/** Ships past the view go to the system map this often (ticks) */
export const MAP_DOTS_TICKS = 60;
/** Messages that can wait for the next frame (see Outbox.lazy), and for how many ticks at most */
export const LAZY_TYPES = new Set(['damage', 'projectileHit', 'partDestroyed', 'contact', 'detonation', 'ignite', 'stationFire']);
export const LAZY_TICKS = 2;

/** Combat effects (hits, damage numbers, parts blown off) only go to clients this near them */
export const FX_RANGE = SHIP_VIEW_OUT;
/** Debris a client was told to work out itself waits this long (plus twice its ping) for its confirmation, then goes as any ship does */
export const DEBRIS_ACK_TICKS = 30;
