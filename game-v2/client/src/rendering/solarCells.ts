/**
 * Solar cells, one look wherever they're drawn: the stations' arrays (stationTextures.ts tile SOLAR2, the solar kind in
 * StationMaterials.ts) and a ship's own solar panels (hullTextures.ts tile SOLAR_HULL_TILE, a bespoke piece's
 * `surface: 'solar'`, drawn in ShipBatch's hull shader). Plain data and GLSL strings, no Pixi, so the texture workers and
 * the native renderer (scripts/native-render/scene.ts) can read it too.
 */

/** The ship hull atlas's tile for solar cells (the seventh row's first) */
export const SOLAR_HULL_TILE = 24;

/** The shaders' constants (GLSL): the hull tile's number, the cells' navy-violet, the silver of their bus lines and frame, the navy floor an array facing away still shows, its broad sheen's blue-white and its shininess */
export const SOLAR = {
  tile: `${SOLAR_HULL_TILE}`,
  cell: 'vec3(0.13, 0.15, 0.42)',
  bus: 'vec3(0.36, 0.39, 0.45)',
  floor: 'vec3(0.025, 0.035, 0.1)',
  sheen: 'vec3(0.42, 0.6, 1.0)',
  shin: '7.0',
} as const;
/** The cells' colour as a number (a ship's solar part is built in it: hullBuild.ts) */
export const SOLAR_CELL_HEX = 0x21266b;
/** What's laid over a ship's solar panel (its frame, its boom) by default: the stations' frame grey (stationBake LOOK_COLORS.FRAME_C) */
export const SOLAR_FRAME_HEX = 0x8a96a6;

const groove = (dist: number, w: number) => (dist < w ? -((1 - dist / w) ** 2) : 0);
const sm = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/**
 * One texel of a 256² tile of photovoltaic cells: 32 px (8×8 to a tile) with a hairline gap, two thin silver bus lines
 * across each and a fine finger line along, a heavier frame every 4×4 cells; a crystalline speckle (blocks of 3 px) in
 * the relief. `v`: its height; `e`: the mask of silver (bus lines, fingers, frame)
 */
export function solarCellTexel(i: number, j: number): { v: number; e: number } {
  const li = i % 32, lj = j % 32, d = Math.min(li, 32 - li, lj, 32 - lj), fd = Math.min(i % 128, 128 - (i % 128), j % 128, 128 - (j % 128));
  let q = ((Math.floor(i / 3) * 73856093) ^ (Math.floor(j / 3) * 19349663)) >>> 0; q = Math.imul(q ^ (q >>> 13), 1274126177) >>> 0;
  let v = groove(d, 1.5) * 1.6 + groove(fd, 3) * 2.5 + ((q / 4294967296) - 0.5) * 0.5;
  const bus = Math.max(1 - sm(0.4, 1.2, Math.abs(li - 10.5)), 1 - sm(0.4, 1.2, Math.abs(li - 21.5))) * (d > 1.5 ? 1 : 0);
  const finger = (1 - sm(0.2, 0.7, Math.abs(lj - 16))) * 0.45 * (d > 1.5 ? 1 : 0);
  const frame = 1 - sm(1.5, 2.6, fd);
  v += frame * 0.8 + bus * 0.3;
  return { v, e: Math.min(1, Math.max(bus * 0.75, finger, frame)) };
}
