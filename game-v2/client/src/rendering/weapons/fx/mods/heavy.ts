/** Heavy: a slow thump of thick smoke and kicked-up dust at the muzzle, a fat dark shell with a short dense wake, a deep hit that throws chunky debris */

import { mixColor } from '../particleTypes';
import { SOOT, type ModLayer } from './kit';

const SMOKE = 0x5a524a, DUST = 0x8a7a66, SLAG = 0x3a2a20;

export const heavy: ModLayer = {
  muzzle(c, k) {
    const L = c.look.n;
    // The thump: a dull slow bloom, then thick smoke rolling forward, each puff its own size and pace
    c.glow(c.x + c.ux * c.s * 0.25, c.y + c.uy * c.s * 0.25, c.s * (0.8 + 0.8 * k), 12 + 8 * k, mixColor(c.color, 0x7a2a10, 0.3));
    for (let i = 0, n = c.n(L.smoke * (0.25 + 0.75 * k)); i < n; i++) {
      const d = c.s * c.range(0, 0.9);
      c.puff(c.x + c.ux * d, c.y + c.uy * d, c.a + c.jit(0.9), c.range(0.3, 2.2), c.s * c.range(0.3, 0.65) * (0.7 + 0.3 * k), c.range(46, 90), i % 3 ? SMOKE : mixColor(SMOKE, c.color, 0.3), 0.45, c.range(0, 5));
    }
    // Recoil: dust kicked back and out past the barrel's sides
    for (let i = 0, n = c.n(L.dust * k); i < n; i++) {
      const side = i & 1 ? 1 : -1;
      c.puff(c.x - c.ux * c.s * 0.15, c.y - c.uy * c.s * 0.15, c.a + side * c.range(1.7, 2.6), c.range(1.2, 3.6), c.s * c.range(0.14, 0.28), c.range(22, 40), DUST, 0.26);
    }
    // Wadding and slag: a few hot lumps lobbed out, tumbling and smoking, and slow heavy flakes
    for (let i = 0, n = c.n(4 * k); i < n; i++) c.frag(c.x, c.y, c.a + c.jit(1.4), c.range(0.8, 2.6), c.range(1.6, 3), c.range(30, 55), c.color, SLAG, 0.95, 0.7);
    for (let i = 0, n = c.n(5 * k); i < n; i++) c.spark(c.x, c.y, c.a + c.jit(1.1), c.range(1, 3.4), c.range(16, 30), c.color, c.range(2, 3), 0.93, SLAG);
  },

  flight(c, k) {
    const L = c.look.n, a = c.alpha, r = Math.min(c.s * 1.3, 3 + c.s * 0.5) * L.body * (0.6 + 0.4 * k);
    // Its smoke: a dark rope strung out behind it, thinning (under the light), and a dull line of its heat
    for (let i = 0; i < 6; i++) {
      const d = r * (1.2 + 1.5 * i) * (0.9 + 0.2 * c.h(i));
      c.soot(c.x - c.ux * d + c.nx * (c.h(i + 6) - 0.5) * r, c.y - c.uy * d + c.ny * (c.h(i + 6) - 0.5) * r, r * (1 - 0.1 * i), SMOKE, 0.55 * a * k * (1 - i / 7));
    }
    c.line(c.bx, c.by, c.x, c.y, r * 0.5, c.color, 0.25 * a * k);
    // The slug: dark and fat, a dull rim of its own heat on its nose (a big round keeps its own look: the mass sits on it, not over it)
    c.dot(c.x, c.y, r * 1.9, c.color, 0.3 * a * k);
    c.disc(c.x - c.ux * r * 0.6, c.y - c.uy * r * 0.6, r * 0.85, SOOT, 0.85 * a * (0.3 + 0.7 * k));
    c.disc(c.x, c.y, r, SOOT, 0.95 * a * (0.3 + 0.7 * k));
    c.dot(c.x + c.ux * r * 0.55, c.y + c.uy * r * 0.55, r * 0.55, c.look.hot, 0.7 * a * k);
    // Its wake: dense and dark, hanging where it passed
    for (let i = 0, n = c.n(L.wake * k * c.frames); i < n; i++) {
      c.puff(c.x - c.ux * r * 1.4 + c.jit(r), c.y - c.uy * r * 1.4 + c.jit(r), c.a + Math.PI + c.jit(1.2), c.range(0.1, 0.5), r * c.range(0.7, 1.3), c.range(22, 40), SMOKE, 0.4);
    }
  },

  impact(c, k) {
    const L = c.look.n;
    // Driven deep: a slow glow in the hole, a second thump a beat later
    c.glow(c.x, c.y, c.s * (0.55 + 0.5 * k), 22 + 12 * k, mixColor(c.color, 0x7a2a10, 0.6));
    c.glow(c.x + c.ux * c.s * 0.3, c.y + c.uy * c.s * 0.3, c.s * (0.4 + 0.5 * k), 10, c.look.hot, false, 4);
    c.scorch(c.x, c.y, c.s * (0.5 + 0.5 * k), 60 + 40 * k, c.color);
    // Chunks torn out, big and slow, tumbling off every which way
    for (let i = 0, n = c.n(L.chunks * (0.2 + 0.8 * k)); i < n; i++) {
      const a = c.out + c.jit(c.surface ? 2.4 : 3.4);
      c.frag(c.x, c.y, a, c.range(0.7, 3.4) * (0.6 + 0.4 * k), c.range(2, 4.4) * (0.6 + 0.4 * k), c.range(40, 80), mixColor(c.color, c.look.hot, c.rnd()), SLAG, c.range(0.94, 0.975), c.range(0.5, 0.9));
    }
    // A dark pall hanging over it
    for (let i = 0, n = c.n(L.pall * (0.25 + 0.75 * k)); i < n; i++) {
      c.puff(c.x + c.jit(c.s), c.y + c.jit(c.s), c.out + c.jit(2), c.range(0.2, 1), c.s * c.range(0.4, 0.75), c.range(50, 90), SMOKE, 0.3, c.range(2, 10));
    }
    c.light(c.x, c.y, Math.min(c.s * 9, 150), 0.9 * k, 20);
  },

  beam(b, k) {
    // Weight on the beam: a wide dull sheath with dark edges either side of it, slow heavy swells riding down it
    const w = b.wid * (0.6 + 0.9 * k) + 1.2;
    b.line(b.x0, b.y0, b.x1, b.y1, w * 2.8, b.color, 0.2 * b.gain * k);
    for (let side = -1; side <= 1; side += 2) b.line(b.px(0, side * w * 1.2), b.py(0, side * w * 1.2), b.px(b.len, side * w * 1.2), b.py(b.len, side * w * 1.2), 1 + 1.2 * k, SOOT, 0.6 * b.gain * (0.25 + 0.75 * k));
    for (let i = 0, n = Math.min(10, Math.floor(b.len / 30)); i < n; i++) {
      const p = (b.t * (0.16 + 0.1 * b.h(i)) + b.h(i + 5)) % 1, d = p * b.len, r = w * (1.1 + 0.9 * b.h(i + 9)) * Math.sin(p * Math.PI);
      b.dot(b.px(d, 0), b.py(d, 0), r * 1.3 + 0.6, b.color, 0.3 * b.gain * k);
      b.dot(b.px(d, 0), b.py(d, 0), r * 0.6, b.look.hot, 0.45 * b.gain * k);
    }
  },

  beamEnd(b, k) {
    if (!b.hit) return;
    // It bores in: a dark boil, slag crawling out of it
    b.dot(b.x1, b.y1, (5 + 6 * k) * (0.9 + 0.1 * Math.sin(b.t * 5)), b.color, 0.32 * b.gain * k);
    b.dot(b.x1, b.y1, 2 + 2 * k, SOOT, 0.7 * b.gain * (0.25 + 0.75 * k));
    for (let i = 0; i < 5; i++) {
      const p = (b.t * (0.5 + 0.5 * b.h(i)) + b.h(i + 5)) % 1, a = Math.atan2(-b.uy, -b.ux) + (b.h(i + 10) - 0.5) * 4, d = 3 + p * (12 + 12 * k) * (0.5 + 0.5 * b.h(i + 15));
      b.dot(b.x1 + Math.cos(a) * d, b.y1 + Math.sin(a) * d, (1 + 1.6 * b.h(i + 20)) * (1 - 0.6 * p) * (0.5 + 0.5 * k), p < 0.4 ? b.look.hot : mixColor(b.color, SLAG, p), 0.9 * b.gain * k * (1 - p));
    }
  },
};
