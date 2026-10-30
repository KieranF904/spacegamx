/**
 * The Pyreclast's hull (bosses.json boss_pyreclast): writes its bespoke
 * pieces (data/ships/bespoke/pyreclast.json) and its design
 * (data/ships/blueprints/enemy/pyreclast.json). Run: node scripts/bespoke/pyreclast.mjs [preview.svg]
 *
 * Grid units (a cell is 24 world units), y down, nose towards -y. Built as
 * the left half and mirrored, then scaled up by S on the way out. Every part
 * shares an edge with its neighbours or lies over one (bespoke parts join what
 * they touch), and power runs core → generator ring → the conduit veins →
 * whatever's out on the wings.
 *
 * Its look: a recessed core framed by rings, ribs from the heart out to every
 * spire, spires seated in collars with clusters of crystal at their roots,
 * recessed vents and glowing channels where power runs, turrets on raised
 * hardpoints, drives in heavy nozzle housings (pieces' `detail`: look only).
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const DEG = Math.PI / 180;
const C = [0, 3];
/** A point `r` out from the hull's middle, `deg` round from straight ahead (positive: to the right) */
const P = (r, deg, c = C) => [round(c[0] + r * Math.sin(deg * DEG)), round(c[1] - r * Math.cos(deg * DEG))];
const round = (v) => Math.round(v * 1000) / 1000;
const mid = (a, b, t = 0.5) => [round(a[0] + (b[0] - a[0]) * t), round(a[1] + (b[1] - a[1]) * t)];
const mirror = (pts) => pts.map(([x, y]) => [round(-x), y]).reverse();
const flipX = (p) => [round(-p[0]), p[1]];
const norm = ([x, y]) => { const l = Math.hypot(x, y) || 1; return [round(x / l), round(y / l)]; };
const centroid = (pts) => [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length];

const pieces = [];
const parts = [];
let uid = 0;
/** The whole hull is drawn at this scale on the way out (turrets keep their size: a bigger gun hits harder) */
const S = 1.4;
/** One part: its shape, what it is, and (engines, guns, bays) where it points out; its look: relief, turret size, detail */
function part(name, fn, material, polygon, opts = {}) {
  const id = `pyreclast_${name}`;
  pieces.push({
    id, polygon, ...(opts.mount ? { mount: opts.mount } : {}), ...(opts.contact ? { contact: opts.contact } : {}),
    ...(opts.relief ? { relief: opts.relief } : {}), ...(opts.turretSize ? { turret: opts.turretSize } : {}), ...(opts.detail?.length ? { detail: opts.detail } : {}),
  });
  parts.push({ uid: uid++, piece: id, fn, material, x: 0, y: 0, rot: 0, flip: false, ...(opts.turret ? { mount: 'turret' } : {}) });
}
/** A detail mirrored to the right side */
const mirrorDetail = (d) => ({ ...d, ...(d.poly ? { poly: d.kind === 'vein' ? d.poly.map(flipX) : mirror(d.poly) } : {}), ...(d.at ? { at: flipX(d.at) } : {}), ...(d.dir ? { dir: flipX(d.dir) } : {}) });
/** The same on both sides: the left as given, the right mirrored */
function pair(name, fn, material, polygon, opts = {}) {
  part(`${name}_l`, fn, material, polygon, opts);
  const m = opts.mount && { ...opts.mount, at: flipX(opts.mount.at), dir: flipX(opts.mount.dir) };
  part(`${name}_r`, fn, material, mirror(polygon), { ...opts, mount: m, detail: opts.detail?.map(mirrorDetail) });
}
/** A turret: a small hexagon sat on the plate under it (overlapping it, so it holds on), aimed `dir`, on a raised hardpoint */
const turret = (c, dir, r = 0.72) => ({
  polygon: [0, 60, 120, 180, 240, 300].map((d) => P(r / S, d + 30, c)), mount: { at: c, dir, width: (r / S) * 1.6 },
  turretSize: 1.5,
  detail: [
    { kind: 'raise', poly: [0, 45, 90, 135, 180, 225, 270, 315].map((d) => P(1.2, d + 22.5, c)) },
    { kind: 'ring', at: c, r: 1.0, w: 0.3 },
    { kind: 'halo', at: c, r: 1.32, w: 0.1, sides: 8 },
  ],
});
const outward = (deg) => [round(Math.sin(deg * DEG)), round(-Math.cos(deg * DEG))];
/** A band `w` wide from a to b (ribs, channels, collars), its ends `taper` narrower */
function bar(a, b, w, taper = 0.85) {
  const [ux, uy] = norm([b[0] - a[0], b[1] - a[1]]), vx = -uy * w / 2, vy = ux * w / 2;
  return [[a[0] - vx, a[1] - vy], [b[0] - vx * taper, b[1] - vy * taper], [b[0] + vx * taper, b[1] + vy * taper], [a[0] + vx, a[1] + vy]].map(([x, y]) => [round(x), round(y)]);
}
/** A cluster of crystal shards rooted along a→b, growing `dir`, of different sizes (detail) */
function cluster(a, b, dir, n, size, spread = 0.5, seed = 1) {
  const out = [];
  for (let k = 0; k < n; k++) {
    const t = (k + 0.5) / n, h = ((Math.sin((k + 1) * 12.9898 + seed * 78.233) * 43758.5453) % 1 + 1) % 1;
    const ang = Math.atan2(dir[1], dir[0]) + (h - 0.5) * spread * 2;
    out.push({ kind: 'shard', crystal: true, at: mid(a, b, t), dir: [round(Math.cos(ang)), round(Math.sin(ang))], r: size * (0.55 + 0.7 * h), w: size * (0.28 + 0.12 * h) });
  }
  return out;
}
/** Vents along a strip: two corners down one long side (a0 → a1), two back up the other (b1 → b0), `fins` across */
const vent = (a0, a1, b1, b0, fins = 6) => ({ kind: 'vent', poly: [a0, a1, b1, b0], fins });
/**
 * Teeth along the edge a→b of `parent` (left side; mirrored too): `n` crystal
 * spikes, `depth` out, each leaning `lean` of the way along its base, each
 * with a smaller shard or two at its root (a cluster, not a row)
 */
function teeth(name, fn, material, parent, a, b, n, depth, lean = 0.5) {
  const ex = b[0] - a[0], ey = b[1] - a[1], len = Math.hypot(ex, ey);
  let nx = -ey / len, ny = ex / len;
  const c = centroid(parent), m = mid(a, b);
  if ((c[0] - m[0]) * nx + (c[1] - m[1]) * ny > 0) { nx = -nx; ny = -ny; }
  for (let i = 0; i < n; i++) {
    const p0 = mid(a, b, i / n), p1 = mid(a, b, (i + 1) / n), at = mid(p0, p1, lean);
    const tip = [round(at[0] + nx * depth), round(at[1] + ny * depth)];
    const lean2 = norm([tip[0] - mid(p0, p1)[0], tip[1] - mid(p0, p1)[1]]);
    pair(`${name}${i}`, fn, material, [p0, tip, p1], {
      contact: 0.6, relief: 'ridge',
      detail: cluster(mid(p0, p1, 0.1), mid(p0, p1, 0.9), lean2, 2, depth * 0.55, 0.6, i + name.length),
    });
  }
}

// Its own materials (boss-only): dark volcanic glass throughout, crystal at the spires, teeth and clusters; guns of plain conductive steel (their damage is a gun's)
const GLASS = 'pyre_glass', CRYSTAL = 'pyre_crystal', GUN = 'conductive_steel';

// ---- The heart: the core sunk in, framed by rings, the light deep inside; a ring of generators round it ----
const R0 = 3.2, R1 = 5.6, R2 = 8.8;
const hex = (r) => [30, 90, 150, 210, 270, 330].map((d) => P(r, d));
// (the core itself comes last, so its veins lie over everything: see the end)
for (let k = 0; k < 6; k++) {
  const a = 30 + 60 * k, b = a + 60;
  // Each generator a raised block, a glowing channel down its middle
  part(`heart_${k}`, 'generator', GLASS, [P(R0, a), P(R1, a), P(R1, b), P(R0, b)], {
    detail: [{ kind: 'channel', poly: bar(P(R0 + 0.45, a + 30), P(R1 - 0.45, a + 30), 0.32, 1) }],
  });
}

// ---- The carapace: twelve plates round the heart, each in two courses ----
// (inner corners on the generator ring's outline; outer on a circle)
const inner = (deg) => {
  // On the hexagon R1: between its corners at 30 + 60k
  const k = Math.floor((((deg - 30) % 360) + 360) % 360 / 60), a = 30 + 60 * k;
  const t = ((((deg - a) % 360) + 360) % 360) / 60;
  return mid(P(R1, a), P(R1, a + 60), t);
};
const course = (d) => mid(inner(d), P(R2, d), 0.45);
/** Carapace plate d0..d1: its inner course and its outer */
const plateIn = (d0, d1) => [inner(d0), course(d0), course(d1), inner(d1)];
const plateOut = (d0, d1) => [course(d0), P(R2, d0), P(R2, d1), course(d1)];
/** A glowing channel down the middle of an outer carapace plate (where power runs out to the wings) */
const radialChannel = (d0, d1) => ({ kind: 'channel', poly: bar(mid(course((d0 + d1) / 2), P(R2, (d0 + d1) / 2), 0.12), mid(course((d0 + d1) / 2), P(R2, (d0 + d1) / 2), 0.88), 0.3, 1) });
// Ahead: the prow's root (armour); sides: veins out to the wings; behind: mortars and vents
part('carapace_front_in_l', 'armor', GLASS, plateIn(-30, 0));
part('carapace_front_in_r', 'armor', GLASS, plateIn(0, 30));
part('carapace_front_l', 'armor', GLASS, plateOut(-30, 0));
part('carapace_front_r', 'armor', GLASS, plateOut(0, 30));
for (const [name, d0, d1] of [['fore', -60, -30], ['side', -90, -60], ['aft', -120, -90]]) {
  pair(`carapace_${name}_in`, 'conduit', GLASS, plateIn(d0, d1));
  pair(`carapace_${name}`, 'conduit', GLASS, plateOut(d0, d1), { detail: [radialChannel(d0, d1)] });
}
pair('mortar_bed', 'conduit', GLASS, plateIn(-150, -120));
const mortarAt = P(R2 * 0.8, -135);
pair('mortar', 'magma_mortar', GLASS, plateOut(-150, -120), {
  mount: { at: P(R2 * 0.85, -135), dir: outward(-135), width: 2 },
  detail: [{ kind: 'ring', at: mortarAt, r: 1.0, w: 0.32 }, { kind: 'glow', at: mortarAt, r: 0.62 }],
});
part('vent_bed_l', 'conduit', GLASS, plateIn(-180, -150));
part('vent_bed_r', 'conduit', GLASS, plateIn(150, 180));
const ventPlate = (d0, d1) => vent(mid(course(d0), course(d1), 0.18), mid(course(d0), course(d1), 0.82), mid(P(R2, d0), P(R2, d1), 0.8), mid(P(R2, d0), P(R2, d1), 0.2), 4);
part('vent_l', 'heat_vent', GLASS, plateOut(-180, -150), { detail: [ventPlate(-180, -150)] });
part('vent_r', 'heat_vent', GLASS, plateOut(150, 180), { detail: [ventPlate(150, 180)] });

// ---- The prow: a vein down the middle to the lance, plates either side, two great horns ----
/** A point along the carapace's straight outer edge between d0 and d1 */
const chord = (d0, d1, t) => mid(P(R2, d0), P(R2, d1), t);
const rootL = chord(-30, 0, 0.72), rootR = chord(0, 30, 0.28);
// (the spine's root sits across the two front plates' outer edges; a channel of light runs its length)
part('spine', 'conduit', GLASS, [rootL, P(R2, 0), rootR, [0.9, -15], [0.9, -17], [-0.9, -17], [-0.9, -15]], {
  detail: [{ kind: 'channel', poly: bar([0, -6.2], [0, -16.4], 0.42, 0.7) }],
});
part('lance', 'pyre_lance', CRYSTAL, [[-0.9, -17], [0.9, -17], [0.6, -20.5], [0, -21.5], [-0.6, -20.5]], {
  mount: { at: [0, -21.5], dir: [0, -1], width: 1.2 }, relief: 'ridge',
  detail: [{ kind: 'glow', at: [0, -18.4], r: 0.7 }],
});
// Armoured chevrons laid across the spine
[-8.6, -11, -13.4, -15.6].forEach((y, i) => part(`spine_rib_${i}`, 'armor', GLASS, [[-1.5, y], [0, y - 0.7], [1.5, y], [1.2, y + 0.55], [0, y - 0.1], [-1.2, y + 0.55]]));
// Prow plates: from the front carapace's outer edge to the spine's flank, raked back, in two
const pa = mid(rootL, [-0.9, -15], 0.5), pb = mid([-5.2, -9.5], P(R2, -30), 0.5);
pair('prow', 'armor', GLASS, [P(R2, -30), rootL, pa, pb]);
pair('prow_fore', 'armor', GLASS, [pb, pa, [-0.9, -15], [-0.9, -17], [-2.6, -15.5], [-5.2, -9.5]], {
  detail: [{ kind: 'recess', poly: [mid(pb, pa, 0.25), mid(pb, pa, 0.75), mid([-0.9, -15], [-2.6, -15.5], 0.6), mid([-5.2, -9.5], [-2.6, -15.5], 0.5)] }],
});
// Horns: off the fore carapace, sweeping out and forward; seated in a collar, crystal clustered at the root
const hornRoot0 = P(R2, -60), hornRoot1 = P(R2, -30);
const hg = turret([-8.6, -11.4], [-0.45, -0.89]);
pair('horn_base', 'molten_plate', GLASS, [hornRoot0, hornRoot1, [-5.2, -9.5], [-8.6, -13.5], [-11.4, -10.2]]);
const hx = mid([-8.6, -13.5], [-9.6, -19]), hy = mid([-12.6, -17.5], [-11.4, -10.2]);
const hornA = [[-11.4, -10.2], [-8.6, -13.5], hx, hy];
const hornTip = [hy, hx, [-9.6, -19], [-11.2, -24.5], [-12.6, -17.5]];
const hornUp = norm([-11.2 - hx[0], -24.5 - hx[1]]);
pair('horn', 'armor', GLASS, hornA, {
  // The collar: a heavy band round the spire's root
  detail: [{ kind: 'raise', poly: [mid(hy, hx, 0.04), mid(hy, hx, 0.96), mid(hx, [-8.6, -13.5], 0.38), mid(hy, [-11.4, -10.2], 0.38)] }],
});
pair('horn_tip', 'armor', CRYSTAL, hornTip, { contact: 0.5, relief: 'ridge', detail: cluster(mid(hy, hx, 0.15), mid(hy, hx, 0.85), hornUp, 3, 2.2, 0.45, 3) });
teeth('horn_tooth', 'armor', CRYSTAL, hornA, hy, [-11.4, -10.2], 2, 1.1, 0.3);
teeth('horn_tip_tooth', 'armor', CRYSTAL, hornTip, [-12.6, -17.5], hy, 2, 1.0, 0.25);
// A cannon turret on each horn's root, on its hardpoint
pair('horn_gun', 'magma_cannon', GUN, hg.polygon, { mount: hg.mount, turret: true, turretSize: hg.turretSize, detail: hg.detail });

// ---- The wings: scythes off the flanks, sweeping out and forward ----
const sideA = P(R2, -90), sideB = P(R2, -60);
const aftA = P(R2, -120);
// Wing root (a dash coil) on the side and aft veins' outer edges: two finned vents through it
const w0 = [-13.5, -3.5], w1 = [-14.5, 5.5];
pair('coil', 'dash_coil', GLASS, [sideB, sideA, aftA, w1, w0], {
  mount: { at: mid(w0, w1), dir: [-1, 0], width: 3 },
  detail: [vent([-10.4, -1.9], [-13.2, -2.4], [-13.5, 0.2], [-10.6, 0.7], 7), vent([-10.8, 2.0], [-13.6, 1.6], [-13.9, 4.2], [-11.0, 4.6], 7)],
});
// Mid wing: a vein running out (power for the guns and the bay), vented too
const m0 = [-20, -7.5], m1 = [-21.5, 4];
pair('wing_vein', 'conduit', GLASS, [w0, w1, m1, m0]);
// Its leading edge (armour), and a flak turret on its hardpoint
// (split at the body's edge, x = -EDGE: the inner part stays with the body when the wing goes)
const EDGE = 14.5;
/** A polygon's part on one side of x = -EDGE (inner: x >= -EDGE) */
function halfAt(poly, inner) {
  const out = [], ins = (p) => (inner ? p[0] >= -EDGE : p[0] <= -EDGE);
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    if (ins(a)) out.push(a);
    if (ins(a) !== ins(b) && a[0] !== b[0]) { const t = (-EDGE - a[0]) / (b[0] - a[0]); out.push([-EDGE, a[1] + (b[1] - a[1]) * t]); }
  }
  return out.filter((p, i) => i === 0 || Math.hypot(p[0] - out[i - 1][0], p[1] - out[i - 1][1]) > 1e-6);
}
const lead = [sideB, w0, m0, [-17.5, -10.5], [-12.4, -8.8]];
pair('wing_lead_in', 'molten_plate', GLASS, halfAt(lead, true));
pair('wing_lead', 'molten_plate', GLASS, halfAt(lead, false));
const wf = turret([-15.4, -7.6], [-0.2, -0.98], 0.85);
// Trailing edge: the brood bay, its mouth out and back (sunk, glowing)
const bayMouth = mid(m1, [-19.5, 8]);
const bayPoly = [aftA, w1, m1, [-19.5, 8], [-12, 9.5]];
pair('bay_in', 'molten_plate', GLASS, halfAt(bayPoly, true));
pair('bay', 'brood_bay', GLASS, halfAt(bayPoly, false), {
  mount: { at: bayMouth, dir: [-0.7, 0.71], width: 2.6 },
  detail: [{ kind: 'recess', poly: [[-14.6, 6.4], [-19.6, 5.4], [-18.6, 7.6], [-13.8, 8.6]] }, { kind: 'glow', at: [-16.6, 7.0], r: 0.9 }],
});
// Outer wing: the scythe, curving forward to a point, in two; its spire seated in a collar with crystal at its root
const s0 = [-26.5, -4], s1 = [-27, 3];
pair('scythe_root', 'molten_plate', GLASS, [m0, m1, s1, s0]);
const scytheA = [m0, s0, [-28.5, -11], [-24, -13]];
const scytheTip = [[-24, -13], [-28.5, -11], [-27.5, -20]];
const scytheUp = norm([-27.5 - (-26.25), -20 - (-12)]);
pair('scythe', 'molten_plate', GLASS, scytheA, {
  detail: [{ kind: 'raise', poly: [mid([-24, -13], [-28.5, -11], 0.04), mid([-24, -13], [-28.5, -11], 0.96), mid([-28.5, -11], s0, 0.22), mid([-24, -13], m0, 0.22)] }],
});
pair('scythe_tip', 'molten_plate', CRYSTAL, scytheTip, { contact: 0.5, relief: 'ridge', detail: cluster([-24.4, -12.8], [-28.1, -11.2], scytheUp, 4, 2.0, 0.5, 7) });
teeth('scythe_tooth', 'armor', CRYSTAL, scytheA, s0, [-28.5, -11], 3, 1.3, 0.75);
teeth('scythe_tip_tooth', 'armor', CRYSTAL, scytheTip, [-28.5, -11], [-27.5, -20], 3, 1.1, 0.75);
const heel = [m1, [-19.5, 8], [-24.5, 9], s1];
pair('scythe_heel', 'armor', GLASS, heel);
teeth('heel_tooth', 'armor', CRYSTAL, heel, [-19.5, 8], [-24.5, 9], 3, 1.2, 0.7);
// A cannon turret on each scythe, on its hardpoint
const sg = turret([-24.4, -8.2], [-0.6, -0.8]);

// ---- Armour plates laid over the rest, overhanging the parts they cover (each casts its shadow on them) ----
// Over the scythe: from below its crystal, round its gun, down onto the wing root
pair('scythe_plate', 'armor', GLASS, [[-22.9, -12.9], [-23.9, -12.6], [-26.1, -11.0], [-25.7, -7.2], [-23.5, -3.6], [-19.4, -4.6], [-19.0, -7.3]], { relief: 'plate' });
// Over the wing vein: a great C-shaped plate, its curve overhanging the scythe's root; the vein's vents through it
pair('wing_plate', 'armor', GLASS, [[-14.8, -4.3], [-21.1, -6.0], [-22.6, -5.2], [-23.6, -3.4], [-24.0, -1.2], [-23.6, 1.6], [-22.6, 3.6], [-20.2, 4.4], [-14.8, 5.0]], {
  relief: 'plate',
  detail: [vent([-15.4, -3.0], [-19.8, -4.6], [-20.1, -2.4], [-15.6, -0.9], 8), vent([-15.6, 0.9], [-20.4, -0.2], [-20.6, 2.0], [-15.8, 3.1], 8)],
});
// Along the horn: its inner edge down the horn, out over the horn's outer flank
pair('horn_plate', 'armor', GLASS, [[-10.7, -14.7], [-6.1, -3.3], [-8.0, -0.9], [-12.1, -9.9], [-12.5, -13.4]], { relief: 'plate' });

// ---- Ribs: raised from the heart out to every spire (laid over the plates they cross) ----
pair('rib_horn', 'molten_plate', GLASS, bar(P(R1 + 0.5, -42), [-7.6, -10.2], 0.75, 0.7));
pair('rib_scythe', 'molten_plate', GLASS, bar(P(R1 + 0.5, -68), [-18.6, -6.6], 0.8, 0.65));
pair('rib_aft', 'molten_plate', GLASS, bar(P(R1 + 0.5, -112), [-11.2, 8.4], 0.7, 0.7));
// (the turrets after the ribs, so their hardpoints lie on top)
pair('wing_flak', 'magma_cannon', GUN, wf.polygon, { mount: wf.mount, turret: true, turretSize: 1.7, detail: wf.detail });
pair('scythe_gun', 'magma_cannon', GUN, sg.polygon, { mount: sg.mount, turret: true, turretSize: sg.turretSize, detail: sg.detail });

// ---- Aft: three great drives in heavy nozzle housings, their housings off the vents and aft veins; fins on the outer two ----
const back0 = P(R2, -150), back1 = P(R2, 180), back2 = P(R2, 150);
const ey = 15.5;
const drive = [aftA, back0, [-5.4, 14.0], [-6.0, 18.2], [-9.2, 18.2], [-9.9, 14.0], [-12, 9.5]];
pair('drive', 'plasma_drive', GLASS, drive, {
  mount: { at: [-7.6, 18.2], dir: [0, 1], width: 3.0 },
  detail: [
    { kind: 'raise', poly: [[-5.5, 13.4], [-9.8, 13.4], [-9.9, 14.5], [-5.4, 14.5]] },
    { kind: 'vent', poly: [[-6.3, 10.2], [-6.5, 12.6], [-8.9, 12.6], [-9.3, 10.2]], fins: 4 },
    { kind: 'bell', at: [-7.6, 18.2], dir: [0, 1], r: 1.75, w: 2.8 },
  ],
});
teeth('drive_fin', 'armor', CRYSTAL, drive, [-9.9, 14.0], [-12, 9.5], 2, 1.4, 0.25);
part('drive_c', 'plasma_drive', GLASS, [back0, back1, back2, [3.6, 14.6], [2.7, 19.6], [-2.7, 19.6], [-3.6, 14.6]], {
  mount: { at: [0, 19.6], dir: [0, 1], width: 4.6 },
  detail: [
    { kind: 'raise', poly: [[-3.6, 14.0], [3.6, 14.0], [3.5, 15.2], [-3.5, 15.2]] },
    { kind: 'vent', poly: [[-2.4, 10.8], [2.4, 10.8], [2.4, 13.0], [-2.4, 13.0]], fins: 6 },
    { kind: 'bell', at: [0, 19.6], dir: [0, 1], r: 2.5, w: 3.6 },
  ],
});
// Small steering drives under each brood bay
const aux1 = [[-13, 9.3], [-15.2, 8.86], [-15.0, 11.0], [-13.2, 11.2]], aux2 = [[-16.2, 8.66], [-18.4, 8.22], [-18.2, 10.4], [-16.4, 10.8]];
pair('aux_drive', 'thruster', GLASS, aux1, { mount: { at: [-14.1, 11.1], dir: [0, 1], width: 1.6 }, detail: [{ kind: 'bell', at: [-14.1, 11.1], dir: [0, 1], r: 0.85, w: 1.5 }] });
pair('aux_drive2', 'thruster', GLASS, aux2, { mount: { at: [-17.3, 10.6], dir: [0, 1], width: 1.6 }, detail: [{ kind: 'bell', at: [-17.3, 10.6], dir: [0, 1], r: 0.85, w: 1.5 }] });

// ---- The core, last: sunk in, framed by rings, the light deep inside, and its veins of light out to every gun and node ----
/** A vein from the core towards `to`, wandering a little, stopping `short` of it (at a hardpoint's rim) */
function veinTo(to, short, seed, width = 0.42) {
  const dx = to[0] - C[0], dy = to[1] - C[1], len = Math.hypot(dx, dy), ux = dx / len, uy = dy / len, vx = -uy, vy = ux;
  const from = R0 * 0.55, end = len - short, pts = [];
  const h = (k) => ((Math.sin(k * 12.9898 + seed * 78.233) * 43758.5453) % 1 + 1) % 1;
  const ph1 = h(1) * 6.28, ph2 = h(2) * 6.28, amp = 0.5 + 0.6 * h(3);
  const steps = Math.max(6, Math.round((end - from) / 0.9));
  for (let k = 0; k <= steps; k++) {
    const t = k / steps, d = from + (end - from) * t;
    // (it leaves the core straight, wanders, and arrives straight)
    const wob = amp * Math.sin(Math.PI * t) * (0.5 * Math.sin(t * 11 + ph1) + 0.3 * Math.sin(t * 23 + ph2) + 0.2 * Math.sin(t * 41 + ph1 * 2));
    pts.push([round(C[0] + ux * d + vx * wob), round(C[1] + uy * d + vy * wob)]);
  }
  return { kind: 'vein', poly: pts, w: width * 0.62 };
}
const node = (at) => [{ kind: 'ring', at, r: 0.62, w: 0.2 }, { kind: 'glow', at, r: 0.42 }];
const veinTargets = [
  // [where, how far short, width]: the guns (to their hardpoints' rims), the mortar, the bay, the drives, and nodes between
  [[-8.6, -11.4], 1.25, 0.46], [[-15.4, -7.6], 1.25, 0.44], [[-24.4, -8.2], 1.25, 0.4], [P(R2 * 0.8, -135), 1.0, 0.4],
  [[-16.6, 7.0], 0.9, 0.38], [[-7.6, 12.0], 0.5, 0.42], [[-21.2, 0.8], 0.5, 0.36], [[-5.2, -12.6], 0.5, 0.34],
];
const veins = [], nodes = [];
veinTargets.forEach(([to, short, w], i) => {
  const v = veinTo(to, short, i + 3, w);
  veins.push(v, mirrorDetail(v));
  if (short <= 0.5) { const end = v.poly[v.poly.length - 1]; nodes.push(...node(end), ...node(flipX(end)).map((d) => d)); }
});
const coreDown = veinTo([0, 10.2], 0.5, 41, 0.5), coreUp = veinTo([0, -5.6], 0.3, 43, 0.4);
// (its heart, beneath, has the true core: this one's a generator, so it can break away from it)
part('core', 'generator', GLASS, hex(R0), {
  relief: 'recess',
  detail: [
    ...veins, coreDown, coreUp, ...nodes, ...node(coreDown.poly[coreDown.poly.length - 1]),
    { kind: 'ring', at: C, r: 2.9, w: 0.55, sides: 6 },
    { kind: 'ring', at: C, r: 2.15, w: 0.4, sides: 6 },
    { kind: 'halo', at: C, r: 2.45, w: 0.08, sides: 6 },
    { kind: 'glow', at: C, r: 1.65, sides: 6 },
  ],
});

// Out at its true size
const scale = ([x, y]) => [round(x * S), round(y * S)];
for (const p of pieces) {
  p.polygon = p.polygon.map(scale);
  if (p.mount) p.mount = { ...p.mount, at: scale(p.mount.at), width: round((p.mount.width ?? 1) * S) };
  if (p.detail) p.detail = p.detail.map((d) => ({
    ...d, ...(d.poly ? { poly: d.poly.map(scale) } : {}), ...(d.at ? { at: scale(d.at) } : {}),
    ...(d.r !== undefined ? { r: round(d.r * S) } : {}), ...(d.w !== undefined ? { w: round(d.w * S) } : {}),
  }));
}

// ---- Its skeleton: one part to each wing over the union of that wing's carapace (true size), last (so the plating
// over it takes the hits first); drawn as lit geometry under the hull (client ships/skeletonBuild.ts): a rim just inside
// the carapace's outline, a main frame of bones out from the body to what's on the wing, a finer frame beneath, and
// its inner workings; what's on the wing holds onto it as its carapace comes off, and goes with it when it breaks ----
const WING_PIECES = ['wing_lead', 'wing_vein', 'scythe_root', 'scythe', 'scythe_heel', 'bay', 'scythe_plate', 'wing_plate', 'rib_scythe'];
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
const wingPolys = WING_PIECES.map((n) => pieces.find((q) => q.id === `pyreclast_${n}_l`).polygon);
// (its own outline a little proud of the carapace's, so what sits on the carapace's edge, crystal teeth, holds to it)
const WING = unionOutline(wingPolys, -0.25, -19.9);
const RIM_W = 0.95, RIM = unionOutline(wingPolys, 0.18 + RIM_W / 2, -20.1);
// The main frame (left; mirrored): three beams out from the body (top: to the scythe gun and the crystal's root;
// middle: through the node to the rim; low: through the bay to the heel), braced from the node to the guns and the
// bay, a spur to the leading corner. Widths in cells, tapering out from the root
const ROOT_T = [-20.3, -6], ROOT_M = [-20.3, 1], ROOT_L = [-20.3, 8.5];
const S_GUN = [-34.2, -11.5], S_FLAK = [-21.6, -10.6], S_NODE = [-29, 1.2], S_BAY = [-28.7, 8.4], S_CRYST = [-35.8, -15.6];
const k0 = 0.62;
const BONES = [
  { pts: [ROOT_T, [-28, -10.4], S_GUN, S_CRYST], w: [1.9, 1.5, 1.4, 1.1], lava: true },
  { pts: [ROOT_M, S_NODE, [-36.6, -0.8]], w: [1.8, 1.4, 1.1], lava: true },
  { pts: [ROOT_L, S_BAY, [-35.2, 8.6]], w: [1.7, 1.3, 1.0] },
  { pts: [S_NODE, [-32.6, -5.5], S_GUN], w: [1.2, 1.0, 1.1] },
  { pts: [S_NODE, [-25, -5], S_FLAK], w: [1.2, 1.0, 1.0] },
  { pts: [S_NODE, S_BAY], w: [1.1, 1.1] },
  { pts: [S_BAY, [-32.4, 4.4]], w: [0.9, 0.9] },
  { pts: [S_FLAK, [-24.1, -13.6]], w: [1.0, 0.8] },
  { pts: [[-33.5, -1], [-35.4, -8.4]], w: [0.8, 0.8] },
].map((b) => ({ pts: b.pts, w: b.w.map((v) => round(v * k0)), layer: 0, ...(b.lava ? { lava: true } : {}) }));
// The finer frame beneath: bracing across each gap of the main one
const FINE = [
  [[-22.6, -8.5], [-26.6, -3.6]], [[-21, -3.6], [-26.2, -9.3]],
  [[-22.4, -0.4], [-24.8, -4.6]], [[-24.8, 1.1], [-24.4, -3.8]],
  [[-27.4, -9.9], [-30.8, -2.8]], [[-26.3, -4.4], [-32.2, -8.4]],
  [[-30.5, -1.2], [-34.2, -8.8]], [[-34.6, -3.4], [-36.6, -4]],
  [[-29.6, -12.4], [-32.8, -15.2]], [[-35.1, -12.4], [-37.6, -12.4]], [[-25.4, -11.4], [-27.9, -13.2]],
  [[-21.8, 4.6], [-27.2, 2.8]], [[-24.6, 1.6], [-24.4, 8.2]], [[-30.8, 2.2], [-34.6, 6.2]], [[-32.6, 1], [-36.2, 3]],
  [[-23.6, 8.6], [-22.8, 11.8]], [[-31, 8.8], [-31.6, 11]], [[-26.6, 8.6], [-26.2, 11]],
].map((pts) => ({ pts, w: [round(1.05 * 0.42), round(0.9 * 0.42)], layer: 1 }));
// Each bone gently bowed, as designed (a sixth of a tenth of its length out at its middle, one way then the other
// along it), so the finer frame's ends land on the main one: in eight steps a segment, its width tapering along them
function bowed(b) {
  const pts = [b.pts[0]], w = [b.w[0]];
  if (b.pts.length < 2) return b;
  for (let i = 0; i < b.pts.length - 1; i++) {
    const a = b.pts[i], c = b.pts[i + 1], len = Math.hypot(c[0] - a[0], c[1] - a[1]), nx = -(c[1] - a[1]) / len, ny = (c[0] - a[0]) / len, bow = (i % 2 ? -1 : 1) * len * 0.06;
    const w0 = b.w[Math.min(i, b.w.length - 1)], w1 = b.w[Math.min(i + 1, b.w.length - 1)];
    for (let t = 1; t <= 8; t++) {
      const f = t / 8, o = bow * Math.sin(Math.PI * f);
      pts.push([round(a[0] + (c[0] - a[0]) * f + nx * o), round(a[1] + (c[1] - a[1]) * f + ny * o)]);
      w.push(round(w0 + (w1 - w0) * f));
    }
  }
  return { ...b, pts, w };
}
BONES.splice(0, BONES.length, ...BONES.map(bowed));
// (the finer frame runs on a little past each end, under the main frame and the rim, so it's cast into them)
// (each end taken to the nearest point of the main frame or the rim first, so none stops short of what it braces)
const frameLines = [...BONES.filter((b) => b.pts.length > 1).map((b) => b.pts), [...RIM, RIM[0]]];
const nearest = (q) => {
  let best = q, bd = Infinity, rim = false;
  for (const [li, l] of frameLines.entries()) for (let i = 0; i < l.length - 1; i++) {
    const [ax, ay] = l[i], [bx, by] = l[i + 1], dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, ((q[0] - ax) * dx + (q[1] - ay) * dy) / (dx * dx + dy * dy || 1)));
    const p = [ax + dx * t, ay + dy * t], d = Math.hypot(p[0] - q[0], p[1] - q[1]);
    if (d < bd) { bd = d; best = p; rim = li === frameLines.length - 1; }
  }
  return bd < 2.5 ? { p: best, rim } : { p: q, rim: false };
};
const reach = (b) => {
  // (on into a bone a little; never on past the rim)
  const A = nearest(b.pts[0]), Cn = nearest(b.pts[b.pts.length - 1]), a = A.p, c = Cn.p, l = Math.hypot(c[0] - a[0], c[1] - a[1]), ux = ((c[0] - a[0]) / l) * 0.35, uy = ((c[1] - a[1]) / l) * 0.35;
  const ka = A.rim ? 0 : 1, kc = Cn.rim ? 0 : 1;
  return { ...b, pts: [[round(a[0] - ux * ka), round(a[1] - uy * ka)], ...b.pts.slice(1, -1), [round(c[0] + ux * kc), round(c[1] + uy * kc)]] };
};
FINE.splice(0, FINE.length, ...FINE.map(reach).map(bowed));
/**
 * A frame cast as one plate, as the design draws it (flat.mjs's forge filter): its bars, bosses and rim rasterized on
 * a fine grid over the wing, then closed (grown and shrunk again by `closing`: every corner where two meet filled in,
 * as forged), then its outline and every hole in it traced and smoothed. `band`: a rim this wide inside the wing's
 * outline (0: none); the whole clipped to the wing shrunk by `inset`; in `voids` (polygons) nothing's filled in, only
 * the bars themselves (where the inner workings show through, or a gap wants to stay open). Plates: [{ outer, holes }]
 * (more than one if it's in pieces).
 */
function castPlate(polys, xMax, bars, discs, band, closing, inset, voids = []) {
  const G = 0.1;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const pg of polys) for (const [x, y] of pg) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  x0 -= 1; y0 -= 1; x1 += 1; y1 += 1;
  const W = Math.ceil((x1 - x0) / G), H = Math.ceil((y1 - y0) / G);
  const inPoly = (x, y, pg) => { let c = false; for (let i = 0, j = pg.length - 1; i < pg.length; j = i++) if ((pg[i][1] > y) !== (pg[j][1] > y) && x < ((pg[j][0] - pg[i][0]) * (y - pg[i][1])) / (pg[j][1] - pg[i][1]) + pg[i][0]) c = !c; return c; };
  const morph = (grid, dist, grow) => {
    const r = Math.round(dist / G), out = new Uint8Array(W * H);
    if (!r) return grid.slice();
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      let v = grid[j * W + i] === 1;
      for (let dj = -r; dj <= r && v !== grow; dj++) for (let di = -r; di <= r && v !== grow; di++) {
        if (di * di + dj * dj > r * r) continue;
        const ii = i + di, jj = j + dj, on = ii >= 0 && jj >= 0 && ii < W && jj < H && grid[jj * W + ii] === 1;
        if (grow ? on : !on) v = grow;
      }
      out[j * W + i] = v ? 1 : 0;
    }
    return out;
  };
  const wing = new Uint8Array(W * H);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) { const x = x0 + (i + 0.5) * G, y = y0 + (j + 0.5) * G; wing[j * W + i] = x <= xMax && polys.some((pg) => inPoly(x, y, pg)) ? 1 : 0; }
  const clip = morph(wing, inset, false), rimIn = band > 0 ? morph(wing, band, false) : null;
  let mask = new Uint8Array(W * H);
  if (rimIn) for (let k = 0; k < W * H; k++) mask[k] = clip[k] && !rimIn[k] ? 1 : 0;
  // the bars: each segment a capsule, its width running from one end's to the other's
  const cell = (x, y) => [Math.floor((x - x0) / G), Math.floor((y - y0) / G)];
  for (const b of bars) for (let k = 0; k < b.pts.length - 1; k++) {
    const [ax, ay] = b.pts[k], [bx, by] = b.pts[k + 1], w0 = b.w[Math.min(k, b.w.length - 1)] / 2, w1 = b.w[Math.min(k + 1, b.w.length - 1)] / 2, wm = Math.max(w0, w1);
    const [i0, j0] = cell(Math.min(ax, bx) - wm, Math.min(ay, by) - wm), [i1, j1] = cell(Math.max(ax, bx) + wm, Math.max(ay, by) + wm);
    const dx = bx - ax, dy = by - ay, ll = dx * dx + dy * dy || 1;
    for (let j = Math.max(0, j0); j <= Math.min(H - 1, j1); j++) for (let i = Math.max(0, i0); i <= Math.min(W - 1, i1); i++) {
      const x = x0 + (i + 0.5) * G, y = y0 + (j + 0.5) * G, t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / ll));
      if (Math.hypot(x - ax - dx * t, y - ay - dy * t) <= w0 + (w1 - w0) * t) mask[j * W + i] = 1;
    }
  }
  for (const [c, r] of discs) {
    const [i0, j0] = cell(c[0] - r, c[1] - r), [i1, j1] = cell(c[0] + r, c[1] + r);
    for (let j = Math.max(0, j0); j <= Math.min(H - 1, j1); j++) for (let i = Math.max(0, i0); i <= Math.min(W - 1, i1); i++) {
      if (Math.hypot(x0 + (i + 0.5) * G - c[0], y0 + (j + 0.5) * G - c[1]) <= r) mask[j * W + i] = 1;
    }
  }
  for (let k = 0; k < W * H; k++) if (!clip[k]) mask[k] = 0;
  const raw = mask;
  mask = morph(morph(mask, closing, true), closing, false);
  if (voids.length) for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const x = x0 + (i + 0.5) * G, y = y0 + (j + 0.5) * G;
    if (voids.some((v) => inPoly(x, y, v))) mask[j * W + i] = raw[j * W + i];
  }
  for (let k = 0; k < W * H; k++) if (!clip[k]) mask[k] = 0;
  // Every edge of it (the shape on the right of travel), linked into loops: its outlines run one way, its holes the other
  const at = (i, j) => (i < 0 || j < 0 || i >= W || j >= H ? 0 : mask[j * W + i]);
  const key = (i, j) => j * (W + 1) + i;
  const edges = new Map();
  const edge = (i, j, di, dj) => { const k = key(i, j); if (!edges.has(k)) edges.set(k, []); edges.get(k).push({ i, j, di, dj, used: false }); };
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    if (!at(i, j)) continue;
    if (!at(i, j - 1)) edge(i, j, 1, 0);
    if (!at(i + 1, j)) edge(i + 1, j, 0, 1);
    if (!at(i, j + 1)) edge(i + 1, j + 1, -1, 0);
    if (!at(i - 1, j)) edge(i, j + 1, 0, -1);
  }
  const loops = [];
  for (const list of edges.values()) for (const e0 of list) {
    if (e0.used) continue;
    const loop = [];
    let e = e0;
    for (let guard = 0; guard < 400000 && e && !e.used; guard++) {
      e.used = true;
      loop.push([e.i, e.j]);
      const ni = e.i + e.di, nj = e.j + e.dj, next = edges.get(key(ni, nj)) ?? [];
      // (where two corners touch: turn right first, so each loop stays tight)
      const prefer = [[-e.dj, e.di], [e.di, e.dj], [e.dj, -e.di]];
      e = null;
      for (const [pi, pj] of prefer) { const f = next.find((q) => !q.used && q.di === pi && q.dj === pj); if (f) { e = f; break; } }
    }
    if (loop.length > 8) loops.push(loop);
  }
  const rdp = (q, eps) => {
    if (q.length < 3) return q;
    const [a2, b2] = [q[0], q[q.length - 1]], dx = b2[0] - a2[0], dy = b2[1] - a2[1], l = Math.hypot(dx, dy) || 1;
    let idx = 0, dmax = 0;
    for (let k = 1; k < q.length - 1; k++) { const d = Math.abs((q[k][0] - a2[0]) * dy - (q[k][1] - a2[1]) * dx) / l; if (d > dmax) { dmax = d; idx = k; } }
    return dmax > eps ? [...rdp(q.slice(0, idx + 1), eps).slice(0, -1), ...rdp(q.slice(idx), eps)] : [a2, b2];
  };
  const smooth = (loop) => {
    let pts = loop.map(([i, j]) => [x0 + i * G, y0 + j * G]);
    for (let pass = 0; pass < 3; pass++) pts = pts.map((q, k) => { const a2 = pts[(k + pts.length - 1) % pts.length], b2 = pts[(k + 1) % pts.length]; return [(a2[0] + 2 * q[0] + b2[0]) / 4, (a2[1] + 2 * q[1] + b2[1]) / 4]; });
    const half = Math.floor(pts.length / 2);
    return [...rdp(pts.slice(0, half + 1), 0.06).slice(0, -1), ...rdp([...pts.slice(half), pts[0]], 0.06).slice(0, -1)].map((q) => q.map(round));
  };
  const area = (l) => { let a2 = 0; for (let k = 0; k < l.length; k++) { const q = l[k], r = l[(k + 1) % l.length]; a2 += q[0] * r[1] - r[0] * q[1]; } return a2 / 2; };
  const rings = loops.map((l) => ({ pts: smooth(l), outer: area(l) > 0 }));
  const plates = rings.filter((r) => r.outer).map((r) => ({ outer: r.pts, holes: [] }));
  for (const h of rings.filter((r) => !r.outer)) {
    const q = h.pts[0], own = plates.find((pl) => inPoly(q[0], q[1], pl.outer));
    if (own && h.pts.length >= 3) own.holes.push(h.pts);
  }
  return plates;
}
// The main frame and the finer one beneath it, each cast whole: the main with the rim and solid bosses round the
// guns, the node and the bay (the finer frame narrower, and closed less: its corners tighter)
// (cast heavier than the bones' own widths: thick, and never past the wing's outline, which clips it)
const thick = (bars, k) => bars.map((b) => ({ ...b, w: b.w.map((v) => v * k) }));
// (left open: the gap between the spur and the rim by the leading gun, and over the drone rack)
const VOIDS = [[[-37.4, -8.0], [-33.0, -8.0], [-32.4, -0.4], [-37.4, -0.4]], [[-26.4, 8.9], [-33.4, 8.9], [-33.4, 11.6], [-26.4, 11.6]]];
const PLATES = [
  ...castPlate(wingPolys, -20.1, thick(BONES.filter((b) => b.layer === 0), 1.7), [[S_GUN, 1.9], [S_FLAK, 1.9], [S_NODE, 1.5], [S_BAY, 1.5]], 1.45, 0.75, 0.18, VOIDS).map((pl) => ({ layer: 0, ...pl })),
  ...castPlate(wingPolys, -20.1, thick(FINE.filter((b) => !(Math.abs(b.pts[0][0] + 34.6) < 0.8 && Math.abs(b.pts[0][1] + 3.4) < 0.8)), 1.9), [], 0, 0.5, 0.18, VOIDS).map((pl) => ({ layer: 1, ...pl })),
];
console.log(`skeleton: ${PLATES.map((pl) => `${pl.layer}:${pl.outer.length}/${pl.holes.length}`).join(' ')}`);
// The inner workings: conduits alongside the beams, a pump at the node, a coiled feed up into the scythe gun, a rack
// of drone pods behind the bay, a heat exchanger by the leading gun, cable bundles from the root
const PARTS = [
  { kind: 'pipe', pts: [[-20.3, -4.6], [-27.6, -8.9], [-33.4, -9.9]], w: 0.75, glow: true },
  { kind: 'pipe', pts: [[-20.3, 2.5], [-26.6, 2.6]], w: 0.85, glow: true },
  { kind: 'pipe', pts: [[-20.3, 6.8], [-27.2, 6.9]], w: 0.7, glow: true },
  { kind: 'pipe', pts: [[-30.6, 2.2], [-34.4, 3.2], [-35.2, 5.6]], w: 0.5, glow: true },
  { kind: 'drum', at: [-28.2, 3.2], r: 2.1 },
  { kind: 'coil', a: [-31.2, -6.8], b: [-33.4, -10.2], amp: 0.55, turns: 8 },
  { kind: 'rack', poly: [[-26.8, 9.3], [-32.6, 9.3], [-32.6, 11.1], [-26.8, 11.1]], pods: [0, 1].flatMap((r) => [0, 1, 2, 3].map((c) => [round(-27.5 - c * 1.45 - r * 0.72), round(9.85 + r * 0.85)])), r: 0.4 },
  { kind: 'fins', poly: [[-22.4, -8.8], [-25.4, -7.2], [-26.4, -9], [-23.4, -10.6]], n: 6 },
  ...[0, 1, 2, 3].flatMap((k) => [
    { kind: 'cable', pts: [[-20.3, 4.2 + k * 0.32], [-23.5, 4.4 + k * 0.32], [-25.8, 3.8 + k * 0.2]].map((q) => q.map(round)), w: 0.12 },
    { kind: 'cable', pts: [[-20.3, 9.6 + k * 0.32], [-24, 9.6 + k * 0.32], [-26.6, 10 + k * 0.16]].map((q) => q.map(round)), w: 0.12 },
  ]),
];
const flipPt = ([x, y]) => [round(-x), y];
const flipPart = (q) => ({ ...q, ...(q.pts ? { pts: q.pts.map(flipPt) } : {}), ...(q.poly ? { poly: q.poly.map(flipPt) } : {}), ...(q.pods ? { pods: q.pods.map(flipPt) } : {}), ...(q.at ? { at: flipPt(q.at) } : {}), ...(q.a ? { a: flipPt(q.a), b: flipPt(q.b) } : {}) });
for (const side of ['l', 'r']) {
  const m = side === 'l' ? (q) => q : flipPt, mp = side === 'l' ? (q) => q : flipPart;
  const skeleton = {
    rim: (side === 'l' ? RIM : [...RIM].reverse()).map(m), rimW: RIM_W,
    bones: [...BONES, ...FINE].map((b) => ({ ...b, pts: b.pts.map(m) })),
    plates: PLATES.map((pl) => ({ layer: pl.layer, outer: pl.outer.map(m), holes: pl.holes.map((h) => h.map(m)) })),
    parts: PARTS.map(mp),
  };
  pieces.push({ id: `pyreclast_skeleton_${side}`, polygon: (side === 'l' ? WING : [...WING].reverse()).map(m), skeleton });
  parts.push({ uid: uid++, piece: `pyreclast_skeleton_${side}`, fn: 'bone_frame', material: GLASS, x: 0, y: 0, rot: 0, flip: false });
}

// Its stages (PieceDef `stage`: an outer one must be beaten before what's under it can be hurt): 1 its carapace and
// wings (its plates, its skeletons, what's out past its body), 2 its body (its heart, beneath, is 3). The same
// split as its brain's (server/src/game/brains/pyreclast.ts SHED, body())
const CARAPACE = new Set(['scythe_plate', 'wing_plate', 'scythe_heel', 'scythe', 'scythe_root', 'wing_vein', 'wing_lead', 'rib_scythe']);
const areaCentroid = (pg) => {
  let a = 0, x = 0, y = 0;
  for (let i = 0; i < pg.length; i++) { const [x0, y0] = pg[i], [x1, y1] = pg[(i + 1) % pg.length], c = x0 * y1 - x1 * y0; a += c; x += (x0 + x1) * c; y += (y0 + y1) * c; }
  return [x / (3 * a), y / (3 * a)];
};
for (const p of pieces) {
  const name = p.id.replace(/^pyreclast_/, '');
  p.stage = p.skeleton || CARAPACE.has(name.replace(/_[lr]$/, '')) || Math.abs(areaCentroid(p.polygon)[0]) > 20.3 ? 1 : 2;
  // (its body isn't shot off piece by piece: worn out, each piece is left a wreck until it blows the lot away)
  if (p.stage === 2) p.ruin = true;
}
const pieceFile = { _comment: 'The Pyreclast\'s own hull (bosses.json boss_pyreclast). Written by scripts/bespoke/pyreclast.mjs: edit that, not this.', pieces };
// Its heart (its third stage) beneath everything, drawn first, there from the start: scripts/bespoke/pyreclast_heart.mjs
const heart = JSON.parse(readFileSync(join(root, 'data/ships/blueprints/enemy/pyreclast_heart.json'), 'utf8')).parts;
const all = [...heart, ...parts].map((q, k) => ({ ...q, uid: k }));
// (rigid: it flies as built throughout, its hull drawn once: Blueprint `rigid`)
const design = { name: 'Pyreclast', catalogVersion: 1, paint: '#2a201c', rigid: true, parts: all };
mkdirSync(join(root, 'data/ships/bespoke'), { recursive: true });
writeFileSync(join(root, 'data/ships/bespoke/pyreclast.json'), JSON.stringify(pieceFile, null, 1) + '\n');
writeFileSync(join(root, 'data/ships/blueprints/enemy/pyreclast.json'), JSON.stringify(design, null, 1) + '\n');
console.log(`${pieces.length} pieces, ${all.length} parts (${heart.length} of its heart)`);

// A quick look (optional): every part's outline, coloured by function
const out = process.argv[2];
if (out) {
  const colors = { molten_plate: '#7a4a3a', core: '#dfe6f5', generator: '#f5a83a', conduit: '#ff7a2a', armor: '#6b7280', hull: '#3a4660', weapon: '#e05a4a', flak: '#c86a2a', magma_cannon: '#ff7a2a', plasma_drive: '#9b6ad8', dash_coil: '#ffb15a', brood_bay: '#c84a2a', pyre_lance: '#ff3a12', magma_mortar: '#ffd040', heat_vent: '#ff5a5a' };
  const s = 14;
  const paths = pieces.map((p, i) => `<polygon points="${p.polygon.map(([x, y]) => `${x * s},${y * s}`).join(' ')}" fill="${colors[parts[i].fn] ?? '#888'}" stroke="#111" stroke-width="1.2"/>`
    + (p.mount ? `<line x1="${p.mount.at[0] * s}" y1="${p.mount.at[1] * s}" x2="${(p.mount.at[0] + p.mount.dir[0] * 2) * s}" y2="${(p.mount.at[1] + p.mount.dir[1] * 2) * s}" stroke="#0f0" stroke-width="2"/>` : ''));
  writeFileSync(out, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-44 * s} ${-38 * s} ${88 * s} ${66 * s}" style="background:#0b0f16">${paths.join('')}</svg>`);
}
