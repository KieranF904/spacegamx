/**
 * Test-only helper: reads data/ships/*.json from disk. Not exported from index.ts
 * (it uses Node's fs), and only imported by *.test.ts files.
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { type Catalog, CatalogFiles, loadCatalog } from './catalog.js';
import type { Blueprint, Rot, Side } from './types.js';
import { blueprintGeometry } from './blueprint.js';
import { frameOf, placeEdge } from './power/portsBuild.js';

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

const OPPOSITE: Record<Side, Side> = { N: 'S', E: 'W', S: 'N', W: 'E' };
const ROT_OF: Record<Side, Rot> = { N: 0, E: 1, S: 2, W: 3 };
/**
 * A part added to a design gets its own power (ports core: power crosses only out -> in through ports): across each of
 * its in ports, a generator whose out port faces it (`gen`, a Cell Reactor by default), in place of whatever stood on
 * that cell. In place; returns the design. (Tests that add a shield, a coil or a strafer to a library ship.)
 */
export function feedParts(catalog: Catalog, bp: Blueprint, uids: readonly number[], gen = 'power_cell_reactor'): Blueprint {
  let next = Math.max(...bp.parts.map((q) => q.uid)) + 1;
  for (const uid of uids) {
    const geoms = blueprintGeometry(catalog, bp);
    const i = bp.parts.findIndex((q) => q.uid === uid);
    const part = bp.parts[i], fn = catalog.functions.get(part.fn);
    for (const q of fn?.ports ?? []) {
      if (q.dir !== 'in') continue;
      const e = placeEdge(part, frameOf(part, geoms[i].cells), q.side, q.cell ?? 0);
      const there = bp.parts.findIndex((o, j) => j !== i && geoms[j].cells.some((c) => c[0] === e.nx && c[1] === e.ny));
      if (there >= 0 && bp.parts[there].fn === 'core') throw new Error(`feedParts: part ${uid}'s in port faces the core`);
      if (there >= 0 && bp.parts[there].fn === gen && bp.parts[there].rot === ROT_OF[OPPOSITE[e.side]]) continue;
      if (there >= 0) bp.parts.splice(there, 1);
      bp.parts.push({ uid: next++, piece: 'sq', fn: gen, material: catalog.functions.get(gen)?.material ?? 'alloy', x: e.nx, y: e.ny, rot: ROT_OF[OPPOSITE[e.side]], flip: false });
    }
  }
  return bp;
}
