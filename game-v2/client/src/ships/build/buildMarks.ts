/**
 * @contract client.ships.build-marks
 * owns:       build-view marks shared by the hangar and the world build view: the facing arrow of a directional part and the
 *             real cover (wall line or arc) of a shaped shield, as pure grid-space geometry plus a pixi Graphics drawer
 * needs:      common mountOf / shapedAt / registeredFunction / partNeedsFacing (the game's own rules); npm: pixi.js (types only)
 * invariants: a shield's cover is the one shaped.ts builds, so the preview matches what blocks shots — client/src/ships/build/buildMarks.test.ts
 *             marks only draw, never change a design — client/src/ships/hangar/marksPure.test.ts
 * extend:     a part kind with a direction but no `facing` is one more case in facingMark(); a canvas drawer reuses facingMark / coverPolyline
 */

import type { Graphics } from 'pixi.js';
import { mountOf, shapedAt, registeredFunction, partNeedsFacing, isWeaponFn, type PlacedPart, type PlacedGeom, type ShapedShield, type Vec2 } from '@space-game/common';

export type ToScreen = (gx: number, gy: number) => { x: number; y: number };

/** A facing arrow in grid cells: its three points (base left, tip, base right), and where it sits and points */
export interface FacingMark { tri: [Vec2, Vec2, Vec2]; at: Vec2; dir: Vec2 }

/** Guns' arrows are warm, everything else cool */
export const FACING_COLOR = 0x9fd0ff;
export const GUN_FACING_COLOR = 0xffb4a8;
export const COVER_COLOR = 0x67e8f9;
export const COVER_DEEP_COLOR = 0xfbbf24;

/** Does this part point somewhere (a gun's barrel, an engine, a clamp, a mine bay, a shield, a diode: whatever keeps a facing) */
export function hasDirection(part: PlacedPart): boolean {
  return !!part.facing && (partNeedsFacing(part.fn) || !!registeredFunction(part.fn)?.shaped);
}

/** The arrow of a directional part: on the middle of its business edge, pointing out of it. Null for a part with no direction */
export function facingMark(part: PlacedPart, geom: PlacedGeom, len = 0.45, half = 0.22): FacingMark | null {
  if (!hasDirection(part)) return null;
  const m = mountOf(geom);
  if (!m) return null;
  const [ax, ay] = m.at, [dx, dy] = m.dir;
  const bx = ax - dx * 0.05, by = ay - dy * 0.05;
  return { tri: [[bx - dy * half, by + dx * half], [ax + dx * len, ay + dy * len], [bx + dy * half, by - dx * half]], at: m.at, dir: m.dir };
}

/** The shaped shield a part is, placed as it stands (null: not a shield, or no edge to project from) */
export function shieldCover(part: PlacedPart, geom: PlacedGeom): ShapedShield | null {
  const fn = registeredFunction(part.fn);
  if (!fn?.shaped) return null;
  return shapedAt(fn, undefined, part.uid, mountOf(geom));
}

/** The line a shield covers in grid cells: a wall's two ends, or an arc sampled (`steps` segments) */
export function coverPolyline(s: ShapedShield, steps = 24): Vec2[] {
  if (s.kind === 'wall') return [[s.ax, s.ay], [s.bx, s.by]];
  const pts: Vec2[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = s.mid - s.half + (2 * s.half * i) / steps;
    pts.push([s.cx + Math.cos(a) * s.r, s.cy + Math.sin(a) * s.r]);
  }
  return pts;
}

/** An arrow on a directional part (no-op on others). `scale` is screen px a cell, for the line weight */
export function drawFacingMark(g: Graphics, part: PlacedPart, geom: PlacedGeom, toScreen: ToScreen, scale: number, color?: number): void {
  const mk = facingMark(part, geom);
  if (!mk) return;
  const flat: number[] = [];
  for (const [x, y] of mk.tri) { const p = toScreen(x, y); flat.push(p.x, p.y); }
  const c = color ?? (isWeaponFn(part.fn) ? GUN_FACING_COLOR : FACING_COLOR);
  g.poly(flat).fill({ color: c, alpha: 0.9 }).stroke({ color: 0x0b1220, width: Math.max(1, scale * 0.03), alpha: 0.6 });
}

/** A shaped shield's real cover, faint (no-op on other parts) */
export function drawShieldCover(g: Graphics, part: PlacedPart, geom: PlacedGeom, toScreen: ToScreen, scale: number, alpha: number): void {
  const s = shieldCover(part, geom);
  if (!s) return;
  const pts = coverPolyline(s);
  const color = s.deep ? COVER_DEEP_COLOR : COVER_COLOR;
  const w = Math.max(2, scale * 0.14);
  const line = (width: number, a: number) => {
    const p0 = toScreen(pts[0][0], pts[0][1]);
    g.moveTo(p0.x, p0.y);
    for (let i = 1; i < pts.length; i++) { const p = toScreen(pts[i][0], pts[i][1]); g.lineTo(p.x, p.y); }
    g.stroke({ color, width, alpha: a, cap: 'round', join: 'round' });
  };
  line(w * 2.2, alpha * 0.25);
  line(w, alpha);
}
