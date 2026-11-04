/**
 * Scrap Crawler (Scrapborn, replaces the grid scrap_crawler). DESIGN ONLY: docs/enemies/custom-roster.md.
 * A salvage crab: a riveted carapace of two mismatched plates over a spine, a greyseam lamp in its back, an
 * electromagnet between two crusher claws, two hind legs braced out, one worn drive.
 *   puller / brawler: the magnet drags you in, the claws snap shut ahead of it.
 *   node scripts/bespoke/enemies/scrap_crawler.mjs
 */
import { design, mirror, mirrorDetail, mid, bar, ringPts, oval, limb, curve, inset, rivet, rivets, glow, halo, ring, raise, recess, channel, stripes, dent, bell } from './kit.mjs';

const IRON = 'scrap_iron', RUST = 'scrap_rust', PAINT = 'scrap_paint', STEEL = 'scrap_steel', SEAM = 'scrap_seam';
const SEAMGLOW = '#7affd2', HAZ = '#c9a23a', DARK = '#202226', COPPER = '#b0702a';

const d = design('scrap_crawler', {
  name: 'Scrap Crawler', faction: 'scrapborn', sky: 'sol_scrap_nest', replaces: 'scrap_crawler',
  role: 'puller / brawler', level: '3-6', threat: 'medium',
});

// The hind legs (under the shell): a thigh out and a shin bent back, a foot pad
const legPath = [[-0.8, 1.0], [-2.4, 1.3], [-4.3, 1.9], [-5.6, 3.6], [-5.4, 5.4]];
d.pair('leg', 'hull', STEEL, limb(legPath, [0.5, 0.55, 0.5, 0.42, 0.22]), {
  group: 'legs', shared: true, relief: 'round',
  detail: [ring([-4.3, 1.9], 0.42, 0.16, HAZ), ...stripes([-4.6, 2.3], [-5.5, 4.2], 0.45, 3, HAZ, DARK)],
});
// The spine: under the shell, the lamp sits in it
const spine = [[-0.95, -2.7], [0.95, -2.7], [1.0, 3.5], [-1.0, 3.5]];
d.part('spine', 'hull', IRON, spine, {
  group: 'core',
  detail: [channel(bar([0, -2.3], [0, -0.3], 0.2), SEAMGLOW), ...[2.2, 2.75, 3.3].map((y) => raise([[-0.8, y - 0.2], [0.8, y - 0.2], [0.8, y + 0.15], [-0.8, y + 0.15]], '#55585e')), ...rivets([-0.72, -2.4], [-0.72, -0.4], 3, 0.11), ...rivets([0.72, -2.4], [0.72, -0.4], 3, 0.11)],
});
// The carapace: two mismatched plates, rust on the left, faded paint on the right
const shell = [[-0.9, -2.55], [-1.7, -2.6], [-2.85, -1.7], [-3.35, 0.1], [-3.1, 1.9], [-2.1, 3.0], [-0.9, 3.35]];
const shellDetail = (pg, k) => [
  raise(inset(pg, 0.72), k ? '#4d5a44' : '#5a3a2a'),
  ...rivets(mid(pg[1], pg[2], 0.1), mid(pg[3], pg[4], 0.2), 4),
  dent(mid(pg[4], [-1.8, 0.4], 0.5), 0.45, 1.3 + k, k ? undefined : '#3d2318'),
  channel(bar([-1.2, -0.4], [-2.8, 0.3], 0.18), SEAMGLOW),
];
d.part('shell_l', 'armor', RUST, shell, { group: 'shell_l', relief: 'plate', detail: shellDetail(shell, 0) });
d.part('shell_r', 'armor', PAINT, mirror(shell), { group: 'shell_r', relief: 'plate', detail: shellDetail(shell, 1).map(mirrorDetail) });
// The lamp: greyseam glowing through a hex bezel in its back (the core)
d.part('lamp', 'core', SEAM, ringPts([0, 0.9], 1.05, 6, Math.PI / 6), {
  group: 'core', relief: 'recess',
  detail: [ring([0, 0.9], 0.85, 0.22, '#9a9ea4', 6), glow([0, 0.9], 0.62, SEAMGLOW, 6)],
});
// The claws: an arm out from the shell's shoulder, a crusher finger curling in, a short fixed finger inside it
const arm = [[-0.8, -1.8], ...curve([-2.0, -1.9], [-3.9, -2.4], [-3.5, -4.4], 4)];
d.pair('arm', 'hull', STEEL, limb(arm, [0.5, 0.62, 0.6, 0.55, 0.52, 0.5]), {
  group: 'claw', relief: 'round',
  detail: [ring([-2.3, -2.0], 0.4, 0.14, HAZ), ...stripes([-3.3, -2.4], [-3.6, -3.7], 0.6, 3, HAZ, DARK)],
});
// (the palm and its fixed finger in one plate; the crushing finger hinged on the outside of it)
const palm = [[-3.55, -3.9], [-3.55, -4.7], [-3.2, -5.6], [-2.6, -6.4], [-1.7, -6.9]];
d.pair('pincer', 'armor', RUST, limb(palm, [0.75, 1.0, 0.85, 0.5, 0.2, 0.05].slice(0, palm.length)), {
  group: 'claw', relief: 'plate',
  detail: [rivet([-3.55, -4.5], 0.18), rivet([-3.3, -5.3], 0.15), raise(bar([-3.0, -5.4], [-2.1, -6.4], 0.16), '#a6a9ae'), dent([-3.8, -4.7], 0.3, 2.2, '#3d2318')],
});
const finger = curve([-4.2, -5.0], [-4.6, -7.2], [-2.5, -8.0], 5);
d.pair('finger', 'armor', STEEL, limb(finger, [0.45, 0.5, 0.42, 0.3, 0.18, 0.04]), {
  group: 'claw', relief: 'ridge',
  detail: [ring([-4.2, -5.1], 0.32, 0.12, HAZ)],
});
// The magnet: a copper-wound disc between the claws (the puller)
d.part('magnet', 'conduit', STEEL, ringPts([0, -3.45], 1.2, 14), {
  group: 'magnet', relief: 'round',
  detail: [ring([0, -3.45], 1.0, 0.24, '#6e7277'), ring([0, -3.45], 0.7, 0.2, COPPER), recess(ringPts([0, -3.45], 0.48, 10)), glow([0, -3.45], 0.36, SEAMGLOW)],
});
// The drive: one worn plasma drive, a stack either side of it
d.part('drive', 'plasma_drive', STEEL, [[-0.95, 3.3], [0.95, 3.3], [1.15, 5.0], [-1.15, 5.0]], {
  group: 'drive', relief: 'round', mount: { at: [0, 5.0], dir: [0, 1], width: 1.8 },
  detail: [bell([0, 5.0], [0, 1], 1.7, 1.2), ...stripes([-0.85, 3.6], [0.85, 3.6], 0.35, 4, HAZ, DARK)],
});

d.write({ damaged: ['claw_l', 'shell_r', 'magnet'], scale: 0.72 });
