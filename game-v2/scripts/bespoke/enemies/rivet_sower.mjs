/**
 * Rivet Sower (Scrapborn, new). DESIGN ONLY: docs/enemies/custom-roster.md.
 * A long salvage beetle that sows greyseam-lit rivet mines: a revolving drum magazine at its tail, two panniers of
 * spare mines slung either side, two long sensor whiskers forward, two small drives.
 *   mine layer: it flies ahead of you and drops mines across your line, then turns away.
 *   node scripts/bespoke/enemies/rivet_sower.mjs
 */
import { design, mid, bar, ringPts, limb, curve, inset, rivet, rivets, glow, halo, ring, raise, recess, channel, stripes, dent, bell } from './kit.mjs';

const IRON = 'scrap_iron', RUST = 'scrap_rust', PAINT = 'scrap_paint', STEEL = 'scrap_steel', SEAM = 'scrap_seam';
// (greyseam's green kept to the Scrap Mother's own, but its mines lit unevenly, some dead; amber work lamps; grime)
const SEAMGLOW = '#7affd2', SEAMDIM = '#3f9a78', AMBER = '#ffa53a', GRIME = '#2a2620', HAZ = '#c9a23a', DARK = '#202226';

const d = design('rivet_sower', {
  name: 'Rivet Sower', faction: 'scrapborn', sky: 'sol_scrap_nest',
  role: 'mine layer', level: '4-7', threat: 'medium',
});

/** A gear: `teeth` teeth between radii r0 and r1 */
const gear = (c, r0, r1, teeth) => Array.from({ length: teeth * 4 }, (_, k) => {
  const a = (k / (teeth * 4)) * Math.PI * 2, r = k % 4 === 1 || k % 4 === 2 ? r1 : r0;
  return [c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r];
});
/** A rivet mine as drawn racked: a steel cap and its greyseam light */
let mines = 0;
const mine = (at, r = 0.36) => { const k = mines++ % 5; return [ring(at, r, r * 0.38, '#7a7268', 8), ...(k === 3 ? [recess(ringPts(at, r * 0.5, 8), GRIME)] : [glow(at, r * (k === 1 ? 0.3 : 0.45), k === 1 ? SEAMDIM : SEAMGLOW)])]; };

// The whiskers: long sensor feelers forward, a lit bulb at each tip
d.pair('whisker', 'scanner', STEEL, limb([[-0.35, -3.2], ...curve([-0.7, -3.9], [-2.1, -5.6], [-2.4, -8.0], 5)], [0.3, 0.26, 0.22, 0.18, 0.14, 0.12, 0.1]), {
  group: 'sensors', shared: true, relief: 'round',
  detail: [glow([-2.4, -7.9], 0.24, AMBER), ring([-0.9, -4.2], 0.24, 0.09, HAZ)],
});
// The body: a long riveted shell, a spine plate down it
const body = [[0, -4.3], [-0.95, -3.95], [-1.65, -2.7], [-1.95, -0.6], [-1.85, 1.4], [-1.25, 2.5], [0, 2.75], [1.25, 2.5], [1.85, 1.4], [1.95, -0.6], [1.65, -2.7], [0.95, -3.95]];
d.part('body', 'hull', IRON, body, {
  group: 'core',
  detail: [
    raise([[-0.75, -3.4], [0.75, -3.4], [1.1, 2.0], [-1.1, 2.0]], '#4a4e55'),
    ...rivets([-1.45, -2.4], [-1.65, 1.3], 5, 0.12), ...rivets([1.45, -2.4], [1.65, 1.3], 5, 0.12),
    recess(bar([0, -0.6], [0, 1.8], 0.3), GRIME), glow([0, 0.4], 0.12, SEAMDIM), dent([-1.1, 0.9], 0.3, 2.2, GRIME),
    dent([1.2, 0.6], 0.35, 4.1),
  ],
});
// The lamp, forward in the shell (its core)
d.part('lamp', 'core', SEAM, ringPts([0, -2.2], 0.78, 6, Math.PI / 6), {
  group: 'core', relief: 'recess',
  detail: [ring([0, -2.2], 0.62, 0.18, '#9a9ea4', 6), recess(ringPts([0, -2.2], 0.45, 6, Math.PI / 6), GRIME), glow([0, -2.2], 0.3, SEAMGLOW, 6)],
});
// The panniers: racks of spare mines slung either side (rust on one, paint on the other)
const pan = [[-1.75, -2.2], [-3.2, -1.95], [-3.65, -0.4], [-3.55, 1.25], [-3.05, 1.95], [-1.8, 1.7]];
const panDetail = [recess(inset(pan, 0.8)), ...[-1.25, -0.15, 0.95].flatMap((y) => [...mine([-2.35, y]), ...mine([-3.05, y + 0.1], 0.3)]), ...rivets(pan[1], pan[2], 2, 0.13)];
d.pair('pannier', 'cargo', RUST, pan, { matR: PAINT, relief: 'plate', detail: panDetail });
// The drives: two small worn ones aft of the panniers
d.pair('drive', 'thruster', STEEL, [[-1.6, 1.4], [-3.4, 1.6], [-3.3, 3.5], [-2.3, 3.5], [-2.0, 2.3]], {
  group: 'drive', shared: true, relief: 'round', mount: { at: [-2.8, 3.5], dir: [0, 1], width: 1.0 },
  detail: [bell([-2.8, 3.5], [0, 1], 0.95, 0.7)],
});
// The drum: a revolving magazine at its tail, mines round its rim, a striped hub
const DC = [0, 4.0];
d.part('drum', 'conduit', STEEL, gear(DC, 1.85, 2.2, 10), {
  group: 'drum', relief: 'round',
  detail: [
    ring(DC, 1.55, 0.22, '#6e7277'), recess(ringPts(DC, 1.3, 16)),
    ...Array.from({ length: 6 }, (_, k) => mine([DC[0] + Math.cos((k / 6) * Math.PI * 2) * 0.88, DC[1] + Math.sin((k / 6) * Math.PI * 2) * 0.88], 0.3)).flat(),
    ring(DC, 0.4, 0.18, HAZ, 6), ...stripes([-0.5, 2.15], [0.5, 2.15], 0.3, 4, HAZ, DARK),
  ],
});

d.write({ damaged: ['pannier_r', 'sensors'], scale: 0.78 });
