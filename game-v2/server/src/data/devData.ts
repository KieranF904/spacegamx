/**
 * Dev-only data (temporary): the systems in data/dev/*.json (rockery.json, a tiny system packed with every rock type;
 * range.json, the weapons range), merged into the game data only when the server runs in development (index.ts). The
 * client merges the rockery's rock field in its dev build (Game.ts), so both place the same rocks. A file's `system` is
 * added to the systems; its optional `field` (and `outliers`) to the mining table; its `range` block is the weapons
 * range's setup (loadRangeConfig).
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import type { GameDataFiles } from './GameData.js';
import type { RangeConfig } from '../game/WeaponsRange.js';

interface DevFile { system?: { id: string }; field?: Record<string, number>; outliers?: number; range?: Omit<RangeConfig, 'system'> }

function devFiles(dataPath: string): DevFile[] {
  const dir = join(dataPath, 'dev');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(join(dir, f), 'utf-8')) as DevFile);
}

export function withDevData(files: GameDataFiles, dataPath: string): GameDataFiles {
  const devs = devFiles(dataPath).filter((d) => d.system);
  if (!devs.length) return files;
  const out = structuredClone(files) as GameDataFiles & { systems: { systems: unknown[] }; mining: { fields?: Record<string, unknown>; outliers?: { systems?: Record<string, number> } } };
  for (const dev of devs) {
    const id = dev.system!.id;
    out.systems.systems.push(dev.system);
    if (dev.field) out.mining.fields = { ...out.mining.fields, [id]: dev.field };
    if (out.mining.outliers && dev.outliers) out.mining.outliers.systems = { ...out.mining.outliers.systems, [id]: dev.outliers };
    console.log(`Dev data: added ${id}`);
  }
  return out;
}

/** The weapons range's setup (data/dev/range.json), or none */
export function loadRangeConfig(dataPath: string): RangeConfig | undefined {
  const d = devFiles(dataPath).find((f) => f.range && f.system);
  return d ? { system: d.system!.id, ...d.range! } : undefined;
}

/** Dev-only: the designs every guest finds in their hangar (data/ships/blueprints/dev/guest-*.json) */
export function devGuestShips(dataPath: string): unknown[] {
  const dir = join(dataPath, 'ships', 'blueprints', 'dev');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /^guest-.*\.json$/.test(f)).sort().map((f) => JSON.parse(readFileSync(join(dir, f), 'utf-8')));
}
