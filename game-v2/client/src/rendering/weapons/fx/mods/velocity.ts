/** Velocity: a tight shock cone and speed streaks at the muzzle, a longer hotter tracer with a faint wake, a narrow spray punched on through the hit */

import { mixColor } from '../particleTypes';
import { ease, type MarkDraw, type ModLayer } from './kit';

/** The shock cone: two hard edges opening forward off the muzzle with a pale sheet between, gone in a few frames */
const cone: MarkDraw = (c, m) => {
  const n = m.life / m.max, f = 1 - n, L = m.s * m.look.n.reach * (0.35 + 0.65 * m.k) * ease(n * 1.6), half = m.look.n.cone * (0.6 + 0.4 * m.k);
  const x0 = m.x + c.ux * L * 0.25 * n, y0 = m.y + c.uy * L * 0.25 * n;
  for (let side = -1; side <= 1; side += 2) {
    const a = m.a + side * half * (0.85 + 0.3 * c.h(side + 2)), l = L * (0.8 + 0.4 * c.h(side + 5));
    c.line(x0, y0, m.x + Math.cos(a) * l, m.y + Math.sin(a) * l, 1.1 + (1.2 + m.s * 0.03) * m.k * f, m.color, 0.75 * f * (0.4 + 0.6 * m.k));
    c.line(x0, y0, m.x + Math.cos(a) * l * 0.7, m.y + Math.sin(a) * l * 0.7, 0.7, 0xffffff, 0.8 * f * f);
  }
  c.petal(x0, y0, m.a, L * 0.9, L * Math.tan(half) * 0.55, mixColor(m.color, 0xffffff, 0.4), 0.3 * f * (0.4 + 0.6 * m.k));
};

export const velocity: ModLayer = {
  muzzle(c, k) {
    const L = c.look.n;
    c.mark(cone, c.x, c.y, c.a, 6 + 4 * k, k, c.s);
    // A lance of light down the line, a hard white kernel where it left
    c.flare(c.x, c.y, c.a + c.jit(0.03), c.s * (2.2 + 3.4 * k), 1.2 + 0.8 * k, 7, c.color);
    c.glow(c.x + c.ux * c.s * 0.2, c.y + c.uy * c.s * 0.2, c.s * (0.3 + 0.25 * k), 5, 0xffffff, true);
    // Speed streaks: thin, fast, straight down the line, no two alike
    for (let i = 0, n = c.n(L.streaks * (0.3 + 0.7 * k)); i < n; i++) {
      const a = c.a + c.jit(L.cone * 1.2), off = c.jit(c.s * 0.3);
      c.spark(c.x + c.nx * off, c.y + c.ny * off, a, c.s * c.range(0.5, 1.4) * (0.6 + 0.4 * k), c.range(6, 13), c.rnd() < 0.4 ? 0xffffff : c.color, c.range(0.9, 1.6), 0.86);
    }
    // The air it tore through, left hanging in a string ahead of the barrel
    for (let i = 0, n = c.n(5 * k); i < n; i++) {
      const d = c.s * c.range(0.4, 2.6);
      c.puff(c.x + c.ux * d, c.y + c.uy * d, c.a, c.range(0.6, 1.8), c.s * c.range(0.14, 0.3), c.range(18, 32), mixColor(c.color, 0xffffff, 0.5), 0.16 * (0.4 + 0.6 * k), i);
    }
    // (fine shavings thrown off to the sides)
    for (let i = 0, n = c.n(4 * k); i < n; i++) c.spark(c.x, c.y, c.a + (i & 1 ? 1 : -1) * c.range(0.9, 1.4), c.range(2, 5), c.range(5, 9), c.color, c.range(0.7, 1.1), 0.86);
  },

  flight(c, k) {
    const L = c.look.n, a = c.alpha, back = c.dl * L.wake * k, w = c.s * (0.5 + 0.5 * k);
    // The tracer drawn on well past its tail, hot: a wide line of its colour, a white core, a bright head
    c.line(c.bx - c.ux * back, c.by - c.uy * back, c.x, c.y, 1 + w, c.color, 0.55 * a * (0.3 + 0.7 * k));
    c.line(c.bx - c.ux * back * 0.6, c.by - c.uy * back * 0.6, c.x, c.y, 0.6 + w * 0.4, 0xffffff, 0.8 * a * k);
    c.dot(c.x, c.y, c.s * (1 + k), 0xffffff, 0.7 * a * k);
    // Its wake: pairs of streaks opening back off it at stations down its length, each its own reach
    const span = c.dl + back;
    for (let i = 0; i < 3; i++) {
      const d = span * (0.03 + 0.3 * i + 0.1 * c.h(i)), ox = c.x - c.ux * d, oy = c.y - c.uy * d;
      const ll = (c.s * 4 + c.dl * 0.22) * (0.4 + 0.6 * k) * (1 - 0.2 * i), open = c.s * (0.9 + 1.4 * k) * (1 + 0.5 * i);
      for (let side = -1; side <= 1; side += 2) {
        const l = ll * (0.6 + 0.7 * c.h(i * 2 + side + 4));
        c.line(ox, oy, ox - c.ux * l + c.nx * side * open, oy - c.uy * l + c.ny * side * open, 0.8 + c.s * 0.14, i ? c.color : mixColor(c.color, 0xffffff, 0.5), 0.6 * a * k * (1 - 0.25 * i));
      }
    }
    // (sparks stripped off it, falling behind)
    for (let i = 0, n = c.n(0.6 * k * c.frames); i < n; i++) c.spark(c.x, c.y, c.a + Math.PI + (c.rnd() < 0.5 ? 1 : -1) * c.range(0.15, 0.45), c.range(1, 3), c.range(6, 11), c.color, c.range(0.8, 1.2), 0.9);
  },

  impact(c, k) {
    const L = c.look.n;
    // Punched on through: a lance out the far side with two shorter beside it, and a narrow fast spray along the shot
    c.flare(c.x, c.y, c.a + c.jit(0.05), c.s * (2.4 + 4 * k), 1.4 + 0.8 * k, 9, c.color);
    for (let side = -1; side <= 1; side += 2) c.flare(c.x, c.y, c.a + side * c.range(0.08, 0.2), c.s * c.range(1.2, 2.4) * (0.4 + 0.6 * k), 1, 7, 0xffffff);
    c.glow(c.x, c.y, c.s * (0.45 + 0.4 * k), 6, 0xffffff, true);
    for (let i = 0, n = c.n(L.punch * (0.25 + 0.75 * k)); i < n; i++) {
      const u = c.jit(2), a = c.a + u * Math.abs(u) * 0.22;
      c.spark(c.x, c.y, a, L.punchSpeed * c.range(0.4, 1.15) * (0.6 + 0.4 * k), c.range(9, 17), c.rnd() < 0.35 ? 0xffffff : c.color, c.range(1, 2), 0.9);
    }
    for (let i = 0, n = c.n(3 * k); i < n; i++) {
      const d = c.s * c.range(0.5, 2.2);
      c.puff(c.x + c.ux * d, c.y + c.uy * d, c.a, c.range(0.8, 2), c.s * c.range(0.2, 0.36), c.range(16, 28), mixColor(c.color, 0xffffff, 0.5), 0.16, i * 2);
    }
  },

  beam(b, k) {
    // Bright dashes racing down the beam, each its own length and pace
    for (let i = 0, n = 2 + Math.round(4 * k); i < n; i++) {
      const p = (b.t * (2.2 + 1.6 * b.h(i)) + b.h(i + 9)) % 1, l = (10 + 22 * b.h(i + 20)) * (0.5 + 0.5 * k), d = p * (b.len + l) - l;
      const d0 = Math.max(0, d), d1 = Math.min(b.len, d + l), off = (b.h(i + 30) - 0.5) * b.wid * 0.9;
      if (d1 > d0) b.line(b.px(d0, off), b.py(d0, off), b.px(d1, off), b.py(d1, off), 0.9 + 0.6 * k, i % 3 ? 0xffffff : b.color, 0.75 * k * b.gain * Math.sin(p * Math.PI));
    }
  },

  beamEnd(b, k) {
    if (!b.hit) return;
    // A needle spray punched on past the end
    for (let i = 0; i < 4; i++) {
      const a = Math.atan2(b.uy, b.ux) + (b.hs(i, 22) - 0.5) * 0.3, l = (6 + 16 * b.hs(i + 5, 22)) * (0.4 + 0.6 * k);
      b.line(b.x1, b.y1, b.x1 + Math.cos(a) * l, b.y1 + Math.sin(a) * l, 0.9, i & 1 ? 0xffffff : b.color, 0.7 * k * b.gain);
    }
  },
};
