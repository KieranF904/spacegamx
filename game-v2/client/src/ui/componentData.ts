/**
 * The game data behind a component's gates, read once and shared by the component guide and the hangar palette:
 * structure's plates (which materials a pilot builds structure in), the jobs that teach licences, where bosses drop
 * rare parts; and `componentGates`, a row's gates for a pilot (componentGuide.ts rowGates with that context).
 */

import type { Bag, Catalog, Economy } from '@space-game/common';
import bossData from '../../../data/bosses.json';
import systemsData from '../../../data/systems.json';
import questsData from '../../../data/quests.json';
import recipesData from '../../../data/recipes.json';
import { bossDrops, questTeaches, rowGates, rowItemId, type CompRow, type Gate, type GateCtx, type PilotView } from './componentGuide';

/** Structure's plate per material (recipes.json parts.plates): a material with one is buildable structure */
export const PLATES = (recipesData as unknown as { parts: { plates: Record<string, string> } }).parts.plates;
const SYSTEM_NAME = new Map((systemsData as unknown as { systems: { id: string; name: string }[] }).systems.map((s) => [s.id, s.name]));
export const DROPS = bossDrops(bossData as unknown as Parameters<typeof bossDrops>[0], (id) => SYSTEM_NAME.get(id));
export const QUESTS = questTeaches(questsData as unknown as Parameters<typeof questTeaches>[0]);

/** What fabricating a row takes (a model's recipe inputs) */
export function rowInputs(econ: Economy, row: CompRow): Bag {
  return econ.recipes.recipeFor(rowItemId(row))?.inputs ?? {};
}

export function gateCtx(econ: Economy, row: CompRow): GateCtx {
  return { items: econ.items.all(), quests: QUESTS, drops: DROPS, inputs: rowInputs(econ, row) };
}

/** A row's gates for this pilot */
export function componentGates(catalog: Catalog, econ: Economy, row: CompRow, pilot: PilotView): Gate[] {
  return rowGates(row, catalog.functions.get(row.fn), pilot, gateCtx(econ, row));
}
