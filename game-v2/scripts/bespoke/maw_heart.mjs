/**
 * The Heart of the Maw, redesigned (DESIGN ONLY: docs/bosses/maw-heart-redesign.md). Writes its bespoke pieces and its
 * designs to docs/bosses/maw-heart/ (never to data/: the game does not load them; the live boss is still
 * bosses.json boss_maw_heart on design maw_heart_titan). Render them with scripts/bespoke/maw_heart_render.mjs.
 *
 *   node scripts/bespoke/maw_heart.mjs [preview.svg]
 *
 * Grid units (a cell is 24 world units), y down, nose towards -y; scaled by S on the way out. Angles are degrees
 * clockwise from straight ahead. Left and right are mirrored.
 *
 * Its look: an outcrop of the shard ring's dark rock that beats. Four-fold about its middle (the four axes, where its
 * seams run gold), with two breaks on purpose: a crown of glass on its apex only, and its back roots longer (the side it
 * lies buried on). Read in three sizes: a few big masses (four caps, four buttresses, four roots), a middle layer of
 * structure (stepped plates, knots), and fine detail only where the eye should go (the gold seams converging on the
 * eye at its middle, where the core shows through). In three stages, laid out round the beat:
 *
 *   1 the bed       four caps on the axes (`ruin`: they decide the stage), each a stepped stone plate split by a gold
 *                   seam; four buttresses on the diagonals between them (inner and outer: they calve); a keystone over
 *                   the middle with the eye in it; four roots, each held by a glowing knot (shoot the knot and the root
 *                   goes whole); a crown of three glass shards on the apex. Under the crust, a lattice (its skeleton)
 *   2 the chambers  four chambers on the axes, each two dark-metal walls and a valve lip with a deep glowing throat
 *                   (all `ruin`: they gape when worn out); a septum over the middle with its iris; four arteries on the
 *                   diagonals (optional: they feed its pull)
 *   3 the node      the knot at the middle (`under`): a core of seam glass, lit from within, in a ring of dark metal;
 *                   four valve teeth on the diagonals (`ruin`) and four stubs on the axes (optional)
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = join(root, 'docs/bosses/maw-heart');
const DEG = Math.PI / 180;
const round = (v) => Math.round(v * 1000) / 1000;
const flipX = ([x, y]) => [round(-x), y];
const mirror = (pts) => pts.map(flipX).reverse();
const norm = ([x, y]) => { const l = Math.hypot(x, y) || 1; return [x / l, y / l]; };

/** Drawn at this scale on the way out */
const S = 1.6;
// Its proposed materials (not in the game's table: maw_heart_render.mjs adds them, and their surfaces, to its private
// renderer only; the doc's section 2 has them). METAL is the game's leaded iridium: the node's machined collar and root tips
const ROCK = 'maw_crust', STONE = 'maw_heartstone', METAL = 'leaded_iridium', SEAM = 'maw_seamglass', GLASS = 'maw_shardglass', BONE = 'maw_bone';
// Its palette: three steps of stone (deep, face, rim), warm stone where the seams light it, gold from deep to white-hot
const DEEP = '#26272b', FACE = '#45474d', TOP = '#585b62', RIM = '#9097a1', WARM1 = '#d9a356', WARM2 = '#94713f';
const GOLD = '#ffb238', GOLD2 = '#ffd27a', HOT = '#fff4d8', PIT = '#121215', BRONZE = '#8a6a3a', GREY = '#8d939c';

/** A point `r` out from the middle, `deg` round from straight ahead */
const P = (r, deg) => [round(r * Math.sin(deg * DEG)), round(-r * Math.cos(deg * DEG))];
/** Rock's roughness, small: a fixed wobble by place (the same at a shared corner) */
const rough = (r, deg, amp) => r + amp * (Math.sin(deg * 0.43 + r * 1.3) * 0.6 + Math.sin(deg * 0.19 - r * 0.7) * 0.4);
/** An arc band between radii r0 and r1, from a0 to a1 degrees, its outer edge a little rough */
const band = (r0, r1, a0, a1, n = 8, amp = 0) => [
  ...Array.from({ length: n + 1 }, (_, k) => P(rough(r1, a0 + ((a1 - a0) * k) / n, amp), a0 + ((a1 - a0) * k) / n)),
  ...Array.from({ length: n + 1 }, (_, k) => P(r0, a1 - ((a1 - a0) * k) / n)),
];
/** The same band with its corners cut (a chamfered stone) */
const block = (r0, r1, a0, a1, cut, n = 8, amp = 0) => {
  const da = (cut / ((r0 + r1) / 2)) / DEG;
  return [P(r0 + cut, a0), ...Array.from({ length: n + 1 }, (_, k) => P(rough(r1 - (k === 0 || k === n ? cut : 0), a0 + da + ((a1 - a0 - 2 * da) * k) / n, amp), a0 + da + ((a1 - a0 - 2 * da) * k) / n)), P(r0 + cut, a1), ...Array.from({ length: n - 1 }, (_, k) => P(r0, a1 - da - ((a1 - a0 - 2 * da) * (k + 1)) / n))];
};
const ringPts = (c, r, n, off = 0) => Array.from({ length: n }, (_, k) => [round(c[0] + Math.cos(off + (k / n) * Math.PI * 2) * r), round(c[1] + Math.sin(off + (k / n) * Math.PI * 2) * r)]);
const oval = (c, a, b, dir, n = 14) => { const [ux, uy] = norm(dir); return Array.from({ length: n }, (_, k) => { const t = (k / n) * Math.PI * 2, p = Math.cos(t) * a, q = Math.sin(t) * b; return [round(c[0] + ux * p - uy * q), round(c[1] + uy * p + ux * q)]; }); };
/** A strip along a path, `w0` wide at its start to `w1` at its end: a channel's or a warm wash's polygon */
function strip(path, w0, w1 = w0) {
  const L = [], R = [], n = path.length;
  path.forEach((p, k) => {
    const a = path[Math.max(0, k - 1)], b = path[Math.min(n - 1, k + 1)], [ux, uy] = norm([b[0] - a[0], b[1] - a[1]]), w = (w0 + ((w1 - w0) * k) / (n - 1)) / 2;
    L.push([round(p[0] - uy * w), round(p[1] + ux * w)]); R.push([round(p[0] + uy * w), round(p[1] - ux * w)]);
  });
  return [...L, ...R.reverse()];
}
/** A radial path along `deg` from r0 to r1 */
const radial = (r0, r1, deg, n = 4) => Array.from({ length: n + 1 }, (_, k) => P(r0 + ((r1 - r0) * k) / n, deg));
const raise = (poly, color) => ({ kind: 'raise', color, poly });
const recess = (poly, color = PIT) => ({ kind: 'recess', color, poly });
const channel = (poly, color = GOLD) => ({ kind: 'channel', color, poly });
const glow = (at, r, color = GOLD) => ({ kind: 'glow', at, r, color });
const halo = (at, r, w, color = GOLD) => ({ kind: 'halo', at, r, w, color });
const vein = (pts, w = 0.3, color = GOLD) => ({ kind: 'vein', w, color, poly: pts });
const crystal = (at, dir, r, w, color) => ({ kind: 'shard', crystal: true, ...(color ? { color } : {}), at, dir: norm(dir), r, w });
/** Fixed noise in [0, 1) from a number (the same every run) */
const nz = (a) => { const v = Math.sin(a * 12.9898 + 78.233) * 43758.5453; return v - Math.floor(v); };
/** A polygon chipped: each corner pulled in or out from its middle a little, by place, so no two plates are alike */
function chip(poly, amp, seed) {
  const c = [poly.reduce((a, p) => a + p[0], 0) / poly.length, poly.reduce((a, p) => a + p[1], 0) / poly.length];
  return poly.map(([x, y], i) => { const f = 1 + (nz(seed * 31 + i * 7.3) - 0.55) * amp; return [round(c[0] + (x - c[0]) * f), round(c[1] + (y - c[1]) * f)]; });
}
/** A path wobbled sideways at its inner points (its ends held) */
function wob(path, amp, seed) {
  return path.map((p, i) => {
    if (i === 0 || i === path.length - 1) return p;
    const a = path[i - 1], b = path[i + 1], [ux, uy] = norm([b[0] - a[0], b[1] - a[1]]), o = (nz(seed * 17 + i * 3.1) - 0.5) * 2 * amp;
    return [round(p[0] - uy * o), round(p[1] + ux * o)];
  });
}
/** Gold that fades as it runs out from the heart: bright near it, ember at the crust's edge */
const FADE = ['#ffcf72', '#e0962f', '#b07024', '#80521e', '#5a3d1a'];
const fade = (r) => FADE[Math.max(0, Math.min(FADE.length - 1, Math.floor((r - 4) / 7)))];
/**
 * A vein of the heartbeat out along an axis: a wobbling main vein, tapering, its gold fading with distance from the
 * heart, capillaries branching off it into the crust (alternate sides, shorter and dimmer outward), a few of them
 * forking again. Not a bar: a thing that carries something
 */
function veinTree(r0, r1, deg, w, seed, branches = 4) {
  const out = [], steps = 7;
  const main = wob(Array.from({ length: steps + 1 }, (_, k) => P(r0 + ((r1 - r0) * k) / steps, deg + (nz(seed + k) - 0.5) * 3)), 0.5, seed);
  // (in two lengths, so the outer one can be dimmer and thinner)
  const cut = Math.ceil(steps * 0.45);
  out.push(vein(main.slice(0, cut + 1), w, fade(r0)), vein(main.slice(cut), w * 0.55, fade(r0 + (r1 - r0) * 0.6)));
  for (let b = 0; b < branches; b++) {
    const t = 0.22 + (b / branches) * 0.68 + (nz(seed * 3 + b) - 0.5) * 0.08, r = r0 + (r1 - r0) * t, side = b % 2 ? 1 : -1;
    const ang = deg + side * (32 + nz(seed + b * 5) * 26), len = (r1 - r0) * (0.32 - t * 0.14) * (0.8 + nz(seed * 7 + b) * 0.5);
    const root = P(r, deg), [dx, dy] = [Math.sin(ang * DEG), -Math.cos(ang * DEG)];
    const pts = wob(Array.from({ length: 4 }, (_, k) => [round(root[0] + dx * len * (k / 3)), round(root[1] + dy * len * (k / 3))]), 0.35, seed * 11 + b);
    out.push(vein(pts, w * (0.42 - t * 0.18), fade(r + 4)));
    if (nz(seed * 13 + b) > 0.45) {
      const fr = pts[2], fa = ang + side * 34, fl = len * 0.45;
      out.push(vein([fr, [round(fr[0] + Math.sin(fa * DEG) * fl * 0.5), round(fr[1] - Math.cos(fa * DEG) * fl * 0.5)], [round(fr[0] + Math.sin(fa * DEG) * fl), round(fr[1] - Math.cos(fa * DEG) * fl)]], w * 0.2, fade(r + 10)));
    }
  }
  return out;
}
/** A rounded lobe (a ventricle's half): its outer edge bulging, `r0` to `r1` at its middle, from a0 to a1 */
function lobe(r0, r1, a0, a1, mid, half, n, seed) {
  const outer = Array.from({ length: n + 1 }, (_, k) => { const a = a0 + ((a1 - a0) * k) / n, f = Math.cos(Math.min(1, Math.abs(a - mid) / half) * Math.PI / 2) ** 0.55; return P(r0 + 2 + (r1 - r0 - 2) * f + (nz(seed + k) - 0.5) * 0.7, a); });
  return [...outer, ...Array.from({ length: 4 }, (_, k) => P(r0, a1 - ((a1 - a0) * k) / 3))];
}

const pieces = [], parts = [];
const extra = [];
let uid = 0;
function part(name, fn, material, polygon, opts = {}) {
  const id = `mawheart_${name}`;
  pieces.push({
    id, polygon, ...(opts.stage ? { stage: opts.stage } : {}), ...(opts.ruin ? { ruin: true } : {}), ...(opts.under ? { under: true } : {}),
    ...(opts.relief ? { relief: opts.relief } : {}), ...(opts.detail?.length ? { detail: opts.detail } : {}), ...(opts.skeleton ? { skeleton: opts.skeleton } : {}),
  });
  (opts.bed ? extra : parts).push({ uid: uid++, piece: id, fn, material, x: 0, y: 0, rot: 0, flip: false });
}
const mirrorDetail = (d) => ({ ...d, ...(d.poly ? { poly: d.kind === 'vein' || d.kind === 'cable' ? d.poly.map(flipX) : mirror(d.poly) } : {}), ...(d.at ? { at: flipX(d.at) } : {}), ...(d.dir ? { dir: flipX(d.dir) } : {}) });
function pair(name, fn, material, polygon, opts = {}) {
  part(`${name}_l`, fn, material, polygon, opts);
  part(`${name}_r`, fn, material, mirror(polygon), { ...opts, detail: opts.detail?.map(mirrorDetail) });
}
/** The four axes: apex, the flanks (left built, right mirrored), base */
const AXES = [['apex', 0], ['flank', -90], ['base', 180]];
function onAxes(fn) {
  for (const [k, deg] of AXES) {
    if (k === 'flank') { const got = []; fn(k, deg, (...a) => got.push(a)); for (const [n, ...a] of got) pair(n, ...a); }
    else fn(k, deg, (n, ...a) => part(n, ...a));
  }
}
const DIAG = [[0, -45], [1, -135]];
const AXSEED = { apex: 3, flank: 7, base: 11 };
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
function tentacle(pts, w0, w1, segs, per = 6) {
  const c = spline(pts, segs * per), last = c.length - 1;
  const sideAt = (k) => {
    const a = c[Math.max(0, k - 1)], b = c[Math.min(last, k + 1)], [ux, uy] = norm([b[0] - a[0], b[1] - a[1]]);
    const t = k / last, w = (w0 + (w1 - w0) * t) * (1 + 0.1 * Math.cos(t * segs * Math.PI * 2)) / 2;
    return [[c[k][0] - uy * w, c[k][1] + ux * w], [c[k][0] + uy * w, c[k][1] - ux * w]];
  };
  return Array.from({ length: segs }, (_, s) => {
    const k0 = Math.max(0, s * per - 1), k1 = Math.min(last, (s + 1) * per + 1), L = [], R = [];
    for (let k = k0; k <= k1; k++) { const [l, r] = sideAt(k); L.push(l); R.push(r); }
    if (k1 === last) { L.pop(); R.pop(); L.push(c[last]); }
    return { poly: [...L, ...R.reverse()].map((q) => q.map(round)), path: c.slice(k0, k1 + 1).map((q) => q.map(round)) };
  });
}
/** A clutch of crystal round a point, pointing out from it (the Maw's glass, not a lens) */
const clutch = (c, n, len, seed, color = '#c79a52') => Array.from({ length: n }, (_, i) => {
  const a = (i / n) * 360 + nz(seed + i) * 40;
  return crystal([round(c[0] + Math.sin(a * DEG) * 0.6), round(c[1] - Math.cos(a * DEG) * 0.6)], [Math.sin(a * DEG), -Math.cos(a * DEG)], len * (0.7 + nz(seed * 3 + i) * 0.6), len * 0.32, color);
});
/** A feathered light: one glow, ember at its rim to white at its middle (the renderer blends it smoothly: maw_heart_relief.ts) */
const feather = (c, r) => [{ kind: 'glow', at: c, r, color: '#241103', sides: 48 }];

// =====================================================================================================================
// Stage 3, the node: beneath everything (drawn first), bared when its chambers burst. Half made, half grown: a machined
// collar of dark metal, its plates exact, its rings true, with roots grown over it and through it, holding the core
// =====================================================================================================================
const S3 = { stage: 3, under: true };
// Its collar: engineered. Eight equal plates in a ring, exact gaps, two true rings
part('s3_ring', 'conduit', METAL, ringPts([0, 0], 12.2, 48, 0), {
  ...S3, relief: 'raise',
  detail: [
    ...Array.from({ length: 8 }, (_, k) => raise(band(8.2, 11.6, k * 45 + 2.0, k * 45 + 43, 6), k % 2 ? '#4f5258' : '#5e6168')),
    ...Array.from({ length: 8 }, (_, k) => raise(band(10.4, 11.3, k * 45 + 8, k * 45 + 37, 5), '#787c84')),
    { kind: 'ring', at: [0, 0], r: 12.1, w: 0.4, sides: 48, color: '#8a8e96' },
    { kind: 'ring', at: [0, 0], r: 7.9, w: 0.3, sides: 48, color: '#6c7078' },
    ...Array.from({ length: 16 }, (_, k) => ({ kind: 'ring', at: P(9.3, k * 22.5 + 11.25), r: 0.28, w: 0.14, sides: 8, color: '#a2a8b0' })),
  ],
});
// Its valve teeth: grown. The last four roots holding the core, curved and uneven, lying over the collar
for (const [k, deg, len, curl, w] of [[0, -45, 12.5, 24, 5.4], [1, 45, 15.5, -17, 5.8], [2, -135, 16.5, -28, 6.2], [3, 135, 11, 14, 5.0]]) {
  const pts = [P(5.6, deg), P(5.6 + len * 0.4, deg + curl * 0.25), P(5.6 + len * 0.75, deg + curl * 0.65), P(5.6 + len, deg + curl)];
  const [sg] = tentacle(pts, w, 0.7, 1, 12), n = sg.path.length;
  part(`s3_valve${k}`, 'generator', ROCK, sg.poly, {
    ...S3, ruin: true, relief: 'round',
    detail: [raise(strip(sg.path.slice(1, n - 2), w * 0.55, w * 0.18), FACE), raise(strip(sg.path.slice(2, n - 3), w * 0.26, w * 0.1), TOP), vein(sg.path.slice(0, Math.floor(n * 0.6)), 0.28, '#b8762c')],
  });
}
// Its stubs: knobs of growth on the axes, where the arteries met it, each its own size, a rib of it over the collar
onAxes((k, deg, emit) => {
  const sz = { apex: 1.9, flank: 2.3, base: 1.6 }[k], c = P(12.4, deg);
  emit(`s3_stub_${k}`, 'conduit', ROCK, chip(oval(c, sz * 1.25, sz, [Math.sin(deg * DEG), -Math.cos(deg * DEG)], 10), 0.18, AXSEED[k]), {
    ...S3, relief: 'round', detail: [raise(chip(oval(c, sz * 0.8, sz * 0.6, [1, 0], 8), 0.2, AXSEED[k] + 1), TOP)],
  });
});
// The core, last: seam glass, a dark iris, and the beat in its middle: a feathered light, brightest of anything on it
part('s3_core', 'core', 'maw_coreglass', ringPts([0, 0], 7.6, 40, 0), {
  ...S3, ruin: true,
  detail: [
    recess(ringPts([0, 0], 7.0, 40, 0), '#120e0a'),
    ...feather([0, 0], 6.0),
  ],
});

// =====================================================================================================================
// Stage 2, the chambers: four ventricles hollowed in the rock. Worn out, each gapes (a wreck) until the Heart bursts
// them, one a beat
// =====================================================================================================================
const S2 = { stage: 2, ruin: true };
const CH_HALF = 36;
onAxes((k, deg, emit) => {
  const r1 = k === 'apex' ? 31.5 : k === 'base' ? 29.5 : 28.5, sd = AXSEED[k];
  // Its two halves: a rounded lobe of rock, ribbed across, a wet sheen near its rim
  for (const [s, a0, a1] of [['a', deg - CH_HALF, deg + 0.5], ['b', deg - 0.5, deg + CH_HALF]]) {
    const ribs = [13.5, 18, 22.5].map((r, i) => raise(strip(wob(Array.from({ length: 6 }, (_, j) => P(r + (nz(sd + i + j) - 0.5) * 0.8, a0 + 7 + ((a1 - a0 - 14) * j) / 5)), 0.3, sd * 5 + i), 1.5 - i * 0.2, 1.1 - i * 0.2), i === 1 ? TOP : FACE));
    emit(`ch_${k}_wall${s}`, 'armor', STONE, lobe(9.5, r1, a0, a1, deg, CH_HALF, 10, sd * 3 + (s === 'a' ? 0 : 1)), {
      ...S2, relief: 'plate',
      detail: [
        raise(lobe(11, r1 - 2.2, a0 + 3, a1 - 3, deg, CH_HALF, 8, sd * 7), '#3b3c41'),
        ...ribs,
      ],
    });
  }
  // Its valve: the ventricle's mouth, a fleshy lip round a deep wet hollow, gold pooled at the bottom of it
  const c = P(r1 - 0.6, deg), dir = [Math.cos(deg * DEG), Math.sin(deg * DEG)];
  emit(`ch_${k}_valve`, 'generator', SEAM, chip(oval(c, 7.2, 4.8, dir, 18), 0.07, sd), {
    ...S2, relief: 'round',
    detail: [
      raise(chip(oval(c, 6.2, 3.9, dir, 16), 0.06, sd + 1), '#3e2c24'),
      recess(chip(oval(c, 5.0, 2.9, dir, 16), 0.08, sd + 2), '#060504'),
      glow(P(r1 - 2.0, deg), 1.9, '#2a1406'),
      raise(strip([P(r1 + 1.9, deg - 7), P(r1 + 2.5, deg - 2), P(r1 + 2.4, deg + 3)], 0.35, 0.12), '#8a7a72'),
    ],
  });
});
// The septum over the middle: the chambers' shared wall, its iris where the core shows through, veins out from it
part('septum', 'armor', STONE, chip(ringPts([0, 0], 11.5, 22, 0.13), 0.06, 21), {
  ...S2, relief: 'plate',
  detail: [
    raise(chip(ringPts([0, 0], 10, 16, 0.3), 0.1, 22), FACE), raise(chip(ringPts([0, 0], 8.2, 12, 0.1), 0.12, 23), TOP),
    ...[0, 90, 180, 270].flatMap((d, i) => veinTree(4.4, 11, d, 0.3, 40 + i, 2)),
    recess(chip(ringPts([0, 0], 4.3, 14, 0.2), 0.12, 24), '#0d0c0b'), ...feather([0, 0], 3.6),
  ],
});
// Its braces on the diagonals, between the chambers: sinew and bone, not pipes (optional: they feed its pull)
for (const [k, deg] of DIAG) {
  const pts = [P(9, deg), P(17, deg + 3.5), P(24, deg - 1.5), P(30.5, deg + 4)];
  const [sg] = tentacle(pts, 4.4, 1.4, 1, 12), n = sg.path.length;
  pair(`artery${k}`, 'conduit', BONE, sg.poly, {
    stage: 2, relief: 'round',
    detail: [raise(strip(sg.path.slice(1, n - 1), 2.4, 0.7), '#8a8275'), raise(strip(sg.path.slice(2, n - 3), 1.0, 0.3), '#a9a090'), vein(sg.path.slice(0, n - 4), 0.3, '#8a5520')],
  });
}

// =====================================================================================================================
// Stage 1, the bed. The caps decide it; the rest calves away when shot (toward the black hole)
// =====================================================================================================================
const S1 = { stage: 1 };
// The buttresses first (the caps lie over them): on the diagonals, inner and outer, rock in uneven plates
for (const [k, deg] of DIAG) {
  const a0 = deg - 26, a1 = deg + 26;
  pair(`crust_diag${k}_in`, 'hull', ROCK, block(12.5, 23.5, a0, a1, 1.6, 8, 0.5), {
    ...S1, relief: 'plate',
    detail: [
      raise(chip(block(14.2, 21.4, a0 + 4, deg + 2, 1.2, 4), 0.14, k * 10 + 1), FACE),
      raise(chip(block(15.5, 22, deg + 4, a1 - 5, 1, 4), 0.16, k * 10 + 2), '#505259'),
      raise(chip(oval(P(19.5, deg - 9), 1.4, 0.9, [1, 0.3], 7), 0.2, k * 10 + 3), '#5d6067'),
      vein(wob([P(13, deg + 3), P(16.5, deg + 8), P(19.5, deg + 6), P(22, deg + 13)], 0.4, k * 10 + 4), 0.22, '#6e4920'),
    ],
  });
  pair(`crust_diag${k}_out`, 'armor', ROCK, block(22.5, 32, a0 + 3, a1 - 3, 1.8, 8, 0.9), {
    ...S1, relief: 'plate',
    detail: [
      raise(chip(block(24.2, 30, a0 + 6, deg - 1, 1.2, 4, 0.4), 0.15, k * 10 + 5), TOP),
      raise(chip(block(24.8, 29.2, deg + 1, a1 - 8, 1, 4, 0.4), 0.15, k * 10 + 6), FACE),
      raise(chip(oval(P(30.6, deg + 6), 1.6, 0.8, [1, 0], 7), 0.25, k * 10 + 7), '#5d6067'),
    ],
  });
}
// The caps: one over each chamber, stone in uneven plates, its vein of the heartbeat branching down its axis
onAxes((k, deg, emit) => {
  const r1 = k === 'apex' ? 38 : k === 'base' ? 35 : 34.5, half = 25, sd = AXSEED[k];
  emit(`cap_${k}`, 'armor', STONE, block(13.5, r1, deg - half, deg + half, 2.2, 10, 0.9), {
    ...S1, ruin: true, relief: 'plate',
    detail: [
      // (three plates of different sizes and shades, not a stepped emblem)
      raise(chip(block(15.5, r1 - 2.6, deg - half + 3.5, deg - 1.5, 1.4, 5, 0.5), 0.1, sd), FACE),
      raise(chip(block(17, r1 - 1.8, deg + 1, deg + half - 4.5, 1.4, 5, 0.6), 0.1, sd + 1), '#505259'),
      raise(chip(block(21, r1 - 6.5, deg - half + 7, deg - 6, 1, 4, 0.4), 0.16, sd + 2), TOP),
      // (chips of lighter stone at its edges: weathering)
      raise(chip(oval(P(r1 - 1.6, deg - half + 6), 1.5, 0.8, [1, 0.2], 7), 0.25, sd + 3), '#5d6067'),
      raise(chip(oval(P(r1 - 2.4, deg + half - 9), 1.1, 0.7, [1, -0.2], 7), 0.25, sd + 4), '#55585e'),
      raise(chip(oval(P(16.5, deg + half - 5), 0.9, 0.6, [0.4, 1], 6), 0.25, sd + 5), '#55585e'),
      // (warm stone round the vein, near the heart only)
      ...veinTree(14, r1 - 2.5, deg, 0.6, sd * 19),
    ],
  });
});
// Its overgrowth: a lump of crust grown over its right shoulder, glass coming through it (a break in the symmetry the
// way rock breaks it, not a design)
part('crust_growth', 'hull', ROCK, chip([P(28, 50), P(33.5, 55), P(37.5, 64), P(36, 74), P(31.5, 80), P(27, 76), P(25.5, 62)], 0.08, 61), {
  ...S1, relief: 'plate',
  detail: [
    raise(chip([P(29, 55), P(33.5, 59), P(35, 67), P(32, 75), P(28.5, 70)], 0.14, 62), FACE),
    raise(chip(oval(P(33.5, 62), 1.3, 0.8, [1, 0], 7), 0.25, 63), RIM),
    ...clutch(P(31.5, 68), 3, 3.6, 64, '#6d6253'),
    vein(wob([P(26.5, 63), P(29.5, 66), P(31.5, 68)], 0.3, 65), 0.24, '#9a6224'),
  ],
});
// The keystone over the middle: uneven rings of stone round the eye, where the four veins rise and the beat shows
part('crust_key', 'armor', STONE, chip(ringPts([0, 0], 15, 22, 0.13), 0.05, 31), {
  ...S1, relief: 'plate',
  detail: [
    raise(chip(ringPts([0, 0], 13.2, 14, 0.3), 0.1, 32), FACE), raise(chip(ringPts([0, 0], 10.6, 11, 0.1), 0.14, 33), TOP),
    raise(chip(ringPts([0, 0], 8.0, 9, 0.5), 0.12, 34), '#3c3d42'),
    ...[0, 90, 180, 270].flatMap((d, i) => veinTree(5.4, 15.2, d, 0.85, 50 + i * 7, 2)),
    recess(chip(ringPts([0, 0], 5.4, 14, 0.1), 0.1, 39), '#0c0b0a'),
    ...feather([0, 0], 4.8),
  ],
});
// The crown: three shards of glass on the apex only (the first break in its symmetry)
for (const [n, deg, len, w] of [['crown_mid', 0, 15, 2.6], ['crown_side', -11, 10, 2.0]]) {
  const r = 35.5, base = [P(r - 2.2, deg - w * 2.2), P(r - 2.2, deg + w * 2.2)];
  const pg = [base[0], P(r + len * 0.4, deg - w * 1.3), P(r + len, deg), P(r + len * 0.4, deg + w * 1.3), base[1]];
  const opts = { ...S1, relief: 'ridge', detail: [vein(wob(radial(r - 1, r + len * 0.7, deg, 3), 0.15, n.length), 0.3, '#8a5a24')] };
  if (deg === 0) part(n, 'armor', GLASS, pg, opts); else pair(n, 'armor', GLASS, pg, opts);
}
// The roots: four, on the diagonals, curling back to grip the bed. The back pair longer (the second break: the side it
// lies buried on). Each held by a knot: a clutch of the Maw's glass grown round a light, not a porthole
for (const [k, deg, len, curl] of [[0, -45, 25, -26], [1, -135, 33, -24]]) {
  const r0 = 31, w = 7.2;
  const pts = [P(r0 - 2, deg), P(r0 + len * 0.35, deg + curl * 0.15), P(r0 + len * 0.7, deg + curl * 0.5), P(r0 + len, deg + curl)];
  tentacle(pts, w, 0.8, 3).forEach((sg, s) => {
    const n = sg.path.length, mid = sg.path.slice(1, n - 1);
    pair(`root${k}${'abc'[s]}`, s === 0 ? 'armor' : 'hull', s === 2 ? METAL : ROCK, sg.poly, {
      ...S1, relief: 'round',
      detail: [raise(strip(mid, w * (0.5 - s * 0.14), w * (0.38 - s * 0.12)), s === 0 ? TOP : FACE), vein(mid, 0.24 - s * 0.05, '#6e4920')],
    });
  });
  const kc = P(r0, deg);
  pair(`root${k}_knot`, 'conduit', SEAM, chip(oval(kc, 4.6, 4.0, [Math.sin(deg * DEG), -Math.cos(deg * DEG)], 14), 0.16, 70 + k), {
    ...S1, relief: 'round',
    detail: [
      raise(chip(oval(kc, 3.6, 3.0, [1, 0.4], 11), 0.18, 72 + k), '#3e2c24'),
      ...clutch(kc, 7, 2.3, 74 + k * 9),
      glow(kc, 1.5, '#3a1e08'),
    ],
  });
}

// ---- The lattice under the crust (look only: client ships/skeletonBuild.ts), bared as the crust calves ----
const BONES = [];
function branch(a, deg, len, depth, w) {
  const b = [round(a[0] + Math.sin(deg * DEG) * len), round(a[1] - Math.cos(deg * DEG) * len)];
  BONES.push({ pts: [a, [round((a[0] + b[0]) / 2), round((a[1] + b[1]) / 2)], b], w: [w, w * 0.85, w * 0.7], layer: depth > 1 ? 0 : 1 });
  if (depth > 0) for (const s of [-30, 30]) branch(b, deg + s, len * 0.58, depth - 1, w * 0.62);
}
for (const deg of [-45, -135]) branch(P(10, deg), deg, 9, 3, 1.6);
for (const deg of [0, -90, 180]) branch(P(12, deg), deg, 7, 2, 1.2);
const arcBone = (r, a0, a1, w, lava) => ({ pts: Array.from({ length: 13 }, (_, k) => P(r, a0 + ((a1 - a0) * k) / 12)), w: Array(13).fill(w), layer: 0, ...(lava ? { lava: true } : {}) });
BONES.push(arcBone(17, -180, 0, 1.3, true), arcBone(26, -180, 0, 1.0, false));
const RIM_PTS = [...Array.from({ length: 19 }, (_, k) => P(26, -180 + k * 10)), P(8, 0), P(8, -180)];
const SKPARTS = [
  { kind: 'drum', at: P(17, -45), r: 1.6 }, { kind: 'drum', at: P(17, -135), r: 1.6 }, { kind: 'drum', at: P(27, -90), r: 1.3 },
  { kind: 'pipe', pts: [P(11, -22), P(17, -22), P(27, -22), P(31, -28)], w: 0.6, glow: true },
  { kind: 'pipe', pts: [P(11, -158), P(17, -158), P(27, -158), P(31, -152)], w: 0.6, glow: true },
];
const PALETTE = { bone: '#a29a8c', fine: '#4a4740', part: '#2c2a27', edge: '#6b665c', bolt: '#d8d0c0', hot: '#ffae38', hotCore: '#fff4d8' };
const flipPart = (q) => ({ ...q, ...(q.pts ? { pts: q.pts.map(flipX) } : {}), ...(q.at ? { at: flipX(q.at) } : {}) });
for (const sd of ['l', 'r']) {
  const m = sd === 'l' ? (q) => q : flipX, mp = sd === 'l' ? (q) => q : flipPart;
  part(`lattice_${sd}`, 'bone_frame', ROCK, (sd === 'l' ? RIM_PTS : [...RIM_PTS].reverse()).map(m), {
    ...S1,
    skeleton: { rim: (sd === 'l' ? RIM_PTS : [...RIM_PTS].reverse()).map(m), rimW: 0.9, bones: BONES.map((b) => ({ ...b, pts: b.pts.map(m) })), parts: SKPARTS.map(mp), palette: PALETTE },
  });
}

// ---- Its bed (render only: never part of the boss): a crater rim of boulders round it, and a drift over its back ----
/** A boulder: an angular rock, longer than it's wide, its lit top raised and a shadowed face on its far side */
function boulder(name, c, sz, rot, k, single = false) {
  const n = 5 + (k % 3), el = 1.25 + (k % 4) * 0.12;
  const pg = Array.from({ length: n }, (_, i) => { const a = (i / n) * Math.PI * 2 + (k % 2) * 0.3, rr = sz * (0.8 + 0.2 * Math.abs(Math.sin(i * 2.7 + k))); const x = Math.cos(a) * rr * el, y = Math.sin(a) * rr; const ca = Math.cos(rot * DEG), sa = Math.sin(rot * DEG); return [round(c[0] + x * ca - y * sa), round(c[1] + x * sa + y * ca)]; });
  const top = pg.map(([x, y]) => [round(c[0] + (x - c[0]) * 0.58 - sz * 0.12), round(c[1] + (y - c[1]) * 0.58 - sz * 0.15)]);
  const opts = { relief: 'plate', bed: true, detail: [raise(top, k % 2 ? TOP : FACE)] };
  if (single) part(name, 'hull', k % 3 === 0 ? STONE : ROCK, pg, opts); else pair(name, 'hull', k % 3 === 0 ? STONE : ROCK, pg, opts);
}
// (the rim: big boulders on the four diagonals, smaller between, a gap ahead where it looks out; even all round)
const RIMS = [[-14, 2.6], [-26, 3.6], [-38, 4.4], [-50, 6.6], [-63, 4.0], [-75, 3.2], [-88, 5.0], [-101, 3.4], [-113, 4.4], [-126, 5.4], [-139, 7.6], [-153, 4.8], [-166, 3.8]];
RIMS.forEach(([deg, sz], k) => boulder(`rim${k}`, P(46 + sz * 0.5, deg), sz, -deg + 90, k));
boulder('rim_aft', P(49, 180), 5.4, 0, 3, true);
// (the drift: a slope of rubble over its back third, biggest at the bottom, smaller up its back)
const DRIFT = [[-150, 30, 6.8], [-125, 33, 5.6], [-165, 21, 5.2], [-138, 22, 4.4], [-112, 26, 3.8]];
DRIFT.forEach(([deg, r, sz], k) => boulder(`drift${k}`, P(r, deg), sz, -deg, k + 2));
boulder('drift_mid', P(26, 180), 6.6, 0, 1, true);
boulder('drift_low', P(36, 180), 5.2, 90, 4, true);

// ---- Out: scaled by S ----
const sc = (q) => [round(q[0] * S), round(q[1] * S)];
const scaleDetail = (d) => ({ ...d, ...(d.poly ? { poly: d.poly.map(sc) } : {}), ...(d.at ? { at: sc(d.at) } : {}), ...(d.r !== undefined ? { r: round(d.r * S) } : {}), ...(d.w !== undefined ? { w: round(d.w * S) } : {}) });
const scalePart = (q) => ({ ...q, ...(q.pts ? { pts: q.pts.map(sc) } : {}), ...(q.poly ? { poly: q.poly.map(sc) } : {}), ...(q.at ? { at: sc(q.at) } : {}), ...(q.r !== undefined ? { r: round(q.r * S) } : {}), ...(q.w !== undefined ? { w: round(q.w * S) } : {}) });
for (const p of pieces) {
  p.polygon = p.polygon.map(sc);
  if (p.detail) p.detail = p.detail.map(scaleDetail);
  if (p.skeleton) {
    const k = p.skeleton;
    p.skeleton = { ...k, rim: k.rim.map(sc), rimW: round(k.rimW * S), bones: k.bones.map((b) => ({ ...b, pts: b.pts.map(sc), w: b.w.map((v) => round(v * S)) })), parts: k.parts.map(scalePart) };
  }
}

// ---- Spent: the node as it is after the end (render only): its light gone out ----
const SPENT = '#2b2722';
// (its core cooled: a dark orb, cracked, a last ember deep in it; a lit crescent on its upper side so it reads round)
const CRACKS = [[[-1, -0.5], [-2.6, -2.2], [-3.4, -4.6], [-5.6, -4.4]], [[0.4, 0.2], [2.4, 0.8], [4.4, 2.6], [6.2, 2.4]], [[-0.3, 0.6], [-0.8, 2.8], [-2.6, 4.6], [-2.2, 6.4]], [[0.5, -0.7], [2.2, -3.2], [3.0, -5.8]]];
const SPENT_CORE = [
  recess(ringPts([0, 0], 7.0, 40, 0), '#0e0c0a'),
  raise(ringPts([0, 0], 6.4, 40, 0), '#2a2724'),
  raise(ringPts([-0.9, -1.0], 4.6, 32, 0), '#33302c'),
  raise(oval([-2.6, -3.4], 2.6, 0.7, [1, -0.6], 16), '#4a4640'),
  ...CRACKS.map((c) => recess(strip(c, 0.4, 0.08), '#0a0807')),
  glow([0.2, 0.1], 0.8, '#2a1404'),
].map(scaleDetail);
for (const p of pieces.filter((q) => q.stage === 3)) {
  const detail = p.id.endsWith('s3_core') ? SPENT_CORE : (p.detail ?? []).filter((d) => d.kind !== 'glow' && d.kind !== 'vein').map((d) => (d.color && d.kind !== 'recess' && d.kind !== 'raise' ? { ...d, color: SPENT } : d));
  pieces.push({ ...p, id: `${p.id}_spent`, detail });
}

// ---- Dim: the bed's light down to embers, for its dormant still (render only) ----
/** A colour taken down to `f` of itself */
const darken = (c, f) => '#' + [1, 3, 5].map((i) => Math.round(parseInt(c.slice(i, i + 2), 16) * f).toString(16).padStart(2, '0')).join('');
for (const p of pieces.filter((q) => q.stage === 1)) pieces.push({
  ...p, id: `${p.id}_dim`,
  detail: p.detail?.filter((d) => !(d.kind === 'glow' && d.r < 2 * S)).map((d) => (d.kind === 'vein' ? { kind: 'channel', color: darken(d.color, 0.38), poly: strip(d.poly, d.w * 0.8, d.w * 0.3) } : d.kind === 'channel' ? { ...d, color: darken(d.color, 0.32) } : d.kind === 'glow' ? { ...d, color: darken(d.color, 0.4) } : [WARM1, WARM2].includes(d.color) ? { ...d, color: '#3f3830' } : d)),
});

// ---- Connectivity (a quick geometric check: every part reaches the core through overlapping parts, also with the
// earlier stages gone). The real check is ShipBridge's orphanGroups (doc section 9) ----
const byId = new Map(pieces.map((p) => [p.id, p]));
const segX = (a, b, c, d) => { const o = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])); return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b); };
const inPoly = ([x, y], pg) => { let c = false; for (let i = 0, j = pg.length - 1; i < pg.length; j = i++) if ((pg[i][1] > y) !== (pg[j][1] > y) && x < ((pg[j][0] - pg[i][0]) * (y - pg[i][1])) / (pg[j][1] - pg[i][1]) + pg[i][0]) c = !c; return c; };
const touch = (A, B) => A.some((q) => inPoly(q, B)) || B.some((q) => inPoly(q, A)) || A.some((a, i) => B.some((b, j) => segX(a, A[(i + 1) % A.length], b, B[(j + 1) % B.length])));
function orphans(list) {
  const ps = list.map((q) => byId.get(q.piece)).filter((p) => !p.skeleton);
  const seen = new Set([ps.findIndex((p) => p.id.endsWith('s3_core'))]), todo = [...seen];
  while (todo.length) { const i = todo.pop(); ps.forEach((p, j) => { if (!seen.has(j) && touch(ps[i].polygon, p.polygon)) { seen.add(j); todo.push(j); } }); }
  return ps.filter((_, j) => !seen.has(j)).map((p) => p.id);
}
const stageOfPart = (q) => byId.get(q.piece).stage;

// ---- Designs (docs only). Stage 3 parts first: drawn under ----
const order = [...parts.filter((q) => stageOfPart(q) === 3), ...parts.filter((q) => stageOfPart(q) === 2), ...parts.filter((q) => stageOfPart(q) === 1)];
const design = (name, list) => ({ name, catalogVersion: 1, paint: '#34363c', rigid: true, parts: list.map((q, k) => ({ ...q, uid: k })) });
// (stage 1 half shot: the left front root cut at its knot, two buttresses calved, a crown shard off; caps and lattice on)
const CRACKED_GONE = /root0[abc]_l|root0_knot_l|crust_diag0_out_r|crust_diag1_in_l|crust_diag1_out_l|crown_side_r/;
const VARIANTS = {
  maw_heart: design('Heart of the Maw (redesign)', order),
  maw_heart_dormant: design('Heart of the Maw (redesign), at rest in its bed', [...order.map((q) => (stageOfPart(q) === 1 ? { ...q, piece: `${q.piece}_dim` } : q)), ...extra]),
  maw_heart_cracked: design('Heart of the Maw (redesign), stage 1 half shot', order.filter((q) => !CRACKED_GONE.test(q.piece))),
  maw_heart_chambers: design('Heart of the Maw (redesign), stage 2: the chambers', order.filter((q) => stageOfPart(q) >= 2)),
  maw_heart_node: design('Heart of the Maw (redesign), stage 3: the node', order.filter((q) => stageOfPart(q) === 3)),
  maw_heart_spent: design('Heart of the Maw (redesign), spent', order.filter((q) => stageOfPart(q) === 3).map((q) => ({ ...q, piece: `${q.piece}_spent`, ...(q.fn === 'generator' ? { fn: 'armor', material: METAL } : {}), ...(q.fn === 'core' ? { fn: 'armor', material: ROCK } : {}) }))),
};
mkdirSync(OUT, { recursive: true });
const pieceFile = { _comment: 'DESIGN ONLY, not loaded by the game: the redesigned Heart of the Maw (docs/bosses/maw-heart-redesign.md). Written by scripts/bespoke/maw_heart.mjs.', pieces };
writeFileSync(join(OUT, 'maw_heart.pieces.json'), JSON.stringify(pieceFile, null, 1) + '\n');
for (const [id, d] of Object.entries(VARIANTS)) writeFileSync(join(OUT, `${id}.json`), JSON.stringify(d, null, 1) + '\n');

const by = (st) => parts.filter((q) => stageOfPart(q) === st).length;
let R = 0, Rc = 0;
for (const q of order) for (const [x, y] of byId.get(q.piece).polygon) { const r = Math.hypot(x, y); R = Math.max(R, r); if (!/root|crown/.test(q.piece)) Rc = Math.max(Rc, r); }
console.log(`${parts.length} parts (+${extra.length} bed): stage 1 ${by(1)}, stage 2 ${by(2)}, stage 3 ${by(3)}; radius ${Math.round(R * 24)} world units (${Math.round(Rc * 24)} to the crust)`);
for (const [label, list] of [['full', order], ['stage 1 gone', order.filter((q) => stageOfPart(q) >= 2)], ['stages 1-2 gone', order.filter((q) => stageOfPart(q) === 3)]]) {
  const o = orphans(list);
  console.log(`connectivity, ${label}: ${o.length ? `ORPHANS ${o.join(', ')}` : 'all reach the core'}`);
}

const out = process.argv[2];
if (out) {
  const colors = { 1: '#4a4d55', 2: '#7a6a4a', 3: '#ffc24a' };
  const s = 6;
  const paths = [...order, ...extra].map((q) => byId.get(q.piece)).map((p) => `<polygon points="${p.polygon.map(([x, y]) => `${x * s},${y * s}`).join(' ')}" fill="${p.skeleton ? 'none' : p.stage ? colors[p.stage] : '#2a2c30'}" fill-opacity="${p.stage ? 1 : 0.6}" stroke="#111" stroke-width="1"/>`);
  writeFileSync(out, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-130 * s} ${-130 * s} ${260 * s} ${260 * s}" style="background:#0b0c10">${paths.join('')}</svg>`);
}
