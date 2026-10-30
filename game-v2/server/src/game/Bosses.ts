/**
 * Bosses (data/bosses.json): one big hostile per lair, with phases.
 *
 * A boss appears at its lair while players are in its system, and after it
 * dies comes back `respawnSeconds` later. Left alone for a while (nobody in
 * the system), it resets to full health. It's flown by the enemy AI with its
 * own behaviour; this module adds what makes it a boss:
 *   - phases as its hull falls (escorts, rage, healing, blinking, novas)
 *   - novas: a telegraphed ring of shots (clients see it charging first)
 *   - an intro title card the first time it's hurt, announcements to the system
 *   - shared credit: everyone who hurt it recently, or was close when it died,
 *     gets the XP, the credits, the quest credit and their own loot roll,
 *     straight into storage (nobody fights over the pod)
 *
 * An `arena` boss has no lair out in the world: a job spawns it in a party's
 * own copy of an arena (Arenas.ts, spawnAt), once, for that fight.
 */

import { IWorld } from 'bitecs';
import { Position, InSystem, Bag, Blueprint, ShipState, ServerMessage, mulberry32, plated } from '@space-game/common';
import type { ShipBridge } from '../ships/ShipBridge.js';
import type { Enemies, Behaviour } from './Enemies.js';
import type { Mobs } from './Mobs.js';
import type { BossBrain, BrainHost } from './brains/kit.js';
import { PyreclastBrain } from './brains/pyreclast.js';
import { ScrapMotherBrain } from './brains/scrapMother.js';
import { BroodMotherBrain } from './brains/broodMother.js';

/** Bosses with a mind of their own (bosses.json `brain`): their moves are written out in server/src/game/brains */
const BRAINS: Record<string, (host: BrainHost) => BossBrain> = {
  pyreclast: (host) => new PyreclastBrain(host),
  scrap_mother: (host) => new ScrapMotherBrain(host),
  brood_mother: (host) => new BroodMotherBrain(host),
};
export { BRAIN_IDS } from './brains/ids.js';

export interface BossPhase {
  at: number;
  say?: string;
  escorts?: string[];
  enrage?: number;
  heal?: number;
  blink?: number;
  nova?: { every: number; kind: string; count: number; warnTicks: number };
}

export interface BossDef {
  name: string;
  title: string;
  faction: string;
  system: string;
  lair: { x: number; y: number };
  level: number;
  hp: number;
  damage: number;
  xp: number;
  credits: number;
  respawnSeconds: number;
  behaviour: Behaviour;
  intro: string;
  phases: BossPhase[];
  loot: { item: string; chance: number; min: number; max: number }[];
  /** The blueprint (enemy designs) when it isn't the boss's own id */
  design?: string;
  /** Fought only in a job's arena (spawnAt), never at a lair */
  arena?: boolean;
  /** A structure (an outpost), not a ship: it holds its lair and never moves */
  fixed?: boolean;
  /**
   * Built in its system's grade (or `grade`), its armour plates `plating`
   * grades better (default 1): a boss has a few parts a grade above what you
   * meet around it. `asDesigned`: built exactly as its blueprint is (the Maw).
   */
  grade?: number;
  plating?: number;
  asDesigned?: boolean;
  /** Engine output (its blueprint's drive, up to MAX_DRIVE): how fast it flies and turns against its design; unset, as designed */
  speed?: number;
  /** Its turning × this (its blueprint's turn, up to MAX_TURN), braking in time to settle on its heading: every brain-flown boss has one */
  turn?: number;
  /** A wanderer: while it isn't fighting, it moves on to somewhere new this far from its lair every `everySeconds` */
  roam?: { radius: number; everySeconds: number };
  /** Flown by its own brain (server/src/game/brains), not just the enemy AI: dashes, charges, telegraphed attacks */
  brain?: string;
}

export interface BossesFile {
  rules: {
    creditRange: number; creditWindowTicks: number; resetAfterSeconds: number; barRange: number;
    /** A pilot's credits for a boss they've killed before, as a share of the full pay (1: no change) */
    repeatCredits?: number;
  };
  bosses: Record<string, BossDef>;
}

export interface BossHost {
  /** An arrival's effect (escorts launching) */
  effect?(num: number, x: number, y: number, kind: 'warning' | 'warpIn' | 'launch'): void;
  readonly world: IWorld;
  tick(): number;
  systemNum(id: string): number;
  /** Living players in a system */
  players(systemNum: number): number[];
  send(systemNum: number, msg: ServerMessage): void;
  /** A notice to every player in a system */
  announce(systemNum: number, text: string, kind: 'info' | 'warn' | 'good' | 'bad'): void;
  /** Fire a shot from a ship (novas) */
  fire(owner: number, kind: string, x: number, y: number, angle: number, damageScale: number, opts?: { target?: number; speed?: number }): void;
  /** Warp flash at a point (blinks) */
  warpFx(systemNum: number, x: number, y: number, out: boolean): void;
  /** Pay a player for the kill: XP, credits, loot into storage, quest credit */
  reward(player: number, boss: string, def: BossDef, xp: number, credits: number, loot: Bag): void;
  /** Has this player killed this boss before (repeat kills pay less) */
  killedBefore?(player: number, boss: string): boolean;
  /** Does this player already hold one of this item (artefacts drop only to those who don't) */
  holds?(player: number, item: string): boolean;
  /** Is this item an artefact (one per pilot) */
  isArtefact?(item: string): boolean;
  /** A surface's rock (bosses' beams stop at it) */
  terrain?(systemNum: number): import('@space-game/common').Terrain | undefined;
  /** It's dead, and these players had a hand in it */
  defeated?(boss: string, def: BossDef, players: number[]): void;
}

interface Live {
  /** id for a lair boss; id@instance for an arena's */
  key: string;
  id: string;
  def: BossDef;
  eid: number;
  systemNum: number;
  phase: number;
  rage: number;
  blinkEvery: number;
  nextBlink: number;
  nova: BossPhase['nova'] | null;
  nextNova: number;
  /** A nova charging: fires at this tick */
  novaAt: number;
  engaged: boolean;
  brain?: BossBrain;
  /** Pilots in its system who've been told what phase it's in (a pilot arriving mid-fight is told: their client draws it so) */
  told: Set<number>;
  /** Where it was put (its lair, or an arena's spot): its brain keeps near it */
  home: { x: number; y: number };
  /** Damage dealt by each player, and when they last hit */
  dealt: Map<number, { amount: number; last: number }>;
  lastSeen: number;
}

export class Bosses {
  private live = new Map<string, Live>();
  private byEid = new Map<number, Live>();
  private nextSpawn = new Map<string, number>();
  private rng = mulberry32(0xb055);
  /** Single-body enemies (what brood bays launch) */
  mobs?: Mobs;

  constructor(private host: BossHost, private enemies: Enemies, private ships: ShipBridge, readonly file: BossesFile, private designs: Record<string, Blueprint>) {
    enemies.bosses = {
      onDestroyed: (eid, killer, ship) => this.onDestroyed(eid, killer, ship),
      name: (eid) => this.byEid.get(eid)?.def.name,
      lair: (boss) => {
        const d = this.file.bosses[boss];
        return d && !d.arena ? { system: d.system, x: d.lair.x, y: d.lair.y } : null;
      },
      launcher: (num, faction) => this.launcher(num, faction),
    };
  }

  def(id: string): BossDef | undefined {
    return this.file.bosses[id];
  }

  /** The boss this entity is (for the snapshot), or undefined */
  of(eid: number): { id: string; def: BossDef; phase: number } | undefined {
    const b = this.byEid.get(eid);
    return b && { id: b.id, def: b.def, phase: b.phase };
  }

  isAlive(id: string): boolean {
    return this.live.has(id);
  }

  eidOf(id: string): number {
    return this.live.get(id)?.eid ?? -1;
  }

  /** Spawn a boss at its lair now (tests, admin) */
  spawn(id: string): number {
    const def = this.file.bosses[id];
    const num = def ? this.host.systemNum(def.system) : -1;
    if (!def || num < 0) return -1;
    return this.create(id, id, def, num, def.lair.x, def.lair.y);
  }

  /** An arena boss in one copy of its arena (Arenas.ts) */
  spawnAt(id: string, num: number, x: number, y: number): number {
    const def = this.file.bosses[id];
    return def ? this.create(`${id}@${num}`, id, def, num, x, y) : -1;
  }

  /** A standing outpost of this faction in a system (its packs launch from it): where, and how far out its bays are */
  launcher(num: number, faction: string): { x: number; y: number; r: number } | null {
    for (const b of this.live.values()) {
      if (!b.def.fixed || b.def.faction !== faction || b.systemNum !== num || !this.ships.has(b.eid)) continue;
      return { x: Position.x[b.eid], y: Position.y[b.eid], r: (this.ships.get(b.eid)?.derived.radius ?? 200) + 150 };
    }
    return null;
  }

  /** Take a boss away (its arena emptied) */
  remove(eid: number): void {
    const b = this.byEid.get(eid);
    if (b) this.despawn(b);
  }

  private create(key: string, id: string, def: BossDef, num: number, x: number, y: number): number {
    const design = this.designs[def.design ?? id];
    if (!design || this.live.has(key)) return this.live.get(key)?.eid ?? -1;
    const built = def.asDesigned ? design : plated(this.ships.catalog, design, def.grade ?? this.enemies.gradeOf(num), def.plating ?? 1);
    const bp = def.speed || def.turn ? { ...built, ...(def.speed ? { drive: def.speed } : {}), ...(def.turn ? { turn: def.turn } : {}) } : built;
    const eid = this.ships.spawnDummy(bp, x, y, this.rng() * Math.PI * 2, num);
    this.ships.scaleHp(eid, def.hp);
    // A boss dies when its core does: keep that for the end of the fight, not a lucky shot through a gap
    this.ships.hardenParts(eid, 'core', 2.5);
    this.ships.setDamageScale(eid, def.damage);
    this.enemies.addBoss(eid, id, def.faction, num, { x, y }, def.behaviour);
    if (def.fixed) this.ships.pin(eid);
    const b: Live = {
      key, id, def, eid, systemNum: num, phase: 0, rage: 1, blinkEvery: 0, nextBlink: 0, nova: null, nextNova: 0, novaAt: -1,
      engaged: false, dealt: new Map(), lastSeen: this.host.tick(), home: { x, y }, told: new Set(),
    };
    const make = def.brain ? BRAINS[def.brain] : undefined;
    if (make) {
      // Its brain flies it, from what the enemy AI would do (who to fight, where its turrets aim)
      const brain = make(this.brainHost());
      b.brain = brain;
      this.ships.setController(eid, (id, ship) => brain.orders(this.enemies.pilot(id, ship), ship, {
        eid: id, systemNum: b.systemNum, phase: b.phase, damage: b.def.damage * b.rage, fighters: Math.max(1, this.fighters(b)), home: b.home,
      }));
    }
    this.live.set(key, b);
    this.byEid.set(eid, b);
    if (!def.arena) this.host.announce(num, `${def.name} has been sighted in this system.`, 'warn');
    return eid;
  }

  private brainHost(): BrainHost {
    const host = this.host, self = this;
    return {
      tick: () => host.tick(),
      rng: () => this.rng(),
      ships: this.ships,
      get mobs() { return self.mobs; },
      send: (num, msg) => host.send(num, msg),
      fire: (owner, kind, x, y, angle, k, opts) => host.fire(owner, kind, x, y, angle, k, opts),
      launchFx: (num, x, y) => host.effect?.(num, x, y, 'launch'),
      players: (num) => host.players(num),
      terrain: (num) => host.terrain?.(num),
    };
  }

  /** Pilots who've hurt it in the last while (more of them, the harder it comes) */
  private fighters(b: Live): number {
    const now = this.host.tick();
    let n = 0;
    for (const d of b.dealt.values()) if (now - d.last < 60 * 30) n++;
    return n;
  }

  /** Damage report from the ship bridge: who's fighting a boss */
  onDamage(target: number, amount: number, source: number): void {
    const b = this.byEid.get(target);
    if (!b || source < 0 || !this.host.players(b.systemNum).includes(source)) return;
    const now = this.host.tick();
    const d = b.dealt.get(source) ?? { amount: 0, last: now };
    d.amount += amount;
    d.last = now;
    b.dealt.set(source, d);
    this.engage(b);
  }

  /** The fight starts (it spots someone, or someone hurts it): the title card */
  private engage(b: Live): void {
    if (b.engaged) return;
    b.engaged = true;
    this.host.send(b.systemNum, { type: 'bossIntro', bodyId: b.eid, name: b.def.name, title: b.def.title, text: b.def.intro });
  }

  tick(): void {
    const now = this.host.tick();
    // Spawn at lairs where players are, reset bosses left alone
    if (now % 60 === 0) {
      for (const [id, def] of Object.entries(this.file.bosses)) {
        if (def.arena) continue;
        const num = this.host.systemNum(def.system);
        if (num < 0) continue;
        const here = this.host.players(num).length > 0;
        const b = this.live.get(id);
        if (b) {
          if (here) b.lastSeen = now;
          else if (now - b.lastSeen > this.file.rules.resetAfterSeconds * 60) this.despawn(b);
          continue;
        }
        if (here && now >= (this.nextSpawn.get(id) ?? 0)) this.spawn(id);
      }
    }
    for (const b of [...this.live.values()]) {
      if (!this.ships.has(b.eid)) { this.forget(b); continue; }
      this.stepPhases(b, now);
    }
  }

  private stepPhases(b: Live, now: number): void {
    // Distant (ships/SimLod.ts): nothing's happening to it; a wanderer still moves on
    if (this.ships.isDormant(b.eid)) { this.roam(b, now, -1); return; }
    const integrity = b.brain?.integrity?.() ?? this.ships.integrity(b.eid);
    while (b.phase < b.def.phases.length && integrity < b.def.phases[b.phase].at) {
      this.enterPhase(b, b.def.phases[b.phase], now);
      b.phase++;
    }
    // Someone new here, mid-fight: everyone's told the phase again (no line: just so it's drawn so)
    if (now % 30 === 0) {
      const here = this.host.players(b.systemNum);
      if (here.some((p) => !b.told.has(p)) && b.phase > 0) this.host.send(b.systemNum, { type: 'bossPhase', bodyId: b.eid, phase: b.phase, text: '' });
      b.told = new Set(here);
    }
    const x = Position.x[b.eid], y = Position.y[b.eid];
    const target = this.enemies.targetOf(b.eid);
    if (target >= 0) this.engage(b);
    // A wanderer moves on while nobody's fighting it
    const roamed = this.roam(b, now, target);
    // Quiet again (everyone left or died): the next one gets the card too
    if (!roamed && b.engaged && !this.host.players(b.systemNum).some((p) => Math.hypot(Position.x[p] - x, Position.y[p] - y) < this.file.rules.barRange)) b.engaged = false;
    // Novas: warn, then fire a ring of shots
    if (b.nova && b.novaAt < 0 && now >= b.nextNova && target >= 0) {
      b.novaAt = now + b.nova.warnTicks;
      this.host.send(b.systemNum, { type: 'bossCharge', bodyId: b.eid, kind: b.nova.kind, ticks: b.nova.warnTicks });
    }
    if (b.nova && b.novaAt >= 0 && now >= b.novaAt) {
      const r = (this.ships.get(b.eid)?.derived.radius ?? 100) + 30;
      const a0 = this.rng() * Math.PI * 2;
      for (let i = 0; i < b.nova.count; i++) {
        const a = a0 + (i / b.nova.count) * Math.PI * 2;
        this.host.fire(b.eid, b.nova.kind, x + Math.cos(a) * r, y + Math.sin(a) * r, a, b.def.damage * b.rage);
      }
      b.novaAt = -1;
      b.nextNova = now + b.nova.every;
    }
    // Blinks: fold space and come out beside the target
    if (b.blinkEvery > 0 && now >= b.nextBlink && target >= 0) {
      const a = this.rng() * Math.PI * 2, d = 700 + this.rng() * 500;
      const nx = Position.x[target] + Math.cos(a) * d, ny = Position.y[target] + Math.sin(a) * d;
      this.host.warpFx(b.systemNum, x, y, true);
      this.ships.teleport(b.eid, nx, ny);
      this.host.warpFx(b.systemNum, nx, ny, false);
      b.nextBlink = now + b.blinkEvery;
    }
  }

  /** A wanderer moves on now and then while nobody's fighting it. True if it did. */
  private roam(b: Live, now: number, target: number): boolean {
    if (!b.def.roam || target >= 0 || now % (b.def.roam.everySeconds * 60) !== 0) return false;
    const a = this.rng() * Math.PI * 2, d = b.def.roam.radius * (0.3 + 0.7 * this.rng());
    this.enemies.sendPack([b.eid], { x: b.def.lair.x + Math.cos(a) * d, y: b.def.lair.y + Math.sin(a) * d });
    return true;
  }

  private enterPhase(b: Live, p: BossPhase, now: number): void {
    if (p.say) this.host.announce(b.systemNum, p.say, 'warn');
    if (p.enrage) {
      b.rage = p.enrage;
      this.ships.setDamageScale(b.eid, b.def.damage * b.rage);
    }
    if (p.heal) this.ships.healAll(b.eid, p.heal);
    if (p.blink) { b.blinkEvery = p.blink; b.nextBlink = now + 60; }
    if (p.nova) { b.nova = p.nova; b.nextNova = now + 90; }
    if (p.escorts?.length) {
      // Out of its launch bays, at its hull (not out of nowhere beside you)
      const x = Position.x[b.eid], y = Position.y[b.eid];
      const a = this.rng() * Math.PI * 2, r = (this.ships.get(b.eid)?.derived.radius ?? 300) + 120;
      const lx = x + Math.cos(a) * r, ly = y + Math.sin(a) * r;
      this.host.effect?.(b.systemNum, lx, ly, 'launch');
      const eids = this.enemies.spawnPack(b.systemNum, { faction: b.def.faction, ships: p.escorts }, lx, ly);
      // They fight round their mother ship
      this.enemies.sendPack(eids, { x, y }, 9000);
    }
    this.host.send(b.systemNum, { type: 'bossPhase', bodyId: b.eid, phase: b.phase + 1, text: p.say ?? '' });
  }

  private onDestroyed(eid: number, killer: number | undefined, ship: ShipState | undefined): void {
    const b = this.byEid.get(eid);
    if (!b) return;
    void ship;
    const now = this.host.tick();
    const x = Position.x[eid], y = Position.y[eid];
    const r = this.file.rules;
    const winners = new Set<number>();
    for (const [p, d] of b.dealt) if (now - d.last < r.creditWindowTicks && this.host.players(b.systemNum).includes(p)) winners.add(p);
    for (const p of this.host.players(b.systemNum)) if (Math.hypot(Position.x[p] - x, Position.y[p] - y) < r.creditRange) winners.add(p);
    if (killer !== undefined && this.host.players(b.systemNum).includes(killer)) winners.add(killer);
    for (const p of winners) {
      // Full pay the first time; a farmed boss pays a share, and no second artefact
      const again = this.host.killedBefore?.(p, b.id) ?? false;
      const credits = again ? Math.round(b.def.credits * (r.repeatCredits ?? 1)) : b.def.credits;
      const loot = this.rollLoot(b.def);
      for (const id of Object.keys(loot)) if (this.host.isArtefact?.(id) && this.host.holds?.(p, id)) delete loot[id];
      this.host.reward(p, b.id, b.def, b.def.xp, credits, loot);
    }
    this.host.defeated?.(b.id, b.def, [...winners]);
    this.host.send(b.systemNum, { type: 'bossDefeated', bodyId: eid, name: b.def.name, x: Math.round(x), y: Math.round(y) });
    this.host.announce(b.systemNum, `${b.def.name} is destroyed!`, 'good');
    if (!b.def.arena) this.nextSpawn.set(b.id, now + b.def.respawnSeconds * 60);
    this.forget(b);
  }

  private rollLoot(def: BossDef): Bag {
    const bag: Bag = {};
    for (const l of def.loot) {
      if (this.rng() >= l.chance) continue;
      bag[l.item] = (bag[l.item] ?? 0) + l.min + Math.floor(this.rng() * (l.max - l.min + 1));
    }
    return bag;
  }

  private despawn(b: Live): void {
    this.ships.removeShip(b.eid);
    this.forget(b);
  }

  private forget(b: Live): void {
    b.brain?.dispose?.();
    // (What it launched goes with it)
    this.mobs?.clear(b.systemNum, b.eid);
    this.live.delete(b.key);
    this.byEid.delete(b.eid);
  }

  /**
   * Mustn't go distant now (ships/SimLod.ts): fighting, a move or a stage's
   * blowing-away under way (its brain isn't idle), a nova charging, or drones
   * of its own still out. Idle at its lair, it sleeps like any hostile and
   * wakes as a pilot comes near: its brain only ever runs live.
   */
  busy(eid: number): boolean {
    const b = this.byEid.get(eid);
    if (!b) return false;
    if (this.enemies.targetOf(eid) >= 0 || b.novaAt >= 0) return true;
    if (b.brain && !(b.brain.idle?.() ?? false)) return true;
    return (this.mobs?.ownedBy(b.systemNum, eid) ?? 0) > 0;
  }

  /** Living bosses in a system, for the snapshot */
  inSystem(num: number): number[] {
    return [...this.live.values()].filter((b) => b.systemNum === num).map((b) => b.eid);
  }

  /** How far into the fight a boss is (for tests) */
  /** (dev) a boss's brain, by its body */
  brainOf(eid: number): BossBrain | undefined {
    for (const b of this.live.values()) if (b.eid === eid) return b.brain;
    return undefined;
  }

  phaseOf(id: string): number {
    return this.live.get(id)?.phase ?? -1;
  }

  /** Where the world is this boss (InSystem for tests) */
  systemOf(id: string): number {
    const b = this.live.get(id);
    return b ? InSystem.systemId[b.eid] : -1;
  }
}
