/**
 * The server tick as an ordered table of guarded systems (GameServer builds it once, in its constructor, and
 * tick() walks it). The order IS the simulation order: server/src/golden/tickOrder.json pins it, and
 * tickOrder.test.ts pins the table itself.
 *
 * Phases, in order:
 *   pilots-move  the world moves: orbits, world memory, spatial grid, pilots fly, tows, docking, rifts
 *   combat       guns, shells, AI (sectors only), collisions, part deaths, ships, replication, self hashes
 *   world        pods, mining, hazards, cold, homes, comet, outposts, pilots, quests, codex, party, trade, ...
 *   persist      linger, derelict respawn, traffic, lifetimes, cleanup
 *
 * Walking the table allocates nothing: every entry's `run` is built once. An entry with `perClient` runs its own
 * loop over the clients and guards each client separately (today's guard granularity: one bad client must not
 * stop the rest), so the walker does not wrap it in a guard of its own.
 */

export type TickPhase = 'pilots-move' | 'combat' | 'world' | 'persist';

/** The phases in the order they run */
export const TICK_PHASES: readonly TickPhase[] = ['pilots-move', 'combat', 'world', 'persist'];

export interface TickSystem {
  /** The guard name (fault reports, tickOrder.json) */
  readonly name: string;
  readonly phase: TickPhase;
  /** Runs only on ticks where currentTick % every === 0 */
  readonly every?: number;
  /** Runs only in this scene */
  readonly scene?: 'sectors';
  /** Extra gate, checked each tick before running */
  readonly when?: () => boolean;
  /** The entry guards per client inside run (the walker does not guard it) */
  readonly perClient?: boolean;
  readonly run: () => void;
}

/** Throws if the table's phases are out of order or a name is used twice (checked once, at construction) */
export function checkTickOrder(systems: readonly TickSystem[]): void {
  let phase = 0;
  const seen = new Set<string>();
  for (const s of systems) {
    const p = TICK_PHASES.indexOf(s.phase);
    if (p < phase) throw new Error(`tick system ${s.name} (${s.phase}) is out of phase order`);
    phase = p;
    if (seen.has(s.name)) throw new Error(`tick system ${s.name} is listed twice`);
    seen.add(s.name);
  }
}
