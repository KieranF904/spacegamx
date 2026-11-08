/**
 * Node-only: read data/ships/*.json for the ship bridge.
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import { Blueprint, parseBlueprint, resolveDesignUpdate, type DesignUpdateFile } from '@space-game/common';
import type { ShipConfig } from '../proto/createProtoServer.js';

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
  // The players' remakes (blueprints/remakes): the design update swaps them in (designUpdate.json); never sold, learned
  // or spawned. The deploy ships them (unlike dev/); like the dev test ships they're on the F9 ship swap too
  const remakes: Record<string, Blueprint> = {};
  const remakeDir = join(dir, 'blueprints', 'remakes');
  if (existsSync(remakeDir)) for (const f of readdirSync(remakeDir)) {
    if (f.endsWith('.json')) remakes[f.slice(0, -5)] = dev[f.slice(0, -5)] = parseBlueprint(readFileSync(join(remakeDir, f), 'utf-8'));
  }
  // The design update's mapping, its blueprints found: "remakes/<file>", or a library ship's id
  const designUpdate = existsSync(join(dir, 'designUpdate.json'))
    ? resolveDesignUpdate(read('designUpdate.json') as DesignUpdateFile, (id) => (id.startsWith('remakes/') ? remakes[id.slice('remakes/'.length)] : library[id]))
    : undefined;
  if (designUpdate?.missing.length) console.warn(`[ships] designUpdate.json names blueprints that aren't there (those saves are wiped instead): ${designUpdate.missing.join(', ')}`);
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
    ...(designUpdate ? { designUpdate: { accounts: designUpdate.accounts, blueprints: designUpdate.blueprints } } : {}),
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
