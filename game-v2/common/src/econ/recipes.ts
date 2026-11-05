/**
 * Recipes (data/recipes.json): refining, ship part costs and fabricator
 * recipes, plus the cost arithmetic everything else uses: what a part costs to
 * make, what minerals that comes to, and what a rebuild bill is.
 */

import type { Catalog } from '../ships/catalog.js';
import type { ItemCatalog } from './items.js';
import { parsePartItemId, partItemId } from './items.js';
import { gradeOf } from '../ships/grades.js';
import type { Bag } from './stacks.js';

/** `time`: seconds per batch (refining always takes a while; default 2) */
/** `level`: the pilot level it needs (alloying, hazard plating) */
export interface RefineRecipe { id: string; inputs: Bag; out: number; time?: number; level?: number }
/**
 * `level`: the pilot level it opens at (every recipe that isn't a starter has one);
 * `quest`: a job's own kit, also learned during it (a craft step's `teach`) and only shown while it's on
 */
export interface CraftRecipe { id: string; out: Bag; inputs: Bag; time: number; starter?: boolean; level?: number; quest?: string }
export interface PartRules {
  plates: Record<string, string>;
  platesPerArea: number;
  /** Multiplies platesPerArea, by grade (index 1 = Mk I): the top grades take far more */
  platesPerAreaByGrade?: number[];
  /** Multiplies fabrication time, by grade */
  timeByGrade?: number[];
  /** Per function: extra items per cell of area; "plate" means the part's own material plate */
  extras: Record<string, Record<string, number>>;
  instantMaxArea: number;
  secondsPerArea: number;
  rebuildFraction: number;
}
/** A model's own recipe (scripts/econ/models.mjs): what one takes, and how long (`perCell`: per cell of its piece, for models in more than one size) */
export interface ModelRecipe { inputs: Bag; time: number; perCell?: boolean }
export interface RecipesFile { refining: RefineRecipe[]; parts: PartRules; craft: CraftRecipe[]; models?: Record<string, ModelRecipe> }

export class RecipeBook {
  readonly refining = new Map<string, RefineRecipe>();
  readonly craft = new Map<string, CraftRecipe>();
  readonly parts: PartRules;
  readonly models = new Map<string, ModelRecipe>();

  constructor(file: RecipesFile, private ships: Catalog) {
    for (const r of file.refining) this.refining.set(r.id, r);
    for (const r of file.craft) this.craft.set(r.id, r);
    for (const [id, r] of Object.entries(file.models ?? {})) this.models.set(id, r);
    this.parts = file.parts;
  }

  /** A model's recipe for one part of this piece (null: not a model) */
  private modelRecipe(p: { fn: string; piece: string }): ModelRecipe | null {
    const r = this.models.get(p.fn);
    if (!r) return null;
    if (!r.perCell) return r;
    const area = this.ships.variants.get(p.piece)?.[0]?.area ?? 1;
    const inputs: Bag = {};
    for (const [id, n] of Object.entries(r.inputs)) inputs[id] = Math.max(1, Math.ceil(n * area - 1e-9));
    return { inputs, time: Math.round(r.time * Math.max(1, area)) };
  }

  /** What one part costs to fabricate: a model's recipe, else plate of its material and its function's extras */
  partInputs(p: { material: string; fn: string; piece: string }): Bag {
    const own = this.modelRecipe(p);
    if (own) return { ...own.inputs };
    const area = this.ships.variants.get(p.piece)?.[0]?.area ?? 1;
    const plate = this.parts.plates[p.material];
    const out: Bag = {};
    const add = (id: string, perArea: number) => { if (id && perArea > 0) out[id] = (out[id] ?? 0) + perArea * area; };
    const g = gradeOf(this.ships.materials.get(p.material));
    add(plate, this.parts.platesPerArea * (this.parts.platesPerAreaByGrade?.[g] ?? 1));
    for (const [id, n] of Object.entries(this.parts.extras[p.fn] ?? {})) add(id === 'plate' ? plate : id, n);
    for (const id of Object.keys(out)) out[id] = Math.max(1, Math.ceil(out[id] - 1e-9));
    return out;
  }

  /** Fabrication time for a part, seconds (0 = instant) */
  partTime(p: { piece: string; fn: string; material?: string }): number {
    const own = this.modelRecipe(p);
    if (own) return own.time;
    const area = this.ships.variants.get(p.piece)?.[0]?.area ?? 1;
    const g = p.material ? gradeOf(this.ships.materials.get(p.material)) : 1;
    if (p.fn !== 'core' && g <= 2 && area <= this.parts.instantMaxArea + 1e-9) return 0;
    return Math.round(this.parts.secondsPerArea * area * (p.fn === 'core' ? 6 : 1) * (this.parts.timeByGrade?.[g] ?? 1));
  }

  /** A fabricator recipe for any craftable output: listed recipes, or a generated part recipe */
  recipeFor(id: string): CraftRecipe | null {
    const listed = this.craft.get(id);
    if (listed) return listed;
    const part = parsePartItemId(id);
    const fn = part && this.ships.functions.get(part.fn);
    // (Legacy functions aren't made any more; a model only in its own material and pieces)
    if (fn?.legacy || (fn?.model && (part!.material !== fn.material || !(fn.pieces as string[]).includes(part!.piece)))) return null;
    if (part && this.ships.materials.has(part.material) && fn && this.ships.pieces.has(part.piece)) {
      return { id, out: { [id]: 1 }, inputs: this.partInputs(part), time: this.partTime(part) };
    }
    return null;
  }

  /** Expand refined materials back to the raw items they're made from (fractional) */
  raw(bag: Bag): Bag {
    const out: Bag = {};
    const visit = (id: string, n: number, depth: number) => {
      const r = this.refining.get(id);
      if (!r || depth > 4) { out[id] = (out[id] ?? 0) + n; return; }
      for (const [inId, k] of Object.entries(r.inputs)) visit(inId, (n / r.out) * k, depth + 1);
    };
    for (const [id, n] of Object.entries(bag)) visit(id, n, 0);
    return out;
  }

  /**
   * Rebuild bill for a lost part: a share of the common minerals it was made
   * from. Gems, components and artefacts are never charged again.
   */
  rebuildCost(p: { material: string; fn: string; piece: string }, items: ItemCatalog, fraction = this.parts.rebuildFraction): Bag {
    const raw = this.raw(this.partInputs(p));
    const out: Bag = {};
    for (const [id, n] of Object.entries(raw)) {
      if (items.get(id)?.category !== 'mineral') continue;
      const k = Math.ceil(n * fraction - 1e-9);
      if (k > 0) out[id] = k;
    }
    return out;
  }

  /** Credit value of an item made by a recipe: its raw inputs' value plus a margin */
  valueOf(bag: Bag, items: ItemCatalog, margin = 1.25): number {
    let v = 0;
    for (const [id, n] of Object.entries(this.raw(bag))) v += (items.get(id)?.value ?? 0) * n;
    return v * margin;
  }

  partValue(id: string, items: ItemCatalog): number {
    const p = parsePartItemId(id);
    return p ? this.valueOf(this.partInputs(p), items) : 0;
  }
}

export { partItemId };
