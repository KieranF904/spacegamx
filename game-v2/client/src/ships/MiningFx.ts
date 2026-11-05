/**
 * A mining laser's beam, drawn to look nothing like a weapon laser's pulse
 * (PulseFx: a thin white-hot line with a bright knot racing down it):
 *
 *   beam    a wide, soft cyan beam whose brightness follows the pulse curve
 *           (fades in, flares, trails off to a dim glow, then again): never
 *           a hard line
 *   rings   rings travelling in along the whole beam from the rock to the ship
 *           (drawing the ore in), edge-on, narrowing as they go; they fade in
 *           as the beam starts to cut and out when it stops
 *   motes   while it's cutting rock: specks of ore in the rock's own colours
 *           streaming back down the beam to the ship (the chunks it breaks
 *           off are thrown to the miner too)
 *   cut     where it meets rock: a glowing molten pool, chips of rock thrown
 *           back, and a haze of dust, lingering while the beam is held
 *
 * Particles are plain records in capped arrays, recycled in place.
 */

import type { Graphics } from 'pixi.js';
import { pulseIntensity, mineFalloff, type PulseProfile } from '@space-game/common';
import type { BeamLook } from '../rendering/weapons/weaponStyles';
import { drawCone, drawStrands, sputterGain } from './beamLookFx';
import { AnchorList, rideStep, type ImpactAnchor, type PoseSource } from '../rendering/weapons/impactAnchor';

const OUTER = 0x0284c7, MID = 0x4fc3f7, CORE = 0xe6f8ff;
/** Rings are this far apart along the beam (world units) and travel this fast (units a tick) */
const RING_SPACING = 64, RING_SPEED = 6;
/** Frames the rings take to fade in as a cut starts and out as it stops */
const RING_FADE = 20;
/** Motes flow to the ship at about this speed (units a tick) */
const MOTE_SPEED = 5.5;

/** What a rock throws off as it's cut (chips, motes, dust), brightest first: its own colours, lit by the beam; and how its cut glows */
const ROCK: Record<string, { bits: number[]; hot: number }> = {
  stone: { bits: [0xe2cfae, 0xbfa985, 0xfff1d0], hot: 0xff8a3a },
  metal: { bits: [0xd6dde8, 0xa3b4c9, 0xffffff], hot: 0xffa050 },
  ice: { bits: [0xdaf3ff, 0x9fdcff, 0xffffff], hot: 0xa8e6ff },
  crystal: { bits: [0xe8c4ff, 0xb9a3ff, 0xffffff], hot: 0xd08cff },
  tar: { bits: [0xe8d3a6, 0xffa94a, 0xb09a78], hot: 0xff6a1a },
  leestone: { bits: [0xdcead0, 0xb6cfa0, 0xfffbe6], hot: 0xd8ff80 },
};
const FALLBACK = ROCK.stone;

interface Line { x: number; y: number; hx: number; hy: number; hit: boolean }
/** A beam's rings: how far faded in (0..1), its line, brightness and width as last drawn, and whether it was drawn this frame */
interface RingState { fade: number; x: number; y: number; hx: number; hy: number; lvl: number; w: number; seen: boolean }
/** An ore mote on its way down the beam: `f` along it from the cut (0) to the ship (1) */
interface Mote { key: number; f: number; speed: number; side: number; phase: number; color: number; size: number }
/** Chips and dust ride the rock they came off (`anc`, impactAnchor): they fly in its frame, so they don't smear round its orbit */
interface Chip { x: number; y: number; vx: number; vy: number; rot: number; vr: number; life: number; max: number; len: number; color: number; anc?: ImpactAnchor }
interface Puff { x: number; y: number; vx: number; vy: number; life: number; max: number; r0: number; r1: number; color: number; anc?: ImpactAnchor }

const MAX_MOTES = 90, MAX_CHIPS = 160, MAX_PUFFS = 60;

export class MiningFx {
  private motes: Mote[] = [];
  private chips: Chip[] = [];
  private puffs: Puff[] = [];
  /** Where the rocks are drawn (GameState.entities), and the rock the beam about to be drawn is cutting (-1 none) */
  poses: PoseSource | null = null;
  target = -1;
  private anchors = new AnchorList();
  /** Each beam's anchor on the rock it's cutting (by its key), while it cuts the same one */
  private cutAnchors = new Map<number, ImpactAnchor>();
  /** Each beam this frame (by its key), for its motes */
  private lines = new Map<number, Line>();
  private ringStates = new Map<number, RingState>();
  /** The frame's time in ticks (a fading beam's rings keep moving) */
  private clock = 0;

  /** Once a frame, before the beams */
  begin(now = 0, frames = 0): void {
    this.clock = now;
    // (what's riding a rock follows it first, before anything new is thrown off it this frame)
    if (this.anchors.live.length) this.anchors.step(this.poses, frames);
    if (this.cutAnchors.size) for (const [k, a] of this.cutAnchors) if (a.left <= 0) this.cutAnchors.delete(k);
    this.lines.clear();
    for (const r of this.ringStates.values()) r.seen = false;
  }

  /**
   * One beam this frame: `age` ticks into its pulse (`ending`: let go, so no pulse follows it: it fades to nothing), from the muzzle (x, y) to
   * (hx, hy), `hit` if it meets rock there (`rock`: its material's name); full strength out to `full`, then trailing off
   */
  draw(g: Graphics, key: number, prof: PulseProfile, age: number, ending: boolean, x: number, y: number, hx: number, hy: number, hit: boolean, rock: string | null, now: number, frames: number, full: number, look?: BeamLook, power = 1): void {
    const k = pulseIntensity(prof, age);
    const OUT = look?.outer ?? OUTER, MIDC = look?.mid ?? MID, COREC = look?.core ?? CORE;
    // Never quite out: a dim glow between pulses, the flare at each one's peak
    const env = ending ? Math.max(0, Math.min(1, (prof.ticks - age) / (prof.ticks - prof.peak))) : 1;
    // (`power`: a ports ship's mining laser's fulfilment, the share of its draw it got: starved, it burns dim and thin)
    const lvl = (0.2 + 0.8 * k) * env * sputterGain(look?.sputter, now / 60, key) * (0.3 + 0.7 * Math.max(0, Math.min(1, power)));
    // (Where it cuts, past its range, it cuts less: the glow and the particles follow)
    const reachStr = hit ? mineFalloff(Math.hypot(hx - x, hy - y), full) : 1;
    const len = Math.hypot(hx - x, hy - y) || 1, ux = (hx - x) / len, uy = (hy - y) / len, nx = -uy, ny = ux;
    const kind = ROCK[rock ?? ''] ?? FALLBACK, pal = kind.bits;
    this.lines.set(key, { x, y, hx, hy, hit });
    const flick = 0.93 + 0.07 * Math.sin(now * 0.7 + key);
    const w = 7 * (0.62 + 0.38 * lvl) * flick * (look?.width ?? 1);

    // The beam: wide and soft, a bright core that swells with the flare
    // (Past `full` it thins away, in steps, as mineFalloff)
    const line = (width: number, color: number, alpha: number) => {
      const near = Math.min(1, full / len);
      g.moveTo(x, y).lineTo(x + (hx - x) * near, y + (hy - y) * near).stroke({ color, width, alpha });
      const STEPS = 8;
      for (let i = 0; near < 1 && i < STEPS; i++) {
        const a0 = near + (1 - near) * (i / STEPS), a1 = near + (1 - near) * ((i + 1) / STEPS);
        const s = mineFalloff((a0 + a1) / 2 * len, full);
        if (s > 0.01) g.moveTo(x + (hx - x) * a0, y + (hy - y) * a0).lineTo(x + (hx - x) * a1, y + (hy - y) * a1).stroke({ color, width, alpha: alpha * s });
      }
    };
    if (look?.cone) drawCone(g, x, y, ux, uy, Math.min(len, full), look.cone, MIDC, 0.2 * lvl);
    line(w * 5.2, OUT, 0.09 * lvl);
    line(w * 2.4, MIDC, 0.26 * lvl);
    line(w * 1.1, MIDC, 0.4 * lvl);
    line(Math.max(1.4, w * (0.35 + 0.35 * k)), COREC, (0.45 + 0.5 * k) * env * (0.3 + 0.7 * Math.max(0, Math.min(1, power))));
    if (look?.braid) drawStrands(g, x, y, ux, uy, Math.min(len, full), w, look.braid.strands, look.braid.color, lvl, now / 60, key);
    // Its muzzle: a steady glow
    g.circle(x, y, w * (1.3 + 1.1 * k)).fill({ color: MIDC, alpha: 0.38 * lvl });
    g.circle(x, y, w * (0.55 + 0.4 * k)).fill({ color: COREC, alpha: (0.5 + 0.4 * k) * env });

    // Rings drawing in along it, fading in while it cuts and out when it doesn't
    let rs = this.ringStates.get(key);
    if (!rs) this.ringStates.set(key, (rs = { fade: 0, x, y, hx, hy, lvl, w, seen: true }));
    Object.assign(rs, { x, y, hx, hy, lvl, w, seen: true });
    rs.fade = Math.max(0, Math.min(1, rs.fade + (hit ? frames : -frames) / RING_FADE));
    this.rings(g, rs, now);

    // The cut: where it meets rock
    if (!hit) return;
    // A molten pool, brighter at the flare, lingering between
    const pool = w * (1.7 + 1.4 * k);
    for (let i = 0; i < 5; i++) g.circle(hx, hy, pool * (2.3 - i * 0.4)).fill({ color: kind.hot, alpha: (0.05 + 0.05 * lvl) * (1 + i * 0.35) * reachStr });
    g.circle(hx, hy, pool * 0.5).fill({ color: 0xfff6e0, alpha: (0.5 + 0.45 * k) * env * reachStr });
    // Chips and dust thrown back along the beam, in a wide fan; motes set off from the cut
    const back = Math.atan2(-uy, -ux), anc = this.cutAnchor(key, hx, hy);
    if (Math.random() < (0.1 + 3.4 * k * k) * env * reachStr * frames && this.chips.length < MAX_CHIPS) {
      const a = back + (Math.random() - 0.5) * 2.2, s = 1.4 + Math.random() * (2.4 + 2 * k), max = 16 + Math.random() * 22;
      this.chips.push({ x: hx, y: hy, vx: Math.cos(a) * s, vy: Math.sin(a) * s, rot: Math.random() * 6.28, vr: (Math.random() - 0.5) * 0.5, life: 0, max,
        len: 2.6 + Math.random() * 3.6, color: pal[Math.random() < 0.7 ? 0 : 2], anc });
      anc?.hold(max + 2);
    }
    if (Math.random() < (0.04 + 0.7 * k * k) * env * reachStr * frames && this.puffs.length < MAX_PUFFS) {
      const a = back + (Math.random() - 0.5) * 2.8, s = 0.3 + Math.random() * 0.8, max = 34 + Math.random() * 26;
      this.puffs.push({ x: hx, y: hy, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0, max, r0: 4, r1: 16 + Math.random() * 12, color: pal[1], anc });
      anc?.hold(max + 2);
    }
    if (Math.random() < (0.08 + 2.2 * k * k) * env * reachStr * frames * (look?.motes ?? 1) && this.motes.length < MAX_MOTES) {
      this.motes.push({ key, f: 0.02, speed: MOTE_SPEED * (0.8 + Math.random() * 0.5), side: (Math.random() - 0.5) * 2, phase: Math.random() * 6.28, color: pal[Math.floor(Math.random() * 3)], size: 2.2 + Math.random() * 1.8 });
    }
  }

  /**
   * A beam's rings, travelling from the rock in to the ship: born at the cut,
   * narrowing as they go (a funnel), taken in at the muzzle
   */
  private rings(g: Graphics, r: RingState, now: number): void {
    if (r.fade <= 0.01) return;
    const len = Math.hypot(r.hx - r.x, r.hy - r.y) || 1, ux = (r.hx - r.x) / len, uy = (r.hy - r.y) / len, nx = -uy, ny = ux;
    const base = ((-now * RING_SPEED) % RING_SPACING + RING_SPACING) % RING_SPACING;
    for (let d = base; d < len - 4; d += RING_SPACING) {
      const f = d / len;
      const a = r.fade * r.lvl * (0.5 + 0.4 * f) * Math.min(1, d / 30) * Math.min(1, (len - d) / 24);
      if (a < 0.03) continue;
      this.ring(g, r.x + ux * d, r.y + uy * d, ux, uy, nx, ny, 2.2 + 3.2 * r.lvl, r.w * (1.2 + 2.4 * f), a);
    }
  }

  /** An edge-on ring: an ellipse `ra` long along the beam and `rb` across it */
  private ring(g: Graphics, cx: number, cy: number, ux: number, uy: number, nx: number, ny: number, ra: number, rb: number, alpha: number): void {
    const n = 14;
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2, along = Math.cos(a) * ra, across = Math.sin(a) * rb;
      const px = cx + ux * along + nx * across, py = cy + uy * along + ny * across;
      if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
    }
    g.stroke({ color: MID, width: 1.5, alpha });
    g.moveTo(cx - nx * rb, cy - ny * rb).lineTo(cx + nx * rb, cy + ny * rb).stroke({ color: CORE, width: 1, alpha: alpha * 0.5 });
  }

  /** Once a frame, after the beams: motes, chips and dust move on, are drawn, and fade */
  /** The anchor on the rock beam `key` is cutting (`target`), at the cut (hx, hy): its last one while that's still riding the same rock */
  private cutAnchor(key: number, hx: number, hy: number): ImpactAnchor | undefined {
    if (this.target < 0) return undefined;
    const old = this.cutAnchors.get(key);
    if (old && old.id === this.target && old.left > 0 && !old.gone) return old;
    const a = this.anchors.open(this.poses, this.target, hx, hy) ?? undefined;
    if (a) this.cutAnchors.set(key, a); else this.cutAnchors.delete(key);
    return a;
  }

  drawAfter(g: Graphics, dt: number, frames: number): void {
    void dt;
    // Rings of a beam that's let go fade out where it was
    for (const [key, r] of this.ringStates) {
      if (r.seen) continue;
      r.fade -= frames / RING_FADE;
      if (r.fade <= 0) this.ringStates.delete(key);
      else this.rings(g, r, this.clock);
    }
    // Motes: down the beam to the ship, wobbling a little, taken in at the muzzle
    let w = 0;
    for (const m of this.motes) {
      const L = this.lines.get(m.key);
      if (!L) continue;
      const len = Math.hypot(L.x - L.hx, L.y - L.hy) || 1;
      m.f += (m.speed * frames) / len;
      if (m.f >= 1) continue;
      const ux = (L.x - L.hx) / len, uy = (L.y - L.hy) / len, nx = -uy, ny = ux;
      // (Out from the beam's middle by a little, narrowing to nothing at the ship)
      const off = Math.sin(m.phase + m.f * 14) * 11 * m.side * (1 - m.f * 0.8);
      const px = L.hx + (L.x - L.hx) * m.f + nx * off, py = L.hy + (L.y - L.hy) * m.f + ny * off;
      const a = Math.min(1, m.f * 7) * (1 - m.f * m.f * m.f);
      const tail = 7 + 9 * (1 - m.f);
      g.moveTo(px - ux * tail, py - uy * tail).lineTo(px, py).stroke({ color: m.color, width: m.size * 0.9, alpha: 0.55 * a });
      g.circle(px, py, m.size * 1.5).fill({ color: m.color, alpha: 0.35 * a });
      g.circle(px, py, m.size * 0.7).fill({ color: 0xffffff, alpha: 0.85 * a });
      this.motes[w++] = m;
    }
    this.motes.length = w;

    w = 0;
    for (const c of this.chips) {
      c.life += frames;
      if (c.life >= c.max) continue;
      rideStep(c, c.anc, 0.94, frames);
      c.rot += c.vr * frames;
      const f = 1 - c.life / c.max, dx = Math.cos(c.rot) * c.len, dy = Math.sin(c.rot) * c.len;
      g.moveTo(c.x - dx, c.y - dy).lineTo(c.x + dx, c.y + dy).stroke({ color: c.color, width: 2.4, alpha: 0.9 * f });
      this.chips[w++] = c;
    }
    this.chips.length = w;

    w = 0;
    for (const p of this.puffs) {
      p.life += frames;
      if (p.life >= p.max) continue;
      rideStep(p, p.anc, 0.97, frames);
      const f = p.life / p.max;
      // (Soft: a few rings, thinning outward)
      const r = p.r0 + (p.r1 - p.r0) * f, a = 0.07 * (1 - f);
      g.circle(p.x, p.y, r).fill({ color: p.color, alpha: a * 0.6 });
      g.circle(p.x, p.y, r * 0.7).fill({ color: p.color, alpha: a * 0.8 });
      g.circle(p.x, p.y, r * 0.4).fill({ color: p.color, alpha: a });
      this.puffs[w++] = p;
    }
    this.puffs.length = w;
  }
}
