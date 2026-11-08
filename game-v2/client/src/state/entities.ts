/**
 * @contract client.state.entities
 * owns:       the client's entity record (InterpolatedEntity: physics, render pose, orbit params, history) and the by-id map that also indexes by type
 * needs:      common EntityType and Composition
 * invariants: an entity's type never changes, so the by-type sets stay right as entities come and go — client/src/state/lateRemovals.test.ts
 * extend:     a new per-entity client field is one more optional line on InterpolatedEntity
 */

import type { Composition } from '@space-game/common';
import { EntityType } from '@space-game/common';

export interface InterpolatedEntity {
  /** The tick a deterministic asteroid was last placed for */
  orbitTick?: number;
  id: number;
  type: EntityType;
  /** Asteroids: what they're made of (colours, seams, scanner) */
  composition?: Composition;
  // Physics (authoritative / predicted position)
  x: number;
  y: number;
  angle: number;
  vx: number;
  vy: number;
  // Smooth render position (visual, catches up to x/y)
  renderX: number;
  renderY: number;
  renderAngle: number;
  // Server state
  hp: number;
  maxHp: number;
  data?: number[];
  // Player display name
  name?: string;
  /** Modular ships: angular velocity (rad/tick), predicted for the local player */
  angVel?: number;
  /** Modular ships: jump drive counter, predicted for the local player (others: data[3]) */
  jump?: number;
  /** This jump's speed scale (local player; server data[PILOT_ROW.jumpScale] / 1000) */
  jumpScale?: number;
  /** A charging jump's locked heading and distance (local player, its tick layer's: common flight.ts FlightBody.jumpAim/jumpTo) */
  jumpAim?: number;
  jumpTo?: number;
  /** A lodestone's priming left, ticks (local player; server data[PILOT_ROW.prime], then predicted) */
  jumpPrime?: number;
  /** Knocked out by an EMP until this tick (local player; the snapshot's tick + server data[5]): prediction drifts till then */
  empUntil?: number;
  /** Warmth, % (local player; server data[PILOT_ROW.warmth]: common/src/ships/warmth.ts): the frost vignette, and how cold prediction flies and fires */
  warmth?: number;
  /** Slowed by a Frostbite's beam until this tick (local player; the snapshot's tick + the pilot row's slowed ticks: features/weaponry): prediction flies it slowed till then */
  slowUntil?: number;
  /** Marked by a Searchlight until this tick (local player; the snapshot's tick + the pilot row's marked ticks) */
  markUntil?: number;
  /** Burst Strafer: the dodge counter and the last dodge's way (local player: the server's, then predicted; others: their replica's): ships/strafer.ts */
  dodge?: number;
  dodgeDir?: number;
  /** Part features' values read from the pilot's row (local player; ships/features: ClientFeature.parsePilot) */
  fx?: { [name: string]: number };
  /** The hold's cargo mass (local player; server data[PILOT_ROW.cargo]: common/src/ships/load.ts): prediction flies it */
  cargoMass?: number;
  /** Other pilots: their status row (shield, EMP, beams, cursor distance, tow); data is rebuilt from it and their replica */
  status?: number[];
  /**
   * The last few states the server sent (tick-stamped). Snapshots only carry what
   * changed, and distant ships come less often, so between them we dead-reckon
   * from the latest of these. Projectiles are sent once and flown from here.
   */
  hist?: { tick: number; x: number; y: number; vx: number; vy: number; angle: number }[];
  // Projectile prediction fields
  spawnTick?: number;
  spawnX?: number;
  spawnY?: number;
  predictedX?: number;
  predictedY?: number;
  lastServerUpdate?: number;
  // Orbit params (client-side position calculation)
  orbitType?: number;
  semiMajorAxis?: number;
  eccentricity?: number;
  argPeriapsis?: number;
  meanAnomaly0?: number;
  epochTick?: number;
  /** Orbit clock rate (stations orbit slower than Kepler so ships can match them) */
  orbitTimeScale?: number;
  /** Station size (world units), for drawing */
  stationRadius?: number;
  wobblePhase?: number;
  isDeterministic?: boolean; // true → skip snapshot interpolation, calculate position
}

const NONE: ReadonlySet<InterpolatedEntity> = new Set();

/**
 * The entities by id, each type also kept in a set of its own as they come and go, for the passes a frame makes over
 * one kind (the shots, the stations) without walking the hundreds of rocks and ships besides. An entity's type never changes.
 */
export class EntityMap extends Map<number, InterpolatedEntity> {
  private byType = new Map<EntityType, Set<InterpolatedEntity>>();

  override set(id: number, e: InterpolatedEntity): this {
    const old = super.get(id);
    if (old && old !== e) this.byType.get(old.type)?.delete(old);
    super.set(id, e);
    let s = this.byType.get(e.type);
    if (!s) this.byType.set(e.type, (s = new Set()));
    s.add(e);
    return this;
  }

  override delete(id: number): boolean {
    const old = super.get(id);
    if (old) this.byType.get(old.type)?.delete(old);
    return super.delete(id);
  }

  override clear(): void {
    this.byType.clear();
    super.clear();
  }

  /** The entities of one type (live: don't add or remove while going through it) */
  ofType(type: EntityType): ReadonlySet<InterpolatedEntity> {
    return this.byType.get(type) ?? NONE;
  }
}
