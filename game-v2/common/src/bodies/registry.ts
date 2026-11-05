/**
 * The bodies there are (docs/design/decision-inputs.md 4.1), by the brain that decides for them (bosses.json `brain`;
 * `ai`: the enemy AI's commander, server/src/game/Enemies.ts): a ship with an entry here is flown by its body on both
 * sides once its brain has turned it on. Adding a body is a module and a line here, never a branch in the server's or
 * the client's ship code. The index is the body's kind on the wire (a SYNC's first arg): add at the end.
 */

import { stagedFlight, type StagedFlightTables, type BodyOut, type BodyPose } from './stagedFlight.js';
import { aiPilot, aiReads, orderPack, packCentroid } from './aiPilot.js';
import type { BodyState } from './decisions.js';

/** What a body reads of other ships, on the side it runs on */
export interface BodyReads {
  /** A ship as the body's step reads it at its tick (its target: after its own step, before that tick's pulls and contacts) */
  now(id: number): BodyPose | null;
  /** A ship as it ended the tick before */
  before(id: number): BodyPose | null;
}

export interface BodyKind {
  brain: string;
  /** Its flight's tables (a staged boss's: bodies/stagedFlight.ts) */
  flight?: StagedFlightTables;
  /**
   * Hits on it are told, not found by the client (HitLedger 'body'): how much of a hit a boss takes (braced, laid open,
   * between stages) is still its brain's
   */
  toldHits: boolean;
  /** The enemy AI's pilot: run only by clients with CAPS.PILOTS too */
  pilot?: boolean;
  /** Ships its body reads besides its own (a client must hold every one to run it) */
  reads(id: number, s: BodyState): number[];
  /** Tick t's controls and push (null: it can't be flown now); `prevQ` the aim it flew with the tick before */
  step(id: number, s: BodyState, me: BodyPose, read: BodyReads, t: number, prevQ: number): BodyOut | null;
}

/** The Scrap Mother's flight: her hoard holds off, her mill closes in, her seed is quick; held to the middle of her Heart (brains/scrapMother.ts) */
const SCRAP_MOTHER: StagedFlightTables = { range: [1800, 1200, 1100], circle: [0.3, 0.4, 0.55], drive: [0.12, 0.2, 0.3], homeR: 3500 };

/** The Pyreclast's flight: its fortress holds off, its hunter closes in and drives harder, its heart is quick (brains/pyreclast.ts) */
const PYRECLAST: StagedFlightTables = { range: [2400, 1700, 1300], circle: [0.3, 0.4, 0.55], drive: [0, 0.13, 0.22], homeR: 4600 };

/** A staged boss's body: its flight at its target */
function staged(brain: string, flight: StagedFlightTables): BodyKind {
  return {
    brain, flight, toldHits: true,
    reads: (_id, s) => (s.target >= 0 ? [s.target] : []),
    step: (_id, s, me, read, t) => {
      if (s.target < 0) return null;
      const tg = read.now(s.target);
      return tg ? stagedFlight(flight, s, me, tg, t) : null;
    },
  };
}

/** The enemy AI's pilot (bodies/aiPilot.ts): its order, its target, its pack's side */
const AI_PILOT: BodyKind = {
  brain: 'ai', toldHits: false, pilot: true,
  reads: aiReads,
  step: (id, s, me, read, t, prevQ) => {
    const reads = aiReads(id, s);
    let tg = null;
    if (s.target >= 0 && reads.length) { tg = read.now(s.target); if (!tg) return null; }
    const pack = orderPack(id, s.want);
    const c = pack ? packCentroid(pack, read.before) : null;
    if (pack && !c) return null;
    return aiPilot(s, me, tg, c, t, id, prevQ);
  },
};

export const BODY_KINDS: readonly BodyKind[] = [
  staged('scrap_mother', SCRAP_MOTHER),
  // (the Scrap Mother's flight, until she has moves of her own: brains/broodMother.ts)
  staged('brood_mother', SCRAP_MOTHER),
  AI_PILOT,
  staged('pyreclast', PYRECLAST),
];

/** A brain's body kind (-1: none) */
export function bodyKindOf(brain: string): number {
  return BODY_KINDS.findIndex((k) => k.brain === brain);
}
