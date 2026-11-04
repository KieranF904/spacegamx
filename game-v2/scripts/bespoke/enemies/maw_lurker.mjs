/**
 * Maw Lurker (Maw Spawn, replaces the grid maw_lurker). DESIGN ONLY: docs/enemies/custom-roster.md.
 * A splinter of the shard ring's dark rock that hunts: a jagged body of slate and glassy black shards, a long horn of
 * rock forward with a gold-lit groove (its rail), one gold eye under the horn's root, a knot of seam glass in its
 * middle, broken shards fanned back either side (the left bigger), three gold vents at its root.
 *   sniper: it hangs far off in the shard field, its eye draws a thin gold line on you, then the rail fires one slug.
 *   node scripts/bespoke/enemies/maw_lurker.mjs
 */
import { design, mid, round, bar, ringPts, oval, inset, glow, ring, raise, recess, channel, vein, shard } from './kit.mjs';

// Stand-in materials (the game's own) until the Maw has its own, as the Heart's redesign does
const SLATE = 'leestone', GLASS = 'pyre_glass';
const GOLD = '#ffc24a', HOTG = '#fff0c4', PIT = '#101114', GRAIN = '#2b2d33', EDGE = '#555963', DUST = '#3a3b40';

const d = design('maw_lurker', {
  name: 'Maw Lurker', faction: 'maw', sky: 'the_maw', replaces: 'maw_lurker',
  role: 'sniper', level: '24-30', threat: 'high',
});

/** Notched, never square: each corner cut back a little */
const notch = (pg, t = 0.16) => pg.flatMap((q, i) => { const a = pg[(i + pg.length - 1) % pg.length], b = pg[(i + 1) % pg.length]; return [mid(q, a, t), mid(q, b, t)]; });

/** A shard of rock from `base` out to `tip`, `w` across at its widest (a third of the way out), a little skewed */
const blade = (base, tip, w, skew = 0.15) => {
  const dx = tip[0] - base[0], dy = tip[1] - base[1], L = Math.hypot(dx, dy), ux = dx / L, uy = dy / L, vx = -uy, vy = ux;
  const at = (t, s) => [round(base[0] + dx * t + vx * s), round(base[1] + dy * t + vy * s)];
  return notch([at(0, -w * 0.38), at(0.3, -w * 0.5), at(0.78, -w * (0.2 - skew)), at(1, 0), at(0.62, w * (0.3 + skew)), at(0.25, w * 0.5), at(0, w * 0.4)], 0.1);
};

// The vents: a rough knot of rock at its root, gold light deep in its cracks
const root = notch([[-1.3, 2.0], [1.1, 2.1], [1.4, 3.6], [0.4, 4.9], [-0.9, 4.6], [-1.6, 3.4]], 0.2);
d.part('vents', 'hull', GLASS, root, {
  relief: 'round',
  detail: [raise(inset(root, 0.62), DUST), ...[[-0.7, 3.6], [0.5, 3.9]].flatMap((at) => [recess(ringPts(at, 0.3, 7), PIT), glow(at, 0.22, GOLD)]), vein([[-0.9, 2.6], [-0.2, 3.3], [0.1, 4.4]], 0.07, GOLD)],
});
// The shards: broken glassy blades grown out of it at odd angles, two to the left (one reaching forward), two to the right
const SH = {
  flank_l: [blade([-1.3, -0.4], [-6.2, 2.9], 1.9, 0.2), blade([-1.0, -1.4], [-3.4, -4.9], 1.2, -0.1)],
  flank_r: [blade([1.4, -0.3], [4.9, -1.6], 1.4, 0.1), blade([1.0, 1.6], [3.0, 4.6], 1.0, -0.15)],
};
for (const [g, list] of Object.entries(SH)) list.forEach((pg, k) => d.part(`${g}${k}`, 'armor', GLASS, pg, {
  group: g, relief: 'ridge',
  detail: [raise(inset(pg, 0.5), k ? GRAIN : EDGE), vein([mid(pg[0], pg[pg.length - 1]), mid(pg[3], pg[7], 0.5), pg[7]], 0.07, GOLD), shard(mid(pg[2], pg[3]), [pg[2][0] - pg[3][0], pg[2][1] - pg[3][1]], 0.6, 0.22, GOLD)],
}));
// The body: a chunky knot of slate, facets of darker grain across it
const body = notch([[-0.2, -2.7], [1.2, -1.8], [1.9, 0.2], [1.5, 2.3], [0.2, 2.9], [-1.3, 2.6], [-2.0, 0.8], [-1.7, -1.5]], 0.14);
d.part('body', 'hull', SLATE, body, {
  group: 'core', relief: 'ridge',
  detail: [
    raise([[-1.6, -1.0], [-1.75, 0.8], [-1.1, 2.3], [-0.5, 2.0], [-0.9, -0.6]], GRAIN),
    raise([[1.1, -1.2], [1.6, 0.3], [1.2, 2.0], [0.7, 1.8], [0.8, -0.6]], EDGE),
    raise([[-0.6, 1.75], [0.85, 1.95], [0.15, 2.6], [-0.9, 2.4]], DUST),
    raise([[-1.25, -1.65], [-0.55, -2.25], [-0.25, -1.75], [-0.75, -0.75]], EDGE),
    vein([[-0.55, 1.7], [-1.05, 1.0], [-1.55, 0.1]], 0.05, GOLD), vein([[0.75, 1.6], [1.15, 0.6], [1.0, -0.4]], 0.05, GOLD),
    shard([-1.8, 1.6], [-1, 0.6], 0.6, 0.22, GOLD), shard([1.6, 1.2], [1, 0.3], 0.5, 0.2, GOLD),
  ],
});
// The node: a knot of seam glass in its middle (the core)
d.part('node', 'core', GLASS, notch(ringPts([0.15, 0.8], 0.8, 6, Math.PI / 6), 0.2), {
  group: 'core', relief: 'recess',
  detail: [recess(ringPts([0.15, 0.8], 0.52, 6, Math.PI / 6), PIT), glow([0.15, 0.8], 0.42, GOLD, 6), glow([0.15, 0.8], 0.18, HOTG, 6)],
});
// The rail: a long horn of rock forward, a gold groove down it, its muzzle at the tip
const horn = [[-0.4, -1.4], [-0.3, -4.6], [-0.1, -7.4], [0.22, -8.6], [0.42, -7.3], [0.68, -4.4], [0.8, -1.4]];
d.part('rail', 'railgun', GLASS, horn, {
  group: 'rail', relief: 'ridge', mount: { at: [0.22, -8.6], dir: [0, -1], width: 0.35 },
  detail: [raise([[0.35, -1.6], [0.65, -1.6], [0.52, -4.6], [0.36, -6.6]], EDGE), channel([[0.06, -1.6], [0.3, -1.6], [0.3, -7.4], [0.2, -7.9], [0.1, -7.4]], GOLD), glow([0.2, -8.2], 0.18, GOLD)],
});
// The eye: a gold lens under the horn's root, set in a socket of rock (it charges as it aims)
const EC = [-0.95, -1.35];
d.part('eye', 'scanner', GLASS, oval(EC, 0.78, 0.62, [0, -1], 12), {
  relief: 'recess',
  detail: [ring(EC, 0.62, 0.17, EDGE), recess(oval(EC, 0.46, 0.34, [0, -1], 10), PIT), glow(EC, 0.38, GOLD), glow(EC, 0.14, HOTG)],
});

d.write({ damaged: ['eye', 'flank_l'], scale: 0.78 });
