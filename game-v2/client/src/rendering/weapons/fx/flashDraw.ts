/**
 * @contract client.weapon-fx.flash-draw
 * owns:       drawing a muzzle flash by its kind: a powder gun's ragged flame, a heavy gun's side-vented blast, an autocannon's star,
 *             a rail's needle and crackling arcs, a launcher's back-blown ignition, an energy gun's flare, an incendiary's gout of fire
 * needs:      FxField (its glow and light pools, line), particleTypes (Flash), fxTextures (petalScale)
 * invariants: a flash draws only into the glow and light pools, before the sparks — client/src/rendering/weapons/fx/fxInvariants.test.ts
 * extend:     a new kind is one MuzzleBlast name (weaponStyles), one case here and one recipe in muzzleBlasts
 */

import { petalScale, DOT_SIZE } from '../../fxTextures';
import type { FxField } from './FxField';
import { mixColor, TEX, TEX3, type Flash } from './particleTypes';

/** Draws one muzzle flash at its age (its light is additive, as a layered hit's glow; its flame the glow pool's petals) */
export function drawFlash(fx: FxField, f: Flash): void {
  const n = f.life / f.max, fade = 1 - n, pop = fade * fade, kind = f.kind ?? 'powder', s = f.size, grow = 0.7 + 0.5 * n;
  const ca = Math.cos(f.angle), sa = Math.sin(f.angle);
  const ball = (ahead: number, r: number, color: number, alpha: number, stretch = 1) => {
    const k = (r * 2) / DOT_SIZE;
    fx.hitG.take(TEX3.ball, f.x + ca * ahead, f.y + sa * ahead, 0.5, 0.5, color, alpha, f.angle, k * stretch, k);
  };
  const petal = (dir: number, len: number, wid: number, color: number, alpha: number) => {
    const k = petalScale(s * len, Math.max(0.6, s * wid * f.girth));
    fx.glow.take(TEX.petal, f.x, f.y, 0, 0.5, color, alpha, f.angle + dir, k.x, k.y);
  };
  const ray = (a: number, r0: number, r1: number, w: number, color: number, alpha: number) =>
    fx.line(f.x + Math.cos(a) * r0, f.y + Math.sin(a) * r0, f.x + Math.cos(a) * r1, f.y + Math.sin(a) * r1, w, color, alpha);
  // (each lick of flame wavers on its own beat)
  const flicker = (i: number) => 0.8 + 0.2 * Math.sin(f.life * 2.3 + i * 1.9);
  // A pop of light round the muzzle, brightest as the shell leaves
  ball(0, s * (0.75 + 0.45 * n) * f.girth, f.color, 0.5 * Math.pow(fade, 1.5));

  if (kind === 'rail') {
    // A needle of light down the bore, a flare across the muzzle, and arcs crackling off the rails (new ones every frame)
    const len = s * f.petals[0] * (0.8 + 0.6 * n);
    ray(f.angle, 0, len, Math.max(1, s * 0.16 * fade * f.girth), f.color, 0.6 * fade);
    ray(f.angle, 0, len * 0.7, Math.max(0.8, s * 0.06 * fade * f.girth), 0xffffff, 0.95 * fade);
    const across = s * (0.5 + 0.5 * n) * f.girth;
    ray(f.angle + Math.PI / 2, -across, across, Math.max(1, s * 0.05 * fade), f.color, 0.7 * pop);
    if (n < 0.75) {
      for (let i = Math.min(5, f.sparks.length); i > 0; i--) {
        const back = Math.random() * s * 0.5;
        let x = f.x - ca * back, y = f.y - sa * back, a = f.angle + (Math.random() - 0.5) * 4.4;
        for (let j = 0; j < 3; j++) {
          const l = s * (0.16 + Math.random() * 0.2), x1 = x + Math.cos(a) * l, y1 = y + Math.sin(a) * l;
          fx.line(x, y, x1, y1, 1.2, j ? f.color : 0xffffff, 0.85 * fade);
          x = x1; y = y1; a += (Math.random() - 0.5) * 1.8;
        }
      }
    }
    ball(0, s * 0.26 * (1 - 0.4 * n), 0xffffff, 0.9 * pop);
    return;
  }
  if (kind === 'energy') {
    // A short spike forward, a long thin flare across the muzzle and fine rays all round
    petal(0, f.petals[0] * 0.7 * grow, 0.2 * fade, f.color, 0.7 * fade);
    petal(0, f.petals[0] * 0.4 * grow, 0.09 * fade, 0xffffff, 0.9 * fade);
    const across = s * (0.9 + 0.7 * n);
    ray(f.angle + Math.PI / 2, -across, across, Math.max(1, s * 0.07 * fade), f.color, 0.65 * pop);
    ray(f.angle + Math.PI / 2, -across * 0.6, across * 0.6, Math.max(0.7, s * 0.03 * fade), 0xffffff, 0.9 * pop);
    for (const sp of f.sparks) ray(f.angle + sp.a * 8, sp.l * 0.3, sp.l * (0.5 + 0.5 * n), 1, f.color, 0.6 * fade);
    ball(0, s * 0.3 * (1 - 0.4 * n), 0xffffff, 0.85 * pop);
    return;
  }
  if (kind === 'rocket') {
    // The motor lighting in the tube: a short tongue after the missile, and the launch gas blown back past the tube's mouth
    petal(0, f.petals[0] * 0.45 * grow, 0.22 * fade, f.color, 0.6 * fade);
    const back = Math.PI - 0.55;
    petal(back, f.petals[1] * 1.6 * grow * flicker(1), 0.16 * fade, f.color, 0.6 * fade);
    petal(-back, f.petals[2] * 1.6 * grow * flicker(2), 0.16 * fade, f.color, 0.6 * fade);
    f.sparks.forEach((sp, i) => petal(Math.PI + sp.a * 2.2, (sp.l / s) * 0.5 * grow * flicker(i), 0.07 * fade, f.color, 0.5 * fade));
    ball(0, s * 0.3 * (1 - 0.3 * n), 0xffffff, 0.8 * pop);
    return;
  }
  if (kind === 'auto') {
    // A fast gun's flash: a long thin spike of fire down the line of fire, a hard white star across the muzzle that
    // snaps shut, short licks round it, and a hot ball at the bore
    const spike = f.petals[0] * grow * flicker(7);
    petal(0, spike * 1.35, 0.2 * fade, f.color, 0.8 * fade);
    petal(0, spike * 0.9, 0.08 * fade, 0xffffff, 0.95 * fade);
    for (const side of [Math.PI / 2, -Math.PI / 2]) {
      petal(side, f.petals[1] * 1.15 * grow * flicker(side > 0 ? 3 : 5), 0.13 * fade, f.color, 0.7 * fade);
      petal(side, f.petals[1] * 0.7 * grow, 0.05 * fade, 0xffffff, 0.9 * pop);
    }
    f.sparks.forEach((sp, i) => petal(sp.a * 1.6, (sp.l / s) * 0.6 * (0.5 + 0.5 * n) * flicker(i), 0.07 * fade, f.color, 0.6 * fade));
    petal(Math.PI, 0.35 * fade, 0.12 * fade, f.color, 0.5 * pop);
    ball(s * 0.1, s * 0.42 * (1 - 0.4 * n) * f.girth, 0xffffff, 0.95 * pop, 1.6);
    return;
  }
  if (kind === 'fire') {
    // A gout of burning fuel: many thin licks of deep red fire fanned round the bore, each wavering and reaching as it
    // goes, a yellow tongue inside them and a hot ball that hangs at the muzzle (the rolling fire is muzzleBlasts')
    const deep = mixColor(f.color, 0xff2a08, 0.55), swell = 0.6 + 0.7 * n;
    f.sparks.forEach((sp, i) => {
      petal(sp.a * 1.3, (sp.l / s) * 1.1 * swell * flicker(i), 0.09 * fade, i % 2 ? deep : f.color, 0.55 * fade);
      petal(-sp.a * 0.7 + 0.12 * Math.sin(f.life * 1.1 + i), (sp.l / s) * 0.7 * swell * flicker(i + 3), 0.06 * fade, i % 2 ? f.color : 0xffd080, 0.5 * fade);
    });
    petal(0.1 * Math.sin(f.life * 0.9), f.petals[0] * 1.25 * swell * flicker(7), 0.2 * fade, deep, 0.7 * fade);
    petal(0, f.petals[0] * 0.95 * swell * flicker(4), 0.13 * fade, f.color, 0.8 * fade);
    petal(0, f.petals[0] * 0.55 * swell, 0.07 * fade, 0xfff2c0, 0.9 * fade);
    ball(s * 0.25, s * 0.5 * (1 - 0.3 * n) * f.girth, 0xffe0a0, 0.8 * pop, 1.7);
    return;
  }
  // Powder flame: a ragged crown of licks round a long tongue, each wavering, thinning as they fade
  f.sparks.forEach((sp, i) => petal(sp.a, (sp.l / s) * (0.5 + 0.5 * n) * flicker(i), 0.1 * fade, f.color, 0.55 * fade));
  petal(0, f.petals[0] * grow * flicker(7), 0.3 * fade, f.color, 0.75 * fade);
  petal(0, f.petals[0] * 0.6 * grow, 0.14 * fade, 0xffffff, 0.9 * fade);
  // (a heavy gun's brake throws a jet out to each side)
  const side = kind === 'powder' ? Math.PI / 2.4 : Math.PI / 2, reach = kind === 'heavy' ? 1.3 : 1, fat = kind === 'heavy' ? 0.26 : 0.15;
  petal(side, f.petals[1] * reach * grow * flicker(3), fat * fade, f.color, 0.55 * fade);
  petal(-side, f.petals[2] * reach * grow * flicker(5), fat * fade, f.color, 0.55 * fade);
  if (kind === 'heavy') {
    petal(side, f.petals[1] * reach * 0.6 * grow, 0.11 * fade, 0xffffff, 0.8 * fade);
    petal(-side, f.petals[2] * reach * 0.6 * grow, 0.11 * fade, 0xffffff, 0.8 * fade);
  }
  // (the white-hot heart of it, a little way down the tongue, shrinking away)
  ball(s * 0.12, s * 0.34 * (1 - 0.4 * n) * f.girth, 0xffffff, 0.85 * pop, 1.5);
}
