/**
 * Node-only: read data/ships/*.json for the ship bridge.
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import { Blueprint, parseBlueprint } from '@space-game/common';
import type { ShipConfig } from './createShipBridge.js';

export function loadShipConfigFromDisk(dataPath: string): ShipConfig {
  const dir = join(dataPath, 'ships');
  const read = (name: string) => JSON.parse(readFileSync(join(dir, name), 'utf-8'));
  const library: Record<string, Blueprint> = {};
  for (const f of readdirSync(join(dir, 'blueprints'))) {
    if (f.endsWith('.json')) library[f.slice(0, -5)] = parseBlueprint(readFileSync(join(dir, 'blueprints', f), 'utf-8'));
  }
  // Enemy designs live apart from the plan library (players don't learn them)
  const enemies: Record<string, Blueprint> = {};
  for (const f of readdirSync(join(dir, 'blueprints', 'enemy'))) {
    if (f.endsWith('.json')) enemies[f.slice(0, -5)] = parseBlueprint(readFileSync(join(dir, 'blueprints', 'enemy', f), 'utf-8'));
  }
  // Dev test ships (the F9 ship swap only: apart from the plan library, so never sold, learned or spawned)
  const dev: Record<string, Blueprint> = {};
  const devDir = join(dir, 'blueprints', 'dev');
  if (existsSync(devDir)) for (const f of readdirSync(devDir)) {
    if (f.endsWith('.json')) dev[f.slice(0, -5)] = parseBlueprint(readFileSync(join(devDir, f), 'utf-8'));
  }
  // The players' remakes (blueprints/remakes: made for the v5 design update, long run): never sold, learned or spawned.
  // The deploy ships them (unlike dev/); like the dev test ships they're on the F9 ship swap
  const remakeDir = join(dir, 'blueprints', 'remakes');
  if (existsSync(remakeDir)) for (const f of readdirSync(remakeDir)) {
    if (f.endsWith('.json')) dev[f.slice(0, -5)] = parseBlueprint(readFileSync(join(remakeDir, f), 'utf-8'));
  }
  // Designs' own pieces (bosses' bespoke hulls)
  const bespokeDir = join(dir, 'bespoke');
  const bespoke = existsSync(bespokeDir) ? readdirSync(bespokeDir).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(join(bespokeDir, f), 'utf-8'))) : [];
  return {
    catalog: { pieces: read('pieces.json'), functions: read('functions.json'), materials: read('materials.json'), models: read('models.json'), bespoke },
    tuning: read('tuning.json'),
    inventory: read('inventory.json'),
    starter: library['sparrow-t'],
    library,
    enemies,
    dev,
  };
}

const cached = new Map<string, ShipConfig>();

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/**
 * Tests' loader: the same config as loadShipConfigFromDisk, read once per worker per data folder and handed (deep
 * frozen) to every caller. A test that needs to change the config copies the part it changes.
 */
export function loadShipConfigCached(dataPath: string): ShipConfig {
  const key = resolve(dataPath);
  let config = cached.get(key);
  if (!config) cached.set(key, config = deepFreeze(loadShipConfigFromDisk(dataPath)));
  return config;
}
