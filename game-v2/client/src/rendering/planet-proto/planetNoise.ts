/**
 * The planet prototypes' noise (docs/rendering/planet-prototypes.md): one tileable 64³ RGBA8 volume, sampled on
 * the sphere (no pole pinch, no seam) and in a planet's longitude and latitude (gas giants, rings). Mipmapped, so
 * detail smaller than a pixel averages out instead of shimmering.
 *
 *   R  fbm, 4 octaves (4 to 32 cells a tile)      terrain, continents, the bands' large turbulence
 *   G  fbm, another seed, 3 octaves (6 to 24)    a second field: warps, clouds, detail
 *   B  Worley F1 (7 cells a tile)                craters, lava cells, storm cores
 *   A  Worley F2 - F1 (5 cells a tile)           the cells' edges: cracks, canyons, lineae
 *
 * Pure (no DOM, no GL): baked once (about 0.5 s), then kept by the asset cache when adopted
 * (`assetKind('planetNoise3', PLANET_NOISE_VERSION)`, built in proceduralWorker).
 */

export const PLANET_NOISE_SIZE = 64;
export const PLANET_NOISE_VERSION = 1;

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
    const [a1, a2] = worley(u * 5, v * 5, w * 5, 5, 303);
    out[i++] = clamp255((r * 1.55 + 0.5) * 255);
    out[i++] = clamp255((g * 1.55 + 0.5) * 255);
    out[i++] = clamp255(Math.min(1, b1 / 0.9) * 255);
    out[i++] = clamp255(Math.min(1, (a2 - a1) / 0.6) * 255);
  }
  return out;
}

const clamp255 = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
