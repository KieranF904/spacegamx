/**
 * The stations' hull panel atlas: 4×3 tiles of STATION_TILE² (11 used), each
 * a height field turned into first-order normal-map data:
 *   r, g  the slope across and along (0.5 flat)
 *   b     cavity: the height against its blurred surroundings (0.5 level)
 *   a     an emissive or paint mask (windows, vent slots, solar bus lines,
 *         hex joints, hazard stripes)
 * Plain data with no Pixi in it, so the procedural worker can build it
 * (procedural.ts asks; StationMaterials.ts makes the texture).
 */

import { solarCellTexel } from '../solarCells';

export const STATION_TILE = 256;
/** What it makes, by version (assetCache.ts): bump it whenever the output changes */
export const STATION_ATLAS_VERSION = 1;
export const STATION_ATLAS_W = STATION_TILE * 4;
export const STATION_ATLAS_H = STATION_TILE * 3;

/** The tiles, in atlas order (4 to a row) */
export const TILE = { PLATE: 0, ARMOUR: 1, MACH: 2, WIN2: 3, WIN1: 4, SOLAR: 5, HAZARD: 6, SMOOTH: 7, HEX: 8, SOLAR2: 9, GRAIN: 10 } as const;
const TILES = 11;

const N = STATION_TILE;
const wrap = (v: number) => ((v % N) + N) % N;

function tile(kind: number): { h: Float32Array; e: Float32Array } {
  const h = new Float32Array(N * N), e = new Float32Array(N * N);
  let seed = 31 + kind * 977;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const bump = (cx: number, cy: number, r: number, d: number) => {
    for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) { const q = Math.hypot(x, y) / r; if (q < 1) h[wrap(Math.round(cy + y)) * N + wrap(Math.round(cx + x))] += d * (1 - q * q); }
  };
  const groove = (dist: number, w: number) => (dist < w ? -((1 - dist / w) ** 2) : 0);
  const sm = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    let v = 0;
    if (kind === TILE.PLATE || kind === TILE.GRAIN) {
      // panels: two by two per tile, staggered rows, a sub-seam across alternate panels
      const row = Math.floor(j / 128), ii = (i + row * 64) % N, pi = Math.floor(ii / 128);
      const di = Math.min(ii % 128, 128 - (ii % 128)), dj = Math.min(j % 128, 128 - (j % 128));
      v = ((pi * 7 + row * 13) % 5) * 0.22 + groove(Math.min(di, dj), 4) * 5;
      if ((pi + row) % 2) v += groove(Math.abs((ii % 128) - 64), 2) * 2;
      // brushed: faint streaks along u, each row of texels its own, broken up slowly along it
      if (kind === TILE.GRAIN) { let q = (j * 2654435761) >>> 0; q = Math.imul(q ^ (q >>> 15), 2246822519) >>> 0; v += ((q / 4294967296) - 0.5) * 0.35 * (0.6 + 0.4 * Math.sin(i * 0.07 + j * 0.9)); }
    } else if (kind === TILE.ARMOUR) {
      // heavy plates, four to a tile, bevelled down to deep seams, each a touch proud of the last
      const li = i % 128, lj = j % 128, d = Math.min(li, 128 - li, lj, 128 - lj);
      v = Math.min(1, d / 14) * 5 + groove(d, 4) * 4 + ((Math.floor(i / 128) + Math.floor(j / 128) * 3) % 3) * 0.5;
    } else if (kind === TILE.MACH) {
      const li = i % 128, lj = j % 128, d = Math.min(li, 128 - li, lj, 128 - lj);
      v = groove(d, 4) * 4;
      if (li > 24 && li < 104 && lj > 28 && lj < 100) {
        const q = Math.abs(((lj - 28) % 12) - 6);
        v += groove(q, 3.2) * 4 - 1;
        // the vent slots (what glows, on a vented part)
        if (li > 30 && li < 98) e[j * N + i] = Math.max(0, 1 - q / 2.4) * sm(30, 36, li) * (1 - sm(92, 98, li));
      }
    } else if (kind === TILE.WIN2 || kind === TILE.WIN1) {
      // hull with seams running along u; a recessed band (two for WIN2) of windows, eight to a tile, some dark
      const bands = kind === TILE.WIN2 ? [[0.225, 0.275], [0.725, 0.775]] : [[0.45, 0.55]];
      const fv = (j + 0.5) / N;
      v = groove(Math.min(i % 64, 64 - (i % 64)), 3) * 3;
      v += groove(Math.min(j, N - j), 4) * 2;
      for (const [b0, b1] of bands) {
        const inb = sm(b0 - 0.012, b0, fv) * (1 - sm(b1, b1 + 0.012, fv));
        v -= inb * 1.4 + groove(Math.min(Math.abs(fv - b0), Math.abs(fv - b1)) * N, 2.5) * 1.5;
        const slot = Math.floor(i / 32), li = (i % 32) + 0.5, lit = [1, 1, 0, 1, 1, 1, 0, 1][slot];
        const wx = sm(7, 9.5, li) * (1 - sm(22.5, 25, li));
        const wy = sm(b0 + 0.004, b0 + 0.012, fv) * (1 - sm(b1 - 0.012, b1 - 0.004, fv));
        e[j * N + i] = Math.max(e[j * N + i], wx * wy * (lit ? 0.85 + 0.15 * ((slot * 5) % 3) / 2 : 0.06));
      }
    } else if (kind === TILE.SOLAR) {
      // solar cells: a fine grid, the cells faintly domed
      const li = i % 32, lj = j % 32, d = Math.min(li, 32 - li, lj, 32 - lj);
      v = groove(d, 2) * 2.5 + Math.min(1, d / 6) * 0.4 + groove(Math.min(i % 128, 128 - (i % 128), j % 128, 128 - (j % 128)), 3) * 2;
    } else if (kind === TILE.SOLAR2) {
      // photovoltaic cells (solarCells.ts: the ships' solar panels share them)
      const c = solarCellTexel(i, j);
      v = c.v; e[j * N + i] = c.e;
    } else if (kind === TILE.HEX) {
      // power core: raised hex tiles, energy along the joints (in the alpha)
      const x = i / 32, y = (j / N) * 8, r = Math.round(y), xo = x - (r % 2) * 0.5, c = Math.round(xo);
      const dx = (xo - c), dy = (y - r) * 0.866, dh = Math.max(Math.abs(dx) * 0.866 + Math.abs(dy) * 0.5, Math.abs(dy));
      v = Math.min(1, (0.5 - dh) * 8) * 2;
      e[j * N + i] = Math.max(0, 1 - (0.5 - dh) * 16);
    } else if (kind === TILE.HAZARD) {
      // diagonal stripes (paint, in the alpha) over a ribbed girder
      const s = ((i + j) % 64) / 64;
      e[j * N + i] = sm(0.46, 0.5, s) * (1 - sm(0.96, 1, s));
      v = groove(Math.min(j % 128, 128 - (j % 128)), 4) * 3 + groove(Math.min(i % 64, 64 - (i % 64)), 2) * 1.5;
    } else {
      // smooth: long faint seams, a little waviness
      v = groove(Math.min(i % 128, 128 - (i % 128)), 2) * 1.2 + Math.sin(i * 0.05 + j * 0.03) * 0.15;
    }
    h[j * N + i] += v + (rnd() - 0.5) * 0.1;
  }
  if (kind === TILE.PLATE) for (let row = 0; row < 2; row++) for (let p = 0; p < 2; p++) for (let k = 0; k < 6; k++) {
    const t = 14 + k * 20, x0 = p * 128 - row * 64;
    bump(x0 + t, row * 128 + 9, 2.5, 1.5); bump(x0 + t, row * 128 + 119, 2.5, 1.5);
  }
  if (kind === TILE.ARMOUR) for (let p = 0; p < 4; p++) for (const [x, y] of [[16, 16], [112, 16], [16, 112], [112, 112]]) bump((p % 2) * 128 + x, Math.floor(p / 2) * 128 + y, 5, 2.5);
  return { h, e };
}

/** The atlas, RGBA, STATION_ATLAS_W × STATION_ATLAS_H */
export function buildStationAtlas(): Uint8Array {
  const TW = STATION_ATLAS_W, TH = STATION_ATLAS_H, data = new Uint8Array(TW * TH * 4);
  const q = (v: number) => Math.round((0.5 + 0.5 * Math.tanh(v)) * 255);
  for (let k = 0; k < TILES; k++) {
    const { h, e } = tile(k), ox = (k % 4) * N, oy = Math.floor(k / 4) * N;
    const at = (i: number, j: number) => h[wrap(j) * N + wrap(i)];
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      let blur = 0, n = 0;
      for (let a = -6; a <= 6; a += 3) for (let b = -6; b <= 6; b += 3) { blur += at(i + a, j + b); n++; }
      const sx = (at(i + 1, j) - at(i - 1, j)) * 0.35, sy = (at(i, j + 1) - at(i, j - 1)) * 0.35, cv = (at(i, j) - blur / n) * 0.25;
      const o = ((oy + j) * TW + ox + i) * 4;
      data[o] = q(-sx); data[o + 1] = q(-sy); data[o + 2] = q(cv); data[o + 3] = Math.round(Math.min(1, e[j * N + i]) * 255);
    }
  }
  return data;
}
