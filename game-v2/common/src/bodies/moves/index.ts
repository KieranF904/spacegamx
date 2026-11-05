/**
 * Bodies' moves, the same on both sides (decision-inputs stage 4, CAPS.MOVES): a staged boss's moves by its brain (a
 * module and a line here), custom enemies' by design (custom.ts)
 */
import type { StagedFlightTables } from '../stagedFlight.js';
import type { MoveHost } from './host.js';
import type { StagedMoves } from './staged.js';
import { ScrapMotherMoves, MOTHER_PERSONAL, MOTHER_PERSONAL_NAMES } from './scrapMother.js';
import { PyreclastMoves, PYRECLAST_PERSONAL, PYRECLAST_PERSONAL_NAMES } from './pyreclast.js';

export interface StagedMovesKind {
  make(h: MoveHost, eid: number, flight: StagedFlightTables): StagedMoves;
  /** Its personal attacks' names (a PERSONAL's name index), and how long one runs */
  personalNames: readonly string[];
  personalTicks: number;
}

/** By brain (bosses.json `brain`) */
export const STAGED_MOVES: Readonly<Record<string, StagedMovesKind>> = {
  scrap_mother: { make: (h, eid, f) => new ScrapMotherMoves(h, eid, f), personalNames: MOTHER_PERSONAL_NAMES, personalTicks: MOTHER_PERSONAL.ticks },
  pyreclast: { make: (h, eid, f) => new PyreclastMoves(h, eid, f), personalNames: PYRECLAST_PERSONAL_NAMES, personalTicks: PYRECLAST_PERSONAL.ticks },
};

export * from './host.js';
export * from './staged.js';
export * from './scrapMother.js';
export * from './pyreclast.js';
export * from './custom.js';
export * from './track.js';
