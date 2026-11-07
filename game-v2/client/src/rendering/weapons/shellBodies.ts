/**
 * The bodies shells are drawn as, in place of a tracer (the Round Lab's Seeker Swarm dart and Splitting Shell canister,
 * prototypes/projectile-fx). Visual only: they are drawn where WeaponFx places a shell's head and along the direction it
 * flies, and read nothing of the sim but how far through its flight the shell is.
 *
 *   dart       a slim finned body with a red nose band, a flickering exhaust flame at its tail (missiles)
 *   canister   a banded shell with a fuse ring that runs down to its burst and a nose lamp that blinks faster as it goes (flak)
 *
 * Each part is a pooled particle (no Graphics, nothing allocated per frame). Solid parts go in the body pool, light in the
 * glow pool (which the bloom takes).
 */

import type { Texture } from 'pixi.js';
import type { ParticlePool } from '../particlePool';
import { disc, ring, softDot, streak, streakScale, petal, petalScale, DOT_SIZE } from '../fxTextures';
import { arcFraction } from './ordnanceTells';

/** A slim dart (sizes in world units for a shell of scale 1) */
export interface DartShell {
  kind: 'dart';
  len: number;
  width: number;
  /** How far the fins reach out past the body */
  fin: number;
  /** The flame's length (it flickers between 0.75 and 1.25 of it) */
  flame: number;
  body: number;
  fins: number;
  nose: number;
  flameColor: number;
  flameCore: number;
}

/** A banded canister with a fuse ring and a nose lamp */
export interface CanisterShell {
  kind: 'canister';
  len: number;
  width: number;
  /** The fuse ring's radius */
  ring: number;
  body: number;
  cap: number;
  band: number;
  lamp: number;
  timer: number;
}

export type ShellBody = DartShell | CanisterShell;

export const DART_SHELL: DartShell = {
  kind: 'dart', len: 14, width: 3.6, fin: 3.6, flame: 11,
  body: 0xdfe6ee, fins: 0x8e98a3, nose: 0xff5a3c, flameColor: 0xffb060, flameCore: 0xfff2d0,
};

export const CANISTER_SHELL: CanisterShell = {
  kind: 'canister', len: 11, width: 7, ring: 10,
  body: 0x5d6352, cap: 0x3d4237, band: 0xff8a3c, lamp: 0xff5a2a, timer: 0xffc080,
};

/** How far through its fuse a canister is, 0 at the muzzle to 1 at its burst: its endTick, else the tick it is known to end on (0 when neither is known) */
export function fuseFraction(tick: number, spawnTick: number, endTick: number, endAt: number): number {
  return arcFraction(tick, spawnTick, endTick > 0 ? endTick : endAt);
}

/** The fuse lamp's blink period in ticks: slow at the muzzle, four times as quick at the burst */
export function lampPeriod(fuse: number): number {
  return 20 - 16 * Math.max(0, Math.min(1, fuse));
}

/** 0..1, steady for a given step: the flame's flicker */
function flicker(step: number): number {
  const s = Math.sin(step * 12.9898) * 43758.5453;
  return s - Math.floor(s);
}

/** Dots round a fuse ring at full quality, and the fewest that still read as a ring */
const RING_DOTS = 24;
const RING_DOTS_LOW = 12;
/** Below this share of particles (Medium is 0.7) the fins and the ring's tick marks are left off */
const FULL_DETAIL = 0.7;

export class ShellBodies {
  constructor(private readonly body: ParticlePool, private readonly light: ParticlePool) {}

  private line(pool: ParticlePool, x0: number, y0: number, x1: number, y1: number, width: number, color: number, alpha: number): void {
    const k = streakScale(Math.hypot(x1 - x0, y1 - y0), width);
    pool.take(streak(), (x0 + x1) / 2, (y0 + y1) / 2, 0.5, 0.5, color, alpha, Math.atan2(y1 - y0, x1 - x0), k.x, k.y);
  }

  private dot(pool: ParticlePool, tex: Texture, x: number, y: number, r: number, color: number, alpha: number): void {
    const k = (r * 2) / DOT_SIZE;
    pool.take(tex, x, y, 0.5, 0.5, color, alpha, 0, k, k);
  }

  /** A soft triangle from its base (x, y) out `len` along `angle`, `half` either side at the base */
  private tongue(pool: ParticlePool, x: number, y: number, angle: number, len: number, half: number, color: number, alpha: number): void {
    const k = petalScale(len, half);
    pool.take(petal(), x, y, 0, 0.5, color, alpha, angle, k.x, k.y);
  }

  /**
   * Draws a shell's body with its head at (hx, hy) flying along the unit vector (ux, uy), `z` its scale, `alpha` its
   * fade, `glow` its colour (the owner-tinted glow), `phase` its own 0..1 offset, `fuse` how far to its burst (0..1) and
   * `keep` the quality's share of particles. (tx, ty) is where its tracer begins.
   */
  draw(shell: ShellBody, hx: number, hy: number, tx: number, ty: number, ux: number, uy: number, z: number, alpha: number, glow: number, clock: number, phase: number, fuse: number, keep: number): void {
    if (shell.kind === 'dart') this.dart(shell, hx, hy, ux, uy, z, alpha, glow, clock, phase, keep);
    else this.canister(shell, hx, hy, tx, ty, ux, uy, z, alpha, glow, clock, fuse, keep);
  }

  private dart(s: DartShell, hx: number, hy: number, ux: number, uy: number, z: number, alpha: number, glow: number, clock: number, phase: number, keep: number): void {
    const m = Math.pow(z, 0.7), L = s.len * m, W = s.width * m, F = s.fin * m;
    const nx = -uy, ny = ux, ang = Math.atan2(uy, ux);
    // The body's middle sits half a length behind the head, so its nose is where the head is
    const cx = hx - ux * L * 0.5, cy = hy - uy * L * 0.5;
    const tailX = cx - ux * L * 0.5, tailY = cy - uy * L * 0.5;
    // Flame and its light first (they sit behind the body)
    const fl = s.flame * m * (0.75 + 0.5 * flicker(Math.floor(clock * 1.5) + phase * 13));
    this.dot(this.light, softDot(0.5, 0.1), tailX - ux * fl * 0.3, tailY - uy * fl * 0.3, 6 * m + fl * 0.4, glow, 0.5 * alpha);
    this.tongue(this.light, tailX, tailY, ang + Math.PI, fl, W * 0.55, s.flameColor, 0.75 * alpha);
    this.tongue(this.light, tailX, tailY, ang + Math.PI, fl * 0.55, W * 0.3, s.flameCore, 0.95 * alpha);
    // Fins swept back from the body's rear, then the body and its pointed nose
    if (keep >= FULL_DETAIL) {
      for (let side = -1; side <= 1; side += 2) {
        this.line(this.body, cx - ux * L * 0.2 + nx * side * W * 0.4, cy - uy * L * 0.2 + ny * side * W * 0.4,
          cx - ux * L * 0.5 + nx * side * (W * 0.5 + F), cy - uy * L * 0.5 + ny * side * (W * 0.5 + F), Math.max(1, 1.1 * m), s.fins, alpha);
      }
    }
    this.line(this.body, tailX, tailY, cx + ux * L * 0.2, cy + uy * L * 0.2, W, s.body, alpha);
    // (the body pool holds four textures, streak, disc, ring and the world's puff: the nose is discs, not a tongue)
    this.dot(this.body, disc(), cx + ux * L * 0.22, cy + uy * L * 0.22, W * 0.5, s.body, alpha);
    this.dot(this.body, disc(), cx + ux * L * 0.3, cy + uy * L * 0.3, W * 0.3, s.nose, alpha);
  }

  private canister(s: CanisterShell, hx: number, hy: number, tx: number, ty: number, ux: number, uy: number, z: number, alpha: number, glow: number, clock: number, fuse: number, keep: number): void {
    const m = Math.pow(z, 0.7), L = s.len * m, W = s.width * m, R = s.ring * Math.pow(z, 0.6);
    const nx = -uy, ny = ux;
    const cx = hx - ux * L * 0.5, cy = hy - uy * L * 0.5;
    // A short faint tracer behind it
    this.line(this.light, tx, ty, cx, cy, 2 * z, glow, 0.22 * alpha);
    // The fuse: a faint full ring and the dots still to burn, running down; the shell heats as it nears its burst
    const k = (R * 2 * 32) / (28 * DOT_SIZE);
    this.body.take(ring(), cx, cy, 0.5, 0.5, s.timer, 0.16 * alpha, 0, k, k);
    const dots = keep >= FULL_DETAIL ? RING_DOTS : RING_DOTS_LOW;
    const left = Math.ceil(dots * (1 - fuse)), hot = fuse > 0.8, dr = 0.55 * Math.sqrt(z) + 0.25;
    for (let i = 0; i < left; i++) {
      const a = -Math.PI / 2 + (Math.PI * 2 * i) / dots;
      this.dot(this.body, disc(), cx + Math.cos(a) * R, cy + Math.sin(a) * R, dr, hot ? 0xffffff : s.timer, 0.9 * alpha);
    }
    if (keep >= FULL_DETAIL) {
      for (let q = 0; q < 4; q++) {
        const a = -Math.PI / 2 + (Math.PI / 2) * q, c = Math.cos(a), sn = Math.sin(a);
        this.line(this.body, cx + c * R * 0.8, cy + sn * R * 0.8, cx + c * R * 1.2, cy + sn * R * 1.2, 0.8, s.timer, 0.6 * alpha);
      }
    }
    if (fuse > 0.75) this.dot(this.light, softDot(0.5, 0.1), cx, cy, W * 3, s.band, Math.min(1, (fuse - 0.75) * 2.4) * alpha);
    // The shell: its body, a darker cap at the tail, two bands across it
    this.line(this.body, cx - ux * L * 0.5, cy - uy * L * 0.5, cx + ux * L * 0.5, cy + uy * L * 0.5, W, s.body, alpha);
    this.line(this.body, cx - ux * L * 0.5, cy - uy * L * 0.5, cx - ux * L * 0.34, cy - uy * L * 0.34, W * 0.62, s.cap, alpha);
    for (let b = 0; b < 2; b++) {
      const p = b === 0 ? -0.07 : 0.13, bx = cx + ux * L * p, by = cy + uy * L * p;
      this.line(this.body, bx - nx * W * 0.46, by - ny * W * 0.46, bx + nx * W * 0.46, by + ny * W * 0.46, L * 0.15, s.band, alpha);
    }
    // The nose lamp
    const period = lampPeriod(fuse), on = clock % period < period * 0.45;
    const lx = cx + ux * L * 0.4, ly = cy + uy * L * 0.4, lr = (on ? 6 : 2) * Math.sqrt(z);
    this.dot(this.light, softDot(0.5, 0.1), lx, ly, lr, s.lamp, (on ? 0.95 : 0.25) * alpha);
    if (on) this.dot(this.body, disc(), lx, ly, lr * 0.3, 0xffffff, alpha);
  }
}
