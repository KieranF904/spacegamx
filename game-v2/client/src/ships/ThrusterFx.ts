/**
 * Thruster effects. Each engine has its own throttle: engines fire only when
 * they push the way the ship is being driven (or help it turn), spool up fast
 * and die away a little slower. Your own ship reads your controls; every other
 * ship's command is inferred from how its velocity and spin are changing.
 *
 * Looks: per engine a layered additive plume (soft glow, outer flame, hot inner
 * flame, white core, shock diamonds at high throttle) with smooth flicker, a
 * faint nozzle glow at idle, and exhaust particles left behind in the world.
 * Boost makes plumes longer and hotter.
 *
 * All of it is sprites of textures painted once (rendering/fxTextures.ts) and
 * the exhaust a particle container: each frame only moves, stretches and fades
 * them, rather than rebuilding vector shapes.
 */

import { Container, Particle, ParticleContainer, Sprite, Texture } from 'pixi.js';
import { plumeBody, plumeCore, plumeDiamonds, plumeKey, plumeScale, PLUME_ANCHOR, puff, ring, softDot, DOT_SIZE, type PlumeShape } from '../rendering/fxTextures';
import { FRICTION, ShipState, Vec2, worldToLocalDir } from '@space-game/common';
import { decorOf } from './partDecor';
import { engineLookOf, plumeSpec, puffFlicker, sailRing, type EngineLook, type Palette } from './engineLooks';
import type { InterpolatedEntity } from '../state/GameState';
import type { ShipSource } from './ShipStore';
import type { Lighting } from '../rendering/lighting/Lighting';

/** What the pilot is asking for, in the ship's grid frame (forward = -y) */
export interface ThrustCommand {
  /** Desired thrust direction, length 0..1 */
  dir: Vec2;
  /** Turn: -1 (angle decreasing) .. 1 (angle increasing) */
  turn: number;
  boost: boolean;
}

interface EngineState {
  throttle: number[];
  /** Inference for ships we don't fly: last velocity sample and smoothed acceleration */
  lastVx: number;
  lastVy: number;
  lastT: number;
  accel: Vec2;
  seed: number;
  boost: number;
}

interface Spark { x: number; y: number; vx: number; vy: number; life: number; max: number; size: number; hot: boolean; p: Particle; tint: [number, number, number] }

const MAX_PARTICLES = 900;

export const PAL = {
  glow: 0x2a63ff, outer: 0x3d8bff, inner: 0xa8dcff, core: 0xffffff,
  boostOuter: 0x8a6bff, boostInner: 0xe6dcff,
};

/** A colour's hue (degrees), or null for greys (they keep the default blue flame) */
export function hueOf(c: number): number | null {
  const r = ((c >> 16) & 255) / 255, g = ((c >> 8) & 255) / 255, b = (c & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d < 0.12) return null;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

export function hsl(h: number, s: number, l: number): number {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => { const k = (n + h / 30) % 12; return Math.round((l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255); };
  return (f(0) << 16) | (f(8) << 8) | f(4);
}

/** A flame in one hue (10° steps, so a handful of textures at most): outer, inner, glow */
interface Flame { body: Texture; inner: number; light: number }

/** One nozzle's sprites (pooled per ship) */
interface Nozzle { idle: Sprite; body: Sprite; core: Sprite; diamonds: Sprite; puffA: Sprite; puffB: Sprite; ringA: Sprite; ringB: Sprite }

export class ThrusterFx {
  private engines = new Map<number, EngineState>();
  private particles: Spark[] = [];
  private exhaust = new ParticleContainer({ dynamicProperties: { position: true, vertex: true, color: true, rotation: false, uvs: false } });
  private dot = softDot(0.45, 0.07);
  private spare: Particle[] = [];
  private time = 0;
  private nozzles = new WeakMap<Container, Nozzle[]>();
  private tex = {
    body: plumeBody(PAL.outer, PAL.inner, PAL.glow),
    boost: plumeBody(PAL.boostOuter, PAL.boostInner, PAL.glow),
    core: plumeCore(),
    diamonds: plumeDiamonds(),
    puff: puff(),
    ring: ring(),
  };

  constructor(worldLayer: Container, private source: ShipSource) {
    this.exhaust.blendMode = 'add';
    worldLayer.addChildAt(this.exhaust, 0);
  }

  forget(id: number): void {
    this.engines.delete(id);
    this.glows.delete(id);
  }

  /** Each ship's engines as one light: where (thrust-weighted), how hard, boosting, its colour; refreshed when drawn */
  private glows = new Map<number, { x: number; y: number; power: number; boost: number; at: number; color: number }>();
  private flames = new Map<number, Flame>();
  private blue: Flame = { body: this.tex.body, inner: PAL.inner, light: 0x5a9bff };

  /** The flame for a ship tinted `tint` (faction colours or paint; none: the default blue) */
  private flameFor(tint: number | undefined): Flame {
    const h = tint === undefined ? null : hueOf(tint);
    if (h === null) return this.blue;
    const k = (Math.round(h / 10) * 10) % 360;
    let f = this.flames.get(k);
    if (!f) {
      f = { body: plumeBody(hsl(k, 0.95, 0.6), hsl(k, 0.9, 0.85), hsl(k, 1, 0.45)), inner: hsl(k, 0.9, 0.85), light: hsl(k, 0.9, 0.65) };
      this.flames.set(k, f);
    }
    return f;
  }

  /** The engines' light on the hull and whatever's behind (see rendering/lighting) */
  collectLights(L: Lighting): void {
    for (const [id, g] of this.glows) {
      if (g.at !== this.time) { this.glows.delete(id); continue; }
      if (g.power < 0.05) continue;
      L.point(g.x, g.y, g.boost > 0.5 ? 0x9a7bff : g.color, 110 + 70 * Math.min(4, g.power), Math.min(1.3, 0.35 * g.power) * (1 + 0.5 * g.boost), 40);
    }
  }

  /** Once per frame, before the per-ship draws */
  beginFrame(dt: number): void {
    this.time += dt;
    // Age the exhaust left in the world
    let w = 0;
    for (const s of this.particles) {
      s.life -= dt;
      if (s.life <= 0) { this.spare.push(s.p); continue; }
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.vx *= 0.97;
      s.vy *= 0.97;
      // Hot sparks cool from white-blue to deep blue, a soft halo spreading as they go
      const k = s.life / s.max;
      const r = s.size * (0.6 + 0.9 * (1 - k));
      const p = s.p;
      p.x = s.x;
      p.y = s.y;
      p.scaleX = p.scaleY = (r * 2.2 * 2) / DOT_SIZE;
      p.tint = k > 0.6 ? s.tint[0] : k > 0.3 ? s.tint[1] : s.tint[2];
      p.alpha = (s.hot ? 0.75 : 0.5) * k;
      this.particles[w++] = s;
    }
    this.particles.length = w;
    const pc = this.exhaust;
    pc.particleChildren.length = 0;
    for (const s of this.particles) pc.particleChildren.push(s.p);
    pc.update();
  }

  /** The exhaust left in the world (for the bloom) */
  get exhaustLayer(): Container {
    return this.exhaust;
  }

  private spark(): Particle {
    return this.spare.pop() ?? new Particle({ texture: this.dot, anchorX: 0.5, anchorY: 0.5 });
  }

  private sprite(c: Container, texture: Texture, anchorX: number, anchorY: number): Sprite {
    const s = new Sprite(texture);
    s.anchor.set(anchorX, anchorY);
    s.blendMode = 'add';
    c.addChild(s);
    return s;
  }

  /** The sprites for nozzle `i` on a ship */
  private nozzle(c: Container, i: number): Nozzle {
    let list = this.nozzles.get(c);
    if (!list) { list = []; this.nozzles.set(c, list); }
    while (list.length <= i) {
      list.push({
        idle: this.sprite(c, Texture.WHITE, 0.5, 0.5),
        body: this.sprite(c, this.tex.body, PLUME_ANCHOR.x, PLUME_ANCHOR.y),
        core: this.sprite(c, this.tex.core, PLUME_ANCHOR.x, PLUME_ANCHOR.y),
        diamonds: this.sprite(c, this.tex.diamonds, PLUME_ANCHOR.x, PLUME_ANCHOR.y),
        puffA: this.sprite(c, this.tex.puff, 0.5, 0.5),
        puffB: this.sprite(c, this.tex.puff, 0.5, 0.5),
        ringA: this.sprite(c, this.tex.ring, 0.5, 0.5),
        ringB: this.sprite(c, this.tex.ring, 0.5, 0.5),
      });
      const z = list[list.length - 1];
      z.puffA.visible = z.puffB.visible = z.ringA.visible = z.ringB.visible = false;
    }
    return list[i];
  }

  /** The body texture for a palette and shape (painted once each) */
  private bodyTex(p: Palette): Texture {
    const k = plumeKey(p.outer, p.inner, p.glow, p.shape);
    let t = this.bodies.get(k);
    if (!t) { t = plumeBody(p.outer, p.inner, p.glow, p.shape); this.bodies.set(k, t); }
    return t;
  }
  private bodies = new Map<string, Texture>();

  /**
   * Draw one ship's engines into `g` (the ship's rotating container, grid units
   * scaled by `cs`, origin at the centre of mass).
   */
  draw(c: Container, ship: ShipState, e: InterpolatedEntity, command: ThrustCommand | null, dt: number, cs: number, tint?: number): void {
    let used = 0;
    const hideRest = () => { for (const n of (this.nozzles.get(c) ?? []).slice(used)) n.idle.visible = n.body.visible = n.core.visible = n.diamonds.visible = n.puffA.visible = n.puffB.visible = n.ringA.visible = n.ringB.visible = false; };
    if (ship.kind !== 'ship' || !ship.derived.thrusters.length) { hideRest(); return; }
    let st = this.engines.get(e.id);
    if (!st) {
      st = { throttle: [], lastVx: e.vx, lastVy: e.vy, lastT: this.time, accel: [0, 0], seed: (e.id * 7.31) % 100, boost: 0 };
      this.engines.set(e.id, st);
    }
    const cmd = command ?? this.infer(st, ship, e);
    st.boost += ((cmd.boost ? 1 : 0) - st.boost) * Math.min(1, dt * 8);
    const mag = Math.hypot(cmd.dir[0], cmd.dir[1]);
    const ux = mag > 1e-6 ? cmd.dir[0] / mag : 0, uy = mag > 1e-6 ? cmd.dir[1] / mag : 0;

    const [cx, cy] = ship.derived.com;
    const geoms = this.source.geometry(ship);
    const flame = this.flameFor(tint);
    const angle = e.renderAngle + Math.PI / 2;
    const ca = Math.cos(angle), sa = Math.sin(angle);
    const shipVx = e.vx * 60, shipVy = e.vy * 60; // world units / s

    let gx = 0, gy = 0, gp = 0;
    ship.derived.thrusters.forEach((t, i) => {
      const f = Math.hypot(t.force[0], t.force[1]);
      // (a rigid design flies on its engines as built: only those still on it burn)
      if (f <= 0 || !ship.derived.alive[t.part]) return;
      // How much this engine helps: along the requested direction, or with the turn
      let want = Math.max(0, (t.force[0] / f) * ux + (t.force[1] / f) * uy) * Math.min(1, mag);
      if (Math.abs(cmd.turn) > 0.15 && Math.sign(t.torque) === Math.sign(cmd.turn)) want = Math.max(want, 0.55 * Math.min(1, Math.abs(cmd.turn)));
      want = want > 0.12 ? want : 0;
      const prev = st!.throttle[i] ?? 0;
      const thr = prev + (want - prev) * Math.min(1, dt * (want > prev ? 14 : 6));
      st!.throttle[i] = thr;

      // Out of each nozzle's exit (partDecor draws the bells)
      const look = engineLookOf(ship.blueprint.parts[t.part]?.fn);
      for (const nz of decorOf(geoms[t.part]).nozzles) {
        const n = nz.n;
        const mx = (nz.at[0] - cx) * cs, my = (nz.at[1] - cy) * cs;
        const edge = nz.width * cs * 1.05;
        const tx = nz.t[0], ty = nz.t[1];
        this.plume(this.nozzle(c, used++), mx, my, n[0], n[1], tx, ty, edge, thr, st!.boost, st!.seed + i * 1.7, cs, flame, look);
        // Its share of the engines' light, a little behind the nozzle
        const lp = thr * (edge / cs);
        if (lp > 0) {
          const lx = mx + n[0] * cs, ly = my + n[1] * cs;
          gx += (e.renderX + lx * ca - ly * sa) * lp; gy += (e.renderY + lx * sa + ly * ca) * lp; gp += lp;
        }
        // Exhaust: spawn in world space, thrown out of the nozzle on top of the ship's own motion
        if (thr > 0.25 && this.particles.length < MAX_PARTICLES) {
          const rate = thr * (edge / cs) * (1 + st!.boost * (look.boostGain > 0 ? 1 : 0)) * 38 * look.motes;
          let count = rate * dt;
          while (count > 0) {
            if (count < 1 && Math.random() > count) break;
            count -= 1;
            const off = (Math.random() - 0.5) * edge * 0.7;
            const lx = mx + tx * off + n[0] * cs * 0.3, ly = my + ty * off + n[1] * cs * 0.3;
            const wx = e.renderX + lx * ca - ly * sa, wy = e.renderY + lx * sa + ly * ca;
            const nx = n[0] * ca - n[1] * sa, ny = n[0] * sa + n[1] * ca;
            const speed = (220 + Math.random() * 180) * (1 + st!.boost * (look.boostGain > 0 ? 0.6 : 0)) * (0.6 + 0.4 * thr) * look.moteSpeed;
            const life = 0.25 + Math.random() * 0.45;
            this.particles.push({
              x: wx, y: wy, vx: shipVx + nx * speed + (Math.random() - 0.5) * 40, vy: shipVy + ny * speed + (Math.random() - 0.5) * 40,
              life, max: life, size: (edge * 0.11 + 1.2) * (0.7 + Math.random() * 0.6), hot: Math.random() < 0.35, p: this.spark(), tint: look.moteTint,
            });
          }
        }
      }
    });
    this.glows.set(e.id, { x: gp > 0 ? gx / gp : e.renderX, y: gp > 0 ? gy / gp : e.renderY, power: gp, boost: st.boost, at: this.time, color: flame.light });
    hideRest();
  }

  /** One engine's flame, in the ship's frame: base at (mx, my) on the nozzle edge, pointing along n */
  private plume(z: Nozzle, mx: number, my: number, nx: number, ny: number, tx: number, ty: number,
    edge: number, thr: number, boost: number, seed: number, cs: number, flame: Flame, look: EngineLook): void {
    const w = edge * 0.42; // half-width at the nozzle
    // Idle: just a faint glow in the nozzle (none on a cold-gas jet or a sail)
    z.idle.visible = look.kind === 'plume';
    z.idle.position.set(mx, my);
    z.idle.rotation = Math.atan2(ty, tx);
    z.idle.scale.set(w * 2, Math.max(1.5, cs * 0.18));
    z.idle.tint = look.pal ? look.pal.inner : flame.inner;
    z.idle.alpha = 0.18 + 0.6 * thr;
    const t = this.time;
    if (look.kind === 'puff') {
      // Cold gas: white puffs that blink on and off, no flame
      z.body.visible = z.core.visible = z.diamonds.visible = z.ringA.visible = z.ringB.visible = false;
      const f = thr < 0.03 ? 0 : puffFlicker(t, seed) * Math.min(1, thr * 1.5);
      z.puffA.visible = z.puffB.visible = f > 0;
      if (f <= 0) return;
      const d = (edge * 1.1) / 64;
      z.puffA.position.set(mx + nx * cs * 0.3, my + ny * cs * 0.3);
      z.puffA.tint = 0xf2f7ff; z.puffA.alpha = 0.85 * f; z.puffA.scale.set(d * (0.8 + 0.4 * f));
      z.puffB.position.set(mx + nx * cs * 0.85, my + ny * cs * 0.85);
      z.puffB.tint = 0xc9d6e6; z.puffB.alpha = 0.4 * f; z.puffB.scale.set(d * (1.3 + 0.5 * f));
      return;
    }
    if (look.kind === 'sail') {
      // A sail: two soft rings breathing against each other behind the nozzle, a glow between
      z.body.visible = z.core.visible = z.diamonds.visible = z.puffB.visible = false;
      const r = sailRing(t, seed, thr), k = (edge * 2 * (64 / 56)) / 64;
      z.ringA.visible = z.ringB.visible = z.puffA.visible = true;
      z.ringA.position.set(mx + nx * cs * 0.6, my + ny * cs * 0.6);
      z.ringA.tint = 0x9fd4ff; z.ringA.alpha = r.a; z.ringA.scale.set(k * r.r * 0.9);
      z.ringB.position.set(mx + nx * cs * 1.0, my + ny * cs * 1.0);
      z.ringB.tint = 0xc8e6ff; z.ringB.alpha = r.a2; z.ringB.scale.set(k * r.r2 * 1.3);
      z.puffA.position.set(mx + nx * cs * 0.8, my + ny * cs * 0.8);
      z.puffA.tint = 0x6aa8ff; z.puffA.alpha = 0.16 + 0.3 * thr; z.puffA.scale.set((edge * 2.4) / 64);
      return;
    }
    z.puffA.visible = z.puffB.visible = z.ringA.visible = z.ringB.visible = false;
    if (thr < 0.03) { z.body.visible = z.core.visible = z.diamonds.visible = false; return; }
    const sp = plumeSpec(look, thr, boost, edge, cs, t, seed);
    const rot = Math.atan2(ny, nx);
    const sc = plumeScale(sp.L, sp.w);
    z.body.position.set(mx, my); z.body.rotation = rot; z.body.scale.set(sc.x, sc.y);
    z.core.position.set(mx, my); z.core.rotation = rot; z.core.scale.set(sc.x * sp.coreLen, sc.y * sp.coreWidth);
    z.diamonds.position.set(mx, my); z.diamonds.rotation = rot; z.diamonds.scale.set(sc.x, sc.y);
    z.body.visible = true;
    z.body.texture = sp.pal ? this.bodyTex(sp.pal) : flame.body;
    z.body.alpha = thr;
    z.core.visible = true;
    z.core.alpha = Math.min(1, thr * 1.4);
    // Shock diamonds once the engine is really working
    z.diamonds.visible = sp.diamonds > 0;
    if (sp.diamonds > 0) z.diamonds.alpha = sp.diamonds;
  }

  /**
   * For ships we don't fly: the commanded acceleration is what changed the
   * velocity, plus what friction is taking away. Snapshots arrive in steps, so
   * the rate of change only updates when the velocity actually changes.
   */
  private infer(st: EngineState, ship: ShipState, e: InterpolatedEntity): ThrustCommand {
    // Rate of velocity change (updated when a new velocity arrives, fading otherwise)...
    if (e.vx !== st.lastVx || e.vy !== st.lastVy) {
      const ticks = Math.max(1, (this.time - st.lastT) * 60);
      st.accel[0] += ((e.vx - st.lastVx) / ticks - st.accel[0]) * 0.5;
      st.accel[1] += ((e.vy - st.lastVy) / ticks - st.accel[1]) * 0.5;
      st.lastVx = e.vx;
      st.lastVy = e.vy;
      st.lastT = this.time;
    } else if (this.time - st.lastT > 0.25) {
      st.accel[0] *= 0.8;
      st.accel[1] *= 0.8;
    }
    // ...plus what friction is taking right now: at cruise speed the engines only fight friction
    const want: Vec2 = [st.accel[0] + e.vx * (1 - FRICTION), st.accel[1] + e.vy * (1 - FRICTION)];
    const d = ship.derived;
    const maxA = Math.max(1e-6, Math.max(d.maxThrust.forward, d.maneuverForce) / Math.max(1e-6, d.mass));
    const local = worldToLocalDir(want, e.renderAngle);
    const a = Math.hypot(local[0], local[1]) / maxA;
    const scale = a > 0.15 ? Math.min(1, a) / (a || 1) : 0;
    return {
      dir: [local[0] / maxA * scale, local[1] / maxA * scale],
      turn: Math.max(-1, Math.min(1, (e.angVel ?? 0) / 0.05)),
      boost: a > 1.4,
    };
  }
}
