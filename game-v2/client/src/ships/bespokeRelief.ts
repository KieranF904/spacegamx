/**
 * Bespoke parts (bosses' own shapes) in relief, for the hull (hullBuild.ts):
 *
 *   seam    a dark lip just outside every plate, so where plates meet there's
 *           a shadowed groove, and later plates overlap earlier ones like armour
 *   raise   a bevel down to the outline, a chamfer up, a raised top tilted a
 *           few degrees its own way: each face one normal, so light reads clean
 *   recess  the same turned inside out: walls falling in, a dark floor
 *   ridge   a crystal: faces meeting along its long axis
 *
 * and the detail a piece carries (PieceDetail: raised plates, recesses, vents
 * with fins, glowing channels, crystal shards, rings, glows, drive nozzles),
 * drawn on top of it, hurt with it, gone with it.
 */

import type { PieceDetail, PieceRelief } from '@space-game/common';
import type { ShipGeometry } from '../rendering/lighting/ShipBatch';
import { mix } from './shipColors';

/** A steady 0..1 from a few numbers (so a hull comes out the same every time it's built) */
export const seeded = (a: number, b: number, c = 0) => ((((Math.sin(a * 12.9898 + b * 78.233 + c * 37.719) * 43758.5453) % 1) + 1) % 1);

const SEAM = 0x07050a;
const hex = (s: string) => parseInt(s.slice(1), 16);

function centre(pts: number[]): [number, number] {
  let cx = 0, cy = 0;
  const n = pts.length / 2;
  for (let i = 0; i < n; i++) { cx += pts[i * 2]; cy += pts[i * 2 + 1]; }
  return [cx / n, cy / n];
}
const winding = (pts: number[]) => {
  let a = 0;
  const n = pts.length / 2;
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; a += pts[i * 2] * pts[j * 2 + 1] - pts[j * 2] * pts[i * 2 + 1]; }
  return a >= 0 ? 1 : -1;
};
/** Each corner moved `d` towards (or, negative, away from) the middle, never past most of the way */
function inset(pts: number[], d: number): number[] {
  const [cx, cy] = centre(pts), out: number[] = [];
  for (let i = 0; i < pts.length; i += 2) {
    const x = pts[i], y = pts[i + 1], dd = Math.hypot(cx - x, cy - y) || 1, k = Math.max(-1, Math.min(0.42, d / dd));
    out.push(x + (cx - x) * k, y + (cy - y) * k);
  }
  return out;
}
/** A band between an outline and the same outline moved in: each edge's face leaning out by `tilt` (negative: in) */
function band(g: ShipGeometry, outer: number[], inner: number[], tilt: number, cOut: number, cIn: number, glow = 0): void {
  const n = outer.length / 2, sgn = winding(outer), nz = Math.sqrt(1 - tilt * tilt);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ex = outer[j * 2] - outer[i * 2], ey = outer[j * 2 + 1] - outer[i * 2 + 1], len = Math.hypot(ex, ey) || 1;
    const nx = (ey / len) * sgn * tilt, ny = (-ex / len) * sgn * tilt;
    const v0 = g.vertex(outer[i * 2], outer[i * 2 + 1], nx, ny, nz, cOut, glow), v1 = g.vertex(outer[j * 2], outer[j * 2 + 1], nx, ny, nz, cOut, glow);
    const v2 = g.vertex(inner[j * 2], inner[j * 2 + 1], nx, ny, nz, cIn, glow), v3 = g.vertex(inner[i * 2], inner[i * 2 + 1], nx, ny, nz, cIn, glow);
    g.tri(v0, v1, v2); g.tri(v0, v2, v3);
  }
}
/** A flat face (convex), its own normal */
function face(g: ShipGeometry, pts: number[], n: readonly number[], color: number, glow = 0): void {
  const first = g.vertexCount, m = pts.length / 2;
  for (let i = 0; i < m; i++) g.vertex(pts[i * 2], pts[i * 2 + 1], n[0], n[1], n[2], color, glow);
  for (let i = 1; i < m - 1; i++) g.tri(first, first + i, first + i + 1);
}
const unit = (x: number, y: number, z: number) => { const l = Math.hypot(x, y, z) || 1; return [x / l, y / l, z / l]; };
/** A triangle's normal from its corners in 3D, facing up */
function normal3(a: number[], b: number[], c: number[]): number[] {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], wx = c[0] - a[0], wy = c[1] - a[1], wz = c[2] - a[2];
  let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
  if (nz < 0) { nx = -nx; ny = -ny; nz = -nz; }
  return unit(nx, ny, nz);
}

/** Where the line o + t·(ux, uy) crosses a convex outline: [t in, t out], or null */
function clipLine(pts: number[], ox: number, oy: number, ux: number, uy: number): [number, number] | null {
  let t0 = -Infinity, t1 = Infinity;
  const n = pts.length / 2, sgn = winding(pts);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, ax = pts[i * 2], ay = pts[i * 2 + 1], ex = pts[j * 2] - ax, ey = pts[j * 2 + 1] - ay;
    // inside: on the left (sgn > 0) of each edge
    const num = sgn * (ex * (oy - ay) - ey * (ox - ax)), den = sgn * (ex * uy - ey * ux);
    if (Math.abs(den) < 1e-9) { if (num < 0) return null; continue; }
    const t = -num / den;
    if (den > 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
  }
  return t0 < t1 ? [t0, t1] : null;
}
/** The part of a convex outline where n·p <= d (Sutherland–Hodgman, one plane) */
function clipHalf(pts: number[], nx: number, ny: number, d: number): number[] {
  const out: number[] = [], n = pts.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, px = pts[i * 2], py = pts[i * 2 + 1], qx = pts[j * 2], qy = pts[j * 2 + 1];
    const dp = nx * px + ny * py - d, dq = nx * qx + ny * qy - d;
    if (dp <= 0) out.push(px, py);
    if ((dp < 0 && dq > 0) || (dp > 0 && dq < 0)) { const t = dp / (dp - dq); out.push(px + (qx - px) * t, py + (qy - py) * t); }
  }
  return out;
}
/** Every corner cut off `c` along both its edges (never more than a third of an edge): an engineered outline */
function chamfer(pts: number[], c: number): number[] {
  const n = pts.length / 2, out: number[] = [];
  for (let i = 0; i < n; i++) {
    const h = (i + n - 1) % n, j = (i + 1) % n, x = pts[i * 2], y = pts[i * 2 + 1];
    const la = Math.hypot(pts[h * 2] - x, pts[h * 2 + 1] - y) || 1, lb = Math.hypot(pts[j * 2] - x, pts[j * 2 + 1] - y) || 1;
    const ka = Math.min(c, la / 3) / la, kb = Math.min(c, lb / 3) / lb;
    out.push(x + (pts[h * 2] - x) * ka, y + (pts[h * 2 + 1] - y) * ka, x + (pts[j * 2] - x) * kb, y + (pts[j * 2 + 1] - y) * kb);
  }
  return out;
}
const area2 = (pts: number[]) => {
  let a = 0;
  const n = pts.length / 2;
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; a += pts[i * 2] * pts[j * 2 + 1] - pts[j * 2] * pts[i * 2 + 1]; }
  return Math.abs(a) / 2;
};
/** A thin groove from a to b, `w` wide: dark, its far wall catching the light */
function groove(g: ShipGeometry, ax: number, ay: number, bx: number, by: number, w: number, color: number): void {
  const l = Math.hypot(bx - ax, by - ay) || 1, nx = (-(by - ay) / l) * w / 2, ny = ((bx - ax) / l) * w / 2;
  face(g, [ax + nx, ay + ny, bx + nx, by + ny, bx, by, ax, ay], unit(-nx, -ny, Math.hypot(nx, ny) * 1.4), mix(color, SEAM, 0.75));
  face(g, [ax, ay, bx, by, bx - nx, by - ny, ax - nx, ay - ny], unit(nx, ny, Math.hypot(nx, ny) * 1.4), mix(color, 0xffffff, 0.06));
}
/**
 * Panelling across a big plate's top: a border groove in from its edge, then
 * seams across it at intervals (square to its longest side), a few of them
 * ending in a small slot of light
 */
function panelled(g: ShipGeometry, crest: number[], color: number, bevel: number, seed: number, light: number): void {
  const n = crest.length / 2;
  let area = 0, best = 0, ux = 1, uy = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, ex = crest[j * 2] - crest[i * 2], ey = crest[j * 2 + 1] - crest[i * 2 + 1], l = Math.hypot(ex, ey);
    area += crest[i * 2] * crest[j * 2 + 1] - crest[j * 2] * crest[i * 2 + 1];
    if (l > best) { best = l; ux = ex / l; uy = ey / l; }
  }
  if (Math.abs(area) / 2 < (bevel * 16) ** 2) return;
  const gw = bevel * 0.42;
  // The border: a groove all round, a little in
  const border = inset(crest, bevel * 2.4);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    groove(g, border[i * 2], border[i * 2 + 1], border[j * 2], border[j * 2 + 1], gw, color);
  }
  // Seams across, each its own spacing; some cut short of the border, some ending in a light
  const [cx, cy] = centre(border);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) { const s = (border[i * 2] - cx) * ux + (border[i * 2 + 1] - cy) * uy; lo = Math.min(lo, s); hi = Math.max(hi, s); }
  let s = lo + bevel * (7 + 6 * seeded(seed, 11));
  for (let k = 0; s < hi - bevel * 5; k++) {
    const ox = cx + ux * s, oy = cy + uy * s, cut = clipLine(border, ox, oy, -uy, ux);
    if (cut) {
      const [t0, t1] = cut, short = seeded(seed, k, 12) < 0.3 ? (t1 - t0) * 0.35 : 0;
      const fromStart = seeded(seed, k, 13) < 0.5;
      const a0 = t0 + (fromStart ? short : 0), a1 = t1 - (fromStart ? 0 : short);
      groove(g, ox - uy * a0, oy + ux * a0, ox - uy * a1, oy + ux * a1, gw, color);
      if (seeded(seed, k, 14) < 0.35) {
        // A slot of light by the seam's end
        const e = a1 - bevel * 2.2, w = bevel * 0.55, ln = bevel * 1.6, px = ox - uy * e + ux * bevel * 0.9, py = oy + ux * e + uy * bevel * 0.9;
        face(g, [px - ux * w - uy * ln, py - uy * w + ux * ln, px + ux * w - uy * ln, py + uy * w + ux * ln, px + ux * w, py + uy * w, px - ux * w, py - uy * w], [0, 0, 1], light, 0.9);
      }
    }
    s += bevel * (9 + 9 * seeded(seed, k, 15));
  }
}

/** An outline moved by (dx, dy) */
const shifted = (pts: number[], dx: number, dy: number) => pts.map((v, i) => v + (i % 2 ? dy : dx));
/** A plate's side wall: its outline dropped by (sx, sy), its thickness, joined up to its top edge (only the faces turned towards the drop show) */
function walls(g: ShipGeometry, plate: number[], sx: number, sy: number, color: number): void {
  const wall = shifted(plate, sx, sy), m = plate.length / 2, sgn = winding(plate);
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % m, ex = plate[j * 2] - plate[i * 2], ey = plate[j * 2 + 1] - plate[i * 2 + 1], l = Math.hypot(ex, ey) || 1;
    const ox = (ey / l) * sgn, oy = (-ex / l) * sgn;
    if (ox * sx + oy * sy <= 0) continue;
    const nn = unit(ox * 0.85, oy * 0.85, 0.5);
    face(g, [plate[i * 2], plate[i * 2 + 1], plate[j * 2], plate[j * 2 + 1], wall[j * 2], wall[j * 2 + 1], wall[i * 2], wall[i * 2 + 1]], nn, mix(color, SEAM, 0.35));
  }
}

/**
 * Armour laid over a big plate, as a layer of its own: the plate cut into a
 * few slabs across its long side (their ends cut at angles, not square), and
 * over some of them a slab of armour: a shadow cast on the plate below, a side
 * wall (its thickness), and its own top, bevelled, with a seam and bolts
 */
function overlays(g: ShipGeometry, crest: number[], color: number, edge: number, bevel: number, seed: number): void {
  const n = crest.length / 2;
  if (area2(crest) < (bevel * 22) ** 2) return;
  let best = 0, ux = 1, uy = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, ex = crest[j * 2] - crest[i * 2], ey = crest[j * 2 + 1] - crest[i * 2 + 1], l = Math.hypot(ex, ey);
    if (l > best) { best = l; ux = ex / l; uy = ey / l; }
  }
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) { const d = crest[i * 2] * ux + crest[i * 2 + 1] * uy; lo = Math.min(lo, d); hi = Math.max(hi, d); }
  const count = 2 + Math.floor(seeded(seed, 21) * 2);
  // Each cut its own place and its own angle
  const cuts: { d: number; a: number }[] = [{ d: lo - bevel * 4, a: 0 }];
  for (let k = 1; k < count; k++) cuts.push({ d: lo + (hi - lo) * ((k + (seeded(seed, k, 22) - 0.5) * 0.45) / count), a: (seeded(seed, k, 29) - 0.5) * 0.7 });
  cuts.push({ d: hi + bevel * 4, a: 0 });
  // The light comes from up and left (in the hull's own frame): shadows and walls fall down and right
  const sx = bevel * 1.0, sy = bevel * 1.25;
  let laid = 0;
  for (let k = 0; k < count; k++) {
    if (laid > 0 && seeded(seed, k, 23) < 0.35) continue;
    const gap = bevel * 1.6;
    const c0 = cuts[k], c1 = cuts[k + 1];
    // The slab between two cuts, each cut along its own slant
    const n0x = Math.cos(c0.a) * ux - Math.sin(c0.a) * uy, n0y = Math.sin(c0.a) * ux + Math.cos(c0.a) * uy;
    const n1x = Math.cos(c1.a) * ux - Math.sin(c1.a) * uy, n1y = Math.sin(c1.a) * ux + Math.cos(c1.a) * uy;
    // (each cut through its point on the long axis, square to its own slant)
    const [mx, my] = centre(crest), base = mx * ux + my * uy;
    const q0x = mx + ux * (c0.d + gap - base), q0y = my + uy * (c0.d + gap - base), q1x = mx + ux * (c1.d - gap - base), q1y = my + uy * (c1.d - gap - base);
    let slab = clipHalf(crest, -n0x, -n0y, -(n0x * q0x + n0y * q0y));
    slab = clipHalf(slab, n1x, n1y, n1x * q1x + n1y * q1y);
    if (slab.length < 6) continue;
    const plate = chamfer(inset(slab, bevel * 0.5), bevel * 2.6);
    if (plate.length < 6 || area2(plate) < (bevel * 9) ** 2) continue;
    laid++;
    // Its shadow on the plate below, soft at the edge
    face(g, shifted(inset(plate, -bevel * 0.4), sx * 1.9, sy * 1.9), [0, 0, 1], mix(color, SEAM, 0.55));
    face(g, shifted(plate, sx * 1.4, sy * 1.4), [0, 0, 1], mix(color, SEAM, 0.85));
    walls(g, plate, sx, sy, color);
    // Its top: a shade of its own, bevelled, tilted its own way
    const tone = mix(color, seeded(seed, k, 25) < 0.5 ? 0xffffff : 0x8a7aa0, 0.08 + 0.06 * seeded(seed, k, 26));
    const ta = seeded(seed, k, 27) * Math.PI * 2, tk = 0.05 + 0.08 * seeded(seed, k, 28);
    const foot = inset(plate, bevel * 0.8), top = mix(tone, 0xffffff, 0.1), crown = inset(plate, bevel * 1.8);
    band(g, plate, foot, 0.72, mix(edge, 0xffffff, 0.12), tone);
    band(g, foot, crown, 0.32, tone, top);
    face(g, crown, unit(Math.cos(ta) * tk, Math.sin(ta) * tk, 1), top);
    // A seam across it, and bolts at its ends
    const [px, py] = centre(crown), cut = clipLine(crown, px, py, -uy, ux);
    if (cut && seeded(seed, k, 30) < 0.7) {
      const off = (seeded(seed, k, 31) - 0.5) * bevel * 6, ox = px + ux * off, oy = py + uy * off;
      const c2 = clipLine(crown, ox, oy, -uy, ux);
      if (c2) groove(g, ox - uy * (c2[0] + bevel), oy + ux * (c2[0] + bevel), ox - uy * (c2[1] - bevel), oy + ux * (c2[1] - bevel), bevel * 0.45, top);
    }
    const along = clipLine(crown, px, py, ux, uy);
    if (along) for (const t of [along[0] + bevel * 2.2, along[1] - bevel * 2.2]) {
      const bx = px + ux * t, by = py + uy * t;
      face(g, circle(bx, by, bevel * 0.7, 8), [0, 0, 1], mix(top, SEAM, 0.5));
      face(g, circle(bx - bevel * 0.12, by - bevel * 0.12, bevel * 0.45, 8), unit(-0.3, -0.3, 1), mix(top, 0xffffff, 0.2));
    }
  }
}

/** A convex outline standing proud: bevel, chamfer, a top tilted `tilt` towards angle `ta`; big ones panelled and overlaid (`light` >= 0) */
function raised(g: ShipGeometry, pts: number[], color: number, edge: number, bevel: number, ta: number, tk: number, glow = 0, seed = 0, light = -1): void {
  const foot = inset(pts, bevel * 1.1), crest = inset(pts, bevel * 3.0), top = mix(color, 0xffffff, 0.07);
  band(g, pts, foot, 0.72, edge, color, glow);
  band(g, foot, crest, 0.38, color, top, glow);
  face(g, crest, unit(Math.cos(ta) * tk, Math.sin(ta) * tk, 1), top, glow);
  if (light >= 0) {
    panelled(g, crest, top, bevel, seed, light);
    overlays(g, crest, color, edge, bevel, seed);
  }
}
/** A convex outline sunk in: walls falling inwards (lit from the far side), a dark floor */
function sunk(g: ShipGeometry, pts: number[], color: number, bevel: number, floor: number, floorGlow = 0): void {
  const wall = inset(pts, bevel * 1.6);
  band(g, pts, wall, -0.62, mix(color, SEAM, 0.25), mix(color, SEAM, 0.6));
  face(g, wall, [0, 0, 1], floor, floorGlow);
}
/** A crystal: faces meeting along its long axis (its two farthest corners), raised `h` */
function ridged(g: ShipGeometry, pts: number[], color: number, h: number): void {
  const n = pts.length / 2;
  let a = 0, b = 1, best = -1;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const d = Math.hypot(pts[i * 2] - pts[j * 2], pts[i * 2 + 1] - pts[j * 2 + 1]);
    if (d > best) { best = d; a = i; b = j; }
  }
  const px = pts[a * 2], py = pts[a * 2 + 1], qx = pts[b * 2], qy = pts[b * 2 + 1], L = Math.hypot(qx - px, qy - py) || 1;
  // The ridge runs most of the way between them, high in the middle
  const ridge = (t: number): number[] => [px + (qx - px) * t, py + (qy - py) * t, h * Math.sin(Math.PI * Math.min(1, Math.max(0, t)))];
  const along = (x: number, y: number) => Math.max(0.08, Math.min(0.92, ((x - px) * (qx - px) + (y - py) * (qy - py)) / (L * L)));
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const A = [pts[i * 2], pts[i * 2 + 1], 0], B = [pts[j * 2], pts[j * 2 + 1], 0];
    const ra = ridge(along(A[0], A[1])), rb = ridge(along(B[0], B[1]));
    const nn = normal3(A, B, rb[2] > ra[2] ? rb : ra);
    // Each face a little lighter or darker, so the facets read as cut
    const c = mix(color, nn[0] + nn[1] > 0 ? 0xffffff : 0x000000, 0.08);
    const v0 = g.vertex(A[0], A[1], nn[0], nn[1], nn[2], c), v1 = g.vertex(B[0], B[1], nn[0], nn[1], nn[2], c);
    const v2 = g.vertex(rb[0], rb[1], nn[0], nn[1], nn[2], mix(c, 0xffffff, 0.12)), v3 = g.vertex(ra[0], ra[1], nn[0], nn[1], nn[2], mix(c, 0xffffff, 0.12));
    g.tri(v0, v1, v2); g.tri(v0, v2, v3);
  }
}

/** A bespoke part's body: a seam round each of its convex pieces, then the piece in its relief */
export function carve(g: ShipGeometry, pieces: number[][], color: number, edge: number, bevel: number, seed: number, relief: PieceRelief = 'raise', light = 0xff8a3a, soft = false): void {
  // (the seam's lip: near-black on a boss; on a small hull (`soft`), a narrower shadow of the part's own colour, as the
  // grid ships' panels meet, not an inked outline round its silhouette)
  const lipOut = soft ? mix(color, SEAM, 0.62) : SEAM, lipIn = soft ? mix(color, SEAM, 0.4) : mix(SEAM, color, 0.25), lipW = soft ? 0.5 : 0.7;
  // The plate's tilt: one way for the whole part, a few degrees
  const ta = seeded(seed, 0, 1) * Math.PI * 2, tk = 0.05 + 0.08 * seeded(seed, 0, 2);
  // (a rounded part is one cylinder, however it's cut up: its axis and its width taken from the whole of it)
  if (relief === 'round') { cylinder(g, pieces.filter((p) => p.length >= 6), color, bevel, lipOut, lipIn, lipW); return; }
  for (const pts of pieces) {
    if (pts.length < 6) continue;
    // The seam: a dark lip out past the outline (what's drawn later lies over it, as armour overlaps)
    band(g, inset(pts, -bevel * lipW), pts, 0, lipOut, lipIn);
    if (relief === 'plate') {
      // Laid over what's under it: its shadow on that, its side wall, then the plate itself (see overlays)
      const outline = chamfer(pts, bevel * 1.6), sx = bevel * 1.2, sy = bevel * 1.5;
      face(g, shifted(inset(outline, -bevel * 0.6), sx * 2.2, sy * 2.2), [0, 0, 1], mix(color, SEAM, 0.5));
      face(g, shifted(outline, sx * 1.5, sy * 1.5), [0, 0, 1], mix(color, SEAM, 0.85));
      walls(g, outline, sx, sy, color);
      raised(g, outline, mix(color, 0xffffff, 0.04), edge, bevel, ta, tk, 0, seed * 7 + pieces.indexOf(pts), light);
      continue;
    }
    if (relief === 'recess') sunk(g, pts, color, bevel, mix(color, SEAM, 0.55));
    else if (relief === 'ridge') ridged(g, pts, color, bevel * 3.5);
    else raised(g, chamfer(pts, bevel * 1.6), color, edge, bevel, ta, tk, 0, seed * 7 + pieces.indexOf(pts), light);
  }
}

/**
 * A rounded part (a polished drive's casing) as a cylinder along its length: its axis the way it's longest, its
 * normals rolling across it from one side to the other, so a light runs down it in a streak and its sides fall away
 */
function cylinder(g: ShipGeometry, pieces: number[][], color: number, bevel: number, lipOut = SEAM, lipIn = mix(SEAM, color, 0.25), lipW = 0.7): void {
  const all = pieces.flat(), m = all.length / 2;
  let cx = 0, cy = 0;
  for (let i = 0; i < m; i++) { cx += all[i * 2] / m; cy += all[i * 2 + 1] / m; }
  let xx = 0, xy = 0, yy = 0;
  for (let i = 0; i < m; i++) { const dx = all[i * 2] - cx, dy = all[i * 2 + 1] - cy; xx += dx * dx; xy += dx * dy; yy += dy * dy; }
  const ang = 0.5 * Math.atan2(2 * xy, xx - yy), ux = Math.cos(ang), uy = Math.sin(ang), vx = -uy, vy = ux;
  const S = (x: number, y: number) => (x - cx) * ux + (y - cy) * uy, R = (x: number, y: number) => (x - cx) * vx + (y - cy) * vy;
  /** Where a polygon spans across, at `s` along: its [from, to] (or none) */
  const span = (p: number[], s: number): [number, number] | null => {
    let lo = Infinity, hi = -Infinity;
    const n = p.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n, s0 = S(p[i * 2], p[i * 2 + 1]), s1 = S(p[j * 2], p[j * 2 + 1]);
      if ((s0 - s) * (s1 - s) > 0 || s0 === s1) continue;
      const t = (s - s0) / (s1 - s0), r = R(p[i * 2], p[i * 2 + 1]) + (R(p[j * 2], p[j * 2 + 1]) - R(p[i * 2], p[i * 2 + 1])) * t;
      lo = Math.min(lo, r); hi = Math.max(hi, r);
    }
    return hi > lo ? [lo, hi] : null;
  };
  const MAX = 1.25, ACROSS = 8, ALONG = 10;
  // The seam round it first (as every carved part has), then each piece as strips across the whole part's width
  for (const p of pieces) band(g, inset(p, -bevel * lipW), p, 0, lipOut, lipIn);
  for (const p of pieces) {
    const ss = Array.from({ length: p.length / 2 }, (_, i) => S(p[i * 2], p[i * 2 + 1]));
    const s0 = Math.min(...ss), s1 = Math.max(...ss), rows: number[][] = [];
    for (let k = 0; k <= ALONG; k++) {
      const s = s0 + (s1 - s0) * (0.002 + 0.996 * (k / ALONG)), own = span(p, s);
      if (!own) continue;
      const whole = pieces.map((q) => span(q, s)).filter((x): x is [number, number] => !!x);
      const W0 = Math.min(...whole.map((x) => x[0])), W1 = Math.max(...whole.map((x) => x[1])), mid = (W0 + W1) / 2, half = (W1 - W0) / 2 || 1;
      const row: number[] = [];
      for (let a = 0; a <= ACROSS; a++) {
        const r = own[0] + (own[1] - own[0]) * (a / ACROSS), f = Math.max(-1, Math.min(1, (r - mid) / half)), th = f * MAX;
        const nz = Math.cos(th), nv = Math.sin(th);
        // (the sides fall into shadow a little, as a cylinder's do)
        row.push(g.vertex(cx + ux * s + vx * r, cy + uy * s + vy * r, vx * nv, vy * nv, nz, mix(color, SEAM, 0.35 * f * f)));
      }
      rows.push(row);
    }
    for (let k = 0; k < rows.length - 1; k++) for (let a = 0; a < ACROSS; a++) {
      const A = rows[k][a], B = rows[k][a + 1], C = rows[k + 1][a + 1], D = rows[k + 1][a];
      g.tri(A, B, C); g.tri(A, C, D);
    }
  }
}

/** Light round a point: rings from `rim` at its edge to near-white at its middle (glowing, not lit) */
function glowDisc(g: ShipGeometry, x: number, y: number, r: number, sides: number, rim: number, rot = 0): void {
  const layers = 5;
  for (let k = 0; k < layers; k++) {
    const t = k / layers, rr = r * (1 - t * 0.85), pts: number[] = [];
    for (let i = 0; i < sides; i++) { const a = rot + (i / sides) * Math.PI * 2; pts.push(x + Math.cos(a) * rr, y + Math.sin(a) * rr); }
    face(g, pts, [0, 0, 1], mix(rim, 0xfff3d8, t * t), 0.35 + 0.65 * t);
  }
}
function circle(x: number, y: number, r: number, sides: number, rot = 0): number[] {
  const pts: number[] = [];
  for (let i = 0; i < sides; i++) { const a = rot + (i / sides) * Math.PI * 2; pts.push(x + Math.cos(a) * r, y + Math.sin(a) * r); }
  return pts;
}
/** A raised ring: its outer face leaning out, its inner face leaning in, a flat crown between */
function ringOf(g: ShipGeometry, x: number, y: number, r: number, w: number, sides: number, color: number, rot: number): void {
  const o = circle(x, y, r, sides, rot), o2 = circle(x, y, r - w * 0.3, sides, rot), i2 = circle(x, y, r - w * 0.7, sides, rot), i = circle(x, y, r - w, sides, rot);
  const n = sides, sgn = winding(o), top = mix(color, 0xffffff, 0.1);
  band(g, o, o2, 0.7, mix(color, SEAM, 0.3), top);
  // The crown: a flat strip round
  for (let k = 0; k < n; k++) {
    const j = (k + 1) % n;
    const v0 = g.vertex(o2[k * 2], o2[k * 2 + 1], 0, 0, 1, top), v1 = g.vertex(o2[j * 2], o2[j * 2 + 1], 0, 0, 1, top);
    const v2 = g.vertex(i2[j * 2], i2[j * 2 + 1], 0, 0, 1, top), v3 = g.vertex(i2[k * 2], i2[k * 2 + 1], 0, 0, 1, top);
    g.tri(v0, v1, v2); g.tri(v0, v2, v3);
  }
  // Inner face: leaning in (towards the middle)
  for (let k = 0; k < n; k++) {
    const j = (k + 1) % n;
    const mx = (i2[k * 2] + i2[j * 2]) / 2 - x, my = (i2[k * 2 + 1] + i2[j * 2 + 1]) / 2 - y, ml = Math.hypot(mx, my) || 1;
    const nn = unit((-mx / ml) * 0.7, (-my / ml) * 0.7, 0.71);
    const v0 = g.vertex(i2[k * 2], i2[k * 2 + 1], nn[0], nn[1], nn[2], top), v1 = g.vertex(i2[j * 2], i2[j * 2 + 1], nn[0], nn[1], nn[2], top);
    const v2 = g.vertex(i[j * 2], i[j * 2 + 1], nn[0], nn[1], nn[2], mix(color, SEAM, 0.4)), v3 = g.vertex(i[k * 2], i[k * 2 + 1], nn[0], nn[1], nn[2], mix(color, SEAM, 0.4));
    g.tri(v0, v1, v2); g.tri(v0, v2, v3);
  }
  void sgn;
}

export interface DetailColours { body: number; edge: number; crystal: number; glow: number }

/** One detail, `px` mapping its grid points to the hull's (pixels about the centre of mass), `cs` pixels a cell */
export function drawDetail(g: ShipGeometry, d: PieceDetail, px: (x: number, y: number) => [number, number], cs: number, col: DetailColours, seed: number, bevel: number, soft = false): void {
  const own = d.color ? hex(d.color) : undefined;
  // The dark lip round a detail standing proud: black on a boss, where it's a hairline; on a small hull (`soft`) a
  // narrower shadow of what it's on, as the grid ships' panels have it, so stacked trim doesn't read as an inked outline
  const lip = (pts: number[], w: number) => (soft
    ? band(g, inset(pts, -bevel * w * 0.6), pts, 0, mix(col.body, SEAM, 0.5), mix(col.body, SEAM, 0.3))
    : band(g, inset(pts, -bevel * w), pts, 0, SEAM, SEAM));
  // (and its bevel's rim the detail's own colour lifted, not the hull's pale edge: a gold strip stays gold to its edge)
  const rimOf = (c: number) => (soft ? mix(c, 0xffffff, 0.12) : col.edge);
  const poly = d.poly?.flatMap(([x, y]) => px(x, y));
  const at = d.at ? px(d.at[0], d.at[1]) : undefined;
  const r = (d.r ?? 1) * cs, w = (d.w ?? 0.3) * cs;
  switch (d.kind) {
    case 'raise':
      if (poly) {
        lip(poly, 0.6);
        const c = d.crystal ? col.crystal : own ?? mix(col.body, 0xffffff, 0.05);
        raised(g, poly, c, rimOf(c), bevel * 0.8, seeded(seed, 3) * 6.28, 0.08);
      }
      break;
    case 'recess':
      if (poly) sunk(g, poly, own ?? col.body, bevel, mix(col.body, SEAM, 0.7));
      break;
    case 'vent':
      if (poly) {
        const fins = d.fins ?? 5, n = poly.length / 2;
        // The frame: a raised lip round it (leaning out, then in)
        const outer = inset(poly, -bevel * 1.1);
        lip(outer, 0.5);
        band(g, outer, poly, 0.6, mix(col.body, 0xffffff, 0.1), mix(col.body, 0xffffff, 0.04));
        // The recess: walls falling steeply in, dark all the way down
        const floor = inset(poly, bevel * 1.2);
        band(g, poly, floor, -0.8, mix(col.body, SEAM, 0.55), SEAM);
        face(g, floor, [0, 0, 1], SEAM);
        // Light in the gaps: a glowing strip down the floor, under the slats
        const glowStrip = inset(floor, bevel * 0.6);
        face(g, glowStrip, [0, 0, 1], mix(own ?? col.glow, SEAM, 0.5), 0.6);
        // The slats across it: each a sloped louvre (one face to the light, one away), with a dark gap either side
        const a0 = [floor[0], floor[1]], a1 = [floor[2], floor[3]], b0 = [floor[(n - 1) * 2], floor[(n - 1) * 2 + 1]], b1 = [floor[(n - 2) * 2], floor[(n - 2) * 2 + 1]];
        const lerp = (p: number[], q: number[], t: number) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
        for (let k = 0; k < fins; k++) {
          const t0 = (k + 0.18) / fins, t1 = (k + 0.82) / fins, tm = (k + 0.42) / fins;
          const p0 = lerp(a0, a1, t0), p1 = lerp(a0, a1, t1), q1 = lerp(b0, b1, t1), q0 = lerp(b0, b1, t0), pm = lerp(a0, a1, tm), qm = lerp(b0, b1, tm);
          const h = bevel * 1.4;
          const A = [p0[0], p0[1], 0], B = [pm[0], pm[1], h], Cq = [qm[0], qm[1], h], D = [q0[0], q0[1], 0], E = [p1[0], p1[1], 0], F = [q1[0], q1[1], 0];
          const n1 = normal3(A, B, D), n2 = normal3(B, E, Cq);
          const lit = mix(col.body, 0xffffff, 0.2), shade = mix(col.body, SEAM, 0.45);
          face(g, [A[0], A[1], B[0], B[1], Cq[0], Cq[1], D[0], D[1]], n1, lit);
          face(g, [B[0], B[1], E[0], E[1], F[0], F[1], Cq[0], Cq[1]], n2, shade);
        }
      }
      break;
    case 'channel':
      if (poly) {
        band(g, inset(poly, -bevel * 0.7), poly, 0.55, mix(col.body, 0xffffff, 0.08), mix(col.body, 0xffffff, 0.03));
        const floor = inset(poly, bevel * 0.45);
        band(g, poly, floor, -0.8, mix(col.body, SEAM, 0.6), SEAM);
        face(g, floor, [0, 0, 1], SEAM);
        face(g, inset(floor, bevel * 0.25), [0, 0, 1], own ?? col.glow, 0.9);
      }
      break;
    case 'shard':
      if (at && d.dir) {
        const ux = d.dir[0], uy = d.dir[1], vx = -uy, vy = ux;
        const tip = [at[0] + ux * r, at[1] + uy * r], back = [at[0] - ux * w * 0.6, at[1] - uy * w * 0.6];
        const l = [at[0] + vx * w * 0.5 + ux * r * 0.15, at[1] + vy * w * 0.5 + uy * r * 0.15], rr = [at[0] - vx * w * 0.5 + ux * r * 0.15, at[1] - vy * w * 0.5 + uy * r * 0.15];
        const pts = [...back, ...l, ...tip, ...rr];
        lip(pts, 0.5);
        ridged(g, pts, own ?? col.crystal, w * 0.9);
      }
      break;
    case 'ring':
      if (at) ringOf(g, at[0], at[1], r, w, d.sides ?? 24, own ?? mix(col.body, 0xffffff, 0.08), d.sides === 6 ? Math.PI / 6 : 0);
      break;
    case 'glow':
      if (at) glowDisc(g, at[0], at[1], r, d.sides ?? 24, own ?? col.glow, d.sides === 6 ? Math.PI / 6 : 0);
      break;
    case 'vein':
      if (poly && poly.length >= 4) {
        // A vein of light along a path: a dark groove under it, the light tapering from its root
        const m = poly.length / 2;
        for (let k = 0; k < m - 1; k++) {
          const ww = w * (1 - 0.6 * (k / (m - 1)));
          groove(g, poly[k * 2], poly[k * 2 + 1], poly[k * 2 + 2], poly[k * 2 + 3], ww * 2.2, col.body);
        }
        for (let k = 0; k < m - 1; k++) {
          const t = k / (m - 1), t2 = (k + 1) / (m - 1), w0 = (w * (1 - 0.6 * t)) / 2, w1 = (w * (1 - 0.6 * t2)) / 2;
          const ax = poly[k * 2], ay = poly[k * 2 + 1], bx = poly[k * 2 + 2], by = poly[k * 2 + 3], l = Math.hypot(bx - ax, by - ay) || 1;
          const nx = -(by - ay) / l, ny = (bx - ax) / l;
          // (each step a little past its end, so the joints close)
          const ex = ((bx - ax) / l) * w1 * 0.8, ey = ((by - ay) / l) * w1 * 0.8;
          face(g, [ax + nx * w0, ay + ny * w0, bx + ex + nx * w1, by + ey + ny * w1, bx + ex - nx * w1, by + ey - ny * w1, ax - nx * w0, ay - ny * w0], [0, 0, 1],
            mix(own ?? col.glow, 0xfff0c8, 0.55 * (1 - t)), 1);
        }
      }
      break;
    case 'cable':
      if (poly && poly.length >= 4) {
        // A cable lying over the hull along a path: a round tube (three strips, normals rolling across it), a plug at its start
        const c = own ?? mix(col.body, SEAM, 0.72), m = poly.length / 2, hw = w / 2;
        for (let k = 0; k < m - 1; k++) {
          const ax = poly[k * 2], ay = poly[k * 2 + 1], bx = poly[k * 2 + 2], by = poly[k * 2 + 3], l = Math.hypot(bx - ax, by - ay) || 1;
          const ux = (bx - ax) / l, uy = (by - ay) / l, nx = -uy, ny = ux, ex = ux * hw * 0.6, ey = uy * hw * 0.6;
          const strip = (t0: number, t1: number, tilt: number) => face(g, [ax - ex + nx * hw * t0, ay - ey + ny * hw * t0, bx + ex + nx * hw * t0, by + ey + ny * hw * t0, bx + ex + nx * hw * t1, by + ey + ny * hw * t1, ax - ex + nx * hw * t1, ay - ey + ny * hw * t1],
            unit(nx * tilt, ny * tilt, 0.72), c);
          strip(-1, -0.35, -0.7); strip(-0.35, 0.35, 0); strip(0.35, 1, 0.7);
        }
        ringOf(g, poly[0], poly[1], hw * 1.7, hw * 0.8, 10, mix(col.body, 0xffffff, 0.12), 0);
      }
      break;
    case 'beam':
      if (poly && poly.length === 8) {
        // Light thrown from a lamp (its first edge) to what it's aimed at (its far edge): soft layers, brightest down the middle
        const [a0x, a0y, a1x, a1y, b1x, b1y, b0x, b0y] = poly, c = own ?? col.glow;
        for (const [f, k] of [[1, 0.25], [0.6, 0.4], [0.25, 0.65]] as const) {
          const am = [(a0x + a1x) / 2, (a0y + a1y) / 2], bm = [(b0x + b1x) / 2, (b0y + b1y) / 2];
          const q = (x: number, y: number, m: number[]) => [m[0] + (x - m[0]) * f, m[1] + (y - m[1]) * f];
          face(g, [...q(a0x, a0y, am), ...q(a1x, a1y, am), ...q(b1x, b1y, bm), ...q(b0x, b0y, bm)], [0, 0, 1], mix(c, 0xfff0c8, 1 - f), k);
        }
      }
      break;
    case 'halo':
      if (at) {
        const sides = d.sides ?? 24, rot = d.sides === 8 ? Math.PI / 8 : 0, o = circle(at[0], at[1], r, sides, rot), i = circle(at[0], at[1], r - w, sides, rot);
        for (let k = 0; k < sides; k++) {
          const j = (k + 1) % sides;
          face(g, [o[k * 2], o[k * 2 + 1], o[j * 2], o[j * 2 + 1], i[j * 2], i[j * 2 + 1], i[k * 2], i[k * 2 + 1]], [0, 0, 1], own ?? col.glow, 1);
        }
      }
      break;
    case 'bell':
      if (at && d.dir) {
        // A drive's bell: a housing narrowing back from its mouth (`at`, `r` across, `w` long), grooves round it, a dark throat, light deep within
        const ux = d.dir[0], uy = d.dir[1], vx = -uy, vy = ux, len = w;
        const q = (s: number, h: number): [number, number] => [at[0] - ux * s + vx * h, at[1] - uy * s + vy * h];
        const shell = [...q(len, -r * 0.62), ...q(0, -r), ...q(0, r), ...q(len, r * 0.62)];
        lip(shell, 0.6);
        raised(g, shell, mix(col.body, 0xffffff, 0.06), rimOf(mix(col.body, 0xffffff, 0.06)), bevel * 0.7, Math.atan2(uy, ux), 0.12);
        for (const s of [0.3, 0.62]) {
          const h = r * (1 - 0.38 * s) * 0.92, a = q(len * s, -h), b = q(len * s, h);
          groove(g, a[0], a[1], b[0], b[1], bevel * 0.6, col.body);
        }
        // The mouth: the throat, the light
        face(g, [...q(r * 0.36, -r * 0.8), ...q(0, -r * 0.86), ...q(0, r * 0.86), ...q(r * 0.36, r * 0.8)], [0, 0, 1], mix(col.body, SEAM, 0.8));
        ringOf(g, at[0] - ux * r * 0.2, at[1] - uy * r * 0.2, r * 0.66, r * 0.14, 20, mix(col.body, SEAM, 0.3), 0);
        glowDisc(g, at[0] - ux * r * 0.2, at[1] - uy * r * 0.2, r * 0.42, 20, own ?? col.glow);
      }
      break;
    case 'nozzle':
      if (at) {
        // The housing (a heavy ring), a second ring sunk inside it, then the light deep within
        ringOf(g, at[0], at[1], r, r * 0.28, 24, mix(col.body, 0xffffff, 0.05), 0);
        face(g, circle(at[0], at[1], r * 0.72, 24), [0, 0, 1], mix(col.body, SEAM, 0.7));
        ringOf(g, at[0], at[1], r * 0.62, r * 0.12, 24, mix(col.body, SEAM, 0.2), 0);
        glowDisc(g, at[0], at[1], r * 0.48, 24, own ?? col.glow);
      }
      break;
  }
}
