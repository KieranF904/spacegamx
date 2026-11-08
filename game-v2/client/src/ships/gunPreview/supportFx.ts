/**
 * The two support guns in the preview, drawn with plain Graphics in the game's own colours (MiningBeamFx.repairBeam's
 * teal beam, braided and sparkling where it mends; damage/events.ts intercept's hot orange tracer, flash and pop): a
 * Repair Beam mending a hurt friendly plate, and a Point Defence Turret shooting down missiles flying in at it.
 * Nothing is kept but the sparks, the missiles and the tracers of the moment; `reset()` clears them.
 */

import type { Graphics } from 'pixi.js';
import { drawStrands } from '../beamLookFx';

interface Spark { x: number; y: number; vx: number; vy: number; life: number; max: number }
interface Missile { x: number; y: number }
interface Tracer { x1: number; age: number }
interface Pop { x: number; age: number; down: boolean }

/** Frames a PD tracer and a pop last */
const TRACER = 8, POP = 22;
/** Missile speed a frame, and ticks between missiles sent in */
const MISSILE_V = 3.2, MISSILE_EVERY = 80;

export class SupportFx {
  private sparks: Spark[] = [];
  private missiles: Missile[] = [];
  private tracers: Tracer[] = [];
  private pops: Pop[] = [];
  private t = 0;

  reset(): void {
    this.sparks.length = 0; this.missiles.length = 0; this.tracers.length = 0; this.pops.length = 0; this.t = 0;
  }

  /** A Repair Beam from the muzzle (x0, 0) to the plate it mends at (x1, 0) (lit: held; `frames` since last), strands in the model's colour */
  repair(g: Graphics, x0: number, x1: number, lit: boolean, frames: number, strands: number, strandColor: number): void {
    this.t += frames / 60;
    const w = Math.max(0, x1 - x0);
    if (lit && w > 8) {
      const breathe = 0.8 + 0.2 * Math.sin(this.t * 5), wid = 7 * breathe;
      g.moveTo(x0, 0).lineTo(x1, 0).stroke({ color: 0x0f766e, width: wid * 3.4, alpha: 0.12 });
      g.moveTo(x0, 0).lineTo(x1, 0).stroke({ color: 0x2dd4bf, width: wid * 1.3, alpha: 0.4 });
      g.moveTo(x0, 0).lineTo(x1, 0).stroke({ color: 0xecfdf5, width: wid * 0.35, alpha: 0.9 });
      drawStrands(g, x0, 0, 1, 0, w, wid, strands, strandColor, 1, this.t, 0);
      // '+' motes flowing to what it mends
      for (let k = 0; k < 4; k++) {
        const u = (this.t * 0.9 + k / 4) % 1, s = Math.sin(u * Math.PI), r = 2.6 + 1.6 * s, mx = x0 + w * u;
        g.moveTo(mx - r, 0).lineTo(mx + r, 0).moveTo(mx, -r).lineTo(mx, r).stroke({ color: 0xa7f3d0, width: 1.6, alpha: 0.85 * s });
      }
      g.circle(x0, 0, wid * 1.1).fill({ color: 0x5eead4, alpha: 0.45 });
      g.circle(x1, 0, wid * 2.8).fill({ color: 0x2dd4bf, alpha: 0.22 });
      g.circle(x1, 0, wid).fill({ color: 0xecfdf5, alpha: 0.8 });
      if (Math.random() < 0.7 * Math.min(1, frames)) {
        const a = Math.random() * Math.PI * 2, s = 0.4 + Math.random() * 1.2;
        this.sparks.push({ x: x1 + Math.cos(a) * 10, y: Math.sin(a) * 10, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 0.3, life: 0, max: 24 + Math.random() * 20 });
      }
    }
    // (green sparkles drift on after the beam lets go)
    let n = 0;
    for (const s of this.sparks) {
      s.life += frames;
      if (s.life >= s.max) continue;
      s.vx *= Math.pow(0.9, frames); s.vy *= Math.pow(0.9, frames);
      s.x += s.vx * frames; s.y += s.vy * frames;
      const f = 1 - s.life / s.max, r = 2.4 * (0.6 + f);
      g.moveTo(s.x - r, s.y).lineTo(s.x + r, s.y).moveTo(s.x, s.y - r).lineTo(s.x, s.y + r).stroke({ color: f > 0.5 ? 0xd1fae5 : 0x34d399, width: 1.3, alpha: f });
      this.sparks[n++] = s;
    }
    this.sparks.length = Math.min(n, 120);
  }

  /**
   * Point defence: a missile is sent in from `farX` every so often; on a tick the turret fires (`fired`), it shoots the
   * nearest one in `reach` of the muzzle (x 0): a tracer, and the missile pops. Drawn flying in along the line of fire.
   */
  pd(g: Graphics, tick: number, fired: boolean, frames: number, farX: number, reach: number): void {
    if (tick % MISSILE_EVERY === 1 && this.missiles.length < 3) this.missiles.push({ x: farX, y: 0 });
    if (fired) {
      let best = -1;
      for (let i = 0; i < this.missiles.length; i++) if (this.missiles[i].x <= reach && (best < 0 || this.missiles[i].x < this.missiles[best].x)) best = i;
      if (best >= 0) {
        const m = this.missiles.splice(best, 1)[0];
        this.tracers.push({ x1: m.x, age: 0 });
        this.pops.push({ x: m.x, age: 0, down: true });
      }
    }
    for (const m of this.missiles) {
      m.x -= MISSILE_V * frames;
      // (one that reaches the gun unshot is taken as gone: a pop too)
      if (m.x < 8) { this.pops.push({ x: 8, age: 0, down: false }); m.x = Infinity; }
      else {
        g.poly([m.x + 9, 0, m.x - 4, -3.2, m.x - 4, 3.2]).fill(0xcbd5e1).stroke({ color: 0x64748b, width: 1 });
        g.circle(m.x - 6, 0, 3.2).fill({ color: 0xffa040, alpha: 0.85 });
        g.moveTo(m.x - 5, 0).lineTo(m.x + 26, 0).stroke({ color: 0xffb060, width: 1.6, alpha: 0.35 });
      }
    }
    this.missiles = this.missiles.filter((m) => m.x !== Infinity);
    for (const tr of this.tracers) {
      tr.age += frames;
      const a = Math.max(0, 1 - tr.age / TRACER);
      g.moveTo(6, 0).lineTo(tr.x1, 0).stroke({ color: 0xff8a1a, width: 2.6, alpha: a });
      g.moveTo(6, 0).lineTo(tr.x1, 0).stroke({ color: 0xfff1d0, width: 1, alpha: a });
      g.circle(6, 0, 7 * a + 2).fill({ color: 0xffb060, alpha: 0.7 * a });
    }
    this.tracers = this.tracers.filter((tr) => tr.age < TRACER);
    for (const p of this.pops) {
      p.age += frames;
      const u = Math.min(1, p.age / POP), a = 1 - u;
      g.circle(p.x, 0, 8 + 22 * u).fill({ color: 0xffd08a, alpha: 0.45 * a });
      g.circle(p.x, 0, 6 + 28 * u).stroke({ color: 0xffd08a, width: 2, alpha: 0.8 * a });
      g.circle(p.x, 0, 4 * a + 1).fill({ color: 0xfff1d0, alpha: a });
      for (let i = 0; i < 8; i++) {
        const ang = (i / 8) * Math.PI * 2 + p.x, d = 4 + 26 * u;
        g.circle(p.x + Math.cos(ang) * d, Math.sin(ang) * d, 1.4).fill({ color: 0xffa040, alpha: a });
      }
    }
    this.pops = this.pops.filter((p) => p.age < POP);
  }
}
