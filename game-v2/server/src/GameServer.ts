/**
 * Game Server - Main server with ECS world and systems
 */

import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import {
  createWorld,
  addEntity,
  removeEntity,
  addComponent,
  hasComponent,
  defineQuery,
  enterQuery,
  exitQuery,
  IWorld,
} from 'bitecs';

import {
  // Components
  Position,
  Velocity,
  Rotation,
  Radius,
  Health,
  Shield,
  Lifetime,
  Player,
  Input,
  Boost,
  Equipment,
  EquipmentStats,
  Inventory,
  WeaponState,
  Projectile,
  Bullet,
  Laser,
  Missile,
  Pulse,
  Mine,
  MiningShot,
  WarpBeacon,
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
  SNAPSHOT_MS,
  WORLD_SIZE,
  ACCEL_BASE,
  TURN_SPEED,
  FRICTION,
  BOOST_FACTOR,
  BOOST_DRAIN,
  BOOST_REGEN,
  BOOST_REGEN_DELAY,
  BOOST_FUEL_DEFAULT,
  PLAYER_MAX_HP,
  PLAYER_RADIUS,
  PLAYER_REGEN_RATE,
  PLAYER_REGEN_DELAY_TICKS,
  PLAYER_MAX_SHIELD,
  PLAYER_SHIELD_REGEN,
  PLAYER_SHIELD_REGEN_DELAY,
  BULLET_SPEED,
  BULLET_DAMAGE,
  FIRE_COOLDOWN_TICKS,
  BLASTER_LIFE_TICKS,
  LASER_RANGE,
  LASER_DAMAGE_MAX,
  LASER_TICK_COOLDOWN,
  MISSILE_SPEED,
  MISSILE_FUEL_TICKS,
  MISSILE_TURN_RATE,
  MISSILE_ACCEL,
  MISSILE_DAMPING,
  SCATTER_LIFE_TICKS,
  SCATTER_FRICTION,
  MINE_ARM_TICKS,
  MINE_LIFE_TICKS,
  MINE_SPLASH_RADIUS,
  ICE_SPRITE_MAX_COUNT,
  ICE_SPRITE_SPAWN_INTERVAL,
  ICE_SPRITE_SPAWN_RADIUS_MIN,
  ICE_SPRITE_SPAWN_RADIUS_MAX,
  ASTEROID_SEED,
  ITEM_LIFETIME_TICKS,
  ITEM_FRICTION,
  STATION_INTERACT_RADIUS,
  NPC_INTERACT_RADIUS,
  xpForLevel,
  MAX_LEVEL,
  makeAsteroidParams,
  makeAsteroidParamsFromField,
  calcAsteroidPosition,
  OrbitType,
  asteroidRegistry,
} from '@space-game/common';

import {
  ClientMessage,
  ServerMessage,
  EntityState,
  EntityType,
  encodeMessage,
  decodeMessage,
  ServerAsteroidSeedMessage,
  ServerAsteroidDebugMessage,
  EffectType,
  computeStateHash,
  packCursorWeaponState,
  quantizeCursorAngle,
  dequantizeCursorAngle,
  // Shared polygon & collision helpers (used by both fireLaser and projectile collision)
  getAsteroidPolygon,
  raycastPolygon,
  segmentIntersectT,
  pointInPolygon,
  hashString,
  mulberry32,
  cross2,
  // Shared physics for exact client/server parity
  stepPlayerPhysics,
  PhysicsState,
  PhysicsInput,
} from '@space-game/common';

import { GameData } from './data/GameData.js';
import { UserDB } from './UserDB.js';

// ============================================
// SPATIAL PARTITIONING
// ============================================

const SPATIAL_CHUNK_SIZE = 500;

interface SpatialEntity {
  id: number;
  x: number;
  y: number;
  radius: number;
  type: 'asteroid' | 'enemy' | 'player' | 'projectile' | 'item';
}

class SpatialGrid {
  private grid: Map<string, SpatialEntity[]> = new Map();
  
  clear(): void {
    this.grid.clear();
  }
  
  add(entity: SpatialEntity): void {
    const minCx = Math.floor((entity.x - entity.radius + WORLD_SIZE) / SPATIAL_CHUNK_SIZE);
    const maxCx = Math.floor((entity.x + entity.radius + WORLD_SIZE) / SPATIAL_CHUNK_SIZE);
    const minCy = Math.floor((entity.y - entity.radius + WORLD_SIZE) / SPATIAL_CHUNK_SIZE);
    const maxCy = Math.floor((entity.y + entity.radius + WORLD_SIZE) / SPATIAL_CHUNK_SIZE);
    
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        const key = `${cx},${cy}`;
        if (!this.grid.has(key)) {
          this.grid.set(key, []);
        }
        this.grid.get(key)!.push(entity);
      }
    }
  }
  
  query(x1: number, y1: number, x2: number, y2: number, padding: number = 0): SpatialEntity[] {
    const minX = Math.min(x1, x2) - padding;
    const maxX = Math.max(x1, x2) + padding;
    const minY = Math.min(y1, y2) - padding;
    const maxY = Math.max(y1, y2) + padding;
    
    const minCx = Math.floor((minX + WORLD_SIZE) / SPATIAL_CHUNK_SIZE);
    const maxCx = Math.floor((maxX + WORLD_SIZE) / SPATIAL_CHUNK_SIZE);
    const minCy = Math.floor((minY + WORLD_SIZE) / SPATIAL_CHUNK_SIZE);
    const maxCy = Math.floor((maxY + WORLD_SIZE) / SPATIAL_CHUNK_SIZE);
    
    const seen = new Set<number>();
    const result: SpatialEntity[] = [];
    
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        const key = `${cx},${cy}`;
        const chunk = this.grid.get(key);
        if (chunk) {
          for (const entity of chunk) {
            if (!seen.has(entity.id)) {
              seen.add(entity.id);
              result.push(entity);
            }
          }
        }
      }
    }
    
    return result;
  }
  
  queryRay(x1: number, y1: number, x2: number, y2: number, padding: number = 0): SpatialEntity[] {
    // Query all chunks along the ray path
    return this.query(x1, y1, x2, y2, padding);
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
};

// ============================================
// QUERIES
// ============================================

const playerQuery = defineQuery([Player, Position, Velocity, Rotation, Input, Health, Boost]);
const projectileQuery = defineQuery([Projectile, Position, Velocity, Lifetime]);
const bulletQuery = defineQuery([Bullet, Position, Velocity]);
const missileQuery = defineQuery([Missile, Position, Velocity]);
const mineQuery = defineQuery([Mine, Position]);
const miningProjectileQuery = defineQuery([MiningShot, Position, Velocity, Projectile]);
const enemyQuery = defineQuery([Enemy, AI, Position, Velocity, Health]);
const asteroidQuery = defineQuery([Asteroid, Position]);
const droppedItemQuery = defineQuery([DroppedItem, Position, Velocity, Lifetime]);
const stationQuery = defineQuery([Station, Position]);
const portalQuery = defineQuery([Portal, Position]);
const npcQuery = defineQuery([NPC, Position]);
const lifetimeQuery = defineQuery([Lifetime]);
const deadQuery = defineQuery([Dead]);

// Enter/exit queries for tracking removed entities
const playerEnter = enterQuery(playerQuery);
const playerExit = exitQuery(playerQuery);
const deadEnter = enterQuery(deadQuery);

// ============================================
// CLIENT CONNECTION
// ============================================

interface PlayerQuestState {
  questId: string;
  stageIndex: number;
  progress: number; // Current progress for this stage
  startedAt: number; // Tick when quest started
}

interface ClientConnection {
  ws: WebSocket;
  playerId: number;  // Entity ID
  lastInputSeq: number;
  lastPingTime: number;
  ping: number;
  username: string;  // Player display name
  userId: number | null;  // DB user ID (null for guests)
  isAdmin: boolean;
  authToken: string | null;
  knownEntities: Set<number>;   // Entity IDs already sent one-time to this client (asteroids, stations, portals, NPCs)
  lastSystemId: number;         // Last system ID — clear knownEntities on change
  /** Per-player scheduled input buffer. Inputs held until targetTick <= currentTick. */
  scheduledInputs: Array<{ targetTick: number; msg: any }>;
  forceSnapshot: boolean;
  lastSnapshotSentTick: number;
}

// ============================================
// GAME SERVER
// ============================================

import { AdminServer } from './AdminServer.js';

export class GameServer {
  private world: IWorld;
  private gameData: GameData;
  private wss: WebSocketServer;
  private clients: Map<WebSocket, ClientConnection> = new Map();
  private clientIdCounter = 1;
  
  private currentTick = 0;
  private lastTickTime = 0;
  private tickAccumulator = 0;
  
  private lastSnapshotTick = 0;
  
  // Input queue — messages arrive instantly between ticks, get applied at tick boundaries
  private inputQueue: Array<{ conn: ClientConnection; msg: any }> = [];
  
  // Tracks entities that died this tick (for snapshot removal notifications)
  private pendingRemovedEntities: Set<number> = new Set();
  
  // Spatial partitioning for efficient collision detection
  private spatialGrid: SpatialGrid = new SpatialGrid();

  // Deterministic asteroid ids per system (systemNum -> asteroid ids)
  private asteroidIdsBySystem: Map<number, number[]> = new Map();
  private asteroidSeedTickBySystem: Map<number, number> = new Map();
  private asteroidIndexById: Map<number, number> = new Map();
  
  // Entity state cache for delta compression
  private lastEntityStates: Map<number, Map<number, string>> = new Map(); // playerId -> entityId -> serialized state
  
  // System-specific state
  private enemySpawnTimers: Map<string, number> = new Map();
  private systemEnemyCounts: Map<string, number> = new Map();
  
  // NPC ID mapping (npcId number -> npc string id)
  private npcIdMap: Map<number, string> = new Map();
  private nextNpcId = 1;
  
  // Player quest state (playerId -> quest data)
  private playerQuests: Map<number, { active: Map<string, PlayerQuestState>, completed: string[] }> = new Map();
  
  // Player bank storage (playerId -> array of {itemNum, count})
  private playerBanks: Map<number, { itemNum: number, count: number }[]> = new Map();
  private static readonly BANK_SIZE = 20; // 20 bank slots
  
  // Admin server for dev tools
  private adminServer: AdminServer | null = null;
  
  // User database for auth
  private userDB: UserDB;
  
  // Error tracking for admin stats
  private recentErrors: string[] = [];
  private static readonly MAX_ERRORS = 50;
  private tickTimeHistory: number[] = [];
  private snapshotBytesSent = 0;
  private bytesByType: Record<string, number> = {};
  private totalConnectionsEver = 0;
  
  // HTTP server for health checks and WebSocket upgrade
  private httpServer: http.Server;

  constructor(port: number, dataPath: string, adminServer?: AdminServer | null) {
    this.world = createWorld();
    this.gameData = new GameData(dataPath);
    this.adminServer = adminServer || null;
    this.userDB = new UserDB(dataPath + '/users.db');
    
    // Hook up admin server events
    if (this.adminServer) {
      this.setupAdminHandlers();
    }
    
    // Create HTTP server for health checks, auth, and WebSocket upgrade
    this.httpServer = http.createServer((req, res) => {
      // CORS headers for all responses
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      
      // Handle preflight
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }
      
      // Health check endpoint for Fly.io
      if (req.url === '/health' || req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', players: this.getPlayerCount() }));
        return;
      }

      // Auth endpoints
      if (req.method === 'POST' && req.url === '/auth/register') {
        this.handleAuthRequest(req, res, 'register');
        return;
      }
      if (req.method === 'POST' && req.url === '/auth/login') {
        this.handleAuthRequest(req, res, 'login');
        return;
      }
      if (req.method === 'POST' && req.url === '/auth/validate') {
        this.handleAuthRequest(req, res, 'validate');
        return;
      }

      res.writeHead(404);
      res.end();
    });
    
    // Initialize WebSocket server attached to HTTP server
    this.wss = new WebSocketServer({ server: this.httpServer });
    this.wss.on('connection', this.handleConnection.bind(this));
    
    // Start HTTP server
    this.httpServer.listen(port, () => {
      console.log(`Game server started on port ${port}`);
    });
    
    // Initialize world
    this.initializeWorld();
    
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
    this.lastTickTime = performance.now();
    this.gameLoop();
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
      
      // Create NPCs
      for (const npcId of system.npcs) {
        const npcData = this.gameData.getNPC(npcId);
        if (npcData) {
          this.createNPC(npcData, systemNum);
        }
      }
      
      // Create portals
      for (const portalData of system.portals) {
        this.createPortal(portalData, systemNum);
      }
      
      // Create asteroids
      this.createAsteroids(system, systemNum);
      
      // Initialize enemy spawn timers
      for (const enemyId of system.enemies) {
        this.enemySpawnTimers.set(`${system.id}_${enemyId}`, 0);
        this.systemEnemyCounts.set(`${system.id}_${enemyId}`, 0);
      }
    }
    
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
      const { x, y } = calcAsteroidPosition({
        orbitType,
        semiMajorAxis,
        eccentricity,
        argPeriapsis,
        meanAnomaly0,
        epochTick,
      }, this.currentTick);
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
    }
    Radius.value[eid] = data.radius;
    Station.stationId[eid] = this.gameData.getStationNum(data.id) || 0;
    Station.dockingRadius[eid] = data.dockingRadius;
    InSystem.systemId[eid] = systemNum;
    
    return eid;
  }

  private createNPC(data: any, systemNum: number): number {
    const eid = addEntity(this.world);
    addComponent(this.world, Position, eid);
    addComponent(this.world, Radius, eid);
    addComponent(this.world, NPC, eid);
    addComponent(this.world, InSystem, eid);
    addComponent(this.world, NetworkSync, eid);
    
    Position.x[eid] = data.position.x;
    Position.y[eid] = data.position.y;
    Radius.value[eid] = data.radius;
    InSystem.systemId[eid] = systemNum;
    
    // Assign NPC ID and track in map
    const npcIdNum = this.nextNpcId++;
    NPC.npcId[eid] = npcIdNum;
    this.npcIdMap.set(npcIdNum, data.id);
    
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
    InSystem.systemId[eid] = systemNum;
    
    return eid;
  }

  private createAsteroids(system: any, systemNum: number): void {
    const belt = system.asteroidBelt;
    if (!belt) return;

    const systemId = system.id || String(systemNum);
    const ids: number[] = [];
    const seedTick = this.currentTick;
    
    // Get asteroid field configuration if available
    const fieldId = system.asteroidField as string | undefined;
    const field = fieldId ? asteroidRegistry.getField(fieldId) : undefined;
    
    for (let i = 0; i < belt.count; i++) {
      // Use definition-based generation if field config exists, otherwise fallback to legacy
      const params = field 
        ? makeAsteroidParamsFromField(systemId, i, ASTEROID_SEED, seedTick, belt, field)
        : makeAsteroidParams(systemId, i, ASTEROID_SEED, seedTick, belt);
      
      const { x, y } = calcAsteroidPosition({
        orbitType: params.orbitType,
        semiMajorAxis: params.semiMajorAxis,
        eccentricity: params.eccentricity,
        argPeriapsis: params.argPeriapsis,
        meanAnomaly0: params.meanAnomaly0,
        epochTick: params.epochTick,
      }, seedTick);
      
      const eid = addEntity(this.world);
      addComponent(this.world, Position, eid);
      addComponent(this.world, Velocity, eid);
      addComponent(this.world, Radius, eid);
      addComponent(this.world, Asteroid, eid);
      addComponent(this.world, Health, eid);
      addComponent(this.world, InSystem, eid);
      addComponent(this.world, NetworkSync, eid);
      
      const size = params.size;
      
      // Calculate health using definition's healthPerUnit (scales with size)
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
      ids.push(eid);
      this.asteroidIndexById.set(eid, i);
    }

    this.asteroidIdsBySystem.set(systemNum, ids);
    this.asteroidSeedTickBySystem.set(systemNum, seedTick);
  }

  // ============================================
  // CONNECTION HANDLING
  // ============================================

  private handleConnection(ws: WebSocket): void {
    console.log('Client connected');
    this.totalConnectionsEver++;
    
    // Create player entity
    const playerId = this.createPlayer();
    const clientId = this.clientIdCounter++;
    
    const conn: ClientConnection = {
      ws,
      playerId,
      lastInputSeq: 0,
      lastPingTime: Date.now(),
      ping: 0,
      knownEntities: new Set(),
      lastSystemId: -1,
      username: `Player${clientId}`,
      userId: null,
      isAdmin: false,
      authToken: null,
      scheduledInputs: [],
      forceSnapshot: true,
      lastSnapshotSentTick: 0,
    };
    
    this.clients.set(ws, conn);
    Player.clientId[playerId] = clientId;
    
    // Send welcome message
    this.send(ws, {
      type: 'welcome',
      playerId,
      tickRate: TICK_RATE,
      serverTime: Date.now(),
    });
    
    // Send initial state
    this.sendPlayerState(conn);
    this.sendInventory(conn);
    
    ws.on('message', (data) => {
      try {
        // Handle both binary and JSON messages
        let msg: ClientMessage;
        if (Buffer.isBuffer(data)) {
          // Check if it's a binary message (starts with known binary type ID)
          const firstByte = data[0];
          if (firstByte === 0x01) {
            // Binary input message
            msg = decodeMessage(data) as ClientMessage;
          } else {
            // Try parsing as JSON string
            msg = JSON.parse(data.toString());
          }
        } else {
          msg = JSON.parse(data.toString());
        }
        this.handleMessage(conn, msg);
      } catch (e) {
        console.error('Failed to parse message:', e);
      }
    });
    
    ws.on('close', () => {
      console.log('Client disconnected');
      this.clients.delete(ws);
      if (hasComponent(this.world, Player, playerId)) {
        addComponent(this.world, Dead, playerId);
      }
    });
  }

  private createPlayer(): number {
    const eid = addEntity(this.world);
    
    addComponent(this.world, Position, eid);
    addComponent(this.world, Velocity, eid);
    addComponent(this.world, Rotation, eid);
    addComponent(this.world, Radius, eid);
    addComponent(this.world, Health, eid);
    addComponent(this.world, Shield, eid);
    addComponent(this.world, Player, eid);
    addComponent(this.world, Input, eid);
    addComponent(this.world, Boost, eid);
    addComponent(this.world, Equipment, eid);
    addComponent(this.world, EquipmentStats, eid);
    addComponent(this.world, Inventory, eid);
    addComponent(this.world, WeaponState, eid);
    addComponent(this.world, InSystem, eid);
    addComponent(this.world, NetworkSync, eid);
    
    // Spawn at Sol system
    const solSystem = this.gameData.getSystem('sol');
    const spawnX = 3000 + (Math.random() - 0.5) * 1000;
    const spawnY = (Math.random() - 0.5) * 1000;
    
    Position.x[eid] = spawnX;
    Position.y[eid] = spawnY;
    Velocity.x[eid] = 0;
    Velocity.y[eid] = 0;
    Rotation.angle[eid] = 0;
    Radius.value[eid] = PLAYER_RADIUS;
    
    Health.current[eid] = PLAYER_MAX_HP;
    Health.max[eid] = PLAYER_MAX_HP;
    Health.regenRate[eid] = PLAYER_REGEN_RATE;
    Health.regenDelay[eid] = PLAYER_REGEN_DELAY_TICKS;
    Health.lastDamageTick[eid] = 0;
    
    Shield.current[eid] = PLAYER_MAX_SHIELD;
    Shield.max[eid] = PLAYER_MAX_SHIELD;
    Shield.regenRate[eid] = PLAYER_SHIELD_REGEN;
    Shield.regenDelay[eid] = PLAYER_SHIELD_REGEN_DELAY;
    Shield.lastDamageTick[eid] = 0;
    
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
    
    // Give starter equipment
    const blasterNum = this.gameData.getItemNum('blaster_mk1');
    const laserNumForEquip = this.gameData.getItemNum('laser_mk1');
    Equipment.leftWeapon[eid] = laserNumForEquip || blasterNum; // Use laser as default for testing
    Equipment.rightWeapon[eid] = 0;
    Equipment.booster[eid] = this.gameData.getItemNum('booster_mk1');
    Equipment.cockpit[eid] = this.gameData.getItemNum('cockpit_mk1');
    
    // Give some starter items in inventory for testing
    const laserNum = this.gameData.getItemNum('laser_mk1');
    const scatterNum = this.gameData.getItemNum('scatter_mk1');
    const missileNum = this.gameData.getItemNum('missile_mk1');
    
    // Initialize inventory (10 slots)
    if (laserNum) {
      Inventory.slot0[eid] = laserNum;
      Inventory.count0[eid] = 1;
    }
    if (scatterNum) {
      Inventory.slot1[eid] = scatterNum;
      Inventory.count1[eid] = 1;
    }
    if (missileNum) {
      Inventory.slot2[eid] = missileNum;
      Inventory.count2[eid] = 1;
    }
    
    // Initialize equipment stats
    this.updateEquipmentStats(eid);
    
    InSystem.systemId[eid] = 0;
    
    return eid;
  }
  
  private updateEquipmentStats(eid: number): void {
    // Reset to defaults
    EquipmentStats.thrustMultiplier[eid] = 1.0;
    EquipmentStats.fuelCapacity[eid] = 1.0;
    EquipmentStats.fuelRegenRate[eid] = 1.0;
    EquipmentStats.accelBonus[eid] = 0;
    EquipmentStats.turnBonus[eid] = 0;
    EquipmentStats.hpBonus[eid] = 0;
    
    // Apply booster stats
    const boosterNum = Equipment.booster[eid];
    if (boosterNum > 0) {
      const booster = this.gameData.getItemByNum(boosterNum);
      if (booster) {
        EquipmentStats.thrustMultiplier[eid] = booster.thrustMultiplier ?? 1.0;
        EquipmentStats.fuelCapacity[eid] = booster.fuelCapacity ?? 1.0;
        EquipmentStats.fuelRegenRate[eid] = booster.regenRate ?? 1.0;
      }
    }
    
    // Apply cockpit stats
    const cockpitNum = Equipment.cockpit[eid];
    if (cockpitNum > 0) {
      const cockpit = this.gameData.getItemByNum(cockpitNum);
      if (cockpit) {
        EquipmentStats.accelBonus[eid] = cockpit.accelBonus ?? 0;
        EquipmentStats.turnBonus[eid] = cockpit.turnBonus ?? 0;
        EquipmentStats.hpBonus[eid] = cockpit.hpBonus ?? 0;
      }
    }
    
    // Update max HP based on cockpit bonus
    Health.max[eid] = PLAYER_MAX_HP + EquipmentStats.hpBonus[eid];
    
    // Update boost stats based on booster
    Boost.maxFuel[eid] = BOOST_FUEL_DEFAULT * EquipmentStats.fuelCapacity[eid];
    Boost.regenRate[eid] = BOOST_REGEN * EquipmentStats.fuelRegenRate[eid];
  }

  // ============================================
  // MESSAGE HANDLING
  // ============================================

  private handleMessage(conn: ClientConnection, msg: ClientMessage): void {
    switch (msg.type) {
      case 'input':
        // Queue for next tick boundary — don't apply mid-frame.
        // Messages still arrive instantly via setImmediate event loop.
        this.inputQueue.push({ conn, msg });
        break;
      case 'ping':
        this.handlePing(conn, msg);
        break;
      case 'chat':
        this.handleChat(conn, msg);
        break;
      case 'interact':
        this.handleInteract(conn, msg);
        break;
      case 'equip':
        this.handleEquip(conn, msg);
        break;
      case 'unequip':
        this.handleUnequip(conn, msg);
        break;
      case 'respawn':
        this.handleRespawn(conn);
        break;
      case 'pickup':
        this.handlePickupRequest(conn, msg);
        break;
      case 'dropItem':
        this.handleDropItem(conn, msg);
        break;
      case 'acceptQuest':
        this.handleAcceptQuest(conn, msg);
        break;
      case 'abandonQuest':
        this.handleAbandonQuest(conn, msg);
        break;
      case 'turnInQuest':
        this.handleTurnInQuest(conn, msg);
        break;
      case 'bankDeposit':
        this.handleBankDeposit(conn, msg);
        break;
      case 'bankWithdraw':
        this.handleBankWithdraw(conn, msg);
        break;
      case 'join':
        this.handleJoin(conn, msg);
        break;
      case 'authLogin':
        this.handleAuthLogin(conn, msg);
        break;
      case 'authRegister':
        this.handleAuthRegister(conn, msg);
        break;
      case 'stateHash':
        this.handleStateHash(conn, msg as any);
        break;
    }
  }

  private handleStateHash(conn: ClientConnection, msg: { tick: number; hash: number }): void {
    const eid = conn.playerId;
    if (!hasComponent(this.world, Player, eid)) return;

    const systemData = this.gameData.getSystemByNum(InSystem.systemId[eid]);
    const serverHash = computeStateHash(
      Position.x[eid],
      Position.y[eid],
      Rotation.angle[eid],
      Velocity.x[eid],
      Velocity.y[eid],
      Health.current[eid],
      Boost.fuel[eid],
      systemData?.id || 'sol',
    );

    if (serverHash !== msg.hash) {
      conn.forceSnapshot = true;
    }
  }

  /**
   * Schedule an input for future application at its targetTick.
   * If no targetTick or it's in the past, apply immediately (backward compat).
   */
  private handleInput(conn: ClientConnection, msg: any): void {
    const eid = conn.playerId;
    if (!hasComponent(this.world, Player, eid)) return;
    
    const targetTick = msg.targetTick;
    if (targetTick !== undefined && targetTick > this.currentTick) {
      // Schedule for future tick
      conn.scheduledInputs.push({ targetTick, msg });
    } else {
      // No targetTick (old client) or late arrival — apply immediately
      this.applyInputToEntity(conn, msg);
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
    // Client already sends dequantized(quantized(rawAngle)), so use it directly.
    // Re-quantizing here would introduce floating-point precision errors.
    Input.targetAngle[eid] = msg.targetAngle;
    Input.sequence[eid] = msg.seq;
    
    conn.lastInputSeq = msg.seq;
  }

  private handlePing(conn: ClientConnection, msg: any): void {
    const receiveTime = performance.now();
    const serverNow = Date.now();
    // Rough estimate for admin display (includes clock skew, but close enough)
    conn.ping = Math.max(0, serverNow - msg.clientTime);
    this.send(conn.ws, {
      type: 'pong',
      clientTime: msg.clientTime,
      serverTime: serverNow,
      tick: this.currentTick,
      serverProcessing: Math.round((performance.now() - receiveTime) * 100) / 100,
    });
  }

  private handleChat(conn: ClientConnection, msg: any): void {
    // Broadcast chat to all clients
    const text = String(msg.text || '').slice(0, 200).trim();
    if (!text) return;
    
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

  private handleJoin(conn: ClientConnection, msg: any): void {
    if (msg.token) {
      // Authenticated join - validate token
      const user = this.userDB.validateSession(msg.token);
      if (user) {
        conn.username = user.username;
        conn.userId = user.id;
        conn.isAdmin = user.is_admin;
        conn.authToken = msg.token;
        console.log(`Player ${conn.playerId} authenticated as ${user.username}${user.is_admin ? ' (admin)' : ''}`);
      } else {
        // Token invalid, use as guest
        conn.username = msg.username || `Player${conn.playerId}`;
        conn.userId = null;
        conn.isAdmin = false;
      }
    } else {
      // Guest join
      conn.username = msg.username || `Guest_${Math.floor(Math.random() * 10000)}`;
      conn.userId = null;
      conn.isAdmin = false;
    }
    
    // Send auth result back
    this.send(conn.ws, {
      type: 'authResult',
      success: true,
      username: conn.username,
      isAdmin: conn.isAdmin,
    } as any);
  }

  private handleAuthLogin(conn: ClientConnection, msg: any): void {
    const result = this.userDB.login(msg.username, msg.password);
    if (result.success) {
      conn.username = result.user.username;
      conn.userId = result.user.id;
      conn.isAdmin = result.user.is_admin;
      conn.authToken = result.token;
      
      this.send(conn.ws, {
        type: 'authResult',
        success: true,
        username: result.user.username,
        token: result.token,
        isAdmin: result.user.is_admin,
      } as any);
    } else {
      this.send(conn.ws, {
        type: 'authResult',
        success: false,
        error: result.error,
      } as any);
    }
  }

  private handleAuthRegister(conn: ClientConnection, msg: any): void {
    const result = this.userDB.register(msg.username, msg.email, msg.password);
    if (result.success) {
      conn.username = result.user.username;
      conn.userId = result.user.id;
      conn.isAdmin = result.user.is_admin;
      conn.authToken = result.token;
      
      this.send(conn.ws, {
        type: 'authResult',
        success: true,
        username: result.user.username,
        token: result.token,
        isAdmin: result.user.is_admin,
      } as any);
    } else {
      this.send(conn.ws, {
        type: 'authResult',
        success: false,
        error: result.error,
      } as any);
    }
  }

  private handleInteract(conn: ClientConnection, msg: any): void {
    const playerEid = conn.playerId;
    if (!hasComponent(this.world, Player, playerEid)) return;
    
    const playerX = Position.x[playerEid];
    const playerY = Position.y[playerEid];
    const playerSystemId = InSystem.systemId[playerEid];
    
    // Check for nearby portals
    for (const portalEid of portalQuery(this.world)) {
      if (InSystem.systemId[portalEid] !== playerSystemId) continue;
      
      const dx = Position.x[portalEid] - playerX;
      const dy = Position.y[portalEid] - playerY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      
      // Portal interaction radius
      if (dist < 300) {
        const targetSystemNum = Portal.targetSystem[portalEid];
        const targetSystem = this.gameData.getSystemByNum(targetSystemNum);
        
        if (targetSystem) {
          // Move player to target system
          InSystem.systemId[playerEid] = targetSystemNum;
          conn.knownEntities.clear();
          conn.lastSystemId = targetSystemNum;
          
          // Find the portal in the target system that leads back
          for (const targetPortalEid of portalQuery(this.world)) {
            if (InSystem.systemId[targetPortalEid] !== targetSystemNum) continue;
            
            // Spawn near the portal
            Position.x[playerEid] = Position.x[targetPortalEid] + 500;
            Position.y[playerEid] = Position.y[targetPortalEid];
            Velocity.x[playerEid] = 0;
            Velocity.y[playerEid] = 0;
            break;
          }
          
          // Send system change message
          this.send(conn.ws, {
            type: 'systemMessage',
            text: `Arrived in ${targetSystem.name}`,
            color: '#44ff44',
          });
          
          // Quest progress for travel objectives
          this.updateQuestProgress(playerEid, 'enterSystem', { systemId: targetSystem.id });
          
          // Update player state
          this.sendPlayerState(conn);
        }
        return;
      }
    }
    
    // Check for nearby stations
    for (const stationEid of stationQuery(this.world)) {
      if (InSystem.systemId[stationEid] !== playerSystemId) continue;
      
      const dx = Position.x[stationEid] - playerX;
      const dy = Position.y[stationEid] - playerY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      
      if (dist < STATION_INTERACT_RADIUS) {
        const stationNum = Station.stationId[stationEid];
        const stationData = this.gameData.getStationByNum(stationNum);
        
        // Send station dialogue
        const options: { text: string; action: string; data?: any }[] = [];
        
        if (stationData?.services?.includes('bank')) {
          options.push({ text: 'Access Bank', action: 'bank' });
        }
        if (stationData?.services?.includes('repair')) {
          options.push({ text: 'Repair Ship', action: 'repair' });
        }
        if (stationData?.services?.includes('refuel')) {
          options.push({ text: 'Refuel Ship', action: 'refuel' });
        }
        if (stationData?.services?.includes('shop')) {
          options.push({ text: 'Visit Shop', action: 'shop' });
        }
        options.push({ text: 'Leave Station', action: 'close' });
        
        this.send(conn.ws, {
          type: 'dialogue',
          npcId: stationData?.id || 'station',
          npcName: stationData?.name || 'Space Station',
          text: stationData?.description || 'Welcome to the station.',
          options,
        });
        
        // Also send bank contents if station has bank
        if (stationData?.services?.includes('bank')) {
          this.sendBankContents(conn);
        }
        return;
      }
    }
    
    // Check for nearby NPCs
    for (const npcEid of npcQuery(this.world)) {
      if (InSystem.systemId[npcEid] !== playerSystemId) continue;
      
      const dx = Position.x[npcEid] - playerX;
      const dy = Position.y[npcEid] - playerY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      
      if (dist < NPC_INTERACT_RADIUS) {
        // Get NPC data
        const npcIdNum = NPC.npcId[npcEid];
        const npcIdStr = this.npcIdMap.get(npcIdNum);
        if (!npcIdStr) {
          this.send(conn.ws, {
            type: 'systemMessage',
            text: 'Unknown NPC',
            color: '#ff0000',
          });
          return;
        }
        
        const npcData = this.gameData.getNPC(npcIdStr);
        if (!npcData) {
          this.send(conn.ws, {
            type: 'systemMessage',
            text: 'NPC data not found',
            color: '#ff0000',
          });
          return;
        }
        
        // Build dialogue options
        const options: { text: string; action: string; data?: any }[] = [];
        
        // Add quest options if NPC has quests
        if (npcData.quests && npcData.quests.length > 0) {
          options.push({
            text: 'Tell me about available jobs',
            action: 'quests',
          });
        }
        
        // Add shop option if NPC has shop
        if (npcData.shop) {
          options.push({
            text: 'Show me what you have for sale',
            action: 'shop',
          });
        }
        
        // Add service options
        if (npcData.services) {
          for (const service of npcData.services) {
            if (service === 'repair') {
              options.push({ text: 'Repair my ship', action: 'repair' });
            } else if (service === 'heal') {
              options.push({ text: 'Heal me', action: 'heal' });
            } else if (service === 'refuel') {
              options.push({ text: 'Refuel my ship', action: 'refuel' });
            }
          }
        }
        
        // Add farewell option
        options.push({ text: 'Goodbye', action: 'close' });
        
        // Send dialogue message
        this.send(conn.ws, {
          type: 'dialogue',
          npcId: npcIdStr,
          npcName: npcData.name,
          text: npcData.dialogue.greeting,
          options,
        });
        return;
      }
    }
  }

  private handleEquip(conn: ClientConnection, msg: any): void {
    const playerEid = conn.playerId;
    if (!hasComponent(this.world, Player, playerEid)) return;
    
    const inventorySlot = msg.inventorySlot;
    const equipSlot = msg.equipSlot as 'leftWeapon' | 'rightWeapon' | 'booster' | 'cockpit';
    
    if (inventorySlot < 0 || inventorySlot >= 10) return;
    
    // Get item from inventory
    const invItemNum = Inventory[`slot${inventorySlot}` as keyof typeof Inventory][playerEid];
    if (!invItemNum) return;
    
    const item = this.gameData.getItemByNum(invItemNum);
    if (!item) return;
    
    // Check if item can go in this slot
    if (equipSlot === 'leftWeapon' || equipSlot === 'rightWeapon') {
      if (item.type !== 'weapon') return;
    } else if (equipSlot === 'booster') {
      if (item.slot !== 'booster') return;
    } else if (equipSlot === 'cockpit') {
      if (item.slot !== 'cockpit') return;
    }
    
    // Get currently equipped item (if any)
    const currentEquipped = Equipment[equipSlot][playerEid];
    
    // Swap: put current equipment into inventory slot
    (Inventory as any)[`slot${inventorySlot}`][playerEid] = currentEquipped;
    (Inventory as any)[`count${inventorySlot}`][playerEid] = currentEquipped ? 1 : 0;
    
    // Put inventory item into equipment slot
    Equipment[equipSlot][playerEid] = invItemNum;
    
    // Update equipment stats
    this.updateEquipmentStats(playerEid);
    
    // Send updated inventory
    this.sendInventory(conn);
  }
  
  private handleUnequip(conn: ClientConnection, msg: any): void {
    const playerEid = conn.playerId;
    if (!hasComponent(this.world, Player, playerEid)) return;
    
    const equipSlot = msg.equipSlot as 'leftWeapon' | 'rightWeapon' | 'booster' | 'cockpit';
    
    // Get currently equipped item
    const equippedItemNum = Equipment[equipSlot][playerEid];
    if (!equippedItemNum) return;
    
    // Find empty inventory slot
    let emptySlot = -1;
    for (let i = 0; i < 10; i++) {
      const slotKey = `slot${i}` as keyof typeof Inventory;
      if (Inventory[slotKey][playerEid] === 0) {
        emptySlot = i;
        break;
      }
    }
    
    if (emptySlot === -1) {
      // No space in inventory
      this.send(conn.ws, {
        type: 'systemMessage',
        text: 'Inventory full!',
        color: '#ff4444',
      });
      return;
    }
    
    // Move to inventory
    (Inventory as any)[`slot${emptySlot}`][playerEid] = equippedItemNum;
    (Inventory as any)[`count${emptySlot}`][playerEid] = 1;
    Equipment[equipSlot][playerEid] = 0;
    
    // Update equipment stats
    this.updateEquipmentStats(playerEid);
    
    // Send updated inventory
    this.sendInventory(conn);
  }

  private handleDropItem(conn: ClientConnection, msg: any): void {
    const playerEid = conn.playerId;
    if (!hasComponent(this.world, Player, playerEid)) return;
    
    const inventorySlot = msg.inventorySlot;
    const count = msg.count || 1;
    
    if (typeof inventorySlot !== 'number' || inventorySlot < 0 || inventorySlot >= 10) return;
    
    // Get item from inventory
    const slotKey = `slot${inventorySlot}` as keyof typeof Inventory;
    const countKey = `count${inventorySlot}` as keyof typeof Inventory;
    const itemNum = (Inventory as any)[slotKey][playerEid];
    const currentCount = (Inventory as any)[countKey][playerEid] || 1;
    
    if (!itemNum || itemNum === 0) return;
    
    // Determine how many to drop
    const dropCount = Math.min(count, currentCount);
    
    // Remove from inventory
    if (dropCount >= currentCount) {
      // Drop entire stack
      (Inventory as any)[slotKey][playerEid] = 0;
      (Inventory as any)[countKey][playerEid] = 0;
    } else {
      // Drop partial stack
      (Inventory as any)[countKey][playerEid] = currentCount - dropCount;
    }
    
    // Get player position and spawn item nearby
    const px = Position.x[playerEid];
    const py = Position.y[playerEid];
    const angle = Rotation.angle[playerEid];
    const systemId = InSystem.systemId[playerEid];
    
    // Spawn in front of ship
    const spawnDist = 50;
    const spawnX = px + Math.cos(angle) * spawnDist;
    const spawnY = py + Math.sin(angle) * spawnDist;
    
    // Get item id from num
    const itemData = this.gameData.getItemByNum(itemNum);
    if (itemData) {
      this.spawnDroppedItem(spawnX, spawnY, itemData.id, dropCount, systemId);
    }
    
    // Send updated inventory
    this.sendInventory(conn);
  }

  private handleRespawn(conn: ClientConnection): void {
    const eid = conn.playerId;
    if (hasComponent(this.world, Dead, eid)) {
      // Remove dead component and reset health
      // For now, just recreate the player
      const newPlayerId = this.createPlayer();
      conn.playerId = newPlayerId;
      Player.clientId[newPlayerId] = Player.clientId[eid];
      removeEntity(this.world, eid);
      
      this.send(conn.ws, {
        type: 'welcome',
        playerId: newPlayerId,
        tickRate: TICK_RATE,
        serverTime: Date.now(),
      });
    }
  }

  private handlePickupRequest(conn: ClientConnection, msg: any): void {
    const playerEid = conn.playerId;
    if (!hasComponent(this.world, Player, playerEid)) return;
    
    const itemEntityId = msg.itemEntityId;
    if (typeof itemEntityId !== 'number') return;
    
    // Verify item exists and has DroppedItem component
    if (!hasComponent(this.world, DroppedItem, itemEntityId)) return;
    if (hasComponent(this.world, Dead, itemEntityId)) return;
    
    // Check distance
    const px = Position.x[playerEid];
    const py = Position.y[playerEid];
    const ix = Position.x[itemEntityId];
    const iy = Position.y[itemEntityId];
    const dist = Math.sqrt((px - ix) ** 2 + (py - iy) ** 2);
    
    const TRACTOR_RANGE = 300;
    if (dist > TRACTOR_RANGE) return;
    
    // Check same system
    if (InSystem.systemId[playerEid] !== InSystem.systemId[itemEntityId]) return;
    
    // Find empty inventory slot
    let emptySlot = -1;
    for (let i = 0; i < 10; i++) {
      const slotKey = `slot${i}` as keyof typeof Inventory;
      if (Inventory[slotKey][playerEid] === 0) {
        emptySlot = i;
        break;
      }
    }
    
    if (emptySlot === -1) {
      this.send(conn.ws, {
        type: 'systemMessage',
        text: 'Inventory full!',
        color: '#ff4444',
      });
      return;
    }
    
    // Pick up the item
    const itemNum = DroppedItem.itemId[itemEntityId];
    const stackCount = DroppedItem.stackCount[itemEntityId];
    
    (Inventory as any)[`slot${emptySlot}`][playerEid] = itemNum;
    (Inventory as any)[`count${emptySlot}`][playerEid] = stackCount;
    
    // Mark item for removal
    addComponent(this.world, Dead, itemEntityId);
    this.pendingRemovedEntities.add(itemEntityId);
    
    // Broadcast tractor beam effect
    const systemId = InSystem.systemId[playerEid];
    this.broadcastToSystem(systemId, {
      type: 'effect',
      effectType: 8, // PickupItem
      x: ix,
      y: iy,
      targetX: px,
      targetY: py,
      entityId: playerEid,
    });
    
    // Send updated inventory
    this.sendInventory(conn);
    
    // Notify player
    const item = this.gameData.getItemByNum(itemNum);
    if (item) {
      this.send(conn.ws, {
        type: 'systemMessage',
        text: `Picked up ${item.name}`,
        color: '#44ff44',
      });
    }
  }

  // ============================================
  // QUEST HANDLERS
  // ============================================

  private getPlayerQuestState(playerId: number) {
    let questState = this.playerQuests.get(playerId);
    if (!questState) {
      questState = { active: new Map(), completed: [] };
      this.playerQuests.set(playerId, questState);
    }
    return questState;
  }

  private handleAcceptQuest(conn: ClientConnection, msg: any): void {
    const playerEid = conn.playerId;
    if (!hasComponent(this.world, Player, playerEid)) return;

    const questId = msg.questId;
    const npcId = msg.npcId;

    const questDef = this.gameData.getQuest(questId);
    if (!questDef) {
      this.send(conn.ws, {
        type: 'systemMessage',
        text: 'Quest not found',
        color: '#ff4444',
      });
      return;
    }

    const playerQuests = this.getPlayerQuestState(playerEid);

    // Check if already active
    if (playerQuests.active.has(questId)) {
      this.send(conn.ws, {
        type: 'systemMessage',
        text: 'Quest already active',
        color: '#ffaa00',
      });
      return;
    }

    // Check if completed and not repeatable
    if (playerQuests.completed.includes(questId) && !questDef.repeatable) {
      this.send(conn.ws, {
        type: 'systemMessage',
        text: 'Quest already completed',
        color: '#ffaa00',
      });
      return;
    }

    // Check level requirement
    const playerLevel = Player.level[playerEid];
    if (questDef.level > playerLevel) {
      this.send(conn.ws, {
        type: 'systemMessage',
        text: `Requires level ${questDef.level}`,
        color: '#ff4444',
      });
      return;
    }

    // Check prerequisites
    for (const prereq of questDef.prerequisites) {
      if (!playerQuests.completed.includes(prereq)) {
        this.send(conn.ws, {
          type: 'systemMessage',
          text: 'Prerequisites not met',
          color: '#ff4444',
        });
        return;
      }
    }

    // Check max active quests (5)
    if (playerQuests.active.size >= 5) {
      this.send(conn.ws, {
        type: 'systemMessage',
        text: 'Too many active quests (max 5)',
        color: '#ff4444',
      });
      return;
    }

    // Accept the quest
    playerQuests.active.set(questId, {
      questId,
      stageIndex: 0,
      progress: 0,
      startedAt: this.currentTick,
    });

    // Send notification
    this.send(conn.ws, {
      type: 'systemMessage',
      text: `Quest accepted: ${questDef.name}`,
      color: '#44ff44',
    });

    // Send quest update
    const stage = questDef.stages[0];
    this.send(conn.ws, {
      type: 'questUpdate',
      questId,
      stage: 0,
      progress: 0,
      maxProgress: stage.objective?.count ?? 1,
      completed: false,
    });

    // Send full quest list
    this.sendQuestList(conn);
  }

  private handleAbandonQuest(conn: ClientConnection, msg: any): void {
    const playerEid = conn.playerId;
    if (!hasComponent(this.world, Player, playerEid)) return;

    const questId = msg.questId;
    const playerQuests = this.getPlayerQuestState(playerEid);

    if (!playerQuests.active.has(questId)) {
      this.send(conn.ws, {
        type: 'systemMessage',
        text: 'Quest not active',
        color: '#ff4444',
      });
      return;
    }

    // Remove quest
    playerQuests.active.delete(questId);

    const questDef = this.gameData.getQuest(questId);
    this.send(conn.ws, {
      type: 'systemMessage',
      text: `Quest abandoned: ${questDef?.name ?? questId}`,
      color: '#ffaa00',
    });

    // Send updated quest list
    this.sendQuestList(conn);
  }

  private handleTurnInQuest(conn: ClientConnection, msg: any): void {
    const playerEid = conn.playerId;
    if (!hasComponent(this.world, Player, playerEid)) return;

    const questId = msg.questId;
    const npcId = msg.npcId;

    const playerQuests = this.getPlayerQuestState(playerEid);
    const questState = playerQuests.active.get(questId);

    if (!questState) {
      this.send(conn.ws, {
        type: 'systemMessage',
        text: 'Quest not active',
        color: '#ff4444',
      });
      return;
    }

    const questDef = this.gameData.getQuest(questId);
    if (!questDef) return;

    // Check if all stages complete
    const isComplete = questState.stageIndex >= questDef.stages.length;
    if (!isComplete) {
      this.send(conn.ws, {
        type: 'systemMessage',
        text: 'Quest not complete yet',
        color: '#ffaa00',
      });
      return;
    }

    // Grant rewards
    const rewards = questDef.rewards;

    // XP reward
    if (rewards.xp > 0) {
      Player.xp[playerEid] += rewards.xp;
      this.checkLevelUp(playerEid);
    }

    // Credits reward
    if (rewards.credits > 0) {
      Player.credits[playerEid] += rewards.credits;
    }

    // Item rewards
    if (rewards.items && rewards.items.length > 0) {
      for (const itemId of rewards.items) {
        const item = this.gameData.getItem(itemId);
        if (!item) continue;

        // Find empty inventory slot
        let emptySlot = -1;
        for (let i = 0; i < 10; i++) {
          const slotKey = `slot${i}` as keyof typeof Inventory;
          if (Inventory[slotKey][playerEid] === 0) {
            emptySlot = i;
            break;
          }
        }

        if (emptySlot >= 0) {
          const itemNum = this.gameData.getItemNum(item.id);
          (Inventory as any)[`slot${emptySlot}`][playerEid] = itemNum;
          (Inventory as any)[`count${emptySlot}`][playerEid] = 1;
        }
      }
    }

    // Remove from active, add to completed
    playerQuests.active.delete(questId);
    if (!playerQuests.completed.includes(questId)) {
      playerQuests.completed.push(questId);
    }

    // Send completion message
    this.send(conn.ws, {
      type: 'systemMessage',
      text: `Quest complete: ${questDef.name}! Rewards: ${rewards.xp} XP, ${rewards.credits} credits`,
      color: '#44ff44',
    });

    // Send updated state
    this.sendQuestList(conn);
    this.sendInventory(conn);
    this.sendPlayerState(conn);
  }

  private sendQuestList(conn: ClientConnection): void {
    const playerEid = conn.playerId;
    const playerQuests = this.getPlayerQuestState(playerEid);

    const activeQuests: { questId: string; currentStage: number; progress: number; maxProgress: number }[] = [];
    
    for (const [questId, state] of playerQuests.active) {
      const questDef = this.gameData.getQuest(questId);
      if (!questDef) continue;

      const stage = questDef.stages[state.stageIndex];
      activeQuests.push({
        questId,
        currentStage: state.stageIndex,
        progress: state.progress,
        maxProgress: stage?.objective?.count ?? 1,
      });
    }

    this.send(conn.ws, {
      type: 'quests',
      active: activeQuests,
      completed: playerQuests.completed,
    });
  }

  // Check and update quest progress for various events
  private updateQuestProgress(playerEid: number, eventType: string, eventData: any): void {
    const playerQuests = this.getPlayerQuestState(playerEid);
    
    for (const [questId, state] of playerQuests.active) {
      const questDef = this.gameData.getQuest(questId);
      if (!questDef) continue;
      
      const stage = questDef.stages[state.stageIndex];
      if (!stage) continue;

      let progressMade = false;

      switch (stage.type) {
        case 'kill':
          if (eventType === 'kill' && stage.objective?.enemy === eventData.enemyType) {
            state.progress++;
            progressMade = true;
          }
          break;

        case 'travel':
          if (eventType === 'enterSystem' && stage.objective?.system === eventData.systemId) {
            state.progress = 1;
            progressMade = true;
          }
          break;

        case 'acquire':
          if (eventType === 'itemPickup' && stage.objective?.item === eventData.itemId) {
            state.progress++;
            progressMade = true;
          }
          break;

        case 'action':
          if (eventType === 'action' && stage.objective?.action === eventData.action) {
            state.progress++;
            progressMade = true;
          }
          break;
      }

      if (progressMade) {
        const targetCount = stage.objective?.count ?? 1;
        
        // Find connection for this player
        for (const [ws, conn] of this.clients) {
          if (conn.playerId === playerEid) {
            // Check if stage complete
            if (state.progress >= targetCount) {
              state.stageIndex++;
              state.progress = 0;

              // Send stage complete message
              this.send(conn.ws, {
                type: 'systemMessage',
                text: `Stage complete: ${stage.description}`,
                color: '#44ff44',
              });

              // Check if quest complete
              if (state.stageIndex >= questDef.stages.length) {
                this.send(conn.ws, {
                  type: 'systemMessage',
                  text: `Quest complete! Return to ${questDef.giver} for your reward.`,
                  color: '#44ff44',
                });
              }
            }

            // Send quest update
            const nextStage = questDef.stages[state.stageIndex];
            this.send(conn.ws, {
              type: 'questUpdate',
              questId,
              stage: state.stageIndex,
              progress: state.progress,
              maxProgress: nextStage?.objective?.count ?? 1,
              completed: state.stageIndex >= questDef.stages.length,
            });
            break;
          }
        }
      }
    }
  }

  // ============================================
  // BANK HANDLERS
  // ============================================

  private getPlayerBank(playerId: number): { itemNum: number, count: number }[] {
    let bank = this.playerBanks.get(playerId);
    if (!bank) {
      bank = [];
      for (let i = 0; i < GameServer.BANK_SIZE; i++) {
        bank.push({ itemNum: 0, count: 0 });
      }
      this.playerBanks.set(playerId, bank);
    }
    return bank;
  }

  private sendBankContents(conn: ClientConnection): void {
    const bank = this.getPlayerBank(conn.playerId);
    const slots = bank.map((slot, idx) => ({
      slot: idx,
      itemId: slot.itemNum > 0 ? (this.gameData.getItemByNum(slot.itemNum)?.id || '') : '',
      count: slot.count,
    }));
    
    this.send(conn.ws, {
      type: 'bank',
      slots,
    });
  }

  private handleBankDeposit(conn: ClientConnection, msg: any): void {
    const playerEid = conn.playerId;
    if (!hasComponent(this.world, Player, playerEid)) return;
    
    const inventorySlot = msg.inventorySlot;
    const count = msg.count ?? 1;
    
    if (inventorySlot < 0 || inventorySlot >= 10) return;
    
    // Get item from inventory
    const slotKey = `slot${inventorySlot}` as keyof typeof Inventory;
    const countKey = `count${inventorySlot}` as keyof typeof Inventory;
    const itemNum = Inventory[slotKey][playerEid];
    const itemCount = Inventory[countKey][playerEid];
    
    if (itemNum === 0 || itemCount < count) {
      this.send(conn.ws, {
        type: 'systemMessage',
        text: 'Invalid item',
        color: '#ff4444',
      });
      return;
    }
    
    // Find empty bank slot or stack with same item
    const bank = this.getPlayerBank(playerEid);
    let targetSlot = -1;
    
    // First try to stack with existing item
    for (let i = 0; i < bank.length; i++) {
      if (bank[i].itemNum === itemNum) {
        targetSlot = i;
        break;
      }
    }
    
    // If no stack found, find empty slot
    if (targetSlot === -1) {
      for (let i = 0; i < bank.length; i++) {
        if (bank[i].itemNum === 0) {
          targetSlot = i;
          break;
        }
      }
    }
    
    if (targetSlot === -1) {
      this.send(conn.ws, {
        type: 'systemMessage',
        text: 'Bank full!',
        color: '#ff4444',
      });
      return;
    }
    
    // Transfer item
    const transferAmount = Math.min(count, itemCount);
    (Inventory as any)[countKey][playerEid] -= transferAmount;
    
    // If inventory slot is now empty, clear it
    if ((Inventory as any)[countKey][playerEid] <= 0) {
      (Inventory as any)[slotKey][playerEid] = 0;
      (Inventory as any)[countKey][playerEid] = 0;
    }
    
    bank[targetSlot].itemNum = itemNum;
    bank[targetSlot].count += transferAmount;
    
    // Send updates
    this.sendInventory(conn);
    this.sendBankContents(conn);
    
    const item = this.gameData.getItemByNum(itemNum);
    this.send(conn.ws, {
      type: 'systemMessage',
      text: `Deposited ${transferAmount}x ${item?.name || 'item'}`,
      color: '#44ff44',
    });
  }

  private handleBankWithdraw(conn: ClientConnection, msg: any): void {
    const playerEid = conn.playerId;
    if (!hasComponent(this.world, Player, playerEid)) return;
    
    const bankSlot = msg.bankSlot;
    const count = msg.count ?? 1;
    
    const bank = this.getPlayerBank(playerEid);
    if (bankSlot < 0 || bankSlot >= bank.length) return;
    
    const itemNum = bank[bankSlot].itemNum;
    const itemCount = bank[bankSlot].count;
    
    if (itemNum === 0 || itemCount < count) {
      this.send(conn.ws, {
        type: 'systemMessage',
        text: 'Invalid item',
        color: '#ff4444',
      });
      return;
    }
    
    // Find inventory slot - try to stack first
    let targetSlot = -1;
    
    for (let i = 0; i < 10; i++) {
      const slotKey = `slot${i}` as keyof typeof Inventory;
      if (Inventory[slotKey][playerEid] === itemNum) {
        targetSlot = i;
        break;
      }
    }
    
    // If no stack, find empty
    if (targetSlot === -1) {
      for (let i = 0; i < 10; i++) {
        const slotKey = `slot${i}` as keyof typeof Inventory;
        if (Inventory[slotKey][playerEid] === 0) {
          targetSlot = i;
          break;
        }
      }
    }
    
    if (targetSlot === -1) {
      this.send(conn.ws, {
        type: 'systemMessage',
        text: 'Inventory full!',
        color: '#ff4444',
      });
      return;
    }
    
    // Transfer item
    const transferAmount = Math.min(count, itemCount);
    bank[bankSlot].count -= transferAmount;
    
    // If bank slot is now empty, clear it
    if (bank[bankSlot].count <= 0) {
      bank[bankSlot].itemNum = 0;
      bank[bankSlot].count = 0;
    }
    
    const slotKey = `slot${targetSlot}` as keyof typeof Inventory;
    const countKey = `count${targetSlot}` as keyof typeof Inventory;
    (Inventory as any)[slotKey][playerEid] = itemNum;
    (Inventory as any)[countKey][playerEid] += transferAmount;
    
    // Send updates
    this.sendInventory(conn);
    this.sendBankContents(conn);
    
    const item = this.gameData.getItemByNum(itemNum);
    this.send(conn.ws, {
      type: 'systemMessage',
      text: `Withdrew ${transferAmount}x ${item?.name || 'item'}`,
      color: '#44ff44',
    });
  }

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
    
    // Fixed timestep updates — cap catch-up to avoid spiral of death
    let ticksThisFrame = 0;
    const maxTicksPerFrame = 4;
    while (this.tickAccumulator >= TICK_MS && ticksThisFrame < maxTicksPerFrame) {
      // Drain queued inputs right before each tick so they take effect
      // on the earliest possible tick boundary.
      this.drainInputQueue();
      
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
      this.sendSnapshots();
      this.lastSnapshotTick = this.currentTick;
    }
    
    // Always yield via setImmediate — lets pending I/O (WebSocket messages,
    // pong responses, HTTP requests) dispatch between every iteration.
    setImmediate(() => this.gameLoop());
  }
  
  /**
   * Apply all queued player inputs.  Called once per tick, right before
   * simulation, so every input lands on the earliest tick boundary.
   */
  private drainInputQueue(): void {
    // 1. Process newly received inputs (may schedule them for future ticks)
    for (let i = 0; i < this.inputQueue.length; i++) {
      const { conn, msg } = this.inputQueue[i];
      this.handleInput(conn, msg);
    }
    if (this.inputQueue.length > 0 && this.currentTick % 60 === 0) {
      console.log(`[DRAIN] tick=${this.currentTick} newInputs=${this.inputQueue.length}`);
    }
    this.inputQueue.length = 0; // clear without re-allocation
    
    // 2. Apply per-player scheduled inputs whose targetTick has arrived
    const nextTick = this.currentTick + 1;
    let drainedCount = 0;
    for (const conn of this.clients.values()) {
      const scheduled = conn.scheduledInputs;
      if (scheduled.length > 0 && this.currentTick % 60 === 0) {
        console.log(`[DRAIN] player=${conn.playerId} scheduled=${scheduled.length} nextTick=${nextTick} targets=[${scheduled.map(s=>s.targetTick).join(',')}] fire=${scheduled.map(s=>s.msg.fireLeft?'Y':'N').join(',')}`);
      }
      let i = 0;
      while (i < scheduled.length) {
        if (scheduled[i].targetTick <= nextTick) {
          this.applyInputToEntity(conn, scheduled[i].msg);
          drainedCount++;
          // Swap-remove for O(1)
          scheduled[i] = scheduled[scheduled.length - 1];
          scheduled.pop();
        } else {
          i++;
        }
      }
    }
    if (drainedCount > 0 && this.currentTick % 60 === 0) {
      console.log(`[DRAIN] drained=${drainedCount}`);
    }
  }

  private tick(): void {
    const tickStart = performance.now();
    this.currentTick++;
    
    // Update asteroid positions FIRST so spatial grid + hitscan use current-tick data
    this.asteroidOrbitSystem();
    this.stationOrbitSystem();
    
    // Reset spatial grid and rebuild (now with current asteroid positions)
    this.spatialGrid.clear();
    this.buildSpatialGrid();
    
    // Run systems
    this.playerMovementSystem();
    this.boostRegenSystem();  // Separate from physics - not predicted by client
    this.weaponSystem();
    this.projectileSystem();
    this.missileHomingSystem();
    this.mineSystem();
    this.miningProjectileSystem();
    this.enemyAISystem();
    this.enemySpawnSystem();
    this.collisionSystem();
    this.asteroidDeathSystem();  // Check for destroyed asteroids
    this.healthRegenSystem();
    this.lifetimeSystem();
    this.cleanupSystem();
    
    // Report to admin server and update performance metrics
    const tickTime = performance.now() - tickStart;
    this.updatePerfMetrics(tickTime);
    this.reportAdminStats(tickTime);
  }
  
  private buildSpatialGrid(): void {
    // Add asteroids to spatial grid
    for (const eid of asteroidQuery(this.world)) {
      if (hasComponent(this.world, Dead, eid)) continue;
      this.spatialGrid.add({
        id: eid,
        x: Position.x[eid],
        y: Position.y[eid],
        radius: Asteroid.size[eid],
        type: 'asteroid'
      });
    }
    
    // Add enemies
    for (const eid of enemyQuery(this.world)) {
      if (hasComponent(this.world, Dead, eid)) continue;
      this.spatialGrid.add({
        id: eid,
        x: Position.x[eid],
        y: Position.y[eid],
        radius: Radius.value[eid],
        type: 'enemy'
      });
    }
    
    // Add players
    for (const eid of playerQuery(this.world)) {
      if (hasComponent(this.world, Dead, eid)) continue;
      this.spatialGrid.add({
        id: eid,
        x: Position.x[eid],
        y: Position.y[eid],
        radius: Radius.value[eid],
        type: 'player'
      });
    }
    
    // Add dropped items
    for (const eid of droppedItemQuery(this.world)) {
      if (hasComponent(this.world, Dead, eid)) continue;
      this.spatialGrid.add({
        id: eid,
        x: Position.x[eid],
        y: Position.y[eid],
        radius: 15,
        type: 'item'
      });
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
    const players = playerQuery(this.world);
    
    for (const eid of players) {
      // Build physics state from ECS components
      const state: PhysicsState = {
        x: Position.x[eid],
        y: Position.y[eid],
        vx: Velocity.x[eid],
        vy: Velocity.y[eid],
        angle: Rotation.angle[eid],
      };
      
      // Build physics input from ECS input components
      const input: PhysicsInput = {
        forward: Input.forward[eid] === 1,
        backward: Input.backward[eid] === 1,
        left: Input.left[eid] === 1,
        right: Input.right[eid] === 1,
        boost: Input.boost[eid] === 1,
        targetAngle: Input.targetAngle[eid],
      };
      
      // Use shared physics function - MUST match client exactly
      // stepPlayerPhysics now applies BitBuffer quantization internally
      const result = stepPlayerPhysics(state, input, {
        fuel: Boost.fuel[eid],
        drainRate: Boost.drainRate[eid],
      });
      
      // stepPlayerPhysics already quantizes to BitBuffer precision - use values directly
      // This ensures server and client have identical determinism at network precision
      Position.x[eid] = result.state.x;
      Position.y[eid] = result.state.y;
      Velocity.x[eid] = result.state.vx;
      Velocity.y[eid] = result.state.vy;
      Rotation.angle[eid] = result.state.angle;
      Boost.fuel[eid] = result.boostFuel;
      
      // Track boost usage for regen delay (used by boostRegenSystem)
      if (result.isBoosting) {
        Boost.lastUseTick[eid] = this.currentTick;
      }
    }
  }
  
  /**
   * Boost regeneration system - runs AFTER playerMovementSystem.
   * This is NOT part of physics simulation and is NOT predicted by the client,
   * so it must run separately from stepPlayerPhysics to avoid prediction divergence.
   */
  private boostRegenSystem(): void {
    const players = playerQuery(this.world);
    
    for (const eid of players) {
      // Only regen if not boosting and delay has passed
      if (this.currentTick - Boost.lastUseTick[eid] > Boost.regenDelay[eid]) {
        Boost.fuel[eid] = Math.min(Boost.maxFuel[eid], Boost.fuel[eid] + Boost.regenRate[eid]);
      }
    }
  }

  private weaponSystem(): void {
    const players = playerQuery(this.world);
    
    for (const eid of players) {
      // DEBUG: log fire state every second
      if (this.currentTick % 60 === 0 && (Input.fireLeft[eid] || Input.fireRight[eid])) {
        const lwId = Equipment.leftWeapon[eid];
        const lwItem = lwId > 0 ? this.gameData.getItemByNum(lwId) : null;
        console.log(`[WEAPON] eid=${eid} fireL=${Input.fireLeft[eid]} fireR=${Input.fireRight[eid]} leftWpn=${lwId} type=${lwItem?.weaponType} cd=${WeaponState.leftCooldown[eid]}`);
      }
      // Determine laser active state: player is holding fire AND has a laser equipped.
      // This is continuous (not just on fire ticks) so remote clients render a steady beam.
      // See CURSOR_STATE.md for the packed snapshot format.
      const leftWeaponId = Equipment.leftWeapon[eid];
      const rightWeaponId = Equipment.rightWeapon[eid];
      const leftItem = leftWeaponId > 0 ? this.gameData.getItemByNum(leftWeaponId) : null;
      const rightItem = rightWeaponId > 0 ? this.gameData.getItemByNum(rightWeaponId) : null;
      const leftLaserNow = !!(Input.fireLeft[eid] && leftItem?.weaponType === 'laser');
      const rightLaserNow = !!(Input.fireRight[eid] && rightItem?.weaponType === 'laser');
      WeaponState.leftLaserActive[eid] = leftLaserNow ? 1 : 0;
      WeaponState.rightLaserActive[eid] = rightLaserNow ? 1 : 0;
      
      // Decrease cooldowns
      if (WeaponState.leftCooldown[eid] > 0) WeaponState.leftCooldown[eid]--;
      if (WeaponState.rightCooldown[eid] > 0) WeaponState.rightCooldown[eid]--;
      
      // Fire left weapon
      if (Input.fireLeft[eid] && WeaponState.leftCooldown[eid] === 0) {
        const weaponId = Equipment.leftWeapon[eid];
        if (weaponId > 0) {
          this.fireWeapon(eid, weaponId, true);
        }
      }
      
      // Fire right weapon
      if (Input.fireRight[eid] && WeaponState.rightCooldown[eid] === 0) {
        const weaponId = Equipment.rightWeapon[eid];
        if (weaponId > 0) {
          this.fireWeapon(eid, weaponId, false);
        }
      }
    }
  }

  private fireWeapon(shooterEid: number, weaponNumId: number, isLeft: boolean): void {
    const item = this.gameData.getItemByNum(weaponNumId);
    if (!item) return;
    
    const x = Position.x[shooterEid];
    const y = Position.y[shooterEid];
    const angle = Rotation.angle[shooterEid];
    const targetAngle = Input.targetAngle[shooterEid]; // Aim direction (toward mouse)
    const systemId = InSystem.systemId[shooterEid];
    
    const cooldown = isLeft ? 'leftCooldown' : 'rightCooldown';
    
    // Debug: log weapon type for troubleshooting
    if (!item.weaponType) {
      console.log(`[WEAPON] No weaponType for item: ${item.id}, type: ${item.type}`);
    }
    
    switch (item.weaponType) {
      case 'cannon':
        this.fireCannon(shooterEid, x, y, targetAngle, item, systemId);
        WeaponState[cooldown][shooterEid] = Math.floor(FIRE_COOLDOWN_TICKS / (item.fireRate || 1));
        break;
      case 'scatter':
        this.fireScatter(shooterEid, x, y, targetAngle, item, systemId);
        WeaponState[cooldown][shooterEid] = Math.floor(FIRE_COOLDOWN_TICKS / (item.fireRate || 1) * 1.5);
        break;
      case 'laser':
        // Laser uses ship's facing angle for determinism (not aim angle)
        const shipAngle = Rotation.angle[shooterEid];
        if (this.currentTick % 30 === 0) console.log(`[FIRE_LASER] eid=${shooterEid} calling fireLaser shipAngle=${shipAngle.toFixed(2)} sys=${systemId}`);
        this.fireLaser(shooterEid, x, y, shipAngle, item, systemId);
        WeaponState[cooldown][shooterEid] = LASER_TICK_COOLDOWN;
        break;
      case 'missile':
        this.fireMissile(shooterEid, x, y, targetAngle, item, systemId);
        WeaponState[cooldown][shooterEid] = Math.floor(FIRE_COOLDOWN_TICKS / (item.fireRate || 1) * 2);
        break;
      case 'pulse':
        this.firePulse(shooterEid, x, y, targetAngle, item, systemId);
        WeaponState[cooldown][shooterEid] = Math.floor(FIRE_COOLDOWN_TICKS / (item.fireRate || 1) * 2);
        break;
      case 'mine':
        this.fireMine(shooterEid, x, y, item, systemId);
        WeaponState[cooldown][shooterEid] = 120; // 2 second cooldown
        break;
      case 'mining':
        this.fireMining(shooterEid, x, y, targetAngle, item, systemId);
        WeaponState[cooldown][shooterEid] = Math.floor(FIRE_COOLDOWN_TICKS / (item.fireRate || 1) * 4);
        break;
    }
  }

  private fireCannon(shooterEid: number, x: number, y: number, angle: number, item: any, systemId: number): void {
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
    
    const speed = BULLET_SPEED * (item.speed || 1) * speedVariance;
    const damage = BULLET_DAMAGE * (item.damage || 1);
    const finalAngle = angle + angleVariance;
    
    // Spawn slightly ahead of player
    const spawnX = x + Math.cos(angle) * 30;
    const spawnY = y + Math.sin(angle) * 30;
    
    Position.x[eid] = spawnX;
    Position.y[eid] = spawnY;
    
    // Add player velocity to bullet
    Velocity.x[eid] = Math.cos(finalAngle) * speed + Velocity.x[shooterEid] * 0.3;
    Velocity.y[eid] = Math.sin(finalAngle) * speed + Velocity.y[shooterEid] * 0.3;
    
    Radius.value[eid] = 5;
    Projectile.ownerId[eid] = shooterEid;
    Projectile.damage[eid] = damage;
    Projectile.weaponType[eid] = WeaponType.Cannon;
    Projectile.tier[eid] = item.tier || 1;
    Projectile.spawnTick[eid] = this.currentTick;
    Projectile.spawnX[eid] = spawnX;
    Projectile.spawnY[eid] = spawnY;
    Bullet.speed[eid] = speed;
    Lifetime.remaining[eid] = BLASTER_LIFE_TICKS;
    InSystem.systemId[eid] = systemId;
    OwnedBy.ownerId[eid] = shooterEid;
  }

  private fireScatter(shooterEid: number, x: number, y: number, angle: number, item: any, systemId: number): void {
    const count = item.projectileCount || 5;
    const spread = item.spread || 0.5;
    
    // Seeded randomization for deterministic scatter pattern
    const rng = mulberry32(hashString(`scatter:${this.currentTick}:${shooterEid}`));
    
    for (let i = 0; i < count; i++) {
      // Use seeded random for spread angle
      const spreadAngle = angle + (rng() - 0.5) * spread;
      
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
      
      // Seeded speed variance (90-110% base speed)
      const speed = BULLET_SPEED * (item.speed || 0.8) * (0.9 + rng() * 0.2);
      const damage = BULLET_DAMAGE * (item.damage || 0.8);
      
      const spawnX = x + Math.cos(angle) * 30;
      const spawnY = y + Math.sin(angle) * 30;
      
      Position.x[eid] = spawnX;
      Position.y[eid] = spawnY;
      Velocity.x[eid] = Math.cos(spreadAngle) * speed + Velocity.x[shooterEid] * 0.3;
      Velocity.y[eid] = Math.sin(spreadAngle) * speed + Velocity.y[shooterEid] * 0.3;
      Radius.value[eid] = 4;
      Projectile.ownerId[eid] = shooterEid;
      Projectile.damage[eid] = damage;
      Projectile.weaponType[eid] = WeaponType.Scatter;
      Projectile.tier[eid] = item.tier || 1;
      Projectile.spawnTick[eid] = this.currentTick;
      Projectile.spawnX[eid] = spawnX;
      Projectile.spawnY[eid] = spawnY;
      Bullet.speed[eid] = speed;
      Lifetime.remaining[eid] = SCATTER_LIFE_TICKS;
      InSystem.systemId[eid] = systemId;
      OwnedBy.ownerId[eid] = shooterEid;
    }

    // Debug: send nearby asteroid positions to shooter when firing scatter
    for (const [ws, conn] of this.clients) {
      if (conn.playerId !== shooterEid) continue;
      const debugRadius = 6000;
      const points: { id: number; x: number; y: number }[] = [];
      for (const eid of asteroidQuery(this.world)) {
        if (hasComponent(this.world, Dead, eid)) continue;
        if (InSystem.systemId[eid] !== systemId) continue;
        const dx = Position.x[eid] - x;
        const dy = Position.y[eid] - y;
        if (dx * dx + dy * dy > debugRadius * debugRadius) continue;
        points.push({ id: eid, x: Math.round(Position.x[eid]), y: Math.round(Position.y[eid]) });
      }
      this.send(ws, {
        type: 'asteroidDebug',
        tick: this.currentTick,
        durationMs: 10000,
        points,
      } as ServerAsteroidDebugMessage);
      break;
    }
  }

  private _laserFireCount = 0;
  private fireLaser(shooterEid: number, x: number, y: number, angle: number, item: any, systemId: number): void {
    this._laserFireCount++;
    // Laser is instant hitscan - find target along ray
    const range = LASER_RANGE * (item.range || 1);
    const damage = LASER_DAMAGE_MAX * (item.damage || 1);
    
    // Laser fires from ship nose in ship's facing direction.
    // Using ship angle (not aim angle) ensures client-server determinism.
    const SHIP_TIP_OFFSET = 30;
    const startX = x + Math.cos(angle) * SHIP_TIP_OFFSET;
    const startY = y + Math.sin(angle) * SHIP_TIP_OFFSET;
    
    const endX = startX + Math.cos(angle) * range;
    const endY = startY + Math.sin(angle) * range;
    
    // Find closest entity along ray using spatial grid
    let bestT = 1.0; // parametric t along ray (0=start, 1=end)
    let hitEntity = 0;
    let isAsteroid = false;
    
    const nearby = this.spatialGrid.queryRay(startX, startY, endX, endY, 400);
    
    // DEBUG: log every 10th fireLaser call (~every 60 ticks = 1s)
    if (this._laserFireCount % 10 === 0) {
      const asteroidCount = nearby.filter(e=>e.type==='asteroid').length;
      let closestAstDist = Infinity;
      let closestAstPos = {x:0,y:0};
      let closestAstEid = 0;
      let totalAstInSystem = 0;
      for (const aeid of asteroidQuery(this.world)) {
        if (InSystem.systemId[aeid] !== systemId) continue;
        totalAstInSystem++;
        const dx = Position.x[aeid] - x;
        const dy = Position.y[aeid] - y;
        const d = Math.sqrt(dx*dx+dy*dy);
        if (d < closestAstDist) { closestAstDist = d; closestAstPos = {x: Position.x[aeid], y: Position.y[aeid]}; closestAstEid = aeid; }
      }
      console.log(`[LASER] tick=${this.currentTick} player@(${Math.round(x)},${Math.round(y)}) sys=${systemId} aim=${angle.toFixed(2)} range=${Math.round(range)} nearby=${nearby.length}(ast=${asteroidCount}) totalAstInSys=${totalAstInSystem} closestAst:eid=${closestAstEid}@(${Math.round(closestAstPos.x)},${Math.round(closestAstPos.y)}) dist=${Math.round(closestAstDist)}`);
    }
    
    // Pre-compute ray direction for enemy circle collision
    const rdx = endX - startX;
    const rdy = endY - startY;
    const len = Math.sqrt(rdx * rdx + rdy * rdy);
    const nx = rdx / len;
    const ny = rdy / len;
    
    for (const spatialEntity of nearby) {
      if (spatialEntity.type === 'player' || spatialEntity.type === 'item') continue;
      const eid = spatialEntity.id;
      if (hasComponent(this.world, Dead, eid)) continue;
      if (InSystem.systemId[eid] !== systemId) continue;
      
      // Unified circle collision for all target types.
      // Server uses circle (generous) collision for gameplay feel;
      // client uses polygon hitscan only for visual beam endpoint.
      const ex = spatialEntity.x;
      const ey = spatialEntity.y;
      const er = spatialEntity.type === 'asteroid'
        ? (Asteroid.size[eid] || 50) * 1.2  // more forgiving to small desync
        : spatialEntity.radius;
      const toEx = ex - startX;
      const toEy = ey - startY;
      const proj = toEx * nx + toEy * ny;
      if (proj < 0 || proj > len) continue;
      const perpDist = Math.abs(toEx * ny - toEy * nx);
      if (perpDist < er) {
        const t = proj / len;
        if (t < bestT) {
          bestT = t;
          hitEntity = eid;
          isAsteroid = spatialEntity.type === 'asteroid';
        }
      }
    }
    
    const closestDist = bestT * range;
    
    // Apply damage with distance falloff
    if (hitEntity) {
      const falloff = 1 - closestDist / range;
      const finalDamage = (damage / 10) * falloff; // Per-tick damage
      
      // DEBUG: log hits
      if (this._laserFireCount % 10 === 0) {
        console.log(`[LASER HIT] eid=${hitEntity} asteroid=${isAsteroid} dist=${closestDist.toFixed(0)} dmg=${finalDamage.toFixed(2)} hp=${isAsteroid ? Asteroid.hp[hitEntity].toFixed(0) : 'N/A'}`);
      }
      
      if (isAsteroid) {
        // Damage asteroid
        Asteroid.hp[hitEntity] = Math.max(0, Asteroid.hp[hitEntity] - finalDamage);
        
        // Check if destroyed
        if (Asteroid.hp[hitEntity] <= 0 && !hasComponent(this.world, Dead, hitEntity)) {
          addComponent(this.world, Dead, hitEntity);
          this.pendingRemovedEntities.add(hitEntity);
          
          const ax = Position.x[hitEntity];
          const ay = Position.y[hitEntity];
          
          // Broadcast asteroid break
          this.broadcastToSystem(systemId, {
            type: 'effect',
            effectType: EffectType.AsteroidBreak,
            x: ax,
            y: ay,
            data: [Asteroid.size[hitEntity], 30], // size, hue
          });
          
          // Spawn loot
          const dropChance = 0.15 + Asteroid.size[hitEntity] * 0.05;
          if (Math.random() < dropChance) {
            this.spawnAsteroidLoot(ax, ay, Asteroid.size[hitEntity], systemId);
          }
          
          // Quest progress for mining
          if (hasComponent(this.world, Player, shooterEid)) {
            this.updateQuestProgress(shooterEid, 'mine', { count: 1 });
          }
        }
      } else {
        // Damage enemy
        Health.current[hitEntity] -= finalDamage;
        
        // Update last damage tick for regen delay
        if (hasComponent(this.world, Player, hitEntity)) {
          Health.lastDamageTick[hitEntity] = this.currentTick;
        }
      }
      
      // Broadcast damage (include hp/maxHp for asteroids so client can update without snapshots)
      const dmgMsg: any = {
        type: 'damage',
        targetId: hitEntity,
        amount: finalDamage,
        sourceId: shooterEid,
      };
      if (isAsteroid) {
        dmgMsg.hp = Math.round(Asteroid.hp[hitEntity]);
        dmgMsg.maxHp = Math.round(Asteroid.maxHp[hitEntity]);
      }
      this.broadcastToSystem(systemId, dmgMsg);
    }
  }

  private fireMissile(shooterEid: number, x: number, y: number, angle: number, item: any, systemId: number): void {
    const eid = addEntity(this.world);
    addComponent(this.world, Position, eid);
    addComponent(this.world, Velocity, eid);
    addComponent(this.world, Radius, eid);
    addComponent(this.world, Projectile, eid);
    addComponent(this.world, Missile, eid);
    addComponent(this.world, Lifetime, eid);
    addComponent(this.world, InSystem, eid);
    addComponent(this.world, NetworkSync, eid);
    addComponent(this.world, OwnedBy, eid);
    
    const speed = MISSILE_SPEED * (item.speed || 1);
    const damage = BULLET_DAMAGE * 2.5 * (item.damage || 1);
    
    const spawnX = x + Math.cos(angle) * 30;
    const spawnY = y + Math.sin(angle) * 30;
    
    Position.x[eid] = spawnX;
    Position.y[eid] = spawnY;
    Velocity.x[eid] = Math.cos(angle) * speed;
    Velocity.y[eid] = Math.sin(angle) * speed;
    Radius.value[eid] = 8;
    Projectile.ownerId[eid] = shooterEid;
    Projectile.damage[eid] = damage;
    Projectile.weaponType[eid] = WeaponType.Missile;
    Projectile.tier[eid] = item.tier || 1;
    Projectile.spawnTick[eid] = this.currentTick;
    Projectile.spawnX[eid] = spawnX;
    Projectile.spawnY[eid] = spawnY;
    Missile.targetId[eid] = 0;  // Will acquire target
    Missile.turnRate[eid] = MISSILE_TURN_RATE * (item.homing || 1);
    Missile.fuel[eid] = MISSILE_FUEL_TICKS;
    Missile.armed[eid] = 0;
    Lifetime.remaining[eid] = MISSILE_FUEL_TICKS + 60;
    InSystem.systemId[eid] = systemId;
    OwnedBy.ownerId[eid] = shooterEid;
  }

  private firePulse(shooterEid: number, x: number, y: number, angle: number, item: any, systemId: number): void {
    const eid = addEntity(this.world);
    addComponent(this.world, Position, eid);
    addComponent(this.world, Velocity, eid);
    addComponent(this.world, Radius, eid);
    addComponent(this.world, Projectile, eid);
    addComponent(this.world, Pulse, eid);
    addComponent(this.world, Lifetime, eid);
    addComponent(this.world, InSystem, eid);
    addComponent(this.world, NetworkSync, eid);
    addComponent(this.world, OwnedBy, eid);
    
    const speed = 42 * (item.speed || 1);
    const damage = BULLET_DAMAGE * 3 * (item.damage || 1);
    const splashRadius = item.splashRadius || 220;
    
    const spawnX = x + Math.cos(angle) * 30;
    const spawnY = y + Math.sin(angle) * 30;
    
    Position.x[eid] = spawnX;
    Position.y[eid] = spawnY;
    Velocity.x[eid] = Math.cos(angle) * speed + Velocity.x[shooterEid] * 0.2;
    Velocity.y[eid] = Math.sin(angle) * speed + Velocity.y[shooterEid] * 0.2;
    Radius.value[eid] = 15;
    Projectile.ownerId[eid] = shooterEid;
    Projectile.damage[eid] = damage;
    Projectile.weaponType[eid] = WeaponType.Pulse;
    Projectile.tier[eid] = item.tier || 1;
    Projectile.spawnTick[eid] = this.currentTick;
    Projectile.spawnX[eid] = spawnX;
    Projectile.spawnY[eid] = spawnY;
    Pulse.splashRadius[eid] = splashRadius;
    Lifetime.remaining[eid] = 180; // 3 seconds
    InSystem.systemId[eid] = systemId;
    OwnedBy.ownerId[eid] = shooterEid;
  }

  private fireMine(shooterEid: number, x: number, y: number, item: any, systemId: number): void {
    // Check max mines
    const existingMines = mineQuery(this.world);
    let mineCount = 0;
    for (const eid of existingMines) {
      if (Mine.ownerId[eid] === shooterEid) {
        mineCount++;
      }
    }
    
    const maxMines = item.maxMines || 3;
    if (mineCount >= maxMines) {
      // Remove oldest mine
      for (const eid of existingMines) {
        if (Mine.ownerId[eid] === shooterEid) {
          addComponent(this.world, Dead, eid);
          break;
        }
      }
    }
    
    const eid = addEntity(this.world);
    addComponent(this.world, Position, eid);
    addComponent(this.world, Velocity, eid);
    addComponent(this.world, Radius, eid);
    addComponent(this.world, Mine, eid);
    addComponent(this.world, Lifetime, eid);
    addComponent(this.world, InSystem, eid);
    addComponent(this.world, NetworkSync, eid);
    
    const damage = item.damage || 150;
    const splashRadius = item.splashRadius || 400;
    
    // Drop mine behind player
    const angle = Rotation.angle[shooterEid];
    Position.x[eid] = x - Math.cos(angle) * 40;
    Position.y[eid] = y - Math.sin(angle) * 40;
    Velocity.x[eid] = -Math.cos(angle) * 2;
    Velocity.y[eid] = -Math.sin(angle) * 2;
    Radius.value[eid] = 20;
    Mine.ownerId[eid] = shooterEid;
    Mine.damage[eid] = damage;
    Mine.splashRadius[eid] = splashRadius;
    Mine.armTimer[eid] = item.armTicks || MINE_ARM_TICKS;
    Mine.armed[eid] = 0;
    Lifetime.remaining[eid] = item.lifeTicks || MINE_LIFE_TICKS;
    InSystem.systemId[eid] = systemId;
  }

  private fireMining(shooterEid: number, x: number, y: number, angle: number, item: any, systemId: number): void {
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
    
    const speed = 22 * (item.speed || 1);
    const damage = item.damage || 100;
    
    const spawnX = x + Math.cos(angle) * 30;
    const spawnY = y + Math.sin(angle) * 30;
    
    Position.x[eid] = spawnX;
    Position.y[eid] = spawnY;
    Velocity.x[eid] = Math.cos(angle) * speed + Velocity.x[shooterEid] * 0.3;
    Velocity.y[eid] = Math.sin(angle) * speed + Velocity.y[shooterEid] * 0.3;
    Radius.value[eid] = 10;
    Projectile.ownerId[eid] = shooterEid;
    Projectile.damage[eid] = damage;
    Projectile.weaponType[eid] = WeaponType.Mining;
    Projectile.tier[eid] = item.tier || 1;
    Projectile.spawnTick[eid] = this.currentTick;
    Projectile.spawnX[eid] = spawnX;
    Projectile.spawnY[eid] = spawnY;
    Bullet.speed[eid] = speed;
    Lifetime.remaining[eid] = 300; // 5 seconds - slow moving
    InSystem.systemId[eid] = systemId;
    OwnedBy.ownerId[eid] = shooterEid;
  }

  private projectileSystem(): void {
    const projectiles = projectileQuery(this.world);
    
    for (const eid of projectiles) {
      // Apply scatter friction
      if (Projectile.weaponType[eid] === WeaponType.Scatter) {
        Velocity.x[eid] *= SCATTER_FRICTION;
        Velocity.y[eid] *= SCATTER_FRICTION;
      }
      
      // Update position
      Position.x[eid] += Velocity.x[eid];
      Position.y[eid] += Velocity.y[eid];
    }
  }

  private missileHomingSystem(): void {
    const missiles = missileQuery(this.world);
    const enemies = enemyQuery(this.world);
    
    for (const eid of missiles) {
      if (Missile.fuel[eid] <= 0) continue;
      Missile.fuel[eid]--;
      
      const systemId = InSystem.systemId[eid];
      const mx = Position.x[eid];
      const my = Position.y[eid];
      
      // Find or verify target
      let targetId = Missile.targetId[eid];
      
      if (!targetId || !hasComponent(this.world, Enemy, targetId)) {
        // Acquire new target - find closest enemy
        let closestDist = 1200;  // Max acquisition range
        
        for (const enemy of enemies) {
          if (InSystem.systemId[enemy] !== systemId) continue;
          
          const dx = Position.x[enemy] - mx;
          const dy = Position.y[enemy] - my;
          const dist = Math.sqrt(dx * dx + dy * dy);
          
          if (dist < closestDist) {
            closestDist = dist;
            targetId = enemy;
          }
        }
        
        Missile.targetId[eid] = targetId;
      }
      
      if (targetId) {
        // Home towards target
        const tx = Position.x[targetId];
        const ty = Position.y[targetId];
        
        const dx = tx - mx;
        const dy = ty - my;
        const targetAngle = Math.atan2(dy, dx);
        
        const vx = Velocity.x[eid];
        const vy = Velocity.y[eid];
        const currentAngle = Math.atan2(vy, vx);
        
        let angleDiff = targetAngle - currentAngle;
        while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
        while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
        
        const turnRate = Missile.turnRate[eid] * 0.01;
        const turn = Math.sign(angleDiff) * Math.min(Math.abs(angleDiff), turnRate);
        const newAngle = currentAngle + turn;
        
        const speed = Math.sqrt(vx * vx + vy * vy);
        Velocity.x[eid] = Math.cos(newAngle) * speed * MISSILE_DAMPING + Math.cos(newAngle) * MISSILE_ACCEL;
        Velocity.y[eid] = Math.sin(newAngle) * speed * MISSILE_DAMPING + Math.sin(newAngle) * MISSILE_ACCEL;
      }
    }
  }

  private mineSystem(): void {
    const mines = mineQuery(this.world);
    const players = playerQuery(this.world);
    const enemies = enemyQuery(this.world);
    
    for (const eid of mines) {
      // Arm timer
      if (Mine.armTimer[eid] > 0) {
        Mine.armTimer[eid]--;
        if (Mine.armTimer[eid] === 0) {
          Mine.armed[eid] = 1;
          // Broadcast arm effect
          this.broadcastToSystem(InSystem.systemId[eid], {
            type: 'effect',
            effectType: EffectType.MineArm,
            x: Position.x[eid],
            y: Position.y[eid],
          });
        }
        continue;
      }
      
      if (!Mine.armed[eid]) continue;
      
      const mx = Position.x[eid];
      const my = Position.y[eid];
      const detectRadius = Mine.splashRadius[eid] * 0.5;
      const ownerId = Mine.ownerId[eid];
      const systemId = InSystem.systemId[eid];
      
      // Check for nearby enemies
      for (const enemy of enemies) {
        if (InSystem.systemId[enemy] !== systemId) continue;
        
        const dx = Position.x[enemy] - mx;
        const dy = Position.y[enemy] - my;
        const dist = Math.sqrt(dx * dx + dy * dy);
        
        if (dist < detectRadius) {
          // Explode!
          this.explodeMine(eid);
          break;
        }
      }
    }
  }

  private explodeMine(mineEid: number): void {
    const x = Position.x[mineEid];
    const y = Position.y[mineEid];
    const damage = Mine.damage[mineEid];
    const radius = Mine.splashRadius[mineEid];
    const systemId = InSystem.systemId[mineEid];
    
    // Damage all enemies in radius
    const enemies = enemyQuery(this.world);
    for (const eid of enemies) {
      if (InSystem.systemId[eid] !== systemId) continue;
      
      const dx = Position.x[eid] - x;
      const dy = Position.y[eid] - y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      
      if (dist < radius) {
        const falloff = 1 - dist / radius;
        const finalDamage = damage * falloff;
        Health.current[eid] -= finalDamage;
        
        this.broadcastToSystem(systemId, {
          type: 'damage',
          targetId: eid,
          amount: finalDamage,
        });
      }
    }
    
    // Explosion effect
    this.broadcastToSystem(systemId, {
      type: 'effect',
      effectType: EffectType.Explosion,
      x,
      y,
      data: [radius],
    });
    
    addComponent(this.world, Dead, mineEid);
  }

  private miningProjectileSystem(): void {
    const miningProjectiles = miningProjectileQuery(this.world);
    const asteroids = asteroidQuery(this.world);
    
    for (const eid of miningProjectiles) {
      const attachedTo = MiningShot.attachedToId[eid];
      
      if (attachedTo > 0) {
        // Projectile is attached to an asteroid - apply DoT
        if (!hasComponent(this.world, Asteroid, attachedTo)) {
          // Asteroid was destroyed, remove mining shot
          addComponent(this.world, Dead, eid);
          continue;
        }
        
        // Position stays on the asteroid
        Position.x[eid] = Position.x[attachedTo];
        Position.y[eid] = Position.y[attachedTo];
        Velocity.x[eid] = 0;
        Velocity.y[eid] = 0;
        
        // DoT timer
        MiningShot.dotTimer[eid]--;
        if (MiningShot.dotTimer[eid] <= 0) {
          // Apply damage tick
          const damage = MiningShot.dotDamage[eid];
          Asteroid.hp[attachedTo] -= damage;
          
          // Check for asteroid destruction
          if (Asteroid.hp[attachedTo] <= 0) {
            addComponent(this.world, Dead, attachedTo);
          }
          
          // Reset timer
          MiningShot.dotTimer[eid] = MiningShot.dotInterval[eid];
        }
        
        // Reduce remaining duration
        MiningShot.dotDuration[eid]--;
        if (MiningShot.dotDuration[eid] <= 0) {
          addComponent(this.world, Dead, eid);
        }
      } else {
        // Projectile is still flying - check for asteroid collision
        const px = Position.x[eid];
        const py = Position.y[eid];
        const pRadius = Radius.value[eid] || 10;
        const systemId = InSystem.systemId[eid];
        
        for (const asteroid of asteroids) {
          if (InSystem.systemId[asteroid] !== systemId) continue;
          
          const ax = Position.x[asteroid];
          const ay = Position.y[asteroid];
          const aRadius = Asteroid.size[asteroid] * 0.8;
          
          const dx = ax - px;
          const dy = ay - py;
          const dist = Math.sqrt(dx * dx + dy * dy);
          
          if (dist < pRadius + aRadius) {
            // Attach to this asteroid
            MiningShot.attachedToId[eid] = asteroid;
            
            // Apply initial hit damage
            const damage = Projectile.damage[eid];
            Asteroid.hp[asteroid] -= damage;
            
            if (Asteroid.hp[asteroid] <= 0) {
              addComponent(this.world, Dead, asteroid);
            }
            
            break;
          }
        }
      }
    }
  }

  private asteroidOrbitSystem(): void {
    const asteroids = asteroidQuery(this.world);
    
    for (const eid of asteroids) {
      const { x, y } = calcAsteroidPosition({
        orbitType: Asteroid.orbitType[eid],
        semiMajorAxis: Asteroid.semiMajorAxis[eid],
        eccentricity: Asteroid.eccentricity[eid],
        argPeriapsis: Asteroid.argPeriapsis[eid],
        meanAnomaly0: Asteroid.meanAnomaly0[eid],
        epochTick: Asteroid.epochTick[eid],
      }, this.currentTick);
      Position.x[eid] = x;
      Position.y[eid] = y;
    }
  }

  private stationOrbitSystem(): void {
    const stations = stationQuery(this.world);

    for (const eid of stations) {
      if (Station.orbitType[eid] === 255 || Station.semiMajorAxis[eid] <= 0) continue;
      const { x, y } = calcAsteroidPosition({
        orbitType: Station.orbitType[eid],
        semiMajorAxis: Station.semiMajorAxis[eid],
        eccentricity: Station.eccentricity[eid],
        argPeriapsis: Station.argPeriapsis[eid],
        meanAnomaly0: Station.meanAnomaly0[eid],
        epochTick: Station.epochTick[eid],
      }, this.currentTick);
      Position.x[eid] = x;
      Position.y[eid] = y;
    }
  }

  private enemyAISystem(): void {
    const enemies = enemyQuery(this.world);
    const players = playerQuery(this.world);
    
    for (const eid of enemies) {
      const systemId = InSystem.systemId[eid];
      const behavior = AI.behaviorType[eid];
      const state = AI.state[eid];
      
      AI.stateTimer[eid]++;
      if (AI.attackCooldown[eid] > 0) AI.attackCooldown[eid]--;
      
      const ex = Position.x[eid];
      const ey = Position.y[eid];
      
      // Find closest player in same system
      let closestPlayer = 0;
      let closestDist = Infinity;
      
      for (const player of players) {
        if (InSystem.systemId[player] !== systemId) continue;
        
        const dx = Position.x[player] - ex;
        const dy = Position.y[player] - ey;
        const dist = Math.sqrt(dx * dx + dy * dy);
        
        if (dist < closestDist) {
          closestDist = dist;
          closestPlayer = player;
        }
      }
      
      // State machine
      switch (state) {
        case AIState.Idle:
          if (closestPlayer && closestDist < AI.aggroRange[eid]) {
            AI.state[eid] = AIState.Chase;
            AI.targetId[eid] = closestPlayer;
            AI.stateTimer[eid] = 0;
          }
          break;
          
        case AIState.Chase:
          if (!closestPlayer || closestDist > AI.deaggroRange[eid]) {
            AI.state[eid] = AIState.Return;
            AI.stateTimer[eid] = 0;
            break;
          }
          
          // Move towards player
          const targetX = Position.x[closestPlayer];
          const targetY = Position.y[closestPlayer];
          const dx = targetX - ex;
          const dy = targetY - ey;
          const dist = Math.sqrt(dx * dx + dy * dy);
          
          if (dist > 0) {
            const enemyData = this.gameData.getEnemy('ice_sprite');
            const speed = enemyData?.speed || 2.5;
            
            Velocity.x[eid] = (dx / dist) * speed;
            Velocity.y[eid] = (dy / dist) * speed;
          }
          
          // Attack if in range
          if (dist < 600 && AI.attackCooldown[eid] === 0) {
            AI.state[eid] = AIState.Attack;
            AI.stateTimer[eid] = 0;
          }
          break;
          
        case AIState.Attack:
          if (AI.attackCooldown[eid] === 0) {
            // Fire at player
            this.enemyAttack(eid, closestPlayer);
            AI.attackCooldown[eid] = 90;
          }
          
          if (AI.stateTimer[eid] > 30) {
            AI.state[eid] = AIState.Chase;
            AI.stateTimer[eid] = 0;
          }
          break;
          
        case AIState.Return:
          // Move back to home position
          const homeX = AI.homeX[eid];
          const homeY = AI.homeY[eid];
          const dxHome = homeX - ex;
          const dyHome = homeY - ey;
          const distHome = Math.sqrt(dxHome * dxHome + dyHome * dyHome);
          
          if (distHome < 100) {
            AI.state[eid] = AIState.Idle;
            AI.stateTimer[eid] = 0;
          } else {
            const enemyData = this.gameData.getEnemy('ice_sprite');
            const speed = enemyData?.speed || 2.5;
            Velocity.x[eid] = (dxHome / distHome) * speed;
            Velocity.y[eid] = (dyHome / distHome) * speed;
          }
          break;
      }
      
      // Update position
      Position.x[eid] += Velocity.x[eid];
      Position.y[eid] += Velocity.y[eid];
    }
  }

  private enemyAttack(enemyEid: number, targetEid: number): void {
    const x = Position.x[enemyEid];
    const y = Position.y[enemyEid];
    const tx = Position.x[targetEid];
    const ty = Position.y[targetEid];
    const angle = Math.atan2(ty - y, tx - x);
    const systemId = InSystem.systemId[enemyEid];
    
    // Create enemy projectile
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
    
    Position.x[eid] = x + Math.cos(angle) * 30;
    Position.y[eid] = y + Math.sin(angle) * 30;
    Velocity.x[eid] = Math.cos(angle) * 8;
    Velocity.y[eid] = Math.sin(angle) * 8;
    Radius.value[eid] = 6;
    Projectile.ownerId[eid] = enemyEid;
    Projectile.damage[eid] = 5;
    Projectile.weaponType[eid] = WeaponType.Cannon;
    Bullet.speed[eid] = 8;
    Lifetime.remaining[eid] = 180;
    InSystem.systemId[eid] = systemId;
    OwnedBy.ownerId[eid] = enemyEid;
  }

  private enemySpawnSystem(): void {
    for (const system of this.gameData.getAllSystems()) {
      const systemNum = this.gameData.getSystemNum(system.id);
      
      for (const enemyTypeId of system.enemies) {
        const key = `${system.id}_${enemyTypeId}`;
        const enemyData = this.gameData.getEnemy(enemyTypeId);
        if (!enemyData) continue;
        
        // Get current count
        const currentCount = enemyQuery(this.world).filter(
          eid => InSystem.systemId[eid] === systemNum
        ).length;
        
        // Check spawn timer
        let timer = this.enemySpawnTimers.get(key) || 0;
        timer++;
        
        if (timer >= enemyData.spawnInfo.spawnInterval && currentCount < enemyData.spawnInfo.maxCount) {
          this.spawnEnemy(enemyData, systemNum);
          timer = 0;
        }
        
        this.enemySpawnTimers.set(key, timer);
      }
    }
  }

  private spawnEnemy(data: any, systemNum: number): void {
    const eid = addEntity(this.world);
    
    addComponent(this.world, Position, eid);
    addComponent(this.world, Velocity, eid);
    addComponent(this.world, Radius, eid);
    addComponent(this.world, Health, eid);
    addComponent(this.world, Enemy, eid);
    addComponent(this.world, AI, eid);
    addComponent(this.world, InSystem, eid);
    addComponent(this.world, NetworkSync, eid);
    
    // Random position in spawn ring
    const angle = Math.random() * Math.PI * 2;
    const minR = data.spawnInfo.minRadius;
    const maxR = data.spawnInfo.maxRadius;
    const radius = minR + Math.random() * (maxR - minR);
    
    Position.x[eid] = Math.cos(angle) * radius;
    Position.y[eid] = Math.sin(angle) * radius;
    Velocity.x[eid] = 0;
    Velocity.y[eid] = 0;
    Radius.value[eid] = data.radius;
    Health.current[eid] = data.hp;
    Health.max[eid] = data.hp;
    Enemy.xpValue[eid] = data.xp;
    AI.behaviorType[eid] = AIBehavior.Aggressive;
    AI.state[eid] = AIState.Idle;
    AI.targetId[eid] = 0;
    AI.stateTimer[eid] = 0;
    AI.attackCooldown[eid] = 0;
    AI.homeX[eid] = Position.x[eid];
    AI.homeY[eid] = Position.y[eid];
    AI.aggroRange[eid] = data.ai.detectionRange;
    AI.deaggroRange[eid] = data.ai.loseAggroRange;
    InSystem.systemId[eid] = systemNum;
  }

  private collisionSystem(): void {
    const projectiles = projectileQuery(this.world);
    const players = playerQuery(this.world);
    const enemies = enemyQuery(this.world);
    
    // Projectile vs Enemy/Player/Asteroid using spatial grid
    for (const proj of projectiles) {
      if (hasComponent(this.world, Dead, proj)) continue;
      
      const px = Position.x[proj];
      const py = Position.y[proj];
      const pr = Radius.value[proj];
      const systemId = InSystem.systemId[proj];
      const ownerId = Projectile.ownerId[proj];
      
      // Calculate the ray from current position to next (projectile moves fast)
      const vx = Velocity.x[proj];
      const vy = Velocity.y[proj];
      const endX = px + vx;
      const endY = py + vy;
      const speed = Math.sqrt(vx * vx + vy * vy);
      
      // Use spatial grid to find nearby entities
      const nearby = this.spatialGrid.queryRay(px, py, endX, endY, speed + 100);
      perfMetrics.spatialQueries++;
      
      // Check against enemies (if player projectile)
      if (hasComponent(this.world, Player, ownerId)) {
        for (const spatialEntity of nearby) {
          if (spatialEntity.type !== 'enemy') continue;
          const enemy = spatialEntity.id;
          
          if (hasComponent(this.world, Dead, enemy)) continue;
          if (InSystem.systemId[enemy] !== systemId) continue;
          
          perfMetrics.collisionChecks++;
          
          const ex = Position.x[enemy];
          const ey = Position.y[enemy];
          const er = Radius.value[enemy];
          
          const dx = ex - px;
          const dy = ey - py;
          const dist = Math.sqrt(dx * dx + dy * dy);
          
          if (dist < pr + er) {
            // Hit!
            Health.current[enemy] -= Projectile.damage[proj];
            addComponent(this.world, Dead, proj);
            this.pendingRemovedEntities.add(proj);
            
            this.broadcastToSystem(systemId, {
              type: 'damage',
              targetId: enemy,
              amount: Projectile.damage[proj],
              sourceId: ownerId,
            });
            
            break;
          }
        }
      }
      
      // Check against players (if enemy projectile)
      if (hasComponent(this.world, Enemy, ownerId)) {
        for (const spatialEntity of nearby) {
          if (spatialEntity.type !== 'player') continue;
          const player = spatialEntity.id;
          
          if (hasComponent(this.world, Dead, player)) continue;
          if (InSystem.systemId[player] !== systemId) continue;
          
          perfMetrics.collisionChecks++;
          
          const plx = Position.x[player];
          const ply = Position.y[player];
          const plr = Radius.value[player];
          
          const dx = plx - px;
          const dy = ply - py;
          const dist = Math.sqrt(dx * dx + dy * dy);
          
          if (dist < pr + plr) {
            Health.current[player] -= Projectile.damage[proj];
            Health.lastDamageTick[player] = this.currentTick;
            addComponent(this.world, Dead, proj);
            this.pendingRemovedEntities.add(proj);
            
            this.broadcastToSystem(systemId, {
              type: 'damage',
              targetId: player,
              amount: Projectile.damage[proj],
              sourceId: ownerId,
            });
            
            break;
          }
        }
      }
      
      // Skip if projectile already dead (hit enemy or player)
      if (hasComponent(this.world, Dead, proj)) {
        this.pendingRemovedEntities.add(proj);
        continue;
      }
      
      // Check against asteroids using ray-traced collision with spatial grid
      let hitAsteroid: number | null = null;
      let hitX = endX;
      let hitY = endY;
      let bestT = Infinity;
      
      for (const spatialEntity of nearby) {
        if (spatialEntity.type !== 'asteroid') continue;
        const asteroid = spatialEntity.id;
        
        if (hasComponent(this.world, Dead, asteroid)) continue;
        if (InSystem.systemId[asteroid] !== systemId) continue;
        
        perfMetrics.collisionChecks++;
        
        const ax = Position.x[asteroid];
        const ay = Position.y[asteroid];
        const ar = Asteroid.size[asteroid];
        
        // Get asteroid polygon for precise collision
        const poly = getAsteroidPolygon(asteroid, ax, ay, ar);
        
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
        addComponent(this.world, Dead, proj);
        this.pendingRemovedEntities.add(proj);
        
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
          
          // Spawn loot
          const dropChance = 0.15 + Asteroid.size[hitAsteroid] * 0.05;
          if (Math.random() < dropChance) {
            this.spawnAsteroidLoot(ax, ay, Asteroid.size[hitAsteroid], systemId);
          }
          
          // Quest progress for mining
          if (hasComponent(this.world, Player, ownerId)) {
            this.updateQuestProgress(ownerId, 'mine', { count: 1 });
          }
        }
      }
    }
    
    // Check enemy deaths
    for (const enemy of enemies) {
      if (Health.current[enemy] <= 0 && !hasComponent(this.world, Dead, enemy)) {
        addComponent(this.world, Dead, enemy);
        
        const systemId = InSystem.systemId[enemy];
        const xp = Enemy.xpValue[enemy];
        const enemyType = Enemy.typeId[enemy];
        const enemyTypeName = this.gameData.getEnemyByNum(enemyType)?.id || '';
        
        // Grant XP to nearby players
        for (const player of players) {
          if (InSystem.systemId[player] === systemId) {
            const dx = Position.x[player] - Position.x[enemy];
            const dy = Position.y[player] - Position.y[enemy];
            const dist = Math.sqrt(dx * dx + dy * dy);
            
            if (dist < 2000) {
              Player.xp[player] += xp;
              
              // Level up check
              this.checkLevelUp(player);
              
              // Quest progress for kills
              this.updateQuestProgress(player, 'kill', { enemyType: enemyTypeName });
            }
          }
        }
        
        this.broadcastToSystem(systemId, {
          type: 'death',
          entityId: enemy,
          entityType: EntityType.Enemy,
        });
        
        // Spawn drops
        this.spawnDrops(enemy);
      }
    }
    
    // Check player deaths
    for (const player of players) {
      if (Health.current[player] <= 0 && !hasComponent(this.world, Dead, player)) {
        addComponent(this.world, Dead, player);
        
        const systemId = InSystem.systemId[player];
        
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

  private spawnDrops(enemyEid: number): void {
    const x = Position.x[enemyEid];
    const y = Position.y[enemyEid];
    const systemId = InSystem.systemId[enemyEid];
    
    // Get enemy type data
    const enemyData = this.gameData.getEnemy('ice_sprite');
    if (!enemyData) return;
    
    for (const drop of enemyData.drops) {
      if (Math.random() < drop.chance) {
        const count = drop.minCount + Math.floor(Math.random() * (drop.maxCount - drop.minCount + 1));
        this.spawnDroppedItem(x, y, drop.itemId, count, systemId);
      }
    }
  }

  private spawnDroppedItem(x: number, y: number, itemId: string, count: number, systemId: number): void {
    const eid = addEntity(this.world);
    
    addComponent(this.world, Position, eid);
    addComponent(this.world, Velocity, eid);
    addComponent(this.world, Radius, eid);
    addComponent(this.world, DroppedItem, eid);
    addComponent(this.world, Lifetime, eid);
    addComponent(this.world, InSystem, eid);
    addComponent(this.world, NetworkSync, eid);
    
    // Random scatter from death position
    const angle = Math.random() * Math.PI * 2;
    const dist = 20 + Math.random() * 30;
    
    Position.x[eid] = x + Math.cos(angle) * dist;
    Position.y[eid] = y + Math.sin(angle) * dist;
    Velocity.x[eid] = Math.cos(angle) * 3;
    Velocity.y[eid] = Math.sin(angle) * 3;
    Radius.value[eid] = 15;
    DroppedItem.itemId[eid] = this.gameData.getItemNum(itemId);
    DroppedItem.stackCount[eid] = count;
    Lifetime.remaining[eid] = ITEM_LIFETIME_TICKS;
    InSystem.systemId[eid] = systemId;
  }

  private asteroidDeathSystem(): void {
    const asteroids = asteroidQuery(this.world);
    
    for (const eid of asteroids) {
      if (hasComponent(this.world, Dead, eid)) continue;
      if (Asteroid.hp[eid] <= 0) {
        addComponent(this.world, Dead, eid);
        this.pendingRemovedEntities.add(eid);
        
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
        const dropChance = 0.15 + size * 0.05; // 15-40% chance based on size
        if (Math.random() < dropChance) {
          this.spawnAsteroidLoot(x, y, size, systemId);
        }
      }
    }
  }

  private spawnAsteroidLoot(x: number, y: number, size: number, systemId: number): void {
    // Determine loot tier based on system and size
    const systemData = this.gameData.getSystemByNum(systemId);
    const systemId_str = systemData?.id || 'sol';
    
    // Loot tables - weapons more likely from bigger asteroids
    const lootTable: { itemId: string; weight: number; minSize: number }[] = [
      { itemId: 'blaster_mk1', weight: 30, minSize: 1 },
      { itemId: 'laser_mk1', weight: 25, minSize: 1 },
      { itemId: 'scatter_mk1', weight: 20, minSize: 2 },
      { itemId: 'missile_mk1', weight: 15, minSize: 3 },
      { itemId: 'booster_mk1', weight: 5, minSize: 2 },
      { itemId: 'cockpit_mk1', weight: 5, minSize: 2 },
    ];
    
    // Filter by size requirement
    const available = lootTable.filter(l => size >= l.minSize);
    if (available.length === 0) return;
    
    // Weighted random selection
    const totalWeight = available.reduce((sum, l) => sum + l.weight, 0);
    let roll = Math.random() * totalWeight;
    
    for (const loot of available) {
      roll -= loot.weight;
      if (roll <= 0) {
        this.spawnDroppedItem(x, y, loot.itemId, 1, systemId);
        return;
      }
    }
    
    // Fallback
    this.spawnDroppedItem(x, y, available[0].itemId, 1, systemId);
  }

  private checkLevelUp(playerEid: number): void {
    const currentLevel = Player.level[playerEid];
    if (currentLevel >= MAX_LEVEL) return;
    
    const currentXp = Player.xp[playerEid];
    const xpNeeded = xpForLevel(currentLevel + 1);
    
    if (currentXp >= xpNeeded) {
      // Level up!
      Player.level[playerEid]++;
      Player.xp[playerEid] -= xpNeeded;
      
      const newLevel = Player.level[playerEid];
      
      // Increase max HP with level
      const oldMaxHp = Health.max[playerEid];
      const newMaxHp = PLAYER_MAX_HP + (newLevel - 1) * 10;
      Health.max[playerEid] = newMaxHp;
      Health.current[playerEid] += (newMaxHp - oldMaxHp); // Heal the difference
      
      // Find connection for this player
      for (const [ws, conn] of this.clients) {
        if (conn.playerId === playerEid) {
          this.send(ws, {
            type: 'levelUp',
            playerId: playerEid,
            newLevel: newLevel,
          });
          
          // Also send updated player state
          this.sendPlayerState(conn);
          break;
        }
      }
      
      // Check for additional level ups (if gained lots of XP)
      this.checkLevelUp(playerEid);
    }
  }

  private healthRegenSystem(): void {
    const players = playerQuery(this.world);
    
    for (const eid of players) {
      if (hasComponent(this.world, Dead, eid)) continue;
      
      // Health regen
      const ticksSinceDamage = this.currentTick - Health.lastDamageTick[eid];
      
      if (ticksSinceDamage > Health.regenDelay[eid]) {
        Health.current[eid] = Math.min(
          Health.max[eid],
          Health.current[eid] + Health.regenRate[eid]
        );
      }
      
      // Shield regen
      if (hasComponent(this.world, Shield, eid)) {
        const ticksSinceShieldDamage = this.currentTick - Shield.lastDamageTick[eid];
        
        if (ticksSinceShieldDamage > Shield.regenDelay[eid]) {
          Shield.current[eid] = Math.min(
            Shield.max[eid],
            Shield.current[eid] + Shield.regenRate[eid] / TICK_RATE
          );
        }
      }
    }
  }

  private lifetimeSystem(): void {
    const entities = lifetimeQuery(this.world);
    
    for (const eid of entities) {
      Lifetime.remaining[eid]--;
      
      if (Lifetime.remaining[eid] <= 0) {
        addComponent(this.world, Dead, eid);
        // Track for removal notification to clients
        this.pendingRemovedEntities.add(eid);
      }
    }
    
    // Apply friction to dropped items
    const items = droppedItemQuery(this.world);
    for (const eid of items) {
      Velocity.x[eid] *= ITEM_FRICTION;
      Velocity.y[eid] *= ITEM_FRICTION;
      Position.x[eid] += Velocity.x[eid];
      Position.y[eid] += Velocity.y[eid];
    }
  }

  private cleanupSystem(): void {
    const dead = deadQuery(this.world);
    
    for (const eid of dead) {
      // Ensure all dead entities are in the removed set (safety net)
      this.pendingRemovedEntities.add(eid);
      removeEntity(this.world, eid);
    }
  }

  // ============================================
  // NETWORKING
  // ============================================

  /** Get byte length of encoded message (string or ArrayBuffer) */
  private getMessageByteLength(data: string | ArrayBuffer): number {
    if (typeof data === 'string') {
      return data.length; // Approximation for ASCII/UTF-8 JSON
    }
    return data.byteLength;
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      const data = encodeMessage(msg);
      const byteLen = this.getMessageByteLength(data);
      this.snapshotBytesSent += byteLen;
      this.bytesByType[msg.type] = (this.bytesByType[msg.type] || 0) + byteLen;
      ws.send(data);
    }
  }

  private broadcast(msg: ServerMessage): void {
    const data = encodeMessage(msg);
    const byteLen = this.getMessageByteLength(data);
    let sent = 0;
    for (const client of this.clients.values()) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(data);
        sent++;
      }
    }
    const total = byteLen * sent;
    this.snapshotBytesSent += total;
    this.bytesByType[msg.type] = (this.bytesByType[msg.type] || 0) + total;
  }

  private broadcastToSystem(systemId: number, msg: ServerMessage): void {
    const data = encodeMessage(msg);
    const byteLen = this.getMessageByteLength(data);
    let sent = 0;
    for (const client of this.clients.values()) {
      if (client.ws.readyState !== WebSocket.OPEN) continue;
      if (!hasComponent(this.world, Player, client.playerId)) continue;
      if (InSystem.systemId[client.playerId] !== systemId) continue;
      
      client.ws.send(data);
      sent++;
    }
    const total = byteLen * sent;
    this.snapshotBytesSent += total;
    this.bytesByType[msg.type] = (this.bytesByType[msg.type] || 0) + total;
  }

  private sendSnapshots(): void {
    for (const conn of this.clients.values()) {
      if (conn.ws.readyState !== WebSocket.OPEN) continue;
      if (!hasComponent(this.world, Player, conn.playerId)) continue;
      
      const playerSystemId = InSystem.systemId[conn.playerId];
      const entities: EntityState[] = [];
      const removed: number[] = Array.from(this.pendingRemovedEntities);
      const prevStates = this.lastEntityStates.get(conn.playerId) || new Map<number, string>();
      const newStates = new Map<number, string>();
      const markIfChanged = (state: EntityState) => {
        const key = JSON.stringify(state);
        newStates.set(state.id, key);
        if (prevStates.get(state.id) !== key) {
          entities.push(state);
        }
      };
      
      // Players
      for (const eid of playerQuery(this.world)) {
        if (InSystem.systemId[eid] !== playerSystemId) continue;
        
        // Find the username for this player entity
        let playerName: string | undefined;
        for (const c of this.clients.values()) {
          if (c.playerId === eid) {
            playerName = c.username;
            break;
          }
        }
        
        markIfChanged({
          id: eid,
          type: EntityType.Player,
          x: Math.round(Position.x[eid] * 100) / 100,
          y: Math.round(Position.y[eid] * 100) / 100,
          angle: Math.round(Rotation.angle[eid] * 1000) / 1000,
          // Higher velocity precision (4 decimals) to prevent prediction drift
          // during reconciliation. 2 decimals caused ~0.002 vel error per tick.
          vx: Math.round(Velocity.x[eid] * 10000) / 10000,
          vy: Math.round(Velocity.y[eid] * 10000) / 10000,
          hp: Math.round(Health.current[eid]),
          maxHp: Math.round(Health.max[eid]),
          shield: hasComponent(this.world, Shield, eid) ? Math.round(Shield.current[eid]) : 0,
          maxShield: hasComponent(this.world, Shield, eid) ? Math.round(Shield.max[eid]) : 0,
          name: playerName,
          // Pack cursor aim + laser active flags + boost fuel into data array.
          // data[0]: cursor/weapon state (see CURSOR_STATE.md)
          // data[1]: boost fuel (for reconciliation - needed every snapshot, not just playerState)
          data: [
            packCursorWeaponState(
              Input.targetAngle[eid],
              0, // hitFraction field unused — client does local hitscan
              WeaponState.leftLaserActive[eid] === 1,
              WeaponState.rightLaserActive[eid] === 1,
            ),
            Math.round(Boost.fuel[eid] * 10) / 10, // 1 decimal precision for boost fuel
          ],
        });
      }
      
      // Enemies
      for (const eid of enemyQuery(this.world)) {
        if (InSystem.systemId[eid] !== playerSystemId) continue;
        
        markIfChanged({
          id: eid,
          type: EntityType.Enemy,
          x: Math.round(Position.x[eid] * 100) / 100,
          y: Math.round(Position.y[eid] * 100) / 100,
          vx: Math.round(Velocity.x[eid] * 100) / 100,
          vy: Math.round(Velocity.y[eid] * 100) / 100,
          hp: Math.round(Health.current[eid]),
          maxHp: Math.round(Health.max[eid]),
        });
      }
      
      // Projectiles
      for (const eid of projectileQuery(this.world)) {
        if (InSystem.systemId[eid] !== playerSystemId) continue;
        
        // Calculate hue from owner ID (deterministic player color)
        const ownerId = Projectile.ownerId[eid];
        const ownerHue = (ownerId * 137) % 360; // Golden angle hash for unique colors
        
        // data: [weaponType, tier, hue, spawnTick, spawnX, spawnY]
        markIfChanged({
          id: eid,
          type: EntityType.Projectile,
          x: Math.round(Position.x[eid] * 100) / 100,
          y: Math.round(Position.y[eid] * 100) / 100,
          vx: Math.round(Velocity.x[eid] * 100) / 100,
          vy: Math.round(Velocity.y[eid] * 100) / 100,
          data: [
            Projectile.weaponType[eid], 
            Projectile.tier[eid], 
            ownerHue,
            Projectile.spawnTick[eid],
            Math.round(Projectile.spawnX[eid]),
            Math.round(Projectile.spawnY[eid])
          ],
        });
      }
      
      // Dropped items (nearby only)
      for (const eid of droppedItemQuery(this.world)) {
        if (InSystem.systemId[eid] !== playerSystemId) continue;
        
        const dx = Position.x[eid] - Position.x[conn.playerId];
        const dy = Position.y[eid] - Position.y[conn.playerId];
        const dist = Math.sqrt(dx * dx + dy * dy);
        
        if (dist < 3000) {
          markIfChanged({
            id: eid,
            type: EntityType.DroppedItem,
            x: Math.round(Position.x[eid]),
            y: Math.round(Position.y[eid]),
            data: [DroppedItem.itemId[eid], DroppedItem.stackCount[eid]],
          });
        }
      }
      
      // Asteroids — sent once per system via deterministic seed message
      if (conn.lastSystemId !== playerSystemId) {
        conn.lastSystemId = playerSystemId;
        conn.knownEntities.clear();

        const systemData = this.gameData.getSystemByNum(playerSystemId);
        const belt = systemData?.asteroidBelt;
        const idsAll = this.asteroidIdsBySystem.get(playerSystemId) || [];
        const ids = idsAll.filter(eid => !hasComponent(this.world, Dead, eid));
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
            },
            asteroidField: systemData?.asteroidField,
            ids,
            indices,
          } as ServerAsteroidSeedMessage);
        }
      }
      
      // Stations — sent once per system (they never move)
      for (const eid of stationQuery(this.world)) {
        if (InSystem.systemId[eid] !== playerSystemId) continue;
        if (conn.knownEntities.has(eid)) continue;
        conn.knownEntities.add(eid);
        const stationData =
          Station.orbitType[eid] === 255
            ? [Station.stationId[eid]]
            : [
              Station.stationId[eid],
              Station.orbitType[eid],
              Station.semiMajorAxis[eid],
              Station.eccentricity[eid],
              Station.argPeriapsis[eid],
              Station.meanAnomaly0[eid],
              Station.epochTick[eid],
            ];
        markIfChanged({
          id: eid,
          type: EntityType.Station,
          x: Math.round(Position.x[eid]),
          y: Math.round(Position.y[eid]),
          data: stationData,
        });
      }
      
      // Portals — sent once per system (they never move)
      for (const eid of portalQuery(this.world)) {
        if (InSystem.systemId[eid] !== playerSystemId) continue;
        if (conn.knownEntities.has(eid)) continue;
        conn.knownEntities.add(eid);
        
        markIfChanged({
          id: eid,
          type: EntityType.Portal,
          x: Math.round(Position.x[eid]),
          y: Math.round(Position.y[eid]),
          data: [Portal.targetSystem[eid]],
        });
      }
      
      // NPCs — sent once when nearby (they don't move)
      for (const eid of npcQuery(this.world)) {
        if (InSystem.systemId[eid] !== playerSystemId) continue;
        if (conn.knownEntities.has(eid)) continue;
        
        const dx = Position.x[eid] - Position.x[conn.playerId];
        const dy = Position.y[eid] - Position.y[conn.playerId];
        const dist = Math.sqrt(dx * dx + dy * dy);
        
        if (dist < 10000) {
          conn.knownEntities.add(eid);
          markIfChanged({
            id: eid,
            type: EntityType.NPC,
            x: Math.round(Position.x[eid]),
            y: Math.round(Position.y[eid]),
          });
        }
      }

      const onlySelfUpdate =
        entities.length === 1 &&
        entities[0].id === conn.playerId &&
        removed.length === 0;

      // Throttle self-only movement updates to reduce bandwidth (10 Hz)
      if (onlySelfUpdate && !conn.forceSnapshot) {
        const minIntervalTicks = Math.floor(TICK_RATE / 10);
        if (this.currentTick - conn.lastSnapshotSentTick < minIntervalTicks) {
          this.lastEntityStates.set(conn.playerId, newStates);
          continue;
        }
      }

      const shouldSend = conn.forceSnapshot || entities.length > 0 || removed.length > 0;
      if (!shouldSend) {
        this.lastEntityStates.set(conn.playerId, newStates);
        continue;
      }
      
      this.send(conn.ws, {
        type: 'snapshot',
        tick: this.currentTick,
        serverTime: Date.now(),
        lastProcessedInput: conn.lastInputSeq,
        entities,
        removed,
      });

      conn.forceSnapshot = false;
      conn.lastSnapshotSentTick = this.currentTick;
      this.lastEntityStates.set(conn.playerId, newStates);
      
      // Send player state periodically for HUD updates (every 3rd snapshot = ~7/sec)
      if (this.currentTick % 60 === 0) {
        this.sendPlayerState(conn);
      }
    }
    
    // Clear pending removed entities after sending to all clients
    // Also remove from knownEntities so they can be re-sent if respawned
    for (const eid of this.pendingRemovedEntities) {
      for (const conn of this.clients.values()) {
        conn.knownEntities.delete(eid);
      }
    }
    this.pendingRemovedEntities.clear();
  }

  private sendPlayerState(conn: ClientConnection): void {
    const eid = conn.playerId;
    if (!hasComponent(this.world, Player, eid)) return;
    
    const systemData = this.gameData.getSystemByNum(InSystem.systemId[eid]);
    
    this.send(conn.ws, {
      type: 'playerState',
      hp: Math.round(Health.current[eid]),
      maxHp: Math.round(Health.max[eid]),
      shield: hasComponent(this.world, Shield, eid) ? Math.round(Shield.current[eid]) : 0,
      maxShield: hasComponent(this.world, Shield, eid) ? Math.round(Shield.max[eid]) : 0,
      boostFuel: Math.round(Boost.fuel[eid] * 10) / 10,
      maxBoostFuel: Math.round(Boost.maxFuel[eid] * 10) / 10,
      xp: Player.xp[eid],
      level: Player.level[eid],
      credits: Player.credits[eid],
      systemId: systemData?.id || 'sol',
    });
  }

  private sendInventory(conn: ClientConnection): void {
    const eid = conn.playerId;
    if (!hasComponent(this.world, Player, eid)) return;
    
    // Build inventory slots array
    const slots: { itemId: string | null; count: number }[] = [];
    for (let i = 0; i < 10; i++) {
      const slotKey = `slot${i}` as keyof typeof Inventory;
      const countKey = `count${i}` as keyof typeof Inventory;
      const itemNum = (Inventory as any)[slotKey][eid];
      const count = (Inventory as any)[countKey][eid];
      
      if (itemNum > 0) {
        const itemData = this.gameData.getItemByNum(itemNum);
        slots.push({
          itemId: itemData?.id || `item_${itemNum}`,
          count: count || 1,
        });
      } else {
        slots.push({ itemId: null, count: 0 });
      }
    }
    
    this.send(conn.ws, {
      type: 'inventory',
      slots,
      equipment: {
        leftWeapon: this.gameData.getItemByNum(Equipment.leftWeapon[eid])?.id || null,
        rightWeapon: this.gameData.getItemByNum(Equipment.rightWeapon[eid])?.id || null,
        booster: this.gameData.getItemByNum(Equipment.booster[eid])?.id || null,
        cockpit: this.gameData.getItemByNum(Equipment.cockpit[eid])?.id || null,
      },
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
          
        case 'spawnEnemy':
          // Spawn enemy at position
          this.adminSpawnEnemy(data.type, data.x, data.y, data.systemId);
          break;
          
        case 'teleportPlayer':
          // Teleport a player
          this.adminTeleportPlayer(data.playerId, data.x, data.y, data.systemId);
          break;
      }
    });
  }
  
  private adminKillAllEnemies(systemId?: string): void {
    let killed = 0;
    for (const eid of enemyQuery(this.world)) {
      if (systemId) {
        const systemNum = this.gameData.getSystemNum(systemId);
        if (InSystem.systemId[eid] !== systemNum) continue;
      }
      addComponent(this.world, Dead, eid);
      killed++;
    }
    console.log(`🔧 Admin: Killed ${killed} enemies`);
  }
  
  private adminSpawnEnemy(type: string, x: number, y: number, systemId: string): void {
    const enemyData = this.gameData.getEnemy(type);
    if (!enemyData) {
      console.log(`🔧 Admin: Unknown enemy type "${type}"`);
      return;
    }
    
    const systemNum = this.gameData.getSystemNum(systemId);
    // Could call createEnemy here if we expose it
    console.log(`🔧 Admin: Would spawn ${type} at (${x}, ${y}) in ${systemId}`);
  }
  
  private adminTeleportPlayer(playerId: number, x: number, y: number, systemId?: string): void {
    if (!hasComponent(this.world, Player, playerId)) {
      console.log(`🔧 Admin: Player ${playerId} not found`);
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
  private handleAuthRequest(req: http.IncomingMessage, res: http.ServerResponse, action: string): void {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        res.setHeader('Content-Type', 'application/json');

        if (action === 'register') {
          const result = this.userDB.register(data.username, data.email, data.password);
          if (result.success) {
            res.writeHead(200);
            res.end(JSON.stringify({ success: true, username: result.user.username, token: result.token, isAdmin: result.user.is_admin }));
          } else {
            res.writeHead(400);
            res.end(JSON.stringify({ success: false, error: result.error }));
          }
        } else if (action === 'login') {
          const result = this.userDB.login(data.username, data.password);
          if (result.success) {
            res.writeHead(200);
            res.end(JSON.stringify({ success: true, username: result.user.username, token: result.token, isAdmin: result.user.is_admin }));
          } else {
            res.writeHead(400);
            res.end(JSON.stringify({ success: false, error: result.error }));
          }
        } else if (action === 'validate') {
          const user = this.userDB.validateSession(data.token);
          if (user) {
            res.writeHead(200);
            res.end(JSON.stringify({ success: true, username: user.username, isAdmin: user.is_admin }));
          } else {
            res.writeHead(401);
            res.end(JSON.stringify({ success: false, error: 'Invalid or expired session' }));
          }
        }
      } catch (e) {
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
    
    if (!this.adminServer) return;
    
    // Count entities
    let entityCount = 0;
    entityCount += playerQuery(this.world).length;
    entityCount += projectileQuery(this.world).length;
    entityCount += enemyQuery(this.world).length;
    entityCount += asteroidQuery(this.world).length;
    
    this.adminServer.updateStats({
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
      const mem = process.memoryUsage();
      
      const playerList: { id: number; name: string; ping: number; system: string }[] = [];
      for (const c of this.clients.values()) {
        const sysNum = hasComponent(this.world, Player, c.playerId) ? InSystem.systemId[c.playerId] : 0;
        const sysData = this.gameData.getSystemByNum(sysNum);
        playerList.push({
          id: c.playerId,
          name: c.username,
          ping: c.ping,
          system: sysData?.id || 'unknown',
        });
      }
      
      const adminStatsMsg = {
        type: 'adminStats' as const,
        tick: this.currentTick,
        playerCount: this.clients.size,
        entityCount,
        tickTimeMs: tickTime,
        avgTickTimeMs: Math.round(avgTickTime * 100) / 100,
        maxTickTimeMs: Math.round(maxTickTime * 100) / 100,
        memoryMb: Math.round(mem.heapUsed / 1024 / 1024 * 10) / 10,
        uptime: process.uptime(),
        snapshotBytes: this.snapshotBytesSent,
        bytesByType: { ...this.bytesByType },
        connectionsTotal: this.totalConnectionsEver,
        errors: this.recentErrors.slice(-10),
        playerList,
      };
      
      // Send to all admin clients
      for (const c of this.clients.values()) {
        if (c.isAdmin && c.ws.readyState === WebSocket.OPEN) {
          this.send(c.ws, adminStatsMsg as any);
        }
      }
      
      // Reset byte counters
      this.snapshotBytesSent = 0;
      this.bytesByType = {};
    }
  }
  
  /**
   * Get current player count (for server browser registration)
   */
  getPlayerCount(): number {
    return this.clients.size;
  }
}
