/**
 * StateRing: the last k ticks of every ship's SimShipState, and a hash per ship per tick and per tick (sim
 * foundation; the API and the hashed fields are the Stage 0 contract, Stage 1C replaces ShipReplicaSet's
 * pend/hist/rewind with it and may change the storage, not the API).
 *
 * ## Hashed (shipHash), exactly: every number's float64 bits (-0 as 0), in this order
 * id, mode, structure.version; body x, y, vx, vy, angle, angVel, jump, jumpScale (absent: 1), cargo, dodge,
 * dodgeDir, and while a charge has its lock jumpAim, jumpTo (absent: neither); ctl.bits, ctl.q; jumpPrime; hazard empUntil, slowUntil, numb; accounted; when accounted the charge
 * (g, b[], eng[], gun[], and a ports ship's held/amt/closed/aug/flags/mat/sat, shieldSat, gauge); guns cooldown[],
 * rounds[], reload[], charge[], spin[], aim[], triggerHeld, clickAt, minePaid, mineUntil, mineShare, tow.
 * Not hashed: `structure` itself (only its version), an unaccounted charge (a replica's FULL_CHARGE stand-in).
 *
 * The tick hash folds the ship hashes in ascending id order.
 *
 * ## API (contract; settled in Stage 3 with Stage 1C's additions)
 * put (a copy), keep (by reference: the caller hands the state over, e.g. a ReplicaState), get, has, hash, tickHash,
 * last, first, size, ticks, ids, dropFrom, delete (one tick), remove (one ship), clear.
 */

import type { SimShipState } from './state.js';
import { cloneSimShip } from './state.js';

const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);

const mix = (h: number, v: number) => Math.imul(h ^ v, 0x9e3779b1) ^ (Math.imul(h, 0x85ebca6b) >>> 13);

function num(h: number, v: number | undefined): number {
  f64[0] = v === undefined ? NaN : v === 0 ? 0 : v;
  return mix(mix(h, u32[0]), u32[1]);
}

function arr(h: number, a: ArrayLike<number> | undefined): number {
  if (!a) return mix(h, 0x7fffffff);
  h = mix(h, a.length);
  for (let i = 0; i < a.length; i++) h = num(h, a[i]);
  return h;
}

function fin(h: number): number {
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return h >>> 0;
}

/** 32-bit hash of a ship's per-tick state (the fields listed above) */
export function shipHash(s: Readonly<SimShipState>): number {
  let h = 0x2545f491;
  h = num(h, s.id); h = num(h, s.mode); h = num(h, s.structure.version);
  const b = s.body;
  h = num(h, b.x); h = num(h, b.y); h = num(h, b.vx); h = num(h, b.vy); h = num(h, b.angle); h = num(h, b.angVel);
  h = num(h, b.jump ?? 0); h = num(h, b.jumpScale ?? 1); h = num(h, b.cargo ?? 0); h = num(h, b.dodge ?? 0); h = num(h, b.dodgeDir ?? 0);
  // (A charging jump's locked heading and distance, while it has them: flight.ts FlightBody.jumpAim)
  if (b.jumpAim !== undefined) { h = num(h, b.jumpAim); h = num(h, b.jumpTo ?? 0); }
  h = num(h, s.ctl.bits); h = num(h, s.ctl.q); h = num(h, s.jumpPrime);
  h = num(h, s.hazard.empUntil); h = num(h, s.hazard.slowUntil); h = num(h, s.hazard.numb);
  h = num(h, s.accounted ? 1 : 0);
  if (s.accounted) {
    const c = s.charge;
    h = num(h, c.g); h = arr(h, c.b); h = arr(h, c.eng); h = arr(h, c.gun);
    if (c.e) { h = arr(h, c.e.held); h = arr(h, c.e.amt); h = arr(h, c.e.closed); h = arr(h, c.e.aug); h = arr(h, c.e.flags); h = arr(h, c.e.mat); h = arr(h, c.e.sat); h = num(h, c.e.shieldSat); h = num(h, c.e.gauge); }
  }
  const g = s.guns;
  h = arr(h, g.cooldown); h = arr(h, g.rounds); h = arr(h, g.reload); h = arr(h, g.charge); h = arr(h, g.spin); h = arr(h, g.aim);
  h = num(h, g.triggerHeld ? 1 : 0); h = num(h, g.clickAt); h = num(h, g.minePaid); h = num(h, g.mineUntil); h = num(h, g.mineShare); h = num(h, g.tow);
  // (A pilot's held aim distance only while its trigger is held: idle, its guns step on the cursor's, guns.ts distDue)
  if (g.triggerHeld && g.heldDist !== undefined) h = num(h, g.heldDist);
  // (The trigger word, once a group is selected: with "all" on both it is the buttons, which triggerHeld has)
  if (g.trig !== undefined && g.trig > 3) h = num(h, g.trig);
  // (Who a waiting click is for, once it is not every gun: a group change or the other button pressed while held)
  if (g.clickMasks !== undefined) h = num(h, g.clickMasks);
  return fin(h);
}

/** The tick hash: ship hashes folded in ascending id order */
export function tickHash(ships: Iterable<Readonly<SimShipState>>): number {
  const list = [...ships].sort((a, b) => a.id - b.id);
  let h = 0x6a09e667;
  for (const s of list) h = mix(h, shipHash(s));
  return fin(h);
}

/** One ship's ticks: states by tick, hashes worked out when first asked (a stored state never changes), its span */
interface Track {
  by: Map<number, SimShipState>;
  hashes: Map<number, number>;
  /** Lowest tick that may be held (a lower bound: pruning and `first` walk up from it) */
  lo: number;
  /** Highest tick held (exact while anything is held) */
  hi: number;
}

const NOTHING = new Map<number, SimShipState>();

/**
 * k ticks of states per ship. `put` stores a copy (later mutation of the caller's object can't reach the ring);
 * `get` returns the stored object, read-only by contract (clone it to step from it: stepShip does).
 *
 * (Stage 1C internals: a ship's hash is worked out the first time it's asked for, from the stored state, so storing
 * costs no hash; the window is pruned from its low end rather than by walking every tick held. Beyond the Stage 0
 * API, additive: `keep` stores without the copy, for a caller that hands the object over (the replica set's per-tick
 * states, network/replication.ts); `has`, `first`, `size`, `ticks`, `delete`, `clear`.)
 */
export class StateRing {
  private readonly tracks = new Map<number, Track>();

  constructor(readonly k = 64) {}

  put(t: number, s: Readonly<SimShipState>): void {
    this.keep(t, cloneSimShip(s));
  }

  /** Store `s` itself for ship `id` (default s.id): the caller hands it over and must not change it after */
  keep(t: number, s: SimShipState, id: number = s.id): void {
    let tr = this.tracks.get(id);
    if (!tr) this.tracks.set(id, (tr = { by: new Map(), hashes: new Map(), lo: t, hi: t }));
    if (!tr.by.size) { tr.lo = t; tr.hi = t; }
    tr.by.set(t, s);
    tr.hashes.delete(t);
    if (t > tr.hi) tr.hi = t;
    if (t < tr.lo) tr.lo = t;
    const floor = tr.hi - this.k;
    if (tr.lo <= floor) {
      // (Walked up from the low end when that's shorter than walking what's held)
      if (floor - tr.lo < tr.by.size) { for (let u = tr.lo; u <= floor; u++) if (tr.by.delete(u)) tr.hashes.delete(u); }
      else for (const u of [...tr.by.keys()]) if (u <= floor) { tr.by.delete(u); tr.hashes.delete(u); }
      tr.lo = floor + 1;
    }
  }

  get(id: number, t: number): Readonly<SimShipState> | undefined {
    return this.tracks.get(id)?.by.get(t);
  }

  has(id: number, t: number): boolean {
    return this.tracks.get(id)?.by.has(t) ?? false;
  }

  hash(id: number, t: number): number | undefined {
    const tr = this.tracks.get(id);
    if (!tr) return undefined;
    let h = tr.hashes.get(t);
    if (h === undefined) {
      const s = tr.by.get(t);
      if (!s) return undefined;
      tr.hashes.set(t, (h = shipHash(s)));
    }
    return h;
  }

  /** The tick hash over every ship held at t (ascending ids) */
  tickHash(t: number): number {
    const ids = [...this.tracks.keys()].filter((id) => this.tracks.get(id)!.by.has(t)).sort((a, b) => a - b);
    let h = 0x6a09e667;
    for (const id of ids) h = mix(h, this.hash(id, t)!);
    return fin(h);
  }

  /** The newest tick held for a ship */
  last(id: number): number | undefined {
    const tr = this.tracks.get(id);
    return tr && tr.by.size ? tr.hi : undefined;
  }

  /** The oldest tick held for a ship */
  first(id: number): number | undefined {
    const tr = this.tracks.get(id);
    if (!tr || !tr.by.size) return undefined;
    if (tr.hi - tr.lo > 4 * tr.by.size) { let lo = Infinity; for (const k of tr.by.keys()) if (k < lo) lo = k; tr.lo = lo; }
    while (!tr.by.has(tr.lo)) tr.lo++;
    return tr.lo;
  }

  /** How many ticks are held for a ship */
  size(id: number): number {
    return this.tracks.get(id)?.by.size ?? 0;
  }

  /** A ship's held ticks, in no particular order */
  ticks(id: number): IterableIterator<number> {
    return (this.tracks.get(id)?.by ?? NOTHING).keys();
  }

  /** Forget a ship's ticks >= t (it will be re-stepped from t - 1) */
  dropFrom(id: number, t: number): void {
    const tr = this.tracks.get(id);
    if (!tr || !tr.by.size || t > tr.hi) return;
    if (t > tr.lo && tr.hi - t < tr.by.size) { for (let u = t; u <= tr.hi; u++) if (tr.by.delete(u)) tr.hashes.delete(u); }
    else for (const u of [...tr.by.keys()]) if (u >= t) { tr.by.delete(u); tr.hashes.delete(u); }
    if (!tr.by.size) return;
    // (The newest left: usually just below t)
    let u = Math.min(t, tr.hi + 1) - 1;
    if (u - tr.lo <= 4 * tr.by.size) { while (!tr.by.has(u)) u--; tr.hi = u; }
    else { let hi = -Infinity; for (const k of tr.by.keys()) if (k > hi) hi = k; tr.hi = hi; }
  }

  /** Forget one tick of a ship's */
  delete(id: number, t: number): void {
    const tr = this.tracks.get(id);
    if (!tr || !tr.by.has(t)) return;
    if (t === tr.hi) { this.dropFrom(id, t); return; }
    tr.by.delete(t);
    tr.hashes.delete(t);
  }

  remove(id: number): void {
    this.tracks.delete(id);
  }

  clear(): void {
    this.tracks.clear();
  }

  ids(): IterableIterator<number> {
    return this.tracks.keys();
  }
}
