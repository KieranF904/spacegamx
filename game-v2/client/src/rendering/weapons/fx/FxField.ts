/**
 * @contract client.weapon-fx.field
 * owns:       the particle pools and live particle lists every WeaponFx sub-system draws into, and the simple lists' draw
 *             (muzzle flashes, sparks, smoke, rings, liquid)
 * needs:      ParticlePool, particleTypes, impactAnchor (AnchorList), liquidSplash, fxTextures; npm: pixi.js
 * invariants: lists are drawn in a fixed order — flashes, sparks, smoke, rings, liquid, then layered hits — client/src/rendering/weapons/fx/fxInvariants.test.ts
 *             a vent makes no particles when the quality share drops it — client/src/rendering/weapons/fx/fxInvariants.test.ts
 * extend:     a new particle list is one field here and a loop in drawParticles (or hitDraw for layered impacts)
 */

import type { Container, Texture } from 'pixi.js';
import { Container as PixiContainer } from 'pixi.js';
import { petalScale, DOT_SIZE } from '../../fxTextures';
import { ParticlePool } from '../../particlePool';
import { AnchorList, rideStep } from '../impactAnchor';
import { LiquidFx, type LiquidSink } from '../liquidSplash';
import type { Lighting } from '../../lighting/Lighting';
import type { GameState } from '../../../state/GameState';
import { drawHits } from './hitDraw';
import { mixColor, TEX, TEX2, type Flash, type Frag, type HitGlow, type HitLight, type Flare, type Ring, type Scorch, type Shock, type Smoke, type Spark } from './particleTypes';

export class FxField {
  /** Light (additive) and smoke (normal blending) */
  /**
   * Normal blending, as these have always been drawn: the pool's 'add' never reached its sprites once the bloom made
   * it a render group (Pixi doesn't pass a render group's blend mode on). Additive would be brighter, a look to choose.
   */
  glow = new ParticlePool('normal');
  smokeG = new ParticlePool('normal');
  /** Rings, puffs and cloud (a fifth texture would not fit the glow pool) */
  extraG = new ParticlePool('normal');
  /** Layered impacts (ImpactLayers): core flashes, glows and hull scorches as light (additive), and their shock rings as true thin rings */
  hitG = new ParticlePool('add');
  shockG = new ParticlePool('add', 'rings');
  /** What the bloom takes: the glow pool and the layered impacts' light */
  readonly glowRoot = new PixiContainer();
  hitGlows: HitGlow[] = [];
  shocks: Shock[] = [];
  scorches: Scorch[] = [];
  hitLights: HitLight[] = [];
  flares: Flare[] = [];
  frags: Frag[] = [];
  /** Fragments made so far (a group's are the last made while it spawned: the oldest are dropped past the cap) */
  fragsMade = 0;
  /** Impacts riding what they hit: one entity lookup each a frame */
  anchors = new AnchorList();
  /** Layered impacts' liquid splashes (ImpactLayers.liquid), drawn into the glow pool through `liquidSink` */
  liquid = new LiquidFx();
  private readonly liquidSink: LiquidSink = {
    line: (x0, y0, x1, y1, w, color, alpha) => this.line(x0, y0, x1, y1, w, color, alpha),
    dot: (x, y, r, color, alpha) => this.circle(this.glow, TEX.dot, x, y, r, color, alpha),
    disc: (x, y, r, color, alpha) => this.circle(this.glow, TEX.disc, x, y, r, color, alpha),
  };
  smoke: Smoke[] = [];
  flashes: Flash[] = [];
  sparks: Spark[] = [];
  rings: Ring[] = [];
  /** Share of the impact sparks and smoke puffs made (the quality setting's particles) */
  particleKeep = 1;

  constructor(layer: Container) {
    this.glowRoot.addChild(this.glow.container, this.hitG.container, this.shockG.container);
    layer.addChild(this.smokeG.container, this.glowRoot, this.extraG.container);
  }

  /** A line from (x0, y0) to (x1, y1), `width` thick with soft round ends */
  line(x0: number, y0: number, x1: number, y1: number, width: number, color: number, alpha: number): void {
    const len = Math.hypot(x1 - x0, y1 - y0);
    // (streakScale's numbers, inline: no object a call)
    this.glow.take(TEX.streak, (x0 + x1) / 2, (y0 + y1) / 2, 0.5, 0.5, color, alpha, Math.atan2(y1 - y0, x1 - x0), (len + width) / 128, width / 32);
  }

  /** A filled circle (smooth-edged) */
  circle(pool: ParticlePool, tex: Texture, x: number, y: number, r: number, color: number, alpha: number): void {
    const k = (r * 2) / DOT_SIZE;
    pool.take(tex, x, y, 0.5, 0.5, color, alpha, 0, k, k);
  }

  /** A ring of `r` radius (the ring texture's) */
  ringAt(x: number, y: number, r: number, color: number, alpha: number): void {
    const k = (r * 2 * 32) / (28 * DOT_SIZE);
    this.extraG.take(TEX2.ring, x, y, 0.5, 0.5, color, alpha, 0, k, k);
  }

  /** Opens every pool for this frame's draw */
  begin(): void {
    this.glow.begin();
    this.smokeG.begin();
    this.extraG.begin();
    this.hitG.begin();
    this.shockG.begin();
  }

  end(): void {
    this.glow.end();
    this.smokeG.end();
    this.extraG.end();
    this.hitG.end();
    this.shockG.end();
  }

  /** Flashes ride along with their guns: the ship keeps moving and turning under them */
  pinFlashes(state: GameState): void {
    for (const f of this.flashes) {
      const o = f.owner >= 0 ? state.entities.get(f.owner) : undefined;
      if (!o) continue;
      const c = Math.cos(o.renderAngle), sn = Math.sin(o.renderAngle);
      f.x = o.renderX + f.ox * c - f.oy * sn;
      f.y = o.renderY + f.ox * sn + f.oy * c;
      f.angle = o.renderAngle + f.rel;
    }
  }

  /** Flashes, rings and layered hits light what's near them (see rendering/lighting) */
  collectLights(L: Lighting): void {
    for (const f of this.flashes) L.point(f.x, f.y, f.color, 70 + f.size * 7, 1.4 * (1 - f.life / f.max));
    for (const r of this.rings) L.point(r.x, r.y, r.color, 80 + r.size * 6, 1.1 * (1 - r.life / r.max));
    for (const h of this.hitLights) { const f = 1 - h.life / h.max; L.point(h.x, h.y, h.color, h.radius, h.power * f * f); }
  }

  /**
   * A puff off a gun that is not shooting: smoke venting from a housing, or sparks (a spent clip's eject, a rail's
   * vent). From the ship renderer, on reload.
   */
  vent(x: number, y: number, angle: number, kind: 'smoke' | 'spark', color: number): void {
    if (this.particleKeep < 1 && Math.random() > this.particleKeep) return;
    if (kind === 'smoke') {
      const a = angle + (Math.random() - 0.5) * 1.4;
      this.smoke.push({ x, y, vx: Math.cos(a) * 0.7, vy: Math.sin(a) * 0.7, life: 0, max: 40 + Math.random() * 20, size: 5 + Math.random() * 3, color, alpha: 0.2 });
      return;
    }
    for (let i = 0; i < 2; i++) {
      const a = angle + (Math.random() - 0.5) * 1.6, v = 1.5 + Math.random() * 2;
      this.sparks.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0, max: 14 + Math.random() * 10, color });
    }
  }

  /** Draws (and ages) the muzzle flashes, sparks, gun smoke and rings */
  drawParticles(frames: number): void {
    const g = this.glow;
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      f.life += frames;
      if (f.life >= f.max) { this.flashes.splice(i, 1); continue; }
      const n = f.life / f.max, fade = 1 - n;
      // Soft bloom, then the flash shape: a long tongue forward and two short petals to the sides
      this.circle(g, TEX.dot, f.x, f.y, f.size * (0.7 + 0.5 * n) * 1.4 * f.girth, f.color, 0.3 * fade);
      const petal = (dir: number, len: number, wid: number, color: number, alpha: number) => {
        const k = petalScale(f.size * len * (0.7 + 0.5 * n), f.size * wid * fade * f.girth);
        g.take(TEX.petal, f.x, f.y, 0, 0.5, color, alpha, f.angle + dir, k.x, k.y);
      };
      petal(0, f.petals[0], 0.32, f.color, 0.75 * fade);
      petal(0, f.petals[0] * 0.6, 0.16, 0xffffff, 0.9 * fade);
      petal(Math.PI / 2.4, f.petals[1], 0.18, f.color, 0.55 * fade);
      petal(-Math.PI / 2.4, f.petals[2], 0.18, f.color, 0.55 * fade);
      this.circle(g, TEX.disc, f.x, f.y, f.size * 0.3 * fade * f.girth + 0.5, 0xffffff, 0.95 * fade);
      for (const sp of f.sparks) {
        const a = f.angle + sp.a;
        const l = sp.l * (0.5 + n);
        this.line(f.x + Math.cos(a) * l * 0.4, f.y + Math.sin(a) * l * 0.4, f.x + Math.cos(a) * l, f.y + Math.sin(a) * l, 1.4, f.color, 0.8 * fade);
      }
    }

    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const p = this.sparks[i];
      p.life += frames;
      if (p.life >= p.max) { this.sparks.splice(i, 1); continue; }
      // (in the frame of what it came off, if anything, slowing to rest on it: its streak drawn by its own motion off that)
      rideStep(p, p.anc, p.drag ?? 0.9, frames);
      const n = p.life / p.max, rvx = p.vx, rvy = p.vy;
      if (p.cool !== undefined) {
        // An ember: cooling as it goes, bright for most of its life and fading at the end
        this.line(p.x - rvx * 2, p.y - rvy * 2, p.x, p.y, p.width ?? 2.4, mixColor(p.color, p.cool, Math.min(1, n * 1.3)), 1 - n * n);
        continue;
      }
      this.line(p.x - rvx * 2.5, p.y - rvy * 2.5, p.x, p.y, p.width ?? 1.5, p.color, 1 - n);
    }

    // Gun smoke and impact vapour (normal blending, so it reads as smoke, not light)
    for (let i = this.smoke.length - 1; i >= 0; i--) {
      const s = this.smoke[i];
      s.life += frames;
      if (s.life >= s.max) { this.smoke.splice(i, 1); continue; }
      rideStep(s, s.anc, 0.95, frames);
      const k = s.life / s.max;
      this.circle(this.smokeG, TEX.dot, s.x, s.y, s.size * (1 + 1.8 * k) * 1.3, s.color ?? 0xb4aea6, (s.alpha ?? 0.16) * (1 - k) * Math.min(1, k * 8));
    }

    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.life += frames;
      if (r.life >= r.max) { this.rings.splice(i, 1); continue; }
      if (r.anc) r.anc.move(r);
      const n = r.life / r.max;
      this.circle(g, TEX.disc, r.x, r.y, r.size * (0.3 + 0.7 * n), r.color, 0.35 * (1 - n));
      this.circle(g, TEX.disc, r.x, r.y, r.size * 0.25 * (1 - n) + 0.5, 0xffffff, 0.8 * (1 - n));
    }
  }

  /** Draws (and ages) the liquid splashes and the layered impacts */
  drawLayered(frames: number): void {
    this.liquid.keep = this.particleKeep;
    if (this.liquid.n) this.liquid.update(frames, this.liquidSink);
    drawHits(this, frames);
  }
}
