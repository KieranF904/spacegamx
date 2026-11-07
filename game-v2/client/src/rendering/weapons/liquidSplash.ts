/**
 * The liquid layer of a layered impact (ImpactLayers.liquid: the Impact Lab's "Liquid splash", prototypes/impact-fx):
 * heavy, syrupy blobs thrown up between the surface's normal and the rebound that fall back under a pull toward the
 * surface, stretched by their speed, each sticking where it lands as a small smear along the surface; and a film at the
 * hit that creeps along the surface the way the beam was sliding and thins as it cools, hot to crust.
 *
 * A fixed pool (structure of arrays, swap-remove, capped): no allocation per frame. Everything rides what it hit (an
 * ImpactAnchor, bound by WeaponFx.grouped): the blob's position, velocity and launch plane, the film's place and its
 * surface, all moved and turned with the target each frame, so a splash stays on a ship that flies and turns.
 * WeaponFx draws it through a LiquidSink (its glow pool's soft lines and dots).
 */

import type { LiquidLayer } from './weaponStyles';
import type { ImpactAnchor } from './impactAnchor';

/** How WeaponFx draws: a soft line with round ends, a soft glow and a filled disc (all its glow pool's, normal blend) */
export interface LiquidSink {
  line(x0: number, y0: number, x1: number, y1: number, width: number, color: number, alpha: number): void;
  dot(x: number, y: number, r: number, color: number, alpha: number): void;
  disc(x: number, y: number, r: number, color: number, alpha: number): void;
}

/** Where and how a hit struck (WeaponFx's Aim, read only): the surface normal (facing the shot), and the shot's direction (0, 0: unknown) */
export interface LiquidHit { nx: number; ny: number; dx: number; dy: number }

/** Blobs and films live at most (past it new ones are skipped) */
export const LIQUID_CAP = 360;
const BLOB = 0, FILM = 1;
/** A blob's drag a frame, and its streak's length × its speed (the thick-liquid stretch) */
const BLOB_DRAG = 0.99, STRETCH = 2.2;

function mix(a: number, b: number, t: number): number {
  const u = t <= 0 ? 0 : t >= 1 ? 1 : t, v = 1 - u;
  return ((((a >> 16) & 255) * v + ((b >> 16) & 255) * u) << 16) | ((((a >> 8) & 255) * v + ((b >> 8) & 255) * u) << 8) | ((a & 255) * v + (b & 255) * u);
}

export class LiquidFx {
  /** Live blobs and films (indices 0..n-1) */
  n = 0;
  private readonly kind = new Uint8Array(LIQUID_CAP);
  /** Blob: its place; film: its root on the surface */
  private readonly x = new Float32Array(LIQUID_CAP);
  private readonly y = new Float32Array(LIQUID_CAP);
  /** Blob: its velocity (world units a frame, relative to what it came off) */
  private readonly vx = new Float32Array(LIQUID_CAP);
  private readonly vy = new Float32Array(LIQUID_CAP);
  /** The surface's normal, turned with the target */
  private readonly nx = new Float32Array(LIQUID_CAP);
  private readonly ny = new Float32Array(LIQUID_CAP);
  /** Blob: a point on the plane it left from (it lands back past it) */
  private readonly px = new Float32Array(LIQUID_CAP);
  private readonly py = new Float32Array(LIQUID_CAP);
  private readonly age = new Float32Array(LIQUID_CAP);
  private readonly life = new Float32Array(LIQUID_CAP);
  /** Blob: its width; film: its thickness */
  private readonly size = new Float32Array(LIQUID_CAP);
  /** Blob: its pull a frame. Film: its creep a frame */
  private readonly pull = new Float32Array(LIQUID_CAP);
  /** Film: its reach ahead along `dir` and behind, the frames it spreads over, and which way along the tangent it creeps (±1) */
  private readonly fwd = new Float32Array(LIQUID_CAP);
  private readonly back = new Float32Array(LIQUID_CAP);
  private readonly grow = new Float32Array(LIQUID_CAP);
  private readonly dir = new Float32Array(LIQUID_CAP);
  /** Blob: how long a smear it leaves lives, and how far along the surface from where it left it can still land (past that it fell off the edge: no smear) */
  private readonly smear = new Float32Array(LIQUID_CAP);
  private readonly hot = new Uint32Array(LIQUID_CAP);
  private readonly cool = new Uint32Array(LIQUID_CAP);
  private readonly anc: (ImpactAnchor | undefined)[] = new Array(LIQUID_CAP).fill(undefined);
  /** Share of the blobs and landing smears made (the quality setting's particles) */
  keep = 1;
  private readonly pt = { x: 0, y: 0 };

  private add(kind: number, x: number, y: number, nx: number, ny: number, life: number, size: number, hot: number, cool: number): number {
    if (this.n >= LIQUID_CAP) return -1;
    const i = this.n++;
    this.kind[i] = kind; this.x[i] = x; this.y[i] = y; this.nx[i] = nx; this.ny[i] = ny; this.vx[i] = 0; this.vy[i] = 0;
    this.px[i] = x; this.py[i] = y; this.age[i] = 0; this.life[i] = Math.max(1, life); this.size[i] = size; this.pull[i] = 0;
    this.fwd[i] = 0; this.back[i] = 0; this.grow[i] = 1; this.dir[i] = 1; this.smear[i] = 0; this.hot[i] = hot; this.cool[i] = cool; this.anc[i] = undefined;
    return i;
  }

  /** A film on the surface at (x, y) (normal nx, ny): `fwd` ahead along `dir` (±1 along the tangent), `back` behind, spreading over `grow` frames and creeping at `creep` */
  private film(x: number, y: number, nx: number, ny: number, dir: number, fwd: number, back: number, thick: number, life: number, grow: number, creep: number, hot: number, cool: number): number {
    const i = this.add(FILM, x, y, nx, ny, life, thick, hot, cool);
    if (i < 0) return i;
    this.dir[i] = dir; this.fwd[i] = fwd; this.back[i] = back; this.grow[i] = Math.max(1, grow); this.pull[i] = creep;
    return i;
  }

  /** A liquid splash at (x, y) for a hit `h`, its layer `L`, scaled by `k` (WeaponFx.impactScale) */
  spawn(L: LiquidLayer, x: number, y: number, h: LiquidHit, k: number): void {
    const nx = h.nx, ny = h.ny, tx = -ny, ty = nx;
    // How far it grazed (the shot's direction along the surface) and which way it slid
    const along = h.dx * tx + h.dy * ty, known = h.dx !== 0 || h.dy !== 0;
    const g = known ? Math.min(1, Math.abs(along)) : 0.4, sdir = known ? (along >= 0 ? 1 : -1) : Math.random() < 0.5 ? 1 : -1;
    const F = L.film, kt = Math.pow(k, 0.6);
    // The pool: mostly creeping the way it slid, a little back the other way
    this.film(x, y, nx, ny, sdir, F.length * k * (0.6 + 0.8 * g), F.length * 0.4 * k * (1.2 - g), F.thickness * kt, F.life, 4, F.creep * (0.3 + g), L.hot, L.cool);
    if (g < 0.7) this.film(x, y, nx, ny, -sdir, F.length * 0.4 * k, F.length * 0.1, F.thickness * 0.7 * kt, F.life * 0.8, 5, F.creep * 0.4 * (1 - g), L.hot, L.cool);
    // The blobs: fanned round an axis between the normal and the rebound, never into the surface
    const B = L.blobs, dn = h.dx * nx + h.dy * ny, rx = known ? h.dx - 2 * dn * nx : nx, ry = known ? h.dy - 2 * dn * ny : ny;
    const bias = B.bias ?? 0.35;
    let ax = nx * (1 - bias) + rx * bias, ay = ny * (1 - bias) + ry * bias;
    const al = Math.hypot(ax, ay) || 1; ax /= al; ay /= al;
    const n = Math.round(B.count * Math.min(1.5, k) * this.keep), cone = (B.cone * Math.PI) / 180;
    for (let j = 0; j < n; j++) {
      const sp = ((j + 0.5) / n - 0.5) * cone + (Math.random() - 0.5) * 0.2, c = Math.cos(sp), s = Math.sin(sp);
      let dx = ax * c - ay * s, dy = ax * s + ay * c;
      const out = dx * nx + dy * ny;
      if (out < 0.3) { dx += nx * (0.3 - out); dy += ny * (0.3 - out); const l = Math.hypot(dx, dy); dx /= l; dy /= l; }
      const v = B.speed * Math.sqrt(k) * (0.6 + Math.random() * 0.5);
      const i = this.add(BLOB, x + nx * 1.2, y + ny * 1.2, nx, ny, B.life * (0.8 + Math.random() * 0.4), B.size * Math.pow(k, 0.45) * (0.8 + Math.random() * 0.5), L.hot, L.cool);
      if (i < 0) return;
      this.vx[i] = dx * v; this.vy[i] = dy * v; this.px[i] = x; this.py[i] = y;
      this.pull[i] = B.pull * (0.8 + Math.random() * 0.4); this.smear[i] = F.life * 0.6; this.fwd[i] = F.length * k;
    }
  }

  /** What was made from index `from` on rides `anc` (WeaponFx.grouped) */
  bind(from: number, anc: ImpactAnchor): void {
    for (let i = from; i < this.n; i++) {
      this.anc[i] = anc;
      anc.hold(this.life[i] - this.age[i] + (this.kind[i] === BLOB ? this.smear[i] : 0) + 2);
    }
  }

  private kill(i: number): void {
    const j = --this.n;
    if (i !== j) {
      this.kind[i] = this.kind[j]; this.x[i] = this.x[j]; this.y[i] = this.y[j]; this.vx[i] = this.vx[j]; this.vy[i] = this.vy[j];
      this.nx[i] = this.nx[j]; this.ny[i] = this.ny[j]; this.px[i] = this.px[j]; this.py[i] = this.py[j]; this.age[i] = this.age[j]; this.life[i] = this.life[j];
      this.size[i] = this.size[j]; this.pull[i] = this.pull[j]; this.fwd[i] = this.fwd[j]; this.back[i] = this.back[j]; this.grow[i] = this.grow[j];
      this.dir[i] = this.dir[j]; this.smear[i] = this.smear[j]; this.hot[i] = this.hot[j]; this.cool[i] = this.cool[j]; this.anc[i] = this.anc[j];
    }
    this.anc[j] = undefined;
  }

  /** One frame (`frames` long): ride, fall, land, age; then draw (films under blobs) */
  update(frames: number, sink: LiquidSink): void {
    const pt = this.pt;
    for (let i = this.n - 1; i >= 0; i--) {
      this.age[i] += frames;
      if (this.age[i] >= this.life[i]) { this.kill(i); continue; }
      // (on what it hit: moved and turned with it)
      const a = this.anc[i];
      if (a) {
        pt.x = this.x[i]; pt.y = this.y[i]; a.move(pt); this.x[i] = pt.x; this.y[i] = pt.y;
        if (a.turn !== 0) {
          const c = Math.cos(a.turn), s = Math.sin(a.turn), nx = this.nx[i], ny = this.ny[i], vx = this.vx[i], vy = this.vy[i];
          this.nx[i] = nx * c - ny * s; this.ny[i] = nx * s + ny * c;
          this.vx[i] = vx * c - vy * s; this.vy[i] = vx * s + vy * c;
        }
      }
      if (this.kind[i] !== BLOB) continue;
      if (a) { pt.x = this.px[i]; pt.y = this.py[i]; a.move(pt); this.px[i] = pt.x; this.py[i] = pt.y; }
      // Pulled back toward the surface, slowing a little
      const nx = this.nx[i], ny = this.ny[i], p = this.pull[i] * frames, d = Math.pow(BLOB_DRAG, frames);
      this.vx[i] = (this.vx[i] - nx * p) * d; this.vy[i] = (this.vy[i] - ny * p) * d;
      this.x[i] += this.vx[i] * frames; this.y[i] += this.vy[i] * frames;
      const below = (this.x[i] - this.px[i]) * nx + (this.y[i] - this.py[i]) * ny;
      if (below < 0 && this.age[i] > 2) {
        // It lands: sticks as a small smear along the surface, the way it was moving
        // (only near where it left: the surface is taken as flat, so one that flew further fell past the hull's edge)
        const off = (this.x[i] - this.px[i]) * -ny + (this.y[i] - this.py[i]) * nx;
        if (Math.abs(off) <= this.fwd[i] && (this.keep >= 1 || Math.random() < this.keep)) {
          const vt = -this.vx[i] * ny + this.vy[i] * nx, av = Math.abs(vt), sz = this.size[i], t = this.age[i] / this.life[i];
          const j = this.film(this.x[i] - nx * below, this.y[i] - ny * below, nx, ny, vt >= 0 ? 1 : -1, 2 + av * 3, 1 + sz * 0.6, sz * 0.75, this.smear[i], 6, av * 0.12,
            mix(this.hot[i], this.cool[i], t * 0.6), this.cool[i]);
          if (j >= 0 && a) { this.anc[j] = a; a.hold(this.smear[i] + 2); }
        }
        this.kill(i);
      }
    }
    for (let i = 0; i < this.n; i++) if (this.kind[i] === FILM) this.drawFilm(i, sink);
    for (let i = 0; i < this.n; i++) if (this.kind[i] === BLOB) this.drawBlob(i, sink);
  }

  /** A film: a strip along the surface, swelling at its creeping front, thinning and cooling from molten to crust */
  private drawFilm(i: number, sink: LiquidSink): void {
    const age = this.age[i], t = age / this.life[i], nx = this.nx[i], ny = this.ny[i], dir = this.dir[i], flow = this.pull[i];
    const tx = -ny * dir, ty = nx * dir;
    const reach = Math.min(1, age / this.grow[i]), e = 1 - (1 - reach) * (1 - reach);
    const s0 = flow * age * (1 - 0.5 * t), front = s0 + this.fwd[i] * e + flow * age * 0.4, rear = s0 - this.back[i] * e;
    const th = this.size[i] * (1 - 0.55 * t), lift = th * 0.35;
    const x = this.x[i] + nx * lift, y = this.y[i] + ny * lift;
    const x0 = x + tx * rear, y0 = y + ty * rear, x1 = x + tx * front, y1 = y + ty * front;
    const hot = this.hot[i], cool = this.cool[i];
    // The cooled crust under it, the molten film over that, a white-hot vein while it's fresh
    sink.line(x0, y0, x1, y1, th * 1.5, cool, 0.6 * (1 - t * t * t));
    sink.line(x0, y0, x1, y1, th, mix(hot, cool, Math.pow(t, 0.8)), 0.9 * Math.pow(1 - t, 1.6));
    if (t < 0.25) sink.line(x0, y0, x1, y1, th * 0.4, mix(0xffffff, hot, t / 0.25), 0.8 * (1 - t / 0.25));
    // (the bead at its creeping front)
    if (flow > 0) sink.disc(x1 - tx * th * 0.3, y1 - ty * th * 0.3, th * 0.75, mix(hot, cool, t * 0.8), 0.9 * Math.pow(1 - t, 1.4));
  }

  /** A blob: stretched back along its velocity, a soft glow on its head, cooling as it flies */
  private drawBlob(i: number, sink: LiquidSink): void {
    const t = this.age[i] / this.life[i], x = this.x[i], y = this.y[i], vx = this.vx[i], vy = this.vy[i], sz = this.size[i];
    const sp = Math.hypot(vx, vy), len = Math.max(sz * 0.3, sp * STRETCH), ux = sp > 1e-6 ? vx / sp : 0, uy = sp > 1e-6 ? vy / sp : 0;
    const col = mix(this.hot[i], this.cool[i], 0.1 + 0.8 * t), w = sz * (1 - 0.4 * t);
    sink.line(x - ux * len, y - uy * len, x, y, w, col, 1 - t * t);
    sink.dot(x, y, sz * 2.8, this.hot[i], 0.4 * (1 - t));
  }
}
