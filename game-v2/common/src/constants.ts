/**
 * Complete Game Constants - Migrated from v1
 */

// ============================================
// WORLD PARAMETERS
// ============================================

export const WORLD_SIZE = 260000;              // Half-width/height of world
// Keplerian orbit parameter (distance^3 / tick^2)
export const ORBIT_MU = 625000 / 9;           // Orbit "gravity": 1/9 of the old 625000, so asteroids orbit 3x slower (speed goes with sqrt(mu))

// ============================================
// TIMING CONSTANTS
// ============================================

export const TICK_RATE = 60;                   // Server Hz
export const TICK_MS = 1000 / TICK_RATE;       // ~16.67ms
export const SNAPSHOT_RATE = 20;               // Network update Hz
export const PING_HISTORY_SIZE = 5;

// Interpolation delay
export const INTERP_MAX_DELAY_MS = 520;
export const INTERP_MIN_DELAY_MS = 80;
export const INTERP_SLEW_MS_PER_SEC = 90;

// ============================================
// PLAYER CONSTANTS
// ============================================

export const PLAYER_MAX_HP = 100;
export const PLAYER_RADIUS = 20;

// Movement (modular ships take thrust and turning from their parts; these are shared)
export const FRICTION = 0.985;
export const BOOST_DRAIN = 0.8;
export const BOOST_REGEN = 0.35;
export const BOOST_REGEN_DELAY = 60;           // Ticks
export const BOOST_FUEL_DEFAULT = 100;
export const BOOST_FACTOR = 2.2;               // Speed multiplier

// ============================================
// WEAPONS - BLASTER/CANNON
// ============================================

export const BULLET_SPEED = 48;                // Base speed (multiplied by item speed); ships fly twice as fast as they used to, so rounds do too
export const BULLET_DAMAGE = 14;               // Base damage
export const BLASTER_LIFE_TICKS = 150;         // 2.5 seconds (~3600 units of range)

// ============================================
// ASTEROIDS
// ============================================

// Deterministic asteroid generation seed
export const ASTEROID_SEED = 'spacegame-v2-asteroids';
/** Asteroids are drawn and collide at their generated size × this (ships grew 3×, so rocks did too) */
export const ASTEROID_SIZE_SCALE = 2.5;
// Keplerian orbit eccentricity distribution (mostly near-circular)
export const ASTEROID_ECC_MAX = 0.25;
export const ASTEROID_ECC_CURVE = 4;

// ============================================
// STATIONS
// ============================================

export const STATION_INTERACT_RADIUS = 800;

/**
 * How close you must be to dock at a station of this radius and look (a design
 * name, or its index in STATION_DESIGNS): its docking ring sits round its main
 * structure, so a big look's reaches further (a citadel's, its arms' pylons).
 * Server and client both work it out from this.
 */
export function stationInteractRadius(radius: number, design?: number | string): number {
  const name = typeof design === 'number' ? STATION_DESIGNS[design] : design;
  return Math.max(STATION_INTERACT_RADIUS, radius * (STATION_DOCK_REACH[name as StationDesign] ?? 1.3));
}

/** Station looks (data/stations.json `design`); the index goes to the client in the station's entity data */
export const STATION_DESIGNS = ['ring', 'outpost', 'observatory', 'bastion', 'shipyard', 'refinery', 'citadel'] as const;
export type StationDesign = typeof STATION_DESIGNS[number];
/** Each look's docking ring, × its radius: just inside its outer structure (client/src/rendering/stationDesigns.ts) */
export const STATION_DOCK_REACH: Record<StationDesign, number> = {
  ring: 2.4, outpost: 2.0, observatory: 2.0, bastion: 2.1, shipyard: 2.1, refinery: 2.3, citadel: 3.0,
};
/** The furthest a station of this radius can be docked at, whatever its look (stationInteractRadius is never more) */
export function stationReachMax(radius: number): number {
  return Math.max(STATION_INTERACT_RADIUS, radius * DOCK_REACH_MAX);
}
const DOCK_REACH_MAX = Math.max(1.3, ...Object.values(STATION_DOCK_REACH));
/** Station defence turrets (`defence.weapon`): stats in data/factions.json rules.stationDefence */
export const STATION_WEAPONS = ['laser', 'flak', 'lance'] as const;

// ============================================
// NPC
// ============================================

export const NPC_INTERACT_RADIUS = 500;

// ============================================
// AUDIO
// ============================================

export const AUDIO_MAX_DISTANCE = 8000;
export const AUDIO_REF_DISTANCE = 500;

/** Loot pods lose this much speed a tick (velocity *= POD_DRAG, then position += velocity) */
export const POD_DRAG = 0.985;

/** Where a drifting pod is `n` ticks after an anchor (x, y, vx, vy) */
export function podDrift(a: { x: number; y: number; vx: number; vy: number }, n: number): { x: number; y: number; vx: number; vy: number } {
  const dn = Math.pow(POD_DRAG, Math.max(0, n));
  const f = (POD_DRAG * (1 - dn)) / (1 - POD_DRAG);
  return { x: a.x + a.vx * f, y: a.y + a.vy * f, vx: a.vx * dn, vy: a.vy * dn };
}
