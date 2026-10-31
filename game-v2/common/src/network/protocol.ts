import type { EconClientMessage, EconServerMessage } from './econProtocol.js';
import type { SocialClientMessage, SocialServerMessage } from './socialProtocol.js';
import type { ClientContribMessage, ContribServerMessage } from './contributorProtocol.js';
export * from './econProtocol.js';
export * from './socialProtocol.js';
export * from './contributorProtocol.js';
export * from './replication.js';
export * from './binaryCodec.js';
import { encodeBinary, BinaryReader, BinaryWriter, DICTIONARY } from './binaryCodec.js';
import { quantizeCursorAngle, dequantizeCursorAngle } from './cursorState.js';
/**
 * Network Protocol - All client/server message types
 */

import type { Blueprint } from '../ships/types.js';
import { patrolFrom, type Leg, type Patrol, type PatrolState } from '../ships/farRoute.js';
import type { AsteroidBeltData, LodestoneData } from '../data/schemas.js';

/**
 * The wire format's version. The client sends it in `join` and the server
 * echoes its own in `welcome`; on a mismatch the server closes the socket with
 * PROTOCOL_MISMATCH_CLOSE and the client asks the player to reload (a cached
 * old client would otherwise mis-decode every compact row, silently).
 *
 * Bump it whenever COMPACT, SNAP_FIELDS, DICTIONARY (binaryCodec.ts' head and
 * wire-dictionary.json), the binary input layout or the snapshot packing
 * changes; protocol.test.ts hashes those and fails until `npm run wire:bump`
 * has updated PROTOCOL_VERSION and PROTOCOL_WIRE_HASH.
 */
// History: PROTOCOL_CHANGELOG.md. Re-pin with `npm run wire:bump "reason"` (game-v2/), never by hand.
export const PROTOCOL_VERSION = 18;
/** The hash of the wire tables PROTOCOL_VERSION was recorded for (see protocol.test.ts) */
export const PROTOCOL_WIRE_HASH = '6c1c0c52';
/** WebSocket close code (and reason) for a client on another protocol version */
export const PROTOCOL_MISMATCH_CLOSE = 4002;
export const PROTOCOL_MISMATCH_REASON = 'version';

// ============================================
// CLIENT -> SERVER MESSAGES
// ============================================

export interface ClientInputMessage {
  type: 'input';
  seq: number;
  tick: number;
  targetTick?: number; // Server tick when this input should be applied (input-delay buffer)
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
  boost: boolean;
  fireLeft: boolean;
  fireRight: boolean;
  targetAngle: number;
  /** Modular ships, helm controls: strafe relative to the ship (Q/E) */
  strafeLeft?: boolean;
  strafeRight?: boolean;
  /** Modular ships: helm controls (left/right turn the ship) instead of mouse-steer */
  helm?: boolean;
  /** Distance from the ship to the cursor, world units (turrets converge on the cursor point) */
  cursorDist?: number;
  /** Jump drive: true while spooling up (the client latches it from a J press) */
  jump?: boolean;
  /** Burst Strafer: held to dodge, the way the movement keys ask (ships/features/strafer) */
  dodge?: boolean;
}

/** Cursor distance is sent in steps of this many world units, up to CURSOR_DIST_MAX */
export const CURSOR_DIST_STEP = 4;
export const CURSOR_DIST_MAX = 200000; // far enough to aim a jump (16 bits at 4-unit steps)

export function quantizeCursorDist(d: number): number {
  return Math.round(Math.max(0, Math.min(CURSOR_DIST_MAX, d)) / CURSOR_DIST_STEP);
}

export interface ClientPingMessage {
  type: 'ping';
  clientTime: number;
}

/** The system map opened or closed: while it's open the server sends the system's far ships (mapDots) */
export interface ClientMapViewMessage {
  type: 'mapView';
  open: boolean;
}

export interface ClientChatMessage {
  type: 'chat';
  text: string;
}

export interface ClientInteractMessage {
  type: 'interact';
  targetId?: number;  // Entity ID of NPC/station (optional - server finds nearest)
}

export interface ClientDropItemMessage {
  type: 'dropItem';
  inventorySlot: number;
  count: number;
}

export interface ClientPickupMessage {
  type: 'pickup';
  itemEntityId: number;
}

export interface ClientBuyMessage {
  type: 'buy';
  stationId: string;
  itemId: string;
  count: number;
}

export interface ClientSellMessage {
  type: 'sell';
  stationId: string;
  inventorySlot: number;
  count: number;
}

export interface ClientRepairMessage {
  type: 'repair';
  stationId: string;
}

export interface ClientRefuelMessage {
  type: 'refuel';
  stationId: string;
}

export interface ClientBankDepositMessage {
  type: 'bankDeposit';
  inventorySlot: number;
  count: number;
}

export interface ClientBankWithdrawMessage {
  type: 'bankWithdraw';
  bankSlot: number;
  count: number;
}

export interface ClientWarpMessage {
  type: 'warp';
  portalId: string;
}

export interface ClientRespawnMessage {
  type: 'respawn';
  /** Rally beside this party member instead of at home */
  rally?: string;
}

/** The tutorial's combat lesson: a training drone in front of you (inner Sol only, one at a time) */
export interface ClientTrainingDroneMessage {
  type: 'trainingDrone';
}

export interface ClientJoinMessage {
  type: 'join';
  token?: string;      // Auth session token (for registered users)
  username: string;    // Display name (for guests)
  /** The client's PROTOCOL_VERSION (absent: a client from before the handshake) */
  protocol?: number;
}

export interface ClientAuthLoginMessage {
  type: 'authLogin';
  username: string;
  password: string;
}

export interface ClientAuthRegisterMessage {
  type: 'authRegister';
  username: string;
  email: string;
  password: string;
}

export interface ClientStateHashMessage {
  type: 'stateHash';
  tick: number;
  hash: number;
}

export type ClientMessage =
  | ClientInputMessage
  | ClientTrainingDroneMessage
  | ClientShipNeedMessage
  | ClientPingMessage
  | ClientMapViewMessage
  | ClientChatMessage
  | ClientInteractMessage
| ClientDropItemMessage
  | ClientPickupMessage
  | ClientBuyMessage
  | ClientSellMessage
  | ClientRepairMessage
  | ClientRefuelMessage
  | ClientBankDepositMessage
  | ClientBankWithdrawMessage
  | ClientWarpMessage
  | ClientRespawnMessage
  | ClientJoinMessage
  | ClientAuthLoginMessage
  | ClientAuthRegisterMessage
  | ClientStateHashMessage
  | ClientShipEditMessage
  | ClientDockMessage
  | ClientUndockMessage
  | ClientTowMessage
  | ClientDevTeleportMessage
  | ClientDevSpawnMessage
  | ClientDevShipMessage
  | ClientDevBossMessage
  | ClientAdminMessage
  | ClientSiegeMessage
  | EconClientMessage
  | SocialClientMessage
  | ClientContribMessage;

/**
 * Dev tool (map click): jump to a system, optionally to a spot in it. Only
 * honoured on dev/proto servers or for admins.
 */
export interface ClientDevTeleportMessage {
  type: 'devTeleport';
  systemId: string;
  x?: number;
  y?: number;
}

/** Dev tool: a hostile pack of the system's own (or `ships` of `faction`) at a spot. Dev servers or admins only. */
export interface ClientDevSpawnMessage {
  type: 'devSpawn';
  x: number;
  y: number;
  faction?: string;
  ships?: string[];
}

/**
 * Dev tool: fly a ship from the plan library (data/ships/blueprints) right now, wherever you are, nothing
 * spent; without `ship`, your own ship back. It's never saved. Dev servers or admins only.
 */
export interface ClientDevShipMessage {
  type: 'devShip';
  ship?: string;
}

/**
 * Dev tool: the nearest boss in your system worn down to `wear` of its hull (into its later phases), or
 * with `reset`, taken away to come back fresh. Dev servers or admins only.
 */
export interface ClientDevBossMessage {
  type: 'devBoss';
  wear?: number;
  reset?: boolean;
  /** Its first this many shedding steps done at once (a boss that sheds: its stages, to look at) */
  shed?: number;
}

/** A moon siege's day: ready up (or not), refit, or buy from the shop */
export interface ClientSiegeMessage {
  type: 'siege';
  action: 'ready' | 'unready' | 'refit' | 'buy' | 'upgrade' | 'scrap' | 'claim';
  item?: string;
  /** The turret pad, for upgrade and scrap */
  pad?: number;
}

/** An admin command (server/src/game/AdminTools.ts lists them); refused for non-admins */
export interface ClientAdminMessage {
  type: 'admin';
  cmd: string;
  args?: Record<string, unknown>;
}

/** Hangar opening: berth at the station in range (the ship rides along with it until undock) */
export interface ClientDockMessage {
  type: 'dock';
}

export interface ClientUndockMessage {
  type: 'undock';
}

/**
 * Tow Beam (common/src/ships/features/tow/tow.ts): `on` takes hold of the wreck, debris or pod nearest the cursor within reach
 * (the input's aim and cursor distance say where), off lets go. The server answers with a toast and the snapshot
 */
export interface ClientTowMessage {
  type: 'tow';
  on: boolean;
}

/** Hangar: replace my ship with this blueprint (validated by the server; must be docked) */
export interface ClientShipEditMessage {
  type: 'shipEdit';
  blueprint: Blueprint;
}

// ============================================
// SERVER -> CLIENT MESSAGES
// ============================================

export interface ServerWelcomeMessage {
  type: 'welcome';
  playerId: number;       // Entity ID
  tickRate: number;
  serverTime: number;
  /** The server's PROTOCOL_VERSION */
  protocol?: number;
  /** Per system id: the rating of what its hostiles send (ships/rating.ts); siege moons: their first nights */
  threats?: Record<string, number>;
  /** Systems with danger bands (Sol): the threat in each (system id -> region id -> rating) */
  regionThreats?: Record<string, Record<string, number>>;
}

export interface ServerPongMessage {
  type: 'pong';
  clientTime: number;
  serverTime: number;
  tick: number;
  serverProcessing?: number;  // ms the pong was delayed by server-side processing
}

/** Compact entity state for network sync */
export interface EntityState {
  id: number;             // Entity ID
  type: EntityType;
  x: number;
  y: number;
  angle?: number;
  vx?: number;
  vy?: number;
  hp?: number;
  maxHp?: number;
// Type-specific data encoded as needed
  data?: number[];
  // Player display name (only for Player entities)
  name?: string;
  /** Modular ships: angular velocity (rad/tick), for prediction */
  av?: number;
}

export enum EntityType {
  Player = 1,
  Enemy = 2,
  NPC = 3,
  Asteroid = 4,
  Station = 5,
  Portal = 6,
  Projectile = 7,
  DroppedItem = 8,
  Mine = 9,
  /** Modular ship body without a pilot: dummies and debris */
  ShipBody = 10,
}

export interface ServerSnapshotMessage {
  type: 'snapshot';
  tick: number;
  /** (Not sent on the wire: clients time snapshots by tick) */
  serverTime?: number;
  lastProcessedInput: number;  // Client input seq
  entities: EntityState[];
  // Removed entities this tick
  removed: number[];
  /** Ship keyframes (see replication.ts): only where a client is new to a ship or out of step */
  ships?: number[][];
  /** Ship control changes since the last snapshot */
  ctl?: number[][];
  /**
   * Ships that went out of this client's view: it forgets them (but keeps their
   * structure). Coming back into view, a ship is sent again on its own.
   */
  out?: number[];
  /**
   * Shots from ships this client replicates, for it to build the shells itself
   * (common/src/ships/launch.ts): [owner, ticksAgo, part, aimQ, ...shell ids]
   */
  fire?: number[][];
}

export interface ServerPlayerStateMessage {
  type: 'playerState';
  hp: number;
  maxHp: number;
boostFuel: number;
  maxBoostFuel: number;
  xp: number;
  level: number;
  credits: number;
  systemId: string;
}

export interface InventorySlot {
  itemId: string | null;
  count: number;
}

export interface ServerInventoryMessage {
  type: 'inventory';
  slots: InventorySlot[];
}

export interface ServerBankMessage {
  type: 'bank';
  slots: InventorySlot[];
}

export interface ServerChatMessage {
  type: 'chat';
  playerId: number;
  playerName: string;
  text: string;
  timestamp: number;
}

export interface ServerSystemMessage {
  type: 'systemMessage';
  text: string;
  color?: string;
}

/**
 * Data-driven system info pushed to the client when entering a system.
 * Drives the renderer's central body and background visuals.
 */
export interface ServerSystemInfoMessage {
  type: 'systemInfo';
  systemId: string;
  name: string;
  sector?: string;
  /** Central body config (defaults to sun) */
  centralBody: {
    type: 'sun' | 'binary' | 'black_hole' | 'pulsar' | 'brown_dwarf' | 'none';
    radius?: number;
    hue?: number;
    sunStyle?: string;
    coronaStyle?: string;
    sunStyleParams?: Record<string, number>;
    coronaStyleParams?: Record<string, number>;
    companionOffsetX?: number;
    companionOffsetY?: number;
    companionHue?: number;
    companionRadius?: number;
    diskHue?: number;
    beamHue?: number;
    /** Gravity well (black holes); client prediction applies the same pull */
    gravity?: { strength: number; minRadius: number; horizon?: number };
  };
  /** Hazards in this system: 'cold' | 'radiation' | 'low_visibility' | 'darkness' | 'gravitational_anomalies' */
  hazards?: string[];
  /** Hazard ratings 0-5 (ships/hazards.ts), and the star's or black hole's radius they rise within */
  hazardRatings?: Record<string, number>;
  hazardRadius?: number;
  /** Ancient lodestones (their fields charge the jump drive: ships/jumpFields.ts) */
  lodestones?: LodestoneData[];
  /** Background visuals */
  visuals: {
    starHueShift?: number;
    specialStarChance?: number;
    specialStarHue?: number;
    hasNebula?: boolean;
    nebulaHue?: number;
  };
}

export interface ServerDialogueMessage {
  type: 'dialogue';
  npcId: string;
  npcName: string;
  text: string;
  options?: DialogueOption[];
}

export interface DialogueOption {
  text: string;
  action: string;
  data?: any;
}

export interface ServerShopMessage {
  type: 'shop';
  stationId: string;
  stationName: string;
  items: ShopItemInfo[];
  buyMultiplier: number;
  sellMultiplier: number;
}

export interface ShopItemInfo {
  itemId: string;
  name: string;
  price: number;
  stock: number;  // -1 = unlimited
}

export interface ServerDamageMessage {
  type: 'damage';
  targetId: number;
  amount: number;
  sourceId?: number;
  critical?: boolean;
  hp?: number;      // remaining HP after damage (sent for asteroids)
  maxHp?: number;   // max HP (sent for asteroids)
  /** The hit barely got through the armour it struck (a gun too weak for it) */
  glancing?: boolean;
}

export interface ServerDeathMessage {
  type: 'death';
  entityId: number;
  entityType: EntityType;
  killerId?: number;
}

export interface ServerLevelUpMessage {
  type: 'levelUp';
  playerId: number;
  newLevel: number;
}

export interface ServerLootMessage {
  type: 'loot';
  itemId: string;
  itemName: string;
  count: number;
}

export interface ServerEffectMessage {
  type: 'effect';
  effectType: EffectType;
  x: number;
  y: number;
  targetX?: number;
  targetY?: number;
  entityId?: number;
  data?: number[];
}

export enum EffectType {
  Explosion = 1,
  LaserHit = 2,
  MissileTrail = 3,
  WarpIn = 4,
  WarpOut = 5,
  LevelUp = 6,
  Heal = 7,
  PickupItem = 8,
  MineArm = 9,
  AsteroidBreak = 10,
  MuzzleFlash = 11,
  /** A Flash Screen came back (entityId: the ship): a white bloom round it */
  ShieldFlash = 12,
}

export interface ServerAuthResultMessage {
  type: 'authResult';
  success: boolean;
  username?: string;
  token?: string;
  isAdmin?: boolean;
  /** Contributor rank (admins are contributors too): the contributor tools */
  isContributor?: boolean;
  error?: string;
}

export interface ServerAdminStatsMessage {
  type: 'adminStats';
  tick: number;
  playerCount: number;
  entityCount: number;
  tickTimeMs: number;
  avgTickTimeMs: number;
  maxTickTimeMs: number;
  memoryMb: number;
  uptime: number;
  snapshotBytes: number;
  connectionsTotal: number;
  errors: string[];       // recent server errors
  bytesByType?: Record<string, number>;
  playerList: AdminPlayerInfo[];
}

/** A player as the admin panel sees them */
export interface AdminPlayerInfo {
  id: number; name: string; ping: number; admin: boolean;
  system: string; x: number; y: number; dead: boolean;
  god: boolean; hidden: boolean;
  /** Has the contributor rank (admins have it anyway) */
  contributor?: boolean;
  /** Free build is on for them (dev servers only) */
  freeBuild?: boolean;
}

/** An admin command's answer */
export interface ServerAdminResultMessage {
  type: 'adminResult';
  ok: boolean;
  text: string;
}

/** A player the admin panel can manage, online or not (the `players` command) */
export interface AdminAccountInfo {
  name: string;
  /** Online: their entity id (null: offline) */
  online: number | null;
  /** Signed in to an account (guests aren't: no rank or ban for them) */
  account: boolean;
  rank: 'player' | 'contributor' | 'admin';
  /** Banned: until when (epoch ms; null: for good), why, by whom */
  ban: { until: number | null; reason: string; by: string } | null;
}

/** The answer to the `players` admin command: online players first, then accounts */
export interface ServerAdminAccountsMessage {
  type: 'adminAccounts';
  search: string;
  players: AdminAccountInfo[];
  /** Accounts matching the search */
  total: number;
  /** More match than were sent (the search wants more of the name) */
  more: boolean;
  /** Why the accounts aren't listed (no lobby here, or it's unreachable): online players only */
  error?: string;
}

/** The lists the admin panel picks from */
export interface ServerAdminInfoMessage {
  type: 'adminInfo';
  systems: { id: string; name: string }[];
  stations: { id: string; name: string; system: string; x: number; y: number }[];
  factions: Record<string, string[]>;
  bosses: string[];
  items: { id: string; name: string }[];
  /** This server lets admins switch on free build (dev servers only: never in production) */
  freeBuild?: boolean;
}

export interface ServerErrorMessage {
  type: 'error';
  code: string;
  message: string;
}

export interface ServerWarpMessage {
  type: 'warp';
  systemId: string;
  x: number;
  y: number;
}

/** One-time asteroid spawn data — client calculates positions locally */
export interface ServerAsteroidSpawnMessage {
  type: 'asteroidSpawn';
  tick: number;           // server tick when orbitAngle values are valid
  asteroids: AsteroidSpawnData[];
}

/** Deterministic asteroid seed message (client derives params locally) */
export interface ServerAsteroidSeedMessage {
  type: 'asteroidSeed';
  tick: number;           // server tick when seed is valid
  systemId: string;       // system id string (e.g. 'sol')
  seed: string;           // global seed string
  belt: AsteroidBeltData;
  asteroidField?: string; // optional field ID for definition-based generation
  ids: number[];          // asteroid entity ids in this system
  indices: number[];      // original deterministic indices for ids
}

export interface AsteroidSpawnData {
  id: number;
  size: number;
  resourceType: number;
  orbitType: number;
  semiMajorAxis: number;
  eccentricity: number;
  argPeriapsis: number;
  meanAnomaly0: number;
  epochTick: number;
  wobblePhase: number;
  hp: number;
  maxHp: number;
  /** An outlier's stage (0: whole); absent for an ordinary rock */
  stage?: number;
  /** Respawned asteroids: belt index, type and system (the client derives its composition from these) */
  index?: number;
  definitionId?: string;
  systemId?: string;
}

/** Debug message: server sends nearby asteroid positions for visualization. */
export interface ServerAsteroidDebugMessage {
  type: 'asteroidDebug';
  tick: number;
  durationMs: number;
  points: { id: number; x: number; y: number }[];
}

export type ServerMessage =
  | ServerWelcomeMessage
  | ServerPongMessage
  | ServerSnapshotMessage
  | ServerPlayerStateMessage
  | ServerSystemInfoMessage
  | ServerInventoryMessage
  | ServerBankMessage
  | ServerChatMessage
  | ServerSystemMessage
  | ServerDialogueMessage
  | ServerShopMessage
  | ServerDamageMessage
  | ServerDeathMessage
  | ServerLevelUpMessage
  | ServerLootMessage
  | ServerEffectMessage
  | ServerErrorMessage
  | ServerWarpMessage
  | ServerAsteroidSpawnMessage
  | ServerAsteroidSeedMessage
  | ServerAsteroidDebugMessage
  | ServerAuthResultMessage
  | ServerAdminStatsMessage
  | ServerAdminResultMessage
  | ServerAdminInfoMessage
  | ServerAdminAccountsMessage
  | ServerShipSyncMessage
  | ServerShipHpMessage
  | ServerShipHpBatchMessage
  | ServerShipEditResultMessage
  | ServerProjectileHitMessage
  | ServerDockResultMessage
  | ServerPartDestroyedMessage
  | ServerContactMessage
  | ServerDetonationMessage
  | ServerInterceptMessage
  | ServerStationFireMessage
  | ServerMapDotsMessage
  | ServerIgniteMessage
  | ServerBossIntroMessage
  | ServerBossChargeMessage
  | ServerBossTelegraphMessage
  | ServerBossBeamMessage
  | ServerBossBlowMessage
  | ServerBossPhaseMessage
  | ServerBossDefeatedMessage
  | ServerWorldEventMessage
  | ServerWorldEventEndMessage
  | ServerObjectiveMessage
  | ServerObjectiveEndMessage
  | ServerSiegeStateMessage
  | EconServerMessage
  | SocialServerMessage
  | ContribServerMessage;

/**
 * The ships of a client's system it doesn't have in view (further than the
 * snapshot's ship view: pilotless ones, distant or live, and other pilots),
 * for the system map: once a second while its map is open (mapView), only
 * what's changed. Each ship's way is a leg in closed form (common
 * ships/farRoute.ts) the client carries it on along exactly as the server
 * reckons it, so a distant ship's dot is sent again only when its route turns,
 * a live one's when it's strayed MAP_DOT_SLACK from where the client has it.
 *   dots   MAP_DOT_STRIDE numbers a ship: [id, x / 10, y / 10, vx × 100, vy × 100,
 *          wx × 100, wy × 100, thrust] (its leg as from `tick`: velocity, the
 *          top speed it's thrusting towards, for `thrust` more ticks, -1 for good)
 *   routes MAP_ROUTE_STRIDE numbers a ship on patrol round a home that stays
 *          put: [id, age, x, y, vx, vy, tx, ty, hx, hy, roam, speed, seed], the
 *          leg it's on (from where it was `age` ticks before `tick`, for (tx, ty))
 *          and its patrol (common ships/farRoute.ts Patrol, with its dice), all
 *          as the server has them: the map works out every leg after as the
 *          server does, so it's told a patrol once
 *   info   MAP_INFO_STRIDE numbers a ship that's new or looks different:
 *          [id, flags, rating]; flags = kind (1 derelict, 2 traffic, 3 hostile,
 *          4 pilot) | rank (1 elite, 2 boss) << 3 | calm << 5 | (faction index + 1) << 6
 *   gone   ships no longer on it
 *   names  [id, name, ...] for the ones it hasn't been told the name of
 *   full   a fresh list (just opened, or another system): anything not in it is gone
 */
export interface ServerMapDotsMessage {
  type: 'mapDots';
  tick: number;
  dots: number[];
  routes?: number[];
  info?: number[];
  gone?: number[];
  names?: (number | string)[];
  full?: 1;
}
export const MAP_DOT_STRIDE = 8;
export const MAP_ROUTE_STRIDE = 13;
export const MAP_INFO_STRIDE = 3;
/** How far a live ship's dot may stray from where the client carries it before it's sent again (world units) */
export const MAP_DOT_SLACK = 250;

/** What a map dot is (MAP_INFO rows, decoded) */
export interface MapDot { id: number; kind: number; rank: number; calm: boolean; faction: number; rating: number }

/** A ship's leg as the map is sent it (rounded: what the client will have) */
export function packMapLeg(out: number[], id: number, l: Leg): void {
  out.push(id, Math.round(l.x / 10), Math.round(l.y / 10), Math.round(l.vx * 100), Math.round(l.vy * 100),
    Math.round(l.wx * 100), Math.round(l.wy * 100), l.thrust < 0 ? -1 : Math.round(l.thrust));
}

export function unpackMapLegs(dots: number[]): { id: number; leg: Leg }[] {
  const out: { id: number; leg: Leg }[] = [];
  for (let i = 0; i + MAP_DOT_STRIDE <= dots.length; i += MAP_DOT_STRIDE) {
    out.push({ id: dots[i], leg: { x: dots[i + 1] * 10, y: dots[i + 2] * 10, vx: dots[i + 3] / 100, vy: dots[i + 4] / 100,
      wx: dots[i + 5] / 100, wy: dots[i + 6] / 100, thrust: dots[i + 7] } });
  }
  return out;
}

/** A patrolling ship's route as the map is sent it (`tick`: the message's) */
export function packMapRoute(out: number[], id: number, tick: number, p: Patrol, s: PatrolState): void {
  out.push(id, tick - s.t0, s.from.x, s.from.y, s.from.vx, s.from.vy, s.tx, s.ty, p.hx, p.hy, p.roam, p.speed, s.seed);
}

export function unpackMapRoutes(routes: number[], tick: number): { id: number; patrol: Patrol; state: PatrolState }[] {
  const out: { id: number; patrol: Patrol; state: PatrolState }[] = [];
  for (let i = 0; i + MAP_ROUTE_STRIDE <= routes.length; i += MAP_ROUTE_STRIDE) {
    const r = (k: number) => routes[i + k];
    const patrol: Patrol = { hx: r(8), hy: r(9), roam: r(10), speed: r(11) };
    out.push({ id: r(0), patrol, state: patrolFrom(patrol, tick - r(1), { x: r(2), y: r(3), vx: r(4), vy: r(5) }, r(6), r(7), r(12)) });
  }
  return out;
}

export function mapDotFlags(d: Omit<MapDot, 'id' | 'rating'>): number {
  return (d.kind & 7) | ((d.rank & 3) << 3) | (d.calm ? 32 : 0) | ((d.faction + 1) << 6);
}

export function packMapInfo(out: number[], d: MapDot): void {
  out.push(d.id, mapDotFlags(d), Math.round(d.rating));
}

export function unpackMapInfo(info: number[]): MapDot[] {
  const out: MapDot[] = [];
  for (let i = 0; i + MAP_INFO_STRIDE <= info.length; i += MAP_INFO_STRIDE) {
    const f = info[i + 1];
    out.push({ id: info[i], kind: f & 7, rank: (f >> 3) & 3, calm: (f & 32) !== 0, faction: (f >> 6) - 1, rating: info[i + 2] });
  }
  return out;
}

/** One of a station's defence turrets fired on a hostile ship (for the effect) */
export interface ServerStationFireMessage {
  type: 'stationFire';
  station: number;
  target: number;
  /** Which of its turrets */
  turret?: number;
}

/** A boss is engaged for the first time: title card */
export interface ServerBossIntroMessage {
  type: 'bossIntro';
  bodyId: number;
  name: string;
  title: string;
  text: string;
}

/** A boss is charging a nova (a ring of `kind` shots in `ticks`) */
export interface ServerBossChargeMessage {
  type: 'bossCharge';
  bodyId: number;
  kind: string;
  ticks: number;
}

/**
 * A boss's warning of what's coming, shown for `ticks` and brightening to the
 * moment it lands: a line (a charge's path, a dash, a beam's start) from
 * (x, y) along `angle` for `length`, `width` across; or a circle (where a
 * shell comes down) of `radius` at (x, y). With `bodyId` it rides that body:
 * (x, y) is an offset in its own frame (world units, its nose along +x) and
 * `angle` is from its heading.
 */
export interface ServerBossTelegraphMessage {
  type: 'bossTelegraph';
  shape: 'line' | 'circle';
  x: number;
  y: number;
  angle?: number;
  length?: number;
  width?: number;
  radius?: number;
  ticks: number;
  bodyId?: number;
  /** 'charge' (red: get out of the way), 'lance' (red: a beam gathering), 'dash' (orange: where it's going), 'impact' (shells landing), 'magma' (a ball swelling on a turret: x, y on the body) */
  kind: string;
}

/**
 * A boss's sweeping beam: from (x, y) on the body (its own frame, world units,
 * nose along +x), turning from `a0` to `a1` (radians from its heading) over
 * `ticks`, `length` long and `width` wide
 */
export interface ServerBossBeamMessage {
  type: 'bossBeam';
  bodyId: number;
  x: number;
  y: number;
  a0: number;
  a1: number;
  ticks: number;
  length: number;
  width: number;
  /** 'crystal' (white-hot: the Pyreclast's heart); absent, a molten lance */
  kind?: string;
}

/** A boss blows away what was under one of its parts (`part`: a skeleton's piece under it), one after another between stages */
export interface ServerBossBlowMessage {
  type: 'bossBlow';
  bodyId: number;
  part: number;
}

/** A boss entered a new phase */
export interface ServerBossPhaseMessage {
  type: 'bossPhase';
  bodyId: number;
  phase: number;
  text: string;
}

/** Something is happening in this system (a raid, a wreck): announce it and mark it */
export interface ServerWorldEventMessage {
  type: 'worldEvent';
  id: number;
  kind: 'raid' | 'salvage' | 'warband' | 'peak';
  title: string;
  text: string;
  x: number;
  y: number;
  /** Seconds until it's over at the latest */
  seconds: number;
}

export interface ServerWorldEventEndMessage {
  type: 'worldEventEnd';
  id: number;
}

/** An objective banner for pilots in a system (a planet's siege): replaces any earlier one with the same id */
export interface ServerObjectiveMessage {
  type: 'objective';
  id: string;
  title: string;
  text: string;
  /** A bar under it (pylons standing, the structure's hull) */
  meter?: { label: string; value: number; max: number };
  /** Shown in red: fighting is on */
  danger?: boolean;
  /** Where it's happening (a nav marker) */
  at?: { x: number; y: number };
  /** How dark it is (0 day .. 1 night): a moon siege's nights */
  night?: number;
}

/** A moon siege's day panel (Sieges.ts): supplies, the shop, who's ready */
export interface ServerSiegeStateMessage {
  type: 'siegeState';
  active: boolean;
  title?: string;
  phase?: 'day' | 'dusk' | 'night' | 'lost';
  wave?: number;
  supplies?: number;
  ready?: { name: string; ready: boolean }[];
  youReady?: boolean;
  pads?: { free: number; total: number };
  shop?: { id: string; label: string; cost: number; note: string }[];
  /** What's built on each pad (null: empty), with what upgrading costs (absent: top mark) and what scrapping it gives back */
  turrets?: ({ label: string; mark: number; hull: number; upgrade?: number; refund: number } | null)[];
  /** Your haul so far, paid out when you claim and leave by day (half, with no bonus, if you leave any other way or the bastion falls) */
  haul?: { xp: number; credits: number; nights: number; bonus: number; nextBonusAt: number; nextBonus: number };
  /** This moon's siege, and (by day) the boss tonight brings */
  profile?: { name: string; about: string };
  nextBoss?: string;
}

export interface ServerObjectiveEndMessage {
  type: 'objectiveEnd';
  id: string;
}

/** A boss died */
export interface ServerBossDefeatedMessage {
  type: 'bossDefeated';
  bodyId: number;
  name: string;
  x: number;
  y: number;
}

/** A ship's part caught fire (incendiary hit): flames for `ticks` */
export interface ServerIgniteMessage {
  type: 'ignite';
  bodyId: number;
  part: number;
  ticks: number;
}

/**
 * Point defence (common/src/ships/support.ts) fired: part `part` of ship `bodyId` (its muzzle at fx, fy) hit shot
 * `proj` at (x, y); `down`: that brought it down (it's gone, its warhead never went off). Sent as a plain message (no
 * compact row: the wire tables are unchanged).
 */
export interface ServerInterceptMessage {
  type: 'intercept';
  bodyId: number;
  part: number;
  proj: number;
  x: number;
  y: number;
  fx: number;
  fy: number;
  down: boolean;
}

/** A warhead went off (flak burst, missile, EMP): for effects */
export interface ServerDetonationMessage {
  type: 'detonation';
  kind: string;
  x: number;
  y: number;
  radius: number;
  /** Lightning: where it leapt from */
  from?: [number, number];
  /** A mob's burst: which kind (data/mobs.json) */
  mob?: string;
}

/**
 * A ship part was destroyed. `how`: 'blast' = it blew up (size = blast radius),
 * 'break' = shot or crushed apart, 'crumble' = a loose part decaying (size = part size).
 * `vx, vy` is the body's velocity, so fragments fly on with it.
 */
export interface ServerPartDestroyedMessage {
  type: 'partDestroyed';
  bodyId: number;
  part: number;
  fn: string;
  how: 'blast' | 'break' | 'crumble';
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
}

/** Two bodies collided at (x, y) along normal (nx, ny), closing at `speed` units per tick */
export interface ServerContactMessage {
  type: 'contact';
  x: number;
  y: number;
  nx: number;
  ny: number;
  speed: number;
}

export interface ServerDockResultMessage {
  type: 'dockResult';
  ok: boolean;
  /** Station name when docked */
  station?: string;
  error?: string;
}

/** A projectile struck something at (x, y): clients end its tracer there and throw sparks. */
export interface ServerProjectileHitMessage {
  type: 'projectileHit';
  id: number;
  x: number;
  y: number;
}

/**
 * A modular ship or debris body, sent when a client first sees it and after
 * every server rebuild. `hp` is exact and is what the server rebuilt from, so
 * the client's rebuild() reproduces the server's derived stats.
 */
export interface ServerShipSyncMessage {
  type: 'shipSync';
  id: number;
  kind: 'ship' | 'debris';
  /** Sent the first time a client sees this ship; later syncs (after a rebuild) reuse it */
  blueprint?: Blueprint;
  /**
   * The design's hash. With a blueprint, the client keeps it under this; alone,
   * the client already has that design (another ship of it), so it isn't resent.
   */
  design?: string;
  /** Every part's HP (a new ship), or... */
  hp?: number[];
  /** ...after a rebuild, just the parts whose HP the client doesn't have: [part, hp] */
  hpd?: [number, number][];
  /** Every part's most HP, when it isn't the blueprint's (a boss's scaled hull): with `hp` */
  maxHp?: number[];
  /** Part indices that have left this body as debris */
  detached: number[];
  /** Part indices not built yet (hangar ghosts) */
  ghosts?: number[];
  rebuilds: number;
}

/** Part HP changes between rebuilds (visual only: the client doesn't rebuild on these) */
export interface ServerShipHpMessage {
  type: 'shipHp';
  id: number;
  /** [part index, hp] */
  hp: [number, number][];
}

/** Every ship's part HP changes since the last snapshot, in one message: [ship id, [part index, hp][]] */
export interface ServerShipHpBatchMessage {
  type: 'shipHps';
  ships: [number, [number, number][]][];
}

/** The client has no blueprint for this ship (it was dropped): send a full sync */
export interface ClientShipNeedMessage {
  type: 'shipNeed';
  id: number;
}

export interface ServerShipEditResultMessage {
  type: 'shipEditResult';
  ok: boolean;
  errors: string[];
}

// ============================================
// BINARY ENCODING FOR HIGH-FREQUENCY MESSAGES
// ============================================

// Binary message type IDs (first byte)
const BINARY_MSG_INPUT_V1 = 0x01;
const BINARY_MSG_INPUT = 0x03;

// Input message binary format (11 bytes):
// [0]    : BINARY_MSG_INPUT
// [1-2]  : seq (16 bits)
// [3-4]  : targetTick, low 16 bits (the server takes the tick nearest its own: unwrapTick16)
// [5]    : flags (forward, backward, left, right, boost, fireLeft, fireRight)
// [6-7]  : aim angle in the 13-bit cursor quantization (the client only ever sends those)
// [8-9]  : cursorDist / CURSOR_DIST_STEP (16 bits)
// [10]   : flags2 (strafeLeft, strafeRight, helm, jump, has targetTick, -, dodge, -)  (0x20 and 0x80 free)
// The tick the client was at isn't sent: nothing reads it.
// (The old 17-byte form, type 0x01, still decodes.)

/** A tick from its low 16 bits: the one nearest `near` */
export function unwrapTick16(low: number, near: number): number {
  const d = ((low - near) % 65536 + 65536 + 32768) % 65536 - 32768;
  return near + d;
}

export function encodeInputBinary(msg: ClientInputMessage): ArrayBuffer {
  const buffer = new ArrayBuffer(11);
  const view = new DataView(buffer);
  view.setUint8(0, BINARY_MSG_INPUT);
  view.setUint16(1, msg.seq & 0xFFFF, true);
  view.setUint16(3, (msg.targetTick ?? 0) & 0xFFFF, true);
  view.setUint8(5,
    (msg.forward ? 0x01 : 0) |
    (msg.backward ? 0x02 : 0) |
    (msg.left ? 0x04 : 0) |
    (msg.right ? 0x08 : 0) |
    (msg.boost ? 0x10 : 0) |
    (msg.fireLeft ? 0x20 : 0) |
    (msg.fireRight ? 0x40 : 0));
  view.setUint16(6, quantizeCursorAngle(msg.targetAngle), true);
  view.setUint16(8, quantizeCursorDist(msg.cursorDist ?? 0), true);
  view.setUint8(10,
    (msg.strafeLeft ? 0x01 : 0) |
    (msg.strafeRight ? 0x02 : 0) |
    (msg.helm ? 0x04 : 0) |
    (msg.jump ? 0x08 : 0) |
    (msg.targetTick !== undefined ? 0x10 : 0) |
    (msg.dodge ? 0x40 : 0));
  return buffer;
}

export function decodeInputBinary(data: ArrayBuffer | Uint8Array): ClientInputMessage {
  // (A Node Buffer shares a larger ArrayBuffer: respect its offset and length)
  const view = data instanceof ArrayBuffer ? new DataView(data) : new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getUint8(0) === BINARY_MSG_INPUT_V1) return decodeInputV1(view);
  const flags = view.getUint8(5);
  const flags2 = view.getUint8(10);
  return {
    type: 'input',
    seq: view.getUint16(1, true),
    tick: 0,
    targetTick: flags2 & 0x10 ? view.getUint16(3, true) : undefined,
    forward: (flags & 0x01) !== 0,
    backward: (flags & 0x02) !== 0,
    left: (flags & 0x04) !== 0,
    right: (flags & 0x08) !== 0,
    boost: (flags & 0x10) !== 0,
    fireLeft: (flags & 0x20) !== 0,
    fireRight: (flags & 0x40) !== 0,
    // As the old float32 form carried it, so the server steps exactly what the client predicted
    targetAngle: Math.fround(dequantizeCursorAngle(view.getUint16(6, true))),
    strafeLeft: (flags2 & 0x01) !== 0,
    strafeRight: (flags2 & 0x02) !== 0,
    helm: (flags2 & 0x04) !== 0,
    jump: (flags2 & 0x08) !== 0,
    dodge: (flags2 & 0x40) !== 0,
    cursorDist: view.getUint16(8, true) * CURSOR_DIST_STEP,
  };
}

function decodeInputV1(view: DataView): ClientInputMessage {
  const flags = view.getUint8(9);
  const flags2 = view.byteLength > 14 ? view.getUint8(14) : 0;
  return {
    type: 'input',
    seq: view.getUint16(1, true),
    tick: view.getUint8(3) | (view.getUint8(4) << 8) | (view.getUint8(5) << 16),
    targetTick: view.getUint8(6) | (view.getUint8(7) << 8) | (view.getUint8(8) << 16),
    forward: (flags & 0x01) !== 0,
    backward: (flags & 0x02) !== 0,
    left: (flags & 0x04) !== 0,
    right: (flags & 0x08) !== 0,
    boost: (flags & 0x10) !== 0,
    fireLeft: (flags & 0x20) !== 0,
    fireRight: (flags & 0x40) !== 0,
    targetAngle: view.getFloat32(10, true),
    strafeLeft: (flags2 & 0x01) !== 0,
    strafeRight: (flags2 & 0x02) !== 0,
    helm: (flags2 & 0x04) !== 0,
    jump: (flags2 & 0x08) !== 0,
    cursorDist: view.byteLength > 16 ? view.getUint16(15, true) * CURSOR_DIST_STEP : 0,
  };
}

/**
 * Check if data is a binary message (starts with known binary type ID)
 */
export function isBinaryMessage(data: ArrayBuffer | Uint8Array | string): boolean {
  if (typeof data === 'string') return false;
  // Handle Node.js Buffer properly - must respect byteOffset and byteLength
  let view: DataView;
  if (data instanceof ArrayBuffer) {
    view = new DataView(data);
  } else {
    view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }
  const firstByte = view.getUint8(0);
  return firstByte === BINARY_MSG_INPUT || firstByte === BINARY_MSG_INPUT_V1;
}

// ============================================
// HELPERS
// ============================================

export function encodeMessage(msg: ClientMessage | ServerMessage): string | ArrayBuffer {
  // Use binary encoding for input messages (high frequency)
  if (msg.type === 'input') {
    return encodeInputBinary(msg as ClientInputMessage);
  }
  // Snapshots go as rows of values rather than keyed objects (about half the size)
  if (msg.type === 'snapshot') return JSON.stringify(packSnapshot(msg));
  // Frequent server messages go as [code, ...values] (see COMPACT)
  const row = packCompact(msg);
  if (row) return JSON.stringify(row);
  // Fall back to JSON for other messages
  return JSON.stringify(msg);
}

/**
 * The server's frequent messages, sent as arrays of their values in this field
 * order ([code, ...values], code = index here, trailing absent values dropped)
 * instead of keyed objects: a damage number is ~20 bytes instead of ~60. A
 * message with a field not listed goes as a plain object, so nothing is lost.
 */
const COMPACT: [string, string[]][] = [
  ['damage', ['targetId', 'amount', 'sourceId', 'critical', 'hp', 'maxHp', 'glancing']],
  ['projectileHit', ['id', 'x', 'y']],
  ['partDestroyed', ['bodyId', 'part', 'fn', 'how', 'x', 'y', 'vx', 'vy', 'size']],
  ['contact', ['x', 'y', 'nx', 'ny', 'speed']],
  ['shipHps', ['ships']],
  ['shipSync', ['id', 'kind', 'hp', 'detached', 'rebuilds', 'design', 'blueprint', 'hpd', 'ghosts']],
  ['effect', ['effectType', 'x', 'y', 'targetX', 'targetY', 'entityId', 'data']],
  ['death', ['entityId', 'entityType', 'killerId']],
  ['stationFire', ['station', 'target', 'turret']],
  ['playerState', ['hp', 'maxHp', 'boostFuel', 'maxBoostFuel', 'xp', 'level', 'credits', 'systemId']],
  // (Packed first: see packSnapshot)
  ['snapshot', ['t', 'lp', 'e', 'p', 'r', 'k', 'c', 'o', 'f']],
  ['mapDots', ['tick', 'dots', 'routes', 'info', 'gone', 'names', 'full']],
];
const COMPACT_CODE = new Map(COMPACT.map(([type, fields], i) => [type, { code: i, fields, known: new Set(['type', ...fields]) }]));
/** Message types by compact code (for tools that count traffic) */
export const COMPACT_TYPES = COMPACT.map(([type]) => type);

function packCompact(msg: { type: string }): unknown[] | null {
  const c = COMPACT_CODE.get(msg.type);
  if (!c) return null;
  const m = (msg.type === 'snapshot' ? packSnapshot(msg as ServerSnapshotMessage) : msg) as unknown as Record<string, unknown>;
  for (const k in m) if (m[k] !== undefined && !c.known.has(k)) return null;
  const row: unknown[] = [c.code];
  for (const f of c.fields) row.push(m[f] ?? null);
  while (row.length > 1 && row[row.length - 1] === null) row.pop();
  return row;
}

function unpackCompact(row: unknown[]): ServerMessage {
  const [type, fields] = COMPACT[row[0] as number];
  const m: Record<string, unknown> = { type };
  for (let i = 1; i < row.length; i++) if (row[i] !== null) m[fields[i - 1]] = row[i];
  if (type === 'snapshot') return unpackSnapshot(m as unknown as PackedSnapshot);
  return m as unknown as ServerMessage;
}

/** One message as it came off the wire (a packed snapshot, a compact row, or a plain object) */
function unpackServer(x: unknown): ServerMessage {
  if (Array.isArray(x)) return unpackCompact(x);
  const m = x as { type: string; t?: number };
  return m.type === 'snapshot' && m.t !== undefined ? unpackSnapshot(m as unknown as PackedSnapshot) : (m as ServerMessage);
}

/**
 * Snapshot wire format: { type, t: tick, lp: lastProcessedInput, e: entity rows,
 * p: projectile rows, r: removed, k: keyframes, c: control rows, o: out of view }
 * (empty lists left out). A row is
 *   [id, type, x, y, angle, vx, vy, hp, maxHp, data, name, av]
 * with absent fields as null and trailing nulls dropped.
 */
const SNAP_FIELDS = ['id', 'type', 'x', 'y', 'angle', 'vx', 'vy', 'hp', 'maxHp', 'data', 'name', 'av'] as const;

/** What the encoding is defined by, for protocol.test.ts to hash (a change here needs a PROTOCOL_VERSION bump) */
export function wireTables(): Record<string, unknown> {
  return {
    compact: COMPACT,
    snapFields: SNAP_FIELDS,
    dictionary: DICTIONARY,
    binaryInput: [BINARY_MSG_INPUT_V1, BINARY_MSG_INPUT],
    serverFrame: SERVER_FRAME,
  };
}

interface PackedSnapshot { type: 'snapshot'; t: number; lp: number; e?: unknown[][]; p?: (number | null)[][]; r?: number[]; k?: number[][]; c?: number[][]; o?: number[]; f?: number[][] }

/**
 * Projectiles have rows of their own (they're most of a fight's rows):
 *   [id, vx, vy, weaponType, ticks since fired, spawnX, spawnY, ownerId, tier?, sizeScale?, turret?, x?, y?]
 * tier 1, size 1 and no turret go as null (trailing ones dropped); x and y only
 * when it's off the straight line from the muzzle (missiles). The hue is the
 * owner's, worked out again on arrival.
 */
function packProjectile(s: EntityState, tick: number): (number | null)[] | null {
  const d = s.data;
  if (!d || d.length !== 9 || s.angle !== undefined || s.hp !== undefined || s.name !== undefined) return null;
  const row: (number | null)[] = [s.id, s.vx ?? 0, s.vy ?? 0, d[0], tick - d[3], d[4], d[5], d[6],
    d[1] === 1 ? null : d[1], d[7] === 1 ? null : d[7], d[8] === 0 ? null : d[8], s.x ?? null, s.y ?? null];
  while (row[row.length - 1] === null) row.pop();
  return row;
}

function unpackProjectile(r: (number | null)[], tick: number): EntityState {
  const owner = r[7] as number;
  const s: EntityState = {
    id: r[0] as number, type: EntityType.Projectile, vx: r[1] as number, vy: r[2] as number,
    data: [r[3] as number, r[8] ?? 1, (owner * 137) % 360, tick - (r[4] as number), r[5] as number, r[6] as number, owner, r[9] ?? 1, r[10] ?? 0],
  } as EntityState;
  if (r[11] != null) { s.x = r[11]; s.y = r[12] as number; }
  return s;
}

/** A snapshot's entity rows and projectile rows */
function packEntities(m: ServerSnapshotMessage): { e: unknown[][]; p: (number | null)[][] } {
  const p: (number | null)[][] = [];
  const e = m.entities.filter((s) => {
    const row = s.type === EntityType.Projectile ? packProjectile(s, m.tick) : null;
    if (row) p.push(row);
    return !row;
  }).map((s) => {
    const row: unknown[] = SNAP_FIELDS.map((k) => (s as unknown as Record<string, unknown>)[k] ?? null);
    while (row.length && row[row.length - 1] === null) row.pop();
    return row;
  });
  return { e, p };
}

export function packSnapshot(m: ServerSnapshotMessage): PackedSnapshot {
  const { e, p } = packEntities(m);
  const out: PackedSnapshot = { type: 'snapshot', t: m.tick, lp: m.lastProcessedInput };
  if (e.length) out.e = e;
  if (p.length) out.p = p;
  if (m.removed.length) out.r = m.removed;
  if (m.ships?.length) out.k = m.ships;
  if (m.ctl?.length) out.c = packCtlIds(m.ctl);
  if (m.out?.length) out.o = m.out;
  if (m.fire?.length) out.f = packFire(m.fire);
  return out;
}

/**
 * Control rows on the wire go in id order, each id as the step from the one
 * before (doubled, plus 1 for a run row: see packControlRow), so most take a
 * byte instead of three.
 */
function packCtlIds(rows: number[][]): number[][] {
  const ided = rows.map((r) => (r[0] < 0 ? { id: -1 - r[0], run: 1, r } : { id: r[0], run: 0, r })).sort((a, b) => a.id - b.id);
  let prev = 0;
  return ided.map(({ id, run, r }) => { const row = [(id - prev) * 2 + run, ...r.slice(1)]; prev = id; return row; });
}

/**
 * Fire events on the wire: in owner order, the owner as the step from the one
 * before, and each shell id as the step from the last id (they're mostly
 * consecutive): [ownerStep, ticksAgo, part, aimQ, idStep, idStep, ...]
 */
function packFire(rows: number[][]): number[][] {
  const sorted = [...rows].sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  let owner = 0, id = 0;
  return sorted.map((r) => {
    const row = [r[0] - owner, r[1], r[2], r[3]];
    owner = r[0];
    for (let i = 4; i < r.length; i++) { row.push(r[i] - id); id = r[i]; }
    return row;
  });
}

function unpackFire(rows: number[][]): number[][] {
  let owner = 0, id = 0;
  return rows.map((r) => {
    owner += r[0];
    const row = [owner, r[1], r[2], r[3]];
    for (let i = 4; i < r.length; i++) { id += r[i]; row.push(id); }
    return row;
  });
}

function unpackCtlIds(rows: number[][]): number[][] {
  let id = 0;
  return rows.map((r) => {
    id += Math.floor(r[0] / 2);
    return [r[0] % 2 ? -1 - id : id, ...r.slice(1)];
  });
}

export function unpackSnapshot(p: PackedSnapshot): ServerSnapshotMessage {
  const entities = (p.e ?? []).map((row) => {
    const s: Record<string, unknown> = {};
    for (let i = 0; i < row.length; i++) if (row[i] !== null) s[SNAP_FIELDS[i]] = row[i];
    return s as unknown as EntityState;
  });
  for (const r of p.p ?? []) entities.push(unpackProjectile(r, p.t));
  return { type: 'snapshot', tick: p.t, lastProcessedInput: p.lp, entities, removed: p.r ?? [], ships: p.k, ctl: p.c && unpackCtlIds(p.c), out: p.o, fire: p.f && unpackFire(p.f) };
}

/**
 * Everything in one frame from the server: a single message, or a batch of the
 * messages a tick produced ({ type: 'batch', m: [...] }).
 */
// ---------------------------------------------------------------------------
// Server → client frames are binary (binaryCodec.ts): SERVER_FRAME, then each
// message's wire form (a compact row, or a plain object) one after another.

export const SERVER_FRAME = 0x02;

/** A server message's bytes (encode once, send to every client it's for) */
export function encodeServerMessage(msg: ServerMessage): Uint8Array {
  if (msg.type === 'snapshot') return encodeSnapshot(msg);
  return encodeBinary(packCompact(msg) ?? msg);
}

/**
 * A snapshot's bytes: exactly what encodeBinary(packCompact(snapshot)) gives (protocol.test.ts holds it to that),
 * but each keyframe and control row is encoded once and its bytes kept with it. The server makes those rows once a
 * snapshot for every client that gets them (its Replication) and never changes one after, so each client's snapshot
 * copies them in rather than encoding them again. A control row's id goes as the step from the one before (see
 * packCtlIds), so what's kept of one is the rest of it.
 */
const keyframeBytes = new WeakMap<readonly number[], Uint8Array>();
const ctlTailBytes = new WeakMap<readonly number[], Uint8Array>();
const rowWriter = new BinaryWriter();
const snapWriter = new BinaryWriter();
const SNAPSHOT_CODE = COMPACT_CODE.get('snapshot')!.code;

function rowBytes(cache: WeakMap<readonly number[], Uint8Array>, row: readonly number[], from: number): Uint8Array {
  let b = cache.get(row);
  if (!b) {
    if (from === 0) rowWriter.value(row);
    else for (let i = from; i < row.length; i++) rowWriter.value(row[i]);
    b = rowWriter.take();
    cache.set(row, b);
  }
  return b;
}

function encodeSnapshot(m: ServerSnapshotMessage): Uint8Array {
  const { e, p } = packEntities(m);
  // (The compact row: [code, t, lp, e, p, r, k, c, o, f], absent ones null and trailing nulls dropped)
  const row: unknown[] = [SNAPSHOT_CODE, m.tick ?? null, m.lastProcessedInput ?? null, e.length ? e : null, p.length ? p : null,
    m.removed.length ? m.removed : null, m.ships?.length ? m.ships : null, m.ctl?.length ? m.ctl : null,
    m.out?.length ? m.out : null, m.fire?.length ? packFire(m.fire) : null];
  while (row.length > 1 && row[row.length - 1] === null) row.pop();
  const w = snapWriter;
  w.arrayHeader(row.length);
  for (let i = 0; i < row.length; i++) {
    if (i === 6 && m.ships?.length) {
      w.arrayHeader(m.ships.length);
      for (const k of m.ships) w.bytes(rowBytes(keyframeBytes, k, 0));
    } else if (i === 7 && m.ctl?.length) {
      // (As packCtlIds: in id order, each id the step from the one before, doubled, plus 1 for a run row)
      const ided = m.ctl.map((r) => (r[0] < 0 ? { id: -1 - r[0], run: 1, r } : { id: r[0], run: 0, r })).sort((a, b) => a.id - b.id);
      w.arrayHeader(ided.length);
      let prev = 0;
      for (const { id, run, r } of ided) {
        w.arrayHeader(r.length);
        w.number((id - prev) * 2 + run);
        w.bytes(rowBytes(ctlTailBytes, r, 1));
        prev = id;
      }
    } else {
      w.value(row[i]);
    }
  }
  return w.take();
}

/** A frame of encoded messages */
export function serverFrame(parts: Uint8Array[]): Uint8Array {
  let n = 1;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  out[0] = SERVER_FRAME;
  let at = 1;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

function bytesOf(data: ArrayBuffer | Uint8Array): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

/** A binary frame's messages, each with its size on the wire (for tools that count traffic) */
export function splitServerFrame(data: ArrayBuffer | Uint8Array): { msg: ServerMessage; wire: unknown; bytes: number }[] {
  const buf = bytesOf(data);
  if (buf[0] !== SERVER_FRAME) throw new Error('not a server frame');
  const r = new BinaryReader(buf);
  r.pos = 1;
  const out: { msg: ServerMessage; wire: unknown; bytes: number }[] = [];
  while (!r.done) {
    const at = r.pos;
    const wire = r.value();
    out.push({ msg: unpackServer(wire), wire, bytes: r.pos - at });
  }
  return out;
}

export function decodeServerFrame(data: string | ArrayBuffer | Uint8Array): ServerMessage[] {
  if (typeof data !== 'string') {
    const buf = bytesOf(data);
    if (buf[0] !== SERVER_FRAME) return [decodeMessage(buf) as ServerMessage];
    const r = new BinaryReader(buf);
    r.pos = 1;
    const out: ServerMessage[] = [];
    while (!r.done) out.push(unpackServer(r.value()));
    return out;
  }
  const m = JSON.parse(data);
  const list: unknown[] = !Array.isArray(m) && m.type === 'batch' ? m.m : [m];
  return list.map(unpackServer);
}

export function decodeMessage(data: string | ArrayBuffer | Uint8Array): ClientMessage | ServerMessage {
  // Check for binary message
  if (typeof data !== 'string') {
    if (isBinaryMessage(data)) {
      return decodeInputBinary(data);
    }
    // Unknown binary format - should not happen, but try to handle gracefully
    throw new Error('Unknown binary message format');
  }
  const m = JSON.parse(data);
  return Array.isArray(m) || m.type === 'snapshot' ? unpackServer(m) : m;
}
