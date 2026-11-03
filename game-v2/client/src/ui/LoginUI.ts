/**
 * Login UI - Cinematic Login/Registration screen
 * 
 * Features:
 * - A huge body of Sol under the form, a different one each visit (ui/loginBody.ts): the sun (rendering/sun/SunRenderer.ts)
 *   or a planet or moon as the game draws them, by the game's own renderer
 * - Stylized glowing title
 * - Animated starfield background
 * - Particle effects
 * - Sleek modern login form
 */

import { Application, Container, Graphics, type GlProgram } from 'pixi.js';
import { SunRenderer } from '../rendering/sun/SunRenderer';
import { batchProgram, shaderReady } from '../rendering/shaderWarmup';
import type { StarSystemData } from '@space-game/common';
import systemsData from '../../../data/systems.json';
import { LoginBody, loginBodyForVisit } from './loginBody';
import { SkyRenderer, skyPrograms } from '../rendering/sky/SkyRenderer';
import { skyBiome, type BiomeHints } from '../rendering/sky/skyBiome';
import { attachVolumeUploads } from '../rendering/planet-proto/planetTextures';

export class LoginUI {
  private container: HTMLElement;
  private panel: HTMLElement;
  private visible = true;
  private startTime = Date.now();
  
  // The backdrop: drawn by the game's renderer in the world's place while the screen is up (one WebGL context, so its
  // shaders compile once, and ahead: see shaderWarmup), on the game's canvas, borrowed into the panel
  private app: Application;
  private worldContainer: Container | null = null;
  /** The star (it shows itself once its noise and program are ready) */
  private sunRenderer: SunRenderer | null = null;
  /** Sol's sky behind it all */
  private sky: SkyRenderer | null = null;
  private skyW = 0;
  private skyH = 0;
  /** Or this visit's planet or moon of Sol (loginBody.ts), in the sun's place */
  private body: LoginBody | null = null;
  private starsGraphics: Graphics | null = null;
  /** The backdrop's parts and the programs each waits for: shown once they're compiled (a first visit's first frames aren't held up) */
  private parts: [Container, GlProgram[]][] = [];
  /** Where the game's canvas goes back to when the screen is hidden */
  private canvasHome: { parent: Node; next: Node | null } | null = null;
  
  // Star field
  private stars: Array<{ x: number; y: number; z: number; size: number; phase: number }> = [];
  
  // Callbacks
  public onLogin: ((username: string, password: string) => void) | null = null;
  public onRegister: ((username: string, password: string, email: string) => void) | null = null;
  public onPlayAsGuest: (() => void) | null = null;
  /** After it's shown or hidden (the game renders at the screen's density while it's up) */
  public onVisibility: (() => void) | null = null;
  
  private mode: 'login' | 'register' = 'login';
  private errorMessage = '';
  private loading = false;

  constructor(container: HTMLElement, app: Application) {
    this.container = container;
    this.app = app;
    
    // Create login panel
    this.panel = document.createElement('div');
    this.panel.id = 'login-panel';
    this.panel.className = 'ui-element';
    container.appendChild(this.panel);
    
    this.setupStyles();
    this.initStars();
    this.render();
    this.attachBackdrop();
  }
  
  /** The sign-in screen's scene while it's up (the game draws it instead of the world), else null */
  backdrop(): Container | null {
    return this.visible ? this.worldContainer : null;
  }

  private buildBackdrop(): void {
    if (this.worldContainer) return;
    // Create container hierarchy
    this.worldContainer = new Container();
    
    // Stars layer
    this.starsGraphics = new Graphics();
    this.worldContainer.addChild(this.starsGraphics);
    
    const batch = batchProgram(this.app.renderer);
    this.parts = [[this.starsGraphics, batch ? [batch] : []]];

    // Sol's sky as the game draws it (its nebula, haze and stars), once its programs are compiled; the dots above till then
    const sol = (systemsData as { systems: StarSystemData[] }).systems.find((s) => s.id === 'sol');
    const v = (sol?.visuals ?? {}) as BiomeHints;
    this.sky = new SkyRenderer(this.app);
    this.sky.setBiome(skyBiome('sol', {
      biome: v.biome, sector: sol?.sector, position: sol?.position, central: sol?.centralBody?.type,
      hasNebula: v.hasNebula, nebulaHue: v.nebulaHue, starHueShift: v.starHueShift, specialStarChance: v.specialStarChance, specialStarHue: v.specialStarHue,
    }));
    this.worldContainer.addChild(this.sky.container);
    this.parts.push([this.sky.container, skyPrograms()]);

    // One of Sol's bodies, a different one each visit (loginBody.ts): the sun as the game draws it, or a planet or moon
    // lit by the sun drawn small at a top corner (the sun and one small body orbit it, slowly)
    const id = loginBodyForVisit(sol);
    this.sunRenderer = new SunRenderer(this.app);
    this.sunRenderer.setStar('sol');
    // The star goes in first, under the planets: it is the farthest thing in the scene, so the central body (its disc, haze
    // and rings) and the small one cover it wherever it passes behind them. It is one container (the star's own pass drawn
    // to a target and stretched over the screen: disc, plasma, corona, glow, flares), so one place in the order does it.
    this.worldContainer.addChild(this.sunRenderer.container);
    if (id !== 'sun') {
      attachVolumeUploads(this.app.renderer);
      this.body = new LoginBody(id, sol);
      this.worldContainer.addChild(this.body.container);
    }
  }

  /** Show the backdrop: the game's canvas into the panel, under the form, and animated */
  private attachBackdrop(): void {
    this.buildBackdrop();
    const canvas = this.app.canvas as HTMLCanvasElement;
    if (canvas.parentNode && canvas.parentNode !== this.panel) {
      this.canvasHome = { parent: canvas.parentNode, next: canvas.nextSibling };
      this.panel.insertBefore(canvas, this.panel.firstChild);
    }
    this.app.ticker.remove(this.updateAnimation);
    this.app.ticker.add(this.updateAnimation);
  }

  /** The game's canvas back where it was; nothing more to animate */
  private detachBackdrop(): void {
    this.app.ticker.remove(this.updateAnimation);
    const canvas = this.app.canvas as HTMLCanvasElement, home = this.canvasHome;
    if (home && canvas.parentNode === this.panel) home.parent.insertBefore(canvas, home.next?.parentNode === home.parent ? home.next : null);
    this.canvasHome = null;
  }
  
  private updateAnimation = (): void => {
    if (!this.visible || !this.sunRenderer) return;
    for (const [part, programs] of this.parts) part.visible = programs.every(shaderReady);
    
    const time = (Date.now() - this.startTime) / 1000;
    const delta = this.app.ticker.deltaMS / 1000;
    const w = this.app.screen.width;
    const h = this.app.screen.height;
    // (the sky's haze texture is screen-sized: follow the window when it's resized under the sign-in screen)
    if (this.sky && (w !== this.skyW || h !== this.skyH)) { this.skyW = w; this.skyH = h; this.sky.resize(); }
    
    // The sun: its visible top quarter's arc spans exactly the view's width (touching both bottom corners): for a cap of
    // height f·2R, the chord is 4R·sqrt(f(1 − f))
    const visibleFraction = 0.25;
    const renderedRadius = w / (4 * Math.sqrt(visibleFraction * (1 - visibleFraction)));
    const cy = h + (1 - 2 * visibleFraction) * renderedRadius;
    // (a slow drift through the sky: its near stars slide past the far ones; not drawn, its haze not even into its
    // texture, till its programs are compiled ahead: a compile here would hold up the sign-in screen's first frames)
    if (this.sky?.container.visible) this.sky.update(delta * 1000, time * 40, time * 12, 0.35);
    if (this.body) {
      // (the star and the small body orbit the big one, slowly: the body says where the star is)
      const sun = this.body.update(delta, w / 2, cy, renderedRadius, w, h);
      this.sunRenderer.drawAt(delta, sun.x, sun.y, sun.r);
    } else this.sunRenderer.drawAt(delta, w / 2, cy, renderedRadius);

    // Draw stars
    this.drawStars(time);
  };
  
  private drawStars(time: number): void {
    if (!this.starsGraphics) return;
    
    const g = this.starsGraphics;
    const w = this.app.screen.width;
    const h = this.app.screen.height;
    
    g.clear();
    // The backdrop's own black (the game's renderer clears to its own)
    g.rect(0, 0, w, h);
    g.fill({ color: 0x000005 });
    // (only till Sol's own sky shows)
    if (this.sky?.container.visible) return;
    
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
        z-index: 5000; /* over anything a connection left on screen */
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



      
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      /* Import Google Font */
      @import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@700;900&family=Rajdhani:wght@400;500;600&display=swap');
    `;
    document.head.appendChild(style);
  }
  
  // Helper to convert hex color to RGB array
  private render(): void {
    const isLogin = this.mode === 'login';
    
    // Keep the backdrop's canvas (the game's, borrowed)
    const existingCanvas = this.canvasHome ? (this.app.canvas as HTMLCanvasElement) : null;
    
    this.panel.innerHTML = `
      <div class="login-content">
        <div class="login-title-container">
          <div class="login-title">SPACE GAME</div>
          <div class="login-subtitle">Working Title</div>
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
    // The backdrop: running again, or rebuilt if it was released
    this.attachBackdrop();
    this.onVisibility?.();
  }

  hide(): void {
    this.visible = false;
    this.panel.style.display = 'none';
    // The world is drawn again, on its canvas back in the game's container
    this.detachBackdrop();
    this.onVisibility?.();
  }

  /** Free the backdrop (the game is up); show() builds it again */
  releaseBackdrop(): void {
    if (this.visible) return;
    this.disposePixi();
  }

  isVisible(): boolean {
    return this.visible;
  }
  
  destroy(): void {
    this.detachBackdrop();
    this.disposePixi();
  }

  private disposePixi(): void {
    // Clean up PixiJS (the meshes; the renderer is the game's)
    if (this.sunRenderer) {
      this.sunRenderer.destroy();
      this.sunRenderer = null;
    }
    this.body = null;
    this.sky = null;
    this.worldContainer?.destroy({ children: true });
    this.worldContainer = null;
    this.starsGraphics = null;
    this.parts = [];
  }
}
