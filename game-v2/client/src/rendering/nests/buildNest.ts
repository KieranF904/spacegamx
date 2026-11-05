/**
 * Each kind of nest as lit pieces (NestGeometry): bevelled plates, facetted
 * shards and rock bodies from the asteroids' own builder, each with its
 * material (nestShader.ts). The layouts are the old flat drawings' (the same
 * seeded sequence per nest), so a nest is where and what it was:
 *   den     a hollowed asteroid, plated hab across its mouth with lit windows, a docking arm and collar
 *   dig     a cracked boulder, a Halden cache glowing in the cut, a gantry rig over it, crates
 *   scrap   slanted plates and girders heaped round a lump of greyseam (faint veins), rare glints
 *   sift    a ring frame of girders holding faintly glowing crystal, plates across it
 *   roost   ridged ice shards splayed from a frozen heart
 *   shrine  soot-blackened vanes and collar round a furnace mouth, the fire in it
 *   dock    a plated cradle with gold trim, clamp arms, blades racked on it
 *   knot    dark glassy shards on two arms, each circling at its own rate, finer debris between
 * Lamps are a small glowing body plus a soft glow sprite; each nest has at
 * most one real light, its most important (the cache, the fire, the heart...).
 */

import { NEST_RADIUS, getAsteroidPolygon, hashString, type Composition, type NestData } from '@space-game/common';
import { NestGeometry, lift, mix, type Tag } from './NestGeometry';
import { M } from './nestShader';

/** A real light, in the nest's own frame */
export interface NestLight { x: number; y: number; r: number; h: number; color: number; power: number; flicker?: boolean }
/** A soft glow sprite, in the nest's own frame; `pulse`: a lamp (breathes), `flicker`: fire */
export interface NestGlow { x: number; y: number; r: number; color: number; a: number; pulse?: boolean; flicker?: boolean }
export interface BuiltNest { geo: NestGeometry; light: NestLight | null; glows: NestGlow[] }

const R = NEST_RADIUS;

/** Of 60 asteroid ids from `seed`, the roundest (its nearest rim point furthest out): a body that fills the old outline */
const roundId = (seed: number) => {
  let best = seed, bv = 0;
  for (let id = seed; id < seed + 60; id++) {
    const p = getAsteroidPolygon(id, 0, 0, 1);
    let v = Infinity;
    for (const q of p) v = Math.min(v, Math.hypot(q.x, q.y));
    if (v > bv) { bv = v; best = id; }
  }
  return best;
};
const compOf = (primary: string, type = 'asteroid'): Composition => ({ type, ores: { [primary]: 1 }, primary, hardness: 1, seam: null, units: 100 });

export function buildNest(data: NestData, lamp: number): BuiltNest {
  // The old drawing's sequence (so the same layout), and a second one for what's new
  let seed = 11;
  for (const ch of data.id) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  let s2 = hashString(`nest-extra:${data.id}`) >>> 0;
  const rx = () => (s2 = (s2 * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const g = new NestGeometry(), glows: NestGlow[] = [];
  let light: NestLight | null = null;

  const rock = (r: number, n: number, rough: number, x = 0, y = 0): number[] => {
    const pts: number[] = [];
    for (let k = 0; k < n; k++) { const a = (k / n) * Math.PI * 2, rr = r * (1 - rough + rnd() * rough * 2); pts.push(x + Math.cos(a) * rr, y + Math.sin(a) * rr); }
    return pts;
  };
  const plate = (x: number, y: number, w: number, h: number, t: number): number[] => {
    const c = Math.cos(t), s = Math.sin(t), out: number[] = [];
    for (const [u, v] of [[-w, -h], [w, -h], [w, h], [-w, h]]) out.push(x + u * c - v * s, y + u * s + v * c);
    return out;
  };
  const rect = (x: number, y: number, w: number, h: number) => [x, y, x + w, y, x + w, y + h, x, y + h];
  /** A lit panel of a material */
  const panel = (pts: number[], color: number, mat: number, o: { bevel?: number; edge?: number; glow?: number; split?: number; rings?: number; tilt?: [number, number]; seed?: number; axis?: number; fine?: boolean } = {}) => {
    const v0 = g.vertexCount;
    g.panel(pts, color, { bevel: o.bevel ?? 10, edge: o.edge, glow: o.glow, split: o.split, rings: o.rings });
    const tl = o.tilt ?? [0, 0];
    if (tl[0] || tl[1]) g.tilt(v0, tl[0], tl[1]);
    const l = Math.hypot(tl[0], tl[1], 1);
    g.tag(v0, { mat, seed: o.seed ?? rx(), smooth: [tl[0] / l, tl[1] / l, 1 / l], axis: o.axis, fine: o.fine });
  };
  /** A bevelled girder; in strip plating its seams run across it */
  const bar = (x0: number, y0: number, x1: number, y1: number, w: number, color: number, mat: number, bevel = w * 0.3) => {
    const v0 = g.vertexCount;
    g.bar(x0, y0, x1, y1, w, color, { bevel, split: Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0) / 160)) });
    g.tag(v0, { mat, seed: rx(), axis: Math.atan2(y1 - y0, x1 - x0) });
  };
  /** A flat or round shape glowing by itself */
  const lit = (v0: number, mat: number, fine = false) => g.tag(v0, { mat, fine });
  /** A lamp: a small glowing body and a soft glow that breathes */
  const lampAt = (x: number, y: number, r: number, color: number, a = 0.8) => {
    const v0 = g.vertexCount;
    g.disc(x, y, r * 0.55, mix(color, 0xffffff, 0.35), { glow: 1 }, 10);
    lit(v0, M.plating, true);
    glows.push({ x, y, r: r * 3.2, color, a: a * 0.75, pulse: true });
  };
  /** A shard: a kite from its base, ridged along its length (two facets) */
  const shard = (bx: number, by: number, ang: number, len: number, w: number, color: number, mat: number, glow = 0) => {
    const c = Math.cos(ang), s = Math.sin(ang), px = -s, py = c, v0 = g.vertexCount;
    const back = [bx - c * w * 0.35, by - s * w * 0.35], tip = [bx + c * len, by + s * len], lf = [bx + px * w, by + py * w], rt = [bx - px * w, by - py * w];
    const tz = 0.82, tx = 0.57;
    const nL = [px * tx + c * 0.12, py * tx + s * 0.12, tz], nR = [-px * tx + c * 0.12, -py * tx + s * 0.12, tz];
    const hi = mix(color, 0xffffff, 0.12);
    const a = g.vertex(back[0], back[1], nL[0], nL[1], nL[2], hi, glow), b = g.vertex(lf[0], lf[1], nL[0], nL[1], nL[2], color, glow), d = g.vertex(tip[0], tip[1], nL[0], nL[1], nL[2], hi, glow);
    g.tri(a, b, d);
    const e = g.vertex(back[0], back[1], nR[0], nR[1], nR[2], hi, glow), f = g.vertex(tip[0], tip[1], nR[0], nR[1], nR[2], hi, glow), q = g.vertex(rt[0], rt[1], nR[0], nR[1], nR[2], color, glow);
    g.tri(e, f, q);
    g.tag(v0, { mat, seed: rx(), smooth: [0, 0, 1], S: 200 });
  };
  /** A small facetted rock from an outline (any centre) */
  const stone = (pts: number[], color: number, mat: number, smooth: number, t: Partial<Tag> = {}) => {
    let cx = 0, cy = 0;
    const n = pts.length / 2;
    for (let i = 0; i < n; i++) { cx += pts[i * 2]; cy += pts[i * 2 + 1]; }
    cx /= n; cy /= n;
    const v0 = g.vertexCount;
    g.rock(Array.from({ length: n }, (_, i) => ({ x: pts[i * 2] - cx, y: pts[i * 2 + 1] - cy })), color, mix(color, 0xffffff, 0.12), 'facets', rx, 0, smooth);
    g.shift(v0, cx, cy);
    g.tag(v0, { mat, seed: rx(), smooth: 'own', S: 180, ...t });
  };
  const k = data.kind;
  const bodyId = roundId((hashString(`nest-body:${data.id}`) >>> 0) % 100000);

  if (k === 'dig' || k === 'den') {
    // The rock: an asteroid body, and the old surface lumps as boulders on it
    for (let i = 0; i < 13; i++) rnd();
    g.boulder(bodyId, R * 0.95, compOf('silicate'), lift(k === 'dig' ? 0x564a40 : 0x4e4640, 1.25), 0, 0, 0);
    for (let i = 0; i < 5; i++) {
      const pts = rock(R * (0.12 + rnd() * 0.1), 7, 0.25, (rnd() - 0.5) * R, (rnd() - 0.5) * R);
      stone(pts, lift(0x5d5248, 1.2), M.stone, 0.55);
    }
    if (k === 'dig') {
      // The cut, dark, and the cache in it: a warm glow, and the nest's light low down, lighting the rig from below
      const cut = [-R * 0.32, -R * 0.1, R * 0.3, -R * 0.18, R * 0.24, R * 0.12, -R * 0.26, R * 0.16];
      let v0 = g.vertexCount;
      g.flat(cut, 0x1c1714, { rings: 2 });
      g.tag(v0, { mat: M.stone });
      v0 = g.vertexCount;
      g.flat([-R * 0.2, -R * 0.04, R * 0.18, -R * 0.1, R * 0.14, R * 0.06, -R * 0.16, R * 0.08], 0xc87838, { glow: 1, rings: 2 });
      lit(v0, M.stone);
      glows.push({ x: 0, y: -R * 0.02, r: R * 0.55, color: 0xffa860, a: 0.55 });
      light = { x: 0, y: -R * 0.02, r: R * 1.3, h: 50, color: 0xffa050, power: 1.6 };
      // The rig: gantry legs and beams (plated), the drill shaft, crates
      for (const sx of [-1, 1]) {
        bar(sx * R * 0.62, -R * 0.62, sx * R * 0.18, -R * 0.05, 26, lift(0x8a8f96, 1.15), M.strip);
        bar(sx * R * 0.62, R * 0.55, sx * R * 0.18, R * 0.05, 26, lift(0x8a8f96, 1.15), M.strip);
      }
      panel(rect(-R * 0.7, -R * 0.72, R * 1.4, 46), lift(0x6d7178), M.strip, { bevel: 12, edge: lift(0x8a9098), split: 4 });
      panel(rect(-R * 0.7, R * 0.6, R * 1.4, 46), lift(0x6d7178), M.strip, { bevel: 12, edge: lift(0x8a9098), split: 4 });
      panel(rect(-34, -R * 0.7, 68, R * 0.62), lift(0x9a3f22, 1.2), M.scrap, { bevel: 14, split: 3 });
      for (let i = 0; i < 4; i++) panel(rect(R * (0.42 + (i % 2) * 0.16), R * (0.14 + Math.floor(i / 2) * 0.16), 58, 58), lift(0x7a5a3a), M.crate, { bevel: 9, fine: true });
      for (const [x, y] of [[-R * 0.7, -R * 0.7], [R * 0.7, -R * 0.7], [-R * 0.7, R * 0.62], [R * 0.7, R * 0.62]]) lampAt(x, y, 26, lamp);
    } else {
      // The hollow (lit on its far side), a plated hab across its mouth with lit windows, a docking arm, a lamp-ringed collar
      let v0 = g.vertexCount;
      g.bowl(R * 0.05, 0, R * 0.42, 0x1e1915, { rings: 3 }, 14);
      g.tag(v0, { mat: M.stone, smooth: [0, 0, 1] });
      panel(rect(-R * 0.55, -70, R * 1.1, 140), lift(0x5a616b), M.plating, { bevel: 16, edge: lift(0x737b86), split: 4 });
      for (let i = 0; i < 5; i++) {
        const x = -R * 0.5 + i * R * 0.22;
        panel(rect(x, -40, R * 0.14, 80), 0x2a3038, M.blade, { bevel: 6, fine: true });
        v0 = g.vertexCount;
        g.flat(rect(x + 10, -26, R * 0.14 - 20, 52), 0xc8a868, { glow: 1 });
        lit(v0, M.plating, true);
        glows.push({ x: x + R * 0.07, y: 0, r: 70, color: 0xffe2a0, a: 0.35 });
      }
      bar(R * 0.5, 0, R * 1.1, 0, 44, lift(0x7a818b), M.strip);
      v0 = g.vertexCount;
      g.disc(R * 1.1, 0, 68, mix(lamp, 0xffffff, 0.15), { glow: 0.9 }, 20);
      lit(v0, M.plating);
      v0 = g.vertexCount;
      g.disc(R * 1.1, 0, 54, lift(0x5a616b), { bevel: 14, edge: lift(0x7a828c) }, 20);
      g.tag(v0, { mat: M.plating, seed: rx() });
      lampAt(R * 1.1, 0, 22, lamp);
      lampAt(-R * 0.6, 0, 24, lamp);
      // The light: the hab's, warm, over the hollow and the rock round it
      light = { x: 0, y: 0, r: R * 1.05, h: 110, color: mix(0xffe2a0, lamp, 0.2), power: 0.95 };
    }
  } else if (k === 'scrap' || k === 'sift') {
    if (k === 'sift') {
      // The frame: a ring of bevelled girder lengths, six spokes
      const n = 24;
      for (let i = 0; i < n; i++) {
        const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
        bar(Math.cos(a0) * R * 0.78, Math.sin(a0) * R * 0.78, Math.cos(a1) * R * 0.78, Math.sin(a1) * R * 0.78, 34, lift(0x6d7a86), M.metal, 10);
      }
      for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2; bar(Math.cos(a) * 30, Math.sin(a) * 30, Math.cos(a) * R * 0.76, Math.sin(a) * R * 0.76, 20, lift(0x55616c), M.strip, 7); }
    }
    const plates = k === 'scrap' ? 26 : 10;
    const PAL = [0x6b6660, 0x7d6a58, 0x585450, 0x8a5a3a];
    for (let i = 0; i < plates; i++) {
      const a = rnd() * Math.PI * 2, d = R * (0.3 + rnd() * 0.55);
      const w = 60 + rnd() * 120, h = 30 + rnd() * 60, t = rnd() * Math.PI;
      const pts = plate(Math.cos(a) * d, Math.sin(a) * d, w, h, t);
      // Each plate lies at its own slant, so each catches the light its own way
      const ta = rx() * Math.PI * 2, tm = k === 'scrap' ? 0.15 + rx() * 0.35 : 0.08;
      if (k === 'scrap') panel(pts, lift(PAL[i % 4], 1.2), i % 4 === 2 ? M.metal : M.scrap, { bevel: 12, edge: lift(mix(PAL[i % 4], 0xb0a898, 0.25), 1.2), split: 2, tilt: [Math.cos(ta) * tm, Math.sin(ta) * tm] });
      else panel(pts, lift(0x7a8692, 1.15), M.plating, { bevel: 12, edge: lift(0x95a2ae), split: 2, tilt: [Math.cos(ta) * tm, Math.sin(ta) * tm], axis: t });
    }
    if (k === 'scrap') {
      // Girders across the heap
      for (let i = 0; i < 6; i++) {
        const a = rx() * Math.PI * 2, d = R * (0.35 + rx() * 0.4), t = rx() * Math.PI, l = 140 + rx() * 160, x = Math.cos(a) * d, y = Math.sin(a) * d;
        bar(x - Math.cos(t) * l, y - Math.sin(t) * l, x + Math.cos(t) * l, y + Math.sin(t) * l, 24, lift(0x6a6662, 1.2), M.scrap, 8);
      }
      // Rare glints: small bright chips at steep slants, flashing as the heap turns them through the light (gone far off)
      for (let i = 0; i < 12; i++) {
        const a = rx() * Math.PI * 2, d = R * (0.25 + rx() * 0.6), x = Math.cos(a) * d, y = Math.sin(a) * d, ta = rx() * Math.PI * 2, tm = 0.3 + rx() * 0.6;
        panel(plate(x, y, 10 + rx() * 14, 6 + rx() * 8, rx() * Math.PI), 0x5e6268, M.chrome, { bevel: 0, tilt: [Math.cos(ta) * tm, Math.sin(ta) * tm], fine: true });
      }
      // The lump of greyseam: a rock body veined all over, the veins dull grey with a faint glow of their own (kept faint)
      for (let i = 0; i < 9; i++) rnd();
      g.boulder(bodyId, R * 0.36, compOf('silicate'), lift(0x55595e, 1.25), 0, 0, 1);
      for (let i = 0; i < 5; i++) rnd();
      glows.push({ x: 0, y: 0, r: R * 0.42, color: 0xd8dde6, a: 0.12 });
      for (let i = 0; i < 3; i++) { const a = (i / 3) * Math.PI * 2 + 0.5; lampAt(Math.cos(a) * R * 0.7, Math.sin(a) * R * 0.7, 18, lamp, 0.7); }
      // The light: the first lamp's, over the heap
      light = { x: Math.cos(0.5) * R * 0.7, y: Math.sin(0.5) * R * 0.7, r: R * 1.1, h: 110, color: lamp, power: 1.0 };
    } else {
      // Crystal held in the frame: facetted, faintly glowing, lighting the frame round it
      for (let i = 0; i < 7; i++) {
        const a = rnd() * Math.PI * 2, d = R * rnd() * 0.5, r = 40 + rnd() * 50, x = Math.cos(a) * d, y = Math.sin(a) * d;
        g.gem([x, y - r * 1.6, x + r * 0.6, y, x, y + r * 1.6, x - r * 0.6, y], x, y, 0.6, 0x6ec8e6, 0.22, { mat: M.crystal, seed: rx(), S: 160 });
        glows.push({ x, y, r: r * 2.4, color: 0x9fe8ff, a: 0.22 });
      }
      for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2; lampAt(Math.cos(a) * R * 0.78, Math.sin(a) * R * 0.78, 16, lamp, 0.7); }
      light = { x: 0, y: 0, r: R * 1.1, h: 70, color: 0x9fe8ff, power: 1.15 };
    }
  } else if (k === 'roost') {
    // Ice shards splayed from a frozen heart, ridged; a soft cold glow inside, and a cold light low at the heart
    for (let i = 0; i < 14; i++) {
      const a = rnd() * Math.PI * 2, len = R * (0.45 + rnd() * 0.55), w = 40 + rnd() * 50;
      shard(0, 0, a, len, w, i % 2 ? 0xbfe4f2 : 0x9cc8dc, M.ice);
    }
    for (let i = 0; i < 8; i++) rnd();
    g.boulder(bodyId, R * 0.38, compOf('ice', 'asteroid_ice'), 0xdff4ff, 0, 0, undefined, 0.12);
    glows.push({ x: 0, y: 0, r: R * 0.7, color: lamp, a: 0.35, pulse: true });
    glows.push({ x: 0, y: 0, r: R * 0.3, color: 0xe8f8ff, a: 0.3 });
    light = { x: 0, y: 0, r: R * 1.2, h: 60, color: mix(lamp, 0xd8f4ff, 0.4), power: 1.3 };
  } else if (k === 'shrine') {
    // A hull welded into a furnace: soot-blackened vanes and collar (darker towards the mouth), the mouth a bowl, the fire in it
    const soot = (v0: number, dark: number) => g.shade(v0, (x, y) => { const d = Math.hypot(x, y) / R; return dark + (1 - dark) * Math.min(1, Math.max(0, (d - 0.3) / 0.6)); });
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2, v0 = g.vertexCount;
      panel([Math.cos(a - 0.2) * R * 0.4, Math.sin(a - 0.2) * R * 0.4, Math.cos(a) * R * 0.95, Math.sin(a) * R * 0.95, Math.cos(a + 0.2) * R * 0.4, Math.sin(a + 0.2) * R * 0.4], lift(0x4a3630, 1.35), M.soot, { bevel: 18, edge: lift(0x5e4a40, 1.3), split: 3 });
      soot(v0, 0.45);
    }
    let v0 = g.vertexCount;
    panel(Array.from({ length: 28 }, (_, i) => { const a = (Math.floor(i / 2) / 14) * Math.PI * 2; return i % 2 ? Math.sin(a) * R * 0.48 : Math.cos(a) * R * 0.48; }), lift(0x5a423a, 1.25), M.soot, { bevel: 30, edge: lift(0x6a5248, 1.2), rings: 3 });
    soot(v0, 0.4);
    v0 = g.vertexCount;
    g.bowl(0, 0, R * 0.3, 0x3a1a10, { rings: 3 }, 16);
    g.tag(v0, { mat: M.soot, smooth: [0, 0, 1] });
    v0 = g.vertexCount;
    g.disc(0, 0, R * 0.2, 0xff8a3a, { glow: 1, rings: 2 }, 16);
    g.disc(0, 0, R * 0.09, 0xffd890, { glow: 1 }, 12);
    lit(v0, M.soot);
    glows.push({ x: 0, y: 0, r: R * 0.75, color: 0xff7a2a, a: 0.55, flicker: true });
    glows.push({ x: 0, y: 0, r: R * 0.3, color: 0xffd27a, a: 0.6, flicker: true });
    for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; lampAt(Math.cos(a) * R * 0.9, Math.sin(a) * R * 0.9, 14, lamp, 0.8); }
    light = { x: 0, y: 0, r: R * 1.35, h: 80, color: 0xff8a3a, power: 2.0, flicker: true };
  } else if (k === 'dock') {
    // A cradle: station plating with gold trim (bright highlights), clamp arms, blades racked on it
    const gold = lift(0xd9b45a, 1.1);
    panel(rect(-R * 0.75, -R * 0.18, R * 1.5, R * 0.36), lift(0x8f9bab, 1.15), M.plating, { bevel: 18, edge: lift(0xa8b4c2, 1.1), split: 5 });
    for (const y of [-R * 0.18, R * 0.18]) bar(-R * 0.75, y, R * 0.75, y, 22, gold, M.gold, 7);
    for (const x of [-R * 0.75, R * 0.75]) bar(x, -R * 0.18, x, R * 0.18, 22, gold, M.gold, 7);
    for (const sx of [-1, 1]) {
      panel(rect(sx * R * 0.62 - 40, -R * 0.7, 80, R * 1.4), lift(0x6d7888, 1.2), M.plating, { bevel: 14, edge: lift(0x8692a2, 1.15), split: 5, axis: Math.PI / 2 });
      for (const sy of [-1, 1]) bar(sx * R * 0.62, sy * R * 0.7, sx * R * 0.95, sy * R * 0.9, 22, lift(0xb8c4d4, 1.05), M.strip, 7);
    }
    for (let i = -2; i <= 2; i++) {
      const x = i * R * 0.22 - 30;
      panel(rect(x - 7, -R * 0.5 - 7, 74, R * 0.28 + 14), gold, M.gold, { bevel: 6 });
      panel(rect(x, -R * 0.5, 60, R * 0.28), lift(0x1c3a63, 1.2), M.blade, { bevel: 4 });
    }
    let v0 = g.vertexCount;
    g.disc(0, 0, 82, gold, { bevel: 10 }, 24);
    g.tag(v0, { mat: M.gold, seed: rx() });
    v0 = g.vertexCount;
    g.disc(0, 0, 68, lift(0x3a4250, 1.25), { bevel: 14, edge: lift(0x4e5868, 1.2), rings: 2 }, 24);
    g.tag(v0, { mat: M.plating, seed: rx() });
    v0 = g.vertexCount;
    g.disc(0, 0, 18, 0xffe0a0, { glow: 1 }, 12);
    lit(v0, M.plating);
    glows.push({ x: 0, y: 0, r: 110, color: 0xffd890, a: 0.5 });
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) lampAt(sx * R * 0.95, sy * R * 0.9, 18, lamp, 0.8);
    light = { x: 0, y: 0, r: R * 1.1, h: 110, color: 0xffd890, power: 1.1 };
  } else {
    // A knot: dark glassy shards on two arms round a point, each circling at its own rate (inner faster) and tumbling;
    // a pale light low at the heart lights their inner faces
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 4 + rnd() * 0.3, d = R * (0.2 + (i / 18) * 0.7);
      const pts = rock(40 + rnd() * 70, 5, 0.4, Math.cos(a) * d, Math.sin(a) * d);
      const rate = 0.05 * Math.pow(0.5 / (0.2 + (i / 18) * 0.7), 0.85) * (0.85 + rx() * 0.3), tum = (rx() - 0.5) * 0.6;
      stone(pts, lift(i % 3 ? 0x2a2633 : 0x3a3446, 1.45), M.knot, 0.15, { orb: [rate, tum] });
    }
    // Finer debris between the arms (gone far off)
    for (let i = 0; i < 30; i++) {
      const a = rx() * Math.PI * 2, dn = 0.15 + rx() * 0.8, d = R * dn, r = 10 + rx() * 22, x = Math.cos(a) * d, y = Math.sin(a) * d;
      const pts: number[] = [];
      for (let q = 0; q < 5; q++) { const b = (q / 5) * Math.PI * 2, rr = r * (0.6 + rx() * 0.8); pts.push(x + Math.cos(b) * rr, y + Math.sin(b) * rr); }
      stone(pts, lift(0x2e2a38, 1.45), M.knot, 0.1, { orb: [0.05 * Math.pow(0.5 / dn, 0.85) * (0.8 + rx() * 0.4), (rx() - 0.5) * 1.2], fine: true });
    }
    const v0 = g.vertexCount;
    g.disc(0, 0, 16, 0xf2e8ff, { glow: 1 }, 10);
    lit(v0, M.knot);
    glows.push({ x: 0, y: 0, r: 230, color: lamp, a: 0.42, pulse: true });
    glows.push({ x: 0, y: 0, r: 80, color: 0xf2e8ff, a: 0.55 });
    light = { x: 0, y: 0, r: R * 1.2, h: 40, color: mix(0xf2e8ff, lamp, 0.35), power: 1.8 };
  }
  return { geo: g, light, glows };
}
