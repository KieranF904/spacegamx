// The part list: a design as a list of parts with positions, instead of a drawn grid. Each entry is the token a grid
// writes in a part's first cell (code, facing mark, shape mark), its position as "col,row" (the part's top-left cell:
// topmost, then leftmost), and for a multi-cell box piece its size ("2x1", "1x2", "2x2"):
//   name: Wren
//   parts:
//   CA 0,0
//   PI^ -1,0
//   HB -3,1 2x2
//   HAt4 -3,1
// Entries may also be separated by ";". The tool places each piece by its anchor and refuses overlaps by name.
import type { Blueprint, PlacedPart, Side, Vec2 } from '../../../common/src/ships/index';
import { getVariant, placeGeometry } from '../../../common/src/ships/index';
import type { ShipgenContext } from './context';
import { CodeBook, FACING_MARK, type DecodeResult, type GridError } from './grid';
import { type ShapeClass, pieceOfLetter, pieceShapes, placeShape, shapeOfPart } from './shapes';

const MARK_FACING: Record<string, Side> = { '^': 'N', '>': 'E', v: 'S', '<': 'W' };
/** CODE[mark][shape] col,row [WxH] */
const ENTRY = /^\s*[-*•]?\s*([A-Za-z]{2})([\^>v<])?([a-z]?[1-8])?\s*(?:at\s*|@\s*)?[([]?\s*(-?\d+)\s*[,\s]\s*(-?\d+)\s*[)\]]?\s*(?:(\d)\s*[x×]\s*(\d))?\s*,?\s*$/;

const sizeOf = (cells: Vec2[]) => {
  const xs = cells.map((c) => c[0]), ys = cells.map((c) => c[1]);
  return [Math.max(...xs) - Math.min(...xs) + 1, Math.max(...ys) - Math.min(...ys) + 1] as const;
};

/** The entry for one placed part */
export function partEntry(ctx: ShipgenContext, book: CodeBook, p: PlacedPart): string {
  const { cls, at } = shapeOfPart(ctx.catalog, p);
  const s = pieceShapes(ctx.catalog, p.piece);
  const def = book.codeFor(p);
  const face = p.facing ? FACING_MARK[p.facing as Side] ?? '' : '';
  const shape = s.box ? '' : `${s.letter ?? ''}${cls.index}`;
  const [w, h] = sizeOf(cls.cells);
  return `${def.code}${face}${shape} ${at[0]},${at[1]}${s.box && w * h > 1 ? ` ${w}x${h}` : ''}`;
}

/** A design as a part list (reading order: top row first) */
export function blueprintToParts(ctx: ShipgenContext, bp: Blueprint, opts: { book?: CodeBook } = {}): { text: string; book: CodeBook } {
  const book = opts.book ?? new CodeBook(ctx);
  const rows = bp.parts.map((p) => { const { at } = shapeOfPart(ctx.catalog, p); return { p, at }; }).sort((a, b) => a.at[1] - b.at[1] || a.at[0] - b.at[0]);
  const lines = [`name: ${bp.name}`, 'parts:', ...rows.map((r) => partEntry(ctx, book, r.p)), 'end'];
  if (book.own.length) {
    lines.push('key:');
    for (const c of book.own) lines.push(`  ${c.code} = fn=${c.fn} material=${c.material}${c.piece ? ` piece=${c.piece}` : ''}${c.mount ? ` mount=${c.mount}` : ''}`);
  }
  return { text: lines.join('\n') + '\n', book };
}

/** The shape a code takes at an entry: its shape mark, else the box piece of the size given (else its smallest) */
function shapeFor(ctx: ShipgenContext, book: CodeBook, code: string, shape: string | undefined, size: [number, number] | null): { cls?: ShapeClass; why?: string } {
  const def = book.get(code);
  if (!def) return { why: `"${code}" isn't in the legend` };
  const fn = ctx.catalog.functions.get(def.fn);
  const allowed = def.piece ? [def.piece] : !fn ? [] : fn.pieces === '*' ? ctx.catalog.pieceIds.filter((p) => !ctx.catalog.pieces.get(p)?.bespoke) : fn.pieces;
  if (shape) {
    const letter = /[a-z]/.test(shape[0]) ? shape[0] : undefined, n = Number(shape.slice(-1));
    const piece = letter ? pieceOfLetter(ctx.catalog, letter) : allowed.filter((p) => !pieceShapes(ctx.catalog, p).box).length === 1 ? allowed.find((p) => !pieceShapes(ctx.catalog, p).box) : undefined;
    if (!piece || !allowed.includes(piece)) return { why: `shape ${shape} isn't one ${code} can be` };
    const cls = pieceShapes(ctx.catalog, piece).classes[n - 1];
    if (!cls) return { why: `${piece} has shapes 1-${pieceShapes(ctx.catalog, piece).classes.length}` };
    if (size && sizeOf(cls.cells).join('x') !== size.join('x')) return { why: `shape ${shape} is ${sizeOf(cls.cells).join('x')}, not ${size.join('x')}` };
    return { cls };
  }
  const boxes = allowed.filter((p) => pieceShapes(ctx.catalog, p).box).flatMap((p) => pieceShapes(ctx.catalog, p).classes);
  if (!boxes.length) {
    const sp = pieceShapes(ctx.catalog, allowed[0]);
    return { why: `${fn?.name ?? code} is a shaped piece: add its shape after the code (like ${code}${sp.letter ?? ''}1)` };
  }
  if (size) {
    const hit = boxes.find((c) => sizeOf(c.cells).join('x') === size.join('x'));
    if (!hit) return { why: `${fn?.name ?? code} comes ${[...new Set(boxes.map((c) => sizeOf(c.cells).join('x')))].join(' or ')}, not ${size.join('x')}` };
    return { cls: hit };
  }
  return { cls: [...boxes].sort((a, b) => a.cells.length - b.cells.length)[0] };
}

/** Reads a part list into a blueprint; overlaps and unknown codes are errors naming the entries */
export function partsToBlueprint(ctx: ShipgenContext, text: string, opts: { book?: CodeBook } = {}): DecodeResult {
  const book = opts.book ?? new CodeBook(ctx);
  const errors: GridError[] = [], warnings: string[] = [];
  let name: string | undefined;
  let mode: 'top' | 'parts' | 'key' = 'top';
  const parts: PlacedPart[] = [];
  const owner = new Map<string, { entry: string; i: number }>();
  const dropped = new Set<number>();
  const raw = text.replace(/\r/g, '').split('\n');
  const hasHead = raw.some((l) => /^\s*parts\s*:/i.test(l));
  for (const line of raw) {
    const t = line.trim();
    const nm = /^name\s*:\s*(.*)$/i.exec(t);
    if (nm) { name = nm[1].trim() || name; continue; }
    if (/^parts\s*:?\s*$/i.test(t)) { mode = 'parts'; continue; }
    if (/^end\s*$/i.test(t)) { mode = 'top'; continue; }
    if (/^key\s*:\s*$/i.test(t)) { mode = 'key'; continue; }
    if (!t) continue;
    if (mode === 'key') {
      const km = /^([A-Z]{2})\s*=\s*(.*)$/.exec(t);
      if (!km) continue;
      const kv = Object.fromEntries(km[2].split(/\s+/).map((x) => x.split('=')).filter((x) => x.length === 2));
      if (kv.fn && kv.material && !book.get(km[1])) book.add({ code: km[1], fn: kv.fn, material: kv.material, kind: 'extra', ...(kv.piece ? { piece: kv.piece } : {}), ...(kv.mount === 'turret' ? { mount: 'turret' } : {}) });
      continue;
    }
    if (hasHead && mode !== 'parts') continue;
    for (const entry of t.split(';').map((s) => s.trim()).filter(Boolean)) {
      const m = ENTRY.exec(entry);
      if (!m) {
        const bare = /^([a-z])(\d)\s/.exec(entry);
        if (mode === 'parts') errors.push({ message: `can't read "${entry.slice(0, 60)}": write CODE col,row (like PI^ -1,-2, or HB -3,1 2x2)${bare ? `; a shape goes after a code: HA${bare[1]}${bare[2]}, not ${bare[1]}${bare[2]}` : ''}` });
        continue;
      }
      const [, c, mark, shape, xs, ys, w, h] = m;
      if (c !== c.toUpperCase()) { errors.push({ message: `"${entry}": write the code in CAPITALS` }); continue; }
      const x = Number(xs), y = Number(ys);
      const sh = shapeFor(ctx, book, c, shape, w ? [Number(w), Number(h)] : null);
      if (!sh.cls) { errors.push({ row: y, col: x, message: `"${entry}": ${sh.why}` }); continue; }
      const def = book.get(c)!;
      const p: PlacedPart = { uid: parts.length, piece: sh.cls.piece, fn: def.fn, material: def.material, ...placeShape(sh.cls, [x, y]), ...(mark ? { facing: MARK_FACING[mark] } : {}), ...(def.mount ? { mount: def.mount } : {}) };
      let cells: Vec2[];
      try { cells = placeGeometry(ctx.catalog, p).cells; } catch (e) { errors.push({ row: y, col: x, message: `"${entry}": ${(e as Error).message}` }); continue; }
      // (Hull "under" a part: models often list a hull cell and a part on it; the part wins, with a note)
      const under = [...new Set(cells.map((k) => owner.get(`${k[0]},${k[1]}`)?.i).filter((i): i is number => i !== undefined))];
      if (under.length && p.fn === 'hull') { warnings.push(`"${entry}" is under another part: dropped (a cell holds one part)`); continue; }
      if (under.length && under.every((i) => parts[i].fn === 'hull' && !dropped.has(i))) {
        for (const i of under) { dropped.add(i); warnings.push(`hull under "${entry}": dropped (a cell holds one part)`); }
        for (const [k, o] of [...owner]) if (dropped.has(o.i)) owner.delete(k);
      }
      const clash = cells.find((k) => owner.has(`${k[0]},${k[1]}`));
      if (clash) {
        const o = owner.get(`${clash[0]},${clash[1]}`)!;
        errors.push({ row: y, col: x, message: `"${entry}" overlaps "${o.entry}": both cover col ${clash[0]} row ${clash[1]}${cells.length > 1 ? ` (${entry.split(/\s+/)[0]} covers ${cells.map((k) => `${k[0]},${k[1]}`).join(' ')})` : ''}: move one` });
        continue;
      }
      for (const k of cells) owner.set(`${k[0]},${k[1]}`, { entry, i: parts.length });
      parts.push(p);
    }
  }
  if (errors.length) return { errors, warnings, book };
  if (!hasHead) warnings.push('no "parts:" line: read every line that looks like an entry');
  const bp: Blueprint = { name: name ?? 'Untitled', catalogVersion: ctx.catalog.version, parts: parts.filter((_, i) => !dropped.has(i)).map((p, uid) => ({ ...p, uid })) };
  return { bp, errors, warnings, book };
}

/**
 * Adds parts to a design (a staged step's reply): parts already there (the same part in the same place) are skipped;
 * a new part may cover cells of a part `replaceable` allows (frame hull), which then goes; any other overlap is an error.
 */
export function mergeParts(ctx: ShipgenContext, base: Blueprint, add: PlacedPart[], replaceable: (p: PlacedPart) => boolean, book: CodeBook = new CodeBook(ctx)): DecodeResult {
  const errors: GridError[] = [], warnings: string[] = [];
  const keep = base.parts.map((p) => ({ p, gone: false }));
  const owner = new Map<string, number>();
  keep.forEach(({ p }, i) => { for (const c of placeGeometry(ctx.catalog, p).cells) owner.set(`${c[0]},${c[1]}`, i); });
  const same = (a: PlacedPart, b: PlacedPart) => a.fn === b.fn && a.material === b.material && a.piece === b.piece && a.rot === b.rot && !!a.flip === !!b.flip && a.x === b.x && a.y === b.y && (a.facing ?? '') === (b.facing ?? '');
  const added: PlacedPart[] = [];
  let skipped = 0, replaced = 0;
  for (const p of add) {
    if (base.parts.some((q) => same(p, q))) { skipped++; continue; }
    const cells = placeGeometry(ctx.catalog, p).cells;
    const all = cells.map((c) => owner.get(`${c[0]},${c[1]}`));
    if (all.includes(-1)) { errors.push({ message: `"${partEntry(ctx, book, p)}" overlaps another new part` }); continue; }
    const hits = [...new Set(all.filter((i): i is number => i !== undefined))];
    const blocking = hits.filter((i) => !keep[i].gone && !replaceable(keep[i].p));
    if (blocking.length) {
      const q = keep[blocking[0]].p, at = shapeOfPart(ctx.catalog, q).at;
      errors.push({ row: shapeOfPart(ctx.catalog, p).at[1], col: shapeOfPart(ctx.catalog, p).at[0], message: `"${partEntry(ctx, book, p)}" overlaps "${partEntry(ctx, book, q)}" (placed before, at col ${at[0]} row ${at[1]}): put it on free cells (or on frame hull)` });
      continue;
    }
    for (const i of hits) if (!keep[i].gone) { keep[i].gone = true; replaced++; }
    for (const c of cells) owner.set(`${c[0]},${c[1]}`, -1);
    added.push(p);
  }
  if (skipped) warnings.push(`${skipped} part(s) you listed were already there: kept once`);
  if (replaced) warnings.push(`${replaced} frame hull cell(s) were replaced by your new parts`);
  if (errors.length) return { errors, warnings, book };
  const parts = [...keep.filter((k) => !k.gone).map((k) => k.p), ...added].map((p, uid) => ({ ...p, uid }));
  return { bp: { ...base, parts }, errors, warnings, book };
}

/** A box piece's size words, for the format text ("2x1") */
export function boxSize(ctx: ShipgenContext, piece: string): string {
  return sizeOf(getVariant(ctx.catalog, piece, 0, false).cells).join('x');
}
