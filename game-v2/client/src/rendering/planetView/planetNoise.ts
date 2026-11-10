/**
 * The planet prototypes' noise (docs/rendering/planet-prototypes.md): one tileable 64³ RGBA8 volume, sampled on
 * the sphere (no pole pinch, no seam) and in a planet's longitude and latitude (gas giants, rings). Mipmapped, so
 * detail smaller than a pixel averages out instead of shimmering.
 *
 *   R  fbm, 4 octaves (4 to 32 cells a tile)      terrain, continents, the bands' large turbulence
 *   G  fbm, another seed, 3 octaves (6 to 24)    a second field: warps, clouds, detail
 *   B  Worley F1 (7 cells a tile)                craters, lava cells, storm cores
 *   A  Worley F2 - F1 (5 cells a tile)           the cells' edges: cracks, canyons, lineae (a 4³ search: exact;
 *                                                the fine planet shader works the same out per pixel, crackAt)
 *
 * Pure (no DOM, no GL): baked once (about 0.5 s) in the procedural worker, then kept by the asset cache
 * (kind planetNoise3, versioned by PLANET_NOISE_VERSION; with the crack candidates below).
 */

export const PLANET_NOISE_SIZE = 64;
export const PLANET_NOISE_VERSION = 2;

function hash3(x: number, y: number, z: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647 + seed * 144665) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const wrap = (i: number, p: number) => ((i % p) + p) % p;
const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

/** Periodic gradient noise (period p cells), about -0.7..0.7 */
function gradient(x: number, y: number, z: number, p: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  let v = 0;
  const u = fade(fx), w = fade(fy), s = fade(fz);
  for (let c = 0; c < 8; c++) {
    const dx = c & 1, dy = (c >> 1) & 1, dz = (c >> 2) & 1;
    const h = hash3(wrap(ix + dx, p), wrap(iy + dy, p), wrap(iz + dz, p), seed);
    // one of 12 edge directions
    const k = Math.floor(h * 12);
    const g = GRAD[k];
    const d = g[0] * (fx - dx) + g[1] * (fy - dy) + g[2] * (fz - dz);
    v += d * (dx ? u : 1 - u) * (dy ? w : 1 - w) * (dz ? s : 1 - s);
  }
  return v;
}
const GRAD = [[1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0], [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1], [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1]];

/** Periodic Worley: F1 and F2 (in cell units) at a point, `cells` a tile */
function worley(x: number, y: number, z: number, cells: number, seed: number): [number, number] {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  let f1 = 9, f2 = 9;
  for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const cx = ix + dx, cy = iy + dy, cz = iz + dz;
    const wx = wrap(cx, cells), wy = wrap(cy, cells), wz = wrap(cz, cells);
    const px = cx + hash3(wx, wy, wz, seed), py = cy + hash3(wx, wy, wz, seed + 1), pz = cz + hash3(wx, wy, wz, seed + 2);
    const d = Math.hypot(px - x, py - y, pz - z);
    if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
  }
  return [f1, f2];
}

/**
 * Periodic Worley F2 - F1 from a 4³ search about the point (every feature within 1.5 cells), so F2 is right even where
 * the nearest points are sparse (a 3³ search misses it there, and the field jumps along the cells' faces). The planet
 * shader's fine level (planetLook.ts crackAt) is this, line for line.
 */
function worleyEdge(x: number, y: number, z: number, cells: number, seed: number): number {
  const ix = Math.floor(x - 0.5), iy = Math.floor(y - 0.5), iz = Math.floor(z - 0.5);
  let f1 = 81, f2 = 81;
  for (let dz = -1; dz <= 2; dz++) for (let dy = -1; dy <= 2; dy++) for (let dx = -1; dx <= 2; dx++) {
    const cx = ix + dx, cy = iy + dy, cz = iz + dz;
    const wx = wrap(cx, cells), wy = wrap(cy, cells), wz = wrap(cz, cells);
    const px = cx + hash3(wx, wy, wz, seed), py = cy + hash3(wx, wy, wz, seed + 1), pz = cz + hash3(wx, wy, wz, seed + 2);
    const d = (px - x) ** 2 + (py - y) ** 2 + (pz - z) ** 2;
    if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
  }
  return Math.sqrt(f2) - Math.sqrt(f1);
}

/** The volume, RGBA8, x fastest */
export function planetNoiseData(size = PLANET_NOISE_SIZE): Uint8Array {
  const out = new Uint8Array(size * size * size * 4);
  const fbm = (x: number, y: number, z: number, base: number, octaves: number, seed: number) => {
    let v = 0, a = 0.5, norm = 0;
    for (let o = 0; o < octaves; o++) {
      const f = base << o;
      v += a * gradient(x * f, y * f, z * f, f, seed + o * 17);
      norm += a;
      a *= 0.5;
    }
    return v / norm;
  };
  let i = 0;
  for (let z = 0; z < size; z++) for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size, v = y / size, w = z / size;
    const r = fbm(u, v, w, 4, 4, 11);
    const g = fbm(u, v, w, 6, 3, 57);
    const [b1] = worley(u * 7, v * 7, w * 7, 7, 101);
    const edge = worleyEdge(u * 5, v * 5, w * 5, 5, 303);
    out[i++] = clamp255((r * 1.55 + 0.5) * 255);
    out[i++] = clamp255((g * 1.55 + 0.5) * 255);
    out[i++] = clamp255(Math.min(1, b1 / 0.9) * 255);
    out[i++] = clamp255(Math.min(1, edge / 0.6) * 255);
  }
  return out;
}

const clamp255 = (v: number) => Math.max(0, Math.min(255, Math.round(v)));

/**
 * The crack channel's candidates (the planet shader's fine level, planetLook.ts crackAt): for each of 8x8x8 sub-cells
 * of every Worley cell of the A channel (5 cells a tile, so 40³, periodic), the cells (up to 16, nearest first; 4.5
 * on average, more than 16 in one sub-cell in 64000) whose points can be the nearest, or count toward the soft second
 * nearest, anywhere in that sub-cell. The shader then visits just those, not a 4x4x4 search: the same exact field
 * for a tenth of the work. Each is an offset from the sub-cell's own cell, -2..2 each way, as (dx + 2) + 5 (dy + 2)
 * + 25 (dz + 2); 255: no more. RGBA8, 160 x 40 x 40: texel (4x + j, y, z) holds a sub-cell's slots 4j..4j + 3.
 */
export const CRACK_SLOTS = 16;
export const CRACK_CELLS_PER_CELL = 8;
/** How far past the nearest point a point still counts (planetLook.ts: the most a look reads, CRACK_CAP 0.2, in cells, plus 4 K) */
export const CRACK_REACH = 0.2 * 0.6 + 4 * 0.025;
export function planetCrackCells(stats?: { overflow: number; most: number }): Uint8Array {
  const cells = 5, R = CRACK_CELLS_PER_CELL, N = cells * R;
  const out = new Uint8Array(N * N * N * CRACK_SLOTS).fill(255);
  // (each point of the tile once)
  const pt: number[][] = [];
  for (let z = 0; z < cells; z++) for (let y = 0; y < cells; y++) for (let x = 0; x < cells; x++) pt.push([hash3(x, y, z, 303), hash3(x, y, z, 304), hash3(x, y, z, 305)]);
  // A point P counts somewhere in the sub-cell if d(x, P) - F1(x) <= the reach for some x in it; F1(x) <= d(x, P1) (P1
  // the nearest at the centre), so P can be left out where d(x, P) - d(x, P1) is past the reach all over it: checked
  // on a 3x3x3 lattice of the sub-cell, less what it can dip between (the difference moves at most 2 per unit)
  const step = 1 / (2 * R), dip = 2 * (Math.sqrt(3) / 2) * step;
  const near: [number, number, number, number, number][] = [];
  for (let iz = 0; iz < N; iz++) for (let iy = 0; iy < N; iy++) for (let ix = 0; ix < N; ix++) {
    const px = (ix + 0.5) / R, py = (iy + 0.5) / R, pz = (iz + 0.5) / R;
    const cx = Math.floor(px), cy = Math.floor(py), cz = Math.floor(pz);
    near.length = 0;
    for (let dz = -2; dz <= 2; dz++) for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const qx = cx + dx, qy = cy + dy, qz = cz + dz;
      const h = pt[wrap(qx, cells) + cells * (wrap(qy, cells) + cells * wrap(qz, cells))];
      near.push([Math.hypot(qx + h[0] - px, qy + h[1] - py, qz + h[2] - pz), (dx + 2) + 5 * (dy + 2) + 25 * (dz + 2), qx + h[0], qy + h[1], qz + h[2]]);
    }
    near.sort((a, b) => a[0] - b[0]);
    const p1 = near[0];
    const kept: number[] = [];
    for (const q of near) {
      if (q[0] - p1[0] > CRACK_REACH + 2 * (Math.sqrt(3) / 2 / R)) break;
      let lo = Infinity;
      for (let sz = -1; sz <= 1; sz++) for (let sy = -1; sy <= 1; sy++) for (let sx = -1; sx <= 1; sx++) {
        const x = px + sx * step, y = py + sy * step, z = pz + sz * step;
        lo = Math.min(lo, Math.hypot(q[2] - x, q[3] - y, q[4] - z) - Math.hypot(p1[2] - x, p1[3] - y, p1[4] - z));
      }
      if (lo - dip <= CRACK_REACH) kept.push(q[1]);
    }
    if (stats) { if (kept.length > CRACK_SLOTS) stats.overflow++; stats.most = Math.max(stats.most, kept.length); }
    const o = ((iz * N + iy) * N + ix) * CRACK_SLOTS;
    for (let k = 0; k < Math.min(kept.length, CRACK_SLOTS); k++) out[o + k] = kept[k];
  }
  return out;
}
