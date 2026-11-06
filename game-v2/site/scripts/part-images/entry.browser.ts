/**
 * Runs in headless Chrome (scripts/build-part-images.mjs bundles it with esbuild): draws every component guide row's
 * picture and every item's icon with the game client's own drawing code (client/src/ui/componentSprites.ts and
 * itemIcons.ts), and collects the guide's short lines the data files don't hold (trade-off, mounting, size, key
 * numbers) and the structure rows (one per material). Never the game's descriptions: no lore leaves here.
 *
 * Not part of the site's typecheck (tsconfig excludes this folder): it is client code, bundled for a browser.
 */

import { Economy, loadCatalog, markName, partStats, registerAmmo, setUnlockTable, type ItemsFile, type RecipesFile, type ShipTuning, type UnlockTable } from '@space-game/common';
import shipPieces from '../../../data/ships/pieces.json';
import shipFunctions from '../../../data/ships/functions.json';
import shipMaterials from '../../../data/ships/materials.json';
import shipModels from '../../../data/ships/models.json';
import shipTuning from '../../../data/ships/tuning.json';
import itemsData from '../../../data/items.json';
import recipesData from '../../../data/recipes.json';
import unlockData from '../../../data/unlocks.json';
import { partSprite, type SpritePart } from '../../../client/src/ui/componentSprites';
import { itemIcon } from '../../../client/src/ui/itemIcons';
import { guideRows, rowItemId, STRUCTURE_FNS, teachKeys, COMP_TABS, type CompRow } from '../../../client/src/ui/componentGuide';
import { PLATES } from '../../../client/src/ui/componentData';
import { familyLabel, keyStats, mountingText, sizeText, tradeOff } from '../../../client/src/ships/modelCards';

/** The rows' pictures at this share of the size the game draws them (the game's are 2x: this keeps them sharp on a 2x screen at half size) */
const PART_SCALE = 0.5;
const WEBP_QUALITY = 0.9;

interface Out { file: string; data: string }

async function reencode(url: string, scale: number): Promise<{ data: string; w: number; h: number }> {
  const img = new Image();
  img.src = url;
  await img.decode();
  const w = Math.max(1, Math.round(img.naturalWidth * scale)), h = Math.max(1, Math.round(img.naturalHeight * scale));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d')!;
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, 0, 0, w, h);
  return { data: c.toDataURL('image/webp', WEBP_QUALITY), w, h };
}

const fileId = (id: string) => id.replace(/[^a-z0-9_-]+/gi, '-');

export async function run(bespoke: unknown[]): Promise<{ files: Out[]; guide: unknown }> {
  const tuning = shipTuning as unknown as ShipTuning;
  const catalog = loadCatalog({ pieces: shipPieces, functions: shipFunctions, materials: shipMaterials, models: shipModels, bespoke } as never, { overlapShrink: (tuning as { overlapShrink?: number }).overlapShrink });
  const econ = new Economy(itemsData as unknown as ItemsFile, recipesData as unknown as RecipesFile, catalog, {});
  econ.tuning = tuning;
  setUnlockTable(unlockData as unknown as Partial<UnlockTable>);
  registerAmmo(econ.items.all());

  const files: Out[] = [];
  const rows: Record<string, unknown>[] = [];
  const spriteParts = (r: CompRow): SpritePart[] =>
    r.kind === 'structure' ? STRUCTURE_FNS.map((fn, i) => ({ fn, material: r.material, piece: 'sq', x: i * 1.15, y: 0 })) : [{ fn: r.fn, material: r.material, piece: r.piece }];

  for (const r of guideRows(catalog, PLATES)) {
    const s = partSprite(catalog, spriteParts(r));
    // (The sprite's CSS size is half its pixels: the game draws at 2x)
    const pic = await reencode(s.url, PART_SCALE);
    const name = `parts/${fileId(r.id.replace('structure:', 'structure-'))}.webp`;
    files.push({ file: name, data: pic.data });
    const fn = catalog.functions.get(r.fn)!;
    const row: Record<string, unknown> = {
      id: r.id, tab: r.tab, kind: r.kind, name: r.name, level: r.level, order: r.order, fn: r.fn, material: r.material, piece: r.piece,
      art: { src: `/static/img/${name}`, w: pic.w, h: pic.h },
      licence: teachKeys(r).length > 0,
    };
    if (r.kind === 'structure') {
      const m = catalog.materials.get(r.material)!;
      row.structure = {
        materialName: m.name ?? m.id, mark: markName(m.grade ?? 1), grade: m.grade ?? 1, toughness: m.toughness, density: m.density,
        traits: (m.traits ?? []).map((t: string) => t.replace(/_/g, ' ')), insulation: m.insulation ?? 0,
        parts: [...STRUCTURE_FNS, 'core'].flatMap((f) => {
          const st = partStats(catalog, tuning, { fn: f, material: r.material, piece: 'sq' });
          if (!st) return [];
          return [{ fn: f, name: catalog.functions.get(f)?.name ?? f, hp: Math.round(st.hp), armour: st.armour, mass: Math.round(st.mass * 10) / 10, cost: econ.recipes.partInputs({ material: r.material, fn: f, piece: 'sq' }) }];
        }),
      };
    } else {
      // (The trade-off line, never the description it falls back on: descriptions carry the game's voice)
      const t = tradeOff({ ...fn, description: undefined });
      if (t) row.tradeOff = t;
      if (r.kind === 'model') row.family = familyLabel(fn);
      row.size = r.kind === 'model' ? sizeText(catalog, fn) : undefined;
      const key = keyStats(catalog, tuning, fn, r.piece, r.material);
      if (key) row.keyNumbers = key;
      const words = mountingText(catalog, { fn: fn.id });
      if (words.length) row.mounting = words;
      const rec = econ.recipes.recipeFor(rowItemId(r));
      row.cost = r.kind === 'model' ? rec?.inputs ?? {} : econ.recipes.partInputs({ material: r.material, fn: r.fn, piece: r.piece });
      if (rec) row.seconds = rec.time;
    }
    rows.push(row);
  }

  const items: Record<string, string> = {};
  for (const it of (itemsData as unknown as { items: { id: string }[] }).items) {
    const pic = await reencode(itemIcon(econ, it.id), 0.5);
    const name = `items/${fileId(it.id)}.webp`;
    files.push({ file: name, data: pic.data });
    items[it.id] = `/static/img/${name}`;
  }

  return { files, guide: { version: 1, tabs: COMP_TABS.map((t) => ({ id: t.id, label: t.label })), rows, items } };
}


(window as unknown as { runPartImages: typeof run }).runPartImages = run;
