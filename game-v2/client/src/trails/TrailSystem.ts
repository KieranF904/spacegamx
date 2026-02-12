/**
 * Trail System - Efficient client-side trail rendering
 * Manages per-entity trails with configurable appearance
 */

import { TrailDefinition, TrailColorConfig, trailRegistry } from '@space-game/common';

// === Trail Types ===

interface TrailPoint {
  x: number;
  y: number;
  age: number;       // Ms since created
  speed: number;     // Speed at time of creation (for velocity-based color)
}

interface Trail {
  entityId: number;
  definitionId: string;
  points: TrailPoint[];
  lastX: number;
  lastY: number;
  active: boolean;
  fadeTimer: number; // For fading after emission stops
}

// === Main Trail System ===

export class TrailSystem {
  private trails = new Map<number, Trail>();

  /**
   * Create or get trail for an entity
   */
  createTrail(entityId: number, definitionId: string): void {
    if (this.trails.has(entityId)) {
      // Update definition if changed
      const trail = this.trails.get(entityId)!;
      if (trail.definitionId !== definitionId) {
        trail.definitionId = definitionId;
        trail.points = [];
      }
      trail.active = true;
      trail.fadeTimer = 0;
      return;
    }

    this.trails.set(entityId, {
      entityId,
      definitionId,
      points: [],
      lastX: 0,
      lastY: 0,
      active: true,
      fadeTimer: 0,
    });
  }

  /**
   * Update trail position (call every frame while entity exists)
   */
  updateTrail(entityId: number, x: number, y: number, speed: number = 0): void {
    const trail = this.trails.get(entityId);
    if (!trail) return;

    const def = trailRegistry.get(trail.definitionId);
    if (!def) return;

    // Check if we should add a new point
    const dx = x - trail.lastX;
    const dy = y - trail.lastY;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist >= def.shape.minSegmentDistance || trail.points.length === 0) {
      // Add new point at front
      trail.points.unshift({
        x,
        y,
        age: 0,
        speed,
      });

      trail.lastX = x;
      trail.lastY = y;

      // Trim to max length
      while (trail.points.length > def.shape.maxLength) {
        trail.points.pop();
      }
    }
  }

  /**
   * Stop adding to trail (will fade out)
   */
  stopTrail(entityId: number): void {
    const trail = this.trails.get(entityId);
    if (trail) {
      trail.active = false;
    }
  }

  /**
   * Remove trail completely
   */
  removeTrail(entityId: number): void {
    this.trails.delete(entityId);
  }

  /**
   * Update all trails (age points, handle fading)
   */
  update(deltaMs: number): void {
    for (const [entityId, trail] of this.trails) {
      const def = trailRegistry.get(trail.definitionId);
      if (!def) continue;

      // Age all points
      for (const point of trail.points) {
        point.age += deltaMs;
      }

      // Handle fading
      if (!trail.active) {
        trail.fadeTimer += deltaMs;
        if (trail.fadeTimer >= def.behavior.fadeTime) {
          this.trails.delete(entityId);
          continue;
        }
      }

      // Remove old points based on shape and fading
      if (!trail.active && def.behavior.shrinkOnFade) {
        // Remove points faster when fading
        const removeRate = trail.points.length / (def.behavior.fadeTime / deltaMs);
        const toRemove = Math.ceil(removeRate);
        for (let i = 0; i < toRemove && trail.points.length > 0; i++) {
          trail.points.pop();
        }
      }
    }
  }

  /**
   * Render all trails
   */
  render(ctx: CanvasRenderingContext2D, cameraX: number, cameraY: number): void {
    for (const trail of this.trails.values()) {
      if (trail.points.length < 2) continue;

      const def = trailRegistry.get(trail.definitionId);
      if (!def) continue;

      this.renderTrail(ctx, trail, def, cameraX, cameraY);
    }
  }

  private renderTrail(
    ctx: CanvasRenderingContext2D,
    trail: Trail,
    def: TrailDefinition,
    cameraX: number,
    cameraY: number
  ): void {
    const points = trail.points;
    if (points.length < 2) return;

    ctx.save();

    // Set blend mode
    if (def.visual.blendMode === 'add') {
      ctx.globalCompositeOperation = 'lighter';
    }

    // Calculate fade multiplier
    let fadeMult = 1;
    if (!trail.active && def.behavior.fadeTime > 0) {
      fadeMult = 1 - trail.fadeTimer / def.behavior.fadeTime;
    }

    switch (def.shape.type) {
      case 'line':
        this.renderLine(ctx, points, def, cameraX, cameraY, fadeMult);
        break;

      case 'ribbon':
        this.renderRibbon(ctx, points, def, cameraX, cameraY, fadeMult);
        break;

      case 'dotted':
        this.renderDotted(ctx, points, def, cameraX, cameraY, fadeMult);
        break;

      case 'tapered':
        this.renderTapered(ctx, points, def, cameraX, cameraY, fadeMult);
        break;
    }

    ctx.restore();
  }

  private renderLine(
    ctx: CanvasRenderingContext2D,
    points: TrailPoint[],
    def: TrailDefinition,
    cameraX: number,
    cameraY: number,
    fadeMult: number
  ): void {
    ctx.beginPath();
    ctx.moveTo(points[0].x - cameraX, points[0].y - cameraY);
    
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x - cameraX, points[i].y - cameraY);
    }

    ctx.strokeStyle = this.getColor(def.visual.color, 0, points[0].speed);
    ctx.lineWidth = def.shape.width.start;
    ctx.globalAlpha = def.visual.alpha.start * fadeMult;
    ctx.lineCap = 'round';
    ctx.stroke();
  }

  private renderRibbon(
    ctx: CanvasRenderingContext2D,
    points: TrailPoint[],
    def: TrailDefinition,
    cameraX: number,
    cameraY: number,
    fadeMult: number
  ): void {
    // Draw as gradient strokes of decreasing width
    for (let i = 0; i < points.length - 1; i++) {
      const t = i / (points.length - 1);
      const p1 = points[i];
      const p2 = points[i + 1];

      const width = def.shape.width.start + (def.shape.width.end - def.shape.width.start) * t;
      const alpha = (def.visual.alpha.start + (def.visual.alpha.end - def.visual.alpha.start) * t) * fadeMult;
      const color = this.getColor(def.visual.color, t, p1.speed);

      ctx.beginPath();
      ctx.moveTo(p1.x - cameraX, p1.y - cameraY);
      
      // Bezier smoothing
      if (def.behavior.smoothing > 0 && i < points.length - 2) {
        const p3 = points[i + 2];
        const cp1x = p1.x + (p2.x - p1.x) * def.behavior.smoothing;
        const cp1y = p1.y + (p2.y - p1.y) * def.behavior.smoothing;
        const cp2x = p2.x - (p3.x - p1.x) * def.behavior.smoothing * 0.5;
        const cp2y = p2.y - (p3.y - p1.y) * def.behavior.smoothing * 0.5;
        ctx.bezierCurveTo(
          cp1x - cameraX, cp1y - cameraY,
          cp2x - cameraX, cp2y - cameraY,
          p2.x - cameraX, p2.y - cameraY
        );
      } else {
        ctx.lineTo(p2.x - cameraX, p2.y - cameraY);
      }

      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.globalAlpha = alpha;
      ctx.lineCap = 'round';
      ctx.stroke();
    }

    // Glow effect
    if (def.visual.glow && def.visual.glow > 0) {
      ctx.shadowColor = this.getColor(def.visual.color, 0, points[0].speed);
      ctx.shadowBlur = def.shape.width.start * def.visual.glow;
    }
  }

  private renderDotted(
    ctx: CanvasRenderingContext2D,
    points: TrailPoint[],
    def: TrailDefinition,
    cameraX: number,
    cameraY: number,
    fadeMult: number
  ): void {
    for (let i = 0; i < points.length; i++) {
      const t = i / (points.length - 1);
      const p = points[i];

      const size = def.shape.width.start + (def.shape.width.end - def.shape.width.start) * t;
      const alpha = (def.visual.alpha.start + (def.visual.alpha.end - def.visual.alpha.start) * t) * fadeMult;
      const color = this.getColor(def.visual.color, t, p.speed);

      ctx.beginPath();
      ctx.arc(p.x - cameraX, p.y - cameraY, size, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.globalAlpha = alpha;
      ctx.fill();
    }
  }

  private renderTapered(
    ctx: CanvasRenderingContext2D,
    points: TrailPoint[],
    def: TrailDefinition,
    cameraX: number,
    cameraY: number,
    fadeMult: number
  ): void {
    if (points.length < 2) return;

    // Calculate perpendicular offsets for each point
    const leftPoints: { x: number; y: number }[] = [];
    const rightPoints: { x: number; y: number }[] = [];

    for (let i = 0; i < points.length; i++) {
      const t = i / (points.length - 1);
      const width = (def.shape.width.start + (def.shape.width.end - def.shape.width.start) * t) / 2;

      // Get direction
      let dx: number, dy: number;
      if (i === 0) {
        dx = points[1].x - points[0].x;
        dy = points[1].y - points[0].y;
      } else {
        dx = points[i].x - points[i - 1].x;
        dy = points[i].y - points[i - 1].y;
      }

      const len = Math.sqrt(dx * dx + dy * dy);
      if (len === 0) continue;

      // Perpendicular
      const px = -dy / len;
      const py = dx / len;

      leftPoints.push({
        x: points[i].x + px * width - cameraX,
        y: points[i].y + py * width - cameraY,
      });
      rightPoints.push({
        x: points[i].x - px * width - cameraX,
        y: points[i].y - py * width - cameraY,
      });
    }

    // Draw as filled shape
    ctx.beginPath();
    ctx.moveTo(leftPoints[0].x, leftPoints[0].y);

    for (let i = 1; i < leftPoints.length; i++) {
      ctx.lineTo(leftPoints[i].x, leftPoints[i].y);
    }

    for (let i = rightPoints.length - 1; i >= 0; i--) {
      ctx.lineTo(rightPoints[i].x, rightPoints[i].y);
    }

    ctx.closePath();

    // Gradient fill
    const gradient = ctx.createLinearGradient(
      points[0].x - cameraX,
      points[0].y - cameraY,
      points[points.length - 1].x - cameraX,
      points[points.length - 1].y - cameraY
    );
    
    gradient.addColorStop(0, this.getColor(def.visual.color, 0, points[0].speed));
    gradient.addColorStop(1, this.getColor(def.visual.color, 1, points[points.length - 1].speed));

    ctx.fillStyle = gradient;
    ctx.globalAlpha = def.visual.alpha.start * fadeMult;
    ctx.fill();
  }

  private getColor(config: TrailColorConfig, t: number, speed: number): string {
    switch (config.type) {
      case 'solid':
        return config.start;

      case 'gradient':
        return this.lerpColor(config.start, config.end || config.start, t);

      case 'hueShift':
        const baseHue = config.hue ?? 0;
        return `hsl(${baseHue}, 100%, 50%)`;

      case 'velocity':
        if (config.velocityColors && config.velocityColors.length > 0) {
          // Find the right color based on speed
          const colors = config.velocityColors.sort((a, b) => a.speed - b.speed);
          
          for (let i = 0; i < colors.length - 1; i++) {
            if (speed >= colors[i].speed && speed < colors[i + 1].speed) {
              const localT = (speed - colors[i].speed) / (colors[i + 1].speed - colors[i].speed);
              return this.lerpColor(colors[i].color, colors[i + 1].color, localT);
            }
          }
          
          // Above max speed
          if (speed >= colors[colors.length - 1].speed) {
            return colors[colors.length - 1].color;
          }
          
          // Below min speed
          return colors[0].color;
        }
        return config.start;

      default:
        return config.start;
    }
  }

  private lerpColor(colorA: string, colorB: string, t: number): string {
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

  // === Stats ===

  getStats(): { trailCount: number; totalPoints: number } {
    let totalPoints = 0;
    for (const trail of this.trails.values()) {
      totalPoints += trail.points.length;
    }
    return {
      trailCount: this.trails.size,
      totalPoints,
    };
  }

  clear(): void {
    this.trails.clear();
  }
}

// Export singleton
export const trailSystem = new TrailSystem();
