/**
 * The Scrap Mother's hull (bosses.json boss_scrap_mother): writes its bespoke pieces (data/ships/bespoke/scrap_mother.json)
 * and its design (data/ships/blueprints/enemy/scrap_mother.json). Run: node scripts/bespoke/scrap_mother.mjs [preview.svg]
 *
 * Grid units (a cell is 24 world units), y down, nose towards -y; built as the left half and mirrored, scaled by S on
 * the way out. Every part shares an edge with its neighbours or lies over one (bespoke parts join what they touch).
 *
 * Its look: salvage welded together. Weathered gunmetal, rust and faded plate, mismatched panel to panel, hazard
 * stripes on what moves, rivets along the seams; greyseam's pale green wherever power runs. In three stages:
 *
 *   1 the hoard   its nest wings (slabs of scavenged hull over a scaffold, drone eggs racked in it, turrets), crane arms
 *                 reaching forward with three-fingered claws, grapple booms trailing electromagnets
 *   2 the mill    its body: a grinder maw (two toothed rotors, crusher mandibles), the intake behind, sludge vats,
 *                 exhaust stacks over three drives. Worn out, each piece is left a wreck (`ruin`)
 *   3 the seed    its heart, beneath: a greyseam core in an iris of six petals, a ring of twelve servo housings (those
 *                 wreck, and blow at once when it dies); greyseam spikes, arc welders and drives hung on them
 */

import { writeFileSync, mkdirSync } from 'fs';
import { compactJson } from '../lib/compactJson.mjs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const DEG = Math.PI / 180;
const round = (v) => Math.round(v * 1000) / 1000;
const C = [0, 2];
/** A point `r` out from `c`, `deg` round from straight ahead (positive: to the right) */
const P = (r, deg, c = C) => [round(c[0] + r * Math.sin(deg * DEG)), round(c[1] - r * Math.cos(deg * DEG))];
const mid = (a, b, t = 0.5) => [round(a[0] + (b[0] - a[0]) * t), round(a[1] + (b[1] - a[1]) * t)];
const flipX = ([x, y]) => [round(-x), y];
const mirror = (pts) => pts.map(flipX).reverse();
const norm = ([x, y]) => { const l = Math.hypot(x, y) || 1; return [x / l, y / l]; };
const centroid = (pts) => [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length];
const h = (k) => ((Math.sin(k * 12.9898 + 4.1) * 43758.5453) % 1 + 1) % 1;

/** Drawn at this scale on the way out */
const S = 1.25;
const IRON = 'scrap_iron', RUST = 'scrap_rust', PAINT = 'scrap_paint', STEEL = 'scrap_steel', SEAM = 'scrap_seam';
const HAZARD = '#c9a23a', DARK = '#24262b', SEAMGLOW = '#7affd2';

const pieces = [], parts = [];
let uid = 0;
function part(name, fn, material, polygon, opts = {}) {
  const id = `scrapmother_${name}`;
  pieces.push({
    id, polygon, stage: opts.stage, ...(opts.ruin ? { ruin: true } : {}), ...(opts.under ? { under: true } : {}),
    ...(opts.mount ? { mount: opts.mount } : {}), ...(opts.relief ? { relief: opts.relief } : {}), ...(opts.turretSize ? { turret: opts.turretSize } : {}),
    ...(opts.contact ? { contact: opts.contact } : {}), ...(opts.detail?.length ? { detail: opts.detail } : {}), ...(opts.skeleton ? { skeleton: opts.skeleton } : {}),
  });
  parts.push({ uid: uid++, piece: id, fn, material, x: 0, y: 0, rot: 0, flip: false, ...(opts.turret ? { mount: 'turret' } : {}) });
}
const mirrorDetail = (d) => ({ ...d, ...(d.poly ? { poly: d.kind === 'vein' || d.kind === 'cable' ? d.poly.map(flipX) : mirror(d.poly) } : {}), ...(d.at ? { at: flipX(d.at) } : {}), ...(d.dir ? { dir: flipX(d.dir) } : {}) });
function pair(name, fn, material, polygon, opts = {}) {
  part(`${name}_l`, fn, material, polygon, opts);
  const m = opts.mount && { ...opts.mount, at: flipX(opts.mount.at), dir: flipX(opts.mount.dir) };
  part(`${name}_r`, fn, material, mirror(polygon), { ...opts, mount: m, detail: opts.detail?.map(mirrorDetail) });
}

// ---- Look helpers ----
/** A band `w` wide from a to b, its far end `taper` narrower */
function bar(a, b, w, taper = 1) {
  const [ux, uy] = norm([b[0] - a[0], b[1] - a[1]]), vx = -uy * w / 2, vy = ux * w / 2;
  return [[a[0] - vx, a[1] - vy], [b[0] - vx * taper, b[1] - vy * taper], [b[0] + vx * taper, b[1] + vy * taper], [a[0] + vx, a[1] + vy]].map(([x, y]) => [round(x), round(y)]);
}
const rivet = (at, r = 0.2) => ({ kind: 'ring', at, r, w: r * 0.75, sides: 8, color: '#8a8d92' });
/** Rivets along a→b, `n` of them, `inset` in from the ends */
const rivets = (a, b, n, r = 0.2) => Array.from({ length: n }, (_, k) => rivet(mid(a, b, (k + 0.5) / n), r));
/** Hazard stripes along a band a→b, `w` wide: yellow and black chevrons */
function stripes(a, b, w, n) {
  const out = [];
  for (let k = 0; k < n; k++) {
    const p0 = mid(a, b, k / n), p1 = mid(a, b, (k + 1) / n);
    const [ux, uy] = norm([b[0] - a[0], b[1] - a[1]]), vx = -uy * w / 2, vy = ux * w / 2, sk = 0.35 * (Math.hypot(b[0] - a[0], b[1] - a[1]) / n);
    out.push({ kind: 'raise', color: k % 2 ? DARK : HAZARD, poly: [[p0[0] - vx, p0[1] - vy], [p1[0] - vx, p1[1] - vy], [p1[0] + vx + ux * sk, p1[1] + vy + uy * sk], [p0[0] + vx + ux * sk, p0[1] + vy + uy * sk]].map((q) => q.map(round)) });
  }
  return out;
}
/** A dent or a scrap patch (a recess, rust-coloured) roughly round `at`, `r` across */
const dent = (at, r, seed, color) => ({ kind: 'recess', ...(color ? { color } : {}), poly: Array.from({ length: 6 }, (_, k) => { const a = (k / 6) * Math.PI * 2 + seed, rr = r * (0.7 + 0.5 * h(seed * 9 + k)); return [round(at[0] + Math.cos(a) * rr), round(at[1] + Math.sin(a) * rr)]; }) });
/** A ring of `n` points (a disc, a hex) */
const ringPts = (c, r, n, off = 0) => Array.from({ length: n }, (_, k) => [round(c[0] + Math.cos(off + (k / n) * Math.PI * 2) * r), round(c[1] + Math.sin(off + (k / n) * Math.PI * 2) * r)]);
/** A gear: `teeth` teeth between radii r0 and r1 */
const gear = (c, r0, r1, teeth) => Array.from({ length: teeth * 4 }, (_, k) => {
  const a = (k / (teeth * 4)) * Math.PI * 2, r = k % 4 === 1 || k % 4 === 2 ? r1 : r0;
  return [round(c[0] + Math.cos(a) * r), round(c[1] + Math.sin(a) * r)];
});
/** An arc band between radii r0 and r1, from a0 to a1 degrees round C, its inner edge turned on by `twist` */
const band = (r0, r1, a0, a1, n = 6, twist = 0) => [
  ...Array.from({ length: n + 1 }, (_, k) => P(r1, a0 + ((a1 - a0) * k) / n)),
  ...Array.from({ length: n + 1 }, (_, k) => P(r0, a1 + twist - ((a1 - a0) * k) / n)),
];
/** A turret: a small hexagon sat on the plate under it, aimed `dir`, on a raised, striped hardpoint */
const turret = (c, dir, r = 0.95) => ({
  polygon: ringPts(c, r / S, 6, Math.PI / 6), mount: { at: c, dir, width: (r / S) * 1.6 }, turretSize: 1.4, turret: true,
  detail: [
    { kind: 'raise', poly: ringPts(c, 1.6, 8, Math.PI / 8) },
    { kind: 'ring', at: c, r: 1.25, w: 0.28, color: HAZARD },
    { kind: 'halo', at: c, r: 1.6, w: 0.08, sides: 8 },
  ],
});

// =====================================================================================================================
// Stage 3, the seed: beneath everything (drawn first), bared when its body blows away
// =====================================================================================================================
// (each course overlapping the one inside it a little: they hold to each other, not only to what's over them)
const RC = 4.0, RI = 3.3, RP = 7.8, RO = 10.6;
const S3 = { stage: 3, under: true };
// The iris: six petals, each skewed round (a camera's shutter), a glowing seam down its leading edge
for (let k = 0; k < 6; k++) {
  const a0 = k * 60, a1 = a0 + 60;
  part(`s3_petal${k}`, 'generator', k % 2 ? IRON : STEEL, band(RI, RP, a0, a1, 6, 18), {
    ...S3, ruin: true,
    detail: [
      { kind: 'channel', poly: bar(P(RI + 0.5, a0 + 20), P(RP - 0.5, a0 + 4), 0.32) },
      { kind: 'recess', poly: band(5.6, 7.0, a0 + 22, a1 - 6, 3, 6) },
      rivet(P(RP - 0.55, a1 - 6)), rivet(P(RP - 0.55, a0 + 26)), rivet(P(RI + 0.7, a1 + 6)),
    ],
  });
}
// The ring: twelve servo housings, each a joint and a slot, alternating steel and iron
for (let k = 0; k < 12; k++) {
  const a0 = k * 30 - 15, a1 = a0 + 30, am = a0 + 15;
  part(`s3_servo${k}`, 'armor', k % 2 ? IRON : PAINT, band(RP - 0.35, RO, a0, a1, 4), {
    ...S3, ruin: true,
    detail: [
      { kind: 'raise', poly: band(RP + 0.45, RO - 0.45, a0 + 3, a1 - 3, 3) },
      { kind: 'ring', at: P((RP + RO) / 2, am), r: 0.85, w: 0.3, sides: 10 },
      { kind: 'glow', at: P((RP + RO) / 2, am), r: 0.38, color: SEAMGLOW },
      ...(k % 3 === 0 ? stripes(P(RO - 0.35, a0 + 3), P(RO - 0.35, a1 - 3), 0.45, 4) : [rivet(P(RO - 0.4, a0 + 4)), rivet(P(RO - 0.4, a1 - 4))]),
    ],
  });
}
// Greyseam spikes out of the ring, between its welders (shot off, it's still standing)
for (const [k, a] of [[0, 0], [1, 60], [2, 120], [3, 180], [4, 240], [5, 300]]) {
  if (a === 0 || a === 180) continue;
  const len = 2.6 + 0.8 * h(k);
  part(`s3_spike${k}`, 'generator', SEAM, [P(RO - 0.6, a - 6), P(RO + len, a - 1.5), P(RO + len + 0.8, a + 2), P(RO - 0.6, a + 7)], {
    ...S3, relief: 'ridge',
    detail: [
      { kind: 'shard', crystal: true, color: '#8ff0d8', at: P(RO, a - 1), dir: norm([Math.sin(a * DEG), -Math.cos(a * DEG)]), r: len * 0.9, w: 0.9 },
      { kind: 'shard', crystal: true, color: '#5fcfb4', at: P(RO + 0.2, a + 4), dir: norm([Math.sin((a + 14) * DEG), -Math.cos((a + 14) * DEG)]), r: len * 0.55, w: 0.6 },
    ],
  });
}
// Arc welders forward, either side: a jointed stub, its electrode glowing
{
  const a = -32, b0 = P(RO - 0.8, a), b1 = P(RO + 4.2, a - 6);
  pair('s3_welder', 'arc', STEEL, bar(b0, b1, 2.0, 0.6), {
    ...S3, mount: { at: b1, dir: norm([b1[0] - b0[0], b1[1] - b0[1]]), width: 0.8 },
    detail: [
      { kind: 'ring', at: mid(b0, b1, 0.3), r: 0.8, w: 0.28 },
      ...stripes(mid(b0, b1, 0.45), mid(b0, b1, 0.8), 1.1, 3),
      { kind: 'glow', at: b1, r: 0.6, color: SEAMGLOW },
    ],
  });
}
// Its drives: two, hung aft of the ring
pair('s3_drive', 'plasma_drive', STEEL, [[-4.6, 11.2], [-1.4, 11.2], [-1.6, 15.8], [-4.4, 15.8]], {
  ...S3, relief: 'round', mount: { at: [-3.0, 15.8], dir: [0, 1], width: 2.4 },
  detail: [{ kind: 'bell', at: [-3.0, 15.8], dir: [0, 1], r: 2.4, w: 1.6 }, rivet([-4.1, 11.8]), rivet([-1.9, 11.8])],
});
// The core, last: greyseam grown through a hex bezel
part('s3_core', 'core', SEAM, ringPts(C, RC, 6, Math.PI / 6), {
  ...S3, ruin: true, relief: 'recess',
  detail: [
    { kind: 'ring', at: C, r: RC - 0.3, w: 0.6, sides: 6, color: '#9a9ea4' },
    { kind: 'glow', at: C, r: RC - 0.7, sides: 6, color: SEAMGLOW },
    ...[0, 72, 144, 216, 288].map((d, k) => ({ kind: 'shard', crystal: true, color: k % 2 ? '#7fe8cc' : '#b4fff0', at: P(0.4, d), dir: norm([Math.sin((d + 10) * DEG), -Math.cos((d + 10) * DEG)]), r: 1.9 + 0.5 * h(k + 3), w: 0.75 })),
    { kind: 'halo', at: C, r: RC + 0.2, w: 0.1, sides: 6 },
  ],
});

// =====================================================================================================================
// Stage 2, the mill: its body, over its heart. Worn out, each piece is left a wreck
// =====================================================================================================================
const S2 = { stage: 2, ruin: true };
const W2 = 14.5;
// The spine: the intake, the works, the stacks
part('throat', 'conduit', IRON, [[-4, -14], [4, -14], [4, -7], [-4, -7]], {
  ...S2,
  detail: [
    { kind: 'vent', poly: [[-3.2, -13.2], [-0.4, -13.2], [-0.4, -7.8], [-3.2, -7.8]], fins: 6 },
    { kind: 'vent', poly: [[0.4, -13.2], [3.2, -13.2], [3.2, -7.8], [0.4, -7.8]], fins: 6 },
  ],
});
part('spine', 'generator', IRON, [[-4, -7], [4, -7], [4, 3], [-4, 3]], {
  ...S2,
  detail: [
    { kind: 'raise', poly: [[-3.2, -6.2], [3.2, -6.2], [3.2, 2.2], [-3.2, 2.2]], color: '#5a5e64' },
    { kind: 'ring', at: [0, -2], r: 2.3, w: 0.5, sides: 8 },
    { kind: 'recess', poly: ringPts([0, -2], 1.7, 8, Math.PI / 8) },
    { kind: 'glow', at: [0, -2], r: 0.9, sides: 8, color: SEAMGLOW },
    { kind: 'channel', poly: [[-0.25, 0.4], [0.25, 0.4], [0.25, 2.6], [-0.25, 2.6]] },
    ...rivets([-3.5, -6.6], [3.5, -6.6], 6),
  ],
});
part('works', 'conduit', RUST, [[-4, 3], [4, 3], [4, 12], [-4, 12]], {
  ...S2,
  detail: [
    { kind: 'channel', poly: [[-2.6, 3.6], [-2.1, 3.6], [-2.1, 11.4], [-2.6, 11.4]] },
    { kind: 'channel', poly: [[2.1, 3.6], [2.6, 3.6], [2.6, 11.4], [2.1, 11.4]] },
    { kind: 'raise', poly: [[-1.4, 4.2], [1.4, 4.2], [1.4, 10.8], [-1.4, 10.8]], color: '#3a3d43' },
    ...rivets([-1, 5], [-1, 10], 4), ...rivets([1, 5], [1, 10], 4),
    dent([-3, 9.5], 0.7, 2.2, '#4a2a1c'),
  ],
});
part('stacks', 'heat_vent', IRON, [[-4, 12], [4, 12], [3.4, 18], [-3.4, 18]], {
  ...S2, relief: 'plate',
  detail: [
    { kind: 'ring', at: [-1.7, 14.9], r: 1.35, w: 0.35 }, { kind: 'recess', poly: ringPts([-1.7, 14.9], 1.0, 10) }, { kind: 'glow', at: [-1.7, 14.9], r: 0.6, color: SEAMGLOW },
    { kind: 'ring', at: [1.7, 14.9], r: 1.35, w: 0.35 }, { kind: 'recess', poly: ringPts([1.7, 14.9], 1.0, 10) }, { kind: 'glow', at: [1.7, 14.9], r: 0.6, color: SEAMGLOW },
    ...stripes([-3.2, 17.4], [3.2, 17.4], 0.6, 8),
  ],
});
// Its flanks: four courses of mismatched plate each side
const FL = [
  [[-4, -14], [-12, -15.5], [-W2, -11], [-W2, -4], [-4, -7]],
  [[-4, -7], [-W2, -4], [-W2, 5], [-4, 3]],
  [[-4, 3], [-W2, 5], [-W2, 13], [-4, 12]],
  [[-4, 12], [-W2, 13], [-12.5, 18.5], [-3.4, 18]],
];
const FLMAT = [PAINT, IRON, RUST, IRON];
FL.forEach((pg, k) => {
  const c = centroid(pg);
  pair(`flank${k}`, k === 1 ? 'generator' : 'armor', FLMAT[k], pg, {
    ...S2,
    detail: [
      { kind: 'raise', poly: pg.map((q) => mid(c, q, 0.78)) },
      ...rivets(mid(pg[1], pg[2], 0.08), mid(pg[1], pg[2], 0.92), 4),
      dent(mid(c, pg[2], 0.4), 0.8, k * 1.7, k % 2 ? '#5a3424' : undefined),
      ...(k === 1 ? [{ kind: 'channel', poly: bar([-5, -1], [-13.6, 0.6], 0.36) }, { kind: 'channel', poly: bar([-5, 1.6], [-13.6, 3.6], 0.36) }] : []),
      ...(k === 0 ? stripes([-5.2, -13.6], [-11.6, -14.7], 0.7, 5) : []),
    ],
  });
});
// Sludge vats over its flanks: greyseam slurry glowing through a port
pair('vat', 'generator', STEEL, ringPts([-11, 8.6], 2.6, 14), {
  ...S2, relief: 'round',
  detail: [
    { kind: 'ring', at: [-11, 8.6], r: 2.2, w: 0.35 },
    { kind: 'recess', poly: ringPts([-11, 8.6], 1.5, 12) },
    { kind: 'glow', at: [-11, 8.6], r: 1.25, color: SEAMGLOW },
    ...ringPts([-11, 8.6], 2.35, 8).map((q) => rivet(q, 0.16)),
  ],
});
// A turret either side, on the forward flank
for (const side of ['l', 'r']) {
  const c = side === 'l' ? [-9.6, -9.4] : [9.6, -9.4], t = turret(c, [0, -1]);
  part(`flak_${side}`, 'flak', STEEL, t.polygon, { ...S2, ...t });
}
// The maw: two toothed rotors, a spindle between, crusher mandibles either side
pair('rotor', 'hull', STEEL, gear([-4.3, -17.6], 3.0, 3.75, 12), {
  ...S2, relief: 'round',
  detail: [
    { kind: 'ring', at: [-4.3, -17.6], r: 2.3, w: 0.4 },
    { kind: 'recess', poly: ringPts([-4.3, -17.6], 1.5, 8) },
    { kind: 'ring', at: [-4.3, -17.6], r: 0.7, w: 0.3, sides: 6, color: HAZARD },
    ...[0, 1, 2].map((k) => ({ kind: 'raise', color: '#8c8f94', poly: bar(P(0.9, k * 120, [-4.3, -17.6]), P(2.0, k * 120 + 25, [-4.3, -17.6]), 0.35) })),
  ],
});
part('spindle', 'hull', IRON, [[-1.3, -14], [1.3, -14], [1.1, -22.5], [-1.1, -22.5]], {
  ...S2, relief: 'plate', detail: [...stripes([0, -15], [0, -22], 1.6, 6), { kind: 'ring', at: [0, -22.4], r: 0.9, w: 0.3 }],
});
{
  const jaw = [[-7.6, -14.6], [-12.6, -15.6], [-13.8, -21], [-11.4, -27.6], [-9.2, -26.8], [-8.6, -21.4]];
  const teeth = [];
  for (let k = 0; k < 4; k++) { const a = mid([-9.0, -26.2], [-8.0, -16.0], k / 4), b = mid([-9.0, -26.2], [-8.0, -16.0], (k + 0.7) / 4); teeth.push({ kind: 'raise', color: '#a6a9ae', poly: [a, [round((a[0] + b[0]) / 2 + 1.0), round((a[1] + b[1]) / 2)], b] }); }
  pair('jaw', 'armor', RUST, jaw, {
    ...S2, relief: 'plate',
    detail: [...teeth, ...stripes([-12.6, -16.6], [-11.6, -25.6], 0.9, 6), rivet([-10.6, -15.4], 0.26), dent([-11.6, -20.6], 0.8, 3.3, '#4a2a1c')],
  });
}
// Its drives: three, aft
part('drive_c', 'plasma_drive', STEEL, [[-1.9, 17.8], [1.9, 17.8], [2.3, 23.2], [-2.3, 23.2]], {
  ...S2, relief: 'round', mount: { at: [0, 23.2], dir: [0, 1], width: 3.4 },
  detail: [{ kind: 'bell', at: [0, 23.2], dir: [0, 1], r: 3.2, w: 2.2 }],
});
pair('drive', 'plasma_drive', IRON, [[-9.2, 17.4], [-5.2, 17.8], [-5.6, 22.6], [-8.8, 22.6]], {
  ...S2, relief: 'round', mount: { at: [-7.2, 22.6], dir: [0, 1], width: 2.8 },
  detail: [{ kind: 'bell', at: [-7.2, 22.6], dir: [0, 1], r: 2.8, w: 1.8 }, ...stripes([-9, 18.2], [-5.4, 18.4], 0.6, 4)],
});

// =====================================================================================================================
// Stage 1, the hoard: its nest wings, crane arms and grapple booms. Every slab shot off bares the scaffold beneath
// =====================================================================================================================
const S1 = { stage: 1 };
const A = [[-14, -11], [-14, -3.5], [-14, 4.5], [-14, 11.5], [-14, 17]];
const B = [[-20.5, -15.5], [-21.8, -6], [-20.6, 3], [-21.6, 11], [-19.2, 19.6]];
const Cc = [[-27.8, -13.6], [-28.6, -4.2], [-27.6, 4.6], [-28.8, 12.2], [-25.4, 18.4]];
const D = [[-32.2, -7.2], [-33.6, 3.2], [-31.8, 12.8]];
const SLABS = [
  [A[0], B[0], B[1], A[1]], [A[1], B[1], B[2], A[2]], [A[2], B[2], B[3], A[3]], [A[3], B[3], B[4], A[4]],
  [B[0], Cc[0], Cc[1], B[1]], [B[1], Cc[1], Cc[2], B[2]], [B[2], Cc[2], Cc[3], B[3]], [B[3], Cc[3], Cc[4], B[4]],
  [Cc[0], D[0], Cc[1]], [Cc[1], D[0], D[1], Cc[2]], [Cc[2], D[1], D[2], Cc[3]], [Cc[3], D[2], Cc[4]],
];
const SLABMAT = [IRON, RUST, PAINT, IRON, PAINT, IRON, RUST, PAINT, RUST, IRON, PAINT, RUST];
SLABS.forEach((pg, k) => {
  const c = centroid(pg);
  const edges = pg.map((q, i) => [q, pg[(i + 1) % pg.length]]);
  pair(`slab${k}`, k === 1 || k === 5 ? 'conduit' : 'armor', SLABMAT[k], pg, {
    ...S1,
    detail: [
      // (a welded seam round it: rivets along two of its edges; a dent or a patch; a weld bead across some)
      ...rivets(mid(edges[0][0], edges[0][1], 0.1), mid(edges[0][0], edges[0][1], 0.9), 4),
      ...(pg.length > 3 ? rivets(mid(edges[2][0], edges[2][1], 0.1), mid(edges[2][0], edges[2][1], 0.9), 4) : []),
      dent(mid(c, pg[k % pg.length], 0.35), 0.9 + 0.5 * h(k), k * 2.1, SLABMAT[k] === RUST ? '#4a2a1c' : undefined),
      ...(k % 3 === 1 ? [{ kind: 'raise', poly: pg.map((q) => mid(c, q, 0.55)), color: k % 2 ? '#3c4046' : '#62533f' }] : []),
      ...(k === 1 || k === 5 ? [{ kind: 'channel', poly: bar(mid(pg[0], pg[3], 0.5), mid(pg[1], pg[2], 0.5), 0.34) }] : []),
    ],
  });
});
// Patches welded over its seams, one striped
const patch = (c, w, hgt, deg) => { const a = deg * DEG, ux = Math.cos(a), uy = Math.sin(a); return [[-w, -hgt], [w, -hgt], [w, hgt], [-w, hgt]].map(([x, y]) => [round(c[0] + x * ux - y * uy), round(c[1] + x * uy + y * ux)]); };
pair('patch0', 'armor', STEEL, patch([-21.4, -9.2], 2.2, 1.6, 14), { ...S1, relief: 'plate', detail: [...patch([-21.4, -9.2], 1.8, 1.25, 14).map((q) => rivet(q, 0.18))] });
pair('patch1', 'armor', PAINT, patch([-28.2, 7.8], 2.0, 2.4, -9), { ...S1, relief: 'plate', detail: stripes(mid(...patch([-28.2, 7.8], 2.0, 2.4, -9).slice(0, 2), 0), mid(...patch([-28.2, 7.8], 2.0, 2.4, -9).slice(2, 4), 1), 1.0, 5) });
// Brood racks: drone eggs in rows, each glowing through its shell
const rack = (name, c, w, hgt, rows, cols) => {
  const pg = patch(c, w, hgt, 0), eggs = [];
  for (let r = 0; r < rows; r++) for (let q = 0; q < cols; q++) {
    const at = [round(c[0] - w + (2 * w * (q + 0.5)) / cols), round(c[1] - hgt + (2 * hgt * (r + 0.5)) / rows)];
    eggs.push({ kind: 'ring', at, r: 0.62, w: 0.22, sides: 10, color: '#7c8086' }, { kind: 'glow', at, r: 0.44, color: SEAMGLOW });
  }
  pair(name, 'brood_bay', IRON, pg, { ...S1, relief: 'plate', mount: { at: [c[0] - w, c[1]], dir: [-1, 0], width: hgt * 1.6 }, detail: [{ kind: 'recess', poly: patch(c, w - 0.3, hgt - 0.3, 0) }, ...eggs] });
};
rack('rack0', [-24.4, -0.4], 2.9, 1.9, 2, 4);
rack('rack1', [-23.6, 14.2], 2.4, 1.6, 2, 3);
// Turrets out on its wings
for (const [k, c, dir] of [[0, [-25.2, -10.2], norm([-0.4, -1])], [1, [-30.2, 2.2], [-1, 0]], [2, [-18.0, 7.6], norm([-1, 0.3])]]) {
  const t = turret(c, dir);
  pair(`gun${k}`, 'autocannon', STEEL, t.polygon, { ...S1, ...t });
}
// Crane arms forward: a shoulder on its body's corner, a boom, an elbow, a forearm, a wrist, three fingers
const hexAt = (c, r) => ringPts(c, r, 6, Math.PI / 6);
pair('shoulder', 'hull', STEEL, hexAt([-12.8, -14.6], 2.0), { ...S1, relief: 'round', detail: [{ kind: 'ring', at: [-12.8, -14.6], r: 1.4, w: 0.4 }, { kind: 'ring', at: [-12.8, -14.6], r: 0.55, w: 0.3, sides: 6, color: HAZARD }] });
pair('boom', 'hull', IRON, bar([-13.6, -16.2], [-21.4, -25.4], 2.4, 0.82), {
  ...S1, relief: 'plate',
  detail: [...stripes([-14.8, -17.6], [-17.4, -20.6], 1.6, 4), { kind: 'raise', color: '#9a9da2', poly: bar([-15.2, -15.6], [-20.2, -23.6], 0.45) }, rivet([-19.6, -23.6]), rivet([-18.4, -22.0])],
});
pair('elbow', 'hull', STEEL, hexAt([-21.8, -26], 1.7), { ...S1, relief: 'round', detail: [{ kind: 'ring', at: [-21.8, -26], r: 1.1, w: 0.35 }] });
pair('forearm', 'hull', RUST, bar([-21.4, -26.8], [-16.6, -33.4], 2.0, 0.85), { ...S1, relief: 'plate', detail: [...stripes([-20.6, -28.0], [-18.4, -31.0], 1.3, 3), dent([-19.2, -29.6], 0.5, 1.1, '#4a2a1c')] });
pair('wrist', 'hull', STEEL, hexAt([-15.6, -34.6], 2.0), { ...S1, relief: 'round', detail: [{ kind: 'ring', at: [-15.6, -34.6], r: 1.1, w: 0.35, color: HAZARD }] });
pair('claw0', 'armor', STEEL, [[-16.9, -35.3], [-19.7, -38.5], [-18.4, -41.4], [-17.3, -38.5], [-15.7, -35.9]], { ...S1, relief: 'ridge' });
pair('claw1', 'armor', STEEL, [[-15.3, -35.6], [-14.3, -39.9], [-12.4, -41.5], [-13.4, -38.4], [-14.4, -35.0]], { ...S1, relief: 'ridge' });
pair('claw2', 'armor', STEEL, [[-14.8, -33.9], [-11.3, -35.4], [-9.7, -33.6], [-12.4, -33.3], [-14.7, -33.0]], { ...S1, relief: 'ridge' });
// Grapple booms aft: a hinge, a boom, an electromagnet
pair('hinge', 'hull', STEEL, hexAt([-13.0, 15.8], 1.6), { ...S1, relief: 'round', detail: [{ kind: 'ring', at: [-13.0, 15.8], r: 1.0, w: 0.3 }] });
pair('tow', 'hull', IRON, bar([-13.5, 16.6], [-23.4, 24.4], 1.8, 0.85), { ...S1, relief: 'plate', detail: [...stripes([-15.2, 18.0], [-21.4, 22.8], 1.1, 6)] });
pair('magnet', 'conduit', STEEL, ringPts([-25.2, 26.2], 3.0, 16), {
  ...S1, relief: 'round',
  detail: [
    { kind: 'ring', at: [-25.2, 26.2], r: 2.5, w: 0.5, color: '#6e7277' },
    { kind: 'ring', at: [-25.2, 26.2], r: 1.7, w: 0.35, color: '#b0702a' },
    { kind: 'recess', poly: ringPts([-25.2, 26.2], 1.2, 12) },
    { kind: 'glow', at: [-25.2, 26.2], r: 0.9, color: SEAMGLOW },
    { kind: 'halo', at: [-25.2, 26.2], r: 3.1, w: 0.08 },
  ],
});

// ---- Its scaffold: one to each wing, under its slabs (drawn as lit geometry: client ships/skeletonBuild.ts) ----
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
const wingPolys = SLABS;
const WING = unionOutline(wingPolys, -0.25, -13.9);
const RIM_W = 0.85, RIM = unionOutline(wingPolys, 0.18 + RIM_W / 2, -14.1);
const BONES = [
  { pts: [[-14.1, -9], [-21, -12.6], [-27.8, -11.2], [-31.0, -6.8]], w: [1.6, 1.3, 1.1, 0.9], layer: 0 },
  { pts: [[-14.1, 0.5], [-21.2, -1.2], [-28.4, 0.2], [-32.8, 2.8]], w: [1.7, 1.4, 1.1, 0.9], layer: 0, lava: true },
  { pts: [[-14.1, 9.5], [-21.0, 8.0], [-28.2, 9.4], [-31.0, 12.0]], w: [1.6, 1.3, 1.1, 0.9], layer: 0 },
  { pts: [[-14.1, 15.5], [-19.4, 18.4], [-25.0, 17.6]], w: [1.4, 1.1, 0.9], layer: 0 },
  { pts: [[-21, -12.6], [-21.2, -1.2], [-21.0, 8.0], [-19.4, 18.4]], w: [1.2, 1.2, 1.2, 1.0], layer: 0 },
  { pts: [[-27.8, -11.2], [-28.4, 0.2], [-28.2, 9.4], [-25.0, 17.6]], w: [1.0, 1.0, 1.0, 0.9], layer: 0 },
];
// (cross-braced: an X in every bay of the scaffold, beneath)
const NODES = [[[-14.4, -9], [-21, -12.6], [-27.8, -11.2]], [[-14.4, 0.5], [-21.2, -1.2], [-28.4, 0.2]], [[-14.4, 9.5], [-21.0, 8.0], [-28.2, 9.4]], [[-14.4, 15.5], [-19.4, 18.4], [-25.0, 17.6]]];
const FINE = [];
for (let r = 0; r < 3; r++) for (let c = 0; c < 2; c++) {
  const a = NODES[r][c], b = NODES[r][c + 1], cc = NODES[r + 1][c], d = NODES[r + 1][c + 1];
  FINE.push({ pts: [a, d], w: [0.55], layer: 1 }, { pts: [b, cc], w: [0.55], layer: 1 });
}
const SKPARTS = [
  { kind: 'rack', poly: [[-22.6, -9.2], [-27.2, -9.2], [-27.2, -6.6], [-22.6, -6.6]], pods: [0, 1].flatMap((r) => [0, 1, 2, 3].map((q) => [round(-23.2 - q * 1.15), round(-8.5 + r * 1.2)])), r: 0.5 },
  { kind: 'rack', poly: [[-22.2, 3.4], [-26.8, 3.4], [-26.8, 6.6], [-22.2, 6.6]], pods: [0, 1].flatMap((r) => [0, 1, 2, 3].map((q) => [round(-22.8 - q * 1.15), round(4.2 + r * 1.4)])), r: 0.55 },
  { kind: 'drum', at: [-17.6, -4.8], r: 1.9 },
  { kind: 'drum', at: [-17.4, 13.0], r: 1.6 },
  { kind: 'pipe', pts: [[-14.2, -2.6], [-18.6, -3.0], [-24.6, -3.6], [-30.4, -2.4]], w: 0.6, glow: true },
  { kind: 'pipe', pts: [[-14.2, 6.0], [-19.0, 5.2], [-23.0, 10.6], [-27.0, 14.6]], w: 0.55, glow: true },
  { kind: 'coil', a: [-29.4, 5.6], b: [-30.4, 10.4], amp: 0.5, turns: 7 },
  { kind: 'fins', poly: [[-15.6, -12.2], [-19.4, -14.0], [-19.8, -11.4], [-16.0, -10.0]], n: 6 },
  ...[0, 1, 2].flatMap((k) => [
    { kind: 'cable', pts: [[-14.2, 2.2 + k * 0.35], [-18.0, 2.6 + k * 0.35], [-22.0, 1.4 + k * 0.3], [-26.4, 2.0 + k * 0.25]].map((q) => q.map(round)), w: 0.13 },
    { kind: 'cable', pts: [[-14.2, 11.6 + k * 0.35], [-18.6, 10.8 + k * 0.3], [-22.6, 12.4 + k * 0.25]].map((q) => q.map(round)), w: 0.13 },
  ]),
];
const PALETTE = { bone: '#5c5f63', fine: '#2c2e31', part: '#34363a', edge: '#4c4f54', bolt: '#8a8d92', hot: '#59e8b8', hotCore: '#d8fff0' };
const flipPart = (q) => ({ ...q, ...(q.pts ? { pts: q.pts.map(flipX) } : {}), ...(q.poly ? { poly: q.poly.map(flipX) } : {}), ...(q.pods ? { pods: q.pods.map(flipX) } : {}), ...(q.at ? { at: flipX(q.at) } : {}), ...(q.a ? { a: flipX(q.a), b: flipX(q.b) } : {}) });
for (const side of ['l', 'r']) {
  const m = side === 'l' ? (q) => q : flipX, mp = side === 'l' ? (q) => q : flipPart;
  part(`scaffold_${side}`, 'bone_frame', IRON, (side === 'l' ? WING : [...WING].reverse()).map(m), {
    ...S1,
    skeleton: {
      rim: (side === 'l' ? RIM : [...RIM].reverse()).map(m), rimW: RIM_W,
      bones: [...BONES, ...FINE].map((b) => ({ ...b, pts: b.pts.map(m) })),
      parts: SKPARTS.map(mp), palette: PALETTE,
    },
  });
}

// ---- Out: scaled by S (turrets keep their size) ----
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

const pieceFile = { _comment: 'The Scrap Mother\'s own hull (bosses.json boss_scrap_mother). Written by scripts/bespoke/scrap_mother.mjs: edit that, not this.', pieces };
// (its heart first: drawn under everything; rigid: it flies as built throughout, its hull drawn once)
const order = [...parts.filter((q) => q.piece.includes('_s3_')), ...parts.filter((q) => !q.piece.includes('_s3_'))].map((q, k) => ({ ...q, uid: k }));
const design = { name: 'Scrap Mother', catalogVersion: 1, paint: '#3a3c40', rigid: true, parts: order };
mkdirSync(join(root, 'data/ships/bespoke'), { recursive: true });
writeFileSync(join(root, 'data/ships/bespoke/scrap_mother.json'), compactJson(pieceFile));
writeFileSync(join(root, 'data/ships/blueprints/enemy/scrap_mother.json'), JSON.stringify(design, null, 1) + '\n');
const by = (st) => pieces.filter((p) => p.stage === st).length;
console.log(`${pieces.length} pieces: stage 1 ${by(1)}, stage 2 ${by(2)}, stage 3 ${by(3)}`);

const out = process.argv[2];
if (out) {
  const colors = { 1: '#7a6a4a', 2: '#4a6a7a', 3: '#6fe0c4' };
  const s = 12;
  const paths = pieces.map((p) => `<polygon points="${p.polygon.map(([x, y]) => `${x * s},${y * s}`).join(' ')}" fill="${p.skeleton ? 'none' : colors[p.stage]}" stroke="#111" stroke-width="1"/>`);
  writeFileSync(out, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-50 * s} ${-56 * s} ${100 * s} ${96 * s}" style="background:#0b0f16">${paths.join('')}</svg>`);
}
