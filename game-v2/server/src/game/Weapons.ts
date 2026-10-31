/**
 * Ship weapon projectiles: spawning each kind (data/ships/tuning.json
 * weapons) and what it does in flight.
 *   cannon   a plain shell
 *   railgun  very fast, passes through `pierce` bodies before stopping
 *   flak     proximity fuse: bursts near a target (or at the end of its life), splash damage
 *   missile  accelerates and homes on its lock; splash damage on impact
 *   emp      proximity fuse: an EMP burst that knocks out engines and guns
 * Legendary (boss) weapons:
 *   hive          a burst of small homing missiles
 *   cinder_bloom  incendiary: the part hit burns, and the fire spreads
 *   prism         shatters on impact into a fan of shards
 *   phase         pierces ships without losing damage
 *   singularity   a slow collapsing star: drags ships in, then implodes
 * Beam weapons (laser, lance, frostbite) are continuous and live in the ship bridge.
 */

import { addEntity, addComponent, hasComponent, entityExists, IWorld } from 'bitecs';
import {
  Position, Velocity, Radius, Projectile, Bullet, Lifetime, InSystem, NetworkSync, OwnedBy, Dead,
  ShipTuning, WeaponTuning, WEAPON_KIND_TYPE, ServerMessage, interceptHits, mulberry32, hashString, weaponDef, gunDef, launchShot, volleyAngles, weaponHit, type WeaponMods, type HitInfo,
} from '@space-game/common';
import type { ShipBridge } from '../ships/ShipBridge.js';

export interface WeaponsHost {
  readonly world: IWorld;
  tick(): number;
  broadcast(systemNum: number, msg: ServerMessage): void;
  /** Push a ship (gravity pulls); skips ships that can't be moved */
  nudge?(eid: number, ax: number, ay: number): void;
  remove(eid: number): void;
  /** Mining yield and hardness for a weapon's shots (asteroids) */
  miningTool(kind: string, turret: boolean): { yield: number; hardness: number };
}

interface Extra {
  kind: string;
  def: WeaponTuning;
  owner: number;
  target: number;
  pierceLeft: number;
  hit: Set<number>;
  damageScale: number;
  sizeScale: number;
  /** Point defence: hits left to shoot it down (0: it can't be; common/src/ships/features/support/support.ts) */
  intercept: number;
}

export class Weapons {
  private extras = new Map<number, Extra>();

  constructor(private host: WeaponsHost, private ships: ShipBridge, private tuning: ShipTuning) {}

  def(kind: string): WeaponTuning {
    return weaponDef(this.tuning, kind);
  }

  /**
   * One shot (a burst's fanned extras too). The shells' entity ids go in `out`
   * in spawn order. Where each goes is launchShot's (common/src/ships/launch.ts),
   * which clients use to build the same volley from a fire event.
   */
  spawn(owner: number, kind: string, x: number, y: number, angle: number, damageScale: number,
    shape: { speedScale: number; sizeScale: number; turret: boolean; target?: number; noBurst?: boolean; seed?: string; index?: number; mods?: WeaponMods; dry?: boolean; ammoMods?: WeaponMods; reach?: number; grade?: number; size?: number; model?: WeaponMods; intercept?: boolean }, out?: number[]): number {
    const w = this.host.world;
    // The gun's own mods (gems), then its ammunition's, its grade's and its size's: the same as the pilot's client builds the shells from (launch.ts gunDef)
    const full = gunDef(this.tuning, kind, { mods: shape.mods, ammo: shape.ammoMods, grade: shape.grade, size: shape.size, model: shape.model });
    // A plain round (out of ammunition): the same shell, none of its effects (and no fuse: with nothing to burst, it has to hit)
    const def = shape.dry ? { ...full, splash: undefined, emp: undefined, ignite: undefined, split: undefined, pull: undefined, pierce: 0, fuse: undefined, bane: undefined } : full;
    // A burst: the rest of the volley, fanned out (the main shell is the volley's last)
    let index = shape.index ?? 0;
    if ((def.burst ?? 1) > 1 && !shape.noBurst) {
      const angles = volleyAngles(def, angle);
      for (let i = 0; i < angles.length - 1; i++) this.spawn(owner, kind, x, y, angles[i], damageScale, { ...shape, noBurst: true, index: i }, out);
      index = angles.length - 1;
    }
    const eid = addEntity(w);
    for (const c of [Position, Velocity, Radius, Projectile, Bullet, Lifetime, InSystem, NetworkSync, OwnedBy]) addComponent(w, c, eid);
    // Seeded by what the client knows too (the firing ship, the part, the shell's place in the volley), so a pilot can predict it
    const seed = shape.seed !== undefined ? `${shape.seed}:${index}` : `e${eid}`;
    const shot = launchShot(def, kind, shape, angle, Velocity.x[owner], Velocity.y[owner], this.host.tick(), seed);
    Position.x[eid] = x;
    Position.y[eid] = y;
    // Shells inherit a little of the ship's motion; missiles launch slow and accelerate
    Velocity.x[eid] = shot.vx;
    Velocity.y[eid] = shot.vy;
    Radius.value[eid] = 5 * shot.size;
    Projectile.ownerId[eid] = owner;
    Projectile.damage[eid] = (def.damage ?? 14) * damageScale;
    Projectile.weaponType[eid] = WEAPON_KIND_TYPE[kind] ?? 1;
    // The gun's grade: how hard its shells punch through (damage.ts)
    Projectile.tier[eid] = shape.grade ?? 1;
    Projectile.spawnTick[eid] = this.host.tick();
    Projectile.spawnX[eid] = x;
    Projectile.spawnY[eid] = y;
    Projectile.sizeScale[eid] = shot.size;
    Projectile.turret[eid] = shape.turret ? 1 : 0;
    const tool = this.host.miningTool(kind, shape.turret);
    Projectile.miningYield[eid] = tool.yield;
    Projectile.miningHardness[eid] = tool.hardness;
    Bullet.speed[eid] = shot.speed;
    // A lobbed shell comes down where it was aimed
    Lifetime.remaining[eid] = def.lob && shape.reach ? Math.max(10, Math.min(shot.life, Math.round(shape.reach / Math.max(1, shot.speed)))) : shot.life;
    InSystem.systemId[eid] = InSystem.systemId[owner];
    OwnedBy.ownerId[eid] = owner;
    // (A plain cannon shell has nothing to track: one with a grade's or a gem's changes does)
    if (kind !== 'cannon' || def !== this.def(kind)) {
      // (Point defence may shoot it down if its kind can be, unless it's told not (a boss's nova): support.ts)
      this.extras.set(eid, { kind, def, owner, target: shape.target ?? -1, pierceLeft: def.pierce ?? 0, hit: new Set(), damageScale, sizeScale: shot.size, intercept: shape.intercept === false ? 0 : interceptHits(def) });
    }
    out?.push(eid);
    return eid;
  }

  /** Lobbed shells fly over everything until they come down */
  lobbed(proj: number): boolean {
    return !!this.extras.get(proj)?.def.lob;
  }

  /** A shot's damage against shields and hull, if its weapon has its own, what it hits with (damage.ts), and the faction its ammunition is made for */
  vsOf(proj: number): { shield?: number; hull?: number; hit: HitInfo; bane?: { faction: string; damage: number } } {
    const x = this.extras.get(proj), d = x?.def;
    const hit = this.hitOf(proj);
    const vs = d && (d.vsShield !== undefined || d.vsHull !== undefined) ? { shield: d.vsShield, hull: d.vsHull, hit } : { hit };
    return d?.bane ? { ...vs, bane: d.bane } : vs;
  }

  /** What a shot hits with: its weapon's damage type, and the gun's grade plus its penetration */
  hitOf(proj: number): HitInfo {
    const x = this.extras.get(proj);
    return weaponHit(x?.kind ?? 'cannon', x?.def ?? this.def('cannon'), Projectile.tier[proj] || 1);
  }

  /** Bodies a piercing shot has already passed through (it doesn't hit them twice) */
  exclusions(proj: number): Set<number> | undefined {
    return this.extras.get(proj)?.hit;
  }

  // --- Point defence (common/src/ships/features/support/support.ts; features/support pointDefence) ---

  /**
   * Shots point defence at (x, y) could fire on: ones that can be shot down, in this system, within `range`, fired by
   * a ship `hostile` says may hurt it. Nearest first, into `out` (cleared).
   */
  threats(systemNum: number, x: number, y: number, range: number, hostile: (owner: number) => boolean, out: { id: number; x: number; y: number; d: number }[]): void {
    out.length = 0;
    const w = this.host.world, r2 = range * range;
    for (const [eid, e] of this.extras) {
      if (e.intercept <= 0 || InSystem.systemId[eid] !== systemNum || !entityExists(w, eid) || hasComponent(w, Dead, eid)) continue;
      const dx = Position.x[eid] - x, dy = Position.y[eid] - y, d2 = dx * dx + dy * dy;
      if (d2 > r2 || !hostile(e.owner)) continue;
      out.push({ id: eid, x: Position.x[eid], y: Position.y[eid], d: Math.sqrt(d2) });
    }
    out.sort((a, b) => a.d - b.d || a.id - b.id);
  }

  /** A point-defence hit: one of its hits gone, and brought down it's removed (its warhead never goes off). True when it's down */
  intercept(proj: number): boolean {
    const e = this.extras.get(proj);
    if (!e || e.intercept <= 0) return false;
    if (--e.intercept > 0) return false;
    this.extras.delete(proj);
    this.host.remove(proj);
    return true;
  }
  // --- end point defence ---

  /** Missiles steer, fuses check for targets in range */
  tick(): void {
    const w = this.host.world;
    for (const [eid, x] of this.extras) {
      if (!entityExists(w, eid) || hasComponent(w, Dead, eid)) { this.extras.delete(eid); continue; }
      if (x.def.homing) {
        const t = x.target;
        const alive = t >= 0 && this.ships.has(t) && InSystem.systemId[t] === InSystem.systemId[eid];
        let vx = Velocity.x[eid], vy = Velocity.y[eid];
        const sp = Math.hypot(vx, vy) || 1;
        const max = x.def.maxSpeed ?? 40;
        const nsp = Math.min(max, sp + (x.def.accel ?? 0.5));
        let ang = Math.atan2(vy, vx);
        if (alive) {
          // Lead the target a little
          const lead = Math.min(30, Math.hypot(Position.x[t] - Position.x[eid], Position.y[t] - Position.y[eid]) / Math.max(1, nsp));
          const want = Math.atan2(Position.y[t] + Velocity.y[t] * lead - Position.y[eid], Position.x[t] + Velocity.x[t] * lead - Position.x[eid]);
          let d = want - ang;
          while (d > Math.PI) d -= 2 * Math.PI;
          while (d < -Math.PI) d += 2 * Math.PI;
          ang += Math.max(-x.def.homing, Math.min(x.def.homing, d));
        }
        vx = Math.cos(ang) * nsp; vy = Math.sin(ang) * nsp;
        Velocity.x[eid] = vx; Velocity.y[eid] = vy;
      }
      if (x.def.pull) {
        // A collapsing star: everything nearby is dragged in, harder the closer it is
        const px = Position.x[eid], py = Position.y[eid], r = x.def.pull.radius;
        for (const [other, s] of this.ships.bodies) {
          if (other === x.owner || InSystem.systemId[other] !== InSystem.systemId[eid] || s.kind === 'debris') continue;
          const dx = px - Position.x[other], dy = py - Position.y[other];
          const d = Math.hypot(dx, dy);
          if (d > r || d < 1) continue;
          const k = x.def.pull.strength * (1 - d / r) * (1 - d / r) * 2;
          if (this.host.nudge) this.host.nudge(other, (dx / d) * k, (dy / d) * k);
        }
      }
      if (x.def.fuse) {
        // Burst when the hull of anything we may hit comes within fuse range (its real outline: a boss's centre is far inside it)
        const near = this.ships.nearestTarget(x.owner, Position.x[eid], Position.y[eid], x.def.fuse, undefined, true);
        if (near >= 0 && this.host.tick() - Projectile.spawnTick[eid] > 4) {
          this.detonate(eid, Position.x[eid], Position.y[eid]);
          this.host.remove(eid);
        }
      }
    }
  }

  /** The shot hit a ship: true when it's spent (piercing shots carry on) */
  onShipHit(proj: number, hit: { eid: number; x: number; y: number; part?: number }): boolean {
    const x = this.extras.get(proj);
    if (!x) return true;
    if (x.def.frost) this.ships.frostHit(hit.eid, x.def.frost.perHit, x.def.frost.ticks);
    if (x.def.chain) this.chain(proj, x, hit);
    if (x.def.ignite) {
      const ig = x.def.ignite;
      const part = this.ships.ignite(hit.eid, hit.x, hit.y, ig.dps * x.damageScale, ig.ticks, ig.radius, x.owner, this.hitOf(proj), hit.part ?? -1);
      if (part >= 0) this.host.broadcast(InSystem.systemId[proj], { type: 'ignite', bodyId: hit.eid, part, ticks: ig.ticks });
    }
    if (x.pierceLeft > 0) {
      x.pierceLeft--;
      x.hit.add(hit.eid);
      Projectile.damage[proj] *= x.def.pierceKeep ?? 0.75;
      if (x.def.pierceKeep !== undefined) this.host.broadcast(InSystem.systemId[proj], { type: 'detonation', kind: x.kind, x: Math.round(hit.x), y: Math.round(hit.y), radius: 40 });
      return false;
    }
    if (x.def.split) this.shatter(proj, x, hit);
    this.detonate(proj, hit.x, hit.y);
    return true;
  }

  /** The shot hit a mob (Mobs.ts, which took its damage): true when it's spent */
  onMobHit(proj: number, x: number, y: number): boolean {
    const e = this.extras.get(proj);
    if (!e) return true;
    if (e.pierceLeft > 0) { e.pierceLeft--; Projectile.damage[proj] *= e.def.pierceKeep ?? 0.75; return false; }
    this.detonate(proj, x, y);
    return true;
  }

  /** The shot flew into rock (a surface's terrain): it bursts there */
  onWallHit(proj: number, x: number, y: number): void {
    if (this.extras.has(proj)) this.detonate(proj, x, y);
  }

  /** The shot ran out of life: flak and EMP burst anyway, missiles fizzle with a bang */
  onExpire(proj: number): void {
    const x = this.extras.get(proj);
    if (x && (x.def.splash || x.def.emp)) this.detonate(proj, Position.x[proj], Position.y[proj]);
  }

  /** Lightning leaps from what it hit to the nearest ships it may hurt, weaker each time */
  private chain(proj: number, x: Extra, hit: { eid: number; x: number; y: number }): void {
    const c = x.def.chain!, sys = InSystem.systemId[proj];
    const struck = new Set([hit.eid, x.owner]);
    let from: [number, number] = [hit.x, hit.y], dmg = Projectile.damage[proj];
    for (let i = 0; i < c.count; i++) {
      // (Nearest by its hull, and it strikes the part nearest where it leapt from: not the ship's centre, which on a boss is nowhere near a part)
      const next = this.ships.nearestTarget(x.owner, from[0], from[1], c.radius, (o) => !struck.has(o), true);
      if (next < 0) break;
      struck.add(next);
      dmg *= c.falloff;
      const at = this.ships.nearestPartPoint(next, from[0], from[1]);
      const to: [number, number] = at ? [at[0], at[1]] : [Position.x[next], Position.y[next]];
      this.ships.splashAt(sys, to[0], to[1], 30, dmg, x.owner, this.hitOf(proj));
      this.host.broadcast(sys, { type: 'detonation', kind: 'arc', x: Math.round(to[0]), y: Math.round(to[1]), radius: 30, from: [Math.round(from[0]), Math.round(from[1])] });
      from = to;
    }
  }

  /** A prism bolt breaks into a fan of shards carrying on past what it hit */
  private shatter(proj: number, x: Extra, hit: { eid: number; x: number; y: number }): void {
    const sp = x.def.split!;
    const heading = Math.atan2(Velocity.y[proj], Velocity.x[proj]);
    const arc = (sp.arc * Math.PI) / 180;
    for (let i = 0; i < sp.count; i++) {
      const a = heading + arc * ((sp.count > 1 ? i / (sp.count - 1) : 0.5) - 0.5);
      const shard = this.spawn(x.owner, sp.kind, hit.x + Math.cos(a) * 8, hit.y + Math.sin(a) * 8, a, x.damageScale, { speedScale: 1, sizeScale: 1, turret: false, noBurst: true });
      this.extras.get(shard)?.hit.add(hit.eid);
    }
  }

  private detonate(proj: number, px: number, py: number): void {
    const x = this.extras.get(proj);
    if (!x) return;
    this.extras.delete(proj);
    const num = InSystem.systemId[proj];
    if (x.def.splash) this.ships.splashAt(num, px, py, x.def.splash.radius, x.def.splash.damage * x.damageScale, x.owner, weaponHit(x.kind, x.def, Projectile.tier[proj] || 1));
    if (x.def.emp) this.ships.empAt(num, px, py, x.def.emp.radius, x.def.emp.ticks, x.owner);
    const radius = x.def.splash?.radius ?? x.def.emp?.radius ?? 40;
    this.host.broadcast(num, { type: 'detonation', kind: x.kind, x: Math.round(px), y: Math.round(py), radius });
  }
}
