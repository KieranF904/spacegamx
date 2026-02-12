/**
 * Login UI - Cinematic Login/Registration screen
 * 
 * Features:
 * - Huge animated sun using WebGL shader (same as in-game)
 * - Stylized glowing title
 * - Animated starfield background
 * - Particle effects
 * - Sleek modern login form
 */

import { Application, Container, Graphics } from 'pixi.js';
import { SunRenderer } from '../rendering/SunRenderer';
import { GlowRenderer } from '../rendering/GlowRenderer';
import { sunShaderDefs } from '@space-game/common';

export class LoginUI {
  private container: HTMLElement;
  private panel: HTMLElement;
  private visible = true;
  private startTime = Date.now();
  
  // PixiJS WebGL rendering
  private app: Application | null = null;
  private worldContainer: Container | null = null;
  private sunRenderer: SunRenderer | null = null;
  private glowRenderer: GlowRenderer | null = null;
  private starsGraphics: Graphics | null = null;
  private pixiInitialized = false;
  
  // Star field
  private stars: Array<{ x: number; y: number; z: number; size: number; phase: number }> = [];
  
  // Debug sliders values - fBM + Plasma shader params
  private debugParams = {
    // === fBM CORE ===
    octaves: 5.0,           // Number of noise octaves (1-8)
    lacunarity: 2.0,        // Frequency multiplier per octave
    gain: 0.5,              // Amplitude multiplier per octave
    noiseScale: 4.0,        // Overall noise scale
    animSpeed: 0.15,        // Animation speed
    contrast: 1.0,          // Output contrast
    // === DOMAIN WARPING ===
    warpAmount: 0.4,        // Warp strength
    warpScale: 0.5,         // Warp noise scale
    turbulenceMix: 0.3,     // Smooth vs turbulent fBM
    // === PLASMA OVERLAY ===
    plasmaIntensity: 0.3,   // Plasma effect strength
    plasmaScale: 3.0,       // Plasma pattern scale
    plasmaSpeed: 1.0,       // Plasma animation speed
    // === CENTER CONTRAST ===
    centerDarken: 0.5,      // Darken dark areas toward center
    centerHighlight: 0.5,   // Highlight bright areas toward center
    centerFalloff: 1.5,     // Center effect falloff curve
    // === INSIDE ADJUST ===
    innerDarkening: 0.0,    // Darken the center (opposite of limb)
    whiteBalance: 0.0,      // Warm (+) / Cool (-) shift
    saturation: 1.0,        // Color saturation
    // === EDGE STYLING ===
    edgeBrightness: 1.0,    // Edge brightness multiplier
    edgeThickness: 0.03,    // Edge thickness
    edgeSharpness: 0.5,     // Edge sharpness/falloff
    limbDarkening: 0.5,     // Darken towards edges
    glowIntensity: 0.4,     // Edge glow strength
    glowSize: 0.1,          // How far glow extends
    // === CORONA ===
    coronaSize: 2.0,
    coronaIntensity: 0.8,
    // === COLORS (hex strings) ===
    darkColor: '#1a0500',   // Darkest
    midColor: '#661100',    // Mid-tone
    brightColor: '#ff6600', // Brightest
    edgeColor: '#ffaa33',   // Highlight/edge color
    plasmaColor: '#ff9933', // Plasma overlay color
    centerColor: '#ffe6cc', // Center light color
  };
  
  // Callbacks
  public onLogin: ((username: string, password: string) => void) | null = null;
  public onRegister: ((username: string, password: string, email: string) => void) | null = null;
  public onPlayAsGuest: (() => void) | null = null;
  
  private mode: 'login' | 'register' = 'login';
  private errorMessage = '';
  private loading = false;

  constructor(container: HTMLElement) {
    this.container = container;
    
    // Create login panel
    this.panel = document.createElement('div');
    this.panel.id = 'login-panel';
    this.panel.className = 'ui-element';
    container.appendChild(this.panel);
    
    this.setupStyles();
    this.initStars();
    this.render();
    this.initPixi();
  }
  
  private async initPixi(): Promise<void> {
    // Create PixiJS application
    this.app = new Application();
    await this.app.init({
      width: window.innerWidth,
      height: window.innerHeight,
      backgroundColor: 0x000005,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
      antialias: true,
    });
    
    // Insert canvas into the login panel before other content
    const canvas = this.app.canvas as HTMLCanvasElement;
    canvas.id = 'login-canvas';
    canvas.style.position = 'absolute';
    canvas.style.top = '0';
    canvas.style.left = '0';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.zIndex = '0';
    this.panel.insertBefore(canvas, this.panel.firstChild);
    
    // Create container hierarchy
    this.worldContainer = new Container();
    this.app.stage.addChild(this.worldContainer);
    
    // Stars layer
    this.starsGraphics = new Graphics();
    this.worldContainer.addChild(this.starsGraphics);
    
    // Initialize GPU renderers
    this.glowRenderer = new GlowRenderer();
    this.glowRenderer.initialize();
    this.worldContainer.addChild(this.glowRenderer.getContainer());
    
    this.sunRenderer = new SunRenderer();
    this.sunRenderer.initialize();
    this.worldContainer.addChild(this.sunRenderer.getContainer());
    
    // Set up the brownian sun style
    this.setupBrownianSunStyle();
    
    // Position sun at bottom center
    this.updateSunPosition();
    
    // Handle resize
    window.addEventListener('resize', this.handleResize);
    
    // Start animation loop
    this.app.ticker.add(() => this.updateAnimation());
    
    this.pixiInitialized = true;
  }
  
  private setupBrownianSunStyle(): void {
    if (!this.sunRenderer) return;
    
    // Find the brownian style index
    const brownianIndex = sunShaderDefs.sunStyles.findIndex(s => s.id === 'brownian');
    
    // Set up corona style (plasma streams looks nice)
    const coronaIndex = sunShaderDefs.coronaStyles.findIndex(s => s.id === 'plasmaStreams');
    const coronaStyle = sunShaderDefs.coronaStyles[coronaIndex] || sunShaderDefs.coronaStyles[0];
    const coronaParams = coronaStyle.params.map(p => p.default);
    this.sunRenderer.setCoronaStyle(coronaIndex >= 0 ? coronaIndex : 0, coronaParams);
    
    // Set sun visual parameters
    this.sunRenderer.setRadius(0.4);
    this.sunRenderer.setLOD(1.0); // Full detail
    
    // Apply debug params (this sets the sun style and corona)
    this.applyDebugParams();
  }
  
  private updateSunPosition(): void {
    if (!this.sunRenderer || !this.glowRenderer || !this.app) return;
    
    const w = this.app.screen.width;
    const h = this.app.screen.height;
    
    // Position sun at bottom center, partially visible (top half showing)
    const sunX = w / 2;
    const sunY = h * 0.85; // 85% down = sun rises from bottom with top half visible
    
    this.sunRenderer.setPosition(sunX, sunY);
    this.glowRenderer.setPosition(sunX, sunY);
  }
  
  private updateAnimation(): void {
    if (!this.visible || !this.app || !this.sunRenderer || !this.glowRenderer) return;
    
    const time = (Date.now() - this.startTime) / 1000;
    const delta = this.app.ticker.deltaMS / 1000;
    const w = this.app.screen.width;
    const h = this.app.screen.height;
    
    // Update sun shader
    const sunRadius = Math.min(w, h) * 0.3;
    const glowRadius = sunRadius * 4;
    const hue = 30;
    
    this.sunRenderer.update(delta, hue, sunRadius, { width: w, height: h });
    this.glowRenderer.update(delta, hue, sunRadius, glowRadius, 0, 0);
    
    // Draw stars
    this.drawStars(time);
  }
  
  private drawStars(time: number): void {
    if (!this.starsGraphics || !this.app) return;
    
    const g = this.starsGraphics;
    const w = this.app.screen.width;
    const h = this.app.screen.height;
    
    g.clear();
    
    for (const star of this.stars) {
      const parallax = 0.5 + star.z * 0.5;
      const x = ((star.x * parallax + 1) / 2) * w;
      const y = ((star.y * parallax + 1) / 2) * h;
      
      // Twinkle effect
      const twinkle = 0.5 + 0.5 * Math.sin(time * 2 + star.phase);
      const alpha = (0.3 + star.z * 0.7) * twinkle;
      
      g.circle(x, y, star.size * star.z);
      g.fill({ color: 0xffffff, alpha });
    }
  }
  
  private initStars(): void {
    // Create 300 stars with depth
    for (let i = 0; i < 300; i++) {
      this.stars.push({
        x: Math.random() * 2 - 1,
        y: Math.random() * 2 - 1,
        z: Math.random(),
        size: 0.5 + Math.random() * 2,
        phase: Math.random() * Math.PI * 2,
      });
    }
  }

  private setupStyles(): void {
    const style = document.createElement('style');
    style.id = 'login-ui-styles';
    
    // Remove old styles if they exist
    const oldStyle = document.getElementById('login-ui-styles');
    if (oldStyle) oldStyle.remove();
    
    style.textContent = `
      #login-panel {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        display: flex;
        align-items: center;
        justify-content: center;
        background: #000;
        z-index: 2000;
        overflow: hidden;
      }
      
      #login-canvas {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        z-index: 0;
      }
      
      .login-content {
        position: relative;
        z-index: 10;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 30px;
        margin-top: -10vh;
      }
      
      .login-title-container {
        text-align: center;
        margin-bottom: 20px;
      }
      
      .login-title {
        font-size: 72px;
        font-weight: 900;
        color: #fff;
        text-shadow: 
          0 0 10px rgba(255, 200, 100, 0.8),
          0 0 20px rgba(255, 150, 50, 0.6),
          0 0 40px rgba(255, 100, 0, 0.4),
          0 0 80px rgba(255, 50, 0, 0.3);
        letter-spacing: 12px;
        animation: titlePulse 3s ease-in-out infinite;
        font-family: 'Orbitron', 'Rajdhani', 'Arial Black', sans-serif;
        text-transform: uppercase;
      }
      
      @keyframes titlePulse {
        0%, 100% { 
          text-shadow: 
            0 0 10px rgba(255, 200, 100, 0.8),
            0 0 20px rgba(255, 150, 50, 0.6),
            0 0 40px rgba(255, 100, 0, 0.4),
            0 0 80px rgba(255, 50, 0, 0.3);
        }
        50% { 
          text-shadow: 
            0 0 15px rgba(255, 200, 100, 1),
            0 0 30px rgba(255, 150, 50, 0.8),
            0 0 60px rgba(255, 100, 0, 0.6),
            0 0 100px rgba(255, 50, 0, 0.4);
        }
      }
      
      .login-subtitle {
        font-size: 16px;
        color: #ff9944;
        letter-spacing: 8px;
        text-transform: uppercase;
        opacity: 0.8;
        margin-top: 10px;
        font-family: 'Rajdhani', 'Arial', sans-serif;
      }
      
      .login-container {
        width: 380px;
        background: rgba(0, 0, 0, 0.7);
        backdrop-filter: blur(10px);
        border: 1px solid rgba(255, 150, 50, 0.3);
        border-radius: 16px;
        padding: 30px;
        box-shadow: 
          0 0 40px rgba(255, 100, 0, 0.1),
          inset 0 0 60px rgba(0, 0, 0, 0.5);
      }
      
      .login-tabs {
        display: flex;
        margin-bottom: 25px;
        border-bottom: 1px solid rgba(255, 150, 50, 0.2);
      }
      
      .login-tab {
        flex: 1;
        padding: 12px;
        text-align: center;
        cursor: pointer;
        color: rgba(255, 200, 150, 0.5);
        border-bottom: 2px solid transparent;
        transition: all 0.3s;
        font-family: 'Rajdhani', 'Arial', sans-serif;
        font-size: 14px;
        letter-spacing: 2px;
        text-transform: uppercase;
      }
      
      .login-tab:hover {
        color: rgba(255, 200, 150, 0.8);
        background: rgba(255, 150, 50, 0.05);
      }
      
      .login-tab.active {
        color: #ffaa55;
        border-bottom-color: #ff8833;
      }
      
      .login-form {
        display: flex;
        flex-direction: column;
        gap: 18px;
      }
      
      .form-group {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      
      .form-group label {
        font-size: 11px;
        color: rgba(255, 200, 150, 0.6);
        text-transform: uppercase;
        letter-spacing: 2px;
        font-family: 'Rajdhani', 'Arial', sans-serif;
      }
      
      .form-group input {
        padding: 14px 16px;
        background: rgba(0, 0, 0, 0.5);
        border: 1px solid rgba(255, 150, 50, 0.2);
        border-radius: 8px;
        color: #fff;
        font-size: 15px;
        outline: none;
        transition: all 0.3s;
        font-family: 'Rajdhani', 'Arial', sans-serif;
      }
      
      .form-group input:focus {
        border-color: #ff8833;
        box-shadow: 0 0 20px rgba(255, 100, 0, 0.2);
        background: rgba(20, 10, 0, 0.6);
      }
      
      .form-group input::placeholder {
        color: rgba(255, 200, 150, 0.3);
      }
      
      .login-button {
        padding: 16px;
        background: linear-gradient(180deg, #ff6600 0%, #cc3300 100%);
        border: none;
        border-radius: 8px;
        color: #fff;
        font-size: 15px;
        font-weight: bold;
        cursor: pointer;
        transition: all 0.3s;
        text-transform: uppercase;
        letter-spacing: 3px;
        font-family: 'Rajdhani', 'Arial', sans-serif;
        margin-top: 5px;
        box-shadow: 0 4px 20px rgba(255, 100, 0, 0.3);
      }
      
      .login-button:hover {
        background: linear-gradient(180deg, #ff8833 0%, #ff5500 100%);
        box-shadow: 0 6px 30px rgba(255, 100, 0, 0.5);
        transform: translateY(-2px);
      }
      
      .login-button:active {
        transform: translateY(0);
      }
      
      .login-button:disabled {
        background: #333;
        cursor: not-allowed;
        box-shadow: none;
        transform: none;
      }
      
      .guest-button {
        padding: 14px;
        background: transparent;
        border: 1px solid rgba(255, 150, 50, 0.3);
        border-radius: 8px;
        color: rgba(255, 200, 150, 0.7);
        font-size: 13px;
        cursor: pointer;
        transition: all 0.3s;
        font-family: 'Rajdhani', 'Arial', sans-serif;
        letter-spacing: 2px;
      }
      
      .guest-button:hover {
        border-color: #ff8833;
        color: #ffaa55;
        background: rgba(255, 100, 0, 0.1);
      }
      
      .login-error {
        padding: 12px;
        background: rgba(200, 50, 50, 0.2);
        border: 1px solid rgba(255, 100, 100, 0.3);
        border-radius: 6px;
        color: #ff6666;
        font-size: 13px;
        text-align: center;
        font-family: 'Rajdhani', 'Arial', sans-serif;
      }
      
      .login-divider {
        display: flex;
        align-items: center;
        gap: 15px;
        color: rgba(255, 200, 150, 0.3);
        font-size: 11px;
        margin: 8px 0;
        text-transform: uppercase;
        letter-spacing: 2px;
      }
      
      .login-divider::before,
      .login-divider::after {
        content: '';
        flex: 1;
        height: 1px;
        background: linear-gradient(90deg, transparent, rgba(255, 150, 50, 0.2), transparent);
      }
      
      .version-info {
        position: absolute;
        bottom: 20px;
        left: 50%;
        transform: translateX(-50%);
        font-size: 12px;
        color: rgba(255, 200, 150, 0.3);
        letter-spacing: 2px;
        font-family: 'Rajdhani', 'Arial', sans-serif;
      }
      
      .credits-link {
        position: absolute;
        bottom: 20px;
        right: 20px;
        font-size: 11px;
        color: rgba(255, 200, 150, 0.3);
        text-decoration: none;
        letter-spacing: 1px;
        transition: color 0.3s;
      }
      
      .credits-link:hover {
        color: #ff8833;
      }
      
      /* Loading spinner */
      .spinner {
        display: inline-block;
        width: 16px;
        height: 16px;
        border: 2px solid rgba(255, 255, 255, 0.3);
        border-top-color: #fff;
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
        margin-right: 8px;
        vertical-align: middle;
      }
      
      @keyframes spin {
        to { transform: rotate(360deg); }
      }
      
      /* Debug Panel Styles */
      .debug-panel {
        position: fixed;
        top: 10px;
        left: 10px;
        background: rgba(0, 0, 0, 0.85);
        border: 1px solid rgba(255, 150, 50, 0.4);
        border-radius: 8px;
        padding: 10px;
        z-index: 9999;
        font-family: monospace;
        font-size: 11px;
        color: #ffaa66;
        min-width: 220px;
        max-height: 90vh;
        overflow-y: auto;
      }
      
      .debug-panel-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        cursor: pointer;
        padding-bottom: 8px;
        border-bottom: 1px solid rgba(255, 150, 50, 0.3);
        margin-bottom: 8px;
      }
      
      .debug-panel-title {
        font-weight: bold;
        font-size: 12px;
      }
      
      .debug-panel-content {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      
      .debug-panel.collapsed .debug-panel-content {
        display: none;
      }
      
      .debug-slider-group {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      
      .debug-slider-label {
        display: flex;
        justify-content: space-between;
        font-size: 10px;
      }
      
      .debug-slider-label span:last-child {
        color: #ffcc88;
      }
      
      .debug-slider {
        width: 100%;
        height: 4px;
        -webkit-appearance: none;
        background: rgba(255, 150, 50, 0.2);
        border-radius: 2px;
        outline: none;
      }
      
      .debug-slider::-webkit-slider-thumb {
        -webkit-appearance: none;
        width: 12px;
        height: 12px;
        background: #ff8833;
        border-radius: 50%;
        cursor: pointer;
      }
      
      .debug-slider::-moz-range-thumb {
        width: 12px;
        height: 12px;
        background: #ff8833;
        border-radius: 50%;
        cursor: pointer;
        border: none;
      }
      
      .debug-color-section {
        margin-top: 8px;
        padding-top: 8px;
        border-top: 1px solid rgba(255, 150, 50, 0.3);
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      
      .debug-color-group {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 2px;
      }
      
      .debug-color-group label {
        font-size: 9px;
      }
      
      .debug-color-group input[type="color"] {
        width: 32px;
        height: 20px;
        border: 1px solid rgba(255, 150, 50, 0.4);
        border-radius: 4px;
        background: transparent;
        cursor: pointer;
        padding: 0;
      }
      
      .debug-group {
        margin-bottom: 6px;
        padding-bottom: 6px;
        border-bottom: 1px solid rgba(255, 150, 50, 0.15);
      }
      
      .debug-group:last-of-type {
        border-bottom: none;
      }
      
      .debug-group-title {
        font-weight: bold;
        font-size: 10px;
        color: #ff9944;
        margin-bottom: 4px;
        text-transform: uppercase;
        letter-spacing: 1px;
      }
      
      /* Import Google Font */
      @import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@700;900&family=Rajdhani:wght@400;500;600&display=swap');
    `;
    document.head.appendChild(style);
    
    // Create debug panel
    this.createDebugPanel();
  }
  
  private createDebugPanel(): void {
    const existingPanel = document.getElementById('sun-debug-panel');
    if (existingPanel) existingPanel.remove();
    
    const panel = document.createElement('div');
    panel.id = 'sun-debug-panel';
    panel.className = 'debug-panel';
    
    const sliders = [
      // fBM Core
      { key: 'octaves', label: 'Octaves', min: 1, max: 8, step: 1, group: 'fBM' },
      { key: 'lacunarity', label: 'Lacunarity', min: 1.5, max: 3.0, step: 0.1, group: 'fBM' },
      { key: 'gain', label: 'Gain', min: 0.1, max: 0.9, step: 0.05, group: 'fBM' },
      { key: 'noiseScale', label: 'Noise Scale', min: 1, max: 10, step: 0.5, group: 'fBM' },
      { key: 'animSpeed', label: 'Anim Speed', min: 0.01, max: 0.5, step: 0.01, group: 'fBM' },
      { key: 'contrast', label: 'Contrast', min: 0.5, max: 2.0, step: 0.1, group: 'fBM' },
      // Domain Warping
      { key: 'warpAmount', label: 'Warp Amount', min: 0, max: 1.5, step: 0.05, group: 'Warp' },
      { key: 'warpScale', label: 'Warp Scale', min: 0.1, max: 2.0, step: 0.1, group: 'Warp' },
      { key: 'turbulenceMix', label: 'Turbulence', min: 0, max: 1, step: 0.05, group: 'Warp' },
      // Plasma
      { key: 'plasmaIntensity', label: 'Intensity', min: 0, max: 1, step: 0.05, group: 'Plasma' },
      { key: 'plasmaScale', label: 'Scale', min: 0.5, max: 8, step: 0.5, group: 'Plasma' },
      { key: 'plasmaSpeed', label: 'Speed', min: 0.1, max: 3, step: 0.1, group: 'Plasma' },
      // Center Contrast
      { key: 'centerDarken', label: 'Darken Darks', min: 0, max: 2, step: 0.1, group: 'Center' },
      { key: 'centerHighlight', label: 'Highlight Brights', min: 0, max: 2, step: 0.1, group: 'Center' },
      { key: 'centerFalloff', label: 'Falloff', min: 0.5, max: 5, step: 0.25, group: 'Center' },
      // Inside Adjust
      { key: 'innerDarkening', label: 'Inner Dark', min: 0, max: 1, step: 0.05, group: 'Inside' },
      { key: 'whiteBalance', label: 'Warm/Cool', min: -1, max: 1, step: 0.1, group: 'Inside' },
      { key: 'saturation', label: 'Saturation', min: 0, max: 2, step: 0.1, group: 'Inside' },
      // Edge Styling
      { key: 'edgeBrightness', label: 'Brightness', min: 0.2, max: 2, step: 0.1, group: 'Edge' },
      { key: 'edgeThickness', label: 'Thickness', min: 0.01, max: 0.15, step: 0.01, group: 'Edge' },
      { key: 'edgeSharpness', label: 'Sharpness', min: 0.1, max: 1, step: 0.05, group: 'Edge' },
      { key: 'limbDarkening', label: 'Limb Dark', min: 0, max: 1, step: 0.05, group: 'Edge' },
      { key: 'glowIntensity', label: 'Glow', min: 0, max: 1, step: 0.05, group: 'Edge' },
      { key: 'glowSize', label: 'Glow Size', min: 0.01, max: 0.3, step: 0.01, group: 'Edge' },
      // Corona
      { key: 'coronaSize', label: 'Size', min: 0.5, max: 4, step: 0.1, group: 'Corona' },
      { key: 'coronaIntensity', label: 'Intensity', min: 0, max: 2, step: 0.1, group: 'Corona' },
    ];
    
    const colors = [
      { key: 'darkColor', label: 'Dark' },
      { key: 'midColor', label: 'Mid' },
      { key: 'brightColor', label: 'Bright' },
      { key: 'edgeColor', label: 'Edge' },
      { key: 'plasmaColor', label: 'Plasma' },
      { key: 'centerColor', label: 'Center' },
    ];
    
    // Group sliders by category
    const groups = ['fBM', 'Warp', 'Plasma', 'Center', 'Inside', 'Edge', 'Corona'];
    
    panel.innerHTML = `
      <div class="debug-panel-header">
        <span class="debug-panel-title">☀️ Sun Debug</span>
        <span>▼</span>
      </div>
      <div class="debug-panel-content">
        ${groups.map(group => `
          <div class="debug-group">
            <div class="debug-group-title">${group}</div>
            ${sliders.filter(s => s.group === group).map(s => `
              <div class="debug-slider-group">
                <div class="debug-slider-label">
                  <span>${s.label}</span>
                  <span id="val-${s.key}">${(this.debugParams as any)[s.key].toFixed(2)}</span>
                </div>
                <input type="range" class="debug-slider" 
                  id="slider-${s.key}" 
                  min="${s.min}" max="${s.max}" step="${s.step}" 
                  value="${(this.debugParams as any)[s.key]}">
              </div>
            `).join('')}
          </div>
        `).join('')}
        <div class="debug-color-section">
          ${colors.map(c => `
            <div class="debug-color-group">
              <label>${c.label}</label>
              <input type="color" id="color-${c.key}" value="${(this.debugParams as any)[c.key]}">
            </div>
          `).join('')}
        </div>
      </div>
    `;
    
    document.body.appendChild(panel);
    
    // Toggle collapse
    const header = panel.querySelector('.debug-panel-header');
    header?.addEventListener('click', () => {
      panel.classList.toggle('collapsed');
      const arrow = header.querySelector('span:last-child');
      if (arrow) arrow.textContent = panel.classList.contains('collapsed') ? '▶' : '▼';
    });
    
    // Bind sliders
    sliders.forEach(s => {
      const slider = document.getElementById(`slider-${s.key}`) as HTMLInputElement;
      const valDisplay = document.getElementById(`val-${s.key}`);
      
      slider?.addEventListener('input', () => {
        const val = parseFloat(slider.value);
        (this.debugParams as any)[s.key] = val;
        if (valDisplay) valDisplay.textContent = val.toFixed(2);
        this.applyDebugParams();
      });
    });
    
    // Bind color pickers
    colors.forEach(c => {
      const picker = document.getElementById(`color-${c.key}`) as HTMLInputElement;
      picker?.addEventListener('input', () => {
        (this.debugParams as any)[c.key] = picker.value;
        this.applyDebugParams();
      });
    });
  }
  
  // Helper to convert hex color to RGB array
  private hexToRgb(hex: string): [number, number, number] {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (result) {
      return [
        parseInt(result[1], 16) / 255,
        parseInt(result[2], 16) / 255,
        parseInt(result[3], 16) / 255
      ];
    }
    return [0, 0, 0];
  }
  
  private applyDebugParams(): void {
    if (!this.sunRenderer) return;
    
    // Apply corona settings
    this.sunRenderer.setCoronaSize(this.debugParams.coronaSize);
    this.sunRenderer.setCoronaIntensity(this.debugParams.coronaIntensity);
    
    // Apply custom colors (4 colors: dark, mid, bright, edge)
    const darkRgb = this.hexToRgb(this.debugParams.darkColor);
    const midRgb = this.hexToRgb(this.debugParams.midColor);
    const brightRgb = this.hexToRgb(this.debugParams.brightColor);
    const edgeRgb = this.hexToRgb(this.debugParams.edgeColor);
    this.sunRenderer.setCustomColors(darkRgb, midRgb, brightRgb, edgeRgb);
    
    // Apply warp params: warpScale, unused, turbulenceMix
    this.sunRenderer.setWarpParams(
      this.debugParams.warpScale,
      0.0, // unused
      this.debugParams.turbulenceMix
    );
    
    // Apply fBM params: noiseScale, animSpeed, contrast
    this.sunRenderer.setFbmParams(
      this.debugParams.noiseScale,
      this.debugParams.animSpeed,
      this.debugParams.contrast
    );
    
    // Apply plasma params: intensity, scale, speed
    this.sunRenderer.setPlasmaParams(
      this.debugParams.plasmaIntensity,
      this.debugParams.plasmaScale,
      this.debugParams.plasmaSpeed
    );
    
    // Apply plasma color
    const plasmaRgb = this.hexToRgb(this.debugParams.plasmaColor);
    this.sunRenderer.setPlasmaColor(plasmaRgb);
    
    // Apply center contrast: darken, highlight, falloff
    this.sunRenderer.setCenterLight(
      this.debugParams.centerDarken,
      this.debugParams.centerHighlight,
      this.debugParams.centerFalloff
    );
    
    // Apply center color
    const centerRgb = this.hexToRgb(this.debugParams.centerColor);
    this.sunRenderer.setCenterColor(centerRgb);
    
    // Apply inside adjustments: innerDarkening, whiteBalance, saturation
    this.sunRenderer.setInsideAdjust(
      this.debugParams.innerDarkening,
      this.debugParams.whiteBalance,
      this.debugParams.saturation
    );
    
    // Apply edge style: brightness, thickness, sharpness
    this.sunRenderer.setEdgeStyle(
      this.debugParams.edgeBrightness,
      this.debugParams.edgeThickness,
      this.debugParams.edgeSharpness
    );
    
    // Apply edge glow: limbDarkening, glowIntensity, glowSize
    this.sunRenderer.setEdgeGlow(
      this.debugParams.limbDarkening,
      this.debugParams.glowIntensity,
      this.debugParams.glowSize
    );
    
    // Get brownian style index (should be 2)
    const brownianIndex = sunShaderDefs.sunStyles.findIndex(s => s.id === 'brownian');
    const styleIndex = brownianIndex >= 0 ? brownianIndex : 2;
    
    // Apply sun style params (fBM core): [coreRadius, octaves, lacunarity, gain, unused, warpAmount]
    const sunParams = [
      0.5,                              // coreRadius
      this.debugParams.octaves,         // octaves (1-8)
      this.debugParams.lacunarity,      // lacunarity (freq multiplier)
      this.debugParams.gain,            // gain (amplitude multiplier)
      0.9,                              // unused
      this.debugParams.warpAmount,      // warpAmount for domain warping
    ];
    this.sunRenderer.setSunStyle(styleIndex, sunParams);
  }

  private render(): void {
    const isLogin = this.mode === 'login';
    
    // Keep existing canvas if PixiJS already initialized
    const existingCanvas = this.panel.querySelector('#login-canvas');
    
    this.panel.innerHTML = `
      <div class="login-content">
        <div class="login-title-container">
          <div class="login-title">SPACE GAME</div>
          <div class="login-subtitle">Journey to the Stars</div>
        </div>
        
        <div class="login-container">
          <div class="login-tabs">
            <div class="login-tab ${isLogin ? 'active' : ''}" data-mode="login">Sign In</div>
            <div class="login-tab ${!isLogin ? 'active' : ''}" data-mode="register">Create Account</div>
          </div>
          
          ${this.errorMessage ? `<div class="login-error">${this.errorMessage}</div>` : ''}
          
          <form class="login-form">
            <div class="form-group">
              <label>Username</label>
              <input type="text" name="username" placeholder="Enter your username" required minlength="3" maxlength="20" autocomplete="username">
            </div>
            
            ${!isLogin ? `
            <div class="form-group">
              <label>Email</label>
              <input type="email" name="email" placeholder="Enter your email" required autocomplete="email">
            </div>
            ` : ''}
            
            <div class="form-group">
              <label>Password</label>
              <input type="password" name="password" placeholder="Enter your password" required autocomplete="${isLogin ? 'current-password' : 'new-password'}">
            </div>
            
            ${!isLogin ? `
            <div class="form-group">
              <label>Confirm Password</label>
              <input type="password" name="confirmPassword" placeholder="Confirm your password" required autocomplete="new-password">
            </div>
            ` : ''}
            
            <button type="submit" class="login-button" ${this.loading ? 'disabled' : ''}>
              ${this.loading ? '<span class="spinner"></span>Please wait...' : (isLogin ? 'Launch' : 'Create Account')}
            </button>
          </form>
          
          <div class="login-divider">or</div>
          
          <button class="guest-button" ${this.loading ? 'disabled' : ''}>Quick Play as Guest</button>
        </div>
      </div>
      
      <div class="version-info">v2.0</div>
    `;
    
    // Re-insert pixi canvas if it exists
    if (existingCanvas) {
      this.panel.insertBefore(existingCanvas, this.panel.firstChild);
    }
    
    this.setupEventListeners();
  }
  
  private handleResize = (): void => {
    if (this.app) {
      this.app.renderer.resize(window.innerWidth, window.innerHeight);
      this.updateSunPosition();
    }
  };

  private setupEventListeners(): void {
    // Tab switching
    const tabs = this.panel.querySelectorAll('.login-tab');
    tabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        this.mode = (tab as HTMLElement).dataset.mode as 'login' | 'register';
        this.errorMessage = '';
        this.render();
      });
    });
    
    // Form submission
    const form = this.panel.querySelector('.login-form');
    form?.addEventListener('submit', (e) => {
      e.preventDefault();
      this.handleSubmit();
    });
    
    // Guest button
    const guestBtn = this.panel.querySelector('.guest-button');
    guestBtn?.addEventListener('click', () => {
      this.onPlayAsGuest?.();
    });
  }

  private handleSubmit(): void {
    const form = this.panel.querySelector('.login-form') as HTMLFormElement;
    const formData = new FormData(form);
    
    const username = formData.get('username') as string;
    const password = formData.get('password') as string;
    
    if (this.mode === 'login') {
      this.onLogin?.(username, password);
    } else {
      const email = formData.get('email') as string;
      const confirmPassword = formData.get('confirmPassword') as string;
      
      if (password !== confirmPassword) {
        this.showError('Passwords do not match');
        return;
      }
      
      this.onRegister?.(username, password, email);
    }
  }

  showError(message: string): void {
    this.errorMessage = message;
    this.loading = false;
    this.render();
  }

  setLoading(loading: boolean): void {
    this.loading = loading;
    this.render();
  }

  show(): void {
    this.visible = true;
    this.panel.style.display = 'flex';
  }

  hide(): void {
    this.visible = false;
    this.panel.style.display = 'none';
    window.removeEventListener('resize', this.handleResize);
  }

  isVisible(): boolean {
    return this.visible;
  }
  
  destroy(): void {
    window.removeEventListener('resize', this.handleResize);
    
    // Clean up PixiJS
    if (this.sunRenderer) {
      this.sunRenderer.destroy();
      this.sunRenderer = null;
    }
    if (this.glowRenderer) {
      this.glowRenderer.destroy();
      this.glowRenderer = null;
    }
    if (this.app) {
      this.app.destroy(true);
      this.app = null;
    }
  }
}
