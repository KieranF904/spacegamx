/**
 * Renderer - PixiJS WebGL rendering
 */

import {
  Application,
  Container,
  Graphics,
  Text,
  TextStyle,
  Sprite,
  Texture,
  Color,
  BlurFilter,
} from 'pixi.js';
import { GameState } from '../state/GameState';
import { SunRenderer } from './SunRenderer';
import { GlowRenderer } from './GlowRenderer';
import {
  EntityType,
  EffectType,
  WeaponType,
  WORLD_SIZE,
  PLAYER_RADIUS,
  TIER_COLORS,
  LASER_RANGE,
  unpackCursorWeaponState,
  getAsteroidPolygon,
  raycastPolygon,
  mulberry32,
  hashString,
  sunShaderDefs,
} from '@space-game/common';
import { ITEM_DATA } from '../data/itemData';

interface DamageNumber {
  x: number;
  y: number;
  amount: number;
  critical: boolean;
  lifetime: number;
  text: Text;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  color: number;
  size: number;
  graphic: Graphics;
}

interface TractorBeam {
  startX: number;
  startY: number;
  targetX: number;
  targetY: number;
  progress: number;
  graphic: Graphics;
}

// Dying trail for fade effect
interface DyingTrail {
  points: { x: number; y: number }[];
  weaponType: number;
  tier: number;
  hue: number;
  fadeProgress: number; // 0 to 1
}

// Fire effect (muzzle flash) - matching original game
interface FireEffect {
  x: number;
  y: number;
  angle: number;
  weaponType: string; // 'cannon', 'scatter', 'missile', 'pulse', 'mine', 'mining', 'laser', 'warp'
  tier: number;
  hue: number;
  life: number;
  maxLife: number;
  graphic: Graphics;
}

// Object pool for graphics reuse
class GraphicsPool {
  private available: Graphics[] = [];
  private inUse: Map<number, Graphics> = new Map();
  
  acquire(id: number): Graphics {
    let g = this.available.pop();
    if (!g) {
      g = new Graphics();
    }
    this.inUse.set(id, g);
    return g;
  }
  
  release(id: number): Graphics | undefined {
    const g = this.inUse.get(id);
    if (g) {
      g.clear();
      this.inUse.delete(id);
      this.available.push(g);
    }
    return g;
  }
  
  get(id: number): Graphics | undefined {
    return this.inUse.get(id);
  }
  
  releaseAll(): void {
    for (const [id, g] of this.inUse) {
      g.clear();
      this.available.push(g);
    }
    this.inUse.clear();
  }
}

// Data-driven star layer configuration (matching original game)
// Each layer: zMin, zMax, minSize, maxSize, baseCount, minZoom threshold
interface StarLayerConfig {
  zMin: number;
  zMax: number;
  minSize: number;
  maxSize: number;
  baseCount: number;
  minZoom: number;
  noiseScale: number;
  noiseSeed: number;
  noiseThreshold: number;
}

interface StarData {
  x: number;
  y: number;
  z: number;
  size: number;
  hue: number;
  phase: number;
  brightness: number;
}

// Default starfield layers (can be overridden per system)
const DEFAULT_STAR_LAYERS: StarLayerConfig[] = [
  { zMin: 400, zMax: 800, minSize: 6.0, maxSize: 10.0, baseCount: 4, minZoom: 0, noiseScale: 0.00008, noiseSeed: 100, noiseThreshold: 0.5 },
  { zMin: 800, zMax: 1500, minSize: 4.0, maxSize: 7.0, baseCount: 8, minZoom: 0.15, noiseScale: 0.00015, noiseSeed: 200, noiseThreshold: 0.5 },
  { zMin: 900, zMax: 1500, minSize: 2.5, maxSize: 4.5, baseCount: 10, minZoom: 0.25, noiseScale: 0.0008, noiseSeed: 300, noiseThreshold: 0 },
  { zMin: 1500, zMax: 2200, minSize: 1.5, maxSize: 3.0, baseCount: 14, minZoom: 0.4, noiseScale: 0.001, noiseSeed: 400, noiseThreshold: 0 },
  { zMin: 2200, zMax: 3000, minSize: 1.0, maxSize: 2.0, baseCount: 20, minZoom: 0.6, noiseScale: 0.0015, noiseSeed: 500, noiseThreshold: 0 },
  { zMin: 3000, zMax: 4500, minSize: 0.6, maxSize: 1.2, baseCount: 28, minZoom: 0.8, noiseScale: 0.002, noiseSeed: 600, noiseThreshold: 0 },
];

// System-specific visual configurations
interface SystemVisuals {
  starHue: number;          // Base hue for the central star (0-360)
  starRadius: number;       // Size of central star
  starLayers?: StarLayerConfig[];  // Optional custom star layers
  specialStarChance?: number;      // Chance for special colored stars
  specialStarHue?: number;         // Hue for special stars
  hasNebula?: boolean;
  nebulaHue?: number;
  sunStyle?: string;
  sunStyleParams?: Record<string, number>;
  coronaStyle?: string;
  coronaStyleParams?: Record<string, number>;
}

const SYSTEM_VISUALS: Record<string, SystemVisuals> = {
  'sol': { 
    starHue: 40,           // Yellow-orange
    starRadius: 1000,
    sunStyle: 'granular',
    coronaStyle: 'plasmaStreams',
  },
  'borealis': { 
    starHue: 200,          // Cyan-blue
    starRadius: 800,
    specialStarChance: 0.05,
    specialStarHue: 240,   // Pure blue special stars
    sunStyle: 'granular',
    coronaStyle: 'softGlow',
  },
  'nebula_prime': { 
    starHue: 330,          // Pink-magenta
    starRadius: 1200,
    hasNebula: true,
    nebulaHue: 300,
    sunStyle: 'flow',
    coronaStyle: 'plasmaStreams',
  },
  'void_sector': { 
    starHue: 270,          // Purple
    starRadius: 600,
    sunStyle: 'flow',
    coronaStyle: 'softGlow',
  },
};

function buildStyleParams(
  styles: typeof sunShaderDefs.sunStyles,
  styleId: string | undefined,
  paramOverrides?: Record<string, number>
) {
  const index = Math.max(0, styles.findIndex((s) => s.id === styleId));
  const style = styles[index] || styles[0];
  const params = style.params.map((param) => {
    const override = paramOverrides?.[param.key];
    return override !== undefined ? override : param.default;
  });
  return { index, params };
}

export class Renderer {
  private app: Application;
  private state: GameState;
  
  // Containers (render order)
  private worldContainer: Container;
  private backgroundContainer: Container;
  private entityContainer: Container;
  private effectContainer: Container;
  private uiContainer: Container;
  
  // Camera
  private cameraX = 0;
  private cameraY = 0;
  private cameraZoom = 1;
  private targetCameraX = 0;
  private targetCameraY = 0;
  
  // Star field - cached stars per region for performance
  private starCache: Map<string, StarData[]> = new Map();
  private starsGraphics: Graphics;
  private nebulaGraphics: Graphics;
  private sunGraphics: Graphics;
  
  // GPU shader renderers for sun and glow
  private sunRenderer: SunRenderer;
  private glowRenderer: GlowRenderer;
  
  // Starfield constants
  private readonly STARFIELD_FOCAL = 1000;
  private readonly STARFIELD_SNAP = 3000;
  
  // Current system info
  private currentSystemId: string = 'sol';
  
  // Entity graphics cache
  private entityGraphics: Map<number, Container> = new Map();
  
  // Object pools for performance
  private projectilePool: GraphicsPool = new GraphicsPool();
  
  // Effects
  private damageNumbers: DamageNumber[] = [];
  private particles: Particle[] = [];
  private trails: Map<number, { x: number; y: number }[]> = new Map();
  private dyingTrails: DyingTrail[] = []; // Fading trails from destroyed projectiles
  private tractorBeams: TractorBeam[] = [];
  private fireEffects: FireEffect[] = []; // Muzzle flash effects
  private spawnedFireEffectIds: Set<number> = new Set(); // Track which projectiles spawned fire effects
  
  // Active laser beams - persists while firing for smooth interpolation
  private activeLasers: Map<number, {
    graphic: Graphics;
    targetEndX: number;
    targetEndY: number;
    displayEndX: number;
    displayEndY: number;
    collisionDist: number;
    powerTime: number;
    hue: number;
    lastUpdateTime: number;
    entityId: number;
    aimAngle: number;
    range: number;
  }> = new Map();
  
  // Cached laser beam colors (hue=30 orange, avoids hslToRgb per frame)
  private readonly LASER_COLOR_OUTER = (() => { const [r,g,b] = Renderer.hslToRgbStatic(30,100,60); return (r<<16)|(g<<8)|b; })();
  private readonly LASER_COLOR_MID = (() => { const [r,g,b] = Renderer.hslToRgbStatic(30,100,80); return (r<<16)|(g<<8)|b; })();
  
  // Local laser prediction state
  private localFireLeft = false;
  private localFireRight = false;
  private localTargetAngle = 0;

  // Debug asteroid markers (server-provided)
  private debugAsteroidGraphics: Graphics;
  private debugAsteroidMarkers: { x: number; y: number; expiresAt: number }[] = [];

  // Death screen
  private deathOverlay: Container | null = null;
  
  // Minimap
  private minimapContainer: Container | null = null;
  private minimapGraphics: Graphics | null = null;
  private readonly MINIMAP_SIZE = 180;
  private readonly MINIMAP_RANGE = 8000; // World units to display
  
  // Culling margin (pixels beyond viewport to render)
  private readonly CULL_MARGIN = 200;
  
  // Animation timing
  private time: number = 0;

  constructor(app: Application, state: GameState) {
    this.app = app;
    this.state = state;
    
    // Create layer containers
    this.worldContainer = new Container();
    this.backgroundContainer = new Container();
    this.entityContainer = new Container();
    this.effectContainer = new Container();
    this.uiContainer = new Container();
    
    this.worldContainer.addChild(this.backgroundContainer);
    this.worldContainer.addChild(this.entityContainer);
    this.worldContainer.addChild(this.effectContainer);
    
    this.app.stage.addChild(this.worldContainer);
    this.app.stage.addChild(this.uiContainer);
    
    // Initialize graphics
    this.nebulaGraphics = new Graphics();
    this.starsGraphics = new Graphics();
    this.sunGraphics = new Graphics();
    this.backgroundContainer.addChild(this.nebulaGraphics);
    this.backgroundContainer.addChild(this.starsGraphics);
    // Note: sunGraphics no longer added - replaced by shader renderers
    
    // Initialize GPU shader renderers for sun and ambient glow
    this.glowRenderer = new GlowRenderer();
    this.glowRenderer.initialize();
    this.backgroundContainer.addChild(this.glowRenderer.getContainer());
    
    this.sunRenderer = new SunRenderer();
    this.sunRenderer.initialize();
    this.backgroundContainer.addChild(this.sunRenderer.getContainer());

    // Debug asteroid marker layer (above entities, below UI)
    this.debugAsteroidGraphics = new Graphics();
    this.debugAsteroidGraphics.name = 'debugAsteroidMarkers';
    this.effectContainer.addChild(this.debugAsteroidGraphics);
    
    // Initialize minimap
    this.initMinimap();
  }
  
  private initMinimap(): void {
    this.minimapContainer = new Container();
    this.minimapContainer.x = this.app.screen.width - this.MINIMAP_SIZE - 15;
    this.minimapContainer.y = 15;
    this.uiContainer.addChild(this.minimapContainer);
    
    // Background circle
    const bg = new Graphics();
    bg.circle(this.MINIMAP_SIZE / 2, this.MINIMAP_SIZE / 2, this.MINIMAP_SIZE / 2);
    bg.fill({ color: 0x000000, alpha: 0.6 });
    bg.circle(this.MINIMAP_SIZE / 2, this.MINIMAP_SIZE / 2, this.MINIMAP_SIZE / 2);
    bg.stroke({ color: 0x44ffff, width: 2, alpha: 0.8 });
    this.minimapContainer.addChild(bg);
    
    // Graphics layer for entities
    this.minimapGraphics = new Graphics();
    this.minimapContainer.addChild(this.minimapGraphics);
    
    // Mask to keep dots inside circle
    const mask = new Graphics();
    mask.circle(this.MINIMAP_SIZE / 2, this.MINIMAP_SIZE / 2, this.MINIMAP_SIZE / 2 - 2);
    mask.fill({ color: 0xffffff });
    this.minimapContainer.addChild(mask);
    this.minimapGraphics.mask = mask;
  }

  // Seeded random number generator (mulberry32)
  private seededRandom(seed: number): () => number {
    return () => {
      let t = seed += 0x6D2B79F5;
      t = Math.imul(t ^ t >>> 15, t | 1);
      t ^= t + Math.imul(t ^ t >>> 7, t | 61);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  
  // Simple hash function for region keys
  private hashRegion(x: number, y: number, seed: number): number {
    let h = seed;
    h = Math.imul(h ^ x, 0x9E3779B9);
    h = Math.imul(h ^ y, 0x85EBCA6B);
    h = h ^ (h >>> 13);
    return h >>> 0;
  }
  
  // Hash function matching reference game
  private hash2(x: number, y: number, seed: number): number {
    let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed, 1442695041);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }
  
  // 2D Simplex noise for starfield density variation (matching reference)
  private readonly SIMPLEX_F2 = 0.5 * (Math.sqrt(3) - 1);
  private readonly SIMPLEX_G2 = (3 - Math.sqrt(3)) / 6;
  private readonly SIMPLEX_GRAD = [[1,1],[-1,1],[1,-1],[-1,-1],[1,0],[-1,0],[0,1],[0,-1]];
  
  private simplexNoise2D(x: number, y: number, seed: number = 0): number {
    const s = (x + y) * this.SIMPLEX_F2;
    const i = Math.floor(x + s);
    const j = Math.floor(y + s);
    const t = (i + j) * this.SIMPLEX_G2;
    const X0 = i - t;
    const Y0 = j - t;
    const x0 = x - X0;
    const y0 = y - Y0;
    
    let i1: number, j1: number;
    if (x0 > y0) { i1 = 1; j1 = 0; }
    else { i1 = 0; j1 = 1; }
    
    const x1 = x0 - i1 + this.SIMPLEX_G2;
    const y1 = y0 - j1 + this.SIMPLEX_G2;
    const x2 = x0 - 1 + 2 * this.SIMPLEX_G2;
    const y2 = y0 - 1 + 2 * this.SIMPLEX_G2;
    
    const perm = (n: number): number => {
      let h = Math.imul(n, 374761393) ^ Math.imul(seed, 668265263);
      h = Math.imul(h ^ (h >>> 13), 1274126177);
      return (h >>> 0) % 8;
    };
    
    const ii = i & 0xff;
    const jj = j & 0xff;
    const gi0 = perm(ii + perm(jj));
    const gi1 = perm(ii + i1 + perm(jj + j1));
    const gi2 = perm(ii + 1 + perm(jj + 1));
    
    let n0 = 0, n1 = 0, n2 = 0;
    
    let t0 = 0.5 - x0*x0 - y0*y0;
    if (t0 >= 0) {
      t0 *= t0;
      n0 = t0 * t0 * (this.SIMPLEX_GRAD[gi0][0] * x0 + this.SIMPLEX_GRAD[gi0][1] * y0);
    }
    
    let t1 = 0.5 - x1*x1 - y1*y1;
    if (t1 >= 0) {
      t1 *= t1;
      n1 = t1 * t1 * (this.SIMPLEX_GRAD[gi1][0] * x1 + this.SIMPLEX_GRAD[gi1][1] * y1);
    }
    
    let t2 = 0.5 - x2*x2 - y2*y2;
    if (t2 >= 0) {
      t2 *= t2;
      n2 = t2 * t2 * (this.SIMPLEX_GRAD[gi2][0] * x2 + this.SIMPLEX_GRAD[gi2][1] * y2);
    }
    
    return 70 * (n0 + n1 + n2); // Returns -1 to 1
  }
  
  // Generate stars for a region (cached)
  private getStarsForRegion(regionX: number, regionY: number, layer: StarLayerConfig): StarData[] {
    const key = `${regionX},${regionY},${layer.noiseSeed}`;
    
    if (this.starCache.has(key)) {
      return this.starCache.get(key)!;
    }
    
    const stars: StarData[] = [];
    
    // Use simplex noise for density variation (matching reference game)
    const noiseVal = this.simplexNoise2D(regionX * layer.noiseScale * 1000, regionY * layer.noiseScale * 1000, layer.noiseSeed);
    const noiseNorm = noiseVal * 0.5 + 0.5; // 0 to 1
    
    // Skip region if noise below threshold (creates sparse clusters)
    if (layer.noiseThreshold > 0 && noiseNorm < layer.noiseThreshold) {
      this.starCache.set(key, stars);
      return stars;
    }
    
    const noiseFactor = layer.noiseThreshold > 0 
      ? (noiseNorm - layer.noiseThreshold) / (1 - layer.noiseThreshold) // Remap above threshold
      : 0.3 + 0.7 * noiseNorm;
    const starCount = Math.floor(layer.baseCount * noiseFactor);
    
    if (starCount <= 0) {
      this.starCache.set(key, stars);
      return stars;
    }
    
    // Deterministic RNG for this region+layer (matching reference)
    const seed = Math.floor(this.hash2(regionX, regionY, layer.noiseSeed + 7919) * 0xffffffff);
    const rng = this.seededRandom(seed);
    
    const systemVisuals = SYSTEM_VISUALS[this.currentSystemId] || SYSTEM_VISUALS['sol'];
    
    for (let i = 0; i < starCount; i++) {
      const rx = (rng() - 0.5) * this.STARFIELD_SNAP;
      const ry = (rng() - 0.5) * this.STARFIELD_SNAP;
      const zRand = rng();
      
      // Base hue in blue-white range (matching reference: 180-260)
      let hue = 180 + rng() * 80;
      
      // Special star colors for certain systems
      if (systemVisuals.specialStarChance && rng() < systemVisuals.specialStarChance) {
        hue = systemVisuals.specialStarHue || hue;
      }
      
      stars.push({
        x: regionX * this.STARFIELD_SNAP + this.STARFIELD_SNAP * 0.5 + rx,
        y: regionY * this.STARFIELD_SNAP + this.STARFIELD_SNAP * 0.5 + ry,
        z: layer.zMin + zRand * (layer.zMax - layer.zMin),
        size: layer.minSize + rng() * (layer.maxSize - layer.minSize),
        hue,
        phase: rng() * Math.PI * 2,
        brightness: 0.5 + rng() * 0.5,
      });
    }
    
    this.starCache.set(key, stars);
    return stars;
  }
  
  setCurrentSystem(systemId: string): void {
    this.currentSystemId = systemId;
    // Clear star cache when changing systems (different star colors)
    this.starCache.clear();
  }

  update(delta: number): void {
    // Update animation time
    this.time += delta;
    
    // Update current system from state
    if (this.state.systemId && this.state.systemId !== this.currentSystemId) {
      this.currentSystemId = this.state.systemId;
    }
    
    // Update camera to follow player
    this.updateCamera();
    
    // Render background
    this.renderBackground();
    
    // Render entities
    this.renderEntities();

    // Render debug asteroid markers
    this.renderDebugAsteroidMarkers();
    
    // Update effects
    this.updateEffects(delta);
    
    // Render damage numbers
    this.renderDamageNumbers(delta);
    
    // Update minimap
    this.updateMinimap();
  }

  /**
   * Add debug asteroid markers (red X) for a limited duration.
   */
  showAsteroidDebug(points: { id: number; x: number; y: number }[], durationMs: number = 10000): void {
    const now = performance.now();
    const expiresAt = now + durationMs;
    // Clear previous markers so each debug pulse replaces the last
    this.debugAsteroidMarkers = [];
    for (const p of points) {
      this.debugAsteroidMarkers.push({ x: p.x, y: p.y, expiresAt });
    }
  }

  private renderDebugAsteroidMarkers(): void {
    const now = performance.now();
    this.debugAsteroidMarkers = this.debugAsteroidMarkers.filter(m => m.expiresAt > now);

    const g = this.debugAsteroidGraphics;
    g.clear();
    if (this.debugAsteroidMarkers.length === 0) return;

    const size = 20;
    for (const m of this.debugAsteroidMarkers) {
      g.moveTo(m.x - size, m.y - size);
      g.lineTo(m.x + size, m.y + size);
      g.moveTo(m.x - size, m.y + size);
      g.lineTo(m.x + size, m.y - size);
    }
    g.stroke({ color: 0xff3333, width: 2, alpha: 0.9 });
  }

  private updateCamera(): void {
    const playerPos = this.state.getPlayerPosition();
    
    // Smooth camera follow
    const lerpFactor = 0.1;
    this.cameraX += (playerPos.x - this.cameraX) * lerpFactor;
    this.cameraY += (playerPos.y - this.cameraY) * lerpFactor;
    
    // Apply camera transform to world container with screen shake
    const screenCenterX = this.app.screen.width / 2;
    const screenCenterY = this.app.screen.height / 2;
    
    const shakeX = this.state.screenShake.offsetX || 0;
    const shakeY = this.state.screenShake.offsetY || 0;
    
    this.worldContainer.x = screenCenterX - this.cameraX * this.cameraZoom + shakeX;
    this.worldContainer.y = screenCenterY - this.cameraY * this.cameraZoom + shakeY;
    this.worldContainer.scale.set(this.cameraZoom);
  }

  private renderBackground(): void {
    this.starsGraphics.clear();
    this.nebulaGraphics.clear();
    this.sunGraphics.clear();
    
    const w = this.app.screen.width;
    const h = this.app.screen.height;
    const zoom = this.cameraZoom;
    
    // Get system visuals
    const systemVisuals = SYSTEM_VISUALS[this.currentSystemId] || SYSTEM_VISUALS['sol'];
    const layers = systemVisuals.starLayers || DEFAULT_STAR_LAYERS;
    
    // Calculate grid for star regions
    const viewW = w / zoom;
    const viewH = h / zoom;
    const gridRadius = Math.ceil(Math.max(viewW, viewH) / this.STARFIELD_SNAP) + 1;
    const snapX = Math.floor(this.cameraX / this.STARFIELD_SNAP);
    const snapY = Math.floor(this.cameraY / this.STARFIELD_SNAP);
    const screenCenterX = w / 2;
    const screenCenterY = h / 2;
    
    // Draw each star layer (back to front)
    for (let layerIdx = layers.length - 1; layerIdx >= 0; layerIdx--) {
      const layer = layers[layerIdx];
      
      // Skip layer if zoom is too low
      if (zoom < layer.minZoom) continue;
      
      // Fade layer in as zoom approaches minZoom
      const layerAlphaMultiplier = layer.minZoom > 0 
        ? Math.min(1, (zoom - layer.minZoom) / (layer.minZoom * 0.5 + 0.1))
        : 1;
      if (layerAlphaMultiplier <= 0) continue;
      
      const depthRatio = (layer.zMin - 400) / (3000 - 400);
      
      // Loop through grid regions
      for (let dy = -gridRadius; dy <= gridRadius; dy++) {
        for (let dx = -gridRadius; dx <= gridRadius; dx++) {
          const regionX = snapX + dx;
          const regionY = snapY + dy;
          
          const stars = this.getStarsForRegion(regionX, regionY, layer);
          
          for (const star of stars) {
            // Perspective projection
            const scale = (this.STARFIELD_FOCAL / star.z) * zoom;
            const screenX = screenCenterX + (star.x - this.cameraX) * scale;
            const screenY = screenCenterY + (star.y - this.cameraY) * scale;
            
            // Cull off-screen stars
            const margin = star.size * 10;
            if (screenX < -margin || screenX > w + margin || 
                screenY < -margin || screenY > h + margin) continue;
            
            // Blink/twinkle effect
            const blinkSpeed = 0.2 + (1 - depthRatio) * 0.3;
            const blink = 0.75 + 0.25 * Math.sin(this.time * blinkSpeed + star.phase);
            
            // Alpha based on depth and layer visibility
            const baseAlpha = 0.5 + 0.5 * (1 - depthRatio);
            const alpha = baseAlpha * blink * layerAlphaMultiplier * star.brightness;
            
            if (alpha < 0.05) continue;
            
            const starRadius = Math.max(1, star.size * scale * 0.8);
            
            // Draw outer glow
            const glowRadius = starRadius * 4;
            const glowColor = this.hslToHex(star.hue, 50, 85);
            this.starsGraphics.circle(screenX, screenY, glowRadius);
            this.starsGraphics.fill({ color: glowColor, alpha: alpha * 0.2 });
            
            // Star core
            const coreColor = this.hslToHex(star.hue, 25, 92);
            this.starsGraphics.circle(screenX, screenY, starRadius);
            this.starsGraphics.fill({ color: coreColor, alpha });
            
            // Bright center for larger stars
            if (starRadius > 2) {
              this.starsGraphics.circle(screenX, screenY, starRadius * 0.4);
              this.starsGraphics.fill({ color: 0xffffff, alpha: alpha * 0.8 });
            }
          }
        }
      }
    }
    
    // Update and render GPU shader-based sun and glow
    // Use actual delta time scaled appropriately for animation speed
    const animDelta = 0.016; // ~60fps equivalent for consistent animation
    const screenSize = { width: this.app.screen.width, height: this.app.screen.height };
    
    // Position at world origin (0, 0)
    this.glowRenderer.setPosition(0, 0);
    this.sunRenderer.setPosition(0, 0);
    
    // Calculate LOD based on zoom (closer = more detail)
    // Zoom 0.1 = far (LOD 0), Zoom 2+ = close (LOD 1)
    const lodZoom = Math.max(0, Math.min(1, (this.cameraZoom - 0.1) / 1.9));
    this.glowRenderer.setLOD(lodZoom);
    this.sunRenderer.setLOD(lodZoom);

    const sunStyle = buildStyleParams(
      sunShaderDefs.sunStyles,
      systemVisuals.sunStyle,
      systemVisuals.sunStyleParams
    );
    const coronaStyle = buildStyleParams(
      sunShaderDefs.coronaStyles,
      systemVisuals.coronaStyle,
      systemVisuals.coronaStyleParams
    );
    this.sunRenderer.setSunStyle(sunStyle.index, sunStyle.params);
    this.sunRenderer.setCoronaStyle(coronaStyle.index, coronaStyle.params);
    
    // Update shaders with current system visuals
    // Pass camera position for parallax effect
    const glowRadius = systemVisuals.starRadius * 8;
    this.glowRenderer.update(animDelta, systemVisuals.starHue, systemVisuals.starRadius, glowRadius, this.cameraX, this.cameraY);
    this.sunRenderer.update(animDelta, systemVisuals.starHue, systemVisuals.starRadius, screenSize);
  }

  private renderEntities(): void {
    // Track which entities are still alive
    const aliveIds = new Set<number>();
    
    // Calculate visible bounds for culling
    const halfW = (this.app.screen.width / 2) / this.cameraZoom + this.CULL_MARGIN;
    const halfH = (this.app.screen.height / 2) / this.cameraZoom + this.CULL_MARGIN;
    const minX = this.cameraX - halfW;
    const maxX = this.cameraX + halfW;
    const minY = this.cameraY - halfH;
    const maxY = this.cameraY + halfH;
    
    for (const entity of this.state.entities.values()) {
      aliveIds.add(entity.id);
      
      // Culling - skip entities outside viewport (but always render player)
      if (entity.id !== this.state.playerId) {
        if (entity.x < minX || entity.x > maxX || entity.y < minY || entity.y > maxY) {
          // Hide if exists but out of view
          const existing = this.entityGraphics.get(entity.id);
          if (existing) {
            existing.visible = false;
          }
          continue;
        }
      }
      
      let container = this.entityGraphics.get(entity.id);
      
      if (!container) {
        // Create new graphics for this entity, passing entity data for size/type info
        container = this.createEntityGraphics(entity.type, entity.id, entity.data);
        this.entityGraphics.set(entity.id, container);
        this.entityContainer.addChild(container);
        
        // Spawn fire effect for new projectiles (muzzle flash)
        if (entity.type === EntityType.Projectile && !this.spawnedFireEffectIds.has(entity.id)) {
          this.spawnedFireEffectIds.add(entity.id);
          
          const weaponType = entity.data?.[0] || WeaponType.Cannon;
          const tier = entity.data?.[1] || 1;
          const hue = entity.data?.[2] ?? 200;
          
          // Map weapon type to string
          const weaponTypeMap: Record<number, string> = {
            [WeaponType.Cannon]: 'cannon',
            [WeaponType.Scatter]: 'scatter',
            [WeaponType.Missile]: 'missile',
            [WeaponType.Pulse]: 'pulse',
            [WeaponType.Mine]: 'mine',
            [WeaponType.Mining]: 'mining',
            [WeaponType.Laser]: 'laser',
          };
          const weaponTypeStr = weaponTypeMap[weaponType] || 'cannon';
          
          // Calculate muzzle position (where projectile spawned from)
          // Use spawn position if available, otherwise use current position
          const spawnX = entity.renderX;
          const spawnY = entity.renderY;
          
          this.spawnFireEffect(spawnX, spawnY, entity.renderAngle, weaponTypeStr, tier, hue);
        }
      }
      
      // Make visible
      container.visible = true;
      
      // Update position (use smooth render position)
      container.x = entity.renderX;
      container.y = entity.renderY;
      container.rotation = entity.renderAngle;
      
      // Update entity-specific visuals
      this.updateEntityVisuals(container, entity);
      
      // Update nametag (counter-rotate so text stays upright)
      const nameTag = container.getChildByName('nameTag') as Text;
      if (nameTag) {
        // Always counter-rotate to stay upright
        nameTag.rotation = -entity.renderAngle;
        if (entity.name) {
          nameTag.text = entity.name;
          nameTag.visible = true;
        }
      }
      // Also counter-rotate health bar elements (outside name check)
      const hbBg = container.getChildByName('healthBarBg') as Graphics;
      const hb = container.getChildByName('healthBar') as Graphics;
      if (hbBg) hbBg.rotation = -entity.renderAngle;
      if (hb) hb.rotation = -entity.renderAngle;
    }
    
    // Remove dead entities and save their trails for fading
    for (const [id, container] of this.entityGraphics) {
      if (!aliveIds.has(id)) {
        // Check if this was a projectile and save trail for fading
        const trail = this.trails.get(id);
        if (trail && trail.length > 1) {
          // Find the entity data for trail color info
          const dying = this.state.dyingEntities.get(id);
          if (dying) {
            const weaponType = dying.entity.data?.[0] || 0;
            const tier = dying.entity.data?.[1] || 1;
            const hue = dying.entity.data?.[2] ?? 200;
            
            this.dyingTrails.push({
              points: [...trail],
              weaponType,
              tier,
              hue,
              fadeProgress: 0
            });
          }
        }
        
        this.entityContainer.removeChild(container);
        container.destroy();
        this.entityGraphics.delete(id);
        this.trails.delete(id);
        this.spawnedFireEffectIds.delete(id); // Clean up fire effect tracking
      }
    }
  }

  private createEntityGraphics(type: EntityType, id: number, data?: number[]): Container {
    const container = new Container();
    
    switch (type) {
      case EntityType.Player:
        this.createPlayerGraphics(container, id === this.state.playerId);
        break;
      case EntityType.Enemy:
        this.createEnemyGraphics(container);
        break;
      case EntityType.Asteroid:
        // data[0] = size, data[1] = resourceType
        this.createAsteroidGraphics(container, id, data?.[0]);
        break;
      case EntityType.Projectile:
        // data[0] = weaponType, data[1] = tier  
        this.createProjectileGraphics(container, data);
        break;
      case EntityType.DroppedItem:
        this.createDroppedItemGraphics(container);
        break;
      case EntityType.Station:
        this.createStationGraphics(container);
        break;
      case EntityType.Portal:
        this.createPortalGraphics(container);
        break;
      default:
        // Default circle
        const g = new Graphics();
        g.circle(0, 0, 10);
        g.fill({ color: 0xffffff });
        container.addChild(g);
    }
    
    return container;
  }

  private createPlayerGraphics(container: Container, isLocalPlayer: boolean): void {
    const g = new Graphics();
    
    // Ship body
    g.moveTo(30, 0);
    g.lineTo(-15, 15);
    g.lineTo(-10, 0);
    g.lineTo(-15, -15);
    g.closePath();
    g.fill({ color: isLocalPlayer ? 0x44ff44 : 0x4488ff });
    g.stroke({ color: 0xffffff, width: 2 });
    
    // Engine glow
    const glow = new Graphics();
    glow.circle(-15, 0, 8);
    glow.fill({ color: 0xff8800, alpha: 0.5 });
    glow.label = 'engineGlow';
    
    container.addChild(g);
    container.addChild(glow);
    
    // Health bar (above ship) - old game style: semi-transparent bg, white border, red fill
    const healthBarBg = new Graphics();
    healthBarBg.rect(-17, -32, 35, 4);
    healthBarBg.fill({ color: 0x000000, alpha: 0.5 });
    healthBarBg.stroke({ color: 0xffffff, width: 1, alpha: 0.3 });
    healthBarBg.label = 'healthBarBg';
    healthBarBg.visible = false;  // Only show when damaged
    
    const healthBar = new Graphics();
    healthBar.rect(-17, -32, 35, 4);
    healthBar.fill({ color: 0xff3333 });
    healthBar.label = 'healthBar';
    healthBar.visible = false;  // Only show when damaged
    
    container.addChild(healthBarBg);
    container.addChild(healthBar);
    
    // Nametag (below ship)
    const nameTag = new Text({
      text: '',
      style: new TextStyle({
        fontFamily: 'Arial, sans-serif',
        fontSize: 11,
        fill: 0xffffff,
        align: 'center',
        dropShadow: {
          color: 0x000000,
          blur: 2,
          distance: 1,
          alpha: 0.8,
        },
      }),
    });
    nameTag.anchor.set(0.5, 0);
    nameTag.position.set(0, 38);
    nameTag.label = 'nameTag';
    container.addChild(nameTag);
  }

  private createEnemyGraphics(container: Container): void {
    const g = new Graphics();
    
    // Ice sprite - crystalline shape
    g.moveTo(0, -25);
    g.lineTo(20, 0);
    g.lineTo(10, 25);
    g.lineTo(-10, 25);
    g.lineTo(-20, 0);
    g.closePath();
    g.fill({ color: 0x88ddff, alpha: 0.8 });
    g.stroke({ color: 0xaaeeff, width: 2 });
    
    // Inner glow
    g.moveTo(0, -12);
    g.lineTo(10, 0);
    g.lineTo(5, 12);
    g.lineTo(-5, 12);
    g.lineTo(-10, 0);
    g.closePath();
    g.fill({ color: 0xaaeeff, alpha: 0.3 });
    
    container.addChild(g);
    
    // Health bar - old game style: semi-transparent bg, white border, blue fill
    const healthBarBg = new Graphics();
    healthBarBg.rect(-20, -40, 40, 5);
    healthBarBg.fill({ color: 0x000000, alpha: 0.5 });
    healthBarBg.stroke({ color: 0xffffff, width: 1, alpha: 0.3 });
    healthBarBg.label = 'healthBarBg';
    healthBarBg.visible = false;  // Only show when damaged
    
    const healthBar = new Graphics();
    healthBar.rect(-20, -40, 40, 5);
    healthBar.fill({ color: 0x4488ff });
    healthBar.label = 'healthBar';
    healthBar.visible = false;  // Only show when damaged
    healthBar.label = 'healthBar';
    
    container.addChild(healthBarBg);
    container.addChild(healthBar);
  }

  private createAsteroidGraphics(container: Container, entityId: number, size?: number): void {
    const g = new Graphics();
    g.label = 'asteroidShape';
    
    const actualSize = size || 30;
    
    // Use the SAME polygon generation as the server (shared from common/).
    // getAsteroidPolygon(id, cx, cy, size) — pass cx=cy=0 for local-space vertices.
    const vertices = getAsteroidPolygon(entityId, 0, 0, actualSize);
    
    // Draw the polygon
    g.moveTo(vertices[0].x, vertices[0].y);
    for (let i = 1; i < vertices.length; i++) {
      g.lineTo(vertices[i].x, vertices[i].y);
    }
    g.closePath();
    
    // Determine asteroid color — burn a fresh seeded RNG for cosmetic randomness
    // (same seed as polygon but the polygon already consumed some values,
    //  so we re-seed just for color to keep it stable)
    const colorRng = mulberry32(hashString(`asteroid-color:${entityId}`));
    const resourceType = Math.floor(colorRng() * 3);
    const colors = [
      { fill: 0x666666, stroke: 0x888888 },  // Rock
      { fill: 0x886644, stroke: 0xaa8866 },  // Iron
      { fill: 0x4488aa, stroke: 0x66aacc },  // Ice
    ];
    const color = colors[resourceType];
    
    g.fill({ color: color.fill });
    g.stroke({ color: color.stroke, width: 2 });
    
    // Add some surface detail
    for (let i = 0; i < 3; i++) {
      const cx = (colorRng() - 0.5) * actualSize * 1.2;
      const cy = (colorRng() - 0.5) * actualSize * 1.2;
      const cr = 3 + colorRng() * 5;
      g.circle(cx, cy, cr);
      g.fill({ color: color.fill, alpha: 0.5 });
    }
    
    container.addChild(g);
    // No scale — vertices are already at the correct size
  }

  private createProjectileGraphics(container: Container, data?: number[]): void {
    const g = new Graphics();
    g.label = 'projectileShape';
    
    // data[0] = weaponType, data[1] = tier, data[2] = hue (optional)
    const weaponType = data?.[0] || WeaponType.Cannon;
    const tier = data?.[1] || 1;
    const hue = data?.[2] ?? 200; // Default cyan-ish
    
    // Tier-based visual parameters
    const tierMultiplier = tier === 3 ? 1.3 : tier === 2 ? 1.15 : 1.0;
    const baseWidth = tier === 3 ? 10 : tier === 2 ? 8 : 6;
    
    // Convert hue to hex color
    const hslToHex = (h: number, s: number, l: number): number => {
      s /= 100;
      l /= 100;
      const a = s * Math.min(l, 1 - l);
      const f = (n: number) => {
        const k = (n + h / 30) % 12;
        return l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
      };
      const r = Math.round(f(0) * 255);
      const g = Math.round(f(8) * 255);
      const b = Math.round(f(4) * 255);
      return (r << 16) | (g << 8) | b;
    };
    
    const mainColor = hslToHex(hue, 100, 75);
    const brightColor = hslToHex(hue, 100, 88);
    const glowColor = hslToHex(hue, 100, 60);
    
    switch (weaponType) {
      case WeaponType.Cannon:
        // Blaster bullet - matching original game style
        // Outer glow
        g.circle(0, 0, baseWidth * tierMultiplier);
        g.fill({ color: glowColor, alpha: 0.25 });
        // Main body
        g.circle(0, 0, baseWidth * 0.6 * tierMultiplier);
        g.fill({ color: mainColor, alpha: 0.9 });
        // Bright core
        g.circle(0, 0, baseWidth * 0.3 * tierMultiplier);
        g.fill({ color: brightColor });
        // White center
        g.circle(0, 0, baseWidth * 0.15 * tierMultiplier);
        g.fill({ color: 0xffffff });
        break;
        
      case WeaponType.Scatter:
        // Smaller scatter pellets
        const scatterSize = baseWidth * 0.4 * tierMultiplier;
        g.circle(0, 0, scatterSize * 1.5);
        g.fill({ color: glowColor, alpha: 0.3 });
        g.circle(0, 0, scatterSize);
        g.fill({ color: mainColor });
        g.circle(0, 0, scatterSize * 0.4);
        g.fill({ color: 0xffffff, alpha: 0.8 });
        break;
        
      case WeaponType.Missile:
        // Missile shape with flame
        const missileLen = 12 * tierMultiplier;
        g.moveTo(missileLen, 0);
        g.lineTo(-missileLen * 0.5, missileLen * 0.4);
        g.lineTo(-missileLen * 0.3, 0);
        g.lineTo(-missileLen * 0.5, -missileLen * 0.4);
        g.closePath();
        g.fill({ color: 0x666688 });
        g.stroke({ color: mainColor, width: 1.5 });
        // Flame trail
        const flame = new Graphics();
        flame.label = 'missileFlame';
        flame.moveTo(-missileLen * 0.3, 0);
        flame.lineTo(-missileLen, missileLen * 0.35);
        flame.lineTo(-missileLen * 0.8, 0);
        flame.lineTo(-missileLen, -missileLen * 0.35);
        flame.closePath();
        flame.fill({ color: 0xff6600, alpha: 0.9 });
        container.addChild(flame);
        break;
        
      case WeaponType.Pulse:
        // Growing energy pulse
        const pulseSize = 15 * tierMultiplier;
        g.circle(0, 0, pulseSize);
        g.fill({ color: glowColor, alpha: 0.15 });
        g.circle(0, 0, pulseSize * 0.7);
        g.fill({ color: mainColor, alpha: 0.35 });
        g.circle(0, 0, pulseSize * 0.4);
        g.fill({ color: brightColor, alpha: 0.6 });
        g.circle(0, 0, pulseSize * 0.2);
        g.fill({ color: 0xffffff, alpha: 0.9 });
        break;
        
      case WeaponType.Mine:
        // Mine - spiked ball
        const mineRadius = 10 * tierMultiplier;
        const spikes = 8;
        for (let i = 0; i < spikes; i++) {
          const angle = (i / spikes) * Math.PI * 2;
          g.moveTo(Math.cos(angle) * mineRadius * 0.6, Math.sin(angle) * mineRadius * 0.6);
          g.lineTo(Math.cos(angle) * mineRadius, Math.sin(angle) * mineRadius);
        }
        g.stroke({ color: 0xff4444, width: 2.5 });
        g.circle(0, 0, mineRadius * 0.6);
        g.fill({ color: 0x331111 });
        g.stroke({ color: 0xff4444, width: 2 });
        // Glowing center
        g.circle(0, 0, mineRadius * 0.25);
        g.fill({ color: 0xff6666 });
        break;
        
      case WeaponType.Mining:
        // Mining projectile - golden drill
        const drillLen = 14 * tierMultiplier;
        g.moveTo(drillLen, 0);
        g.lineTo(-drillLen * 0.3, drillLen * 0.4);
        g.lineTo(-drillLen * 0.3, -drillLen * 0.4);
        g.closePath();
        g.fill({ color: 0xffcc00 });
        g.stroke({ color: 0xff9900, width: 1.5 });
        // Inner detail
        g.moveTo(drillLen * 0.5, 0);
        g.lineTo(-drillLen * 0.1, drillLen * 0.2);
        g.lineTo(-drillLen * 0.1, -drillLen * 0.2);
        g.closePath();
        g.fill({ color: 0xffee88 });
        break;
        
      default:
        // Default bullet
        g.circle(0, 0, 5);
        g.fill({ color: mainColor });
    }
    
    container.addChild(g);
  }

  private createDroppedItemGraphics(container: Container): void {
    const g = new Graphics();
    
    // Glowing orb
    g.circle(0, 0, 12);
    g.fill({ color: 0xffaa00, alpha: 0.8 });
    g.circle(0, 0, 8);
    g.fill({ color: 0xffff00 });
    
    container.addChild(g);
  }

  private createStationGraphics(container: Container): void {
    const g = new Graphics();
    
    // Station body
    g.rect(-100, -100, 200, 200);
    g.fill({ color: 0x444466 });
    g.stroke({ color: 0x6666aa, width: 4 });
    
    // Docking bay
    g.rect(-30, 80, 60, 25);
    g.fill({ color: 0x333344 });
    
    // Lights
    for (let i = 0; i < 4; i++) {
      const x = -80 + i * 50;
      g.circle(x, -80, 5);
      g.fill({ color: 0x44ff44 });
    }
    
    container.addChild(g);
  }

  private createPortalGraphics(container: Container): void {
    const g = new Graphics();
    
    // Swirling portal effect
    g.circle(0, 0, 150);
    g.fill({ color: 0x4400aa, alpha: 0.3 });
    g.circle(0, 0, 100);
    g.fill({ color: 0x6600cc, alpha: 0.5 });
    g.circle(0, 0, 50);
    g.fill({ color: 0x8800ff, alpha: 0.7 });
    g.circle(0, 0, 20);
    g.fill({ color: 0xffffff });
    
    container.addChild(g);
  }

  private updateEntityVisuals(container: Container, entity: any): void {
    // Update health bars - only show when damaged (old game style)
    const healthBar = container.getChildByName('healthBar') as Graphics;
    const healthBarBg = container.getChildByName('healthBarBg') as Graphics;
    if (healthBar && entity.hp !== undefined && entity.maxHp) {
      const healthPercent = entity.hp / entity.maxHp;
      const isDamaged = healthPercent < 1.0;
      
      healthBar.visible = isDamaged;
      if (healthBarBg) healthBarBg.visible = isDamaged;
      
      if (isDamaged) {
        healthBar.scale.x = healthPercent;
      }
    }
    
    // Update engine glow for players
    const engineGlow = container.getChildByName('engineGlow') as Graphics;
    if (engineGlow) {
      const speed = Math.sqrt(entity.vx * entity.vx + entity.vy * entity.vy);
      engineGlow.alpha = Math.min(1, speed / 10) * 0.8;
    }
    
    // Update projectile trails and effects
    if (entity.type === EntityType.Projectile) {
      let trail = this.trails.get(entity.id);
      if (!trail) {
        trail = [];
        this.trails.set(entity.id, trail);
      }
      
      trail.push({ x: entity.renderX, y: entity.renderY });
      
      // Trail length depends on weapon type
      const weaponType = entity.data?.[0] || WeaponType.Cannon;
      const maxTrailLength = this.getTrailLength(weaponType);
      
      while (trail.length > maxTrailLength) trail.shift();
      
      // Animate missile flame
      const flame = container.getChildByName('missileFlame') as Graphics;
      if (flame) {
        const flicker = 0.6 + Math.random() * 0.4;
        flame.alpha = flicker;
      }
    }
    
    // Rotate projectiles to face movement direction
    if (entity.type === EntityType.Projectile && entity.vx !== undefined && entity.vy !== undefined) {
      const speed = Math.sqrt(entity.vx * entity.vx + entity.vy * entity.vy);
      if (speed > 0.1) {
        container.rotation = Math.atan2(entity.vy, entity.vx);
      }
    }
  }
  
  private getTrailLength(weaponType: number): number {
    // Trail lengths - Cannon/blaster 3x longer for better visibility
    switch (weaponType) {
      case WeaponType.Cannon: return 60;    // 3x longer (was 20)
      case WeaponType.Scatter: return 36;   // 3x longer (was 12)
      case WeaponType.Missile: return 25;
      case WeaponType.Pulse: return 18;
      case WeaponType.Mine: return 5;
      case WeaponType.Mining: return 15;
      default: return 60;
    }
  }

  private updateEffects(delta: number): void {
    // Update particles
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i] as any;
      p.x += p.vx * delta * 60;
      p.y += p.vy * delta * 60;
      p.life -= delta;
      
      // Handle rotation for debris
      if (p.rotSpeed) {
        p.graphic.rotation += p.rotSpeed * delta;
      }
      
      if (p.life <= 0) {
        this.effectContainer.removeChild(p.graphic);
        p.graphic.destroy();
        this.particles.splice(i, 1);
      } else {
        p.graphic.x = p.x;
        p.graphic.y = p.y;
        p.graphic.alpha = p.life / p.maxLife;
        p.graphic.scale.set(p.life / p.maxLife * p.size);
      }
    }
    
    // Update dying trails fade
    this.updateDyingTrails(delta);
    
    // Update tractor beam animations
    this.updateTractorBeams(delta);
    
    // Client-side laser prediction for local player (runs before updateActiveLasers)
    this.updateLocalLaserPrediction();
    
    // All players' lasers from server snapshot data (aim angle + hit distance)
    this.updateSnapshotLasers();
    
    // Update active laser beams (fade out when not receiving updates)
    this.updateActiveLasers();
    
    // Update and render fire effects (muzzle flash)
    this.updateFireEffects(delta);
    
    // Render projectile trails
    this.renderTrails();
  }
  
  /** Update and remove expired dying trails */
  private updateDyingTrails(delta: number): void {
    const TRAIL_FADE_SPEED = 3.0; // Fade out over ~0.33 seconds
    
    for (let i = this.dyingTrails.length - 1; i >= 0; i--) {
      this.dyingTrails[i].fadeProgress += delta * TRAIL_FADE_SPEED;
      
      if (this.dyingTrails[i].fadeProgress >= 1.0) {
        this.dyingTrails.splice(i, 1);
      }
    }
  }
  
  /** Update and render fire effects (muzzle flash) - matching original game */
  private updateFireEffects(delta: number): void {
    for (let i = this.fireEffects.length - 1; i >= 0; i--) {
      const fx = this.fireEffects[i];
      fx.life += delta * 60; // Convert to frames (60 fps)
      
      if (fx.life >= fx.maxLife) {
        // Remove effect
        this.effectContainer.removeChild(fx.graphic);
        fx.graphic.destroy();
        this.fireEffects.splice(i, 1);
      } else {
        // Redraw with updated fade
        this.drawFireEffect(fx);
      }
    }
  }
  
  /** Draw a single fire effect frame - matching original game's FireEffect.draw() */
  private drawFireEffect(fx: FireEffect): void {
    const g = fx.graphic;
    g.clear();
    
    const n = fx.life / fx.maxLife;
    const fade = 1 - n;
    const tier = fx.tier;
    const hue = fx.hue;
    
    // Apply position and rotation
    g.x = fx.x;
    g.y = fx.y;
    g.rotation = fx.angle;
    
    // Use additive blending for glow
    g.blendMode = 'add';
    
    if (fx.weaponType === 'cannon') {
      const len = 16 + tier * 4;
      const width = 6 + tier * 2;
      
      // Main flash triangle
      g.poly([0, -width * 0.6, len, 0, 0, width * 0.6]);
      g.fill({ color: this.hslToHex(hue, 90, 65), alpha: 0.7 * fade });
      
      // Inner ring
      g.circle(0, 0, 6 + tier * 2);
      g.stroke({ color: this.hslToHex((hue + 40) % 360, 90, 80), width: 1.5, alpha: 0.6 * fade });
      
      // Tier 2+: Outer ring
      if (tier >= 2) {
        g.circle(0, 0, 12 + tier * 3);
        g.stroke({ color: this.hslToHex((hue + 80) % 360, 100, 85), width: 2, alpha: 0.5 * fade });
      }
      
      // Tier 3: Radial lines
      if (tier >= 3) {
        for (let i = 0; i < 6; i++) {
          const ang = (i / 6) * Math.PI * 2;
          g.moveTo(Math.cos(ang) * 4, Math.sin(ang) * 4);
          g.lineTo(Math.cos(ang) * 14, Math.sin(ang) * 14);
          g.stroke({ color: this.hslToHex((hue + 120) % 360, 100, 90), width: 1.4, alpha: 0.45 * fade });
        }
      }
      
      // Random spark lines
      for (let i = 0; i < 3 + tier; i++) {
        const ang = (Math.random() - 0.5) * 0.7;
        const sLen = 8 + Math.random() * 10;
        g.moveTo(0, 0);
        g.lineTo(Math.cos(ang) * sLen, Math.sin(ang) * sLen);
        g.stroke({ color: this.hslToHex((hue + 20) % 360, 100, 85), width: 1, alpha: 0.35 * fade });
      }
      
    } else if (fx.weaponType === 'scatter') {
      const len = 12 + tier * 3;
      const spread = 0.6 + tier * 0.1;
      
      // Fan shape
      g.poly([0, 0, len, -len * spread, len * 1.1, 0, len, len * spread]);
      g.fill({ color: this.hslToHex(hue, 95, 70), alpha: 0.6 * fade });
      
      // Center ring
      g.circle(0, 0, 8 + tier * 2);
      g.stroke({ color: this.hslToHex((hue + 30) % 360, 100, 85), width: 1.2, alpha: 0.5 * fade });
      
      // Tier 2+: spark lines
      if (tier >= 2) {
        for (let i = 0; i < 4 + tier; i++) {
          const ang = (Math.random() - 0.5) * 1.2;
          const sLen = 10 + Math.random() * 8;
          g.moveTo(0, 0);
          g.lineTo(Math.cos(ang) * sLen, Math.sin(ang) * sLen);
          g.stroke({ color: this.hslToHex((hue + 60) % 360, 100, 85), width: 1, alpha: 0.45 * fade });
        }
      }
      
      // Tier 3: Large outer ring
      if (tier >= 3) {
        g.circle(0, 0, 16);
        g.stroke({ color: this.hslToHex((hue + 120) % 360, 100, 90), width: 2.5, alpha: 0.4 * fade });
      }
      
      // Random small sparks
      for (let i = 0; i < 5 + tier; i++) {
        const ang = (Math.random() - 0.5) * 1.6;
        const sLen = 6 + Math.random() * 6;
        g.moveTo(0, 0);
        g.lineTo(Math.cos(ang) * sLen, Math.sin(ang) * sLen);
        g.stroke({ color: this.hslToHex((hue + 90) % 360, 100, 88), width: 0.9, alpha: 0.35 * fade });
      }
      
    } else if (fx.weaponType === 'pulse') {
      const len = 16 + tier * 5;
      
      // Center orb
      g.circle(0, 0, 8 + tier * 2.5);
      g.fill({ color: this.hslToHex(hue, 95, 70), alpha: 0.65 * fade });
      
      // Outer ring
      g.circle(0, 0, 14 + tier * 3.5);
      g.stroke({ color: this.hslToHex((hue + 40) % 360, 100, 85), width: 2.2, alpha: 0.55 * fade });
      
      // Spark lines
      for (let i = 0; i < 5 + tier; i++) {
        const ang = (Math.random() - 0.5) * 1.2;
        const sLen = 8 + Math.random() * 10;
        g.moveTo(0, 0);
        g.lineTo(Math.cos(ang) * sLen, Math.sin(ang) * sLen);
        g.stroke({ color: this.hslToHex((hue + 80) % 360, 100, 88), width: 1.2, alpha: 0.4 * fade });
      }
      
      // Directional flash
      g.moveTo(-4, -6);
      g.lineTo(len, 0);
      g.lineTo(-4, 6);
      g.stroke({ color: this.hslToHex((hue + 140) % 360, 100, 90), width: 1.6, alpha: 0.35 * fade });
      
    } else if (fx.weaponType === 'mine') {
      const size = 10 + tier * 3;
      
      // Center
      g.circle(0, 0, size);
      g.fill({ color: this.hslToHex(hue, 70, 45), alpha: 0.5 * fade });
      
      // Warning pulse ring
      g.circle(0, 0, size * 1.5 + n * 10);
      g.stroke({ color: 0xff3333, width: 2, alpha: 0.6 * fade });
      
      // Deploy lines
      for (let i = 0; i < 4; i++) {
        const ang = (i / 4) * Math.PI * 2 + Math.PI / 4;
        g.moveTo(Math.cos(ang) * size * 0.5, Math.sin(ang) * size * 0.5);
        g.lineTo(Math.cos(ang) * size * 2, Math.sin(ang) * size * 2);
        g.stroke({ color: this.hslToHex(hue, 80, 70), width: 1.5, alpha: 0.4 * fade });
      }
      
      if (tier >= 2) {
        g.circle(0, 0, size * 2.2);
        g.stroke({ color: this.hslToHex((hue + 60) % 360, 90, 75), width: 1.4, alpha: 0.35 * fade });
      }
      
      if (tier >= 3) {
        g.circle(0, 0, 4);
        g.fill({ color: 0xff4444, alpha: 0.5 * fade });
      }
      
    } else if (fx.weaponType === 'mining') {
      const len = 14 + tier * 4;
      
      // Main beam line
      g.moveTo(0, 0);
      g.lineTo(len, 0);
      g.stroke({ color: this.hslToHex((hue + 80) % 360, 85, 70), width: 2.2, alpha: 0.6 * fade });
      
      // Ring
      g.circle(0, 0, 10 + tier * 3);
      g.stroke({ color: this.hslToHex((hue + 30) % 360, 90, 80), width: 1.2, alpha: 0.35 * fade });
      
      // Spark lines
      for (let i = 0; i < 4 + tier; i++) {
        const ang = (Math.random() - 0.5) * 1.4;
        const sLen = 8 + Math.random() * 8;
        g.moveTo(0, 0);
        g.lineTo(Math.cos(ang) * sLen, Math.sin(ang) * sLen);
        g.stroke({ color: this.hslToHex((hue + 120) % 360, 90, 80), width: 1.4, alpha: 0.45 * fade });
      }
      
      if (tier >= 2) {
        g.moveTo(4, -6);
        g.lineTo(4, 6);
        g.stroke({ color: this.hslToHex((hue + 40) % 360, 100, 85), width: 1.6, alpha: 0.4 * fade });
      }
      
      if (tier >= 3) {
        g.poly([8, -8, 16, 0, 8, 8]);
        g.stroke({ color: this.hslToHex((hue + 160) % 360, 100, 90), width: 2, alpha: 0.45 * fade });
      }
      
    } else if (fx.weaponType === 'missile') {
      const flareLen = 18 + tier * 6;
      
      // Exhaust flare (pointing backward)
      g.poly([-flareLen, -5, 0, 0, -flareLen, 5]);
      g.fill({ color: this.hslToHex((hue + 10) % 360, 95, 65), alpha: 0.7 * fade });
      
      // Exhaust particles
      for (let i = 0; i < 3 + tier; i++) {
        const ex = -flareLen * (0.6 + Math.random() * 0.4);
        const ey = (Math.random() - 0.5) * 8;
        g.circle(ex, ey, 2 + Math.random() * 2);
        g.fill({ color: this.hslToHex((hue + 20) % 360, 100, 75), alpha: 0.35 * fade });
      }
      
      // Center glow ring
      g.circle(-2, 0, 6 + tier * 2);
      g.stroke({ color: this.hslToHex((hue + 60) % 360, 100, 85), width: 2, alpha: 0.5 * fade });
      
      if (tier >= 2) {
        g.moveTo(-flareLen * 0.8, -8);
        g.lineTo(-flareLen * 0.2, 0);
        g.lineTo(-flareLen * 0.8, 8);
        g.stroke({ color: this.hslToHex((hue + 100) % 360, 100, 88), width: 1.4, alpha: 0.4 * fade });
      }
      
      if (tier >= 3) {
        g.circle(2, 0, 14);
        g.stroke({ color: this.hslToHex((hue + 160) % 360, 100, 90), width: 2.4, alpha: 0.45 * fade });
      }
      
    } else if (fx.weaponType === 'laser') {
      // Central glow
      g.circle(0, 0, 6 + tier * 2);
      g.fill({ color: this.hslToHex((hue + 10) % 360, 100, 85), alpha: 0.7 * fade });
      
      // Directional flash
      g.moveTo(0, -2);
      g.lineTo(22 + tier * 6, 0);
      g.lineTo(0, 2);
      g.stroke({ color: this.hslToHex((hue + 40) % 360, 100, 90), width: 2, alpha: 0.5 * fade });
      
      if (tier >= 2) {
        g.circle(0, 0, 12 + tier * 2);
        g.stroke({ color: this.hslToHex((hue + 80) % 360, 100, 90), width: 1.6, alpha: 0.35 * fade });
      }
      
      if (tier >= 3) {
        for (let i = 0; i < 5; i++) {
          const ang = (i / 5) * Math.PI * 2;
          g.moveTo(Math.cos(ang) * 6, Math.sin(ang) * 6);
          g.lineTo(Math.cos(ang) * 16, Math.sin(ang) * 16);
          g.stroke({ color: this.hslToHex((hue + 140) % 360, 100, 92), width: 1.4, alpha: 0.4 * fade });
        }
      }
      
      // X pattern
      g.moveTo(-4, -4);
      g.lineTo(4, 4);
      g.moveTo(-4, 4);
      g.lineTo(4, -4);
      g.stroke({ color: this.hslToHex((hue + 200) % 360, 100, 88), width: 1.2, alpha: 0.3 * fade });
      
    } else if (fx.weaponType === 'warp') {
      // Warp gun fire effect - triplet of expanding orbs
      for (let i = 0; i < 3; i++) {
        const spread = Math.PI / 4;
        const ang = (i - 1) * spread;
        const dist = 10 + n * 20;
        const ox = Math.cos(ang) * dist;
        const oy = Math.sin(ang) * dist;
        
        const orbSize = 4 + n * 12;
        g.circle(ox, oy, orbSize);
        g.fill({ color: this.hslToHex(hue, 90, 60), alpha: 0.7 * fade });
        
        g.circle(ox, oy, orbSize * 1.5);
        g.stroke({ color: 0xff4444, width: 2, alpha: 0.5 * fade });
      }
      
      // Central flash
      g.circle(0, 0, 6 * (1 - n));
      g.fill({ color: this.hslToHex(hue, 100, 85), alpha: 0.8 * fade });
      
      // Warning pulse
      g.circle(0, 0, 20 + n * 30);
      g.stroke({ color: 0xff3333, width: 1.5, alpha: 0.4 * fade });
    }
    
    // Burst particles around all effects
    const burstCount = fx.weaponType === 'laser' ? 4
      : fx.weaponType === 'missile' ? 5
      : fx.weaponType === 'mining' ? 4
      : fx.weaponType === 'scatter' ? 6
      : fx.weaponType === 'pulse' ? 6
      : fx.weaponType === 'mine' ? 5
      : fx.weaponType === 'warp' ? 6
      : 4;
    
    for (let i = 0; i < burstCount; i++) {
      const ang = (i / burstCount) * Math.PI * 2 + (Math.random() - 0.5) * 0.4;
      const r = 6 + Math.random() * 10 + tier * 2;
      g.circle(Math.cos(ang) * r, Math.sin(ang) * r, 1.6 + Math.random() * 1.6);
      g.fill({ color: this.hslToHex((hue + i * 18) % 360, 100, 70), alpha: 0.35 * fade });
    }
  }
  
  /** Spawn a fire effect (muzzle flash) - matching original game's spawnFireEffect */
  spawnFireEffect(x: number, y: number, angle: number, weaponType: string, tier: number, hue: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    
    const maxLife = weaponType === 'laser' ? 10
      : weaponType === 'missile' ? 14
      : weaponType === 'pulse' ? 14
      : weaponType === 'mine' ? 16
      : 12;
    
    const g = new Graphics();
    this.effectContainer.addChild(g);
    
    this.fireEffects.push({
      x,
      y,
      angle,
      weaponType,
      tier: tier || 1,
      hue: Number.isFinite(hue) ? hue : 200,
      life: 0,
      maxLife,
      graphic: g,
    });
  }
  
  private renderTrails(): void {
    // Find existing trail graphics or create container
    let trailGraphics = this.effectContainer.getChildByName('trailLayer') as Graphics;
    if (!trailGraphics) {
      trailGraphics = new Graphics();
      trailGraphics.label = 'trailLayer';
      this.effectContainer.addChildAt(trailGraphics, 0); // Behind particles
    }
    
    trailGraphics.clear();
    
    // Render active projectile trails
    for (const entity of this.state.entities.values()) {
      if (entity.type !== EntityType.Projectile) continue;
      
      const trail = this.trails.get(entity.id);
      if (!trail || trail.length < 2) continue;
      
      const weaponType = entity.data?.[0] || WeaponType.Cannon;
      const tier = entity.data?.[1] || 1;
      const hue = entity.data?.[2] ?? 200;
      
      this.drawTrail(trailGraphics, trail, weaponType, tier, hue, 1.0);
      
      // Special effects for missiles - engine glow particles
      if (weaponType === WeaponType.Missile && trail.length > 0) {
        const lastPos = trail[trail.length - 1];
        // Add smoke particles occasionally
        if (Math.random() < 0.3) {
          this.addTrailParticle(lastPos.x, lastPos.y, 0xff8800);
        }
      }
    }
    
    // Render dying trails with fade effect
    for (const dyingTrail of this.dyingTrails) {
      const fadeAlpha = 1.0 - dyingTrail.fadeProgress;
      if (fadeAlpha > 0 && dyingTrail.points.length >= 2) {
        this.drawTrail(
          trailGraphics, 
          dyingTrail.points, 
          dyingTrail.weaponType, 
          dyingTrail.tier, 
          dyingTrail.hue, 
          fadeAlpha
        );
      }
    }
  }
  
  /** Draw a trail with given fade alpha - matching original game's visual style */
  private drawTrail(
    g: Graphics, 
    trail: Array<{x: number, y: number}>, 
    weaponType: number, 
    tier: number, 
    hue: number, 
    fadeAlpha: number
  ): void {
    if (trail.length < 2) return;
    
    const time = performance.now() * 0.001;
    const trailLen = trail.length;
    
    // Tier-based visual parameters (matching original)
    const baseWidth = tier === 3 ? 10 : tier === 2 ? 8 : 6;
    const baseAlphaBoost = (tier === 3 ? 1.0 : tier === 2 ? 0.9 : 0.8) * fadeAlpha;
    
    // Missile-specific effects
    if (weaponType === WeaponType.Missile) {
      const maxTrailLen = trail.length;
      
      // Mk3: Draw outer energy aura trail
      if (tier === 3) {
        for (let i = 0; i < trailLen - 1; i += 2) {
          const t = (i + 1) / maxTrailLen;
          const pulse = 0.5 + 0.5 * Math.sin(time * 8 + i * 0.3);
          const alpha = (1 - t) * 0.25 * pulse * fadeAlpha;
          const width = 20 * (1 - t * 0.5);
          const auraHue = (hue + 30) % 360;
          const auraColor = this.hslToHex(auraHue, 100, 80);
          
          const p1 = this.getWobbledTrailPoint(trail[i], time, i);
          const p2 = this.getWobbledTrailPoint(trail[i + 1], time, i + 1);
          
          g.moveTo(p1.x, p1.y);
          g.lineTo(p2.x, p2.y);
          g.stroke({ color: auraColor, width, alpha });
        }
      }
      
      // Mk2+: Draw secondary trail with complementary color
      if (tier >= 2) {
        const secondaryHue = (hue + 180) % 360;
        const secondaryColor = this.hslToHex(secondaryHue, 80, 70);
        
        for (let i = 0; i < trailLen - 1; i += 3) {
          const t = (i + 1) / maxTrailLen;
          const alpha = (1 - t) * 0.3 * fadeAlpha;
          const width = (tier === 3 ? 4 : 2) * (1 - t * 0.5);
          
          const p1 = this.getWobbledTrailPoint(trail[i], time, i);
          const p2 = this.getWobbledTrailPoint(trail[i + 1], time, i + 1);
          
          g.moveTo(p1.x, p1.y);
          g.lineTo(p2.x, p2.y);
          g.stroke({ color: secondaryColor, width, alpha });
        }
      }
      
      // Main trail segments with wobble
      for (let i = 0; i < trailLen - 1; i++) {
        const t = (i + 1) / maxTrailLen;
        const alpha = (1 - t) * baseAlphaBoost;
        const minWidth = 1.2;
        const maxWidth = baseWidth;
        const ageShrink = 1 - t * 0.15;
        const width = (minWidth + (maxWidth - minWidth) * t) * ageShrink;
        
        // Mk3: Rainbow shift along trail
        const trailHue = tier === 3 ? (hue + t * 60) % 360 : hue;
        const lightness = tier === 3 ? 95 - t * 20 : 90 - t * 30;
        const trailColor = this.hslToHex(trailHue, 100, lightness);
        
        const p1 = this.getWobbledTrailPoint(trail[i], time, i);
        const p2 = this.getWobbledTrailPoint(trail[i + 1], time, i + 1);
        
        g.moveTo(p1.x, p1.y);
        g.lineTo(p2.x, p2.y);
        g.stroke({ color: trailColor, width, alpha });
      }
      
      // Mk3: Sparkle particles along trail
      if (tier === 3 && trailLen > 5) {
        for (let i = 0; i < Math.min(trailLen, 20); i += 4) {
          const sparkle = 0.3 + 0.7 * Math.sin(time * 15 + i * 1.5);
          if (sparkle > 0.6) {
            const pt = trail[i];
            const sparkRadius = 3 * sparkle;
            const sparkColor = this.hslToHex((hue + 60) % 360, 100, 95);
            g.circle(pt.x, pt.y, sparkRadius);
            g.fill({ color: sparkColor, alpha: sparkle * 0.8 * fadeAlpha });
          }
        }
      }
      
    } else if (weaponType === WeaponType.Cannon || weaponType === WeaponType.Mining) {
      // Bullet/mining: Single gradient segment trail
      const trailColor = this.hslToHex(hue, 100, 75);
      const width = baseWidth * 1.4;
      
      // Draw with gradient from tail to head
      const startPt = trail[0];
      const endPt = trail[trail.length - 1];
      
      g.moveTo(startPt.x, startPt.y);
      g.lineTo(endPt.x, endPt.y);
      g.stroke({ color: trailColor, width, alpha: 0.8 * baseAlphaBoost });
      
    } else if (weaponType === WeaponType.Scatter) {
      // Scatter: shorter, fading trails
      const trailColor = this.hslToHex(hue, 100, 82);
      const width = baseWidth * 0.3;
      
      for (let i = 1; i < trail.length; i++) {
        const prev = trail[i - 1];
        const curr = trail[i];
        const t = i / trail.length;
        const alpha = t * t * 0.8 * baseAlphaBoost;
        
        g.moveTo(prev.x, prev.y);
        g.lineTo(curr.x, curr.y);
        g.stroke({ color: trailColor, width: width * (0.3 + t * 0.7), alpha });
      }
      
    } else if (weaponType === WeaponType.Pulse) {
      // Pulse: Growing trail with scale
      const trailColor = this.hslToHex(hue, 100, 72);
      const alpha = baseAlphaBoost * 0.75;
      const fullSize = 10; // Default pulse size
      
      if (trail.length >= 2) {
        const startPt = trail[0];
        const endPt = trail[trail.length - 1];
        
        g.moveTo(startPt.x, startPt.y);
        for (let i = 1; i < trail.length; i++) {
          g.lineTo(trail[i].x, trail[i].y);
        }
        g.stroke({ color: trailColor, width: baseWidth * 2, alpha });
      }
      
    } else {
      // Default trail
      const trailColor = this.hslToHex(hue, 100, 75);
      
      for (let i = 1; i < trail.length; i++) {
        const prev = trail[i - 1];
        const curr = trail[i];
        const t = i / trail.length;
        const alpha = t * t * 0.8 * fadeAlpha;
        const width = baseWidth * (0.3 + t * 0.7);
        
        g.moveTo(prev.x, prev.y);
        g.lineTo(curr.x, curr.y);
        g.stroke({ color: trailColor, width, alpha });
      }
    }
  }
  
  /** Get trail point with missile wobble effect */
  private getWobbledTrailPoint(pt: {x: number, y: number}, time: number, idx: number): {x: number, y: number} {
    const wobble = Math.sin(time * 6 + pt.x * 0.02 + idx * 0.4) * 2.2
      + Math.cos(time * 4 + pt.y * 0.015 - idx * 0.25) * 1.6;
    return { x: pt.x + wobble, y: pt.y + wobble * 0.6 };
  }
  
  private getTrailColor(weaponType: number, tier: number): number {
    const tierModifiers = [1.0, 0.8, 0.6, 0.4];
    
    switch (weaponType) {
      case WeaponType.Cannon:
        return [0xffff00, 0x88ff88, 0x88aaff, 0xcc88ff][Math.min(tier, 3)];
      case WeaponType.Scatter:
        return [0xffaa00, 0x66ff66, 0x6688ff, 0xaa66ff][Math.min(tier, 3)];
      case WeaponType.Missile:
        return 0xff4400; // Always orange-red flame
      case WeaponType.Pulse:
        return [0x00ffff, 0x44ffaa, 0x44aaff, 0xaa44ff][Math.min(tier, 3)];
      case WeaponType.Mine:
        return 0xff2222;
      case WeaponType.Mining:
        return 0xffaa44;
      default:
        return 0xffffff;
    }
  }
  
  private getTrailWidth(weaponType: number): number {
    switch (weaponType) {
      case WeaponType.Cannon: return 4;
      case WeaponType.Scatter: return 2;
      case WeaponType.Missile: return 6;
      case WeaponType.Pulse: return 8;
      case WeaponType.Mine: return 3;
      case WeaponType.Mining: return 4;
      default: return 4;
    }
  }
  
  private addTrailParticle(x: number, y: number, color: number): void {
    const g = new Graphics();
    g.circle(0, 0, 2 + Math.random() * 2);
    g.fill({ color, alpha: 0.6 });
    g.x = x + (Math.random() - 0.5) * 4;
    g.y = y + (Math.random() - 0.5) * 4;
    
    this.effectContainer.addChild(g);
    
    this.particles.push({
      x: g.x,
      y: g.y,
      vx: (Math.random() - 0.5) * 0.5,
      vy: (Math.random() - 0.5) * 0.5,
      life: 0.2 + Math.random() * 0.2,
      maxLife: 0.4,
      color,
      size: 0.5,
      graphic: g,
    });
  }
  
  /** Convert HSL to hex color (matching original game's color system) */
  private hslToHex(h: number, s: number, l: number): number {
    s /= 100;
    l /= 100;
    const a = s * Math.min(l, 1 - l);
    const f = (n: number) => {
      const k = (n + h / 30) % 12;
      return l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    };
    const r = Math.round(f(0) * 255);
    const g = Math.round(f(8) * 255);
    const b = Math.round(f(4) * 255);
    return (r << 16) | (g << 8) | b;
  }

  private renderDamageNumbers(delta: number): void {
    for (let i = this.damageNumbers.length - 1; i >= 0; i--) {
      const dn = this.damageNumbers[i];
      dn.lifetime -= delta;
      dn.y -= 30 * delta;  // Float up
      
      if (dn.lifetime <= 0) {
        this.effectContainer.removeChild(dn.text);
        dn.text.destroy();
        this.damageNumbers.splice(i, 1);
      } else {
        dn.text.x = dn.x;
        dn.text.y = dn.y;
        dn.text.alpha = Math.min(1, dn.lifetime * 2);
      }
    }
  }

  // Public methods for effects

  showDamageNumber(entityId: number, amount: number, critical?: boolean): void {
    const entity = this.state.getEntity(entityId);
    if (!entity) return;
    
    const style = new TextStyle({
      fontFamily: 'Arial',
      fontSize: critical ? 24 : 18,
      fill: critical ? 0xffff00 : 0xff4444,
      fontWeight: 'bold',
    });
    
    const text = new Text({
      text: Math.floor(amount).toString(),
      style,
    });
    text.anchor.set(0.5);
    text.x = entity.renderX;
    text.y = entity.renderY - 30;
    
    this.effectContainer.addChild(text);
    
    this.damageNumbers.push({
      x: entity.renderX,
      y: entity.renderY - 30,
      amount,
      critical: critical || false,
      lifetime: 1,
      text,
    });
  }

  showExplosion(entityId: number): void {
    const entity = this.state.getEntity(entityId);
    if (!entity) return;
    
    // Create explosion particles
    const particleCount = 30;
    for (let i = 0; i < particleCount; i++) {
      const angle = (i / particleCount) * Math.PI * 2;
      const speed = 2 + Math.random() * 4;
      
      const g = new Graphics();
      g.circle(0, 0, 5);
      g.fill({ color: Math.random() > 0.5 ? 0xff8800 : 0xffff00 });
      g.x = entity.renderX;
      g.y = entity.renderY;
      
      this.effectContainer.addChild(g);
      
      this.particles.push({
        x: entity.renderX,
        y: entity.renderY,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0.5 + Math.random() * 0.5,
        maxLife: 1,
        color: 0xff8800,
        size: 1,
        graphic: g,
      });
    }
  }

  showEffect(type: EffectType, x: number, y: number, data?: number[], targetX?: number, targetY?: number, entityId?: number): void {
    switch (type) {
      case EffectType.Explosion:
        this.createExplosionAt(x, y, data?.[0] || 100);
        break;
      case EffectType.LaserHit:
        // Laser beams are now rendered from snapshot data (see updateRemoteLasers / CURSOR_STATE.md).
        // The server no longer broadcasts per-fire LaserHit effects.
        // Fall through to bullet hit for any legacy messages.
        this.createBulletHitEffect(x, y, data?.[0] || 10, data?.[1] || 30);
        break;
      case EffectType.AsteroidBreak:
        this.createAsteroidBreakEffect(x, y, data?.[0] || 50, data?.[1] || 30);
        break;
      case EffectType.MineArm:
        this.createMineArmEffect(x, y);
        break;
      case EffectType.PickupItem:
        if (targetX !== undefined && targetY !== undefined) {
          this.createTractorBeam(x, y, targetX, targetY);
        }
        break;
      case EffectType.MissileTrail:
        // Handled by trail system
        break;
      case EffectType.MuzzleFlash:
        // data: [weaponType, tier, hue, angle]
        if (data && data.length >= 4) {
          const weaponTypeNum = data[0];
          const tier = data[1] || 1;
          const hue = data[2] ?? 200;
          const angle = data[3] || 0;
          
          // Map weapon type number to string
          const weaponTypeMap: Record<number, string> = {
            [WeaponType.Cannon]: 'cannon',
            [WeaponType.Scatter]: 'scatter',
            [WeaponType.Missile]: 'missile',
            [WeaponType.Pulse]: 'pulse',
            [WeaponType.Mine]: 'mine',
            [WeaponType.Mining]: 'mining',
            [WeaponType.Laser]: 'laser',
          };
          const weaponTypeStr = weaponTypeMap[weaponTypeNum] || 'cannon';
          
          this.spawnFireEffect(x, y, angle, weaponTypeStr, tier, hue);
        }
        break;
      // Add more effect types as needed
    }
  }
  
  private createMineArmEffect(x: number, y: number): void {
    // Pulsing ring effect when mine arms
    const g = new Graphics();
    g.circle(0, 0, 20);
    g.stroke({ color: 0xff4444, width: 3, alpha: 0.8 });
    g.x = x;
    g.y = y;
    
    this.effectContainer.addChild(g);
    
    let scale = 1;
    const pulseInterval = setInterval(() => {
      scale += 0.15;
      g.scale.set(scale);
      g.alpha = Math.max(0, 1 - (scale - 1) / 2);
      
      if (scale > 3) {
        clearInterval(pulseInterval);
        this.effectContainer.removeChild(g);
        g.destroy();
      }
    }, 16);
  }

  private createExplosionAt(x: number, y: number, radius: number): void {
    const particleCount = Math.floor(radius / 3); // More particles
    const debrisCount = Math.floor(radius / 10); // Add debris
    
    // Main explosion particles
    for (let i = 0; i < particleCount; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 1 + Math.random() * 4;
      const size = 2 + Math.random() * 4;
      
      // Vary colors from white/yellow core to orange/red edges
      const colorRoll = Math.random();
      const color = colorRoll < 0.2 ? 0xffffff 
                  : colorRoll < 0.4 ? 0xffffaa 
                  : colorRoll < 0.7 ? 0xff8800 
                  : 0xff4400;
      
      const g = new Graphics();
      g.circle(0, 0, size);
      g.fill({ color });
      g.x = x;
      g.y = y;
      
      this.effectContainer.addChild(g);
      
      this.particles.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0.2 + Math.random() * 0.5,
        maxLife: 0.7,
        color,
        size: 1.2,
        graphic: g,
      });
    }
    
    // Debris chunks
    for (let i = 0; i < debrisCount; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 2 + Math.random() * 3;
      const size = 3 + Math.random() * 5;
      
      const g = new Graphics();
      // Random polygon for debris
      const sides = 3 + Math.floor(Math.random() * 3);
      const points: number[] = [];
      for (let j = 0; j < sides; j++) {
        const a = (j / sides) * Math.PI * 2 + Math.random() * 0.5;
        const r = size * (0.5 + Math.random() * 0.5);
        points.push(Math.cos(a) * r, Math.sin(a) * r);
      }
      g.poly(points);
      g.fill({ color: 0x666666 });
      g.stroke({ color: 0x888888, width: 1 });
      g.x = x;
      g.y = y;
      g.rotation = Math.random() * Math.PI * 2;
      
      this.effectContainer.addChild(g);
      
      // Add with spin effect
      const rotSpeed = (Math.random() - 0.5) * 10;
      this.particles.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0.5 + Math.random() * 0.5,
        maxLife: 1.0,
        color: 0x666666,
        size: 1,
        graphic: g,
        rotSpeed, // Custom rotation speed
      } as any);
    }
    
    // Central flash
    const flash = new Graphics();
    flash.circle(0, 0, radius * 0.8);
    flash.fill({ color: 0xffffff, alpha: 0.8 });
    flash.x = x;
    flash.y = y;
    this.effectContainer.addChild(flash);
    
    // Animate flash
    let flashAlpha = 0.8;
    const flashFade = setInterval(() => {
      flashAlpha -= 0.2;
      flash.alpha = Math.max(0, flashAlpha);
      flash.scale.set(1 + (0.8 - flashAlpha));
      if (flashAlpha <= 0) {
        clearInterval(flashFade);
        this.effectContainer.removeChild(flash);
        flash.destroy();
      }
    }, 32);
    
    // Trigger screen shake for nearby explosions
    const player = this.state.entities.get(this.state.playerId);
    if (player) {
      const dx = player.x - x;
      const dy = player.y - y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const maxDist = 500;
      if (dist < maxDist) {
        const intensity = ((maxDist - dist) / maxDist) * (radius / 50);
        this.state.triggerScreenShake(Math.min(intensity, 15), 0.3);
      }
    }
  }

  // Helper to spawn laser particles for beam and impact
  private spawnLaserParticle(x: number, y: number, angle: number, hue: number): void {
    if (this.particles.length >= 200) return; // Cap to prevent GC pressure / jitter growth
    const speed = 0.5 + Math.random() * 1;
    const [r, g, b] = this.hslToRgb(hue, 100, 70);
    const color = (r << 16) | (g << 8) | b;
    
    const spark = new Graphics();
    spark.circle(0, 0, 1 + Math.random() * 2);
    spark.fill({ color });
    spark.x = x;
    spark.y = y;
    
    this.effectContainer.addChild(spark);
    
    this.particles.push({
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 0.2 + Math.random() * 0.2,
      maxLife: 0.4,
      color,
      size: 0.5,
      graphic: spark,
    });
  }
  
  // HSL to RGB conversion (matching original game)
  private hslToRgb(h: number, s: number, l: number): [number, number, number] {
    return Renderer.hslToRgbStatic(h, s, l);
  }
  
  private static hslToRgbStatic(h: number, s: number, l: number): [number, number, number] {
    h = h % 360;
    s = s / 100;
    l = l / 100;
    const a = s * Math.min(l, 1 - l);
    const f = (n: number) => {
      const k = (n + h / 30) % 12;
      return l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    };
    return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
  }
  
  // Angle lerp helper
  private lerpAngle(from: number, to: number, t: number): number {
    let diff = to - from;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    return from + diff * t;
  }
  
  /**
   * Client-side laser prediction for the local player.
   * Shows the beam immediately using the local aim angle and performs
   * polygon hitscan against interpolated asteroids for pixel-perfect hits.
   */
  private updateLocalLaserPrediction(): void {
    const player = this.state.entities.get(this.state.playerId);
    if (!player) return;
    
    // Check both weapon slots for laser
    const equipment = this.state.equipment;
    const slots: { firing: boolean; weaponId: string | null }[] = [
      { firing: this.localFireLeft, weaponId: equipment.leftWeapon },
      { firing: this.localFireRight, weaponId: equipment.rightWeapon },
    ];
    
    for (const slot of slots) {
      if (!slot.firing || !slot.weaponId) continue;
      
      const itemInfo = ITEM_DATA.get(slot.weaponId);
      if (!itemInfo || itemInfo.weaponType !== 'laser') continue;
      
      const range = LASER_RANGE * (itemInfo.range || 1);
      
      // Laser fires from ship nose in ship's facing direction.
      // Using ship angle (not aim angle) ensures client-server determinism.
      const shipAngle = player.renderAngle || player.angle || 0;
      const SHIP_TIP_OFFSET = 30; // Must match server fireLaser offset
      const tipX = player.renderX + Math.cos(shipAngle) * SHIP_TIP_OFFSET;
      const tipY = player.renderY + Math.sin(shipAngle) * SHIP_TIP_OFFSET;
      
      // Beam direction also uses ship angle for determinism
      const rawEndX = tipX + Math.cos(shipAngle) * range;
      const rawEndY = tipY + Math.sin(shipAngle) * range;
      
      // Client-side polygon hitscan against interpolated asteroids + enemies
      const hitT = this.laserHitscan(tipX, tipY, rawEndX, rawEndY, this.state.playerId);
      const endX = tipX + (rawEndX - tipX) * hitT;
      const endY = tipY + (rawEndY - tipY) * hitT;
      
      const entityId = this.state.playerId;
      const hue = 30;
      
      let laser = this.activeLasers.get(entityId);
      if (!laser) {
        const g = new Graphics();
        this.effectContainer.addChild(g);
        laser = {
          graphic: g,
          targetEndX: endX,
          targetEndY: endY,
          displayEndX: endX,
          displayEndY: endY,
          collisionDist: range * hitT,
          powerTime: 0,
          hue: hue,
          lastUpdateTime: performance.now(),
          entityId: entityId,
          aimAngle: shipAngle, // Store ship angle for fade-out tracking
          range: range,
        };
        this.activeLasers.set(entityId, laser);
      }
      
      // Update target — the endpoint tracks the hitscan result each frame
      laser.targetEndX = endX;
      laser.targetEndY = endY;
      laser.collisionDist = range * hitT;
      laser.lastUpdateTime = performance.now();
      laser.aimAngle = shipAngle; // Track ship angle for fade-out
      laser.range = range;
      
      // Only process first laser weapon (one beam per player)
      return;
    }
  }

  /**
   * Perform client-side ray vs polygon hitscan against all nearby entities.
   * Returns parametric t (0–1) along the ray where the nearest hit occurs.
   * Uses the shared getAsteroidPolygon from common/ for pixel-perfect polygon match.
   */
  private laserHitscan(
    startX: number, startY: number,
    endX: number, endY: number,
    shooterId: number,
  ): number {
    let bestT = 1.0;
    
    // Pre-compute ray direction for circle collision
    const rdx = endX - startX;
    const rdy = endY - startY;
    const len = Math.sqrt(rdx * rdx + rdy * rdy);
    if (len < 1) return bestT;
    const nx = rdx / len;
    const ny = rdy / len;
    
    for (const entity of this.state.entities.values()) {
      if (entity.id === shooterId) continue;
      
      if (entity.type === EntityType.Asteroid) {
        // Polygon hitscan — use true position (entity.x/y) not renderX/Y
        // renderX/Y has lerp smoothing lag which causes desync with server hitscan
        const size = entity.data?.[0] || 30;
        const poly = getAsteroidPolygon(entity.id, entity.x, entity.y, size);
        const t = raycastPolygon(startX, startY, endX, endY, poly);
        if (t !== null && t < bestT) {
          bestT = t;
        }
      } else if (entity.type === EntityType.Enemy) {
        // Circle collision for enemies — use true position
        const ex = entity.x;
        const ey = entity.y;
        const er = 25; // enemy radius
        const toEx = ex - startX;
        const toEy = ey - startY;
        const proj = toEx * nx + toEy * ny;
        if (proj < 0 || proj > len) continue;
        const perpDist = Math.abs(toEx * ny - toEy * nx);
        const t = proj / len;
        if (perpDist < er && t < bestT) {
          bestT = t;
        }
      }
    }
    
    return bestT;
  }

  /**
   * Render ALL players' lasers using snapshot data for aim angle + active flags,
   * with client-side polygon hitscan for beam endpoint.
   */
  private updateSnapshotLasers(): void {
    for (const entity of this.state.entities.values()) {
      if (entity.type !== EntityType.Player) continue;
      if (!entity.data || entity.data.length < 1) continue;
      
      const packed = entity.data[0];
      if (packed === 0 || packed === undefined) continue;
      
      const cursor = unpackCursorWeaponState(packed);
      
      if (!cursor.leftActive && !cursor.rightActive) continue;
      
      // For the local player, updateLocalLaserPrediction already set the target.
      // We still run hitscan here so the endpoint gets refined each frame,
      // but we use the local angle (which is more responsive).
      const isLocal = entity.id === this.state.playerId;
      const angle = isLocal ? this.localTargetAngle : cursor.aimAngle;
      
      // Both tip offset and beam direction use the aim angle (toward cursor)
      const SHIP_TIP_OFFSET = 30; // Must match server fireLaser offset
      const tipX = entity.renderX + Math.cos(angle) * SHIP_TIP_OFFSET;
      const tipY = entity.renderY + Math.sin(angle) * SHIP_TIP_OFFSET;
      
      const range = LASER_RANGE;
      const rawEndX = tipX + Math.cos(angle) * range;
      const rawEndY = tipY + Math.sin(angle) * range;
      
      // Client-side polygon hitscan for beam endpoint
      const hitT = this.laserHitscan(tipX, tipY, rawEndX, rawEndY, entity.id);
      const endX = tipX + (rawEndX - tipX) * hitT;
      const endY = tipY + (rawEndY - tipY) * hitT;
      
      const hue = 30;
      let laser = this.activeLasers.get(entity.id);
      if (!laser) {
        const g = new Graphics();
        this.effectContainer.addChild(g);
        laser = {
          graphic: g,
          targetEndX: endX,
          targetEndY: endY,
          displayEndX: endX,
          displayEndY: endY,
          collisionDist: range * hitT,
          powerTime: 0,
          hue: hue,
          lastUpdateTime: performance.now(),
          entityId: entity.id,
          aimAngle: angle,
          range: range,
        };
        this.activeLasers.set(entity.id, laser);
      }
      
      laser.targetEndX = endX;
      laser.targetEndY = endY;
      laser.collisionDist = range * hitT;
      laser.lastUpdateTime = performance.now();
      laser.aimAngle = angle;
      laser.range = range;
      
      // Power ramp-up
      laser.powerTime = Math.min(15, laser.powerTime + 1);
      const power = laser.powerTime / 15;
      
      // Smooth interpolation of hit point
      const lerpSpeed = isLocal ? 0.5 : 0.3;
      laser.displayEndX += (laser.targetEndX - laser.displayEndX) * lerpSpeed;
      laser.displayEndY += (laser.targetEndY - laser.displayEndY) * lerpSpeed;
      
      const x1 = tipX;
      const y1 = tipY;
      const x2 = laser.displayEndX;
      const y2 = laser.displayEndY;
      const beamAngle = Math.atan2(y2 - y1, x2 - x1);
      
      const time = performance.now() * 0.01;
      const flicker = 0.9 + Math.sin(time * 3) * 0.07 + Math.sin(time * 7) * 0.03;
      const alpha = power * flicker;
      
      const gfx = laser.graphic;
      gfx.clear();
      
      // Beam particle (reduced rate to cut GC pressure)
      if (this.particles.length < 200 && Math.random() < 0.08 * power) {
        const t = Math.random();
        const px = x1 + (x2 - x1) * t;
        const py = y1 + (y2 - y1) * t;
        this.spawnLaserParticle(px, py, beamAngle + Math.PI / 2, hue);
      }
      
      // Impact particle
      if (this.particles.length < 200 && alpha > 0.3 && Math.random() < 0.1 * power) {
        this.spawnLaserParticle(x2, y2, Math.random() * Math.PI * 2, hue);
      }
      
      const outerColor = this.LASER_COLOR_OUTER;
      const midColor = this.LASER_COLOR_MID;
      
      // Outer glow
      gfx.moveTo(x1, y1);
      gfx.lineTo(x2, y2);
      gfx.stroke({ color: outerColor, width: 8 + power * 10, alpha: alpha * 0.2 });
      
      // Mid glow
      gfx.moveTo(x1, y1);
      gfx.lineTo(x2, y2);
      gfx.stroke({ color: midColor, width: 3 + power * 4, alpha: alpha * 0.4 });
      
      // Core beam
      gfx.moveTo(x1, y1);
      gfx.lineTo(x2, y2);
      gfx.stroke({ color: 0xffffff, width: 1.5 + power * 2, alpha: alpha });
      
      // Impact glow
      if (alpha > 0.1) {
        const impactSize = 8 + power * 12 + Math.sin(time * 5) * 3 * power;
        gfx.circle(x2, y2, impactSize);
        gfx.fill({ color: midColor, alpha: alpha * 0.3 });
        gfx.circle(x2, y2, 3 + power * 2);
        gfx.fill({ color: 0xffffff, alpha: alpha * 0.8 });
      }
    }
  }

  // Update active lasers (call from render loop)
  private updateActiveLasers(): void {
    const now = performance.now();
    const LASER_TIMEOUT = 200; // ms before laser fades (>1 snapshot interval at 20Hz)
    
    for (const [entityId, laser] of this.activeLasers) {
      const timeSinceUpdate = now - laser.lastUpdateTime;
      
      if (timeSinceUpdate > LASER_TIMEOUT) {
        // Fade out by reducing powerTime
        laser.powerTime = Math.max(0, laser.powerTime - 1.5);

        if (laser.powerTime <= 0) {
          // Remove the laser
          this.effectContainer.removeChild(laser.graphic);
          laser.graphic.destroy();
          this.activeLasers.delete(entityId);
          continue;
        }

        // Keep the beam attached to the ship while fading
        // Use the ship's CURRENT angle for both tip position and beam direction
        const entity = this.state.entities.get(entityId);
        if (!entity) continue;

        // Ship tip and beam both use ship's facing angle
        const shipAngle = entity.renderAngle || entity.angle || 0;
        const SHIP_TIP_OFFSET = 30;
        const tipX = entity.renderX + Math.cos(shipAngle) * SHIP_TIP_OFFSET;
        const tipY = entity.renderY + Math.sin(shipAngle) * SHIP_TIP_OFFSET;

        // Beam direction uses ship angle
        const rawEndX = tipX + Math.cos(shipAngle) * laser.range;
        const rawEndY = tipY + Math.sin(shipAngle) * laser.range;

        const hitT = this.laserHitscan(tipX, tipY, rawEndX, rawEndY, entityId);
        const endX = tipX + (rawEndX - tipX) * hitT;
        const endY = tipY + (rawEndY - tipY) * hitT;

        laser.displayEndX = endX;
        laser.displayEndY = endY;

        const power = laser.powerTime / 15;
        const time = performance.now() * 0.01;
        const flicker = 0.9 + Math.sin(time * 3) * 0.07 + Math.sin(time * 7) * 0.03;
        const alpha = power * flicker;

        const gfx = laser.graphic;
        gfx.clear();

        const outerColor = this.LASER_COLOR_OUTER;
        const midColor = this.LASER_COLOR_MID;

        // Outer glow
        gfx.moveTo(tipX, tipY);
        gfx.lineTo(endX, endY);
        gfx.stroke({ color: outerColor, width: 8 + power * 10, alpha: alpha * 0.2 });

        // Mid glow
        gfx.moveTo(tipX, tipY);
        gfx.lineTo(endX, endY);
        gfx.stroke({ color: midColor, width: 3 + power * 4, alpha: alpha * 0.4 });

        // Core beam
        gfx.moveTo(tipX, tipY);
        gfx.lineTo(endX, endY);
        gfx.stroke({ color: 0xffffff, width: 1.5 + power * 2, alpha: alpha });

        // Impact glow
        if (alpha > 0.1) {
          const impactSize = 8 + power * 12 + Math.sin(time * 5) * 3 * power;
          gfx.circle(endX, endY, impactSize);
          gfx.fill({ color: midColor, alpha: alpha * 0.3 });
          gfx.circle(endX, endY, 3 + power * 2);
          gfx.fill({ color: 0xffffff, alpha: alpha * 0.8 });
        }
      }
    }
  }

  private createTractorBeam(startX: number, startY: number, targetX: number, targetY: number): void {
    const g = new Graphics();
    this.effectContainer.addChild(g);
    
    this.tractorBeams.push({
      startX,
      startY,
      targetX,
      targetY,
      progress: 0,
      graphic: g,
    });
  }
  
  private updateTractorBeams(dt: number): void {
    const completed: TractorBeam[] = [];
    
    for (const beam of this.tractorBeams) {
      beam.progress += dt * 2.5; // ~0.4 second animation
      
      if (beam.progress >= 1) {
        completed.push(beam);
        continue;
      }
      
      const g = beam.graphic;
      g.clear();
      
      // Animate the item moving toward the player
      const t = beam.progress;
      const easeT = 1 - Math.pow(1 - t, 3); // Ease out cubic
      
      const currentX = beam.startX + (beam.targetX - beam.startX) * easeT;
      const currentY = beam.startY + (beam.targetY - beam.startY) * easeT;
      
      // Draw tractor beam
      const dx = beam.targetX - beam.startX;
      const dy = beam.targetY - beam.startY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      
      // Pulsing energy beam from player to item pickup point
      const pulse = Math.sin(t * Math.PI * 8) * 0.3 + 0.7;
      const beamWidth = 3 + pulse * 2;
      
      // Outer glow
      g.moveTo(beam.targetX, beam.targetY);
      g.lineTo(currentX, currentY);
      g.stroke({ color: 0x00ffff, width: beamWidth + 8, alpha: 0.15 * (1 - t) });
      
      // Mid glow
      g.moveTo(beam.targetX, beam.targetY);
      g.lineTo(currentX, currentY);
      g.stroke({ color: 0x44ffff, width: beamWidth + 4, alpha: 0.3 * (1 - t) });
      
      // Core beam
      g.moveTo(beam.targetX, beam.targetY);
      g.lineTo(currentX, currentY);
      g.stroke({ color: 0xaaffff, width: beamWidth, alpha: 0.6 * (1 - t) });
      
      // Bright center
      g.moveTo(beam.targetX, beam.targetY);
      g.lineTo(currentX, currentY);
      g.stroke({ color: 0xffffff, width: 1, alpha: 0.8 * (1 - t) });
      
      // Item dot at current position
      const dotSize = 6 * (1 - t * 0.5);
      g.circle(currentX, currentY, dotSize + 4);
      g.fill({ color: 0x00ffff, alpha: 0.3 });
      g.circle(currentX, currentY, dotSize);
      g.fill({ color: 0xffffff, alpha: 0.8 });
      
      // Sparkle particles along beam
      if (Math.random() < 0.3) {
        const sparkT = Math.random();
        const sparkX = beam.targetX + (currentX - beam.targetX) * sparkT;
        const sparkY = beam.targetY + (currentY - beam.targetY) * sparkT;
        
        const spark = new Graphics();
        spark.circle(0, 0, 2 + Math.random() * 2);
        spark.fill({ color: 0x88ffff, alpha: 0.8 });
        spark.x = sparkX + (Math.random() - 0.5) * 10;
        spark.y = sparkY + (Math.random() - 0.5) * 10;
        
        this.effectContainer.addChild(spark);
        
        this.particles.push({
          x: spark.x,
          y: spark.y,
          vx: (Math.random() - 0.5) * 2,
          vy: (Math.random() - 0.5) * 2,
          life: 0.2,
          maxLife: 0.2,
          color: 0x88ffff,
          size: 0.5,
          graphic: spark,
        });
      }
    }
    
    // Remove completed beams
    for (const beam of completed) {
      this.effectContainer.removeChild(beam.graphic);
      beam.graphic.destroy();
      const idx = this.tractorBeams.indexOf(beam);
      if (idx !== -1) this.tractorBeams.splice(idx, 1);
    }
  }

  /**
   * Create a bullet hit effect at a position (hitting asteroid/enemy)
   */
  private createBulletHitEffect(x: number, y: number, damage: number, hue: number): void {
    // Convert hue to RGB color
    const color = this.hueToColor(hue);
    
    // Flash at impact point
    const flash = new Graphics();
    flash.circle(0, 0, 8 + damage * 0.5);
    flash.fill({ color: 0xffffff, alpha: 0.8 });
    flash.circle(0, 0, 5 + damage * 0.3);
    flash.fill({ color: color, alpha: 0.9 });
    flash.x = x;
    flash.y = y;
    
    this.effectContainer.addChild(flash);
    
    // Fade out flash
    let alpha = 1;
    const fadeInterval = setInterval(() => {
      alpha -= 0.2;
      flash.alpha = Math.max(0, alpha);
      if (alpha <= 0) {
        clearInterval(fadeInterval);
        this.effectContainer.removeChild(flash);
        flash.destroy();
      }
    }, 16);
    
    // Spark particles
    const sparkCount = Math.min(12, 4 + Math.floor(damage / 5));
    for (let i = 0; i < sparkCount; i++) {
      const sparkAngle = Math.random() * Math.PI * 2;
      const sparkSpeed = 2 + Math.random() * 4;
      
      const spark = new Graphics();
      spark.circle(0, 0, 1.5 + Math.random() * 1.5);
      spark.fill({ color: Math.random() > 0.3 ? color : 0xffffff });
      spark.x = x;
      spark.y = y;
      
      this.effectContainer.addChild(spark);
      
      this.particles.push({
        x,
        y,
        vx: Math.cos(sparkAngle) * sparkSpeed,
        vy: Math.sin(sparkAngle) * sparkSpeed,
        life: 0.15 + Math.random() * 0.15,
        maxLife: 0.3,
        color,
        size: 0.6,
        graphic: spark,
      });
    }
  }

  /**
   * Create asteroid break/destroy effect
   */
  private createAsteroidBreakEffect(x: number, y: number, size: number, hue: number): void {
    const color = this.hueToColor(hue);
    const particleCount = Math.min(30, Math.floor(size / 3));
    
    // Central flash
    const flash = new Graphics();
    flash.circle(0, 0, size * 1.2);
    flash.fill({ color: 0xffffff, alpha: 0.6 });
    flash.x = x;
    flash.y = y;
    
    this.effectContainer.addChild(flash);
    
    // Expand and fade flash
    let scale = 1;
    const expandInterval = setInterval(() => {
      scale += 0.15;
      flash.scale.set(scale);
      flash.alpha = Math.max(0, 0.6 - (scale - 1) * 0.3);
      if (scale > 2.5) {
        clearInterval(expandInterval);
        this.effectContainer.removeChild(flash);
        flash.destroy();
      }
    }, 16);
    
    // Rock debris particles
    for (let i = 0; i < particleCount; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 1 + Math.random() * 4;
      const pSize = 2 + Math.random() * (size / 10);
      
      const debris = new Graphics();
      // Irregular rock shapes
      const sides = 4 + Math.floor(Math.random() * 3);
      debris.poly(this.createRockShape(pSize, sides));
      debris.fill({ color: Math.random() > 0.2 ? color : this.hueToColor(hue + 10) });
      debris.x = x + (Math.random() - 0.5) * size * 0.5;
      debris.y = y + (Math.random() - 0.5) * size * 0.5;
      
      this.effectContainer.addChild(debris);
      
      this.particles.push({
        x: debris.x,
        y: debris.y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0.5 + Math.random() * 0.5,
        maxLife: 1,
        color,
        size: 0.8,
        graphic: debris,
      });
    }
    
    // Dust cloud (small fading particles)
    for (let i = 0; i < particleCount / 2; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 0.5 + Math.random() * 2;
      
      const dust = new Graphics();
      dust.circle(0, 0, 3 + Math.random() * 4);
      dust.fill({ color: color, alpha: 0.4 });
      dust.x = x;
      dust.y = y;
      
      this.effectContainer.addChild(dust);
      
      this.particles.push({
        x: dust.x,
        y: dust.y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0.3 + Math.random() * 0.3,
        maxLife: 0.6,
        color,
        size: 0.5,
        graphic: dust,
      });
    }
  }

  /**
   * Convert HSL hue (0-360) to RGB color number
   */
  private hueToColor(hue: number): number {
    const h = (hue % 360) / 360;
    const s = 0.7;
    const l = 0.5;
    
    const hueToRgb = (p: number, q: number, t: number) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1/6) return p + (q - p) * 6 * t;
      if (t < 1/2) return q;
      if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
      return p;
    };
    
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    
    const r = Math.round(hueToRgb(p, q, h + 1/3) * 255);
    const g = Math.round(hueToRgb(p, q, h) * 255);
    const b = Math.round(hueToRgb(p, q, h - 1/3) * 255);
    
    return (r << 16) | (g << 8) | b;
  }

  /**
   * Create irregular rock polygon shape
   */
  private createRockShape(radius: number, sides: number): number[] {
    const points: number[] = [];
    for (let i = 0; i < sides; i++) {
      const angle = (i / sides) * Math.PI * 2;
      const r = radius * (0.7 + Math.random() * 0.6);
      points.push(Math.cos(angle) * r, Math.sin(angle) * r);
    }
    return points;
  }

  showDeathScreen(): void {
    if (this.deathOverlay) return;
    
    this.deathOverlay = new Container();
    
    const bg = new Graphics();
    bg.rect(0, 0, this.app.screen.width, this.app.screen.height);
    bg.fill({ color: 0x000000, alpha: 0.7 });
    
    const style = new TextStyle({
      fontFamily: 'Arial',
      fontSize: 48,
      fill: 0xff4444,
      fontWeight: 'bold',
    });
    
    const text = new Text({
      text: 'DESTROYED',
      style,
    });
    text.anchor.set(0.5);
    text.x = this.app.screen.width / 2;
    text.y = this.app.screen.height / 2 - 50;
    
    const subStyle = new TextStyle({
      fontFamily: 'Arial',
      fontSize: 24,
      fill: 0xffffff,
    });
    
    const subText = new Text({
      text: 'Press R to respawn',
      style: subStyle,
    });
    subText.anchor.set(0.5);
    subText.x = this.app.screen.width / 2;
    subText.y = this.app.screen.height / 2 + 20;
    
    this.deathOverlay.addChild(bg);
    this.deathOverlay.addChild(text);
    this.deathOverlay.addChild(subText);
    
    this.uiContainer.addChild(this.deathOverlay);
  }

  hideDeathScreen(): void {
    if (this.deathOverlay) {
      this.uiContainer.removeChild(this.deathOverlay);
      this.deathOverlay.destroy();
      this.deathOverlay = null;
    }
  }

  screenToWorld(screenX: number, screenY: number): { x: number; y: number } {
    const screenCenterX = this.app.screen.width / 2;
    const screenCenterY = this.app.screen.height / 2;
    
    return {
      x: (screenX - screenCenterX) / this.cameraZoom + this.cameraX,
      y: (screenY - screenCenterY) / this.cameraZoom + this.cameraY,
    };
  }

  worldToScreen(worldX: number, worldY: number): { x: number; y: number } {
    const screenCenterX = this.app.screen.width / 2;
    const screenCenterY = this.app.screen.height / 2;
    
    return {
      x: (worldX - this.cameraX) * this.cameraZoom + screenCenterX,
      y: (worldY - this.cameraY) * this.cameraZoom + screenCenterY,
    };
  }

  setZoom(zoom: number): void {
    this.cameraZoom = zoom;
  }

  getZoom(): number {
    return this.cameraZoom;
  }

  /** Called by Game.ts each frame to pass local firing state for laser prediction */
  setLocalFireState(fireLeft: boolean, fireRight: boolean, targetAngle: number): void {
    this.localFireLeft = fireLeft;
    this.localFireRight = fireRight;
    this.localTargetAngle = targetAngle;
  }

  onResize(): void {
    // Update any screen-space UI
    if (this.deathOverlay) {
      this.hideDeathScreen();
      this.showDeathScreen();
    }
    
    // Reposition minimap
    if (this.minimapContainer) {
      this.minimapContainer.x = this.app.screen.width - this.MINIMAP_SIZE - 15;
    }
  }
  
  private updateMinimap(): void {
    if (!this.minimapGraphics || !this.minimapContainer) return;
    
    const g = this.minimapGraphics;
    g.clear();
    
    const playerPos = this.state.getPlayerPosition();
    const center = this.MINIMAP_SIZE / 2;
    const scale = (this.MINIMAP_SIZE / 2) / this.MINIMAP_RANGE;
    
    // Draw star/sun at center if close enough
    const sunDist = Math.sqrt(playerPos.x ** 2 + playerPos.y ** 2);
    if (sunDist < this.MINIMAP_RANGE * 2) {
      const sunX = center + (-playerPos.x) * scale;
      const sunY = center + (-playerPos.y) * scale;
      g.circle(sunX, sunY, 8);
      g.fill({ color: 0xffaa00, alpha: 0.9 });
      g.circle(sunX, sunY, 5);
      g.fill({ color: 0xffff88, alpha: 1.0 });
    }
    
    // Draw entities
    for (const [id, entity] of this.state.entities) {
      const dx = entity.renderX - playerPos.x;
      const dy = entity.renderY - playerPos.y;
      const dist = Math.sqrt(dx ** 2 + dy ** 2);
      
      if (dist > this.MINIMAP_RANGE) continue;
      
      const mx = center + dx * scale;
      const my = center + dy * scale;
      
      // Color based on entity type
      switch (entity.type) {
        case EntityType.Player:
          if (id === this.state.playerId) continue; // Skip self
          g.circle(mx, my, 4);
          g.fill({ color: 0x44ff44, alpha: 0.9 }); // Green for other players
          break;
          
        case EntityType.Asteroid:
          g.circle(mx, my, 2 + (entity.data?.[0] || 50) / 50);
          g.fill({ color: 0x888888, alpha: 0.6 }); // Gray for asteroids
          break;
          
        case EntityType.DroppedItem:
          g.circle(mx, my, 3);
          g.fill({ color: 0xffff00, alpha: 0.9 }); // Yellow for items
          break;
          
        case EntityType.Enemy:
          g.circle(mx, my, 4);
          g.fill({ color: 0xff4444, alpha: 0.9 }); // Red for enemies
          break;
          
        case EntityType.Station:
          g.rect(mx - 5, my - 5, 10, 10);
          g.fill({ color: 0x4488ff, alpha: 0.9 }); // Blue for stations
          break;
          
        case EntityType.NPC:
          g.circle(mx, my, 4);
          g.fill({ color: 0x44ffff, alpha: 0.9 }); // Cyan for NPCs
          break;
      }
    }
    
    // Draw player at center
    g.circle(center, center, 5);
    g.fill({ color: 0x00ff00, alpha: 1.0 });
    
    // Draw player direction indicator
    const player = this.state.entities.get(this.state.playerId);
    if (player) {
      const angle = player.angle || 0;
      const dirLen = 12;
      g.moveTo(center, center);
      g.lineTo(center + Math.cos(angle) * dirLen, center + Math.sin(angle) * dirLen);
      g.stroke({ color: 0x00ff00, width: 2, alpha: 0.8 });
    }
  }
}
