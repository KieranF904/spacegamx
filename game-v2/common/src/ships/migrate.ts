/**
 * Legacy parts to models (docs/parts-redesign.md §7): the model a legacy part
 * (`fn`, `piece`, `material`) stands for now that modules are fixed named
 * models. Enemy designs still use legacy parts, so what they drop comes as
 * models (server/src/game/enemies/loot.ts migratePartItem).
 *
 * A legacy part becomes a model of its function's family (models.json
 * `legacy`), the one of its size: sq, wedges and rounds small, panels medium,
 * blocks large (the nearest when the family has none that size; its own piece
 * first). Hull, armour and cargo keep their material; conduits become hull.
 * (The pilots' saves went through the whole-ship version of this, the v4 step,
 * long since removed with the old save migrations.)
 */

import type { FunctionDef } from './types.js';
import type { Catalog } from './catalog.js';
import { partThrust } from './grades.js';

/** Each piece's size class (anything else: by its area) */
const SIZE_OF: Record<string, number> = { sq: 0, tri: 0, slope2: 0, round: 0, cap: 0, fillet: 0, rect2: 1, fillet2: 1, block2: 2, block3: 2, round2: 2, nose2: 2 };

function sizeClass(catalog: Catalog, piece: string): number {
  const s = SIZE_OF[piece];
  if (s !== undefined) return s;
  const a = catalog.variants.get(piece)?.[0]?.area ?? 1;
  return a < 1.5 ? 0 : a < 3.5 ? 1 : 2;
}

const itemOf = (p: { material: string; fn: string; piece: string }) => `part:${p.material}:${p.fn}:${p.piece}`;

/**
 * The models a legacy part could become, best first: its own piece, then its
 * size, then the nearest size (smaller first), each by unlock level. Empty:
 * not a legacy module (structure, the core, a model already). `maxLevel` keeps
 * to the models a pilot of that level could make (when the family has any).
 */
export function legacyCandidates(catalog: Catalog, p: { fn: string; piece: string }, maxLevel?: number): FunctionDef[] {
  const fam = catalog.legacyFamily.get(p.fn);
  const all = fam ? catalog.families.get(fam) ?? [] : [];
  const capped = maxLevel === undefined ? all : all.filter((m) => (m.unlock?.level ?? Infinity) <= maxLevel);
  const list = capped.length ? capped : all;
  const want = sizeClass(catalog, p.piece);
  const score = (m: FunctionDef) => {
    const pieces = m.pieces as string[];
    if (pieces.includes(p.piece)) return -1;
    const d = Math.min(...pieces.map((pc) => sizeClass(catalog, pc) - want));
    return d === 0 ? 0 : d < 0 ? -2 * d - 0.5 : 2 * d;
  };
  const own = [...list].sort((a, b) => score(a) - score(b) || (a.unlock?.level ?? 999) - (b.unlock?.level ?? 999));
  // An engine whose family has none its size: another family's engine of that size pushing nearest what it did a cell
  // (a big ion thruster is a Fusion Torch, not two little Ion Drives with hull round them)
  const fn = catalog.functions.get(p.fn);
  if (!fn?.thrust || own.some((m) => score(m) <= 0)) return own;
  const area = catalog.variants.get(p.piece)?.[0]?.area ?? 1;
  const push = partThrust(catalog, fn, area, undefined) / area;
  const others = [...catalog.functions.values()].filter((m) => m.model && (m.thrust ?? 0) > 0 && m.family !== fam
    && (maxLevel === undefined || (m.unlock?.level ?? Infinity) <= maxLevel) && (m.pieces as string[]).some((pc) => sizeClass(catalog, pc) === want))
    .sort((a, b) => Math.abs(a.thrust! - push) - Math.abs(b.thrust! - push) || (a.unlock?.level ?? 999) - (b.unlock?.level ?? 999));
  return [...others, ...own];
}

/** The model a legacy part becomes (null: it isn't a legacy module) */
export function legacyModel(catalog: Catalog, p: { fn: string; piece: string }, maxLevel?: number): FunctionDef | null {
  return legacyCandidates(catalog, p, maxLevel)[0] ?? null;
}

/** The model's piece for a legacy part's: its own if the model comes in it, else the model's first */
function modelPiece(m: FunctionDef, piece: string): string {
  const pieces = m.pieces as string[];
  return pieces.includes(piece) ? piece : pieces[0];
}

/** The item a legacy part's item becomes (a conduit's: hull; anything else as it is) */
export function migratePartItem(catalog: Catalog, id: string): string {
  const q = /^part:([^:]+):([^:]+):([^:]+)$/.exec(id);
  if (!q) return id;
  const [, material, fn, piece] = q;
  if (fn === 'conduit') return itemOf({ material, fn: 'hull', piece });
  const m = legacyModel(catalog, { fn, piece });
  return m ? itemOf({ material: m.material!, fn: m.id, piece: modelPiece(m, piece) }) : id;
}
