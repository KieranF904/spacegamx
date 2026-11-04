/**
 * Mobs (data/mobs.json): single-body enemies. One shape (a circle for
 * hits, its outline only for the look), one HP number, and a simple way of
 * flying: no blueprint, no parts, no power network. Cheap enough to throw
 * in by the dozen, so they're what a boss launches in waves.
 *
 * Behaviours:
 *   kamikaze  homes on its target with a little lead, turning at its own rate,
 *             and bursts when anything it may hurt comes within its fuse (or
 *             when its life runs out, harmlessly)
 *
 * Only pilots' damage hurts them (their owner's own shells pass through), and
 * they travel in the snapshot as plain entities (EntityType.Enemy).
 */

import { addComponent, addEntity, removeEntity, IWorld } from 'bitecs';
import { Position, Velocity, Rotation, Radius, InSystem, segmentNearCircle, insideTerrain, type Terrain, datan2, dcos, dhypot, dsin } from '@space-game/common';

export interface MobDef {
  name: string;
  behaviour: 'kamikaze';
  hp: number;
  /** Hit radius (world units) */
  radius: number;
  /** Top speed and acceleration (world units a tick), and turn rate (radians a tick) */
  speed: number;
  accel: number;
  turn: number;
  /** Ticks it lives */
  life: number;
  /** Its burst: fuse distance (from the target's hull), radius and damage */
  blast: { fuse: number; radius: number; damage: number };
  /** Ticks after launch before it hunts (it flies straight out of its bay first) */
  arm?: number;
  /** The look (the client draws it): its outline (world units, nose along +x), hull and glow colours */
  shape: [number, number][];
  color: string;
  glow: string;
}

export interface MobsFile { mobs: Record<string, MobDef> }

export interface MobHost {
  readonly world: IWorld;
  tick(): number;
  /** Who a mob's owner is fighting (a boss's target), or -1 */
  targetOf(owner: number): number;
  /** The nearest pilot in a system within range of a point, or -1 */
  nearestPlayer(systemNum: number, x: number, y: number, range: number): number;
  /** A ship's hull radius (fuse distances are from its hull) */
  radiusOf(eid: number): number;
  /** How far a point is from a ship's real hull (its parts' outlines), if the host can tell: fuses go by it */
  hullGap?(eid: number, x: number, y: number, within: number): number;
  /** Splash damage from a mob's burst (hurts ships, never its own side) */
  blast(systemNum: number, x: number, y: number, radius: number, damage: number, owner: number): void;
  /** Effects: a burst (`fizzle`: it burnt out, harmlessly) */
  burst(systemNum: number, x: number, y: number, radius: number, kind: string, fizzle: boolean): void;
  /** It's gone (the snapshot tells clients) */
  removed(eid: number): void;
  /** A surface's rock (it bursts against it) */
  terrain?(systemNum: number): Terrain | undefined;
}

interface Live {
  eid: number;
  id: string;
  def: MobDef;
  index: number;
  hp: number;
  owner: number;
  born: number;
  target: number;
  /** Damage scale (its owner's) */
  scale: number;
}

export class Mobs {
  private live = new Map<number, Live>();
  private ids: string[];

  constructor(private host: MobHost, readonly file: MobsFile) {
    this.ids = Object.keys(file.mobs);
  }

  /** The mob kinds in a stable order (the snapshot sends an index) */
  kinds(): string[] {
    return this.ids;
  }

  has(eid: number): boolean {
    return this.live.has(eid);
  }

  count(systemNum?: number): number {
    let n = 0;
    for (const m of this.live.values()) if (systemNum === undefined || InSystem.systemId[m.eid] === systemNum) n++;
    return n;
  }

  /** Launch one: out of (x, y) heading `angle` at `speed`, flying for `owner` (whose target it hunts) */
  spawn(id: string, systemNum: number, x: number, y: number, angle: number, speed: number, owner: number, scale = 1): number {
    const def = this.file.mobs[id];
    if (!def) return -1;
    const w = this.host.world;
    const eid = addEntity(w);
    addComponent(w, Position, eid);
    addComponent(w, Velocity, eid);
    addComponent(w, Rotation, eid);
    addComponent(w, Radius, eid);
    addComponent(w, InSystem, eid);
    Position.x[eid] = x; Position.y[eid] = y;
    Velocity.x[eid] = dcos(angle) * speed; Velocity.y[eid] = dsin(angle) * speed;
    Rotation.angle[eid] = angle;
    Radius.value[eid] = def.radius;
    InSystem.systemId[eid] = systemNum;
    this.live.set(eid, { eid, id, def, index: this.ids.indexOf(id), hp: def.hp, owner, born: this.host.tick(), target: -1, scale });
    return eid;
  }

  /** For the snapshot: its kind's index, and HP */
  info(eid: number): { index: number; hp: number; maxHp: number } | undefined {
    const m = this.live.get(eid);
    return m && { index: m.index, hp: Math.max(0, Math.round(m.hp)), maxHp: m.def.hp };
  }

  /** Mobs in a system (the snapshot) */
  inSystem(num: number): number[] {
    const out: number[] = [];
    for (const m of this.live.values()) if (InSystem.systemId[m.eid] === num) out.push(m.eid);
    return out;
  }

  tick(): void {
    const now = this.host.tick();
    for (const m of [...this.live.values()]) {
      const { eid, def } = m;
      const num = InSystem.systemId[eid];
      const age = now - m.born;
      if (age >= def.life) { this.kill(m, true); continue; }
      const x = Position.x[eid], y = Position.y[eid];
      let vx = Velocity.x[eid], vy = Velocity.y[eid];
      let ang = Rotation.angle[eid];
      if (age >= (def.arm ?? 0)) {
        // Its owner's target, or the nearest pilot about
        if (now % 15 === m.eid % 15 || m.target < 0) {
          const t = this.host.targetOf(m.owner);
          m.target = t >= 0 && InSystem.systemId[t] === num ? t : this.host.nearestPlayer(num, x, y, 4000);
        }
        const t = m.target;
        if (t >= 0) {
          const tx = Position.x[t], ty = Position.y[t];
          const d = dhypot(tx - x, ty - y);
          // A little lead, more the further off it is
          const lead = Math.min(18, d / Math.max(4, def.speed));
          const want = datan2(ty + Velocity.y[t] * lead - y, tx + Velocity.x[t] * lead - x);
          let da = want - ang;
          while (da > Math.PI) da -= 2 * Math.PI;
          while (da < -Math.PI) da += 2 * Math.PI;
          ang += Math.max(-def.turn, Math.min(def.turn, da));
          // Burst once within its fuse of the hull
          const gap = this.host.hullGap ? this.host.hullGap(t, x, y, def.blast.fuse) : d - this.host.radiusOf(t);
          if (gap < def.blast.fuse) { this.kill(m, false); continue; }
        }
        vx += dcos(ang) * def.accel; vy += dsin(ang) * def.accel;
        // It flies where it points: sideways drift bleeds away fast
        const fx = dcos(ang), fy = dsin(ang), along = vx * fx + vy * fy;
        vx = fx * along + (vx - fx * along) * 0.86; vy = fy * along + (vy - fy * along) * 0.86;
        const sp = dhypot(vx, vy);
        if (sp > def.speed) { vx *= def.speed / sp; vy *= def.speed / sp; }
      } else {
        // Out of the bay: coasting, slowing a little
        vx *= 0.98; vy *= 0.98;
      }
      Velocity.x[eid] = vx; Velocity.y[eid] = vy;
      Rotation.angle[eid] = ang;
      Position.x[eid] = x + vx;
      Position.y[eid] = y + vy;
      // Flown into rock: it bursts against it (weakly, as one shot down)
      if (insideTerrain(this.host.terrain?.(num), x + vx, y + vy, def.radius * 0.6)) this.kill(m, false, true);
    }
  }

  /**
   * A pilot's shot this tick, from (x0, y0) to (x1, y1): the first mob it
   * meets, and how far along (0..1). Their owner's side's shots pass through.
   */
  rayHit(systemNum: number, x0: number, y0: number, x1: number, y1: number, pad = 0): { eid: number; t: number } | null {
    let best: { eid: number; t: number } | null = null;
    const dx = x1 - x0, dy = y1 - y0, len2 = dx * dx + dy * dy || 1;
    for (const m of this.live.values()) {
      if (InSystem.systemId[m.eid] !== systemNum) continue;
      const cx = Position.x[m.eid], cy = Position.y[m.eid], r = m.def.radius + pad;
      if (!segmentNearCircle(x0, y0, x1, y1, cx, cy, r)) continue;
      const t = Math.max(0, Math.min(1, ((cx - x0) * dx + (cy - y0) * dy) / len2));
      if (!best || t < best.t) best = { eid: m.eid, t };
    }
    return best;
  }

  /** Damage one; true if that killed it */
  hurt(eid: number, amount: number): boolean {
    const m = this.live.get(eid);
    if (!m || amount <= 0) return false;
    m.hp -= amount;
    if (m.hp > 0) return false;
    // Shot down: it still bursts, but out of reach of where it was going
    this.kill(m, false, true);
    return true;
  }

  /** Splash: every mob within reach takes it (falling off to half at the edge) */
  splash(systemNum: number, x: number, y: number, radius: number, damage: number): void {
    for (const m of [...this.live.values()]) {
      if (InSystem.systemId[m.eid] !== systemNum) continue;
      const d = dhypot(Position.x[m.eid] - x, Position.y[m.eid] - y) - m.def.radius;
      if (d < radius) this.hurt(m.eid, damage * (1 - 0.5 * Math.max(0, d) / radius));
    }
  }

  /** Every mob a beam passes through takes `damage` (beams aren't stopped by them) */
  beam(systemNum: number, x0: number, y0: number, x1: number, y1: number, width: number, damage: number): void {
    for (const m of [...this.live.values()]) {
      if (InSystem.systemId[m.eid] !== systemNum) continue;
      if (segmentNearCircle(x0, y0, x1, y1, Position.x[m.eid], Position.y[m.eid], m.def.radius + width / 2)) this.hurt(m.eid, damage);
    }
  }

  /** How many of one owner's are out in a system */
  ownedBy(systemNum: number, owner: number): number {
    let n = 0;
    for (const m of this.live.values()) if (m.owner === owner && InSystem.systemId[m.eid] === systemNum) n++;
    return n;
  }

  /** Clear them all from a system (a boss reset), or those of one owner */
  clear(systemNum: number, owner?: number): void {
    for (const m of [...this.live.values()]) {
      if (InSystem.systemId[m.eid] === systemNum && (owner === undefined || m.owner === owner)) this.kill(m, true);
    }
  }

  private kill(m: Live, fizzle: boolean, shot = false): void {
    const num = InSystem.systemId[m.eid], x = Position.x[m.eid], y = Position.y[m.eid];
    this.live.delete(m.eid);
    // A burst that reached its target hurts; one shot down hurts only what's right beside it
    if (!fizzle) this.host.blast(num, x, y, shot ? m.def.blast.radius * 0.6 : m.def.blast.radius, m.def.blast.damage * m.scale * (shot ? 0.35 : 1), m.owner);
    this.host.burst(num, x, y, m.def.blast.radius, m.id, fizzle);
    this.host.removed(m.eid);
    removeEntity(this.host.world, m.eid);
  }
}
