/**
 * Game - Main client orchestrator
 */

import { lobbyAuth, LobbyAuthResult } from './network/lobby';
import { setText, setStyle } from './ui/domWrite';
import { Application, Text} from 'pixi.js';
import { NetworkManager } from './network/NetworkManager';
import { InputManager } from './input/InputManager';
import { Renderer } from './rendering/Renderer';
import { noseUpAngle } from './rendering/cameraView';
import { attachShaderWarmup, warmShaders } from './rendering/shaderWarmup';
import { gameShaders } from './rendering/gameShaders';
import { GameState } from './state/GameState';
import { InventoryWindow } from './ui/InventoryWindow';
import type { ComponentGuideUI } from './ui/ComponentGuideUI';
import { Lazy, prefetchIdle } from './lazy';
import type { StationWindow } from './ui/StationWindow';
import { PilotHud, ToastUI } from './ui/PilotHud';
import { CargoPanelUI } from './ui/CargoPanelUI';
import { RegionUI } from './ui/RegionUI';
import { BuildSites } from './rendering/BuildSites';
import { PilotState, createClientEconomy } from './econ/clientEcon';
import { LoginUI } from './ui/LoginUI';
import { ServerBrowserUI, ServerInfo } from './ui/ServerBrowserUI';
import { AudioManager } from './audio/AudioManager';
import { KillFeedUI } from './ui/KillFeedUI';
import { PlayerStatsUI } from './ui/PlayerStatsUI';
import { NavMarkersUI } from './ui/NavMarkersUI';
import { FarZoomMarkers } from './ui/FarZoomMarkers';
import { SocialUI } from './ui/SocialUI';
import { InfoPanel } from './ui/InfoPanel';
import { TradeWindow } from './ui/TradeWindow';
import { TargetUI } from './ui/TargetUI';
import { OpsUI } from './ui/OpsUI';
import { Tutorial } from './ui/Tutorial';
import { PingUI } from './ui/PingUI';
import { PerfMonitor } from './ui/PerfMonitor';
import { RibbonPopup } from './ui/RibbonPopup';
import ribbonData from '../../data/achievements.json';
import type { RibbonsFile } from '@space-game/common';
import { QuestClient } from './ui/QuestUI';
import questsData from '../../data/quests.json';
import { DialogueUI } from './ui/DialogueUI';
import { PeopleUI, TALK_RANGE } from './ui/PeopleUI';
import { ContextActions } from './input/ContextActions';
import { GuideUI } from './ui/GuideUI';
import { BossUI } from './ui/BossUI';
import { QuickBar } from './ui/QuickBar';
import { GameMenuUI, fieldGuide } from './ui/GameMenuUI';
import { settings, SettingsData } from './settings/Settings';
import { AutoQuality, PROFILES, type QualityTier } from './settings/quality';
import { ACTIONS, boundKeyName } from './input/keybindings';
import systemsDataForMenu from '../../data/systems.json';
import { SystemMapUI } from './ui/SystemMapUI';
import { DamageIndicatorUI } from './ui/DamageIndicatorUI';
import { FloatingRewardsUI } from './ui/FloatingRewardsUI';
import { ShipClient } from './ships/ShipClient';
import type { AdminPanel } from './ui/AdminPanel';
import type { ContributorPanel } from './ui/ContributorPanel';
import { RenderTuningPanel } from './ui/RenderTuningPanel';
import { DevShipPanel } from './ui/DevShipPanel';
import { CircuitBars } from './ui/CircuitBars';
import { ObjectiveBanner } from './ui/ObjectiveBanner';
import { SiegePanel } from './ui/SiegePanel';
import { moonOffset, planetPosition, pocketAt, inSafeSpace, jumpRange, jumpTuning, type StarSystemData } from '@space-game/common';
import { Autopilot, AutoDest } from './ships/Autopilot';
import { HazardOverlay } from './ui/HazardOverlay';
import { FrostVignette } from './ui/FrostVignette';
import shipPieces from '../../data/ships/pieces.json';
import shipFunctions from '../../data/ships/functions.json';
import shipMaterials from '../../data/ships/materials.json';
import shipModels from '../../data/ships/models.json';
import shipTuning from '../../data/ships/tuning.json';
import miningTable from '../../data/mining.json';
import {
  TICK_RATE,
  TICK_MS,
  xpToReach,
} from '@space-game/common';
import { itemIcon } from './ui/itemIcons';
import {
  ServerMessage,
  asteroidComposition,
  MiningTable, registerRockTypes, chooseCrate, crateOrder, cratesFor, ammoByCode, ammoCode,
  ClientInputMessage,
  EntityType,
  quantizeCursorAngle,
  dequantizeCursorAngle,
  CURSOR_RADIUS,
  computeStateHash,
  ClientTransport,
  loadCatalog,
  ShipTuning,
  InventoryStub,
  quantizeCursorDist,
  CURSOR_DIST_STEP,
  QuestTarget, QuestsFile,
  DisconnectInfo,
  PROTOCOL_VERSION,
  PROTOCOL_MISMATCH_CLOSE,
} from '@space-game/common';

/** Keys that take the controls back from the autopilot */
// This build's rock types and belts (both sides generate the same rocks from them); a dev build adds the
// dev-only rock system's field, as the dev server does (data/dev/rockery.json, server/src/data/devData.ts)
if (import.meta.env.DEV) {
  const found = import.meta.glob('../../data/dev/rockery.json', { eager: true, import: 'default' });
  const dev = Object.values(found)[0] as { system: { id: string }; field: Record<string, number>; outliers?: number } | undefined;
  const t = miningTable as unknown as MiningTable;
  if (dev) {
    t.fields = { ...t.fields, [dev.system.id]: dev.field };
    if (t.outliers && dev.outliers) t.outliers.systems = { ...t.outliers.systems, [dev.system.id]: dev.outliers };
  }
}
registerRockTypes(miningTable as unknown as MiningTable);

/** A cannon shot's pitch by its gun's grade, Mk I-V (heavy shells lower, high-velocity slugs higher) */
const CANNON_GRADE_PITCH = [1, 0.86, 1.14, 1.06, 0.8];

const FLIGHT_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'KeyJ', 'KeyY', 'KeyV', 'KeyX', 'KeyH', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight', 'Space']);

/** Proto mode (npm run proto): in-process server, no login, no prediction. */
export interface ProtoHooks {
  /** Called once after init with the pieces proto tools draw into and read from. */
  onInit?(ctx: { app: Application; renderer: Renderer; state: GameState; input: InputManager }): void;
  /** Runs after entity interpolation each frame. Proto mode writes simulation state straight into GameState here. */
  afterInterpolate(state: GameState): void;
  /** Return true to consume the key. */
  onKeyPressed?(code: string): boolean;
  /** Return false to stop movement/fire input reaching the simulation. */
  inputEnabled?(): boolean;
}

export interface GameOptions {
  transport?: ClientTransport;
  proto?: ProtoHooks;
  /** Modular ship options (proto: hangar anywhere, pause while editing) */
  ships?: { editAnywhere?: boolean; onHangarOpen?(): void; onHangarClose?(): void };
}

export class Game {
  private container: HTMLElement;
  private app!: Application;
  private network: ClientTransport;
  private proto: ProtoHooks | null;
  private shipClient: ShipClient;
  private hazards = new HazardOverlay();
  /** The cold on screen: frost in from the edges as the ship's warmth runs down */
  private frost = new FrostVignette();
  /** System id → display name (from systemInfo) */
  private systemNames = new Map<string, string>();
  private input: InputManager;
  private renderer!: Renderer;
  private state: GameState;
  private audio: AudioManager;
  
  // UI components
  private loginUI!: LoginUI;
  private serverBrowserUI!: ServerBrowserUI;
  private inventoryWindow!: InventoryWindow;
  /** Split out of the main chunk (see prefetchScreens) */
  private componentGuide!: Lazy<ComponentGuideUI>;
  /** Split out of the main chunk (see prefetchScreens; calls made before it arrives run when it does, in order) */
  private stationWindow!: Lazy<StationWindow>;
  private get stationOpen(): boolean {
    return this.stationWindow?.value?.isOpen ?? false;
  }
  /** The pilot's progress, cargo and storage as the server reports them */
  readonly pilot: PilotState;
  private pilotHud!: PilotHud;
  private cargoPanel!: CargoPanelUI;
  /** The danger band you're in (a banner as you cross), and the card for a gate you're near */
  private regionUI = new RegionUI();
  private quests!: QuestClient;
  /** Conversations with people (and their calls) */
  private dialogue!: DialogueUI;
  /** People out in space and on planets */
  private peopleUI: PeopleUI | null = null;
  /** The objective guide's chevrons */
  private guide!: GuideUI;
  private bossUI!: BossUI;
  private quickBar!: QuickBar;
  private autopilot!: Autopilot;
  /** The right-click menu: dock, travel, land, talk, target, fly or jump there (ContextActions.ts) */
  private context!: ContextActions;
  /** Raids and wrecks in this system (marked on screen) */
  private worldEvents = new Map<number, { name: string; x: number; y: number; system: string }>();
  /** Kills (and assists) this session, for the tutorial */
  private sessionKills = 0;
  /** Your last ship's wreck, kept for you a while (wall ms): marked until you recover it */
  private wreck: { system: string; x: number; y: number; until: number } | null = null;
  /** Objective banners (a city under siege) */
  private objectives = new ObjectiveBanner();
  /** A moon siege's day panel */
  private siegePanel = new SiegePanel((m) => this.network.send(m));
  private toasts!: ToastUI;
  private killFeedUI!: KillFeedUI;
  private playerStatsUI!: PlayerStatsUI;
  private systemMapUI!: SystemMapUI;
  private navMarkers: NavMarkersUI | null = null;
  private farMarkers!: FarZoomMarkers;
  private social!: SocialUI;
  private infoPanel!: InfoPanel;
  private tradeWindow!: TradeWindow;
  private targetUI!: TargetUI;
  private opsUI!: OpsUI;
  /** Structures you've built or are building (drawn for you alone) */
  private buildSites: BuildSites | null = null;
  private tutorial!: Tutorial;
  private pingUI!: PingUI;
  private ribbonPopup!: RibbonPopup;
  private lastTraffic = { t: 0, bytesIn: 0, bytesOut: 0, framesIn: 0 };
  private trafficText = '';
  private localDead = false;
  private menu!: GameMenuUI;
  /** The server we joined (for the menu's Server page) */
  private serverName = 'Local';
  private serverAddress = '';
  private windowFocused = true;
  /** Projectiles and ship bodies already heard (so each makes its sound once) */
  private heard = new Set<number>();
  private systemArrivedAt = 0;
  private lastAlarm = 0;
  private statsPrimed = false;
  private damageIndicatorUI!: DamageIndicatorUI;
  private floatingRewardsUI!: FloatingRewardsUI;
  
  private running = false;
  /** Graphics quality: Auto's pick (used while the setting is Auto) */
  private autoQuality = new AutoQuality();
  /** A full-screen window (hangar, menu) hides the world: it isn't updated or drawn until this is set again (a resize, a setting changed) or the window closes */
  private worldPaused = false;
  /** The shots in the world this frame (updateSounds; reused) */
  private shotsAlive = new Set<number>();
  /** The nav markers are placed every hudEvery frames (the quality tier) */
  private hudEvery = 1;
  private navFrames = 0;
  /** Time since the world was last updated under the map (see update) */
  private coveredDelta = 0;
  private refreshWorld = false;
  private lastFrameTime = 0;
  private frameCount = 0;
  private fpsUpdateTime = 0;
  private loggedIn = false;
  
  // UI elements - new HUD
  private loadingEl: HTMLElement | null;
  private topHudEl: HTMLElement | null;
private xpHudEl: HTMLElement | null;
private boostHudEl: HTMLElement | null;
  private inventoryPanelEl: HTMLElement | null;
private perfMonitor: PerfMonitor | null = null;
  private perfSrv: number | undefined;
  private perfNet = '';
  
  // Individual HUD components
private xpFillEl: HTMLElement | null;
  private xpBarEl: HTMLElement | null = null;
  /** The XP bar as last shown (to glow when it grows) */
  private xpSeen: { level: number; into: number } | null = null;
  private boostFillEl: HTMLElement | null;
  /** Each circuit's charge beside the ENERGY gauge (local circuits) */
  private circuitBars: CircuitBars | null = null;
  private levelEl: HTMLElement | null;
  private xpEl: HTMLElement | null;
  private xpToNextEl: HTMLElement | null;
  private creditsEl: HTMLElement | null;
  private systemInfoEl: HTMLElement | null;

  // Chat elements
  private chatMessagesEl: HTMLElement | null;
  private chatInputEl: HTMLInputElement | null;
  private chatSendBtn: HTMLElement | null;
  private chatFocused = false;
  
  // Weapon firing state (for sound triggering)
  private lastFireLeft = false;
  private lastFireRight = false;
  private lastStateHashTime = 0;

  // Tick-based input system
  private inputTickAccum = 0;         // ms accumulator for fixed-rate input ticks
  private lastSentForward = false;
  private lastSentBackward = false;
  private lastSentLeft = false;
  private lastSentRight = false;
  private lastSentBoost = false;
  private lastSentFireLeft = false;
  private lastSentFireRight = false;
  private lastSentAngle = 0;          // quantized angle (int)
  private lastSentStrafeLeft = false;
  private lastSentStrafeRight = false;
  private lastSentHelm = false;
  private lastSentJump = false;
  private lastSentBrace = false;
  /** Extra camera zoom factor while jumping */
  private jumpZoom = 1;
  private lastSentCursorDist = 0;

  // Auth state
  private authToken: string | null = null;
  private isAdmin = false;
  /** A guest's name, to join with once connected (signed-in pilots join with authToken) */
  private pendingAuth: { type: 'guest'; username: string } | null = null;
  /** This build speaks another protocol than the server: nothing more until the player reloads */
  private versionMismatch = false;

  // Ping graph

  constructor(container: HTMLElement, options: GameOptions = {}) {
    this.container = container;
    this.network = options.transport ?? new NetworkManager();
    this.proto = options.proto ?? null;
    this.input = new InputManager();
    this.state = new GameState();
    // Asteroid compositions, exactly as the server derives them
    const systemDanger = new Map((systemsDataForMenu as { systems: { id: string; danger?: number }[] }).systems.map((s) => [s.id, s.danger ?? 1]));
    this.state.composeAsteroid = (type, key, size, systemId, stage) => asteroidComposition(miningTable as unknown as MiningTable, type, key, size, systemDanger.get(systemId) ?? 1, stage);
    this.state.predictionEnabled = !this.proto;

    // Modular ships: the client carries the same piece catalog (and economy) as the server
    const shipTuningData = shipTuning as ShipTuning;
    // (Designs' own pieces: bosses' bespoke hulls)
    const bespoke = Object.values(import.meta.glob('../../data/ships/bespoke/*.json', { eager: true, import: 'default' }));
    const shipCatalog = loadCatalog({ pieces: shipPieces, functions: shipFunctions, materials: shipMaterials, models: shipModels, bespoke } as any, { overlapShrink: shipTuningData.overlapShrink });
    this.pilot = new PilotState(createClientEconomy(shipCatalog));
    this.shipClient = new ShipClient({
      catalog: shipCatalog,
      pilot: this.pilot,
      grantAllParts: !!options.proto,
      onDocked: () => this.stationWindow.use((w) => w.open()),
      stationOpen: () => this.stationOpen,
      onHangarBackToStation: () => this.stationWindow.use((w) => w.showAgain()),
      miningHeld: () => this.rightHeld() && !this.menu?.isOpen,
      tuning: shipTuningData,
      state: this.state,
      send: (msg) => this.network.send(msg),
      showMessage: (text, color) => this.showSystemMessage(text, color),
      toast: (text, kind) => this.toasts?.show(text, kind),
      localAim: () => this.localAim(),
      isKeyDown: (code) => this.input.isKeyDown(code),
      inputEnabled: () => !this.menu?.isOpen,
      sound: (id, at, volume, pitch) => (at ? this.audio.play(id, at.x, at.y, { volume, pitch }) : this.audio.playUI(id, volume, pitch)),
      editAnywhere: options.ships?.editAnywhere,
      onHangarOpen: options.ships?.onHangarOpen,
      onHangarClose: options.ships?.onHangarClose,
    });
    this.state.shipPhysics = (player, input, fuel, tick) => this.shipClient.predict(player, input, fuel, tick);
    this.state.shipGuns = (player, input, tick, charge) => this.shipClient.predictGuns(player, input, tick, charge);
    this.state.chargeTotal = (charge) => this.shipClient.chargeTotal(charge);
    // Every other ship moves by replication (proto writes its state straight in instead)
    if (!this.proto) {
      this.state.preSnapshot = (m) => this.shipClient.preSnapshot(m);
      this.state.onReplication = (m) => this.shipClient.onReplication(m);
      this.state.replicaPose = (e, t) => this.shipClient.placeReplica(e, t);
    }
    this.audio = new AudioManager();
    
    // Cache UI elements - new HUD structure
    this.loadingEl = document.getElementById('loading');
    this.topHudEl = document.getElementById('topHud');
this.xpHudEl = document.getElementById('xpHud');
this.boostHudEl = document.getElementById('boostHud');
    this.inventoryPanelEl = document.getElementById('inventoryPanel');
    
    // Individual components
this.xpFillEl = document.getElementById('xpFill');
    this.xpBarEl = document.getElementById('xpBar');
    this.boostFillEl = document.getElementById('boostFill');
    this.circuitBars = new CircuitBars();
    this.levelEl = document.getElementById('level');
    this.xpEl = document.getElementById('xp');
    this.xpToNextEl = document.getElementById('xpToNext');
    this.creditsEl = document.getElementById('credits');
    this.systemInfoEl = document.getElementById('systemInfo');

    // Chat elements
    this.chatMessagesEl = document.getElementById('chatMessages');
    this.chatInputEl = document.getElementById('chatInput') as HTMLInputElement;
    this.chatSendBtn = document.getElementById('chatSendBtn');

    // Performance monitor (Settings > Performance monitor): its own panel, fed every frame
    this.perfMonitor = new PerfMonitor(document.getElementById('ui-overlay') ?? document.body, () => ({
      ping: this.state.ping,
      jitter: this.state.jitter,
      pingHistory: this.state.pingGraphHistory,
      jitterHistory: this.state.jitterGraphHistory,
      pingEvery: 2,
      entities: this.state.entities.size,
      tier: `${this.qualityTier()}${settings.data.display.quality === 'auto' ? ' (auto)' : ''}`,
      serverMs: this.perfSrv,
      net: this.perfNet,
    }));
  }

  async init(): Promise<void> {
    // Initialize PixiJS
    this.app = new Application();
    await this.app.init({
      width: window.innerWidth,
      height: window.innerHeight,
      backgroundColor: 0x000011,
      // (Multisampling is fixed when the canvas is made: the quality setting is read here, and Auto starts at High)
      antialias: PROFILES[this.qualityTier()].msaa,
      resolution: this.renderResolution(),
      autoDensity: true,
      // Nothing here uses Pixi's pointer events (the aim is read from the DOM): no hit-testing on every mouse move
      eventFeatures: { move: false, globalMove: false, click: false, wheel: false },
    });
    // Behind a full-screen window the stage isn't drawn at all (the canvas keeps its last frame); only the stage's own render is held back
    {
      const r = this.app.renderer, base = r.render.bind(r) as (o: unknown) => void;
      (r as unknown as { render: (o: unknown) => void }).render = (o) => {
        const opts = o as { container?: unknown; target?: unknown } | undefined;
        if (opts?.container === this.app.stage && !opts.target) {
          // While the sign-in screen is up its backdrop is drawn instead of the world (one renderer: shaders compile once)
          const backdrop = this.loginUI?.backdrop();
          if (backdrop) { base({ ...opts, container: backdrop }); return; }
          if (this.worldPaused && !this.refreshWorld) return;
          this.refreshWorld = false;
        }
        base(o);
      };
    }
    
    this.container.appendChild(this.app.canvas as HTMLCanvasElement);
    
    // Initialize renderer
    this.renderer = new Renderer(this.app, this.state);
    this.shipClient.init(this.app, this.renderer);
    // Render tuning (F8): on a dev server only, never in the deployed build
    if (import.meta.env.DEV) {
      new RenderTuningPanel({ zoom: () => this.renderer.getZoom(), warp: (systemId, x, y) => this.network.send({ type: 'devTeleport', systemId, x, y }) });
      // Ship swap (F9): the plan library's ships and the dev test ships, flown at once
      const library = import.meta.glob(['../../data/ships/blueprints/*.json', '../../data/ships/blueprints/dev/*.json'], { eager: true, import: 'default' }) as Record<string, { name: string; parts: { fn: string }[] }>;
      new DevShipPanel(Object.fromEntries(Object.entries(library).map(([path, bp]) => [path.replace(/^.*\//, '').replace(/\.json$/, ''), bp])), (ship) => this.network.send({ type: 'devShip', ship }),
        (wear, reset) => this.network.send({ type: 'devBoss', wear, reset }));
    }
    
    // Initialize UI components
    const uiOverlay = document.getElementById('ui-overlay')!;
    this.loginUI = new LoginUI(uiOverlay, this.app);
    // (its own render resolution while it's up: renderResolution)
    this.loginUI.onVisibility = () => { if (Math.abs(this.app.renderer.resolution - this.renderResolution()) > 1e-3) this.onResize(); };
    this.loginUI.onVisibility();
    // Load time: the shaders compiled ahead, off the main thread, while the sign-in screen is up (see shaderWarmup)
    attachShaderWarmup(this.app.renderer);
    warmShaders(gameShaders(this.app.renderer, this.loginUI.backdrop(), this.app.stage, (systemsDataForMenu as unknown as { systems: StarSystemData[] }).systems));
    this.serverBrowserUI = new ServerBrowserUI(uiOverlay);
    this.inventoryWindow = new InventoryWindow(this.pilot, (m) => this.network.send(m), (id) => this.audio.playUI(id, id === 'ui_click' ? 0.4 : 0.6));
    this.componentGuide = new Lazy(() => import('./ui/ComponentGuideUI').then(({ ComponentGuideUI }) =>
      new ComponentGuideUI({ catalog: this.pilot.econ.ships, tuning: shipTuning as ShipTuning, pilot: this.pilot, sound: (id, v) => this.audio.playUI(id, v ?? 0.6) })));
    this.pilotHud = new PilotHud(this.pilot);
    this.cargoPanel = new CargoPanelUI(this.pilot, (m) => this.network.send(m), (id) => this.audio.playUI(id, 0.4));
    this.cargoPanel.ceiling = () => this.pilotHud.bottom();
    // (The load is weighed against the ship you fly: common/src/ships/load.ts)
    this.cargoPanel.ship = () => this.shipClient.myShip()?.derived ?? null;
    this.shipClient.ownAmmo = (kind) => {
      const prof = this.pilot.profile;
      const pick = chooseCrate(crateOrder(cratesFor(shipTuning as ShipTuning, kind), prof?.loadout), prof?.ammoPrefer?.[kind], prof?.ammo ?? {}, (id) => this.pilot.cargo.some((s) => s.id === id && s.n > 0));
      return pick ? ammoByCode(ammoCode(pick.item))?.mods : undefined;
    };
    this.pilotHud.ammoKinds = () => {
      const ship = this.shipClient?.myShip();
      if (!ship) return [];
      const out = new Set<string>();
      for (const w of ship.derived.weapons) { const a = (shipTuning as ShipTuning).weapons?.[w.kind]?.ammo; if (a) out.add(a.item); }
      // Special crates aboard for these guns too
      const kinds = new Set(ship.derived.weapons.map((w) => w.kind));
      for (const st of this.pilot.cargo) if (kinds.has(this.pilot.econ.items.get(st.id)?.ammoFor?.weapon ?? '')) out.add(st.id);
      return [...out];
    };
    this.quests = new QuestClient({ pilot: this.pilot, send: (m) => this.network.send(m), sound: (id, v) => this.audio.playUI(id, v ?? 0.6) });
    this.stationWindow = new Lazy(() => import('./ui/StationWindow').then(({ StationWindow }) => new StationWindow({
      quests: this.quests,
      pilot: this.pilot,
      send: (m) => this.network.send(m),
      sound: (id, v) => this.audio.playUI(id, v ?? 0.6),
      openHangar: (slot) => { this.stationWindow.value?.hideForHangar(); this.shipClient.openHangar(slot); },
      openInventory: () => this.inventoryWindow.open(),
      onClose: () => { if (!this.shipClient.hangarOpen) this.shipClient.undock(); },
    })));
    this.toasts = new ToastUI();
    this.dialogue = new DialogueUI({
      pilot: this.pilot, send: (m) => this.network.send(m), sound: (id, v) => this.audio.playUI(id, v ?? 0.6),
      track: (id) => this.quests.track(id), toast: (t, k) => this.toasts.show(t, k),
    });
    this.guide = new GuideUI();
    this.bossUI = new BossUI(this.state, (id, v) => this.audio.playUI(id, v ?? 0.7));
    this.quickBar = new QuickBar(this.pilot, (m) => this.network.send(m), (id, v) => this.audio.playUI(id, v ?? 0.5));
    this.autopilot = new Autopilot({
      state: this.state,
      tuning: shipTuning as ShipTuning,
      accel: () => this.shipClient.localAccel(),
      boostFactor: () => this.shipClient.localBoostFactor(),
      energy: () => this.state.boostFuel,
      jumpPhase: () => this.shipClient.localJump().phase,
      jumpReach: () => this.shipClient.jumpReach(),
      objective: () => this.objective(),
      memberSystem: (id) => this.social?.party.members.find((m) => m.eid === id)?.system,
      interact: () => this.network.send({ type: 'interact' }),
      arrived: (_d, station) => {
        this.context?.arrived();
        this.audio.playUI('ui_open', 0.5);
        if (station) {
          this.showSystemMessage(`Autopilot: arrived at ${station}`, '#86efac');
          if (!this.stationOpen) this.shipClient.onKey('KeyH');
        }
      },
      message: (text, color) => this.showSystemMessage(text, color),
      lead: () => this.state.inputDelayTicks,
      drive: () => {
        const ship = this.shipClient.myShip(), me = this.state.entities.get(this.state.playerId);
        if (!ship || !me) return null;
        const jt = jumpTuning(shipTuning as ShipTuning), cooldown = ship.derived.jumpCooldown || jt.cooldownTicks;
        const j = this.shipClient.localJump();
        const cool = j.phase === 'ready' ? 0 : j.phase === 'cooldown' ? (1 - j.progress) * cooldown : cooldown;
        return { range: jumpRange(ship.derived, jt), cooldown, cool, primed: me.jumpPrime ?? 0 };
      },
    });
    this.quests.onAutopilot = () => this.toggleAutopilotToObjective();
    this.context = new ContextActions({
      state: this.state,
      systems: (systemsDataForMenu as unknown as { systems: StarSystemData[] }).systems,
      system: () => this.currentSystem(),
      cursor: () => ({ x: this.input.mouseX, y: this.input.mouseY }),
      screenToWorld: (x, y) => this.renderer.screenToWorld(x, y),
      worldToScreen: (x, y) => this.renderer.worldToScreen(x, y),
      zoom: () => this.renderer.getZoom(),
      shipRadius: (id) => this.shipClient.store.get(id)?.derived.radius ?? 60,
      people: () => this.peopleUI?.here() ?? [],
      talkRange: TALK_RANGE,
      enabled: () => this.loggedIn && !this.localDead && !this.shipClient.hangarOpen && !this.menu.isOpen && !this.systemMapUI.isOpen
        && !this.stationOpen && !this.inventoryWindow.isOpen && !this.tradeWindow.isOpen && !this.social.window.isOpen && !this.quests.log.isOpen && !this.componentGuide.value?.isOpen
        && !this.adminPanel?.capturesFlight,
      menuModifier: () => this.input.isKeyDown('KeyZ'),
      autopilot: this.autopilot,
      flyTo: (d, note) => this.flyTo(d, note),
      dock: () => { this.shipClient.onKey('KeyH'); },
      stationInRange: () => this.shipClient.stationInRange()?.name ?? null,
      // (As the X key: the gate card asks first for a system that outclasses you)
      interact: () => { if (this.regionUI.allowInteract()) this.network.send({ type: 'interact' }); },
      planetBelow: () => this.planetBelow(),
      locked: (id) => this.systemMapUI.locked?.(id) ?? null,
      jumpPhase: () => this.shipClient.localJump().phase,
      jumpReach: () => this.shipClient.jumpReach(),
      jumpMinRange: jumpTuning(shipTuning as ShipTuning).minRange,
      jumpCool: () => {
        const ship = this.shipClient.myShip(), j = this.shipClient.localJump();
        if (j.phase !== 'cooldown') return 0;
        return ((1 - j.progress) * (ship?.derived.jumpCooldown || jumpTuning(shipTuning as ShipTuning).cooldownTicks)) / 60;
      },
      jumpDanger: () => this.shipClient.jumpDanger(),
      targetId: () => this.targetUI.target,
      setTarget: (id) => this.targetUI.set(id),
      inspect: (id) => this.infoPanel.inspect(id),
      partyMate: (id) => this.social.isMember(id),
      invite: (id) => this.social.invite(id),
      trade: (id) => this.network.send({ type: 'tradeRequest', id }),
      ping: (x, y, kind, target) => this.network.send({ type: 'mapPing', x, y, kind, target }),
      wreck: () => { const w = this.wreck; return w && w.system === this.state.systemId && w.until > Date.now() ? { x: w.x, y: w.y } : null; },
      message: (t, c) => this.showSystemMessage(t, c),
      sound: (id) => this.audio.playUI(id, 0.5),
    });
    this.social = new SocialUI({
      state: this.state,
      send: (m) => this.network.send(m),
      sound: (id, v) => this.audio.playUI(id, v ?? 0.6),
      flyTo: (d) => this.flyTo(d),
      message: (t, c) => this.showSystemMessage(t, c),
    });
    // (With the system map open, the cursor is the map's)
    const cursorWorld = () => this.systemMapUI?.aimWorld() ?? this.renderer.screenToWorld(this.input.mouseX, this.input.mouseY);
    const shipRadius = (id: number) => this.shipClient.store.get(id)?.derived.radius ?? 60;
    this.infoPanel = new InfoPanel({
      state: this.state, send: (m) => this.network.send(m), cursorWorld,
      worldToScreen: (x, y) => this.renderer.worldToScreen(x, y), zoom: () => this.renderer.getZoom(),
      radius: shipRadius, inParty: (id) => this.social.isMember(id), itemName: (id) => this.pilot.econ.items.name(id),
      myRating: () => this.shipClient.myRating(), target: () => this.targetUI.target, belowHeight: () => this.targetUI.panelHeight,
    });
    this.tradeWindow = new TradeWindow(this.pilot, (m) => this.network.send(m), (id) => this.audio.playUI(id, 0.5));
    this.targetUI = new TargetUI(this.state, (m) => this.network.send(m), (x, y) => this.renderer.worldToScreen(x, y), () => this.renderer.getZoom(),
      shipRadius, cursorWorld, (id) => this.audio.playUI(id, 0.4), () => this.shipClient.myRating());
    this.buildSites = new BuildSites(this.renderer.getEffectLayer(), this.state);
    this.opsUI = new OpsUI(this.state, (x, y) => this.renderer.worldToScreen(x, y), () => this.renderer.getZoom(), {
      abandon: (id) => this.quests.abandon(id),
      leader: () => (this.social?.inParty() ? this.social.party.members.some((m) => m.leader && m.eid === this.state.playerId) : null),
    });
    this.ribbonPopup = new RibbonPopup((id) => this.audio.playUI(id, 0.6));
    this.pingUI = new PingUI(this.state, (m) => this.network.send(m), (x, y) => this.renderer.worldToScreen(x, y), cursorWorld,
      () => this.renderer.getZoom(), (id) => this.audio.playUI(id, 0.5));
    this.tutorial = new Tutorial({
      state: this.state,
      isKeyDown: (c) => this.input.isKeyDown(c),
      worldToScreen: (x, y) => this.renderer.worldToScreen(x, y),
      oreInHold: () => this.pilot.cargo.filter((s) => ['mineral', 'gem', 'volatile'].includes(this.pilot.econ.items.get(s.id)?.category ?? '')).reduce((t, s) => t + s.n, 0),
      inventoryOpen: () => this.inventoryWindow.isOpen,
      stationOpen: () => this.stationOpen,
      stationTab: () => (this.stationOpen ? this.stationWindow.value!.currentTab : ''),
      inDockRing: () => this.shipClient.isDocked(),
      autopilotOn: () => this.autopilot.active,
      sound: (id, v) => this.audio.playUI(id, v ?? 0.5),
      trainingDrone: () => this.network.send({ type: 'trainingDrone' }),
      kills: () => this.sessionKills,
      jumpPhase: () => this.shipClient.localJump().phase,
    });
    this.killFeedUI = new KillFeedUI(uiOverlay);
    this.playerStatsUI = new PlayerStatsUI(uiOverlay);
    this.systemMapUI = new SystemMapUI(uiOverlay, this.state);
    this.systemMapUI.onFlyTo = (dest) => this.flyTo(dest);
    this.systemMapUI.wreck = () => (this.wreck && this.wreck.until > Date.now() ? this.wreck : null);
    this.systemMapUI.jump = () => ({ aiming: this.shipClient.jumpAiming(), phase: this.shipClient.localJump().phase, reach: this.shipClient.jumpReach() });
    this.systemMapUI.autoTarget = () => this.autopilot.heading();
    this.systemMapUI.autoRoute = () => this.autopilot.routeView();
    this.systemMapUI.onVisibleChange = (open) => this.network.send({ type: 'mapView', open });
    // Zoom is one continuous range: flight, then the system map, then the galaxy
    this.systemMapUI.flightMinScale = this.input.minZoom;
    this.input.onZoomPastMin = () => {
      if (!this.loggedIn || this.systemMapUI.isOpen || this.shipClient.hangarOpen || this.menu.isOpen) return;
      this.systemMapUI.showFromFlight(this.input.zoom * this.jumpZoom);
      this.audio.playUI('ui_open', 0.4);
    };
    this.systemMapUI.onZoomIntoFlight = (scale) => {
      this.input.zoom = this.input.targetZoom = Math.max(this.input.minZoom, scale);
      this.audio.playUI('ui_close', 0.4);
    };
    // Proto's empty scene has nothing to navigate to
    if (!this.proto) this.peopleUI = new PeopleUI(this.state, (x, y) => this.renderer.worldToScreen(x, y), () => this.quests.people);
    if (!this.proto) this.navMarkers = new NavMarkersUI(this.state, (x, y) => this.renderer.worldToScreen(x, y), () => this.objective(),
      () => [...this.worldEvents.values()].filter((e) => e.system === this.state.systemId).concat(this.objectives.markers(this.state.systemId), this.wreckMarker()),
      () => this.social.others().filter((m) => m.alive && m.system === this.state.systemId).map((m) => {
        const e = this.state.entities.get(m.eid);
        return { name: m.name, x: e?.renderX ?? m.x, y: e?.renderY ?? m.y };
      }),
      () => {
        // (Not twice: the job's own marker already points at its site)
        const o = this.objective();
        // People out here who want you
        const people = (this.peopleUI?.here() ?? []).filter((p) => p.mark).map((p) => ({ name: `${p.mark === 'offer' ? '! ' : '▸ '}${p.name}`, x: p.x!, y: p.y! }));
        return [...this.opsUI.markers(), ...this.pingUI.markers(), ...people].filter((m) => !o || o.x === undefined || o.y === undefined || Math.hypot(m.x - o.x, m.y - o.y) > 300);
      });
    this.farMarkers = new FarZoomMarkers(this.state, (x, y) => this.renderer.worldToScreen(x, y), () => this.renderer.getZoom(), () => this.social.memberIds());
    this.systemMapUI.party = () => this.social.others();
    this.systemMapUI.myRating = () => this.shipClient.myRating();
    this.systemMapUI.myShip = () => this.shipClient.myShip()?.derived ?? null;
    this.systemMapUI.locked = (id) => {
      const r = (questsData as unknown as QuestsFile).restricted[id];
      if (!r || this.pilot.profile?.licences.includes(r.licence ?? id)) return null;
      return { name: r.name, hint: r.hint };
    };
    this.systemMapUI.pings = () => this.pingUI.markers();
    this.systemMapUI.onPing = (x, y) => this.pingUI.pingAt(x, y);
    this.createMenu();
    settings.subscribe((s) => this.applySettings(s));
    window.addEventListener('blur', () => { this.windowFocused = false; this.applyVolume(settings.data); });
    window.addEventListener('focus', () => { this.windowFocused = true; this.applyVolume(settings.data); });
    this.damageIndicatorUI = new DamageIndicatorUI(uiOverlay);
    this.floatingRewardsUI = new FloatingRewardsUI(uiOverlay);
    
    // Setup login callbacks - show server browser after login
    this.loginUI.onLogin = (username, password) => this.handleLogin(username, password);
    this.loginUI.onRegister = (username, password, email) => this.handleRegister(username, password, email);
    this.loginUI.onPlayAsGuest = () => this.handleGuestPlay();
    void this.resumeSession();
    
    // Setup server browser callbacks
    this.serverBrowserUI.onServerSelect = (server) => this.handleServerSelect(server);
    this.serverBrowserUI.onLogout = () => this.handleLogout();
    

    // Handle resize
    window.addEventListener('resize', () => this.onResize());
    
    // Set up network handlers
    this.network.onMessage = (msg) => this.handleServerMessage(msg);
    this.network.onConnect = () => this.onConnected();
    this.network.onDisconnect = (info) => this.onDisconnected(info);

    // Set up input handlers
    this.input.init(this.app.canvas as HTMLCanvasElement);
    this.input.onFocusLost = () => { this.context.resetPress(); this.sendNeutralInput(); };
    this.input.onMouseButton = (button, down, x, y) => this.context.mouse(button, down, x, y);
    this.context.attach(this.app.canvas as HTMLCanvasElement);
    this.input.onZoomChange = (zoom) => {
      this.renderer.setZoom(zoom);
    };
    this.input.onKeyPressed = (code) => this.handleKeyPress(code);
    
    // Setup chat
    this.setupChat();
    
    // Hide loading, show login
    if (this.loadingEl) this.loadingEl.style.display = 'none';

    if (this.proto) {
      this.proto.onInit?.({ app: this.app, renderer: this.renderer, state: this.state, input: this.input });
      // No login or server browser: join the in-process server as a guest.
      this.loginUI.hide();
      this.state.playerName = 'Proto';
      this.pendingAuth = { type: 'guest', username: 'Proto' };
      this.network.connect('local');
    }

    console.log('Game initialized');
  }

  /** Sign in at the lobby (accounts are kept there, one for every server); only then pick a server */
  private async handleLogin(username: string, password: string): Promise<void> {
    this.loginUI.setLoading(true);
    this.loginUI.showError('');
    this.signedIn(await lobbyAuth('login', { username, password }));
  }

  private async handleRegister(username: string, password: string, email: string): Promise<void> {
    this.loginUI.setLoading(true);
    this.loginUI.showError('');
    this.signedIn(await lobbyAuth('register', { username, password, email }));
  }

  /** The screens split out of the main chunk were asked for (prefetchScreens) */
  private screensFetched = false;

  /** Fetches the split-out screens in idle time once past the sign-in screen, so none waits when first opened */
  private prefetchScreens(): void {
    if (this.screensFetched) return;
    this.screensFetched = true;
    void prefetchIdle([() => this.stationWindow.load(), () => this.shipClient.hangar.load(), () => this.componentGuide.load(), () => fieldGuide.load()]);
  }

  /** The lobby's answer to a sign-in: on to the server list with a token, or the reason it was refused */
  private signedIn(r: LobbyAuthResult): void {
    if (!r.success || !r.token) {
      this.loginUI.setLoading(false);
      this.loginUI.showError(r.error || 'Sign-in failed');
      return;
    }
    this.authToken = r.token;
    try { localStorage.setItem('authToken', r.token); } catch { /* storage unavailable: this session only */ }
    this.state.playerName = r.username ?? '';
    this.pendingAuth = null;
    this.loginUI.setLoading(false);
    this.loginUI.hide();
    this.serverBrowserUI.show();
    this.prefetchScreens();
  }

  /** A saved session from last time: if the lobby still knows it, skip the sign-in screen */
  private async resumeSession(): Promise<void> {
    let token: string | null = null;
    try { token = localStorage.getItem('authToken'); } catch { /* storage unavailable */ }
    if (!token || this.proto) return;
    const r = await lobbyAuth('validate', { token });
    if (!r.success) {
      try { localStorage.removeItem('authToken'); } catch { /* storage unavailable */ }
      return;
    }
    // Only if still on the sign-in screen (the player hasn't moved on meanwhile)
    if (this.authToken || this.pendingAuth ||!this.loginUI.isVisible()) return;
    this.signedIn({ ...r, token });
  }

  private handleGuestPlay(): void {
    const guestName = 'Guest_' + Math.floor(Math.random() * 10000);
    this.state.playerName = guestName;
    this.pendingAuth = { type: 'guest', username: guestName };
    this.loginUI.hide();
    this.serverBrowserUI.show();
    this.prefetchScreens();
  }

  private handleServerSelect(server: ServerInfo): void {
    this.authFailed = false;
    this.serverBrowserUI.hide();
    this.serverName = server.name;
    this.serverAddress = `${server.host}:${server.port}`;
    this.clearLoadingClick();
    if (this.loadingEl) {
      this.loadingEl.textContent = `Connecting to ${server.name}...`;
      this.loadingEl.style.display = 'block';
    }
    
    // Build WebSocket URL
    const protocol = server.secure ? 'wss' : 'ws';
    const shouldOmitPort = server.secure && (server.port === 443 || server.port === 80);

    const wsUrl = shouldOmitPort
      ? `${protocol}://${server.host}`
      : `${protocol}://${server.host}:${server.port}`;
    
    console.log('Connecting to WebSocket:', wsUrl);
    this.network.connect(wsUrl);
  }

  private handleLogout(): void {
    this.stopAdmin();
    this.serverBrowserUI.hide();
    this.state.playerName = '';
    if (this.authToken) void lobbyAuth('logout', { token: this.authToken });
    this.authToken = null;
    try { localStorage.removeItem('authToken'); } catch { /* storage unavailable */ }
    this.loginUI.show();
  }

  start(): void {
    // Start game loop (but don't connect yet - wait for login)
    this.running = true;
    this.lastFrameTime = performance.now();
    this.app.ticker.add(() => this.update());
  }

  private createMenu(): void {
    this.menu= new GameMenuUI({
      proto: !!this.proto,
      openMap: () => this.systemMapUI.toggle(),
      pilot: () => {
        const sys = this.currentSystem();
        return {
          name: this.state.playerName || 'Pilot',
          level: this.state.level,
          xp: this.state.xp,
          xpToNext: xpToReach(this.state.level + 1),
          credits: this.state.credits,
          system: sys?.name ?? this.systemNames.get(this.state.systemId) ?? 'Deep space',
          sector: (sys?.sector ?? 'uncharted').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) + ' sector',
          admin: this.isAdmin,
        };
      },
      ship: () => this.shipClient.menuShipInfo(),
      server: () => {
        let pilots = 0;
        for (const e of this.state.entities.values()) if (e.type === EntityType.Player) pilots++;
        return {
          name: this.proto ? 'Prototype (in this tab)' : this.serverName,
          address: this.proto ? 'local' : this.serverAddress || location.host,
          ping: this.state.ping, jitter: this.state.jitter, tick: this.state.serverTick,
          pilotsHere: pilots, entities: this.state.entities.size,
        };
      },
      dockableStation: () => this.shipClient.dockableStationName(),
      dock: () => { this.shipClient.onKey('KeyH'); },
      captureKey: (cb) => { this.input.onCapture = cb; },
      sound: (id, volume) => { this.audio.playUI(id, volume); },
      leave: () => location.reload(),
      logout: () => {
        if (this.authToken) void lobbyAuth('logout', { token: this.authToken });
        try { localStorage.removeItem('authToken'); } catch { /* storage unavailable */ }
        location.reload();
      },
      onOpenChange: () => {},
      replayTutorial: () => this.tutorial.restart(),
      threats: () => this.state.threats,
      myRating: () => this.shipClient.myRating(),
      level: () => this.pilot.profile?.level ?? this.state.level,
      xp: () => this.pilot.profile?.xp ?? this.state.xp,
      icon: (id) => itemIcon(this.pilot.econ, id),
      openComponents: () => this.componentGuide.use((g) => g.open()),
    });
  }

  /**
   * Sounds driven by what's on screen: a shot for each new projectile (a few
   * per frame at most), parts breaking off as debris, the engine and boost
   * loops, the event-horizon alarm, and the music's mood.
   */
  private updateSounds(now: number): void {
    const me = this.state.entities.get(this.state.playerId);
    const settled = now - this.systemArrivedAt > 1500; // don't play everything already there on arrival
    let shots = 0;
    const alive = this.shotsAlive;
    alive.clear();
    for (const e of this.state.entities.ofType(EntityType.Projectile)) {
      alive.add(e.id);
      if (this.heard.has(e.id)) continue;
      this.heard.add(e.id);
      if (settled && shots < 4) {
        shots++;
        const own = e.data?.[6] === this.state.playerId;
        // data[0]: weapon type; data[8]: fired by a turret (cannons)
        const wt = e.data?.[0] ?? 1;
        const id = this.audio.shotSound(wt, e.data?.[8] === 1);
        // data[1]: the gun's grade: a cannon's heavier marks boom deeper, its fast slugs crack higher
        const pitch = wt === 1 ? CANNON_GRADE_PITCH[Math.max(0, Math.min(4, (e.data?.[1] ?? 1) - 1))] : 1;
        if (id) this.audio.play(id, e.spawnX ?? e.x, e.spawnY ?? e.y, { volume: own ? 0.6 : 0.8, pitch: pitch * (0.94 + Math.random() * 0.12) });
      }
    }
    for (const id of this.heard) if (!alive.has(id)) this.heard.delete(id);

    const flying = this.loggedIn && !!me && !this.shipClient.hangarOpen && !this.menu.isOpen;
    const thrusting = flying && ['KeyW', 'KeyS', 'KeyA', 'KeyD', 'KeyQ', 'KeyE', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].some((k) => this.input.isKeyDown(k));
    const boosting = thrusting && this.state.boostFuel > 0 && (this.input.isKeyDown('ShiftLeft') || this.input.isKeyDown('ShiftRight'));
    const speed = me ? Math.hypot(me.vx, me.vy) : 0;
    this.audio.setLoop('engine', flying ? (thrusting ? 1 : 0.25) : 0, 0.8 + Math.min(0.5, speed / 30));
    this.audio.setLoop('boost', boosting ? 1 : 0, 1 + Math.min(0.3, speed / 60));
    // (Mining lasers pulse, each pulse its own sound: ShipClient's beamFx.onMiningPulse)
    const beam = flying ? this.shipClient.weaponBeamKind() : null;
    this.audio.setBeam(beam);

    if (this.shipClient.horizonDanger() > 0.35 && now - this.lastAlarm > 900) {
      this.lastAlarm = now;
      this.audio.playUI('warning', 0.6);
    }
    this.audio.setMusicSystem(this.state.systemId || 'sol');
    // Nearing a boss's lair (a surface's or pocket's dread point), the music turns ominous
    const dread = this.currentSystem()?.surface?.dread ?? this.currentSystem()?.pocket?.dread;
    const d = dread && me ? Math.hypot(me.renderX - dread.x, me.renderY - dread.y) : Infinity;
    this.audio.setDread(dread ? Math.max(0, Math.min(1, (dread.from - d) / Math.max(1, dread.from - dread.full))) : 0);
    this.updateZone();
    this.objectives.update(this.state.systemId);
    const wayIn = flying ? this.pocketWayIn() : null;
    this.shipClient.setPlanetHint(wayIn ?? (flying ? this.planetBelow() : null), wayIn ? 'Enter' : undefined);
  }

  /** A pocket's way in (a boss's nest), close enough to go in (X enters) */
  private pocketWayIn(): string | null {
    const me = this.state.entities.get(this.state.playerId);
    if (!me) return null;
    return pocketAt((systemsDataForMenu as unknown as { systems: StarSystemData[] }).systems, this.state.systemId, me.renderX, me.renderY)?.pocket?.entrance.name ?? null;
  }

  private systemCache: { id: string; sys: StarSystemData | undefined } | null = null;

  /** The current system's data (looked up once per system, not every frame) */
  private currentSystem(): StarSystemData | undefined {
    const id = this.state.systemId;
    if (this.systemCache?.id !== id) {
      this.systemCache = { id, sys: (systemsDataForMenu as unknown as { systems: StarSystemData[] }).systems.find((s) => s.id === id) };
    }
    return this.systemCache.sys;
  }

  /** A planet you can land on, close enough below you (X descends) */
  private planetBelow(): string | null {
    const me = this.state.entities.get(this.state.playerId);
    const sys = this.currentSystem();
    if (!me || !sys) return null;
    // On a surface: a cave's mouth here
    if (sys.surface) {
      for (const s of (systemsDataForMenu as unknown as { systems: StarSystemData[] }).systems) {
        const u = s.surface?.under;
        if (u && u.surface === sys.id && Math.hypot(me.renderX - u.x, me.renderY - u.y) < u.radius) return u.name ?? s.name;
      }
      return null;
    }
    if (!sys.planets) return null;
    for (const p of sys.planets) {
      const tick = this.state.getRawServerTick();
      const at = planetPosition(p, tick);
      if (p.surface && Math.hypot(me.renderX - at.x, me.renderY - at.y) < p.radius + 900) return p.name;
      // Moons you can land on (a party's siege)
      for (let i = 0; i < (p.moons?.length ?? 0); i++) {
        const m = p.moons![i];
        if (!m.surface) continue;
        const o = moonOffset(p, i, tick);
        const threat = this.state.threats[m.surface];
        if (Math.hypot(me.renderX - at.x - o.x, me.renderY - at.y - o.y) < m.radius + 900) return `${m.name ?? 'the moon'} (siege${threat ? `, threat ${threat}` : ''})`;
      }
    }
    return null;
  }

  /** Sector danger and PvP status for the HUD (the same rules as the server's canDamage) */
  private updateZone(): void {
    const me = this.state.entities.get(this.state.playerId);
    const sys = this.currentSystem();
    if (!sys || !me) return;
    let safe = true;
    if (sys.pvp) {
      safe = false;
      for (const e of this.state.entities.values()) {
        if (e.type !== EntityType.Station) continue;
        const d = Math.hypot(e.renderX - me.renderX, e.renderY - me.renderY);
        const r = sys.pvp.mode === 'outer' ? sys.pvp.safeRadius ?? 3000 : Math.max((e.data?.[8] ?? 200) + 1500, 2200);
        if (d < r) { safe = true; break; }
      }
    }
    const r = Math.hypot(me.renderX, me.renderY);
    const ring = sys.zones?.find((z) => { const d = z.x !== undefined ? Math.hypot(me.renderX - z.x, me.renderY - (z.y ?? 0)) : r; return d >= z.inner && d <= z.outer; });
    const rating = this.shipClient.myRating();
    const ctx = {
      sys, x: me.renderX, y: me.renderY, rating, threats: this.state.threats, regionThreats: this.state.regionThreats,
      system: (id: string) => (systemsDataForMenu as unknown as { systems: StarSystemData[] }).systems.find((s) => s.id === id),
      locked: (id: string) => this.systemMapUI.locked?.(id) ?? null, interactKey: boundKeyName('interact', settings.data.bindings),
    };
    const region = this.regionUI.current(ctx);
    this.regionUI.update(ctx);
    this.pilotHud.setZone(sys.name.replace(/ System$/, ''), sys.danger ?? 1, !!sys.pvp, safe, ring, region ?? undefined);
    // (Against the band you're in, where a system has them)
    this.pilotHud.setRating(rating, (region && this.state.regionThreats[sys.id]?.[region.id]) || this.state.threats[sys.id]);
  }

  /** Apply every setting (runs on start and on each change). */
  private applySettings(s: SettingsData): void {
    this.applyVolume(s);
    this.renderer.shakeScale = s.display.screenShake;
    this.state.logSpikes = s.ui.netStats;
    this.renderer.showDamageNumbers = s.display.damageNumbers;
    this.renderer.showNames = s.display.playerNames;
    this.renderer.setPlanetsVisible(s.display.planets);
    this.renderer.bloom.enabled = s.display.bloom;
    this.renderer.lighting.enabled = s.display.lighting;
    // Graphics quality and the frame-rate cap
    this.autoQuality.reset();
    this.applyQuality();
    this.app.ticker.maxFPS = s.display.fpsCap;
    this.refreshWorld = true;
    // Render resolution: only resize when it actually changes
    const res = this.renderResolution();
    if (Math.abs(this.app.renderer.resolution - res) > 1e-3) this.onResize();
    this.renderer.setMinimapVisible(s.ui.minimap);
    this.shipClient.setDisplay({ hud: s.ui.shipHud, jumpScreenEffects: s.display.jumpEffects });
    this.shipClient.applyControlMode();
    this.hazards.setEffectsVisible(s.ui.hazardEffects);
    this.frost.setVisible(s.ui.hazardEffects);
    if (this.navMarkers) this.navMarkers.enabled = s.ui.navMarkers;
    if (this.loggedIn) {
      this.perfMonitor?.setVisible(s.ui.netStats);
    }
    const chat = document.getElementById('chatBox');
    if (chat) chat.style.visibility = s.ui.chat ? 'visible' : 'hidden';
    this.input.invertZoom = s.gameplay.invertZoom;
    this.input.zoomSpeedScale = s.gameplay.zoomSpeed;
    this.input.setBindings(ACTIONS.filter((a) => a.rebindable !== false).map((a) => ({ defaultCode: a.key, code: s.bindings[a.id] ?? a.key })));
  }

  private heatEl: HTMLDivElement | null = null;
  private heatText: HTMLElement | null = null;
  private heatFill: HTMLElement | null = null;
  private wasOverheated = false;

  /** Beam weapon heat (lances, frostbite): a thin bar over the jump gauge while anything's warm; pulse lasers' charge there while they charge */
  private updateHeatGauge(): void {
    const me = this.state.entities.get(this.state.playerId);
    const heat = me?.data?.[6] ?? 0, over = me?.data?.[7] === 1;
    if (!this.heatEl) {
      this.heatEl = document.createElement('div');
      this.heatEl.style.cssText = `position: fixed; left: 50%; bottom: 150px; transform: translateX(-50%); width: 240px; z-index: 860; pointer-events: none;
        font: 700 10px 'Segoe UI', sans-serif; letter-spacing: 2px; text-align: center; display: none;`;
      this.heatEl.innerHTML = '<div data-k="t"></div><div style="height:4px; border-radius:2px; background:rgba(255,255,255,0.08); margin-top:3px; overflow:hidden"><i data-k="f" style="display:block; height:100%; transition: width .1s"></i></div>';
      document.body.appendChild(this.heatEl);
      this.heatText = this.heatEl.querySelector('[data-k="t"]') as HTMLElement;
      this.heatFill = this.heatEl.querySelector('[data-k="f"]') as HTMLElement;
    }
    const laser = this.shipClient.laserCharge();
    const charging = !!laser && laser.charge < 0.999 && !(heat > 1 || over);
    const show = this.loggedIn && !this.shipClient.hangarOpen && (heat > 1 || over || charging);
    setStyle(this.heatEl, 'display', show ? 'block' : 'none');
    if (!show) { this.wasOverheated = false; return; }
    if (charging && laser) {
      // Pulse lasers: no heat, just the charge to their next pulse
      setText(this.heatText, laser.total > 1 ? `LASERS CHARGING · ${laser.ready}/${laser.total} READY` : 'LASER CHARGING');
      setStyle(this.heatText, 'color', '#fecaca');
      setStyle(this.heatFill, 'width', `${Math.round(laser.charge * 100)}%`);
      setStyle(this.heatFill, 'background', 'linear-gradient(90deg,#7f1d1d,#f87171,#ffe4e4)');
      this.wasOverheated = false;
      return;
    }
    setText(this.heatText, over ? 'BEAMS OVERHEATED · COOLING' : 'BEAM HEAT');
    setStyle(this.heatText, 'color', over ? '#fca5a5' : heat > 75 ? '#fdba74' : '#cbd5e1');
    setStyle(this.heatFill, 'width', `${Math.min(100, Math.round(heat))}%`);
    setStyle(this.heatFill, 'background', over ? '#ef4444' : heat > 75 ? 'linear-gradient(90deg,#f59e0b,#ef4444)' : 'linear-gradient(90deg,#38bdf8,#f59e0b)');
    if (over && !this.wasOverheated) this.audio.playUI('warning', 0.5);
    this.wasOverheated = over;
  }

  private applyVolume(s: SettingsData): void {
    const muted = s.audio.muteUnfocused && !this.windowFocused;
    this.audio.setMasterVolume(muted ? 0 : s.audio.master);
    this.audio.setSFXVolume(s.audio.sfx);
    this.audio.setMusicVolume(s.audio.music);
  }

  private handleKeyPress(code: string): void {
    // The menu owns the keyboard while open (Esc steps back / closes it)
    if (this.menu.isOpen) {
      if (code === 'Escape') this.menu.back();
      return;
    }
    // A conversation: digits answer, Space skips ahead, Esc walks away
    if (this.dialogue.onKey(code)) return;
    // The component guide sits over everything else (the hangar, the station)
    if (this.componentGuide.value?.isOpen) {
      if (code === 'Escape' || code === 'KeyC') this.componentGuide.value.close();
      return;
    }
    // C: the component guide (anywhere but the map, which centres on C)
    if (code === 'KeyC' && this.loggedIn && !this.systemMapUI.isOpen) {
      this.componentGuide.use((g) => g.open());
      return;
    }
    if (this.inventoryWindow.isOpen) {
      if (code === 'Escape' || code === 'KeyI') this.inventoryWindow.close();
      return;
    }
    if (this.tradeWindow.isOpen) {
      if (code === 'Escape') this.tradeWindow.close();
      return;
    }
    if (this.social.window.isOpen) {
      if (code === 'Escape' || code === 'KeyP') this.social.window.close();
      return;
    }
    if (this.quests.log.isOpen) {
      if (code === 'Escape') this.quests.log.close();
      else if (code === 'KeyL') this.quests.log.toggle('jobs');
      else if (code === 'KeyK') this.quests.log.toggle('skills');
      return;
    }
    if (this.stationOpen && !this.shipClient.hangarOpen) {
      if (code === 'Escape' || code === 'KeyH') this.stationWindow.value!.close();
      else if (code === 'KeyI') this.inventoryWindow.open();
      return;
    }
    if (this.proto?.onKeyPressed?.(code)) return;
    // Any flight key hands control back from the autopilot
    if (this.autopilot.active && FLIGHT_KEYS.has(code) && !this.shipClient.hangarOpen) this.autopilot.cancel('Autopilot off');
    // ...and calls off a menu jump; Esc calls off a menu order (instead of opening the game menu)
    if (this.context.jumpMark() && FLIGHT_KEYS.has(code) && !this.shipClient.hangarOpen) this.context.cancel('Jump cancelled');
    if (code === 'Escape' && this.context.active && this.context.cancel(this.context.jumpMark() ? 'Jump cancelled' : 'Autopilot off')) return;
    // G: autopilot to the job you're following (again: off)
    if (code === 'KeyG' && this.loggedIn && !this.shipClient.hangarOpen) {
      this.toggleAutopilotToObjective();
      return;
    }
    if (this.loggedIn && this.shipClient.onKey(code)) return;

    // I: cargo and storage
    if (code === 'KeyI' && this.loggedIn && !this.shipClient.hangarOpen) {
      this.inventoryWindow.open();
      return;
    }
    // 1-5: the quick bar
    const quick = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5'].indexOf(code);
    if (quick >= 0 && this.loggedIn && !this.shipClient.hangarOpen) {
      this.quickBar.use(quick);
      return;
    }
    // P: invite the pilot under the cursor, or the party window
    if (code === 'KeyP' && this.loggedIn && !this.shipClient.hangarOpen) {
      const over = this.infoPanel.hovered;
      if (over > 0 && !this.social.isMember(over)) this.social.invite(over);
      else this.social.openWindow();
      return;
    }
    // B: ping what's under the cursor for the party (Shift: danger)
    if (code === 'KeyB' && this.loggedIn && !this.shipClient.hangarOpen) {
      this.pingUI.pingAtCursor(this.input.isKeyDown('ShiftLeft') || this.input.isKeyDown('ShiftRight'));
      return;
    }
    // Tab: next hostile; T: the ship under the cursor
    if (code === 'Tab' && this.loggedIn && !this.shipClient.hangarOpen) {
      this.targetUI.cycle();
      return;
    }
    if (code === 'KeyT' && this.loggedIn && !this.shipClient.hangarOpen) {
      this.targetUI.pickAtCursor();
      return;
    }
    // L: the pilot log (jobs), K: skills
    if ((code === 'KeyL' || code === 'KeyK') && this.loggedIn && !this.shipClient.hangarOpen) {
      this.quests.log.open(code === 'KeyL' ? 'jobs' : 'skills');
      return;
    }

    // Escape opens the menu (the map and the hangar close themselves first; the stats panel closes instead)
    if (code === 'Escape' && this.loggedIn) {
      if (this.playerStatsUI.isVisible()) this.playerStatsUI.hide();
      else this.menu.open();
      return;
    }
    
    // O: session stats panel
    if (code === 'KeyO' && this.loggedIn) {
      this.playerStatsUI.toggle();
    }

    // M key - toggle system map
    if (code === 'KeyM' && this.loggedIn) {
      this.systemMapUI.toggle();
      this.audio.playUI(this.systemMapUI.isOpen ? 'ui_open' : 'ui_close', 0.7);
    }

    // N key - toggle navigation markers
    if (code === 'KeyN' && this.loggedIn && this.navMarkers) {
      const on = !settings.data.ui.navMarkers;
      settings.update((s) => { s.ui.navMarkers = on; });
      this.showSystemMessage(on ? 'Nav markers on' : 'Nav markers off', '#7dd3fc');
    }
    
    // Respawn with R after being destroyed
    if (code === 'KeyR' && this.loggedIn) {
      this.network.send({ type: 'respawn' });
    }
    
    // Interact with X (E is strafe right in helm controls)
    if (code === 'KeyX' && this.loggedIn && this.regionUI.allowInteract()) {
      this.network.send({ type: 'interact' });
    }
    

    // Reset zoom with Home
    if (code === 'Home') {
      this.input.resetZoom();
      this.renderer.setZoom(1);
    }
  }
  
  /**
   * Where the followed job wants you. Jobs out in space follow what's live: the
   * freighter you're escorting as it flies, the outpost or beacons once they're up.
   */
  /** Your wreck, as a marker while it's kept for you here (with the time left) */
  private wreckMarker(): { name: string; x: number; y: number; system: string }[] {
    const w = this.wreck;
    if (!w || w.system !== this.state.systemId) return [];
    const left = Math.max(0, Math.round((w.until - Date.now()) / 1000));
    if (!left) { this.wreck = null; return []; }
    return [{ name: `⚑ Your wreck (${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')})`, x: w.x, y: w.y, system: w.system }];
  }

  private objective(): QuestTarget | null {
    const t = this.quests.objective();
    const q = this.quests.current();
    const op = q && this.opsUI?.ops.find((o) => o.quest === q.id);
    if (!op || op.system !== this.state.systemId) return t;
    const ward = op.ward && this.state.entities.get(op.ward.eid);
    if (ward) return { system: op.system, x: ward.renderX, y: ward.renderY, label: op.ward!.name };
    if (t && t.x === undefined && op.markers.length && op.kind !== 'scan') {
      const m = op.markers[0];
      return { system: op.system, x: m.x, y: m.y, label: m.label };
    }
    return t;
  }

  /** The objective guide: the next waypoint under the tracker, and chevrons from the ship towards it */
  private updateGuide(): void {
    const on = settings.data.ui.questGuide && this.loggedIn && !this.shipClient.hangarOpen && !this.systemMapUI.isOpen && !this.menu.isOpen;
    const wp = on ? this.navMarkers?.objectiveTarget() ?? null : null;
    const me = this.state.entities.get(this.state.playerId);
    if (!wp || !me) { this.quests.setGuide(''); this.guide.update(null, null, 0); return; }
    const dist = Math.hypot(wp.x - me.renderX, wp.y - me.renderY);
    const km = dist >= 1000 ? `${(dist / 1000).toFixed(1)} km` : `${Math.round(dist)} m`;
    this.quests.setGuide(`➜ ${wp.name} · ${km}`);
    this.guide.update(this.renderer.worldToScreen(me.renderX, me.renderY), this.renderer.worldToScreen(wp.x, wp.y), dist);
  }

  /** The right mouse button as the guns and mining laser see it: held, but not while the right-click menu is up (or the press that opened it) */
  private rightHeld(): boolean {
    return this.input.isMouseDown(2) && !this.context?.withholdingFire();
  }

  /** Engage the autopilot (map clicks, the job tracker, party members, right-clicks) */
  flyTo(dest: AutoDest, note?: string): void {
    if (!this.loggedIn || this.proto) return;
    if (this.stationOpen) this.stationWindow.value!.close();
    // (Somewhere new: a menu jump lining up is off)
    if (this.context.jumpMark()) this.context.cancel();
    this.autopilot.engage(dest, note);
    this.audio.playUI('ui_click', 0.5);
  }

  private toggleAutopilotToObjective(): void {
    if (this.autopilot.active) { this.autopilot.cancel('Autopilot off'); return; }
    const t = this.objective();
    const q = this.quests.current() ?? this.quests.trackedLead();
    if (!t || !q) { this.showSystemMessage(`Follow a job or a lead with a destination first (${boundKeyName('log', settings.data.bindings)}), or click a place on the map (${boundKeyName('map', settings.data.bindings)})`, '#f2d24b'); return; }
    this.flyTo({ kind: 'objective', name: t.label || q.name });
  }

  /** Network readout: what's coming in and going out, per second (refreshed every couple of seconds) */
  private netRates(): string {
    const tr = (this.network as { traffic?: { bytesIn: number; bytesOut: number; framesIn: number } }).traffic;
    if (!tr) return '';
    const now = performance.now();
    const dt = (now - this.lastTraffic.t) / 1000;
    if (dt >= 1.5) {
      if (this.lastTraffic.t) {
        this.trafficText = ` | ↓ ${((tr.bytesIn - this.lastTraffic.bytesIn) / 1024 / dt).toFixed(1)} KB/s (${Math.round((tr.framesIn - this.lastTraffic.framesIn) / dt)}/s) ↑ ${((tr.bytesOut - this.lastTraffic.bytesOut) / 1024 / dt).toFixed(2)} KB/s`;
      }
      this.lastTraffic = { t: now, bytesIn: tr.bytesIn, bytesOut: tr.bytesOut, framesIn: tr.framesIn };
    }
    return this.trafficText;
  }

  /** Local cursor relative to the player's ship, world units. */
  private localAim(): { angle: number; dist: number } {
    const m = this.systemMapUI?.aimWorld() ?? this.renderer.screenToWorld(this.input.mouseX, this.input.mouseY);
    const p = this.state.getPlayerPosition();
    return { angle: Math.atan2(m.y - p.y, m.x - p.x), dist: Math.hypot(m.x - p.x, m.y - p.y) };
  }

  private update(): void {
    if (!this.running) return;
    
    const now = performance.now();
    const delta = (now - this.lastFrameTime) / 1000;
    this.lastFrameTime = now;
    
    // Auto quality: steps down a tier when the frames stay slow (not while a window hides the world)
    if (settings.data.display.quality === 'auto' && this.loggedIn && !this.worldPaused) {
      const cap = settings.data.display.fpsCap;
      if (this.autoQuality.sample(delta * 1000, now, cap ? 1000 / cap : 0)) this.applyQuality();
    }

    // Update FPS counter
    this.frameCount++;
    this.perfMonitor?.frame(delta * 1000, now);
    if (now - this.fpsUpdateTime > 1000) {
      this.frameCount = 0;
      this.fpsUpdateTime = now;
    }
    
    // Update input (for zoom interpolation). Hangar and menu read keys as they are, unbound.
    this.input.raw = this.shipClient.hangarOpen || this.menu.isOpen;
    this.input.update(delta);
    // Mid-jump the camera locks on and pulls back; afterwards it eases back to normal
    const burning = this.shipClient.localBurning();
    this.jumpZoom += ((burning && settings.data.display.jumpCamera ? 0.72 : 1) - this.jumpZoom) * Math.min(1, delta * (burning ? 3 : 1.5));
    this.renderer.cameraFollow = burning ? 0.85 : Math.max(0.1, this.renderer.cameraFollow * 0.97);
    this.renderer.setZoom(this.input.zoom * this.jumpZoom);
    
    if (this.loggedIn && this.state.playerId && this.network.isConnected()) {
      if (this.proto) {
        // Proto: no prediction. Inputs go straight to the in-process simulation, at the tick rate.
        this.state.updateCachedServerTick();
        this.inputTickAccum += delta * 1000; // delta is in seconds
        let ticksRun = 0;
        while (this.inputTickAccum >= TICK_MS && ticksRun < 4) {
          this.tickInput();
          this.inputTickAccum -= TICK_MS;
          ticksRun++;
        }
        if (this.inputTickAccum > TICK_MS * 4) this.inputTickAccum = 0;
      } else {
        // Prediction: one physics step per tick number, every tick number once, up to the
        // server's tick (estimated). The replay after a snapshot then steps exactly the
        // ticks the server will (see GameState.ticksDue: tick numbers and steps can't drift apart).
        const due = Math.min(4, this.state.ticksDue());
        for (let i = 0; i < due; i++) {
          this.state.cachedServerTick = this.state.predictedTick;
          this.tickInput();               // sample input, queued for targetTick = tick + input delay
          this.state.drainDelayQueue();   // apply what's due and step to predictedTick + 1
          this.state.predictedTick++;
        }
        this.state.cachedServerTick = this.state.predictedTick;
      }
    }

    // Interpolate entities (rocks out of sight placed less often: see GameState.orbitFocus)
    {
      const me = this.state.entities.get(this.state.playerId);
      const shown = !this.systemMapUI.covers() && !(this.loggedIn && (this.shipClient.hangarOpen || this.menu.isOpen));
      if (me) this.renderer.orbitFocus(me.renderX, me.renderY, shown, this.state.orbitFocus ??= { cx: 0, cy: 0, px: 0, py: 0, hw: 0, hh: 0 });
      else this.state.orbitFocus = null;
    }
    this.state.interpolate(delta);
    this.proto?.afterInterpolate(this.state);
    this.shipClient.update(now);
    this.hazards.setHorizonDanger(this.shipClient.horizonDanger());
    this.frost.update(this.loggedIn ? this.state.entities.get(this.state.playerId)?.warmth ?? null : null, delta);
    this.updateSounds(now);
    if (this.navMarkers) {
      this.navMarkers.setHidden(!this.loggedIn || this.shipClient.hangarOpen || this.systemMapUI.isOpen || this.menu.isOpen);
    this.regionUI.setHidden(!this.loggedIn || this.shipClient.hangarOpen || this.menu.isOpen || this.stationOpen);
      // (Every few frames on the lower tiers: see settings/quality.ts)
      if (++this.navFrames >= this.hudEvery) {
        this.navFrames = 0;
        this.navMarkers.update();
      }
    }
    if (this.peopleUI) {
      this.peopleUI.setHidden(!this.loggedIn || this.shipClient.hangarOpen || this.systemMapUI.isOpen || this.menu.isOpen);
      this.peopleUI.update();
    }
    this.updateGuide();
    this.context.update();
    this.bossUI.hidden = !this.loggedIn || this.shipClient.hangarOpen || this.systemMapUI.isOpen;
    if (!this.loggedIn || this.shipClient.hangarOpen || this.menu.isOpen || this.stationOpen) this.autopilot.setHidden(true);
    this.bossUI.update();
    this.farMarkers.setHidden(!this.loggedIn || this.shipClient.hangarOpen || this.systemMapUI.isOpen || this.menu.isOpen);
    this.farMarkers.update();
    const blocked = !this.loggedIn || this.shipClient.hangarOpen || this.systemMapUI.isOpen || this.menu.isOpen;
    const windowOpen = this.stationOpen || this.inventoryWindow.isOpen || this.tradeWindow.isOpen || this.social.window.isOpen || this.quests.log.isOpen || !!this.componentGuide.value?.isOpen;
    this.targetUI.setHidden(blocked);
    this.targetUI.update();
    this.infoPanel.update(!blocked && !windowOpen && !this.localDead);
    this.opsUI.setHidden(blocked);
    this.opsUI.update(this.bossUI.visible);
    // A construct job's site, while a piece is going on: the constructor beam
    const building = this.opsUI.ops.find((o) => o.kind === 'construct' && o.system === this.state.systemId && o.markers[0]?.state === 'active');
    this.buildSites?.update(1 / 60, building ? building.markers[0] : null);
    this.tutorial.update(blocked || this.localDead || this.playerStatsUI.isVisible());
    this.pingUI.setHidden(blocked);
    this.pingUI.update();
    // The hold above the chat: not while docked (the station's storage has it) or behind a full-screen view
    {
      const me = this.state.entities.get(this.state.playerId);
      this.cargoPanel.update(blocked || this.stationOpen || !me, !!me && !inSafeSpace(this.currentSystem(), me.renderX, me.renderY));
    }
    this.updateHeatGauge();

    // Update screen shake
    this.state.updateScreenShake(delta);
    
    // Helm: the view turns to put the ship's nose up the screen; otherwise it eases back to north-up
    {
      const me = this.state.entities.get(this.state.playerId);
      this.renderer.setCameraHeading(this.loggedIn && me && this.shipClient.helmMode() && !this.shipClient.hangarOpen ? noseUpAngle(me.renderAngle) : null);
    }

    // Update floating rewards with camera position
    if (this.loggedIn) {
      const playerPos = this.state.getPlayerPosition();
      const zoom = this.input.zoom;
      const roll = this.renderer.getCameraAngle();
      this.floatingRewardsUI.setCamera(playerPos.x, playerPos.y, zoom, roll);
      this.damageIndicatorUI.setPlayerPosition(playerPos.x, playerPos.y, roll);
    }
    
    // Update audio listener position
    const playerPos = this.state.getPlayerPosition();
    this.audio.setListenerPosition(playerPos.x, playerPos.y);
    
    // Under the hangar or the menu the world isn't updated or drawn (the simulation, network and audio carry on above);
    // it catches up the frame the window closes, and once for a resize or a changed setting
    const paused = this.loggedIn && (this.shipClient.hangarOpen || this.menu.isOpen);
    this.worldPaused = paused;
    const covered = this.systemMapUI.covers();
    // (Nor under the sign-in screen, whose backdrop is drawn instead: its shaders are still compiling ahead)
    // Under a map that covers the screen the world isn't drawn at all (the GPU gets a rest), and kept up ten times a
    // second, not every frame (its effects run their course and views come and go; it's whole again as the map lifts)
    this.coveredDelta = covered ? this.coveredDelta + delta : 0;
    if ((!paused || this.refreshWorld) && !this.loginUI.backdrop()) {
      if (this.app.stage.visible === covered) this.app.stage.visible = !covered;
      if (!covered) {
        this.renderer.update(delta);
        this.renderer.applyLighting();
        this.renderer.renderBloom();
      } else if (this.coveredDelta >= 0.1) {
        this.renderer.update(this.coveredDelta);
        this.coveredDelta = 0;
      }
    }
    
    // Periodic state hash for snapshot-on-mismatch (1 Hz). Proto has no prediction to check.
    if (!this.proto && this.loggedIn && this.state.playerId && this.network.isConnected()) {
      if (now - this.lastStateHashTime > 1000) {
        const player = this.state.entities.get(this.state.playerId);
        if (player) {
          const hash = computeStateHash(
            player.x,
            player.y,
            player.angle || 0,
            player.vx || 0,
            player.vy || 0,
            player.hp || 0,
            this.state.boostFuel,
            this.state.systemId,
          );
          // The tick the prediction is at: the server checks it against its own record of that tick
          this.network.send({ type: 'stateHash', tick: this.state.cachedServerTick, hash });
          this.lastStateHashTime = now;
        }
      }
    }
    
    // Update UI
    this.updateUI();
  }

  /**
   * Fixed-rate input tick (runs at TICK_RATE = 60Hz).
   * Samples current input state, runs local prediction, and only sends
   * a network message if the input actually changed from last send.
   */
  private tickInput(): void {
    // The system map open: the ship faces the map cursor
    const mouseWorld = this.systemMapUI.aimWorld() ?? this.renderer.screenToWorld(
      this.input.mouseX,
      this.input.mouseY
    );
    
    const playerPos = this.state.getPlayerPosition();
    
    // Clamp cursor to circle of CURSOR_RADIUS and compute angle
    let dx = mouseWorld.x - playerPos.x;
    let dy = mouseWorld.y - playerPos.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > CURSOR_RADIUS) {
      dx = dx / dist * CURSOR_RADIUS;
      dy = dy / dist * CURSOR_RADIUS;
    }
    
    let rawAngle = Math.atan2(dy, dx);
    // True distance (not the clamped one): turrets converge on the cursor point
    let aimDist = Math.hypot(mouseWorld.x - playerPos.x, mouseWorld.y - playerPos.y);
    // Lining up a jump: lock on to a station, gate or marker near the cursor, and stop just short of it (a stillstone: inside its field)
    // A menu jump: its mark, wherever the cursor is
    const inputEnabled = (this.proto?.inputEnabled?.() ?? true) && !this.shipClient.hangarOpen && !this.menu.isOpen && !this.adminPanel?.capturesFlight;
    const order = inputEnabled ? this.context.flight() : null;
    if (order) {
      rawAngle = order.angle;
      aimDist = order.dist;
      this.shipClient.setJumpAim(aimDist, null);
      this.systemMapUI.jumpAim = { angle: rawAngle, dist: aimDist, label: null };
    } else if (this.loggedIn && this.shipClient.jumpAiming()) {
      // Cursor right on a destination, or pointing straight at one (off-screen ones too: aim at its edge marker)
      // (On the map, whatever's under its cursor wins)
      let best: { name: string; x: number; y: number; stop?: number } | null = this.systemMapUI.jumpLock(), bd = best ? -Infinity : Infinity;
      const aimA = Math.atan2(mouseWorld.y - playerPos.y, mouseWorld.x - playerPos.x);
      for (const t of this.navMarkers?.snapTargets() ?? []) {
        const far = Math.hypot(t.x - playerPos.x, t.y - playerPos.y);
        if (far < 2500) continue;
        const near = Math.hypot(t.x - mouseWorld.x, t.y - mouseWorld.y);
        let da = Math.abs(Math.atan2(t.y - playerPos.y, t.x - playerPos.x) - aimA);
        if (da > Math.PI) da = 2 * Math.PI - da;
        const onPoint = near < Math.max(1500, far * 0.12);
        const onLine = da < Math.max(0.05, Math.atan2(1200, far));
        if (!onPoint && !onLine) continue;
        const score = onPoint ? near / far : da;
        if (score < bd) { bd = score; best = t; }
      }
      if (best) {
        const far = Math.hypot(best.x - playerPos.x, best.y - playerPos.y);
        rawAngle = Math.atan2(best.y - playerPos.y, best.x - playerPos.x);
        aimDist = Math.max(0, far - (best.stop ?? 1500));
      }
      this.shipClient.setJumpAim(aimDist, best?.name ?? null);
      this.systemMapUI.jumpAim = { angle: rawAngle, dist: aimDist, label: best?.name ?? null };
    }
    
    let fireLeft = inputEnabled && ((this.input.isMouseDown(0) && !this.context.withholdingLeft()) || this.systemMapUI.firing());
    let fireRight = inputEnabled && this.rightHeld();
    // A click calls off a menu jump too
    if (fireLeft && this.context.jumpMark()) this.context.cancel('Jump cancelled');
    // The autopilot flies until a click (or a flight key) takes over
    if (this.autopilot.active && (fireLeft || fireRight)) this.autopilot.cancel('Autopilot off');
    const auto = this.loggedIn && inputEnabled && !this.stationOpen ? this.autopilot.tick() : null;
    if (auto) { fireLeft = fireRight = false; }
    
    // Gun sounds come from the shots themselves (updateSounds); firing stirs the combat music
    if (fireLeft && !this.lastFireLeft) this.playerStatsUI.addShotFired();
    if (fireRight && !this.lastFireRight) this.playerStatsUI.addShotFired();
    if (fireLeft || fireRight) this.audio.bumpCombat(1);
    this.lastFireLeft = fireLeft;
    this.lastFireRight = fireRight;
    
    // Fire state is now passed to renderer AFTER drainDelayQueue() in the
    // update loop, using the drained (tick-accurate) angle rather than the
    // live mouse angle. This ensures the laser visual matches what the server
    // actually processes (N ticks delayed).
    
    let forward = inputEnabled && (this.input.isKeyDown('KeyW') || this.input.isKeyDown('ArrowUp'));
    let backward = inputEnabled && (this.input.isKeyDown('KeyS') || this.input.isKeyDown('ArrowDown'));
    let left = inputEnabled && (this.input.isKeyDown('KeyA') || this.input.isKeyDown('ArrowLeft'));
    let right = inputEnabled && (this.input.isKeyDown('KeyD') || this.input.isKeyDown('ArrowRight'));
    let boost = inputEnabled && (this.input.isKeyDown('ShiftLeft') || this.input.isKeyDown('ShiftRight'));
    // Proto helm controls: left/right turn the ship, Q/E strafe
    let helm = this.shipClient.helmMode();
    let strafeLeft = helm && inputEnabled && this.input.isKeyDown('KeyQ');
    let strafeRight = helm && inputEnabled && this.input.isKeyDown('KeyE');
    // Jump drive: J latches it on, and it stays on until the jump fires (or J again cancels)
    let jump = inputEnabled && this.shipClient.jumpHeld();
    // Stabiliser Anchor: toggled (Y), it stays braced while the toggle is on, chat or menus open or not
    let brace = this.shipClient.braceHeld();
    // (The angle is quantized to 13 bits, so client and server use the same value for hitscan: see CURSOR_STATE.md)
    let quantized = quantizeCursorAngle(rawAngle);
    let cursorDistQ = quantizeCursorDist(aimDist);
    // A menu jump has the controls as the autopilot does: no thrust, mouse-steer, the drive as it says
    if (order) {
      forward = backward = left = right = boost = helm = strafeLeft = strafeRight = brace = false;
      jump = order.jump;
    }
    if (auto) {
      ({ forward, backward, left, right, boost, jump } = auto);
      helm = strafeLeft = strafeRight = brace = false;
      quantized = quantizeCursorAngle(auto.targetAngle);
      cursorDistQ = quantizeCursorDist(auto.jump ? auto.cursorDist : aimDist);
    }
    const targetAngle = dequantizeCursorAngle(quantized);
    
    // Check if anything changed from last sent state
    const changed = forward !== this.lastSentForward
      || backward !== this.lastSentBackward
      || left !== this.lastSentLeft
      || right !== this.lastSentRight
      || boost !== this.lastSentBoost
      || fireLeft !== this.lastSentFireLeft
      || fireRight !== this.lastSentFireRight
      || quantized !== this.lastSentAngle
      || strafeLeft !== this.lastSentStrafeLeft
      || strafeRight !== this.lastSentStrafeRight
      || helm !== this.lastSentHelm
      || jump !== this.lastSentJump
      || brace !== this.lastSentBrace
      || cursorDistQ !== this.lastSentCursorDist;
    
    // Stamp targetTick using local tick counter — each tick iteration
    // gets a unique targetTick, ensuring one physics step per drain.
    const targetTick = this.state.getInputTargetTick();
    
    const msg: ClientInputMessage = {
      type: 'input',
      seq: 0, // set below only if we send
      tick: this.state.serverTick,
      targetTick,
      forward,
      backward,
      left,
      right,
      boost,
      fireLeft,
      fireRight,
      targetAngle,
      strafeLeft,
      strafeRight,
      helm,
      cursorDist: cursorDistQ * CURSOR_DIST_STEP,
      jump,
      brace,
    };
    
    // Proto: no targetTick (applied on the next tick) and no prediction queue.
    if (this.proto) {
      if (changed) {
        msg.seq = this.state.nextInputSeq();
        msg.targetTick = undefined;
        this.network.send(msg);
        this.lastSentForward = forward;
        this.lastSentBackward = backward;
        this.lastSentLeft = left;
        this.lastSentRight = right;
        this.lastSentBoost = boost;
        this.lastSentFireLeft = fireLeft;
        this.lastSentFireRight = fireRight;
        this.lastSentAngle = quantized;
        this.lastSentStrafeLeft = strafeLeft;
        this.lastSentStrafeRight = strafeRight;
        this.lastSentHelm = helm;
        this.lastSentJump = jump;
        this.lastSentBrace = brace;
        this.lastSentCursorDist = cursorDistQ;
      }
      return;
    }

    // Only send over network if something changed
    if (changed) {
      msg.seq = this.state.nextInputSeq();
      this.network.send(msg);
      // Queue for delayed application (physics runs when targetTick is reached)
      this.state.applyInput(msg);
      this.lastSentForward = forward;
      this.lastSentBackward = backward;
      this.lastSentLeft = left;
      this.lastSentRight = right;
      this.lastSentBoost = boost;
      this.lastSentFireLeft = fireLeft;
      this.lastSentFireRight = fireRight;
      this.lastSentAngle = quantized;
      this.lastSentStrafeLeft = strafeLeft;
      this.lastSentStrafeRight = strafeRight;
      this.lastSentHelm = helm;
      this.lastSentJump = jump;
      this.lastSentBrace = brace;
      this.lastSentCursorDist = cursorDistQ;
    } else {
      // Queue for delayed application (server also applies same input on same tick)
      this.state.predictTick(msg);
    }
  }

  /**
   * The window lost focus or the tab was hidden: one neutral input (all keys
   * up, no fire), straight to the network. A hidden tab's ticker stops, so
   * tickInput wouldn't send it until the player came back, and the ship would
   * fly on (the server also stops a ship that hasn't sent input for a while).
   */
  private sendNeutralInput(): void {
    if (!this.loggedIn || !this.state.playerId || !this.network.isConnected()) return;
    const msg: ClientInputMessage = {
      type: 'input',
      seq: this.state.nextInputSeq(),
      tick: this.state.serverTick,
      targetTick: this.proto ? undefined : this.state.getInputTargetTick(),
      forward: false,
      backward: false,
      left: false,
      right: false,
      boost: false,
      fireLeft: false,
      fireRight: false,
      targetAngle: dequantizeCursorAngle(this.lastSentAngle),
      strafeLeft: false,
      strafeRight: false,
      helm: this.lastSentHelm,
      cursorDist: this.lastSentCursorDist * CURSOR_DIST_STEP,
      jump: false,
      // (The anchor is a toggle, not a held key: it stays as it was)
      brace: this.lastSentBrace,
    };
    this.network.send(msg);
    // The prediction steps the same input (proto has none)
    if (!this.proto) this.state.applyInput(msg);
    this.lastSentForward = this.lastSentBackward = this.lastSentLeft = this.lastSentRight = false;
    this.lastSentBoost = this.lastSentFireLeft = this.lastSentFireRight = false;
    this.lastSentStrafeLeft = this.lastSentStrafeRight = this.lastSentJump = false;
  }

  private handleServerMessage(msg: ServerMessage): void {
    if (this.shipClient.handleMessage(msg)) return;
    switch (msg.type) {
      case 'welcome':
        // A server on another protocol version (it echoes its own): our decoding can't be trusted
        if (msg.protocol !== undefined && msg.protocol !== PROTOCOL_VERSION) {
          console.warn(`Server protocol ${msg.protocol}, this client ${PROTOCOL_VERSION}`);
          this.network.disconnect();
          this.onDisconnected({ code: PROTOCOL_MISMATCH_CLOSE, reason: 'version', retrying: false });
          return;
        }
        this.state.playerId = msg.playerId;
        this.state.tickRate = msg.tickRate;
        if (msg.threats) this.state.threats = msg.threats;
        if (msg.regionThreats) this.state.regionThreats = msg.regionThreats;
        this.loggedIn = true;
        this.renderer.hideDeathScreen(); // welcome also follows a respawn
        this.localDead = false;
        this.social?.showRally(false);
        console.log('Joined as player', msg.playerId);
        break;
        
      case 'pong':
        this.state.handlePong(msg.clientTime, msg.serverTime, msg.tick);
        this.perfSrv = msg.serverProcessing;
        this.perfNet = this.netRates().replace(/^ \| /, '');
        break;
        
      case 'snapshot':
        this.state.applySnapshot(msg);
        break;
        
      case 'playerState':
        // Track credit gains for stats
        if (msg.credits > this.state.credits) {
          const creditGain = msg.credits - this.state.credits;
          this.playerStatsUI.addCreditsEarned(creditGain);
          // Show floating credit text near player
          const playerPos = this.state.getPlayerPosition();
          this.floatingRewardsUI.addCredits(playerPos.x, playerPos.y, creditGain);
        }
        // Track XP gains for stats
        if (msg.xp > this.state.xp || msg.level > this.state.level) {
          const xpGain = msg.xp - this.state.xp;
          if (xpGain > 0) {
            const playerPos = this.state.getPlayerPosition();
            this.floatingRewardsUI.addXP(playerPos.x, playerPos.y, xpGain, msg.level > this.state.level);
          }
        }
        this.state.hp = msg.hp;
        this.state.maxHp = msg.maxHp;
        this.state.boostFuel = msg.boostFuel;
        this.state.maxBoostFuel = msg.maxBoostFuel;
        this.state.serverBoostFuel = msg.boostFuel; // anchor for reconciliation
        // Sounds for gains and travel (not for the first update after joining)
        if (this.statsPrimed) {
          if (msg.level > this.state.level) this.audio.playUI('level_up');
          else if (msg.credits > this.state.credits) this.audio.playUI('credits', 0.8);
          if (msg.systemId !== this.state.systemId) this.audio.playUI('warp');
        }
        if (msg.systemId !== this.state.systemId) this.systemArrivedAt = performance.now();
        this.statsPrimed = true;
        this.state.xp = msg.xp;
        this.state.level = msg.level;
        this.state.credits = msg.credits;
        // Clear deterministic asteroids on system change
        if (msg.systemId !== this.state.systemId) {
          this.state.clearDeterministicAsteroids();
          this.state.clearForSystemChange();
        }
        this.state.systemId = msg.systemId;
        break;
        
      case 'systemInfo':
        // Data-driven system visuals from the server (central body + starfield)
        this.renderer.setSystemInfo(msg);
        this.systemNames.set(msg.systemId, msg.name);
        this.hazards.setHazards(msg.hazards ?? []);
        // Feed the system map
        this.systemMapUI.setSystemInfo({
          name: msg.name,
          sector: msg.sector,
          centralBody: msg.centralBody as any,
        });
        break;
        
      case 'profile':
        if (this.pilot.profile && msg.level > this.pilot.profile.level) this.audio.playUI('level_up');
        this.pilot.setProfile(msg);
        break;

      case 'items':
        this.pilot.setItems(msg);
        break;

      case 'gained': {
        if (msg.source?.startsWith('kill:') || msg.source?.startsWith('assist:')) this.sessionKills++;
        const at = msg.x !== undefined && msg.y !== undefined ? { x: msg.x, y: msg.y } : this.state.getPlayerPosition();
        let k = 0;
        for (const [id, n] of Object.entries(msg.items)) {
          const d = this.pilot.econ.items.get(id);
          this.floatingRewardsUI.addItem(at.x, at.y - k++ * 26, `+${n} ${d?.name ?? id}`, d?.rarity ?? 'common');
        }
        if (k) this.audio.playUI('credits', 0.35);
        if (msg.xp) this.floatingRewardsUI.addXP(at.x + 40, at.y - k * 26, msg.xp);
        if (msg.credits) this.floatingRewardsUI.addCredits(at.x - 40, at.y - k * 26, msg.credits);
        if (msg.source?.startsWith('kill:')) {
          this.killFeedUI.addEnemyDefeat(this.state.playerName, msg.source.slice(5), true);
          this.playerStatsUI.addEnemyDefeated();
          this.audio.playUI('credits', 0.6);
        }
        break;
      }

      case 'wreck':
        this.wreck = msg.gone || msg.system === undefined ? null : { system: msg.system, x: msg.x ?? 0, y: msg.y ?? 0, until: Date.now() + (msg.seconds ?? 0) * 1000 };
        break;

      case 'toast':
        this.toasts.show(msg.text, msg.kind);
        if (msg.kind === 'bad') this.audio.playUI('error', 0.5);
        else if (msg.text.startsWith('Fabrication complete')) this.audio.playUI('craft_done', 0.8);
        break;

      case 'rebuild':
        this.pilot.setRebuild(msg);
        break;

      case 'station':
        this.stationWindow.use((w) => w.setStation(msg));
        break;

      case 'vendors':
        this.stationWindow.use((w) => w.setVendors(msg));
        break;

      case 'marketScan':
        this.stationWindow.use((w) => w.setScan(msg));
        break;

      case 'quests':
        // Brand-new pilots get the flight school
        if (!this.proto) this.tutorial.maybeStart(msg.done === 0 && (this.pilot.profile?.level ?? 1) <= 1 && (this.pilot.profile?.xp ?? 0) < 20);
        this.quests.setQuests(msg);
        this.buildSites?.set(msg.builds);
        break;

      case 'codex':
        this.quests.setCodex(msg);
        break;

      case 'hangar':
        this.pilot.setHangar(msg);
        break;

      case 'party':
        this.social.setParty(msg);
        break;

      case 'partyInvite':
        this.social.onInvite(msg);
        break;

      case 'tradeRequest':
        this.social.onTradeRequest(msg);
        break;

      case 'trade':
        this.tradeWindow.onTrade(msg);
        break;

      case 'pilotInfo':
        this.infoPanel.onInfo(msg);
        break;

      case 'ops':
        this.opsUI.setOps(msg);
        break;

      case 'mapPing':
        this.pingUI.onPing(msg);
        break;

      case 'ribbon': {
        const def = (ribbonData as unknown as RibbonsFile).ribbons.find((r) => r.id === msg.id);
        if (def) this.ribbonPopup.show(def, msg.credits, msg.xp);
        break;
      }

      case 'ribbons':
        this.quests.setRibbons(msg);
        break;

      case 'rankings':
        this.quests.setRankings(msg);
        break;

      case 'news':
        // The galaxy's news: in the chat log, and fresh stories in the event feed too
        this.addChatMessage('Galaxy', msg.text, true);
        if (!msg.old) {
          this.killFeedUI.addSystemMessage(msg.text);
          if (msg.kind === 'boss' || msg.kind === 'fleet') this.audio.playUI('scan_ping', 0.4);
        }
        break;

      case 'sharedDesign':
        this.shipClient.addSharedDesign(msg.from, msg.blueprint);
        this.toasts?.show(`${msg.from} shared the ${msg.blueprint.name}. Open the hangar at a station and pick it under Load → Shared with you`, 'info');
        this.audio.playUI('scan_ping', 0.5);
        break;

      case 'repairKit':
        this.quickBar.setKit(msg.left, msg.total);
        this.shipClient.setKitActive(msg.left > 0);
        break;

      case 'questBoard':
        this.quests.setBoard(msg);
        break;

      case 'talk':
        this.dialogue.set(msg.view);
        break;

      case 'people':
        this.quests.setPeople(msg.people);
        break;

      case 'worldEvent':
        this.worldEvents.set(msg.id, { name: msg.title, x: msg.x, y: msg.y, system: this.state.systemId });
        setTimeout(() => this.worldEvents.delete(msg.id), msg.seconds * 1000 + 5000);
        if (msg.kind === 'raid') this.audio.playUI('warning', 0.7);
        break;

      case 'worldEventEnd':
        this.worldEvents.delete(msg.id);
        break;

      case 'objective':
        this.objectives.show(msg, this.state.systemId);
        if (msg.night !== undefined) this.renderer.setNight(msg.night);
        break;

      case 'objectiveEnd':
        this.objectives.end(msg.id);
        this.renderer.setNight(0);
        break;

      case 'siegeState':
        this.siegePanel.update(msg);
        if (!msg.active) this.renderer.setNight(0);
        break;

      case 'bossIntro':
        this.bossUI.intro(msg.name, msg.title, msg.text);
        break;

      case 'mapDots':
        this.state.farShips.apply(msg, this.state.systemId, this.state.getRawServerTick());
        break;

      case 'bossPhase':
        // (no line: a reminder of the phase it's in, for someone arriving mid-fight)
        if (msg.text) this.bossUI.onPhase(msg.text);
        break;

      case 'bossDefeated':
        this.bossUI.defeated(msg.name);
        break;

      case 'questStep':
        this.quests.stepDone(msg.text);
        this.toasts.show(`Next: ${msg.text}`, 'info');
        break;

      case 'damage':
        this.renderer.showDamageNumber(msg.targetId, msg.amount, msg.critical, msg.glancing);
        this.renderer.hitEntity(msg.targetId, msg.amount);
        // Update entity HP if included (deterministic asteroids)
        if (msg.hp !== undefined) {
          const dmgEntity = this.state.entities.get(msg.targetId);
          if (dmgEntity) {
            dmgEntity.hp = msg.hp;
            if (msg.maxHp !== undefined) dmgEntity.maxHp = msg.maxHp;
          }
        }
        // Show damage indicator if local player is the target
        if (msg.targetId === this.state.playerId) {
          // The indicator points at whoever fired (when we can see them); otherwise it's just a flash
          const src = msg.sourceId !== undefined && msg.sourceId !== msg.targetId ? this.state.entities.get(msg.sourceId) : undefined;
          const playerPos = this.state.getPlayerPosition();
          this.damageIndicatorUI.addDamage(
            src ? src.renderX : playerPos.x,
            src ? src.renderY : playerPos.y,
            Math.min(1, msg.amount / 50) // Normalize intensity
          );
          // Track damage taken
          this.playerStatsUI.addDamageTaken(msg.amount);
        } else if (msg.sourceId === this.state.playerId) {
          // Track damage dealt
          this.playerStatsUI.addDamageDealt(msg.amount);
          this.playerStatsUI.addShotHit();
        }
        // Your own hull taking it: a thump (impacts on others sound from projectileHit)
        if (msg.targetId === this.state.playerId) {
          this.audio.playUI('hurt', Math.min(1, 0.4 + msg.amount / 40));
          this.audio.bumpCombat(1);
        }
        break;
        
      case 'projectileHit':
        this.renderer.showProjectileHit(msg.id, msg.x, msg.y);
        this.audio.play('hit', msg.x, msg.y, { pitch: 0.85 + Math.random() * 0.3, volume: 0.7 });
        break;
        
      case 'asteroidSpawn':
        this.state.handleAsteroidSpawn(msg.tick, msg.asteroids);
        break;

      case 'asteroidSeed':
        this.state.handleAsteroidSeed(msg.tick, msg.systemId, msg.seed, msg.belt, msg.ids, msg.indices, msg.asteroidField);
        // Feed belt geometry to the system map
        if (msg.belt) {
          this.systemMapUI.setBelt(msg.belt.innerRadius, msg.belt.outerRadius);
        }
        break;

      case 'asteroidDebug':
        this.renderer.showAsteroidDebug(msg.points, msg.durationMs);
        break;
        
      case 'death':
        if (msg.entityId === this.state.playerId) {
          // (The blast itself sounds from the core's partDestroyed message)
          this.renderer.showDeathScreen(msg.killerId !== undefined ? this.state.entities.get(msg.killerId)?.name : undefined);
          this.killFeedUI.addSystemMessage('You were destroyed');
          this.autopilot.cancel();
          this.localDead = true;
          this.social.showRally(true);
        } else {
          this.renderer.showExplosion(msg.entityId);
          // Get dead entity info
          const deadEntity = this.state.entities.get(msg.entityId);
          if (deadEntity) this.audio.play('explosion_large', deadEntity.x, deadEntity.y);
        }
        break;
        
      case 'effect':
        this.renderer.showEffect(msg.effectType, msg.x, msg.y, msg.data, msg.targetX, msg.targetY, msg.entityId);
        break;
        
      case 'systemMessage':
        this.showSystemMessage(msg.text, msg.color);
        break;
        
      case 'chat':
        this.addChatMessage(msg.playerName, msg.text);
        break;
        
      case 'authResult':
        this.handleAuthResult(msg);
        break;
        
      case 'adminStats':
        this.adminPanel?.onStats(msg);
        break;

      case 'adminInfo':
        this.adminPanel?.onInfo(msg);
        break;
      case 'adminAccounts':
        this.adminPanel?.onAccounts(msg);
        break;

      case 'contribRank':
        if (msg.on) this.startContrib(); else this.stopContrib();
        this.addChatMessage('', msg.on ? 'You are a contributor: F6 opens the contributor notes.' : 'Your contributor rank was removed.', true, '#5eead4');
        break;
      case 'contribNotes':
        this.contribPanel?.onNotes(msg.system, msg.notes);
        break;
      case 'contribNote':
        this.contribPanel?.onNote(msg.note);
        break;
      case 'contribNoteGone':
        this.contribPanel?.onGone(msg.id);
        break;
      case 'contribResult':
        this.contribPanel?.onResult(msg.ok, msg.text);
        if (!this.contribPanel?.isOpen) this.addChatMessage('', msg.text, true, msg.ok ? '#9fe0b5' : '#ff9a8a');
        break;

      case 'adminResult':
        this.adminPanel?.onResult(msg.ok, msg.text);
        // Chat commands answer in the chat (the panel may be shut)
        if (!this.adminPanel?.isOpen) this.addChatMessage('', msg.text, true, msg.ok ? '#9fe0b5' : '#ff9a8a');
        break;
    }
  }

  private setupChat(): void {
    if (!this.chatInputEl || !this.chatSendBtn) return;
    
    // Send on Enter key
    this.chatInputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.sendChatMessage();
      }
      // Prevent game input while typing
      e.stopPropagation();
    });
    
    // Track focus state
    this.chatInputEl.addEventListener('focus', () => {
      this.chatFocused = true;
      this.input.setEnabled(false);
    });
    
    this.chatInputEl.addEventListener('blur', () => {
      this.chatFocused = false;
      this.input.setEnabled(true);
    });
    
    // Send button click
    this.chatSendBtn.addEventListener('click', () => this.sendChatMessage());
    
    // Global Enter to focus chat
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !this.chatFocused && !this.menu.isOpen && this.network.isConnected()) {
        e.preventDefault();
        this.chatInputEl?.focus();
      }
    });
  }
  
  private sendChatMessage(): void {
    if (!this.chatInputEl) return;
    const text = this.chatInputEl.value.trim();
    if (!text) return;
    
    this.network.send({ type: 'chat', text });
    this.chatInputEl.value = '';
    this.chatInputEl.blur();
  }
  
  private addChatMessage(playerName: string, text: string, isSystem = false, color?: string): void {
    if (!this.chatMessagesEl) return;
    
    const msgEl = document.createElement('div');
    msgEl.className = 'chat-message' + (isSystem ? ' system' : '');
    
    if (isSystem) {
      msgEl.textContent = text;
      msgEl.style.whiteSpace = 'pre-wrap';
      if (color) msgEl.style.color = color;
    } else {
      msgEl.innerHTML = `<span class="player-name">${this.escapeHtml(playerName)}:</span> <span class="message-text">${this.escapeHtml(text)}</span>`;
    }
    
    this.chatMessagesEl.appendChild(msgEl);
    this.chatMessagesEl.scrollTop = this.chatMessagesEl.scrollHeight;
    
    // Limit chat history to 100 messages
    while (this.chatMessagesEl.children.length > 100) {
      this.chatMessagesEl.removeChild(this.chatMessagesEl.firstChild!);
    }
  }
  
  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  private onConnected(): void {
    console.log('Connected to server');
    // (proto mode skips the server list)
    this.prefetchScreens();
    this.clearLoadingClick();
    if (this.loadingEl) this.loadingEl.style.display = 'none';
    // The sign-in backdrop has done its job: free its renderer (it's rebuilt if the sign-in screen comes back)
    this.loginUI.releaseBackdrop();
    
    // Show all HUD elements
    if (this.topHudEl) this.topHudEl.style.display = 'flex';
if (this.xpHudEl) this.xpHudEl.style.display = 'flex';
if (this.boostHudEl) this.boostHudEl.style.display = 'flex';
    this.pilotHud.show();
    this.shipClient.setInGame(true);
    this.quests.show();
    this.quickBar.show();
    this.social.show();
    this.perfMonitor?.setVisible(settings.data.ui.netStats);
    
    // Send join/auth message based on pending auth state
    // (Each carries our protocol version: a server on another one hangs up with PROTOCOL_MISMATCH_CLOSE)
    const pending = this.pendingAuth;
    if (pending) {
      // Guest
      this.network.send({ type: 'join', username: pending.username, protocol: PROTOCOL_VERSION });
      this.pendingAuth = null;
    } else if (this.authToken) {
      // Signed in at the lobby: the server checks the token with it
      this.network.send({ type: 'join', token: this.authToken, username: this.state.playerName, protocol: PROTOCOL_VERSION });
    } else {
      // Fallback guest
      this.network.send({ type: 'join', username: this.state.playerName || 'Player', protocol: PROTOCOL_VERSION });
    }
    
    // Start ping loop (one per connection: a reconnect replaces it)
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      this.network.send({
        type: 'ping',
        clientTime: Date.now(),
      });
    }, 2000);
  }

  private onDisconnected(info?: DisconnectInfo): void {
    console.log('Disconnected from server', info ?? '');
    this.loggedIn = false;
    
    if (info?.code === PROTOCOL_MISMATCH_CLOSE || this.versionMismatch) {
      // A new version is out (or this one is newer than the server): only a reload helps
      this.versionMismatch = true;
      this.network.disconnect();
      this.showVersionOverlay();
      if (this.loadingEl) this.loadingEl.style.display = 'none';
    } else if (this.authFailed) {
      if (this.loadingEl) this.loadingEl.style.display = 'none';
    } else if (this.loadingEl) {
      const el = this.loadingEl;
      el.style.display = 'block';
      el.style.cursor = 'pointer';
      el.textContent = info?.retrying
        ? `Connection lost. Reconnecting in ${Math.round((info.retryInMs ?? 0) / 1000)}s (attempt ${info.attempt}/${info.maxAttempts})... Click to pick a server instead.`
        : 'Disconnected. Click to reconnect.';
      el.onclick = () => {
        this.clearLoadingClick();
        el.style.display = 'none';
        // The player takes over: no reconnect is still going to land behind the server browser
        this.network.disconnect();
        // Show server browser to pick a new server (keep username)
        if (this.state.playerName) {
          this.serverBrowserUI.show();
        } else {
          this.loginUI.show();
        }
      };
    }
    // Hide all HUD elements on disconnect
    if (this.topHudEl) this.topHudEl.style.display = 'none';
if (this.xpHudEl) this.xpHudEl.style.display = 'none';
if (this.boostHudEl) this.boostHudEl.style.display = 'none';
    this.pilotHud.hide();
    this.shipClient.setInGame(false);
    this.quests.hide();
    this.dialogue.hide();
    this.quickBar.hide();
    this.social.hide();
    this.quests.log.close();
    this.inventoryWindow.close();
  }

  private handleAuthResult(msg: { success: boolean; username?: string; token?: string; isAdmin?: boolean; isContributor?: boolean; error?: string }): void {
    if (msg.success) {
      console.log(`Authenticated as ${msg.username}${msg.isAdmin ? ' (admin)' : ''}`);
      if (msg.username) this.state.playerName = msg.username;
      if (msg.token) {
        this.authToken = msg.token;
        // Save token for reconnection
        try { localStorage.setItem('authToken', msg.token); } catch (e) {}
      }
      this.isAdmin = !!msg.isAdmin;
      // Map warp (Ctrl-click) is an admin tool: the server refuses it for anyone else, so only admins see it offered
      this.systemMapUI.onWarp = this.isAdmin ? (systemId, x, y) => this.network.send({ type: 'devTeleport', systemId, x, y }) : null;
      
      if (this.isAdmin) this.startAdmin();
      else this.stopAdmin();
      if (msg.isContributor || this.isAdmin) this.startContrib();
      else this.stopContrib();
    } else {
      // Wrong password or a refused registration: back to the sign-in screen with the reason
      // (the server hangs up too, so no nameless pilot is left in the world)
      console.warn('Auth failed:', msg.error);
      this.authFailed = true;
      this.stopAdmin();
      this.stopContrib();
      this.network.disconnect();
      this.onDisconnected();
      this.serverBrowserUI.hide();
      this.state.playerName = '';
      // The token was refused (expired, signed out elsewhere): forget it (unless another tab has signed in since: tabs share storage)
      try { if (!this.authToken || localStorage.getItem('authToken') === this.authToken) localStorage.removeItem('authToken'); } catch { /* storage unavailable */ }
      this.authToken = null;
      this.loginUI.setLoading(false);
      this.loginUI.show();
      this.loginUI.showError(msg.error || 'Sign-in failed');
    }
  }

  private clearLoadingClick(): void {
    if (!this.loadingEl) return;
    this.loadingEl.onclick = null;
    this.loadingEl.style.cursor = 'default';
  }

  /** The server speaks another protocol version: say so and offer a reload (no reconnecting) */
  private showVersionOverlay(): void {
    if (document.getElementById('version-overlay')) return;
    const el = document.createElement('div');
    el.id = 'version-overlay';
    el.style.cssText = `position: fixed; inset: 0; z-index: 100000; display: flex; align-items: center; justify-content: center;
      background: rgba(2, 6, 18, 0.88); font-family: 'Segoe UI', sans-serif; color: #e2e8f0;`;
    el.innerHTML = `<div style="text-align:center; padding:28px 36px; border:1px solid rgba(148,163,184,0.3); border-radius:10px; background:rgba(15,23,42,0.95); max-width:360px">
      <div style="font-size:18px; font-weight:700; letter-spacing:1px; margin-bottom:8px">A new version is out</div>
      <div style="font-size:13px; color:#94a3b8; margin-bottom:18px">This page is older (or newer) than the server. Reload to get the current version.</div>
      <button style="font:600 14px 'Segoe UI', sans-serif; padding:8px 26px; border-radius:6px; border:none; background:#38bdf8; color:#04121f; cursor:pointer">Reload</button>
    </div>`;
    el.querySelector('button')!.addEventListener('click', () => location.reload());
    document.body.appendChild(el);
  }

  /** The last sign-in was refused (the disconnect that follows isn't a dropped connection) */
  private authFailed = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  /** The admin panel (admins only; F2 opens it) */
  private adminPanel: AdminPanel | null = null;

  /** Its chunk is on its way (split out of the main chunk: only admins fetch it) */
  private adminLoading = false;

  private startAdmin(): void {
    if (this.adminPanel || this.adminLoading) return;
    this.adminLoading = true;
    void import('./ui/AdminPanel').then(({ AdminPanel }) => {
      this.adminLoading = false;
      // (signed out while it loaded)
      if (this.adminPanel || !this.isAdmin) return;
      this.adminPanel = new AdminPanel({
        send: (m) => this.network.send(m),
        state: this.state,
        econ: this.pilot.econ,
        cursorWorld: () => this.renderer.screenToWorld(this.input.mouseX, this.input.mouseY),
        screenToWorld: (x, y) => this.renderer.screenToWorld(x, y),
        setCamera: (t) => this.renderer.setCameraTarget(t),
        zoom: () => this.input.zoom,
        isKeyDown: (c) => this.input.isKeyDown(c),
        clientStats: () => {
          const s = this.state;
          return `<b>Prediction</b><span>${s.predErrorPre.toFixed(1)}px before · ${s.predErrorPost.toFixed(1)}px after (avg ${s.predErrorPreAvg.toFixed(1)})</span>
            <b>Snaps</b><span>${s.predSnapCount}</span><b>Pending</b><span>${s.predPendingCount} inputs</span>
            <b>Input delay</b><span>${s.inputDelayTicks} ticks (${(s.inputDelayTicks * 16.67).toFixed(0)} ms)</span>`;
        },
      });
      this.addChatMessage('', 'Admin: F2 opens the admin panel, F3 teleports to the cursor, F4 frees the camera. /help lists the chat commands.', true, '#ff8a6a');
    }, (e) => { this.adminLoading = false; console.error('Admin panel failed to load:', e); });
  }

  private stopAdmin(): void {
    this.adminPanel?.destroy();
    this.adminPanel = null;
    this.isAdmin = false;
  }

  /** Contributor notes (contributors and admins; F6) */
  private contribPanel: ContributorPanel | null = null;
  /** Started and not stopped since (its chunk loads first: only contributors fetch it) */
  private contribWanted = false;

  private startContrib(): void {
    if (this.contribPanel || this.proto) return;
    this.contribWanted = true;
    void import('./ui/ContributorPanel').then(({ ContributorPanel }) => {
      if (this.contribPanel || !this.contribWanted) return;
      this.contribPanel = new ContributorPanel({
        send: (m) => this.network.send(m),
        state: this.state,
        me: () => this.state.playerName,
        isAdmin: () => this.isAdmin,
        screenToWorld: (x, y) => this.renderer.screenToWorld(x, y),
        worldToScreen: (x, y) => this.renderer.worldToScreen(x, y),
        zoom: () => this.renderer.getZoom(),
        map: this.systemMapUI,
        flyTo: (d) => this.flyTo(d),
        setCamera: (t) => this.renderer.setCameraTarget(t),
        warp: (systemId, x, y) => this.network.send({ type: 'devTeleport', systemId, x, y }),
      });
    }, (e) => console.error('Contributor panel failed to load:', e));
  }

  private stopContrib(): void {
    this.contribWanted = false;
    this.contribPanel?.destroy();
    this.contribPanel = null;
  }

  /** The credits figure last written to the HUD */
  private creditsShown = -1;

  private updateUI(): void {
    this.adminPanel?.update();
    this.contribPanel?.update();
    
// Boost Bar (vertical)
    if (this.boostFillEl) {
      const boostPercent = (this.state.boostFuel / this.state.maxBoostFuel) * 100;
      setStyle(this.boostFillEl, 'height', `${boostPercent.toFixed(1)}%`);
    }
    // (and each circuit's, flashing while one browns out: ui/CircuitBars.ts)
    this.circuitBars?.update(this.shipClient?.myShip()?.derived, this.state.charge);
    
    // XP bar: progress through the current level (from the pilot's profile)
    const prof = this.pilot.profile;
    const into = prof ? prof.xp - prof.xpLevel : 0;
    const span = prof ? Math.max(1, prof.xpNext - prof.xpLevel) : 100;
    // (Each only when it changes: see domWrite)
    setStyle(this.xpFillEl, 'width', `${Math.min(100, (into / span) * 100).toFixed(1)}%`);
    setText(this.levelEl, String(prof?.level ?? this.state.level));
    const lvl = prof?.level ?? this.state.level;
    if (prof && this.xpSeen) {
      if (lvl > this.xpSeen.level) { this.replayClass(this.xpBarEl, 'lvl'); this.replayClass(this.levelEl?.parentElement, 'lvl'); }
      else if (into > this.xpSeen.into) this.replayClass(this.xpBarEl, 'gain');
    }
    if (prof) this.xpSeen = { level: lvl, into };
    setText(this.xpEl, String(into));
    setText(this.xpToNextEl, String(span));
    // (Formatted only when it changes: toLocaleString is slow to run every frame)
    if (this.state.credits !== this.creditsShown) { this.creditsShown = this.state.credits; setText(this.creditsEl, this.state.credits.toLocaleString()); }
    setText(this.systemInfoEl, this.systemNames.get(this.state.systemId) ?? this.state.systemId ?? 'Unknown System');
  }

  /** Restart a one-shot CSS animation (remove the class, reflow, add it back) */
  private replayClass(el: Element | null | undefined, cls: string): void {
    if (!el) return;
    el.classList.remove('gain', 'lvl');
    void (el as HTMLElement).offsetWidth;
    el.classList.add(cls);
  }

  /** The server's notices (party, travel, announcements) go in the chat */
  private showSystemMessage(text: string, color?: string): void {
    this.addChatMessage('', text, true, color);
  }

  /**
   * Pixels per CSS pixel to render at: the screen's density, but no more than 2
   * (nobody can see past that, and 3× screens would cost over twice the GPU work),
   * times the Render resolution setting.
   */
  private renderResolution(): number {
    // (the sign-in screen: one body on an idle screen, at the screen's own density whatever the tier)
    if (this.loginUI?.isVisible()) return Math.min(2, window.devicePixelRatio || 1);
    return Math.min(PROFILES[this.qualityTier()].maxDpr, window.devicePixelRatio || 1) * Math.max(0.5, Math.min(1, settings.data.display.renderScale));
  }

  /** The tier in force: the setting, or (Auto) what Auto has settled on */
  private qualityTier(): QualityTier {
    const q = settings.data.display.quality;
    return q === 'auto' ? this.autoQuality.tier : q;
  }

  /** Hand the tier's settings to the renderer, and resize if its pixel density changed */
  private applyQuality(): void {
    const q = PROFILES[this.qualityTier()];
    this.renderer.setQuality(q);
    this.frost.setQuality(q);
    this.shipClient.setQuality(q);
    this.systemMapUI?.setRedrawEvery(q.mapEvery);
    this.hudEvery = q.hudEvery;
    const res = this.renderResolution();
    if (Math.abs(this.app.renderer.resolution - res) > 1e-3) this.onResize();
  }

  private onResize(): void {
    this.refreshWorld = true;
    this.app.renderer.resize(window.innerWidth, window.innerHeight, this.renderResolution());
    this.renderer.onResize();
  }
}
