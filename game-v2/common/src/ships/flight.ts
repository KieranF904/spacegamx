/**
 * Flight on derived stats. Keeps the legacy controls (screen-relative WASD,
 * ship turns to face the cursor, same friction and boost), but acceleration
 * comes from thrust / mass and turning from torque / inertia via a PD controller.
 */

import type { Vec2 } from './types.js';
import type { ShipDerived } from './rebuild.js';
import type { ShipTuning } from './tuning.js';
import { powerTick, type Charge } from './energy.js';

/** A boss's fastest turn (radians a tick; Blueprint `turn`): a hull the size of a station doesn't whip round */
const BOSS_SPIN = 0.04;

export interface FlightBody {
  x: number; y: number;
  vx: number; vy: number;
  angle: number;
  angVel: number;
  /** Jump drive counter (see stepJump); absent = 0 (ready) */
  jump?: number;
  /** This jump's burn as a fraction of a full-power one (set when the burn starts: jumpBurnSpeed) */
  jumpScale?: number;
}

export interface FlightControls {
  forward: boolean; backward: boolean; left: boolean; right: boolean;
  boost: boolean;
  targetAngle: number;
  /**
   * Helm controls: left/right turn the ship, forward/backward and
   * strafeLeft/strafeRight thrust relative to it. Otherwise (mouse-steer) the
   * ship turns to targetAngle and the four directions are screen-relative.
   */
  helm?: boolean;
  strafeLeft?: boolean;
  strafeRight?: boolean;
  /** Jump drive: held (or latched) to spool up; releasing during the charge cancels it */
  jump?: boolean;
  /** How far to jump (world units; the cursor distance): where the ship comes to rest. 0 = as far as the drive goes */
  jumpDist?: number;
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
  const r = Math.hypot(body.x, body.y);
  if (r < 1e-6) return;
  const a = g.strength / Math.max(r, g.minRadius) ** 2;
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
}

// ---------------------------------------------------------------------------
// Jump drive
// ---------------------------------------------------------------------------

/**
 * The jump drive: spool up for a moment, then the ship is flung along its nose
 * for a fixed, short burn (a longer jump just goes faster), then the drive
 * cools down. The burn lets the ship go at exitSpeed, so it coasts the last
 * stretch (jumpCoast) and comes to rest where it was aimed, or flies on with a
 * head start. Its whole state is one integer counter, so it rides in snapshots
 * and prediction replays it exactly:
 *
 *   0                                  ready
 *   1 .. chargeTicks-1                 charging (counts up while the jump control is held)
 *   chargeTicks .. +burnTicks-1        burn (the jump itself)
 *   .. +cooldownTicks-1                cooling down, then back to 0
 */
export interface JumpTuning {
  chargeTicks: number;
  burnTicks: number;
  /** Cooldown at the sweet spot (coils just right for the hull, Mk I: jumpDriveStats) */
  cooldownTicks: number;
  /** World units / tick at full burn (jumpScale 1; a jump's own scale sets how fast it really goes) */
  speed: number;
  /** Speed the ship leaves the burn at, whatever the jump's length (then friction takes over: jumpCoast) */
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
  speed: 340, exitSpeed: 30, rampTicks: 5, slowTicks: 16, chargeDamping: 0.96,
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
    const doublings = Math.log2(ratio);
    range = sweetRange * (1 + Math.min(t.overRangeMax, t.overRange * doublings));
    cool = Math.max(sweetCool * t.cooldownFloor, t.minCooldownTicks, sweetCool / (1 + t.overCooldown * doublings));
  } else {
    range = sweetRange * Math.max(t.underRangeFloor, ratio ** t.underRange);
    cool = sweetCool * Math.min(t.underCooldownCap, ratio > 0 ? ratio ** -t.underCooldown : Infinity);
  }
  return { range: Math.round(range), cooldown: Math.round(cool), ratio: Math.round(ratio * 100) / 100 };
}

/** How far a ship's drive reaches here */
export function jumpRange(d: { jumpRange?: number }, t: JumpTuning, boost = 1): number {
  return (d.jumpRange ?? t.baseRange) * boost;
}

/** Is (x, y) inside a system's charging ring (stars and pulsars; black holes have none) */
export function inSolarRing(x: number, y: number, body: { type?: string; radius?: number } | null | undefined, t: JumpTuning): boolean {
  if (!body || body.type === 'black_hole' || body.type === 'none' || !body.radius) return false;
  return Math.hypot(x, y) < solarRingRadius(body.radius, t);
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

/** Phase of a jump counter, and progress through that phase in [0, 1]. */
export function jumpPhase(j: number, t: JumpTuning): { phase: JumpPhase; progress: number } {
  if (j <= 0) return { phase: 'ready', progress: 1 };
  if (j < t.chargeTicks) return { phase: 'charging', progress: j / t.chargeTicks };
  const b = j - t.chargeTicks;
  if (b < t.burnTicks) return { phase: 'burn', progress: b / t.burnTicks };
  return { phase: 'cooldown', progress: (b - t.burnTicks) / t.cooldownTicks };
}

/** Advance the counter one tick. */
export function stepJump(j: number, want: boolean, t: JumpTuning): number {
  if (j <= 0) return want ? 1 : 0;
  if (j < t.chargeTicks) return want ? j + 1 : 0; // let go: the charge collapses (no cooldown)
  return j + 1 >= t.chargeTicks + t.burnTicks + t.cooldownTicks ? 0 : j + 1;
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
  const phi = angle + Math.PI / 2;
  const c = Math.cos(phi), s = Math.sin(phi);
  return [v[0] * c - v[1] * s, v[0] * s + v[1] * c];
}

export function worldToLocalDir(v: Vec2, angle: number): Vec2 {
  const phi = angle + Math.PI / 2;
  const c = Math.cos(phi), s = Math.sin(phi);
  return [v[0] * c + v[1] * s, -v[0] * s + v[1] * c];
}

/**
 * Acceleration along a ship-local unit direction: what the thrusters give that
 * way (never less than the core's own maneuvering force), cut by damage
 * (`drive`), over the ship's mass as built (a stripped frame is no quicker).
 * `speed`: how fast the ship is already going that way (engines fade near
 * their rated speed: thrustAlong).
 */
export function accelAlong(d: ShipDerived, dir: Vec2, speed = 0): number {
  const m = Math.max(d.mass, d.fullMass ?? d.mass);
  return m > 0 ? (thrustAlong(d, dir, speed) * (d.drive ?? 1)) / m : 0;
}

/** Steepness of an engine's fade towards its rated speed: near full until close to it, none past it */
export const RATED_FADE_EXP = 6;

/** How much of its thrust an engine rated `rated` gives at `speed` (world units a tick) its way; no rating, it never fades */
export function ratedFade(rated: number | undefined, speed: number): number {
  if (!rated || speed <= 0) return 1;
  return Math.max(0, Math.min(1, 1 - Math.pow(speed / rated, RATED_FADE_EXP)));
}

/** Turning acceleration caps (cw, ccw), on the same terms as accelAlong */
export function turnAccel(d: ShipDerived): { cw: number; ccw: number } {
  const I = Math.max(d.inertia, d.fullInertia ?? d.inertia);
  const k = ((d.drive ?? 1) * (d.turn ?? 1)) / (I || 1);
  return { cw: d.maxTorque.cw * k, ccw: d.maxTorque.ccw * k };
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

export function stepFlight(
  body: FlightBody,
  input: FlightControls,
  d: ShipDerived,
  tuning: ShipTuning,
  boost: { charge: Charge; drainRate: number },
  k: FlightConstants,
): FlightResult {
  const ft = tuning.flight;

  // --- Jump drive: while burning, nothing else applies (no steering, thrust, friction or gravity)
  const jt0 = jumpTuning(tuning);
  const jt = d.jumpCooldown ? { ...jt0, cooldownTicks: d.jumpCooldown } : jt0;
  const prev = body.jump ?? 0;
  const j = stepJump(prev, !!input.jump && d.mass > 0, jt);
  body.jump = j;
  // The burn starts: fix how far this jump goes (where you aimed, within the drive's reach)
  if (j === jt.chargeTicks && prev === jt.chargeTicks - 1) {
    const range = jumpRange(d, jt, (k.jumpBoost ?? 1) * (k.hazard?.jump ?? 1));
    const want = input.jumpDist && input.jumpDist > 0 ? input.jumpDist : range;
    body.jumpScale = jumpScaleFor(Math.max(jt.minRange, Math.min(range, want)), jt, k.friction);
  }
  const jp = jumpPhase(j, jt).phase;
  if (jp === 'burn') {
    const speed = jumpBurnSpeed(j - jt.chargeTicks, jt, body.jumpScale ?? 1);
    body.angVel = 0;
    body.vx = Math.cos(body.angle) * speed;
    body.vy = Math.sin(body.angle) * speed;
    body.x = Math.max(-k.worldSize, Math.min(k.worldSize, body.x + body.vx));
    body.y = Math.max(-k.worldSize, Math.min(k.worldSize, body.y + body.vy));
    return { charge: boost.charge, isBoosting: false, accel: 0, power: 1 };
  }
  const charging = jp === 'charging';

  // --- Rotation, angular acceleration capped by torque / inertia.
  // Mouse-steer: PD towards the aim angle. Helm: chase ±maxAngularSpeed (or stop) from the turn keys.
  if (d.inertia > 0) {
    let alpha: number;
    if (input.helm) {
      const turn = (input.right ? 1 : 0) - (input.left ? 1 : 0);
      alpha = ft.helmTurnGain * (turn * ft.maxAngularSpeed - body.angVel);
    } else if (d.turn) {
      // A boss (Blueprint `turn`): it turns no faster than it can stop from by the time it's round, so a big hull swings
      // onto its heading and settles there instead of overshooting and hunting back and forth (the last little way
      // eased in, a share of what's left each tick: no twitching about it)
      const err = wrapAngle(input.targetAngle - body.angle), a = Math.min(turnAccel(d).cw, turnAccel(d).ccw);
      const want = Math.sign(err) * Math.min(BOSS_SPIN, Math.sqrt(2 * a * Math.abs(err)) * 0.9, Math.abs(err) * 0.15);
      alpha = want - body.angVel;
    } else {
      const err = wrapAngle(input.targetAngle - body.angle);
      alpha = ft.turnKp * err - ft.turnKd * body.angVel;
    }
    const { cw: maxCw, ccw: maxCcw } = turnAccel(d);
    const ctl = k.hazard?.control ?? 1;
    alpha = Math.max(-maxCcw * ctl, Math.min(maxCw * ctl, alpha));
    body.angVel = Math.max(-ft.maxAngularSpeed, Math.min(ft.maxAngularSpeed, body.angVel + alpha));
  } else {
    body.angVel = 0;
  }
  body.angle = wrapAngle(body.angle + body.angVel);

  // --- Thrust: force from whatever points the requested way.
  // Mouse-steer asks in screen space; helm asks in ship space (forward = the nose).
  let ix = 0, iy = 0;
  if (input.helm) {
    let lx = 0, ly = 0;
    if (input.forward) ly -= 1;
    if (input.backward) ly += 1;
    if (input.strafeLeft) lx -= 1;
    if (input.strafeRight) lx += 1;
    [ix, iy] = localToWorldDir([lx, ly], body.angle);
  } else {
    if (input.forward) iy -= 1;
    if (input.backward) iy += 1;
    if (input.left) ix -= 1;
    if (input.right) ix += 1;
  }
  // Spooling the drive takes the engines: the ship can still aim, but brakes instead of thrusting
  if (charging) ix = iy = 0;
  const mag = Math.hypot(ix, iy);
  let accel = 0;
  let charge = boost.charge;
  let isBoosting = false;
  // The batteries (energy.ts): engines take the spare power first, then the drive and general batteries; what's left charges them.
  // (drainRate 0: no accounting, as for pilotless ships)
  const thrusting = mag > 0 && d.mass > 0;
  let power = 1, canBoost = !!input.boost;
  if (boost.drainRate > 0 && d.energy) {
    // A hazard that saps the batteries: they hold only so much
    const cap = k.hazard ? Math.round(100 * k.hazard.cap * 1000) / 1000 : 100;
    const held = cap < 100 ? { g: Math.min(boost.charge.g, cap), d: Math.min(boost.charge.d, cap), w: Math.min(boost.charge.w, cap) } : boost.charge;
    const pt = powerTick(d, held, { thrusting, boosting: !!input.boost }, tuning);
    charge = pt.charge;
    power = pt.power;
    canBoost = pt.boost;
  }
  if (thrusting) {
    ix /= mag; iy /= mag;
    // (Engines fade as the ship nears their rated speed the way it's pushing)
    accel = accelAlong(d, worldToLocalDir([ix, iy], body.angle), body.vx * ix + body.vy * iy) * power * (k.hazard?.control ?? 1);
    if (input.boost && canBoost) {
      // The engines decide: afterburners kick hard and drink the battery, plasma drives barely boost
      accel *= d.boostFactor ?? k.boostFactor;
      isBoosting = true;
    }
    body.vx += ix * accel;
    body.vy += iy * accel;
  }

  applyGravity(body, k.gravity);
  // A gravity hazard: a light ship is drawn towards the well
  if (k.hazard?.driftAccel) {
    const r = Math.hypot(body.x, body.y);
    if (r > 1) { body.vx -= (body.x / r) * k.hazard.driftAccel; body.vy -= (body.y / r) * k.hazard.driftAccel; }
  }

  // --- Same integrator as the legacy ship
  const damp = charging ? k.friction * jt.chargeDamping : k.friction;
  body.vx *= damp;
  body.vy *= damp;
  body.x = Math.max(-k.worldSize, Math.min(k.worldSize, body.x + body.vx));
  body.y = Math.max(-k.worldSize, Math.min(k.worldSize, body.y + body.vy));

  return { charge, isBoosting, accel, power };
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
