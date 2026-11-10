/**
 * @contract client.weapon-fx.hit-draw
 * owns:       drawing and ageing a layered impact's cores, glows, fireballs, scorches, shock rings, fragments, streaks and lights
 * needs:      FxField (its pools and particle lists), particleTypes, impactAnchor (rideStep)
 * invariants: each list is aged and drawn newest first, spliced out at max life — client/src/rendering/weapons/fx/fxInvariants.test.ts
 * extend:     a new layered-impact part is one list on FxField and one loop here
 */

import { DOT_SIZE } from '../../fxTextures';
import { rideStep } from '../impactAnchor';
import type { FxField } from './FxField';
import { mixColor, TEX, TEX3, SMOKE_CAP } from './particleTypes';

  /** Draws (and ages) the layered impacts' cores, glows, shock rings and hull scorches, and ages their lights */
export function drawHits(fx: FxField, frames: number): void {
  const h = fx.hitG, tex = TEX3.ball;
  for (let i = fx.hitGlows.length - 1; i >= 0; i--) {
    const p = fx.hitGlows[i];
    p.life += frames;
    if (p.life >= p.max) { fx.hitGlows.splice(i, 1); continue; }
    if (p.anc) p.anc.move(p);
    if (p.life < 0) continue;
    const n = p.life / p.max, f = 1 - n;
    if (p.cool !== undefined) {
      // A fireball: it drifts out, swells fast and cools from its colour to a dull red as it fades
      const dr = Math.pow(0.9, frames);
      p.vx! *= dr; p.vy! *= dr; p.x += p.vx! * frames; p.y += p.vy! * frames;
      const r = p.size * (0.4 + 0.6 * (1 - Math.pow(1 - Math.min(1, n * 2.5), 2))), kk = (r * 2) / DOT_SIZE;
      h.take(tex, p.x, p.y, 0.5, 0.5, mixColor(p.color, p.cool, Math.min(1, n * 1.4)), 0.9 * Math.pow(f, 1.2), 0, kk, kk);
      if (n < 0.25) { const k2 = kk * 0.45; h.take(tex, p.x, p.y, 0.5, 0.5, 0xfff4d8, 0.9 * (1 - n / 0.25), 0, k2, k2); }
      continue;
    }
    // The core is a hard white flash shrinking away; the glow swells out (eased) and fades slower
    const r = p.core ? p.size * (1 - 0.35 * n) : p.size * (0.55 + 0.45 * (1 - f * f * f));
    const kk = (r * 2) / DOT_SIZE;
    h.take(tex, p.x, p.y, 0.5, 0.5, p.color, p.core ? f * f : 0.85 * Math.pow(f, 1.6), 0, kk, kk);
  }
  for (let i = fx.scorches.length - 1; i >= 0; i--) {
    const p = fx.scorches[i];
    p.life += frames;
    if (p.life >= p.max) { fx.scorches.splice(i, 1); continue; }
    if (p.anc) p.anc.move(p);
    const n = p.life / p.max;
    // White-hot for a moment, then its colour, cooling to a dull red as it fades
    const col = n < 0.12 ? mixColor(0xffffff, p.color, n / 0.12) : mixColor(p.color, 0x5a1206, Math.min(1, (n - 0.12) / 0.7));
    const r = p.size * (1 - 0.3 * n), kk = (r * 2) / DOT_SIZE;
    h.take(tex, p.x, p.y, 0.5, 0.5, col, 0.95 * Math.pow(1 - n, 1.4), 0, kk, kk);
    if (n < 0.35) { const k2 = kk * 0.45; h.take(tex, p.x, p.y, 0.5, 0.5, 0xfff4e0, 0.8 * (1 - n / 0.35), 0, k2, k2); }
  }
  for (let i = fx.shocks.length - 1; i >= 0; i--) {
    const s = fx.shocks[i];
    s.life += frames;
    if (s.life >= s.max) { fx.shocks.splice(i, 1); continue; }
    if (s.anc) s.anc.move(s);
    if (s.life < 0) continue;
    const n = s.life / s.max, f = 1 - n;
    // Out fast and slowing (ease-out), the band thinning to a hairline as it goes
    const r = s.size * (0.12 + 0.88 * (1 - f * f * f));
    fx.shockG.ring(s.x, s.y, r, Math.max(0.8, s.width * f), s.color, 0.9 * Math.pow(f, 1.3));
    if (n < 0.4) fx.shockG.ring(s.x, s.y, r * 0.96, Math.max(0.6, s.width * 0.35 * f), 0xffffff, 0.7 * (1 - n / 0.4));
  }
  // Fragments: slowing, cooling, a fading streak behind each and a puff of smoke now and then; dimming away at the end
  for (let i = fx.frags.length - 1; i >= 0; i--) {
    const p = fx.frags[i];
    p.life += frames;
    if (p.life >= p.max) { fx.frags.splice(i, 1); continue; }
    // (in the frame of what it came off, slowing to rest on it: it carries the target's motion)
    rideStep(p, p.anc, p.drag, frames);
    const n = p.life / p.max, fade = n < 0.65 ? 1 : 1 - (n - 0.65) / 0.35, sp = Math.hypot(p.vx, p.vy);
    const col = mixColor(p.hot, p.cool, Math.min(1, n * 1.15));
    if (sp > 0.15) fx.line(p.x - p.vx * 7, p.y - p.vy * 7, p.x, p.y, p.size * 0.9, p.trail, 0.45 * fade * Math.min(1, sp / 1.5));
    // (a soft glow round it while it's hot)
    if (n < 0.7) fx.circle(fx.glow, TEX.dot, p.x, p.y, p.size * 2.4, p.trail, 0.28 * (1 - n / 0.7));
    fx.circle(fx.glow, TEX.disc, p.x, p.y, p.size * (1 - 0.35 * n), col, 0.95 * fade);
    if (n < 0.3) fx.circle(fx.glow, TEX.disc, p.x, p.y, p.size * 0.45, 0xffffff, 0.8 * (1 - n / 0.3));
    p.puff -= frames;
    if (p.puff <= 0 && n < p.smokes && fx.smoke.length < SMOKE_CAP && Math.random() < fx.particleKeep) {
      p.puff = 3 + Math.random() * 3;
      const max = 26 + Math.random() * 16;
      fx.smoke.push({ x: p.x, y: p.y, vx: p.vx * 0.1, vy: p.vy * 0.1, life: 0, max, size: p.size * 1.3, color: 0x6a625a, alpha: 0.22 * (1 - n), anc: p.anc });
      p.anc?.hold(max + 2);
    }
  }
  for (let i = fx.flares.length - 1; i >= 0; i--) {
    const f = fx.flares[i];
    f.life += frames;
    if (f.life >= f.max) { fx.flares.splice(i, 1); continue; }
    if (f.anc) { f.anc.move(f); f.a += f.anc.turn; }
    const n = f.life / f.max, out = 1 - Math.pow(1 - Math.min(1, n / 0.3), 3);
    // Shoots out fast (eased) from the hit, its root lifting off after it as it fades, thinning
    const r1 = f.len * out, r0 = f.len * 0.55 * Math.max(0, (n - 0.25) / 0.75), c = Math.cos(f.a), sn = Math.sin(f.a);
    const fade = Math.pow(1 - n, 1.3), w = f.width * (1 - 0.6 * n);
    fx.line(f.x + c * r0, f.y + sn * r0, f.x + c * r1, f.y + sn * r1, w * 2.6, f.color, 0.55 * fade);
    fx.line(f.x + c * r0, f.y + sn * r0, f.x + c * r1, f.y + sn * r1, w, 0xffffff, 0.95 * fade);
  }
  for (let i = fx.hitLights.length - 1; i >= 0; i--) {
    const l = fx.hitLights[i];
    l.life += frames;
    if (l.life >= l.max) fx.hitLights.splice(i, 1);
    else if (l.anc) l.anc.move(l);
  }
}
