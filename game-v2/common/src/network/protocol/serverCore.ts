/**
 * @contract protocol.server-core
 * owns:       the core server-to-client message types: welcome, snapshot, player state, chat, range, dialogue, shop, damage, admin, asteroids
 * needs:      econ/social protocol types, ships/types, data/schemas
 * invariants: server message shapes are the wire contract — serverMessages.json
 * extend:     a new server message is an interface here (or its own *Protocol.ts) plus one line in serverMessage.ts
 */
import type { AsteroidBeltData, LodestoneData } from '../../data/schemas.js';
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
  /**
   * Its own ship's tick-layer causes (hits.ts CAPS.OWN_SIM, network/ownTick.ts): [ticksAgo, kind, ...], in the order
   * the server's step had them
   */
  own?: number[][];
  /**
   * Bosses' decisions for the bodies it runs (CAPS.BODIES, common bodies/decisions.ts): [id, dt, op, ...args], dt the
   * decision's tick less the snapshot's
   */
  decisions?: number[][];
  /**
   * Other ships' tick-layer causes (hits.ts CAPS.CAUSES, network/causes.ts): [ago, kind, id, ...] (a contact once for
   * both ships), by tick, in the order the server's step had them
   */
  causes?: number[][];
  /**
   * Homing shells it runs on its tick layer (hits.ts CAPS.WAYPOINTS, guidance/records.ts): [id, dt, op, ...args], dt the
   * record's tick less the snapshot's
   */
  guides?: number[][];
  /**
   * The head hash (hits.ts CAPS.OWN_SIM; sim/headHash.ts): its own ship as the server stepped it to this snapshot's
   * tick, the low 16 bits of its state's hash (sim/c-replicaState.ts replicaStateHash), and the flags above them
   * (HEAD_HASH_HELD, HEAD_HASH_ROW): own | flags << 16, 24 bits. In place of its own row's safety copy every 2 s
   */
  hh?: number;
  /**
   * Other pilots' gun-control changes in this snapshot's window, for the gun lanes it steps (sim/otherGuns.ts
   * packGunRow rows, in the server's lane order): taken before the rest of the snapshot (OtherGuns.onGunCtl). Each
   * row is made once a round for every client (GunNet), so it goes as an encode-once block
   */
  gun?: number[][];
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

/** One range dummy's readout (ServerRangeStateMessage) */
export interface RangeDummyState {
  id: string;
  name: string;
  /** Distance from the firing line, units */
  dist: number;
  dead: boolean;
  /** Hull (core) and shield, 0..1 */
  hull: number;
  shield: number;
  /** Damage taken in the last 5 s, and per second over them */
  dmg5: number;
  dps: number;
  /** Seconds of the current fight (first hit until now or its death), and the last kill's: first hit to death */
  fight: number;
  ttk: number | null;
  /** Everything taken since its first hit */
  total: number;
}

/**
 * The weapons range's readout as the client's panel sees it (client devRangeFeed.ts puts it together from rangeHead
 * and rangeRow; never sent whole)
 */
export interface ServerRangeStateMessage {
  type: 'rangeState';
  moving: boolean;
  ideal: boolean;
  /** Each gun you carry: its model's name, its kind, and the crate "ideal ammo" gives it (or the one it is firing) */
  guns: { name: string; kind: string; crate?: string }[];
  dummies: RangeDummyState[];
}

/**
 * Dev tool, the weapons range (WeaponsRange.ts): what changes rarely, sent when a pilot arrives and when any of it
 * changes: the switches, your guns, and each dummy's label (its rangeRow index is its place here)
 */
export interface ServerRangeHeadMessage {
  type: 'rangeHead';
  moving: boolean;
  ideal: boolean;
  guns: { name: string; kind: string; crate?: string }[];
  dummies: { id: string; name: string; dist: number }[];
}

/**
 * Dev tool, the weapons range: one dummy's numbers, sent (a compact row) only when they change. On the wire `dead` is
 * 0/1, hull and shield are whole percent, fight and ttk tenths of a second (COMPACT_HOOKS); ttk absent is "none"
 */
export interface ServerRangeRowMessage {
  type: 'rangeRow';
  /** The dummy's index in rangeHead.dummies */
  i: number;
  dead: boolean;
  hull: number;
  shield: number;
  dmg5: number;
  dps: number;
  fight: number;
  total: number;
  ttk?: number;
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
  /** The owner rank, above admin (isAdmin is true for the owner too); missing: not the owner */
  isOwner?: boolean;
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
  /** The owner rank (admin is true for them too); missing: not */
  owner?: boolean;
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
  rank: 'player' | 'contributor' | 'admin' | 'owner';
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
  ids: number[];          // asteroid entity ids in this system, as ranges (ranges.ts: [start, count, ...])
  indices: number[];      // original deterministic indices for ids, as ranges, in the same order
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

