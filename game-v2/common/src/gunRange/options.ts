/**
 * @contract common.gun-range.options
 * owns:       which weapon models a pilot may try in the gun range: every model licensed at their level (as the hangar's
 *             palette lets them fit it), and any model they already have (on a ship of theirs, in the hold or in storage)
 * needs:      econ/{market (modelLicensed), items (parsePartItemId)}, gunRange/cheatShip (isRangeWeapon), ships/catalog
 * invariants: nothing above the pilot's level unless they hold one, and never a game-only (exclusive) or legacy weapon —
 *             common/src/gunRange/options.test.ts
 * extend:     another way a pilot comes to have a weapon is one more source in owned() below
 */

import type { Catalog } from '../ships/catalog.js';
import type { Blueprint } from '../ships/types.js';
import { modelLicensed } from '../econ/market.js';
import { parsePartItemId } from '../econ/items.js';
import { isRangeWeapon } from './cheatShip.js';

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
