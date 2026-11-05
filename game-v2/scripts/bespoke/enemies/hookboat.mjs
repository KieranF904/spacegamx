/**
 * Hookboat (Pirates, replaces the grid pirate_raider). DESIGN ONLY: docs/enemies/custom-roster.md.
 * A whaler gone bad: a long narrow hull in grey and red, a harpoon gun on its bow with the cable winch behind it, a
 * wheelhouse aft and off to starboard, a rusted outrigger to port on two struts carrying a gun, two mismatched drives.
 *   puller: it harpoons you from its bow and reels you towards its pack; the outrigger's gun covers the reel.
 *   node scripts/bespoke/enemies/hookboat.mjs
 */
import { design, mid, bar, ringPts, oval, inset, rivets, glow, ring, raise, recess, channel, stripes, dent, bell, cable } from './kit.mjs';

const GREY = 'pirate_plate', PAINT = 'pirate_paint', RUST = 'scrap_rust', STEEL = 'scrap_steel', DRIVE = 'pyre_steel';
const RED = '#8e2a22', REDB = '#b8372b', CREAM = '#d8cdb4', GLASS = '#16202a', LAMP = '#ff5a3a', GUNM = '#3a3e44', DECK = '#5b6068', ROPE = '#c8c2b0';

const d = design('hookboat', {
  name: 'Hookboat', faction: 'pirates', sky: 'nebula_prime', replaces: 'pirate_raider',
  role: 'puller', level: '8-12', threat: 'medium',
});

// The core: inside the wheelhouse (drawn under it, never seen while it stands)
d.part('core', 'core', GREY, ringPts([0.75, 2.6], 0.5, 6, Math.PI / 6), { group: 'core', under: true });
// The outrigger: a rusted pontoon to port on two struts, a gun on its nose
d.part('strut_f', 'hull', STEEL, bar([-0.8, -1.2], [-3.9, -1.6], 0.55), { group: 'outrigger', relief: 'round', detail: stripes([-1.8, -1.33], [-3.0, -1.49], 0.42, 3, CREAM, RED) });
d.part('strut_a', 'hull', STEEL, bar([-0.8, 2.4], [-3.9, 2.0], 0.55), { group: 'outrigger', relief: 'round' });
const pontoon = oval([-4.25, 0.1], 3.6, 0.95, [0, -1], 18);
d.part('pontoon', 'armor', RUST, pontoon, {
  group: 'outrigger', relief: 'round',
  detail: [raise(oval([-4.25, 0.5], 2.6, 0.55, [0, -1], 14), '#5a3626'), ...rivets([-4.95, -2.4], [-4.95, 2.8], 6, 0.1), dent([-3.8, 1.9], 0.3, 1.9, '#3d2318'), ...stripes([-4.95, 3.1], [-3.55, 3.1], 0.38, 3, CREAM, RED)],
});
d.part('gun', 'autocannon', GREY, ringPts([-4.25, -1.9], 0.6, 6, Math.PI / 6), { group: 'outrigger', turret: 1.3, detail: [ring([-4.25, -1.9], 0.9, 0.15, REDB, 8)] });
// The hull: long and narrow, a red band down its starboard side, deck plates, its bow in hazard paint
const hull = [[0, -5.3], [-0.85, -4.3], [-1.35, -2.0], [-1.45, 1.5], [-1.25, 4.6], [1.25, 4.6], [1.45, 1.5], [1.35, -2.0], [0.85, -4.3]];
d.part('hull', 'hull', GREY, hull, {
  group: 'core', relief: 'round',
  detail: [
    raise([[1.0, -3.6], [1.3, -2.0], [1.4, 1.5], [1.2, 4.3], [0.95, 4.3], [1.05, 1.5], [0.95, -2.0], [0.7, -3.6]], RED),
    raise([[-0.95, -1.3], [0.55, -1.3], [0.55, 0.9], [-0.95, 0.9]], DECK),
    raise([[-0.95, 1.2], [-0.15, 1.2], [-0.15, 4.2], [-0.95, 4.2]], GUNM),
    ...rivets([-1.15, -1.6], [-1.3, 1.4], 4, 0.1), ...rivets([-0.55, 1.5], [-0.55, 4.0], 3, 0.09),
    ...stripes([-0.55, -4.25], [0.55, -4.25], 0.32, 4, CREAM, RED),
    dent([0.0, -0.2], 0.28, 2.7),
  ],
});
// The wheelhouse: aft, off to starboard, windows along its front, its running lamp
d.part('wheelhouse', 'hull', PAINT, [[0.0, 1.5], [1.25, 1.4], [1.35, 3.8], [0.05, 3.9]], {
  group: 'core', relief: 'plate',
  detail: [recess([[0.15, 1.65], [1.1, 1.58], [1.12, 2.0], [0.17, 2.08]], GLASS), raise([[0.2, 2.4], [1.1, 2.35], [1.15, 3.6], [0.25, 3.65]], DECK), glow([0.7, 3.05], 0.2, LAMP), channel(bar([0.2, 1.85], [1.05, 1.8], 0.1), '#9fd4ff')],
});
// The harpoon: a gun on its bow (shaft and barbed head), the cable winch behind it
d.part('winch', 'hull', STEEL, ringPts([0, -2.6], 0.85, 14), {
  group: 'harpoon', relief: 'round',
  detail: [ring([0, -2.6], 0.7, 0.18, GUNM), ring([0, -2.6], 0.48, 0.16, ROPE), ring([0, -2.6], 0.3, 0.12, ROPE), ring([0, -2.6], 0.14, 0.1, REDB, 6), cable([[0, -3.3], [0.12, -4.2], [0.05, -5.4]], 0.07, ROPE)],
});
d.part('harpoon', 'railgun', GREY, [[-0.35, -3.5], [0.35, -3.5], [0.22, -6.0], [0.6, -6.1], [0, -7.2], [-0.6, -6.1], [-0.22, -6.0]], {
  group: 'harpoon', relief: 'ridge', mount: { at: [0, -7.2], dir: [0, -1], width: 0.4 },
  detail: [raise([[-0.2, -3.6], [0.2, -3.6], [0.12, -5.9], [-0.12, -5.9]], GUNM)],
});
// The drives: a big one and a small one, mismatched
d.part('drive_l', 'plasma_drive', DRIVE, [[-1.2, 4.4], [0.05, 4.4], [0.15, 6.2], [-1.3, 6.2]], {
  group: 'drive_l', relief: 'round', mount: { at: [-0.58, 6.2], dir: [0, 1], width: 1.35 },
  detail: [bell([-0.58, 6.2], [0, 1], 1.3, 0.9)],
});
d.part('drive_r', 'thruster', DRIVE, [[0.35, 4.4], [1.2, 4.4], [1.25, 5.6], [0.4, 5.6]], {
  group: 'drive_r', relief: 'round', mount: { at: [0.82, 5.6], dir: [0, 1], width: 0.8 },
  detail: [bell([0.82, 5.6], [0, 1], 0.78, 0.5)],
});

d.write({ damaged: ['harpoon', 'outrigger'], scale: 0.8 });
