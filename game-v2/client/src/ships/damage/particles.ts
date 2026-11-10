/**
 * @contract client.damage.particles
 * owns:       the damage effects' particle list and pools (sparks, glows, rings, smoke, chunks, beams, arcs) and their
 *             per-frame move, fade and draw, and the quality cap on them
 * needs:      ParticlePool, fxTextures, gfx (clearIfDrawn), impactAnchor (AnchorList); npm: pixi.js
 * invariants: the live list is capped by setQuality and the lower tiers drop a share of the small particles — client/src/ships/damage/particles.test.ts
 *             a chunk's hot edge is stroked once and parked for the next chunk when it cools — client/src/ships/damage/particles.test.ts
 * extend:     a new particle kind is one member of P.kind, one helper below and one case in draw
 */

import { clearIfDrawn } from '../../rendering/gfx';
import { Container, Graphics, GraphicsContext, Texture } from 'pixi.js';
import { ParticlePool } from '../../rendering/particlePool';
import { DOT_SIZE, glowBall, puff, streak, streakScale } from '../../rendering/fxTextures';
import { AnchorList, type ImpactAnchor } from '../../rendering/weapons/impactAnchor';

interface P {
  kind: 'spark' | 'glow' | 'smoke' | 'chunk' | 'ring' | 'arc' | 'dust' | 'beam';
  x: number; y: number; vx: number; vy: number;
  life: number; max: number;
  size: number; grow: number;
  color: number; alpha: number;
  drag: number;
  rot: number; vr: number;
  /** Arcs: jagged points, regenerated as they flicker; beams: [dx, dy] to the far end */
  pts?: number[];
  /** Arcs: a new jag every frame (a chain's lightning), not now and then */
  jit?: boolean;
  /** Chunks: the hot edge while it glows (its outline, stroked once for the chunk's size) */
  hot?: Graphics;
  /** A hit's spark, glow or chip riding the ship it struck (impactAnchor): its velocity is relative to that ship */
  anc?: ImpactAnchor;
}


const MAX_PARTICLES = 2500;
/** A debris chunk's outline, a unit across (scaled to each chunk's size) */
const CHUNK = [-1, -0.6, 0.8, -0.8, 1, 0.5, -0.5, 1];
/** A parked hot edge's (nothing) */
const EMPTY = new GraphicsContext();


export class DamageParticles {
  add = new Graphics();
  /** Redrawn every frame, so a render group of its own: Pixi rebuilds its draw list, not the whole glow layer's */
  private addGroup = new Container({ isRenderGroup: true });
  addSprites = new ParticlePool('add');
  /** Shield bubbles (rim, fill, hex, the regen flash): their own pool, a pool draws from at most four textures */
  shieldSprites = new ParticlePool('add');
  /** Shockwave and charge rings, charge glows */
  rings = new ParticlePool('add', 'rings');
  /** Chunks' hot edges: one per glowing chunk, kept for it (its outline stroked once), spares parked */
  private hotLayer = new Container({ isRenderGroup: true });
  private hotSpare: Graphics[] = [];
  private glowRoot = new Container();
  /** The additive layer: sparks, fire, flashes, shields (for the bloom) */
  get glowLayer(): Container { return this.glowRoot; }
  /** Debris chunks' bodies: one shape, filled once, each placed, turned, sized, tinted and faded (none redrawn a frame) */
  private chunkShape = new GraphicsContext().poly(CHUNK).fill(0xffffff);
  private chunkLayer = new Container();
  private chunkBodies: Graphics[] = [];
  /** Chunk bodies drawn last frame (those after are parked: no alpha, no size) */
  private chunksDrawn = 0;
  smokeSprites = new ParticlePool('normal');
  ps: P[] = [];
  /** Plating hits riding the ships they struck: one entity lookup each a frame */
  anchors = new AnchorList();
  /** Share of the sparks, smoke and dust made, and most particles alive (the quality setting) */
  private keep = 1;
  private cap = MAX_PARTICLES;

  /** The share of small particles kept (1 at full quality) */
  get keepShare(): number { return this.keep; }

  /** A flak fragment: a bright streak flying straight at `speed` for `life` frames; never dropped by the quality share (its count is the tier's) */
  fragment(x: number, y: number, vx: number, vy: number, life: number, size: number, color: number): void {
    if (this.ps.length < this.cap) this.ps.push({ kind: 'spark', x, y, vx, vy, life: 0, max: life, size, grow: 0, color, alpha: 1, drag: 1, rot: 0, vr: 0 });
  }

  setQuality(keep: number, cap: number): void {
    this.keep = keep;
    this.cap = Math.min(MAX_PARTICLES, cap);
  }

  constructor(layer: Container) {
    this.add.blendMode = 'add';
    this.addGroup.addChild(this.add);
    this.glowRoot.addChild(this.shieldSprites.container, this.addSprites.container, this.rings.container, this.hotLayer, this.addGroup);
    layer.addChild(this.smokeSprites.container, this.chunkLayer, this.glowRoot);
  }

  /** Opens the pools for this frame */
  begin(): void {
    this.addSprites.begin();
    this.shieldSprites.begin();
    this.smokeSprites.begin();
    this.rings.begin();
  }

  end(): void {
    this.addSprites.end();
    this.shieldSprites.end();
    this.smokeSprites.end();
    this.rings.end();
  }

  push(p: P): void {
    // (The lower quality tiers: fewer of the small ones, and fewer in all)
    if (this.keep < 1 && (p.kind === 'spark' || p.kind === 'smoke' || p.kind === 'dust') && Math.random() > this.keep) return;
    if (this.ps.length < this.cap) this.ps.push(p);
  }

  spark(x: number, y: number, vx: number, vy: number, life: number, color: number): void {
    this.push({ kind: 'spark', x, y, vx, vy, life: 0, max: life, size: 1.2, grow: 0, color, alpha: 1, drag: 0.93, rot: 0, vr: 0 });
  }

  burstSparks(x: number, y: number, vx: number, vy: number, n: number, smin: number, smax: number, color: number): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = smin + Math.random() * (smax - smin);
      this.spark(x, y, vx + Math.cos(a) * s, vy + Math.sin(a) * s, 14 + Math.random() * 26, Math.random() < 0.25 ? 0xffffff : color);
    }
  }

  glow(x: number, y: number, vx: number, vy: number, size: number, life: number, color: number, alpha: number, grow = 0): void {
    this.push({ kind: 'glow', x, y, vx, vy, life: 0, max: life, size, grow, color, alpha, drag: 0.96, rot: 0, vr: 0 });
  }

  ring(x: number, y: number, vx: number, vy: number, from: number, to: number, life: number, color: number, alpha: number): void {
    this.push({ kind: 'ring', x, y, vx, vy, life: 0, max: life, size: from, grow: (to - from) / life, color, alpha, drag: 1, rot: 0, vr: 0 });
  }

  dustPuff(x: number, y: number, vx: number, vy: number, size: number, life: number, color: number, alpha: number, grow = 0.08): void {
    this.push({ kind: 'smoke', x, y, vx, vy, life: 0, max: life, size, grow, color, alpha, drag: 0.985, rot: 0, vr: 0 });
  }

  /** Spinning fragments: dark metal with a hot edge that cools */
  chunks(x: number, y: number, vx: number, vy: number, n: number, speed: number, size: number, color = 0x5d6470): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = speed * (0.4 + Math.random());
      this.push({ kind: 'chunk', x, y, vx: vx + Math.cos(a) * s, vy: vy + Math.sin(a) * s, life: 0, max: 120 + Math.random() * 120,
        size: Math.max(2, size * (0.6 + Math.random() * 0.8)), grow: 0, color, alpha: 1, drag: 0.995, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.3 });
    }
  }

  /** A jagged electric arc reaching out from (x, y) */
  arc(x: number, y: number, vx: number, vy: number, angle: number, length: number, life: number): void {
    this.push({ kind: 'arc', x, y, vx, vy, life: 0, max: life, size: length, grow: 0, color: 0xbfeaff, alpha: 1, drag: 1, rot: angle, vr: 0, pts: this.jag(length, angle) });
  }

  /** A lightning polyline from where a chain leapt to where it lands, re-jittered every frame for 6 frames */
  zapArc(from: [number, number], x: number, y: number, color: number): void {
    const dx = x - from[0], dy = y - from[1], len = Math.hypot(dx, dy) || 1, angle = Math.atan2(dy, dx);
    this.push({ kind: 'arc', x: from[0], y: from[1], vx: 0, vy: 0, life: 0, max: 6, size: len, grow: 0, color, alpha: 1, drag: 1, rot: angle, vr: 0, pts: this.jag(len, angle), jit: true });
  }

  jag(length: number, angle: number): number[] {
    const pts = [0, 0];
    const steps = 6;
    for (let i = 1; i <= steps; i++) {
      const d = (i / steps) * length;
      const off = (Math.random() - 0.5) * length * 0.35;
      pts.push(Math.cos(angle) * d - Math.sin(angle) * off, Math.sin(angle) * d + Math.cos(angle) * off);
    }
    return pts;
  }

  draw(frames: number): void {
    const ga = this.add;
    clearIfDrawn(ga);
    let w = 0, chunks = 0;
    for (const p of this.ps) {
      p.life += frames;
      if (p.life >= p.max) {
        if (p.hot) this.coolEdge(p);
        continue;
      }
      const drag = Math.pow(p.drag, frames);
      p.vx *= drag; p.vy *= drag;
      p.x += p.vx * frames; p.y += p.vy * frames;
      // (riding the ship it struck: carried by how far the hit point moved)
      if (p.anc) { p.x += p.anc.dx; p.y += p.anc.dy; }
      p.size += p.grow * frames;
      p.rot += p.vr * frames;
      const k = p.life / p.max, fade = 1 - k;
      switch (p.kind) {
        case 'spark': {
          // A streak back along its motion
          const len = 2.2, w = p.size * 1.4;
          const sl = Math.hypot(p.vx, p.vy) * len;
          const sc = streakScale(sl, w);
          this.addSprites.take(streak(), p.x - p.vx * len * 0.5, p.y - p.vy * len * 0.5, 0.5, 0.5, p.color, p.alpha * fade, Math.atan2(p.vy, p.vx), sc.x, sc.y);
          break;
        }
        case 'glow': {
          const s = (p.size * (0.75 + 0.3 * k) * 2) / DOT_SIZE;
          this.addSprites.take(glowBall(), p.x, p.y, 0.5, 0.5, p.color, Math.min(1, p.alpha * fade * fade * 1.1), 0, s, s);
          break;
        }
        case 'ring':
          this.rings.ring(p.x, p.y, p.size, 2 + 6 * fade, p.color, p.alpha * fade);
          break;
        case 'smoke':
        case 'dust': {
          const s = (p.size * 2.3) / DOT_SIZE;
          this.smokeSprites.take(puff(), p.x, p.y, 0.5, 0.5, p.color, p.alpha * fade * Math.min(1, k * 6), p.rot, s, s);
          break;
        }
        case 'chunk': {
          const s = p.size, body = this.chunkBody(chunks++);
          body.position.set(p.x, p.y);
          body.rotation = p.rot;
          body.scale.set(s);
          if (body.tint !== p.color) body.tint = p.color;
          body.alpha = Math.min(1, fade * 2);
          // Glowing hot for the first moments
          if (k < 0.35) {
            const hot = p.hot ?? this.hotEdge(p);
            hot.position.set(p.x, p.y);
            hot.rotation = p.rot;
            hot.alpha = (1 - k / 0.35) * 0.9;
          } else if (p.hot) this.coolEdge(p);
          break;
        }
        case 'beam': {
          // A soft wide glow round a hot core, both thinning as it fades
          // (Two straight strokes with butt ends, as they were drawn: rectangles along the beam)
          const [bx, by] = p.pts!;
          const len = Math.hypot(bx, by), a = Math.atan2(by, bx), mx = p.x + bx / 2, my = p.y + by / 2;
          this.addSprites.take(Texture.WHITE, mx, my, 0.5, 0.5, p.color, 0.35 * fade, a, len, p.size * (0.4 + fade) * 1.6);
          this.addSprites.take(Texture.WHITE, mx, my, 0.5, 0.5, 0xffffff, fade, a, len, p.size * 0.35 * (0.3 + fade));
          break;
        }
        case 'arc': {
          if (p.pts && p.pts.length > 4 && (p.jit || Math.random() < 0.35)) p.pts = this.jag(p.size, p.rot);
          const pts = p.pts!;
          ga.moveTo(p.x + pts[0], p.y + pts[1]);
          for (let i = 2; i < pts.length; i += 2) ga.lineTo(p.x + pts[i], p.y + pts[i + 1]);
          ga.stroke({ color: p.color, width: 2.2, alpha: fade });
          break;
        }
      }
      this.ps[w++] = p;
    }
    this.ps.length = w;
    for (let i = chunks; i < this.chunksDrawn; i++) {
      this.chunkBodies[i].alpha = 0;
      this.chunkBodies[i].scale.set(0);
    }
    this.chunksDrawn = chunks;
  }

  /** A glowing chunk's hot edge: its outline, stroked 1.5 wide at its size (scaled with it, so the width is in world units) */
  private hotEdge(p: P): Graphics {
    const g = this.hotSpare.pop() ?? this.hotLayer.addChild(new Graphics());
    g.blendMode = 'add';
    g.context = new GraphicsContext().poly(CHUNK).stroke({ color: 0xff9a4a, width: 1.5 / p.size });
    g.scale.set(p.size);
    p.hot = g;
    return g;
  }

  /** The chunk has cooled (or gone): its edge parked for the next */
  private coolEdge(p: P): void {
    const g = p.hot!;
    p.hot = undefined;
    const ctx = g.context;
    g.context = EMPTY;
    ctx.destroy();
    g.alpha = 0;
    this.hotSpare.push(g);
  }

  /** The i-th chunk body this frame (made the first time there are that many) */
  private chunkBody(i: number): Graphics {
    let g = this.chunkBodies[i];
    if (!g) {
      g = new Graphics(this.chunkShape);
      this.chunkBodies.push(g);
      this.chunkLayer.addChild(g);
    }
    return g;
  }
}
