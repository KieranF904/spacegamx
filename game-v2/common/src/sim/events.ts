/**
 * What a step produces besides the next state (sim foundation, Stage 0 contract). The step never calls out (no
 * beamFx, scene, gunFeel, gunSync, notifyContact, fireWeapons): it returns events, and each end presents or acts on
 * them after the step. A re-step (rollback) produces the same events again for ticks already presented: consumers
 * dedupe by `eventKey` (a shell already drawn is not fired twice; a fire that a re-step no longer produces is taken back).
 */

/** Ticks a shot id's tick field covers before it wraps (18.2 min at 60 Hz: far past any shot's life) */
export const SHOT_ID_TICKS = 1 << 16;
export const SHOT_ID_OWNERS = 1 << 20;
export const SHOT_ID_SLOTS = 1 << 8;
export const SHOT_ID_BARRELS = 1 << 5;

/**
 * The deterministic shot id: f(owner, tick, gun slot, barrel), the same on every end with no message.
 * `tick` the tick the gun fired on (the step's tick), `slot` the gun's part index (< maxParts 255), `barrel` the
 * shell's place in its volley (volleyShells' index). Packed into 49 bits of a safe integer:
 *   (tick mod 2^16) · 2^33 + owner · 2^13 + slot · 2^5 + barrel
 * Collision-free: two different (owner, tick, slot, barrel) give different ids while their ticks are under 2^16
 * apart and owner < 2^20, slot < 2^8, barrel < 2^5 (out of range throws: a bigger world needs a new layout, not a
 * silent collision). Not a seed: spread and the like keep using ships/rng.ts shotSeed and launch.ts shellSeed.
 */
export function shotId(owner: number, tick: number, slot: number, barrel: number): number {
  if (owner < 0 || owner >= SHOT_ID_OWNERS || slot < 0 || slot >= SHOT_ID_SLOTS || barrel < 0 || barrel >= SHOT_ID_BARRELS || (owner | 0) !== owner || (slot | 0) !== slot || (barrel | 0) !== barrel) {
    throw new RangeError(`shotId out of range: owner ${owner} slot ${slot} barrel ${barrel}`);
  }
  const t = ((tick % SHOT_ID_TICKS) + SHOT_ID_TICKS) % SHOT_ID_TICKS;
  return t * 2 ** 33 + owner * 2 ** 13 + slot * 2 ** 5 + barrel;
}

export function shotIdParts(id: number): { tick16: number; owner: number; slot: number; barrel: number } {
  const t = Math.floor(id / 2 ** 33), rest = id - t * 2 ** 33;
  return { tick16: t, owner: Math.floor(rest / 2 ** 13), slot: Math.floor(rest / 2 ** 5) % SHOT_ID_SLOTS, barrel: rest % SHOT_ID_BARRELS };
}

/**
 * The event union. `tick`: the tick it happened on (the step's). Positions in world units on SHIP_PRECISION.
 * Every field is plain data (numbers, short strings): events cross workers and the wire unchanged.
 */
export type SimEvent =
  /** A gun fired one shell (one per barrel). Shape and spread are re-derived from (owner, slot, tick, aimQ) on every end */
  | { k: 'fire'; tick: number; owner: number; slot: number; barrel: number; shot: number; aimQ: number }
  /** A shell reached the end of its life (deterministic: never sent) */
  | { k: 'shotEnd'; tick: number; shot: number }
  /** A shell struck a ship's part (or a rock: target -1, until rocks are on the tick layer) */
  | { k: 'hit'; tick: number; shot: number; target: number; part: number; x: number; y: number }
  /** Two bodies touched (contacts phase: a < b by id), with the impulse each took */
  | { k: 'contact'; tick: number; a: number; b: number; dvax: number; dvay: number; dvbx: number; dvby: number; speed: number }
  /** A pull acted on a ship (pulls phase): the velocity it added */
  | { k: 'pull'; tick: number; target: number; from: number; dvx: number; dvy: number }
  /** A visual with no effect on state (a pulse starting, a charge tell, a muzzle flash) */
  | { k: 'fx'; tick: number; owner: number; fx: string; part: number; x: number; y: number }
  | { k: 'sound'; tick: number; owner: number; sound: string; x: number; y: number }
  /**
   * Reserved plug-in point for damage (clients don't apply damage yet): what a hit or contact would do to a part.
   * The server applies it; a client may draw it. Never produced by Stage 1 steps
   */
  | { k: 'damage'; tick: number; target: number; part: number; amount: number; source: number };

export type SimEventKind = SimEvent['k'];

/** A key that is equal for the same event produced again by a re-step (consumers dedupe on it) */
export function eventKey(e: SimEvent): string {
  switch (e.k) {
    case 'fire': return `f${e.shot}`;
    case 'shotEnd': return `e${e.shot}`;
    case 'hit': return `h${e.shot}:${e.target}:${e.part}`;
    case 'contact': return `c${e.tick}:${e.a}:${e.b}`;
    case 'pull': return `p${e.tick}:${e.target}:${e.from}`;
    case 'fx': return `x${e.tick}:${e.owner}:${e.part}:${e.fx}`;
    case 'sound': return `s${e.tick}:${e.owner}:${e.sound}`;
    case 'damage': return `d${e.tick}:${e.target}:${e.part}:${e.source}`;
  }
}

/** Where a step's events go: a plain array is enough; the push is the only call a step makes */
export interface EventSink { push(e: SimEvent): void }
