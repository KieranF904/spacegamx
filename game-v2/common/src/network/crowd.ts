/**
 * Crowd fallbacks (CAPS.CROWD, protocol 41; docs/design/awareness-model.md section 7.11): what a system does, all on its
 * own and automatically, when its tick cost goes over budget. Up to about 100 pilots in a system is the target; these
 * are for the rare dense case, applied in this order as the cost rises and undone in reverse as it falls:
 *
 *   1. focus     the focus radius shrinks (19 km to 10 km in steps) for the system's clients; everything inside stays
 *                exact, ghosts start sooner (the fade follows: the last km inside the radius, cells.ts ghostWeight)
 *   2. window    the snapshot window widens (3 ticks to 6, then 9): fewer rounds, each carrying more; a client's own
 *                inputs still go on change, unbatched, but other pilots' ride the snapshots, so they relay later
 *   3. dilation  the system's ticks run less often in real time: the same step (same dt), so the simulation is
 *                unchanged and deterministic, but everything in it slows down. A system's tick is its own count of
 *                steps: one dilated keeps its own number, behind the rest (server SystemClocks)
 *
 * Each level is a row of CROWD_LEVELS; every change goes to the system's clients (crowd message), stamped with the
 * system tick it takes effect from. A rate change is said CROWD_RATE_LEAD ticks ahead so the client's clock turns at
 * the same tick as the server's. Nothing here is on a simulation path: it is what is sent and how often, and when.
 */
import { TICK_RATE, SNAPSHOT_RATE } from '../constants.js';
import { FOCUS_RANGE } from './cells.js';

export interface CrowdLevel {
  /** The focus radius (world units) */
  focus: number;
  /** System ticks between two snapshots */
  window: number;
  /** System ticks a second of real time (TICK_RATE: none slowed) */
  rate: number;
}

/** The normal window (ticks): SNAPSHOT_RATE */
export const CROWD_BASE_WINDOW = TICK_RATE / SNAPSHOT_RATE;

/** The levels, mildest first: level 0 is none */
export const CROWD_LEVELS: readonly CrowdLevel[] = [
  { focus: FOCUS_RANGE, window: CROWD_BASE_WINDOW, rate: TICK_RATE },
  { focus: 16000, window: CROWD_BASE_WINDOW, rate: TICK_RATE },
  { focus: 13000, window: CROWD_BASE_WINDOW, rate: TICK_RATE },
  { focus: 10000, window: CROWD_BASE_WINDOW, rate: TICK_RATE },
  { focus: 10000, window: 6, rate: TICK_RATE },
  { focus: 10000, window: 9, rate: TICK_RATE },
  { focus: 10000, window: 9, rate: 45 },
  { focus: 10000, window: 9, rate: 30 },
  { focus: 10000, window: 9, rate: 20 },
  { focus: 10000, window: 9, rate: 15 },
];

export const CROWD_MAX_LEVEL = CROWD_LEVELS.length - 1;

/** A level's row (clamped) */
export function crowdLevel(lv: number): CrowdLevel {
  return CROWD_LEVELS[Math.max(0, Math.min(CROWD_MAX_LEVEL, lv | 0))];
}

/** Which fallback a level has reached: 0 none, 1 focus, 2 window, 3 dilation */
export function crowdStage(lv: number): 0 | 1 | 2 | 3 {
  const L = crowdLevel(lv);
  return L.rate < TICK_RATE ? 3 : L.window > CROWD_BASE_WINDOW ? 2 : L.focus < FOCUS_RANGE ? 1 : 0;
}

/** A rate change is said this many system ticks before it takes effect */
export const CROWD_RATE_LEAD = 30;

/** Real ms between two of a system's ticks at a rate */
export function crowdPeriodMs(rate: number): number {
  return 1000 / Math.max(1, rate);
}

/**
 * A system's step clock against the server's base ticks (TICK_RATE a second): `acc` gains `rate` every base tick and a
 * step is due each time it reaches TICK_RATE. Integer only: the same steps on every run. Returns the new acc and how
 * many steps (0 or 1: rate is at most TICK_RATE)
 */
export function crowdClockStep(acc: number, rate: number): [number, number] {
  acc += Math.max(1, Math.min(TICK_RATE, rate | 0));
  if (acc >= TICK_RATE) return [acc - TICK_RATE, 1];
  return [acc, 0];
}

/** The fade's start for a focus radius: drawn fully as a ghost from the radius in, by the last km */
function crowdFadeFrom(focus: number): number {
  return focus - 1000;
}
