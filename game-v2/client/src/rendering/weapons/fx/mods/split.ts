/** Split: a three-way prismatic fork at the muzzle, a thin coloured sliver behind each shell, three small splinter bursts at the hit */

import { turnHue } from '../particleTypes';
import type { MarkDraw, ModLayer } from './kit';

/** The fork: three blades of light off the muzzle, the outer two turned either way round the hue wheel, each its own length */
const fork: MarkDraw = (c, m) => {
  const n = m.life / m.max, f = 1 - n, L = m.look.n, spread = L.fork * (0.5 + 0.5 * m.k);
  for (let i = -1; i <= 1; i++) {
    const a = m.a + i * spread * (0.85 + 0.3 * c.h(i + 3)), len = m.s * (1.8 + 2.4 * m.k) * (0.7 + 0.6 * c.h(i + 8)) * (0.5 + 0.5 * Math.min(1, n * 4));
    const col = i === 0 ? 0xffffff : turnHue(m.color, i * L.hue);
    c.petal(m.x, m.y, a, len, m.s * 0.16 * (1 + m.k), col, 0.8 * f * (0.35 + 0.65 * m.k));
    c.line(m.x, m.y, m.x + Math.cos(a) * len * 0.8, m.y + Math.sin(a) * len * 0.8, 0.8, 0xffffff, 0.7 * f * f * m.k);
  }
};

export const split: ModLayer = {
  muzzle(c, k) {
    const L = c.look.n;
    c.mark(fork, c.x, c.y, c.a, 7 + 4 * k, k, c.s);
    // A bead of each blade's colour out along it, and shards flung down all three
    for (let side = -1; side <= 1; side++) {
      const a = c.a + side * L.fork * (0.5 + 0.5 * k), d = c.s * c.range(0.6, 1.2);
      c.glow(c.x + Math.cos(a) * d, c.y + Math.sin(a) * d, c.s * (0.2 + 0.2 * k), 5, side ? turnHue(c.color, side * L.hue) : 0xffffff, true, 1 + c.range(0, 2));
    }
    for (let i = 0, n = c.n(L.glints * k); i < n; i++) {
      const side = (i % 3) - 1;
      c.spark(c.x, c.y, c.a + side * L.fork * 0.8 + c.jit(0.25), c.s * c.range(0.25, 0.7), c.range(7, 15), side ? turnHue(c.color, side * L.hue) : 0xffffff, c.range(0.9, 1.6), 0.88);
    }
    for (let i = 0, n = c.n(3 * k); i < n; i++) c.puff(c.x + c.ux * c.s * 0.3, c.y + c.uy * c.s * 0.3, c.a + ((i % 3) - 1) * L.fork + c.jit(0.2), c.range(0.8, 2), c.s * c.range(0.14, 0.24), c.range(16, 26), turnHue(c.color, ((i % 3) - 1) * L.hue), 0.14);
  },

  flight(c, k) {
    const L = c.look.n, a = c.alpha, turn = (c.h(0) - 0.5) * 2 * L.hue, col = turnHue(c.color, turn);
    // Coloured slivers peeling back off the head, one to each side in its own hue, each running on behind
    for (let side = -1; side <= 1; side += 2) {
      const hc = turnHue(c.color, side * L.hue), ll = (c.dl * 0.5 + c.s * 4) * (0.6 + 0.6 * c.h(side + 2)) * (0.4 + 0.6 * k), open = c.s * (1.2 + 1.8 * k) * (0.8 + 0.4 * c.h(side + 5));
      const px = c.x - c.ux * ll + c.nx * side * open, py = c.y - c.uy * ll + c.ny * side * open;
      c.line(c.x, c.y, px, py, 1 + 0.6 * k + c.s * 0.12, hc, 0.75 * a * (0.3 + 0.7 * k));
      c.line(px, py, px - c.ux * ll * L.sliver * 0.5, py - c.uy * ll * L.sliver * 0.5, 0.8, hc, 0.4 * a * k);
    }
    // (a glint on its nose, twinkling)
    const tw = 0.5 + 0.5 * Math.sin(c.clock * 1.3 + c.h(2) * 6.3);
    c.dot(c.x, c.y, c.s * (1 + 0.8 * tw), col, 0.6 * a * k);
    c.line(c.x - c.nx * c.s * 2.4 * tw, c.y - c.ny * c.s * 2.4 * tw, c.x + c.nx * c.s * 2.4 * tw, c.y + c.ny * c.s * 2.4 * tw, 0.8, 0xffffff, 0.7 * a * k * tw);
    // (shards of colour shed sideways)
    for (let i = 0, n = c.n(0.5 * k * c.frames); i < n; i++) {
      const side = c.rnd() < 0.5 ? 1 : -1;
      c.spark(c.x, c.y, c.a + side * c.range(1.2, 1.9), c.range(1, 2.6), c.range(6, 11), turnHue(c.color, side * L.hue), c.range(0.8, 1.2), 0.9);
    }
  },

  impact(c, k) {
    const L = c.look.n;
    // Three splinter bursts, one after another, across the hit: each a pop, a blade and shards in its hue
    for (let i = 0; i < L.splinters; i++) {
      const side = i - 1, col = side ? turnHue(c.color, side * L.hue) : 0xffffff;
      const along = c.s * c.range(-0.2, 0.5), across = side * c.s * c.range(0.7, 1.4) * (0.5 + 0.5 * k);
      const x = c.x + c.ux * along + c.nx * across, y = c.y + c.uy * along + c.ny * across, out = c.out + side * c.range(0.4, 0.9);
      c.glow(x, y, c.s * (0.4 + 0.4 * k), 6, col, true, i * c.range(1.2, 2.4));
      c.flare(x, y, out, c.s * c.range(1.4, 2.8) * (0.4 + 0.6 * k), 1.2, 8, col);
      for (let j = 0, n = c.n(5 * k); j < n; j++) c.spark(x, y, out + c.jit(0.9), c.range(2, 7), c.range(8, 16), col, c.range(1, 1.8), 0.89);
    }
  },

  beam(b, k) {
    const L = b.look.n, off = b.wid * 0.7 + 1.5 + 3.5 * k, lead = Math.min(b.len * 0.3, 26);
    // Two thin beams split off either side, each its own hue, weaving a little
    for (let side = -1; side <= 1; side += 2) {
      const col = turnHue(b.color, side * L.hue), g = b.g;
      g.moveTo(b.x0, b.y0);
      for (let j = 1; j <= 8; j++) {
        const d = lead + ((b.len - lead) * (j - 1)) / 7, o = side * off * (1 + 0.14 * Math.sin(d * 0.07 - b.t * 5 + side + b.h(3) * 6));
        g.lineTo(b.px(d, o), b.py(d, o));
      }
      g.stroke({ color: col, width: 0.9 + 0.8 * k, alpha: 0.75 * b.gain * (0.3 + 0.7 * k) });
    }
  },

  beamEnd(b, k) {
    if (!b.hit) return;
    const L = b.look.n, off = b.wid * 0.7 + 1.5 + 3.5 * k;
    for (let side = -1; side <= 1; side++) {
      const col = side ? turnHue(b.color, side * L.hue) : 0xffffff, x = b.px(b.len, side * off), y = b.py(b.len, side * off);
      b.dot(x, y, (1.2 + 1.6 * k) * (0.7 + 0.5 * b.hs(side + 2, 18)), col, 0.85 * k * b.gain);
      const a = Math.atan2(-b.uy, -b.ux) + side * 0.7 + (b.hs(side + 6, 18) - 0.5) * 0.8, l = (3 + 7 * b.hs(side + 9, 18)) * (0.5 + 0.5 * k);
      b.line(x, y, x + Math.cos(a) * l, y + Math.sin(a) * l, 0.8, col, 0.7 * k * b.gain);
    }
  },
};
