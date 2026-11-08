/**
 * A part drawn flat as the hangar draws a part not built yet: its body in its hull colours (hullPreview2d partColors)
 * and its hardware (partDecor drawDecorTo, the same shapes the hangar, item icons and ship renderer use), here into a
 * pixi Graphics in any frame. The world build view draws missing parts and the part in hand with it, so a part looks
 * the same in the world as in the hangar. `tint` mixes every colour toward one (the hand: green fits, red doesn't).
 */
import type { Graphics } from 'pixi.js';
import type { Catalog, PlacedGeom } from '@space-game/common';
import { partColors } from '../hullPreview2d';
import { drawDecorTo } from '../partDecor';
import { mix } from '../shipColors';

export interface PartArtStyle {
  alpha: number;
  /** Mix every colour toward this one by `tintK` */
  tint?: number;
  tintK?: number;
  /** The design's paint (Blueprint.paint as a number) */
  paint?: number;
}

/** Draw `geom`'s part: `at` maps grid points into the graphics' frame, `scale` is its units per cell */
export function drawPartArt(g: Graphics, catalog: Catalog, geom: PlacedGeom, at: (gx: number, gy: number) => [number, number], scale: number, style: PartArtStyle): void {
  const p = geom.part, alpha = style.alpha;
  const tone = (c: number) => (style.tint === undefined ? c : mix(c, style.tint, style.tintK ?? 0.5));
  const look = partColors(catalog, p.fn, p.material, style.paint);
  const body: number[] = [];
  for (const [x, y] of geom.polygon) { const w = at(x, y); body.push(w[0], w[1]); }
  if (body.length >= 6) {
    g.poly(body).fill({ color: tone(look.fill), alpha: alpha * 0.85 });
    g.poly(body).stroke({ width: Math.max(1, scale * 0.04), color: tone(look.edge), alpha });
  }
  drawDecorTo({
    poly(pts, color) { if (pts.length >= 6) g.poly(pts).fill({ color: tone(color), alpha }); },
    disc(x, y, r, color) { g.circle(x, y, r).fill({ color: tone(color), alpha }); },
  }, geom, at, scale);
}
