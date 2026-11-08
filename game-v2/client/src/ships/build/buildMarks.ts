/**
 * Build marks shared by the hangar and the world build view: a part's facing arrow and a shaped shield's cover.
 *
 * LOCAL STUB (package "unify"): the agreed API only, so the world build view can call it. The "marks" package writes
 * the real version (every directional part from the game's own rules, the zoneshield cover geometry); the integrator
 * keeps that one. Here: an arrow on parts with an explicit facing, and no shield cover.
 */
import type { Graphics } from 'pixi.js';
import { SIDE_NORMAL, type PlacedGeom, type PlacedPart, type Side } from '@space-game/common';

type ToScreen = (gx: number, gy: number) => { x: number; y: number };

/** An arrow out of the part's facing side (stub: parts with `facing` only) */
export function drawFacingMark(g: Graphics, part: PlacedPart, geom: PlacedGeom, toScreen: ToScreen, scale: number, color = 0xfacc15): void {
  const n = part.facing ? SIDE_NORMAL[part.facing as Side] : undefined;
  if (!n) return;
  const [cx, cy] = geom.centroid;
  const len = 0.45 * Math.sqrt(Math.max(1, geom.area));
  const a = toScreen(cx, cy), b = toScreen(cx + n[0] * len, cy + n[1] * len);
  const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1, ux = dx / d, uy = dy / d, h = scale * 0.14;
  g.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ width: Math.max(1, scale * 0.04), color, alpha: 0.9 });
  g.poly([b.x + ux * h, b.y + uy * h, b.x - uy * h * 0.7, b.y + ux * h * 0.7, b.x + uy * h * 0.7, b.y - ux * h * 0.7]).fill({ color, alpha: 0.9 });
}

/** A shaped shield's cover (stub: drawn by the "marks" package's version) */
export function drawShieldCover(_g: Graphics, _part: PlacedPart, _geom: PlacedGeom, _toScreen: ToScreen, _scale: number, _alpha: number): void {
  // (no-op in the stub)
}
