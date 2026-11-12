/** Rapid: stuttering after-flashes and thrown brass at the muzzle, a short bright dash with stutter marks behind it, small sparks peppered round the hit */

import { mixColor } from '../particleTypes';
import { GREY, type ModLayer } from './kit';

const BRASS = 0xe0b860;

export const rapid: ModLayer = {
  muzzle(c, k) {
    const L = c.look.n;
    // After-flashes: quick pops a beat or two behind the shot, never in the same place, a spark off each
    for (let i = 0, n = c.n(L.pops * (0.34 + 0.66 * k)); i < n; i++) {
      const d = c.s * c.range(0.15, 0.9), off = c.jit(c.s * 0.4), delay = 2 + i * c.range(1.4, 2.6);
      const x = c.x + c.ux * d + c.nx * off, y = c.y + c.uy * d + c.ny * off;
      c.glow(x, y, c.s * c.range(0.35, 0.6) * (0.6 + 0.4 * k), 3.5, i & 1 ? c.color : c.look.hot, true, delay);
      c.spark(x, y, c.a + c.jit(0.5), c.s * c.range(0.15, 0.4), c.range(3, 7), c.look.hot, c.range(1, 1.6), 0.85);
    }
    // Brass and bright flecks flung to the side
    for (let i = 0, n = c.n(L.brass * k); i < n; i++) {
      const a = c.a + (c.rnd() < 0.5 ? 1 : -1) * c.range(1.1, 1.9);
      c.spark(c.x, c.y, a, c.range(1.2, 3.6), c.range(18, 34), BRASS, c.range(1.8, 2.8), 0.94);
    }
    for (let i = 0, n = c.n(L.flecks * (0.3 + 0.7 * k)); i < n; i++) {
      const a = c.a + (c.rnd() < 0.5 ? 1 : -1) * c.range(0.4, 1.5);
      c.spark(c.x, c.y, a, c.range(2.5, 7.5), c.range(5, 12), c.rnd() < 0.5 ? 0xffffff : c.color, c.range(0.8, 1.4), 0.86);
    }
    // Cordite: thin grey wisps off the breech, curling either way
    for (let i = 0, n = c.n(5 * k); i < n; i++) {
      c.puff(c.x + c.ux * c.s * c.range(0, 0.5), c.y + c.uy * c.s * c.range(0, 0.5), c.a + (i & 1 ? 1 : -1) * c.range(0.5, 1.6), c.range(0.4, 1.4), c.s * c.range(0.14, 0.28), c.range(20, 36), GREY, 0.18, i * 1.5);
    }
  },

  flight(c, k) {
    const L = c.look.n, a = c.alpha, bw = c.s * (0.8 + 0.5 * k), span = c.dl * (1 + 0.8 * k), n = 3 + Math.round(L.echoes * k);
    // The tracer chopped into a string of beads and broken dashes, uneven, each flickering on its own beat
    let d = 0;
    for (let i = 0; i < n; i++) {
      const cell = span / n, len = cell * (0.35 + 0.4 * c.h(i)), fade = 1 - (0.6 * i) / n;
      if (Math.sin(c.clock * (1.7 + c.h(i + 9)) + i * 2.1) > -0.45) {
        c.line(c.x - c.ux * d, c.y - c.uy * d, c.x - c.ux * (d + len), c.y - c.uy * (d + len), bw, i & 1 ? c.color : mixColor(c.color, 0xffffff, 0.6), 0.85 * a * (0.3 + 0.7 * k) * fade);
        c.dot(c.x - c.ux * d, c.y - c.uy * d, bw * 0.9, 0xffffff, 0.75 * a * k * fade);
      }
      d += cell;
    }
  },

  impact(c, k) {
    const L = c.look.n;
    // Peppered: hard pops scattered round the hit over a few frames, sparks and a nick of light off each
    for (let i = 0, n = c.n(L.pepper * (0.3 + 0.7 * k)); i < n; i++) {
      const pa = c.rnd() * Math.PI * 2, pr = c.s * c.range(0.4, 1.6), x = c.x + Math.cos(pa) * pr, y = c.y + Math.sin(pa) * pr;
      c.glow(x, y, c.s * c.range(0.35, 0.6), 4, i & 1 ? c.color : 0xffffff, true, i * c.range(1, 2.4));
      if (i & 1) c.flare(x, y, c.out + c.jit(2.4), c.s * c.range(0.6, 1.3), 0.9, 5, c.color);
      c.spark(x, y, c.out + c.jit(3), c.range(1.5, 4.5), c.range(4, 9), 0xffffff, c.range(0.8, 1.2), 0.88);
      c.spark(x, y, c.out + c.jit(2.2), c.range(2.5, 7), c.range(5, 11), c.color, c.range(0.9, 1.5), 0.88);
    }
  },

  beam(b, k) {
    // The beam stutters: short hot lengths marching down it in steps
    const hz = 16 + 14 * k;
    for (let i = 0, n = 2 + Math.round(3 * k); i < n; i++) {
      const d = b.hs(i, hz) * b.len, l = (6 + 14 * b.hs(i + 11, hz)) * (0.5 + 0.5 * k);
      b.line(b.px(d, 0), b.py(d, 0), b.px(Math.min(b.len, d + l), 0), b.py(Math.min(b.len, d + l), 0), b.wid * (0.5 + 0.4 * k), mixColor(b.color, 0xffffff, 0.5), 0.6 * k * b.gain);
    }
  },

  beamEnd(b, k) {
    if (!b.hit) return;
    for (let i = 0, n = 2 + Math.round(3 * k); i < n; i++) {
      const a = b.hs(i, 20) * Math.PI * 2, r = (3 + 9 * b.hs(i + 4, 20)) * (0.5 + 0.5 * k);
      b.dot(b.x1 + Math.cos(a) * r, b.y1 + Math.sin(a) * r, 0.8 + 1.4 * b.hs(i + 8, 20), i & 1 ? 0xffffff : b.color, 0.85 * k * b.gain);
    }
  },
};
