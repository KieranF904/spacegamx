/**
 * Game - Main client orchestrator
 */

import { setResourceOpener } from './ui/resources/resourceFocus';
import { ChatPanel } from './ui/ChatPanel';
import { WorldQueries } from './app/worldQueries';
import { StaffPanels } from './app/staffPanels';
import { TickDriver } from './app/tickDriver';
import { HudReadouts } from './app/hudReadouts';
import { SceneSounds } from './app/sceneSounds';
import { ChargeGauge } from './app/chargeGauge';
import { updateZone, type ZoneHost } from './app/zoneHud';
import { showVersionOverlay } from './app/versionOverlay';
import { buildWindows, type WindowHost, type WindowSet } from './app/windows';
import { prefetchScreens, resetTutorialUI } from './app/lazyScreens';
import { installDevTools } from './app/devTools';
import { Prediction } from './predict/Prediction';
import { handleKey, type KeyHost } from './app/keys';
import { handleServerMessage as handleServerMessageTable, type MessageHost } from './app/serverMessages';
import { FrameGate } from './app/frameGate';
import { terrainHold } from './rendering/terrainData';
import { tickInput, sendNeutralInput, newInputSendState, forgetSession, type InputSendCtx } from './app/inputSend';
import { guestKey, guestName } from './network/guestId';
import { lobbyAuth, LobbyAuthResult, lobbyRegister } from './network/lobby';
import { lobbyInbox } from './network/inbox';
import { initGuestBanner, hideGuestBanner } from './ui/guest/guestBanner';
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
import { beamLightSound, beamLoopFor } from './audio/weaponSounds';
import { CombatSounds } from './audio/CombatSounds';

import { PerfMonitor } from './ui/PerfMonitor';


import type { MenuPilotInfo } from './ui/GameMenuUI';
import { MenuFacade } from './ui/menuLazy';
import { settings, SettingsData } from './settings/Settings';
import { AutoQuality, PROFILES, type QualityTier } from './settings/quality';
import { ACTIONS, boundKeyName } from './input/keybindings';
import systemsDataForMenu from '../../data/systems.json';

import { DamageIndicatorUI } from './ui/DamageIndicatorUI';
import { FloatingRewardsUI } from './ui/FloatingRewardsUI';
import { ShipClient } from './ships/ShipClient';
import type { AdminPanel } from './ui/AdminPanel';
import type { ContributorPanel } from './ui/ContributorPanel';

import { WeaponRing } from './ui/WeaponRing';
import { ObjectiveBanner } from './ui/ObjectiveBanner';
import type { SiegePanel } from './ui/SiegePanel';
import { Lazy } from './lazy';
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
import './app/rockTables';
import { TICK_RATE, TICK_MS, xpToReach } from '@space-game/common';
import { itemIcon, shipIcon } from './ui/itemIcons';
import { LoadingFlow } from './app/loadingFlow';
import { wreckLabel, type WreckMark } from './ui/wreckMark';
import { ServerMessage, asteroidComposition, MiningTable, registerRockTypes, EntityType, computeStateHash, ClientTransport, loadCatalog, ShipTuning, InventoryStub, QuestTarget, DisconnectInfo, PROTOCOL_VERSION, PROTOCOL_MISMATCH_CLOSE, DEFAULT_CAPS } from '@space-game/common';
import { inGunRange, resetRangeState } from './ui/gunRange/rangeState';

export interface GameOptions {
  transport?: ClientTransport;
}

export class Game {
  private container: HTMLElement;
  private app!: Application;
  private network: ClientTransport;
  private readonly keyHost: KeyHost = this.makeKeyHost();
  private readonly msgHost: MessageHost = this.makeMessageHost();
  private readonly inputCtx: InputSendCtx = this.makeInputCtx();
  private readonly windowHost: WindowHost = this.makeWindowHost();
  /** Every window and HUD component (built in init; see app/windows.ts) */
  private w = {} as WindowSet;
  private shipClient: ShipClient;
  /** Questions about where you are (app/worldQueries.ts) */
  private world!: WorldQueries;
  private staff!: StaffPanels;
  private ticks!: TickDriver;
  private hud!: HudReadouts;
  private sceneSounds!: SceneSounds;
  private zoneHost!: ZoneHost;
  private chargeGauge = new ChargeGauge();
  /** Other ships predicted on the PT layer (predict/Prediction.ts: C3) */
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
  /** Your last ship's wreck, yours alone a while, then anyone's (ui/wreckMark.ts): marked until you recover it or it's gone */
  private wreck: WreckMark | null = null;
  /** Objective banners (a city under siege) */
  private objectives = new ObjectiveBanner();
  /** A moon siege's panel (and its night HUD and cards): its own chunk, fetched when the first siege message arrives */
  private siegePanel = new Lazy(() => import('./ui/SiegePanel').then(({ SiegePanel }) => new SiegePanel((m) => this.network.send(m), {
    tick: () => this.state.getRawServerTick(),
    target: () => this.w?.targetUI.target ?? 0,
    me: () => { const e = this.state.entities.get(this.state.playerId); return e ? { x: e.renderX, y: e.renderY } : null; },
    bastion: () => this.world.currentSystem()?.surface?.bastion ?? null,
    focusKey: () => boundKeyName('siegeFocus', settings.data.bindings),
  })));
  private lastTraffic = { t: 0, bytesIn: 0, bytesOut: 0, framesIn: 0 };
  private trafficText = '';
  private localDead = false;
  private menu!: MenuFacade;
  /** The server we joined (for the menu's Server page) */
  private serverName = 'Local';
  private serverAddress = '';
  private windowFocused = true;
  /** Shots and impacts heard as WeaponFx draws them (audio/CombatSounds.ts) */
  private combatSounds!: CombatSounds;
  systemArrivedAt = 0;
  private statsPrimed = false;
  private damageIndicatorUI!: DamageIndicatorUI;
  private floatingRewardsUI!: FloatingRewardsUI;
  
  private running = false;
  /** Graphics quality: Auto's pick (used while the setting is Auto) */
  private autoQuality = new AutoQuality();
  /** A full-screen window (hangar, menu) hides the world: it isn't updated or drawn until this is set again (a resize, a setting changed) or the window closes */
  private worldPaused = false;
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
  /** The loading screen from choosing a server (and on arriving elsewhere, or respawning) until the world is in sync */
  private loading: LoadingFlow | null = null;
  private topHudEl: HTMLElement | null;
private xpHudEl: HTMLElement | null;
  private inventoryPanelEl: HTMLElement | null;
private perfMonitor: PerfMonitor | null = null;
  private perfSrv: number | undefined;
  private perfNet = '';
  
  // Individual HUD components
  /** The weapon ring round the cursor (ui/WeaponRing.ts) */
  private weaponRing: WeaponRing | null = null;
  /** Mouse-steer with the view on the heading: the aim pinned in the world, and its drawn cursor (input/aimPin.ts) */
  private aimPinView: AimPinView | null = null;

  // Chat elements
  /** The chat box: channel toggles, lines, the input and its private-message mode (ui/ChatPanel.ts) */
  private chat: ChatPanel;
  private chatFocused = false;
  
  // Tick-based input system
  /** Extra camera zoom factor while jumping */
  private jumpZoom = 1;

  // Auth state
  private authToken: string | null = null;
  private isAdmin = false;
  /** The owner rank (above admin: isAdmin is true too) */
  private isOwner = false;
  /** The server is a dev server (its adminInfo says free build is on): its dev tools are open to every admin */
  private devServer = false;
  /** A guest's name, to join with once connected (signed-in pilots join with authToken) */
  private pendingAuth: { type: 'guest'; username: string } | null = null;
  /** This build speaks another protocol than the server: nothing more until the player reloads */
  private versionMismatch = false;

  // Ping graph

  constructor(container: HTMLElement, options: GameOptions = {}) {
    this.container = container;
    this.network = options.transport ?? new NetworkManager();
    this.input = new InputManager();
    this.state = new GameState();
    this.world = new WorldQueries(this.state);
    // Asteroid compositions, exactly as the server derives them
    const systemDanger = new Map((systemsDataForMenu as { systems: { id: string; danger?: number }[] }).systems.map((s) => [s.id, s.danger ?? 1]));
    this.state.composeAsteroid = (type, key, size, systemId, stage) => asteroidComposition(miningTable as unknown as MiningTable, type, key, size, systemDanger.get(systemId) ?? 1, stage);

    // Modular ships: the client carries the same piece catalog (and economy) as the server
    const shipTuningData = shipTuning as ShipTuning;
    // (Designs' own pieces: bosses' bespoke hulls)
    const bespoke = Object.values(import.meta.glob('../../data/ships/bespoke/*.json', { eager: true, import: 'default' }));
    const shipCatalog = loadCatalog({ pieces: shipPieces, functions: shipFunctions, materials: shipMaterials, models: shipModels, bespoke } as any, { overlapShrink: shipTuningData.overlapShrink });
    this.pilot = new PilotState(createClientEconomy(shipCatalog));
    this.shipClient = new ShipClient({
      catalog: shipCatalog,
      pilot: this.pilot,
      isAdmin: () => this.isAdmin,
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
      zoom: { get: () => this.input.targetZoom, set: (z) => { this.input.targetZoom = z; } },
    });
    this.state.chargeTotal = (charge) => this.shipClient.chargeTotal(charge);
    // Every other ship moves by replication
    this.state.preSnapshot = (m) => this.shipClient.preSnapshot(m);
    this.state.onReplication = (m) => this.shipClient.onReplication(m);
    // (Your own ship: on its tick layer, stepped once a tick to the prediction's and drawn from there)
    this.state.ownStep = (t) => this.shipClient.ownStepTo(t);
    this.state.ownPose = (t) => this.shipClient.ownPose(t);
    this.state.replicaPose = (e, t) => this.shipClient.placeReplica(e, t);
    // (Every other ship on the PT layer at your tick, drawn by the prediction's hook: C3)
    this.prediction = new Prediction(this.state, this.shipClient, () => this.renderer ?? null);
    this.audio = new AudioManager();
    const g = this;
    this.staff = new StaffPanels({
      state: this.state, pilot: this.pilot,
      get renderer() { return g.renderer; }, input: this.input, get w() { return g.w; },
      isAdmin: () => g.isAdmin, devTools: () => g.devTools(), send: (m) => g.network.send(m), flyTo: (d) => g.flyTo(d), chat: (n, t, s, c) => g.addChatMessage(n, t, s, c),
    });
    this.ticks = new TickDriver({ state: this.state, ctx: this.inputCtx, send: (m) => this.network.send(m) });
    this.hud = new HudReadouts({ state: this.state, pilot: this.pilot, shipClient: this.shipClient, systemNames: this.systemNames });
    this.zoneHost = { state: this.state, world: this.world, shipClient: this.shipClient, regionUI: this.regionUI, get w() { return g.w; } };
    this.sceneSounds = new SceneSounds({
      state: this.state, audio: this.audio, input: this.input, shipClient: this.shipClient, musicPlace: this.musicPlace,
      objectives: this.objectives, world: this.world,
      get combatSounds() { return g.combatSounds; }, get loggedIn() { return g.loggedIn; }, get menuOpen() { return g.menu.isOpen; },
      get stationOpen() { return g.stationOpen; }, get bossId() { return g.w.bossUI.bossId; }, get systemArrivedAt() { return g.systemArrivedAt; },
      updateZone: () => updateZone(g.zoneHost),
    });
    
    // Cache UI elements - new HUD structure
    this.loadingEl = document.getElementById('loading');
    this.topHudEl = document.getElementById('topHud');
this.xpHudEl = document.getElementById('xpHud');
    this.inventoryPanelEl = document.getElementById('inventoryPanel');
    
    // Individual components
    this.weaponRing = new WeaponRing();

    // Chat
    this.chat = new ChatPanel({
      send: (m) => this.network.send(m),
      setGameInput: (on) => this.input.setEnabled(on),
      // (Not while the pickup panel is open: Enter takes all there)
      canFocus: () => !this.menu.isOpen && this.network.isConnected() && !this.w.pickup?.takesEnter,
      ensureShown: () => { if (!settings.data.ui.chat) settings.update((d) => { d.ui.chat = true; }); },
      onFocusChange: (f) => { this.chatFocused = f; },
      openFriends: () => this.w.hub.open('social'),
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
    this.combatSounds = new CombatSounds({
      play: (id, x, y, volume, pitch) => { this.audio.play(id, x, y, { volume, pitch }); },
      shieldAt: (x, y) => this.shipClient.shieldAt(x, y),
    });
    this.renderer.combatSounds = this.combatSounds;
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
    setResourceOpener(() => this.menu.openGuide('resources'));
    settings.subscribe((s) => this.applySettings(s));
    window.addEventListener('blur', () => { this.windowFocused = false; this.applyVolume(settings.data); });
    window.addEventListener('focus', () => { this.windowFocused = true; this.applyVolume(settings.data); });
    this.damageIndicatorUI = new DamageIndicatorUI(uiOverlay);
    {
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
    this.loginUI.onRegister = (username, password, email, newsletter) => this.handleRegister(username, password, email, newsletter);
    this.loginUI.onPlayAsGuest = () => this.handleGuestPlay();
    // (A guest registering from the game: the lobby makes the account, the server moves the pilot; ui/guest/guestBanner.ts)
    initGuestBanner({
      send: (m) => this.network.send(m),
      register: (username, email, password, newsletter) => lobbyRegister(username, email, password, newsletter),
      registered: (token, username) => {
        this.authToken = token;
        this.state.playerName = username;
        try { localStorage.setItem('authToken', token); } catch { /* storage unavailable: this session only */ }
      },
      leave: () => location.reload(),
    });
    void this.resumeSession();
    
    // Setup server browser callbacks
    this.serverBrowserUI.onServerSelect = (server) => this.handleServerSelect(server);
    this.serverBrowserUI.onLogout = () => this.handleLogout();
    

    // Handle resize
    window.addEventListener('resize', () => this.onResize());
    
    // Set up network handlers
    // (Through a gate: a join or system change waits for that system's rock to load, app/frameGate.ts)
    // (Client-detected hits: a frame's hits go out once the whole frame is in, ships/hits/SelfHits.ts)
    const gate = new FrameGate((msg) => this.handleServerMessage(msg), () => this.shipClient.frameEnd((m) => this.handleServerMessage(m)), terrainHold);
    this.network.onMessage = (msg) => gate.message(msg);
    this.network.onFrameEnd = () => gate.end();
    this.network.onConnect = () => this.onConnected();
    this.network.onDisconnect = (info) => { gate.drop(); this.onDisconnected(info); };

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

    console.log('Game initialized');
  }

  /** Sign in at the lobby (accounts are kept there, one for every server); only then pick a server */
  private async handleLogin(username: string, password: string): Promise<void> {
    this.loginUI.setLoading(true);
    this.loginUI.showError('');
    this.signedIn(await lobbyAuth('login', { username, password }));
  }

  private async handleRegister(username: string, password: string, email: string, newsletter: boolean): Promise<void> {
    this.loginUI.setLoading(true);
    this.loginUI.showError('');
    this.signedIn(await lobbyRegister(username, email, password, newsletter));
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
    this.loginUI.showBackdropOnly();
    this.serverBrowserUI.show({ token: r.token, username: r.username ?? '', isAdmin: !!r.isAdmin });
    this.prefetchScreens();
  }

  /** A saved session from last time: if the lobby still knows it, skip the sign-in screen */
  private async resumeSession(): Promise<void> {
    let token: string | null = null;
    try { token = localStorage.getItem('authToken'); } catch { /* storage unavailable */ }
    if (!token) return;
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
    // (The name this browser's guest flew under last: with its key, the server gives them their pilot back)
    const name = guestName();
    this.state.playerName = name;
    this.pendingAuth = { type: 'guest', username: name };
    this.loginUI.showBackdropOnly();
    this.serverBrowserUI.show();
    this.prefetchScreens();
  }

  private handleServerSelect(server: ServerInfo): void {
    this.authFailed = false;
    this.serverBrowserUI.hide();
    // (the join screen's backdrop, the sign-in screen's scene, goes with it: the world is drawn again)
    this.loginUI.hide();
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
    // One throw in a frame must not end the loop: log it (a line every 5 s at most) and carry on with the next frame
    let lastLog = 0, since = 0;
    const report = (what: string, e: unknown) => {
      const t = performance.now();
      if (t - lastLog < 5000) { since++; return; }
      console.error(`[Game] ${what}${since ? ` (and ${since} more since)` : ''}:`, e);
      lastLog = t; since = 0;
    };
    this.app.ticker.add(() => {
      try { this.update(); } catch (e) { report('frame error', e); }
    });
    // Errors outside the frame (a callback, a rejected promise) are logged too, never left to stop anything
    window.addEventListener('error', (ev) => report('uncaught error', ev.error ?? ev.message));
    window.addEventListener('unhandledrejection', (ev) => report('unhandled rejection', ev.reason));
  }

  private createMenu(): void {
    this.menu = new MenuFacade(new Lazy(() => import('./ui/GameMenuUI').then(({ GameMenuUI }) => new GameMenuUI({
      openMap: () => this.w.systemMapUI.toggle(),
      pilot: () => this.pilotInfo(),
      ship: () => this.shipClient.menuShipInfo(),
      server: () => {
        let pilots = 0;
        for (const e of this.state.entities.values()) if (e.type === EntityType.Player) pilots++;
        return {
          name: this.serverName,
          address: this.serverAddress || location.host,
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
      threats: () => this.state.threats,
      myRating: () => this.shipClient.myRating(),
      level: () => this.pilot.profile?.level ?? this.state.level,
      xp: () => this.pilot.profile?.xp ?? this.state.xp,
      icon: (id) => itemIcon(this.pilot.econ, id),
      shipIcon: (parts, size) => shipIcon(this.pilot.econ, parts, size),
      openComponents: () => this.w.hub.open('components'),
    }))));
  }

  /** You as the readouts show you (the Esc menu's front page, the side panel's Pilot tab) */
  private pilotInfo(): MenuPilotInfo {
    const sys = this.world.currentSystem();
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
      get adminPanel() { return g.staff.adminPanel; },
      objective: () => g.objective(),
      flyTo: (d, note) => g.flyTo(d, note),
      showSystemMessage: (text, color) => g.showSystemMessage(text, color),
      currentSystem: () => g.world.currentSystem(),
      planetBelow: () => g.world.planetBelow(),
      wreckMarker: () => g.wreckMarker(),
      siegeMarkers: () => (g.siegePanel.value?.markers() ?? []).map((m) => ({ ...m, system: g.state.systemId })),
      toggleAutopilotToObjective: () => g.toggleAutopilotToObjective(),
      chatTo: (name) => g.chat.messageTo(name),
      friendsOnline: (n) => g.chat.setFriendsOnline(n),
      pilotInfo: () => g.pilotInfo(),
    };
  }

  private makeKeyHost(): KeyHost {
    const g = this;
    return {
      get loggedIn() { return g.loggedIn; },
      get stationOpen() { return g.stationOpen; },
      get menu() { return g.menu; },
      get dialogue() { return g.w.dialogue; },
      get hub() { return g.w.hub; },
      get inventoryWindow() { return g.w.inventoryWindow; },
      get shipWindow() { return g.w.shipWindow; },
      get pickup() { return g.w.pickup; },
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
      get siegePanel() { return { focus: () => g.siegePanel.value?.focus() ?? false }; },
      get gunRangeHud() { return g.w.gunRangeHud.value ?? undefined; },
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
  /** Your wreck, as a marker while it's there (whose it is, and the time left) */
  private wreckMarker(): { name: string; x: number; y: number; system: string }[] {
    const w = this.wreck;
    if (!w || w.system !== this.state.systemId) return [];
    const name = wreckLabel(w, Date.now());
    if (!name) { this.wreck = null; return []; }
    return [{ name, x: w.x, y: w.y, system: w.system }];
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
    if (!this.loggedIn) return;
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
    if (!t || !q) { this.showSystemMessage(`Follow a job or lead first (${boundKeyName('log', settings.data.bindings)}), or click a place on the map (${boundKeyName('map', settings.data.bindings)})`, '#f2d24b'); return; }
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
      this.ticks.run();
    }

    // Interpolate entities (rocks out of sight placed less often: see GameState.orbitFocus)
    {
      const me = this.state.entities.get(this.state.playerId);
      const shown = !this.w.systemMapUI.covers() && !(this.loggedIn && (this.shipClient.hangarOpen || this.menu.isOpen));
      if (me) this.renderer.orbitFocus(me.renderX, me.renderY, shown, this.state.orbitFocus ??= { cx: 0, cy: 0, px: 0, py: 0, hw: 0, hh: 0 });
      else this.state.orbitFocus = null;
    }
    this.state.interpolate(delta);
    this.shipClient.update(now);
    this.hazards.setHorizonDanger(this.shipClient.horizonDanger());
    this.frost.update(this.loggedIn ? this.state.entities.get(this.state.playerId)?.warmth ?? null : null, delta);
    this.sceneSounds.update(now);
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
    const windowOpen = this.stationOpen || this.w.inventoryWindow.isOpen || this.w.tradeWindow.isOpen || this.w.quests.log.isOpen;
    this.w.targetUI.setHidden(blocked);
    this.w.targetUI.update();
    // (the range's HUD is its own chunk: fetched the first time a range is entered)
    if (inGunRange() && !this.w.gunRangeHud.value) this.w.gunRangeHud.load().catch(() => {});
    this.w.gunRangeHud.value?.update(blocked || this.localDead);
    this.w.infoPanel.update(!blocked && !windowOpen && !this.localDead);
    this.w.opsUI.setHidden(blocked);
    this.w.opsUI.update(this.w.bossUI.visible);
    // A construct job's site, while a piece is going on: the constructor beam
    const building = this.w.opsUI.ops.find((o) => o.kind === 'construct' && o.system === this.state.systemId && o.markers[0]?.state === 'active');
    this.w.buildSites?.update(1 / 60, building ? building.markers[0] : null);
    // (the training card stays up over the hangar and the map, by them: the part, generator and map steps are done there)
    this.w.tutorialUI.value?.update(blocked || this.localDead, !this.loggedIn || this.menu.isOpen || this.localDead);
    this.w.pingUI.setHidden(blocked);
    this.w.pingUI.update();
    // The hold above the chat: not while docked (the station's storage has it) or behind a full-screen view
    {
      const me = this.state.entities.get(this.state.playerId);
      // The side panel on top of it: hidden behind the menu or the map; over the station or the hangar only when its key calls it up
      // (In the gun range the weapon picker has its place: ui/gunRange)
      this.w.hub.update(!this.loggedIn || this.w.systemMapUI.isOpen || this.menu.isOpen ? 'off' : blocked || this.stationOpen || !me || inGunRange() ? 'covered' : 'on');
      this.w.cargoPanel.update(blocked || this.stationOpen || !me || inGunRange(), !!me && !inSafeSpace(this.world.currentSystem(), me.renderX, me.renderY));
      this.w.pickup.update(blocked || this.stationOpen || !me || inGunRange());
    }
    this.chargeGauge.update(this.shipClient.laserCharge(), this.loggedIn && !this.shipClient.hangarOpen);
    this.updateShipHud(now, blocked);
    // The weapon ring round the cursor: your gun groups' clips, charges, spin and ammo
    this.weaponRing?.update(this.shipClient.ringGroups(), this.input.mouseX, this.input.mouseY,
      this.loggedIn && !this.localDead && !this.shipClient.hangarOpen && !this.menu.isOpen && !this.stationOpen && !this.w.systemMapUI.isOpen, this.shipClient.ringChip());

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
    
    // Periodic state hash for snapshot-on-mismatch (1 Hz).
    if (this.loggedIn && this.state.playerId && this.network.isConnected()) {
      this.ticks.sendHash(now);
    }
    
    // Chat bubbles: after the world's drawn, so they sit on this frame's camera (ui/bubbles)
    this.w.chatBubbles?.setHidden(!this.loggedIn || this.shipClient.hangarOpen || this.menu.isOpen);
    this.w.chatBubbles?.update();

    // Update UI
    this.staff.update();
    this.hud.update();
  }

  /** The Ship window, the footer, the power readout, the status icons and the weapon group row (ui/ship, ui/hud), once a frame */
  private updateShipHud(now: number, blocked: boolean): void {
    const w = this.w;
    w.shipWindow.update(now, !this.loggedIn || this.shipClient.hangarOpen || this.menu.isOpen || w.systemMapUI.isOpen);
    const flying = this.loggedIn && !blocked && !this.stationOpen && !this.localDead;
    w.footer.update(flying);
    const me = flying ? this.state.entities.get(this.state.playerId) : undefined;
    const ship = me ? this.shipClient.myShip() : null;
    const sent = this.inputCtx.lastSent;
    w.powerMargin.update(ship?.derived, this.state.charge, {
      thrust: !!(sent.forward || sent.backward || sent.left || sent.right), boost: !!sent.boost, firing: !!(sent.fireLeft || sent.fireRight),
    });
    w.statusTray.update(me ? { tick: this.state.serverTick, empUntil: me.empUntil, slowUntil: me.slowUntil, markUntil: me.markUntil, warmth: me.warmth, held: this.shipClient.heldBy() } : null);
    w.groupRow.update(flying, ship);
  }

  /** What app/inputSend.ts (tickInput, sendNeutralInput) reads (getters, so windows built late resolve at use) plus its last-sent state; made once */
  private makeInputCtx(): InputSendCtx {
    const g = this;
    const st = newInputSendState();
    return {
      get loggedIn() { return g.loggedIn; },
      get stationOpen() { return g.stationOpen; },
      get localDead() { return g.localDead; },
      // (The Ship window open: fly, but the guns are held)
      get fireBlocked() { return g.w.shipWindow?.isOpen ?? false; },
      get compactInputs() { return g.network instanceof NetworkManager; },
      get noseThrust() { return viewMode.pinnedAim(g.shipClient.helmMode()); },
      get menu() { return g.menu; },
      get adminPanel() { return g.staff.adminPanel; },
      get shipClient() { return g.shipClient; },
      get autopilot() { return g.w.autopilot; },
      get context() { return g.w.context; },
      get playerStatsUI() { return g.w.playerStatsUI; },
      get systemMapUI() { return g.w.systemMapUI; },
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
      get adminPanel() { return g.staff.adminPanel; },
      get contribPanel() { return g.staff.contribPanel; },
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
      noteDevServer: (on) => g.noteDevServer(on),
      startContrib: () => g.staff.startContrib(),
      stopContrib: () => g.staff.stopContrib(),
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
    this.w.pilotHud.show();
    this.shipClient.setInGame(true);
    this.w.quests.show();
    this.w.quickBar.show();
    this.w.social.show();
    this.perfMonitor?.setVisible(settings.data.ui.netStats);
    
    // Send join/auth message based on pending auth state
    // (Each carries our protocol version: a server on another one hangs up with PROTOCOL_MISMATCH_CLOSE)
    const pending = this.pendingAuth;
    // A new connection (the first, a reconnect after a drop, or to a server that restarted): the server's session starts
    // from nothing, so the client's does too. The world and clock (GameState), every replica, structure, hit and its own
    // tick layer (ShipClient), the PT layer and what inputs were last sent: kept from the last session, they disagree
    // with the new one for good (ships it never removes, ticks far ahead of a restarted clock, keys it never heard)
    this.state.resetSession();
    this.shipClient.resetSession();
    this.prediction?.reset();
    forgetSession(this.inputCtx);
    this.statsPrimed = false;
    this.localDead = false;
    if (pending) {
      // Guest
      // (With this browser's guest key: joining again, a reconnect or after a restart, the server gives back the pilot it kept)
      this.network.send({ type: 'join', username: pending.username, protocol: PROTOCOL_VERSION, caps: DEFAULT_CAPS, guestKey: guestKey() });
      this.pendingAuth = null;
    } else if (this.authToken) {
      // Signed in at the lobby: the server checks the token with it
      this.network.send({ type: 'join', token: this.authToken, username: this.state.playerName, protocol: PROTOCOL_VERSION, caps: DEFAULT_CAPS });
    } else {
      // Fallback guest
      // (A guest reconnecting: the same name and key, so the same pilot)
      this.network.send({ type: 'join', username: this.state.playerName || 'Player', protocol: PROTOCOL_VERSION, caps: DEFAULT_CAPS, guestKey: guestKey() });
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
    hideGuestBanner();
    if (this.w.tutorialUI) resetTutorialUI(this.w.tutorialUI);
    resetRangeState();
    this.loading?.cancel();
    
    if (info?.code === PROTOCOL_MISMATCH_CLOSE || this.versionMismatch) {
      // A new version is out (or this one is newer than the server): only a reload helps
      this.versionMismatch = true;
      this.network.disconnect();
      showVersionOverlay();
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
          this.loginUI.showBackdropOnly();
          this.serverBrowserUI.show();
        } else {
          this.loginUI.show();
        }
      };
    }
    // Hide all HUD elements on disconnect
    if (this.topHudEl) this.topHudEl.style.display = 'none';
if (this.xpHudEl) this.xpHudEl.style.display = 'none';
    this.w.pilotHud.hide();
    this.shipClient.setInGame(false);
    this.w.quests.hide();
    this.w.dialogue.hide();
    this.w.quickBar.hide();
    this.w.social.hide();
    this.w.quests.log.close();
    this.w.inventoryWindow.close();
    this.w.shipWindow.close();
  }

  /** Unread mail, said once a page when the pilot is in (the inbox is on the join screen) */
  private mailToasted = false;
  private mailToast(): void {
    const token = this.authToken;
    if (this.mailToasted || !token) return;
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
      this.offerDevWarp();
      
      if (this.isAdmin) this.staff.startAdmin();
      else this.stopAdmin();
      this.mailToast();
      if (msg.isContributor || this.isAdmin) this.staff.startContrib();
      else this.staff.stopContrib();
    } else {
      // Wrong password or a refused registration: back to the sign-in screen with the reason
      // (the server hangs up too, so no nameless pilot is left in the world)
      console.warn('Auth failed:', msg.error);
      this.authFailed = true;
      this.stopAdmin();
      this.staff.stopContrib();
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

  /** The last sign-in was refused (the disconnect that follows isn't a dropped connection) */
  private authFailed = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  private stopAdmin(): void {
    this.staff.stopAdmin();
    this.isAdmin = false;
    this.isOwner = false;
    this.devServer = false;
    this.offerDevWarp();
  }

  /** The dev tools are the owner's (on a dev server, every admin's): the server refuses them for anyone else, so only they see them offered */
  private devTools(): boolean {
    return this.isOwner || (this.isAdmin && this.devServer);
  }

  /** Map warp (Ctrl-click) is a dev tool */
  private offerDevWarp(): void {
    this.w.systemMapUI.onWarp = this.devTools() ? (systemId, x, y) => this.network.send({ type: 'devTeleport', systemId, x, y }) : null;
  }

  private noteDevServer(on: boolean): void {
    this.devServer = on;
    this.offerDevWarp();
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
    // (and the join screen over the same scene)
    if (this.loginUI?.backdrop()) return Math.min(2, window.devicePixelRatio || 1);
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
