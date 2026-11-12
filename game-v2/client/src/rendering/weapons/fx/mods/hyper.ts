/** Hyper: a sharp thin crack at the muzzle, a line of light down the whole path in a blink with a brief afterimage, a pinpoint hit with a thin line of vapour */

import { mixColor } from '../particleTypes';
import type { MarkDraw, ModLayer } from './kit';

/** The crack: a thin hard line across the muzzle, a shorter one down the bore, gone almost at once */
const crack: MarkDraw = (c, m) => {
  const f = 1 - m.life / m.max, w = m.s * m.look.n.crack * (0.35 + 0.65 * m.k) * (0.6 + 0.4 * f), lean = (c.h(0) - 0.5) * 0.5;
  const cx = Math.cos(m.a + Math.PI / 2 + lean), cy = Math.sin(m.a + Math.PI / 2 + lean), up = 0.35 + 0.3 * c.h(1);
  c.line(m.x - cx * w * up, m.y - cy * w * up, m.x + cx * w * (1 - up), m.y + cy * w * (1 - up), 0.8 + 0.5 * m.k, 0xffffff, 0.95 * f * (0.4 + 0.6 * m.k));
  c.line(m.x - cx * w * up * 0.6, m.y - cy * w * up * 0.6, m.x + cx * w * (1 - up) * 0.6, m.y + cy * w * (1 - up) * 0.6, 2.2, m.color, 0.4 * f);
  c.dot(m.x, m.y, m.s * 0.1 * f, 0xffffff, 0.9 * f);
};

/** The path's line (m.d: where the path began): whole while the shell flies, then a thin afterimage fading and breaking up */
const path: MarkDraw = (c, m) => {
  const n = m.life / m.max, f = 1 - n, dx = m.x - m.d[0], dy = m.y - m.d[1];
  c.line(m.d[0], m.d[1], m.x, m.y, 2.5 + 2.5 * m.k * f, m.color, 0.8 * f * (0.3 + 0.7 * m.k));
  // (the afterimage breaks into lengths as it goes)
  for (let i = 0; i < 4; i++) {
    const t0 = i / 4 + 0.1 * c.h(i) * n, t1 = (i + 1) / 4 - 0.22 * c.h(i + 4) * n * 2;
    if (t1 > t0) c.line(m.d[0] + dx * t0, m.d[1] + dy * t0, m.d[0] + dx * t1, m.d[1] + dy * t1, 1.5, 0xffffff, 0.95 * f * (0.3 + 0.7 * m.k));
  }
  // (motes of light left strung along it, winking out one by one)
  for (let i = 0; i < 7; i++) {
    const t = c.h(i + 10), live = 1 - n / (0.35 + 0.65 * c.h(i + 20));
    if (live > 0) c.dot(m.d[0] + dx * t, m.d[1] + dy * t, 1 + 1.6 * c.h(i + 30), i & 1 ? 0xffffff : m.color, 0.9 * live * m.k);
  }
};

export const hyper: ModLayer = {
  muzzle(c, k) {
    c.mark(crack, c.x, c.y, c.a, 4 + 3 * k, k, c.s);
    // A hairline of light far down the line, a hard white point, sparks snapped off square to it
    c.flare(c.x, c.y, c.a, c.s * (4 + 6 * k), 0.9, 6, 0xffffff);
    c.glow(c.x, c.y, c.s * (0.25 + 0.2 * k), 4, 0xffffff, true);
    for (let i = 0, n = c.n(8 * k); i < n; i++) c.spark(c.x, c.y, c.a + (i & 1 ? 1 : -1) * c.range(1.3, 1.8), c.s * c.range(0.3, 0.9), c.range(4, 8), i % 3 ? 0xffffff : c.color, c.range(0.7, 1.1), 0.8);
    // (the air it left behind, in thin beads down the bore line)
    for (let i = 0, n = c.n(4 * k); i < n; i++) {
      const d = c.s * c.range(0.6, 3.4);
      c.puff(c.x + c.ux * d, c.y + c.uy * d, c.a, c.range(0.05, 0.3), c.s * c.range(0.08, 0.16), c.range(18, 32), mixColor(c.color, 0xffffff, 0.6), 0.18, i);
    }
  },

  flight(c, k) {
    const L = c.look.n, s = c.shot;
    if (!s) return;
    // The line from the barrel to the shell (its nearest stretch, on a long flight), kept as its afterimage once it stops
    const m = c.keep(path, L.after * (0.5 + 0.5 * k), k);
    let x0 = s.spawnX + (s.vox ?? 0), y0 = s.spawnY + (s.voy ?? 0);
    const d = Math.hypot(c.x - x0, c.y - y0);
    if (d > L.trail) { x0 = c.x - ((c.x - x0) / d) * L.trail; y0 = c.y - ((c.y - y0) / d) * L.trail; }
    m.x = c.x; m.y = c.y; m.d[0] = x0; m.d[1] = y0; m.k = k;
    // Its head: a white point with a hairline across it
    const w = c.s * (2 + 2 * k);
    c.dot(c.x, c.y, c.s * (1.2 + 1.2 * k), 0xffffff, 0.85 * c.alpha * k);
    c.line(c.x - c.nx * w, c.y - c.ny * w, c.x + c.nx * w, c.y + c.ny * w, 0.8, 0xffffff, 0.7 * c.alpha * k);
  },

  impact(c, k) {
    const L = c.look.n, back = c.a + Math.PI;
    // A pinpoint: small, white, a hairline glint across it and a lance back up the way it came
    c.glow(c.x, c.y, c.s * 0.9 * (0.6 + 0.4 * k), 7, 0xffffff, true);
    c.flare(c.x, c.y, back + c.jit(0.04), c.s * (2.5 + 4 * k), 0.9, 10, 0xffffff);
    c.flare(c.x, c.y, c.a + Math.PI / 2 + c.jit(0.5), c.s * L.glint * k * c.range(0.7, 1.2), 1, 7, c.color);
    c.flare(c.x, c.y, c.a - Math.PI / 2 + c.jit(0.5), c.s * L.glint * k * c.range(0.7, 1.2), 1, 7, c.color);
    for (let i = 0, n = c.n(6 * k); i < n; i++) c.spark(c.x, c.y, back + c.jit(0.5), c.range(3, 9), c.range(5, 10), i & 1 ? 0xffffff : c.color, c.range(0.7, 1.1), 0.86);
    // A thin line of vapour back up the way it came, beading unevenly
    let d = c.s * 0.3;
    for (let i = 0, n = c.n(L.vapour * (0.3 + 0.7 * k)); i < n; i++) {
      d += c.s * c.range(0.25, 0.7);
      c.puff(c.x + Math.cos(back) * d, c.y + Math.sin(back) * d, back + c.jit(0.6), c.range(0.05, 0.3), c.s * c.range(0.09, 0.17), c.range(22, 40), mixColor(c.color, 0xffffff, 0.6), 0.26, i);
    }
  },

  beam(b, k) {
    // The beam blinks: a white line snapping on and off, thin ghosts of it either side fading between blinks
    const hz = 11 + 8 * k, p = (b.t * hz) % 1, on = b.hs(1, hz) < 0.45 + 0.3 * k;
    if (on) b.line(b.x0, b.y0, b.x1, b.y1, 0.9 + 0.8 * k, 0xffffff, 0.95 * b.gain * (0.3 + 0.7 * k) * (1 - p * p));
    for (let side = -1; side <= 1; side += 2) {
      const off = side * (b.wid * 0.6 + 1.5 + 3 * k * (0.4 + 0.6 * p)) * (0.7 + 0.6 * b.hs(side + 3, hz));
      b.line(b.px(0, off), b.py(0, off), b.px(b.len, off), b.py(b.len, off), 0.7, b.color, 0.5 * b.gain * k * (1 - p));
    }
  },

  beamEnd(b, k) {
    if (!b.hit) return;
    const hz = 11 + 8 * k, p = (b.t * hz) % 1, r = (5 + 9 * k) * (1 - 0.5 * p), lean = b.hs(7, hz) * Math.PI;
    b.dot(b.x1, b.y1, 1 + 1.2 * k, 0xffffff, 0.95 * b.gain * k);
    for (let i = 0; i < 2; i++) {
      const a = lean + (i * Math.PI) / 2, l = r * (i ? 0.55 : 1);
      b.line(b.x1 - Math.cos(a) * l, b.y1 - Math.sin(a) * l, b.x1 + Math.cos(a) * l, b.y1 + Math.sin(a) * l, 0.7, i ? b.color : 0xffffff, 0.8 * b.gain * k * (1 - p));
    }
  },
};
