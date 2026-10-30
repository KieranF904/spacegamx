/**
 * How an asteroid looks, from its composition: the rock tinted by its main
 * ore, hard rock darker with a brighter rim, its surface what it's made of
 * (rocks/RockMaterials.ts: stone, metal, ice, crystal, tar or leestone, with
 * greyseam veins in about one in three), and gem seams as glowing veins that
 * pulse (so a miner can spot them). The rock is lit geometry (drawn in batches
 * by AsteroidBatch), with a lighter version for far off; the seams glow on
 * their own.
 */

import { Container, Graphics } from 'pixi.js';
import { Composition, getAsteroidPolygon, hashString, mulberry32 } from '@space-game/common';
import { RockGeometry } from './rocks/RockGeometry';
import { rockMaterial } from './rocks/RockMaterials';
import { ROCK_MATERIALS } from './rocks/rockTextures';
import itemsData from '../../../data/items.json';
import miningData from '../../../data/mining.json';

/** Rock tints, tuned by hand; any other ore is its item colour, dulled to stone */
const ORE_COLOR: Record<string, number> = {
  iron_ore: 0x8a6a52, nickel_ore: 0x8b9096, silicate: 0x9c8f7a, ice: 0x9cc8dc, copper_ore: 0xa86a3c,
  titanium_ore: 0x9aa6b0, cobalt_ore: 0x4c5a9a, crystal: 0x5fb8c4, helium3: 0xa39a63,
};
for (const i of (itemsData as unknown as { items: { id: string; color: string; family?: string }[] }).items) {
  if (i.family && ORE_COLOR[i.id] === undefined) ORE_COLOR[i.id] = mix(parseInt(i.color.slice(1), 16), 0x6b6b6b, 0.35);
}
/** Rock types that are gas, not rock (mining.json gas) */
export const GAS_TYPES = new Set(Object.entries((miningData as unknown as { types: Record<string, { gas?: boolean }> }).types).filter(([, t]) => t.gas).map(([id]) => id));
const GEM_COLOR: Record<string, number> = { ruby: 0xff3355, sapphire: 0x3d7bff, emerald: 0x2ee59d, void_opal: 0xc28bff };

function mix(a: number, b: number, t: number): number {
  const r = ((a >> 16) & 255) * (1 - t) + ((b >> 16) & 255) * t;
  const g = ((a >> 8) & 255) * (1 - t) + ((b >> 8) & 255) * t;
  const bl = (a & 255) * (1 - t) + (b & 255) * t;
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(bl);
}

export interface AsteroidSeams {
  glow: Graphics;
  color: number;
  phase: number;
}

/**
 * How smoothly a rock's facets blend into each other (0 crisp … 1 smooth):
 * crystal is cut glass, ice nearly so, hard rock and metal have edges, and
 * loose stony rock is rounded. Mixed rocks blend by their ore weights.
 */
const ORE_SMOOTHING: Record<string, number> = {
  crystal: 0, ice: 0.2, titanium_ore: 0.35, cobalt_ore: 0.35, nickel_ore: 0.5, iron_ore: 0.55,
  copper_ore: 0.6, helium3: 0.7, silicate: 0.85,
};
/** Some kinds of asteroid have a character whatever their ore mix */
const TYPE_SMOOTHING: Record<string, number> = { asteroid_crystal: 0.05, asteroid_ice: 0.2, comet: 0.3 };

export function rockSmoothing(comp?: Composition): number {
  if (!comp) return 0.65;
  let s = 0, w = 0;
  for (const [ore, k] of Object.entries(comp.ores)) { s += (ORE_SMOOTHING[ore] ?? 0.65) * k; w += k; }
  let v = w > 0 ? s / w : 0.65;
  // The main ore sets the character more than its share
  v = v * 0.5 + (ORE_SMOOTHING[comp.primary] ?? v) * 0.5;
  // Hard rock is sharper; a gem seam cuts it further
  if (comp.hardness >= 2) v *= 0.7;
  if (comp.seam) v *= 0.8;
  const t = TYPE_SMOOTHING[comp.type];
  if (t !== undefined) v = Math.min(v, t);
  return Math.max(0, Math.min(1, v));
}

/** Rock types that never carry greyseam */
const NO_GREYSEAM = new Set(['asteroid_ice', 'comet']);

/**
 * An asteroid's rock: both its meshes (RockGeometry), the full one and a light
 * one for when it's small on screen (no crater bowls, smooth, a few vertices),
 * and its size (how big it is on screen picks between them)
 */
export interface AsteroidRock {
  geometry: RockGeometry;
  size: number;
}

/**
 * The rock's shape (as LitGeometry.shapedRock's, point for point): a centre
 * (nudged off the middle, highest), an inner ring between each pair of rim
 * points, and the rim, each with a height; triangles centre-inner, inner-rim.
 * Each point's own normal (the average of its facets'), and its place on the
 * surface: how far it is from the centre over the surface (u, v), so the
 * relief runs over the rock's shape rather than straight across it.
 */
type RockPoint = { x: number; y: number; z: number; rim: boolean; s: number[]; avg: number[] };
type RockTri = [RockPoint, RockPoint, RockPoint];

function rockShape(outline: { x: number; y: number }[], jitter: () => number) {
  const n = outline.length;
  let size = 0;
  for (const p of outline) size = Math.max(size, Math.hypot(p.x, p.y));
  type P = RockPoint;
  const point = (x: number, y: number, z: number, rim: boolean): P => ({ x, y, z, rim, s: [0, 0, 0], avg: [0, 0, 0] });
  const centre = point((jitter() - 0.5) * size * 0.2, (jitter() - 0.5) * size * 0.2, size * (0.75 + jitter() * 0.3), false);
  const inner: P[] = [];
  for (let i = 0; i < n; i++) {
    const p = outline[i], q = outline[(i + 1) % n], t = 0.42 + jitter() * 0.22;
    inner.push(point(((p.x + q.x) / 2) * t + centre.x * (1 - t), ((p.y + q.y) / 2) * t + centre.y * (1 - t), size * (0.45 + jitter() * 0.35), false));
  }
  const rim = outline.map((p) => point(p.x, p.y, size * jitter() * 0.12, true));
  const d3 = (a: P, b: P) => Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  const along = (p: P, len: number) => { const dx = p.x - centre.x, dy = p.y - centre.y, l = Math.hypot(dx, dy) || 1; return [(dx / l) * len, (dy / l) * len, p.z / size]; };
  centre.s = [0, 0, centre.z / size];
  inner.forEach((p) => { p.s = along(p, d3(centre, p)); });
  rim.forEach((p, i) => {
    const a = inner[(i + n - 1) % n], b = inner[i], via = d3(centre, a) + d3(a, p) < d3(centre, b) + d3(b, p) ? a : b;
    p.s = along(p, d3(centre, via) + d3(via, p));
  });
  const tris: RockTri[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    tris.push([centre, inner[(i + n - 1) % n], inner[i]], [inner[(i + n - 1) % n], rim[i], inner[i]], [inner[i], rim[i], rim[j]]);
  }
  // How much longer the way over the surface is than straight across, and the inner ring's mean height (for crater bowls)
  let stretch = 0, innerZ = 0;
  for (const p of inner) { stretch += d3(centre, p) / (Math.hypot(p.x - centre.x, p.y - centre.y) || 1); innerZ += p.z; }
  stretch /= n; innerZ /= n;
  const surfaceAt = (x: number, y: number) => [(x - centre.x) * stretch, (y - centre.y) * stretch, (innerZ / size) * 0.95];
  return { tris, surfaceAt };
}

/** Each triangle's facing (kept towards the camera), and each point's own normal (the average of its triangles') */
function shadeRock(tris: RockTri[]): number[][] {
  const faces = tris.map(([a, b, c]) => {
    const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z, vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (nz < 0) { nx = -nx; ny = -ny; nz = -nz; }
    const l = Math.hypot(nx, ny, nz) || 1;
    return [nx / l, ny / l, nz / l];
  });
  const points = new Set<RockPoint>();
  for (const t of tris) for (const p of t) { if (!points.has(p)) { points.add(p); p.avg = [0, 0, 0]; } }
  tris.forEach((t, i) => { for (const p of t) for (let k = 0; k < 3; k++) p.avg[k] += faces[i][k]; });
  for (const p of points) { const l = Math.hypot(p.avg[0], p.avg[1], p.avg[2]) || 1; for (let k = 0; k < 3; k++) p.avg[k] /= l; }
  return faces;
}

/** How many times a rock of this size has its triangles split (big rocks get finer lumps; the light mesh stays coarse) */
export function rockDetailLevels(size: number): number {
  return size < 220 ? 0 : size < 550 ? 1 : size < 1300 ? 2 : 3;
}

/**
 * Finer geometry for a big rock: each triangle split into four, `levels`
 * times, each new point (an edge's midpoint) raised or sunk by a share of its
 * edge's length, so lumps and ridges come at every scale while the big shape
 * stays. Along the rim the new points move only a little, mostly inwards, so
 * the outline stays close to the rock's hit shape (getAsteroidPolygon).
 */
function refineRock(tris: RockTri[], levels: number, rnd: () => number): RockTri[] {
  for (let l = 0; l < levels; l++) {
    const mids = new Map<RockPoint, Map<RockPoint, RockPoint>>();
    const mid = (a: RockPoint, b: RockPoint): RockPoint => {
      const m = mids.get(a)?.get(b) ?? mids.get(b)?.get(a);
      if (m) return m;
      const len = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z), rim = a.rim && b.rim;
      let x = (a.x + b.x) / 2, y = (a.y + b.y) / 2, z = (a.z + b.z) / 2;
      if (rim) {
        const r = Math.hypot(x, y) || 1, d = (rnd() - 0.65) * len * 0.12;
        x += (x / r) * d; y += (y / r) * d; z = Math.max(0, z + (rnd() - 0.5) * len * 0.05);
      } else {
        x += (rnd() - 0.5) * len * 0.06; y += (rnd() - 0.5) * len * 0.06; z += (rnd() - 0.45) * len * 0.28;
      }
      const p: RockPoint = { x, y, z, rim, s: [(a.s[0] + b.s[0]) / 2, (a.s[1] + b.s[1]) / 2, (a.s[2] + b.s[2]) / 2], avg: [0, 0, 1] };
      if (!mids.has(a)) mids.set(a, new Map());
      mids.get(a)!.set(b, p);
      return p;
    };
    const next: RockTri[] = [];
    for (const [a, b, c] of tris) {
      const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
      next.push([a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]);
    }
    tris = next;
  }
  return tris;
}

/**
 * An asteroid: its rock as lit geometry (body and crater bowls, with its
 * material; and a lighter version for far off), and its gem seams, if it has
 * any, drawn into `container` (they glow by themselves). Returns both.
 * `greyseam`: the share of (non-ice) rocks veined with greyseam (a system's `visuals.greyseam`; most places a third).
 */
export function drawAsteroid(container: Container, id: number, size: number, comp?: Composition, greyseam = 0.35): { rock: AsteroidRock; seams: AsteroidSeams | null } {
  const rock: AsteroidRock = { geometry: new RockGeometry(), size };
  if (comp && GAS_TYPES.has(comp.type)) {
    // A gas pocket: no rock, a soft cloud that breathes (the seams' pulse)
    const r = mulberry32(hashString(`gas:${id}`));
    const cloud = new Graphics();
    cloud.blendMode = 'add';
    const color = mix(ORE_COLOR[comp.primary] ?? 0x9ce8e0, 0xffffff, 0.2);
    for (let i = 0; i < 9; i++) {
      const a = r() * Math.PI * 2, d = r() * size * 0.55, rr = size * (0.35 + r() * 0.4);
      cloud.circle(Math.cos(a) * d, Math.sin(a) * d, rr).fill({ color, alpha: 0.09 });
    }
    cloud.circle(0, 0, size * 0.5).fill({ color, alpha: 0.12 });
    container.addChild(cloud);
    return { rock, seams: { glow: cloud, color, phase: r() * Math.PI * 2 } };
  }
  const verts = getAsteroidPolygon(id, 0, 0, size);
  const rng = mulberry32(hashString(`asteroid-color:${id}`));
  const jitter = mulberry32(hashString(`asteroid-normals:${id}`));
  const base = comp ? ORE_COLOR[comp.primary] ?? 0x777777 : [0x666666, 0x886644, 0x4488aa][Math.floor(rng() * 3)];
  const hard = (comp?.hardness ?? 1) >= 2;
  const fill = hard ? mix(base, 0x1a1d24, 0.25) : base;
  // Hard rock: a sharper-edged rim
  const edge = mix(fill, 0xffffff, hard ? 0.22 : 0.12), smooth = rockSmoothing(comp);
  // Its material, its own seed (turning and shifting the relief), and greyseam: one rock in three (or the system's share), never in ice
  const material = rockMaterial(comp);
  const veined = !!comp && material !== 'ice' && !NO_GREYSEAM.has(comp.type) && comp.primary !== 'ice' && size >= 14 && mulberry32(hashString(`greyseam:${id}`))() <= greyseam;
  const seed = mulberry32(hashString(`rock-detail:${id}`))();
  const mat = [ROCK_MATERIALS.indexOf(material), seed, veined ? 0.9 : 0, 0], light = [mat[0], seed, 0, 1];

  const { tris: coarse, surfaceAt } = rockShape(verts, jitter);
  const full = rock.geometry;
  // Small on screen: the coarse shape's points, each shared by its triangles, smooth
  shadeRock(coarse);
  const at = new Map<object, number>();
  const shared = (p: RockPoint) => {
    let k = at.get(p);
    if (k === undefined) at.set(p, (k = full.rockVertex(p.x, p.y, p.avg, p.rim ? edge : fill, [p.s[0] / size, p.s[1] / size, p.s[2], size], p.avg, light)));
    return k;
  };
  for (const t of coarse) full.tri(shared(t[0]), shared(t[1]), shared(t[2]));
  // Close in: the shape (finer for a big rock), each corner lit between its own facet's light and its neighbours' (`smooth`)
  const levels = rockDetailLevels(size);
  const tris = refineRock(coarse, levels, mulberry32(hashString(`rock-shape:${id}`)));
  const faces = shadeRock(tris);
  tris.forEach((t, i) => {
    const f = faces[i];
    const ids = t.map((p) => {
      const nx = f[0] + (p.avg[0] - f[0]) * smooth, ny = f[1] + (p.avg[1] - f[1]) * smooth, nz = f[2] + (p.avg[2] - f[2]) * smooth;
      const l = Math.hypot(nx, ny, nz) || 1;
      return full.rockVertex(p.x, p.y, [nx / l, ny / l, nz / l], p.rim ? edge : fill, [p.s[0] / size, p.s[1] / size, p.s[2], size], p.avg, mat);
    });
    full.tri(ids[0], ids[1], ids[2]);
  });

  // Craters (kept well inside the outline): a rim tilted inwards, so it's lit on the far side
  const inside = (x: number, y: number, k: number) => { const l = Math.hypot(x, y), m = size * k; return l > m ? [(x / l) * m, (y / l) * m] : [x, y]; };
  const bowl = mix(fill, 0x000000, 0.18), up = [0, 0, 1];
  // (more on a big rock, and smaller)
  for (let b = 0; b < 4 + levels * 5; b++) {
    const r = 3 + (rng() * size * 0.12) / (1 + levels * 0.6);
    const [cx, cy] = inside((rng() - 0.5) * size * 1.1, (rng() - 0.5) * size * 1.1, 0.62 - r / size);
    const sc = surfaceAt(cx, cy), ring: number[] = [];
    const c0 = full.rockVertex(cx, cy, up, bowl, [sc[0] / size, sc[1] / size, sc[2], size], up, mat);
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2, tilt = 0.6, x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r, s = surfaceAt(x, y);
      ring.push(full.rockVertex(x, y, [-Math.cos(a) * tilt, -Math.sin(a) * tilt, Math.sqrt(1 - tilt * tilt)], bowl, [s[0] / size, s[1] / size, s[2], size], up, mat));
    }
    for (let i = 0; i < 7; i++) full.tri(c0, ring[i], ring[(i + 1) % 7]);
  }

  if (!comp?.seam) return { rock, seams: null };
  // Seams: jagged veins across the rock, plus a pulsing glow
  const color = GEM_COLOR[comp.seam.gem] ?? 0xffffff;
  const veins = new Graphics();
  const glow = new Graphics();
  glow.blendMode = 'add';
  for (let k = 0; k < 3; k++) {
    const a = rng() * Math.PI;
    const len = size * (0.9 + rng() * 0.6);
    const pts: number[] = [];
    for (let i = 0; i <= 6; i++) {
      const t = i / 6 - 0.5;
      const j = (rng() - 0.5) * size * 0.25;
      pts.push(Math.cos(a) * t * len - Math.sin(a) * j, Math.sin(a) * t * len + Math.cos(a) * j);
    }
    veins.moveTo(pts[0], pts[1]);
    glow.moveTo(pts[0], pts[1]);
    for (let i = 2; i < pts.length; i += 2) { veins.lineTo(pts[i], pts[i + 1]); glow.lineTo(pts[i], pts[i + 1]); }
    veins.stroke({ color: mix(color, 0xffffff, 0.35), width: 2.5 });
    glow.stroke({ color, width: 9, alpha: 0.35 });
  }
  // Keep veins inside the rock outline
  const mask = new Graphics().poly(verts.flatMap((v) => [v.x * 0.96, v.y * 0.96])).fill({ color: 0xffffff });
  const seamLayer = new Container();
  seamLayer.addChild(veins, glow);
  seamLayer.mask = mask;
  container.addChild(mask, seamLayer);
  return { rock, seams: { glow, color, phase: rng() * Math.PI * 2 } };
}
