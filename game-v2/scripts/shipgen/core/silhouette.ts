// The outline of a ship: its exposed outer corners (a hull or armour cell with two adjacent sides open to space) and whether
// each is shaped (a wedge, a round, a nose: any piece that is not a plain rectangle). Pure geometry from the placed parts and
// the catalog's pieces: no piece or part is named. Used by the silhouette score, the staged "shape" step and the feedback.
import type { Blueprint, Side } from '../../../common/src/ships/index';
import { getVariant, placeGeometry } from '../../../common/src/ships/index';
import type { ShipgenContext } from './context';
import { pieceShapes } from './shapes';

export interface Corner {
  x: number;
  y: number;
  /** The two open sides that make it a corner (one of N/S, one of E/W) */
  open: [Side, Side];
  uid: number;
  fn: string;
  /** The part there is a shaped piece */
  shaped: boolean;
}

const OPEN: Record<Side, [number, number]> = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };

/** Structure that outlines a ship and may take any piece: hull and armour (plating models come in squares only) */
const isOutline = (_ctx: ShipgenContext, fnId: string) => fnId === 'hull' || fnId === 'armor';

/** Every exposed outer corner cell of the ship's hull and armour, reading order */
export function exposedCorners(ctx: ShipgenContext, bp: Blueprint): Corner[] {
  const owner = new Map<string, number>();
  bp.parts.forEach((p, i) => { for (const c of placeGeometry(ctx.catalog, p).cells) owner.set(`${c[0]},${c[1]}`, i); });
  const out: Corner[] = [];
  for (const [k, i] of owner) {
    const p = bp.parts[i];
    if (!isOutline(ctx, p.fn)) continue;
    const [x, y] = k.split(',').map(Number);
    const open = (['N', 'E', 'S', 'W'] as Side[]).filter((s) => !owner.has(`${x + OPEN[s][0]},${y + OPEN[s][1]}`));
    const v = open.filter((s) => s === 'N' || s === 'S'), h = open.filter((s) => s === 'E' || s === 'W');
    if (!v.length || !h.length) continue;
    out.push({ x, y, open: [v[0], h[0]], uid: p.uid, fn: p.fn, shaped: !pieceShapes(ctx.catalog, p.piece).box });
  }
  return out.sort((a, b) => a.y - b.y || a.x - b.x);
}

/** Share of the exposed outer corners that are shaped; null when the ship has no hull or armour corner */
export function silhouetteScore(ctx: ShipgenContext, bp: Blueprint): number | null {
  const c = exposedCorners(ctx, bp);
  return c.length ? c.filter((x) => x.shaped).length / c.length : null;
}

const OPPOSITE: Record<Side, Side> = { N: 'S', S: 'N', E: 'W', W: 'E' };

/** The marks of the one-cell outline shapes that cut exactly this corner: flat on the two sides that face into the ship */
function fitMarks(ctx: ShipgenContext, c: Corner): string {
  const want = [OPPOSITE[c.open[0]], OPPOSITE[c.open[1]]].sort().join('');
  const out: string[] = [];
  for (const o of outlineShapes(ctx)) {
    const s = pieceShapes(ctx.catalog, o.piece);
    if (s.classes[0].cells.length !== 1) continue;
    const cls = s.classes.find((k) => [...k.flat].sort().join('') === want);
    if (cls) out.push(`${s.letter}${cls.index}`);
  }
  return out.join(' or ');
}

/**
 * The corner cells still square, as "col,row (open N+W: use t4 or r4)" for a message. `leftOf`: only cells left of this
 * column (mirror mode: the model writes the left half, and a one-sided shape on the centre line would not mirror).
 */
export function squareCornerWords(ctx: ShipgenContext, bp: Blueprint, max = 6, leftOf?: number): string[] {
  const sq = exposedCorners(ctx, bp).filter((c) => !c.shaped && (leftOf === undefined || c.x < leftOf));
  return sq.slice(0, max).map((c) => { const fit = fitMarks(ctx, c); return `${c.x},${c.y} (open ${c.open.join('+')}${fit ? `: use ${fit}` : ''})`; });
}

/** The column of the core's left edge: what a left half's own corners lie left of */
export function coreLeftEdge(ctx: ShipgenContext, bp: Blueprint): number | undefined {
  const core = bp.parts.find((p) => p.fn === 'core');
  return core ? Math.min(...placeGeometry(ctx.catalog, core).cells.map((k) => k[0])) : undefined;
}

/**
 * The shaped pieces most use for an outline, found from the piece geometry: a one-cell wedge (about half a cell), a one-cell
 * rounded corner (most of a cell, one curved side) and the biggest piece with a single flat side (a pointed nose). Each is
 * the piece's mark letter, the digits that are its corners, and a few words.
 */
export function outlineShapes(ctx: ShipgenContext): { piece: string; letter: string; marks: string; words: string }[] {
  const out: { piece: string; letter: string; marks: string; words: string }[] = [];
  const info = ctx.catalog.pieceIds
    .map((id) => ({ id, s: pieceShapes(ctx.catalog, id) }))
    .filter(({ s }) => !s.box && !s.bespoke && s.letter && ctx.catalog.pieces.get(s.piece)?.bespoke !== true)
    .map(({ id, s }) => { const v = getVariant(ctx.catalog, id, 0, false); return { id, s, cells: v.cells.length, frac: v.area / v.cells.length }; });
  const one = info.filter((x) => x.cells === 1);
  const wedge = [...one].sort((a, b) => Math.abs(a.frac - 0.5) - Math.abs(b.frac - 0.5))[0];
  const round = [...one].filter((x) => x !== wedge && x.frac > 0.6).sort((a, b) => b.frac - a.frac)[0];
  const nose = info.filter((x) => x.cells > 1 && x.s.classes.every((c) => c.flat.length === 1)).sort((a, b) => b.cells - a.cells)[0];
  const add = (x: typeof wedge | undefined, words: string) => {
    if (!x) return;
    out.push({ piece: x.id, letter: x.s.letter!, marks: `${x.s.letter}1-${x.s.letter}${x.s.classes.length}`, words });
  };
  add(wedge, 'a cut corner (diagonal)');
  add(round, 'a rounded corner');
  add(nose, 'a pointed nose, 2x2');
  return out;
}
