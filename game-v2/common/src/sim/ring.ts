/**
 * StateRing: the last k ticks of every ship's SimShipState, and a hash per ship per tick and per tick (sim
 * foundation; the API and the hashed fields are the Stage 0 contract, Stage 1C replaces ShipReplicaSet's
 * pend/hist/rewind with it and may change the storage, not the API).
 *
 * ## Hashed (shipHash), exactly: every number's float64 bits (-0 as 0), in this order
 * id, mode, structure.version; body x, y, vx, vy, angle, angVel, jump, jumpScale (absent: 1), cargo, dodge,
 * dodgeDir; ctl.bits, ctl.q; jumpPrime; hazard empUntil, slowUntil, numb; accounted; when accounted the charge
 * (g, b[], eng[], gun[], and a ports ship's held/amt/closed/aug/flags/mat/sat, shieldSat, gauge); guns cooldown[],
 * rounds[], reload[], charge[], spin[], aim[], triggerHeld, clickAt, minePaid, mineUntil, mineShare, tow.
 * Not hashed: `structure` itself (only its version), an unaccounted charge (a replica's FULL_CHARGE stand-in).
 *
 * The tick hash folds the ship hashes in ascending id order.
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
  return fin(h);
}

/** The tick hash: ship hashes folded in ascending id order */
export function tickHash(ships: Iterable<Readonly<SimShipState>>): number {
  const list = [...ships].sort((a, b) => a.id - b.id);
  let h = 0x6a09e667;
  for (const s of list) h = mix(h, shipHash(s));
  return fin(h);
}

/**
 * k ticks of states per ship. `put` stores a copy (later mutation of the caller's object can't reach the ring);
 * `get` returns the stored object, read-only by contract (clone it to step from it: stepShip does).
 */
export class StateRing {
  private readonly by = new Map<number, Map<number, SimShipState>>();
  private readonly hashes = new Map<number, Map<number, number>>();

  constructor(readonly k = 64) {}

  put(t: number, s: Readonly<SimShipState>): void {
    let m = this.by.get(s.id), hm = this.hashes.get(s.id);
    if (!m) this.by.set(s.id, (m = new Map()));
    if (!hm) this.hashes.set(s.id, (hm = new Map()));
    m.set(t, cloneSimShip(s));
    hm.set(t, shipHash(s));
    if (m.size > this.k) for (const old of [...m.keys()]) if (old <= t - this.k) { m.delete(old); hm.delete(old); }
  }

  get(id: number, t: number): Readonly<SimShipState> | undefined {
    return this.by.get(id)?.get(t);
  }

  hash(id: number, t: number): number | undefined {
    return this.hashes.get(id)?.get(t);
  }

  /** The tick hash over every ship held at t (ascending ids) */
  tickHash(t: number): number {
    const ids = [...this.by.keys()].filter((id) => this.by.get(id)!.has(t)).sort((a, b) => a - b);
    let h = 0x6a09e667;
    for (const id of ids) h = mix(h, this.hashes.get(id)!.get(t)!);
    return fin(h);
  }

  /** The newest tick held for a ship */
  last(id: number): number | undefined {
    const m = this.by.get(id);
    if (!m || m.size === 0) return undefined;
    let best = -Infinity;
    for (const t of m.keys()) if (t > best) best = t;
    return best;
  }

  /** Forget a ship's ticks >= t (it will be re-stepped from t - 1) */
  dropFrom(id: number, t: number): void {
    const m = this.by.get(id), hm = this.hashes.get(id);
    if (!m) return;
    for (const k of [...m.keys()]) if (k >= t) { m.delete(k); hm!.delete(k); }
  }

  remove(id: number): void {
    this.by.delete(id);
    this.hashes.delete(id);
  }

  ids(): IterableIterator<number> {
    return this.by.keys();
  }
}
