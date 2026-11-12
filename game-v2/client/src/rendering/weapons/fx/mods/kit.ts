/**
 * @contract client.weapon-fx.mods.kit
 * owns:       what every modifier layer draws and throws with: one reused context (ModCtx) carrying the shot's pose, the
 *             effect's look, a random stream seeded from the shot, the particle budget, the emitters into FxField's lists and
 *             the direct draws into its pools; the marks (shapes that outlive a frame, riding what was hit); the beam context
 * needs:      FxField (lists incl. shock rings, pools, particleKeep), particleTypes (caps, textures), impactAnchor, looks; npm: pixi.js (Graphics type)
 * invariants: a layer's variation comes from the shot (its id, the effect, the stage), never Math.random; an emitter makes
 *             nothing past the shot's budget or a list's cap — client/src/rendering/weapons/fx/mods/mods.test.ts
 * extend:     a new kind of emission is one method on ModCtx
 */

import type { Graphics } from 'pixi.js';
import { petalScale, DOT_SIZE } from '../../../fxTextures';
import type { ImpactAnchor } from '../../impactAnchor';
import type { FxField } from '../FxField';
import { FRAG_CAP, HIT_CAP, SMOKE_CAP, TEX, TEX3, mixColor } from '../particleTypes';
import type { Shot } from '../shotTypes';
import { MARK_CAP, type ModLook } from './looks';

/** One live effect on a shot or beam: its id (index in tuning `modifiers.effects`) and strength 0..1 */
export interface ModFx { readonly fx: number; readonly k: number }

/** What fire cools to, gun smoke's grey, soot */
export const COOL = 0x7a2a10, GREY = 0xb4aea6, SOOT = 0x18120e;

/** Fast out, slowing (0..1) */
export const ease = (n: number): number => 1 - Math.pow(1 - Math.min(1, Math.max(0, n)), 3);

export type MarkDraw = (c: ModCtx, m: Mark, frames: number) => void;
/** A layer's shape that outlives the frame (an arc crackling, a flame clinging): drawn by `draw` each frame of its life, riding `anc` */
export interface Mark {
  x: number; y: number; a: number; life: number; max: number; k: number; s: number; color: number; seed: number;
  /** Numbers of its own (an end point's offset, a reach) */
  d: number[];
  draw: MarkDraw; look: ModLook; anc?: ImpactAnchor;
  /** Kept up by its shot while that flies (ModCtx.keep) */
  key?: number;
}

/** A field's modifier state: its marks, the ones kept by key, the layer particles made lately (the budget's load), and the blasts told with no shell (index.ts modBlast: each its own number) */
export interface ModState { marks: Mark[]; kept: Map<number, Mark>; load: number; blasts: number }
const STATES = new WeakMap<object, ModState>();
export function stateOf(f: FxField): ModState {
  let s = STATES.get(f);
  if (!s) STATES.set(f, s = { marks: [], kept: new Map(), load: 0, blasts: 0 });
  return s;
}

const fract = (v: number): number => v - Math.floor(v);

export class ModCtx {
  f!: FxField;
  st!: ModState;
  shot: Shot | undefined;
  look!: ModLook;
  color = 0xffffff;
  /** The effect's id (with the shot's, a kept mark's key) */
  fx = 0;
  /** Where: the muzzle, the shell's head, or the hit; `a` the shot's direction, (ux, uy) its unit, (nx, ny) its left normal */
  x = 0; y = 0; a = 0; ux = 1; uy = 0; nx = 0; ny = 1;
  /** The size things are drawn to: the muzzle flash's, the shell's (its drawn half-width), the impact's */
  s = 10;
  /** In flight: the tracer's tail, its length, its light (fade and dimming), this frame's length, the clock */
  bx = 0; by = 0; dl = 0; alpha = 1; frames = 1; clock = 0;
  /** At a hit: the angle its parts are thrown at, whether that is off a known surface, and the blast radius if it has one */
  out = 0; surface = false; R = 0;
  /** What its particles ride (set for a mark on a target; a hit's own are bound by ImpactFx's group) */
  anc: ImpactAnchor | undefined;
  /** Particles it may still make, and x its counts (quality and load) */
  left = 0; thin = 1;
  /** x the speed its thrown particles are given (a big gun's hit throws further) */
  vs = 1;
  private r = 1;
  private base = 0;

  /** Points it along angle `a` */
  aim(a: number): void {
    this.a = a; this.ux = Math.cos(a); this.uy = Math.sin(a); this.nx = -this.uy; this.ny = this.ux;
  }

  /** Starts the random stream for (shot or mark, effect and stage, step); the steady numbers (`h`) are of the first two alone */
  seed(a: number, b: number, c: number): void {
    let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263) + Math.imul(c | 0, 1274126177)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1103515245);
    this.r = (h ^ (h >>> 16)) >>> 0;
    this.base = fract(Math.abs(a) * 0.6180339 + b * 0.371);
  }

  rnd = (): number => {
    this.r = (this.r + 0x6d2b79f5) >>> 0;
    let t = this.r;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  /** Within ±w/2 */
  jit(w: number): number { return (this.rnd() - 0.5) * w; }
  /** Between lo and hi */
  range(lo: number, hi: number): number { return lo + (hi - lo) * this.rnd(); }
  /** The shot's own number i (0..1), the same every frame of its flight */
  h(i: number): number { return fract(Math.sin((this.base + i) * 127.1 + i * 311.7) * 43758.5453); }

  /** How many of `count` to make now: thinned by quality and load, never more than the budget has left (a fraction is made that share of the time) */
  n(count: number): number {
    return Math.max(0, Math.min(this.left, Math.floor(count * this.thin + this.rnd())));
  }

  private take(): boolean {
    if (this.left <= 0) return false;
    this.left--; this.st.load++;
    return true;
  }

  /** A bright streak flying along `a` (cooling to `cool` if given: an ember) */
  spark(x: number, y: number, a: number, v: number, max: number, color: number, width = 1.5, drag = 0.9, cool?: number): void {
    if (this.f.sparks.length >= HIT_CAP * 2 || !this.take()) return;
    this.f.sparks.push({ x, y, vx: Math.cos(a) * v * this.vs, vy: Math.sin(a) * v * this.vs, life: 0, max, color, width, drag, cool, anc: this.anc });
    this.anc?.hold(max + 2);
  }

  /** A smoke or vapour puff of radius r drifting along `a` (`delay` frames before it shows) */
  puff(x: number, y: number, a: number, v: number, r: number, max: number, color = GREY, alpha = 0.2, delay = 0): void {
    if (this.f.smoke.length >= SMOKE_CAP || !this.take()) return;
    this.f.smoke.push({ x, y, vx: Math.cos(a) * v * this.vs, vy: Math.sin(a) * v * this.vs, life: -delay, max, size: r, color, alpha, anc: this.anc });
    this.anc?.hold(max + delay + 2);
  }

  /** A ball of fire rolling along `a`, swelling and cooling to `cool` */
  fire(x: number, y: number, a: number, v: number, r: number, max: number, color: number, cool = COOL, delay = 0): void {
    if (this.f.hitGlows.length >= HIT_CAP || !this.take()) return;
    this.f.hitGlows.push({ x, y, life: -delay, max, size: r, color, core: false, vx: Math.cos(a) * v * this.vs, vy: Math.sin(a) * v * this.vs, cool, anc: this.anc });
    this.anc?.hold(max + delay + 2);
  }

  /** A still light: a hard flash shrinking away (`core`) or a glow swelling out */
  glow(x: number, y: number, r: number, max: number, color: number, core = false, delay = 0): void {
    if (this.f.hitGlows.length >= HIT_CAP || !this.take()) return;
    this.f.hitGlows.push({ x, y, life: -delay, max, size: r, color, core, anc: this.anc });
    this.anc?.hold(max + delay + 2);
  }

  /** A glowing chunk tumbling off along `a`, slowing, cooling and smoking */
  frag(x: number, y: number, a: number, v: number, size: number, max: number, hot: number, cool: number, drag = 0.95, smokes = 0.5): void {
    if (!this.take()) return;
    if (this.f.frags.length >= FRAG_CAP) this.f.frags.shift();
    this.f.fragsMade++;
    this.f.frags.push({ x, y, vx: Math.cos(a) * v * this.vs, vy: Math.sin(a) * v * this.vs, life: 0, max, size, hot, cool, trail: hot, drag, puff: this.rnd() * 3, smokes, anc: this.anc });
    this.anc?.hold(max + 2);
  }

  /** A streak shooting out along `a` to `len` and lifting off */
  flare(x: number, y: number, a: number, len: number, width: number, max: number, color: number): void {
    if (this.f.flares.length >= 128 || !this.take()) return;
    this.f.flares.push({ x, y, a, len, width, life: 0, max, color, anc: this.anc });
  }

  /** A thin shock ring racing out to radius `r` (`delay` frames before it starts) */
  shock(x: number, y: number, r: number, width: number, max: number, color: number, delay = 0): void {
    if (this.f.shocks.length < HIT_CAP) this.f.shocks.push({ x, y, life: -delay, max, size: r, width, color, anc: this.anc });
    this.anc?.hold(max + delay + 2);
  }

  /** A glow left on what was hit, cooling */
  scorch(x: number, y: number, r: number, max: number, color: number): void {
    if (this.f.scorches.length < HIT_CAP) this.f.scorches.push({ x, y, life: 0, max, size: r, color, anc: this.anc });
  }

  /** Light thrown on what is near */
  light(x: number, y: number, radius: number, power: number, max: number, color = this.color): void {
    if (this.f.hitLights.length < 64) this.f.hitLights.push({ x, y, life: 0, max, radius, power, color, anc: this.anc });
  }

  /** A shape drawn by `draw` for `max` frames from `delay` frames on, at (x, y) turned to `a`, sized `s` at strength k */
  mark(draw: MarkDraw, x: number, y: number, a: number, max: number, k: number, s: number, d: number[] = [], delay = 0): Mark {
    const marks = this.st.marks;
    if (marks.length >= MARK_CAP) { const old = marks.shift()!; if (old.key !== undefined) this.st.kept.delete(old.key); }
    const m: Mark = { x, y, a, life: -delay, max, k, s, color: this.color, seed: (this.rnd() * 0x7fffffff) | 0, d, draw, look: this.look, anc: this.anc };
    marks.push(m);
    this.anc?.hold(max + delay + 2);
    return m;
  }

  /**
   * The shot's own mark for this effect, made on its first call and kept young while the shot calls it each frame: it
   * lives its `max` frames on from the last call (an afterimage of where the shot got to). Returns it, to be brought up to date
   */
  keep(draw: MarkDraw, max: number, k: number): Mark {
    const key = (this.shot?.id ?? 0) * 16 + this.fx;
    let m = this.st.kept.get(key);
    if (!m) { m = this.mark(draw, this.x, this.y, this.a, max, k, this.s); m.key = key; this.st.kept.set(key, m); }
    m.life = 0;
    return m;
  }

  // Direct draws (this frame only)

  line(x0: number, y0: number, x1: number, y1: number, w: number, color: number, alpha: number): void {
    if (alpha > 0.004) this.f.line(x0, y0, x1, y1, w, color, alpha);
  }

  /** A soft-edged dot */
  dot(x: number, y: number, r: number, color: number, alpha: number): void {
    if (alpha > 0.004) this.f.circle(this.f.glow, TEX.dot, x, y, r, color, alpha);
  }

  /** A hard-edged disc (a body, not a light) */
  disc(x: number, y: number, r: number, color: number, alpha: number): void {
    if (alpha > 0.004) this.f.circle(this.f.glow, TEX.disc, x, y, r, color, alpha);
  }

  /** A ball of light (additive), `stretch` times longer along `rot` */
  ball(x: number, y: number, r: number, color: number, alpha: number, rot = 0, stretch = 1): void {
    if (alpha <= 0.004) return;
    const k = (r * 2) / DOT_SIZE;
    this.f.hitG.take(TEX3.ball, x, y, 0.5, 0.5, color, alpha, rot, k * stretch, k);
  }

  /** A lick of flame from (x, y) along `dir`, `len` long and `half` wide at its belly */
  petal(x: number, y: number, dir: number, len: number, half: number, color: number, alpha: number): void {
    if (alpha <= 0.004 || len <= 0.2) return;
    const k = petalScale(len, Math.max(0.5, half));
    this.f.glow.take(TEX.petal, x, y, 0, 0.5, color, alpha, dir, k.x, k.y);
  }

  /** A soft tongue of flame from (x, y) along `dir`: a body of light, a cooler tip beyond it and a pale root */
  flame(x: number, y: number, dir: number, len: number, half: number, color: number, alpha: number): void {
    if (alpha <= 0.004 || len <= 0.4) return;
    const ux = Math.cos(dir), uy = Math.sin(dir), h = Math.max(0.6, half);
    this.ball(x + ux * len * 0.34, y + uy * len * 0.34, h, color, alpha, dir, Math.max(1, (len * 0.42) / h));
    this.ball(x + ux * len * 0.68, y + uy * len * 0.68, h * 0.6, mixColor(color, 0xc2260c, 0.55), alpha * 0.8, dir, Math.max(1, (len * 0.36) / (h * 0.6)));
    this.ball(x + ux * len * 0.16, y + uy * len * 0.16, h * 0.55, 0xfff0c8, alpha * 0.9, dir, Math.max(1, (len * 0.2) / (h * 0.55)));
  }

  /** A smoke-dark dot under the light (normal blending) */
  soot(x: number, y: number, r: number, color: number, alpha: number): void {
    if (alpha > 0.004) this.f.circle(this.f.smokeG, TEX.dot, x, y, r, color, alpha);
  }

  /**
   * A jagged bolt from (x0, y0) to (x1, y1): `segs` lengths each thrown up to `amp` off the line (most in the middle), an
   * accent line under a thin white one. Drawn from the random stream as it stands: seed by time step for a crackle
   */
  bolt(x0: number, y0: number, x1: number, y1: number, amp: number, segs: number, color: number, alpha: number, w = 1.3): void {
    const dx = x1 - x0, dy = y1 - y0, l = Math.hypot(dx, dy) || 1, px = -dy / l, py = dx / l;
    let lx = x0, ly = y0;
    for (let i = 1; i <= segs; i++) {
      const t = i / segs, o = i === segs ? 0 : this.jit(2) * amp * Math.sin(t * Math.PI);
      const x = x0 + dx * t + px * o, y = y0 + dy * t + py * o;
      this.line(lx, ly, x, y, w * 2.4, color, 0.45 * alpha);
      this.line(lx, ly, x, y, w * 0.8, 0xffffff, 0.95 * alpha);
      lx = x; ly = y;
    }
  }

  /**
   * A crescent front centred on (cx, cy) facing along (ux, uy): `hw` to each side, its tips swept back `bow` x hw, thick
   * in the middle and thinning to its tips
   */
  crescent(cx: number, cy: number, ux: number, uy: number, hw: number, bow: number, w: number, color: number, alpha: number, segs = 6): void {
    if (alpha <= 0.004) return;
    let lx = 0, ly = 0;
    for (let j = 0; j <= segs; j++) {
      const t = (j / segs) * 2 - 1, o = t * hw, back = bow * hw * t * t;
      const x = cx - uy * o - ux * back, y = cy + ux * o - uy * back;
      if (j > 0) { const m = Math.abs(t - 1 / segs); this.f.line(lx, ly, x, y, w * (1 - 0.72 * m * m), color, alpha * (1 - 0.6 * m)); }
      lx = x; ly = y;
    }
  }
}

/** A held or pulsed beam's pose and light this frame, for the beam layers (plain Graphics, nothing kept: all from `t` and `seed`) */
export class BeamCtx {
  g!: Graphics;
  look!: ModLook;
  color = 0xffffff;
  x0 = 0; y0 = 0; x1 = 0; y1 = 0; ux = 1; uy = 0; nx = 0; ny = 1; len = 0;
  /** The beam's width (the game's measure: beamLookFx drawBeamBody), its brightness 0..1, seconds, and whether its end is on something */
  wid = 4; gain = 1; t = 0; seed = 0; hit = false;

  /** The beam's own number i (0..1), steady */
  h(i: number): number { return fract(Math.sin((this.seed * 0.37 + i) * 127.1 + i * 311.7) * 43758.5453); }
  /** Number i at time step `hz` a second: steady within a step, new the next (a crackle, a pop) */
  hs(i: number, hz: number): number { return fract(Math.sin((Math.floor(this.t * hz) * 1.37 + this.seed * 0.37 + i) * 91.7 + i * 47.3) * 24634.6345); }

  line(x0: number, y0: number, x1: number, y1: number, w: number, color: number, alpha: number): void {
    if (alpha > 0.004) this.g.moveTo(x0, y0).lineTo(x1, y1).stroke({ color, width: w, alpha, cap: 'round' });
  }

  dot(x: number, y: number, r: number, color: number, alpha: number): void {
    if (alpha > 0.004 && r > 0) this.g.circle(x, y, r).fill({ color, alpha });
  }

  /** A point `d` along the beam and `off` to its left */
  px(d: number, off: number): number { return this.x0 + this.ux * d + this.nx * off; }
  py(d: number, off: number): number { return this.y0 + this.uy * d + this.ny * off; }

  /** A flame's tongue from (x, y) along `dir`, `len` long and `half` wide at its root */
  tongue(x: number, y: number, dir: number, len: number, half: number, color: number, alpha: number): void {
    if (alpha <= 0.004 || len <= 0.3) return;
    const c = Math.cos(dir), s = Math.sin(dir), tx = x + c * len, ty = y + s * len, mx = x + c * len * 0.45, my = y + s * len * 0.45;
    this.g.moveTo(x + s * half, y - c * half).quadraticCurveTo(mx + s * half * 0.9, my - c * half * 0.9, tx, ty)
      .quadraticCurveTo(mx - s * half * 0.9, my + c * half * 0.9, x - s * half, y + c * half).closePath().fill({ color, alpha });
  }

  /** A jagged bolt between two points, new every 1/hz s (index `i` tells bolts apart) */
  bolt(x0: number, y0: number, x1: number, y1: number, amp: number, segs: number, i: number, hz: number, color: number, alpha: number, w = 1.2): void {
    if (alpha <= 0.004) return;
    const dx = x1 - x0, dy = y1 - y0, l = Math.hypot(dx, dy) || 1, px = -dy / l, py = dx / l, g = this.g;
    for (let pass = 0; pass < 2; pass++) {
      g.moveTo(x0, y0);
      for (let j = 1; j <= segs; j++) {
        const t = j / segs, o = j === segs ? 0 : (this.hs(i * 17 + j, hz) - 0.5) * 2 * amp * Math.sin(t * Math.PI);
        g.lineTo(x0 + dx * t + px * o, y0 + dy * t + py * o);
      }
      g.stroke(pass === 0 ? { color, width: w * 2.6, alpha: 0.4 * alpha } : { color: 0xffffff, width: w * 0.8, alpha: 0.95 * alpha });
    }
  }
}

/** One effect's layers: each optional, each adding to the gun's own look at strength k (0..1, continuous) */
export interface ModLayer {
  /** As the shot leaves its barrel (c.x, c.y the muzzle, c.s the flash's size) */
  muzzle?(c: ModCtx, k: number): void;
  /** Each frame of the shell's flight (c.x, c.y its head, c.bx, c.by its tail, c.s its half-width) */
  flight?(c: ModCtx, k: number): void;
  /** Where it hits (c.out the throw, c.s the impact's size, c.R its blast radius) */
  impact?(c: ModCtx, k: number): void;
  /** Along a beam, each frame */
  beam?(b: BeamCtx, k: number): void;
  /** At a beam's far end, each frame (b.hit: on something) */
  beamEnd?(b: BeamCtx, k: number): void;
}
