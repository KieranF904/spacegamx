/**
 * Ship energy, a tick at a time: the glue between flight, the guns and the snapshot and the ports core (power/ports.ts;
 * docs/design/energy-ports-2026-11.md), which every ship runs. The charge is the core's PortsState (`Charge.e`): what
 * every part holds. The same steps run on the server and on the pilot's client.
 */

import type { ShipDerived, WeaponInfo } from './rebuild.js';
import type { ShipTuning } from './tuning.js';
import type { Vec2 } from './types.js';
import {
  type PortsControls, type PortsLayout, type PortsState, P_THRUSTER, TK_ENGINE, createPortsState, portsCapStores, portsMineStep, portsMineStop, fullPorts, isPortsRow, packPorts, portsGaugePct, portsSlotEnd, portsThrustFrac, portsThrustMul, portsTick, remapPorts, unpackPortsInto,
} from './power/ports.js';
import { dhypot } from '../math/detTrig.js';

export interface EnergyInfo {
  /** What the ship's stores hold full (the ports gauge's whole, power units) */
  max: number;
  /** Total generator power (health-scaled, per second), and what the steady loads (not engines, guns, mining lasers or burst features) ask */
  supply: number;
  demand: number;
  /** What the engines draw at full thrust, and the mining lasers while mining (per second) */
  engineDraw: number;
  minerDraw: number;
  /** What the guns draw firing flat out (per second), each by its firing model (gunDrawFlatOut: an ammunition gun nothing), for ratings and the hangar */
  weaponDraw: number;
}

/**
 * The charge: a ports ship's state (`e`, power/ports.ts: what every part holds). Absent: full (a fresh ship; the tick
 * makes the state the first time it runs).
 */
export interface Charge {
  e?: PortsState;
  /** A ports row a client was sent and hasn't read yet (it needs the layout: ensurePortsCharge) */
  row?: ArrayLike<number>;
}

export const FULL_CHARGE: Charge = {};

/**
 * The pilot's own snapshot row (server SnapshotBuilder; client GameState reads it), by index: 0 cursor and weapon
 * state, 1 the whole charge (the gauge), 2 cursor distance, 3 jump counter, 4 shield %, 5 EMP ticks left, then these.
 * After the charge groups come the part features' values (features.wire.json pilotExtra), then the gun state
 * (guns.ts packGunState: a count, then that many part and value pairs).
 */
export const PILOT_ROW = { jumpScale: 6, field: 7, pool: 8, groups: 9, prime: 10, warmth: 11, cargo: 12 } as const;

/**
 * The pilot's own snapshot row carries the charge (SnapshotBuilder, GameState): data[1] the gauge, data[PILOT_ROW.pool]
 * the ports layout's sig, data[PILOT_ROW.groups] the parts' triples' count, negative (power/ports.ts portsWire), and
 * the triples from data[CHARGE_GROUPS_AT]. A ship with no state yet sends one group (100: full).
 */
export const CHARGE_GROUPS_AT = 13;
/** (In the wire hash with CHARGE_GROUPS_LAYOUT: a change of either is a protocol bump) */
export const MAX_CHARGE_GROUPS = 24;
/** Where the charge groups end in a pilot row (the part features' values start there) */
export function chargeGroupsEnd(data: ArrayLike<number>): number {
  if ((data[PILOT_ROW.groups] | 0) < 0) return portsSlotEnd(data);
  return CHARGE_GROUPS_AT + Math.max(0, Math.min(MAX_CHARGE_GROUPS, data[PILOT_ROW.groups] | 0));
}
/** What the charge groups mean (in the wire hash: a change of meaning is a protocol bump) */
export const CHARGE_GROUPS_LAYOUT = 'pool+banks';
const hundredths = (v: number) => Math.round(v * 100) / 100;

/** The charge's fields for the snapshot row: the gauge, the layout's sig, and the parts' triples (their count negative) */
export function packCharge(d: ShipDerived | undefined, c: Charge): { total: number; g: number; count: number; groups: number[] } {
  if (!d || !c.e) return { total: 100, g: 100, count: 1, groups: [100] };
  const groups: number[] = [], n = packPorts(d.ports, c.e, groups);
  return { total: hundredths(portsGaugePct(d.ports, c.e)), g: d.ports.sig, count: -n, groups };
}

/** The charge a snapshot row says (data as packed above; anything else: full) */
export function unpackCharge(data: number[] | undefined): Charge {
  // (A ports row is read once the layout is at hand: ensurePortsCharge)
  if (data && data.length > PILOT_ROW.groups && isPortsRow(data)) return { row: data };
  return {};
}
/** A mining laser's pulse (ticks): once started it runs to its end, whether or not the button's still held; it just isn't followed by another */
export const MINE_CYCLE = 54;

/** A share counts as a brownout below this */
export const BROWNOUT = 0.995;

/** All the ship's stored energy as one percentage (the HUD's gauge) */
export function chargeTotal(d: ShipDerived, c: Charge): number {
  return c.e ? portsGaugePct(d.ports, c.e) : 100;
}

export interface PowerUse {
  thrusting: boolean;
  boosting: boolean;
  /** The way the pilot pushes, ship-local (forward is -y): only engines pushing that way draw. Absent: every engine */
  dir?: Vec2;
  /**
   * Part features' draws this tick, by feature number (features/plan.ts), each by part: the share (0..1) of each of the
   * ship's thrusters' burn the feature wants this tick (a Burst Strafer bursting, a Gyro turning: power/ports.ts
   * TK_STRAFER, TK_GYRO). Undefined entries ask nothing
   */
  extra?: readonly (ArrayLike<number> | undefined)[];
  /** A hazard that saps the stores (radiation: hazards.ts HazardFlight.cap): each store holds at most this share. Absent, 1: all */
  storeCap?: number;
}

export interface PowerResult {
  charge: Charge;
  /** Engines' share of the power they asked for, all together (1 unless short): flight scales each by its own (thrustShare) */
  power: number;
  /** Whether a boost was asked for (each engine's own boost is folded into thrustShare) */
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

/** What a gun draws a second firing flat out (the hangar's figures): its model's draw spread over its whole cycle */
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

// ---- The ports core's tick (power/ports.ts), as flight calls it
let sActive = new Uint8Array(0), sScale = new Float64Array(0);
const PORTS_CTL: PortsControls = { active: null, scale: null, boosting: false, toolWant: null, reload: false };
/**
 * One tick of the ship's power: the thrusters pushing the way asked (every one, with no way given) burn; part features'
 * thrusters the share they ask; the tools draw; the guns' timers run. Returns the new charge, the engines' share all
 * together and each feature's share.
 */
export function powerTick(d: ShipDerived, c: Charge, use: PowerUse, _tuning?: ShipTuning): PowerResult {
  const L = d.ports;
  if (!c.e || c.e.held.length !== L.n) c = { e: c.e && c.e.held.length === L.n ? c.e : createPortsState(L) };
  if (sActive.length < L.n) { sActive = new Uint8Array(L.n); sScale = new Float64Array(L.n); }
  sActive.fill(0, 0, L.n); sScale.fill(0, 0, L.n);
  if (use.thrusting) for (const t of d.thrusters) {
    if (!t.force[0] && !t.force[1]) continue;
    if (use.dir && t.force[0] * use.dir[0] + t.force[1] * use.dir[1] <= 1e-9) continue;
    sActive[t.part] = 1;
  }
  // (Part features' thrusters (Burst Strafers, Gyros) burn the share of their burn their feature asks, by part)
  const X = use.extra;
  if (X) for (let x = 0; x < X.length; x++) {
    const ask = X[x];
    if (!ask) continue;
    const m = ask.length < L.n ? ask.length : L.n;
    for (let p = 0; p < m; p++) { const k = ask[p]; if (k > 0 && L.role[p] === P_THRUSTER && L.thrustKind[p] !== TK_ENGINE) { sActive[p] = 1; sScale[p] = k < 1 ? k : 1; } }
  }
  PORTS_CTL.active = sActive; PORTS_CTL.scale = sScale; PORTS_CTL.boosting = use.boosting && use.thrusting;
  portsTick(L, c.e!, PORTS_CTL);
  PORTS_CTL.active = null; PORTS_CTL.scale = null;
  if (use.storeCap !== undefined && use.storeCap < 1) portsCapStores(L, c.e!, use.storeCap);
  // (The engines' share all together; whether a boost is possible is each engine's own, folded into thrustShare)
  const frac = portsThrustFrac();
  let want = 0, got = 0;
  if (use.thrusting) for (const t of d.thrusters) { if (!sActive[t.part]) continue; const v = dhypot(t.force[0], t.force[1]); want += v; got += v * frac[t.part]; }
  // (Each feature's share: what its parts got of the burn it asked, weighted by that burn)
  let extra: (number | undefined)[] | undefined;
  if (X) for (let x = 0; x < X.length; x++) {
    const ask = X[x];
    if (!ask) continue;
    let w = 0, g = 0;
    const m = ask.length < L.n ? ask.length : L.n;
    for (let p = 0; p < m; p++) { if (!(ask[p] > 0) || !sActive[p] || L.thrustKind[p] === TK_ENGINE) continue; const b = L.burn[p] * sScale[p]; w += b; g += b * frac[p]; }
    if (w > 0) (extra ??= [])[x] = Math.min(1, g / w);
  }
  return { charge: c, power: want > 1e-15 ? Math.min(1, got / want) : 1, boost: use.boosting && use.thrusting, ...(extra ? { extra } : {}) };
}
/**
 * The share of their regen a ship's shields get (0..1): shields draw as tools, and refill only as fast as they are fed
 * (Kieran, 2026-11-06); an unfed shield doesn't refill. 1 for a ship whose power isn't accounted
 */
export function shieldShare(d: ShipDerived, c: Charge | undefined): number {
  if (!c?.e || c.e.held.length !== d.ports.n) return 1;
  return c.e.shieldSat / 255;
}
/** A client's charge: its state made (once a layout) and the row it was sent read into it */
const clientStates = new WeakMap<object, PortsState>();
export function ensurePortsCharge(d: ShipDerived, c: Charge): void {
  const L = d.ports;
  if (!c.e || c.e.held.length !== L.n) {
    let e = clientStates.get(L);
    if (!e) clientStates.set(L, (e = createPortsState(L)));
    c.e = e;
  }
  if (c.row) { unpackPortsInto(L, c.e, c.row); c.row = undefined; }
}
/** A ship's charge for a load test or a fresh spawn: everything full */
export function fullPortsCharge(d: ShipDerived): Charge {
  return { e: createPortsState(d.ports) };
}
export { fullPorts };

/**
 * How much harder the ship pushes forward boosting (the autopilot's and the HUD's estimate): each engine's boost is
 * folded into its thrust share, so it is the forward engines' boost multipliers, weighted by their push
 */
export function boostOf(d: ShipDerived): number {
  const L: PortsLayout = d.ports;
  let f = 0, b = 0;
  for (const t of d.thrusters) { const v = Math.max(0, -t.force[1]); f += v; b += v * L.boostMul[t.part]; }
  return f > 0 ? b / f : 1;
}

/**
 * The share of their push the engines pushing along `dir` (ship-local) get, each by its share of its burn this tick
 * and its boost, straight after powerTick (the core's maneuvering is its own, never short): what flight scales the
 * thrust by
 */
export function thrustShare(d: ShipDerived, c: Charge, dir: Vec2, fade: (rated: number | undefined) => number): number {
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

/** The same charge on a ship rebuilt (a part lost or mended): each part keeps what it held (power/ports.ts remapPorts) */
export function remapCharge(_before: ShipDerived, after: ShipDerived, c: Charge): Charge {
  return { e: c.e ? remapPorts(c.e, after.ports, c.e.held.length === after.ports.n) : createPortsState(after.ports) };
}

/**
 * Mining lasers, one tick: each runs its own pulses (MINE_CYCLE ticks) off its own buffer and cuts by its fulfilment
 * (power/ports.ts portsMineStep). Returns whether any beam is on this tick. A ship with no charge state mines nothing.
 */
export function payMining(ship: { derived: ShipDerived }, on: boolean, _tick: number, c: { charge: Charge }, stop = false): boolean {
  const miners = ship.derived.miners;
  if (!miners.length) return false;
  const pz = ship.derived.ports, pe = c.charge.e;
  if (!pe || pe.held.length !== pz.n) return false;
  if (stop) { portsMineStop(pz, pe); return false; }
  let any = false;
  for (const m of miners) if (portsMineStep(pz, pe, m.part, on) >= 0) any = true;
  return any;
}
