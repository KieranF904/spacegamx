/**
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

import { hasComponent, IWorld } from 'bitecs';
import {
  Position, Velocity, Rotation, InSystem, Player, Dead, Radius,
  Blueprint, Bag, ShipState, partItemId, mulberry32,
  MAX_GRADE, markName, regrade, blueprintGrade, gradeReward, rateShip, ratingOf, createShipState, placeCost, type Economy, plated, aiLoadout, AI_BEAM_REACH, type AiLead, migratePartItem,
  nestPosition, nestPost, NEST_RADIUS, insideTerrain, rayTerrain, terrainRadius, type Terrain, type NestData, type PlanetData, type StarSystemData, datan2, dcos, dhypot, dsin,
  orderEngage, orderFlee, orderPatrol, orderReturn, aiAimError, type BodyState, type WantRec,
  spawnersOf, seedGroups, pickGroup, ghostCentre, ghostShip, slotStyle, packPopSlot, lureSector, packLure, LIFE_ASLEEP_RESET, FOCUS_RANGE, GHOST_STEP,
  type Spawner, type Lure } from '@space-game/common';
import { AiPilots } from './brains/aiPilot.js';
import { Defenders } from './enemies/defenders.js';
import { CustomEnemies } from './custom/CustomEnemies.js';
import type { CustomTable } from './custom/types.js';
import type { Mobs } from './Mobs.js';
import { nestBand, clampBand, stepRound, placesOfInterest, looseWaypoint, nomadDestination, anchoredWaypoint, LOOSE_REACH, PATROL_STALL, type ClearRun, type RoamStyle, type Band, type XY } from './Roaming.js';
import type { ShipBridge, PilotOrders } from '../ships/ShipBridge.js';
import type { Intent, Plan, FarPose } from '../ships/SimLod.js';
import { shipMemory, restoreHp, type ShipMemory } from './SystemMemory.js';
import { SimPass } from '../sim/SystemClocks.js';
import { PayoutDice, type Dice } from './payoutDice.js';

export interface FactionDef {
  name: string;
  color: string;
  /** strafe: share of the time spent circling at fighting range (default 1); the rest it brakes and holds */
  behaviour: { aggro: number; range: number; flee: number; leash: number; accuracy?: number; strafe?: number };
  ships: Record<string, { xp: number; credits: number }>;
  loot: { item: string; chance: number; min: number; max: number }[];
  partSalvage: number;
  /** Hull strength against the designs' own (heavy but flimsy junk: < 1) */
  hpScale?: number;
  /** Their guns' damage against the designs' own (Helios drones' pea-shooters: well under 1) */
  damageScale?: number;
  /** A passive pack, provoked, stays angry this long (default 45 s) */
  angrySeconds?: number;
}

/**
 * `plating`: armour this many grades better than the system's (the rim's veterans).
 * In a nest, `limit`: at most this many of its packs out at once; `respawnSeconds`:
 * once one is wiped out, this long before the nest sends it again (the heavies);
 * `style`: how this group gets about, if not as the nest's packs do (Roaming.ts).
 */
type SpawnGroup = { faction: string; ships: string[]; weight: number; passive?: boolean; plating?: number; limit?: number; respawnSeconds?: number; style?: RoamStyle };

/** A nest's packs (factions.json): who, how many out at once, and how far they roam */
export interface SpawnNest {
  /** systems.json nest of the same id (where it is) */
  id: string;
  packs: number;
  /** Between launches while it's short, and once a pack's wiped out before it's replaced (default rules.respawnSeconds) */
  respawnSeconds?: number;
  /** How far its ships chase from it (default their faction's leash) */
  leash?: number;
  /** How close a pilot comes before its ships go for them (default their faction's aggro: a den's are keener) */
  aggro?: number;
  /** How far round it they patrol (default 2400): anchored packs keep within it, loose ones stray a few times it */
  roam?: number;
  /** How its packs get about (default loose: Roaming.ts), and how strongly loose ones are drawn back to it (0..1, default 0.5) */
  style?: RoamStyle;
  bias?: number;
  /** Where its packs keep round, if not the nest (a den heap against a wall: its chamber's open middle; common nestPost) */
  post?: XY;
  groups: SpawnGroup[];
  /** Filled in from systems.json (withNests): the nest, its system (planets, belts), and the band of it its packs keep to */
  place?: NestData;
  planets?: PlanetData[];
  sys?: StarSystemData;
  band?: Band;
}

/** A ring of a system with packs of its own */
export interface SpawnZone {
  id: string;
  inner: number;
  outer: number;
  /** A spot rather than a ring round the star: inner/outer are measured from here (systems.json zone of the same id) */
  x?: number;
  y?: number;
  /** Packs alive at once while pilots are in the ring (0: its packs come from nests; its groups are who raids and events there send) */
  packs: number;
  respawnSeconds?: number;
  groups: SpawnGroup[];
}

export interface FactionsFile {
  factions: Record<string, FactionDef>;
  /** passive groups leave pilots alone until someone shoots one of them */
  /** Per system: `grade` (Mk I-V, default I) is what its ships are built of (ships/grades.ts) */
  /** `groups` is also who lives there (events and raids draw on it); `packs` of them roam free, coming in from outside (0: all from nests) */
  spawns: Record<string, { grade?: number; packs: number; groups: SpawnGroup[]; zones?: SpawnZone[]; nests?: SpawnNest[]; events?: import('./Events.js').SystemEvents }>;
  /** Custom enemies (docs/enemies/custom-roster.md): designs in ship types' places, their pieces' HP and moves' numbers (custom/) */
  custom?: CustomTable;
  rules: {
    minStationDistance: number;
    minPlayerDistance: number;
    eliteChance: number;
    eliteHp: number;
    eliteLoot: number;
    respawnSeconds: number;
    /** A zone's packs nobody's been near this long (in a system with pilots: one without is remembered whole, SystemMemory.ts) are recycled, so new ones come in where the pilots are */
    idleDespawnSeconds: number;
    assistXpShare: number;
    /** Kill credits: the ship type's × this by the enemy's grade (Mk I-V at 0-4; none: gradeReward, as XP), never falling with grade */
    gradeCredits?: number[];
    /**
     * Where packs come from (never out of nowhere beside you): `spawnRange`
     * from every pilot, past the radar's reach, then most fly in towards the
     * pilots' part of the system (`approachChance`); or out of a gate
     * (`gateChance`), seen spooling up `warnSeconds` before; or launched from
     * their faction's outpost in the system, if it stands.
     */
    spawnRange?: [number, number];
    approachChance?: number;
    gateChance?: number;
    warnSeconds?: number;
    /** A nest's or zone's ghost pack is loaded (made real ships, where its ghost is) once a pilot is this close to it, and put back once none is within 1.25 times this (default 36000) */
    nestWake?: number;
    /** Station turrets by weapon: reach past the hull, damage a shot, ticks between shots, flak's blast radius */
    stationDefence: Record<string, StationGun>;
  };
}

/** Zones that are spots (systems.json zones with a centre) take their centre from the system's zone of the same id */
export function withZoneSpots(data: FactionsFile, system: (id: string) => { zones?: { id: string; x?: number; y?: number }[] } | undefined): FactionsFile {
  for (const [sysId, sp] of Object.entries(data.spawns)) {
    for (const z of sp.zones ?? []) {
      const at = system(sysId)?.zones?.find((q) => q.id === z.id);
      if (at?.x !== undefined && z.x === undefined) { z.x = at.x; z.y = at.y; }
    }
  }
  return data;
}

/** Nests take their place from systems.json (the nest of the same id, and the planets it may circle) */
export function withNests(data: FactionsFile, system: (id: string) => StarSystemData | undefined): FactionsFile {
  for (const [sysId, sp] of Object.entries(data.spawns)) {
    const sys = system(sysId);
    for (const n of sp.nests ?? []) {
      n.place = sys?.nests?.find((q) => q.id === n.id);
      n.planets = sys?.planets;
      n.sys = sys;
      if (n.place) n.band = nestBand(sys, n.place);
    }
  }
  return data;
}

export interface StationGun { range: number; damage: number; interval: number; splash?: number }

/** Who sent a pack: the system's roaming packs, a zone's, a nest's, a boss's escorts (what's remembered of a system left empty) */
export type PackOrigin = 'system' | 'zone' | 'nest' | 'escort';

/** A hostile as remembered (SystemMemory.ts): what it is, and what it was doing (a fight's forgotten: it's on its way home) */
export interface EnemyMemory extends ShipMemory {
  type: string;
  faction: string;
  elite: boolean;
  grade: number;
  plating?: number;
  state: 'patrol' | 'return';
  waypoint: XY;
  strafe: number;
  flank: number;
  /** Retuned (a leash it was sent with) */
  behaviour?: Behaviour;
}

/** What a hostile was doing (a boss's, remembered with it: Bosses.capture) */
export interface EnemyAi { state: 'patrol' | 'return'; waypoint: XY; home: XY; behaviour?: Behaviour }

/** A pack as remembered (times are world ticks); `nest` is its nest's id in the system */
export interface PackMemory {
  origin: PackOrigin;
  home: XY;
  members: EnemyMemory[];
  passive?: boolean;
  angryUntil?: number;
  zone?: string;
  size0?: number;
  nest?: string;
  group?: number;
  roam?: number;
  style?: RoamStyle;
  wp?: XY;
  wpUntil?: number;
  pauseUntil?: number;
  pace?: number;
  dest?: XY;
  settleUntil?: number;
}

export interface EnemyHost {
  readonly world: IWorld;
  tick(): number;
  /** Player entities in a system (alive) */
  players(systemNum: number): number[];
  /** Station entities in a system */
  stations(systemNum: number): number[];
  /** Where a ship is now (a distant one's route worked out: SimLod.where; none: its components) */
  where?(eid: number): XY;
  systemNum(id: string): number;
  systemId(num: number): string | undefined;
  /** Rough size of the playable area of a system (for picking spawn points) */
  systemRadius(num: number): number;
  /** Is this point too close to the star or a black hole */
  unsafe(num: number, x: number, y: number): boolean;
  reward(killer: number, xp: number, credits: number, assist: boolean, label: string): void;
  dropLoot(num: number, x: number, y: number, vx: number, vy: number, items: Bag): void;
  questKill(player: number, enemyType: string, faction: string): void;
  /** An armed station's battery (none: it doesn't fire) */
  stationDefence?(station: number): { weapon: string; turrets: number } | null | undefined;
  /** A station turret fired (for the effect) */
  stationBeam(num: number, station: number, target: number, turret: number): void;
  /** The other members of a player's party (entities), for shared kills */
  partyOf?(player: number): number[];
  /** Pilots who've been mending this one (Repair Beams: ships/features/support/Support.ts): they share its kills as its party does */
  supportersOf?(player: number): number[];
  /** Docked, or in a station's docking ring: hostiles leave them be */
  sheltered?(player: number): boolean;
  /** Docked (out of the fight: a freighter stops shooting back at it, enemies/defenders.ts) */
  docked?(eid: number): boolean;
  /** An arrival's effect: a gate spooling up (`warning`), or a ship coming through (`warpIn`) / launching (`launch`) */
  effect?(num: number, x: number, y: number, kind: 'warning' | 'warpIn' | 'launch'): void;
  /** A system's gates */
  gates?(num: number): { x: number; y: number }[];
  /** In the system's safe space (inner Sol): hostiles leave pilots there alone */
  safeAt?(num: number, x: number, y: number): boolean;
  /** A system's rock (a den's walls; none in open space): patrols keep off it */
  terrain?(num: number): Terrain | null | undefined;
  /** A pilot's decision, for the clients that run its body (CAPS.PILOTS: net/decisions/BodyNet.ts) */
  decide?(eid: number, op: number, args: readonly number[], state: BodyState): void;
  /** Custom enemies' moves (custom/): a shot from a ship (tuning.json weapons kind), a message to a system */
  fire?(owner: number, kind: string, x: number, y: number, angle: number, damageScale: number, opts?: { target?: number; speed?: number; seed?: string }): void;
  send?(systemNum: number, msg: import('@space-game/common').ServerMessage): void;
  /** Their moves on their clients' tick layers (CAPS.MOVES): a move's look and straight shells, not to the clients working them out */
  moveFx?(systemNum: number, eid: number, origin: import('@space-game/common').MoveOrigin, msg: import('@space-game/common').ServerMessage): void;
  moveShot?(owner: number, kind: string, x: number, y: number, angle: number, damageScale: number, speed: number | undefined, seed: string, origin: import('@space-game/common').MoveOrigin): void;
}

/** Party members this close to a kill share it */
const PARTY_SHARE_RANGE = 8000;

export type Behaviour = FactionDef['behaviour'];

interface Enemy {
  eid: number;
  type: string;
  faction: string;
  /** A boss (data/bosses.json id): its own behaviour, and Bosses handles its death */
  boss?: string;
  /** A weapons-range target (dev only: WeaponsRange.ts): never moves, turns or fires, pays nothing, drops nothing, counts for nothing */
  dummy?: boolean;
  behaviour?: Behaviour;
  pack: number;
  elite: boolean;
  /** Mk I-V: what it's built of, and its armour this many grades better (an elite's one more) */
  grade: number;
  plating?: number;
  /** Its ship rating as spawned (ships/rating.ts) */
  rating: number;
  state: 'patrol' | 'engage' | 'flee' | 'return';
  target: number;
  /** When it last took up its target, or its target last shot the pack (a chase far past the leash ends a while after) */
  engagedAt?: number;
  waypoint: { x: number; y: number };
  strafe: number;
  nextThink: number;
  /** Aim error (radians): its aim's off by up to this either way, re-rolled from `aimSeed` every 12 + id % 7 ticks */
  aimErr: number;
  aimSeed?: number;
  /** How far its guns really reach (worked out from its loadout the first time it fights), whether it lobs shells, and its main gun's round (its lead) */
  reach?: number;
  lobs?: boolean;
  lead?: AiLead;
  /** Where round a target it fights from, against the pack's side (radians): packs spread out to flank */
  flank: number;
  /** One target it goes for first while it stands, from any distance (a siege's sapper on a turret); `preyOnly`: it ignores everything else, even what shoots it (a runner on the bastion) */
  prey?: number;
  preyOnly?: boolean;
  /** One of a population's ships (its slot's ship k): its death is remembered there */
  pop?: { p: Population; slot: number; k: number };
  /** On patrol: the nearest it has come to its waypoint, and when it last got nearer (it picks another once it stalls) */
  wpBest?: number;
  wpSince?: number;
  wpRef?: XY;
}

/**
 * A pack slot of a population (common world/populations.ts): which group it is, which of its ships are alive (bit k),
 * which of those are elites, each one's part HP if it's hurt (shares of max), and the pack it's loaded as (none: a ghost)
 */
interface PopSlot { group: number; alive: number; elite: number; hp: (number[] | undefined)[]; pack?: number; leftAt?: number }

/** A nest's or zone's packs, ship by ship, there whether anyone's near or not (`next`: its next ship back, 0: it's full) */
interface Population {
  num: number; sysId: string; sp: Spawner; sys?: StarSystemData; nest?: SpawnNest; zone?: SpawnZone; key: string; slots: PopSlot[]; next: number; changed: boolean;
  /** Its nomads' ghosts drift towards where pilots were last seen in its band (common Lure; none: it has no nomads, or nobody's been) */
  lure?: Lure;
}

/** A system's populations on the wire (pops: `p` slots, `n` lures) */
export interface PopRows { p: number[]; n: number[] }

/** A population as remembered (SystemMemory.ts: the file's `populations`), times as world ticks */
export interface PopulationMemory { next?: number; slots: { group: number; alive: number; elite?: number; hp?: (number[] | null)[]; leftAt?: number }[]; lure?: { l1: number; s1: number; l2: number; s2: number } }

interface Pack {
  id: number;
  systemNum: number;
  home: { x: number; y: number };
  members: Set<number>;
  /** Last tick a pilot was in its zone (zone packs nobody's near are recycled: rules.idleDespawnSeconds) */
  lastSeen: number;
  /** A boss's (Bosses has it) */
  boss?: boolean;
  /** Sent by the system's own spawners (its roaming packs, a zone, a nest, a boss's escorts): what's remembered of a system left empty (SystemMemory.ts); the rest (events', jobs', tests') go with it */
  origin?: PackOrigin;
  /** Minds its own business until provoked (safe systems) */
  passive?: boolean;
  /** Provoked: fights back until this tick */
  angryUntil?: number;
  /** Belongs to a zone's own pool (SpawnZone id) */
  zone?: string;
  /** How many it set out with (its nerve breaks when most are gone) */
  size0?: number;
  /** Launched from a nest (`${system}:${nest id}`), as which of its groups; how far round it they patrol */
  nest?: string;
  nestDef?: SpawnNest;
  group?: number;
  roam?: number;
  /** How it gets about (Roaming.ts); loose and nomad packs move as one, to `wp` (re-picked by `wpUntil`), holding still until `pauseUntil` */
  style?: RoamStyle;
  wp?: XY;
  wpUntil?: number;
  pauseUntil?: number;
  /** Share of the time it thrusts on patrol (packs cruise at their own pace) */
  pace?: number;
  /** A nomad: where it's heading (its home slides there), or how long it stays where it is */
  dest?: XY;
  settleUntil?: number;
  /** Its ships (in id order) and their centroid as they ended the last tick: where a pack's fighters spread round from */
  cent?: { ids: number[]; x: number; y: number };
  /** A population's slot loaded as this pack */
  pop?: { p: Population; slot: number };
}

/** How fast a nest's ships come out of it (units a tick) */
const LAUNCH_SPEED = 5;
/** Drawn more than twice its leash from home, a hostile breaks off once its target hasn't shot the pack for this long (ticks) */
const CHASE_GRACE = 60 * 10;
/** How fast a nomad pack's home moves on (units a tick: about cruising speed) */
const NOMAD_SPEED = 2.2;

/** What Bosses plugs into the enemy AI */
export interface BossHooks {
  onDestroyed(eid: number, killer: number | undefined, ship: ShipState | undefined): void;
  name(eid: number): string | undefined;
  lair(boss: string): { system: string; x: number; y: number } | null;
  /** A standing outpost of a faction in a system, its packs launched from it */
  launcher(num: number, faction: string): { x: number; y: number; r: number } | null;
}

export class Enemies {
  private enemies = new Map<number, Enemy>();
  private packs = new Map<number, Pack>();
  private nextPack = 1;
  private nextSpawn = new Map<number, number>();
  /** When each of a nest's groups may be sent again once a pack of it is wiped out (`${system}:${id}:${group}`: its heavies) */
  private nestLock = new Map<string, number>();
  /** Every system's populations (its nests' and zones' packs, ship by ship), by system number; built on first use */
  private pops: Map<number, Population[]> | null = null;
  /** Time away mends a population's hurt ships by this share of each part's max a minute (SystemMemory's healPerMinute) */
  mendPerMinute = 0.04;
  private rng = mulberry32(0x5eed);
  bosses: BossHooks | null = null;
  /** For salvage: what structure drops as (materials) */
  econ: Economy | null = null;
  /** Pilotless ships hostiles attack like players (escorted freighters, outposts) */
  private wards = new Set<number>();
  /** Each armed station's turrets: the tick each may fire next, and what it's firing on */
  private batteries = new Map<number, { next: number[]; target: number[] }>();

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
  private readonly pilots: AiPilots;
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
  private readonly destroyed = new Set<number>();

  /** A kill's loot and salvaged parts: payout dice, from the server's secret (payoutDice.ts) */
  private readonly lootDice: Dice;

  /** `payout`: the server's payout dice (GameServer's; none: a secret of its own) */
  constructor(private host: EnemyHost, private ships: ShipBridge, private data: FactionsFile, private designs: Record<string, Blueprint>, payout: PayoutDice = new PayoutDice()) {
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
    this.ships.setController(eid, (id, ship) => this.fly(e, ship));
  }

  /** What the enemy AI would do with this ship this tick (a boss's brain starts from it: its target, aim and guns) */
  pilot(eid: number, ship: ShipState): PilotOrders | null {
    const e = this.enemies.get(eid);
    return e ? this.fly(e, ship, false) : null;
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

  /**
   * What a hostile is doing, coarsely, for a distant one (ships/SimLod.ts),
   * from where its route has it (`at`, at the tick its last leg ended, with
   * its own dice): on patrol, flying from point to point round its home at
   * its pack's pace (as fly() picks them; a home that stays put, a patrol the
   * map can follow on its own), a loose or nomad pack's lead
   * on the pack's shared wander and the rest keeping their places off it;
   * going home, flying straight back inside its leash; fighting or fleeing,
   * null (it stays live). undefined: not a hostile.
   */
  intent(eid: number, at: Plan): Intent | null | undefined {
    const e = this.enemies.get(eid);
    if (!e) return undefined;
    if (e.dummy) return null;
    if (e.state === 'engage' || e.state === 'flee' || e.target >= 0) return null;
    const now = at.tick;
    const b = e.behaviour ?? this.data.factions[e.faction].behaviour;
    const pack = this.packs.get(e.pack);
    const x = at.x, y = at.y;
    const home = pack ? this.homeAt(pack, now) : { x, y };
    if (e.state === 'return') {
      if (dhypot(x - home.x, y - home.y) >= b.leash * 0.5) return { kind: 'goto', x: home.x, y: home.y, arrive: b.leash * 0.5 };
      e.state = 'patrol';
    }
    let until: number | undefined;
    if (pack?.nestDef && pack.style !== 'anchored') {
      const lead = pack.members.values().next().value ?? eid, k = [...pack.members].indexOf(eid);
      const off = { x: dcos(k * 2.4) * 380, y: dsin(k * 2.4) * 380 };
      if (k > 0 && this.ships.isDormant(lead)) return { kind: 'follow', lead, dx: off.x, dy: off.y };
      const wp = this.wander(pack, lead, now, k <= 0 ? at : undefined, at.rng);
      e.waypoint = k <= 0 ? wp : { x: wp.x + off.x, y: wp.y + off.y };
      until = pack.wpUntil;
    } else if (!pack?.nestDef) {
      // Round a home that stays put: a patrol worked out by its own dice (the map's told it once: SimLod, common farRoute.ts)
      return { kind: 'patrol', x: home.x, y: home.y, roam: pack?.roam ?? 2400, pace: pack?.pace ?? 0.58, wp: e.waypoint };
    } else if (dhypot(x - e.waypoint.x, y - e.waypoint.y) < 300) {
      e.waypoint = anchoredWaypoint({ x, y }, home, pack?.roam ?? 2400, at.rng, this.clearRun(eid));
    }
    // (Packs cruise in pulses at their own pace, and a loose one stops a while now and then)
    const paused = now < (pack?.pauseUntil ?? 0);
    if (paused) return { kind: 'hold', until: pack!.pauseUntil };
    return { kind: 'goto', x: e.waypoint.x, y: e.waypoint.y, arrive: 300, pace: pack?.pace ?? 0.58, until };
  }

  /**
   * Whether a ship can fly straight from one place to another in its system without touching rock: its centre's line
   * and both its sides', and room for it where it ends up (undefined: its system has none, any run is clear)
   */
  private clearRun(eid: number): ClearRun | undefined {
    const rock = this.host.terrain?.(InSystem.systemId[eid]);
    if (!rock?.pieces.length) return undefined;
    const r = terrainRadius(this.ships.get(eid)?.derived.radius ?? Radius.value[eid] ?? 40) + 150;
    return (a, b) => {
      if (insideTerrain(rock, b.x, b.y, r)) return false;
      const d = dhypot(b.x - a.x, b.y - a.y) || 1, nx = (-(b.y - a.y) / d) * r, ny = ((b.x - a.x) / d) * r;
      return rayTerrain(rock, a.x, a.y, b.x, b.y) >= 1 && rayTerrain(rock, a.x + nx, a.y + ny, b.x + nx, b.y + ny) >= 1 && rayTerrain(rock, a.x - nx, a.y - ny, b.x - nx, b.y - ny) >= 1;
    };
  }

  /** Which way a nest's ships come out of it: anywhere, or (one with a post, a heap against a den's wall) out towards its post */
  private launchAngle(n: SpawnNest | undefined, at: XY | undefined): number {
    const roll = this.rng();
    if (!n?.post || !at) return roll * Math.PI * 2;
    return datan2(n.post.y - at.y, n.post.x - at.x) + (roll - 0.5) * 1.2;
  }

  /**
   * A patrolling ship among rock that hasn't got any nearer its waypoint for PATROL_STALL (holding still doesn't count):
   * held up on a wall (or a boulder its straight run didn't see). In open space nothing holds a patrol up for good
   */
  private stalled(e: Enemy, x: number, y: number, now: number, pauseUntil: number): boolean {
    const d = dhypot(x - e.waypoint.x, y - e.waypoint.y);
    if (now < pauseUntil || e.wpRef !== e.waypoint || e.wpBest === undefined || d < e.wpBest - 150) {
      e.wpRef = e.waypoint; e.wpBest = d; e.wpSince = now;
      return false;
    }
    return now - (e.wpSince ?? now) >= PATROL_STALL;
  }

  /** Where a pack's home is at tick t: a nest's goes round with it (tendNest keeps it so while it's watched), a nomad's is where it's got to */
  private homeAt(p: Pack, t: number): XY {
    const n = p.nestDef;
    return n?.place && p.style !== 'nomad' ? nestPost(n, n.place, n.planets, t) : p.home;
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
   * A weapons-range target (dev only, WeaponsRange.ts): a real enemy ship that is held where it is, aims nowhere and fires
   * nothing (pinned, no AI), takes damage as any ship does, and pays nothing when it dies (onDestroyed). Its own pack,
   * never remembered with the system. `hp` scales its hull as a boss's (bosses.json) does, `core` hardens its core.
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
    this.ships.pin(eid);
    return eid;
  }

  /** Let a range target fly (or hold again): a slow sweep across its spot, else pinned where it stands */
  setTargetMoving(eid: number, to: { x: number; y: number } | null): void {
    if (!this.enemies.get(eid)?.dummy) return;
    if (to) { this.ships.pin(eid, false); this.ships.setAutopilot(eid, { x: to.x, y: to.y, arriveRadius: 60 }); }
    else { this.ships.setAutopilot(eid, null); this.ships.pin(eid); }
  }

  isTarget(eid: number): boolean {
    return !!this.enemies.get(eid)?.dummy;
  }

  /** One of a pack's ships: its design in its grade (an elite's plated a grade better, and tougher), its faction's hull and guns, and its AI (-1: no such design) */
  private spawnShip(pack: Pack, type: string, faction: string, grade: number, plating: number, elite: boolean, x: number, y: number, angle: number | null, flank: number): number {
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
    this.ships.setController(eid, (id, ship) => this.fly(e, ship));
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
        this.popLost(e, now);
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
      for (const list of this.populations().values()) for (const pop of list) this.regrow(pop, now);
      for (const [sysId, sp] of Object.entries(this.data.spawns)) {
        const num = this.host.systemNum(sysId);
        // (Its system's pass: crowd dilation, sim/SystemClocks.ts)
        if (num < 0 || !SimPass.on(num)) continue;
        const players = this.host.players(num);
        const all = [...this.packs.values()].filter((p) => p.systemNum === num && !p.boss);
        const packs = all.filter((p) => !p.zone && !p.nest);
        // Nests' and zones' packs: ghosts a pilot comes near are loaded where they are, loaded ones nobody's near any more go back to ghosts
        this.tendPops(num, players, now);
        // (A zone's own packs are its population; its packs from elsewhere, an event's say, recycled once nobody's near)
        for (const z of sp.zones ?? []) {
          const inside = players.some((p) => { const r = dhypot(Position.x[p] - (z.x ?? 0), Position.y[p] - (z.y ?? 0)); return r > z.inner - 3000 && r < z.outer + 3000; });
          if (inside) for (const p of all) if (p.zone === z.id) p.lastSeen = now;
        }
        for (const n of sp.nests ?? []) this.tendNest(num, n, players, all, now);
        for (const p of all) {
          if (p.zone && !p.pop && players.length && now - p.lastSeen > this.data.rules.idleDespawnSeconds * 60 && [...p.members].every((m) => this.ships.isDormant(m))) {
            for (const m of p.members) this.ships.removeShip(m);
            this.packs.delete(p.id);
          }
        }
        if (!players.length) continue;
        if (packs.length >= sp.packs || now < (this.nextSpawn.get(num) ?? 0)) continue;
        this.arrive(num, this.pickGroup(sp.groups), players);
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
    if (now % 3 === 0) this.stationDefence(now);
  }

  // ---------------------------------------------------------------------------
  // Nests
  // ---------------------------------------------------------------------------

  /**
   * A nest, every half second: its loaded packs' home follows it round its
   * orbit, and a loaded nomad near a pilot travels on (its home slides to
   * where it's heading). Its packs are its population (below): they're out
   * round it whether anyone's near or not, and nothing is launched here.
   */
  private tendNest(num: number, n: SpawnNest, players: number[], all: Pack[], now: number): void {
    if (!n.place) return;
    const key = `${num}:${n.id}`;
    const at = nestPost(n, n.place, n.planets, now);
    const wake = this.loadRange();
    for (const p of all) {
      if (p.nest !== key) continue;
      // A nomad is awake while a pilot is near it, wherever it's got to; the rest go where the nest goes
      if (p.style === 'nomad') {
        if (players.some((q) => dhypot(Position.x[q] - p.home.x, Position.y[q] - p.home.y) < wake)) this.steerNomad(num, n, p, players, now);
        continue;
      }
      p.home = at;
    }
  }

  // ---------------------------------------------------------------------------
  // Populations: every nest's and zone's packs, ship by ship (common world/populations.ts)
  // ---------------------------------------------------------------------------

  /** How close a pilot comes to a ghost pack before it's loaded (rules.nestWake); it's put back once none is within 1.25 times this */
  private loadRange(): number {
    return this.data.rules.nestWake ?? 36000;
  }

  /** Every system's populations, built the first time they're wanted: a fresh world's are full, their groups from the seed */
  private populations(): Map<number, Population[]> {
    if (this.pops) return this.pops;
    const out = new Map<number, Population[]>();
    for (const [sysId, spawns] of Object.entries(this.data.spawns)) {
      const num = this.host.systemNum(sysId);
      if (num < 0) continue;
      const sys = spawns.nests?.find((n) => n.sys)?.sys;
      const list: Population[] = [];
      for (const sp of spawnersOf(spawns, sys)) {
        const groups = seedGroups(sysId, sp);
        const slots = groups.map((g): PopSlot => {
          const n = g >= 0 ? sp.def.groups[g].ships.length : 0;
          return { group: g, alive: n ? (1 << n) - 1 : 0, elite: n && this.rng() < this.data.rules.eliteChance ? 1 : 0, hp: [] };
        });
        list.push({
          num, sysId, sp, sys, key: `${num}:${sp.def.id}`, slots, next: 0, changed: true,
          ...(sp.kind === 'nest' ? { nest: spawns.nests!.find((q) => q.id === sp.def.id) } : { zone: spawns.zones!.find((q) => q.id === sp.def.id) }),
        });
      }
      if (list.length) out.set(num, list);
    }
    this.pops = out;
    return out;
  }

  /**
   * Between one ship coming back and the next (ticks): its spawner's respawnSeconds shared out over the ships of the
   * pack the next one goes to (a pack refills in about respawnSeconds, as one pack a respawnSeconds always did, but a
   * ship at a time)
   */
  private interval(pop: Population): number {
    const every = ((pop.nest?.respawnSeconds ?? pop.zone?.respawnSeconds) ?? this.data.rules.respawnSeconds) * 60;
    const i = this.nextSlot(pop), g = i >= 0 ? pop.sp.def.groups[pop.slots[i].group] : undefined;
    const size = g?.ships.length ?? Math.max(1, Math.round(pop.sp.def.groups.reduce((n, q) => n + q.ships.length, 0) / Math.max(1, pop.sp.def.groups.length)));
    return Math.max(60, Math.round(every / Math.max(1, size)));
  }

  /** The slot the next ship back goes to: a hurt pack's first, then a wiped-out one (-1: it's full) */
  private nextSlot(pop: Population): number {
    const i = pop.slots.findIndex((s) => s.group >= 0 && s.alive && s.alive !== this.full(pop, s));
    return i >= 0 ? i : pop.slots.findIndex((s) => !s.alive);
  }

  private full(pop: Population, s: PopSlot): number {
    const n = s.group >= 0 ? pop.sp.def.groups[s.group]?.ships.length ?? 0 : 0;
    return n ? (1 << n) - 1 : 0;
  }

  private short(pop: Population): boolean {
    return pop.slots.some((s) => s.group < 0 || s.alive !== this.full(pop, s));
  }

  /**
   * A population short of ships gets one back every interval (`next`), the first an interval after it was first
   * short: a hurt pack's missing ships first, then a wiped-out one, as a group by weight (its heavies not until
   * they're rebuilt, `nestLock`). However long it's been (a system nobody's in, a restart), it's caught up on here.
   */
  private regrow(pop: Population, now: number): void {
    if (!this.short(pop)) { pop.next = 0; return; }
    if (!pop.next) pop.next = now + this.interval(pop);
    for (let guard = 0; pop.next <= now && guard < 1000 && this.short(pop); guard++) {
      this.regrowOne(pop, pop.next, now);
      pop.next += this.interval(pop);
    }
    if (!this.short(pop)) pop.next = 0;
  }

  private regrowOne(pop: Population, at: number, now: number): void {
    const i = this.nextSlot(pop);
    if (i < 0) return;
    const slot = pop.slots[i], empty = !slot.alive;
    if (empty) {
      const taken = pop.slots.filter((s, j) => j !== i && s.alive).map((s) => s.group);
      const g = pickGroup(pop.sp.def.groups, taken, this.rng, (q) => at >= (this.nestLock.get(`${pop.key}:${q}`) ?? -Infinity));
      if (g < 0) return;
      slot.group = g; slot.elite = 0; slot.hp = [];
    }
    const n = pop.sp.def.groups[slot.group].ships.length;
    let k = 0;
    while (k < n && slot.alive & (1 << k)) k++;
    if (k >= n) return;
    slot.alive |= 1 << k;
    slot.elite = k === 0 && this.rng() < this.data.rules.eliteChance ? slot.elite | 1 : slot.elite & ~(1 << k);
    slot.hp[k] = undefined;
    pop.changed = true;
    // Loaded: it comes out of the nest and joins its pack; a wiped-out pack's first ship with a pilot near the nest is
    // seen launching; otherwise its ghost is a ship stronger (loaded where it is once a pilot's near)
    const pack = slot.pack !== undefined ? this.packs.get(slot.pack) : undefined;
    if (pack) this.launchInto(pop, i, pack, k, now);
    else if (empty && now - at < 60 && pop.nest?.place && this.host.players(pop.num).some((p) => {
      const c = nestPosition(pop.nest!.place!, pop.nest!.planets, now);
      return dhypot(Position.x[p] - c.x, Position.y[p] - c.y) < this.loadRange();
    })) this.loadSlot(pop, i, now, true);
  }

  /** One of a population's ships made real in this pack: its type, faction, grade, elite, its nest's leash and keenness */
  private spawnPopShip(pop: Population, i: number, pack: Pack, k: number, x: number, y: number, angle: number): number {
    const slot = pop.slots[i], g = pop.sp.def.groups[slot.group] as SpawnGroup;
    const flank = k === 0 ? 0 : (k % 2 ? 1 : -1) * Math.min(1.6, 0.55 * Math.ceil(k / 2));
    const eid = this.spawnShip(pack, g.ships[k], g.faction, this.gradeOf(pop.num), g.plating ?? 0, !!(slot.elite & (1 << k)), x, y, angle, flank);
    if (eid < 0) return -1;
    const e = this.enemies.get(eid)!;
    e.pop = { p: pop, slot: i, k };
    const n = pop.nest, f = this.data.factions[g.faction];
    if (n && f) {
      // A loose pack's leash reaches past where it strays; a nomad's is round wherever it's got to
      const roam = n.roam ?? 2400, leash = pack.style === 'loose' ? Math.max(n.leash ?? f.behaviour.leash ?? 0, roam * LOOSE_REACH + 2500) : n.leash;
      if (leash || n.aggro) e.behaviour = { ...f.behaviour, ...(leash ? { leash } : {}), ...(n.aggro ? { aggro: n.aggro } : {}) };
    }
    return eid;
  }

  /** A ship back while its pack's loaded: out of the nest's hull, seen launching (a zone's: where its pack's ghost would be) */
  private launchInto(pop: Population, i: number, pack: Pack, k: number, now: number): void {
    const n = pop.nest;
    const at = n?.place ? nestPosition(n.place, n.planets, now) : ghostCentre(pop.sys, pop.sysId, pop.sp, i, slotStyle(pop.sp, pop.slots[i].group), now, pop.lure);
    const a = this.launchAngle(n, at), c = dcos(a), s = dsin(a);
    const from = n?.place ? NEST_RADIUS : 0, x = at.x + c * from, y = at.y + s * from;
    if (n?.place && !n.place.hidden) this.host.effect?.(pop.num, x, y, 'launch');
    const eid = this.spawnPopShip(pop, i, pack, k, x, y, a);
    if (eid < 0) { pop.slots[i].alive &= ~(1 << k); return; }
    Velocity.x[eid] = c * LAUNCH_SPEED; Velocity.y[eid] = s * LAUNCH_SPEED;
    const roam = pack.roam ?? 2400;
    // (A posted nest's ships go out to patrol round its post, by a way clear of rock)
    this.enemies.get(eid)!.waypoint = n?.post ? anchoredWaypoint({ x, y }, this.homeAt(pack, now), roam, this.rng, this.clearRun(eid)) : { x: at.x + c * roam * 0.6, y: at.y + s * roam * 0.6 };
    pack.size0 = Math.max(pack.size0 ?? 0, pack.members.size);
  }

  /**
   * A ghost pack made real: each of its live ships exactly where its ghost is (common ghostShip), hurt as it was
   * (mended for the time since it was put back), on patrol; `launch`: a wiped-out pack's first ship back, seen
   * coming out of the nest's hull instead
   */
  private loadSlot(pop: Population, i: number, now: number, launch = false, seen = false): void {
    const slot = pop.slots[i], g = pop.sp.def.groups[slot.group] as SpawnGroup | undefined;
    if (!g || !slot.alive) return;
    const style = slotStyle(pop.sp, slot.group), n = pop.nest, roam = pop.sp.def.roam ?? 2400;
    const nestAt = n?.place ? nestPosition(n.place, n.planets, now) : undefined;
    const c = ghostCentre(pop.sys, pop.sysId, pop.sp, i, style, now, pop.lure);
    const pack: Pack = {
      id: this.nextPack++, systemNum: pop.num, home: n?.place && style !== 'nomad' ? nestPost(n, n.place, n.planets, now) : { ...c }, members: new Set(), lastSeen: now,
      passive: g.passive, origin: n ? 'nest' : 'zone', pop: { p: pop, slot: i }, roam, pace: 0.4 + this.rng() * 0.45,
      ...(pop.zone ? { zone: pop.zone.id } : {}),
      ...(n ? { nest: pop.key, nestDef: n, group: slot.group, style } : {}),
    };
    this.packs.set(pack.id, pack);
    const away = now - (slot.leftAt ?? now);
    const heal = away >= LIFE_ASLEEP_RESET ? 1 : (away / 3600) * this.mendPerMinute;
    const a0 = this.launchAngle(n, nestAt);
    for (let k = 0; k < g.ships.length; k++) {
      if (!(slot.alive & (1 << k))) continue;
      const out = launch && nestAt;
      const at = out ? { x: nestAt.x + dcos(a0) * (NEST_RADIUS + k * 170), y: nestAt.y + dsin(a0) * (NEST_RADIUS + k * 170) } : ghostShip(c, k);
      const h = out ? a0 : this.rng() * Math.PI * 2;
      const eid = this.spawnPopShip(pop, i, pack, k, at.x, at.y, h);
      if (eid < 0) { slot.alive &= ~(1 << k); continue; }
      const v = out ? LAUNCH_SPEED : 0;
      Velocity.x[eid] = dcos(h) * v; Velocity.y[eid] = dsin(h) * v;
      const hp = slot.hp[k];
      if (hp) restoreHp(this.ships, eid, hp, heal);
      // (Loaded within a pilot's sight, an arrival as anyone's: it comes in as a warp-in looks)
      if (seen && !out) this.host.effect?.(pop.num, at.x, at.y, 'warpIn');
      this.enemies.get(eid)!.waypoint = { ...c };
    }
    slot.hp = []; slot.leftAt = undefined;
    pop.changed = true;
    if (!pack.members.size) { this.packs.delete(pack.id); return; }
    pack.size0 = pack.members.size;
    slot.pack = pack.id;
    if (launch && nestAt && n?.place && !n.place.hidden) this.host.effect?.(pop.num, nestAt!.x + dcos(a0) * NEST_RADIUS, nestAt!.y + dsin(a0) * NEST_RADIUS, 'launch');
    if (n) {
      pack.wp = clampBand(launch && nestAt ? { x: nestAt.x + dcos(a0) * roam, y: nestAt.y + dsin(a0) * roam } : c, n.band ?? { min: 0, max: 1e9 });
      pack.wpUntil = now + 60 * 20;
      if (style === 'nomad') pack.settleUntil = now + 60 * 15;
    }
  }

  /** A loaded pack nobody's near any more, all asleep and none fighting, back to a ghost (each ship's hurt kept) */
  private unloadSlot(pop: Population, i: number, now: number): void {
    const slot = pop.slots[i], pack = slot.pack !== undefined ? this.packs.get(slot.pack) : undefined;
    slot.pack = undefined;
    pop.changed = true;
    if (!pack) return;
    for (const m of pack.members) {
      const e = this.enemies.get(m), ship = this.ships.get(m);
      if (e?.pop && ship) slot.hp[e.pop.k] = hpShares(ship);
      // (Out of the books first: put away, not lost)
      this.enemies.delete(m); this.pilots.forget(m); this.custom.forget(m);
      if (this.ships.has(m)) this.ships.removeShip(m);
    }
    this.packs.delete(pack.id);
    slot.leftAt = now;
  }

  /** A system's ghosts a pilot's near are loaded; loaded packs nobody's near, all asleep and calm, go back to ghosts */
  private tendPops(num: number, players: number[], now: number): void {
    const list = this.populations().get(num);
    if (!list) return;
    const R = this.loadRange(), far = R * 1.25;
    const near = (x: number, y: number, r: number) => players.some((p) => dhypot(Position.x[p] - x, Position.y[p] - y) < r);
    for (const pop of list) {
      pop.slots.forEach((slot, i) => {
        if (slot.pack !== undefined) {
          const pack = this.packs.get(slot.pack);
          if (!pack) { slot.pack = undefined; pop.changed = true; return; }
          // (Kept while anyone's within 1.25 times the load range of any of its ships, or any of them is fighting)
          for (const m of pack.members) {
            const e = this.enemies.get(m), at = this.host.where?.(m) ?? { x: Position.x[m], y: Position.y[m] };
            if (near(at.x, at.y, far) || (e && (e.state === 'engage' || e.state === 'flee' || e.target >= 0))) return;
          }
          this.unloadSlot(pop, i, now);
          return;
        }
        if (!slot.alive || !players.length) return;
        const c = ghostCentre(pop.sys, pop.sysId, pop.sp, i, slotStyle(pop.sp, slot.group), now, pop.lure);
        if (near(c.x, c.y, R)) this.loadSlot(pop, i, now, false, near(c.x, c.y, FOCUS_RANGE));
      });
      this.tendLure(pop, players, now);
    }
  }

  /**
   * A spawner with nomads: its lure follows its band's pilots, by sector (common Lure): the sector of the pilot in its
   * band nearest its first nomad's ghost. A new sector starts a new lure from now (the clients are told: pops `n`);
   * nobody in the band leaves it as it is. Pilots' places aren't the clients' to know past their view: a sector a
   * sixteenth of the way round changes seldom, and is all they're told.
   */
  private tendLure(pop: Population, players: number[], now: number): void {
    const band = pop.sp.band;
    const slot = pop.slots.findIndex((s) => s.group >= 0 && slotStyle(pop.sp, s.group) === 'nomad');
    if (!band || slot < 0) return;
    const inBand = players.filter((p) => { const r = dhypot(Position.x[p], Position.y[p]); return r > band.min - 4000 && r < band.max + 4000; });
    if (!inBand.length) return;
    const c = ghostCentre(pop.sys, pop.sysId, pop.sp, slot, 'nomad', now, pop.lure);
    let best = inBand[0], bd = Infinity;
    for (const p of inBand) { const d = dhypot(Position.x[p] - c.x, Position.y[p] - c.y); if (d < bd) { bd = d; best = p; } }
    const sector = lureSector(Position.x[best], Position.y[best]);
    const l = pop.lure ?? { l1: -1, s1: 0, l2: -1, s2: 0 };
    if (sector === l.l2) return;
    pop.lure = { l1: l.l2, s1: l.s2, l2: sector, s2: Math.floor(now / GHOST_STEP) };
    pop.changed = true;
  }

  /** A population's ship is gone (shot down, or gone some other way): its slot remembers, and the spawner starts on its replacement */
  private popLost(e: Enemy, now: number): void {
    const at = e.pop;
    if (!at) return;
    e.pop = undefined;
    const pop = at.p, slot = pop.slots[at.slot];
    slot.alive &= ~(1 << at.k);
    slot.elite &= ~(1 << at.k);
    slot.hp[at.k] = undefined;
    pop.changed = true;
    if (!pop.next) pop.next = now + this.interval(pop);
    // (A wiped-out heavy pack's group isn't sent again until it's rebuilt)
    const g = pop.sp.def.groups[slot.group] as SpawnGroup | undefined;
    if (!slot.alive && g?.respawnSeconds) this.nestLock.set(`${pop.key}:${slot.group}`, now + g.respawnSeconds * 60);
  }

  /**
   * A system's populations as the wire has them: `p` [spawner index, slots, ...a code a slot] for each (common
   * packPopSlot), `n` its nomads' lures (common packLure)
   */
  popRows(num: number): PopRows {
    const out: PopRows = { p: [], n: [] };
    for (const pop of this.populations().get(num) ?? []) this.popRow(pop, out);
    return out;
  }

  private popRow(pop: Population, out: PopRows): void {
    out.p.push(pop.sp.index, pop.slots.length, ...pop.slots.map((s) => packPopSlot(s.group, s.pack !== undefined, s.alive)));
    if (pop.lure) packLure(out.n, pop.sp.index, pop.lure);
  }

  /** What's changed in each system's populations since last asked (a death, a ship back, a pack loaded or put back, a lure moved): its rows */
  popChanges(): Map<number, PopRows> {
    const out = new Map<number, PopRows>();
    for (const [num, list] of this.populations()) {
      for (const pop of list) {
        if (!pop.changed) continue;
        pop.changed = false;
        let rows = out.get(num);
        if (!rows) out.set(num, (rows = { p: [], n: [] }));
        this.popRow(pop, rows);
      }
    }
    return out;
  }

  /** A population's slots now (tests, tools): each one's group, ships alive (bit k), and whether it's loaded */
  population(systemNum: number, id: string): { next: number; slots: { group: number; alive: number; loaded: boolean; ships: number[] }[] } | null {
    const pop = this.populations().get(systemNum)?.find((p) => p.sp.def.id === id);
    if (!pop) return null;
    return { next: pop.next, slots: pop.slots.map((s) => ({ group: s.group, alive: s.alive, loaded: s.pack !== undefined, ships: s.pack !== undefined ? [...(this.packs.get(s.pack)?.members ?? [])] : [] })) };
  }

  /** Where a population's slot's pack is while it's a ghost, at `tick` (tests, tools: the clients work out the same) */
  ghostAt(systemNum: number, id: string, slot: number, tick = this.host.tick()): XY | null {
    const pop = this.populations().get(systemNum)?.find((p) => p.sp.def.id === id), s = pop?.slots[slot];
    if (!pop || !s || s.group < 0) return null;
    return ghostCentre(pop.sys, pop.sysId, pop.sp, slot, slotStyle(pop.sp, s.group), tick, pop.lure);
  }

  /** Every population as remembered (the memory file): times as world ticks; a loaded pack's ships as hurt as they are now */
  popMemory(offset: number): Record<string, Record<string, PopulationMemory>> {
    const out: Record<string, Record<string, PopulationMemory>> = {};
    for (const list of this.populations().values()) {
      for (const pop of list) {
        const pack = (s: PopSlot) => (s.pack !== undefined ? this.packs.get(s.pack) : undefined);
        (out[pop.sysId] ??= {})[pop.sp.def.id] = {
          ...(pop.next ? { next: pop.next + offset } : {}),
          ...(pop.lure ? { lure: { ...pop.lure, s1: pop.lure.s1 * GHOST_STEP + offset, s2: pop.lure.s2 * GHOST_STEP + offset } } : {}),
          slots: pop.slots.map((s) => {
            const hp = [...s.hp];
            for (const m of pack(s)?.members ?? []) { const e = this.enemies.get(m), ship = this.ships.get(m); if (e?.pop && ship) hp[e.pop.k] = hpShares(ship); }
            const kept = hp.some((h) => h) ? { hp: hp.map((h) => h ?? null) } : {};
            return { group: s.group, alive: s.alive, ...(s.elite ? { elite: s.elite } : {}), ...kept, ...(s.leftAt !== undefined ? { leftAt: s.leftAt + offset } : {}) };
          }),
        };
      }
    }
    return out;
  }

  /** Populations back as remembered (a spawner's data changed since: what still fits; a new one's full) */
  setPopMemory(data: Record<string, Record<string, PopulationMemory>> | undefined, offset: number): void {
    for (const list of this.populations().values()) {
      for (const pop of list) {
        const m = data?.[pop.sysId]?.[pop.sp.def.id];
        if (!m || !Array.isArray(m.slots)) continue;
        pop.slots.forEach((slot, i) => {
          const r = m.slots[i];
          if (!r || typeof r.group !== 'number' || r.group >= pop.sp.def.groups.length) return;
          slot.group = r.group;
          const n = r.group >= 0 ? pop.sp.def.groups[r.group].ships.length : 0;
          slot.alive = (r.alive | 0) & (n ? (1 << n) - 1 : 0);
          slot.elite = (r.elite ?? 0) & slot.alive;
          slot.hp = (r.hp ?? []).map((h) => (Array.isArray(h) ? h : undefined));
          slot.leftAt = typeof r.leftAt === 'number' ? r.leftAt - offset : undefined;
          slot.pack = undefined;
        });
        pop.next = typeof m.next === 'number' ? m.next - offset : 0;
        const l = m.lure;
        if (l && [l.l1, l.s1, l.l2, l.s2].every((v) => typeof v === 'number')) pop.lure = { l1: l.l1, s1: Math.floor((l.s1 - offset) / GHOST_STEP), l2: l.l2, s2: Math.floor((l.s2 - offset) / GHOST_STEP) };
        pop.changed = true;
      }
    }
  }

  /** Places a pack might head for: planets, belts, stations' outskirts, gates, the system's other nests (in its band) */
  private places(num: number, n: SpawnNest, now: number, rng = this.rng): XY[] {
    const extra: XY[] = [];
    const out = (x: number, y: number, d: number) => { const r = dhypot(x, y) || 1; extra.push({ x: x + (x / r) * d, y: y + (y / r) * d }); };
    for (const st of this.host.stations(num)) out(Position.x[st], Position.y[st], 9000);
    for (const g of this.host.gates?.(num) ?? []) out(g.x, g.y, 6000);
    for (const o of this.data.spawns[this.host.systemId(num) ?? '']?.nests ?? []) if (o !== n && o.place) extra.push(nestPosition(o.place, o.planets, now));
    return placesOfInterest(n.sys, n.planets, now, extra, n.band ?? { min: 0, max: 1e9 }, rng);
  }

  /** A nomad pack, every half second while awake: its home slides on to where it's heading; settled a while, it picks somewhere new */
  private steerNomad(num: number, n: SpawnNest, p: Pack, players: number[], now: number): void {
    const band = n.band ?? { min: 0, max: 1e9 };
    if (p.dest) {
      const { at, arrived } = stepRound(p.home, p.dest, NOMAD_SPEED * 30);
      p.home = clampBand(at, band);
      if (arrived) { p.dest = undefined; p.settleUntil = now + 60 * (40 + this.rng() * 80); p.wpUntil = 0; }
      return;
    }
    if (now < (p.settleUntil ?? 0)) return;
    p.dest = nomadDestination(p.home, this.places(num, n, now), players.map((q) => ({ x: Position.x[q], y: Position.y[q] })), band, this.rng);
  }

  /**
   * A loose or nomad pack's waypoint (the pack's, shared): re-picked once its
   * lead gets there or it's taken too long. `from`: where the lead is, if not
   * its components (a distant one's route: SimLod), with that route's dice.
   */
  private wander(p: Pack, lead: number, now: number, from?: XY, rng = this.rng): XY {
    const n = p.nestDef!;
    // Travelling: a little ahead of its home, on the way
    if (p.style === 'nomad' && p.dest) return stepRound(p.home, p.dest, 2500).at;
    const at = from ? { x: from.x, y: from.y } : { x: Position.x[lead], y: Position.y[lead] };
    if (p.wp && now < (p.wpUntil ?? 0) && dhypot(at.x - p.wp.x, at.y - p.wp.y) > 600) return p.wp;
    const lane = p.style !== 'nomad' && n.place && n.place.around === undefined ? n.place.orbit.radius : 0;
    const w = looseWaypoint(at, this.homeAt(p, now), p.roam ?? 2400, n.bias ?? 0.5, n.band ?? { min: 0, max: 1e9 }, this.places(p.systemNum, n, now, rng), lane, rng);
    p.wp = w.wp;
    p.wpUntil = now + 60 * (25 + rng() * 35);
    if (w.pause) p.pauseUntil = now + 60 * (6 + rng() * 10);
    return p.wp;
  }

  /** A nest's packs out now (their ships), and where it is (tests, tools) */
  nest(systemNum: number, id: string): { x: number; y: number; packs: number[][] } | null {
    const sp = this.data.spawns[this.host.systemId(systemNum) ?? ''];
    const n = sp?.nests?.find((q) => q.id === id);
    if (!n?.place) return null;
    const key = `${systemNum}:${id}`;
    const packs = [...this.packs.values()].filter((p) => p.nest === key).map((p) => [...p.members]);
    return { ...nestPosition(n.place, n.planets, this.host.tick()), packs };
  }

  // ---------------------------------------------------------------------------
  // Memory: a system left empty is put away, and comes back as it was (SystemMemory.ts)
  // ---------------------------------------------------------------------------

  /**
   * A system's packs as they are: the ones its own spawners sent (PackOrigin),
   * each ship where it is (`where`: a distant one's route worked out) and every
   * part's HP; times as world ticks (`offset` on). `evict`: and every pack
   * there is taken out of the world (the rest, an event's or a job's, go as
   * they always did when a system emptied), never counted as wiped out (no
   * nest starts rebuilding). A boss's own pack is Bosses' to remember.
   */
  capture(num: number, where: (eid: number) => FarPose, offset: number, evict: boolean): PackMemory[] {
    const out: PackMemory[] = [];
    const w = (t?: number) => (t === undefined ? undefined : t + offset);
    for (const [id, p] of this.packs) {
      if (p.systemNum !== num || p.boss) continue;
      // (A population's pack is its population's: put away, it's a ghost again)
      if (p.pop) { if (evict) this.unloadSlot(p.pop.p, p.pop.slot, this.host.tick()); continue; }
      const members: EnemyMemory[] = [];
      for (const m of p.origin ? p.members : []) {
        const e = this.enemies.get(m), ship = this.ships.get(m);
        if (!e || !ship) continue;
        members.push({
          ...shipMemory(ship, where(m)), type: e.type, faction: e.faction, elite: e.elite, grade: e.grade, plating: e.plating,
          state: e.state === 'patrol' ? 'patrol' : 'return', waypoint: { ...e.waypoint }, strafe: e.strafe, flank: e.flank, ...(e.behaviour ? { behaviour: { ...e.behaviour } } : {}),
        });
      }
      if (members.length) {
        out.push({
          origin: p.origin!, home: { ...p.home }, members, passive: p.passive, angryUntil: w(p.angryUntil), zone: p.zone, size0: p.size0,
          nest: p.nest?.slice(p.nest.indexOf(':') + 1), group: p.group, roam: p.roam, style: p.style, wp: p.wp, wpUntil: w(p.wpUntil),
          pauseUntil: w(p.pauseUntil), pace: p.pace, dest: p.dest, settleUntil: w(p.settleUntil),
        });
      }
      if (!evict) continue;
      for (const m of p.members) { this.enemies.delete(m); if (this.ships.has(m)) this.ships.removeShip(m); }
      this.packs.delete(id);
    }
    if (evict) this.arrivals = this.arrivals.filter((a) => a.num !== num);
    return out;
  }

  /**
   * A remembered system's packs back: each ship where it was, as hurt as it
   * was less `heal` (a share of each part's max: time away mends), handed to
   * `adopt` (put to sleep and flown on from then: SimLod.adopt)
   */
  restore(num: number, packs: PackMemory[], offset: number, heal: number, adopt: (eid: number, pose: FarPose) => void): void {
    const l = (t?: number) => (t === undefined ? undefined : t - offset);
    for (const m of packs) {
      // (Nests' and zones' packs are their populations' now: a file from before them has them as ships, left out)
      if (m.nest !== undefined || m.origin === 'zone') continue;
      const pack: Pack = {
        id: this.nextPack++, systemNum: num, home: { ...m.home }, members: new Set(), lastSeen: this.host.tick(), origin: m.origin, passive: m.passive,
        angryUntil: l(m.angryUntil), zone: m.zone, size0: m.size0, wp: m.wp, wpUntil: l(m.wpUntil), pauseUntil: l(m.pauseUntil), pace: m.pace, dest: m.dest, settleUntil: l(m.settleUntil),
      };
      this.packs.set(pack.id, pack);
      for (const s of m.members) {
        if (!this.data.factions[s.faction]) continue;
        const eid = this.spawnShip(pack, s.type, s.faction, s.grade, s.plating ?? 0, s.elite, s.x, s.y, s.a, s.flank);
        if (eid < 0) continue;
        const e = this.enemies.get(eid)!;
        e.state = s.state; e.waypoint = { ...s.waypoint }; e.strafe = s.strafe;
        if (s.behaviour) e.behaviour = { ...s.behaviour };
        Velocity.x[eid] = s.vx; Velocity.y[eid] = s.vy;
        restoreHp(this.ships, eid, s.hp, heal);
        adopt(eid, { x: s.x, y: s.y, vx: s.vx, vy: s.vy, angle: s.a, angVel: 0 });
      }
      if (!pack.members.size) this.packs.delete(pack.id);
      else pack.size0 ??= pack.members.size;
    }
  }

  /** What a hostile is doing, to remember it by (a fight's forgotten: it's on its way home) */
  aiOf(eid: number): EnemyAi | undefined {
    const e = this.enemies.get(eid), pack = e && this.packs.get(e.pack);
    if (!e || !pack) return undefined;
    return { state: e.state === 'patrol' ? 'patrol' : 'return', waypoint: { ...e.waypoint }, home: { ...pack.home }, ...(e.behaviour ? { behaviour: { ...e.behaviour } } : {}) };
  }

  setAi(eid: number, ai: EnemyAi): void {
    const e = this.enemies.get(eid), pack = e && this.packs.get(e.pack);
    if (!e || !pack) return;
    e.state = ai.state; e.waypoint = { ...ai.waypoint }; pack.home = { ...ai.home };
    if (ai.behaviour) e.behaviour = { ...ai.behaviour };
  }

  /** Every spawner's clock still to run (when each may next send, launch, rebuild), keyed by system id, as world ticks */
  timers(offset: number): Record<string, Record<string, number>> {
    const now = this.host.tick();
    const out: Record<string, Record<string, number>> = {};
    for (const [name, map] of this.clocks()) {
      const o: Record<string, number> = (out[name] = {});
      for (const [k, t] of map) {
        const s = String(k), i = s.indexOf(':'), id = this.host.systemId(Number(i < 0 ? s : s.slice(0, i)));
        if (id !== undefined && t > now) o[i < 0 ? id : id + s.slice(i)] = t + offset;
      }
    }
    return out;
  }

  setTimers(t: Record<string, Record<string, number>>, offset: number): void {
    for (const [name, map] of this.clocks()) {
      for (const [k, at] of Object.entries(t[name] ?? {})) {
        const i = k.indexOf(':'), num = this.host.systemNum(i < 0 ? k : k.slice(0, i));
        if (num < 0 || typeof at !== 'number') continue;
        (map as Map<string | number, number>).set(i < 0 ? num : `${num}${k.slice(i)}`, at - offset);
      }
    }
  }

  /** The spawners' clocks, by name (keys: a system's number, or `${number}:...`) */
  private clocks(): [string, Map<string, number> | Map<number, number>][] {
    return [['spawn', this.nextSpawn], ['nestLock', this.nestLock]];
  }

  private pickGroup(groups: { faction: string; ships: string[]; weight: number }[]) {
    const total = groups.reduce((t, g) => t + g.weight, 0);
    let roll = this.rng() * total;
    for (const g of groups) { roll -= g.weight; if (roll <= 0) return g; }
    return groups[0];
  }

  /** In a zone's ring, near one of the pilots there but out of their sight */
  private zonePoint(num: number, players: number[], z: SpawnZone): { x: number; y: number } | null {
    const stations = this.host.stations(num);
    const [lo, hi] = this.spawnRange();
    for (let tries = 0; tries < 40; tries++) {
      const p = players[Math.floor(this.rng() * players.length)];
      // Out past the radar, in the zone's ring (a narrow ring: as far as it allows)
      const a = this.rng() * Math.PI * 2, d = (tries < 30 ? lo : lo * 0.7) + this.rng() * (hi - lo);
      const x = Position.x[p] + dcos(a) * d, y = Position.y[p] + dsin(a) * d;
      const r = dhypot(x - (z.x ?? 0), y - (z.y ?? 0));
      if (r < z.inner || r > z.outer || this.host.unsafe(num, x, y)) continue;
      if (players.some((q) => dhypot(Position.x[q] - x, Position.y[q] - y) < (tries < 30 ? lo : lo * 0.7))) continue;
      if (stations.some((s) => dhypot(Position.x[s] - x, Position.y[s] - y) < this.data.rules.minStationDistance)) continue;
      return { x, y };
    }
    return null;
  }

  /** Ships coming through a gate: when, where, and where they're headed */
  private arrivals: { due: number; num: number; group: SpawnGroup; x: number; y: number; zone?: string; approach?: { x: number; y: number } }[] = [];

  /**
   * A pack comes into the system, never out of nowhere beside a pilot: from
   * its faction's outpost if it stands, through a gate (spooling up first,
   * for all to see), or out past the radar's reach; then most fly in towards
   * where the pilots are, the rest patrol where they came in.
   */
  private arrive(num: number, group: SpawnGroup, players: number[], zone?: SpawnZone): void {
    const R = this.data.rules;
    const passive = !!(group as { passive?: boolean }).passive;
    const towards = (): { x: number; y: number } | undefined => {
      const out = players.filter((p) => !this.host.safeAt?.(num, Position.x[p], Position.y[p]));
      if (passive || this.rng() >= (R.approachChance ?? 0.6) || !out.length) return undefined;
      const p = out[Math.floor(this.rng() * out.length)];
      const a = this.rng() * Math.PI * 2, d = 2500 + this.rng() * 2500;
      return { x: Position.x[p] + dcos(a) * d, y: Position.y[p] + dsin(a) * d };
    };
    // Launched from the faction's outpost (the Redtooth Hold sends its cutters out)
    const base = this.bosses?.launcher(num, group.faction);
    if (base && this.rng() < 0.5) {
      const a = this.rng() * Math.PI * 2;
      const x = base.x + dcos(a) * base.r, y = base.y + dsin(a) * base.r;
      this.host.effect?.(num, x, y, 'launch');
      const eids = this.spawnPack(num, group, x, y, zone?.id);
      this.own(eids, zone ? 'zone' : 'system');
      const to = towards();
      if (to) this.sendPack(eids, to);
      return;
    }
    // Through a gate, seen spooling up first (not one a pilot's sitting on)
    const gates = (this.host.gates?.(num) ?? []).filter((g) => players.every((p) => dhypot(Position.x[p] - g.x, Position.y[p] - g.y) > 6000));
    if (gates.length && this.rng() < (R.gateChance ?? 0.3)) {
      const g = gates[Math.floor(this.rng() * gates.length)];
      const a = this.rng() * Math.PI * 2;
      const x = g.x + dcos(a) * 600, y = g.y + dsin(a) * 600;
      this.host.effect?.(num, x, y, 'warning');
      this.arrivals.push({ due: this.host.tick() + Math.round((R.warnSeconds ?? 3) * 60), num, group, x, y, zone: zone?.id, approach: towards() });
      return;
    }
    const at = zone ? this.zonePoint(num, players, zone) : this.spawnPoint(num, players, passive);
    if (!at) return;
    const eids = this.spawnPack(num, group, at.x, at.y, zone?.id);
    this.own(eids, zone ? 'zone' : 'system');
    const to = towards();
    if (to) this.sendPack(eids, to);
  }

  /** How far from every pilot a pack may come in: past the radar's reach */
  private spawnRange(): [number, number] {
    return this.data.rules.spawnRange ?? [12000, 18000];
  }

  /** Somewhere out past the pilots' radar, and far from stations */
  private spawnPoint(num: number, players: number[], passive = false): { x: number; y: number } | null {
    const R = this.host.systemRadius(num);
    const stations = this.host.stations(num);
    const [lo, hi] = this.spawnRange();
    for (let tries = 0; tries < 40; tries++) {
      // Near a player's part of the system, so packs are found, but beyond their sight
      const p = players[Math.floor(this.rng() * players.length)];
      const a = this.rng() * Math.PI * 2, d = lo + this.rng() * (hi - lo);
      const x = Position.x[p] + dcos(a) * d, y = Position.y[p] + dsin(a) * d;
      if (dhypot(x, y) > R * 1.2 || this.host.unsafe(num, x, y)) continue;
      // Hostiles come in outside the safe space
      if (!passive && this.host.safeAt?.(num, x, y)) continue;
      if (players.some((q) => dhypot(Position.x[q] - x, Position.y[q] - y) < lo)) continue;
      if (stations.some((s) => dhypot(Position.x[s] - x, Position.y[s] - y) < this.data.rules.minStationDistance)) continue;
      return { x, y };
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // The pilot
  // ---------------------------------------------------------------------------

  private fly(e: Enemy, ship: ShipState, asBody = true): PilotOrders {
    const now = this.host.tick();
    const eid = e.eid;
    const f = this.data.factions[e.faction];
    const b = e.behaviour ?? f.behaviour;
    const pack = this.packs.get(e.pack);
    const home = pack?.home ?? { x: Position.x[eid], y: Position.y[eid] };
    const x = Position.x[eid], y = Position.y[eid];

    if (now >= e.nextThink) {
      e.nextThink = now + 12 + (eid % 7);
      const fromHome = dhypot(x - home.x, y - home.y);
      // Hurt? run (if the faction does); and when most of the pack is gone, its nerve breaks
      const broken = b.flee > 0 && !e.boss && pack && (pack.size0 ?? 1) >= 3 && pack.members.size <= (pack.size0 ?? 1) * 0.4 && this.ships.coreFraction(eid) < 0.75;
      // Passive packs (safe systems) only fight once one of them has been shot (a wingmate of their own faction bumping
      // into them doesn't count)
      if (pack?.passive && pack.members.size && [...pack.members].some((m) => now - this.ships.lastDamagedTick(m) < 30 && this.enemies.get(this.ships.lastHitter(m))?.faction !== e.faction)) pack.angryUntil = now + 60 * (f.angrySeconds ?? 45);
      const calm = !!pack?.passive && now >= (pack.angryUntil ?? 0);
      // Whoever's been hurting the pack, from however far off
      const hitter = calm ? -1 : this.packHitter(e, pack, now);
      if (b.flee > 0 && (this.ships.coreFraction(eid) < b.flee || broken) && e.target >= 0) e.state = 'flee';
      else if (e.state === 'engage' && this.gaveUp(e, b, fromHome, hitter, now)) { e.state = 'return'; e.target = -1; }
      else if (e.state !== 'engage' && fromHome > b.leash && hitter < 0) { e.state = 'return'; e.target = -1; }
      else if (e.state !== 'return' || fromHome < b.leash * 0.5 || hitter >= 0) {
        // Nearest player in range (a packmate's target counts too), or a ward: defenders who get in the way draw the fire
        let best = -1, bd = calm ? 0 : b.aggro;
        for (const p of this.host.players(InSystem.systemId[eid])) {
          if (this.host.sheltered?.(p) || this.spared(e, p, now)) continue;
          const d = dhypot(Position.x[p] - x, Position.y[p] - y);
          if (d < bd) { bd = d; best = p; }
        }
        for (const w of this.wards) {
          if (!this.ships.has(w) || InSystem.systemId[w] !== InSystem.systemId[eid]) continue;
          const d = dhypot(Position.x[w] - x, Position.y[w] - y);
          if (!calm && d < bd) { bd = d; best = w; }
        }
        // Whoever's been hurting the pack gets its attention
        if (hitter >= 0) best = hitter;
        // ...unless it has its prey (gone: it's back to the usual)
        if (e.prey !== undefined) {
          if (!this.targetable(e.prey)) e.prey = undefined;
          else if (e.preyOnly || hitter < 0) best = e.prey;
        }
        if (best < 0 && pack && !calm) {
          for (const m of pack.members) {
            const o = this.enemies.get(m);
            if (o && o.target >= 0 && this.targetable(o.target)) { best = o.target; break; }
          }
        }
        if (best >= 0) {
          if (best !== e.target || best === hitter) e.engagedAt = now;
          e.target = best; e.state = 'engage';
        }
        else if (e.state === 'engage' || e.state === 'flee') { e.state = 'patrol'; e.target = -1; }
        else if (e.state === 'return' && fromHome < b.leash * 0.5) e.state = 'patrol';
      }
      // (Among rock (a den), a patrol is kept clear of it, and one held up on it is given up: clearRun, stalled)
      const clear = e.state === 'patrol' ? this.clearRun(eid) : undefined;
      if (e.state === 'patrol' && pack?.nestDef && pack.style !== 'anchored') {
        // Loose and nomad packs wander as one: each to its own spot round the pack's waypoint
        const lead = pack.members.values().next().value ?? eid;
        const wp = this.wander(pack, lead, now), k = [...pack.members].indexOf(eid);
        e.waypoint = k <= 0 ? wp : { x: wp.x + dcos(k * 2.4) * 380, y: wp.y + dsin(k * 2.4) * 380 };
      } else if (e.state === 'patrol' && (dhypot(x - e.waypoint.x, y - e.waypoint.y) < 300 || (clear && this.stalled(e, x, y, now, pack?.pauseUntil ?? 0)))) {
        e.waypoint = anchoredWaypoint({ x, y }, home, pack?.roam ?? 2400, this.rng, clear);
        e.wpBest = undefined;
      }
      if (this.rng() < 0.04) e.strafe = -e.strafe;
      // Nobody shoots perfectly: its aim's off by up to this much either way, re-rolled as it goes from a seed it rolled
      // once (common bodies/aiPilot.ts aiAimError: its pilot's body, on the clients that run it too)
      const acc = (b.accuracy ?? 0.85) + (e.elite ? 0.05 : 0);
      e.aimErr = (1 - acc) * 0.45;
      const roll = this.rng();
      e.aimSeed ??= Math.floor(roll * 256);
    }

    const t = e.target;
    // Gone, or safe at a station or in safe space: break off (every tick, not just when thinking)
    if ((e.state === 'engage' || e.state === 'flee') && (!this.targetable(t) || (now % 20 === 0 && this.spared(e, t, now)))) { e.state = 'return'; e.target = -1; }

    // Its order, flown by the shared pilot (common bodies/aiPilot.ts): on the clients that run its body too
    let want: WantRec, cent: [number, number] | null = null, reach = 0;
    // (A custom enemy: its range and reach are its design's, and its order carries its move and lost pieces: custom/)
    const cs = this.custom.has(eid) ? this.custom.statsOf(e.type) : undefined;
    if (e.state === 'engage') {
      if (e.reach === undefined) { if (cs) e.reach = cs.reach; else this.learnLoadout(e, ship); }
      reach = Math.round(e.reach ?? Math.max(b.range * 1.8, 900));
      // (shot at lately by its target: its commander's to know, from the damage ledger)
      const hitBy = now - this.ships.lastDamagedTick(eid) < 150 && this.ships.lastHitter(eid) === t;
      const c = pack?.cent, mates = c && c.ids.includes(eid) ? c.ids.filter((m) => m !== eid) : undefined;
      if (c && mates?.length) cent = [c.x, c.y];
      // (whether one of its guns lobs: its trigger fires from further off, common bodies/aiPilot.ts aiFires)
      want = orderEngage(eid, cs?.range ?? b.range, reach, hitBy, e.aimErr, e.aimSeed ?? 0, b.strafe, cent ? e.flank : undefined, cent ? mates : undefined, !cs && e.lobs === true, cs ? undefined : e.lead);
      if (cs) want = this.custom.order(eid, want, t);
    } else if (e.state === 'flee') want = orderFlee();
    else if (e.state === 'return') want = orderReturn(home.x, home.y);
    else want = orderPatrol(e.waypoint.x, e.waypoint.y, pack?.pace ?? 0.58, pack?.pauseUntil ?? 0);
    const fights = e.state === 'engage' || e.state === 'flee';
    const pose = (id: number) => ({ x: Position.x[id], y: Position.y[id], angle: Rotation.angle[id], vx: Velocity.x[id], vy: Velocity.y[id] });
    // (its target with its size, as its trigger reads it: aiFires)
    const tpose = (id: number) => ({ ...pose(id), r: this.ships.get(id)?.derived.radius ?? Radius.value[id] ?? 60 });
    // (its body flies it while what it fights is a pilot's ship, or nothing: brains/aiPilot.ts)
    // (Pinned (a fixed boss, a range target): it only turns, its thrust dropped (bridge/pilotless.ts), which its body doesn't know: the rows fly it)
    const bodied = asBody && !this.ships.isPinned(eid) && (!fights || hasComponent(this.host.world, Player, t));
    const out = this.pilots.fly(eid, fights ? t : -1, e.strafe, want, pose(eid), fights ? tpose(t) : null, cent, bodied);
    // (Its moves and guns: what they do this tick, common bodies/moves/custom.ts; it fires no part guns)
    if (cs) { if (asBody) this.custom.step(eid, t, e.state === 'engage'); }
    // Its trigger is its pilot's (common bodies/aiPilot.ts aiFires: within its guns' real reach, when a hit is likely),
    // so a client flying its body fires it too (sim/otherGuns.ts)
    return this.pilots.orders(eid, out, !cs && e.state === 'engage' && out.fire, t);
  }

  /** Is this enemy's pilot body on (clients fly it, and its guns: server net/guns/GunNet.ts)? Not a boss's brain's body */
  aiBodyOn(eid: number): boolean {
    return this.pilots.on(eid);
  }

  /** How far an enemy's guns really reach (its longest), whether any lob shells, and the round it leads by (common bodies/aiLead.ts) */
  private learnLoadout(e: Enemy, ship: ShipState): void {
    const l = aiLoadout(this.ships.tuning, ship, AI_BEAM_REACH);
    e.reach = l.reach > 0 ? l.reach : undefined;
    e.lobs = l.lobs;
    e.lead = l.lead;
  }

  /** Alive, and not sheltering at a station */
  /**
   * A pilot in safe space (inner Sol) is left alone by hostile packs, unless
   * they've been shooting this pack in the last few seconds; passive packs
   * provoked there fight back as anywhere.
   */
  private spared(e: Enemy, p: number, now: number): boolean {
    if (e.boss || !this.host.safeAt?.(InSystem.systemId[e.eid], Position.x[p], Position.y[p])) return false;
    const pack = this.packs.get(e.pack);
    if (pack?.passive) return false;
    for (const m of pack?.members ?? [e.eid]) if (this.ships.lastHitter(m) === p && now - this.ships.lastDamagedTick(m) < 60 * 8) return false;
    return true;
  }

  /** The pilot (or ward) who most recently shot one of its pack in the last few seconds, wherever they are in the system; -1 if none */
  private packHitter(e: Enemy, pack: Pack | undefined, now: number): number {
    let best = -1, last = -Infinity;
    for (const m of pack?.members ?? [e.eid]) {
      const h = this.ships.lastHitter(m), at = this.ships.lastDamagedTick(m);
      if (h < 0 || now - at > 240 || at <= last || !this.targetable(h) || InSystem.systemId[h] !== InSystem.systemId[e.eid]) continue;
      best = h; last = at;
    }
    return best;
  }

  /**
   * A chase ends when its target has got well away (out past twice its sight, and past its
   * guns' reach), or when it's been drawn far past its leash and hasn't been shot at for a while
   */
  private gaveUp(e: Enemy, b: Behaviour, fromHome: number, hitter: number, now: number): boolean {
    const t = e.target;
    if (!this.targetable(t)) return true;
    if (hitter === t || t === e.prey) return false;
    const d = dhypot(Position.x[t] - Position.x[e.eid], Position.y[t] - Position.y[e.eid]);
    if (d > Math.max(b.aggro * 2, e.reach ?? b.range * 1.8)) return true;
    return fromHome > b.leash * 2 && now - (e.engagedAt ?? 0) > CHASE_GRACE;
  }

  private targetable(eid: number): boolean {
    return this.alive(eid) && !this.host.sheltered?.(eid);
  }

  private alive(eid: number): boolean {
    if (eid >= 0 && this.wards.has(eid)) return this.ships.has(eid);
    return eid >= 0 && hasComponent(this.host.world, Player, eid) && !hasComponent(this.host.world, Dead, eid);
  }

  // ---------------------------------------------------------------------------
  // Kills and station defence
  // ---------------------------------------------------------------------------

  /** An enemy ship was destroyed: pay the killer (and helpers), drop loot */
  onDestroyed(eid: number, killer: number | undefined, ship: ShipState | undefined): void {
    const e = this.enemies.get(eid);
    if (!e) return;
    this.enemies.delete(eid);
    this.destroyed.add(eid);
    this.packs.get(e.pack)?.members.delete(eid);
    this.popLost(e, this.host.tick());
    // A range target pays nothing, drops nothing, counts for nothing
    if (e.dummy) return;
    if (e.boss) { this.bosses?.onDestroyed(eid, killer, ship); return; }
    const f = this.data.factions[e.faction];
    const base = f.ships[e.type] ?? { xp: 20, credits: 20 };
    // Better-built ships pay better: XP ×1.5 at Mk II, ×4.6 at Mk V (gradeReward); credits × rules.gradeCredits by grade
    const gk = gradeReward(this.ships.catalog, e.grade);
    const pay = { xp: base.xp * gk, credits: base.credits * (this.data.rules.gradeCredits?.[e.grade - 1] ?? gk) };
    const k = e.elite ? this.data.rules.eliteLoot : 1;
    const num = InSystem.systemId[eid];
    const x = Position.x[eid], y = Position.y[eid];
    const label = this.info(eid)?.name ?? (this.designs[e.type]?.name ?? e.type);
    if (killer !== undefined && this.alive(killer)) {
      this.host.reward(killer, pay.xp * k, pay.credits * k, false, label);
      this.host.questKill(killer, e.type, e.faction);
    }
    // The killer's party nearby shares the kill (XP, some credits, and it counts for their jobs);
    // other helpers nearby get a share of the XP
    const party = new Set(killer !== undefined && this.alive(killer) ? this.host.partyOf?.(killer) ?? [] : []);
    const support = new Set(killer !== undefined && this.alive(killer) ? this.host.supportersOf?.(killer) ?? [] : []);
    for (const p of this.host.players(num)) {
      if (p === killer) continue;
      const d = dhypot(Position.x[p] - x, Position.y[p] - y);
      if (party.has(p) && d < PARTY_SHARE_RANGE) {
        this.host.reward(p, Math.round(pay.xp * k * 0.75), Math.round(pay.credits * k * 0.4), true, label);
        this.host.questKill(p, e.type, e.faction);
        continue;
      }
      // (Support credit: whoever kept the killer flying shares the kill's pay as its party does, not its job steps)
      if (support.has(p) && d < PARTY_SHARE_RANGE) {
        this.host.reward(p, Math.round(pay.xp * k * 0.75), Math.round(pay.credits * k * 0.4), true, label);
        continue;
      }
      if (d > 3000) continue;
      this.host.reward(p, Math.round(pay.xp * k * this.data.rules.assistXpShare), 0, true, label);
    }
    // Loot: the faction table, rolled (twice for elites), plus salvaged parts
    const bag: Bag = {};
    for (let r = 0; r < k; r++) {
      for (const l of f.loot) {
        if (this.lootDice() >= l.chance) continue;
        const n = l.min + Math.floor(this.lootDice() * (l.max - l.min + 1));
        bag[l.item] = (bag[l.item] ?? 0) + n;
      }
    }
    if (ship) {
      ship.blueprint.parts.forEach((p, i) => {
        if (p.fn === 'core' || !(ship.rebuildHp[i] > 0) || this.lootDice() >= f.partSalvage) return;
        // (The game's own ships' parts, and bespoke shapes, are never salvage)
        if (this.ships.catalog.functions.get(p.fn)?.exclusive || this.ships.catalog.pieces.get(p.piece)?.bespoke) return;
        // Modules come as their models (an enemy's are legacy parts: ships/migrate.ts); structure as the materials it's made of
        for (const [id, n] of Object.entries(this.econ ? placeCost(this.econ, p) : { [partItemId(p)]: 1 })) { const to = migratePartItem(this.ships.catalog, id); bag[to] = (bag[to] ?? 0) + n; }
      });
    }
    if (Object.keys(bag).length) this.host.dropLoot(num, x, y, Velocity.x[eid] * 0.4, Velocity.y[eid] * 0.4, bag);
  }

  /**
   * Armed stations' turrets fire on hostiles in reach: each stays on its
   * target while it's in reach, otherwise takes the nearest (shared out round
   * the turrets, so a battery spreads over a pack), and fires as it comes ready.
   */
  private stationDefence(now: number): void {
    const bySystem = new Map<number, number[]>();
    for (const e of this.enemies.values()) {
      // (Distant ships are out of every fight: ships/SimLod.ts)
      if (this.ships.isDormant(e.eid)) continue;
      const num = InSystem.systemId[e.eid];
      if (!SimPass.on(num)) continue;
      const list = bySystem.get(num);
      if (list) list.push(e.eid);
      else bySystem.set(num, [e.eid]);
    }
    for (const [num, foes] of bySystem) {
      for (const st of this.host.stations(num)) {
        const def = this.host.stationDefence?.(st);
        const gun = def && def.turrets > 0 ? this.data.rules.stationDefence[def.weapon] : undefined;
        if (!def || !gun) continue;
        const reach = gun.range + Radius.value[st];
        const near = foes.map((eid) => ({ eid, d: dhypot(Position.x[st] - Position.x[eid], Position.y[st] - Position.y[eid]) }))
          .filter((f) => f.d <= reach && this.ships.get(f.eid))
          .sort((a, b) => a.d - b.d);
        if (!near.length) continue;
        let b = this.batteries.get(st);
        if (!b) {
          // Staggered, so a battery fires in turn rather than all at once
          b = { next: Array.from({ length: def.turrets }, (_, i) => now + Math.round((i * gun.interval) / def.turrets)), target: new Array(def.turrets).fill(-1) };
          this.batteries.set(st, b);
        }
        for (let i = 0; i < def.turrets; i++) {
          if (now < b.next[i]) continue;
          const target = near.find((f) => f.eid === b.target[i])?.eid ?? near[i % near.length].eid;
          b.target[i] = target;
          b.next[i] = now + gun.interval;
          this.stationShot(st, target, gun, foes);
          this.host.stationBeam(num, st, target, i);
        }
      }
    }
  }

  /** A turret's shot lands: on the part of the ship facing the station (what a shot at it from there strikes first; flak hurts those near it too) */
  private stationShot(st: number, target: number, gun: StationGun, foes: number[]): void {
    const sx = Position.x[st], sy = Position.y[st];
    const hit = (eid: number, damage: number) => {
      const ship = this.ships.get(eid);
      if (!ship) return;
      const part = this.ships.partFacing(eid, sx, sy);
      if (part >= 0) this.ships.hurt(eid, ship, part, damage, -1);
    };
    const x = Position.x[target], y = Position.y[target];
    hit(target, gun.damage);
    if (!gun.splash) return;
    for (const eid of foes) {
      if (eid !== target && dhypot(Position.x[eid] - x, Position.y[eid] - y) < gun.splash) hit(eid, gun.damage * 0.5);
    }
  }
}

/** A ship's parts' HP as shares of their max (undefined: it's whole) */
function hpShares(ship: ShipState): number[] | undefined {
  const hp = ship.hp.map((h, i) => (ship.detached[i] || !(ship.maxHp[i] > 0) ? 0 : Math.round(Math.min(1, h / ship.maxHp[i]) * 1000) / 1000));
  return hp.every((h) => h >= 1) ? undefined : hp;
}
