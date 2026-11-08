/**
 * @contract server.sieges.objectives
 * owns:       moon-night siege objectives by kind (a profile's objectives.kinds names them)
 * needs:      siege types and rules, Pilots (type), the objective modules
 * invariants: siege nights run their objectives — server/src/game/sieges/siegeNights.test.ts
 * extend:     a new objective kind is a file here and one entry in OBJECTIVES
 */

/**
 * Objectives out on the moon at night, by kind (a profile's `objectives.kinds`
 * names them). A new kind is a file here and an entry in OBJECTIVES.
 */

import type { PilotConn } from '../../Pilots.js';
import type { SiegeRules } from '../rules.js';
import type { PilotAt, Run, SiegeCtx, SiegeObjective } from '../types.js';
import { cache } from './cache.js';
import { nest } from './nest.js';

export interface SiegeObjectiveKind {
  id: string;
  /** Its name (the banner's title, the toasts) */
  title(ctx: SiegeCtx): string;
  /** What to do, for the "out on the moon" toast */
  how(ctx: SiegeCtx): string;
  /** How long it lasts and what it pays */
  pay(rules: SiegeRules): { lifeSeconds: number; supplies: number; suppliesPerNight: number; credits: number };
  /** Set it up at (x, y): its entity (-1: none), or null if it couldn't be */
  start(ctx: SiegeCtx, run: Run, x: number, y: number, now: number): number | null;
  /** A step (every 10 ticks): the pilots who did it (it's done), or nothing */
  step(ctx: SiegeCtx, run: Run, o: SiegeObjective, pilots: PilotAt[], now: number): PilotConn[] | void;
  /** Its banner's text and meter */
  banner(ctx: SiegeCtx, run: Run, o: SiegeObjective, now: number): { text: string; meter: { label: string; value: number; max: number }; danger?: boolean };
}

export const OBJECTIVES: Record<string, SiegeObjectiveKind> = { cache, nest };
