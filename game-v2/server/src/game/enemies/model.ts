/**
 * Enemies' data shapes: the factions file, spawn groups, nests and zones, what a hostile and a pack are while they live,
 * a population's slots, and what is remembered of them. Types only (and the two functions that fill the factions file
 * from systems.json); the rules that use them are the sibling modules.
 */

import { IWorld } from 'bitecs';
import { Player, Bag, ShipState, type DropSpec, type LootTable, gradeReward, type AiLead, nestPost, type Terrain, type NestData, type PlanetData, type StarSystemData, type BodyState, type Spawner, type Lure } from '@space-game/common';
import type { CustomTable } from '../custom/types.js';
import { nestBand, type RoamStyle, type Band, type XY } from '../Roaming.js';
import { type ShipMemory } from '../SystemMemory.js';

export interface FactionDef {
  name: string;
  color: string;
  /** strafe: share of the time spent circling at fighting range (default 1); the rest it brakes and holds */
  behaviour: { aggro: number; range: number; flee: number; leash: number; accuracy?: number; strafe?: number };
  /** Per design: its pay, and its drops if not the faction's (common econ/loot.ts) */
  ships: Record<string, { xp: number; credits: number } & DropSpec>;
  /** What its ships roll (data/loot.json tables), and the table an elite rolls once more: the default for its designs */
  drops?: DropSpec['drops'];
  eliteDrop?: string;
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
export type SpawnGroup = { faction: string; ships: string[]; weight: number; passive?: boolean; plating?: number; limit?: number; respawnSeconds?: number; style?: RoamStyle };

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
  /** `loot`: designs that drop differently in this system (the Scrap Nest den), by design */
  spawns: Record<string, { grade?: number; packs: number; groups: SpawnGroup[]; zones?: SpawnZone[]; nests?: SpawnNest[]; events?: import('../Events.js').SystemEvents; loot?: Record<string, DropSpec> }>;
  /** data/loot.json's tables (GameServer fills it in: withLoot) */
  lootTables?: Record<string, LootTable>;
  /** Custom enemies (docs/enemies/custom-roster.md): designs in ship types' places, their pieces' HP and moves' numbers (custom/) */
  custom?: CustomTable;
  rules: {
    minStationDistance: number;
    minPlayerDistance: number;
    eliteChance: number;
    eliteHp: number;
    /** An elite's XP and credits × this (its loot: one more roll of its eliteDrop table) */
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


export type Behaviour = FactionDef['behaviour'];

export interface Enemy {
  eid: number;
  type: string;
  faction: string;
  /** A boss (data/bosses.json id): its own behaviour, and Bosses handles its death */
  boss?: string;
  /** A gun range target (game/gunRange): no AI, never fires, pays nothing, drops nothing, counts for nothing */
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
export interface PopSlot { group: number; alive: number; elite: number; hp: (number[] | undefined)[]; pack?: number; leftAt?: number }

/** A nest's or zone's packs, ship by ship, there whether anyone's near or not (`next`: its next ship back, 0: it's full) */
export interface Population {
  num: number; sysId: string; sp: Spawner; sys?: StarSystemData; nest?: SpawnNest; zone?: SpawnZone; key: string; slots: PopSlot[]; next: number; changed: boolean;
  /** Its nomads' ghosts drift towards where pilots were last seen in its band (common Lure; none: it has no nomads, or nobody's been) */
  lure?: Lure;
}

/** A system's populations on the wire (pops: `p` slots, `n` lures) */
export interface PopRows { p: number[]; n: number[] }

/** A population as remembered (SystemMemory.ts: the file's `populations`), times as world ticks */
export interface PopulationMemory { next?: number; slots: { group: number; alive: number; elite?: number; hp?: (number[] | null)[]; leftAt?: number }[]; lure?: { l1: number; s1: number; l2: number; s2: number } }

export interface Pack {
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


/** What Bosses plugs into the enemy AI */
export interface BossHooks {
  onDestroyed(eid: number, killer: number | undefined, ship: ShipState | undefined): void;
  name(eid: number): string | undefined;
  lair(boss: string): { system: string; x: number; y: number } | null;
  /** A standing outpost of a faction in a system, its packs launched from it */
  launcher(num: number, faction: string): { x: number; y: number; r: number } | null;
}

