/**
 * The refiner's choice of batch (docs/design/field-fabrication.md 5.7): a chosen recipe while the hold has its inputs,
 * or, on auto, whatever the fabricator's next jobs are short of that the hold's ore can make. The grade cap applies
 * (econ/field canRefine). Pure.
 */

import { canRefine, type Bag, type Economy, type MachineBlock } from '@space-game/common';

export type RefinePick = { recipe: string; inputs: Bag; out: Bag } | { blocked: MachineBlock };

const hasAll = (inputs: Bag, have: (id: string) => number) => Object.entries(inputs).every(([id, n]) => have(id) >= n);

/**
 * `recipe`: the pilot's choice (undefined: auto). `short`: what the fabricator's jobs were short of (auto refines the
 * first of those, by id, that a recipe this tier can run makes from what the hold has)
 */
export function pickRefine(econ: Economy, tier: number, recipe: string | undefined, short: Bag, have: (id: string) => number): RefinePick {
  const batch = (id: string): RefinePick => {
    const r = econ.recipes.refining.get(id)!;
    return { recipe: id, inputs: { ...r.inputs }, out: { [id]: r.out } };
  };
  if (recipe !== undefined) {
    if (!econ.recipes.refining.has(recipe)) return { blocked: 'idle' };
    if (!canRefine(econ, tier, recipe)) return { blocked: 'grade' };
    return hasAll(econ.recipes.refining.get(recipe)!.inputs, have) ? batch(recipe) : { blocked: 'materials' };
  }
  let graded = false;
  for (const id of Object.keys(short).filter((k) => short[k] > 0).sort()) {
    const r = econ.recipes.refining.get(id);
    if (!r) continue;
    if (!canRefine(econ, tier, id)) { graded = true; continue; }
    if (hasAll(r.inputs, have)) return batch(id);
  }
  return { blocked: graded ? 'grade' : 'idle' };
}
