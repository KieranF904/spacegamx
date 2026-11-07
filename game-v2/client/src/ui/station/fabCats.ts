/**
 * Station Fabricator categories.
 *
 * Owns: FabCat, FabEntry, FAB_CATS (the categories, filled from each function's category in data/ships/functions.json in fabOrder) and licenceFor (what a locked recipe waits on).
 * Needs: ship function data, data/gems.json (the Gems icon), data/station.json (armoury rounds).
 * Extend: a new fabricator category is a FabCat entry in FAB_CATS plus its functions' category in functions.json.
 */

import {
  CraftRecipe, ItemCatalog, licenceName, parsePartItemId, registeredFunction, materialLicensed, MATERIAL_LEVEL, materialUnlockName, unlocks, gemItemId, armouryRound, type ItemDef,
} from '@space-game/common';
import { SHIP_FUNCTIONS } from '../../ships/shipFunctionData';
import { STATION, GEMS } from './shared';

export type FabCat = 'weapons' | 'power' | 'engines' | 'shields' | 'utility' | 'core' | 'ammo' | 'supplies' | 'components' | 'gems';

/** One thing to pick in a fabricator category: a module (by function) or a recipe */
export interface FabEntry { key: string; name: string; icon: string; locked: boolean; have?: number; group?: string; order: number; /** A locked model: its badge ("Lv 12"), and what unlocks it */ badge?: string; why?: string }

/**
 * The fabricator's categories: modules, from each function's `category` in
 * data/ships/functions.json, in `fabOrder` (structure isn't fabricated); the
 * rest hold the item recipes, by what they make.
 */
export const FAB_CATS: Record<FabCat, { label: string; title: string; icon: string; fns: string[]; items?: (d: ItemDef | undefined) => boolean }> = {
  weapons: { label: 'Weapons', title: 'Weapons', icon: 'part:alloy:cannon_pip:sq', fns: [] },
  power: { label: 'Power', title: 'Generators & batteries', icon: 'part:alloy:power_cell_reactor:sq', fns: [] },
  engines: { label: 'Engines', title: 'Engines & coils', icon: 'part:alloy:engine_ion_drive:sq', fns: [] },
  shields: { label: 'Shields', title: 'Shields & plating', icon: 'part:steel:shield_deflector:sq', fns: [] },
  utility: { label: 'Mining', title: 'Mining & scanning', icon: 'part:alloy:utility_mining_laser:sq', fns: [] },
  core: { label: 'Core', title: 'Cores', icon: 'part:alloy:core:sq', fns: [] },
  ammo: { label: 'Ammo', title: 'Ammunition', icon: 'missile_crate', fns: [], items: (d) => d?.category === 'ammo' },
  supplies: { label: 'Supplies', title: 'Supplies', icon: 'pack_hull', fns: [], items: (d) => d?.category === 'consumable' },
  components: { label: 'Components', title: 'Components', icon: 'power_coupling', fns: [], items: (d) => d?.category !== 'ammo' && d?.category !== 'consumable' },
  gems: { label: 'Gems', title: 'Gems', icon: '', fns: [] },
};
FAB_CATS.gems.icon = gemItemId(Object.keys(GEMS.types)[0] ?? '', 1);
// (The models and the core: not the legacy functions models replaced, nor the game's own ships' parts)
for (const f of [...SHIP_FUNCTIONS].filter((f) => !f.legacy && !f.exclusive).sort((a, b) => (a.fabOrder ?? 0) - (b.fabOrder ?? 0))) {
  if (f.category && f.category !== 'other' && f.category in FAB_CATS) FAB_CATS[f.category as FabCat].fns.push(f.id);
}

/** What a locked recipe waits on: "pilot level 12", "pilot level 5 (Steel structure)", "Core fabrication" (nothing opens early) */
export function licenceFor(r: CraftRecipe, learned: string[], items: ItemCatalog, level: number): string {
  const p = parsePartItemId(r.id);
  if (!p) {
    if (r.level !== undefined && level < r.level) return `pilot level ${r.level}`;
    if (armouryRound(r.id, STATION)) return r.quest ? "its job, and your own station's armoury" : "your own station's armoury";
    return r.quest ? 'its job' : 'the recipe';
  }
  const fn = registeredFunction(p.fn);
  if (fn?.model) return fn.unlock ? `pilot level ${fn.unlock.level}` : 'a model no pilot makes';
  if (!materialLicensed(p.material, learned, level)) {
    const at = MATERIAL_LEVEL[p.material];
    if (at === undefined) return `${materialUnlockName(p.material)}, which no pilot builds with`;
    return level < at ? `pilot level ${at} (${materialUnlockName(p.material)})` : `${licenceName(`material:${p.material}`, items)}, from its job`;
  }
  return licenceName(`fn:${p.fn}`, items);
}
