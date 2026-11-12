/**
 * @contract common.gun-range.options
 * owns:       which weapon models a pilot may try in the gun range: every model licensed at their level (as the hangar's
 *             palette lets them fit it), and any model they already have (on a ship of theirs, in the hold or in storage);
 *             and which weapon modifier effects, by the same rule over every part an effect takes
 * needs:      econ/{market (modelLicensed), items (parsePartItemId)}, gunRange/cheatShip (isRangeWeapon),
 *             gunRange/mods (rangeModNeed), ships/catalog
 * invariants: nothing above the pilot's level unless they hold one, and never a game-only (exclusive) or legacy weapon;
 *             an effect only with every part of it theirs to fit, never more than a gun carries (FX_MAX) —
 *             common/src/gunRange/options.test.ts
 * extend:     another way a pilot comes to have a part is one more source in owned() below
 */

import type { Catalog } from '../ships/catalog.js';
import type { Blueprint } from '../ships/types.js';
import { modelLicensed } from '../econ/market.js';
import { parsePartItemId } from '../econ/items.js';
import { FX_MAX, type ModifierTuning } from '../ships/modifiers/types.js';
import { isRangeWeapon } from './cheatShip.js';
import { rangeModNeed, rangeModParts } from './mods.js';

/** What the options are worked out from (a PlayerProfile has all of it) */
export interface RangePilotView {
  level: number;
  recipes?: readonly string[];
  ship?: { blueprint: Blueprint } | null;
  hangar?: readonly ({ blueprint: Blueprint } | null)[];
  cargo?: readonly { id: string; n: number }[];
  storage?: readonly { id: string; n: number }[];
}

/** The weapon models this pilot has (fitted, held or stored) */
function owned(p: RangePilotView): Set<string> {
  const out = new Set<string>();
  for (const rec of [p.ship, ...(p.hangar ?? [])]) for (const q of rec?.blueprint.parts ?? []) out.add(q.fn);
  for (const st of [...(p.cargo ?? []), ...(p.storage ?? [])]) { const part = st.n > 0 ? parsePartItemId(st.id) : null; if (part) out.add(part.fn); }
  return out;
}

/** The weapon models this pilot may pick in the gun range, in catalog order */
export function gunRangeOptions(catalog: Catalog, p: RangePilotView): string[] {
  const have = owned(p), learned = [...(p.recipes ?? [])];
  const out: string[] = [];
  for (const f of catalog.functions.values()) {
    if (!f.weapon || !f.model || f.legacy || f.exclusive) continue;
    if (!modelLicensed(f, learned, p.level) && !have.has(f.id)) continue;
    if (isRangeWeapon(catalog, f.id)) out.push(f.id);
  }
  return out;
}

/** The weapon modifier effects this pilot may try in the gun range (every part of one theirs to fit), in the tuning's order */
export function gunRangeMods(catalog: Catalog, mt: ModifierTuning | undefined, p: RangePilotView): string[] {
  if (!mt) return [];
  const have = owned(p), learned = [...(p.recipes ?? [])];
  const mine = (fn: string) => { const f = catalog.functions.get(fn); return !!f && (have.has(fn) || modelLicensed(f, learned, p.level)); };
  return mt.effects.filter((e) => { const need = rangeModNeed(catalog, mt, e); return !!need && rangeModParts(need).every(mine); });
}

/** What a pilot asked for, made a set of effects they may fly: theirs only, each once, in the options' order, as many as a gun carries */
export function cleanRangeMods(options: readonly string[], asked: unknown): string[] {
  if (!Array.isArray(asked)) return [];
  return options.filter((e) => asked.includes(e)).slice(0, FX_MAX);
}
