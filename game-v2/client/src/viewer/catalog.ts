/**
 * The viewer's data, standalone (no server): the piece catalog as the game and the hull worker load it, every
 * blueprint under data/ships/blueprints (enemy/ and dev/ too), and the browse list. Vite only (import.meta.glob).
 */

import { loadCatalog, parseBlueprint, type Blueprint, type Catalog, type ShipTuning } from '@space-game/common';
import shipPieces from '../../../data/ships/pieces.json';
import shipFunctions from '../../../data/ships/functions.json';
import shipMaterials from '../../../data/ships/materials.json';
import shipModels from '../../../data/ships/models.json';
import shipTuning from '../../../data/ships/tuning.json';
import { listAssets, type AssetEntry, type AssetSources } from './assets';
import { usesBespoke } from './builders';

export interface ViewerData {
  catalog: Catalog;
  tuning: ShipTuning;
  ships: Map<string, Blueprint>;
  assets: AssetEntry[];
}

export function loadViewerData(): ViewerData {
  const tuning = shipTuning as unknown as ShipTuning;
  const bespoke = Object.values(import.meta.glob('../../../data/ships/bespoke/*.json', { eager: true, import: 'default' }));
  const catalog = loadCatalog({ pieces: shipPieces, functions: shipFunctions, materials: shipMaterials, models: shipModels, bespoke } as never, { overlapShrink: tuning.overlapShrink });
  const files = import.meta.glob('../../../data/ships/blueprints/**/*.json', { eager: true, import: 'default' }) as Record<string, unknown>;
  const ships = new Map<string, Blueprint>();
  const blueprints: AssetSources['blueprints'] = [];
  for (const [file, json] of Object.entries(files)) {
    const path = file.replace(/^.*\/blueprints\//, '').replace(/\.json$/, '');
    try {
      const bp = parseBlueprint(JSON.stringify(json));
      ships.set(path, bp);
      blueprints.push({ path, name: bp.name, bespoke: usesBespoke(catalog, bp), rigid: !!bp.rigid, parts: bp.parts.length });
    } catch (e) {
      console.warn('[viewer] skipped blueprint', path, e);
    }
  }
  const models = [...catalog.functions.values()].filter((f) => f.model).map((f) => ({ id: f.id, name: f.name, family: f.family, mount: f.mount, category: f.category, rarity: f.rarity }));
  const materials = [...catalog.materials.values()].map((m) => ({ id: m.id, name: m.name, grade: m.grade }));
  const pieces = [...catalog.pieces.values()].filter((p) => !p.bespoke).map((p) => ({ id: p.id, tier: p.tier }));
  return { catalog, tuning, ships, assets: listAssets({ blueprints, models, materials, pieces }) };
}
