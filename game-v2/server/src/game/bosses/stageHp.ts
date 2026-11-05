/**
 * A staged boss's HP set outright by stage (docs/bosses/rework-2026-11.md 3.1): bosses.json `stageHp` [a, b, c] is what
 * each stage's deciding pieces (common ships/stages.ts `deciding`) hold together, its core's x2.5 counted in (so this
 * runs after Bosses.create hardens it); each keeps its share of its stage as built. `limbs` sets each limb's HP outright
 * (PieceDef `limb`: by piece name, less its design's prefix and its side, `scythe_gun` for pyreclast_scythe_gun_l).
 * Pieces in neither keep their HP (the boss's `hp` scale).
 */

import { deciding, stageOf, type Catalog, type ShipState } from '@space-game/common';

export interface StageHpDef {
  /** Each stage's deciding HP, stage one first */
  stageHp?: number[];
  /** A limb's HP, by piece name (no prefix, no side) */
  limbs?: Record<string, number>;
}

/** A piece's name as `limbs` keys it: `pyreclast_s3_vent_housing_l` -> `s3_vent_housing` */
export const limbName = (piece: string): string => piece.replace(/^[^_]+_/, '').replace(/_[lr]$/, '');

/** Every part's max HP with `stageHp` and `limbs` applied (null: the def sets neither) */
export function stageHpOf(catalog: Catalog, ship: ShipState, def: StageHpDef): number[] | null {
  if (!def.stageHp?.length && !def.limbs) return null;
  const hp = [...ship.maxHp];
  const sums = new Map<number, number>();
  ship.blueprint.parts.forEach((_, i) => {
    if (deciding(catalog, ship, i)) { const st = stageOf(catalog, ship, i); sums.set(st, (sums.get(st) ?? 0) + hp[i]); }
  });
  ship.blueprint.parts.forEach((p, i) => {
    const st = stageOf(catalog, ship, i), want = def.stageHp?.[st - 1];
    if (want !== undefined && deciding(catalog, ship, i) && (sums.get(st) ?? 0) > 0) hp[i] = (hp[i] * want) / sums.get(st)!;
    else if (catalog.pieces.get(p.piece)?.limb) { const own = def.limbs?.[limbName(p.piece)]; if (own !== undefined) hp[i] = own; }
  });
  return hp;
}
