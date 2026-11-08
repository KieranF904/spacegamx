/**
 * @contract client.weaponFx.tracer
 * owns:       drawing every flying shell: its tracer or body, contrail, afterimages, pulse rings, nose light, crackle and pull
 *             field, the lobbed shells' landing marks and the guided shell's guide line
 * needs:      FxField (pools, smoke list, line/circle), ShellBodies, WeaponStyle fields, TracerHost (guideTo, state)
 * invariants: a shell that ended at a surface draws nothing past it — client/src/rendering/weapons/visualStop.test.ts
 *             a dying tracer shrinks towards its head over FADE_FRAMES — none pinned
 * extend:     a new tracer look is one block in drawExtras (or drawBody for the shape itself), driven by a WeaponStyle field
 */

import { Container, Graphics } from 'pixi.js';
import { EntityType } from '@space-game/common';
import { DOT_SIZE } from '../../fxTextures';
import type { GameState } from '../../../state/GameState';
import { ShellBodies, fuseFraction } from '../shellBodies';
import { sonarPeriod } from '../ordnanceTells';
import type { FxField } from './FxField';
import { FADE_FRAMES, TEX, TEX2, mixColor } from './particleTypes';
import type { Shot } from './shotTypes';

/** A piece of contrail left in the world: it stays where it was laid and fades over `max` frames, long after the shot has gone */
interface TrailSeg { x0: number; y0: number; x1: number; y1: number; age: number; max: number; width: number; color: number; alpha: number }
const TRAIL_CAP = 2048;

const SHIP_TYPES = [EntityType.Player, EntityType.Enemy, EntityType.NPC, EntityType.ShipBody];

/** Crackle defaults (an EMP orb's) when a style asks for lightning with no numbers of its own */
const ORB_LIGHTNING = { color: 0xbfeaff, forks: 3, length: 7 };

/** What the tracers ask of WeaponFx (read live: the owner sets them after construction) */
export interface TracerHost {
  /** Where your cursor is in the world while you hold fire (a guided shell's guide line), else null; the object may be reused */
  readonly guideTo: (() => { x: number; y: number } | null) | null;
  readonly state: GameState | null;
}

/** One shell's drawn pose this frame (head, tail-end, its unit direction and normal), shared by the body and the extras */
interface TracerFrame {
  hx: number; hy: number; bx: number; by: number; ux: number; uy: number; nx: number; ny: number;
  dx: number; dy: number; dl: number; z: number; alpha: number; fade: number; glowCol: number; coreCol: number;
}

export class TracerFx {
  /** Shells drawn as bodies (a dart, a canister) rather than tracers: solid parts in the extra pool, light in the glow pool */
  private shells: ShellBodies;
  private crackle = new Graphics();
  /** Redrawn every frame it's crackling, so a render group of its own (Pixi rebuilds its draw list, not the scene's) */
  readonly crackleGroup = new Container({ isRenderGroup: true });
  private crackling = false;
  private readonly fr: TracerFrame = { hx: 0, hy: 0, bx: 0, by: 0, ux: 1, uy: 0, nx: 0, ny: 1, dx: 0, dy: 0, dl: 0, z: 1, alpha: 1, fade: 1, glowCol: 0, coreCol: 0 };
  /** Contrail segments, a ring buffer of reused records (oldest overwritten when full); `trailLen` are live, ending at `trailHead` */
  private trail: TrailSeg[] = Array.from({ length: TRAIL_CAP }, () => ({ x0: 0, y0: 0, x1: 0, y1: 0, age: 0, max: 0, width: 0, color: 0, alpha: 0 }));
  private trailHead = 0;
  private trailLen = 0;

  constructor(private readonly f: FxField, private readonly host: TracerHost) {
    this.shells = new ShellBodies(f.extraG, f.glow);
    this.crackle.blendMode = 'add';
    this.crackleGroup.addChild(this.crackle);
  }

  /** Clears last frame's crackle lines */
  beginFrame(): void {
    if (this.crackling) { this.crackle.clear(); this.crackling = false; }
  }

  /** Draws every shell, the landing marks and the contrails (`clock`: frames since start, for sway and pulses) */
  drawAll(shots: ReadonlyMap<number, Shot>, clock: number, frames: number): void {
    for (const shot of shots.values()) this.drawShot(shot, clock, frames);
    this.drawLandings(shots.values());
    this.drawTrails(frames);
  }

  /** One shell this frame: its pose (through the dying shrink and sway), then body and extras */
  private drawShot(shot: Shot, clock: number, frames: number): void {
    if (!shot.head || !shot.tail || (shot.fading !== null && shot.fading >= FADE_FRAMES)) return;
    const fade = shot.fading === null ? 1 : 1 - shot.fading / FADE_FRAMES;
    const st = shot.style;
    // A dying tracer shrinks towards its head
    const k = shot.fading === null ? 0 : shot.fading / FADE_FRAMES;
    const tx = shot.tail.x + (shot.head.x - shot.tail.x) * k;
    const ty = shot.tail.y + (shot.head.y - shot.tail.y) * k;

    const z = shot.size * (st.lob ? 1 + st.lob * Math.sin(Math.PI * shot.arc) : 1);
    let hx = shot.head.x, hy = shot.head.y, bx = tx, by = ty;
    const dx = hx - bx, dy = hy - by, dl = Math.hypot(dx, dy);
    const ux = dl > 1e-6 ? dx / dl : 1, uy = dl > 1e-6 ? dy / dl : 0, nx = -uy, ny = ux;
    let alpha = fade * shot.dim;
    let coreCol = st.coreColor, glowCol = shot.glow;
    if (st.heat) {
      // (tracers run from the cold colour to the hot one with the gun's spin)
      coreCol = mixColor(st.heat.cold, st.heat.hot, shot.hot);
      glowCol = mixColor(shot.glow, st.heat.cold, 0.5 + 0.3 * shot.hot);
    }
    if (st.blink) alpha *= ((clock / st.blink + shot.phase * 2) % 1) < 0.5 ? 1 : 0.2;
    if (st.wobble && !shot.ended) {
      // The head sways across its line, the tail trailing the sway
      const w = st.wobble, sw = Math.sin(((clock + shot.phase * w.period) / w.period) * Math.PI * 2) * w.amp * z;
      hx += nx * sw; hy += ny * sw;
      bx += nx * sw * 0.4; by += ny * sw * 0.4;
    }
    const fr = this.fr;
    fr.hx = hx; fr.hy = hy; fr.bx = bx; fr.by = by; fr.ux = ux; fr.uy = uy; fr.nx = nx; fr.ny = ny;
    fr.dx = dx; fr.dy = dy; fr.dl = dl; fr.z = z; fr.alpha = alpha; fr.fade = fade; fr.glowCol = glowCol; fr.coreCol = coreCol;
    this.drawBody(shot, fr, clock);
    this.drawExtras(shot, fr, clock, frames);
  }

  /** The tracer's lines, halo and head (or the shell's body); an ended shell collapses into its impact point */
  private drawBody(shot: Shot, fr: TracerFrame, clock: number): void {
    const st = shot.style, g = this.f.glow;
    const { hx, hy, bx, by, ux, uy, nx, ny, dl, z, alpha, glowCol, coreCol } = fr;
    if (st.shell) {
      // A body in place of the tracer; once it ends at a surface nothing of it is drawn (the impact is)
      if (!shot.ended) {
        this.shells.draw(st.shell, hx, hy, bx, by, ux, uy, z, alpha, shot.glow, clock, shot.phase,
          fuseFraction(shot.t, shot.spawnTick, shot.endTick, shot.endAt), this.f.particleKeep);
      }
    } else {
      const lanes = st.pair ? 2 : 1;
      for (let lane = 0; lane < lanes; lane++) {
        // A pair runs as two thinner tracers either side of the line
        const off = lanes === 2 ? (lane === 0 ? -0.5 : 0.5) * st.pair!.gap * z : 0, wk = lanes === 2 ? 0.7 : 1;
        const ox = nx * off, oy = ny * off;
        if (shot.ended) {
          // Ended at a surface: the tracer collapses into the impact point, its round end kept behind it, no head or halo
          // past it (the impact is drawn there)
          const gw = st.glowWidth * z * wk, cw = st.coreWidth * z * wk;
          if (gw > 0 && dl > gw) this.f.line(bx + ox, by + oy, hx + ox - ux * gw * 0.5, hy + oy - uy * gw * 0.5, gw, glowCol, st.glowAlpha * alpha);
          if (cw > 0 && dl > cw) this.f.line(bx + ox, by + oy, hx + ox - ux * cw * 0.5, hy + oy - uy * cw * 0.5, cw, coreCol, 0.9 * alpha);
          continue;
        }
        if (st.glowWidth > 0) this.f.line(bx + ox, by + oy, hx + ox, hy + oy, st.glowWidth * z * wk, glowCol, st.glowAlpha * alpha);
        if (st.coreWidth > 0) this.f.line(bx + ox, by + oy, hx + ox, hy + oy, st.coreWidth * z * wk, coreCol, 0.9 * alpha);
        if (st.haloRadius > 0) {
          this.f.circle(g, TEX.disc, hx + ox, hy + oy, st.haloRadius * z * wk, shot.glow, 0.14 * alpha);
          this.f.circle(g, TEX.disc, hx + ox, hy + oy, st.haloRadius * z * wk * 0.55, shot.glow, 0.22 * alpha);
        }
        if (st.headRadius > 0) this.f.circle(g, TEX.disc, hx + ox, hy + oy, st.headRadius * z * wk, st.headColor ?? 0xffffff, alpha);
      }
    }
  }

  /** What a shell adds beside its body: contrail, afterimages, pulse rings, nose light, guide, cloud, lightning, pull, smoke */
  private drawExtras(shot: Shot, fr: TracerFrame, clock: number, frames: number): void {
    const st = shot.style, g = this.f.glow;
    const { hx, hy, bx, by, ux, uy, nx, ny, dx, dy, dl, z, alpha, fade } = fr;
    const speed = Math.hypot(shot.vx, shot.vy);
    // A contrail: a segment laid from where the head was last frame to where it is now, left in the world to fade over `life` frames
    const ct = st.contrail;
    if (ct && shot.fading === null) {
      if (shot.ctX === shot.ctX && Math.hypot(hx - shot.ctX, hy - shot.ctY) > 0.5) {
        const sg = this.trail[this.trailHead];
        sg.x0 = shot.ctX; sg.y0 = shot.ctY; sg.x1 = hx; sg.y1 = hy; sg.age = 0; sg.max = ct.life;
        sg.width = ct.size * z; sg.color = ct.color; sg.alpha = 0.5 * alpha;
        this.trailHead = (this.trailHead + 1) % TRAIL_CAP;
        if (this.trailLen < TRAIL_CAP) this.trailLen++;
      }
      shot.ctX = hx; shot.ctY = hy;
    }
    // Ghost copies of the head, each further back and fainter
    if (st.afterimages && shot.fading === null) {
      const gap = Math.max(3, speed * 0.9);
      for (let i = 1; i <= st.afterimages; i++) {
        const f = i / (st.afterimages + 1);
        this.f.circle(g, TEX.disc, hx - ux * gap * i, hy - uy * gap * i, Math.max(1, st.headRadius * z) * (1 - 0.5 * f), shot.glow, 0.5 * (1 - f) * alpha * (0.55 + 0.45 * Math.sin(clock * 0.9 + i * 2.1 + shot.phase * 11)));
      }
    }
    // A ring swelling off the head and fading, again and again
    const rp = st.ringPulse;
    if (rp && shot.fading === null) {
      // (A sonar quickens as it closes on a ship: the phase builds up, so the period can change without a jump)
      if (shot.pulse === 0) shot.pulse = shot.phase || 0.001;
      shot.pulse += frames / (rp.closing ? sonarPeriod(rp.period, this.nearestShip(shot), rp.closing) : rp.period);
      const q = shot.pulse % 1, r = rp.size * z * (0.3 + 0.7 * q);
      const k2 = (r * 2 * 32) / (28 * DOT_SIZE);
      this.f.extraG.take(TEX2.ring, hx, hy, 0.5, 0.5, rp.color, 0.7 * (1 - q) * alpha, 0, k2, k2);
    }
    // A light at the nose: a hard blink, or a slow pulse
    const ns = st.nose;
    if (ns && shot.fading === null) {
      const ph = ((clock + shot.phase * ns.period) % ns.period) / ns.period;
      const on = ns.blink ? (ph < 0.22 ? 1 : 0) : 0.5 + 0.5 * Math.sin(ph * Math.PI * 2);
      if (on > 0.02) {
        this.f.circle(g, TEX.dot, hx, hy, ns.size * z * (0.8 + 0.5 * on), ns.color, 0.6 * on * alpha);
        this.f.circle(g, TEX.disc, hx, hy, ns.size * z * 0.28, mixColor(ns.color, 0xffffff, 0.5), on * alpha);
      }
    }
    // Your own guided shell: a dashed guide to your cursor while you hold fire (it flies where you point)
    if (st.guide && shot.fading === null && shot.owner === this.host.state?.playerId) this.guideLine(hx, hy);
    // A thin cloud as it flies: soft puffs along its path
    const sc = st.smokeCloud;
    if (sc?.fly && shot.fading === null) {
      const reach = Math.min(speed * 6, 180);
      for (let i = 0; i < 5; i++) {
        const f = (i + 1) / 5, r = sc.size * z * (0.7 + 0.8 * f), kk = (r * 2) / DOT_SIZE;
        this.f.extraG.take(TEX2.puff, hx - ux * reach * f, hy - uy * reach * f, 0.5, 0.5, sc.color, 0.22 * (1 - f) * alpha, 0, kk, kk);
      }
    }
    // A blast radius you can see coming: a faint ring round the head, the whole flight
    const rr = st.radiusRing;
    if (rr && shot.fading === null) {
      const k2 = (rr.radius * 2 * 32) / (28 * DOT_SIZE);
      this.f.extraG.take(TEX2.ring, hx, hy, 0.5, 0.5, rr.color, 0.22 * alpha, 0, k2, k2);
    }
    // A bolt of lightning down the whole tracer, different every frame
    const jg = st.jagged;
    if (jg && shot.fading === null && dl > 1) {
      const c = this.crackle, n = Math.max(4, Math.min(14, Math.round(dl / 40)));
      this.crackling = true;
      for (let pass = 0; pass < 2; pass++) {
        c.moveTo(bx, by);
        for (let i = 1; i <= n; i++) {
          const f = i / n, o = i === n ? 0 : (Math.random() - 0.5) * 2 * jg.amp * z;
          c.lineTo(bx + dx * f + nx * o, by + dy * f + ny * o);
        }
        c.stroke(pass === 0 ? { color: jg.color, width: 3, alpha: 0.35 * fade } : { color: 0xffffff, width: 1.2, alpha: 0.95 * fade });
      }
    }
    // Crackle (EMP orbs, arcs, lightning-wrapped shots)
    const lt = st.lightning ?? (st.orb ? ORB_LIGHTNING : undefined);
    if (lt && shot.fading === null) {
      const c = this.crackle, as = st.arcScale ?? 1;
      this.crackling = true;
      for (let k = 0; k < lt.forks; k++) {
        const a0 = Math.random() * Math.PI * 2;
        let x = hx, y = hy;
        c.moveTo(x, y);
        for (let j = 0; j < 4; j++) {
          x += Math.cos(a0 + (Math.random() - 0.5) * 1.6) * lt.length * as * z;
          y += Math.sin(a0 + (Math.random() - 0.5) * 1.6) * lt.length * as * z;
          c.lineTo(x, y);
        }
        c.stroke({ color: lt.color, width: 1.5, alpha: 0.8 * fade });
      }
    }
    // A gravity well: a faint ring at the pull radius and motes streaming in to the head, quickening as they fall
    const pl = st.pull;
    if (pl && shot.fading === null) {
      const c = this.crackle;
      this.crackling = true;
      c.circle(hx, hy, pl.radius).stroke({ color: pl.color, width: 2.5, alpha: 0.14 * alpha });
      c.circle(hx, hy, pl.radius * 0.985).stroke({ color: pl.color, width: 9, alpha: 0.04 * alpha });
      const N = 22;
      for (let i = 0; i < N; i++) {
        const f = (clock * 0.011 + i / N + shot.phase) % 1, a = i * 2.399 + shot.phase * 6.283 + f * 1.1;
        const r1 = pl.radius * (1 - f * f), r0 = Math.min(pl.radius, r1 + 24 + 90 * f), ca = Math.cos(a), sa = Math.sin(a);
        c.moveTo(hx + ca * r0, hy + sa * r0).lineTo(hx + ca * r1, hy + sa * r1).stroke({ color: pl.color, width: 2, alpha: 0.55 * Math.sin(f * Math.PI) * alpha });
      }
    }
    // Missiles leave smoke
    if (st.trail && shot.fading === null && Math.random() < 0.8) {
      this.f.smoke.push({ x: (st.wobble ? hx : shot.head!.x) - shot.vx * 0.5, y: (st.wobble ? hy : shot.head!.y) - shot.vy * 0.5, vx: (Math.random() - 0.5) * 0.4, vy: (Math.random() - 0.5) * 0.4,
        life: 0, max: st.trail.life * (0.7 + Math.random() * 0.6), size: st.trail.size * (0.6 + Math.random() * 0.5) });
    }
  }

  private drawLandings(shots: Iterable<Shot>): void {
    for (const shot of shots) {
      if (shot.fading === null && shot.endTick && shot.style.aimTick && shot.head && shot.owner === this.host.state?.playerId) {
        // Your Cloudmaker shell: a faint tick across its line where it will burst
        const sp = Math.hypot(shot.vx, shot.vy) || 1, nx = -shot.vy / sp, ny = shot.vx / sp;
        this.f.line(shot.landX - nx * 26, shot.landY - ny * 26, shot.landX + nx * 26, shot.landY + ny * 26, 2, shot.style.coreColor, 0.45);
        this.f.ringAt(shot.landX, shot.landY, 9, shot.style.coreColor, 0.35);
      }
      if (shot.fading !== null || !shot.endTick || !shot.style.landBurst || !shot.head) continue;
      const f = shot.arc, r = shot.splash || 200;
      const own = shot.owner === this.host.state?.playerId;
      const col = own ? shot.style.impact.color : 0xff6a4a;
      this.f.ringAt(shot.landX, shot.landY, r, col, 0.16 + 0.34 * f);
      this.f.ringAt(shot.landX, shot.landY, r * (1 + 1.3 * (1 - f)), col, 0.25 + 0.45 * f);
      this.f.circle(this.f.extraG, TEX.dot, shot.landX, shot.landY, 10 + 20 * f, col, 0.2 + 0.4 * f);
    }
  }

  private nearestShip(shot: Shot): number {
    const st = this.host.state;
    if (!st || !shot.head) return Infinity;
    let best = Infinity;
    for (const type of SHIP_TYPES) {
      for (const e of st.entities.ofType(type)) {
        if (e.id === shot.owner) continue;
        const d = Math.hypot(e.renderX - shot.head.x, e.renderY - shot.head.y);
        if (d < best) best = d;
      }
    }
    return best;
  }

  private guideLine(x: number, y: number): void {
    const to = this.host.guideTo?.();
    if (!to) return;
    const dx = to.x - x, dy = to.y - y, full = Math.hypot(dx, dy), len = Math.min(full, 1400);
    if (len < 40) return;
    const ux = dx / full, uy = dy / full;
    for (let d = 30; d < len; d += 38) {
      const e = Math.min(len, d + 20);
      this.f.line(x + ux * d, y + uy * d, x + ux * e, y + uy * e, 1.5, 0xcfe6ff, 0.34 * (1 - d / 1700));
    }
    if (full <= 1400) this.f.ringAt(to.x, to.y, 14, 0xcfe6ff, 0.4);
  }

  private drawTrails(frames: number): void {
    for (let i = 0; i < this.trailLen; i++) {
      const sg = this.trail[(this.trailHead - 1 - i + TRAIL_CAP) % TRAIL_CAP];
      sg.age += frames;
      if (sg.age >= sg.max) continue;
      const f = 1 - sg.age / sg.max;
      this.f.line(sg.x0, sg.y0, sg.x1, sg.y1, sg.width, sg.color, sg.alpha * f);
    }
    // (Lives differ per style, so only the oldest ones can be dropped from the count)
    while (this.trailLen > 0) {
      const old = this.trail[(this.trailHead - this.trailLen + TRAIL_CAP) % TRAIL_CAP];
      if (old.age < old.max) break;
      this.trailLen--;
    }
  }
}
