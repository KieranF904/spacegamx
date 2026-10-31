/**
 * Ship energy, a tick at a time, on local circuits (circuits.ts works out
 * the layout once a rebuild; docs/design/energy-system.md, Phase 1).
 *
 * Each circuit keeps its own charge. Each tick, every circuit:
 *
 *   1. Engines first: the ones pushing the way the pilot asks draw (boosting
 *      draws far more, and needs stored charge). They take their circuit's
 *      spare generator stream, then its drive pool, then its general pool
 *      (the main circuit then the core's store), each store giving no more
 *      than its discharge rate.
 *   2. Then the guns and mining lasers: a gun draws while it reloads (a
 *      shot's energy, spread over its reload), a beam while it burns, a
 *      mining laser while it cuts. They take what's left of the stream, then
 *      the weapon pool, then the general pool (main circuit: then the core).
 *   3. A capacitor bank tops up the consumers it touches, then the core's
 *      trickle tops up what's still short on every other circuit and on parts
 *      on no circuit, shared by what each is short.
 *   4. What a circuit couldn't give, its consumers lack in proportion: a
 *      brownout. Engines push that much less, guns reload that much slower,
 *      beams burn that share of the time. What its stream had left charges
 *      its own stores (and the main circuit's, the core's), the emptiest most.
 *
 * Steady loads (shields, scanners, jump coils) share their circuit's
 * generators at the rebuild, before any of this (rebuild.ts), as before.
 *
 * Charge travels (and is predicted) as a percentage per store group plus
 * the core's. The same steps run on the server and on the pilot's client.
 */

import type { ShipDerived } from './rebuild.js';
import type { ShipTuning } from './tuning.js';
import type { Vec2 } from './types.js';
import type { PowerLayout } from './circuits.js';

export interface EnergyInfo {
  /** Capacity of each kind of store (energy units: power × seconds): general (the core's and batteries), drive (engines only), weapon (guns and lasers only: weapon batteries and capacitor banks) */
  max: number;
  driveMax: number;
  weaponMax: number;
  /** Generator power left after the steady loads (power units: per second), every circuit together */
  spare: number;
  /** Total generator power */
  supply: number;
  /** What the engines draw at full thrust, and the mining lasers while mining (per second) */
  engineDraw: number;
  minerDraw: number;
  /** What the guns draw firing flat out (per second), for ratings and the hangar */
  weaponDraw: number;
}

/**
 * The charge: the core's store and each store group's (ShipDerived.power.stores
 * order), as percentages of what they hold; a group with no entry is full.
 * `eng` and `gun` are this tick's shares of their power each feed group got
 * (powerTick): never sent, worked out afresh every tick.
 */
export interface Charge {
  core: number;
  s: number[];
  eng?: number[];
  gun?: number[];
}

export const FULL_CHARGE: Charge = { core: 100, s: [] };

/**
 * The pilot's own snapshot row carries the charge (GameServer, GameState): data[1] the whole ship's (the gauge),
 * data[10] the core's store, data[11] how many store groups follow, and each group's from data[CHARGE_GROUPS_AT]
 * (at most MAX_CHARGE_GROUPS; any past that are taken as full). Hundredths of a percent.
 */
export const CHARGE_GROUPS_AT = 16;
export const MAX_CHARGE_GROUPS = 24;
const hundredths = (v: number) => Math.round(pctOf(v) * 100) / 100;

/** The charge's fields for the snapshot row: [core, count, groups] */
export function packCharge(d: ShipDerived | undefined, c: Charge): { total: number; core: number; groups: number[] } {
  const n = Math.min(MAX_CHARGE_GROUPS, d?.power?.stores.length ?? 0);
  return { total: d ? hundredths(chargeTotal(d, c)) : 100, core: hundredths(c.core), groups: Array.from({ length: n }, (_, i) => hundredths(c.s[i] ?? 100)) };
}

/** The charge a snapshot row says (data as packed above; an old row: full) */
export function unpackCharge(data: number[] | undefined): Charge {
  if (!data || data.length <= 11) return { core: 100, s: [] };
  const n = Math.max(0, Math.min(MAX_CHARGE_GROUPS, data[11] | 0));
  return { core: data[10] ?? 100, s: data.slice(CHARGE_GROUPS_AT, CHARGE_GROUPS_AT + n).map((v) => (Number.isFinite(v) ? v : 100)) };
}
/** Mining lasers' old payment segment (ticks): kept for the tick alignment of their pulse */
export const MINE_SEGMENT = 15;
/** A mining laser's pulse (ticks): once started it runs to its end, whether or not the button's still held; it just isn't followed by another */
export const MINE_CYCLE = 54;

export const ENERGY_DEFAULTS = { coreCapacity: 240, boostDraw: 2.8 };

/** Each tuning's energy settings, worked out once (this runs for every ship every tick) */
const energyTunings = new WeakMap<ShipTuning, typeof ENERGY_DEFAULTS>();

export function energyTuning(t: ShipTuning): typeof ENERGY_DEFAULTS {
  let e = energyTunings.get(t);
  if (!e) energyTunings.set(t, (e = { ...ENERGY_DEFAULTS, ...((t as { energy?: Partial<typeof ENERGY_DEFAULTS> }).energy ?? {}) }));
  return e;
}

/** A share counts as a brownout below this */
export const BROWNOUT = 0.995;

const pct = (v: number, max: number) => (max <= 0 ? 100 : Math.round(Math.max(0, Math.min(100, (v / max) * 100)) * 1000) / 1000);
const pctOf = (v: number | undefined) => (v === undefined || !Number.isFinite(v) ? 100 : Math.max(0, Math.min(100, v)));

/** Energy held in a store group, and in the core */
export function storeHeld(d: ShipDerived, c: Charge, s: number): number {
  const g = d.power?.stores[s];
  return g ? (g.cap * pctOf(c.s[s])) / 100 : 0;
}
export function coreHeld(d: ShipDerived, c: Charge): number {
  return d.power?.core ? (d.power.core.cap * pctOf(c.core)) / 100 : 0;
}

/** All the ship's stored energy as one percentage (the HUD's gauge) */
export function chargeTotal(d: ShipDerived, c: Charge): number {
  const L = d.power;
  if (!L) return 100;
  let held = coreHeld(d, c), max = L.core?.cap ?? 0;
  L.stores.forEach((g, s) => { held += storeHeld(d, c, s); max += g.cap; });
  return max <= 0 ? 0 : Math.round((held / max) * 1000) / 10;
}

/** Stored energy the engines (or the guns) can reach anywhere on the ship */
export function storedFor(d: ShipDerived, c: Charge, use: 'drive' | 'weapon'): number {
  const L = d.power;
  if (!L) return 0;
  let h = coreHeld(d, c);
  L.stores.forEach((g, s) => { if (g.kind === 'g' || g.kind === 'k' || g.kind === (use === 'drive' ? 'd' : 'w')) h += storeHeld(d, c, s); });
  return h;
}

/** Each circuit's charge (its pools and banks together) as a percentage, and what it holds full; the core's last (letter 'core') */
export function circuitCharges(d: ShipDerived, c: Charge): { circuit: number; letter: string; pct: number; cap: number; main: boolean }[] {
  const L = d.power;
  if (!L) return [];
  const out: { circuit: number; letter: string; pct: number; cap: number; main: boolean }[] = [];
  L.circuits.forEach((ci, k) => {
    const groups = [ci.pools.g, ci.pools.d, ci.pools.w, ...ci.banks].filter((s) => s >= 0);
    const cap = groups.reduce((t, s) => t + L.stores[s].cap, 0);
    if (!ci.letter && !cap) return;
    const held = groups.reduce((t, s) => t + storeHeld(d, c, s), 0);
    out.push({ circuit: k, letter: ci.letter || '·', pct: cap > 0 ? (held / cap) * 100 : 0, cap, main: ci.main });
  });
  if (L.core) out.push({ circuit: -1, letter: 'core', pct: pctOf(c.core), cap: L.core.cap, main: false });
  return out;
}

/** The charge with every store held to at most `cap` percent (a hazard that saps the batteries) */
export function capCharge(d: ShipDerived, c: Charge, cap: number): Charge {
  if (cap >= 100) return c;
  const n = d.power?.stores.length ?? 0;
  return { core: Math.min(pctOf(c.core), cap), s: Array.from({ length: n }, (_, i) => Math.min(pctOf(c.s[i]), cap)) };
}

export interface PowerUse {
  thrusting: boolean;
  boosting: boolean;
  /** The way the pilot pushes, ship-local (forward is -y): only engines pushing that way draw. Absent: every engine (flight: every
   * engine draws while thrusting, as it always has; the load test too) */
  dir?: Vec2;
  /** What the guns and mining lasers draw this tick, per feed group (per second): gunLoad */
  load?: ArrayLike<number>;
}

export interface PowerResult {
  charge: Charge;
  /** Engines' share of the power they asked for, all together (1 unless short): flight scales each by its own (thrustShare) */
  power: number;
  /** Whether a boost was possible (it needs stored charge) */
  boost: boolean;
}

/**
 * What the guns and mining lasers will draw this tick, per feed group (per
 * second): a gun reloading draws its draw (so a shot's energy over its
 * reload), a beam that burned last tick its draw, a running mining laser its
 */
export function gunLoad(ship: { derived: ShipDerived; cooldown: number[]; mineUntil?: number }, tick: number): number[] | undefined {
  const L = ship.derived.power;
  if (!L || !L.feeds.length) return undefined;
  const out = new Array<number>(L.feeds.length).fill(0);
  for (const w of ship.derived.weapons) {
    const f = L.feedOf[w.part];
    if (f >= 0 && ship.cooldown[w.part] > 0) out[f] += L.draw[w.part];
  }
  if (tick < (ship.mineUntil ?? 0)) for (const m of ship.derived.miners) { const f = L.feedOf[m.part]; if (f >= 0) out[f] += L.draw[m.part]; }
  return out;
}

/**
 * One tick of the ship's power (steps 1 to 4 above). Returns the new charge
 * (with each feed group's share this tick: `eng`, `gun`), the engines' share
 * all together, and whether a boost was possible (it needs stored charge).
 */
export function powerTick(d: ShipDerived, c: Charge, use: PowerUse, tuning: ShipTuning): PowerResult {
  const L = d.power;
  if (!L || !d.energy) return { charge: c, power: 1, boost: use.boosting };
  const et = energyTuning(tuning);
  const S = L.stores, F = L.feeds, C = L.circuits;
  const nS = S.length, nF = F.length, nC = C.length;
  const held = new Float64Array(nS), allow = new Float64Array(nS);
  for (let s = 0; s < nS; s++) { held[s] = (S[s].cap * pctOf(c.s[s])) / 100; allow[s] = Math.min(held[s], S[s].rate / 60); }
  const core = L.core;
  let coreLeft = core ? (core.cap * pctOf(c.core)) / 100 : 0;
  const coreFull = coreLeft;
  let coreMain = core ? core.rate / 60 : 0, coreTrickle = core ? core.trickle / 60 : 0;

  // Boosting needs charge stored somewhere
  let stored = coreLeft;
  for (let s = 0; s < nS; s++) if (S[s].kind !== 'w') stored += held[s];
  const boost = use.boosting && use.thrusting && stored > 0;
  const mult = boost ? 1 + et.boostDraw * (d.boostDrain ?? 1) : 1;

  // What each feed group asks for this tick
  const engWant = new Float64Array(nF), gunWant = new Float64Array(nF);
  if (use.thrusting) {
    for (const t of d.thrusters) {
      const f = L.feedOf[t.part];
      if (f < 0 || (!t.force[0] && !t.force[1])) continue;
      if (use.dir && t.force[0] * use.dir[0] + t.force[1] * use.dir[1] <= 1e-9) continue;
      engWant[f] += (L.draw[t.part] * mult) / 60;
    }
  }
  if (use.load) for (let f = 0; f < nF; f++) gunWant[f] = Math.max(0, use.load[f] ?? 0) / 60;
  const engGot = new Float64Array(nF), gunGot = new Float64Array(nF);
  const cE = new Float64Array(nC), cG = new Float64Array(nC);
  for (let f = 0; f < nF; f++) { cE[F[f].circuit] += engWant[f]; cG[F[f].circuit] += gunWant[f]; }

  const take = (s: number, want: number): number => {
    if (s < 0 || want <= 1e-15) return 0;
    const t = Math.min(want, allow[s]);
    allow[s] -= t; held[s] -= t;
    return t;
  };
  // The main circuit's general pool and the core's store are one general store: they give together, each by what it holds
  // (so they run dry together, as one pool did), each no more than its own rate
  const takeGeneral = (s: number, want: number, main: boolean): number => {
    if (!main || !core) return take(s, want);
    if (want <= 1e-15) return 0;
    const a = s >= 0 ? allow[s] : 0, b = Math.max(0, Math.min(coreLeft, coreMain));
    const t = Math.min(want, a + b);
    if (t <= 0) return 0;
    const hg = s >= 0 ? held[s] : 0, hc = coreLeft;
    let fromG = hg + hc > 0 ? Math.min(a, (t * hg) / (hg + hc)) : 0;
    const fromC = Math.min(b, t - fromG);
    fromG = Math.min(a, t - fromC);
    return take(s, fromG) + takeCore(fromC, true);
  };
  const takeCore = (want: number, main: boolean): number => {
    if (!core || want <= 1e-15) return 0;
    const t = Math.min(want, coreLeft, main ? coreMain : coreTrickle);
    if (t <= 0) return 0;
    if (main) coreMain -= t; else coreTrickle -= t;
    coreLeft -= t;
    return t;
  };

  // 1-2. Each circuit: engines, then guns and mining lasers, from its stream, then its pools (and the core, on the main one)
  const stream = new Float64Array(nC);
  for (let k = 0; k < nC; k++) {
    const ci = C[k];
    stream[k] = ci.spare / 60;
    let e = 0;
    if (cE[k] > 0) {
      const fs = Math.min(stream[k], cE[k]);
      stream[k] -= fs; e += fs;
      e += take(ci.pools.d, cE[k] - e);
      e += takeGeneral(ci.pools.g, cE[k] - e, ci.main);
    }
    let g = 0;
    if (cG[k] > 0) {
      const fs = Math.min(stream[k], cG[k]);
      stream[k] -= fs; g += fs;
      g += take(ci.pools.w, cG[k] - g);
      g += takeGeneral(ci.pools.g, cG[k] - g, ci.main);
    }
    cE[k] = cE[k] > 0 ? e / cE[k] : 1;
    cG[k] = cG[k] > 0 ? g / cG[k] : 1;
  }
  for (let f = 0; f < nF; f++) { engGot[f] = engWant[f] * cE[F[f].circuit]; gunGot[f] = gunWant[f] * cG[F[f].circuit]; }

  // 3. Banks top up what they touch (engines first), shared by what each is short; then the core's trickle, the same
  const topUp = (want: Float64Array, got: Float64Array, eligible: (f: number) => boolean, give: (short: number) => number) => {
    let short = 0;
    for (let f = 0; f < nF; f++) if (eligible(f)) short += Math.max(0, want[f] - got[f]);
    if (short <= 1e-15) return;
    const k = give(short) / short;
    if (k > 0) for (let f = 0; f < nF; f++) if (eligible(f)) got[f] += Math.max(0, want[f] - got[f]) * k;
  };
  for (let s = 0; s < nS; s++) {
    if (S[s].kind !== 'k') continue;
    topUp(engWant, engGot, (f) => F[f].bank === s, (short) => take(s, short));
    topUp(gunWant, gunGot, (f) => F[f].bank === s, (short) => take(s, short));
  }
  if (core) {
    const off = (f: number) => !C[F[f].circuit].main;
    topUp(engWant, engGot, off, (short) => takeCore(short, false));
    topUp(gunWant, gunGot, off, (short) => takeCore(short, false));
  }

  // 4. Shares (nothing asked: whether anything could be given at all), then the stream left charges each circuit's stores
  const eng = new Array<number>(nF), gun = new Array<number>(nF);
  let wantAll = 0, gotAll = 0;
  for (let f = 0; f < nF; f++) {
    const ci = C[F[f].circuit], b = F[f].bank;
    const reach = (pool: number) => ci.spare > 0 || (pool >= 0 && S[pool].cap > 0 && pctOf(c.s[pool]) > 0) || (ci.pools.g >= 0 && pctOf(c.s[ci.pools.g]) > 0)
      || (b >= 0 && pctOf(c.s[b]) > 0) || (!!core && coreFull > 0 && (ci.main || core.trickle > 0));
    eng[f] = engWant[f] > 1e-15 ? Math.min(1, engGot[f] / engWant[f]) : reach(ci.pools.d) ? 1 : 0;
    gun[f] = gunWant[f] > 1e-15 ? Math.min(1, gunGot[f] / gunWant[f]) : reach(ci.pools.w) ? 1 : 0;
    wantAll += engWant[f]; gotAll += engGot[f];
  }
  for (let k = 0; k < nC; k++) {
    const left = stream[k];
    if (left <= 1e-15) continue;
    const ci = C[k];
    const groups = [ci.pools.g, ci.pools.d, ci.pools.w, ...ci.banks].filter((s) => s >= 0);
    let room = 0;
    for (const s of groups) room += Math.max(0, S[s].cap - held[s]);
    const coreRoom = ci.main && core ? Math.max(0, core.cap - coreLeft) : 0;
    room += coreRoom;
    if (room <= 0) continue;
    const kk = Math.min(1, left / room);
    for (const s of groups) held[s] += Math.max(0, S[s].cap - held[s]) * kk;
    coreLeft += coreRoom * kk;
  }
  const s = new Array<number>(nS);
  for (let i = 0; i < nS; i++) s[i] = pct(held[i], S[i].cap);
  return {
    charge: { core: core ? pct(coreLeft, core.cap) : 100, s, eng, gun },
    power: wantAll > 1e-15 ? Math.min(1, gotAll / wantAll) : 1,
    boost,
  };
}

/** A feed group's share this tick (1 when it isn't accounted) */
export function feedShare(d: ShipDerived, c: Charge | undefined, part: number, use: 'eng' | 'gun'): number {
  const f = d.power?.feedOf[part] ?? -1;
  if (f < 0 || !c) return 1;
  return c[use]?.[f] ?? 1;
}

/**
 * The share of their push the engines pushing along `dir` (ship-local) get,
 * each on its own circuit's share (the core's maneuvering is its own, never
 * short): what flight scales the thrust by
 */
export function thrustShare(d: ShipDerived, c: Charge, dir: Vec2, fade: (rated: number | undefined) => number): number {
  const L = d.power;
  if (!L || !c.eng) return 1;
  let f = 0, got = 0;
  for (const t of d.thrusters) {
    const v = Math.max(0, t.force[0] * dir[0] + t.force[1] * dir[1]) * fade(t.rated);
    if (v <= 0) continue;
    f += v;
    const g = L.feedOf[t.part];
    got += v * (g >= 0 ? c.eng[g] ?? 1 : 1);
  }
  const m = d.maneuverForce;
  const full = Math.max(f, m);
  return full > 0 ? Math.max(got, Math.min(m, full)) / full : 1;
}

/**
 * The same charge on a ship rebuilt (a part lost or mended, the circuits
 * split or joined): each store keeps what it held, so a split circuit's
 * halves each keep their share and joined ones pool theirs; a store that
 * wasn't on the ship before (mended) comes back empty
 */
export function remapCharge(before: ShipDerived, after: ShipDerived, c: Charge): Charge {
  const A = before.power, B = after.power;
  if (!B) return c;
  if (!A) return { core: pctOf(c.core), s: B.stores.map(() => 100) };
  const partPct = new Map<number, number>();
  A.stores.forEach((g, s) => { for (const i of g.parts) partPct.set(i, pctOf(c.s[s])); });
  const s = B.stores.map((g) => {
    let cap = 0, held = 0;
    for (const i of g.parts) { const k = B.partCap[i]; cap += k; held += (k * (partPct.get(i) ?? 0)) / 100; }
    return cap > 0 ? Math.round((held / cap) * 100 * 1000) / 1000 : 100;
  });
  return { core: B.core ? (A.core ? pctOf(c.core) : 0) : 100, s };
}

/**
 * Mining lasers, one tick: a pulse (MINE_CYCLE ticks) runs to its end once
 * started, drawing on its circuit as it goes (gunLoad); none starts, and one
 * running stops, while their circuit can give them nothing. Returns whether
 * the beams are on this tick; `ship.mineUntil` is updated.
 */
export function payMining(ship: { derived: ShipDerived; minePaid?: number; mineUntil?: number }, on: boolean, tick: number, c: { charge: Charge }): boolean {
  const miners = ship.derived.miners;
  if (!miners.length) return false;
  const running = tick < (ship.mineUntil ?? 0);
  if (!on && !running) return false;
  let share = 1;
  for (const m of miners) share = Math.min(share, feedShare(ship.derived, c.charge, m.part, 'gun'));
  if (share <= 0.001) { ship.mineUntil = 0; return false; }
  if (!running) ship.mineUntil = tick + MINE_CYCLE;
  return true;
}

export interface LoadTestResult {
  /** Per circuit (power.circuits order): the lowest share its engines and its guns got, when its first brownout came (s, -1 never), and its charge at the end (%) */
  circuits: { letter: string; engines: number; guns: number; brownAt: number; end: number; refill: number }[];
  /** Per part: the lowest share it got (burst consumers only; 1 elsewhere) */
  part: number[];
  seconds: number;
}

/**
 * The hangar's load test: `seconds` of every gun firing flat out (reloading
 * all the time) and the engines thrusting forward (boosting if asked), from
 * full, the ship's own power code tick by tick. Then how long each circuit
 * takes to fill again, idle (s, Infinity never).
 */
export function loadTest(d: ShipDerived, tuning: ShipTuning, opts: { fire: boolean; thrust: boolean; boost: boolean; seconds: number; from?: Charge }): LoadTestResult {
  const L = d.power;
  const ticks = Math.round(opts.seconds * 60);
  const part = d.alive.map(() => 1);
  if (!L) return { circuits: [], part, seconds: opts.seconds };
  const load = opts.fire ? (() => {
    const out = new Array<number>(L.feeds.length).fill(0);
    for (const w of d.weapons) { const f = L.feedOf[w.part]; if (f >= 0) out[f] += L.draw[w.part]; }
    return out;
  })() : undefined;
  const engines = L.circuits.map(() => 1), guns = L.circuits.map(() => 1), brownAt = L.circuits.map(() => -1);
  let c: Charge = opts.from ?? FULL_CHARGE;
  for (let t = 0; t < ticks; t++) {
    const r = powerTick(d, c, { thrusting: opts.thrust, boosting: opts.boost, load }, tuning);
    c = r.charge;
    L.feeds.forEach((f, k) => {
      const ci = f.circuit;
      const e = c.eng![k], g = c.gun![k];
      if (e < engines[ci]) engines[ci] = e;
      if (g < guns[ci]) guns[ci] = g;
      if ((e < BROWNOUT || g < BROWNOUT) && brownAt[ci] < 0) brownAt[ci] = t / 60;
    });
    for (let i = 0; i < part.length; i++) {
      const f = L.feedOf[i];
      if (f < 0) continue;
      const isEngine = d.thrusters.some((x) => x.part === i && (x.force[0] || x.force[1]));
      const v = isEngine ? (opts.thrust ? c.eng![f] : 1) : opts.fire ? c.gun![f] : 1;
      if (v < part[i]) part[i] = v;
    }
  }
  const after = c;
  const end = circuitCharges(d, after);
  // Refill: idle ticks until each circuit's stores are full again (up to two minutes)
  const refill = L.circuits.map(() => Infinity);
  let idle = after;
  for (let t = 0; t <= 7200; t++) {
    const cc = circuitCharges(d, idle);
    for (const x of cc) if (x.circuit >= 0 && refill[x.circuit] === Infinity && x.pct >= 99.5) refill[x.circuit] = t / 60;
    if (refill.every((v, k) => v !== Infinity || !end.some((x) => x.circuit === k))) break;
    idle = powerTick(d, idle, { thrusting: false, boosting: false }, tuning).charge;
  }
  return {
    circuits: L.circuits.map((ci, k) => ({ letter: ci.letter, engines: engines[k], guns: guns[k], brownAt: brownAt[k], end: end.find((x) => x.circuit === k)?.pct ?? 100, refill: refill[k] })),
    part,
    seconds: opts.seconds,
  };
}
