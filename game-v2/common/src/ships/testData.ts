/**
 * Test-only helper: reads data/ships/*.json from disk. Not exported from index.ts
 * (it uses Node's fs), and only imported by *.test.ts files.
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { CatalogFiles, loadCatalog } from './catalog.js';

export const SHIP_DATA_DIR = join(__dirname, '../../../data/ships');

export function readShipJson<T = any>(name: string): T {
  return JSON.parse(readFileSync(join(SHIP_DATA_DIR, name), 'utf-8'));
}

export function readCatalogFiles(): CatalogFiles {
  return {
    pieces: readShipJson('pieces.json'),
    functions: readShipJson('functions.json'),
    materials: readShipJson('materials.json'),
    models: readShipJson('models.json'),
    bespoke: existsSync(join(SHIP_DATA_DIR, 'bespoke')) ? readdirSync(join(SHIP_DATA_DIR, 'bespoke')).filter((f) => f.endsWith('.json')).sort().map((f) => readShipJson(`bespoke/${f}`)) : [],
  };
}

export function testCatalog() {
  // (The ship-wide bubbles are kept on here: their rules are tested with them. Production catalogs have them off for player ships: catalog.ts PLAYER_BUBBLE_MODELS)
  return loadCatalog(readCatalogFiles(), { playerBubbles: true });
}
