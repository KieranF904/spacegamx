/**
 * Ship ratings against threats (common/src/ships/rating.ts), for the HUD,
 * the target panel and the maps: how your ship (its rating) fares against a
 * system's or a siege moon's hostiles, or one ship, in words and a colour.
 */

import { threatLevel } from '@space-game/common';

export const THREAT_COLOR: Record<ReturnType<typeof threatLevel>, string> = {
  easy: '#86efac', fair: '#a3e635', hard: '#fbbf24', deadly: '#f87171',
};

const WORDS: Record<ReturnType<typeof threatLevel>, string> = {
  easy: 'easy', fair: 'a fair fight', hard: 'hard', deadly: 'deadly',
};

/** "Threat 46 · hard" (coloured), against your rating; empty with no threat */
export function threatTag(mine: number, theirs: number | undefined, label = 'Threat'): string {
  if (!theirs) return '';
  if (!mine) return `<span style="color:#8394ad">${label} ${Math.round(theirs)}</span>`;
  const k = threatLevel(mine, theirs);
  return `<span style="color:${THREAT_COLOR[k]}" title="Your ship rates ${Math.round(mine)}">${label} ${Math.round(theirs)} · ${WORDS[k]}</span>`;
}
