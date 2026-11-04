/**
 * Clinker (ash and lava creature of the Pyreclast's cavern, new). DESIGN ONLY: docs/enemies/custom-roster.md.
 * A tortoise of cooled slag: an oval shell of four crust plates (a beaked front, a back with two chimneys, a left and a
 * right) around a lava vent at its crown, a rim of darker crust round it all. The plates part along its diagonals, so
 * the magma under the shell shows as a glowing X; where a plate comes off, the magma floods out.
 *   tank / artillery: it sits in a lane and lobs magma over the rock; its crust soaks fire until a plate comes off.
 *   node scripts/bespoke/enemies/clinker.mjs
 */
import { design, P, round, mid, ringPts, glow, ring, raise, recess, vein, shard } from './kit.mjs';

const CRUST = 'leestone', GLASS = 'pyre_glass';
const EMBER = '#ff7a2a', HOT = '#ffc46a', ASH = '#4f453f', ASH2 = '#625650', SOOT = '#221d1b', PIT = '#140a06';

const d = design('clinker', {
  name: 'Clinker', faction: 'cinder', sky: 'ashfall_cavern',
  role: 'tank / artillery', level: '26-32', threat: 'high',
});

const C = [0, 0.4], SY = 1.2;
/** A point on the shell's oval, `r` out at `a` degrees */
const pt = (r, a) => { const p = P(r, a); return [round(C[0] + p[0]), round(C[1] + p[1] * SY)]; };
/** A band of the shell from a0 to a1 degrees, between radii r0 and r1 */
const shellBand = (r0, r1, a0, a1, n = 8) => [
  ...Array.from({ length: n + 1 }, (_, k) => pt(r1, a0 + ((a1 - a0) * k) / n)),
  ...Array.from({ length: n + 1 }, (_, k) => pt(r0, a1 - ((a1 - a0) * k) / n)),
];
const R0 = 1.5, R1 = 3.9, GAP = 7;

// The magma under the shell (with the vent, its core body: covered, hits on it go to the plate over it)
d.part('magma', 'armor', GLASS, Array.from({ length: 24 }, (_, k) => pt(R1 - 0.1, k * 15)), {
  group: 'core', relief: 'recess', under: true,
  detail: [glow(C, 3.3, EMBER), glow(C, 2.0, HOT), ...[45, 135, 225, 315].map((a) => vein([pt(R0, a), pt(2.6, a + 3), pt(R1 - 0.3, a - 2)], 0.3, HOT))],
});
// The plates: front (with the beak), right, back (with the chimneys), left; each a raised scute in a bevelled frame,
// two growth ridges across it, one crack of lava down its middle
const PLATES = [['front', -45, 45], ['right', 45, 135], ['back', 135, 225], ['left', 225, 315]];
for (const [name, a0, a1] of PLATES) {
  const b0 = a0 + GAP / 2, b1 = a1 - GAP / 2, am = (a0 + a1) / 2;
  d.part(`plate_${name}`, 'armor', CRUST, shellBand(R0, R1, b0, b1), {
    group: `plate_${name}`, relief: 'plate',
    detail: [
      raise(shellBand(R0 + 0.35, R1 - 0.45, b0 + 5, b1 - 5, 6), ASH),
      raise(shellBand(2.2, 2.45, b0 + 9, b1 - 9, 6), SOOT),
      raise(shellBand(2.95, 3.2, b0 + 8, b1 - 8, 6), SOOT),
      vein([pt(R0 + 0.3, am), pt(2.3, am + 2), pt(3.3, am - 1)], 0.12, EMBER),
    ],
  });
}
// The rim: a darker skirt round the shell's edge, in four lengths (one with each plate)
for (const [name, a0, a1] of PLATES) {
  d.part(`rim_${name}`, 'armor', GLASS, shellBand(R1 - 0.2, R1 + 0.55, a0 + GAP / 2, a1 - GAP / 2, 10), {
    group: `plate_${name}`, relief: 'round', detail: [raise(shellBand(R1 + 0.05, R1 + 0.35, a0 + GAP / 2 + 3, a1 - GAP / 2 - 3, 10), SOOT)],
  });
}
// The beak: a blunt wedge on the front plate
d.part('beak', 'armor', CRUST, [[-1.0, -4.3], [-0.35, -5.6], [0.35, -5.6], [1.0, -4.3], [0.5, -3.4], [-0.5, -3.4]], {
  group: 'plate_front', relief: 'ridge', detail: [raise([[-0.45, -4.25], [-0.15, -5.1], [0.15, -5.1], [0.45, -4.25], [0.25, -3.8], [-0.25, -3.8]], ASH2), vein([[0, -3.7], [0, -5.0]], 0.08, EMBER)],
});
// The chimneys: two stacks on the back plate, banded, their bores glowing (the mortars)
for (const [side, sx] of [['l', -1], ['r', 1]]) {
  const c = pt(2.7, 180 - sx * 24);
  d.part(`chimney_${side}`, 'magma_mortar', CRUST, ringPts(c, 0.95, 12, 0.3), {
    group: `chimney_${side}`, relief: 'round', mount: { at: [c[0], c[1] + 0.95], dir: [sx * 0.3, 1], width: 0.9 },
    detail: [ring(c, 0.8, 0.22, ASH2), recess(ringPts(c, 0.55, 12), PIT), glow(c, 0.45, EMBER), glow(c, 0.18, HOT)],
  });
}
// The vent: lava welling up at its crown (the core), a collar of crust round it
const vent = ringPts(C, R0 + 0.15, 12, 0.13);
d.part('vent', 'core', GLASS, vent, {
  group: 'core', relief: 'recess',
  detail: [recess(ringPts(C, R0 + 0.12, 12, 0.13), '#2a1a12'), ring(C, 1.3, 0.28, ASH2), recess(ringPts(C, 1.0, 12), PIT), glow(C, 0.85, EMBER), glow(C, 0.36, HOT), shard([-0.15, 0.2], [0.3, -1], 0.5, 0.2, HOT)],
});

d.write({ damaged: ['plate_left', 'chimney_r'], scale: 0.7 });
