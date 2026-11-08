// The text grid a model reads and writes, and blueprint <-> grid. One token per cell:
//   ..        empty
//   HA        the first cell (topmost, then leftmost) of a part: its code in CAPITALS
//   ha        any other cell of that part: the same code in small letters
//   PI^       a part that faces out: ^ N (forward), > E, v S (back), < W
//   HAt3      a shaped piece: its shape letter and number (legend "shapes"); box pieces (1x1, 2x1, 2x2, 3x3) need none
//   ##        a cell of a part the grid can't draw (it rides in the `raw:` section)
// Rows are y (row labels), columns x (the header). Parts the legend has no code for get one in the `key:` section.
import type { Blueprint, PlacedPart, Side, Vec2 } from '../../../common/src/ships/index';
import { getVariant, orientToFacing, placeGeometry } from '../../../common/src/ships/index';
import type { ShipgenContext } from './context';
import { type CodeDef, type Legend, allocateCode, buildLegend } from './legend';
import { type ShapeClass, mirrorShape, pieceOfLetter, pieceShapes, placeShape, polygonKey, shapeOfPart, topLeft } from './shapes';

export const FACING_MARK: Record<Side, string> = { N: '^', E: '>', S: 'v', W: '<' };
const MARK_FACING: Record<string, Side> = { '^': 'N', '>': 'E', v: 'S', '<': 'W' };
const TOKEN = /^([A-Za-z]{2})([\^>v<])?([a-z]?[1-8])?$/;

export interface GridError { row?: number; col?: number; message: string }

interface Token { x: number; y: number; code: string; anchor: boolean; facing?: Side; shape?: { letter?: string; n: number }; text: string }

/** A design's codes: the legend's, plus its own `key:` entries */
export class CodeBook {
  readonly own: CodeDef[] = [];
  private used: Set<string>;
  constructor(readonly ctx: ShipgenContext, readonly legend: Legend = buildLegend(ctx)) {
    this.used = new Set(legend.byCode.keys());
  }
  get(code: string): CodeDef | undefined {
    return this.legend.byCode.get(code) ?? this.own.find((c) => c.code === code);
  }
  add(def: CodeDef): void {
    this.used.add(def.code);
    this.own.push(def);
  }
  /** The code for a part, adding a key entry when the legend has none that draws it exactly */
  codeFor(p: PlacedPart): CodeDef {
    const fn = this.ctx.catalog.functions.get(p.fn);
    const bespoke = !!this.ctx.catalog.pieces.get(p.piece)?.bespoke;
    const allowed = !fn || fn.pieces === '*' ? !bespoke : fn.pieces.includes(p.piece);
    const piece = bespoke || !allowed ? p.piece : undefined;
    const mount = p.mount === 'turret' && !fn?.mount ? 'turret' as const : undefined;
    if (!piece && !mount) {
      const e = this.legend.find(p.fn, p.material);
      if (e) return e;
    }
    const hit = this.own.find((c) => c.fn === p.fn && c.material === p.material && c.piece === piece && c.mount === mount);
    if (hit) return hit;
    const def: CodeDef = { code: allocateCode(`${fn?.name ?? p.fn} ${p.material}`, this.used), fn: p.fn, material: p.material, kind: 'extra', ...(piece ? { piece } : {}), ...(mount ? { mount } : {}) };
    this.add(def);
    return def;
  }
}

/** A part's identity for "same parts" (uid, rot/flip labels aside: the geometry it covers) */
export function partKey(ctx: ShipgenContext, p: PlacedPart): string {
  const g = placeGeometry(ctx.catalog, p);
  return [p.fn, p.material, p.piece, p.facing ?? '', p.mount === 'turret' && !ctx.catalog.functions.get(p.fn)?.mount ? 'turret' : '', polygonKey(g.polygon, 0, 0)].join('|');
}

/** Where a part is on the grid (its first cell) and its code */
export function partAt(ctx: ShipgenContext, p: PlacedPart): { row: number; col: number } {
  try { const { at } = shapeOfPart(ctx.catalog, p); return { row: at[1], col: at[0] }; } catch { return { row: p.y, col: p.x }; }
}

// ---------------------------------------------------------------------------------------------------------------------
// Blueprint -> grid

export interface EncodeResult {
  text: string;
  book: CodeBook;
  /** Parts the grid can't draw (kept in `raw:`), and why */
  raw: { uid: number; reason: string }[];
}

function tokenOf(ctx: ShipgenContext, def: CodeDef, p: PlacedPart, cls: ShapeClass, mark: boolean): string {
  const s = pieceShapes(ctx.catalog, p.piece);
  const face = p.facing ? FACING_MARK[p.facing as Side] ?? '' : '';
  const shape = s.box && !mark ? '' : `${s.letter ?? ''}${cls.index}`;
  return def.code + face + shape;
}

export function blueprintToGrid(ctx: ShipgenContext, bp: Blueprint, opts: { book?: CodeBook } = {}): EncodeResult {
  const rawUids = new Map<number, string>(), marked = new Set<number>();
  for (const p of bp.parts) if (p.mods || p.gems?.length) rawUids.set(p.uid, 'has mods or gems');
  for (let pass = 0; pass < 8; pass++) {
    const book = opts.book ?? new CodeBook(ctx);
    const text = encode(ctx, bp, book, rawUids, marked);
    const back = gridToBlueprint(ctx, text);
    if (!back.bp) {
      // (Can't happen for a grid we wrote; keep everything raw rather than lose it)
      for (const p of bp.parts) rawUids.set(p.uid, 'grid did not read back');
      continue;
    }
    const got = new Map<string, number>();
    for (const p of back.bp.parts) { const k = partKey(ctx, p); got.set(k, (got.get(k) ?? 0) + 1); }
    let ok = true;
    for (const p of bp.parts) {
      const k = partKey(ctx, p), n = got.get(k) ?? 0;
      if (n > 0) { got.set(k, n - 1); continue; }
      if (rawUids.has(p.uid)) continue;
      ok = false;
      // (Box parts of one code that read either way get a shape mark; a part still misread after that rides raw)
      if (!marked.has(p.uid)) marked.add(p.uid);
      else rawUids.set(p.uid, 'reads back as a different part');
    }
    if (ok) return { text, book, raw: [...rawUids].map(([uid, reason]) => ({ uid, reason })) };
  }
  throw new Error(`could not encode ${bp.name}`);
}

function encode(ctx: ShipgenContext, bp: Blueprint, book: CodeBook, rawUids: Map<number, string>, marked: Set<number>): string {
  const cells = new Map<string, string>();
  const placed: { p: PlacedPart; def: CodeDef; cls: ShapeClass; at: Vec2 }[] = [];
  for (const p of bp.parts) {
    if (rawUids.has(p.uid)) continue;
    let shape;
    try { shape = shapeOfPart(ctx.catalog, p); } catch { rawUids.set(p.uid, 'unknown piece'); continue; }
    const cellsOf = shape.cls.cells.map((c) => `${c[0] + shape.at[0]},${c[1] + shape.at[1]}`);
    const clash = cellsOf.find((k) => cells.has(k));
    if (clash) { rawUids.set(p.uid, `shares cell ${clash} with another part`); continue; }
    const def = book.codeFor(p);
    for (const k of cellsOf) cells.set(k, def.code.toLowerCase());
    cells.set(`${shape.at[0]},${shape.at[1]}`, tokenOf(ctx, def, p, shape.cls, marked.has(p.uid)));
    placed.push({ p, def, cls: shape.cls, at: shape.at });
  }
  const raws = bp.parts.filter((p) => rawUids.has(p.uid));
  for (const p of raws) {
    try { for (const c of placeGeometry(ctx.catalog, p).cells) { const k = `${c[0]},${c[1]}`; if (!cells.has(k)) cells.set(k, '##'); } } catch { /* (an unknown piece covers nothing) */ }
  }
  const head: string[] = [`name: ${bp.name}`];
  if (bp.paint) head.push(`paint: ${bp.paint}`);
  if (bp.drive !== undefined) head.push(`drive: ${bp.drive}`);
  if (bp.rigid) head.push('rigid: true');
  const out = [...head, 'grid:', ...gridLines(cells)];
  out.push('end');
  if (book.own.length) {
    out.push('key:');
    for (const c of book.own) out.push(`  ${c.code} = fn=${c.fn} material=${c.material}${c.piece ? ` piece=${c.piece}` : ''}${c.mount ? ` mount=${c.mount}` : ''}`);
  }
  if (raws.length) {
    out.push('raw:');
    for (const p of raws) { const { uid: _u, ...rest } = p; out.push(`  ${JSON.stringify(rest)}`); }
  }
  return out.join('\n') + '\n';
}

/** Grid rows from cell tokens ("x,y" -> token), with the x header and y labels */
export function gridLines(cells: Map<string, string>): string[] {
  if (!cells.size) return ['   0', '0  ..'];
  const xy = [...cells.keys()].map((k) => k.split(',').map(Number));
  const x0 = Math.min(...xy.map((c) => c[0])), x1 = Math.max(...xy.map((c) => c[0]));
  const y0 = Math.min(...xy.map((c) => c[1])), y1 = Math.max(...xy.map((c) => c[1]));
  const w = Math.max(3, ...[...cells.values()].map((t) => t.length)) + 1;
  const lw = Math.max(String(y0).length, String(y1).length) + 1;
  const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - s.length));
  const lines: string[] = [];
  let head = ' '.repeat(lw + 1);
  for (let x = x0; x <= x1; x++) head += pad(String(x), w);
  lines.push(head.trimEnd());
  for (let y = y0; y <= y1; y++) {
    let row = String(y).padStart(lw) + ' ';
    for (let x = x0; x <= x1; x++) row += pad(cells.get(`${x},${y}`) ?? '..', w);
    lines.push(row.trimEnd());
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------------------------------
// Grid -> blueprint

export interface DecodeResult {
  bp?: Blueprint;
  errors: GridError[];
  warnings: string[];
  book: CodeBook;
}

interface Parsed {
  name?: string; paint?: string; drive?: number; rigid?: boolean;
  tokens: Token[];
  raw: PlacedPart[];
  errors: GridError[];
  warnings: string[];
}

const isInt = (s: string) => /^-?\d+$/.test(s);

function parseText(text: string, book: CodeBook): Parsed {
  const out: Parsed = { tokens: [], raw: [], errors: [], warnings: [] };
  const lines = text.replace(/\r/g, '').split('\n').map((l) => l.replace(/```\w*/g, '').replace(/\|/g, ' ').replace(/\s+$/, ''));
  let mode: 'top' | 'grid' | 'key' | 'raw' = 'top';
  const hasGridHead = lines.some((l) => /^\s*grid\s*:/i.test(l));
  let header: number[] | null = null, rowIdx = 0, blank = false;
  const rows: { y: number; toks: string[] }[] = [];
  for (const line of lines) {
    const t = line.trim();
    const m = /^(name|paint|drive|rigid|grid|key|raw|end)\s*:?\s*(.*)$/i.exec(t);
    if (m) {
      const k = m[1].toLowerCase(), v = m[2].trim();
      if (k === 'name' && /:/.test(t)) { out.name = v; continue; }
      if (k === 'paint' && /:/.test(t)) { if (/^#[0-9a-f]{6}$/i.test(v)) out.paint = v.toLowerCase(); continue; }
      if (k === 'drive' && /:/.test(t)) { const d = Number(v); if (d > 0 && d < 1) out.drive = d; continue; }
      if (k === 'rigid' && /:/.test(t)) { out.rigid = v === 'true'; continue; }
      if (k === 'grid') { mode = 'grid'; continue; }
      if (k === 'end') { mode = 'top'; continue; }
      if (k === 'key' && /:/.test(t)) { mode = 'key'; continue; }
      if (k === 'raw' && /:/.test(t)) { mode = 'raw'; continue; }
    }
    if (!t) { if (mode === 'grid' && rows.length) blank = true; continue; }
    if (blank) {
      // (A blank line inside the grid: rows that follow it are still the grid's; anything else ends it)
      blank = false;
      if (mode === 'grid') {
        const bt = t.split(/\s+/);
        if (isInt(bt[0]) && bt.length > 1) bt.shift();
        if (bt.every((x) => /^\.+$/.test(x) || x === '##' || TOKEN.test(x))) out.warnings.push('a blank line inside the grid: the rows after it were read too (leave no blank lines between rows)');
        else mode = 'top';
      }
    }
    if (mode === 'key') {
      const km = /^([A-Z]{2})\s*=\s*(.*)$/.exec(t);
      if (!km) continue;
      const kv = Object.fromEntries(km[2].split(/\s+/).map((x) => x.split('=')).filter((x) => x.length === 2));
      if (!kv.fn || !kv.material) { out.errors.push({ message: `key "${t}": needs fn= and material=` }); continue; }
      if (!book.get(km[1])) book.add({ code: km[1], fn: kv.fn, material: kv.material, kind: 'extra', ...(kv.piece ? { piece: kv.piece } : {}), ...(kv.mount === 'turret' ? { mount: 'turret' } : {}) });
      continue;
    }
    if (mode === 'raw') {
      try { const p = JSON.parse(t); if (p && typeof p.fn === 'string') out.raw.push(p); } catch { out.errors.push({ message: `raw line isn't JSON: ${t.slice(0, 60)}` }); }
      continue;
    }
    if (mode !== 'grid' && hasGridHead) continue;
    const toks = t.split(/\s+/);
    if (toks.every(isInt) && (toks.length > 1 || mode === 'grid') && !header && !rows.length) { header = toks.map(Number); continue; }
    let label: number | null = null;
    if (isInt(toks[0]) && toks.length > 1) label = Number(toks.shift());
    if (!toks.every((x) => /^\.+$/.test(x) || x === '##' || TOKEN.test(x))) {
      if (mode === 'grid') out.errors.push({ message: `can't read grid line "${t.slice(0, 80)}": every cell is .. or a code like HA, ha, PI^, HAt2` });
      continue;
    }
    if (!hasGridHead) mode = 'grid';
    rows.push({ y: label ?? rowIdx, toks });
    rowIdx++;
  }
  const width = Math.max(header?.length ?? 0, ...rows.map((r) => r.toks.length));
  const xs = header && header.length === width ? header : Array.from({ length: width }, (_, i) => (header ? header[0] + i : i));
  if (header && header.length !== width) out.warnings.push(`the header has ${header.length} columns but a row has ${width}: columns counted from ${xs[0]}`);
  for (const r of rows) {
    if (r.toks.length < width) out.warnings.push(`row ${r.y} has ${r.toks.length} cells, not ${width}: the rest read as empty`);
    r.toks.forEach((tk, i) => {
      if (/^\.+$/.test(tk) || tk === '##') return;
      const m = TOKEN.exec(tk)!;
      const anchor = m[1] === m[1].toUpperCase(), lower = m[1] === m[1].toLowerCase();
      if (!anchor && !lower) { out.errors.push({ row: r.y, col: xs[i], message: `"${tk}": write a part's first cell in CAPITALS (HA) and its other cells in small letters (ha)` }); return; }
      if (!anchor && (m[2] || m[3])) { out.errors.push({ row: r.y, col: xs[i], message: `"${tk}": marks (^ > v <, shape) go on the part's first cell, in CAPITALS` }); return; }
      const shape = m[3] ? { letter: /[a-z]/.test(m[3][0]) ? m[3][0] : undefined, n: Number(m[3].slice(-1)) } : undefined;
      out.tokens.push({ x: xs[i], y: r.y, code: m[1].toUpperCase(), anchor, ...(m[2] ? { facing: MARK_FACING[m[2]] } : {}), ...(shape ? { shape } : {}), text: tk });
    });
  }
  return out;
}

interface Cand { cls: ShapeClass; cells: string[] }

function candidates(ctx: ShipgenContext, book: CodeBook, t: Token, cellAt: Map<string, Token>): { list: Cand[]; why?: string } {
  const def = book.get(t.code);
  if (!def) return { list: [], why: `"${t.code}" isn't in the legend` };
  const fn = ctx.catalog.functions.get(def.fn);
  const allowed = def.piece ? [def.piece] : !fn ? [] : fn.pieces === '*' ? ctx.catalog.pieceIds : fn.pieces;
  let classes: ShapeClass[] = [];
  if (t.shape) {
    const piece = t.shape.letter ? pieceOfLetter(ctx.catalog, t.shape.letter) : allowed.filter((p) => !pieceShapes(ctx.catalog, p).box).length === 1 ? allowed.find((p) => !pieceShapes(ctx.catalog, p).box) : undefined;
    if (!piece || !allowed.includes(piece)) return { list: [], why: `"${t.text}": shape ${t.shape.letter ?? ''}${t.shape.n} isn't one ${def.code} can be` };
    const c = pieceShapes(ctx.catalog, piece).classes[t.shape.n - 1];
    if (!c) return { list: [], why: `"${t.text}": ${piece} has shapes 1-${pieceShapes(ctx.catalog, piece).classes.length}` };
    classes = [c];
  } else {
    for (const p of allowed) { const s = pieceShapes(ctx.catalog, p); if (s.box || def.piece) classes.push(...s.classes); }
    if (!classes.length) return { list: [], why: `"${t.text}": a ${fn?.name ?? def.fn} is a shaped piece: add its shape (like ${def.code}${pieceShapes(ctx.catalog, allowed[0]).letter ?? ''}1)` };
  }
  const list: Cand[] = [];
  for (const cls of classes) {
    const self = `${t.x},${t.y}`;
    const cells = [self, ...cls.cells.map((c) => `${c[0] + t.x},${c[1] + t.y}`).filter((k) => k !== self)];
    if (cells.slice(1).every((k) => { const o = cellAt.get(k); return !!o && !o.anchor && o.code === t.code; })) list.push({ cls, cells });
  }
  list.sort((a, b) => b.cells.length - a.cells.length);
  return { list };
}

const readingOrder = (a: Token, b: Token) => a.y - b.y || a.x - b.x;

export function gridToBlueprint(ctx: ShipgenContext, text: string, opts: { book?: CodeBook } = {}): DecodeResult {
  const book = opts.book ?? new CodeBook(ctx);
  const pr = parseText(text, book);
  const errors = [...pr.errors], warnings = [...pr.warnings];
  let tokens = pr.tokens;
  let solved = solve(ctx, book, tokens);
  if (!solved.ok) {
    // (Lenient: a capital cell that can't start a part, beside the same code, was meant as one of its other cells)
    const cellAt = new Map(tokens.map((t) => [`${t.x},${t.y}`, t]));
    let changed = false;
    tokens = tokens.map((t) => {
      if (!t.anchor || t.facing || t.shape || candidates(ctx, book, t, cellAt).list.length) return t;
      const prev = [cellAt.get(`${t.x - 1},${t.y}`), cellAt.get(`${t.x},${t.y - 1}`)].find((o) => o && o.code === t.code);
      if (!prev) return t;
      changed = true;
      warnings.push(`row ${t.y} col ${t.x}: read "${t.text}" as "${t.code.toLowerCase()}" (another cell of the part before it)`);
      return { ...t, anchor: false };
    });
    if (changed) solved = solve(ctx, book, tokens);
  }
  if (!solved.ok) return { errors: [...errors, ...solved.errors], warnings, book };
  if (errors.length) return { errors, warnings, book };
  const parts: PlacedPart[] = [];
  for (const { t, c } of solved.picks) {
    const def = book.get(t.code)!;
    const pl = placeShape(c.cls, [t.x, t.y]);
    parts.push(orientToFacing(ctx.catalog, { uid: parts.length, piece: c.cls.piece, fn: def.fn, material: def.material, ...pl, ...(t.facing ? { facing: t.facing } : {}), ...(def.mount ? { mount: def.mount } : {}) }));
  }
  for (const r of pr.raw) parts.push({ ...r, uid: parts.length });
  const bp: Blueprint = {
    name: pr.name ?? 'Untitled', catalogVersion: ctx.catalog.version,
    ...(pr.paint ? { paint: pr.paint } : {}), ...(pr.drive !== undefined ? { drive: pr.drive } : {}), ...(pr.rigid ? { rigid: true } : {}),
    parts,
  };
  return { bp, errors, warnings, book };
}

type Solve = { ok: true; picks: { t: Token; c: Cand }[] } | { ok: false; errors: GridError[] };

/** How a part with only rectangular pieces is drawn, for an error: ` (a 2x2: "HB hb" over "hb hb")` */
function footprint(ctx: ShipgenContext, code: string, pieces: string[] | '*' | undefined): string {
  if (!Array.isArray(pieces) || pieces.length !== 1 || !pieceShapes(ctx.catalog, pieces[0]).box) return '';
  const cells = getVariant(ctx.catalog, pieces[0], 0, false).cells;
  const w = Math.max(...cells.map((c) => c[0])) - Math.min(...cells.map((c) => c[0])) + 1;
  const h = Math.max(...cells.map((c) => c[1])) - Math.min(...cells.map((c) => c[1])) + 1;
  if (w * h <= 1) return '';
  const lo = code.toLowerCase(), row = (first: boolean) => `"${[first ? code : lo, ...Array(w - 1).fill(lo)].join(' ')}"`;
  const rows = [row(true), ...Array(h - 1).fill(row(false))];
  return ` (it is ${w}x${h}: ${rows.join(' over ')}${w !== h ? ', or turned' : ''})`;
}

/** Exact cover: each capital cell starts one part; every small-letter cell belongs to exactly one */
function solve(ctx: ShipgenContext, book: CodeBook, tokens: Token[]): Solve {
  const cellAt = new Map(tokens.map((t) => [`${t.x},${t.y}`, t]));
  const anchors = tokens.filter((t) => t.anchor).sort(readingOrder);
  const rest = tokens.filter((t) => !t.anchor).sort(readingOrder);
  const cands = anchors.map((t) => candidates(ctx, book, t, cellAt));
  const claimed = new Set<string>(), picks: { t: Token; c: Cand }[] = [];
  let steps = 0;
  const go = (i: number): boolean => {
    if (++steps > 200000) return false;
    // (a small-letter cell before this part's first cell can't be claimed by it or any later part)
    const pos = i < anchors.length ? anchors[i] : null;
    for (const r of rest) {
      if (pos && readingOrder(r, pos) > 0) break;
      if (!claimed.has(`${r.x},${r.y}`)) return false;
    }
    if (!pos) return true;
    for (const c of cands[i].list) {
      if (c.cells.some((k) => claimed.has(k))) continue;
      for (const k of c.cells) claimed.add(k);
      picks.push({ t: pos, c });
      if (go(i + 1)) return true;
      picks.pop();
      for (const k of c.cells) claimed.delete(k);
    }
    return false;
  };
  if (go(0)) return { ok: true, picks };
  // Explain: anchors nothing fits, then small-letter cells a greedy pass leaves over
  const errors: GridError[] = [];
  const taken = new Set<string>();
  anchors.forEach((t, i) => {
    const { list, why } = cands[i];
    const def = book.get(t.code), fn = def && ctx.catalog.functions.get(def.fn);
    const fit = list.find((c) => !c.cells.some((k) => taken.has(k)));
    if (fit) { for (const k of fit.cells) taken.add(k); return; }
    taken.add(`${t.x},${t.y}`);
    errors.push({ row: t.y, col: t.x, message: why ?? `"${t.text}": no ${fn?.name ?? t.code} fits here: its other cells must be "${t.code.toLowerCase()}" right of or below this one, in its shape${footprint(ctx, t.code, fn?.pieces)}` });
  });
  for (const r of rest) {
    if (taken.has(`${r.x},${r.y}`)) continue;
    errors.push({ row: r.y, col: r.x, message: book.get(r.code) ? `"${r.text}" belongs to no part: each part's first (top-left) cell is in CAPITALS, the rest of its cells small` : `"${r.text}": ${r.code} isn't in the legend` });
  }
  if (!errors.length) errors.push({ message: 'the parts can\'t be told apart: mark each part\'s first cell in CAPITALS' });
  return { ok: false, errors };
}

// ---------------------------------------------------------------------------------------------------------------------
// Symmetry

/** A part mirrored left-right about x = axis2 / 2 (facings E and W swap) */
export function mirrorPart(ctx: ShipgenContext, p: PlacedPart, axis2: number): PlacedPart {
  const { cls, at } = shapeOfPart(ctx.catalog, p);
  const cells: Vec2[] = cls.cells.map((c) => [axis2 - (c[0] + at[0]) - 1, c[1] + at[1]]);
  const m = mirrorShape(ctx.catalog, cls);
  const facing = p.facing === 'E' ? 'W' : p.facing === 'W' ? 'E' : p.facing;
  return { ...p, ...placeShape(m, topLeft(cells)), piece: m.piece, ...(facing ? { facing } : {}) };
}

/** The core's centre line (x2: twice the x), the usual axis */
export function coreAxis2(ctx: ShipgenContext, bp: Blueprint): number {
  const core = bp.parts.find((p) => p.fn === 'core');
  if (!core) return 0;
  const cells = placeGeometry(ctx.catalog, core).cells;
  return Math.min(...cells.map((c) => c[0])) + Math.max(...cells.map((c) => c[0])) + 1;
}

/** Keep the left half (and parts on the axis), and add its mirror image on the right */
export function mirrorLeft(ctx: ShipgenContext, bp: Blueprint, axis2 = coreAxis2(ctx, bp)): Blueprint {
  const out: PlacedPart[] = [];
  for (const p of bp.parts) {
    const xs = placeGeometry(ctx.catalog, p).cells.map((c) => c[0]);
    const left = Math.max(...xs) + 1 <= axis2 / 2, right = Math.min(...xs) >= axis2 / 2;
    if (right) continue;
    out.push(p);
    if (left) out.push(mirrorPart(ctx, p, axis2));
  }
  return { ...bp, parts: out.map((p, uid) => ({ ...p, uid })) };
}

/** mirrorLeft on grid text */
export function mirrorGridLeft(ctx: ShipgenContext, text: string, axis2?: number): DecodeResult & { text?: string } {
  const d = gridToBlueprint(ctx, text);
  if (!d.bp) return d;
  const bp = mirrorLeft(ctx, d.bp, axis2);
  return { ...d, bp, text: blueprintToGrid(ctx, bp).text };
}
