/**
 * @contract server.enemies
 * owns:       the hostile ships of every system: spawning, the tick, and the public doors to the rules in enemies/*.ts
 * needs:      EnemyHost, ShipBridge, enemies/{model, populations, placement, steering, memory, loot, stationDefence}; npm: @space-game/common
 * events:     BossHooks (Bosses plugs in), EnemyHost.reward/dropLoot/questKill on a kill
 * invariants: tick order: forget the dead, packs, populations, spawners, arrivals, station turrets — server/src/golden/tickOrder.json
 *             a ghost pack place is worked out from the seed and the tick, and its ships load where it is — server/src/game/nests.test.ts
 * extend:     a new area of enemy behaviour is a module in enemies/ taking the Enemies instance, with a door here if public
 *
 * Enemies: hostile ships built from blueprints (data/ships/blueprints/enemy),
 * flown by a simple AI, in packs by faction (data/factions.json).
 *
 * Most live in nests (systems.json `nests`: orbiting homes), and a zone (a
 * ring of a system, or a spot) can have packs of its own: each nest's and
 * zone's packs are a population (below; common world/populations.ts), always
 * there, ship by ship. A pack nobody's near isn't simulated: it's a ghost
 * whose place both ends work out from the seed and the tick, loaded where its
 * ghost is once a pilot comes within rules.nestWake, put back once nobody's
 * near and it isn't fighting. Ships shot down are remembered (through the
 * system being put away and restarts: SystemMemory.ts) and come back one at a
 * time, one every respawnSeconds of their spawner (the heavies' group not
 * until it's rebuilt), time away counting; a loaded pack's come out of the
 * nest's hull. Nest packs guard it close, wander widely round it, or go
 * nomad across the system (Roaming.ts). A system's own `packs` (none in the
 * data now) come in from outside, out of sight of players. Each ship patrols around its pack's home, engages
 * the nearest player in range (closing to its preferred range, then circling
 * and firing), runs when badly hurt (if its faction does), and goes after
 * whoever shoots its pack from wherever they are. It gives up the chase once
 * its target has got well away, or once it's been drawn far past its leash
 * without being shot at again for a while. Armed stations (data/stations.json `defence`, mostly
 * in hostile sectors) have turrets that fire on hostiles near them.
 *
 * Kills pay XP and credits (a share to helpers nearby, a bigger one to the
 * killer's party) and drop a loot pod: the faction's loot table plus a chance
 * of salvaged ship parts. Elites are tougher and drop more.
 *
 * Wards are pilotless ships players are protecting (an escorted freighter, a
 * mining outpost): hostiles go for them as readily as for a pilot.
 */

import { Position, InSystem, Blueprint, ShipState, mulberry32, MAX_GRADE, markName, blueprintGrade, rateShip, ratingOf, createShipState, type Economy, plated, dcos, dhypot, dsin } from '@space-game/common';
import { AiPilots } from './brains/aiPilot.js';
import { Defenders } from './enemies/defenders.js';
import { CustomEnemies } from './custom/CustomEnemies.js';
import type { Mobs } from './Mobs.js';
import { type XY } from './Roaming.js';
import type { ShipBridge, PilotOrders } from '../ships/ShipBridge.js';
import type { Intent, Plan, FarPose } from '../ships/SimLod.js';
import { SimPass } from '../sim/SystemClocks.js';
import { PayoutDice, type Dice } from './payoutDice.js';
import type { SpawnGroup, SpawnNest, SpawnZone, FactionsFile, PackOrigin, EnemyAi, PackMemory, EnemyHost, Behaviour, Enemy, Population, PopRows, PopulationMemory, Pack, BossHooks } from './enemies/model.js';
import * as populations from './enemies/populations.js';
import * as memory from './enemies/memory.js';
import * as placement from './enemies/placement.js';
import * as steering from './enemies/steering.js';
import * as loot from './enemies/loot.js';
import * as stationDefence from './enemies/stationDefence.js';

export type { FactionDef, SpawnNest, SpawnZone, FactionsFile, StationGun, PackOrigin, EnemyMemory, EnemyAi, PackMemory, EnemyHost, Behaviour, PopRows, PopulationMemory, BossHooks } from './enemies/model.js';
export { withZoneSpots, withNests } from './enemies/model.js';

export class Enemies {
  /** @internal shared with enemies/*.ts */
  enemies = new Map<number, Enemy>();
  /** @internal shared with enemies/*.ts */
  packs = new Map<number, Pack>();
  /** @internal shared with enemies/*.ts */
  nextPack = 1;
  /** @internal shared with enemies/*.ts */
  nextSpawn = new Map<number, number>();
  /** When each of a nest's groups may be sent again once a pack of it is wiped out (`${system}:${id}:${group}`: its heavies) */
  /** @internal shared with enemies/*.ts */
  nestLock = new Map<string, number>();
  /** Every system's populations (its nests' and zones' packs, ship by ship), by system number; built on first use */
  /** @internal shared with enemies/*.ts */
  pops: Map<number, Population[]> | null = null;
  /** Time away mends a population's hurt ships by this share of each part's max a minute (SystemMemory's healPerMinute) */
  mendPerMinute = 0.04;
  /** @internal shared with enemies/*.ts */
  rng = mulberry32(0x5eed);
  bosses: BossHooks | null = null;
  /** For salvage: what structure drops as (materials) */
  econ: Economy | null = null;
  /** Pilotless ships hostiles attack like players (escorted freighters, outposts) */
  /** @internal shared with enemies/*.ts */
  wards = new Set<number>();
  /** Each armed station's turrets: the tick each may fire next, and what it's firing on */
  /** @internal shared with enemies/*.ts */
  batteries = new Map<number, { next: number[]; target: number[] }>();

  addWard(eid: number): void {
    this.wards.add(eid);
  }

  removeWard(eid: number): void {
    this.wards.delete(eid);
  }

  /** A pilotless ship that keeps its course but shoots back at whoever hurts it (a freighter: enemies/defenders.ts) */
  defend(eid: number): void {
    this.defenders.add(eid);
  }

  /** Its ships' pilots: the commander's orders flown by the shared pilot body (brains/aiPilot.ts) */
  /** @internal shared with enemies/*.ts */
  readonly pilots: AiPilots;
  /** Custom enemies' pieces and moves (custom/CustomEnemies.ts) */
  readonly custom: CustomEnemies;
  /** Freighters that keep their course but shoot back at whoever hurts them (enemies/defenders.ts), flown by the same pilots */
  readonly defenders: Defenders;
  /** What mines are laid as (set once mobs exist) */
  mobs: Mobs | undefined;
  /**
   * Ships shot down since the last tick (onDestroyed: out of `enemies` at once, so the dead the tick forgets never had
   * them): their pilots' bodies and custom moves forgotten as the tick's dead are, so a client running one is told its
   * OFF at the first tick its moves weren't run (net/decisions/BodyNet.ts ended)
   */
  /** @internal shared with enemies/*.ts */
  readonly destroyed = new Set<number>();

  /** A kill's loot and salvaged parts: payout dice, from the server's secret (payoutDice.ts) */
  /** @internal shared with enemies/*.ts */
  readonly lootDice: Dice;

  /** `payout`: the server's payout dice (GameServer's; none: a secret of its own) */
  constructor(readonly host: EnemyHost, readonly ships: ShipBridge, readonly data: FactionsFile, readonly designs: Record<string, Blueprint>, payout: PayoutDice = new PayoutDice()) {
    this.lootDice = payout.stream('kill loot');
    this.pilots = new AiPilots({
      tick: () => host.tick(), decide: host.decide ? (e, op, args, st) => host.decide!(e, op, args, st) : undefined,
      status: (e) => [ships.empTicksLeft(e), ships.slowedTicksLeft(e)],
    });
    this.defenders = new Defenders({ world: host.world, tick: () => host.tick(), docked: host.docked ? (e) => host.docked!(e) : undefined }, ships, this.pilots);
    const self = this;
    this.custom = new CustomEnemies({
      tick: () => host.tick(), ships, players: (num) => host.players(num), get mobs() { return self.mobs; },
      fire: host.fire ? (o, k, x, y, a, d, opts) => host.fire!(o, k, x, y, a, d, opts) : undefined,
      send: host.send ? (num, msg) => host.send!(num, msg) : undefined,
      moveFx: host.moveFx ? (num, eid, o, msg) => host.moveFx!(num, eid, o, msg) : undefined,
      moveShot: host.moveShot ? (owner, kind, x, y, a, k, speed, seed, o) => host.moveShot!(owner, kind, x, y, a, k, speed, seed, o) : undefined,
      decide: (eid, op, args) => self.pilots.note(eid, op, args),
    }, data.custom);
  }

  /** Is this entity a hostile ship (and of which faction) */
  factionOf(eid: number): string | undefined {
    return this.enemies.get(eid)?.faction;
  }

  info(eid: number): { name: string; faction: string; factionIndex: number; elite: boolean; boss?: string; grade: number; rating: number } | undefined {
    const e = this.enemies.get(eid);
    if (!e) return undefined;
    const base = (e.boss && this.bosses?.name(eid)) || (this.design(e.type, 1)?.name ?? e.type);
    // Above Mk I, the grade is part of the name: a Mk III raider is a different fight
    const name = !e.boss && e.grade > 1 ? `${base} ${markName(e.grade)}` : base;
    return {
      name: e.elite ? `Elite ${name}` : name, faction: e.faction, factionIndex: Object.keys(this.data.factions).indexOf(e.faction),
      elite: e.elite, boss: e.boss, grade: e.grade, rating: e.rating,
    };
  }

  /** What a system's ships are built of (factions.json spawns.<system>.grade) */
  gradeOf(systemNum: number): number {
    const id = this.host.systemId?.(systemNum);
    return (id && this.data.spawns[id]?.grade) || 1;
  }

  /** A design in a grade (cached: every Mk III raider is the same blueprint) */
  private graded = new Map<string, Blueprint>();
  /** `plating`: its armour plates that many grades better (elites, bosses) */
  design(type: string, grade: number, plating = 0): Blueprint | undefined {
    // (A custom enemy's design is its own at every grade: its grade scales its pieces' HP and its damage instead, custom/)
    const custom = this.custom.designOf(type);
    if (custom) return this.designs[custom];
    const bp = this.designs[type];
    if (!bp || (grade <= 1 && !plating && blueprintGrade(this.ships.catalog, bp) === 1)) return bp;
    const key = `${type}@${grade}+${plating}`;
    let out = this.graded.get(key);
    if (!out) { out = plated(this.ships.catalog, bp, grade, plating); this.graded.set(key, out); }
    return out;
  }

  /** The typical rating of what a system sends: its packs' ratings (each pack's ships together), weighted as they're picked */
  systemRating(systemId: string, band?: { inner: number; outer: number }): number {
    const sp = this.data.spawns[systemId];
    if (!sp) return 0;
    const grade = sp.grade ?? 1;
    // A band of the system (a region): the zones in it, and the system's own packs in its innermost band
    const inBand = (z: SpawnZone) => { const r = z.x !== undefined ? dhypot(z.x, z.y ?? 0) : (z.inner + z.outer) / 2; return !band || (r >= band.inner && r < band.outer); };
    // (Nests by how far out what they circle is; the system's own groups and zones only if they send packs of their own: else they're just who lives there)
    const nestR = (n: SpawnNest) => { const pl = n.place?.around !== undefined ? n.planets?.find((q) => q.id === n.place!.around) : undefined; return pl ? pl.orbit.radius : n.place?.orbit.radius ?? 0; };
    const groups = [
      ...((!band || band.inner === 0) && sp.packs > 0 ? sp.groups : []), ...(sp.zones ?? []).filter((z) => z.packs > 0 && inBand(z)).flatMap((z) => z.groups),
      ...(sp.nests ?? []).filter((n) => { const r = nestR(n); return !band || (r >= band.inner && r < band.outer); }).flatMap((n) => n.groups),
    ];
    let sum = 0, weight = 0;
    for (const g of groups) {
      let fp = 0, tough = 0;
      const f = this.data.factions[g.faction];
      for (const type of g.ships) {
        const cs = this.custom.statsOf(type);
        if (cs) { fp += this.custom.firepower(type, grade); tough += Object.values(cs.hp).reduce((a, h) => a + h, 0) * 4; continue; }
        const bp = this.design(type, grade, g.plating ?? 0);
        if (!bp) continue;
        const r = rateShip(this.ships.catalog, this.ships.tuning, createShipState(this.ships.catalog, this.ships.tuning, 0, bp, 0), f?.hpScale ?? 1);
        fp += r.firepower * (f?.damageScale ?? 1); tough += r.toughness;
      }
      sum += ratingOf(fp, tough) * (g.weight ?? 1);
      weight += g.weight ?? 1;
    }
    return weight ? sum / weight : 0;
  }

  /** Where a boss lairs (quest markers) */
  bossLair(boss: string): { system: string; x: number; y: number } | null {
    return this.bosses?.lair(boss) ?? null;
  }

  /** A boss ship joins the AI: it guards `home` with its own behaviour */
  addBoss(eid: number, boss: string, faction: string, systemNum: number, home: { x: number; y: number }, behaviour: Behaviour): void {
    const pack: Pack = { id: this.nextPack++, systemNum, home, members: new Set([eid]), lastSeen: this.host.tick(), boss: true };
    this.packs.set(pack.id, pack);
    const ship = this.ships.get(eid);
    const grade = ship ? blueprintGrade(this.ships.catalog, ship.blueprint) : 1;
    const rating = ship ? rateShip(this.ships.catalog, this.ships.tuning, ship).rating : 0;
    const e: Enemy = { eid, type: boss, faction, boss, behaviour, pack: pack.id, elite: false, grade, rating, state: 'patrol', target: -1, waypoint: { ...home }, strafe: 1, nextThink: 0, aimErr: 0, flank: 0 };
    this.enemies.set(eid, e);
    this.ships.setController(eid, (id, ship) => steering.fly(this, e, ship));
  }

  /** What the enemy AI would do with this ship this tick (a boss's brain starts from it: its target, aim and guns) */
  pilot(eid: number, ship: ShipState): PilotOrders | null {
    const e = this.enemies.get(eid);
    return e ? steering.fly(this, e, ship, false) : null;
  }

  /** Send these ships' pack somewhere new (raids head for a station) */
  sendPack(eids: number[], home: { x: number; y: number }, leash?: number): void {
    for (const eid of eids) {
      const e = this.enemies.get(eid);
      const pack = e && this.packs.get(e.pack);
      if (!e || !pack) continue;
      pack.home = { ...home };
      e.waypoint = { ...home };
      e.state = 'return';
      if (leash) e.behaviour = { ...(e.behaviour ?? this.data.factions[e.faction].behaviour), leash };
      this.onOrders?.(eid);
    }
  }

  /** A ship's orders changed (a distant one's route is planned again from now: GameServer hands it to SimLod.replan) */
  onOrders?: (eid: number) => void;

  /** These ships' pack was sent by the system's own spawners (what's remembered of a system left empty: SystemMemory.ts) */
  own(eids: number[], origin: PackOrigin): void {
    for (const eid of eids) {
      const p = this.packs.get(this.enemies.get(eid)?.pack ?? -1);
      if (p) p.origin = origin;
    }
  }

  /** Retune one ship's fighting (a siege's artillery keeps its distance) */
  tune(eid: number, patch: Partial<Behaviour>): void {
    const e = this.enemies.get(eid);
    if (e) e.behaviour = { ...(e.behaviour ?? this.data.factions[e.faction].behaviour), ...patch };
  }

  /** Give a hostile one target to go for first while it stands, from any distance (-1: none); `only`: nothing else, even what shoots it */
  setPrey(eid: number, prey: number, only = false): void {
    const e = this.enemies.get(eid);
    if (!e) return;
    e.prey = prey >= 0 ? prey : undefined;
    e.preyOnly = prey >= 0 && only;
  }

  /** A passive pack's ship that nobody's provoked: it'll leave you be */
  isCalm(eid: number): boolean {
    const e = this.enemies.get(eid);
    const pack = e && this.packs.get(e.pack);
    return !!pack?.passive && this.host.tick() >= (pack.angryUntil ?? 0);
  }

  /** Take a ship out of the world quietly (an event's leftovers leaving) */
  retire(eid: number): void {
    if (this.enemies.has(eid) && this.ships.has(eid)) this.ships.removeShip(eid);
  }

  isAlive(eid: number): boolean {
    return this.enemies.has(eid);
  }

  /** The player a hostile is fighting (or -1) */
  targetOf(eid: number): number {
    return this.enemies.get(eid)?.target ?? -1;
  }

  /** A ship type's name (for quest text) */
  displayName(type: string): string {
    return this.design(type, 1)?.name ?? type.replace(/^boss_/, '').replace(/_/g, ' ').replace(/\w/g, (c) => c.toUpperCase());
  }

  count(systemNum?: number): number {
    let n = 0;
    for (const e of this.enemies.values()) if (systemNum === undefined || InSystem.systemId[e.eid] === systemNum) n++;
    return n;
  }

  /** Spawn a pack now (tests, events). Returns the ship entities. */
  spawnPack(systemNum: number, group: { faction: string; ships: string[]; passive?: boolean; grade?: number; plating?: number }, x: number, y: number, zone?: string): number[] {
    const pack: Pack = { id: this.nextPack++, systemNum, home: { x, y }, members: new Set(), lastSeen: this.host.tick(), passive: group.passive, zone };
    this.packs.set(pack.id, pack);
    const out: number[] = [];
    const grade = Math.max(1, Math.min(MAX_GRADE, Math.round(group.grade ?? this.gradeOf(systemNum))));
    group.ships.forEach((type, i) => {
      // An elite: tougher, and plated a grade better
      const elite = i === 0 && this.rng() < this.data.rules.eliteChance;
      const a = (i / Math.max(1, group.ships.length)) * Math.PI * 2;
      const r = i === 0 ? 0 : 260 + i * 90;
      // The leader takes the front; the rest fan out either side of it
      const flank = i === 0 ? 0 : (i % 2 ? 1 : -1) * Math.min(1.6, 0.55 * Math.ceil(i / 2));
      const eid = this.spawnShip(pack, type, group.faction, grade, group.plating ?? 0, elite, x + dcos(a) * r, y + dsin(a) * r, null, flank);
      if (eid < 0) return;
      this.enemies.get(eid)!.waypoint = { x, y };
      pack.size0 = pack.members.size;
      out.push(eid);
    });
    return out;
  }

  /**
   * A gun range target (game/gunRange): a real enemy ship with no AI, so it aims nowhere and fires nothing, and holds
   * still (CTL.hold) unless steered back to its spot (steerTarget). Not pinned: it is a free body every client's contact
   * pass and prediction take as they take any ship. It takes damage as any ship does, and pays nothing when it dies
   * (onDestroyed: no XP, credits, loot, quests or achievements). Its own pack, never remembered with the system.
   * `hp` scales its hull as a boss's (bosses.json) does, `core` hardens its core.
   */
  spawnTarget(systemNum: number, t: { ship: string; faction: string; grade?: number; plating?: number; elite?: boolean; hp?: number; core?: number }, x: number, y: number, angle: number): number {
    const pack: Pack = { id: this.nextPack++, systemNum, home: { x, y }, members: new Set(), lastSeen: this.host.tick() };
    const eid = this.spawnShip(pack, t.ship, t.faction, Math.max(1, Math.min(MAX_GRADE, Math.round(t.grade ?? 1))), t.plating ?? 0, !!t.elite, x, y, angle, 0);
    if (eid < 0) return -1;
    this.packs.set(pack.id, pack);
    const e = this.enemies.get(eid)!;
    e.dummy = true;
    this.ships.setController(eid, () => null);
    if (t.hp && t.hp !== 1) this.ships.scaleHp(eid, t.hp);
    if (t.core && t.core !== 1) this.ships.hardenParts(eid, 'core', t.core);
    return eid;
  }

  /** Fly a gun range target to a spot (its autopilot: the clients replay its controls), or with none hold still where it is */
  steerTarget(eid: number, to: { x: number; y: number; arriveRadius: number } | null): void {
    if (!this.enemies.get(eid)?.dummy) return;
    this.ships.setAutopilot(eid, to ? { x: to.x, y: to.y, arriveRadius: to.arriveRadius } : null);
  }

  isTarget(eid: number): boolean {
    return !!this.enemies.get(eid)?.dummy;
  }

  /** One of a pack's ships: its design in its grade (an elite's plated a grade better, and tougher), its faction's hull and guns, and its AI (-1: no such design) */
  /** @internal shared with enemies/*.ts */
  spawnShip(pack: Pack, type: string, faction: string, grade: number, plating: number, elite: boolean, x: number, y: number, angle: number | null, flank: number): number {
    const bp = this.design(type, grade, plating + (elite ? 1 : 0));
    if (!bp) return -1;
    const eid = this.ships.spawnDummy(bp, x, y, angle ?? this.rng() * Math.PI * 2, pack.systemNum);
    const custom = this.custom.statsOf(type);
    if (custom) {
      // (A custom enemy: its pieces' HP and its damage are its design's own, by grade: custom/CustomEnemies.ts)
      this.custom.adopt(eid, type, grade, elite ? this.data.rules.eliteHp : 1);
    } else {
      const hp = (this.data.factions[faction]?.hpScale ?? 1) * (elite ? this.data.rules.eliteHp : 1);
      if (hp !== 1) this.ships.scaleHp(eid, hp);
      const dmg = this.data.factions[faction]?.damageScale;
      if (dmg !== undefined && dmg !== 1) this.ships.setDamageScale?.(eid, dmg);
    }
    const ship = this.ships.get(eid);
    const rating = !ship ? 0 : custom ? ratingOf(this.custom.firepower(type, grade), ship.maxHp.reduce((a, h) => a + h, 0) * 4) : rateShip(this.ships.catalog, this.ships.tuning, ship).rating;
    const e: Enemy = { eid, type, faction, pack: pack.id, elite, grade, plating, rating, state: 'patrol', target: -1, waypoint: { x, y }, strafe: this.rng() < 0.5 ? 1 : -1, nextThink: 0, aimErr: 0, flank };
    this.enemies.set(eid, e);
    pack.members.add(eid);
    this.ships.setController(eid, (id, ship) => steering.fly(this, e, ship));
    return eid;
  }

  tick(): void {
    const now = this.host.tick();
    this.defenders.tick();
    // Forget the dead
    for (const [eid, e] of this.enemies) {
      if (!this.ships.has(eid)) {
        this.enemies.delete(eid);
        this.pilots.forget(eid);
        this.custom.forget(eid);
        this.packs.get(e.pack)?.members.delete(eid);
        populations.popLost(this, e, now);
      }
    }
    // (its id another enemy's already, spawned since: what custom holds is the new one's; no tick has flown it yet)
    for (const eid of this.destroyed) { this.pilots.forget(eid); if (!this.enemies.has(eid)) this.custom.forget(eid); }
    this.destroyed.clear();
    for (const [id, p] of this.packs) {
      // (Where its fighters spread round from: its ships as they ended the last tick, summed in id order, as a client
      // running their pilots sums its replicas: common bodies/aiPilot.ts)
      if (p.members.size > 1) {
        const ids = [...p.members].sort((a, b) => a - b);
        let x = 0, y = 0;
        for (const m of ids) { x += Position.x[m]; y += Position.y[m]; }
        p.cent = { ids, x: x / ids.length, y: y / ids.length };
      } else p.cent = undefined;
      if (p.members.size) continue;
      this.packs.delete(id);
      if (p.pop?.p.slots[p.pop.slot].pack === id) p.pop.p.slots[p.pop.slot].pack = undefined;
    }

    // Keep each occupied system stocked (one nobody's in is put away whole: SystemMemory.ts)
    if (now % 30 === 0) {
      // Populations ship by ship back at their spawners' rates, wherever they are (time away counts: it's caught up on)
      for (const list of populations.populations(this).values()) for (const pop of list) populations.regrow(this, pop, now);
      for (const [sysId, sp] of Object.entries(this.data.spawns)) {
        const num = this.host.systemNum(sysId);
        // (Its system's pass: crowd dilation, sim/SystemClocks.ts)
        if (num < 0 || !SimPass.on(num)) continue;
        const players = this.host.players(num);
        const all = [...this.packs.values()].filter((p) => p.systemNum === num && !p.boss);
        const packs = all.filter((p) => !p.zone && !p.nest);
        // Nests' and zones' packs: ghosts a pilot comes near are loaded where they are, loaded ones nobody's near any more go back to ghosts
        populations.tendPops(this, num, players, now);
        // (A zone's own packs are its population; its packs from elsewhere, an event's say, recycled once nobody's near)
        for (const z of sp.zones ?? []) {
          const inside = players.some((p) => { const r = dhypot(Position.x[p] - (z.x ?? 0), Position.y[p] - (z.y ?? 0)); return r > z.inner - 3000 && r < z.outer + 3000; });
          if (inside) for (const p of all) if (p.zone === z.id) p.lastSeen = now;
        }
        for (const n of sp.nests ?? []) placement.tendNest(this, num, n, players, all, now);
        for (const p of all) {
          if (p.zone && !p.pop && players.length && now - p.lastSeen > this.data.rules.idleDespawnSeconds * 60 && [...p.members].every((m) => this.ships.isDormant(m))) {
            for (const m of p.members) this.ships.removeShip(m);
            this.packs.delete(p.id);
          }
        }
        if (!players.length) continue;
        if (packs.length >= sp.packs || now < (this.nextSpawn.get(num) ?? 0)) continue;
        placement.arrive(this, num, placement.pickGroup(this, sp.groups), players);
        this.nextSpawn.set(num, now + this.data.rules.respawnSeconds * 60 / Math.max(1, sp.packs));
      }
    }
    // Ships coming through gates, once they've spooled up
    for (let i = this.arrivals.length - 1; i >= 0; i--) {
      const a = this.arrivals[i];
      if (now < a.due || !SimPass.on(a.num)) continue;
      this.arrivals.splice(i, 1);
      this.host.effect?.(a.num, a.x, a.y, 'warpIn');
      const eids = this.spawnPack(a.num, a.group, a.x, a.y, a.zone);
      this.own(eids, a.zone ? 'zone' : 'system');
      if (a.approach) this.sendPack(eids, a.approach);
    }

    // Armed stations fire on hostiles near them
    if (now % 3 === 0) stationDefence.stationDefence(this, now);
  }

  // ---------------------------------------------------------------------------
  // Nests
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Populations: every nest's and zone's packs, ship by ship (common world/populations.ts)
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Memory: a system left empty is put away, and comes back as it was (SystemMemory.ts)
  // ---------------------------------------------------------------------------

  /** Ships coming through a gate: when, where, and where they're headed */
  /** @internal shared with enemies/*.ts */
  arrivals: { due: number; num: number; group: SpawnGroup; x: number; y: number; zone?: string; approach?: { x: number; y: number } }[] = [];

  // ---------------------------------------------------------------------------
  // The pilot
  // ---------------------------------------------------------------------------

  /** Is this enemy's pilot body on (clients fly it, and its guns: server net/guns/GunNet.ts)? Not a boss's brain's body */
  aiBodyOn(eid: number): boolean {
    return this.pilots.on(eid);
  }

  // ---------------------------------------------------------------------------
  // Kills and station defence
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // The rules live in enemies/*.ts (populations, packs, steering, memory, loot, stationDefence); these are the public doors
  // ---------------------------------------------------------------------------

  /** What a hostile is doing, coarsely, for a distant one (enemies/steering.ts) */
  intent(eid: number, at: Plan): Intent | null | undefined { return steering.intent(this, eid, at); }
  /** A system's populations as the wire has them (enemies/populations.ts) */
  popRows(num: number): PopRows { return populations.popRows(this, num); }
  /** What's changed in each system's populations since last asked */
  popChanges(): Map<number, PopRows> { return populations.popChanges(this); }
  /** A population's slots now (tests, tools) */
  population(systemNum: number, id: string): { next: number; slots: { group: number; alive: number; loaded: boolean; ships: number[] }[] } | null { return populations.population(this, systemNum, id); }
  /** Where a population's slot's pack is while it's a ghost, at `tick` (tests, tools) */
  ghostAt(systemNum: number, id: string, slot: number, tick?: number): XY | null { return populations.ghostAt(this, systemNum, id, slot, tick); }
  /** Every population as remembered (the memory file) */
  popMemory(offset: number): Record<string, Record<string, PopulationMemory>> { return populations.popMemory(this, offset); }
  /** Populations back as remembered */
  setPopMemory(data: Record<string, Record<string, PopulationMemory>> | undefined, offset: number): void { populations.setPopMemory(this, data, offset); }
  /** A nest's packs out now (their ships), and where it is (tests, tools) */
  nest(systemNum: number, id: string): { x: number; y: number; packs: number[][] } | null { return placement.nest(this, systemNum, id); }
  /** A spawn group arrives in a system (enemies/placement.ts) */
  arrive(num: number, group: SpawnGroup, players: number[], zone?: SpawnZone): void { placement.arrive(this, num, group, players, zone); }
  /** Every system's populations, built on first use (enemies/populations.ts) */
  populations(): Map<number, Population[]> { return populations.populations(this); }
  /** A system's packs as they are, to put the system away (enemies/memory.ts) */
  capture(num: number, where: (eid: number) => FarPose, offset: number, evict: boolean): PackMemory[] { return memory.capture(this, num, where, offset, evict); }
  /** A remembered system's packs back */
  restore(num: number, packs: PackMemory[], offset: number, heal: number, adopt: (eid: number, pose: FarPose) => void): void { memory.restore(this, num, packs, offset, heal, adopt); }
  /** What a hostile is doing, to remember it by */
  aiOf(eid: number): EnemyAi | undefined { return memory.aiOf(this, eid); }
  setAi(eid: number, ai: EnemyAi): void { memory.setAi(this, eid, ai); }
  /** Every spawner's clock still to run, keyed by system id, as world ticks */
  timers(offset: number): Record<string, Record<string, number>> { return memory.timers(this, offset); }
  setTimers(t: Record<string, Record<string, number>>, offset: number): void { memory.setTimers(this, t, offset); }
  /** An enemy ship was destroyed: pay the killer (and helpers), drop loot (enemies/loot.ts) */
  onDestroyed(eid: number, killer: number | undefined, ship: ShipState | undefined): void { loot.onDestroyed(this, eid, killer, ship); }

}

