/**
 * describePart(): what a part says about itself. `base` is partStats (the
 * grade/size/damage/power core, unchanged); `facts` are what the part
 * features its function gives add (features/types.ts Fact, run through
 * features/plan.ts featureFacts). The client renders the facts into tooltip
 * rows, card chips, summary fields and guide numbers (client/src/ships/describe/).
 * UI only: may allocate.
 */

import type { Catalog } from './catalog.js';
import type { ShipTuning } from './tuning.js';
import { partStats, type PartStats } from './partStats.js';
import { partMaterial } from './grades.js';
import { featureFacts } from './features/plan.js';
import type { Fact } from './features/types.js';
import type { FunctionDef } from './types.js';

export interface PartFacts {
  base: PartStats;
  facts: Fact[];
}

export function describePart(catalog: Catalog, tuning: ShipTuning | undefined, part: { material: string; fn: string; piece: string }): PartFacts | null {
  const base = partStats(catalog, tuning, part);
  const fn = catalog.functions.get(part.fn);
  if (!base || !fn) return null;
  // (No tuning: a feature reads its defaults from an empty one, as partStats does)
  const facts = featureFacts({ catalog, tuning: tuning ?? ({} as ShipTuning), fn, mat: partMaterial(catalog, part), area: base.area });
  facts.push(...relayFacts(fn));
  return { base, facts };
}

/**
 * Energy routing's relays (plain FunctionDef data, no feature: docs/design/energy-routing-impl.md §3.4): a Diode
 * (`oneWay`) and a Conduit (`relayOnly`), in plain words (their Holds and Gives are any store's: partTip, modelCards).
 */
function relayFacts(fn: FunctionDef): Fact[] {
  if (!((fn.store ?? 0) > 0) || !(fn.oneWay || fn.relayOnly)) return [];
  if (fn.oneWay) {
    return [{
      feature: 'relay', key: 'oneWay', label: 'One way', value: 'out of its front', tier: 'stat',
      sentence: 'power only flows out of its front, into the part there; the other parts touching it can only feed it, and its front must touch a part',
      short: 'power only flows out of its front', chip: 'one way',
    }];
  }
  return [{
    feature: 'relay', key: 'carries', label: 'Carries', value: 'between touching parts', tier: 'stat',
    sentence: 'a power line: it passes power between the parts it touches, both ways, and holds very little itself',
    short: 'passes power between the parts it touches', chip: 'power line',
  }];
}

/** Facts of a function on its own (a palette card, no material placed): the first material it names */
export function describeFn(catalog: Catalog, tuning: ShipTuning | undefined, fnId: string, piece?: string, material?: string): Fact[] {
  const fn = catalog.functions.get(fnId);
  if (!fn) return [];
  const pc = piece ?? (fn.pieces === '*' ? 'sq' : fn.pieces[0]);
  return describePart(catalog, tuning, { fn: fnId, material: fn.model ? fn.material ?? 'alloy' : material ?? fn.material ?? 'alloy', piece: pc })?.facts ?? [];
}
