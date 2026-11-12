/**
 * @contract client.weapon-fx.mods.blast
 * owns:       the explosive modifier's blast where it goes off: the flash, the shock ring at its real radius, the sparks,
 *             and what hangs there after (embers and smoke, one mark a blast); the way out of a hull drawn as a jet
 * needs:      kit (ModCtx: emitters, marks, budget), particleTypes (mixColor)
 * invariants: a blast's ring is as wide as its radius; its embers and smoke hang BLAST_LINGER frames (over a second);
 *             a way out throws along its heading and nothing behind; blasts on one spot in one frame draw once, and a
 *             blast on a spot still burning feeds it at half its particles; never more than BLAST_MARKS spots hang at
 *             once — client/src/rendering/weapons/fx/mods/blast.test.ts
 * extend:     a new part of the blast is a block in blast(); what hangs after is drawn in `hang`
 */

import { mixColor } from '../particleTypes';
import { COOL, ease, type Mark, type MarkDraw, type ModCtx } from './kit';

const SMOKE = 0x4a423c;
/** Frames a blast's embers and smoke hang where it went off (1.4 s) */
export const BLAST_LINGER = 84;
/** Spots hanging at once at most: past it the oldest is put out as a new one starts */
export const BLAST_MARKS = 32;
/** A blast's particles at most when no shell's own budget holds it (a beam's end, the way out of a hull), and the embers a spot shows */
export const CAP_BLAST = 44, HANG_EMBERS = 14;

/**
 * What hangs where a blast went off: a glow cooling, smoke swelling and thinning, and embers thrown out at the start
 * that drift, flicker and die each in its own time. d: [radius, 1 for a way out (carried along `a`), tint]
 */
const hang: MarkDraw = (c, m) => {
  const n = m.life / m.max, f = 1 - n, R = m.d[0], jet = m.d[1] > 0, tint = m.d[2];
  // (a way out's cloud is carried on along its heading, slowing)
  const run = jet ? R * 1.1 * ease(n * 1.6) : 0, cx = m.x + c.ux * run, cy = m.y + c.uy * run;
  c.ball(cx, cy, R * (0.5 + 0.3 * n), mixColor(tint, COOL, Math.min(1, n * 1.7)), 0.4 * f * f * (0.5 + 0.5 * m.k), m.a, jet ? 1.6 : 1);
  for (let i = 0; i < 3; i++) {
    const a = c.h(i) * Math.PI * 2, d = R * (0.12 + 0.4 * c.h(i + 3)) * (0.3 + 0.7 * ease(n * 2));
    c.soot(cx + Math.cos(a) * d, cy + Math.sin(a) * d, R * (0.3 + 0.34 * n + 0.14 * c.h(i + 6)), mixColor(SMOKE, tint, 0.14), 0.24 * Math.min(1, n * 7) * f * (0.5 + 0.5 * m.k));
  }
  for (let i = 0, count = Math.round(HANG_EMBERS * (0.45 + 0.55 * m.k) * c.thin); i < count; i++) {
    // (each dies at its own time; the last of them at the very end)
    const e = n / (0.5 + 0.5 * c.h(i + 50));
    if (e >= 1) continue;
    const a = jet ? m.a + (c.h(i + 10) - 0.5) * 1.1 : c.h(i + 10) * Math.PI * 2;
    const d = R * (0.2 + 0.85 * c.h(i + 30)) * (jet ? 2.1 : 1) * (0.25 + 0.75 * ease(n * 3)) + R * 0.18 * n;
    const x = m.x + Math.cos(a) * d, y = m.y + Math.sin(a) * d, r = (1 + 1.3 * c.h(i + 70)) * (1 - 0.45 * e);
    const col = mixColor(c.look.hot, mixColor(tint, COOL, e), Math.min(1, e * 1.6)), al = (1 - e * e) * (0.6 + 0.4 * c.rnd());
    if (i % 3 === 0) c.ball(x, y, r * 3.2, col, 0.3 * al);
    c.dot(x, y, r, col, al);
  }
};

/** The spot hanging nearest (x, y) within `reach`, of a way out or not */
function spotNear(marks: readonly Mark[], x: number, y: number, reach: number, jet: boolean): Mark | undefined {
  let best: Mark | undefined, bd = reach * reach;
  for (const m of marks) {
    if (m.draw !== hang || m.d[1] > 0 !== jet) continue;
    const d = (m.x - x) * (m.x - x) + (m.y - y) * (m.y - y);
    if (d <= bd) { bd = d; best = m; }
  }
  return best;
}

/** How many spots hang in a field's marks */
export function blastSpots(marks: readonly Mark[]): number {
  let n = 0;
  for (const m of marks) if (m.draw === hang && m.life < m.max) n++;
  return n;
}

/**
 * An explosive blast at (c.x, c.y), `R` its real radius, at strength k, tinted `tint`. `heading` (radians): it is a shot's
 * way out of a hull, thrown along that heading; else it bursts all round (off the surface, where c.surface knows one).
 * `fire`: with its own lumps of fire (a blast no shell's hit has drawn a fireball for). False: this spot already burst
 * this frame, and nothing was added
 */
export function blast(c: ModCtx, k: number, R: number, tint: number, heading?: number, fire = false): boolean {
  // (sparks fly to a small blast's edge and a little past: they are drawn by their speed)
  const jet = heading !== undefined, out = heading ?? 0, Rs = Math.max(R, 22), x = c.x, y = c.y, hot = c.look.hot, marks = c.st.marks;
  const old = spotNear(marks, x, y, Math.max(16, R * 0.75), jet);
  // (one blast a spot a frame: a fan's or a wave's shells landing together, a shell's hit and the server's word of it)
  if (old && old.life <= 0) return false;
  // (a spot still burning is fed: its embers thrown again, half the particles)
  const share = old ? 0.5 : 1, kk = 0.4 + 0.6 * k;
  const ux = jet ? Math.cos(out) : 0, uy = jet ? Math.sin(out) : 0;
  const any = (w: number): number => (jet ? out + c.jit(w) : c.surface ? c.out + c.jit(2.8) : c.rnd() * Math.PI * 2);

  // The flash and the shock: a hard white core, a hot swell, the ring racing out to the blast's edge
  c.glow(x + ux * R * 0.25, y + uy * R * 0.25, R * (jet ? 0.42 : 0.6), 7, 0xffffff, true);
  c.glow(x + ux * R * 0.4, y + uy * R * 0.4, R * (jet ? 0.6 : 0.95), 13, hot);
  if (jet) {
    // The way out: a lance and a short jet of fire along the heading, a small ring pushed ahead of the hull
    c.shock(x + ux * R * 0.55, y + uy * R * 0.55, R * 0.6, 1.4 + 1.2 * k, 12, tint, 1);
    c.flare(x, y, out, R * (2.4 + 1.8 * k), 1.6 + k, 11, tint);
    c.flare(x, y, out + c.jit(0.16), R * (1.3 + k), 1, 8, 0xffffff);
    for (let i = 0, n = c.n(3 * kk * share); i < n; i++) c.fire(x, y, out + c.jit(0.4), R * c.range(0.05, 0.12), R * c.range(0.26, 0.42), c.range(14, 24), i ? tint : hot, COOL, i * 1.5);
  } else {
    c.shock(x, y, R, 2 + 2.4 * k, 15, tint);
    c.shock(x, y, R * 0.72, 1.4, 13, 0xffffff, 3);
    if (fire) for (let i = 0, n = c.n(4 * kk * share); i < n; i++) {
      const pa = c.rnd() * Math.PI * 2, pr = R * c.range(0.05, 0.45);
      c.fire(x + Math.cos(pa) * pr, y + Math.sin(pa) * pr, pa + c.jit(0.8), R * c.range(0.01, 0.04), R * c.range(0.3, 0.52), c.range(16, 28), i % 2 ? tint : hot, COOL, i * c.range(0.6, 1.6));
    }
  }
  // Sparks thrown out: all round to about the ring, or a tight cone along the way out (most of them near its line)
  for (let i = 0, n = c.n((jet ? 18 : 14) * kk * share); i < n; i++) {
    const u = c.jit(2), a = jet ? out + u * Math.abs(u) * 0.5 : any(0);
    c.spark(x, y, a, (Rs * c.range(0.07, jet ? 0.34 : 0.2)) / c.vs, c.range(9, 19), i % 3 ? hot : 0xffffff, c.range(1.2, 2), jet ? 0.9 : 0.87);
  }
  if (jet) for (let i = 0, n = c.n(3 * kk * share); i < n; i++) c.frag(x, y, out + c.jit(0.7), (Rs * c.range(0.05, 0.13)) / c.vs, c.range(1.2, 2.2), c.range(28, 50), hot, 0x6a2410, c.range(0.93, 0.96), c.range(0.4, 0.7));
  // Embers that hang and cool, and smoke rolling up after (down the heading, for a way out)
  for (let i = 0, n = c.n(8 * kk * share); i < n; i++) {
    c.spark(x, y, any(1.2), c.range(0.3, jet ? 2.4 : 1.5) / c.vs, c.range(46, BLAST_LINGER), i % 2 ? tint : hot, c.range(1.3, 2.3), 0.955, COOL);
  }
  for (let i = 0, n = c.n(4 * kk * share); i < n; i++) {
    const pa = c.rnd() * Math.PI * 2, pr = R * c.range(0.1, 0.5);
    c.puff(x + Math.cos(pa) * pr + ux * R * 0.5, y + Math.sin(pa) * pr + uy * R * 0.5, jet ? out + c.jit(0.6) : pa, c.range(0.15, jet ? 1.1 : 0.5) / c.vs, R * c.range(0.24, 0.4), c.range(60, 96), mixColor(SMOKE, tint, 0.12), 0.24, c.range(4, 12));
  }
  c.light(x, y, Math.min(R * 4, 190), 1.1 * kk, 22, tint);

  if (old) {
    old.life = 0; old.k = Math.max(old.k, k); old.d[0] = Math.max(old.d[0], R); old.seed = (c.rnd() * 0x7fffffff) | 0;
    old.anc?.hold(old.max + 2);
    return true;
  }
  if (blastSpots(marks) >= BLAST_MARKS) {
    // (the oldest spot is put out: it is the first of them in the list)
    const first = marks.find((m) => m.draw === hang && m.life < m.max);
    if (first) first.life = first.max;
  }
  c.mark(hang, x, y, jet ? out : 0, BLAST_LINGER, k, R, [R, jet ? 1 : 0, tint]);
  return true;
}
