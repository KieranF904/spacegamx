import { AsteroidBeltData } from '../data/schemas.js';
import { ASTEROID_ECC_CURVE, ASTEROID_ECC_MAX } from '../constants.js';
import { OrbitType } from './orbit.js';
import { hashString, mulberry32 } from './polygon.js';
import { asteroidRegistry } from '../data/registries/AsteroidRegistry.js';
import { AsteroidFieldConfig, AsteroidDefinition } from '../data/definitions/AsteroidDefinition.js';

export interface AsteroidParams {
  size: number;
  resourceType: number;
  orbitType: OrbitType;
  semiMajorAxis: number;
  eccentricity: number;
  argPeriapsis: number;
  meanAnomaly0: number;
  epochTick: number;
  wobblePhase: number;
  // New definition-based fields
  definitionId: string;
  healthPerUnit: number;
  miningMultiplier: number;
  visualType: string;
  hue: number;
  saturation: number;
}

/**
 * Resource type mapping for legacy compatibility
 */
const RESOURCE_TYPE_MAP: Record<string, number> = {
  'ice': 0,
  'metal': 1,
  'crystal': 2,
  'fuel': 3,
  'rare': 4,
};

/**
 * Pick asteroid definition from field using seeded RNG
 */
function pickAsteroidDefinition(
  field: AsteroidFieldConfig,
  rng: () => number
): AsteroidDefinition | null {
  const totalWeight = field.asteroidTypes.reduce((sum, t) => sum + t.weight, 0);
  let roll = rng() * totalWeight;
  
  for (const entry of field.asteroidTypes) {
    roll -= entry.weight;
    if (roll <= 0) {
      return asteroidRegistry.get(entry.id) ?? null;
    }
  }
  
  // Fallback
  const firstId = field.asteroidTypes[0]?.id;
  return firstId ? asteroidRegistry.get(firstId) ?? null : null;
}

/**
 * Generate asteroid parameters using definition-based system
 * Preserves deterministic orbital mechanics while using rich definitions
 */
export function makeAsteroidParamsFromField(
  systemId: string,
  index: number,
  seed: string,
  spawnTick: number,
  belt: AsteroidBeltData,
  field: AsteroidFieldConfig,
): AsteroidParams {
  const rng = mulberry32(hashString(`${seed}:${systemId}:${spawnTick}:${index}`));
  
  // Pick asteroid type from field weights (deterministic based on seed)
  const definition = pickAsteroidDefinition(field, rng);
  
  if (!definition) {
    // Fallback to legacy generation if no definition found
    return makeAsteroidParams(systemId, index, seed, spawnTick, belt);
  }
  
  // Orbital parameters (same as before - Keplerian mechanics)
  const orbitType = OrbitType.Elliptic;
  const eccentricity = ASTEROID_ECC_MAX * Math.pow(rng(), ASTEROID_ECC_CURVE);
  const minA = belt.innerRadius / (1 + eccentricity);
  const maxA = belt.outerRadius / (1 - eccentricity);
  const semiMajorAxis = minA + rng() * (maxA - minA);
  const argPeriapsis = rng() * Math.PI * 2;
  const meanAnomaly0 = rng() * Math.PI * 2;
  const epochTick = spawnTick;
  const wobblePhase = rng() * Math.PI * 2;
  
  // Size from definition range
  const size = definition.size.min + rng() * (definition.size.max - definition.size.min);
  
  // Resource type from definition's primary resource
  const resourceType = RESOURCE_TYPE_MAP[definition.resources.primary.type] ?? 0;

  return {
    size,
    resourceType,
    orbitType,
    semiMajorAxis,
    eccentricity,
    argPeriapsis,
    meanAnomaly0,
    epochTick,
    wobblePhase,
    // Definition-based fields
    definitionId: definition.id,
    healthPerUnit: definition.healthPerUnit,
    miningMultiplier: definition.miningMultiplier,
    visualType: definition.visualType,
    hue: definition.hue ?? 0,
    saturation: definition.saturation ?? 0.5,
  };
}

/**
 * Legacy asteroid params generation (fallback)
 */
export function makeAsteroidParams(
  systemId: string,
  index: number,
  seed: string,
  spawnTick: number,
  belt: AsteroidBeltData,
): AsteroidParams {
  const rng = mulberry32(hashString(`${seed}:${systemId}:${spawnTick}:${index}`));
  const orbitType = OrbitType.Elliptic;
  const eccentricity = ASTEROID_ECC_MAX * Math.pow(rng(), ASTEROID_ECC_CURVE);
  const minA = belt.innerRadius / (1 + eccentricity);
  const maxA = belt.outerRadius / (1 - eccentricity);
  const semiMajorAxis = minA + rng() * (maxA - minA);
  const argPeriapsis = rng() * Math.PI * 2;
  const meanAnomaly0 = rng() * Math.PI * 2;
  const size = 30 + rng() * 50;
  const resourceType = Math.floor(rng() * 3);
  const epochTick = spawnTick;
  const wobblePhase = rng() * Math.PI * 2;

  return {
    size,
    resourceType,
    orbitType,
    semiMajorAxis,
    eccentricity,
    argPeriapsis,
    meanAnomaly0,
    epochTick,
    wobblePhase,
    // Legacy defaults
    definitionId: 'asteroid_ice',
    healthPerUnit: 50,
    miningMultiplier: 1.0,
    visualType: 'rock',
    hue: 0,
    saturation: 0.5,
  };
}
