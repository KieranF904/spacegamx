/**
 * All projectile visuals: tracers, heads, muzzle flashes and impact sparks.
 *
 * Shots are placed from their exact spawn point and spawn tick (both in the
 * snapshot), not from wherever the first snapshot happened to catch them, so
 * every tracer leaves the muzzle and travels continuously:
 *   - your own shots run on the present timeline, matching your predicted ship
 *   - everyone else's run on the interpolated timeline, matching their ships
 * When the server reports a hit (damage message with the hit point), the tracer
 * stops there and throws sparks.
 *
 * Barrels are deterministic: a shell's spawn point is its barrel at its fire
 * tick, and the firing ship is drawn on the same timeline, so the two meet
 * when the shot's age reaches 0. That's when its muzzle flash goes off (shots
 * usually arrive a little ahead of that, in the interpolation buffer), pinned
 * to the ship from then on as it flies and turns.
 *
 * Your own shells don't wait for the server: your client fires them on the
 * tick it predicts (common/src/ships/guns.ts), from the same barrel with the
 * same spread (predict). When the server's copy arrives it takes over the
 * shell already flying (same tick, same spawn, same heading), so hits stop it;
 * one the server never fired fades out after CONFIRM_TICKS.
 *
 * Everything is pooled sprites of painted textures (fxTextures.ts), so a frame
 * only moves and fades them; only an EMP orb's crackle is drawn as lines.
 */

import { Container, Graphics, Texture } from 'pixi.js';
import { disc, softDot, streak, streakScale, petal, petalScale, DOT_SIZE } from '../fxTextures';
import { ParticlePool } from '../particlePool';
import { EntityType, WeaponType } from '@space-game/common';
import type { GameState, InterpolatedEntity } from '../../state/GameState';
import { WeaponStyle, weaponStyle } from './weaponStyles';
import type { Lighting } from '../lighting/Lighting';

interface Shot {
  id: number;
  style: WeaponStyle;
  /** Shell size relative to the base shot (fixed cannons fire bigger shells) */
  size: number;
  type: number;
  owner: number;
  glow: number;
  spawnX: number;
  spawnY: number;
  spawnTick: number;
  vx: number;
  vy: number;
  hit: { x: number; y: number } | null;
  /** Its muzzle flash has gone off (at age 0 on its timeline) */
  flashed: boolean;
  /** Fired by your own client ahead of the server (until the server's copy takes it over) */
  predicted: boolean;
  /** The firing ship's pose on the fire tick (the flash sits on the barrel in its frame) */
  pose?: FirePoseXY;
  /** Drawn from the barrel's tip, not the spawn point: this offset at first, easing to none over BARREL_EASE ticks (muzzleFlash) */
  vox?: number;
  voy?: number;
  /** Frames since the shot stopped (hit or removed); null while flying */
  fading: number | null;
  head: { x: number; y: number } | null;
  tail: { x: number; y: number } | null;
}

/** A muzzle flash: pinned to the ship that fired it (`owner`, at `ox, oy` and `rel` in its frame) */
interface Flash {
  x: number; y: number; angle: number; life: number; max: number; size: number; color: number; sparks: { a: number; l: number }[]; petals: number[];
  /** Its flash's width × this (a heavy shell's is fat) */
  girth: number;
  owner: number; ox: number; oy: number; rel: number;
}
interface Smoke { x: number; y: number; vx: number; vy: number; life: number; max: number; size: number }
interface Spark { x: number; y: number; vx: number; vy: number; life: number; max: number; color: number }
interface Ring { x: number; y: number; life: number; max: number; size: number; color: number }

const FADE_FRAMES = 9;
/** A shell drawn from its barrel's tip eases onto its true path over this many ticks */
const BARREL_EASE = 8;
/** A predicted shell the server hasn't confirmed by then was never fired: it fades */
const CONFIRM_TICKS = 60;

export interface FirePoseXY { x: number; y: number; angle: number }

/** A shell your client fired ahead of the server */
export interface PredictedShell {
  /** Your ship's pose on the fire tick */
  pose: FirePoseXY;
  owner: number;
  type: number;
  /** Its gun's grade (Mk I-V): each mark's shells look their own way */
  grade?: number;
  spawnX: number;
  spawnY: number;
  spawnTick: number;
  vx: number;
  vy: number;
  size: number;
}

function mixColor(a: number, b: number, t: number): number {
  const r = ((a >> 16) & 255) * (1 - t) + ((b >> 16) & 255) * t;
  const g = ((a >> 8) & 255) * (1 - t) + ((b >> 8) & 255) * t;
  const bl = (a & 255) * (1 - t) + (b & 255) * t;
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(bl);
}

function hueColor(h: number): number {
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return 0.6 - 0.4 * Math.max(Math.min(k - 3, 9 - k, 1), -1);
  };
  return (Math.round(f(0) * 255) << 16) | (Math.round(f(8) * 255) << 8) | Math.round(f(4) * 255);
}

const TEX = { get disc() { return disc(); }, get dot() { return softDot(0.5, 0.1); }, get streak() { return streak(); }, get petal() { return petal(); } };

export class WeaponFx {
  /** Light (additive) and smoke (normal blending) */
  /**
   * Normal blending, as these have always been drawn: the pool's 'add' never reached its sprites once the bloom made
   * it a render group (Pixi doesn't pass a render group's blend mode on). Additive would be brighter, a look to choose.
   */
  private glow = new ParticlePool('normal');
  private smokeG = new ParticlePool('normal');
  private crackle = new Graphics();
  /** Redrawn every frame it's crackling, so a render group of its own (Pixi rebuilds its draw list, not the scene's) */
  private crackleGroup = new Container({ isRenderGroup: true });
  private crackling = false;
  private smoke: Smoke[] = [];
  private shots = new Map<number, Shot>();
  private flashes: Flash[] = [];
  private sparks: Spark[] = [];
  private rings: Ring[] = [];
  /** A shot seen leaving its gun (the ship renderer kicks the turret back) */
  onMuzzle: ((owner: number, x: number, y: number) => void) | null = null;
  /** Where a shot leaving (x, y) along `angle` comes out of its drawn barrel (the ship renderer knows), if it can tell */
  barrelTip: ((owner: number, x: number, y: number, angle: number) => { x: number; y: number } | null) | null = null;
  /** The firing ship's pose on a shell's fire tick, where it's known (shells built from fire events) */
  firePose: ((id: number) => FirePoseXY | undefined) | null = null;

  /** Everything here that glows (for the bloom) */
  get glowLayer(): Container {
    return this.glow.container;
  }

  constructor(layer: Container) {
    this.crackle.blendMode = 'add';
    this.crackleGroup.addChild(this.crackle);
    layer.addChild(this.smokeG.container, this.glow.container, this.crackleGroup);
  }

  /** A line from (x0, y0) to (x1, y1), `width` thick with soft round ends */
  private line(x0: number, y0: number, x1: number, y1: number, width: number, color: number, alpha: number): void {
    const len = Math.hypot(x1 - x0, y1 - y0);
    const k = streakScale(len, width);
    this.glow.take(TEX.streak, (x0 + x1) / 2, (y0 + y1) / 2, 0.5, 0.5, color, alpha, Math.atan2(y1 - y0, x1 - x0), k.x, k.y);
  }

  /** A filled circle (smooth-edged) */
  private circle(pool: ParticlePool, tex: Texture, x: number, y: number, r: number, color: number, alpha: number): void {
    const k = (r * 2) / DOT_SIZE;
    pool.take(tex, x, y, 0.5, 0.5, color, alpha, 0, k, k);
  }

  /** Projectile ids seen this frame (reused) */
  private seenShots = new Set<number>();

  /**
   * @param presentTick server tick "now" (the local player's predicted timeline)
   * @param renderTick  interpolated timeline other entities are drawn on
   */
  update(state: GameState, delta: number, presentTick: number, renderTick: number): void {
    const frames = Math.min(4, delta * 60);
    const seen = this.seenShots;
    seen.clear();

    for (const e of state.entities.values()) {
      if (e.type !== EntityType.Projectile) continue;
      seen.add(e.id);
      let shot = this.shots.get(e.id);
      if (!shot) {
        // Your own shell, already flying since your client fired it? The server's copy takes it over
        shot = this.claim(e) ?? this.createShot(e);
        this.shots.set(e.id, shot);
      }
      const t = this.timeline(shot, state, presentTick, renderTick);
      // The flash goes off when the shot leaves the gun on its timeline (the ship is drawn at that tick too):
      // not when it arrives, which is usually a little early. Shots first seen well downrange don't flash.
      if (!shot.flashed && t >= shot.spawnTick) {
        shot.flashed = true;
        if (t - shot.spawnTick < 12) this.muzzleFlash(shot, state.entities.get(shot.owner));
      }
      if (shot.fading === null) this.place(shot, e, t);
    }

    // Flashes ride along with their guns: the ship keeps moving and turning under them
    for (const f of this.flashes) {
      const o = f.owner >= 0 ? state.entities.get(f.owner) : undefined;
      if (!o) continue;
      const c = Math.cos(o.renderAngle), sn = Math.sin(o.renderAngle);
      f.x = o.renderX + f.ox * c - f.oy * sn;
      f.y = o.renderY + f.ox * sn + f.oy * c;
      f.angle = o.renderAngle + f.rel;
    }

    // Shots the server removed without a reported hit just burn out where they are
    for (const shot of this.shots.values()) {
      if (shot.predicted) {
        // Not confirmed yet: it flies on its own (and fades if the server never fired it)
        if (shot.fading !== null) continue;
        if (presentTick - shot.spawnTick > CONFIRM_TICKS) { shot.fading = 0; continue; }
        if (!shot.flashed && presentTick >= shot.spawnTick) {
          shot.flashed = true;
          this.muzzleFlash(shot, state.entities.get(shot.owner));
        }
        this.place(shot, undefined, presentTick);
        continue;
      }
      if (!seen.has(shot.id) && shot.fading === null) shot.fading = 0;
    }

    this.draw(frames);
  }

  /** Shots, muzzle flashes and impacts light what's near them (see rendering/lighting) */
  collectLights(L: Lighting): void {
    for (const s of this.shots.values()) {
      if (!s.head) continue;
      const f = s.fading === null ? 1 : 1 - s.fading / FADE_FRAMES;
      // (a great orb lights no further than a big shell: its own glow is light enough)
      L.point(s.head.x, s.head.y, s.glow, 90 + 150 * Math.min(s.size, 3) + s.style.haloRadius * 3, 0.45 * f * (s.style.orb ? 2 : 1));
    }
    for (const f of this.flashes) L.point(f.x, f.y, f.color, 70 + f.size * 7, 1.4 * (1 - f.life / f.max));
    for (const r of this.rings) L.point(r.x, r.y, r.color, 80 + r.size * 6, 1.1 * (1 - r.life / r.max));
  }

  /** A damage message with a hit point: stop that tracer there and throw sparks. */
  onHit(projectileId: number | undefined, x: number, y: number): void {
    const shot = projectileId !== undefined ? this.shots.get(projectileId) : undefined;
    const style = shot?.style ?? weaponStyle(WeaponType.Cannon);
    const size = shot?.size ?? 1;
    let normal = Math.random() * Math.PI * 2;
    if (shot) {
      shot.hit = { x, y };
      shot.head = { x, y };
      if (shot.fading === null) shot.fading = 0;
      normal = Math.atan2(-shot.vy, -shot.vx);
    }
    const imp = style.impact;
    for (let i = 0; i < imp.sparks * size; i++) {
      const a = normal + (Math.random() - 0.5) * 2.2;
      const s = imp.speed * (0.4 + Math.random());
      this.sparks.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0, max: imp.life * (0.6 + Math.random() * 0.6), color: Math.random() < 0.25 ? 0xffffff : imp.color });
    }
    this.rings.push({ x, y, life: 0, max: 10, size: imp.flash * size, color: imp.color });
    // The heavier marks ring out wider and slower
    if (imp.ring !== undefined) this.rings.push({ x, y, life: 0, max: 16, size: imp.flash * size * 1.8, color: imp.ring });
    // A puff of vapourised hull
    for (let i = 0; i < 2; i++) {
      const a = normal + (Math.random() - 0.5) * 1.2;
      this.smoke.push({ x, y, vx: Math.cos(a) * 0.8, vy: Math.sin(a) * 0.8, life: 0, max: 40 + Math.random() * 20, size: 6 * size });
    }
  }

  // -------------------------------------------------------------------------

  private createShot(e: InterpolatedEntity): Shot {
    const type = e.data?.[0] ?? WeaponType.Cannon;
    // data[1]: the gun's grade
    const style = weaponStyle(type, e.data?.[1] ?? 1);
    const hue = e.data?.[2] ?? 30;
    return {
      id: e.id,
      style,
      size: e.data?.[7] || 1,
      type,
      owner: e.data?.[6] ?? -1,
      glow: mixColor(style.glowColor, hueColor(hue), style.ownerTint),
      spawnX: e.spawnX ?? e.x,
      spawnY: e.spawnY ?? e.y,
      spawnTick: e.spawnTick ?? 0,
      vx: e.vx,
      vy: e.vy,
      hit: null,
      flashed: false,
      predicted: false,
      pose: this.firePose?.(e.id),
      fading: null,
      head: null,
      tail: null,
    };
  }

  private nextPredicted = -1;

  /** A shell your client just fired (guns.ts): it flies from your barrel now, the server's copy takes it over when it comes */
  predict(p: PredictedShell): void {
    const style = weaponStyle(p.type, p.grade);
    const id = this.nextPredicted--;
    this.shots.set(id, {
      id, style, size: p.size, type: p.type, owner: p.owner,
      glow: mixColor(style.glowColor, hueColor((p.owner * 137) % 360), style.ownerTint),
      spawnX: p.spawnX, spawnY: p.spawnY, spawnTick: p.spawnTick, vx: p.vx, vy: p.vy,
      hit: null, flashed: false, predicted: true, pose: p.pose, fading: null, head: null, tail: null,
    });
  }

  /**
   * The server's copy of a shell we fired ahead: same owner and weapon, the
   * same tick, from the same barrel, the same way. It takes over (keeping the
   * flight already drawn), so hits reported for it stop the right tracer.
   */
  private claim(e: InterpolatedEntity): Shot | null {
    const owner = e.data?.[6] ?? -1, type = e.data?.[0] ?? -1;
    const sx = e.spawnX ?? e.x, sy = e.spawnY ?? e.y, tick = e.spawnTick ?? 0;
    let best: Shot | null = null, bd = Infinity;
    for (const s of this.shots.values()) {
      if (!s.predicted || s.owner !== owner || s.type !== type || s.fading !== null) continue;
      const dt = Math.abs(s.spawnTick - tick);
      if (dt > 3) continue;
      const d = Math.hypot(s.spawnX - sx, s.spawnY - sy) + Math.hypot(s.vx - e.vx, s.vy - e.vy) * 20 + dt * 10;
      if (d < bd) { bd = d; best = s; }
    }
    if (!best || bd > 120) return null;
    this.shots.delete(best.id);
    best.id = e.id;
    best.predicted = false;
    return best;
  }

  private timeline(shot: Shot, state: GameState, presentTick: number, renderTick: number): number {
    return !state.predictionEnabled || shot.owner === state.playerId ? presentTick : renderTick;
  }

  private place(shot: Shot, e: InterpolatedEntity | undefined, t: number): void {
    const age = t - shot.spawnTick;
    if (age < 0) { shot.head = null; return; } // not fired yet on this timeline
    const trail = shot.style.tracerTicks;
    if (shot.style.motion === 'linear') {
      // (From its barrel's tip at first, easing onto its true path)
      const off = (a: number) => Math.max(0, 1 - a / BARREL_EASE);
      const ox = shot.vox ?? 0, oy = shot.voy ?? 0;
      shot.head = { x: shot.spawnX + shot.vx * age + ox * off(age), y: shot.spawnY + shot.vy * age + oy * off(age) };
      const ta = Math.max(0, age - trail);
      shot.tail = { x: shot.spawnX + shot.vx * ta + ox * off(ta), y: shot.spawnY + shot.vy * ta + oy * off(ta) };
    } else if (e) {
      shot.head = { x: e.renderX, y: e.renderY };
      // Tail follows the current heading back, but never behind the muzzle
      const back = Math.min(Math.hypot(e.vx, e.vy) * trail, Math.hypot(e.renderX - shot.spawnX, e.renderY - shot.spawnY));
      const sp = Math.hypot(e.vx, e.vy) || 1;
      shot.tail = { x: e.renderX - (e.vx / sp) * back, y: e.renderY - (e.vy / sp) * back };
    }
  }

  /** A directional flash out of the barrel (a long forward tongue and two side petals), sparks and a smoke puff */
  private muzzleFlash(shot: Shot, owner?: { renderX: number; renderY: number; renderAngle: number }): void {
    const m = shot.style.muzzle;
    const angle = Math.atan2(shot.vy, shot.vx);
    this.onMuzzle?.(shot.owner, shot.spawnX, shot.spawnY);
    // At the drawn barrel's tip (shells spawn on the facing edge, the barrel pokes out past it), and the shell drawn from there too
    const tip = this.barrelTip?.(shot.owner, shot.spawnX, shot.spawnY, angle);
    if (tip) { shot.vox = tip.x - shot.spawnX; shot.voy = tip.y - shot.spawnY; }
    const x = tip?.x ?? shot.spawnX, y = tip?.y ?? shot.spawnY;
    const size = m.size * shot.size;
    // The barrel in the ship's frame: from the ship's pose on the fire tick (exact), else as it's drawn now (it's drawn at that tick)
    const ref = shot.pose ?? (owner ? { x: owner.renderX, y: owner.renderY, angle: owner.renderAngle } : undefined);
    const oa = ref?.angle ?? 0, c = Math.cos(-oa), sn = Math.sin(-oa);
    const dx = ref ? x - ref.x : 0, dy = ref ? y - ref.y : 0;
    this.flashes.push({
      x, y, angle, life: 0, max: m.life, size, color: m.color,
      sparks: Array.from({ length: m.sparks }, () => ({ a: (Math.random() - 0.5) * 0.7, l: size * (0.9 + Math.random() * 1.1) })),
      petals: [(1.6 + Math.random() * 0.8) * (m.tongue ?? 1), 0.6 + Math.random() * 0.3, 0.6 + Math.random() * 0.3], girth: m.girth ?? 1,
      owner: owner ? shot.owner : -1, ox: dx * c - dy * sn, oy: dx * sn + dy * c, rel: angle - oa,
    });
    // Smoke puffs out ahead of the barrel, carried a little by the shot, and left behind as the ship flies on
    for (let i = 0; i < m.smoke; i++) {
      const a = angle + (Math.random() - 0.5) * 0.8, s = 0.8 + Math.random() * 1.6;
      const ahead = size * (0.4 + Math.random() * 0.5);
      this.smoke.push({ x: x + Math.cos(angle) * ahead, y: y + Math.sin(angle) * ahead, vx: Math.cos(a) * s + shot.vx * 0.04, vy: Math.sin(a) * s + shot.vy * 0.04,
        life: 0, max: 26 + Math.random() * 18, size: size * (0.12 + Math.random() * 0.1) });
    }
  }

  private draw(frames: number): void {
    const g = this.glow;
    g.begin();
    this.smokeG.begin();
    if (this.crackling) { this.crackle.clear(); this.crackling = false; }

    // (Deleting the current entry while iterating a Map is safe)
    for (const shot of this.shots.values()) {
      if (shot.fading !== null) {
        shot.fading += frames;
        if (shot.fading >= FADE_FRAMES) { this.shots.delete(shot.id); continue; }
      }
      if (!shot.head || !shot.tail) continue;
      const fade = shot.fading === null ? 1 : 1 - shot.fading / FADE_FRAMES;
      const st = shot.style;
      // A dying tracer shrinks towards its head
      const k = shot.fading === null ? 0 : shot.fading / FADE_FRAMES;
      const tx = shot.tail.x + (shot.head.x - shot.tail.x) * k;
      const ty = shot.tail.y + (shot.head.y - shot.tail.y) * k;

      const z = shot.size;
      if (st.glowWidth > 0) this.line(tx, ty, shot.head.x, shot.head.y, st.glowWidth * z, shot.glow, st.glowAlpha * fade);
      if (st.coreWidth > 0) this.line(tx, ty, shot.head.x, shot.head.y, st.coreWidth * z, st.coreColor, 0.9 * fade);
      if (st.haloRadius > 0) {
        this.circle(g, TEX.disc, shot.head.x, shot.head.y, st.haloRadius * z, shot.glow, 0.14 * fade);
        this.circle(g, TEX.disc, shot.head.x, shot.head.y, st.haloRadius * z * 0.55, shot.glow, 0.22 * fade);
      }
      if (st.headRadius > 0) this.circle(g, TEX.disc, shot.head.x, shot.head.y, st.headRadius * z, 0xffffff, fade);
      // EMP orbs crackle
      if (st.orb && shot.fading === null) {
        const c = this.crackle;
        this.crackling = true;
        for (let k = 0; k < 3; k++) {
          const a0 = Math.random() * Math.PI * 2;
          let x = shot.head.x, y = shot.head.y;
          c.moveTo(x, y);
          for (let j = 0; j < 4; j++) {
            x += Math.cos(a0 + (Math.random() - 0.5) * 1.6) * 7 * z;
            y += Math.sin(a0 + (Math.random() - 0.5) * 1.6) * 7 * z;
            c.lineTo(x, y);
          }
          c.stroke({ color: 0xbfeaff, width: 1.5, alpha: 0.8 * fade });
        }
      }
      // Missiles leave smoke
      if (st.trail && shot.fading === null && Math.random() < 0.8) {
        this.smoke.push({ x: shot.head.x - shot.vx * 0.5, y: shot.head.y - shot.vy * 0.5, vx: (Math.random() - 0.5) * 0.4, vy: (Math.random() - 0.5) * 0.4,
          life: 0, max: st.trail.life * (0.7 + Math.random() * 0.6), size: st.trail.size * (0.6 + Math.random() * 0.5) });
      }
    }

    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      f.life += frames;
      if (f.life >= f.max) { this.flashes.splice(i, 1); continue; }
      const n = f.life / f.max, fade = 1 - n;
      // Soft bloom, then the flash shape: a long tongue forward and two short petals to the sides
      this.circle(g, TEX.dot, f.x, f.y, f.size * (0.7 + 0.5 * n) * 1.4 * f.girth, f.color, 0.3 * fade);
      const petal = (dir: number, len: number, wid: number, color: number, alpha: number) => {
        const k = petalScale(f.size * len * (0.7 + 0.5 * n), f.size * wid * fade * f.girth);
        g.take(TEX.petal, f.x, f.y, 0, 0.5, color, alpha, f.angle + dir, k.x, k.y);
      };
      petal(0, f.petals[0], 0.32, f.color, 0.75 * fade);
      petal(0, f.petals[0] * 0.6, 0.16, 0xffffff, 0.9 * fade);
      petal(Math.PI / 2.4, f.petals[1], 0.18, f.color, 0.55 * fade);
      petal(-Math.PI / 2.4, f.petals[2], 0.18, f.color, 0.55 * fade);
      this.circle(g, TEX.disc, f.x, f.y, f.size * 0.3 * fade * f.girth + 0.5, 0xffffff, 0.95 * fade);
      for (const sp of f.sparks) {
        const a = f.angle + sp.a;
        const l = sp.l * (0.5 + n);
        this.line(f.x + Math.cos(a) * l * 0.4, f.y + Math.sin(a) * l * 0.4, f.x + Math.cos(a) * l, f.y + Math.sin(a) * l, 1.4, f.color, 0.8 * fade);
      }
    }

    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const p = this.sparks[i];
      p.life += frames;
      if (p.life >= p.max) { this.sparks.splice(i, 1); continue; }
      const drag = Math.pow(0.9, frames);
      p.vx *= drag; p.vy *= drag;
      p.x += p.vx * frames; p.y += p.vy * frames;
      const fade = 1 - p.life / p.max;
      this.line(p.x - p.vx * 2.5, p.y - p.vy * 2.5, p.x, p.y, 1.5, p.color, fade);
    }

    // Gun smoke and impact vapour (normal blending, so it reads as smoke, not light)
    for (let i = this.smoke.length - 1; i >= 0; i--) {
      const s = this.smoke[i];
      s.life += frames;
      if (s.life >= s.max) { this.smoke.splice(i, 1); continue; }
      const drag = Math.pow(0.95, frames);
      s.vx *= drag; s.vy *= drag;
      s.x += s.vx * frames; s.y += s.vy * frames;
      const k = s.life / s.max;
      this.circle(this.smokeG, TEX.dot, s.x, s.y, s.size * (1 + 1.8 * k) * 1.3, 0xb4aea6, 0.16 * (1 - k) * Math.min(1, k * 8));
    }

    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.life += frames;
      if (r.life >= r.max) { this.rings.splice(i, 1); continue; }
      const n = r.life / r.max;
      this.circle(g, TEX.disc, r.x, r.y, r.size * (0.3 + 0.7 * n), r.color, 0.35 * (1 - n));
      this.circle(g, TEX.disc, r.x, r.y, r.size * 0.25 * (1 - n) + 0.5, 0xffffff, 0.8 * (1 - n));
    }
    g.end();
    this.smokeG.end();
  }
}
