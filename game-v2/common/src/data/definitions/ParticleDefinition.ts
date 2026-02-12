/**
 * Particle Definition - Data-driven particle emitter configuration
 * Used by the client-side particle system
 */

export interface ParticleDefinition {
  id: string;
  name: string;
  
  // === Emission ===
  emission: EmissionConfig;
  
  // === Particle Properties ===
  particle: ParticleConfig;
  
  // === Physics ===
  physics: ParticlePhysicsConfig;
  
  // === Visual ===
  visual: ParticleVisualConfig;
}

export interface EmissionConfig {
  type: 'burst' | 'continuous' | 'trail';
  rate: number;               // Particles per second (continuous) or per burst
  burstCount?: number;        // For burst type
  burstInterval?: number;     // Ms between bursts
  duration?: number;          // Ms, 0 = infinite
  maxParticles: number;       // Max active particles for this emitter
}

export interface ParticleConfig {
  lifetime: { min: number; max: number };   // Ms
  size: { start: number; end: number };
  rotation: { min: number; max: number };   // Starting rotation
  rotationSpeed: { min: number; max: number };
}

export interface ParticlePhysicsConfig {
  speed: { min: number; max: number };
  direction: { min: number; max: number };  // Radians, relative to emitter
  spread: number;                            // Radians, cone spread
  gravity?: { x: number; y: number };
  friction: number;                          // 0-1, velocity decay
  inheritVelocity: number;                   // 0-1, from parent
}

export interface ParticleVisualConfig {
  shape: 'circle' | 'square' | 'triangle' | 'star' | 'spark' | 'smoke' | 'ring';
  color: ColorConfig;
  alpha: { start: number; end: number };
  blendMode: 'normal' | 'add' | 'multiply' | 'screen';
  glow?: number;                             // Glow intensity
}

export interface ColorConfig {
  type: 'solid' | 'gradient' | 'random' | 'hueShift';
  start: string;              // Hex color
  end?: string;               // For gradient
  hue?: number;               // For hueShift (base hue)
  hueRange?: number;          // For random hue variation
  saturation?: number;
  lightness?: number;
}

// === Default particle definitions ===
export const DEFAULT_PARTICLES: ParticleDefinition[] = [
  // ENGINE EXHAUST
  {
    id: 'engine_exhaust',
    name: 'Engine Exhaust',
    emission: {
      type: 'continuous',
      rate: 30,
      maxParticles: 100,
    },
    particle: {
      lifetime: { min: 200, max: 400 },
      size: { start: 8, end: 2 },
      rotation: { min: 0, max: Math.PI * 2 },
      rotationSpeed: { min: -0.1, max: 0.1 },
    },
    physics: {
      speed: { min: 50, max: 100 },
      direction: { min: Math.PI - 0.3, max: Math.PI + 0.3 },
      spread: 0.5,
      friction: 0.95,
      inheritVelocity: 0.3,
    },
    visual: {
      shape: 'circle',
      color: { type: 'gradient', start: '#ffff00', end: '#ff4400' },
      alpha: { start: 0.8, end: 0 },
      blendMode: 'add',
      glow: 0.5,
    },
  },

  // ENGINE EXHAUST BOOSTING
  {
    id: 'engine_boost',
    name: 'Boost Exhaust',
    emission: {
      type: 'continuous',
      rate: 60,
      maxParticles: 150,
    },
    particle: {
      lifetime: { min: 300, max: 500 },
      size: { start: 12, end: 3 },
      rotation: { min: 0, max: Math.PI * 2 },
      rotationSpeed: { min: -0.2, max: 0.2 },
    },
    physics: {
      speed: { min: 80, max: 150 },
      direction: { min: Math.PI - 0.4, max: Math.PI + 0.4 },
      spread: 0.6,
      friction: 0.94,
      inheritVelocity: 0.4,
    },
    visual: {
      shape: 'circle',
      color: { type: 'gradient', start: '#00ffff', end: '#0044ff' },
      alpha: { start: 1, end: 0 },
      blendMode: 'add',
      glow: 0.8,
    },
  },

  // BULLET IMPACT
  {
    id: 'bullet_impact',
    name: 'Bullet Impact',
    emission: {
      type: 'burst',
      rate: 15,
      burstCount: 1,
      maxParticles: 30,
    },
    particle: {
      lifetime: { min: 100, max: 250 },
      size: { start: 4, end: 1 },
      rotation: { min: 0, max: Math.PI * 2 },
      rotationSpeed: { min: -0.5, max: 0.5 },
    },
    physics: {
      speed: { min: 100, max: 200 },
      direction: { min: 0, max: Math.PI * 2 },
      spread: Math.PI * 2,
      friction: 0.9,
      inheritVelocity: 0.1,
    },
    visual: {
      shape: 'spark',
      color: { type: 'hueShift', start: '#ffff00', hue: 60, hueRange: 30 },
      alpha: { start: 1, end: 0 },
      blendMode: 'add',
    },
  },

  // EXPLOSION
  {
    id: 'explosion',
    name: 'Explosion',
    emission: {
      type: 'burst',
      rate: 40,
      burstCount: 1,
      maxParticles: 50,
    },
    particle: {
      lifetime: { min: 300, max: 600 },
      size: { start: 20, end: 5 },
      rotation: { min: 0, max: Math.PI * 2 },
      rotationSpeed: { min: -0.3, max: 0.3 },
    },
    physics: {
      speed: { min: 50, max: 200 },
      direction: { min: 0, max: Math.PI * 2 },
      spread: Math.PI * 2,
      friction: 0.92,
      inheritVelocity: 0.05,
    },
    visual: {
      shape: 'circle',
      color: { type: 'gradient', start: '#ffffff', end: '#ff4400' },
      alpha: { start: 1, end: 0 },
      blendMode: 'add',
      glow: 1,
    },
  },

  // EXPLOSION SMOKE
  {
    id: 'explosion_smoke',
    name: 'Explosion Smoke',
    emission: {
      type: 'burst',
      rate: 20,
      burstCount: 1,
      maxParticles: 30,
    },
    particle: {
      lifetime: { min: 500, max: 1000 },
      size: { start: 15, end: 40 },
      rotation: { min: 0, max: Math.PI * 2 },
      rotationSpeed: { min: -0.1, max: 0.1 },
    },
    physics: {
      speed: { min: 20, max: 60 },
      direction: { min: 0, max: Math.PI * 2 },
      spread: Math.PI * 2,
      friction: 0.98,
      inheritVelocity: 0.02,
    },
    visual: {
      shape: 'smoke',
      color: { type: 'gradient', start: '#444444', end: '#222222' },
      alpha: { start: 0.6, end: 0 },
      blendMode: 'normal',
    },
  },

  // MISSILE SMOKE TRAIL
  {
    id: 'missile_smoke',
    name: 'Missile Smoke',
    emission: {
      type: 'continuous',
      rate: 40,
      maxParticles: 80,
    },
    particle: {
      lifetime: { min: 400, max: 700 },
      size: { start: 6, end: 15 },
      rotation: { min: 0, max: Math.PI * 2 },
      rotationSpeed: { min: -0.05, max: 0.05 },
    },
    physics: {
      speed: { min: 5, max: 20 },
      direction: { min: Math.PI - 0.5, max: Math.PI + 0.5 },
      spread: 0.8,
      friction: 0.99,
      inheritVelocity: 0.1,
    },
    visual: {
      shape: 'smoke',
      color: { type: 'gradient', start: '#666666', end: '#333333' },
      alpha: { start: 0.5, end: 0 },
      blendMode: 'normal',
    },
  },

  // PULSE CHARGE
  {
    id: 'pulse_charge',
    name: 'Pulse Charging',
    emission: {
      type: 'continuous',
      rate: 20,
      maxParticles: 40,
    },
    particle: {
      lifetime: { min: 200, max: 400 },
      size: { start: 3, end: 8 },
      rotation: { min: 0, max: Math.PI * 2 },
      rotationSpeed: { min: 0.1, max: 0.3 },
    },
    physics: {
      speed: { min: 30, max: 60 },
      direction: { min: 0, max: Math.PI * 2 },
      spread: Math.PI * 2,
      gravity: { x: 0, y: 0 },
      friction: 0.95,
      inheritVelocity: 0,
    },
    visual: {
      shape: 'spark',
      color: { type: 'hueShift', start: '#00ffff', hue: 180, hueRange: 40 },
      alpha: { start: 0.8, end: 0 },
      blendMode: 'add',
      glow: 0.6,
    },
  },

  // MINING SPARKS
  {
    id: 'mining_sparks',
    name: 'Mining Sparks',
    emission: {
      type: 'continuous',
      rate: 25,
      maxParticles: 50,
    },
    particle: {
      lifetime: { min: 150, max: 350 },
      size: { start: 3, end: 1 },
      rotation: { min: 0, max: Math.PI * 2 },
      rotationSpeed: { min: -1, max: 1 },
    },
    physics: {
      speed: { min: 80, max: 150 },
      direction: { min: 0, max: Math.PI * 2 },
      spread: Math.PI * 2,
      gravity: { x: 0, y: 50 },
      friction: 0.95,
      inheritVelocity: 0.05,
    },
    visual: {
      shape: 'spark',
      color: { type: 'random', start: '#ffaa00', hueRange: 30 },
      alpha: { start: 1, end: 0 },
      blendMode: 'add',
    },
  },

  // SHIELD HIT
  {
    id: 'shield_hit',
    name: 'Shield Impact',
    emission: {
      type: 'burst',
      rate: 25,
      burstCount: 1,
      maxParticles: 40,
    },
    particle: {
      lifetime: { min: 150, max: 300 },
      size: { start: 6, end: 2 },
      rotation: { min: 0, max: Math.PI * 2 },
      rotationSpeed: { min: -0.2, max: 0.2 },
    },
    physics: {
      speed: { min: 50, max: 120 },
      direction: { min: 0, max: Math.PI * 2 },
      spread: Math.PI,
      friction: 0.92,
      inheritVelocity: 0.1,
    },
    visual: {
      shape: 'circle',
      color: { type: 'solid', start: '#00aaff' },
      alpha: { start: 0.9, end: 0 },
      blendMode: 'add',
      glow: 0.7,
    },
  },

  // LEVEL UP
  {
    id: 'level_up',
    name: 'Level Up Effect',
    emission: {
      type: 'burst',
      rate: 60,
      burstCount: 1,
      maxParticles: 80,
    },
    particle: {
      lifetime: { min: 500, max: 1000 },
      size: { start: 8, end: 2 },
      rotation: { min: 0, max: Math.PI * 2 },
      rotationSpeed: { min: 0.1, max: 0.3 },
    },
    physics: {
      speed: { min: 80, max: 200 },
      direction: { min: 0, max: Math.PI * 2 },
      spread: Math.PI * 2,
      gravity: { x: 0, y: -30 },
      friction: 0.96,
      inheritVelocity: 0,
    },
    visual: {
      shape: 'star',
      color: { type: 'gradient', start: '#ffff00', end: '#ff8800' },
      alpha: { start: 1, end: 0 },
      blendMode: 'add',
      glow: 1,
    },
  },

  // ITEM PICKUP
  {
    id: 'item_pickup',
    name: 'Item Pickup',
    emission: {
      type: 'burst',
      rate: 12,
      burstCount: 1,
      maxParticles: 20,
    },
    particle: {
      lifetime: { min: 200, max: 400 },
      size: { start: 5, end: 1 },
      rotation: { min: 0, max: Math.PI * 2 },
      rotationSpeed: { min: 0.2, max: 0.5 },
    },
    physics: {
      speed: { min: 40, max: 80 },
      direction: { min: -Math.PI / 2 - 0.5, max: -Math.PI / 2 + 0.5 },
      spread: 1,
      gravity: { x: 0, y: 100 },
      friction: 0.98,
      inheritVelocity: 0,
    },
    visual: {
      shape: 'circle',
      color: { type: 'solid', start: '#00ff00' },
      alpha: { start: 1, end: 0 },
      blendMode: 'add',
    },
  },

  // HEAL EFFECT
  {
    id: 'heal_effect',
    name: 'Healing',
    emission: {
      type: 'burst',
      rate: 15,
      burstCount: 3,
      burstInterval: 200,
      maxParticles: 50,
    },
    particle: {
      lifetime: { min: 400, max: 700 },
      size: { start: 6, end: 2 },
      rotation: { min: 0, max: Math.PI * 2 },
      rotationSpeed: { min: 0, max: 0.1 },
    },
    physics: {
      speed: { min: 20, max: 50 },
      direction: { min: -Math.PI / 2 - 0.3, max: -Math.PI / 2 + 0.3 },
      spread: 0.6,
      friction: 0.98,
      inheritVelocity: 0,
    },
    visual: {
      shape: 'circle',
      color: { type: 'solid', start: '#00ff88' },
      alpha: { start: 0.8, end: 0 },
      blendMode: 'add',
      glow: 0.5,
    },
  },

  // ICE SHATTER
  {
    id: 'ice_shatter',
    name: 'Ice Shatter',
    emission: {
      type: 'burst',
      rate: 30,
      burstCount: 1,
      maxParticles: 40,
    },
    particle: {
      lifetime: { min: 300, max: 600 },
      size: { start: 8, end: 3 },
      rotation: { min: 0, max: Math.PI * 2 },
      rotationSpeed: { min: -0.5, max: 0.5 },
    },
    physics: {
      speed: { min: 60, max: 150 },
      direction: { min: 0, max: Math.PI * 2 },
      spread: Math.PI * 2,
      gravity: { x: 0, y: 20 },
      friction: 0.96,
      inheritVelocity: 0.1,
    },
    visual: {
      shape: 'triangle',
      color: { type: 'gradient', start: '#aaffff', end: '#4488ff' },
      alpha: { start: 0.9, end: 0 },
      blendMode: 'add',
    },
  },

  // MINE ARM
  {
    id: 'mine_arm',
    name: 'Mine Arming',
    emission: {
      type: 'continuous',
      rate: 10,
      duration: 1000,
      maxParticles: 20,
    },
    particle: {
      lifetime: { min: 300, max: 500 },
      size: { start: 4, end: 8 },
      rotation: { min: 0, max: Math.PI * 2 },
      rotationSpeed: { min: 0.05, max: 0.1 },
    },
    physics: {
      speed: { min: 5, max: 15 },
      direction: { min: 0, max: Math.PI * 2 },
      spread: Math.PI * 2,
      friction: 0.99,
      inheritVelocity: 0,
    },
    visual: {
      shape: 'ring',
      color: { type: 'gradient', start: '#ff0000', end: '#ffaa00' },
      alpha: { start: 0.6, end: 0 },
      blendMode: 'add',
    },
  },
];
