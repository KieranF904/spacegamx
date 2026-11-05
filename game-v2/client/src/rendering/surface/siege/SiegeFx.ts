/**
 * The siege's moving light on the bastion's ground, each frame: the beacon's
 * slow sweep at night, the core's glow (its colour by the bastion's hull,
 * throbbing red in the last stand), a ring at each front's landing point
 * drawing in as it comes (and a pillar of red light), shock rings (a turret
 * lost, a front landing, the bastion hit), mend progress rings, and smoke and
 * sparks from what's damaged. Sprites for the glows and particles (moving
 * them costs nothing); one small Graphics for the rings.
 */

import { CanvasSource, Container, Graphics, Sprite, Texture } from 'pixi.js';
import { glowBall, puff, softDot } from '../../fxTextures';

/** The sweep's beam: a soft wedge from its left middle, fading out along it (painted once) */
let beamTex: Texture | null = null;
function sweepBeam(): Texture {
  if (beamTex) return beamTex;
  const W = 512, H = 256, canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  // Wedges narrowing in, each fainter: soft edges
  for (let k = 0; k < 6; k++) {
    const half = 0.22 - k * 0.032;
    const g = ctx.createRadialGradient(0, H / 2, 0, 0, H / 2, W);
    g.addColorStop(0, 'rgba(255,255,255,0.22)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.12)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(0, H / 2);
    ctx.lineTo(W, H / 2 - Math.tan(half) * W);
    ctx.lineTo(W, H / 2 + Math.tan(half) * W);
    ctx.closePath();
    ctx.fill();
  }
  beamTex = new Texture({ source: new CanvasSource({ resource: canvas, width: W, height: H, resolution: 1, autoGenerateMipmaps: true }) });
  return beamTex;
}

interface Part { s: Sprite; x: number; y: number; vx: number; vy: number; life: number; max: number; size: number; grow: number; a: number }
interface Shock { x: number; y: number; t: number; max: number; r0: number; r1: number; color: number; width: number }

export interface FxState {
  /** The bastion's place, 0 day .. 1 night, its hull (%), the last stand, its core's colour */
  bx: number; by: number; night: number; hull: number; breach: boolean; core: number;
  /** Fronts showing their beacons: where, how far along (0..1), a boss among them */
  beacons: { x: number; y: number; phase: number; boss: boolean }[];
  /** Mends under way (0..1): each pad's, and the bastion's */
  mends: { x: number; y: number; k: number; r: number }[];
}

const MAX_PARTS = 90;

export class SiegeFx {
  /** Glows and smoke (on the ground, under the ships) */
  readonly under = new Container();
  readonly g = new Graphics();
  private sweep = new Sprite(sweepBeam());
  private core = new Sprite(glowBall());
  private pillars: Sprite[] = [];
  private parts: Part[] = [];
  private free: Sprite[] = [];
  private shocks: Shock[] = [];
  private t = 0;
  /** The sweep's bearing (radians), for the light that goes with it */
  angle = 0;

  constructor() {
    this.sweep.anchor.set(0, 0.5);
    this.sweep.blendMode = 'add';
    this.sweep.tint = 0xfff1d0;
    this.core.anchor.set(0.5);
    this.core.blendMode = 'add';
    this.under.addChild(this.core, this.sweep);
    this.under.addChild(this.g);
  }

  shock(x: number, y: number, r0: number, r1: number, color: number, max = 0.8, width = 18): void {
    this.shocks.push({ x, y, t: 0, max, r0, r1, color, width });
  }

  /** `n` sparks flung from (x, y) */
  sparks(x: number, y: number, n: number, color = 0xffc070, speed = 380): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, v = speed * (0.4 + Math.random() * 0.8);
      this.part(x, y, Math.cos(a) * v, Math.sin(a) * v, 0.35 + Math.random() * 0.4, 14 + Math.random() * 10, 0, color, 1, true);
    }
  }

  /** A puff of smoke drifting off (x, y) */
  smoke(x: number, y: number, size: number, dark = 0.55): void {
    const a = Math.random() * Math.PI * 2;
    this.part(x + Math.cos(a) * size * 0.3, y + Math.sin(a) * size * 0.3, 30 + Math.random() * 25, -20 - Math.random() * 20,
      1.6 + Math.random() * 1.2, size, size * 1.4, 0x1c1a1a, dark, false);
  }

  private part(x: number, y: number, vx: number, vy: number, max: number, size: number, grow: number, color: number, a: number, add: boolean): void {
    if (this.parts.length >= MAX_PARTS) return;
    const s = this.free.pop() ?? new Sprite();
    s.texture = add ? softDot() : puff();
    s.anchor.set(0.5);
    s.blendMode = add ? 'add' : 'normal';
    s.tint = color;
    s.visible = true;
    if (!s.parent) this.under.addChild(s);
    this.parts.push({ s, x, y, vx, vy, life: 0, max, size, grow, a });
  }

  update(dt: number, st: FxState): void {
    this.t += dt;
    const g = this.g, n = st.night;
    g.clear();
    // The beacon's sweep: a slow turn, only in the dark (faster in the last stand)
    this.angle = (this.angle + dt * (st.breach ? 0.9 : 0.42)) % (Math.PI * 2);
    this.sweep.visible = n > 0.05;
    this.sweep.position.set(st.bx, st.by);
    this.sweep.rotation = this.angle;
    this.sweep.scale.set(3600 / 512);
    this.sweep.alpha = 0.3 * n;
    this.sweep.tint = st.breach ? 0xff8a7a : 0xfff1d0;
    // The core: its glow by the hull, throbbing in the last stand
    const throb = st.breach ? 0.5 + 0.5 * Math.sin(this.t * 7) : 0.5 + 0.5 * Math.sin(this.t * 1.6);
    this.core.position.set(st.bx, st.by);
    this.core.tint = st.core;
    this.core.scale.set((300 + 40 * throb) / 32);
    this.core.alpha = (0.08 + 0.16 * n) * (0.75 + 0.25 * throb) * (st.breach ? 1.6 : 1);
    g.circle(st.bx, st.by, 200).stroke({ color: st.core, width: 10, alpha: 0.25 + 0.35 * n * (st.breach ? throb : 0.8) });
    // Fronts coming: a ring drawing in, dashes turning round where they'll land, a pillar of red light
    while (this.pillars.length < st.beacons.length) {
      const s = new Sprite(softDot(0.2, 0.25));
      s.anchor.set(0.5);
      s.blendMode = 'add';
      this.pillars.push(s);
      this.under.addChild(s);
    }
    this.pillars.forEach((s, i) => { s.visible = i < st.beacons.length; });
    st.beacons.forEach((b, i) => {
      const col = b.boss ? 0xff2d55 : 0xff4a3a, R = b.boss ? 560 : 420, pulse = 0.5 + 0.5 * Math.sin(this.t * (3 + b.phase * 5));
      const closing = R * 2.6 - (R * 2.6 - R * 0.35) * b.phase;
      g.circle(b.x, b.y, closing).stroke({ color: col, width: 16, alpha: 0.25 + 0.5 * b.phase });
      const spin = this.t * 0.6;
      for (let k = 0; k < 12; k++) {
        const a0 = spin + (k / 12) * Math.PI * 2;
        g.moveTo(b.x + Math.cos(a0) * R, b.y + Math.sin(a0) * R).arc(b.x, b.y, R, a0, a0 + 0.3).stroke({ color: col, width: 12, alpha: 0.5 + 0.3 * pulse });
      }
      g.circle(b.x, b.y, 60).fill({ color: col, alpha: 0.35 + 0.4 * pulse });
      const s = this.pillars[i];
      s.position.set(b.x, b.y);
      s.tint = col;
      s.scale.set((R * (0.8 + 0.3 * pulse)) / 32);
      s.alpha = 0.2 + 0.55 * b.phase;
    });
    // Mends under way
    for (const m of st.mends) {
      g.circle(m.x, m.y, m.r).stroke({ color: 0x7dd3fc, width: 8, alpha: 0.2 });
      g.moveTo(m.x, m.y - m.r).arc(m.x, m.y, m.r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * m.k).stroke({ color: 0x7dd3fc, width: 10, alpha: 0.9 });
    }
    // Shock rings
    this.shocks = this.shocks.filter((s) => (s.t += dt) < s.max);
    for (const s of this.shocks) {
      const k = s.t / s.max, e = 1 - (1 - k) * (1 - k);
      g.circle(s.x, s.y, s.r0 + (s.r1 - s.r0) * e).stroke({ color: s.color, width: s.width * (1 - k * 0.6), alpha: 0.85 * (1 - k) });
    }
    // Smoke and sparks
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const p = this.parts[i];
      p.life += dt;
      if (p.life >= p.max) {
        p.s.visible = false;
        this.free.push(p.s);
        this.parts[i] = this.parts[this.parts.length - 1];
        this.parts.pop();
        continue;
      }
      const k = p.life / p.max;
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.vx *= 1 - dt * 1.5; p.vy *= 1 - dt * 1.5;
      p.s.position.set(p.x, p.y);
      p.s.scale.set((p.size + p.grow * k) / 32);
      p.s.alpha = p.a * (p.grow ? Math.min(1, k * 5) * (1 - k) : 1 - k);
    }
  }

  dispose(): void {
    this.under.destroy({ children: true });
  }
}
