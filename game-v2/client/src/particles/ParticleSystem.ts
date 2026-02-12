/**
 * Particle System - Efficient client-side particle rendering with object pooling
 */

import { ParticleDefinition, ColorConfig, particleRegistry } from '@space-game/common';

// === Particle Types ===

interface Particle {
  // State
  active: boolean;
  definitionId: string;
  
  // Position
  x: number;
  y: number;
  
  // Velocity
  vx: number;
  vy: number;
  
  // Properties
  lifetime: number;
  maxLifetime: number;
  size: number;
  rotation: number;
  rotationSpeed: number;
  alpha: number;
  
  // Color (computed)
  color: string;
}

interface Emitter {
  id: number;
  definitionId: string;
  x: number;
  y: number;
  angle: number;
  vx: number;
  vy: number;
  active: boolean;
  
  // Timing
  emitTimer: number;
  duration: number;
  maxDuration: number;
  burstCount: number;
  
  // Tracking
  particleCount: number;
}

// === Object Pool ===

class ObjectPool<T> {
  private pool: T[] = [];
  private factory: () => T;
  private reset: (obj: T) => void;

  constructor(factory: () => T, reset: (obj: T) => void, initialSize: number = 100) {
    this.factory = factory;
    this.reset = reset;
    
    // Pre-allocate
    for (let i = 0; i < initialSize; i++) {
      this.pool.push(factory());
    }
  }

  acquire(): T {
    if (this.pool.length > 0) {
      return this.pool.pop()!;
    }
    return this.factory();
  }

  release(obj: T): void {
    this.reset(obj);
    this.pool.push(obj);
  }

  get available(): number {
    return this.pool.length;
  }
}

// === Main Particle System ===

export class ParticleSystem {
  private particles: Particle[] = [];
  private emitters: Emitter[] = [];
  private pool: ObjectPool<Particle>;
  
  private maxParticles = 2000;
  private nextEmitterId = 1;
  
  private ctx: CanvasRenderingContext2D | null = null;

  constructor() {
    // Create particle pool
    this.pool = new ObjectPool(
      () => this.createParticle(),
      (p) => this.resetParticle(p),
      500
    );
  }

  private createParticle(): Particle {
    return {
      active: false,
      definitionId: '',
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      lifetime: 0,
      maxLifetime: 1000,
      size: 5,
      rotation: 0,
      rotationSpeed: 0,
      alpha: 1,
      color: '#ffffff',
    };
  }

  private resetParticle(p: Particle): void {
    p.active = false;
    p.definitionId = '';
    p.x = 0;
    p.y = 0;
    p.vx = 0;
    p.vy = 0;
    p.lifetime = 0;
    p.alpha = 1;
  }

  setContext(ctx: CanvasRenderingContext2D): void {
    this.ctx = ctx;
  }

  // === Emitter Management ===

  /**
   * Create an emitter at a position
   */
  createEmitter(definitionId: string, x: number, y: number, angle: number = 0): number {
    const def = particleRegistry.get(definitionId);
    if (!def) {
      console.warn(`[ParticleSystem] Unknown particle definition: ${definitionId}`);
      return -1;
    }

    const emitter: Emitter = {
      id: this.nextEmitterId++,
      definitionId,
      x,
      y,
      angle,
      vx: 0,
      vy: 0,
      active: true,
      emitTimer: 0,
      duration: 0,
      maxDuration: def.emission.duration ?? 0,
      burstCount: 0,
      particleCount: 0,
    };

    this.emitters.push(emitter);

    // For burst emitters, emit immediately
    if (def.emission.type === 'burst') {
      this.emitBurst(emitter, def);
    }

    return emitter.id;
  }

  /**
   * Update emitter position
   */
  updateEmitter(id: number, x: number, y: number, angle?: number, vx?: number, vy?: number): void {
    const emitter = this.emitters.find((e) => e.id === id);
    if (emitter) {
      emitter.x = x;
      emitter.y = y;
      if (angle !== undefined) emitter.angle = angle;
      if (vx !== undefined) emitter.vx = vx;
      if (vy !== undefined) emitter.vy = vy;
    }
  }

  /**
   * Stop and remove an emitter
   */
  removeEmitter(id: number): void {
    const index = this.emitters.findIndex((e) => e.id === id);
    if (index >= 0) {
      this.emitters.splice(index, 1);
    }
  }

  /**
   * Trigger a one-shot burst effect
   */
  burst(definitionId: string, x: number, y: number): void {
    const id = this.createEmitter(definitionId, x, y);
    // Burst emitters auto-remove after emission
    setTimeout(() => this.removeEmitter(id), 100);
  }

  // === Internal Emission ===

  private emitBurst(emitter: Emitter, def: ParticleDefinition): void {
    const count = def.emission.rate;
    for (let i = 0; i < count; i++) {
      this.emitParticle(emitter, def);
    }
    emitter.burstCount++;
  }

  private emitParticle(emitter: Emitter, def: ParticleDefinition): void {
    if (this.particles.length >= this.maxParticles) return;
    if (emitter.particleCount >= def.emission.maxParticles) return;

    const particle = this.pool.acquire();
    particle.active = true;
    particle.definitionId = def.id;

    // Position
    particle.x = emitter.x;
    particle.y = emitter.y;

    // Lifetime
    const lifetimeRange = def.particle.lifetime.max - def.particle.lifetime.min;
    particle.maxLifetime = def.particle.lifetime.min + Math.random() * lifetimeRange;
    particle.lifetime = particle.maxLifetime;

    // Size
    particle.size = def.particle.size.start;

    // Rotation
    const rotRange = def.particle.rotation.max - def.particle.rotation.min;
    particle.rotation = def.particle.rotation.min + Math.random() * rotRange;
    const rotSpeedRange = def.particle.rotationSpeed.max - def.particle.rotationSpeed.min;
    particle.rotationSpeed = def.particle.rotationSpeed.min + Math.random() * rotSpeedRange;

    // Velocity
    const physics = def.physics;
    const speedRange = physics.speed.max - physics.speed.min;
    const speed = (physics.speed.min + Math.random() * speedRange) / 1000; // Convert to per-ms
    
    const dirRange = physics.direction.max - physics.direction.min;
    const baseDir = physics.direction.min + Math.random() * dirRange;
    const spread = (Math.random() - 0.5) * physics.spread;
    const dir = emitter.angle + baseDir + spread;

    particle.vx = Math.cos(dir) * speed + emitter.vx * physics.inheritVelocity;
    particle.vy = Math.sin(dir) * speed + emitter.vy * physics.inheritVelocity;

    // Color
    particle.color = this.computeColor(def.visual.color, 1);
    particle.alpha = def.visual.alpha.start;

    this.particles.push(particle);
    emitter.particleCount++;
  }

  private computeColor(config: ColorConfig, t: number): string {
    switch (config.type) {
      case 'solid':
        return config.start;
      
      case 'gradient':
        return this.lerpColor(config.start, config.end || config.start, t);
      
      case 'hueShift':
        const baseHue = config.hue ?? 0;
        const range = config.hueRange ?? 30;
        const hue = baseHue + (Math.random() - 0.5) * range;
        return `hsl(${hue}, ${(config.saturation ?? 100)}%, ${(config.lightness ?? 50)}%)`;
      
      case 'random':
        const rndHue = Math.random() * 360;
        return `hsl(${rndHue}, 100%, 50%)`;
      
      default:
        return config.start;
    }
  }

  private lerpColor(colorA: string, colorB: string, t: number): string {
    // Simple hex lerp
    const a = this.hexToRgb(colorA);
    const b = this.hexToRgb(colorB);
    if (!a || !b) return colorA;

    const r = Math.round(a.r + (b.r - a.r) * t);
    const g = Math.round(a.g + (b.g - a.g) * t);
    const bl = Math.round(a.b + (b.b - a.b) * t);
    
    return `rgb(${r},${g},${bl})`;
  }

  private hexToRgb(hex: string): { r: number; g: number; b: number } | null {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result
      ? {
          r: parseInt(result[1], 16),
          g: parseInt(result[2], 16),
          b: parseInt(result[3], 16),
        }
      : null;
  }

  // === Update Loop ===

  update(deltaMs: number): void {
    // Update emitters
    for (let i = this.emitters.length - 1; i >= 0; i--) {
      const emitter = this.emitters[i];
      if (!emitter.active) continue;

      const def = particleRegistry.get(emitter.definitionId);
      if (!def) continue;

      // Handle continuous emission
      if (def.emission.type === 'continuous') {
        emitter.emitTimer += deltaMs;
        const interval = 1000 / def.emission.rate;
        
        while (emitter.emitTimer >= interval) {
          this.emitParticle(emitter, def);
          emitter.emitTimer -= interval;
        }
      }

      // Handle burst with interval
      if (def.emission.type === 'burst' && def.emission.burstInterval) {
        emitter.emitTimer += deltaMs;
        if (emitter.emitTimer >= def.emission.burstInterval) {
          this.emitBurst(emitter, def);
          emitter.emitTimer = 0;
        }
      }

      // Check duration
      if (def.emission.duration && def.emission.duration > 0) {
        emitter.duration += deltaMs;
        if (emitter.duration >= def.emission.duration) {
          emitter.active = false;
        }
      }
    }

    // Update particles
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      if (!p.active) continue;

      const def = particleRegistry.get(p.definitionId);
      if (!def) continue;

      // Update lifetime
      p.lifetime -= deltaMs;
      if (p.lifetime <= 0) {
        // Return to pool
        p.active = false;
        const emitter = this.emitters.find((e) => e.definitionId === p.definitionId);
        if (emitter) emitter.particleCount--;
        
        this.pool.release(p);
        this.particles.splice(i, 1);
        continue;
      }

      // Interpolation factor
      const t = 1 - p.lifetime / p.maxLifetime;

      // Update position
      p.x += p.vx * deltaMs;
      p.y += p.vy * deltaMs;

      // Apply gravity
      if (def.physics.gravity) {
        p.vx += def.physics.gravity.x * deltaMs * 0.001;
        p.vy += def.physics.gravity.y * deltaMs * 0.001;
      }

      // Apply friction
      const friction = Math.pow(def.physics.friction, deltaMs / 16.67);
      p.vx *= friction;
      p.vy *= friction;

      // Update rotation
      p.rotation += p.rotationSpeed * deltaMs * 0.001;

      // Update size
      p.size = def.particle.size.start + (def.particle.size.end - def.particle.size.start) * t;

      // Update alpha
      p.alpha = def.visual.alpha.start + (def.visual.alpha.end - def.visual.alpha.start) * t;

      // Update color if gradient
      if (def.visual.color.type === 'gradient') {
        p.color = this.lerpColor(def.visual.color.start, def.visual.color.end || def.visual.color.start, t);
      }
    }
  }

  // === Rendering ===

  render(ctx: CanvasRenderingContext2D, cameraX: number, cameraY: number): void {
    for (const p of this.particles) {
      if (!p.active) continue;

      const def = particleRegistry.get(p.definitionId);
      if (!def) continue;

      const screenX = p.x - cameraX;
      const screenY = p.y - cameraY;

      ctx.save();
      ctx.translate(screenX, screenY);
      ctx.rotate(p.rotation);
      ctx.globalAlpha = p.alpha;

      // Set blend mode
      if (def.visual.blendMode === 'add') {
        ctx.globalCompositeOperation = 'lighter';
      }

      // Draw based on shape
      ctx.fillStyle = p.color;
      
      switch (def.visual.shape) {
        case 'circle':
          ctx.beginPath();
          ctx.arc(0, 0, p.size, 0, Math.PI * 2);
          ctx.fill();
          break;

        case 'square':
          ctx.fillRect(-p.size, -p.size, p.size * 2, p.size * 2);
          break;

        case 'triangle':
          ctx.beginPath();
          ctx.moveTo(0, -p.size);
          ctx.lineTo(p.size, p.size);
          ctx.lineTo(-p.size, p.size);
          ctx.closePath();
          ctx.fill();
          break;

        case 'star':
          this.drawStar(ctx, 0, 0, 5, p.size, p.size * 0.5);
          break;

        case 'spark':
          ctx.beginPath();
          ctx.moveTo(-p.size, 0);
          ctx.lineTo(p.size, 0);
          ctx.moveTo(0, -p.size);
          ctx.lineTo(0, p.size);
          ctx.strokeStyle = p.color;
          ctx.lineWidth = 2;
          ctx.stroke();
          break;

        case 'smoke':
          ctx.beginPath();
          ctx.arc(0, 0, p.size, 0, Math.PI * 2);
          ctx.fill();
          break;

        case 'ring':
          ctx.beginPath();
          ctx.arc(0, 0, p.size, 0, Math.PI * 2);
          ctx.strokeStyle = p.color;
          ctx.lineWidth = 2;
          ctx.stroke();
          break;
      }

      // Glow effect
      if (def.visual.glow && def.visual.glow > 0) {
        ctx.shadowColor = p.color;
        ctx.shadowBlur = p.size * def.visual.glow;
      }

      ctx.restore();
    }
  }

  private drawStar(ctx: CanvasRenderingContext2D, cx: number, cy: number, spikes: number, outerRadius: number, innerRadius: number): void {
    let rot = (Math.PI / 2) * 3;
    const step = Math.PI / spikes;

    ctx.beginPath();
    ctx.moveTo(cx, cy - outerRadius);

    for (let i = 0; i < spikes; i++) {
      ctx.lineTo(cx + Math.cos(rot) * outerRadius, cy + Math.sin(rot) * outerRadius);
      rot += step;
      ctx.lineTo(cx + Math.cos(rot) * innerRadius, cy + Math.sin(rot) * innerRadius);
      rot += step;
    }

    ctx.lineTo(cx, cy - outerRadius);
    ctx.closePath();
    ctx.fill();
  }

  // === Stats ===

  getStats(): { particles: number; emitters: number; poolAvailable: number } {
    return {
      particles: this.particles.length,
      emitters: this.emitters.length,
      poolAvailable: this.pool.available,
    };
  }

  clear(): void {
    for (const p of this.particles) {
      this.pool.release(p);
    }
    this.particles = [];
    this.emitters = [];
  }
}

// Export singleton for easy access
export const particleSystem = new ParticleSystem();
