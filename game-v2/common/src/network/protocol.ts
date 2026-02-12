/**
 * Network Protocol - All client/server message types
 */

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
}

export interface ClientPingMessage {
  type: 'ping';
  clientTime: number;
}

export interface ClientChatMessage {
  type: 'chat';
  text: string;
}

export interface ClientInteractMessage {
  type: 'interact';
  targetId?: number;  // Entity ID of NPC/station (optional - server finds nearest)
}

export interface ClientEquipMessage {
  type: 'equip';
  inventorySlot: number;
  equipSlot: 'leftWeapon' | 'rightWeapon' | 'booster' | 'cockpit';
}

export interface ClientUnequipMessage {
  type: 'unequip';
  equipSlot: 'leftWeapon' | 'rightWeapon' | 'booster' | 'cockpit';
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

export interface ClientAcceptQuestMessage {
  type: 'acceptQuest';
  questId: string;
  npcId: string;
}

export interface ClientAbandonQuestMessage {
  type: 'abandonQuest';
  questId: string;
}

export interface ClientTurnInQuestMessage {
  type: 'turnInQuest';
  questId: string;
  npcId: string;
}

export interface ClientWarpMessage {
  type: 'warp';
  portalId: string;
}

export interface ClientRespawnMessage {
  type: 'respawn';
}

export interface ClientJoinMessage {
  type: 'join';
  token?: string;      // Auth session token (for registered users)
  username: string;    // Display name (for guests)
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
  | ClientPingMessage
  | ClientChatMessage
  | ClientInteractMessage
  | ClientEquipMessage
  | ClientUnequipMessage
  | ClientDropItemMessage
  | ClientPickupMessage
  | ClientBuyMessage
  | ClientSellMessage
  | ClientRepairMessage
  | ClientRefuelMessage
  | ClientBankDepositMessage
  | ClientBankWithdrawMessage
  | ClientAcceptQuestMessage
  | ClientAbandonQuestMessage
  | ClientTurnInQuestMessage
  | ClientWarpMessage
  | ClientRespawnMessage
  | ClientJoinMessage
  | ClientAuthLoginMessage
  | ClientAuthRegisterMessage
  | ClientStateHashMessage;

// ============================================
// SERVER -> CLIENT MESSAGES
// ============================================

export interface ServerWelcomeMessage {
  type: 'welcome';
  playerId: number;       // Entity ID
  tickRate: number;
  serverTime: number;
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
  shield?: number;
  maxShield?: number;
  // Type-specific data encoded as needed
  data?: number[];
  // Player display name (only for Player entities)
  name?: string;
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
}

export interface ServerSnapshotMessage {
  type: 'snapshot';
  tick: number;
  serverTime: number;
  lastProcessedInput: number;  // Client input seq
  entities: EntityState[];
  // Removed entities this tick
  removed: number[];
}

export interface ServerPlayerStateMessage {
  type: 'playerState';
  hp: number;
  maxHp: number;
  shield: number;
  maxShield: number;
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

export interface EquipmentSlots {
  leftWeapon: string | null;
  rightWeapon: string | null;
  booster: string | null;
  cockpit: string | null;
}

export interface ServerInventoryMessage {
  type: 'inventory';
  slots: InventorySlot[];
  equipment: EquipmentSlots;
}

export interface ServerBankMessage {
  type: 'bank';
  slots: InventorySlot[];
}

export interface ActiveQuest {
  questId: string;
  currentStage: number;
  progress: number;
  maxProgress: number;
}

export interface ServerQuestsMessage {
  type: 'quests';
  active: ActiveQuest[];
  completed: string[];
}

export interface ServerQuestUpdateMessage {
  type: 'questUpdate';
  questId: string;
  stage: number;
  progress: number;
  maxProgress: number;
  completed: boolean;
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
}

export interface ServerAuthResultMessage {
  type: 'authResult';
  success: boolean;
  username?: string;
  token?: string;
  isAdmin?: boolean;
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
  playerList: { id: number; name: string; ping: number; system: string }[];
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
  belt: { innerRadius: number; outerRadius: number; count: number };
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
  | ServerInventoryMessage
  | ServerBankMessage
  | ServerQuestsMessage
  | ServerQuestUpdateMessage
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
  | ServerAdminStatsMessage;

// ============================================
// BINARY ENCODING FOR HIGH-FREQUENCY MESSAGES
// ============================================

// Binary message type IDs (first byte)
const BINARY_MSG_INPUT = 0x01;

// Input message binary format (13 bytes total):
// [0]    : BINARY_MSG_INPUT (1 byte)
// [1-2]  : seq (16 bits)
// [3-5]  : tick (24 bits) 
// [6-8]  : targetTick (24 bits)
// [9]    : flags (8 bits: forward, backward, left, right, boost, fireLeft, fireRight, reserved)
// [10-13]: targetAngle as float32 (4 bytes)

/**
 * Encode input message to binary (13 bytes vs ~190 bytes JSON)
 */
export function encodeInputBinary(msg: ClientInputMessage): ArrayBuffer {
  const buffer = new ArrayBuffer(14);
  const view = new DataView(buffer);
  
  view.setUint8(0, BINARY_MSG_INPUT);
  view.setUint16(1, msg.seq & 0xFFFF, true); // little-endian
  
  // Pack tick into 24 bits
  const tick = msg.tick & 0xFFFFFF;
  view.setUint8(3, tick & 0xFF);
  view.setUint8(4, (tick >> 8) & 0xFF);
  view.setUint8(5, (tick >> 16) & 0xFF);
  
  // Pack targetTick into 24 bits
  const targetTick = (msg.targetTick ?? 0) & 0xFFFFFF;
  view.setUint8(6, targetTick & 0xFF);
  view.setUint8(7, (targetTick >> 8) & 0xFF);
  view.setUint8(8, (targetTick >> 16) & 0xFF);
  
  // Pack boolean flags into 1 byte
  const flags = 
    (msg.forward ? 0x01 : 0) |
    (msg.backward ? 0x02 : 0) |
    (msg.left ? 0x04 : 0) |
    (msg.right ? 0x08 : 0) |
    (msg.boost ? 0x10 : 0) |
    (msg.fireLeft ? 0x20 : 0) |
    (msg.fireRight ? 0x40 : 0);
  view.setUint8(9, flags);
  
  // targetAngle as float32
  view.setFloat32(10, msg.targetAngle, true);
  
  return buffer;
}

/**
 * Decode binary input message
 */
export function decodeInputBinary(data: ArrayBuffer | Uint8Array): ClientInputMessage {
  // Handle Node.js Buffer properly - it's a Uint8Array but shares a larger underlying ArrayBuffer
  // We need to pass both byteOffset AND byteLength to DataView
  let view: DataView;
  if (data instanceof ArrayBuffer) {
    view = new DataView(data);
  } else {
    // Uint8Array or Node.js Buffer - must respect byteOffset and byteLength
    view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }
  
  // const msgType = view.getUint8(0); // Should be BINARY_MSG_INPUT
  const seq = view.getUint16(1, true);
  
  const tick = view.getUint8(3) | (view.getUint8(4) << 8) | (view.getUint8(5) << 16);
  const targetTick = view.getUint8(6) | (view.getUint8(7) << 8) | (view.getUint8(8) << 16);
  
  const flags = view.getUint8(9);
  const targetAngle = view.getFloat32(10, true);
  
  return {
    type: 'input',
    seq,
    tick,
    targetTick,
    forward: (flags & 0x01) !== 0,
    backward: (flags & 0x02) !== 0,
    left: (flags & 0x04) !== 0,
    right: (flags & 0x08) !== 0,
    boost: (flags & 0x10) !== 0,
    fireLeft: (flags & 0x20) !== 0,
    fireRight: (flags & 0x40) !== 0,
    targetAngle,
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
  return firstByte === BINARY_MSG_INPUT;
}

// ============================================
// HELPERS
// ============================================

export function encodeMessage(msg: ClientMessage | ServerMessage): string | ArrayBuffer {
  // Use binary encoding for input messages (high frequency)
  if (msg.type === 'input') {
    return encodeInputBinary(msg as ClientInputMessage);
  }
  // Fall back to JSON for other messages
  return JSON.stringify(msg);
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
  return JSON.parse(data);
}
