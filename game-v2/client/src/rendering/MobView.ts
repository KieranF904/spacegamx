/**
 * A single-body enemy (data/mobs.json, server/src/game/Mobs.ts) as drawn: its
 * outline in its hull colour with a darker rim, a glowing core that pulses,
 * and a flickering exhaust behind it. It flashes white when it's hit.
 */

import { Container, Graphics } from 'pixi.js';
import mobData from '../../../data/mobs.json';

interface MobLook { shape: [number, number][]; color: string; glow: string; radius: number }
const KINDS = Object.values((mobData as unknown as { mobs: Record<string, MobLook> }).mobs);
const hex = (s: string) => parseInt(s.slice(1), 16);

export class MobView {
  readonly container = new Container();
  private glow = new Graphics();
  private flame = new Graphics();
  private flash = new Graphics();
  private look: MobLook;
  private t = Math.random() * 10;
  private lastHp = -1;
  private hit = 0;

  constructor(kind: number) {
    this.look = KINDS[kind] ?? KINDS[0];
    const { shape, color, glow, radius } = this.look;
    const pts = shape.flat();
    const body = new Graphics();
    // A soft halo under it, so it reads against dark ground
    body.circle(0, 0, radius * 1.9).fill({ color: hex(glow), alpha: 0.1 });
    body.circle(0, 0, radius * 1.3).fill({ color: hex(glow), alpha: 0.16 });
    body.poly(pts).fill({ color: hex(color) }).stroke({ color: 0x0a0605, width: 2.5, alpha: 0.9 });
    // Plating seams: a line down its spine, a cut across its back
    body.moveTo(shape[0][0] * 0.8, 0).lineTo(shape[3][0], 0).stroke({ color: hex(glow), width: 1.4, alpha: 0.55 });
    this.flame.blendMode = 'add';
    this.glow.blendMode = 'add';
    this.flash.poly(pts).fill({ color: 0xffffff });
    this.flash.alpha = 0;
    this.container.addChild(this.flame, body, this.glow, this.flash);
  }

  /** Each frame: `hp` from the snapshot (a drop flashes it) */
  update(dt: number, hp: number | undefined): void {
    this.t += dt;
    const { glow, shape, radius } = this.look;
    const g = hex(glow);
    if (hp !== undefined) {
      if (this.lastHp >= 0 && hp < this.lastHp) this.hit = 1;
      this.lastHp = hp;
    }
    this.hit = Math.max(0, this.hit - dt * 6);
    this.flash.alpha = this.hit * 0.8;
    const pulse = 0.65 + 0.35 * Math.sin(this.t * 14);
    this.glow.clear();
    this.glow.circle(radius * 0.15, 0, radius * 0.9).fill({ color: g, alpha: 0.22 * pulse });
    this.glow.circle(radius * 0.15, 0, radius * 0.45).fill({ color: g, alpha: 0.5 * pulse });
    this.glow.circle(radius * 0.15, 0, radius * 0.22).fill({ color: 0xfff1d6, alpha: 0.9 * pulse });
    // Exhaust: out of its tail, flickering
    const tail = shape[3][0];
    const len = radius * (1.2 + 0.5 * Math.random());
    this.flame.clear();
    this.flame.poly([tail, -radius * 0.32, tail - len, 0, tail, radius * 0.32]).fill({ color: g, alpha: 0.55 });
    this.flame.poly([tail, -radius * 0.14, tail - len * 0.6, 0, tail, radius * 0.14]).fill({ color: 0xffe0b0, alpha: 0.8 });
  }
}
