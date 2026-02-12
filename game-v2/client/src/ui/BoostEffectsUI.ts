/**
 * Boost Effects UI - Visual effects when player is boosting
 * 
 * Features:
 * - Speed lines radiating from center
 * - Screen edge blur/vignette
 * - FOV increase effect (simulated with zoom)
 * - Particle trails
 */

interface SpeedLine {
  angle: number;
  length: number;
  speed: number;
  distance: number; // Distance from center
  opacity: number;
  width: number;
}

export class BoostEffectsUI {
  private container: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private speedLines: SpeedLine[] = [];
  private animationFrame: number = 0;
  private visible = true;
  
  // Boost state
  private boostIntensity = 0; // 0-1, smoothed
  private targetBoostIntensity = 0;
  private playerAngle = 0; // Player's facing direction
  private playerSpeed = 0; // Current player speed
  
  // Visual settings
  private readonly MAX_SPEED_LINES = 60;
  private readonly LINE_SPAWN_RATE = 0.3;
  
  constructor(container: HTMLElement) {
    this.container = container;
    
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'boost-effects-canvas';
    this.canvas.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: 85;
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
   * Set boost state - call this every frame when player is boosting
   */
  setBoost(isBoosting: boolean, playerAngle: number, playerSpeed: number): void {
    this.targetBoostIntensity = isBoosting ? 1 : 0;
    this.playerAngle = playerAngle;
    this.playerSpeed = playerSpeed;
  }
  
  /**
   * Set just the intensity directly (0-1)
   */
  setIntensity(intensity: number): void {
    this.targetBoostIntensity = Math.max(0, Math.min(1, intensity));
  }
  
  private update(): void {
    const dt = 1 / 60;
    
    // Smooth boost intensity transitions
    const smoothingUp = 8;   // Fast ramp up
    const smoothingDown = 3; // Slower fade out
    const smoothing = this.targetBoostIntensity > this.boostIntensity ? smoothingUp : smoothingDown;
    this.boostIntensity += (this.targetBoostIntensity - this.boostIntensity) * smoothing * dt;
    
    // Clamp very small values to zero
    if (this.boostIntensity < 0.01) {
      this.boostIntensity = 0;
      this.speedLines = [];
      return;
    }
    
    // Spawn new speed lines when boosting
    if (this.boostIntensity > 0.1 && Math.random() < this.LINE_SPAWN_RATE * this.boostIntensity) {
      this.spawnSpeedLine();
    }
    
    // Update existing speed lines
    for (let i = this.speedLines.length - 1; i >= 0; i--) {
      const line = this.speedLines[i];
      
      // Move line outward from center
      line.distance += line.speed * dt * (1 + this.boostIntensity);
      
      // Fade in then out based on distance
      const maxDist = Math.max(this.canvas.width, this.canvas.height) * 0.8;
      if (line.distance < 100) {
        line.opacity = line.distance / 100;
      } else if (line.distance > maxDist * 0.6) {
        line.opacity = 1 - ((line.distance - maxDist * 0.6) / (maxDist * 0.4));
      }
      
      // Extend line length as it moves outward
      line.length = 50 + (line.distance / maxDist) * 150 * this.boostIntensity;
      
      // Remove lines that have moved off screen
      if (line.distance > maxDist || line.opacity <= 0) {
        this.speedLines.splice(i, 1);
      }
    }
  }
  
  private spawnSpeedLine(): void {
    if (this.speedLines.length >= this.MAX_SPEED_LINES) return;
    
    // Spawn lines in the direction of movement
    // Cluster them around the movement direction
    const spread = Math.PI * 0.6; // How wide the cone is
    const angle = this.playerAngle + Math.PI + (Math.random() - 0.5) * spread;
    
    this.speedLines.push({
      angle: angle,
      length: 30 + Math.random() * 50,
      speed: 400 + Math.random() * 300 + this.playerSpeed * 0.5,
      distance: 20 + Math.random() * 50, // Start near center
      opacity: 0,
      width: 1 + Math.random() * 2,
    });
  }
  
  private draw(): void {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    
    ctx.clearRect(0, 0, w, h);
    
    if (this.boostIntensity < 0.01) return;
    
    const cx = w / 2;
    const cy = h / 2;
    
    // Draw vignette effect (tunnel vision when boosting)
    this.drawVignette(ctx, w, h);
    
    // Draw speed lines
    this.drawSpeedLines(ctx, cx, cy);
    
    // Draw center glow
    this.drawCenterGlow(ctx, cx, cy);
  }
  
  private drawVignette(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const intensity = this.boostIntensity * 0.5;
    
    const cx = w / 2;
    const cy = h / 2;
    const radius = Math.sqrt(cx * cx + cy * cy);
    
    // Radial gradient for vignette
    const grad = ctx.createRadialGradient(cx, cy, radius * 0.2, cx, cy, radius);
    grad.addColorStop(0, 'rgba(0, 0, 0, 0)');
    grad.addColorStop(0.5, 'rgba(0, 0, 0, 0)');
    grad.addColorStop(0.7, `rgba(0, 10, 30, ${intensity * 0.2})`);
    grad.addColorStop(0.85, `rgba(0, 20, 60, ${intensity * 0.4})`);
    grad.addColorStop(1, `rgba(0, 30, 80, ${intensity * 0.6})`);
    
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
    
    // Add chromatic aberration edge effect
    if (this.boostIntensity > 0.5) {
      const aberrationIntensity = (this.boostIntensity - 0.5) * 0.3;
      
      // Blue edge on one side
      const blueGrad = ctx.createLinearGradient(0, 0, w * 0.15, 0);
      blueGrad.addColorStop(0, `rgba(0, 100, 255, ${aberrationIntensity})`);
      blueGrad.addColorStop(1, 'rgba(0, 100, 255, 0)');
      ctx.fillStyle = blueGrad;
      ctx.fillRect(0, 0, w * 0.15, h);
      
      // Red edge on other side
      const redGrad = ctx.createLinearGradient(w, 0, w * 0.85, 0);
      redGrad.addColorStop(0, `rgba(255, 50, 0, ${aberrationIntensity})`);
      redGrad.addColorStop(1, 'rgba(255, 50, 0, 0)');
      ctx.fillStyle = redGrad;
      ctx.fillRect(w * 0.85, 0, w * 0.15, h);
    }
  }
  
  private drawSpeedLines(ctx: CanvasRenderingContext2D, cx: number, cy: number): void {
    for (const line of this.speedLines) {
      const alpha = line.opacity * this.boostIntensity;
      if (alpha < 0.01) continue;
      
      // Calculate line start and end points
      const cos = Math.cos(line.angle);
      const sin = Math.sin(line.angle);
      
      const startDist = line.distance;
      const endDist = line.distance + line.length;
      
      const x1 = cx + cos * startDist;
      const y1 = cy + sin * startDist;
      const x2 = cx + cos * endDist;
      const y2 = cy + sin * endDist;
      
      // Create gradient along line (fades at both ends)
      const grad = ctx.createLinearGradient(x1, y1, x2, y2);
      grad.addColorStop(0, `rgba(150, 200, 255, 0)`);
      grad.addColorStop(0.2, `rgba(150, 200, 255, ${alpha})`);
      grad.addColorStop(0.8, `rgba(200, 230, 255, ${alpha * 0.8})`);
      grad.addColorStop(1, `rgba(255, 255, 255, 0)`);
      
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.strokeStyle = grad;
      ctx.lineWidth = line.width;
      ctx.lineCap = 'round';
      ctx.stroke();
    }
  }
  
  private drawCenterGlow(ctx: CanvasRenderingContext2D, cx: number, cy: number): void {
    // Small glow at center that pulses
    const pulseTime = Date.now() / 200;
    const pulse = 0.8 + 0.2 * Math.sin(pulseTime);
    const glowSize = 100 + 50 * this.boostIntensity * pulse;
    
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, glowSize);
    grad.addColorStop(0, `rgba(200, 230, 255, ${0.1 * this.boostIntensity * pulse})`);
    grad.addColorStop(0.5, `rgba(100, 180, 255, ${0.05 * this.boostIntensity})`);
    grad.addColorStop(1, 'rgba(50, 100, 200, 0)');
    
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, glowSize, 0, Math.PI * 2);
    ctx.fill();
  }
  
  show(): void {
    this.visible = true;
    this.canvas.style.display = 'block';
  }
  
  hide(): void {
    this.visible = false;
    this.canvas.style.display = 'none';
  }
  
  /**
   * Get current boost intensity (for other systems to use)
   */
  getIntensity(): number {
    return this.boostIntensity;
  }
  
  destroy(): void {
    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame);
    }
    window.removeEventListener('resize', this.handleResize);
    this.canvas.remove();
  }
}
