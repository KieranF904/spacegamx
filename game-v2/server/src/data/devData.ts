/**
 * Dev-only data (temporary): the systems in data/dev/*.json (rockery.json, a tiny system packed with every rock type),
 * merged into the game data on every server, production too (index.ts); each is `exclusive: "dev"` (ships/devOnly.ts): hidden from every listing, reached only by an admin. The client merges the rockery's rock
 * field in its dev build (Game.ts), so both place the same rocks. A file's `system` is added to the systems; its
 * optional `field` (and `outliers`) to the mining table. (The old dev weapons range is now the gun range: game/gunRange.)
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import type { GameDataFiles } from './GameData.js';

interface DevFile { system?: { id: string }; field?: Record<string, number>; outliers?: number }

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

/** Dev-only: the designs every guest finds in their hangar (data/ships/blueprints/dev/guest-*.json) */
export function devGuestShips(dataPath: string): unknown[] {
  const dir = join(dataPath, 'ships', 'blueprints', 'dev');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /^guest-.*\.json$/.test(f)).sort().map((f) => JSON.parse(readFileSync(join(dir, f), 'utf-8')));
}
