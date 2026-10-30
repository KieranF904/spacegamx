/**
 * A boss's stages (PieceDef `stage`: 1 its first, outermost). Each must be beaten before the next can be hurt:
 *
 *   standing  what a shot can hit: an attached part that isn't a skeleton (shots pass through bones) and isn't ruined
 *   ruined    a `ruin` piece worn out: it stays on (RUIN_HP left), wrecked, until its boss blows its stage away
 *   deciding  what a stage is beaten by: its `ruin` pieces, if it has any (the rest of it can be shot off, but needn't
 *             be), else all of it
 *   current   the earliest stage with a deciding part still standing (hits on a later stage's part go to its nearest)
 *   integrity how whole it is, each stage an equal share of its bar: the current stage's standing deciding hull, and
 *             every stage after it whole (so beating a stage brings it down a share, and a later one isn't a softer one)
 */

import type { Catalog } from './catalog.js';
import type { ShipState } from './state.js';
import type { Blueprint } from './types.js';

/** What a ruined piece keeps (it never breaks off on its own: its boss blows it away) */
export const RUIN_HP = 1;

export function stageOf(catalog: Catalog, ship: ShipState, i: number): number {
  return catalog.pieces.get(ship.blueprint.parts[i]?.piece)?.stage ?? 0;
}

export function isRuined(catalog: Catalog, ship: ShipState, i: number): boolean {
  return !!catalog.pieces.get(ship.blueprint.parts[i]?.piece)?.ruin && ship.hp[i] <= RUIN_HP;
}

/** Can a shot hit it */
export function standing(catalog: Catalog, ship: ShipState, i: number): boolean {
  if (!ship.derived.alive[i]) return false;
  const pc = catalog.pieces.get(ship.blueprint.parts[i]?.piece);
  return !pc?.skeleton && !(pc?.ruin && ship.hp[i] <= RUIN_HP);
}

/** The stages (of a design) that have `ruin` pieces: those are beaten by them alone */
const RUINING = new WeakMap<Blueprint, Set<number>>();
function ruining(catalog: Catalog, ship: ShipState): Set<number> {
  let s = RUINING.get(ship.blueprint);
  if (!s) {
    s = new Set();
    for (const p of ship.blueprint.parts) { const pc = catalog.pieces.get(p.piece); if (pc?.ruin && pc.stage) s.add(pc.stage); }
    RUINING.set(ship.blueprint, s);
  }
  return s;
}

/** Does it decide its stage (a skeleton never does) */
export function deciding(catalog: Catalog, ship: ShipState, i: number): boolean {
  const pc = catalog.pieces.get(ship.blueprint.parts[i]?.piece);
  if (!pc?.stage || pc.skeleton) return false;
  return !!pc.ruin || !ruining(catalog, ship).has(pc.stage);
}

/**
 * A design's stages, worked out once (a design's parts and the catalog's pieces don't change; like RUINING): its
 * deciding parts, earliest stage first (in part order within one), and each stage's parts in part order
 */
const STAGED = new WeakMap<Blueprint, { deciders: number[]; parts: Map<number, number[]> }>();
function staged(catalog: Catalog, ship: ShipState): { deciders: number[]; parts: Map<number, number[]> } {
  let s = STAGED.get(ship.blueprint);
  if (!s) {
    const parts = new Map<number, number[]>();
    const deciders: number[] = [];
    ship.blueprint.parts.forEach((_, i) => {
      const st = stageOf(catalog, ship, i);
      if (!st) return;
      if (!parts.has(st)) parts.set(st, []);
      parts.get(st)!.push(i);
      if (deciding(catalog, ship, i)) deciders.push(i);
    });
    deciders.sort((a, b) => stageOf(catalog, ship, a) - stageOf(catalog, ship, b) || a - b);
    s = { deciders, parts };
    STAGED.set(ship.blueprint, s);
  }
  return s;
}

/** The earliest stage with a deciding part standing (0: it has no stages, or nothing stands) */
export function currentStage(catalog: Catalog, ship: ShipState): number {
  for (const i of staged(catalog, ship).deciders) if (standing(catalog, ship, i)) return stageOf(catalog, ship, i);
  return 0;
}

/** A stage's parts, in part order (none: an empty list) */
export function stageParts(catalog: Catalog, ship: ShipState, stage: number): readonly number[] {
  return staged(catalog, ship).parts.get(stage) ?? [];
}

/** How whole a staged ship is (0..1), or null if it has no stages */
export function stagedIntegrity(catalog: Catalog, ship: ShipState): number | null {
  const hp = new Map<number, number>(), max = new Map<number, number>();
  ship.blueprint.parts.forEach((p, i) => {
    const st = stageOf(catalog, ship, i), pc = catalog.pieces.get(p.piece);
    if (!st || !deciding(catalog, ship, i)) return;
    const floor = pc?.ruin ? RUIN_HP : 0;
    max.set(st, (max.get(st) ?? 0) + Math.max(0, ship.maxHp[i] - floor));
    hp.set(st, (hp.get(st) ?? 0) + (ship.detached[i] || !ship.derived.alive[i] ? 0 : Math.max(0, ship.hp[i] - floor)));
  });
  if (!max.size) return null;
  const stages = [...max.keys()].sort((a, b) => a - b), cur = currentStage(catalog, ship) || stages[stages.length - 1];
  const k = stages.indexOf(cur), frac = (max.get(cur) ?? 0) > 0 ? (hp.get(cur) ?? 0) / max.get(cur)! : 0;
  return Math.max(0, Math.min(1, (stages.length - k - 1 + frac) / stages.length));
}
