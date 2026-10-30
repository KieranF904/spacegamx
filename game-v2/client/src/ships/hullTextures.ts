/**
 * The ships' hull atlas (ShipBatch's hull shader reads it): 4×4 tiles of 256²,
 * one tile two cells across, each tileable. Tiles 0-3 by what a part does:
 * plating (seams, rivets, faint brushing), armour (one heavy bevelled plate),
 * machinery (framed vent blocks, their slots glowing on energy parts) and the
 * core (hex tiles, energy along the joints, window strips). Tiles 4-15 are the
 * hull materials' own surfaces, rising in character with grade (materialTile).
 * A fifth row holds the game's own ships' materials (bossTile): Pyreclast
 * glass (faceted volcanic glass, fissures glowing) and crystal (gabled prisms
 * lit from within); then, into a sixth, the Scrap Mother's salvage (scrapTile)
 * and the Brood Mother's carapace (broodTile).
 * Each texel: slope (r, g), cavity (b), own light (a; on the salvage but its
 * crystal, where it's worn through instead: HULL_WEAR). Pure: built in a
 * worker (hullAtlasWorker.ts).
 */

/** A tile's side (texels); the atlas is 4 tiles across and HULL_ROWS down */
export const HULL_TILE = 256;
/** What it makes, by version (assetCache.ts): bump it whenever the output changes */
export const HULL_ATLAS_VERSION = 1;
export const HULL_ROWS = 6;

const N = HULL_TILE;
/** Height, own light (or wear), and a tone of its own (stains, fading: into the cavity channel, whatever the height) */
type Tile = { h: Float32Array; e: Float32Array; k?: Float32Array };
const wrap = (v: number) => ((v % N) + N) % N;
function tile(kind: number): Tile {
  const h = new Float32Array(N * N), e = new Float32Array(N * N);
  let seed = 77 + kind * 991;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const bump = (cx: number, cy: number, r: number, d: number) => {
    for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) { const q = Math.hypot(x, y) / r; if (q < 1) h[wrap(Math.round(cy + y)) * N + wrap(Math.round(cx + x))] += d * (1 - q * q); }
  };
  const groove = (dist: number, w: number) => (dist < w ? -((1 - dist / w) ** 2) : 0);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    let v = 0;
    if (kind === 0) {
      // plating: one broad panel per tile (two cells), a seam round it, a faint sub-seam across
      const pi = 0, pj = 0, di = Math.min(i, N - i), dj = Math.min(j, N - j);
      v = groove(Math.min(di, dj), 4) * 5 + groove(Math.abs(j - 128), 1.5) * 0.8;
      // brushed: fine streaks along each panel, one way or the other (they break the highlight into grain)
      const line = (pi + pj) % 2 ? j : i, hsh = (n: number) => ((Math.sin(n * 12.9898) * 43758.5453) % 1 + 1) % 1;
      v += (hsh(line + pi * 977 + pj * 331) - 0.5) * 0.07 + (hsh(Math.floor(line / 3) + 51) - 0.5) * 0.06;
    } else if (kind === 1) {
      // armour: one heavy plate per tile, its edge bevelled down to a deep seam
      const d = Math.min(i, N - i, j, N - j);
      v = Math.min(1, d / 18) * 6 + groove(d, 5) * 4;
    } else if (kind === 2) {
      // machinery: a framed panel per cell with a block of vent slots
      const li = i % 128, lj = j % 128, d = Math.min(li, 128 - li, lj, 128 - lj);
      v = groove(d, 4) * 4;
      if (li > 24 && li < 104 && lj > 28 && lj < 100) {
        const slot = Math.abs(((lj - 28) % 12) - 6);
        v += groove(slot, 3.2) * 4 - 1;
        // the slots' floors glow (on parts that glow: energy)
        if (slot < 1.8 && li > 30 && li < 98) e[j * N + i] = 1 - slot / 1.8;
      }
    } else if (kind === 3) {
      // core: raised hex tiles; window strips (in the emissive mask)
      const s = 32, x = i / s, y = j / s * 1.1547, r = Math.round(y), xo = x - (r % 2) * 0.5, c = Math.round(xo);
      const dx = (xo - c), dy = (y - r) * 0.866, dh = Math.max(Math.abs(dx) * 0.866 + Math.abs(dy) * 0.5, Math.abs(dy));
      v = Math.min(1, (0.5 - dh) * 8) * 2;
      // energy along the joints between the tiles
      if (dh > 0.44) e[j * N + i] = Math.min(1, (dh - 0.44) / 0.04) * 0.75;
      const li = i % 128, lj = j % 128;
      if (lj > 54 && lj < 74 && li % 22 > 4 && li % 22 < 16) { e[j * N + i] = 1; v -= 1.5; }
    }
    // (a faint grain; not on the hull materials' tiles, whose shine would turn it to sparkle)
    h[j * N + i] += v + (kind < 4 ? (rnd() - 0.5) * 0.12 : 0);
  }
  if (kind === 23) return broodTile(h, e, groove);
  if (kind >= 18) return scrapTile(kind, h, e, bump, groove);
  if (kind >= 16) bossTile(kind, h, e, groove);
  else if (kind >= 4) materialTile(kind, h, e, bump, groove);
  if (kind === 0) for (let k = 0; k < 12; k++) { // rivets along the panel's edges
    const t = 12 + k * 21; bump(t, 11, 2.5, 1.0); bump(t, N - 11, 2.5, 1.0);
  }
  if (kind === 1) for (const [x, y] of [[22, 22], [234, 22], [22, 234], [234, 234], [128, 22], [128, 234]]) bump(x, y, 6, 3);
  return { h, e };
}
/** Tileable value noise: `cells` across the tile */
const hash2 = (a: number, b: number, s: number) => ((Math.sin(a * 127.1 + b * 311.7 + s * 74.7) * 43758.5453) % 1 + 1) % 1;
/** hash2 over a lattice `cx` by `cy`, worked out once (the same numbers, without a sine a texel) */
const lattices = new Map<number, Float64Array>();
function lattice(cx: number, cy: number, seed: number): Float64Array {
  const key = (seed * 1024 + cx) * 1024 + cy;
  let t = lattices.get(key);
  if (!t) { t = new Float64Array(cx * cy); for (let b = 0; b < cy; b++) for (let a = 0; a < cx; a++) t[b * cx + a] = hash2(a, b, seed); lattices.set(key, t); }
  return t;
}
function vnoise(i: number, j: number, cells: number, seed: number): number {
  const x = (i / N) * cells, y = (j / N) * cells, xi = Math.floor(x), yi = Math.floor(y), u = x - xi, v = y - yi, L = lattice(cells, cells, seed);
  const su = u * u * (3 - 2 * u), sv = v * v * (3 - 2 * v), q = (a: number, b: number) => L[(((b % cells) + cells) % cells) * cells + ((a % cells) + cells) % cells];
  return (q(xi, yi) * (1 - su) + q(xi + 1, yi) * su) * (1 - sv) + (q(xi, yi + 1) * (1 - su) + q(xi + 1, yi + 1) * su) * sv;
}
/**
 * The hull materials' own surfaces (tiles 4-15), each its own character, rising with grade:
 * composite weave · steel riveted plates · polymer pillows · titanium brushed panels · ceramic tiles ·
 * sealed gasketed panels · conductive bus lines (they glow) · iridium mirror plates with lead seams ·
 * ferrite rough iron · leestone strata · cobalt fine hex (edges glow) · neutronium heavy plates (seams glow)
 */
function materialTile(kind: number, h: Float32Array, e: Float32Array, bump: (x: number, y: number, r: number, d: number) => void, groove: (d: number, w: number) => number): void {
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const o = j * N + i, li = i % 128, lj = j % 128, d128 = Math.min(li, 128 - li, lj, 128 - lj), dT = Math.min(i, N - i, j, N - j);
    let v = 0;
    if (kind === 4) { // composite: a woven fibre, a seam round the panel
      const alt = (Math.floor(i / 16) + Math.floor(j / 16)) % 2 === 0;
      v = (alt ? Math.sin((Math.PI * (j % 16)) / 16) : Math.sin((Math.PI * (i % 16)) / 16)) * 0.9 + groove(dT, 4) * 3;
    } else if (kind === 5) { // steel: heavy plates, a bevel down to the seam
      v = Math.min(1, d128 / 10) * 3 + groove(d128, 3) * 3;
    } else if (kind === 6) { // polymer: soft rounded pillows
      const q = Math.max(Math.abs((i % 64) - 32), Math.abs((j % 64) - 32)) / 32;
      v = (1 - q ** 4) * 2;
    } else if (kind === 7) { // titanium: one broad panel, brushed along its length
      v = groove(dT, 4) * 3 + groove(Math.abs(j - 128), 1.5) * 1.2 + (vnoise(i, j, 2, 8) - 0.5) * 0.3 + (hash2(Math.floor(j / 2), 3, 7) - 0.5) * 0.05;
    } else if (kind === 8) { // ceramic: small tiles, each a touch proud of the next, fine gaps
      const d = Math.min(i % 32, 32 - (i % 32), j % 32, 32 - (j % 32));
      v = Math.min(1, d / 3) * 1.2 + groove(d, 1.6) * 1.6 + hash2(Math.floor(i / 32), Math.floor(j / 32), 5) * 0.5;
    } else if (kind === 9) { // sealed composite: smooth domed panels, a raised gasket round each
      v = 1.4 * Math.exp(-(((d128 - 7) / 2.5) ** 2)) + 0.9 * (1 - ((li - 64) ** 2 + (lj - 64) ** 2) / 8192) + groove(d128, 2) * 2;
    } else if (kind === 10) { // conductive steel: plates crossed by raised bus lines (which glow, faintly)
      const bus = Math.abs((i % 32) - 16);
      v = groove(d128, 3) * 3 + (bus < 2.5 ? 1 - bus / 2.5 : 0) * 1.5;
      if (bus < 1.6) e[o] = 0.55 * (1 - bus / 1.6);
    } else if (kind === 11) { // leaded iridium: mirror-flat plates, deep dark lead seams
      const d = Math.min(i % 64, 64 - (i % 64), j % 64, 64 - (j % 64));
      v = groove(d, 3) * 4;
    } else if (kind === 12) { // dense ferrite: rough, pitted iron
      v = vnoise(i, j, 8, 1) * 2.2 + vnoise(i, j, 32, 2) * 1.0 + vnoise(i, j, 64, 3) * 0.5 + groove(dT, 4) * 2;
    } else if (kind === 13) { // leestone: dark stone in strata
      v = Math.sin((j / N) * Math.PI * 12 + vnoise(i, j, 4, 4) * 5) * 0.9 + vnoise(i, j, 16, 5) * 1.4 + vnoise(i, j, 64, 6) * 0.4;
    } else if (kind === 14) { // cobalt: a fine raised hex pattern, its edges glowing
      const sc = 16, x = i / sc, y = (j / sc) * 1.1547, r = Math.round(y), xo = x - (((r % 2) + 2) % 2) * 0.5, c = Math.round(xo);
      const dx = xo - c, dy = (y - r) * 0.866, dh = Math.max(Math.abs(dx) * 0.866 + Math.abs(dy) * 0.5, Math.abs(dy));
      v = Math.min(1, (0.5 - dh) * 6) * 1.5 + groove(dT, 4) * 3;
      if (dh > 0.43) e[o] = Math.min(1, (dh - 0.43) / 0.05) * 0.65;
    } else { // neutronium: massive plates, deep seams alive with light, faint ribs
      v = Math.min(1, d128 / 14) * 4 + groove(d128, 5) * 5 + Math.sin((i + j) * 0.09) * 0.25;
      if (d128 < 3.2) e[o] = 1 - d128 / 3.2;
    }
    h[o] += v;
  }
  if (kind === 5) for (let pi = 0; pi < 2; pi++) for (let pj = 0; pj < 2; pj++) for (let k = 0; k < 7; k++) { // steel's rivets
    const t = pi * 128 + 10 + k * 18;
    bump(t, pj * 128 + 8, 2.5, 1.4); bump(t, pj * 128 + 120, 2.5, 1.4); bump(pi * 128 + 8, pj * 128 + 10 + k * 18, 2.5, 1.4); bump(pi * 128 + 120, pj * 128 + 10 + k * 18, 2.5, 1.4);
  }
}
/**
 * Tileable Voronoi (`cells` across): for a texel, the nearest site and the gap
 * to the next nearest (0 on a boundary), and where the nearest site is
 */
function voronoi(i: number, j: number, cells: number, seed: number): { id: number; gap: number; sx: number; sy: number; id2: number } {
  const s = N / cells, ci = Math.floor(i / s), cj = Math.floor(j / s), LX = lattice(cells, cells, seed), LY = lattice(cells, cells, seed + 1);
  let d1 = Infinity, d2 = Infinity, id = 0, id2 = 0, sx = 0, sy = 0;
  for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) {
    const gi = ci + a, gj = cj + b, wi = ((gi % cells) + cells) % cells, wj = ((gj % cells) + cells) % cells;
    const px = (gi + 0.15 + 0.7 * LX[wj * cells + wi]) * s, py = (gj + 0.15 + 0.7 * LY[wj * cells + wi]) * s;
    const d = Math.hypot(i - px, j - py), k = wj * cells + wi;
    if (d < d1) { d2 = d1; id2 = id; d1 = d; id = k; sx = px; sy = py; } else if (d < d2) { d2 = d; id2 = k; }
  }
  return { id, gap: d2 - d1, sx, sy, id2 };
}
/** Pyreclast glass's plates: the tile cut in two, and each half again, and so on (a few levels), each cut its own place */
const PLATES: [number, number, number, number][] = (() => {
  const out: [number, number, number, number][] = [];
  const cut = (x0: number, y0: number, x1: number, y1: number, depth: number, s: number) => {
    const w = x1 - x0, h = y1 - y0;
    if (depth === 0 || (w < 70 && h < 70) || (depth < 3 && hash2(x0, y0, s) < 0.25)) { out.push([x0, y0, x1, y1]); return; }
    const across = w >= h, at = 0.3 + 0.4 * hash2(x1, y1, s + 1), m = Math.round((across ? x0 + w * at : y0 + h * at) / 8) * 8;
    if (across) { cut(x0, y0, m, y1, depth - 1, s + 2); cut(m, y0, x1, y1, depth - 1, s + 3); }
    else { cut(x0, y0, x1, m, depth - 1, s + 4); cut(x0, m, x1, y1, depth - 1, s + 5); }
  };
  cut(0, 0, N, N, 4, 61);
  return out;
})();
/**
 * The game's own ships' materials (tiles 16-19):
 *   16  Pyreclast glass: volcanic glass broken into facets (each cell a tilted
 *       plane, so the light picks each out), fine fractures between, some of
 *       them molten and glowing; a faint flow banding through it all
 *   17  crystal: clusters of gabled prisms (two pitched faces and two ends
 *       each), their cores lit from within
 */
function bossTile(kind: number, h: Float32Array, e: Float32Array, groove: (d: number, w: number) => number): void {
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const o = j * N + i;
    let v = 0;
    if (kind === 16) {
      // engineered: plates of many sizes (the tile cut and cut again, each cut its own place), a seam round each, a bevel in
      const pl = PLATES.find(([x0, y0, x1, y1]) => i >= x0 && i < x1 && j >= y0 && j < y1)!;
      const dp = Math.min(i - pl[0], pl[2] - i, j - pl[1], pl[3] - j), big = (pl[2] - pl[0]) * (pl[3] - pl[1]) > 9000;
      v = Math.min(1, dp / 10) * 0.8 + groove(dp, 2.0) * 1.1;
      // (studs only at the big plates' corners)
      if (big) for (const [sx, sy] of [[pl[0] + 9, pl[1] + 9], [pl[2] - 9, pl[1] + 9], [pl[0] + 9, pl[3] - 9], [pl[2] - 9, pl[3] - 9]]) {
        const q = Math.hypot(i - sx, j - sy) / 3.2; if (q < 1) v += (1 - q * q) * 0.8;
      }
      // natural: a few long fissures of cooled glass wandering across the plates, whatever their seams, their edges crazed
      const c = voronoi(i, j, 3, 31), fine = voronoi(i, j, 9, 33);
      v += groove(c.gap, 2.2) * 2.6;
      if (c.gap < 7) v += groove(fine.gap, 1.1) * 1.3 * (1 - c.gap / 7);
      // the glass's own grain: faint, flowing one way
      v += Math.sin((i * 0.7 + j * 0.3) * 0.08 + vnoise(i, j, 4, 44) * 3) * 0.18;
    } else if (kind === 17) {
      const c = voronoi(i, j, 7, 51), a = Math.PI * 0.25 + (hash2(c.id, 2, 52) - 0.5) * 0.6;
      const ux = Math.cos(a), uy = Math.sin(a), dx = i - c.sx, dy = j - c.sy;
      const along = dx * ux + dy * uy, across = -dx * uy + dy * ux;
      // a gabled prism: pitched faces either side of its ridge, its ends cut back steeper
      v = 14 - Math.abs(across) * 0.55 - Math.abs(along) * 0.28 + groove(c.gap, 1.6) * 3;
      // lit from within along its ridge
      const core = Math.max(0, 1 - Math.abs(across) / 3.2) * Math.max(0, 1 - Math.abs(along) / 18);
      if (hash2(c.id, 8, 53) < 0.7) e[o] = Math.max(e[o], core * (0.55 + 0.45 * hash2(c.id, 9, 54)));
    }
    h[o] += v;
  }
}
/** Tileable value noise stretched: `cx` cells across, `cy` down (streaks, brushing) */
function vnoise2(i: number, j: number, cx: number, cy: number, seed: number): number {
  const x = (i / N) * cx, y = (j / N) * cy, xi = Math.floor(x), yi = Math.floor(y), u = x - xi, v = y - yi, L = lattice(cx, cy, seed);
  const su = u * u * (3 - 2 * u), sv = v * v * (3 - 2 * v), q = (a: number, b: number) => L[(((b % cy) + cy) % cy) * cx + ((a % cx) + cx) % cx];
  return (q(xi, yi) * (1 - su) + q(xi + 1, yi) * su) * (1 - sv) + (q(xi, yi + 1) * (1 - su) + q(xi + 1, yi + 1) * su) * sv;
}
/** Tileable fractal noise, `oct` octaves from `cells` across (0..1, about 0.5) */
function fbm(i: number, j: number, cells: number, seed: number, oct: number): number {
  let s = 0, a = 1, n = 0;
  for (let k = 0; k < oct; k++, a *= 0.5) { s += vnoise(i, j, cells << k, seed + k * 13) * a; n += a; }
  return s / n;
}
/** The shortest way round the tile (so shapes laid on it wrap) */
const wd = (a: number) => a - N * Math.round(a / N);
const smooth = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
/** How far a texel is from a segment (wrapping), and how far along it */
function segment(i: number, j: number, ax: number, ay: number, bx: number, by: number): [number, number] {
  const px = wd(i - ax), py = wd(j - ay), ex = bx - ax, ey = by - ay, ll = ex * ex + ey * ey || 1, t = Math.max(0, Math.min(1, (px * ex + py * ey) / ll));
  return [Math.hypot(px - ex * t, py - ey * t), t * Math.sqrt(ll)];
}
/**
 * The Scrap Mother's salvage (tiles 18-22; each drawn six times larger, each part its own patch of it, turned its own way):
 *   18  scrap iron: weathered gunmetal, hammered (dents overlapping), patched plates welded on (a rippled bead round
 *       each), a long weld across, pitting in clusters; rust in the pits and along the welds
 *   19  scrap rust: rust gone to scale, flakes lifting at their cracks, blooms blistering up bright orange, streaks
 *       running from them the length of the plate
 *   20  scrap paint: faded green plate, orange-peel smooth, chipped through to the metal (the paint's edge stands
 *       proud of it), scratched, rivet rows under the paint; patches faded chalky
 *   21  scrap steel: worked steel, brushed one way, oil-canned a little, polished arcs where things have scraped it,
 *       dings; grime and heat tint in patches
 *   22  greyseam: crystal in facets, each cell a plane tilted its own way, finer facets within; veins of light along
 *       some of the cracks, a faint light deep in some facets
 * Own light (e) on 18-21 is where it's worn through (the shader takes the colour there towards HULL_WEAR's);
 * tone (k) stains it, whatever the height
 */
function scrapTile(kind: number, h: Float32Array, e: Float32Array, bump: (x: number, y: number, r: number, d: number) => void, groove: (d: number, w: number) => number): Tile {
  const k = new Float32Array(N * N);
  let seed = 4099 + kind * 557;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  if (kind === 18) {
    // patched plates welded on: each turned a little, a bead round it
    const patches = Array.from({ length: 4 }, () => ({ x: rnd() * N, y: rnd() * N, w: 22 + rnd() * 30, hh: 16 + rnd() * 26, a: (rnd() - 0.5) * 0.5 }));
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const o = j * N + i;
      let v = (fbm(i, j, 4, 73, 3) - 0.5) * 3;
      let weld = 0;
      for (const p of patches) {
        const dx = wd(i - p.x), dy = wd(j - p.y), ca = Math.cos(p.a), sa = Math.sin(p.a), u = dx * ca + dy * sa, w = -dx * sa + dy * ca;
        const dr = Math.min(p.w - Math.abs(u), p.hh - Math.abs(w));
        if (dr > 0) v += Math.min(1, dr / 3) * 1.6;
        // the bead: rippled along its length (the welder's strokes)
        const bd = Math.abs(dr - 1);
        if (bd < 3.2) { const along = Math.abs(u) > p.w - 2 ? w : u; v += (1 - (bd / 3.2) ** 2) * 2.2 * (0.85 + 0.15 * Math.sin(along * 1.25)); }
        weld = Math.max(weld, 1 - Math.abs(dr) / 9);
      }
      // a long weld across the tile, wandering
      const wl = Math.abs(j - 186 - 7 * Math.sin((i / N) * Math.PI * 4) - 3 * Math.sin((i / N) * Math.PI * 10));
      if (wl < 3) v += (1 - (wl / 3) ** 2) * 2.4 * (0.7 + 0.3 * Math.sin(i * 1.3));
      weld = Math.max(weld, 1 - wl / 10);
      // pitting, in clusters
      const pitted = smooth(0.45, 0.68, fbm(i, j, 4, 74, 3)), pc = voronoi(i, j, 26, 75), pr = 2 + 2.2 * hash2(pc.id, 3, 76);
      const pd = Math.hypot(i - pc.sx, j - pc.sy);
      if (pd < pr && hash2(pc.id, 4, 77) < 0.02 + 0.7 * pitted * pitted) v -= (1 - (pd / pr) ** 2) * 2.2;
      h[o] += v;
      // rust where it's pitted and along the welds
      const rust = smooth(0.55, 0.85, fbm(i, j, 8, 78, 3) * 0.5 + pitted * 0.38 + Math.max(0, weld) * 0.3);
      e[o] = rust * 0.8;
      k[o] = (fbm(i, j, 3, 79, 3) - 0.5) * 0.5 - rust * 0.3;
    }
    // hammered: dents, overlapping, each its own size and depth
    for (let n = 0; n < 60; n++) {
      // (each easing in from its rim: a dent, not a crater)
      const cx = rnd() * N, cy = rnd() * N, r = 8 + rnd() * 16, d = 0.8 + rnd() * 1.6;
      for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) { const q = (x * x + y * y) / (r * r); if (q < 1) h[wrap(Math.round(cy + y)) * N + wrap(Math.round(cx + x))] -= d * (1 - q) * (1 - q); }
    }
  } else if (kind === 19) {
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const o = j * N + i;
      // rough, gone to scale: flakes, each a little proud, cracked apart, lifting at their edges
      const f = voronoi(i, j, 16, 81);
      let v = (fbm(i, j, 6, 82, 4) - 0.5) * 4.5 + hash2(f.id, 1, 83) * 0.7 + groove(f.gap, 1.2) * 0.8 + Math.max(0, 1 - f.gap / 4) * 0.3;
      // blooms: blisters, clustered, bright fresh rust round them
      const b = voronoi(i, j, 7, 84), bs = N / 7, br = bs * (0.18 + 0.2 * hash2(b.id, 2, 85)), bd = Math.hypot(i - b.sx, j - b.sy), live = hash2(b.id, 3, 86) < 0.32;
      let bloom = 0;
      if (live) {
        if (bd < br) v += (1 - (bd / br) ** 2) ** 1.5 * 4;
        bloom = Math.max(0, 1 - bd / (br * 2.2));
        // small blisters about the big one
        const sb = voronoi(i, j, 30, 87), sd = Math.hypot(i - sb.sx, j - sb.sy), sr = 1.8 + 1.6 * hash2(sb.id, 4, 88);
        if (sd < sr && hash2(sb.id, 5, 89) < bloom * 1.6) v += (1 - (sd / sr) ** 2) * 1.6;
      }
      // streaks: the length of the plate (down the tile), from the blooms and on their own
      // (each streak running a way and fading out, not the whole length of the plate)
      const st = 0.5 + (vnoise2(i, j, 28, 3, 90) * 0.6 + vnoise2(i, j, 64, 5, 91) * 0.4 - 0.5) * smooth(0.35, 0.75, vnoise2(i, j, 5, 6, 95)) * 1.5, below = live ? Math.max(0, 1 - Math.abs(wd(i - b.sx)) / (br * 1.3)) * smooth(-br, br * 4, wd(j - b.sy)) : 0;
      v += (st - 0.5) * 0.8;
      h[o] += v;
      const rag = fbm(i, j, 12, 94, 3);
      e[o] = Math.min(1, smooth(0.3, 0.9, bloom * (0.6 + rag * 0.8)) * 0.85 + below * smooth(0.5, 0.75, st) * 0.55 + smooth(0.66, 0.82, fbm(i, j, 5, 92, 3)) * 0.3);
      k[o] = (st - 0.5) * 0.8 - below * 0.15 + (fbm(i, j, 3, 93, 2) - 0.5) * 0.35;
    }
  } else if (kind === 20) {
    // scratches through the paint, a few long, most short
    const scratches = Array.from({ length: 16 }, (_, n) => { const x = rnd() * N, y = rnd() * N, a = rnd() * Math.PI, l = (n < 4 ? 70 : 18) + rnd() * 40; return [x, y, x + Math.cos(a) * l, y + Math.sin(a) * l]; });
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const o = j * N + i;
      // the paint chipped through: where a warped noise peaks (more of it towards its own patches of wear), small flecks too
      const wx = fbm(i, j, 4, 101, 2) * 40, w = fbm(wrap(i + wx), wrap(j - wx), 6, 102, 4), worn = fbm(i, j, 2, 103, 2);
      let chip = smooth(0.7, 0.72, w + (worn - 0.5) * 0.3);
      const fl = voronoi(i, j, 22, 104), fd = Math.hypot(i - fl.sx, j - fl.sy), fr = 1.8 + 2.5 * hash2(fl.id, 1, 105);
      if (hash2(fl.id, 2, 106) < 0.02 + worn * 0.14) chip = Math.max(chip, smooth(fr, fr - 0.8, fd));
      let scr = 0;
      for (const [ax, ay, bx, by] of scratches) {
        // (most are nowhere near: by their bounds first)
        const mx = wd(i - (ax + bx) / 2), my = wd(j - (ay + by) / 2);
        if (Math.abs(mx) > Math.abs(bx - ax) / 2 + 2 || Math.abs(my) > Math.abs(by - ay) / 2 + 2) continue;
        const [d] = segment(i, j, ax, ay, bx, by); if (d < 1.4) scr = Math.max(scr, 1 - d / 1.4);
      }
      chip = Math.max(chip, scr * 0.9);
      // the paint: orange-peel smooth, a little proud of the metal; the metal under it rough
      let v = (fbm(i, j, 16, 107, 2) - 0.5) * 0.5 + (fbm(i, j, 3, 108, 2) - 0.5) * 2.4 + (1 - chip) * 1.5 + chip * (fbm(i, j, 24, 109, 2) - 0.5) * 1.4;
      // rivet rows, under the paint
      for (const ry of [36, 164]) { const dy = Math.abs(wd(j - ry)), dx = Math.abs(((i + 8) % 24) - 12); const q = Math.hypot(dx, dy) / 3.4; if (q < 1) v += (1 - q * q) * 1.6; }
      h[o] += v;
      e[o] = chip;
      // faded: chalky in patches, the paint lighter at a chip's edge (worn thin), grime along the length
      const edge = smooth(0.0, 0.5, chip) * (1 - smooth(0.6, 1, chip));
      k[o] = smooth(0.5, 0.75, fbm(i, j, 3, 110, 3)) * 0.3 * (1 - chip) + edge * 0.3 - (vnoise2(i, j, 24, 2, 111) - 0.5) * 0.3 - chip * 0.1;
    }
  } else if (kind === 21) {
    // dings, and arcs polished where things have scraped across it
    const dings = Array.from({ length: 14 }, () => [rnd() * N, rnd() * N, 3 + rnd() * 5, 0.8 + rnd() * 1.4]);
    const arcs = Array.from({ length: 5 }, () => [rnd() * N, rnd() * N, 40 + rnd() * 70, rnd() * Math.PI * 2, 0.6 + rnd() * 1.2]);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const o = j * N + i;
      // brushed along its length, oil-canned a little
      const br = vnoise2(i, j, 3, 90, 121) * 0.6 + vnoise2(i, j, 8, 48, 122) * 0.4;
      let v = (br - 0.5) * 1.1 + (fbm(i, j, 2, 123, 3) - 0.5) * 4;
      let pol = 0;
      for (const [cx, cy, r, a0, span] of arcs) {
        const dx = wd(i - cx), dy = wd(j - cy), ring = 1 - Math.abs(Math.hypot(dx, dy) - r) / 2.2;
        if (ring <= 0) continue;
        const da = Math.abs(((Math.atan2(dy, dx) - a0 + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
        if (da < span) pol = Math.max(pol, ring * (1 - da / span));
      }
      v -= pol * 0.6;
      h[o] += v;
      const grime = smooth(0.5, 0.66, fbm(i, j, 3, 124, 4));
      e[o] = grime * 0.8;
      k[o] = (br - 0.5) * 0.35 + pol * 0.35 - grime * 0.05;
    }
    for (const [x, y, r, d] of dings) bump(x, y, Math.round(r), -d);
  } else if (kind === 22) {
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const o = j * N + i, c = voronoi(i, j, 6, 131), f = voronoi(i, j, 15, 132);
      // each facet a plane of its own, tilted its own way; finer facets cut into it
      const ga = hash2(c.id, 1, 133) * Math.PI * 2, gk = 0.12 + 0.2 * hash2(c.id, 2, 134), fa = hash2(f.id, 1, 135) * Math.PI * 2;
      let v = hash2(c.id, 3, 136) * 4 + ((i - c.sx) * Math.cos(ga) + (j - c.sy) * Math.sin(ga)) * gk;
      v += ((i - f.sx) * Math.cos(fa) + (j - f.sy) * Math.sin(fa)) * 0.07 + groove(f.gap, 1) * 0.6 + groove(c.gap, 1.8) * 2.6;
      h[o] += v;
      // veins of light along some cracks, a faint light deep in some facets
      const vein = hash2(Math.min(c.id, c.id2), Math.max(c.id, c.id2), 137) < 0.45 ? Math.max(0, 1 - c.gap / 2.2) : 0;
      const deep = hash2(c.id, 4, 138) < 0.5 ? Math.max(0, 1 - Math.hypot(i - c.sx, j - c.sy) / (N / 6 * 0.55)) * 0.45 : 0;
      e[o] = Math.min(1, vein + deep);
      k[o] = (hash2(f.id, 5, 139) - 0.5) * 0.3;
    }
  }
  return { h, e, k };
}
/**
 * The Brood Mother's carapace (tile 23; drawn six times larger, each part its own patch, turned its own way): shell
 * grown in scales, each a dome tipped its own way (its lip proud of the next, as shingles lie), faint growth ridges
 * round it, a grain of frost over all; rime pale in the seams. Own light down some seams, and in a pit in some scales
 */
function broodTile(h: Float32Array, e: Float32Array, groove: (d: number, w: number) => number): Tile {
  const k = new Float32Array(N * N), R = (N / 5) * 0.75;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const o = j * N + i, c = voronoi(i, j, 5, 211), dx = i - c.sx, dy = j - c.sy, d = Math.hypot(dx, dy);
    // a dome, tipped one way, its edge falling into the seam
    const rim = Math.min(1, c.gap / 14), tilt = hash2(c.id, 1, 212) * Math.PI * 2;
    let v = Math.sqrt(rim) * 2.4 - (d / R) * 0.9 + ((dx * Math.cos(tilt) + dy * Math.sin(tilt)) / R) * 0.9 + groove(c.gap, 2.4) * 2.2;
    v += Math.sin(d * 0.55 + hash2(c.id, 2, 213) * 6) * 0.14 * rim;
    v += (fbm(i, j, 16, 214, 2) - 0.5) * 0.5;
    // (a pit, its light deep in it)
    const px = c.sx + (hash2(c.id, 3, 216) - 0.5) * R * 0.6, py = c.sy + (hash2(c.id, 4, 217) - 0.5) * R * 0.6;
    const pit = hash2(c.id, 5, 218) < 0.45 ? Math.max(0, 1 - Math.hypot(i - px, j - py) / 4.5) : 0;
    h[o] += v - pit * 1.5;
    const seam = hash2(Math.min(c.id, c.id2), Math.max(c.id, c.id2), 215) < 0.3 ? Math.max(0, 1 - c.gap / 2.6) * 0.85 : 0;
    e[o] = Math.min(1, seam + pit);
    k[o] = Math.max(0, 1 - c.gap / 7) * 0.35 * fbm(i, j, 8, 219, 2) + (hash2(c.id, 6, 220) - 0.5) * 0.22;
  }
  return { h, e, k };
}
/** The whole atlas: 4 × HULL_ROWS tiles of 256², RGBA (slope r, g; cavity b; own light a) */
export function buildHullAtlas(): Uint8Array {
  const data = new Uint8Array(N * 4 * N * HULL_ROWS * 4);
  // (each texel's wrapped neighbours, by offset: W[d + 6] at i + d)
  const W = Array.from({ length: 13 }, (_, d) => Int32Array.from({ length: N }, (_, i) => wrap(i + d - 6)));
  for (let k = 0; k < 4 * HULL_ROWS; k++) {
    const { h, e, k: tone } = tile(k), ox = (k % 4) * N, oy = Math.floor(k / 4) * N;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      let blur = 0;
      for (let a = 0; a <= 12; a += 3) { const x = W[a][i]; for (let b = 0; b <= 12; b += 3) blur += h[W[b][j] * N + x]; }
      const c = j * N + i, xl = W[5][i], xr = W[7][i], yu = W[5][j] * N, yd = W[7][j] * N;
      const sx = (h[j * N + xr] - h[j * N + xl]) * 0.35, sy = (h[yd + i] - h[yu + i]) * 0.35, cv = (h[c] - blur / 25) * 0.25 + (tone ? tone[c] : 0);
      const o = ((oy + j) * N * 4 + ox + i) * 4, q = (v: number) => Math.round((0.5 + 0.5 * Math.tanh(v)) * 255);
      data[o] = q(-sx); data[o + 1] = q(-sy); data[o + 2] = q(cv); data[o + 3] = Math.round(e[j * N + i] * 255);
    }
  }
  return data;
}
