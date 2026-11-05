/**
 * Legacy parts to models (docs/parts-redesign.md §7): what pilots' ships,
 * designs and parts become now that modules are fixed named models.
 *
 * A legacy part (`fn`, `piece`, `material`) becomes a model of its function's
 * family (models.json `legacy`), the one of its size: sq, wedges and rounds
 * small, panels medium, blocks large (the nearest when the family has none
 * that size; its own piece first). On a ship it takes the part's place: the
 * same piece where the model comes in it; else as many of the model as fit
 * inside the part's cells with their business edge out where the part's was,
 * the rest of its cells hull, so the ship keeps its shape and its push. Where
 * no model fits (a wedge gun) the part becomes hull and its model goes to
 * storage. Hull, armour and cargo keep their material; conduits become hull.
 * Nothing a pilot owned is lost. Pure: the same design always comes out the same.
 */

import type { Blueprint, FunctionDef, PlacedPart, Rot, Side } from './types.js';
import type { Catalog } from './catalog.js';
import { facingEdges, placeGeometry } from './grid.js';
import { partThrust } from './grades.js';
import { partNeedsFacing } from './blueprint.js';

type Bag = Record<string, number>;

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

/** Item counts with each legacy part item as its model's (counts kept, like ids merged) */
export function migrateBag(catalog: Catalog, bag: Bag): Bag {
  const out: Bag = {};
  for (const [id, n] of Object.entries(bag)) { const to = migratePartItem(catalog, id); out[to] = (out[to] ?? 0) + n; }
  return out;
}

/**
 * What `n` of a legacy part item in a pilot's hold or storage become: never a
 * model they couldn't fit (`usable`: their level allows it).
 * The best usable model of its family by size (as legacyCandidates ranks
 * them); one smaller than the part comes as many copies as its cells hold (a
 * 2-cell generator: two Cell Reactors). With none usable, the family's
 * earliest model nearest its size, theirs the soonest. Anything else as
 * migratePartItem has it.
 */
export function migrateItemStack(catalog: Catalog, id: string, n: number, usable: (m: FunctionDef) => boolean): Bag {
  const q = /^part:([^:]+):([^:]+):([^:]+)$/.exec(id);
  const fam = q && catalog.legacyFamily.get(q[2]);
  if (!q || !fam) return { [migratePartItem(catalog, id)]: n };
  const piece = q[3];
  const cands = legacyCandidates(catalog, { fn: q[2], piece });
  if (!cands.length) return { [migratePartItem(catalog, id)]: n };
  const m = cands.find(usable) ?? [...cands].sort((a, b) => (a.unlock?.level ?? 999) - (b.unlock?.level ?? 999))[0];
  const at = modelPiece(m, piece);
  const area = (pc: string) => catalog.variants.get(pc)?.[0]?.area ?? 1;
  const copies = Math.max(1, Math.floor(area(piece) / area(at) + 1e-6));
  return { [itemOf({ material: m.material!, fn: m.id, piece: at })]: n * copies };
}

/** A bag's legacy part items as migrateItemStack has them */
export function migrateItemBag(catalog: Catalog, bag: Bag, usable: (m: FunctionDef) => boolean): Bag {
  const out: Bag = {};
  for (const [id, n] of Object.entries(bag)) for (const [to, k] of Object.entries(migrateItemStack(catalog, id, n, usable))) out[to] = (out[to] ?? 0) + k;
  return out;
}

export interface MigratedBlueprint {
  blueprint: Blueprint;
  /** Parts that weren't in the design (a second model, hull filling the rest of a part's cells) and the part each came from (uids) */
  added: { uid: number; from: number }[];
  /** Models that found no place on it (their part, by uid, became hull): to storage, if the part was built */
  refund: { uid: number; item: string }[];
  /** Did anything change */
  changed: boolean;
}

const ck = (x: number, y: number) => `${x},${y}`;
const ek = (e: [number[], number[]]) => `${e[0][0]},${e[0][1]},${e[1][0]},${e[1][1]}`;

/**
 * A design with every legacy part as its model (see above). `maxLevel`: only
 * models a pilot of that level could make (the starter's).
 */
export function migrateBlueprint(catalog: Catalog, bp: Blueprint, opts: { maxLevel?: number } = {}): MigratedBlueprint {
  const used = new Set(bp.parts.map((p) => p.uid));
  const freeUid = () => { for (let u = 0; u <= 255; u++) if (!used.has(u)) { used.add(u); return u; } return -1; };
  const parts: PlacedPart[] = [];
  const added: MigratedBlueprint['added'] = [];
  const refund: MigratedBlueprint['refund'] = [];
  let changed = false;
  for (const p of bp.parts) {
    const fn = catalog.functions.get(p.fn);
    if (!fn?.legacy) { parts.push(p); continue; }
    changed = true;
    const hull: PlacedPart = { uid: p.uid, piece: p.piece, fn: 'hull', material: p.material, x: p.x, y: p.y, rot: p.rot, flip: p.flip };
    if (p.fn === 'conduit') { parts.push(hull); continue; }
    const cands = legacyCandidates(catalog, p, opts.maxLevel);
    if (!cands.length) { parts.push(hull); continue; }
    const placed = fitModels(catalog, p, cands);
    if (!placed) {
      parts.push(hull);
      const m = cands[0];
      refund.push({ uid: p.uid, item: itemOf({ material: m.material!, fn: m.id, piece: modelPiece(m, p.piece) }) });
      continue;
    }
    placed.models.forEach((q, k) => {
      const uid = k === 0 ? p.uid : freeUid();
      if (uid < 0) return;
      parts.push({ ...q, uid });
      if (k > 0) added.push({ uid, from: p.uid });
    });
    // The rest of its cells: hull of its material
    for (const [x, y] of placed.rest) {
      const uid = freeUid();
      if (uid < 0) break;
      parts.push({ uid, piece: 'sq', fn: 'hull', material: p.material, x, y, rot: 0, flip: false });
      added.push({ uid, from: p.uid });
    }
  }
  return { blueprint: changed ? { ...bp, parts } : bp, added, refund, changed };
}

/**
 * The first candidate that fits a legacy part's place: its own piece as it
 * lay, or as many copies as fit in its (whole) cells, business edge out where
 * its was; with the cells left over. Null: none fits.
 */
function fitModels(catalog: Catalog, p: PlacedPart, cands: FunctionDef[]): { models: Omit<PlacedPart, 'uid'>[]; rest: [number, number][] } | null {
  const g = placeGeometry(catalog, p);
  for (const m of cands) {
    // (A model weapon's mount is its own, whatever the part's was)
    const mount = p.mount && !m.mount ? { mount: p.mount } : {};
    const keep = { ...(p.facing ? { facing: p.facing } : {}), ...mount, ...(p.gems?.length ? { gems: p.gems } : {}), ...(p.mods ? { mods: p.mods } : {}) };
    const facing = partNeedsFacing(m.id);
    if (facing && !p.facing) continue;
    if ((m.pieces as string[]).includes(p.piece)) {
      return { models: [{ piece: p.piece, fn: m.id, material: m.material!, x: p.x, y: p.y, rot: p.rot, flip: p.flip, ...keep }], rest: [] };
    }
    // Only a part whose cells it wholly fills has room for others' shapes
    if (Math.abs(g.area - g.cells.length) > 1e-6) continue;
    const free = new Set(g.cells.map(([x, y]) => ck(x, y)));
    const out = facing ? new Set(facingEdges(g, p.facing as Side).map(ek)) : null;
    const models: Omit<PlacedPart, 'uid'>[] = [];
    const cells = [...g.cells].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    for (const piece of m.pieces as string[]) {
      for (const [cx, cy] of cells) {
        for (const flip of [false, true]) {
          for (const rot of [0, 1, 2, 3] as Rot[]) {
            const v = catalog.variants.get(piece)?.[rot + (flip ? 4 : 0)];
            if (!v) continue;
            // Its first cell on this one
            const x = cx - v.cells[0][0], y = cy - v.cells[0][1];
            if (!v.cells.every(([vx, vy]) => free.has(ck(x + vx, y + vy)))) continue;
            // (The gems stay with the first)
            const q: Omit<PlacedPart, 'uid'> = { piece, fn: m.id, material: m.material!, x, y, rot, flip, ...(models.length ? { ...(p.facing ? { facing: p.facing } : {}), ...mount } : keep) };
            if (out) {
              const edges = facingEdges(placeGeometry(catalog, { ...q, uid: 0 }), p.facing as Side);
              if (!edges.length || !edges.every((e) => out.has(ek(e)))) continue;
            }
            models.push(q);
            for (const [vx, vy] of v.cells) free.delete(ck(x + vx, y + vy));
          }
        }
      }
    }
    if (models.length) return { models, rest: cells.filter(([x, y]) => free.has(ck(x, y))) };
  }
  return null;
}
