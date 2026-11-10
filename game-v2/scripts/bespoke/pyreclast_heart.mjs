/**
 * The Pyreclast's heart (its third stage, after its central body burns away): writes its bespoke pieces
 * (data/ships/bespoke/pyreclast_heart.json) and its design (data/ships/blueprints/enemy/pyreclast_heart.json).
 * Run: node scripts/bespoke/pyreclast_heart.mjs (before pyreclast.mjs: the Pyreclast's own design carries these parts,
 * beneath its body, revealed as the body breaks away; this design alone is a dev view of it)
 *
 * True size (cells, y down, nose towards -y), a fifth narrower than the central body. Polished steel throughout
 * (pyre_steel), round about the core: the core open and white-hot; an inner ring of eight plates with molten seams;
 * an outer ring of sixteen; vent housings either side and an aft vent where the body's vents were; its spire cut
 * to a lancet frame holding a crystal; its horn arms to stubs; its drives (the body's, a fifth smaller) hung below
 * on struts and hoses.
 *
 * Its round (the core and both rings) is what it's beaten by: those pieces are wrecked, not shot off (`ruin`), and
 * go all at once when it dies. What's hung on the round (frame, crystal, lamps, vents, stubs, drives, struts, hoses)
 * can be shot off.
 */

import { readFileSync, writeFileSync } from 'fs';
import { compactJson } from '../lib/compactJson.mjs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const DEG = Math.PI / 180;
const round = (v) => Math.round(v * 1000) / 1000;
const C = [0, 4.2];
/** A point `r` out from the middle, `deg` round from straight ahead (positive: to the right) */
const P = (r, deg, c = C) => [round(c[0] + r * Math.sin(deg * DEG)), round(c[1] - r * Math.cos(deg * DEG))];
const mid = (a, b, t = 0.5) => [round(a[0] + (b[0] - a[0]) * t), round(a[1] + (b[1] - a[1]) * t)];
const flipX = ([x, y]) => [round(-x), y];
const mirror = (pts) => pts.map(flipX).reverse();
const norm = ([x, y]) => { const l = Math.hypot(x, y) || 1; return [x / l, y / l]; };
/** An arc band between radii r0 and r1, from a0 to a1 degrees */
const band = (r0, r1, a0, a1, n = 6) => [...Array.from({ length: n + 1 }, (_, k) => P(r1, a0 + ((a1 - a0) * k) / n)), ...Array.from({ length: n + 1 }, (_, k) => P(r0, a1 - ((a1 - a0) * k) / n))];
/** A strip `w` wide from a to b, its far end `taper` narrower */
function bar(a, b, w, taper = 1) {
  const [ux, uy] = norm([b[0] - a[0], b[1] - a[1]]), vx = (-uy * w) / 2, vy = (ux * w) / 2;
  return [[a[0] - vx, a[1] - vy], [b[0] - vx * taper, b[1] - vy * taper], [b[0] + vx * taper, b[1] + vy * taper], [a[0] + vx, a[1] + vy]].map(([x, y]) => [round(x), round(y)]);
}
/** A hose: a strip `w` wide along a sagging curve from a to b (sag: how far it bows, to its right) */
function hose(a, b, w, sag, n = 10) {
  const [ux, uy] = norm([b[0] - a[0], b[1] - a[1]]), len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const line = Array.from({ length: n + 1 }, (_, k) => { const t = k / n, s = Math.sin(Math.PI * t) * sag; return [a[0] + (b[0] - a[0]) * t - uy * s, a[1] + (b[1] - a[1]) * t + ux * s]; });
  const L = [], R = [];
  line.forEach((p, k) => {
    const q = line[Math.min(n, k + 1)], o = line[Math.max(0, k - 1)], [tx, ty] = norm([q[0] - o[0], q[1] - o[1]]);
    L.push([round(p[0] - ty * w / 2), round(p[1] + tx * w / 2)]); R.push([round(p[0] + ty * w / 2), round(p[1] - tx * w / 2)]);
  });
  void len;
  return [...L, ...R.reverse()];
}
const rivet = (at, r = 0.24) => ({ kind: 'ring', at, r, w: r * 0.7, sides: 8 });

const pieces = [], parts = [];
let uid = 0;
const STEEL = 'pyre_steel', GLASS = 'pyre_glass', CRYSTAL = 'pyre_crystal';
function part(name, fn, material, polygon, opts = {}) {
  const id = `pyreclast_s3_${name}`;
  pieces.push({ id, polygon, under: true, stage: 3, ...(opts.ruin ? { ruin: true } : {}), ...(opts.mount ? { mount: opts.mount } : {}), ...(opts.contact ? { contact: opts.contact } : {}), ...(opts.relief ? { relief: opts.relief } : {}), ...(opts.detail?.length ? { detail: opts.detail } : {}) });
  parts.push({ uid: uid++, piece: id, fn, material, x: 0, y: 0, rot: 0, flip: false });
}
const mirrorDetail = (d) => ({ ...d, ...(d.poly ? { poly: mirror(d.poly) } : {}), ...(d.at ? { at: flipX(d.at) } : {}), ...(d.dir ? { dir: flipX(d.dir) } : {}) });
function pair(name, fn, material, polygon, opts = {}) {
  part(`${name}_l`, fn, material, polygon, opts);
  const m = opts.mount && { ...opts.mount, at: flipX(opts.mount.at), dir: flipX(opts.mount.dir) };
  part(`${name}_r`, fn, material, mirror(polygon), { ...opts, mount: m, detail: opts.detail?.map(mirrorDetail) });
}

const RC = 4.6, R1 = 5.3, R2 = 9.3, R3 = 13.0;

// ---- The inner ring: eight plates, a molten seam down the leading edge of each, a sunk panel and bolts in each ----
for (let k = 0; k < 8; k++) {
  const a0 = k * 45 - 22.5, a1 = a0 + 45;
  part(`inner${k}`, 'generator', STEEL, band(R1, R2, a0, a1, 6), {
    ruin: true,
    detail: [
      { kind: 'channel', poly: [P(R1 + 0.35, a0 + 1.6), P(R2 - 0.35, a0 + 0.9), P(R2 - 0.35, a0 + 3.4), P(R1 + 0.35, a0 + 5.6)] },
      { kind: 'recess', poly: band(6.6, 8.3, a0 + 11, a1 - 6, 4) },
      { kind: 'raise', poly: band(6.9, 8.0, a0 + 15, a1 - 10, 3) },
      rivet(P(R2 - 0.6, a1 - 4)), rivet(P(R1 + 0.6, a1 - 7)), rivet(P(R2 - 0.6, a0 + 9)),
    ],
  });
}
// ---- The outer ring: sixteen heavy segments, each a raised plate with a bolt at either end ----
for (let k = 0; k < 16; k++) {
  const a0 = k * 22.5 - 11.25, a1 = a0 + 22.5;
  part(`outer${k}`, 'armor', STEEL, band(R2, R3, a0, a1, 4), {
    ruin: true,
    detail: [
      { kind: 'raise', poly: band(R2 + 0.6, R3 - 0.7, a0 + 2.4, a1 - 2.4, 3) },
      rivet(P(R3 - 0.45, a0 + 2.2)), rivet(P(R3 - 0.45, a1 - 2.2)),
      ...(k % 2 ? [{ kind: 'recess', poly: band(R2 + 1.2, R3 - 1.4, a0 + 6, a1 - 6, 2) }] : []),
    ],
  });
}

// ---- Either side, where the body's vents were: a housing laid over the ring, two banks of louvres, a feed ----
pair('vent_housing', 'heat_vent', STEEL, [[-10.9, -2.6], [-15.4, -1.5], [-16.3, 1.4], [-16.3, 7.0], [-15.4, 9.9], [-10.9, 11.0], [-11.8, 4.2]], {
  relief: 'plate',
  detail: [
    { kind: 'vent', poly: [[-12.6, -0.7], [-15.1, -0.1], [-15.3, 3.4], [-12.6, 3.4]], fins: 5 },
    { kind: 'vent', poly: [[-12.6, 5.0], [-15.3, 5.0], [-15.1, 8.5], [-12.6, 9.1]], fins: 5 },
    { kind: 'channel', poly: [[-11.6, 3.85], [-15.9, 3.85], [-15.9, 4.55], [-11.6, 4.55]] },
    rivet([-11.6, -1.6]), rivet([-15.6, 0.4]), rivet([-15.6, 8.0]), rivet([-11.6, 10.0]),
  ],
});
// ---- Aft, where its mortars and vents were: a vent block under the ring, a molten channel across it ----
part('aft_vent', 'heat_vent', STEEL, [[-5.6, 13.6], [5.6, 13.6], [6.6, 16.0], [4.4, 18.4], [-4.4, 18.4], [-6.6, 16.0]], {
  relief: 'plate',
  detail: [
    { kind: 'vent', poly: [[-4.6, 14.4], [-0.5, 14.4], [-0.5, 17.4], [-3.8, 17.4]], fins: 4 },
    { kind: 'vent', poly: [[0.5, 14.4], [4.6, 14.4], [3.8, 17.4], [0.5, 17.4]], fins: 4 },
    rivet([-5.4, 15.2]), rivet([5.4, 15.2]),
  ],
});

// ---- Its spire, cut to a lancet frame on the ring, a crystal held in it on four clamps, a molten stem feeding it ----
const O = [[0, -27.4], [4.7, -18.4], [4.4, -9.6], [-4.4, -9.6], [-4.7, -18.4]];
const I = [[0, -25.0], [3.3, -18.3], [3.1, -11.0], [-3.1, -11.0], [-3.3, -18.3]];
part('frame_l', 'hull', STEEL, [O[0], O[4], O[3], I[3], I[4], I[0]], { detail: [rivet(mid(O[4], I[4])), rivet(mid(mid(O[0], O[4]), mid(I[0], I[4]), 0.5))] });
part('frame_r', 'hull', STEEL, [O[0], I[0], I[1], I[2], O[2], O[1]], { detail: [rivet(mid(O[1], I[1])), rivet(mid(mid(O[0], O[1]), mid(I[0], I[1]), 0.5))] });
part('frame_base', 'hull', STEEL, [[-5.4, -11.0], [5.4, -11.0], [5.0, -8.0], [-5.0, -8.0]], {
  relief: 'plate', detail: [rivet([-4.4, -9.5]), rivet([4.4, -9.5]), { kind: 'raise', poly: [[-3.4, -10.4], [3.4, -10.4], [3.2, -8.8], [-3.2, -8.8]] }],
});
const K = [[0, -25.0], [2.2, -20.4], [0, -16.0], [-2.2, -20.7]];
part('mineral', 'generator', CRYSTAL, K, {
  relief: 'ridge',
  detail: [
    { kind: 'shard', crystal: true, at: [0.25, -18.0], dir: [0.12, -0.99], r: 3.8, w: 1.3 },
    { kind: 'shard', crystal: true, at: [-0.8, -18.6], dir: [-0.5, -0.86], r: 2.2, w: 0.8 },
    { kind: 'shard', crystal: true, at: [0.9, -18.4], dir: [0.6, -0.8], r: 1.8, w: 0.65 },
    { kind: 'glow', at: [0, -20.4], r: 0.8 },
  ],
});
// (the clamps: from its top and sides to the frame)
part('clamp_top', 'hull', STEEL, bar([0, -25.9], [0, -24.4], 0.9, 0.7));
part('clamp_l', 'hull', STEEL, bar([-4.2, -19.6], [-1.8, -20.5], 0.8, 0.7), { detail: [rivet([-3.8, -19.7], 0.3)] });
part('clamp_r', 'hull', STEEL, bar([4.2, -19.6], [1.8, -20.2], 0.8, 0.7), { detail: [rivet([3.8, -19.7], 0.3)] });
// Under the stone: an array of lamps shining up into it, on a rack across the frame, a loom of cables plugged into it
{
  const lamps = [-2.4, -1.2, 0, 1.2, 2.4], top = -14.3;
  const cables = [];
  // (cables out of the rack's underside, down over the base and the ring, gathered in bundles left and right; a few round to the frame's legs)
  const loom = [
    [[-2.6, -12.0], [-2.9, -10.4], [-3.6, -9.2], [-4.6, -7.6], [-5.4, -6.0]],
    [[-2.0, -12.0], [-2.2, -10.2], [-3.0, -8.8], [-4.0, -7.2], [-4.6, -5.6]],
    [[-1.4, -12.0], [-1.6, -10.0], [-2.4, -8.4], [-3.3, -6.8], [-3.8, -5.4]],
    [[-0.7, -12.0], [-0.8, -9.8], [-1.2, -8.0], [-1.6, -6.4], [-1.8, -5.2]],
    [[-3.2, -13.0], [-3.9, -13.4], [-4.4, -12.6], [-4.6, -11.0]],
    [[-3.2, -12.5], [-3.7, -12.0], [-4.0, -10.8], [-4.9, -9.6], [-6.2, -8.4]],
  ];
  for (const c of loom) cables.push(c, c.map(flipX));
  cables.push([[0, -12.0], [0.2, -10.4], [-0.1, -8.6], [0.3, -6.8], [0, -5.0]]);
  // (and wires all over the stone, unevenly: from the frame, the clamps and the rack into it, each to a node of light
  // deep inside it, fine filaments branching off it, as if wired into its nerves)
  const curve = (a, b, bow, n = 7) => {
    const [ux, uy] = norm([b[0] - a[0], b[1] - a[1]]), len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    return Array.from({ length: n + 1 }, (_, k) => { const t = k / n, o = Math.sin(Math.PI * t) * bow * len; return [round(a[0] + (b[0] - a[0]) * t - uy * o), round(a[1] + (b[1] - a[1]) * t + ux * o)]; });
  };
  const nodes = [[-0.9, -22.6], [0.7, -23.5], [1.35, -20.9], [-1.45, -20.1], [0.35, -19.1], [-0.55, -17.5], [1.0, -17.9], [0.1, -21.7], [-0.2, -24.2]];
  const wires = [
    [[-3.4, -21.2], 0, 0.18], [[-2.5, -23.4], 7, -0.2], [[-3.8, -17.4], 3, 0.15], [[-3.1, -14.7], 5, -0.25], [[-3.6, -19.8], 7, 0.12],
    [[3.3, -21.8], 2, -0.16], [[2.0, -24.2], 1, 0.22], [[3.7, -16.8], 6, -0.18], [[2.9, -13.9], 4, 0.3], [[3.9, -19.4], 0, -0.1],
    [[-1.8, -14.4], 5, 0.2], [[1.6, -14.4], 6, -0.15], [[0.6, -14.4], 3, 0.25], [[-0.9, -25.4], 8, 0.3], [[0.5, -25.6], 1, -0.25],
  ];
  const h = (k) => ((Math.sin(k * 12.9898) * 43758.5453) % 1 + 1) % 1;
  const synapse = [];
  wires.forEach(([from, n, bow], k) => synapse.push({ kind: 'cable', poly: curve(from, nodes[n], bow), w: round(0.16 + 0.12 * h(k + 1)) }));
  nodes.forEach((c, k) => {
    for (let j = 0; j < 2 + (k % 2); j++) {
      const a = h(k * 7 + j) * Math.PI * 2, l = 0.7 + 0.8 * h(k * 5 + j + 2), m = [c[0] + Math.cos(a) * l * 0.5 + (h(k + j) - 0.5) * 0.3, c[1] + Math.sin(a) * l * 0.5 + (h(k * 3 + j) - 0.5) * 0.3];
      synapse.push({ kind: 'vein', poly: [c, m, [c[0] + Math.cos(a) * l, c[1] + Math.sin(a) * l]].map((q) => q.map(round)), w: 0.12, color: '#b9a4ff' });
    }
  });
  nodes.forEach((c) => synapse.push({ kind: 'ring', at: c, r: 0.3, w: 0.1, sides: 10 }, { kind: 'glow', at: c, r: 0.24, sides: 10, color: '#d8ccff' }));
  part('lamps', 'generator', STEEL, [[-3.5, -14.3], [3.5, -14.3], [3.3, -12.6], [2.6, -11.6], [-2.6, -11.6], [-3.3, -12.6]], {
    detail: [
      ...cables.map((pts, k) => ({ kind: 'cable', poly: pts, w: k % 3 ? 0.32 : 0.42 })),
      { kind: 'raise', poly: [[-3.2, -14.1], [3.2, -14.1], [3.0, -13.0], [-3.0, -13.0]] },
      ...lamps.flatMap((x) => [
        { kind: 'beam', poly: [[x - 0.32, top], [x + 0.32, top], [x * 0.25 + 0.5, -16.6], [x * 0.25 - 0.5, -16.6]] },
        { kind: 'ring', at: [x, -13.55], r: 0.48, w: 0.18, sides: 10 },
        { kind: 'glow', at: [x, -13.55], r: 0.34, sides: 10 },
      ]),
      rivet([-3.0, -12.2]), rivet([3.0, -12.2]),
      ...synapse,
    ],
  });
}

// ---- Its horn arms, cut back to stubs: tapered posts out of the ring, sawn off, a socket glowing in the end ----
{
  const a = -50, b0 = P(R3 - 1.0, a), b1 = P(R3 + 4.8, a);
  const s = bar(b0, b1, 3.6, 0.72);
  const [ux, uy] = norm([b1[0] - b0[0], b1[1] - b0[1]]);
  const at = (d, o) => [round(b0[0] + ux * d - uy * o), round(b0[1] + uy * d + ux * o)];
  pair('stub', 'armor', STEEL, s, {
    detail: [
      { kind: 'raise', poly: [at(2.2, -1.5), at(3.0, -1.4), at(3.0, 1.4), at(2.2, 1.5)] },
      { kind: 'recess', poly: [at(5.1, -1.05), at(5.75, -0.85), at(5.75, 0.85), at(5.1, 1.05)] },
      { kind: 'glow', at: at(5.4, 0), r: 0.55 },
      rivet(at(1.6, -1.1)), rivet(at(1.6, 1.1)),
    ],
  });
}

// ---- Its drives: the body's, a fifth smaller, hung a little below the ring ----
const body = JSON.parse(readFileSync(join(root, 'data/ships/bespoke/pyreclast.json'), 'utf8')).pieces;
const SC = 0.76, DROP = 5.1;
const sc = ([x, y]) => [round(x * SC), round(C[1] + (y - C[1]) * SC + DROP)];
const shrinkDetail = (d) => ({ ...d, ...(d.poly ? { poly: d.poly.map(sc) } : {}), ...(d.at ? { at: sc(d.at) } : {}), ...(d.r !== undefined ? { r: round(d.r * SC) } : {}), ...(d.w !== undefined ? { w: round(d.w * SC) } : {}) });
for (const name of ['drive_l', 'drive_c', 'drive_r']) {
  const p = body.find((q) => q.id === `pyreclast_${name}`);
  part(name, 'plasma_drive', 'pyre_chrome', p.polygon.map(sc), { relief: 'round', mount: { ...p.mount, at: sc(p.mount.at), width: round(p.mount.width * SC) }, detail: p.detail.map(shrinkDetail) });
}
// The struts they hang on (each bolted at both ends), and the hoses feeding them (ribbed, sagging)
const dl = body.find((q) => q.id === 'pyreclast_drive_l').polygon.map(sc), dc = body.find((q) => q.id === 'pyreclast_drive_c').polygon.map(sc);
const strut = (name, a, b) => pair(name, 'hull', STEEL, bar(a, b, 0.95), { detail: [rivet(mid(a, b, 0.12), 0.32), rivet(mid(a, b, 0.88), 0.32)] });
strut('strut_out', P(R3 - 0.8, -140), mid(dl[6], dl[0], 0.55));
strut('strut_in', P(R3 - 0.8, -158), mid(dl[0], dl[1], 0.5));
part('strut_c', 'hull', STEEL, bar([0, 17.6], [0, dc[1][1] + 0.6], 1.3), { detail: [rivet([0, 17.9], 0.34)] });
pair('strut_c_side', 'hull', STEEL, bar([-4.2, 17.9], mid(dc[0], dc[1], 0.35), 0.85), { detail: [rivet([-4.2, 18.1], 0.28)] });
pair('hose_out', 'conduit', GLASS, hose(P(R3 - 0.3, -125), mid(dl[6], dl[5], 0.3), 0.95, -1.4), { relief: 'ridge' });
pair('hose_in', 'conduit', GLASS, hose([-5.9, 16.6], mid(dl[1], dl[2], 0.45), 0.85, 1.0), { relief: 'ridge' });
pair('hose_c', 'conduit', GLASS, hose([-2.6, 18.2], mid(dc[0], dc[1], 0.72), 0.8, -0.7), { relief: 'ridge' });

// ---- The core, last: wide open, white-hot, a heavy bezel round it ----
const hex = (r) => [30, 90, 150, 210, 270, 330].map((d) => P(r, d));
part('core', 'core', GLASS, hex(RC + 0.8), {
  ruin: true,
  relief: 'recess',
  detail: [
    { kind: 'ring', at: C, r: RC + 0.5, w: 0.75, sides: 6 },
    ...[0, 60, 120, 180, 240, 300].map((d) => rivet(P(RC + 0.15, d), 0.26)),
    { kind: 'glow', at: C, r: RC - 0.2, sides: 6 },
    { kind: 'ring', at: C, r: RC - 1.4, w: 0.32, sides: 6 },
    { kind: 'halo', at: C, r: RC - 0.6, w: 0.1, sides: 6 },
    { kind: 'glow', at: C, r: 2.4, sides: 12 },
  ],
});

// Its limbs (PieceDef `limb`, `armour` outright 5 against its body's 3: scripts/bespoke/pyreclast.mjs): the crystal (its
// beams) and its three vents (its heat); never what its heart is beaten by
const LIMBS = new Set(['mineral', 'vent_housing', 'aft_vent']);
for (const p of pieces) {
  if (LIMBS.has(p.id.replace(/^pyreclast_s3_/, '').replace(/_[lr]$/, ''))) { p.limb = true; p.armour = 5; } else p.armour = 3;
}

const pieceFile = { _comment:'The Pyreclast\'s heart (its third stage). Written by scripts/bespoke/pyreclast_heart.mjs: edit that, not this.', pieces };
const design = { name: 'Pyreclast Heart', catalogVersion: 1, paint: '#2a201c', parts };
writeFileSync(join(root, 'data/ships/bespoke/pyreclast_heart.json'), compactJson(pieceFile));
writeFileSync(join(root, 'data/ships/blueprints/enemy/pyreclast_heart.json'), JSON.stringify(design, null, 1) + '\n');
console.log(`${pieces.length} pieces`);
