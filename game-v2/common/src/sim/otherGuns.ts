/**
 * Other ships' guns, stepped on every end from their inputs (sim foundation, after the C3 rollout). Before, another
 * ship's shells came as fire records a round trip late (snapshot.fire); the client had no gun state of other ships to
 * step. Now each armed ship a client holds has a gun lane: its gun state and stores (OwnExtras: the own ship's form),
 * stepped each tick beside its replica by the same cores the server's real ship runs, from the controls everyone has:
 *
 *   pilot      (replica mode Player) its held keys and aim (control rows) and its trigger, mining trigger and cursor
 *              distance (gun rows, snapshot.gun: packGunRow; the distance exact only while a trigger is held or
 *              changing, rough otherwise: an idle turret points at the aim and carries nothing, ships/guns.ts
 *              stepGuns, and laneHash leaves idle aim out), stepped by the own ship's step (ownStep.ts stepOwnShip:
 *              the accounted flight, for its stores) from its replica as it ended t - 1, then its guns (guns.ts
 *              stepShipGuns) at its replica's pose after t's step, before t's causes (where the server's fired from)
 *   pilotless  an AI pilot flown by its body on the client's tick layer (CAPS.PILOTS): its trigger and lead are its
 *              body's (bodies/aiPilot.ts aiFires, `aim`, `aimDist`), its battery the server's pilotless one (powerTick
 *              with no thrust, then the guns: server bridge/pilotless.ts)
 *
 * What the lane fired comes out as fire and fx events (guns.ts); `laneRecords` turns them into the records a fire row
 * carries (one per volley, pulse or tell), and the client builds the shells from them as it built a told record's, each
 * named by its shot id (`otherShotWire`) in place of a server entity id. The server runs the same lane (server
 * net/guns/GunNet.ts, from its real ship's pose and the replicated controls), compares what it fired with what the
 * real ship fired, and tells (a fire record, as before) only a tick where they differ: an ammunition round, a shot the
 * server's state alone decided. A tick told replaces the client's own records of that ship and tick; TELL_NONE says
 * nothing fired where the lane did.
 *
 * Point defence follows threats only the server sees (server features/support/pointDefence.ts): its aim isn't stepped
 * here and is left out of the hash, its intercepts are told as before, and each of its shots is told as a TELL_PD
 * record (lanePd) so the lane's cooldown and the power its reload draws stay the server's.
 *
 * A lane starts from a `gunSync` (the server's lane state, exact, at a snapshot's tick: first sight, a keyframe of the
 * ship, a rebuild, the lane off the real ship), and gun rows step from the controls it carries.
 */

import type { FlightBody } from '../ships/flight.js';
import { jumpPhase, jumpTuning } from '../ships/flight.js';
import type { ShipState } from '../ships/state.js';
import type { ShipTuning } from '../ships/tuning.js';
import { powerTick, ensurePortsCharge, remapCharge, type Charge } from '../ships/energy.js';
import { firesStraight } from '../ships/launch.js';
import { gunShell } from '../ships/hitRules.js';
import { TELL_CHARGE_START, TELL_CHARGE_CANCEL, TELL_BEAM_PIECE, TELL_MINE_PULSE } from '../ships/guns.js';
import { TRIG_LEFT, TRIG_RIGHT, trigSel } from '../ships/weaponGroups.js';
import { NO_HAZARD, cloneCharge, copyGunScalars, gunScalarsOntoRecord, GUN_SCALARS, GUN_SCALARS_HASHED, type GunScalarField, type GunState, type SimShipState, type SimStructure } from './state.js';
import type { SimInput } from './input.js';
import type { SimEnv } from './env.js';
import { SHOT_ID_BARRELS, SHOT_ID_SLOTS, shotIdParts, type SimEvent } from './events.js';
import type { OwnExtras } from './headHash.js';
import { shipHash } from './ring.js';
import { stepShipGuns, gunsTick, GUN_FX } from './guns.js';
import { stepOwnShip, cloneOwnExtras } from './ownStep.js';

/**
 * Where other ships' shells' wire names start: above every 31-bit id (entity ids, own shells' ownShotWire, move shells),
 * and every name under 2^48 (the packed codec's ids: network/packed/packedIO.ts isId). A name is its shot id's parts
 * (events.ts shotId: owner, tick, gun, barrel) with the tick mod 4096 (68 s: longer than any shell lives):
 *   OTHER_SHOT_WIRE0 + ((owner · 4096 + tick mod 4096) · 256 + slot) · 32 + barrel
 */
export const OTHER_SHOT_WIRE0 = 2 ** 31;
const WIRE_TICKS = 4096;
export function otherShotWireOf(owner: number, tick: number, slot: number, barrel: number): number {
  const t = ((tick % WIRE_TICKS) + WIRE_TICKS) % WIRE_TICKS;
  return OTHER_SHOT_WIRE0 + ((owner * WIRE_TICKS + t) * SHOT_ID_SLOTS + slot) * SHOT_ID_BARRELS + barrel;
}
/** Another ship's shell's wire name from its shot id */
export function otherShotWire(shot: number): number {
  const p = shotIdParts(shot);
  return otherShotWireOf(p.owner, p.tick16, p.slot, p.barrel);
}
export const isOtherShotWire = (id: number): boolean => id >= OTHER_SHOT_WIRE0;

/** Fire-row ammo code: nothing fired on this tick (the lane's records of it are wrong: no shells) */
export const TELL_NONE = 251;
/** Fire-row ammo code: a point-defence turret fired (its cooldown restarts: lanePd); drawn by its intercept */
export const TELL_PD = 250;

/** Gun-row control bits: a gun row's bits are the trigger word (weaponGroups.ts trigWord: left 1, right 2, the selection from bit 2) */
export const GUN_FIRE = TRIG_LEFT;
export const GUN_ALT = TRIG_RIGHT;

/** A ship's gun controls on a tick: its triggers and cursor distance (world units, on the 4-unit input grid) */
export interface GunCtl { bits: number; dist: number }
const NO_GUN_CTL: Readonly<GunCtl> = Object.freeze({ bits: 0, dist: 0 });

/** What a ship's guns did on a tick, as a fire row carries it: a volley (n shells), a pulse (n 0) or a tell (code) */
export interface LaneRec { tick: number; part: number; code: number; aimQ: number; aug: 0 | 1; n: number }

/** Can another end build this gun's shells from a record (straight from the muzzle: as OwnShells.derivable) */
export function shellsDerivable(tuning: ShipTuning, ship: ShipState, gun: number): boolean {
  const sh = gunShell(tuning, ship, gun);
  return !!sh && firesStraight(sh.def) && !sh.def.lob && !sh.def.arm;
}

const FX_CODE: Record<string, number | undefined> = {
  [GUN_FX.pulse]: 0, [GUN_FX.chargeStart]: TELL_CHARGE_START, [GUN_FX.chargeCancel]: TELL_CHARGE_CANCEL,
  [GUN_FX.beamPiece]: TELL_BEAM_PIECE, [GUN_FX.minePulse]: TELL_MINE_PULSE,
};

/**
 * A tick's gun events as records (into `out`, cleared): a volley of straight shells per gun (others go as rows: homing,
 * lobbed, arming), a pulse, a charge tell, a beam's piece, a mining laser's pulse. In a fixed order (by part, then code)
 */
export function laneRecords(events: readonly SimEvent[], ship: ShipState, tuning: ShipTuning, out: LaneRec[] = []): LaneRec[] {
  out.length = 0;
  for (const e of events) {
    if (e.k === 'fire') {
      if (e.barrel !== 0) { const r = out.find((x) => x.tick === e.tick && x.part === e.slot && x.code === 0 && x.n > 0); if (r) r.n++; continue; }
      const aug = e.aug ? 1 : 0;
      if (!shellsDerivable(tuning, ship, e.slot + (aug ? 65536 : 0))) continue;
      out.push({ tick: e.tick, part: e.slot, code: 0, aimQ: e.aimQ, aug, n: 1 });
    } else if (e.k === 'fx') {
      const code = FX_CODE[e.fx];
      if (code === undefined) continue;
      out.push({ tick: e.tick, part: e.part, code, aimQ: e.aq ?? 0, aug: 0, n: 0 });
    }
  }
  out.sort(recOrder);
  return out;
}

const recOrder = (a: LaneRec, b: LaneRec) => a.part - b.part || a.code - b.code || a.n - b.n;

/** A server fire record as a LaneRec (a volley it can't name by shot ids: n -1, never one a lane matches) */
export function firedRec(f: { tick: number; part: number; ammo?: number; aug?: 1; aimQ: number; ids: readonly number[]; shots?: readonly number[] }): LaneRec {
  const n = f.ids.length && (!f.shots || f.shots.length !== f.ids.length) ? -1 : f.ids.length;
  return { tick: f.tick, part: f.part, code: f.ammo ?? 0, aimQ: f.aimQ, aug: f.aug ? 1 : 0, n };
}

/** Two ticks' records the same (each list in laneRecords' order) */
export function sameRecs(a: readonly LaneRec[], b: readonly LaneRec[]): boolean {
  if (a.length !== b.length) return false;
  const bs = b.length > 1 ? [...b].sort(recOrder) : b;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = bs[i];
    if (x.part !== y.part || x.code !== y.code || x.aimQ !== y.aimQ || x.aug !== y.aug || x.n !== y.n) return false;
  }
  return true;
}

/** A record as a fire row ([owner, ticksAgo, part + 256 × code + 65536 × aug, aimQ, ...shell names]), named by shot id */
export function laneFireRow(owner: number, snapTick: number, r: LaneRec): number[] {
  const row = [owner, snapTick - r.tick, r.part + 256 * r.code + (r.aug ? 65536 : 0), r.aimQ];
  for (let i = 0; i < r.n; i++) row.push(otherShotWireOf(owner, r.tick, r.part, i));
  return row;
}

// ---------------------------------------------------------------------------------------------------- the lane's step

const BIT_EMP = 512;
const PILOT_IN: SimInput = { bits: 0, q: 0, jumpDist: -1, fire: false, fireAlt: false, aimDist: 0 };
const PILOT_X = { fire: false, fireAlt: false, jumpDist: -1, aimDist: 0, sel: 0 };
const NO_EVENTS: SimEvent[] = [];
/** (lanePilot's flight: the env given, the guns left to the lane's own phase) */
const MOTION_ENV: SimEnv = { tick: 0, tuning: undefined as unknown as SimEnv['tuning'], gravity: null, fields: { central: null }, terrain: null, gunsByHost: true };

/**
 * One tick of a pilot's lane: its stores through its accounted flight from `before` (its replica as it ended t - 1;
 * untouched), with its held keys and aim (`bits`, `q`: what it flew, its engines' power bits dropped as stepOwnShip
 * drops them, its hazard bits kept), then its guns at `after` (its replica after t's step, before t's causes) on the
 * gun controls. Its fire and fx events go to `events`. Returns the lane's state as tick t ended
 */
export function lanePilot(id: number, prev: Readonly<OwnExtras>, before: Readonly<FlightBody>, after: Readonly<FlightBody>, bits: number, q: number, g: Readonly<GunCtl>, structure: SimStructure, env: SimEnv, events: SimEvent[]): OwnExtras {
  let x: OwnExtras;
  if (structure.derived.energy || structure.derived.ports) {
    // (The flight only for its stores: the replica's own step is the pose; the guns' phase runs below, at that pose)
    const me = MOTION_ENV;
    me.tick = env.tick; me.tuning = env.tuning; me.gravity = env.gravity; me.fields = env.fields; me.terrain = env.terrain; me.hazard = env.hazard;
    NO_EVENTS.length = 0;
    PILOT_X.fire = (g.bits & GUN_FIRE) !== 0; PILOT_X.fireAlt = (g.bits & GUN_ALT) !== 0; PILOT_X.aimDist = g.dist; PILOT_X.sel = trigSel(g.bits);
    const s = stepOwnShip(id, prev, { ...before }, bits, q, PILOT_X, structure, me, NO_EVENTS);
    x = { charge: s.charge, guns: s.guns, hazard: { ...NO_HAZARD }, jumpPrime: s.jumpPrime };
  } else x = cloneOwnExtras(prev);
  const s: SimShipState = { id, mode: 0 as SimShipState['mode'], body: after as FlightBody, ctl: { bits, q }, charge: x.charge, accounted: true, jumpPrime: x.jumpPrime, hazard: x.hazard, guns: x.guns, structure };
  PILOT_IN.bits = bits; PILOT_IN.q = q; PILOT_IN.fire = (g.bits & GUN_FIRE) !== 0; PILOT_IN.fireAlt = (g.bits & GUN_ALT) !== 0; PILOT_IN.aimDist = g.dist; PILOT_IN.sel = trigSel(g.bits);
  ensurePortsCharge(structure.derived, s.charge);
  stepShipGuns(s, PILOT_IN, env, events);
  x.charge = s.charge;
  return x;
}

/** (A lane's gun state as the firing models read it: the structure's record, the lane's gun state on top) */
function laneView(ship: ShipState, g: GunState): ShipState {
  const v = Object.create(ship) as ShipState;
  v.cooldown = g.cooldown; v.rounds = g.rounds; v.reload = g.reload; v.charge = g.charge; v.spin = g.spin; v.aim = g.aim;
  gunScalarsOntoRecord(g, v);
  return v;
}

const PILOTLESS_USE = { thrusting: false, boosting: false };

/**
 * One tick of an AI pilot's lane, as the server's stepPilotless runs its battery and guns: spare power charges it
 * (powerTick, no thrust), then its guns at `after` (after t's step, before t's causes) on its body's trigger (`fire`),
 * lead (`aim`: undefined none) and distance; nothing fires EMP'd (`bits`' CTL.emp: what it flew) or mid-jump
 */
export function lanePilotless(id: number, prev: Readonly<OwnExtras>, after: Readonly<FlightBody>, bits: number, fire: boolean, aim: number | undefined, aimDist: number, ship: ShipState, tick: number, tuning: ShipTuning, events: SimEvent[], derived: ShipState['derived'] = ship.derived): OwnExtras {
  const x = cloneOwnExtras(prev), d = derived;
  const view = laneView(ship, x.guns);
  view.derived = d;
  ensurePortsCharge(d, x.charge);
  const energy = { charge: powerTick(d, x.charge, PILOTLESS_USE).charge };
  const burning = jumpPhase(after.jump ?? 0, jumpTuning(tuning)).phase === 'burn';
  const firing = fire && (bits & BIT_EMP) === 0 && !burning;
  gunsTick(view, id, after, { firing, aimWorld: aim, aimDist, energy }, tick, tuning, events);
  // (Every scalar back: the mining ones and the tow come back as they went in, no mining runs here)
  copyGunScalars(view, x.guns);
  x.charge = energy.charge;
  return x;
}

/**
 * A lane's stores moved onto a new structure (a rebuild between two ticks: what the server's rebuild does to the real
 * ship's, energy.ts remapCharge), in place
 */
export function laneRemap(x: OwnExtras, before: ShipState['derived'], after: ShipState['derived']): void {
  if (before !== after) x.charge = remapCharge(before, after, cloneCharge(x.charge));
}

/**
 * A point-defence turret's shot told (TELL_PD), into a lane's state as tick t ended: its cooldown restarts as the
 * server's turret's does (server features/support/pointDefence.ts). Its aim is the server's alone (not stepped, not hashed)
 */
export function lanePd(x: OwnExtras, ship: ShipState, part: number): void {
  const w = ship.derived.weapons.find((v) => v.part === part);
  if (!w) return;
  const cd = x.guns.cooldown[part] ?? 0;
  x.guns.cooldown[part] = (cd > -1 ? cd : 0) + w.interval;
}

/** Parts of point-defence guns (their aim follows the server's threats: left out of the lane's hash) */
export function pdParts(ship: ShipState, tuning: ShipTuning): number[] {
  const out: number[] = [];
  for (const w of ship.derived.weapons) if (tuning.weapons?.[w.kind]?.pointDefence) out.push(w.part);
  return out;
}

const HASH_STATE: SimShipState = {
  id: 0, mode: 0 as SimShipState['mode'], body: { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angVel: 0 }, ctl: { bits: 0, q: 0 }, charge: {},
  accounted: true, jumpPrime: 0, hazard: NO_HAZARD as SimShipState['hazard'], guns: undefined as unknown as GunState,
  structure: { derived: undefined as unknown as SimStructure['derived'], version: 0 },
};

/**
 * A lane's state hash (what the server's lane and the real ship are compared by, and the PT layer's lane against the
 * confirmed one): its stores and gun state, less point defence's aim (pd: its parts), every gun's aim while the
 * trigger isn't held (an idle turret points at the aim and carries nothing to the next tick: ships/guns.ts stepGuns;
 * other pilots' idle aim distance is sent only roughly, GunNet) and the Tow Beam's towed entity (the tow feature's).
 * Pose, controls, hazards and priming aren't the lane's (its replica's)
 */
export function laneHash(id: number, x: Readonly<OwnExtras>, pd: readonly number[] = []): number {
  const s = HASH_STATE, g = x.guns;
  s.id = id; s.charge = x.charge;
  let aim = g.aim;
  if (!g.triggerHeld) aim = g.aim.length ? new Array<number>(g.aim.length).fill(0) : g.aim;
  else if (pd.length) { aim = [...g.aim]; for (const p of pd) aim[p] = 0; }
  const v = { cooldown: g.cooldown, rounds: g.rounds, reload: g.reload, charge: g.charge, spin: g.spin, aim } as GunState;
  copyGunScalars(g, v);
  v.tow = undefined;
  s.guns = v;
  return shipHash(s);
}

/** A lane's state from a ship's record and stores (the server's real ship: what a gunSync is cut from) */
export function laneOf(guns: GunState, charge: Charge): OwnExtras {
  return { charge: cloneCharge(charge), guns: { ...guns, cooldown: [...guns.cooldown], rounds: [...guns.rounds], reload: [...guns.reload], charge: [...guns.charge], spin: [...guns.spin], aim: [...guns.aim] }, hazard: { ...NO_HAZARD }, jumpPrime: 0 };
}

// ------------------------------------------------------------------------------------------------------------ the wire

/**
 * `gunSync` (a plain message, server to a client, just before a snapshot): ship `id`'s gun lane as tick `t` ended,
 * exact, and its gun controls then (which that ship's gun rows step from). Its lane starts here; its fire records
 * through t are told. `z` is the whole state as one list of numbers (packGunSync: each array sparse, packArr):
 *   [ports?, (sig, shieldSat, gauge, mach, ...held, ...flags, ...amt, ...mat, ...closed, ...aug, ...sat), ...cooldown,
 *    ...rounds, ...reload, ...charge, ...spin, ...aim, triggerHeld, clickAt, tow, control bits, cursor distance / 4, held
 *    aim distance (ships/guns.ts distDue), trigger word (weaponGroups.ts trigWord), then any later gun scalars
 *    (sim/state.ts GUN_SCALARS past GUN_SCALARS_HASHED, trailing absent ones left off)]
 * (each `...x` an array as its packArr's length, then the packArr; absent: -1; an absent scalar: null). The mining
 * scalars (minePaid, mineUntil, mineShare) don't go: a lane runs no mining (its guns' step only zeroes mineUntil when
 * stopped), and nothing a client does with a lane reads them; its lane has them undefined
 */
/** The gun scalars a gunSync leaves out (a lane runs no mining): its lane has them undefined */
export const GUN_SYNC_UNSENT = ['minePaid', 'mineUntil', 'mineShare'] as const;

export interface ServerGunSyncMessage {
  type: 'gunSync';
  id: number;
  t: number;
  z: (number | null)[];
  /**
   * The first tick whose fire records the server tells (its round's span: earlier ticks, rounds that sent this client
   * nothing, it decided then, and the client works them out from the lane it had). Absent: t + 1 (all through t told)
   */
  w?: number;
  /**
   * The lane stands (z empty): the ship was keyframed in this snapshot, so this round's span (from w) is told, as rows;
   * the client keeps its lane and steps on from it
   */
  keep?: 1;
}

/** The gun state's and a ports ship's stores' arrays (by part, by port): sent sparse (packArr) */
const GUN_ARRAYS = ['cooldown', 'rounds', 'reload', 'charge', 'spin', 'aim'] as const;
const PORT_ARRAYS = ['held', 'flags', 'amt', 'mat', 'closed', 'aug', 'sat'] as const;

/** An array as [length, its commonest value, then index, value for each other entry] */
export function packArr(a: ArrayLike<number>): number[] {
  const n = a.length;
  if (!n) return [0];
  const count = new Map<number, number>();
  let m = a[0], best = 0;
  for (let i = 0; i < n; i++) { const c = (count.get(a[i]) ?? 0) + 1; count.set(a[i], c); if (c > best) { best = c; m = a[i]; } }
  const out = [n, m];
  for (let i = 0; i < n; i++) if (a[i] !== m) out.push(i, a[i]);
  return out;
}

export function unpackArr(p: readonly number[] | undefined): number[] {
  if (!p || !p.length) return [];
  const out = new Array<number>(p[0]).fill(p[1] ?? 0);
  for (let i = 2; i + 1 < p.length; i += 2) out[p[i]] = p[i + 1];
  return out;
}

const putArr = (z: (number | null)[], a: ArrayLike<number> | undefined) => { if (!a) { z.push(-1); return; } const p = packArr(a); z.push(p.length, ...p); };
const opt = (v: number | undefined) => (v === undefined ? null : v);

export function packGunSync(id: number, t: number, x: Readonly<OwnExtras>, k: Readonly<GunCtl>): ServerGunSyncMessage {
  const c = x.charge, g = x.guns, z: (number | null)[] = [];
  // (mach: which field machines draw, so another ship's guns get the power its own do; their energy counters aren't needed here)
  if (c.e) { z.push(1, c.e.sig, c.e.shieldSat, c.e.gauge, c.e.mach ?? 0); for (const a of PORT_ARRAYS) putArr(z, c.e[a]); } else z.push(0);
  for (const a of GUN_ARRAYS) putArr(z, g[a]);
  z.push(g.triggerHeld ? 1 : 0, g.clickAt, opt(g.tow), k.bits, Math.round(k.dist / 4), opt(g.heldDist), g.trig ?? 0);
  // (Scalars past the hand-ruled ones (state.ts GUN_SCALARS_HASHED), in order, absent as null, the trailing absent ones left off)
  const end = z.length;
  for (let n = GUN_SCALARS_HASHED; n < GUN_SCALARS.length; n++) z.push(opt(g[GUN_SCALARS[n]] as number | undefined));
  while (z.length > end && z[z.length - 1] === null) z.pop();
  return { type: 'gunSync', id, t, z };
}

export function unpackGunSync(m: ServerGunSyncMessage): { x: OwnExtras; k: GunCtl } {
  const z = m.z;
  let i = 0;
  const num = () => z[i++] as number;
  const val = () => { const v = z[i++]; return v === null ? undefined : v; };
  const arr = () => { const n = num(); if (n < 0) return undefined; const p = z.slice(i, i + n) as number[]; i += n; return unpackArr(p); };
  const charge: Charge = {};
  if (num() === 1) {
    const sig = num(), shieldSat = num(), gauge = num(), mach = num();
    const [held, flags, amt, mat, closed, aug, sat] = PORT_ARRAYS.map(() => arr() ?? []);
    charge.e = { sig, shieldSat, gauge, held: Int32Array.from(held), flags: Uint8Array.from(flags), amt: Int32Array.from(amt), mat: Uint8Array.from(mat), closed: Int16Array.from(closed), aug: Int32Array.from(aug), sat: Uint8Array.from(sat), mach, machEu: new Float64Array(3) };
  }
  const [cooldown, rounds, reload, gcharge, spin, aim] = GUN_ARRAYS.map(() => arr() ?? []);
  const guns: GunState = { cooldown, rounds, reload, charge: gcharge, spin, aim, triggerHeld: num() === 1, clickAt: num(), minePaid: undefined, mineUntil: undefined, mineShare: undefined, tow: val() };
  const bits = num(), dist = num() * 4;
  if (i < z.length) guns.heldDist = val();
  if (i < z.length) guns.trig = num();
  for (let n = GUN_SCALARS_HASHED; n < GUN_SCALARS.length && i < z.length; n++) (guns as Record<GunScalarField, unknown>)[GUN_SCALARS[n]] = val();
  return { x: { charge, guns, hazard: { ...NO_HAZARD }, jumpPrime: 0 }, k: { bits, dist } };
}

/**
 * Pilots' gun-control changes in a snapshot's window: the snapshot's `gun` rows (each a packGunRow row) and its tick
 * `t`, taken before the rest of the snapshot. They ride in the snapshot (each row an encode-once block: network/packed
 * blocks.ts BlockStore.gunRow), not a message of their own
 */
export interface GunCtlRows {
  t: number;
  r: readonly (readonly number[])[];
}

/**
 * A pilot's gun-control changes as a row (gunCtl): [id, tb, dd, tb, dd, ...], events oldest first, tb = bits × 8 +
 * ticksAgo (7 or more: bits × 8 + 7, then ticksAgo), dd the distance's step (in 4-unit steps) from the one before, the
 * first from `base` (what the client has: its gunSync's or the last row's). A run of one change a tick with the same
 * bits: [-1 - id, tb, dd, dd, ...]
 */
export function packGunRow(id: number, events: readonly (readonly [number, number, number])[], base: number): number[] {
  const tb = (t: number, b: number) => (t < 7 ? [b * 8 + t] : [b * 8 + 7, t]);
  const dd = events.map(([, , d], i) => d - (i ? events[i - 1][2] : base));
  const run = events.length > 1 && events.every(([t, b], i) => i === 0 || (t === events[i - 1][0] - 1 && b === events[0][1]));
  if (run) return [-1 - id, ...tb(events[0][0], events[0][1]), ...dd];
  return [id, ...events.flatMap(([t, b], i) => [...tb(t, b), dd[i]])];
}

export function gunRowId(row: readonly number[]): number {
  return row[0] < 0 ? -1 - row[0] : row[0];
}

/** packGunRow undone: [ticksAgo, bits, distance in 4-unit steps], oldest first */
export function unpackGunRow(row: readonly number[], base: number): [number, number, number][] {
  const out: [number, number, number][] = [];
  let d = base, i = 1;
  const tb = (): [number, number] => { const v = row[i++]; return [v % 8 === 7 ? row[i++] : v % 8, Math.floor(v / 8)]; };
  if (row[0] < 0) {
    const [t, b] = tb();
    for (let k = 0; i < row.length; k++) { d += row[i++]; out.push([t - k, b, d]); }
    return out;
  }
  while (i < row.length) { const [t, b] = tb(); d += row[i++]; out.push([t, b, d]); }
  return out;
}
