/**
 * A station's lit geometry that also remembers each shape drawn into it (its
 * call, vertex range, colour, glow and outline), so the station's look can
 * tell plating from windows, solar cells, tanks, struts and so on, and bake
 * its heights, shadows and light spill (stationBake.ts). Only the outermost
 * call is recorded (a disc is one shape, not the panel and flat it makes).
 */

import { LitGeometry, type ShapeOpts } from '../lighting/LitGeometry';
import type { StationShape } from './stationBake';

const circle = (x: number, y: number, r: number, n = 12): number[] => {
  const p: number[] = [];
  for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; p.push(x + Math.cos(a) * r, y + Math.sin(a) * r); }
  return p;
};

export class StationGeometry extends LitGeometry {
  shapes: StationShape[] = [];
  private depth = 0;

  private rec(call: string, color: number, o: ShapeOpts | undefined, pts: number[], r: number, draw: () => void): void {
    const v0 = this.vertexCount, top = this.depth === 0;
    this.depth++;
    try { draw(); } finally { this.depth--; }
    if (top && this.vertexCount > v0) this.shapes.push({ call, v0, v1: this.vertexCount, color, glow: o?.glow ?? 0, pts, r });
  }

  override flat(pts: number[], color: number, o: ShapeOpts = {}): void {
    this.rec('flat', color, o, pts, 0, () => super.flat(pts, color, o));
  }

  override panel(pts: number[], color: number, o: ShapeOpts = {}): void {
    this.rec('panel', color, o, pts, 0, () => super.panel(pts, color, o));
  }

  override disc(x: number, y: number, r: number, color: number, o: ShapeOpts = {}, sides = 16): void {
    this.rec('disc', color, o, circle(x, y, r), r, () => super.disc(x, y, r, color, o, sides));
  }

  override bowl(x: number, y: number, r: number, color: number, o: ShapeOpts = {}, sides = 7): void {
    this.rec('bowl', color, o, circle(x, y, r), r, () => super.bowl(x, y, r, color, o, sides));
  }

  override bar(x0: number, y0: number, x1: number, y1: number, width: number, color: number, o: ShapeOpts = {}): void {
    const l = Math.hypot(x1 - x0, y1 - y0) || 1, nx = (-(y1 - y0) / l) * width / 2, ny = ((x1 - x0) / l) * width / 2;
    const pts = [x0 + nx, y0 + ny, x1 + nx, y1 + ny, x1 - nx, y1 - ny, x0 - nx, y0 - ny];
    this.rec('bar', color, o, pts, 0, () => super.bar(x0, y0, x1, y1, width, color, o));
  }

  /** Append another station geometry, its shapes with it */
  appendShapes(o: StationGeometry, slot = 0): void {
    const off = this.vertexCount;
    this.append(o, slot);
    for (const s of o.shapes) this.shapes.push({ ...s, v0: s.v0 + off, v1: s.v1 + off });
  }
}

export { circle as shapeCircle };
