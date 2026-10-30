/**
 * A station's look, baked once per build (off the main thread: procedural.ts
 * runs it in the worker). From each piece's lit geometry and the shapes drawn
 * into it (StationGeometry), per vertex:
 *   kind      what it is (plating, windowed hull, strut, armour, solar cells,
 *             hazard paint, dish, tank, glow, dark machinery, paint, vents,
 *             power core, reactor disc, glass dome): its material
 *             (StationMaterials.ts)
 *   panels    atlas coordinates: round shapes about their own centre, arc
 *             segments about the station's, the rest along their long axis;
 *             window strips from where the window discs sat (the discs dropped)
 *   exposure  its openness to space by direction (mean, cos, sin)
 *   height    every shape sits on the highest thing drawn before it under it,
 *             its kind's thickness up; soft sun shadows from the layers above
 *             (16 ways, kept as mean, cos, sin), ambient occlusion
 *   facing    one lean per face (to its layer's edge, plus out from the
 *             station's centre; round shapes domed), about a fifth per vertex
 *   spill     light from windows, beacons, chase lights and glowing parts
 *   grime     refinery soot from the stacks, bastion scorching round the guns
 *
 * Pieces that turn (the spinner, turret heads) are baked in their own frame:
 * what they see of the rest of the station, and what the rest sees of them,
 * is averaged round their centre, so the bake holds at any angle.
 *
 * Plain data in and out (no Pixi), so it runs in a worker.
 */

export interface StationShape { call: string; v0: number; v1: number; color: number; glow: number; pts: number[]; r: number }
/** A glass dome: centre, glass radius, and its panes' tints as [vertex, tint, vertex, tint, …] */
export interface StationDome { cx: number; cy: number; r: number; pane: number[] }

export interface BakePiece {
  pos: Float32Array; nrm: Float32Array; col: Float32Array; idx: Uint32Array; shapes: StationShape[];
  /** Where its origin sits in the station (what it turns about, if it turns) */
  x: number; y: number;
  rotor: boolean;
  domes: StationDome[];
}
export interface BakeInput {
  design: string; R: number; tileW: number;
  /** The body first, then the parts that turn */
  pieces: BakePiece[];
  navTips: { x: number; y: number; color: number }[];
  chase: { x: number; y: number }[];
  chaseColor: number;
  guns: number[][];
}
/** One piece's new geometry, three vertices to a triangle, in its own frame */
export interface BakedPiece {
  count: number;
  pos: Float32Array; nrm: Float32Array; col: Float32Array; expo: Float32Array; mat: Float32Array;
  uv: Float32Array; win: Float32Array; shadow: Float32Array; bend: Float32Array; spill: Float32Array;
}
export interface BakeOutput { pieces: BakedPiece[]; ms: number }

/** Atlas tiles (stationTextures.ts TILE) */
export const T = { PLATE: 0, ARMOUR: 1, MACH: 2, WIN2: 3, WIN1: 4, SOLAR: 5, HAZARD: 6, SMOOTH: 7, HEX: 8, SOLAR2: 9, GRAIN: 10 } as const;
/** Material kinds */
export const K = { HULL: 0, WIN2: 1, WIN1: 2, STRUT: 3, ARMOUR: 4, SOLAR: 5, HAZARD: 6, DISH: 7, TANK: 8, EMIS: 9, DARK: 10, PAINT: 11, LEGACY: 12, VENT: 13, CORE: 14, REACTOR: 15, DOME: 16 } as const;
export const NK = 17;

/** Colours of the parts the look adds (stationLook.ts) */
export const LOOK_COLORS = { DOME_C: 0x1e5560, FRAME_C: 0x8a96a6, BODY_C: 0x9aa4b2, SEAM_C: 0x6c7582, MULL_C: 0x8b97a7, CAP_C: 0x9ba5b3, AMBER_P: 0x4a2410 };
const { DOME_C, MULL_C, CAP_C, AMBER_P } = LOOK_COLORS;

const PANELS = [0x1c3557, 0x4f78a8, 0x4a2410], GUN = [0x8d96a3, 0x6a737f, 0x434b56, 0x7a838f, 0x5c6470];
const CARGO = [0xb5523b, 0x3b7fb5, 0xd0a23a, 0x4f9a5a, 0x8c8f96];
const TANKS = [0x9aa3ad, 0xc2ae8e, 0xd8dde4, 0xc9b48a, 0xd9dde4];
const DARKS = [0x3a4250, 0x252b36, 0x2c2624, 0x14181e, 0x2a2f38, 0x4a403b, 0x2c333f, 0x4a4f58, 0x5a6370, 0x353c46, 0x3d4048, 0x4a4f5c];
const WINDOWS = [0xffd890, 0xcfe9ff];
/** How thick each kind sits on what's under it (× R) */
const THICK = [0.14, 0.14, 0.14, 0.04, 0.15, 0.02, 0.06, 0.05, 0.22, 0.02, 0.07, 0.03, 0, 0.07, 0.07, 0.03, 0.1];
const SUN_ELEV = 0.55;

function kindOf(s: StationShape, R: number, design: string): number {
  const c = s.color;
  if (c === DOME_C) return K.DOME;
  if (s.glow >= 0.3) return K.EMIS;
  if (design === 'refinery' && c === 0x4a403b) return K.VENT;
  if (c === 0x3a4250 && s.call === 'disc') return K.CORE;
  if (c === 0x252b36) return K.REACTOR;
  if (s.call === 'bowl' || c === 0xc9d0da || (s.call === 'disc' && c === 0x8d98a8 && s.r > R * 0.5)) return K.DISH;
  if (c === 0xd9a640) return s.call === 'flat' ? K.PAINT : K.HAZARD;
  if (PANELS.includes(c)) return K.SOLAR;
  if (GUN.includes(c)) return K.ARMOUR;
  if (CARGO.includes(c)) return K.PAINT;
  if (TANKS.includes(c)) return K.TANK;
  if (DARKS.includes(c)) return K.DARK;
  if (s.call === 'bar') return K.STRUT;
  return K.HULL;
}
/** A window disc (dropped: the hull under it gets a window strip instead) */
export const isWindow = (s: StationShape, R: number) => s.call === 'disc' && s.glow >= 1 && WINDOWS.includes(s.color) && s.r < R * 0.03;

const rgbOf = (c: number) => [((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255];

// ---------------------------------------------------------------------------- one piece: kinds, frames, windows, exposure, grime
interface Frame { polar: boolean; round?: boolean; ox: number; oy: number; ex: number; ey: number; th: number; rbar: number; win?: { rows: number[]; s: number; pitch: number; tint: number } }
interface Piece { inp: BakePiece; nv: number; expo: Float32Array; kind: Int8Array; grime: Float32Array; tint: Float32Array; frames: (Frame | null)[]; shapeOf: Int32Array; list: StationShape[]; kinds: number[]; legacyShape: boolean[] }

function inPoly(p: number[], x: number, y: number): boolean {
  let c = false;
  for (let a = 0, n = p.length / 2, b = n - 1; a < n; b = a++) {
    const xa = p[a * 2], ya = p[a * 2 + 1], xb = p[b * 2], yb = p[b * 2 + 1];
    if ((ya > y) !== (yb > y) && x < ((xb - xa) * (y - ya)) / (yb - ya) + xa) c = !c;
  }
  return c;
}
function noise(x: number, y: number): number {
  const h = (i: number, j: number) => { let n = (i * 374761393 + j * 668265263) | 0; n = Math.imul(n ^ (n >>> 13), 1274126177); return ((n ^ (n >>> 16)) >>> 0) / 4294967296; };
  const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j, u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  return (h(i, j) * (1 - u) + h(i + 1, j) * u) * (1 - v) + (h(i, j + 1) * (1 - u) + h(i + 1, j + 1) * u) * v;
}

function piece(g: BakePiece, R: number, design: string, tileW: number, extra: { stacks: number[][]; guns: number[][] }): Piece {
  const list = g.shapes;
  const nv = g.pos.length / 2;
  const shapeOf = new Int32Array(nv).fill(-1);
  list.forEach((s, i) => { for (let v = s.v0; v < s.v1; v++) shapeOf[v] = i; });
  const kinds = list.map((s) => kindOf(s, R, design));
  const legacyShape = list.map((s) => isWindow(s, R));
  // frames: round shapes about their own centre, arc segments about the piece's centre, the rest along their long axis
  // (a hexagon or octagon is plated straight, unless windows ring it)
  const roundCand: (Frame | null)[] = list.map(() => null);
  const frames: (Frame | null)[] = list.map((s, si) => {
    const n = s.pts.length / 2;
    let cx = 0, cy = 0;
    for (let i = 0; i < n; i++) { cx += s.pts[i * 2]; cy += s.pts[i * 2 + 1]; }
    cx /= n; cy /= n;
    let dmin = Infinity, dmax = 0, rmin = Infinity, rmax = 0;
    for (let i = 0; i < n; i++) {
      const d = Math.hypot(s.pts[i * 2] - cx, s.pts[i * 2 + 1] - cy), r = Math.hypot(s.pts[i * 2], s.pts[i * 2 + 1]);
      dmin = Math.min(dmin, d); dmax = Math.max(dmax, d); rmin = Math.min(rmin, r); rmax = Math.max(rmax, r);
    }
    let emin = Infinity, emax = 0;
    for (let i = 0; i < n; i++) { const j = (i + 1) % n, e = Math.hypot(s.pts[j * 2] - s.pts[i * 2], s.pts[j * 2 + 1] - s.pts[i * 2 + 1]); emin = Math.min(emin, e); emax = Math.max(emax, e); }
    if (n >= 6 && dmin > dmax * 0.85 && emin > emax * 0.75) {
      const rf: Frame = { polar: true, round: true, ox: cx, oy: cy, ex: 1, ey: 0, th: 0, rbar: (dmin + dmax) / 2 };
      if (s.call === 'disc' || s.call === 'bowl' || n >= 10) return rf;
      roundCand[si] = rf;
    }
    let twoRadii = n >= 6 && rmax - rmin < rmax * 0.5;
    if (twoRadii) for (let i = 0; i < n; i++) { const r = Math.hypot(s.pts[i * 2], s.pts[i * 2 + 1]); if (Math.min(r - rmin, rmax - r) > (rmax - rmin) * 0.12) twoRadii = false; }
    if (twoRadii) return { polar: true, ox: 0, oy: 0, ex: 1, ey: 0, th: Math.atan2(cy, cx), rbar: (rmin + rmax) / 2 };
    let xx = 0, yy = 0, xy = 0;
    for (let i = 0; i < n; i++) { const dx = s.pts[i * 2] - cx, dy = s.pts[i * 2 + 1] - cy; xx += dx * dx; yy += dy * dy; xy += dx * dy; }
    const a = 0.5 * Math.atan2(2 * xy, xx - yy);
    return { polar: false, ox: cx, oy: cy, ex: Math.cos(a), ey: Math.sin(a), th: 0, rbar: 0 };
  });
  /** A point in a frame: along (u) and across (v), world units (polar: u is the angle) */
  const local = (f: Frame, x: number, y: number): [number, number] => {
    if (f.polar) {
      const dx = x - f.ox, dy = y - f.oy, r = Math.hypot(dx, dy), ref = f.th;
      let a = r < 1e-6 ? ref : Math.atan2(dy, dx);
      a = ref + Math.atan2(Math.sin(a - ref), Math.cos(a - ref));
      return [a, r];
    }
    const dx = x - f.ox, dy = y - f.oy;
    return [dx * f.ex + dy * f.ey, -dx * f.ey + dy * f.ex];
  };
  // windows: each disc onto the topmost shape drawn under it, which takes a window frame from the discs' rows
  const wins = new Map<number, { u: number; v: number; d: number; tint: number }[]>();
  list.forEach((s, i) => {
    if (!legacyShape[i]) return;
    const x = s.pts[0] - s.r, y = s.pts[1];
    for (let j = i - 1; j >= 0; j--) {
      if (legacyShape[j] || kinds[j] === K.EMIS || !inPoly(list[j].pts, x, y)) continue;
      if (roundCand[j]) { frames[j] = roundCand[j]; roundCand[j] = null; }
      const [u, v] = local(frames[j]!, x, y);
      let l = wins.get(j);
      if (!l) wins.set(j, (l = []));
      l.push({ u, v, d: s.r * 2, tint: s.color === WINDOWS[1] ? 1 : 0 });
      break;
    }
  });
  for (const [j, l] of wins) {
    const f = frames[j]!, d = l[0].d;
    const vs = l.map((w) => w.v).sort((a, b) => a - b), rows: number[] = [vs[0]];
    for (const v of vs) if (v - rows[rows.length - 1] > d * 1.5) rows.push(v);
    // spacing along a row (world units; polar: the angle times the row's radius)
    const row0 = l.filter((w) => Math.abs(w.v - rows[0]) < d).map((w) => w.u * (f.polar ? rows[0] : 1)).sort((a, b) => a - b);
    const gaps = row0.slice(1).map((u, k) => u - row0[k]).filter((x) => x > d * 0.5).sort((a, b) => a - b);
    let pitch = Math.min(Math.max(gaps.length ? gaps[0] : d * 3, d * 2.2), d * 3.2);
    const two = rows.length >= 2;
    const rr = two ? [rows[0], rows[rows.length - 1]] : [rows[0]];
    const s = two ? 0.5 / (rr[1] - rr[0]) : 0.1 / d;
    // round: a whole number of windows (×8, a tile) round it, so the pattern meets itself
    if (f.round) { const rw = rr[0], n8 = Math.max(1, Math.round((Math.PI * 2 * rw) / (pitch * 8))); pitch = (Math.PI * 2 * rw) / (n8 * 8); }
    f.win = { rows: rr, s, pitch, tint: l[0].tint };
    kinds[j] = two ? K.WIN2 : K.WIN1;
  }
  // round shapes: a whole number of plating tiles round them
  for (const f of frames) if (f && f.round) { const n = Math.max(1, Math.round((Math.PI * 2 * f.rbar) / tileW)); f.rbar = (n * tileW) / (Math.PI * 2); }

  // exposure: the piece as a grid, then from each vertex how far to clear it going each of 16 ways
  const pos = g.pos, idx = g.idx;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let v = 0; v < nv; v++) { const x = pos[v * 2], y = pos[v * 2 + 1]; x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const cell = R * 0.02, gw = Math.ceil((x1 - x0) / cell) + 2, gh = Math.ceil((y1 - y0) / cell) + 2, grid = new Uint8Array(Math.max(1, gw * gh));
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    if (legacyShape[shapeOf[a]]) continue;
    const ax = pos[a * 2], ay = pos[a * 2 + 1], bx = pos[b * 2], by = pos[b * 2 + 1], cx = pos[c * 2], cy = pos[c * 2 + 1];
    const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(den) < 1e-9) continue;
    const gx0 = Math.floor((Math.min(ax, bx, cx) - x0) / cell), gx1 = Math.ceil((Math.max(ax, bx, cx) - x0) / cell);
    const gy0 = Math.floor((Math.min(ay, by, cy) - y0) / cell), gy1 = Math.ceil((Math.max(ay, by, cy) - y0) / cell);
    for (let gy = Math.max(0, gy0); gy <= Math.min(gh - 1, gy1); gy++) for (let gx = Math.max(0, gx0); gx <= Math.min(gw - 1, gx1); gx++) {
      const px = x0 + (gx + 0.5) * cell, py = y0 + (gy + 0.5) * cell;
      const l1 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / den, l2 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / den;
      if (l1 >= -0.02 && l2 >= -0.02 && 1 - l1 - l2 >= -0.02) grid[gy * gw + gx] = 1;
    }
  }
  const solid = (x: number, y: number) => { const gx = Math.floor((x - x0) / cell), gy = Math.floor((y - y0) / cell); return gx >= 0 && gy >= 0 && gx < gw && gy < gh && grid[gy * gw + gx] === 1; };
  const expo = new Float32Array(nv * 3), DIRS = 16, MAXD = R * 1.2, FALL = R * 0.4;
  for (let v = 0; v < nv; v++) {
    const px = pos[v * 2], py = pos[v * 2 + 1];
    let a0 = 0, a1 = 0, b1 = 0;
    for (let k = 0; k < DIRS; k++) {
      const a = (k / DIRS) * Math.PI * 2, dx = Math.cos(a), dy = Math.sin(a);
      let d = MAXD;
      for (let t = cell * 0.6; t < MAXD; t += cell) if (!solid(px + dx * t, py + dy * t)) { d = t; break; }
      const e = Math.exp(-d / FALL);
      a0 += e; a1 += e * dx; b1 += e * dy;
    }
    expo[v * 3] = a0 / DIRS; expo[v * 3 + 1] = (2 * a1) / DIRS; expo[v * 3 + 2] = (2 * b1) / DIRS;
  }

  // per vertex: kind, grime (soot from the stacks drifting outward; scorching round the guns and in blotches), window tint
  const kind = new Int8Array(nv), grime = new Float32Array(nv), tint = new Float32Array(nv);
  for (let v = 0; v < nv; v++) {
    const si = shapeOf[v];
    kind[v] = si < 0 ? K.HULL : legacyShape[si] ? K.LEGACY : kinds[si];
    tint[v] = si >= 0 ? frames[si]?.win?.tint ?? 0 : 0;
    const x = pos[v * 2], y = pos[v * 2 + 1], k = kind[v];
    if (k === K.EMIS || k === K.LEGACY || k === K.SOLAR) continue;
    let w = 0;
    if (design === 'refinery') {
      for (const [sx, sy] of extra.stacks) {
        const ux = sx / (Math.hypot(sx, sy) || 1), uy = sy / (Math.hypot(sx, sy) || 1), dx = x - sx, dy = y - sy;
        const along = dx * ux + dy * uy, across = -dx * uy + dy * ux;
        const a = along > 0 ? along / (R * 1.3) : along / (R * 0.7);
        w = Math.max(w, 1.3 * Math.exp(-(a * a + (across / (R * 0.7)) ** 2)));
      }
      w = Math.max(w, 0.6 * Math.exp(-((Math.hypot(x, y) / (R * 0.9)) ** 2)));
      w *= 0.55 + 0.75 * noise(x / (R * 0.18), y / (R * 0.18));
    } else if (design === 'bastion' && (k === K.ARMOUR || k === K.STRUT || k === K.DARK)) {
      for (const [gx, gy] of extra.guns) w = Math.max(w, Math.exp(-((Math.hypot(x - gx, y - gy) / (R * 0.55)) ** 2)) * 0.9);
      w = Math.max(w, Math.max(0, noise(x / (R * 0.3) + 7, y / (R * 0.3) + 3) - 0.42) * 2.4);
    }
    grime[v] = Math.min(1, w);
  }
  // glass domes: how far out each vertex sits (0 centre, 1 rim) where the grime would be, its pane's tint; amber cells
  const pane = new Map<number, number>();
  for (const d of g.domes) for (let i = 0; i < d.pane.length; i += 2) pane.set(d.pane[i], d.pane[i + 1]);
  for (let v = 0; v < nv; v++) {
    if (kind[v] === K.SOLAR && list[shapeOf[v]]?.color === AMBER_P) tint[v] = 1;
    if (kind[v] !== K.DOME || !g.domes.length) continue;
    let q = 1;
    for (const d of g.domes) { const dq = Math.hypot(pos[v * 2] - d.cx, pos[v * 2 + 1] - d.cy) / d.r; if (dq < q) q = dq; }
    grime[v] = q; tint[v] = pane.get(v) ?? 0.5;
  }
  return { inp: g, nv, expo, kind, grime, tint, frames, shapeOf, list, kinds, legacyShape };
}

// ---------------------------------------------------------------------------- the station as layers
interface Bake { shadow: Float32Array; bend: Float32Array; spill: Float32Array }
interface Src { x: number; y: number; c: number[]; i: number; rad: number }

/**
 * Over all the pieces in the station's frame (each turning piece at rest, in its own frame):
 *  heights   each shape sits on the highest thing drawn before it under it, its kind's thickness up
 *  shadow    from each vertex, 16 ways: does anything rise above the sun's line that way; soft, as mean, cos, sin
 *  AO        lower layers a little darker; more where a higher layer stands close by
 *  facing    one lean per shape (its vertices' leans to the edge of their layer, averaged, plus out from the station's
 *            centre; round shapes a gentle dome), then 18% of the vertex's own; solar arrays tilt outward
 *  spill     light from the windows, beacons, chase lights and glowing parts, by distance and facing
 */
function bakeLayers(pcs: Piece[], R: number, sources: Src[][]): Bake[] {
  const thick = (s: StationShape, k: number) => (s.call === 'flat' ? 0.006 : s.color === MULL_C ? 0.006 : s.color === CAP_C ? 0.05 : THICK[k]);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const o of pcs) {
    const p = o.inp.pos;
    let rmax = 0;
    for (let v = 0; v < o.nv; v++) {
      const x = o.inp.x + p[v * 2], y = o.inp.y + p[v * 2 + 1];
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      rmax = Math.max(rmax, Math.hypot(p[v * 2], p[v * 2 + 1]));
    }
    if (o.inp.rotor) { x0 = Math.min(x0, o.inp.x - rmax); y0 = Math.min(y0, o.inp.y - rmax); x1 = Math.max(x1, o.inp.x + rmax); y1 = Math.max(y1, o.inp.y + rmax); }
  }
  const cell = R * 0.02;
  x0 -= cell * 4; y0 -= cell * 4;
  const gw = Math.ceil((x1 - x0) / cell) + 8, gh = Math.ceil((y1 - y0) / cell) + 8;

  /** Each shape onto `grid`, in order, on whatever's highest under it; its top kept; cells it covers marked */
  const raster = (o: Piece, grid: Float32Array, cover?: Uint8Array): Float32Array => {
    const g = o.inp, pos = g.pos, idx = g.idx, ox = g.x, oy = g.y, tops = new Float32Array(o.list.length);
    const byShape: number[][] = o.list.map(() => []);
    for (let t = 0; t < idx.length; t += 3) { const si = o.shapeOf[idx[t]]; if (si >= 0) byShape[si].push(t); }
    o.list.forEach((s, si) => {
      if (o.legacyShape[si]) return;
      const cells: number[] = [];
      for (const t of byShape[si]) {
        const ax = ox + pos[idx[t] * 2], ay = oy + pos[idx[t] * 2 + 1];
        const bx = ox + pos[idx[t + 1] * 2], by = oy + pos[idx[t + 1] * 2 + 1];
        const cx = ox + pos[idx[t + 2] * 2], cy = oy + pos[idx[t + 2] * 2 + 1];
        const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
        if (Math.abs(den) < 1e-9) continue;
        const gx0 = Math.floor((Math.min(ax, bx, cx) - x0) / cell), gx1 = Math.ceil((Math.max(ax, bx, cx) - x0) / cell);
        const gy0 = Math.floor((Math.min(ay, by, cy) - y0) / cell), gy1 = Math.ceil((Math.max(ay, by, cy) - y0) / cell);
        for (let gy = Math.max(0, gy0); gy <= Math.min(gh - 1, gy1); gy++) for (let gx = Math.max(0, gx0); gx <= Math.min(gw - 1, gx1); gx++) {
          const px = x0 + (gx + 0.5) * cell, py = y0 + (gy + 0.5) * cell;
          const l1 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / den, l2 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / den;
          if (l1 >= -0.02 && l2 >= -0.02 && 1 - l1 - l2 >= -0.02) cells.push(gy * gw + gx);
        }
      }
      let base = 0;
      for (const c of cells) base = Math.max(base, grid[c]);
      const top = base + thick(s, o.kinds[si]) * R;
      for (const c of cells) { grid[c] = Math.max(grid[c], top); if (cover) cover[c] = 1; }
      tops[si] = top;
    });
    return tops;
  };
  /** `src` averaged round (cx, cy): what a turning piece sees, or shows, over a turn (masked: only the cells it covers) */
  const radialAvg = (src: Float32Array, cx: number, cy: number, mask?: Uint8Array): Float32Array => {
    const nb = Math.ceil(Math.hypot(gw, gh)) + 3, sum = new Float64Array(nb), cnt = new Float64Array(nb), out = new Float32Array(gw * gh);
    const dist = new Float32Array(gw * gh);
    for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
      const c = gy * gw + gx, d = Math.hypot(x0 + (gx + 0.5) * cell - cx, y0 + (gy + 0.5) * cell - cy) / cell, b = Math.floor(d);
      dist[c] = d;
      sum[b] += mask ? (mask[c] ? src[c] : 0) : src[c]; cnt[b]++;
    }
    for (let b = 0; b < nb; b++) sum[b] = cnt[b] ? sum[b] / cnt[b] : 0;
    for (let c = 0; c < out.length; c++) {
      const t = Math.max(0, dist[c] - 0.5), b = Math.min(nb - 2, Math.floor(t)), f = t - b;
      out[c] = sum[b] * (1 - f) + sum[b + 1] * f;
    }
    return out;
  };

  const n = gw * gh, body = new Float32Array(n);
  const tops: Float32Array[] = [], grids: Float32Array[] = [];
  tops[0] = raster(pcs[0], body);
  const seen = body.slice();
  for (let i = 1; i < pcs.length; i++) {
    const o = pcs[i];
    const grid = radialAvg(body, o.inp.x, o.inp.y), cover = new Uint8Array(n);
    tops[i] = raster(o, grid, cover);
    grids[i] = grid;
    const shows = radialAvg(grid, o.inp.x, o.inp.y, cover);
    for (let c = 0; c < n; c++) if (shows[c] > seen[c]) seen[c] = shows[c];
  }
  grids[0] = seen;

  const tanE = Math.tan(SUN_ELEV), DIRS = 16, MAXD = R * 1.4, F = R * 0.22, EPS = R * 0.008, NEAR = R * 0.6;
  const sm = (x: number) => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t); };
  return pcs.map((o, oi) => {
    const g = o.inp, nv = o.nv, grid = grids[oi], shadow = new Float32Array(nv * 3), bend = new Float32Array(nv * 3), spill = new Float32Array(nv * 3);
    let hmax = 0;
    for (const h of grid) hmax = Math.max(hmax, h);
    const at = (x: number, y: number) => { const gx = Math.floor((x - x0) / cell), gy = Math.floor((y - y0) / cell); return gx >= 0 && gy >= 0 && gx < gw && gy < gh ? grid[gy * gw + gx] : 0; };
    // pass 1, per vertex in the station's frame: shadow, the lean to its layer's edge, AO
    const raw = new Float32Array(nv * 2), wpos = new Float32Array(nv * 2), aos = new Float32Array(nv).fill(1), live = new Uint8Array(nv);
    for (let v = 0; v < nv; v++) {
      const si = o.shapeOf[v];
      shadow[v * 3] = 1;
      const px = g.x + g.pos[v * 2], py = g.y + g.pos[v * 2 + 1];
      wpos[v * 2] = px; wpos[v * 2 + 1] = py;
      if (si < 0 || o.legacyShape[si]) continue;
      live[v] = 1;
      const h = tops[oi][si], tSh = (hmax - h) / tanE + R * 0.05;
      let s0 = 0, s1 = 0, s2 = 0, bx = 0, by = 0, hor = 0;
      for (let k = 0; k < DIRS; k++) {
        const a = (k / DIRS) * Math.PI * 2, dx = Math.cos(a), dy = Math.sin(a);
        let occl = 0, hk = 0, dOpen = MAXD;
        for (let t = cell * 0.7; t < MAXD; t += cell) {
          const H = at(px + dx * t, py + dy * t);
          if (t < tSh && H > h + EPS) { const pen = R * 0.01 + 0.07 * t, ex = H - h - t * tanE; if (ex > -pen) occl = Math.max(occl, sm((ex + pen) / (2 * pen))); }
          if (t < NEAR && H > h) hk = Math.max(hk, (H - h) / Math.hypot(H - h, t));
          if (dOpen === MAXD && H < h - EPS) dOpen = t;
          if (t >= tSh && t >= NEAR && dOpen < MAXD) break;
        }
        const vis = 1 - occl;
        s0 += vis; s1 += vis * dx; s2 += vis * dy; hor += hk;
        const wv = Math.exp(-dOpen / F);
        bx += wv * dx; by += wv * dy;
      }
      shadow[v * 3] = s0 / DIRS; shadow[v * 3 + 1] = (2 * s1) / DIRS; shadow[v * 3 + 2] = (2 * s2) / DIRS;
      raw[v * 2] = (2 * bx) / DIRS; raw[v * 2 + 1] = (2 * by) / DIRS;
      aos[v] = Math.min(1, Math.max(0.4, (0.55 + 0.45 * Math.min(1, h / (R * 0.35))) * (1 - (0.7 * hor) / DIRS)));
    }
    // pass 2: one facing per shape (its own average lean, plus out from the station's centre, unless it turns off-centre),
    // round shapes a gentle dome of their own; then 18% of the vertex's own lean so a face isn't perfectly flat
    const ns = o.list.length, fb = new Float32Array(ns * 2), fc = new Float32Array(ns * 3), fr = new Float32Array(ns);
    const outward = !g.rotor || Math.hypot(g.x, g.y) < R * 0.05;
    for (let v = 0; v < nv; v++) {
      const si = o.shapeOf[v];
      if (!live[v]) continue;
      fb[si * 2] += raw[v * 2]; fb[si * 2 + 1] += raw[v * 2 + 1];
      fc[si * 3] += wpos[v * 2]; fc[si * 3 + 1] += wpos[v * 2 + 1]; fc[si * 3 + 2]++;
    }
    for (let si = 0; si < ns; si++) {
      const m = fc[si * 3 + 2];
      if (!m) continue;
      fb[si * 2] /= m; fb[si * 2 + 1] /= m; fc[si * 3] /= m; fc[si * 3 + 1] /= m;
      const cx = fc[si * 3], cy = fc[si * 3 + 1];
      if (outward) {
        const l = Math.hypot(cx, cy), k = (0.32 * Math.min(1, l / (R * 0.8))) / (l || 1);
        fb[si * 2] += cx * k; fb[si * 2 + 1] += cy * k;
      }
      const sh = o.list[si], np = sh.pts.length / 2;
      let rr = 0;
      for (let i = 0; i < np; i++) rr = Math.max(rr, Math.hypot(g.x + sh.pts[i * 2] - cx, g.y + sh.pts[i * 2 + 1] - cy));
      fr[si] = o.frames[si]?.round && rr > R * 0.12 ? rr : 0;
    }
    const srcs = sources[oi];
    for (let v = 0; v < nv; v++) {
      bend[v * 3 + 2] = aos[v];
      if (!live[v]) continue;
      const si = o.shapeOf[v], px = wpos[v * 2], py = wpos[v * 2 + 1], kind = o.kind[v];
      let ex = fb[si * 2] + 0.18 * raw[v * 2], ey = fb[si * 2 + 1] + 0.18 * raw[v * 2 + 1];
      if (fr[si] > 0) { const q = (fr[si] > R * 0.6 ? 0.36 : 0.26) / fr[si]; ex += (px - fc[si * 3]) * q; ey += (py - fc[si * 3 + 1]) * q; }
      if (kind === K.SOLAR) { const l = Math.hypot(px, py) || 1; ex = (0.18 * px) / l; ey = (0.18 * py) / l; }
      if (kind === K.DOME) { ex = 0; ey = 0; }
      // light spill, by the vertex's leaning normal
      if (g.col[v * 4 + 3] < 0.5 && srcs.length) {
        let nx = g.nrm[v * 3] + ex * 2.2, ny = g.nrm[v * 3 + 1] + ey * 2.2, nz = g.nrm[v * 3 + 2];
        const nl = Math.hypot(nx, ny, nz) || 1;
        nx /= nl; ny /= nl; nz /= nl;
        let r = 0, gg = 0, b = 0;
        for (const q of srcs) {
          const dx = q.x - px, dy = q.y - py, d = Math.hypot(dx, dy);
          if (d >= q.rad) continue;
          const lh = R * 0.05, ll = Math.hypot(d, lh), f = (1 - d / q.rad) ** 2 * (Math.max(0, (nx * dx + ny * dy + nz * lh) / ll) + 0.15) * q.i;
          r += q.c[0] * f; gg += q.c[1] * f; b += q.c[2] * f;
        }
        spill[v * 3] = Math.min(0.9, r); spill[v * 3 + 1] = Math.min(0.9, gg); spill[v * 3 + 2] = Math.min(0.9, b);
      }
      bend[v * 3] = ex; bend[v * 3 + 1] = ey;
    }
    return { shadow, bend, spill };
  });
}

/** A piece into its new mesh's arrays, a triangle at a time (so round shapes' mapping can wrap); window discs dropped */
function newGeometry(p: Piece, bk: Bake, tileW: number): BakedPiece {
  const g = p.inp;
  let tris = 0;
  for (let t = 0; t < g.idx.length; t += 3) if (!p.legacyShape[p.shapeOf[g.idx[t]]]) tris++;
  const count = tris * 3;
  const out: BakedPiece = {
    count, pos: new Float32Array(count * 2), nrm: new Float32Array(count * 3), col: new Float32Array(count * 4), expo: new Float32Array(count * 3),
    mat: new Float32Array(count * 4), uv: new Float32Array(count * 2), win: new Float32Array(count * 2),
    shadow: new Float32Array(count * 3), bend: new Float32Array(count * 3), spill: new Float32Array(count * 3),
  };
  let o = 0;
  for (let t = 0; t < g.idx.length; t += 3) {
    const tri = [g.idx[t], g.idx[t + 1], g.idx[t + 2]];
    if (p.legacyShape[p.shapeOf[tri[0]]]) continue;
    const f = p.frames[p.shapeOf[tri[0]]] ?? null;
    const mx = (g.pos[tri[0] * 2] + g.pos[tri[1] * 2] + g.pos[tri[2] * 2]) / 3, my = (g.pos[tri[0] * 2 + 1] + g.pos[tri[1] * 2 + 1] + g.pos[tri[2] * 2 + 1]) / 3;
    const th = f && f.round ? Math.atan2(my - f.oy, mx - f.ox) : undefined;
    for (const v of tri) {
      const x = g.pos[v * 2], y = g.pos[v * 2 + 1];
      out.pos.set([x, y], o * 2);
      out.nrm.set([g.nrm[v * 3], g.nrm[v * 3 + 1], g.nrm[v * 3 + 2]], o * 3);
      out.col.set([g.col[v * 4], g.col[v * 4 + 1], g.col[v * 4 + 2], g.col[v * 4 + 3]], o * 4);
      out.expo.set([p.expo[v * 3], p.expo[v * 3 + 1], p.expo[v * 3 + 2]], o * 3);
      out.mat.set([p.kind[v], p.grime[v], p.tint[v], 0], o * 4);
      for (let q = 0; q < 3; q++) { out.shadow[o * 3 + q] = bk.shadow[v * 3 + q]; out.bend[o * 3 + q] = bk.bend[v * 3 + q]; out.spill[o * 3 + q] = bk.spill[v * 3 + q]; }
      let u = x / tileW, w = y / tileW, wu = 0, wv = 0;
      if (f) {
        let a: number, b: number;
        if (f.polar) {
          const dx = x - f.ox, dy = y - f.oy, r = Math.hypot(dx, dy), ref = th ?? f.th;
          let an = r < 1e-6 ? Math.atan2(my - f.oy, mx - f.ox) : Math.atan2(dy, dx);
          an = ref + Math.atan2(Math.sin(an - ref), Math.cos(an - ref));
          a = an; b = r;
          u = (a * f.rbar) / tileW; w = b / tileW;
        } else {
          a = (x - f.ox) * f.ex + (y - f.oy) * f.ey; b = -(x - f.ox) * f.ey + (y - f.oy) * f.ex;
          u = a / tileW; w = b / tileW;
        }
        if (f.win) {
          const rw = f.win.rows[0];
          wu = (f.polar ? a * rw : a) / (f.win.pitch * 8);
          wv = f.win.rows.length > 1 ? 0.25 + (b - f.win.rows[0]) * f.win.s : 0.5 + (b - f.win.rows[0]) * f.win.s;
        }
      }
      const sc = p.kind[v] === K.VENT ? 0.45 : p.kind[v] === K.CORE ? 0.5 : 1;
      // (a power core is tiled flat: hex tiles mapped round a disc spiral into a moiré)
      if (p.kind[v] === K.CORE) { u = x / tileW; w = y / tileW; }
      out.uv[o * 2] = u * sc; out.uv[o * 2 + 1] = w * sc;
      out.win[o * 2] = wu; out.win[o * 2 + 1] = wv;
      o++;
    }
  }
  return out;
}

/** The whole bake: every piece's new geometry */
export function bakeStation(inp: BakeInput): BakeOutput {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const { design, R, tileW } = inp;
  const body = inp.pieces[0];
  const stacks = body.shapes.filter((s) => s.call === 'disc' && s.color === 0x2c2624).map((s) => [s.pts[0] - s.r, s.pts[1]]);
  const pcs = inp.pieces.map((g, i) => piece(g, R, design, tileW, i === 0 ? { stacks, guns: inp.guns } : { stacks: [], guns: [] }));
  // what lights the hull nearby without being a light: windows, beacons, chase lights, glowing parts (each piece by
  // its own; the body by the nav and chase lights too)
  const sources: Src[][] = pcs.map((o, oi) => {
    const out: Src[] = [];
    o.list.forEach((s, si) => {
      if (o.legacyShape[si]) {
        out.push({ x: o.inp.x + s.pts[0] - s.r, y: o.inp.y + s.pts[1], c: s.color === WINDOWS[1] ? [0.8, 0.9, 1] : [1, 0.82, 0.52], i: 0.18, rad: R * 0.3 });
      } else if (s.glow >= 0.8) {
        const n = s.pts.length / 2;
        let cx = 0, cy = 0, area = 0;
        for (let i = 0; i < n; i++) { const j = (i + 1) % n; cx += s.pts[i * 2] / n; cy += s.pts[i * 2 + 1] / n; area += s.pts[i * 2] * s.pts[j * 2 + 1] - s.pts[j * 2] * s.pts[i * 2 + 1]; }
        const a = Math.sqrt(Math.abs(area) / 2);
        out.push({ x: o.inp.x + cx, y: o.inp.y + cy, c: rgbOf(s.color), i: 0.45 * Math.min(1, a / (R * 0.3)), rad: R * 0.35 + a * 0.8 });
      }
    });
    if (oi === 0) {
      for (const t of inp.navTips) out.push({ x: t.x, y: t.y, c: rgbOf(t.color), i: 0.3, rad: R * 0.6 });
      for (const c of inp.chase) out.push({ x: c.x, y: c.y, c: rgbOf(inp.chaseColor), i: 0.08, rad: R * 0.2 });
    }
    return out;
  });
  const bakes = bakeLayers(pcs, R, sources);
  const pieces = pcs.map((p, i) => newGeometry(p, bakes[i], tileW));
  return { pieces, ms: (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0 };
}

/** The arrays to hand over when a bake crosses threads */
export function bakeTransfers(out: BakeOutput): ArrayBuffer[] {
  const list: ArrayBuffer[] = [];
  for (const p of out.pieces) for (const a of [p.pos, p.nrm, p.col, p.expo, p.mat, p.uv, p.win, p.shadow, p.bend, p.spill]) list.push(a.buffer as ArrayBuffer);
  return list;
}
