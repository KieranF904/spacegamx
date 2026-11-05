/**
 * The hull look (hullLook.ts) for 2D canvases (the hangar): a part's colour as
 * it's drawn in flight, its trim, and its grade's glow colour.
 */

import type { Catalog } from '@space-game/common';
import { functionColor, mix } from './shipColors';
import { GLOW_COOL, GLOW_WARM, HULL_MAT, gradeOfMaterial } from './hullLook';

/** A part's fill and trim colours, as the hull is built in flight (ShipRenderer.buildHull) */
export function partColors(catalog: Catalog, fn: string, material: string, paint?: number): { fill: number; edge: number; grade: number } {
  const shell = fn === 'hull' || fn === 'armor', hm = shell ? HULL_MAT[material] : undefined;
  const grade = gradeOfMaterial(catalog, material), gk = (grade - 1) / 4;
  const matColor = parseInt((catalog.materials.get(material)?.color ?? '#888888').slice(1), 16);
  let fill = hm ? mix(functionColor(fn), matColor, hm.tint) : shell ? mix(functionColor(fn), matColor, 0.25) : mix(functionColor(fn), matColor, 0.12 * gk);
  if (paint !== undefined && (shell || fn === 'core')) fill = mix(fill, paint, fn === 'core' ? 0.3 : 0.45);
  let edge = mix(fill, 0xc8d6ea, shell ? 0.22 : 0.3);
  if (!shell) edge = mix(edge, matColor, 0.15 + 0.6 * gk);
  return { fill, edge, grade };
}

/** A grade's glow colour as CSS: cool (cores, engines) or warm (vents) */
export function gradeGlow(grade: number, warm = false): string {
  const p = warm ? GLOW_WARM : GLOW_COOL, i = (Math.max(1, Math.min(5, grade)) - 1) * 3;
  return `rgb(${Math.round(p[i] * 255)}, ${Math.round(p[i + 1] * 255)}, ${Math.round(p[i + 2] * 255)})`;
}
