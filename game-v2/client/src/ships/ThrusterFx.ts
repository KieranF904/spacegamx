/**
 * Thruster effects. Each engine has its own throttle: engines fire only when
 * they push the way the ship is being driven (or help it turn), spool up fast
 * and die away a little slower. Your own ship reads your controls; every other
 * ship's command is inferred from how its velocity and spin are changing.
 *
 * Looks: each engine model's own (engineLooks.ts: the table and the arithmetic,
 * shared with the native renderer). Every nozzle has the same fixed set of
 * sprites (a haze, the nozzle glow, two rings, the flame's body, core and
 * diamonds, two blobs); the look decides which are on and where. Exhaust
 * particles are left behind in the world. Boost makes plumes longer and hotter.
 *
 * All of it is sprites of textures painted once (rendering/fxTextures.ts) and
 * the exhaust a particle container: each frame only moves, stretches and fades
 * them, rather than rebuilding vector shapes.
 */

import { Container, Particle, ParticleContainer, Sprite, Texture } from 'pixi.js';
import { plumeBody, plumeCore, plumeDiamonds, plumeKey, plumeScale, PLUME_ANCHOR, puff, ring, softDot, DOT_SIZE } from '../rendering/fxTextures';
import { FRICTION, ShipState, Vec2, worldToLocalDir } from '@space-game/common';
import { decorOf } from './partDecor';
import {
  engineLookOf, initMote, moteAlpha, moteRadius, moteRate, moteTint, newMote, newNozzleDraw, nozzleDraw, stepMote,
  BOOST_LIGHT, PLUME_SLOT, SLOTS, SLOT_TEX, TEX_PX, type EngineLook, type Mote, type NozzleDraw, type Palette, type SlotTex,
} from './engineLooks';
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

/** An exhaust mote and its particle (pooled: a spent one goes back to `spare` whole) */
interface Spark extends Mote { p: Particle }

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

/** One nozzle's sprites (pooled per ship), one per engineLooks SLOTS entry in that order, and the tint each was last given */
interface Nozzle { s: Sprite[]; tint: number[] }
const BODY_SLOT = SLOTS.indexOf('body');
/** Per slot, by index: anchored as a plume, and the texture's size in px (the centred ones) */
const SLOT_PLUME = SLOTS.map((s) => PLUME_SLOT[s]);
const SLOT_PX = SLOTS.map((s) => TEX_PX[SLOT_TEX[s]]);
/** plumeScale is linear in length and width: its factors */
const PLUME_PER = plumeScale(1, 1);

export class ThrusterFx {
  private engines = new Map<number, EngineState>();
  private particles: Spark[] = [];
  private exhaust = new ParticleContainer({ dynamicProperties: { position: true, vertex: true, color: true, rotation: false, uvs: false } });
  private dot = softDot(0.45, 0.07);
  private spare: Spark[] = [];
  /** One nozzle's layers, refilled for each nozzle drawn */
  private layers: NozzleDraw = newNozzleDraw();
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
  /** The texture each slot starts with (the body's is swapped per palette) */
  private slotTex: Record<SlotTex, Texture> = {
    white: Texture.WHITE, body: this.tex.body, core: this.tex.core, diamonds: this.tex.diamonds, puff: this.tex.puff, ring: this.tex.ring,
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
  private glows = new Map<number, { x: number; y: number; power: number; boost: number; at: number; color: number; boostColor: number }>();
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
      L.point(g.x, g.y, g.boost > 0.5 ? g.boostColor : g.color, 110 + 70 * Math.min(4, g.power), Math.min(1.3, 0.35 * g.power) * (1 + 0.5 * g.boost), 40);
    }
  }

  /** Once per frame, before the per-ship draws */
  beginFrame(dt: number): void {
    this.time += dt;
    // Age the exhaust left in the world (each look's drag and swirl; they cool through its three colours, a soft halo spreading)
    let w = 0;
    for (const s of this.particles) {
      if (!stepMote(s, dt)) { this.spare.push(s); continue; }
      const p = s.p;
      p.x = s.x;
      p.y = s.y;
      p.scaleX = p.scaleY = (moteRadius(s) * 2.2 * 2) / DOT_SIZE;
      p.tint = moteTint(s);
      p.alpha = moteAlpha(s);
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

  private spark(): Spark {
    return this.spare.pop() ?? Object.assign(newMote(), { p: new Particle({ texture: this.dot, anchorX: 0.5, anchorY: 0.5 }) });
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
      const z: Nozzle = { s: [], tint: [] };
      for (const slot of SLOTS) {
        const sp = this.sprite(c, this.slotTex[SLOT_TEX[slot]], PLUME_SLOT[slot] ? PLUME_ANCHOR.x : 0.5, PLUME_SLOT[slot] ? PLUME_ANCHOR.y : 0.5);
        sp.visible = false;
        z.s.push(sp);
        z.tint.push(0xffffff);
      }
      list.push(z);
    }
    return list[i];
  }

  /** The body texture for a palette and shape (painted once each; found by the palette object, so no key is built per frame) */
  private bodyTex(p: Palette): Texture {
    let t = this.bodyOf.get(p);
    if (!t) {
      const k = plumeKey(p.outer, p.inner, p.glow, p.shape);
      t = this.bodies.get(k) ?? plumeBody(p.outer, p.inner, p.glow, p.shape);
      this.bodies.set(k, t);
      this.bodyOf.set(p, t);
    }
    return t;
  }
  private bodies = new Map<string, Texture>();
  private bodyOf = new Map<Palette, Texture>();

  /**
   * Draw one ship's engines into `g` (the ship's rotating container, grid units
   * scaled by `cs`, origin at the centre of mass).
   */
  draw(c: Container, ship: ShipState, e: InterpolatedEntity, command: ThrustCommand | null, dt: number, cs: number, tint?: number, frost = 0, emp = false): void {
    let used = 0;
    const hideRest = () => {
      const list = this.nozzles.get(c);
      if (list) for (let k = used; k < list.length; k++) for (const sp of list[k].s) sp.visible = false;
    };
    if (ship.kind !== 'ship' || !ship.derived.thrusters.length) { hideRest(); return; }
    let st = this.engines.get(e.id);
    if (!st) {
      st = { throttle: [], lastVx: e.vx, lastVy: e.vy, lastT: this.time, accel: [0, 0], seed: (e.id * 7.31) % 100, boost: 0 };
      this.engines.set(e.id, st);
    }
    const cmd = command ?? this.infer(st, ship, e);
    // (An EMP'd drive goes dark: the throttle falls to nothing whatever the keys say)
    st.boost += ((cmd.boost && !emp ? 1 : 0) - st.boost) * Math.min(1, dt * 8);
    const mag = Math.hypot(cmd.dir[0], cmd.dir[1]);
    const ux = mag > 1e-6 ? cmd.dir[0] / mag : 0, uy = mag > 1e-6 ? cmd.dir[1] / mag : 0;

    const [cx, cy] = ship.derived.com;
    const geoms = this.source.geometry(ship);
    const flame = this.flameFor(tint);
    const angle = e.renderAngle + Math.PI / 2;
    const ca = Math.cos(angle), sa = Math.sin(angle);
    const shipVx = e.vx * 60, shipVy = e.vy * 60; // world units / s

    let gx = 0, gy = 0, gp = 0, top = 0, light = flame.light, boostLight = BOOST_LIGHT;
    ship.derived.thrusters.forEach((t, i) => {
      const f = Math.hypot(t.force[0], t.force[1]);
      // (a rigid design flies on its engines as built: only those still on it burn)
      if (f <= 0 || !ship.derived.alive[t.part]) return;
      // How much this engine helps: along the requested direction, or with the turn
      let want = Math.max(0, (t.force[0] / f) * ux + (t.force[1] / f) * uy) * Math.min(1, mag);
      if (Math.abs(cmd.turn) > 0.15 && Math.sign(t.torque) === Math.sign(cmd.turn)) want = Math.max(want, 0.55 * Math.min(1, Math.abs(cmd.turn)));
      want = want > 0.12 && !emp ? want : 0;
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
        const pulse = this.plume(this.nozzle(c, used++), mx, my, n[0], n[1], tx, ty, edge, thr, st!.boost, st!.seed + i * 1.7, cs, flame, look, frost);
        // Its share of the engines' light, a little behind the nozzle (coloured as the strongest engine burns)
        const lp = thr * (edge / cs);
        if (lp > 0) {
          const lx = mx + n[0] * cs, ly = my + n[1] * cs;
          gx += (e.renderX + lx * ca - ly * sa) * lp; gy += (e.renderY + lx * sa + ly * ca) * lp; gp += lp;
          if (lp > top) { top = lp; light = look.light ?? look.pal?.outer ?? flame.light; boostLight = look.boostPal?.outer ?? look.light ?? BOOST_LIGHT; }
        }
        // Exhaust: spawn in world space, thrown out of the nozzle on top of the ship's own motion
        let count = this.particles.length < MAX_PARTICLES ? moteRate(look, thr, st!.boost, edge, cs, pulse) * dt : 0;
        if (count > 0) {
          const ox = e.renderX + mx * ca - my * sa, oy = e.renderY + mx * sa + my * ca;
          const nx = n[0] * ca - n[1] * sa, ny = n[0] * sa + n[1] * ca, wtx = tx * ca - ty * sa, wty = tx * sa + ty * ca;
          while (count > 0 && this.particles.length < MAX_PARTICLES) {
            if (count < 1 && Math.random() > count) break;
            count -= 1;
            this.particles.push(initMote(this.spark(), look, thr, st!.boost, edge, cs, frost, Math.random, ox, oy, nx, ny, wtx, wty, shipVx, shipVy) as Spark);
          }
        }
      }
    });
    this.glows.set(e.id, { x: gp > 0 ? gx / gp : e.renderX, y: gp > 0 ? gy / gp : e.renderY, power: gp, boost: st.boost, at: this.time, color: light, boostColor: boostLight });
    hideRest();
  }

  /**
   * One nozzle's layers (engineLooks.nozzleDraw), in the ship's frame: the exit's middle at (mx, my), pointing along n,
   * across it t. Every slot is placed the same way whatever the model; the look decides which are on. Returns the throb
   * (the exhaust follows it).
   */
  private plume(z: Nozzle, mx: number, my: number, nx: number, ny: number, tx: number, ty: number,
    edge: number, thr: number, boost: number, seed: number, cs: number, flame: Flame, look: EngineLook, frost = 0): number {
    const d = nozzleDraw(this.layers, look, thr, boost, edge, cs, this.time, seed, flame.inner, frost);
    const rot = Math.atan2(ny, nx);
    for (let i = 0; i < SLOTS.length; i++) {
      const l = d[SLOTS[i]], sp = z.s[i];
      sp.visible = l.on;
      if (!l.on) continue;
      sp.position.set(mx + nx * l.a + tx * l.s, my + ny * l.a + ty * l.s);
      sp.rotation = rot + l.rot;
      // (a tint is parsed each time it's set: only when it changes)
      if (z.tint[i] !== l.tint) { sp.tint = l.tint; z.tint[i] = l.tint; }
      sp.alpha = l.alpha;
      if (SLOT_PLUME[i]) sp.scale.set(l.len * PLUME_PER.x, l.wid * PLUME_PER.y);
      else sp.scale.set(l.len / SLOT_PX[i], l.wid / SLOT_PX[i]);
    }
    // (the body's texture: the look's palette, or the ship's tinted flame)
    if (d.body.on) z.s[BODY_SLOT].texture = d.pal ? this.bodyTex(d.pal) : flame.body;
    return d.pulse;
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
