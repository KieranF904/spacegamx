/**
 * The component guide's pictures: a part as it looks on a ship (its piece in
 * its material's colours and its hardware, an engine's nozzle; a gun is only
 * its mounting base and turret, the rest of its cell open, as in the hangar),
 * on a transparent ground with a soft drop shadow baked in. Every picture is
 * at one scale (CELL_PX a cell, about 60% of the hangar zoomed in)
 * so sizes compare, drawn once and cached as a data URL.
 */

import { isWeaponFn, partNeedsFacing, placeGeometry, type Catalog, type PlacedPart, type Vec2 } from '@space-game/common';
import { ENGINE_FNS, decorOf, drawDecor2d } from '../ships/partDecor';
import { gradeGlow, partColors } from '../ships/hullPreview2d';
import { mix, numToCss } from '../ships/shipColors';
import { pictureSheet } from '../assets/pictureSheet';
import { pictureData } from '../assets/gameData';

/** CSS pixels a cell */
export const CELL_PX = 34;
const DPR = 2;
/** What it draws, by version (assetCache.ts): bump it whenever the pictures change */
export const PART_SPRITES_VERSION = 1;
/** (Kept between visits: pictureSheet) */
const cache = pictureSheet<{ url: string; w: number; h: number }>('partSprites', PART_SPRITES_VERSION, pictureData);

/** One part, or several side by side (structure: hull, armour, cargo) */
export interface SpritePart { fn: string; material: string; piece: string; x?: number; y?: number }

const keyOf = (parts: SpritePart[]) => parts.map((p) => `${p.fn}:${p.material}:${p.piece}@${p.x ?? 0},${p.y ?? 0}`).join('|');

/** The picture if it has been drawn already (drawing one costs a few ms: callers spread that over idle time) */
export function peekSprite(parts: SpritePart[]): { url: string; w: number; h: number } | undefined {
  return cache.get(keyOf(parts));
}

/** A cached picture of parts (CSS size w × h) */
export function partSprite(catalog: Catalog, parts: SpritePart[]): { url: string; w: number; h: number } {
  const key = keyOf(parts);
  const hit = cache.get(key);
  if (hit) return hit;
  const k = CELL_PX * DPR;
  const geoms = parts.flatMap((p) => {
    if (!catalog.variants.has(p.piece)) return [];
    // Weapons face forward (up), engines push forward (nozzle down)
    const part = { uid: 0, piece: p.piece, fn: p.fn, material: p.material, x: p.x ?? 0, y: p.y ?? 0, rot: 0, flip: false, facing: ENGINE_FNS.has(p.fn) ? 'S' : isWeaponFn(p.fn) || partNeedsFacing(p.fn) ? 'N' : undefined } as PlacedPart;
    return [placeGeometry(catalog, part)];
  });
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const g of geoms) for (const [x, y] of g.polygon) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
  if (!geoms.length) { minX = minY = 0; maxX = maxY = 1; }
  // Room for barrels and nozzles past the piece, and the shadow
  const pad = 1.6;
  const W = Math.ceil((maxX - minX + pad * 2) * k), H = Math.ceil((maxY - minY + pad * 2) * k);
  const art = document.createElement('canvas');
  art.width = W; art.height = H;
  const g = art.getContext('2d')!;
  const map = (x: number, y: number): [number, number] => [(x - minX + pad) * k, (y - minY + pad) * k];
  for (const geom of geoms) {
    const p = geom.part;
    const look = partColors(catalog, p.fn, p.material);
    const path = (poly: Vec2[]) => { g.beginPath(); poly.forEach(([x, y], i) => { const [sx, sy] = map(x, y); if (i) g.lineTo(sx, sy); else g.moveTo(sx, sy); }); g.closePath(); };
    // A weapon's body is its mounting base (decor.base, drawn by drawDecor2d): no piece under it, the rest of its cell open
    if (decorOf(geom).base) { drawDecor2d(g, geom, map, k, 1, gradeGlow(look.grade)); continue; }
    path(geom.polygon);
    const [x0, y0] = map(minX, minY), [x1, y1] = map(maxX, maxY);
    const grad = g.createLinearGradient(x0, y0, x1, y1);
    grad.addColorStop(0, numToCss(mix(look.fill, 0xffffff, 0.22)));
    grad.addColorStop(1, numToCss(mix(look.fill, 0x000000, 0.3)));
    g.fillStyle = grad;
    g.fill();
    g.strokeStyle = numToCss(look.edge);
    g.lineWidth = 1.5 * DPR;
    g.stroke();
    mark(g, p.fn, catalog.functions.get(p.fn)?.family ?? '', map(geom.centroid[0], geom.centroid[1]), k, look.grade);
    drawDecor2d(g, geom, map, k, 1, gradeGlow(look.grade));
  }
  // Trim to what was drawn, then lay it on a soft shadow
  const box = bounds(g, W, H);
  const sh = 10 * DPR, dy = 5 * DPR;
  const out = document.createElement('canvas');
  out.width = box.w + sh * 2; out.height = box.h + sh * 2 + dy;
  const o = out.getContext('2d')!;
  o.shadowColor = 'rgba(0, 0, 0, 0.6)';
  o.shadowBlur = sh;
  o.shadowOffsetY = dy;
  o.drawImage(art, box.x, box.y, box.w, box.h, sh, sh, box.w, box.h);
  const res = { url: out.toDataURL(), w: out.width / DPR, h: out.height / DPR };
  cache.add(key, res);
  return res;
}

/** What structure, the core and the hardware-less models (scanners, constructors) are, on top of their piece */
function mark(g: CanvasRenderingContext2D, fn: string, fam: string, [cx, cy]: [number, number], k: number, grade: number): void {
  const s = k * 0.32;
  g.save();
  g.lineWidth = 0.06 * k;
  if (fn === 'core') {
    g.shadowColor = gradeGlow(grade); g.shadowBlur = 0.4 * k;
    g.fillStyle = '#e0f4ff'; g.beginPath(); g.arc(cx, cy, 0.18 * k, 0, Math.PI * 2); g.fill();
  } else if (fam === 'scanner') {
    // A dish and its sweep
    g.strokeStyle = '#e6fffb'; g.lineWidth = 0.05 * k;
    for (const r of [0.12, 0.22, 0.32]) { g.beginPath(); g.arc(cx, cy + 0.12 * k, r * k, -Math.PI * 0.8, -Math.PI * 0.2); g.stroke(); }
    g.fillStyle = '#e6fffb'; g.beginPath(); g.arc(cx, cy + 0.12 * k, 0.05 * k, 0, Math.PI * 2); g.fill();
  } else if (fam === 'constructor') {
    // A builder's arm and its beam head
    g.fillStyle = 'rgba(30, 25, 10, 0.75)';
    g.fillRect(cx - 0.3 * k, cy + 0.12 * k, 0.6 * k, 0.12 * k);
    g.fillRect(cx - 0.05 * k, cy - 0.25 * k, 0.1 * k, 0.4 * k);
    g.shadowColor = '#7dd3fc'; g.shadowBlur = 0.25 * k;
    g.fillStyle = '#bae6fd'; g.beginPath(); g.arc(cx, cy - 0.27 * k, 0.08 * k, 0, Math.PI * 2); g.fill();
  } else if (fn === 'armor') {
    g.strokeStyle = 'rgba(20, 25, 35, 0.55)';
    for (let i = -1; i <= 1; i++) { g.beginPath(); g.moveTo(cx + i * s * 0.7 - s * 0.35, cy - s); g.lineTo(cx + i * s * 0.7 + s * 0.35, cy + s); g.stroke(); }
  } else if (fn === 'cargo') {
    g.strokeStyle = 'rgba(20, 25, 35, 0.6)';
    g.strokeRect(cx - s, cy - s, s * 2, s * 2);
    g.beginPath(); g.moveTo(cx - s, cy - s); g.lineTo(cx + s, cy + s); g.moveTo(cx + s, cy - s); g.lineTo(cx - s, cy + s); g.stroke();
  }
  g.restore();
}

function bounds(g: CanvasRenderingContext2D, W: number, H: number): { x: number; y: number; w: number; h: number } {
  const a = g.getImageData(0, 0, W, H).data;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (a[(y * W + x) * 4 + 3] < 8) continue;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return x1 < 0 ? { x: 0, y: 0, w: 1, h: 1 } : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
