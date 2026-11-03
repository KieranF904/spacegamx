/**
 * Piece catalog: loading, validation and the 8 symmetry variants.
 *
 * Variants rotate about the centre of the origin cell, so the origin cell is
 * the same cell in every variant. Variant index = rot + (flip ? 4 : 0); the
 * mirror (x → 1 - x) is applied before the rotation. One rotation step is 90°
 * clockwise on screen: (x, y) → (1 - y, x).
 */

import type {
  BespokeFile, Connector, Diag, FunctionDef, MaterialDef, PieceDef, PieceMount, Rot, Segment, Side, Vec2,
} from './types.js';
import {
  convexAreaInBox, convexDecompose, flattenOutline, outlineArea, polygonCentroid,
  polygonPolarMomentCentroid, segmentEnd, segmentStart, shrinkConvex, signedArea, snap,
} from './geometry.js';
import { registerFunctionDefs } from './blueprint.js';
import { HAZARDS } from './hazards.js';
import { dhypot } from '../math/detTrig.js';

export const SIDES: Side[] = ['N', 'E', 'S', 'W'];
export const SIDE_NORMAL: Record<Side, Vec2> = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };

export interface LineEdge { a: Vec2; b: Vec2 }

export interface PieceVariant {
  pieceId: string;
  index: number;
  rot: Rot;
  flip: boolean;
  cells: Vec2[];
  outline: Segment[];
  connectors: Connector[];
  /** Flattened outline (8 segments per quarter circle) */
  polygon: Vec2[];
  /** Convex pieces of the polygon, exact (hit tests) */
  convex: Vec2[][];
  /** Convex pieces shrunk by tuning.overlapShrink (overlap tests) */
  convexShrunk: Vec2[][];
  /** Straight outline segments (for facing / free-edge checks) */
  lines: LineEdge[];
  /** Exact area in cells² */
  area: number;
  /** Centroid in cell units, relative to the origin cell's top-left corner */
  centroid: Vec2;
  /** Polar second moment of area about the centroid (cells⁴); × density = inertia */
  polarMoment: number;
  /** Bespoke pieces: where it points out, turned with it (dir a unit vector) */
  mount?: PieceMount;
}

export interface CatalogFiles {
  pieces: { catalogVersion: number; pieces: PieceDef[] };
  /** Designs' own pieces (data/ships/bespoke/*.json) */
  bespoke?: BespokeFile[];
  functions: { functions: FunctionDef[] };
  materials: { materials: MaterialDef[] };
  /** Player models (data/ships/models.json): merged into the functions; `legacy` is each legacy function's family */
  models?: ModelsFile;
}

export interface ModelsFile { models: FunctionDef[]; legacy?: Record<string, string> }

export interface Catalog {
  version: number;
  pieces: Map<string, PieceDef>;
  /** 8 variants per piece, indexed by rot + (flip ? 4 : 0) */
  variants: Map<string, PieceVariant[]>;
  functions: Map<string, FunctionDef>;
  materials: Map<string, MaterialDef>;
  /** The pieces a player can build with, in a stable order (bespoke pieces aren't among them) */
  pieceIds: string[];
  /** Each family's models, by unlock level (models.json) */
  families: Map<string, FunctionDef[]>;
  /** The family each legacy function's parts become (migrate.ts) */
  legacyFamily: Map<string, string>;
}

export class CatalogError extends Error {}

// ---------------------------------------------------------------------------
// Symmetries
// ---------------------------------------------------------------------------

export function variantIndex(rot: Rot, flip: boolean): number {
  return rot + (flip ? 4 : 0);
}

export function transformPoint(p: Vec2, rot: Rot, flip: boolean): Vec2 {
  let x = flip ? 1 - p[0] : p[0];
  let y = p[1];
  for (let i = 0; i < rot; i++) [x, y] = [1 - y, x];
  return [snap(x), snap(y)];
}

export function transformDir(d: Vec2, rot: Rot, flip: boolean): Vec2 {
  let x = flip ? -d[0] : d[0];
  let y = d[1];
  for (let i = 0; i < rot; i++) [x, y] = [-y, x];
  return [x === 0 ? 0 : x, y === 0 ? 0 : y];
}

export function sideFromNormal(n: Vec2): Side {
  for (const s of SIDES) if (SIDE_NORMAL[s][0] === n[0] && SIDE_NORMAL[s][1] === n[1]) return s;
  throw new Error(`not a side normal: ${n}`);
}

export function transformSide(s: Side, rot: Rot, flip: boolean): Side {
  return sideFromNormal(transformDir(SIDE_NORMAL[s], rot, flip));
}

export function transformDiag(d: Diag, rot: Rot, flip: boolean): Diag {
  const swaps = rot % 2 + (flip ? 1 : 0);
  return swaps % 2 === 0 ? d : d === 'NE' ? 'NW' : 'NE';
}

function transformCell(c: Vec2, rot: Rot, flip: boolean): Vec2 {
  const centre = transformPoint([c[0] + 0.5, c[1] + 0.5], rot, flip);
  return [Math.floor(centre[0]), Math.floor(centre[1])];
}

function normAngle(a: number): number {
  return ((a % 360) + 540) % 360 - 180;
}

function transformSegment(s: Segment, rot: Rot, flip: boolean): Segment {
  if (s.type === 'line') {
    return { type: 'line', a: transformPoint(s.a, rot, flip), b: transformPoint(s.b, rot, flip) };
  }
  // The circle centre is a grid corner, so it maps like any point. Angles: the
  // mirror maps θ → 180 - θ, each rotation adds 90.
  let a0 = flip ? 180 - s.a0 : s.a0;
  let a1 = flip ? 180 - s.a1 : s.a1;
  a0 += 90 * rot;
  a1 += 90 * rot;
  const shift = normAngle(a0) - a0;
  return { type: 'arc', c: transformPoint(s.c, rot, flip), r: s.r, a0: a0 + shift, a1: a1 + shift };
}

function transformConnector(c: Connector, rot: Rot, flip: boolean): Connector {
  const cell = transformCell(c.cell, rot, flip);
  return 'side' in c
    ? { cell, side: transformSide(c.side, rot, flip) }
    : { cell, diag: transformDiag(c.diag, rot, flip) };
}

/** The two corner points of a cell edge or diagonal. */
export function connectorEndpoints(c: Connector, ox = 0, oy = 0): [Vec2, Vec2] {
  const x = c.cell[0] + ox, y = c.cell[1] + oy;
  if ('side' in c) {
    switch (c.side) {
      case 'N': return [[x, y], [x + 1, y]];
      case 'E': return [[x + 1, y], [x + 1, y + 1]];
      case 'S': return [[x, y + 1], [x + 1, y + 1]];
      case 'W': return [[x, y], [x, y + 1]];
    }
  }
  return c.diag === 'NW' ? [[x, y], [x + 1, y + 1]] : [[x, y + 1], [x + 1, y]];
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const isInt = (v: number) => Number.isInteger(v);
const samePoint = (p: Vec2, q: Vec2) => Math.abs(p[0] - q[0]) < 1e-6 && Math.abs(p[1] - q[1]) < 1e-6;

/** True when segment p→q lies entirely on segment a→b. */
function segmentOnSegment(p: Vec2, q: Vec2, a: Vec2, b: Vec2): boolean {
  const ex = b[0] - a[0], ey = b[1] - a[1];
  const len2 = ex * ex + ey * ey;
  for (const pt of [p, q]) {
    const cr = ex * (pt[1] - a[1]) - ey * (pt[0] - a[0]);
    if (Math.abs(cr) > 1e-6) return false;
    const t = ((pt[0] - a[0]) * ex + (pt[1] - a[1]) * ey) / len2;
    if (t < -1e-6 || t > 1 + 1e-6) return false;
  }
  return true;
}

export function lineEdges(outline: Segment[]): LineEdge[] {
  return outline.filter((s): s is Extract<Segment, { type: 'line' }> => s.type === 'line').map((s) => ({ a: s.a, b: s.b }));
}

/** True when the connector's edge or diagonal is fully covered by one straight outline segment. */
export function connectorOnOutline(c: Connector, lines: LineEdge[]): boolean {
  const [p, q] = connectorEndpoints(c);
  return lines.some((l) => segmentOnSegment(p, q, l.a, l.b));
}

function validatePiece(p: PieceDef): void {
  const fail = (msg: string): never => { throw new CatalogError(`piece "${p.id}": ${msg}`); };

  if (!p.id) fail('missing id');
  if (!Number.isInteger(p.tier)) fail('tier must be an integer');
  if (!p.cells?.length) fail('no cells');
  const cellKeys = new Set<string>();
  for (const c of p.cells) {
    if (!isInt(c[0]) || !isInt(c[1])) fail(`cell ${c} is not integer`);
    const k = `${c[0]},${c[1]}`;
    if (cellKeys.has(k)) fail(`duplicate cell ${k}`);
    cellKeys.add(k);
  }
  if (!cellKeys.has('0,0')) fail('cells must include the origin cell [0,0]');

  if (!p.outline?.length) fail('no outline');
  for (const [i, s] of p.outline.entries()) {
    if (s.type === 'line') {
      // Straight edges run between grid corners: cell boundaries, cell diagonals,
      // or (slope pieces) the diagonal of a whole-cell rectangle.
      if (![...s.a, ...s.b].every(isInt)) fail(`line ${i} has a non-integer endpoint`);
      if (samePoint(s.a, s.b)) fail(`line ${i} has zero length`);
    } else if (s.type === 'arc') {
      if (!isInt(s.c[0]) || !isInt(s.c[1])) fail(`arc ${i} centre is not on a grid corner`);
      if (!isInt(s.r) || s.r < 1) fail(`arc ${i} radius must be a whole number ≥ 1`);
      if (s.a0 % 90 !== 0 || s.a1 % 90 !== 0) fail(`arc ${i} angles must be multiples of 90°`);
      if (s.a0 === s.a1 || Math.abs(s.a1 - s.a0) > 360) fail(`arc ${i} has a bad sweep`);
    } else {
      fail(`segment ${i} has unknown type`);
    }
    const next = p.outline[(i + 1) % p.outline.length];
    if (!samePoint(segmentEnd(s), segmentStart(next))) fail(`outline is not closed after segment ${i}`);
  }

  const lines = lineEdges(p.outline);
  for (const c of p.connectors) {
    if (!cellKeys.has(`${c.cell[0]},${c.cell[1]}`)) fail(`connector on cell ${c.cell} which is not in cells`);
    if (!('side' in c) && !('diag' in c)) fail('connector needs a side or a diag');
    if (!connectorOnOutline(c, lines)) {
      fail(`connector ${JSON.stringify(c)} is not a full straight edge of the outline`);
    }
  }
}

/** A bespoke file's piece as a piece: its polygon as straight lines, no connectors (it joins what it touches) */
export function bespokePiece(b: BespokeFile['pieces'][number]): PieceDef {
  const pts = b.polygon;
  return {
    id: b.id, bespoke: true, tier: 9, cells: [], connectors: [],
    outline: pts.map((a, i) => ({ type: 'line' as const, a, b: pts[(i + 1) % pts.length] })),
    ...(b.mount ? { mount: b.mount } : {}),
    ...(b.contact !== undefined ? { contact: b.contact } : {}),
    ...(b.relief ? { relief: b.relief } : {}),
    ...(b.turret ? { turret: b.turret } : {}),
    ...(b.detail?.length ? { detail: b.detail } : {}),
    ...(b.frame ? { frame: b.frame } : {}),
    ...(b.skeleton ? { skeleton: b.skeleton } : {}),
    ...(b.under ? { under: true } : {}),
    ...(b.stage ? { stage: b.stage } : {}),
    ...(b.ruin ? { ruin: true } : {}),
  };
}

function validateBespoke(p: PieceDef): void {
  const fail = (msg: string): never => { throw new CatalogError(`bespoke piece "${p.id}": ${msg}`); };
  if (!p.id) fail('missing id');
  if (p.outline.length < 3) fail('needs at least 3 points');
  for (const s of p.outline) if (s.type !== 'line' || ![...s.a, ...s.b].every(Number.isFinite)) fail('points must be numbers');
  if (p.mount && (![...p.mount.at, ...p.mount.dir].every(Number.isFinite) || dhypot(p.mount.dir[0], p.mount.dir[1]) < 1e-6)) fail('mount needs a point and a direction');
}

/** The grid cells a bespoke piece's shape covers some of (it lists none) */
function cellsCovered(convex: Vec2[][]): Vec2[] {
  const cells: Vec2[] = [];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const poly of convex) for (const [x, y] of poly) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  for (let cy = Math.floor(y0); cy < Math.ceil(y1); cy++) {
    for (let cx = Math.floor(x0); cx < Math.ceil(x1); cx++) {
      let a = 0;
      for (const poly of convex) a += convexAreaInBox(poly, cx, cy, cx + 1, cy + 1);
      if (a > 1e-4) cells.push([cx, cy]);
    }
  }
  return cells;
}

function validateCoverage(p: PieceDef, convex: Vec2[][], area: number): void {
  const fail = (msg: string): never => { throw new CatalogError(`piece "${p.id}": ${msg}`); };
  let inCells = 0;
  for (const c of p.cells) {
    let a = 0;
    for (const poly of convex) a += convexAreaInBox(poly, c[0], c[1], c[0] + 1, c[1] + 1);
    if (a < 1e-4) fail(`cell ${c} is listed but the shape doesn't cover any of it`);
    inCells += a;
  }
  const polyArea = convex.reduce((s, poly) => s + signedArea(poly), 0);
  if (Math.abs(inCells - polyArea) > 1e-6) fail('shape extends outside its listed cells');
  // The polyline differs slightly from the true arcs; only gross mismatches mean a bad outline
  if (Math.abs(polyArea - area) > 0.05 * area + 0.01) fail('outline is self-intersecting or wound inconsistently');
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export function buildVariant(p: PieceDef, rot: Rot, flip: boolean, shrink: number): PieceVariant {
  const outline = p.outline.map((s) => transformSegment(s, rot, flip));
  const polygon = flattenOutline(outline);
  const convex = convexDecompose(polygon);
  const convexShrunk = convex.map((c) => shrinkConvex(c, shrink)).filter((c): c is Vec2[] => c !== null);
  // Moments come from a fine polyline; area is exact.
  const fine = flattenOutline(outline, 64);
  return {
    pieceId: p.id,
    index: variantIndex(rot, flip),
    rot,
    flip,
    cells: p.cells.map((c) => transformCell(c, rot, flip)),
    outline,
    connectors: p.connectors.map((c) => transformConnector(c, rot, flip)),
    polygon,
    convex,
    convexShrunk,
    lines: lineEdges(outline),
    area: Math.abs(outlineArea(outline)),
    centroid: polygonCentroid(fine),
    polarMoment: polygonPolarMomentCentroid(fine),
    ...(p.mount ? { mount: transformMount(p.mount, rot, flip) } : {}),
  };
}

function transformMount(m: PieceMount, rot: Rot, flip: boolean): PieceMount {
  // (Directions turn like points do, less the shift: the mirror is x → 1 - x)
  const d = transformDir(m.dir, rot, flip), len = dhypot(d[0], d[1]) || 1;
  return { at: transformPoint(m.at, rot, flip), dir: [d[0] / len, d[1] / len], width: m.width ?? 1 };
}

export function loadCatalog(files: CatalogFiles, opts: { overlapShrink?: number } = {}): Catalog {
  const shrink = opts.overlapShrink ?? 0.01;
  const pieces = new Map<string, PieceDef>();
  const variants = new Map<string, PieceVariant[]>();

  const all = [...files.pieces.pieces, ...(files.bespoke ?? []).flatMap((f) => f.pieces.map(bespokePiece))];
  for (const p of all) {
    if (pieces.has(p.id)) throw new CatalogError(`piece "${p.id}": duplicate id`);
    if (p.bespoke) validateBespoke(p); else validatePiece(p);
    let base: PieceVariant;
    try {
      base = buildVariant(p, 0, false, shrink);
    } catch (e) {
      throw new CatalogError(`piece "${p.id}": ${(e as Error).message}`);
    }
    if (p.bespoke) {
      // Its cells are whatever its shape covers; a shape wound backwards is put right
      if (signedArea(base.polygon) <= 1e-6) throw new CatalogError(`bespoke piece "${p.id}": no area`);
      p.cells = cellsCovered(base.convex);
      base = buildVariant(p, 0, false, shrink);
    } else validateCoverage(p, base.convex, base.area);
    const list: PieceVariant[] = [];
    for (const flip of [false, true]) {
      for (const rot of [0, 1, 2, 3] as Rot[]) list.push(buildVariant(p, rot, flip, shrink));
    }
    pieces.set(p.id, p);
    variants.set(p.id, list);
  }

  const functions = new Map<string, FunctionDef>();
  for (const f of [...files.functions.functions, ...(files.models?.models ?? [])]) {
    if (functions.has(f.id)) throw new CatalogError(`function "${f.id}": duplicate id`);
    if (f.pieces !== '*') {
      for (const id of f.pieces) {
        if (!pieces.has(id)) throw new CatalogError(`function "${f.id}": unknown piece "${id}"`);
      }
    }
    functions.set(f.id, f);
  }
  if (!functions.has('core')) throw new CatalogError('functions: missing "core"');

  const materials = new Map<string, MaterialDef>();
  for (const m of files.materials.materials) {
    if (!(m.density > 0) || !(m.toughness > 0)) throw new CatalogError(`material "${m.id}": density and toughness must be > 0`);
    for (const [h, r] of Object.entries(m.hazards ?? {})) {
      if (!(HAZARDS as readonly string[]).includes(h) || !(r >= 0 && r <= 5)) throw new CatalogError(`material "${m.id}": hazards.${h} must be a hazard (${HAZARDS.join(', ')}) rated 0-5`);
    }
    materials.set(m.id, m);
  }

  // Models: each its own pieces, material and tier
  const families = new Map<string, FunctionDef[]>();
  for (const f of functions.values()) {
    if (!f.model) continue;
    const fail = (msg: string): never => { throw new CatalogError(`model "${f.id}": ${msg}`); };
    if (f.pieces === '*' || !f.pieces.length) fail('needs its own pieces');
    if (!f.family) fail('needs a family');
    if (!f.material || !materials.has(f.material) || materials.get(f.material)!.exclusive) fail(`unknown material "${f.material}"`);
    if (!(Number.isInteger(f.grade) && f.grade! >= 1 && f.grade! <= 5)) fail('grade must be 1..5');
    if (f.legacy) fail("a model can't be legacy");
    if (f.mounting) {
      const r = f.mounting;
      if (!f.weapon) fail('only weapons have mounting rules');
      if (r.attach !== undefined && r.attach !== 'back' && r.attach !== 'any') fail(`mounting.attach "${r.attach}" isn't back or any`);
      if (r.angle !== undefined && r.angle !== 'straight' && r.angle !== 'right') fail(`mounting.angle "${r.angle}" isn't straight or right`);
      if (r.arc !== undefined && !(r.arc > 0 && r.arc <= 360)) fail('mounting.arc must be 1..360 degrees');
      if (r.clear !== undefined && !(Array.isArray(r.clear) && r.clear.every((c) => Array.isArray(c) && c.length === 2 && c.every(Number.isInteger) && c[1] >= 1))) {
        fail('mounting.clear must be [right, ahead] integer cells, ahead ≥ 1');
      }
    }
    families.set(f.family!, [...(families.get(f.family!) ?? []), f]);
  }
  for (const list of families.values()) list.sort((a, b) => (a.unlock?.level ?? 999) - (b.unlock?.level ?? 999));
  const legacyFamily = new Map(Object.entries(files.models?.legacy ?? {}).filter(([fn, fam]) => functions.has(fn) && families.has(fam)));
  // Which functions are weapons / point a facing edge out (isWeaponFn, partNeedsFacing), and each's family
  registerFunctionDefs(functions.values(), legacyFamily);

  return {
    version: files.pieces.catalogVersion,
    pieces,
    variants,
    functions,
    materials,
    pieceIds: [...pieces.values()].filter((p) => !p.bespoke).map((p) => p.id),
    families,
    legacyFamily,
  };
}

export function getVariant(catalog: Catalog, pieceId: string, rot: Rot, flip: boolean): PieceVariant {
  const list = catalog.variants.get(pieceId);
  if (!list) throw new Error(`unknown piece "${pieceId}"`);
  return list[variantIndex(rot, flip)];
}

