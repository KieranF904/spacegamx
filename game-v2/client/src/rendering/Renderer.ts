/**
 * Renderer - PixiJS WebGL rendering
 */

import { Bloom } from './Bloom';
import type { QualityProfile } from '../settings/quality';
import { SpritePool } from './spritePool';
import { disc, ring, rock, glowBall, softDot, streak, streakScale, vignette, DOT_SIZE } from './fxTextures';
import { stepOverlays, screenTint } from './overlayFrame';
import { cameraView, HELM_FOLLOW_RATE, MAX_VIEW_SPIN, NORTH_RETURN_RATE, screenToWorld, screenToWorldDir, smoothAngle, viewHalfExtents, worldToScreen, worldToScreenDir } from './cameraView';
import { FACTION_COLORS } from '../ships/ShipRenderer';
import { PlanetRenderer } from './PlanetRenderer';
import { SceneryRenderer } from './Scenery';
import { NestRenderer, nestColor } from './NestViews';
import systemsData from '../../../data/systems.json';
import {
  Application,
  BitmapFont,
  BitmapText,
  Sprite,
  Texture,
  Container,
  Graphics,
  Text,
  TextStyle,
  Color,
} from 'pixi.js';
import { GameState } from '../state/GameState';
import { WeaponFx, type PredictedShell } from './weapons/WeaponFx';
import { LootPodView } from './LootPodView';
import { TerrainView } from './TerrainView';
import { terrainFor } from './terrainData';
import { MobView } from './MobView';
import { drawAsteroid, AsteroidSeams } from './AsteroidLook';
import { RiftShader } from './RiftShader';
import { StationShot, StationView } from './StationView';
import { CentralBodyShaders, CentralType } from './CentralBodyShaders';
import { SunRenderer } from './SunRenderer';
import { GlowRenderer } from './GlowRenderer';
import {
  EntityType,
  EffectType,
  TICK_MS,
  getAsteroidPolygon,
  mulberry32,
  hashString,
  sunShaderDefs,
  nestPosition,
  pocketsFrom,
  entranceNest,
} from '@space-game/common';
import { SkyRenderer } from './sky/SkyRenderer';
import { SurfaceRenderer, SUN_DIR } from './surface/SurfaceRenderer';
import { CityView } from './surface/CityView';
import { BastionView } from './surface/BastionView';
import { Lighting } from './lighting/Lighting';
import { AsteroidBatch } from './lighting/AsteroidBatch';
import { CoronaRaysRenderer } from './CoronaRaysRenderer';
import { skyBiome, SkyBiome } from './sky/skyBiome';
import type { NestData, ServerSystemInfoMessage, StarSystemData } from '@space-game/common';

interface DamageNumber {
  /** Where it was hit (world) */
  x: number;
  y: number;
  /** Its rise and drift from there, along the screen's axes (world units) */
  ox: number;
  oy: number;
  amount: number;
  critical: boolean;
  lifetime: number;
  /** Sideways drift (world units a second at the start) */
  drift: number;
  text: BitmapText;
}

/** A short-lived effect particle, drawn from a sprite pool (see updateEffects) */
interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  color: number;
  /** Scale at full life (it shrinks as it fades) */
  size: number;
  /** Its radius in world units at scale 1 */
  radius: number;
  tex: Texture;
  alpha: number;
  rot: number;
  rotSpeed: number;
}

/** An expanding, fading flash or ring */
interface Flash { x: number; y: number; radius: number; life: number; max: number; color: number; alpha: number; grow: number; tex: Texture }

interface TractorBeam {
  startX: number;
  startY: number;
  targetX: number;
  targetY: number;
  progress: number;
}

/** A name tag and health bar over an entity (kept, not looked up by name each frame) */
interface Tag {
  name: Text | null;
  bar: Graphics | null;
  /** What the bar shows now (it's redrawn only when that changes) */
  barKey: string;
}

/** A jump gate's moving parts */
interface Gate { outer: Graphics; inner: Graphics; core: Graphics; phase: number; pulse: number }

/** Seconds to fade an entity in as it appears, or out as it goes */
const FADE = 0.25;
/** A panned view (middle mouse) keeps your ship at least this fraction of the screen in from every edge */
const PAN_MARGIN = 0.1;

// System-specific visual configuration
// Populated from server 'systemInfo' messages (data-driven via systems.json),
// with a Sol-like fallback for systems without data.
interface SystemVisuals {
  starHue: number;          // Base hue for the central star (0-360)
  starRadius: number;       // Size of central star
  specialStarChance?: number;      // Chance for special colored stars
  specialStarHue?: number;         // Hue for special stars
  hasNebula?: boolean;
  /** Hazards here ('darkness' dims the ambient light) */
  hazards?: string[];
  nebulaHue?: number;
  sunStyle?: string;
  sunStyleParams?: Record<string, number>;
  coronaStyle?: string;
  coronaStyleParams?: Record<string, number>;
  /** Central body type 'none' (e.g. the proto empty scene): no sun or glow */
  noCentralBody?: boolean;
  /** Black holes and pulsars get their own shaders instead of the sun */
  centralType?: CentralType;
  centralRadius?: number;
  centralHue?: number;
  /** Detail-star mode: full fBM/warp/plasma control (like sandbox detail_sun) */
  detailStar?: boolean;
  detailParams?: Record<string, number>;
  detailColors?: Record<string, string>;
  /** Starfield shader config (sandbox-style GPU starfield) */
  starfield?: {
    starBrightness?: number;
    twinkleSpeed?: number;
    twinkleAmount?: number;
    hueShift?: number;
    density?: number;
    starSize?: number;
    parallaxStrength?: number;
    baseCell?: number;
    lodBlendWidth?: number;
  };
}

// Fallback visuals used until the server sends systemInfo
const DEFAULT_SYSTEM_VISUALS: SystemVisuals = {
  starHue: 40,
  starRadius: 1000,
  sunStyle: 'granular',
  coronaStyle: 'plasmaStreams',
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

/** A screen-aligned offset (ox, oy) in an entity's turned frame (c, sn: the cos and sin of `up`, the roll that keeps `o` upright) */
function placeUpright(o: Container, c: number, sn: number, up: number, ox: number, oy: number): void {
  o.position.set(c * ox - sn * oy, sn * ox + c * oy);
  o.rotation = up;
}

export class Renderer {
  private app: Application;
  private state: GameState;
  
  // Containers (render order)
  private worldContainer: Container;
  private backgroundContainer: Container;
  private entityContainer: Container;
  /** A surface's rock (TerrainView), and the system it's for */
  private terrainLayer = new Container();
  private terrainView: TerrainView | null = null;
  private terrainId: string | null = null;
  private effectContainer: Container;
  private uiContainer: Container;
  
  /** Projectile tracers, muzzle flashes and impacts */
  private weaponFx: WeaponFx;
  /** Black hole / pulsar central bodies */
  private centralShaders = new CentralBodyShaders();
  /** The current system's planets and moons */
  private planets = new PlanetRenderer();
  /** Comets, built structures and stillstones */
  private scenery = new SceneryRenderer();
  /** Hostile nests (drawn with the scenery) */
  private nests = new NestRenderer();
  /** Ways into pockets from this system, drawn as nests (world/pockets.ts entranceNest) */
  private wayIns: NestData[] = [];
  /** How brightly a stillstone's veins pulse for the local drive, 0..1 (ShipClient.lodestoneGlow) */
  lodestoneGlow: ((id: string) => number) | null = null;
  private scenerySystem = '';
  /** Rift portal vortex shaders, by entity id */
  private rifts = new Map<number, RiftShader>();
  private lootPods = new Map<number, LootPodView>();
  /** Single-body enemies (data/mobs.json) */
  private mobs = new Map<number, MobView>();
  private asteroidSeams = new Map<number, AsteroidSeams>();
  /** Asteroids just struck (when, how hard): a white flash and a little jolt */
  private rockHits = new Map<number, { at: number; strength: number }>();
  private seamTime = 0;
  /** Station visuals, by entity id */
  private stations = new Map<number, StationView>();
  /** Modular ships and debris (drawn by ShipRenderer) */
  private shipLayer = new Container();

  /** Entities whose body is drawn elsewhere (modular ships): only their name tag and health bar show. */
  public hiddenEntityIds: Set<number> = new Set();
  /** Hull radius of those ships (ShipRenderer fills it), so tags sit just outside the hull */
  public shipRadius = new Map<number, number>();
  
  // Camera
  private cameraX = 0;
  private cameraY = 0;
  private cameraZoom = 1;
  /** The view's roll (cameraView.ts): eases onto this heading in helm, back to north-up (null) otherwise */
  private cameraAngle = 0;
  private cameraHeading: number | null = null;
  /** Where the pilot has dragged the view from their ship (middle mouse), in world units along the screen's axes; it always keeps the ship PAN_MARGIN inside the screen */
  private pan = { x: 0, y: 0 };
  private panDrag: number | null = null;
  private recenterBtn: HTMLButtonElement | null = null;
  private recenterShown = false;
  /** Camera catch-up per frame (0..1) */
  public cameraFollow = 0.1;
  /** Display settings */
  public shakeScale = 1;
  public showDamageNumbers = true;
  public showNames = true;
  
  // GPU shader renderers for sun and glow
  private sunRenderer: SunRenderer;
  private glowRenderer: GlowRenderer;
  
  // GPU procedural starfield (sandbox-style)
  private sky: SkyRenderer;
  /** A planet's ground and clouds, in place of the sky while you're on one */
  private surface: SurfaceRenderer;
  private city: { system: string; view: CityView | null; bastion: BastionView | null } | null = null;
  /** A surface's daylight (night dims it) */
  private day = { ambient: [1, 1, 1] as [number, number, number], power: 0 };
  /** The edge of a surface's map */
  private surfaceEdge = new Graphics();
  /** On a surface, ships cast soft shadows on the ground (that's what puts them up in the air) */
  private shadows = new SpritePool('normal');
  /** Ships, stations and asteroids lit by the sun, the system's ambient light and every light nearby */
  readonly lighting: Lighting;
  /** Asteroid rocks, lit, in batches */
  private rocks: AsteroidBatch;
  private lightKey = '';
  private podLight: [number, number, number] = [1, 1, 1];
  /** A sun's corona: streamers of plasma reaching out from its edge */
  private corona: CoronaRaysRenderer;
  /** Each system's sky, made the first time it's seen */
  private biomes = new Map<string, SkyBiome>();
  
  // Current system info
  private currentSystemId: string = 'sol';
  /** Data-driven visuals per system, from server systemInfo messages */
  private systemVisuals: Map<string, SystemVisuals> = new Map();
  
  // Entity graphics cache
  private entityGraphics: Map<number, Container> = new Map();
  /** Name tags and health bars, by entity id */
  private tags = new Map<number, Tag>();
  /** Jump gates, by entity id */
  private gates = new Map<number, Gate>();
  /** Entities just made, fading in (id → 0..1) */
  private fadingIn = new Map<number, number>();
  /** Entities gone, fading out where they were (then destroyed) */
  private fadingOut: { id: number; container: Container }[] = [];
  /** This system's data (looked up once per system, not per frame) */
  private sys: { id: string; data: (StarSystemData & { visuals?: Record<string, any> }) | undefined } = { id: '', data: undefined };
  /** The sun's style parameters and the corona's look, made once per system's visuals */
  private sunLook: { visuals: SystemVisuals | null; id: string; sun: ReturnType<typeof buildStyleParams>; corona: ReturnType<typeof buildStyleParams>; rays: Parameters<CoronaRaysRenderer['update']>[3] | null } | null = null;

  // Effects
  private damageNumbers: DamageNumber[] = [];
  private particles: Particle[] = [];
  private flashes: Flash[] = [];
  /** Particles and flashes are pooled sprites (no Graphics made and destroyed per spark) */
  private fxPool = new SpritePool('normal');
  /** Damage numbers: a bitmap font (digits drawn once), pooled */
  private numberPool: BitmapText[] = [];
  private tractorBeams: TractorBeam[] = [];
  /** Tractor beams: pooled streaks and dots */
  private beamPool = new SpritePool('add');
  
  // Debug asteroid markers (server-provided)
  private debugAsteroidGraphics: Graphics;
  private debugAsteroidMarkers: { x: number; y: number; expiresAt: number }[] = [];
  private debugDrawn = false;
  /** Glow over the bright effects (Display settings) */
  readonly bloom: Bloom;
  private static fontInstalled = false;
  /** The minimap redraws at 20 Hz (its dots move a fraction of a pixel a frame) */
  private minimapAt = 0;

  // Death screen
  private deathOverlay: Container | null = null;
  private deathAt = 0;
  private killerName: string | undefined;
  /** A soft dark edge to the screen (reddening when you're hit) */
  private vignette = new Sprite(vignette());
  
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
    this.initPan();

    // Create layer containers
    this.worldContainer = new Container();
    this.backgroundContainer = new Container();
    this.entityContainer = new Container();
    this.effectContainer = new Container();
    this.uiContainer = new Container();
    
    this.worldContainer.addChild(this.backgroundContainer);
    this.worldContainer.addChild(this.shadows.container);
    // A surface's rock: over the ground and ships' shadows, under everything else
    this.worldContainer.addChild(this.terrainLayer);
    this.worldContainer.addChild(this.entityContainer);
    this.lighting = new Lighting(this.worldContainer);
    this.scenery.lighting = this.lighting;
    this.nests.lighting = this.lighting;
    this.rocks = new AsteroidBatch(this.lighting);
    // Rocks under every other entity
    this.entityContainer.addChild(this.rocks.container);
    // Ships draw above stations, gates and other entities
    this.worldContainer.addChild(this.shipLayer);
    this.worldContainer.addChild(this.effectContainer);
    this.weaponFx = new WeaponFx(this.effectContainer);
    this.lighting.addSource((L) => this.collectLights(L));
    this.effectContainer.addChild(this.fxPool.container);
    this.effectContainer.addChild(this.beamPool.container);
    
    this.app.stage.addChild(this.worldContainer);
    // Bloom over the world, under the UI (see Bloom.ts)
    this.bloom = new Bloom(app);
    this.bloom.add(this.weaponFx.glowLayer);
    this.app.stage.addChild(this.bloom.sprite);
    this.app.stage.addChild(this.uiContainer);
    // The vignette under the rest of the UI
    this.uiContainer.addChild(this.vignette);
    
    // Initialize GPU shader renderers for sun and ambient glow
    this.glowRenderer = new GlowRenderer();
    this.glowRenderer.initialize();
    this.backgroundContainer.addChild(this.glowRenderer.getContainer());
    
    // Solar rays between the glow and the disc
    this.corona = new CoronaRaysRenderer();
    this.corona.initialize();
    this.backgroundContainer.addChild(this.corona.getContainer());

    this.sunRenderer = new SunRenderer();
    this.sunRenderer.initialize();
    this.backgroundContainer.addChild(this.sunRenderer.getContainer());
    this.backgroundContainer.addChild(this.centralShaders.container);
    this.backgroundContainer.addChild(this.scenery.container);
    this.backgroundContainer.addChild(this.nests.container);
    this.backgroundContainer.addChild(this.planets.container);

    // Initialize GPU procedural starfield (sandbox-style)
    // Added to stage at index 0 (screen-space) so it always fills the viewport
    this.sky = new SkyRenderer(this.app);
    this.app.stage.addChildAt(this.sky.container, 0);
    this.surface = new SurfaceRenderer(this.app);
    this.app.stage.addChildAt(this.surface.ground, 0);
    // Clouds over the world (ships fly beneath them), under the bloom and the UI
    this.app.stage.addChildAt(this.surface.clouds, this.app.stage.getChildIndex(this.worldContainer) + 1);
    this.backgroundContainer.addChild(this.surfaceEdge);

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

  setCurrentSystem(systemId: string): void {
    this.currentSystemId = systemId;
  }

  /**
   * Store data-driven system visuals from a server systemInfo message.
   * Called when entering a system (or on join).
   */
  setSystemInfo(msg: ServerSystemInfoMessage): void {
    const visuals: SystemVisuals = {
      starHue: msg.centralBody.hue ?? 40,
      starRadius: msg.centralBody.radius ?? 1000,
      sunStyle: msg.centralBody.sunStyle,
      sunStyleParams: msg.centralBody.sunStyleParams,
      coronaStyle: msg.centralBody.coronaStyle,
      coronaStyleParams: msg.centralBody.coronaStyleParams,
      specialStarChance: msg.visuals.specialStarChance,
      specialStarHue: msg.visuals.specialStarHue,
      hasNebula: msg.visuals.hasNebula,
      hazards: msg.hazards,
      nebulaHue: msg.visuals.nebulaHue,
      starfield: {
        hueShift: msg.visuals.starHueShift,
      },
    };

    // Detail-star mode: full fBM/warp/plasma control
    const cb = msg.centralBody as any;
    visuals.noCentralBody = cb.type === 'none';
    if (cb.type === 'black_hole' || cb.type === 'pulsar' || cb.type === 'brown_dwarf') {
      visuals.centralType = cb.type;
      visuals.centralRadius = cb.radius ?? 1000;
      visuals.centralHue = cb.type === 'black_hole' ? (cb.diskHue ?? 30) : cb.type === 'brown_dwarf' ? (cb.hue ?? 14) : (cb.beamHue ?? 190);
    }
    if (cb.detailStar) {
      visuals.detailStar = true;
      visuals.detailParams = cb.detailParams ?? {};
      visuals.detailColors = cb.detailColors ?? {};
    }

    this.systemVisuals.set(msg.systemId, visuals);
  }

  update(delta: number): void {
    // Update animation time
    this.time += delta;
    
    // Update current system from state
    if (this.state.systemId && this.state.systemId !== this.currentSystemId) {
      this.currentSystemId = this.state.systemId;
    }
    if (this.sys.id !== this.currentSystemId) {
      this.sys = { id: this.currentSystemId, data: (systemsData as { systems: StarSystemData[] }).systems.find((s) => s.id === this.currentSystemId) };
    }
    
    // Update camera to follow player
    this.updateCamera(delta);
    
    // Render background
    this.renderBackground(delta);
    this.updatePlanets(delta);
    
    // Render entities
    this.renderEntities(delta);
    this.rocks.update(this.entityGraphics, this.cameraZoom);

    // Render debug asteroid markers
    this.renderDebugAsteroidMarkers();
    
    // Update effects
    this.updateEffects(delta);
    
    // Render damage numbers
    this.renderDamageNumbers(delta);
    
    // Update minimap
    if (performance.now() - this.minimapAt >= 50) {
      this.minimapAt = performance.now();
      this.updateMinimap();
    }
    this.updateScreen();
    // The 2D overlay canvases, in step with this frame
    stepOverlays(delta);
  }

  /** Screen-space extras: the vignette, and the death screen easing in */
  private updateScreen(): void {
    const v = this.vignette, w = this.app.screen.width, h = this.app.screen.height;
    v.width = w;
    v.height = h;
    // Subtle on its own; none where a hazard already darkens the edges; red when hit
    const hz = this.systemVisuals.get(this.currentSystemId)?.hazards;
    const base = hz && (hz.includes('darkness') || hz.includes('low_visibility')) ? 0 : 0.3;
    const dmg = screenTint.damage;
    const red = Math.min(1, dmg / 0.25);
    v.alpha = Math.max(base, dmg);
    v.tint = (Math.round(0xc8 * red) << 16) | (Math.round(0x10 * red) << 8);
    v.visible = v.alpha > 0.01;

    const o = this.deathOverlay;
    if (o) {
      const t = Math.min(1, (performance.now() - this.deathAt) / 700);
      const e = 1 - (1 - t) ** 3;
      o.alpha = e;
      const title = o.getChildByLabel('deathTitle');
      if (title) title.scale.set(1.35 - 0.35 * e);
    }
  }

  /** Whether a circle (world units) is on screen (ShipRenderer skips work for ships that aren't) */
  inView(x: number, y: number, r: number): boolean {
    const v = this.viewBox();
    return Math.abs(x - this.cameraX) <= v.hw + r && Math.abs(y - this.cameraY) <= v.hh + r;
  }

  /** Half-size (world units) of the box round the view, turned or not */
  private viewBox(): { hw: number; hh: number } {
    // (Memoised on its inputs: asked once per entity-batch and again per ship, and it only changes with the camera)
    const m = this.vbMemo, w = this.app.screen.width, h = this.app.screen.height;
    if (m.w !== w || m.h !== h || m.zoom !== this.cameraZoom || m.angle !== this.cameraAngle) {
      m.w = w; m.h = h; m.zoom = this.cameraZoom; m.angle = this.cameraAngle;
      m.box = viewHalfExtents(w, h, m.zoom, m.angle);
    }
    return m.box;
  }
  private vbMemo = { w: -1, h: -1, zoom: NaN, angle: NaN, box: { hw: 0, hh: 0 } };
  /** Entities seen this frame (reused: cleared each frame instead of a new Set) */
  private aliveIds = new Set<number>();

  /** The view's roll: the heading to put up the screen (helm), or null for north-up */
  setCameraHeading(angle: number | null): void {
    this.cameraHeading = angle;
  }

  getCameraAngle(): number {
    return this.cameraAngle;
  }

  /** Name tags, health bars and damage numbers: counter-scaled zoomed out (to stay readable), world size zoomed in */
  get tagScale(): number {
    return Math.max(1, Math.min(3, 1 / this.cameraZoom));
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
    // (Nothing to draw, and nothing drawn last frame: leave it be)
    if (this.debugAsteroidMarkers.length === 0 && !this.debugDrawn) return;
    g.clear();
    this.debugDrawn = this.debugAsteroidMarkers.length > 0;
    if (!this.debugDrawn) return;

    const size = 20;
    for (const m of this.debugAsteroidMarkers) {
      g.moveTo(m.x - size, m.y - size);
      g.lineTo(m.x + size, m.y + size);
      g.moveTo(m.x - size, m.y + size);
      g.lineTo(m.x + size, m.y - size);
    }
    g.stroke({ color: 0xff3333, width: 2, alpha: 0.9 });
  }

  setPlanetsVisible(on: boolean): void {
    this.planets.container.visible = on;
  }

  setMinimapVisible(on: boolean): void {
    if (this.minimapContainer) this.minimapContainer.visible = on;
  }

  private updatePlanets(delta: number): void {
    const sys = this.sys.data;
    const { hw, hh } = this.viewBox();
    const view = { x0: this.cameraX - hw, x1: this.cameraX + hw, y0: this.cameraY - hh, y1: this.cameraY + hh };
    if (this.scenerySystem !== this.currentSystemId) {
      this.scenerySystem = this.currentSystemId;
      this.scenery.set(sys?.comets ?? [], sys?.structures ?? [], sys?.lodestones ?? []);
      // (and the ways into pockets from here: a boss's nest, drawn as one)
      this.wayIns = pocketsFrom((systemsData as { systems: StarSystemData[] }).systems, this.currentSystemId).map(entranceNest).filter((n) => n !== null);
      this.nests.set([...(sys?.nests ?? []), ...this.wayIns], sys?.planets);
    }
    this.scenery.update(delta, this.state.getRawServerTick(), view, this.lodestoneGlow ?? undefined);
    this.nests.update(delta, this.state.getRawServerTick(), view);
    if (!this.planets.container.visible) return;
    this.planets.setSystem(this.currentSystemId, sys?.planets ?? [], sys?.centralBody?.type);
    this.planets.update(delta, this.state.getRawServerTick(), view);
  }

  /** Admin free camera / watching another pilot: the camera follows this instead of your ship */
  private cameraTarget: (() => { x: number; y: number } | null) | null = null;

  setCameraTarget(target: (() => { x: number; y: number } | null) | null): void {
    this.cameraTarget = target;
  }

  /** Middle mouse drags the view about your ship; a button at the top brings it back */
  private initPan(): void {
    const canvas = this.app.canvas as HTMLCanvasElement;
    // (No browser autoscroll on the middle button)
    canvas.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
    canvas.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 1 || this.cameraTarget) return;
      e.preventDefault();
      this.panDrag = e.pointerId;
      canvas.setPointerCapture?.(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (this.panDrag !== e.pointerId) return;
      // Grab and drag: the world follows the mouse (clamped to the margin each frame, in updateCamera; along the screen's axes, the view may be turned)
      this.pan.x -= e.movementX / this.cameraZoom;
      this.pan.y -= e.movementY / this.cameraZoom;
    });
    const end = (e: PointerEvent) => {
      if (this.panDrag !== e.pointerId) return;
      this.panDrag = null;
      canvas.releasePointerCapture?.(e.pointerId);
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    const b = document.createElement('button');
    b.textContent = '⌖ RECENTER VIEW';
    b.title = 'Bring the view back onto your ship (middle mouse drags it about)';
    b.style.cssText = 'position:absolute;top:58px;left:50%;transform:translateX(-50%);z-index:26;display:none;padding:5px 14px;'
      + 'border-radius:999px;border:1px solid rgba(125,211,252,0.45);background:rgba(8,14,28,0.8);color:#bfe6ff;'
      + 'font-family:inherit;font-size:11px;font-weight:600;letter-spacing:0.1em;cursor:pointer;';
    b.addEventListener('click', () => this.recenter());
    document.body.appendChild(b);
    this.recenterBtn = b;
  }

  /** The view back onto your ship */
  recenter(): void {
    this.pan.x = 0;
    this.pan.y = 0;
  }

  private updateCamera(dt: number): void {
    const playerPos = this.cameraTarget?.() ?? this.state.getPlayerPosition();
    // Your own ship (not the admin free camera or someone watched): the view may sit off it, as far as keeps the ship a margin inside every edge
    const own = !this.cameraTarget;
    const maxX = Math.max(0, (0.5 - PAN_MARGIN) * this.app.screen.width / this.cameraZoom);
    const maxY = Math.max(0, (0.5 - PAN_MARGIN) * this.app.screen.height / this.cameraZoom);
    this.pan.x = Math.max(-maxX, Math.min(maxX, this.pan.x));
    this.pan.y = Math.max(-maxY, Math.min(maxY, this.pan.y));
    // The roll: onto the heading in helm, back to north-up out of it (gentle, and the same at any frame rate)
    // (Not on a free camera or someone else's ship)
    const heading = own ? this.cameraHeading : null;
    this.cameraAngle = smoothAngle(this.cameraAngle, heading ?? 0, heading === null ? NORTH_RETURN_RATE : HELM_FOLLOW_RATE, Math.min(0.1, dt), MAX_VIEW_SPIN);
    if (heading === null && Math.abs(this.cameraAngle) < 1e-4) this.cameraAngle = 0;
    cameraView.angle = this.cameraAngle;
    const pw = own ? screenToWorldDir(this.pan.x, this.pan.y, this.cameraAngle) : { x: 0, y: 0 };
    const tx = playerPos.x + pw.x, ty = playerPos.y + pw.y;

    // Smooth camera follow (tighter mid-jump, or the ship would leave the screen; a slow drift while dead).
    // cameraFollow is the catch-up per 60 Hz frame, so it's the same at any frame rate.
    const follow = this.deathOverlay ? this.cameraFollow * 0.12 : this.cameraFollow;
    const lerpFactor = 1 - Math.pow(1 - Math.min(1, follow), Math.min(0.1, dt) * 60);
    this.cameraX += (tx - this.cameraX) * lerpFactor;
    this.cameraY += (ty - this.cameraY) * lerpFactor;
    if (own) {
      // However fast the ship goes (a jump's burn), it never slips past the margin (along the screen's axes)
      const d = worldToScreenDir(this.cameraX - playerPos.x, this.cameraY - playerPos.y, this.cameraAngle);
      const c = screenToWorldDir(Math.max(-maxX, Math.min(maxX, d.x)), Math.max(-maxY, Math.min(maxY, d.y)), this.cameraAngle);
      this.cameraX = playerPos.x + c.x;
      this.cameraY = playerPos.y + c.y;
    }
    const off = own && Math.hypot(this.pan.x, this.pan.y) * this.cameraZoom > 24;
    if (off !== this.recenterShown && this.recenterBtn) {
      this.recenterShown = off;
      this.recenterBtn.style.display = off ? 'block' : 'none';
    }

    // Apply camera transform to world container with screen shake: the camera's point sits at the
    // screen's centre (plus the shake), and the shake's roll turns about it
    const shake = this.state.screenShake;
    this.worldContainer.pivot.set(this.cameraX, this.cameraY);
    this.worldContainer.x = this.app.screen.width / 2 + (shake.offsetX || 0) * this.shakeScale;
    this.worldContainer.y = this.app.screen.height / 2 + (shake.offsetY || 0) * this.shakeScale;
    this.worldContainer.rotation = (shake.rotation || 0) * this.shakeScale - this.cameraAngle;
    this.worldContainer.scale.set(this.cameraZoom);
  }

  private renderBackground(delta: number): void {
    const zoom = this.cameraZoom;
    
    // Get system visuals (data-driven from server, with Sol-like fallback)
    const systemVisuals = this.systemVisuals.get(this.currentSystemId) || DEFAULT_SYSTEM_VISUALS;
    
    // The sky: this system's biome (made once per system), following the camera
    let biome = this.biomes.get(this.currentSystemId);
    if (!biome) {
      const sys = this.sys.data;
      const v = sys?.visuals ?? {};
      biome = skyBiome(this.currentSystemId || 'sol', {
        biome: v.biome, sector: sys?.sector, position: sys?.position, central: sys?.centralBody?.type,
        hasNebula: v.hasNebula ?? systemVisuals.hasNebula, nebulaHue: v.nebulaHue ?? systemVisuals.nebulaHue,
        starHueShift: v.starHueShift, specialStarChance: v.specialStarChance, specialStarHue: v.specialStarHue,
      });
      this.biomes.set(this.currentSystemId, biome);
    }
    this.sky.setBiome(biome);
    this.sky.setLens(systemVisuals.centralType === 'black_hole' ? systemVisuals.centralRadius ?? 0 : 0);
    // On a planet: its ground and clouds instead of the sky, and its city
    const here = this.sys.data;
    const surface = here?.surface ?? null;
    this.surface.setSurface(surface);
    this.setCity(surface ? here! : null);
    // Its rock (built once, when you arrive)
    if (this.terrainId !== this.currentSystemId) {
      this.terrainId = this.currentSystemId;
      this.terrainView?.destroy();
      this.terrainView = null;
      const t = terrainFor(this.currentSystemId);
      if (t) { this.terrainView = new TerrainView(t, this.lighting, surface?.kind === 'cavern'); this.terrainLayer.addChild(this.terrainView.container); }
    }
    this.terrainView?.update(Math.min(0.1, delta));
    const lightKey = `${this.currentSystemId}|${this.systemVisuals.has(this.currentSystemId)}`;
    if (lightKey !== this.lightKey) {
      this.lightKey = lightKey;
      this.lightSystem(systemVisuals, biome);
    }
    if (surface) {
      this.sky.container.visible = false;
      const shake = this.state.screenShake;
      this.surface.update(Math.min(0.1, delta) * 1000, this.cameraX, this.cameraY, zoom,
        { x: (shake.offsetX || 0) * this.shakeScale, y: (shake.offsetY || 0) * this.shakeScale, rot: (shake.rotation || 0) * this.shakeScale - this.cameraAngle });
      this.drawShadows(this.day.power <= 0);
      // Night falls on the light too (headlights come on by themselves in the dark)
      const n = this.surface.night;
      this.lighting.ambient = this.day.ambient.map((a) => a * (1 - 0.86 * n)) as [number, number, number];
      this.lighting.sun.power = this.day.power * (1 - 0.92 * n);
      this.shadows.container.alpha = 1 - n * 0.8;
    } else {
      this.shadows.begin();
      this.shadows.end();
      this.sky.update(Math.min(0.1, delta) * 1000, this.cameraX, this.cameraY, zoom, this.cameraAngle);
    }

    // Update and render GPU shader-based sun and glow (seconds: the same speed at any frame rate)
    const animDelta = Math.min(0.1, delta);
    const screenSize = { width: this.app.screen.width, height: this.app.screen.height };
    
    // Position at world origin (0, 0)
    this.glowRenderer.setPosition(0, 0);
    this.sunRenderer.setPosition(0, 0);
    const plainSun = !systemVisuals.noCentralBody && !systemVisuals.centralType;
    this.glowRenderer.getContainer().visible = plainSun;
    this.sunRenderer.getContainer().visible = plainSun;
    this.corona.getContainer().visible = plainSun;
    this.centralShaders.set(systemVisuals.centralType ?? null, systemVisuals.centralRadius ?? 1000, systemVisuals.centralHue ?? 30);
    this.centralShaders.update(animDelta);
    
    // Calculate LOD based on zoom (closer = more detail)
    // Zoom 0.1 = far (LOD 0), Zoom 2+ = close (LOD 1)
    const lodZoom = Math.max(0, Math.min(1, (this.cameraZoom - 0.1) / 1.9));
    this.glowRenderer.setLOD(lodZoom);
    { const vb = this.viewBox(); this.glowRenderer.setViewHalf(vb.hw, vb.hh); }
    this.sunRenderer.setLOD(lodZoom);

    if (systemVisuals.detailStar) {
      // Detail-star mode: full fBM/warp/plasma control (sandbox detail_sun look)
      this.updateDetailStar(systemVisuals, animDelta, screenSize);
    } else {
      // Standard style-based sun
      const look = this.lookOf(systemVisuals);
      this.sunRenderer.setSunStyle(look.sun.index, look.sun.params);
      this.sunRenderer.setCoronaStyle(look.corona.index, look.corona.params);
      
      // Update shaders with current system visuals
      // Pass camera position for parallax effect
      const glowRadius = systemVisuals.starRadius * 1.8 + 8000;
      this.glowRenderer.update(animDelta, systemVisuals.starHue, systemVisuals.starRadius, glowRadius, this.cameraX, this.cameraY);
      // (The shader draws its disc at discScale × what it's given: give it what makes the disc the star's own radius)
      this.sunRenderer.update(animDelta, systemVisuals.starHue, systemVisuals.starRadius / this.sunRenderer.discScale, screenSize);
    }
    if (plainSun) this.updateCorona(systemVisuals, animDelta);
  }

  /** The sun's style parameters for these visuals (made when the system or its visuals change, not each frame) */
  private lookOf(v: SystemVisuals): NonNullable<Renderer['sunLook']> {
    if (this.sunLook?.visuals !== v || this.sunLook.id !== this.currentSystemId) {
      this.sunLook = {
        visuals: v, id: this.currentSystemId, rays: null,
        sun: buildStyleParams(sunShaderDefs.sunStyles, v.sunStyle, v.sunStyleParams),
        corona: buildStyleParams(sunShaderDefs.coronaStyles, v.coronaStyle, v.coronaStyleParams),
      };
    }
    return this.sunLook;
  }

  /**
   * Configure the sun renderer for detail-star mode.
   * Mirrors the sandbox's detail_sun element: brownian fBM style with
   * domain warping, plasma, custom colors, and edge control.
   */
  private updateDetailStar(v: SystemVisuals, animDelta: number, screenSize: { width: number; height: number }): void {
    const p = v.detailParams ?? {};
    const sp = v.detailColors ?? {};
    const radius = p.radius ?? v.starRadius;
    const hue = p.hue ?? v.starHue;

    // Resolve the brownian sun style (same shader used by sandbox detail_sun)
    const brownianIndex = sunShaderDefs.sunStyles.findIndex(s => s.id === 'brownian');
    const styleIndex = brownianIndex >= 0 ? brownianIndex : 2;
    const sunParams = [
      0.5,                              // coreRadius
      p.octaves ?? 5.0,                 // octaves (1-8)
      p.lacunarity ?? 2.0,              // lacunarity (freq multiplier)
      p.gain ?? 0.5,                    // gain (amplitude multiplier)
      0.9,                              // unused
      p.warpAmount ?? 0.4,              // warpAmount for domain warping
    ];
    this.sunRenderer.setSunStyle(styleIndex, sunParams);

    // Disable built-in corona — detail stars use the glow renderer for atmosphere
    this.sunRenderer.setCoronaSize(0);
    this.sunRenderer.setCoronaIntensity(0);

    this.sunRenderer.setRadius(0.4);
    this.sunRenderer.setWarpParams(p.warpScale ?? 0.5, 0.0, p.turbulenceMix ?? 0.3);
    this.sunRenderer.setFbmParams(p.noiseScale ?? 4.0, p.animSpeed ?? 0.15, p.fbmContrast ?? 1.0);
    this.sunRenderer.setPlasmaParams(p.plasmaIntensity ?? 0.3, p.plasmaScale ?? 3.0, p.plasmaSpeed ?? 1.0);
    this.sunRenderer.setCenterLight(
      p.centerDarken ?? 0.5,
      p.centerHighlight ?? 0.5,
      p.centerFalloff ?? 1.5,
      p.centerMidpoint ?? 0.5
    );
    this.sunRenderer.setInsideAdjust(p.innerDarkening ?? 0.0, p.whiteBalance ?? 0.0, p.saturation ?? 1.0);
    this.sunRenderer.setEdgeStyle(p.edgeBrightness ?? 1.0, p.edgeThickness ?? 0.03, p.edgeSharpness ?? 0.5);
    this.sunRenderer.setEdgeGlow(p.limbDarkening ?? 0.5, 0.0, 0.0);
    this.sunRenderer.setAtmosphereRadii(0.0, 0.0);
    this.sunRenderer.setCoronaRadii(0.0, 0.0);
    this.sunRenderer.setCustomColors(
      this.hexToRgb(sp.darkColor ?? '#1a0500'),
      this.hexToRgb(sp.midColor ?? '#661100'),
      this.hexToRgb(sp.brightColor ?? '#ff6600'),
      this.hexToRgb(sp.edgeColor ?? '#ffaa33')
    );
    this.sunRenderer.setPlasmaColor(this.hexToRgb(sp.plasmaColor ?? '#ff9933'));
    this.sunRenderer.setCenterColor(this.hexToRgb(sp.centerColor ?? '#ffe6cc'));

    // Atmosphere glow via the glow renderer (like sandbox detail_atmosphere)
    const glowIntensity = p.glowIntensity ?? 0.6;
    const glowSize = p.glowSize ?? 0.1;
    const glowRadius = p.glowRadius ?? radius * 1.8 + 8000;
    if (glowIntensity > 0) {
      // Bright glow colors derived from the sun's bright/edge palette
      const bright = this.hexToRgb(sp.brightColor ?? '#ffaa22');
      const edge = this.hexToRgb(sp.edgeColor ?? '#ffdd66');
      this.glowRenderer.update(
        animDelta, hue, radius, glowRadius,
        this.cameraX, this.cameraY,
        glowIntensity, glowSize,
        // inner color: bright sun tone
        [Math.min(1, bright[0] * 1.1), Math.min(1, bright[1] * 1.1), Math.min(1, bright[2] * 1.1)],
        // outer color: softer edge tone
        [edge[0] * 0.9, edge[1] * 0.85, edge[2] * 0.8],
      );
    }

    this.sunRenderer.update(animDelta, hue, radius / this.sunRenderer.discScale, screenSize);
  }

  /**
   * The corona's look follows the system: its ray count, reach and motion from
   * the system's id, its colours from the sun's own palette.
   */
  private updateCorona(v: SystemVisuals, dt: number): void {
    // From the disc's edge (drawn at the star's own radius)
    const radius = v.detailStar ? v.detailParams?.radius ?? v.starRadius : v.starRadius;
    const look = this.lookOf(v);
    if (!look.rays) {
      // Made once per system: its ray count, reach and motion from its id, its colours from the sun's palette
      const rnd = mulberry32(hashString(`corona:${this.currentSystemId}`));
      const c = v.detailColors;
      look.rays = {
        intensity: 0.75 + rnd() * 0.3,
        innerRadiusMul: 0.96,
        outerRadiusMul: 2.2 + rnd() * 0.9,
        rayCount: Math.round(7 + rnd() * 8),
        rayWidth: 0.05 + rnd() * 0.05,
        rayVariation: 0.3 + rnd() * 0.3,
        raySpeed: 0.25 + rnd() * 0.3,
        rayTurbulence: 0.1 + rnd() * 0.25,
        baseColor: c?.brightColor ? this.hexToRgb(c.brightColor) : this.hslRgb(v.starHue, 0.9, 0.62),
        tipColor: c?.edgeColor ? this.hexToRgb(c.edgeColor) : this.hslRgb(v.starHue + 12, 0.85, 0.82),
      };
    }
    this.corona.setPosition(0, 0);
    this.corona.update(dt * 1000, v.starHue, radius, look.rays);
  }

  private hslRgb(h: number, s: number, l: number): [number, number, number] {
    const hex = this.hslToHex(h, s * 100, l * 100);
    return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
  }

  /** Parse '#RRGGBB' to [r, g, b] 0-1 floats */
  private hexToRgb(hex: string): [number, number, number] {
    const val = hex.startsWith('#') ? hex.slice(1) : hex;
    const rgb = parseInt(val, 16);
    if (isNaN(rgb)) return [1, 0, 0];
    return [
      ((rgb >> 16) & 0xff) / 255,
      ((rgb >> 8) & 0xff) / 255,
      (rgb & 0xff) / 255,
    ];
  }

  private renderEntities(dt: number): void {
    // Track which entities are still alive
    const aliveIds = this.aliveIds;
    aliveIds.clear();

    // Calculate visible bounds for culling (each entity's own size is added below, so big ones don't pop at the edge)
    const vb = this.viewBox();
    const halfW = vb.hw + this.CULL_MARGIN;
    const halfH = vb.hh + this.CULL_MARGIN;
    const k = this.tagScale;

    for (const entity of this.state.entities.values()) {
      aliveIds.add(entity.id);

      // Culling - skip entities outside viewport (but always render player)
      if (entity.id !== this.state.playerId) {
        const r = this.radiusOf(entity);
        if (Math.abs(entity.x - this.cameraX) > halfW + r || Math.abs(entity.y - this.cameraY) > halfH + r) {
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
        // It fades in (asteroids are drawn in batches, which don't fade: they just appear; projectiles and ship bodies are drawn elsewhere)
        if (entity.type !== EntityType.Projectile && entity.type !== EntityType.ShipBody && entity.type !== EntityType.Asteroid) {
          container.alpha = 0;
          this.fadingIn.set(entity.id, 0);
        }
      }

      // Make visible (modular ships keep only their name tag and health bar here)
      container.visible = true;
      if (this.hiddenEntityIds.has(entity.id)) {
        for (const c of container.children) c.visible = c.label === 'nameTag' || c.label === 'healthBar';
      }
      const fade = this.fadingIn.get(entity.id);
      if (fade !== undefined) {
        const a = Math.min(1, fade + dt / FADE);
        container.alpha = a;
        if (a >= 1) this.fadingIn.delete(entity.id);
        else this.fadingIn.set(entity.id, a);
      }

      // Update position (use smooth render position)
      container.x = entity.renderX;
      container.y = entity.renderY;
      container.rotation = entity.renderAngle;
      if (entity.type === EntityType.Enemy) this.mobs.get(entity.id)?.update(dt, entity.hp);

      if (this.rockHits.size && this.rockHits.has(entity.id)) this.animateRockHit(container, entity.id, entity.data?.[0] || 30);

      // Name tag and health bar: upright, fixed on screen however the ship turns, counter-scaled zoomed out
      const tag = this.tags.get(entity.id);
      if (tag) {
        const r = this.shipRadius.get(entity.id) ?? 20;
        // (Upright on screen: the view's roll less the ship's)
        const up = this.cameraAngle - entity.renderAngle;
        const c = Math.cos(up), sn = Math.sin(up);
        if (tag.name) {
          if (entity.name) {
            if (tag.name.text !== entity.name) tag.name.text = entity.name;
            tag.name.visible = this.showNames;
          }
          tag.name.scale.set(k);
          placeUpright(tag.name, c, sn, up, 0, r + 14);
        }
        if (tag.bar) {
          this.updateHealthBar(tag, entity);
          // Drawn from its left edge, 35 × 4 (the shield strip above it)
          tag.bar.scale.set(k);
          placeUpright(tag.bar, c, sn, up, -17.5 * k, -(r + 10) - 4 * k);
        }
      }
    }

    // Remove dead entities: stations, gates and loot fade out where they were, then go
    for (const [id, container] of this.entityGraphics) {
      if (!aliveIds.has(id)) {
        this.entityGraphics.delete(id);
        this.fadingIn.delete(id);
        this.tags.delete(id);
        this.rocks.remove(id);
        const type = this.typeOf.get(id);
        this.typeOf.delete(id);
        if (container.visible && (type === EntityType.Station || type === EntityType.Portal || type === EntityType.DroppedItem)) {
          this.fadingOut.push({ id, container });
        } else {
          this.disposeEntity(id, container);
        }
      }
    }
    let w = 0;
    for (const f of this.fadingOut) {
      f.container.alpha -= dt / FADE;
      if (f.container.alpha <= 0 || this.entityGraphics.has(f.id)) { this.disposeEntity(f.id, f.container); continue; }
      this.fadingOut[w++] = f;
    }
    this.fadingOut.length = w;
  }

  /** An entity's views gone for good */
  private disposeEntity(id: number, container: Container): void {
    // (Its id may be back already, with new views of its own)
    if (!this.entityGraphics.has(id)) {
      this.rifts.delete(id);
      this.gates.delete(id);
      this.stations.get(id)?.dispose();
      this.stations.delete(id);
      this.mobs.delete(id);
    }
    this.entityContainer.removeChild(container);
    container.destroy({ children: true });
  }

  /** Each entity's type, for when it's gone */
  private typeOf = new Map<number, EntityType>();

  /** How far an entity reaches from its centre (world units), for culling */
  private radiusOf(e: { id: number; type: EntityType; data?: number[] }): number {
    switch (e.type) {
      // (Its look reaches well past its radius: a citadel's arms nearly four times it)
      case EntityType.Station: return this.stations.get(e.id)?.reach ?? (e.data?.[8] ?? 200) * 3.8;
      case EntityType.Asteroid: return (e.data?.[0] || 30) * 1.3;
      case EntityType.Portal: return e.data?.[1] === 1 ? 600 : 220;
      case EntityType.Enemy: return 80;
      // Ships: the hull, and their name tag and health bar
      default: return (this.shipRadius.get(e.id) ?? 30) + 60;
    }
  }

  private createEntityGraphics(type: EntityType, id: number, data?: number[]): Container {
    const container = new Container();
    this.typeOf.set(id, type);

    switch (type) {
      case EntityType.Player:
        this.createPlayerGraphics(container, id);
        break;
      case EntityType.Asteroid:
        // data[0] = size, data[1] = resourceType
        {
          const { rock, seams } = drawAsteroid(container, id, data?.[0] || 30, this.state.entities.get(id)?.composition, this.sys.data?.visuals?.greyseam);
          const at = this.state.entities.get(id);
          this.rocks.add(id, rock, at?.x ?? 0, at?.y ?? 0);
          if (seams) this.asteroidSeams.set(id, seams);
        }
        break;
      case EntityType.Projectile:
        // Drawn by WeaponFx (tracers placed from the true spawn point)
        break;
      case EntityType.DroppedItem: {
        // data: [rarity index, kinds of item, item count]
        const pod = new LootPodView(data?.[0] ?? 0, data?.[2] ?? 1);
        this.lootPods.set(id, pod);
        container.addChild(pod.container);
        break;
      }
      case EntityType.Station: {
        // data: [stationId, orbit..., orbitTimeScale, radius, design, turrets, weapon]
        const view = new StationView(data?.[0] ?? id, data?.[8] ?? 200, this.state.entities.get(id)?.name, this.lighting, data?.[9] ?? 0, data?.[10] ?? 0, data?.[11] ?? 0);
        this.stations.set(id, view);
        container.addChild(view.container);
        break;
      }
      case EntityType.Portal:
        // data: [targetSystem, kind (0 jump gate, 1 rift), hue]
        if (data?.[1] === 1) {
          const rift = new RiftShader(data[2] ?? 275);
          this.rifts.set(id, rift);
          container.addChild(rift.container);
        } else {
          this.createPortalGraphics(container, id);
        }
        break;
      case EntityType.Enemy: {
        // A single-body enemy: data[0] its kind's index in data/mobs.json
        const view = new MobView(data?.[0] ?? 0);
        this.mobs.set(id, view);
        container.addChild(view.container);
        break;
      }
      case EntityType.ShipBody:
        // Dummies and debris are drawn by the ship renderer
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

  private createPlayerGraphics(container: Container, id: number): void {
    // The ship itself is drawn by the ship renderer; this container carries
    // the health bar and name tag

    // Health bar (above ship): drawn from its left edge, so it empties from the right (see updateHealthBar)
    const bar = new Graphics();
    bar.label = 'healthBar';
    bar.visible = false;  // Only show when damaged
    container.addChild(bar);

    // Nametag (below ship), rastered at 2x so it stays crisp zoomed in
    const nameTag = new Text({
      text: '',
      resolution: 2,
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
    this.tags.set(id, { name: nameTag, bar, barKey: '' });
  }

  /** A jump gate: a glowing core in two counter-rotating broken rings, breathing slowly (see updateEffects) */
  private createPortalGraphics(container: Container, id: number): void {
    const g = new Graphics();
    g.circle(0, 0, 150);
    g.fill({ color: 0x4400aa, alpha: 0.3 });
    g.circle(0, 0, 100);
    g.fill({ color: 0x6600cc, alpha: 0.5 });
    container.addChild(g);

    // Rings broken into arcs, so their turning shows
    const arcs = (r: number, n: number, gap: number, color: number, width: number, alpha: number) => {
      const ring = new Graphics();
      for (let i = 0; i < n; i++) {
        const a0 = (i / n) * Math.PI * 2, a1 = a0 + (Math.PI * 2 / n) * (1 - gap);
        ring.moveTo(Math.cos(a0) * r, Math.sin(a0) * r).arc(0, 0, r, a0, a1);
      }
      ring.stroke({ color, width, alpha });
      ring.blendMode = 'add';
      container.addChild(ring);
      return ring;
    };
    const outer = arcs(138, 6, 0.28, 0xa98bff, 6, 0.65);
    const inner = arcs(84, 4, 0.35, 0xc9b6ff, 4, 0.7);

    const core = new Graphics();
    core.circle(0, 0, 50);
    core.fill({ color: 0x8800ff, alpha: 0.7 });
    core.circle(0, 0, 20);
    core.fill({ color: 0xffffff });
    container.addChild(core);
    this.gates.set(id, { outer, inner, core, phase: (id * 1.618) % (Math.PI * 2), pulse: 1 });
  }

  /** A pilot's health bar and shield strip, redrawn only when what it shows changes; shown once damaged */
  private updateHealthBar(tag: Tag, entity: { hp: number; maxHp: number; data?: number[] }): void {
    const bar = tag.bar!;
    if (entity.hp === undefined || !entity.maxHp) return;
    const f = Math.max(0, Math.min(1, entity.hp / entity.maxHp));
    // Shield (data[4], 0..100): a strip over the bar while it's partly down
    const sh = Math.max(0, Math.min(1, (entity.data?.[4] ?? 0) / 100));
    const show = f < 1 || (sh > 0 && sh < 1);
    bar.visible = show;
    if (!show) return;
    const key = `${f.toFixed(3)}|${sh.toFixed(2)}`;
    if (key === tag.barKey) return;
    tag.barKey = key;
    const w = 35;
    bar.clear();
    bar.rect(-0.5, -0.5, w + 1, 5).fill({ color: 0x000000, alpha: 0.5 }).stroke({ color: 0xffffff, width: 1, alpha: 0.3 });
    // Red-orange, amber below half, deep red below a quarter (as the hostiles' bars)
    bar.rect(0, 0, w * f, 4).fill({ color: f > 0.5 ? 0xff6b5a : f > 0.25 ? 0xffa94d : 0xff3b3b });
    if (sh > 0) bar.rect(0, -3, w * sh, 2).fill({ color: 0x7dd3fc });
  }

  private updateEffects(delta: number): void {
    // Particles and flashes: pooled sprites, moved and faded
    const pool = this.fxPool;
    pool.begin();
    let w = 0;
    for (const p of this.particles) {
      p.x += p.vx * delta * 60;
      p.y += p.vy * delta * 60;
      p.life -= delta;
      if (p.life <= 0) continue;
      p.rot += p.rotSpeed * delta;
      const k = p.life / p.maxLife;
      const sp = pool.take(p.tex, p.x, p.y, 0.5, 0.5, p.color, p.alpha * k);
      sp.scale.set(k * p.size * (p.radius * 2) / DOT_SIZE);
      sp.rotation = p.rot;
      this.particles[w++] = p;
    }
    this.particles.length = w;
    w = 0;
    for (const f of this.flashes) {
      f.life += delta;
      if (f.life >= f.max) continue;
      const t = f.life / f.max;
      const sp = pool.take(f.tex, f.x, f.y, 0.5, 0.5, f.color, f.alpha * (1 - t));
      sp.scale.set((f.radius * (1 + f.grow * t) * 2) / DOT_SIZE);
      this.flashes[w++] = f;
    }
    this.flashes.length = w;
    pool.end();

    // Update tractor beam animations
    this.updateTractorBeams(delta);

    for (const rift of this.rifts.values()) rift.update(delta);
    // Jump gates: the rings turn slowly against each other and the whole gate breathes (its light with it, see collectLights)
    for (const gate of this.gates.values()) {
      gate.pulse = 0.82 + 0.18 * Math.sin(this.time * 1.3 + gate.phase);
      gate.outer.rotation = this.time * 0.12 + gate.phase;
      gate.inner.rotation = -this.time * 0.2 - gate.phase;
      gate.outer.alpha = gate.pulse;
      gate.inner.alpha = 0.6 + 0.4 * Math.sin(this.time * 1.3 + gate.phase + 0.8);
      gate.core.scale.set(0.94 + 0.06 * gate.pulse);
    }
    this.seamTime += delta;
    for (const [id, s] of this.asteroidSeams) {
      if (!this.entityGraphics.has(id)) { this.asteroidSeams.delete(id); continue; }
      s.glow.alpha = 0.55 + 0.45 * Math.sin(this.seamTime * 2.2 + s.phase);
    }
    for (const [id, pod] of this.lootPods) {
      const c = this.entityGraphics.get(id);
      if (!c) { this.lootPods.delete(id); continue; }
      pod.update(delta);
      if (c.visible) pod.light(this.lighting.levelAt(c.x, c.y, this.podLight));
    }
    const me = this.state.entities.get(this.state.playerId);
    for (const [id, station] of this.stations) {
      const e = this.state.entities.get(id);
      station.update(delta, me && e ? Math.hypot(e.renderX - me.renderX, e.renderY - me.renderY) : Infinity,
        e ? { x: e.renderX, y: e.renderY } : undefined, this.entityAt);
    }

    // Projectile tracers, muzzle flashes and impacts
    const presentTick = this.state.getRawServerTick();
    this.weaponFx.update(this.state, delta, presentTick, presentTick - this.state.interpDelayMs / TICK_MS);
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
    // Counter-scaled zoomed out (so they stay readable), and they float as far on screen
    const k = this.tagScale;
    for (let i = this.damageNumbers.length - 1; i >= 0; i--) {
      const dn = this.damageNumbers[i];
      dn.lifetime -= delta;
      // Float up the screen, slowing, drifting a little to its side (so a burst of hits fans out instead of stacking)
      dn.oy -= 55 * k * delta * dn.lifetime;
      dn.ox += dn.drift * k * delta * dn.lifetime;
      
      if (dn.lifetime <= 0) {
        this.effectContainer.removeChild(dn.text);
        this.numberPool.push(dn.text);
        this.damageNumbers.splice(i, 1);
      } else {
        const o = screenToWorldDir(dn.ox, dn.oy, this.cameraAngle);
        dn.text.x = dn.x + o.x;
        dn.text.y = dn.y + o.y;
        dn.text.rotation = this.cameraAngle;
        dn.text.alpha = Math.min(1, dn.lifetime * 2);
        // A pop as it appears: big, settling to size in the first ~0.12 s
        const age = 1 - dn.lifetime;
        dn.text.scale.set((age < 0.12 ? 1 + 0.6 * (1 - age / 0.12) : 1) * k);
      }
    }
  }

  /** A particle (see updateEffects) */
  private spark(x: number, y: number, vx: number, vy: number, life: number, radius: number, color: number, o: Partial<Particle> = {}): void {
    if (this.particleKeep < 1 && Math.random() > this.particleKeep) return;
    this.particles.push({ x, y, vx, vy, life, maxLife: o.maxLife ?? life, color, size: o.size ?? 1, radius, tex: o.tex ?? disc(), alpha: o.alpha ?? 1, rot: o.rot ?? 0, rotSpeed: o.rotSpeed ?? 0 });
  }

  /** A flash: `radius` growing by `grow` (×radius) while it fades from `alpha` over `max` seconds */
  private flash(x: number, y: number, radius: number, color: number, alpha: number, max: number, grow: number, tex: Texture = disc()): void {
    this.flashes.push({ x, y, radius, life: 0, max, color, alpha, grow, tex });
  }

  // Public methods for effects

  private entityAt = (id: number) => {
    const e = this.state.entities.get(id);
    return e ? { x: e.renderX, y: e.renderY } : null;
  };

  /** A station's turret fired on `target`: it swings onto it; returns where the shot starts (null: no such station or target) */
  stationFire(station: number, turret: number, target: number): StationShot | null {
    const view = this.stations.get(station), s = this.state.entities.get(station), t = this.state.entities.get(target);
    if (!view || !s || !t) return null;
    return view.fire(turret, target, s.renderX, s.renderY, t.renderX, t.renderY);
  }

  /** Something took damage: asteroids flash and jolt (ships do their own, ShipRenderer.hit) */
  hitEntity(id: number, amount: number): void {
    if (this.state.entities.get(id)?.type !== EntityType.Asteroid) return;
    this.rockHits.set(id, { at: performance.now(), strength: Math.min(1, 0.45 + amount / 50) });
  }

  private animateRockHit(container: Container, id: number, size: number): void {
    const hit = this.rockHits.get(id)!;
    const k = Math.max(0, 1 - (performance.now() - hit.at) / 170);
    let flash = container.getChildByLabel('rockFlash') as Graphics | null;
    if (!flash && k > 0) {
      // The rock's outline in white, made on its first hit and kept (hidden) after
      flash = new Graphics().poly(getAsteroidPolygon(id, 0, 0, size).flatMap((v) => [v.x, v.y])).fill({ color: 0xffffff });
      flash.label = 'rockFlash';
      flash.blendMode = 'add';
      container.addChild(flash);
    }
    if (flash) {
      flash.visible = k > 0;
      flash.alpha = 0.5 * hit.strength * k * k * k;
    }
    container.scale.set(1 + 0.03 * hit.strength * k * k);
    if (k <= 0) this.rockHits.delete(id);
  }

  /** A hit's number over what it hit: yellow and bigger for a critical, small and grey for a glancing hit (a gun too weak for that armour) */
  showDamageNumber(entityId: number, amount: number, critical?: boolean, glancing?: boolean): void {
    const entity = this.state.getEntity(entityId);
    if (!entity) return;
    // A bitmap font (its digits drawn once), pooled: no text rasterised and uploaded per hit
    if (!Renderer.fontInstalled) {
      BitmapFont.install({ name: 'DamageNumbers', style: { fontFamily: 'Arial', fontSize: 36, fill: 0xffffff, fontWeight: 'bold' }, chars: [['0', '9']], resolution: 2 });
      Renderer.fontInstalled = true;
    }
    const text = this.numberPool.pop() ?? new BitmapText({ text: '', style: { fontFamily: 'DamageNumbers', fontSize: 18 } });
    text.text = Math.floor(amount).toString();
    text.style.fontSize = critical ? 24 : glancing ? 14 : 18;
    text.tint = critical ? 0xffff00 : glancing ? 0x94a3b8 : 0xff4444;
    text.anchor.set(0.5);
    text.alpha = 1;
    text.visible = this.showDamageNumbers;
    text.rotation = this.cameraAngle;
    this.effectContainer.addChild(text);

    text.scale.set(1.6 * this.tagScale);
    const jx = (Math.random() - 0.5) * 24 * this.tagScale;
    // (Its rise and drift along the screen's axes, from the hit)
    const o = screenToWorldDir(jx, -30, this.cameraAngle);
    text.x = entity.renderX + o.x;
    text.y = entity.renderY + o.y;
    this.damageNumbers.push({
      drift: jx * 1.5,
      x: entity.renderX,
      y: entity.renderY,
      ox: jx,
      oy: -30,
      amount,
      critical: critical || false,
      lifetime: 1,
      text,
    });
  }

  showExplosion(entityId: number): void {
    const entity = this.state.getEntity(entityId);
    if (!entity) return;
    const particleCount = 30;
    for (let i = 0; i < particleCount; i++) {
      const angle = (i / particleCount) * Math.PI * 2;
      const speed = 2 + Math.random() * 4;
      this.spark(entity.renderX, entity.renderY, Math.cos(angle) * speed, Math.sin(angle) * speed, 0.5 + Math.random() * 0.5, 5,
        Math.random() > 0.5 ? 0xff8800 : 0xffff00, { maxLife: 1 });
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
      case EffectType.WarpOut:
      case EffectType.WarpIn:
        // (data 2: something's spooling up to come through here, a few seconds off)
        if (data?.[0] === 2) this.createArrivalWarning(x, y);
        else this.createWarpEffect(x, y, type === EffectType.WarpOut);
        break;
      // Add more effect types as needed
    }
  }
  
  /**
   * A ship went through a gate (out: leaving here; in: arriving): a white-blue
   * flash and a shockwave ring, as the jump drive's launch and arrival (JumpFx).
   */
  private createWarpEffect(x: number, y: number, out: boolean): void {
    if (out) {
      this.flash(x, y, 70, 0xe8f6ff, 0.85, 0.45, 1.6);
      this.flash(x, y, 60, 0x7dd3fc, 0.9, 0.8, 9, ring());
      this.flash(x, y, 40, 0x3b82f6, 0.6, 0.6, 5, ring());
    } else {
      this.flash(x, y, 50, 0xe8f6ff, 0.7, 0.35, 1);
      this.flash(x, y, 45, 0x7dd3fc, 0.8, 0.55, 4, ring());
    }
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * Math.PI * 2, sp = (out ? 4 : 2.5) + Math.random() * 4;
      this.spark(x, y, Math.cos(a) * sp, Math.sin(a) * sp, 0.3 + Math.random() * 0.3, 3 + Math.random() * 3, Math.random() > 0.4 ? 0x9fd8ff : 0xffffff,
        { maxLife: 0.6, size: 0.8, tex: softDot() });
    }
  }

  /**
   * Something is about to come through here (a gate spooling up, a front
   * arriving out of the dark): slow amber rings drawing in, a few seconds'
   * warning to get ready or get clear.
   */
  private createArrivalWarning(x: number, y: number): void {
    for (let k = 0; k < 4; k++) this.flash(x, y, 380 - k * 60, 0xffb547, 0.5, 0.9 + k * 0.55, -0.6, ring());
    this.flash(x, y, 160, 0xffd890, 0.35, 3, 0.4);
  }

  private createMineArmEffect(x: number, y: number): void {
    // Pulsing ring effect when mine arms
    this.flash(x, y, 20, 0xff4444, 0.8, 0.21, 2, ring());
  }

  private createExplosionAt(x: number, y: number, radius: number): void {
    const particleCount = Math.floor(radius / 3); // More particles
    const debrisCount = Math.floor(radius / 10); // Add debris

    // Main explosion particles: white/yellow core to orange/red edges
    for (let i = 0; i < particleCount; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 1 + Math.random() * 4;
      const roll = Math.random();
      const color = roll < 0.2 ? 0xffffff : roll < 0.4 ? 0xffffaa : roll < 0.7 ? 0xff8800 : 0xff4400;
      this.spark(x, y, Math.cos(angle) * speed, Math.sin(angle) * speed, 0.2 + Math.random() * 0.5, 2 + Math.random() * 4, color, { maxLife: 0.7, size: 1.2 });
    }
    // Debris chunks, spinning
    for (let i = 0; i < debrisCount; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 2 + Math.random() * 3;
      this.spark(x, y, Math.cos(angle) * speed, Math.sin(angle) * speed, 0.5 + Math.random() * 0.5, 3 + Math.random() * 5, 0x6a6a6a,
        { maxLife: 1, tex: rock(i), rot: Math.random() * Math.PI * 2, rotSpeed: (Math.random() - 0.5) * 10 });
    }
    // Central flash
    this.flash(x, y, radius * 0.8, 0xffffff, 0.8, 0.13, 0.8);

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

  // Update active lasers (call from render loop)

  private createTractorBeam(startX: number, startY: number, targetX: number, targetY: number): void {
    this.tractorBeams.push({ startX, startY, targetX, targetY, progress: 0 });
  }

  private updateTractorBeams(dt: number): void {
    const pool = this.beamPool;
    pool.begin();
    let w = 0;
    for (const beam of this.tractorBeams) {
      beam.progress += dt * 2.5; // ~0.4 second animation
      if (beam.progress >= 1) continue;
      this.tractorBeams[w++] = beam;

      // Animate the item moving toward the player
      const t = beam.progress;
      const easeT = 1 - Math.pow(1 - t, 3); // Ease out cubic
      const currentX = beam.startX + (beam.targetX - beam.startX) * easeT;
      const currentY = beam.startY + (beam.targetY - beam.startY) * easeT;

      // Pulsing energy beam from player to item pickup point: a wide glow and a bright core
      const pulse = Math.sin(t * Math.PI * 8) * 0.3 + 0.7;
      const beamWidth = 3 + pulse * 2;
      const len = Math.hypot(currentX - beam.targetX, currentY - beam.targetY);
      const rot = Math.atan2(currentY - beam.targetY, currentX - beam.targetX);
      const fade = 1 - t;
      for (const [width, color, alpha] of [[beamWidth + 8, 0x00ffff, 0.3], [beamWidth, 0xaaffff, 0.7], [1.5, 0xffffff, 0.8]] as const) {
        const sp = pool.take(streak(), beam.targetX, beam.targetY, 0, 0.5, color, alpha * fade);
        const sc = streakScale(len, width);
        sp.scale.set(sc.x, sc.y);
        // The streak's tail cap starts half a width behind its anchor
        sp.position.set(beam.targetX - Math.cos(rot) * width / 2, beam.targetY - Math.sin(rot) * width / 2);
        sp.rotation = rot;
      }

      // Item dot at current position
      const dotSize = 6 * (1 - t * 0.5);
      pool.take(softDot(), currentX, currentY, 0.5, 0.5, 0x00ffff, 0.5).scale.set(((dotSize + 4) * 2) / DOT_SIZE);
      pool.take(disc(), currentX, currentY, 0.5, 0.5, 0xffffff, 0.8).scale.set((dotSize * 2) / DOT_SIZE);

      // Sparkle particles along beam (about 18 a second)
      if (Math.random() < dt * 18) {
        const sparkT = Math.random();
        const sparkX = beam.targetX + (currentX - beam.targetX) * sparkT;
        const sparkY = beam.targetY + (currentY - beam.targetY) * sparkT;

        this.spark(sparkX + (Math.random() - 0.5) * 10, sparkY + (Math.random() - 0.5) * 10, (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2,
          0.2, 2 + Math.random() * 2, 0x88ffff, { size: 0.5, alpha: 0.8 });
      }
    }
    this.tractorBeams.length = w;
    pool.end();
  }

  /**
   * Create a bullet hit effect at a position (hitting asteroid/enemy)
   */
  private createBulletHitEffect(x: number, y: number, damage: number, hue: number): void {
    const color = this.hueToColor(hue);
    // Flash at impact point
    this.flash(x, y, 8 + damage * 0.5, 0xffffff, 0.8, 0.08, 0);
    this.flash(x, y, 5 + damage * 0.3, color, 0.9, 0.08, 0);
    // Spark particles
    const sparkCount = Math.min(12, 4 + Math.floor(damage / 5));
    for (let i = 0; i < sparkCount; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 2 + Math.random() * 4;
      this.spark(x, y, Math.cos(a) * sp, Math.sin(a) * sp, 0.15 + Math.random() * 0.15, 1.5 + Math.random() * 1.5, Math.random() > 0.3 ? color : 0xffffff,
        { maxLife: 0.3, size: 0.6 });
    }
  }

  /**
   * Create asteroid break/destroy effect
   */
  private createAsteroidBreakEffect(x: number, y: number, size: number, hue: number): void {
    const color = this.hueToColor(hue);
    const particleCount = Math.min(30, Math.floor(size / 3));
    // Central flash, expanding as it fades
    this.flash(x, y, size * 1.2, 0xffffff, 0.6, 0.16, 1.5);
    // Rock debris
    for (let i = 0; i < particleCount; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 1 + Math.random() * 4;
      this.spark(x + (Math.random() - 0.5) * size * 0.5, y + (Math.random() - 0.5) * size * 0.5, Math.cos(angle) * speed, Math.sin(angle) * speed,
        0.5 + Math.random() * 0.5, 2 + Math.random() * (size / 10), Math.random() > 0.2 ? color : this.hueToColor(hue + 10),
        { maxLife: 1, size: 0.8, tex: rock(i), rot: Math.random() * Math.PI * 2 });
    }
    // Dust cloud (small fading particles)
    for (let i = 0; i < particleCount / 2; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 0.5 + Math.random() * 2;
      this.spark(x, y, Math.cos(angle) * speed, Math.sin(angle) * speed, 0.3 + Math.random() * 0.3, 3 + Math.random() * 4, color,
        { maxLife: 0.6, size: 0.5, alpha: 0.4 });
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

  showDeathScreen(killerName?: string): void {
    if (this.deathOverlay) return;
    this.killerName = killerName;
    this.deathAt = performance.now();
    this.buildDeathScreen();
  }

  /** The overlay (it fades and settles in from deathAt, see updateScreen) */
  private buildDeathScreen(): void {
    const w = this.app.screen.width, h = this.app.screen.height;
    this.deathOverlay = new Container();
    this.deathOverlay.alpha = 0;

    const bg = new Graphics();
    bg.rect(0, 0, w, h);
    bg.fill({ color: 0x000000, alpha: 0.7 });
    this.deathOverlay.addChild(bg);

    const text = new Text({
      text: 'DESTROYED',
      style: new TextStyle({ fontFamily: 'Arial', fontSize: 48, fill: 0xff4444, fontWeight: 'bold', letterSpacing: 6 }),
    });
    text.anchor.set(0.5);
    text.position.set(w / 2, h / 2 - 50);
    text.label = 'deathTitle';
    this.deathOverlay.addChild(text);

    if (this.killerName) {
      const by = new Text({
        text: `by ${this.killerName}`,
        style: new TextStyle({ fontFamily: 'Arial', fontSize: 20, fill: 0xffb4a8 }),
      });
      by.anchor.set(0.5);
      by.position.set(w / 2, h / 2 - 8);
      this.deathOverlay.addChild(by);
    }

    const subText = new Text({
      text: 'Press R to respawn',
      style: new TextStyle({ fontFamily: 'Arial', fontSize: 24, fill: 0xffffff }),
    });
    subText.anchor.set(0.5);
    subText.position.set(w / 2, h / 2 + 34);
    this.deathOverlay.addChild(subText);

    this.uiContainer.addChild(this.deathOverlay);
  }

  hideDeathScreen(): void {
    if (this.deathOverlay) {
      this.uiContainer.removeChild(this.deathOverlay);
      this.deathOverlay.destroy({ children: true });
      this.deathOverlay = null;
    }
  }

  /** (Through the view's roll; not the shake) */
  screenToWorld(screenX: number, screenY: number): { x: number; y: number } {
    return screenToWorld(screenX, screenY, this.pose(), this.app.screen.width, this.app.screen.height);
  }

  worldToScreen(worldX: number, worldY: number): { x: number; y: number } {
    return worldToScreen(worldX, worldY, this.pose(), this.app.screen.width, this.app.screen.height);
  }

  private pose(): { x: number; y: number; zoom: number; angle: number } {
    return { x: this.cameraX, y: this.cameraY, zoom: this.cameraZoom, angle: this.cameraAngle };
  }

  setZoom(zoom: number): void {
    this.cameraZoom = zoom;
  }

  /** The firing ship's pose on a shell's fire tick (the flash sits exactly on the barrel) */
  set firePoseOf(fn: WeaponFx['firePose']) {
    this.weaponFx.firePose = fn;
  }

  /** A shell your client fired ahead of the server (WeaponFx.predict) */
  predictShot(p: PredictedShell): void {
    this.weaponFx.predict(p);
  }

  /** Called when a shot is seen leaving its gun (owner, muzzle point) */
  /** Where a shot comes out of its drawn barrel (WeaponFx.barrelTip) */
  set barrelTip(fn: WeaponFx['barrelTip']) {
    this.weaponFx.barrelTip = fn;
  }

  set onMuzzle(fn: ((owner: number, x: number, y: number) => void) | null) {
    this.weaponFx.onMuzzle = fn;
  }

  /** The server reported where a projectile hit: stop its tracer there and throw sparks. */
  showProjectileHit(projectileId: number | undefined, x: number, y: number): void {
    this.weaponFx.onHit(projectileId, x, y);
  }

  /** World-space layer for effects (above entities). */
  getEffectLayer(): Container {
    return this.effectContainer;
  }

  /** World-space layer for ships, above every other entity. */
  getShipLayer(): Container {
    return this.shipLayer;
  }

  getZoom(): number {
    return this.cameraZoom;
  }

  /** Share of the small effect particles spawned (the quality setting) */
  private particleKeep = 1;

  /** Apply a graphics quality tier (settings/quality.ts) */
  setQuality(q: QualityProfile): void {
    this.bloom.setQuality(q.bloomScale, q.bloomQuality);
    this.sky.setDetail(q.hazeScale, q.starLayers);
    this.particleKeep = q.particles;
  }

  /** A layer of glowing things for the bloom */
  addBloomSource(c: Container): void {
    this.bloom.add(c);
  }

  /** Once a frame, after everything has moved and before the bloom: hand every lit mesh its lights */
  applyLighting(): void {
    const w = this.app.screen.width, h = this.app.screen.height;
    this.lighting.frame({ x: this.cameraX, y: this.cameraY, r: Math.hypot(w, h) / 2 / this.cameraZoom });
  }

  /**
   * A system's light: its ambient (from its sky, dimmer in dark systems, or
   * set in its data) and its central body's (a sun's warm light, a black
   * hole's disc glow, a pulsar's cold one).
   */
  private lightSystem(v: SystemVisuals, biome: SkyBiome): void {
    const sys = this.sys.data;
    // A planet's surface: daylight, from the same way the ground is shaded
    const day = sys?.surface ? this.surface.light() : null;
    if (day) {
      const tl = Math.max(...day.tint) || 1;
      // Underground: no sun, a little dim light, most of it the glow of the cracks in the floor coming up
      if (!day.sun) {
        this.lighting.ambient = [0, 1, 2].map((i) => day.ambient * (0.45 + 0.55 * (day.tint[i] / tl))) as [number, number, number];
        this.lighting.sun.power = 0;
        this.lighting.ground = day.ground;
        this.day = { ambient: [...this.lighting.ambient] as [number, number, number], power: 0 };
        return;
      }
      const lava = sys?.surface?.kind === 'lava';
      // (a lava world's sky is its own haze: the light takes much more of its colour, and the sun comes through it warm)
      this.lighting.ambient = [0, 1, 2].map((i) => day.ambient * ((lava ? 0.55 : 0.8) + (lava ? 0.45 : 0.2) * (day.tint[i] / tl))) as [number, number, number];
      Object.assign(this.lighting.sun, { x: -SUN_DIR[0] * 1e8, y: -SUN_DIR[1] * 1e8, falloff: 1e9, power: 0.8, color: lava ? [1, 0.82, 0.66] : [1, 0.96, 0.88], elevation: 0.85 });
      this.lighting.ground = day.ground;
      this.day = { ambient: [...this.lighting.ambient] as [number, number, number], power: 0.8 };
      return;
    }
    this.lighting.ground = [0, 0, 0];
    const AMBIENT: Record<string, number> = { band: 0.3, cluster: 0.32, emission: 0.28, ember: 0.22, remnant: 0.22, void: 0.06, abyss: 0.07 };
    let level = typeof sys?.visuals?.ambient === 'number' ? sys.visuals.ambient : AMBIENT[biome.kind] ?? 0.25;
    if (v.hazards?.includes('darkness')) level *= 0.6;
    // Tinted a little by the sky's own colour
    const tint = biome.nebula.strength > 0.05 ? biome.nebula.b : biome.band.edge;
    const tl = Math.max(tint[0], tint[1], tint[2]) || 1;
    this.lighting.ambient = [0, 1, 2].map((i) => level * (0.75 + 0.25 * (tint[i] / tl))) as [number, number, number];
    const sun = this.lighting.sun;
    sun.x = 0; sun.y = 0;
    if (v.noCentralBody) sun.power = 0;
    else if (v.centralType === 'black_hole') {
      Object.assign(sun, { power: 1.1, falloff: (v.centralRadius ?? 1000) * 10, color: this.hslRgb(v.centralHue ?? 30, 0.85, 0.62), elevation: 0.55 });
    } else if (v.centralType === 'pulsar') {
      Object.assign(sun, { power: 0.9, falloff: 25000, color: this.hslRgb(v.centralHue ?? 190, 0.6, 0.78), elevation: 0.7 });
    } else if (v.centralType === 'brown_dwarf') {
      // Dim and red: the planets and rocks catch a low ember light
      Object.assign(sun, { power: 0.75, falloff: 30000 + (v.centralRadius ?? 0), color: this.hslRgb(v.centralHue ?? 14, 0.75, 0.6), elevation: 0.45 });
    } else {
      const r = v.detailStar ? v.detailParams?.radius ?? v.starRadius : v.starRadius;
      Object.assign(sun, { power: 1.0, falloff: 39000 + r, color: this.hslRgb(v.starHue, 0.55, 0.84), elevation: 0.55 });
    }
  }

  /** How dark it is on this surface (0 day .. 1 night): a moon siege's nights */
  setNight(k: number): void {
    this.surface.setNight(k);
  }

  /** Each ship's shadow on the ground, cast away from the sun */
  /** `under`: underground (no sun: each falls nearly straight below its ship, darker, the glow all round softening it) */
  private drawShadows(under = false): void {
    this.shadows.begin();
    for (const [id, r] of this.shipRadius) {
      const e = this.state.entities.get(id);
      if (!e) continue;
      const off = under ? 20 + r * 0.25 : 60 + r * 0.9;
      const s = this.shadows.take(glowBall(), e.renderX + SUN_DIR[0] * off, e.renderY + SUN_DIR[1] * off, 0.5, 0.5, 0x000000, under ? 0.62 : 0.42);
      s.scale.set((r * (under ? 2.9 : 2.6)) / DOT_SIZE);
    }
    this.shadows.end();
  }

  /** A surface's city (built once while you're there) and the edge of its map */
  private setCity(sys: StarSystemData | null): void {
    const id = sys?.id ?? null;
    if ((this.city?.system ?? null) === id) return;
    this.city?.view?.dispose();
    this.city?.bastion?.dispose();
    this.city = null;
    this.surfaceEdge.clear();
    if (!sys?.surface) return;
    const s = sys.surface;
    const view = s.city ? new CityView(s.city, s.seed ?? 1, this.lighting) : null;
    const bastion = s.bastion ? new BastionView(s.bastion, this.lighting) : null;
    if (view) this.backgroundContainer.addChild(view.container);
    if (bastion) this.backgroundContainer.addChild(bastion.container);
    this.city = { system: sys.id, view, bastion };
    // The edge: a dashed ring (fly past it to climb back to orbit)
    const R = s.radius, dashes = 120;
    for (let k = 0; k < dashes; k++) {
      const a0 = (k / dashes) * Math.PI * 2, a1 = a0 + (Math.PI * 2 / dashes) * 0.55;
      this.surfaceEdge.moveTo(Math.cos(a0) * R, Math.sin(a0) * R).arc(0, 0, R, a0, a1);
    }
    this.surfaceEdge.stroke({ color: 0xe8f4ff, width: 40, alpha: 0.35 });
  }

  /** The renderer's own lights: old-style flashes, loot, rifts, stations */
  private collectLights(L: Lighting): void {
    this.weaponFx.collectLights(L);
    for (const f of this.flashes) {
      const t = f.life / f.max;
      L.point(f.x, f.y, f.color, f.radius * (1 + f.grow * t) * 3 + 40, f.alpha * (1 - t) * 1.2);
    }
    const RARITY = [0xc8d0dc, 0x5fd38d, 0x4fa3ff, 0xc77dff, 0xffb347];
    for (const [id, c] of this.entityGraphics) {
      if (!c.visible) continue;
      const e = this.state.entities.get(id);
      if (!e) continue;
      if (e.type === EntityType.DroppedItem) L.point(c.x, c.y, RARITY[Math.max(0, Math.min(4, e.data?.[0] ?? 0))], 170, 0.45, 50);
      else if (e.type === EntityType.Portal) L.point(c.x, c.y, e.data?.[1] === 1 ? 0xb28cff : 0x7dd3fc, 1600, 0.8 * (this.gates.get(id)?.pulse ?? 1), 300);
      else if (e.type === EntityType.Station) this.stations.get(id)?.collectLights(L, c.x, c.y, c.rotation);
    }
    // In space, ships shade the structures under them (on a surface they have their shadows on the ground)
    if (!this.surface.active) for (const [id, r] of this.shipRadius) {
      const e = this.state.entities.get(id);
      if (e) L.shadow(e.renderX, e.renderY, r);
    }
  }

  /** Once a frame, after everything has moved */
  renderBloom(): void {
    this.bloom.render();
  }

  onResize(): void {
    this.bloom.resize();
    this.sky.resize();
    this.surface.resize();
    // Update any screen-space UI (the death screen keeps its place in its fade)
    if (this.deathOverlay) {
      const old = this.deathOverlay;
      const alpha = old.alpha, titleScale = old.getChildByLabel('deathTitle')?.scale.x;
      this.uiContainer.removeChild(old);
      old.destroy({ children: true });
      this.buildDeathScreen();
      // (It starts at 0: carry the fade across, so a resize while dead doesn't flash the world back)
      if (this.deathOverlay) {
        this.deathOverlay.alpha = alpha;
        if (titleScale !== undefined) this.deathOverlay.getChildByLabel('deathTitle')?.scale.set(titleScale);
      }
    }
    
    // Reposition minimap
    if (this.minimapContainer) {
      this.minimapContainer.x = this.app.screen.width - this.MINIMAP_SIZE - 15;
    }
    
    // Starfield quad rescales itself in update(), nothing to do here
  }
  
  /** The minimap's nests and way-ins together (reused) */
  private nestScratch: typeof this.wayIns = [];

  private updateMinimap(): void {
    if (!this.minimapGraphics || !this.minimapContainer) return;
    
    const g = this.minimapGraphics;
    g.clear();
    // Turned with the view, so it reads the same way as the screen
    g.pivot.set(this.MINIMAP_SIZE / 2, this.MINIMAP_SIZE / 2);
    g.position.set(this.MINIMAP_SIZE / 2, this.MINIMAP_SIZE / 2);
    g.rotation = -this.cameraAngle;
    
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

    // Hostile nests: a triangle in their faction's colour
    const nestList = this.nestScratch;
    nestList.length = 0;
    for (const n of this.sys.data?.nests ?? []) nestList.push(n);
    for (const n of this.wayIns) nestList.push(n);
    for (const n of nestList) {
      const at = nestPosition(n, this.sys.data?.planets, this.state.getRawServerTick());
      const dx = at.x - playerPos.x, dy = at.y - playerPos.y;
      if (dx * dx + dy * dy > this.MINIMAP_RANGE * this.MINIMAP_RANGE) continue;
      const mx = center + dx * scale, my = center + dy * scale;
      g.poly([mx, my - 6, mx + 5.5, my + 4, mx - 5.5, my + 4]);
      g.fill({ color: nestColor(n.faction), alpha: 0.35 });
      g.stroke({ color: nestColor(n.faction), width: 1.5, alpha: 0.95 });
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

        case EntityType.ShipBody: {
          // data[0]: 3 hostile (in its faction's colour; bigger for elites and bosses), 2 traffic, 1 wreck/derelict
          const kind = entity.data?.[0] ?? 0;
          if (kind === 3) {
            const rank = entity.data?.[4] ?? 0;
            g.circle(mx, my, rank === 2 ? 6 : rank === 1 ? 4.5 : 3.5);
            // (Grey while it's a passive pack nobody's provoked)
            g.fill({ color: entity.data?.[9] === 1 ? 0x9ca3af : FACTION_COLORS[entity.data?.[3] ?? -1] ?? 0xff4444, alpha: entity.data?.[9] === 1 ? 0.7 : 0.95 });
          } else if (kind === 2) {
            g.circle(mx, my, 2.5);
            g.fill({ color: 0x9fd8ff, alpha: 0.75 }); // Pale blue for traffic
          } else if (kind === 1) {
            g.circle(mx, my, 2.5);
            g.fill({ color: 0x8a8a8a, alpha: 0.7 }); // Grey for wrecks and derelicts
          }
          break;
        }
          
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
