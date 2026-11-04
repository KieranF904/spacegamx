/**
 * The Heart of the Maw, redesigned (DESIGN ONLY: docs/bosses/maw-heart-redesign.md). Writes its bespoke pieces and its
 * designs to docs/bosses/maw-heart/ (never to data/: the game does not load them; the live boss is still
 * bosses.json boss_maw_heart on design maw_heart_titan). Render them with scripts/bespoke/maw_heart_render.mjs.
 *
 *   node scripts/bespoke/maw_heart.mjs [preview.svg]
 *
 * Grid units (a cell is 24 world units), y down, nose towards -y; scaled by S on the way out. Angles are degrees
 * clockwise from straight ahead. Left and right are mirrored; ahead (the apex) and behind (the bed) differ.
 *
 * Its look: an outcrop of the shard ring's dark rock that beats. A four-chambered thing round a knot of greyseam glass,
 * sealed under crust, rooted in a bed of shard rubble (where it lies when it's at rest), gold light in its seams where
 * the plating parts along its four axes. In three stages, laid out round the beat rather than outside to in:
 *
 *   1 the bed       the crust and the roots. Four caps seal its four chambers (the caps are what stage 1 is beaten
 *                   by: `ruin`); crust slabs between them; ten roots, each cut at its knot (the glowing joint at its
 *                   base: shoot that and the whole root goes), a crown of glass shards on its apex. Under the crust,
 *                   a lattice of greyseam veins (its skeleton), bared as the crust calves away
 *   2 the chambers  four chambers, apex, flanks and base, each a root wall, two side walls and a valve lip (all `ruin`:
 *                   they gape when worn out, they don't fall); four arteries on the diagonals between them (optional:
 *                   they feed its pull)
 *   3 the node      the knot at the middle (`under`): a core of seam glass and four valve teeth round it (`ruin`)
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
const mid = (a, b, t = 0.5) => [round(a[0] + (b[0] - a[0]) * t), round(a[1] + (b[1] - a[1]) * t)];

/** Drawn at this scale on the way out (radius about 2700 world units to the root tips, 1200 to the crust) */
const S = 1.6;
// Stand-in materials (the game's own, so it renders today). The proposed boss materials are in the doc, section 3.
const ROCK = 'dense_ferrite', STONE = 'leestone', SEAM = 'pyre_glass', GLASS = 'titanium', DARK = 'leaded_iridium';
const GOLD = '#ffc24a', HOTG = '#fff0c4', GREY = '#9aa1ab', PIT = '#16171b', CRUST = '#3b3d43', GRAIN = '#4a4c52';

/** A point `r` out from the middle, `deg` round from straight ahead */
const P = (r, deg) => [round(r * Math.sin(deg * DEG)), round(-r * Math.cos(deg * DEG))];
/** Rock's roughness: a fixed wobble by place (the same at a shared corner, so neighbours still meet) */
const rough = (r, deg, amp = 0.6) => r + amp * (Math.sin(deg * 0.31 + r * 1.7) * 0.6 + Math.sin(deg * 0.17 - r * 0.9) * 0.4);
const PR = (r, deg, amp) => P(rough(r, deg, amp), deg);
/** An arc band between radii r0 and r1, from a0 to a1 degrees, its outer edge rough */
const band = (r0, r1, a0, a1, n = 6, amp = 0.6) => [
  ...Array.from({ length: n + 1 }, (_, k) => PR(r1, a0 + ((a1 - a0) * k) / n, amp)),
  ...Array.from({ length: n + 1 }, (_, k) => P(r0, a1 - ((a1 - a0) * k) / n)),
];
const ringPts = (c, r, n, off = 0) => Array.from({ length: n }, (_, k) => [round(c[0] + Math.cos(off + (k / n) * Math.PI * 2) * r), round(c[1] + Math.sin(off + (k / n) * Math.PI * 2) * r)]);
const oval = (c, a, b, dir, n = 14) => { const [ux, uy] = norm(dir); return Array.from({ length: n }, (_, k) => { const t = (k / n) * Math.PI * 2, p = Math.cos(t) * a, q = Math.sin(t) * b; return [round(c[0] + ux * p - uy * q), round(c[1] + uy * p + ux * q)]; }); };
const crystal = (at, dir, r, w, color = GOLD) => ({ kind: 'shard', crystal: true, color, at, dir: norm(dir), r, w });
const seam = (pts, w = 0.22, color = GOLD) => ({ kind: 'channel', w, color, poly: pts });
const vein = (pts, w = 0.18, color = GREY) => ({ kind: 'vein', w, color, poly: pts });
const pit = (at, r = 0.5) => [{ kind: 'recess', color: PIT, poly: ringPts(at, r, 7) }, { kind: 'glow', at, r: r * 0.6, color: GOLD }];

const pieces = [], parts = [];
const extra = [];
let uid = 0;
function part(name, fn, material, polygon, opts = {}) {
  const id = `mawheart_${name}`;
  pieces.push({
    id, polygon, ...(opts.stage ? { stage: opts.stage } : {}), ...(opts.ruin ? { ruin: true } : {}), ...(opts.under ? { under: true } : {}),
    ...(opts.mount ? { mount: opts.mount } : {}), ...(opts.relief ? { relief: opts.relief } : {}),
    ...(opts.detail?.length ? { detail: opts.detail } : {}), ...(opts.skeleton ? { skeleton: opts.skeleton } : {}),
  });
  const p = { uid: uid++, piece: id, fn, material, x: 0, y: 0, rot: 0, flip: false, ...(opts.tag ? { tag: opts.tag } : {}) };
  (opts.bed ? extra : parts).push(p);
}
const mirrorDetail = (d) => ({ ...d, ...(d.poly ? { poly: d.kind === 'vein' || d.kind === 'channel' || d.kind === 'cable' ? d.poly.map(flipX) : mirror(d.poly) } : {}), ...(d.at ? { at: flipX(d.at) } : {}), ...(d.dir ? { dir: flipX(d.dir) } : {}) });
function pair(name, fn, material, polygon, opts = {}) {
  part(`${name}_l`, fn, material, polygon, opts);
  part(`${name}_r`, fn, material, mirror(polygon), { ...opts, detail: opts.detail?.map(mirrorDetail) });
}

// The four chambers, by axis: apex (ahead), the flanks, the base (behind). Its outline is a heart's: the apex long and
// pointed, the base broad, the flanks between
const CH = [
  { k: 'apex', deg: 0, half: 28, r1: 33, lip: 37.5 },
  { k: 'flank', deg: -90, half: 36, r1: 27.5, lip: 30.5 },
  { k: 'base', deg: 180, half: 42, r1: 29, lip: 32 },
];

// =====================================================================================================================
// Stage 3, the node: beneath everything (drawn first), bared when its chambers burst
// =====================================================================================================================
const S3 = { stage: 3, under: true };
for (const [k, deg] of [[0, -45], [1, -135]]) {
  // Its valve teeth: four, on the diagonals, each lying over the core and its neighbours' roots
  const pg = [P(4.6, deg - 28), P(9.4, deg - 16), P(14.6, deg - 4), P(15.6, deg + 2), P(10, deg + 13), P(4.6, deg + 26), P(3.2, deg)];
  pair(`s3_valve${k}`, 'generator', SEAM, pg, {
    ...S3, ruin: true, relief: 'ridge',
    detail: [seam([P(5, deg), P(11.5, deg)], 0.32), crystal(P(9, deg), [Math.sin(deg * DEG), -Math.cos(deg * DEG)], 2.6, 0.9), ...pit(P(7, deg), 0.55)],
  });
}
// (a ring of seam glass the teeth sit in, so they hold to each other as well as to the core)
part('s3_ring', 'conduit', SEAM, [...ringPts([0, 0], 8.2, 20)], {
  ...S3, relief: 'round',
  detail: [{ kind: 'ring', at: [0, 0], r: 7.4, w: 0.35, color: GOLD }, ...[0, 90, 180, 270].map((d) => vein([P(5.6, d), P(8, d + 8)], 0.2, GREY))],
});
// Its stubs: where the arteries' channels met the node, on its four axes (optional: each feeds one of stage 3's moves)
for (const [k, deg] of [['apex', 0], ['base', 180]]) part(`s3_stub_${k}`, 'conduit', SEAM, [P(7, deg - 12), P(11.6, deg - 6), P(12.4, deg), P(11.6, deg + 6), P(7, deg + 12)], { ...S3, relief: 'round', detail: [seam([P(7.6, deg), P(11.8, deg)], 0.3), { kind: 'glow', at: P(11, deg), r: 0.6, color: GOLD }] });
pair('s3_stub_flank', 'conduit', SEAM, [P(7, -102), P(11.6, -96), P(12.4, -90), P(11.6, -84), P(7, -78)], { ...S3, relief: 'round', detail: [seam([P(7.6, -90), P(11.8, -90)], 0.3), { kind: 'glow', at: P(11, -90), r: 0.6, color: GOLD }] });
part('s3_core', 'core', SEAM, ringPts([0, 0], 6.2, 18, 0.1), {
  ...S3, ruin: true,
  detail: [
    { kind: 'recess', color: '#2a2418', poly: ringPts([0, 0], 4.9, 16, 0.1) },
    { kind: 'glow', at: [0, 0], r: 2.6, color: GOLD },
    { kind: 'glow', at: [0, 0], r: 1.1, color: HOTG },
    { kind: 'halo', at: [0, 0], r: 4.2, w: 0.14, color: GOLD },
    ...[0, 72, 144, 216, 288].map((d) => vein([P(1.4, d), P(3.4, d + 18), P(4.6, d + 6)], 0.16, GREY)),
  ],
});

// =====================================================================================================================
// Stage 2, the chambers. Worn out, each piece gapes (a wreck) until the Heart bursts them, one a beat
// =====================================================================================================================
const S2 = { stage: 2, ruin: true };
function chamber(c, emit) {
  const { k, deg, half, r1, lip } = c;
  const a0 = deg - half, a1 = deg + half;
  // (its root wall, sunk into the node's ring)
  emit(`ch_${k}_root`, 'armor', STONE, band(7.4, 15.5, a0 + 4, a1 - 4, 6, 0.2), {
    ...S2, relief: 'plate',
    detail: [{ kind: 'raise', color: GRAIN, poly: band(9.2, 14.2, a0 + 9, a1 - 9, 5, 0) }, vein([P(9, deg - 6), P(12, deg + 3), P(14.6, deg - 2)])],
  });
  // (its two side walls, bowed out)
  for (const [s, b0, b1] of [['a', a0, deg + 1], ['b', deg - 1, a1]]) {
    emit(`ch_${k}_wall${s}`, 'armor', STONE, band(14.8, r1, b0, b1, 6, 0.9), {
      ...S2, relief: 'plate',
      detail: [
        { kind: 'raise', color: GRAIN, poly: band(16.4, r1 - 2.2, b0 + 4, b1 - 4, 5, 0.5) },
        vein([P(16, (b0 + b1) / 2 - 5), P(20, (b0 + b1) / 2 + 2), P(r1 - 2, (b0 + b1) / 2 - 3)]),
        ...pit(P(r1 - 4.5, (b0 + b1) / 2), 0.5),
      ],
    });
  }
  // (its valve lip: where it opens, the gold light in it)
  emit(`ch_${k}_valve`, 'generator', SEAM, band(r1 - 3.2, lip, deg - half * 0.55, deg + half * 0.55, 6, 0.4), {
    ...S2, relief: 'ridge',
    detail: [seam([P(r1 - 1.4, deg - half * 0.42), P(r1 - 0.8, deg), P(r1 - 1.4, deg + half * 0.42)], 0.4), { kind: 'glow', at: P(r1, deg), r: 1.8, color: GOLD }, { kind: 'glow', at: P(r1, deg), r: 0.7, color: HOTG }],
  });
}
chamber(CH[0], (n, ...a) => part(n, ...a));
chamber(CH[2], (n, ...a) => part(n, ...a));
// (the flanks: built on the left and mirrored)
{
  const got = [];
  chamber(CH[1], (n, fn, mat, pg, o) => got.push([n, fn, mat, pg, o]));
  for (const [n, fn, mat, pg, o] of got) pair(n, fn, mat, pg, o);
}
// The septum: the chambers' shared wall over the node (worn out, it gapes like the rest)
part('septum', 'armor', STONE, ringPts([0, 0], 9.6, 16, 0.2), {
  ...S2, relief: 'round',
  detail: [{ kind: 'raise', color: GRAIN, poly: ringPts([0, 0], 7.4, 12, 0.2) }, ...[0, 90, 180, 270].map((d) => seam([P(1.2, d), P(8.8, d)], 0.26)), { kind: 'glow', at: [0, 0], r: 1.2, color: GOLD }],
});
// Its arteries: on the diagonals between the chambers, out from the node's ring to under the crust (optional: they feed its pull)
for (const [k, deg] of [[0, -45], [1, -135]]) {
  const len = k === 0 ? 27 : 29;
  const pg = [P(7.2, deg - 9), P(14, deg - 5.5), P(len, deg - 3.6), P(len + 1.6, deg), P(len, deg + 3.6), P(14, deg + 5.5), P(7.2, deg + 9)];
  pair(`artery${k}`, 'conduit', SEAM, pg, {
    stage: 2, relief: 'round',
    detail: [seam([P(8.5, deg), P(16, deg), P(len - 1, deg)], 0.34), ...[12, 18, 24].map((r) => ({ kind: 'ring', at: P(r, deg), r: 1.3, w: 0.24, color: GREY }))],
  });
}

// =====================================================================================================================
// Stage 1, the bed: crust, caps, roots and crown. The caps decide the stage; the rest calves away when shot
// =====================================================================================================================
const S1 = { stage: 1 };
// The caps: one sealed over each chamber's valve (`ruin`: worn out, they crack open and stay, until the bed is shaken off)
function cap(c, emit) {
  const { k, deg, half, r1, lip } = c;
  emit(`cap_${k}`, 'armor', ROCK, band(r1 - 6, lip + 2.6, deg - half * 0.72, deg + half * 0.72, 8, 1.1), {
    ...S1, ruin: true, relief: 'plate',
    detail: [
      { kind: 'raise', color: CRUST, poly: band(r1 - 4.4, lip + 1, deg - half * 0.55, deg + half * 0.55, 6, 0.8) },
      // (the seam down its middle, along the axis: where it parts when it opens)
      seam([P(r1 - 5.6, deg), P(r1 - 1, deg + 1.5), P(lip + 2.2, deg - 1)], 0.3),
      vein([P(r1 - 4, deg - half * 0.5), P(r1 - 1, deg - half * 0.25), P(lip, deg - half * 0.4)]),
      vein([P(r1 - 3, deg + half * 0.45), P(lip - 1, deg + half * 0.2)]),
    ],
  });
}
cap(CH[0], (n, ...a) => part(n, ...a));
cap(CH[2], (n, ...a) => part(n, ...a));
{ const got = []; cap(CH[1], (n, fn, mat, pg, o) => got.push([n, fn, mat, pg, o])); for (const [n, fn, mat, pg, o] of got) pair(n, fn, mat, pg, o); }
// Crust slabs: either side of each cap, and over the diagonals (outer and inner), dark rock in plates
const SLABS = [
  ['apex_s', -30, -12, 14, 33],
  ['flank_n', -122, -104, 14, 30],
  ['flank_s', -76, -58, 14, 30],
  ['base_s', -172, -150, 14, 31],
  ['diag0_in', -60, -30, 12, 21.5],
  ['diag0_out', -58, -32, 21, 30],
  ['diag1_in', -150, -120, 12, 22],
  ['diag1_out', -148, -122, 21.5, 31],
];
for (const [k, a0, a1, r0, r1] of SLABS) {
  const m = (a0 + a1) / 2;
  pair(`crust_${k}`, k.includes('out') ? 'armor' : 'hull', ROCK, band(r0, r1, a0, a1, 5, 1.0), {
    ...S1, relief: 'plate',
    detail: [
      { kind: 'raise', color: CRUST, poly: band(r0 + 1.5, r1 - 1.6, a0 + 3, a1 - 3, 4, 0.7) },
      vein([P(r0 + 1, m - 4), P((r0 + r1) / 2, m + 3), P(r1 - 1, m - 2)]),
      ...(k.includes('out') ? pit(P(r1 - 3, m + 3), 0.45) : []),
    ],
  });
}
// The keystone: the crust's boss over the middle, where the four seams meet
part('crust_key', 'armor', ROCK, Array.from({ length: 16 }, (_, k) => PR(14, k * 22.5, 0.9)), {
  ...S1, relief: 'plate',
  detail: [{ kind: 'raise', color: CRUST, poly: Array.from({ length: 12 }, (_, k) => PR(10.5, k * 30 + 8, 0.7)) }, ...[0, 90, 180, 270].map((d) => seam([P(2, d), P(13.6, d + 3)], 0.24)), ...pit([0, 0], 0.9)],
});
// The crown: glass shards jutting off the apex cap and its slabs
for (const [k, deg, r, len, w] of [[0, -7, 33, 9.5, 2.0], [1, -19, 31, 7.4, 1.7], [2, -31, 29, 6.2, 1.5]]) {
  const b0 = P(r - 1.6, deg - w * 1.6), b1 = P(r - 1.6, deg + w * 1.6), tip = P(r + len, deg - 2.5), kn = P(r + len * 0.55, deg + 1.4);
  pair(`crown${k}`, 'armor', GLASS, [b0, P(r + len * 0.45, deg - w * 1.1), tip, kn, b1], {
    ...S1, relief: 'ridge', detail: [crystal(P(r, deg), [Math.sin((deg - 2) * DEG), -Math.cos((deg - 2) * DEG)], len * 0.9, w * 0.5)],
  });
}
part('crown_mid', 'armor', GLASS, [P(33, -3.5), P(38, -1.8), P(45.5, 0), P(38, 1.8), P(33, 3.5)], { ...S1, relief: 'ridge', detail: [crystal(P(34, 0), [0, -1], 11, 1.2)] });

// The roots: out of the crust's rim, curling, longest behind (the side it lies buried on). Each: a knot at its base
// (the joint: shoot it and the whole root comes away) and three lengths tapering to a point
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
    // (knuckled: thicker at each joint, as rock roots are)
    const t = k / last, w = (w0 + (w1 - w0) * t) * (1 + 0.14 * Math.cos(t * segs * Math.PI * 2)) / 2;
    return [[c[k][0] - uy * w, c[k][1] + ux * w], [c[k][0] + uy * w, c[k][1] - ux * w]];
  };
  return Array.from({ length: segs }, (_, s) => {
    const k0 = Math.max(0, s * per - 1), k1 = Math.min(last, (s + 1) * per + 1), L = [], R = [];
    for (let k = k0; k <= k1; k++) { const [l, r] = sideAt(k); L.push(l); R.push(r); }
    if (k1 === last) { L.pop(); R.pop(); L.push(c[last]); }
    return { poly: [...L, ...R.reverse()].map((q) => q.map(round)), path: c.slice(k0, k1 + 1).map((q) => q.map(round)) };
  });
}
const ROOTS = [
  // [name, base angle, length, curl (degrees it bends by), root width]
  ['r0', -38, 17, 14, 5.2],
  ['r1', -66, 22, -12, 5.8],
  ['r2', -104, 27, 16, 6.4],
  ['r3', -140, 36, -18, 7.0],
  ['r4', -166, 39, 12, 7.2],
];
ROOTS.forEach(([n, deg, len, curl, w], i) => {
  const r0 = 26.5 + (i > 2 ? 2 : 0);
  const pts = [P(r0 - 2, deg), P(r0 + len * 0.3, deg + curl * 0.2), P(r0 + len * 0.62, deg + curl * 0.55), P(r0 + len, deg + curl)];
  // (the knot: a joint of seam glass where it leaves the crust)
  const kc = P(r0, deg);
  pair(`${n}_knot`, 'conduit', SEAM, oval(kc, w * 0.62, w * 0.55, [Math.sin(deg * DEG), -Math.cos(deg * DEG)], 12), {
    ...S1, relief: 'round', detail: [{ kind: 'glow', at: kc, r: w * 0.3, color: GOLD }, { kind: 'ring', at: kc, r: w * 0.42, w: 0.22, color: GREY }],
  });
  tentacle(pts, w * 0.95, 0.6, 3).forEach((sg, s) => {
    const nP = sg.path.length;
    pair(`${n}${'abc'[s]}`, s === 0 ? 'armor' : 'hull', s === 2 ? DARK : ROCK, sg.poly, {
      ...S1, relief: 'round',
      detail: [vein(sg.path.slice(1, nP - 1), 0.2 - s * 0.04), ...(s === 0 ? [crystal(sg.path[Math.floor(nP / 2)], [sg.path[nP - 1][0] - sg.path[0][0], sg.path[nP - 1][1] - sg.path[0][1]], 1.6, 0.5, GREY)] : [])],
    });
  });
});

// ---- The lattice under the crust (look only: client ships/skeletonBuild.ts), bared as the crust calves ----
/** Branching veins: a vein from a to b forks at its end into two, each shorter, the same way at every scale */
function branch(a, deg, len, depth, out, w) {
  const b = [round(a[0] + Math.sin(deg * DEG) * len), round(a[1] - Math.cos(deg * DEG) * len)];
  out.push({ pts: [a, mid(a, b), b], w: [w, w * 0.85, w * 0.7], layer: depth > 1 ? 0 : 1 });
  if (depth > 0) for (const s of [-28, 28]) branch(b, deg + s, len * 0.58, depth - 1, out, w * 0.62);
}
const BONES = [];
for (const deg of [-45, -135]) branch(P(9, deg), deg, 8, 3, BONES, 1.3);
for (const deg of [-18, -72, -108, -162]) branch(P(13, deg), deg, 6.5, 2, BONES, 0.9);
// (two rings round it, the inner carrying its light)
const arcBone = (r, a0, a1, w, lava) => ({ pts: Array.from({ length: 13 }, (_, k) => P(r, a0 + ((a1 - a0) * k) / 12)), w: Array(13).fill(w), layer: 0, ...(lava ? { lava: true } : {}) });
BONES.push(arcBone(16, -178, -2, 1.1, true), arcBone(25, -176, -4, 0.85, false));
const RIM_PTS = [...Array.from({ length: 19 }, (_, k) => P(30.5, -180 + k * 10)), P(8, 0), P(8, -180)];
const SKPARTS = [
  { kind: 'pipe', pts: [P(9, -20), P(16, -30), P(24, -24), P(29, -34)], w: 0.55, glow: true },
  { kind: 'pipe', pts: [P(9, -160), P(16, -150), P(24, -156), P(29, -146)], w: 0.55, glow: true },
  { kind: 'drum', at: P(17, -45), r: 1.4 }, { kind: 'drum', at: P(17, -135), r: 1.4 }, { kind: 'drum', at: P(25, -90), r: 1.2 },
  ...[0, 1, 2].map((k) => ({ kind: 'cable', pts: [P(12, -60 - k * 4), P(20, -88 - k * 3), P(27, -112 + k * 4)], w: 0.14 })),
];
const PALETTE = { bone: '#6f747d', fine: '#3a3d44', part: '#2a2c31', edge: '#50545c', bolt: '#b9bec6', hot: '#ffb43c', hotCore: '#fff0c4' };
const flipPart = (q) => ({ ...q, ...(q.pts ? { pts: q.pts.map(flipX) } : {}), ...(q.poly ? { poly: q.poly.map(flipX) } : {}), ...(q.at ? { at: flipX(q.at) } : {}) });
for (const sd of ['l', 'r']) {
  const m = sd === 'l' ? (q) => q : flipX, mp = sd === 'l' ? (q) => q : flipPart;
  part(`lattice_${sd}`, 'bone_frame', ROCK, (sd === 'l' ? RIM_PTS : [...RIM_PTS].reverse()).map(m), {
    ...S1,
    skeleton: { rim: (sd === 'l' ? RIM_PTS : [...RIM_PTS].reverse()).map(m), rimW: 0.8, bones: BONES.map((b) => ({ ...b, pts: b.pts.map(m) })), parts: SKPARTS.map(mp), palette: PALETTE },
  });
}

// ---- Its bed (render only: the shard rubble it lies half buried in at rest; never part of the boss) ----
const BED = [];
for (let k = 0; k < 34; k++) {
  const deg = -70 - ((k * 53) % 112), r = 16 + ((k * 37) % 38), sz = 4.6 + ((k * 13) % 7) * 0.75;
  BED.push([k, P(r, deg), sz, deg + k * 21]);
}
for (const [k, c, sz, rot] of BED) {
  const n = 5 + (k % 3);
  const pg = Array.from({ length: n }, (_, i) => { const a = rot * DEG + (i / n) * Math.PI * 2, rr = sz * (0.7 + 0.3 * Math.abs(Math.sin(i * 2.3 + k))); return [round(c[0] + Math.cos(a) * rr), round(c[1] + Math.sin(a) * rr * 0.8)]; });
  pair(`bed${k}`, 'hull', k % 4 === 0 ? STONE : ROCK, pg, { relief: 'plate', bed: true, detail: [vein([pg[0], c, pg[Math.floor(n / 2)]], 0.16)] });
}

// ---- Out: scaled by S ----
const sc = (q) => [round(q[0] * S), round(q[1] * S)];
const scaleDetail = (d) => ({ ...d, ...(d.poly ? { poly: d.poly.map(sc) } : {}), ...(d.at ? { at: sc(d.at) } : {}), ...(d.r !== undefined ? { r: round(d.r * S) } : {}), ...(d.w !== undefined ? { w: round(d.w * S) } : {}) });
const scalePart = (q) => ({ ...q, ...(q.pts ? { pts: q.pts.map(sc) } : {}), ...(q.poly ? { poly: q.poly.map(sc) } : {}), ...(q.at ? { at: sc(q.at) } : {}), ...(q.r !== undefined ? { r: round(q.r * S) } : {}), ...(q.w !== undefined ? { w: round(q.w * S) } : {}) });
for (const p of pieces) {
  p.polygon = p.polygon.map(sc);
  if (p.mount) p.mount = { ...p.mount, at: sc(p.mount.at), ...(p.mount.width ? { width: round(p.mount.width * S) } : {}) };
  if (p.detail) p.detail = p.detail.map(scaleDetail);
  if (p.skeleton) {
    const k = p.skeleton;
    p.skeleton = { ...k, rim: k.rim.map(sc), rimW: round(k.rimW * S), bones: k.bones.map((b) => ({ ...b, pts: b.pts.map(sc), w: b.w.map((v) => round(v * S)) })), parts: k.parts.map(scalePart) };
  }
}

// ---- Spent: the node as it is after the end (render only): its light gone out of every seam ----
const SPENT = '#4d4a44';
for (const p of pieces.filter((q) => q.stage === 3)) {
  const detail = (p.detail ?? []).filter((d) => d.kind !== 'glow').map((d) => (d.color ? { ...d, color: d.kind === 'recess' ? d.color : SPENT } : d));
  pieces.push({ ...p, id: `${p.id}_spent`, detail });
}
// ---- Connectivity (a quick geometric check: every part reaches the core through overlapping parts, also with the
// earlier stages gone). The real check is ShipBridge's orphanGroups (doc section 11) ----
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
// (shot about: what stage 1 looks like half way, its crust calved and roots cut, the caps and the lattice still on)
const CRACKED_GONE = /crust_(apex_s|flank_n|diag0_out|diag1_in)_l|crust_(base_s|diag0_in|flank_s)_r|r1[abc]_l|r1_knot_l|r3[bc]_r|r4c_l|crown[02]_r|crown1_l|crown_mid/;
const VARIANTS = {
  maw_heart: design('Heart of the Maw (redesign)', order),
  maw_heart_dormant: design('Heart of the Maw (redesign), at rest in its bed', [...order, ...extra]),
  maw_heart_cracked: design('Heart of the Maw (redesign), stage 1 half shot', order.filter((q) => !CRACKED_GONE.test(q.piece))),
  maw_heart_chambers: design('Heart of the Maw (redesign), stage 2: the chambers', order.filter((q) => stageOfPart(q) >= 2)),
  maw_heart_node: design('Heart of the Maw (redesign), stage 3: the node', order.filter((q) => stageOfPart(q) === 3)),
  maw_heart_spent: design('Heart of the Maw (redesign), spent', order.filter((q) => stageOfPart(q) === 3).map((q) => ({ ...q, piece: `${q.piece}_spent` }))),
};
mkdirSync(OUT, { recursive: true });
const pieceFile = { _comment: 'DESIGN ONLY, not loaded by the game: the redesigned Heart of the Maw (docs/bosses/maw-heart-redesign.md). Written by scripts/bespoke/maw_heart.mjs.', pieces };
writeFileSync(join(OUT, 'maw_heart.pieces.json'), JSON.stringify(pieceFile, null, 1) + '\n');
for (const [id, d] of Object.entries(VARIANTS)) writeFileSync(join(OUT, `${id}.json`), JSON.stringify(d, null, 1) + '\n');

const by = (st) => parts.filter((q) => stageOfPart(q) === st).length;
let R = 0;
for (const q of order) for (const [x, y] of byId.get(q.piece).polygon) R = Math.max(R, Math.hypot(x, y));
console.log(`${parts.length} parts (+${extra.length} bed): stage 1 ${by(1)}, stage 2 ${by(2)}, stage 3 ${by(3)}; radius ${Math.round(R * 24)} world units`);
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
