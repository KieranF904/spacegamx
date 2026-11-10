/**
 * The Brood Mother's hull (bosses.json boss_brood_mother): writes her bespoke pieces (data/ships/bespoke/brood_mother.json)
 * and her design (data/ships/blueprints/enemy/brood_mother.json). Run: node scripts/bespoke/brood_mother.mjs [preview.svg]
 *
 * Grid units (a cell is 24 world units), y down, nose towards -y; built as the left half and mirrored, scaled by S on
 * the way out. Every part shares an edge with its neighbours or lies over one (bespoke parts join what they touch).
 *
 * Her look: a Frost Brood grown huge, something like a squid that swims the aurora, nothing built. Slate-indigo shell
 * in overlapping scales, frosted blue rime at her edges, dusky violet membrane; her own light a cold aurora violet,
 * running in veins down her fins and arms and glowing in pits along her shell. In three stages:
 *
 *   1 the veil    her fins: two great crescents of scaled shell, hooked ice horns at their tips, a scalloped frill
 *                 round their edges, frost teeth along their leading edge; three trailing arms either side, egg sacs
 *                 slung on the outer ones. Every scale shot off bares the fin's rays beneath (her skeleton, pale bone,
 *                 violet nerves, clutches of eggs nested in it)
 *   2 the mantle  her body: a long spindle of shell segments over a rime keel, a hooked beak and palps forward, frost
 *                 glands either flank, ice spines along her sides, two siphons aft. Worn out, each piece is left a
 *                 wreck (`ruin`)
 *   3 the clutch  her heart, beneath: a long frost gland, six eggs down its flanks (those wreck, and blow at once when she
 *                 dies); two ice antlers forward, two siphons aft
 */

import { writeFileSync, mkdirSync } from 'fs';
import { compactJson } from '../lib/compactJson.mjs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const round = (v) => Math.round(v * 1000) / 1000;
const C = [0, 2];
const mid = (a, b, t = 0.5) => [round(a[0] + (b[0] - a[0]) * t), round(a[1] + (b[1] - a[1]) * t)];
const flipX = ([x, y]) => [round(-x), y];
const mirror = (pts) => pts.map(flipX).reverse();
const norm = ([x, y]) => { const l = Math.hypot(x, y) || 1; return [x / l, y / l]; };
const centroid = (pts) => [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length];

/** Drawn at this scale on the way out */
const S = 1.25;
const SHELL = 'brood_shell', RIME = 'brood_rime', VEIL = 'brood_membrane', ICE = 'brood_ice', GLAND = 'brood_gland';
const VIOLET = '#cf7cff', HOTV = '#ecd2ff', FROST = '#b4cfe3', ICEB = '#7fa6c4', PIT = '#1a1d2c', SCALE = '#47546f';

const pieces = [], parts = [];
let uid = 0;
function part(name, fn, material, polygon, opts = {}) {
  const id = `broodmother_${name}`;
  pieces.push({
    id, polygon, stage: opts.stage, ...(opts.ruin ? { ruin: true } : {}), ...(opts.under ? { under: true } : {}),
    ...(opts.mount ? { mount: opts.mount } : {}), ...(opts.relief ? { relief: opts.relief } : {}),
    ...(opts.contact ? { contact: opts.contact } : {}), ...(opts.detail?.length ? { detail: opts.detail } : {}), ...(opts.skeleton ? { skeleton: opts.skeleton } : {}),
  });
  parts.push({ uid: uid++, piece: id, fn, material, x: 0, y: 0, rot: 0, flip: false });
}
const mirrorDetail = (d) => ({ ...d, ...(d.poly ? { poly: d.kind === 'vein' || d.kind === 'cable' ? d.poly.map(flipX) : mirror(d.poly) } : {}), ...(d.at ? { at: flipX(d.at) } : {}), ...(d.dir ? { dir: flipX(d.dir) } : {}) });
function pair(name, fn, material, polygon, opts = {}) {
  part(`${name}_l`, fn, material, polygon, opts);
  const m = opts.mount && { ...opts.mount, at: flipX(opts.mount.at), dir: flipX(opts.mount.dir) };
  part(`${name}_r`, fn, material, mirror(polygon), { ...opts, mount: m, detail: opts.detail?.map(mirrorDetail) });
}

// ---- Look helpers ----
/** A ring of `n` points (a disc, a hex) */
const ringPts = (c, r, n, off = 0) => Array.from({ length: n }, (_, k) => [round(c[0] + Math.cos(off + (k / n) * Math.PI * 2) * r), round(c[1] + Math.sin(off + (k / n) * Math.PI * 2) * r)]);
/** An oval round `c`: `a` along `dir`, `b` across it */
const oval = (c, a, b, dir, n = 14) => { const [ux, uy] = norm(dir); return Array.from({ length: n }, (_, k) => { const t = (k / n) * Math.PI * 2, p = Math.cos(t) * a, q = Math.sin(t) * b; return [round(c[0] + ux * p - uy * q), round(c[1] + uy * p + ux * q)]; }); };
/** A pit in the shell (a photophore): sunk, its light deep in it */
const pit = (at, r = 0.5) => [{ kind: 'recess', color: PIT, poly: ringPts(at, r, 8) }, { kind: 'glow', at, r: r * 0.7, color: VIOLET }];
/** A frost crystal from `at`, out along `dir` */
const frost = (at, dir, r, w, color = FROST) => ({ kind: 'shard', crystal: true, color, at, dir: norm(dir), r, w });
/** Catmull-Rom through `pts`, `n` steps */
function spline(pts, n) {
  const out = [];
  for (let k = 0; k <= n; k++) {
    const t = (k / n) * (pts.length - 1), i = Math.min(pts.length - 2, Math.floor(t)), f = t - i;
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    const cr = (a, b, c2, d) => 0.5 * (2 * b + (-a + c2) * f + (2 * a - 5 * b + 4 * c2 - d) * f * f + (-a + 3 * b - 3 * c2 + d) * f * f * f);
    out.push([cr(p0[0], p1[0], p2[0], p3[0]), cr(p0[1], p1[1], p2[1], p3[1])]);
  }
  return out;
}
/** A tentacle along `pts`, `w0` wide at its root to `w1` at its tip, in `segs` lengths (each running a step into the next) */
function tentacle(pts, w0, w1, segs, per = 6) {
  const c = spline(pts, segs * per), last = c.length - 1;
  const side = (k) => {
    const a = c[Math.max(0, k - 1)], b = c[Math.min(last, k + 1)], [ux, uy] = norm([b[0] - a[0], b[1] - a[1]]), w = (w0 + ((w1 - w0) * k) / last) / 2;
    return [[c[k][0] - uy * w, c[k][1] + ux * w], [c[k][0] + uy * w, c[k][1] - ux * w]];
  };
  return Array.from({ length: segs }, (_, s) => {
    const k0 = Math.max(0, s * per - 1), k1 = Math.min(last, (s + 1) * per + 1), L = [], R = [];
    for (let k = k0; k <= k1; k++) { const [l, r] = side(k); L.push(l); R.push(r); }
    // (its tip drawn to a point)
    if (k1 === last) { L.pop(); R.pop(); L.push(c[last]); return { poly: [...L, ...R.reverse()].map((q) => q.map(round)), path: c.slice(k0, k1 + 1).map((q) => q.map(round)) }; }
    return { poly: [...L, ...R.reverse()].map((q) => q.map(round)), path: c.slice(k0, k1 + 1).map((q) => q.map(round)) };
  });
}
/** A rounded lobe of frill on the edge a→b, bulging `depth` away from `from`, its base sunk `sink` back into what it's on */
function scallop(a, b, depth, from, sink = 0.8) {
  const m = mid(a, b), [ux, uy] = norm([b[0] - a[0], b[1] - a[1]]), L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  let nx = -uy, ny = ux;
  if ((m[0] - from[0]) * nx + (m[1] - from[1]) * ny < 0) { nx = -nx; ny = -ny; }
  const pts = [];
  for (let k = 0; k <= 8; k++) { const t = (Math.PI * k) / 8, al = -Math.cos(t) * L * 0.5, out = Math.sin(t) * depth; pts.push([m[0] + ux * al + nx * out, m[1] + uy * al + ny * out]); }
  pts.push([m[0] + ux * L * 0.42 - nx * sink, m[1] + uy * L * 0.42 - ny * sink], [m[0] - ux * L * 0.42 - nx * sink, m[1] - uy * L * 0.42 - ny * sink]);
  return { poly: pts.map((q) => q.map(round)), tip: [round(m[0] + nx * depth * 0.6), round(m[1] + ny * depth * 0.6)], out: [nx, ny], base: m };
}

// =====================================================================================================================
// Stage 3, the clutch: beneath everything (drawn first), bared when her mantle blows away
// =====================================================================================================================
// (each egg lies over the gland and its neighbours: they hold to each other, not only to what's over them)
const S3 = { stage: 3, under: true };
const CORE_A = 6.2, CORE_B = 3.2;
// The clutch: a pod of six eggs down the gland's flanks, each pointing out, an embryo glowing through its shell
for (const [k, c, dir, a, b] of [[0, [-4.2, -2.4], [-0.6, -0.8], 2.8, 2.4], [1, [-4.9, 2.2], [-1, 0], 2.9, 2.5], [2, [-4.2, 6.6], [-0.6, 0.8], 2.8, 2.4]]) {
  const out = norm(dir), tipward = [round(c[0] + out[0] * 0.8), round(c[1] + out[1] * 0.8)];
  pair(`s3_egg${k}`, 'brood_bay', VEIL, oval(c, a, b, out, 16), {
    ...S3, ruin: true,
    detail: [
      { kind: 'raise', color: '#56446f', poly: oval(c, a * 0.78, b * 0.74, out, 14) },
      { kind: 'glow', at: tipward, r: 0.95, color: VIOLET },
      frost([round(c[0] - out[1] * b * 0.72), round(c[1] + out[0] * b * 0.72)], [out[0] - out[1] * 0.5, out[1] + out[0] * 0.5], 1.1, 0.45, ICEB),
    ],
  });
}
// Her antlers: ice, hooked forward off the gland
pair('s3_antler', 'generator', ICE, [[-1.1, -3.1], [-2.6, -8.6], [-3.9, -13.4], [-3.4, -17.2], [-5.5, -14.6], [-6.2, -10.2], [-4.5, -3.8]], {
  ...S3, relief: 'ridge',
  detail: [frost([-3.6, -7.8], [-0.25, -1], 2.6, 0.9, ICEB), frost([-5.2, -11.0], [-0.8, -0.6], 1.6, 0.6, ICEB), { kind: 'vein', w: 0.3, color: VIOLET, poly: [[-2.8, -4.6], [-4.0, -9.6], [-4.5, -14.4]] }],
});
// Her siphons: two, aft of the clutch
pair('s3_siphon', 'plasma_drive', SHELL, [[-3.9, 7.6], [-0.9, 7.4], [-1.2, 13.6], [-3.7, 13.6]], {
  ...S3, relief: 'round', mount: { at: [-2.45, 13.6], dir: [0, 1], width: 2.4 },
  detail: [{ kind: 'bell', at: [-2.45, 13.6], dir: [0, 1], r: 2.3, w: 1.6 }, ...pit([-2.4, 9.8], 0.4)],
});
// The gland, last: her frost gland, long, its light pooled down its length
part('s3_core', 'core', GLAND, oval(C, CORE_A, CORE_B, [0, -1], 20), {
  ...S3, ruin: true,
  detail: [
    { kind: 'recess', color: '#2a2140', poly: oval(C, CORE_A * 0.8, CORE_B * 0.7, [0, -1], 16) },
    { kind: 'glow', at: C, r: 1.6, color: VIOLET },
    { kind: 'glow', at: C, r: 0.6, color: HOTV },
    { kind: 'halo', at: C, r: 2.5, w: 0.1, color: VIOLET },
  ],
});

// =====================================================================================================================
// Stage 2, the mantle: her body, over her heart. Worn out, each piece is left a wreck
// =====================================================================================================================
const S2 = { stage: 2, ruin: true };
// Her outline: a spindle, half-width by y
const SPINDLE = [[-22.5, 2.8], [-18, 5.8], [-12, 8.4], [-5, 10.0], [2, 10.6], [9, 10.2], [15, 8.6], [20, 6.2], [24.5, 4.2]];
const wAt = (y) => {
  if (y <= SPINDLE[0][0]) return SPINDLE[0][1];
  for (let k = 0; k < SPINDLE.length - 1; k++) { const [y0, w0] = SPINDLE[k], [y1, w1] = SPINDLE[k + 1]; if (y <= y1) return w0 + ((w1 - w0) * (y - y0)) / (y1 - y0); }
  return SPINDLE[SPINDLE.length - 1][1];
};
// Its segments: shell plates across her back, each bowed back at its sides (overlapping the next, as a woodlouse's)
const SEG = [-22, -16, -10, -4, 2, 8, 14, 19, 24], BOW = 1.3;
const edge = (y0) => { const W = wAt(y0 + BOW); return [0, 0.25, 0.5, 0.75, 1].map((t) => [round(-t * W), round(y0 + BOW * t * t)]); };
for (let k = 0; k < SEG.length - 1; k++) {
  const top = edge(SEG[k]), bot = edge(SEG[k + 1]), ya = SEG[k] + BOW, yb = SEG[k + 1] + BOW;
  const side = [1, 2].map((q) => { const y = ya + ((yb - ya) * q) / 3; return [round(-wAt(y)), round(y)]; });
  // (each half running a little past her middle, so the halves hold)
  const pg = [[0.15, SEG[k]], ...top, ...side, ...[...bot].reverse(), [0.15, SEG[k + 1]]];
  const ym = (SEG[k] + SEG[k + 1]) / 2, W = wAt(ym + BOW * 0.5);
  pair(`seg${k}`, k === 3 || k === 5 ? 'conduit' : 'armor', SHELL, pg, {
    ...S2, relief: 'plate',
    detail: [
      { kind: 'raise', color: SCALE, poly: [[-1.6, SEG[k] + 0.9], [-W * 0.55, SEG[k] + 0.9 + BOW * 0.3], [-W * 0.82, ym + BOW * 0.7], [-W * 0.55, SEG[k + 1] - 0.2 + BOW * 0.3], [-1.6, SEG[k + 1] - 0.3]].map((q) => q.map(round)) },
      { kind: 'vein', w: 0.2, color: VIOLET, poly: [[-1.9, ym + 0.2], [round(-W * 0.45), round(ym + BOW * 0.25)], [round(-W * 0.8), round(ym + BOW * 0.7)]] },
      ...(k % 2 ? pit([round(-W * 0.62), round(ym - 0.9)], 0.45) : []),
      // (rime on its trailing lip)
      frost([round(-W * 0.7), round(SEG[k + 1] + BOW * 0.4)], [-0.5, -1], 1.0, 0.4, FROST),
    ],
  });
}
// The keel down her back: rime, in three lengths
part('keel0', 'armor', RIME, [[0, -21.6], [1.5, -14], [1.3, -7.2], [0, -6.2], [-1.3, -7.2], [-1.5, -14]], { ...S2, relief: 'ridge', detail: [frost([0, -14], [0, -1], 2.6, 0.9)] });
part('keel1', 'armor', RIME, [[0, -7.0], [1.9, -1.5], [1.9, 6], [0, 10.2], [-1.9, 6], [-1.9, -1.5]], { ...S2, relief: 'ridge', detail: [...pit([0, 1.6], 0.6)] });
part('keel2', 'armor', RIME, [[0, 9.4], [1.5, 14], [1.1, 21], [0, 23.4], [-1.1, 21], [-1.5, 14]], { ...S2, relief: 'ridge', detail: [frost([0, 16], [0, 1], 2.2, 0.8)] });
// Her beak, hooked, and two palps either side of it
part('beak', 'armor', SHELL, [[-3.3, -21.0], [-2.0, -25.2], [-0.6, -29.6], [0, -31.2], [0.6, -29.6], [2.0, -25.2], [3.3, -21.0], [0, -20.2]], {
  ...S2, relief: 'ridge', detail: [frost([0, -25.5], [0, -1], 4.2, 1.3, ICEB), ...pit([-1.2, -22.4], 0.35), ...pit([1.2, -22.4], 0.35)],
});
pair('palp', 'hull', SHELL, [[-2.6, -20.4], [-6.6, -24.2], [-7.6, -28.4], [-5.8, -32.4], [-6.1, -28.4], [-5.2, -25.0], [-2.2, -22.6]], {
  ...S2, relief: 'plate', detail: [frost([-6.6, -28.2], [0.15, -1], 2.6, 0.7, ICEB), { kind: 'vein', w: 0.24, color: VIOLET, poly: [[-3.2, -21.4], [-5.8, -24.6], [-6.6, -27.4]] }],
});
// Frost glands, two either flank: sacs glowing through
for (const [k, c, a, b] of [[0, [-7.4, -6.4], 2.7, 2.0], [1, [-7.6, 5.4], 2.9, 2.15]]) {
  pair(`gland${k}`, 'generator', GLAND, oval(c, a, b, [0, -1], 16), {
    ...S2,
    detail: [
      { kind: 'recess', color: '#2a2140', poly: oval(c, a * 0.72, b * 0.66, [0, -1], 12) },
      { kind: 'glow', at: c, r: b * 0.5, color: VIOLET },
      { kind: 'halo', at: c, r: b * 0.95, w: 0.1, color: VIOLET },
    ],
  });
}
// Ice spines along her sides (under her fins until they go)
for (const [k, y, dir, len] of [[0, -15, [-1, -0.8], 6.4], [1, -1, [-1, -0.12], 6.0], [2, 11, [-1, 0.5], 5.6]]) {
  const b = [round(-wAt(y) + 0.9), y], [ux, uy] = norm(dir), vx = -uy, vy = ux;
  const tip = [round(b[0] + ux * len), round(b[1] + uy * len)], kn = [round(b[0] + ux * len * 0.45 - vx * 0.5), round(b[1] + uy * len * 0.45 - vy * 0.5)];
  pair(`spine${k}`, 'armor', ICE, [[round(b[0] - vx * 1.1), round(b[1] - vy * 1.1)], kn, tip, [round(b[0] + ux * len * 0.4 + vx * 0.7), round(b[1] + uy * len * 0.4 + vy * 0.7)], [round(b[0] + vx * 1.1), round(b[1] + vy * 1.1)]], {
    ...S2, relief: 'ridge', detail: [frost(b, dir, len * 0.85, 0.8)],
  });
}
// Her siphons: two, aft
pair('siphon', 'plasma_drive', SHELL, [[-4.6, 22.6], [-0.6, 22.8], [-0.9, 28.6], [-4.2, 28.6]], {
  ...S2, relief: 'round', mount: { at: [-2.55, 28.6], dir: [0, 1], width: 3.0 },
  detail: [{ kind: 'bell', at: [-2.55, 28.6], dir: [0, 1], r: 2.6, w: 1.9 }, ...pit([-2.6, 24.0], 0.4)],
});

// =====================================================================================================================
// Stage 1, the veil: her fins and arms. Every scale shot off bares the fin's rays beneath
// =====================================================================================================================
const S1 = { stage: 1 };
// The fin as four lines out from her side (its root, sunk into her body, to its outer edge), each front to back
const L = [
  [[-6.0, -16], [-8.3, -9], [-9.5, -2], [-9.7, 5], [-8.7, 12]],
  [[-13.4, -18.4], [-16.4, -10.6], [-17.6, -2.4], [-17.0, 5.6], [-14.8, 13.0]],
  [[-20.8, -22.0], [-24.2, -13.6], [-25.4, -5.0], [-24.4, 3.4], [-21.2, 9.2]],
  [[-28.0, -27.6], [-31.6, -19.0], [-32.6, -11.0], [-30.6, -3.6], [-26.2, 2.6]],
];
/** Catmull-Rom between control points (`t` from 0 at the first to n - 1 at the last) */
const cr = (pts, t) => {
  const i = Math.max(0, Math.min(pts.length - 2, Math.floor(t))), f = t - i, p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
  const c = (a, b, c2, d) => 0.5 * (2 * b + (-a + c2) * f + (2 * a - 5 * b + 4 * c2 - d) * f * f + (-a + 3 * b - 3 * c2 + d) * f * f * f);
  return [c(p0[0], p1[0], p2[0], p3[0]), c(p0[1], p1[1], p2[1], p3[1])];
};
/** A point on the fin: `u` out from its root (0) to its edge (3), `v` from its front (0) to its back (4); smooth between the lines */
const F = (u, v) => cr(L.map((l) => cr(l, v)), u).map(round);
const FIN_C = F(1.5, 2);
// Its scales: a bay of the fin each, their edges following its curves (each edge in three, shared with the next scale)
const N_EDGE = 3;
const slab = (u, v) => [
  ...Array.from({ length: N_EDGE }, (_, i) => F(u + i / N_EDGE, v)),
  ...Array.from({ length: N_EDGE }, (_, i) => F(u + 1, v + i / N_EDGE)),
  ...Array.from({ length: N_EDGE }, (_, i) => F(u + 1 - i / N_EDGE, v + 1)),
  ...Array.from({ length: N_EDGE }, (_, i) => F(u, v + 1 - i / N_EDGE)),
];
/** A rounded shape in bay (u, v): round (s, t) in it, `rs` by `rt` across (fractions of the bay) */
const blob = (u, v, s, t, rs, rt, n = 14) => Array.from({ length: n }, (_, k) => { const a = (k / n) * Math.PI * 2; return F(u + s + Math.cos(a) * rs, v + t + Math.sin(a) * rt); });
const SLABS = [], SLABMAT = [SHELL, SHELL, RIME];
for (let u = 0; u < 3; u++) for (let v = 0; v < 4; v++) SLABS.push({ u, v, pg: slab(u, v) });
for (const { u, v, pg } of SLABS) {
  const k = u * 4 + v;
  pair(`scale${k}`, v === 1 || v === 2 ? 'conduit' : 'armor', u === 1 && v % 2 ? VEIL : SLABMAT[u], pg, {
    ...S1, relief: 'plate',
    detail: [
      // (its scale's raised face, lying out over the next; the fin's ray glowing faintly through it, root to edge)
      { kind: 'raise', color: u === 2 ? '#64809c' : SCALE, poly: blob(u, v, 0.56, 0.5, 0.34, 0.36) },
      { kind: 'vein', w: 0.2, color: VIOLET, poly: [F(u + 0.1, v + 0.5), F(u + 0.5, v + 0.57), F(u + 0.92, v + 0.5)] },
      ...((k * 7) % 3 === 1 ? pit(F(u + 0.3, v + 0.78), 0.45) : []),
      ...(u === 2 ? [frost(F(u + 0.82, v + 0.3), [F(u + 1.2, v + 0.3)[0] - F(u + 0.8, v + 0.3)[0], F(u + 1.2, v + 0.3)[1] - F(u + 0.8, v + 0.3)[1]], 1.3, 0.5)] : []),
    ],
  });
}
// The horns: ice, hooked forward off each fin's tip
pair('horn', 'armor', ICE, [[-21.6, -21.2], [-27.6, -26.0], [-28.2, -32], [-26.6, -37], [-22.6, -40.6], [-23.6, -36.2], [-23.9, -31.6], [-21.9, -26.2]], {
  ...S1, relief: 'ridge',
  detail: [frost([-24.6, -29], [-0.2, -1], 4.6, 1.3, ICEB), frost([-26.4, -33.4], [0.4, -1], 2.8, 0.9, ICEB), { kind: 'vein', w: 0.3, color: VIOLET, poly: [[-23.2, -25.4], [-25.2, -30.6], [-24.8, -35.6]] }],
});
// Frost teeth along the fins' leading edge
for (const [k, a, b] of [[0, F(0.3, 0), F(0.7, 0)], [1, F(1.3, 0), F(1.7, 0)]]) {
  const m = mid(a, b), [ux, uy] = norm([b[0] - a[0], b[1] - a[1]]), nx = uy, ny = -ux, len = 3.4 - k * 0.4;
  pair(`tooth${k}`, 'armor', ICE, [[round(m[0] - ux * 1.4 - nx * 0.6), round(m[1] - uy * 1.4 - ny * 0.6)], [round(m[0] + nx * len * 0.5 - ux * 0.6), round(m[1] + ny * len * 0.5 - uy * 0.6)], [round(m[0] + nx * len + ux * 0.8), round(m[1] + ny * len + uy * 0.8)], [round(m[0] + ux * 1.4 - nx * 0.6), round(m[1] + uy * 1.4 - ny * 0.6)]], {
    ...S1, relief: 'ridge', detail: [frost(m, [nx + ux * 0.25, ny + uy * 0.25], len * 0.9, 0.7)],
  });
}
// Its frill: scalloped lobes of membrane round its outer and trailing edges
const FRILL = [...[1, 1.5, 2, 2.5, 3, 3.5].map((v) => [F(3, v), F(3, v + 0.5)]), ...[3, 2, 1].map((u) => [F(u, 4), F(u - 1, 4)])];
FRILL.forEach(([a, b], k) => {
  const s = scallop(a, b, k < 6 ? 1.6 : 2.2, FIN_C);
  pair(`frill${k}`, 'hull', VEIL, s.poly, {
    ...S1, relief: 'plate',
    detail: [
      { kind: 'vein', w: 0.26, color: VIOLET, poly: [mid(s.base, s.tip, -0.4), s.tip] },
      { kind: 'glow', at: s.tip, r: 0.42, color: VIOLET },
    ],
  });
});
// Her arms: three either side, trailing; egg sacs slung on the outer two
const ARMS = [
  { pts: [[-9.4, 12.0], [-16.5, 17.0], [-22.5, 23.5], [-24.0, 31.0], [-21.4, 37.5], [-23.4, 44.5]], w0: 4.4, w1: 0.7 },
  { pts: [[-7.4, 16.4], [-12.2, 23.0], [-14.4, 30.5], [-12.4, 38.0], [-14.4, 45.0], [-12.6, 51.0]], w0: 4.0, w1: 0.65 },
  { pts: [[-4.6, 20.6], [-6.4, 27.5], [-5.4, 34.5], [-7.2, 41.5], [-5.4, 48.0], [-6.2, 54.0]], w0: 3.4, w1: 0.6 },
];
ARMS.forEach((arm, a) => {
  const segs = tentacle(arm.pts, arm.w0, arm.w1, 3);
  segs.forEach((sg, s) => {
    const n = sg.path.length;
    pair(`arm${a}${'abc'[s]}`, s === 0 ? 'conduit' : 'hull', VEIL, sg.poly, {
      ...S1, relief: 'round',
      detail: [
        { kind: 'vein', w: 0.22 - s * 0.03, color: VIOLET, poly: sg.path.slice(1, n - 1) },
        ...sg.path.filter((_, k) => k % 3 === 2 && k < n - 2).map((q) => ({ kind: 'glow', at: q, r: 0.42 * (1 - s * 0.2), color: VIOLET })),
      ],
    });
  });
  // (an egg sac half way down the outer two)
  if (a < 2) {
    const path = spline(arm.pts, 18), k = a === 0 ? 7 : 8, c = path[k].map(round), dir = norm([path[k + 1][0] - path[k - 1][0], path[k + 1][1] - path[k - 1][1]]), r = a === 0 ? 2.2 : 2.0;
    // (a string of three eggs down it)
    const eggs = [-1, 0, 1].map((t) => [round(c[0] + dir[0] * t * r * 0.85), round(c[1] + dir[1] * t * r * 0.85)]);
    pair(`sac${a}`, 'brood_bay', GLAND, oval(c, r * 1.45, r * 0.9, dir, 16), {
      ...S1, relief: 'round',
      detail: [{ kind: 'recess', color: '#2a2140', poly: oval(c, r * 1.2, r * 0.68, dir, 14) }, ...eggs.flatMap((e) => [{ kind: 'ring', at: e, r: r * 0.4, w: 0.18, color: '#6d5a8c' }, { kind: 'glow', at: e, r: r * 0.3, color: VIOLET }])],
    });
  }
});

// ---- The fins' rays: one to each fin, under its scales (drawn as lit geometry: client ships/skeletonBuild.ts) ----
/** The outline of the union of polygons (cells), shrunk by `inset`, no further in than x = xMax: traced round a fine grid */
function unionOutline(polys, inset, xMax) {
  const G = 0.1;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const pg of polys) for (const [x, y] of pg) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  x0 -= 1; y0 -= 1; x1 += 1; y1 += 1;
  const W = Math.ceil((x1 - x0) / G), H = Math.ceil((y1 - y0) / G);
  const inPoly = (x, y, pg) => { let c = false; for (let i = 0, j = pg.length - 1; i < pg.length; j = i++) if ((pg[i][1] > y) !== (pg[j][1] > y) && x < ((pg[j][0] - pg[i][0]) * (y - pg[i][1])) / (pg[j][1] - pg[i][1]) + pg[i][0]) c = !c; return c; };
  let grid = new Uint8Array(W * H);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) { const x = x0 + (i + 0.5) * G, y = y0 + (j + 0.5) * G; grid[j * W + i] = x <= xMax && polys.some((pg) => inPoly(x, y, pg)) ? 1 : 0; }
  // shrink (inset > 0: a cell stays if every cell within it is in) or grow (inset < 0: a cell's in if any within it is)
  if (inset !== 0) {
    const r = Math.round(Math.abs(inset) / G), grow = inset < 0, out = new Uint8Array(W * H);
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      let v = grid[j * W + i] === 1;
      for (let dj = -r; dj <= r && v !== grow; dj++) for (let di = -r; di <= r && v !== grow; di++) {
        if (di * di + dj * dj > r * r) continue;
        const ii = i + di, jj = j + dj, on = ii >= 0 && jj >= 0 && ii < W && jj < H && grid[jj * W + ii] === 1;
        if (grow ? on : !on) v = grow;
      }
      out[j * W + i] = v ? 1 : 0;
    }
    grid = out;
  }
  const at = (i, j) => (i < 0 || j < 0 || i >= W || j >= H ? 0 : grid[j * W + i]);
  // trace its edge (corners, the shape on the right of travel), from its topmost-leftmost cell
  let si = -1, sj = -1;
  for (let j = 0; j < H && si < 0; j++) for (let i = 0; i < W; i++) if (at(i, j)) { si = i; sj = j; break; }
  const loop = [], DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];
  let x = si, y = sj, dir = 0;
  for (let guard = 0; guard < 400000; guard++) {
    loop.push([x, y]);
    x += DX[dir]; y += DY[dir];
    if (x === si && y === sj) break;
    const tl = at(x - 1, y - 1), tr = at(x, y - 1), bl = at(x - 1, y), br = at(x, y);
    const turn = (d) => (d === 0 ? br && !tr : d === 1 ? bl && !br : d === 2 ? tl && !bl : tr && !tl);
    for (const d of [(dir + 1) % 4, dir, (dir + 3) % 4]) if (turn(d)) { dir = d; break; }
  }
  // simplified (Ramer-Douglas-Peucker on the closed loop)
  let pts = loop.map(([i, j]) => [x0 + i * G, y0 + j * G]);
  // (the grid's steps smoothed away first)
  for (let pass = 0; pass < 3; pass++) pts = pts.map((q, k) => { const a2 = pts[(k + pts.length - 1) % pts.length], b2 = pts[(k + 1) % pts.length]; return [(a2[0] + 2 * q[0] + b2[0]) / 4, (a2[1] + 2 * q[1] + b2[1]) / 4]; });
  const rdp = (q, eps) => {
    if (q.length < 3) return q;
    const [a2, b2] = [q[0], q[q.length - 1]], dx = b2[0] - a2[0], dy = b2[1] - a2[1], l = Math.hypot(dx, dy) || 1;
    let idx = 0, dmax = 0;
    for (let k = 1; k < q.length - 1; k++) { const d = Math.abs((q[k][0] - a2[0]) * dy - (q[k][1] - a2[1]) * dx) / l; if (d > dmax) { dmax = d; idx = k; } }
    return dmax > eps ? [...rdp(q.slice(0, idx + 1), eps).slice(0, -1), ...rdp(q.slice(idx), eps)] : [a2, b2];
  };
  const half = Math.floor(pts.length / 2);
  return [...rdp(pts.slice(0, half + 1), 0.07).slice(0, -1), ...rdp([...pts.slice(half), pts[0]], 0.07).slice(0, -1)].map((q) => q.map(round));
}
const finPolys = SLABS.map((s) => s.pg);
// (its outline runs into her body a little: it holds to her through that)
const FIN = unionOutline(finPolys, -0.25, 0);
const RIM_W = 0.75, RIM = unionOutline(finPolys, 0.18 + RIM_W / 2, 0);
// Its rays (root to edge, curving with it, the middle ones carrying her light) and the two ribs across them
const US = [0, 0.5, 1, 1.5, 2, 2.5, 2.9], VS = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4];
const BONES = [
  ...[0, 1, 2, 3, 4].map((v) => ({ pts: US.map((u) => F(u, v === 4 ? 3.9 : v === 0 ? 0.1 : v)), w: US.map((u) => round(1.7 - u * 0.3)), layer: 0, ...(v === 1 || v === 3 ? { lava: true } : {}) })),
  { pts: VS.map((v) => F(1, v)), w: VS.map(() => 1.0), layer: 0 },
  { pts: VS.map((v) => F(2, v)), w: VS.map(() => 0.85), layer: 0 },
];
// (finer rays between, the length of each bay)
const FINE = [0.5, 1.5, 2.5, 3.5].map((v) => ({ pts: US.map((u) => F(u, v)), w: US.map(() => 0.45), layer: 1 }));
/** A point in bay (u, v) of the fin: s from its root side to its outer, t from its front to its back */
const bay = (u, v, s, t) => F(u + s, v + t);
const clutch = (u, v) => ({ kind: 'rack', poly: [bay(u, v, 0.15, 0.2), bay(u, v, 0.85, 0.2), bay(u, v, 0.85, 0.8), bay(u, v, 0.15, 0.8)], pods: [[0.3, 0.33], [0.55, 0.3], [0.78, 0.36], [0.32, 0.66], [0.58, 0.7]].map(([s, t]) => bay(u, v, s, t)), r: 0.62 });
const SKPARTS = [
  clutch(1, 1), clutch(1, 2), clutch(2, 2),
  { kind: 'drum', at: bay(0, 1, 0.5, 0.5), r: 1.5 },
  { kind: 'drum', at: bay(0, 3, 0.5, 0.45), r: 1.3 },
  { kind: 'drum', at: bay(2, 0, 0.45, 0.55), r: 1.2 },
  // (nerves: glowing, along the root and out between the rays)
  { kind: 'pipe', pts: [bay(0, 0, 0.3, 0.1), bay(0, 1, 0.3, 0.5), bay(0, 2, 0.3, 0.5), bay(0, 3, 0.3, 0.6)], w: 0.55, glow: true },
  { kind: 'pipe', pts: [bay(0, 2, 0.35, 0.3), bay(1, 2, 0.1, 0.25), bay(2, 2, 0.1, 0.2), bay(2, 1, 0.8, 0.8)], w: 0.45, glow: true },
  { kind: 'pipe', pts: [bay(0, 0, 0.6, 0.6), bay(1, 0, 0.4, 0.5), bay(2, 0, 0.2, 0.7), bay(2, 1, 0.6, 0.3)], w: 0.4, glow: true },
  // (sinews)
  ...[0, 1, 2].flatMap((k) => [
    { kind: 'cable', pts: [bay(0, 1, 0.1, 0.75 + k * 0.06), bay(1, 1, 0.2, 0.85 + k * 0.04), bay(1, 2, 0.1, 0.1 + k * 0.05)], w: 0.14 },
    { kind: 'cable', pts: [bay(0, 3, 0.15, 0.2 + k * 0.08), bay(1, 3, 0.3, 0.25 + k * 0.07), bay(2, 3, 0.4, 0.3 + k * 0.05)], w: 0.13 },
  ]),
];
const PALETTE = { bone: '#7c879c', fine: '#394155', part: '#2b3142', edge: '#4d576c', bolt: '#a7b4c8', hot: '#c46cff', hotCore: '#f1dcff' };
const flipPart = (q) => ({ ...q, ...(q.pts ? { pts: q.pts.map(flipX) } : {}), ...(q.poly ? { poly: q.poly.map(flipX) } : {}), ...(q.pods ? { pods: q.pods.map(flipX) } : {}), ...(q.at ? { at: flipX(q.at) } : {}), ...(q.a ? { a: flipX(q.a), b: flipX(q.b) } : {}) });
for (const side of ['l', 'r']) {
  const m = side === 'l' ? (q) => q : flipX, mp = side === 'l' ? (q) => q : flipPart;
  part(`rays_${side}`, 'bone_frame', SHELL, (side === 'l' ? FIN : [...FIN].reverse()).map(m), {
    ...S1,
    skeleton: {
      rim: (side === 'l' ? RIM : [...RIM].reverse()).map(m), rimW: RIM_W,
      bones: [...BONES, ...FINE].map((b) => ({ ...b, pts: b.pts.map(m) })),
      parts: SKPARTS.map(mp), palette: PALETTE,
    },
  });
}

// ---- Out: scaled by S ----
const sc = (q) => [round(q[0] * S), round(q[1] * S)];
const scaleDetail = (d) => ({ ...d, ...(d.poly ? { poly: d.poly.map(sc) } : {}), ...(d.at ? { at: sc(d.at) } : {}), ...(d.r !== undefined ? { r: round(d.r * S) } : {}), ...(d.w !== undefined ? { w: round(d.w * S) } : {}) });
const scalePart = (q) => ({ ...q, ...(q.pts ? { pts: q.pts.map(sc) } : {}), ...(q.poly ? { poly: q.poly.map(sc) } : {}), ...(q.pods ? { pods: q.pods.map(sc) } : {}), ...(q.at ? { at: sc(q.at) } : {}), ...(q.a ? { a: sc(q.a), b: sc(q.b) } : {}), ...(q.r !== undefined ? { r: round(q.r * S) } : {}), ...(q.w !== undefined ? { w: round(q.w * S) } : {}), ...(q.amp !== undefined ? { amp: round(q.amp * S) } : {}) });
for (const p of pieces) {
  p.polygon = p.polygon.map(sc);
  if (p.mount) p.mount = { ...p.mount, at: sc(p.mount.at), ...(p.mount.width ? { width: round(p.mount.width * S) } : {}) };
  if (p.detail) p.detail = p.detail.map(scaleDetail);
  if (p.skeleton) {
    const k = p.skeleton;
    p.skeleton = { ...k, rim: k.rim.map(sc), rimW: round(k.rimW * S), bones: k.bones.map((b) => ({ ...b, pts: b.pts.map(sc), w: b.w.map((v) => round(v * S)) })), parts: k.parts.map(scalePart) };
  }
}

const pieceFile = { _comment: 'The Brood Mother\'s own hull (bosses.json boss_brood_mother). Written by scripts/bespoke/brood_mother.mjs: edit that, not this.', pieces };
// (her heart first: drawn under everything; rigid: she flies as built throughout, her hull drawn once)
const order = [...parts.filter((q) => q.piece.includes('_s3_')), ...parts.filter((q) => !q.piece.includes('_s3_'))].map((q, k) => ({ ...q, uid: k }));
const design = { name: 'Brood Mother', catalogVersion: 1, paint: '#3d4763', rigid: true, parts: order };
mkdirSync(join(root, 'data/ships/bespoke'), { recursive: true });
writeFileSync(join(root, 'data/ships/bespoke/brood_mother.json'), compactJson(pieceFile));
writeFileSync(join(root, 'data/ships/blueprints/enemy/brood_mother.json'), JSON.stringify(design, null, 1) + '\n');
const by = (st) => pieces.filter((p) => p.stage === st).length;
console.log(`${pieces.length} pieces: stage 1 ${by(1)}, stage 2 ${by(2)}, stage 3 ${by(3)}`);

const out = process.argv[2];
if (out) {
  const colors = { 1: '#4a5678', 2: '#5a4a7a', 3: '#cf7cff' };
  const s = 12;
  const paths = pieces.map((p) => `<polygon points="${p.polygon.map(([x, y]) => `${x * s},${y * s}`).join(' ')}" fill="${p.skeleton ? 'none' : colors[p.stage]}" stroke="#111" stroke-width="1"/>`);
  writeFileSync(out, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-50 * s} ${-56 * s} ${100 * s} ${126 * s}" style="background:#0b0f16">${paths.join('')}</svg>`);
}
