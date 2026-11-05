/**
 * A surface's rock as drawn (terrainData.ts, common's terrain.ts), all one
 * mesh in world coordinates, lit per pixel (rockShader.ts: its relief and a
 * cliff's ledges worked out at every pixel), with its lava streams under it:
 *
 *   streams  lava running over the floor (LavaStreams.ts)
 *   cliffs   along the valley's outline, a tall face turned in to the valley:
 *            sheer at the foot, easing towards the top, broken into facets
 *            (each point given a height up the wall and nudged off its row,
 *            each triangle flat with its own true normal, so the rock catches
 *            the light plane by plane); a dark band on the floor at its foot.
 *            In a cavern it falls away into the dark past the exposed face
 *   top      the rock beyond, rows running back from the cliffs' edge
 *   fill     rock further off: flat, dark (in a cavern, black)
 *   rocks    boulders sunk in the walls and the arena's pillars: faceted domes
 *            in the walls' own rock (their outline's corners cut, rings of it
 *            drawn in, each ring higher, each point a little off; every
 *            triangle flat with its own true normal; drawn as a little cliff
 *            all round, its way into the rock towards its middle, so they
 *            take the walls' strata and light), a dark band at their foot
 *   ridges   a long heap of rock (a cave mouth's): cross-sections along its
 *            crest, rising from its foot either side, each point a little
 *            off; faceted like the rest, and drawn as a cliff on both sides
 *            (the way into the rock towards its crest), so it takes their
 *            strata and light; a dark band along its foot
 *   holes    a cave's mouth: black, its rim falling away into it (drawn
 *            first: what stands round it stands over its rim)
 */

import { Container } from 'pixi.js';
import type { Terrain, Vec2 } from '@space-game/common';
import { LitGeometry } from './lighting/LitGeometry';
import { LitMesh, type Lighting } from './lighting/Lighting';
import { rockProgram } from './lighting/rockShader';
import { skyNoiseTexture } from './sky/noiseTexture';
import { LavaStreams } from './LavaStreams';
import { BarrierView } from './BarrierView';
import { DenDressing } from './DenDressing';

/** The rock's colours (a terrain's `palette` overrides them): its foot, face, top, rock further off */
const ROCK = { foot: 0x2c2224, face: 0x3a3033, top: 0x302a2d, far: 0x241d21 };
/** A boulder's rings, drawn in from its outline (of its size), and how far over their faces lean (0 flat .. 1 sheer) */
const DOME = [0, 0.16, 0.38, 0.66];
/** Each ring's height (of the boulder's size; its middle stands at 1) */
const DOME_HEIGHT = [0, 0.42, 0.68, 0.86];
/** The deep of a cave's mouth: the faintest glow far down */
const PIT = 0x1a0603;

/** What each vertex is (rockShader.ts aRock.w) */
const CLIFF = 0, BOULDER_KIND = 1, SHADOW = 2;

/** In a cavern: a wall's exposed face (into the rock) before it fades, and black by here */
const EXPOSED = 1900, BLACK = 3700;
/** How far up a cavern's walls the floor's glow reaches */
const FOOT_GLOW = 900;

const hex = (c: string) => parseInt(c.replace('#', ''), 16);
const hash = (a: number, b: number) => { const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return s - Math.floor(s); };
const mixc = (a: number, b: number, t: number) => {
  const r = ((a >> 16) & 255) + ((((b >> 16) & 255) - ((a >> 16) & 255)) * t), g = ((a >> 8) & 255) + ((((b >> 8) & 255) - ((a >> 8) & 255)) * t), bl = (a & 255) + (((b & 255) - (a & 255)) * t);
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(bl);
};

/** Every corner moved `d` towards its rock's middle (negative: outwards) */
function inset(pts: number[], d: number): number[] {
  let cx = 0, cy = 0;
  const n = pts.length / 2;
  for (let i = 0; i < n; i++) { cx += pts[i * 2]; cy += pts[i * 2 + 1]; }
  cx /= n; cy /= n;
  return pts.map((v, i) => {
    const x = pts[i - (i % 2)], y = pts[i - (i % 2) + 1], dd = Math.hypot(cx - x, cy - y) || 1, k = Math.max(-1, Math.min(0.45, d / dd));
    return i % 2 ? y + (cy - y) * k : x + (cx - x) * k;
  });
}

/** A rock's outline rounded off (corners cut) and roughened a little, so it never reads as a polygon */
function roundOff(pts: number[], r: number): number[] {
  let p = pts;
  for (let pass = 0; pass < 1; pass++) {
    const m = p.length / 2, out: number[] = [];
    for (let i = 0; i < m; i++) {
      const j = (i + 1) % m, ax = p[i * 2], ay = p[i * 2 + 1], bx = p[j * 2], by = p[j * 2 + 1];
      out.push(ax * 0.75 + bx * 0.25, ay * 0.75 + by * 0.25, ax * 0.25 + bx * 0.75, ay * 0.25 + by * 0.75);
    }
    p = out;
  }
  const m = p.length / 2;
  let cx = 0, cy = 0;
  for (let i = 0; i < m; i++) { cx += p[i * 2]; cy += p[i * 2 + 1]; }
  cx /= m; cy /= m;
  return p.map((v, i) => {
    const k = i >> 1, x = p[k * 2], y = p[k * 2 + 1], f = 1 + (hash(k, r) - 0.5) * 0.08;
    return i % 2 ? cy + (y - cy) * f : cx + (x - cx) * f;
  });
}

/** The cliffs' terraces: how far into the rock each row sits, and how steeply the face below it leans (0 flat .. 1 sheer) */
const ROWS = [0, 110, 260, 450, 700, 1000, 1400, 1900, 2600, 3600, 5900];
const LEAN = [0.92, 0.88, 0.82, 0.74, 0.64, 0.52, 0.38, 0.24, 0.12, 0.06];
/** Each row's height up the wall (the face below it rising at its lean) */
const HEIGHT = ROWS.map((_, r) => {
  let z = 0;
  for (let k = 0; k < r; k++) z += (ROWS[k + 1] - ROWS[k]) * (LEAN[k] / Math.sqrt(1 - LEAN[k] * LEAN[k]));
  return z;
});

export class TerrainView {
  readonly container = new Container();
  private lit: LitMesh | null = null;
  private streams: LavaStreams | null = null;
  /** A boss arena's barrier (world/gates.ts) */
  private barrier: BarrierView | null = null;
  /** Lamps, cables, veins, belts and plates in and on the rock (look only) */
  private dressing: DenDressing | null = null;
  /** Its colours */
  private pal = ROCK;

  /** `cave`: a cavern (dark: its walls fall away into black past their face, the floor's glow lights their foot) */
  constructor(terrain: Terrain, private lighting: Lighting, cave = false) {
    const g = new LitGeometry();
    const rock: number[] = [];
    /** Tag every vertex added since the last call */
    const tag = (ix: number, iy: number, d: number, kind: number) => { while (rock.length < g.vertexCount * 4) rock.push(ix, iy, d, kind); };
    const f = terrain.file;
    if (f.palette) this.pal = { foot: hex(f.palette.foot), face: hex(f.palette.face), top: hex(f.palette.top), far: hex(f.palette.far) };
    if (f.streams?.length) {
      this.streams = new LavaStreams(f.streams, lighting);
      this.container.addChild(this.streams.mesh);
    }
    // (a hollowed rock's floor: plain rock, under everything; its lava, barrier and dressing go over it)
    for (const pts of f.floor ?? []) { g.flat(pts.flat(), f.palette?.floor ? hex(f.palette.floor) : this.pal.far); tag(0, 0, 0, BOULDER_KIND); }
    for (const pts of f.fill ?? []) { g.flat(pts.flat(), cave ? 0x000000 : this.pal.far); tag(0, 0, 1e5, CLIFF); }
    // A cave's mouth: black, a faint glow far down, its rim falling away into it
    for (const hole of f.holes ?? []) {
      const pts = hole.flat(), m = hole.length;
      const cx = hole.reduce((s, p) => s + p[0], 0) / m, cy = hole.reduce((s, p) => s + p[1], 0) / m;
      const c = g.vertex(cx, cy, 0, 0, 1, PIT); rock.push(0, 0, 1, SHADOW);
      const first = g.vertexCount;
      for (let i = 0; i < m; i++) { g.vertex(pts[i * 2], pts[i * 2 + 1], 0, 0, 1, 0x000000); rock.push(0, 0, 1, SHADOW); }
      for (let i = 0; i < m; i++) g.tri(c, first + i, first + ((i + 1) % m));
      this.ring(g, rock, pts, inset(pts, -420), 0x000000, 0x000000, 1, 0);
    }
    if (f.cliff && f.cliffIn) this.cliffMesh(g, rock, f.cliff, f.cliffIn, cave);
    for (const c of f.cliffs ?? []) this.cliffMesh(g, rock, c.pts, c.in, cave, c.depth);
    // Ridges: one faceted mass along each, a little cliff on both sides of its crest
    for (const rd of f.ridges ?? []) this.ridge(g, rock, rd, cave);
    // Boulders and pillars: a soft shadow round the foot, then the dome
    for (const rk of terrain.rocks) {
      const pts = rk.flat();
      let r = 0;
      const k = rk.length, cx = rk.reduce((s, p) => s + p[0], 0) / k, cy = rk.reduce((s, p) => s + p[1], 0) / k;
      for (const [x, y] of rk) r = Math.max(r, Math.hypot(x - cx, y - cy));
      const round = roundOff(pts, r);
      this.ring(g, rock, round, inset(round, -Math.min(280, r * 0.4)), 0x000000, 0x000000, cave ? 0.75 : 0.5, 0);
      this.dome(g, rock, round, cx, cy, r);
    }
    tag(0, 1, -1, BOULDER_KIND);
    if (f.gates?.length) { this.barrier = new BarrierView(f.gates); this.container.addChild(this.barrier.gfx); }
    if (f.dressing) this.dressing = new DenDressing(f.dressing, lighting);
    // (Nothing but a barrier: no rock to draw)
    if (!g.vertexCount) return;
    this.lit = new LitMesh(g.toGeometry(undefined, { aRock: { buffer: new Float32Array(rock), format: 'float32x4' } }), {
      chunk: true, program: rockProgram(),
      resources: { uNoise: skyNoiseTexture().source, rockUniforms: { uRock: { value: new Float32Array([EXPOSED, BLACK, FOOT_GLOW, cave ? 1 : 0]), type: 'vec4<f32>' } } },
    });
    this.container.addChild(this.lit.mesh);
    lighting.add(this.lit);
    // (over a floor: its lava and its barrier; over the rock: lamps on its walls, veins in it, plates on it)
    if (f.floor?.length) for (const c of [this.streams?.mesh, this.barrier?.gfx]) if (c) this.container.addChild(c);
    if (this.dressing) this.container.addChild(this.dressing.container);
  }


  /**
   * One outline's cliffs: a dark band at the foot, then rows of facets up into the rock. `depth`: how deep the rock goes
   * at each point (the rows stop there: a wall between two chambers is drawn from both sides, meeting in the middle)
   */
  private cliffMesh(g: LitGeometry, rock: number[], cliff: Vec2[], into: Vec2[], cave: boolean, depth?: number[]): void {
    const n = cliff.length;
    if (n < 3 || into.length !== n) return;
    // A dark band on the floor at the cliffs' foot (it's where the wall meets the ground: no bright seam)
    let first = g.vertexCount;
    for (let i = 0; i < n; i++) {
      const [x, y] = cliff[i], [ix, iy] = into[i], w = 240 + hash(i, 7) * 120;
      g.vertex(x - ix * w, y - iy * w, 0, 0, 1, 0x000000); rock.push(ix, iy, 0, SHADOW);
      g.vertex(x + ix * 20, y + iy * 20, 0, 0, 1, 0x000000); rock.push(ix, iy, cave ? 0.75 : 0.5, SHADOW);
    }
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n, a0 = first + i * 2, a1 = first + j * 2;
      g.tri(a0, a1, a1 + 1);
      g.tri(a0, a1 + 1, a0 + 1);
    }
    // The way into the rock at each point as an angle, unwound so it never jumps; how far along the wall
    const ang: number[] = [], along: number[] = [0];
    for (let i = 0; i <= n; i++) {
      let a = Math.atan2(into[i % n][1], into[i % n][0]);
      if (i > 0) { while (a - ang[i - 1] > Math.PI) a -= Math.PI * 2; while (a - ang[i - 1] < -Math.PI) a += Math.PI * 2; }
      ang.push(a);
      if (i > 0) along.push(along[i - 1] + Math.hypot(cliff[i % n][0] - cliff[i - 1][0], cliff[i % n][1] - cliff[i - 1][1]));
    }
    // Each row's points: along the outline, `ROWS[r]` into the rock, nudged off it (into the rock, along the
    // wall) and up or down a little, more so further up: the corners of the facets (the foot stays on the outline)
    // (one column more than the outline has points: the last is the first again, its angle a full turn on)
    const rows = ROWS.map((_, r) => Array.from({ length: n + 1 }, (_, i) => {
      const k = i % n, [x, y] = cliff[k], [ix, iy] = into[k];
      if (r === 0) return [x, y, 0, 0];
      const d = Math.min(ROWS[r] + (hash(k, r) - 0.5) * (60 + ROWS[r] * 0.14), depth?.[k] ?? Infinity);
      const s = (hash(k, r + 20) - 0.5) * 340;
      const z = HEIGHT[r] + (hash(k, r + 60) - 0.5) * (HEIGHT[r] - HEIGHT[r - 1]) * 1.1;
      return [x + ix * d - iy * s, y + iy * d + ix * s, d, z];
    }));
    for (let r = 0; r < ROWS.length - 1; r++) {
      const a = rows[r], b = rows[r + 1];
      const P = this.pal, lo = r === 0 ? P.foot : r < 4 ? P.face : P.top, hi = r < 3 ? P.face : P.top;
      for (let i = 0; i < n; i++) {
        const a0 = { p: a[i], c: lo, i }, a1 = { p: a[i + 1], c: lo, i: i + 1 }, b0 = { p: b[i], c: hi, i }, b1 = { p: b[i + 1], c: hi, i: i + 1 };
        // Split each quad either way (so the facets don't line up)
        const tris = hash(i, r + 90) < 0.5 ? [[a0, a1, b1], [a0, b1, b0]] : [[a0, a1, b0], [a1, b1, b0]];
        for (const [t, tri] of tris.entries()) {
          // Its own flat normal, from where its corners really are (up the wall included)
          const [p, q, w] = tri.map((v) => v.p);
          const ux = q[0] - p[0], uy = q[1] - p[1], uz = q[3] - p[3], vx = w[0] - p[0], vy = w[1] - p[1], vz = w[3] - p[3];
          let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
          if (nz < 0) { nx = -nx; ny = -ny; nz = -nz; }
          const l = Math.hypot(nx, ny, nz) || 1;
          // and a tone of its own
          const shade = (hash(i * 2 + t, r + 80) - 0.5) * 0.22;
          for (const v of tri) {
            g.vertex(v.p[0], v.p[1], nx / l, ny / l, nz / l, mixc(v.c, shade > 0 ? 0xffffff : 0x000000, Math.abs(shade)));
            rock.push(ang[v.i], along[v.i], v.p[2], CLIFF);
          }
          const f0 = g.vertexCount - 3;
          g.tri(f0, f0 + 1, f0 + 2);
        }
      }
    }
  }

  /** A boulder: rings of its outline drawn in towards its middle and up, faceted (each triangle flat, its normal its own) */
  private dome(g: LitGeometry, rock: number[], pts: number[], cx: number, cy: number, r: number): void {
    const m = pts.length / 2;
    // Each ring's points, up where they stand (a little off, each one)
    const rings = DOME.map((f, k) => {
      const ring = inset(pts, r * f);
      return Array.from({ length: m }, (_, i) => ({
        x: ring[i * 2], y: ring[i * 2 + 1],
        z: r * (DOME_HEIGHT[k] + (k > 0 ? (hash(i, k + r) - 0.5) * 0.14 : 0)),
        d: r * DOME[k], c: k === 0 ? this.pal.foot : k < 2 ? this.pal.face : this.pal.top,
      }));
    });
    // (its peak a little off its middle)
    const top = { x: cx + (hash(cx, 1) - 0.5) * r * 0.3, y: cy + (hash(cy, 2) - 0.5) * r * 0.3, z: r, d: r, c: this.pal.top };
    type P = typeof top;
    const facet = (p: P, q: P, w: P, t: number) => {
      const ux = q.x - p.x, uy = q.y - p.y, uz = q.z - p.z, vx = w.x - p.x, vy = w.y - p.y, vz = w.z - p.z;
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      if (nz < 0) { nx = -nx; ny = -ny; nz = -nz; }
      const l = Math.hypot(nx, ny, nz) || 1, shade = (hash(t, r) - 0.5) * 0.22;
      // The way into the rock: towards the middle (as an angle, unwound across this one triangle; the top takes its corners')
      const ang = [p, q, w].map((v) => (v === top ? NaN : Math.atan2(cy - v.y, cx - v.x)));
      const a0 = ang.find((a) => !Number.isNaN(a))!;
      for (let k = 0; k < 3; k++) if (!Number.isNaN(ang[k])) { while (ang[k] - a0 > Math.PI) ang[k] -= Math.PI * 2; while (ang[k] - a0 < -Math.PI) ang[k] += Math.PI * 2; }
      const known = ang.filter((a) => !Number.isNaN(a)), mean = known.reduce((x, y) => x + y, 0) / known.length;
      [p, q, w].forEach((v, k) => {
        const a = Number.isNaN(ang[k]) ? mean : ang[k];
        g.vertex(v.x, v.y, nx / l, ny / l, nz / l, mixc(v.c, shade > 0 ? 0xffffff : 0x000000, Math.abs(shade)));
        rock.push(a, a * r + cx * 0.37, v.d, CLIFF);
      });
      const f0 = g.vertexCount - 3;
      g.tri(f0, f0 + 1, f0 + 2);
    };
    let t = 0;
    for (let k = 0; k < rings.length - 1; k++) {
      const A = rings[k], B = rings[k + 1];
      for (let i = 0; i < m; i++) {
        const j = (i + 1) % m;
        if (hash(i, k + 7) < 0.5) { facet(A[i], A[j], B[j], t++); facet(A[i], B[j], B[i], t++); }
        else { facet(A[i], A[j], B[i], t++); facet(A[j], B[j], B[i], t++); }
      }
    }
    const L = rings[rings.length - 1];
    for (let i = 0; i < m; i++) facet(L[i], L[(i + 1) % m], top, t++);
  }

  /** A ridge: cross-sections along its crest, foot to crest to foot, faceted (each triangle flat, its own true normal); its ends taper away (narrow and low in the data) */
  private ridge(g: LitGeometry, rock: number[], rd: { pts: Vec2[]; w: number[]; h: number[] }, cave: boolean): void {
    const n = rd.pts.length;
    if (n < 2) return;
    /** Across the ridge: -1 one foot, 0 the crest, 1 the other foot */
    const ACROSS = [-1, -0.64, -0.3, 0, 0.32, 0.66, 1];
    const along = [0];
    for (let i = 1; i < n; i++) along.push(along[i - 1] + Math.hypot(rd.pts[i][0] - rd.pts[i - 1][0], rd.pts[i][1] - rd.pts[i - 1][1]));
    const sideOf = (i: number) => {
      const a = rd.pts[Math.max(0, i - 1)], b = rd.pts[Math.min(n - 1, i + 1)], ex = b[0] - a[0], ey = b[1] - a[1], l = Math.hypot(ex, ey) || 1;
      return [-ey / l, ex / l];
    };
    const sec = rd.pts.map(([x, y], i) => {
      const [nx, ny] = sideOf(i), w = rd.w[i], h = rd.h[i];
      return ACROSS.map((t, j) => {
        const foot = j === 0 || j === ACROSS.length - 1;
        // (each point a little off, along and across; up or down a little, but the feet stay on the ground)
        const jit = foot ? 0 : (hash(i, j) - 0.5) * 0.18, slide = (hash(i, j + 9) - 0.5) * 0.35 * w * (foot ? 0.3 : 1);
        const tt = t * (1 + jit), px = x + nx * tt * w - ny * slide, py = y + ny * tt * w + nx * slide;
        const z = foot ? 0 : h * (1 - Math.pow(Math.abs(t), 1.5)) * (1 + (hash(i, j + 30) - 0.5) * 0.25);
        return { x: px, y: py, z, t, d: (1 - Math.abs(t)) * w, c: foot ? this.pal.foot : Math.abs(t) > 0.5 ? this.pal.face : this.pal.top, i };
      });
    });
    type P = (typeof sec)[0][0];
    let k = 0;
    const facet = (p: P, q: P, w: P) => {
      const ux = q.x - p.x, uy = q.y - p.y, uz = q.z - p.z, vx = w.x - p.x, vy = w.y - p.y, vz = w.z - p.z;
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      if (nz < 0) { nx = -nx; ny = -ny; nz = -nz; }
      const l = Math.hypot(nx, ny, nz) || 1, shade = (hash(k++, 41) - 0.5) * 0.22;
      // The way into the rock: across, towards the crest, from whichever side this facet is on
      const [sx, sy] = sideOf(p.i), towards = p.t + q.t + w.t > 0 ? -1 : 1, ang = Math.atan2(sy * towards, sx * towards);
      for (const v of [p, q, w]) {
        g.vertex(v.x, v.y, nx / l, ny / l, nz / l, mixc(v.c, shade > 0 ? 0xffffff : 0x000000, Math.abs(shade)));
        rock.push(ang, along[v.i], v.d, CLIFF);
      }
      const f0 = g.vertexCount - 3;
      g.tri(f0, f0 + 1, f0 + 2);
    };
    // A dark band along its foot, either side
    for (const s of [-1, 1]) {
      const first = g.vertexCount;
      for (let i = 0; i < n; i++) {
        const [nx, ny] = sideOf(i), e = sec[i][s < 0 ? 0 : ACROSS.length - 1], out = Math.min(280, rd.w[i] * 0.6);
        g.vertex(e.x, e.y, 0, 0, 1, 0x000000); rock.push(0, 0, cave ? 0.75 : 0.5, SHADOW);
        g.vertex(e.x + nx * s * out, e.y + ny * s * out, 0, 0, 1, 0x000000); rock.push(0, 0, 0, SHADOW);
      }
      for (let i = 0; i < n - 1; i++) {
        const a0 = first + i * 2, a1 = first + (i + 1) * 2;
        g.tri(a0, a1, a1 + 1);
        g.tri(a0, a1 + 1, a0 + 1);
      }
    }
    for (let i = 0; i < n - 1; i++) {
      const A = sec[i], B = sec[i + 1];
      for (let j = 0; j < ACROSS.length - 1; j++) {
        if (hash(i, j + 60) < 0.5) { facet(A[j], A[j + 1], B[j + 1]); facet(A[j], B[j + 1], B[j]); }
        else { facet(A[j], A[j + 1], B[j]); facet(A[j + 1], B[j + 1], B[j]); }
      }
    }
  }

  /** A shadow band between two outlines: `a` at `alphaIn` on the inner one, fading to `alphaOut` on the outer */
  private ring(g: LitGeometry, rock: number[], inner: number[], outer: number[], cin: number, cout: number, alphaIn: number, alphaOut: number): void {
    const m = inner.length / 2, first = g.vertexCount;
    for (let i = 0; i < m; i++) {
      g.vertex(inner[i * 2], inner[i * 2 + 1], 0, 0, 1, cin); rock.push(0, 0, alphaIn, SHADOW);
      g.vertex(outer[i * 2], outer[i * 2 + 1], 0, 0, 1, cout); rock.push(0, 0, alphaOut, SHADOW);
    }
    for (let i = 0; i < m; i++) {
      const j = (i + 1) % m, a0 = first + i * 2, a1 = first + j * 2;
      g.tri(a0, a1, a1 + 1);
      g.tri(a0, a1 + 1, a0 + 1);
    }
  }

  update(dt: number): void {
    this.streams?.update(dt);
    this.barrier?.update(dt);
    this.dressing?.update(dt);
  }

  destroy(): void {
    this.streams?.destroy();
    this.barrier?.destroy();
    this.dressing?.destroy();
    if (this.lit) { this.lighting.remove(this.lit); this.lit.destroy(); }
    this.container.destroy({ children: true });
  }
}
