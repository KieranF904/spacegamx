/**
 * The bodies there are (docs/design/decision-inputs.md 4.1), by the brain that decides for them (bosses.json `brain`):
 * a boss with an entry here is flown by its body on both sides once its brain has a target. Adding a body is a module
 * and a line here, never a branch in the server's or the client's ship code. The index is the body's kind on the wire
 * (a SYNC's first arg): add at the end.
 */

import type { StagedFlightTables } from './stagedFlight.js';

export interface BodyKind {
  brain: string;
  /** Its flight (bodies/stagedFlight.ts) */
  flight: StagedFlightTables;
}

/** The Scrap Mother's flight: her hoard holds off, her mill closes in, her seed is quick (brains/scrapMother.ts) */
const SCRAP_MOTHER: StagedFlightTables = { range: [2100, 1500, 1200], circle: [0.3, 0.4, 0.55], drive: [0.12, 0.2, 0.3], homeR: 5000 };

export const BODY_KINDS: readonly BodyKind[] = [
  { brain: 'scrap_mother', flight: SCRAP_MOTHER },
  // (the Scrap Mother's flight, until she has moves of her own: brains/broodMother.ts)
  { brain: 'brood_mother', flight: SCRAP_MOTHER },
];

/** A brain's body kind (-1: none) */
export function bodyKindOf(brain: string): number {
  return BODY_KINDS.findIndex((k) => k.brain === brain);
}
