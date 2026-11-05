/**
 * The Scrap Mother's Nest Rock (data/terrain/sol_scrap_nest.json; docs/bosses/rework-2026-11.md 9.1): one big asteroid in
 * her pocket of the Drift, with chambers carved into it and tunnels between them, drawn and solid as terrain. Her arena
 * (the Heart) is at its middle, the pocket's origin. Run: node scripts/terrain/scrap_nest.mjs [preview.svg]
 *
 *                      .------ Wreck Gallery ------.
 *                     /       (0,-14000) r3700      \
 *               west ring tunnel               east ring tunnel
 *                   |                                  |
 *             Sorting Floor        THE HEART        Smelter
 *            (-13500,5500)       (0,0) r5600      (13500,4500)
 *                r4300            [her arena]         r4300
 *                    \               ||                /
 *                     \      Throat + BARRIER        /
 *                      '------- The Gullet ---------'
 *                              (0,12500) r3400
 *                                    |
 *                               the Mouth (south face)
 *                                    |
 *                            landing (0,26500), outside
 *
 *   cliffs  every edge between open space (outside, chambers, tunnels: all one, through the Mouth) and the rock, each
 *           traced round on its own (the rock is two pieces: the shell, and the core round the Heart), each point with
 *           the way into the rock and how deep the rock goes there (half the wall: the drawn rock meets in the middle)
 *   mass    the rock along them, as triangles DEPTH in (solid: ships, shots and beams stop at it)
 *   rocks   a few boulders half sunk in the chambers' walls (solid)
 *   streams slag in the Smelter's pool (look only: the lava drawing)
 *   ridges  the scrap heap in the Heart's bowl she lies buried in (look only)
 *   dressing (DenDressing, look only) amber work lamps down the tunnels, cables slung across the chambers, greyseam veins
 *           glowing in the rock's cracks, the Sorting Floor's conveyor belts, plates welded round the Mouth
 *   palette basalt grey, rust in it
 *
 * Every tunnel is at least 3,000 wide: the biggest hulls (about 480 across) turn in them. World units.
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
let seed = 20261105;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const round = (v) => Math.round(v);

/** The rock: its middle and mean radius; the pocket it sits in */
const ROCK_C = [0, 800], ROCK_R = 21000, POCKET = 29000;
export const CHAMBERS = {
  heart: { c: [0, 0], r: 5600, rough: 0.25 },
  gullet: { c: [0, 12500], r: 3400, rough: 0.5 },
  sorting: { c: [-13500, 5500], r: 4300, rough: 0.6 },
  smelter: { c: [13500, 4500], r: 4300, rough: 0.6 },
  gallery: { c: [0, -14000], r: 3700, rough: 0.6 },
};
/** Tunnels: each a line and its half-width (the rough edge never narrows one under 3,000 across) */
const TUNNELS = [
  { name: 'throat', pts: [[0, 4600], [0, 10000]], half: 1500, rough: 0 },
  { name: 'mouth', pts: [[0, 14500], [0, 18000], [0, 25000]], half: 1800, rough: 0.3 },
  { name: 'gullet-sorting', pts: [[-2400, 13600], [-7000, 11600], [-10400, 8700]], half: 1600, rough: 0.25 },
  { name: 'gullet-smelter', pts: [[2400, 13600], [7000, 11400], [10400, 7800]], half: 1600, rough: 0.25 },
  { name: 'west-ring', pts: [[-14200, 1500], [-14000, -5000], [-10000, -10600], [-3000, -14000]], half: 1600, rough: 0.25 },
  { name: 'east-ring', pts: [[14200, 500], [14000, -5000], [10000, -10600], [3000, -14000]], half: 1600, rough: 0.25 },
];
/** The barrier across the Throat (systems.json arena.barrier): in the tunnel's straight, closing it wall to wall */
export const BARRIER_Y = 6250;
/** How far into the rock its solid mass reaches from the edge (walls are 2,000 or more: never through one) */
const DEPTH = 850;

// Smooth value noise, for the edges' raggedness
const H = (i, j) => { const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453; return s - Math.floor(s); };
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), u = x - xi, v = y - yi, su = u * u * (3 - 2 * u), sv = v * v * (3 - 2 * v);
  return (H(xi, yi) * (1 - su) + H(xi + 1, yi) * su) * (1 - sv) + (H(xi, yi + 1) * (1 - su) + H(xi + 1, yi + 1) * su) * sv;
}
const rough = (x, y) => (vnoise(x / 2600, y / 2600) - 0.5) * 900 + (vnoise(x / 700 + 9, y / 700) - 0.5) * 360;

function segDist(x, y, a, b) {
  const ex = b[0] - a[0], ey = b[1] - a[1], l2 = ex * ex + ey * ey || 1;
  const t = Math.max(0, Math.min(1, ((x - a[0]) * ex + (y - a[1]) * ey) / l2));
  return Math.hypot(x - (a[0] + ex * t), y - (a[1] + ey * t));
}
const lineDist = (x, y, pts) => { let d = Infinity; for (let i = 0; i < pts.length - 1; i++) d = Math.min(d, segDist(x, y, pts[i], pts[i + 1])); return d; };

/** Open (not rock): outside the asteroid, or in a chamber or tunnel */
function open(x, y) {
  const n = rough(x, y);
  // The asteroid's own outline: lumpy, a big swell and smaller ones
  const a = Math.atan2(y - ROCK_C[1], x - ROCK_C[0]);
  const lump = 520 * Math.sin(a * 3 + 0.7) + 300 * Math.sin(a * 5 + 2.1) + 200 * Math.sin(a * 9 + 0.3);
  if (Math.hypot(x - ROCK_C[0], y - ROCK_C[1]) > ROCK_R + lump + n * 0.6) return true;
  for (const ch of Object.values(CHAMBERS)) if (Math.hypot(x - ch.c[0], y - ch.c[1]) < ch.r + n * ch.rough) return true;
  // (the outer half of a rough edge only: a tunnel never comes in under its half-width)
  for (const t of TUNNELS) if (lineDist(x, y, t.pts) < t.half + Math.max(0, n) * t.rough) return true;
  return false;
}

// ---- The grid: open or rock; the open ground kept where it joins space (pockets sealed in rock are rock) ----
const G = 200, LO = -POCKET - 1000, N = Math.ceil((2 * POCKET + 2000) / G);
const cell = new Uint8Array(N * N);
for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) cell[j * N + i] = open(LO + (i + 0.5) * G, LO + (j + 0.5) * G) ? 1 : 0;
const keep = new Uint8Array(N * N);
{
  const stack = [[0, 0]];
  while (stack.length) {
    const [i, j] = stack.pop();
    if (i < 0 || j < 0 || i >= N || j >= N || !cell[j * N + i] || keep[j * N + i]) continue;
    keep[j * N + i] = 1;
    stack.push([i + 1, j], [i - 1, j], [i, j + 1], [i, j - 1]);
  }
}
const inside = (i, j) => (i < 0 || j < 0 || i >= N || j >= N ? 1 : keep[j * N + i]);
const cellAt = (x, y) => [Math.floor((x - LO) / G), Math.floor((y - LO) / G)];
const openAt = (x, y) => { const [i, j] = cellAt(x, y); return inside(i, j) === 1; };
for (const [name, ch] of Object.entries(CHAMBERS)) if (!openAt(ch.c[0], ch.c[1])) throw new Error(`chamber ${name} isn't reached from outside`);

// ---- Every edge between open and rock, traced round into loops (open on the right of travel, y down) ----
const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];
/** Directed edges by their start corner: (corner key) -> [dir...] */
const out = new Map();
const ck = (x, y) => x * 100003 + y;
const addEdge = (x, y, d) => { const k = ck(x, y); (out.get(k) ?? out.set(k, []).get(k)).push(d); };
for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
  if (!inside(i, j)) continue;
  if (!inside(i, j - 1)) addEdge(i, j, 0);
  if (!inside(i + 1, j)) addEdge(i + 1, j, 1);
  if (!inside(i, j + 1)) addEdge(i + 1, j + 1, 2);
  if (!inside(i - 1, j)) addEdge(i, j + 1, 3);
}
const loops = [];
for (const [k0, dirs0] of out) {
  while (dirs0.length) {
    let x = Math.floor(k0 / 100003), y = k0 - x * 100003, dir = dirs0.pop();
    const x0 = x, y0 = y, loop = [];
    for (let guard = 0; guard < 2_000_000; guard++) {
      loop.push([x, y]);
      x += DX[dir]; y += DY[dir];
      if (x === x0 && y === y0) break;
      const here = out.get(ck(x, y)) ?? [];
      // (right turn first: hug the open ground)
      const pick = [(dir + 1) % 4, dir, (dir + 3) % 4].find((d) => here.includes(d));
      if (pick === undefined) throw new Error('loop broke at ' + x + ',' + y);
      here.splice(here.indexOf(pick), 1);
      dir = pick;
    }
    if (loop.length > 40) loops.push(loop);
  }
}

// ---- Each loop: to world, simplified, smoothed; the way into the rock; how deep the rock is there ----
const cliffs = [];
const mass = [];
for (const loop of loops) {
  let pts = loop.map(([x, y]) => [LO + x * G, LO + y * G]).filter((_, i) => i % 2 === 0);
  for (let pass = 0; pass < 2; pass++) pts = pts.map((p, i) => {
    const a = pts[(i + pts.length - 1) % pts.length], b = pts[(i + 1) % pts.length];
    return [(a[0] + 2 * p[0] + b[0]) / 4, (a[1] + 2 * p[1] + b[1]) / 4];
  });
  const n = pts.length;
  let normals = pts.map((p, i) => {
    const a = pts[(i + n - 3) % n], b = pts[(i + 3) % n], ex = b[0] - a[0], ey = b[1] - a[1], l = Math.hypot(ex, ey) || 1;
    return [-ey / l, ex / l];
  });
  // (pointing into the rock: most points' 300 along it must be rock)
  const intoRock = normals.filter((nn, i) => !openAt(pts[i][0] + nn[0] * 300, pts[i][1] + nn[1] * 300)).length;
  if (intoRock < n / 2) normals = normals.map(([x, y]) => [-x, -y]);
  // How deep the rock goes along the normal before open ground again: half of it (the far side's rows meet these)
  const depth = pts.map((p, i) => {
    const [nx, ny] = normals[i];
    let d = 120;
    while (d < 16000 && !openAt(p[0] + nx * d, p[1] + ny * d)) d += 100;
    return round(Math.max(300, Math.min(d >= 16000 ? 9000 : d / 2, 9000)));
  });
  cliffs.push({ pts: pts.map((p) => p.map(round)), in: normals.map(([x, y]) => [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000]), depth });
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, a = pts[i], b = pts[j], na = normals[i], nb = normals[j];
    const da = Math.min(DEPTH, depth[i] * 1.6), db = Math.min(DEPTH, depth[j] * 1.6);
    const ao = [a[0] + na[0] * da, a[1] + na[1] * da], bo = [b[0] + nb[0] * db, b[1] + nb[1] * db];
    mass.push([a, b, bo].map((p) => p.map(round)), [a, bo, ao].map((p) => p.map(round)));
  }
}

// ---- Boulders, half sunk in the chambers' walls (never in a tunnel: they'd narrow it) ----
function boulder(x, y, r, sides = 6 + Math.floor(rnd() * 3)) {
  const a0 = rnd() * Math.PI * 2, pts = [];
  for (let k = 0; k < sides; k++) {
    const a = a0 + (k / sides) * Math.PI * 2 + (rnd() - 0.5) * 0.3, d = r * (0.8 + 0.2 * rnd());
    pts.push([round(x + Math.cos(a) * d), round(y + Math.sin(a) * d)]);
  }
  return pts;
}
const rocks = [];
const inTunnel = (x, y, pad) => TUNNELS.some((t) => lineDist(x, y, t.pts) < t.half + pad);
for (const [name, ch] of Object.entries(CHAMBERS)) {
  const count = name === 'heart' ? 14 : 7;
  for (let k = 0; k < count; k++) {
    const a = (k / count) * Math.PI * 2 + rnd() * 0.5;
    // (out along the line from the middle to the wall)
    let d = ch.r * 0.6;
    while (d < ch.r * 1.4 && openAt(ch.c[0] + Math.cos(a) * d, ch.c[1] + Math.sin(a) * d)) d += 50;
    const r = 260 + rnd() * 380, x = ch.c[0] + Math.cos(a) * (d - r * 0.2), y = ch.c[1] + Math.sin(a) * (d - r * 0.2);
    if (inTunnel(x, y, r + 600) || Math.abs(y - BARRIER_Y) < 1200) continue;
    rocks.push(boulder(x, y, r));
  }
}

// ---- The Smelter's slag pool, and slag pouring into it from a chute in its east wall (look only) ----
let seed2 = 9931;
const rnd2 = () => { seed2 = (seed2 * 1664525 + 1013904223) >>> 0; return seed2 / 4294967296; };
function spline(ctrl, step = 200) {
  const o = [];
  for (let i = 0; i < ctrl.length - 1; i++) {
    const p0 = ctrl[Math.max(0, i - 1)], p1 = ctrl[i], p2 = ctrl[i + 1], p3 = ctrl[Math.min(ctrl.length - 1, i + 2)];
    const n = Math.max(1, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / step));
    for (let k = 0; k < n; k++) {
      const t = k / n, t2 = t * t, t3 = t2 * t;
      const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      o.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  o.push(ctrl[ctrl.length - 1]);
  return o;
}
function stream(ctrl, w, full = 1) {
  const pts = spline(ctrl), n = pts.length;
  const width = pts.map((_, i) => { const t = i / (n - 1); return round(w * Math.min(1, t / 0.15 + 0.4) * Math.min(1, (1 - t) / 0.25 + full * 0.3) * (0.8 + 0.4 * vnoise(i * 0.4, w))); });
  return { pts: pts.map((p) => p.map(round)), w: width };
}
const SM = CHAMBERS.smelter.c;
const streams = [
  // The chute's run, out of the east wall and down into the pool
  stream([[SM[0] + 3500, SM[1] - 900], [SM[0] + 2600, SM[1] - 500], [SM[0] + 1500, SM[1] - 150], [SM[0] + 600, SM[1] + 150]], 150),
  // The pool: a wide loop round the rich rocks' feet
  stream([[SM[0] + 900, SM[1] + 300], [SM[0] + 200, SM[1] + 1300], [SM[0] - 1200, SM[1] + 1100], [SM[0] - 1500, SM[1] - 200], [SM[0] - 600, SM[1] - 1200], [SM[0] + 700, SM[1] - 900]], 340, 0),
];

// ---- The scrap heap she lies buried in (the Heart's bowl): low ridges round its middle (look only) ----
const ridges = [];
for (let k = 0; k < 5; k++) {
  const a0 = (k / 5) * Math.PI * 2 + 0.4, pts = [], w = [], h = [];
  for (let s = 0; s <= 6; s++) {
    const a = a0 + (s / 6) * 1.0, d = 1700 + 260 * Math.sin(s * 1.7 + k);
    pts.push([round(Math.cos(a) * d), round(Math.sin(a) * d)]);
    const tip = Math.sin((s / 6) * Math.PI);
    w.push(round(140 + 360 * tip)); h.push(round(60 + 260 * tip));
  }
  ridges.push({ pts, w, h });
}

// ---- Dressing (look only): lamps, cables, veins, belts, the Mouth's plates ----
const lamps = [];
for (const t of TUNNELS) {
  for (let i = 0; i < t.pts.length - 1; i++) {
    const a = t.pts[i], b = t.pts[i + 1], l = Math.hypot(b[0] - a[0], b[1] - a[1]), ux = (b[0] - a[0]) / l, uy = (b[1] - a[1]) / l;
    for (let s = 450; s < l; s += 950) for (const side of [-1, 1]) {
      // (on the wall: out across the tunnel until the rock, a little back from it)
      let d = t.half - 400;
      const x0 = a[0] + ux * s, y0 = a[1] + uy * s;
      while (d < t.half + 1400 && openAt(x0 - uy * side * d, y0 + ux * side * d)) d += 40;
      const x = x0 - uy * side * (d - 70), y = y0 + ux * side * (d - 70);
      if (Math.hypot(x, y - BARRIER_Y) < 600 || !openAt(x, y)) continue;
      lamps.push([round(x), round(y)]);
    }
  }
}
// (and round the chambers' walls, more thinly)
for (const ch of Object.values(CHAMBERS)) {
  const k = Math.round(ch.r / 700);
  for (let s = 0; s < k; s++) {
    const a = (s / k) * Math.PI * 2 + 0.2;
    let d = ch.r * 0.7;
    while (d < ch.r * 1.5 && openAt(ch.c[0] + Math.cos(a) * d, ch.c[1] + Math.sin(a) * d)) d += 40;
    const x = ch.c[0] + Math.cos(a) * (d - 80), y = ch.c[1] + Math.sin(a) * (d - 80);
    if (openAt(x, y) && !inTunnel(x, y, 0)) lamps.push([round(x), round(y)]);
  }
}
/** A cable slung between two points on a chamber's wall, sagging (as seen from above: a gentle curve) */
function cable(ch, a0, a1, sag) {
  const wall = (a) => { let d = ch.r * 0.7; while (d < ch.r * 1.5 && openAt(ch.c[0] + Math.cos(a) * d, ch.c[1] + Math.sin(a) * d)) d += 40; return [ch.c[0] + Math.cos(a) * (d + 120), ch.c[1] + Math.sin(a) * (d + 120)]; };
  const p = wall(a0), q = wall(a1), mx = (p[0] + q[0]) / 2, my = (p[1] + q[1]) / 2, l = Math.hypot(q[0] - p[0], q[1] - p[1]);
  const nx = -(q[1] - p[1]) / l, ny = (q[0] - p[0]) / l, pts = [];
  for (let s = 0; s <= 16; s++) { const t = s / 16, b = 4 * t * (1 - t) * sag; pts.push([round(p[0] + (q[0] - p[0]) * t + nx * b), round(p[1] + (q[1] - p[1]) * t + ny * b)]); }
  void mx; void my;
  return pts;
}
const H_ = CHAMBERS.heart, cables = [
  cable(H_, -2.6, -0.5, 500), cable(H_, -2.2, 0.3, -400), cable(H_, 3.6, 1.0, 300),
  cable(CHAMBERS.gullet, 3.6, 5.8, 260), cable(CHAMBERS.sorting, -1.2, 1.9, 300), cable(CHAMBERS.smelter, 1.4, 4.4, -280), cable(CHAMBERS.gallery, 0.4, 2.7, 300),
];
/** Greyseam veins: short cracks in the rock near its edges, glowing faint green */
const veins = [];
for (const c of cliffs) {
  for (let i = 0; i < c.pts.length; i += 11) {
    if (rnd() < 0.55) continue;
    const [x, y] = c.pts[i], [nx, ny] = c.in[i], room = c.depth[i];
    if (room < 500) continue;
    const pts = [];
    let px = x + nx * (120 + rnd() * 200), py = y + ny * (120 + rnd() * 200), a = Math.atan2(ny, nx) + (rnd() - 0.5) * 1.6;
    const len = 4 + Math.floor(rnd() * 5);
    for (let s = 0; s < len; s++) {
      pts.push([round(px), round(py)]);
      a += (rnd() - 0.5) * 1.1;
      px += Math.cos(a) * (120 + rnd() * 110); py += Math.sin(a) * (120 + rnd() * 110);
      if (openAt(px, py)) break;
    }
    if (pts.length >= 3) veins.push(pts);
  }
}
/** The Sorting Floor's belts: three running across it, east to west, crates riding them */
const SO = CHAMBERS.sorting.c, belts = [-1300, 0, 1300].map((o, k) => ({
  pts: spline([[SO[0] + 3300, SO[1] + o - 300], [SO[0] + 1200, SO[1] + o + 150 * (k - 1)], [SO[0] - 1200, SO[1] + o - 100], [SO[0] - 3300, SO[1] + o + 250]], 260).map((p) => p.map(round)),
  w: 280,
}));
// (each cut where the rock is: a belt runs from wall to wall)
for (const b of belts) b.pts = b.pts.filter(([x, y]) => openAt(x, y));
/** Plates welded round the Mouth, over the rock face (where the outer outline passes near it) */
const plates = [];
for (const c of cliffs) {
  for (let i = 0; i < c.pts.length; i += 3) {
    const [x, y] = c.pts[i], [nx, ny] = c.in[i];
    const near = Math.hypot(x, y - 21000);
    if (near > 4600 || y < 16500) continue;
    const w = 380 + rnd() * 240, d = 280 + rnd() * 520, tx = -ny, ty = nx;
    plates.push([[x - tx * w / 2, y - ty * w / 2], [x + tx * w / 2, y + ty * w / 2], [x + tx * w / 2 + nx * d, y + ty * w / 2 + ny * d], [x - tx * w / 2 + nx * d, y - ty * w / 2 + ny * d]].map((p) => p.map(round)));
  }
}

mkdirSync(join(root, 'data/terrain'), { recursive: true });
writeFileSync(join(root, 'data/terrain/sol_scrap_nest.json'), JSON.stringify({
  _comment: 'The Scrap Mother\'s Nest Rock (common/src/terrain.ts). Written by scripts/terrain/scrap_nest.mjs: edit that, not this.',
  rocks, mass, cliffs, streams, ridges,
  palette: { foot: '#221f1e', face: '#3d3634', top: '#2f2a28', far: '#1b1817' },
  dressing: { lamps, cables, veins, belts, plates },
}) + '\n');
console.log(`${cliffs.length} outlines (${cliffs.map((c) => c.pts.length).join(', ')} points), ${mass.length} mass triangles, ${rocks.length} boulders, ${streams.length} streams, ${ridges.length} ridges; ${lamps.length} lamps, ${cables.length} cables, ${veins.length} veins, ${belts.length} belts, ${plates.length} plates`);

const svg = process.argv[2];
if (svg) {
  const s = 0.018, W = POCKET * 2.1 * s, T = (x, y) => `${(x * s + W / 2).toFixed(1)},${(y * s + W / 2).toFixed(1)}`;
  const poly = (ps, fillc, stroke = 'none') => `<polygon points="${ps.map(([x, y]) => T(x, y)).join(' ')}" fill="${fillc}" stroke="${stroke}" stroke-width="0.5"/>`;
  const line = (ps, c, w) => `<polyline points="${ps.map(([x, y]) => T(x, y)).join(' ')}" fill="none" stroke="${c}" stroke-width="${w}"/>`;
  const parts = [`<circle cx="${W / 2}" cy="${W / 2}" r="${POCKET * s}" fill="#0a0b10" stroke="#334"/>`];
  // (rock: every cell that isn't open, as a raster of small squares)
  for (let j = 0; j < N; j += 2) for (let i = 0; i < N; i += 2) if (!inside(i, j)) parts.push(`<rect x="${((LO + i * G) * s + W / 2).toFixed(1)}" y="${((LO + j * G) * s + W / 2).toFixed(1)}" width="${(2 * G * s).toFixed(1)}" height="${(2 * G * s).toFixed(1)}" fill="#3a3432"/>`);
  parts.push(...mass.map((p) => poly(p, '#4a4240')), ...cliffs.map((c) => `<polyline points="${c.pts.map(([x, y]) => T(x, y)).join(' ')}" fill="none" stroke="#c98a5a" stroke-width="1"/>`));
  parts.push(...rocks.map((p) => poly(p, '#5a504c', '#120c0e')), ...streams.map((t) => line(t.pts, '#ffb040', 4)), ...ridges.map((r) => line(r.pts, '#7a6a60', 5)));
  parts.push(...veins.map((v) => line(v, '#6fe0c4', 0.8)), ...cables.map((c) => line(c, '#222', 1.2)), ...belts.map((b) => line(b.pts, '#8a7a50', 4)), ...plates.map((p) => poly(p, '#6a6e74')));
  parts.push(...lamps.map(([x, y]) => `<circle cx="${(x * s + W / 2).toFixed(1)}" cy="${(y * s + W / 2).toFixed(1)}" r="1.6" fill="#ffa53a"/>`));
  parts.push(line([[-1900, BARRIER_Y], [1900, BARRIER_Y]], '#7affd2', 2));
  for (const [name, ch] of Object.entries(CHAMBERS)) parts.push(`<text x="${(ch.c[0] * s + W / 2).toFixed(1)}" y="${(ch.c[1] * s + W / 2).toFixed(1)}" fill="#ddd" font-size="9" text-anchor="middle">${name}</text>`);
  parts.push(`<circle cx="${W / 2}" cy="${(26500 * s + W / 2).toFixed(1)}" r="5" fill="#4ade80"/>`);
  writeFileSync(svg, `<svg xmlns="http://www.w3.org/2000/svg" width="${W.toFixed(0)}" height="${W.toFixed(0)}" style="background:#07070a">${parts.join('')}</svg>`);
}
