// Every piece's distinct shapes on the grid: its 8 variants (catalog getVariant) grouped by the geometry they cover, so a
// grid token names a shape, never a rot/flip that looks the same. Derived from the catalog: a new piece needs no edit.
import type { Catalog, PieceVariant, PlacedPart, Side, Vec2 } from '../../../common/src/ships/index';
import { getVariant } from '../../../common/src/ships/index';

export interface ShapeClass {
  piece: string;
  /** 1-based, in variant order: the digit a token writes */
  index: number;
  /** The first variant (rot + flip*4) with this geometry: the one a decoded part gets */
  variant: number;
  /** The variant's top-left cell (topmost, then leftmost), in its own coordinates */
  tl: Vec2;
  /** Cells relative to the top-left cell */
  cells: Vec2[];
  /** Geometry key (polygon vertices relative to the top-left cell) */
  key: string;
  /** Sides of its cell box it has a full straight edge on */
  flat: Side[];
}

export interface PieceShapes {
  piece: string;
  /** Fills its cells exactly as a rectangle (sq, rect2, block2, block3): the cells alone say its shape */
  box: boolean;
  bespoke: boolean;
  /** Its letter in a shape mark ("t" for tri), unique; bespoke pieces have none. A box piece's mark is optional */
  letter?: string;
  classes: ShapeClass[];
}

const EPS = 1e-6;
const r4 = (v: number) => Math.round(v * 1e4) / 1e4 + 0;

/** Top-left cell of a cell list: smallest y, then smallest x */
export function topLeft(cells: readonly Vec2[]): Vec2 {
  let best = cells[0];
  for (const c of cells) if (c[1] < best[1] || (c[1] === best[1] && c[0] < best[0])) best = c;
  return [best[0], best[1]];
}

export function polygonKey(points: readonly Vec2[], ox: number, oy: number): string {
  const set = new Set(points.map((p) => `${r4(p[0] - ox)},${r4(p[1] - oy)}`));
  return [...set].sort().join(' ');
}

function flatSides(v: PieceVariant): Side[] {
  const xs = v.cells.map((c) => c[0]), ys = v.cells.map((c) => c[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs) + 1, y0 = Math.min(...ys), y1 = Math.max(...ys) + 1;
  const along = (horiz: boolean, at: number, len: number) => {
    let sum = 0;
    for (const l of v.lines) {
      if (horiz && Math.abs(l.a[1] - at) < EPS && Math.abs(l.b[1] - at) < EPS) sum += Math.abs(l.b[0] - l.a[0]);
      if (!horiz && Math.abs(l.a[0] - at) < EPS && Math.abs(l.b[0] - at) < EPS) sum += Math.abs(l.b[1] - l.a[1]);
    }
    return sum >= len - EPS;
  };
  const out: Side[] = [];
  if (along(true, y0, x1 - x0)) out.push('N');
  if (along(false, x1, y1 - y0)) out.push('E');
  if (along(true, y1, x1 - x0)) out.push('S');
  if (along(false, x0, y1 - y0)) out.push('W');
  return out;
}

function isBox(v: PieceVariant): boolean {
  const xs = v.cells.map((c) => c[0]), ys = v.cells.map((c) => c[1]);
  const w = Math.max(...xs) - Math.min(...xs) + 1, h = Math.max(...ys) - Math.min(...ys) + 1;
  return Math.abs(v.area - v.cells.length) < 1e-3 && w * h === v.cells.length;
}

const cacheOf = new WeakMap<Catalog, Map<string, PieceShapes>>();

function letters(catalog: Catalog): Map<string, string> {
  // (Player pieces in catalog order, shaped ones first, each the first free letter of its id; 'v' is the south facing mark)
  const out = new Map<string, string>(), used = new Set<string>(['v']);
  const ids = catalog.pieceIds.filter((id) => !isBox(getVariant(catalog, id, 0, false)));
  ids.push(...catalog.pieceIds.filter((id) => !ids.includes(id)));
  for (const id of ids) {
    const pick = [...id.toLowerCase()].find((c) => /[a-z]/.test(c) && !used.has(c)) ?? [...'abcdefghijklmnopqrstuwxyz'].find((c) => !used.has(c));
    if (!pick) continue;
    used.add(pick);
    out.set(id, pick);
  }
  return out;
}

export function pieceShapes(catalog: Catalog, piece: string): PieceShapes {
  let m = cacheOf.get(catalog);
  if (!m) {
    m = new Map();
    cacheOf.set(catalog, m);
    const ls = letters(catalog);
    for (const id of catalog.pieces.keys()) m.set(id, buildShapes(catalog, id, ls.get(id)));
  }
  const s = m.get(piece);
  if (!s) throw new Error(`unknown piece "${piece}"`);
  return s;
}

function buildShapes(catalog: Catalog, piece: string, letter: string | undefined): PieceShapes {
  const bespoke = !!catalog.pieces.get(piece)!.bespoke;
  const classes: ShapeClass[] = [];
  for (let vi = 0; vi < 8; vi++) {
    const v = getVariant(catalog, piece, (vi % 4) as 0 | 1 | 2 | 3, vi >= 4);
    const tl = topLeft(v.cells);
    const key = polygonKey(v.polygon, tl[0], tl[1]) + '|' + v.cells.map((c) => `${c[0] - tl[0]},${c[1] - tl[1]}`).sort().join(' ');
    if (classes.some((c) => c.key === key)) continue;
    classes.push({ piece, index: classes.length + 1, variant: vi, tl, cells: v.cells.map((c) => [c[0] - tl[0], c[1] - tl[1]]), key, flat: flatSides(v) });
  }
  const box = !bespoke && isBox(getVariant(catalog, piece, 0, false));
  return { piece, box, bespoke, ...(letter ? { letter } : {}), classes };
}

/** Every piece's shapes (the catalog's, bespoke included) */
export function allShapes(catalog: Catalog): PieceShapes[] {
  pieceShapes(catalog, catalog.pieceIds[0]);
  return [...cacheOf.get(catalog)!.values()];
}

/** The piece a token's shape letter names */
export function pieceOfLetter(catalog: Catalog, letter: string): string | undefined {
  return allShapes(catalog).find((s) => s.letter === letter)?.piece;
}

/** A placed part's shape, and its top-left cell on the ship */
export function shapeOfPart(catalog: Catalog, p: Pick<PlacedPart, 'piece' | 'rot' | 'flip' | 'x' | 'y'>): { cls: ShapeClass; at: Vec2 } {
  const s = pieceShapes(catalog, p.piece);
  const v = getVariant(catalog, p.piece, p.rot, p.flip);
  const tl = topLeft(v.cells);
  const key = polygonKey(v.polygon, tl[0], tl[1]) + '|' + v.cells.map((c) => `${c[0] - tl[0]},${c[1] - tl[1]}`).sort().join(' ');
  const cls = s.classes.find((c) => c.key === key)!;
  return { cls, at: [p.x + tl[0], p.y + tl[1]] };
}

/** The part a shape class makes with its top-left cell at `at` */
export function placeShape(cls: ShapeClass, at: Vec2): { rot: 0 | 1 | 2 | 3; flip: boolean; x: number; y: number } {
  return { rot: (cls.variant % 4) as 0 | 1 | 2 | 3, flip: cls.variant >= 4, x: at[0] - cls.tl[0], y: at[1] - cls.tl[1] };
}

/** The shape class that is `cls` mirrored left-right */
export function mirrorShape(catalog: Catalog, cls: ShapeClass): ShapeClass {
  const s = pieceShapes(catalog, cls.piece);
  const v = getVariant(catalog, cls.piece, (cls.variant % 4) as 0 | 1 | 2 | 3, cls.variant >= 4);
  const cells: Vec2[] = v.cells.map((c) => [-c[0] - 1, c[1]]);
  const tl = topLeft(cells);
  const key = polygonKey(v.polygon.map((p) => [-p[0], p[1]] as Vec2), tl[0], tl[1]) + '|' + cells.map((c) => `${c[0] - tl[0]},${c[1] - tl[1]}`).sort().join(' ');
  return s.classes.find((c) => c.key === key) ?? cls;
}

/** "flat on W+S" */
export function shapeWords(cls: ShapeClass): string {
  const xs = cls.cells.map((c) => c[0]), ys = cls.cells.map((c) => c[1]);
  const size = cls.cells.length > 1 ? `${Math.max(...xs) - Math.min(...xs) + 1}x${Math.max(...ys) - Math.min(...ys) + 1} ` : '';
  return size + (cls.flat.length ? `flat on ${cls.flat.join('+')}` : 'no flat side');
}
