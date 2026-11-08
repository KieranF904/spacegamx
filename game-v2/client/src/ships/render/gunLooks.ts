/**
 * @contract client.ship.render.gun-looks
 * owns:       gun looks drawn once and shared by every gun like it (reference counted), plus cracks, colour darkening and light shading
 * needs:      pixi Graphics/GraphicsContext/Texture, gunDecor GunShape, shipColors mix; npm: pixi.js
 * invariants: a look is destroyed only when no ship uses it and the idle cache is full — none pinned
 * extend:     a new shared gun-look helper is added here
 */

import { Container, Graphics, GraphicsContext, Texture } from 'pixi.js';
import type { GunShape } from '../gunDecor';
import { mix } from '../shipColors';
import type { BodyView } from './viewTypes';

/**
 * A gun's look, drawn once and shared by every gun like it (each ship's own Graphics over the same contexts): its metal
 * and, if it has any, its lit bits (each in its own colours), and the cracks over its outline. Counted out and back
 * (gunLook / dropGun); the last GUNS_IDLE_KEPT that no ship uses are kept, older ones destroyed.
 */
export interface GunLook { metal: GraphicsContext; lit?: GraphicsContext; crack: GraphicsContext; uses: number }
export const GUN_LOOKS = new Map<string, GunLook>();
export const GUNS_IDLE = new Set<string>();
export const GUNS_IDLE_KEPT = 128;
export const destroyLook = (l: GunLook) => { l.metal.destroy(); l.lit?.destroy(); l.crack.destroy(); };
/** A gun's look by its key, made from its shapes and outline (scaled by k) the first time */
export function gunLook(key: string, make: () => { shapes: readonly GunShape[]; outline: readonly number[][]; k: number }): GunLook {
  let look = GUN_LOOKS.get(key);
  if (!look) {
    const { shapes, outline, k } = make();
    const metal = new GraphicsContext();
    let lit: GraphicsContext | undefined;
    for (const s of shapes) {
      const g = s.glow ? (lit ??= new GraphicsContext()) : metal;
      g.poly(k === 1 ? s.pts : s.pts.map((v) => v * k)).fill({ color: s.color });
    }
    const crack = new GraphicsContext();
    for (const o of outline) crack.poly(k === 1 ? o : o.map((v) => v * k)).fill({ texture: crackTexture(), color: 0xffffff });
    GUN_LOOKS.set(key, (look = { metal, lit, crack, uses: 0 }));
  }
  look.uses++;
  GUNS_IDLE.delete(key);
  return look;
}
export function dropGun(key: string): void {
  const look = GUN_LOOKS.get(key);
  if (!look || --look.uses > 0) return;
  GUNS_IDLE.add(key);
  for (const k of GUNS_IDLE) {
    if (GUNS_IDLE.size <= GUNS_IDLE_KEPT) break;
    GUNS_IDLE.delete(k);
    destroyLook(GUN_LOOKS.get(k)!);
    GUN_LOOKS.delete(k);
  }
}
/** Every gun look no ship is using, destroyed now */
export function flushGuns(): void {
  for (const k of GUNS_IDLE) { destroyLook(GUN_LOOKS.get(k)!); GUN_LOOKS.delete(k); }
  GUNS_IDLE.clear();
}
/** A gun's Graphics over its shared look, in a container (cracks come later, if it's hurt) */
export function gunGraphics(look: GunLook): { c: Container; metal: Graphics; lit?: Graphics } {
  const c = new Container(), metal = new Graphics(look.metal), lit = look.lit ? new Graphics(look.lit) : undefined;
  c.addChild(metal);
  if (lit) c.addChild(lit);
  return { c, metal, lit };
}
/** A gun's cracks, shown by how hurt its part is (`f` its health; made the first time they show) */
export function showCracks(gun: { crack?: Graphics; look: string }, holder: Container, f: number): void {
  const a = crackShow(f);
  if (a <= 0) { if (gun.crack) gun.crack.visible = false; return; }
  if (!gun.crack) gun.crack = holder.addChild(new Graphics(GUN_LOOKS.get(gun.look)!.crack));
  gun.crack.alpha = a;
  gun.crack.visible = true;
}
/** A gun's Graphics and holder destroyed (its shared look kept for others), its look given back */
export function disposeGun(gun: { metal: Graphics; lit?: Graphics; crack?: Graphics; deco?: Graphics; look: string }, holder: Container): void {
  gun.metal.destroy(); gun.lit?.destroy(); gun.crack?.destroy(); gun.deco?.destroy();
  holder.destroy();
  dropGun(gun.look);
}

/** Dark branching cracks on clear (laid over guns' barrels as their part is hurt), made once */
let cracks: Texture | null = null;
export function crackTexture(): Texture {
  if (cracks) return cracks;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d')!;
  let seed = 7;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  x.strokeStyle = 'rgba(0,0,0,0.9)';
  x.lineCap = 'round';
  const crack = (px: number, py: number, a: number, len: number, w: number, depth: number): void => {
    for (let i = 0; i < 8 && len > 2; i++) {
      const nx = px + Math.cos(a) * len, ny = py + Math.sin(a) * len;
      x.lineWidth = w;
      x.beginPath(); x.moveTo(px, py); x.lineTo(nx, ny); x.stroke();
      if (depth < 2 && rnd() < 0.35) crack(nx, ny, a + (rnd() < 0.5 ? 0.7 : -0.7), len * 0.7, w * 0.7, depth + 1);
      px = nx; py = ny; a += (rnd() - 0.5) * 0.9; len *= 0.85;
    }
  };
  for (let k = 0; k < 7; k++) crack(rnd() * 128, rnd() * 128, rnd() * Math.PI * 2, 10 + rnd() * 8, 1.6 + rnd(), 0);
  return (cracks = Texture.from(c));
}
/** How much of a gun's cracks show at this health (none until it's taken a little) */
export const crackShow = (f: number) => Math.max(0, Math.min(1, (0.88 - f) / 0.6));
/** A colour darkened towards ember red as its part is hurt (as the hull shader does) */
export const hurt = (c: number, f: number) => mix(0x3a0d08, c, 0.35 + 0.65 * Math.min(1, f));

/** A colour under light (per channel, up to 1.6) */
export function shade(c: number, l: [number, number, number]): number {
  const f = (v: number, k: number) => Math.min(255, Math.round(v * k));
  return (f((c >> 16) & 255, l[0]) << 16) | (f((c >> 8) & 255, l[1]) << 8) | f(c & 255, l[2]);
}

/** Its fixed guns' barrels destroyed (their looks given back) */
export function clearBarrels(view: BodyView): void {
  for (const b of view.fixed) disposeGun(b, b.g);
  view.fixed = [];
}

/** Its turrets destroyed (their looks given back) */
export function clearTurrets(view: BodyView): void {
  for (const t of view.turrets) disposeGun(t, t.barrel);
  view.turrets = [];
}
