/**
 * The Lance (lance_lance), the one super-tier gun, drawn as the most formidable beam in the game. Into the beams'
 * additive Graphics (MiningBeamFx, which feeds the bloom), every frame for every Lance on a ship in view:
 *
 *   charging  while its buffer fills (your own: the buffer as it stands; another pilot's: guessed from when it went
 *             out), motes of violet light drawn in to the muzzle round a swelling orb, a ring tightening on it; full,
 *             it sits primed, breathing
 *   lit       it strikes out from the muzzle in a few frames behind a flash and a shock ring, then burns: a soft wide
 *             haze, a violet sheath, a hot lilac body and a white core, its edges crackling, packets of energy
 *             crawling along it and a braid wound round it, the whole thing breathing; at the muzzle a white flare,
 *             a bar of light across it and arcs off the prongs
 *   on a hull it burns in: a white-hot heart in a violet bloom, a ragged flare round it, a splash of light thrown
 *             back, shock rings, sparks and molten droplets, and a burn on the hull that rides the ship, grows the
 *             longer it is held there, glows orange-white and cools slowly after
 *   going out the beam lets go of the muzzle and its last length runs off down the line, thinning to a thread; the
 *             muzzle vents sparks and cools from white through violet to a dull ember while it rests
 *
 * Particles, rings and burns are plain records in capped arrays, recycled in place; one run per Lance (by ship and
 * part), dropped when it hasn't been seen for a frame.
 */

import type { Graphics } from 'pixi.js';
import { drawCone, drawStrands } from './beamLookFx';

/** Seconds the beam takes to reach out from the muzzle when it lights, and the ignition flash to fade */
const STRIKE = 0.07, IGNITE = 0.22;
/** Seconds the going-out takes (its last length running off down the line), and the muzzle to cool after */
const WIND_DOWN = 0.42, COOL = 1.6;
const MAX_PARTICLES = 420, MAX_RINGS = 24, MAX_BURNS = 24;

/** The colours a Lance burns in (its model's BEAM_LOOKS, or its kind's) */
export interface LanceColors { outer: number; mid: number; core: number; braid?: { color: number; strands: number } }

/** One Lance this frame */
export interface LanceFrame {
  /** Lit now */
  lit: boolean;
  /** Its buffer, 0..1 (how near it is to lighting), or -1 if not known */
  charge: number;
  /** Muzzle (where the beam is drawn from) and the beam's direction */
  x: number; y: number; ux: number; uy: number;
  /** How far the beam reaches (to what it meets, or its range) and whether it meets something */
  len: number; hit: boolean;
  /** The ship it burns, if one (its burn rides that ship), and that ship's pose now */
  target: number;
  /** Half-ish width (world units), colours, brightness (a sputter short of power) */
  wid: number; colors: LanceColors; gain: number;
}

interface Run {
  lit: boolean;
  /** Seconds lit (or since it went out) */
  litFor: number; outFor: number;
  /** The last lit beam's length and direction (its going-out runs down it) */
  len: number; ux: number; uy: number;
  /** Seconds burning (it builds heat on a hull) and the next shock ring's countdown */
  burn: number; ring: number;
  /** Its burn on a hull now, if it's on one */
  mark: Burn | null;
  seen: number;
  colors: LanceColors;
}

/** 0 spark (a streak), 1 ember (a fading dot), 2 mote (drawn in to a muzzle) */
interface Particle { kind: number; x: number; y: number; vx: number; vy: number; life: number; max: number; color: number; size: number; tx: number; ty: number }
interface Ring { x: number; y: number; life: number; max: number; r0: number; r1: number; color: number; width: number }
/** A burn on a hull, in its ship's own frame; heat 0..1 */
interface Burn { ship: number; lx: number; ly: number; heat: number; r: number; life: number; max: number; hot: boolean; color: number }

export type ShipPoseOf = (id: number) => { x: number; y: number; angle: number } | null;

export class LanceFx {
  private runs = new Map<number, Run>();
  private particles: Particle[] = [];
  private rings: Ring[] = [];
  private burns: Burn[] = [];
  private t = 0;
  private frameNo = 0;

  /** Once a frame, before the Lances are drawn */
  begin(dt: number): void {
    this.t += dt;
    this.frameNo++;
  }

  /** One Lance's frame (key: ship × 256 + part) */
  draw(g: Graphics, key: number, f: LanceFrame, dt: number, frames: number, pose: ShipPoseOf): void {
    let r = this.runs.get(key);
    if (!r) this.runs.set(key, (r = { lit: false, litFor: 0, outFor: 99, len: f.len, ux: f.ux, uy: f.uy, burn: 0, ring: 0, mark: null, seen: 0, colors: f.colors }));
    r.seen = this.frameNo;
    r.colors = f.colors;
    if (f.lit !== r.lit) {
      r.lit = f.lit;
      if (f.lit) { r.litFor = 0; r.burn = 0; }
      else { r.outFor = 0; this.goneOut(f, r); }
    }
    if (f.lit) {
      r.litFor += dt;
      r.len = f.len; r.ux = f.ux; r.uy = f.uy;
      this.lit(g, r, f, dt, frames, pose);
    } else {
      r.outFor += dt;
      r.mark = null;
      this.unlit(g, r, f, frames);
    }
  }

  /** Lances not seen this frame are forgotten (their particles and burns live on) */
  sweep(): void {
    for (const [k, r] of this.runs) if (r.seen !== this.frameNo) this.runs.delete(k);
  }

  // ---- lit

  private lit(g: Graphics, r: Run, f: LanceFrame, dt: number, frames: number, pose: ShipPoseOf): void {
    const { x, y, ux, uy, colors: c } = f, t = this.t, nx = -uy, ny = ux;
    const ign = Math.max(0, 1 - r.litFor / IGNITE);
    // It strikes out from the muzzle, then breathes
    const reach = f.len * Math.min(1, r.litFor / STRIKE);
    const breathe = 1 + 0.07 * Math.sin(t * 37 + x * 0.01) + 0.04 * Math.sin(t * 91);
    const w = f.wid * breathe * (1 + 0.6 * ign), a = f.gain;
    const ex = x + ux * reach, ey = y + uy * reach;
    // Haze, sheath, body, hot body, core
    // (the haze in three widths, for a soft edge)
    g.moveTo(x, y).lineTo(ex, ey).stroke({ color: c.outer, width: w * 6, alpha: 0.035 * a });
    g.moveTo(x, y).lineTo(ex, ey).stroke({ color: c.outer, width: w * 4.4, alpha: 0.05 * a });
    g.moveTo(x, y).lineTo(ex, ey).stroke({ color: c.outer, width: w * 3, alpha: 0.13 * a });
    g.moveTo(x, y).lineTo(ex, ey).stroke({ color: c.mid, width: w * 1.6, alpha: 0.5 * a });
    g.moveTo(x, y).lineTo(ex, ey).stroke({ color: 0xf0e2ff, width: w * 0.85, alpha: 0.8 * a });
    g.moveTo(x, y).lineTo(ex, ey).stroke({ color: 0xffffff, width: Math.max(1.5, w * 0.4), alpha: a });
    // The ignition: the whole line white-hot for a moment
    if (ign > 0) g.moveTo(x, y).lineTo(ex, ey).stroke({ color: 0xffffff, width: w * 2.2 * ign, alpha: 0.7 * ign * a });
    if (reach > 8) {
      // Crackling edges: a jagged thread down each side, new every frame
      const n = Math.max(4, Math.min(30, Math.round(reach / 24)));
      for (const s of [-1, 1]) {
        g.moveTo(x + nx * s * w * 0.9, y + ny * s * w * 0.9);
        for (let i = 1; i <= n; i++) {
          const d = (reach * i) / n, o = s * w * (0.95 + 0.75 * Math.random()) * (i === n ? 0.5 : 1);
          g.lineTo(x + ux * d + nx * o, y + uy * d + ny * o);
        }
        g.stroke({ color: 0xe9d5ff, width: 1.3, alpha: 0.5 * a });
      }
      // A braid wound round it
      if (c.braid) drawStrands(g, x, y, ux, uy, reach, w * 0.7, c.braid.strands, c.braid.color, 0.45 * a, t, x * 0.003);
      // Packets of energy crawling out along it
      const packets = Math.max(3, Math.min(9, Math.round(reach / 70)));
      for (let k = 0; k < packets; k++) {
        const u = (t * 1.9 + k / packets + (k * 0.37) % 0.2) % 1, d = u * reach, l = w * (2.2 + 1.2 * Math.sin(k * 2.1 + t * 7));
        const s = Math.sin(u * Math.PI);
        g.moveTo(x + ux * Math.max(0, d - l), y + uy * Math.max(0, d - l)).lineTo(x + ux * d, y + uy * d)
          .stroke({ color: 0xffffff, width: w * 1.05, alpha: 0.55 * s * a });
      }
    }
    // The muzzle: a flare, a bar of light across it, arcs off the prongs
    const fl = 0.85 + 0.15 * Math.sin(t * 53);
    g.circle(x, y, w * 2.5).fill({ color: c.outer, alpha: 0.14 * a });
    g.circle(x, y, w * 1.5).fill({ color: c.mid, alpha: 0.4 * a * fl });
    g.circle(x, y, w * 0.9).fill({ color: 0xf5ecff, alpha: 0.85 * a });
    g.circle(x, y, w * 0.5).fill({ color: 0xffffff, alpha: a });
    const bar = w * (2.6 + 0.8 * Math.sin(t * 29)) * (1 + ign);
    g.moveTo(x - nx * bar, y - ny * bar).lineTo(x + nx * bar, y + ny * bar).stroke({ color: 0xffffff, width: 1.6, alpha: 0.45 * a * fl });
    g.moveTo(x - ux * bar * 0.6, y - uy * bar * 0.6).lineTo(x + ux * bar * 0.9, y + uy * bar * 0.9).stroke({ color: 0xf5ecff, width: 1.2, alpha: 0.3 * a });
    for (const s of [-1, 1]) {
      const ang = Math.atan2(uy, ux) + s * (0.55 + 0.3 * Math.sin(t * 40 + s)), l = w * (2.2 + 1.8 * Math.random());
      const mx = x + Math.cos(ang) * l * 0.5 + (Math.random() - 0.5) * w * 0.6, my = y + Math.sin(ang) * l * 0.5 + (Math.random() - 0.5) * w * 0.6;
      g.moveTo(x, y).lineTo(mx, my).lineTo(x + Math.cos(ang) * l, y + Math.sin(ang) * l).stroke({ color: c.core, width: 1.2, alpha: 0.85 * a });
    }
    if (ign > 0) {
      // A shock ring off the muzzle as it lights
      const p = 1 - ign;
      g.circle(x, y, w * (1.2 + 4.5 * p)).stroke({ color: c.mid, width: 1.5 + 2.5 * ign, alpha: 0.7 * ign });
      g.circle(x, y, w * (0.8 + 1.4 * ign)).fill({ color: 0xffffff, alpha: 0.45 * ign });
    }
    if (f.hit && reach >= f.len - 0.5) this.impact(g, r, f, w, dt, frames, pose);
    else { if (r.mark) r.mark.hot = false; r.mark = null; }
  }

  /** Where it lands on something: it burns in */
  private impact(g: Graphics, r: Run, f: LanceFrame, w: number, dt: number, frames: number, pose: ShipPoseOf): void {
    const hx = f.x + f.ux * f.len, hy = f.y + f.uy * f.len, c = f.colors, a = f.gain, t = this.t;
    r.burn += dt;
    const heat = Math.min(1, r.burn / 1.4);
    // A ragged flare round the heart, new every frame
    const spikes = 9, base = Math.random() * Math.PI * 2;
    g.moveTo(hx + Math.cos(base) * w * 2.4, hy + Math.sin(base) * w * 2.4);
    for (let i = 1; i < spikes * 2; i++) {
      const ang = base + (i * Math.PI) / spikes, rr = w * (i % 2 ? 0.9 : 1.6 + 1.4 * Math.random()) * (1 + 0.3 * heat);
      g.lineTo(hx + Math.cos(ang) * rr, hy + Math.sin(ang) * rr);
    }
    g.closePath().fill({ color: c.mid, alpha: 0.38 * a });
    // Light thrown back off the hull
    drawCone(g, hx, hy, -f.ux, -f.uy, w * 6, 38, c.mid, 0.3 * a);
    g.circle(hx, hy, w * 4).fill({ color: c.outer, alpha: 0.13 * a });
    g.circle(hx, hy, w * 2.4).fill({ color: c.mid, alpha: 0.42 * a });
    g.circle(hx, hy, w * (1.35 + 0.25 * Math.sin(t * 47))).fill({ color: 0xfdf4ff, alpha: 0.9 * a });
    g.circle(hx, hy, w * 0.7).fill({ color: 0xffffff, alpha: a });
    // Shock rings, a few a second
    r.ring -= dt;
    if (r.ring <= 0) {
      r.ring = 0.18 + Math.random() * 0.08;
      this.ring(hx, hy, w, w * (3.5 + heat * 1.5), 14, c.mid, 2.2);
    }
    // Sparks and molten droplets thrown back off the hull, more as it burns in
    const back = Math.atan2(-f.uy, -f.ux);
    const n = (2 + 2.5 * heat) * frames * a;
    for (let i = 0; i < n; i++) {
      const ang = back + (Math.random() - 0.5) * 2.6, s = 3 + Math.random() * (7 + 5 * heat);
      this.particle(0, hx, hy, Math.cos(ang) * s, Math.sin(ang) * s, 8 + Math.random() * 12, Math.random() < 0.5 ? 0xfff1d6 : 0xffb366, 1.4);
    }
    if (Math.random() < (0.3 + 0.5 * heat) * frames * a) {
      const ang = back + (Math.random() - 0.5) * 3, s = 0.6 + Math.random() * 2.2;
      this.particle(1, hx, hy, Math.cos(ang) * s, Math.sin(ang) * s, 20 + Math.random() * 24, Math.random() < 0.6 ? 0xff8a3a : c.mid, w * (0.12 + 0.1 * Math.random()));
    }
    // The burn on the hull: riding its ship, building heat while the beam holds near it (on a ship only: rock and
    // wreckage just flare)
    const p = f.target >= 0 ? pose(f.target) : null;
    if (!p) { if (r.mark) r.mark.hot = false; r.mark = null; return; }
    const dx = hx - p.x, dy = hy - p.y, ca = Math.cos(p.angle), sa = Math.sin(p.angle);
    const lx = dx * ca + dy * sa, ly = -dx * sa + dy * ca, ship = f.target;
    let b = r.mark ?? undefined;
    if (!b || !this.burns.includes(b) || b.ship !== ship || Math.hypot(b.lx - lx, b.ly - ly) > w * 1.6) {
      if (b) b.hot = false;
      if (this.burns.length >= MAX_BURNS) this.burns.shift();
      b = { ship, lx, ly, heat: 0, r: w * 0.8, life: 0, max: 100, hot: true, color: 0xff6a1a };
      this.burns.push(b);
    }
    // (follows the beam a little as it wanders over the hull)
    b.lx += (lx - b.lx) * 0.2; b.ly += (ly - b.ly) * 0.2;
    b.heat = Math.min(1, b.heat + dt / 1.2);
    b.r = Math.min(w * 1.5, b.r + dt * w * 0.6);
    b.life = 0; b.hot = true;
    r.mark = b;
  }

  // ---- not lit: going out, resting, charging, primed

  private goneOut(f: LanceFrame, r: Run): void {
    // Vents: sparks off the muzzle to either side
    const nx = -r.uy, ny = r.ux;
    for (let i = 0; i < 14; i++) {
      const s = (i % 2 ? 1 : -1), sp = 1.5 + Math.random() * 4;
      this.particle(0, f.x, f.y, nx * s * sp - r.ux * Math.random() * 2, ny * s * sp - r.uy * Math.random() * 2, 10 + Math.random() * 14, i % 3 ? 0xe9d5ff : 0xffffff, 1.2);
    }
    this.ring(f.x, f.y, f.wid * 0.8, f.wid * 4, 16, f.colors.mid, 2);
    if (r.mark) r.mark.hot = false;
  }

  private unlit(g: Graphics, r: Run, f: LanceFrame, frames: number): void {
    const { x, y, colors: c } = f, t = this.t, w = f.wid;
    // Going out: the beam lets go of the muzzle and its last length runs off down the line, thinning to a thread
    if (r.outFor < WIND_DOWN) {
      const p = r.outFor / WIND_DOWN, e = p * p;
      const d0 = r.len * e, d1 = r.len * Math.min(1, e + 0.12 + 0.6 * (1 - p)) ;
      const tw = w * Math.pow(1 - p, 1.4), a = (1 - p) * f.gain;
      if (d1 > d0 + 1) {
        const ax = x + r.ux * d0, ay = y + r.uy * d0, bx = x + r.ux * d1, by = y + r.uy * d1;
        g.moveTo(ax, ay).lineTo(bx, by).stroke({ color: c.outer, width: tw * 3, alpha: 0.18 * a });
        g.moveTo(ax, ay).lineTo(bx, by).stroke({ color: c.mid, width: tw * 1.4, alpha: 0.5 * a });
        g.moveTo(ax, ay).lineTo(bx, by).stroke({ color: 0xffffff, width: Math.max(1, tw * 0.45), alpha: Math.min(1, 1.4 * a) });
        g.circle(bx, by, tw * 1.4).fill({ color: c.mid, alpha: 0.5 * a });
      }
    }
    // The muzzle cooling: white, then violet, then a dull ember, while it rests
    if (r.outFor < COOL) {
      const p = r.outFor / COOL, k = 1 - p;
      g.circle(x, y, w * (0.5 + 0.7 * k)).fill({ color: p < 0.25 ? c.mid : p < 0.6 ? c.outer : 0xb4532a, alpha: 0.5 * k * k });
      g.circle(x, y, w * 0.32).fill({ color: p < 0.3 ? 0xffffff : 0xff9a5c, alpha: 0.65 * k });
    }
    // Charging: motes drawn in to the muzzle round a swelling orb, a ring tightening on it; full, it sits primed, breathing
    const q = f.charge;
    if (q > 0.02 && r.outFor > WIND_DOWN * 0.6) {
      const full = q >= 0.985;
      const orb = w * (0.35 + 0.9 * q) * (full ? 1 + 0.12 * Math.sin(t * 9) : 1);
      g.circle(x, y, orb * 2).fill({ color: c.outer, alpha: 0.12 * q });
      g.circle(x, y, orb * 1.5).fill({ color: c.mid, alpha: 0.3 * q });
      g.circle(x, y, orb * 0.7).fill({ color: 0xf5ecff, alpha: 0.35 + 0.55 * q });
      if (!full) {
        const ring = w * (4.5 - 3.2 * q) + w * 0.4 * Math.sin(t * 20);
        g.circle(x, y, ring).stroke({ color: c.mid, width: 1.4, alpha: 0.15 + 0.5 * q });
        // Motes falling in (more as it fills)
        if (Math.random() < (0.4 + 1.2 * q) * frames) {
          const ang = Math.random() * Math.PI * 2, rr = w * (3 + 3 * Math.random());
          this.particle(2, x + Math.cos(ang) * rr, y + Math.sin(ang) * rr, 0, 0, 14 + Math.random() * 10, Math.random() < 0.5 ? 0xffffff : c.mid, 1.6, x, y);
        }
      } else {
        // Primed: a slow ring breathing out from it, a twinkle across
        const p = (t * 0.9) % 1;
        g.circle(x, y, orb * (1.2 + 2.2 * p)).stroke({ color: c.mid, width: 1.3, alpha: 0.45 * (1 - p) });
        const tw = orb * (1.8 + 0.6 * Math.sin(t * 6)), nx = -f.uy, ny = f.ux;
        g.moveTo(x - nx * tw, y - ny * tw).lineTo(x + nx * tw, y + ny * tw).stroke({ color: 0xffffff, width: 1, alpha: 0.4 });
      }
    }
  }

  // ---- particles, rings and burns

  private particle(kind: number, x: number, y: number, vx: number, vy: number, max: number, color: number, size: number, tx = 0, ty = 0): void {
    if (this.particles.length >= MAX_PARTICLES) return;
    this.particles.push({ kind, x, y, vx, vy, life: 0, max, color, size, tx, ty });
  }

  private ring(x: number, y: number, r0: number, r1: number, max: number, color: number, width: number): void {
    if (this.rings.length >= MAX_RINGS) this.rings.shift();
    this.rings.push({ x, y, life: 0, max, r0, r1, color, width });
  }

  /** Every Lance's particles, rings and burns move on and fade (once a frame, after the Lances) */
  drawAfter(g: Graphics, frames: number, pose: ShipPoseOf): void {
    // Burns first (under the sparks): riding their ships, cooling from white-orange to a dull red glow
    let s = 0;
    for (const b of this.burns) {
      if (!b.hot) b.life += frames;
      if (b.life >= b.max) continue;
      const p = pose(b.ship);
      if (!p) continue;
      const ca = Math.cos(p.angle), sa = Math.sin(p.angle);
      const x = p.x + b.lx * ca - b.ly * sa, y = p.y + b.lx * sa + b.ly * ca;
      const k = (1 - b.life / b.max) * (0.4 + 0.6 * b.heat);
      g.circle(x, y, b.r * 1.6).fill({ color: 0x9a2a10, alpha: 0.16 * k });
      g.circle(x, y, b.r * 1.15).fill({ color: b.color, alpha: 0.45 * k });
      if (k > 0.35) g.circle(x, y, b.r * 0.55).fill({ color: 0xffd9a0, alpha: 0.7 * (k - 0.35) / 0.65 });
      this.burns[s++] = b;
    }
    this.burns.length = s;
    let w = 0;
    for (const p of this.particles) {
      p.life += frames;
      if (p.life >= p.max) continue;
      const f = 1 - p.life / p.max;
      if (p.kind === 2) {
        // A mote: drawn in to its muzzle, quicker as it closes
        const k = Math.min(1, 0.12 * frames * (1 + 2 * (1 - f)));
        const ox = p.x, oy = p.y;
        p.x += (p.tx - p.x) * k; p.y += (p.ty - p.y) * k;
        g.moveTo(ox, oy).lineTo(p.x, p.y).stroke({ color: p.color, width: p.size, alpha: 0.8 * Math.sin(f * Math.PI) });
      } else {
        const drag = Math.pow(p.kind ? 0.96 : 0.9, frames);
        p.vx *= drag; p.vy *= drag;
        p.x += p.vx * frames; p.y += p.vy * frames;
        if (p.kind === 0) g.moveTo(p.x - p.vx * 1.8, p.y - p.vy * 1.8).lineTo(p.x, p.y).stroke({ color: p.color, width: p.size, alpha: f });
        else g.circle(p.x, p.y, p.size * (0.5 + 0.5 * f)).fill({ color: p.color, alpha: 0.8 * f });
      }
      this.particles[w++] = p;
    }
    this.particles.length = w;
    let r = 0;
    for (const ring of this.rings) {
      ring.life += frames;
      if (ring.life >= ring.max) continue;
      const p = ring.life / ring.max;
      g.circle(ring.x, ring.y, ring.r0 + (ring.r1 - ring.r0) * (1 - (1 - p) * (1 - p))).stroke({ color: ring.color, width: ring.width * (1 - p) + 0.5, alpha: 0.75 * (1 - p) });
      this.rings[r++] = ring;
    }
    this.rings.length = r;
  }
}
