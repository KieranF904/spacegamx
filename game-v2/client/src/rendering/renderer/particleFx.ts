/**
 * @contract client.render.particle-fx
 * owns:       short-lived effect particles, flashes and rings, tractor beams, and the named one-shot effects (explosion, warp, hit, break)
 * needs:      pooled sprites (SpritePool), fxTextures, Lighting (flash lights), GameState (player position, screen shake); npm: @space-game/common, pixi.js
 * invariants: an effect's random draws go in a fixed order, so the same sequence makes the same effect — client/src/rendering/renderer/rendererModules.test.ts
 * extend:     a new one-shot effect is one case in showEffect() plus a create* method
 */

import { Container, Texture } from 'pixi.js';
import { EffectType } from '@space-game/common';
import type { GameState } from '../../state/GameState';
import { SpritePool } from '../spritePool';
import { disc, ring, rock, softDot, streak, streakScale, DOT_SIZE } from '../fxTextures';
import type { Lighting } from '../lighting/Lighting';

/** A short-lived effect particle, drawn from a sprite pool (see updateEffects) */
interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  color: number;
  /** Scale at full life (it shrinks as it fades) */
  size: number;
  /** Its radius in world units at scale 1 */
  radius: number;
  tex: Texture;
  alpha: number;
  rot: number;
  rotSpeed: number;
}

/** An expanding, fading flash or ring */
interface Flash { x: number; y: number; radius: number; life: number; max: number; color: number; alpha: number; grow: number; tex: Texture }

interface TractorBeam {
  startX: number;
  startY: number;
  targetX: number;
  targetY: number;
  progress: number;
}

export class ParticleFx {
  private particles: Particle[] = [];
  private flashes: Flash[] = [];
  /** Particles and flashes are pooled sprites (no Graphics made and destroyed per spark) */
  private fxPool = new SpritePool('normal');
  private tractorBeams: TractorBeam[] = [];
  /** Tractor beams: pooled streaks and dots */
  private beamPool = new SpritePool('add');
  /** Share of the small effect particles spawned (the quality setting) */
  particleKeep = 1;

  constructor(parent: Container, private state: Pick<GameState, 'entities' | 'playerId' | 'triggerScreenShake'>) {
    parent.addChild(this.fxPool.container);
    parent.addChild(this.beamPool.container);
  }

  /** Each frame: particles and flashes move and fade, tractor beams animate */
  update(delta: number): void {
    // Particles and flashes: pooled sprites, moved and faded
    const pool = this.fxPool;
    pool.begin();
    let w = 0;
    for (const p of this.particles) {
      p.x += p.vx * delta * 60;
      p.y += p.vy * delta * 60;
      p.life -= delta;
      if (p.life <= 0) continue;
      p.rot += p.rotSpeed * delta;
      const k = p.life / p.maxLife;
      const sp = pool.take(p.tex, p.x, p.y, 0.5, 0.5, p.color, p.alpha * k, p.rot);
      sp.scale.set(k * p.size * (p.radius * 2) / DOT_SIZE);
      this.particles[w++] = p;
    }
    this.particles.length = w;
    w = 0;
    for (const f of this.flashes) {
      f.life += delta;
      if (f.life >= f.max) continue;
      const t = f.life / f.max;
      const sp = pool.take(f.tex, f.x, f.y, 0.5, 0.5, f.color, f.alpha * (1 - t));
      sp.scale.set((f.radius * (1 + f.grow * t) * 2) / DOT_SIZE);
      this.flashes[w++] = f;
    }
    this.flashes.length = w;
    pool.end();
    // Update tractor beam animations
    this.updateTractorBeams(delta);
  }

  /** The flashes' lights (old-style: the renderer's own lights) */
  collectLights(L: Lighting): void {
    for (const f of this.flashes) {
      const t = f.life / f.max;
      L.point(f.x, f.y, f.color, f.radius * (1 + f.grow * t) * 3 + 40, f.alpha * (1 - t) * 1.2);
    }
  }

  /** A particle (see update) */
  spark(x: number, y: number, vx: number, vy: number, life: number, radius: number, color: number, o: Partial<Particle> = {}): void {
    if (this.particleKeep < 1 && Math.random() > this.particleKeep) return;
    this.particles.push({ x, y, vx, vy, life, maxLife: o.maxLife ?? life, color, size: o.size ?? 1, radius, tex: o.tex ?? disc(), alpha: o.alpha ?? 1, rot: o.rot ?? 0, rotSpeed: o.rotSpeed ?? 0 });
  }

  /** A flash: `radius` growing by `grow` (×radius) while it fades from `alpha` over `max` seconds */
  flash(x: number, y: number, radius: number, color: number, alpha: number, max: number, grow: number, tex: Texture = disc()): void {
    this.flashes.push({ x, y, radius, life: 0, max, color, alpha, grow, tex });
  }

  explosion(x: number, y: number): void {
    const particleCount = 30;
    for (let i = 0; i < particleCount; i++) {
      const angle = (i / particleCount) * Math.PI * 2;
      const speed = 2 + Math.random() * 4;
      this.spark(x, y, Math.cos(angle) * speed, Math.sin(angle) * speed, 0.5 + Math.random() * 0.5, 5,
        Math.random() > 0.5 ? 0xff8800 : 0xffff00, { maxLife: 1 });
    }
  }

  showEffect(type: EffectType, x: number, y: number, data?: number[], targetX?: number, targetY?: number): void {
    switch (type) {
      case EffectType.Explosion:
        this.createExplosionAt(x, y, data?.[0] || 100);
        break;
      case EffectType.LaserHit:
        // Laser beams are now rendered from snapshot data (see updateRemoteLasers / CURSOR_STATE.md).
        // The server no longer broadcasts per-fire LaserHit effects.
        // Fall through to bullet hit for any legacy messages.
        this.createBulletHitEffect(x, y, data?.[0] || 10, data?.[1] || 30);
        break;
      case EffectType.AsteroidBreak:
        this.createAsteroidBreakEffect(x, y, data?.[0] || 50, data?.[1] || 30);
        break;
      case EffectType.MineArm:
        this.createMineArmEffect(x, y);
        break;
      case EffectType.PickupItem:
        if (targetX !== undefined && targetY !== undefined) {
          this.createTractorBeam(x, y, targetX, targetY);
        }
        break;
      case EffectType.MissileTrail:
        // Handled by trail system
        break;
      case EffectType.WarpOut:
      case EffectType.WarpIn:
        // (data 2: something's spooling up to come through here, a few seconds off)
        if (data?.[0] === 2) this.createArrivalWarning(x, y);
        else this.createWarpEffect(x, y, type === EffectType.WarpOut);
        break;
      case EffectType.ShieldFlash:
        // (a Flash Screen came back: a white bloom and a ring where the ship is)
        this.flash(x, y, 90, 0xffffff, 0.8, 0.35, 1.4);
        this.flash(x, y, 80, 0xbfe6ff, 0.7, 0.6, 3, ring());
        break;
      // Add more effect types as needed
    }
  }
  
  /**
   * A ship went through a gate (out: leaving here; in: arriving): a white-blue
   * flash and a shockwave ring, as the jump drive's launch and arrival (JumpFx).
   */
  private createWarpEffect(x: number, y: number, out: boolean): void {
    if (out) {
      this.flash(x, y, 70, 0xe8f6ff, 0.85, 0.45, 1.6);
      this.flash(x, y, 60, 0x7dd3fc, 0.9, 0.8, 9, ring());
      this.flash(x, y, 40, 0x3b82f6, 0.6, 0.6, 5, ring());
    } else {
      this.flash(x, y, 50, 0xe8f6ff, 0.7, 0.35, 1);
      this.flash(x, y, 45, 0x7dd3fc, 0.8, 0.55, 4, ring());
    }
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * Math.PI * 2, sp = (out ? 4 : 2.5) + Math.random() * 4;
      this.spark(x, y, Math.cos(a) * sp, Math.sin(a) * sp, 0.3 + Math.random() * 0.3, 3 + Math.random() * 3, Math.random() > 0.4 ? 0x9fd8ff : 0xffffff,
        { maxLife: 0.6, size: 0.8, tex: softDot() });
    }
  }

  /**
   * Something is about to come through here (a gate spooling up, a front
   * arriving out of the dark): slow amber rings drawing in, a few seconds'
   * warning to get ready or get clear.
   */
  private createArrivalWarning(x: number, y: number): void {
    for (let k = 0; k < 4; k++) this.flash(x, y, 380 - k * 60, 0xffb547, 0.5, 0.9 + k * 0.55, -0.6, ring());
    this.flash(x, y, 160, 0xffd890, 0.35, 3, 0.4);
  }

  private createMineArmEffect(x: number, y: number): void {
    // Pulsing ring effect when mine arms
    this.flash(x, y, 20, 0xff4444, 0.8, 0.21, 2, ring());
  }

  createExplosionAt(x: number, y: number, radius: number): void {
    const particleCount = Math.floor(radius / 3); // More particles
    const debrisCount = Math.floor(radius / 10); // Add debris

    // Main explosion particles: white/yellow core to orange/red edges
    for (let i = 0; i < particleCount; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 1 + Math.random() * 4;
      const roll = Math.random();
      const color = roll < 0.2 ? 0xffffff : roll < 0.4 ? 0xffffaa : roll < 0.7 ? 0xff8800 : 0xff4400;
      this.spark(x, y, Math.cos(angle) * speed, Math.sin(angle) * speed, 0.2 + Math.random() * 0.5, 2 + Math.random() * 4, color, { maxLife: 0.7, size: 1.2 });
    }
    // Debris chunks, spinning
    for (let i = 0; i < debrisCount; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 2 + Math.random() * 3;
      this.spark(x, y, Math.cos(angle) * speed, Math.sin(angle) * speed, 0.5 + Math.random() * 0.5, 3 + Math.random() * 5, 0x6a6a6a,
        { maxLife: 1, tex: rock(i), rot: Math.random() * Math.PI * 2, rotSpeed: (Math.random() - 0.5) * 10 });
    }
    // Central flash
    this.flash(x, y, radius * 0.8, 0xffffff, 0.8, 0.13, 0.8);

    // Trigger screen shake for nearby explosions
    const player = this.state.entities.get(this.state.playerId);
    if (player) {
      const dx = player.x - x;
      const dy = player.y - y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const maxDist = 500;
      if (dist < maxDist) {
        const intensity = ((maxDist - dist) / maxDist) * (radius / 50);
        this.state.triggerScreenShake(Math.min(intensity, 15), 0.3);
      }
    }
  }

  // Update active lasers (call from render loop)

  private createTractorBeam(startX: number, startY: number, targetX: number, targetY: number): void {
    this.tractorBeams.push({ startX, startY, targetX, targetY, progress: 0 });
  }

  private updateTractorBeams(dt: number): void {
    const pool = this.beamPool;
    pool.begin();
    let w = 0;
    for (const beam of this.tractorBeams) {
      beam.progress += dt * 2.5; // ~0.4 second animation
      if (beam.progress >= 1) continue;
      this.tractorBeams[w++] = beam;

      // Animate the item moving toward the player
      const t = beam.progress;
      const easeT = 1 - Math.pow(1 - t, 3); // Ease out cubic
      const currentX = beam.startX + (beam.targetX - beam.startX) * easeT;
      const currentY = beam.startY + (beam.targetY - beam.startY) * easeT;

      // Pulsing energy beam from player to item pickup point: a wide glow and a bright core
      const pulse = Math.sin(t * Math.PI * 8) * 0.3 + 0.7;
      const beamWidth = 3 + pulse * 2;
      const len = Math.hypot(currentX - beam.targetX, currentY - beam.targetY);
      const rot = Math.atan2(currentY - beam.targetY, currentX - beam.targetX);
      const fade = 1 - t;
      for (const [width, color, alpha] of [[beamWidth + 8, 0x00ffff, 0.3], [beamWidth, 0xaaffff, 0.7], [1.5, 0xffffff, 0.8]] as const) {
        const sp = pool.take(streak(), beam.targetX, beam.targetY, 0, 0.5, color, alpha * fade);
        const sc = streakScale(len, width);
        sp.scale.set(sc.x, sc.y);
        // The streak's tail cap starts half a width behind its anchor
        sp.position.set(beam.targetX - Math.cos(rot) * width / 2, beam.targetY - Math.sin(rot) * width / 2);
        sp.rotation = rot;
      }

      // Item dot at current position
      const dotSize = 6 * (1 - t * 0.5);
      pool.take(softDot(), currentX, currentY, 0.5, 0.5, 0x00ffff, 0.5).scale.set(((dotSize + 4) * 2) / DOT_SIZE);
      pool.take(disc(), currentX, currentY, 0.5, 0.5, 0xffffff, 0.8).scale.set((dotSize * 2) / DOT_SIZE);

      // Sparkle particles along beam (about 18 a second)
      if (Math.random() < dt * 18) {
        const sparkT = Math.random();
        const sparkX = beam.targetX + (currentX - beam.targetX) * sparkT;
        const sparkY = beam.targetY + (currentY - beam.targetY) * sparkT;

        this.spark(sparkX + (Math.random() - 0.5) * 10, sparkY + (Math.random() - 0.5) * 10, (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2,
          0.2, 2 + Math.random() * 2, 0x88ffff, { size: 0.5, alpha: 0.8 });
      }
    }
    this.tractorBeams.length = w;
    pool.end();
  }

  /**
   * Create a bullet hit effect at a position (hitting asteroid/enemy)
   */
  private createBulletHitEffect(x: number, y: number, damage: number, hue: number): void {
    const color = this.hueToColor(hue);
    // Flash at impact point
    this.flash(x, y, 8 + damage * 0.5, 0xffffff, 0.8, 0.08, 0);
    this.flash(x, y, 5 + damage * 0.3, color, 0.9, 0.08, 0);
    // Spark particles
    const sparkCount = Math.min(12, 4 + Math.floor(damage / 5));
    for (let i = 0; i < sparkCount; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 2 + Math.random() * 4;
      this.spark(x, y, Math.cos(a) * sp, Math.sin(a) * sp, 0.15 + Math.random() * 0.15, 1.5 + Math.random() * 1.5, Math.random() > 0.3 ? color : 0xffffff,
        { maxLife: 0.3, size: 0.6 });
    }
  }

  /**
   * Create asteroid break/destroy effect
   */
  private createAsteroidBreakEffect(x: number, y: number, size: number, hue: number): void {
    const color = this.hueToColor(hue);
    const particleCount = Math.min(30, Math.floor(size / 3));
    // Central flash, expanding as it fades
    this.flash(x, y, size * 1.2, 0xffffff, 0.6, 0.16, 1.5);
    // Rock debris
    for (let i = 0; i < particleCount; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 1 + Math.random() * 4;
      this.spark(x + (Math.random() - 0.5) * size * 0.5, y + (Math.random() - 0.5) * size * 0.5, Math.cos(angle) * speed, Math.sin(angle) * speed,
        0.5 + Math.random() * 0.5, 2 + Math.random() * (size / 10), Math.random() > 0.2 ? color : this.hueToColor(hue + 10),
        { maxLife: 1, size: 0.8, tex: rock(i), rot: Math.random() * Math.PI * 2 });
    }
    // Dust cloud (small fading particles)
    for (let i = 0; i < particleCount / 2; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 0.5 + Math.random() * 2;
      this.spark(x, y, Math.cos(angle) * speed, Math.sin(angle) * speed, 0.3 + Math.random() * 0.3, 3 + Math.random() * 4, color,
        { maxLife: 0.6, size: 0.5, alpha: 0.4 });
    }
  }

  /**
   * Convert HSL hue (0-360) to RGB color number
   */
  private hueToColor(hue: number): number {
    const h = (hue % 360) / 360;
    const s = 0.7;
    const l = 0.5;
    
    const hueToRgb = (p: number, q: number, t: number) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1/6) return p + (q - p) * 6 * t;
      if (t < 1/2) return q;
      if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
      return p;
    };
    
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    
    const r = Math.round(hueToRgb(p, q, h + 1/3) * 255);
    const g = Math.round(hueToRgb(p, q, h) * 255);
    const b = Math.round(hueToRgb(p, q, h - 1/3) * 255);
    
    return (r << 16) | (g << 8) | b;
  }
}
