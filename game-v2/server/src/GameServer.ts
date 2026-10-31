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
} from '@space-game/common';

import {
  ClientMessage,
  ServerMessage,
  EntityState,
  EntityType,
  encodeServerMessage,
  serverFrame,
  unwrapTick16,
  ServerAsteroidSeedMessage,
  EffectType,
  computeStateHash,
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
  PROTOCOL_MISMATCH_CLOSE,
  PROTOCOL_MISMATCH_REASON,
  segmentNearCircle,
  segmentIntersectT,
  pointInPolygon,
  hashString,
  mulberry32,
  // Shared physics for exact client/server parity
// Data types
  StarSystemData,
  DerelictData,
  TrafficData,
  RiftData,
} from '@space-game/common';

import { GameData } from './data/GameData.js';
import type { UserStore } from './auth/types.js';
import type { ClientSocket, ClientLink } from '@space-game/common';
import type { ShipBridge, ShipHost } from './ships/ShipBridge.js';
import { Blueprint, ShipState, parseBlueprint, quantizeShipValue, skillValue, hasAll, removeAll, Economy, Bag, StarterKit, jumpTuning, jumpPhase, partItemId, rateShip, ratingOf, createShipState, gradeReward, gradeOf, accrueTraces, releaseTraces, unlocks, isStructural, stationPerks, hazardFlight, stationTable, blueprintGrade, lookFn, fixModelMaterials, warmthPercent, packCharge, nearerThan, fartherThan, stationReachMax, type ShipDerived } from '@space-game/common';

/** A station site by id */
const stationPerksSite = (id: string | undefined) => (id ? stationTable()?.sites.find((s) => s.id === id) : undefined);
import { Pilots, PilotHost, type PilotConn } from './game/Pilots.js';
import { Ammo } from './game/Ammo.js';
import { Hazards } from './game/Hazards.js';
import { Warmth } from './game/Warmth.js';
import { Outpost } from './game/Outpost.js';
import { HomeStations } from './game/HomeStations.js';
import { LootPods, PodHost } from './game/LootPods.js';
import { Towing, type TowKind } from './game/Towing.js';
import { towTuning } from '@space-game/common';
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
import { Support } from './game/Support.js';
import { Trade } from './game/Trade.js';
import { Operations } from './game/Operations.js';
import { Market } from './game/Market.js';
import { Replication } from './net/Replication.js';
import { SimLod, type Plan, type Intent, type FarPose } from './ships/SimLod.js';
import { SystemMemory, shipMemory, restoreHp, type WorldStore, type MemoryHost, type ShipMemory } from './game/SystemMemory.js';
import { Achievements } from './game/Achievements.js';
import { huntedBoss, RibbonsFile, mineFalloff, rayTerrain, type Terrain } from '@space-game/common';
import { repRank, replicaAngle, quantizeReplicaAngle, ReplicaMode } from '@space-game/common';
import { MemoryProfileStore, type ProfileStore } from './profile/ProfileStore.js';
import { MessageLimiter } from './net/MessageLimits.js';

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

const playerQuery = defineQuery([Player, Position, Velocity, Rotation, Input, Health, Boost]);
const projectileQuery = defineQuery([Projectile, Position, Velocity, Lifetime]);
const bulletQuery = defineQuery([Bullet, Position, Velocity]);
const miningProjectileQuery = defineQuery([MiningShot, Position, Velocity, Projectile]);
const asteroidQuery = defineQuery([Asteroid, Position]);

/** Messages a connection may send before it has joined */
const PRE_JOIN = new Set(['join', 'ping', 'authLogin', 'authRegister']);
/** Input flood guards: per tick, how far ahead one may be scheduled, and how many may wait */
const MAX_INPUTS_PER_TICK = 16;
const MAX_INPUT_LEAD = 64;
const MAX_SCHEDULED_INPUTS = 32;
/** A client's game loop silent this long (3 s) lets go of its controls */
const INPUT_TIMEOUT_TICKS = 180;
const droppedItemQuery = defineQuery([DroppedItem, Position, Velocity, Lifetime]);
const stationQuery = defineQuery([Station, Position]);
const portalQuery = defineQuery([Portal, Position]);
const lifetimeQuery = defineQuery([Lifetime]);
const deadQuery = defineQuery([Dead]);

/** Fly within this distance of a rift's centre to be pulled through */
const RIFT_TRIGGER_RADIUS = 200;
const RIFT_COOLDOWN_TICKS = 180;
/** Freighters: replacement delay, how close counts as arrived, how long they stay */
const TRAFFIC_RESPAWN_TICKS = 60 * 120;
const TRAFFIC_ARRIVE_RADIUS = 700;
const TRAFFIC_DWELL_TICKS = 60 * 6;
/** A destroyed derelict is replaced after this long */
const DERELICT_RESPAWN_TICKS = 60 * 60 * 5;
/** A broken derelict gives this share of the plate and wire its structure was built from */
const DERELICT_PLATE_SHARE = 0.15;
/** A derelict's log (systems.json `log`) is read by flying this close (a scan step's 700 is inside it) */
const DERELICT_LOG_RANGE = 900;

// Enter/exit queries for tracking removed entities
const playerEnter = enterQuery(playerQuery);
const playerExit = exitQuery(playerQuery);
const deadEnter = enterQuery(deadQuery);

// ============================================
// CLIENT CONNECTION
// ============================================

interface ClientConnection {
  ws: ClientSocket;
  /** The player's address as the transport saw it (passed on to the lobby with a sign-in, for its attempt limits) */
  address?: string;
  playerId: number;  // Entity ID
  lastInputSeq: number;
  lastPingTime: number;
  ping: number;
  username: string;  // Player display name
  userId: number | null;  // DB user ID (null for guests)
  isAdmin: boolean;
  /** Contributor rank (ContributorNotes: the notes tools; admins have them anyway) */
  isContributor: boolean;
  authToken: string | null;
  knownEntities: Set<number>;   // Entity IDs already sent one-time to this client (asteroids, stations, portals, NPCs)
  lastSystemId: number;         // Last system ID — clear knownEntities on change
  /** Last system id for which systemInfo was sent (string id) */
  lastSystemInfoId: string | null;
  /** Per-player scheduled input buffer. Inputs held until targetTick <= currentTick. */
  scheduledInputs: Array<{ targetTick: number; msg: any }>;
  /** Sent `join` (nothing but join, ping and sign-in is handled before) */
  joined: boolean;
  /** Inputs queued this tick (a flood beyond MAX_INPUTS_PER_TICK is dropped) */
  inputsThisTick: number;
  /** The last tick its game loop was heard from (an input or a state hash) */
  liveTick: number;
  /** It sends state hashes (a real client's game loop): the input timeout applies */
  hashSeen: boolean;
  forceSnapshot: boolean;
  lastSnapshotSentTick: number;
  /** The ship this player built in the hangar (null = starter) */
  blueprint: Blueprint | null;
  /** Berthed at a station (hangar open): the ship rides along at this offset */
  /** Berthed in a station: held at its centre (ox, oy: 0), and put back out at `exit` (where it came in) when it leaves */
  docked: { station: number; ox: number; oy: number; exit?: { x: number; y: number } } | null;
  /**
   * Ship bodies this client has been synced to: entity id → the ship state and rebuild count sent, and the snapshot
   * its HP was last brought up to date at (`hpAt`: skip it while the ship's HP hasn't changed since)
   */
  shipSynced: Map<number, { ship: ShipState; rebuilds: number; hpAt?: number }>;
  /** Last part HP sent to this client, per ship body */
  shipHpSent: Map<number, number[]>;
  /** Entity names this client has been sent (names go once) */
  sentNames: Map<number, string>;
  /** Ship keyframe versions this client has (replication) */
  repKnown: Map<number, number>;
  /** Ships in this client's view (the rest of the system's ships cost it nothing) */
  shipView: Set<number>;
  /** Ships out of view it's been told the names of, for the map (mapDots) */
  mapNamed: Set<number>;
  /** The map's dots as it has them (each one's leg as sent, from when; its route's leg count; its look), and whether the next list is a fresh one */
  mapSent?: Map<number, { leg: Leg; tick: number; seq: number; look: number }>;
  mapFresh?: boolean;
  /** Its system map is open (mapView), and it's owed a list now (just opened) */
  mapOpen?: boolean;
  mapDotsDue?: boolean;
  /** State hashes the client sent for ticks we hadn't reached yet (it predicts ahead): tick → hash */
  aheadHashes: Map<number, number>;
  /** Ship designs (blueprint hashes) this client has been sent: another ship of one is sent by its hash */
  designs: Set<string>;
  /** The last HUD numbers sent (they only go when they change) */
  playerStateKey: string;
  /**
   * Its own ship: the client predicts it from its inputs, so it's only sent when
   * that prediction would be wrong (or as a slow safety net). An input applied
   * later than its target tick makes it wrong...
   */
  selfLate: boolean;
  /** ...as does anything that moves the ship besides its inputs (a new keyframe version), or a status change */
  selfVersion: number;
  selfKey: string;
  selfSentTick: number;
  /** Hash of its ship's state at each recent tick (the client checks its prediction against these) */
  selfHashes: Map<number, number>;
}

/** One entity's snapshot state, built once per system per snapshot */
interface SnapRow {
  id: number;
  kind: 'player' | 'ship' | 'projectile' | 'pod' | 'mob';
  x: number;
  y: number;
  /** Without its name (names go separately, once) */
  state: EntityState;
  name?: string;
  /** What decides "changed since the last snapshot" */
  key: string;
  /** Players: the row other pilots get (status only: their motion is replicated) */
  other?: { state: EntityState; key: string };
}

/** A pilot's own ship is resent at least this often, even when its prediction is spot on */
const SELF_SAFETY_TICKS = 120;
/** Projectiles and loot further than this aren't sent at all */
const SNAP_PROJECTILE_RANGE = 12000;
const SNAP_POD_RANGE = 3000;
/**
 * A client's view of the ships: those within SHIP_VIEW_IN come into it, and leave
 * past SHIP_VIEW_OUT (the gap stops one at the edge flickering in and out). Both
 * are well past the furthest flight zoom (about 24 km across half a 1080p screen).
 * Party members and your target are always in view.
 */
const SHIP_VIEW_IN = 40000;
const SHIP_VIEW_OUT = 48000;
/** Ships past the view go to the system map this often (ticks) */
const MAP_DOTS_TICKS = 60;
/** A pilot this close past a gate's or rift's edge has where it goes brought back (SystemMemory), before they're through */
const MEMORY_GATE_MOUTH = 3000;
/** Messages that can wait for the next frame (see GameServer.lazy), and for how many ticks at most */
const LAZY_TYPES = new Set(['damage', 'projectileHit', 'partDestroyed', 'contact', 'detonation', 'ignite', 'stationFire']);
const LAZY_TICKS = 2;

/** Combat effects (hits, damage numbers, parts blown off) only go to clients this near them */
const FX_RANGE = SHIP_VIEW_OUT;

/** A blueprint's hash (designs are sent once per client; see ServerShipSyncMessage.design) */
function designHash(bp: unknown): string {
  const s = JSON.stringify(bp);
  let a = 0x811c9dc5, b = 0x01000193 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995) ^ (b >>> 15);
  }
  return (a >>> 0).toString(36) + (b >>> 0).toString(36);
}

/** Part HP on the wire: to a tenth, never rounded down to nothing */
function hpWire(h: number): number {
  return h <= 0 ? 0 : Math.max(0.1, Math.round(h * 10) / 10);
}

/** Entities removed this tick and the system each was in (so only clients there are told) */
class RemovalSet extends Map<number, number> {
  add(eid: number): this {
    this.set(eid, InSystem.systemId[eid]);
    return this;
  }
}

/** Convert a hex color (#RRGGBB) to hue 0-360 */
function hexToHue(hex: string): number {
  const val = hex.startsWith('#') ? hex.slice(1) : hex;
  const rgb = parseInt(val, 16);
  if (isNaN(rgb)) return 40;
  const r = ((rgb >> 16) & 0xff) / 255;
  const g = ((rgb >> 8) & 0xff) / 255;
  const b = (rgb & 0xff) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return Math.round(h * 60);
}

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
  /** Admins may switch on free build (any part in the hangar, nothing taken): the dev server only. Refused outright under NODE_ENV=production. */
  freeBuild?: boolean;
  /** Where pilots' deaths and milestones are written (Telemetry.ts); none: not recorded */
  telemetry?: TelemetryWriter;
  /** Where contributor notes and ranks are kept (contribFileStore: data/contributor); none: in memory */
  contributorStore?: ContribStore;
  /** Where the world's memory is kept between restarts (worldFileStore: data/world/memory.json); none: in memory only */
  worldStore?: WorldStore;
}

/** A player who quits within this long of taking damage leaves their ship in space... */
/** What a job or a hangar order can be told to do */
const ORDER_ACTIONS = new Set(['pause', 'resume', 'cancel', 'top'] as const);
const LINGER_COMBAT_TICKS = 60 * 15;
/** ...for this long */
const LINGER_TICKS = 60 * 20;

// setImmediate is Node-only; fall back to setTimeout when running in a browser (proto mode).
const scheduleImmediate: (fn: () => void) => unknown =
  typeof setImmediate === 'function' ? setImmediate : (fn) => setTimeout(fn, 0);

export class GameServer {
  private world: IWorld;
  private gameData: GameData;
  private clients: Map<ClientSocket, ClientConnection> = new Map();
  private scene: 'sectors' | 'empty';
  private everyoneAdmin: boolean;
  private guestAdmin: boolean;
  /** Admins may build for free in the hangar (AdminTools `freebuild`) */
  private freeBuildAllowed: boolean;
  private paused = false;
  /** Tick until which each player ignores rifts (no instant bounce-back) */
  private riftCooldown = new Map<number, number>();
  private ships: ShipBridge;
  private shipEditAnywhere: boolean;

  private devTeleport: boolean;
  private clientIdCounter = 1;
  
  private currentTick = 0;
  private lastTickTime = 0;
  private tickAccumulator = 0;
  
  private lastSnapshotTick = 0;
  
  // Input queue — messages arrive instantly between ticks, get applied at tick boundaries
  private inputQueue: Array<{ conn: ClientConnection; msg: any }> = [];
  
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
  private derelicts: { data: DerelictData; systemNum: number; eid: number; respawnTick: number; spawns: number }[] = [];
  /** Freighters: which station they're bound for, and how long they've been docked there */
  private traffic: { data: TrafficData; systemNum: number; eid: number; leg: number; dwell: number; respawnTick: number }[] = [];
  
  // NPC ID mapping (npcId number -> npc string id)
  
  
  /** Items, recipes and part costs (shared with the client) */
  readonly econ: Economy;
  /** Each player's progress: profile, cargo, storage, saving */
  readonly pilots: Pilots;
  private pods: LootPods;
  /** Tow Beams (game/Towing.ts) */
  private towing!: Towing;
  private mining: Mining;
  private services: StationServices;
  private ammo!: Ammo;
  private hazards!: Hazards;
  private warmth!: Warmth;
  private outpost?: Outpost;
  private homes!: HomeStations;
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
  /** Who's been mending whom (Repair Beams): support counts towards kills' and bosses' rewards (game/Support.ts) */
  readonly support = new Support();
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
  /** People's ships, parked where they live (people.json craft): untouchable, by name */
  private personCraft = new Map<number, string>();
  private clock: () => number;
  /** Disconnected mid-fight: the ship stays in space until this tick */
  private lingering = new Map<number, { conn: ClientConnection; until: number }>();

  // Admin server for dev tools
  private adminServer: AdminServer | null = null;
  
  // User database for auth
  private userDB: UserStore;
  
  // Error tracking for admin stats
  private recentErrors: string[] = [];
  private static readonly MAX_ERRORS = 50;
  private tickTimeHistory: number[] = [];
  private snapshotBytesSent = 0;
  private bytesByType: Record<string, number> = {};
  private totalConnectionsEver = 0;
  
  // Scheduled game loop callback (setTimeout or setImmediate handle)
  private gameLoopTimer: unknown = null;

  constructor(opts: GameServerOptions) {
    this.world = createWorld();
    this.gameData = opts.gameData;
    this.adminServer = opts.adminServer || null;
    this.userDB = opts.userDB;
    this.scene = opts.scene ?? 'sectors';
    this.everyoneAdmin = opts.everyoneAdmin ?? false;
    // (never on a production server, whatever it was started with)
    this.guestAdmin = !!opts.guestAdmin && process.env.NODE_ENV !== 'production';
    this.freeBuildAllowed = !!opts.freeBuild && process.env.NODE_ENV !== 'production';
    this.ships = opts.ships;
    this.ships.attach(this.createShipHost());
    this.shipEditAnywhere = opts.shipEditAnywhere ?? false;
    this.econ = new Economy(this.gameData.itemsFile, this.gameData.recipesFile, this.ships.catalog, Object.fromEntries(this.ships.library));
    this.pods = new LootPods(this.createPodHost(), this.econ.items);
    // ---- Tow Beam (game/Towing.ts)
    this.towing = new Towing({
      world: this.world,
      getTick: () => this.currentTick,
      tell: (pilot, text, color) => { for (const c of this.clients.values()) if (c.playerId === pilot) this.send(c.ws, { type: 'systemMessage', text, color }); },
      stationInRange: (pilot) => this.stationInRange(pilot),
      isDocked: (pilot) => this.dockedShips.has(pilot),
      deliver: (pilot, target, kind) => this.towDelivered(pilot, target, kind),
    }, this.ships, this.pods, this.ships.tuning);
    // ---- (end Tow Beam)
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
    this.batching++;
    try {
      this.guard('inputs', () => this.drainInputQueue());
      this.tick();
      if (this.currentTick - this.lastSnapshotTick >= TICK_RATE / SNAPSHOT_RATE) {
        this.lastSnapshotTick = this.currentTick;
        this.guard('snapshots', () => this.sendSnapshots());
      }
    } finally {
      this.batching--;
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
        if (this.gameData.getSystemByNum(num)?.private) {
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
  private flying(eid: number): boolean {
    return eid >= 0 && hasComponent(this.world, Player, eid) && !hasComponent(this.world, Dead, eid);
  }

  /** The connection flying this entity (not one that's lingering after quitting) */
  private liveConn(eid: number): ClientConnection | undefined {
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

  /** Another pilot's info card */
  private handlePilotInfo(conn: ClientConnection, eid: number): void {
    const other = this.liveConn(eid);
    const p = other && this.pilots.get(other);
    if (!other || !p) return;
    const ship = this.ships.get(eid);
    let best = { v: -1, name: '', rank: '' };
    // (A tie goes to the faction whose id sorts first, so it doesn't hang on how the save stored the keys)
    for (const [f, v] of Object.entries(p.reputation).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (v > best.v) best = { v, name: this.quests.file.reputations[f]?.name ?? f, rank: repRank(v).name };
    }
    const size = this.party.size(other);
    this.send(conn.ws, {
      type: 'pilotInfo', id: eid, name: other.username, level: p.level, guest: other.userId === null,
      ship: ship?.blueprint.name ?? 'No ship', parts: ship ? ship.derived.alive.filter(Boolean).length : 0,
      hull: Math.round(this.ships.integrity(eid) * 100),
      title: best.v >= 5 ? `${best.rank} · ${best.name}` : 'Independent pilot',
      party: size > 1 ? { leader: this.party.leaderName(other) ?? '', size, mine: this.party.same(conn, other) } : undefined,
      kills: p.stats.kills ?? 0,
      ribbons: this.achievements.summary(other).count,
      topRibbon: this.achievements.summary(other).top,
    });
  }

  private lastShare = new WeakMap<ClientConnection, number>();

  /**
   * A design a client sent, parsed (throws if it isn't one). Sizes are checked
   * before any work's done on it: parts have unique uids 0..255, so a real design
   * never has more than 256; and the strings in it are kept to a sensible length
   * (they're saved and sent to everyone near).
   */
  private clientBlueprint(raw: unknown): Blueprint {
    const r = raw as { parts?: unknown } | null;
    if (!r || typeof r !== 'object' || !Array.isArray(r.parts) || r.parts.length > 256) throw new Error('not a blueprint');
    const bp = fixModelMaterials(this.ships.catalog, parseBlueprint(JSON.stringify(raw)));
    bp.name = bp.name.slice(0, 64);
    for (const p of bp.parts) {
      if (p.facing !== undefined && (typeof p.facing !== 'string' || p.facing.length > 16)) delete p.facing;
      if (p.gems) p.gems = p.gems.map((g) => g.slice(0, 40));
    }
    return bp;
  }

  /** Send a ship design to your party (they can load it into their hangar) */
  private handleShareDesign(conn: ClientConnection, raw: unknown): void {
    const now = this.clock();
    if (now - (this.lastShare.get(conn) ?? 0) < 3000) return;
    this.lastShare.set(conn, now);
    let bp: Blueprint;
    try {
      bp = this.clientBlueprint(raw);
    } catch {
      return this.pilots.toast(conn, "That isn't a ship design", 'warn');
    }
    if (!this.ships.validate(bp).ok) return this.pilots.toast(conn, 'Fix the design first: it has problems', 'warn');
    const others = this.party.members(conn).filter((m) => m !== conn) as ClientConnection[];
    if (!others.length) return this.pilots.toast(conn, 'Share designs with your party: invite someone first (P)', 'warn');
    for (const m of others) this.send(m.ws, { type: 'sharedDesign', from: conn.username, blueprint: bp });
    this.pilots.toast(conn, `Sent the ${bp.name} to your party`, 'good');
  }

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
      // (Support credit: game/Support.ts)
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
      // (Support credit: game/Support.ts)
      supportersOf: (player: number) => this.support.supporters(player, this.currentTick),
    };
  }

  /**
   * May `healer`'s Repair Beam mend `target` (common/src/ships/support.ts)? Friendly ships only: pilots and what they
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
        this.broadcastToSystem(num, { type: 'systemMessage', text, color });
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
  private placePlayer(conn: ClientConnection, systemNum: number, x: number, y: number): void {
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
  private async loginPilot(conn: ClientConnection, userId: number): Promise<void> {
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
      fireBaseShot: (ownerEid, x, y, angle, damageScale, shape) => {
        const ids: number[] = [];
        this.weapons.spawn(ownerEid, shape?.kind ?? 'cannon', x, y, angle, damageScale,
          { speedScale: shape?.speedScale ?? 1, sizeScale: shape?.sizeScale ?? 1, turret: shape?.turret ?? false, target: shape?.target, seed: shape?.seed, mods: shape?.mods, dry: shape?.dry, ammoMods: shape?.ammoMods, reach: shape?.reach, grade: shape?.grade, size: shape?.size, model: shape?.model }, ids);
        return ids;
      },
      shotVs: (proj) => this.weapons.vsOf(proj),
      hazardScale: (eid, what) => (what === 'heat' ? this.hazards.heatScale(eid) : this.hazards.shieldScale(eid)),
      partLost: (eid, uid) => { const pc = this.pilots.connOf(eid); if (pc) this.hangar.gemsLost(pc, uid); },
      spendAmmo: (eid, kind, free) => { const pc = this.pilots.connOf(eid); return pc ? this.ammo.spend(pc, kind, free) : { scale: 1, dry: false }; },
      beamAsteroid: (eid, x, y, angle, range, damage, kind) => this.beamAsteroid(eid, x, y, angle, range, damage, kind),
      notifyDamage: (targetEid, amount, sourceEid, glancing) => {
        this.bosses?.onDamage(targetEid, amount, sourceEid);
        this.broadcastNear(InSystem.systemId[targetEid], Position.x[targetEid], Position.y[targetEid], { type: 'damage', targetId: targetEid, amount, sourceId: sourceEid, ...(glancing ? { glancing: true } : {}) }, [sourceEid]);
      },
      notifyProjectileHit: (proj, x, y) => this.broadcastProjectileHit(proj, x, y),
      onShipDestroyed: (eid, lastHitBy, ship) => {
        this.enemies.onDestroyed(eid, lastHitBy, ship);
        // A ward (freighter, pylon, bastion, turret) shot down: forget it before its entity number is reused
        if (this.wards.delete(eid)) { this.enemies.removeWard(eid); this.ships.setDamageScale(eid, 1); }
        this.onPilotlessShipDestroyed(eid, lastHitBy);
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
      // --- Support weapons (common/src/ships/support.ts) ---
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
      towLoad: (eid) => this.towing?.load(eid) ?? 0,
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
        if (!this.memory.remembers(system.id)) this.spawnDerelict(slot);
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
    this.spawnPersonCraft();
    console.log('World initialized');
  }

  /** People out in space and on planets live aboard something (people.json craft): parked there, out of every fight */
  private spawnPersonCraft(): void {
    for (const d of this.people.file.people) {
      const bp = d.craft && this.ships.library.get(d.craft.ship);
      if (!bp || !d.craft || 'station' in d.at) continue;
      const num = this.gameData.getSystem(d.at.system) ? this.gameData.getSystemNum(d.at.system) : -1;
      if (num < 0) continue;
      const eid = this.ships.spawnDummy(bp, d.at.x, d.at.y, d.craft.angle ?? 0, num);
      this.ships.pin(eid);
      this.personCraft.set(eid, d.craft.name ?? d.name);
    }
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
        this.batching++;
        try {
          this.handleMessage(conn, msg);
        } catch (e) {
          // (Logged a line every 10 s at most per type: a hostile client could send thousands)
          this.fault(`message:${typeof msg?.type === 'string' ? msg.type.slice(0, 32) : '?'}`, e);
        } finally {
          this.batching--;
          // Answers to requests go now, together (inputs only queue, so usually nothing)
          if (!this.batching) this.flushOutbox();
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
        this.outbox.delete(ws);
        this.lazy.delete(ws);
        this.guard('close', () => this.party.remove(conn));
        this.guard('close', () => this.trade.remove(conn));
        this.guard('close', () => this.admin.forget(conn));
        this.guard('close', () => this.contrib.forget(conn));
        this.guard('close', () => this.ammo.forget(conn));
        const eid = conn.playerId;
        const alive = hasComponent(this.world, Player, eid) && !hasComponent(this.world, Dead, eid);
        // Leaving mid-fight doesn't save you: the ship stays put (hands off the controls) for a while
        if (alive && conn.userId !== null && this.currentTick - this.ships.lastDamagedTick(eid) < LINGER_COMBAT_TICKS) {
          for (const k of ['forward', 'backward', 'left', 'right', 'boost', 'fireLeft', 'fireRight', 'strafeLeft', 'strafeRight', 'jump'] as const) Input[k][eid] = 0;
          this.lingering.set(eid, { conn, until: this.currentTick + LINGER_TICKS });
          return;
        }
        this.pilots.detach(conn).catch((e) => this.fault('detach', e));
        if (hasComponent(this.world, Player, eid)) addComponent(this.world, Dead, eid);
      },
    };
  }

  private createPlayer(): number {
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

    this.ships.onPlayerCreated(eid);

    return eid;
  }

  // ============================================
  // MESSAGE HANDLING
  // ============================================

  /** Per-connection rate limits for expensive or broadcast messages (net/MessageLimits.ts) */
  readonly limiter = new MessageLimiter();

  private handleMessage(conn: ClientConnection, msg: ClientMessage): void {
    // (Anything that isn't a typed message object is dropped: a hostile client can send any JSON)
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
    if (!conn.joined && !PRE_JOIN.has(msg.type)) return;
    if (!conn.isAdmin && !this.limiter.allow(conn, msg.type)) {
      if (msg.type === 'chat') this.send(conn.ws, { type: 'systemMessage', text: 'Slow down: too many messages at once.', color: '#fca5a5' });
      return;
    }
    switch (msg.type) {
      case 'input':
        // Queue for next tick boundary — don't apply mid-frame.
        // Messages still arrive instantly via setImmediate event loop.
        if (++conn.inputsThisTick > MAX_INPUTS_PER_TICK) break;
        this.inputQueue.push({ conn, msg });
        break;
      case 'ping':
        this.handlePing(conn, msg);
        break;
      case 'mapView':
        // (Opened: the far ships at once, then once a second while it's open)
        conn.mapOpen = msg.open === true;
        if (conn.mapOpen) { conn.mapDotsDue = true; conn.mapFresh = true; conn.mapSent?.clear(); }
        break;
      case 'chat':
        this.handleChat(conn, msg);
        break;
      case 'interact':
        this.handleInteract(conn, msg);
        break;
case 'respawn':
        this.handleRespawn(conn, typeof msg.rally === 'string' ? msg.rally : undefined);
        break;
      case 'trainingDrone':
        this.trainingDrone(conn);
        break;
      case 'target':
        this.ships.setTarget(conn.playerId, Number(msg.id) || 0);
        break;
      case 'pilotInfo':
        this.handlePilotInfo(conn, Number(msg.id));
        break;
      case 'partyInvite':
        this.party.invite(conn, { name: msg.name, id: msg.id });
        break;
      case 'ribbons':
        this.achievements.progress(conn);
        break;
      case 'rankings':
        this.achievements.rankings(conn);
        break;
      case 'shareDesign':
        this.handleShareDesign(conn, msg.blueprint);
        break;
      case 'mapPing':
        if (this.flying(conn.playerId)) this.party.ping(conn, msg, this.gameData.getSystemByNum(InSystem.systemId[conn.playerId])?.id ?? '');
        break;
      case 'partyRespond':
        this.party.respond(conn, !!msg.accept);
        break;
      case 'partyLeave':
        this.party.leave(conn);
        break;
      case 'partyKick':
        this.party.kick(conn, String(msg.name));
        break;
      case 'partyPromote':
        this.party.promote(conn, String(msg.name));
        break;
      case 'tradeRequest':
        this.trade.request(conn, msg);
        break;
      case 'tradeRespond':
        this.trade.respond(conn, msg);
        break;
      case 'tradeOffer':
        this.trade.offer(conn, msg);
        break;
      case 'tradeAccept':
        this.trade.accept(conn);
        break;
      case 'tradeCancel':
        this.trade.cancel(conn);
        break;
      case 'vendorOpen':
        this.market.vendors(conn);
        break;
      case 'vendorBuy':
        this.market.buy(conn, msg);
        break;
      case 'marketScan':
        this.market.scan(conn, Array.isArray(msg.items) ? msg.items.slice(0, 80).map(String) : []);
        break;
      case 'itemMove':
        this.pilots.handleMove(conn, msg);
        break;
      case 'itemJettison':
        this.pilots.handleJettison(conn, msg);
        break;
      case 'itemUse':
        this.pilots.handleUse(conn, msg);
        break;
      case 'stationOpen':
        this.services.open(conn);
        this.quests.board(conn);
        break;
      case 'refine':
        this.services.refine(conn, msg);
        break;
      case 'craft':
        this.services.craft(conn, msg);
        break;
      case 'outpostCharter':
        this.outpost?.charter(conn, String(msg.site));
        break;
      case 'outpostUpgrade':
        this.outpost?.upgrade(conn, String(msg.track));
        break;
      case 'devStation': {
        // Dev (or an admin): a station at Sol's site with every track at a tier, and in you go
        if (!this.devTeleport && !conn.isAdmin) break;
        const p = this.pilots.get(conn), file = stationTable();
        if (!p || !file) break;
        const tier = Math.max(0, Math.min(5, Math.floor(Number((msg as { tier?: number }).tier ?? 3))));
        p.outpost = { site: 'sol_outer', tracks: Object.fromEntries(Object.keys(file.tracks).map((t) => [t, tier])) };
        this.pilots.sendProfile(conn);
        const sol = this.gameData.getSystemNum('sol');
        const jp = [...portalQuery(this.world)].find((g) => InSystem.systemId[g] === sol && this.gameData.getSystemByNum(Portal.targetSystem[g])?.private);
        if (jp !== undefined) this.homes.jump(conn, 'sol', Position.x[jp], Position.y[jp]);
        break;
      }
      case 'ammoPrefer':
        this.ammo.prefer(conn, String(msg.item));
        break;
      case 'slotLoadout':
        this.ammo.setLoadout(conn, Math.floor(Number(msg.slot)), msg.load, msg.first);
        break;
      case 'restockLoadout':
        this.ammo.restock(conn, { report: true });
        break;
      case 'itemStore':
        this.pilots.handleStore(conn, msg.what);
        break;
      case 'gemCut':
        this.services.cutGem(conn, msg);
        break;
      case 'gemSocket':
        this.hangar.socketGem(conn, Math.floor(Number(msg.slot)), Math.floor(Number(msg.uid)), String(msg.gem));
        break;
      case 'gemUnsocket':
        this.hangar.unsocketGem(conn, Math.floor(Number(msg.slot)), Math.floor(Number(msg.uid)), Math.floor(Number(msg.index)));
        break;
      case 'marketSell':
        this.services.sell(conn, msg);
        break;
      case 'marketBuy':
        this.services.buy(conn, msg);
        break;
      case 'questBoard':
        this.quests.board(conn);
        break;
      case 'questAccept':
        this.quests.accept(conn, msg);
        break;
      case 'talk':
        this.people.handle(conn, msg);
        break;
      case 'questAbandon':
        this.quests.abandon(conn, msg);
        break;
      case 'questSeen':
        this.quests.seen(conn);
        break;
      case 'codexRead':
        this.codex.read(conn, msg);
        break;
      case 'skillUp':
        this.quests.skillUp(conn, msg);
        break;
case 'join':
        // (Async: a throw inside is a rejected promise the receive() try/catch can't see)
        this.handleJoin(conn, msg).catch((e) => this.fault('join', e));
        break;
      case 'authLogin':
        this.handleAuthLogin(conn, msg).catch((e) => this.fault('authLogin', e));
        break;
      case 'authRegister':
        this.handleAuthRegister(conn, msg).catch((e) => this.fault('authRegister', e));
        break;
      case 'stateHash':
        this.handleStateHash(conn, msg as any);
        break;
      case 'shipEdit':
        this.handleShipEdit(conn, msg.blueprint);
        break;
      case 'slotSave':
        this.handleSlotSave(conn, msg);
        break;
      case 'slotFly': {
        const was = this.pilots.get(conn)?.ship;
        this.hangar.fly(conn, Math.floor(Number(msg.slot)));
        // Another ship: its own loadout aboard
        if (this.pilots.get(conn)?.ship !== was) { this.ammo.restock(conn, { report: true, quiet: true }); this.pilots.sendProfile(conn); }
        break;
      }
      case 'slotClear':
        this.hangar.scrap(conn, Math.floor(Number(msg.slot)));
        break;
      case 'designSave': {
        let bp: Blueprint;
        try { bp = this.clientBlueprint(msg.blueprint); } catch { break; }
        if (!this.ships.validate(bp).ok) { this.pilots.toast(conn, 'Fix the design first: it has problems', 'warn'); break; }
        this.hangar.saveDesign(conn, Math.floor(Number(msg.slot)), bp);
        break;
      }
      case 'fabOrder':
        this.hangar.orderItem(conn, String(msg.item), Math.floor(Number(msg.n)));
        break;
      case 'fabOrderCancel':
        this.hangar.cancelOrder(conn, Math.floor(Number(msg.id)));
        break;
      case 'designDelete':
        this.hangar.deleteDesign(conn, Math.floor(Number(msg.slot)));
        break;
      case 'slotBuild':
        this.hangar.build(conn, Math.floor(Number(msg.slot)));
        break;
      case 'slotOrder':
        if (ORDER_ACTIONS.has(msg.action)) this.hangar.order(conn, Math.floor(Number(msg.slot)), msg.action);
        break;
      case 'job':
        if (ORDER_ACTIONS.has(msg.action)) this.services.jobAction(conn, Math.floor(Number(msg.id)), msg.action);
        break;
      case 'scrapItem':
        this.pilots.scrapItem(conn, String(msg.id), Math.floor(Number(msg.n)));
        break;
      case 'marketSellAll':
        this.services.sellAll(conn);
        break;
      case 'quickbarSet':
        this.pilots.setQuickbar(conn, msg);
        break;
      case 'dock':
        this.handleDock(conn);
        break;
      case 'devTeleport':
        this.handleDevTeleport(conn, msg);
        break;
      case 'devSpawn':
        this.handleDevSpawn(conn, msg);
        break;
      case 'devShip': {
        if (!this.devTeleport && !conn.isAdmin) break;
        const name = typeof msg.ship === 'string' ? msg.ship : '';
        const bp = name ? this.ships.library.get(name) ?? this.ships.enemyDesigns[name] ?? this.ships.devDesigns[name] ?? null : null;
        if (name && !bp) { this.pilots.toast(conn, `No library ship called ${name}`, 'warn'); break; }
        if (this.pilots.devSwapShip(conn, bp ?? null)) {
          this.ammo.restock(conn, { report: true, quiet: true });
          this.pilots.toast(conn, bp ? `Flying the ${bp.name} (dev: not saved)` : 'Back in your own ship', 'info');
        }
        break;
      }
      case 'devBoss': {
        if (!this.devTeleport && !conn.isAdmin) break;
        const pid = conn.playerId, num = InSystem.systemId[pid];
        let boss = -1, bd = Infinity;
        for (const b of this.bosses.inSystem(num)) {
          const d = Math.hypot(Position.x[b] - Position.x[pid], Position.y[b] - Position.y[pid]);
          if (d < bd) { bd = d; boss = b; }
        }
        if (boss < 0) { this.pilots.toast(conn, 'No boss in this system', 'warn'); break; }
        if (msg.shed !== undefined) { this.bosses.brainOf(boss)?.forceShed?.(Number(msg.shed) || 0); this.pilots.toast(conn, `Boss shed ${msg.shed} steps`, 'info'); break; }
        if (msg.reset) { this.bosses.remove(boss); this.pilots.toast(conn, 'Boss reset: it comes back fresh in a moment', 'info'); break; }
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
        break;
      }
      case 'contrib':
        this.contrib.handle(conn, msg as unknown as Record<string, unknown>);
        break;
      case 'admin':
        this.admin.run(conn, String(msg.cmd ?? ''), msg.args && typeof msg.args === 'object' ? msg.args : {});
        break;
      case 'siege':
        this.sieges.handle(conn, msg, conn.playerId);
        break;
      case 'undock':
        this.undock(conn);
        break;
      case 'tow': {
        // Tow Beam (game/Towing.ts): take hold of what's nearest the cursor, or let go
        const p = conn.playerId;
        if (!hasComponent(this.world, Player, p)) break;
        const a = Input.targetAngle[p], dist = Input.cursorDist[p];
        this.towing.request(p, !!msg.on, { x: Position.x[p] + Math.cos(a) * dist, y: Position.y[p] + Math.sin(a) * dist });
        break;
      }
      case 'shipNeed': {
        // The client lost a ship's blueprint: the next snapshot sends it in full
        conn.shipSynced.delete(Number(msg.id));
        const bp = this.ships.get(Number(msg.id))?.blueprint;
        if (bp) conn.designs.delete(designHash(bp));
        break;
      }
    }
  }

  /** The station this player is close enough to dock at, or -1. */
  private stationInRange(eid: number): number {
    for (const st of stationQuery(this.world)) {
      if (InSystem.systemId[st] !== InSystem.systemId[eid]) continue;
      const dx = Position.x[st] - Position.x[eid], dy = Position.y[st] - Position.y[eid];
      // (Further than any station of its size reaches: no need to look up its design. Enemies ask this of every pilot they might go for)
      if (fartherThan(dx, dy, stationReachMax(Radius.value[st]))) continue;
      if (Math.hypot(dx, dy) < stationInteractRadius(Radius.value[st], this.gameData.getStationByNum(Station.stationId[st])?.design)) return st;
    }
    return -1;
  }

  /** Is this player close enough to a station to use its shipyard? */
  private isDocked(eid: number): boolean {
    return this.stationInRange(eid) >= 0;
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

  /** Berth at the nearest station (hangar opening): the ship then rides along with it. */
  private handleDock(conn: ClientConnection): void {
    const eid = conn.playerId;
    const reply = (ok: boolean, station?: string, error?: string) => this.send(conn.ws, { type: 'dockResult', ok, station, error });
    if (!hasComponent(this.world, Player, eid) || hasComponent(this.world, Dead, eid)) return reply(false, undefined, 'no ship');
    if (this.shipEditAnywhere) return reply(true, 'Hangar');
    const st = this.stationInRange(eid);
    if (st < 0) return reply(false, undefined, 'too far from a station');
    // Inside: at the station's centre, out of reach; back out where it came in
    conn.docked = { station: st, ox: 0, oy: 0, exit: { x: Position.x[eid] - Position.x[st], y: Position.y[eid] - Position.y[st] } };
    this.dockedShips.add(eid);
    for (const k of ['forward', 'backward', 'left', 'right', 'boost', 'fireLeft', 'fireRight', 'strafeLeft', 'strafeRight', 'jump'] as const) Input[k][eid] = 0;
    const sd = this.gameData.getStationByNum(Station.stationId[st]);
    if (sd?.dockingFee) this.pilots.payDockFee(conn, sd.id, sd.dockingFee);
    // (Quiet when there was nothing to load: every dock shouldn't say so)
    this.ammo.restock(conn, { report: true, quiet: true });
    if (sd) this.pilots.bumpStat(conn, `dock:${sd.id}`);
    if (sd) this.quests.rumourAt(conn, sd.id, sd.system, Math.floor(this.clock() / 86_400_000));
    reply(true, sd?.name ?? 'Station');
  }

  /** Leave the berth: back out where the ship came in, at rest */
  private undock(conn: ClientConnection): void {
    const d = conn.docked;
    // Launching: the loadout tops up one last time (still in the berth), and says what's short
    if (d) this.ammo.restock(conn, { report: true, quiet: true });
    conn.docked = null;
    this.dockedShips.delete(conn.playerId);
    const eid = conn.playerId;
    if (!d?.exit || !entityExists(this.world, d.station) || !hasComponent(this.world, Player, eid)) return;
    Position.x[eid] = Position.x[d.station] + d.exit.x;
    Position.y[eid] = Position.y[d.station] + d.exit.y;
    Velocity.x[eid] = 0;
    Velocity.y[eid] = 0;
  }

  /** Docked ships (inside a station): invulnerable, untouchable, unseen by hostiles */
  private dockedShips = new Set<number>();

  /** Berthed ships ride along inside their station, holding still. */
  private dockingSystem(): void {
    this.dockedShips.clear();
    for (const conn of this.clients.values()) {
      const d = conn.docked;
      if (!d) continue;
      const eid = conn.playerId;
      if (!hasComponent(this.world, Player, eid) || hasComponent(this.world, Dead, eid) || !entityExists(this.world, d.station)) {
        conn.docked = null;
        continue;
      }
      this.dockedShips.add(eid);
      const x = Position.x[d.station] + d.ox, y = Position.y[d.station] + d.oy;
      Velocity.x[eid] = x - Position.x[eid];
      Velocity.y[eid] = y - Position.y[eid];
      Position.x[eid] = x;
      Position.y[eid] = y;
    }
  }

  /**
   * Refits that take no parts and need no licence: proto mode (everyone's an
   * admin, editing anywhere), or an admin who switched on free build where the
   * server allows it (dev only: freeBuildAllowed is never set in production)
   */
  private freeBuild(conn: ClientConnection): boolean {
    return (this.everyoneAdmin && this.shipEditAnywhere) || (this.freeBuildAllowed && this.admin.freeBuild(conn));
  }

  /** Hangar: validate the new blueprint and respawn the player's ship in place. */
  private handleShipEdit(conn: ClientConnection, raw: unknown): void {
    const reply = (ok: boolean, errors: string[]) => this.send(conn.ws, { type: 'shipEditResult', ok, errors });
    const eid = conn.playerId;
    if (!hasComponent(this.world, Player, eid) || hasComponent(this.world, Dead, eid)) return reply(false, ['no ship to refit']);
    // Berthed (hangar opened in range) counts even if the station has moved since; otherwise be in range now
    if (!this.shipEditAnywhere && !conn.docked && !this.isDocked(eid)) return reply(false, ['dock at a station to refit your ship']);
    let bp: Blueprint;
    try {
      bp = this.clientBlueprint(raw);
    } catch {
      return reply(false, ['not a blueprint']);
    }
    const result = this.ships.validate(bp);
    if (!result.ok) return reply(false, result.errors.map((e) => e.message));
    // Parts the pilot has are built in; the rest become ghosts (proto mode hands out everything)
    const profile = this.pilots.get(conn);
    const errors = this.hangar.save(conn, profile?.activeSlot ?? 0, bp, { grantAll: this.freeBuild(conn) });
    if (errors.length) return reply(false, errors);
    conn.blueprint = bp;
    reply(true, []);
  }

  /** Save a design to a hangar slot */
  private handleSlotSave(conn: ClientConnection, msg: { slot: number; blueprint: unknown; plan?: string }): void {
    const reply = (ok: boolean, errors: string[]) => this.send(conn.ws, { type: 'shipEditResult', ok, errors });
    const eid = conn.playerId;
    if (!hasComponent(this.world, Player, eid) || hasComponent(this.world, Dead, eid)) return reply(false, ['no ship']);
    if (!this.shipEditAnywhere && !conn.docked && !this.isDocked(eid)) return reply(false, ['dock at a station to use the hangar']);
    let bp: Blueprint;
    try {
      bp = this.clientBlueprint(msg.blueprint);
    } catch {
      return reply(false, ['not a blueprint']);
    }
    const result = this.ships.validate(bp);
    if (!result.ok) return reply(false, result.errors.map((e) => e.message));
    const plan = typeof msg.plan === 'string' && this.ships.library.has(msg.plan) && this.pilots.knowsPlan(conn, msg.plan) ? msg.plan : undefined;
    const errors = this.hangar.save(conn, Math.floor(Number(msg.slot)), bp, { plan, grantAll: this.freeBuild(conn) });
    reply(errors.length === 0, errors);
  }

  /** The client's prediction of its ship at a tick, checked against what the ship really did then */
  private handleStateHash(conn: ClientConnection, msg: { tick: number; hash: number }): void {
    conn.liveTick = this.currentTick;
    conn.hashSeen = true;
    if (!hasComponent(this.world, Player, conn.playerId)) return;
    const tick = Number(msg.tick);
    // The client predicts ahead of us: a hash for a tick we haven't reached is checked when we get there
    if (tick > this.currentTick) {
      if (tick - this.currentTick < 120 && conn.aheadHashes.size < 8) conn.aheadHashes.set(tick, msg.hash);
      return;
    }
    const h = conn.selfHashes.get(tick);
    if (h !== undefined && h !== msg.hash) conn.forceSnapshot = true;
  }

  /** End of tick: remember each pilot's ship state hash for the last couple of seconds */
  private recordSelfHashes(): void {
    for (const conn of this.clients.values()) {
      const eid = conn.playerId;
      if (!hasComponent(this.world, Player, eid) || hasComponent(this.world, Dead, eid)) continue;
      const h = computeStateHash(Position.x[eid], Position.y[eid], Rotation.angle[eid], Velocity.x[eid], Velocity.y[eid],
        Health.current[eid], Boost.fuel[eid], this.gameData.getSystemByNum(InSystem.systemId[eid])?.id || 'sol');
      conn.selfHashes.set(this.currentTick, h);
      conn.selfHashes.delete(this.currentTick - 180);
      const ahead = conn.aheadHashes.get(this.currentTick);
      if (ahead !== undefined) {
        if (ahead !== h) conn.forceSnapshot = true;
        conn.aheadHashes.delete(this.currentTick);
      }
      for (const t of conn.aheadHashes.keys()) if (t < this.currentTick) conn.aheadHashes.delete(t);
    }
  }

  /**
   * Schedule an input for future application at its targetTick.
   * If no targetTick or it's in the past, apply immediately (backward compat).
   */
  private handleInput(conn: ClientConnection, msg: any): void {
    const eid = conn.playerId;
    if (!hasComponent(this.world, Player, eid)) return;
    
    // Inputs carry the low 16 bits of their target tick: the one nearest ours
    if (msg.targetTick !== undefined) msg.targetTick = unwrapTick16(msg.targetTick & 0xFFFF, this.currentTick);
    const targetTick = msg.targetTick;
    conn.liveTick = this.currentTick;
    if (targetTick !== undefined && targetTick > this.currentTick) {
      // Schedule for future tick (no further ahead than a client could predict, and only so many)
      if (targetTick > this.currentTick + MAX_INPUT_LEAD) return;
      conn.scheduledInputs.push({ targetTick, msg });
      if (conn.scheduledInputs.length > MAX_SCHEDULED_INPUTS) conn.scheduledInputs.shift();
    } else {
      // No targetTick (old client) or late arrival — apply immediately. The client
      // predicted it on an earlier tick, so its ship needs correcting
      this.applyInputToEntity(conn, msg);
      conn.selfLate = true;
    }
  }

  /** Write input state to ECS components for a player entity. */
  private applyInputToEntity(conn: ClientConnection, msg: any): void {
    const eid = conn.playerId;
    Input.forward[eid] = msg.forward ? 1 : 0;
    Input.backward[eid] = msg.backward ? 1 : 0;
    Input.left[eid] = msg.left ? 1 : 0;
    Input.right[eid] = msg.right ? 1 : 0;
    Input.boost[eid] = msg.boost ? 1 : 0;
    Input.fireLeft[eid] = msg.fireLeft ? 1 : 0;
    Input.fireRight[eid] = msg.fireRight ? 1 : 0;
    Input.strafeLeft[eid] = msg.strafeLeft ? 1 : 0;
    Input.strafeRight[eid] = msg.strafeRight ? 1 : 0;
    Input.helm[eid] = msg.helm ? 1 : 0;
    Input.jump[eid] = msg.jump ? 1 : 0;
    Input.dodge[eid] = msg.dodge ? 1 : 0;
    // (The binary input carries it as a uint16; a JSON one could say NaN, Infinity or a string)
    const cursorDist = Number(msg.cursorDist);
    Input.cursorDist[eid] = Number.isFinite(cursorDist) ? Math.min(65535, Math.max(0, cursorDist)) : 0;
    // The client sends dequantized(quantized(rawAngle)) as a float32, which is already on the
    // replicated grid (replicaAngle gives back exactly that value). Anything else (a JSON input,
    // a bot) is put on the grid too, so every client replays this ship's turning exactly.
    Input.targetAngle[eid] = replicaAngle(ReplicaMode.Player, quantizeReplicaAngle(Number(msg.targetAngle) || 0));
    const seq = Number.isFinite(msg.seq) ? msg.seq : 0;
    Input.sequence[eid] = seq;
    
    conn.lastInputSeq = seq;
  }

  private handlePing(conn: ClientConnection, msg: any): void {
    const receiveTime = performance.now();
    const serverNow = Date.now();
    // Rough estimate for admin display (includes clock skew, but close enough)
    const clientTime = Number.isFinite(msg.clientTime) ? msg.clientTime : 0;
    conn.ping = Math.max(0, serverNow - clientTime);
    this.send(conn.ws, {
      type: 'pong',
      clientTime,
      serverTime: serverNow,
      tick: this.currentTick,
      serverProcessing: Math.round((performance.now() - receiveTime) * 100) / 100,
    });
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

  private async handleJoin(conn: ClientConnection, msg: any): Promise<void> {
    // A client built for another wire format can't talk to us: it shows "new version, reload"
    // (one that doesn't say predates the handshake, and the format it knows hasn't changed since)
    if (msg.protocol !== undefined && msg.protocol !== PROTOCOL_VERSION) {
      conn.ws.close?.(PROTOCOL_MISMATCH_CLOSE, PROTOCOL_MISMATCH_REASON);
      return;
    }
    conn.joined = true;
    if (msg.token) {
      // Authenticated join - validate token
      const { user, error } = this.userDB.checkSession
        ? await this.userDB.checkSession(msg.token)
        : { user: await this.userDB.validateSession(msg.token), error: '' };
      if (user) {
        conn.username = user.username;
        conn.userId = user.id;
        conn.isAdmin = user.is_admin;
        conn.isContributor = this.contrib.hasRank(user.id, user.username);
        conn.authToken = msg.token;
        this.loginPilot(conn, user.id).catch((e) => this.fault('login', e));
        console.log(`Player ${conn.playerId} authenticated as ${user.username}${user.is_admin ? ' (admin)' : ''}`);
      } else {
        // Expired, signed out or banned (or the lobby's unreachable): back to the sign-in screen, not in as a guest
        this.rejectAuth(conn, error || 'Your session has ended. Sign in again.');
        return;
      }
    } else {
      // Guest join
      // (A name only: a string, no control characters, a sensible length; it goes to everyone near)
      const name = typeof msg.username === 'string' ? msg.username.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, 24) : '';
      // (Nor anyone's account: a guest can't pose as a known pilot or an admin)
      // (Only asking the lobby waits: with no lobby to ask, a guest's join goes through at once, as it always has)
      const owner = name ? this.signedInOwner(name) ?? (this.userDB.admin ? await this.accountOwner(name) : null) : null;
      if (owner) {
        this.rejectAuth(conn, `"${name}" is ${owner === 'admin' ? "an admin's" : "a registered pilot's"} name. Sign in to fly as them, or pick another name.`);
        return;
      }
      conn.username = name || `Guest_${Math.floor(Math.random() * 10000)}`;
      conn.userId = null;
      conn.isAdmin = this.everyoneAdmin || this.guestAdmin;
      conn.isContributor = false;
    }
    
    // Send auth result back
    this.send(conn.ws, {
      type: 'authResult',
      success: true,
      username: conn.username,
      isAdmin: conn.isAdmin,
      isContributor: this.contrib.allowed(conn),
    });
  }

  private async handleAuthLogin(conn: ClientConnection, msg: any): Promise<void> {
    const result = await this.userDB.login(msg.username, msg.password, conn.address);
    if (result.success) {
      conn.username = result.user.username;
      conn.userId = result.user.id;
      this.loginPilot(conn, result.user.id).catch((e) => this.fault('login', e));
      conn.isAdmin = result.user.is_admin;
      conn.isContributor = this.contrib.hasRank(result.user.id, result.user.username);
      conn.authToken = result.token;
      
      this.send(conn.ws, {
        type: 'authResult',
        success: true,
        username: result.user.username,
        token: result.token,
        isAdmin: result.user.is_admin,
        isContributor: this.contrib.allowed(conn),
      });
    } else {
      this.rejectAuth(conn, result.error);
    }
  }

  /**
   * Whose account a guest's name is (whatever its case): an admin's or a registered pilot's, or nobody's (null).
   * signedInOwner knows those signed in here; accountOwner asks the lobby (when this server may: its admin secret,
   * `userDB.admin`), and a lobby that can't be reached doesn't keep guests out.
   */
  private signedInOwner(name: string): 'admin' | 'pilot' | null {
    const lower = name.toLowerCase();
    for (const c of this.clients.values()) {
      if (c.userId !== null && c.username.toLowerCase() === lower) return c.isAdmin ? 'admin' : 'pilot';
    }
    return null;
  }
  private async accountOwner(name: string): Promise<'admin' | 'pilot' | null> {
    try {
      const account = await this.userDB.admin?.get(name);
      return account ? (account.isAdmin ? 'admin' : 'pilot') : null;
    } catch {
      return null;
    }
  }

  /**
   * A wrong password or a refused registration: say why, then hang up, so the
   * connection doesn't stay in the world as a nameless pilot.
   */
  private rejectAuth(conn: ClientConnection, error: string | undefined): void {
    this.send(conn.ws, { type: 'authResult', success: false, error });
    // A moment for the answer to get out before the socket closes
    setTimeout(() => conn.ws.close?.(), 250);
  }

  private async handleAuthRegister(conn: ClientConnection, msg: any): Promise<void> {
    const result = await this.userDB.register(msg.username, msg.email, msg.password, conn.address);
    if (result.success) {
      conn.username = result.user.username;
      conn.userId = result.user.id;
      this.loginPilot(conn, result.user.id).catch((e) => this.fault('login', e));
      conn.isAdmin = result.user.is_admin;
      conn.isContributor = this.contrib.hasRank(result.user.id, result.user.username);
      conn.authToken = result.token;
      
      this.send(conn.ws, {
        type: 'authResult',
        success: true,
        username: result.user.username,
        token: result.token,
        isAdmin: result.user.is_admin,
        isContributor: this.contrib.allowed(conn),
      });
    } else {
      this.rejectAuth(conn, result.error);
    }
  }

  /**
   * Move a player to (x, y) in another (or the same) system: jump gates and rifts.
   * Rifts keep the ship's momentum; gates bring it to a stop.
   */
  private travelTo(conn: ClientConnection, systemNum: number, x: number, y: number, keepMomentum: boolean): void {
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

  private handleInteract(conn: ClientConnection, msg: any): void {
    const playerEid = conn.playerId;
    if (!hasComponent(this.world, Player, playerEid)) return;
    // Someone out here to talk to (People.ts)
    const person = hasComponent(this.world, Dead, playerEid) ? null : this.people.nearby(conn);
    if (person) return this.people.talkTo(conn, person.id);
    
    const playerX = Position.x[playerEid];
    const playerY = Position.y[playerEid];
    const playerSystemId = InSystem.systemId[playerEid];
    
    // In orbit over a planet with a surface: down you go
    const here = this.gameData.getSystemByNum(playerSystemId);
    if (here && !hasComponent(this.world, Dead, playerEid) && this.surfaces.descend(conn, here, playerX, playerY)) return;

    // Check for nearby jump gates (rifts trigger on their own when flown into)
    for (const portalEid of portalQuery(this.world)) {
      if (InSystem.systemId[portalEid] !== playerSystemId || Portal.kind[portalEid] !== 0) continue;

      const dx = Position.x[portalEid] - playerX;
      const dy = Position.y[portalEid] - playerY;
      const dist = Math.sqrt(dx * dx + dy * dy);

      // Portal interaction radius
      if (dist < 300) {
        const targetSystemNum = Portal.targetSystem[portalEid];
        const targetData = this.gameData.getSystemByNum(targetSystemNum);
        if (!targetData) return;
        // Pilots' own stations: in by a site's jump point, out by their station's gate
        if (here?.private && this.homes.leave(conn, playerSystemId)) return;
        if (targetData.private) return this.homes.jump(conn, here?.id ?? '', Position.x[portalEid], Position.y[portalEid]);
        const barred = this.quests.canEnter(conn, targetData.id);
        if (barred) return this.pilots.toast(conn, barred, 'warn');
        // Arrive beside the gate that leads back here (or any gate if there's no return gate)
        let arrival: number | null = null;
        for (const g of portalQuery(this.world)) {
          if (InSystem.systemId[g] !== targetSystemNum || Portal.kind[g] !== 0) continue;
          if (arrival === null || Portal.targetSystem[g] === playerSystemId) arrival = g;
        }
        const ax = arrival !== null ? Position.x[arrival] + 500 : 0;
        const ay = arrival !== null ? Position.y[arrival] : 0;
        this.travelTo(conn, targetSystemNum, ax, ay, false);
        return;
      }
    }
  }

  private handleRespawn(conn: ClientConnection, rally?: string): void {
    const eid = conn.playerId;
    // cleanupSystem removes dead entities the same tick they die, so by the time
    // a respawn request arrives the entity is usually gone rather than Dead.
    if (hasComponent(this.world, Dead, eid) || !entityExists(this.world, eid)) {
      // Remove dead component and reset health
      // For now, just recreate the player
      const newPlayerId = this.createPlayer();
      conn.playerId = newPlayerId;
      Player.clientId[newPlayerId] = Player.clientId[eid];
      if (hasComponent(this.world, Dead, eid)) removeEntity(this.world, eid);
      this.pilots.onRespawn(conn);
      // Rally: come back beside a party member (if they aren't in the thick of a fight)
      if (rally) {
        const m = this.party.members(conn).find((x) => x !== conn && x.username === rally) as ClientConnection | undefined;
        const me = m?.playerId ?? -1;
        if (!m || !this.flying(me)) this.pilots.toast(conn, `${rally} isn't flying right now: you're back at your home station`, 'warn');
        else if (this.currentTick - this.ships.lastDamagedTick(me) < 60 * 8) this.pilots.toast(conn, `${rally} is under fire: you're back at your home station`, 'warn');
        else {
          const a = Math.random() * Math.PI * 2;
          this.placePlayer(conn, InSystem.systemId[me], Position.x[me] + Math.cos(a) * 450, Position.y[me] + Math.sin(a) * 450);
          this.pilots.toast(conn, `Rallied with ${rally}`, 'good');
        }
      }

      this.send(conn.ws, {
        type: 'welcome',
        playerId: newPlayerId,
        protocol: PROTOCOL_VERSION,
        tickRate: TICK_RATE,
        serverTime: Date.now(),
      });
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
    this.batching++;
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
      this.batching--;
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

  /** Let go of every key (aim and helm stay as they are) */
  private releaseControls(eid: number): void {
    Input.forward[eid] = 0; Input.backward[eid] = 0; Input.left[eid] = 0; Input.right[eid] = 0;
    Input.boost[eid] = 0; Input.fireLeft[eid] = 0; Input.fireRight[eid] = 0;
    Input.strafeLeft[eid] = 0; Input.strafeRight[eid] = 0; Input.jump[eid] = 0; Input.dodge[eid] = 0;
  }

  // ---- Crash isolation (server robustness audit, docs/audits/server-robustness.md) ----
  /** Errors by where they happened: how many, and when it was last logged */
  private faults = new Map<string, { count: number; unlogged: number; loggedAt: number }>();

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

  private tick(): void {
    const tickStart = performance.now();
    this.currentTick++;
    
    // (Asteroids aren't moved: their positions are worked out when something needs them, see placeAsteroid)
    this.guard('stationOrbitSystem', () => this.stationOrbitSystem());
    // Systems pilots are in or coming to are in the world; ones left a while are put away (before anything's spawned)
    if (this.scene === 'sectors') this.guard('memory', () => this.memory.tick());

    // Reset spatial grid and rebuild
    this.guard('spatialGrid', () => { this.spatialGrid.clear(); this.buildSpatialGrid(); });
    
    // Run systems
    this.guard('playerMovementSystem', () => this.playerMovementSystem());
    // (Tow Beams pull what they tow, after the pilots fly and before wrecks and pods move: game/Towing.ts)
    this.guard('towing', () => this.towing.tick());
    this.guard('dockingSystem', () => this.dockingSystem());
    this.guard('riftSystem', () => this.riftSystem());
    // (Boost fuel is the ship's battery now: it charges in the flight step, energy.ts)
    this.guard('weaponSystem', () => this.weaponSystem());
    this.guard('projectileSystem', () => this.projectileSystem());
    if (this.scene === 'sectors') {
      this.guard('enemies', () => this.enemies.tick()); this.guard('bosses', () => this.bosses.tick()); this.guard('mobs', () => this.mobs.tick());
      this.guard('events', () => this.events.tick()); this.guard('surfaces', () => this.surfaces.tick()); this.guard('sieges', () => this.sieges.tick()); this.guard('arenas', () => this.arenas.tick());
    }
    this.guard('collisionSystem', () => this.collisionSystem());
    this.guard('asteroidDeathSystem', () => this.asteroidDeathSystem());  // Check for destroyed asteroids
    this.guard('lod', () => this.lod.tick());
    this.guard('ships', () => this.ships.tick());
    this.guard('replication.endTick', () => this.replication.endTick());
    this.guard('recordSelfHashes', () => this.recordSelfHashes());
    this.guard('pods', () => this.pods.tick());
    this.guard('mining', () => this.mining.tick());
    this.guard('hazards', () => this.hazards.tick());
    this.guard('warmth', () => this.warmth.tick());
    this.guard('homes', () => this.homes.tick());
    this.guard('watchComet', () => this.watchComet());
    if (this.outpost && this.currentTick % 60 === 0) for (const c of this.clients.values()) this.guard('outpost', () => this.outpost!.finish(c));
    this.guard('pilots', () => this.pilots.tick());
    this.guard('quests', () => this.quests.tick());
    this.guard('codex', () => this.codex.tick());
    this.guard('party', () => this.party.tick());
    this.guard('trade', () => this.trade.tick(this.currentTick));
    if (this.currentTick % 60 === 0) {
      for (const c of this.clients.values()) {
        if (this.flying(c.playerId)) this.guard('achievements', () => this.achievements.visit(c, this.gameData.getSystemByNum(InSystem.systemId[c.playerId])?.id ?? ''));
      }
      this.achievements.save().catch((e) => console.error('[Achievements] save failed:', e));
    }
    if (this.scene === 'sectors') this.guard('ops', () => this.ops.tick());
    if (this.currentTick % 60 === 0) for (const c of this.clients.values()) this.guard('services', () => { this.services.tick(c); this.hangar.tick(c); this.hangar.fill(c); });
    this.guard('lingerSystem', () => this.lingerSystem());
    this.guard('derelictRespawnSystem', () => this.derelictRespawnSystem());
    this.guard('trafficSystem', () => this.trafficSystem());
    this.guard('lifetimeSystem', () => this.lifetimeSystem());
    this.guard('cleanupSystem', () => this.cleanupSystem());
    
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
      if (this.weapons.lobbed(proj)) continue;
      
      const px = Position.x[proj];
      const py = Position.y[proj];
      const pr = Radius.value[proj];
      const systemId = InSystem.systemId[proj];
      const ownerId = Projectile.ownerId[proj];
      
      // Calculate the ray from current position to next (projectile moves fast)
      const vx = Velocity.x[proj];
      const vy = Velocity.y[proj];
      // A surface's rock: the shot's path this tick ends where it meets it
      const wall = this.shotWall(proj, systemId, px, py, vx, vy);
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
      
      for (const asteroid of this.asteroidOrbits.query(systemId, px, py, endX, endY, speed + 100, this.currentTick)) {
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
        
        const ax = Position.x[hitAsteroid];
        const ay = Position.y[hitAsteroid];
        const damage = Projectile.damage[proj];
        
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

  private spawnDerelict(slot: { data: DerelictData; systemNum: number; eid: number; spawns: number }): void {
    const bp = this.ships.library.get(slot.data.blueprint);
    if (!bp) return;
    const seed = hashString(`derelict:${slot.data.id}:${slot.spawns++}`);
    slot.eid = this.ships.spawnWreck(bp, slot.data.position.x, slot.data.position.y, slot.data.angle ?? 0, slot.systemNum, seed);
  }

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
          this.spawnDerelict(slot);
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
  private trainers = new Map<number, number>();

  /** A Helios drone 1400 ahead of a pilot in safe space, to practise on: it only fights back once shot */
  private trainingDrone(conn: ClientConnection): void {
    const eid = conn.playerId;
    const num = InSystem.systemId[eid];
    const prev = this.trainers.get(eid);
    if (prev !== undefined && this.enemies.isAlive(prev)) return;
    if (!inSafeSpace(this.gameData.getSystemByNum(num), Position.x[eid], Position.y[eid]) || !(this.gameData.factionsFile as FactionsFile).factions?.helios) return;
    const a = Rotation.angle[eid];
    const [d] = this.enemies.spawnPack(num, { faction: 'helios', ships: ['helios_drone'], passive: true }, Position.x[eid] + Math.cos(a) * 1400, Position.y[eid] + Math.sin(a) * 1400);
    if (d !== undefined) this.trainers.set(eid, d);
  }

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

  /** A broken-up derelict comes back a while later (somebody always tows in another). */
  private derelictRespawnSystem(): void {
    if (this.currentTick % 60 !== 0) return;
    for (const slot of this.derelicts) {
      if (!this.memory.isResident(slot.systemNum)) continue;
      if (slot.eid >= 0 && !this.ships.has(slot.eid)) {
        slot.eid = -1;
        slot.respawnTick = this.currentTick + DERELICT_RESPAWN_TICKS;
      }
      if (slot.eid < 0 && slot.respawnTick && this.currentTick >= slot.respawnTick) {
        slot.respawnTick = 0;
        this.spawnDerelict(slot);
      }
    }
  }

  // ---- Tow Beam (game/Towing.ts): towed into a station's reach, a wreck, debris or a pod is salvaged into the pilot's storage
  private towDelivered(pilot: number, target: number, kind: TowKind): void {
    const pc = this.pilots.connOf(pilot);
    if (!pc) return;
    const tell = (text: string) => { for (const c of this.clients.values()) if (c.playerId === pilot) this.send(c.ws, { type: 'systemMessage', text, color: '#ffd166' }); };
    if (kind === 'pod') {
      const bag = this.pods.take(target);
      if (!bag) return;
      this.pilots.give(pc, bag, { toStorage: true, source: 'salvaged' });
      tell('Towed in a pod: its contents are in station storage');
      return;
    }
    const ship = this.ships.get(target);
    if (!ship) return;
    // Its structure cut up for plate (towTuning salvage of what it's made of), as a derelict's chunks are; modules aren't salvaged
    const share = towTuning(this.ships.tuning).salvage;
    const made: Bag = {};
    ship.blueprint.parts.forEach((q, i) => {
      if (!(ship.hp[i] > 0) || ship.detached[i] || !isStructural(q.fn)) return;
      for (const [id, n] of Object.entries(this.econ.recipes.partInputs(q))) made[id] = (made[id] ?? 0) + n * share;
    });
    const bag: Bag = {};
    for (const [id, n] of Object.entries(made)) if (Math.floor(n) > 0) bag[id] = Math.floor(n);
    const slot = this.derelicts.find((d) => d.eid === target);
    let credits = 0, name = kind === 'wreck' ? 'a wreck' : 'debris';
    if (slot) {
      slot.eid = -1;
      slot.respawnTick = this.currentTick + DERELICT_RESPAWN_TICKS;
      credits = slot.data.salvage ?? 250;
      name = slot.data.name;
      this.pilots.addCredits(pc, credits);
      this.pilots.addXp(pc, Math.round(credits / 4));
      if (slot.data.log) this.codex.unlock(pc, [slot.data.log.codex]);
    }
    this.ships.removeShip(target);
    if (Object.keys(bag).length) this.pilots.give(pc, bag, { toStorage: true, source: 'salvaged' });
    this.pilots.bumpStat(pc, 'salvaged');
    const n = Object.values(bag).reduce((t, k) => t + k, 0);
    tell(`Salvaged ${name}: ${n} plate to station storage${credits ? `, +${credits} credits` : ''}`);
  }
  // ---- (end Tow Beam)

  /** Whoever breaks a derelict's core gets its salvage: credits, and plate of its material */
  private onPilotlessShipDestroyed(eid: number, lastHitBy: number | undefined): void {
    const slot = this.derelicts.find((d) => d.eid === eid);
    if (!slot) return;
    slot.eid = -1;
    slot.respawnTick = this.currentTick + DERELICT_RESPAWN_TICKS;
    if (lastHitBy === undefined || !hasComponent(this.world, Player, lastHitBy)) return;
    const credits = slot.data.salvage ?? 250;
    const xp = Math.round(credits / 4);
    const pc = this.pilots.connOf(lastHitBy);
    // Cut up, it gives plate of what it was built from (and the wire in it), thrown out as chunks to pull in
    const bp = this.ships.library.get(slot.data.blueprint);
    if (bp) {
      const made: Bag = {};
      for (const q of bp.parts) {
        if (!isStructural(q.fn)) continue;
        for (const [id, n] of Object.entries(this.econ.recipes.partInputs(q))) made[id] = (made[id] ?? 0) + n * DERELICT_PLATE_SHARE;
      }
      const x = slot.data.position.x, y = slot.data.position.y;
      let i = 0;
      for (const [id, n] of Object.entries(made)) {
        let left = Math.floor(n);
        while (left > 0) {
          const k = Math.min(left, 6), a = i++ * 2.39996;
          this.pods.spawnChunk(slot.systemNum, x, y, Math.cos(a) * 2, Math.sin(a) * 2, { [id]: k }, lastHitBy);
          left -= k;
        }
      }
    }
    if (pc) {
      this.pilots.addCredits(pc, credits);
      this.pilots.addXp(pc, xp);
      this.pilots.bumpStat(pc, 'salvaged');
      if (slot.data.log) this.codex.unlock(pc, [slot.data.log.codex]);
    }
    for (const c of this.clients.values()) {
      if (c.playerId !== lastHitBy) continue;
      this.send(c.ws, { type: 'systemMessage', text: `Salvaged ${slot.data.name}: +${credits} credits, +${xp} XP`, color: '#ffd166' });
    }
  }

  private lifetimeSystem(): void {
    const entities = lifetimeQuery(this.world);
    
    for (const eid of entities) {
      Lifetime.remaining[eid]--;
      
      if (Lifetime.remaining[eid] <= 0) {
        if (hasComponent(this.world, Projectile, eid)) this.weapons.onExpire(eid);
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

  /** Get byte length of encoded message (string or ArrayBuffer) */
  private getMessageByteLength(data: string | ArrayBuffer | Uint8Array): number {
    if (typeof data === 'string') {
      return data.length; // Approximation for ASCII/UTF-8 JSON
    }
    return data.byteLength;
  }

  /**
   * Messages for a client wait in its outbox and go out together, one frame per
   * tick (or straight after handling one of its requests), instead of a frame each.
   */
  private outbox = new Map<ClientSocket, Uint8Array[]>();
  /** Inside a tick or a request: messages wait for the flush (outside, e.g. timers, they go at once) */
  private batching = 0;

  /**
   * Effects only for the eye and ear (hit sparks, damage numbers, parts blowing
   * off, bumps) needn't have a frame of their own: they wait (up to LAZY_TICKS)
   * to go with the next frame a client gets anyway, usually a snapshot. Saves
   * a packet's headers each time, for a delay of a tick or two.
   */
  private lazy = new Map<ClientSocket, { since: number; parts: Uint8Array[] }>();

  private send(ws: ClientSocket, msg: ServerMessage): void {
    if (ws.isOpen()) {
      const data = encodeServerMessage(msg);
      const byteLen = data.length;
      this.snapshotBytesSent += byteLen;
      this.bytesByType[msg.type] = (this.bytesByType[msg.type] || 0) + byteLen;
      // Pongs go at once: they measure the round trip
      if (msg.type === 'pong') { ws.send(serverFrame([data])); return; }
      this.queue(ws, data, LAZY_TYPES.has(msg.type));
    }
  }

  private queue(ws: ClientSocket, data: Uint8Array, lazy = false): void {
    if (!this.batching) { ws.send(serverFrame([data])); return; }
    if (lazy) {
      const l = this.lazy.get(ws);
      if (l) l.parts.push(data); else this.lazy.set(ws, { since: this.currentTick, parts: [data] });
      return;
    }
    const box = this.outbox.get(ws);
    if (box) box.push(data); else this.outbox.set(ws, [data]);
  }

  /** Send everything waiting: one frame per client (effects that can wait, wait: see lazy) */
  flushOutbox(): void {
    for (const [ws, box] of this.outbox) {
      const l = this.lazy.get(ws);
      if (l) this.lazy.delete(ws);
      if (ws.isOpen() && box.length) ws.send(serverFrame(l ? [...l.parts, ...box] : box));
    }
    this.outbox.clear();
    for (const [ws, l] of this.lazy) {
      if (!ws.isOpen()) { this.lazy.delete(ws); continue; }
      if (this.currentTick - l.since >= LAZY_TICKS) { ws.send(serverFrame(l.parts)); this.lazy.delete(ws); }
    }
  }

  /** Send the effects still waiting now (tests that look at a tick's messages straight after it) */
  flushLazy(): void {
    for (const [ws, l] of this.lazy) if (ws.isOpen()) ws.send(serverFrame(l.parts));
    this.lazy.clear();
  }

  private broadcastToSystem(systemId: number, msg: ServerMessage): void {
    const data = encodeServerMessage(msg);
    const byteLen = this.getMessageByteLength(data);
    let sent = 0;
    for (const client of this.clients.values()) {
      // (System first: the cheapest check, and it rules out most)
      if (InSystem.systemId[client.playerId] !== systemId) continue;
      if (!client.ws.isOpen() || !hasComponent(this.world, Player, client.playerId)) continue;
      
      this.queue(client.ws, data, LAZY_TYPES.has(msg.type));
      sent++;
    }
    const total = byteLen * sent;
    this.snapshotBytesSent += total;
    this.bytesByType[msg.type] = (this.bytesByType[msg.type] || 0) + total;
  }

  private broadcastProjectileHit(proj: number, x: number, y: number): void {
    this.broadcastNear(InSystem.systemId[proj], x, y, { type: 'projectileHit', id: proj, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 });
  }

  /**
   * Ship structure for one client: a full sync (blueprint and all) the first time
   * it sees a ship, a light one (part HP and what's detached) after each rebuild,
   * and part HP changes otherwise, all ships' in one message. Ships far from the
   * client wait until it comes near (it only sees them as dots out there).
   */
  /** Each ship's part HP as sent (to a tenth), worked out once a snapshot, and the snapshot it last changed at */
  private hpWire = new Map<number, { ship: ShipState; at: number; since: number; hp: number[] }>();
  private hpWireOf(id: number, ship: ShipState): { since: number; hp: number[] } {
    const e = this.hpWire.get(id);
    if (e && e.at === this.snapshotCount && e.ship === ship) return e;
    const hp = ship.hp.map(hpWire);
    const same = !!e && e.ship === ship && e.hp.length === hp.length && hp.every((h, i) => h === e.hp[i]);
    const next = { ship, at: this.snapshotCount, since: same ? e!.since : this.snapshotCount, hp };
    this.hpWire.set(id, next);
    return next;
  }

  /** A ship's structure as a sync sends it, worked out once a snapshot for every client that's synced to it (cleared each snapshot) */
  private syncWire = new Map<number, { ship: ShipState; rebuilds: number; hp: number[]; detached: number[]; ghosts?: number[]; maxHp?: number[]; design?: string }>();
  private syncWireOf(id: number, ship: ShipState): { hp: number[]; detached: number[]; ghosts?: number[]; maxHp?: number[]; design?: string } {
    const e = this.syncWire.get(id);
    if (e && e.ship === ship && e.rebuilds === ship.rebuilds) return e;
    const next = {
      ship, rebuilds: ship.rebuilds, hp: ship.rebuildHp.map(hpWire), detached: ship.detached.flatMap((d, i) => (d ? [i] : [])),
      ghosts: ship.ghost.some(Boolean) ? ship.ghost.flatMap((g, i) => (g ? [i] : [])) : undefined,
    };
    this.syncWire.set(id, next);
    return next;
  }

  private sendShipUpdates(conn: ClientConnection, systemId: number): void {
    for (const id of conn.shipSynced.keys()) {
      if (!this.ships.has(id)) { conn.shipSynced.delete(id); conn.shipHpSent.delete(id); }
    }
    const hps: [number, [number, number][]][] = [];
    // Ships out of view wait (the client keeps what it had, and catches up when one comes back). The view was
    // made this snapshot from the system's bodies in their order (updateShipView), so this goes in that order too
    for (const id of conn.shipView) {
      const ship = this.ships.bodies.get(id);
      if (!ship || InSystem.systemId[id] !== systemId) continue;
      let synced = conn.shipSynced.get(id);
      // A refit or respawn replaces the ShipState (its rebuild count restarts), so compare both
      if (!synced || synced.ship !== ship || synced.rebuilds !== ship.rebuilds) {
        const fresh = !synced || synced.ship !== ship;
        synced = { ship, rebuilds: ship.rebuilds };
        conn.shipSynced.set(id, synced);
        const sync = this.syncWireOf(id, ship);
        const hp = sync.hp;
        // After a rebuild the client has this ship's HP already, bar what changed since
        const had = fresh ? undefined : conn.shipHpSent.get(id);
        const hpd = had && had.length === hp.length ? hp.flatMap((h, i) => (had[i] !== h ? [[i, h] as [number, number]] : [])) : undefined;
        conn.shipHpSent.set(id, [...hp]);
        // A design this client has seen (another ship of it) goes by its hash
        const design = fresh ? (sync.design ??= designHash(ship.blueprint)) : undefined;
        const known = design !== undefined && conn.designs.has(design);
        if (design !== undefined) conn.designs.add(design);
        this.send(conn.ws, {
          type: 'shipSync',
          id,
          kind: ship.kind,
          blueprint: fresh && !known ? ship.blueprint : undefined,
          design,
          hp: hpd ? undefined : hp,
          hpd: hpd?.length ? hpd : undefined,
          maxHp: !hpd && ship.scaledHp ? (sync.maxHp ??= ship.maxHp.map(hpWire)) : undefined,
          detached: sync.detached,
          rebuilds: ship.rebuilds,
          ghosts: sync.ghosts,
        });
      }
      // HP for the visuals: to a tenth, and only what changed (nothing to look at if it hasn't changed since this client was last brought up to date)
      const wire = this.hpWireOf(id, ship);
      const at = synced.hpAt;
      synced.hpAt = this.snapshotCount;
      if (at !== undefined && at >= wire.since) continue;
      const sent = conn.shipHpSent.get(id)!;
      const changes: [number, number][] = [];
      for (let i = 0; i < wire.hp.length; i++) {
        const h = wire.hp[i];
        if (sent[i] !== h) { changes.push([i, h]); sent[i] = h; }
      }
      if (changes.length) hps.push([id, changes]);
    }
    if (hps.length) this.send(conn.ws, { type: 'shipHps', ships: hps });
  }

  /**
   * What every client in a system sees moving: players, ship bodies, hostiles,
   * projectiles and loot pods. Built once per system per snapshot and shared by
   * every client there; each row's key is its serialised state, so a client is
   * only sent what changed since its last snapshot.
   *
   * Projectiles fly in straight lines, so their key leaves out the position:
   * one is sent when it's fired and again only if its course changes (missiles).
   */
  private systemRows(num: number): SnapRow[] {
    const rows: SnapRow[] = [];
    // (Each key is interned: see internKey. Ships and projectiles are keyed by their values: rowKey)
    const add = (state: EntityState, kind: SnapRow['kind'], name?: string, key?: string) => {
      const row: SnapRow = { id: state.id, kind, x: state.x, y: state.y, state, name, key: key ?? this.internKey(state.id, JSON.stringify(state)) };
      rows.push(row);
      return row;
    };
    const names = new Map<number, string>();
    for (const c of this.clients.values()) names.set(c.playerId, c.username);
    for (const l of this.lingering.values()) names.set(l.conn.playerId, l.conn.username);

    for (const eid of playerQuery(this.world)) {
      if (InSystem.systemId[eid] !== num) continue;
      const beam = this.ships.beamState(eid);
      const heat = this.ships.heatState(eid);
      const ship = this.ships.get(eid);
      // (The charge, packed: the whole gauge, the core's store, and each store group's, energy.ts packCharge)
      const charge = packCharge(ship?.derived, this.ships.chargeOf(eid));
      const field = this.ships.jumpFieldState(eid);
      const row = add({
        id: eid,
        type: EntityType.Player,
        // Ship bodies are already rounded to SHIP_PRECISION each tick; these
        // must match it exactly so client prediction replays from server state
        x: quantizeShipValue('pos', Position.x[eid]),
        y: quantizeShipValue('pos', Position.y[eid]),
        angle: quantizeShipValue('angle', Rotation.angle[eid]),
        vx: quantizeShipValue('vel', Velocity.x[eid]),
        vy: quantizeShipValue('vel', Velocity.y[eid]),
        av: quantizeShipValue('angVel', ship?.angVel ?? 0),
        hp: Math.round(Health.current[eid]),
        maxHp: Math.round(Health.max[eid]),
        // data[0]: cursor/weapon state (see CURSOR_STATE.md); data[1]: the whole charge (the gauge); [10] the core's store, [11] how many
        // store groups, [15...] each group's charge (local circuits, reconciliation: energy.ts packCharge / unpackCharge)
        data: [
          packCursorWeaponState(Input.targetAngle[eid], beam.hit, this.ships.weaponBeamState(eid).on, beam.on),
          charge.total,
          Math.round(Input.cursorDist[eid]),     // turret convergence (cursor distance)
          ship?.jump ?? 0,                       // jump drive counter (reconciliation + effects)
          Math.round(this.ships.shieldFraction(eid) * 100), // shield charge %
          this.ships.empTicksLeft(eid),          // knocked out by an EMP: ticks left (prediction drifts that long)
          Math.round(heat.heat * 100),           // hottest beam weapon %
          heat.over ? 1 : 0,                     // a beam weapon overheated
          Math.round((ship?.jumpScale ?? 1) * 1000), // this jump's speed scale (prediction)
          field.flags,                           // in a charging field: 1 a star's ring, 2 a lodestone's (bits)
          charge.core,                           // [10] the core's store %
          charge.groups.length,                  // [11] store groups that follow from [15]
          field.prime,                           // a lodestone's priming left, ticks (prediction)
          warmthPercent(this.ships.warmthOf(eid)), // warmth % (common/src/ships/warmth.ts: the frost vignette, and the stage prediction flies and fires with)
          ship?.cargo ?? 0,                      // [14] the hold's cargo mass (common/src/ships/load.ts: prediction flies it)
          ...charge.groups,                      // [15...] each store group's charge % (CHARGE_GROUPS_AT)
          // After the groups (common/src/ships/strafer.ts pilotExtras): the Burst Strafer's dodge counter and way, what the Tow Beam tows (+1)
          ship?.dodge ?? 0, ship?.dodgeDir ?? 0, this.towing.wireOf(eid),
        ],
      }, 'player', names.get(eid));
      // Everyone else: status only (motion is replicated). data: [shield %, EMP'd, beam heat (tenths), overheated,
      // mining beam hit (tenths), weapon beam on, mining beam on, cursor distance (hundreds)]
      const status: EntityState = {
        id: eid, type: EntityType.Player, x: row.state.x, y: row.state.y, hp: row.state.hp, maxHp: row.state.maxHp,
        data: [Math.round(this.ships.shieldFraction(eid) * 20) * 5, this.ships.isEmped(eid) ? 1 : 0, Math.round(heat.heat * 10), heat.over ? 1 : 0,
          Math.round(beam.hit * 10), this.ships.weaponBeamState(eid).on ? 1 : 0, beam.on ? 1 : 0, Math.round(Input.cursorDist[eid] / 100),
          // [8] what its Tow Beam tows (entity id + 1, 0 none: game/Towing.ts)
          this.towing.wireOf(eid)],
      };
      row.other = { state: status, key: this.internKey(-1 - eid, `${status.hp},${status.maxHp},${status.data!.join(',')}`) };
    }

    // Ship bodies without a pilot (dummies, hostiles, freighters, wrecks, debris)
    for (const [eid] of this.ships.bodies) {
      if (hasComponent(this.world, Player, eid) || InSystem.systemId[eid] !== num) continue;
      const named = this.namedBody(eid);
      const foe = this.enemies.info(eid);
      // Status only: motion is replicated (where it is goes only for creating it on the client)
      // data: [kind (1 derelict, 2 traffic, 3 hostile, 0 other), shield %, EMP'd, faction index, 1 elite / 2 boss, core %, weapon beam on, hull %, rating, 1 calm (a passive pack, unprovoked),
      //        side (1 a ward, on the pilots' side; 2 a person's craft, out of every fight: canDamage, so clients' beams pass through as the server's do)]
      // Core and hull % go as 0: clients work them out from the part HP they have (ShipClient.fillHull)
      const side = this.personCraft.has(eid) ? 2 : this.wards.has(eid) ? 1 : 0;
      const data = [named?.kind ?? 0, Math.round(this.ships.shieldFraction(eid) * 100), this.ships.isEmped(eid) ? 1 : 0,
        foe?.factionIndex ?? -1, foe?.boss ? 2 : foe?.elite ? 1 : 0, 0, this.ships.weaponBeamState(eid).on ? 1 : 0, 0, Math.round(foe?.rating ?? 0), foe && this.enemies.isCalm(eid) ? 1 : 0, side];
      add({
        id: eid,
        type: EntityType.ShipBody,
        x: quantizeShipValue('pos', Position.x[eid]),
        y: quantizeShipValue('pos', Position.y[eid]),
        angle: quantizeShipValue('angle', Rotation.angle[eid]),
        data,
      }, 'ship', named?.name, this.rowKey(eid, data));
    }

    // Single-body enemies: where they are and their HP (data: [their kind's index in data/mobs.json])
    for (const eid of this.mobs.inSystem(num)) {
      const m = this.mobs.info(eid)!;
      const r1 = (v: number) => Math.round(v * 10) / 10;
      add({ id: eid, type: EntityType.Enemy, x: r1(Position.x[eid]), y: r1(Position.y[eid]), angle: Math.round(Rotation.angle[eid] * 1000) / 1000,
        vx: r1(Velocity.x[eid]), vy: r1(Velocity.y[eid]), hp: m.hp, maxHp: m.maxHp, data: [m.index] }, 'mob');
    }

    for (const eid of projectileQuery(this.world)) {
      if (InSystem.systemId[eid] !== num) continue;
      const ownerId = Projectile.ownerId[eid];
      const vx = Math.round(Velocity.x[eid] * 100) / 100, vy = Math.round(Velocity.y[eid] * 100) / 100;
      // data: [weaponType, tier, hue (golden-angle hash of the owner), spawnTick, spawnX, spawnY, ownerId, sizeScale, turret]
      const data = [
        Projectile.weaponType[eid], Projectile.tier[eid], (ownerId * 137) % 360, Projectile.spawnTick[eid],
        Math.round(Projectile.spawnX[eid] * 10) / 10, Math.round(Projectile.spawnY[eid] * 10) / 10,
        ownerId, Math.round((Projectile.sizeScale[eid] || 1) * 100) / 100, Projectile.turret[eid],
      ];
      // Where it is goes only if the client can't work it out (spawn + velocity × age: see GameState)
      const x = Math.round(Position.x[eid] * 100) / 100, y = Math.round(Position.y[eid] * 100) / 100;
      const off = (from: number) => Math.max(Math.abs(data[4] + vx * (this.currentTick - from) - x), Math.abs(data[5] + vy * (this.currentTick - from) - y));
      // (A pilot's shells move on the tick they're fired: they count from the tick before. The two are a
      // whole tick's flight apart, so the nearer is always the right one, and the row's key never flips.)
      if (off(data[3] - 1) < off(data[3])) data[3]--;
      // The rounded velocity drifts from the real one by up to 0.005 a tick
      const onLine = off(data[3]) < 0.5 + 0.006 * (this.currentTick - data[3]);
      const row = add({ id: eid, type: EntityType.Projectile, x: onLine ? undefined! : x, y: onLine ? undefined! : y, vx, vy, data },
        'projectile', undefined, this.rowKey(eid, [vx, vy, ...data]));
      row.x = x; row.y = y;
    }

    for (const eid of droppedItemQuery(this.world)) {
      if (InSystem.systemId[eid] !== num) continue;
      // A drifting pod goes once, as its drift anchor (data[3] its tick): clients work out the rest (podDrift)
      const a = this.pods.anchor(eid);
      const row = a
        ? add({ id: eid, type: EntityType.DroppedItem, x: Math.round(a.x * 10) / 10, y: Math.round(a.y * 10) / 10,
          vx: Math.round(a.vx * 1000) / 1000, vy: Math.round(a.vy * 1000) / 1000, data: [...this.pods.snapshotData(eid), a.t] }, 'pod')
        : add({ id: eid, type: EntityType.DroppedItem, x: Math.round(Position.x[eid]), y: Math.round(Position.y[eid]), data: this.pods.snapshotData(eid) }, 'pod');
      row.x = Position.x[eid]; row.y = Position.y[eid];
    }
    return rows;
  }

  /**
   * The rows' keys by entity (status keys by -1 - id), the last snapshot's and this one's (see systemRows). A key
   * that hasn't changed since the last snapshot is made the very string it was then, so each pilot's "changed?" test
   * in sendSnapshots is a pointer comparison rather than a character-by-character one.
   */
  private keysWere = new Map<number, { key: string; values?: readonly number[] }>();
  private keysNow = new Map<number, { key: string; values?: readonly number[] }>();
  private internKey(id: number, key: string): string {
    const was = this.keysWere.get(id)?.key;
    const k = was === key ? was : key;
    this.keysNow.set(id, { key: k });
    return k;
  }
  /** A row's key from its values (joined with commas), without joining them again while they're unchanged */
  private rowKey(id: number, values: readonly number[]): string {
    const was = this.keysWere.get(id);
    const same = !!was?.values && was.values.length === values.length && values.every((v, i) => v === was.values![i]);
    const key = same ? was!.key : values.join(',');
    this.keysNow.set(id, { key, values });
    return key;
  }

  private snapshotCount = 0;

  private sendSnapshots(): void {
    // Skip entirely when no clients are connected — avoids building
    // per-entity state objects and JSON keys for nothing.
    if (this.clients.size === 0) {
      this.pendingRemovedEntities.clear();
      this.ships.fired.length = 0;
      return;
    }
    this.snapshotCount++;
    for (const id of this.hpWire.keys()) if (!this.ships.has(id)) this.hpWire.delete(id);
    this.syncWire.clear();
    const bySystem = new Map<number, SnapRow[]>();
    this.replication.beginSnapshot();

    for (const conn of this.clients.values()) {
      // No snapshot this round: it misses the control changes, so it starts over with keyframes
      if (!conn.ws.isOpen() || !hasComponent(this.world, Player, conn.playerId)) { conn.repKnown.clear(); continue; }

      const playerSystemId = InSystem.systemId[conn.playerId];
      if (conn.lastSystemId !== playerSystemId) this.enterSystem(conn, playerSystemId);
      let rows = bySystem.get(playerSystemId);
      if (!rows) { rows = this.systemRows(playerSystemId); bySystem.set(playerSystemId, rows); }

      const entities: EntityState[] = [];
      const prevStates = this.lastEntityStates.get(conn.playerId) || new Map<number, string>();
      const newStates = new Map<number, string>();
      const markIfChanged = (state: EntityState) => {
        const key = JSON.stringify(state);
        newStates.set(state.id, key);
        if (prevStates.get(state.id) !== key) entities.push(state);
      };

      // Interest management: what's near is sent every snapshot; distant ships every few
      // (the client dead-reckons in between); distant projectiles and loot not at all
      const px = Position.x[conn.playerId], py = Position.y[conn.playerId];
      // Ships that left its view: it forgets them, and gets each again on its own when it comes back
      const out = this.updateShipView(conn, playerSystemId, px, py);
      // (its structure too: the client drops a ship it hasn't seen for a moment, so it's synced afresh when it comes back)
      for (const id of out) { conn.sentNames.delete(id); conn.shipSynced.delete(id); conn.shipHpSent.delete(id); }
      // Ship motion: keyframes where needed, control changes otherwise
      const rep = this.replication.forClient(playerSystemId, conn.playerId, conn.repKnown, this.currentTick, conn.shipView);
      // Shots from ships it replicates go as fire events: it builds the shells itself (launch.ts).
      // Not for a ship it's only now getting a keyframe for (it can't place it back then), nor its
      // own (predicted, not replicated); those shells, and any flying in from further off, go as rows.
      const keyed = new Set(rep.ships.map((k) => k[0]));
      const fire: number[][] = [];
      const covered = new Set<number>();
      for (const f of this.ships.fired) {
        if (f.owner === conn.playerId || !conn.shipView.has(f.owner) || keyed.has(f.owner) || !conn.repKnown.has(f.owner)) continue;
        if (InSystem.systemId[f.owner] !== playerSystemId) continue;
        // (the ammunition rides on the part: part + 256 × its code)
        fire.push([f.owner, this.currentTick - f.tick, f.part + 256 * (f.ammo ?? 0), f.aimQ, ...f.ids]);
        for (const id of f.ids) covered.add(id);
      }
      for (const r of rows) {
        if ((r.kind === 'player' || r.kind === 'ship') && !conn.shipView.has(r.id)) continue;
        if (r.kind === 'projectile' && covered.has(r.id)) { newStates.set(r.id, r.key); continue; }
        if ((r.kind === 'projectile' || r.kind === 'mob') && fartherThan(r.x - px, r.y - py, SNAP_PROJECTILE_RANGE)) continue;
        if (r.kind === 'pod' && fartherThan(r.x - px, r.y - py, SNAP_POD_RANGE)) continue;
        if (r.id === conn.playerId) {
          // Its own ship: only when its prediction needs correcting, its status changed (its warmth too), or now and then
          const d = r.state.data ?? [];
          const key = JSON.stringify([r.state.hp, r.state.maxHp, d[4], d[5], Math.round((d[6] ?? 0) / 10), d[7], d[9], d[13]]);
          const version = this.replication.versionOf(r.id);
          const need = conn.forceSnapshot || conn.selfLate || version !== conn.selfVersion || key !== conn.selfKey
            || this.currentTick - conn.selfSentTick >= SELF_SAFETY_TICKS || !prevStates.has(r.id);
          newStates.set(r.id, 'self');
          if (!need) continue;
          conn.selfLate = false;
          conn.selfVersion = version;
          conn.selfKey = key;
          conn.selfSentTick = this.currentTick;
        }
        let v = r.other && r.id !== conn.playerId ? r.other : r;
        if (r.id !== conn.playerId) {
          newStates.set(r.id, v.key);
          if (prevStates.get(r.id) === v.key) continue;
          // Another ship it already has: its motion is replicated, so the status goes without where it is
          if ((r.kind === 'player' || r.kind === 'ship') && prevStates.has(r.id)) {
            v = { ...v, state: { ...v.state, x: undefined!, y: undefined!, angle: undefined } };
          }
        }
        // Names go once (the client keeps them)
        if (r.name !== undefined && conn.sentNames.get(r.id) !== r.name) {
          conn.sentNames.set(r.id, r.name);
          entities.push({ ...v.state, name: r.name });
        } else {
          entities.push(v.state);
        }
      }
      // Ship structure: full sync on first sight and after every rebuild, HP deltas otherwise
      this.sendShipUpdates(conn, playerSystemId);

      // Stations — sent once per system (they never move)
      for (const eid of stationQuery(this.world)) {
        if (InSystem.systemId[eid] !== playerSystemId) continue;
        if (conn.knownEntities.has(eid)) continue;
        conn.knownEntities.add(eid);
        // data: [stationId, orbitType (255 = fixed), a, e, argP, M0, epoch, orbitTimeScale, radius, design, turrets, weapon]
        const def = this.gameData.getStationByNum(Station.stationId[eid]);
        markIfChanged({
          id: eid,
          type: EntityType.Station,
          x: Math.round(Position.x[eid]),
          y: Math.round(Position.y[eid]),
          data: [Station.stationId[eid], Station.orbitType[eid], Station.semiMajorAxis[eid], Station.eccentricity[eid], Station.argPeriapsis[eid],
            Station.meanAnomaly0[eid], Station.epochTick[eid], Station.orbitTimeScale[eid], Radius.value[eid],
            Math.max(0, STATION_DESIGNS.indexOf(def?.design ?? 'ring')), def?.defence?.turrets ?? 0, Math.max(0, STATION_WEAPONS.indexOf(def?.defence?.weapon ?? 'laser'))],
          name: def?.name,
        });
      }

      // Portals — sent once per system (they never move)
      for (const eid of portalQuery(this.world)) {
        if (InSystem.systemId[eid] !== playerSystemId) continue;
        if (conn.knownEntities.has(eid)) continue;
        conn.knownEntities.add(eid);
        markIfChanged({ id: eid, type: EntityType.Portal, x: Math.round(Position.x[eid]), y: Math.round(Position.y[eid]), data: [Portal.targetSystem[eid], Portal.kind[eid], Portal.hue[eid]] });
      }

      // Removals this client cares about: things in its system, or that it was sent
      const removed: number[] = [];
      for (const [eid, sys] of this.pendingRemovedEntities) {
        if (sys !== playerSystemId && !prevStates.has(eid) && !conn.knownEntities.has(eid)) continue;
        removed.push(eid);
        conn.sentNames.delete(eid);
        conn.mapNamed.delete(eid);
      }

      // HUD numbers (fuel, XP) once a second, whether or not anything else goes
      if (this.currentTick % 60 === 0) this.sendPlayerState(conn);

      const shouldSend = conn.forceSnapshot || entities.length > 0 || removed.length > 0 || rep.ships.length > 0 || rep.ctl.length > 0 || out.length > 0 || fire.length > 0;
      if (!shouldSend) {
        this.lastEntityStates.set(conn.playerId, newStates);
        continue;
      }

      this.send(conn.ws, {
        type: 'snapshot',
        tick: this.currentTick,
        lastProcessedInput: conn.lastInputSeq,
        entities,
        removed,
        ships: rep.ships.length ? rep.ships : undefined,
        ctl: rep.ctl.length ? rep.ctl : undefined,
        out: out.length ? out : undefined,
        fire: fire.length ? fire : undefined,
      });

      conn.forceSnapshot = false;
      conn.lastSnapshotSentTick = this.currentTick;
      this.lastEntityStates.set(conn.playerId, newStates);
    }

    // Clear pending removed entities after sending to all clients
    // Also remove from knownEntities so they can be re-sent if respawned
    for (const [eid] of this.pendingRemovedEntities) {
      for (const conn of this.clients.values()) conn.knownEntities.delete(eid);
    }
    this.pendingRemovedEntities.clear();
    this.replication.endSnapshot();
    this.ships.fired.length = 0;
    [this.keysWere, this.keysNow] = [this.keysNow, this.keysWere];
    this.keysNow.clear();
    const dotsDue = this.currentTick - this.lastMapDotsTick >= MAP_DOTS_TICKS;
    if (dotsDue) this.lastMapDotsTick = this.currentTick;
    this.sendMapDots(dotsDue);
  }

  private lastMapDotsTick = -Infinity;

  /**
   * The system map's ships past the snapshot's ship view, once a second to
   * clients with their map open (mapView): derelicts, traffic, hostiles
   * (distant ones too: ships/SimLod.ts) and other pilots. Only what's changed
   * goes: each dot is a leg in closed form the client carries on exactly as
   * it's reckoned here (common ships/farRoute.ts), or for one on patrol round
   * a home that stays put, the patrol itself (the client works out its legs
   * as SimLod does). So a distant ship is sent again only when its route
   * changes (a patrol not at all while it's on it), a live one when it's
   * strayed MAP_DOT_SLACK from where the client has it; a new one's look
   * (kind, rank, faction, rating) once and when it changes, and the ones gone.
   */
  private sendMapDots(due: boolean): void {
    type Row = { eid: number; name?: string; look: number; rating: number; leg: Leg; seq: number; patrol?: NonNullable<ReturnType<SimLod['track']>>['patrol'] };
    const bySystem = new Map<number, Row[]>();
    const rowsFor = (num: number) => {
      let rows = bySystem.get(num);
      if (rows) return rows;
      rows = [];
      const add = (eid: number, kind: number, name: string | undefined, foe?: ReturnType<Enemies['info']>) => {
        // A distant ship's leg from its route; a live one's as it's going now, held
        const far = this.lod.track(eid);
        const leg = far?.leg ?? { x: Position.x[eid], y: Position.y[eid], vx: Velocity.x[eid], vy: Velocity.y[eid], wx: Velocity.x[eid], wy: Velocity.y[eid], thrust: -1 };
        const look = mapDotFlags({ kind, rank: foe?.boss ? 2 : foe?.elite ? 1 : 0, calm: !!foe && this.enemies.isCalm(eid), faction: foe?.factionIndex ?? -1 });
        rows!.push({ eid, name, look, rating: Math.round(foe?.rating ?? 0), leg, seq: far?.seq ?? -1, patrol: far?.patrol });
      };
      for (const [eid, ship] of this.ships.bodies) {
        if (InSystem.systemId[eid] !== num || ship.kind !== 'ship' || hasComponent(this.world, Player, eid)) continue;
        const named = this.namedBody(eid);
        if (named) add(eid, named.kind, named.name, named.kind === 3 ? this.enemies.info(eid) : undefined);
      }
      // Other pilots, wherever they are in the system
      for (const c of this.clients.values()) if (this.flying(c.playerId) && InSystem.systemId[c.playerId] === num) add(c.playerId, 4, c.username);
      bySystem.set(num, rows);
      return rows;
    };
    const now = this.currentTick;
    for (const conn of this.clients.values()) {
      if (!conn.mapOpen || !(due || conn.mapDotsDue) || !conn.ws.isOpen() || !hasComponent(this.world, Player, conn.playerId)) continue;
      conn.mapDotsDue = false;
      const sent = (conn.mapSent ??= new Map());
      const full = conn.mapFresh === true;
      conn.mapFresh = false;
      const dots: number[] = [], routes: number[] = [], info: number[] = [], gone: number[] = [];
      const names: (number | string)[] = [];
      const on = new Set<number>();
      for (const r of rowsFor(InSystem.systemId[conn.playerId])) {
        if (r.eid === conn.playerId || conn.shipView.has(r.eid)) continue;
        on.add(r.eid);
        const was = sent.get(r.eid);
        // (A live one: how far it's strayed from where the client has it, carried on along what it was sent)
        const off = was && r.seq < 0 ? (() => { const p = legAt(was.leg, now - was.tick); return Math.hypot(p.x - r.leg.x, p.y - r.leg.y); })() : 0;
        if (!was || was.seq !== r.seq || off > MAP_DOT_SLACK) {
          const at = dots.length;
          if (r.patrol) packMapRoute(routes, r.eid, now, r.patrol.p, r.patrol.s);
          else packMapLeg(dots, r.eid, r.leg);
          sent.set(r.eid, { leg: r.patrol ? r.leg : unpackMapLegs(dots.slice(at))[0].leg, tick: now, seq: r.seq, look: was?.look ?? -1 });
        }
        const s = sent.get(r.eid)!;
        if (s.look !== r.look * 4096 + r.rating) { s.look = r.look * 4096 + r.rating; info.push(r.eid, r.look, r.rating); }
        if (r.name && !conn.mapNamed.has(r.eid)) { conn.mapNamed.add(r.eid); names.push(r.eid, r.name); }
      }
      for (const id of sent.keys()) if (!on.has(id)) { gone.push(id); sent.delete(id); }
      // (Nothing's changed: nothing to say)
      if (!full && !dots.length && !routes.length && !info.length && !gone.length && !names.length) continue;
      this.send(conn.ws, { type: 'mapDots', tick: now, dots, ...(routes.length ? { routes } : {}), ...(info.length ? { info } : {}), ...(gone.length ? { gone } : {}), ...(names.length ? { names } : {}), ...(full ? { full: 1 as const } : {}) });
    }
  }

  /**
   * Which of a system's ships a client sees (see SHIP_VIEW_IN): updates its view
   * and returns the ships that just left it.
   */
  private updateShipView(conn: ClientConnection, systemId: number, px: number, py: number): number[] {
    const was = conn.shipView;
    const now = new Set<number>();
    const party = this.party.partyId(conn) ? new Set(this.party.members(conn).map((m) => m.playerId)) : null;
    const target = this.ships.targetOf(conn.playerId);
    const left: number[] = [];
    for (const eid of this.ships.bodies.keys()) {
      if (InSystem.systemId[eid] !== systemId) continue;
      if (eid === conn.playerId || nearerThan(Position.x[eid] - px, Position.y[eid] - py, was.has(eid) ? SHIP_VIEW_OUT : SHIP_VIEW_IN) || party?.has(eid) || eid === target) now.add(eid);
      else if (was.has(eid)) left.push(eid);
    }
    // (Ships gone from the system entirely are removals, sent as before)
    conn.shipView = now;
    return left;
  }

  /** Clients in a system near a point (combat effects: nobody further out has the ships involved) */
  private broadcastNear(systemId: number, x: number, y: number, msg: ServerMessage, also: number[] = []): void {
    const data = encodeServerMessage(msg);
    for (const client of this.clients.values()) {
      if (InSystem.systemId[client.playerId] !== systemId) continue;
      if (!client.ws.isOpen() || !hasComponent(this.world, Player, client.playerId)) continue;
      const pid = client.playerId;
      if (Math.hypot(Position.x[pid] - x, Position.y[pid] - y) > FX_RANGE && !also.includes(pid)) continue;
      this.queue(client.ws, data, LAZY_TYPES.has(msg.type));
      this.snapshotBytesSent += this.getMessageByteLength(data);
    }
  }

  /** A client's first snapshot in a system: world events, the asteroid seed, and a clean slate */
  private enterSystem(conn: ClientConnection, playerSystemId: number): void {
    conn.lastSystemId = playerSystemId;
    for (const m of this.events.briefing(playerSystemId)) this.send(conn.ws, m);
    for (const m of this.surfaces.briefing(playerSystemId)) this.send(conn.ws, m);
    conn.knownEntities.clear();
    conn.shipSynced.clear();
    conn.shipHpSent.clear();
    conn.sentNames.clear();
    conn.repKnown.clear();
    conn.shipView.clear();
    conn.mapNamed.clear();
    conn.mapSent?.clear();
    conn.mapFresh = true;

    const systemData = this.gameData.getSystemByNum(playerSystemId);
    const belt = systemData?.asteroidBelt;
    const idsAll = this.asteroidIdsBySystem.get(playerSystemId) || [];
    const alive = idsAll.filter(eid => entityExists(this.world, eid) && !hasComponent(this.world, Dead, eid));
    // The seed only describes the original belt; asteroids that grew back follow as spawns
    const ids = alive.filter(eid => !this.respawnedAsteroids.has(eid));
    const regrown = alive.filter(eid => this.respawnedAsteroids.has(eid));
    const indices = ids.map(eid => this.asteroidIndexById.get(eid) ?? 0);
    const seedTick = this.asteroidSeedTickBySystem.get(playerSystemId) ?? this.currentTick;

    if (belt && ids.length > 0) {
      for (const id of ids) conn.knownEntities.add(id);
      this.send(conn.ws, {
        type: 'asteroidSeed',
        tick: seedTick,
        systemId: systemData?.id || String(playerSystemId),
        seed: ASTEROID_SEED,
        belt: {
          innerRadius: belt.innerRadius,
          outerRadius: belt.outerRadius,
          count: belt.count,
          // (A still field's rocks are placed from these too)
          ...(belt.stationary ? { stationary: true } : {}),
          ...(belt.lane ? { lane: belt.lane } : {}),
          ...(belt.extra ? { extra: belt.extra } : {}),
        },
        asteroidField: systemData?.asteroidField,
        ids,
        indices,
      } as ServerAsteroidSeedMessage);
      if (regrown.length) {
        for (const id of regrown) conn.knownEntities.add(id);
        this.send(conn.ws, { type: 'asteroidSpawn', tick: this.currentTick, asteroids: regrown.map((eid) => this.asteroidSpawnData(eid)) });
      }
    }
  }

  private sendPlayerState(conn: ClientConnection): void {
    const eid = conn.playerId;
    if (!hasComponent(this.world, Player, eid)) return;
    
    const systemData = this.gameData.getSystemByNum(InSystem.systemId[eid]);
    
    const state: ServerMessage = {
      type: 'playerState',
      hp: Math.round(Health.current[eid]),
      maxHp: Math.round(Health.max[eid]),
      boostFuel: Math.round(Boost.fuel[eid] * 10) / 10,
      maxBoostFuel: Math.round(Boost.maxFuel[eid] * 10) / 10,
      xp: Player.xp[eid],
      level: Player.level[eid],
      credits: Player.credits[eid],
      systemId: systemData?.id || 'sol',
    };
    // Only when something changed (or now and then, in case)
    const key = JSON.stringify(state);
    if (key !== conn.playerStateKey || this.currentTick % 600 === 0) {
      conn.playerStateKey = key;
      this.send(conn.ws, state);
    }

    // Push data-driven system visuals whenever the player's system changes
    if (systemData && conn.lastSystemInfoId !== systemData.id) {
      conn.lastSystemInfoId = systemData.id;
      this.sendSystemInfo(conn, systemData);
    }
  }

  /**
   * Send data-driven system visuals (central body + background config)
   * to a client. Derived from systems.json with sensible defaults.
   */
  /**
   * What replicas and the jump drive's fields need of a system (built once each:
   * none of it changes). The empty scene has no lodestones (systemInfo sends none).
   */
  /** A system's rock (a surface's terrain), or undefined */
  terrainOf(num: number): Terrain | undefined {
    const id = this.gameData.getSystemByNum(num)?.id;
    return id ? this.gameData.terrain(id) : undefined;
  }

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

  private sendSystemInfo(conn: ClientConnection, system: StarSystemData): void {
    const cb = system.centralBody;
    // Default: a sun derived from starColor/starRadius. The empty scene has no central body.
    const centralBody = this.scene === 'empty'
      ? { type: 'none' as const, radius: 0, hue: 0 }
      : cb
      ? { ...cb }
      : {
          type: 'sun' as const,
          radius: system.starRadius,
          hue: hexToHue(system.starColor),
        };

    this.send(conn.ws, {
      type: 'systemInfo',
      systemId: system.id,
      name: system.name,
      sector: system.sector,
      centralBody,
      visuals: system.visuals ?? {},
      hazards: this.scene === 'empty' ? [] : system.hazards ?? [],
      // (Prediction charges the jump drive in their fields exactly as the server does)
      ...(this.scene !== 'empty' && system.lodestones?.length ? { lodestones: system.lodestones } : {}),
      ...(this.scene !== 'empty' && system.hazardRatings ? { hazardRatings: system.hazardRatings, hazardRadius: system.starRadius } : {}),
    });
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
  async handleHttpAuth(req: IncomingMessage, res: ServerResponse, action: 'register' | 'login' | 'validate', address?: string): Promise<void> {
    // (A sign-in is a few hundred bytes: anything past 16 KB is refused, not held in memory)
    let body = '', tooBig = false;
    req.on('data', (chunk: { toString(): string }) => {
      if (tooBig) return;
      body += chunk.toString();
      if (body.length > 16 * 1024) { tooBig = true; body = ''; }
    });
    req.on('error', () => {});
    req.on('end', async () => {
      try {
        if (tooBig) throw new Error('request too large');
        const data = JSON.parse(body);
        if (!data || typeof data !== 'object') throw new Error('not an object');
        res.setHeader('Content-Type', 'application/json');

        if (action === 'register') {
          const result = await this.userDB.register(data.username, data.email, data.password, address);
          if (result.success) {
            res.writeHead(200);
            res.end(JSON.stringify({ success: true, username: result.user.username, token: result.token, isAdmin: result.user.is_admin }));
          } else {
            res.writeHead(400);
            res.end(JSON.stringify({ success: false, error: result.error }));
          }
        } else if (action === 'login') {
          const result = await this.userDB.login(data.username, data.password, address);
          if (result.success) {
            res.writeHead(200);
            res.end(JSON.stringify({ success: true, username: result.user.username, token: result.token, isAdmin: result.user.is_admin }));
          } else {
            res.writeHead(400);
            res.end(JSON.stringify({ success: false, error: result.error }));
          }
        } else if (action === 'validate') {
          const user = await this.userDB.validateSession(data.token);
          if (user) {
            res.writeHead(200);
            res.end(JSON.stringify({ success: true, username: user.username, isAdmin: user.is_admin }));
          } else {
            res.writeHead(401);
            res.end(JSON.stringify({ success: false, error: 'Invalid or expired session' }));
          }
        }
      } catch (e) {
        if (res.headersSent) { res.end(); return; }
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'Invalid request' }));
      }
    });
  }

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
        snapshotBytes: this.snapshotBytesSent,
        bytesByType: { ...this.bytesByType },
        connectionsTotal: this.totalConnectionsEver,
        errors: this.recentErrors.slice(-10),
        playerList: this.admin.players(),
      };
      
      // Send to all admin clients
      if (adminStatsMsg) for (const c of admins) this.send(c.ws, adminStatsMsg as any);
      
      // Reset byte counters
      this.snapshotBytesSent = 0;
      this.bytesByType = {};
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
