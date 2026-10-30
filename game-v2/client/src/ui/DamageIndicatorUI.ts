/**
 * Damage Indicator UI - Shows damage direction around screen edge
 * 
 * When the player takes damage, shows a red arc/segment on the screen
 * edge pointing toward the source of the damage.
 */

import { onOverlayFrame, screenTint } from '../rendering/overlayFrame';

interface DamageIndicator {
  id: number;
  angle: number; // Direction damage came from (radians)
  intensity: number; // 0-1
  life: number;
  maxLife: number;
}

export class DamageIndicatorUI {
  private container: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private indicators: DamageIndicator[] = [];
  private nextId = 0;
  private stop: () => void;
  private visible = true;
  /** The canvas has something on it (so it's cleared only when there's something to clear) */
  private drawn = false;
  
  // Player position (updated externally)
  private playerX = 0;
  private playerY = 0;
  /** The view's roll: indicators keep the hit's world direction, drawn turned with the view */
  private viewAngle = 0;
  
  constructor(container: HTMLElement) {
    this.container = container;
    
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'damage-indicator-canvas';
    this.canvas.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: 90;
    `;
    container.appendChild(this.canvas);
    
    this.ctx = this.canvas.getContext('2d')!;
    
    this.handleResize();
    window.addEventListener('resize', this.handleResize);
    
    // Stepped from the renderer's frame (see overlayFrame)
    this.stop = onOverlayFrame((dt) => {
      if (!this.visible || (!this.indicators.length && !this.drawn)) return;
      this.update(Math.min(0.1, dt));
      this.draw();
    });
  }
  
  private handleResize = (): void => {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
  };
  
  /**
   * Add a damage indicator from a specific world position
   */
  addDamage(sourceX: number, sourceY: number, intensity: number = 1): void {
    // Calculate angle from player to damage source (none known: just the vignette)
    const dx = sourceX - this.playerX;
    const dy = sourceY - this.playerY;
    const angle = dx === 0 && dy === 0 ? NaN : Math.atan2(dy, dx);
    
    this.addDamageFromAngle(angle, intensity);
  }
  
  /**
   * Add a damage indicator from a specific angle (radians)
   */
  addDamageFromAngle(angle: number, intensity: number = 1): void {
    // Clamp intensity
    intensity = Math.max(0.3, Math.min(1, intensity));
    
    this.indicators.push({
      id: this.nextId++,
      angle,
      intensity,
      life: 1,
      maxLife: 0.8 + intensity * 0.4, // Longer for more intense hits
    });
    
    // Limit total indicators
    while (this.indicators.length > 8) {
      this.indicators.shift();
    }
  }
  
  /**
   * Update player position for damage direction calculation
   */
  setPlayerPosition(x: number, y: number, viewAngle = 0): void {
    this.playerX = x;
    this.playerY = y;
    this.viewAngle = viewAngle;
  }
  
  private update(dt: number): void {
    
    // Update all indicators
    for (let i = this.indicators.length - 1; i >= 0; i--) {
      const ind = this.indicators[i];
      ind.life -= dt / ind.maxLife;
      
      if (ind.life <= 0) {
        this.indicators.splice(i, 1);
      }
    }
  }
  
  private draw(): void {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    
    ctx.clearRect(0, 0, w, h);
    this.drawn = this.indicators.length > 0;
    // The red edge is the renderer's vignette (one gradient, not two stacked)
    screenTint.damage = this.drawn ? Math.max(...this.indicators.map(i => i.intensity * this.easeOutQuad(i.life))) * 0.4 : 0;
    if (this.indicators.length === 0) return;
    
    const cx = w / 2;
    const cy = h / 2;
    
    // Distance from center to draw indicators (screen edge)
    const edgeDistX = w / 2 - 40;
    const edgeDistY = h / 2 - 40;
    
    for (const ind of this.indicators) {
      if (Number.isNaN(ind.angle)) continue;
      // Ease out the intensity as it fades
      const fadeAlpha = this.easeOutQuad(ind.life);
      const alpha = fadeAlpha * ind.intensity;
      
      // Calculate position on screen edge
      const screenAngle = ind.angle - this.viewAngle;
      const cosA = Math.cos(screenAngle);
      const sinA = Math.sin(screenAngle);
      
      // Find intersection with screen edge
      let x: number, y: number;
      const aspectRatio = edgeDistX / edgeDistY;
      
      if (Math.abs(cosA) * edgeDistY > Math.abs(sinA) * edgeDistX) {
        // Hit left or right edge
        x = cx + Math.sign(cosA) * edgeDistX;
        y = cy + sinA * edgeDistX / Math.abs(cosA);
      } else {
        // Hit top or bottom edge
        x = cx + cosA * edgeDistY / Math.abs(sinA);
        y = cy + Math.sign(sinA) * edgeDistY;
      }
      
      // Clamp to screen
      x = Math.max(40, Math.min(w - 40, x));
      y = Math.max(40, Math.min(h - 40, y));
      
      // Draw damage indicator arc
      this.drawIndicator(ctx, x, y, screenAngle, alpha, ind.intensity);
    }
  }
  
  private drawIndicator(
    ctx: CanvasRenderingContext2D,
    x: number, y: number,
    angle: number,
    alpha: number,
    intensity: number
  ): void {
    const size = 30 + intensity * 20;
    
    // Save context
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    
    // Create gradient for the indicator
    const grad = ctx.createLinearGradient(-size, 0, size * 0.5, 0);
    grad.addColorStop(0, `rgba(255, 0, 0, 0)`);
    grad.addColorStop(0.3, `rgba(255, 50, 50, ${alpha * 0.8})`);
    grad.addColorStop(0.6, `rgba(255, 100, 50, ${alpha})`);
    grad.addColorStop(1, `rgba(255, 50, 50, ${alpha * 0.3})`);
    
    // Arrow/wedge shape pointing inward; first larger and faint, for a soft glow (cheaper than shadowBlur, the slowest thing a canvas does)
    const wedge = (k: number) => {
      ctx.beginPath();
      ctx.moveTo(-size * 0.5 * k, -size * 0.4 * k);
      ctx.lineTo(size * 0.3 * k, 0);
      ctx.lineTo(-size * 0.5 * k, size * 0.4 * k);
      ctx.closePath();
    };
    wedge(1.7);
    ctx.fillStyle = `rgba(255, 50, 0, ${alpha * 0.12})`;
    ctx.fill();
    wedge(1.3);
    ctx.fillStyle = `rgba(255, 50, 0, ${alpha * 0.2})`;
    ctx.fill();
    wedge(1);
    ctx.fillStyle = grad;
    ctx.fill();
    
    // Inner bright core
    ctx.beginPath();
    ctx.moveTo(-size * 0.3, -size * 0.2);
    ctx.lineTo(size * 0.15, 0);
    ctx.lineTo(-size * 0.3, size * 0.2);
    ctx.closePath();
    ctx.fillStyle = `rgba(255, 200, 150, ${alpha * 0.5})`;
    ctx.fill();
    
    ctx.restore();
  }
  
  private easeOutQuad(t: number): number {
    return t * (2 - t);
  }
  
  show(): void {
    this.visible = true;
    this.canvas.style.display = 'block';
  }
  
  hide(): void {
    this.visible = false;
    this.canvas.style.display = 'none';
    screenTint.damage = 0;
  }
  
  clear(): void {
    this.indicators = [];
    screenTint.damage = 0;
  }
  
  destroy(): void {
    this.stop();
    screenTint.damage = 0;
    window.removeEventListener('resize', this.handleResize);
    this.canvas.remove();
  }
}
