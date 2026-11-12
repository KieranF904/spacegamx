/**
 * @contract client.ships.gun-preview.block-target
 * owns:       the hangar gun preview's target as a wall of square ship blocks (no Pixi, no DOM): each block's HP, the surface
 *             rounds meet and throw their impact off, the damage a round, burst, chain or beam does to the blocks it
 *             touches, blocks breaking, and the wall rebuilding when it is mostly gone
 * needs:      impactAim SurfaceProbe (the same normal finder the live client's hits use); common partMaxHp (the blocks' HP)
 * invariants: a round hurts only the block it strikes, a burst the blocks within its radius by falloff — client/src/ships/gunPreview/blockTarget.test.ts
 *             a block at 0 HP is broken once and no longer met by rounds — client/src/ships/gunPreview/blockTarget.test.ts
 *             a rebuilt wall has every block at full HP — client/src/ships/gunPreview/blockTarget.test.ts
 * extend:     a new kind of damage is one method here and one call in GunPreview's onStruck or frame
 */

import { partMaxHp, type Catalog, type PlacedPart } from '@space-game/common';
import { SurfaceProbe, type SurfaceNormal } from '../../rendering/weapons/impactAim';
import { WALL_COLS, WALL_ROWS } from './framing';

/** The wall's blocks are the entities rounds see struck: ids from here (impact anchors look the pose up by id) */
export const BLOCK_ID = 7_000_001;

/** HP of a block of hull and of armour: the catalogue's partMaxHp for a square of each */
export interface BlockSpec { hullHp: number; armourHp: number }
export const DEFAULT_SPEC: BlockSpec = { hullHp: 75, armourHp: 187.5 };

export interface Block {
  /** Entity id: BLOCK_ID + index */
  id: number;
  col: number;
  row: number;
  /** Centre and side (world units) */
  x: number;
  y: number;
  size: number;
  hp: number;
  max: number;
  /** The front column is armour plate, the rest hull */
  armour: boolean;
  alive: boolean;
  /** 0..1 while the wall grows back */
  appear: number;
  /** Needs redrawing */
  dirty: boolean;
}

/** What a round does where it lands */
export interface HitDamage {
  damage: number;
  splashDamage: number;
  splashRadius: number;
  splashFalloff: number;
  chain: { count: number; radius: number; falloff: number } | null;
}

/** As hitSurface: how far back along the line and on past the hit its edges are looked for, and the nearest edge's reach */
const BACK = 48, ON = 24, REACH = 36;
/** A wall this share gone (or this many seconds old) is rebuilt after a short lull */
const GONE_SHARE = 0.8;
const LULL_S = 1.3;
const MAX_AGE_S = 24;
const GROW_S = 0.7;

const probe = new SurfaceProbe();

export class BlockTarget {
  blocks: Block[] = [];
  /** Blocks broken since the last `takeBroken`, for the debris */
  private broken: Block[] = [];
  /** Seconds the wall has stood, and the lull before it is rebuilt (-1: not rebuilding) */
  private age = 0;
  private lull = -1;
  private hurt = 1;
  private mended = 0;
  /** Bumped on every rebuild */
  rebuilds = 0;

  constructor(private spec: BlockSpec = DEFAULT_SPEC) {}

  /** Lay the wall out: its front face `dist` along the line of fire, blocks `size` a side, centred on the line */
  layout(dist: number, size: number, hurt = 1): void {
    this.blocks = [];
    for (let c = 0; c < WALL_COLS; c++) {
      for (let r = 0; r < WALL_ROWS; r++) {
        const armour = c === 0, max = armour ? this.spec.armourHp : this.spec.hullHp;
        this.blocks.push({
          id: BLOCK_ID + this.blocks.length, col: c, row: r, x: dist + (c + 0.5) * size, y: (r - (WALL_ROWS - 1) / 2) * size,
          size, hp: max, max, armour, alive: true, appear: 1, dirty: true,
        });
      }
    }
    this.hurt = hurt;
    this.reset(false);
  }

  /** Every block whole again (hurt: at that share of its HP, for a wall a Repair Beam mends); `grow`: fading in */
  reset(grow = true): void {
    for (const b of this.blocks) {
      b.alive = true; b.hp = b.max * this.hurt; b.appear = grow ? 0 : 1; b.dirty = true;
    }
    this.broken.length = 0;
    this.age = 0; this.lull = -1; this.mended = 0;
    if (grow) this.rebuilds++;
  }

  get aliveCount(): number {
    let n = 0;
    for (const b of this.blocks) if (b.alive) n++;
    return n;
  }

  /** Blocks broken since last asked (each once) */
  takeBroken(): Block[] {
    const out = this.broken;
    this.broken = [];
    return out;
  }

  private find(id: number): Block | undefined {
    return this.blocks[id - BLOCK_ID];
  }

  /** `dt` seconds on: the wall grows back in, and is rebuilt when mostly gone or old (a mended one: when whole) */
  step(dt: number): void {
    this.age += dt;
    for (const b of this.blocks) if (b.appear < 1) { b.appear = Math.min(1, b.appear + dt / GROW_S); b.dirty = true; }
    if (this.hurt < 1) {
      if (this.blocks.every((b) => b.hp >= b.max - 0.01)) { this.mended += dt; if (this.mended > LULL_S) this.reset(true); } else this.mended = 0;
      return;
    }
    if (this.lull >= 0) {
      this.lull -= dt;
      if (this.lull <= 0) this.reset(true);
    } else if (this.aliveCount <= this.blocks.length * (1 - GONE_SHARE) || this.age > MAX_AGE_S) this.lull = this.age > MAX_AGE_S ? 0.2 : LULL_S;
  }

  /** The first `t` (0..1) along (x0, y0) -> (x1, y1) that meets a standing block, with the block's id; 0 if it starts inside one */
  cast(x0: number, y0: number, x1: number, y1: number): { t: number; id: number } | null {
    const dx = x1 - x0, dy = y1 - y0;
    let best = Infinity, id = -1;
    for (const b of this.blocks) {
      if (!b.alive) continue;
      const h = b.size / 2;
      let tmin = 0, tmax = 1, ok = true;
      for (const [o, d, lo, hi] of [[x0, dx, b.x - h, b.x + h], [y0, dy, b.y - h, b.y + h]] as const) {
        if (Math.abs(d) < 1e-12) { if (o < lo || o > hi) { ok = false; break; } continue; }
        let a = (lo - o) / d, c = (hi - o) / d;
        if (a > c) [a, c] = [c, a];
        tmin = Math.max(tmin, a); tmax = Math.min(tmax, c);
        if (tmin > tmax) { ok = false; break; }
      }
      if (ok && tmin < best) { best = tmin; id = b.id; }
    }
    return id < 0 ? null : { t: best, id };
  }

  /** The normal of the block edge a shell flying (dx, dy) (a unit vector) struck at (x, y), facing it; target: the nearest edge's block */
  normalAt(x: number, y: number, dx: number, dy: number, out: SurfaceNormal): SurfaceNormal | null {
    probe.begin(x - dx * BACK, y - dy * BACK, x + dx * ON, y + dy * ON, x, y, REACH);
    for (const b of this.blocks) {
      if (!b.alive || Math.abs(b.x - x) > b.size * 2.5 || Math.abs(b.y - y) > b.size * 2.5) continue;
      const h = b.size / 2, l = b.x - h, r = b.x + h, t = b.y - h, bt = b.y + h;
      probe.edge(l, t, r, t, b.id); probe.edge(r, t, r, bt, b.id); probe.edge(r, bt, l, bt, b.id); probe.edge(l, bt, l, t, b.id);
    }
    return probe.result(out);
  }

  /** The standing block holding (x, y), else the nearest within a block's reach of it */
  blockAt(x: number, y: number): Block | null {
    let best: Block | null = null, bd = Infinity;
    for (const b of this.blocks) {
      if (!b.alive) continue;
      const d = Math.max(Math.abs(b.x - x), Math.abs(b.y - y)) - b.size / 2;
      if (d < bd) { bd = d; best = b; }
    }
    return best && bd <= best.size ? best : null;
  }

  /** Damage to one block; true if it broke */
  hurtBlock(b: Block, amount: number): boolean {
    if (!b.alive || amount <= 0) return false;
    b.hp -= amount;
    b.dirty = true;
    if (b.hp > 0) return false;
    b.hp = 0; b.alive = false;
    this.broken.push(b);
    return true;
  }

  /**
   * A round landed at (x, y): its direct damage to the block it struck (`target` an id, else the one holding the point),
   * its burst to every block by distance (full at the block's edge nearest the centre, to nothing at the radius, by
   * falloff), and a chain's jumps to the nearest other blocks. Returns the blocks hurt.
   */
  strike(x: number, y: number, target: number, d: HitDamage): Block[] {
    const hit = this.find(target)?.alive ? this.find(target)! : this.blockAt(x, y);
    const hurt: Block[] = [];
    if (hit && d.damage > 0) { this.hurtBlock(hit, d.damage); hurt.push(hit); }
    if (d.splashRadius > 0 && d.splashDamage > 0) {
      for (const b of this.blocks) {
        if (!b.alive) continue;
        const near = Math.hypot(Math.max(0, Math.abs(b.x - x) - b.size / 2), Math.max(0, Math.abs(b.y - y) - b.size / 2));
        if (near >= d.splashRadius) continue;
        this.hurtBlock(b, d.splashDamage * Math.pow(1 - near / d.splashRadius, d.splashFalloff));
        if (!hurt.includes(b)) hurt.push(b);
      }
    }
    if (d.chain && hit && d.damage > 0) {
      const ch = d.chain;
      const others = this.blocks.filter((b) => b.alive && b !== hit && Math.hypot(b.x - hit.x, b.y - hit.y) <= ch.radius)
        .sort((a, b) => Math.hypot(a.x - hit.x, a.y - hit.y) - Math.hypot(b.x - hit.x, b.y - hit.y));
      for (let i = 0; i < Math.min(ch.count, others.length); i++) {
        this.hurtBlock(others[i], d.damage * Math.pow(ch.falloff, i + 1));
        hurt.push(others[i]);
      }
    }
    return hurt;
  }

  /** A beam from the muzzle to (farX, farY) for one tick (along y = 0, but for a beam of a fan): `amount` to the first standing block (or mended, if negative); the x it ends at, or null if it meets none */
  beam(amount: number, farX: number, farY = 0): { x: number; id: number } | null {
    const c = this.cast(0, 0, farX, farY);
    if (!c) return null;
    const b = this.find(c.id)!;
    if (amount >= 0) this.hurtBlock(b, amount);
    else { b.hp = Math.min(b.max, b.hp - amount); b.dirty = true; }
    return { x: c.t * farX, id: c.id };
  }

  /** The x a beam from the muzzle ends at without touching anything (the first block's face), or null */
  beamEnd(farX: number, farY = 0): number | null {
    const c = this.cast(0, 0, farX, farY);
    return c ? c.t * farX : null;
  }
}

/** The HP of a hull square and an armour square of the first grade, from the catalogue (partMaxHp) */
export function blockSpec(catalog: Catalog): BlockSpec {
  const hp = (fn: string): number => partMaxHp(catalog, { uid: 0, piece: 'sq', fn, material: 'alloy', x: 0, y: 0, rot: 0, flip: false } as PlacedPart);
  return { hullHp: hp('hull'), armourHp: hp('armor') };
}
