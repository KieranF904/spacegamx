/**
 * A gun's own part art for the hangar preview: the picture the hangar and the component guide draw for the part (its
 * mounting base and, for a turret, its head, or a fixed gun's barrels: partDecor.drawDecor2d over the placed part),
 * painted once on a canvas facing forward, with where its muzzle is and how far it reaches behind and across it
 * (world units, from the muzzle). Nothing is redrawn here: the shapes are the ship renderer's.
 */

import { isWeaponFn, mountOf, placeGeometry, type Catalog, type FunctionDef, type PlacedPart, type Vec2 } from '@space-game/common';
import { decorOf, drawDecor2d, isTurret } from '../partDecor';
import { gradeGlow, partColors } from '../hullPreview2d';
import { mix, numToCss } from '../shipColors';

/** Canvas pixels a cell */
const PX = 64;
/** Cells of room round the part for barrels and the head */
const PAD = 1.6;

export interface GunArt {
  canvas: HTMLCanvasElement;
  /** The muzzle on the canvas (pixels) */
  tipX: number;
  tipY: number;
  /** Turns the canvas so the gun fires along +x (radians), and the world units a canvas pixel is */
  rotation: number;
  scale: number;
  /** World units behind the muzzle and either side of the line the art reaches */
  back: number;
  half: number;
}

const cache = new Map<string, GunArt | null>();

/** The art for a weapon function, or null when the catalogue has no piece for it */
export function gunArt(catalog: Catalog, fn: FunctionDef, cellSize: number): GunArt | null {
  const key = `${fn.id}|${cellSize}`;
  if (cache.has(key)) return cache.get(key)!;
  const art = make(catalog, fn, cellSize);
  cache.set(key, art);
  return art;
}

function make(catalog: Catalog, fn: FunctionDef, cs: number): GunArt | null {
  const piece = fn.pieces === '*' ? 'sq' : fn.pieces[0];
  if (!catalog.variants.has(piece)) return null;
  const material = fn.material ?? 'alloy';
  // (facing north, as the hangar's guide pictures stand it)
  const part = { uid: 0, piece, fn: fn.id, material, x: 0, y: 0, rot: 0, flip: false, facing: isWeaponFn(fn.id) ? 'N' : undefined } as PlacedPart;
  const geom = placeGeometry(catalog, part);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of geom.polygon) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
  if (!isFinite(minX)) return null;
  const W = Math.ceil((maxX - minX + PAD * 2) * PX), H = Math.ceil((maxY - minY + PAD * 2) * PX);
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const g = canvas.getContext('2d');
  if (!g) return null;
  const map = (x: number, y: number): [number, number] => [(x - minX + PAD) * PX, (y - minY + PAD) * PX];
  const look = partColors(catalog, fn.id, material);
  const d = decorOf(geom);
  if (!d.base) {
    // (a part with no mounting base of its own: its piece under the hardware, as the guide draws it)
    g.beginPath();
    geom.polygon.forEach(([x, y], i) => { const [sx, sy] = map(x, y); if (i) g.lineTo(sx, sy); else g.moveTo(sx, sy); });
    g.closePath();
    g.fillStyle = numToCss(mix(look.fill, 0x000000, 0.1));
    g.fill();
    g.strokeStyle = numToCss(look.edge);
    g.lineWidth = 3;
    g.stroke();
  }
  drawDecor2d(g, geom, map, PX, 1, gradeGlow(look.grade));

  // The muzzle and the way it points: a fixed gun's barrels end where they reach, a turret's head a head-length out of its pivot
  let tip: Vec2 | null = null, dir: Vec2 = [0, -1];
  if (d.barrels.length) {
    const b = d.barrels[0];
    tip = [b.base[0] + b.n[0] * b.len, b.base[1] + b.n[1] * b.len];
    dir = b.n;
  } else if (isTurret(part)) {
    const m = mountOf(geom);
    if (m) { dir = m.dir; const len = 0.8 * Math.sqrt(Math.max(1, geom.area)); tip = [geom.centroid[0] + dir[0] * len, geom.centroid[1] + dir[1] * len]; }
  }
  if (!tip) { const m = mountOf(geom); if (m) { dir = m.dir; tip = [m.at[0], m.at[1]]; } else tip = [(minX + maxX) / 2, minY]; }
  const [tipX, tipY] = map(tip[0], tip[1]);
  // How far the part reaches behind the muzzle along its line and across it, in cells
  const side: Vec2 = [-dir[1], dir[0]];
  let back = 0.5, half = 0.5;
  for (const [x, y] of geom.polygon) {
    back = Math.max(back, (tip[0] - x) * dir[0] + (tip[1] - y) * dir[1]);
    half = Math.max(half, Math.abs((x - tip[0]) * side[0] + (y - tip[1]) * side[1]));
  }
  const k = cs / PX;
  return { canvas, tipX, tipY, rotation: -Math.atan2(dir[1], dir[0]), scale: k, back: (back + 0.3) * cs, half: (half + 0.3) * cs };
}
