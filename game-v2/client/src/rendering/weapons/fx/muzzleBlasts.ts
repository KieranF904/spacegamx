/**
 * @contract client.weapon-fx.muzzle-blasts
 * owns:       the particles a gun throws as it fires, by its kind: a powder gun's fireball, smoke plume and bright fragments; a heavy
 *             gun's side jets and smoking barrel; a long gun's bore jet; an autocannon's wisp; a rail's ion sparks and vapour; a launcher's
 *             smoke ring and backblast; an energy gun's motes, ring and afterglow; an incendiary's rolling fire, drifting embers and soot
 * needs:      FxField (hitGlow, shock, spark and smoke lists, particleKeep), particleTypes (SMOKE_CAP, mixColor), weaponStyles (MuzzleBlast)
 * invariants: a shot's particles go only into FxField's own lists, thinned by the quality setting — client/src/rendering/weapons/fx/fxInvariants.test.ts
 * extend:     a new kind is one MuzzleBlast name (weaponStyles), one recipe here and one case in flashDraw
 */

import type { FxField } from './FxField';
import { mixColor, SMOKE_CAP } from './particleTypes';
import type { MuzzleBlast, WeaponStyle } from '../weaponStyles';

/** What fragments and fireballs cool to, a fragment's white heat, and gun smoke's grey */
const COOL = 0x7a2a10, HOT = 0xfff4d8, GREY = 0xb4aea6;
/** A powder gun with a flash this big or bigger (after muzzleScale) throws fragments, at most FRAG_MAX */
const FRAG_SIZE = 14, FRAG_MAX = 9;

/** The particles of one shot leaving its barrel at (x, y) along `angle`, its flash `size` across */
export function muzzleBlast(f: FxField, kind: MuzzleBlast, x: number, y: number, angle: number, size: number, m: WeaponStyle['muzzle'], svx: number, svy: number): void {
  const rnd = Math.random, keep = () => f.particleKeep >= 1 || rnd() <= f.particleKeep;
  const heft = Math.max(0.5, Math.min(1.6, size / 24)), girth = m.girth ?? 1, ca = Math.cos(angle), sa = Math.sin(angle);
  /** A smoke puff `ahead` of the muzzle, drifting along `a` (a `delay` in frames: it rises later, off a barrel still smoking) */
  const puff = (a: number, v: number, ahead: number, r: number, max: number, color = GREY, alpha = 0.22, delay = 0) => {
    if (f.smoke.length >= SMOKE_CAP || !keep()) return;
    f.smoke.push({ x: x + ca * ahead, y: y + sa * ahead, vx: Math.cos(a) * v + svx * 0.03, vy: Math.sin(a) * v + svy * 0.03, life: -delay, max, size: r, color, alpha });
  };
  /** A bright fragment or mote along `a` (cooling when `cool` is given, else fading in its own colour) */
  const spark = (a: number, v: number, max: number, color: number, width: number, drag: number, cool?: number) => {
    if (keep()) f.sparks.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0, max, color, width, drag, cool });
  };
  /** A ball of burning gas rolling out along `a`, cooling to a dull red */
  const fireball = (a: number, v: number, r: number, max: number) =>
    f.hitGlows.push({ x, y, life: 0, max, size: r, color: mixColor(m.color, 0xffffff, 0.3), core: false, vx: Math.cos(a) * v, vy: Math.sin(a) * v, cool: COOL });
  const jitter = (w: number) => (rnd() - 0.5) * w;

  if (kind === 'auto') {
    // A stream of fire: a lick of gas each shot, burning grains spat down the line of fire after the shell, a wisp of
    // smoke that builds to a haze, now and then a hot fleck thrown wide
    fireball(angle + jitter(0.3), 1.2 + rnd() * 1.8, size * 0.4, 6 + rnd() * 4);
    for (let i = Math.min(4, m.sparks); i > 0; i--) spark(angle + jitter(0.22), 7 + rnd() * 9, 7 + rnd() * 8, mixColor(m.color, HOT, 0.7), 1.4, 0.88, COOL);
    if (m.smoke > 0) puff(angle + jitter(1.2), 0.4 + rnd() * 0.8, size * (0.3 + rnd() * 0.6), size * (0.2 + rnd() * 0.15), 40 + rnd() * 30, GREY, 0.13);
    if (rnd() < 0.4) spark(angle + jitter(1.1), 3 + rnd() * 4, 12 + rnd() * 12, mixColor(m.color, HOT, 0.6), 1.5, 0.93, COOL);
    return;
  }
  if (kind === 'rail') {
    // No powder: ion sparks thrown forward and back down the rails, a glow of charged air, and vapour along the first of the path
    const n = Math.min(12, m.sparks + 3);
    for (let i = 0; i < n; i++) {
      const fwd = i % 3 !== 0;
      spark(angle + (fwd ? jitter(1.5) : Math.PI + jitter(0.9)), (2 + rnd() * 5) * (fwd ? 1 : 0.6), 10 + rnd() * 16, i % 2 ? m.color : 0xffffff, 1.3, 0.9);
    }
    f.hitGlows.push({ x, y, life: 0, max: 16 + size * 0.2, size: size * 0.6, color: m.color, core: false });
    const mist = mixColor(GREY, m.color, 0.55);
    for (let i = 0; i < 3 + m.smoke * 2; i++) puff(angle + jitter(2.4), 0.2 + rnd() * 0.5, size * rnd() * 2.6, size * (0.07 + rnd() * 0.07), 28 + rnd() * 26, mist, 0.14);
    return;
  }
  if (kind === 'rocket') {
    // A launch: the motor lights in the tube, the gas rolls out in a ring round its mouth and blows back past the launcher
    fireball(angle + jitter(0.3), 0.4 + rnd() * 0.6, size * 0.38 * girth, 10 + rnd() * 5);
    const n = 6 + Math.round(m.smoke * 0.8), turn = rnd() * 6.28;
    for (let i = 0; i < n; i++) {
      const a = turn + (i / n) * Math.PI * 2 + jitter(0.4), v = (0.7 + rnd() * 0.8) * heft;
      // (each puff of the ring drifts back as well as out)
      const vx = Math.cos(a) * v - ca * 1.1 * heft, vy = Math.sin(a) * v - sa * 1.1 * heft;
      puff(Math.atan2(vy, vx), Math.hypot(vx, vy), size * 0.1, size * (0.17 + rnd() * 0.13), 46 + rnd() * 36, GREY, 0.2);
    }
    for (let i = Math.min(7, 2 + Math.round(size / 7)); i > 0; i--) spark(angle + Math.PI + jitter(1.5), 2 + rnd() * 3.5, 16 + rnd() * 18, mixColor(m.color, HOT, 0.5), 1.6, 0.92, COOL);
    return;
  }
  if (kind === 'energy') {
    // No smoke and nothing burning: motes of its own light drifting off, a ring thrown out, and a glow left hanging at the muzzle
    for (let i = Math.min(10, 3 + Math.round(size / 5)); i > 0; i--) spark(angle + jitter(3.2), 0.8 + rnd() * 2.4, 18 + rnd() * 20, i % 3 ? m.color : 0xffffff, 1.4, 0.95);
    if (!m.ring) f.shocks.push({ x, y, life: 0, max: 12, size: size * 0.75, width: Math.max(1.2, size * 0.05), color: m.color });
    if (size >= 30) f.shocks.push({ x, y, life: -3, max: 16, size: size * 1.2, width: Math.max(1.2, size * 0.04), color: m.color });
    f.hitGlows.push({ x, y, life: 0, max: 14 + size * 0.25, size: size * 0.55, color: m.color, core: false });
    return;
  }
  if (kind === 'fire') {
    // An incendiary lit in the bore: balls of fire rolling out one past another (the far ones small and fast, the near
    // ones fat and slow to die), embers thrown wide that drift and cool, soot after them, and the muzzle left glowing
    for (let i = 0; i < 6; i++) {
      const t = i / 5;
      fireball(angle + jitter(0.65 - 0.3 * t), (0.8 + 4.2 * t) * heft * (0.8 + rnd() * 0.4), size * (0.42 - 0.2 * t) * girth, 14 + rnd() * 10 + 8 * (1 - t));
    }
    for (let i = Math.min(14, m.sparks + 4); i > 0; i--) {
      const off = jitter(1.5);
      spark(angle + off, (1.5 + rnd() * 5) * (1 - 0.4 * Math.abs(off)), 30 + rnd() * 40, i % 3 ? mixColor(m.color, HOT, 0.4) : 0xffd060, 1.6 + rnd(), 0.955, COOL);
    }
    for (let i = m.smoke; i > 0; i--) puff(angle + jitter(0.9), 0.5 + rnd() * 1.4, size * (0.4 + rnd() * 0.9), size * (0.14 + rnd() * 0.12), 50 + rnd() * 40, 0x4a3a34, 0.2, 6 + rnd() * 8);
    f.hitGlows.push({ x, y, life: 0, max: 22, size: size * 0.5, color: m.color, core: false });
    return;
  }
  // Powder: burning gas rolling out of the bore, a plume of smoke after it (the far puffs the fastest), and bright fragments in a cone
  const heavy = kind === 'heavy', thrown = m.smokeSpeed ?? 1;
  for (let i = (size >= 26 ? 3 : size >= 16 ? 2 : 1) + (heavy ? 1 : 0); i > 0; i--) {
    fireball(angle + jitter(0.5), (1.2 + rnd() * 2.6) * heft, size * (0.26 + rnd() * 0.14) * girth, 9 + rnd() * 7 + (heavy ? 3 : 0));
  }
  const warm = mixColor(GREY, m.color, 0.12);
  for (let i = Math.round(m.smoke * 1.5) + (m.smoke ? 2 : 0); i > 0; i--) {
    const t = rnd();
    puff(angle + jitter(1 - 0.5 * t), (0.4 + 1.8 * t) * heft * thrown, size * (0.2 + 0.9 * t), size * (0.16 + rnd() * 0.16), 40 + rnd() * 40, warm, 0.22);
  }
  const frags = size >= FRAG_SIZE ? Math.min(FRAG_MAX, Math.round((size - 8) / 5)) : 0, hot = mixColor(m.color, HOT, 0.6);
  for (let i = 0; i < frags; i++) {
    const off = jitter(1.3);
    spark(angle + off, (3 + rnd() * 5) * (0.8 + 0.4 * heft) * (1 - 0.5 * Math.abs(off)), 18 + rnd() * 22, hot, 1.6 + 0.8 * heft, 0.94, COOL);
  }
  if (m.jet) {
    // A long gun's bore jet: burning gas racing down the line of fire after the round, a tight streak of white-hot sparks
    // with it, and gun smoke laid along the first of the path
    fireball(angle + jitter(0.06), 5.5 * heft, size * 0.3 * girth, 14 + rnd() * 4);
    fireball(angle + jitter(0.06), 9 * heft, size * 0.2 * girth, 11 + rnd() * 4);
    for (let i = m.jet; i > 0; i--) spark(angle + jitter(0.08), (10 + rnd() * 18) * heft, 12 + rnd() * 16, i % 3 ? hot : 0xffffff, 1.4 + rnd(), 0.9, COOL);
    for (let i = m.jet; i > 0; i--) puff(angle + jitter(0.5), 0.3 + rnd() * 0.9, size * rnd() * 5, size * (0.08 + rnd() * 0.08), 36 + rnd() * 30, warm, 0.16, rnd() * 6);
  }
  if (!heavy) return;
  // A heavy gun's brake: a jet of flame-lit smoke and sparks out to each side, and the barrel smoking after
  for (const sd of [-1, 1]) {
    const out = angle + sd * Math.PI / 2;
    fireball(out + jitter(0.2), (2 + rnd() * 1.5) * heft, size * 0.22, 8 + rnd() * 4);
    for (let i = 0; i < 4; i++) puff(out + jitter(0.5), (0.8 + rnd() * 2.2) * heft * thrown, size * 0.05, size * (0.12 + rnd() * 0.12), 36 + rnd() * 30, warm, 0.2);
    for (let i = 0; i < 3; i++) spark(out + jitter(0.5), 3 + rnd() * 4, 12 + rnd() * 14, hot, 1.6, 0.92, COOL);
  }
  for (let i = 0; i < 4; i++) puff(angle + jitter(2.5), 0.25 + rnd() * 0.35, 0, size * (0.1 + rnd() * 0.08), 50 + rnd() * 30, GREY, 0.16, 8 + i * 9 + rnd() * 6);
}
