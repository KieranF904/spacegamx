/**
 * Data Schemas - TypeScript interfaces for game data files
 */

// ============================================
// ITEM DATA
// ============================================

export type ItemSlot = 'leftWeapon' | 'rightWeapon' | 'booster' | 'cockpit';
export type ItemType = 'weapon' | 'equipment' | 'resource' | 'consumable';
export type WeaponTypeString = 'cannon' | 'laser' | 'scatter' | 'missile' | 'pulse' | 'mine' | 'mining' | 'warp';
export type Rarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary' | 'quest';

export interface ItemData {
  id: string;
  name: string;
  type: ItemType;
  tier?: number;
  rarity: Rarity;
  description: string;
  
  // Weapon-specific
  slot?: ItemSlot;
  weaponType?: WeaponTypeString;
  damage?: number;
  speed?: number;
  fireRate?: number;
  range?: number;
  spread?: number;
  projectileCount?: number;
  maxCharge?: number;
  homing?: number;
  splashRadius?: number;
  maxMines?: number;
  miningSpeed?: number;
  
  // Equipment-specific
  thrustMultiplier?: number;
  fuelCapacity?: number;
  regenRate?: number;
  hpBonus?: number;
  shieldBonus?: number;
  radarRange?: number;
  accelBonus?: number;
  turnBonus?: number;
  
  // Resource-specific
  stackSize?: number;
  value?: number;
}

// ============================================
// STAR SYSTEM DATA
// ============================================

export interface Vector2 {
  x: number;
  y: number;
}

export interface AsteroidBeltData {
  innerRadius: number;
  outerRadius: number;
  count: number;
}

export interface PortalData {
  id: string;
  targetSystem: string;
  position: Vector2;
}

export type SystemHazard = 'cold' | 'radiation' | 'low_visibility' | 'darkness' | 'gravitational_anomalies';

export interface StarSystemData {
  id: string;
  name: string;
  description: string;
  starColor: string;
  starRadius: number;
  position: Vector2;
  hazards: SystemHazard[];
  asteroidDensity: number;
  asteroidBelt: AsteroidBeltData;
  asteroidField?: string;  // Optional field ID for definition-based asteroid generation
  stations: string[];
  npcs: string[];
  enemies: string[];
  portals: PortalData[];
}

// ============================================
// ENEMY DATA
// ============================================

export interface DropData {
  itemId: string;
  chance: number;
  minCount: number;
  maxCount: number;
}

export interface SpawnInfo {
  maxCount: number;
  spawnInterval: number;
  minRadius: number;
  maxRadius: number;
  systems: string[];
}

export interface EnemyVisuals {
  color: string;
  glowColor: string;
  trailColor: string;
  shape: string;
}

export interface EnemyAI {
  detectionRange: number;
  loseAggroRange: number;
  attackPattern: string;
  fleeThreshold: number;
  groupBehavior: boolean;
  teleportCooldown?: number;
  teleportRange?: number;
  burrowCooldown?: number;
  territoryRadius?: number;
}

export type EnemyBehavior = 'aggressive' | 'flanker' | 'sniper' | 'swarm' | 'territorial' | 'teleport' | 'burrow' | 'flee_when_damaged';

export interface EnemyTypeData {
  id: string;
  name: string;
  description: string;
  hp: number;
  damage: number;
  xp: number;
  speed: number;
  radius: number;
  attackRange: number;
  attackCooldown: number;
  projectileSpeed: number;
  behaviors: EnemyBehavior[];
  drops: DropData[];
  spawnInfo: SpawnInfo;
  visuals: EnemyVisuals;
  ai: EnemyAI;
}

// ============================================
// NPC DATA
// ============================================

export interface NPCDialogue {
  greeting: string;
  idle: string[];
  farewell: string;
}

export interface ShopItem {
  itemId: string;
  stock: number;  // -1 = unlimited
  price: number;
}

export interface ShopData {
  buyMultiplier: number;
  sellMultiplier: number;
  inventory: ShopItem[];
}

export type NPCService = 'repair' | 'heal' | 'refuel';

export interface NPCData {
  id: string;
  name: string;
  title: string;
  description: string;
  system: string;
  position: Vector2;
  radius: number;
  sprite: string;
  dialogue: NPCDialogue;
  quests: string[];
  shop: ShopData | null;
  services: NPCService[];
}

// ============================================
// STATION DATA
// ============================================

export type StationService = 'repair' | 'refuel' | 'shop' | 'bank' | 'quests';

export interface StationData {
  id: string;
  name: string;
  description: string;
  system: string;
  position: Vector2;
  radius: number;
  sprite: string;
  dockingRadius: number;
  orbit?: OrbitData;
  services: StationService[];
  shop?: ShopData;
  repairCostPerHp: number;
  refuelCostPerUnit: number;
}

export interface OrbitData {
  orbitType: number;
  semiMajorAxis: number;
  eccentricity: number;
  argPeriapsis: number;
  meanAnomaly0: number;
  epochTick?: number;
}

// ============================================
// QUEST DATA
// ============================================

export type QuestStageType = 'travel' | 'kill' | 'gather' | 'interact' | 'action' | 'acquire';

export interface QuestObjective {
  // Travel
  system?: string;
  distance?: number;
  
  // Kill
  enemy?: string;
  count?: number;
  weaponType?: WeaponTypeString;
  
  // Gather/Acquire
  item?: string;
  
  // Interact
  npc?: string;
  station?: string;
  
  // Action
  action?: string;
}

export interface QuestStageDialogue {
  start: string;
  complete?: string;
}

export interface QuestStage {
  id: string;
  type: QuestStageType;
  description: string;
  objective: QuestObjective;
  dialogue: QuestStageDialogue;
}

export interface QuestRewards {
  xp: number;
  credits: number;
  items: string[];
}

export interface QuestData {
  id: string;
  name: string;
  description: string;
  giver: string;
  level: number;
  stages: QuestStage[];
  rewards: QuestRewards;
  prerequisites: string[];
  repeatable: boolean;
}

// ============================================
// DATA FILE ROOTS
// ============================================

export interface ItemsFile {
  items: ItemData[];
}

export interface SystemsFile {
  systems: StarSystemData[];
}

export interface EnemiesFile {
  enemies: EnemyTypeData[];
}

export interface NPCsFile {
  npcs: NPCData[];
}

export interface StationsFile {
  stations: StationData[];
}

export interface QuestsFile {
  quests: QuestData[];
}
