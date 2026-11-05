/**
 * Which way a hit throws its sparks: off the surface the shell struck, not just back up its line.
 *
 *   SurfaceProbe   finds the struck surface: fed the edges of whatever is near the hit (a ship's parts, an asteroid's
 *                  outline), it keeps the first one the shell's line crosses and that edge's normal, turned to face the
 *                  shell (or, if the line crosses none, as the drawn pose and the server's can differ a little, the
 *                  nearest edge within reach)
 *   throwAngle     the angle a hit's directional parts leave at, by the style's `hitThrow`: mirrored off the surface
 *                  (a ricochet), straight out of it, or back up the shell's line
 *   offSurface     a direction kept out of the surface (one aimed into it is mirrored out)
 *   hitAge         how many ticks into its flight a straight shell reaches a point on its line
 */

/** How a hit's directional parts leave it (WeaponStyle.hitThrow) */
export type HitThrow = 'reflect' | 'normal' | 'back';

/** A struck surface's unit normal, facing the shell that struck it; `target`: the entity it belongs to (-1: none known) */
export interface SurfaceNormal { nx: number; ny: number; target?: number }

export class SurfaceProbe {
  private x0 = 0; private y0 = 0; private dx = 0; private dy = 0;
  private px = 0; private py = 0; private reach = 0;
  private bestT = Infinity; private nearD = Infinity;
  private tnx = 0; private tny = 0; private nnx = 0; private nny = 0; private tTag = -1; private nTag = -1;

  /**
   * A new search along the shell's line from (x0, y0) to (x1, y1), its hit reported at (px, py); `reach`: how far off
   * the hit the nearest edge may be when the line crosses none
   */
  begin(x0: number, y0: number, x1: number, y1: number, px: number, py: number, reach: number): this {
    this.x0 = x0; this.y0 = y0; this.dx = x1 - x0; this.dy = y1 - y0;
    this.px = px; this.py = py; this.reach = reach;
    this.bestT = Infinity; this.nearD = Infinity; this.tTag = -1; this.nTag = -1;
    return this;
  }

  /** One edge of a surface, a to b (either winding); `tag`: whose it is (an entity id) */
  edge(ax: number, ay: number, bx: number, by: number, tag = -1): void {
    const ex = bx - ax, ey = by - ay, len = Math.hypot(ex, ey);
    if (len < 1e-9) return;
    // Its normal, turned to face the shell
    let nx = -ey / len, ny = ex / len;
    if (nx * this.dx + ny * this.dy > 0) { nx = -nx; ny = -ny; }
    // Where the line crosses it (t along the line, u along the edge)
    const den = this.dx * ey - this.dy * ex;
    if (Math.abs(den) > 1e-12) {
      const qx = ax - this.x0, qy = ay - this.y0;
      const t = (qx * ey - qy * ex) / den, u = (qx * this.dy - qy * this.dx) / den;
      if (t >= 0 && t <= 1 && u >= 0 && u <= 1 && t < this.bestT) { this.bestT = t; this.tnx = nx; this.tny = ny; this.tTag = tag; }
    }
    // How far the hit is from it
    const w = Math.max(0, Math.min(1, ((this.px - ax) * ex + (this.py - ay) * ey) / (len * len)));
    const d = Math.hypot(ax + ex * w - this.px, ay + ey * w - this.py);
    if (d < this.nearD) { this.nearD = d; this.nnx = nx; this.nny = ny; this.nTag = tag; }
  }

  /** The struck surface's normal (and whose it is, out.target) into `out`, or null if nothing near was crossed or close */
  result(out: SurfaceNormal): SurfaceNormal | null {
    if (this.bestT < Infinity) { out.nx = this.tnx; out.ny = this.tny; out.target = this.tTag; return out; }
    if (this.nearD <= this.reach) { out.nx = this.nnx; out.ny = this.nny; out.target = this.nTag; return out; }
    out.target = -1;
    return null;
  }
}

/**
 * The angle a hit's directional parts are thrown at: a shell flying (dx, dy) (a unit vector) into a surface whose normal
 * is (nx, ny) (facing the shell). 'reflect' mirrors its line off the surface, 'normal' leaves straight out of it, 'back'
 * goes back up its line. With no surface known, pass the reversed line as the normal: all three then go straight back.
 */
export function throwAngle(mode: HitThrow, dx: number, dy: number, nx: number, ny: number): number {
  if (mode === 'normal') return Math.atan2(ny, nx);
  if (mode === 'reflect') {
    const k = 2 * (dx * nx + dy * ny);
    return Math.atan2(dy - k * ny, dx - k * nx);
  }
  return Math.atan2(-dy, -dx);
}

/** A direction (angle) kept out of a surface: one aimed into it (against its normal) is mirrored out */
export function offSurface(a: number, nx: number, ny: number): number {
  const cx = Math.cos(a), cy = Math.sin(a), k = cx * nx + cy * ny;
  return k >= 0 ? a : Math.atan2(cy - 2 * k * ny, cx - 2 * k * nx);
}

/** Outlier defaults of a burst (ImpactLayers BurstSpread) */
export const BURST = { outliers: 0.15, outSpeed: 2.2, outLife: 1.8 };

/**
 * One fragment's speed (or ember's), × its layer's typical: most near it on a skewed spread (0.55 to 2.35, averaging 1,
 * a few of them quick), a share `out` of them outliers at `mul` × (0.8 to 1.3). `r` and `o` are uniform draws.
 */
export function burstSpeed(out: number, mul: number, r = Math.random(), o = Math.random(), j = Math.random()): number {
  return o < out ? mul * (0.8 + 0.5 * j) : 0.55 + r * r * r * 1.8;
}

/** One fragment's life, × its layer's typical: 0.65 to 1.7 (averaging 1, most short), a share `out` at `mul` × (0.85 to 1.15); drawn apart from its speed */
export function burstLife(out: number, mul: number, r = Math.random(), o = Math.random(), j = Math.random()): number {
  return o < out ? mul * (0.85 + 0.3 * j) : 0.65 + r * r * 1.05;
}

/** How many ticks into its flight a shell leaving (sx, sy) at (vx, vy) a tick reaches the point on its line nearest (x, y) */
export function hitAge(sx: number, sy: number, vx: number, vy: number, x: number, y: number): number {
  const v2 = vx * vx + vy * vy;
  return v2 > 1e-9 ? ((x - sx) * vx + (y - sy) * vy) / v2 : 0;
}
