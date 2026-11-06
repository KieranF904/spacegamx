/**
 * The shapes (pieces) a component comes in, shared by the component guide and the hangar palette (no DOM): which
 * pieces, in the catalog's order; the one picked by default (a square where it comes in one, else its first; a shape
 * you last used it in wins); and each shape's footprint (cells across and down, area, size word) as drawn unturned.
 */

import { PIECE_NAMES, type Catalog, type FunctionDef } from '@space-game/common';

/** Its shapes, in the catalog's piece order ('*': every piece) */
export function shapesOf(catalog: Pick<Catalog, 'pieceIds'>, fn: Pick<FunctionDef, 'pieces'>): string[] {
  if (fn.pieces === '*') return [...catalog.pieceIds];
  const known = catalog.pieceIds.filter((p) => fn.pieces.includes(p));
  // (A piece the catalog doesn't list still counts, after the known ones)
  return [...known, ...fn.pieces.filter((p) => !known.includes(p))];
}

/** The shape picked when a component goes in hand: the one you last used it in, else a square, else its first */
export function defaultShape(shapes: readonly string[], remembered?: string): string {
  if (remembered && shapes.includes(remembered)) return remembered;
  return shapes.includes('sq') ? 'sq' : shapes[0] ?? 'sq';
}

/** Small (under 1.5 cells), Medium (under 3), Large (under 7), Heavy */
export function sizeWordOf(area: number): string {
  return area < 1.5 ? 'Small' : area < 3 ? 'Medium' : area < 7 ? 'Large' : 'Heavy';
}

export interface Footprint {
  piece: string;
  /** "square", "panel"... */
  name: string;
  /** Cells across and down, unturned */
  w: number;
  h: number;
  /** Exact area in cells */
  area: number;
  /** "Small" ... "Heavy" */
  size: string;
}

/** A shape's footprint as drawn unturned (catalog variants: its first is rot 0, not mirrored) */
export function footprint(catalog: Pick<Catalog, 'variants'>, piece: string): Footprint {
  const v = catalog.variants.get(piece)?.[0];
  const xs = v?.cells.map((c) => c[0]) ?? [0], ys = v?.cells.map((c) => c[1]) ?? [0];
  const area = v?.area ?? 1;
  return {
    piece, name: PIECE_NAMES[piece] ?? piece,
    w: Math.max(...xs) - Math.min(...xs) + 1, h: Math.max(...ys) - Math.min(...ys) + 1,
    area, size: sizeWordOf(area),
  };
}

/** A footprint as turned a quarter `rot` times (across and down swap on odd turns) */
export function turned(f: Footprint, rot: number): Footprint {
  return rot % 2 ? { ...f, w: f.h, h: f.w } : f;
}

/** "1×2 · 2 cells" (area rounded to a tenth) */
export function footprintText(f: Footprint): string {
  const a = Math.round(f.area * 10) / 10;
  return `${f.w}×${f.h} · ${a} cell${a === 1 ? '' : 's'}`;
}
