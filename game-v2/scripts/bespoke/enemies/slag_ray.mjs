/**
 * Slag Ray (ash and lava creature of the Pyreclast's cavern, new). DESIGN ONLY: docs/enemies/custom-roster.md.
 * A manta of cooled crust: two broad swept wings of obsidian scaled with ash, cracked with lava; a thick ridged body
 * over a molten heart, gill slits glowing down its back; two curled horns either side of an ember mouth; a long whip
 * tail dripping slag.
 *   skirmisher / area denial: it sweeps past in long arcs, spitting embers ahead and laying a burning slag wake.
 *   node scripts/bespoke/enemies/slag_ray.mjs
 */
import { design, mid, bar, oval, smooth, limb, curve, inset, glow, ring, raise, recess, vein, shard } from './kit.mjs';

const GLASS = 'pyre_glass', DARK = 'leestone';
const EMBER = '#ff7a2a', HOT = '#ffc46a', ASH = '#4a403a', ASH2 = '#5c5048', SOOT = '#1c1816', PIT = '#140a06';

const d = design('slag_ray', {
  name: 'Slag Ray', faction: 'cinder', sky: 'ashfall_cavern',
  role: 'skirmisher / area denial', level: '26-32', threat: 'medium',
});

// The tail: a long whip, a lava seam down it, the slag spout at its tip
const tailPath = curve([0, 2.4], [1.5, 6.6], [-0.7, 10.6], 8);
d.part('tail', 'heat_vent', DARK, limb(tailPath, [0.8, 0.68, 0.56, 0.46, 0.37, 0.29, 0.22, 0.16, 0.1]), {
  group: 'tail', relief: 'round', mount: { at: [-0.7, 10.6], dir: [-0.3, 1], width: 0.5 },
  detail: [vein(tailPath.slice(1), 0.14, EMBER), glow([-0.66, 10.4], 0.3, EMBER), ...[2, 4, 6].map((k) => ring(tailPath[k], 0.42 - k * 0.04, 0.12, ASH))],
});
// The wings: broad, swept, pointed; three scales of ash overlapping down each, lava in the cracks between
const wing = [[-1.0, -2.5], [-2.6, -2.5], [-4.4, -1.7], [-6.2, -0.2], [-7.9, 1.6], [-6.6, 1.8], [-5.0, 2.0], [-3.7, 2.5], [-2.5, 3.4], [-1.0, 3.0]];
const scale = (a0, a1, b1, b0) => [a0, a1, b1, b0];
const wingDetail = [
  raise(scale([-1.6, -2.1], [-4.3, -1.3], [-4.6, -0.2], [-1.7, -0.3]), ASH2),
  raise(scale([-1.7, 0.0], [-4.7, 0.1], [-5.8, 0.9], [-1.8, 1.4]), ASH),
  raise(scale([-1.9, 1.7], [-4.6, 1.5], [-3.6, 2.2], [-2.0, 2.7]), SOOT),
  raise([[-4.6, -1.2], [-6.2, 0.0], [-7.3, 1.4], [-5.9, 0.7]], ASH),
  vein([[-1.5, -0.15], [-3.2, -0.25], [-4.7, -0.05], [-6.4, 0.7], [-7.5, 1.5]], 0.2, EMBER),
  vein([[-1.6, 1.55], [-3.3, 1.4], [-5.2, 1.3]], 0.15, EMBER),
  vein([[-4.5, -0.9], [-5.6, 0.4]], 0.07, HOT),
  shard([-6.2, 0.35], [-1, 0.55], 0.7, 0.26, '#6a5a50'), shard([-4.3, -1.25], [-1, -0.3], 0.55, 0.22, '#6a5a50'),
];
d.pair('wing', 'armor', GLASS, wing, { relief: 'plate', detail: wingDetail });
// The horns: curled lobes either side of its mouth (the ember spitter between them)
const horn = curve([-0.8, -2.5], [-2.5, -3.6], [-1.3, -5.4], 6);
d.pair('horn', 'hull', DARK, limb(horn, [0.55, 0.56, 0.5, 0.42, 0.32, 0.2, 0.06]), {
  group: 'horns', shared: true, relief: 'ridge',
  detail: [vein([[-1.0, -2.7], [-1.9, -3.5], [-1.7, -4.6]], 0.07, EMBER)],
});
// The body: a thick ridged lozenge of dark crust, its mouth a glowing slit, gill slits down its back
const body = smooth([[0, -3.4], [-1.25, -2.8], [-1.8, -0.8], [-1.65, 1.6], [-0.95, 3.2], [0, 3.7], [0.95, 3.2], [1.65, 1.6], [1.8, -0.8], [1.25, -2.8]], 1);
d.part('body', 'armor', DARK, body, {
  group: 'core', relief: 'round',
  detail: [
    recess([[-0.8, -3.05], [0.8, -3.05], [0.5, -2.7], [-0.5, -2.7]], PIT), glow([0, -2.88], 0.3, EMBER),
    raise([[-0.55, -2.35], [0.55, -2.35], [0.75, -1.45], [-0.75, -1.45]], ASH),
    raise([[-1.3, -1.6], [-0.9, -1.25], [-1.0, 0.6], [-1.5, 0.4]], ASH2), raise([[1.3, -1.6], [0.9, -1.25], [1.0, 0.6], [1.5, 0.4]], ASH2),
    vein([[0, -2.5], [0, -1.2]], 0.1, EMBER),
    ...[1.0, 1.55, 2.1].flatMap((y) => [recess(bar([-1.35, y], [-0.55, y + 0.12], 0.16), PIT), recess(bar([1.35, y], [0.55, y + 0.12], 0.16), PIT), vein([[-1.25, y], [-0.65, y + 0.1]], 0.06, EMBER), vein([[1.25, y], [0.65, y + 0.1]], 0.06, EMBER)]),
    raise([[-0.35, 2.5], [0.35, 2.5], [0.25, 3.3], [-0.25, 3.3]], ASH),
  ],
});
// The heart: molten glass seen through a crack in its back (the core)
const heart = oval([0, -0.4], 0.95, 0.62, [0, -1], 12);
d.part('heart', 'core', GLASS, heart, {
  group: 'core', relief: 'recess',
  detail: [recess(inset(heart, 0.99), '#2a1a12'), recess(inset(heart, 0.8), PIT), glow([0, -0.4], 0.6, EMBER), glow([0, -0.4], 0.25, HOT), vein([[-0.5, -0.5], [0, -0.3], [0.45, -0.55]], 0.06, HOT)],
});

d.write({ damaged: ['wing_r', 'tail'], scale: 0.62 });
