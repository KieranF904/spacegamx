/**
 * @contract client.render.renderer
 * owns:       the PixiJS scene: layers, camera, entity views, background and lighting, per frame
 * needs:      npm: pixi.js; GameState, renderer/{particleFx,damageNumbers,deathScreen,minimap,panControl,entityParts,systemVisuals}, WeaponFx, SunRenderer, SkyRenderer, SurfaceRenderer, Lighting; npm: @space-game/common
 * invariants: one update(delta) per frame steps camera, backdrop, entities, effects, hit numbers and minimap in that order — client/src/rendering/renderer/rendererModules.test.ts
 *             effects, hit numbers, minimap and death screen are modules under renderer/, not code here — client/src/rendering/renderer/rendererModules.test.ts
 * extend:     a new effect or overlay is a module under renderer/ created in the constructor and stepped in update()
 */

import { Bloom } from './Bloom';
import { PanControl } from './renderer/panControl';
import { type Tag, type Gate } from './renderer/entityParts';
import { visualsFromInfo, type SystemVisuals, type Day } from './renderer/systemVisuals';
import { ParticleFx } from './renderer/particleFx';
import { DamageNumbers } from './renderer/damageNumbers';
import { DeathScreen } from './renderer/deathScreen';
import { Minimap } from './renderer/minimap';
import type { QualityProfile } from '../settings/quality';
import { SpritePool } from './spritePool';
import { vignette } from './fxTextures';
import { stepOverlays, screenTint } from './overlayFrame';
import { screenToWorld, viewHalfExtents, worldToScreen } from './cameraView';
import { PlanetRenderer } from './PlanetRenderer';
import { setPlanetDetail } from './planetView/planetQuad';
import { installVolumeUpload } from './texture3d';
import { SceneryRenderer } from './Scenery';
import { NestRenderer } from './NestViews';
import systemsData from '../../../data/systems.json';
import { Application, Sprite, Container, Graphics } from 'pixi.js';
import { GameState } from '../state/GameState';
import { WeaponFx, type PredictedShell } from './weapons/WeaponFx';
import { MiningStrikeFx } from './weapons/MiningStrikeFx';
import { LootPodView } from './LootPodView';
import { TerrainView } from './TerrainView';
import { ChamberView } from './gunRange/ChamberView';
import { MobView } from './MobView';
import { AsteroidSeams } from './AsteroidLook';
import type { AsteroidRock } from './AsteroidLook';
import { drawTrainingLook, TRAINING_LABEL } from './TrainingLook';
import type { TrainingLook } from '../ui/tutorial/tutorialModel';
import { RiftShader } from './RiftShader';
import { StationShot, StationView } from './StationView';
import { CentralBodyShaders } from './CentralBodyShaders';
import { SunRenderer } from './sun/SunRenderer';
import type { StarBody } from './sun/plasmaSun';
import { EntityType, EffectType, pocketsFrom, entranceNest } from '@space-game/common';
import { SkyRenderer } from './sky/SkyRenderer';
import { SurfaceRenderer } from './surface/SurfaceRenderer';
import { CityView } from './surface/CityView';
import { BastionView } from './surface/siege/BastionView';
import { Lighting } from './lighting/Lighting';
import { AsteroidBatch } from './lighting/AsteroidBatch';
import { SkyBiome } from './sky/skyBiome';
import type { NestData, ServerSystemInfoMessage, StarSystemData } from '@space-game/common';
import { renderEntities } from './renderer/entityViews';
import { renderBackground } from './renderer/background';
import { updateCamera } from './renderer/cameraStep';
import { updateEffects, collectLights } from './renderer/frameEffects';

export class Renderer {
  app: Application;
  state: GameState;
  
  // Containers (render order)
  worldContainer: Container;
  backgroundContainer: Container;
  entityContainer: Container;
  /** A surface's rock (TerrainView), and the system it's for */
  terrainLayer = new Container();
  terrainView: TerrainView | null = null;
  /** A gun range's chamber (rendering/gunRange): indoors, so no sky */
  chamber: ChamberView | null = null;
  terrainId: string | null = null;
  effectContainer: Container;
  private uiContainer: Container;
  
  /** Projectile tracers, muzzle flashes and impacts */
  weaponFx: WeaponFx;
  /** Mining strikes on rock (a hit that rolls for ore), and a chunk's richer puff where it appears (weapons/MiningStrikeFx.ts) */
  miningStrikes = new MiningStrikeFx({ spark: (...a) => this.fx.spark(...a), flash: (...a) => this.fx.flash(...a) }, () => performance.now() / 1000);
  /** Black hole / pulsar central bodies */
  centralShaders = new CentralBodyShaders();
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
  rifts = new Map<number, RiftShader>();
  lootPods = new Map<number, LootPodView>();
  /** Single-body enemies (data/mobs.json) */
  mobs = new Map<number, MobView>();
  asteroidSeams = new Map<number, AsteroidSeams>();
  /** Training-yard bodies drawn another way (a drone, a ghost) instead of in the rock batch, and each rock's own object to put it back */
  trainingLooks = new Map<number, TrainingLook>();
  rockObjs = new Map<number, AsteroidRock>();
  /** Asteroids just struck (when, how hard): a white flash and a little jolt */
  rockHits = new Map<number, { at: number; strength: number }>();
  seamTime = 0;
  /** Station visuals, by entity id */
  stations = new Map<number, StationView>();
  /** Modular ships and debris (drawn by ShipRenderer) */
  private shipLayer = new Container();

  /** Entities whose body is drawn elsewhere (modular ships): only their name tag and health bar show. */
  public hiddenEntityIds: Set<number> = new Set();
  /** Hull radius of those ships (ShipRenderer fills it), so tags sit just outside the hull */
  public shipRadius = new Map<number, number>();
  
  // Camera
  cameraX = 0;
  cameraY = 0;
  cameraZoom = 1;
  /** The view's roll (cameraView.ts): eases onto this heading in helm, back to north-up (null) otherwise */
  cameraAngle = 0;
  /** Seconds the view has been following a heading (helm): it follows loosely at first, then closely */
  helmTime = 0;
  cameraHeading: number | null = null;
  /** The middle-mouse drag of the view and its button (renderer/panControl.ts); the view always keeps the ship PAN_MARGIN inside the screen */
  panCtl: PanControl;
  /** Camera catch-up per frame (0..1) */
  public cameraFollow = 0.1;
  /** Display settings */
  public shakeScale = 1;
  get showDamageNumbers(): boolean { return this.damageNumbers.visible; }
  set showDamageNumbers(v: boolean) { this.damageNumbers.visible = v; }
  public showNames = true;
  /** Where your cursor is in the world (null: no ship of yours to aim from); a bunch of ships names the one under it (ships/render/labelCrowd.ts) */
  public pointerWorld: (() => { x: number; y: number } | null) | null = null;
  
  /** The star (plasma, drawn at a share of the screen's resolution: sun/SunRenderer.ts) */
  readonly sun: SunRenderer;
  /** A system's star, for one not in systems.json (made from its visuals once) */
  starBodies = new WeakMap<SystemVisuals, StarBody>();
  
  // GPU procedural starfield (sandbox-style)
  sky: SkyRenderer;
  /** A planet's ground and clouds, in place of the sky while you're on one */
  surface: SurfaceRenderer;
  city: { system: string; view: CityView | null; bastion: BastionView | null } | null = null;
  day: Day = { ambient: [1, 1, 1], power: 0, sun: [1, 1, 1] };
  /** The edge of a surface's map */
  surfaceEdge = new Graphics();
  /** On a surface, ships cast soft shadows on the ground (that's what puts them up in the air) */
  shadows = new SpritePool('normal');
  /** Ships, stations and asteroids lit by the sun, the system's ambient light and every light nearby */
  readonly lighting: Lighting;
  /** Asteroid rocks, lit, in batches */
  rocks: AsteroidBatch;
  lightKey = '';
  podLight: [number, number, number] = [1, 1, 1];
  /** Each system's sky, made the first time it's seen */
  biomes = new Map<string, SkyBiome>();
  
  // Current system info
  currentSystemId: string = 'sol';
  /** Data-driven visuals per system, from server systemInfo messages */
  systemVisuals: Map<string, SystemVisuals> = new Map();
  
  // Entity graphics cache
  entityGraphics: Map<number, Container> = new Map();
  /** Name tags and health bars, by entity id */
  tags = new Map<number, Tag>();
  /** Jump gates, by entity id */
  gates = new Map<number, Gate>();
  /** Entities just made, fading in (id → 0..1) */
  fadingIn = new Map<number, number>();
  /** Entities gone, fading out where they were (then destroyed) */
  fadingOut: { id: number; container: Container }[] = [];
  /** This system's data (looked up once per system, not per frame) */
  sys: { id: string; data: (StarSystemData & { visuals?: Record<string, any> }) | undefined } = { id: '', data: undefined };

  // Effects
  fx!: ParticleFx;
  private damageNumbers!: DamageNumbers;
  death!: DeathScreen;
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
  readonly CULL_MARGIN = 200;
  
  // Animation timing
  time: number = 0;

  constructor(app: Application, state: GameState) {
    this.app = app;
    this.state = state;
    // (the planets' noise is a 3D texture: planetView/planetTextures.ts)
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
    this.lighting.addSource((L) => collectLights(this, L));
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
      hiddenBody: (id) => this.trainingLooks.get(id) === 'hidden',
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
    updateCamera(this, delta);
    
    // Render background
    renderBackground(this, delta);
    this.updatePlanets(delta);
    
    // Render entities
    renderEntities(this, delta);
    this.rocks.update(this.entityGraphics, this.cameraZoom);

    // Render debug asteroid markers
    this.renderDebugAsteroidMarkers();
    
    // Update effects
    updateEffects(this, delta);
    
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
  viewBox(): { hw: number; hh: number } {
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
  aliveIds = new Set<number>();

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
  cameraTarget: (() => { x: number; y: number } | null) | null = null;

  setCameraTarget(target: (() => { x: number; y: number } | null) | null): void {
    this.cameraTarget = target;
  }

  /** Next frame the view goes straight onto your ship (pan, roll and all), no easing: behind the loading screen, so it
   *  is already there when the screen lifts (app/loadingFlow.ts) */
  snapCamera(): void {
    this.cameraSnap = true;
  }
  cameraSnap = false;

  /** Rock chunks still to be built (and the relief atlas still coming): the loading screen waits for none */
  buildPending(): number {
    return this.rocks.pending;
  }

  /** The view back onto your ship */
  recenter(): void {
    this.panCtl.recenter();
  }

  /** Each entity's type, for when it's gone */
  typeOf = new Map<number, EntityType>();

  // Public methods for effects

  entityAt = (id: number) => {
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

  /** Draw a training-yard body as a drone or a ghost (null: as a normal rock); applies now if the body is on screen, else when it is made */
  setTrainingLook(id: number, look: TrainingLook | null): void {
    if (this.trainingLooks.get(id) === look || (look === null && !this.trainingLooks.has(id))) return;
    if (look) this.trainingLooks.set(id, look); else this.trainingLooks.delete(id);
    const container = this.entityGraphics.get(id);
    const rock = this.rockObjs.get(id);
    if (!container || !rock) return;
    container.getChildByLabel(TRAINING_LABEL)?.destroy();
    const at = this.state.entities.get(id);
    if (look) {
      this.rocks.remove(id);
      container.addChild(drawTrainingLook(look, id, at?.data?.[0] || 30));
    } else {
      this.rocks.add(id, rock, at?.x ?? 0, at?.y ?? 0);
    }
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

  /** Where each of your flak guns' shells will burst (WeaponFx.aimMarks) */
  set aimMarks(fn: WeaponFx['aimMarks']) {
    this.weaponFx.aimMarks = fn;
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

  /** A gun's detonation that may be a weapon modifier's blast (WeaponFx.modBlast) */
  modBlast(kind: string, x: number, y: number, radius: number, out?: number): void {
    this.weaponFx.modBlast(kind, x, y, radius, out);
  }

  /** A chain modifier's arc between two hulls (WeaponFx.chainArc) */
  chainArc(x0: number, y0: number, x1: number, y1: number, k: number): void {
    this.weaponFx.chainArc(x0, y0, x1, y1, k);
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
