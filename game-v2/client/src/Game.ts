/**
 * Game - Main client orchestrator
 */

import { ChatPanel } from './ui/ChatPanel';
import { buildWindows, type WindowHost, type WindowSet } from './app/windows';
import { prefetchScreens } from './app/lazyScreens';
import { installDevTools } from './app/devTools';
import { Prediction } from './predict/Prediction';
import { handleKey, type KeyHost } from './app/keys';
import { handleServerMessage as handleServerMessageTable, type MessageHost } from './app/serverMessages';
import { tickInput, sendNeutralInput, newInputSendState, type InputSendCtx } from './app/inputSend';
import { lobbyAuth, LobbyAuthResult } from './network/lobby';
import { lobbyInbox } from './network/inbox';
import { setText, setStyle } from './ui/domWrite';
import { Application, Text } from 'pixi.js';
import { NetworkManager } from './network/NetworkManager';
import { InputManager } from './input/InputManager';
import { Renderer } from './rendering/Renderer';
import { noseUpAngle } from './rendering/cameraView';
import { viewMode } from './input/viewMode';
import { AimPin, AimPinView } from './input/aimPin';
import { attachShaderWarmup, warmShaders } from './rendering/shaderWarmup';
import { gameShaders } from './rendering/gameShaders';
import { GameState } from './state/GameState';



import { RegionUI } from './ui/RegionUI';
import { MusicPlaceTracker } from './audio/musicPlace';
import { TimeScaleBadge } from './ui/TimeScaleBadge';

import { PilotState, createClientEconomy } from './econ/clientEcon';
import { LoginUI } from './ui/LoginUI';
import { ServerBrowserUI, ServerInfo } from './ui/ServerBrowserUI';
import { AudioManager, type BeamSource } from './audio/AudioManager';
import { beamLightSound, beamLoopFor, hasOwnShotSound } from './audio/weaponSounds';

import { PerfMonitor } from './ui/PerfMonitor';


import { GameMenuUI } from './ui/GameMenuUI';
import { settings, SettingsData } from './settings/Settings';
import { AutoQuality, PROFILES, type QualityTier } from './settings/quality';
import { ACTIONS, boundKeyName } from './input/keybindings';
import systemsDataForMenu from '../../data/systems.json';

import { DamageIndicatorUI } from './ui/DamageIndicatorUI';
import { FloatingRewardsUI } from './ui/FloatingRewardsUI';
import { ShipClient } from './ships/ShipClient';
import type { AdminPanel } from './ui/AdminPanel';
import type { ContributorPanel } from './ui/ContributorPanel';

import { BankBars } from './ui/BankBars';
import { WeaponRing } from './ui/WeaponRing';
import { ObjectiveBanner } from './ui/ObjectiveBanner';
import { SiegePanel } from './ui/SiegePanel';
import { moonOffset, planetPosition, pocketAt, inSafeSpace, type StarSystemData } from '@space-game/common';
import { AutoDest } from './ships/Autopilot';
import { HazardOverlay } from './ui/HazardOverlay';
import { FrostVignette } from './ui/FrostVignette';
import shipPieces from '../../data/ships/pieces.json';
import shipFunctions from '../../data/ships/functions.json';
import shipMaterials from '../../data/ships/materials.json';
import shipModels from '../../data/ships/models.json';
import shipTuning from '../../data/ships/tuning.json';
import miningTable from '../../data/mining.json';
import { TICK_RATE, TICK_MS, xpToReach } from '@space-game/common';
import { itemIcon } from './ui/itemIcons';
import { LoadingFlow } from './app/loadingFlow';
import { ServerMessage, asteroidComposition, MiningTable, registerRockTypes, EntityType, computeStateHash, ClientTransport, loadCatalog, ShipTuning, InventoryStub, QuestTarget, DisconnectInfo, PROTOCOL_VERSION, PROTOCOL_MISMATCH_CLOSE, DEFAULT_CAPS } from '@space-game/common';

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
  private readonly keyHost: KeyHost = this.makeKeyHost();
  private readonly msgHost: MessageHost = this.makeMessageHost();
  private readonly inputCtx: InputSendCtx = this.makeInputCtx();
  private readonly windowHost: WindowHost = this.makeWindowHost();
  /** Every window and HUD component (built in init; see app/windows.ts) */
  private w = {} as WindowSet;
  private shipClient: ShipClient;
  /** Other ships predicted on the PT layer (predict/Prediction.ts: C3); null in proto */
  private prediction: Prediction | null = null;
  /** The time-scale badge: the system slowed in a crowd (CAPS.CROWD) */
  private timeBadge: TimeScaleBadge | null = typeof document !== 'undefined' ? new TimeScaleBadge() : null;
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
  private get stationOpen(): boolean {
    return this.w.stationWindow?.value?.isOpen ?? false;
  }
  /** The pilot's progress, cargo and storage as the server reports them */
  readonly pilot: PilotState;
  /** The danger band you're in (a banner as you cross), and the card for a gate you're near */
  private regionUI = new RegionUI();
  /** Where you are, for the music (its areas, with edge margins) */
  private musicPlace = new MusicPlaceTracker();
  /** Raids and wrecks in this system (marked on screen) */
  private worldEvents = new Map<number, { name: string; x: number; y: number; system: string }>();
  /** Kills (and assists) this session, for the tutorial */
  private sessionKills = 0;
  /** Your last ship's wreck, kept for you a while (wall ms): marked until you recover it */
  private wreck: { system: string; x: number; y: number; until: number } | null = null;
  /** Objective banners (a city under siege) */
  private objectives = new ObjectiveBanner();
  /** A moon siege's panel (and its night HUD and cards) */
  private siegePanel = new SiegePanel((m) => this.network.send(m), {
    tick: () => this.state.getRawServerTick(),
    target: () => this.w?.targetUI.target ?? 0,
    me: () => { const e = this.state.entities.get(this.state.playerId); return e ? { x: e.renderX, y: e.renderY } : null; },
    bastion: () => this.currentSystem()?.surface?.bastion ?? null,
    focusKey: () => boundKeyName('siegeFocus', settings.data.bindings),
  });
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
  /** The loading screen from choosing a server (and on arriving elsewhere, or respawning) until the world is in sync (none in proto) */
  private loading: LoadingFlow | null = null;
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
  /** Each bank's charge beside the ENERGY gauge (circuits.ts banks) */
  private bankBars: BankBars | null = null;
  /** The weapon ring round the cursor (ui/WeaponRing.ts) */
  private weaponRing: WeaponRing | null = null;
  /** Mouse-steer with the view on the heading: the aim pinned in the world, and its drawn cursor (input/aimPin.ts) */
  private aimPinView: AimPinView | null = null;
  private levelEl: HTMLElement | null;
  private xpEl: HTMLElement | null;
  private xpToNextEl: HTMLElement | null;
  private creditsEl: HTMLElement | null;
  private systemInfoEl: HTMLElement | null;

  // Chat elements
  /** The chat box: channel toggles, lines, the input and its private-message mode (ui/ChatPanel.ts) */
  private chat: ChatPanel;
  private chatFocused = false;
  
  private lastStateHashTime = 0;

  // Tick-based input system
  private inputTickAccum = 0;         // ms accumulator for fixed-rate input ticks
  /** Extra camera zoom factor while jumping */
  private jumpZoom = 1;

  // Auth state
  private authToken: string | null = null;
  private isAdmin = false;
  /** The owner rank (above admin: isAdmin is true too) */
  private isOwner = false;
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
      onDocked: () => this.w.stationWindow.use((w) => w.open()),
      stationOpen: () => this.stationOpen,
      onHangarBackToStation: () => this.w.stationWindow.use((w) => w.showAgain()),
      miningHeld: () => this.rightHeld() && !this.menu?.isOpen,
      tuning: shipTuningData,
      state: this.state,
      send: (msg) => this.network.send(msg),
      showMessage: (text, color) => this.showSystemMessage(text, color),
      toast: (text, kind) => this.w.toasts?.show(text, kind),
      localAim: () => this.localAim(),
      isKeyDown: (code) => this.input.isKeyDown(code),
      inputEnabled: () => !this.menu?.isOpen,
      noseThrust: () => !!this.inputCtx?.noseThrust,
      sound: (id, at, volume, pitch) => (at ? this.audio.play(id, at.x, at.y, { volume, pitch }) : this.audio.playUI(id, volume, pitch)),
      editAnywhere: options.ships?.editAnywhere,
      onHangarOpen: options.ships?.onHangarOpen,
      onHangarClose: options.ships?.onHangarClose,
    });
    this.state.chargeTotal = (charge) => this.shipClient.chargeTotal(charge);
    // Every other ship moves by replication (proto writes its state straight in instead)
    if (!this.proto) {
      this.state.preSnapshot = (m) => this.shipClient.preSnapshot(m);
      this.state.onReplication = (m) => this.shipClient.onReplication(m);
      // (Your own ship: on its tick layer, stepped once a tick to the prediction's and drawn from there)
      this.state.ownStep = (t) => this.shipClient.ownStepTo(t);
      this.state.ownPose = (t) => this.shipClient.ownPose(t);
      this.state.replicaPose = (e, t) => this.shipClient.placeReplica(e, t);
      // (Every other ship on the PT layer at your tick, drawn by the prediction's hook: C3)
      this.prediction = new Prediction(this.state, this.shipClient, () => this.renderer ?? null);
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
    this.bankBars = new BankBars();
    this.weaponRing = new WeaponRing();
    this.levelEl = document.getElementById('level');
    this.xpEl = document.getElementById('xp');
    this.xpToNextEl = document.getElementById('xpToNext');
    this.creditsEl = document.getElementById('credits');
    this.systemInfoEl = document.getElementById('systemInfo');

    // Chat
    this.chat = new ChatPanel({
      send: (m) => this.network.send(m),
      setGameInput: (on) => this.input.setEnabled(on),
      canFocus: () => !this.menu.isOpen && this.network.isConnected(),
      ensureShown: () => { if (!settings.data.ui.chat) settings.update((d) => { d.ui.chat = true; }); },
      onFocusChange: (f) => { this.chatFocused = f; },
      openFriends: () => this.w.social.openWindow('friends'),
      sound: (id, v) => this.audio.playUI(id, v ?? 0.5),
    });

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
    // Render tuning (F8) and ship swap (F9): dev server only (app/devTools.ts)
    installDevTools(this.windowHost);
    
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
    this.w = buildWindows(this.windowHost, uiOverlay);
    this.createMenu();
    settings.subscribe((s) => this.applySettings(s));
    window.addEventListener('blur', () => { this.windowFocused = false; this.applyVolume(settings.data); });
    window.addEventListener('focus', () => { this.windowFocused = true; this.applyVolume(settings.data); });
    this.damageIndicatorUI = new DamageIndicatorUI(uiOverlay);
    if (!this.proto) {
      const g = this;
      // (On the body: over the HUD, which sits outside the overlay's stacking)
      this.loading = new LoadingFlow(document.body, {
        state: this.state, renderer: this.renderer, shipClient: this.shipClient,
        connected: () => g.network.isConnected(), loggedIn: () => g.loggedIn, systemName: (id) => g.systemNames.get(id),
      });
    }
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
    // (Client-detected hits: a frame's hits go out once the whole frame is in, ships/hits/SelfHits.ts)
    this.network.onFrameEnd = () => this.shipClient.frameEnd((m) => this.handleServerMessage(m));
    this.network.onConnect = () => this.onConnected();
    this.network.onDisconnect = (info) => this.onDisconnected(info);

    // Set up input handlers
    this.input.init(this.app.canvas as HTMLCanvasElement);
    this.input.pin = new AimPin(() => this.renderer.screenSize(), () => this.renderer.getCameraAngle());
    this.aimPinView = new AimPinView(this.app.canvas as HTMLCanvasElement, this.input.pin,
      () => ({ x: this.input.mouseX, y: this.input.mouseY, rawX: this.input.rawX, rawY: this.input.rawY }));
    this.input.onFocusLost = () => { this.w.context.resetPress(); sendNeutralInput(this.inputCtx); };
    this.input.onMouseButton = (button, down, x, y) => this.w.context.mouse(button, down, x, y);
    this.w.context.attach(this.app.canvas as HTMLCanvasElement);
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
    prefetchScreens(this.windowHost, this.w);
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
    this.serverBrowserUI.show({ token: r.token, username: r.username ?? '', isAdmin: !!r.isAdmin });
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
    if (this.loadingEl) this.loadingEl.style.display = 'none';
    this.loading?.begin('join', server.name);
    
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
    this.serverBrowserUI.inbox.setAccount(null);
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
      openMap: () => this.w.systemMapUI.toggle(),
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
          owner: this.isOwner,
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
      replayTutorial: () => this.w.tutorial.restart(),
      threats: () => this.state.threats,
      myRating: () => this.shipClient.myRating(),
      level: () => this.pilot.profile?.level ?? this.state.level,
      xp: () => this.pilot.profile?.xp ?? this.state.xp,
      icon: (id) => itemIcon(this.pilot.econ, id),
      openComponents: () => this.w.componentGuide.use((g) => g.open()),
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
    // (One sound a gun's volley: a fan of shells from one ship in one frame is heard once, so a pack can't machine-gun a sample)
    const volleys = this.volleysHeard;
    volleys.clear();
    alive.clear();
    for (const e of this.state.entities.ofType(EntityType.Projectile)) {
      alive.add(e.id);
      if (this.heard.has(e.id)) continue;
      this.heard.add(e.id);
      if (settled && shots < 4) {
        // Its gun's model, known from its fire event (no wire bytes: ShipClient.shellInfo), has its own sound; else the
        // kind's, by data[0] (the weapon type) and data[8] (fired by a turret)
        const wt = e.data?.[0] ?? 1;
        const model = this.shipClient.shellInfo(e)?.model;
        const id = this.audio.shotSound(model, wt, e.data?.[8] === 1);
        const volley = `${e.data?.[6] ?? -1}:${id}`;
        if (volleys.has(volley)) continue;
        volleys.add(volley);
        shots++;
        // (A cannon heard by its kind's sound: data[1], its grade, nudges the pitch, heavier marks deeper)
        const pitch = wt === 1 && !hasOwnShotSound(model) ? CANNON_GRADE_PITCH[Math.max(0, Math.min(4, (e.data?.[1] ?? 1) - 1))] : 1;
        if (id) this.audio.play(id, e.spawnX ?? e.x, e.spawnY ?? e.y, { volume: 0.8, pitch });
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
    this.beamSounds(flying);

    if (this.shipClient.horizonDanger() > 0.35 && now - this.lastAlarm > 900) {
      this.lastAlarm = now;
      this.audio.playUI('warning', 0.6);
    }
    // The music follows the system, the area you're in, docking, a boss's arena or fight (audio/musicPlace.ts)
    this.audio.setMusicPlace(this.musicPlace.update({
      systemId: this.state.systemId || 'sol', sys: this.currentSystem(), x: me?.renderX, y: me?.renderY,
      tick: this.state.getRawServerTick(), docked: this.stationOpen, boss: this.w.bossUI.bossId,
    }), now);
    // Nearing a boss's lair (a surface's or pocket's dread point), the music turns ominous
    const dread = this.currentSystem()?.surface?.dread ?? this.currentSystem()?.pocket?.dread;
    const d = dread && me ? Math.hypot(me.renderX - dread.x, me.renderY - dread.y) : Infinity;
    this.audio.setDread(dread ? Math.max(0, Math.min(1, (dread.from - d) / Math.max(1, dread.from - dread.full))) : 0);
    this.updateZone();
    this.objectives.update(this.state.systemId);
    const wayIn = flying ? this.pocketWayIn() : null;
    this.shipClient.setPlanetHint(wayIn ?? (flying ? this.planetBelow() : null), wayIn ? 'Enter' : undefined);
  }

  /** This frame's shot sounds, by owner and sound (updateSounds) */
  private readonly volleysHeard = new Set<string>();
  /** Held beams lit last frame (ship * 256 + part), so a beam lighting is heard once */
  private beamsLit = new Set<number>();
  private beamsNow = new Set<number>();
  private readonly beamSources: BeamSource[] = [];

  /**
   * Held beams, every ship's, heard as they're drawn (MiningBeamFx.litBeams): each its model's loop (weaponSounds
   * beamLoopFor), and as one lights its model's ignition, if it has one (the Lance's)
   */
  private beamSounds(flying: boolean): void {
    const src = this.beamSources, now = this.beamsNow;
    src.length = 0;
    now.clear();
    if (flying) {
      for (const b of this.shipClient.litBeams()) {
        const key = b.owner * 256 + b.part;
        now.add(key);
        const loop = beamLoopFor(b.model, b.kind);
        if (loop) src.push({ loop, x: b.x, y: b.y, own: b.own });
        if (this.beamsLit.has(key)) continue;
        const light = beamLightSound(b.model);
        if (light) { if (b.own) this.audio.playUI(light, 0.6); else this.audio.play(light, b.x, b.y, { volume: 0.8 }); }
      }
    }
    this.audio.setBeams(src);
    this.beamsNow = this.beamsLit;
    this.beamsLit = now;
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
      locked: (id: string) => this.w.systemMapUI.locked?.(id) ?? null, interactKey: boundKeyName('interact', settings.data.bindings),
    };
    const region = this.regionUI.current(ctx);
    this.regionUI.update(ctx);
    this.w.pilotHud.setZone(sys.name.replace(/ System$/, ''), sys.danger ?? 1, !!sys.pvp, safe, ring, region ?? undefined);
    // (Against the band you're in, where a system has them)
    this.w.pilotHud.setRating(rating, (region && this.state.regionThreats[sys.id]?.[region.id]) || this.state.threats[sys.id]);
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
    if (this.w.navMarkers) this.w.navMarkers.enabled = s.ui.navMarkers;
    if (this.loggedIn) {
      this.perfMonitor?.setVisible(s.ui.netStats);
    }
    const chat = document.getElementById('chatBox');
    if (chat) {
      chat.style.visibility = s.ui.chat ? 'visible' : 'hidden';
      chat.classList.toggle('chat-hidden', !s.ui.chat);
    }
    this.input.invertZoom = s.gameplay.invertZoom;
    this.input.zoomSpeedScale = s.gameplay.zoomSpeed;
    this.input.setBindings(ACTIONS.filter((a) => a.rebindable !== false).map((a) => ({ defaultCode: a.key, code: s.bindings[a.id] ?? a.key })));
  }

  private heatEl: HTMLDivElement | null = null;
  private heatText: HTMLElement | null = null;
  private heatFill: HTMLElement | null = null;

  /** Charge guns' charge (Longbarrel, Blackout) and pulse lasers' charge to their next pulse: a thin bar over the jump gauge while they charge (no heat: rework 2026-11) */
  private updateHeatGauge(): void {
    if (!this.heatEl) {
      this.heatEl = document.createElement('div');
      this.heatEl.style.cssText = `position: fixed; left: 50%; bottom: 150px; transform: translateX(-50%); width: 240px; z-index: 860; pointer-events: none;
        font: 700 10px 'Segoe UI', sans-serif; letter-spacing: 2px; text-align: center; display: none;`;
      this.heatEl.innerHTML = '<div data-k="t"></div><div style="height:4px; border-radius:2px; background:rgba(255,255,255,0.08); margin-top:3px; overflow:hidden"><i data-k="f" style="display:block; height:100%; transition: width .1s"></i></div>';
      document.body.appendChild(this.heatEl);
      this.heatText = this.heatEl.querySelector('[data-k="t"]') as HTMLElement;
      this.heatFill = this.heatEl.querySelector('[data-k="f"]') as HTMLElement;
    }
    // (A charge gun's charge is on the weapon ring round the cursor: ui/WeaponRing.ts)
    const laser = this.shipClient.laserCharge();
    const charging = !!laser && laser.charge < 0.999;
    const show = this.loggedIn && !this.shipClient.hangarOpen && charging;
    setStyle(this.heatEl, 'display', show ? 'block' : 'none');
    if (!show) return;
    if (laser) {
      // Pulse lasers: the charge to their next pulse
      setText(this.heatText, laser.total > 1 ? `LASERS CHARGING · ${laser.ready}/${laser.total} READY` : 'LASER CHARGING');
      setStyle(this.heatText, 'color', '#fecaca');
      setStyle(this.heatFill, 'width', `${Math.round(laser.charge * 100)}%`);
      setStyle(this.heatFill, 'background', 'linear-gradient(90deg,#7f1d1d,#f87171,#ffe4e4)');
    }
  }

  private applyVolume(s: SettingsData): void {
    const muted = s.audio.muteUnfocused && !this.windowFocused;
    this.audio.setMasterVolume(muted ? 0 : s.audio.master);
    this.audio.setSFXVolume(s.audio.sfx);
    this.audio.setMusicVolume(s.audio.music);
  }

  private handleKeyPress(code: string): void {
    handleKey(this.keyHost, code);
  }

  /** What keys.ts reads (getters, so windows built late resolve at use; made once) */
  private makeWindowHost(): WindowHost {
    const g = this;
    return {
      get state() { return g.state; },
      get pilot() { return g.pilot; },
      get network() { return g.network; },
      get audio() { return g.audio; },
      get shipClient() { return g.shipClient; },
      get prediction() { return g.prediction; },
      get renderer() { return g.renderer; },
      get input() { return g.input; },
      get proto() { return g.proto; },
      get regionUI() { return g.regionUI; },
      get objectives() { return g.objectives; },
      get worldEvents() { return g.worldEvents; },
      get wreck() { return g.wreck; },
      get sessionKills() { return g.sessionKills; },
      get loggedIn() { return g.loggedIn; },
      get localDead() { return g.localDead; },
      get jumpZoom() { return g.jumpZoom; },
      get stationOpen() { return g.stationOpen; },
      get menu() { return g.menu; },
      get adminPanel() { return g.adminPanel; },
      objective: () => g.objective(),
      flyTo: (d, note) => g.flyTo(d, note),
      showSystemMessage: (text, color) => g.showSystemMessage(text, color),
      currentSystem: () => g.currentSystem(),
      planetBelow: () => g.planetBelow(),
      wreckMarker: () => g.wreckMarker(),
      siegeMarkers: () => g.siegePanel.markers().map((m) => ({ ...m, system: g.state.systemId })),
      toggleAutopilotToObjective: () => g.toggleAutopilotToObjective(),
      chatTo: (name) => g.chat.messageTo(name),
      friendsOnline: (n) => g.chat.setFriendsOnline(n),
    };
  }

  private makeKeyHost(): KeyHost {
    const g = this;
    return {
      get loggedIn() { return g.loggedIn; },
      get stationOpen() { return g.stationOpen; },
      get proto() { return g.proto; },
      get menu() { return g.menu; },
      get dialogue() { return g.w.dialogue; },
      get componentGuide() { return g.w.componentGuide; },
      get inventoryWindow() { return g.w.inventoryWindow; },
      get tradeWindow() { return g.w.tradeWindow; },
      get social() { return g.w.social; },
      get quests() { return g.w.quests; },
      get stationWindow() { return g.w.stationWindow; },
      get shipClient() { return g.shipClient; },
      get autopilot() { return g.w.autopilot; },
      get context() { return g.w.context; },
      get quickBar() { return g.w.quickBar; },
      get infoPanel() { return g.w.infoPanel; },
      get pingUI() { return g.w.pingUI; },
      get targetUI() { return g.w.targetUI; },
      get playerStatsUI() { return g.w.playerStatsUI; },
      get systemMapUI() { return g.w.systemMapUI; },
      get navMarkers() { return g.w.navMarkers; },
      get siegePanel() { return g.siegePanel; },
      get regionUI() { return g.regionUI; },
      get audio() { return g.audio; },
      get network() { return g.network; },
      get input() { return g.input; },
      get renderer() { return g.renderer; },
      toggleAutopilotToObjective: () => g.toggleAutopilotToObjective(),
      showSystemMessage: (text, color) => g.showSystemMessage(text, color),
    };
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
    const t = this.w.quests.objective();
    const q = this.w.quests.current();
    const op = q && this.w.opsUI?.ops.find((o) => o.quest === q.id);
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
    const on = settings.data.ui.questGuide && this.loggedIn && !this.shipClient.hangarOpen && !this.w.systemMapUI.isOpen && !this.menu.isOpen;
    const wp = on ? this.w.navMarkers?.objectiveTarget() ?? null : null;
    const me = this.state.entities.get(this.state.playerId);
    if (!wp || !me) { this.w.quests.setGuide(''); this.w.guide.update(null, null, 0); return; }
    const dist = Math.hypot(wp.x - me.renderX, wp.y - me.renderY);
    const km = dist >= 1000 ? `${(dist / 1000).toFixed(1)} km` : `${Math.round(dist)} m`;
    this.w.quests.setGuide(`➜ ${wp.name} · ${km}`);
    this.w.guide.update(this.renderer.worldToScreen(me.renderX, me.renderY), this.renderer.worldToScreen(wp.x, wp.y), dist);
  }

  /** The right mouse button as the guns and mining laser see it: held, but not while the right-click menu is up (or the press that opened it) */
  private rightHeld(): boolean {
    return this.input.isMouseDown(2) && !this.w.context?.withholdingFire();
  }

  /** Engage the autopilot (map clicks, the job tracker, party members, right-clicks) */
  flyTo(dest: AutoDest, note?: string): void {
    if (!this.loggedIn || this.proto) return;
    if (this.stationOpen) this.w.stationWindow.value!.close();
    // (Somewhere new: a menu jump lining up is off)
    if (this.w.context.jumpMark()) this.w.context.cancel();
    this.w.autopilot.engage(dest, note);
    this.audio.playUI('ui_click', 0.5);
  }

  private toggleAutopilotToObjective(): void {
    if (this.w.autopilot.active) { this.w.autopilot.cancel('Autopilot off'); return; }
    const t = this.objective();
    const q = this.w.quests.current() ?? this.w.quests.trackedLead();
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
    const m = this.w.systemMapUI?.aimWorld() ?? this.renderer.screenToWorld(this.input.mouseX, this.input.mouseY);
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
    this.timeBadge?.update(this.state.crowd);
    
    if (this.loggedIn && this.state.playerId && this.network.isConnected()) {
      if (this.proto) {
        // Proto: no prediction. Inputs go straight to the in-process simulation, at the tick rate.
        this.state.updateCachedServerTick();
        this.inputTickAccum += delta * 1000; // delta is in seconds
        let ticksRun = 0;
        while (this.inputTickAccum >= TICK_MS && ticksRun < 4) {
          tickInput(this.inputCtx);
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
          tickInput(this.inputCtx);       // sample input, queued for targetTick = tick + input delay
          this.state.drainDelayQueue();   // apply what's due and step to predictedTick + 1
          this.state.predictedTick++;
        }
        this.state.cachedServerTick = this.state.predictedTick;
      }
    }

    // Interpolate entities (rocks out of sight placed less often: see GameState.orbitFocus)
    {
      const me = this.state.entities.get(this.state.playerId);
      const shown = !this.w.systemMapUI.covers() && !(this.loggedIn && (this.shipClient.hangarOpen || this.menu.isOpen));
      if (me) this.renderer.orbitFocus(me.renderX, me.renderY, shown, this.state.orbitFocus ??= { cx: 0, cy: 0, px: 0, py: 0, hw: 0, hh: 0 });
      else this.state.orbitFocus = null;
    }
    this.state.interpolate(delta);
    this.proto?.afterInterpolate(this.state);
    this.shipClient.update(now);
    this.hazards.setHorizonDanger(this.shipClient.horizonDanger());
    this.frost.update(this.loggedIn ? this.state.entities.get(this.state.playerId)?.warmth ?? null : null, delta);
    this.updateSounds(now);
    if (this.w.navMarkers) {
      this.w.navMarkers.setHidden(!this.loggedIn || this.shipClient.hangarOpen || this.w.systemMapUI.isOpen || this.menu.isOpen);
    this.regionUI.setHidden(!this.loggedIn || this.shipClient.hangarOpen || this.menu.isOpen || this.stationOpen);
      // (Every few frames on the lower tiers: see settings/quality.ts)
      if (++this.navFrames >= this.hudEvery) {
        this.navFrames = 0;
        this.w.navMarkers.update();
      }
    }
    if (this.w.peopleUI) {
      this.w.peopleUI.setHidden(!this.loggedIn || this.shipClient.hangarOpen || this.w.systemMapUI.isOpen || this.menu.isOpen);
      this.w.peopleUI.update();
    }
    this.updateGuide();
    this.w.context.update();
    this.w.bossUI.hidden = !this.loggedIn || this.shipClient.hangarOpen || this.w.systemMapUI.isOpen;
    if (!this.loggedIn || this.shipClient.hangarOpen || this.menu.isOpen || this.stationOpen) this.w.autopilot.setHidden(true);
    this.w.bossUI.update();
    this.w.farMarkers.setHidden(!this.loggedIn || this.shipClient.hangarOpen || this.w.systemMapUI.isOpen || this.menu.isOpen);
    this.w.farMarkers.update();
    const blocked = !this.loggedIn || this.shipClient.hangarOpen || this.w.systemMapUI.isOpen || this.menu.isOpen;
    const windowOpen = this.stationOpen || this.w.inventoryWindow.isOpen || this.w.tradeWindow.isOpen || this.w.social.window.isOpen || this.w.quests.log.isOpen || !!this.w.componentGuide.value?.isOpen;
    this.w.targetUI.setHidden(blocked);
    this.w.targetUI.update();
    this.w.infoPanel.update(!blocked && !windowOpen && !this.localDead);
    this.w.opsUI.setHidden(blocked);
    this.w.opsUI.update(this.w.bossUI.visible);
    // A construct job's site, while a piece is going on: the constructor beam
    const building = this.w.opsUI.ops.find((o) => o.kind === 'construct' && o.system === this.state.systemId && o.markers[0]?.state === 'active');
    this.w.buildSites?.update(1 / 60, building ? building.markers[0] : null);
    this.w.tutorial.update(blocked || this.localDead || this.w.playerStatsUI.isVisible());
    this.w.pingUI.setHidden(blocked);
    this.w.pingUI.update();
    // The hold above the chat: not while docked (the station's storage has it) or behind a full-screen view
    {
      const me = this.state.entities.get(this.state.playerId);
      this.w.cargoPanel.update(blocked || this.stationOpen || !me, !!me && !inSafeSpace(this.currentSystem(), me.renderX, me.renderY));
    }
    this.updateHeatGauge();
    // The weapon ring round the cursor: your gun groups' clips, charges, spin and ammo
    this.weaponRing?.update(this.shipClient.ringGroups(), this.input.mouseX, this.input.mouseY,
      this.loggedIn && !this.localDead && !this.shipClient.hangarOpen && !this.menu.isOpen && !this.stationOpen && !this.w.systemMapUI.isOpen);

    // Update screen shake
    this.state.updateScreenShake(delta);
    
    // The view follows the heading (input/viewMode.ts: helm by default, or as picked) to put the ship's nose up the
    // screen; otherwise it eases back to north-up. Mouse-steer so: the aim is pinned in the world (input/aimPin.ts)
    {
      const me = this.state.entities.get(this.state.playerId);
      const helm = this.shipClient.helmMode(), flying = this.loggedIn && !!me && !this.shipClient.hangarOpen;
      this.renderer.setCameraHeading(flying && viewMode.followsHeading(helm) ? noseUpAngle(me!.renderAngle) : null);
      this.aimPinView?.frame(flying && viewMode.pinnedAim(helm),
        !blocked && !windowOpen && !this.localDead && !this.chatFocused && !this.w.context.menuOpen && !this.w.dialogue?.isOpen);
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
    const covered = this.w.systemMapUI.covers();
    // (Nor under the sign-in screen, whose backdrop is drawn instead: its shaders are still compiling ahead)
    // Under a map that covers the screen the world isn't drawn at all (the GPU gets a rest), and kept up ten times a
    // second, not every frame (its effects run their course and views come and go; it's whole again as the map lifts)
    this.coveredDelta = covered ? this.coveredDelta + delta : 0;
    this.loading?.update(now);
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
    
    // Chat bubbles: after the world's drawn, so they sit on this frame's camera (ui/bubbles)
    this.w.chatBubbles?.setHidden(!this.loggedIn || this.shipClient.hangarOpen || this.menu.isOpen);
    this.w.chatBubbles?.update();

    // Update UI
    this.updateUI();
  }

  /** What app/inputSend.ts (tickInput, sendNeutralInput) reads (getters, so windows built late resolve at use) plus its last-sent state; made once */
  private makeInputCtx(): InputSendCtx {
    const g = this;
    const st = newInputSendState();
    return {
      get loggedIn() { return g.loggedIn; },
      get stationOpen() { return g.stationOpen; },
      get localDead() { return g.localDead; },
      get compactInputs() { return g.network instanceof NetworkManager; },
      get noseThrust() { return viewMode.pinnedAim(g.shipClient.helmMode()); },
      get proto() { return g.proto; },
      get menu() { return g.menu; },
      get adminPanel() { return g.adminPanel; },
      get shipClient() { return g.shipClient; },
      get autopilot() { return g.w.autopilot; },
      get context() { return g.w.context; },
      get playerStatsUI() { return g.w.playerStatsUI; },
      get systemMapUI() { return g.w.systemMapUI; },
      get navMarkers() { return g.w.navMarkers; },
      get audio() { return g.audio; },
      get network() { return g.network; },
      get input() { return g.input; },
      get renderer() { return g.renderer; },
      get state() { return g.state; },
      rightHeld: () => g.rightHeld(),
      lastSent: st.lastSent,
      lastSentAngle: st.lastSentAngle,
      lastSentCursorDist: st.lastSentCursorDist,
      sentDist: st.sentDist,
      aimSeen: st.aimSeen,
      aimStill: st.aimStill,
      lastFireLeft: st.lastFireLeft,
      lastFireRight: st.lastFireRight,
    };
  }

  private handleServerMessage(msg: ServerMessage): void {
    handleServerMessageTable(this.msgHost, msg);
  }

  /** What app/serverMessages.ts reads and writes (getters/setters, so late-built windows resolve at use; made once) */
  private makeMessageHost(): MessageHost {
    const g = this;
    return {
      get chat() { return g.chat; },
      get proto() { return g.proto; },
      get network() { return g.network; },
      get state() { return g.state; },
      get pilot() { return g.pilot; },
      get renderer() { return g.renderer; },
      get audio() { return g.audio; },
      get shipClient() { return g.shipClient; },
      get autopilot() { return g.w.autopilot; },
      get hazards() { return g.hazards; },
      get systemNames() { return g.systemNames; },
      get systemMapUI() { return g.w.systemMapUI; },
      get playerStatsUI() { return g.w.playerStatsUI; },
      get floatingRewardsUI() { return g.floatingRewardsUI; },
      get damageIndicatorUI() { return g.damageIndicatorUI; },
      get killFeedUI() { return g.w.killFeedUI; },
      get toasts() { return g.w.toasts; },
      get tutorial() { return g.w.tutorial; },
      get quests() { return g.w.quests; },
      get buildSites() { return g.w.buildSites; },
      get social() { return g.w.social; },
      get tradeWindow() { return g.w.tradeWindow; },
      get infoPanel() { return g.w.infoPanel; },
      get opsUI() { return g.w.opsUI; },
      get pingUI() { return g.w.pingUI; },
      get ribbonPopup() { return g.w.ribbonPopup; },
      get quickBar() { return g.w.quickBar; },
      get dialogue() { return g.w.dialogue; },
      get objectives() { return g.objectives; },
      get siegePanel() { return g.siegePanel; },
      get bossUI() { return g.w.bossUI; },
      get stationWindow() { return g.w.stationWindow; },
      get worldEvents() { return g.worldEvents; },
      get adminPanel() { return g.adminPanel; },
      get contribPanel() { return g.contribPanel; },
      get chatBubbles() { return g.w.chatBubbles; },
      get loggedIn() { return g.loggedIn; },
      set loggedIn(v) { g.loggedIn = v; },
      get localDead() { return g.localDead; },
      set localDead(v) { g.localDead = v; },
      get statsPrimed() { return g.statsPrimed; },
      set statsPrimed(v) { g.statsPrimed = v; },
      get sessionKills() { return g.sessionKills; },
      set sessionKills(v) { g.sessionKills = v; },
      get systemArrivedAt() { return g.systemArrivedAt; },
      set systemArrivedAt(v) { g.systemArrivedAt = v; },
      get perfSrv() { return g.perfSrv; },
      set perfSrv(v) { g.perfSrv = v; },
      get perfNet() { return g.perfNet; },
      set perfNet(v) { g.perfNet = v; },
      get wreck() { return g.wreck; },
      set wreck(v) { g.wreck = v; },
      onDisconnected: (info) => g.onDisconnected(info),
      netRates: () => g.netRates(),
      addChatMessage: (playerName, text, isSystem, color) => g.addChatMessage(playerName, text, isSystem, color),
      showSystemMessage: (text, color) => g.showSystemMessage(text, color),
      handleAuthResult: (msg) => g.handleAuthResult(msg),
      startContrib: () => g.startContrib(),
      stopContrib: () => g.stopContrib(),
    };
  }

  private setupChat(): void {
    // Hide / show the chat in place (the same setting as Settings > Chat box), e.g. for recording videos
    document.getElementById('chatHideBtn')?.addEventListener('click', () => settings.update((d) => { d.ui.chat = false; }));
    document.getElementById('chatShowBtn')?.addEventListener('click', () => settings.update((d) => { d.ui.chat = true; }));
    this.chat.install();
  }

  /** A line for the chat panel: the game's own (isSystem) or a player's. See ui/ChatPanel.ts */
  private addChatMessage(playerName: string, text: string, isSystem = false, color?: string): void {
    this.chat.add(playerName, text, isSystem, color);
  }

  private onConnected(): void {
    console.log('Connected to server');
    // (proto mode skips the server list)
    this.prefetchScreens();
    this.clearLoadingClick();
    if (this.loadingEl) this.loadingEl.style.display = 'none';
    // Covered until the world is in sync (a reconnect too)
    this.loading?.begin('join', this.serverName);
    // The sign-in backdrop has done its job: free its renderer (it's rebuilt if the sign-in screen comes back)
    this.loginUI.releaseBackdrop();
    
    // Show all HUD elements
    if (this.topHudEl) this.topHudEl.style.display = 'flex';
if (this.xpHudEl) this.xpHudEl.style.display = 'flex';
if (this.boostHudEl) this.boostHudEl.style.display = 'flex';
    this.w.pilotHud.show();
    this.shipClient.setInGame(true);
    this.w.quests.show();
    this.w.quickBar.show();
    this.w.social.show();
    this.perfMonitor?.setVisible(settings.data.ui.netStats);
    
    // Send join/auth message based on pending auth state
    // (Each carries our protocol version: a server on another one hangs up with PROTOCOL_MISMATCH_CLOSE)
    const pending = this.pendingAuth;
    // (A new connection: confirmed hits' shell counts start afresh, as the server's do)
    this.shipClient.resetHits();
    if (pending) {
      // Guest
      this.network.send({ type: 'join', username: pending.username, protocol: PROTOCOL_VERSION, caps: DEFAULT_CAPS });
      this.pendingAuth = null;
    } else if (this.authToken) {
      // Signed in at the lobby: the server checks the token with it
      this.network.send({ type: 'join', token: this.authToken, username: this.state.playerName, protocol: PROTOCOL_VERSION, caps: DEFAULT_CAPS });
    } else {
      // Fallback guest
      this.network.send({ type: 'join', username: this.state.playerName || 'Player', protocol: PROTOCOL_VERSION, caps: DEFAULT_CAPS });
    }
    
    // Start ping loop (one per connection: a reconnect replaces it)
    // The first now: until a pong comes the client has no idea of the server's tick (rock orbits, stations and
    // other ships are placed at the wrong one, then jump), and the loading screen waits for it
    if (this.pingTimer) clearInterval(this.pingTimer);
    const ping = () => this.network.send({ type: 'ping', clientTime: Date.now() });
    ping();
    this.pingTimer = setInterval(ping, 2000);
  }

  private onDisconnected(info?: DisconnectInfo): void {
    console.log('Disconnected from server', info ?? '');
    this.loggedIn = false;
    this.loading?.cancel();
    
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
    this.w.pilotHud.hide();
    this.shipClient.setInGame(false);
    this.w.quests.hide();
    this.w.dialogue.hide();
    this.w.quickBar.hide();
    this.w.social.hide();
    this.w.quests.log.close();
    this.w.inventoryWindow.close();
  }

  /** Unread mail, said once a page when the pilot is in (the inbox is on the join screen) */
  private mailToasted = false;
  private mailToast(): void {
    const token = this.authToken;
    if (this.mailToasted || !token || this.proto) return;
    this.mailToasted = true;
    void lobbyInbox.list(token).then((r) => {
      if (!r.success || !r.unread) return;
      this.w.toasts?.show(`You have ${r.unread} unread message${r.unread === 1 ? '' : 's'} (your inbox is on the join screen)`, r.unreadImportant ? 'warn' : 'info');
    });
  }

  private handleAuthResult(msg: { success: boolean; username?: string; token?: string; isAdmin?: boolean; isOwner?: boolean; isContributor?: boolean; error?: string }): void {
    if (msg.success) {
      console.log(`Authenticated as ${msg.username}${msg.isOwner ? ' (owner)' : msg.isAdmin ? ' (admin)' : ''}`);
      if (msg.username) this.state.playerName = msg.username;
      if (msg.token) {
        this.authToken = msg.token;
        // Save token for reconnection
        try { localStorage.setItem('authToken', msg.token); } catch (e) {}
      }
      this.isOwner = !!msg.isOwner;
      this.isAdmin = !!msg.isAdmin || this.isOwner;
      // Map warp (Ctrl-click) is an admin tool: the server refuses it for anyone else, so only admins see it offered
      this.w.systemMapUI.onWarp = this.isAdmin ? (systemId, x, y) => this.network.send({ type: 'devTeleport', systemId, x, y }) : null;
      
      if (this.isAdmin) this.startAdmin();
      else this.stopAdmin();
      this.mailToast();
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
    this.isOwner = false;
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
        map: this.w.systemMapUI,
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
    // (and each bank's, flashing while what it feeds browns out: ui/BankBars.ts)
    this.bankBars?.update(this.shipClient?.myShip()?.derived, this.state.charge);
    
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
    this.w.systemMapUI?.setRedrawEvery(q.mapEvery);
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
