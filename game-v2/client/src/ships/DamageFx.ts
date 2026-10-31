/**
 * Damage, collision and repair effects for modular ships.
 *
 * Driven by the server's partDestroyed and contact messages, plus what the
 * client can see for itself (parts reappearing after a station repair,
 * debris crumbling, ships healing near a station). Each kind of part goes its
 * own way:
 *   core       a fireball, shockwave, flying chunks and lingering smoke
 *   generator  an electric burst with arcs crackling outwards
 *   thruster   a fiery burst
 *   weapon     its ammunition cooking off in a quick run of pops
 *   armor      heavy plates breaking off, little fire
 *   hull       fragments and sparks
 *   conduit    shorting sparks and a few arcs
 *   crumble    (a loose part decaying) a puff of dust and grit
 *
 * Particles live in world units and move per tick, like everything else.
 * The many small ones (sparks, glows, smoke) and the shield bubbles are pooled
 * sprites of painted textures; rings and beams are particles too (rings worked
 * out per pixel, see rendering/particlePool.ts), chunks are one shared shape
 * placed, and a hot chunk's edge is its outline stroked once. Only electric
 * arcs are drawn as lines a frame, which cost nothing while there are none.
 */

import { clearIfDrawn } from '../rendering/gfx';
import { Container, Graphics, GraphicsContext, Texture } from 'pixi.js';
import { ParticlePool } from '../rendering/particlePool';
import { BUBBLE_RIM, DOT_SIZE, bubble, glowBall, hexShield, puff, streak, streakScale } from '../rendering/fxTextures';
import { shieldLookOf } from './shieldLooks';
import { EntityType, isRuined, lookFn, ServerContactMessage, ServerPartDestroyedMessage } from '@space-game/common';
import type { GameState } from '../state/GameState';
import type { ShipSource } from './ShipStore';
import type { Lighting } from '../rendering/lighting/Lighting';

type Sound = (id: string, at?: { x: number; y: number }, volume?: number) => void;

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
}

interface Pending { at: number; run: () => void }

const MAX_PARTICLES = 2500;
/** A debris chunk's outline, a unit across (scaled to each chunk's size) */
const CHUNK = [-1, -0.6, 0.8, -0.8, 1, 0.5, -0.5, 1];
/** A parked hot edge's (nothing) */
const EMPTY = new GraphicsContext();

export class DamageFx {
  private add = new Graphics();
  /** Redrawn every frame, so a render group of its own: Pixi rebuilds its draw list, not the whole glow layer's */
  private addGroup = new Container({ isRenderGroup: true });
  private addSprites = new ParticlePool('add');
  /** Shockwave and charge rings, charge glows */
  private rings = new ParticlePool('add', 'rings');
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
  private smokeSprites = new ParticlePool('normal');
  /** Where shields were struck: a bright patch on the bubble's rim, facing the hit */
  /** Shield ripples: where the shot struck, about the ship's centre in its own frame (angle and distance), so it rides with it */
  private ripples: { id: number; a: number; d: number; life: number; model: number }[] = [];
  private ps: P[] = [];
  private pending: Pending[] = [];
  private time = 0;
  private lastCrumbleSound = 0;
  private emberClock = 0;
  /** Share of the sparks, smoke and dust made, and most particles alive (the quality setting) */
  private keep = 1;
  private cap = MAX_PARTICLES;
  setQuality(keep: number, cap: number): void {
    this.keep = keep;
    this.cap = Math.min(MAX_PARTICLES, cap);
  }

  /** Ships with a repair kit at work (glints like station repair) */
  readonly kitShips = new Set<number>();

  constructor(layer: Container, private source: ShipSource, private state: GameState, private sound: Sound, private repairRange: number) {
    this.add.blendMode = 'add';
    this.addGroup.addChild(this.add);
    this.glowRoot.addChild(this.addSprites.container, this.rings.container, this.hotLayer, this.addGroup);
    layer.addChild(this.smokeSprites.container, this.chunkLayer, this.glowRoot);
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

  onPartDestroyed(m: ServerPartDestroyedMessage): void {
    const { x, y, vx, vy } = m;
    if (m.how === 'crumble') return this.crumble(x, y, vx, vy, m.size);
    switch (lookFn(m.fn)) {
      case 'core': return this.coreBlast(x, y, vx, vy, m.size);
      case 'generator': return m.how === 'blast' ? this.electricBlast(x, y, vx, vy, m.size) : this.hullBreak(x, y, vx, vy, m.size);
      case 'thruster': case 'afterburner': case 'plasma_drive': return m.how === 'blast' ? this.fireBurst(x, y, vx, vy, m.size) : this.hullBreak(x, y, vx, vy, m.size);
      case 'weapon': return m.how === 'blast' ? this.cookOff(x, y, vx, vy, m.size) : this.hullBreak(x, y, vx, vy, m.size);
      case 'armor': return this.armorBreak(x, y, vx, vy, m.size);
      case 'conduit': return this.shortOut(x, y, vx, vy, m.size);
      default: return this.hullBreak(x, y, vx, vy, m.size);
    }
  }

  /** Hulls grinding together: sparks thrown along the surface, a flash, some grit */
  onContact(m: ServerContactMessage): void {
    const k = Math.min(1, m.speed / 6);
    const tx = -m.ny, ty = m.nx;
    const n = Math.round(10 + 26 * k);
    for (let i = 0; i < n; i++) {
      const side = Math.random() < 0.5 ? -1 : 1;
      const s = (2 + Math.random() * 6) * (0.5 + k);
      const spread = (Math.random() - 0.5) * 0.9;
      this.spark(m.x, m.y, (tx * side + m.nx * spread) * s, (ty * side + m.ny * spread) * s, 10 + Math.random() * 18, Math.random() < 0.3 ? 0xffffff : 0xffc46b);
    }
    this.glow(m.x, m.y, 0, 0, 10 + 22 * k, 5, 0xffe2b0, 0.8);
    for (let i = 0; i < 2 + 4 * k; i++) this.dustPuff(m.x, m.y, (Math.random() - 0.5) * 1.2, (Math.random() - 0.5) * 1.2, 8 + Math.random() * 10, 40, 0x9a948c, 0.35);
    this.sound('bump', { x: m.x, y: m.y }, 0.15 + 0.55 * k * k);
    if (this.near(m.x, m.y, 900)) this.state.triggerScreenShake(2 + 6 * k, 0.2);
  }

  /** A warhead went off: flak burst, missile explosion or EMP ring */
  /** Burning parts (incendiary hits): flames until `until` (seconds on this clock) */
  private burns: { body: number; part: number; until: number }[] = [];
  /** Bosses charging a nova: a gathering glow until it fires */
  private charges: { body: number; kind: string; start: number; until: number }[] = [];

  onIgnite(bodyId: number, part: number, ticks: number): void {
    const until = this.time + ticks / 60;
    const cur = this.burns.find((b) => b.body === bodyId && b.part === part);
    if (cur) cur.until = Math.max(cur.until, until);
    else this.burns.push({ body: bodyId, part, until });
    const p = this.partWorld(bodyId, part);
    if (p) {
      this.glow(p.x, p.y, p.vx, p.vy, 40, 14, 0xffb347, 0.9);
      this.burstSparks(p.x, p.y, p.vx, p.vy, 14, 2.5, 7, 0xff7a2a);
    }
  }

  onBossCharge(bodyId: number, kind: string, ticks: number): void {
    this.charges.push({ body: bodyId, kind, start: this.time, until: this.time + ticks / 60 });
    const e = this.state.entities.get(bodyId);
    if (e) this.sound('jump_charge', { x: e.renderX, y: e.renderY }, 0.8);
  }

  /** A boss dies: a chain of blasts across its hull, then one huge one */
  onBossDefeated(x: number, y: number): void {
    for (let i = 0; i < 9; i++) {
      this.later(i * 0.16, () => {
        const a = Math.random() * Math.PI * 2, d = 40 + Math.random() * 160;
        this.onDetonation('missile', x + Math.cos(a) * d, y + Math.sin(a) * d, 110 + Math.random() * 90);
      });
    }
    this.later(1.6, () => {
      this.glow(x, y, 0, 0, 520, 14, 0xffffff, 1);
      this.glow(x, y, 0, 0, 380, 40, 0xffb347, 0.9, 2);
      this.ring(x, y, 0, 0, 60, 1400, 40, 0xffe6c0, 0.8);
      this.ring(x, y, 0, 0, 30, 900, 30, 0xff8a2b, 0.7);
      this.burstSparks(x, y, 0, 0, 90, 6, 18, 0xffc46b);
      for (let i = 0; i < 16; i++) this.dustPuff(x, y, (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 3, 90 + Math.random() * 60, 160, 0x3a3634, 0.5, 0.6);
      this.sound('explosion_large', { x, y }, 1);
      if (this.near(x, y, 4000)) this.state.triggerScreenShake(18, 0.9);
    });
  }

  /** A jagged bolt of sparks from one point to another */
  private bolt(from: [number, number], x: number, y: number, c0: number, c1: number, size: number): void {
    const steps = 7, dx = x - from[0], dy = y - from[1], len = Math.hypot(dx, dy) || 1, nx = -dy / len, ny = dx / len;
    // (a long one, in more steps: it stays jagged)
    const n = Math.max(steps, Math.round(len / 160));
    let px = from[0], py = from[1];
    for (let i = 1; i <= n; i++) {
      const t = i / n, j = i < n ? (Math.random() - 0.5) * Math.min(len * 0.18, 260) : 0;
      const qx = from[0] + dx * t + nx * j, qy = from[1] + dy * t + ny * j;
      for (let k = 0; k <= 3; k++) {
        const u = k / 3;
        this.push({ kind: 'spark', x: px + (qx - px) * u, y: py + (qy - py) * u, vx: 0, vy: 0, life: 0, max: 10, size, grow: 0, color: k % 2 ? c1 : c0, alpha: 1, drag: 1, rot: 0, vr: 0 });
      }
      px = qx; py = qy;
    }
  }

  onDetonation(kind: string, x: number, y: number, radius: number, from?: [number, number]): void {
    if (kind === 'eruption') {
      // A boss's mortar shell coming down: a column of fire, a shock ring, slag thrown out
      this.glow(x, y, 0, 0, radius * 0.9, 14, 0xffe0b0, 1);
      this.glow(x, y, 0, 0, radius * 1.3, 26, 0xff5a12, 0.8);
      this.ring(x, y, 0, 0, radius * 0.2, radius * 1.2, 20, 0xff8a3a, 0.9);
      this.burstSparks(x, y, 0, 0, 34, 4, 14, 0xffb060);
      this.later(0.08, () => this.ring(x, y, 0, 0, radius * 0.1, radius * 0.8, 16, 0xffd08a, 0.7));
      this.sound('explosion_large', { x, y }, 0.75);
      if (this.near(x, y, 1600)) this.state.triggerScreenShake(7, 0.3);
      return;
    }
    if (kind === 'mob_burst' || kind === 'mob_fizzle') {
      // A drone bursting (on target, or shot down); burnt out, a pop and a puff
      const big = kind === 'mob_burst';
      this.glow(x, y, 0, 0, radius * (big ? 0.7 : 0.25), big ? 12 : 8, big ? 0xffe0b0 : 0xffb070, big ? 1 : 0.6);
      if (big) this.ring(x, y, 0, 0, radius * 0.15, radius, 14, 0xff7a2a, 0.85);
      this.burstSparks(x, y, 0, 0, big ? 18 : 6, big ? 3 : 1.5, big ? 9 : 4, 0xff9a40);
      this.sound(big ? 'explosion_small' : 'hit', { x, y }, big ? 0.6 : 0.3);
      return;
    }
    if (kind === 'sludge') {
      // Greyseam sludge landing: a green splash and spatter
      this.glow(x, y, 0, 0, radius * 0.8, 12, 0xd8ffc0, 0.9);
      this.ring(x, y, 0, 0, radius * 0.2, radius * 1.1, 18, 0x7aff6a, 0.8);
      this.burstSparks(x, y, 0, 0, 20, 3, 12, 0x9cff6a);
      this.sound('explosion_small', { x, y }, 0.5);
      return;
    }
    if (kind === 'scrap') {
      // Grinding: a spray of white-hot sparks and scrap, a dull flash
      this.glow(x, y, 0, 0, radius * 0.5, 8, 0xfff0c0, 0.6);
      this.burstSparks(x, y, 0, 0, 26, 5, 10, 0xffd080);
      this.sound('hit', { x, y }, 0.5);
      return;
    }
    if (kind === 'synapse') {
      // A boss's wires striking a mark: a white-hot bolt down from it, a burst of molten spatter where it lands
      if (from) this.bolt(from, x, y, 0xfff4d0, 0xffa030, 3);
      this.glow(x, y, 0, 0, radius * 0.9, 12, 0xffe8b0, 1);
      this.ring(x, y, 0, 0, radius * 0.15, radius * 1.1, 16, 0xff8a2a, 0.9);
      this.burstSparks(x, y, 0, 0, 22, 3, 10, 0xffb060);
      this.sound('explosion_small', { x, y }, 0.55);
      if (this.near(x, y, 900)) this.state.triggerScreenShake(4, 0.2);
      return;
    }
    if (kind === 'arc') {
      // A jagged bolt from where it leapt, and a crackle where it lands
      if (from) this.zapArc(from, x, y);
      this.glow(x, y, 0, 0, 50, 9, 0x9ad8ff, 0.9);
      this.burstSparks(x, y, 0, 0, 5, 2.5, 8, 0xbfe9ff);
      this.sound('hit', { x, y }, 0.5);
      return;
    }
    if (kind === 'singularity') {
      // Collapse: rings falling inwards, then a violent flash
      for (let i = 0; i < 4; i++) this.later(i * 0.05, () => this.ring(x, y, 0, 0, radius * 1.3, radius * 0.1, 14, 0xc084fc, 0.8));
      this.later(0.25, () => {
        this.glow(x, y, 0, 0, radius * 0.9, 12, 0xf5e8ff, 1);
        this.ring(x, y, 0, 0, radius * 0.1, radius * 1.3, 24, 0x9b5de5, 0.9);
        this.burstSparks(x, y, 0, 0, 40, 5, 14, 0xd8b4fe);
        this.sound('explosion_large', { x, y }, 0.8);
        if (this.near(x, y, 2000)) this.state.triggerScreenShake(10, 0.4);
      });
      return;
    }
    if (kind === 'prism' || kind === 'prism_shard') {
      const big = kind === 'prism';
      this.glow(x, y, 0, 0, big ? 60 : 24, 8, 0xe0fbff, 0.9);
      for (let i = 0; i < (big ? 18 : 6); i++) {
        const a = Math.random() * Math.PI * 2, s = 2 + Math.random() * 5;
        this.push({ kind: 'spark', x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0, max: 14 + Math.random() * 12, size: 1.6, grow: 0, color: i % 3 === 0 ? 0xf0abfc : i % 3 === 1 ? 0x67e8f9 : 0xffffff, alpha: 1, drag: 0.92, rot: 0, vr: 0 });
      }
      if (big) this.sound('hit', { x, y }, 0.8);
      return;
    }
    if (kind === 'magma') {
      // A ball of magma bursting: a hot flash, a ring of spatter, and molten gobbets thrown out
      this.glow(x, y, 0, 0, 150, 18, 0xffb347, 0.9);
      this.ring(x, y, 0, 0, 20, 240, 20, 0xff6a1a, 0.8);
      this.burstSparks(x, y, 0, 0, 34, 4, 22, 0xff5a14);
      this.sound('magma_burst', { x, y }, 0.9);
      return;
    }
    if (kind === 'cinder_bloom') {
      this.glow(x, y, 0, 0, 70, 12, 0xffb347, 0.95);
      this.burstSparks(x, y, 0, 0, 22, 3.2, 12, 0xff6a1a);
      return;
    }
    if (kind === 'phase') {
      // A violet ripple spreading over the hull it passed through, a second one following
      this.ring(x, y, 0, 0, 10, 90, 14, 0xa78bfa, 0.9);
      this.later(0.07, () => this.ring(x, y, 0, 0, 6, 130, 22, 0xc4b5fd, 0.6));
      this.glow(x, y, 0, 0, 50, 10, 0xede9fe, 0.8);
      return;
    }
    if (kind === 'railgun') {
      // A slug passing through a hull (a Spear's, at full damage): a shock ring where it went through, a cyan-white flash
      this.glow(x, y, 0, 0, 40, 8, 0xdbeafe, 0.9);
      this.ring(x, y, 0, 0, 8, 70, 16, 0x9fe8ff, 0.8);
      this.burstSparks(x, y, 0, 0, 14, 4, 10, 0xbfe3ff);
      return;
    }
    if (kind === 'hive') radius *= 0.7;
    if (kind === 'emp') {
      // A wide one (the Blackout's) first throws a dark-blue dome out to its blast radius
      if (radius >= 260) {
        this.glow(x, y, 0, 0, radius * 0.95, 30, 0x1d3ea8, 0.55, 0.3);
        this.ring(x, y, 0, 0, radius * 0.9, radius, 26, 0x3b6cf0, 0.7);
      }
      this.glow(x, y, 0, 0, radius * 0.5, 10, 0xd9f6ff, 0.9);
      this.ring(x, y, 0, 0, radius * 0.15, radius * 1.1, 22, 0x6ad1ff, 0.8);
      this.ring(x, y, 0, 0, radius * 0.1, radius * 0.8, 16, 0xffffff, 0.5);
      for (let i = 0; i < 9; i++) this.arc(x, y, 0, 0, Math.random() * Math.PI * 2, radius * (0.6 + Math.random() * 0.5), 14 + Math.random() * 10);
      this.sound('generator_blast', { x, y }, 0.7);
      return;
    }
    if (kind === 'flak') {
      // A burst: an orange flash, shrapnel streaks and a cloud that lingers (the Burst's 1.2 s dark grey; the Cloudmaker's
      // bigger one, brown-grey round a gold core, 2.5 s: a wall that stays)
      const wall = radius >= 220;
      this.glow(x, y, 0, 0, radius * 0.45, 8, wall ? 0xffd070 : 0xffa050, 0.9);
      this.burstSparks(x, y, 0, 0, wall ? 20 : 26, 3, 9, 0xffb050);
      if (wall) this.glow(x, y, 0, 0, radius * 0.5, 60, 0xd9a040, 0.35, radius * 0.002);
      const stay = wall ? 150 : 72;
      for (let i = 0; i < 6; i++) this.dustPuff(x, y, (Math.random() - 0.5) * 1.4, (Math.random() - 0.5) * 1.4, radius * (0.2 + Math.random() * 0.15), stay * (0.85 + Math.random() * 0.3), wall ? 0x5a4a3c : 0x3a3836, 0.55, radius * 0.004);
      this.sound('explosion_small', { x, y }, 0.55);
      return;
    }
    // Missile: a proper fireball
    this.glow(x, y, 0, 0, radius * 0.9, 8, 0xffffff, 1);
    for (let i = 0; i < 6; i++) {
      const a = Math.random() * Math.PI * 2, d = Math.random() * radius * 0.35;
      this.glow(x + Math.cos(a) * d, y + Math.sin(a) * d, Math.cos(a) * 0.5, Math.sin(a) * 0.5, radius * (0.3 + Math.random() * 0.3), 24 + Math.random() * 20, i % 2 ? 0xff8a2b : 0xffd27a, 0.75, radius * 0.008);
    }
    this.ring(x, y, 0, 0, radius * 0.2, radius * 1.4, 18, 0xffe6c0, 0.6);
    this.burstSparks(x, y, 0, 0, 30, 3, 10, 0xffc46b);
    for (let i = 0; i < 6; i++) this.dustPuff(x, y, (Math.random() - 0.5), (Math.random() - 0.5), radius * 0.35, 90, 0x3a3634, 0.5, radius * 0.006);
    this.sound('explosion_small', { x, y }, 0.85);
    if (this.near(x, y, 1500)) this.state.triggerScreenShake(6, 0.3);
  }

  /**
   * A station's defence turret fired on a hostile, from `from`: a laser's red
   * bolt, flak's tracers bursting on the target, or the lance's heavy beam.
   */
  /**
   * Point defence fired (common/src/ships/features/support/support.ts): a hot tracer from its muzzle to the shot, a flash where it
   * struck, and brought down, the shot pops (a puff and a ring, small: its warhead never went off)
   */
  onIntercept(m: { x: number; y: number; fx: number; fy: number; down: boolean }): void {
    const dx = m.x - m.fx, dy = m.y - m.fy;
    this.push({ kind: 'beam', x: m.fx, y: m.fy, vx: 0, vy: 0, life: 0, max: 8, size: 3, grow: 0, color: 0xff8a1a, alpha: 1, drag: 1, rot: 0, vr: 0, pts: [dx, dy] });
    this.glow(m.fx, m.fy, 0, 0, 16, 5, 0xffb060, 0.9);
    this.glow(m.x, m.y, 0, 0, 22, 6, 0xfff1d0, 1);
    if (m.down) {
      this.glow(m.x, m.y, 0, 0, 46, 12, 0xffb24a, 0.9, 0.8);
      this.ring(m.x, m.y, 0, 0, 8, 60, 12, 0xffd08a, 0.8);
      this.burstSparks(m.x, m.y, 0, 0, 10, 1.5, 6, 0xffa040);
      for (let i = 0; i < 2; i++) this.dustPuff(m.x, m.y, (Math.random() - 0.5) * 0.8, (Math.random() - 0.5) * 0.8, 18 + Math.random() * 10, 40, 0x3a3634, 0.45, 0.3);
      this.sound('explosion_small', { x: m.x, y: m.y }, 0.35);
    } else this.burstSparks(m.x, m.y, 0, 0, 4, 1, 4, 0xffd080);
    this.sound('turret_shot', { x: m.fx, y: m.fy }, 0.35);
  }

  onStationFire(from: { x: number; y: number; weapon: string; color: number }, target: number): void {
    const t = this.state.entities.get(target);
    if (!t) return;
    const { x, y, color } = from;
    const dx = t.renderX - x, dy = t.renderY - y, d = Math.hypot(dx, dy) || 1;
    if (from.weapon === 'flak') {
      // Tracers, then a burst of black smoke and shrapnel on the target as they arrive
      const speed = 70, frames = Math.max(4, d / speed);
      for (let i = 0; i < 2; i++) {
        const j = (Math.random() - 0.5) * 0.05;
        const c = Math.cos(j), s = Math.sin(j);
        this.push({ kind: 'spark', x, y, vx: ((dx * c - dy * s) / d) * speed, vy: ((dx * s + dy * c) / d) * speed, life: 0, max: frames, size: 1.8, grow: 0, color, alpha: 1, drag: 1, rot: 0, vr: 0 });
      }
      this.glow(x, y, 0, 0, 22, 5, 0xffe0b0, 0.9);
      this.later(frames / 60, () => {
        const bx = t.renderX + (Math.random() - 0.5) * 80, by = t.renderY + (Math.random() - 0.5) * 80;
        this.glow(bx, by, t.vx, t.vy, 48, 8, 0xffd9a0, 0.95);
        this.glow(bx, by, t.vx, t.vy, 26, 20, 0xff8a2b, 0.6, 0.6);
        this.burstSparks(bx, by, t.vx, t.vy, 12, 2, 8, 0xffb050);
        for (let i = 0; i < 2; i++) this.dustPuff(bx, by, t.vx * 0.5 + (Math.random() - 0.5), t.vy * 0.5 + (Math.random() - 0.5), 26 + Math.random() * 16, 60, 0x2e2a28, 0.55, 0.3);
      });
      this.sound('flak_shot', { x, y }, 0.45);
      return;
    }
    if (from.weapon === 'lance') {
      // A thick violet beam that thins as it fades, a flare at both ends
      this.push({ kind: 'beam', x, y, vx: 0, vy: 0, life: 0, max: 18, size: 11, grow: 0, color, alpha: 1, drag: 1, rot: 0, vr: 0, pts: [dx, dy] });
      this.glow(x, y, 0, 0, 40, 10, 0xe4dcff, 1);
      this.glow(t.renderX, t.renderY, t.vx, t.vy, 60, 14, color, 0.95);
      this.ring(t.renderX, t.renderY, t.vx, t.vy, 10, 90, 16, 0xd6ccff, 0.6);
      this.burstSparks(t.renderX, t.renderY, t.vx, t.vy, 14, 3, 9, 0xd6ccff);
      this.sound('railgun_shot', { x, y }, 0.6);
      return;
    }
    // (Lasers are pulses: MiningBeamFx.stationPulse)
  }

  /** A part came back (station repair): sparkles drawing in, then a soft flash */
  onPartRestored(bodyId: number, part: number): void {
    const p = this.partWorld(bodyId, part);
    if (!p) return;
    for (let i = 0; i < 18; i++) {
      const a = Math.random() * Math.PI * 2, r = 30 + Math.random() * 30;
      const life = 24 + Math.random() * 10;
      this.ps.push({ kind: 'spark', x: p.x + Math.cos(a) * r, y: p.y + Math.sin(a) * r, vx: -Math.cos(a) * r / life + p.vx, vy: -Math.sin(a) * r / life + p.vy,
        life: 0, max: life, size: 1.4, grow: 0, color: 0x8ff6ff, alpha: 0.9, drag: 1, rot: 0, vr: 0 });
    }
    this.later(0.4, () => {
      this.glow(p.x, p.y, p.vx, p.vy, 26, 14, 0x9ffcff, 0.7);
      this.ring(p.x, p.y, p.vx, p.vy, 8, 36, 16, 0x9ffcff, 0.6);
    });
    this.sound('repair_part', { x: p.x, y: p.y }, 0.8);
  }

  // ---------------------------------------------------------------------------
  // Per-part effects
  // ---------------------------------------------------------------------------

  private coreBlast(x: number, y: number, vx: number, vy: number, r: number): void {
    // White flash, then a fireball that swells, reddens and fades into smoke
    this.glow(x, y, vx, vy, r * 1.6, 8, 0xffffff, 1);
    for (let i = 0; i < 9; i++) {
      const a = Math.random() * Math.PI * 2, d = Math.random() * r * 0.5;
      this.glow(x + Math.cos(a) * d, y + Math.sin(a) * d, vx + Math.cos(a) * 0.6, vy + Math.sin(a) * 0.6, r * (0.5 + Math.random() * 0.6), 30 + Math.random() * 25, i % 3 ? 0xff8a2b : 0xffd27a, 0.75, r * 0.02);
    }
    this.ring(x, y, vx, vy, r * 0.3, r * 3.2, 26, 0xffe6c0, 0.7);
    this.ring(x, y, vx, vy, r * 0.2, r * 2, 18, 0xffffff, 0.5);
    this.burstSparks(x, y, vx, vy, 60, 4, 12, 0xffc46b);
    this.chunks(x, y, vx, vy, 14, 2.5, r * 0.18);
    for (let i = 0; i < 16; i++) {
      const a = Math.random() * Math.PI * 2, s = Math.random() * 1.6;
      this.dustPuff(x, y, vx + Math.cos(a) * s, vy + Math.sin(a) * s, r * (0.4 + Math.random() * 0.5), 120 + Math.random() * 90, 0x3a3634, 0.55, r * 0.012);
    }
    this.sound('explosion_large', { x, y });
    if (this.near(x, y, 2500)) this.state.triggerScreenShake(14, 0.6);
  }

  private electricBlast(x: number, y: number, vx: number, vy: number, r: number): void {
    this.glow(x, y, vx, vy, r * 1.4, 10, 0xd9f6ff, 1);
    this.glow(x, y, vx, vy, r * 0.9, 26, 0x4fb8ff, 0.7, r * 0.02);
    this.ring(x, y, vx, vy, r * 0.2, r * 2.2, 18, 0x9fe0ff, 0.7);
    for (let i = 0; i < 7; i++) this.arc(x, y, vx, vy, Math.random() * Math.PI * 2, r * (0.9 + Math.random() * 0.8), 14 + Math.random() * 10);
    this.burstSparks(x, y, vx, vy, 34, 3, 9, 0x9fe0ff);
    this.chunks(x, y, vx, vy, 5, 1.8, r * 0.14);
    for (let i = 0; i < 6; i++) this.dustPuff(x, y, vx + (Math.random() - 0.5), vy + (Math.random() - 0.5), r * 0.4, 90, 0x403f48, 0.4, r * 0.01);
    this.sound('generator_blast', { x, y });
    if (this.near(x, y, 1500)) this.state.triggerScreenShake(7, 0.35);
  }

  private fireBurst(x: number, y: number, vx: number, vy: number, r: number): void {
    // Fire with a direction to it: the fuel jets out one way
    const dir = Math.random() * Math.PI * 2;
    this.glow(x, y, vx, vy, r * 1.2, 8, 0xfff0c8, 1);
    for (let i = 0; i < 26; i++) {
      const a = dir + (Math.random() - 0.5) * 0.9, s = 1.5 + Math.random() * 4;
      this.glow(x, y, vx + Math.cos(a) * s, vy + Math.sin(a) * s, r * (0.18 + Math.random() * 0.22), 18 + Math.random() * 16, Math.random() < 0.4 ? 0xffd27a : 0xff7a2b, 0.7, r * 0.015);
    }
    this.burstSparks(x, y, vx, vy, 24, 3, 9, 0xffb050);
    this.chunks(x, y, vx, vy, 4, 2, r * 0.15);
    for (let i = 0; i < 8; i++) this.dustPuff(x, y, vx + Math.cos(dir) * Math.random() * 2, vy + Math.sin(dir) * Math.random() * 2, r * 0.45, 100, 0x3d3833, 0.45, r * 0.012);
    this.sound('thruster_blast', { x, y });
    if (this.near(x, y, 1200)) this.state.triggerScreenShake(5, 0.3);
  }

  private cookOff(x: number, y: number, vx: number, vy: number, r: number): void {
    // The magazine goes off round by round
    const pops = 4 + Math.floor(Math.random() * 3);
    for (let i = 0; i < pops; i++) {
      this.later(i * (0.07 + Math.random() * 0.08), () => {
        const a = Math.random() * Math.PI * 2, d = Math.random() * r * 0.5;
        const px = x + vx * 6 * i + Math.cos(a) * d, py = y + vy * 6 * i + Math.sin(a) * d;
        this.glow(px, py, vx, vy, r * (0.4 + Math.random() * 0.4), 7, 0xffe6a8, 0.95);
        this.burstSparks(px, py, vx, vy, 10, 3, 7, 0xffd28a);
      });
    }
    this.chunks(x, y, vx, vy, 3, 1.6, r * 0.18);
    this.sound('weapon_cookoff', { x, y });
  }

  private armorBreak(x: number, y: number, vx: number, vy: number, size: number): void {
    // Heavy plates crack off: big slow chunks, a few sparks, no fire
    this.glow(x, y, vx, vy, size * 0.7, 6, 0xfff2dc, 0.6);
    this.chunks(x, y, vx, vy, 6, 1.1, size * 0.32, 0x7a7f88);
    this.burstSparks(x, y, vx, vy, 12, 2, 6, 0xffd9a0);
    for (let i = 0; i < 4; i++) this.dustPuff(x, y, vx + (Math.random() - 0.5) * 0.8, vy + (Math.random() - 0.5) * 0.8, size * 0.5, 70, 0x8a857e, 0.35);
    this.sound('armor_break', { x, y });
  }

  private hullBreak(x: number, y: number, vx: number, vy: number, size: number): void {
    this.glow(x, y, vx, vy, size * 0.9, 7, 0xffe2b0, 0.75);
    this.chunks(x, y, vx, vy, 5, 1.8, size * 0.2);
    this.burstSparks(x, y, vx, vy, 18, 2.5, 8, 0xffc46b);
    for (let i = 0; i < 3; i++) this.dustPuff(x, y, vx + (Math.random() - 0.5), vy + (Math.random() - 0.5), size * 0.45, 60, 0x6e6a66, 0.35);
    this.sound('part_break', { x, y });
  }

  private shortOut(x: number, y: number, vx: number, vy: number, size: number): void {
    this.glow(x, y, vx, vy, size * 0.8, 8, 0xcff2ff, 0.8);
    for (let i = 0; i < 4; i++) this.arc(x, y, vx, vy, Math.random() * Math.PI * 2, size * (1 + Math.random()), 10 + Math.random() * 8);
    this.burstSparks(x, y, vx, vy, 16, 2.5, 7, 0xbfe8ff);
    this.chunks(x, y, vx, vy, 2, 1.5, size * 0.15);
    this.sound('conduit_spark', { x, y });
  }

  private crumble(x: number, y: number, vx: number, vy: number, size: number): void {
    for (let i = 0; i < 4; i++) this.dustPuff(x, y, vx + (Math.random() - 0.5) * 0.5, vy + (Math.random() - 0.5) * 0.5, size * 0.4, 80 + Math.random() * 40, 0x7d7873, 0.3, size * 0.006);
    this.chunks(x, y, vx, vy, 3, 0.5, size * 0.16);
    for (let i = 0; i < 4; i++) this.spark(x, y, vx + (Math.random() - 0.5) * 1.2, vy + (Math.random() - 0.5) * 1.2, 30 + Math.random() * 30, 0xff9a4a);
    if (this.time - this.lastCrumbleSound > 0.25) {
      this.lastCrumbleSound = this.time;
      this.sound('disintegrate', { x, y }, 0.45);
    }
  }

  // ---------------------------------------------------------------------------
  // Particle helpers
  // ---------------------------------------------------------------------------

  private push(p: P): void {
    // (The lower quality tiers: fewer of the small ones, and fewer in all)
    if (this.keep < 1 && (p.kind === 'spark' || p.kind === 'smoke' || p.kind === 'dust') && Math.random() > this.keep) return;
    if (this.ps.length < this.cap) this.ps.push(p);
  }

  private spark(x: number, y: number, vx: number, vy: number, life: number, color: number): void {
    this.push({ kind: 'spark', x, y, vx, vy, life: 0, max: life, size: 1.2, grow: 0, color, alpha: 1, drag: 0.93, rot: 0, vr: 0 });
  }

  private burstSparks(x: number, y: number, vx: number, vy: number, n: number, smin: number, smax: number, color: number): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = smin + Math.random() * (smax - smin);
      this.spark(x, y, vx + Math.cos(a) * s, vy + Math.sin(a) * s, 14 + Math.random() * 26, Math.random() < 0.25 ? 0xffffff : color);
    }
  }

  private glow(x: number, y: number, vx: number, vy: number, size: number, life: number, color: number, alpha: number, grow = 0): void {
    this.push({ kind: 'glow', x, y, vx, vy, life: 0, max: life, size, grow, color, alpha, drag: 0.96, rot: 0, vr: 0 });
  }

  private ring(x: number, y: number, vx: number, vy: number, from: number, to: number, life: number, color: number, alpha: number): void {
    this.push({ kind: 'ring', x, y, vx, vy, life: 0, max: life, size: from, grow: (to - from) / life, color, alpha, drag: 1, rot: 0, vr: 0 });
  }

  private dustPuff(x: number, y: number, vx: number, vy: number, size: number, life: number, color: number, alpha: number, grow = 0.08): void {
    this.push({ kind: 'smoke', x, y, vx, vy, life: 0, max: life, size, grow, color, alpha, drag: 0.985, rot: 0, vr: 0 });
  }

  /** Spinning fragments: dark metal with a hot edge that cools */
  private chunks(x: number, y: number, vx: number, vy: number, n: number, speed: number, size: number, color = 0x5d6470): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = speed * (0.4 + Math.random());
      this.push({ kind: 'chunk', x, y, vx: vx + Math.cos(a) * s, vy: vy + Math.sin(a) * s, life: 0, max: 120 + Math.random() * 120,
        size: Math.max(2, size * (0.6 + Math.random() * 0.8)), grow: 0, color, alpha: 1, drag: 0.995, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.3 });
    }
  }

  /** A jagged electric arc reaching out from (x, y) */
  private arc(x: number, y: number, vx: number, vy: number, angle: number, length: number, life: number): void {
    this.push({ kind: 'arc', x, y, vx, vy, life: 0, max: life, size: length, grow: 0, color: 0xbfeaff, alpha: 1, drag: 1, rot: angle, vr: 0, pts: this.jag(length, angle) });
  }

  /** A lightning polyline from where a chain leapt to where it lands, re-jittered every frame for 6 frames */
  private zapArc(from: [number, number], x: number, y: number): void {
    const dx = x - from[0], dy = y - from[1], len = Math.hypot(dx, dy) || 1, angle = Math.atan2(dy, dx);
    this.push({ kind: 'arc', x: from[0], y: from[1], vx: 0, vy: 0, life: 0, max: 6, size: len, grow: 0, color: 0xc7dcff, alpha: 1, drag: 1, rot: angle, vr: 0, pts: this.jag(len, angle), jit: true });
  }

  private jag(length: number, angle: number): number[] {
    const pts = [0, 0];
    const steps = 6;
    for (let i = 1; i <= steps; i++) {
      const d = (i / steps) * length;
      const off = (Math.random() - 0.5) * length * 0.35;
      pts.push(Math.cos(angle) * d - Math.sin(angle) * off, Math.sin(angle) * d + Math.cos(angle) * off);
    }
    return pts;
  }

  private later(seconds: number, run: () => void): void {
    this.pending.push({ at: this.time + seconds, run });
  }

  private near(x: number, y: number, r: number): boolean {
    const me = this.state.entities.get(this.state.playerId);
    return !!me && Math.hypot(me.renderX - x, me.renderY - y) < r;
  }

  /** World position and velocity of a part as drawn now */
  private partWorld(bodyId: number, part: number): { x: number; y: number; vx: number; vy: number } | null {
    const ship = this.source.get(bodyId);
    const e = this.state.entities.get(bodyId);
    if (!ship || !e) return null;
    const c = this.source.geometry(ship)[part]?.centroid;
    if (!c) return null;
    const cs = this.source.tuning.cellSize;
    const lx = (c[0] - ship.derived.com[0]) * cs, ly = (c[1] - ship.derived.com[1]) * cs;
    const a = e.renderAngle + Math.PI / 2, ca = Math.cos(a), sa = Math.sin(a);
    return { x: e.renderX + lx * ca - ly * sa, y: e.renderY + lx * sa + ly * ca, vx: e.vx, vy: e.vy };
  }

  // ---------------------------------------------------------------------------
  // Frame
  // ---------------------------------------------------------------------------

  private lastShield = new Map<number, number>();
  private shieldFlash = new Map<number, number>();
  /** A Flash Screen's re-form bloom, 1 fading to 0 */
  private reform = new Map<number, number>();

  /** Shield bubbles (brighter when hit) and EMP crackle over knocked-out ships */
  private drawShields(frames: number): void {
    for (const [id, ship] of this.source.bodies) {
      const e = this.state.entities.get(id);
      if (!e || ship.kind !== 'ship') continue;
      const isPlayer = e.type === EntityType.Player;
      const shieldPct = (isPlayer ? e.data?.[4] : e.data?.[1]) ?? 0;
      // (Your own row carries the ticks left, everyone else's a flag)
      const emp = ((isPlayer ? e.data?.[5] : e.data?.[2]) ?? 0) > 0;
      const r = ship.derived.radius * 1.12 + 10;
      const prev = this.lastShield.get(id) ?? shieldPct;
      const look = shieldLookOf(ship);
      if (shieldPct < prev - 0.5) {
        if ((this.shieldFlash.get(id) ?? 0) < 0.4) this.sound('shield_hit', { x: e.renderX, y: e.renderY }, 0.6);
        this.shieldFlash.set(id, 1);
      }
      // A Flash Screen coming back: a white bloom swelling out of the bubble (the server's ShieldFlash effect adds the ring)
      if (look.reform && prev <= 0.5 && shieldPct > 0.5) this.reform.set(id, 1);
      this.lastShield.set(id, shieldPct);
      const flash = Math.max(0, (this.shieldFlash.get(id) ?? 0) - frames * 0.06);
      this.shieldFlash.set(id, flash);
      const rf = Math.max(0, (this.reform.get(id) ?? 0) - frames * 0.035);
      this.reform.set(id, rf);
      if (shieldPct > 0 || flash > 0) {
        const k = shieldPct / 100;
        const wob = 1 + 0.015 * Math.sin(this.time * 3 + id);
        const grow = 1 + 0.04 * flash + 0.12 * rf * rf;
        const b = (r * wob * grow) / (64 * BUBBLE_RIM);
        // (Flicker: the thin screen shimmers; the rest breathe slowly)
        const sh = look.shimmer ? 1 - look.shimmer * (0.5 + 0.5 * Math.sin(this.time * 47 + id) * Math.sin(this.time * 29 + id * 2)) : 1;
        const a = (look.base + look.fill * k + 0.7 * flash) * sh + 0.8 * rf;
        this.addSprites.take(bubble(), e.renderX, e.renderY, 0.5, 0.5, flash > 0.3 ? look.hit : rf > 0.3 ? 0xffffff : look.tint, a, 0, b, b);
        if (look.inner) this.addSprites.take(bubble(), e.renderX, e.renderY, 0.5, 0.5, look.inner, a * 0.8, 0, b * 0.9, b * 0.9);
        if (look.hex) this.addSprites.take(hexShield(), e.renderX, e.renderY, 0.5, 0.5, look.hex, (0.18 + 0.3 * k + 0.5 * flash) * sh, this.time * 0.05 + id, b, b);
        if (rf > 0) this.addSprites.take(glowBall(), e.renderX, e.renderY, 0.5, 0.5, 0xffffff, 0.7 * rf, 0, (r * (1.1 + 0.5 * (1 - rf))) / DOT_SIZE, (r * (1.1 + 0.5 * (1 - rf))) / DOT_SIZE);
      }
      if (emp && Math.random() < 0.5 * frames) {
        // (Sparks on a live part, not a random spot in the hull's disc)
        const parts = ship.derived.alive;
        let pi = (Math.random() * parts.length) | 0;
        for (let k = 0; k < parts.length && !parts[pi]; k++) pi = (pi + 1) % parts.length;
        const c = parts[pi] ? this.source.geometry(ship)[pi]?.centroid : undefined;
        let px = e.renderX, py = e.renderY;
        if (c) {
          const cs = this.source.tuning.cellSize, ang = e.renderAngle + Math.PI / 2, ca = Math.cos(ang), sa = Math.sin(ang);
          const lx = (c[0] - ship.derived.com[0]) * cs, ly = (c[1] - ship.derived.com[1]) * cs;
          px += lx * ca - ly * sa; py += lx * sa + ly * ca;
        }
        this.arc(px, py, e.vx, e.vy, Math.random() * Math.PI * 2, Math.min(r * 0.5, 30), 6);
      }
    }
  }

  /** Fireballs and flashes light what's near them (see rendering/lighting) */
  collectLights(L: Lighting): void {
    for (const p of this.ps) {
      if (p.kind !== 'glow' || p.size < 6) continue;
      const fade = 1 - p.life / p.max;
      L.point(p.x, p.y, p.color, 40 + p.size * 3.5, Math.min(2, p.alpha * fade * fade * 1.3));
    }
  }

  /** A shot struck at (x, y): if that's on a shielded ship, its bubble lights up there */
  shieldHit(x: number, y: number, model?: string): void {
    const m = model === 'pulse_strobe' ? 1 : model === 'pulse_overpulse' ? 2 : 0;
    this.platingHit(x, y);
    for (const [id, pct] of this.lastShield) {
      if (pct <= 0) continue;
      const e = this.state.entities.get(id), ship = this.source.get(id);
      if (!e || !ship) continue;
      const r = ship.derived.radius * 1.12 + 10;
      if (Math.hypot(x - e.renderX, y - e.renderY) > r * 1.25) continue;
      // (At the hull where the server's hit landed, not out on the bubble's rim: the shot met the parts, not a circle)
      if (this.ripples.length < 40) this.ripples.push({ id, a: Math.atan2(y - e.renderY, x - e.renderX) - e.renderAngle, d: Math.min(r, Math.hypot(x - e.renderX, y - e.renderY)), life: 0, model: m });
    }
  }

  /**
   * A shot struck at (x, y): on a ship's plating (no shield up), Reactive Armour throws bright sparks off and flicks a
   * ring where it deflects; Spaced Plating throws chips and a puff of dust, and the outer plate peels away a little more
   * the harder it's hurt. The part is found from where the shot landed (the wire carries no part).
   */
  private platingHit(x: number, y: number): void {
    for (const [id, ship] of this.source.bodies) {
      const e = this.state.entities.get(id);
      if (!e || ship.kind !== 'ship' || (this.lastShield.get(id) ?? 0) > 0) continue;
      const R = ship.derived.radius + 12;
      if (Math.abs(x - e.renderX) > R || Math.abs(y - e.renderY) > R) continue;
      const parts = ship.blueprint.parts;
      const cs = this.source.tuning.cellSize, a = e.renderAngle + Math.PI / 2, ca = Math.cos(a), sa = Math.sin(a);
      const dx = x - e.renderX, dy = y - e.renderY;
      const [cx, cy] = ship.derived.com;
      const gx = cx + (dx * ca + dy * sa) / cs, gy = cy + (-dx * sa + dy * ca) / cs;
      const geoms = this.source.geometry(ship);
      let hit = -1, bd = 0.9;
      for (let i = 0; i < parts.length; i++) {
        if (!ship.derived.alive[i]) continue;
        const f = parts[i].fn;
        if (f !== 'plating_reactive_armour' && f !== 'plating_spaced_plating') continue;
        const c = geoms[i]?.centroid;
        if (!c) continue;
        const d = Math.hypot(c[0] - gx, c[1] - gy);
        if (d < bd) { bd = d; hit = i; }
      }
      if (hit < 0) continue;
      const reactive = parts[hit].fn === 'plating_reactive_armour';
      if (reactive) {
        this.burstSparks(x, y, e.vx, e.vy, 7, 3, 9, 0xffe9a0);
        this.glow(x, y, e.vx, e.vy, 7, 5, 0xfff2c8, 0.7);
        this.ring(x, y, e.vx, e.vy, 3, 13, 8, 0xffd98a, 0.5);
      } else {
        const hurt = ship.maxHp[hit] > 0 ? 1 - ship.hp[hit] / ship.maxHp[hit] : 0;
        this.chunks(x, y, e.vx, e.vy, 2 + Math.round(3 * hurt), 1.3, 3, 0x8a929e);
        this.dustPuff(x, y, e.vx, e.vy, 6, 40, 0x8a857e, 0.3);
        this.burstSparks(x, y, e.vx, e.vy, 3, 1.5, 4, 0xc9d0da);
      }
      return;
    }
  }

  /** A Flash Screen came back at (x, y) (the server's ShieldFlash effect, seen even when the shield never showed as empty): bloom the nearest bubble */
  shieldReform(x: number, y: number): void {
    let best = -1, bd = Infinity;
    for (const [id, ship] of this.source.bodies) {
      const e = this.state.entities.get(id);
      if (!e || ship.kind !== 'ship') continue;
      const d = Math.hypot(e.renderX - x, e.renderY - y);
      if (d < bd) { bd = d; best = id; }
    }
    if (best >= 0 && bd < 300) this.reform.set(best, 1);
  }

  private drawRipples(frames: number): void {
    for (let i = this.ripples.length - 1; i >= 0; i--) {
      const rp = this.ripples[i];
      rp.life += frames;
      const e = this.state.entities.get(rp.id), ship = this.source.get(rp.id);
      if (rp.life >= 18 || !e || !ship) { this.ripples.splice(i, 1); continue; }
      const k = rp.life / 18, r = ship.derived.radius * 1.12 + 10, a = rp.a + e.renderAngle;
      // A patch of shield over the struck spot, spreading as it fades
      // (Sized to the strike, capped: a boss's bubble is huge, and its whole rim lighting up read as the shot meeting a circle)
      const rr = Math.min(r, 90);
      const px = e.renderX + Math.cos(a) * rp.d, py = e.renderY + Math.sin(a) * rp.d, fade = Math.pow(1 - k, 1.5);
      // Strobe flares the rim pink; Overpulse cracks the bubble; every other gun is the pale ripple
      const tint = rp.model === 1 ? 0xff4fb0 : rp.model === 2 ? 0xff6ee8 : 0xe0faff;
      this.addSprites.take(glowBall(), px, py, 0.5, 0.5, tint, fade, a, (rr * 0.3) / DOT_SIZE, (rr * (0.6 + 1.0 * k)) / DOT_SIZE);
      if (rp.model === 1) {
        // The rim itself: a bright arc across the struck spot, tangent to the bubble
        this.addSprites.take(streak(), px, py, 0.5, 0.5, 0xff8fd0, fade, a + Math.PI / 2, streakScale(rr * 0.9, 5).x, streakScale(rr * 0.9, 5).y);
      } else if (rp.model === 2) {
        // Cracks: jagged radial lines from the strike, fixed per ripple, lengthening then fading
        const len = rr * (0.45 + 0.4 * Math.min(1, k * 3));
        for (let c = 0; c < 6; c++) {
          const ca = a + c * (Math.PI / 3) + Math.sin(rp.a * 7 + c * 2.1) * 0.35;
          const sc = streakScale(len * (0.6 + 0.4 * ((c * 5) % 3) / 2), 2.5);
          this.addSprites.take(streak(), px, py, 0, 0.5, 0xfff0fb, fade, ca, sc.x, sc.y);
        }
      }
    }
  }

  update(dt: number): void {
    this.time += dt;
    const frames = Math.min(4, dt * 60);
    for (let i = this.pending.length - 1; i >= 0; i--) {
      if (this.pending[i].at > this.time) continue;
      const p = this.pending[i];
      this.pending.splice(i, 1);
      p.run();
    }
    this.ambient(dt);
    this.fires(frames);
    this.addSprites.begin();
    this.smokeSprites.begin();
    this.rings.begin();
    this.draw(frames);
    this.drawShields(frames);
    this.drawRipples(frames);
    this.drawCharges();
    this.addSprites.end();
    this.smokeSprites.end();
    this.rings.end();
  }

  /** Flames licking off burning parts, and smoke and fire pouring off wrecked ones (a boss's ruined pieces) */
  private fires(frames: number): void {
    this.wrecks(frames);
    if (!this.burns.length) return;
    this.burns = this.burns.filter((b) => b.until > this.time && this.source.get(b.body)?.derived.alive[b.part] !== false);
    for (const b of this.burns) {
      if (Math.random() > 0.55 * frames) continue;
      const p = this.partWorld(b.body, b.part);
      if (!p) continue;
      const a = Math.random() * Math.PI * 2;
      this.push({ kind: 'glow', x: p.x + Math.cos(a) * 6, y: p.y + Math.sin(a) * 6, vx: p.vx + (Math.random() - 0.5) * 0.5, vy: p.vy + (Math.random() - 0.5) * 0.5,
        life: 0, max: 16 + Math.random() * 14, size: 9 + Math.random() * 9, grow: 0.25, color: Math.random() < 0.5 ? 0xff7a1a : 0xffc04a, alpha: 0.8, drag: 0.97, rot: 0, vr: 0 });
      if (Math.random() < 0.25) this.dustPuff(p.x, p.y, p.vx, p.vy - 0.2, 7, 60, 0x302a26, 0.35, 0.15);
      // Embers lifting off it
      if (Math.random() < 0.3) this.push({ kind: 'spark', x: p.x + Math.cos(a) * 4, y: p.y + Math.sin(a) * 4, vx: p.vx + (Math.random() - 0.5) * 0.8, vy: p.vy - 0.5 - Math.random() * 0.7,
        life: 0, max: 26 + Math.random() * 20, size: 1.3, grow: 0, color: 0xffa04a, alpha: 1, drag: 0.97, rot: 0, vr: 0 });
    }
  }

  private wrecks(frames: number): void {
    const catalog = this.source.catalog;
    for (const [id, ship] of this.source.bodies) {
      if (!ship.blueprint.rigid) continue;
      ship.hp.forEach((_, i) => {
        if (!ship.derived.alive[i] || !isRuined(catalog, ship, i) || Math.random() > 0.12 * frames) return;
        const p = this.partWorld(id, i);
        if (!p) return;
        const a = Math.random() * Math.PI * 2, r = Math.random() * 18;
        if (Math.random() < 0.6) this.dustPuff(p.x + Math.cos(a) * r, p.y + Math.sin(a) * r, p.vx, p.vy - 0.3, 14, 110, 0x221c19, 0.55, 0.2);
        else this.push({ kind: 'glow', x: p.x + Math.cos(a) * r, y: p.y + Math.sin(a) * r, vx: p.vx + (Math.random() - 0.5) * 0.6, vy: p.vy + (Math.random() - 0.5) * 0.6,
          life: 0, max: 14 + Math.random() * 12, size: 10 + Math.random() * 10, grow: 0.3, color: Math.random() < 0.5 ? 0xff6a1a : 0xffb04a, alpha: 0.85, drag: 0.97, rot: 0, vr: 0 });
      });
    }
  }

  /** A boss gathering power: a tightening ring and a growing core glow */
  private drawCharges(): void {
    if (!this.charges.length) return;
    this.charges = this.charges.filter((c) => c.until > this.time);
    const g = this.add;
    for (const c of this.charges) {
      const e = this.state.entities.get(c.body);
      const ship = this.source.get(c.body);
      if (!e || !ship) continue;
      const k = Math.min(1, (this.time - c.start) / Math.max(0.01, c.until - c.start));
      const r = ship.derived.radius + 40;
      const color = c.kind === 'emp' ? 0x7dd3fc : c.kind === 'singularity' ? 0xc084fc : c.kind === 'prism_shard' ? 0xf0abfc : 0xffa04a;
      this.rings.ring(e.renderX, e.renderY, r * (2.2 - 1.2 * k), 2 + 6 * k, color, 0.25 + 0.6 * k);
      this.rings.disc(e.renderX, e.renderY, r * (0.4 + 0.5 * k), color, 0.06 + 0.16 * k);
      if (Math.random() < 0.6) {
        const a = Math.random() * Math.PI * 2, d = r * (1.6 - k * 0.6);
        this.push({ kind: 'spark', x: e.renderX + Math.cos(a) * d, y: e.renderY + Math.sin(a) * d, vx: -Math.cos(a) * 5 + e.vx, vy: -Math.sin(a) * 5 + e.vy,
          life: 0, max: 14, size: 1.5, grow: 0, color, alpha: 0.9, drag: 0.95, rot: 0, vr: 0 });
      }
    }
  }

  /**
   * Things that just go on: embers and smoke trailing off crumbling debris, and
   * cyan glints over ships being repaired at a station.
   */
  private ambient(dt: number): void {
    this.emberClock += dt;
    if (this.emberClock < 0.08) return;
    this.emberClock = 0;
    const stations = [...this.state.entities.ofType(EntityType.Station)];
    for (const [id, ship] of this.source.bodies) {
      const e = this.state.entities.get(id);
      if (!e) continue;
      const alive = ship.derived.alive.map((a, i) => (a ? i : -1)).filter((i) => i >= 0);
      if (!alive.length) continue;
      if (ship.kind === 'debris') {
        if (Math.random() > 0.5) continue;
        const p = this.partWorld(id, alive[Math.floor(Math.random() * alive.length)]);
        if (!p) continue;
        if (Math.random() < 0.6) this.spark(p.x, p.y, p.vx + (Math.random() - 0.5) * 0.6, p.vy + (Math.random() - 0.5) * 0.6, 30 + Math.random() * 40, 0xff8a3a);
        else this.dustPuff(p.x, p.y, p.vx + (Math.random() - 0.5) * 0.3, p.vy + (Math.random() - 0.5) * 0.3, 6 + Math.random() * 6, 70, 0x5a5550, 0.25, 0.12);
        continue;
      }
      // Being repaired: near a station and something to fix
      const damaged = alive.filter((i) => ship.hp[i] < ship.maxHp[i] - 1e-6);
      const missing = ship.derived.alive.length - alive.length;
      if (!damaged.length && !missing) continue;
      const nearStation = stations.some((s) => Math.hypot(s.renderX - e.renderX, s.renderY - e.renderY) < (s.data?.[8] ?? 200) + this.repairRange);
      if (!nearStation && !this.kitShips.has(id)) continue;
      const pool = damaged.length ? damaged : alive;
      const p = this.partWorld(id, pool[Math.floor(Math.random() * pool.length)]);
      if (!p) continue;
      const a = Math.random() * Math.PI * 2;
      this.push({ kind: 'spark', x: p.x + Math.cos(a) * 8, y: p.y + Math.sin(a) * 8, vx: p.vx, vy: p.vy - 0.15, life: 0, max: 30, size: 1.2, grow: 0, color: 0x8ff6ff, alpha: 0.7, drag: 1, rot: 0, vr: 0 });
    }
  }

  private draw(frames: number): void {
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
