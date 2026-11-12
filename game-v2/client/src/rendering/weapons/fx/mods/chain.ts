/**
 * Chain: arcs crackling round the muzzle and the shell, and forked lightning off the hit. The hit's own forks ground out
 * a short way off it (which targets the chain jumps to is not known where the hit is drawn); a jump to a known target is
 * `chainArc` (index.ts), the same bolt between two points.
 */

import type { MarkDraw, ModLayer } from './kit';
import { MECH } from './looks';

/** Frames between a bolt's new shapes */
const CRACKLE = 2;

/** Arcs off a point: m.d holds each one's angle (off m.a) and reach; re-thrown every other frame, flickering */
const arcs: MarkDraw = (c, m) => {
  const f = 1 - m.life / m.max;
  for (let i = 0; i + 1 < m.d.length; i += 2) {
    // (each arc is out for some frames and dark for others)
    if (c.rnd() < 0.25) continue;
    const a = m.a + m.d[i], r = m.d[i + 1], x = m.x + Math.cos(a) * r, y = m.y + Math.sin(a) * r;
    c.bolt(m.x, m.y, x, y, r * 0.22, 4, m.color, f * (0.4 + 0.6 * m.k), 0.9 + 0.5 * m.k);
  }
  c.dot(m.x, m.y, m.s * 0.16 * f, m.color, 0.5 * f * m.k);
};

/**
 * A bolt between two points (m.d: the far end's offset along and across m.a, then where it forks and the fork's offset):
 * re-thrown every other frame, a knot of light at its far end
 */
export const strike: MarkDraw = (c, m) => {
  const f = 1 - m.life / m.max, al = Math.pow(f, 0.7) * (0.4 + 0.6 * m.k);
  const x1 = m.x + c.ux * m.d[0] + c.nx * m.d[1], y1 = m.y + c.uy * m.d[0] + c.ny * m.d[1], len = Math.hypot(m.d[0], m.d[1]);
  c.bolt(m.x, m.y, x1, y1, len * 0.16, Math.max(4, Math.min(8, Math.round(len / 9))), m.color, al, 1 + 0.6 * m.k);
  if (m.d.length > 2) {
    const t = m.d[2], fx = m.x + (x1 - m.x) * t, fy = m.y + (y1 - m.y) * t;
    c.bolt(fx, fy, fx + c.ux * m.d[3] + c.nx * m.d[4], fy + c.uy * m.d[3] + c.ny * m.d[4], len * 0.1, 3, m.color, al * 0.7, 0.8);
  }
  c.ball(x1, y1, 2 + 3 * m.k * f, m.color, 0.8 * al);
};

export const chain: ModLayer = {
  muzzle(c, k) {
    const L = c.look.n, d: number[] = [];
    for (let i = 0, n = Math.max(1, Math.round(L.arcs * (0.3 + 0.7 * k))); i < n; i++) d.push(c.jit(Math.PI * 1.5), c.s * L.reach * c.range(0.4, 1) * (0.5 + 0.5 * k));
    c.mark(arcs, c.x, c.y, c.a, 7 + 5 * k, k, c.s, d);
    for (let i = 0, n = c.n(3 * k); i < n; i++) c.spark(c.x, c.y, c.a + c.jit(2.6), c.range(2, 6), c.range(4, 9), i & 1 ? 0xffffff : c.color, 0.9, 0.85);
  },

  flight(c, k) {
    const L = c.look.n, a = c.alpha, r = c.s * L.orbit * (0.5 + 0.5 * k);
    // Arcs jumping off the shell: one or two at a time, never where the last was
    for (let i = 0, n = 1 + (k > 0.5 ? 1 : 0); i < n; i++) {
      if (c.rnd() > 0.35 + 0.55 * k) continue;
      const ang = c.rnd() * Math.PI * 2, rr = r * c.range(0.5, 1.1), back = c.dl * c.range(0, 0.5);
      c.bolt(c.x - c.ux * back * 0.3, c.y - c.uy * back * 0.3, c.x - c.ux * back + Math.cos(ang) * rr, c.y - c.uy * back + Math.sin(ang) * rr, rr * 0.3, 3, c.color, a * (0.35 + 0.65 * k), 0.8 + 0.4 * k);
    }
    c.dot(c.x, c.y, c.s * (1.2 + 1.2 * k), c.color, 0.3 * a * k);
  },

  impact(c, k) {
    const L = c.look.n, reach = MECH.chainReach * L.ground * (0.45 + 0.55 * k);
    // Forks off the hit, thrown wide of the way the shot came in, each its own length, each forking once
    for (let i = 0, n = Math.max(1, Math.round(Math.min(MECH.chainJumps, L.bolts) * (0.25 + 0.75 * k))); i < n; i++) {
      const a = (i - (n - 1) / 2) * (2.2 / Math.max(1, n)) + c.jit(0.7), r = reach * c.range(0.45, 1), fa = a + (c.rnd() < 0.5 ? 1 : -1) * c.range(0.5, 1.1), fr = r * c.range(0.25, 0.5);
      c.mark(strike, c.x, c.y, c.a, 8 + 6 * k, k, c.s, [Math.cos(a) * r, Math.sin(a) * r, L.forkAt * c.range(0.7, 1.2), Math.cos(fa) * fr, Math.sin(fa) * fr], i * c.range(0.5, 1.6));
    }
    c.glow(c.x, c.y, c.s * (0.3 + 0.4 * k), 6, 0xffffff, true);
    for (let i = 0, n = c.n(5 * k); i < n; i++) c.spark(c.x, c.y, c.rnd() * Math.PI * 2, c.range(2, 7), c.range(4, 9), i & 1 ? 0xffffff : c.color, 0.9, 0.84);
    c.light(c.x, c.y, reach * 2.5, 0.9 * k, 10);
  },

  beam(b, k) {
    // Arcs crawling down the beam: each a stretch of it, leaping off one side and back
    for (let i = 0, n = 1 + Math.round(2 * k); i < n; i++) {
      const span = (24 + 40 * b.h(i)) * (0.6 + 0.4 * k), p = (b.t * (0.5 + 0.4 * b.h(i + 3)) + b.h(i + 6)) % 1, d0 = p * Math.max(1, b.len - span), d1 = Math.min(b.len, d0 + span);
      if (b.hs(i + 40, 30 / CRACKLE) < 0.2) continue;
      const side = b.hs(i + 20, 6) < 0.5 ? -1 : 1, off = side * b.wid * 0.3;
      b.bolt(b.px(d0, off), b.py(d0, off), b.px(d1, -off), b.py(d1, -off), b.wid * 0.9 + 2.5 + 3 * k, 5, i, 30 / CRACKLE, b.color, b.gain * (0.35 + 0.65 * k), 0.9 + 0.4 * k);
    }
  },

  beamEnd(b, k) {
    if (!b.hit) return;
    const back = Math.atan2(-b.uy, -b.ux);
    for (let i = 0, n = 2 + Math.round(2 * k); i < n; i++) {
      if (b.hs(i + 50, 15) < 0.3) continue;
      const a = back + (b.h(i + 60) - 0.5) * 4.4 + (b.hs(i + 70, 5) - 0.5) * 0.6, r = (8 + 18 * b.h(i + 80)) * (0.45 + 0.55 * k);
      b.bolt(b.x1, b.y1, b.x1 + Math.cos(a) * r, b.y1 + Math.sin(a) * r, r * 0.22, 4, i + 9, 15, b.color, b.gain * (0.35 + 0.65 * k), 0.9);
    }
  },
};
