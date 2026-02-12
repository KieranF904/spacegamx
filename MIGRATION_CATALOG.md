# Space Game v1 → v2 Feature Migration Catalog

## Complete Technical Reference for Faithful Recreation

---

## 1. CORE CONSTANTS & CONFIGURATION

### World Parameters
```javascript
WORLD_SIZE = 260000           // Half-width/height of the world
STAR_MASS = 80000             // Gravitational strength for orbital calculations
STAR_RADIUS = 1000            // Visual radius of star (~2000 diameter)
EVENT_HORIZON = 800           // Objects inside consumed by star
SYSTEM_RADIUS = 80000         // Radius of each star system
CHUNK_SIZE = 500              // Spatial partitioning grid size
```

### Timing Constants
```javascript
TICK_RATE = 60                // Server game loop Hz
SNAPSHOT_RATE = 20            // Client update Hz (60/3)
FIXED_TICK_MS = 1000/60       // ~16.67ms per tick
INPUT_DELAY_MS = 100          // Input prediction delay
INPUT_DELAY_TICKS = 6         // Math.round(100/16.67)
MAX_FRAME_DELTA_MS = 250      // Maximum frame time cap
PING_INTERVAL_MS = 2000       // Ping measurement interval
PING_HISTORY_SIZE = 5         // Rolling ping average window
```

### Server Tick Smoothing
```javascript
SERVER_TICK_SMOOTHING = 0.5
SERVER_TICK_MAX_STEP = 1
INTERP_MAX_DELAY_MS = 520
INTERP_MIN_DELAY_MS = 80
INTERP_SLEW_MS_PER_SEC = 90
```

---

## 2. PLAYER SYSTEM

### Player Stats
```javascript
PLAYER_MAX_HP = 100
PLAYER_REGEN_RATE = 1         // HP per regen tick
PLAYER_REGEN_DELAY_TICKS = 300 // 5 seconds out of combat

// Movement
ACCEL_BASE = 0.22
TURN_SPEED = 0.08
FRICTION = 0.985
BOOST_DRAIN = 0.8
BOOST_REGEN = 0.35
BOOST_REGEN_DELAY = 60        // ticks
BOOST_FUEL_DEFAULT = 100
BOOST_FACTOR = 2.2            // Speed multiplier when boosting
```

### Player State Structure
```javascript
{
  id: string,
  userId: string,              // Supabase auth ID
  name: string,
  x, y: number,
  vx, vy: number,
  angle: number,
  boostFuel: number,
  maxBoostFuel: number,
  boostRegenTimer: number,
  hp: number,
  maxHp: number,
  level: number,
  xp: number,
  xpToNext: number,
  lastCombatTick: number,
  systemId: string,
  dockedAtStation: boolean,
  warpBoosted: boolean,        // Active warp boost flag
  inventory: Item[10],
  equipment: {
    leftWeapon: Item,
    rightWeapon: Item,
    booster: Item,
    cockpit: Item
  },
  itemBank: Item[50],
  quests: {
    active: { [questId]: QuestState },
    completed: string[]
  },
  // Weapon state
  leftCooldown, rightCooldown: number,
  leftChargeTicks, rightChargeTicks: number,
  leftPulseCharge, rightPulseCharge: number,
  leftMineCharge, rightMineCharge: number,
  leftDeployedMines, rightDeployedMines: Projectile[],
  leftLaser, rightLaser: LaserState,
  // Input
  input: InputState,
  inputQueue: Map<tick, InputState>,
  lastSeq: number
}
```

### Equipment Bonuses
```javascript
// Cockpit bonuses
cockpit_mk1: { turnBonus: 0, accelBonus: 0 }
cockpit_mk2: { turnBonus: 0.02, accelBonus: 0.05 }
cockpit_mk3: { turnBonus: 0.04, accelBonus: 0.1 }

// Booster bonuses  
booster_mk1: { fuelBonus: 0, regenBonus: 0 }
booster_mk2: { fuelBonus: 25, regenBonus: 0.1 }
booster_mk3: { fuelBonus: 50, regenBonus: 0.2 }
```

### Player Modifiers System
```javascript
// Modifiers are temporary effects (friction, poison, slow)
addPlayerModifier(player, type, value, durationTicks)
updatePlayerModifiers(player)  // Called each tick

// Example: Warp boost ending applies friction modifier
addPlayerModifier(player, 'friction', 0.1, 30) // 10% friction for 0.5s
WARP_BOOST_END_SPEED = 25     // Speed threshold to end warp boost
```

---

## 3. ITEMS & EQUIPMENT

### Item Rarity System
```javascript
rarities = ['common', 'uncommon', 'rare', 'legendary', 'quest']

TIER_COLORS = {
  mk1: { hue: 120, name: 'green' },   // Common
  mk2: { hue: 210, name: 'blue' },    // Uncommon
  mk3: { hue: 280, name: 'purple' }   // Rare
}
```

### Item Type Definitions
```javascript
ITEM_TYPES = {
  // === LASER WEAPONS ===
  'laser_mk1': { 
    name: 'Laser Mk1', slot: 'weapon', weaponType: 'laser',
    damage: 1.0, range: 3000, cooldown: 6, 
    rarity: 'common', icon: '⚡', tier: 'mk1'
  },
  'laser_mk2': { 
    name: 'Laser Mk2', slot: 'weapon', weaponType: 'laser',
    damage: 1.5, range: 3600, cooldown: 5,
    rarity: 'uncommon', icon: '⚡', tier: 'mk2'
  },
  'laser_mk3': { 
    name: 'Laser Mk3', slot: 'weapon', weaponType: 'laser',
    damage: 2.0, range: 4200, cooldown: 4,
    rarity: 'rare', icon: '⚡', tier: 'mk3'
  },

  // === BLASTER/CANNON WEAPONS ===
  'cannon_mk1': {
    name: 'Blaster Mk1', slot: 'weapon', weaponType: 'cannon',
    damage: 1.0, speed: 192, cooldown: 10,
    rarity: 'common', icon: '💥', tier: 'mk1'
  },
  'cannon_mk2': {
    name: 'Blaster Mk2', slot: 'weapon', weaponType: 'cannon',
    damage: 1.5, speed: 228, cooldown: 8,
    rarity: 'uncommon', icon: '💥', tier: 'mk2'
  },
  'cannon_mk3': {
    name: 'Blaster Mk3', slot: 'weapon', weaponType: 'cannon',
    damage: 2.0, speed: 264, cooldown: 6,
    rarity: 'rare', icon: '💥', tier: 'mk3'
  },

  // === MINING WEAPONS ===
  'mining_mk1': {
    name: 'Mining Shot Mk1', slot: 'weapon', weaponType: 'mining',
    damage: 100.0, speed: 22, cooldown: 280,
    rarity: 'common', icon: '⛏️', tier: 'mk1'
  },
  'mining_mk2': {
    name: 'Mining Shot Mk2', slot: 'weapon', weaponType: 'mining',
    damage: 140.0, speed: 24, cooldown: 240,
    rarity: 'uncommon', icon: '⛏️', tier: 'mk2'
  },
  'mining_mk3': {
    name: 'Mining Shot Mk3', slot: 'weapon', weaponType: 'mining',
    damage: 180.0, speed: 26, cooldown: 200,
    rarity: 'rare', icon: '⛏️', tier: 'mk3'
  },

  // === MISSILE WEAPONS ===
  'missile_mk1': {
    name: 'Missile Shot Mk1', slot: 'weapon', weaponType: 'missile',
    damage: 1.2, speed: 18, cooldown: 45,
    rarity: 'common', icon: '🧨', tier: 'mk1'
  },
  'missile_mk2': {
    name: 'Missile Shot Mk2', slot: 'weapon', weaponType: 'missile',
    damage: 1.5, speed: 20, cooldown: 40,
    rarity: 'uncommon', icon: '🧨', tier: 'mk2'
  },
  'missile_mk3': {
    name: 'Missile Shot Mk3', slot: 'weapon', weaponType: 'missile',
    damage: 2.0, speed: 22, cooldown: 36,
    rarity: 'rare', icon: '🧨', tier: 'mk3'
  },

  // === SCATTER WEAPONS ===
  'scatter_mk1': {
    name: 'Scattershot Mk1', slot: 'weapon', weaponType: 'scatter',
    damage: 1.98, speed: 139, cooldown: 22,
    rarity: 'common', icon: '🌀', tier: 'mk1'
  },
  'scatter_mk2': {
    name: 'Scattershot Mk2', slot: 'weapon', weaponType: 'scatter',
    damage: 2.64, speed: 157, cooldown: 22,
    rarity: 'uncommon', icon: '🌀', tier: 'mk2'
  },
  'scatter_mk3': {
    name: 'Scattershot Mk3', slot: 'weapon', weaponType: 'scatter',
    damage: 3.51, speed: 177, cooldown: 22,
    rarity: 'rare', icon: '🌀', tier: 'mk3'
  },

  // === PULSE WEAPONS ===
  'pulse_mk1': {
    name: 'Pulse Blaster Mk1', slot: 'weapon', weaponType: 'pulse',
    damage: 1.35, speed: 42, cooldown: 28,
    rarity: 'common', icon: '💠', tier: 'mk1'
  },
  'pulse_mk2': {
    name: 'Pulse Blaster Mk2', slot: 'weapon', weaponType: 'pulse',
    damage: 1.65, speed: 46, cooldown: 24,
    rarity: 'uncommon', icon: '💠', tier: 'mk2'
  },
  'pulse_mk3': {
    name: 'Pulse Blaster Mk3', slot: 'weapon', weaponType: 'pulse',
    damage: 2.05, speed: 50, cooldown: 20,
    rarity: 'rare', icon: '💠', tier: 'mk3'
  },

  // === MINE WEAPONS ===
  'mine_mk1': {
    name: 'Mine Shot Mk1', slot: 'weapon', weaponType: 'mine',
    damage: 150, cooldown: 120,
    rarity: 'common', icon: '💣', tier: 'mk1'
  },
  'mine_mk2': {
    name: 'Mine Shot Mk2', slot: 'weapon', weaponType: 'mine',
    damage: 200, cooldown: 100,
    rarity: 'uncommon', icon: '💣', tier: 'mk2'
  },
  'mine_mk3': {
    name: 'Mine Shot Mk3', slot: 'weapon', weaponType: 'mine',
    damage: 300, cooldown: 80,
    rarity: 'rare', icon: '💣', tier: 'mk3'
  },

  // === EQUIPMENT ===
  'booster_mk1': { name: 'Booster Mk1', slot: 'booster', fuelBonus: 0, regenBonus: 0, rarity: 'common', icon: '🚀', tier: 'mk1' },
  'booster_mk2': { name: 'Booster Mk2', slot: 'booster', fuelBonus: 25, regenBonus: 0.1, rarity: 'uncommon', icon: '🚀', tier: 'mk2' },
  'booster_mk3': { name: 'Booster Mk3', slot: 'booster', fuelBonus: 50, regenBonus: 0.2, rarity: 'rare', icon: '🚀', tier: 'mk3' },
  
  'cockpit_mk1': { name: 'Cockpit Mk1', slot: 'cockpit', turnBonus: 0, accelBonus: 0, rarity: 'common', icon: '🛸', tier: 'mk1' },
  'cockpit_mk2': { name: 'Cockpit Mk2', slot: 'cockpit', turnBonus: 0.02, accelBonus: 0.05, rarity: 'uncommon', icon: '🛸', tier: 'mk2' },
  'cockpit_mk3': { name: 'Cockpit Mk3', slot: 'cockpit', turnBonus: 0.04, accelBonus: 0.1, rarity: 'rare', icon: '🛸', tier: 'mk3' },

  // === QUEST ITEMS ===
  'ice_sample': {
    name: 'Ice Sample', slot: 'quest', questItem: true,
    rarity: 'quest', icon: '❄️',
    description: 'A frozen sample of exotic ice from Borealis.'
  },

  // === LEGENDARY WEAPONS ===
  'warp_gun': {
    name: 'Warp Gun', slot: 'weapon', weaponType: 'warp',
    damage: 0, cooldown: 180,
    rarity: 'legendary', icon: '🌀',
    description: 'Fires a warp field that launches enemies.'
  }
}
```

### Item Instance Structure
```javascript
{
  id: string,      // Unique instance ID
  type: string,    // Key into ITEM_TYPES
  hue: number      // Random 0-360 for visual variation
}
```

---

## 4. WEAPONS & COMBAT

### Blaster/Cannon System
```javascript
BULLET_SPEED = 64            // Base projectile speed (item speed is multiplier)
BULLET_DAMAGE = 14           // Base damage
FIRE_COOLDOWN_TICKS = 10     // Default cooldown
BLASTER_LIFE_TICKS = 180     // 3 seconds max lifetime

// Projectile structure
{
  id, ownerId, type: 'bullet',
  x, y, vx, vy,
  life: BLASTER_LIFE_TICKS,
  damage, hue, tier,
  scatter: boolean,
  size: number,
  friction: number (if scatter)
}
```

### Laser System
```javascript
LASER_RANGE = 3000           // Base range (item range modifies)
LASER_DAMAGE_MAX = 600       // Max damage at point-blank
LASER_TICK_COOLDOWN = 6      // Ticks between damage application

// Laser state per weapon slot
{
  active: boolean,
  hitX, hitY: number,        // Hit point world coordinates
  aimAngle: number,
  alpha: number,             // Fade based on distance
  hue: number,               // Weapon-specific color
  powerTime: number,         // Ramp-up counter for visuals
  prevStartX, prevStartY,    // For swept collision detection
  prevEndX, prevEndY
}

// Continuous damage formula
dmg = (laserDamage / 10) * fade  // Per-tick damage
fade = Math.max(0, 1 - dist / laserRange)
```

### Missile System
```javascript
MISSILE_SPEED = 18           // Base speed
MISSILE_FUEL_TICKS = 360     // 6 seconds of fuel
MISSILE_CHARGE_TICKS = 20    // Ticks to charge one missile
MISSILE_MAX_CHARGE = 3       // Max missiles per shot (mk3 = 8)
MISSILE_TURN_RATE = 4.2      // Radians/tick turning
MISSILE_ACCEL = 0.032        // Acceleration rate
MISSILE_DAMPING = 0.999      // Velocity damping
MISSILE_TARGET_CONE_DEG = 30 // Homing cone angle
MISSILE_TARGET_RANGE = 1200  // Homing acquisition range

// Speed wobble for organic feel
MISSILE_SPEED_WOBBLE_AMPL = 0.06
MISSILE_SPEED_WOBBLE_RATE = 0.12

// Missile projectile
{
  type: 'missile',
  speedBase, speedMax, speedAccel,
  speedWobblePhase, speedWobbleRate, speedWobbleAmp,
  aimTicks, aimAngle,        // Initial aim-lock period
  targetId,                  // Homing target asteroid ID
  fuelMax: MISSILE_FUEL_TICKS,
  clientSimulated: true      // Client predicts movement
}
```

### Scatter Shot System
```javascript
SCATTER_LIFE_TICKS = 60      // 1 second lifetime
SCATTER_STOP_SPEED = 0.35    // Fade out when below this speed
SCATTER_STOP_FADE_SECONDS = 0.2

// Scatter spawns multiple smaller projectiles in a cone
{
  type: 'bullet',
  scatter: true,
  friction: 0.94,            // Quick slowdown
  size: 0.3-0.7              // Variable small sizes
}
```

### Pulse System
```javascript
PULSE_CHARGE_TICKS = 180     // 3 seconds to fully charge
PULSE_COOLDOWN_TICKS = 180   // 3 seconds between shots
PULSE_SPLASH_RADIUS = 220    // AOE splash radius
PULSE_SPLASH_FALLOFF = 1.5   // Damage falloff exponent

// Charge affects size: hold longer = bigger pulse
// Size multiplier: tier 1 = 2x, tier 2 = 2.5x, tier 3 = 3x max
baseRadius = 5
maxRadius = baseRadius * maxMultiplier
radius = baseRadius + (maxRadius - baseRadius) * chargeRatio

// Visual grow animation: 0.5s to reach full size
PULSE_GROW_TIME = 0.5
```

### Mine System
```javascript
MINE_CHARGE_TICKS = 180      // 3 seconds to fully charge
MINE_COOLDOWN_TICKS = 120    // 2 seconds between deploys
MINE_LIFE_TICKS = 1800       // 30 seconds lifetime
MINE_ARM_TICKS = 60          // 1 second to arm after deploy
MINE_SPLASH_RADIUS = 400     // Explosion radius
MINE_SPLASH_FALLOFF = 2.0    // Damage falloff exponent
MAX_MINES_PER_SLOT = 3       // Max deployed mines

// Short click (< 15 ticks) = detonate existing mines
// Long hold = deploy new mine
// Timeout explosion = 30% damage
```

### Warp Gun System
```javascript
WARP_PROJECTILE_SPEED = 35
WARP_ACTIVATION_TICKS = 60   // 1 second to activate after firing
WARP_LAUNCH_SPEED = 800      // Speed applied to caught players
WARP_BOOST_END_SPEED = 25    // Threshold to end warp boost effect

// Fires 3 projectiles forming a triangle
// Main projectile + 2 vertices at ±30° offset
// Triangle checks if players are inside
// On hit: launches player in firing direction
```

### Mining System
```javascript
MINING_SPEED = 22            // Slow projectile
MINING_DOT_TICKS = 1200      // 20 seconds of DoT
MINING_DOT_INTERVAL = 30     // Tick between damage ticks
MINING_DOT_DAMAGE_FACTOR = 0.5

// On hit: converts to 'mining_stuck' that attaches to asteroid
// Deals periodic damage until asteroid destroyed or DoT expires
{
  type: 'mining_stuck',
  asteroidId, offsetX, offsetY,  // Attachment point
  damagePerTick, nextDamageTick
}
```

---

## 5. NPC SYSTEM

### NPC Definition
```javascript
NPCS = {
  'dr_vance': {
    id: 'dr_vance',
    name: 'Dr. Elena Vance',
    title: 'Exogeologist',
    systemId: 'sol',           // Spawns in Sol system
    orbitRadius: 5500,         // Distance from star
    orbitSpeed: 0.0002,        // Radians per tick
    orbitPhase: Math.PI/4,     // Starting angle
    interactRadius: 500,       // Interaction distance
    questsOffered: ['ice_sample_delivery'],
    dialogue: {
      greeting: "Hello, pilot. I'm Dr. Elena Vance...",
      questOffer: "I'm studying the crystalline ice formations...",
      questAccept: "Excellent! I've marked the Borealis system...",
      questProgress: "Any luck finding those ice crystals?",
      questComplete: "Remarkable! These samples show unique...",
      noQuest: "Thank you for your help, pilot."
    }
  }
}

// NPC state at runtime
{
  ...definition,
  x, y: number,              // Current position
  angle: number              // Facing direction
}

// NPC position calculation (orbiting)
angle = orbitPhase + orbitSpeed * tick
x = systemCenter.x + cos(angle) * orbitRadius
y = systemCenter.y + sin(angle) * orbitRadius
```

### NPC Interaction Flow
1. Player approaches within `interactRadius` (500 units)
2. UI shows "[E] Talk" prompt
3. Press E sends `interactNPC` message
4. Server checks quest state and returns dialogue
5. If quest available, shows accept button
6. `acceptQuest` message starts quest

---

## 6. ENEMY SYSTEM (Ice Sprites)

### Ice Sprite Configuration
```javascript
ICE_SPRITE_HP = 40
ICE_SPRITE_DAMAGE = 5
ICE_SPRITE_XP = 20           // XP granted on kill
ICE_SPRITE_SPEED = 2.5
ICE_SPRITE_ATTACK_RANGE = 600
ICE_SPRITE_ATTACK_COOLDOWN = 90  // 1.5 seconds
ICE_SPRITE_PROJECTILE_SPEED = 8

// Spawner settings
ICE_SPRITE_SPAWN_SYSTEM = 'borealis'
ICE_SPRITE_MAX_COUNT = 12
ICE_SPRITE_SPAWN_INTERVAL = 180  // 3 seconds
ICE_SPRITE_SPAWN_RADIUS_MIN = 40000
ICE_SPRITE_SPAWN_RADIUS_MAX = 70000
```

### Behavior Types
```javascript
behaviorTypes = ['aggressive', 'flanker', 'sniper', 'swarm']

// Aggressive: Direct approach, close combat
// Flanker: Circles around, attacks from sides
// Sniper: Maintains distance, long-range attacks  
// Swarm: Groups together, coordinated attacks
```

### Enemy State Structure
```javascript
{
  id: string,
  type: 'ice_sprite',
  x, y: number,
  vx, vy: number,
  angle: number,
  hp, maxHp: number,
  behavior: behaviorType,
  targetPlayerId: string,
  attackCooldown: number,
  lastDamagedBy: string,     // Player ID for kill credit
  systemId: string
}
```

### Enemy Projectile
```javascript
{
  id: string,
  type: 'ice_bolt',
  x, y, vx, vy,
  damage: ICE_SPRITE_DAMAGE,
  ownerId: enemyId,
  spawnTick: number,         // For client interpolation
  spawnX, spawnY             // Original spawn position
}
```

---

## 7. QUEST SYSTEM

### Quest Definition
```javascript
QUESTS = {
  'ice_sample_delivery': {
    id: 'ice_sample_delivery',
    name: 'Crystalline Research',
    description: 'Dr. Vance needs ice samples from Borealis...',
    giver: 'dr_vance',
    stages: [
      {
        type: 'reach_system',
        systemId: 'borealis',
        description: 'Travel to the Borealis system'
      },
      {
        type: 'mine_asteroid',
        asteroidType: 'crystal',
        systemId: 'borealis',
        count: 1,
        description: 'Mine an ice crystal'
      },
      {
        type: 'talk_to_npc',
        npcId: 'dr_vance',
        description: 'Return to Dr. Vance with the sample'
      }
    ],
    rewards: {
      xp: 500,
      items: ['mining_mk2']
    }
  }
}
```

### Quest State Tracking
```javascript
player.quests = {
  active: {
    'ice_sample_delivery': {
      stage: 0,              // Current stage index
      progress: {}           // Stage-specific progress
    }
  },
  completed: ['quest_id', ...]
}
```

### Quest Objective Types
- `reach_system`: Enter a specific star system
- `mine_asteroid`: Destroy asteroids (optionally specific type)
- `talk_to_npc`: Interact with NPC to complete
- `collect_item`: Have item in inventory
- `kill_enemy`: Defeat specific enemy types

### Quest Progression Functions
```javascript
startQuest(player, questId)
checkQuestObjective(player, objectiveType, data)
completeQuestStage(player, questId)
grantQuestRewards(player, questId)
```

---

## 8. PHYSICS & COLLISION

### Orbital Mechanics (Asteroids)
```javascript
// Elliptical orbit parameters
asteroid = {
  orbitA, orbitB: number,    // Semi-major/minor axes
  angle0: number,            // Starting angle
  omega: number,             // Angular velocity
  ellipseAngle: number,      // Orbit rotation
  systemId: string
}

// Position calculation
function getAsteroidPos(a, tick) {
  const angle = a.angle0 + a.omega * tick;
  const ex = cos(angle) * a.orbitA;
  const ey = sin(angle) * a.orbitB;
  
  // Rotate by ellipse angle
  const cosR = cos(a.ellipseAngle);
  const sinR = sin(a.ellipseAngle);
  const orbitX = ex * cosR - ey * sinR;
  const orbitY = ex * sinR + ey * cosR;
  
  // Flow field wobble
  const t = tick * ASTEROID_FLOW_FIELD_RATE;
  const wave = sin(t + angle * ASTEROID_FLOW_FIELD_SPATIAL);
  const radialOffset = ASTEROID_FLOW_FIELD_AMPL * wave;
  
  return {
    x: systemCenter.x + orbitX + offsetX,
    y: systemCenter.y + orbitY + offsetY
  };
}

// Constants
ASTEROID_FLOW_FIELD_AMPL = 14
ASTEROID_FLOW_FIELD_RATE = 0.0014
ASTEROID_FLOW_FIELD_SPATIAL = 1.6
```

### Collision Detection
```javascript
// Spatial partitioning grid
CHUNK_SIZE = 500
HIT_PADDING = 6

// Functions
clearSpatialGrid()
addToSpatialGrid(entity, x, y, radius)
getEntitiesInChunks(x1, y1, x2, y2, padding)

// Polygon collision for asteroids
getAsteroidPolygon(asteroid, tick)  // Returns vertex array
pointInPolygon(x, y, polygon)
segmentIntersectT(x1,y1, x2,y2, x3,y3, x4,y4)  // Returns t or null

// For lasers: swept collision using quad from prev to current ray
```

### Flow Field (Particles)
```javascript
fieldSeed = random() * 1000
fieldScale = 0.0018
fieldTimeScale = 0.12

// Perlin-like noise for particle movement
fx = x * fieldScale + fieldSeed;
fy = y * fieldScale + fieldSeed * 1.37;
angle1 = sin(fx * 1.7 + t * 0.9) * cos(fy * 1.3 - t * 0.7);
angle2 = sin(fy * 1.1 - t * 1.4) * cos(fx * 1.9 + t * 0.5);
flowAngle = angle1 * PI + angle2 * PI * 0.5;
```

---

## 9. INVENTORY & BANKING

### Inventory Slots
- Player Inventory: 10 slots (indices 0-9)
- Equipment: 4 slots (leftWeapon, rightWeapon, booster, cockpit)
- Item Bank: 50 slots (accessed at space stations)

### Drag & Drop Operations
```javascript
// Message: inventoryMove
{
  type: 'inventoryMove',
  fromType: 'inventory' | 'equipment',
  fromSlot: number | string,
  toType: 'inventory' | 'equipment',
  toSlot: number | string
}

// Validation: equipment slots only accept matching item types
// Weapons go to leftWeapon/rightWeapon
// Boosters go to booster slot only
// Cockpits go to cockpit slot only
```

### Item Pickup
```javascript
TRACTOR_PICKUP_RANGE = 300   // Must be within this distance
// Shift+Click on world item triggers pickup request
// Server validates range, adds to inventory if space available
// Visual: tractor beam animation pulls item to ship
TRACTOR_BEAM_DURATION = 300  // ms for animation
```

### World Item Drops
```javascript
ITEM_LIFETIME_TICKS = 3600   // 60 seconds
ITEM_FRICTION = 0.92

// Item spawns from asteroid destruction with random velocity
// Drifts and slows due to friction
// Despawns after lifetime expires
```

---

## 10. STAR SYSTEMS

### System Definitions
```javascript
SYSTEMS = [
  {
    id: 'sol',
    name: 'Sol',
    x: 0, y: 0,
    hue: 38,                  // Star color
    starRadius: 1000,
    eventHorizon: 800,
    asteroidConfig: {
      mainBand: { minRadius: 20000, maxRadius: 22000, count: 180 },
      outerBand: { minRadius: 60000, maxRadius: 66000, count: 80 }
    }
  },
  {
    id: 'borealis',
    name: 'Borealis',
    x: 300000, y: 150000,     // Offset from Sol
    hue: 180,                 // Cyan star
    starRadius: 800,
    eventHorizon: 600,
    binaryStars: true,        // Has two stars
    secondaryOffset: { x: 3000, y: 0 },
    hasAurora: true,          // Visual effect
    asteroidConfig: {
      mainBand: { minRadius: 18000, maxRadius: 20000, count: 120 },
      crystalBand: { minRadius: 45000, maxRadius: 55000, count: 60, type: 'crystal' }
    }
  }
]
```

### Ice Crystals (Borealis)
```javascript
// Special asteroid type in Borealis
{
  type: 'crystal',
  radiusSize: 25-45,
  hue: 190,                  // Light blue
  health: 80-120
}

// Visual: hexagonal faceted shape with pulsing glow
// Mining yields 'ice_sample' quest item
```

### System Visibility
```javascript
// Players only receive data for nearby systems
SYSTEM_VISIBILITY_RADIUS = 100000

getVisibleSystemsForPos(x, y) {
  return SYSTEMS.filter(s => 
    hypot(x - s.x, y - s.y) < SYSTEM_VISIBILITY_RADIUS
  );
}
```

---

## 11. SPACE STATIONS

### Station Definition
```javascript
SPACE_STATIONS = [
  {
    id: 'station_sol',
    name: 'Sol Station Alpha',
    systemId: 'sol',
    orbitRadius: 4500,
    orbitSpeed: 0.0003,       // Radians per tick
    orbitPhase: 0,
    interactRadius: 800,      // Distance for "E to Enter"
    size: 540                 // Visual size
  }
]
```

### Station Features
- Item Bank access (50 slots)
- View inventory
- Transfer items between inventory and bank
- Safe zone (no combat while docked)

### Docking Flow
1. Approach within `interactRadius`
2. "Press E to Enter Station" prompt appears
3. Press E sends `enterStation` message
4. Server sets `player.dockedAtStation = true`
5. Client shows station UI
6. Press "Leave Station" to undock

---

## 12. VISUAL EFFECTS

### Projectile Trails
```javascript
// Bullet trail: gradient from tail to head
const grad = ctx.createLinearGradient(tail.x, tail.y, head.x, head.y);
grad.addColorStop(0, `hsla(${hue}, 100%, 75%, 0)`);
grad.addColorStop(0.35, `hsla(${hue}, 100%, 82%, ${alpha * 0.45})`);
grad.addColorStop(1, `hsla(${hue}, 100%, 88%, ${alpha})`);

// Missile trail: multi-point with wobble
const wobble = sin(time * 6 + pt.x * 0.02) * 2.2;

// Pulse trail: size scales with charge level
```

### Engine Effects
```javascript
// Booster tiers affect particle visuals
mk1: orange/yellow flame, player color tint
mk2: hot blue flame, player color tint  
mk3: plasma exhaust (cyan/white), electric arcs

// Particle spawning
spawnEngineParticle(player, isBoosting, boosterTier)
MAX_ENGINE_PARTICLES = 500
```

### Impact Sparks & Fragments
```javascript
// HitFragment class for projectile impacts
{
  x, y, vx, vy,
  hue, size,
  trail: [{x,y}, ...],
  life, maxLife: 50-70 frames
}

// Spawn on collision
spawnHitFragments(hit)  // 3 normal, 30 for pulse
```

### Laser Visuals
```javascript
// Multi-layer laser beam
// 1. Winding helix around beam
// 2. Outer glow layer
// 3. Mid glow layer  
// 4. Core beam (bright white with hue tint)
// 5. Electric crackle effect
// 6. Impact shockwave rings
// 7. Spark lines radiating from hit point
```

### Asteroid Destruction
```javascript
// Debris particle system
spawnNetDebrisParticles(breakEvent)
// 28-52 particles per asteroid
// Particles orbit the star, have trails
// 900-1500 tick lifetime
```

### Warp Triangle Effect
```javascript
// Black fill with glowing red edges
// Gradient bands from edges inward (25% inset)
// Edge particles spawn along activated edges
// Explosion particles on player capture
```

### Tractor Beam
```javascript
// Beam line from ship to item
// Item lerps toward ship with easeOutCubic
// Item shrinks as it approaches
// Duration: 300ms
```

---

## 13. UI SYSTEM

### HUD Elements
- HP Bar: `100/100` with fill bar
- XP Bar: Level display + progress bar with tick marks
- Weapon Charge Bars: Left/Right weapon cooldown/charge
- Zoom Indicator: Current zoom level with bar
- FPS Counter: Debug display (optional)

### Panels
- Login Panel: Email/password, signup flow
- Server Browser: Server list with ping/player count
- Options Panel: Volume sliders, settings
- Inventory Panel: 10 slot grid
- Equipment Panel: 4 equipment slots (LMB, RMB, Boost, Cockpit)
- Station UI: Item bank + inventory grids
- Quest Journal: Active quests with progress
- Admin Panel: Item spawning, XP granting, teleport (admin only)
- Chat: Message log + input

### Tooltips
```javascript
// Item tooltip shows:
- Name
- Type (weapon/equipment)
- Damage, Speed, Cooldown (weapons)
- Bonuses (equipment)
- Rarity color coding
```

### Level Up Animation
```javascript
// "LEVEL UP!" text with glow
// Choice cards for stat upgrades (if applicable)
```

---

## 14. AUDIO SYSTEM

### 3D Spatial Audio
```javascript
AudioSystem = {
  maxDistance: 8000,         // Inaudible beyond this
  refDistance: 500,          // Full volume at this distance
  
  // Volume falloff
  calcVolumeForDistance(dist) {
    if (dist <= refDistance) return 1.0;
    if (dist >= maxDistance) return 0.0;
    const normalized = (dist - refDistance) / (maxDistance - refDistance);
    return Math.max(0, 1 - Math.pow(normalized, 0.5));
  },
  
  // Stereo panning based on relative position to player
  calcPan(worldX, worldY) {
    const relativeAngle = soundAngle - playerAngle;
    return Math.sin(relativeAngle) * 0.8;
  }
}
```

### Sound Effects
- `blaster.mp3`: Cannon/blaster fire
- (Additional sounds to be added)

### Options
- Music Volume: 0-100
- SFX Volume: 0-100

---

## 15. NETWORKING

### Message Types (Client → Server)
```javascript
'hello'         // Initial auth + join
'input'         // Single input frame
'inputBatch'    // Multiple input frames
'ping'          // Latency measurement
'chat'          // Chat message
'setName'       // (Disabled - permanent usernames)
'interactNPC'   // Talk to NPC
'acceptQuest'   // Accept quest from NPC
'inventoryMove' // Move items between slots
'enterStation'  // Dock at station
'leaveStation'  // Undock from station
'requestPickup' // Pick up world item
'adminSpawnItem', 'adminGiveItem', 'adminGiveXP', etc.  // Admin commands
```

### Message Types (Server → Client)
```javascript
'init'          // Initial game state
'snapshot'      // Periodic world state
'join'          // Player joined
'leave'         // Player left
'chat'          // Chat message
'pong'          // Ping response
'inventory'     // Inventory update
'xpGain'        // XP gained notification
'levelUp'       // Level up notification
'questUpdate'   // Quest progress change
'questStarted'  // New quest accepted
'npcDialogue'   // NPC dialogue response
'hit'           // Projectile hit events
'asteroidBreak' // Asteroid destroyed
'itemSpawned'   // Item dropped in world
'itemPickup'    // Item picked up
'systemEnter'   // Entered new system
'enemySpawn'    // Enemy NPC spawned
'enemyHit'      // Enemy took damage
'enemyDeath'    // Enemy killed
```

### Serialization
```javascript
// Using msgpack-lite for binary encoding
const msgpack = require('msgpack-lite');
ws.send(msgpack.encode(message));

// JSON fallback for some messages
ws.send(JSON.stringify(message));
```

### Snapshot Structure
```javascript
{
  type: 'snapshot',
  tick: number,
  players: [{id, x, y, vx, vy, angle, boostFuel, ...}],
  asteroids: [{id, health}],  // Only changed asteroids
  projectiles: [...],
  flowParticles: [...],
  enemies: [...],
  enemyProjectiles: [...],
  hits: [...],
  breaks: [...]
}
```

---

## 16. PERSISTENCE (Supabase)

### Auth Flow
1. Client sends email/password to server
2. Server validates with Supabase Auth
3. On success, returns JWT tokens
4. Client stores tokens, sends with WebSocket `hello`

### Saved Data
```javascript
player_data table: {
  user_id: uuid,
  username: string,
  inventory: json,
  equipment: json,
  item_bank: json,
  level: integer,
  xp: integer,
  quests: json,
  last_x, last_y: float,
  created_at, updated_at: timestamp
}

profiles table: {
  id: uuid,
  username: string,
  created_at: timestamp
}
```

### Save Triggers
- Inventory change
- Equipment change
- Level up
- Quest progress
- Periodic autosave (every 60 seconds)
- On disconnect

---

## MIGRATION CHECKLIST

### Phase 1: Core Systems
- [ ] World configuration (sizes, constants)
- [ ] Tick/snapshot timing
- [ ] Player movement physics
- [ ] Camera system
- [ ] Spatial partitioning

### Phase 2: Combat
- [ ] Projectile base class
- [ ] Blaster weapon
- [ ] Laser weapon
- [ ] Missile weapon
- [ ] Scatter weapon
- [ ] Pulse weapon
- [ ] Mine weapon
- [ ] Warp weapon
- [ ] Collision detection
- [ ] Damage system

### Phase 3: World
- [ ] Multi-system support
- [ ] Asteroid generation
- [ ] Asteroid orbits
- [ ] Ice crystals
- [ ] Space stations
- [ ] Flow particles

### Phase 4: Entities
- [ ] NPC system
- [ ] Enemy spawner
- [ ] Enemy AI (4 behavior types)
- [ ] Enemy projectiles

### Phase 5: Progression
- [ ] Items & equipment
- [ ] Inventory management
- [ ] Item banking
- [ ] Quest system
- [ ] XP & leveling

### Phase 6: Visual
- [ ] Ship rendering
- [ ] Projectile trails
- [ ] Engine particles
- [ ] Impact effects
- [ ] Laser effects
- [ ] Warp effects
- [ ] Asteroid visuals
- [ ] HUD elements

### Phase 7: Infrastructure
- [ ] WebSocket networking
- [ ] Input prediction
- [ ] State interpolation
- [ ] Auth integration
- [ ] Data persistence
- [ ] Admin tools
