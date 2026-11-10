// The game data the generator reads, loaded once from disk (Node only; no network). Everything else in core/ takes a
// ShipgenContext, so a test or a tool can build one from other data.
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { type Catalog, type CatalogFiles, type ShipTuning, loadCatalog } from '../../../common/src/ships/index';
import { Economy, type ItemsFile, type RecipesFile } from '../../../common/src/econ/index';

export interface ShipgenContext {
  catalog: Catalog;
  tuning: ShipTuning;
  /** Items and recipes (part costs); absent when the data has none */
  econ?: Economy;
  /** data/ (the game's data folder) */
  dataDir: string;
}

/** game-v2/data */
export const DATA_DIR = join(__dirname, '../../../data');

const readJson = <T = any>(p: string): T => JSON.parse(readFileSync(p, 'utf8'));

export function readCatalogFiles(dataDir = DATA_DIR): CatalogFiles {
  const dir = join(dataDir, 'ships'), bespokeDir = join(dir, 'bespoke');
  return {
    pieces: readJson(join(dir, 'pieces.json')),
    functions: readJson(join(dir, 'functions.json')),
    materials: readJson(join(dir, 'materials.json')),
    models: readJson(join(dir, 'models.json')),
    bespoke: existsSync(bespokeDir) ? readdirSync(bespokeDir).filter((f) => f.endsWith('.json')).sort().map((f) => readJson(join(bespokeDir, f))) : [],
  };
}

const cache = new Map<string, ShipgenContext>();

/** The live game data (cached per folder) */
export function loadContext(dataDir = DATA_DIR): ShipgenContext {
  const hit = cache.get(dataDir);
  if (hit) return hit;
  const tuning: ShipTuning = readJson(join(dataDir, 'ships/tuning.json'));
  const catalog = loadCatalog(readCatalogFiles(dataDir), { overlapShrink: tuning.overlapShrink });
  let econ: Economy | undefined;
  const items = join(dataDir, 'items.json'), recipes = join(dataDir, 'recipes.json');
  if (existsSync(items) && existsSync(recipes)) {
    econ = new Economy(readJson<ItemsFile>(items), readJson<RecipesFile>(recipes), catalog, {});
    econ.tuning = tuning;
  }
  const ctx: ShipgenContext = { catalog, tuning, econ, dataDir };
  cache.set(dataDir, ctx);
  return ctx;
}

/**
 * A design's file by its id: a path under data/ships/blueprints (no .json), or `samples/<name>`: shipgen's own sample
 * designs (data/shipgen/samples: the review ships, kept for the tools and their tests when they left the game)
 */
export function shipFile(dataDir: string, path: string): string {
  return path.startsWith('samples/') ? join(dataDir, 'shipgen', `${path}.json`) : join(dataDir, 'ships/blueprints', `${path}.json`);
}
