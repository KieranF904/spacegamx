/**
 * @contract client.render.renderer
 * owns:       the PixiJS scene: layers, camera, entity views, background and lighting, per frame
 * needs:      GameState, renderer/{particleFx,damageNumbers,deathScreen,minimap,panControl,entityParts,systemVisuals}, WeaponFx, SunRenderer, SkyRenderer, SurfaceRenderer, Lighting; npm: @space-game/common
 * invariants: one update(delta) per frame draws everything from GameState — none pinned
 *             effects, hit numbers, minimap and death screen are modules under renderer/, not code here — none pinned
 * extend:     a new effect or overlay is a module under renderer/ created in the constructor and stepped in update()
 */

import { Bloom } from './Bloom';
import { PanControl } from './renderer/panControl';
import { placeUpright, buildPlayerParts, buildPortalParts, updateHealthBar, type Tag, type Gate } from './renderer/entityParts';
import { DEFAULT_SYSTEM_VISUALS, visualsFromInfo, lightSystem, type SystemVisuals, type Day } from './renderer/systemVisuals';
import { ParticleFx } from './renderer/particleFx';
import { DamageNumbers } from './renderer/damageNumbers';
import { DeathScreen } from './renderer/deathScreen';
import { Minimap } from './renderer/minimap';
import type { QualityProfile } from '../settings/quality';
import { SpritePool } from './spritePool';
import { disc, ring, rock, glowBall, vignette, DOT_SIZE } from './fxTextures';
import { stepOverlays, screenTint } from './overlayFrame';
import { cameraView, helmFollow, MAX_VIEW_SPIN, NORTH_RETURN_RATE, screenToWorld, screenToWorldDir, smoothAngle, viewHalfExtents, worldToScreen, worldToScreenDir } from './cameraView';
import { PlanetRenderer } from './PlanetRenderer';
import { setPlanetDetail } from './planet-proto/planetQuad';
import { installVolumeUpload } from './texture3d';
import { SceneryRenderer } from './Scenery';
import { NestRenderer } from './NestViews';
import systemsData from '../../../data/systems.json';
import {
  Application,
  Sprite,
  Container,
  Graphics,
  Text,
  TextStyle,
} from 'pixi.js';
import { GameState } from '../state/GameState';
import { WeaponFx, shotTimelines, type PredictedShell } from './weapons/WeaponFx';
import { MiningStrikeFx } from './weapons/MiningStrikeFx';
import { LootPodView } from './LootPodView';
import { TerrainView } from './TerrainView';
import { terrainFor } from './terrainData';
import { MobView } from './MobView';
import { drawAsteroid, AsteroidSeams } from './AsteroidLook';
import { RiftShader } from './RiftShader';
import { StationShot, StationView } from './StationView';
import { CentralBodyShaders } from './CentralBodyShaders';
import { SunRenderer, starOf } from './sun/SunRenderer';
import type { StarBody } from './sun/plasmaSun';
import {
  EntityType,
  EffectType,
  getAsteroidPolygon,
  pocketsFrom,
  entranceNest,
} from '@space-game/common';
import { SkyRenderer } from './sky/SkyRenderer';
import { SurfaceRenderer, SUN_DIR } from './surface/SurfaceRenderer';
import { CityView } from './surface/CityView';
import { BastionView } from './surface/siege/BastionView';
import { Lighting } from './lighting/Lighting';
import { AsteroidBatch } from './lighting/AsteroidBatch';
import { skyBiome, SkyBiome } from './sky/skyBiome';
import type { NestData, ServerSystemInfoMessage, StarSystemData } from '@space-game/common';

/** Seconds to fade an entity in as it appears, or out as it goes */
const FADE = 0.25;
/** A panned view (middle mouse) keeps your ship at least this fraction of the screen in from every edge */
const PAN_MARGIN = 0.1;

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
  /** Mining strikes on rock (a hit that rolls for ore), and a chunk's richer puff where it appears (weapons/MiningStrikeFx.ts) */
  private miningStrikes = new MiningStrikeFx({ spark: (...a) => this.fx.spark(...a), flash: (...a) => this.fx.flash(...a) }, () => performance.now() / 1000);
  /** A loot pod appeared at (x, y) (a mined chunk among them: ships/MiningProgress.ts takes it as your drop when it's by your strikes) */
  onPodAppeared: ((x: number, y: number) => void) | null = null;
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
  /** Seconds the view has been following a heading (helm): it follows loosely at first, then closely */
  private helmTime = 0;
  private cameraHeading: number | null = null;
  /** The middle-mouse drag of the view and its button (renderer/panControl.ts); the view always keeps the ship PAN_MARGIN inside the screen */
  private panCtl: PanControl;
  /** Camera catch-up per frame (0..1) */
  public cameraFollow = 0.1;
  /** Display settings */
  public shakeScale = 1;
  get showDamageNumbers(): boolean { return this.damageNumbers.visible; }
  set showDamageNumbers(v: boolean) { this.damageNumbers.visible = v; }
  public showNames = true;
  
  /** The star (plasma, drawn at a share of the screen's resolution: sun/SunRenderer.ts) */
  readonly sun: SunRenderer;
  /** A system's star, for one not in systems.json (made from its visuals once) */
  private starBodies = new WeakMap<SystemVisuals, StarBody>();
  
  // GPU procedural starfield (sandbox-style)
  private sky: SkyRenderer;
  /** A planet's ground and clouds, in place of the sky while you're on one */
  private surface: SurfaceRenderer;
  private city: { system: string; view: CityView | null; bastion: BastionView | null } | null = null;
  private day: Day = { ambient: [1, 1, 1], power: 0, sun: [1, 1, 1] };
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

  // Effects
  private fx!: ParticleFx;
  private damageNumbers!: DamageNumbers;
  private death!: DeathScreen;
  private minimap!: Minimap;
  // Debug asteroid markers (server-provided)
  private debugAsteroidGraphics: Graphics;
  private debugAsteroidMarkers: { x: number; y: number; expiresAt: number }[] = [];
  private debugDrawn = false;
  /** Glow over the bright effects (Display settings) */
  readonly bloom: Bloom;
  // Death screen
  /** A soft dark edge to the screen (reddening when you're hit) */
  private vignette = new Sprite(vignette());
  
  // Culling margin (pixels beyond viewport to render)
  private readonly CULL_MARGIN = 200;
  
  // Animation timing
  private time: number = 0;

  constructor(app: Application, state: GameState) {
    this.app = app;
    this.state = state;
    // (the planets' noise is a 3D texture: planet-proto/planetTextures.ts)
    installVolumeUpload(app.renderer);
    this.panCtl = new PanControl(app.canvas as HTMLCanvasElement, { zoom: () => this.cameraZoom, locked: () => !!this.cameraTarget });

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
    this.fx = new ParticleFx(this.effectContainer, this.state);
    
    this.app.stage.addChild(this.worldContainer);
    // Bloom over the world, under the UI (see Bloom.ts)
    this.bloom = new Bloom(app);
    this.bloom.add(this.weaponFx.glowLayer);
    this.bloom.addTo(this.app.stage);
    this.app.stage.addChild(this.uiContainer);
    // The vignette under the rest of the UI
    this.uiContainer.addChild(this.vignette);
    
    // The star: its disc, chromosphere and corona in one (behind the central bodies, planets and everything else)
    this.sun = new SunRenderer(this.app);
    this.backgroundContainer.addChild(this.sun.container);
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
    this.damageNumbers = new DamageNumbers(this.effectContainer, { tagScale: () => this.tagScale, cameraAngle: () => this.cameraAngle });
    this.death = new DeathScreen(this.uiContainer, () => this.app.screen);
    
    this.minimap = new Minimap(() => this.app.screen.width, this.uiContainer, this.state, {
      cameraAngle: () => this.cameraAngle,
      sysData: () => this.sys.data,
      wayIns: () => this.wayIns,
    });
  }
  
  setCurrentSystem(systemId: string): void {
    this.currentSystemId = systemId;
  }

  /**
   * Store data-driven system visuals from a server systemInfo message.
   * Called when entering a system (or on join).
   */
  setSystemInfo(msg: ServerSystemInfoMessage): void {
    this.systemVisuals.set(msg.systemId, visualsFromInfo(msg));  }

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
    this.damageNumbers.update(delta);

    this.minimap.tick();
    this.updateScreen();
    // The 2D overlay canvases, in step with this frame (every few frames on the lower tiers)
    this.overlayDelta += delta;
    if (++this.overlayFrames >= this.hudEvery) {
      stepOverlays(this.overlayDelta);
      this.overlayDelta = 0;
      this.overlayFrames = 0;
    }
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

    this.death.step();
  }

  /** Whether a circle (world units) is on screen (ShipRenderer skips work for ships that aren't) */
  inView(x: number, y: number, r: number): boolean {
    const v = this.viewBox();
    return Math.abs(x - this.cameraX) <= v.hw + r && Math.abs(y - this.cameraY) <= v.hh + r;
  }

  /**
   * Where asteroids must be exact this frame (GameState.orbitFocus): the view round the camera and round the pilot (the
   * camera moves after the rocks are placed, and snaps to the pilot on a jump), with a margin; `shown` false (the world
   * hidden under the map or the hangar): just round the pilot.
   */
  orbitFocus(px: number, py: number, shown: boolean, out: { cx: number; cy: number; px: number; py: number; hw: number; hh: number }): void {
    const v = this.viewBox(), m = 600;
    out.px = px; out.py = py;
    if (shown) { out.cx = this.cameraX; out.cy = this.cameraY; out.hw = v.hw + m; out.hh = v.hh + m; }
    else { out.cx = px; out.cy = py; out.hw = out.hh = 2000; }
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
    this.minimap.setVisible(on);
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
      this.nests.set([...(sys?.nests ?? []).filter((n) => !n.hidden), ...this.wayIns], sys?.planets);
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

  /** Next frame the view goes straight onto your ship (pan, roll and all), no easing: behind the loading screen, so it
   *  is already there when the screen lifts (app/loadingFlow.ts) */
  snapCamera(): void {
    this.cameraSnap = true;
  }
  private cameraSnap = false;

  /** Rock chunks still to be built (and the relief atlas still coming): the loading screen waits for none */
  buildPending(): number {
    return this.rocks.pending;
  }

  /** The view back onto your ship */
  recenter(): void {
    this.panCtl.recenter();
  }

  private updateCamera(dt: number): void {
    const playerPos = this.cameraTarget?.() ?? this.state.getPlayerPosition();
    // Your own ship (not the admin free camera or someone watched): the view may sit off it, as far as keeps the ship a margin inside every edge
    const own = !this.cameraTarget;
    const maxX = Math.max(0, (0.5 - PAN_MARGIN) * this.app.screen.width / this.cameraZoom);
    const maxY = Math.max(0, (0.5 - PAN_MARGIN) * this.app.screen.height / this.cameraZoom);
    this.panCtl.pan.x = Math.max(-maxX, Math.min(maxX, this.panCtl.pan.x));
    this.panCtl.pan.y = Math.max(-maxY, Math.min(maxY, this.panCtl.pan.y));
    // The roll: onto the heading in helm, back to north-up out of it (gentle, and the same at any frame rate)
    // (Not on a free camera or someone else's ship)
    const heading = own ? this.cameraHeading : null;
    this.helmTime = heading === null ? 0 : this.helmTime + dt;
    const roll = heading === null ? { rate: NORTH_RETURN_RATE, maxSpin: MAX_VIEW_SPIN } : helmFollow(this.helmTime);
    if (this.cameraSnap) { this.panCtl.pan.x = this.panCtl.pan.y = 0; this.cameraAngle = heading ?? 0; }
    this.cameraAngle = smoothAngle(this.cameraAngle, heading ?? 0, roll.rate, Math.min(0.1, dt), roll.maxSpin);
    if (heading === null && Math.abs(this.cameraAngle) < 1e-4) this.cameraAngle = 0;
    cameraView.angle = this.cameraAngle;
    const pw = own ? screenToWorldDir(this.panCtl.pan.x, this.panCtl.pan.y, this.cameraAngle) : { x: 0, y: 0 };
    const tx = playerPos.x + pw.x, ty = playerPos.y + pw.y;

    // Smooth camera follow (tighter mid-jump, or the ship would leave the screen; a slow drift while dead).
    // cameraFollow is the catch-up per 60 Hz frame, so it's the same at any frame rate.
    const follow = this.death.active ? this.cameraFollow * 0.12 : this.cameraFollow;
    const lerpFactor = this.cameraSnap ? 1 : 1 - Math.pow(1 - Math.min(1, follow), Math.min(0.1, dt) * 60);
    this.cameraSnap = false;
    this.cameraX += (tx - this.cameraX) * lerpFactor;
    this.cameraY += (ty - this.cameraY) * lerpFactor;
    if (own) {
      // However fast the ship goes (a jump's burn), it never slips past the margin (along the screen's axes)
      const d = worldToScreenDir(this.cameraX - playerPos.x, this.cameraY - playerPos.y, this.cameraAngle);
      const c = screenToWorldDir(Math.max(-maxX, Math.min(maxX, d.x)), Math.max(-maxY, Math.min(maxY, d.y)), this.cameraAngle);
      this.cameraX = playerPos.x + c.x;
      this.cameraY = playerPos.y + c.y;
    }
    const off = own && Math.hypot(this.panCtl.pan.x, this.panCtl.pan.y) * this.cameraZoom > 24;
    this.panCtl.showRecenter(off);

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
    this.surface.setSurface(surface, here?.id);
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
    if (this.city?.bastion) { const vb = this.viewBox(); this.city.bastion.update(Math.min(0.1, delta), { night: this.surface.night, zoom: this.cameraZoom, angle: this.cameraAngle, entities: this.state.entities.ofType(EntityType.ShipBody), view: { x: this.cameraX, y: this.cameraY, hw: vb.hw, hh: vb.hh } }); }
    const lightKey = `${this.currentSystemId}|${this.systemVisuals.has(this.currentSystemId)}`;
    if (lightKey !== this.lightKey) {
      this.lightKey = lightKey;
      lightSystem(this.lighting, this.surface, this.sys.data, systemVisuals, biome, (d) => { this.day = d; });
    }
    if (surface) {
      this.sky.container.visible = false;
      const shake = this.state.screenShake;
      this.surface.update(Math.min(0.1, delta) * 1000, this.cameraX, this.cameraY, zoom,
        { x: (shake.offsetX || 0) * this.shakeScale, y: (shake.offsetY || 0) * this.shakeScale, rot: (shake.rotation || 0) * this.shakeScale - this.cameraAngle });
      this.drawShadows(this.day.power <= 0);
      // Night falls on the light too (headlights come on by themselves in the dark): warm through dusk, cold at night
      const n = this.surface.night, shade = this.surface.shade(), sun = this.lighting.sun;
      for (let i = 0; i < 3; i++) { this.lighting.ambient[i] = this.day.ambient[i] * shade.ambient[i]; sun.color[i] = this.day.sun[i] * shade.sun[i]; }
      sun.power = this.day.power * (1 - 0.92 * n);
      this.shadows.container.alpha = 1 - n * 0.8;
    } else {
      this.shadows.begin();
      this.shadows.end();
    }

    // The star (seconds: the same speed at any frame rate), at the world's origin: drawn into its own target with the
    // camera's transform, and stretched back over the screen in the background layer's frame (the world's)
    const animDelta = Math.min(0.1, delta);
    const plainSun = !systemVisuals.noCentralBody && !systemVisuals.centralType;
    this.centralShaders.set(systemVisuals.centralType ?? null, systemVisuals.centralRadius ?? 1000, systemVisuals.centralHue ?? 30, this.sys.data?.centralBody?.look);
    this.centralShaders.update(animDelta);
    if (plainSun) {
      this.sun.setStar(this.currentSystemId, this.starBody(systemVisuals));
      this.worldContainer.updateLocalTransform();
      const toScreen = this.worldContainer.localTransform;
      this.sun.update(animDelta, toScreen, toScreen);
    } else {
      // (none here: it draws nothing, and the sky has no hole)
      this.sun.setStar(this.currentSystemId, null);
      this.sun.update(animDelta, this.worldContainer.localTransform);
    }
    // The sky after it: nothing drawn behind its disc, none at all when the disc fills the screen
    if (!surface) this.sky.update(Math.min(0.1, delta) * 1000, this.cameraX, this.cameraY, zoom, this.cameraAngle, this.sun.opaqueRadius);
  }

  /** A system's star: its systems.json entry (its look there), else one made from what the server sent */
  private starBody(v: SystemVisuals): StarBody {
    const known = starOf(this.currentSystemId);
    if (known) return known;
    let b = this.starBodies.get(v);
    if (!b) this.starBodies.set(v, (b = { radius: v.starRadius, hue: v.starHue, sunStyle: v.sunStyle, detailStar: v.detailStar, detailParams: v.detailParams, detailColors: v.detailColors }));
    return b;
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
      // Shots are drawn by WeaponFx: no view of their own (one made and dropped per shot rebuilt the scene's draw list)
      if (entity.type === EntityType.Projectile) continue;
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
        // It fades in (asteroids are drawn in batches, which don't fade: they just appear; ship bodies are drawn elsewhere)
        if (entity.type !== EntityType.ShipBody && entity.type !== EntityType.Asteroid) {
          container.alpha = 0;
          this.fadingIn.set(entity.id, 0);
        }
      }

      // Make visible (modular ships keep only their name tag and health bar here)
      container.visible = true;
      if (this.hiddenEntityIds.has(entity.id)) {
        // (the tag's name and bar are shown or not below: set here too, an undamaged ship's bar went on and off every frame)
        for (const c of container.children) if (c.label !== 'nameTag' && c.label !== 'healthBar') c.visible = false;
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
          updateHealthBar(tag, entity);
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
        this.tags.set(id, buildPlayerParts(container));
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
        // (A chunk thrown out of a rock just struck: the strike kept ore, and it shows richer where it appears)
        const at = this.state.entities.get(id);
        if (at) { this.miningStrikes.pod(at.x, at.y); this.onPodAppeared?.(at.x, at.y); }
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
          this.gates.set(id, buildPortalParts(container, id));
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

  private updateEffects(delta: number): void {
    this.fx.update(delta);

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
    // (Each shell on the timeline its firing ship is drawn on: shotTimelines)
    this.weaponFx.update(this.state, delta, ...shotTimelines(this.state));
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

  /** A hit on rock that rolls for ore: rock dust and grit off the face; (dx, dy) out of it (weapons/MiningStrikeFx.ts) */
  miningStrike(x: number, y: number, dx: number, dy: number, material: string | null | undefined, scale = 1): void {
    this.miningStrikes.strike(x, y, dx, dy, material, scale);
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

  /** A hit's number over what it hit (DamageNumbers) */
  showDamageNumber(entityId: number, amount: number, critical?: boolean, glancing?: boolean): void {
    const entity = this.state.getEntity(entityId);
    if (!entity) return;
    this.damageNumbers.show(entity.renderX, entity.renderY, amount, critical, glancing);
  }

  showExplosion(entityId: number): void {
    const entity = this.state.getEntity(entityId);
    if (!entity) return;
    this.fx.explosion(entity.renderX, entity.renderY);
  }

  showEffect(type: EffectType, x: number, y: number, data?: number[], targetX?: number, targetY?: number, _entityId?: number): void {
    this.fx.showEffect(type, x, y, data, targetX, targetY);
  }

  showDeathScreen(killerName?: string): void {
    this.death.show(killerName);
  }

  hideDeathScreen(): void {
    this.death.hide();
  }

  /** (Through the view's roll; not the shake) */
  screenToWorld(screenX: number, screenY: number): { x: number; y: number } {
    return screenToWorld(screenX, screenY, this.pose(), this.app.screen.width, this.app.screen.height);
  }

  worldToScreen(worldX: number, worldY: number): { x: number; y: number } {
    return worldToScreen(worldX, worldY, this.pose(), this.app.screen.width, this.app.screen.height);
  }

  /** worldToScreen into `out` (per-frame overlays: nothing allocated) */
  worldToScreenInto(worldX: number, worldY: number, out: { x: number; y: number }): void {
    const c = Math.cos(this.cameraAngle), s = Math.sin(this.cameraAngle), dx = worldX - this.cameraX, dy = worldY - this.cameraY;
    out.x = this.app.screen.width / 2 + (c * dx + s * dy) * this.cameraZoom;
    out.y = this.app.screen.height / 2 + (-s * dx + c * dy) * this.cameraZoom;
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

  /** Each drawn strike and told hit, by shell (dev Sim tools' hit agreement: WeaponFx.tally) */
  set shotTally(fn: WeaponFx['tally']) {
    this.weaponFx.tally = fn;
  }

  /** The model and damage of the gun a fire-event shell came from (WeaponFx.shellLook) */
  set shellLookOf(fn: WeaponFx['shellLook']) {
    this.weaponFx.shellLook = fn;
  }

  /** Shells heading at you that warn of it (WeaponFx.threats) */
  get incomingShells(): { list: WeaponFx['threats']; count: number } {
    this.incomingScratch.list = this.weaponFx.threats;
    this.incomingScratch.count = this.weaponFx.threatCount;
    return this.incomingScratch;
  }
  private incomingScratch: { list: WeaponFx['threats']; count: number } = { list: [], count: 0 };

  screenSize(): { w: number; h: number } {
    this.sizeScratch.w = this.app.screen.width;
    this.sizeScratch.h = this.app.screen.height;
    return this.sizeScratch;
  }
  private sizeScratch = { w: 0, h: 0 };

  /** Where your cursor is in the world while you hold fire (WeaponFx.guideTo) */
  set guideTo(fn: WeaponFx['guideTo']) {
    this.weaponFx.guideTo = fn;
  }

  /** A held beam's burn throws an impact off what it lights (WeaponFx.beamBurn) */
  beamBurn(...a: Parameters<WeaponFx['beamBurn']>): void {
    this.weaponFx.beamBurn(...a);
  }

  /** The surface a shell struck, for its impact's direction (WeaponFx.surfaceAt) */
  set surfaceAt(fn: WeaponFx['surfaceAt']) {
    this.weaponFx.surfaceAt = fn;
  }

  /** The first drawn surface a shell's line meets: every drawn shell stops there (WeaponFx.castHit) */
  set castHit(fn: WeaponFx['castHit']) {
    this.weaponFx.castHit = fn;
  }

  /** A shell stopped (or passed, piercing) at a drawn surface: its other hit effects there (WeaponFx.onStruck) */
  set onStruck(fn: WeaponFx['onStruck']) {
    this.weaponFx.onStruck = fn;
  }

  /** Shots and impacts heard as they're drawn (WeaponFx.sounds: audio/CombatSounds.ts) */
  set combatSounds(feed: WeaponFx['sounds']) {
    this.weaponFx.sounds = feed;
  }

  /** Is this shell drawn (now or lately)? Its hit effects then go where it's seen to strike (WeaponFx.draws) */
  drawsShell(id: number): boolean {
    return this.weaponFx.draws(id);
  }

  /** A shell your client fired ahead of the server (WeaponFx.predict) */
  predictShot(p: PredictedShell): number {
    return this.weaponFx.predict(p);
  }

  /** A shell drawn ahead taken back (WeaponFx.retract) */
  retractShot(id: number): void {
    this.weaponFx.retract(id);
  }

  /** Called when a shot is seen leaving its gun (owner, muzzle point) */
  /** Where a shot comes out of its drawn barrel (WeaponFx.barrelTip) */
  set barrelTip(fn: WeaponFx['barrelTip']) {
    this.weaponFx.barrelTip = fn;
  }

  set onMuzzle(fn: ((owner: number, x: number, y: number, power: number) => void) | null) {
    this.weaponFx.onMuzzle = fn;
  }

  /** A gun's spin where a shot left it (WeaponFx.spinAt) */
  set spinAtOf(fn: WeaponFx['spinAt']) {
    this.weaponFx.spinAt = fn;
  }

  /** Smoke or sparks off a gun that is reloading (WeaponFx.vent) */
  ventPuff(x: number, y: number, angle: number, kind: 'smoke' | 'spark', color: number): void {
    this.weaponFx.vent(x, y, angle, kind, color);
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

  /** The camera's world point and the screen size (dev overlays place world points with these) */
  getCameraView(): { x: number; y: number; width: number; height: number } {
    return { x: this.cameraX, y: this.cameraY, width: this.app.screen.width, height: this.app.screen.height };
  }

  /** The overlays are stepped every hudEvery frames, with the time since */
  private hudEvery = 1;
  private overlayFrames = 0;
  private overlayDelta = 0;

  /** Apply a graphics quality tier (settings/quality.ts) */
  setQuality(q: QualityProfile): void {
    setPlanetDetail(q.planetDetail);
    this.bloom.setQuality(q.bloomScale, q.bloomQuality);
    this.sky.setDetail(q.hazeScale, q.starLayers);
    this.sun.setScale(q.sunScale);
    this.fx.particleKeep = q.particles;
    this.weaponFx.particleKeep = q.particles;
    this.minimap.setHz(q.minimapHz);
    this.hudEvery = q.hudEvery;
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
    const bastion = s.bastion ? new BastionView(s.bastion, this.lighting, { radius: s.radius, boom: (x, y, r) => this.fx.createExplosionAt(x, y, r) }) : null;
    if (view) this.backgroundContainer.addChild(view.container);
    if (bastion) { this.backgroundContainer.addChild(bastion.container); this.effectContainer.addChild(bastion.top); }
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
    this.fx.collectLights(L);
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
    this.death.rebuild();
    this.minimap.onResize();

    // Starfield quad rescales itself in update(), nothing to do here
  }
  
}
