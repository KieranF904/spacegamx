/**
 * Economy: the item catalogue and recipe book built together from data, plus
 * the part bookkeeping both server and client need (what parts a design uses,
 * what a lost part costs to rebuild). Built identically on both sides from the
 * same JSON, so prices and costs always agree.
 */

import type { Catalog } from '../ships/catalog.js';
import type { ShipTuning } from '../ships/tuning.js';
import type { Blueprint, PlacedPart } from '../ships/types.js';
import { ItemCatalog, ItemsFile, partItemId } from './items.js';
import { RecipeBook, RecipesFile } from './recipes.js';
import { Bag, addBag } from './stacks.js';

export class Economy {
  readonly items: ItemCatalog;
  readonly recipes: RecipeBook;
  /** Ship tuning, when the host has it (weapon stats for part descriptions: ships/partStats.ts) */
  tuning?: ShipTuning;

  constructor(itemsFile: ItemsFile, recipesFile: RecipesFile, readonly ships: Catalog, readonly plans: Record<string, Blueprint>) {
    this.items = new ItemCatalog(itemsFile, ships);
    this.recipes = new RecipeBook(recipesFile, ships);
    this.items.priceParts((id) => this.recipes.partValue(id, this.items));
  }

  /** The item id of one placed part */
  partId(p: PlacedPart): string {
    return partItemId(p);
  }

  /** Part item counts a design uses */
  designParts(bp: Blueprint): Bag {
    const out: Bag = {};
    for (const p of bp.parts) out[partItemId(p)] = (out[partItemId(p)] ?? 0) + 1;
    return out;
  }

  /** Rebuild bill for a set of lost parts */
  rebuildBill(parts: PlacedPart[], fraction?: number): Bag {
    let bill: Bag = {};
    for (const p of parts) bill = addBag(bill, this.recipes.rebuildCost(p, this.items, fraction));
    return bill;
  }
}
