/**
 * Ship energy, a tick at a time (docs/design/rework-2026-11.md §2.2-2.3;
 * circuits.ts works out the layout once a rebuild).
 *
 * One ship pool (the core's store plus the batteries on powered networks) and
 * the banks (touching Capacitors, touching Drive Cells). The ship's Output is
 * the most it can give a second: its spare generation plus the pool's rate
 * while the pool holds charge. Each tick:
 *
 *   1. Banks first: engines (boosting draws far more, and needs stored charge),
 *      guns, beams, mining lasers and part features (a Tow Beam's load, a Burst
 *      Strafer's burst: PowerUse.extra) draw on the banks they touch (engines
 *      and strafers Drive Cell banks, the rest Capacitor banks; fuller bank
 *      first, each giving at most its rate).
 *   2. Proportional sharing (Kieran, 2026-11-04): everything still short asks
 *      the Output for the rest, and so does every bank not full that can
 *      refill (a member on a powered network), for its charge rate (`intake`,
 *      at most the room it has). Within the Output, every asker gets what it
 *      asked; past it, each gets Output × its ask / all asked: the same share
 *      for everyone (a brownout: guns reload slower, beams burn that share of
 *      the ticks, thrust scales by it). The spare stream pays first, then the
 *      pool. A bank's intake is how it raises its side's share: it asks while
 *      what it feeds draws on it.
 *   3. What's left of the spare stream refills the pool. Then each bank gets
 *      what its Pulse Dynamos make.
 *
 * Steady loads (shields, scanners, jump coils) share their network's
 * generators at the rebuild, before any of this (rebuild.ts).
 *
 * Charge travels (and is predicted) as the pool's percentage plus one per bank.
 * The same steps run on the server and on the pilot's client.
 */

import type { ShipDerived, WeaponInfo } from './rebuild.js';
import type { ShipTuning } from './tuning.js';
import type { Vec2 } from './types.js';
import { getPlan } from './features/plan.js';
import {
  type PortsControls, type PortsState, createPortsState, portsMineStep, portsMineStop, fullPorts, isPortsRow, packPorts, portsGaugePct, portsSlotEnd, portsThrustFrac, portsThrustMul, portsTick, remapPorts, unpackPortsInto,
} from './power/ports.js';
import { dhypot } from '../math/detTrig.js';

export interface EnergyInfo {
  /** What the pool holds full (the core's store and the batteries'), and what the Drive Cell and Capacitor banks hold */
  max: number;
  driveMax: number;
  weaponMax: number;
  /** Generator power left after the steady loads (power units: per second) */
  spare: number;
  /** Total generator power */
  supply: number;
  /** What the engines draw at full thrust, and the mining lasers while mining (per second) */
  engineDraw: number;
  minerDraw: number;
  /** What the guns draw firing flat out (per second), each by its firing model (gunDrawFlatOut: an ammunition gun nothing), for ratings and the hangar */
  weaponDraw: number;
}

/**
 * The charge: the pool's (`g`) and each bank's (`b`, ShipDerived.power.banks order), as percentages of what they hold;
 * a bank with no entry is full. `eng` and `gun` are this tick's shares of their power each feed group got (powerTick):
 * never sent, worked out afresh every tick.
 */
export interface Charge {
  g: number;
  b: number[];
  eng?: number[];
  gun?: number[];
  /** A ports ship's (power/ports.ts): what every part holds, in place of the pool and banks (`g` and `b` are then unused) */
  e?: PortsState;
  /** A ports row a client was sent and hasn't read yet (it needs the layout: ensurePortsCharge) */
  row?: ArrayLike<number>;
}

export const FULL_CHARGE: Charge = { g: 100, b: [] };

/**
 * The pilot's own snapshot row (server SnapshotBuilder; client GameState reads it), by index: 0 cursor and weapon
 * state, 1 the whole charge (the gauge), 2 cursor distance, 3 jump counter, 4 shield %, 5 EMP ticks left, then these.
 * After the charge groups come the part features' values (features.wire.json pilotExtra), then the gun state
 * (guns.ts packGunState: a count, then that many part and value pairs).
 */
export const PILOT_ROW = { jumpScale: 6, field: 7, pool: 8, groups: 9, prime: 10, warmth: 11, cargo: 12 } as const;

/**
 * The pilot's own snapshot row carries the charge (SnapshotBuilder, GameState): data[1] the whole ship's (the gauge),
 * data[PILOT_ROW.pool] the pool's, data[PILOT_ROW.groups] how many charge groups follow, and each group's from
 * data[CHARGE_GROUPS_AT]: the pool's, then each bank's (at most MAX_CHARGE_GROUPS in all; banks past that are taken
 * as full). Hundredths of a percent.
 */
export const CHARGE_GROUPS_AT = 13;
export const MAX_CHARGE_GROUPS = 24;
/** Where the charge groups end in a pilot row (the part features' values start there) */
export function chargeGroupsEnd(data: ArrayLike<number>): number {
  // (A ports ship's row carries its parts' triples instead, counted negative: power/ports.ts)
  if ((data[PILOT_ROW.groups] | 0) < 0) return portsSlotEnd(data);
  return CHARGE_GROUPS_AT + Math.max(0, Math.min(MAX_CHARGE_GROUPS, data[PILOT_ROW.groups] | 0));
}
/** What the charge groups mean (in the wire hash: a change of meaning is a protocol bump) */
export const CHARGE_GROUPS_LAYOUT = 'pool+banks';
const hundredths = (v: number) => Math.round(pctOf(v) * 100) / 100;

/** The charge's fields for the snapshot row: the gauge, the pool's, and the groups (the pool's, then each bank's) */
export function packCharge(d: ShipDerived | undefined, c: Charge): { total: number; g: number; count: number; groups: number[] } {
  // (A ports ship: its layout's sig in the pool's slot, its parts' triples in the groups', their count negative)
  if (d?.ports && c.e) {
    const groups: number[] = [], n = packPorts(d.ports, c.e, groups);
    return { total: hundredths(portsGaugePct(d.ports, c.e)), g: d.ports.sig, count: -n, groups };
  }
  const n = Math.min(MAX_CHARGE_GROUPS - 1, d?.power?.banks.length ?? 0);
  const groups = new Array<number>(n + 1);
  groups[0] = hundredths(c.g);
  for (let i = 0; i < n; i++) groups[i + 1] = hundredths(c.b[i] ?? 100);
  return { total: d ? hundredths(chargeTotal(d, c)) : 100, g: groups[0], count: groups.length, groups };
}

/** The charge a snapshot row says (data as packed above; an old row: full) */
export function unpackCharge(data: number[] | undefined): Charge {
  if (!data || data.length <= PILOT_ROW.groups) return { g: 100, b: [] };
  // (A ports row is read once the layout is at hand: ensurePortsCharge)
  if (isPortsRow(data)) return { g: 100, b: [], row: data };
  const n = Math.max(0, Math.min(MAX_CHARGE_GROUPS, data[PILOT_ROW.groups] | 0));
  const fin = (v: number | undefined, dflt: number) => (v !== undefined && Number.isFinite(v) ? v : dflt);
  if (n === 0) return { g: fin(data[PILOT_ROW.pool], 100), b: [] };
  return { g: fin(data[CHARGE_GROUPS_AT], fin(data[PILOT_ROW.pool], 100)), b: data.slice(CHARGE_GROUPS_AT + 1, CHARGE_GROUPS_AT + n).map((v) => fin(v, 100)) };
}
/** Mining lasers' old payment segment (ticks): kept for the tick alignment of their pulse */
export const MINE_SEGMENT = 15;
/** A mining laser's pulse (ticks): once started it runs to its end, whether or not the button's still held; it just isn't followed by another */
export const MINE_CYCLE = 54;

export const ENERGY_DEFAULTS = { coreCapacity: 240, boostDraw: 2.2 };

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

/** Energy held in the pool, and in a bank */
export function poolHeld(d: ShipDerived, c: Charge): number {
  return d.power ? (d.power.pool.cap * pctOf(c.g)) / 100 : 0;
}
export function bankHeld(d: ShipDerived, c: Charge, b: number): number {
  const B = d.power?.banks[b];
  return B ? (B.cap * pctOf(c.b[b])) / 100 : 0;
}

/** All the ship's stored energy as one percentage (the HUD's gauge) */
export function chargeTotal(d: ShipDerived, c: Charge): number {
  if (d.ports) return c.e ? portsGaugePct(d.ports, c.e) : 100;
  const L = d.power;
  if (!L) return 100;
  let held = poolHeld(d, c), max = L.pool.cap;
  for (let b = 0; b < L.banks.length; b++) { held += bankHeld(d, c, b); max += L.banks[b].cap; }
  return max <= 0 ? 0 : Math.round((held / max) * 1000) / 10;
}

/** The pool's charge and each bank's (Charge.b order), as percentages, with what each holds full: for the HUD and hangar */
export function bankCharges(d: ShipDerived, c: Charge): { bank: number; kind: 'pool' | 'cap' | 'drive'; pct: number; cap: number }[] {
  const L = d.power;
  if (!L) return [];
  const out: { bank: number; kind: 'pool' | 'cap' | 'drive'; pct: number; cap: number }[] = [{ bank: -1, kind: 'pool', pct: pctOf(c.g), cap: L.pool.cap }];
  L.banks.forEach((B, b) => out.push({ bank: b, kind: B.kind, pct: pctOf(c.b[b]), cap: B.cap }));
  return out;
}

/** The charge with every store held to at most `cap` percent (a hazard that saps the batteries) */
export function capCharge(d: ShipDerived, c: Charge, cap: number): Charge {
  if (cap >= 100 || c.e) return c;
  const n = d.power?.banks.length ?? 0;
  return { g: Math.min(pctOf(c.g), cap), b: Array.from({ length: n }, (_, i) => Math.min(pctOf(c.b[i]), cap)) };
}

export interface PowerUse {
  thrusting: boolean;
  boosting: boolean;
  /** The way the pilot pushes, ship-local (forward is -y): only engines pushing that way draw. Absent: every engine (flight: every
   * engine draws while thrusting, as it always has; the load test too) */
  dir?: Vec2;
  /** What the guns and mining lasers draw this tick, per feed group (per second): gunLoad */
  load?: ArrayLike<number>;
  /**
   * Part features' burst draws this tick, by feature number (features/plan.ts), each per feed group (per second): each
   * takes from the banks feeding it first, then shares the Output with the guns (a Burst Strafer's dodge: features/strafer).
   * In feature order; undefined entries ask nothing.
   */
  extra?: readonly (ArrayLike<number> | undefined)[];
}

export interface PowerResult {
  charge: Charge;
  /** Engines' share of the power they asked for, all together (1 unless short): flight scales each by its own (thrustShare) */
  power: number;
  /** Whether a boost was possible (it needs stored charge) */
  boost: boolean;
  /** By feature number, the share of its `extra` draw each got (absent, or an undefined entry: it asked nothing) */
  extra?: (number | undefined)[];
}

/** The gun state a ship's guns keep (ShipState's fields): what gunDraw reads */
export interface GunStateShip { cooldown: number[]; rounds?: number[]; reload?: number[]; charge?: number[]; spin?: number[] }

/**
 * What a gun draws this tick (per second), by its model, from the state the
 * last tick left: a cycle (or auto) gun its `draw` while it reloads (a spinning
 * one as much faster as it fires), a beam that burned last tick its `draw`, a
 * clip gun `reloadE` × missing / clip over its reload (regrowing: `reloadE / clip`
 * a round), a charge gun `chargeE` over its charge; an ammunition gun nothing.
 */
export function gunDraw(ship: GunStateShip, w: WeaponInfo, draw: number): number {
  const f = w.fire, p = w.part;
  switch (f.model) {
    case 'ammo': return 0;
    case 'clip': {
      const clip = f.clip ?? 1, e = f.reloadE ?? 0;
      if (f.regrow) return (ship.rounds?.[p] ?? clip) < clip ? (e / clip) * (60 / f.regrow) : 0;
      const r = ship.reload?.[p] ?? 0;
      return r > 0 ? (e * Math.max(0, clip - (ship.rounds?.[p] ?? 0))) / clip * (60 / Math.max(1, f.reload ?? 60)) : 0;
    }
    case 'charge': return (ship.charge?.[p] ?? 0) > 0 ? ((f.chargeE ?? 0) * 60) / Math.max(1, f.charge ?? 60) : 0;
    case 'beam': return ship.cooldown[p] > 0 ? draw : 0;
    default: {
      if (!(ship.cooldown[p] > 0)) return 0;
      const s = f.spin;
      if (!s) return draw;
      const k = ship.spin?.[p] ?? 0;
      return (draw * f.interval) / Math.max(1e-9, s.from + (s.to - s.from) * k);
    }
  }
}

/** What a gun draws a second firing flat out (the hangar's load test): its model's draw spread over its whole cycle */
export function gunDrawFlatOut(w: WeaponInfo, draw: number): number {
  const f = w.fire;
  switch (f.model) {
    case 'ammo': return 0;
    case 'clip': {
      const clip = f.clip ?? 1, e = f.reloadE ?? 0;
      if (f.regrow) return (e / clip) * (60 / f.regrow);
      return (e * 60) / Math.max(1, (f.reload ?? 60) + clip * w.interval);
    }
    case 'charge': return ((f.chargeE ?? 0) * 60) / Math.max(1, (f.charge ?? 60) + (f.cooldown ?? 0));
    case 'beam': return draw;
    default: return f.spin ? (draw * f.interval) / Math.max(1e-9, f.spin.to) : draw;
  }
}

/** The ship gunLoad (and a part feature's load()) reads */
export interface GunLoadShip extends GunStateShip { derived: ShipDerived; mineUntil?: number; tow?: number }

/**
 * What the guns and mining lasers will draw this tick, per feed group (per
 * second): each gun what its firing model draws now (gunDraw: a cycle gun its
 * shot's energy over its reload, a clip gun its reload's, a charge gun its
 * charge's, a beam that burned last tick its draw), a running mining laser its
 */
export function gunLoad(ship: GunLoadShip, tick: number): number[] | undefined {
  const L = ship.derived.power;
  if (!L || !L.feeds.length) return undefined;
  return gunLoadInto(ship, tick, new Array<number>(L.feeds.length).fill(0));
}

const sLoad: number[] = [];
/**
 * gunLoad for the per-tick paths: the same vector in a shared scratch (no allocation). Only valid until the
 * next call and must not be kept: hand it straight to powerTick / stepShipPhysics. (Tests and anything that
 * holds the vector use gunLoad.)
 */
export function gunLoadTick(ship: GunLoadShip, tick: number): number[] | undefined {
  const L = ship.derived.power;
  if (!L || !L.feeds.length) return undefined;
  const n = L.feeds.length;
  sLoad.length = n;
  for (let i = 0; i < n; i++) sLoad[i] = 0;
  return gunLoadInto(ship, tick, sLoad);
}

function gunLoadInto(ship: GunLoadShip, tick: number, out: number[]): number[] {
  const L = ship.derived.power!;
  for (const w of ship.derived.weapons) {
    const f = L.feedOf[w.part];
    if (f >= 0) out[f] += gunDraw(ship, w, L.draw[w.part]);
  }
  if (tick < (ship.mineUntil ?? 0)) for (const m of ship.derived.miners) { const f = L.feedOf[m.part]; if (f >= 0) out[f] += L.draw[m.part]; }
  // (Part features that draw by the tick: features/, in plan order; none on a ship without them. A Tow Beam draws while it tows: features/tow)
  const fl = ship.derived.fxList;
  if (fl !== undefined) {
    const load = getPlan().load;
    for (let k = 0; k < fl.length; k++) { const h = load[fl[k]]; if (h !== undefined) h(ship, L, out); }
  }
  return out;
}

// ---- Scratch for powerTick (one ship at a time, never re-entered): grown as needed, so a tick allocates only its result
let sHeld = new Float64Array(8), sAllow = new Float64Array(8), sAsk = new Float64Array(8), sFill = new Float64Array(8);
let sEngW = new Float64Array(8), sGunW = new Float64Array(8), sGot = new Float64Array(8);
let sRem = new Float64Array(8), sPick = new Int32Array(8), sUsed = new Int32Array(8);
function grow(nB: number, nF: number): void {
  if (sHeld.length < nB) { const m = Math.max(nB, sHeld.length * 2); sHeld = new Float64Array(m); sAllow = new Float64Array(m); sAsk = new Float64Array(m); sFill = new Float64Array(m); }
  if (sEngW.length < nF) {
    const m = Math.max(nF, sEngW.length * 2);
    sEngW = new Float64Array(m); sGunW = new Float64Array(m); sGot = new Float64Array(m);
    sRem = new Float64Array(m); sPick = new Int32Array(m); sUsed = new Int32Array(m);
  }
}

/**
 * One tick of the ship's power (steps 1 to 3 above). Returns the new charge
 * (with each feed group's share this tick: `eng`, `gun`, the same for both, as
 * every asker gets the same share of what it asks), the engines' share all
 * together, and whether a boost was possible (it needs stored charge).
 */
export function powerTick(d: ShipDerived, c: Charge, use: PowerUse, tuning: ShipTuning): PowerResult {
  if (d.ports) return portsPowerTick(d, c, use);
  const L = d.power;
  if (!L || !d.energy) return { charge: c, power: 1, boost: use.boosting };
  const et = energyTuning(tuning);
  const B = L.banks, F = L.feeds;
  const nB = B.length, nF = F.length;
  grow(nB, nF);
  const held = sHeld, allow = sAllow;
  for (let b = 0; b < nB; b++) { held[b] = (B[b].cap * pctOf(c.b[b])) / 100; allow[b] = Math.min(held[b], B[b].rate / 60); }
  const P = L.pool;
  let pool = (P.cap * pctOf(c.g)) / 100;
  const poolStart = pool;
  const poolAllow = Math.min(pool, P.rate / 60);
  let stream = L.spare / 60;

  // Boosting needs charge stored for the engines: the pool's, or a Drive Cell bank's
  let stored = pool;
  for (let b = 0; b < nB; b++) if (B[b].kind === 'drive') stored += held[b];
  const boost = use.boosting && use.thrusting && stored > 0;
  const boostDraw = boost ? et.boostDraw : 0;

  // What each feed group asks for this tick: its engines, and its guns, mining lasers and part features
  const engW = sEngW, gunW = sGunW;
  for (let f = 0; f < nF; f++) { engW[f] = 0; gunW[f] = 0; }
  if (use.thrusting) {
    for (const t of d.thrusters) {
      const f = L.feedOf[t.part];
      if (f < 0 || (!t.force[0] && !t.force[1])) continue;
      if (use.dir && t.force[0] * use.dir[0] + t.force[1] * use.dir[1] <= 1e-9) continue;
      engW[f] += (L.draw[t.part] * (1 + boostDraw * L.boostDrain[t.part])) / 60;
    }
  }
  if (use.load) for (let f = 0; f < nF; f++) gunW[f] = Math.max(0, use.load[f] ?? 0) / 60;
  const X = use.extra;
  let anyExtra = false;
  if (X) for (let x = 0; x < X.length; x++) {
    const ask = X[x];
    if (!ask) continue;
    for (let f = 0; f < nF; f++) { const w = Math.max(0, ask[f] ?? 0) / 60; if (w > 1e-15) { gunW[f] += w; anyExtra = true; } }
  }

  // 1. Each group's want from its banks first (fuller bank first, a bank short of what's asked shared by what each asks)
  const rem = sRem, got = sGot, pick = sPick, used = sUsed, ask = sAsk;
  let maxBanks = 0;
  for (let f = 0; f < nF; f++) { rem[f] = engW[f] + gunW[f]; got[f] = 0; used[f] = 0; if (F[f].banks.length > maxBanks) maxBanks = F[f].banks.length; }
  for (let r = 0; r < maxBanks; r++) {
    for (let b = 0; b < nB; b++) ask[b] = 0;
    let any = false;
    for (let f = 0; f < nF; f++) {
      pick[f] = -1;
      if (rem[f] <= 1e-15) continue;
      const fb = F[f].banks;
      let best = -1, bestPct = -1;
      for (let j = 0; j < fb.length; j++) {
        if (used[f] & (1 << j)) continue;
        const b = fb[j], p = B[b].cap > 0 ? held[b] / B[b].cap : 0;
        if (p > bestPct) { bestPct = p; best = j; }
      }
      if (best < 0) continue;
      used[f] |= 1 << best;
      pick[f] = fb[best];
      ask[fb[best]] += rem[f];
      any = true;
    }
    if (!any) break;
    for (let f = 0; f < nF; f++) {
      const b = pick[f];
      if (b < 0) continue;
      const t = rem[f] * Math.min(1, ask[b] > 0 ? allow[b] / ask[b] : 0);
      rem[f] -= t; got[f] += t;
    }
    for (let b = 0; b < nB; b++) if (ask[b] > 0) { const t = Math.min(allow[b], ask[b]); allow[b] -= t; held[b] -= t; }
  }

  // 2. Proportional sharing: what each group still wants, and each bank not full that can refill its intake (at most its
  // room), all ask the Output; past it, each gets Output x its ask / all asked (the spare stream pays first, then the pool)
  const fill = sFill;
  let asked = 0;
  for (let f = 0; f < nF; f++) asked += rem[f];
  for (let b = 0; b < nB; b++) {
    const K = B[b], room = K.cap - held[b];
    fill[b] = K.refills && room > 1e-12 ? Math.min(K.intake / 60, room) : 0;
    asked += fill[b];
  }
  if (asked > 1e-15) {
    const give = Math.min(asked, stream + poolAllow);
    const fromStream = Math.min(stream, give);
    stream -= fromStream;
    pool -= give - fromStream;
    const k = give / asked;
    for (let f = 0; f < nF; f++) got[f] += rem[f] * k;
    for (let b = 0; b < nB; b++) if (fill[b] > 0) held[b] = Math.min(B[b].cap, held[b] + fill[b] * k);
  }

  // 3. The stream left refills the pool; then each bank's Pulse Dynamos
  if (stream > 1e-15 && P.cap > 0) pool = Math.min(P.cap, pool + stream);
  for (let b = 0; b < nB; b++) if (B[b].dynamo > 0) held[b] = Math.min(B[b].cap, held[b] + B[b].dynamo / 60);

  // Shares: one a group, its engines' and its guns' alike (nothing asked: whether anything could be given at all)
  const eng = new Array<number>(nF), gun = new Array<number>(nF);
  let wantAll = 0, gotAll = 0;
  for (let f = 0; f < nF; f++) {
    let reach = L.spare > 0 || poolStart > 0;
    if (!reach) for (const b of F[f].banks) if (pctOf(c.b[b]) > 0 || B[b].dynamo > 0) { reach = true; break; }
    const w = engW[f] + gunW[f];
    const share = w > 1e-15 ? Math.min(1, got[f] / w) : reach ? 1 : 0;
    eng[f] = engW[f] > 1e-15 ? share : reach ? 1 : 0;
    gun[f] = gunW[f] > 1e-15 ? share : reach ? 1 : 0;
    wantAll += engW[f]; gotAll += engW[f] * share;
  }
  const s = new Array<number>(nB);
  for (let b = 0; b < nB; b++) s[b] = pct(held[b], B[b].cap);
  // (A feature's burst share: what it asked of each feed group, at that group's share)
  let extra: (number | undefined)[] | undefined;
  if (X && anyExtra) for (let x = 0; x < X.length; x++) {
    const ask = X[x];
    if (!ask) continue;
    let want = 0, got = 0;
    for (let f = 0; f < nF; f++) { const w = Math.max(0, ask[f] ?? 0); if (w > 0) { want += w; got += w * gun[f]; } }
    if (want <= 1e-12) continue;
    (extra ??= [])[x] = Math.min(1, got / want);
  }
  return {
    charge: { g: pct(pool, P.cap), b: s, eng, gun },
    power: wantAll > 1e-15 ? Math.min(1, gotAll / wantAll) : 1,
    boost,
    ...(extra ? { extra } : {}),
  };
}

// ---- The ports core (power/ports.ts), in the same places
let sActive = new Uint8Array(0);
const PORTS_CTL: PortsControls = { active: null, boosting: false, toolWant: null, reload: false };
/** A ports ship's tick: the thrusters pushing the way asked (every one, with no way given) burn; the tools draw; the guns' timers run */
function portsPowerTick(d: ShipDerived, c: Charge, use: PowerUse): PowerResult {
  const L = d.ports!;
  if (!c.e || c.e.held.length !== L.n) c = { g: 100, b: [], e: c.e && c.e.held.length === L.n ? c.e : createPortsState(L) };
  if (sActive.length < L.n) sActive = new Uint8Array(L.n);
  sActive.fill(0, 0, L.n);
  if (use.thrusting) for (const t of d.thrusters) {
    if (!t.force[0] && !t.force[1]) continue;
    if (use.dir && t.force[0] * use.dir[0] + t.force[1] * use.dir[1] <= 1e-9) continue;
    sActive[t.part] = 1;
  }
  PORTS_CTL.active = sActive; PORTS_CTL.boosting = use.boosting && use.thrusting;
  portsTick(L, c.e!, PORTS_CTL);
  PORTS_CTL.active = null;
  // (The engines' share all together; whether a boost is possible is each engine's own, folded into thrustShare)
  const frac = portsThrustFrac();
  let want = 0, got = 0;
  if (use.thrusting) for (const t of d.thrusters) { if (!sActive[t.part]) continue; const v = dhypot(t.force[0], t.force[1]); want += v; got += v * frac[t.part]; }
  return { charge: c, power: want > 1e-15 ? Math.min(1, got / want) : 1, boost: use.boosting && use.thrusting };
}
/** A client's charge for a ports ship: its state made (once a layout) and the row it was sent read into it */
const clientStates = new WeakMap<object, PortsState>();
export function ensurePortsCharge(d: ShipDerived, c: Charge): void {
  const L = d.ports;
  if (!L) return;
  if (!c.e || c.e.held.length !== L.n) {
    let e = clientStates.get(L);
    if (!e) clientStates.set(L, (e = createPortsState(L)));
    c.e = e;
  }
  if (c.row) { unpackPortsInto(L, c.e, c.row); c.row = undefined; }
}
/** A ports ship's charge for a load test or a fresh spawn: everything full */
export function fullPortsCharge(d: ShipDerived): Charge {
  return d.ports ? { g: 100, b: [], e: createPortsState(d.ports) } : FULL_CHARGE;
}
export { fullPorts };

/** A feed group's share this tick (1 when it isn't accounted) */
export function feedShare(d: ShipDerived, c: Charge | undefined, part: number, use: 'eng' | 'gun'): number {
  const f = d.power?.feedOf[part] ?? -1;
  if (f < 0 || !c) return 1;
  return c[use]?.[f] ?? 1;
}

/**
 * The share of their push the engines pushing along `dir` (ship-local) get,
 * each on its own feed group's share (the core's maneuvering is its own, never
 * short): what flight scales the thrust by
 */
export function thrustShare(d: ShipDerived, c: Charge, dir: Vec2, fade: (rated: number | undefined) => number): number {
  if (d.ports) {
    // (Each engine's share of its burn this tick, and its boost, straight after portsPowerTick)
    if (!c.e) return 1;
    const frac = portsThrustFrac(), mul = portsThrustMul();
    let f = 0, got = 0;
    for (const t of d.thrusters) {
      const v = Math.max(0, t.force[0] * dir[0] + t.force[1] * dir[1]) * fade(t.rated);
      if (v <= 0) continue;
      f += v; got += v * frac[t.part] * mul[t.part];
    }
    const m = d.maneuverForce, full = Math.max(f, m);
    return full > 0 ? Math.max(got, Math.min(m, full)) / full : 1;
  }
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
 * The same charge on a ship rebuilt (a part lost or mended, a bank split or
 * joined): each store keeps what it held, so a split bank's halves each keep
 * their share and joined ones pool theirs; a store that wasn't on the ship
 * before (mended, or newly on a powered network) comes back empty
 */
export function remapCharge(before: ShipDerived, after: ShipDerived, c: Charge): Charge {
  if (after.ports) return { g: 100, b: [], e: c.e ? remapPorts(c.e, after.ports, c.e.held.length === after.ports.n) : createPortsState(after.ports) };
  const A = before.power, B = after.power;
  if (!B) return c;
  if (!A) return { g: pctOf(c.g), b: B.banks.map(() => 100) };
  const g = pctOf(c.g);
  // The pool: the core's store and the batteries that were in it keep theirs
  let cap = B.pool.coreCap, held = A.pool.coreCap > 0 ? (B.pool.coreCap * g) / 100 : 0;
  for (const i of B.pool.parts) { cap += B.partCap[i]; if (A.pooled[i]) held += (B.partCap[i] * g) / 100; }
  const partPct = new Map<number, number>();
  A.banks.forEach((bk, b) => { for (const i of bk.parts) partPct.set(i, pctOf(c.b[b])); });
  const b = B.banks.map((bk) => {
    let bc = 0, bh = 0;
    for (const i of bk.parts) { const k = B.partCap[i]; bc += k; bh += (k * (partPct.get(i) ?? 0)) / 100; }
    return bc > 0 ? Math.round((bh / bc) * 100 * 1000) / 1000 : 100;
  });
  return { g: cap > 0 ? Math.round((held / cap) * 100 * 1000) / 1000 : 100, b };
}

/**
 * Mining lasers, one tick: a pulse (MINE_CYCLE ticks) runs to its end once
 * started, drawing on the ship as it goes (gunLoad); none starts, and one
 * running stops, while the ship can give them nothing. Returns whether the
 * beams are on this tick; `ship.mineUntil` is updated.
 */
export function payMining(ship: { derived: ShipDerived; minePaid?: number; mineUntil?: number }, on: boolean, tick: number, c: { charge: Charge }, stop = false): boolean {
  const miners = ship.derived.miners;
  if (!miners.length) return false;
  // A ports ship: each mining laser runs its own pulses off its own buffer and cuts by its fulfilment (power/ports.ts portsMineStep)
  const pz = ship.derived.ports, pe = c.charge.e;
  if (pz && pe && pe.held.length === pz.n) {
    if (stop) { portsMineStop(pz, pe); return false; }
    let any = false;
    for (const m of miners) if (portsMineStep(pz, pe, m.part, on) >= 0) any = true;
    return any;
  }
  if (stop) ship.mineUntil = 0;
  const running = tick < (ship.mineUntil ?? 0);
  if (!on && !running) return false;
  let share = 1;
  for (const m of miners) share = Math.min(share, feedShare(ship.derived, c.charge, m.part, 'gun'));
  if (share <= 0.001) { ship.mineUntil = 0; return false; }
  if (!running) ship.mineUntil = tick + MINE_CYCLE;
  return true;
}

export interface LoadTestResult {
  /** The lowest share the engines and the guns got, when the first brownout came (s, -1 never), the pool's charge at the end (%) and how long it takes to refill idle (s, Infinity never) */
  engines: number;
  guns: number;
  brownAt: number;
  end: number;
  refill: number;
  /** Each bank's charge at the end (%) */
  banks: number[];
  /** Per part: the lowest share it got (burst consumers only; 1 elsewhere) */
  part: number[];
  seconds: number;
}

/**
 * The hangar's load test: `seconds` of every gun firing flat out (reloading
 * all the time) and the engines thrusting forward (boosting if asked), from
 * full, the ship's own power code tick by tick. Then how long the ship takes
 * to fill again, idle (s, Infinity never).
 */
export function loadTest(d: ShipDerived, tuning: ShipTuning, opts: { fire: boolean; thrust: boolean; boost: boolean; seconds: number; from?: Charge }): LoadTestResult {
  const L = d.power;
  const ticks = Math.round(opts.seconds * 60);
  const part = d.alive.map(() => 1);
  if (!L) return { engines: 1, guns: 1, brownAt: -1, end: 100, refill: 0, banks: [], part, seconds: opts.seconds };
  const load = opts.fire ? (() => {
    const out = new Array<number>(L.feeds.length).fill(0);
    for (const w of d.weapons) { const f = L.feedOf[w.part]; if (f >= 0) out[f] += gunDrawFlatOut(w, L.draw[w.part]); }
    return out;
  })() : undefined;
  let engines = 1, guns = 1, brownAt = -1;
  const isEngine = d.alive.map((_, i) => d.thrusters.some((x) => x.part === i && (x.force[0] || x.force[1])));
  let c: Charge = opts.from ?? FULL_CHARGE;
  for (let t = 0; t < ticks; t++) {
    c = powerTick(d, c, { thrusting: opts.thrust, boosting: opts.boost, load }, tuning).charge;
    for (let k = 0; k < L.feeds.length; k++) {
      const e = c.eng![k], g = c.gun![k];
      if (e < engines) engines = e;
      if (g < guns) guns = g;
      if ((e < BROWNOUT || g < BROWNOUT) && brownAt < 0) brownAt = t / 60;
    }
    for (let i = 0; i < part.length; i++) {
      const f = L.feedOf[i];
      if (f < 0) continue;
      const v = isEngine[i] ? (opts.thrust ? c.eng![f] : 1) : opts.fire ? c.gun![f] : 1;
      if (v < part[i]) part[i] = v;
    }
  }
  const end = pctOf(c.g), banks = L.banks.map((_, b) => pctOf(c.b[b]));
  // Refill: idle ticks until the pool and every bank that can refill are full again (up to two minutes)
  const full = (x: Charge) => (L.pool.cap <= 0 || pctOf(x.g) >= 99.5) && L.banks.every((B, b) => !(B.refills || B.dynamo > 0) || B.cap <= 0 || pctOf(x.b[b]) >= 99.5);
  let refill = Infinity, idle = c;
  for (let t = 0; t <= 7200; t++) {
    if (full(idle)) { refill = t / 60; break; }
    idle = powerTick(d, idle, { thrusting: false, boosting: false }, tuning).charge;
  }
  return { engines, guns, brownAt, end, refill, banks, part, seconds: opts.seconds };
}
