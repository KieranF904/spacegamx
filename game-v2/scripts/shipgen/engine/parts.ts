// What the page draws for a part: its category (colour and timelapse stage, from the power core's role, then the
// structure function) and its grid cells. Derived from the catalog, so a new part needs no edit here.
import type { Blueprint, PlacedPart } from '../../../common/src/ships/index';
import { placeGeometry } from '../../../common/src/ships/index';
import { type LegendEntry, type ShipgenContext, buildLegend, partPower, shapeOfPart } from '../core/index';

export type Category =
  | 'core' | 'generator' | 'dynamo' | 'store' | 'conduit' | 'diode'
  | 'weapon' | 'thruster' | 'tool' | 'armour' | 'hull' | 'cargo' | 'other';

export function categoryOf(ctx: ShipgenContext, p: Pick<PlacedPart, 'fn' | 'piece' | 'material'>): Category {
  const fn = ctx.catalog.functions.get(p.fn);
  if (!fn) return 'other';
  if (p.fn === 'core') return 'core';
  let role: string = 'none';
  try { role = partPower(ctx, fn, p.piece, p.material).role; } catch { /* (a piece the core can't place) */ }
  if (role !== 'none') return role as Category;
  if (/armou?r/.test(p.fn)) return 'armour';
  if (/cargo/.test(p.fn)) return 'cargo';
  if (/hull/.test(p.fn)) return 'hull';
  return 'other';
}

/** [row, col] of every cell a part covers, as the grid draws it */
export function cellsOf(ctx: ShipgenContext, p: PlacedPart): [number, number][] {
  try {
    const { cls, at } = shapeOfPart(ctx.catalog, p);
    if (cls) return cls.cells.map((c) => [c[1] + at[1], c[0] + at[0]] as [number, number]);
  } catch { /* fall through */ }
  try { return placeGeometry(ctx.catalog, p).cells.map((c) => [Math.round(c[1]), Math.round(c[0])] as [number, number]); } catch { return []; }
}

export function partCells(ctx: ShipgenContext, bp: Blueprint): Record<number, [number, number][]> {
  const out: Record<number, [number, number][]> = {};
  for (const p of bp.parts) out[p.uid] = cellsOf(ctx, p);
  return out;
}

export interface LegendRow { code: string; name: string; cat: Category; fn: string; material: string; level: number; kind: LegendEntry['kind'] }

/** The legend, as the page colours it */
export function legendRows(ctx: ShipgenContext): LegendRow[] {
  return buildLegend(ctx).entries.map((e) => ({
    code: e.code, name: e.name, fn: e.fn, material: e.material, level: e.level, kind: e.kind,
    cat: categoryOf(ctx, { fn: e.fn, piece: e.pieces[0] ?? 'sq', material: e.material }),
  }));
}
