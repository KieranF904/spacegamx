/**
 * Pulse lasers' pulses (common/src/ships/pulse.ts), drawn on their curve into
 * the beams' own additive Graphics (MiningBeamFx, which feeds the bloom):
 *
 *   ramp  energy gathers at the muzzle: motes drawn in to a swelling charge
 *         orb, and a thin, flickering beam
 *   peak  the flare: the beam at full width inside a wide bloom, a white flash
 *         at the muzzle, and a bright bulge racing down the beam (~0.15 s);
 *         where it lands, a flash, a shockwave ring, sparks and molten
 *         droplets thrown off the hull
 *   tail  the beam dims and wavers, shedding embers along its line, an
 *         afterglow at the muzzle
 * and, all the while it's on a hull, a hot scorch glow there that lingers.
 * Past its effective range the beam thins and fades out to its full range
 * (common/src/ships/pulse.ts beamFalloff), and what it hits there flares weaker.
 *
 * Each beam is a white-hot core inside a coloured beam inside a soft wide
 * glow, in its grade's colours (Mk I red, II emerald wound with a spiralling
 * double strand, III a cooled orange that throws more embers, IV a wide
 * magenta with a double shockwave, V a white-hot x-ray with a violet halo). Particles are plain
 * records in capped arrays, recycled in place; nothing is allocated per frame
 * beyond what the beams already draw.
 */

import type { Graphics } from 'pixi.js';
import { pulseIntensity, beamFalloff, effectiveRange, type PulseProfile, type WeaponTuning } from '@space-game/common';

/** The flare's bulge races from the muzzle to where the beam lands at about this speed (world units a tick), in 5 to 12 ticks (~0.1-0.2 s) */
const BULGE_SPEED = 420;
/** Frames the flash where the bulge lands takes to fade */
const IMPACT_FRAMES = 14;

/** A grade's look: outer glow, beam body and core colours, and its extras */
export interface PulseLook {
  outer: number; mid: number; core: number;
  /** Embers and sparks thrown (× the usual), beam width (×), and whether its shockwave rings twice */
  embers: number; width: number; rings: number;
  /** A wide extra halo round the beam at the peak (the x-ray's) */
  halo?: number;
  /** Two strands spiralling round the beam while it's lit (Mk II's), this colour */
  helix?: number;
}

const LOOKS: PulseLook[] = [
  { outer: 0xdc2626, mid: 0xff6b6b, core: 0xfff0f0, embers: 1, width: 1, rings: 1 },
  { outer: 0x059669, mid: 0x34d399, core: 0xf0fdf4, embers: 0.8, width: 0.9, rings: 1, helix: 0xbbf7d0 },
  { outer: 0xea580c, mid: 0xff9a5c, core: 0xfff6ea, embers: 1.8, width: 1, rings: 1 },
  { outer: 0xdb2777, mid: 0xff7ad9, core: 0xfff0fb, embers: 1.2, width: 1.25, rings: 2 },
  { outer: 0xf43f5e, mid: 0xffc2d0, core: 0xffffff, embers: 1.3, width: 1.1, rings: 2, halo: 0xa78bfa },
];

export function pulseLook(grade: number): PulseLook {
  return LOOKS[Math.max(0, Math.min(4, Math.round(grade) - 1))];
}


/** One pulse under way, and where its beam is this frame */
export interface PulseRun {
  owner: number; part: number; start: number; sounded: boolean;
  /** Its flare has gone off (its bulge launched), and the bulge has landed (its shockwave and sparks thrown, once) */
  flared: boolean;
  arrived: boolean;
  /** Frames since the bulge landed (its flash there fades), -1 before */
  impact: number;
  /** Muzzle this frame (motes are drawn in to it) */
  mx: number; my: number;
}

interface Particle {
  /** 0 spark (a streak), 1 ember (a fading dot), 2 mote (drawn in to its pulse's muzzle) */
  kind: number;
  x: number; y: number; vx: number; vy: number; life: number; max: number; color: number; size: number;
  run?: PulseRun;
}
interface Ring { x: number; y: number; life: number; max: number; r0: number; r1: number; color: number; width: number }
interface Scorch { x: number; y: number; life: number; max: number; r: number; color: number }

const MAX_PARTICLES = 500, MAX_RINGS = 32, MAX_SCORCH = 48;

export class PulseFx {
  private particles: Particle[] = [];
  private rings: Ring[] = [];
  private scorch: Scorch[] = [];
  private t = 0;

  /** Mk II's double strand: two thin lines winding round the beam out to its effective range, turning as it fires */
  private helix(g: Graphics, x: number, y: number, ux: number, uy: number, nx: number, ny: number, len: number, wid: number, color: number, alpha: number, part: number): void {
    const period = 70, n = Math.max(6, Math.min(48, Math.round(len / 18))), amp = Math.max(2.5, wid * 1.5);
    for (const phase of [0, Math.PI]) {
      g.moveTo(x, y);
      for (let i = 1; i <= n; i++) {
        const d = (len * i) / n, off = Math.sin((d / period) * Math.PI * 2 - this.t * 14 + phase + part) * amp * Math.min(1, d / 40);
        g.lineTo(x + ux * d + nx * off, y + uy * d + ny * off);
      }
      g.stroke({ color, width: Math.max(1, wid * 0.3), alpha: 0.85 * alpha });
    }
  }

  private spawn(p: Particle): void {
    if (this.particles.length < MAX_PARTICLES) this.particles.push(p);
  }

  /**
   * One pulse this frame: `age` ticks into it (fractional), its beam from the
   * muzzle (x, y) to (hx, hy) (`hit`: it meets something there), `def` its
   * gun's tuning (its width at the flare, and where it fades: beamFalloff).
   * Past its effective range the beam thins and fades away to nothing at its
   * full range, and what it hits out there flares weaker.
   */
  draw(g: Graphics, run: PulseRun, prof: PulseProfile, age: number, x: number, y: number, hx: number, hy: number, hit: boolean,
    def: WeaponTuning, grade: number, frames: number): void {
    const k = pulseIntensity(prof, age);
    run.mx = x; run.my = y;
    const L = pulseLook(grade);
    const peakWidth = def.width ?? 16;
    const len = Math.hypot(hx - x, hy - y) || 1, ux = (hx - x) / len, uy = (hy - y) / len, nx = -uy, ny = ux;
    // Where it starts to fade, and how strong it is where it lands (dim past its effective range)
    const eff = Math.min(len, effectiveRange(def)), range = def.range ?? len;
    const land = hit ? beamFalloff(def, len) : 0;
    /** How much of the beam shows at `d` along it: all of it to its effective range, then thinning away to nothing at its full range */
    const shows = (d: number) => (d <= eff ? 1 : Math.max(0, 1 - (d - eff) / Math.max(1, range - eff)) ** 1.5);
    const ramp = age < prof.peak - 0.5, tail = age > prof.peak + 1.5;
    // The beam's width follows the curve (narrow to full)
    const wid = peakWidth * 0.5 * L.width * (0.14 + 0.86 * k) * (1 + 0.06 * (grade - 1));
    const glow = Math.min(1, Math.sqrt(k / 0.25)) * (0.55 + 0.45 * k);

    // Ramp: motes drawn in to the muzzle, and a charge orb swelling there
    if (ramp) {
      const q = Math.max(0, age / prof.peak);
      if (Math.random() < 0.9 * frames) for (let i = 0; i < 2; i++) {
        const a = Math.random() * Math.PI * 2, d = (26 + Math.random() * 40) * (1.2 - 0.5 * q);
        this.spawn({ kind: 2, x: Math.cos(a) * d, y: Math.sin(a) * d, vx: 0, vy: 0, life: 0, max: 10 + Math.random() * 8, color: Math.random() < 0.4 ? L.core : L.mid, size: 1.2 + Math.random() * 1.2, run });
      }
      const flick = 0.75 + 0.25 * Math.sin(this.t * 70 + run.part * 3);
      const orb = (3 + 11 * q * q) * L.width;
      g.circle(x, y, orb * 2.2).fill({ color: L.outer, alpha: 0.18 * (0.3 + q) * flick });
      g.circle(x, y, orb).fill({ color: L.mid, alpha: 0.45 * (0.3 + q) * flick });
      g.circle(x, y, orb * 0.45).fill({ color: L.core, alpha: 0.85 * (0.3 + 0.7 * q) });
    }

    if (k > 0.004) {
      // Thin and flickering on the way in, steady at the flare, wavering as it dies
      const flicker = ramp ? 0.55 + 0.45 * Math.random() : 1;
      const a = glow * flicker;
      const waver = tail ? wid * 0.9 * (1 - k) : 0;
      const ex = x + ux * eff, ey = y + uy * eff;
      const line = (width: number, color: number, alpha: number, wv: number) => {
        if (wv <= 0.05) g.moveTo(x, y).lineTo(ex, ey).stroke({ color, width, alpha });
        else {
          // A shimmering line: a few segments, each nudged sideways
          const n = 9;
          g.moveTo(x, y);
          for (let i = 1; i <= n; i++) {
            const f = i / n, off = i === n ? 0 : Math.sin(this.t * 23 + f * 9 + run.part) * wv * Math.sin(f * Math.PI);
            g.lineTo(x + (ex - x) * f + nx * off, y + (ey - y) * f + ny * off);
          }
          g.stroke({ color, width, alpha });
        }
        // Past its effective range: thinner and fainter, segment by segment, to nothing
        if (len - eff < 1) return;
        const n = 6;
        for (let i = 0; i < n; i++) {
          const d0 = eff + ((len - eff) * i) / n, d1 = eff + ((len - eff) * (i + 1)) / n, m = shows((d0 + d1) / 2);
          if (m <= 0.01) break;
          g.moveTo(x + ux * d0, y + uy * d0).lineTo(x + ux * d1, y + uy * d1).stroke({ color, width: width * (0.35 + 0.65 * m), alpha: alpha * m });
        }
      };
      // At the flare, a wide soft bloom round all of it (and the x-ray's halo)
      if (k > 0.35) {
        line(wid * 8, L.outer, 0.16 * k, 0);
        if (L.halo !== undefined) line(wid * 4.5, L.halo, 0.12 * k, 0);
      }
      line(wid * 3.6, L.outer, 0.28 * a, waver * 1.4);
      line(wid * 1.6, L.mid, 0.6 * a, waver);
      line(Math.max(1, wid * 0.45), L.core, a, waver * 0.5);
      if (L.helix !== undefined && !ramp) this.helix(g, x, y, ux, uy, nx, ny, eff, wid, L.helix, a, run.part);
      // Its muzzle: the glow it fires from (and an afterglow as it dies)
      g.circle(x, y, wid * (1.2 + 2.2 * k)).fill({ color: L.mid, alpha: 0.42 * a });
      if (hit && land > 0.01) {
        // On the hull: a hot glow where it burns (dimmer the further out), and a scorch left behind
        g.circle(hx, hy, wid * (1.4 + 2.4 * k) * (0.5 + 0.5 * land)).fill({ color: L.mid, alpha: 0.35 * a * land });
        g.circle(hx, hy, wid * (0.6 + 0.9 * k) * (0.5 + 0.5 * land)).fill({ color: L.core, alpha: 0.75 * a * land });
        if (Math.random() < 0.35 * frames * land && this.scorch.length < MAX_SCORCH) this.scorch.push({ x: hx, y: hy, life: 0, max: 40 + Math.random() * 30, r: wid * (1.2 + Math.random()), color: 0xff7a2a });
        if (Math.random() < (0.25 + 0.5 * k) * frames * L.embers * land) {
          const sa = Math.atan2(-uy, -ux) + (Math.random() - 0.5) * 2.4, s = 1.5 + Math.random() * 4;
          this.spawn({ kind: 0, x: hx, y: hy, vx: Math.cos(sa) * s, vy: Math.sin(sa) * s, life: 0, max: 8 + Math.random() * 12, color: Math.random() < 0.5 ? 0xfff2c8 : L.mid, size: 1.3 });
        }
      }
      // The tail sheds embers along its line
      if (tail && Math.random() < 0.8 * frames * L.embers) {
        const f = Math.random(), side = (Math.random() - 0.5) * 2;
        this.spawn({ kind: 1, x: x + (hx - x) * f + nx * side * wid, y: y + (hy - y) * f + ny * side * wid, vx: nx * side * 0.3 + (Math.random() - 0.5) * 0.3, vy: ny * side * 0.3 + (Math.random() - 0.5) * 0.3,
          life: 0, max: 22 + Math.random() * 26, color: Math.random() < 0.3 ? L.core : L.mid, size: 1 + Math.random() * 1.6 });
      }
    }

    // The flare: a white flash at the muzzle (each frame of it) as its bulge launches
    if (k > 0.4) {
      g.circle(x, y, wid * 3.4 * k).fill({ color: L.core, alpha: 0.75 * k });
      g.circle(x, y, wid * 6 * k).fill({ color: L.mid, alpha: 0.18 * k });
      // A flare streak across the muzzle, as a lens catches it
      const fl = wid * 9 * k;
      g.moveTo(x - nx * fl, y - ny * fl).lineTo(x + nx * fl, y + ny * fl).stroke({ color: L.mid, width: wid * 0.5 * k, alpha: 0.5 * k });
      g.moveTo(x - nx * fl * 0.6, y - ny * fl * 0.6).lineTo(x + nx * fl * 0.6, y + ny * fl * 0.6).stroke({ color: L.core, width: Math.max(1, wid * 0.18), alpha: 0.9 * k });
    }
    if (!run.flared && age >= prof.peak - 0.5) {
      run.flared = true;
      // The muzzle's own small ring as the flare goes off
      if (this.rings.length < MAX_RINGS) this.rings.push({ x, y, life: 0, max: 12, r0: wid * 0.5, r1: peakWidth * 1.3, color: L.core, width: 2 });
    }

    // The bulge: a bright knot of the flare racing down the beam, wider and hotter than it, to where it lands
    const pw = peakWidth * 0.5 * L.width * (1 + 0.06 * (grade - 1));
    const bt = (age - prof.peak) / Math.max(5, Math.min(12, len / BULGE_SPEED));
    if (run.flared && !run.arrived && bt >= 0) {
      const d = len * Math.min(1, bt), m = shows(d);
      const bx = x + ux * d, by = y + uy * d;
      if (m > 0.01) {
        g.circle(bx, by, pw * 3.2).fill({ color: L.outer, alpha: 0.22 * m });
        g.moveTo(bx - ux * pw * 6, by - uy * pw * 6).lineTo(bx + ux * pw * 1.5, by + uy * pw * 1.5).stroke({ color: L.mid, width: pw * 2.4 * (0.5 + 0.5 * m), alpha: 0.7 * m });
        g.moveTo(bx - ux * pw * 3.5, by - uy * pw * 3.5).lineTo(bx + ux * pw, by + uy * pw).stroke({ color: L.core, width: pw * 1.0 * (0.5 + 0.5 * m), alpha: 0.95 * m });
        g.circle(bx, by, pw * 1.1).fill({ color: 0xffffff, alpha: 0.9 * m });
      }
      if (bt >= 1) {
        run.arrived = true;
        run.impact = 0;
        this.land(run, x, y, hx, hy, ux, uy, hit, hit ? land : shows(len) * 0.4, pw, peakWidth, L);
      }
    }
    // Where it landed: a flash fading after the bulge
    if (run.impact >= 0 && run.impact < IMPACT_FRAMES) {
      const e = 1 - run.impact / IMPACT_FRAMES, s = (hit ? land : shows(len) * 0.4) * e;
      if (s > 0.01) {
        g.circle(hx, hy, pw * 7 * (0.5 + 0.5 * s)).fill({ color: L.mid, alpha: 0.25 * s });
        g.circle(hx, hy, pw * 2.8 * (0.5 + 0.5 * s)).fill({ color: 0xffffff, alpha: 0.95 * s });
      }
      run.impact += frames;
    }
  }

  /** The bulge lands: a shockwave there, and on a hull sparks, molten droplets and a scorch, as strong as the beam is out there (`s`) */
  private land(run: PulseRun, x: number, y: number, hx: number, hy: number, ux: number, uy: number, hit: boolean, s: number, pw: number, peakWidth: number, L: PulseLook): void {
    void run; void x; void y;
    if (s <= 0.02) return;
    for (let i = 0; i < (hit ? L.rings : 1) && this.rings.length < MAX_RINGS; i++) {
      this.rings.push({ x: hx, y: hy, life: -i * 5, max: 18 + i * 6, r0: pw * 0.8, r1: peakWidth * (2.6 + i * 1.4) * (0.4 + 0.6 * s), color: i ? L.outer : L.mid, width: (3 - i) * (0.5 + 0.5 * s) });
    }
    if (!hit) return;
    const back = Math.atan2(-uy, -ux);
    for (let i = 0; i < 16 * L.embers * s; i++) {
      const sa = back + (Math.random() - 0.5) * 2.8, v = 3 + Math.random() * 7;
      this.spawn({ kind: 0, x: hx, y: hy, vx: Math.cos(sa) * v, vy: Math.sin(sa) * v, life: 0, max: 10 + Math.random() * 14, color: Math.random() < 0.4 ? 0xffffff : 0xffd38a, size: 1.5 });
    }
    // Molten droplets: slower, longer, orange cooling to red
    for (let i = 0; i < 8 * L.embers * s; i++) {
      const sa = back + (Math.random() - 0.5) * 2.2, v = 0.8 + Math.random() * 2.2;
      this.spawn({ kind: 1, x: hx, y: hy, vx: Math.cos(sa) * v, vy: Math.sin(sa) * v, life: 0, max: 30 + Math.random() * 30, color: 0xffa040, size: 1.6 + Math.random() * 1.6 });
    }
    if (this.scorch.length < MAX_SCORCH) this.scorch.push({ x: hx, y: hy, life: 0, max: 70, r: peakWidth * 0.9 * (0.5 + 0.5 * s), color: 0xff6a1a });
  }

  /** Every pulse's particles, rings and scorches move on and fade (once a frame, after the pulses) */
  drawAfter(g: Graphics, dt: number, frames: number): void {
    this.t += dt;
    const drag = Math.pow(0.92, frames), slow = Math.pow(0.96, frames);
    let w = 0;
    for (const p of this.particles) {
      p.life += frames;
      if (p.life >= p.max) continue;
      const f = 1 - p.life / p.max;
      if (p.kind === 2) {
        // Drawn in to its muzzle as it lives
        const run = p.run!;
        const s = Math.pow(f, 1.5);
        const px = run.mx + p.x * s, py = run.my + p.y * s;
        g.circle(px, py, p.size).fill({ color: p.color, alpha: 0.8 * (1 - f * 0.5) });
      } else if (p.kind === 0) {
        p.vx *= drag; p.vy *= drag;
        p.x += p.vx * frames; p.y += p.vy * frames;
        g.moveTo(p.x - p.vx * 2.2, p.y - p.vy * 2.2).lineTo(p.x, p.y).stroke({ color: p.color, width: p.size, alpha: f });
      } else {
        p.vx *= slow; p.vy *= slow;
        p.x += p.vx * frames; p.y += p.vy * frames;
        g.circle(p.x, p.y, p.size * (0.5 + 0.5 * f)).fill({ color: f > 0.5 ? p.color : 0xff4a2a, alpha: 0.8 * f });
      }
      this.particles[w++] = p;
    }
    this.particles.length = w;
    let r = 0;
    for (const ring of this.rings) {
      ring.life += frames;
      if (ring.life >= ring.max) continue;
      if (ring.life >= 0) {
        const n = ring.life / ring.max, e = 1 - (1 - n) * (1 - n);
        g.circle(ring.x, ring.y, ring.r0 + (ring.r1 - ring.r0) * e).stroke({ color: ring.color, width: ring.width * (1.6 - n), alpha: 0.7 * (1 - n) });
      }
      this.rings[r++] = ring;
    }
    this.rings.length = r;
    let s = 0;
    for (const sc of this.scorch) {
      sc.life += frames;
      if (sc.life >= sc.max) continue;
      const f = 1 - sc.life / sc.max;
      g.circle(sc.x, sc.y, sc.r).fill({ color: sc.color, alpha: 0.16 * f * f });
      this.scorch[s++] = sc;
    }
    this.scorch.length = s;
  }
}
