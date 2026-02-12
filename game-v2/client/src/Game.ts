/**
 * Game - Main client orchestrator
 */

import { Application, Container, Graphics, Text, TextStyle } from 'pixi.js';
import { NetworkManager } from './network/NetworkManager';
import { InputManager } from './input/InputManager';
import { Renderer } from './rendering/Renderer';
import { GameState } from './state/GameState';
import { InventoryUI } from './ui/InventoryUI';
import { LoginUI } from './ui/LoginUI';
import { ServerBrowserUI, ServerInfo } from './ui/ServerBrowserUI';
import { DebugUI } from './ui/DebugUI';
import { AudioManager } from './audio/AudioManager';
import { KillFeedUI } from './ui/KillFeedUI';
import { PlayerStatsUI } from './ui/PlayerStatsUI';
import { DamageIndicatorUI } from './ui/DamageIndicatorUI';
import { FloatingRewardsUI } from './ui/FloatingRewardsUI';
import { BoostEffectsUI } from './ui/BoostEffectsUI';
import {
  TICK_RATE,
  TICK_MS,
  WORLD_SIZE,
  PLAYER_RADIUS,
} from '@space-game/common';
import {
  ServerMessage,
  ClientInputMessage,
  EntityState,
  EntityType,
  quantizeCursorAngle,
  dequantizeCursorAngle,
  CURSOR_RADIUS,
  computeStateHash,
} from '@space-game/common';

export class Game {
  private container: HTMLElement;
  private app!: Application;
  private network: NetworkManager;
  private input: InputManager;
  private renderer!: Renderer;
  private state: GameState;
  private audio: AudioManager;
  
  // UI components
  private loginUI!: LoginUI;
  private serverBrowserUI!: ServerBrowserUI;
  private inventoryUI!: InventoryUI;
  private debugUI!: DebugUI;
  private killFeedUI!: KillFeedUI;
  private playerStatsUI!: PlayerStatsUI;
  private damageIndicatorUI!: DamageIndicatorUI;
  private floatingRewardsUI!: FloatingRewardsUI;
  private boostEffectsUI!: BoostEffectsUI;
  
  private running = false;
  private lastFrameTime = 0;
  private frameCount = 0;
  private fpsUpdateTime = 0;
  private loggedIn = false;
  
  // UI elements - new HUD
  private loadingEl: HTMLElement | null;
  private topHudEl: HTMLElement | null;
  private hpHudEl: HTMLElement | null;
  private xpHudEl: HTMLElement | null;
  private weaponHudEl: HTMLElement | null;
  private boostHudEl: HTMLElement | null;
  private inventoryPanelEl: HTMLElement | null;
  private equipmentPanelEl: HTMLElement | null;
  private debugEl: HTMLElement | null;
  
  // Individual HUD components
  private hpFillEl: HTMLElement | null;
  private hpNumberEl: HTMLElement | null;
  private xpFillEl: HTMLElement | null;
  private xpNumberEl: HTMLElement | null = null;
  private boostFillEl: HTMLElement | null;
  private levelEl: HTMLElement | null;
  private xpEl: HTMLElement | null;
  private xpToNextEl: HTMLElement | null;
  private creditsEl: HTMLElement | null;
  private systemInfoEl: HTMLElement | null;
  private fpsEl: HTMLElement | null;
  private pingEl: HTMLElement | null;
  private entityCountEl: HTMLElement | null;
  private weaponLeftFillEl: HTMLElement | null;
  private weaponRightFillEl: HTMLElement | null;

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

  // Auth state
  private authToken: string | null = null;
  private isAdmin = false;
  private serverBaseUrl = '';  // Set when connecting to a server
  private lastAdminPanelUpdate = 0;  // throttle admin panel redraws

  // Ping graph
  private pingDisplayEl: HTMLElement | null;
  private pingTextEl: HTMLElement | null;
  private pingGraphCanvas: HTMLCanvasElement | null;
  private pingGraphCtx: CanvasRenderingContext2D | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
    this.network = new NetworkManager();
    this.input = new InputManager();
    this.state = new GameState();
    this.audio = new AudioManager();
    
    // Cache UI elements - new HUD structure
    this.loadingEl = document.getElementById('loading');
    this.topHudEl = document.getElementById('topHud');
    this.hpHudEl = document.getElementById('hpHud');
    this.xpHudEl = document.getElementById('xpHud');
    this.weaponHudEl = document.getElementById('weaponHud');
    this.boostHudEl = document.getElementById('boostHud');
    this.inventoryPanelEl = document.getElementById('inventoryPanel');
    this.equipmentPanelEl = document.getElementById('equipmentPanel');
    this.debugEl = document.getElementById('debug');
    
    // Individual components
    this.hpFillEl = document.getElementById('hpFill');
    this.hpNumberEl = document.getElementById('hpNumber');
    this.xpFillEl = document.getElementById('xpFill');
    this.boostFillEl = document.getElementById('boostFill');
    this.levelEl = document.getElementById('level');
    this.xpEl = document.getElementById('xp');
    this.xpToNextEl = document.getElementById('xpToNext');
    this.creditsEl = document.getElementById('credits');
    this.systemInfoEl = document.getElementById('systemInfo');
    this.fpsEl = document.getElementById('fps');
    this.pingEl = document.getElementById('ping');
    this.entityCountEl = document.getElementById('entity-count');
    this.weaponLeftFillEl = document.getElementById('weaponLeftFill');
    this.weaponRightFillEl = document.getElementById('weaponRightFill');
    
    // Chat elements
    this.chatMessagesEl = document.getElementById('chatMessages');
    this.chatInputEl = document.getElementById('chatInput') as HTMLInputElement;
    this.chatSendBtn = document.getElementById('chatSendBtn');

    // Ping display
    this.pingDisplayEl = document.getElementById('pingDisplay');
    this.pingTextEl = document.getElementById('pingText');
    this.pingGraphCanvas = document.getElementById('pingGraphCanvas') as HTMLCanvasElement;
    if (this.pingGraphCanvas) {
      this.pingGraphCtx = this.pingGraphCanvas.getContext('2d');
    }
  }

  async init(): Promise<void> {
    // Initialize PixiJS
    this.app = new Application();
    await this.app.init({
      width: window.innerWidth,
      height: window.innerHeight,
      backgroundColor: 0x000011,
      antialias: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
    });
    
    this.container.appendChild(this.app.canvas as HTMLCanvasElement);
    
    // Initialize renderer
    this.renderer = new Renderer(this.app, this.state);
    
    // Initialize UI components
    const uiOverlay = document.getElementById('ui-overlay')!;
    this.loginUI = new LoginUI(uiOverlay);
    this.serverBrowserUI = new ServerBrowserUI(uiOverlay);
    this.inventoryUI = new InventoryUI(uiOverlay);
    this.debugUI = new DebugUI(uiOverlay);
    this.killFeedUI = new KillFeedUI(uiOverlay);
    this.playerStatsUI = new PlayerStatsUI(uiOverlay);
    this.damageIndicatorUI = new DamageIndicatorUI(uiOverlay);
    this.floatingRewardsUI = new FloatingRewardsUI(uiOverlay);
    this.boostEffectsUI = new BoostEffectsUI(uiOverlay);
    
    // Setup login callbacks - show server browser after login
    this.loginUI.onLogin = (username, password) => this.handleLogin(username, password);
    this.loginUI.onRegister = (username, password, email) => this.handleRegister(username, password, email);
    this.loginUI.onPlayAsGuest = () => this.handleGuestPlay();
    
    // Setup server browser callbacks
    this.serverBrowserUI.onServerSelect = (server) => this.handleServerSelect(server);
    this.serverBrowserUI.onLogout = () => this.handleLogout();
    
    // Setup inventory callbacks
    this.inventoryUI.onEquip = (slot, equipSlot) => {
      this.network.send({ type: 'equip', inventorySlot: slot, equipSlot: equipSlot as any });
    };
    this.inventoryUI.onUnequip = (equipSlot) => {
      this.network.send({ type: 'unequip', equipSlot: equipSlot as any });
    };
    this.inventoryUI.onDropItem = (slot) => {
      this.network.send({ type: 'dropItem', inventorySlot: slot, count: 1 });
    };
    
    // Handle resize
    window.addEventListener('resize', () => this.onResize());
    
    // Set up network handlers
    this.network.onMessage = (msg) => this.handleServerMessage(msg);
    this.network.onConnect = () => this.onConnected();
    this.network.onDisconnect = () => this.onDisconnected();
    
    // Set up input handlers
    this.input.init(this.app.canvas as HTMLCanvasElement);
    this.input.onZoomChange = (zoom) => {
      this.renderer.setZoom(zoom);
      this.updateZoomDisplay();
    };
    this.input.onKeyPressed = (code) => this.handleKeyPress(code);
    
    // Setup chat
    this.setupChat();
    
    // Hide loading, show login
    if (this.loadingEl) this.loadingEl.style.display = 'none';
    
    console.log('Game initialized');
  }

  private async handleLogin(username: string, password: string): Promise<void> {
    this.loginUI.setLoading(true);
    this.loginUI.showError('');
    
    // Store credentials - auth happens after WebSocket connects
    this.state.playerName = username;
    (this as any)._pendingAuth = { type: 'login', username, password };
    this.loginUI.hide();
    this.serverBrowserUI.show();
  }

  private async handleRegister(username: string, password: string, email: string): Promise<void> {
    this.loginUI.setLoading(true);
    this.loginUI.showError('');
    
    // Store credentials - auth happens after WebSocket connects
    this.state.playerName = username;
    (this as any)._pendingAuth = { type: 'register', username, password, email };
    this.loginUI.hide();
    this.serverBrowserUI.show();
  }

  private handleGuestPlay(): void {
    const guestName = 'Guest_' + Math.floor(Math.random() * 10000);
    this.state.playerName = guestName;
    (this as any)._pendingAuth = { type: 'guest', username: guestName };
    this.loginUI.hide();
    this.serverBrowserUI.show();
  }

  private handleServerSelect(server: ServerInfo): void {
    this.serverBrowserUI.hide();
    if (this.loadingEl) {
      this.loadingEl.textContent = `Connecting to ${server.name}...`;
      this.loadingEl.style.display = 'block';
    }
    
    // Build WebSocket URL
    const protocol = server.secure ? 'wss' : 'ws';
    const httpProtocol = server.secure ? 'https' : 'http';
    const isFlyHost = /\.fly\.dev$/i.test(server.host);
    const shouldOmitPort = isFlyHost || (server.secure && (server.port === 443 || server.port === 80));
    
    const wsUrl = shouldOmitPort
      ? `${protocol}://${server.host}`
      : `${protocol}://${server.host}:${server.port}`;
    
    // Store HTTP base URL for auth requests
    this.serverBaseUrl = shouldOmitPort
      ? `${httpProtocol}://${server.host}`
      : `${httpProtocol}://${server.host}:${server.port}`;
    
    console.log('Connecting to WebSocket:', wsUrl);
    this.network.connect(wsUrl);
  }

  private handleLogout(): void {
    this.serverBrowserUI.hide();
    this.state.playerName = '';
    this.loginUI.show();
  }

  private connectToServer(username: string): void {
    this.state.playerName = username;
    this.loginUI.hide();
    if (this.loadingEl) {
      this.loadingEl.textContent = 'Connecting...';
      this.loadingEl.style.display = 'block';
    }
    
    // Connect to server
    const host = window.location.hostname || 'localhost';
    const wsUrl = `ws://${host}:3000`;
    console.log('Connecting to WebSocket:', wsUrl);
    this.network.connect(wsUrl);
  }

  start(): void {
    // Start game loop (but don't connect yet - wait for login)
    this.running = true;
    this.lastFrameTime = performance.now();
    this.app.ticker.add(() => this.update());
  }

  private handleKeyPress(code: string): void {
    // Escape key - reserved for future use
    if (code === 'Escape') {
      // Could close modals, menus, etc.
    }
    
    // Tab key - toggle stats panel
    if (code === 'Tab' && this.loggedIn) {
      this.playerStatsUI.toggle();
    }
    
    // Interact with E
    if (code === 'KeyE' && this.loggedIn) {
      this.network.send({ type: 'interact' });
    }
    
    // Tractor beam pickup with F
    if (code === 'KeyF' && this.loggedIn) {
      this.tryPickupNearbyItem();
    }
    
    // Reset zoom with Home
    if (code === 'Home') {
      this.input.resetZoom();
      this.renderer.setZoom(1);
      this.updateZoomDisplay();
    }
  }
  
  private tryPickupNearbyItem(): void {
    if (!this.state.playerId) return;
    
    const player = this.state.entities.get(this.state.playerId);
    if (!player) return;
    
    const TRACTOR_RANGE = 300;
    let closestItem: { id: number; distance: number } | null = null;
    
    // Find closest DroppedItem entity
    for (const [id, entity] of this.state.entities) {
      if (entity.type !== EntityType.DroppedItem) continue;
      
      const dx = entity.x - player.x;
      const dy = entity.y - player.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      
      if (dist <= TRACTOR_RANGE) {
        if (!closestItem || dist < closestItem.distance) {
          closestItem = { id, distance: dist };
        }
      }
    }
    
    if (closestItem) {
      this.network.send({ type: 'pickup', itemEntityId: closestItem.id });
    }
  }

  private update(): void {
    if (!this.running) return;
    
    const now = performance.now();
    const delta = (now - this.lastFrameTime) / 1000;
    this.lastFrameTime = now;
    
    // Update FPS counter
    this.frameCount++;
    if (now - this.fpsUpdateTime > 1000) {
      if (this.fpsEl) this.fpsEl.textContent = this.frameCount.toString();
      this.frameCount = 0;
      this.fpsUpdateTime = now;
    }
    
    // Update input (for zoom interpolation)
    this.input.update(delta);
    this.renderer.setZoom(this.input.zoom);
    
    // Tick-based input: accumulate time, run fixed-rate input ticks
    if (this.loggedIn && this.state.playerId && this.network.isConnected()) {
      // Cache estimated server tick ONCE per frame before tick loop.
      // This avoids EMA drift from calling getEstimatedServerTick multiple times.
      this.state.updateCachedServerTick();
      
      this.inputTickAccum += delta * 1000; // delta is in seconds
      let ticksRun = 0;
      while (this.inputTickAccum >= TICK_MS && ticksRun < 4) {
        this.tickInput();              // Sample input & queue with targetTick = cachedServerTick + delay
        this.state.drainDelayQueue();  // Apply inputs whose targetTick <= cachedServerTick, run physics ONCE
        this.state.advanceCachedTick(); // Increment cachedServerTick for next iteration
        this.inputTickAccum -= TICK_MS;
        ticksRun++;
      }
      // Update laser visual with the DRAINED (tick-accurate) fire state,
      // not the live mouse — this matches what the server actually processes.
      this.renderer.setLocalFireState(
        this.state.drainedFireLeft,
        this.state.drainedFireRight,
        this.state.drainedTargetAngle,
      );
      // Prevent spiral if tab was backgrounded
      if (this.inputTickAccum > TICK_MS * 4) {
        this.inputTickAccum = 0;
      }
    }
    
    // Interpolate entities
    this.state.interpolate(delta);
    
    // Update screen shake
    this.state.updateScreenShake(delta);
    
    // Update boost visual effects
    if (this.loggedIn && this.state.playerId) {
      const player = this.state.entities.get(this.state.playerId);
      if (player) {
        const isBoosting = (this.input.isKeyDown('ShiftLeft') || this.input.isKeyDown('ShiftRight')) 
          && this.state.boostFuel > 0 
          && (this.input.isKeyDown('KeyW') || this.input.isKeyDown('ArrowUp')); // Only show boost effect when actually thrusting
        const playerAngle = player.angle || 0;
        const playerSpeed = Math.sqrt((player.vx || 0) ** 2 + (player.vy || 0) ** 2);
        this.boostEffectsUI.setBoost(isBoosting, playerAngle, playerSpeed);
      }
    }
    
    // Update floating rewards with camera position
    if (this.loggedIn) {
      const playerPos = this.state.getPlayerPosition();
      const zoom = this.input.zoom;
      this.floatingRewardsUI.setCamera(playerPos.x, playerPos.y, zoom);
      this.damageIndicatorUI.setPlayerPosition(playerPos.x, playerPos.y);
    }
    
    // Update audio listener position
    const playerPos = this.state.getPlayerPosition();
    this.audio.setListenerPosition(playerPos.x, playerPos.y);
    
    // Update renderer
    this.renderer.update(delta);
    
    // Periodic state hash for snapshot-on-mismatch (1 Hz)
    if (this.loggedIn && this.state.playerId && this.network.isConnected()) {
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
          this.network.send({ type: 'stateHash', tick: this.state.serverTick, hash });
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
    const mouseWorld = this.renderer.screenToWorld(
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
    
    const rawAngle = Math.atan2(dy, dx);
    
    // Quantize angle to 13-bit precision — both client and server use
    // the same quantized value for hitscan, ensuring perfect agreement.
    // See CURSOR_STATE.md for bit layout and rationale.
    const quantized = quantizeCursorAngle(rawAngle);
    const targetAngle = dequantizeCursorAngle(quantized);
    
    const fireLeft = this.input.isMouseDown(0);
    const fireRight = this.input.isMouseDown(2);
    
    // Play weapon fire sound when starting to fire
    if (fireLeft && !this.lastFireLeft) {
      this.audio.play('laser', playerPos.x, playerPos.y);
      this.playerStatsUI.addShotFired();
    }
    if (fireRight && !this.lastFireRight) {
      this.audio.play('laser', playerPos.x, playerPos.y);
      this.playerStatsUI.addShotFired();
    }
    this.lastFireLeft = fireLeft;
    this.lastFireRight = fireRight;
    
    // Fire state is now passed to renderer AFTER drainDelayQueue() in the
    // update loop, using the drained (tick-accurate) angle rather than the
    // live mouse angle. This ensures the laser visual matches what the server
    // actually processes (N ticks delayed).
    
    const forward = this.input.isKeyDown('KeyW') || this.input.isKeyDown('ArrowUp');
    const backward = this.input.isKeyDown('KeyS') || this.input.isKeyDown('ArrowDown');
    const left = this.input.isKeyDown('KeyA') || this.input.isKeyDown('ArrowLeft');
    const right = this.input.isKeyDown('KeyD') || this.input.isKeyDown('ArrowRight');
    const boost = this.input.isKeyDown('ShiftLeft') || this.input.isKeyDown('ShiftRight');
    
    // Check if anything changed from last sent state
    const changed = forward !== this.lastSentForward
      || backward !== this.lastSentBackward
      || left !== this.lastSentLeft
      || right !== this.lastSentRight
      || boost !== this.lastSentBoost
      || fireLeft !== this.lastSentFireLeft
      || fireRight !== this.lastSentFireRight
      || quantized !== this.lastSentAngle;
    
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
    };
    
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
    } else {
      // Queue for delayed application (server also applies same input on same tick)
      this.state.predictTick(msg);
    }
  }

  private handleServerMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case 'welcome':
        this.state.playerId = msg.playerId;
        this.state.tickRate = msg.tickRate;
        this.loggedIn = true;
        console.log('Joined as player', msg.playerId);
        break;
        
      case 'pong':
        this.state.handlePong(msg.clientTime, msg.serverTime, msg.tick);
        if (this.pingEl) this.pingEl.textContent = this.state.ping.toString();
        if (this.pingTextEl) {
          const procText = msg.serverProcessing !== undefined ? ` | SRV: ${msg.serverProcessing}ms` : '';
          this.pingTextEl.textContent = `PING: ${this.state.ping}ms | JITTER: ${this.state.jitter}ms${procText}`;
        }
        this.drawPingGraph();
        break;
        
      case 'snapshot':
        this.state.applySnapshot(msg);
        if (this.entityCountEl) {
          this.entityCountEl.textContent = msg.entities.length.toString();
        }
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
        this.state.xp = msg.xp;
        this.state.level = msg.level;
        this.state.credits = msg.credits;
        // Clear deterministic asteroids on system change
        if (msg.systemId !== this.state.systemId) {
          this.state.clearDeterministicAsteroids();
        }
        this.state.systemId = msg.systemId;
        break;
        
      case 'inventory':
        this.state.inventory = msg.slots;
        this.state.equipment = msg.equipment;
        this.inventoryUI.update(msg.slots, msg.equipment);
        break;
        
      case 'damage':
        this.renderer.showDamageNumber(msg.targetId, msg.amount, msg.critical);
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
          // Find attacker position for directional indicator
          // For now, show generic indicator since we don't have attacker info
          const playerPos = this.state.getPlayerPosition();
          this.damageIndicatorUI.addDamage(
            playerPos.x + (Math.random() - 0.5) * 500,
            playerPos.y + (Math.random() - 0.5) * 500,
            Math.min(1, msg.amount / 50) // Normalize intensity
          );
          // Track damage taken
          this.playerStatsUI.addDamageTaken(msg.amount);
        } else {
          // Track damage dealt (assuming player dealt it for now)
          this.playerStatsUI.addDamageDealt(msg.amount);
          this.playerStatsUI.addShotHit();
        }
        // Play hit sound at target position
        const targetEntity = this.state.entities.get(msg.targetId);
        if (targetEntity) {
          this.audio.play('hit', targetEntity.x, targetEntity.y);
        }
        break;
        
      case 'asteroidSpawn':
        this.state.handleAsteroidSpawn(msg.tick, msg.asteroids);
        break;

      case 'asteroidSeed':
        this.state.handleAsteroidSeed(msg.tick, msg.systemId, msg.seed, msg.belt, msg.ids, msg.indices, msg.asteroidField);
        break;

      case 'asteroidDebug':
        this.renderer.showAsteroidDebug(msg.points, msg.durationMs);
        break;
        
      case 'death':
        if (msg.entityId === this.state.playerId) {
          this.renderer.showDeathScreen();
          this.audio.play('death', 0, 0); // Play at center (listener position)
          this.killFeedUI.addSystemMessage('You were destroyed');
        } else {
          this.renderer.showExplosion(msg.entityId);
          // Get dead entity info
          const deadEntity = this.state.entities.get(msg.entityId);
          if (deadEntity) {
            this.audio.play('explosion', deadEntity.x, deadEntity.y);
            // Check if it was an enemy defeated by local player
            if (deadEntity.type === EntityType.Enemy && deadEntity.name) {
              this.killFeedUI.addEnemyDefeat(this.state.playerName, deadEntity.name, true);
              this.playerStatsUI.addEnemyDefeated();
            }
          }
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
        this.handleAuthResult(msg as any);
        break;
        
      case 'adminStats':
        this.handleAdminStats(msg as any);
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
      if (e.key === 'Enter' && !this.chatFocused && this.network.isConnected()) {
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
  
  private addChatMessage(playerName: string, text: string, isSystem = false): void {
    if (!this.chatMessagesEl) return;
    
    const msgEl = document.createElement('div');
    msgEl.className = 'chat-message' + (isSystem ? ' system' : '');
    
    if (isSystem) {
      msgEl.textContent = text;
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
    if (this.loadingEl) this.loadingEl.style.display = 'none';
    
    // Show all HUD elements
    if (this.topHudEl) this.topHudEl.style.display = 'flex';
    if (this.hpHudEl) this.hpHudEl.style.display = 'flex';
    if (this.xpHudEl) this.xpHudEl.style.display = 'flex';
    if (this.weaponHudEl) this.weaponHudEl.style.display = 'flex';
    if (this.boostHudEl) this.boostHudEl.style.display = 'flex';
    // Show inventory UI (always visible when connected)
    this.inventoryUI.show();
    if (this.debugEl) this.debugEl.style.display = 'block';
    if (this.pingDisplayEl) this.pingDisplayEl.style.display = 'flex';
    
    // Send join/auth message based on pending auth state
    const pending = (this as any)._pendingAuth;
    if (pending) {
      if (pending.type === 'login') {
        this.network.send({ type: 'authLogin', username: pending.username, password: pending.password } as any);
      } else if (pending.type === 'register') {
        this.network.send({ type: 'authRegister', username: pending.username, email: pending.email, password: pending.password } as any);
      } else {
        // Guest
        this.network.send({ type: 'join', username: pending.username } as any);
      }
      (this as any)._pendingAuth = null;
    } else if (this.authToken) {
      // Reconnect with existing token
      this.network.send({ type: 'join', token: this.authToken, username: this.state.playerName } as any);
    } else {
      // Fallback guest
      this.network.send({ type: 'join', username: this.state.playerName || 'Player' } as any);
    }
    
    // Start ping loop
    setInterval(() => {
      this.network.send({
        type: 'ping',
        clientTime: Date.now(),
      });
    }, 2000);
  }

  private onDisconnected(): void {
    console.log('Disconnected from server');
    this.loggedIn = false;
    
    if (this.loadingEl) {
      this.loadingEl.textContent = 'Disconnected. Click to reconnect.';
      this.loadingEl.style.display = 'block';
      this.loadingEl.style.cursor = 'pointer';
      this.loadingEl.onclick = () => {
        this.loadingEl!.onclick = null;
        this.loadingEl!.style.cursor = 'default';
        this.loadingEl!.style.display = 'none';
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
    if (this.hpHudEl) this.hpHudEl.style.display = 'none';
    if (this.xpHudEl) this.xpHudEl.style.display = 'none';
    if (this.weaponHudEl) this.weaponHudEl.style.display = 'none';
    if (this.boostHudEl) this.boostHudEl.style.display = 'none';
    this.inventoryUI.hide();
  }

  private handleAuthResult(msg: { success: boolean; username?: string; token?: string; isAdmin?: boolean; error?: string }): void {
    if (msg.success) {
      console.log(`Authenticated as ${msg.username}${msg.isAdmin ? ' (admin)' : ''}`);
      if (msg.username) this.state.playerName = msg.username;
      if (msg.token) {
        this.authToken = msg.token;
        // Save token for reconnection
        try { localStorage.setItem('authToken', msg.token); } catch (e) {}
      }
      this.isAdmin = !!msg.isAdmin;
      
      // Show admin panel if admin
      if (this.isAdmin) {
        this.showAdminPanel();
      }
    } else {
      console.warn('Auth failed:', msg.error);
      this.addChatMessage('System', `Authentication failed: ${msg.error}`, true);
    }
  }

  // Admin stats state
  private adminPanel: HTMLElement | null = null;
  private lastAdminStats: any = null;

  private handleAdminStats(stats: any): void {
    this.lastAdminStats = stats;
    this.updateAdminPanel();
  }

  private showAdminPanel(): void {
    if (this.adminPanel) return;
    
    this.adminPanel = document.createElement('div');
    this.adminPanel.id = 'adminPanel';
    this.adminPanel.style.cssText = `
      position: fixed;
      top: 80px;
      right: 10px;
      width: 320px;
      max-height: 600px;
      overflow-y: auto;
      background: rgba(0, 0, 0, 0.85);
      border: 1px solid rgba(255, 100, 100, 0.5);
      border-radius: 8px;
      color: #eee;
      font-family: 'Courier New', monospace;
      font-size: 12px;
      padding: 10px;
      z-index: 1000;
      pointer-events: auto;
    `;
    this.adminPanel.innerHTML = '<div style="color: #ff6644; font-weight: bold; margin-bottom: 6px;">⚙ ADMIN PANEL</div><div id="adminStatsContent">Waiting for stats...</div>';
    document.body.appendChild(this.adminPanel);
  }

  private updateAdminPanel(): void {
    if (!this.adminPanel || !this.lastAdminStats) return;
    const s = this.lastAdminStats;
    
    const content = this.adminPanel.querySelector('#adminStatsContent');
    if (!content) return;
    
    const memColor = s.memoryMb > 500 ? '#ff4444' : s.memoryMb > 200 ? '#ffaa44' : '#44ff44';
    const tickColor = s.avgTickTimeMs > 10 ? '#ff4444' : s.avgTickTimeMs > 5 ? '#ffaa44' : '#44ff44';
    
    let playerRows = '';
    if (s.playerList && s.playerList.length > 0) {
      playerRows = s.playerList.map((p: any) => 
        `<tr><td>${p.id}</td><td>${this.escapeHtml(p.name)}</td><td>${p.ping}ms</td><td>${p.system}</td></tr>`
      ).join('');
    } else {
      playerRows = '<tr><td colspan="4" style="color: #888;">No players</td></tr>';
    }
    
    let errorRows = '';
    if (s.errors && s.errors.length > 0) {
      errorRows = s.errors.slice(-5).map((e: string) =>
        `<div style="color: #ff6666; font-size: 10px; word-break: break-all; margin: 2px 0;">${this.escapeHtml(e)}</div>`
      ).join('');
    }
    
    content.innerHTML = `
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 4px 12px;">
        <div>Tick:</div><div>${s.tick}</div>
        <div>Players:</div><div>${s.playerCount}</div>
        <div>Entities:</div><div>${s.entityCount}</div>
        <div>Tick Time:</div><div style="color: ${tickColor}">${s.avgTickTimeMs}ms avg / ${s.maxTickTimeMs}ms max</div>
        <div>Memory:</div><div style="color: ${memColor}">${s.memoryMb} MB</div>
        <div>Uptime:</div><div>${Math.floor(s.uptime / 60)}m ${Math.floor(s.uptime % 60)}s</div>
        <div>Bandwidth:</div><div>${(s.snapshotBytes / 1024).toFixed(1)} KB/s</div>
        <div>Total Conns:</div><div>${s.connectionsTotal}</div>
      </div>
      <div style="margin-top: 8px; color: #ff6644; font-weight: bold;">Players</div>
      <table style="width: 100%; border-collapse: collapse; font-size: 11px;">
        <tr style="color: #888;"><th>ID</th><th>Name</th><th>Ping</th><th>System</th></tr>
        ${playerRows}
      </table>
      ${s.bytesByType ? `<div style="margin-top: 8px; color: #ff6644; font-weight: bold;">Bandwidth Breakdown</div>
      <table style="width: 100%; border-collapse: collapse; font-size: 11px;">
        <tr style="color: #888;"><th style="text-align:left">Type</th><th style="text-align:right">KB/s</th><th style="text-align:right">%</th></tr>
        ${Object.entries(s.bytesByType as Record<string, number>)
          .sort(([,a], [,b]) => (b as number) - (a as number))
          .map(([type, bytes]) => {
            const kbs = ((bytes as number) / 1024).toFixed(1);
            const pct = s.snapshotBytes > 0 ? ((bytes as number) / s.snapshotBytes * 100).toFixed(0) : '0';
            const barWidth = s.snapshotBytes > 0 ? Math.round((bytes as number) / s.snapshotBytes * 100) : 0;
            return `<tr><td>${type}</td><td style="text-align:right">${kbs}</td><td style="text-align:right; position:relative;"><div style="position:absolute;left:0;top:0;bottom:0;width:${barWidth}%;background:rgba(100,200,255,0.15);border-radius:2px;"></div>${pct}%</td></tr>`;
          }).join('')}
      </table>` : ''}
      ${errorRows ? `<div style="margin-top: 8px; color: #ff6644; font-weight: bold;">Recent Errors</div>${errorRows}` : ''}
      <div style="margin-top: 8px; color: #ff6644; font-weight: bold;">Prediction Disagreement</div>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 2px 12px; font-size: 11px;">
        <div style="color:#aaa">Pre-recon:</div><div style="color:${this.predColor(this.state.predErrorPre)}">${this.state.predErrorPre.toFixed(1)}px (avg ${this.state.predErrorPreAvg.toFixed(1)}, max ${this.state.predErrorPreMax.toFixed(1)})</div>
        <div style="color:#aaa">Post-recon:</div><div style="color:${this.predColor(this.state.predErrorPost)}">${this.state.predErrorPost.toFixed(1)}px (avg ${this.state.predErrorPostAvg.toFixed(1)}, max ${this.state.predErrorPostMax.toFixed(1)})</div>
        <div style="color:#aaa">Vel error:</div><div style="color:${this.predColor(this.state.predVelError * 10)}">${this.state.predVelError.toFixed(3)} (avg ${this.state.predVelErrorAvg.toFixed(3)})</div>
        <div style="color:#aaa">Pending:</div><div>${this.state.predPendingCount}</div>
        <div style="color:#aaa">Snaps:</div><div style="color:${this.state.predSnapCount > 0 ? '#ff4444' : '#44ff44'}">${this.state.predSnapCount}</div>
        <div style="color:#aaa">Input delay:</div><div>${this.state.inputDelayTicks} ticks (${(this.state.inputDelayTicks * 16.67).toFixed(0)}ms) | estTick: ${this.state.cachedServerTick}</div>
      </div>
      <canvas id="predErrorGraph" width="300" height="40" style="width:100%;height:40px;margin-top:4px;background:rgba(0,0,0,0.3);border-radius:3px;"></canvas>
    `;
    
    // Draw prediction error mini-graph
    this.drawPredErrorGraph();
  }

  private predColor(val: number): string {
    if (val > 20) return '#ff4444';
    if (val > 8) return '#ffaa44';
    return '#44ff44';
  }

  private drawPredErrorGraph(): void {
    const canvas = document.getElementById('predErrorGraph') as HTMLCanvasElement;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    const history = this.state.predErrorHistory;
    if (history.length < 2) return;
    
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    
    // Find max for scaling (at least 5px so flat lines don't fill the canvas)
    const maxVal = Math.max(5, ...history);
    
    // Draw threshold lines
    ctx.strokeStyle = 'rgba(255,100,100,0.3)';
    ctx.setLineDash([3, 3]);
    const y20 = h - (20 / maxVal) * h;
    ctx.beginPath(); ctx.moveTo(0, y20); ctx.lineTo(w, y20); ctx.stroke();
    const y8 = h - (8 / maxVal) * h;
    ctx.strokeStyle = 'rgba(255,170,68,0.3)';
    ctx.beginPath(); ctx.moveTo(0, y8); ctx.lineTo(w, y8); ctx.stroke();
    ctx.setLineDash([]);
    
    // Draw error line
    ctx.beginPath();
    for (let i = 0; i < history.length; i++) {
      const x = (i / (history.length - 1)) * w;
      const y = h - (history[i] / maxVal) * h;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = '#6af';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  private updateUI(): void {
    // Refresh admin panel prediction stats at ~4Hz (not every frame)
    if (this.adminPanel) {
      const now = performance.now();
      if (now - this.lastAdminPanelUpdate > 250) {
        this.lastAdminPanelUpdate = now;
        this.updateAdminPanel();
      }
    }
    
    // HP Bar
    if (this.hpFillEl) {
      const healthPercent = (this.state.hp / this.state.maxHp) * 100;
      this.hpFillEl.style.width = `${healthPercent}%`;
    }
    if (this.hpNumberEl) {
      this.hpNumberEl.textContent = `${Math.round(this.state.hp)}/${Math.round(this.state.maxHp)}`;
    }
    
    // Boost Bar (vertical)
    if (this.boostFillEl) {
      const boostPercent = (this.state.boostFuel / this.state.maxBoostFuel) * 100;
      this.boostFillEl.style.height = `${boostPercent}%`;
    }
    
    // XP Bar
    const xpToNext = this.getXpToNextLevel(this.state.level);
    const xpProgress = this.state.xp / xpToNext;
    if (this.xpFillEl) {
      this.xpFillEl.style.width = `${xpProgress * 100}%`;
    }
    
    // Text values
    if (this.levelEl) this.levelEl.textContent = this.state.level.toString();
    if (this.xpEl) this.xpEl.textContent = this.state.xp.toString();
    if (this.xpToNextEl) this.xpToNextEl.textContent = xpToNext.toString();
    if (this.creditsEl) this.creditsEl.textContent = this.state.credits.toLocaleString();
    if (this.systemInfoEl) this.systemInfoEl.textContent = this.state.systemId || 'Unknown System';
  }

  private getXpToNextLevel(level: number): number {
    // XP formula: 100 * level^1.5
    return Math.floor(100 * Math.pow(level, 1.5));
  }

  private updateZoomDisplay(): void {
    // Zoom display removed from new HUD
  }

  private drawPingGraph(): void {
    const ctx = this.pingGraphCtx;
    const canvas = this.pingGraphCanvas;
    if (!ctx || !canvas) return;
    
    const w = canvas.width;   // 720 (2x retina)
    const h = canvas.height;  // 240
    
    // Layout: left margin for axis labels, bottom margin for time axis
    const marginLeft = 52;
    const marginBottom = 28;
    const marginTop = 24;
    const marginRight = 16;
    const plotW = w - marginLeft - marginRight;
    const plotH = h - marginTop - marginBottom;
    
    ctx.clearRect(0, 0, w, h);
    
    const pingData = this.state.pingGraphHistory;
    const jitterData = this.state.jitterGraphHistory;
    if (pingData.length < 2) return;
    
    // Determine scale — snap to nice grid intervals
    const rawMax = Math.max(20, ...pingData, ...jitterData);
    const niceIntervals = [10, 20, 25, 50, 100, 150, 200, 250, 500, 1000];
    let gridInterval = 10;
    let maxVal = 20;
    for (const interval of niceIntervals) {
      if (rawMax <= interval * 4) {
        gridInterval = interval;
        maxVal = interval * 4;
        break;
      }
    }
    if (rawMax > maxVal) {
      gridInterval = Math.ceil(rawMax / 4 / 50) * 50;
      maxVal = gridInterval * 4;
    }
    
    const scaleY = plotH / maxVal;
    const step = plotW / Math.max(1, pingData.length - 1);
    
    const toX = (i: number) => marginLeft + i * step;
    const toY = (v: number) => marginTop + plotH - v * scaleY;
    
    // ── Grid lines ──
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    for (let g = 0; g <= 4; g++) {
      const val = g * gridInterval;
      const y = toY(val);
      ctx.strokeStyle = g === 0 ? 'rgba(120,160,220,0.3)' : 'rgba(120,160,220,0.12)';
      ctx.beginPath();
      ctx.moveTo(marginLeft, y);
      ctx.lineTo(w - marginRight, y);
      ctx.stroke();
      
      // Axis label
      ctx.fillStyle = 'rgba(180,200,230,0.7)';
      ctx.font = '18px monospace';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${val}`, marginLeft - 8, y);
    }
    ctx.setLineDash([]);
    
    // ── "ms" label at top of Y axis ──
    ctx.fillStyle = 'rgba(180,200,230,0.5)';
    ctx.font = '16px monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText('ms', marginLeft - 8, marginTop - 2);
    
    // ── Time axis labels (seconds ago) ──
    const totalSamples = this.state.pingGraphHistory.length;
    const sampleIntervalSec = 2;  // ping every 2s
    ctx.fillStyle = 'rgba(180,200,230,0.5)';
    ctx.font = '16px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const timeLabels = 5;
    for (let t = 0; t < timeLabels; t++) {
      const frac = t / (timeLabels - 1);
      const idx = Math.round(frac * (pingData.length - 1));
      const secsAgo = (pingData.length - 1 - idx) * sampleIntervalSec;
      const x = toX(idx);
      const label = secsAgo === 0 ? 'now' : `-${secsAgo}s`;
      ctx.fillText(label, x, marginTop + plotH + 6);
    }
    
    // ── Jitter fill area ──
    ctx.beginPath();
    ctx.moveTo(toX(0), toY(0));
    for (let i = 0; i < jitterData.length; i++) {
      ctx.lineTo(toX(i), toY(jitterData[i]));
    }
    ctx.lineTo(toX(jitterData.length - 1), toY(0));
    ctx.closePath();
    ctx.fillStyle = 'rgba(255, 160, 60, 0.12)';
    ctx.fill();
    
    // ── Jitter line ──
    ctx.beginPath();
    for (let i = 0; i < jitterData.length; i++) {
      i === 0 ? ctx.moveTo(toX(i), toY(jitterData[i])) : ctx.lineTo(toX(i), toY(jitterData[i]));
    }
    ctx.strokeStyle = 'rgba(255, 160, 60, 0.7)';
    ctx.lineWidth = 2;
    ctx.stroke();
    
    // ── Ping line ──
    ctx.beginPath();
    for (let i = 0; i < pingData.length; i++) {
      i === 0 ? ctx.moveTo(toX(i), toY(pingData[i])) : ctx.lineTo(toX(i), toY(pingData[i]));
    }
    ctx.strokeStyle = 'rgba(100, 200, 255, 0.9)';
    ctx.lineWidth = 2.5;
    ctx.stroke();
    
    // ── Current value dots ──
    const lastPing = pingData[pingData.length - 1];
    const lastJitter = jitterData[jitterData.length - 1];
    const lastX = toX(pingData.length - 1);
    
    // Ping dot
    ctx.beginPath();
    ctx.arc(lastX, toY(lastPing), 4, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(100, 200, 255, 1)';
    ctx.fill();
    
    // Jitter dot
    ctx.beginPath();
    ctx.arc(lastX, toY(lastJitter), 3, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 160, 60, 1)';
    ctx.fill();
    
    // ── Legend (top-left of plot area) ──
    const legendX = marginLeft + 12;
    const legendY = marginTop + 8;
    ctx.font = 'bold 18px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    
    // Ping legend
    ctx.fillStyle = 'rgba(100, 200, 255, 0.9)';
    ctx.fillRect(legendX, legendY + 2, 16, 3);
    ctx.fillText(`Ping: ${lastPing}ms`, legendX + 22, legendY - 3);
    
    // Jitter legend
    ctx.fillStyle = 'rgba(255, 160, 60, 0.8)';
    ctx.fillRect(legendX, legendY + 22, 16, 3);
    ctx.fillText(`Jitter: ${lastJitter}ms`, legendX + 22, legendY + 17);
  }

  private showSystemMessage(text: string, color?: string): void {
    // TODO: Show floating message
    console.log(`[SYSTEM]: ${text}`);
  }

  private onResize(): void {
    this.app.renderer.resize(window.innerWidth, window.innerHeight);
    this.renderer.onResize();
  }
}
