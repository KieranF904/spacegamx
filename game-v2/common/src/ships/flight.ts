/**
 * Flight on derived stats. Keeps the legacy controls (screen-relative WASD,
 * ship turns to face the cursor, same friction and boost), but acceleration
 * comes from thrust / mass and turning from torque / inertia (towards the cursor, braking in time: steerSpin).
 */

import type { Vec2 } from './types.js';
import type { ShipDerived } from './rebuild.js';
import type { ShipTuning } from './tuning.js';
import { capCharge, powerTick, thrustShare, type Charge } from './energy.js';
import { cargoThrust, cargoTurn } from './load.js';
import type { FlightCtx } from './features/types.js';
import type { FlightEntry } from './features/plan.js';
import { getPlan } from './features/plan.js';
import { dhypot, dlog2, dpow, dsincos } from '../math/detTrig.js';

// (dsincos's result, reused: the flight step allocates nothing for its trig)
const SC: [number, number] = [0, 0];

export interface FlightBody {
  x: number; y: number;
  vx: number; vy: number;
  angle: number;
  angVel: number;
  /** Jump drive counter (see stepJump); absent = 0 (ready) */
  jump?: number;
  /** This jump's burn as a fraction of a full-power one (set when the burn starts: jumpBurnSpeed) */
  jumpScale?: number;
  /** A replica's stillstone priming (jumpFields.ts stepPrime), as replicaStep keeps it: carried, not sent; absent = 0 (sim/step.ts) */
  jumpPrime?: number;
  /** Mass of the cargo in the hold (load.ts): carried, not stepped; absent = 0 */
  cargo?: number;
  /** Burst Strafer (features/strafer): the dodge counter and the way of the last dodge (1..DODGE_DIRS, ship-local); absent = 0 */
  dodge?: number;
  dodgeDir?: number;
}

export interface FlightControls {
  forward: boolean; backward: boolean; left: boolean; right: boolean;
  boost: boolean;
  targetAngle: number;
  /**
   * Helm controls: left/right turn the ship, forward/backward and
   * strafeLeft/strafeRight thrust relative to it. Otherwise (mouse-steer) the
   * ship turns to targetAngle and the four directions are screen-relative
   * (world-aligned), or ship-relative with both strafe bits held (noseFrame).
   */
  helm?: boolean;
  strafeLeft?: boolean;
  strafeRight?: boolean;
  /** Jump drive: held (or latched) to spool up; releasing during the charge cancels it */
  jump?: boolean;
  /** How far to jump (world units; the cursor distance): where the ship comes to rest. 0 = as far as the drive goes; below 0: not known (a replica: the charge waits) */
  jumpDist?: number;
  /** Burst Strafer: held to dodge, the way the movement keys ask; one burst a press (features/strafer: its input, filled from the plan's held inputs) */
  dodge?: boolean;
}

export interface FlightConstants {
  friction: number;
  boostFactor: number;
  worldSize: number;
  /** A gravity well at the system origin (black holes), or none */
  gravity?: GravityWell | null;
  /** Jump range multiplier here (a star's charging ring or a stillstone's priming: jumpFields.ts fieldRangeBoost) */
  jumpBoost?: number;
  /** What hazards do to this ship here (ships/hazards.ts hazardFlight) */
  hazard?: { control: number; driftAccel: number; jump: number; cap: number };
}

/**
 * Slowed (a Frostbite beam's status, features/weaponry): thrust and turning × this while lit and a while after. The
 * server flies it from its own clock, the pilot's prediction from the slowed ticks in its row, replicas from CTL.slowed
 * (replica.ts): the same hazard on every side, applied after the cold's numbness and before an EMP.
 */
export const SLOW_CONTROL = 0.6;

const SLOWED_ALONE: NonNullable<FlightConstants['hazard']> = Object.freeze({ control: SLOW_CONTROL, driftAccel: 0, jump: 1, cap: 1 });
const slowedScratch: NonNullable<FlightConstants['hazard']> = { control: 1, driftAccel: 0, jump: 1, cap: 1 };

/** What a slowed drive flies with (allocation-free: the result is only good until the next call, so pass it straight on) */
export function withSlowed(h: FlightConstants['hazard'] | undefined, slowed: boolean): FlightConstants['hazard'] | undefined {
  if (!slowed) return h;
  if (!h) return SLOWED_ALONE;
  slowedScratch.control = h.control * SLOW_CONTROL;
  slowedScratch.driftAccel = h.driftAccel;
  slowedScratch.jump = h.jump;
  slowedScratch.cap = h.cap;
  return slowedScratch;
}

/** Pull towards the system origin: a = strength / max(r, minRadius)² */
export interface GravityWell {
  strength: number;
  minRadius: number;
  /** Crossing this radius destroys a ship (the server enforces it) */
  horizon?: number;
}

/** Add one tick of the well's pull to a body's velocity. */
export function applyGravity(body: { x: number; y: number; vx: number; vy: number }, g: GravityWell | null | undefined): void {
  if (!g) return;
  const r = dhypot(body.x, body.y);
  if (r < 1e-6) return;
  const m = Math.max(r, g.minRadius);
  const a = g.strength / (m * m);
  body.vx -= (body.x / r) * a;
  body.vy -= (body.y / r) * a;
}

export interface FlightResult {
  /** The batteries' charge after this tick (energy.ts) */
  charge: Charge;
  isBoosting: boolean;
  /** How much of their power the engines got (1 unless they ran on empty) */
  power: number;
  /** Linear acceleration applied this tick, world units / tick² */
  accel: number;
  /** What a replica must be told in the control bits to fly this step the same (power, a refused boost): ctlOfPower */
  ctlPower: number;
}

// ---------------------------------------------------------------------------
// Jump drive
// ---------------------------------------------------------------------------

/**
 * The jump drive: spool up for a moment, then the ship is flung along the aim
 * for a fixed, short burn (a longer jump just goes faster), then the drive
 * cools down. The charge waits on its last tick until the nose is within
 * JUMP_ALIGN of the aim (jumpAimed), and the burn then goes exactly along the
 * aim. The burn ends at exitSpeed (0: dead still, right where it was aimed;
 * above 0 the ship coasts the rest, jumpCoast). Its whole state is one integer
 * counter, so it rides in snapshots and prediction replays it exactly.
 *
 * A short jump charges longer (Kieran, 2026-11-05: "Short jumps are allowed,
 * just add more charge time"): up to shortRange the charge adds the time it
 * would take to fly there at shortCruise, so a short jump is never quicker
 * than flying it; past shortRange that extra tapers off, gone by shortTaper
 * (jumpChargeNeed). The counter counts the ticks charged, so the burn starts
 * at a fixed count past the longest charge (jumpBurnAt):
 *
 *   0                                  ready
 *   1 .. burnAt-1                      charging (counts the ticks charged while the jump control is held; the burn
 *                                      starts once it has charged jumpChargeNeed for the jump aimed, and the nose is
 *                                      aimed; till then it waits, at burnAt-1 at most)
 *   burnAt .. +burnTicks-1             burn (the jump itself)
 *   .. +cooldownTicks-1                cooling down, then back to 0
 */
export interface JumpTuning {
  /** The charge for a long jump (ticks); a short one adds to it (jumpChargeNeed) */
  chargeTicks: number;
  /** Short jumps: a reference cruise speed (world units a tick); up to shortRange the charge adds the time to fly the jump at it */
  shortCruise: number;
  shortRange: number;
  /** ...and past shortRange that extra tapers off, gone by here (world units) */
  shortTaper: number;
  burnTicks: number;
  /** Cooldown at the sweet spot (coils just right for the hull, Mk I: jumpDriveStats) */
  cooldownTicks: number;
  /** World units / tick at full burn (jumpScale 1; a jump's own scale sets how fast it really goes) */
  speed: number;
  /** Speed the ship leaves the burn at, whatever the jump's length (then friction takes over: jumpCoast). 0: it stops dead where it was aimed */
  exitSpeed: number;
  /** Ticks to reach full speed, and to slow down to exitSpeed at the end */
  rampTicks: number;
  slowTicks: number;
  /** Velocity kept per tick while charging (the drive holds the ship still) */
  chargeDamping: number;
  /** Reach at the sweet spot (world units, including the coast: jumpDriveStats) */
  baseRange: number;
  /**
   * The coils' capacity against the hull's demand (jumpDriveStats). The core's own
   * coil serves this many cells of hull; a jump coil this many per cell of its own
   * (functions.json jumpCapacity), and better grades this fraction more per grade.
   */
  coreCapacity: number;
  gradeCapacity: number;
  /** At the sweet spot, better coils reach this fraction further and cool this fraction faster per grade */
  gradeRange: number;
  gradeCooldown: number;
  /** Over-coiled: range × (1 + overRange·log2 ratio) up to +overRangeMax; cooldown ÷ (1 + overCooldown·log2 ratio), never under cooldownFloor of the sweet spot's nor minCooldownTicks */
  overRange: number;
  overRangeMax: number;
  overCooldown: number;
  cooldownFloor: number;
  minCooldownTicks: number;
  /** Under-coiled: range × ratio^underRange (not under underRangeFloor of it), cooldown × ratio^-underCooldown (up to underCooldownCap times) */
  underRange: number;
  underRangeFloor: number;
  underCooldown: number;
  underCooldownCap: number;
  /** Shortest jump (including the coast) */
  minRange: number;
  /** Near a star (within this far of its surface) the drive charges faster and reaches further */
  solarRing: number;
  solarRangeBoost: number;
  /** Extra cooldown ticks counted per tick in the ring (2 = three times as fast) */
  solarCharge: number;
  /** Stillstones (systems.json `lodestones`, jumpFields.ts): what they're called, and on the gauge */
  lodestoneName: string;
  lodestoneShort: string;
  /** One's radius when it doesn't give its own `size` (world units) */
  lodestoneSize: number;
  /** How far their charging field reaches past the stone, and extra cooldown ticks per tick inside it */
  lodestoneField: number;
  lodestoneCharge: number;
  /** A primed drive's range multiplier, and how long the priming lasts after leaving the field (ticks) */
  lodestoneRangeBoost: number;
  lodestonePrimeTicks: number;
  /** A scarred one keeps this share of the charge and of the range boost */
  lodestoneScarredCharge: number;
  lodestoneScarredBoost: number;
}

export const DEFAULT_JUMP: JumpTuning = {
  chargeTicks: 90, burnTicks: 90, cooldownTicks: 900,
  shortCruise: 20, shortRange: 12000, shortTaper: 25000,
  speed: 340, exitSpeed: 0, rampTicks: 5, slowTicks: 16, chargeDamping: 0.96,
  baseRange: 50000, minRange: 5000,
  coreCapacity: 40, gradeCapacity: 0.1, gradeRange: 0.05, gradeCooldown: 0.0625,
  overRange: 0.15, overRangeMax: 0.35, overCooldown: 0.2, cooldownFloor: 0.7, minCooldownTicks: 600,
  underRange: 0.6, underRangeFloor: 0.6, underCooldown: 0.7, underCooldownCap: 1.6667,
  solarRing: 9000, solarRangeBoost: 1.25, solarCharge: 1,
  lodestoneName: 'Stillstone', lodestoneShort: 'Stillstone', lodestoneSize: 900,
  lodestoneField: 1250, lodestoneCharge: 1, lodestoneRangeBoost: 1.2, lodestonePrimeTicks: 3600,
  lodestoneScarredCharge: 0.5, lodestoneScarredBoost: 0.5,
};

/** Cells of hull a coil serves: its base capacity (the core's coreCapacity, or a coil's jumpCapacity × area), more for a better grade */
export function coilCapacity(base: number, grade: number, t: JumpTuning): number {
  return base * (1 + t.gradeCapacity * (Math.max(1, grade) - 1));
}

/** What a drive does for a hull */
export interface JumpDriveStats {
  /** Reach (world units) and cooldown (ticks), whole numbers (the server and every client work them out alike) */
  range: number;
  cooldown: number;
  /** The coils' capacity over what the hull needs (1: the sweet spot) */
  ratio: number;
}

/**
 * A drive's reach and cooldown from its coils' capacity (cells of hull they
 * serve: the core's own coil, and jump coils) against the hull's demand (its
 * cells), and the coils' grade (capacity-weighted). Just right (ratio 1) is the
 * sweet spot: baseRange and cooldownTicks, a little better with better coils.
 * More coils than the hull needs help less and less (and the cooldown has a
 * floor); too few for a big hull and it reaches less and recharges slower, but
 * never uselessly so.
 */
export function jumpDriveStats(capacity: number, demand: number, grade: number, t: JumpTuning): JumpDriveStats {
  const ratio = demand > 0 ? Math.max(0, capacity) / demand : 1;
  const g = Math.max(0, grade - 1);
  const sweetRange = t.baseRange * (1 + t.gradeRange * g);
  const sweetCool = t.cooldownTicks / (1 + t.gradeCooldown * g);
  let range: number, cool: number;
  if (ratio >= 1) {
    const doublings = dlog2(ratio);
    range = sweetRange * (1 + Math.min(t.overRangeMax, t.overRange * doublings));
    cool = Math.max(sweetCool * t.cooldownFloor, t.minCooldownTicks, sweetCool / (1 + t.overCooldown * doublings));
  } else {
    range = sweetRange * Math.max(t.underRangeFloor, dpow(ratio, t.underRange));
    cool = sweetCool * Math.min(t.underCooldownCap, ratio > 0 ? dpow(ratio, -t.underCooldown) : Infinity);
  }
  return { range: Math.round(range), cooldown: Math.round(cool), ratio: Math.round(ratio * 100) / 100 };
}

/** How far a ship's drive reaches here */
export function jumpRange(d: { jumpRange?: number }, t: JumpTuning, boost = 1): number {
  return (d.jumpRange ?? t.baseRange) * boost;
}

/**
 * The one reach rule: the drive's range × the charging fields' boost (a star's ring, a primed drive: jumpFields.ts
 * fieldRangeBoost) × a gravity hazard's jump share (hazards.ts hazardFlight). The burn fixes its length by it, and the
 * pilot's overlay draws it
 */
export function jumpReachAt(d: { jumpRange?: number }, t: JumpTuning, fieldBoost = 1, hazard?: { jump: number } | null): number {
  return jumpRange(d, t, fieldBoost * (hazard?.jump ?? 1));
}

/**
 * How far a jump aimed `dist` away goes (0 or none: as far as it reaches `reach`; never short of minRange). Below 0:
 * not known (a replica's controls: flightControls), -1
 */
export function jumpGoFor(dist: number | undefined, reach: number, t: JumpTuning): number {
  if (dist !== undefined && dist < 0) return -1;
  return Math.max(t.minRange, Math.min(reach, dist && dist > 0 ? dist : reach));
}

/** The charge waits on its last tick until the nose is this close to the aim (radians); the burn then goes along the aim itself */
export const JUMP_ALIGN = 0.03;

/**
 * Mouse-steer with the movement keys pushing along the ship (W the nose, A/D sideways), for the view that follows the
 * heading (hits.ts CAPS.NOSE; client input/viewMode.ts). Said by both strafe bits with helm off: a pair no input sent
 * before (mouse-steer never sent a strafe, and at the helm the two cancel), so it needs no new wire field and replicas
 * get it in the control bits they already carry.
 */
export function noseFrame(input: { helm?: boolean; strafeLeft?: boolean; strafeRight?: boolean }): boolean {
  return !input.helm && !!input.strafeLeft && !!input.strafeRight;
}

/** Is the ship pointed for a jump: helm (the nose is the aim), or the nose within JUMP_ALIGN of the aim */
export function jumpAimed(body: { angle: number }, input: { helm?: boolean; targetAngle: number }): boolean {
  return !!input.helm || Math.abs(wrapAngle(input.targetAngle - body.angle)) <= JUMP_ALIGN;
}

/** Is (x, y) inside a system's charging ring (stars and pulsars; black holes have none) */
export function inSolarRing(x: number, y: number, body: { type?: string; radius?: number } | null | undefined, t: JumpTuning): boolean {
  if (!body || body.type === 'black_hole' || body.type === 'none' || !body.radius) return false;
  return dhypot(x, y) < solarRingRadius(body.radius, t);
}

/** How far out a star's charging ring reaches (from its centre) */
export function solarRingRadius(radius: number, t: JumpTuning = DEFAULT_JUMP): number {
  return Math.max(5000, radius + t.solarRing);
}

export type JumpPhase = 'ready' | 'charging' | 'burn' | 'cooldown';

export function jumpTuning(t: ShipTuning): JumpTuning {
  if (!t.jump) return DEFAULT_JUMP;
  // Built once per tuning (it's read for every ship many times a tick)
  let j = jumpCache.get(t.jump);
  if (!j) jumpCache.set(t.jump, (j = { ...DEFAULT_JUMP, ...t.jump }));
  return j;
}
const jumpCache = new WeakMap<object, JumpTuning>();

/** The extra charge a jump of `dist` (world units, as it goes: jumpGo) needs: the time to fly it at shortCruise up to shortRange, tapering to none by shortTaper */
export function jumpExtraCharge(dist: number, t: JumpTuning): number {
  if (!(t.shortCruise > 0) || dist >= t.shortTaper) return 0;
  if (dist <= t.shortRange) return Math.ceil(Math.max(0, dist) / t.shortCruise);
  return Math.ceil((t.shortRange / t.shortCruise) * ((t.shortTaper - dist) / (t.shortTaper - t.shortRange)));
}

/** Ticks a jump of `dist` charges for (the counter's count when the burn can start). Negative `dist`: not known (a replica's: it waits for the burn's keyframe) */
export function jumpChargeNeed(dist: number, t: JumpTuning): number {
  return dist >= 0 ? t.chargeTicks + jumpExtraCharge(dist, t) : Infinity;
}

/** The counter's value as the burn starts: past the longest charge any jump needs */
export function jumpBurnAt(t: JumpTuning): number {
  return t.chargeTicks + (t.shortCruise > 0 ? Math.ceil(t.shortRange / t.shortCruise) : 0);
}

/** Phase of a jump counter, and progress through that phase in [0, 1]. `need`: the charge the jump aimed needs (jumpChargeNeed; a long jump's by default) */
export function jumpPhase(j: number, t: JumpTuning, need = t.chargeTicks): { phase: JumpPhase; progress: number } {
  if (j <= 0) return { phase: 'ready', progress: 1 };
  const at = jumpBurnAt(t);
  if (j < at) return { phase: 'charging', progress: Math.min(1, j / Math.min(need, at)) };
  const b = j - at;
  if (b < t.burnTicks) return { phase: 'burn', progress: b / t.burnTicks };
  return { phase: 'cooldown', progress: (b - t.burnTicks) / t.cooldownTicks };
}

/**
 * Advance the counter one tick. Charging, it counts the ticks charged; once it has charged `need` (jumpChargeNeed) the
 * burn starts, unless `hold`: not aimed yet (jumpAimed), so it waits (counting on, to burnAt-1 at most)
 */
export function stepJump(j: number, want: boolean, t: JumpTuning, hold = false, need = t.chargeTicks): number {
  if (j <= 0) return want ? 1 : 0;
  const at = jumpBurnAt(t);
  if (j < at) {
    if (!want) return 0; // let go: the charge collapses (no cooldown)
    if (j + 1 >= need && !hold) return at;
    return Math.min(j + 1, at - 1);
  }
  return j + 1 >= at + t.burnTicks + t.cooldownTicks ? 0 : j + 1;
}

/** Is the drive mid-burn at counter `j` */
export function jumpBurning(j: number, t: JumpTuning): boolean {
  const at = jumpBurnAt(t);
  return j >= at && j < at + t.burnTicks;
}

/** The burn's shape `b` ticks in: up to 1 over rampTicks, down to 0 over slowTicks (exactly 0 on its last tick) */
function burnProfile(b: number, t: JumpTuning): number {
  const ramp = Math.min(1, (b + 1) / t.rampTicks);
  const slow = Math.min(1, (t.burnTicks - 1 - b) / t.slowTicks);
  return Math.max(0, Math.min(ramp, slow));
}

/** Speed along the nose `b` ticks into a burn of this scale (the last tick is exactly exitSpeed). */
export function jumpBurnSpeed(b: number, t: JumpTuning, scale = 1): number {
  return t.exitSpeed + (t.speed - t.exitSpeed) * scale * burnProfile(b, t);
}

/** Distance the burn itself covers at this scale */
export function jumpDistance(t: JumpTuning, scale = 1): number {
  let d = 0;
  for (let b = 0; b < t.burnTicks; b++) d += jumpBurnSpeed(b, t, scale);
  return d;
}

/** How far a ship coasts after the burn (leaving it at exitSpeed, with nothing pressed) */
export function jumpCoast(t: JumpTuning, friction: number): number {
  return (t.exitSpeed * friction) / (1 - friction);
}

/** The burn scale that brings a ship to rest `dist` away (burn + coast), rounded as snapshots carry it */
export function jumpScaleFor(dist: number, t: JumpTuning, friction: number): number {
  let shape = 0;
  for (let b = 0; b < t.burnTicks; b++) shape += burnProfile(b, t);
  const extra = dist - jumpCoast(t, friction) - t.exitSpeed * t.burnTicks;
  return Math.round(Math.max(0, extra / ((t.speed - t.exitSpeed) * shape)) * 1000) / 1000;
}

export function wrapAngle(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

/** Ship-local grid frame → world: forward (-y) maps to the ship's heading. */
export function localToWorldDir(v: Vec2, angle: number): Vec2 {
  dsincos(angle + Math.PI / 2, SC);
  const s = SC[0], c = SC[1];
  return [v[0] * c - v[1] * s, v[0] * s + v[1] * c];
}

export function worldToLocalDir(v: Vec2, angle: number): Vec2 {
  dsincos(angle + Math.PI / 2, SC);
  const s = SC[0], c = SC[1];
  return [v[0] * c + v[1] * s, -v[0] * s + v[1] * c];
}

/**
 * Acceleration along a ship-local unit direction: what the thrusters give that
 * way (never less than the core's own maneuvering force), cut by damage
 * (`drive`), over the ship's mass as built (a stripped frame is no quicker).
 * `speed`: how fast the ship is already going that way (engines fade near
 * their rated speed: thrustAlong).
 */
export function accelAlong(d: ShipDerived, dir: Vec2, speed = 0, cargo = 0): number {
  const m = Math.max(d.mass, d.fullMass ?? d.mass);
  // (The hold's cargo is carried too: load.ts)
  return m > 0 ? ((thrustAlong(d, dir, speed) * (d.drive ?? 1)) / m) * cargoThrust(d, cargo) : 0;
}

/** Steepness of an engine's fade towards its rated speed: near full until close to it, none past it (ratedFade multiplies it out) */
export const RATED_FADE_EXP = 6;

/** How much of its thrust an engine rated `rated` gives at `speed` (world units a tick) its way; no rating, it never fades */
export function ratedFade(rated: number | undefined, speed: number): number {
  if (!rated || speed <= 0) return 1;
  // ((speed / rated)^RATED_FADE_EXP, by multiplication: the same bits everywhere, and cheap per thruster per tick)
  const r = speed / rated, r2 = r * r;
  return Math.max(0, Math.min(1, 1 - r2 * r2 * r2));
}

/** Turning acceleration caps (cw, ccw), on the same terms as accelAlong */
export function turnAccel(d: ShipDerived, cargo = 0): { cw: number; ccw: number } {
  const k = turnScale(d, cargo);
  return { cw: d.maxTorque.cw * k, ccw: d.maxTorque.ccw * k };
}

/** Torque → turning acceleration (turnAccel's factor, allocation-free for the flight step and part features' flight hooks) */
export function turnScale(d: ShipDerived, cargo: number): number {
  const I = Math.max(d.inertia, d.fullInertia ?? d.inertia);
  return (((d.drive ?? 1) * (d.turn ?? 1)) / (I || 1)) * cargoTurn(d, cargo);
}

/**
 * The spin (rad/tick, signed) to turn at with `err` still to go: as fast as `maxSpin`, but no faster than the ship can
 * stop from by the time it's round (`brake`: its turning cap the way that slows this turn, × `margin`), and the last
 * little way eased in at `gain` of what's left a tick (≤ 1: no overshoot, no twitching). So a big, slow-turning hull
 * swings onto its heading and settles there instead of overshooting and hunting back and forth, and a nimble one is
 * round as fast as its torque allows.
 *
 * The stop is worked out on the step's own terms (the spin changes, then the angle moves by it): spinning at v and
 * braking at a, the ship turns v + (v − a) + (v − 2a) + … ≈ v(v + a) / 2a before it stops, so the fastest spin that
 * still stops within |err| is (√(a² + 8a|err|) − a) / 2.
 */
function steerSpin(err: number, brake: number, maxSpin: number, gain: number, margin: number): number {
  const e = Math.abs(err);
  const stop = (Math.sqrt(brake * brake + 8 * brake * e) - brake) * 0.5 * margin;
  return Math.sign(err) * Math.min(maxSpin, stop, gain * e);
}

/**
 * Force available along a ship-local unit direction: what the thrusters give
 * that way (each fading as `speed`, the ship's speed that way, nears its
 * rating: docs/parts-redesign.md §5), but never less than the core's own
 * maneuvering force.
 */
export function thrustAlong(d: ShipDerived, dir: Vec2, speed = 0): number {
  let f = 0;
  for (const t of d.thrusters) f += Math.max(0, t.force[0] * dir[0] + t.force[1] * dir[1]) * ratedFade(t.rated, speed);
  return Math.max(f, d.maneuverForce);
}

/** The one flight context every stepFlight call fills (features/types.ts FlightCtx: reset by field, never re-entered) */
const CTX: FlightCtx = {
  body: undefined as unknown as FlightBody, input: undefined as unknown as FlightControls, d: undefined as unknown as ShipDerived,
  tuning: undefined as unknown as ShipTuning, k: undefined as unknown as FlightConstants,
  feature: 0, cargo: 0, wantX: 0, wantY: 0, charging: false, accounted: false, replay: false, load: [], loads: 0, shares: undefined, scratch: {},
};

/** A replica's part-feature shares (every feature at the one its control bits carry: shareOfCtl), reused every tick */
const REPLAY_SHARES: number[] = [];

/** Run one phase's part-feature hooks (features/plan.ts, in (order, feature) order) */
function runHooks(list: readonly FlightEntry[], c: FlightCtx): void {
  for (let i = 0; i < list.length; i++) { const e = list[i]; c.feature = e.feature; e.step(c); }
}

export function stepFlight(
  body: FlightBody,
  input: FlightControls,
  d: ShipDerived,
  tuning: ShipTuning,
  /** The charge, whether it's accounted (drainRate 0: not), and what the guns and mining lasers draw this tick per feed group (energy.ts gunLoad) */
  boost: { charge: Charge; drainRate: number; load?: ArrayLike<number>; tick?: number; replay?: number },
  k: FlightConstants,
): FlightResult {
  const ft = tuning.flight;
  // (Part features' flight hooks: features/types.ts FlightPhase says where each phase runs)
  const H = getPlan().flight;
  const c = CTX;
  c.body = body; c.input = input; c.d = d; c.tuning = tuning; c.k = k;
  c.cargo = body.cargo ?? 0; c.wantX = 0; c.wantY = 0; c.charging = false; c.accounted = boost.drainRate > 0 && !!d.energy; c.shares = undefined;
  c.replay = !c.accounted && boost.replay !== undefined;
  if (c.loads) { c.load.fill(undefined); c.loads = 0; }
  runHooks(H.preJump, c);

  // --- Jump drive: while burning, nothing else applies (no steering, thrust, friction or gravity)
  const jt0 = jumpTuning(tuning);
  const jt = d.jumpCooldown ? { ...jt0, cooldownTicks: d.jumpCooldown } : jt0;
  const prev = body.jump ?? 0;
  const cargo = body.cargo ?? 0;
  const burnAt = jumpBurnAt(jt);
  // How far this jump goes (where you aimed, within the drive's reach), and so how long it charges (a short one longer)
  // (A replica's jumpDist is below 0: where it lands isn't known, so its charge waits for the burn's keyframe)
  let go = 0, need = jt.chargeTicks;
  if (prev > 0 && prev < burnAt) {
    go = jumpGoFor(input.jumpDist, jumpReachAt(d, jt, k.jumpBoost, k.hazard), jt);
    need = jumpChargeNeed(go, jt);
  }
  const j = stepJump(prev, !!input.jump && d.mass > 0, jt, !jumpAimed(body, input), need);
  body.jump = j;
  // The burn starts: fix how far this jump goes, and along the aim itself
  // (the nose is within JUMP_ALIGN of it: the last of the turn is taken in the launch flash)
  if (j === burnAt && prev > 0 && prev < burnAt) {
    if (!input.helm) body.angle = wrapAngle(input.targetAngle);
    body.jumpScale = jumpScaleFor(go, jt, k.friction);
  }
  const jp = jumpPhase(j, jt).phase;
  if (jp === 'burn') {
    const speed = jumpBurnSpeed(j - burnAt, jt, body.jumpScale ?? 1);
    body.angVel = 0;
    dsincos(body.angle, SC);
    body.vx = SC[1] * speed;
    body.vy = SC[0] * speed;
    body.x = Math.max(-k.worldSize, Math.min(k.worldSize, body.x + body.vx));
    body.y = Math.max(-k.worldSize, Math.min(k.worldSize, body.y + body.vy));
    return { charge: boost.charge, isBoosting: false, accel: 0, power: 1, ctlPower: 0 };
  }
  const charging = jp === 'charging';

  // --- Rotation, angular acceleration capped by torque / inertia.
  // Mouse-steer: spin towards the aim angle, braking in time (steerSpin). Helm: chase ±maxAngularSpeed (or stop) from the turn keys.
  if (d.inertia > 0) {
    // (The caps, cut by hazards: a positive alpha turns cw)
    const tk = turnScale(d, cargo) * (k.hazard?.control ?? 1);
    const maxCw = d.maxTorque.cw * tk, maxCcw = d.maxTorque.ccw * tk;
    let alpha: number;
    if (input.helm) {
      const turn = (input.right ? 1 : 0) - (input.left ? 1 : 0);
      alpha = ft.helmTurnGain * (turn * ft.maxAngularSpeed - body.angVel);
    } else {
      // (Turning cw, it brakes with the ccw cap, and the other way round. A boss, Blueprint `turn`, swings slower and eases in gentler)
      const err = wrapAngle(input.targetAngle - body.angle);
      const boss = !!d.turn;
      alpha = steerSpin(err, err > 0 ? maxCcw : maxCw, boss ? ft.bossMaxAngularSpeed : ft.maxAngularSpeed, boss ? ft.bossTurnGain : ft.turnGain, ft.turnBrakeMargin) - body.angVel;
    }
    alpha = Math.max(-maxCcw, Math.min(maxCw, alpha));
    body.angVel = Math.max(-ft.maxAngularSpeed, Math.min(ft.maxAngularSpeed, body.angVel + alpha));
  } else {
    body.angVel = 0;
  }
  body.angle = wrapAngle(body.angle + body.angVel);
  runHooks(H.steer, c);

  // --- Thrust: force from whatever points the requested way.
  // Mouse-steer asks in screen space; helm asks in ship space (forward = the nose), as does mouse-steer in the nose
  // frame (noseFrame: its left/right keys push sideways)
  let ix = 0, iy = 0;
  if (input.helm) {
    let lx = 0, ly = 0;
    if (input.forward) ly -= 1;
    if (input.backward) ly += 1;
    if (input.strafeLeft) lx -= 1;
    if (input.strafeRight) lx += 1;
    [ix, iy] = localToWorldDir([lx, ly], body.angle);
  } else if (noseFrame(input)) {
    let lx = 0, ly = 0;
    if (input.forward) ly -= 1;
    if (input.backward) ly += 1;
    if (input.left) lx -= 1;
    if (input.right) lx += 1;
    if (lx || ly) [ix, iy] = localToWorldDir([lx, ly], body.angle);
  } else {
    if (input.forward) iy -= 1;
    if (input.backward) iy += 1;
    if (input.left) ix -= 1;
    if (input.right) ix += 1;
  }
  // (Part features see the way asked before a spooling drive takes the engines, and may ask power for this tick: a Burst
  // Strafer's dodge, features/strafer)
  c.wantX = ix; c.wantY = iy; c.charging = charging;
  runHooks(H.thrustGate, c);
  // Spooling the drive takes the engines: the ship can still aim, but brakes instead of thrusting
  if (charging) ix = iy = 0;
  const mag = dhypot(ix, iy);
  let accel = 0;
  let charge = boost.charge;
  let isBoosting = false;
  // The ship's power (energy.ts): thrusting, the engines draw first (their Drive Cell banks, then the ship's Output), then the
  // guns and mining lasers (`boost.load`) and part features; what's left refills the stores. (drainRate 0: no accounting, as for
  // pilotless ships)
  const thrusting = mag > 0 && d.mass > 0;
  let power = 1, canBoost = !!input.boost;
  if (boost.drainRate > 0 && d.energy) {
    // A hazard that saps the batteries: they hold only so much
    const cap = k.hazard ? Math.round(100 * k.hazard.cap * 1000) / 1000 : 100;
    const dir = thrusting ? worldToLocalDir([ix / mag, iy / mag], body.angle) : undefined;
    // (A ports ship's engines burn only pushing the way asked; its features' thrusters by part: energy.ts PowerUse.extra)
    const extra = c.loads ? c.load : undefined;
    const pt = powerTick(d, capCharge(d, boost.charge, cap), d.ports ? { thrusting, boosting: !!input.boost, dir, load: boost.load, extra } : { thrusting, boosting: !!input.boost, load: boost.load, extra }, tuning);
    charge = pt.charge;
    // (Part features' shares on the replicated grid's steps, as the engines' power below: replicas are told it, ctlOfShare)
    const sh = pt.extra;
    if (sh) for (let x = 0; x < sh.length; x++) if (sh[x] !== undefined) sh[x] = quantizePower(sh[x]!);
    c.shares = sh;
    canBoost = pt.boost;
    // (Each engine pushes on its own feed group's share: short of power, engines push that much less)
    if (dir) {
      const along = (body.vx * ix + body.vy * iy) / mag;
      power = thrustShare(d, charge, dir, (rated) => ratedFade(rated, along));
    }
    // (On the replicated grid: replicas, which have no charge, are told it in the control bits, ctlPower)
    power = quantizePower(power);
  } else if (boost.replay !== undefined) {
    // A replica: what the engines got, as the ship's control bits carry it (replica.ts replicaStep)
    power = powerOfCtl(boost.replay);
    if (boost.replay & CTL_NO_BOOST) canBoost = false;
    // (and what the part features' bursts got: the one share every feature that asked had, ctlOfShare)
    const share = shareOfCtl(boost.replay);
    if (share < 1) {
      const n = getPlan().features.length;
      REPLAY_SHARES.length = n;
      for (let x = 0; x < n; x++) REPLAY_SHARES[x] = share;
      c.shares = REPLAY_SHARES;
    }
  }
  if (thrusting) {
    ix /= mag; iy /= mag;
    // (Engines fade as the ship nears their rated speed the way it's pushing)
    accel = accelAlong(d, worldToLocalDir([ix, iy], body.angle), body.vx * ix + body.vy * iy, cargo) * power * (k.hazard?.control ?? 1);
    if (input.boost && canBoost) {
      // The engines decide: afterburners kick hard and drink the battery, plasma drives barely boost
      accel *= d.boostFactor ?? k.boostFactor;
      isBoosting = true;
    }
    body.vx += ix * accel;
    body.vy += iy * accel;
  }

  // (Part features' pushes, on what power they got: a Burst Strafer's dodge, features/strafer)
  runHooks(H.impulse, c);

  applyGravity(body, k.gravity);
  // A gravity hazard: a light ship is drawn towards the well
  if (k.hazard?.driftAccel) {
    const r = dhypot(body.x, body.y);
    if (r > 1) { body.vx -= (body.x / r) * k.hazard.driftAccel; body.vy -= (body.y / r) * k.hazard.driftAccel; }
  }

  runHooks(H.damp, c);

  // --- Same integrator as the legacy ship
  const damp = charging ? k.friction * jt.chargeDamping : k.friction;
  body.vx *= damp;
  body.vy *= damp;
  body.x = Math.max(-k.worldSize, Math.min(k.worldSize, body.x + body.vx));
  body.y = Math.max(-k.worldSize, Math.min(k.worldSize, body.y + body.vy));

  // What a replica must be told to fly this step as it was flown: the engines' power, and a boost the stores refused
  const refused = boost.drainRate > 0 && !!d.energy && thrusting && !!input.boost && !isBoosting;
  return { charge, isBoosting, accel, power, ctlPower: ctlOfPower(power) | ctlOfShare(c.shares) | (refused ? CTL_NO_BOOST : 0) };
}

/**
 * The engines' power on the wire (protocol 25): a step of 1/POWER_STEPS, sent in a replicated ship's control bits as
 * (steps - POWER_STEPS) in the 6 bits from CTL_POWER_SHIFT (full power: nothing), and CTL_NO_BOOST when the stores
 * refused a boost. So a ship short of power (a ports ship starving its engines, a pool ship run dry) is stepped by its
 * replicas exactly as it flew, instead of needing a keyframe every snapshot
 */
export const POWER_STEPS = 32;
export const CTL_POWER_SHIFT = 15;
export const CTL_NO_BOOST = 16384;
export const CTL_POWER_MASK = 63 << CTL_POWER_SHIFT;
const POWER_MASK = CTL_POWER_MASK;

export function quantizePower(p: number): number {
  return Math.max(0, Math.min(63, Math.round(p * POWER_STEPS))) / POWER_STEPS;
}

export function ctlOfPower(p: number): number {
  return ((Math.round(p * POWER_STEPS) - POWER_STEPS) & 63) << CTL_POWER_SHIFT;
}

export function powerOfCtl(bits: number): number {
  const e = (bits & POWER_MASK) >>> CTL_POWER_SHIFT;
  return (POWER_STEPS + (e >= 32 ? e - 64 : e)) / POWER_STEPS;
}

/**
 * What the part features' bursts got (a Burst Strafer's dodge, a Gyro's turn: energy.ts PowerResult.extra, on the
 * POWER_STEPS grid), sent in a replicated ship's control bits as (POWER_STEPS - steps) in the 6 bits from
 * CTL_SHARE_SHIFT (all full, or nothing asked: nothing). One share for every feature that asked: the lowest (features
 * in one feed group get the same; two short by different shares at once leave the replica off, and a keyframe follows)
 */
export const CTL_SHARE_SHIFT = 21;
export const CTL_SHARE_MASK = 63 << CTL_SHARE_SHIFT;
const SHARE_MASK = CTL_SHARE_MASK;

export function ctlOfShare(shares: readonly (number | undefined)[] | undefined): number {
  if (!shares) return 0;
  let lo = 1;
  for (let x = 0; x < shares.length; x++) { const v = shares[x]; if (v !== undefined && v < lo) lo = v; }
  return (POWER_STEPS - Math.max(0, Math.min(POWER_STEPS, Math.round(lo * POWER_STEPS)))) << CTL_SHARE_SHIFT;
}

export function shareOfCtl(bits: number): number {
  return (POWER_STEPS - Math.min(POWER_STEPS, (bits & SHARE_MASK) >>> CTL_SHARE_SHIFT)) / POWER_STEPS;
}

/** Debris: no thrust, no steering, same friction. */
export function stepDrift(body: FlightBody, k: FlightConstants): void {
  applyGravity(body, k.gravity);
  body.angle = wrapAngle(body.angle + body.angVel);
  body.angVel *= k.friction;
  body.vx *= k.friction;
  body.vy *= k.friction;
  body.x = Math.max(-k.worldSize, Math.min(k.worldSize, body.x + body.vx));
  body.y = Math.max(-k.worldSize, Math.min(k.worldSize, body.y + body.vy));
}
