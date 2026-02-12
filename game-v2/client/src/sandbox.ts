/**
 * Visual Sandbox - Modular dev tool with draggable windows
 * 
 * Features:
 * - Drag to pan, scroll to zoom (3x range)
 * - Tool picker (pan vs spawn mode)
 * - Draggable windows for each control category
 * - Comprehensive sliders for sun, glow, and stars
 * - Spawn only when explicitly selected
 * - Admin server connectivity for live server editing
 */

import { Application, Container, Graphics } from 'pixi.js';
import { BitBuffer, sunShaderDefs, SunShaderStyleDef } from '@space-game/common';
import { SunRenderer } from './rendering/SunRenderer';
import { GlowRenderer } from './rendering/GlowRenderer';
import { debugConfig } from './ui/DebugUI';

// Simplex noise constants
const SIMPLEX_F2 = 0.5 * (Math.sqrt(3) - 1);
const SIMPLEX_G2 = (3 - Math.sqrt(3)) / 6;
const SIMPLEX_GRAD = [[1,1],[-1,1],[1,-1],[-1,-1],[1,0],[-1,0],[0,1],[0,-1]];

// Star layer config
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

const STAR_LAYERS: StarLayerConfig[] = [
  { zMin: 400, zMax: 800, minSize: 6.0, maxSize: 10.0, baseCount: 4, minZoom: 0, noiseScale: 0.00008, noiseSeed: 100, noiseThreshold: 0.5 },
  { zMin: 800, zMax: 1500, minSize: 4.0, maxSize: 7.0, baseCount: 8, minZoom: 0.15, noiseScale: 0.00015, noiseSeed: 200, noiseThreshold: 0.5 },
  { zMin: 900, zMax: 1500, minSize: 2.5, maxSize: 4.5, baseCount: 10, minZoom: 0.25, noiseScale: 0.0008, noiseSeed: 300, noiseThreshold: 0 },
  { zMin: 1500, zMax: 2200, minSize: 1.5, maxSize: 3.0, baseCount: 14, minZoom: 0.4, noiseScale: 0.001, noiseSeed: 400, noiseThreshold: 0 },
  { zMin: 2200, zMax: 3000, minSize: 1.0, maxSize: 2.0, baseCount: 20, minZoom: 0.6, noiseScale: 0.0015, noiseSeed: 500, noiseThreshold: 0 },
  { zMin: 3000, zMax: 4500, minSize: 0.6, maxSize: 1.2, baseCount: 28, minZoom: 0.8, noiseScale: 0.002, noiseSeed: 600, noiseThreshold: 0 },
];

interface TestEntity {
  id: number;
  type: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  graphic: Container;
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

interface ElementParamDef {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
}

interface ElementDefinition {
  id: string;
  name: string;
  category: string;
  params: ElementParamDef[];
}

interface ElementInstance {
  id: number;
  defId: string;
  x: number;
  y: number;
  rotation: number;
  params: Record<string, number>;
  graphic: Graphics;
  hitRadius: number;
  lockToOrigin: boolean;
  sunRenderer?: SunRenderer;
  seed: number;
}

const ELEMENT_LIBRARY: ElementDefinition[] = [
  {
    id: 'sun',
    name: 'Sun',
    category: 'Star',
    params: [
      { key: 'radius', label: 'Radius', min: 200, max: 1400, step: 10, default: 600 },
      { key: 'hue', label: 'Hue', min: 0, max: 360, step: 1, default: 40 },
      { key: 'variant', label: 'Variant', min: 1, max: 5, step: 1, default: 1 },
      { key: 'noiseScale', label: 'Noise Scale', min: 0.2, max: 3, step: 0.1, default: 1.2 },
      { key: 'speed', label: 'Speed', min: 0, max: 3, step: 0.1, default: 1 },
    ],
  },
  {
    id: 'corona_soft',
    name: 'Corona (Soft Glow)',
    category: 'Star',
    params: [
      { key: 'radius', label: 'Radius', min: 150, max: 1400, step: 10, default: 700 },
      { key: 'thickness', label: 'Thickness', min: 10, max: 120, step: 2, default: 40 },
      { key: 'intensity', label: 'Intensity', min: 0, max: 1.5, step: 0.05, default: 0.85 },
      { key: 'hue', label: 'Hue', min: 0, max: 360, step: 1, default: 45 },
      { key: 'flicker', label: 'Flicker', min: 0, max: 2, step: 0.05, default: 0.6 },
    ],
  },
  {
    id: 'corona_streams',
    name: 'Corona (Plasma Streams)',
    category: 'Star',
    params: [
      { key: 'radius', label: 'Radius', min: 150, max: 1600, step: 10, default: 780 },
      { key: 'streams', label: 'Streams', min: 4, max: 18, step: 1, default: 8 },
      { key: 'width', label: 'Width', min: 6, max: 60, step: 2, default: 20 },
      { key: 'speed', label: 'Speed', min: 0, max: 2.5, step: 0.05, default: 1.1 },
      { key: 'intensity', label: 'Intensity', min: 0, max: 1.6, step: 0.05, default: 1.0 },
      { key: 'hue', label: 'Hue', min: 0, max: 360, step: 1, default: 30 },
    ],
  },
  {
    id: 'ambient_glow',
    name: 'Ambient Glow',
    category: 'Atmosphere',
    params: [
      { key: 'radius', label: 'Radius', min: 200, max: 2000, step: 20, default: 900 },
      { key: 'intensity', label: 'Intensity', min: 0, max: 1.2, step: 0.05, default: 0.5 },
      { key: 'falloff', label: 'Falloff', min: 0.2, max: 4, step: 0.1, default: 1.6 },
      { key: 'hue', label: 'Hue', min: 0, max: 360, step: 1, default: 220 },
    ],
  },
  {
    id: 'nebula',
    name: 'Nebula Cloud',
    category: 'Atmosphere',
    params: [
      { key: 'radius', label: 'Radius', min: 150, max: 1600, step: 20, default: 600 },
      { key: 'density', label: 'Density', min: 0.05, max: 0.6, step: 0.05, default: 0.25 },
      { key: 'hue', label: 'Hue', min: 0, max: 360, step: 1, default: 280 },
      { key: 'swirl', label: 'Swirl', min: 0, max: 1, step: 0.05, default: 0.6 },
      { key: 'contrast', label: 'Contrast', min: 0.2, max: 1.5, step: 0.05, default: 0.8 },
    ],
  },
  {
    id: 'black_hole',
    name: 'Black Hole',
    category: 'Anomaly',
    params: [
      { key: 'radius', label: 'Radius', min: 80, max: 700, step: 10, default: 260 },
      { key: 'disk', label: 'Disk Size', min: 20, max: 200, step: 5, default: 80 },
      { key: 'warp', label: 'Warp', min: 0, max: 1.5, step: 0.05, default: 0.7 },
      { key: 'glow', label: 'Glow', min: 0, max: 1.5, step: 0.05, default: 0.9 },
      { key: 'hue', label: 'Disk Hue', min: 0, max: 360, step: 1, default: 260 },
    ],
  },
  {
    id: 'wormhole',
    name: 'Wormhole',
    category: 'Anomaly',
    params: [
      { key: 'radius', label: 'Radius', min: 120, max: 800, step: 10, default: 320 },
      { key: 'rings', label: 'Rings', min: 4, max: 14, step: 1, default: 8 },
      { key: 'twist', label: 'Twist', min: 0, max: 1.5, step: 0.05, default: 0.8 },
      { key: 'intensity', label: 'Intensity', min: 0.2, max: 1.6, step: 0.05, default: 1.0 },
      { key: 'hue', label: 'Hue', min: 0, max: 360, step: 1, default: 190 },
    ],
  },
  {
    id: 'aurora_arc',
    name: 'Aurora Arc',
    category: 'Atmosphere',
    params: [
      { key: 'radius', label: 'Radius', min: 160, max: 1000, step: 10, default: 420 },
      { key: 'length', label: 'Arc Length', min: 40, max: 300, step: 5, default: 160 },
      { key: 'thickness', label: 'Thickness', min: 6, max: 60, step: 2, default: 20 },
      { key: 'shimmer', label: 'Shimmer', min: 0, max: 1.5, step: 0.05, default: 0.7 },
      { key: 'hue', label: 'Hue', min: 0, max: 360, step: 1, default: 140 },
    ],
  },
  {
    id: 'comet',
    name: 'Comet',
    category: 'Object',
    params: [
      { key: 'radius', label: 'Radius', min: 20, max: 140, step: 2, default: 38 },
      { key: 'tail', label: 'Tail Length', min: 40, max: 360, step: 5, default: 140 },
      { key: 'width', label: 'Tail Width', min: 6, max: 80, step: 2, default: 26 },
      { key: 'sparkle', label: 'Sparkle', min: 0, max: 1.2, step: 0.05, default: 0.5 },
      { key: 'hue', label: 'Hue', min: 0, max: 360, step: 1, default: 210 },
    ],
  },
  {
    id: 'asteroid_belt',
    name: 'Asteroid Belt',
    category: 'Field',
    params: [
      { key: 'radius', label: 'Radius', min: 200, max: 1600, step: 20, default: 620 },
      { key: 'thickness', label: 'Thickness', min: 40, max: 320, step: 10, default: 120 },
      { key: 'count', label: 'Count', min: 40, max: 240, step: 10, default: 120 },
      { key: 'variation', label: 'Variation', min: 0, max: 1, step: 0.05, default: 0.6 },
      { key: 'hue', label: 'Hue', min: 0, max: 360, step: 1, default: 30 },
    ],
  },
];

const SUN_VARIANTS = [
  {
    name: 'Boiling Cells',
    sunStyle: 0,
    sunParams: [0.64, 0.9, 1.4, 0.85, 1.4, 0.55],
    coronaStyle: 0,
    coronaParams: [1.0, 1.4, 1.0, 0.2, 0.2, 0.6],
  },
  {
    name: 'Chromosphere',
    sunStyle: 1,
    sunParams: [0.5, 0.6, 1.0, 0.35, 1.0, 0.35],
    coronaStyle: 0,
    coronaParams: [1.0, 2.2, 0.8, 0.2, 0.2, 0.4],
  },
  {
    name: 'White Dwarf',
    sunStyle: 2,
    sunParams: [0.42, 0.3, 1.8, 0.2, 1.6, 0.75],
    coronaStyle: 0,
    coronaParams: [1.0, 1.2, 1.4, 0.25, 0.2, 0.4],
  },
  {
    name: 'Polar Storm',
    sunStyle: 3,
    sunParams: [0.52, 1.2, 1.1, 0.9, 1.5, 0.6],
    coronaStyle: 1,
    coronaParams: [1.0, 10, 0.14, 1.8, 0.8, 0.7],
  },
  {
    name: 'Iron Sun',
    sunStyle: 4,
    sunParams: [0.7, 0.2, 0.8, 0.35, 1.0, 0.3],
    coronaStyle: 0,
    coronaParams: [1.0, 1.6, 0.7, 0.2, 0.2, 0.3],
  },
];

class VisualSandbox {
  private app!: Application;
  private worldContainer!: Container;
  private backgroundContainer!: Container;
  private elementContainer!: Container;
  private entityContainer!: Container;
  private effectContainer!: Container;
  private gridGraphics!: Graphics;
  
  // Camera
  private cameraX = 0;
  private cameraY = 0;
  private cameraZoom = 1;
  private readonly MIN_ZOOM = 0.03;  // 3x more range
  private readonly MAX_ZOOM = 15;
  
  // Panning
  private isPanning = false;
  private panStartX = 0;
  private panStartY = 0;
  private panStartCamX = 0;
  private panStartCamY = 0;
  
  // Tool state
  private currentTool: 'pan' | 'spawn' = 'pan';
  private elementTool: 'move' | 'scale' | 'rotate' | 'params' = 'move';
  private activeDragElementId: number | null = null;
  private dragOffsetX = 0;
  private dragOffsetY = 0;
  private dragStartRadius = 0;
  private dragStartDistance = 0;
  private dragStartRotation = 0;
  private dragStartAngle = 0;
  private selectedSpawnType: string | null = null;
  
  // Starfield
  private starCache: Map<string, StarData[]> = new Map();
  private starsGraphics!: Graphics;
  private readonly STARFIELD_FOCAL = 1000;
  private readonly STARFIELD_SNAP = 3000;
  private layerEnabled: boolean[] = [true, true, true, true, true, true];
  
  // GPU renderers
  private sunRenderer!: SunRenderer;
  private glowRenderer!: GlowRenderer;
  
  // Config values
  public config = {
    // Sun
    sunHue: 40,
    sunRadius: 1000,
    sunSpeed: 1.0,
    sunNoise: 1.0,
    coronaSize: 2.2,
    coronaIntensity: 0.7,
    sunStyle: 'granular',
    sunStyleParams: {} as Record<string, number>,
    coronaStyle: 'plasmaStreams',
    coronaStyleParams: {} as Record<string, number>,
    
    // Glow
    glowIntensity: 0.6,
    glowRadius: 8000,
    glowParallax: 0.00005,
    glowSpeed: 1.0,
    glowRipple: 1.0,
    
    // Stars
    starBrightness: 1.0,
    starHueShift: 0,
    starDensity: 1.0,
    starTwinkleSpeed: 2.0,
    starTwinkleAmt: 0.3,
  };
  
  // Entities
  private entities: Map<number, TestEntity> = new Map();
  private particles: Particle[] = [];
  private nextEntityId = 1;
  private elements: Map<number, ElementInstance> = new Map();
  private nextElementId = 1;
  private selectedElementId: number | null = null;
  private elementClipboard: string | null = null;
  private undoStack: string[] = [];
  private readonly MAX_UNDO = 30;
  private showGrid = true;
  private snapToGrid = true;
  private gridSize = 100;
  
  // Timing
  private time = 0;
  private animTime = 0;
  private frameCount = 0;
  private lastFpsUpdate = 0;
  private fps = 0;
  
  // Admin server connection
  private adminWs: WebSocket | null = null;
  private adminConnected = false;
  private adminAuthenticated = false;
  private adminToken: string | null = null;
  private serverStats: { tick: number; playerCount: number; entityCount: number; tickTime: number; uptime: number } | null = null;
  
  async init() {
    const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
    
    this.app = new Application();
    await this.app.init({
      canvas,
      width: window.innerWidth,
      height: window.innerHeight,
      backgroundColor: 0x000000,
      antialias: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
    });
    
    // Setup containers
    this.worldContainer = new Container();
    this.backgroundContainer = new Container();
    this.elementContainer = new Container();
    this.entityContainer = new Container();
    this.effectContainer = new Container();
    this.starsGraphics = new Graphics();
    this.gridGraphics = new Graphics();
    
    this.worldContainer.addChild(this.backgroundContainer);
    this.worldContainer.addChild(this.elementContainer);
    this.worldContainer.addChild(this.entityContainer);
    this.worldContainer.addChild(this.effectContainer);
    this.app.stage.addChild(this.worldContainer);
    
    this.backgroundContainer.addChild(this.starsGraphics);
    this.backgroundContainer.addChild(this.gridGraphics);
    
    // Initialize GPU renderers
    this.glowRenderer = new GlowRenderer();
    this.glowRenderer.initialize();
    this.backgroundContainer.addChild(this.glowRenderer.getContainer());
    this.glowRenderer.getContainer().visible = false;
    
    this.sunRenderer = new SunRenderer();
    this.sunRenderer.initialize();
    this.backgroundContainer.addChild(this.sunRenderer.getContainer());
    this.sunRenderer.getContainer().visible = false;
    
    // Setup
    this.setupCanvasInput();
    this.setupWindowDragging();
    this.setupToolbar();
    this.setupToolPanel();
    this.setupControls();
    this.setupSpawnButtons();
    this.setupElementLibrary();
    this.pushUndo();
    this.setupServerBrowser();
    this.connectToAdmin();
    
    window.addEventListener('resize', () => this.onResize());
    this.app.ticker.add(() => this.update());
    
    console.log('Visual Sandbox initialized');
  }
  
  // ============================================
  // SERVER BROWSER
  // ============================================
  
  private serverBrowserUrl = 'https://spacegame-v2.fly.dev';
  
  private setupServerBrowser() {
    const refreshBtn = document.getElementById('refresh-servers-btn');
    const listContainer = document.getElementById('server-browser-list');
    
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => this.refreshServerList());
    }
    
    // Auto-refresh on load
    this.refreshServerList();
  }
  
  private async refreshServerList() {
    const listContainer = document.getElementById('server-browser-list');
    if (!listContainer) return;
    
    listContainer.innerHTML = '<div style="color: #888; font-size: 11px;">Loading servers...</div>';
    
    try {
      const response = await fetch(`${this.serverBrowserUrl}/list`);
      const data = await response.json();
      
      if (!data.servers || data.servers.length === 0) {
        listContainer.innerHTML = '<div style="color: #666; font-size: 11px;">No servers available</div>';
        return;
      }
      
      listContainer.innerHTML = '';
      
      for (const server of data.servers) {
        const serverEl = document.createElement('div');
        serverEl.style.cssText = `
          display: flex; justify-content: space-between; align-items: center;
          padding: 8px; margin-bottom: 4px; background: #1a1a24;
          border: 1px solid #2a2a3a; border-radius: 4px; cursor: pointer;
          transition: background 0.2s;
        `;
        serverEl.onmouseover = () => serverEl.style.background = '#252535';
        serverEl.onmouseout = () => serverEl.style.background = '#1a1a24';
        
        // Use adminPort from server info, or fallback to 3001
        const adminPort = server.adminPort || 3001;
        const protocol = server.secure ? 'wss' : 'ws';
        const adminUrl = `${protocol}://${server.host}:${adminPort}`;
        const hasAdmin = !!server.adminPort;
        
        serverEl.innerHTML = `
          <div>
            <div style="font-size: 11px; color: #fff;">${server.name || 'Unknown'}</div>
            <div style="font-size: 9px; color: #666;">${server.region || 'unknown'} • ${server.players}/${server.maxPlayers}${hasAdmin ? ' • 🔧' : ''}</div>
          </div>
          <button class="spawn-btn" style="font-size: 10px; padding: 4px 8px;" ${!hasAdmin ? 'disabled' : ''}>Admin</button>
        `;
        
        const btn = serverEl.querySelector('button');
        if (btn && hasAdmin) {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const urlInput = document.getElementById('admin-url') as HTMLInputElement;
            if (urlInput) {
              urlInput.value = adminUrl;
            }
          });
        }
        
        listContainer.appendChild(serverEl);
      }
    } catch (e) {
      console.error('Failed to fetch server list:', e);
      listContainer.innerHTML = '<div style="color: #f55; font-size: 11px;">Failed to load servers</div>';
    }
  }
  
  // ============================================
  // ADMIN SERVER CONNECTION
  // ============================================
  
  private connectToAdmin() {
    const statusEl = document.getElementById('admin-status');
    const connectBtn = document.getElementById('admin-connect-btn');
    const urlInput = document.getElementById('admin-url') as HTMLInputElement;
    const passwordInput = document.getElementById('admin-password') as HTMLInputElement;
    const loginBtn = document.getElementById('admin-login-btn');
    const loginSection = document.getElementById('admin-login-section');
    const controlsSection = document.getElementById('admin-controls-section');
    
    const updateUI = () => {
      if (statusEl) {
        if (this.adminAuthenticated) {
          statusEl.textContent = '🟢 Authenticated';
        } else if (this.adminConnected) {
          statusEl.textContent = '🟡 Connected (login required)';
        } else {
          statusEl.textContent = '🔴 Disconnected';
        }
      }
      if (loginSection) loginSection.style.display = this.adminConnected && !this.adminAuthenticated ? 'block' : 'none';
      if (controlsSection) controlsSection.style.display = this.adminAuthenticated ? 'block' : 'none';
      if (connectBtn) connectBtn.textContent = this.adminConnected ? 'Disconnect' : 'Connect';
      if (urlInput) urlInput.disabled = this.adminConnected;
    };
    
    const connect = () => {
      try {
        const url = urlInput?.value || 'ws://localhost:3001';
        this.adminWs = new WebSocket(url);
        
        this.adminWs.onopen = () => {
          this.adminConnected = true;
          this.adminAuthenticated = false;
          updateUI();
          console.log('🔧 Connected to admin server (awaiting auth)');
        };
        
        this.adminWs.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data);
            this.handleAdminMessage(msg, updateUI);
          } catch (e) {
            console.error('Admin message parse error:', e);
          }
        };
        
        this.adminWs.onclose = () => {
          this.adminConnected = false;
          this.adminAuthenticated = false;
          this.adminWs = null;
          this.adminToken = null;
          updateUI();
          console.log('🔧 Disconnected from admin server');
        };
        
        this.adminWs.onerror = () => {
          console.log('🔧 Admin server not available');
          this.adminConnected = false;
          this.adminAuthenticated = false;
          updateUI();
        };
      } catch (e) {
        if (statusEl) statusEl.textContent = '🔴 Error';
      }
    };
    
    // Connect button
    if (connectBtn) {
      connectBtn.addEventListener('click', () => {
        if (this.adminConnected && this.adminWs) {
          this.adminWs.close();
        } else {
          connect();
        }
      });
    }
    
    // Login button
    if (loginBtn && passwordInput) {
      const doLogin = () => {
        const password = passwordInput.value;
        if (password && this.adminWs && this.adminConnected) {
          this.adminWs.send(JSON.stringify({ type: 'auth', password }));
        }
      };
      
      loginBtn.addEventListener('click', doLogin);
      passwordInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') doLogin();
      });
    }
    
    // Auto-connect on load
    connect();
  }
  
  private handleAdminMessage(msg: { type: string; data?: any; token?: string; error?: string }, updateUI: () => void) {
    switch (msg.type) {
      case 'authSuccess':
        this.adminAuthenticated = true;
        this.adminToken = msg.token || null;
        console.log('🔧 Admin authenticated!');
        updateUI();
        break;
        
      case 'authFailed':
        console.log('🔧 Admin auth failed:', msg.error);
        alert('Authentication failed: ' + (msg.error || 'Invalid password'));
        break;
        
      case 'config':
        console.log('🔧 Received server config:', msg.data);
        break;
        
      case 'stats':
        this.serverStats = msg.data;
        this.updateServerStatsUI();
        break;
        
      case 'error':
        console.error('🔧 Admin error:', msg.error);
        break;
    }
  }
  
  private updateServerStatsUI() {
    const statsEl = document.getElementById('server-stats');
    if (statsEl && this.serverStats) {
      const s = this.serverStats;
      statsEl.innerHTML = `
        Tick: ${s.tick} | 
        Players: ${s.playerCount} | 
        Entities: ${s.entityCount} | 
        Tick: ${s.tickTime.toFixed(2)}ms | 
        Uptime: ${Math.floor(s.uptime / 1000)}s
      `;
    }
  }
  
  private sendToAdmin(type: string, data: any) {
    if (this.adminWs && this.adminConnected && this.adminAuthenticated) {
      this.adminWs.send(JSON.stringify({ type, data }));
    }
  }
  
  /**
   * Push current sandbox config to the server
   */
  private pushConfigToServer() {
    this.sendToAdmin('configUpdate', this.config);
  }
  
  /**
   * Execute an admin command on the server
   */
  private executeAdminCommand(command: string, args: any = {}) {
    this.sendToAdmin('command', { command, args });
  }
  
  private setupCanvasInput() {
    const canvas = this.app.canvas;
    
    // Mouse down - start pan or spawn
    canvas.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;

      const worldPos = this.screenToWorld(e.clientX, e.clientY);
      const hit = this.pickElementAt(worldPos.x, worldPos.y);
      if (hit) {
        this.selectElement(hit.id);

        if (this.elementTool === 'move') {
          this.activeDragElementId = hit.id;
          this.dragOffsetX = worldPos.x - hit.x;
          this.dragOffsetY = worldPos.y - hit.y;
        } else if (this.elementTool === 'scale') {
          this.activeDragElementId = hit.id;
          const dx = worldPos.x - hit.x;
          const dy = worldPos.y - hit.y;
          this.dragStartDistance = Math.max(1, Math.sqrt(dx * dx + dy * dy));
          this.dragStartRadius = hit.params.radius ?? 100;
        } else if (this.elementTool === 'rotate') {
          this.activeDragElementId = hit.id;
          const dx = worldPos.x - hit.x;
          const dy = worldPos.y - hit.y;
          this.dragStartAngle = Math.atan2(dy, dx);
          this.dragStartRotation = hit.rotation;
        }

        return;
      }

      if (this.currentTool === 'pan') {
        this.isPanning = true;
        this.panStartX = e.clientX;
        this.panStartY = e.clientY;
        this.panStartCamX = this.cameraX;
        this.panStartCamY = this.cameraY;
        canvas.classList.add('panning');
      } else if (this.currentTool === 'spawn' && this.selectedSpawnType) {
        this.spawnAtPosition(this.selectedSpawnType, worldPos.x, worldPos.y);
      }
    });
    
    // Mouse move - pan
    canvas.addEventListener('mousemove', (e) => {
      if (this.isPanning) {
        const dx = (e.clientX - this.panStartX) / this.cameraZoom;
        const dy = (e.clientY - this.panStartY) / this.cameraZoom;
        this.cameraX = this.panStartCamX - dx;
        this.cameraY = this.panStartCamY - dy;
        return;
      }

      if (this.activeDragElementId !== null) {
        const element = this.elements.get(this.activeDragElementId);
        if (!element) return;
        const worldPos = this.screenToWorld(e.clientX, e.clientY);

        if (this.elementTool === 'move') {
          let nx = worldPos.x - this.dragOffsetX;
          let ny = worldPos.y - this.dragOffsetY;
          if (this.snapToGrid) {
            nx = Math.round(nx / this.gridSize) * this.gridSize;
            ny = Math.round(ny / this.gridSize) * this.gridSize;
          }
          element.x = nx;
          element.y = ny;
        } else if (this.elementTool === 'scale') {
          const dx = worldPos.x - element.x;
          const dy = worldPos.y - element.y;
          const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
          const ratio = dist / this.dragStartDistance;
          const radiusParam = element.params.radius ?? 100;
          const def = ELEMENT_LIBRARY.find((d) => d.id === element.defId);
          const radiusDef = def?.params.find((p) => p.key === 'radius');
          let newRadius = this.dragStartRadius * ratio;
          if (radiusDef) {
            newRadius = Math.max(radiusDef.min, Math.min(radiusDef.max, newRadius));
          }
          element.params.radius = newRadius;
        } else if (this.elementTool === 'rotate') {
          const dx = worldPos.x - element.x;
          const dy = worldPos.y - element.y;
          const ang = Math.atan2(dy, dx);
          element.rotation = this.dragStartRotation + (ang - this.dragStartAngle);
        }

        this.drawElementGraphic(element);
      }
    });
    
    // Mouse up - stop pan
    window.addEventListener('mouseup', () => {
      if (this.activeDragElementId !== null) {
        this.pushUndo();
      }
      this.activeDragElementId = null;
      this.isPanning = false;
      canvas.classList.remove('panning');
    });
    
    // Scroll - zoom
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
      this.cameraZoom = Math.max(this.MIN_ZOOM, Math.min(this.MAX_ZOOM, this.cameraZoom * zoomFactor));
    });

    // Drag from library onto canvas
    canvas.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    });

    canvas.addEventListener('drop', (e) => {
      e.preventDefault();
      const defId = e.dataTransfer?.getData('text/element-id');
      if (!defId) return;
      const worldPos = this.screenToWorld(e.clientX, e.clientY);
      this.spawnElement(defId, worldPos.x, worldPos.y);
    });
    
    // Keyboard
    window.addEventListener('keydown', (e) => {
      if (e.key === 'R' && e.shiftKey) {
        this.resetView();
      }
      if (e.key === 'g' || e.key === 'G') {
        this.setElementTool('move');
      }
      if (e.key === 's' || e.key === 'S') {
        this.setElementTool('scale');
      }
      if (e.key === 'r' || e.key === 'R') {
        this.setElementTool('rotate');
      }
      if (e.key === 'p' || e.key === 'P') {
        this.setElementTool('params');
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        this.deleteSelectedElement();
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'd' || e.key === 'D')) {
        e.preventDefault();
        this.duplicateSelectedElement();
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) {
        e.preventDefault();
        this.copySelectedElement();
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V')) {
        e.preventDefault();
        this.pasteSelectedElement();
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        this.undo();
      }
      if (e.key === 'f' || e.key === 'F') {
        this.focusSelectedElement();
      }
      // Number keys toggle windows
      if (e.key === '1') this.toggleWindow('library');
      if (e.key === '2') this.toggleWindow('element');
      if (e.key === '3') this.toggleWindow('spawn');
      if (e.key === '4') this.toggleWindow('admin');
    });
  }
  
  private screenToWorld(screenX: number, screenY: number): { x: number; y: number } {
    const rect = this.app.canvas.getBoundingClientRect();
    const x = (screenX - rect.left - this.app.renderer.width / 2) / this.cameraZoom + this.cameraX;
    const y = (screenY - rect.top - this.app.renderer.height / 2) / this.cameraZoom + this.cameraY;
    return { x, y };
  }
  
  private setupWindowDragging() {
    document.querySelectorAll('.window').forEach((win) => {
      const header = win.querySelector('.window-header') as HTMLElement;
      const closeBtn = win.querySelector('.window-close') as HTMLElement;
      const windowEl = win as HTMLElement;
      
      let isDragging = false;
      let startX = 0;
      let startY = 0;
      let startLeft = 0;
      let startTop = 0;
      
      header.addEventListener('mousedown', (e) => {
        if (e.target === closeBtn) return;
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        startLeft = windowEl.offsetLeft;
        startTop = windowEl.offsetTop;
        // Bring to front
        document.querySelectorAll('.window').forEach((w) => (w as HTMLElement).style.zIndex = '1000');
        windowEl.style.zIndex = '1001';
      });
      
      window.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        windowEl.style.left = `${startLeft + dx}px`;
        windowEl.style.top = `${startTop + dy}px`;
        windowEl.style.right = 'auto';
      });
      
      window.addEventListener('mouseup', () => {
        isDragging = false;
      });
      
      closeBtn.addEventListener('click', () => {
        windowEl.classList.remove('visible');
        // Deactivate toolbar button
        const windowId = windowEl.id.replace('window-', '');
        document.querySelector(`.toolbar-btn[data-window="${windowId}"]`)?.classList.remove('active');
      });
    });
  }
  
  private setupToolbar() {
    // Tool buttons
    document.querySelectorAll('.toolbar-btn[data-tool]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tool = btn.getAttribute('data-tool') as 'pan' | 'spawn';
        this.setTool(tool);
      });
    });
    
    // Window toggle buttons
    document.querySelectorAll('.toolbar-btn[data-window]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const windowId = btn.getAttribute('data-window')!;
        this.toggleWindow(windowId);
        btn.classList.toggle('active');
      });
    });
    
    // Action buttons
    document.querySelectorAll('.toolbar-btn[data-action]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const action = btn.getAttribute('data-action');
        if (action === 'reset') this.resetView();
      });
    });
  }

  private setupToolPanel() {
    document.querySelectorAll('.tool-btn[data-toolmode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = btn.getAttribute('data-toolmode') as 'move' | 'scale' | 'rotate' | 'params';
        this.setElementTool(mode);
      });
    });
    this.setElementTool(this.elementTool);
  }

  private setElementTool(tool: 'move' | 'scale' | 'rotate' | 'params') {
    this.elementTool = tool;
    document.querySelectorAll('.tool-btn[data-toolmode]').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-toolmode') === tool);
    });

    if (tool === 'params') {
      this.toggleWindow('element');
    }
  }
  
  private setTool(tool: 'pan' | 'spawn') {
    this.currentTool = tool;
    const canvas = this.app.canvas;
    
    document.querySelectorAll('.toolbar-btn[data-tool]').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-tool') === tool);
    });
    
    canvas.classList.remove('tool-spawn');
    if (tool === 'spawn') {
      canvas.classList.add('tool-spawn');
    }
  }
  
  private toggleWindow(windowId: string) {
    const win = document.getElementById(`window-${windowId}`);
    if (win) {
      win.classList.toggle('visible');
    }
  }
  
  private setupControls() {
    // Sun
    this.bindSlider('sun-hue', (v) => this.config.sunHue = v);
    this.bindSlider('sun-radius', (v) => this.config.sunRadius = v);
    this.bindSlider('sun-speed', (v) => this.config.sunSpeed = v);
    this.bindSlider('sun-noise', (v) => this.config.sunNoise = v);
    this.bindSlider('corona-size', (v) => this.config.coronaSize = v);
    this.bindSlider('corona-intensity', (v) => this.config.coronaIntensity = v);
    
    // Glow
    this.bindSlider('glow-intensity', (v) => this.config.glowIntensity = v);
    this.bindSlider('glow-radius', (v) => this.config.glowRadius = v);
    this.bindSlider('glow-parallax', (v) => {
      this.config.glowParallax = v;
      debugConfig.parallaxScale = v;
    });
    this.bindSlider('glow-speed', (v) => this.config.glowSpeed = v);
    this.bindSlider('glow-ripple', (v) => this.config.glowRipple = v);
    
    // Stars
    this.bindSlider('star-brightness', (v) => this.config.starBrightness = v);
    this.bindSlider('star-hue', (v) => this.config.starHueShift = v);
    this.bindSlider('star-density', (v) => {
      this.config.starDensity = v;
      this.starCache.clear(); // Regenerate stars
    });
    this.bindSlider('star-twinkle', (v) => this.config.starTwinkleSpeed = v);
    this.bindSlider('star-twinkle-amt', (v) => this.config.starTwinkleAmt = v);
    
    // Star layer toggles
    for (let i = 0; i < 6; i++) {
      const checkbox = document.getElementById(`star-layer-${i}`) as HTMLInputElement;
      if (checkbox) {
        checkbox.addEventListener('change', () => {
          this.layerEnabled[i] = checkbox.checked;
        });
      }
    }

    this.setupShaderStyleControls();

    const showGrid = document.getElementById('editor-show-grid') as HTMLInputElement | null;
    const snapGrid = document.getElementById('editor-snap-grid') as HTMLInputElement | null;
    const gridSize = document.getElementById('editor-grid-size') as HTMLInputElement | null;
    const gridSizeVal = document.getElementById('editor-grid-size-val');
    if (showGrid) {
      showGrid.checked = this.showGrid;
      showGrid.addEventListener('change', () => {
        this.showGrid = showGrid.checked;
      });
    }
    if (snapGrid) {
      snapGrid.checked = this.snapToGrid;
      snapGrid.addEventListener('change', () => {
        this.snapToGrid = snapGrid.checked;
      });
    }
    if (gridSize && gridSizeVal) {
      gridSize.value = this.gridSize.toString();
      gridSizeVal.textContent = this.gridSize.toString();
      gridSize.addEventListener('input', () => {
        this.gridSize = parseInt(gridSize.value, 10) || 100;
        gridSizeVal.textContent = this.gridSize.toString();
      });
    }

    document.getElementById('elements-save')?.addEventListener('click', () => {
      this.saveElementsToFile();
    });
    const loadBtn = document.getElementById('elements-load');
    const loadInput = document.getElementById('elements-load-input') as HTMLInputElement | null;
    if (loadBtn && loadInput) {
      loadBtn.addEventListener('click', () => loadInput.click());
      loadInput.addEventListener('change', () => this.loadElementsFromFile(loadInput));
    }
  }

  private setupElementLibrary() {
    const library = document.getElementById('element-library');
    if (!library) return;

    library.innerHTML = '';

    for (const def of ELEMENT_LIBRARY) {
      const item = document.createElement('div');
      item.className = 'library-item';
      item.setAttribute('draggable', 'true');
      item.dataset.elementId = def.id;

      const canvas = document.createElement('canvas');
      canvas.className = 'library-thumb';
      canvas.width = 80;
      canvas.height = 80;

      this.drawElementThumbnail(def, canvas);

      const label = document.createElement('div');
      label.textContent = def.name;

      item.appendChild(canvas);
      item.appendChild(label);

      item.addEventListener('dragstart', (e) => {
        e.dataTransfer?.setData('text/element-id', def.id);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy';
      });

      item.addEventListener('dblclick', () => {
        this.spawnElement(def.id, this.cameraX, this.cameraY);
      });

      library.appendChild(item);
    }
  }

  private drawElementThumbnail(def: ElementDefinition, canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#0a0a12';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const params = this.getDefaultParams(def);
    this.drawElementCanvas(ctx, def, params, canvas.width / 2, canvas.height / 2, 0.6);
  }

  private spawnElement(defId: string, x: number, y: number) {
    const def = ELEMENT_LIBRARY.find((d) => d.id === defId);
    if (!def) return;
    const params = this.getDefaultParams(def);
    this.createElementInstance(def, {
      x,
      y,
      rotation: 0,
      lockToOrigin: false,
      seed: Math.floor(Math.random() * 1000000),
      params,
    });
    this.pushUndo();
  }

  private getDefaultParams(def: ElementDefinition): Record<string, number> {
    const params: Record<string, number> = {};
    for (const param of def.params) {
      params[param.key] = param.default;
    }
    return params;
  }

  private pickElementAt(x: number, y: number): ElementInstance | null {
    for (const element of this.elements.values()) {
      const dx = x - element.x;
      const dy = y - element.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist <= element.hitRadius) return element;
    }
    return null;
  }

  private selectElement(id: number | null) {
    this.selectedElementId = id;
    this.updateElementPropertiesUI();
    for (const element of this.elements.values()) {
      this.drawElementGraphic(element);
    }
    if (this.elementTool === 'params') {
      this.toggleWindow('element');
    }
  }

  private updateElementPropertiesUI() {
    const titleEl = document.getElementById('element-properties-title');
    const emptyEl = document.getElementById('element-properties-empty');
    const container = document.getElementById('element-properties');
    if (!container || !titleEl || !emptyEl) return;

    container.innerHTML = '';

    if (this.selectedElementId === null) {
      titleEl.textContent = 'No Selection';
      emptyEl.style.display = 'block';
      return;
    }

    const element = this.elements.get(this.selectedElementId);
    if (!element) {
      titleEl.textContent = 'No Selection';
      emptyEl.style.display = 'block';
      return;
    }

    const def = ELEMENT_LIBRARY.find((d) => d.id === element.defId);
    if (!def) return;

    titleEl.textContent = `${def.name} (${def.category})`;
    emptyEl.style.display = 'none';

    const lockRow = document.createElement('div');
    lockRow.className = 'checkbox-row';
    lockRow.innerHTML = `
      <input type="checkbox" id="element-lock-origin" ${element.lockToOrigin ? 'checked' : ''}>
      <label for="element-lock-origin">Lock to Origin</label>
    `;
    container.appendChild(lockRow);
    const lockCheckbox = lockRow.querySelector('input') as HTMLInputElement;
    lockCheckbox.addEventListener('change', () => {
      element.lockToOrigin = lockCheckbox.checked;
    });

    if (def.id === 'sun') {
      this.buildSunVariantSelector(container, element);
    }

    def.params.forEach((param) => {
      if (def.id === 'sun' && param.key === 'variant') return;
      const row = document.createElement('div');
      row.className = 'control-row';
      const decimals = param.step < 1 ? 2 : 0;
      const value = element.params[param.key] ?? param.default;

      row.innerHTML = `
        <div class="control-label">
          <span>${param.label}</span>
          <span class="control-value">${value.toFixed(decimals)}</span>
        </div>
        <input type="range" min="${param.min}" max="${param.max}" step="${param.step}" value="${value}">
      `;

      const slider = row.querySelector('input') as HTMLInputElement;
      const valueEl = row.querySelector('.control-value') as HTMLElement;

      slider.addEventListener('input', () => {
        const v = parseFloat(slider.value);
        element.params[param.key] = v;
        valueEl.textContent = v.toFixed(decimals);
        this.drawElementGraphic(element);
      });

      container.appendChild(row);
    });

    const actionRow = document.createElement('div');
    actionRow.className = 'spawn-grid';
    actionRow.innerHTML = `
      <button class="spawn-btn" id="element-duplicate">📄 Duplicate</button>
      <button class="spawn-btn danger" id="element-delete">🗑️ Delete</button>
    `;
    container.appendChild(actionRow);
    document.getElementById('element-duplicate')?.addEventListener('click', () => this.duplicateSelectedElement());
    document.getElementById('element-delete')?.addEventListener('click', () => this.deleteSelectedElement());

    const focusRow = document.createElement('div');
    focusRow.className = 'spawn-grid';
    focusRow.innerHTML = `
      <button class="spawn-btn" id="element-focus">🎯 Focus</button>
      <button class="spawn-btn" id="element-copy">📋 Copy</button>
    `;
    container.appendChild(focusRow);
    document.getElementById('element-focus')?.addEventListener('click', () => this.focusSelectedElement());
    document.getElementById('element-copy')?.addEventListener('click', () => this.copySelectedElement());
  }

  private deleteSelectedElement() {
    if (this.selectedElementId === null) return;
    const element = this.elements.get(this.selectedElementId);
    if (!element) return;
    if (element.sunRenderer) {
      this.elementContainer.removeChild(element.sunRenderer.getContainer());
      element.sunRenderer.destroy();
    }
    this.elementContainer.removeChild(element.graphic);
    this.elements.delete(this.selectedElementId);
    this.selectedElementId = null;
    this.updateElementPropertiesUI();
    this.pushUndo();
  }

  private duplicateSelectedElement() {
    if (this.selectedElementId === null) return;
    const element = this.elements.get(this.selectedElementId);
    if (!element) return;
    const def = ELEMENT_LIBRARY.find((d) => d.id === element.defId);
    if (!def) return;
    const offset = this.gridSize;
    this.createElementInstance(def, {
      x: element.x + offset,
      y: element.y + offset,
      rotation: element.rotation,
      lockToOrigin: element.lockToOrigin,
      seed: Math.floor(Math.random() * 1000000),
      params: { ...element.params },
    });
    this.pushUndo();
  }

  private copySelectedElement() {
    if (this.selectedElementId === null) return;
    const element = this.elements.get(this.selectedElementId);
    if (!element) return;
    const data = this.serializeElementsToBase64([element]);
    this.elementClipboard = data;
  }

  private pasteSelectedElement() {
    if (!this.elementClipboard) return;
    this.deserializeElementsFromBase64(this.elementClipboard, true);
    this.pushUndo();
  }

  private focusSelectedElement() {
    if (this.selectedElementId === null) return;
    const element = this.elements.get(this.selectedElementId);
    if (!element) return;
    this.cameraX = element.x;
    this.cameraY = element.y;
  }

  private pushUndo() {
    const snapshot = this.serializeElementsToBase64();
    if (this.undoStack[this.undoStack.length - 1] === snapshot) return;
    this.undoStack.push(snapshot);
    if (this.undoStack.length > this.MAX_UNDO) {
      this.undoStack.shift();
    }
  }

  private undo() {
    if (this.undoStack.length < 2) return;
    this.undoStack.pop();
    const snapshot = this.undoStack[this.undoStack.length - 1];
    this.deserializeElementsFromBase64(snapshot, false);
  }

  private serializeElementsToBase64(elements: ElementInstance[] = Array.from(this.elements.values())): string {
    const buffer = new BitBuffer(1024);
    buffer.writeUint16(1); // version
    buffer.writeVarUint(elements.length);

    for (const element of elements) {
      const defIndex = ELEMENT_LIBRARY.findIndex((d) => d.id === element.defId);
      const def = ELEMENT_LIBRARY[defIndex];
      buffer.writeVarUint(defIndex);
      buffer.writeFloat32(element.x);
      buffer.writeFloat32(element.y);
      buffer.writeFloat32(element.rotation);
      buffer.writeBool(element.lockToOrigin);
      buffer.writeUint32(element.seed);

      for (const param of def.params) {
        const value = element.params[param.key] ?? param.default;
        buffer.writeQuantized(value, param.min, param.max, 16);
      }
    }

    return buffer.toBase64();
  }

  private deserializeElementsFromBase64(base64: string, append: boolean) {
    const buffer = BitBuffer.fromBase64(base64);
    const version = buffer.readUint16();
    if (version !== 1) return;
    const count = buffer.readVarUint();
    if (!append) {
      this.clearElements();
    }

    for (let i = 0; i < count; i++) {
      const defIndex = buffer.readVarUint();
      const def = ELEMENT_LIBRARY[defIndex];
      const x = buffer.readFloat32();
      const y = buffer.readFloat32();
      const rotation = buffer.readFloat32();
      const lockToOrigin = buffer.readBool();
      const seed = buffer.readUint32();
      const params: Record<string, number> = {};
      for (const param of def.params) {
        params[param.key] = buffer.readQuantized(param.min, param.max, 16);
      }
      this.createElementInstance(def, { x, y, rotation, lockToOrigin, seed, params });
    }
  }

  private saveElementsToFile() {
    const data = this.serializeElementsToBase64();
    const payload = JSON.stringify({ version: 1, data }, null, 2);
    const blob = new Blob([payload], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'spacegame-elements.sgx';
    a.click();
    URL.revokeObjectURL(url);
  }

  private loadElementsFromFile(input: HTMLInputElement) {
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const json = JSON.parse(reader.result as string);
        if (json?.data) {
          this.deserializeElementsFromBase64(json.data, false);
          this.pushUndo();
        }
      } catch (e) {
        console.error('Failed to load elements:', e);
      }
    };
    reader.readAsText(file);
    input.value = '';
  }

  private clearElements() {
    for (const element of this.elements.values()) {
      if (element.sunRenderer) {
        this.elementContainer.removeChild(element.sunRenderer.getContainer());
        element.sunRenderer.destroy();
      }
      this.elementContainer.removeChild(element.graphic);
    }
    this.elements.clear();
  }

  private createElementInstance(
    def: ElementDefinition,
    data: {
      x: number;
      y: number;
      rotation: number;
      lockToOrigin: boolean;
      seed: number;
      params: Record<string, number>;
    }
  ) {
    const id = this.nextElementId++;
    const graphic = new Graphics();
    const instance: ElementInstance = {
      id,
      defId: def.id,
      x: data.x,
      y: data.y,
      rotation: data.rotation,
      params: data.params,
      graphic,
      hitRadius: data.params.radius ?? 100,
      lockToOrigin: data.lockToOrigin,
      seed: data.seed,
    };

    this.elements.set(id, instance);
    if (def.id === 'sun') {
      instance.sunRenderer = new SunRenderer();
      instance.sunRenderer.initialize();
      this.elementContainer.addChild(instance.sunRenderer.getContainer());
    }
    this.elementContainer.addChild(graphic);
    this.drawElementGraphic(instance);
    this.selectElement(id);
  }

  private buildSunVariantSelector(container: HTMLElement, element: ElementInstance) {
    const section = document.createElement('div');
    section.className = 'section';
    section.innerHTML = `<div class="section-title">Sun Variants</div>`;

    const grid = document.createElement('div');
    grid.className = 'variant-grid';
    const hue = element.params.hue ?? 40;

    SUN_VARIANTS.forEach((variant, index) => {
      const card = document.createElement('div');
      card.className = 'variant-card';
      const variantIndex = index + 1;
      if ((element.params.variant ?? 1) === variantIndex) {
        card.classList.add('active');
      }

      const canvas = document.createElement('canvas');
      canvas.width = 120;
      canvas.height = 60;
      canvas.className = 'variant-thumb';
      this.drawSunVariantThumbnail(canvas, hue, index);

      const label = document.createElement('div');
      label.textContent = variant.name;

      card.appendChild(canvas);
      card.appendChild(label);

      card.addEventListener('click', () => {
        element.params.variant = variantIndex;
        this.updateElementPropertiesUI();
        this.drawElementGraphic(element);
      });

      grid.appendChild(card);
    });

    section.appendChild(grid);
    container.appendChild(section);
  }

  private drawSunVariantThumbnail(canvas: HTMLCanvasElement, baseHue: number, variantIndex: number) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#0a0a12';
    ctx.fillRect(0, 0, w, h);

    const variant = SUN_VARIANTS[variantIndex];
    const hue = (baseHue + variantIndex * 12) % 360;
    const glow = ctx.createRadialGradient(w * 0.5, h * 0.5, 8, w * 0.5, h * 0.5, 34);
    glow.addColorStop(0, `hsla(${hue}, 80%, 70%, 0.9)`);
    glow.addColorStop(0.4, `hsla(${hue + 15}, 90%, 60%, 0.6)`);
    glow.addColorStop(1, `hsla(${hue + 30}, 90%, 45%, 0)`);
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(w * 0.5, h * 0.5, 34, 0, Math.PI * 2);
    ctx.fill();

    ctx.beginPath();
    ctx.arc(w * 0.5, h * 0.5, 22, 0, Math.PI * 2);
    ctx.fillStyle = `hsl(${hue}, 75%, ${55 + variantIndex * 2}%)`;
    ctx.fill();

    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = `hsla(${hue + 20}, 90%, 80%, 0.6)`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(w * 0.5, h * 0.5, 24, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  private drawElementGraphic(element: ElementInstance) {
    const def = ELEMENT_LIBRARY.find((d) => d.id === element.defId);
    if (!def) return;
    element.graphic.clear();
    if (def.id === 'sun' && element.sunRenderer) {
      const radius = element.params.radius ?? 500;
      element.hitRadius = Math.max(80, radius * 1.1);
      if (element.id === this.selectedElementId) {
        element.graphic.circle(0, 0, radius * 1.1);
        element.graphic.stroke({ color: 0x66aaff, width: 2, alpha: 0.9 });
      }
    } else {
      element.hitRadius = this.drawElementPixi(
        element.graphic,
        def,
        element.params,
        element.seed,
        element.id === this.selectedElementId,
        this.time
      );
    }
  }

  private updateSunElement(element: ElementInstance, dt: number, screenSize: { width: number; height: number }) {
    const renderer = element.sunRenderer;
    if (!renderer) return;

    const params = element.params;
    const radius = params.radius ?? 500;
    const hue = params.hue ?? 40;
    const noiseScale = params.noiseScale ?? 1;
    const coronaSize = 1.0;
    const coronaIntensity = 0.0;
    const speed = params.speed ?? 1;
    const variantIndex = Math.max(1, Math.min(5, Math.round(params.variant ?? 1))) - 1;
    const variant = SUN_VARIANTS[variantIndex];

    renderer.setSunStyle(variantIndex, variant.sunParams);
    renderer.setCoronaStyle(variant.coronaStyle, variant.coronaParams);
    renderer.setRadius(0.35);
    renderer.setNoiseScale(noiseScale);
    renderer.setCoronaSize(coronaSize);
    renderer.setCoronaIntensity(coronaIntensity);
    renderer.setAnimationSpeed(speed);
    renderer.setLOD(Math.max(0, Math.min(1, (this.cameraZoom - 0.1) / 1.9)));
    renderer.update(dt, hue, radius, screenSize);
  }

  private drawElementCanvas(
    ctx: CanvasRenderingContext2D,
    def: ElementDefinition,
    params: Record<string, number>,
    cx: number,
    cy: number,
    scale: number
  ) {
    const radius = (params.radius ?? 100) * scale;
    const hue = params.hue ?? 40;
    ctx.save();
    ctx.translate(cx, cy);

    if (def.id === 'sun') {
      const glow = ctx.createRadialGradient(0, 0, radius * 0.2, 0, 0, radius * 1.2);
      glow.addColorStop(0, `hsla(${hue}, 80%, 70%, 0.9)`);
      glow.addColorStop(0.6, `hsla(${hue + 15}, 90%, 60%, 0.6)`);
      glow.addColorStop(1, `hsla(${hue + 20}, 90%, 45%, 0)`);
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(0, 0, radius * 1.2, 0, Math.PI * 2);
      ctx.fill();

      ctx.beginPath();
      ctx.arc(0, 0, radius, 0, Math.PI * 2);
      ctx.fillStyle = `hsl(${hue}, 75%, 60%)`;
      ctx.fill();
    } else if (def.id === 'corona_soft') {
      const thickness = (params.thickness ?? 20) * scale;
      ctx.beginPath();
      ctx.arc(0, 0, radius, 0, Math.PI * 2);
      ctx.strokeStyle = `hsla(${hue}, 90%, 70%, 0.75)`;
      ctx.lineWidth = thickness;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, radius * 1.1, 0, Math.PI * 2);
      ctx.strokeStyle = `hsla(${hue + 20}, 90%, 60%, 0.4)`;
      ctx.lineWidth = thickness * 0.6;
      ctx.stroke();
    } else if (def.id === 'corona_streams') {
      const streams = Math.max(4, Math.round(params.streams ?? 8));
      ctx.strokeStyle = `hsla(${hue}, 95%, 70%, 0.8)`;
      ctx.lineWidth = Math.max(1, (params.width ?? 10) * scale * 0.3);
      for (let i = 0; i < streams; i++) {
        const ang = (i / streams) * Math.PI * 2;
        ctx.beginPath();
        ctx.arc(0, 0, radius, ang, ang + Math.PI * 0.35);
        ctx.stroke();
      }
    } else if (def.id === 'ambient_glow') {
      const grad = ctx.createRadialGradient(0, 0, radius * 0.2, 0, 0, radius);
      grad.addColorStop(0, `hsla(${hue}, 80%, 70%, 0.7)`);
      grad.addColorStop(1, `hsla(${hue}, 80%, 40%, 0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(0, 0, radius, 0, Math.PI * 2);
      ctx.fill();
    } else if (def.id === 'nebula') {
      for (let i = 0; i < 6; i++) {
        const r = radius * (0.35 + i * 0.1);
        ctx.beginPath();
        ctx.arc((i - 3) * radius * 0.12, ((i % 2) - 0.5) * radius * 0.1, r, 0, Math.PI * 2);
        ctx.fillStyle = `hsla(${hue + i * 6}, 70%, 55%, 0.2)`;
        ctx.fill();
      }
    } else if (def.id === 'black_hole') {
      ctx.beginPath();
      ctx.arc(0, 0, radius * 0.7, 0, Math.PI * 2);
      ctx.fillStyle = '#050008';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(0, 0, radius, 0, Math.PI * 2);
      ctx.strokeStyle = `hsla(${hue}, 80%, 60%, 0.8)`;
      ctx.lineWidth = Math.max(2, radius * 0.12);
      ctx.stroke();
    } else if (def.id === 'wormhole') {
      const rings = Math.max(3, Math.round(params.rings ?? 6));
      for (let i = 0; i < rings; i++) {
        ctx.beginPath();
        ctx.arc(0, 0, radius * (0.4 + i / rings * 0.6), 0, Math.PI * 2);
        ctx.strokeStyle = `hsla(${hue}, 80%, 70%, ${0.2 + i / rings * 0.4})`;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    } else if (def.id === 'comet') {
      const tail = (params.tail ?? 80) * scale;
      const width = (params.width ?? 12) * scale;
      ctx.beginPath();
      ctx.moveTo(-tail, -width * 0.5);
      ctx.lineTo(0, 0);
      ctx.lineTo(-tail, width * 0.5);
      ctx.closePath();
      ctx.fillStyle = `hsla(${hue}, 90%, 70%, 0.6)`;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(0, 0, radius * 0.5, 0, Math.PI * 2);
      ctx.fillStyle = 'white';
      ctx.fill();
    } else if (def.id === 'aurora_arc') {
      const length = (params.length ?? 120) * scale;
      const thickness = (params.thickness ?? 16) * scale;
      ctx.beginPath();
      ctx.strokeStyle = `hsla(${hue}, 90%, 60%, 0.7)`;
      ctx.lineWidth = thickness;
      ctx.arc(0, 0, radius, -Math.PI / 2, -Math.PI / 2 + length / 200);
      ctx.stroke();
    } else if (def.id === 'asteroid_belt') {
      const count = Math.round(params.count ?? 60);
      ctx.fillStyle = `hsla(${hue}, 40%, 50%, 0.7)`;
      for (let i = 0; i < count / 8; i++) {
        const ang = (i / (count / 8)) * Math.PI * 2;
        const r = radius * (0.7 + Math.random() * 0.3);
        ctx.beginPath();
        ctx.arc(Math.cos(ang) * r, Math.sin(ang) * r, 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.restore();
  }

  private drawElementPixi(
    g: Graphics,
    def: ElementDefinition,
    params: Record<string, number>,
    seed: number,
    selected: boolean,
    time: number
  ): number {
    const radius = params.radius ?? 100;
    const hue = params.hue ?? 40;
    const pulse = 0.5 + 0.5 * Math.sin(time * 1.5);
    const rng = this.seededRandom(seed);

    if (def.id === 'corona_soft') {
      const thickness = params.thickness ?? 30;
      const intensity = params.intensity ?? 0.8;
      const flicker = params.flicker ?? 0.6;
      const flickerPulse = 0.7 + 0.3 * Math.sin(time * (1.5 + flicker) + seed);
      const baseAlpha = intensity * flickerPulse;

      g.circle(0, 0, radius * 1.12);
      g.stroke({ color: this.hslToHex(hue + 10, 0.9, 0.8), width: thickness * 0.6, alpha: baseAlpha * 0.35 });
      g.circle(0, 0, radius);
      g.stroke({ color: this.hslToHex(hue, 0.95, 0.7), width: thickness, alpha: baseAlpha * 0.8 });
      g.circle(0, 0, radius * 0.88);
      g.stroke({ color: this.hslToHex(hue + 25, 0.85, 0.75), width: thickness * 0.5, alpha: baseAlpha * 0.6 });
    } else if (def.id === 'corona_streams') {
      const streams = Math.max(4, Math.round(params.streams ?? 8));
      const width = params.width ?? 18;
      const speed = params.speed ?? 1.0;
      const intensity = params.intensity ?? 1.0;
      const streamPulse = 0.6 + 0.4 * Math.sin(time * speed + seed * 0.1);

      for (let i = 0; i < streams; i++) {
        const ang = (i / streams) * Math.PI * 2 + Math.sin(time * speed + i) * 0.4;
        const arcLen = Math.PI * (0.25 + 0.15 * Math.sin(time * 0.7 + i));
        const r = radius * (0.96 + 0.06 * Math.sin(time + i));
        g.arc(0, 0, r, ang, ang + arcLen);
        g.stroke({ color: this.hslToHex(hue + i * 4, 0.9, 0.7), width: width, alpha: intensity * streamPulse * 0.6 });
        g.arc(0, 0, r * 1.05, ang + 0.1, ang + arcLen + 0.1);
        g.stroke({ color: this.hslToHex(hue + 20 + i * 3, 0.9, 0.75), width: width * 0.5, alpha: intensity * 0.4 });
      }
    } else if (def.id === 'ambient_glow') {
      const intensity = params.intensity ?? 0.5;
      const falloff = params.falloff ?? 1.6;
      g.circle(0, 0, radius * (1.2 + falloff * 0.1));
      g.fill({ color: this.hslToHex(hue, 0.7, 0.6), alpha: intensity * 0.15 });
      g.circle(0, 0, radius * 1.05);
      g.fill({ color: this.hslToHex(hue + 12, 0.75, 0.6), alpha: intensity * 0.25 });
      g.circle(0, 0, radius * 0.85);
      g.fill({ color: this.hslToHex(hue, 0.8, 0.55), alpha: intensity * 0.35 });
    } else if (def.id === 'nebula') {
      const density = params.density ?? 0.25;
      const swirl = params.swirl ?? 0.6;
      const contrast = params.contrast ?? 0.8;
      for (let i = 0; i < 18; i++) {
        const a = rng() * Math.PI * 2;
        const r = radius * (0.2 + rng() * 0.8);
        const drift = swirl * (0.6 + 0.4 * Math.sin(time * 0.4 + i));
        const x = Math.cos(a) * r * (0.4 + drift * 0.6);
        const y = Math.sin(a) * r * (0.4 + drift * 0.6);
        const size = radius * (0.15 + rng() * 0.25);
        const light = 0.45 + contrast * 0.25 * rng();
        g.circle(x, y, size);
        g.fill({ color: this.hslToHex(hue + i * 5, 0.6, light), alpha: density * (0.3 + rng() * 0.7) });
      }
    } else if (def.id === 'black_hole') {
      const disk = params.disk ?? 80;
      const warp = params.warp ?? 0.7;
      const glow = params.glow ?? 0.9;
      const diskPulse = 0.6 + 0.4 * Math.sin(time * 0.8 + seed * 0.2);

      g.circle(0, 0, radius * 0.7);
      g.fill({ color: 0x050008, alpha: 1 });

      for (let i = 0; i < 3; i++) {
        const ringR = radius * (0.85 + i * 0.1);
        g.circle(0, 0, ringR);
        g.stroke({ color: this.hslToHex(hue + i * 12, 0.8, 0.6), width: disk * (0.12 + i * 0.04), alpha: glow * (0.3 + 0.2 * i) * diskPulse });
      }

      for (let i = 0; i < 6; i++) {
        const ang = (i / 6) * Math.PI * 2 + time * 0.4 * warp;
        g.arc(0, 0, radius * (1.05 + i * 0.03), ang, ang + Math.PI * 0.2);
        g.stroke({ color: this.hslToHex(hue + 40, 0.9, 0.7), width: 4, alpha: 0.4 * glow });
      }
    } else if (def.id === 'wormhole') {
      const rings = Math.max(4, Math.round(params.rings ?? 8));
      const twist = params.twist ?? 0.8;
      const intensity = params.intensity ?? 1.0;
      for (let i = 0; i < rings; i++) {
        const r = radius * (0.35 + i / rings * 0.75);
        const ang = time * 0.3 * twist + i * 0.6;
        g.arc(0, 0, r, ang, ang + Math.PI * 1.2);
        g.stroke({ color: this.hslToHex(hue + i * 8, 0.8, 0.6), width: 2 + i * 0.4, alpha: intensity * (0.2 + i / rings * 0.6) });
      }
    } else if (def.id === 'aurora_arc') {
      const length = params.length ?? 120;
      const thickness = params.thickness ?? 16;
      const shimmer = params.shimmer ?? 0.7;
      const shimmerPulse = 0.6 + 0.4 * Math.sin(time * 1.8 + seed * 0.3);
      g.arc(0, 0, radius, -Math.PI / 2, -Math.PI / 2 + length / 180);
      g.stroke({ color: this.hslToHex(hue, 0.9, 0.65), width: thickness, alpha: shimmerPulse * shimmer });
      g.arc(0, 0, radius * 0.92, -Math.PI / 2, -Math.PI / 2 + length / 180);
      g.stroke({ color: this.hslToHex(hue + 20, 0.9, 0.7), width: thickness * 0.5, alpha: shimmerPulse * 0.6 });
    } else if (def.id === 'comet') {
      const tail = params.tail ?? 140;
      const width = params.width ?? 26;
      const sparkle = params.sparkle ?? 0.5;
      g.moveTo(-tail, -width * 0.5);
      g.lineTo(0, 0);
      g.lineTo(-tail, width * 0.5);
      g.closePath();
      g.fill({ color: this.hslToHex(hue, 0.85, 0.7), alpha: 0.7 });
      g.circle(0, 0, radius * 0.8);
      g.fill({ color: 0xffffff, alpha: 1 });
      for (let i = 0; i < 6; i++) {
        const ang = rng() * Math.PI * 2;
        const r = radius * (0.8 + rng() * 0.6);
        g.circle(Math.cos(ang) * r, Math.sin(ang) * r, 1 + rng() * 2);
        g.fill({ color: this.hslToHex(hue + 30, 0.9, 0.8), alpha: sparkle * 0.8 });
      }
    } else if (def.id === 'asteroid_belt') {
      const count = Math.round(params.count ?? 120);
      const beltThickness = params.thickness ?? 120;
      const variation = params.variation ?? 0.6;
      for (let i = 0; i < count; i++) {
        const ang = (i / count) * Math.PI * 2 + rng() * 0.2;
        const r = radius + (rng() - 0.5) * beltThickness * (0.4 + variation);
        const size = 2 + rng() * 4;
        g.circle(Math.cos(ang) * r, Math.sin(ang) * r, size);
        g.fill({ color: this.hslToHex(hue + rng() * 20, 0.35, 0.55), alpha: 0.7 + rng() * 0.3 });
      }
    }

    if (selected) {
      g.circle(0, 0, radius * 1.05);
      g.stroke({ color: 0x66aaff, width: 2, alpha: 0.8 });
    }

    return Math.max(60, radius * 1.2);
  }

  private setupShaderStyleControls() {
    const sunSelect = document.getElementById('sun-style-select') as HTMLSelectElement | null;
    const coronaSelect = document.getElementById('corona-style-select') as HTMLSelectElement | null;
    const sunParams = document.getElementById('sun-style-params') as HTMLElement | null;
    const coronaParams = document.getElementById('corona-style-params') as HTMLElement | null;
    const sunLabel = document.getElementById('sun-style-label');
    const coronaLabel = document.getElementById('corona-style-label');

    if (!sunSelect || !coronaSelect || !sunParams || !coronaParams) return;

    this.populateStyleSelect(sunSelect, sunShaderDefs.sunStyles, this.config.sunStyle);
    this.populateStyleSelect(coronaSelect, sunShaderDefs.coronaStyles, this.config.coronaStyle);

    const rebuildSun = () => {
      const style = this.getStyleById(sunShaderDefs.sunStyles, sunSelect.value);
      this.config.sunStyle = style.id;
      if (sunLabel) sunLabel.textContent = style.label;
      this.buildStyleParamsUI(sunParams, style, this.config.sunStyleParams);
    };

    const rebuildCorona = () => {
      const style = this.getStyleById(sunShaderDefs.coronaStyles, coronaSelect.value);
      this.config.coronaStyle = style.id;
      if (coronaLabel) coronaLabel.textContent = style.label;
      this.buildStyleParamsUI(coronaParams, style, this.config.coronaStyleParams);
    };

    sunSelect.addEventListener('change', rebuildSun);
    coronaSelect.addEventListener('change', rebuildCorona);

    rebuildSun();
    rebuildCorona();
  }

  private populateStyleSelect(select: HTMLSelectElement, styles: SunShaderStyleDef[], current: string) {
    select.innerHTML = '';
    styles.forEach((style) => {
      const opt = document.createElement('option');
      opt.value = style.id;
      opt.textContent = style.label;
      select.appendChild(opt);
    });
    select.value = styles.find((style) => style.id === current)?.id ?? styles[0].id;
  }

  private getStyleById(styles: SunShaderStyleDef[], id: string): SunShaderStyleDef {
    return styles.find((style) => style.id === id) ?? styles[0];
  }

  private buildStyleParamsUI(container: HTMLElement, style: SunShaderStyleDef, targetParams: Record<string, number>) {
    container.innerHTML = '';
    style.params.forEach((param) => {
      if (targetParams[param.key] === undefined) {
        targetParams[param.key] = param.default;
      }

      const row = document.createElement('div');
      row.className = 'control-row';

      const decimals = param.step < 1 ? 2 : 0;
      row.innerHTML = `
        <div class="control-label">
          <span>${param.label}</span>
          <span class="control-value" id="${style.id}-${param.key}-val">${targetParams[param.key].toFixed(decimals)}</span>
        </div>
        <input type="range" id="${style.id}-${param.key}" min="${param.min}" max="${param.max}" step="${param.step}" value="${targetParams[param.key]}">
      `;

      container.appendChild(row);

      const slider = row.querySelector('input') as HTMLInputElement;
      const valueEl = row.querySelector('.control-value') as HTMLElement;

      slider.addEventListener('input', () => {
        const val = parseFloat(slider.value);
        targetParams[param.key] = val;
        valueEl.textContent = val.toFixed(decimals);
      });
    });
  }

  private resolveStyleParams(styles: SunShaderStyleDef[], styleId: string, params: Record<string, number>) {
    const index = Math.max(0, styles.findIndex((style) => style.id === styleId));
    const style = styles[index] || styles[0];
    const values = style.params.map((param) => (params[param.key] ?? param.default));
    return { index, values };
  }
  
  private bindSlider(id: string, callback: (val: number) => void) {
    const slider = document.getElementById(id) as HTMLInputElement;
    const valueDisplay = document.getElementById(id + '-val');
    
    if (slider && valueDisplay) {
      slider.addEventListener('input', () => {
        const val = parseFloat(slider.value);
        const decimals = val < 0.001 ? 5 : val < 1 ? 2 : val < 100 ? 1 : 0;
        valueDisplay.textContent = val.toFixed(decimals);
        callback(val);
      });
    }
  }
  
  private setupSpawnButtons() {
    // Spawn type selection
    document.querySelectorAll('.spawn-btn[data-spawn]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const type = btn.getAttribute('data-spawn')!;
        
        // Toggle selection
        if (this.selectedSpawnType === type) {
          this.selectedSpawnType = null;
          btn.classList.remove('active');
          this.setTool('pan');
        } else {
          document.querySelectorAll('.spawn-btn[data-spawn]').forEach((b) => b.classList.remove('active'));
          btn.classList.add('active');
          this.selectedSpawnType = type;
          this.setTool('spawn');
        }
      });
    });
    
    // Instant effects
    document.querySelectorAll('.spawn-btn[data-effect]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const effect = btn.getAttribute('data-effect')!;
        this.spawnEffect(effect);
      });
    });
    
    // Clear buttons
    document.querySelectorAll('.spawn-btn[data-clear]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const clearType = btn.getAttribute('data-clear')!;
        if (clearType === 'entities') this.clearEntities();
        if (clearType === 'all') this.clearAll();
      });
    });
    
    // Admin buttons
    document.getElementById('admin-push-config')?.addEventListener('click', () => {
      this.pushConfigToServer();
    });
    
    document.getElementById('admin-reload-data')?.addEventListener('click', () => {
      this.sendToAdmin('reload', {});
    });
    
    document.getElementById('admin-kill-all')?.addEventListener('click', () => {
      this.executeAdminCommand('killAll');
    });
    
    document.getElementById('admin-toggle-invincible')?.addEventListener('click', () => {
      this.executeAdminCommand('toggleInvincible');
    });
    
    document.getElementById('admin-spawn-test')?.addEventListener('click', () => {
      this.executeAdminCommand('spawnEnemy', { type: 'ice_sprite', x: 0, y: 5000, systemId: 'sol' });
    });
    
    document.getElementById('admin-tp-origin')?.addEventListener('click', () => {
      // This would need a player ID - for now teleport player 1 (if exists)
      this.executeAdminCommand('teleportPlayer', { playerId: 1, x: 0, y: 0 });
    });
  }
  
  private resetView() {
    this.cameraX = 0;
    this.cameraY = 0;
    this.cameraZoom = 1;
  }
  
  private onResize() {
    this.app.renderer.resize(window.innerWidth, window.innerHeight);
  }
  
  private update() {
    const dt = this.app.ticker.deltaMS / 1000;
    this.time += dt;
    this.animTime += dt * this.config.sunSpeed;
    
    // FPS
    this.frameCount++;
    if (this.time - this.lastFpsUpdate >= 1) {
      this.fps = this.frameCount;
      this.frameCount = 0;
      this.lastFpsUpdate = this.time;
    }
    
    this.updateEntities(dt);
    this.updateParticles(dt);
    this.updateElements(dt);
    this.render();
    this.updateUI();
  }
  
  private updateEntities(dt: number) {
    for (const entity of this.entities.values()) {
      entity.x += entity.vx * dt;
      entity.y += entity.vy * dt;
      entity.angle += dt * 0.5;
    }
  }
  
  private updateParticles(dt: number) {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= dt;
      
      if (p.life <= 0) {
        this.effectContainer.removeChild(p.graphic);
        this.particles.splice(i, 1);
      }
    }
  }

  private updateElements(_dt: number) {
    const dt = this.app.ticker.deltaMS / 1000;
    const screenSize = { width: this.app.renderer.width, height: this.app.renderer.height };
    for (const element of this.elements.values()) {
      if (element.lockToOrigin) {
        element.x = 0;
        element.y = 0;
      }
      if (element.sunRenderer) {
        this.updateSunElement(element, dt, screenSize);
      }
      this.drawElementGraphic(element);
    }
  }
  
  private render() {
    const width = this.app.renderer.width;
    const height = this.app.renderer.height;
    
    // Update camera transform
    this.worldContainer.x = width / 2 - this.cameraX * this.cameraZoom;
    this.worldContainer.y = height / 2 - this.cameraY * this.cameraZoom;
    this.worldContainer.scale.set(this.cameraZoom);
    
    // Render starfield
    this.renderStarfield();
    this.renderGrid();
    
    // Update GPU renderers with camera position for parallax
    const dt = this.app.ticker.deltaMS / 1000 * this.config.glowSpeed;
    
    // Calculate LOD based on zoom (closer = more detail)
    // Zoom 0.1 = far (LOD 0), Zoom 2+ = close (LOD 1)
    const lodZoom = Math.max(0, Math.min(1, (this.cameraZoom - 0.1) / 1.9));
    
    if (this.glowRenderer.getContainer().visible) {
      this.glowRenderer.setLOD(lodZoom);
      this.glowRenderer.update(dt, this.config.sunHue, this.config.sunRadius, this.config.glowRadius, this.cameraX, this.cameraY);
      this.glowRenderer.setPosition(0, 0);
    }
    
    // Sun renderer - apply all config values
    const sunDt = this.app.ticker.deltaMS / 1000;
    const sunStyle = this.resolveStyleParams(
      sunShaderDefs.sunStyles,
      this.config.sunStyle,
      this.config.sunStyleParams
    );
    const coronaStyle = this.resolveStyleParams(
      sunShaderDefs.coronaStyles,
      this.config.coronaStyle,
      this.config.coronaStyleParams
    );

    if (this.sunRenderer.getContainer().visible) {
      this.sunRenderer.setSunStyle(sunStyle.index, sunStyle.values);
      this.sunRenderer.setCoronaStyle(coronaStyle.index, coronaStyle.values);
      this.sunRenderer.setRadius(0.35); // Keep UV radius constant, world size changes via mesh scale
      this.sunRenderer.setNoiseScale(this.config.sunNoise);
      this.sunRenderer.setCoronaSize(this.config.coronaSize);
      this.sunRenderer.setCoronaIntensity(this.config.coronaIntensity);
      this.sunRenderer.setAnimationSpeed(this.config.sunSpeed);
      this.sunRenderer.setLOD(lodZoom);
      
      this.sunRenderer.update(sunDt, this.config.sunHue, this.config.sunRadius, { width, height });
      this.sunRenderer.setPosition(0, 0);
    }

    // Render elements
    for (const element of this.elements.values()) {
      element.graphic.x = element.x;
      element.graphic.y = element.y;
      element.graphic.rotation = element.rotation;
      if (element.sunRenderer) {
        element.sunRenderer.setPosition(element.x, element.y);
        element.sunRenderer.getContainer().rotation = element.rotation;
      }
    }
    
    // Render entities
    for (const entity of this.entities.values()) {
      entity.graphic.x = entity.x;
      entity.graphic.y = entity.y;
      entity.graphic.rotation = entity.angle;
    }
    
    // Render particles
    for (const p of this.particles) {
      p.graphic.x = p.x;
      p.graphic.y = p.y;
      p.graphic.alpha = p.life / p.maxLife;
    }
  }
  
  private renderStarfield() {
    this.starsGraphics.clear();
    
    const width = this.app.renderer.width;
    const height = this.app.renderer.height;
    const snap = this.STARFIELD_SNAP;
    const focal = this.STARFIELD_FOCAL;
    
    const halfW = width / 2 / this.cameraZoom;
    const halfH = height / 2 / this.cameraZoom;
    const margin = snap * 2;
    
    const minRX = Math.floor((this.cameraX - halfW - margin) / snap);
    const maxRX = Math.ceil((this.cameraX + halfW + margin) / snap);
    const minRY = Math.floor((this.cameraY - halfH - margin) / snap);
    const maxRY = Math.ceil((this.cameraY + halfH + margin) / snap);
    
    for (let layerIdx = 0; layerIdx < STAR_LAYERS.length; layerIdx++) {
      if (!this.layerEnabled[layerIdx]) continue;
      
      const layer = STAR_LAYERS[layerIdx];
      if (this.cameraZoom < layer.minZoom) continue;
      
      const fadeRange = 0.2;
      const layerAlpha = Math.min(1, (this.cameraZoom - layer.minZoom) / fadeRange);
      
      for (let rx = minRX; rx <= maxRX; rx++) {
        for (let ry = minRY; ry <= maxRY; ry++) {
          const stars = this.getStarsForRegion(rx, ry, layer);
          
          for (const star of stars) {
            const parallax = focal / star.z;
            const screenX = (star.x - this.cameraX) * parallax + this.cameraX;
            const screenY = (star.y - this.cameraY) * parallax + this.cameraY;
            
            const dist = Math.sqrt(
              Math.pow(screenX - this.cameraX, 2) +
              Math.pow(screenY - this.cameraY, 2)
            );
            if (dist > halfW * 2.5) continue;
            
            const twinkleBase = 1 - this.config.starTwinkleAmt;
            const twinkle = twinkleBase + this.config.starTwinkleAmt * Math.sin(this.time * this.config.starTwinkleSpeed + star.phase);
            const brightness = star.brightness * twinkle * this.config.starBrightness * layerAlpha;
            
            const hue = star.hue + this.config.starHueShift;
            const color = this.hslToHex(hue, 0.5, brightness * 0.5 + 0.3);
            
            const size = star.size * parallax * brightness;
            
            this.starsGraphics.circle(screenX, screenY, size * 0.3);
            this.starsGraphics.fill({ color, alpha: brightness });
            
            if (size > 1.5) {
              this.starsGraphics.circle(screenX, screenY, size * 0.6);
              this.starsGraphics.fill({ color, alpha: brightness * 0.3 });
            }
          }
        }
      }
    }
  }

  private renderGrid() {
    this.gridGraphics.clear();
    if (!this.showGrid) return;

    const width = this.app.renderer.width;
    const height = this.app.renderer.height;
    const halfW = width / 2 / this.cameraZoom;
    const halfH = height / 2 / this.cameraZoom;
    const startX = Math.floor((this.cameraX - halfW) / this.gridSize) * this.gridSize;
    const endX = Math.ceil((this.cameraX + halfW) / this.gridSize) * this.gridSize;
    const startY = Math.floor((this.cameraY - halfH) / this.gridSize) * this.gridSize;
    const endY = Math.ceil((this.cameraY + halfH) / this.gridSize) * this.gridSize;

    this.gridGraphics.lineStyle(1, 0x223344, 0.35);
    for (let x = startX; x <= endX; x += this.gridSize) {
      this.gridGraphics.moveTo(x, startY);
      this.gridGraphics.lineTo(x, endY);
    }
    for (let y = startY; y <= endY; y += this.gridSize) {
      this.gridGraphics.moveTo(startX, y);
      this.gridGraphics.lineTo(endX, y);
    }

    this.gridGraphics.lineStyle(2, 0x335577, 0.6);
    this.gridGraphics.moveTo(0, startY);
    this.gridGraphics.lineTo(0, endY);
    this.gridGraphics.moveTo(startX, 0);
    this.gridGraphics.lineTo(endX, 0);
  }
  
  private getStarsForRegion(regionX: number, regionY: number, layer: StarLayerConfig): StarData[] {
    const key = `${regionX},${regionY},${layer.noiseSeed},${this.config.starDensity}`;
    
    if (this.starCache.has(key)) {
      return this.starCache.get(key)!;
    }
    
    const stars: StarData[] = [];
    const noiseVal = this.simplexNoise2D(
      regionX * layer.noiseScale * 1000,
      regionY * layer.noiseScale * 1000,
      layer.noiseSeed
    );
    
    if (layer.noiseThreshold > 0 && noiseVal < layer.noiseThreshold) {
      this.starCache.set(key, stars);
      return stars;
    }
    
    const densityMult = layer.noiseThreshold > 0 
      ? 1 + (noiseVal - layer.noiseThreshold) * 2 
      : 1 + noiseVal * 0.5;
    const count = Math.floor(layer.baseCount * densityMult * this.config.starDensity);
    
    const rand = this.seededRandom(this.hashRegion(regionX, regionY, layer.noiseSeed));
    const baseX = regionX * this.STARFIELD_SNAP;
    const baseY = regionY * this.STARFIELD_SNAP;
    
    for (let i = 0; i < count; i++) {
      stars.push({
        x: baseX + rand() * this.STARFIELD_SNAP,
        y: baseY + rand() * this.STARFIELD_SNAP,
        z: layer.zMin + rand() * (layer.zMax - layer.zMin),
        size: layer.minSize + rand() * (layer.maxSize - layer.minSize),
        hue: 180 + rand() * 80,
        phase: rand() * Math.PI * 2,
        brightness: 0.5 + rand() * 0.5,
      });
    }
    
    this.starCache.set(key, stars);
    return stars;
  }
  
  private simplexNoise2D(x: number, y: number, seed: number = 0): number {
    const s = (x + y) * SIMPLEX_F2;
    const i = Math.floor(x + s);
    const j = Math.floor(y + s);
    const t = (i + j) * SIMPLEX_G2;
    const X0 = i - t;
    const Y0 = j - t;
    const x0 = x - X0;
    const y0 = y - Y0;
    
    let i1: number, j1: number;
    if (x0 > y0) { i1 = 1; j1 = 0; }
    else { i1 = 0; j1 = 1; }
    
    const x1 = x0 - i1 + SIMPLEX_G2;
    const y1 = y0 - j1 + SIMPLEX_G2;
    const x2 = x0 - 1 + 2 * SIMPLEX_G2;
    const y2 = y0 - 1 + 2 * SIMPLEX_G2;
    
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
      n0 = t0 * t0 * (SIMPLEX_GRAD[gi0][0] * x0 + SIMPLEX_GRAD[gi0][1] * y0);
    }
    
    let t1 = 0.5 - x1*x1 - y1*y1;
    if (t1 >= 0) {
      t1 *= t1;
      n1 = t1 * t1 * (SIMPLEX_GRAD[gi1][0] * x1 + SIMPLEX_GRAD[gi1][1] * y1);
    }
    
    let t2 = 0.5 - x2*x2 - y2*y2;
    if (t2 >= 0) {
      t2 *= t2;
      n2 = t2 * t2 * (SIMPLEX_GRAD[gi2][0] * x2 + SIMPLEX_GRAD[gi2][1] * y2);
    }
    
    return 70 * (n0 + n1 + n2);
  }
  
  private seededRandom(seed: number): () => number {
    return () => {
      let t = seed += 0x6D2B79F5;
      t = Math.imul(t ^ t >>> 15, t | 1);
      t ^= t + Math.imul(t ^ t >>> 7, t | 61);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  
  private hashRegion(x: number, y: number, seed: number): number {
    let h = seed;
    h = Math.imul(h ^ x, 0x9E3779B9);
    h = Math.imul(h ^ y, 0x85EBCA6B);
    h = h ^ (h >>> 13);
    return h >>> 0;
  }
  
  private hslToHex(h: number, s: number, l: number): number {
    h = ((h % 360) + 360) % 360;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs((h / 60) % 2 - 1));
    const m = l - c / 2;
    
    let r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; b = 0; }
    else if (h < 120) { r = x; g = c; b = 0; }
    else if (h < 180) { r = 0; g = c; b = x; }
    else if (h < 240) { r = 0; g = x; b = c; }
    else if (h < 300) { r = x; g = 0; b = c; }
    else { r = c; g = 0; b = x; }
    
    const ri = Math.round((r + m) * 255);
    const gi = Math.round((g + m) * 255);
    const bi = Math.round((b + m) * 255);
    
    return (ri << 16) | (gi << 8) | bi;
  }

  private updateUI() {
    const fpsEl = document.getElementById('fps');
    const cameraPosEl = document.getElementById('camera-pos');
    const zoomEl = document.getElementById('zoom-level');
    const entityCountEl = document.getElementById('entity-count');
    
    if (fpsEl) fpsEl.textContent = this.fps.toString();
    if (cameraPosEl) cameraPosEl.textContent = `${Math.round(this.cameraX)}, ${Math.round(this.cameraY)}`;
    if (zoomEl) zoomEl.textContent = `${this.cameraZoom.toFixed(2)}x`;
    if (entityCountEl) entityCountEl.textContent = `${this.entities.size + this.particles.length}`;
  }
  
  // ===== SPAWNING =====
  
  private spawnAtPosition(type: string, x: number, y: number) {
    switch (type) {
      case 'asteroid': this.spawnAsteroid(x, y); break;
      case 'drone': this.spawnEnemy('drone', x, y); break;
      case 'fighter': this.spawnEnemy('fighter', x, y); break;
      case 'boss': this.spawnEnemy('boss', x, y); break;
      case 'station': this.spawnStation(x, y); break;
      case 'portal': this.spawnPortal(x, y); break;
      case 'blackhole': this.spawnBlackHole(x, y); break;
      case 'wormhole': this.spawnWormhole(x, y); break;
      case 'comet': this.spawnComet(x, y); break;
      case 'nebula': this.spawnNebula(x, y); break;
      case 'gascloud': this.spawnGasCloud(x, y); break;
      case 'satellite': this.spawnSatellite(x, y); break;
      case 'ufo': this.spawnUfo(x, y); break;
      case 'spacewhale': this.spawnSpaceWhale(x, y); break;
      case 'derelict': this.spawnDerelict(x, y); break;
      case 'anomaly': this.spawnAnomaly(x, y); break;
    }
  }
  
  private spawnAsteroid(x: number, y: number) {
    const id = this.nextEntityId++;
    const graphic = new Container();
    const g = new Graphics();
    
    const radius = 30 + Math.random() * 40;
    const points: { x: number; y: number }[] = [];
    const numPoints = 8 + Math.floor(Math.random() * 6);
    
    for (let i = 0; i < numPoints; i++) {
      const angle = (i / numPoints) * Math.PI * 2;
      const r = radius * (0.7 + Math.random() * 0.4);
      points.push({ x: Math.cos(angle) * r, y: Math.sin(angle) * r });
    }
    
    g.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      g.lineTo(points[i].x, points[i].y);
    }
    g.closePath();
    g.fill({ color: 0x555555 });
    g.stroke({ color: 0x777777, width: 2 });
    
    graphic.addChild(g);
    
    this.entities.set(id, {
      id, type: 'asteroid', x, y,
      vx: (Math.random() - 0.5) * 20,
      vy: (Math.random() - 0.5) * 20,
      angle: Math.random() * Math.PI * 2,
      graphic,
    });
    
    this.entityContainer.addChild(graphic);
  }
  
  private spawnEnemy(type: string, x: number, y: number) {
    const id = this.nextEntityId++;
    const graphic = new Container();
    const g = new Graphics();
    
    let color = 0xff3333;
    let size = 20;
    
    switch (type) {
      case 'drone': color = 0xff6666; size = 15; break;
      case 'fighter': color = 0xff3333; size = 25; break;
      case 'boss': color = 0xff0000; size = 60; break;
    }
    
    g.moveTo(size, 0);
    g.lineTo(-size * 0.7, -size * 0.6);
    g.lineTo(-size * 0.4, 0);
    g.lineTo(-size * 0.7, size * 0.6);
    g.closePath();
    g.fill({ color });
    g.stroke({ color: 0xffffff, width: 1 });
    
    graphic.addChild(g);
    
    this.entities.set(id, {
      id, type: `enemy_${type}`, x, y,
      vx: (Math.random() - 0.5) * 50,
      vy: (Math.random() - 0.5) * 50,
      angle: Math.random() * Math.PI * 2,
      graphic,
    });
    
    this.entityContainer.addChild(graphic);
  }
  
  private spawnStation(x: number, y: number) {
    const id = this.nextEntityId++;
    const graphic = new Container();
    const g = new Graphics();
    
    g.rect(-40, -40, 80, 80);
    g.fill({ color: 0x3366aa });
    g.stroke({ color: 0x6699dd, width: 3 });
    g.circle(0, 0, 25);
    g.fill({ color: 0x4477bb });
    
    graphic.addChild(g);
    
    this.entities.set(id, {
      id, type: 'station', x, y,
      vx: 0, vy: 0, angle: 0, graphic,
    });
    
    this.entityContainer.addChild(graphic);
  }
  
  private spawnPortal(x: number, y: number) {
    const id = this.nextEntityId++;
    const graphic = new Container();
    const g = new Graphics();
    
    g.circle(0, 0, 60);
    g.stroke({ color: 0x9933ff, width: 8 });
    g.circle(0, 0, 50);
    g.fill({ color: 0x220033, alpha: 0.5 });
    
    graphic.addChild(g);
    
    this.entities.set(id, {
      id, type: 'portal', x, y,
      vx: 0, vy: 0, angle: 0, graphic,
    });
    
    this.entityContainer.addChild(graphic);
  }

  private spawnBlackHole(x: number, y: number) {
    const id = this.nextEntityId++;
    const graphic = new Container();
    const g = new Graphics();

    g.circle(0, 0, 70);
    g.fill({ color: 0x050008 });
    g.circle(0, 0, 85);
    g.stroke({ color: 0x7a3cff, width: 6 });
    g.circle(0, 0, 110);
    g.stroke({ color: 0x3a1a66, width: 4, alpha: 0.6 });

    graphic.addChild(g);
    this.entities.set(id, {
      id, type: 'blackhole', x, y,
      vx: 0, vy: 0, angle: 0, graphic,
    });
    this.entityContainer.addChild(graphic);
  }

  private spawnWormhole(x: number, y: number) {
    const id = this.nextEntityId++;
    const graphic = new Container();
    const g = new Graphics();

    for (let i = 0; i < 5; i++) {
      g.circle(0, 0, 40 + i * 12);
      g.stroke({ color: 0x33ccff, width: 3, alpha: 0.25 + i * 0.1 });
    }

    graphic.addChild(g);
    this.entities.set(id, {
      id, type: 'wormhole', x, y,
      vx: 0, vy: 0, angle: 0, graphic,
    });
    this.entityContainer.addChild(graphic);
  }

  private spawnComet(x: number, y: number) {
    const id = this.nextEntityId++;
    const graphic = new Container();
    const g = new Graphics();

    g.circle(0, 0, 18);
    g.fill({ color: 0xffffff });
    g.moveTo(-60, -10);
    g.lineTo(0, 0);
    g.lineTo(-60, 10);
    g.closePath();
    g.fill({ color: 0x88ccff, alpha: 0.6 });

    graphic.addChild(g);
    this.entities.set(id, {
      id, type: 'comet', x, y,
      vx: 120, vy: -40, angle: 0, graphic,
    });
    this.entityContainer.addChild(graphic);
  }

  private spawnNebula(x: number, y: number) {
    const id = this.nextEntityId++;
    const graphic = new Container();
    const g = new Graphics();
    const colors = [0x6633ff, 0x9933ff, 0x332266];

    for (let i = 0; i < 6; i++) {
      const r = 40 + Math.random() * 80;
      const cx = (Math.random() - 0.5) * 60;
      const cy = (Math.random() - 0.5) * 60;
      g.circle(cx, cy, r);
      g.fill({ color: colors[i % colors.length], alpha: 0.15 });
    }

    graphic.addChild(g);
    this.entities.set(id, {
      id, type: 'nebula', x, y,
      vx: 0, vy: 0, angle: 0, graphic,
    });
    this.entityContainer.addChild(graphic);
  }

  private spawnGasCloud(x: number, y: number) {
    const id = this.nextEntityId++;
    const graphic = new Container();
    const g = new Graphics();
    const colors = [0x88ffaa, 0x55cc88, 0x336644];

    for (let i = 0; i < 5; i++) {
      const r = 35 + Math.random() * 70;
      const cx = (Math.random() - 0.5) * 50;
      const cy = (Math.random() - 0.5) * 50;
      g.circle(cx, cy, r);
      g.fill({ color: colors[i % colors.length], alpha: 0.18 });
    }

    graphic.addChild(g);
    this.entities.set(id, {
      id, type: 'gascloud', x, y,
      vx: 0, vy: 0, angle: 0, graphic,
    });
    this.entityContainer.addChild(graphic);
  }

  private spawnSatellite(x: number, y: number) {
    const id = this.nextEntityId++;
    const graphic = new Container();
    const g = new Graphics();

    g.rect(-12, -10, 24, 20);
    g.fill({ color: 0xcccccc });
    g.rect(-40, -8, 20, 16);
    g.fill({ color: 0x3366ff });
    g.rect(20, -8, 20, 16);
    g.fill({ color: 0x3366ff });

    graphic.addChild(g);
    this.entities.set(id, {
      id, type: 'satellite', x, y,
      vx: 10, vy: 6, angle: 0, graphic,
    });
    this.entityContainer.addChild(graphic);
  }

  private spawnUfo(x: number, y: number) {
    const id = this.nextEntityId++;
    const graphic = new Container();
    const g = new Graphics();

    g.circle(0, -6, 12);
    g.fill({ color: 0x66ccff });
    g.rect(-36, -6, 72, 14);
    g.fill({ color: 0xaaaaaa });
    g.rect(-30, 8, 60, 6);
    g.fill({ color: 0x88ffcc, alpha: 0.5 });

    graphic.addChild(g);
    this.entities.set(id, {
      id, type: 'ufo', x, y,
      vx: 20, vy: -12, angle: 0, graphic,
    });
    this.entityContainer.addChild(graphic);
  }

  private spawnSpaceWhale(x: number, y: number) {
    const id = this.nextEntityId++;
    const graphic = new Container();
    const g = new Graphics();

    g.circle(0, 0, 55);
    g.fill({ color: 0x335577 });
    g.moveTo(40, -15);
    g.lineTo(95, 0);
    g.lineTo(40, 15);
    g.closePath();
    g.fill({ color: 0x2a3f55 });
    g.circle(-20, -10, 6);
    g.fill({ color: 0xffffff });

    graphic.addChild(g);
    this.entities.set(id, {
      id, type: 'spacewhale', x, y,
      vx: 15, vy: 0, angle: 0, graphic,
    });
    this.entityContainer.addChild(graphic);
  }

  private spawnDerelict(x: number, y: number) {
    const id = this.nextEntityId++;
    const graphic = new Container();
    const g = new Graphics();

    g.moveTo(-50, -15);
    g.lineTo(30, -25);
    g.lineTo(60, 0);
    g.lineTo(20, 25);
    g.lineTo(-45, 10);
    g.closePath();
    g.fill({ color: 0x555555 });
    g.stroke({ color: 0x888888, width: 2 });

    graphic.addChild(g);
    this.entities.set(id, {
      id, type: 'derelict', x, y,
      vx: -8, vy: 4, angle: 0, graphic,
    });
    this.entityContainer.addChild(graphic);
  }

  private spawnAnomaly(x: number, y: number) {
    const id = this.nextEntityId++;
    const graphic = new Container();
    const g = new Graphics();

    g.circle(0, 0, 40);
    g.stroke({ color: 0xff99ee, width: 3, alpha: 0.6 });
    g.moveTo(0, -30);
    g.lineTo(12, -8);
    g.lineTo(30, -6);
    g.lineTo(16, 6);
    g.lineTo(20, 28);
    g.lineTo(0, 14);
    g.lineTo(-20, 28);
    g.lineTo(-16, 6);
    g.lineTo(-30, -6);
    g.lineTo(-12, -8);
    g.closePath();
    g.fill({ color: 0xff66cc, alpha: 0.8 });

    graphic.addChild(g);
    this.entities.set(id, {
      id, type: 'anomaly', x, y,
      vx: 0, vy: 0, angle: 0, graphic,
    });
    this.entityContainer.addChild(graphic);
  }
  
  private spawnEffect(effect: string) {
    const x = this.cameraX;
    const y = this.cameraY;
    
    switch (effect) {
      case 'explosion': this.spawnExplosion(x, y); break;
      case 'shield': this.spawnShieldHit(x, y); break;
      case 'mining': this.spawnMiningParticles(x, y); break;
      case 'blaster': this.fireBlaster(x, y); break;
    }
  }
  
  private spawnExplosion(x: number, y: number) {
    for (let i = 0; i < 30; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 100 + Math.random() * 200;
      const g = new Graphics();
      const size = 3 + Math.random() * 5;
      const color = Math.random() > 0.5 ? 0xff6600 : 0xffff00;
      
      g.circle(0, 0, size);
      g.fill({ color });
      
      this.particles.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0.5 + Math.random() * 0.5,
        maxLife: 1,
        color, size, graphic: g,
      });
      
      this.effectContainer.addChild(g);
    }
  }
  
  private spawnShieldHit(x: number, y: number) {
    for (let i = 0; i < 20; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 50 + Math.random() * 100;
      const g = new Graphics();
      const size = 2 + Math.random() * 3;
      
      g.circle(0, 0, size);
      g.fill({ color: 0x00aaff });
      
      this.particles.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0.3 + Math.random() * 0.3,
        maxLife: 0.6,
        color: 0x00aaff, size, graphic: g,
      });
      
      this.effectContainer.addChild(g);
    }
  }
  
  private spawnMiningParticles(x: number, y: number) {
    for (let i = 0; i < 15; i++) {
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 0.5;
      const speed = 80 + Math.random() * 120;
      const g = new Graphics();
      const size = 2 + Math.random() * 4;
      
      g.circle(0, 0, size);
      g.fill({ color: 0x888888 });
      
      this.particles.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0.5 + Math.random() * 0.5,
        maxLife: 1,
        color: 0x888888, size, graphic: g,
      });
      
      this.effectContainer.addChild(g);
    }
  }
  
  private fireBlaster(x: number, y: number) {
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2;
      const speed = 500;
      const g = new Graphics();
      
      g.circle(0, 0, 5);
      g.fill({ color: 0x00ff00 });
      
      this.particles.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 1.5,
        maxLife: 1.5,
        color: 0x00ff00, size: 5, graphic: g,
      });
      
      this.effectContainer.addChild(g);
    }
  }
  
  private clearEntities() {
    for (const entity of this.entities.values()) {
      this.entityContainer.removeChild(entity.graphic);
    }
    this.entities.clear();
  }
  
  private clearAll() {
    this.clearEntities();
    
    for (const p of this.particles) {
      this.effectContainer.removeChild(p.graphic);
    }
    this.particles = [];
  }
}

// Initialize
const sandbox = new VisualSandbox();
sandbox.init();

// Expose for debugging
(window as any).sandbox = sandbox;
