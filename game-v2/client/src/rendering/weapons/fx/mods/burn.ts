/** Burn: flame licking off the muzzle, a dripping fire trail, and flames that cling to what was hit with smoke rising for as long as the burn lasts */

import { mixColor } from '../particleTypes';
import { COOL, type MarkDraw, type ModLayer } from './kit';
import { MECH } from './looks';

const SMOKE = 0x3c3632;

/** The muzzle's flame: tongues licking forward and curling off to the sides, each flickering on its own beat */
const licks: MarkDraw = (c, m) => {
  const n = m.life / m.max, L = m.look.n, swell = Math.sin(Math.min(1, n * 1.4) * Math.PI);
  for (let i = 0, cnt = Math.max(2, Math.round(L.licks * (0.4 + 0.6 * m.k))); i < cnt; i++) {
    const off = (c.h(i) - 0.5) * 1.5, fl = 0.6 + 0.4 * Math.sin(m.life * (0.9 + c.h(i + 5)) + c.h(i + 9) * 6.3);
    const len = m.s * L.tongue * (0.3 + 0.7 * m.k) * (0.45 + 0.75 * c.h(i + 13)) * (1 - 0.5 * Math.abs(off)) * swell * fl;
    const a = m.a + off + 0.25 * Math.sin(m.life * 0.5 + i);
    c.flame(m.x, m.y, a, len, len * 0.2, i % 3 ? m.color : m.look.hot, 0.75 * (1 - n * n));
  }
};

/**
 * Fire clinging where it hit: flames standing off the surface (m.d: each one's place across and along, in the hit's
 * frame), wavering, a wisp of smoke and an ember let go now and then, dying down over the last of the burn
 */
const cling: MarkDraw = (c, m, frames) => {
  const n = m.life / m.max, L = m.look.n, die = n < 0.7 ? 1 : 1 - (n - 0.7) / 0.3, catchOn = Math.min(1, m.life / 8), up = m.a + Math.PI;
  for (let i = 0; i + 1 < m.d.length; i += 2) {
    const x = m.x + c.nx * m.d[i] + c.ux * m.d[i + 1], y = m.y + c.ny * m.d[i] + c.uy * m.d[i + 1];
    const fl = 0.55 + 0.45 * Math.sin(m.life * (0.5 + 0.5 * c.h(i)) + c.h(i + 3) * 6.3), len = m.s * (0.8 + 1 * m.k) * (0.5 + 0.8 * c.h(i + 7)) * fl * die * catchOn;
    const a = up + (c.h(i + 11) - 0.5) * 0.9 + 0.3 * Math.sin(m.life * 0.33 + i);
    c.flame(x, y, a, len, len * 0.26, i % 4 ? m.color : m.look.hot, 0.8 * die);
  }
  c.ball(m.x, m.y, m.s * (0.6 + 0.5 * m.k) * (0.9 + 0.1 * Math.sin(m.life * 0.7)), mixColor(m.color, COOL, 0.3), 0.3 * die * catchOn);
  // (smoke rising off it, an ember now and then)
  if (c.rnd() < L.soot * frames * (0.4 + 0.6 * m.k)) c.puff(m.x + c.jit(m.s * 0.8), m.y + c.jit(m.s * 0.8), up + c.jit(0.9), c.range(0.3, 0.9), m.s * c.range(0.3, 0.5), c.range(40, 70), SMOKE, 0.22 * die);
  if (c.rnd() < 0.07 * frames * m.k) c.spark(m.x + c.jit(m.s), m.y + c.jit(m.s), up + c.jit(1.4), c.range(0.6, 2), c.range(16, 30), m.color, 1.6, 0.94, COOL);
};

export const burn: ModLayer = {
  muzzle(c, k) {
    c.mark(licks, c.x, c.y, c.a, 10 + 6 * k, k, c.s);
    for (let i = 0, n = c.n(3 * k); i < n; i++) c.spark(c.x, c.y, c.a + c.jit(1.2), c.range(1, 4), c.range(14, 26), c.color, c.range(1.3, 2), 0.93, COOL);
    for (let i = 0, n = c.n(2 * k); i < n; i++) c.puff(c.x + c.ux * c.s * 0.5, c.y + c.uy * c.s * 0.5, c.a + c.jit(1), c.range(0.3, 1), c.s * c.range(0.16, 0.26), c.range(30, 50), SMOKE, 0.18, 6);
  },

  flight(c, k) {
    const L = c.look.n, a = c.alpha;
    // Flame licking back off the shell, two tongues out of step
    for (let i = 0; i < 2; i++) {
      const fl = 0.6 + 0.4 * Math.sin(c.clock * (0.8 + 0.5 * c.h(i)) + c.h(i + 2) * 6.3), len = (c.s * 3 + c.dl * 0.3) * (0.4 + 0.6 * k) * fl;
      const dir = c.a + Math.PI + (i ? 1 : -1) * 0.22 * fl;
      c.flame(c.x, c.y, dir, len, c.s * (0.7 + 0.5 * k), i ? c.color : c.look.hot, 0.7 * a * (0.3 + 0.7 * k));
    }
    // Fire dripping off behind it, burning out as it falls away
    for (let i = 0, n = c.n(L.drip * k * c.frames); i < n; i++) {
      const d = c.rnd() * c.dl;
      if (i & 1) c.spark(c.x - c.ux * d, c.y - c.uy * d, c.a + Math.PI + c.jit(2.2), c.range(0.3, 1.3), c.range(12, 24), c.color, c.range(1.2, 2), 0.94, COOL);
      else c.fire(c.x - c.ux * d, c.y - c.uy * d, c.a + c.jit(3), c.range(0.1, 0.5), c.s * c.range(0.8, 1.5), c.range(9, 16), c.look.hot, COOL);
    }
  },

  impact(c, k) {
    const L = c.look.n, d: number[] = [];
    for (let i = 0, n = Math.max(2, Math.round(L.cling * (0.3 + 0.7 * k))); i < n; i++) d.push(c.jit(c.s * (1 + 0.8 * k)), c.jit(c.s * 0.5));
    // (it burns up off the surface where that is known, else back the way the shot came)
    c.mark(cling, c.x, c.y, c.out + Math.PI, MECH.burnFrames * (0.5 + 0.5 * k), k, c.s, d);
    // It catches: a gout of flame and a few embers thrown off
    c.fire(c.x, c.y, c.out, c.range(0.4, 1), c.s * (0.5 + 0.6 * k), c.range(12, 18), c.look.hot);
    for (let i = 0, n = c.n(4 * k); i < n; i++) c.spark(c.x, c.y, c.out + c.jit(1.8), c.range(1, 4), c.range(14, 28), c.color, c.range(1.3, 2), 0.93, COOL);
    c.scorch(c.x, c.y, c.s * (0.4 + 0.4 * k), 80, c.color);
  },

  beam(b, k) {
    // Flame licking off the beam's sides, leaning back along it, each tongue on its own beat
    for (let i = 0, n = Math.min(14, Math.floor(b.len / 16)); i < n; i++) {
      const p = (b.t * (0.25 + 0.2 * b.h(i)) + b.h(i + 4)) % 1, d = p * b.len, side = b.h(i + 8) < 0.5 ? -1 : 1;
      const fl = 0.5 + 0.5 * Math.sin(b.t * (9 + 6 * b.h(i + 12)) + b.h(i + 16) * 6.3), len = (4 + 9 * b.h(i + 20)) * (0.35 + 0.65 * k) * fl * Math.sin(p * Math.PI);
      const dir = Math.atan2(b.ny * side, b.nx * side) - side * (0.5 + 0.3 * fl) * (b.ux * b.ny - b.uy * b.nx > 0 ? 1 : -1);
      b.tongue(b.px(d, side * b.wid * 0.3), b.py(d, side * b.wid * 0.3), dir, len, 1.4 + 1.6 * k, i % 3 ? b.color : b.look.hot, 0.6 * b.gain * (0.3 + 0.7 * k));
    }
  },

  beamEnd(b, k) {
    if (!b.hit) return;
    // What it touches is alight: flames standing back off the end
    const back = Math.atan2(-b.uy, -b.ux);
    b.dot(b.x1, b.y1, 4 + 5 * k, b.color, 0.25 * b.gain * k);
    for (let i = 0, n = 3 + Math.round(3 * k); i < n; i++) {
      const fl = 0.5 + 0.5 * Math.sin(b.t * (8 + 7 * b.h(i)) + b.h(i + 3) * 6.3), o = (b.h(i + 6) - 0.5) * (8 + 10 * k);
      const dir = back + (b.h(i + 9) - 0.5) * 1.3 + 0.3 * Math.sin(b.t * 3 + i), len = (6 + 12 * b.h(i + 12)) * (0.35 + 0.65 * k) * fl;
      b.tongue(b.px(b.len, o), b.py(b.len, o), dir, len, 1.6 + 1.8 * k, i % 3 ? b.color : b.look.hot, 0.65 * b.gain * (0.3 + 0.7 * k));
      b.tongue(b.px(b.len, o), b.py(b.len, o), dir, len * 0.45, 0.9, 0xfff4d8, 0.6 * b.gain * k);
    }
  },
};
