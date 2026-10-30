/**
 * The Pyreclast's cavern under Ashfall (data/terrain/ashfall_cavern.json): one
 * mass of rock with a valley carved through it: a basin in the south where you
 * come down (open behind it: the way back up to the surface), a long winding canyon north, and an
 * arena at its end where the Pyreclast waits. Run: node scripts/terrain/ashfall.mjs [preview.svg]
 *
 *   cliff  the valley's outline, traced round the open ground (ragged), each
 *          point with the way into the rock: the client draws terraced cliffs
 *          falling into the valley along it
 *   mass   the rock along it, as triangles from the outline `DEPTH` into the
 *          rock (solid: ships, shots and beams stop at it)
 *   fill   rock further off (drawn only: nothing can get there)
 *   rocks  boulders along the walls, half sunk in them, and the arena's pillars
 *          (solid; cover from the lance)
 *   streams  lava running over the floor (look only): one down from the vault
 *          and along the canyon, a couple welling out of its walls
 *
 * World units; the surface is RADIUS across.
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
let seed = 20261028;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const round = (v) => Math.round(v);

const RADIUS = 31500;
/** Where you land, and the arena (its middle, where the boss waits; its size) */
const ENTRY = [0, 26500];
const ARENA = [0, -14000];
const ARENA_R = 8000;
/** The canyon: its line from the landing basin to the arena's mouth, and its half-width along it */
const PATH = [[0, 24500], [0, 21000], [3600, 15000], [-3000, 7400], [2600, 400], [0, -5800]];
const HALF = (t) => 1900 + 500 * Math.sin(t * 11) + 300 * Math.sin(t * 23 + 1);
const BASIN = 4200;
/** How far into the rock its solid mass reaches from the valley's outline */
const DEPTH = 5200;

// Smooth value noise, for the outline's raggedness
const H = (i, j) => { const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453; return s - Math.floor(s); };
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), u = x - xi, v = y - yi, su = u * u * (3 - 2 * u), sv = v * v * (3 - 2 * v);
  return (H(xi, yi) * (1 - su) + H(xi + 1, yi) * su) * (1 - sv) + (H(xi, yi + 1) * (1 - su) + H(xi + 1, yi + 1) * su) * sv;
}
const rough = (x, y) => (vnoise(x / 2600, y / 2600) - 0.5) * 1300 + (vnoise(x / 700 + 9, y / 700) - 0.5) * 420;

const lens = PATH.slice(1).map((p, i) => Math.hypot(p[0] - PATH[i][0], p[1] - PATH[i][1]));
const total = lens.reduce((a, b) => a + b, 0);
function toPath(x, y) {
  let best = Infinity, at = 0, run = 0;
  for (let i = 0; i < PATH.length - 1; i++) {
    const [ax, ay] = PATH[i], [bx, by] = PATH[i + 1], ex = bx - ax, ey = by - ay, l = lens[i];
    const t = Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / (l * l)));
    const d = Math.hypot(x - (ax + ex * t), y - (ay + ey * t));
    if (d < best) { best = d; at = (run + t * l) / total; }
    run += l;
  }
  return { d: best, t: at };
}
/** Open ground (with the outline's raggedness): the canyon, the arena, the basin, and the way south out of it */
function open(x, y) {
  const n = rough(x, y);
  const p = toPath(x, y);
  if (p.d < HALF(p.t) + n * 0.6) return true;
  if (Math.hypot(x - ARENA[0], y - ARENA[1]) < ARENA_R + n) return true;
  if (Math.hypot(x - ENTRY[0], y - ENTRY[1]) < BASIN + n * 0.7) return true;
  if (y > ENTRY[1] && Math.abs(x) < 2600 + n * 0.4) return true;
  return false;
}

// ---- The valley's outline: the open ground on a grid, its edge traced round ----
const G = 300, LO = -RADIUS - 3000, N = Math.ceil((2 * RADIUS + 6000) / G);
const cell = new Uint8Array(N * N);
for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) cell[j * N + i] = open(LO + (i + 0.5) * G, LO + (j + 0.5) * G) ? 1 : 0;
const at = (i, j) => (i < 0 || j < 0 || i >= N || j >= N ? 0 : cell[j * N + i]);
// Keep only the valley itself (the open blob round the arena): flood from it
const keep = new Uint8Array(N * N), stack = [[Math.floor((ARENA[0] - LO) / G), Math.floor((ARENA[1] - LO) / G)]];
while (stack.length) {
  const [i, j] = stack.pop();
  if (!at(i, j) || keep[j * N + i]) continue;
  keep[j * N + i] = 1;
  stack.push([i + 1, j], [i - 1, j], [i, j + 1], [i, j - 1]);
}
const inside = (i, j) => (i < 0 || j < 0 || i >= N || j >= N ? 0 : keep[j * N + i]);
// Trace its edge (cell corners, walking with the valley on the left)
let si = -1, sj = -1;
for (let j = 0; j < N && si < 0; j++) for (let i = 0; i < N; i++) if (inside(i, j)) { si = i; sj = j; break; }
const loop = [];
{
  // Corner-based tracing: start at the top-left corner of the first cell, heading east along its top edge
  let x = si, y = sj, dir = 0; // 0 east, 1 south, 2 west, 3 north (corner coordinates)
  const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];
  const x0 = x, y0 = y;
  for (let guard = 0; guard < 400000; guard++) {
    loop.push([x, y]);
    x += DX[dir]; y += DY[dir];
    if (x === x0 && y === y0) break;
    // The four cells round corner (x, y): which way does the edge go on (valley on the right of travel)
    const tl = inside(x - 1, y - 1), tr = inside(x, y - 1), bl = inside(x - 1, y), br = inside(x, y);
    const turn = (d) => {
      // Is the edge leaving the corner in direction d (inside on the right, outside on the left)
      if (d === 0) return br && !tr;
      if (d === 1) return bl && !br;
      if (d === 2) return tl && !bl;
      return tr && !tl;
    };
    // Prefer turning right, then straight, then left
    for (const d of [(dir + 1) % 4, dir, (dir + 3) % 4]) if (turn(d)) { dir = d; break; }
  }
}
// To world, simplified (a point every ~400), smoothed a little
let outline = loop.map(([x, y]) => [LO + x * G, LO + y * G]);
const step = 2;
outline = outline.filter((_, i) => i % step === 0);
for (let pass = 0; pass < 2; pass++) outline = outline.map((p, i) => {
  const a = outline[(i + outline.length - 1) % outline.length], b = outline[(i + 1) % outline.length];
  return [(a[0] + 2 * p[0] + b[0]) / 4, (a[1] + 2 * p[1] + b[1]) / 4];
});
// Which way the rock lies from each point: away from the valley (its outward normal, smoothed)
let area = 0;
for (let i = 0; i < outline.length; i++) { const p = outline[i], q = outline[(i + 1) % outline.length]; area += p[0] * q[1] - q[0] * p[1]; }
const sgn = area >= 0 ? 1 : -1;
const normals = outline.map((p, i) => {
  const a = outline[(i + outline.length - 3) % outline.length], b = outline[(i + 3) % outline.length];
  const ex = b[0] - a[0], ey = b[1] - a[1], l = Math.hypot(ex, ey) || 1;
  return [(-ey / l) * sgn, (ex / l) * sgn];
});
// (pointing out of the valley: check against a point just inside)
{
  const p = outline[0], n = normals[0], i = Math.floor((p[0] - n[0] * 400 - LO) / G), j = Math.floor((p[1] - n[1] * 400 - LO) / G);
  if (!inside(i, j)) for (const n2 of normals) { n2[0] = -n2[0]; n2[1] = -n2[1]; }
}

// ---- The mass: triangles from the outline into the rock ----
const mass = [];
for (let i = 0; i < outline.length; i++) {
  const j = (i + 1) % outline.length, a = outline[i], b = outline[j], na = normals[i], nb = normals[j];
  const ao = [a[0] + na[0] * DEPTH, a[1] + na[1] * DEPTH], bo = [b[0] + nb[0] * DEPTH, b[1] + nb[1] * DEPTH];
  mass.push([a, b, bo].map((p) => p.map(round)), [a, bo, ao].map((p) => p.map(round)));
}

// ---- Rock further off: drawn only (big flat pieces, nothing reaches them) ----
const fill = [];
const FC = 4200;
for (let gx = -RADIUS - 3000; gx <= RADIUS + 3000; gx += FC) {
  for (let gy = -RADIUS - 3000; gy <= RADIUS + 3000; gy += FC) {
    const x = gx + (rnd() - 0.5) * 900, y = gy + (rnd() - 0.5) * 900;
    // (well clear of the valley: the mass covers what's near it)
    let near = false;
    for (let a = 0; a < 8 && !near; a++) { const d = FC * 0.9; if (inside(Math.floor((x + Math.cos(a) * d - LO) / G), Math.floor((y + Math.sin(a) * d - LO) / G))) near = true; }
    if (near || inside(Math.floor((x - LO) / G), Math.floor((y - LO) / G))) continue;
    const pts = [];
    for (let k = 0; k < 6; k++) { const a = (k / 6) * Math.PI * 2 + 0.2; pts.push([round(x + Math.cos(a) * FC * 0.86), round(y + Math.sin(a) * FC * 0.86)]); }
    fill.push(pts);
  }
}

// ---- Boulders along the walls (half sunk in them), the arena's pillars ----
function rock(x, y, r, sides = 6 + Math.floor(rnd() * 3)) {
  const a0 = rnd() * Math.PI * 2, pts = [];
  for (let k = 0; k < sides; k++) {
    const a = a0 + (k / sides) * Math.PI * 2 + (rnd() - 0.5) * 0.3, d = r * (0.8 + 0.2 * rnd());
    pts.push([round(x + Math.cos(a) * d), round(y + Math.sin(a) * d)]);
  }
  return pts;
}
const rocks = [];
for (let i = 0; i < outline.length; i += 3) {
  if (rnd() < 0.45) continue;
  const p = outline[i], n = normals[i], r = 260 + rnd() * 520;
  // (not in the way out south)
  if (p[1] > ENTRY[1] + 1500) continue;
  rocks.push(rock(p[0] + n[0] * r * 0.2, p[1] + n[1] * r * 0.2, r));
  // a smaller one beside it, now and then
  if (rnd() < 0.4) rocks.push(rock(p[0] - n[0] * r * 0.5 + (rnd() - 0.5) * r, p[1] - n[1] * r * 0.5 + (rnd() - 0.5) * r, r * 0.4));
}
for (let k = 0; k < 8; k++) {
  const a = (k / 8) * Math.PI * 2 + 0.3 + (rnd() - 0.5) * 0.4, d = 4300 + rnd() * 1500;
  rocks.push(rock(ARENA[0] + Math.cos(a) * d, ARENA[1] + Math.sin(a) * d, 520 + rnd() * 300));
}

// ---- Lava streams (look only): each a line of points and its width at each ----
let seed2 = 7741;
const rnd2 = () => { seed2 = (seed2 * 1664525 + 1013904223) >>> 0; return seed2 / 4294967296; };
/** The canyon's line at distance `s` along it (from the basin): the point and the way along */
function along(s) {
  let run = 0;
  for (let i = 0; i < PATH.length - 1; i++) {
    const l = lens[i];
    if (s <= run + l || i === PATH.length - 2) {
      const t = Math.max(0, Math.min(1, (s - run) / l)), [ax, ay] = PATH[i], [bx, by] = PATH[i + 1];
      return { x: ax + (bx - ax) * t, y: ay + (by - ay) * t, dx: (bx - ax) / l, dy: (by - ay) / l };
    }
    run += l;
  }
}
const openAt = (x, y) => inside(Math.floor((x - LO) / G), Math.floor((y - LO) / G));
/** Smooth a line of control points through Catmull-Rom, a point every ~`step` */
function spline(ctrl, step = 220) {
  const out = [];
  for (let i = 0; i < ctrl.length - 1; i++) {
    const p0 = ctrl[Math.max(0, i - 1)], p1 = ctrl[i], p2 = ctrl[i + 1], p3 = ctrl[Math.min(ctrl.length - 1, i + 2)];
    const n = Math.max(1, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / step));
    for (let k = 0; k < n; k++) {
      const t = k / n, t2 = t * t, t3 = t2 * t;
      const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  out.push(ctrl[ctrl.length - 1]);
  return out;
}
/** A stream along `ctrl`, `w` wide at its fullest (narrower where it wells up and where it thins out), wandering a little */
function stream(ctrl, w) {
  const pts = spline(ctrl), n = pts.length;
  // (a wander across its line, so it never runs ruler-straight)
  const wob = pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)], ex = b[0] - a[0], ey = b[1] - a[1], l = Math.hypot(ex, ey) || 1;
    const o = (vnoise(i * 0.21 + w, 3.7) - 0.5) * w * 1.6;
    return [p[0] - (ey / l) * o, p[1] + (ex / l) * o];
  });
  const width = wob.map((_, i) => {
    const t = i / (n - 1);
    return round(w * Math.min(1, t / 0.12 + 0.35) * Math.min(1, (1 - t) / 0.3 + 0.15) * (0.75 + 0.5 * vnoise(i * 0.37, w)));
  });
  return { pts: wob.map((p) => p.map(round)), w: width };
}
const S = (f) => { const a = along(total * f); return [a.x, a.y]; };
const side = (f, o) => { const a = along(total * f); return [a.x - a.dy * o, a.y + a.dx * o]; };
const streams = [
  // Down from the vault's north-west wall, round the arena's edge, out through its mouth and a long way down the canyon
  stream([[-5600, -20600], [-5200, -18600], [-4300, -15400], [-2800, -11200], [-1100, -7600], S(0.97), side(0.9, 500), side(0.82, -400), side(0.74, 300), side(0.66, -200), S(0.6)], 230),
  // From the north-east wall, joining it at the vault's mouth
  stream([[6900, -17600], [6000, -15800], [4200, -12600], [2400, -9400], [700, -7000], [-600, -6400]], 150),
];
// A couple welling out of the canyon's walls and running down into it
for (const f of [0.5, 0.31]) {
  const a = along(total * f), sx = rnd2() < 0.5 ? 1 : -1;
  // (the wall on that side: out along the canyon's normal until the rock)
  let d = 0;
  while (d < 4000 && openAt(a.x - a.dy * sx * d, a.y + a.dx * sx * d)) d += 60;
  const wall = [a.x - a.dy * sx * (d + 260), a.y + a.dx * sx * (d + 260)];
  streams.push(stream([wall, [a.x - a.dy * sx * d * 0.55, a.y + a.dx * sx * d * 0.55], side(f - 0.03, -sx * 300), side(f - 0.07, sx * 200), side(f - 0.11, 0)], 110 + rnd2() * 40));
}

mkdirSync(join(root, 'data/terrain'), { recursive: true });
writeFileSync(join(root, 'data/terrain/ashfall_cavern.json'), JSON.stringify({
  _comment: 'The Pyreclast\'s cavern under Ashfall (common/src/terrain.ts). Written by scripts/terrain/ashfall.mjs: edit that, not this.',
  cliff: outline.map((p) => p.map(round)), cliffIn: normals.map(([x, y]) => [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000]),
  mass, fill, rocks, streams,
}) + '\n');
console.log(`outline ${outline.length} points, ${mass.length} mass triangles, ${fill.length} fill, ${rocks.length} rocks, ${streams.length} streams`);

const out = process.argv[2];
if (out) {
  const s = 0.02, W = RADIUS * 2.2 * s, T = (x, y) => `${(x * s + W / 2).toFixed(1)},${(y * s + W / 2).toFixed(1)}`;
  const poly = (ps, fillc, stroke = 'none') => `<polygon points="${ps.map(([x, y]) => T(x, y)).join(' ')}" fill="${fillc}" stroke="${stroke}" stroke-width="0.5"/>`;
  const parts = [`<circle cx="${W / 2}" cy="${W / 2}" r="${RADIUS * s}" fill="#5a2a1a"/>`, ...fill.map((p) => poly(p, '#2a2226')), ...mass.map((p) => poly(p, '#3a3036')),
    `<polyline points="${outline.map(([x, y]) => T(x, y)).join(' ')}" fill="none" stroke="#ff8a3a" stroke-width="1.5"/>`, ...rocks.map((p) => poly(p, '#55474d', '#120c0e')),
    ...streams.map((t) => `<polyline points="${t.pts.map(([x, y]) => T(x, y)).join(' ')}" fill="none" stroke="#ffb040" stroke-width="${(t.w[t.w.length >> 1] * s * 1.4).toFixed(1)}"/>`)];
  parts.push(`<circle cx="${ENTRY[0] * s + W / 2}" cy="${ENTRY[1] * s + W / 2}" r="12" fill="#4ade80"/><circle cx="${ARENA[0] * s + W / 2}" cy="${ARENA[1] * s + W / 2}" r="22" fill="#ff3a12"/>`);
  writeFileSync(out, `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${W}" style="background:#07070a">${parts.join('')}</svg>`);
}
