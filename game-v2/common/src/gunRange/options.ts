/**
 * @contract common.gun-range.options
 * owns:       which weapon models a pilot may try in the gun range: every model there is, whatever their level (the range
 *             is where a pilot finds out what is worth working towards); and which weapon modifier effects: every one
 *             the game's parts can make
 * needs:      gunRange/cheatShip (isRangeWeapon), gunRange/mods (rangeModNeed), ships/catalog
 * invariants: every pilot is offered the same, level 1 or 60; never a game-only (exclusive) or legacy weapon; never more
 *             effects than a gun carries (FX_MAX) — common/src/gunRange/options.test.ts
 * extend:     a limit on what the range offers is a test in gunRangeOptions / gunRangeMods (the pilot's view is passed)
 */

import type { Catalog } from '../ships/catalog.js';
import type { Blueprint } from '../ships/types.js';
import { FX_MAX, type ModifierTuning } from '../ships/modifiers/types.js';
import { isRangeWeapon } from './cheatShip.js';
import { rangeModNeed } from './mods.js';

/** What the options are worked out from (a PlayerProfile has all of it) */
export interface RangePilotView {
  level: number;
  recipes?: readonly string[];
  ship?: { blueprint: Blueprint } | null;
  hangar?: readonly ({ blueprint: Blueprint } | null)[];
  cargo?: readonly { id: string; n: number }[];
  storage?: readonly { id: string; n: number }[];
}

/** The weapon models a pilot may pick in the gun range (every one, whatever their level), in catalog order */
export function gunRangeOptions(catalog: Catalog, _p?: RangePilotView): string[] {
  const out: string[] = [];
  for (const f of catalog.functions.values()) {
    if (!f.weapon || !f.model || f.legacy || f.exclusive) continue;
    if (isRangeWeapon(catalog, f.id)) out.push(f.id);
  }
  return out;
}

/** The weapon modifier effects a pilot may try in the gun range (every one the game's parts can make), in the tuning's order */
export function gunRangeMods(catalog: Catalog, mt: ModifierTuning | undefined, _p?: RangePilotView): string[] {
  if (!mt) return [];
  return mt.effects.filter((e) => !!rangeModNeed(catalog, mt, e));
}

/** What a pilot asked for, made a set of effects they may fly: theirs only, each once, in the options' order, as many as a gun carries */
export function cleanRangeMods(options: readonly string[], asked: unknown): string[] {
  if (!Array.isArray(asked)) return [];
  return options.filter((e) => asked.includes(e)).slice(0, FX_MAX);
}
