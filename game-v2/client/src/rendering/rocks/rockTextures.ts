/**
 * The asteroids' relief atlas (RockMaterials.ts draws with it): one 512² tile
 * per material, 3 across and 2 down, each tileable. Built from a height field
 * per material (chips, dents, swells, facets, blobs or strata), stored as its
 * slope (r, g), its cavity (b: hollows low, ridges high) and a greyseam vein
 * mask (a). Slopes and cavity are centred and scaled by their mean deviation,
 * then softly compressed, so no edge or crack can swamp the rest.
 * Pure (no Pixi): it runs in a worker (proceduralWorker.ts) and in tests.
 */

export type RockMaterial = 'stone' | 'metal' | 'ice' | 'crystal' | 'tar' | 'leestone';
/** In atlas order: tile i at column i % 3, row floor(i / 3) */
export const ROCK_MATERIALS: RockMaterial[] = ['stone', 'metal', 'ice', 'crystal', 'tar', 'leestone'];
/** A tile's side (texels) */
export const ROCK_TILE = 512;

const N = ROCK_TILE;
const wrap = (v: number) => ((v % N) + N) % N;
const wrapD = (d: number) => d - Math.round(d / N) * N;

function lcg(seed: number): () => number {
  return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
}

/** Value noise, tileable: `[cells across, amplitude]` per octave */
function noiseInto(hgt: Float32Array, rnd: () => number, octaves: [number, number][]): void {
  for (const [p, amp] of octaves) {
    const g = new Float32Array(p * p);
    for (let i = 0; i < g.length; i++) g[i] = rnd();
    const cell = N / p, q = (a: number, b: number) => g[(((b % p) + p) % p) * p + (((a % p) + p) % p)];
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const x = i / cell, y = j / cell, xi = Math.floor(x), yi = Math.floor(y), u = x - xi, v = y - yi;
      const su = u * u * (3 - 2 * u), sv = v * v * (3 - 2 * v);
      hgt[j * N + i] += amp * ((q(xi, yi) * (1 - su) + q(xi + 1, yi) * su) * (1 - sv) + (q(xi, yi + 1) * (1 - su) + q(xi + 1, yi + 1) * su) * sv);
    }
  }
}

/** Voronoi chips: each cell a plane at its own tilt, blended into its neighbour over `blend` texels (0: hard facets) */
function cellsInto(hgt: Float32Array, rnd: () => number, count: number, tilt: number, blend: number, amp: number): void {
  const cells = Array.from({ length: count }, () => ({ x: rnd() * N, y: rnd() * N, a: (rnd() - 0.5) * tilt, b: (rnd() - 0.5) * tilt, c: rnd() * 30, w: 0.6 + rnd() * 0.9 }));
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    let best = Infinity, second = Infinity, bc = cells[0], sc = cells[0], bdx = 0, bdy = 0, sdx = 0, sdy = 0;
    for (const c of cells) {
      const dx = wrapD(i - c.x), dy = wrapD(j - c.y), d = (dx * dx + dy * dy) / (c.w * c.w);
      if (d < best) { second = best; sc = bc; sdx = bdx; sdy = bdy; best = d; bc = c; bdx = dx; bdy = dy; } else if (d < second) { second = d; sc = c; sdx = dx; sdy = dy; }
    }
    const p1 = bc.a * bdx + bc.b * bdy + bc.c, p2 = sc.a * sdx + sc.b * sdy + sc.c;
    const m = blend > 0 ? 0.5 + 0.5 * Math.min(1, (Math.sqrt(second) - Math.sqrt(best)) / blend) : 1;
    hgt[j * N + i] += (p1 * m + p2 * (1 - m)) * amp;
  }
}

/** Round dents (negative depth: bumps), mostly small */
function dentsInto(hgt: Float32Array, rnd: () => number, count: number, rMin: number, rMax: number, depth: number): void {
  for (let c = 0; c < count; c++) {
    const cx = rnd() * N, cy = rnd() * N, r = rMin + Math.pow(rnd(), 2) * (rMax - rMin), dd = depth * (0.5 + rnd());
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const q = Math.hypot(dx, dy) / r;
      if (q >= 1) continue;
      hgt[wrap(Math.round(cy + dy)) * N + wrap(Math.round(cx + dx))] -= dd * (1 - q * q) * (1 - q * q);
    }
  }
}

/** Wandering cracks */
function cracksInto(hgt: Float32Array, rnd: () => number, count: number, len: number, depth: number, width = 2): void {
  for (let k = 0; k < count; k++) {
    let x = rnd() * N, y = rnd() * N, a = rnd() * Math.PI * 2;
    for (let st = 0; st < len; st++) {
      a += (rnd() - 0.5) * 0.35; x += Math.cos(a); y += Math.sin(a);
      for (let dy = -width; dy <= width; dy++) for (let dx = -width; dx <= width; dx++) {
        const q = Math.hypot(dx, dy) / (width + 0.2);
        if (q >= 1) continue;
        hgt[wrap(Math.round(y + dy)) * N + wrap(Math.round(x + dx))] -= depth * (1 - q);
      }
    }
  }
}

/** A material's height field */
export function rockHeight(mat: RockMaterial): Float32Array {
  const hgt = new Float32Array(N * N), rnd = lcg(1000 + ROCK_MATERIALS.indexOf(mat) * 7919);
  if (mat === 'stone') {
    // chips blending into each other, lumps at every scale, a couple of cracks
    cellsInto(hgt, rnd, 16, 0.7, 30, 0.6);
    noiseInto(hgt, rnd, [[4, 26], [8, 14], [16, 7], [32, 3], [64, 1.6], [128, 0.9]]);
    cracksInto(hgt, rnd, 2, 260, 3);
  } else if (mat === 'metal') {
    // hammered: many overlapping shallow round dents, a slow warp, a little grain
    noiseInto(hgt, rnd, [[4, 14], [8, 6], [64, 0.8], [128, 0.5]]);
    dentsInto(hgt, rnd, 520, 6, 30, 5);
  } else if (mat === 'ice') {
    // wind-polished: broad smooth swells, a few sharp fracture lines, almost no grain
    noiseInto(hgt, rnd, [[2, 30], [4, 16], [8, 6], [128, 0.3]]);
    cracksInto(hgt, rnd, 6, 320, 7, 1);
  } else if (mat === 'crystal') {
    // hard facets, strongly tilted, meeting at sharp edges
    cellsInto(hgt, rnd, 26, 1.6, 0, 0.6);
    noiseInto(hgt, rnd, [[8, 3], [128, 0.4]]);
  } else if (mat === 'tar') {
    // soft blobs
    noiseInto(hgt, rnd, [[3, 30], [6, 16], [12, 6]]);
    dentsInto(hgt, rnd, 60, 10, 40, -6);
  } else {
    // leestone: dense strata, wavering, with mild chips
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) hgt[j * N + i] += 4 * Math.sin((j + 12 * Math.sin((i / N) * Math.PI * 4)) / N * Math.PI * 18);
    cellsInto(hgt, rnd, 10, 0.4, 30, 0.4);
    noiseInto(hgt, rnd, [[8, 6], [32, 2], [128, 0.6]]);
  }
  // softened a touch (crystal stays sharp)
  if (mat !== 'crystal') {
    const out = new Float32Array(N * N);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      let sum = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) sum += hgt[wrap(j + dy) * N + wrap(i + dx)];
      out[j * N + i] = sum / 9;
    }
    hgt.set(out);
  }
  return hgt;
}

/** Greyseam: a long vein wandering across the tile (its path repeats, so it tiles) and a thinner branch across it that comes and goes; none in ice */
export function rockVeins(mat: RockMaterial): Float32Array {
  const m = new Float32Array(N * N);
  if (mat === 'ice') return m;
  const rnd = lcg(5000 + ROCK_MATERIALS.indexOf(mat) * 104729), T = (Math.PI * 2) / N;
  for (let v = 0; v < 2; v++) {
    const y0 = rnd() * N, a1 = 20 + rnd() * 40, a2 = 8 + rnd() * 16, a3 = 3 + rnd() * 4, p1 = rnd() * 6.3, p2 = rnd() * 6.3, p3 = rnd() * 6.3;
    const wide = v === 0 ? 3.2 : 1.8, pw = rnd() * 6.3, pe = rnd() * 6.3;
    for (let i = 0; i < N; i++) {
      const y = y0 + a1 * Math.sin(i * T + p1) + a2 * Math.sin(i * T * 3 + p2) + a3 * Math.sin(i * T * 11 + p3);
      const w = wide * (0.7 + 0.3 * Math.sin(i * T * 2 + pw)), env = v === 0 ? 1 : Math.max(0, Math.sin(i * T + pe));
      for (let dy = -8; dy <= 8; dy++) {
        const j = Math.round(y) + dy, q = Math.abs(j - y) / w;
        if (q >= 1.6) continue;
        // the vein runs across, the branch down
        const o = v === 0 ? wrap(j) * N + i : i * N + wrap(j);
        m[o] = Math.max(m[o], Math.min(1, 1.6 - q) * env);
      }
    }
  }
  return m;
}

/** The whole atlas, RGBA, (3 × 512) × (2 × 512) */
export function buildRockAtlas(): Uint8Array {
  const W = N * 3, data = new Uint8Array(W * N * 2 * 4);
  ROCK_MATERIALS.forEach((mat, mi) => {
    const veins = rockVeins(mat), hgt = rockHeight(mat), ox = (mi % 3) * N, oy = Math.floor(mi / 3) * N;
    const at = (i: number, j: number) => hgt[wrap(j) * N + wrap(i)];
    const sx = new Float32Array(N * N), sy = new Float32Array(N * N), cv = new Float32Array(N * N);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      let blur = 0, n = 0;
      for (let k = -8; k <= 8; k += 3) for (let m = -8; m <= 8; m += 3) { blur += at(i + m, j + k); n++; }
      const o = j * N + i;
      sx[o] = at(i + 1, j) - at(i - 1, j); sy[o] = at(i, j + 1) - at(i, j - 1); cv[o] = at(i, j) - blur / n;
    }
    const spread = (a: Float32Array): [number, number] => {
      let m = 0, v = 0;
      for (const x of a) m += x;
      m /= a.length;
      for (const x of a) v += Math.abs(x - m);
      return [m, (v / a.length) * 1.6 || 1];
    };
    const [mx, dxs] = spread(sx), [my, dys] = spread(sy), [mc, dcs] = spread(cv);
    const q = (v: number) => Math.max(0, Math.min(255, Math.round((Math.tanh(v * 0.6) * 0.42 + 0.5) * 255)));
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const o = j * N + i, k = ((oy + j) * W + ox + i) * 4;
      data[k] = q(-(sx[o] - mx) / dxs);
      data[k + 1] = q(-(sy[o] - my) / dys);
      data[k + 2] = q((cv[o] - mc) / dcs);
      data[k + 3] = Math.round(veins[o] * 255);
    }
  });
  return data;
}
