/**
 * The game data the resource dictionary reads, wired into one GameData (see resourceIndex.ts) and indexed once.
 * Kept apart from the index so the index stays a pure function (its tests feed it the same files).
 */

import itemsData from '../../../../data/items.json';
import recipesData from '../../../../data/recipes.json';
import miningData from '../../../../data/mining.json';
import systemsData from '../../../../data/systems.json';
import stationsData from '../../../../data/stations.json';
import bossesData from '../../../../data/bosses.json';
import factionsData from '../../../../data/factions.json';
import lootData from '../../../../data/loot.json';
import questsData from '../../../../data/quests.json';
import peopleData from '../../../../data/people.json';
import rulesData from '../../../../data/rules.json';
import stationData from '../../../../data/station.json';
import gemsData from '../../../../data/gems.json';
import materialsData from '../../../../data/ships/materials.json';
import modelsData from '../../../../data/ships/models.json';
import functionsData from '../../../../data/ships/functions.json';
import hintsData from '../../../../data/guideHints.json';
import { buildResourceIndex, type GameData, type ResourceEntry } from './resourceIndex';
import { buildSourceIndex, type SourceIndex } from './sourceIndex';
import { buildLevels, type LevelIndex } from './levels';
import { buildCommonness, type CommonnessIndex } from './commonness';

export const RESOURCE_DATA: GameData = {
  items: (itemsData as unknown as { items: GameData['items'] }).items,
  recipes: recipesData as unknown as GameData['recipes'],
  mining: miningData as unknown as GameData['mining'],
  systems: (systemsData as unknown as { systems: GameData['systems'] }).systems,
  stations: (stationsData as unknown as { stations: GameData['stations'] }).stations,
  bosses: (bossesData as unknown as { bosses: GameData['bosses'] }).bosses,
  factions: (factionsData as unknown as { factions: GameData['factions'] }).factions,
  spawns: (factionsData as unknown as { spawns?: GameData['spawns'] }).spawns,
  loot: lootData as unknown as GameData['loot'],
  quests: questsData as unknown as GameData['quests'],
  people: (peopleData as unknown as { people: GameData['people'] }).people,
  rules: rulesData as unknown as GameData['rules'],
  station: stationData as unknown as GameData['station'],
  gems: gemsData as unknown as GameData['gems'],
  materials: (materialsData as unknown as { materials: GameData['materials'] }).materials,
  models: (modelsData as unknown as { models: GameData['models'] }).models,
  functions: (functionsData as unknown as { functions: GameData['functions'] }).functions,
  hints: (hintsData as unknown as { hints: Record<string, string> }).hints,
};

let cachedSources: SourceIndex | undefined;
/** The rocks, enemies and per-item columns (built on first use) */
export function sourceIndex(): SourceIndex {
  return (cachedSources ??= buildSourceIndex(RESOURCE_DATA));
}
let cached: ResourceEntry[] | undefined;
/** The dictionary's entries (built on first use) */
export function resourceEntries(): ResourceEntry[] {
  return (cached ??= buildResourceIndex(RESOURCE_DATA, sourceIndex()));
}
let cachedLevels: LevelIndex | undefined;
/** The level each entry opens at (built on first use) */
export function levelIndex(): LevelIndex {
  return (cachedLevels ??= buildLevels(RESOURCE_DATA, sourceIndex()));
}
let cachedCommonness: CommonnessIndex | undefined;
/** The most-common-first order keys (built on first use) */
export function commonnessIndex(): CommonnessIndex {
  return (cachedCommonness ??= buildCommonness(RESOURCE_DATA, sourceIndex(), levelIndex()));
}
