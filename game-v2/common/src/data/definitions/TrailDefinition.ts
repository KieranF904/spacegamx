/**
 * Trail Definition - Data-driven trail configuration
 * Used by the client-side trail system
 */

export interface TrailDefinition {
  id: string;
  name: string;
  
  // === Trail Shape ===
  shape: TrailShapeConfig;
  
  // === Visual ===
  visual: TrailVisualConfig;
  
  // === Behavior ===
  behavior: TrailBehaviorConfig;
}

export interface TrailShapeConfig {
  type: 'line' | 'ribbon' | 'dotted' | 'tapered';
  maxLength: number;          // Max points in trail
  minSegmentDistance: number; // Min distance between points
  width: { start: number; end: number };
}

export interface TrailVisualConfig {
  color: TrailColorConfig;
  alpha: { start: number; end: number };
  glow?: number;
  blendMode: 'normal' | 'add' | 'multiply' | 'screen';
}

export interface TrailColorConfig {
  type: 'solid' | 'gradient' | 'hueShift' | 'velocity';
  start: string;              // Hex color
  end?: string;               // For gradient
  hue?: number;               // Base hue for hueShift
  velocityColors?: { speed: number; color: string }[];
}

export interface TrailBehaviorConfig {
  fadeTime: number;           // Ms to fade after emission stops
  shrinkOnFade: boolean;      // Shrink width while fading
  inheritRotation: boolean;   // Trail segments rotate with emitter
  smoothing: number;          // 0-1, bezier smoothing
}

// === Default trail definitions ===
export const DEFAULT_TRAILS: TrailDefinition[] = [
  // BULLET TRAIL
  {
    id: 'bullet',
    name: 'Bullet Trail',
    shape: {
      type: 'tapered',
      maxLength: 15,
      minSegmentDistance: 5,
      width: { start: 4, end: 1 },
    },
    visual: {
      color: { type: 'hueShift', start: '#00ff00', hue: 120 },
      alpha: { start: 0.8, end: 0.1 },
      glow: 0.5,
      blendMode: 'add',
    },
    behavior: {
      fadeTime: 100,
      shrinkOnFade: true,
      inheritRotation: false,
      smoothing: 0,
    },
  },

  // LASER TRAIL
  {
    id: 'laser',
    name: 'Laser Trail',
    shape: {
      type: 'line',
      maxLength: 2,
      minSegmentDistance: 0,
      width: { start: 3, end: 3 },
    },
    visual: {
      color: { type: 'solid', start: '#00ff00' },
      alpha: { start: 1, end: 0.8 },
      glow: 1,
      blendMode: 'add',
    },
    behavior: {
      fadeTime: 50,
      shrinkOnFade: false,
      inheritRotation: false,
      smoothing: 0,
    },
  },

  // SCATTER TRAIL
  {
    id: 'scatter',
    name: 'Scatter Trail',
    shape: {
      type: 'dotted',
      maxLength: 8,
      minSegmentDistance: 8,
      width: { start: 3, end: 1 },
    },
    visual: {
      color: { type: 'hueShift', start: '#ffaa00', hue: 30 },
      alpha: { start: 0.7, end: 0 },
      blendMode: 'add',
    },
    behavior: {
      fadeTime: 80,
      shrinkOnFade: true,
      inheritRotation: false,
      smoothing: 0,
    },
  },

  // MISSILE TRAIL
  {
    id: 'missile',
    name: 'Missile Trail',
    shape: {
      type: 'ribbon',
      maxLength: 30,
      minSegmentDistance: 4,
      width: { start: 8, end: 2 },
    },
    visual: {
      color: { type: 'gradient', start: '#ff4400', end: '#ffaa00' },
      alpha: { start: 0.9, end: 0.2 },
      glow: 0.6,
      blendMode: 'add',
    },
    behavior: {
      fadeTime: 300,
      shrinkOnFade: true,
      inheritRotation: false,
      smoothing: 0.3,
    },
  },

  // PULSE TRAIL
  {
    id: 'pulse',
    name: 'Pulse Trail',
    shape: {
      type: 'ribbon',
      maxLength: 20,
      minSegmentDistance: 6,
      width: { start: 12, end: 4 },
    },
    visual: {
      color: { type: 'gradient', start: '#00ffff', end: '#0088ff' },
      alpha: { start: 0.8, end: 0.1 },
      glow: 0.8,
      blendMode: 'add',
    },
    behavior: {
      fadeTime: 200,
      shrinkOnFade: true,
      inheritRotation: false,
      smoothing: 0.5,
    },
  },

  // MINING TRAIL
  {
    id: 'mining',
    name: 'Mining Trail',
    shape: {
      type: 'tapered',
      maxLength: 12,
      minSegmentDistance: 8,
      width: { start: 6, end: 2 },
    },
    visual: {
      color: { type: 'gradient', start: '#ffff00', end: '#884400' },
      alpha: { start: 0.7, end: 0.1 },
      glow: 0.3,
      blendMode: 'add',
    },
    behavior: {
      fadeTime: 150,
      shrinkOnFade: true,
      inheritRotation: false,
      smoothing: 0.2,
    },
  },

  // ENGINE TRAIL (for player/enemy ships)
  {
    id: 'engine',
    name: 'Engine Trail',
    shape: {
      type: 'tapered',
      maxLength: 25,
      minSegmentDistance: 3,
      width: { start: 10, end: 2 },
    },
    visual: {
      color: { 
        type: 'velocity', 
        start: '#ffaa00',
        velocityColors: [
          { speed: 0, color: '#ff4400' },
          { speed: 5, color: '#ffaa00' },
          { speed: 10, color: '#00ffff' },
        ],
      },
      alpha: { start: 0.7, end: 0 },
      glow: 0.4,
      blendMode: 'add',
    },
    behavior: {
      fadeTime: 200,
      shrinkOnFade: true,
      inheritRotation: false,
      smoothing: 0.4,
    },
  },

  // BOOST TRAIL
  {
    id: 'boost',
    name: 'Boost Trail',
    shape: {
      type: 'ribbon',
      maxLength: 40,
      minSegmentDistance: 2,
      width: { start: 14, end: 4 },
    },
    visual: {
      color: { type: 'gradient', start: '#00ffff', end: '#0044ff' },
      alpha: { start: 0.9, end: 0.1 },
      glow: 1,
      blendMode: 'add',
    },
    behavior: {
      fadeTime: 300,
      shrinkOnFade: true,
      inheritRotation: false,
      smoothing: 0.5,
    },
  },

  // WARP TRAIL
  {
    id: 'warp',
    name: 'Warp Trail',
    shape: {
      type: 'ribbon',
      maxLength: 50,
      minSegmentDistance: 2,
      width: { start: 20, end: 5 },
    },
    visual: {
      color: { type: 'gradient', start: '#ff00ff', end: '#0000ff' },
      alpha: { start: 1, end: 0.2 },
      glow: 1.5,
      blendMode: 'add',
    },
    behavior: {
      fadeTime: 500,
      shrinkOnFade: true,
      inheritRotation: false,
      smoothing: 0.7,
    },
  },

  // ENEMY PROJECTILE
  {
    id: 'enemy_bullet',
    name: 'Enemy Bullet Trail',
    shape: {
      type: 'tapered',
      maxLength: 12,
      minSegmentDistance: 6,
      width: { start: 4, end: 1 },
    },
    visual: {
      color: { type: 'solid', start: '#ff4444' },
      alpha: { start: 0.8, end: 0.1 },
      glow: 0.4,
      blendMode: 'add',
    },
    behavior: {
      fadeTime: 100,
      shrinkOnFade: true,
      inheritRotation: false,
      smoothing: 0,
    },
  },

  // ICE SPRITE TRAIL
  {
    id: 'ice_sprite',
    name: 'Ice Sprite Trail',
    shape: {
      type: 'dotted',
      maxLength: 10,
      minSegmentDistance: 10,
      width: { start: 5, end: 2 },
    },
    visual: {
      color: { type: 'gradient', start: '#aaffff', end: '#4488ff' },
      alpha: { start: 0.6, end: 0 },
      glow: 0.3,
      blendMode: 'add',
    },
    behavior: {
      fadeTime: 150,
      shrinkOnFade: true,
      inheritRotation: false,
      smoothing: 0,
    },
  },

  // ITEM DROP TRAIL
  {
    id: 'item_drop',
    name: 'Item Drop Trail',
    shape: {
      type: 'dotted',
      maxLength: 8,
      minSegmentDistance: 12,
      width: { start: 6, end: 3 },
    },
    visual: {
      color: { type: 'hueShift', start: '#ffff00', hue: 60 },
      alpha: { start: 0.8, end: 0.2 },
      glow: 0.6,
      blendMode: 'add',
    },
    behavior: {
      fadeTime: 300,
      shrinkOnFade: false,
      inheritRotation: false,
      smoothing: 0,
    },
  },
];
