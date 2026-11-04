/**
 * The item catalogue: everything a player can hold.
 *
 * Most items are listed in data/items.json. Two kinds are generated:
 *   - ship parts, `part:<material>:<fn>:<piece>`: a model's one per piece it
 *     comes in (in its own material), structure and the core one per material
 *     and piece (cost and value come from the recipes); legacy functions none
 *   - ship plans, `plan:<blueprint file>`, one per pre-made blueprint
 */

import type { Catalog } from '../ships/catalog.js';
import type { FunctionDef, WeaponMods } from '../ships/types.js';
import { weaponSizeFactor } from '../ships/grades.js';
import { sizeName } from '../ships/partStats.js';
import { dpow } from '../math/detTrig.js';

/** quest: a job's own items (worth nothing, taken back if you abandon it) */
export type ItemCategory = 'mineral' | 'gem' | 'volatile' | 'refined' | 'component' | 'artefact' | 'consumable' | 'ammo' | 'jewel' | 'part' | 'plan' | 'quest';
export type ItemRarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';

export const RARITIES: ItemRarity[] = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
export const RARITY_COLOR: Record<ItemRarity, string> = {
  common: '#c8d0dc', uncommon: '#5fd38d', rare: '#4fa3ff', epic: '#c77dff', legendary: '#ffb347',
};
export const CATEGORY_LABEL: Record<ItemCategory, string> = {
  mineral: 'Mineral', gem: 'Gem', volatile: 'Volatile', refined: 'Refined material', component: 'Component',
  artefact: 'Artefact', consumable: 'Consumable', ammo: 'Ammunition', jewel: 'Cut gem', part: 'Ship part', plan: 'Ship plan', quest: 'Job item',
};

export interface ItemDef {
  id: string;
  name: string;
  category: ItemCategory;
  rarity: ItemRarity;
  /** Base value in credits */
  value: number;
  color: string;
  description: string;
  /** Cargo space per unit (default 1) */
  volume?: number;
  /** Mass per unit in the hold (ships/load.ts); default: its category's (CATEGORY_MASS) × its volume */
  mass?: number;
  /** Parts: what to build */
  part?: { material: string; fn: string; piece: string };
  /** Plans: the blueprint file it unlocks */
  plan?: string;
  /** Job items: the job it belongs to (taken back if you abandon it) */
  quest?: string;
  /** Repair kits: credits of repairs, HP healed per second (fraction of each part's max), seconds per missing part rebuilt */
  repair?: { budget: number; hpPerSec: number; restoreSec: number };
  /** Minerals: which family of rock carries it, and the tier it first turns up in useful amounts */
  family?: MineralFamily;
  tier?: number;
  /** A trace: never mined as such, only found (at a known rate) when its family's ore is refined */
  trace?: boolean;
  /** A short name for tight spaces (the scanner's tags) */
  short?: string;
  /** Cut gems: which, and its level (econ/gems.ts) */
  socket?: { type: string; level: number };
  /** Ammunition crates: the gun it's for, volleys a crate, and what its rounds change (any of its tuning: the fire event says which crate, so clients build the same shells) */
  ammoFor?: { weapon: string; rounds: number; mods?: WeaponMods };
  /** A record (data/codex.json id) found when this first comes into the hold or storage, however it was got */
  codex?: string;
}

/**
 * Mass per unit of cargo space, by category (ships/load.ts: a full hold
 * flies heavy). Ore and metal heavy, gems and plans light, ammunition between.
 * An item's own `mass` (items.json) overrides it. A ship's own mass is about
 * its cell count, so a starter's 30-space hold of ore is about a fifth of it.
 */
export const CATEGORY_MASS: Record<ItemCategory, number> = {
  mineral: 0.1, refined: 0.09, part: 0.08, ammo: 0.06, artefact: 0.05, component: 0.04, quest: 0.04,
  consumable: 0.03, volatile: 0.03, gem: 0.01, jewel: 0.01, plan: 0,
};

/** The five families of minerals (what kind of rock carries them) */
export const MINERAL_FAMILIES = ['ferrous', 'noble', 'crystalline', 'volatile', 'exotic'] as const;
export type MineralFamily = typeof MINERAL_FAMILIES[number];

export interface ItemsFile {
  items: ItemDef[];
}

/** Display names for pieces (the ship catalogue only has ids) */
export const PIECE_NAMES: Record<string, string> = {
  sq: 'Square', rect2: 'Panel', tri: 'Wedge', slope2: 'Slope', cap: 'Nose Cap', round: 'Round',
  fillet: 'Fillet', block2: 'Block', block3: 'Long Block', round2: 'Dome', fillet2: 'Wide Fillet', nose2: 'Wedge Nose',
};
/** What each part function is called (functions.json `name`; filled when an ItemCatalog is built from the ship catalogue) */
export const FN_NAMES: Record<string, string> = {};
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function partItemId(p: { material: string; fn: string; piece: string }): string {
  return `part:${p.material}:${p.fn}:${p.piece}`;
}

export function parsePartItemId(id: string): { material: string; fn: string; piece: string } | null {
  const m = /^part:([^:]+):([^:]+):([^:]+)$/.exec(id);
  return m ? { material: m[1], fn: m[2], piece: m[3] } : null;
}

export function planItemId(file: string): string {
  return `plan:${file}`;
}

export class ItemCatalog {
  private defs = new Map<string, ItemDef>();
  private order = new Map<string, number>();

  /**
   * @param ships the ship catalogue (parts are generated from it)
   * @param plans pre-made blueprints by file name, with display names
   */
  constructor(file: ItemsFile, ships?: Catalog, plans?: Record<string, { name: string; parts: number }>) {
    for (const d of file.items) this.addDef(d);
    if (ships) {
      for (const [fnId, fn] of ships.functions) FN_NAMES[fnId] = fn.name ?? cap(fnId);
      for (const [fnId, fn] of ships.functions) {
        // (The game's own ships' parts are never items, nor the legacy functions' that models replaced)
        if (fn.exclusive || fn.legacy) continue;
        const pieces = (fn.pieces === '*' ? [...ships.pieces.keys()] : fn.pieces).filter((pc) => !ships.pieces.get(pc)?.bespoke);
        if (fn.model) {
          // A model: one item a piece, in its own material
          for (const piece of pieces) {
            const area = ships.variants.get(piece)?.[0]?.area ?? 1;
            this.addDef({
              id: partItemId({ material: fn.material!, fn: fnId, piece }),
              name: pieces.length > 1 ? `${fn.name ?? cap(fnId)} · ${PIECE_NAMES[piece] ?? piece}` : fn.name ?? cap(fnId),
              category: 'part', rarity: fn.rarity ?? 'common', value: 0, color: fn.color ?? ships.materials.get(fn.material!)?.color ?? '#9aa',
              description: fn.description ?? 'A ship part.', volume: Math.max(1, Math.round(area * 2) / 2), part: { material: fn.material!, fn: fnId, piece },
            });
          }
          continue;
        }
        for (const [mat, md] of ships.materials) {
          if (md.exclusive) continue;
          for (const piece of pieces) {
            const id = partItemId({ material: mat, fn: fnId, piece });
            const area = ships.variants.get(piece)?.[0]?.area ?? 1;
            this.addDef({
              id,
              // Weapons and generators by their size (Small .. Heavy), the rest by their shape
              name: `${cap(mat)} ${fn.name ?? cap(fnId)} · ${sizedName(ships, fn, area) ?? PIECE_NAMES[piece] ?? piece}`,
              category: 'part',
              rarity: fn.rarity ?? 'common',
              value: 0,
              color: ships.materials.get(mat)?.color ?? '#9aa',
              description: fn.description ?? 'A ship part.',
              volume: Math.max(1, Math.round(area * 2) / 2),
              part: { material: mat, fn: fnId, piece },
            });
          }
        }
      }
    }
    for (const [file, bp] of Object.entries(plans ?? {})) {
      this.addDef({
        id: planItemId(file), name: `${bp.name} Plan`, category: 'plan', rarity: bp.parts > 60 ? 'epic' : bp.parts > 25 ? 'rare' : 'uncommon',
        value: 50 * bp.parts, color: '#ffd166', description: `Ship plan: the ${bp.name} (${bp.parts} parts). Learn it to build it in the hangar.`, plan: file,
      });
    }
  }

  /** Price generated parts (from their recipes, once the recipe book exists) */
  priceParts(partValue: (id: string) => number): void {
    for (const d of this.defs.values()) if (d.category === 'part') d.value = Math.max(1, Math.round(partValue(d.id)));
  }

  private addDef(d: ItemDef): void {
    if (!this.order.has(d.id)) this.order.set(d.id, this.order.size);
    this.defs.set(d.id, d);
  }

  get(id: string): ItemDef | undefined {
    return this.defs.get(id);
  }

  has(id: string): boolean {
    return this.defs.has(id);
  }

  all(): ItemDef[] {
    return [...this.defs.values()];
  }

  /** Catalogue order (for stable sorting) */
  rank(id: string): number {
    return this.order.get(id) ?? Number.MAX_SAFE_INTEGER;
  }

  volume(id: string): number {
    return this.defs.get(id)?.volume ?? 1;
  }

  /** Mass of one unit in the hold (ships/load.ts) */
  mass(id: string): number {
    const d = this.defs.get(id);
    if (!d) return CATEGORY_MASS.component;
    return d.mass ?? CATEGORY_MASS[d.category] * (d.volume ?? 1);
  }

  /**
   * What a list of stacks weighs: the hold's cargo mass (ships/load.ts), and
   * the hook for jobs that pay by weight delivered (a hauling contract would
   * weigh what it takes with this). Rounded as flight carries it.
   */
  massOf(stacks: readonly { id: string; n: number }[]): number {
    let m = 0;
    for (const s of stacks) m += s.n * this.mass(s.id);
    return Math.round(m * 100) / 100;
  }

  name(id: string): string {
    return this.defs.get(id)?.name ?? id;
  }
}

/** "Small" .. "Heavy" for weapons, engines and generators (null for parts named by their shape) */
function sizedName(ships: Catalog, fn: FunctionDef, area: number): string | null {
  if (fn.weapon || (fn.thrust ?? 0) > 0) return sizeName(dpow(weaponSizeFactor(ships, fn, area), 1 / 1.15));
  if ((fn.produce ?? 0) > 0) return sizeName(area);
  return null;
}
