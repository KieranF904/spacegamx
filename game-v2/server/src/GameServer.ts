/**
 * Game Server - Main server with ECS world and systems
 */

import type { IncomingMessage, ServerResponse } from 'http';
import {
  createWorld,
  addEntity,
  removeEntity,
  addComponent,
  hasComponent,
  entityExists,
  defineQuery,
  enterQuery,
  exitQuery,
  getAllEntities,
  IWorld,
} from 'bitecs';

import {
  // Components
  Position,
  Velocity,
  Rotation,
  Radius,
  Health,
  Lifetime,
  Player,
  Input,
  Boost,
  Inventory,
  Projectile,
  Bullet,
  MiningShot,
  AI,
  Enemy,
  NPC,
  Asteroid,
  Station,
  Portal,
  DroppedItem,
  NetworkSync,
  InSystem,
  Dead,
  OwnedBy,
  // Enums
  WeaponType,
  AIBehavior,
  AIState,
  // Constants
  TICK_RATE,
  TICK_MS,
  SNAPSHOT_RATE,
  WORLD_SIZE,
  BOOST_DRAIN,
  BOOST_REGEN,
  BOOST_REGEN_DELAY,
  BOOST_FUEL_DEFAULT,
  PLAYER_MAX_HP,
  PLAYER_RADIUS,
  BULLET_SPEED,
  BULLET_DAMAGE,
  BLASTER_LIFE_TICKS,
  ASTEROID_SEED,
stationInteractRadius,
  STATION_DESIGNS,
  STATION_WEAPONS,
  NPC_INTERACT_RADIUS,
asteroidParamsAt,
  inSafeSpace,
  regionAt,
  beltTotal,
  beltSegment,
  calcAsteroidPosition,
  stationOrbitTimeScale,
  scaledOrbitTick,
  calcOrbitStateRaw,
  OrbitType,
  asteroidRegistry,
  buildRangeRig,
} from '@space-game/common';

import {
  ClientMessage,
  ServerMessage,
  EntityState,
  EntityType,
  encodeServerMessage,
  serverFrame,
  ServerAsteroidSeedMessage,
  EffectType,
  packCursorWeaponState,
  // Shared polygon & collision helpers (used by both fireLaser and projectile collision)
  getAsteroidPolygon,
  asteroidSpin,
  countOf,
  PROTOCOL_VERSION,
  packMapLeg,
  unpackMapLegs,
  packMapRoute,
  mapDotFlags,
  legAt,
  MAP_DOT_SLACK,
  type Leg,
  ReplicaEnv,
  segmentNearCircle,
  segmentIntersectT,
  pointInPolygon,
  hashString,
  mulberry32,
  // Shared physics for exact client/server parity
// Data types
  StarSystemData,
  TrafficData,
  RiftData,
} from '@space-game/common';

import { GameData } from './data/GameData.js';
import type { UserStore } from './auth/types.js';
import type { ClientSocket, ClientLink } from '@space-game/common';
import type { ShipBridge, ShipHost } from './ships/ShipBridge.js';
import { portsSwitchFeeds } from '@space-game/common';
import { Blueprint, ShipState, quantizeShipValue, skillValue, hasAll, removeAll, Economy, Bag, StarterKit, jumpTuning, jumpPhase, partItemId, rateShip, ratingOf, createShipState, gradeReward, gradeOf, accrueTraces, releaseTraces, unlocks, stationPerks, hazardFlight, stationTable, blueprintGrade, lookFn, warmthPercent, packCharge, nearerThan, fartherThan, type ShipDerived } from '@space-game/common';

/** A station site by id */
const stationPerksSite = (id: string | undefined) => (id ? stationTable()?.sites.find((s) => s.id === id) : undefined);
import { Pilots, PilotHost, type PilotConn } from './game/Pilots.js';
import { Ammo } from './game/Ammo.js';
import { WeaponsRange, type RangeConfig } from './game/WeaponsRange.js';
import { Hazards } from './game/Hazards.js';
import { Warmth } from './game/Warmth.js';
import { Outpost } from './game/Outpost.js';
import { HomeStations } from './game/HomeStations.js';
import { LootPods, PodHost } from './game/LootPods.js';
import { ServerFeatures } from './ships/features/host.js';
import { SERVER_FEATURES } from './ships/features/index.js';
import { Mining, MiningHost } from './game/Mining.js';
import { AsteroidOrbits } from './game/AsteroidOrbits.js';
import { StationServices } from './game/StationServices.js';
import { Weapons } from './game/Weapons.js';
import { Enemies, FactionsFile, withZoneSpots, withNests } from './game/Enemies.js';
import { Telemetry, type TelemetryWriter } from './game/Telemetry.js';
import { Quests } from './game/Quests.js';
import { People, type PeopleHost } from './game/People.js';
import { Codex } from './game/Codex.js';
import { Arenas, type ArenaHost } from './game/Arenas.js';
import { Bosses, BossesFile } from './game/Bosses.js';
import { Mobs, MobsFile } from './game/Mobs.js';
import { Events } from './game/Events.js';
import { AdminTools, type AdminConn, type AdminHost } from './game/AdminTools.js';
import { ContributorNotes, type ContribStore } from './game/ContributorNotes.js';
import { Surfaces, type SurfaceHost } from './game/Surfaces.js';
import { Sieges, type SiegeHost } from './game/Sieges.js';
import { Hangar } from './game/Hangar.js';
import { Party } from './game/Party.js';
import type { Support } from './ships/features/support/Support.js';
import { Trade } from './game/Trade.js';
import { Operations } from './game/Operations.js';
import { Market } from './game/Market.js';
import { Replication } from './net/Replication.js';
import { SimLod, type Plan, type Intent, type FarPose } from './ships/SimLod.js';
import { SystemMemory, shipMemory, restoreHp, type WorldStore, type MemoryHost, type ShipMemory } from './game/SystemMemory.js';
import { Achievements } from './game/Achievements.js';
import { huntedBoss, RibbonsFile, mineFalloff, rayTerrain, type Terrain } from '@space-game/common';
import { MemoryProfileStore, type ProfileStore } from './profile/ProfileStore.js';
import { MessageLimiter } from './net/MessageLimits.js';
import { checkTickOrder, type TickSystem } from './tickOrder.js';
import type { ClientConnection } from './net/ClientConnection.js';
import type { ServerCtx } from './net/ServerCtx.js';
import { registerModuleHandlers } from './net/handlers/modules.js';
import { registerAuthHandlers, rejectAuth, handleHttpAuth } from './net/auth.js';
import { registerShipEditHandlers } from './net/handlers/shipEdit.js';
import { Docking, stationQuery } from './game/Docking.js';
import { Derelicts, type DerelictSlot } from './game/Derelicts.js';
import { HandlerRegistry, dispatch, registerHandlers, type Handler, type HandlerTable } from './net/dispatch.js';
import * as flight from './net/handlers/flight.js';
import { registerFlightHandlers, portalQuery } from './net/handlers/flight.js';
import { Outbox } from './net/snapshot/Outbox.js';
import { SnapshotBuilder, designHash, playerQuery, projectileQuery, droppedItemQuery } from './net/SnapshotBuilder.js';

// ============================================
// SPATIAL PARTITIONING
// ============================================

const SPATIAL_CHUNK_SIZE = 500;

interface SpatialEntity {
  id: number;
  x: number;
  y: number;
  radius: number;
  type: 'player' | 'projectile' | 'item';
  /** The system copy it's in (instanced copies share coordinates) */
  system: number;
}

/**
 * The broadphase: a uniform grid per system (instanced copies are systems of
 * their own here, so shots never see another copy). Everything is recorded
 * where it stood when the tick began; a system's cells are only filled the
 * first time something looks there that tick, so systems nobody's shooting in
 * cost nothing beyond the record.
 */
class SpatialGrid {
  // Integer key = ((system * GRID_STRIDE) + cx + GRID_OFFSET) * GRID_STRIDE + (cy + GRID_OFFSET).
  // Avoids per-add template-string allocation (~100k strings/sec at 60Hz).
  private static readonly GRID_OFFSET = 1024;   // WORLD_SIZE 260000 / chunk 500 = 520 cells max
  private static readonly GRID_STRIDE = 2048;
  private grid: Map<number, SpatialEntity[]> = new Map();
  // Pool of arrays reused across ticks to avoid per-tick array churn
  private arrayPool: SpatialEntity[][] = [];
  // Pool of SpatialEntity objects reused across ticks (~1300 objects/tick otherwise)
  private entityPool: SpatialEntity[] = [];
  private poolIndex = 0;
  /** What's in each system this tick, in the order it was added (cells are filled from it on demand) */
  private pending = new Map<number, SpatialEntity[]>();
  private built = new Set<number>();
  /** Query dedupe without a Set: an entity's last query number, by id */
  private stamp = new Int32Array(1 << 14);
  private queryNo = 0;

  clear(): void {
    // Return arrays to the pool instead of dropping them for GC
    for (const arr of this.grid.values()) this.recycle(arr);
    for (const arr of this.pending.values()) this.recycle(arr);
    this.grid.clear();
    this.pending.clear();
    this.built.clear();
    // Reset the entity pool cursor — objects stay pooled for next tick
    this.poolIndex = 0;
  }

  private recycle(arr: SpatialEntity[]): void {
    if (this.arrayPool.length < 4096) {
      arr.length = 0;
      this.arrayPool.push(arr);
    }
  }

  /** Reuse a pooled SpatialEntity instead of allocating a fresh object */
  private obtainEntity(
    id: number, x: number, y: number, radius: number,
    type: SpatialEntity['type'], system: number,
  ): SpatialEntity {
    let e: SpatialEntity;
    if (this.poolIndex < this.entityPool.length) {
      e = this.entityPool[this.poolIndex];
      e.id = id; e.x = x; e.y = y; e.radius = radius; e.type = type; e.system = system;
    } else {
      e = { id, x, y, radius, type, system };
      this.entityPool.push(e);
    }
    this.poolIndex++;
    return e;
  }

  private obtainArray(): SpatialEntity[] {
    return this.arrayPool.pop() ?? [];
  }

  private static key(system: number, cx: number, cy: number): number {
    return ((system * SpatialGrid.GRID_STRIDE) + cx + SpatialGrid.GRID_OFFSET) * SpatialGrid.GRID_STRIDE + (cy + SpatialGrid.GRID_OFFSET);
  }

  /** File an entity in the cells it covers */
  private insert(entity: SpatialEntity): void {
    const minCx = Math.floor((entity.x - entity.radius + WORLD_SIZE) / SPATIAL_CHUNK_SIZE);
    const maxCx = Math.floor((entity.x + entity.radius + WORLD_SIZE) / SPATIAL_CHUNK_SIZE);
    const minCy = Math.floor((entity.y - entity.radius + WORLD_SIZE) / SPATIAL_CHUNK_SIZE);
    const maxCy = Math.floor((entity.y + entity.radius + WORLD_SIZE) / SPATIAL_CHUNK_SIZE);

    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        const key = SpatialGrid.key(entity.system, cx, cy);
        let chunk = this.grid.get(key);
        if (!chunk) {
          chunk = this.obtainArray();
          this.grid.set(key, chunk);
        }
        chunk.push(entity);
      }
    }
  }

  /** Add an entity by fields, reusing pooled objects (allocation-free); its cells are filled when its system is first queried */
  addEntity(
    id: number, x: number, y: number, radius: number,
    type: SpatialEntity['type'], system: number,
  ): void {
    let list = this.pending.get(system);
    if (!list) {
      list = this.obtainArray();
      this.pending.set(system, list);
    }
    list.push(this.obtainEntity(id, x, y, radius, type, system));
  }

  /** Everything in a system whose cells meet a box (each once, in the order it was added within each cell) */
  query(system: number, x1: number, y1: number, x2: number, y2: number, padding: number = 0): SpatialEntity[] {
    if (!this.built.has(system)) {
      this.built.add(system);
      for (const e of this.pending.get(system) ?? []) this.insert(e);
    }
    const minX = Math.min(x1, x2) - padding;
    const maxX = Math.max(x1, x2) + padding;
    const minY = Math.min(y1, y2) - padding;
    const maxY = Math.max(y1, y2) + padding;

    const minCx = Math.floor((minX + WORLD_SIZE) / SPATIAL_CHUNK_SIZE);
    const maxCx = Math.floor((maxX + WORLD_SIZE) / SPATIAL_CHUNK_SIZE);
    const minCy = Math.floor((minY + WORLD_SIZE) / SPATIAL_CHUNK_SIZE);
    const maxCy = Math.floor((maxY + WORLD_SIZE) / SPATIAL_CHUNK_SIZE);

    if (++this.queryNo === 0x7fffffff) { this.stamp.fill(0); this.queryNo = 1; }
    const result: SpatialEntity[] = [];

    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        const chunk = this.grid.get(SpatialGrid.key(system, cx, cy));
        if (!chunk) continue;
        for (const entity of chunk) {
          const id = entity.id;
          if (id >= this.stamp.length) {
            const grown = new Int32Array(Math.max(id + 1, this.stamp.length * 2));
            grown.set(this.stamp);
            this.stamp = grown;
          }
          if (this.stamp[id] === this.queryNo) continue;
          this.stamp[id] = this.queryNo;
          result.push(entity);
        }
      }
    }

    return result;
  }

  /**
   * Everything whose cells lie along a segment, `padding` either side of it:
   * the cells of its bounding box that the padded segment can reach (a long
   * diagonal beam's box is mostly cells nowhere near it)
   */
  queryRay(system: number, x1: number, y1: number, x2: number, y2: number, padding: number = 0): SpatialEntity[] {
    const dx = x2 - x1, dy = y2 - y1, l2 = dx * dx + dy * dy;
    // (Short ones, a shell's step: the box is a cell or four anyway)
    if (l2 < SPATIAL_CHUNK_SIZE * SPATIAL_CHUNK_SIZE * 4) return this.query(system, x1, y1, x2, y2, padding);
    if (!this.built.has(system)) {
      this.built.add(system);
      for (const e of this.pending.get(system) ?? []) this.insert(e);
    }
    const h = SPATIAL_CHUNK_SIZE / 2, reach = padding + h * Math.SQRT2, reach2 = reach * reach;
    const minCx = Math.floor((Math.min(x1, x2) - padding + WORLD_SIZE) / SPATIAL_CHUNK_SIZE);
    const maxCx = Math.floor((Math.max(x1, x2) + padding + WORLD_SIZE) / SPATIAL_CHUNK_SIZE);
    const minCy = Math.floor((Math.min(y1, y2) - padding + WORLD_SIZE) / SPATIAL_CHUNK_SIZE);
    const maxCy = Math.floor((Math.max(y1, y2) + padding + WORLD_SIZE) / SPATIAL_CHUNK_SIZE);
    if (++this.queryNo === 0x7fffffff) { this.stamp.fill(0); this.queryNo = 1; }
    const result: SpatialEntity[] = [];
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        // The cell's middle within half its diagonal (plus the padding) of the segment, or nothing in it is near enough
        const mx = cx * SPATIAL_CHUNK_SIZE - WORLD_SIZE + h, my = cy * SPATIAL_CHUNK_SIZE - WORLD_SIZE + h;
        const t = Math.max(0, Math.min(1, ((mx - x1) * dx + (my - y1) * dy) / l2));
        const ex = mx - (x1 + dx * t), ey = my - (y1 + dy * t);
        if (ex * ex + ey * ey > reach2) continue;
        const chunk = this.grid.get(SpatialGrid.key(system, cx, cy));
        if (!chunk) continue;
        for (const entity of chunk) {
          const id = entity.id;
          if (id >= this.stamp.length) {
            const grown = new Int32Array(Math.max(id + 1, this.stamp.length * 2));
            grown.set(this.stamp);
            this.stamp = grown;
          }
          if (this.stamp[id] === this.queryNo) continue;
          this.stamp[id] = this.queryNo;
          result.push(entity);
        }
      }
    }
    return result;
  }
}

// ============================================
// PERFORMANCE METRICS
// ============================================

interface PerfMetrics {
  lastTickMs: number;
  avgTickMs: number;
  maxTickMs: number;
  minTickMs: number;
  collisionChecks: number;
  avgCollisionChecks: number;
  ticksProcessed: number;
  spatialQueries: number;
  entityCount: number;
  /** The slowest tick since the box's monitor last asked (liveStatus) */
  windowMaxMs: number;
}

const perfMetrics: PerfMetrics = {
  lastTickMs: 0,
  avgTickMs: 0,
  maxTickMs: 0,
  minTickMs: Infinity,
  collisionChecks: 0,
  avgCollisionChecks: 0,
  ticksProcessed: 0,
  spatialQueries: 0,
  entityCount: 0,
  windowMaxMs: 0,
};

// ============================================
// QUERIES
// ============================================

// (playerQuery, projectileQuery, droppedItemQuery: net/SnapshotBuilder.ts, the same queries)
const bulletQuery = defineQuery([Bullet, Position, Velocity]);
const miningProjectileQuery = defineQuery([MiningShot, Position, Velocity, Projectile]);
const asteroidQuery = defineQuery([Asteroid, Position]);

/** A client's game loop silent this long (3 s) lets go of its controls */
const INPUT_TIMEOUT_TICKS = 180;
const lifetimeQuery = defineQuery([Lifetime]);
const deadQuery = defineQuery([Dead]);

/** Fly within this distance of a rift's centre to be pulled through */
const RIFT_TRIGGER_RADIUS = 200;
const RIFT_COOLDOWN_TICKS = 180;
/** Freighters: replacement delay, how close counts as arrived, how long they stay */
const TRAFFIC_RESPAWN_TICKS = 60 * 120;
const TRAFFIC_ARRIVE_RADIUS = 700;
const TRAFFIC_DWELL_TICKS = 60 * 6;
/** A derelict's log (systems.json `log`) is read by flying this close (a scan step's 700 is inside it) */
const DERELICT_LOG_RANGE = 900;

// Enter/exit queries for tracking removed entities
const playerEnter = enterQuery(playerQuery);
const playerExit = exitQuery(playerQuery);
const deadEnter = enterQuery(deadQuery);

// ============================================
// CLIENT CONNECTION
// ============================================

// (ClientConnection: net/ClientConnection.ts)

/** A pilot this close past a gate's or rift's edge has where it goes brought back (SystemMemory), before they're through */
const MEMORY_GATE_MOUTH = 3000;
// (The snapshot path's tuning: net/snapshot/constants.ts)

// (designHash, hpWire, SnapRow: net/SnapshotBuilder.ts)

/** Entities removed this tick and the system each was in (so only clients there are told) */
class RemovalSet extends Map<number, number> {
  add(eid: number): this {
    this.set(eid, InSystem.systemId[eid]);
    return this;
  }
}

// (hexToHue: net/SnapshotBuilder.ts)

// ============================================
// GAME SERVER
// ============================================

import type { AdminServer } from './AdminServer.js';

export interface GameServerOptions {
  gameData: GameData;
  userDB: UserStore;
  adminServer?: AdminServer | null;
  /** 'sectors' loads every star system (normal play). 'empty' spawns nothing but players. */
  scene?: 'sectors' | 'empty';
  /** Start the real-time loop immediately (default true). Tests and replays drive step() instead. */
  autoStart?: boolean;
  /** Treat every connection as admin (proto mode: no login). */
  everyoneAdmin?: boolean;
  /** Guests (not signed in) are admins: the dev server only. Refused outright under NODE_ENV=production. */
  guestAdmin?: boolean;
  /** Designs every guest finds in their hangar: the dev server only, like guestAdmin */
  guestShips?: Blueprint[];
  /** Modular ships: every player flies one. */
  ships: ShipBridge;
  /** Allow hangar edits anywhere (proto's empty scene has no stations). Default: docked only. */
  shipEditAnywhere?: boolean;
  /** Keeps logged-in players' progress between sessions (default: in memory only) */
  profileStore?: ProfileStore;
  /** Wall clock (ms) for autosave and fabricator jobs; tests pass a fake one */
  clock?: () => number;
  /** Allow the map's click-to-warp for everyone (dev servers, proto). Admins can always use it. */
  devTeleport?: boolean;
  /** The weapons range (data/dev/range.json): the dev server only (needs devTeleport), refused outright under NODE_ENV=production */
  devRange?: RangeConfig;
  /** Admins may switch on free build (any part in the hangar, nothing taken): the dev server only. Refused outright under NODE_ENV=production. */
  freeBuild?: boolean;
  /** Every pilot joins and respawns in this system (the dev Rockery, `dev_rockery`), whatever their profile says: the dev server only. Refused outright under NODE_ENV=production. */
  devStart?: string;
  /** Where pilots' deaths and milestones are written (Telemetry.ts); none: not recorded */
  telemetry?: TelemetryWriter;
  /** Where contributor notes and ranks are kept (contribFileStore: data/contributor); none: in memory */
  contributorStore?: ContribStore;
  /** Where the world's memory is kept between restarts (worldFileStore: data/world/memory.json); none: in memory only */
  worldStore?: WorldStore;
}

/** A player who quits within this long of taking damage leaves their ship in space... */
const LINGER_COMBAT_TICKS = 60 * 15;
/** ...for this long */
const LINGER_TICKS = 60 * 20;

// setImmediate is Node-only; fall back to setTimeout when running in a browser (proto mode).
const scheduleImmediate: (fn: () => void) => unknown =
  typeof setImmediate === 'function' ? setImmediate : (fn) => setTimeout(fn, 0);

/** No asteroids: what a ghost round's rock query is (it flies through them) */
const NO_ROCKS: number[] = [];

export class GameServer implements ServerCtx {
  readonly world: IWorld;
  gameData: GameData;
  clients: Map<ClientSocket, ClientConnection> = new Map();
  scene: 'sectors' | 'empty';
  everyoneAdmin: boolean;
  guestAdmin: boolean;
  /** Admins may build for free in the hangar (AdminTools `freebuild`) */
  private freeBuildAllowed: boolean;
  /** The dev server's start system (opts.devStart), by number; -1: pilots start in Sol and come back where they left off */
  private devStartNum = -1;
  private paused = false;
  /** Tick until which each player ignores rifts (no instant bounce-back) */
  private riftCooldown = new Map<number, number>();
  ships: ShipBridge;
  readonly shipEditAnywhere: boolean;
  /** Berths and who is inside a station (game/Docking.ts) */
  docking!: Docking;
  /** Ships inside a station: the same Set as docking.dockedShips (read on the hot path) */
  private dockedShips!: Set<number>;

  private devTeleport: boolean;
  private clientIdCounter = 1;
  
  currentTick = 0;
  private lastTickTime = 0;
  private tickAccumulator = 0;
  
  private lastSnapshotTick = 0;
  
  // Input queue — messages arrive instantly between ticks, get applied at tick boundaries
  readonly inputQueue: Array<{ conn: ClientConnection; msg: any }> = [];
  
  // Tracks entities that died this tick (for snapshot removal notifications), with the system they were in
  private pendingRemovedEntities = new RemovalSet();
  
  // Spatial partitioning for efficient collision detection
  private spatialGrid: SpatialGrid = new SpatialGrid();

  // Deterministic asteroid ids per system (systemNum -> asteroid ids)
  private asteroidIdsBySystem: Map<number, number[]> = new Map();
  private asteroidSeedTickBySystem: Map<number, number> = new Map();
  private asteroidIndexById: Map<number, number> = new Map();
  private asteroidTypeById: Map<number, string> = new Map();
  /** Outliers: the stage each is at, and its size whole */
  private asteroidStageById = new Map<number, { stage: number; wholeSize: number }>();
  /** Asteroids re-created after breaking (not described by their system's seed) */
  private respawnedAsteroids = new Set<number>();
  /** Replication environments (gravity, central body) per system */
  private replicaEnvs = new Map<number, ReplicaEnv>();
  /** Each system's stations with their names (hostile AI asks every few ticks) */
  private namedStations = new Map<number, { eid: number; name: string }[]>();
  /** Where every asteroid's orbit takes it, and when (shots and beams look asteroids up here) */
  private asteroidOrbits = new AsteroidOrbits();
  /** The tick each asteroid's Position was last worked out for */
  private asteroidPlacedAt = new Map<number, number>();
  
  // Entity state cache for delta compression
  private lastEntityStates: Map<number, Map<number, string>> = new Map(); // playerId -> entityId -> serialized state
  
  // System-specific state
  /** Derelict hulks by slot: the current body (-1 while destroyed) and when it comes back */
  /** Derelict slots: the same array as derelictsMod.derelicts (game/Derelicts.ts) */
  private derelicts!: DerelictSlot[];
  /** Derelicts and people's craft (game/Derelicts.ts) */
  private derelictsMod!: Derelicts;
  /** Freighters: which station they're bound for, and how long they've been docked there */
  private traffic: { data: TrafficData; systemNum: number; eid: number; leg: number; dwell: number; respawnTick: number }[] = [];
  
  // NPC ID mapping (npcId number -> npc string id)
  
  
  /** Items, recipes and part costs (shared with the client) */
  readonly econ: Economy;
  /** Each player's progress: profile, cargo, storage, saving */
  readonly pilots: Pilots;
  private pods: LootPods;
  /** Part features' world side (ships/features/host.ts): built once, ticked in the 'towing' entry's place */
  features!: ServerFeatures;
  private mining: Mining;
  services: StationServices;
  ammo!: Ammo;
  /** The dev weapons range (game/WeaponsRange.ts): null unless this is a dev server */
  range: WeaponsRange | null = null;
  private hazards!: Hazards;
  private warmth!: Warmth;
  outpost?: Outpost;
  homes!: HomeStations;
  private weapons: Weapons;
  readonly enemies: Enemies;
  /** Story, chains and bounties */
  readonly quests: Quests;
  /** Who you can talk to, and the conversations */
  readonly people: People;
  /** Records: lore found as documents and testimony */
  readonly codex: Codex;
  /** Jobs' private battlegrounds */
  readonly arenas: Arenas;
  readonly bosses: Bosses;
  /** Single-body enemies (data/mobs.json): what boss bays launch */
  readonly mobs: Mobs;
  readonly events: Events;
  readonly admin: AdminTools;
  /** Contributor notes and the contributor rank */
  readonly contrib: ContributorNotes<ClientConnection>;
  readonly surfaces: Surfaces;
  readonly sieges: Sieges;
  readonly hangar: Hangar;
  readonly party: Party;
  /** Who's been mending whom (Repair Beams): support counts towards kills' and bosses' rewards (the support feature's ledger: ships/features/support/Support.ts) */
  support!: Support;
  readonly trade: Trade;
  readonly ops: Operations;
  readonly market: Market;
  readonly replication: Replication;
  /** Pilotless ships far from every pilot go distant: out of the pipeline, flown by routes worked out by time (ships/SimLod.ts) */
  readonly lod: SimLod;
  /** A system nobody's in is put away whole and brought back as it was, through restarts too (game/SystemMemory.ts) */
  readonly memory: SystemMemory;
  readonly achievements: Achievements;
  /** Pilotless ships players protect (escorted freighters, outposts): their names */
  private wards = new Map<number, string>();
  /** People's ships, parked where they live (people.json craft): untouchable, by name. The same Map as derelictsMod.personCraft */
  private personCraft!: Map<number, string>;
  readonly clock: () => number;
  /** Disconnected mid-fight: the ship stays in space until this tick */
  private lingering = new Map<number, { conn: ClientConnection; until: number }>();

  /** Outgoing messages: outboxes, lazy effects, broadcasts, byte counters (net/snapshot/Outbox.ts) */
  readonly net: Outbox;
  /** The snapshot path: rows, snapshots, ship structure, map dots, entering a system (net/SnapshotBuilder.ts) */
  readonly snapshots: SnapshotBuilder;

  // Admin server for dev tools
  private adminServer: AdminServer | null = null;
  
  // User database for auth
  userDB: UserStore;
  
  // Error tracking for admin stats
  private recentErrors: string[] = [];
  private static readonly MAX_ERRORS = 50;
  private tickTimeHistory: number[] = [];
  private totalConnectionsEver = 0;
  
  // Scheduled game loop callback (setTimeout or setImmediate handle)
  private gameLoopTimer: unknown = null;

  constructor(opts: GameServerOptions) {
    this.world = createWorld();
    this.net = new Outbox(this);
    this.gameData = opts.gameData;
    this.adminServer = opts.adminServer || null;
    this.userDB = opts.userDB;
    this.scene = opts.scene ?? 'sectors';
    this.everyoneAdmin = opts.everyoneAdmin ?? false;
    // (never on a production server, whatever it was started with)
    this.guestAdmin = !!opts.guestAdmin && process.env.NODE_ENV !== 'production';
    this.freeBuildAllowed = !!opts.freeBuild && process.env.NODE_ENV !== 'production';
    if (opts.devStart && process.env.NODE_ENV !== 'production' && this.gameData.getSystem(opts.devStart)) this.devStartNum = this.gameData.getSystemNum(opts.devStart);
    this.ships = opts.ships;
    this.ships.attach(this.createShipHost());
    this.shipEditAnywhere = opts.shipEditAnywhere ?? false;
    this.econ = new Economy(this.gameData.itemsFile, this.gameData.recipesFile, this.ships.catalog, Object.fromEntries(this.ships.library));
    this.pods = new LootPods(this.createPodHost(), this.econ.items);
    // ---- Part features (ships/features: the Tow Beam; the tick, cargo, wire and message seams)
    this.features = new ServerFeatures(SERVER_FEATURES, {
      world: this.world,
      ships: this.ships,
      pods: this.pods,
      tuning: this.ships.tuning,
      getTick: () => this.currentTick,
      tell: (pilot, text, color) => { for (const c of this.clients.values()) if (c.playerId === pilot) this.send(c.ws, { type: 'systemMessage', text, color }); },
      stationInRange: (pilot) => this.stationInRange(pilot),
      isDocked: (pilot) => this.dockedShips.has(pilot),
      deliver: (pilot, target, kind) => this.derelictsMod.towDelivered(pilot, target, kind),
      effect: (eid, type) => this.broadcastToSystem(InSystem.systemId[eid], { type: 'effect', effectType: type, x: Math.round(Position.x[eid]), y: Math.round(Position.y[eid]), entityId: eid }),
    }, new Set(this.handlers.keys()));
    // A feature's messages join the table (the handlers field is built before the constructor body; the table is a Map)
    for (const [type, fn] of this.features.messages) {
      (this.handlers as Map<string, Handler>).set(type, (_ctx, conn, msg) => {
        if (!hasComponent(this.world, Player, conn.playerId)) return;
        fn(conn.playerId, msg);
      });
    }
    this.support = this.features.get('support') as unknown as Support;
    // ---- (end part features)
    this.mining = new Mining(this.createMiningHost(), this.gameData.miningTable);
    this.weapons = new Weapons({
      world: this.world,
      tick: () => this.currentTick,
      broadcast: (num, msg) => this.broadcastToSystem(num, msg),
      remove: (eid) => { addComponent(this.world, Dead, eid); this.pendingRemovedEntities.add(eid); },
      nudge: (eid, ax, ay) => {
        if (hasComponent(this.world, Dead, eid) || this.ships.get(eid)?.kind === 'debris') return;
        Velocity.x[eid] += ax;
        Velocity.y[eid] += ay;
      },
      miningTool: (kind, turret) => {
        const t = this.gameData.miningTable.tools as unknown as Record<string, { yield: number; hardness: number }>;
        return kind === 'cannon' ? t[turret ? 'turret' : 'fixed'] : t[kind] ?? { yield: 0.05, hardness: 1 };
      },
    }, this.ships, this.ships.tuning);
    this.enemies = new Enemies(this.createEnemyHost(), this.ships, withNests(withZoneSpots(this.gameData.factionsFile as FactionsFile, (id) => this.gameData.getSystem(id)), (id) => this.gameData.getSystem(id)), this.ships.enemyDesigns);
    this.enemies.econ = this.econ;
    const profileStore = opts.profileStore ?? new MemoryProfileStore();
    this.pilots = new Pilots(this.createPilotHost(), this.econ, this.ships, profileStore, {
      starter: this.starterKit(),
      guestShips: process.env.NODE_ENV !== 'production' ? opts.guestShips : undefined,
      spawn: this.devStartNum >= 0 ? (eid) => this.devStartSpot(eid) : undefined,
      freeRebuildBelowLevel: 3,
      autosaveMs: 30_000,
      now: opts.clock,
    });
    this.pilots.telemetry = new Telemetry(opts.telemetry ?? null, opts.clock);
    const stationAtConn = (conn: unknown) => {
      const c = conn as ClientConnection;
      const st = c.docked && entityExists(this.world, c.docked.station) ? c.docked.station : this.stationInRange(c.playerId);
      return st >= 0 && hasComponent(this.world, Player, c.playerId) && !hasComponent(this.world, Dead, c.playerId)
        ? this.gameData.getStationByNum(Station.stationId[st]) ?? null : null;
    };
    this.market = new Market({
      now: opts.clock ?? (() => Date.now()),
      send: (conn, msg) => this.send((conn as ClientConnection).ws, msg),
      stations: () => this.gameData.getAllStations(),
      systemName: (id) => this.gameData.getSystem(id)?.name ?? id,
      stationAt: stationAtConn,
    }, this.econ, this.pilots, this.gameData.questsFile.reputations);
    this.services = new StationServices({
      stationAt: (conn) => {
        const c = conn as ClientConnection;
        const st = c.docked && entityExists(this.world, c.docked.station) ? c.docked.station : this.stationInRange(c.playerId);
        return st >= 0 && hasComponent(this.world, Player, c.playerId) && !hasComponent(this.world, Dead, c.playerId)
          ? this.gameData.getStationByNum(Station.stationId[st]) ?? null : null;
      },
      stationName: (id) => this.gameData.getStation(id)?.name ?? id,
      send: (conn, msg) => this.send((conn as ClientConnection).ws, msg),
      now: opts.clock ?? (() => Date.now()),
      delivered: (conn) => this.hangar?.fill(conn),
      cancelled: (conn, job) => this.hangar?.jobCancelled(conn, job),
      jobsChanged: (conn) => this.hangar?.send(conn),
      refined: (conn, used) => this.releaseTraces(conn, used),
      station: (id) => this.gameData.getStation(id) ?? null,
      stationsWith: (service) => this.gameData.getAllStations().filter((st) => st.services.includes(service as never)),
    }, this.pilots, this.econ, this.market);
    this.ammo = new Ammo(this.pilots, this.ships.tuning, this.ships.catalog);
    this.ammo.hangar = (conn) => this.hangar?.send(conn);
    this.hazards = new Hazards({
      flying: () => [...this.clients.values()].filter((c) => this.flying(c.playerId)).map((c) => ({ conn: c, eid: c.playerId })),
      system: (eid) => this.gameData.getSystemByNum(InSystem.systemId[eid]),
      position: (eid) => ({ x: Position.x[eid], y: Position.y[eid] }),
      toast: (conn, text, kind) => this.pilots.toast(conn as ClientConnection, text, kind),
      tick: () => this.currentTick,
    }, this.ships, this.gameData.hazardRules);
    // Cold building up on pilots' ships, and heat bringing them back (game/Warmth.ts)
    this.warmth = new Warmth({
      flying: () => [...this.clients.values()].filter((c) => this.flying(c.playerId)).map((c) => ({ conn: c, eid: c.playerId })),
      system: (eid) => this.gameData.getSystemByNum(InSystem.systemId[eid]),
      systemNum: (eid) => InSystem.systemId[eid],
      position: (eid) => ({ x: Position.x[eid], y: Position.y[eid] }),
      docked: (eid) => this.dockedShips.has(eid),
      stations: (eid) => [...stationQuery(this.world)].filter((st) => InSystem.systemId[st] === InSystem.systemId[eid]).map((st) => ({ x: Position.x[st], y: Position.y[st], radius: Radius.value[st] })),
      toast: (conn, text, kind) => this.pilots.toast(conn as ClientConnection, text, kind),
      tick: () => this.currentTick,
    }, this.ships, this.gameData.hazardRules);
    this.services.gems = this.gameData.gemsFile;
    this.homes = new HomeStations({
      tick: () => this.currentTick,
      instances: (id) => this.gameData.getSystemInstances(id),
      pilots: (num) => [...this.clients.values()].filter((c) => this.flying(c.playerId) && InSystem.systemId[c.playerId] === num),
      travel: (conn, num, x, y) => { (conn as ClientConnection).docked = null; this.travelTo(conn as ClientConnection, num, x, y, false); },
      systemNum: (id) => this.gameData.getSystemNum(id),
      stationSystem: (id) => this.gameData.getStation(id)?.system,
      spawnDock: (num) => { const d = this.gameData.getStation('homestead_dock'); return d ? this.createStation(d, num) : -1; },
      spawnGate: (num, x, y, to) => this.createPortal({ position: { x, y }, targetSystem: to }, num),
      spawnStructure: (bp, num, x, y, name) => {
        const eid = this.ships.spawnDummy(bp, x, y, 0, num);
        this.ships.pin(eid);
        // Named, and out of every fight (as people's craft are)
        this.personCraft.set(eid, name);
        return eid;
      },
      remove: (eid) => {
        if (eid < 0) return;
        if (this.ships.has(eid)) { this.personCraft.delete(eid); this.ships.removeShip(eid); return; }
        if (!entityExists(this.world, eid)) return;
        this.pendingRemovedEntities.add(eid);
        removeEntity(this.world, eid);
      },
      toast: (conn, text, kind) => this.pilots.toast(conn as ClientConnection, text, kind),
    }, this.pilots);
    if (this.gameData.stationFile) this.outpost = new Outpost({
      now: () => this.clock(),
      stationAt: (conn) => this.services.stationAt(conn),
      stationName: (id) => this.gameData.getStation(id)?.name ?? id,
    }, this.pilots, this.gameData.stationFile);
    this.hangar = new Hangar({ send: (conn, msg) => this.send((conn as ClientConnection).ws, msg), now: opts.clock ?? (() => Date.now()), freeBuild: (conn) => this.freeBuild(conn as ClientConnection) },
      this.pilots, this.ships, this.econ, this.ships.catalog, this.services);
    this.hangar.gems = this.gameData.gemsFile;
    this.pilots.onEvent((conn, ev) => {
      if (ev.type !== 'login') return;
      this.hangar.send(conn);
      this.ammo.firstIssue(conn, this.ships.get(conn.playerId));
    });
    this.clock = opts.clock ?? (() => Date.now());
    this.quests = new Quests(this.createQuestHost(), this.pilots, this.gameData.questsFile);
    this.docking = new Docking({
      world: this.world,
      gameData: this.gameData,
      clients: this.clients,
      shipEditAnywhere: this.shipEditAnywhere,
      pilots: this.pilots,
      ammo: this.ammo,
      quests: this.quests,
      send: (ws, msg) => this.send(ws, msg),
      clock: this.clock,
      releaseControls: (eid) => this.releaseControls(eid),
    });
    this.dockedShips = this.docking.dockedShips;
    this.bosses = new Bosses(this.createBossHost(), this.enemies, this.ships, this.gameData.bossesFile as BossesFile, this.ships.enemyDesigns);
    this.mobs = new Mobs(this.createMobHost(), this.gameData.mobsFile as MobsFile);
    this.bosses.mobs = this.mobs;
    this.events = new Events(this.createEventHost(), this.enemies, this.gameData.factionsFile as FactionsFile, this.gameData.rulesFile.events, this.gameData.stringsFile);
    this.party = new Party(this.createPartyHost());
    this.admin = new AdminTools(this.createAdminHost());
    this.contrib = new ContributorNotes<ClientConnection>({
      conns: () => this.clients.values(),
      send: (c, msg) => this.send(c.ws, msg),
      bodies: (id) => {
        const sys = this.gameData.getSystem(id);
        if (!sys) return null;
        return { planets: sys.planets, nests: sys.nests, lodestones: sys.lodestones, stations: this.gameData.getSystemStations(id) };
      },
      tick: () => this.currentTick,
    }, opts.contributorStore ?? null, opts.clock);
    this.surfaces = new Surfaces(this.createSurfaceHost(), this.gameData.rulesFile.surfaces, this.gameData.stringsFile);
    this.sieges = new Sieges(this.createSiegeHost(), this.gameData.rulesFile.sieges, this.gameData.stringsFile);
    this.surfaces.partyEntry = (conn, surface) => this.sieges.enter(conn, surface);
    this.people = new People(this.createPeopleHost(), this.pilots, this.quests, this.gameData.peopleFile, this.gameData.stringsFile);
    this.quests.people = this.people;
    this.codex = new Codex({
      send: (conn, msg) => this.send((conn as ClientConnection).ws, msg),
      ctx: (conn, p) => this.people.ctx(conn, p),
      wreckLogs: (conn) => {
        const eid = (conn as ClientConnection).playerId;
        if (!this.derelicts.some((d) => d.data.log) || !this.flying(eid)) return [];
        const num = InSystem.systemId[eid], x = Position.x[eid], y = Position.y[eid];
        return this.derelicts.filter((d) => d.data.log && d.systemNum === num && d.eid >= 0 && this.ships.has(d.eid)
          && Math.hypot(Position.x[d.eid] - x, Position.y[d.eid] - y) < DERELICT_LOG_RANGE).map((d) => d.data.log!.codex);
      },
    }, this.pilots, this.gameData.codexFile, this.gameData.itemsFile.items, this.gameData.stringsFile);
    this.quests.codex = this.codex;
    this.people.codex = this.codex;
    this.arenas = new Arenas(this.createArenaHost());
    this.achievements = new Achievements({
      send: (conn, msg) => this.send((conn as ClientConnection).ws, msg),
      broadcast: (msg) => { for (const c of this.clients.values()) this.send(c.ws, msg); },
      now: this.clock,
    }, this.pilots, this.gameData.achievementsFile as RibbonsFile, profileStore);
    // New arrivals hear about this week's hunt
    this.pilots.onEvent((conn, ev) => {
      if (ev.type !== 'login') return;
      const h = this.hunted();
      if (h) this.send((conn as ClientConnection).ws, { type: 'news', text: `This week's hunt: ${h.name} in ${this.gameData.getSystem(h.system)?.name ?? h.system}. Double XP and credits for everyone in on the kill`, kind: 'hunt', at: this.clock(), old: true });
    });
    this.replication = new Replication({
      tick: () => this.currentTick,
      env: (eid) => this.replicaEnv(InSystem.systemId[eid]),
      dockOf: (eid) => {
        const c = this.liveConn(eid);
        return c?.docked ? { station: c.docked.station, ox: c.docked.ox, oy: c.docked.oy } : null;
      },
      docks: () => {
        const out = new Map<number, { station: number; ox: number; oy: number }>();
        for (const c of this.clients.values()) if (c.docked) out.set(c.playerId, { station: c.docked.station, ox: c.docked.ox, oy: c.docked.oy });
        return out;
      },
      occupied: () => {
        const out = new Set<number>();
        for (const c of this.clients.values()) out.add(InSystem.systemId[c.playerId]);
        return out;
      },
    }, this.ships);
    this.lod = new SimLod({
      tick: () => this.currentTick,
      observers: () => this.lodObservers(),
      intent: (eid, at) => this.trafficIntent(eid, at) ?? this.enemies.intent(eid, at),
      busy: (eid) => (this.wards.has(eid) && this.lodOccupied.has(InSystem.systemId[eid])) || this.bosses.busy(eid),
      watched: () => {
        const out = new Set<number>();
        for (const c of this.clients.values()) { const t = this.ships.targetOf(c.playerId); if (t >= 0) out.add(t); }
        return out;
      },
    }, this.ships);
    // (A distant pack sent somewhere new is flown there from where its route has it)
    this.enemies.onOrders = (eid) => this.lod.replan(eid);
    this.memory = new SystemMemory(this.createMemoryHost(), this.gameData.rulesFile.memory, opts.worldStore);
    this.derelictsMod = new Derelicts({
      world: this.world,
      gameData: this.gameData,
      clients: this.clients,
      ships: this.ships,
      pilots: this.pilots,
      pods: this.pods,
      codex: this.codex,
      people: this.people,
      memory: this.memory,
      econ: this.econ,
      send: (ws, msg) => this.send(ws, msg),
      tick: () => this.currentTick,
    });
    this.derelicts = this.derelictsMod.derelicts;
    this.personCraft = this.derelictsMod.personCraft;
    if (this.scene === 'sectors') this.memory.load();
    this.trade = new Trade({
      send: (conn, msg) => this.send((conn as ClientConnection).ws, msg),
      byEntity: (eid) => this.liveConn(eid),
      distance: (a, b) => {
        const ea = a.playerId, eb = b.playerId;
        if (!this.flying(ea) || !this.flying(eb) || InSystem.systemId[ea] !== InSystem.systemId[eb]) return Infinity;
        return Math.hypot(Position.x[ea] - Position.x[eb], Position.y[ea] - Position.y[eb]);
      },
      now: this.clock,
      log: (t) => console.log(`[Trade] ${t}`),
    }, this.pilots);
    this.ops = new Operations(this.createOpsHost(), this.quests, () => [...this.clients.values()].filter((c) => this.flying(c.playerId) || hasComponent(this.world, Player, c.playerId)), this.gameData.rulesFile.operations, this.gameData.stringsFile);
this.devTeleport = opts.devTeleport ?? false;
    if (opts.devRange && this.devTeleport && process.env.NODE_ENV !== 'production') this.range = this.createRange(opts.devRange);
    
    // The snapshot path (net/SnapshotBuilder.ts): built once, after every module it reads
    this.snapshots = new SnapshotBuilder({
      world: this.world,
      gameData: this.gameData,
      clients: this.clients,
      scene: this.scene,
      ships: this.ships,
      enemies: this.enemies,
      lod: this.lod,
      party: this.party,
      events: this.events,
      surfaces: this.surfaces,
      asteroidIdsBySystem: this.asteroidIdsBySystem,
      asteroidSeedTickBySystem: this.asteroidSeedTickBySystem,
      asteroidIndexById: this.asteroidIndexById,
      respawnedAsteroids: this.respawnedAsteroids,
      send: (ws, msg) => this.send(ws, msg),
      namedBody: (eid) => this.namedBody(eid),
      flying: (eid) => this.flying(eid),
      asteroidSpawnData: (eid) => this.asteroidSpawnData(eid),
      replication: this.replication,
      mobs: this.mobs,
      pods: this.pods,
      features: this.features,
      personCraft: this.personCraft,
      wards: this.wards,
      lingering: this.lingering,
      pendingRemovedEntities: this.pendingRemovedEntities,
      lastEntityStates: this.lastEntityStates,
    }, this);

    // Hook up admin server events
    if (this.adminServer) {
      this.setupAdminHandlers();
    }

    // Initialize world (the empty scene has no stations, NPCs, portals or asteroids)
    if (this.scene === 'sectors') {
      this.initializeWorld();
    } else {
      // The client treats playerId 0 as "no player", so never hand out entity 0
      addEntity(this.world);
    }

    // Track errors for admin stats
    const origConsoleError = console.error;
    console.error = (...args: any[]) => {
      origConsoleError.apply(console, args);
      const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
      this.recentErrors.push(`[${new Date().toISOString()}] ${msg}`);
      if (this.recentErrors.length > GameServer.MAX_ERRORS) this.recentErrors.shift();
    };

    // Clean up expired sessions periodically
    setInterval(() => this.userDB.cleanupExpiredSessions(), 60 * 60 * 1000);

    // Start game loop
    if (opts.autoStart ?? true) {
      this.lastTickTime = performance.now();
      this.gameLoop();
    }
  }

  // ============================================
  // EXTERNAL CONTROL (transports, proto tools, tests)
  // ============================================

  /** Run exactly one simulation tick (inputs drained first), as the real-time loop does. */
  step(): void {
    this.net.batching++;
    try {
      this.guard('inputs', () => this.drainInputQueue());
      this.tick();
      if (this.currentTick - this.lastSnapshotTick >= TICK_RATE / SNAPSHOT_RATE) {
        this.lastSnapshotTick = this.currentTick;
        this.guard('snapshots', () => this.sendSnapshots());
      }
    } finally {
      this.net.batching--;
      this.flushOutbox();
    }
  }

  /** Pause the real-time loop (hangar editor). Messages are still accepted. */
  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  isPaused(): boolean {
    return this.paused;
  }

  getTick(): number {
    return this.currentTick;
  }

  getWorld(): IWorld {
    return this.world;
  }

  /** Modular ships bridge. */
  getShips(): ShipBridge {
    return this.ships;
  }

  /** Player entity id for a connected socket, or 0. */
  getPlayerId(socket: ClientSocket): number {
    return this.clients.get(socket)?.playerId ?? 0;
  }

  /** The engine services modular ships use (entities, base shot, damage events). */
  /** What a brand-new pilot starts with */
  private starterKit(): StarterKit {
    return {
      blueprint: this.ships.playerBlueprint,
      planFile: 'sparrow-t',
      credits: 300,
      storage: {
        iron_ore: 40, nickel_ore: 20, silicate: 20, copper_ore: 10,
        alloy_plate: 14, copper_wire: 6, repair_kit: 2, boost_cell: 2,
      },
      home: 'sol_station_central',
      // (Inside the star, so never "where they left off": a new pilot appears at their home station, Pilots.homePoint)
      position: { system: 'sol', x: 0, y: 0 },
    };
  }

  /** Just outside the starter station's docking ring (Sol Central), wherever it is on its orbit */
  private starterSpot(): { x: number; y: number } {
    const id = this.gameData.getStation('sol_station_central') ? 'sol_station_central' : undefined;
    const st = id ? [...stationQuery(this.world)].find((e) => this.gameData.getStationByNum(Station.stationId[e])?.id === id) : undefined;
    const a = Math.random() * Math.PI * 2;
    if (st !== undefined) {
      // (Inside its docking ring, where the tutorial's first stop is, clear of its hull)
      const d = this.gameData.getStation(id!);
      const r = Math.max((d?.radius ?? 0) + 120, stationInteractRadius(d?.radius ?? 0, d?.design) * 0.85);
      return { x: Position.x[st] + Math.cos(a) * r, y: Position.y[st] + Math.sin(a) * r };
    }
    // (No station yet: well clear of the star)
    const sys = this.gameData.getSystem('sol');
    const r = (sys?.centralBody?.radius ?? sys?.starRadius ?? 0) + 12000;
    return { x: Math.cos(a) * r, y: Math.sin(a) * r };
  }

  /**
   * Where a pilot appears in the dev start system: on a ring well clear of the star, just inside the asteroid belt's
   * inner edge (rocks close by, none underneath), each pilot at their own angle
   */
  private devStartSpot(eid: number): { system: number; x: number; y: number } {
    const sys = this.gameData.getSystemByNum(this.devStartNum);
    const star = sys?.centralBody?.radius ?? sys?.starRadius ?? 0;
    const belt = sys?.asteroidBelt?.innerRadius ?? 0;
    const r = Math.max(star + 1500, belt - 600);
    const a = (eid * 2.399) % (Math.PI * 2);
    return { system: this.devStartNum, x: Math.cos(a) * r, y: Math.sin(a) * r };
  }

  private createPilotHost(): PilotHost {
    return {
      world: this.world,
      tick: () => this.currentTick,
      send: (conn, msg) => this.send((conn as ClientConnection).ws, msg),
      stationInRange: (eid) => this.stationInRange(eid),
      stationEntity: (id) => {
        const num = this.gameData.getStationNum(id);
        for (const st of stationQuery(this.world)) if (Station.stationId[st] === num) return st;
        return -1;
      },
      stationInfo: (st) => {
        const d = this.gameData.getStationByNum(Station.stationId[st]);
        return d ? { id: d.id, name: d.name, radius: d.dockingRadius ?? d.radius } : null;
      },
      systemId: (num) => this.gameData.getSystemByNum(num)?.id,
      systemNum: (id) => (this.gameData.getSystem(id) ? this.gameData.getSystemNum(id) : -1),
      safeToAppear: (num, x, y) => {
        const sys = this.gameData.getSystemByNum(num);
        if (!sys) return false;
        const cb = sys.centralBody;
        // (Clear of the star's surface, whatever its size)
        const body = Math.max(cb?.gravity?.horizon ?? 0, cb?.radius ?? sys.starRadius ?? 0);
        return body <= 0 || Math.hypot(x, y) > body + 4000;
      },
      place: (conn, num, x, y) => {
        // Someone's station only exists while it's loaded: back out by its jump point
        if (this.gameData.getSystemByNum(num)?.private && num !== this.devStartNum) {
          const out = this.homes.exitFor(num) ?? this.siteExit(conn as ClientConnection);
          if (out) return this.placePlayer(conn as ClientConnection, out.num, out.x + 500, out.y);
        }
        this.placePlayer(conn as ClientConnection, num, x, y);
      },
      spawnPod: (num, x, y, vx, vy, items, droppedBy) => this.pods.spawn(num, x, y, vx, vy, items, droppedBy),
      spawnWreck: (num, x, y, vx, vy, items, key, seconds) => {
        const eid = this.pods.spawn(num, x, y, vx, vy, items, -1, 0, seconds * 60);
        if (eid >= 0) this.pods.keep(eid, key, this.currentTick + seconds * 60);
        return eid;
      },
      safeAt: (num, x, y) => inSafeSpace(this.gameData.getSystemByNum(num), x, y),
    };
  }

  private createQuestHost() {
    const factions = this.gameData.factionsFile as FactionsFile;
    const stationAt = (conn: ClientConnection): string | null => {
      const st = conn.docked && entityExists(this.world, conn.docked.station) ? conn.docked.station : this.stationInRange(conn.playerId);
      if (st < 0 || !hasComponent(this.world, Player, conn.playerId) || hasComponent(this.world, Dead, conn.playerId)) return null;
      return this.gameData.getStationByNum(Station.stationId[st])?.id ?? null;
    };
    const pretty = (id: string) => id.replace(/^boss_/, '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    return {
      send: (conn: unknown, msg: ServerMessage) => this.send((conn as ClientConnection).ws, msg),
      now: this.clock,
      stationAt: (conn: unknown) => stationAt(conn as ClientConnection),
      where: (conn: unknown) => this.whereIs(conn as ClientConnection),
      enterArena: (conn: unknown, arena: string, boss: string) => this.arenas.enter(conn as ClientConnection, arena, boss),
      systemOf: (conn: unknown) => {
        const eid = (conn as ClientConnection).playerId;
        return hasComponent(this.world, Player, eid) && !hasComponent(this.world, Dead, eid) ? this.gameData.getSystemByNum(InSystem.systemId[eid])?.id : undefined;
      },
      ship: (conn: unknown) => {
        const ship = this.ships.get((conn as ClientConnection).playerId);
        if (!ship) return null;
        const fns: Record<string, number> = {};
        const materials: Record<string, number> = {};
        let parts = 0;
        ship.blueprint.parts.forEach((p, i) => {
          if (!ship.derived.alive[i]) return;
          parts++;
          fns[p.fn] = (fns[p.fn] ?? 0) + 1;
          // (A model counts as the kind of part it is too: a Mining Laser is a miner, a Pip a weapon)
          const look = lookFn(p.fn);
          if (look !== p.fn) fns[look] = (fns[look] ?? 0) + 1;
          materials[p.material] = (materials[p.material] ?? 0) + 1;
          materials[`${p.fn}:${p.material}`] = (materials[`${p.fn}:${p.material}`] ?? 0) + 1;
        });
        return { parts, fns, materials };
      },
      bountyContext: (stationId: string) => {
        const st = this.gameData.getStation(stationId);
        const sys = st && this.gameData.getSystem(st.system);
        if (!st || !sys) return null;
        const danger = sys.danger ?? 1;
        const groups = factions.spawns?.[sys.id]?.groups ?? [];
        const ores = ['iron_ore', 'nickel_ore', 'silicate', 'ice'];
        if (danger >= 2) ores.push('copper_ore');
        if (danger >= 4) ores.push('titanium_ore');
        // Couriers go to stations here or one gate on; escorts to other stations here; scans need wrecks
        const peers = sys.stations.filter((s) => s !== st.id && this.gameData.getStation(s));
        const destinations = peers.map((id) => ({ id, hops: 0 }));
        for (const g of sys.portals ?? []) {
          if (this.quests?.file.restricted[g.targetSystem]) continue;
          for (const s of this.gameData.getSystem(g.targetSystem)?.stations ?? []) destinations.push({ id: s, hops: 1 });
        }
        return { station: { id: st.id, name: st.name, system: sys.id }, danger, factions: [...new Set(groups.map((g) => g.faction))], ores,
          peers, destinations, derelicts: (sys.derelicts ?? []).length };
      },
      stationSystem: (id: string) => this.gameData.getStation(id)?.system,
      bossLair: (boss: string) => this.enemies.bossLair(boss),
      party: (conn: unknown) => this.party.members(conn as ClientConnection),
      leads: (conn: unknown) => this.party.isLeader(conn as ClientConnection),
      completed: (conn: unknown, q: { chain: string; name: string }) => {
        if (q.chain !== 'fleet') return;
        const c = conn as ClientConnection;
        const names = this.party.members(c).map((m) => m.username);
        this.achievements.post(`${names.join(', ')} completed ${q.name.replace(/^Fleet op: /, 'a fleet op: ')}`, 'fleet');
      },
      opTarget: (conn: unknown, id: string) => this.ops?.target(conn as ClientConnection, id),
      names: {
        item: (id: string) => this.econ.items.name(id),
        station: (id: string) => this.gameData.getStation(id)?.name ?? id,
        system: (id: string) => this.gameData.getSystem(id)?.name ?? id,
        faction: (id: string) => factions.factions?.[id]?.name ?? id,
        enemy: (id: string) => this.enemies.displayName(id),
        plan: (file: string) => this.ships.library.get(file)?.name ?? file,
        recipe: (id: string) => {
          const [kind, what] = id.split(':');
          // (a plain recipe, an item's own: Quench Slugs)
          if (what === undefined) return `${this.econ.items.name(kind)} (recipe)`;
          return `${pretty(what)} fabrication`;
        },
      },
    };
  }

  /** Systems someone is in, as of the last lodObservers */
  private lodOccupied = new Set<number>();

  /**
   * Where the pilots are, for SimLod: each a point, or while its jump drive
   * spools and burns, the line out along all the jump could reach (whatever
   * it lands near is woken before it gets there)
   */
  private lodObservers(): Map<number, number[]> {
    const out = new Map<number, number[]>();
    this.lodOccupied.clear();
    const jt = jumpTuning(this.ships.tuning);
    for (const c of this.clients.values()) {
      const p = c.playerId;
      if (!entityExists(this.world, p) || !hasComponent(this.world, Player, p)) continue;
      const sys = InSystem.systemId[p];
      this.lodOccupied.add(sys);
      let list = out.get(sys);
      if (!list) out.set(sys, (list = []));
      const x = Position.x[p], y = Position.y[p];
      const ship = this.ships.get(p);
      const phase = ship && ship.jump > 0 ? jumpPhase(ship.jump, jt).phase : 'ready';
      if (ship && (phase === 'charging' || phase === 'burn')) {
        // (Its reach with every boost a field can give, and then some)
        const reach = Math.max(jt.baseRange, ship.derived.jumpRange || 0) * 1.6, a = Rotation.angle[p];
        list.push(x, y, x + Math.cos(a) * reach, y + Math.sin(a) * reach);
      } else list.push(x, y, x, y);
    }
    // Wards count as someone being there (hostiles near one go for it), while their system's occupied
    for (const w of this.wards.keys()) {
      const list = out.get(InSystem.systemId[w]);
      if (list && this.ships.has(w)) list.push(Position.x[w], Position.y[w], Position.x[w], Position.y[w]);
    }
    return out;
  }

  /** Is this entity a live player ship */
  flying(eid: number): boolean {
    return eid >= 0 && hasComponent(this.world, Player, eid) && !hasComponent(this.world, Dead, eid);
  }

  /** The connection flying this entity (not one that's lingering after quitting) */
  liveConn(eid: number): ClientConnection | undefined {
    for (const c of this.clients.values()) if (c.playerId === eid) return c;
    return undefined;
  }

  private createPartyHost() {
    return {
      send: (conn: unknown, msg: ServerMessage) => this.send((conn as ClientConnection).ws, msg),
      toast: (conn: unknown, text: string, kind?: 'info' | 'good' | 'warn' | 'bad') => this.pilots.toast(conn as ClientConnection, text, kind),
      byName: (name: string) => [...this.clients.values()].find((c) => c.username.toLowerCase() === name.toLowerCase()),
      byEntity: (eid: number) => this.liveConn(eid),
      status: (conn: unknown) => {
        const c = conn as ClientConnection;
        const eid = c.playerId;
        const p = this.pilots.get(c);
        if (!this.flying(eid)) return p ? { system: '', x: 0, y: 0, hull: 0, alive: false, level: p.level, ship: '' } : null;
        return {
          system: this.gameData.getSystemByNum(InSystem.systemId[eid])?.id ?? '', x: Position.x[eid], y: Position.y[eid],
          hull: this.ships.integrity(eid), alive: true, level: p?.level ?? 1, ship: this.ships.get(eid)?.blueprint.name ?? '',
        };
      },
      partySize: (conn: unknown) => { const p = this.pilots.get(conn as ClientConnection); return p ? unlocks(p).partySize : 4; },
      setWing: (conn: unknown, k: number) => this.ships.setWingBonus((conn as ClientConnection).playerId, k),
      now: this.clock,
    };
  }

  private createOpsHost() {
    const stationPos = (id: string) => {
      const st = this.gameData.getStation(id);
      if (!st) return null;
      const num = this.gameData.getSystemNum(st.system);
      const e = this.stationEntity(id, num);
      return e < 0 ? null : { system: st.system, x: Position.x[e], y: Position.y[e], name: st.name };
    };
    const factions = this.gameData.factionsFile as FactionsFile;
    return {
      tick: () => this.currentTick,
      now: this.clock,
      send: (conn: unknown, msg: ServerMessage) => this.send((conn as ClientConnection).ws, msg),
      toast: (conn: unknown, text: string, kind?: 'info' | 'good' | 'warn' | 'bad') => this.pilots.toast(conn as ClientConnection, text, kind),
      pilot: (conn: unknown) => {
        const eid = (conn as ClientConnection).playerId;
        if (!this.flying(eid)) return null;
        return { system: this.gameData.getSystemByNum(InSystem.systemId[eid])?.id ?? '', x: Position.x[eid], y: Position.y[eid], vx: Velocity.x[eid], vy: Velocity.y[eid] };
      },
      station: stationPos,
      stationName: (id: string) => this.gameData.getStation(id)?.name ?? id,
      derelicts: (system: string) => {
        const num = this.gameData.getSystemNum(system);
        return this.derelicts.filter((d) => d.systemNum === num && d.eid >= 0 && this.ships.has(d.eid))
          .map((d) => ({ eid: d.eid, name: d.data.name, x: Position.x[d.eid], y: Position.y[d.eid] }));
      },
      spawnWard: (kind: 'freighter' | 'outpost', system: string, x: number, y: number, angle: number, name: string) => {
        const bp = this.ships.library.get(kind === 'freighter' ? 'hauler' : 'bulwark');
        if (!bp) return -1;
        const eid = this.ships.spawnDummy(bp, x, y, angle, this.gameData.getSystemNum(system));
        this.ships.scaleHp(eid, kind === 'outpost' ? 4 : 1.6);
        this.wards.set(eid, name);
        this.enemies.addWard(eid);
        return eid;
      },
      steer: (eid: number, to: { x: number; y: number; arrive: number } | null) => this.ships.setAutopilot(eid, to ? { x: to.x, y: to.y, arriveRadius: to.arrive } : null),
      removeWard: (eid: number) => {
        // Already gone (shot down: forgotten then): its number may be someone else's by now
        if (!this.wards.delete(eid)) return;
        this.enemies.removeWard(eid);
        if (this.ships.has(eid)) this.ships.removeShip(eid);
      },
      shipAt: (eid: number) => (eid >= 0 && this.ships.has(eid) ? { x: Position.x[eid], y: Position.y[eid], hull: this.ships.integrity(eid) } : null),
      spawnRaid: (system: string, x: number, y: number, size: number, at: { x: number; y: number }) => {
        const num = this.gameData.getSystemNum(system);
        // Whoever lives where it happens: the zone it's in (the Drift's Scrapborn, the Lanes' pirates), else the system's own packs
        const sp = factions.spawns?.[system];
        const zone = (sp?.zones ?? []).find((z) => { const d = Math.hypot(at.x - (z.x ?? 0), at.y - (z.y ?? 0)); return d >= z.inner && d <= z.outer && z.groups.some((g) => !g.passive); });
        const groups = (zone?.groups ?? sp?.groups ?? []).filter((g) => !g.passive);
        const g = groups.length ? groups[Math.floor(Math.random() * groups.length)] : { faction: 'pirates', ships: ['pirate_skiff', 'pirate_skiff'] };
        const ships = Array.from({ length: Math.max(1, Math.min(7, size)) }, (_, i) => g.ships[i % g.ships.length]);
        const eids = this.enemies.spawnPack(num, { faction: g.faction, ships }, x, y);
        this.enemies.sendPack(eids, at, 9000);
        return eids;
      },
      sendRaid: (eids: number[], at: { x: number; y: number }) => this.enemies.sendPack(eids, at, 9000),
      hostileAlive: (eid: number) => this.enemies.isAlive(eid),
      removeHostile: (eid: number) => { if (this.ships.has(eid)) this.ships.removeShip(eid); },
      partyId: (conn: unknown) => this.party.partyId(conn as ClientConnection),
      danger: (system: string) => this.gameData.getSystem(system)?.danger ?? 1,
      spawnCargo: (conn: unknown, system: string, x: number, y: number, items: Bag) => {
        const num = this.gameData.getSystemNum(system);
        const key = this.pilots.keyOf(conn as ClientConnection);
        if (num < 0) return -1;
        const eid = this.pods.spawn(num, x, y, 0, 0, items, -1, 0, 60 * 60 * 10);
        if (eid >= 0 && key) this.pods.keep(eid, key, this.currentTick + 60 * 60 * 10);
        return eid;
      },
      podAlive: (eid: number) => !!this.pods.get(eid),
      holds: (conn: unknown, item: string) => countOf(this.pilots.get(conn as ClientConnection)?.cargo ?? [], item),
      takeCargo: (conn: unknown, items: Bag) => {
        const p = this.pilots.get(conn as ClientConnection);
        if (!p || !hasAll(p.cargo, items)) return false;
        removeAll(p.cargo, items);
        this.pilots.markDirty(conn as ClientConnection);
        this.pilots.sendItems(conn as ClientConnection);
        return true;
      },
      fitted: (conn: unknown, fn: string) => {
        const ship = this.ships.get((conn as ClientConnection).playerId);
        // (A model is the kind of part it grew from: a Constructor model is a constructor)
        return !!ship && ship.blueprint.parts.some((p, i) => (p.fn === fn || lookFn(p.fn) === fn) && ship.derived.alive[i] && !ship.ghost?.[i]);
      },
    };
  }

  /**
   * A design a client sent, parsed (throws if it isn't one). Sizes are checked
   * before any work's done on it: parts have unique uids 0..255, so a real design
   * never has more than 256; and the strings in it are kept to a sensible length
   * (they're saved and sent to everyone near).
   */
  private createEventHost() {
    const alivePlayers = (num: number) => {
      const out: number[] = [];
      for (const c of this.clients.values()) {
        const p = c.playerId;
        if (hasComponent(this.world, Player, p) && !hasComponent(this.world, Dead, p) && InSystem.systemId[p] === num) out.push(p);
      }
      return out;
    };
    const rng = mulberry32(0x0e7e);
    return {
      tick: () => this.currentTick,
      systemNum: (id: string) => (this.gameData.getSystem(id) ? this.gameData.getSystemNum(id) : -1),
      systemId: (num: number) => this.gameData.getSystemByNum(num)?.id,
      systemName: (num: number) => this.gameData.getSystemByNum(num)?.name ?? 'this system',
      players: alivePlayers,
      stations: (num: number) => {
        // (Stations are made with the world and never change: listed once per system)
        let list = this.namedStations.get(num);
        if (!list) {
          list = [...stationQuery(this.world)].filter((st) => InSystem.systemId[st] === num)
            .map((st) => { const d = this.gameData.getStationByNum(Station.stationId[st]); return { eid: st, name: d?.name ?? 'the station', id: d?.id }; });
          this.namedStations.set(num, list);
        }
        return list;
      },
      openSpace: (num: number, which?: number) => {
        const sys = this.gameData.getSystemByNum(num);
        const belt = sys?.asteroidBelt;
        if (!sys || !belt) return null;
        const stations = [...stationQuery(this.world)].filter((st) => InSystem.systemId[st] === num);
        const players = alivePlayers(num);
        for (let i = 0; i < 40; i++) {
          const seg = which && belt.extra?.[which - 1] ? belt.extra[which - 1] : beltSegment(belt, Math.floor(rng() * beltTotal(belt)));
          const a = rng() * Math.PI * 2, r = seg.innerRadius + rng() * (seg.outerRadius - seg.innerRadius);
          const x = Math.cos(a) * r, y = Math.sin(a) * r;
          if (stations.some((s) => Math.hypot(Position.x[s] - x, Position.y[s] - y) < 8000)) continue;
          if (players.some((p) => Math.hypot(Position.x[p] - x, Position.y[p] - y) < 2500)) continue;
          return { x, y };
        }
        return null;
      },
      danger: (num: number) => this.gameData.getSystemByNum(num)?.danger ?? 1,
      send: (num: number, msg: ServerMessage) => this.broadcastToSystem(num, msg),
      announce: (num: number, text: string, kind: 'info' | 'warn' | 'good' | 'bad') => {
        for (const c of this.clients.values()) if (InSystem.systemId[c.playerId] === num) this.pilots.toast(c, text, kind);
      },
      spawnPod: (num: number, x: number, y: number, vx: number, vy: number, items: Bag, life?: number) => { this.pods.spawn(num, x, y, vx, vy, items, -1, undefined, life ? life * 60 : undefined); },
      reward: (player: number, credits: number, xp: number, reputation: Record<string, number>, why: string) => {
        const pc = this.pilots.connOf(player);
        if (!pc) return;
        this.pilots.addCredits(pc, credits);
        this.pilots.addXp(pc, xp);
        this.pilots.grant(pc, { reputation });
        this.pilots.bumpStat(pc, why === 'raid' ? 'raidsDefended' : 'events');
        this.pilots.bumpStat(pc, `event:${why}`);
        this.send((pc as ClientConnection).ws, { type: 'gained', items: {}, xp, credits, x: Position.x[player], y: Position.y[player], source: 'event' });
      },
    };
  }

  private createMobHost() {
    return {
      world: this.world,
      tick: () => this.currentTick,
      targetOf: (owner: number) => this.enemies.targetOf(owner),
      nearestPlayer: (num: number, x: number, y: number, range: number) => {
        let best = -1, bd = range;
        for (const p of playerQuery(this.world)) {
          if (InSystem.systemId[p] !== num || hasComponent(this.world, Dead, p) || !this.ships.has(p)) continue;
          const d = Math.hypot(Position.x[p] - x, Position.y[p] - y);
          if (d < bd) { bd = d; best = p; }
        }
        return best;
      },
      radiusOf: (eid: number) => this.ships.get(eid)?.derived.radius ?? Radius.value[eid] ?? 40,
      hullGap: (eid: number, x: number, y: number, within: number) => (this.ships.has(eid) ? this.ships.hullDistance(eid, x, y, within) : Math.hypot(Position.x[eid] - x, Position.y[eid] - y) - (Radius.value[eid] ?? 40)),
      blast: (num: number, x: number, y: number, radius: number, damage: number, owner: number) => this.ships.splashAt(num, x, y, radius, damage, owner),
      burst: (num: number, x: number, y: number, radius: number, kind: string, fizzle: boolean) =>
        this.broadcastToSystem(num, { type: 'detonation', kind: fizzle ? 'mob_fizzle' : 'mob_burst', x: Math.round(x), y: Math.round(y), radius: Math.round(radius), mob: kind }),
      removed: (eid: number) => this.pendingRemovedEntities.add(eid),
      terrain: (num: number) => this.terrainOf(num),
    };
  }

  private createBossHost() {
    const effect = (num: number, x: number, y: number, kind: 'warning' | 'warpIn' | 'launch') => this.arrivalEffect(num, x, y, kind);
    const alivePlayers = (num: number) => {
      const out: number[] = [];
      for (const c of this.clients.values()) {
        const p = c.playerId;
        if (hasComponent(this.world, Player, p) && !hasComponent(this.world, Dead, p) && InSystem.systemId[p] === num && !this.admin.isHidden(p) && !this.dockedShips.has(p)) out.push(p);
      }
      return out;
    };
    return {
      effect,
      world: this.world,
      tick: () => this.currentTick,
      systemNum: (id: string) => (this.gameData.getSystem(id) ? this.gameData.getSystemNum(id) : -1),
      players: alivePlayers,
      terrain: (num: number) => this.terrainOf(num),
      send: (num: number, msg: ServerMessage) => this.broadcastToSystem(num, msg),
      announce: (num: number, text: string, kind: 'info' | 'warn' | 'good' | 'bad') => {
        for (const c of this.clients.values()) if (InSystem.systemId[c.playerId] === num) this.pilots.toast(c, text, kind);
      },
      // (Support credit: ships/features/support/Support.ts)
      supportersOf: (player: number) => this.support.supporters(player, this.currentTick),
      fire: (owner: number, kind: string, x: number, y: number, angle: number, scale: number, opts?: { target?: number; speed?: number; intercept?: boolean }) => {
        // (A boss's nova punches through as its own grade does; `intercept: false`, point defence can't touch it: support.ts)
        const ship = this.ships.get(owner);
        this.weapons.spawn(owner, kind, x, y, angle, scale, { speedScale: opts?.speed ?? 1, sizeScale: 1, turret: false, noBurst: true, target: opts?.target, grade: ship ? blueprintGrade(this.ships.catalog, ship.blueprint) : 1, intercept: opts?.intercept });
      },
      warpFx: (num: number, x: number, y: number, out: boolean) => {
        this.broadcastToSystem(num, { type: 'effect', effectType: out ? EffectType.WarpOut : EffectType.WarpIn, x, y });
      },
      reward: (player: number, boss: string, def: { name: string; faction: string; system: string }, xp: number, credits: number, loot: Bag) => {
        const pc = this.pilots.connOf(player);
        if (!pc) return;
        // This week's hunted boss pays double
        if (this.hunted()?.id === boss) { xp *= 2; credits *= 2; }
        this.pilots.addXp(pc, xp);
        this.pilots.addCredits(pc, credits);
        this.pilots.bumpStat(pc, 'bosses');
        this.pilots.bumpStat(pc, `boss:${boss}`);
        this.send((pc as ClientConnection).ws, { type: 'gained', items: {}, xp, credits, x: Position.x[player], y: Position.y[player], source: `kill:${def.name}` });
        if (Object.keys(loot).length) {
          this.pilots.give(pc, loot, { toStorage: true, source: 'boss' });
          this.pilots.toast(pc, `${def.name}'s spoils are waiting in your station storage`, 'good');
        }
        this.quests.onKill(pc, boss, def.faction, def.system);
        this.pilots.saveNow(pc);
      },
      killedBefore: (player: number, boss: string) => {
        const pc = this.pilots.connOf(player);
        return !!pc && (this.pilots.get(pc)?.stats[`boss:${boss}`] ?? 0) > 0;
      },
      holds: (player: number, item: string) => {
        const pc = this.pilots.connOf(player);
        const p = pc && this.pilots.get(pc);
        return !!p && countOf(p.storage, item) + countOf(p.cargo, item) > 0;
      },
      isArtefact: (item: string) => this.econ.items.get(item)?.category === 'artefact',
      defeated: (boss: string, def: { name: string }, players: number[]) => {
        const names = players.map((p) => this.pilots.connOf(p)?.username).filter((n): n is string => !!n);
        const who = names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0] ?? 'someone';
        this.achievements.post(`${def.name} has fallen to ${who}${this.hunted()?.id === boss ? ' (the hunted boss!)' : ''}`, 'boss');
      },
    };
  }

  /** Ore refined: the rare traces it carried come out (econ/traces.ts) */
  private releaseTraces(conn: PilotConn, used: Bag): void {
    const p = this.pilots.get(conn);
    if (!p?.traces) return;
    const got = releaseTraces(p.traces, this.gameData.miningTable.traces, used, stationPerks(p.outpost).traceMul);
    if (!Object.keys(p.traces).length) delete p.traces;
    this.pilots.markDirty(conn);
    if (!Object.keys(got).length) return;
    this.pilots.give(conn, got, { toStorage: true, source: 'crafted', quiet: true });
    this.pilots.toast(conn, `Found in the ore: ${Object.entries(got).map(([id, n]) => `${n} × ${this.econ.items.name(id)}`).join(', ')}`, 'good');
  }

  private createMiningHost(): MiningHost {
    return {
      spawnChunk: (num, x, y, vx, vy, items, miner) => { this.pods.spawnChunk(num, x, y, vx, vy, items, miner); },
      minerAt: (eid) => (hasComponent(this.world, Position, eid) ? { x: Position.x[eid], y: Position.y[eid] } : null),
      miningSkill: (eid) => {
        const pc = this.pilots.connOf(eid);
        // Flying in a wing adds its yield bonus on top of the skill's
        return pc ? skillValue('mining', this.pilots.skills(pc).mining ?? 0) + (this.party.wingBonus(pc) - 1) : 0;
      },
      awardXp: (eid, xp) => { const pc = this.pilots.connOf(eid); if (pc) this.pilots.addXp(pc, xp); },
      traceTier: (num, type) => {
        const c = this.gameData.miningTable.comet;
        return c && type === 'comet' && this.cometNow() && c.systems.includes(this.gameData.getSystemByNum(num)?.id ?? '') ? c.traceTier : 0;
      },
      mined: (eid, ores, from) => {
        const pc = this.pilots.connOf(eid), p = pc && this.pilots.get(pc);
        if (!p) return;
        const ledger = p.traces ?? {};
        for (const [ore, n] of Object.entries(ores)) accrueTraces(ledger, this.gameData.miningTable.traces, ore, n, from);
        if (Object.keys(ledger).length) { p.traces = ledger; this.pilots.markDirty(pc); }
      },
      notify: (eid, text) => { const pc = this.pilots.connOf(eid); if (pc) this.pilots.toast(pc, text, 'warn'); },
      respawn: (num, index) => this.respawnAsteroid(num, index),
      shed: (eid, stage, size, left) => this.shedAsteroid(eid, stage, size, left),
      rockTier: (num) => ((this.gameData.factionsFile as { spawns?: Record<string, { grade?: number }> }).spawns?.[this.gameData.getSystemByNum(num)?.id ?? ""]?.grade) || 1,
      crumble: (eid) => {
        if (hasComponent(this.world, Dead, eid)) return;
        addComponent(this.world, Dead, eid);
        this.pendingRemovedEntities.add(eid);
        this.placeAsteroid(eid);
        this.broadcastToSystem(InSystem.systemId[eid], { type: 'effect', effectType: EffectType.AsteroidBreak, x: Math.round(Position.x[eid]), y: Math.round(Position.y[eid]), data: [Asteroid.size[eid], 30] });
        this.mining.onBroken(eid, Position.x[eid], Position.y[eid]);
        this.forgetAsteroid(eid);
      },
      tick: () => this.currentTick,
    };
  }

  /**
   * A mining beam: the first asteroid along it takes `damage` and is mined with
   * the laser's yield. Returns how far along the beam it hit (1 = nothing).
   */
  private mineBeam(eid: number, x: number, y: number, angle: number, range: number, damage: number, material: string, gas = false, full = range): number {
    const x1 = x + Math.cos(angle) * range, y1 = y + Math.sin(angle) * range;
    const systemNum = InSystem.systemId[eid];
    let best = 1, hit = -1;
    for (const a of this.asteroidOrbits.query(systemNum, x, y, x1, y1, 120, this.currentTick)) {
      if (hasComponent(this.world, Dead, a) || InSystem.systemId[a] !== systemNum) continue;
      // A siphon draws only from gas pockets; a mining laser passes through them
      if (this.isGas(a) !== gas) continue;
      this.placeAsteroid(a);
      if (!segmentNearCircle(x, y, x1, y1, Position.x[a], Position.y[a], Asteroid.size[a])) continue;
      const poly = getAsteroidPolygon(a, Position.x[a], Position.y[a], Asteroid.size[a], asteroidSpin(a, this.currentTick));
      for (let i = 0; i < poly.length; i++) {
        const p1 = poly[i], p2 = poly[(i + 1) % poly.length];
        const t = segmentIntersectT(x, y, x1, y1, p1.x, p1.y, p2.x, p2.y);
        if (t !== null && t < best) { best = t; hit = a; }
      }
    }
    if (hit < 0) return 1;
    const tbl = this.gameData.miningTable;
    const hx = x + (x1 - x) * best, hy = y + (y1 - y) * best;
    damage *= mineFalloff(best * range, full);
    if (damage <= 0) return best;
    Asteroid.hp[hit] -= damage;
    const nl = Math.hypot(hx - Position.x[hit], hy - Position.y[hit]) || 1;
    const siphon = (tbl.tools as unknown as Record<string, { yield: number; hardness: number }>).siphon;
    this.mining.extract(hit, eid, damage, gas && siphon ? siphon : { yield: tbl.tools.miner.yield, hardness: tbl.tools.minerByMaterial[material] ?? tbl.tools.miner.hardness, grade: gradeOf(this.ships.catalog.materials.get(material)) },
      hx, hy, (hx - Position.x[hit]) / nl, (hy - Position.y[hit]) / nl);
    if (Asteroid.hp[hit] <= 0 && !hasComponent(this.world, Dead, hit)) {
      addComponent(this.world, Dead, hit);
      this.pendingRemovedEntities.add(hit);
      this.broadcastToSystem(systemNum, { type: 'effect', effectType: EffectType.AsteroidBreak, x: Math.round(Position.x[hit]), y: Math.round(Position.y[hit]), data: [Asteroid.size[hit], 30] });
      this.mining.onBroken(hit, Position.x[hit], Position.y[hit]);
      this.forgetAsteroid(hit);
    }
    return best;
  }

  /** An arrival's effect: a gate spooling up (a slow amber ring), a ship coming through (warp-in), or launching from a hull */
  private arrivalEffect(num: number, x: number, y: number, kind: 'warning' | 'warpIn' | 'launch'): void {
    this.broadcastToSystem(num, { type: 'effect', effectType: kind === 'launch' ? EffectType.WarpOut : EffectType.WarpIn, x: Math.round(x), y: Math.round(y), data: [kind === 'warning' ? 2 : 0] });
  }

  /** The jump point at a pilot's station site (where they come out if they were inside when it was unloaded) */
  private siteExit(conn: ClientConnection): { num: number; x: number; y: number } | null {
    const site = stationPerksSite(this.pilots.get(conn)?.outpost?.site);
    const sys = site ? this.gameData.getStation(site.station)?.system : undefined;
    if (!sys) return null;
    const num = this.gameData.getSystemNum(sys);
    for (const g of portalQuery(this.world)) {
      if (InSystem.systemId[g] === num && this.gameData.getSystemByNum(Portal.targetSystem[g])?.private) return { num, x: Position.x[g], y: Position.y[g] };
    }
    return null;
  }

  /** A gas pocket (shots and beams pass through; only a siphon draws from it) */
  private isGas(asteroid: number): boolean {
    const c = this.mining.get(asteroid);
    return !!(c && this.gameData.miningTable.types[c.type]?.gas);
  }

  /** The comet passing: (now) and where; while it does, comet rocks there carry their traces richly */
  private cometNow(): boolean {
    const c = this.gameData.miningTable.comet;
    if (!c) return false;
    return this.clock() % (c.days * 86_400_000) < c.hours * 3_600_000;
  }
  private cometWas = false;
  private watchComet(): void {
    if (this.currentTick % 600) return;
    const now = this.cometNow();
    if (now === this.cometWas) return;
    this.cometWas = now;
    const c = this.gameData.miningTable.comet!;
    const where = c.systems.map((s) => this.gameData.getSystem(s)?.name ?? s).join(' and ');
    const text = now ? `The comet is passing ${where}: its rocks run with pale iridium while it lasts (${c.hours} hours)` : 'The comet has passed on';
    for (const conn of this.clients.values()) this.pilots.toast(conn, text, now ? 'good' : 'info');
  }

  /** A weapon beam (laser, lance) on asteroids: it burns the first one and mines it a little */
  private beamAsteroid(eid: number, x: number, y: number, angle: number, range: number, damage: number, kind: string): number {
    const tools = this.gameData.miningTable.tools as unknown as Record<string, { yield: number; hardness: number }>;
    const tool = tools[kind] ?? { yield: 0.05, hardness: 1 };
    const x1 = x + Math.cos(angle) * range, y1 = y + Math.sin(angle) * range;
    const systemNum = InSystem.systemId[eid];
    let best = 1, hit = -1;
    for (const a of this.asteroidOrbits.query(systemNum, x, y, x1, y1, 120, this.currentTick)) {
      if (hasComponent(this.world, Dead, a) || InSystem.systemId[a] !== systemNum || this.isGas(a)) continue;
      this.placeAsteroid(a);
      if (!segmentNearCircle(x, y, x1, y1, Position.x[a], Position.y[a], Asteroid.size[a])) continue;
      const poly = getAsteroidPolygon(a, Position.x[a], Position.y[a], Asteroid.size[a], asteroidSpin(a, this.currentTick));
      for (let i = 0; i < poly.length; i++) {
        const p1 = poly[i], p2 = poly[(i + 1) % poly.length];
        const t = segmentIntersectT(x, y, x1, y1, p1.x, p1.y, p2.x, p2.y);
        if (t !== null && t < best) { best = t; hit = a; }
      }
    }
    if (hit < 0) return 1;
    const hx = x + (x1 - x) * best, hy = y + (y1 - y) * best;
    Asteroid.hp[hit] -= damage;
    const nl = Math.hypot(hx - Position.x[hit], hy - Position.y[hit]) || 1;
    this.mining.extract(hit, eid, damage, tool, hx, hy, (hx - Position.x[hit]) / nl, (hy - Position.y[hit]) / nl);
    if (Asteroid.hp[hit] <= 0 && !hasComponent(this.world, Dead, hit)) {
      addComponent(this.world, Dead, hit);
      this.pendingRemovedEntities.add(hit);
      this.broadcastToSystem(systemNum, { type: 'effect', effectType: EffectType.AsteroidBreak, x: Math.round(Position.x[hit]), y: Math.round(Position.y[hit]), data: [Asteroid.size[hit], 30] });
      this.mining.onBroken(hit, Position.x[hit], Position.y[hit]);
      this.forgetAsteroid(hit);
    }
    return best;
  }

  private createEnemyHost() {
    return {
      world: this.world,
      tick: () => this.currentTick,
      players: (num: number) => {
        const out: number[] = [];
        for (const c of this.clients.values()) {
          const p = c.playerId;
          if (hasComponent(this.world, Player, p) && !hasComponent(this.world, Dead, p) && InSystem.systemId[p] === num && !this.admin.isHidden(p) && !this.dockedShips.has(p)) out.push(p);
        }
        return out;
      },
      stations: (num: number) => [...stationQuery(this.world)].filter((st) => InSystem.systemId[st] === num),
      effect: (num: number, x: number, y: number, kind: 'warning' | 'warpIn' | 'launch') => this.arrivalEffect(num, x, y, kind),
      gates: (num: number) => [...portalQuery(this.world)].filter((g) => InSystem.systemId[g] === num && Portal.kind[g] === 0).map((g) => ({ x: Position.x[g], y: Position.y[g] })),
      safeAt: (num: number, x: number, y: number) => inSafeSpace(this.gameData.getSystemByNum(num), x, y),
      systemNum: (id: string) => (this.gameData.getSystem(id) ? this.gameData.getSystemNum(id) : -1),
      systemId: (num: number) => this.gameData.getSystemByNum(num)?.id,
      systemRadius: (num: number) => {
        const s = this.gameData.getSystemByNum(num);
        return Math.max(20000, (s?.asteroidBelt?.outerRadius ?? 30000) * 1.1);
      },
      unsafe: (num: number, x: number, y: number) => {
        const sys = this.gameData.getSystemByNum(num);
        const cb = sys?.centralBody;
        const body = Math.max(cb?.gravity?.horizon ?? 0, cb?.radius ?? sys?.starRadius ?? 0);
        return body > 0 && Math.hypot(x, y) < body + 5000;
      },
      reward: (killer: number, xp: number, credits: number, assist: boolean, label: string) => {
        const pc = this.pilots.connOf(killer);
        if (!pc) return;
        if (xp > 0) this.pilots.addXp(pc, xp);
        if (credits > 0) this.pilots.addCredits(pc, credits);
        this.pilots.bumpStat(pc, assist ? 'assists' : 'kills');
        this.send((pc as ClientConnection).ws, { type: 'gained', items: {}, xp, credits, x: Position.x[killer], y: Position.y[killer], source: assist ? `assist:${label}` : `kill:${label}` });
      },
      dropLoot: (num: number, x: number, y: number, vx: number, vy: number, items: Bag) => { this.pods.spawn(num, x, y, vx, vy, items); },
      questKill: (player: number, type: string, faction: string) => {
        const pc = this.pilots.connOf(player);
        if (!pc) return;
        this.pilots.bumpStat(pc, `kills:${faction}`);
        this.quests.onKill(pc, type, faction, this.gameData.getSystemByNum(InSystem.systemId[player])?.id);
      },
      stationDefence: (st: number) => this.gameData.getStationByNum(Station.stationId[st])?.defence,
      stationBeam: (num: number, station: number, target: number, turret: number) => this.broadcastToSystem(num, { type: 'stationFire', station, target, turret }),
      sheltered: (p: number) => this.dockedShips.has(p) || (hasComponent(this.world, Player, p) && this.stationInRange(p) >= 0),
      partyOf: (player: number) => {
        const pc = this.pilots.connOf(player);
        return pc ? this.party.members(pc).filter((m) => m !== pc).map((m) => m.playerId) : [];
      },
      // (Support credit: ships/features/support/Support.ts)
      supportersOf: (player: number) => this.support.supporters(player, this.currentTick),
    };
  }

  /**
   * May `healer`'s Repair Beam mend `target` (common/src/ships/features/support/support.ts)? Friendly ships only: pilots and what they
   * defend (wards), never itself, nobody docked or a person's craft; two pilots both in a PvP zone only when they're in
   * one party. Hostiles mend nothing (no enemy carries one yet).
   */
  canHeal(healer: number, target: number): boolean {
    if (healer === target) return false;
    if (this.dockedShips.has(healer) || this.dockedShips.has(target) || this.personCraft.has(healer) || this.personCraft.has(target)) return false;
    const aPlayer = hasComponent(this.world, Player, healer), tPlayer = hasComponent(this.world, Player, target);
    if (!(aPlayer || this.wards.has(healer)) || !(tPlayer || this.wards.has(target))) return false;
    if (aPlayer && tPlayer && this.inPvpZone(healer) && this.inPvpZone(target)) {
      const a = this.pilots.connOf(healer), b = this.pilots.connOf(target);
      const pa = a ? this.party.partyId(a) : 0;
      return pa !== 0 && b !== undefined && this.party.partyId(b) === pa;
    }
    return true;
  }

  /** What the admin tools reach into (AdminTools.ts) */
  private createAdminHost(): AdminHost {
    const C = (c: AdminConn) => c as ClientConnection;
    const sysNum = (id: string) => (this.gameData.getSystem(id) ? this.gameData.getSystemNum(id) : -1);
    const factions = () => this.gameData.factionsFile as FactionsFile;
    const alive = (eid: number) => entityExists(this.world, eid) && hasComponent(this.world, Player, eid) && !hasComponent(this.world, Dead, eid);
    const hostilesIn = (num: number) => [...this.ships.bodies.keys()].filter((eid) => this.enemies.factionOf(eid) && InSystem.systemId[eid] === num);
    return {
      conns: () => [...this.clients.values()].filter((c) => c.username),
      where: (c) => {
        const eid = c.playerId;
        if (!entityExists(this.world, eid) || !hasComponent(this.world, Player, eid)) return null;
        return { system: this.gameData.getSystemByNum(InSystem.systemId[eid])?.id ?? '?', x: Position.x[eid], y: Position.y[eid], dead: !alive(eid) };
      },
      systems: () => this.gameData.getAllSystems().map((s) => ({ id: s.id, name: s.name })),
      stations: () => [...stationQuery(this.world)].map((st) => {
        const d = this.gameData.getStationByNum(Station.stationId[st]);
        return { id: d?.id ?? String(st), name: d?.name ?? 'Station', system: this.gameData.getSystemByNum(InSystem.systemId[st])?.id ?? '?', x: Math.round(Position.x[st]), y: Math.round(Position.y[st]) };
      }),
      factions: () => Object.fromEntries(Object.entries(factions().factions).map(([id, f]) => [id, Object.keys(f.ships)])),
      bosses: () => Object.keys((this.gameData.bossesFile as BossesFile).bosses ?? {}),
      items: () => this.econ.items.all().map((d) => ({ id: d.id, name: d.name })),
      itemName: (id) => (this.econ.items.has(id) ? this.econ.items.name(id) : null),
      travel: (c, system, x, y) => {
        const num = sysNum(system);
        if (num < 0 || !alive(c.playerId) || !Number.isFinite(x) || !Number.isFinite(y)) return false;
        C(c).docked = null;
        this.travelTo(C(c), num, x, y, false);
        return true;
      },
      heal: (c) => { if (alive(c.playerId)) this.ships.repair(c.playerId); },
      destroy: (c) => {
        const ship = this.ships.get(c.playerId);
        const core = ship?.blueprint.parts.findIndex((p) => p.fn === 'core') ?? -1;
        if (ship && core >= 0) this.ships.damagePartFraction(c.playerId, core, 1);
      },
      addCredits: (c, n) => this.pilots.addCredits(C(c), n),
      addXp: (c, n) => this.pilots.addXp(C(c), n),
      give: (c, items) => {
        // (what won't fit in the hold goes to station storage, not lost)
        const left = this.pilots.give(C(c), items, { source: 'admin' });
        if (Object.keys(left).length) this.pilots.give(C(c), left, { source: 'admin', toStorage: true });
        return Object.values(left).reduce((a, k) => a + k, 0);
      },
      skillPoints: (c, n) => this.pilots.grant(C(c), { skillPoints: n }),
      codex: (c, what) => this.codex.admin(C(c), what),
      kick: (c, reason) => this.rejectAuth(C(c), reason),
      spawnPack: (system, x, y, faction, ships, count) => {
        const num = sysNum(system);
        if (num < 0) return 0;
        const f = factions();
        let group: { faction: string; ships: string[] };
        if (faction && f.factions[faction]) group = { faction, ships: ships?.length ? ships : Object.keys(f.factions[faction].ships) };
        else if (ships?.length) group = { faction: Object.keys(f.factions).find((k) => ships.some((t) => t in f.factions[k].ships)) ?? 'pirates', ships };
        else {
          const groups = (f.spawns?.[system]?.groups ?? []).filter((g) => !g.passive);
          group = groups.length ? groups[Math.floor(Math.random() * groups.length)] : { faction: 'pirates', ships: ['pirate_skiff', 'pirate_raider'] };
        }
        const valid = group.ships.filter((t) => this.ships.enemyDesigns[t]);
        if (!valid.length) return 0;
        const list = count ? Array.from({ length: Math.min(20, count) }, (_, i) => valid[i % valid.length]) : valid;
        return this.enemies.spawnPack(num, { faction: group.faction, ships: list }, x, y).length;
      },
      spawnBoss: (id) => this.bosses.spawn(id) >= 0,
      clearHostiles: (system, explode, at) => {
        let n = 0;
        for (const eid of hostilesIn(sysNum(system))) {
          if (at && Math.hypot(Position.x[eid] - at.x, Position.y[eid] - at.y) > at.radius) continue;
          const ship = this.ships.get(eid);
          const core = ship?.blueprint.parts.findIndex((p) => p.fn === 'core') ?? -1;
          if (explode && ship && core >= 0) this.ships.damagePartFraction(eid, core, 1);
          else this.ships.removeShip(eid);
          n++;
        }
        return n;
      },
      clearPods: (system) => this.pods.clear(sysNum(system)),
      startEvent: (system, kind) => {
        const num = sysNum(system);
        if (kind === 'siege') return num >= 0 && this.surfaces.startSiege(num);
        return num >= 0 && !!(kind === 'raid' ? this.events.startRaid(num) : kind === 'peak' ? this.events.startPeak(num) : this.events.startSalvage(num));
      },
      announce: (text) => { for (const c of this.clients.values()) this.send(c.ws, { type: 'systemMessage', text: `📢 ${text}`, color: '#fbbf24' }); },
      reply: (c, msg) => this.send(C(c).ws, msg as any),
      setContributor: (name, online, on, by) => this.contrib.setRank(name, online ? C(online) : null, on, by.username),
      contributors: () => this.contrib.contributors().map((r) => r.username),
      accounts: this.userDB.admin ?? null,
      freeBuildAllowed: () => this.freeBuildAllowed,
      freeBuildChanged: (c) => this.hangar.send(C(c)),
      setAdminLive: (c, on) => {
        C(c).isAdmin = on;
        // Their client opens (or puts away) the admin and contributor tools as it does on signing in
        this.send(C(c).ws, { type: 'authResult', success: true, username: c.username, isAdmin: on, isContributor: this.contrib.allowed(C(c)) });
      },
    };
  }

  /** What planet surfaces reach into (Surfaces.ts) */
  private createSurfaceHost(): SurfaceHost {
    const factions = () => this.gameData.factionsFile as FactionsFile;
    return {
      tick: () => this.currentTick,
      systems: () => this.gameData.getAllSystems(),
      systemNum: (id) => (this.gameData.getSystem(id) ? this.gameData.getSystemNum(id) : -1),
      instances: (id) => this.gameData.getSystemInstances(id),
      pilots: (num) => {
        const out: { conn: ClientConnection; eid: number; x: number; y: number }[] = [];
        for (const c of this.clients.values()) {
          const p = c.playerId;
          if (!entityExists(this.world, p) || !hasComponent(this.world, Player, p) || hasComponent(this.world, Dead, p) || InSystem.systemId[p] !== num) continue;
          out.push({ conn: c, eid: p, x: Position.x[p], y: Position.y[p] });
        }
        return out;
      },
      travel: (conn, num, x, y) => { (conn as ClientConnection).docked = null; this.travelTo(conn as ClientConnection, num, x, y, false); },
      toast: (conn, text, kind) => this.pilots.toast(conn, text, kind),
      spawnStructure: (design, num, x, y, name, grade) => {
        const bp = grade ? this.enemies.design(design, grade) : this.ships.enemyDesigns[design];
        if (!bp) return -1;
        const eid = this.ships.spawnDummy(bp, x, y, 0, num);
        this.ships.scaleHp(eid, 3);
        // Built into the ground: rams don't shove it
        this.ships.pin(eid);
        this.wards.set(eid, name);
        this.enemies.addWard(eid);
        return eid;
      },
      removeStructure: (eid) => {
        if (!this.wards.delete(eid)) return;
        this.ships.setDamageScale(eid, 1);
        this.enemies.removeWard(eid);
        if (this.ships.has(eid)) this.ships.removeShip(eid);
      },
      shipAt: (eid) => (eid >= 0 && this.ships.has(eid) ? { x: Position.x[eid], y: Position.y[eid], hull: this.ships.integrity(eid) } : null),
      repairStructure: (eid) => this.ships.repair(eid),
      spawnRaid: (num, faction, x, y, size, at) => {
        const kinds = Object.keys(factions().factions[faction]?.ships ?? {}).filter((t) => this.ships.enemyDesigns[t]);
        if (!kinds.length) return [];
        // Mostly the small ones, a heavier one now and then
        const ships = Array.from({ length: size }, (_, i) => kinds[i % 4 === 3 ? Math.min(kinds.length - 1, 2) : Math.min(kinds.length - 1, i % 2)]);
        const eids = this.enemies.spawnPack(num, { faction, ships }, x, y);
        this.enemies.sendPack(eids, at, 40000);
        return eids;
      },
      sendRaid: (eids, at) => this.enemies.sendPack(eids, at, 40000),
      hostileAlive: (eid) => this.enemies.isAlive(eid),
      removeHostile: (eid) => { if (this.ships.has(eid)) this.ships.removeShip(eid); },
      reward: (conn, xp, credits, label) => {
        const c = conn as ClientConnection;
        this.pilots.addXp(c, xp);
        this.pilots.addCredits(c, credits);
        this.send(c.ws, { type: 'gained', items: {}, xp, credits, x: Position.x[c.playerId], y: Position.y[c.playerId], source: label });
      },
      send: (num, msg) => this.broadcastToSystem(num, msg),
      announce: (num, text, kind) => {
        const color = { info: '#7dd3fc', warn: '#fbbf24', good: '#86efac', bad: '#f87171' }[kind];
        // Every pilot there gets the toast; only the outcomes (won, lost) are also kept in the chat log
        // (raid starts, siege waves and boss sightings were the spam, and the toast already shows them)
        if (kind === 'good' || kind === 'bad') this.broadcastToSystem(num, { type: 'systemMessage', text, color });
        for (const c of this.clients.values()) if (InSystem.systemId[c.playerId] === num) this.pilots.toast(c, text, kind);
      },
    };
  }

  /** What moon sieges reach into (Sieges.ts) */
  /** Where a pilot is flying: their system's id (a surface's own) and position, or null */
  private whereIs(conn: ClientConnection): { system: string; x: number; y: number } | null {
    const eid = conn.playerId;
    if (!entityExists(this.world, eid) || !hasComponent(this.world, Player, eid) || hasComponent(this.world, Dead, eid)) return null;
    const sys = this.gameData.getSystemByNum(InSystem.systemId[eid]);
    return sys ? { system: sys.id, x: Position.x[eid], y: Position.y[eid] } : null;
  }

  /** What the station a ship is repairing at charges per HP (the cheapest in range) */
  private repairRate(eid: number): number {
    const range = this.ships.tuning.repair?.range ?? 0;
    let rate = Infinity;
    for (const st of stationQuery(this.world)) {
      if (InSystem.systemId[st] !== InSystem.systemId[eid]) continue;
      if (Math.hypot(Position.x[st] - Position.x[eid], Position.y[st] - Position.y[eid]) >= Radius.value[st] + range) continue;
      rate = Math.min(rate, this.gameData.getStationByNum(Station.stationId[st])?.repairCostPerHp ?? 0);
    }
    return rate === Infinity ? 0 : rate * this.hazards.repairScale(eid);
  }

  private createPeopleHost(): PeopleHost {
    const quests = this.createQuestHost();
    return {
      send: (conn, msg) => this.send((conn as ClientConnection).ws, msg),
      where: (conn) => this.whereIs(conn as ClientConnection),
      stationAt: (conn) => quests.stationAt(conn),
      stationName: (id) => this.gameData.getStation(id)?.name ?? id,
      stationSystem: (id) => this.gameData.getStation(id)?.system,
      itemName: (id) => this.econ.items.name(id),
      random: Math.random,
    };
  }

  private createArenaHost(): ArenaHost {
    const surfaceHost = this.createSurfaceHost();
    return {
      tick: () => this.currentTick,
      systems: () => this.gameData.getAllSystems(),
      instances: (id) => this.gameData.getSystemInstances(id),
      partyId: (conn) => this.party.partyId(conn as ClientConnection),
      pilots: surfaceHost.pilots,
      travel: surfaceHost.travel,
      toOrbit: (conn, surface, angle) => this.surfaces.toOrbit(conn, surface, angle),
      toast: (conn, text, kind) => this.pilots.toast(conn, text, kind),
      spawnBoss: (boss, num, x, y) => this.bosses.spawnAt(boss, num, x, y),
      bossAlive: (eid) => this.ships.has(eid),
      removeBoss: (eid) => this.bosses.remove(eid),
    };
  }

  private createSiegeHost(): SiegeHost {
    const factions = () => this.gameData.factionsFile as FactionsFile;
    const surfaceHost = this.createSurfaceHost();
    const still = (a: number) => ({ forward: false, backward: false, left: false, right: false, boost: false, targetAngle: a });
    return {
      tick: () => this.currentTick,
      instances: (id) => this.gameData.getSystemInstances(id),
      partyId: (conn) => this.party.partyId(conn as ClientConnection),
      name: (conn) => (conn as ClientConnection).username,
      pilots: surfaceHost.pilots,
      toOrbit: (conn, surface, angle) => this.surfaces.toOrbit(conn, surface, angle),
      toast: (conn, text, kind) => this.pilots.toast(conn, text, kind),
      send: (conn, msg) => this.send((conn as ClientConnection).ws, msg),
      spawnStructure: surfaceHost.spawnStructure,
      removeStructure: surfaceHost.removeStructure,
      shipAt: surfaceHost.shipAt,
      healStructure: (eid, fraction) => this.ships.healAll(eid, fraction),
      refit: (eid) => this.ships.repair(eid),
      arm: (eid, { range, shot, damage }) => {
        this.ships.setDamageScale(eid, damage);
        // Aims at the nearest hostile in range (where it will be when the shells get there) and fires, turning to face it
        this.ships.setController(eid, () => {
          const x = Position.x[eid], y = Position.y[eid];
          const t = this.ships.nearestTarget(eid, x, y, range, (o) => !!this.enemies.factionOf(o));
          if (t < 0) return { controls: still(Rotation.angle[eid]), firing: false };
          const d = Math.hypot(Position.x[t] - x, Position.y[t] - y), lead = shot > 0 ? d / shot : 0;
          const tx = Position.x[t] + Velocity.x[t] * lead, ty = Position.y[t] + Velocity.y[t] * lead;
          const a = Math.atan2(ty - y, tx - x);
          return { controls: still(a), firing: true, aim: a, aimDist: Math.hypot(tx - x, ty - y), target: t };
        });
      },
      rateShips: (ships, grade) => {
        let fp = 0, tough = 0;
        for (const s of ships) {
          const bp = this.enemies.design(s, grade);
          if (!bp) continue;
          const faction = Object.values(factions().factions).find((f) => s in f.ships);
          const r = rateShip(this.ships.catalog, this.ships.tuning, createShipState(this.ships.catalog, this.ships.tuning, 0, bp, 0), faction?.hpScale ?? 1);
          fp += r.firepower; tough += r.toughness;
        }
        return ratingOf(fp, tough);
      },
      gradeReward: (grade) => gradeReward(this.ships.catalog, grade),
      spawnHostiles: (num, ships, x, y, at, grade) => {
        // Packs by faction, eight at most (a big pack would spread out over half the moon), all sent at the bastion
        const byFaction = new Map<string, typeof ships>();
        for (const s of ships) {
          const f = s.faction ?? Object.keys(factions().factions).find((k) => s.ship in factions().factions[k].ships) ?? 'pirates';
          const key = `${f}|${s.plating ?? 0}`;
          byFaction.set(key, [...(byFaction.get(key) ?? []), s]);
        }
        const packs: [string, typeof ships][] = [];
        for (const [key, list] of byFaction) for (let k = 0; k < list.length; k += 8) packs.push([key, list.slice(k, k + 8)]);
        const out: number[] = [];
        packs.forEach(([key, list], i) => {
          const faction = key.split('|')[0];
          const a = (i / packs.length) * Math.PI * 2, r = packs.length > 1 ? 500 + packs.length * 60 : 0;
          const eids = this.enemies.spawnPack(num, { faction, ships: list.map((s) => s.ship), grade, plating: list[0]?.plating }, x + Math.cos(a) * r, y + Math.sin(a) * r);
          this.enemies.sendPack(eids, at, 40000);
          eids.forEach((eid, k) => {
            const s = list[k];
            if (!s) return;
            if (s.hp !== 1) this.ships.scaleHp(eid, s.hp);
            if (s.damage !== undefined) this.ships.setDamageScale(eid, s.damage);
            if (s.range !== undefined || s.aggro !== undefined) this.enemies.tune(eid, { ...(s.range !== undefined ? { range: s.range } : {}), ...(s.aggro !== undefined ? { aggro: s.aggro } : {}) });
          });
          out.push(...eids);
        });
        return out;
      },
      shipName: (design) => this.enemies.displayName(design),
      effect: (num, x, y, kind) => this.arrivalEffect(num, x, y, kind),
      pin: (eid) => this.ships.pin(eid),
      hostileAlive: (eid) => this.enemies.isAlive(eid),
      removeHostile: (eid) => { if (this.ships.has(eid)) this.ships.removeShip(eid); },
      reward: surfaceHost.reward,
    };
  }

  private createPodHost(): PodHost {
    return {
      world: this.world,
      tick: () => this.currentTick,
      keyOf: (eid) => {
        const pc = this.pilots.connOf(eid);
        return pc ? this.pilots.keyOf(pc) : undefined;
      },
      emptied: (_eid, key) => this.pilots.wreckRecovered(key),
      remove: (eid) => {
        addComponent(this.world, Dead, eid);
        this.pendingRemovedEntities.add(eid);
      },
      collectors: (num) => {
        const out: number[] = [];
        for (const c of this.clients.values()) if (InSystem.systemId[c.playerId] === num) out.push(c.playerId);
        for (const l of this.lingering.keys()) if (InSystem.systemId[l] === num) out.push(l);
        return out;
      },
      give: (eid, items, at, source) => {
        const pc = this.lingering.get(eid)?.conn ?? this.pilots.connOf(eid);
        if (!pc) return items;
        const left = this.pilots.give(pc, items, { source, at });
        this.broadcastToSystem(InSystem.systemId[eid], { type: 'effect', effectType: EffectType.PickupItem, x: Math.round(at.x), y: Math.round(at.y), targetX: Math.round(Position.x[eid]), targetY: Math.round(Position.y[eid]), entityId: eid });
        return left;
      },
      cargoFree: (eid) => {
        const pc = this.lingering.get(eid)?.conn ?? this.pilots.connOf(eid);
        return pc ? this.pilots.cargoFree(pc) : 0;
      },
      shipRadius: (eid) => this.ships.get(eid)?.derived.radius ?? 40,
    };
  }

  /** Put a player somewhere without travel effects (logging in, respawning) */
  placePlayer(conn: ClientConnection, systemNum: number, x: number, y: number): void {
    const eid = conn.playerId;
    if (!this.gameData.getSystemByNum(systemNum)) return;
    const from = InSystem.systemId[eid];
    InSystem.systemId[eid] = systemNum;
    Position.x[eid] = x;
    Position.y[eid] = y;
    Velocity.x[eid] = 0;
    Velocity.y[eid] = 0;
    if (from !== systemNum) {
      conn.knownEntities.clear();
      this.lastEntityStates.delete(eid);
      conn.lastSystemId = -1;
    }
    conn.forceSnapshot = true;
    this.sendPlayerState(conn);
  }

  /**
   * Logged in: one account flies in one place at a time. Any other session
   * on it (another tab, another computer) is saved and signed out, and any
   * ship left lingering by an earlier connection finished; then the profile
   * loads (after those saves, so it's the latest).
   */
  async loginPilot(conn: ClientConnection, userId: number): Promise<void> {
    for (const other of [...this.clients.values()]) {
      if (other === conn || other.userId !== userId) continue;
      const eid = other.playerId;
      // Saved where they are; then it's a stranger's connection (so closing it doesn't save over the new one)
      await this.pilots.detach(other);
      other.userId = null;
      if (hasComponent(this.world, Player, eid) && !hasComponent(this.world, Dead, eid)) addComponent(this.world, Dead, eid);
      this.rejectAuth(other, 'You signed in somewhere else, so this session has ended.');
    }
    for (const [eid, l] of [...this.lingering]) {
      if (l.conn.userId !== userId) continue;
      this.lingering.delete(eid);
      await this.pilots.detach(l.conn);
      if (hasComponent(this.world, Player, eid)) addComponent(this.world, Dead, eid);
    }
    await this.pilots.login(conn, userId);
  }

  /** Ships left in space by players who quit mid-fight: saved and removed once the time is up */
  private lingerSystem(): void {
    for (const [eid, l] of [...this.lingering]) {
      const dead = !hasComponent(this.world, Player, eid) || hasComponent(this.world, Dead, eid);
      if (!dead && this.currentTick < l.until) continue;
      this.lingering.delete(eid);
      this.pilots.detach(l.conn).catch((e) => this.fault('detach', e));
      if (!dead) addComponent(this.world, Dead, eid);
    }
  }

  /**
   * PvP rules: players can always hurt pilotless ships, debris and enemies,
   * but another player only in a PvP zone (both of them in it). A player who
   * owns a body (none yet) is treated like the player.
   */
  canDamage(attacker: number, target: number): boolean {
    // Inside a station: out of the fight both ways
    if (this.dockedShips.has(attacker) || this.dockedShips.has(target)) return false;
    // People's ships are out of it
    if (this.personCraft.has(attacker) || this.personCraft.has(target)) return false;
    const aPlayer = hasComponent(this.world, Player, attacker), tPlayer = hasComponent(this.world, Player, target);
    // Pilots and what they defend (wards: freighters, pylons, bastions, their turrets) are on one side
    if ((aPlayer || this.wards.has(attacker)) && (tPlayer || this.wards.has(target)) && !(aPlayer && tPlayer)) return false;
    if (!aPlayer || !tPlayer) return true;
    return this.inPvpZone(attacker) && this.inPvpZone(target);
  }

  /** Inside a zone where players may fight each other */
  inPvpZone(eid: number): boolean {
    const sys = this.gameData.getSystemByNum(InSystem.systemId[eid]);
    const pvp = sys?.pvp;
    if (!pvp) return false;
    const safe = pvp.safeRadius ?? 3000;
    // Station rings are always safe
    for (const st of stationQuery(this.world)) {
      if (InSystem.systemId[st] !== InSystem.systemId[eid]) continue;
      const d = Math.hypot(Position.x[st] - Position.x[eid], Position.y[st] - Position.y[eid]);
      if (d < (pvp.mode === 'outer' ? safe : Math.max(Radius.value[st] + 1500, 2200))) return false;
    }
    return true;
  }

  /** Accounts already dealt with (the lobby repeats the list on every heartbeat) */
  private forgotten = new Set<number>();

  /** Accounts the lobby has deleted: disconnect anyone on them and delete their profiles and ranks */
  async forgetAccounts(ids: number[]): Promise<void> {
    for (const id of ids) {
      if (!Number.isInteger(id) || id <= 0 || this.forgotten.has(id)) continue;
      try {
        for (const conn of await this.pilots.forgetAccount(id)) this.rejectAuth(conn as ClientConnection, 'This account has been deleted.');
        this.achievements.forget(id);
        this.forgotten.add(id);
      } catch (e) {
        console.error(`[Accounts] could not delete the profile of account ${id}:`, e);
      }
    }
    await this.achievements.save();
  }

  /** Save everyone (server shutdown) */
  async saveAll(): Promise<void> {
    // (Each on its own: one store failing mustn't keep the others from being saved)
    const results = await Promise.allSettled([
      () => this.pilots.saveAll(),
      () => this.contrib.flush(),
      () => this.achievements.save(true),
      () => this.memory.save(),
    ].map(async (save) => save()));
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    for (const f of failed) console.error('[Save] a store failed to save:', f.reason);
    if (failed.length) throw new Error(`${failed.length} store(s) failed to save`);
  }

  /** This week's hunted boss: double rewards */
  private hunted(): { id: string; name: string; system: string } | null {
    const bosses = ((this.gameData.bossesFile as BossesFile | undefined)?.bosses ?? {}) as Record<string, { name: string; system: string }>;
    // Outposts aren't hunts: they're always where they are
    const id = huntedBoss(this.clock(), Object.keys(bosses).filter((b) => !(bosses[b] as { arena?: boolean; fixed?: boolean }).arena && !(bosses[b] as { fixed?: boolean }).fixed));
    return id ? { id, name: bosses[id].name, system: bosses[id].system } : null;
  }

  private createShipHost(): ShipHost {
    return {
      world: this.world,
      getTick: () => this.currentTick,
      // (The tick's broadphase: ships are filed by their bounding circles as the tick began)
      shipsAlong: (num, x0, y0, x1, y1, pad) => {
        const out: number[] = [];
        for (const e of this.spatialGrid.queryRay(num, x0, y0, x1, y1, pad)) if (e.type === 'player') out.push(e.id);
        return out;
      },
      createBody: () => {
        const eid = addEntity(this.world);
        addComponent(this.world, Position, eid);
        addComponent(this.world, Velocity, eid);
        addComponent(this.world, Rotation, eid);
        addComponent(this.world, Radius, eid);
        addComponent(this.world, InSystem, eid);
        InSystem.systemId[eid] = 0;
        return eid;
      },
      removeBody: (eid) => {
        this.pendingRemovedEntities.add(eid);
        removeEntity(this.world, eid);
      },
      terrainAt: (eid) => this.terrainOf(InSystem.systemId[eid]),
      // (Only pilots' splash and beams hurt mobs: a boss's own shells pass through its drones)
      splashMobs: (num, x, y, radius, damage, source) => { if (source >= 0 && hasComponent(this.world, Player, source)) this.mobs.splash(num, x, y, radius, damage); },
      beamMobs: (num, x0, y0, x1, y1, width, damage, source) => { if (source >= 0 && hasComponent(this.world, Player, source)) this.mobs.beam(num, x0, y0, x1, y1, width, damage); },
      arcHop: (num, x, y, fx, fy) => this.broadcastToSystem(num, { type: 'detonation', kind: 'tesla_arc', x: Math.round(x), y: Math.round(y), radius: 30, from: [Math.round(fx), Math.round(fy)] }),
      fireBaseShot: (ownerEid, x, y, angle, damageScale, shape) => {
        const ids: number[] = [];
        this.weapons.spawn(ownerEid, shape?.kind ?? 'cannon', x, y, angle, damageScale,
          { speedScale: shape?.speedScale ?? 1, sizeScale: shape?.sizeScale ?? 1, turret: shape?.turret ?? false, target: shape?.target, seed: shape?.seed, mods: shape?.mods, dry: shape?.dry, ammoMods: shape?.ammoMods, reach: shape?.reach, grade: shape?.grade, size: shape?.size, model: shape?.model }, ids);
        return ids;
      },
      shotVs: (proj) => this.weapons.vsOf(proj),
      hazardScale: (eid) => this.hazards.shieldScale(eid),
      partLost: (eid, uid) => { const pc = this.pilots.connOf(eid); if (pc) this.hangar.gemsLost(pc, uid); },
      spendAmmo: (eid, kind, free) => { const pc = this.pilots.connOf(eid); return pc ? this.ammo.spend(pc, kind, free) : { scale: 1, dry: false }; },
      beamAsteroid: (eid, x, y, angle, range, damage, kind) => this.beamAsteroid(eid, x, y, angle, range, damage, kind),
      notifyDamage: (targetEid, amount, sourceEid, glancing) => {
        this.bosses?.onDamage(targetEid, amount, sourceEid);
        this.range?.onDamage(targetEid, amount);
        // (Summed per target and source until the next snapshot, net/snapshot/Outbox.ts flushDamage)
        this.net.addDamage(InSystem.systemId[targetEid], targetEid, amount, sourceEid, !!glancing);
      },
      notifyProjectileHit: (proj, x, y) => this.broadcastProjectileHit(proj, x, y),
      onShipDestroyed: (eid, lastHitBy, ship) => {
        this.enemies.onDestroyed(eid, lastHitBy, ship);
        // A ward (freighter, pylon, bastion, turret) shot down: forget it before its entity number is reused
        if (this.wards.delete(eid)) { this.enemies.removeWard(eid); this.ships.setDamageScale(eid, 1); }
        this.derelictsMod.onPilotlessShipDestroyed(eid, lastHitBy);
      },
      notifyPartDestroyed: (e) => {
        const r = (v: number) => Math.round(v * 10) / 10;
        this.broadcastNear(e.systemId, e.x, e.y, {
          type: 'partDestroyed', bodyId: e.bodyId, part: e.part, fn: e.fn, how: e.how,
          x: r(e.x), y: r(e.y), vx: r(e.vx), vy: r(e.vy), size: r(e.size),
        });
      },
      notifyContact: (e) => {
        const r = (v: number) => Math.round(v * 100) / 100;
        this.broadcastNear(e.systemId, e.x, e.y, { type: 'contact', x: r(e.x), y: r(e.y), nx: r(e.nx), ny: r(e.ny), speed: r(e.speed) });
      },
      payRebuild: (eid, part) => this.pilots.payRebuild(eid, part),
      payRepair: (eid, hp) => this.pilots.payRepair(eid, hp, this.repairRate(eid)),
      canDamage: (a, b) => this.canDamage(a, b),
      // --- Support weapons (common/src/ships/features/support/support.ts) ---
      canHeal: (a, b) => this.canHeal(a, b),
      onHeal: (healer, target, hp) => this.support.note(healer, target, hp, this.currentTick),
      pdThreats: (eid, x, y, range, out) => this.weapons.threats(InSystem.systemId[eid], x, y, range, (owner) => owner !== eid && this.canDamage(owner, eid), out),
      intercept: (eid, part, proj, fx, fy) => {
        const x = Position.x[proj], y = Position.y[proj], sys = InSystem.systemId[proj];
        const down = this.weapons.intercept(proj);
        this.broadcastNear(sys, x, y, { type: 'intercept', bodyId: eid, part, proj, x: Math.round(x), y: Math.round(y), fx: Math.round(fx), fy: Math.round(fy), down });
        return down;
      },
      // --- end support weapons ---
      invulnerable: (eid) => (this.admin?.isGod(eid) ?? false) || this.dockedShips.has(eid) || this.personCraft.has(eid) || !!this.bosses?.brainOf(eid)?.invulnerable?.(),
      takenScale: (eid) => this.bosses?.brainOf(eid)?.taken?.() ?? 1,
      stageCover: (eid) => this.bosses?.stageCover(eid),
      baneFaction: (eid) => { const e = this.enemies?.info(eid); return e && !e.boss ? e.faction : undefined; },
      sheltered: (eid) => this.dockedShips.has(eid),
      mineBeam: (eid, x, y, angle, range, damage, material, gas, full) => this.mineBeam(eid, x, y, angle, range, damage, material, gas, full),
      nearRepairSite: (eid) => {
        const range = this.ships.tuning.repair?.range ?? 0;
        for (const st of stationQuery(this.world)) {
          if (InSystem.systemId[st] !== InSystem.systemId[eid]) continue;
          const d = Math.hypot(Position.x[st] - Position.x[eid], Position.y[st] - Position.y[eid]);
          if (d < Radius.value[st] + range) return true;
        }
        return false;
      },
      gravityAt: (eid) => this.gameData.getSystemByNum(InSystem.systemId[eid])?.centralBody?.gravity ?? null,
      hazardFlight: (eid, d, x, y) => {
        const sys = this.gameData.getSystemByNum(InSystem.systemId[eid]);
        return sys?.hazardRatings ? hazardFlight(this.gameData.hazardRules, sys, d, x, y) : undefined;
      },
      partValue: (part) => this.econ.items.get(partItemId(part))?.value ?? 20,
      cargoMass: (eid) => this.pilots.cargoMass(eid),
      featureCargo: (eid) => this.features?.cargoMass(eid) ?? 0,
      shipRebuilt: (eid) => this.features?.onShipRebuilt(eid),
      shieldBroken: (eid) => this.features?.onShieldBreak(eid),
      shipForgotten: (eid) => this.features?.onLeave(eid),
      onRepairKit: (eid, left, total, broken) => {
        const pc = this.pilots.connOf(eid) as ClientConnection | undefined;
        if (!pc) return;
        this.send(pc.ws, { type: 'repairKit', left: Math.round(left), total: Math.round(total) });
        if (broken === 'hit') this.pilots.toast(pc, 'Repair interrupted: you took a hit. The rest of the kit is wasted', 'bad');
        else if (broken === 'moved') this.pilots.toast(pc, 'Repair interrupted: you moved. The rest of the kit is wasted', 'bad');
        else if (left <= 0) this.pilots.toast(pc, 'Repair kit used up', 'info');
      },
      jumpFields: (eid) => this.replicaEnv(InSystem.systemId[eid]),
    };
  }

  // ============================================
  // INITIALIZATION
  // ============================================

  private initializeWorld(): void {
    // Create entities for each star system
    for (const system of this.gameData.getAllSystems()) {
      const systemNum = this.gameData.getSystemNum(system.id);
      
      // Create stations
      for (const stationId of system.stations) {
        const stationData = this.gameData.getStation(stationId);
        if (stationData) {
          this.createStation(stationData, systemNum);
        }
      }
      
      // Create jump gates and rifts
      for (const portalData of system.portals) {
        this.createPortal(portalData, systemNum);
      }
      for (const rift of system.rifts ?? []) {
        this.createRift(rift, systemNum);
      }

      // Derelict hulks (pre-made ships, battered) to break up for salvage
      for (const d of system.derelicts ?? []) {
        const slot = { data: d, systemNum, eid: -1, respawnTick: 0, spawns: 0 };
        this.derelicts.push(slot);
        // (A system remembered has its own back as they were: SystemMemory)
        if (!this.memory.remembers(system.id)) this.derelictsMod.spawnDerelict(slot);
      }
      for (const t of system.traffic ?? []) {
        const slot = { data: t, systemNum, eid: -1, leg: 0, dwell: 0, respawnTick: 0 };
        this.traffic.push(slot);
      }
      
      // Create asteroids
      this.createAsteroids(system, systemNum);
    }
    
    // Every belt filed: the orbit timetable trimmed to what's in it
    this.asteroidOrbits.settle();
    this.derelictsMod.spawnPersonCraft();
    console.log('World initialized');
  }

  private createStation(data: any, systemNum: number): number {
    const eid = addEntity(this.world);
    addComponent(this.world, Position, eid);
    addComponent(this.world, Radius, eid);
    addComponent(this.world, Station, eid);
    addComponent(this.world, InSystem, eid);
    addComponent(this.world, NetworkSync, eid);
    
    if (data.orbit) {
      const orbitType = data.orbit.orbitType ?? 0;
      const semiMajorAxis = data.orbit.semiMajorAxis ?? 0;
      const eccentricity = data.orbit.eccentricity ?? 0;
      const argPeriapsis = data.orbit.argPeriapsis ?? 0;
      const meanAnomaly0 = data.orbit.meanAnomaly0 ?? 0;
      const epochTick = data.orbit.epochTick ?? 0;
      const timeScale = data.orbit.timeScale ?? stationOrbitTimeScale(semiMajorAxis);
      const { x, y } = calcAsteroidPosition({
        orbitType,
        semiMajorAxis,
        eccentricity,
        argPeriapsis,
        meanAnomaly0,
        epochTick,
      }, scaledOrbitTick(this.currentTick, epochTick, timeScale));
      Station.orbitTimeScale[eid] = timeScale;
      Position.x[eid] = x;
      Position.y[eid] = y;
      Station.orbitType[eid] = orbitType;
      Station.semiMajorAxis[eid] = semiMajorAxis;
      Station.eccentricity[eid] = eccentricity;
      Station.argPeriapsis[eid] = argPeriapsis;
      Station.meanAnomaly0[eid] = meanAnomaly0;
      Station.epochTick[eid] = epochTick;
    } else {
      Position.x[eid] = data.position.x;
      Position.y[eid] = data.position.y;
      Station.orbitType[eid] = 255;
      Station.semiMajorAxis[eid] = 0;
      Station.eccentricity[eid] = 0;
      Station.argPeriapsis[eid] = 0;
      Station.meanAnomaly0[eid] = 0;
      Station.epochTick[eid] = 0;
      Station.orbitTimeScale[eid] = 1;
    }
    Radius.value[eid] = data.radius;
    Station.stationId[eid] = this.gameData.getStationNum(data.id) || 0;
    Station.dockingRadius[eid] = data.dockingRadius;
    InSystem.systemId[eid] = systemNum;
    
    return eid;
  }

  private createRift(data: RiftData, systemNum: number): number {
    const eid = addEntity(this.world);
    addComponent(this.world, Position, eid);
    addComponent(this.world, Radius, eid);
    addComponent(this.world, Portal, eid);
    addComponent(this.world, InSystem, eid);
    addComponent(this.world, NetworkSync, eid);
    Position.x[eid] = data.position.x;
    Position.y[eid] = data.position.y;
    Radius.value[eid] = RIFT_TRIGGER_RADIUS;
    Portal.kind[eid] = 1;
    Portal.hue[eid] = data.hue ?? 275;
    Portal.targetSystem[eid] = this.gameData.getSystemNum(data.destination.system);
    Portal.targetX[eid] = data.destination.x;
    Portal.targetY[eid] = data.destination.y;
    InSystem.systemId[eid] = systemNum;
    return eid;
  }

  private createPortal(data: any, systemNum: number): number {
    const eid = addEntity(this.world);
    addComponent(this.world, Position, eid);
    addComponent(this.world, Radius, eid);
    addComponent(this.world, Portal, eid);
    addComponent(this.world, InSystem, eid);
    addComponent(this.world, NetworkSync, eid);
    
    Position.x[eid] = data.position.x;
    Position.y[eid] = data.position.y;
    Radius.value[eid] = 200;
    Portal.targetSystem[eid] = this.gameData.getSystemNum(data.targetSystem);
    Portal.kind[eid] = 0;
    InSystem.systemId[eid] = systemNum;
    
    return eid;
  }

  private createAsteroids(system: any, systemNum: number): void {
    const belt = system.asteroidBelt;
    if (!belt) return;
    const ids: number[] = [];
    const seedTick = this.currentTick;
    for (let i = 0; i < beltTotal(belt); i++) ids.push(this.createAsteroid(system, systemNum, i, seedTick));
    this.asteroidIdsBySystem.set(systemNum, ids);
    this.asteroidSeedTickBySystem.set(systemNum, seedTick);
  }

  /**
   * One belt asteroid, deterministic from (system, index, spawn tick) so clients
   * derive the same orbit, shape and composition. Respawns use a new tick.
   */
  private createAsteroid(system: any, systemNum: number, i: number, spawnTick: number): number {
    const belt = system.asteroidBelt;
    const systemId = system.id || String(systemNum);
    const params = asteroidParamsAt(systemId, i, ASTEROID_SEED, spawnTick, belt, system.asteroidField as string | undefined);
    const { x, y } = calcAsteroidPosition({
      orbitType: params.orbitType,
      semiMajorAxis: params.semiMajorAxis,
      eccentricity: params.eccentricity,
      argPeriapsis: params.argPeriapsis,
      meanAnomaly0: params.meanAnomaly0,
      epochTick: params.epochTick,
    }, this.currentTick);
    const eid = addEntity(this.world);
    for (const c of [Position, Velocity, Radius, Asteroid, Health, InSystem, NetworkSync]) addComponent(this.world, c, eid);
    const size = params.size;
    const hp = Math.floor(size * params.healthPerUnit);
    Position.x[eid] = x;
    Position.y[eid] = y;
    Velocity.x[eid] = 0;
    Velocity.y[eid] = 0;
    Radius.value[eid] = size;
    Asteroid.size[eid] = size;
    Asteroid.hp[eid] = hp;
    Asteroid.maxHp[eid] = hp;
    Asteroid.resourceType[eid] = params.resourceType;
    Asteroid.resourceAmount[eid] = Math.floor(size / 10) + 1;
    Asteroid.orbitType[eid] = params.orbitType;
    Asteroid.semiMajorAxis[eid] = params.semiMajorAxis;
    Asteroid.eccentricity[eid] = params.eccentricity;
    Asteroid.argPeriapsis[eid] = params.argPeriapsis;
    Asteroid.meanAnomaly0[eid] = params.meanAnomaly0;
    Asteroid.epochTick[eid] = params.epochTick;
    Asteroid.wobblePhase[eid] = params.wobblePhase;
    Health.current[eid] = hp;
    Health.max[eid] = hp;
    InSystem.systemId[eid] = systemNum;
    this.asteroidIndexById.set(eid, i);
    this.asteroidTypeById.set(eid, params.definitionId || 'asteroid_metal');
    // (From the stored fields: they're what its position is worked out from)
    this.asteroidOrbits.add(eid, systemNum, {
      semiMajorAxis: Asteroid.semiMajorAxis[eid], eccentricity: Asteroid.eccentricity[eid], argPeriapsis: Asteroid.argPeriapsis[eid],
      meanAnomaly0: Asteroid.meanAnomaly0[eid], epochTick: Asteroid.epochTick[eid], size: Asteroid.size[eid],
      fixed: Asteroid.orbitType[eid] === OrbitType.Fixed,
    });
    if (params.outlier) this.asteroidStageById.set(eid, { stage: 0, wholeSize: size });
    this.mining.register(eid, systemNum, i, params.definitionId || 'asteroid_metal', `${systemId}:${i}:${spawnTick}`, size, system.danger ?? 1, params.outlier ? { stage: 0, wholeSize: size } : undefined);
    return eid;
  }

  /**
   * An outlier's stage broke away: the smaller rock it leaves, on the same
   * orbit (a new entity, so a new shape), holding the ore that's left.
   */
  private shedAsteroid(old: number, stage: number, size: number, left: number): void {
    const systemNum = InSystem.systemId[old];
    const system = this.gameData.getSystemByNum(systemNum);
    const index = this.asteroidIndexById.get(old) ?? 0;
    const type = this.asteroidTypeById.get(old) ?? 'asteroid_metal';
    const wholeSize = this.asteroidStageById.get(old)?.wholeSize ?? Asteroid.size[old];
    const eid = addEntity(this.world);
    for (const c of [Position, Velocity, Radius, Asteroid, Health, InSystem, NetworkSync]) addComponent(this.world, c, eid);
    // Its health per size as the whole rock's
    const hp = Math.floor(size * (Asteroid.maxHp[old] / (Asteroid.size[old] || 1)));
    Asteroid.size[eid] = size;
    Radius.value[eid] = size;
    Asteroid.hp[eid] = Asteroid.maxHp[eid] = Health.current[eid] = Health.max[eid] = hp;
    Asteroid.resourceType[eid] = Asteroid.resourceType[old];
    Asteroid.resourceAmount[eid] = Math.floor(size / 10) + 1;
    Asteroid.orbitType[eid] = Asteroid.orbitType[old];
    Asteroid.semiMajorAxis[eid] = Asteroid.semiMajorAxis[old];
    Asteroid.eccentricity[eid] = Asteroid.eccentricity[old];
    Asteroid.argPeriapsis[eid] = Asteroid.argPeriapsis[old];
    Asteroid.meanAnomaly0[eid] = Asteroid.meanAnomaly0[old];
    Asteroid.epochTick[eid] = Asteroid.epochTick[old];
    Asteroid.wobblePhase[eid] = Asteroid.wobblePhase[old];
    Velocity.x[eid] = Velocity.y[eid] = 0;
    InSystem.systemId[eid] = systemNum;
    this.asteroidIndexById.set(eid, index);
    this.asteroidTypeById.set(eid, type);
    this.asteroidStageById.set(eid, { stage, wholeSize });
    this.asteroidOrbits.add(eid, systemNum, {
      semiMajorAxis: Asteroid.semiMajorAxis[eid], eccentricity: Asteroid.eccentricity[eid], argPeriapsis: Asteroid.argPeriapsis[eid],
      meanAnomaly0: Asteroid.meanAnomaly0[eid], epochTick: Asteroid.epochTick[eid], size,
      fixed: Asteroid.orbitType[eid] === OrbitType.Fixed,
    });
    this.placeAsteroid(eid);
    this.mining.register(eid, systemNum, index, type, `${system?.id || String(systemNum)}:${index}:${Asteroid.epochTick[eid]}`, size, system?.danger ?? 1, { stage, wholeSize, left });
    this.announceAsteroid(eid);
  }

  /** A broken asteroid grows back: re-create it and tell everyone in the system */
  private respawnAsteroid(systemNum: number, index: number): void {
    const system = this.gameData.getSystemByNum(systemNum);
    if (!system?.asteroidBelt) return;
    this.announceAsteroid(this.createAsteroid(system, systemNum, index, this.currentTick));
  }

  /** A rock that's not in its belt's seed (grown back, or an outlier's next stage): tell everyone in the system */
  private announceAsteroid(eid: number): void {
    const systemNum = InSystem.systemId[eid];
    this.respawnedAsteroids.add(eid);
    const ids = this.asteroidIdsBySystem.get(systemNum);
    if (ids) ids.push(eid);
    for (const c of this.clients.values()) if (InSystem.systemId[c.playerId] === systemNum) c.knownEntities.add(eid);
    this.broadcastToSystem(systemNum, { type: 'asteroidSpawn', tick: this.currentTick, asteroids: [this.asteroidSpawnData(eid)] });
  }

  private asteroidSpawnData(eid: number) {
    const system = this.gameData.getSystemByNum(InSystem.systemId[eid]);
    return {
      id: eid, size: Asteroid.size[eid], resourceType: Asteroid.resourceType[eid], orbitType: Asteroid.orbitType[eid],
      semiMajorAxis: Asteroid.semiMajorAxis[eid], eccentricity: Asteroid.eccentricity[eid], argPeriapsis: Asteroid.argPeriapsis[eid],
      meanAnomaly0: Asteroid.meanAnomaly0[eid], epochTick: Asteroid.epochTick[eid], wobblePhase: Asteroid.wobblePhase[eid],
      hp: Math.max(0, Asteroid.hp[eid]), maxHp: Asteroid.maxHp[eid], stage: this.asteroidStageById.get(eid)?.stage,
      index: this.asteroidIndexById.get(eid), definitionId: this.asteroidTypeById.get(eid), systemId: system?.id,
    };
  }

  /** A broken asteroid leaves its system's list (its entity id will be reused) */
  private forgetAsteroid(eid: number): void {
    const ids = this.asteroidIdsBySystem.get(InSystem.systemId[eid]);
    if (ids) { const k = ids.indexOf(eid); if (k >= 0) ids.splice(k, 1); }
    this.asteroidIndexById.delete(eid);
    this.asteroidTypeById.delete(eid);
    this.respawnedAsteroids.delete(eid);
    this.asteroidOrbits.remove(eid);
    this.asteroidPlacedAt.delete(eid);
    this.asteroidStageById.delete(eid);
  }


  // ============================================
  // CONNECTION HANDLING
  // ============================================

  /**
   * Register a new client. The transport owns the socket; it decodes incoming
   * data and feeds messages through the returned link.
   */
  connect(ws: ClientSocket, address?: string): ClientLink {
    console.log('Client connected');
    this.totalConnectionsEver++;

    // Create player entity
    const playerId = this.createPlayer();
    const clientId = this.clientIdCounter++;

    const conn: ClientConnection = {
      ws,
      address,
      playerId,
      lastInputSeq: 0,
      lastPingTime: Date.now(),
      ping: 0,
      knownEntities: new Set(),
      lastSystemId: -1,
      lastSystemInfoId: null,
      username: `Player${clientId}`,
      userId: null,
      isAdmin: this.everyoneAdmin,
      isContributor: false,
      authToken: null,
      scheduledInputs: [],
      joined: false,
      inputsThisTick: 0,
      liveTick: 0,
      hashSeen: false,
      forceSnapshot: true,
      lastSnapshotSentTick: 0,
      blueprint: null,
      docked: null,
      shipSynced: new Map(),
      shipHpSent: new Map(),
      sentNames: new Map(),
      repKnown: new Map(),
      debrisHeld: new Map(),
      debrisRowOk: new Set(),
      shipView: new Set(),
      mapNamed: new Set(),
      aheadHashes: new Map(),
      designs: new Set(),
      playerStateKey: '',
      selfLate: false,
      selfVersion: 0,
      selfKey: '',
      selfSentTick: -1e9,
      selfHashes: new Map(),
    };
    
    this.clients.set(ws, conn);
    Player.clientId[playerId] = clientId;
    this.pilots.attach(conn);

    // Send welcome message
    this.send(ws, {
      type: 'welcome',
      playerId,
      protocol: PROTOCOL_VERSION,
      tickRate: TICK_RATE,
      serverTime: Date.now(),
      threats: this.threats(),
      regionThreats: this.regionThreats(),
    });

    // Send initial state
    this.sendPlayerState(conn);

    return {
      receive: (msg: ClientMessage) => {
        this.net.batching++;
        try {
          this.handleMessage(conn, msg);
        } catch (e) {
          // (Logged a line every 10 s at most per type: a hostile client could send thousands)
          this.fault(`message:${typeof msg?.type === 'string' ? msg.type.slice(0, 32) : '?'}`, e);
        } finally {
          this.net.batching--;
          // Answers to requests go now, together (inputs only queue, so usually nothing)
          if (!this.net.batching) this.flushOutbox();
        }
      },
      close: () => {
        console.log('Client disconnected');
        // Off a siege moon first (paid what they're owed, back in orbit), so that's where they're saved
        // (Each step on its own: one that throws mustn't stop the rest, or the save, from happening)
        this.guard('close', () => this.sieges.leave(conn));
        this.guard('close', () => this.people.leave(conn));
        this.guard('close', () => this.arenas.leave(conn));
        this.clients.delete(ws);
        this.net.outbox.delete(ws);
        this.net.lazy.delete(ws);
        this.guard('close', () => this.party.remove(conn));
        this.guard('close', () => this.trade.remove(conn));
        this.guard('close', () => this.admin.forget(conn));
        this.guard('close', () => this.contrib.forget(conn));
        this.guard('close', () => this.ammo.forget(conn));
        const eid = conn.playerId;
        const alive = hasComponent(this.world, Player, eid) && !hasComponent(this.world, Dead, eid);
        // Leaving mid-fight doesn't save you: the ship stays put (hands off the controls) for a while
        if (alive && conn.userId !== null && this.currentTick - this.ships.lastDamagedTick(eid) < LINGER_COMBAT_TICKS) {
          this.releaseControls(eid);
          this.lingering.set(eid, { conn, until: this.currentTick + LINGER_TICKS });
          return;
        }
        this.pilots.detach(conn).catch((e) => this.fault('detach', e));
        if (hasComponent(this.world, Player, eid)) addComponent(this.world, Dead, eid);
      },
    };
  }

  createPlayer(): number {
    const eid = addEntity(this.world);
    
    addComponent(this.world, Position, eid);
    addComponent(this.world, Velocity, eid);
    addComponent(this.world, Rotation, eid);
    addComponent(this.world, Radius, eid);
    addComponent(this.world, Health, eid);
    addComponent(this.world, Player, eid);
    addComponent(this.world, Input, eid);
    addComponent(this.world, Boost, eid);
    addComponent(this.world, Inventory, eid);
    addComponent(this.world, InSystem, eid);
    addComponent(this.world, NetworkSync, eid);
    
    // Spawn beside the starter station (a pilot with a profile is placed where they left off when it loads)
    const at = this.starterSpot();
    Position.x[eid] = at.x;
    Position.y[eid] = at.y;
    Velocity.x[eid] = 0;
    Velocity.y[eid] = 0;
    Rotation.angle[eid] = 0;
    Radius.value[eid] = PLAYER_RADIUS;
    
    // Health mirrors the ship's core HP (the ship bridge keeps it in sync)
    Health.current[eid] = PLAYER_MAX_HP;
    Health.max[eid] = PLAYER_MAX_HP;
    Health.regenRate[eid] = 0;
    Health.lastDamageTick[eid] = 0;

    Player.level[eid] = 1;
    Player.xp[eid] = 0;
    Player.credits[eid] = 500;
    Player.systemId[eid] = 0; // Sol
    
    Boost.fuel[eid] = BOOST_FUEL_DEFAULT;
    Boost.maxFuel[eid] = BOOST_FUEL_DEFAULT;
    Boost.drainRate[eid] = BOOST_DRAIN;
    Boost.regenRate[eid] = BOOST_REGEN;
    Boost.regenDelay[eid] = BOOST_REGEN_DELAY;
    Boost.lastUseTick[eid] = 0;
    
    InSystem.systemId[eid] = 0;
    // (The dev server's start system instead, the Rockery: guests are never placed again)
    if (this.devStartNum >= 0) {
      const dev = this.devStartSpot(eid);
      Player.systemId[eid] = InSystem.systemId[eid] = dev.system;
      Position.x[eid] = dev.x;
      Position.y[eid] = dev.y;
    }

    this.ships.onPlayerCreated(eid);

    return eid;
  }

  // ============================================
  // MESSAGE HANDLING
  // ============================================

  /** Per-connection rate limits for expensive or broadcast messages (net/MessageLimits.ts) */
  readonly limiter = new MessageLimiter();
  /** Client message handlers by type (built once; see buildMessageHandlers and net/dispatch.ts) */
  private readonly handlers: HandlerTable = this.buildMessageHandlers();

  /**
   * The client message handlers, by type (net/dispatch.ts runs them after its drops and limits). The bodies are
   * the old handleMessage switch's cases, unchanged but for `break` becoming `return`; later cuts move them out.
   */
  private buildMessageHandlers(): HandlerTable {
    const t = new HandlerRegistry();
    registerHandlers(t, registerModuleHandlers);
    registerHandlers(t, registerAuthHandlers);
    registerHandlers(t, registerShipEditHandlers);
    registerHandlers(t, registerFlightHandlers);
    t.on('chat', (_ctx, conn, msg) => {
      this.handleChat(conn, msg);
    });
    t.on('devStation', (_ctx, conn, msg) => {
      // Dev (or an admin): a station at Sol's site with every track at a tier, and in you go
      if (!this.devTeleport && !conn.isAdmin) return;
      const p = this.pilots.get(conn), file = stationTable();
      if (!p || !file) return;
      const tier = Math.max(0, Math.min(5, Math.floor(Number((msg as { tier?: number }).tier ?? 3))));
      p.outpost = { site: 'sol_outer', tracks: Object.fromEntries(Object.keys(file.tracks).map((t) => [t, tier])) };
      this.pilots.sendProfile(conn);
      const sol = this.gameData.getSystemNum('sol');
      const jp = [...portalQuery(this.world)].find((g) => InSystem.systemId[g] === sol && this.gameData.getSystemByNum(Portal.targetSystem[g])?.private);
      if (jp !== undefined) this.homes.jump(conn, 'sol', Position.x[jp], Position.y[jp]);
    });
    t.on('devTeleport', (_ctx, conn, msg) => {
      this.handleDevTeleport(conn, msg);
    });
    t.on('devSpawn', (_ctx, conn, msg) => {
      this.handleDevSpawn(conn, msg);
    });
    t.on('devShip', (_ctx, conn, msg) => {
      if (!this.devTeleport && !conn.isAdmin) return;
      const name = typeof msg.ship === 'string' ? msg.ship : '';
      const bp = name ? this.ships.library.get(name) ?? this.ships.enemyDesigns[name] ?? this.ships.devDesigns[name] ?? null : null;
      if (name && !bp) { this.pilots.toast(conn, `No library ship called ${name}`, 'warn'); return; }
      if (this.pilots.devSwapShip(conn, bp ?? null)) {
        this.ammo.restock(conn, { report: true, quiet: true });
        this.pilots.toast(conn, bp ? `Flying the ${bp.name} (dev: not saved)` : 'Back in your own ship', 'info');
      }
    });
    // A ports ship's Selectors flipped (common/src/ships/power/ports.ts): the pilot's own, nothing spent
    t.on('feedSwitch', (_ctx, conn) => {
      const ship = this.ships.get(conn.playerId), c = this.ships.chargeOf(conn.playerId);
      if (!ship?.derived.ports || !c.e) return;
      if (!ship.derived.ports.selectors.length) { this.pilots.toast(conn, 'No Selector fitted: nothing to switch', 'warn'); return; }
      portsSwitchFeeds(ship.derived.ports, c.e);
      this.pilots.toast(conn, 'Feeds switched: the old material runs out first', 'info');
    });
    t.on('devBoss', (_ctx, conn, msg) => {
      if (!this.devTeleport && !conn.isAdmin) return;
      const pid = conn.playerId, num = InSystem.systemId[pid];
      let boss = -1, bd = Infinity;
      for (const b of this.bosses.inSystem(num)) {
        const d = Math.hypot(Position.x[b] - Position.x[pid], Position.y[b] - Position.y[pid]);
        if (d < bd) { bd = d; boss = b; }
      }
      if (boss < 0) { this.pilots.toast(conn, 'No boss in this system', 'warn'); return; }
      if (msg.shed !== undefined) { this.bosses.brainOf(boss)?.forceShed?.(Number(msg.shed) || 0); this.pilots.toast(conn, `Boss shed ${msg.shed} steps`, 'info'); return; }
      if (msg.reset) { this.bosses.remove(boss); this.pilots.toast(conn, 'Boss reset: it comes back fresh in a moment', 'info'); return; }
      // Knock parts off (never the core, nor what holds the rest together) until it's worn that far, credited to you
      const at = Math.max(0.02, Math.min(1, Number(msg.wear) || 0.5));
      const ship = this.ships.get(boss)!;
      // (A share of each part at a time, round and round: parts are worn, not shot off, so it keeps its shape)
      for (let pass = 0; pass < 12 && this.ships.integrity(boss) >= at; pass++) {
        for (let i = 0; i < ship.hp.length && this.ships.integrity(boss) >= at; i++) {
          const fn = ship.blueprint.parts[i].fn;
          if (fn === 'core' || ship.hp[i] <= 1) continue;
          this.bosses.onDamage(boss, this.ships.hurt(boss, ship, i, ship.hp[i] * 0.3), pid);
        }
      }
      this.pilots.toast(conn, `Boss worn to ${Math.round(this.ships.integrity(boss) * 100)}%`, 'info');
    });
    t.on('devRange', (_ctx, conn, msg) => {
      this.handleDevRange(conn, msg);
    });
    t.on('shipNeed', (_ctx, conn, msg) => {
      // The client lost a ship's blueprint: the next snapshot sends it in full
      conn.shipSynced.delete(Number(msg.id));
      const bp = this.ships.get(Number(msg.id))?.blueprint;
      if (bp) conn.designs.delete(designHash(bp));
    });
    return t.freeze();
  }

  /** Test hook: every client message type handled (golden/clientMessages.json pins them) */
  handledMessageTypes(): string[] {
    return [...this.handlers.keys()];
  }

  private handleMessage(conn: ClientConnection, msg: ClientMessage): void {
    dispatch(this.handlers, this, conn, msg);
  }

  /** The station this player is close enough to dock at, or -1 (game/Docking.ts) */
  private stationInRange(eid: number): number {
    return this.docking.stationInRange(eid);
  }

  /** Is this player close enough to a station to use its shipyard? */
  isDocked(eid: number): boolean {
    return this.docking.isDocked(eid);
  }

  /** A wrong password, a refused registration, a replaced or deleted session: say why, then hang up (net/auth.ts) */
  private rejectAuth(conn: ClientConnection, error: string | undefined): void {
    rejectAuth(this, conn, error);
  }

  /** HTTP auth requests (register, login, validate), called by SocketTransport (net/auth.ts) */
  handleHttpAuth(req: IncomingMessage, res: ServerResponse, action: 'register' | 'login' | 'validate', address?: string): Promise<void> {
    return handleHttpAuth(this, req, res, action, address);
  }

  /**
   * Map click-to-warp (dev tool). Without coordinates, arrive somewhere sensible:
   * beside the system's first station, else clear of the central body.
   */
  private handleDevTeleport(conn: ClientConnection, msg: { systemId: string; x?: number; y?: number }): void {
    if (!this.devTeleport && !conn.isAdmin) {
      this.send(conn.ws, { type: 'systemMessage', text: 'Map warp is a dev tool (not enabled on this server)', color: '#f2d24b' });
      return;
    }
    const system = this.gameData.getSystem(msg.systemId);
    if (!system || !hasComponent(this.world, Player, conn.playerId) || hasComponent(this.world, Dead, conn.playerId)) return;
    const systemNum = this.gameData.getSystemNum(system.id);
    let x = msg.x, y = msg.y;
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
      let station = -1;
      for (const st of stationQuery(this.world)) if (InSystem.systemId[st] === systemNum) { station = st; break; }
      if (station >= 0 && this.scene === 'sectors') {
        x = Position.x[station] + 900;
        y = Position.y[station];
      } else {
        x = Math.max(8000, (system.centralBody?.radius ?? system.starRadius ?? 1000) + 7000);
        y = 0;
      }
    }
    conn.docked = null;
    this.travelTo(conn, systemNum, x, y, false);
  }

  /** The weapons range, wired to this server (dev only: the caller has checked the dev flag) */
  private createRange(cfg: RangeConfig): WeaponsRange {
    const live = (c: ClientConnection) => hasComponent(this.world, Player, c.playerId) && !hasComponent(this.world, Dead, c.playerId);
    return new WeaponsRange(cfg, this.enemies, this.ships, {
      tick: () => this.currentTick,
      systemNum: () => this.gameData.getSystem(cfg.system) ? this.gameData.getSystemNum(cfg.system) : -1,
      players: (num) => [...this.clients.values()].filter((c) => live(c) && InSystem.systemId[c.playerId] === num).map((c) => c.playerId),
      pilot: (player) => {
        const pc = this.pilots.connOf(player), ship = this.ships.get(player);
        const ideal = !!pc && this.ammo.isIdeal(pc);
        const guns = (ship?.derived.weapons ?? []).map((w) => {
          const fn = ship!.blueprint.parts[w.part]?.fn ?? '';
          const crate = ideal ? this.ammo.idealCrate(w.kind) : undefined;
          return { name: this.ships.catalog.functions.get(fn)?.name ?? fn, kind: w.kind, ...(crate ? { crate: this.pilots.econ.items.name(crate) } : {}) };
        });
        return { ideal, guns };
      },
      send: (player, msg) => { const c = this.pilots.connOf(player) as ClientConnection | undefined; if (c) this.send(c.ws, msg); },
    });
  }

  /** Dev tool, the weapons range (client message devRange): refused unless this is a dev server with the range loaded */
  private handleDevRange(conn: ClientConnection, msg: { action?: string; guns?: unknown; on?: unknown }): void {
    const range = this.range;
    if (!range || !this.devTeleport || process.env.NODE_ENV === 'production') {
      this.send(conn.ws, { type: 'systemMessage', text: 'The weapons range is a dev tool (not enabled on this server)', color: '#f2d24b' });
      return;
    }
    switch (msg.action) {
      case 'go': {
        const system = this.gameData.getSystem(range.cfg.system);
        if (!system || !hasComponent(this.world, Player, conn.playerId) || hasComponent(this.world, Dead, conn.playerId)) return;
        conn.docked = null;
        // (Ideal ammunition starts on: a borrowed rig carries no crates. The panel's switch turns it off.)
        this.ammo.setIdeal(conn, true);
        this.travelTo(conn, this.gameData.getSystemNum(system.id), range.cfg.origin.x, range.cfg.origin.y, false);
        return;
      }
      case 'arm': {
        const guns = (Array.isArray(msg.guns) ? msg.guns : []).filter((g): g is string => typeof g === 'string').slice(0, 2);
        const rig = guns.length ? buildRangeRig(this.ships.catalog, guns) : null;
        if (!rig) { this.pilots.toast(conn, 'No such weapon for the test rig', 'warn'); return; }
        if (this.pilots.devSwapShip(conn, rig)) this.pilots.toast(conn, `${rig.name} (dev: not saved)`, 'info');
        return;
      }
      case 'ideal':
        this.ammo.setIdeal(conn, !!msg.on);
        this.pilots.toast(conn, msg.on ? 'Ideal ammo on: unlimited rounds of the best crate' : 'Ideal ammo off: your own crates', 'info');
        return;
      case 'moving':
        range.setMoving(!!msg.on);
        return;
      case 'reset':
        range.reset();
        return;
    }
  }

  /** Dev tool: a hostile pack here (the system's own kind unless given) */
  private handleDevSpawn(conn: ClientConnection, msg: { x: number; y: number; faction?: string; ships?: string[] }): void {
    if ((!this.devTeleport && !conn.isAdmin) || !Number.isFinite(msg.x) || !Number.isFinite(msg.y)) return;
    const num = InSystem.systemId[conn.playerId];
    const sys = this.gameData.getSystemByNum(num);
    const groups = ((this.gameData.factionsFile as FactionsFile).spawns?.[sys?.id ?? '']?.groups ?? []).filter((g) => !g.passive);
    const g = msg.faction && msg.ships?.length ? { faction: msg.faction, ships: msg.ships.slice(0, 8) }
      : groups.length ? groups[Math.floor(Math.random() * groups.length)] : { faction: 'pirates', ships: ['pirate_skiff', 'pirate_raider'] };
    this.enemies.spawnPack(num, { faction: g.faction, ships: g.ships }, msg.x, msg.y);
  }

  /**
   * Refits that take no parts and need no licence: proto mode (everyone's an
   * admin, editing anywhere), or an admin who switched on free build where the
   * server allows it (dev only: freeBuildAllowed is never set in production)
   */
  freeBuild(conn: ClientConnection): boolean {
    return (this.everyoneAdmin && this.shipEditAnywhere) || (this.freeBuildAllowed && this.admin.freeBuild(conn));
  }

  /** Apply or schedule one queued input (net/handlers/flight.ts; drainInputQueue calls it) */
  private handleInput(conn: ClientConnection, msg: any): void {
    flight.handleInput(this, conn, msg);
  }

  /** Write input state to ECS components for a player entity (net/handlers/flight.ts) */
  private applyInputToEntity(conn: ClientConnection, msg: any): void {
    flight.applyInputToEntity(this, conn, msg);
  }

  /** End of tick: remember each pilot's ship state hash (net/handlers/flight.ts; run from the tick list) */
  private recordSelfHashes(): void {
    flight.recordSelfHashes(this);
  }

  private handleChat(conn: ClientConnection, msg: any): void {
    // Broadcast chat to all clients
    const text = String(msg.text || '').slice(0, 200).trim();
    if (!text) return;
    // Admin commands (/help lists them for admins)
    if (conn.isAdmin && this.admin.chat(conn, text)) return;
    // Party commands
    const cmd = /^\/(\w+)\s*(.*)$/.exec(text);
    if (cmd) {
      const [, c, arg] = cmd;
      switch (c.toLowerCase()) {
        case 'p': case 'party': if (arg) this.party.chat(conn, arg); return;
        case 'invite': this.party.invite(conn, { name: arg }); return;
        case 'leave': this.party.leave(conn); return;
        case 'kick': this.party.kick(conn, arg); return;
        case 'promote': this.party.promote(conn, arg); return;
        case 'help':
          this.send(conn.ws, { type: 'systemMessage', text: 'Chat commands: /p message (party chat) · /invite name · /leave · /kick name · /promote name', color: '#7dd3fc' });
          return;
      }
    }
    
    for (const client of this.clients.values()) {
      this.send(client.ws, {
        type: 'chat',
        playerId: conn.playerId,
        playerName: conn.username,
        text,
        timestamp: Date.now(),
      });
    }
  }

  /**
   * Whose account a guest's name is (whatever its case): an admin's or a registered pilot's, or nobody's (null).
   * signedInOwner knows those signed in here; accountOwner asks the lobby (when this server may: its admin secret,
   * `userDB.admin`), and a lobby that can't be reached doesn't keep guests out.
   */
  /**
   * A wrong password or a refused registration: say why, then hang up, so the
   * connection doesn't stay in the world as a nameless pilot.
   */
  /**
   * Move a player to (x, y) in another (or the same) system: jump gates and rifts.
   * Rifts keep the ship's momentum; gates bring it to a stop.
   */
  travelTo(conn: ClientConnection, systemNum: number, x: number, y: number, keepMomentum: boolean): void {
    const eid = conn.playerId;
    const target = this.gameData.getSystemByNum(systemNum);
    if (!target) return;
    const fromSystem = InSystem.systemId[eid];
    // (A system that was put away is back before the pilot's there: SystemMemory)
    this.memory.enter(systemNum);
    if (fromSystem !== systemNum && !target.private && !target.surface && !target.pocket) this.pilots.track(conn, `visit_${target.id}`, { from: this.gameData.getSystemByNum(fromSystem)?.id }, true);
    this.broadcastToSystem(fromSystem, { type: 'effect', effectType: EffectType.WarpOut, x: Position.x[eid], y: Position.y[eid] });
    InSystem.systemId[eid] = systemNum;
    Position.x[eid] = x;
    Position.y[eid] = y;
    if (!keepMomentum) {
      Velocity.x[eid] = 0;
      Velocity.y[eid] = 0;
    }
    if (fromSystem !== systemNum) {
      conn.knownEntities.clear();
      this.lastEntityStates.delete(eid); // the client drops the old system, so resend everything
      conn.lastSystemId = -1; // re-send the new system's static entities and asteroid seed
      this.send(conn.ws, { type: 'systemMessage', text: `Arrived in ${target.name}`, color: '#44ff44' });
    }
    conn.forceSnapshot = true;
    this.broadcastToSystem(systemNum, { type: 'effect', effectType: EffectType.WarpIn, x, y });
    this.sendPlayerState(conn);
  }

  /** Rifts fast-travel any player ship that flies into them. */
  private riftSystem(): void {
    for (const conn of this.clients.values()) {
      const eid = conn.playerId;
      if (!hasComponent(this.world, Player, eid) || hasComponent(this.world, Dead, eid)) continue;
      const cooling = (this.riftCooldown.get(eid) ?? 0) > this.currentTick;
      for (const rift of portalQuery(this.world)) {
        if (Portal.kind[rift] !== 1 || InSystem.systemId[rift] !== InSystem.systemId[eid]) continue;
        if (Math.hypot(Position.x[rift] - Position.x[eid], Position.y[rift] - Position.y[eid]) > Radius.value[rift]) continue;
        // Just come through (or thrown back out): not again until you've been clear of it a moment, however long you sit in it
        if (cooling) { this.riftCooldown.set(eid, Math.max(this.riftCooldown.get(eid)!, this.currentTick + 30)); break; }
        this.riftCooldown.set(eid, this.currentTick + RIFT_COOLDOWN_TICKS);
        const barred = this.quests.canEnter(conn, this.gameData.getSystemByNum(Portal.targetSystem[rift])?.id ?? '');
        if (barred) {
          // The rift throws unlicensed ships back out
          const dx = Position.x[eid] - Position.x[rift], dy = Position.y[eid] - Position.y[rift];
          const d = Math.hypot(dx, dy) || 1;
          const push = Math.max(12, Math.hypot(Velocity.x[eid], Velocity.y[eid]));
          Velocity.x[eid] = (dx / d) * push;
          Velocity.y[eid] = (dy / d) * push;
          this.pilots.toast(conn, barred, 'warn');
          break;
        }
        this.travelTo(conn, Portal.targetSystem[rift], Portal.targetX[rift], Portal.targetY[rift], true);
        break;
      }
    }
  }

  // ============================================
  // QUEST HANDLERS
  // ============================================

  // ============================================
  // BANK HANDLERS
  // ============================================

  // ============================================
  // GAME LOOP
  // ============================================

  /**
   * Pure setImmediate game loop — never sleeps.
   *
   * Every iteration yields to the Node event loop via setImmediate, so
   * WebSocket messages (inputs, pongs, chat) are received and dispatched
   * with ~0ms server-side delay instead of waiting for a setTimeout to
   * expire.  Inputs are queued on arrival and batch-applied right before
   * each tick for deterministic simulation.
   *
   * CPU usage is slightly higher than a sleeping loop, but on a dedicated
   * game server that's the correct trade-off — latency matters more than
   * idle power savings.
   */
  private gameLoop(): void {
    const now = performance.now();
    const deltaMs = now - this.lastTickTime;
    this.lastTickTime = now;
    
    this.tickAccumulator += deltaMs;
    if (this.paused) this.tickAccumulator = 0;

    // Fixed timestep updates— cap catch-up to avoid spiral of death
    let ticksThisFrame = 0;
    const maxTicksPerFrame = 4;
    this.net.batching++;
    try {
      while (this.tickAccumulator >= TICK_MS && ticksThisFrame < maxTicksPerFrame) {
        // Drain queued inputs right before each tick so they take effect
        // on the earliest possible tick boundary.
        this.guard('inputs', () => this.drainInputQueue());
      
        this.tick();
        this.tickAccumulator -= TICK_MS;
        ticksThisFrame++;
      }
    
      // If we're still behind, drop accumulated time to avoid spiral
      if (this.tickAccumulator > TICK_MS * maxTicksPerFrame) {
        this.tickAccumulator = 0;
      }
    
      // Send snapshots at snapshot rate
      if (this.currentTick - this.lastSnapshotTick >= TICK_RATE / SNAPSHOT_RATE) {
        this.lastSnapshotTick = this.currentTick;
        this.guard('snapshots', () => this.sendSnapshots());
      }
    } catch (e) {
      // (Whatever got past the guards: logged, and the loop goes on: it's scheduled below either way)
      this.tickAccumulator = 0;
      this.fault('gameLoop', e);
    } finally {
      this.net.batching--;
      this.guard('flushOutbox', () => this.flushOutbox());
    }
    
    // Schedule the next iteration with a precise delay instead of busy-spinning.
    // setImmediate loops consume a full CPU core, which starves co-located
    // processes and invites scheduler preemption mid-tick (observed as
    // 100-500ms tick spikes on loaded dev machines). Sleeping between ticks
    // drops CPU usage to near zero while keeping tick timing accurate —
    // the accumulator absorbs any timer jitter via catch-up.
    const msUntilNextTick = TICK_MS - this.tickAccumulator;
    if (msUntilNextTick > 1.5) {
      // Sleep until just before the next tick is due (1ms scheduling margin)
      this.gameLoopTimer = setTimeout(() => this.gameLoop(), msUntilNextTick - 1);
    } else {
      // Tick due now (or behind) — run on the next event loop pass
      this.gameLoopTimer = scheduleImmediate(() => this.gameLoop());
    }
  }
  
  /**
   * Apply all queued player inputs.  Called once per tick, right before
   * simulation, so every input lands on the earliest tick boundary.
   */
  private drainInputQueue(): void {
    // 1. Process newly received inputs (may schedule them for future ticks)
    for (let i = 0; i < this.inputQueue.length; i++) {
      const { conn, msg } = this.inputQueue[i];
      // (One bad input is dropped on its own; the queue's still cleared below)
      this.guard('input', () => this.handleInput(conn, msg));
    }
    this.inputQueue.length = 0; // clear without re-allocation
    
    // 2. Apply per-player scheduled inputs whose targetTick has arrived
    const nextTick = this.currentTick + 1;
    let drainedCount = 0;
    for (const conn of this.clients.values()) {
      conn.inputsThisTick = 0;
      // A client whose game loop has gone quiet (a hidden tab, a hung browser) stops flying and firing
      if (conn.hashSeen && this.currentTick - conn.liveTick > INPUT_TIMEOUT_TICKS) this.releaseControls(conn.playerId);
      const scheduled = conn.scheduledInputs;
      // Everything due, oldest first (the last one applied is the one in effect)
      const due = scheduled.filter((s) => s.targetTick <= nextTick);
      if (due.length) {
        due.sort((a, b) => a.targetTick - b.targetTick || (a.msg.seq ?? 0) - (b.msg.seq ?? 0));
        for (const s of due) this.guard('input', () => this.applyInputToEntity(conn, s.msg));
        drainedCount += due.length;
        conn.scheduledInputs = scheduled.filter((s) => s.targetTick > nextTick);
      }
    }
    void drainedCount;
  }

  /** Let go of every key (net/handlers/flight.ts) */
  private releaseControls(eid: number): void {
    flight.releaseControls(eid);
  }

  // ---- Crash isolation (server robustness audit, docs/audits/server-robustness.md) ----
  /** Errors by where they happened: how many, and when it was last logged */
  private faults = new Map<string, { count: number; unlogged: number; loggedAt: number }>();
  /** The tick's guarded systems, in order (built once; see buildTickSystems and tickOrder.ts) */
  private readonly tickSystems: readonly TickSystem[] = this.buildTickSystems();

  /**
   * Run one part of the tick (or one message, or one client's share of it): if it
   * throws, it's logged and counted and the rest of the tick still runs, so one
   * bad entity can't stop the world. The first error is logged whole, then at most
   * one line every 10 s per place, with how many there were since.
   */
  guard(where: string, fn: () => void): void {
    try {
      fn();
    } catch (e) {
      this.fault(where, e);
    }
  }

  fault(where: string, e: unknown): void {
    const now = Date.now();
    let f = this.faults.get(where);
    if (!f) { f = { count: 0, unlogged: 0, loggedAt: 0 }; this.faults.set(where, f); }
    f.count++;
    if (now - f.loggedAt < 10_000) { f.unlogged++; return; }
    const more = f.unlogged ? ` (and ${f.unlogged} more since the last report)` : '';
    f.loggedAt = now;
    f.unlogged = 0;
    console.error(`[Fault] ${where} threw at tick ${this.currentTick}${more}:`, e);
  }

  /** Errors caught so far, by where (admin stats, tests) */
  faultCounts(): Record<string, number> {
    return Object.fromEntries([...this.faults].map(([k, f]) => [k, f.count]));
  }
  // ---- end crash isolation ----

  /**
   * The tick's guarded systems as an ordered table (tickOrder.ts), built once. tick() walks it; the order is the
   * simulation order (golden/tickOrder.json pins it).
   */
  private buildTickSystems(): readonly TickSystem[] {
    const systems: TickSystem[] = [
      // ---- pilots-move ----
      // (Asteroids aren't moved: their positions are worked out when something needs them, see placeAsteroid)
      { name: 'stationOrbitSystem', phase: 'pilots-move', run: () => this.stationOrbitSystem() },
      // Systems pilots are in or coming to are in the world; ones left a while are put away (before anything's spawned)
      { name: 'memory', phase: 'pilots-move', scene: 'sectors', run: () => this.memory.tick() },
      // Reset spatial grid and rebuild
      { name: 'spatialGrid', phase: 'pilots-move', run: () => { this.spatialGrid.clear(); this.buildSpatialGrid(); } },
      { name: 'playerMovementSystem', phase: 'pilots-move', run: () => this.playerMovementSystem() },
      // (Part features tick here, after the pilots fly and before wrecks and pods move: a Tow Beam pulls what it tows. ships/features/host.ts)
      { name: 'towing', phase: 'pilots-move', run: () => { this.features.tick(); } },
      { name: 'dockingSystem', phase: 'pilots-move', run: () => this.docking.dockingSystem() },
      { name: 'riftSystem', phase: 'pilots-move', run: () => this.riftSystem() },
      // ---- combat ----
      // (Boost fuel is the ship's battery now: it charges in the flight step, energy.ts)
      { name: 'weaponSystem', phase: 'combat', run: () => this.weaponSystem() },
      { name: 'projectileSystem', phase: 'combat', run: () => this.projectileSystem() },
      { name: 'enemies', phase: 'combat', scene: 'sectors', run: () => { this.enemies.tick(); this.range?.tick(); } },
      { name: 'bosses', phase: 'combat', scene: 'sectors', run: () => this.bosses.tick() },
      { name: 'mobs', phase: 'combat', scene: 'sectors', run: () => this.mobs.tick() },
      { name: 'events', phase: 'combat', scene: 'sectors', run: () => this.events.tick() },
      { name: 'surfaces', phase: 'combat', scene: 'sectors', run: () => this.surfaces.tick() },
      { name: 'sieges', phase: 'combat', scene: 'sectors', run: () => this.sieges.tick() },
      { name: 'arenas', phase: 'combat', scene: 'sectors', run: () => this.arenas.tick() },
      { name: 'collisionSystem', phase: 'combat', run: () => this.collisionSystem() },
      // Check for destroyed asteroids
      { name: 'asteroidDeathSystem', phase: 'combat', run: () => this.asteroidDeathSystem() },
      { name: 'lod', phase: 'combat', run: () => this.lod.tick() },
      { name: 'ships', phase: 'combat', run: () => this.ships.tick() },
      { name: 'replication.endTick', phase: 'combat', run: () => this.replication.endTick() },
      { name: 'recordSelfHashes', phase: 'combat', run: () => this.recordSelfHashes() },
      // ---- world ----
      { name: 'pods', phase: 'world', run: () => this.pods.tick() },
      { name: 'mining', phase: 'world', run: () => this.mining.tick() },
      { name: 'hazards', phase: 'world', run: () => this.hazards.tick() },
      { name: 'warmth', phase: 'world', run: () => this.warmth.tick() },
      { name: 'homes', phase: 'world', run: () => this.homes.tick() },
      { name: 'watchComet', phase: 'world', run: () => this.watchComet() },
      // (per-client entries guard each client themselves)
      { name: 'outpost', phase: 'world', every: 60, when: () => !!this.outpost, perClient: true, run: () => {
        for (const c of this.clients.values()) this.guard('outpost', () => this.outpost!.finish(c));
      } },
      { name: 'pilots', phase: 'world', run: () => this.pilots.tick() },
      { name: 'quests', phase: 'world', run: () => this.quests.tick() },
      { name: 'codex', phase: 'world', run: () => this.codex.tick() },
      { name: 'party', phase: 'world', run: () => this.party.tick() },
      { name: 'trade', phase: 'world', run: () => this.trade.tick(this.currentTick) },
      { name: 'achievements', phase: 'world', every: 60, perClient: true, run: () => {
        for (const c of this.clients.values()) {
          if (this.flying(c.playerId)) this.guard('achievements', () => this.achievements.visit(c, this.gameData.getSystemByNum(InSystem.systemId[c.playerId])?.id ?? ''));
        }
        this.achievements.save().catch((e) => console.error('[Achievements] save failed:', e));
      } },
      { name: 'ops', phase: 'world', scene: 'sectors', run: () => this.ops.tick() },
      { name: 'services', phase: 'world', every: 60, perClient: true, run: () => {
        for (const c of this.clients.values()) this.guard('services', () => { this.services.tick(c); this.hangar.tick(c); this.hangar.fill(c); });
      } },
      // ---- persist ----
      { name: 'lingerSystem', phase: 'persist', run: () => this.lingerSystem() },
      { name: 'derelictRespawnSystem', phase: 'persist', run: () => this.derelictsMod.derelictRespawnSystem() },
      { name: 'trafficSystem', phase: 'persist', run: () => this.trafficSystem() },
      { name: 'lifetimeSystem', phase: 'persist', run: () => this.lifetimeSystem() },
      { name: 'cleanupSystem', phase: 'persist', run: () => this.cleanupSystem() },
    ];
    checkTickOrder(systems);
    return systems;
  }

  /** Test hook: the tick table's entries, in order (tickOrder.test.ts) */
  tickSystemList(): { name: string; phase: string; every?: number; scene?: string; perClient?: boolean }[] {
    return this.tickSystems.map((s) => ({ name: s.name, phase: s.phase, every: s.every, scene: s.scene, perClient: s.perClient }));
  }

  private tick(): void {
    const tickStart = performance.now();
    this.currentTick++;
    
    // The guarded systems, in order: tickOrder.ts (the table is built once, in buildTickSystems)
    const tick = this.currentTick, scene = this.scene;
    for (const s of this.tickSystems) {
      if (s.scene !== undefined && s.scene !== scene) continue;
      if (s.every !== undefined && tick % s.every !== 0) continue;
      if (s.when !== undefined && !s.when()) continue;
      if (s.perClient) s.run();
      else this.guard(s.name, s.run);
    }
    
    // Report to admin server and update performance metrics
    const tickTime = performance.now() - tickStart;
    this.updatePerfMetrics(tickTime);
    this.reportAdminStats(tickTime);
  }
  
  private buildSpatialGrid(): void {
    // (Asteroids aren't in it: they're filed once, by orbit, in asteroidOrbits)
    // Add players
    for (const eid of playerQuery(this.world)) {
      if (hasComponent(this.world, Dead, eid)) continue;
      this.spatialGrid.addEntity(
        eid, Position.x[eid], Position.y[eid], Radius.value[eid], 'player', InSystem.systemId[eid]
      );
    }
    
    // Add ship bodies that aren't players (dummies, debris)
    this.ships.addToSpatialGrid((eid, x, y, r) => this.spatialGrid.addEntity(eid, x, y, r, 'player', InSystem.systemId[eid]));

    // Add dropped items
    for (const eid of droppedItemQuery(this.world)) {
      if (hasComponent(this.world, Dead, eid)) continue;
      this.spatialGrid.addEntity(
        eid, Position.x[eid], Position.y[eid], 15, 'item', InSystem.systemId[eid]
      );
    }
  }
  
  private updatePerfMetrics(tickTime: number): void {
    perfMetrics.lastTickMs = tickTime;
    perfMetrics.ticksProcessed++;
    
    // Update running average
    const alpha = 0.1; // Smoothing factor
    perfMetrics.avgTickMs = perfMetrics.avgTickMs * (1 - alpha) + tickTime * alpha;
    perfMetrics.avgCollisionChecks = perfMetrics.avgCollisionChecks * (1 - alpha) + perfMetrics.collisionChecks * alpha;
    
    // Track min/max
    if (tickTime > perfMetrics.maxTickMs) perfMetrics.maxTickMs = tickTime;
    if (tickTime > perfMetrics.windowMaxMs) perfMetrics.windowMaxMs = tickTime;
    if (tickTime < perfMetrics.minTickMs) perfMetrics.minTickMs = tickTime;
    
    // Warn if tick is taking too long (>14ms leaves buffer for 60Hz)
    if (tickTime > 14 && perfMetrics.ticksProcessed > 100) {
      console.warn(`⚠️ Tick ${this.currentTick} took ${tickTime.toFixed(2)}ms (avg: ${perfMetrics.avgTickMs.toFixed(2)}ms, collisions: ${perfMetrics.collisionChecks})`);
    }
    
    // Reset per-tick counters
    perfMetrics.collisionChecks = 0;
    perfMetrics.spatialQueries = 0;
  }

  // ============================================
  // SYSTEMS
  // ============================================

  private playerMovementSystem(): void {
    for (const eid of playerQuery(this.world)) this.ships.stepMovement(eid);
  }
  
  private weaponSystem(): void {
    for (const eid of playerQuery(this.world)) this.ships.stepWeapons(eid);
  }

  private fireCannon(shooterEid: number, x: number, y: number, angle: number, item: any, systemId: number, spawnOffset = 30,
    shape: { speedScale: number; sizeScale: number; turret: boolean } = { speedScale: 1, sizeScale: 1, turret: false }): void {
    const eid = addEntity(this.world);
    addComponent(this.world, Position, eid);
    addComponent(this.world, Velocity, eid);
    addComponent(this.world, Radius, eid);
    addComponent(this.world, Projectile, eid);
    addComponent(this.world, Bullet, eid);
    addComponent(this.world, Lifetime, eid);
    addComponent(this.world, InSystem, eid);
    addComponent(this.world, NetworkSync, eid);
    addComponent(this.world, OwnedBy, eid);
    
    // Seeded randomization using tick + entity ID for deterministic 1% variance
    const rng = mulberry32(hashString(`bullet:${this.currentTick}:${eid}`));
    const angleVariance = (rng() - 0.5) * 0.02 * Math.PI; // ~1% angle variance (±1 degree)
    const speedVariance = 0.99 + rng() * 0.02; // 99-101% speed variance
    
    const speed = BULLET_SPEED * (item.speed || 1) * shape.speedScale * speedVariance;
    const damage = BULLET_DAMAGE * (item.damage || 1);
    const finalAngle = angle + angleVariance;
    
    // Spawn slightly ahead of player (modular ships pass their muzzle and offset 0)
    const spawnX = x + Math.cos(angle) * spawnOffset;
    const spawnY = y + Math.sin(angle) * spawnOffset;
    
    Position.x[eid] = spawnX;
    Position.y[eid] = spawnY;
    
    // Add player velocity to bullet
    Velocity.x[eid] = Math.cos(finalAngle) * speed + Velocity.x[shooterEid] * 0.3;
    Velocity.y[eid] = Math.sin(finalAngle) * speed + Velocity.y[shooterEid] * 0.3;
    
    Radius.value[eid] = 5 * shape.sizeScale;
    Projectile.ownerId[eid] = shooterEid;
    Projectile.sizeScale[eid] = shape.sizeScale;
    Projectile.turret[eid] = shape.turret ? 1 : 0;
    const tool = this.gameData.miningTable.tools[shape.turret ? 'turret' : 'fixed'];
    Projectile.miningYield[eid] = tool.yield;
    Projectile.miningHardness[eid] = tool.hardness;
    Projectile.damage[eid] = damage;
    Projectile.weaponType[eid] = WeaponType.Cannon;
    Projectile.tier[eid] = item.tier || 1;
    Projectile.spawnTick[eid] = this.currentTick;
    Projectile.spawnX[eid] = spawnX;
    Projectile.spawnY[eid] = spawnY;
    Projectile.endTick[eid] = 0;
    Bullet.speed[eid] = speed;
    // Slower shells live longer, so the range stays the same
    Lifetime.remaining[eid] = Math.round(BLASTER_LIFE_TICKS / shape.speedScale);
    InSystem.systemId[eid] = systemId;
    OwnedBy.ownerId[eid] = shooterEid;
  }
  private projectileSystem(): void {
    this.weapons.tick();
    const projectiles = projectileQuery(this.world);

    for (const eid of projectiles) {
// Update position
      Position.x[eid] += Velocity.x[eid];
      Position.y[eid] += Velocity.y[eid];
    }
  }

  /**
   * Put an asteroid where its orbit has it this tick. Nothing moves asteroids
   * every tick: anything about to read one's Position calls this first.
   */
  placeAsteroid(eid: number): void {
    if (this.asteroidPlacedAt.get(eid) === this.currentTick) return;
    this.asteroidPlacedAt.set(eid, this.currentTick);
    const state = calcOrbitStateRaw(
      Asteroid.orbitType[eid],
      Asteroid.semiMajorAxis[eid],
      Asteroid.eccentricity[eid],
      Asteroid.argPeriapsis[eid],
      Asteroid.meanAnomaly0[eid],
      Asteroid.epochTick[eid],
      this.currentTick,
    );
    Position.x[eid] = state.x;
    Position.y[eid] = state.y;
  }

  private stationOrbitSystem(): void {
    const stations = stationQuery(this.world);

    for (const eid of stations) {
      if (Station.orbitType[eid] === 255 || Station.semiMajorAxis[eid] <= 0) continue;
      const state = calcOrbitStateRaw(
        Station.orbitType[eid],
        Station.semiMajorAxis[eid],
        Station.eccentricity[eid],
        Station.argPeriapsis[eid],
        Station.meanAnomaly0[eid],
        Station.epochTick[eid],
        scaledOrbitTick(this.currentTick, Station.epochTick[eid], Station.orbitTimeScale[eid]),
      );
      Position.x[eid] = state.x;
      Position.y[eid] = state.y;
    }
  }

  /**
   * Where each shot flying straight meets rock, in a place whose rock never changes (surface `fixedWalls`): worked out
   * once, along the whole of its flight, as it's first seen; `steady` false once its course changes (missiles turn and
   * speed up: they ask of each step instead). Elsewhere every shot asks of each step.
   */
  private shotWalls = new Map<number, { born: number; steady: boolean; vx: number; vy: number; wx: number; wy: number }>();

  /** How far along this tick's step (0..1) a shot meets rock (1: it doesn't) */
  private shotWall(proj: number, systemId: number, px: number, py: number, vx: number, vy: number): number {
    const terrain = this.terrainOf(systemId);
    if (!terrain) return 1;
    if (!this.gameData.getSystemByNum(systemId)?.surface?.fixedWalls) return rayTerrain(terrain, px, py, px + vx, py + vy);
    const born = Projectile.spawnTick[proj];
    let c = this.shotWalls.get(proj);
    // (a new shot in an old one's entity)
    if (c && c.born !== born) c = undefined;
    if (c && c.steady && Math.abs(c.vx - vx) + Math.abs(c.vy - vy) > 1e-3) c.steady = false;
    if (c && !c.steady) return rayTerrain(terrain, px, py, px + vx, py + vy);
    if (!c) {
      const life = Math.max(1, Lifetime.remaining[proj]);
      const t = rayTerrain(terrain, px, py, px + vx * life, py + vy * life);
      c = { born, steady: true, vx, vy, wx: t < 1 ? px + vx * life * t : NaN, wy: t < 1 ? py + vy * life * t : NaN };
      this.shotWalls.set(proj, c);
    }
    if (Number.isNaN(c.wx)) return 1;
    const along = ((c.wx - px) * vx + (c.wy - py) * vy) / (vx * vx + vy * vy || 1);
    return along <= 1 ? Math.max(0, along) : 1;
  }

  /** Shots stuck in rock (mining charges): the rock and where on it, until they blow */
  private stuckShots = new Map<number, { asteroid: number; ox: number; oy: number }>();

  /** A shot's damage lands on an asteroid: it mines, the shot is spent, the rock may break */
  private hurtAsteroid(proj: number, hitAsteroid: number, ownerId: number, damage: number, hitX: number, hitY: number): void {
    const systemId = InSystem.systemId[proj];
    const ax = Position.x[hitAsteroid];
    const ay = Position.y[hitAsteroid];
    Asteroid.hp[hitAsteroid] -= damage;
    // Any weapon mines a little (mining tools far more)
    if (Projectile.miningYield[proj] > 0) {
      const nl = Math.hypot(hitX - ax, hitY - ay) || 1;
      this.mining.extract(hitAsteroid, ownerId, damage, { yield: Projectile.miningYield[proj], hardness: Projectile.miningHardness[proj] },
        hitX, hitY, (hitX - ax) / nl, (hitY - ay) / nl);
    }
    addComponent(this.world, Dead, proj);
    this.pendingRemovedEntities.add(proj);
    this.broadcastProjectileHit(proj, hitX, hitY);

    // Broadcast hit effect at collision point
    this.broadcastToSystem(systemId, {
      type: 'effect',
      effectType: EffectType.LaserHit,
      x: hitX,
      y: hitY,
      entityId: hitAsteroid,
      data: [damage, 30], // damage, hue (default orange)
    });

    // Check if asteroid destroyed
    if (Asteroid.hp[hitAsteroid] <= 0) {
      addComponent(this.world, Dead, hitAsteroid);
      this.pendingRemovedEntities.add(hitAsteroid);

      // Broadcast asteroid break
      this.broadcastToSystem(systemId, {
        type: 'effect',
        effectType: EffectType.AsteroidBreak,
        x: ax,
        y: ay,
        data: [Asteroid.size[hitAsteroid], 30], // size, hue
      });

      this.mining.onBroken(hitAsteroid, ax, ay);
      this.forgetAsteroid(hitAsteroid);
    }
  }

  /** A stuck charge's time is up: it blows, and the rock takes its damage */
  private blowStuck(proj: number): void {
    const st = this.stuckShots.get(proj);
    if (!st) return;
    this.stuckShots.delete(proj);
    if (hasComponent(this.world, Dead, st.asteroid)) return;
    this.placeAsteroid(st.asteroid);
    this.hurtAsteroid(proj, st.asteroid, Projectile.ownerId[proj], Projectile.damage[proj], Position.x[st.asteroid] + st.ox, Position.y[st.asteroid] + st.oy);
  }

  private collisionSystem(): void {
    const projectiles = projectileQuery(this.world);
    // (now and then, forget the shots that are gone)
    if (this.currentTick % 300 === 0 && this.shotWalls.size) {
      const live = new Set(projectiles);
      for (const id of this.shotWalls.keys()) if (!live.has(id)) this.shotWalls.delete(id);
    }
    const players = playerQuery(this.world);
    
    // Projectiles vs ships and asteroids
    for (const proj of projectiles) {
      if (hasComponent(this.world, Dead, proj)) continue;
      // A lobbed shell passes over everything until it comes down
      if (this.weapons.lobbed(proj) || this.weapons.unarmed(proj)) continue;
      // A charge stuck in rock rides it (and hurts nothing else)
      const stuck = this.stuckShots.get(proj);
      if (stuck) {
        if (hasComponent(this.world, Dead, stuck.asteroid)) { this.stuckShots.delete(proj); addComponent(this.world, Dead, proj); this.pendingRemovedEntities.add(proj); continue; }
        this.placeAsteroid(stuck.asteroid);
        Position.x[proj] = Position.x[stuck.asteroid] + stuck.ox;
        Position.y[proj] = Position.y[stuck.asteroid] + stuck.oy;
        continue;
      }
      
      const px = Position.x[proj];
      const py = Position.y[proj];
      const pr = Radius.value[proj];
      const systemId = InSystem.systemId[proj];
      const ownerId = Projectile.ownerId[proj];
      
      // Calculate the ray from current position to next (projectile moves fast)
      const vx = Velocity.x[proj];
      const vy = Velocity.y[proj];
      // A surface's rock: the shot's path this tick ends where it meets it
      // (A ghost round, the Phase Cannon's, flies through rock and asteroids: only ships stop it)
      const ghost = this.weapons.ghost(proj);
      const wall = ghost ? 1 : this.shotWall(proj, systemId, px, py, vx, vy);
      const endX = px + vx * wall;
      const endY = py + vy * wall;
      const speed = Math.sqrt(vx * vx + vy * vy);
      
      // Use spatial grid to find nearby entities
      const nearby = this.spatialGrid.queryRay(systemId, px, py, endX, endY, speed + 100);
      perfMetrics.spatialQueries++;

      // Modular ships take hits on individual parts (railgun slugs pass through some)
      // (a great slow orb, a boss's, hits as wide as it's drawn: a shell's own width is next to nothing)
      const shipHit = this.ships.hitProjectile(proj, ownerId, px, py, endX, endY, nearby, this.weapons.exclusions(proj), pr >= 20 ? pr : 0);
      if (shipHit) {
        if (this.weapons.onShipHit(proj, shipHit)) {
          addComponent(this.world, Dead, proj);
          this.pendingRemovedEntities.add(proj);
        }
        continue;
      }
      // Single-body enemies: only pilots' shots hit them (their own side's pass through)
      if (hasComponent(this.world, Player, ownerId)) {
        const mob = this.mobs.rayHit(systemId, px, py, endX, endY, pr);
        if (mob) {
          const hx = px + (endX - px) * mob.t, hy = py + (endY - py) * mob.t;
          this.mobs.hurt(mob.eid, Projectile.damage[proj]);
          if (this.weapons.onMobHit(proj, hx, hy)) {
            addComponent(this.world, Dead, proj);
            this.pendingRemovedEntities.add(proj);
          }
          continue;
        }
      }
      // Into the rock: it bursts there
      if (wall < 1) {
        this.shotWalls.delete(proj);
        this.weapons.onWallHit(proj, endX, endY);
        addComponent(this.world, Dead, proj);
        this.pendingRemovedEntities.add(proj);
        continue;
      }

      // Check against asteroids using ray-traced collision with spatial grid
      let hitAsteroid: number | null = null;
      let hitX = endX;
      let hitY = endY;
      let bestT = Infinity;
      
      for (const asteroid of ghost ? NO_ROCKS : this.asteroidOrbits.query(systemId, px, py, endX, endY, speed + 100, this.currentTick)) {
        if (hasComponent(this.world, Dead, asteroid) || this.isGas(asteroid)) continue;
        if (InSystem.systemId[asteroid] !== systemId) continue;

        perfMetrics.collisionChecks++;
        this.placeAsteroid(asteroid);

        const ax = Position.x[asteroid];
        const ay = Position.y[asteroid];
        const ar = Asteroid.size[asteroid];
        // Nowhere near its outline (which lies within its size of the centre): no hit, and the shot didn't start inside
        if (!segmentNearCircle(px, py, endX, endY, ax, ay, ar)) continue;
        
        // Get asteroid polygon for precise collision
        const poly = getAsteroidPolygon(asteroid, ax, ay, ar, asteroidSpin(asteroid, this.currentTick));
        
        // Test ray against each edge of polygon
        for (let i = 0; i < poly.length; i++) {
          const p1 = poly[i];
          const p2 = poly[(i + 1) % poly.length];
          const t = segmentIntersectT(px, py, endX, endY, p1.x, p1.y, p2.x, p2.y);
          if (t !== null && t < bestT) {
            bestT = t;
            hitAsteroid = asteroid;
          }
        }
        
        // Also check if bullet started inside asteroid
        if (hitAsteroid !== asteroid && pointInPolygon(px, py, poly)) {
          bestT = 0;
          hitAsteroid = asteroid;
        }
      }
      
      if (hitAsteroid !== null) {
        // Calculate hit position
        hitX = px + vx * bestT;
        hitY = py + vy * bestT;
        // A mining charge sticks to the rock and blows later (lifetimeSystem), where the rock then is
        const stick = this.weapons.stickTicks(proj);
        if (stick > 0) {
          this.placeAsteroid(hitAsteroid);
          this.stuckShots.set(proj, { asteroid: hitAsteroid, ox: hitX - Position.x[hitAsteroid], oy: hitY - Position.y[hitAsteroid] });
          Position.x[proj] = hitX; Position.y[proj] = hitY;
          Velocity.x[proj] = 0; Velocity.y[proj] = 0;
          Lifetime.remaining[proj] = stick;
          continue;
        }
        this.hurtAsteroid(proj, hitAsteroid, ownerId, Projectile.damage[proj], hitX, hitY);
      }
    }

    // Check player deaths
    for (const player of players) {
      if (Health.current[player] <= 0 && !hasComponent(this.world, Dead, player)) {
        addComponent(this.world, Dead, player);

        const systemId = InSystem.systemId[player];
        const pc = this.lingering.get(player)?.conn ?? this.pilots.connOf(player);
        if (pc) this.pilots.onDestroyed(pc, systemId, Position.x[player], Position.y[player], Velocity.x[player], Velocity.y[player], this.deathCause(player));

        this.broadcastToSystem(systemId, {
          type: 'death',
          entityId: player,
          entityType: EntityType.Player,
        });
        
        // Find client and notify
        for (const conn of this.clients.values()) {
          if (conn.playerId === player) {
            this.send(conn.ws, {
              type: 'systemMessage',
              text: 'You have been destroyed! Press R to respawn.',
              color: '#ff4444',
            });
          }
        }
      }
    }
  }

  /** Asteroids whose HP ran out without being handled where they were hit (HP first: a plain read) */
  private asteroidDeathSystem(): void {
    const asteroids = asteroidQuery(this.world);

    for (const eid of asteroids) {
      if (Asteroid.hp[eid] > 0 || hasComponent(this.world, Dead, eid)) continue;
      {
        addComponent(this.world, Dead, eid);
        this.pendingRemovedEntities.add(eid);
        this.placeAsteroid(eid);

        const systemId = InSystem.systemId[eid];
        const x = Position.x[eid];
        const y = Position.y[eid];
        const size = Asteroid.size[eid];
        
        // Notify clients
        this.broadcastToSystem(systemId, {
          type: 'death',
          entityId: eid,
          entityType: EntityType.Asteroid,
        });
        
        // Spawn loot based on size (larger asteroids = better chance)
        this.mining.onBroken(eid, x, y);
        this.forgetAsteroid(eid);
        void size;
      }
    }
  }

  // ============================================
  // DERELICTS
  // ============================================

  /** Entity ids of the civilian freighters flying now */
  getTrafficShips(): { eid: number; route: string[]; leg: number }[] {
    return this.traffic.filter((t) => t.eid >= 0).map((t) => ({ eid: t.eid, route: t.data.route, leg: t.leg }));
  }

  /** A station entity by its data id, in a system */
  private stationEntity(stationId: string, systemNum: number): number {
    const num = this.gameData.getStationNum(stationId);
    for (const st of stationQuery(this.world)) {
      if (Station.stationId[st] === num && InSystem.systemId[st] === systemNum) return st;
    }
    return -1;
  }

  /**
   * Freighters fly their loop of stations: cruise to the next one, hold there
   * a few seconds, move on. A destroyed freighter is replaced at the start of
   * its route two minutes later.
   */
  private trafficSystem(): void {
    for (const slot of this.traffic) {
      if (!this.memory.isResident(slot.systemNum)) continue;
      if (slot.eid >= 0 && !this.ships.has(slot.eid)) {
        slot.eid = -1;
        slot.respawnTick = this.currentTick + TRAFFIC_RESPAWN_TICKS;
      }
      if (slot.eid < 0) {
        if (this.currentTick < slot.respawnTick) continue;
        const bp = this.ships.library.get(slot.data.blueprint);
        const st = this.stationEntity(slot.data.route[0], slot.systemNum);
        if (!bp || st < 0) continue;
        const a = (hashString(slot.data.id) % 628) / 100;
        slot.eid = this.ships.spawnDummy(bp, Position.x[st] + Math.cos(a) * 900, Position.y[st] + Math.sin(a) * 900, a + Math.PI, slot.systemNum);
        slot.leg = 1 % slot.data.route.length;
        slot.dwell = 0;
      }
      // (Distant: its route's planned leg by leg, trafficIntent)
      if (this.ships.isDormant(slot.eid)) continue;
      const st = this.stationEntity(slot.data.route[slot.leg], slot.systemNum);
      if (st < 0) continue;
      const dist = Math.hypot(Position.x[st] - Position.x[slot.eid], Position.y[st] - Position.y[slot.eid]);
      if (dist < TRAFFIC_ARRIVE_RADIUS + 200) {
        if (++slot.dwell > TRAFFIC_DWELL_TICKS) {
          slot.leg = (slot.leg + 1) % slot.data.route.length;
          slot.dwell = 0;
        }
      }
      this.ships.setAutopilot(slot.eid, { x: Position.x[st], y: Position.y[st], arriveRadius: TRAFFIC_ARRIVE_RADIUS });
    }
  }

  /**
   * A distant freighter's next leg (ships/SimLod.ts), as trafficSystem flies a
   * live one: on to its next station, holding there a while first; re-aimed
   * now and then (stations go round). undefined: not a freighter.
   */
  private trafficIntent(eid: number, at: Plan): Intent | undefined {
    const slot = this.traffic.find((t) => t.eid === eid);
    if (!slot) return undefined;
    let st = this.stationEntity(slot.data.route[slot.leg], slot.systemNum);
    if (st >= 0 && Math.hypot(Position.x[st] - at.x, Position.y[st] - at.y) < TRAFFIC_ARRIVE_RADIUS + 200) {
      const left = TRAFFIC_DWELL_TICKS - slot.dwell;
      if (left > 0) { slot.dwell = TRAFFIC_DWELL_TICKS; return { kind: 'hold', until: at.tick + left }; }
      slot.leg = (slot.leg + 1) % slot.data.route.length;
      slot.dwell = 0;
      st = this.stationEntity(slot.data.route[slot.leg], slot.systemNum);
    }
    if (st < 0) return { kind: 'hold' };
    return { kind: 'goto', x: Position.x[st], y: Position.y[st], arrive: TRAFFIC_ARRIVE_RADIUS, until: at.tick + 60 * 30 };
  }

  /**
   * What SystemMemory puts away and brings back of a system: its packs and
   * bosses (Enemies, Bosses), its freighters and derelicts (here)
   */
  private createMemoryHost(): MemoryHost {
    const where = (eid: number) => this.lod.where(eid);
    const pose = (m: ShipMemory): FarPose => ({ x: m.x, y: m.y, vx: m.vx, vy: m.vy, angle: m.a, angVel: m.av ?? 0 });
    return {
      tick: () => this.currentTick,
      now: () => this.clock(),
      // The world's own systems (an arena's copies, surfaces and pilots' stations look after their own)
      systems: () => this.gameData.getAllSystems().filter((s) => !s.private && !s.surface && !s.instance).map((s) => ({ num: this.gameData.getSystemNum(s.id), id: s.id })),
      occupied: () => {
        const out = new Set<number>();
        for (const c of this.clients.values()) out.add(InSystem.systemId[c.playerId]);
        for (const l of this.lingering.keys()) out.add(InSystem.systemId[l]);
        return out;
      },
      // Pilots at a gate's or a rift's mouth: where it goes is brought back before they're through
      approaching: () => {
        const out = new Set<number>();
        for (const c of this.clients.values()) {
          const p = c.playerId;
          if (!this.flying(p)) continue;
          for (const g of portalQuery(this.world)) {
            if (InSystem.systemId[g] !== InSystem.systemId[p]) continue;
            if (Math.hypot(Position.x[g] - Position.x[p], Position.y[g] - Position.y[p]) < Radius.value[g] + MEMORY_GATE_MOUTH) out.add(Portal.targetSystem[g]);
          }
        }
        return out;
      },
      capture: (num, offset, evict) => {
        const now = this.currentTick;
        const ship = (eid: number) => shipMemory(this.ships.get(eid)!, where(eid));
        const due = (t: number) => (t > now ? { respawnAt: t + offset } : {});
        const snap = {
          packs: this.enemies.capture(num, where, offset, evict),
          bosses: this.bosses.capture(num, where, evict),
          traffic: this.traffic.filter((t) => t.systemNum === num).map((t) => ({ id: t.data.id, leg: t.leg, dwell: t.dwell, ...(t.eid >= 0 && this.ships.has(t.eid) ? { ship: ship(t.eid) } : due(t.respawnTick)) })),
          derelicts: this.derelicts.filter((d) => d.systemNum === num).map((d) => ({ id: d.data.id, spawns: d.spawns, ...(d.eid >= 0 && this.ships.has(d.eid) ? { ship: ship(d.eid) } : due(d.respawnTick)) })),
        };
        if (evict) {
          for (const t of this.traffic) if (t.systemNum === num && t.eid >= 0) { if (this.ships.has(t.eid)) this.ships.removeShip(t.eid); t.eid = -1; }
          for (const d of this.derelicts) if (d.systemNum === num && d.eid >= 0) { if (this.ships.has(d.eid)) this.ships.removeShip(d.eid); d.eid = -1; d.respawnTick = 0; }
        }
        return snap;
      },
      restore: (num, snap, offset, mend, from) => {
        // Each straight to sleep, flown on from when it was left (a pilot near wakes it as ever)
        const adopt = (eid: number, at: FarPose) => { if (this.ships.sleep(eid, { damaged: 0, fired: 0 })) this.lod.adopt(eid, from, at); };
        const local = (t?: number) => (t === undefined ? this.currentTick : t - offset);
        this.enemies.restore(num, snap.packs ?? [], offset, mend.ships, adopt);
        this.bosses.restore(num, snap.bosses ?? [], mend.bosses, adopt);
        for (const m of snap.traffic ?? []) {
          const slot = this.traffic.find((t) => t.systemNum === num && t.data.id === m.id);
          if (!slot || slot.eid >= 0) continue;
          slot.leg = m.leg % slot.data.route.length;
          slot.dwell = m.dwell;
          const bp = this.ships.library.get(slot.data.blueprint);
          if (!m.ship || !bp) { slot.respawnTick = local(m.respawnAt); continue; }
          slot.eid = this.ships.spawnDummy(bp, m.ship.x, m.ship.y, m.ship.a, num);
          Velocity.x[slot.eid] = m.ship.vx; Velocity.y[slot.eid] = m.ship.vy;
          restoreHp(this.ships, slot.eid, m.ship.hp, mend.ships);
          adopt(slot.eid, pose(m.ship));
        }
        for (const m of snap.derelicts ?? []) {
          const slot = this.derelicts.find((d) => d.systemNum === num && d.data.id === m.id);
          if (!slot || slot.eid >= 0) continue;
          if (!m.ship) { slot.spawns = m.spawns; slot.respawnTick = local(m.respawnAt); continue; }
          // The same hulk (its seeded look), where it had drifted, as broken as it was (wrecks don't mend)
          slot.spawns = Math.max(0, m.spawns - 1);
          this.derelictsMod.spawnDerelict(slot);
          if (slot.eid < 0) continue;
          this.ships.teleport(slot.eid, m.ship.x, m.ship.y);
          Rotation.angle[slot.eid] = m.ship.a;
          restoreHp(this.ships, slot.eid, m.ship.hp, 0);
          adopt(slot.eid, pose(m.ship));
        }
      },
      timers: (offset) => ({ enemies: this.enemies.timers(offset), bosses: this.bosses.timers(offset) }),
      setTimers: (t, offset) => { this.enemies.setTimers(t.enemies ?? {}, offset); this.bosses.setTimers(t.bosses ?? {}, offset); },
    };
  }

  /** What each system's (and siege moon's) hostiles are rated, for the maps and the HUD (worked out once: the data doesn't change) */
  private threatCache: Record<string, number> | null = null;
  private regionThreatCache: Record<string, Record<string, number>> | null = null;
  /** Each system's threat (ratings.ts scale): for one with danger bands, its innermost band's, where you come in */
  threats(): Record<string, number> {
    if (this.threatCache) return this.threatCache;
    const out: Record<string, number> = {};
    for (const sys of this.gameData.getAllSystems()) {
      const bands = this.regionThreats()[sys.id];
      const r = sys.surface?.bastion ? this.sieges.threat(sys) : bands ? bands[sys.regions![0].id] : this.enemies.systemRating(sys.id);
      if (r > 0) out[sys.id] = Math.round(r);
    }
    return (this.threatCache = out);
  }

  /** The threat in each danger band of the systems that have them (system id -> region id -> threat) */
  regionThreats(): Record<string, Record<string, number>> {
    if (this.regionThreatCache) return this.regionThreatCache;
    const out: Record<string, Record<string, number>> = {};
    for (const sys of this.gameData.getAllSystems()) {
      if (!sys.regions?.length) continue;
      const bands: Record<string, number> = {};
      let inner = 0, last = 0;
      for (const g of sys.regions) {
        const r = Math.round(this.enemies.systemRating(sys.id, { inner, outer: g.outer }));
        // (A band with nothing rated of its own is at least as bad as the one inside it)
        bands[g.id] = Math.max(r, g.danger === 'safe' ? 0 : last);
        last = bands[g.id];
        inner = g.outer;
      }
      out[sys.id] = bands;
    }
    return (this.regionThreatCache = out);
  }

  /** Pilots with a training drone out (the tutorial's combat lesson): pilot entity -> drone */
  readonly trainers = new Map<number, number>();

  /** What killed a pilot, for telemetry: the last ship to hit them (an enemy's type and faction, or a pilot), the region, their rating */
  private deathCause(player: number): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const sys = this.gameData.getSystemByNum(InSystem.systemId[player]);
    const region = regionAt(sys, Position.x[player], Position.y[player]);
    if (region) out.region = region.id;
    const ship = this.ships.get(player);
    if (ship) out.rating = Math.round(rateShip(this.ships.catalog, this.ships.tuning, ship).rating);
    const h = this.ships.lastHitter(player);
    const foe = h >= 0 ? this.enemies.info(h) : null;
    if (foe) { out.by = foe.name; out.faction = foe.faction; if (foe.boss) out.boss = foe.boss; }
    else if (h >= 0 && this.pilots.connOf(h)) out.by = 'pilot';
    else out.by = 'other';
    return out;
  }

  /** Names (and kinds) of pilotless ships that have one: 1 = derelict, 2 = traffic, 3 = hostile */
  private namedBody(eid: number): { name: string; kind: number } | undefined {
    const foe = this.enemies.info(eid);
    if (foe) return { name: foe.name, kind: 3 };
    const ward = this.wards.get(eid) ?? this.personCraft.get(eid);
    if (ward) return { name: ward, kind: 2 };
    const d = this.derelicts.find((x) => x.eid === eid);
    if (d) return { name: d.data.name, kind: 1 };
    const t = this.traffic.find((x) => x.eid === eid);
    if (t) return { name: t.data.name, kind: 2 };
    return undefined;
  }

  private lifetimeSystem(): void {
    const entities = lifetimeQuery(this.world);
    
    for (const eid of entities) {
      Lifetime.remaining[eid]--;
      
      if (Lifetime.remaining[eid] <= 0) {
        if (hasComponent(this.world, Projectile, eid)) { this.blowStuck(eid); this.weapons.onExpire(eid); }
        addComponent(this.world, Dead, eid);
        // Track for removal notification to clients
        this.pendingRemovedEntities.add(eid);
      }
    }
    
}

  private cleanupSystem(): void {
    const dead = deadQuery(this.world);
    
    for (const eid of dead) {
      // Ensure all dead entities are in the removed set (safety net)
      this.pendingRemovedEntities.add(eid);
      // (What was kept by this entity's id goes with it: a left player's last snapshot states, its rift cooldown)
      this.lastEntityStates.delete(eid);
      this.riftCooldown.delete(eid);
      removeEntity(this.world, eid);
    }
  }

  // ============================================
  // NETWORKING
  // ============================================

  /**
   * Outgoing messages (net/snapshot/Outbox.ts): each client's outbox, the effects that can wait (lazy), the byte
   * counters and the broadcasts. These forward to it, so modules' hosts and tests call them as before.
   */
  send(ws: ClientSocket, msg: ServerMessage): void {
    this.net.send(ws, msg);
  }

  /** Send everything waiting: one frame per client (net/snapshot/Outbox.ts) */
  flushOutbox(): void {
    this.net.flushOutbox();
  }

  /** Send the effects still waiting now (tests that look at a tick's messages straight after it) */
  flushLazy(): void {
    this.net.flushLazy();
  }

  broadcastToSystem(systemId: number, msg: ServerMessage): void {
    this.net.broadcastToSystem(systemId, msg);
  }

  private broadcastProjectileHit(proj: number, x: number, y: number): void {
    this.net.broadcastProjectileHit(proj, x, y);
  }

  /** A snapshot to every client, then the map's dots (net/SnapshotBuilder.ts; netBench and tests wrap this name) */
  private sendSnapshots(): void {
    // (The damage summed since the last one goes first, to ride the same frame)
    this.net.flushDamage();
    this.snapshots.sendSnapshots();
  }

  /** Clients in a system near a point (net/snapshot/Outbox.ts) */
  private broadcastNear(systemId: number, x: number, y: number, msg: ServerMessage, also?: number[]): void {
    this.net.broadcastNear(systemId, x, y, msg, also);
  }

  /** HUD numbers and the system visuals (net/SnapshotBuilder.ts) */
  private sendPlayerState(conn: ClientConnection): void {
    this.snapshots.sendPlayerState(conn);
  }

  /** A system's rock (a surface's terrain), or undefined */
  terrainOf(num: number): Terrain | undefined {
    const id = this.gameData.getSystemByNum(num)?.id;
    return id ? this.gameData.terrain(id) : undefined;
  }

  /**
   * What replicas and the jump drive's fields need of a system (built once each:
   * none of it changes). The empty scene has no lodestones (systemInfo sends none).
   */
  private replicaEnv(num: number): ReplicaEnv {
    let env = this.replicaEnvs.get(num);
    if (!env) {
      const sys = this.gameData.getSystemByNum(num);
      const cb = sys?.centralBody;
      this.replicaEnvs.set(num, (env = { gravity: cb?.gravity ?? null, central: cb ?? null, terrain: this.terrainOf(num) ?? null,
        ...(this.scene !== 'empty' && sys?.lodestones?.length ? { lodestones: sys.lodestones } : {}),
        ...(sys?.hazardRatings ? { hazard: (d: ShipDerived, x: number, y: number) => hazardFlight(this.gameData.hazardRules, sys, d, x, y) } : {}) }));
    }
    return env;
  }


  // ============================================
  // ADMIN SERVER INTEGRATION
  // ============================================
  
  private setupAdminHandlers(): void {
    if (!this.adminServer) return;
    
    this.adminServer.onEvent((event, data) => {
      switch (event) {
        case 'configChange':
          // Config changes are handled by reading from adminServer.getConfig()
          console.log('🔧 Config updated via admin panel');
          break;
          
        case 'reload':
          // Hot reload data files
          console.log('🔧 Hot reloading data files...');
          // Could re-initialize GameData here
          break;
          
        case 'killAll':
          // Kill all enemies in specified system
          this.adminKillAllEnemies(data?.systemId);
          break;
          
        case 'teleportPlayer':
          // Teleport a player
          this.adminTeleportPlayer(data.playerId, data.x, data.y, data.systemId);
          break;
      }
    });
  }
  
  private adminKillAllEnemies(systemId?: string): void {
    const systemNum = systemId ? this.gameData.getSystemNum(systemId) : -1;
    let killed = 0;
    for (const eid of [...this.ships.bodies.keys()]) {
      if (!this.enemies.info(eid) || (systemNum >= 0 && InSystem.systemId[eid] !== systemNum)) continue;
      this.ships.removeShip(eid);
      killed++;
    }
    console.log(`🔧 Admin: Removed ${killed} hostiles`);
  }
  
  private adminTeleportPlayer(playerId: number, x: number, y: number, systemId?: string): void {
    if (!hasComponent(this.world, Player, playerId)) {
      console.log(`🔧 Admin: Player ${playerId} not found`);
      return;
    }
    
    // Connected players go through the normal travel path (system info, entity resend)
    const conn = [...this.clients.values()].find((c) => c.playerId === playerId);
    if (conn) {
      const systemNum = systemId ? this.gameData.getSystemNum(systemId) : InSystem.systemId[playerId];
      this.travelTo(conn, systemNum, x, y, false);
      console.log(`🔧 Admin: Teleported player ${playerId} to (${x}, ${y})`);
      return;
    }
    
    Position.x[playerId] = x;
    Position.y[playerId] = y;
    Velocity.x[playerId] = 0;
    Velocity.y[playerId] = 0;
    
    if (systemId) {
      const systemNum = this.gameData.getSystemNum(systemId);
      InSystem.systemId[playerId] = systemNum;
    }
    
    console.log(`🔧 Admin: Teleported player ${playerId} to (${x}, ${y})`);
  }
  
  /**
   * Handle HTTP auth requests (register, login, validate)
   */
  /**
   * Report stats to admin server (call from game loop)
   */
  private reportAdminStats(tickTime: number): void {
    // Track tick time history
    this.tickTimeHistory.push(tickTime);
    if (this.tickTimeHistory.length > 120) this.tickTimeHistory.shift();
    
    // Count entities
    let entityCount = 0;
    entityCount += playerQuery(this.world).length;
    entityCount += projectileQuery(this.world).length;
    entityCount += asteroidQuery(this.world).length;
    
    this.adminServer?.updateStats({
      tick: this.currentTick,
      playerCount: this.clients.size,
      entityCount,
      tickTime,
    });
    
    // Send detailed admin stats to admin clients every ~60 ticks (~1 second)
    if (this.currentTick % 60 === 0) {
      const avgTickTime = this.tickTimeHistory.length > 0
        ? this.tickTimeHistory.reduce((a, b) => a + b, 0) / this.tickTimeHistory.length
        : 0;
      const maxTickTime = this.tickTimeHistory.length > 0
        ? Math.max(...this.tickTimeHistory)
        : 0;
      // (The proto build runs this server in the browser: no process there)
      const proc = typeof process !== 'undefined' ? process : null;
      const mem = proc?.memoryUsage() ?? { heapUsed: 0 };
      
      const admins = [...this.clients.values()].filter((c) => c.isAdmin && c.ws.isOpen());
      const adminStatsMsg = admins.length > 0 && {
        type: 'adminStats' as const,
        tick: this.currentTick,
        playerCount: this.clients.size,
        entityCount,
        tickTimeMs: tickTime,
        avgTickTimeMs: Math.round(avgTickTime * 100) / 100,
        maxTickTimeMs: Math.round(maxTickTime * 100) / 100,
        memoryMb: Math.round(mem.heapUsed / 1024 / 1024 * 10) / 10,
        uptime: proc?.uptime() ?? 0,
        snapshotBytes: this.net.snapshotBytesSent,
        bytesByType: { ...this.net.bytesByType },
        connectionsTotal: this.totalConnectionsEver,
        errors: this.recentErrors.slice(-10),
        playerList: this.admin.players(),
      };
      
      // Send to all admin clients
      if (adminStatsMsg) for (const c of admins) this.send(c.ws, adminStatsMsg as any);
      
      // Reset byte counters
      this.net.snapshotBytesSent = 0;
      this.net.bytesByType = {};
    }
  }
  
  /**
   * Get current player count (for server browser registration)
   */
  /**
   * How the game's running, for the box's resource monitor (index.ts writes it to data/status/live.json; deploy/vps/monitor
   * reads it): its ticks (the slowest since last asked), and what's in the world. Nothing about who's playing.
   */
  liveStatus(): { tickAvgMs: number; tickLastMs: number; tickMaxMs: number; players: number; ships: number; projectiles: number; entities: number } {
    const s = {
      tickAvgMs: +perfMetrics.avgTickMs.toFixed(3), tickLastMs: +perfMetrics.lastTickMs.toFixed(3), tickMaxMs: +perfMetrics.windowMaxMs.toFixed(3),
      players: this.getPlayerCount(), ships: this.ships.bodies.size, projectiles: projectileQuery(this.world).length, entities: getAllEntities(this.world).length,
    };
    perfMetrics.windowMaxMs = 0;
    return s;
  }

  getPlayerCount(): number {
    return this.clients.size;
  }
}
