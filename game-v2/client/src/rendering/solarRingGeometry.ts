/**
 * The Helios Array's shape (the `solar_ring` structure), plain data with no Pixi: its layout and turn (shared with the
 * system map, ui/mapStructures.ts) and the vertices its mesh is built from (solarRing.ts draws them; see there for
 * what each segment is).
 */
import type { StructureData } from '@space-game/common';

export const SOLAR_RING = {
  /** The inner rim (the sunlit edge tying the arrays together): radii as offsets from the ring's radius */
  rimIn: -1710, rimOut: -1650,
  /** The truss's chords (the main ring), each `chordW` wide */
  chordIn: -300, chordOut: 300, chordW: 52,
  /** A hub's octagon (to its corners) */
  hub: 560,
  /** Its turn, radians a second */
  spin: 0.0015,
} as const;

/** How far it has turned at server tick `tick` (from the clock, so every client and the map agree) */
export function solarRingAngle(tick: number): number {
  return ((tick / 60) * SOLAR_RING.spin) % (Math.PI * 2);
}

/** The Halden's visual language (Scenery.ts HALDEN): slate faces, a darker edge, a greyseam inlay */
const HALDEN = { face: 0x2e333c, faceLight: 0x383e48, edge: 0x56606c, inlay: 0xa9cfd8 };
/** The Directorate's kit: titanium frame (the stations' frame grey), darker structure, gold trim (the Helios Drone's) */
const C = { frame: 0x8a96a6, chord: 0x76818f, strut: 0x8b97a8, dark: 0x3c4452, hull: 0x5a6474, hubCore: 0x2a303b, gold: 0xd9b45a, radiator: 0xd4d9e0 };

/** What each vertex is (aMat.x); the shader's branches */
export const RING_KIND = { metal: 0, cells: 1, radiator: 2, lamp: 3, glow: 4, inlay: 5 } as const;
/** Lamps (aMat.w): steady, blinking, slow pulse */
const LAMP = { steady: 0, blink: 1, pulse: 2 } as const;

/** World units to one 256-texel tile of cells (8 cells across: a cell is 40 units) */
export const CELL_TILE = 320;
/** The sun's elevation for the baked light (Lighting.sun.elevation's default) */
const SUN_ELEV = 0.7;

export interface SolarRingGeometryData {
  positions: Float32Array;
  uvs: Float32Array;
  colors: Float32Array;
  mats: Float32Array;
  indices: Uint32Array;
}

const rgb = (hex: number): [number, number, number] => [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];

/** Builds the ring's vertices: position, uv, albedo, [kind, baked sun, phase, extra] */
class RingBuilder {
  pos: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  mat: number[] = [];
  idx: number[] = [];
  private ce = Math.cos(SUN_ELEV);
  private se = Math.sin(SUN_ELEV);

  /** How much a surface with in-plane lean (nx, ny) (0: flat, facing up) at (x, y) faces the star */
  sun(x: number, y: number, nx = 0, ny = 0): number {
    const r = Math.hypot(x, y) || 1;
    const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
    return Math.max(0, (-x / r) * this.ce * nx + (-y / r) * this.ce * ny + this.se * nz);
  }

  vert(x: number, y: number, u: number, v: number, color: number, kind: number, shade: number, phase = 0, extra = 0): number {
    const [r, g, b] = rgb(color);
    this.pos.push(x, y); this.uv.push(u, v); this.col.push(r, g, b); this.mat.push(kind, shade, phase, extra);
    return this.pos.length / 2 - 1;
  }

  quad(a: number, b: number, c: number, d: number): void { this.idx.push(a, b, c, a, c, d); }

  /**
   * A straight member from (x0, y0) to (x1, y1), `w` wide: bevelled, so its side towards the star is lit and the far
   * side falls into shade
   */
  beam(x0: number, y0: number, x1: number, y1: number, w: number, color: number, kind: number = RING_KIND.metal, phase = 0, extra = 0): void {
    const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy) || 1;
    const px = -dy / L, py = dx / L, h = w / 2, lean = 0.7;
    const s = (x: number, y: number, side: number) => this.sun(x, y, px * side * lean, py * side * lean);
    const a = this.vert(x0 + px * h, y0 + py * h, 0, 1, color, kind, s(x0, y0, 1), phase, extra);
    const b = this.vert(x1 + px * h, y1 + py * h, L, 1, color, kind, s(x1, y1, 1), phase, extra);
    const c = this.vert(x1 - px * h, y1 - py * h, L, -1, color, kind, s(x1, y1, -1), phase, extra);
    const d = this.vert(x0 - px * h, y0 - py * h, 0, -1, color, kind, s(x0, y0, -1), phase, extra);
    this.quad(a, b, c, d);
  }

  /**
   * A band round the centre from radius r0 to r1 and angle a0 to a1 in `sub` pieces. `bevel`: its inner edge leans to
   * the star and its outer edge away (a rail); otherwise flat, lit `flat` (a panel tilted to the star). uv: arc length
   * at the band's middle along, distance out across
   */
  band(r0: number, r1: number, a0: number, a1: number, sub: number, color: number, kind: number, opts: { bevel?: boolean; flat?: number; phase?: number; extra?: number } = {}): void {
    const rm = (r0 + r1) / 2, lean = 0.7;
    let prevIn = -1, prevOut = -1;
    for (let k = 0; k <= sub; k++) {
      const a = a0 + ((a1 - a0) * k) / sub, ca = Math.cos(a), sa = Math.sin(a), u = (a - a0) * rm;
      const si = opts.bevel ? this.sun(ca * r0, sa * r0, -ca * lean, -sa * lean) : opts.flat ?? this.sun(ca * r0, sa * r0);
      const so = opts.bevel ? this.sun(ca * r1, sa * r1, ca * lean, sa * lean) : opts.flat ?? this.sun(ca * r1, sa * r1);
      const vi = this.vert(ca * r0, sa * r0, u, 0, color, kind, si, opts.phase, opts.extra);
      const vo = this.vert(ca * r1, sa * r1, u, r1 - r0, color, kind, so, opts.phase, opts.extra);
      if (k > 0) this.quad(prevIn, prevOut, vo, vi);
      prevIn = vi; prevOut = vo;
    }
  }

  /** A polygon as a fan from its centre: the rim leans out by `lean` (bevelled, lit on the star's side) */
  fan(cx: number, cy: number, pts: [number, number][], color: number, kind: number, lean = 0.6, phase = 0, extra = 0): void {
    const c = this.vert(cx, cy, 0, 0, color, kind, this.sun(cx, cy), phase, extra);
    const ring = pts.map(([x, y]) => {
      const dx = x - cx, dy = y - cy, L = Math.hypot(dx, dy) || 1;
      return this.vert(x, y, dx, dy, color, kind, this.sun(x, y, (dx / L) * lean, (dy / L) * lean), phase, extra);
    });
    for (let i = 0; i < ring.length; i++) this.idx.push(c, ring[i], ring[(i + 1) % ring.length]);
  }

  /** A lamp: a small disc (lit by itself) and a soft glow about it; uv runs -1..1 across both */
  lamp(x: number, y: number, core: number, glow: number, color: number, mode: number, phase: number): void {
    for (const [r, kind] of [[core, RING_KIND.lamp], [glow, RING_KIND.glow]] as const) {
      const a = this.vert(x - r, y - r, -1, -1, color, kind, 1, phase, mode);
      const b = this.vert(x + r, y - r, 1, -1, color, kind, 1, phase, mode);
      const c = this.vert(x + r, y + r, 1, 1, color, kind, 1, phase, mode);
      const d = this.vert(x - r, y + r, -1, 1, color, kind, 1, phase, mode);
      this.quad(a, b, c, d);
    }
  }
}

/** A tiny seeded random, so every client builds the same ring */
function rng(seed: string): () => number {
  let s = 2166136261;
  for (const ch of seed) s = Math.imul(s ^ ch.charCodeAt(0), 16777619) >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

/** The ring's geometry (plain arrays: no Pixi), sized from its radius and segment count */
export function solarRingGeometry(data: Pick<StructureData, 'id' | 'radius' | 'segments' | 'oldArc'>): SolarRingGeometryData {
  const R = data.radius, n = Math.max(12, data.segments), arc = data.oldArc;
  const w = (Math.PI * 2) / n, seg = w * R;
  const B = new RingBuilder();
  const rand = rng(data.id);
  const P = (r: number, a: number): [number, number] => [Math.cos(a) * r, Math.sin(a) * r];
  // Radii, outward: the inner rim, three rows of modules, the truss's chords, the outer beacons
  const L = SOLAR_RING, rimIn = R + L.rimIn, rimOut = R + L.rimOut, chordIn = R + L.chordIn, chordOut = R + L.chordOut, chordW = L.chordW;
  const rowIn = rimOut + 25, rowOut = chordIn - 40, rowGap = 34, rows = 3;
  const rowDepth = (rowOut - rowIn - rowGap * (rows - 1)) / rows;
  const spokeW = 46, colGap = 26, segGap = 20;
  const isOld = (i: number) => !!arc && (i - arc.from + n) % n < arc.count;

  // The chords (the main ring): continuous, in pieces a quarter-segment long
  for (const [r0, r1] of [[chordIn, chordIn + chordW], [chordOut - chordW, chordOut]] as const) B.band(r0, r1, 0, Math.PI * 2, n * 4, C.chord, RING_KIND.metal, { bevel: true });
  // The inner rim (sunlit edge)
  B.band(rimIn, rimOut, 0, Math.PI * 2, n * 4, C.strut, RING_KIND.metal, { bevel: true });

  for (let i = 0; i < n; i++) {
    const ac = i * w, a0 = ac - w / 2, a1 = ac + w / 2;
    const old = isOld(i), hub = i % 10 === 0;
    const structure = old ? HALDEN.edge : C.strut;
    // The truss: a post at the segment's edge, and a Warren pair of diagonals
    {
      const [x0, y0] = P(chordIn + chordW / 2, a0), [x1, y1] = P(chordOut - chordW / 2, a0);
      B.beam(x0, y0, x1, y1, 26, structure);
      const [mx, my] = P(chordOut - chordW / 2, ac), [ex, ey] = P(chordIn + chordW / 2, a1);
      B.beam(x0, y0, mx, my, 16, structure);
      B.beam(mx, my, ex, ey, 16, structure);
    }
    // A beacon on the outer chord (the hub has its own)
    if (!hub) {
      const [bx, by] = P(chordOut + 34, ac);
      B.beam(...P(chordOut - 10, ac), bx, by, 44, C.dark);
      B.lamp(bx, by, 15, 130, i % 2 ? 0xff5a4a : 0x5aff8a, LAMP.blink, i * 0.37);
    }
    if (hub) {
      // The hub: an octagon astride the truss, a gold docking ring, a slow amber beacon
      const [hx, hy] = P(R, ac);
      const oct = (r: number, rot: number) => Array.from({ length: 8 }, (_, k): [number, number] => {
        const b = ac + rot + (k / 8) * Math.PI * 2;
        return [hx + Math.cos(b) * r, hy + Math.sin(b) * r];
      });
      // Radiators outward (away from the star), ribbed, warm at the root
      const [tx, ty] = [-Math.sin(ac), Math.cos(ac)], [cx, cy] = [Math.cos(ac), Math.sin(ac)];
      for (const side of [-1, 1]) {
        const off = side * 250, r0 = R + 420, r1 = R + 1560;
        const p = (r: number, half: number, s: number): [number, number] => [cx * r + tx * (off + s * half), cy * r + ty * (off + s * half)];
        B.beam(...p(R + 300, 0, 0), ...p(r0 + 20, 0, 0), 40, C.dark);
        const sh = B.sun(cx * r0, cy * r0) * 0.85;
        const q = [p(r0, 95, -1), p(r0, 95, 1), p(r1, 70, 1), p(r1, 70, -1)];
        const v = q.map(([x, y], k) => B.vert(x, y, (k === 0 || k === 3 ? -1 : 1) * (k < 2 ? 95 : 70), k < 2 ? 0 : r1 - r0, C.radiator, RING_KIND.radiator, sh));
        B.quad(v[0], v[1], v[2], v[3]);
        B.beam(...p(r0, 0, 0), ...p(r1, 0, 0), 12, C.dark);
      }
      // A mast inward to the rim, with the gold conduit
      B.beam(...P(rimOut - 10, ac), ...P(R - 460, ac), 64, C.strut);
      B.beam(...P(rimOut + 20, ac), ...P(R - 460, ac), 12, C.gold);
      B.fan(hx, hy, oct(L.hub, Math.PI / 8), C.hull, RING_KIND.metal, 0.75);
      B.fan(hx, hy, oct(400, Math.PI / 8), C.dark, RING_KIND.metal, 0.4);
      // (its plating's seams, a gold trim inside its rim, and a lamp at every other corner)
      const outerC = oct(L.hub - 18, Math.PI / 8), innerC = oct(400, Math.PI / 8), trim = oct(L.hub - 60, Math.PI / 8);
      for (let k = 0; k < 8; k++) {
        B.beam(innerC[k][0], innerC[k][1], outerC[k][0], outerC[k][1], 10, C.hubCore);
        B.beam(trim[k][0], trim[k][1], trim[(k + 1) % 8][0], trim[(k + 1) % 8][1], 9, C.gold);
      }
      for (let k = 1; k < 8; k += 2) B.lamp(outerC[k][0], outerC[k][1], 13, 110, 0xfff0d0, LAMP.blink, i * 0.5 + k * 0.25);
      // (the docking ring: gold, then the dark well inside it)
      B.fan(hx, hy, oct(250, 0).flatMap((p, k, all) => { const q = all[(k + 1) % 8]; return [p, [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]] as [number, number][]; }), C.gold, RING_KIND.metal, 0.5);
      B.fan(hx, hy, oct(205, 0), C.hubCore, RING_KIND.metal, 0.2);
      B.lamp(hx, hy, 50, 520, 0xffc870, LAMP.pulse, i * 0.9);
      // Two windows' worth of light on its sunward faces
      for (const side of [-1, 1]) B.lamp(hx - cx * 470 + tx * side * 180, hy - cy * 470 + ty * side * 180, 12, 80, 0xbfe6ff, LAMP.steady, 0);
    } else {
      // The spoke: from the inner chord down to the rim, a gold conduit along it, a dim lamp at its tip
      B.beam(...P(rimOut - 10, ac), ...P(chordIn + 10, ac), spokeW, structure);
      if (!old) B.beam(...P(rimOut + 20, ac), ...P(chordIn, ac), 10, C.gold);
      B.lamp(...P(rimIn - 30, ac), 11, 90, old ? 0x9fd8e8 : 0xffb050, LAMP.steady, i * 1.3);
    }
    // The arrays' backing frame: a member along each gap between rows, and one up each segment's edge
    for (let row = 1; row < rows; row++) {
      const r = rowIn + row * (rowDepth + rowGap) - rowGap / 2;
      B.band(r - 9, r + 9, a0, a1, 3, old ? HALDEN.edge : C.dark, RING_KIND.metal, { bevel: true });
    }
    B.beam(...P(rimOut, a0), ...P(chordIn + 4, a0), 20, old ? HALDEN.edge : C.dark);
    // The modules: two columns either side of the spoke, three rows (a hub keeps its two inner rows)
    for (const side of [-1, 1]) {
      for (let row = 0; row < (hub ? 2 : rows); row++) {
        const r0 = rowIn + row * (rowDepth + rowGap), r1 = r0 + rowDepth, rm = (r0 + r1) / 2;
        // (in angle: from the spoke's edge to the segment's)
        const inner = (spokeW / 2 + colGap) / rm, outer = w / 2 - segGap / rm;
        const b0 = side < 0 ? ac - outer : ac + inner, b1 = side < 0 ? ac - inner : ac + outer;
        if (old) {
          // A Halden slab: notched at its corners, a greyseam chevron down it
          const nb = 0.14 * (b1 - b0), nd = rowDepth * 0.22, pts: [number, number][] = [
            P(r0, b0 + nb), P(r0, b1 - nb), P(r0 + nd, b1), P(r1, b1), P(r1, b0), P(r0 + nd, b0),
          ];
          const [mx, my] = P(rm, (b0 + b1) / 2);
          B.fan(mx, my, pts, (i + row) % 2 ? HALDEN.face : HALDEN.faceLight, RING_KIND.metal, 0.5);
          const [l0x, l0y] = P(r1 - rowDepth * 0.15, b0 + (b1 - b0) * 0.18), [l1x, l1y] = P(r0 + rowDepth * 0.25, (b0 + b1) / 2), [l2x, l2y] = P(r1 - rowDepth * 0.15, b1 - (b1 - b0) * 0.18);
          B.beam(l0x, l0y, l1x, l1y, 9, HALDEN.inlay, RING_KIND.inlay, rand() * 6);
          B.beam(l1x, l1y, l2x, l2y, 9, HALDEN.inlay, RING_KIND.inlay, rand() * 6);
          continue;
        }
        // The frame (a thin rim, bevelled), then the cells inside it, each module tilted a little differently
        B.band(r0, r1, b0, b1, 3, C.frame, RING_KIND.metal, { bevel: true });
        const inset = 14;
        B.band(r0 + inset, r1 - inset, b0 + inset / rm, b1 - inset / rm, 3, 0xffffff, RING_KIND.cells, { flat: 0.82 + rand() * 0.18, extra: 0.4 + rand() * 0.6 });
      }
    }
  }
  return {
    positions: new Float32Array(B.pos), uvs: new Float32Array(B.uv), colors: new Float32Array(B.col), mats: new Float32Array(B.mat),
    indices: new Uint32Array(B.idx),
  };
}
