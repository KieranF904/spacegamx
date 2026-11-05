import type { AsteroidBeltData, AsteroidRingData } from '../data/schemas.js';
import { ASTEROID_ECC_CURVE, ASTEROID_ECC_MAX, ASTEROID_SIZE_SCALE } from '../constants.js';
import { OrbitType } from './orbit.js';
import { hashString, mulberry32 } from './polygon.js';
import { asteroidRegistry } from '../data/registries/AsteroidRegistry.js';
import { AsteroidFieldConfig, AsteroidDefinition } from '../data/definitions/AsteroidDefinition.js';
import type { OutlierTable } from '../econ/mining.js';
import { datan2, dcos, dhypot, dpow, dsin } from '../math/detTrig.js';

let outliers: OutlierTable | null = null;

/** Every rock a belt has, its extra belts' included */
export function beltTotal(belt: AsteroidBeltData): number {
  return belt.count + (belt.extra ?? []).reduce((t, b) => t + b.count, 0);
}

/** Which belt rock `index` is in: the main one's indices first, then each extra belt's in turn */
export function beltSegment(belt: AsteroidBeltData, index: number): AsteroidRingData & { field?: string } {
  return beltRing(belt, index).ring;
}

/** Which belt rock `index` is in, and which of that belt's rocks it is */
function beltRing(belt: AsteroidBeltData, index: number): { ring: AsteroidRingData & { field?: string }; k: number } {
  let i = index - belt.count;
  if (i < 0 || !belt.extra?.length) return { ring: belt, k: Math.min(index, Math.max(0, belt.count - 1)) };
  for (const b of belt.extra) {
    if (i < b.count) return { ring: b, k: i };
    i -= b.count;
  }
  const last = belt.extra[belt.extra.length - 1];
  return { ring: last, k: Math.max(0, last.count - 1) };
}

/** Golden angle: a still ring's rocks, one after another, spiral out evenly (a sunflower's seeds) */
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

/**
 * Where rock `index` of a stationary ring keeps still, as polar (its Fixed orbit's radius and angle):
 * spread evenly over the ring by area (a sunflower spiral, each nudged off its spot on a seed of its own,
 * not the spawn tick's, so it grows back about where it was), kept `size` inside the ring's edges, and
 * pushed out of the lane to its nearer side
 */
export function stationarySpot(systemId: string, seed: string, belt: AsteroidBeltData, index: number, size: number): { r: number; angle: number } {
  const { ring, k } = beltRing(belt, index);
  // (set down at a spot of its own: a den's rich rocks)
  const spot = ring.at?.[k];
  if (spot) return { r: dhypot(spot[0], spot[1]), angle: datan2(spot[1], spot[0]) };
  const n = Math.max(1, ring.count), r0 = ring.innerRadius, r1 = ring.outerRadius;
  const rng = mulberry32(hashString(`still:${seed}:${systemId}:${index}`));
  const spacing = Math.sqrt((Math.PI * (r1 * r1 - r0 * r0)) / n);
  const u = (k + 0.5) / n, a0 = k * GOLDEN;
  const rr = Math.sqrt(r0 * r0 + u * (r1 * r1 - r0 * r0));
  const ja = rng() * Math.PI * 2, jr = Math.sqrt(rng()) * 0.3 * spacing;
  let x = dcos(a0) * rr + dcos(ja) * jr, y = dsin(a0) * rr + dsin(ja) * jr;
  // (Inside the edges, its whole size)
  const lo = Math.min(r0 + size, (r0 + r1) / 2), hi = Math.max(r1 - size, (r0 + r1) / 2);
  const d = dhypot(x, y) || 1, dc = Math.max(lo, Math.min(hi, d));
  x *= dc / d; y *= dc / d;
  const lane = ring.lane;
  if (lane) {
    const c = dcos(lane.angle), s = dsin(lane.angle);
    const along = x * c + y * s, across = -x * s + y * c, clear = lane.width / 2 + size;
    if (along > 0 && Math.abs(across) < clear) {
      const out = (across < 0 ? -1 : 1) * (clear + rng() * 0.5 * spacing);
      x = along * c - out * s; y = along * s + out * c;
    }
  }
  return { r: dhypot(x, y), angle: datan2(y, x) };
}

/** A stationary ring's rock: its orbit made a fixed spot */
function keepStill(p: AsteroidParams, systemId: string, index: number, seed: string, belt: AsteroidBeltData): AsteroidParams {
  if (!beltSegment(belt, index).stationary) return p;
  const at = stationarySpot(systemId, seed, belt, index, p.size);
  return { ...p, orbitType: OrbitType.Fixed, semiMajorAxis: at.r, argPeriapsis: at.angle, eccentricity: 0, meanAnomaly0: 0 };
}

/** A rock's params, from its belt's field (an extra belt's own, if it names one) */
export function asteroidParamsAt(systemId: string, index: number, seed: string, spawnTick: number, belt: AsteroidBeltData, fieldId?: string): AsteroidParams {
  const id = beltSegment(belt, index).field ?? fieldId;
  const field = id ? asteroidRegistry.getField(id) : undefined;
  return field ? makeAsteroidParamsFromField(systemId, index, seed, spawnTick, belt, field) : makeAsteroidParams(systemId, index, seed, spawnTick, belt);
}

/** The outlier rules (data/mining.json), set with the rock types on both sides */
export function setAsteroidOutliers(t: OutlierTable | undefined): void {
  outliers = t ?? null;
}

/**
 * A rock in a hundred or so is an outlier, several times the size (0: not
 * one). Rolled on its own seed, so every other rock is just as it was.
 */
export function outlierScale(seed: string, systemId: string, spawnTick: number, index: number, type: string): number {
  if (!outliers || outliers.exclude?.includes(type)) return 0;
  const r = mulberry32(hashString(`outlier:${seed}:${systemId}:${spawnTick}:${index}`));
  if (r() >= outliers.chance * (outliers.systems?.[systemId] ?? 1)) return 0;
  return outliers.scale[0] + r() * (outliers.scale[1] - outliers.scale[0]);
}

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
  /** An outlier (mined down a stage at a time): its size is already the outsized one */
  outlier?: boolean;
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
  const eccentricity = ASTEROID_ECC_MAX * dpow(rng(), ASTEROID_ECC_CURVE);
  const seg = beltSegment(belt, index);
  const minA = seg.innerRadius / (1 + eccentricity);
  const maxA = seg.outerRadius / (1 - eccentricity);
  const semiMajorAxis = minA + rng() * (maxA - minA);
  const argPeriapsis = rng() * Math.PI * 2;
  const meanAnomaly0 = rng() * Math.PI * 2;
  const epochTick = spawnTick;
  const wobblePhase = rng() * Math.PI * 2;
  
  // Size from definition range (an outlier's several times that)
  const big = outlierScale(seed, systemId, spawnTick, index, definition.id);
  const size = (definition.size.min + rng() * (definition.size.max - definition.size.min)) * ASTEROID_SIZE_SCALE * (big || 1);
  
  // Resource type from definition's primary resource
  const resourceType = RESOURCE_TYPE_MAP[definition.resources.primary.type] ?? 0;

  return keepStill({
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
    ...(big ? { outlier: true } : {}),
  }, systemId, index, seed, belt);
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
  const eccentricity = ASTEROID_ECC_MAX * dpow(rng(), ASTEROID_ECC_CURVE);
  const seg = beltSegment(belt, index);
  const minA = seg.innerRadius / (1 + eccentricity);
  const maxA = seg.outerRadius / (1 - eccentricity);
  const semiMajorAxis = minA + rng() * (maxA - minA);
  const argPeriapsis = rng() * Math.PI * 2;
  const meanAnomaly0 = rng() * Math.PI * 2;
  const big = outlierScale(seed, systemId, spawnTick, index, 'asteroid_ice');
  const size = (30 + rng() * 50) * ASTEROID_SIZE_SCALE * (big || 1);
  const resourceType = Math.floor(rng() * 3);
  const epochTick = spawnTick;
  const wobblePhase = rng() * Math.PI * 2;

  return keepStill({
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
    ...(big ? { outlier: true } : {}),
  }, systemId, index, seed, belt);
}
