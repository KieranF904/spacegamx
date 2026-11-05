/**
 * The tick's phase order as code (sim foundation, Stage 0 contract). Both ends run a tick through `runTick` with
 * the phases they have; a phase an end doesn't run is simply absent from its table (a client has no repair, no
 * part deaths of its own). The order is this list, nowhere else: comments that describe it point here.
 *
 * Today: server/src/GameServer.ts buildTickSystems (pilots-move: playerMovementSystem, towing; combat: weaponSystem,
 * projectileSystem, enemies/bosses/mobs, collisionSystem, lod, ships) and, inside ships, server/src/ships/bridge/
 * flight.ts tick (pilotless, queued pulls, debris, shields, resolveContacts, horizon, part deaths, repair, rebuild,
 * quantise). The server keeps its coarse TICK_PHASES (server/src/tickOrder.ts) for its other systems; these are the
 * simulation's phases within them, and both ends walk them in this order.
 */

export const SIM_PHASES = [
  /** Pilots, by ascending id (stepShip per ship; pulls inside the step once Stage 1C lands) */
  'pilots',
  /** Part features that act after the pilots fly (a Tow Beam's pull on what it tows: features/host.ts) */
  'features',
  /** Pilots' guns (server weaponSystem). Folded into the pilots' stepShip once Stage 1B lands */
  'guns',
  /** Shells move and hit (projectileSystem): pilots at their state this tick, everyone else at last tick's (timeline.ts hitStateTick) */
  'shots',
  /** AI, bosses, mobs decide (decided inputs for the pilotless phase) */
  'decisions',
  /** Shells against rocks and the rest of collisionSystem */
  'collisions',
  /** Everything nobody pilots: AI, autopilot, held; anchored wrecks */
  'pilotless',
  /** Pulls not yet inside the step (today's push queue); empty once Stage 1C lands */
  'pulls',
  /** Debris drifts and knocks into debris, as a world (ships/debris.ts) */
  'debris',
  'shields',
  /** Ship-to-ship contacts: the pairs found once per tick (env.ts ContactCache), in ascending (a, b) order */
  'contacts',
  'horizon',
  /** Part deaths and the blasts they set off, repeated until nothing new dies */
  'partDeaths',
  'repair',
  /** The tick's one rebuild point (structure swaps, version bumps) */
  'rebuild',
  /** Every body onto SHIP_PRECISION */
  'quantize',
] as const;

export type SimPhase = (typeof SIM_PHASES)[number];

export type PhaseTable<C> = Partial<Record<SimPhase, (ctx: C, tick: number) => void>>;

/** Run one tick's phases in the one order */
export function runTick<C>(phases: PhaseTable<C>, ctx: C, tick: number): void {
  for (let i = 0; i < SIM_PHASES.length; i++) {
    const f = phases[SIM_PHASES[i]];
    if (f) f(ctx, tick);
  }
}
