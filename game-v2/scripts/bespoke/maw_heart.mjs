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
// Stand-in materials (the game's own, so it renders today). The proposed boss materials are in the doc, section 2.
const ROCK = 'dense_ferrite', STONE = 'leestone', METAL = 'leaded_iridium', SEAM = 'pyre_glass', GLASS = 'titanium', TOOTH = 'steel';
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
/** A seam of light down an axis: warm stone either side of it (the seam lighting the rock), then the gold channel */
const seamDetail = (r0, r1, deg, w0, w1) => [
  raise(strip(radial(r0, r1, deg), w0 * 4.2, w1 * 3.2), WARM2),
  raise(strip(radial(r0 + 0.4, r1 - 0.4, deg), w0 * 2.4, w1 * 1.9), WARM1),
  channel(strip(radial(r0, r1, deg), w0, w1)),
  channel(strip(radial(r0 + 0.6, r0 + (r1 - r0) * 0.55, deg), w0 * 0.42, w1 * 0.2), HOT),
];

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

// =====================================================================================================================
// Stage 3, the node: beneath everything (drawn first), bared when its chambers burst
// =====================================================================================================================
const S3 = { stage: 3, under: true };
// Its ring: dark metal, a lit rim, rivets of light round it
part('s3_ring', 'conduit', METAL, ringPts([0, 0], 10.2, 24, 0.13), {
  ...S3,
  detail: [
    raise(ringPts([0, 0], 9.6, 24, 0.13), TOP), raise(ringPts([0, 0], 8.8, 24, 0.13), FACE),
    halo([0, 0], 9.9, 0.25, RIM),
    ...Array.from({ length: 12 }, (_, k) => glow(P(9.2, k * 30 + 15), 0.32, GOLD2)),
  ],
});
// Its valve teeth: fangs on the diagonals, lying over the ring and the core, a gold channel down each to a hot tip
for (const [k, deg] of DIAG) {
  const pg = [P(5, deg - 22), P(10.5, deg - 15), P(16.5, deg - 4), P(17.6, deg), P(16.5, deg + 4), P(10.5, deg + 15), P(5, deg + 22)];
  pair(`s3_valve${k}`, 'generator', TOOTH, pg, {
    ...S3, ruin: true, relief: 'ridge',
    detail: [raise([P(6, deg - 18), P(10.5, deg - 12), P(15.8, deg - 2.5), P(15.8, deg + 2.5), P(10.5, deg + 12), P(6, deg + 18)], FACE), raise([P(7.5, deg - 11), P(14.5, deg - 1.5), P(14.5, deg + 1.5), P(7.5, deg + 11)], TOP), channel(strip(radial(6.5, 16.2, deg), 1.3, 0.4)), channel(strip(radial(7, 15, deg), 0.5, 0.16), HOT), glow(P(16.4, deg), 0.75, GOLD2)],
  });
}
// Its stubs: on the axes, where the arteries met it
onAxes((k, deg, emit) => emit(`s3_stub_${k}`, 'conduit', METAL, [P(8.5, deg - 13), P(13.6, deg - 7), P(14.4, deg), P(13.6, deg + 7), P(8.5, deg + 13)], {
  ...S3, detail: [raise([P(8.8, deg - 11.5), P(13.3, deg - 6), P(13.3, deg + 6), P(8.8, deg + 11.5)], FACE), raise([P(9.5, deg - 9), P(12.8, deg - 4.5), P(12.8, deg + 4.5), P(9.5, deg + 9)], TOP), glow(P(12.2, deg), 0.8), glow(P(12.2, deg), 0.35, HOT)],
}));
// The core, last: seam glass lit from within: a dark iris round it, rings of light, veins out to its rim
part('s3_core', 'core', SEAM, ringPts([0, 0], 7.4, 24, 0.13), {
  ...S3, ruin: true,
  detail: [
    recess(ringPts([0, 0], 6.8, 24, 0.13), '#15110c'),
    ...Array.from({ length: 8 }, (_, k) => vein([P(4.4, k * 45 + 22.5), P(5.4, k * 45 + 28), P(6.5, k * 45 + 24)], 0.3, BRONZE)),
    halo([0, 0], 6.6, 0.3, BRONZE), halo([0, 0], 4.9, 0.22, GOLD),
    glow([0, 0], 4.4, '#4a2a0c'), glow([0, 0], 3.6, '#a8621a'), glow([0, 0], 2.7, GOLD), glow([0, 0], 1.7, GOLD2), glow([0, 0], 0.8, HOT),
  ],
});

// =====================================================================================================================
// Stage 2, the chambers. Worn out, each gapes (a wreck) until the Heart bursts them, one a beat
// =====================================================================================================================
const S2 = { stage: 2, ruin: true };
const CH_HALF = 34, CH_R1 = 28;
onAxes((k, deg, emit) => {
  const r1 = k === 'apex' ? 31 : CH_R1;
  // Its two walls: dark metal, plated, a lit rim along the outer edge and a ridge where they meet
  for (const [s, a0, a1] of [['a', deg - CH_HALF, deg + 0.5], ['b', deg - 0.5, deg + CH_HALF]]) {
    const m = (a0 + a1) / 2, out = s === 'a' ? a0 : a1;
    emit(`ch_${k}_wall${s}`, 'armor', METAL, block(9.5, r1, a0, a1, 1.4, 8), {
      ...S2, relief: 'plate',
      detail: [
        raise(block(11.5, r1 - 2.2, a0 + 3, a1 - 3, 1.2, 6), FACE),
        raise(block(13, r1 - 3.6, a0 + 5, a1 - 5, 1, 6), TOP),
        raise(strip(Array.from({ length: 7 }, (_, j) => P(r1 - 1.1, out + (j / 6) * (m - out) * 1.6)), 0.7), RIM),
        recess(oval(P(r1 - 6, m), 1.0, 0.7, [Math.sin(m * DEG), -Math.cos(m * DEG)], 10)),
        glow(P(r1 - 6, m), 0.4, GOLD2),
      ],
    });
  }
  // Its valve lip: the throat it opens through, deep and dark, light glowing at the bottom of it
  const lip = r1 + 4.2;
  emit(`ch_${k}_valve`, 'generator', SEAM, block(r1 - 6, lip, deg - 16, deg + 16, 1.2, 8), {
    ...S2, relief: 'plate',
    detail: [
      raise(block(r1 - 5, lip - 0.8, deg - 14, deg + 14, 1, 6), '#3a2a20'),
      recess(block(r1 - 4.4, lip - 1.2, deg - 12.5, deg + 12.5, 0.8, 6), '#0e0c0a'),
      { kind: 'vent', color: '#9a5c18', fins: 5, poly: block(r1 - 3.2, lip - 2.2, deg - 9, deg + 9, 0.5, 6) },
      channel(strip(Array.from({ length: 9 }, (_, j) => P(lip - 0.7, deg - 13 + j * 3.25)), 0.55), GOLD2),
    ],
  });
});
// The septum over the middle: the chambers' shared wall, an iris where the core shows through
part('septum', 'armor', STONE, ringPts([0, 0], 11.5, 24, 0.13), {
  ...S2, relief: 'plate',
  detail: [
    raise(ringPts([0, 0], 10, 24, 0.13), FACE), raise(ringPts([0, 0], 8.4, 24, 0.13), TOP),
    ...[0, 90, 180, 270].flatMap((d) => [channel(strip(radial(4.2, 11.2, d), 0.9, 0.5)), channel(strip(radial(4.6, 10.4, d), 0.35, 0.18), HOT)]),
    recess(ringPts([0, 0], 4.2, 16, 0.2), '#0d0c0b'), glow([0, 0], 3.0, '#a06418'), glow([0, 0], 2.0, GOLD), glow([0, 0], 0.9, HOT), halo([0, 0], 4.3, 0.3, BRONZE),
  ],
});
// Its arteries on the diagonals, between the chambers: glass tubes, light running out along them
for (const [k, deg] of DIAG) {
  const pg = [P(9.5, deg - 7.5), P(18, deg - 4.2), P(29, deg - 3), P(31, deg), P(29, deg + 3), P(18, deg + 4.2), P(9.5, deg + 7.5)];
  pair(`artery${k}`, 'conduit', SEAM, pg, {
    stage: 2, relief: 'round',
    detail: [vein(radial(10.5, 29.5, deg, 8), 0.75, GOLD), ...[15, 21, 27].map((r) => halo(P(r, deg), 1.25, 0.32, BRONZE)), glow(P(30, deg), 0.6, GOLD2)],
  });
}

// =====================================================================================================================
// Stage 1, the bed. The caps decide it; the rest calves away when shot (toward the black hole)
// =====================================================================================================================
const S1 = { stage: 1 };
// The buttresses first (the caps lie over them): on the diagonals, inner and outer, stepped rock
for (const [k, deg] of DIAG) {
  const a0 = deg - 26, a1 = deg + 26;
  pair(`crust_diag${k}_in`, 'hull', ROCK, block(12.5, 23.5, a0, a1, 1.6, 8), {
    ...S1, relief: 'plate',
    detail: [raise(block(14.5, 21.8, a0 + 6, a1 - 6, 1.3, 6), FACE), raise(block(16.2, 20.4, a0 + 11, a1 - 11, 1, 4), TOP), recess(oval(P(18.3, deg), 0.9, 0.6, [1, 0], 8)), glow(P(18.3, deg), 0.35, GOLD)],
  });
  pair(`crust_diag${k}_out`, 'armor', ROCK, block(22.5, 32, a0 + 3, a1 - 3, 1.8, 8, 0.4), {
    ...S1, relief: 'plate',
    detail: [raise(block(24.5, 30.2, a0 + 8, a1 - 8, 1.3, 6, 0.3), FACE), raise(block(26, 29, a0 + 13, a1 - 13, 1, 4), TOP), vein([P(24, deg - 10), P(27, deg - 3), P(30.5, deg - 6)], 0.22, BRONZE)],
  });
}
// The caps: one over each chamber, stepped stone, split down its axis by the seam it opens along
onAxes((k, deg, emit) => {
  const r1 = k === 'apex' ? 38 : k === 'base' ? 35 : 34.5, half = 25;
  emit(`cap_${k}`, 'armor', STONE, block(13.5, r1, deg - half, deg + half, 2.2, 10, 0.55), {
    ...S1, ruin: true, relief: 'plate',
    detail: [
      raise(block(15.5, r1 - 2.4, deg - half + 4, deg + half - 4, 1.8, 8), FACE),
      raise(block(17.5, r1 - 4.8, deg - half + 7.5, deg + half - 7.5, 1.4, 8), TOP),
      // (its rim: the lit lip of the plate's outer edge)
      raise(strip(Array.from({ length: 11 }, (_, j) => P(r1 - 1.2, deg - half + 5 + j * ((2 * half - 10) / 10))), 0.8), RIM),
      ...seamDetail(14, r1 - 1.6, deg, 1.5, 0.7),
      glow(P(r1 - 2.4, deg), 0.9, GOLD2), glow(P(r1 - 2.4, deg), 0.4, HOT),
      // (veins forking off the seam, faint: the light reaching into the stone)
      vein([P(19, deg + 1.2), P(22.5, deg + 5), P(25.5, deg + 12), P(27, deg + 17)], 0.34, BRONZE),
      vein([P(24, deg - 1.2), P(27, deg - 6), P(r1 - 4.5, deg - 13)], 0.3, BRONZE),
    ],
  });
});
// The keystone over the middle: stepped rings round the eye, where the four seams meet and the core shows through
part('crust_key', 'armor', STONE, ringPts([0, 0], 15, 24, 0.13), {
  ...S1, relief: 'plate',
  detail: [
    raise(ringPts([0, 0], 13.2, 24, 0.13), FACE), raise(ringPts([0, 0], 11, 24, 0.13), TOP),
    halo([0, 0], 14.3, 0.4, '#666a72'),
    ...[0, 90, 180, 270].flatMap((d) => seamDetail(5.6, 15.2, d, 1.7, 1.4)),
    recess(ringPts([0, 0], 5.4, 20, 0.1), '#0c0b0a'), halo([0, 0], 5.6, 0.45, BRONZE),
    glow([0, 0], 4.3, '#6b3f10'), glow([0, 0], 3.3, '#c47a1c'), glow([0, 0], 2.3, GOLD), glow([0, 0], 1.4, GOLD2), glow([0, 0], 0.6, HOT),
  ],
});
// The crown: three shards of glass on the apex only (the first break in its symmetry)
for (const [n, deg, len, w] of [['crown_mid', 0, 15, 2.6], ['crown_side', -11, 10, 2.0]]) {
  const r = 35.5, base = [P(r - 2.2, deg - w * 2.2), P(r - 2.2, deg + w * 2.2)];
  const pg = [base[0], P(r + len * 0.4, deg - w * 1.3), P(r + len, deg), P(r + len * 0.4, deg + w * 1.3), base[1]];
  const opts = { ...S1, relief: 'ridge', detail: [channel(strip(radial(r - 1, r + len * 0.75, deg, 3), 0.8, 0.2), GOLD2), glow(P(r + len * 0.2, deg), 0.5, HOT)] };
  if (deg === 0) part(n, 'armor', GLASS, pg, opts); else pair(n, 'armor', GLASS, pg, opts);
}
// The roots: four, on the diagonals, curling back to grip the bed. The back pair longer (the second break: the side it
// lies buried on). Each holds through a knot of glowing glass; three lengths taper to a point
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
for (const [k, deg, len, curl] of [[0, -45, 25, -26], [1, -135, 33, -24]]) {
  const r0 = 31, w = 7.2;
  const pts = [P(r0 - 2, deg), P(r0 + len * 0.35, deg + curl * 0.15), P(r0 + len * 0.7, deg + curl * 0.5), P(r0 + len, deg + curl)];
  tentacle(pts, w, 0.8, 3).forEach((sg, s) => {
    const n = sg.path.length, mid = sg.path.slice(1, n - 1);
    pair(`root${k}${'abc'[s]}`, s === 0 ? 'armor' : 'hull', s === 2 ? METAL : ROCK, sg.poly, {
      ...S1, relief: 'round',
      detail: [raise(strip(mid, w * (0.5 - s * 0.14), w * (0.38 - s * 0.12)), s === 0 ? TOP : FACE), vein(mid, 0.28 - s * 0.06, BRONZE)],
    });
  });
  // (the knot, over the root's base: shoot it and the root comes away whole)
  const kc = P(r0, deg);
  pair(`root${k}_knot`, 'conduit', SEAM, oval(kc, 4.6, 4.2, [Math.sin(deg * DEG), -Math.cos(deg * DEG)], 16), {
    ...S1, relief: 'round',
    detail: [recess(oval(kc, 3.4, 3.1, [1, 0], 14), '#16110b'), glow(kc, 2.3, '#a8661a'), glow(kc, 1.5, GOLD), glow(kc, 0.7, HOT), halo(kc, 4.1, 0.4, BRONZE)],
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
for (const p of pieces.filter((q) => q.stage === 3)) {
  const detail = (p.detail ?? []).filter((d) => d.kind !== 'glow' && d.kind !== 'vein').map((d) => (d.color && d.kind !== 'recess' && d.kind !== 'raise' ? { ...d, color: SPENT } : d));
  pieces.push({ ...p, id: `${p.id}_spent`, detail });
}

// ---- Dim: the bed's light down to embers, for its dormant still (render only) ----
const DIMMED = { [GOLD]: '#5a3a12', [GOLD2]: '#6a4616', [HOT]: '#7a5420', [WARM1]: '#4c4234', [WARM2]: '#3f3830' };
for (const p of pieces.filter((q) => q.stage === 1)) pieces.push({ ...p, id: `${p.id}_dim`, detail: p.detail?.filter((d) => !(d.kind === 'glow' && d.r < 2)).map((d) => (DIMMED[d.color] ? { ...d, color: DIMMED[d.color] } : d)) });

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
  maw_heart_spent: design('Heart of the Maw (redesign), spent', order.filter((q) => stageOfPart(q) === 3).map((q) => ({ ...q, piece: `${q.piece}_spent`, ...(q.fn === 'generator' ? { fn: 'armor', material: METAL } : {}) }))),
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
