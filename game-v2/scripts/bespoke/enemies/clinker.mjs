/**
 * Clinker (ash and lava creature of the Pyreclast's cavern, new). DESIGN ONLY: docs/enemies/custom-roster.md.
 * A lump of cooled slag that crawls: five crust plates domed over a pool of magma (lava glows in the cracks between
 * them, and floods out where one comes off), a vent at its crown, two chimneys at its back that lob magma, a blunt
 * beak of crust forward.
 *   tank / artillery: it sits in a lane and lobs magma over the rock; its crust soaks fire until a plate comes off.
 *   node scripts/bespoke/enemies/clinker.mjs
 */
import { design, P, D, round, mid, bar, ringPts, inset, centroid, glow, ring, raise, recess, vein, shard } from './kit.mjs';

const GLASS = 'pyre_glass', DARK = 'leestone';
const EMBER = '#ff7a2a', HOT = '#ffc46a', ASH = '#4a403a', ASH2 = '#5c5048', SOOT = '#1f1a18', PIT = '#140a06';

const d = design('clinker', {
  name: 'Clinker', faction: 'cinder', sky: 'ashfall_cavern',
  role: 'tank / artillery', level: '26-32', threat: 'high',
});

const C = [0, 0.3], SY = 1.12;
/** Crust's roughness: a fixed wobble by place */
const rough = (r, deg, amp = 0.38) => r + amp * (Math.sin(deg * 0.29 + r * 1.3) * 0.6 + Math.sin(deg * 0.13 - r * 0.7) * 0.4);
const pt = (r, a) => { const p = P(r, a); return [round(C[0] + p[0]), round(C[1] + p[1] * SY)]; };
/** A crust band a0..a1 degrees, inner radius r0, outer r1 (rough), stretched along y */
const crustBand = (r0, r1, a0, a1, n = 6) => [
  ...Array.from({ length: n + 1 }, (_, k) => { const a = a0 + ((a1 - a0) * k) / n; return pt(rough(r1, a), a); }),
  ...Array.from({ length: n + 1 }, (_, k) => pt(r0, a1 - ((a1 - a0) * k) / n)),
];

// The magma beneath the crust (with the vent, its core body): seen in the cracks, flooding out where a plate goes
const magma = Array.from({ length: 20 }, (_, k) => pt(3.7, k * 18));
d.part('magma', 'armor', GLASS, magma, {
  group: 'core', relief: 'recess', under: true,
  detail: [glow(C, 3.2, EMBER), glow(C, 1.8, HOT), ...[0, 72, 144, 216, 288].map((a) => vein([pt(1.2, a + 36), pt(2.4, a + 30), pt(3.5, a + 38)], 0.16, HOT))],
});
// The crust: five plates domed over the magma, a hair apart (lava shows between them)
const PLATES = [[-33, 33, GLASS], [39, 105, DARK], [111, 177, GLASS], [183, 249, DARK], [255, 321, GLASS]];
PLATES.forEach(([a0, a1, mat], k) => {
  const pg = crustBand(1.3, 4.05, a0, a1, 6);
  const am = (a0 + a1) / 2, c = centroid(pg);
  const top = [pt(1.75, a0 + 7), pt(rough(3.55, a0 + 9), a0 + 9), pt(rough(3.65, am), am), pt(rough(3.55, a1 - 9), a1 - 9), pt(1.75, a1 - 7)];
  d.part(`plate${k}`, 'armor', mat, pg, {
    group: `plate${k}`, relief: 'plate',
    detail: [
      raise([pt(1.8, a0 + 8), pt(rough(3.4, a0 + 10), a0 + 10), pt(rough(3.5, am - 4), am - 4), pt(2.5, am + 2), pt(1.9, am - 2)], k % 2 ? ASH : ASH2),
      raise([pt(2.7, am + 6), pt(rough(3.45, am + 10), am + 10), pt(rough(3.4, a1 - 10), a1 - 10), pt(2.2, a1 - 8)], k % 2 ? SOOT : ASH),
      vein([pt(1.5, am - 5), pt(2.4, am + 6), pt(3.2, am - 4)], 0.1, EMBER),
      shard(mid(c, pt(4.0, am + 16), 0.7), D(am + 16), 0.75, 0.32, '#6a5a50'),
    ],
  });
});
// The chimneys: two stacks standing up out of its back plates, banded, their bores glowing (the mortars)
for (const [side, sx] of [['l', -1], ['r', 1]]) {
  const c = [sx * 1.75, 2.75];
  d.part(`chimney_${side}`, 'magma_mortar', DARK, ringPts(c, 0.95, 10, 0.3), {
    group: `chimney_${side}`, relief: 'round', mount: { at: [c[0] + sx * 0.3, c[1] + 0.9], dir: [sx * 0.35, 1], width: 0.9 },
    detail: [ring(c, 0.8, 0.2, ASH2), ring(c, 0.56, 0.1, SOOT), recess(ringPts(c, 0.5, 10), PIT), glow(c, 0.42, EMBER), glow(c, 0.16, HOT)],
  });
}
// The vent: lava welling up at its crown (the core), crusted glass round it
const vent = ringPts(C, 1.45, 9, 0.2).map((q, k) => [round(q[0] + 0.07 * Math.sin(k * 2.3)), round(q[1] + 0.07 * Math.cos(k * 1.7))]);
d.part('vent', 'core', GLASS, vent, {
  group: 'core', relief: 'recess',
  detail: [recess(inset(vent, 0.99), '#2a1a12'), ring(C, 1.2, 0.25, ASH2), recess(inset(vent, 0.7), PIT), glow(C, 0.8, EMBER), glow(C, 0.34, HOT), vein([P(0.9, 30, C), P(0.35, 80, C), P(0.25, 170, C), P(0.7, 220, C)], 0.06, HOT)],
});
// The beak: a blunt wedge of crust over the front plate
d.part('beak', 'armor', DARK, [[-1.2, -3.5], [-0.4, -4.95], [0.4, -4.95], [1.2, -3.5], [0.6, -2.5], [-0.6, -2.5]], {
  group: 'plate0', relief: 'ridge', detail: [raise([[-0.55, -3.4], [-0.2, -4.4], [0.2, -4.4], [0.55, -3.4], [0.3, -2.9], [-0.3, -2.9]], SOOT), vein([[0, -2.8], [0, -4.3]], 0.07, EMBER)],
});

d.write({ damaged: ['plate1', 'plate4', 'chimney_r'], scale: 0.95 });
