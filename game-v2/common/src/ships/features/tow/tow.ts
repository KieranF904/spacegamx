/**
 * The Tow Beam (a part: functions `tow`; docs/design/build-archetypes.md §2.14 Salvage Tug, §5 #8): latch onto
 * a wreck, a piece of debris or a loot pod within reach and pull it along on a tether.
 *
 * - The tether is a spring with a slack length: inside it nothing pulls; past it the towed thing is drawn towards
 *   the ship, damped, harder the further it stretches, and the heavier it is the less it answers (refMass). Past
 *   `snap` the tether breaks. The server moves the towed thing (server/src/ships/features/tow/Towing.ts); it's never predicted.
 * - The ship feels the load: what it tows counts as cargo (load.ts), `loadShare` of its mass, so it pushes, turns
 *   and stops slower. That rides the flight body's cargo mass, so the pilot's prediction and every replica fly it.
 * - It draws its `demand` while towing, on the ship like a gun (energy.ts gunLoad); short of power the pull
 *   weakens, and under `minShare` the beam lets go.
 * - It never takes hold of a working ship: no enemies, no bosses, no pilots (only wrecks, debris and pods).
 * - Towed into a station's reach, a wreck or debris is salvaged into the pilot's station storage (econ/salvage.ts
 *   salvageParts × `salvage`), and a pod's contents go to storage too.
 */

import type { ShipTuning } from '../../tuning.js';
import { dhypot } from '../../../math/detTrig.js';

export interface TowTuning {
  /** How far from the hull's edge the beam takes hold (world units) */
  range: number;
  /** Slack: the tether's length past both hulls before it pulls */
  rest: number;
  /** Stretched this far past the slack, it breaks */
  snap: number;
  /** Pull per tick per unit of stretch (world units / tick²), and damping on how fast the stretch changes */
  spring: number;
  damping: number;
  /** Most the pull can change the towed thing's speed in a tick */
  maxAccel: number;
  /** The towed thing answers in full up to this mass, less above it (refMass / mass), never under minAnswer */
  refMass: number;
  minAnswer: number;
  /** Share of the towed mass the ship carries as load, and the most load it carries (× its own mass) */
  loadShare: number;
  loadCap: number;
  /** A loot pod's mass (pods have none of their own) */
  podMass: number;
  /** Below this share of its power the beam lets go */
  minShare: number;
  /** Share of a wreck's or debris's salvage (salvageParts) that towing it into a station gives */
  salvage: number;
}

export const DEFAULT_TOW: TowTuning = {
  range: 420, rest: 70, snap: 900,
  spring: 0.004, damping: 0.08, maxAccel: 1.5,
  refMass: 25, minAnswer: 0.15,
  loadShare: 0.8, loadCap: 3,
  podMass: 4,
  minShare: 0.25,
  salvage: 0.5,
};

/** The beam needs at least this much of its power to take hold */
export const MIN_TOW_POWER = 0.5;

const cache = new WeakMap<object, TowTuning>();

/** A tuning's tow settings (tuning.json `tow` over the defaults) */
export function towTuning(t: ShipTuning): TowTuning {
  const over = (t as { tow?: Partial<TowTuning> }).tow;
  if (!over) return DEFAULT_TOW;
  let a = cache.get(over);
  if (!a) cache.set(over, (a = { ...DEFAULT_TOW, ...over }));
  return a;
}

/** What a rebuild derives for a ship's Tow Beams (`derived.fx.tow`): the best one's satisfaction (it takes hold from MIN_TOW_POWER), and every powered one (they draw while towing) */
export interface TowInfo { power: number; parts: number[] }

// (Declared here, not in index.ts, so everything that imports tow.ts (the barrel) sees `derived.fx.tow`)
declare module '../types.js' {
  interface FeatureDerived { tow?: TowInfo }
}

/** What a Tow Beam can take hold of */
export type TowKind = 'wreck' | 'debris' | 'pod';

/** Can this ship tow (a powered Tow Beam) */
export function canTow(d: { fx?: { tow?: { power: number } } }): boolean {
  return (d.fx?.tow?.power ?? 0) >= MIN_TOW_POWER;
}

/** The load a ship carries towing this mass (load.ts cargo), for its own mass */
export function towLoad(towedMass: number, ownMass: number, t: TowTuning = DEFAULT_TOW): number {
  return Math.max(0, Math.min(towedMass * t.loadShare, ownMass * t.loadCap));
}

/** How much the towed thing answers the pull, by its mass (1 light .. minAnswer heavy) */
export function towAnswer(mass: number, t: TowTuning = DEFAULT_TOW): number {
  return mass <= t.refMass ? 1 : Math.max(t.minAnswer, t.refMass / mass);
}

export interface TowEnd { x: number; y: number; vx: number; vy: number; r: number }

/**
 * One tick of the tether: the change in the towed thing's velocity (dvx, dvy), and whether it broke. `ship` and
 * `obj` with their radii; `mass` the towed thing's; `share` the beam's power share this tick (0..1)
 */
export function towPull(ship: TowEnd, obj: TowEnd, mass: number, share: number, t: TowTuning = DEFAULT_TOW): { dvx: number; dvy: number; snapped: boolean; stretch: number } {
  const dx = ship.x - obj.x, dy = ship.y - obj.y;
  const dist = dhypot(dx, dy);
  const slack = t.rest + ship.r + obj.r;
  const stretch = dist - slack;
  if (stretch > t.snap) return { dvx: 0, dvy: 0, snapped: true, stretch };
  if (stretch <= 0 || dist < 1e-6) return { dvx: 0, dvy: 0, snapped: false, stretch };
  const nx = dx / dist, ny = dy / dist;
  // How fast the tether's closing (the towed thing coming in along it, against the ship)
  const closing = (obj.vx - ship.vx) * nx + (obj.vy - ship.vy) * ny;
  let a = (t.spring * stretch - t.damping * closing) * towAnswer(mass, t) * Math.max(0, Math.min(1, share));
  a = Math.max(-t.maxAccel, Math.min(t.maxAccel, a));
  return { dvx: nx * a, dvy: ny * a, snapped: false, stretch };
}
