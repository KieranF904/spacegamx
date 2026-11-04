/**
 * Censer (Cinder Cult, replaces the grid cinder_zealot). DESIGN ONLY: docs/enemies/custom-roster.md.
 * A cult lancer built like a swung censer: a long black reliquary hull inlaid with brass, a forked lance at its nose
 * with a burning focus, a brazier bowl of embers at its back hung on chains from two swept vanes, one drive.
 *   sniper / lancer: it holds off, draws its lance's line on you, then fires down it.
 *   node scripts/bespoke/enemies/censer.mjs
 */
import { design, mid, bar, ringPts, smooth, limb, curve, inset, rivets, glow, ring, raise, recess, channel, vein, shard, cable, bell } from './kit.mjs';

const BLACK = 'leestone', FIRE = 'pyre_glass', STEEL = 'pyre_steel';
const EMBER = '#ff7a2a', HOT = '#ffc46a', SOOT = '#1a1614', BRASS = '#a8843f', BRASS2 = '#c9a35a', GILT = '#e0bd70';

const d = design('censer', {
  name: 'Censer', faction: 'cinder', sky: 'cinder_reach', replaces: 'cinder_zealot',
  role: 'sniper / lancer', level: '15-20', threat: 'medium',
});

// The vanes: two swept blades out of its waist, a brass inlay in each, chains hung from their tips to the bowl
const vane = smooth([[-0.9, -0.7], [-2.4, -0.5], [-4.3, 0.8], [-5.3, 3.1], [-4.6, 3.4], [-3.4, 2.1], [-2.0, 1.6], [-0.9, 1.8]], 1);
d.pair('vane', 'armor', BLACK, vane, {
  relief: 'plate',
  detail: [
    raise(smooth([[-1.2, -0.3], [-2.5, -0.1], [-4.0, 1.0], [-4.75, 2.6], [-3.6, 1.55], [-2.1, 1.05], [-1.2, 1.15]], 1), BRASS),
    raise(smooth([[-1.4, 0.05], [-2.5, 0.2], [-3.7, 1.05], [-2.3, 0.75], [-1.4, 0.8]], 1), SOOT),
    channel(bar([-1.5, 0.45], [-3.6, 1.15], 0.12), EMBER),
    ...rivets([-1.4, 1.45], [-3.3, 1.75], 3, 0.1, GILT),
    cable([[-4.9, 3.15], [-4.0, 3.8], [-2.6, 4.1], [-1.4, 3.9]], 0.07, '#8a7650'),
  ],
});
// The hull: a long black reliquary, brass edging and a gilt rivet line down each side
const hull = [[0, -3.9], [-0.75, -3.5], [-0.95, -1.4], [-1.25, 0.6], [-1.2, 3.0], [-0.7, 4.7], [0, 5.0], [0.7, 4.7], [1.2, 3.0], [1.25, 0.6], [0.95, -1.4], [0.75, -3.5]];
d.part('hull', 'hull', BLACK, hull, {
  group: 'core', relief: 'round',
  detail: [
    raise([[-0.5, -3.4], [0.5, -3.4], [0.72, -1.6], [-0.72, -1.6]], BRASS),
    raise([[-0.3, -3.1], [0.3, -3.1], [0.45, -1.85], [-0.45, -1.85]], SOOT),
    channel(bar([0, -3.0], [0, -1.95], 0.12), EMBER),
    ...rivets([-0.82, -3.1], [-1.08, 0.3], 4, 0.1, GILT), ...rivets([0.82, -3.1], [1.08, 0.3], 4, 0.1, GILT),
    raise([[-1.0, 1.7], [1.0, 1.7], [0.95, 2.1], [-0.95, 2.1]], BRASS),
  ],
});
// The reliquary: a sealed case in the hull's middle, fire behind a brass grille (the core: small, under the grille)
d.part('reliquary', 'core', FIRE, [[-0.6, -1.0], [0.6, -1.0], [0.7, 1.0], [0, 1.45], [-0.7, 1.0]], {
  group: 'core', relief: 'recess',
  detail: [recess([[-0.62, -1.0], [0.62, -1.0], [0.72, 1.0], [0, 1.45], [-0.72, 1.0]], SOOT), glow([0, 0.2], 0.55, EMBER), glow([0, 0.2], 0.22, HOT), ...[-0.36, 0, 0.36].map((x) => raise(bar([x, -0.95], [x, 1.2 - Math.abs(x)], 0.11), GILT)), raise(bar([-0.66, 0.2], [0.66, 0.2], 0.1), GILT)],
});
// The lance: a central blade of fire-glass between two black tines edged in brass, a burning focus at its root
d.part('blade', 'pyre_lance', FIRE, [[-0.32, -3.6], [0.32, -3.6], [0.14, -7.6], [0, -8.1], [-0.14, -7.6]], {
  group: 'lance', relief: 'ridge', mount: { at: [0, -8.1], dir: [0, -1], width: 0.5 },
  detail: [vein([[0, -3.8], [0, -7.6]], 0.12, HOT), glow([0, -3.9], 0.42, EMBER)],
});
const tine = curve([-0.55, -3.0], [-1.6, -4.8], [-0.6, -7.0], 6);
d.pair('tine', 'armor', BLACK, limb(tine, [0.4, 0.4, 0.36, 0.3, 0.24, 0.16, 0.05]), {
  group: 'lance', shared: true, relief: 'ridge',
  detail: [raise(limb(tine.slice(1, 6), [0.14, 0.14, 0.12, 0.1, 0.06]), BRASS2), ring([-0.75, -3.4], 0.24, 0.09, GILT)],
});
// The brazier: a brass-rimmed bowl of embers at its back (it blesses the pack: packmates near it fire faster)
const BC = [0, 3.4];
d.part('brazier', 'conduit', BLACK, ringPts(BC, 1.5, 16), {
  group: 'brazier', relief: 'round',
  detail: [ring(BC, 1.32, 0.24, BRASS), recess(ringPts(BC, 1.08, 16), '#120a06'), glow(BC, 0.95, EMBER), glow(BC, 0.4, HOT), shard([-0.35, 3.15], [0.6, -0.8], 0.55, 0.24, HOT), shard([0.4, 3.75], [-0.9, 0.3], 0.45, 0.2, '#6a3a20'), shard([0.15, 2.85], [0.3, 1], 0.35, 0.18, '#6a3a20')],
});
// The drive, under the bowl
d.part('drive', 'plasma_drive', STEEL, [[-0.7, 4.3], [0.7, 4.3], [0.85, 6.0], [-0.85, 6.0]], {
  group: 'drive', relief: 'round', mount: { at: [0, 6.0], dir: [0, 1], width: 1.3 },
  detail: [bell([0, 6.0], [0, 1], 1.25, 0.9)],
});

d.write({ damaged: ['lance', 'vane_l'], scale: 0.72 });
