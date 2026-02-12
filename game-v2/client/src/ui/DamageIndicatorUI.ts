/**
 * Damage Indicator UI - Shows damage direction around screen edge
 * 
 * When the player takes damage, shows a red arc/segment on the screen
 * edge pointing toward the source of the damage.
 */

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
  private animationFrame: number = 0;
  private visible = true;
  
  // Player position (updated externally)
  private playerX = 0;
  private playerY = 0;
  
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
    
    this.startAnimation();
  }
  
  private handleResize = (): void => {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
  };
  
  private startAnimation(): void {
    const animate = () => {
      if (this.visible) {
        this.update();
        this.draw();
      }
      this.animationFrame = requestAnimationFrame(animate);
    };
    this.animationFrame = requestAnimationFrame(animate);
  }
  
  /**
   * Add a damage indicator from a specific world position
   */
  addDamage(sourceX: number, sourceY: number, intensity: number = 1): void {
    // Calculate angle from player to damage source
    const dx = sourceX - this.playerX;
    const dy = sourceY - this.playerY;
    const angle = Math.atan2(dy, dx);
    
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
  setPlayerPosition(x: number, y: number): void {
    this.playerX = x;
    this.playerY = y;
  }
  
  private update(): void {
    const dt = 1 / 60; // Assume 60fps
    
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
    
    if (this.indicators.length === 0) return;
    
    const cx = w / 2;
    const cy = h / 2;
    
    // Distance from center to draw indicators (screen edge)
    const edgeDistX = w / 2 - 40;
    const edgeDistY = h / 2 - 40;
    
    for (const ind of this.indicators) {
      // Ease out the intensity as it fades
      const fadeAlpha = this.easeOutQuad(ind.life);
      const alpha = fadeAlpha * ind.intensity;
      
      // Calculate position on screen edge
      const cosA = Math.cos(ind.angle);
      const sinA = Math.sin(ind.angle);
      
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
      this.drawIndicator(ctx, x, y, ind.angle, alpha, ind.intensity);
    }
    
    // Draw vignette effect if any indicators are active
    const maxIntensity = Math.max(...this.indicators.map(i => i.intensity * this.easeOutQuad(i.life)));
    if (maxIntensity > 0) {
      this.drawVignette(ctx, w, h, maxIntensity * 0.4);
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
    
    // Draw arrow/wedge shape pointing inward
    ctx.beginPath();
    ctx.moveTo(-size * 0.5, -size * 0.4);
    ctx.lineTo(size * 0.3, 0);
    ctx.lineTo(-size * 0.5, size * 0.4);
    ctx.closePath();
    
    ctx.fillStyle = grad;
    ctx.fill();
    
    // Add glow effect
    ctx.shadowColor = `rgba(255, 50, 0, ${alpha})`;
    ctx.shadowBlur = 20;
    ctx.fill();
    ctx.shadowBlur = 0;
    
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
  
  private drawVignette(
    ctx: CanvasRenderingContext2D,
    w: number, h: number,
    intensity: number
  ): void {
    // Create radial gradient from center
    const cx = w / 2;
    const cy = h / 2;
    const radius = Math.sqrt(cx * cx + cy * cy);
    
    const grad = ctx.createRadialGradient(cx, cy, radius * 0.3, cx, cy, radius);
    grad.addColorStop(0, 'rgba(0, 0, 0, 0)');
    grad.addColorStop(0.5, 'rgba(100, 0, 0, 0)');
    grad.addColorStop(0.8, `rgba(150, 0, 0, ${intensity * 0.2})`);
    grad.addColorStop(1, `rgba(200, 0, 0, ${intensity * 0.4})`);
    
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
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
  }
  
  clear(): void {
    this.indicators = [];
  }
  
  destroy(): void {
    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame);
    }
    window.removeEventListener('resize', this.handleResize);
    this.canvas.remove();
  }
}
