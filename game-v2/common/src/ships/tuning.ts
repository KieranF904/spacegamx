/**
 * data/ships/tuning.json: every number the ship prototype depends on.
 */

import type { JumpTuning } from './flight.js';
import type { WeaponModNumber, WeaponMods } from './types.js';
import type { PulseTuning } from './pulse.js';

export interface ShipTuning {
  /** World units per grid cell */
  cellSize: number;
  /** Convex pieces are shrunk by this many cells before overlap tests */
  overlapShrink: number;
  arcSegmentsPerQuarter: number;
  maxParts: number;

  /** A part's HP crossing a multiple of this fraction marks the ship dirty */
  hpBandSize: number;
  /** health(f) = f <= 0 ? 0 : floor + slope * f */
  health: { floor: number; slope: number };

  flow: { minWeaponSatisfaction: number };

  flight: {
    /** Omnidirectional floor on thrust from the core (so a rear-thruster-only ship can still back up and strafe) */
    coreManeuverForce: number;
    /** Turning torque the core gives in each direction */
    gyroTorque: number;
    /** Multiplier on thruster torque about the centre of mass (differential throttling) */
    thrusterTorqueGain: number;
    /** PD controller towards the aim angle: alpha = kp * error - kd * angularVelocity, per tick */
    turnKp: number;
    turnKd: number;
    /** rad/tick */
    maxAngularSpeed: number;
    /** Helm controls: angular acceleration towards ±maxAngularSpeed (or 0) per tick, before the torque cap */
    helmTurnGain: number;
  };

  /** Jump drive (defaults in flight.ts DEFAULT_JUMP) */
  jump?: Partial<JumpTuning>;

  /**
   * Fixed (non-turret) guns swivel only this far either side of straight ahead, and fire only when the target is inside that (plus the tolerance).
   * Their shells: time between shots, shell speed and shell size relative to the base shot (range stays the same).
   */
  fixedGun?: { gimbalDeg: number; beamGimbalDeg?: number; fireToleranceDeg: number; intervalScale?: number; speedScale?: number; sizeScale?: number };

  /** Per weapon kind: what it fires (see data/ships/tuning.json) */
  weapons?: Record<string, WeaponTuning>;

  /**
   * Per weapon kind, what each grade (Mk I-V, in order) does to it on top of
   * its material's output: changes like a gem's (launch.ts gunDef), so each
   * mark has a character of its own rather than just hitting harder.
   */
  weaponGrades?: Record<string, (WeaponMods | null)[]>;

  /** Shields: recharge waits regenDelayTicks after a hit, then refills regenPerSecond of max per second */
  shield?: { regenDelayTicks: number; regenPerSecond: number; maxPerArea: number };

  /** Mining lasers: beam reach (world units), damage per second to asteroids and to ships, and how far they swivel towards the cursor */
  miner?: { range: number; dps: number; shipDps: number; gimbalDeg: number };

  turret: {
    /** Half-width of a turret's window around its facing, before its own hull is cut out */
    halfArcDeg: number;
    /** Ray spacing when the window is computed */
    sampleDeg: number;
    /** rad/tick */
    slewRate: number;
    /** Fires only while within this of the aim angle */
    fireToleranceDeg: number;
    /** Muzzle sits this far (cells) beyond the turret part's own outline */
    barrelMargin: number;
  };

  /** decayTicks: a loose part (no core holding it) crumbles away in about this long, give or take */
  debris: { lifetimeTicks: number; pushSpeed: number; pushSpin: number; decayTicks?: number };

  /**
   * What a destroyed part does, by function: blows up, damaging parts within `radius` cells
   * (on any body) by up to `damage` HP, falling off with distance, after a delay in [min, max] ticks.
   * Functions not listed just break.
   */
  partBlast?: Record<string, { radius: number; damage: number; delayTicks: number[] }>;

  /**
   * Station repair: ships within `range` of a station's edge heal `healPerSecond` of each part's
   * max HP, and regrow missing parts one at a time (`restoreTicks` each, back at `restoreHp`).
   * Applied every `intervalTicks`; paused for `combatPauseTicks` after taking damage.
   */
  repair?: { range: number; healPerSecond: number; restoreTicks: number; restoreHp: number; intervalTicks: number; combatPauseTicks: number };

  /** Ship-to-ship and ship-to-debris contacts */
  collision: {
    restitution: number;
    /** Closing speed (world units / tick) below which contacts do no damage */
    minDamageSpeed: number;
    /** Damage per unit of closing speed above the threshold, split over the touching parts */
    damagePerSpeed: number;
    /** Contacts closing faster than this show sparks and sound (at most once per pair per cooldown) */
    fxMinSpeed?: number;
    fxCooldownTicks?: number;
  };

  debug: { damageFraction: number; replayTicks: number; replayRuns: number };

  fixtures: {
    flowExample: { supply: number; demands: number[]; priorities: number[]; expected: number[] };
  };
}

export interface WeaponTuning {
  type: 'projectile' | 'beam';
  speed?: number;
  damage?: number;
  life?: number;
  size?: number;
  spread?: number;
  pierce?: number;
  homing?: number;
  accel?: number;
  maxSpeed?: number;
  fuse?: number;
  splash?: { radius: number; damage: number };
  emp?: { radius: number; ticks: number };
  range?: number;
  dps?: number;
  heatPerSec?: number;
  coolPerSec?: number;
  armorBonus?: number;
  /** Beam: how wide it burns (world units): a hull this close to its line is hit */
  width?: number;
  /** Beam: hostiles' (pilotless ships') damage × this (so a change made for pilots doesn't make every enemy that carries it harder) */
  npcScale?: number;
  /**
   * Beam: it fires in pulses (pulse.ts) instead of staying on: `damage` a
   * pulse, `width` at its peak, charging for its part's fireInterval between
   * them; no heat.
   */
  pulse?: PulseTuning;
  /** Beam: full strength out to `start` of its range (its effective range), then tailing off steeply to `floor` at its full range (pulse.ts beamFalloff) */
  falloff?: { start: number; floor: number };
  color?: string;
  /** A ship's guns of this kind (and interval) fire in turn, evenly spaced over their interval, not all at once (guns.ts) */
  stagger?: boolean;
  /** Shots per trigger pull, fanned across `spread` (the hive) */
  burst?: number;
  /** Beam: each tick on a ship takes 1/holdTicks of its warmth (warmth.ts: held this long on a warm ship, it's frozen through), and frozen through it seizes up (an EMP) for `ticks` */
  chill?: { holdTicks: number; ticks: number };
  /** The part hit burns (damage over time), spreading to parts within `radius` cells */
  ignite?: { dps: number; ticks: number; radius: number };
  /** Shatters on impact into `count` shots of `kind` fanned over `arc` degrees */
  split?: { count: number; arc: number; kind: string };
  /** Piercing shots keep this fraction of their damage per body (default 0.75) */
  pierceKeep?: number;
  /** Drags ships within `radius` towards it */
  pull?: { radius: number; strength: number };
  /** Lobbed (a mortar): flies over everything to burst where it was aimed (its flight cut to the aim distance) */
  lob?: boolean;
  /** Damage against shields, and against hull, × these (pulse lasers strip shields; 0: shields don't stop it) */
  vsShield?: number;
  vsHull?: number;
  /** Lightning: from what it hits it leaps to `count` more ships within `radius`, each time × `falloff` */
  chain?: { count: number; radius: number; falloff: number };
  /** Each hit takes `perHit` of the warmth of the ship it lands on (warmth.ts); frozen through (0), it seizes up for `ticks` */
  frost?: { perHit: number; ticks: number };
  /** Hits on one faction's ships (not its bosses) do `damage` times as much (an ammunition made for them: Quench Slugs on the Cinder Cult) */
  bane?: { faction: string; damage: number };
  /**
   * Fires ammunition: crates of `item` in the hold, `rounds` volleys a crate.
   * Out of it, the gun fires plain rounds: the same shells at `dry` (default
   * 0.4) of the damage, with none of its effects (server/src/game/Ammo.ts).
   */
  ammo?: { item: string; rounds: number; dry?: number };
  /** What it hits with (damage.ts; default by kind) and how much it punches through beyond its grade */
  damageType?: string;
  pen?: number;
  /**
   * How a bigger gun of this kind differs, beyond hitting harder (grades.ts
   * weaponSizeFactor): each number is scaled by (size against its base)^this
   * (rate: its fire rate; splashRadius, splashDamage: its burst's).
   */
  bySize?: Partial<Record<WeaponModNumber, number>>;
}

export function healthFactor(f: number, t: ShipTuning): number {
  return f <= 0 ? 0 : t.health.floor + t.health.slope * Math.min(1, f);
}
