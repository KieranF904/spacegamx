/**
 * Node-only: read data/ships/*.json for the ship bridge.
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { Blueprint, parseBlueprint } from '@space-game/common';
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
