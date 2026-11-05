/**
 * The Scrap Mother (her Nest Rock in the Drift, past Nereid): a nest the size of a station, welded out of salvage
 * (scripts/bespoke/scrap_mother.mjs). The generalist starter boss (docs/bosses/rework-2026-11.md sections 4 and 15): any
 * loadout works. Each stage is an attack phase: its signature moves chained back to back (a short beat between them),
 * then one short window (fightRules.ts: x2 up to its cap; outside it she takes x0.3), then the phase again. Nothing is
 * scaled by how many fight her. Each move has one light tell on her hull (always the same for the same move) and one
 * dodge rule that always works. Between moves and in her window (after its 1 s rest beat) she keeps up a light threat:
 * a gun's aimed rivets down a drawn line (stages one and two), a spike's aimed chunks (stage three).
 *
 * Stage one, the hoard (her nest wings, crane arms, grapple booms): she holds off. Phase: barrage, crane, haul.
 *
 *   barrage   tell: a wing gun swings onto you with a clank, a faint yellow line. Her guns in turn, clockwise, a new
 *             line every 0.45 s (two or three live at once), 5 rivets down each, drawn at you, never ahead.
 *                                                                                Rule: cross the line
 *   crane     tell: a crane arm's elbow lamp blinks amber twice. The arm swings across her front from that side, its
 *             claw a wide hit from 600 off her hull out; the other arm blinks as it goes and swings back 0.4 s after.
 *                                                                                Rule: get in close
 *   haul      tell: her magnets hum and glow green. A strong pull towards her front (only her front), then her claws
 *             snap shut across it (the crane drew you in close: now slide off her front). Rule: get out of her front
 *
 * Stage two, the mill (her body): she closes in. Phase: shrapnel, charge, intake, charge.
 *
 *   shrapnel  tell: her stacks puff black smoke, three puffs. Four rings of fast chunks out to the nest's walls; the gap
 *             in every ring is at her flanks as she faces when it's thrown, and she turns a little between rings.
 *                                                                                Rule: stay level with her side
 *   charge    tell: her drives flare white. She lines up on where you are and rams, not turning once she goes.
 *                                                                                Rule: sidestep
 *   intake    tell: her throat glows, her rotors grind up. Her maw's lane pulls you in towards the rotors, and turns
 *             slowly after you.                                                  Rule: leave the lane sideways
 *
 * Stage three, the seed (her heart): small and quick. Phase: spiral, scissor, seekers, scissor.
 *
 *   spiral    tell: her core pulses green, she darts to a new angle. Four arms of fast chunks spun out one way only,
 *             out to the walls.                                                  Rule: circle with the spin
 *   scissor   tell: her welder tips glow blue-white. Two beams sweep in from wide until they cross ahead of her, then
 *             back out.                                                          Rule: get in close
 *   seekers   tell: her four spikes chime in turn. Eight slow-turning seekers in all, two waves of four, shared among
 *             the pilots she sees.                                               Rule: turn hard across them
 *
 * Her window (one a phase) is drawn by clients from the window alone (BossFx: the stage's pieces in bosses.json
 * `exposed`): her breeches and magnets (stage one), her throat and stacks (two), her core (three).
 *
 * Per pilot (fightRules.ts personal, held only in a window's rest beat and a stagger): marked rivets and a mite pair
 * (stage one), marked rivets and a sludge drop (two), a sludge drop and a lone seeker (three). Breaking a move's part
 * takes that move out of her phase (she goes straight on to the next): safer, not slower; her window still comes.
 */

import { Position, WINDOW, windowOpen, motherCap, MOTHER_PERSONAL, type WindowSpec } from '@space-game/common';
import type { BrainHost } from './kit.js';
import { StagedBrain } from './staged.js';

/**
 * Her attack phases' windows (rework section 15), by stage: one a phase, 5 s (4.5 s in stage three). Caps are what
 * lands after her armour (her plating lets a starter's Pip through at about 0.40-0.48): a solo starter fills about two
 * thirds of one, two or more crack it
 */
export const MOTHER_EXPOSURE: WindowSpec[] = [{ ticks: 300, cap: 440 }, { ticks: 300, cap: 470 }, { ticks: 300, cap: 480 }];
/** Her signature moves (what counts as one: fightRules.ts), each with its stage's window */
export const MOTHER_SIGNATURE: Record<string, WindowSpec> = {
  barrage: MOTHER_EXPOSURE[0], haul: MOTHER_EXPOSURE[0], crane: MOTHER_EXPOSURE[0],
  intake: MOTHER_EXPOSURE[1], shrapnel: MOTHER_EXPOSURE[1], charge: MOTHER_EXPOSURE[1],
  scissor: MOTHER_EXPOSURE[2], spiral: MOTHER_EXPOSURE[2], seekers: MOTHER_EXPOSURE[2],
};
/** Her phases: the moves chained in order, the beat between two of them, her rest after a window (ticks), by stage */
export const MOTHER_LOOP = [['barrage', 'crane', 'haul'], ['shrapnel', 'charge', 'intake', 'charge'], ['spiral', 'scissor', 'seekers', 'scissor']];
const CHAIN = [30, 24, 18], REST = [30, 24, 18];
/** Her light threat between moves and in her windows: a harassing shot every this many ticks, by stage */
const HARASS = [90, 80, 70];
/** Outside her windows she takes this (not the shared x0.35): a group's extra pilots add less (rework 3.3's lever) */
const OUTSIDE = 0.25;

/** Her brain: what she picks and when (her moves are common bodies/moves/scrapMother.ts) */
export class ScrapMotherBrain extends StagedBrain {
  constructor(host: BrainHost) {
    super(host, {
      loop: MOTHER_LOOP, rest: REST, haste: [1, 1, 1], chain: CHAIN, harass: HARASS,
      signature: MOTHER_SIGNATURE, exposure: MOTHER_EXPOSURE, personal: MOTHER_PERSONAL,
    }, 'scrap_mother');
  }

  /** Her density cap (rework 2.3): over the pilots she sees, her target first (a CAP decision when it drops any) */
  protected capped(x: number, y: number, angles: number[]): number[] {
    return motherCap(x, y, angles, this.pilots(9000).map((q) => ({ x: Position.x[q], y: Position.y[q] })));
  }

  /** What she takes of a hit, before the window's share (fightRules): outside her windows, OUTSIDE instead of the shared rate */
  taken(): number {
    return windowOpen(this.fight.window, this.host.tick()) ? 1 : OUTSIDE / WINDOW.outside;
  }
}
