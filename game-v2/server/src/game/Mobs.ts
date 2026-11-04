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
 *   mine      sits where it was laid (it never hunts: its flight is the law's unarmed drift) and bursts when a pilot
 *             comes within its fuse, the nearest by (distance, id)
 *
 * It flies by the scheduled-waypoint law (common guidance/waypoints.ts, FLIGHT_MOB), its state on the law's grid: its
 * clients fly it on their tick layers (CAPS.WAYPOINTS, net/guides/GuideNet.ts). Who it hunts is its brain's (its
 * owner's target, else the nearest pilot): a new one goes to them as a TARGET record.
 *
 * Only pilots' damage hurts them (their owner's own shells pass through), and
 * they travel in the snapshot as plain entities (EntityType.Enemy).
 */

import { addComponent, addEntity, removeEntity, IWorld } from 'bitecs';
import {
  Position, Velocity, Rotation, Radius, InSystem, segmentNearCircle, insideTerrain, type Terrain, dcos, dhypot, dsin,
  FLIGHT_MOB, GUIDE, PLAN_NONE, PLAN_WP, guideKind, launchArgs, launchSpots, type LaunchPattern, guideRetarget, guideTick, newGuide, qAngle, qGuide, wpArgs, type Guide, type GuideBody,
} from '@space-game/common';
import { SimPass } from '../sim/SystemClocks.js';

export interface MobDef {
  name: string;
  behaviour: 'kamikaze' | 'mine';
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
  /** Is this ship still there to hunt (gone: it lets go, and its clients are told) */
  alive?(eid: number): boolean;
  /** A mob's guide record at this tick (common guidance/records.ts: WP, NEXT, TARGET), for its clients (GuideNet) */
  guided?(eid: number, tick: number, op: number, args: number[]): void;
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
  /** Its flight (the waypoint law; its target is the guide's) */
  guide: Guide;
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

  /**
   * A volley laid at once (a Rivet Sower's mines): one still at each spot of the pattern (common guidance/launch.ts),
   * for `owner`. Its ids in spot order; its clients get it as one LAUNCH row, not a SYNC a mob (GuideNet, CAPS.LAUNCHES)
   */
  launch(id: string, systemNum: number, p: LaunchPattern, owner: number, scale = 1): number[] {
    const out: number[] = [];
    for (const at of launchSpots(p)) {
      const eid = this.spawn(id, systemNum, at.x, at.y, 0, 0, owner, scale);
      if (eid >= 0) out.push(eid);
    }
    const first = this.live.get(out[0]);
    if (first && out.length === p.n) this.host.guided?.(out[0], this.host.tick(), GUIDE.LAUNCH, launchArgs(first.guide.kind, first.born, p, out));
    return out;
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
    // (on the waypoint law's grid: its clients fly it exactly)
    Position.x[eid] = qGuide(x); Position.y[eid] = qGuide(y);
    Velocity.x[eid] = qGuide(dcos(angle) * speed); Velocity.y[eid] = qGuide(dsin(angle) * speed);
    Rotation.angle[eid] = qAngle(angle);
    Radius.value[eid] = def.radius;
    InSystem.systemId[eid] = systemNum;
    const born = this.host.tick();
    // (A mine never arms its flight: it drifts as laid for its whole life)
    const guide = newGuide(-1, guideKind(def.turn, def.accel, def.speed, FLIGHT_MOB, born + (def.behaviour === 'mine' ? def.life : def.arm ?? 0)));
    this.live.set(eid, { eid, id, def, index: this.ids.indexOf(id), hp: def.hp, owner, born, target: -1, scale, guide });
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

  /** A new target (its brain's), and its clients told */
  private retarget(m: Live, t: number, now: number): void {
    m.target = t;
    guideRetarget(m.guide, t);
    this.host.guided?.(m.eid, now, GUIDE.TARGET, [t + 1]);
  }

  private readonly gm: GuideBody = { x: 0, y: 0, vx: 0, vy: 0, a: 0 };
  private readonly gt: GuideBody = { x: 0, y: 0, vx: 0, vy: 0 };

  tick(): void {
    const now = this.host.tick();
    for (const m of [...this.live.values()]) {
      const { eid, def, guide: g } = m;
      const num = InSystem.systemId[eid];
      // (Its system's pass: crowd dilation, sim/SystemClocks.ts)
      if (!SimPass.on(num)) continue;
      const age = now - m.born;
      if (age >= def.life) { this.kill(m, true); continue; }
      const x = Position.x[eid], y = Position.y[eid];
      if (def.behaviour === 'mine') {
        // A mine: the nearest pilot within its fuse sets it off
        const p = this.host.nearestPlayer(num, x, y, def.blast.fuse + 300);
        const gap = p < 0 ? Infinity : this.host.hullGap ? this.host.hullGap(p, x, y, def.blast.fuse) : dhypot(Position.x[p] - x, Position.y[p] - y) - this.host.radiusOf(p);
        if (age >= (def.arm ?? 0) && gap < def.blast.fuse) { this.kill(m, false); continue; }
      }
      const armed = def.behaviour !== 'mine' && age >= (def.arm ?? 0);
      if (armed) {
        // Its owner's target, or the nearest pilot about (its brain: told to its clients when it changes)
        if (now % 15 === m.eid % 15 || m.target < 0) {
          const t = this.host.targetOf(m.owner);
          const pick = t >= 0 && InSystem.systemId[t] === num ? t : this.host.nearestPlayer(num, x, y, 4000);
          if (pick !== m.target) this.retarget(m, pick, now);
        }
        // (one gone lets go: the next pick is its brain's again)
        if (m.target >= 0 && (InSystem.systemId[m.target] !== num || !(this.host.alive?.(m.target) ?? true))) this.retarget(m, -1, now);
      }
      // Its flight: the waypoint law, its waypoints planned from its target as it is now (a pilot after its step)
      const mb = this.gm, t = m.target, tg = this.gt;
      mb.x = x; mb.y = y; mb.vx = Velocity.x[eid]; mb.vy = Velocity.y[eid]; mb.a = Rotation.angle[eid];
      if (t >= 0) { tg.x = Position.x[t]; tg.y = Position.y[t]; tg.vx = Velocity.x[t]; tg.vy = Velocity.y[t]; }
      const did = guideTick(g, eid, mb, t >= 0 ? tg : null, now);
      if (did !== PLAN_NONE) this.host.guided?.(eid, now, did === PLAN_WP ? GUIDE.WP : GUIDE.NEXT, wpArgs(did === PLAN_WP ? g.w! : g.n!, mb));
      if (armed && t >= 0) {
        // Burst once within its fuse of the hull
        const gap = this.host.hullGap ? this.host.hullGap(t, x, y, def.blast.fuse) : dhypot(Position.x[t] - x, Position.y[t] - y) - this.host.radiusOf(t);
        if (gap < def.blast.fuse) { this.kill(m, false); continue; }
      }
      const vx = mb.vx, vy = mb.vy;
      Velocity.x[eid] = vx; Velocity.y[eid] = vy;
      Rotation.angle[eid] = mb.a!;
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

  /** Every mob, by the waypoint law (GuideNet's sources) */
  *guided(): IterableIterator<[number, Guide]> {
    for (const m of this.live.values()) yield [m.eid, m.guide];
  }

  /** A mob's motion and heading (null: not one) */
  guideBody(eid: number): GuideBody | null {
    return this.live.has(eid) ? { x: Position.x[eid], y: Position.y[eid], vx: Velocity.x[eid], vy: Velocity.y[eid], a: Rotation.angle[eid] } : null;
  }

  /** The tick it was launched (an id reused is another mob) */
  guideBorn(eid: number): number {
    return this.live.get(eid)?.born ?? -1;
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
