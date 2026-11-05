/**
 * Groups: a custom enemy's destroyable pieces (docs/enemies/custom-roster.md). A blueprint part's `group` (0..7) says
 * which piece it is part of; a piece drawn as several parts (a claw's arm, palm and finger) breaks as one: once any of
 * its parts is down (no HP, or broken away) the whole piece is gone, here (rebuild.ts: none of it is intact) and on the
 * server, which takes the rest of its HP too (shedGroup). Only a rigid design's groups count (a player's never do).
 *
 * Which pieces are gone is one byte (a bit a group): what a custom enemy's body flies by (bodies/custom/), sent in its
 * order as the commander last saw it.
 */

import type { Blueprint } from './types.js';

/** Groups a design may have (bits of one byte) */
export const MAX_GROUPS = 8;

/** Does this design break by groups (a rigid design with any part in one) */
export function hasGroups(bp: Blueprint): boolean {
  return !!bp.rigid && bp.parts.some((p) => p.group !== undefined);
}

/** The groups gone (a bit each): a group with any part down. 0 for a design without groups */
export function groupsGone(bp: Blueprint, hp: readonly number[], detached: readonly boolean[]): number {
  if (!bp.rigid) return 0;
  let gone = 0;
  const parts = bp.parts;
  for (let i = 0; i < parts.length; i++) {
    const g = parts[i].group;
    if (g !== undefined && (hp[i] <= 0 || detached[i])) gone |= 1 << g;
  }
  return gone;
}

/** The groups a design has (a bit each) */
export function groupsOf(bp: Blueprint): number {
  let all = 0;
  for (const p of bp.parts) if (p.group !== undefined) all |= 1 << p.group;
  return all;
}

/**
 * A part just went down: the rest of its group goes with it (their HP to 0). The parts it took, in part order (none:
 * not a grouped design's, or nothing else of its group standing)
 */
export function shedGroup(bp: Blueprint, hp: number[], part: number): number[] {
  const g = bp.rigid ? bp.parts[part]?.group : undefined;
  if (g === undefined) return [];
  const out: number[] = [];
  for (let i = 0; i < bp.parts.length; i++) if (i !== part && bp.parts[i].group === g && hp[i] > 0) { hp[i] = 0; out.push(i); }
  return out;
}
