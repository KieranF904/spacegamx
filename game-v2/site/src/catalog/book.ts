/**
 * The catalog in memory: read from a file, checked, and indexed.
 *
 * Two files can feed it, newest sensible one wins:
 *   - the game's own (SITE_CATALOG_FILE, default ../data/catalog/catalog.json): written by the game later;
 *     used when it exists and has the right shape
 *   - the site's snapshot (site/catalog/catalog.json, made by scripts/build-catalog.ts)
 * Files are re-read when they change on disk.
 */

import fs from 'fs/promises';
import type {
  CatalogBoss, CatalogFile, CatalogItem, CatalogKind, CatalogPart, CatalogShip, CatalogStation, CatalogSystem,
} from './types.js';

export interface Catalog extends CatalogFile {
  /** 'game' when the game's file is in use, else 'snapshot' */
  from: 'game' | 'snapshot';
  part: Map<string, CatalogPart>;
  item: Map<string, CatalogItem>;
  ship: Map<string, CatalogShip>;
  boss: Map<string, CatalogBoss>;
  station: Map<string, CatalogStation>;
  system: Map<string, CatalogSystem>;
}

const ARRAYS = ['parts', 'items', 'ships', 'bosses', 'stations', 'systems'] as const;

/** Is this parsed JSON a catalog of the version this site reads? */
export function checkCatalog(v: unknown): v is CatalogFile {
  const f = v as Partial<CatalogFile> | null;
  if (!f || typeof f !== 'object' || f.version !== 1) return false;
  for (const k of ARRAYS) if (!Array.isArray(f[k])) return false;
  const r = f.render;
  return !!r && typeof r === 'object' && !!r.shapes && typeof r.shapes === 'object' && !!r.colors && typeof r.colors === 'object';
}

export function indexCatalog(file: CatalogFile, from: Catalog['from']): Catalog {
  const by = <T extends { id: string }>(list: T[]) => new Map(list.map((x) => [x.id, x]));
  return {
    ...file, from,
    part: by(file.parts), item: by(file.items), ship: by(file.ships), boss: by(file.bosses), station: by(file.stations), system: by(file.systems),
  };
}

export class CatalogBook {
  private cache: { sig: string; catalog: Catalog } | null = null;
  private warned = '';

  /** `snapshot`: the site's file; `gameFile`: the game's, if it writes one */
  constructor(private snapshot: string, private gameFile: string | null = null) {}

  private async read(file: string): Promise<{ sig: string; file: CatalogFile } | null> {
    try {
      const st = await fs.stat(file);
      const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
      if (!checkCatalog(parsed)) {
        if (this.warned !== file) { this.warned = file; console.warn(`[Site] ${file} is not a catalog this site can read; ignored`); }
        return null;
      }
      return { sig: `${file}:${st.mtimeMs}:${st.size}`, file: parsed };
    } catch { return null; }
  }

  /** null: neither file is there (the pages say so) */
  async get(): Promise<Catalog | null> {
    const stamps: string[] = [];
    for (const [file, from] of [[this.gameFile, 'game'], [this.snapshot, 'snapshot']] as const) {
      if (!file) continue;
      try { const st = await fs.stat(file); stamps.push(`${file}:${st.mtimeMs}:${st.size}`); } catch { continue; }
      const sig = stamps.join('|');
      if (this.cache && this.cache.sig === sig && this.cache.catalog.from === from) return this.cache.catalog;
      const r = await this.read(file);
      if (r) {
        const catalog = indexCatalog(r.file, from);
        this.cache = { sig, catalog };
        return catalog;
      }
    }
    return null;
  }
}

export const KIND_LABEL: Record<CatalogKind, string> = { parts: 'Parts', items: 'Items', ships: 'Ships', bosses: 'Bosses', stations: 'Stations' };
