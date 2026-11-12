/** Explosive: an orange-hot shell core dribbling embers, and at the hit a rolling, lumpy fireball the size of its blast with burning fragments and smoke, then the blast (blast.ts: flash, shock ring, sparks, embers and smoke that hang) */

import { mixColor } from '../particleTypes';
import { blast } from './blast';
import { COOL, type ModLayer } from './kit';
import { MECH } from './looks';

const SMOKE = 0x4a423c;

export const explosive: ModLayer = {
  muzzle(c, k) {
    const L = c.look.n;
    c.fire(c.x + c.ux * c.s * 0.3, c.y + c.uy * c.s * 0.3, c.a + c.jit(0.5), c.range(0.6, 1.6), c.s * (0.3 + 0.35 * k), c.range(9, 14), c.look.hot);
    // Embers coughed out with the shell, falling behind it
    for (let i = 0, n = c.n(L.embers * k); i < n; i++) {
      c.spark(c.x, c.y, c.a + c.jit(0.9), c.range(1.5, 6) * (0.6 + 0.4 * k), c.range(14, 30), c.color, c.range(1.4, 2.4), 0.92, COOL);
    }
  },

  flight(c, k) {
    const L = c.look.n, a = c.alpha, r = c.s * L.core * (0.55 + 0.45 * k), fl = 0.82 + 0.18 * Math.sin(c.clock * 0.9 + c.h(0) * 6.3);
    // The charge glowing through the shell
    c.ball(c.x - c.ux * r * 0.3, c.y - c.uy * r * 0.3, r * 1.9 * fl, c.color, 0.5 * a * k, c.a, 1.5);
    c.ball(c.x, c.y, r * fl, c.look.hot, 0.85 * a * (0.25 + 0.75 * k));
    // Embers dribbling off it, and a wisp of smoke now and then
    for (let i = 0, n = c.n(L.drip * k * c.frames); i < n; i++) {
      c.spark(c.x - c.ux * r, c.y - c.uy * r, c.a + Math.PI + c.jit(1.5), c.range(0.3, 1.5), c.range(12, 26), c.color, c.range(1.2, 2.2), 0.93, COOL);
      if (c.rnd() < 0.35) c.puff(c.bx, c.by, c.a + Math.PI + c.jit(1), 0.3, c.s * c.range(0.8, 1.4), c.range(18, 30), SMOKE, 0.14 * k);
    }
  },

  impact(c, k) {
    // (to its blast radius; never smaller than the hit of the gun that carries it)
    const L = c.look.n, R = Math.max(c.R, MECH.blast[0] + (MECH.blast[1] - MECH.blast[0]) * k, c.s * 2.2 * (0.5 + 0.5 * k));
    // The fireball: lumps of fire bursting one after another round the hit, each rolling its own way
    for (let i = 0, n = c.n(L.balls * (0.35 + 0.65 * k)); i < n; i++) {
      const pa = c.rnd() * Math.PI * 2, pr = R * c.range(0.05, 0.5) * (i === 0 ? 0.2 : 1), drift = i === 0 ? c.out : pa + c.jit(0.8);
      c.fire(c.x + Math.cos(pa) * pr, c.y + Math.sin(pa) * pr, drift, R * c.range(0.01, 0.045), R * c.range(0.3, 0.58) * (i === 0 ? 1.15 : 1), c.range(16, 30), i % 3 === 0 ? c.look.hot : c.color, COOL, i * c.range(0.6, 1.8));
    }
    c.glow(c.x, c.y, R * 0.42, 6, 0xffffff, true);
    c.glow(c.x, c.y, Math.min(R * 0.8, 30), 16, mixColor(c.color, COOL, 0.25));
    // Burning fragments thrown clear, trailing smoke
    for (let i = 0, n = c.n(L.frags * (0.2 + 0.8 * k)); i < n; i++) {
      const a = c.surface ? c.out + c.jit(2.6) : c.rnd() * Math.PI * 2;
      c.frag(c.x, c.y, a, R * c.range(0.035, 0.12), c.range(1.3, 2.6), c.range(26, 54), c.look.hot, 0x6a2410, c.range(0.93, 0.965), c.range(0.4, 0.8));
    }
    // Smoke rolling up after the fire
    for (let i = 0, n = c.n(L.smoke * (0.3 + 0.7 * k)); i < n; i++) {
      const pa = c.rnd() * Math.PI * 2, pr = R * c.range(0.1, 0.55);
      c.puff(c.x + Math.cos(pa) * pr, c.y + Math.sin(pa) * pr, pa, c.range(0.15, 0.6), R * c.range(0.2, 0.36), c.range(50, 90), SMOKE, 0.26, c.range(5, 14));
    }
    c.scorch(c.x, c.y, R * 0.4, 50, c.color);
    c.light(c.x, c.y, Math.min(R * 3, 150), 0.9 * (0.4 + 0.6 * k), 18);
    // The blast itself: flash, shock ring at its radius, sparks, and the embers and smoke that hang (blast.ts), in the
    // effect's colour warmed towards the gun's own; its ring at the blast's real radius, whatever the fireball's size
    blast(c, k, c.R > 0 ? c.R : MECH.blast[0] + (MECH.blast[1] - MECH.blast[0]) * k,c.shot ? mixColor(c.color, c.shot.style.impact.color, 0.3) : c.color);
  },

  beam(b, k) {
    // Knots of fire carried down the beam, popping as they go
    for (let i = 0, n = 2 + Math.round(3 * k); i < n; i++) {
      const p = (b.t * (0.7 + 0.5 * b.h(i)) + b.h(i + 3)) % 1, r = (1.6 + 2.6 * b.h(i + 6)) * (0.5 + 0.5 * k) * (0.7 + 0.5 * b.hs(i, 14));
      const off = (b.h(i + 12) - 0.5) * b.wid;
      b.dot(b.px(p * b.len, off), b.py(p * b.len, off), r * 1.8, b.color, 0.35 * k * b.gain);
      b.dot(b.px(p * b.len, off), b.py(p * b.len, off), r * 0.8, b.look.hot, 0.8 * k * b.gain);
    }
  },

  beamEnd(b, k) {
    if (!b.hit) return;
    // A lumpy fire boiling where it lands
    for (let i = 0, n = 3 + Math.round(3 * k); i < n; i++) {
      const a = b.hs(i, 9) * Math.PI * 2, d = (2 + 9 * b.hs(i + 5, 9)) * (0.4 + 0.6 * k), p = (b.t * 9) % 1;
      const r = (3 + 6 * b.hs(i + 9, 9)) * (0.4 + 0.6 * k) * (0.6 + 0.4 * p);
      b.dot(b.x1 + Math.cos(a) * d, b.y1 + Math.sin(a) * d, r, i % 3 ? b.color : b.look.hot, 0.42 * k * b.gain * (1 - 0.5 * p));
    }
  },
};
