/**
 * Rime Bell (Frost Brood, replaces the grid frost_shard). DESIGN ONLY: docs/enemies/custom-roster.md.
 * A drifting creature of ice: a faceted bell of rime, a violet gland glowing under it, a membrane frill round its
 * back edge, three crystal tendrils trailing.
 *   swarmer / support: they come in threes; each bell's frill pulses an EMP ring, its tendrils shed ice splinters.
 *   node scripts/bespoke/enemies/rime_bell.mjs
 */
import { design, P, D, mid, round, ringPts, smooth, limb, curve, inset, glow, ring, raise, recess, channel, vein, shard, band } from './kit.mjs';

const ICE = 'brood_ice', RIME = 'brood_rime', MEMB = 'brood_membrane', GLAND = 'brood_gland', SHELL = 'brood_shell';
const VIOLET = '#c48cff', PALE = '#e6f2ff', FROST = '#a8d4f0', DEEP = '#1b1830';

const d = design('rime_bell', {
  name: 'Rime Bell', faction: 'frost', sky: 'borealis', replaces: 'frost_shard',
  role: 'swarmer / support', level: '6-9', threat: 'low',
});

const C = [0, -0.8];
// The tendrils: three crystal whips trailing, ice splinters along them
const TENDRILS = [
  ['tendril_l', curve([-1.2, 1.0], [-2.6, 4.0], [-1.6, 7.0], 6)],
  ['tendril_c', curve([0, 1.4], [0.9, 4.6], [-0.2, 8.4], 6)],
  ['tendril_r', curve([1.2, 1.0], [2.8, 3.6], [2.2, 6.4], 6)],
];
for (const [name, path] of TENDRILS) {
  d.part(name, 'flak', RIME, limb(path, [0.42, 0.4, 0.34, 0.28, 0.22, 0.14, 0.06]), {
    relief: 'ridge',
    detail: [vein(path, 0.08, VIOLET), ...[2, 4].map((k) => shard(path[k], [path[k + 1][0] - path[k - 1][0] + (k === 2 ? 0.8 : -0.8), path[k + 1][1] - path[k - 1][1]], 0.7, 0.24, PALE))],
  });
}
// The frill: a membrane skirt round its back edge, scalloped (its EMP organ)
const frill = [];
for (let k = 0; k <= 16; k++) { const a = 100 + (160 * k) / 16; frill.push(P(3.05 + (k % 2 ? 0.45 : 0), a, C)); }
for (let k = 16; k >= 0; k--) frill.push(P(2.0, 100 + (160 * k) / 16, C));
d.part('frill', 'emp', MEMB, frill, {
  relief: 'round',
  detail: [...[120, 150, 180, 210, 240].map((a) => vein([P(2.15, a, C), P(3.05, a, C)], 0.07, VIOLET))],
});
// The bell: a faceted cap of rime, ridges of clear ice radiating from its crown
const bell = smooth(ringPts(C, 2.6, 10, -Math.PI / 2).map((q, k) => mid(C, q, k % 2 ? 0.94 : 1)), 1);
d.part('bell', 'armor', ICE, bell, {
  group: 'core', relief: 'round',
  detail: [
    ...[0, 72, 144, 216, 288].map((a) => raise([P(0.9, a - 22, C), P(2.3, a - 14, C), P(2.3, a + 14, C), P(0.9, a + 22, C)], '#7d9cb6')),
    ...[36, 108, 180, 252, 324].map((a) => channel([P(1.0, a - 3, C), P(2.25, a - 2, C), P(2.25, a + 2, C), P(1.0, a + 3, C)], VIOLET)),
    ...[0, 72, 144, 216, 288].map((a) => shard(P(2.2, a, C), D(a), 0.6, 0.26, PALE)),
  ],
});
// The gland: violet light at its crown (the core)
d.part('gland', 'core', GLAND, ringPts(C, 0.95, 8, Math.PI / 8), {
  group: 'core', relief: 'recess',
  detail: [recess(ringPts(C, 0.62, 8, Math.PI / 8), DEEP), glow(C, 0.55, VIOLET), glow(C, 0.22, PALE)],
});

d.write({ damaged: ['frill', 'tendril_r'], scale: 0.5 });
