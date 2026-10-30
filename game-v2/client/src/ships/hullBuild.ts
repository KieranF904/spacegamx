/**
 * Building a ship's hull to draw (ShipRenderer in flight, the hangar's lit
 * preview): its geometry at full health, each vertex marked with its part and
 * look (hullLook.ts), exposure and volume baked in; its far-off version; and
 * its fixed guns' barrels.
 */

import { pointInConvex, type Catalog, type PieceDetail, type PlacedGeom, type ShipState } from '@space-game/common';
import { LitGeometry } from '../rendering/lighting/LitGeometry';
import { ShipGeometry, type ShipHull } from '../rendering/lighting/ShipBatch';
import { ENGINE_FNS, HULL_MAT, bakeHull, gradeOfMaterial, hullKind } from './hullLook';
import { decorOf } from './partDecor';
import { functionColor, mix } from './shipColors';
import { carve, drawDetail } from './bespokeRelief';

/**
 * A fixed gun's barrel as built (pixels, about its base): its first outline, all of its outline (cracks), its shaded
 * shapes; base, outward normal, length, part
 */
export interface BarrelSpec { pts: number[]; outline: number[][]; parts: { pts: number[]; color: number; glow?: boolean }[]; x0: number; y0: number; nx: number; ny: number; len: number; part: number }
/** A hull as built, at full health (shared by every ship of the same design, parts, colouring and kind) */
export interface HullBuild { hull: ShipHull; barrels: BarrelSpec[] }

/**
 * A hull at full health (the shader darkens hurt parts), each vertex marked
 * with its part and its look (hullLook.ts): hull and armour in their
 * material's colour and surface, the more so the higher its grade, other
 * parts with their grade in their trim; exposure and volume baked in. And
 * its far-off version (flat parts, only glowing hardware).
 *
 * `whole` (a rigid design's: a boss's): every part, built once for good, whatever's come off; each triangle marked
 * with what it needs (ShipGeometry `dep`: layered), so as parts go the shader drops them and bares what was under
 */
/** Parts that carry power: on the game's own ships' materials they glow the more (HULL_MAT `hot`) */
const POWERED = new Set(['conduit', 'generator', 'dash_coil', 'brood_bay', 'pyre_lance', 'magma_mortar', 'heat_vent', 'molten_plate']);

export function buildHull(catalog: Catalog, geoms: PlacedGeom[], ship: ShipState, cs: number, tint?: number, whole = false): HullBuild {
  const g = new ShipGeometry(), far = new ShipGeometry(), barrels: BarrelSpec[] = [], parts: [number, number][] = [];
  const bevel = cs * 0.13;
  const [cx, cy] = ship.derived.com;
  const debris = ship.kind === 'debris';
  // (a skeleton isn't plating: it's drawn under the hull: ShipRenderer)
  const art = ship.blueprint.parts.map((p) => !!catalog.pieces.get(p.piece)?.skeleton);
  const alive = whole ? geoms.map(() => true) : ship.derived.alive;
  const shown = alive.map((a, i) => a && !art[i]);
  // (what holds a detail up: plating, and a skeleton while it's there; built whole, what each lies on: layered)
  const trim = whole ? (d: PieceDetail) => [d] : plating(geoms, alive);
  geoms.forEach((geom, i) => {
    if (!shown[i]) return;
    const part = ship.blueprint.parts[i];
    const from = g.vertexCount;
    // (The game's own ships' materials dress every part made of them: HULL_MAT `any`)
    const own = HULL_MAT[part.material]?.any ? HULL_MAT[part.material] : undefined;
    const shell = part.fn === 'hull' || part.fn === 'armor' || !!own, hm = shell ? HULL_MAT[part.material] : undefined;
    const grade = gradeOfMaterial(catalog, part.material), gk = (grade - 1) / 4;
    const matColor = parseInt((catalog.materials.get(part.material)?.color ?? '#888888').slice(1), 16);
    // Hull and armour take their material's colour (more of it the higher the grade); other parts a touch, more in the trim
    let color = hm ? mix(functionColor(part.fn), matColor, hm.tint) : shell ? mix(functionColor(part.fn), matColor, 0.25) : mix(functionColor(part.fn), matColor, 0.12 * gk);
    // Faction colours or paint
    // (a boss's own material is its own colour: no faction's)
    if (tint !== undefined && !own && (shell || part.fn === 'core')) color = mix(color, tint, part.fn === 'core' ? 0.3 : 0.45);
    if (debris) color = mix(color, 0x333333, 0.45);
    let edge = mix(color, debris ? 0x555c66 : 0xc8d6ea, shell ? 0.22 : 0.3);
    if (!shell && !debris) edge = mix(edge, matColor, 0.15 + 0.6 * gk);

    const pts = geom.polygon.flatMap(([x, y]) => [(x - cx) * cs, (y - cy) * cs]);
    // A bespoke part (a boss's own shape) is carved in relief; the rest are bevelled panels
    const piece = geom.bespoke ? catalog.pieces.get(part.piece) : undefined;
    // (A bespoke drive with its own nozzle detail has no standard hardware drawn on it; its flames still come from it)
    const ownNozzle = piece?.detail?.some((d) => d.kind === 'nozzle' || d.kind === 'bell');
    const decor = ownNozzle ? { polys: [], discs: [], barrels: [], nozzles: [] } : decorOf(geom);
    const toPx = (q: number[]) => q.map((v, k) => (v - (k % 2 ? cy : cx)) * cs);
    // A weapon's mounting base, in its colour (toned), is its body: the rest of the part open
    const basePanels = () => { for (const b of decor.base!) g.panel(toPx(b.pts), mix(color, b.tone > 0 ? 0xffffff : 0, Math.abs(b.tone)), { bevel: b.bevel * cs, edge }); };
    if (piece) {
      const glowCol = own?.emit ? (Math.round(own.emit[0] * 255) << 16) | (Math.round(own.emit[1] * 255) << 8) | Math.round(own.emit[2] * 255) : 0xff8a3a;
      carve(g, geom.convex.map((c) => c.flatMap(([x, y]) => [(x - cx) * cs, (y - cy) * cs])), color, edge, bevel, i + 1, piece.relief, glowCol);
      // Its detail (look only): housings, vents, channels, shards, rings, glows, nozzles
      const crystal = mix(parseInt((catalog.materials.get('pyre_crystal')?.color ?? '#9a8fd0').slice(1), 16), color, 0.15);
      piece.detail?.flatMap(trim).forEach((d, k) => drawDetail(g, d, (x, y) => [(x - cx) * cs, (y - cy) * cs], cs, { body: color, edge, crystal, glow: glowCol }, i * 31 + k, bevel));
    } else if (decor.base) basePanels();
    else g.panel(pts, color, { bevel, edge });
    const decorFrom = g.vertexCount;
    // (on a boss's carved weapon, its base goes over the carving, as hardware)
    if (piece && decor.base) basePanels();

    // Engines and weapons: their hardware (nozzles, breeches, lenses, tubes...) on top (damaged with the part, in the shader)
    const wear = (c: number) => (debris ? mix(c, 0x333333, 0.45) : c);
    for (const d of decor.polys) {
      const o = { glow: debris ? 0 : d.glow ?? 0, bevel: (d.bevel ?? 0) * cs };
      const p = toPx(d.pts);
      if (d.sunk) sunken(g, p, wear(d.color), o.bevel, o.glow); else g.panel(p, wear(d.color), o);
    }
    // An engine's glowing disc (its chamber) takes its grade's glow
    const engineDiscs: [number, number][] = [];
    for (const d of decor.discs) {
      const k0 = g.vertexCount;
      const x = (d.x - cx) * cs, y = (d.y - cy) * cs, sides = d.sides ?? 14;
      if (d.sunk) g.bowl(x, y, d.r * cs, wear(d.color), { rings: 2 }, sides);
      else g.disc(x, y, d.r * cs, wear(d.color), { glow: debris ? 0 : d.glow ?? 0, bevel: (d.bevel ?? 0) * cs }, sides);
      if (!debris && d.glow && ENGINE_FNS.has(part.fn)) engineDiscs.push([k0, g.vertexCount]);
    }
    // Each part a shade lighter or darker than the next (from its place, so it holds still)
    const tone = 0.92 + 0.16 * ((((Math.sin(geom.centroid[0] * 12.9898 + geom.centroid[1] * 78.233) * 43758.5453) % 1) + 1) % 1);
    // Its own colour of glow (negative: the shader takes it from grade's colour slots), stronger where power runs
    // (one that doesn't glow still carries its colour, for its cracks and a wreck's seams: a trace of it)
    const emit = own?.emit && !debris ? Math.max(1e-3, own.glow * (POWERED.has(part.fn) ? own.hot ?? 1 : 1)) : 0;
    const look = {
      // (the game's own ships' parts look as their material does, whatever they are: no kind's own glow)
      kind: own ? (part.fn === 'core' ? 3 : 0) : hullKind(part.fn), tone,
      hull: hm && !debris ? [hm.tile, hm.metal, emit ? -emit : hm.glow, hm.boost] : [-1, debris ? 0.2 : 0.4 + 0.5 * gk, 0, debris ? 0 : gk * 0.9],
      decor: [-1, debris ? 0.2 : 0.4 + 0.5 * gk, 0, debris ? 0 : gk * 0.9],
      // (the glows' palette: the game's own ships' materials take Mk III's gold, whatever their grade)
      grade: [debris ? 1 : own ? 3 : grade, ...(emit ? own!.emit! : [((matColor >> 16) & 255) / 255, ((matColor >> 8) & 255) / 255, (matColor & 255) / 255])],
    };
    g.markPart(from, i, look, decorFrom, engineDiscs);
    parts.push([from, decorFrom]);
    // Far off: the part flat (no bevel), and only its glowing hardware (the rest is too small to see)
    const farFrom = far.vertexCount;
    if (decor.base && !piece) { for (const b of decor.base) far.flat(toPx(b.pts), color); }
    else far.flat(pts, color);
    const farDecor = far.vertexCount, farEngines: [number, number][] = [];
    for (const d of decor.discs) {
      if (!d.glow) continue;
      const k0 = far.vertexCount;
      far.disc((d.x - cx) * cs, (d.y - cy) * cs, d.r * cs, wear(d.color), { glow: debris ? 0 : d.glow }, 8);
      if (!debris && ENGINE_FNS.has(part.fn)) farEngines.push([k0, far.vertexCount]);
    }
    far.markPart(farFrom, i, look, farDecor, farEngines);

    // Fixed weapons' barrels poke out of the facing edge (each its own shapes, in their tones and tinted, so it can recoil and glow)
    for (const b of decor.barrels) {
      const turn = (shape: number[]) => {
        const out: number[] = [];
        for (let k = 0; k < shape.length; k += 2) {
          const u = shape[k] * cs, v = shape[k + 1] * cs;
          out.push(b.n[0] * u + b.t[0] * v, b.n[1] * u + b.t[1] * v);
        }
        return out;
      };
      barrels.push({
        pts: turn(b.shape), outline: b.outline.map(turn), parts: b.parts.map((s) => ({ pts: turn(s.pts), color: s.color, glow: s.glow })),
        x0: (b.base[0] - cx) * cs, y0: (b.base[1] - cy) * cs, nx: b.n[0], ny: b.n[1], len: b.len * cs, part: i,
      });
    }
  });
  // Exposure and volume (each part's vertices share their part's lean); the far hull takes each part's mean
  // (a boss's next stage, beneath its body, baked against itself alone: lit as it'll be seen, bared)
  const layer = ship.blueprint.parts.map((p) => (catalog.pieces.get(p.piece)?.under ? 1 : 0));
  const { expo, bend } = bakeHull(g.pos, geoms, shown, ship.derived.com, cs, parts, layer, g.part);
  g.expo = Array.from(expo); g.bend = Array.from(bend);
  const partMean = new Map<number, number[]>();
  for (const [a, b] of parts) {
    if (b <= a) continue;
    const m = [0, 0, 0, 0, 0, 0];
    for (let k = a; k < b; k++) for (let c = 0; c < 3; c++) { m[c] += expo[k * 3 + c]; m[3 + c] += bend[k * 3 + c]; }
    partMean.set(g.part[a], m.map((v) => v / (b - a)));
  }
  for (let k = 0; k < far.vertexCount; k++) {
    const m = partMean.get(far.part[k]);
    if (m) for (let c = 0; c < 3; c++) { far.expo[k * 3 + c] = m[c]; far.bend[k * 3 + c] = m[3 + c]; }
  }
  return { hull: { full: whole ? layered(g, catalog, geoms, ship, cs) : g, far }, barrels };
}

/** A panel set into the hull: a floor and a rim tilted in (lit on its far side), as a bevel turned inside out */
function sunken(g: LitGeometry, pts: number[], color: number, bevel: number, glow: number): void {
  if (bevel <= 0) { g.flat(pts, color, { glow }); return; }
  const n = pts.length / 2;
  let cx = 0, cy = 0, area = 0;
  for (let i = 0; i < n; i++) { cx += pts[i * 2]; cy += pts[i * 2 + 1]; const j = (i + 1) % n; area += pts[i * 2] * pts[j * 2 + 1] - pts[j * 2] * pts[i * 2 + 1]; }
  cx /= n; cy /= n;
  const inner: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = pts[i * 2], y = pts[i * 2 + 1], k = Math.min(0.45, (bevel * 1.3) / (Math.hypot(cx - x, cy - y) || 1));
    inner.push(x + (cx - x) * k, y + (cy - y) * k);
  }
  g.flat(inner, color, { glow });
  const sgn = area >= 0 ? 1 : -1, tilt = 0.6, tz = Math.sqrt(1 - tilt * tilt), rim = mix(color, 0x000000, 0.25);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, ex = pts[j * 2] - pts[i * 2], ey = pts[j * 2 + 1] - pts[i * 2 + 1], len = Math.hypot(ex, ey) || 1;
    // (facing in: the opposite of a raised bevel's)
    const nx = -(ey / len) * sgn * tilt, ny = (ex / len) * sgn * tilt;
    const a = g.vertex(pts[i * 2], pts[i * 2 + 1], nx, ny, tz, rim, glow), b = g.vertex(pts[j * 2], pts[j * 2 + 1], nx, ny, tz, rim, glow);
    const c = g.vertex(inner[j * 2], inner[j * 2 + 1], nx, ny, tz, color, glow), d = g.vertex(inner[i * 2], inner[i * 2 + 1], nx, ny, tz, color, glow);
    g.tri(a, b, c); g.tri(a, c, d);
  }
}

/** Which parts lie under a point (grid units): through a coarse grid of their bounds */
function partsAt(geoms: PlacedGeom[]): (x: number, y: number, want: (i: number) => boolean) => number[] {
  const B = 2, cells = new Map<number, number[]>(), key = (i: number, j: number) => (i + 4096) * 8192 + j + 4096;
  // (each part's bounds too: most candidates in a cell are out of them, and that's cheaper to test than its shape)
  const box = new Float64Array(geoms.length * 4);
  geoms.forEach((g, i) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of g.polygon) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    box[i * 4] = x0; box[i * 4 + 1] = y0; box[i * 4 + 2] = x1; box[i * 4 + 3] = y1;
    for (let cx = Math.floor(x0 / B); cx <= Math.floor(x1 / B); cx++) for (let cy = Math.floor(y0 / B); cy <= Math.floor(y1 / B); cy++) {
      const k = key(cx, cy), list = cells.get(k);
      if (list) list.push(i); else cells.set(k, [i]);
    }
  });
  return (x, y, want) => {
    const list = cells.get(key(Math.floor(x / B), Math.floor(y / B))), out: number[] = [];
    if (!list) return out;
    for (const i of list) {
      if (x < box[i * 4] || y < box[i * 4 + 1] || x > box[i * 4 + 2] || y > box[i * 4 + 3] || !want(i)) continue;
      const cs = geoms[i].convex;
      for (let k = 0; k < cs.length; k++) if (pointInConvex(cs[k], x, y)) { out.push(i); break; }
    }
    return out;
  };
}

/**
 * Sorting a whole-built layer's triangles by what covers them (`over`: the parts that may): each one that some of
 * those cover all over (its corners, its edges' middles and its middle under one or another) goes once for each of
 * them, shown only once that one's gone (if two cover it, either going bares it: the other, still there, is drawn
 * over it); the rest (some of it out in the open) always. `emit(a, b, c, cover)` (cover -1: always)
 */
function sortCovered(pos: number[], idx: number[], toCell: (x: number, y: number) => [number, number], at: ReturnType<typeof partsAt>, over: (i: number) => boolean, emit: (a: number, b: number, c: number, cover: number) => void): void {
  // (its corners, its edges' middles and its middle: in one buffer, reused)
  const S = new Float64Array(14), covers = new Set<number>();
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    for (let k = 0; k < 3; k++) { const v = idx[t + k], [x, y] = toCell(pos[v * 2], pos[v * 2 + 1]); S[k * 2] = x; S[k * 2 + 1] = y; }
    for (let k = 0; k < 3; k++) { const n = (k + 1) % 3; S[6 + k * 2] = (S[k * 2] + S[n * 2]) / 2; S[7 + k * 2] = (S[k * 2 + 1] + S[n * 2 + 1]) / 2; }
    S[12] = (S[0] + S[2] + S[4]) / 3; S[13] = (S[1] + S[3] + S[5]) / 3;
    covers.clear();
    let all = true;
    for (let k = 0; k < 7; k++) {
      const under = at(S[k * 2], S[k * 2 + 1], over);
      if (!under.length) { all = false; break; }
      for (const i of under) covers.add(i);
    }
    if (all && covers.size) for (const j of covers) emit(a, b, c, j);
    else emit(a, b, c, -1);
  }
}

/**
 * A whole-built hull's triangles, each marked with what it needs (ShipGeometry `dep`): a next stage's (pieces
 * `under`) with the body part over it, to show only once that's gone; a detail reaching off its part with what it
 * lies on there (plating of its own layer, or a skeleton), to go with it (lying on two, it stays while either does)
 */
function layered(g: ShipGeometry, catalog: Catalog, geoms: PlacedGeom[], ship: ShipState, cs: number): ShipGeometry {
  const [cx, cy] = ship.derived.com;
  const under = ship.blueprint.parts.map((p) => !!catalog.pieces.get(p.piece)?.under);
  const art = ship.blueprint.parts.map((p) => !!catalog.pieces.get(p.piece)?.skeleton);
  const at = partsAt(geoms), toCell = (x: number, y: number): [number, number] => [x / cs + cx, y / cs + cy];
  const out = new ShipGeometry(), made = new Map<number, number>();
  // (each field copied straight across: this runs for every vertex of a boss)
  const vert = (v: number, hold: number, cover: number) => {
    const k = (v * 512 + hold + 1) * 512 + cover + 1;
    let n = made.get(k);
    if (n === undefined) {
      n = out.vertexCount;
      const v2 = v * 2, v3 = v * 3, v4 = v * 4;
      out.pos.push(g.pos[v2], g.pos[v2 + 1]);
      out.nrm.push(g.nrm[v3], g.nrm[v3 + 1], g.nrm[v3 + 2]);
      out.col.push(g.col[v4], g.col[v4 + 1], g.col[v4 + 2], g.col[v4 + 3]);
      out.slot.push(g.slot[v]); out.part.push(g.part[v]); out.kind.push(g.kind[v]); out.tone.push(g.tone[v]);
      out.hullMat.push(g.hullMat[v4], g.hullMat[v4 + 1], g.hullMat[v4 + 2], g.hullMat[v4 + 3]);
      out.grade.push(g.grade[v4], g.grade[v4 + 1], g.grade[v4 + 2], g.grade[v4 + 3]);
      out.engine.push(g.engine[v]);
      out.expo.push(g.expo[v3], g.expo[v3 + 1], g.expo[v3 + 2]);
      out.bend.push(g.bend[v3], g.bend[v3 + 1], g.bend[v3 + 2]);
      out.dep.push(hold, cover);
      made.set(k, n);
    }
    return n;
  };
  const tri = (a: number, b: number, c: number, hold: number, cover: number) => out.idx.push(vert(a, hold, cover), vert(b, hold, cover), vert(c, hold, cover));
  // Its next stage's: by what covers them
  const heart: number[] = [], rest: number[] = [];
  for (let t = 0; t < g.idx.length; t += 3) (under[g.part[g.idx[t]]] ? heart : rest).push(g.idx[t], g.idx[t + 1], g.idx[t + 2]);
  sortCovered(g.pos, heart, toCell, at, (i) => !under[i] && !art[i], (a, b, c, cover) => tri(a, b, c, -1, cover));
  // The rest: on its own part, or on what it reaches over
  for (let t = 0; t < rest.length; t += 3) {
    const a = rest[t], b = rest[t + 1], c = rest[t + 2], p = g.part[a];
    const [x, y] = toCell((g.pos[a * 2] + g.pos[b * 2] + g.pos[c * 2]) / 3, (g.pos[a * 2 + 1] + g.pos[b * 2 + 1] + g.pos[c * 2 + 1]) / 3);
    const on = geoms[p].convex.some((q) => pointInConvex(q, x, y)) ? [] : at(x, y, (i) => i !== p && under[i] === under[p]);
    if (!on.length) tri(a, b, c, -1, -1);
    else for (const j of on) tri(a, b, c, j, -1);
  }
  return out;
}

/**
 * A skeleton built whole (LitGeometry about the centre of mass), cut into what each part over it covers (`over`):
 * by covering part (-1: what's open from the start), each shown once that part's gone
 */
export function skeletonCovered(lit: LitGeometry, geoms: PlacedGeom[], com: readonly number[], cs: number, over: (i: number) => boolean): Map<number, LitGeometry> {
  const at = partsAt(geoms), toCell = (x: number, y: number): [number, number] => [x / cs + com[0], y / cs + com[1]];
  const out = new Map<number, { g: LitGeometry; made: Map<number, number> }>();
  sortCovered(lit.pos, lit.idx, toCell, at, over, (a, b, c, cover) => {
    let o = out.get(cover);
    if (!o) out.set(cover, (o = { g: new LitGeometry(), made: new Map() }));
    const { g, made } = o;
    const v = (k: number) => {
      let n = made.get(k);
      if (n === undefined) {
        n = g.vertexCount;
        g.pos.push(lit.pos[k * 2], lit.pos[k * 2 + 1]);
        for (let c2 = 0; c2 < 3; c2++) g.nrm.push(lit.nrm[k * 3 + c2]);
        for (let c2 = 0; c2 < 4; c2++) g.col.push(lit.col[k * 4 + c2]);
        g.slot.push(lit.slot[k]);
        made.set(k, n);
      }
      return n;
    };
    g.idx.push(v(a), v(b), v(c));
  });
  return new Map([...out].map(([k, o]) => [k, o.g]));
}

/**
 * Details that reach out over other parts (a boss core's veins of light, the nodes at their ends) go only as far as
 * there's something under them (plating, or a skeleton: its carapace off, its veins still run out over its bones to
 * what's on it): a vein stops where it runs off what's left (a glowing end where it's cut), a node over nothing goes.
 * (Cells, the ship's frame.)
 */
function plating(geoms: PlacedGeom[], alive: boolean[]): (d: PieceDetail) => PieceDetail[] {
  const polys = geoms.filter((_, i) => alive[i]).map((g) => g.polygon);
  const SLACK = 0.35;
  const on = (x: number, y: number) => polys.some((pg) => {
    let c = false, near = Infinity;
    for (let i = 0, j = pg.length - 1; i < pg.length; j = i++) {
      const [ax, ay] = pg[j], [bx, by] = pg[i];
      if ((by > y) !== (ay > y) && x < ((ax - bx) * (y - by)) / (ay - by) + bx) c = !c;
      const dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
      near = Math.min(near, Math.hypot(x - ax - dx * t, y - ay - dy * t));
    }
    return c || near < SLACK;
  });
  return (d) => {
    if ((d.kind === 'ring' || d.kind === 'glow') && d.at) return on(d.at[0], d.at[1]) ? [d] : [];
    if (d.kind !== 'vein' || !d.poly) return [d];
    const k = d.poly.findIndex(([x, y]) => !on(x, y));
    if (k < 0) return [d];
    if (k < 2) return [];
    // (where it runs off: found along the step it leaves on)
    let [ax, ay] = d.poly[k - 1], [bx, by] = d.poly[k];
    for (let n = 0; n < 8; n++) { const mx = (ax + bx) / 2, my = (ay + by) / 2; if (on(mx, my)) { ax = mx; ay = my; } else { bx = mx; by = my; } }
    return [{ ...d, poly: [...d.poly.slice(0, k), [ax, ay]] }, { kind: 'glow', at: [ax, ay], r: (d.w ?? 0.3) * 0.75, sides: 10 }];
  };
}
