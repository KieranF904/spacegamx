/**
 * Ship weapon projectiles: spawning each kind (data/ships/tuning.json
 * weapons) and what it does in flight.
 *   cannon   a plain shell
 *   railgun  very fast, passes through `pierce` bodies before stopping
 *   flak     bursts at the aim distance (endAtAim), or sooner on its proximity fuse near a target; splash damage
 *   missile  accelerates and homes on its lock; splash damage on impact
 *   emp      proximity fuse: an EMP burst that knocks out engines and guns
 * Legendary (boss) weapons:
 *   hive          a burst of small homing missiles
 *   cinder_bloom  incendiary: the part hit burns, and the fire spreads
 *   prism         shatters on impact into a fan of shards
 *   phase         pierces ships without losing damage
 *   singularity   a slow collapsing star: drags ships in, then implodes
 * Shot behaviours any kind may switch on (common/src/ships/features/weaponry): endAtAim (bursts or splits at the aim
 * distance, the mortar's maths), walk (a salvo landing along the aim: the bridge spaces its shells), guided (steers to
 * the cursor while the trigger is held).
 * Beam weapons (laser, lance, frostbite) are continuous and live in the ship bridge.
 *
 * A weapon modifier's shell that shares its hit between the hulls it goes through (tuning.ts pierceFracs: pierce, wave)
 * does at every one of them what it does at its last (docs/design/weapon-modifiers-2026-11.md, Combos): its blast where
 * it goes in and again where it comes out, each of that hull's share; its fire on every hull, as hot as that hull's
 * share against the first's; its arcs, never to a ship that shot has struck already; and one that breaks into shards
 * breaks once, at its first. A shell without pierceFracs does none of this: it hits and says what it always did.
 *
 * A Burn modifier's fire (tuning.ts ignite.fire, .layers, .blast, .arc; the design doc's Burn: spreading fire) spreads
 * over the hull (the bridge's burn step, common ships/fire.ts), and works with the shell's other effects: a sharing
 * shell lights `layers` parts along its line into each hull (lightLayers), a blast lights parts it reaches (fireBlast),
 * an arc lights what it strikes (chain). A fire without those fields (magma's, the Cinder Bloom's) is as it always was.
 */

import { addEntity, addComponent, hasComponent, entityExists, IWorld } from 'bitecs';
import {
  Position, Velocity, Radius, Projectile, Bullet, Lifetime, InSystem, NetworkSync, OwnedBy, Dead,
  ShipTuning, WeaponTuning, WEAPON_KIND_TYPE, ServerMessage, interceptHits, mulberry32, hashString, weaponDef, gunDef, launchShot, volleyAngles, burstShareOf, shellGunCode, weaponHit, type WeaponMods, type GunFx, type HitInfo,
  endsAtAim, lifeToReach, steerToward, bursts, hitEndFx, pierceKeepOf, shellAmount, shellVs, passShare, exitHeading,
  GUIDE, PLAN_NONE, PLAN_WP, guideKind, guideLost, guideTick, newGuide, qGuide, wpArgs, type Guide, type GuideBody,
  Player, PULL_FIELD,
} from '@space-game/common';
import type { ShipBridge } from '../ships/ShipBridge.js';
import { datan2, dcos, dhypot, dsin, arcRadius } from '@space-game/common';
import { SimPass } from '../sim/SystemClocks.js';

export interface WeaponsHost {
  readonly world: IWorld;
  tick(): number;
  broadcast(systemNum: number, msg: ServerMessage): void;
  /** Push a ship (gravity pulls); skips ships that can't be moved */
  nudge?(eid: number, ax: number, ay: number): void;
  remove(eid: number): void;
  /** Mining yield and hardness for a weapon's shots (asteroids) */
  miningTool(kind: string, turret: boolean): { yield: number; hardness: number };
  /**
   * What a shell's hit on a ship sets off that a client can work out itself (its fire, a pierce pass's flash, its end's
   * burst): confirmed hits (net/hits/HitLedger.ts) take it, and send it on to whoever still needs telling. False:
   * broadcast it as ever
   */
  hitFx?(proj: number, msg: ServerMessage): boolean;
  /**
   * A homing shell's guide record at this tick (common guidance/records.ts GUIDE: WP, NEXT, LOST): CAPS.WAYPOINTS
   * clients that lack its target take them (net/guides/GuideNet.ts)
   */
  guided?(proj: number, tick: number, op: number, args: number[]): void;
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
  /** A homing shell's guidance (common guidance/waypoints.ts: the scheduled-waypoint law, the same on its clients) */
  guide?: Guide;
  /** A shell that breaks into shards: its gun's weapon modifier effects and the shot's mask of them, for its shards to carry */
  gunFx?: readonly GunFx[];
  fx?: number;
  /** It has broken into its shards (a shell that goes on through hulls breaks once, at its first) */
  shattered?: boolean;
  /** A sharing shell's blasts owed where it comes out of the hulls it is in: the point, and that hull's share */
  exits?: { x: number; y: number; share: number }[];
  /** A sharing shell's arcs: every ship that shot has struck, by itself or an arc (its owner too) */
  struck?: Set<number>;
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
    shape: { speedScale: number; sizeScale: number; turret: boolean; target?: number; noBurst?: boolean; seed?: string; index?: number; mods?: WeaponMods; dry?: boolean; ammoMods?: WeaponMods; reach?: number; grade?: number; size?: number; model?: WeaponMods; intercept?: boolean; gun?: number; gunFx?: readonly GunFx[]; fx?: number; child?: boolean }, out?: number[]): number {
    const w = this.host.world;
    // The gun's own mods (gems), then its ammunition's, its grade's and its size's: the same as the pilot's client builds the shells from (launch.ts gunDef)
    // (and the shot's weapon modifier effects, last: `fx`, a mask over the gun's own `gunFx`; `child`: a shard, which carries its gun's)
    const full = gunDef(this.tuning, kind, { mods: shape.mods, ammo: shape.ammoMods, grade: shape.grade, size: shape.size, model: shape.model, gunFx: shape.gunFx, fx: shape.fx, child: shape.child });
    // A plain round (out of ammunition): the same shell, none of its effects (and no fuse: with nothing to burst, it has to hit)
    const def = shape.dry ? { ...full, splash: undefined, emp: undefined, ignite: undefined, split: undefined, pull: undefined, pierce: 0, pierceFracs: undefined, fuse: undefined, bane: undefined } : full;
    // A burst: the rest of the volley, fanned out (the main shell is the volley's last)
    let index = shape.index ?? 0;
    if ((def.burst ?? 1) > 1 && !shape.noBurst) {
      const angles = volleyAngles(def, angle);
      // (a split's shells share the shot by their place: launch.ts burstShareOf, 1 for any other burst)
      for (let i = 0; i < angles.length - 1; i++) this.spawn(owner, kind, x, y, angles[i], damageScale * burstShareOf(def, i), { ...shape, noBurst: true, index: i }, out);
      index = angles.length - 1;
      if (def.burstShare) damageScale *= burstShareOf(def, index);
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
    Projectile.damage[eid] = shellAmount(def, damageScale);
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
    // A shell that ends at the aim (a lobbed one, an aim burst, a walking salvo's) comes down or bursts where it was aimed
    const ends = endsAtAim(def) && !!shape.reach;
    Lifetime.remaining[eid] = ends ? lifeToReach(shot.life, shot.speed, shape.reach!) : shot.life;
    // (a held orb stops there, endTick the tick it does, and lives `hold` ticks more)
    if (ends && def.hold) Lifetime.remaining[eid] += def.hold;
    const stopAt = ends && def.hold ? this.host.tick() + Lifetime.remaining[eid] - def.hold : 0;
    // (and everyone is told when: projectile row data[9], in spawn + velocity × age terms)
    Projectile.endTick[eid] = stopAt || (ends ? this.host.tick() + Lifetime.remaining[eid] : 0);
    // (The gun that fired it, as its fire event packs it: a client works out its hits from that, confirmed hits)
    Projectile.gun[eid] = shellGunCode(shape.gun ?? -1, def, index);
    InSystem.systemId[eid] = InSystem.systemId[owner];
    OwnedBy.ownerId[eid] = owner;
    // (A plain cannon shell has nothing to track: one with a grade's or a gem's changes does)
    if (kind !== 'cannon' || def !== this.def(kind)) {
      // (Point defence may shoot it down if its kind can be, unless it's told not (a boss's nova): support.ts)
      this.extras.set(eid, { kind, def, owner, target: shape.target ?? -1, pierceLeft: def.pierce ?? 0, hit: new Set(), damageScale, sizeScale: shot.size, intercept: shape.intercept === false ? 0 : interceptHits(def) });
      // (a shell that breaks up hands its effects on to its shards: shatter)
      if (def.split && shape.fx) { const e = this.extras.get(eid)!; e.gunFx = shape.gunFx; e.fx = shape.fx; }
      // A homing shell flies by the waypoint law, its state on the law's grid so its clients can fly it exactly
      if (def.homing && !def.guided) {
        Position.x[eid] = qGuide(x); Position.y[eid] = qGuide(y);
        Velocity.x[eid] = qGuide(shot.vx); Velocity.y[eid] = qGuide(shot.vy);
        this.extras.get(eid)!.guide = newGuide(shape.target ?? -1, guideKind(def.homing, def.accel ?? 0.5, def.maxSpeed ?? 40));
      }
    }
    out?.push(eid);
    return eid;
  }

  /** Lobbed shells fly over everything until they come down */
  lobbed(proj: number): boolean {
    return !!this.extras.get(proj)?.def.lob;
  }

  /** A ghost round (the Phase Cannon's) flies through rock and asteroids: only ships stop it */
  ghost(proj: number): boolean {
    return !!this.extras.get(proj)?.def.ghost;
  }

  /** An unarmed shell (its `arm` ticks not yet up) flies through ships and rock */
  unarmed(proj: number): boolean {
    const arm = this.extras.get(proj)?.def.arm;
    return !!arm && this.host.tick() - Projectile.spawnTick[proj] < arm;
  }

  /** A shot's damage against shields and hull, if its weapon has its own, what it hits with (damage.ts), and the faction its ammunition is made for */
  vsOf(proj: number): { shield?: number; hull?: number; hit?: HitInfo; bane?: { faction: string; damage: number } } {
    const x = this.extras.get(proj);
    // (common hitRules.ts shellVs: what a client works it out from too; a plain cannon shell keeps no extras)
    return x ? shellVs(x.kind, x.def, Projectile.tier[proj] || 1) : { hit: this.hitOf(proj) };
  }

  /** What a shot hits with: its weapon's damage type, and the gun's grade plus its penetration */
  hitOf(proj: number): HitInfo {
    const x = this.extras.get(proj);
    return weaponHit(x?.kind ?? 'cannon', x?.def ?? this.def('cannon'), Projectile.tier[proj] || 1);
  }

  /** Mining charge: the ticks it stays stuck in rock before it blows (0: it doesn't stick) */
  stickTicks(proj: number): number {
    return this.extras.get(proj)?.def.stick?.ticks ?? 0;
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
      // (Its system's pass: crowd dilation, sim/SystemClocks.ts)
      if (!SimPass.on(InSystem.systemId[eid])) continue;
      if (x.exits?.length) this.exited(eid, x, Position.x[eid], Position.y[eid]);
      if (x.def.guided) this.guide(eid, x);
      else if (x.guide) this.home(eid, x.guide);
      // A held orb parks where it was aimed (its endTick) and pulls from there
      const parked = !!x.def.hold && this.host.tick() >= Projectile.endTick[eid];
      if (parked) { Velocity.x[eid] = 0; Velocity.y[eid] = 0; }
      if (x.def.pull && (!x.def.hold || parked)) {
        // A collapsing star: everything nearby is dragged in, harder the closer it is
        const px = Position.x[eid], py = Position.y[eid], r = x.def.pull.radius;
        // (Parked, it pulls from a fixed point: on pilots a field their steps work out from the next tick, as their
        // clients' do (common sim/pullFields.ts STAR). A shell on the move (a Grapple gem's) is pushed: the server's alone)
        const field = !!x.def.hold;
        if (field) this.ships.pulls.declare(eid, 'star', { kind: PULL_FIELD.STAR, target: -1, skip: x.owner, a: [px, py, r, x.def.pull.strength], until: this.host.tick() + Lifetime.remaining[eid] }, this.host.tick());
        for (const [other, s] of this.ships.bodies) {
          if (other === x.owner || InSystem.systemId[other] !== InSystem.systemId[eid] || s.kind === 'debris') continue;
          if (field && hasComponent(w, Player, other)) continue;
          const dx = px - Position.x[other], dy = py - Position.y[other];
          const d = dhypot(dx, dy);
          if (d > r || d < 1) continue;
          const k = x.def.pull.strength * (1 - d / r) * (1 - d / r) * 2;
          if (this.host.nudge) this.host.nudge(other, (dx / d) * k, (dy / d) * k);
        }
      }
      if (x.def.fuse) {
        // Burst when the hull of anything we may hit comes within fuse range (its real outline: a boss's centre is far inside it)
        const near = this.ships.nearestTarget(x.owner, Position.x[eid], Position.y[eid], x.def.fuse, undefined, true);
        if (near >= 0 && this.host.tick() - Projectile.spawnTick[eid] > 4) {
          // (a splitting shell splits on its fuse too)
          if (x.def.split && !x.shattered) this.shatter(eid, x, null);
          this.detonate(eid, Position.x[eid], Position.y[eid]);
          this.host.remove(eid);
        }
      }
    }
  }

  private readonly gm: GuideBody = { x: 0, y: 0, vx: 0, vy: 0 };
  private readonly gt: GuideBody = { x: 0, y: 0, vx: 0, vy: 0 };

  /**
   * A homing shell's tick (common guidance/waypoints.ts): its waypoints planned from its target as it is now (a pilot
   * after its step, anything else as it ended the last tick), and steered on; what the planner did goes to its clients
   */
  private home(eid: number, g: Guide): void {
    const t = g.target, tick = this.host.tick();
    const alive = t >= 0 && this.ships.has(t) && InSystem.systemId[t] === InSystem.systemId[eid];
    const m = this.gm, tg = this.gt;
    m.x = Position.x[eid]; m.y = Position.y[eid]; m.vx = Velocity.x[eid]; m.vy = Velocity.y[eid];
    if (t >= 0 && !alive) { guideLost(g); this.host.guided?.(eid, tick, GUIDE.LOST, []); }
    if (alive) { tg.x = Position.x[t]; tg.y = Position.y[t]; tg.vx = Velocity.x[t]; tg.vy = Velocity.y[t]; }
    const did = guideTick(g, eid, m, alive ? tg : null, tick);
    if (did !== PLAN_NONE) this.host.guided?.(eid, tick, did === PLAN_WP ? GUIDE.WP : GUIDE.NEXT, wpArgs(did === PLAN_WP ? g.w! : g.n!, m));
    Velocity.x[eid] = m.vx; Velocity.y[eid] = m.vy;
  }

  /** A homing shell's guidance and where it is (null: not one, or gone): CAPS.WAYPOINTS clients are synced from this */
  guideOf(eid: number): Guide | null {
    return this.extras.get(eid)?.guide ?? null;
  }

  /** Every homing shell flying by the waypoint law (GuideNet's sources) */
  *guided(): IterableIterator<[number, Guide]> {
    for (const [eid, x] of this.extras) if (x.guide) yield [eid, x.guide];
  }

  /** A homing shell's motion (null: not one, or gone) */
  guideBody(eid: number): GuideBody | null {
    const w = this.host.world;
    return this.extras.get(eid)?.guide && entityExists(w, eid) && !hasComponent(w, Dead, eid) ? { x: Position.x[eid], y: Position.y[eid], vx: Velocity.x[eid], vy: Velocity.y[eid] } : null;
  }

  /** The tick it was fired (an id reused is another shell) */
  guideBorn(eid: number): number {
    return Projectile.spawnTick[eid];
  }

  /** The shot hit a ship: true when it's spent (piercing shots carry on) */
  onShipHit(proj: number, hit: { eid: number; x: number; y: number; part?: number }): boolean {
    const x = this.extras.get(proj);
    if (!x) return true;
    // (a sharing shell, tuning.ts pierceFracs: see the header. `passes`: the hulls and mobs it went through before this one)
    const shared = !!x.def.pierceFracs, passes = (x.def.pierce ?? 0) - x.pierceLeft;
    if (x.exits) this.exited(proj, x, hit.x, hit.y);
    if (x.def.frost) this.ships.frostHit(hit.eid, x.def.frost.perHit, x.def.frost.ticks);
    if (x.def.chain) this.chain(proj, x, hit);
    // (its fire: a sharing shell's on every hull, as hot as this hull's share against its first's)
    if (x.def.ignite) {
      const ig = x.def.ignite, dps = ig.dps * x.damageScale * (shared ? passShare(x.def, passes) / (passShare(x.def, 0) || 1) : 1);
      const part = this.ships.ignite(hit.eid, hit.x, hit.y, dps, ig.ticks, ig.radius, x.owner, this.hitOf(proj), hit.part ?? -1, -1, ig.fire);
      if (part >= 0) this.atHit(proj, ig.fire ? { type: 'ignite', bodyId: hit.eid, part, ticks: ig.ticks, gen: 1 } : { type: 'ignite', bodyId: hit.eid, part, ticks: ig.ticks });
      if (part >= 0 && (ig.layers ?? 1) > 1) this.lightLayers(proj, x, hit, part, dps);
    }
    if (x.pierceLeft > 0) {
      x.pierceLeft--;
      x.hit.add(hit.eid);
      this.passed(proj, x);
      if (shared) {
        if (x.def.split && !x.shattered) { x.shattered = true; this.shatter(proj, x, hit); }
        if (x.def.splash) this.blastIn(proj, x, hit.x, hit.y, passShare(x.def, passes), this.exitOf(proj, hit));
      }
      const fx = hitEndFx(x.kind, x.def, false);
      if (fx) this.atHit(proj, { type: 'detonation', kind: fx.kind, x: Math.round(hit.x), y: Math.round(hit.y), radius: fx.radius });
      return false;
    }
    if (x.def.split && !x.shattered) this.shatter(proj, x, hit);
    this.detonate(proj, hit.x, hit.y, false, true);
    return true;
  }

  /**
   * A Burn modifier's shell that goes on through hulls lights the parts its line meets behind the one it struck: the
   * struck part and the next ones in, `layers` in all, each deeper one cooler (the bridge's igniteLayers, by the cast
   * that finds where it comes out: exitOf)
   */
  private lightLayers(proj: number, x: Extra, hit: { eid: number; x: number; y: number }, struck: number, dps: number): void {
    const ig = x.def.ignite!, ship = this.ships.get(hit.eid);
    if (!ship) return;
    const vx = Velocity.x[proj], vy = Velocity.y[proj], sp = dhypot(vx, vy) || 1, far = 2 * (ship.derived.radius + 2 + Radius.value[proj]);
    this.ships.igniteLayers(hit.eid, hit.x, hit.y, hit.x + (vx / sp) * far, hit.y + (vy / sp) * far, struck, ig.layers!, ig.layerKeep ?? 1, dps, ig.ticks, ig.radius, x.owner, this.hitOf(proj), ig.fire);
  }

  /** A Burn modifier's shell with a blast: the parts the blast reaches may catch, each a cooler fire of `share` of the shell's (the bridge's blastIgnite) */
  private fireBlast(proj: number, x: Extra, px: number, py: number, share: number): void {
    const ig = x.def.ignite, by = ig?.blast, sp = x.def.splash;
    if (!ig || !by || !sp) return;
    this.ships.blastIgnite(InSystem.systemId[proj], px, py, sp.radius, by, ig.dps * x.damageScale * share * by.scale, ig.ticks, x.owner, weaponHit(x.kind, x.def, Projectile.tier[proj] || 1), ig.fire);
  }

  /**
   * A sharing shell with a blast goes into a hull or a mob: its blast there, of that body's share (its radius as ever),
   * and the same owed at `exit`, where it comes out the far side (exited sets it off once the shell is past it)
   */
  private blastIn(proj: number, x: Extra, hx: number, hy: number, share: number, exit: [number, number]): void {
    const sp = x.def.splash!;
    this.ships.splashAt(InSystem.systemId[proj], hx, hy, sp.radius, sp.damage * x.damageScale * share, x.owner, this.hitOf(proj));
    this.fireBlast(proj, x, hx, hy, share);
    (x.exits ??= []).push({ x: exit[0], y: exit[1], share });
  }

  /**
   * Where a shell that struck a hull at (hit.x, hit.y) comes out of it: its line on from there, cast back at the hull
   * as it stands now (after the hit) from beyond its far side; the first part that meets is the last it leaves. Worked
   * out once, at the hit, and fixed in space (the hull's drift while the shell crosses it is not followed). Nothing
   * left standing on its line (the part it struck was all there was): where it went in
   */
  private exitOf(proj: number, hit: { eid: number; x: number; y: number }): [number, number] {
    const ship = this.ships.get(hit.eid);
    if (!ship) return [hit.x, hit.y];
    const vx = Velocity.x[proj], vy = Velocity.y[proj], sp = dhypot(vx, vy) || 1;
    const far = 2 * (ship.derived.radius + 2 + Radius.value[proj]);
    const fx = hit.x + (vx / sp) * far, fy = hit.y + (vy / sp) * far;
    const h = this.ships.segmentHit(hit.eid, ship, fx, fy, hit.x, hit.y);
    return h ? [fx + (hit.x - fx) * h.t, fy + (hit.y - fy) * h.t] : [hit.x, hit.y];
  }

  /** The same for a mob (a circle): the far end of the shell's chord through it */
  private exitOfMob(proj: number, mob: number, hx: number, hy: number): [number, number] {
    const vx = Velocity.x[proj], vy = Velocity.y[proj], sp = dhypot(vx, vy) || 1, ux = vx / sp, uy = vy / sp;
    const wx = Position.x[mob] - hx, wy = Position.y[mob] - hy, along = wx * ux + wy * uy;
    const half2 = Radius.value[mob] * Radius.value[mob] - (wx * wx + wy * wy - along * along);
    const d = half2 > 0 ? Math.max(0, along + Math.sqrt(half2)) : 0;
    return [hx + ux * d, hy + uy * d];
  }

  /**
   * The exit blasts a sharing shell owes (blastIn) that it has reached by (px, py): each goes off there, of its hull's
   * share, and everyone is told with the shell's heading (`out`: a detonation that is an exit). One it never reaches
   * (the shell ended inside that hull) is never set off
   */
  private exited(proj: number, x: Extra, px: number, py: number): void {
    const ex = x.exits!, sp = x.def.splash!, vx = Velocity.x[proj], vy = Velocity.y[proj], sys = InSystem.systemId[proj];
    for (let i = 0; i < ex.length;) {
      const e = ex[i];
      if ((px - e.x) * vx + (py - e.y) * vy < 0) { i++; continue; }
      ex.splice(i, 1);
      this.ships.splashAt(sys, e.x, e.y, sp.radius, sp.damage * x.damageScale * e.share, x.owner, this.hitOf(proj));
      this.fireBlast(proj, x, e.x, e.y, e.share);
      this.host.broadcast(sys, { type: 'detonation', kind: x.kind, x: Math.round(e.x), y: Math.round(e.y), radius: sp.radius, out: exitHeading(vx, vy) });
    }
  }

  /** A piercing shell went through something (its pierceLeft counted down): what it carries on with (hitRules.ts shellAmount) */
  private passed(proj: number, x: Extra): void {
    if (x.def.pierceFracs) Projectile.damage[proj] = shellAmount(x.def, x.damageScale, (x.def.pierce ?? 0) - x.pierceLeft);
    else Projectile.damage[proj] *= pierceKeepOf(x.def);
  }

  /**
   * The shot hit a mob (Mobs.ts, which took its damage): true when it's spent. A sharing shell (see the header) arcs
   * on from it and blasts where it goes in and comes out, as at a hull, and does not strike it again (`mob` joins
   * its exclusions); a mob has nothing that burns, so its fire does nothing here
   */
  onMobHit(proj: number, x: number, y: number, mob = -1): boolean {
    const e = this.extras.get(proj);
    if (!e) return true;
    const shared = !!e.def.pierceFracs && mob >= 0, passes = (e.def.pierce ?? 0) - e.pierceLeft;
    if (shared) {
      if (e.exits) this.exited(proj, e, x, y);
      if (e.def.chain) this.chain(proj, e, { eid: mob, x, y });
    }
    if (e.pierceLeft > 0) {
      e.pierceLeft--;
      this.passed(proj, e);
      if (shared) {
        e.hit.add(mob);
        if (e.def.split && !e.shattered) { e.shattered = true; this.shatter(proj, e, { eid: mob, x, y }); }
        if (e.def.splash) {
          this.blastIn(proj, e, x, y, passShare(e.def, passes), this.exitOfMob(proj, mob, x, y));
          // (no hit record goes with a mob's: the blast where it went in is told to everyone)
          this.host.broadcast(InSystem.systemId[proj], { type: 'detonation', kind: e.kind, x: Math.round(x), y: Math.round(y), radius: e.def.splash.radius });
        }
      }
      return false;
    }
    this.detonate(proj, x, y);
    return true;
  }

  /** The shot flew into rock (a surface's terrain): it bursts there */
  onWallHit(proj: number, x: number, y: number): void {
    if (this.extras.has(proj)) this.detonate(proj, x, y);
  }

  /** The shot ran out of life: flak and EMP burst anyway, missiles fizzle with a bang; one that ends at the aim splits there (a Prism's) */
  onExpire(proj: number): void {
    const x = this.extras.get(proj);
    if (!x) return;
    const split = !!x.def.split && endsAtAim(x.def) && Projectile.endTick[proj] > 0;
    if (split && !x.shattered) this.shatter(proj, x, null);
    // (A shell that came down at its aim is overhead: what covers a buried part takes the brunt, damage.ts overheadShare)
    if (split || x.def.splash || x.def.emp) this.detonate(proj, Position.x[proj], Position.y[proj], endsAtAim(x.def) && Projectile.endTick[proj] > 0);
  }

  private readonly steer = { x: 0, y: 0 };

  /**
   * A guided shell (weaponry guided): it speeds up as a missile does, and while its gun's trigger is held it turns
   * toward the cursor (the owner's aim this tick, ShipBridge.guideOf); let go (or its ship gone), it flies straight
   */
  private guide(eid: number, x: Extra): void {
    const vx = Velocity.x[eid], vy = Velocity.y[eid];
    const sp = dhypot(vx, vy) || 1;
    const nsp = Math.min(x.def.maxSpeed ?? x.def.speed ?? 40, sp + (x.def.accel ?? 0));
    const g = this.ships.guideOf(x.owner, this.host.tick());
    if (g && g.held) steerToward(Position.x[eid], Position.y[eid], vx, vy, g.x, g.y, x.def.guided!.turn, this.steer);
    else { this.steer.x = vx / sp; this.steer.y = vy / sp; }
    Velocity.x[eid] = this.steer.x * nsp;
    Velocity.y[eid] = this.steer.y * nsp;
  }

  /** Lightning leaps from what it hit to the nearest ships it may hurt, weaker each time */
  private chain(proj: number, x: Extra, hit: { eid: number; x: number; y: number }): void {
    const c = x.def.chain!, sys = InSystem.systemId[proj];
    // (a sharing shell arcs from every hull it goes through: never to a ship that shot has struck already, itself or by an arc)
    const struck = x.def.pierceFracs ? (x.struck ??= new Set([x.owner])).add(hit.eid) : new Set([hit.eid, x.owner]);
    let from: [number, number] = [hit.x, hit.y], dmg = Projectile.damage[proj], heat = 1;
    const ig = x.def.ignite;
    for (let i = 0; i < c.count; i++) {
      // (Nearest by its hull, and it strikes the part nearest where it leapt from: not the ship's centre, which on a boss is nowhere near a part)
      const next = this.ships.nearestTarget(x.owner, from[0], from[1], c.radius, (o) => !struck.has(o), true);
      if (next < 0) break;
      struck.add(next);
      dmg *= c.falloff;
      const at = this.ships.nearestPartPoint(next, from[0], from[1]);
      const to: [number, number] = at ? [at[0], at[1]] : [Position.x[next], Position.y[next]];
      this.ships.splashAt(sys, to[0], to[1], 30, dmg, x.owner, this.hitOf(proj));
      // (a Burn modifier's arc lights what it strikes, as hot as the arc's share of the shot)
      if (ig?.arc) { heat *= c.falloff; this.ships.igniteTold(next, to[0], to[1], ig.dps * x.damageScale * heat * ig.arc, ig.ticks, ig.radius, x.owner, this.hitOf(proj), -1, -1, ig.fire); }
      this.host.broadcast(sys, { type: 'detonation', kind: 'arc', x: Math.round(to[0]), y: Math.round(to[1]), radius: arcRadius(c.fx), from: [Math.round(from[0]), Math.round(from[1])] });
      from = to;
    }
  }

  /** A prism bolt breaks into a fan of shards carrying on past what it hit */
  private shatter(proj: number, x: Extra, hit: { eid: number; x: number; y: number } | null): void {
    const sp = x.def.split!;
    const heading = datan2(Velocity.y[proj], Velocity.x[proj]);
    const arc = (sp.arc * Math.PI) / 180;
    for (let i = 0; i < sp.count; i++) {
      const a = heading + arc * ((sp.count > 1 ? i / (sp.count - 1) : 0.5) - 0.5);
      // (where it broke: what it hit, or where it burst at the aim)
      const px = hit ? hit.x : Position.x[proj], py = hit ? hit.y : Position.y[proj];
      // (its shards carry the gun's weapon modifier effects, all but rapid and split: fxDef's `child`; a gun without fires the shards it always did)
      const shard = this.spawn(x.owner, sp.kind, px + dcos(a) * 8, py + dsin(a) * 8, a, x.damageScale, x.fx ? { speedScale: 1, sizeScale: 1, turret: false, noBurst: true, gunFx: x.gunFx, fx: x.fx, child: true } : { speedScale: 1, sizeScale: 1, turret: false, noBurst: true });
      if (hit) this.extras.get(shard)?.hit.add(hit.eid);
    }
  }

  /** What a shell's hit on a ship sets off, that a client may work out itself (WeaponsHost.hitFx), else broadcast */
  private atHit(proj: number, msg: ServerMessage): void {
    if (!this.host.hitFx?.(proj, msg)) this.host.broadcast(InSystem.systemId[proj], msg);
  }

  private detonate(proj: number, px: number, py: number, overhead = false, atHit = false): void {
    const x = this.extras.get(proj);
    if (!x) return;
    if (x.exits) this.exited(proj, x, px, py);
    this.extras.delete(proj);
    const num = InSystem.systemId[proj];
    // (a sharing shell's blast is of the share it carries here, as its hit is: hitRules.ts passShare, 1 for any other)
    if (x.def.splash) this.ships.splashAt(num, px, py, x.def.splash.radius, x.def.splash.damage * x.damageScale * passShare(x.def, (x.def.pierce ?? 0) - x.pierceLeft), x.owner, weaponHit(x.kind, x.def, Projectile.tier[proj] || 1), overhead ? [Projectile.spawnX[proj], Projectile.spawnY[proj]] : undefined);
    if (x.def.splash && x.def.ignite?.blast) this.fireBlast(proj, x, px, py, passShare(x.def, (x.def.pierce ?? 0) - x.pierceLeft));
    if (x.def.emp) this.ships.empAt(num, px, py, x.def.emp.radius, x.def.emp.ticks, x.owner);
    // A plain slug (a Pip's, a Rattler's: nothing bursts, spreads or carries on) says nothing more: clients draw its
    // impact from the projectileHit they get anyway (WeaponFx), so a detonation would only repeat it (39 bytes a hit)
    // (common hitRules.ts hitEndFx: bursts(def) says whether, and the radius)
    const fx = hitEndFx(x.kind, x.def, true);
    if (!fx) return;
    const msg: ServerMessage = { type: 'detonation', kind: fx.kind, x: Math.round(px), y: Math.round(py), radius: fx.radius };
    if (atHit) this.atHit(proj, msg); else this.host.broadcast(num, msg);
  }
}

/** Does a shell of this kind do anything at its end a detonation has to tell? (common hitRules.ts, where it lives) */
export { bursts };
