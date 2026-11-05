/**
 * Scrap Darter (Scrapborn, new; the Scrap Mother's Nest Rock: docs/bosses/rework-2026-11.md 9.3). Working name: not
 * player-facing lore until something in the game owns it.
 * A fast scrap flanker: a narrow arrowhead spine, two swept fins torn off something bigger, a swivel repeater on its
 * nose, a fat fuel pod slung under its belly, one oversized drive.
 *   flanker: it darts in from your side, rakes a short burst down a line it draws, and peels away.
 *   Pieces: gun (gone: it rams), fin_l / fin_r (gone: it can't turn tight, overshoots), pod (gone: it crawls; shot
 *   through as it passes a packmate, it bursts on them), drive.
 *   node scripts/bespoke/enemies/scrap_darter.mjs
 */
import { design, mid, bar, ringPts, limb, curve, inset, rivet, rivets, glow, halo, ring, raise, recess, stripes, dent, bell } from './kit.mjs';

const IRON = 'scrap_iron', RUST = 'scrap_rust', PAINT = 'scrap_paint', STEEL = 'scrap_steel', SEAM = 'scrap_seam';
const SEAMGLOW = '#7affd2', SEAMDIM = '#3f9a78', AMBER = '#ffa53a', GRIME = '#2a2620', HAZ = '#c9a23a', DARK = '#202226';

const d = design('scrap_darter', {
  name: 'Scrap Darter', faction: 'scrapborn', sky: 'sol_scrap_nest',
  role: 'flanker', level: '4-8', threat: 'medium',
});

// The fins: swept back off the spine's shoulders, mismatched (one painted, one rusted through)
const fin = [[-0.8, -0.6], [-2.4, 1.0], [-4.6, 3.6], [-4.3, 4.4], [-2.6, 3.9], [-1.0, 2.6]];
const finDetail = (k) => [
  raise(inset(fin, 0.62), k ? '#4d5a44' : '#5a3a2a'), ...rivets([-1.2, 0.0], [-3.6, 3.0], 4, 0.12),
  ...stripes([-3.2, 3.4], [-4.3, 4.1], 0.5, 3, HAZ, DARK), dent([-2.4, 2.2], 0.32, 2.2 + k, k ? undefined : '#3d2318'),
];
d.part('fin_l', 'armor', RUST, fin, { group: 'fin_l', relief: 'plate', detail: finDetail(0) });
d.part('fin_r', 'armor', PAINT, fin.map(([x, y]) => [-x, y]).reverse(), { group: 'fin_r', relief: 'plate', detail: finDetail(1).map((q) => ({ ...q, ...(q.poly ? { poly: q.poly.map(([x, y]) => [-x, y]).reverse() } : {}), ...(q.at ? { at: [-q.at[0], q.at[1]] } : {}) })) });
// The spine: a narrow arrowhead, nose forward
const spine = [[0, -5.6], [0.9, -3.6], [1.05, -0.4], [0.9, 3.4], [0.55, 4.6], [-0.55, 4.6], [-0.9, 3.4], [-1.05, -0.4], [-0.9, -3.6]];
d.part('spine', 'hull', IRON, spine, {
  group: 'core', relief: 'ridge',
  detail: [recess(bar([0, -4.4], [0, -1.6], 0.36), GRIME), ...rivets([-0.62, -3.0], [-0.62, 2.8], 5, 0.1), ...rivets([0.62, -3.0], [0.62, 2.8], 5, 0.1),
    raise(bar([-0.7, 0.6], [0.7, 0.6], 0.18), '#4a4d52'), glow([0, -3.6], 0.12, AMBER), dent([0.45, -1.9], 0.28, 1.7, '#5a3a2a'), dent([-0.4, 0.2], 0.22, 0.6, GRIME)],
});
// Its lamp: a little greyseam heart behind the gun (the core)
d.part('lamp', 'core', SEAM, ringPts([0, -0.4], 0.62, 6, Math.PI / 6), {
  group: 'core', relief: 'recess',
  detail: [ring([0, -0.4], 0.5, 0.14, '#9a9ea4', 6), glow([0, -0.4], 0.3, SEAMGLOW, 6)],
});
// The fuel pod: a fat drum under the belly, its greyseam fuel glowing through a sight glass
const pod = [[-1.0, 1.1], [1.0, 1.1], [1.25, 1.8], [1.25, 3.5], [0.95, 4.1], [-0.95, 4.1], [-1.25, 3.5], [-1.25, 1.8]];
d.part('pod', 'cargo', IRON, pod, {
  group: 'pod', relief: 'round',
  detail: [raise(bar([-1.15, 1.7], [1.15, 1.7], 0.2), '#55585e'), raise(bar([-1.15, 3.5], [1.15, 3.5], 0.2), '#55585e'),
    recess(bar([0, 2.05], [0, 3.15], 0.5), GRIME), glow([0, 2.6], 0.3, SEAMGLOW), ...stripes([-0.9, 3.85], [0.9, 3.85], 0.26, 4, HAZ, DARK)],
});
// The gun: a swivel repeater on the nose, twin stubby barrels
d.part('gun', 'autocannon', STEEL, ringPts([0, -2.6], 0.62, 8, Math.PI / 8), {
  group: 'gun', turret: 1,
  detail: [ring([0, -2.6], 0.5, 0.14, HAZ, 8), raise(bar([-0.2, -2.8], [-0.2, -4.9], 0.18), '#868a90'), raise(bar([0.2, -2.8], [0.2, -4.9], 0.18), '#868a90'), glow([0, -2.6], 0.14, AMBER)],
});
// The drive: one oversized, scavenged plasma drive (why it's fast)
d.part('drive', 'plasma_drive', STEEL, [[-0.95, 4.3], [0.95, 4.3], [1.3, 6.3], [-1.3, 6.3]], {
  group: 'drive', relief: 'round', mount: { at: [0, 6.3], dir: [0, 1], width: 2.2 },
  detail: [bell([0, 6.3], [0, 1], 2.0, 1.3), ...stripes([-0.8, 4.6], [0.8, 4.6], 0.32, 4, HAZ, DARK)],
});

d.write({ damaged: ['fin_r', 'pod'], scale: 0.5 });
