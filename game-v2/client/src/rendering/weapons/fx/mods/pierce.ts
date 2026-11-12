/** Pierce: a hard needle of light at the muzzle, a thin bright line through the tracer and out past its nose, an entry puff and a jet out the far side of what it hits */

import { mixColor } from '../particleTypes';
import { ease, type MarkDraw, type ModLayer } from './kit';

/** The needle: a long hard line shot forward off the muzzle (a short spike back), thinning away in a few frames */
const needle: MarkDraw = (c, m) => {
  const n = m.life / m.max, f = 1 - n, L = m.s * m.look.n.needle * (0.35 + 0.65 * m.k) * (0.5 + 0.5 * ease(n * 2));
  const x1 = m.x + c.ux * L, y1 = m.y + c.uy * L, x0 = m.x - c.ux * L * 0.16, y0 = m.y - c.uy * L * 0.16;
  c.line(x0, y0, x1, y1, 3.4 * f * (0.5 + 0.5 * m.k) + 0.8, m.color, 0.6 * f);
  c.line(x0, y0, x1, y1, 0.9, 0xffffff, 0.95 * f * (0.4 + 0.6 * m.k));
  c.dot(m.x, m.y, m.s * 0.14 * f, 0xffffff, 0.8 * f * m.k);
};

/** The skewer: the line it drove through what it hit, entry to exit, for a few frames */
const skewer: MarkDraw = (c, m) => {
  const f = 1 - m.life / m.max, d = m.d[0];
  c.line(m.x, m.y, m.x + c.ux * d, m.y + c.uy * d, 2.8 * f + 0.8, m.color, 0.6 * f * m.k);
  c.line(m.x, m.y, m.x + c.ux * d, m.y + c.uy * d, 1.1, 0xffffff, 0.9 * f * f * m.k);
};

export const pierce: ModLayer = {
  muzzle(c, k) {
    c.mark(needle, c.x, c.y, c.a, 6 + 4 * k, k, c.s);
    // A thin white lance far down the line, a short spike back, a hard point between
    c.flare(c.x, c.y, c.a, c.s * (3 + 4 * k), 0.8 + 0.3 * k, 6, 0xffffff);
    c.flare(c.x, c.y, c.a + Math.PI + c.jit(0.1), c.s * (0.6 + 0.8 * k), 0.9, 5, c.color);
    c.glow(c.x, c.y, c.s * (0.2 + 0.16 * k), 4, 0xffffff, true);
    for (let i = 0, n = c.n(8 * k); i < n; i++) c.spark(c.x + c.ux * c.s * c.range(0, 0.6), c.y + c.uy * c.s * c.range(0, 0.6), c.a + c.jit(0.07), c.s * c.range(0.6, 1.5), c.range(5, 10), i % 3 ? 0xffffff : c.color, c.range(0.9, 1.4), 0.84);
    // (a breath of fine vapour off the bore, left behind)
    for (let i = 0, n = c.n(3 * k); i < n; i++) c.puff(c.x + c.ux * c.s * c.range(0.2, 1.2), c.y + c.uy * c.s * c.range(0.2, 1.2), c.a + (i & 1 ? 1 : -1) * c.range(1.2, 1.7), c.range(0.3, 0.9), c.s * c.range(0.1, 0.18), c.range(14, 24), mixColor(c.color, 0xffffff, 0.5), 0.14);
  },

  flight(c, k) {
    const L = c.look.n, a = c.alpha, tip = c.s * L.tip * (0.4 + 0.6 * k) + c.dl * 0.45 * k, back = c.dl * 0.3 * k;
    const x1 = c.x + c.ux * tip, y1 = c.y + c.uy * tip, x0 = c.bx - c.ux * back, y0 = c.by - c.uy * back;
    // A hard needle run through the shell from behind its tail to well ahead of its nose
    c.line(x0, y0, x1, y1, 1.8 + 1.4 * k + c.s * 0.15, c.color, 0.5 * a * (0.3 + 0.7 * k));
    c.line(x0, y0, x1, y1, 0.9 + 0.4 * k, 0xffffff, 0.95 * a * (0.25 + 0.75 * k));
    // Its point: two barbs swept back off it (each its own length)
    const bl = c.s * (1.6 + 2.2 * k), bo = c.s * (0.5 + 0.7 * k);
    for (let side = -1; side <= 1; side += 2) {
      const l = bl * (0.75 + 0.5 * c.h(side + 2));
      c.line(x1, y1, x1 - c.ux * l + c.nx * side * bo, y1 - c.uy * l + c.ny * side * bo, 0.9 + 0.5 * k, 0xffffff, 0.85 * a * k);
    }
    c.dot(x1, y1, 1.2 + 1.2 * k, 0xffffff, a * k);
  },

  impact(c, k) {
    const L = c.look.n, depth = L.depth * (0.5 + 0.5 * k) * c.range(0.8, 1.2) * Math.max(1, c.s / 16), ex = c.x + c.ux * depth, ey = c.y + c.uy * depth;
    c.mark(skewer, c.x, c.y, c.a, 9 + 5 * k, k, c.s, [depth]);
    // Coming out the far side: a lance and a tight jet along the shot
    c.flare(ex, ey, c.a, c.s * (2.2 + 3.6 * k), 1.4 + 0.8 * k, 9, c.color);
    c.glow(ex, ey, c.s * (0.35 + 0.35 * k), 6, 0xffffff, true, 1);
    for (let i = 0, n = c.n(L.jet * (0.25 + 0.75 * k)); i < n; i++) {
      const u = c.jit(2);
      c.spark(ex, ey, c.a + u * Math.abs(u) * 0.18, L.jetSpeed * c.range(0.35, 1.1) * (0.6 + 0.4 * k), c.range(8, 16), c.rnd() < 0.4 ? 0xffffff : c.color, c.range(1, 2), 0.9);
    }
    for (let i = 0, n = c.n(2 * k); i < n; i++) c.puff(ex, ey, c.a + c.jit(0.5), c.range(0.8, 2), c.s * c.range(0.2, 0.34), c.range(16, 26), mixColor(c.color, 0xb4aea6, 0.5), 0.2, 1);
    // Going in: a small puff and sparks back off the surface
    for (let i = 0, n = c.n(2 * k); i < n; i++) c.puff(c.x, c.y, c.out + c.jit(0.8), c.range(0.4, 1.1), c.s * c.range(0.22, 0.36), c.range(16, 26), mixColor(c.color, 0xb4aea6, 0.6), 0.2);
    for (let i = 0, n = c.n(5 * k); i < n; i++) c.spark(c.x, c.y, c.out + c.jit(1.2), c.range(1.5, 4.5), c.range(5, 11), c.color, 1.1, 0.88);
  },

  beam(b, k) {
    // A hard thin core, run on through and out past the end
    const over = b.hit ? (10 + 26 * k) * (0.85 + 0.15 * b.hs(1, 20)) : 0;
    b.line(b.x0, b.y0, b.px(b.len + over, 0), b.py(b.len + over, 0), 1.6 + 1.2 * k, b.color, 0.4 * b.gain * (0.3 + 0.7 * k));
    b.line(b.x0, b.y0, b.px(b.len + over, 0), b.py(b.len + over, 0), 0.8, 0xffffff, 0.95 * b.gain * (0.3 + 0.7 * k));
  },

  beamEnd(b, k) {
    if (!b.hit) return;
    // The jet out the far side
    const d = b.len + 8 + 10 * k, a0 = Math.atan2(b.uy, b.ux);
    for (let i = 0; i < 4; i++) {
      const a = a0 + (b.hs(i, 24) - 0.5) * 0.24, l = (5 + 14 * b.hs(i + 4, 24)) * (0.4 + 0.6 * k);
      b.line(b.px(d, 0), b.py(d, 0), b.px(d, 0) + Math.cos(a) * l, b.py(d, 0) + Math.sin(a) * l, 0.9, i & 1 ? b.color : 0xffffff, 0.75 * k * b.gain);
    }
  },
};
