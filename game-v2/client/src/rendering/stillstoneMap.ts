/**
 * A stillstone's surface (StillstoneShader.ts draws it): a 256² height field
 * over the stone, from its id. A lumpy, pitted body of rock, and sunk into its
 * face one great carving that fades into the rock at its rim: a crown (bands
 * stepping down to a flat, calm centre, each rimmed by a worn wall and ribbed
 * between, spokes running out over the rock as worn ribs), a rosette (rows of
 * petals, each a stack of terraces, shrinking inwards) or nested polygons
 * twisting inwards. Scarred: one arc of the carving worn away. Dead: much of
 * it crumbled, and no light in its grooves. Rough (newly found): smaller,
 * coarser.
 *
 * Out: `map` RGBA (r, g the surface normal's x, y; b its albedo, darker in the
 * hollows; a the stone's outline, as a distance ramp: 0.5 on the edge), and `glow` (r: the grooves' own cold
 * light). The map spans the square from -1 to 1, the stone's edge about 0.86
 * out. Pure (no Pixi): it runs in a worker (proceduralWorker.ts) and in tests.
 */

import { hashString, mulberry32, type LodestoneData } from '@space-game/common';

export const STILLSTONE_MAP = 256;
/** The map's half-width, in stone radii (the stone itself reaches about 0.95 of its radius) */
export const STILLSTONE_MAP_SPAN = 1.1;
/** Albedo is stored as a share of this */
export const STILLSTONE_ALBEDO_MAX = 0.25;

export type StillstoneKind = 'crown' | 'rosette' | 'nested';

const MAP = STILLSTONE_MAP;
const TAU = Math.PI * 2;
/** Texels the outline's distance ramp runs each side of the edge */
const EDGE_RAMP = 6;

/** The kind straight from the id, so they come out evenly: about half crowns, most of the rest rosettes (rough ones never crowns) */
export function stillstoneKind(data: Pick<LodestoneData, 'id' | 'rough'>): StillstoneKind {
  const pick = Math.floor(mulberry32(hashString(data.id) ^ 0x9e3779b9)() * 100);
  if (data.rough) return pick < 50 ? 'rosette' : 'nested';
  return pick < 48 ? 'crown' : pick < 88 ? 'rosette' : 'nested';
}

/** Value noise, a few octaves */
function makeNoise(seed: number): (x: number, y: number, oct?: number) => number {
  const r = mulberry32(seed), P = new Float32Array(256 * 256);
  for (let i = 0; i < P.length; i++) P[i] = r();
  const at = (x: number, y: number) => P[((y & 255) << 8) | (x & 255)];
  const n = (x: number, y: number) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    return (at(xi, yi) * (1 - u) + at(xi + 1, yi) * u) * (1 - v) + (at(xi, yi + 1) * (1 - u) + at(xi + 1, yi + 1) * u) * v;
  };
  return (x, y, oct = 5) => {
    let s = 0, a = 0.5, f = 1;
    for (let o = 0; o < oct; o++) { s += a * n(x * f, y * f); a *= 0.5; f *= 2.03; }
    return s;
  };
}

const smooth = (e0: number, e1: number, x: number) => { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
/** A soft ridge: 1 at d = 0, falling to 0 at |d| = w */
const ridge = (d: number, w: number) => { const t = Math.min(1, Math.abs(d) / w); return 1 - t * t * (3 - 2 * t); };

/** The height field, the outline and the grooves' light */
export function stillstoneField(data: LodestoneData): { H: Float32Array; mask: Float32Array; glow: Float32Array } {
  const seed = hashString(data.id), kind = stillstoneKind(data);
  const state = data.state ?? 'active', rough = !!data.rough, dead = state === 'dead';
  const r = mulberry32(seed ^ 0x51ed27), noise = makeNoise(seed), noise2 = makeNoise(seed ^ 0x5bd1e995);
  const H = new Float32Array(MAP * MAP), mask = new Float32Array(MAP * MAP), glow = new Float32Array(MAP * MAP);
  // the outline: lumpy, a little stretched
  const waves = [2, 3, 4, 6, 9].map((k) => ({ k, a: (rough ? 0.08 : 0.05) * (2.5 / k) * (0.5 + r()), p: r() * TAU }));
  const edgeAt = (a: number) => 0.86 * (1 + waves.reduce((s, w) => s + w.a * Math.cos(w.k * a + w.p), 0));
  const Rc = rough ? 0.42 : kind === 'rosette' ? 0.6 : kind === 'crown' ? 0.56 : 0.52;
  const nPet = 6 + Math.floor(r() * 3), off = r() * TAU, nSpk = 14 + Math.floor(r() * 6) * 2, m6 = r() < 0.5 ? 6 : 8;
  const pits = Array.from({ length: 26 }, () => { const a = r() * TAU, d = Math.sqrt(r()) * 0.82; return { x: Math.cos(a) * d, y: Math.sin(a) * d, s: 0.012 + r() * 0.03 }; });
  // the scar: the arc it names (degrees), worn down to under half
  const scar = state === 'scarred' && data.scar ? (() => {
    const from = (data.scar.from * Math.PI) / 180, span = ((((data.scar.to - data.scar.from) * Math.PI) / 180) % TAU + TAU) % TAU || TAU;
    return { mid: from + span / 2, half: span / 2 };
  })() : null;
  const rings = [0.16, 0.3, 0.48, 0.7, 0.95];
  for (let j = 0; j < MAP; j++) for (let i = 0; i < MAP; i++) {
    const x = ((i + 0.5) / MAP) * 2 - 1, y = ((j + 0.5) / MAP) * 2 - 1, d = Math.hypot(x, y), a = Math.atan2(y, x);
    // crowns: the outline scalloped between the spokes
    const spk = kind === 'crown' ? Math.pow(0.5 + 0.5 * Math.cos(((a - off) * nSpk) / 2), 6) * 0.025 : 0;
    const e = edgeAt(a) + (noise(i / 18, j / 18, 3) - 0.5) * 0.05 + spk;
    // the outline as distance from the edge, 0.5 on it, ramping over EDGE_RAMP texels each side (so the shader can cut it sharp at any zoom)
    mask[j * MAP + i] = Math.max(0, Math.min(1, 0.5 + ((e - 0.0175 - d) * MAP) / 2 / (2 * EDGE_RAMP)));
    const m = smooth(e, e - 0.035, d);
    if (m <= 0) continue;
    // the body: a low dome, rock bumps at several sizes, pits
    let h = 0.5 * Math.sqrt(Math.max(0, 1 - (d / e) ** 2)) + (noise(i / 60, j / 60, 2) - 0.5) * 0.2 + (noise(i / 22, j / 22) - 0.5) * 0.14 + (noise2(i / 6, j / 6, 3) - 0.5) * 0.06 + (noise2(i / 1.7, j / 1.7, 2) - 0.5) * 0.025;
    for (const p of pits) { const q = Math.hypot(x - p.x, y - p.y) / p.s; if (q < 1.3) h -= 0.035 * (q < 1 ? 1 - q * q : (-0.25 * (1.3 - q)) / 0.3); }
    // the carving: sunk into the face, faded out over a wide, broken band at its rim
    const inC = smooth(Rc * 1.22, Rc * 0.8, d + (noise(a * 4 + 3, d * 5, 3) - 0.5) * 0.08);
    const wob = 1 + (noise(a * 3 + 10, d * 4, 2) - 0.5) * 0.08;
    let c = 0, gl = 0;
    if (kind === 'crown') {
      const t = (d / Rc) * wob;
      // bands stepping down towards the middle, each rimmed by a worn wall (the innermost left out: a flat centre)
      for (let k = 1; k < rings.length; k++) { c += 0.045 * smooth(rings[k] - 0.02, rings[k] + 0.02, t) + 0.06 * ridge(t - rings[k], 0.03); }
      c += 0.045;
      // ribbed between the walls, light along each band's inner foot
      for (let k = 0; k < rings.length - 1; k++) {
        if (t > rings[k] + 0.03 && t < rings[k + 1] - 0.03) {
          const ribs = Math.round(26 + k * 18);
          c += 0.05 * Math.pow(0.5 + 0.5 * Math.cos(a * ribs + k + noise(a * 8, t * 6, 2) * 2), 2) * smooth(rings[k] + 0.03, rings[k] + 0.08, t) * smooth(rings[k + 1] - 0.02, rings[k + 1] - 0.06, t);
          if (k > 0) gl += ridge(t - (rings[k] + 0.045), 0.012) * 0.6;
        }
      }
      c -= 0.012 * smooth(0.2, 0, t);
    } else if (kind === 'rosette') {
      // three rows of petals, each a stack of terraces (loops round its base), shrinking inwards
      const sector = TAU / nPet;
      let best = 0;
      for (let row = 0; row < 3; row++) {
        const rOut = Rc * 0.98 * Math.exp(-row * sector * 0.95), rIn = rOut * Math.exp(-sector * 0.95), sh = off + ((row % 2) * sector) / 2;
        const rel = ((((a - sh) % sector) + sector * 1.5) % sector) - sector / 2;
        const along = d * Math.cos(rel) - rIn * 0.98, across = d * Math.sin(rel);
        const len = rOut - rIn, wid = Math.sin(sector * 0.5) * rOut * 0.95;
        const q = Math.hypot(along / len, across / wid);
        if (along > -len * 0.1 && q < 1) {
          const steps = 5 - row, tq = q * steps, frac = tq - Math.floor(tq);
          const v = (1 - Math.floor(tq) / steps) * 0.12 + 0.03 * smooth(0, 0.25, frac) * smooth(1, 0.7, frac);
          if (v > best) { best = v; gl = ridge(frac - 0.12, 0.06) * 0.5; }
        }
      }
      c += best + 0.06 * smooth(Rc * 0.12, Rc * 0.04, d);
    } else {
      // nested polygons, softened, twisting inwards
      for (let t = 0; t < 7; t++) {
        const rr = Rc * 0.95 * Math.exp(-0.42 * t), rot = off + t * 0.09;
        const aa = ((((a - rot) % (TAU / m6)) + TAU / m6) % (TAU / m6)) - TAU / (2 * m6);
        const poly = (rr * Math.cos(Math.PI / m6)) / Math.cos(aa);
        c += 0.03 * smooth(poly + 0.012, poly - 0.012, d * wob);
        gl += ridge(d * wob - poly + 0.02, 0.006) * 0.5;
      }
    }
    // crowns' spokes: grooves across the carving, raised worn ribs out on the rock
    if (kind === 'crown' && d > Rc * 0.15) {
      const sp = ((((a - off) % (TAU / nSpk)) + TAU / nSpk) % (TAU / nSpk)) - TAU / (2 * nSpk);
      const across = Math.abs(sp) * d, main = Math.round((a - off) / (TAU / nSpk)) % 2 === 0, w = main ? 0.012 : 0.007;
      c += 0.05 * ridge(across, w) * smooth(Rc * 0.15, Rc * 0.25, d) * (d < Rc ? 1 : 0);
      const out = smooth(Rc * 0.95, Rc * 1.1, d) * smooth(e, e * 0.85, d);
      h += (main ? 0.09 : 0.05) * ridge(across, w * 2.6) * out * (0.6 + 0.8 * noise(a * 20, d * 30, 2));
    }
    // erosion: the carving crumbles into noise; a scar wears one arc away, death much of it
    const crumble = (noise2(i / 9, j / 9, 4) - 0.5) * 0.08 + (noise(i / 2.2, j / 2.2, 2) - 0.5) * 0.03;
    let keep = 1;
    if (scar) {
      const da = Math.abs(((((a - scar.mid + Math.PI) % TAU) + TAU) % TAU) - Math.PI);
      keep = 1 - 0.6 * smooth(scar.half + 0.25, Math.max(0, scar.half - 0.1), da);
    }
    if (dead) keep *= 0.35 + 0.65 * smooth(0.42, 0.58, noise(a * 2 + 50, d * 3, 2));
    h = h * (1 - inC * 0.6) + inC * (c * keep * 1.3 - 0.07 + crumble);
    H[j * MAP + i] = h * m;
    glow[j * MAP + i] = dead ? 0 : gl * inC * keep;
  }
  return { H, mask, glow };
}

/** The textures: `map` (normal x, y; albedo; outline) and `glow`, both RGBA, 256² */
export function buildStillstoneMap(data: LodestoneData): { map: Uint8Array; glow: Uint8Array } {
  const { H, mask, glow } = stillstoneField(data);
  const dim = (data.state ?? 'active') === 'dead' ? 0.62 : 1;
  const at = (A: Float32Array, x: number, y: number) => A[Math.max(0, Math.min(MAP - 1, y)) * MAP + Math.max(0, Math.min(MAP - 1, x))];
  // the hollows: below the surrounding average
  const blur = new Float32Array(MAP * MAP);
  for (let j = 0; j < MAP; j++) for (let i = 0; i < MAP; i++) {
    let s = 0, n = 0;
    for (let dj = -6; dj <= 6; dj += 2) for (let di = -6; di <= 6; di += 2) { s += at(H, i + di, j + dj); n++; }
    blur[j * MAP + i] = s / n;
  }
  const map = new Uint8Array(MAP * MAP * 4), light = new Uint8Array(MAP * MAP * 4);
  const S = (13 * MAP) / 32;
  for (let j = 0; j < MAP; j++) for (let i = 0; i < MAP; i++) {
    const o = j * MAP + i, k = o * 4;
    const dx = ((at(H, i + 1, j) - at(H, i - 1, j)) / 2) * S, dy = ((at(H, i, j + 1) - at(H, i, j - 1)) / 2) * S, l = Math.hypot(dx, dy, 1);
    const cav = Math.max(-0.08, Math.min(0.08, H[o] - blur[o]));
    const albedo = (0.1 + cav * 0.7) * (0.75 + 0.25 * (1 + cav * 6)) * dim;
    map[k] = Math.round((-dx / l * 0.5 + 0.5) * 255);
    map[k + 1] = Math.round((-dy / l * 0.5 + 0.5) * 255);
    map[k + 2] = Math.max(0, Math.min(255, Math.round((albedo / STILLSTONE_ALBEDO_MAX) * 255)));
    map[k + 3] = Math.round(Math.max(0, Math.min(1, mask[o])) * 255);
    light[k] = Math.round(Math.max(0, Math.min(1, glow[o])) * 255);
    light[k + 3] = 255;
  }
  return { map, glow: light };
}
