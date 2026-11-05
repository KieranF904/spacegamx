/**
 * The mouth of the Pyreclast's cavern on Ashfall's surface
 * (data/terrain/ashfall_surface.json): one ridge of rock heaped round the
 * north side of a pit, open to the south where you fly in (systems.json:
 * ashfall_cavern's `under`, X near it goes down).
 *
 *   ridges  the ridge: a line along its crest round the pit, highest and
 *           broadest behind it, tapering away at its ends (look)
 *   mass    its footprint, as triangles (solid)
 *   rocks   a few boulders strewn further off (solid)
 *   holes   the pit itself (look only: black, falling away into the dark)
 *
 * Run: node scripts/terrain/ashfall_mouth.mjs
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
let seed = 4111;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const round = (v) => Math.round(v);

/** The pit (its middle and size; ashfall_cavern's `under` must match) */
const MOUTH = [0, -5200];
const PIT = 760;
/** The ridge: how far its crest runs from the pit's middle, how far round it reaches (from the south-west round the north to the south-east) */
const CREST = PIT + 780;
const FROM = Math.PI * 0.8, TO = Math.PI * 2.2;

function rock(x, y, r, sides = 6 + Math.floor(rnd() * 3)) {
  const a0 = rnd() * Math.PI * 2, pts = [];
  for (let k = 0; k < sides; k++) {
    const a = a0 + (k / sides) * Math.PI * 2 + (rnd() - 0.5) * 0.3, d = r * (0.8 + 0.2 * rnd());
    pts.push([round(x + Math.cos(a) * d), round(y + Math.sin(a) * d)]);
  }
  return pts;
}

// The ridge's crest, a point every ~300; its half-width and height swelling to the back and tapering at its ends
const N = 24, pts = [], w = [], h = [];
for (let k = 0; k <= N; k++) {
  const t = k / N, a = FROM + (TO - FROM) * t, back = Math.sin(Math.PI * t);
  const d = CREST + (rnd() - 0.5) * 160 + 120 * back;
  pts.push([round(MOUTH[0] + Math.cos(a) * d), round(MOUTH[1] + Math.sin(a) * d)]);
  const end = Math.min(1, t / 0.2, (1 - t) / 0.2);
  w.push(round((300 + 400 * back) * (0.55 + 0.45 * end) * (0.9 + 0.2 * rnd())));
  h.push(round((320 + 480 * back) * (0.3 + 0.7 * end) * (0.9 + 0.2 * rnd())));
}
// Its footprint: the edges either side of the crest, as triangles
const side = (i, s) => {
  const a = pts[Math.max(0, i - 1)], b = pts[Math.min(N, i + 1)], ex = b[0] - a[0], ey = b[1] - a[1], l = Math.hypot(ex, ey) || 1;
  return [round(pts[i][0] - (ey / l) * w[i] * s), round(pts[i][1] + (ex / l) * w[i] * s)];
};
const mass = [];
for (let i = 0; i < N; i++) {
  const a0 = side(i, 1), a1 = side(i + 1, 1), b0 = side(i, -1), b1 = side(i + 1, -1);
  mass.push([a0, a1, b1], [a0, b1, b0]);
}

// A few boulders strewn further off
const rocks = [];
for (let k = 0; k < 6; k++) {
  const a = Math.PI * (0.7 + 1.6 * rnd()), d = PIT + 2300 + rnd() * 1800;
  rocks.push(rock(MOUTH[0] + Math.cos(a) * d, MOUTH[1] + Math.sin(a) * d, 160 + rnd() * 240));
}

// The pit: ragged, a little longer east-west
const hole = [];
for (let k = 0; k < 20; k++) {
  const a = (k / 20) * Math.PI * 2, d = PIT * (0.86 + 0.18 * rnd());
  hole.push([round(MOUTH[0] + Math.cos(a) * d * 1.15), round(MOUTH[1] + Math.sin(a) * d * 0.9)]);
}

mkdirSync(join(root, 'data/terrain'), { recursive: true });
writeFileSync(join(root, 'data/terrain/ashfall_surface.json'), JSON.stringify({
  _comment: 'The mouth of the Pyreclast\'s cavern on Ashfall (common/src/terrain.ts). Written by scripts/terrain/ashfall_mouth.mjs: edit that, not this.',
  rocks, mass, ridges: [{ pts, w, h }], holes: [hole],
}) + '\n');
console.log(`1 ridge (${mass.length} triangles), ${rocks.length} rocks, 1 hole`);
