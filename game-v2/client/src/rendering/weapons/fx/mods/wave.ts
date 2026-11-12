/** Wave: a broad pressure front off the muzzle, a wide crescent carried with the shell (as wide as its wave is), and a wash swept on across what it hits */

import { mixColor } from '../particleTypes';
import { ease, type MarkDraw, type ModCtx, type ModLayer } from './kit';
import { MECH } from './looks';

/** A wave's half-width off a thing of size `s` at strength k: the mechanic's own widening */
const halfWidth = (c: { look: { n: Record<string, number> } }, s: number, k: number): number => s * c.look.n.base * (1 + (MECH.wave - 1) * k);

/** The muzzle's pressure front: a crescent thrown forward, widening as it goes */
const front: MarkDraw = (c, m) => {
  const n = m.life / m.max, f = 1 - n, go = ease(n), hw = m.s * (0.9 + 1.8 * m.k) * (0.45 + 0.75 * go), d = m.s * (0.3 + 2.2 * go);
  c.crescent(m.x + c.ux * d, m.y + c.uy * d, c.ux, c.uy, hw, m.look.n.bow, 3 + 3 * m.k * f, m.color, 0.7 * f * (0.35 + 0.65 * m.k));
  c.crescent(m.x + c.ux * d, m.y + c.uy * d, c.ux, c.uy, hw * 0.8, m.look.n.bow, 0.9, 0xffffff, 0.7 * f * f * m.k, 5);
};

/** The wash: the front carried on across what it hit, spreading and thinning */
const wash: MarkDraw = (c, m) => {
  const n = m.life / m.max, f = 1 - n, go = ease(n), hw = m.d[0] * (1 + 0.5 * go), d = m.s * m.look.n.wash * go * (0.4 + 0.6 * m.k);
  c.crescent(m.x + c.ux * d, m.y + c.uy * d, c.ux, c.uy, hw, m.look.n.bow * (1 - 0.5 * go), 3 + 4 * f, m.color, 0.8 * f * (0.35 + 0.65 * m.k));
  c.crescent(m.x + c.ux * d * 0.6, m.y + c.uy * d * 0.6, c.ux, c.uy, hw * 0.85, m.look.n.bow * 0.6, 1.6 + 5 * f, mixColor(m.color, 0xffffff, 0.5), 0.4 * f * m.k, 5);
};

function flightFront(c: ModCtx, k: number): void {
  const L = c.look.n, a = c.alpha, hw = halfWidth(c, c.s, k);
  // (a breath in its width, each shell on its own beat)
  const br = 1 + 0.06 * Math.sin(c.clock * 0.5 + c.h(0) * 6.3);
  c.crescent(c.x, c.y, c.ux, c.uy, hw * br, L.bow, 1.6 + 1.6 * k, c.color, 0.7 * a * (0.3 + 0.7 * k));
  c.crescent(c.x + c.ux * 0.6, c.y + c.uy * 0.6, c.ux, c.uy, hw * br * 0.86, L.bow, 0.8, c.look.hot, 0.75 * a * k, 5);
  // Fainter fronts following it, unevenly spaced
  let d = 0;
  for (let i = 0, n = Math.round(L.echoes * (0.5 + 0.5 * k)); i < n; i++) {
    d += c.s * (1.6 + 1.8 * c.h(i + 1));
    c.crescent(c.x - c.ux * d, c.y - c.uy * d, c.ux, c.uy, hw * (0.84 - 0.16 * i), L.bow, 1.1, c.color, 0.3 * a * k * (1 - i / (n + 1)), 5);
  }
}

export const wave: ModLayer = {
  muzzle(c, k) {
    c.mark(front, c.x, c.y, c.a, 9 + 5 * k, k, c.s);
    c.mark(front, c.x, c.y, c.a, 9 + 5 * k, k * 0.6, c.s * 0.8, [], 3);
    // Spray whipped off the front's two tips
    for (let i = 0, n = c.n(6 * k); i < n; i++) {
      const side = i & 1 ? 1 : -1;
      c.spark(c.x + c.ux * c.s * 0.4 + c.nx * side * c.s * c.range(0.3, 0.9), c.y + c.uy * c.s * 0.4 + c.ny * side * c.s * c.range(0.3, 0.9), c.a + side * c.range(0.2, 0.7), c.s * c.range(0.2, 0.5), c.range(6, 12), i % 3 ? c.color : 0xffffff, c.range(0.9, 1.4), 0.88);
    }
    // The air shoved out to both sides
    for (let i = 0, n = c.n(8 * k); i < n; i++) {
      const side = i & 1 ? 1 : -1;
      c.puff(c.x + c.ux * c.s * 0.2, c.y + c.uy * c.s * 0.2, c.a + side * c.range(0.7, 1.3), c.range(1, 3), c.s * c.range(0.2, 0.4), c.range(18, 30), mixColor(c.color, 0xffffff, 0.4), 0.18);
    }
  },

  flight: flightFront,

  impact(c, k) {
    const L = c.look.n, hw = Math.max(c.s * 1.8, halfWidth(c, c.s * 0.6, k)) * (0.5 + 0.5 * k);
    c.mark(wash, c.x, c.y, c.a, 14 + 8 * k, k, c.s, [hw]);
    c.mark(wash, c.x, c.y, c.a, 14 + 8 * k, k * 0.6, c.s * 0.8, [hw * 0.8], 4);
    c.glow(c.x, c.y, c.s * (0.4 + 0.4 * k), 6, c.look.hot, true);
    // Mist and fine sparks driven out along the front, both ways
    for (let i = 0, n = c.n(L.mist * (0.3 + 0.7 * k)); i < n; i++) {
      const side = i & 1 ? 1 : -1, o = side * hw * c.range(0.1, 0.9), x = c.x + c.nx * o, y = c.y + c.ny * o;
      if (i % 3 === 0) c.puff(x, y, c.a + side * c.range(0.2, 0.9), c.range(0.5, 1.6), c.s * c.range(0.3, 0.55), c.range(20, 36), mixColor(c.color, 0xffffff, 0.3), 0.2);
      else c.spark(x, y, c.a + side * c.range(0.3, 1.2), c.range(2, 7), c.range(8, 15), i % 3 === 1 ? c.color : 0xffffff, c.range(1, 1.7), 0.89);
    }
  },

  beam(b, k) {
    // A wide soft sheet either side of the beam, ripples running down it
    const hw = b.wid * (1.2 + 2.6 * k) + 2;
    b.line(b.x0, b.y0, b.x1, b.y1, hw * 2, b.color, 0.1 * b.gain * (0.3 + 0.7 * k));
    b.line(b.x0, b.y0, b.x1, b.y1, hw * 1.2, b.color, 0.1 * b.gain * k);
    for (let i = 0, n = 2 + Math.round(3 * k); i < n; i++) {
      const p = (b.t * (0.9 + 0.5 * b.h(i)) + b.h(i + 4)) % 1, d = p * b.len, w = hw * (0.75 + 0.4 * b.h(i + 8)), bow = w * 0.45;
      b.g.moveTo(b.px(d - bow, w), b.py(d - bow, w)).quadraticCurveTo(b.px(d + bow, 0), b.py(d + bow, 0), b.px(d - bow, -w), b.py(d - bow, -w))
        .stroke({ color: i & 1 ? b.color : b.look.hot, width: 1 + 0.8 * k, alpha: 0.6 * k * b.gain * Math.sin(p * Math.PI) });
    }
  },

  beamEnd(b, k) {
    if (!b.hit) return;
    // The sheet breaking sideways across what it hits
    for (let i = 0; i < 2; i++) {
      const p = (b.t * 2.2 + i * 0.5 + b.h(2)) % 1, w = (b.wid * 1.5 + 6 + 14 * k) * (0.4 + 0.8 * p);
      b.line(b.px(b.len, -w), b.py(b.len, -w), b.px(b.len, w), b.py(b.len, w), 1.2 + 1.6 * (1 - p), b.color, 0.6 * k * b.gain * (1 - p));
    }
  },
};
