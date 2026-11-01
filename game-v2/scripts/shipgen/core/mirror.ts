// Mirror mode: the model draws the LEFT half of the ship and the parts on its centre line (the line through the middle of
// the core); the tool adds the right half as the mirror image (mirrorPart: facings E and W swap, left- and right-handed
// shaped pieces swap via mirrorShape). With mirror mode off, asymmetricCells names the exact cells that have no twin.
import type { Blueprint, PlacedPart } from '../../../common/src/ships/index';
import { placeGeometry } from '../../../common/src/ships/index';
import type { ShipgenContext } from './context';
import { CodeBook, type GridError, coreAxis2, mirrorPart, partAt, partKey } from './grid';

export interface HalfResult {
  /** The whole ship (left half, centre line, and the mirror of the left half) */
  bp?: Blueprint;
  /** Twice the centre line's x */
  axis2: number;
  errors: GridError[];
  warnings: string[];
}

const cellsOf = (ctx: ShipgenContext, p: PlacedPart) => placeGeometry(ctx.catalog, p).cells;

/** Which side of the centre line a part is on: left, right, or across it (on it) */
export function sideOf(ctx: ShipgenContext, p: PlacedPart, axis2: number): 'left' | 'right' | 'centre' {
  const xs = cellsOf(ctx, p).map((c) => c[0]);
  if (Math.max(...xs) + 1 <= axis2 / 2) return 'left';
  if (Math.min(...xs) >= axis2 / 2) return 'right';
  return 'centre';
}

/** The centre line of a drawn half: the middle of the core, or (no core) the rightmost column drawn */
export function halfAxis2(ctx: ShipgenContext, bp: Blueprint): number {
  if (bp.parts.some((p) => p.fn === 'core')) return coreAxis2(ctx, bp);
  let x1 = 0;
  try { x1 = Math.max(...bp.parts.flatMap((p) => cellsOf(ctx, p).map((c) => c[0]))); } catch { /* (unknown parts) */ }
  return Number.isFinite(x1) ? 2 * x1 + 1 : 1;
}

/** The left half and centre line of a whole ship (what a model writes in mirror mode) */
export function halfOf(ctx: ShipgenContext, bp: Blueprint, axis2 = coreAxis2(ctx, bp)): Blueprint {
  return { ...bp, parts: bp.parts.filter((p) => { try { return sideOf(ctx, p, axis2) !== 'right'; } catch { return true; } }).map((p, uid) => ({ ...p, uid })) };
}

/**
 * The whole ship from a drawn half. Forgiving: a part drawn right of the centre line that is already the mirror of a left
 * part is dropped (the tool draws it); one whose mirror cells are free is mirrored to the left too; one that clashes is an
 * error. A part across the centre line must be its own mirror image.
 */
export function mirrorHalf(ctx: ShipgenContext, drawn: Blueprint, opts: { axis2?: number; book?: CodeBook } = {}): HalfResult {
  const axis2 = opts.axis2 ?? halfAxis2(ctx, drawn);
  // (No core: no centre line to mirror about; the check says the core is missing)
  if (opts.axis2 === undefined && !drawn.parts.some((p) => p.fn === 'core')) return { bp: drawn, axis2, errors: [], warnings: ['no core, so nothing was mirrored: the centre line runs down the middle of the core'] };
  const book = opts.book ?? new CodeBook(ctx);
  const errors: GridError[] = [], warnings: string[] = [];
  const label = (p: PlacedPart) => { const a = partAt(ctx, p); let code = p.fn; try { code = book.codeFor(p).code; } catch { /* (unknown) */ } return { ...a, text: `${code} at row ${a.row} col ${a.col}` }; };
  const out: PlacedPart[] = [];
  const owner = new Map<string, number>();
  const put = (p: PlacedPart): number | null => {
    let cells;
    try { cells = cellsOf(ctx, p); } catch { out.push(p); return null; }
    const hit = cells.map((c) => owner.get(`${c[0]},${c[1]}`)).find((i) => i !== undefined);
    if (hit !== undefined) return hit;
    out.push(p);
    for (const c of cells) owner.set(`${c[0]},${c[1]}`, out.length - 1);
    return null;
  };
  const left: PlacedPart[] = [], right: PlacedPart[] = [];
  for (const p of drawn.parts) {
    let side;
    try { side = sideOf(ctx, p, axis2); } catch { out.push(p); continue; }
    if (side === 'right') { right.push(p); continue; }
    if (side === 'centre') {
      const m = mirrorPart(ctx, p, axis2);
      if (partKey(ctx, m) !== partKey(ctx, p)) {
        const l = label(p);
        errors.push({ row: l.row, col: l.col, message: `${l.text} crosses the centre line (the middle of the core) but isn't the same mirrored: a part on the centre line must be symmetric (facing ^ or v, the same width each side); else draw it wholly on the left` });
        continue;
      }
      if (put(p) !== null) { const l = label(p); errors.push({ row: l.row, col: l.col, message: `${l.text} overlaps another part` }); }
      continue;
    }
    left.push(p);
  }
  for (const p of left) {
    const clash = put(p);
    if (clash !== null) { const l = label(p), o = label(out[clash]); errors.push({ row: l.row, col: l.col, message: `${l.text} overlaps ${o.text}: move one` }); continue; }
    const m = mirrorPart(ctx, p, axis2);
    const c2 = put(m);
    if (c2 !== null) { const l = label(p), o = label(out[c2]); errors.push({ row: l.row, col: l.col, message: `${l.text}'s mirror image lands on ${o.text}, which is on the centre line: move it left` }); }
  }
  let dup = 0;
  for (const p of right) {
    const key = partKey(ctx, p);
    const cells = cellsOf(ctx, p);
    const same = cells.every((c) => { const i = owner.get(`${c[0]},${c[1]}`); return i !== undefined && partKey(ctx, out[i]) === key; });
    if (same) { dup++; continue; }
    const m = mirrorPart(ctx, p, axis2);
    const l = label(p);
    if (cells.some((c) => owner.has(`${c[0]},${c[1]}`)) || cellsOf(ctx, m).some((c) => owner.has(`${c[0]},${c[1]}`))) {
      const o = cells.map((c) => owner.get(`${c[0]},${c[1]}`)).find((i) => i !== undefined);
      // (The left half wins: a right-half part that clashes with its mirror is dropped, with a note)
      warnings.push(`${l.text} is right of the centre line, where the mirror of your left half goes${o !== undefined ? ` (${label(out[o]).text})` : ''}: dropped; the left half wins (draw only the left half and the centre line)`);
      continue;
    }
    put(p); put(m);
    warnings.push(`${l.text} is right of the centre line: I mirrored it to the left as well (draw only the left half; the right half is drawn for you)`);
  }
  if (dup) warnings.push(`you drew ${dup} part(s) right of the centre line that are the mirror of your left half: fine, but you only need the left half`);
  if (errors.length) return { axis2, errors, warnings };
  return { bp: { ...drawn, parts: out.map((p, uid) => ({ ...p, uid })) }, axis2, errors, warnings };
}

/**
 * Cells that differ from their mirror image across the core's centre line: "row 2: col -3 is HA, col 4 is empty".
 * Empty when the ship is symmetric.
 */
export function asymmetricCells(ctx: ShipgenContext, bp: Blueprint, opts: { axis2?: number; book?: CodeBook } = {}): { row: number; col: number; message: string }[] {
  const axis2 = opts.axis2 ?? coreAxis2(ctx, bp);
  const book = opts.book ?? new CodeBook(ctx);
  const owner = new Map<string, number>();
  const keys: string[] = [], mirrorKeys: string[] = [], codes: string[] = [];
  bp.parts.forEach((p, i) => {
    let cells;
    try { cells = cellsOf(ctx, p); keys[i] = partKey(ctx, p); mirrorKeys[i] = partKey(ctx, mirrorPart(ctx, p, axis2)); } catch { return; }
    try { codes[i] = book.codeFor(p).code; } catch { codes[i] = '??'; }
    for (const c of cells) owner.set(`${c[0]},${c[1]}`, i);
  });
  const out: { row: number; col: number; message: string }[] = [];
  const seen = new Set<string>();
  const sorted = [...owner.entries()].map(([k, i]) => ({ x: Number(k.split(',')[0]), y: Number(k.split(',')[1]), i })).sort((a, b) => a.y - b.y || a.x - b.x);
  for (const { x, y, i } of sorted) {
    const mx = axis2 - x - 1;
    const j = owner.get(`${mx},${y}`);
    if (j !== undefined && keys[j] === mirrorKeys[i]) continue;
    const pair = [Math.min(x, mx), Math.max(x, mx), y].join(',');
    if (seen.has(pair)) continue;
    seen.add(pair);
    const what = (k: number | undefined) => (k === undefined ? 'empty' : `${codes[k]}${bp.parts[k].facing ? ` facing ${bp.parts[k].facing}` : ''}`);
    out.push({ row: y, col: x, message: `row ${y}: col ${x} is ${what(i)}, but its mirror col ${mx} is ${what(j)}${j !== undefined ? ' (not its mirror image)' : ''}` });
  }
  return out;
}
