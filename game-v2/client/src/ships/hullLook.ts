/**
 * What a hull is made of, to look at (the hull shader in ShipBatch draws it):
 *   kind       what a part does, picking its tile and finish: plating, armour,
 *              machinery, core, energy parts, plain hardware
 *   material   a hull or armour part's own surface (HULL_MAT): its tile, how
 *              far its colour takes the part, metalness, own light, highlight;
 *              each grade more impressive than the last
 *   grade      a part's Mk (its material's): its glows take that grade's colour
 *              (GLOW_COOL for cores and engines, GLOW_WARM for vents)
 *   exposure   how open each vertex is to space, by direction (bakeHull): a
 *              light reaches it as far as it's open towards it
 *   volume     which way open space lies from each vertex, shared by its part:
 *              the shader leans the part that way, so a hull reads rounded
 * and the atlas (hullTextures.ts), built in a worker.
 */

import { BufferImageSource, Texture } from 'pixi.js';
import type { Catalog, PlacedGeom } from '@space-game/common';
import { HULL_ROWS, HULL_TILE } from './hullTextures';
import { shipFunction } from './shipFunctionData';

/** By what a part does: 0 plating, 1 armour, 2 machinery, 3 core, 4 plain hardware (decor), 5 energy parts, 6 jump coils */
const HULL_KIND = { plating: 0, armour: 1, core: 3, energy: 5, jump: 6 } as const;
/** (A function's `hullKind` in functions.json; absent: machinery) */
export const hullKind = (fn: string) => { const k = shipFunction(fn)?.hullKind; return k ? HULL_KIND[k] : 2; };

/** Per kind: highlight strength, shininess, own light, panel relief */
export const KIND_LOOK = new Float32Array([0.32, 18, 0, 1, 0.14, 9, 0, 1, 0.24, 14, 0, 0.9, 0.35, 30, 0.8, 0.8, 0.22, 16, 0, 0, 0.24, 14, 0.45, 0.9, 0.24, 14, 0.4, 0.9]);
/** Per kind: own light's colour (set from the grade's palette when not zero; jump coils keep the stillstones' pale blue-white), pulse rate */
export const KIND_GLOW = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0.4, 0.85, 1.0, 2.4, 0, 0, 0, 1, 1.0, 0.55, 0.2, 1.4, 0.74, 0.85, 0.92, 0.8]);
/** Each grade's glow, round the whole wheel (not its material's colour): cores and engines cyan, green, gold, crimson, violet */
export const GLOW_COOL = new Float32Array([0.15, 0.85, 1.0, 0.2, 1.0, 0.35, 1.0, 0.78, 0.15, 1.0, 0.15, 0.25, 0.7, 0.3, 1.0]);
/** … and vents amber, lime, teal, magenta, white-hot */
export const GLOW_WARM = new Float32Array([1.0, 0.6, 0.1, 0.6, 1.0, 0.15, 0.1, 1.0, 0.85, 1.0, 0.2, 0.85, 1.0, 0.92, 0.8]);

/**
 * Each hull material's look: its tile, how far its own colour takes the part, metalness, own light (in its tile's mask),
 * highlight boost. The game's own ships' materials (`any`) dress every part made of them, not just hull and armour,
 * and glow their own colour (`emit`), more where power runs (`hot`: × that on powered parts). `wear`: where its tile's worn
 * through (its own light's mask, instead), its colour × this (HULL_WEAR)
 */
export const HULL_MAT: Record<string, { tile: number; tint: number; metal: number; glow: number; boost: number; any?: boolean; emit?: [number, number, number]; hot?: number; wear?: [number, number, number] }> = {
  pyre_glass: { tile: 16, tint: 0.9, metal: 0.5, glow: 0.42, boost: 0.8, any: true, emit: [1.0, 0.42, 0.12], hot: 3.6 },
  pyre_chrome: { tile: 7, tint: 1, metal: 1, glow: 0, boost: 3, any: true, emit: [1.0, 0.42, 0.12], hot: 1 },
  pyre_steel: { tile: 7, tint: 1, metal: 0.7, glow: 0, boost: 2.2, any: true, emit: [1.0, 0.42, 0.12], hot: 1 },
  pyre_crystal: { tile: 17, tint: 0.9, metal: 0.75, glow: 0.9, boost: 1.4, any: true, emit: [0.55, 0.62, 1.0], hot: 1.3 },
  // (the Scrap Mother's: salvaged plate, mismatched; greyseam's pale green where power runs)
  // (worn through: rust in the iron's pits and welds, the rust's blooms fresh orange, bare metal in the paint's chips, grime on the steel)
  scrap_iron: { tile: 18, tint: 0.92, metal: 0.6, glow: 0.3, boost: 0.25, any: true, emit: [0.35, 1.0, 0.72], hot: 3.2, wear: [1.3, 0.78, 0.5] },
  scrap_rust: { tile: 19, tint: 0.92, metal: 0.35, glow: 0.3, boost: 0.1, any: true, emit: [0.35, 1.0, 0.72], hot: 3.2, wear: [1.35, 1.02, 0.62] },
  scrap_paint: { tile: 20, tint: 0.92, metal: 0.4, glow: 0.3, boost: 0.3, any: true, emit: [0.35, 1.0, 0.72], hot: 3.2, wear: [1.28, 1.06, 1.12] },
  scrap_steel: { tile: 21, tint: 1, metal: 0.8, glow: 0, boost: 0.9, any: true, emit: [0.35, 1.0, 0.72], hot: 1, wear: [0.7, 0.58, 0.45] },
  scrap_seam: { tile: 22, tint: 0.9, metal: 0.75, glow: 0.95, boost: 1.4, any: true, emit: [0.35, 1.0, 0.72], hot: 1.4 },
  // (the Brood Mother's: scaled shell, membrane and her gland on her own carapace, rime in facets, ice in prisms; an
  // aurora violet where her light runs)
  brood_shell: { tile: 23, tint: 0.92, metal: 0.45, glow: 0.3, boost: 0.5, any: true, emit: [0.82, 0.42, 1.0], hot: 3.0 },
  brood_membrane: { tile: 23, tint: 0.9, metal: 0.25, glow: 0.5, boost: 0.35, any: true, emit: [0.82, 0.42, 1.0], hot: 2.6 },
  brood_gland: { tile: 23, tint: 0.9, metal: 0.4, glow: 0.6, boost: 0.6, any: true, emit: [0.82, 0.42, 1.0], hot: 1.2 },
  brood_rime: { tile: 22, tint: 0.9, metal: 0.6, glow: 0.35, boost: 1.0, any: true, emit: [0.82, 0.42, 1.0], hot: 2.4 },
  brood_ice: { tile: 17, tint: 0.9, metal: 0.7, glow: 0.4, boost: 0.9, any: true, emit: [0.82, 0.42, 1.0], hot: 1.2 },
  // (custom enemies' own, docs/enemies/custom-roster.md: the Maw's slate crust and glass (its heartbeat's gold where light
  // runs), the pirates' grimy plate and chipped red paint)
  maw_slate: { tile: 18, tint: 0.9, metal: 0.35, glow: 0.3, boost: 0.35, any: true, emit: [1.0, 0.7, 0.3], hot: 2.2, wear: [0.8, 0.74, 0.66] },
  maw_glass: { tile: 17, tint: 0.88, metal: 0.7, glow: 0.6, boost: 1.2, any: true, emit: [1.0, 0.7, 0.3], hot: 1.6 },
  pirate_plate: { tile: 21, tint: 0.95, metal: 0.75, glow: 0, boost: 0.7, any: true, emit: [1.0, 0.45, 0.25], hot: 1, wear: [0.7, 0.6, 0.5] },
  pirate_paint: { tile: 20, tint: 0.95, metal: 0.4, glow: 0, boost: 0.3, any: true, emit: [1.0, 0.45, 0.25], hot: 1, wear: [1.2, 1.15, 1.15] },
  alloy: { tile: 0, tint: 0.3, metal: 0.7, glow: 0, boost: 0 },
  composite: { tile: 4, tint: 0.4, metal: 0.1, glow: 0, boost: -0.3 },
  steel: { tile: 5, tint: 0.5, metal: 0.8, glow: 0, boost: 0.15 },
  insulated_polymer: { tile: 6, tint: 0.55, metal: 0.05, glow: 0, boost: -0.2 },
  titanium: { tile: 7, tint: 0.72, metal: 0.95, glow: 0, boost: 0.5 },
  ceramic_laminate: { tile: 8, tint: 0.72, metal: 0.1, glow: 0, boost: 0.25 },
  sealed_composite: { tile: 9, tint: 0.72, metal: 0.35, glow: 0, boost: 0.35 },
  conductive_steel: { tile: 10, tint: 0.72, metal: 0.85, glow: 0.45, boost: 0.35 },
  leaded_iridium: { tile: 11, tint: 0.74, metal: 1, glow: 0, boost: 0.7 },
  dense_ferrite: { tile: 12, tint: 0.72, metal: 0.55, glow: 0, boost: -0.1 },
  leestone: { tile: 13, tint: 0.75, metal: 0.25, glow: 0, boost: 0.1 },
  cobalt: { tile: 14, tint: 0.8, metal: 0.95, glow: 0.6, boost: 0.8 },
  neutronium: { tile: 15, tint: 0.86, metal: 0.9, glow: 1.1, boost: 1.0 },
  dev_singularity: { tile: 15, tint: 0.9, metal: 0.9, glow: 1.6, boost: 1.2, any: true, emit: [1.0, 0.2, 0.9], hot: 2 },
};

/** The game's own ships' tiles (16 on: one a tile): × what colour where worn through, and whether their own light's mask is that (w: 1) */
export const HULL_WEAR = new Float32Array((HULL_ROWS * 4 - 16) * 4).map((_, k) => (k % 4 === 3 ? 0 : 1));
for (const m of Object.values(HULL_MAT)) if (m.wear && m.tile >= 16) HULL_WEAR.set([...m.wear, 1], (m.tile - 16) * 4);

export function gradeOfMaterial(catalog: Catalog, material: string): number {
  return Math.max(1, Math.min(5, Math.round((catalog.materials.get(material) as { grade?: number } | undefined)?.grade ?? 1)));
}

let atlas: Texture | null = null, asked = false, built = false;
/** The real hull atlas is in, or nothing has asked for it yet (the loading screen waits while it's coming) */
export function hullAtlasReady(): boolean {
  return !asked || built;
}
/** The hull atlas once built (a flat stand-in until then: no detail, no glow); a new texture when it arrives */
export function hullAtlas(): Texture {
  if (!atlas) {
    atlas = new Texture({ source: new BufferImageSource({ resource: new Uint8Array([128, 128, 128, 0]), width: 1, height: 1, alphaMode: 'no-premultiply-alpha' }) });
  }
  if (!asked) {
    asked = true;
    const done = (data: Uint8Array) => {
      built = true;
      atlas = new Texture({ source: new BufferImageSource({
        resource: data, width: HULL_TILE * 4, height: HULL_TILE * HULL_ROWS,
        // Data, not colour: alpha is its own channel, never multiplied in
        alphaMode: 'no-premultiply-alpha', addressMode: 'clamp-to-edge', scaleMode: 'linear', autoGenerateMipmaps: true,
      }) });
    };
    const inline = () => void import('./hullTextures').then((m) => done(m.buildHullAtlas()));
    try {
      const w = new Worker(new URL('./hullAtlasWorker.ts', import.meta.url), { type: 'module' });
      // (Ended once it has stored the atlas, too)
      w.onmessage = (e: MessageEvent<Uint8Array | 'stored'>) => { if (e.data === 'stored') w.terminate(); else done(e.data); };
      w.onerror = () => { w.terminate(); inline(); };
      w.postMessage(0);
    } catch {
      setTimeout(inline, 0);
    }
  }
  return atlas;
}

/**
 * Exposure and volume for a hull (`pos`: its vertices in pixels about the
 * centre of mass `com`, `cs` pixels a cell): the hull as a grid (8 to a cell),
 * then from each vertex how far it is to clear it going each of 16 ways.
 * Exposure: mean, cos, sin of exp(-d / 2.2). Volume: the way to open space,
 * weighted to the nearer (exp(-d / 6)), then shared by each part (`parts`:
 * vertex ranges): every vertex gets its part's mean lean and a fifth of its own.
 *
 * `layer` (each part's, by index; `vpart`: each vertex's part): parts in layers, each baked against its own layer's
 * parts alone (a boss's next stage beneath its body is lit as it'll be seen, bared, not as if covered).
 */
export function bakeHull(pos: number[], geoms: PlacedGeom[], alive: readonly boolean[], com: readonly number[], cs: number, parts: [number, number][], layer?: readonly number[], vpart?: readonly number[]): { expo: Float32Array; bend: Float32Array } {
  const [cx, cy] = com;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  geoms.forEach((geom, i) => { if (alive[i]) for (const [x, y] of geom.polygon) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); } });
  // (no parts attached: nothing to bake)
  if (!Number.isFinite(x0)) return { expo: new Float32Array((pos.length / 2) * 3).fill(0.5), bend: new Float32Array((pos.length / 2) * 3) };
  const R = 8, gw = Math.ceil((x1 - x0) * R) + 2, gh = Math.ceil((y1 - y0) * R) + 2, D2 = Math.SQRT2;
  const inPoly = (poly: readonly (readonly number[])[], x: number, y: number) => {
    let c = false;
    for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) {
      const [xa, ya] = poly[a], [xb, yb] = poly[b];
      if ((ya > y) !== (yb > y) && x < ((xb - xa) * (y - ya)) / (yb - ya) + xa) c = !c;
    }
    return c;
  };
  // Each layer's grid, and how far each solid cell of it is from open space (chamfer, in cells: outside the grid is
  // open), so a ray can stride over what's sure to be solid. The chamfer runs up to 1/cos(22.5°) long and a point sits
  // up to a cell from its cell's centre, hence the slack: a stride never passes a point a step at a time would find open
  const grids = new Map<number, { grid: Uint8Array; far: Float32Array }>();
  const gridOf = (l: number) => {
    let got = grids.get(l);
    if (got) return got;
    const grid = new Uint8Array(Math.max(1, gw * gh)), far = new Float32Array(gw * gh);
    geoms.forEach((geom, i) => {
      if (!alive[i] || (layer?.[i] ?? 0) !== l) return;
      let px0 = Infinity, py0 = Infinity, px1 = -Infinity, py1 = -Infinity;
      for (const [x, y] of geom.polygon) { px0 = Math.min(px0, x); py0 = Math.min(py0, y); px1 = Math.max(px1, x); py1 = Math.max(py1, y); }
      for (let gy = Math.floor((py0 - y0) * R); gy <= Math.ceil((py1 - y0) * R); gy++) for (let gx = Math.floor((px0 - x0) * R); gx <= Math.ceil((px1 - x0) * R); gx++) {
        if (gx < 0 || gy < 0 || gx >= gw || gy >= gh) continue;
        if (inPoly(geom.polygon, x0 + (gx + 0.5) / R, y0 + (gy + 0.5) / R)) grid[gy * gw + gx] = 1;
      }
    });
    for (let k = 0; k < gw * gh; k++) far[k] = grid[k] ? 1e9 : 0;
    const at = (gx: number, gy: number) => (gx < 0 || gy < 0 || gx >= gw || gy >= gh ? 0 : far[gy * gw + gx]);
    for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
      const k = gy * gw + gx;
      if (far[k]) far[k] = Math.min(far[k], at(gx - 1, gy) + 1, at(gx, gy - 1) + 1, at(gx - 1, gy - 1) + D2, at(gx + 1, gy - 1) + D2);
    }
    for (let gy = gh - 1; gy >= 0; gy--) for (let gx = gw - 1; gx >= 0; gx--) {
      const k = gy * gw + gx;
      if (far[k]) far[k] = Math.min(far[k], at(gx + 1, gy) + 1, at(gx, gy + 1) + 1, at(gx + 1, gy + 1) + D2, at(gx - 1, gy + 1) + D2);
    }
    grids.set(l, (got = { grid, far }));
    return got;
  };
  const n = pos.length / 2, expo = new Float32Array(n * 3), bend = new Float32Array(n * 3), own = new Float32Array(n * 2);
  const DIRS = 16, MAXD = 12, STEP = 1 / R;
  const DX = Array.from({ length: DIRS }, (_, k) => Math.cos((k / DIRS) * Math.PI * 2)), DY = Array.from({ length: DIRS }, (_, k) => Math.sin((k / DIRS) * Math.PI * 2));
  // (each place worked out once, however many vertices share it: within a sixteenth of a cell is the same place, half
  // the bake's own grid, and a detailed hull packs its vertices that close)
  const done = new Map<number, number>();
  for (let v = 0; v < n; v++) {
    const px = pos[v * 2] / cs + cx, py = pos[v * 2 + 1] / cs + cy, l = layer?.[vpart?.[v] ?? -1] ?? 0;
    const key = ((Math.round(px * 16) + 2 ** 20) * 2 ** 21 + Math.round(py * 16) + 2 ** 20) * 4 + l;
    const same = done.get(key);
    if (same !== undefined) {
      for (let c = 0; c < 3; c++) expo[v * 3 + c] = expo[same * 3 + c];
      own[v * 2] = own[same * 2]; own[v * 2 + 1] = own[same * 2 + 1]; bend[v * 3 + 2] = bend[same * 3 + 2];
      continue;
    }
    done.set(key, v);
    const { grid, far } = gridOf(l);
    let a0 = 0, a1 = 0, b1 = 0, bx = 0, by = 0, depth = MAXD;
    for (let r = 0; r < DIRS; r++) {
      const dx = DX[r], dy = DY[r];
      let d = MAXD;
      // starting just off the vertex (one on the outside edge clears the hull at once going outwards), a step at a
      // time, or more where it's sure to be solid
      for (let st = 0; STEP * (st + 0.6) < MAXD; ) {
        const t = STEP * (st + 0.6), gx = Math.floor((px + dx * t - x0) * R), gy = Math.floor((py + dy * t - y0) * R), k = gy * gw + gx;
        if (gx < 0 || gy < 0 || gx >= gw || gy >= gh || !grid[k]) { d = t; break; }
        st += Math.max(1, Math.floor(far[k] * 0.92 - 1.5));
      }
      const e = Math.exp(-d / 2.2), wv = Math.exp(-d / 6);
      a0 += e; a1 += e * dx; b1 += e * dy;
      bx += wv * dx; by += wv * dy; depth = Math.min(depth, d);
    }
    expo[v * 3] = a0 / DIRS; expo[v * 3 + 1] = (2 * a1) / DIRS; expo[v * 3 + 2] = (2 * b1) / DIRS;
    own[v * 2] = (2 * bx) / DIRS; own[v * 2 + 1] = (2 * by) / DIRS;
    bend[v * 3 + 2] = depth;
  }
  for (const [a, b] of parts) {
    if (b <= a) continue;
    let mx = 0, my = 0;
    for (let k = a; k < b; k++) { mx += own[k * 2]; my += own[k * 2 + 1]; }
    mx /= b - a; my /= b - a;
    for (let k = a; k < b; k++) { bend[k * 3] = mx * 0.8 + own[k * 2] * 0.2; bend[k * 3 + 1] = my * 0.8 + own[k * 2 + 1] * 0.2; }
  }
  return { expo, bend };
}
