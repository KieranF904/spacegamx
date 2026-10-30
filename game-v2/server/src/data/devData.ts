/**
 * Dev-only data (temporary): data/dev/rockery.json, a tiny system packed with
 * every rock type, merged into the game data only when the server runs in
 * development (index.ts). The client merges the same rock field in its dev
 * build (Game.ts), so both place the same rocks.
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import type { GameDataFiles } from './GameData.js';

export function withDevData(files: GameDataFiles, dataPath: string): GameDataFiles {
  const file = join(dataPath, 'dev', 'rockery.json');
  if (!existsSync(file)) return files;
  const dev = JSON.parse(readFileSync(file, 'utf-8')) as { system: { id: string }; field: Record<string, number>; outliers?: number };
  const out = structuredClone(files) as GameDataFiles & { systems: { systems: unknown[] }; mining: { fields?: Record<string, unknown>; outliers?: { systems?: Record<string, number> } } };
  out.systems.systems.push(dev.system);
  out.mining.fields = { ...out.mining.fields, [dev.system.id]: dev.field };
  if (out.mining.outliers && dev.outliers) out.mining.outliers.systems = { ...out.mining.outliers.systems, [dev.system.id]: dev.outliers };
  console.log(`Dev data: added ${dev.system.id}`);
  return out;
}

/** Dev-only: the designs every guest finds in their hangar (data/ships/blueprints/dev/guest-*.json) */
export function devGuestShips(dataPath: string): unknown[] {
  const dir = join(dataPath, 'ships', 'blueprints', 'dev');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /^guest-.*\.json$/.test(f)).sort().map((f) => JSON.parse(readFileSync(join(dir, f), 'utf-8')));
}
