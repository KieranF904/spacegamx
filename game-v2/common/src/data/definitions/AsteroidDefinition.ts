/**
 * Asteroid Definition - Data-driven asteroid configuration
 */

export interface AsteroidDefinition {
  id: string;
  name: string;
  tier: number;
  
  // === Size Configuration ===
  size: AsteroidSizeConfig;
  
  // === Health & Mining ===
  healthPerUnit: number;      // Health multiplier per size unit
  miningMultiplier: number;   // Mining damage multiplier
  
  // === Resources ===
  resources: AsteroidResourceConfig;
  
  // === Physics ===
  physics: AsteroidPhysicsConfig;
  
  // === Spawning ===
  spawn?: AsteroidSpawnConfig;
  
  // === Visual ===
  visualType: string;
  hue?: number;
  saturation?: number;
}

export interface AsteroidSizeConfig {
  min: number;
  max: number;
  healthScale: 'linear' | 'quadratic' | 'cubic';
}

export interface AsteroidResourceConfig {
  primary: ResourceYield;
  secondary?: ResourceYield;
  bonus?: BonusResourceConfig;
}

export interface ResourceYield {
  type: 'ice' | 'metal' | 'crystal' | 'fuel' | 'rare';
  minPerSize: number;
  maxPerSize: number;
}

export interface BonusResourceConfig {
  type: string;
  chance: number;
  min: number;
  max: number;
}

export interface AsteroidPhysicsConfig {
  massPerUnit: number;
  rotationSpeed: { min: number; max: number };
  
  // Orbit configuration (if orbiting)
  orbit?: OrbitConfig;
  
  // Drift configuration (if drifting)
  drift?: DriftConfig;
}

export interface OrbitConfig {
  enabled: boolean;
  radiusMin: number;
  radiusMax: number;
  speedMin: number;
  speedMax: number;
  center?: { x: number; y: number };
}

export interface DriftConfig {
  enabled: boolean;
  speedMin: number;
  speedMax: number;
  directionVariance: number;  // Radians
}

export interface AsteroidSpawnConfig {
  weight: number;             // Spawn weight in asteroid field
  minDistance: number;        // Min distance from player spawn
  clusterSize?: { min: number; max: number };
  clusterSpread?: number;
}

// === Default asteroid definitions ===
export const DEFAULT_ASTEROIDS: AsteroidDefinition[] = [
  // ICE ASTEROID
  {
    id: 'asteroid_ice',
    name: 'Ice Asteroid',
    tier: 1,
    size: {
      min: 30,
      max: 100,
      healthScale: 'quadratic',
    },
    healthPerUnit: 50,
    miningMultiplier: 1.0,
    resources: {
      primary: { type: 'ice', minPerSize: 0.5, maxPerSize: 1.0 },
      bonus: { type: 'crystal', chance: 0.05, min: 1, max: 3 },
    },
    physics: {
      massPerUnit: 2.0,
      rotationSpeed: { min: -0.01, max: 0.01 },
      orbit: {
        enabled: true,
        radiusMin: 2000,
        radiusMax: 8000,
        speedMin: 0.0001,
        speedMax: 0.0008,
      },
    },
    spawn: {
      weight: 40,
      minDistance: 500,
      clusterSize: { min: 3, max: 8 },
      clusterSpread: 300,
    },
    visualType: 'ice',
    hue: 190,
    saturation: 0.3,
  },

  // METAL ASTEROID
  {
    id: 'asteroid_metal',
    name: 'Metal Asteroid',
    tier: 2,
    size: {
      min: 25,
      max: 80,
      healthScale: 'quadratic',
    },
    healthPerUnit: 80,
    miningMultiplier: 0.7,
    resources: {
      primary: { type: 'metal', minPerSize: 0.3, maxPerSize: 0.7 },
      secondary: { type: 'fuel', minPerSize: 0.1, maxPerSize: 0.3 },
      bonus: { type: 'rare_metal', chance: 0.08, min: 1, max: 2 },
    },
    physics: {
      massPerUnit: 4.0,
      rotationSpeed: { min: -0.005, max: 0.005 },
      orbit: {
        enabled: true,
        radiusMin: 3000,
        radiusMax: 10000,
        speedMin: 0.0001,
        speedMax: 0.0005,
      },
    },
    spawn: {
      weight: 30,
      minDistance: 1000,
      clusterSize: { min: 2, max: 5 },
      clusterSpread: 250,
    },
    visualType: 'metal',
    hue: 30,
    saturation: 0.2,
  },

  // CRYSTAL ASTEROID
  {
    id: 'asteroid_crystal',
    name: 'Crystal Asteroid',
    tier: 3,
    size: {
      min: 20,
      max: 60,
      healthScale: 'linear',
    },
    healthPerUnit: 120,
    miningMultiplier: 0.5,
    resources: {
      primary: { type: 'crystal', minPerSize: 0.2, maxPerSize: 0.5 },
      bonus: { type: 'energy_crystal', chance: 0.1, min: 1, max: 2 },
    },
    physics: {
      massPerUnit: 3.0,
      rotationSpeed: { min: -0.008, max: 0.008 },
      orbit: {
        enabled: true,
        radiusMin: 4000,
        radiusMax: 12000,
        speedMin: 0.00005,
        speedMax: 0.0003,
      },
    },
    spawn: {
      weight: 15,
      minDistance: 2000,
      clusterSize: { min: 1, max: 3 },
      clusterSpread: 200,
    },
    visualType: 'crystal',
    hue: 280,
    saturation: 0.5,
  },

  // FUEL ASTEROID (rare)
  {
    id: 'asteroid_fuel',
    name: 'Fuel Deposit',
    tier: 2,
    size: {
      min: 35,
      max: 70,
      healthScale: 'linear',
    },
    healthPerUnit: 40,
    miningMultiplier: 1.5,
    resources: {
      primary: { type: 'fuel', minPerSize: 0.8, maxPerSize: 1.5 },
    },
    physics: {
      massPerUnit: 1.5,
      rotationSpeed: { min: -0.015, max: 0.015 },
      orbit: {
        enabled: true,
        radiusMin: 2500,
        radiusMax: 7000,
        speedMin: 0.0002,
        speedMax: 0.001,
      },
    },
    spawn: {
      weight: 10,
      minDistance: 1500,
      clusterSize: { min: 1, max: 2 },
      clusterSpread: 150,
    },
    visualType: 'fuel',
    hue: 60,
    saturation: 0.6,
  },

  // MEGA ASTEROID (boss-like)
  {
    id: 'asteroid_mega',
    name: 'Mega Asteroid',
    tier: 4,
    size: {
      min: 150,
      max: 300,
      healthScale: 'cubic',
    },
    healthPerUnit: 100,
    miningMultiplier: 0.4,
    resources: {
      primary: { type: 'metal', minPerSize: 0.4, maxPerSize: 0.8 },
      secondary: { type: 'crystal', minPerSize: 0.1, maxPerSize: 0.3 },
      bonus: { type: 'artifact', chance: 0.02, min: 1, max: 1 },
    },
    physics: {
      massPerUnit: 5.0,
      rotationSpeed: { min: -0.002, max: 0.002 },
      drift: {
        enabled: true,
        speedMin: 0.2,
        speedMax: 0.8,
        directionVariance: 0.5,
      },
    },
    spawn: {
      weight: 5,
      minDistance: 5000,
    },
    visualType: 'mega',
    hue: 20,
    saturation: 0.15,
  },

  // COMET (fast-moving)
  {
    id: 'comet',
    name: 'Comet',
    tier: 2,
    size: {
      min: 40,
      max: 80,
      healthScale: 'linear',
    },
    healthPerUnit: 30,
    miningMultiplier: 2.0,
    resources: {
      primary: { type: 'ice', minPerSize: 1.0, maxPerSize: 2.0 },
      secondary: { type: 'crystal', minPerSize: 0.2, maxPerSize: 0.5 },
    },
    physics: {
      massPerUnit: 1.0,
      rotationSpeed: { min: 0.02, max: 0.05 },
      drift: {
        enabled: true,
        speedMin: 3,
        speedMax: 8,
        directionVariance: 0.2,
      },
    },
    spawn: {
      weight: 3,
      minDistance: 3000,
    },
    visualType: 'comet',
    hue: 200,
    saturation: 0.4,
  },
];

// === Asteroid Field Configuration ===
export interface AsteroidFieldConfig {
  id: string;
  name: string;
  center: { x: number; y: number };
  radius: number;
  density: number;            // Asteroids per 1000x1000 area
  asteroidTypes: { id: string; weight: number }[];
  hazards?: FieldHazard[];
}

export interface FieldHazard {
  type: 'radiation' | 'gravity_well' | 'debris_storm' | 'solar_flare';
  intensity: number;
  radius?: number;
  center?: { x: number; y: number };
}

export const DEFAULT_ASTEROID_FIELDS: AsteroidFieldConfig[] = [
  // === System-specific fields ===
  
  // Sol System - balanced starter field
  {
    id: 'sol_belt',
    name: 'Sol Asteroid Belt',
    center: { x: 0, y: 0 },
    radius: 30000,
    density: 0.5,
    asteroidTypes: [
      { id: 'asteroid_ice', weight: 40 },
      { id: 'asteroid_metal', weight: 30 },
      { id: 'asteroid_fuel', weight: 20 },
      { id: 'asteroid_crystal', weight: 10 },
    ],
  },
  
  // Borealis System - ice dominated, cold hazards
  {
    id: 'borealis_belt',
    name: 'Frozen Expanse',
    center: { x: 0, y: 0 },
    radius: 38000,
    density: 0.4,
    asteroidTypes: [
      { id: 'asteroid_ice', weight: 60 },
      { id: 'comet', weight: 20 },
      { id: 'asteroid_crystal', weight: 15 },
      { id: 'asteroid_fuel', weight: 5 },
    ],
    hazards: [
      { type: 'debris_storm', intensity: 0.2 },
    ],
  },
  
  // Nebula Prime - rich resources, radiation hazard
  {
    id: 'nebula_belt',
    name: 'Nebula Mining Zone',
    center: { x: 0, y: 0 },
    radius: 40000,
    density: 0.7,
    asteroidTypes: [
      { id: 'asteroid_crystal', weight: 35 },
      { id: 'asteroid_metal', weight: 30 },
      { id: 'asteroid_mega', weight: 10 },
      { id: 'asteroid_fuel', weight: 15 },
      { id: 'asteroid_ice', weight: 10 },
    ],
    hazards: [
      { type: 'radiation', intensity: 0.3 },
    ],
  },
  
  // Void Sector - sparse, dangerous
  {
    id: 'void_belt',
    name: 'Void Debris Field',
    center: { x: 0, y: 0 },
    radius: 20000,
    density: 0.2,
    asteroidTypes: [
      { id: 'asteroid_crystal', weight: 40 },
      { id: 'asteroid_mega', weight: 25 },
      { id: 'asteroid_metal', weight: 25 },
      { id: 'comet', weight: 10 },
    ],
    hazards: [
      { type: 'gravity_well', intensity: 0.4, radius: 5000, center: { x: 0, y: 0 } },
    ],
  },
  
  // === Generic reusable fields ===
  
  {
    id: 'starter_field',
    name: 'Training Grounds',
    center: { x: 0, y: 0 },
    radius: 5000,
    density: 0.3,
    asteroidTypes: [
      { id: 'asteroid_ice', weight: 70 },
      { id: 'asteroid_fuel', weight: 20 },
      { id: 'asteroid_metal', weight: 10 },
    ],
  },
  {
    id: 'ice_belt',
    name: 'Frozen Belt',
    center: { x: 15000, y: 0 },
    radius: 8000,
    density: 0.5,
    asteroidTypes: [
      { id: 'asteroid_ice', weight: 80 },
      { id: 'comet', weight: 10 },
      { id: 'asteroid_crystal', weight: 10 },
    ],
    hazards: [
      { type: 'debris_storm', intensity: 0.3 },
    ],
  },
  {
    id: 'mining_sector',
    name: 'Mining Sector Alpha',
    center: { x: -10000, y: 10000 },
    radius: 6000,
    density: 0.6,
    asteroidTypes: [
      { id: 'asteroid_metal', weight: 50 },
      { id: 'asteroid_crystal', weight: 30 },
      { id: 'asteroid_mega', weight: 5 },
      { id: 'asteroid_fuel', weight: 15 },
    ],
    hazards: [
      { type: 'radiation', intensity: 0.2, radius: 2000, center: { x: -10000, y: 10000 } },
    ],
  },
];
