/**
 * Maw Lurker (Maw Spawn, replaces the grid maw_lurker). DESIGN ONLY: docs/enemies/custom-roster.md.
 * A small kin of the Heart of the Maw, in its language (docs/bosses/maw-heart-redesign.md): a seed of the shard
 * ring's crust in uneven plates, one gold eye in a socket at its front with the heartbeat's veins branching back from it
 * and fading, a long horn of heartstone forward with a vein down it (its rail), two roots swept back from glowing
 * knots, a short tail root ending in a knot of glass crystal.
 *   sniper: it hangs far off in the shard field, its eye draws a thin gold line on you, then the rail fires one slug.
 *   node scripts/bespoke/enemies/maw_lurker.mjs
 *
 * Drawn with the Heart redesign's proposed materials and surfaces (render.mjs SURFACES=maw), like the Heart.
 */
import { design, P, D, DEG, round, mid, ringPts, oval, limb, curve, inset, glow, ring, raise, recess, vein, shard, hash } from './kit.mjs';

const CRUST = 'maw_crust', STONE = 'maw_heartstone', SEAM = 'maw_seamglass', GLASS = 'maw_shardglass';
const FACE = '#45474d', TOP = '#585b62', DEEP = '#26272b', PIT = '#121215', HOT = '#fff4d8', GOLD2 = '#ffd27a';
/** The heartbeat's gold, fading as it runs out from the eye (the Heart's FADE) */
const FADE = ['#ffcf72', '#e0962f', '#b07024', '#80521e', '#5a3d1a'];
const fade = (dist) => FADE[Math.max(0, Math.min(FADE.length - 1, Math.floor(dist / 1.4)))];

const d = design('maw_lurker', {
  name: 'Maw Lurker', faction: 'maw', sky: 'the_maw', replaces: 'maw_lurker', surfaces: 'maw',
  role: 'sniper', level: '24-30', threat: 'high',
});

const EYE = [0, -2.05];
const dist = (q) => Math.hypot(q[0] - EYE[0], q[1] - EYE[1]);
/** A vein from the eye out along `deg`, `len` long, wobbling; capillaries off it, dimmer outward */
function veinTree(from, deg, len, w, seed, branches = 2) {
  const out = [], n = 5;
  const main = Array.from({ length: n + 1 }, (_, k) => { const p = P(len * k / n, deg + (hash(seed + k) - 0.5) * 16, from); return p; });
  out.push(vein(main.slice(0, 4), w, fade(dist(main[1]))), vein(main.slice(3), w * 0.55, fade(dist(main[4]))));
  for (let b = 0; b < branches; b++) {
    const root = main[2 + b], side = b % 2 ? 1 : -1, a = deg + side * (35 + hash(seed * 3 + b) * 20), l = len * (0.35 - b * 0.08);
    out.push(vein([root, P(l * 0.5, a, root), P(l, a + side * 10, root)], w * 0.4, fade(dist(root) + 1)));
  }
  return out;
}
/** A clutch of crystal round a point (the Maw's glass, as the Heart's crystal knots) */
const clutch = (c, n, len, seed) => Array.from({ length: n }, (_, i) => { const a = (i / n) * 360 + hash(seed + i) * 40; return shard(P(0.3, a, c), D(a), len * (0.7 + hash(seed * 3 + i) * 0.6), len * 0.32, '#c79a52'); });
/** A root: a tapering curved limb of heartstone, a raised ridge of lighter stone down it, a vein of gold dying out along it */
function root(name, group, path, w0, opts = {}) {
  const n = path.length, widths = path.map((_, k) => round(w0 * (1 - (k / (n - 1)) * 0.85)));
  d.part(name, opts.fn ?? 'armor', STONE, limb(path, widths), {
    group, relief: 'round', ...(opts.mount ? { mount: opts.mount } : {}),
    detail: [raise(limb(path.slice(1, n - 1), widths.slice(1, n - 1).map((v) => round(v * 0.5))), FACE), raise(limb(path.slice(2, n - 2), widths.slice(2, n - 2).map((v) => round(v * 0.2))), TOP), vein(path.slice(0, Math.ceil(n * 0.6)), w0 * 0.22, fade(dist(path[0]) + 1.5)), ...(opts.detail ?? [])],
  });
}
/** A knot: the glowing joint a root grows from (shoot it and the root goes) */
const knot = (c, r) => [ring(c, r, r * 0.3, FACE), recess(ringPts(c, r * 0.7, 9), PIT), glow(c, r * 0.55, FADE[1]), glow(c, r * 0.2, HOT)];

// The roots: two swept back from knots on its flanks, the left longer; the tail root behind, ending in a crystal knot
root('root_l', 'root_l', curve([-1.6, 0.0], [-5.0, 0.6], [-6.0, 4.8], 7), 1.25, { detail: knot([-1.95, 0.05], 0.65) });
root('root_r', 'root_r', curve([1.6, 0.5], [4.3, 1.0], [4.7, 4.2], 6), 1.1, { detail: knot([1.95, 0.5], 0.6) });
root('tail', 'tail', curve([0, 2.6], [1.0, 4.6], [0.2, 6.6], 5), 1.0, { detail: clutch([0.25, 6.3], 5, 0.85, 7) });
// The horn: a long tapering spike of heartstone forward, a bright vein down its middle (the rail)
root('rail', 'rail', curve([0, -2.2], [0.25, -5.4], [0.1, -8.8], 7), 0.85, { fn: 'railgun', mount: { at: [0.1, -8.8], dir: [0, -1], width: 0.3 }, detail: [glow([0.1, -8.6], 0.18, GOLD2)] });
// The seed: its body, the shard ring's crust in uneven plates, the heartbeat's veins branching back from its eye
const body = oval([0, 0.5], 3.0, 2.45, [0, -1], 20).map((q, k) => [round(q[0] * (1 + 0.05 * Math.sin(k * 2.1))), round(q[1] + 0.06 * Math.cos(k * 1.3))]);
const plates0 = [
  [[-1.75, -0.6], [-0.9, -1.2], [-0.5, -0.3], [-1.0, 0.6], [-1.85, 0.3]],
  [[0.9, -1.1], [1.7, -0.4], [1.85, 0.6], [1.0, 0.8], [0.6, -0.1]],
  [[-1.7, 0.9], [-0.7, 1.0], [-0.3, 2.0], [-1.0, 2.6], [-1.6, 1.9]],
  [[0.4, 1.3], [1.6, 1.2], [1.4, 2.3], [0.5, 2.7], [0.0, 2.1]],
];
const plates = plates0.map((pg) => pg.map(([x, y]) => [round(x * 1.2), round(0.5 + (y - 0.4) * 1.2)]));
d.part('body', 'hull', CRUST, body, {
  group: 'core', relief: 'round',
  detail: [
    ...plates.map((pg, k) => raise(pg, k % 2 ? FACE : TOP)), ...plates.map((pg) => raise(inset(pg, 0.55), DEEP)),
    ...veinTree(EYE, 208, 4.6, 0.18, 3), ...veinTree(EYE, 152, 4.3, 0.17, 11), ...veinTree(EYE, 180, 5.0, 0.15, 19, 1), ...veinTree(EYE, 245, 2.6, 0.12, 31, 1), ...veinTree(EYE, 115, 2.4, 0.12, 37, 1),
  ],
});
// The node: a knot of seam glass in its back (the core), a clutch of crystal round it
d.part('node', 'core', SEAM, ringPts([0, 1.2], 0.6, 8, 0.2), {
  group: 'core', relief: 'recess',
  detail: [recess(ringPts([0, 1.2], 0.58, 8, 0.2), PIT), glow([0, 1.2], 0.42, FADE[0]), glow([0, 1.2], 0.16, HOT), ...clutch([0, 1.2], 4, 0.55, 23)],
});
// The eye: a gold lens in a socket of crust at its front (it charges as it aims)
d.part('eye', 'scanner', SEAM, oval(EYE, 1.0, 0.82, [0, -1], 14), {
  relief: 'recess',
  detail: [ring(EYE, 0.85, 0.24, FACE), recess(oval(EYE, 0.65, 0.5, [0, -1], 12), PIT), glow(EYE, 0.6, FADE[1]), glow(EYE, 0.36, GOLD2), glow(EYE, 0.14, HOT)],
});

d.write({ damaged: ['eye', 'root_l'], scale: 0.78 });
