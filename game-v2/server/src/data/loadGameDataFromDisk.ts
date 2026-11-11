/**
 * @contract server.data.disk-loader
 * owns:       Node-only reading of the data JSON files from a directory into GameDataFiles
 * needs:      fs, path, GameData.ts (GameDataFiles)
 * invariants: the real data loads and validates — server/src/data/validateGameData.test.ts
 * extend:     a new data file is one more read() line here and its field on GameDataFiles
 */

/**
 * Node-only: read the game data JSON files from a directory.
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { GameData, GameDataFiles } from './GameData.js';

export function readGameDataFiles(dataPath: string): GameDataFiles {
  const read = (name: string) => JSON.parse(readFileSync(join(dataPath, name), 'utf-8'));
  return {
    items: read('items.json'),
    recipes: read('recipes.json'),
    mining: read('mining.json'),
    factions: read('factions.json'),
    bosses: read('bosses.json'),
    ...(existsSync(join(dataPath, 'loot.json')) ? { loot: read('loot.json') } : {}),
    systems: read('systems.json'),
    stations: read('stations.json'),
    quests: read('quests.json'),
    people: read('people.json'),
    achievements: read('achievements.json'),
    rules: read('rules.json'),
    strings: read('strings.json'),
    ...(existsSync(join(dataPath, 'unlocks.json')) ? { unlocks: read('unlocks.json') } : {}),
    ...(existsSync(join(dataPath, 'hazards.json')) ? { hazards: read('hazards.json') } : {}),
    ...(existsSync(join(dataPath, 'gems.json')) ? { gems: read('gems.json') } : {}),
    ...(existsSync(join(dataPath, 'station.json')) ? { station: read('station.json') } : {}),
    ...(existsSync(join(dataPath, 'codex.json')) ? { codex: read('codex.json') } : {}),
    ...(existsSync(join(dataPath, 'mobs.json')) ? { mobs: read('mobs.json') } : {}),
    ...(existsSync(join(dataPath, 'tutorial.json')) ? { tutorial: read('tutorial.json') } : {}),
    ...(existsSync(join(dataPath, 'terrain')) ? { terrain: Object.fromEntries(readdirSync(join(dataPath, 'terrain')).filter((f) => f.endsWith('.json')).map((f) => [f.slice(0, -5), read(`terrain/${f}`)])) } : {}),
  };
}

export function loadGameDataFromDisk(dataPath: string): GameData {
  return new GameData(readGameDataFiles(dataPath));
}
