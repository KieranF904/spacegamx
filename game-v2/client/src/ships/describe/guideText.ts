/**
 * Numbers for the field guide's authored prose: `F(index, 'tow', 'range')`
 * reads a feature's fact off the first model that has it, so a guide sentence
 * follows the tuning instead of repeating it. Prose stays hand-written; only
 * numbers come from facts.
 */

import type { Catalog, Fact, ShipTuning } from '@space-game/common';
import { describeFn } from '@space-game/common';
import { factValue } from './render';

export type FactIndex = Map<string, Fact>;

/** The first fact of each `feature.key` across every function of the catalog */
export function buildFactIndex(catalog: Catalog, tuning: ShipTuning): FactIndex {
  const idx: FactIndex = new Map();
  for (const fn of catalog.functions.values()) {
    for (const f of describeFn(catalog, tuning, fn.id)) {
      const k = `${f.feature}.${f.key}`;
      if (!idx.has(k)) idx.set(k, f);
    }
  }
  return idx;
}

/** The text of one fact, or `fallback` when no part gives it (never throws inside a template) */
export function guideNumber(idx: FactIndex, feature: string, key: string, fallback = ''): string {
  const f = idx.get(`${feature}.${key}`);
  return f ? factValue(f) : fallback;
}
