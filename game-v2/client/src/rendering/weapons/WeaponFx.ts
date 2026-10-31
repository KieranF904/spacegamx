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
import { disc, softDot, streak, streakScale, petal, petalScale, ring, puff, DOT_SIZE } from '../fxTextures';
import { ParticlePool } from '../particlePool';
import { EntityType, WeaponType } from '@space-game/common';
import type { GameState, InterpolatedEntity } from '../../state/GameState';
import { WeaponStyle, weaponStyle, shotScale } from './weaponStyles';
import type { Lighting } from '../lighting/Lighting';
import { arcFraction, incomingTicks, landingPoint, sonarPeriod } from './ordnanceTells';

interface Shot {
  id: number;
  style: WeaponStyle;
  /** Shell size relative to the base shot (fixed cannons fire bigger shells) */
  size: number;
  /** x its flash, recoil and impact, from its damage (weaponStyles.shotScale) */
  power: number;
  /** Its own phase for sway and pulsing (so two shots do not beat together) */
  phase: number;
  /** x its brightness: a stream's dim rounds (style.accent) */
  dim: number;
  /** The firing gun's spin as it left the barrel (0..1): turns its colours from cold to hot (style.heat) */
  hot: number;
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
  /** The tick its flight ends (a mortar's landing: projectile row data[9]), 0 for none */
  endTick: number;
  /** Where it lands, when it has an end */
  landX: number;
  landY: number;
  /** Its blast radius (world units), when its gun is known: the landing ring's */
  splash: number;
  /** 0..1 through its flight to its end (swells a lobbed shell) */
  arc: number;
  /** The timeline tick it was last placed at */
  t: number;
  /** Rings swelled so far (a sonar's, accumulated so a changing period never jumps the phase) */
  pulse: number;
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
interface Smoke { x: number; y: number; vx: number; vy: number; life: number; max: number; size: number; color?: number; alpha?: number }
interface Spark { x: number; y: number; vx: number; vy: number; life: number; max: number; color: number; width?: number }
interface Ring { x: number; y: number; life: number; max: number; size: number; color: number }

const FADE_FRAMES = 9;
/** A shell drawn from its barrel's tip eases onto its true path over this many ticks */
const BARREL_EASE = 8;
/** A predicted shell the server hasn't confirmed by then was never fired: it fades */
const CONFIRM_TICKS = 60;

/** What a shell's gun is: its model's look (MODEL_STYLES), its damage and its blast radius */
export interface ShellLook { model?: string; damage?: number; splash?: number }

export interface FirePoseXY { x: number; y: number; angle: number }

/** A shell your client fired ahead of the server */
export interface PredictedShell {
  /** Your ship's pose on the fire tick */
  pose: FirePoseXY;
  owner: number;
  type: number;
  /** Its gun's grade (Mk I-V): the mark only scales its size and brightness */
  grade?: number;
  /** Its gun's model (PlacedPart.fn): its look (weaponStyles MODEL_STYLES) */
  model?: string;
  /** Damage a shot does: its recoil, flash and impact scale with it */
  damage?: number;
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
/** The extra pool's textures (the glow pool holds its four already) */
const SHIP_TYPES = [EntityType.Player, EntityType.Enemy, EntityType.NPC, EntityType.ShipBody];
const TEX2 = { get ring() { return ring(); }, get puff() { return puff(); } };

/** A colour with its hue turned by `deg` degrees (impact shards of a prism's rainbow) */
export function turnHue(c: number, deg: number): number {
  const r = ((c >> 16) & 255) / 255, g = ((c >> 8) & 255) / 255, b = (c & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  const l = (mx + mn) / 2;
  if (d < 1e-6) return c;
  const sat = d / (1 - Math.abs(2 * l - 1));
  let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = ((h * 60 + deg) % 360 + 360) % 360;
  const ch = (1 - Math.abs(2 * l - 1)) * sat, x = ch * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - ch / 2;
  const [r1, g1, b1] = h < 60 ? [ch, x, 0] : h < 120 ? [x, ch, 0] : h < 180 ? [0, ch, x] : h < 240 ? [0, x, ch] : h < 300 ? [x, 0, ch] : [ch, 0, x];
  return (Math.round((r1 + m) * 255) << 16) | (Math.round((g1 + m) * 255) << 8) | Math.round((b1 + m) * 255);
}

/** Crackle defaults (an EMP orb's) when a style asks for lightning with no numbers of its own */
const ORB_LIGHTNING = { color: 0xbfeaff, forks: 3, length: 7 };

export class WeaponFx {
  /** Light (additive) and smoke (normal blending) */
  /**
   * Normal blending, as these have always been drawn: the pool's 'add' never reached its sprites once the bloom made
   * it a render group (Pixi doesn't pass a render group's blend mode on). Additive would be brighter, a look to choose.
   */
  private glow = new ParticlePool('normal');
  private smokeG = new ParticlePool('normal');
  /** Rings, puffs and cloud (a fifth texture would not fit the glow pool) */
  private extraG = new ParticlePool('normal');
  private clock = 0;
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
  onMuzzle: ((owner: number, x: number, y: number, power: number) => void) | null = null;
  /** Where a shot leaving (x, y) along `angle` comes out of its drawn barrel (the ship renderer knows), if it can tell */
  barrelTip: ((owner: number, x: number, y: number, angle: number) => { x: number; y: number } | null) | null = null;
  /** The firing ship's pose on a shell's fire tick, where it's known (shells built from fire events) */
  firePose: ((id: number) => FirePoseXY | undefined) | null = null;
  /** How far a gun's spin has got (0..1) where a shot left (x, y): the ship renderer knows (minigun tracers heat up with it) */
  spinAt: ((owner: number, x: number, y: number) => number) | null = null;
  /** The model and damage of the gun a fire-event shell came from (read once, as the shell is first seen) */
  shellLook: ((id: number, e: InterpolatedEntity) => ShellLook | undefined) | null = null;
  /** Where your cursor is in the world while you hold fire (a guided shell's guide line), else null; the object may be reused */
  guideTo: (() => { x: number; y: number } | null) | null = null;
  /**
   * Shells heading at the local pilot that warn of it (`incoming` styles), refilled every update: where each is and the
   * ticks to its closest approach. `threatCount` of the slots are live.
   */
  readonly threats: { x: number; y: number; t: number }[] = [{ x: 0, y: 0, t: 0 }, { x: 0, y: 0, t: 0 }, { x: 0, y: 0, t: 0 }, { x: 0, y: 0, t: 0 }];
  threatCount = 0;
  private state: GameState | null = null;

  /** Everything here that glows (for the bloom) */
  get glowLayer(): Container {
    return this.glow.container;
  }

  /** Share of the impact sparks and smoke puffs made (the quality setting's particles) */
  particleKeep = 1;

  constructor(layer: Container) {
    this.crackle.blendMode = 'add';
    this.crackleGroup.addChild(this.crackle);
    layer.addChild(this.smokeG.container, this.glow.container, this.extraG.container, this.crackleGroup);
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
    this.state = state;
    this.threatCount = 0;
    const me = state.entities.get(state.playerId);

    for (const e of state.entities.ofType(EntityType.Projectile)) {
      seen.add(e.id);
      let shot = this.shots.get(e.id);
      if (!shot) {
        // Your own shell, already flying since your client fired it? The server's copy takes it over
        shot = this.claim(e) ?? this.createShot(e);
        this.shots.set(e.id, shot);
      }
      const t = this.timeline(shot, state, presentTick, renderTick);
      shot.t = t;
      // The flash goes off when the shot leaves the gun on its timeline (the ship is drawn at that tick too):
      // not when it arrives, which is usually a little early. Shots first seen well downrange don't flash.
      if (!shot.flashed && t >= shot.spawnTick) {
        shot.flashed = true;
        if (t - shot.spawnTick < 12) {
          if (shot.type === WeaponType.PrismShard) this.splitFlash(shot); else this.muzzleFlash(shot, state.entities.get(shot.owner));
        }
      }
      if (shot.fading === null) {
        this.place(shot, e, t);
        // A shell heading at you that the style warns of (a Leviathan): where it is and how long it has
        const inc = shot.style.incoming;
        if (inc && me && shot.head && shot.owner !== state.playerId && this.threatCount < this.threats.length) {
          const tt = incomingTicks(me.renderX, me.renderY, shot.head.x, shot.head.y, e.vx, e.vy, inc.radius, 600);
          if (tt >= 0) {
            const th = this.threats[this.threatCount++];
            th.x = shot.head.x; th.y = shot.head.y; th.t = tt;
          }
        }
      }
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
      if (!seen.has(shot.id) && shot.fading === null) {
        // A shell that was lobbed to a point and is gone has landed there: its burst (the server's damage messages only come for what it hit)
        if (shot.style.landBurst && shot.endTick > 0 && !shot.hit && shot.t >= shot.endTick - 20) this.landed(shot, state);
        else shot.fading = 0;
      }
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

  /** A lobbed shell reached its end: burst there, and shake a screen near enough (a Quake's) */
  private landed(shot: Shot, state: GameState): void {
    const lb = shot.style.landBurst!;
    this.onHit(shot.id, shot.landX, shot.landY);
    const me = state.entities.get(state.playerId);
    if (lb.shake && me) {
      const d = Math.hypot(me.renderX - shot.landX, me.renderY - shot.landY);
      if (d < lb.shake) state.triggerScreenShake(7 * (1 - d / lb.shake), 0.3);
    }
  }

  /** A damage message with a hit point: stop that tracer there and throw sparks. */
  onHit(projectileId: number | undefined, x: number, y: number): void {
    const shot = projectileId !== undefined ? this.shots.get(projectileId) : undefined;
    const style = shot?.style ?? weaponStyle(WeaponType.Cannon);
    // (The impact scales with the shot's damage as well as its shell's size)
    const size = (shot?.size ?? 1) * (shot?.power ?? 1);
    let normal = Math.random() * Math.PI * 2;
    if (shot) {
      shot.hit = { x, y };
      shot.head = { x, y };
      if (shot.fading === null) shot.fading = 0;
      normal = Math.atan2(-shot.vy, -shot.vx);
    }
    const imp = style.impact;
    for (let i = 0; i < imp.sparks * size * this.particleKeep; i++) {
      const a = normal + (Math.random() - 0.5) * 2.2;
      const s = imp.speed * (0.4 + Math.random());
      const col = Math.random() < 0.25 ? 0xffffff : style.shardHue ? turnHue(imp.color, (Math.random() - 0.5) * style.shardHue) : imp.color;
      this.sparks.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0, max: imp.life * (0.6 + Math.random() * 0.6), color: col });
    }
    // A cloud left where it landed (gas, dust, vapour)
    const cloud = style.smokeCloud;
    if (cloud) {
      for (let i = 0; i < 5; i++) {
        if (this.particleKeep < 1 && Math.random() > this.particleKeep) continue;
        const a = Math.random() * Math.PI * 2, v = 0.3 + Math.random() * 0.8;
        this.smoke.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0, max: cloud.life * (0.7 + Math.random() * 0.6), size: cloud.size * size * (0.6 + Math.random() * 0.6), color: cloud.color, alpha: 0.3 });
      }
    }
    this.rings.push({ x, y, life: 0, max: 10, size: imp.flash * size, color: imp.color });
    // The heavier marks ring out wider and slower
    if (imp.ring !== undefined) this.rings.push({ x, y, life: 0, max: 16, size: imp.flash * size * 1.8, color: imp.ring });
    // A puff of vapourised hull
    for (let i = 0; i < 2; i++) {
      if (this.particleKeep < 1 && Math.random() > this.particleKeep) continue;
      const a = normal + (Math.random() - 0.5) * 1.2;
      this.smoke.push({ x, y, vx: Math.cos(a) * 0.8, vy: Math.sin(a) * 0.8, life: 0, max: 40 + Math.random() * 20, size: 6 * size });
    }
  }

  // -------------------------------------------------------------------------

  private createShot(e: InterpolatedEntity): Shot {
    const type = e.data?.[0] ?? WeaponType.Cannon;
    // data[1]: the gun's grade
    const look = this.shellLook?.(e.id, e);
    const style = weaponStyle(type, e.data?.[1] ?? 1, look?.model);
    const hue = e.data?.[2] ?? 30;
    const shot: Shot = {
      id: e.id,
      style,
      size: e.data?.[7] || 1,
      power: shotScale(look?.damage),
      phase: (e.id * 0.618) % 1, dim: this.dimOf(style, e.id), hot: 0,
      type,
      owner: e.data?.[6] ?? -1,
      glow: type === WeaponType.PrismShard ? hueColor((e.id * 67) % 360) : mixColor(style.glowColor, hueColor(hue), style.ownerTint),
      spawnX: e.spawnX ?? e.x,
      spawnY: e.spawnY ?? e.y,
      spawnTick: e.spawnTick ?? 0,
      vx: e.vx,
      vy: e.vy,
      hit: null,
      flashed: false,
      predicted: false,
      pose: this.firePose?.(e.id),
      endTick: e.data?.[9] ?? 0, landX: 0, landY: 0, splash: look?.splash ?? 0, arc: 0, t: 0, pulse: 0,
      fading: null,
      head: null,
      tail: null,
    };
    if (shot.endTick > 0) {
      const o = { x: 0, y: 0 };
      landingPoint(shot.spawnX, shot.spawnY, shot.vx, shot.vy, shot.spawnTick, shot.endTick, o);
      shot.landX = o.x; shot.landY = o.y;
    }
    return shot;
  }

  private nextPredicted = -1;

  /** A stream's accent: every nth round bright, the rest dim */
  private dimOf(style: WeaponStyle, n: number): number {
    return style.accent && n % style.accent.every !== 0 ? style.accent.dim : 1;
  }

  /**
   * A puff off a gun that is not shooting: smoke venting from a housing, or sparks (a spent clip's eject, a rail's
   * vent). From the ship renderer, on reload.
   */
  vent(x: number, y: number, angle: number, kind: 'smoke' | 'spark', color: number): void {
    if (this.particleKeep < 1 && Math.random() > this.particleKeep) return;
    if (kind === 'smoke') {
      const a = angle + (Math.random() - 0.5) * 1.4;
      this.smoke.push({ x, y, vx: Math.cos(a) * 0.7, vy: Math.sin(a) * 0.7, life: 0, max: 40 + Math.random() * 20, size: 5 + Math.random() * 3, color, alpha: 0.2 });
      return;
    }
    for (let i = 0; i < 2; i++) {
      const a = angle + (Math.random() - 0.5) * 1.6, v = 1.5 + Math.random() * 2;
      this.sparks.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0, max: 14 + Math.random() * 10, color });
    }
  }

  /** A shell your client just fired (guns.ts): it flies from your barrel now, the server's copy takes it over when it comes */
  predict(p: PredictedShell): void {
    const style = weaponStyle(p.type, p.grade, p.model);
    const id = this.nextPredicted--;
    this.shots.set(id, {
      id, style, size: p.size, power: shotScale(p.damage), phase: (-id * 0.618) % 1, dim: this.dimOf(style, -id), hot: 0, type: p.type, owner: p.owner,
      glow: mixColor(style.glowColor, hueColor((p.owner * 137) % 360), style.ownerTint),
      spawnX: p.spawnX, spawnY: p.spawnY, spawnTick: p.spawnTick, vx: p.vx, vy: p.vy,
      hit: null, flashed: false, predicted: true, pose: p.pose, endTick: 0, landX: 0, landY: 0, splash: 0, arc: 0, t: 0, pulse: 0, fading: null, head: null, tail: null,
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
    shot.arc = arcFraction(t, shot.spawnTick, shot.endTick);
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

  /** Where a prism splits: each shard throws a ring and a few sparks in its own hue, so the five make a rainbow pop */
  private splitFlash(shot: Shot): void {
    const angle = Math.atan2(shot.vy, shot.vx);
    this.rings.push({ x: shot.spawnX, y: shot.spawnY, life: 0, max: 14, size: 38, color: shot.glow });
    this.rings.push({ x: shot.spawnX, y: shot.spawnY, life: 0, max: 9, size: 16, color: 0xffffff });
    for (let i = 0; i < 4; i++) {
      const a = angle + (Math.random() - 0.5) * 0.5, v = 3 + Math.random() * 3;
      this.sparks.push({ x: shot.spawnX, y: shot.spawnY, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0, max: 14 + Math.random() * 8, color: shot.glow });
    }
  }

  /** A directional flash out of the barrel (a long forward tongue and two side petals), sparks and a smoke puff */
  private muzzleFlash(shot: Shot, owner?: { renderX: number; renderY: number; renderAngle: number }): void {
    const m = shot.style.muzzle;
    const angle = Math.atan2(shot.vy, shot.vx);
    this.onMuzzle?.(shot.owner, shot.spawnX, shot.spawnY, shot.power);
    // At the drawn barrel's tip (shells spawn on the facing edge, the barrel pokes out past it), and the shell drawn from there too
    const tip = this.barrelTip?.(shot.owner, shot.spawnX, shot.spawnY, angle);
    if (tip) { shot.vox = tip.x - shot.spawnX; shot.voy = tip.y - shot.spawnY; }
    const x = tip?.x ?? shot.spawnX, y = tip?.y ?? shot.spawnY;
    const size = m.size * shot.size * shot.power;
    if (shot.style.heat) shot.hot = Math.max(0, Math.min(1, this.spinAt?.(shot.owner, shot.spawnX, shot.spawnY) ?? 0));
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
    // Spent casings flung out to the side, tumbling away
    // (a minigun throws more brass the faster it spins)
    const brass = Math.round((shot.style.casings ?? 0) * (shot.style.heat ? 0.3 + 0.9 * shot.hot : 1));
    for (let i = 0; i < brass; i++) {
      const side = angle + (Math.random() < 0.5 ? 1 : -1) * (1.2 + Math.random() * 0.5), v = 1.4 + Math.random() * 1.8;
      this.sparks.push({ x, y, vx: Math.cos(side) * v, vy: Math.sin(side) * v, life: 0, max: 26 + Math.random() * 14, color: 0xe0b860, width: 2.4 });
    }
    // Shock rings off the muzzle (a rail's coil rings come one after another, each wider)
    const mr = m.ring;
    if (mr) {
      const n = mr.count ?? 1;
      for (let i = 0; i < n; i++) {
        const ahead = i * size * 0.25;
        this.rings.push({ x: x + Math.cos(angle) * ahead, y: y + Math.sin(angle) * ahead, life: 0, max: 9 + i * 3, size: size * (mr.size ?? 1) * (0.5 + 0.3 * i), color: mr.color });
      }
    }
    // Smoke puffs out ahead of the barrel, carried a little by the shot, and left behind as the ship flies on
    for (let i = 0; i < m.smoke; i++) {
      if (this.particleKeep < 1 && Math.random() > this.particleKeep) continue;
      const a = angle + (Math.random() - 0.5) * 0.8, s = 0.8 + Math.random() * 1.6;
      const ahead = size * (0.4 + Math.random() * 0.5);
      this.smoke.push({ x: x + Math.cos(angle) * ahead, y: y + Math.sin(angle) * ahead, vx: Math.cos(a) * s + shot.vx * 0.04, vy: Math.sin(a) * s + shot.vy * 0.04,
        life: 0, max: 26 + Math.random() * 18, size: size * (0.12 + Math.random() * 0.1) });
    }
  }

  /** A ring of `r` radius (the ring texture's) */
  private ringAt(x: number, y: number, r: number, color: number, alpha: number): void {
    const k = (r * 2 * 32) / (28 * DOT_SIZE);
    this.extraG.take(TEX2.ring, x, y, 0.5, 0.5, color, alpha, 0, k, k);
  }

  /**
   * Where every lobbed shell will land, for everyone (its endTick, worked out where it comes down): the blast's ring and a
   * second ring tightening onto it as the shell falls. Yours in the shell's own colour, others' in a warning red.
   */
  private drawLandings(): void {
    for (const shot of this.shots.values()) {
      if (shot.fading !== null || !shot.endTick || !shot.style.landBurst || !shot.head) continue;
      const f = shot.arc, r = shot.splash || 200;
      const own = shot.owner === this.state?.playerId;
      const col = own ? shot.style.impact.color : 0xff6a4a;
      this.ringAt(shot.landX, shot.landY, r, col, 0.16 + 0.34 * f);
      this.ringAt(shot.landX, shot.landY, r * (1 + 1.3 * (1 - f)), col, 0.25 + 0.45 * f);
      this.circle(this.extraG, TEX.dot, shot.landX, shot.landY, 10 + 20 * f, col, 0.2 + 0.4 * f);
    }
  }

  /** The distance to the nearest ship that is not the shell's owner (a sonar's quickening) */
  private nearestShip(shot: Shot): number {
    const st = this.state;
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

  /** A dashed line from (x, y) toward your cursor, while you hold fire */
  private guideLine(x: number, y: number): void {
    const to = this.guideTo?.();
    if (!to) return;
    const dx = to.x - x, dy = to.y - y, full = Math.hypot(dx, dy), len = Math.min(full, 1400);
    if (len < 40) return;
    const ux = dx / full, uy = dy / full;
    for (let d = 30; d < len; d += 38) {
      const e = Math.min(len, d + 20);
      this.line(x + ux * d, y + uy * d, x + ux * e, y + uy * e, 1.5, 0xcfe6ff, 0.34 * (1 - d / 1700));
    }
    if (full <= 1400) this.ringAt(to.x, to.y, 14, 0xcfe6ff, 0.4);
  }

  private draw(frames: number): void {
    const g = this.glow;
    g.begin();
    this.smokeG.begin();
    this.extraG.begin();
    this.clock += frames;
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
      if (st.blink) alpha *= ((this.clock / st.blink + shot.phase * 2) % 1) < 0.5 ? 1 : 0.2;
      if (st.wobble) {
        // The head sways across its line, the tail trailing the sway
        const w = st.wobble, sw = Math.sin(((this.clock + shot.phase * w.period) / w.period) * Math.PI * 2) * w.amp * z;
        hx += nx * sw; hy += ny * sw;
        bx += nx * sw * 0.4; by += ny * sw * 0.4;
      }
      const lanes = st.pair ? 2 : 1;
      for (let lane = 0; lane < lanes; lane++) {
        // A pair runs as two thinner tracers either side of the line
        const off = lanes === 2 ? (lane === 0 ? -0.5 : 0.5) * st.pair!.gap * z : 0, wk = lanes === 2 ? 0.7 : 1;
        const ox = nx * off, oy = ny * off;
        if (st.glowWidth > 0) this.line(bx + ox, by + oy, hx + ox, hy + oy, st.glowWidth * z * wk, glowCol, st.glowAlpha * alpha);
        if (st.coreWidth > 0) this.line(bx + ox, by + oy, hx + ox, hy + oy, st.coreWidth * z * wk, coreCol, 0.9 * alpha);
        if (st.haloRadius > 0) {
          this.circle(g, TEX.disc, hx + ox, hy + oy, st.haloRadius * z * wk, shot.glow, 0.14 * alpha);
          this.circle(g, TEX.disc, hx + ox, hy + oy, st.haloRadius * z * wk * 0.55, shot.glow, 0.22 * alpha);
        }
        if (st.headRadius > 0) this.circle(g, TEX.disc, hx + ox, hy + oy, st.headRadius * z * wk, 0xffffff, alpha);
      }
      const speed = Math.hypot(shot.vx, shot.vy);
      // A glowing wake: dots left along the path behind it, each fainter (positions follow from the line, nothing is kept)
      const ct = st.contrail;
      if (ct && shot.fading === null) {
        const step = ct.step ?? ct.size * 1.6, reach = Math.min(speed * ct.life * 0.5, 260), n = Math.min(14, Math.max(2, Math.ceil(reach / step)));
        for (let i = 1; i <= n; i++) {
          const f = i / n;
          this.circle(g, TEX.dot, hx - ux * reach * f, hy - uy * reach * f, ct.size * z * (1 - 0.6 * f), ct.color, 0.5 * (1 - f) * alpha);
        }
      }
      // Ghost copies of the head, each further back and fainter
      if (st.afterimages && shot.fading === null) {
        const gap = Math.max(3, speed * 0.9);
        for (let i = 1; i <= st.afterimages; i++) {
          const f = i / (st.afterimages + 1);
          this.circle(g, TEX.disc, hx - ux * gap * i, hy - uy * gap * i, Math.max(1, st.headRadius * z) * (1 - 0.5 * f), shot.glow, 0.5 * (1 - f) * alpha * (0.55 + 0.45 * Math.sin(this.clock * 0.9 + i * 2.1 + shot.phase * 11)));
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
        this.extraG.take(TEX2.ring, hx, hy, 0.5, 0.5, rp.color, 0.7 * (1 - q) * alpha, 0, k2, k2);
      }
      // A light at the nose: a hard blink, or a slow pulse
      const ns = st.nose;
      if (ns && shot.fading === null) {
        const ph = ((this.clock + shot.phase * ns.period) % ns.period) / ns.period;
        const on = ns.blink ? (ph < 0.22 ? 1 : 0) : 0.5 + 0.5 * Math.sin(ph * Math.PI * 2);
        if (on > 0.02) {
          this.circle(g, TEX.dot, hx, hy, ns.size * z * (0.8 + 0.5 * on), ns.color, 0.6 * on * alpha);
          this.circle(g, TEX.disc, hx, hy, ns.size * z * 0.28, mixColor(ns.color, 0xffffff, 0.5), on * alpha);
        }
      }
      // Your own guided shell: a dashed guide to your cursor while you hold fire (it flies where you point)
      if (st.guide && shot.fading === null && shot.owner === this.state?.playerId) this.guideLine(hx, hy);
      // A thin cloud as it flies: soft puffs along its path
      const sc = st.smokeCloud;
      if (sc?.fly && shot.fading === null) {
        const reach = Math.min(speed * 6, 180);
        for (let i = 0; i < 5; i++) {
          const f = (i + 1) / 5, r = sc.size * z * (0.7 + 0.8 * f), kk = (r * 2) / DOT_SIZE;
          this.extraG.take(TEX2.puff, hx - ux * reach * f, hy - uy * reach * f, 0.5, 0.5, sc.color, 0.22 * (1 - f) * alpha, 0, kk, kk);
        }
      }
      // A blast radius you can see coming: a faint ring round the head, the whole flight
      const rr = st.radiusRing;
      if (rr && shot.fading === null) {
        const k2 = (rr.radius * 2 * 32) / (28 * DOT_SIZE);
        this.extraG.take(TEX2.ring, hx, hy, 0.5, 0.5, rr.color, 0.22 * alpha, 0, k2, k2);
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
          const f = (this.clock * 0.011 + i / N + shot.phase) % 1, a = i * 2.399 + shot.phase * 6.283 + f * 1.1;
          const r1 = pl.radius * (1 - f * f), r0 = Math.min(pl.radius, r1 + 24 + 90 * f), ca = Math.cos(a), sa = Math.sin(a);
          c.moveTo(hx + ca * r0, hy + sa * r0).lineTo(hx + ca * r1, hy + sa * r1).stroke({ color: pl.color, width: 2, alpha: 0.55 * Math.sin(f * Math.PI) * alpha });
        }
      }
      // Missiles leave smoke
      if (st.trail && shot.fading === null && Math.random() < 0.8) {
        this.smoke.push({ x: (st.wobble ? hx : shot.head.x) - shot.vx * 0.5, y: (st.wobble ? hy : shot.head.y) - shot.vy * 0.5, vx: (Math.random() - 0.5) * 0.4, vy: (Math.random() - 0.5) * 0.4,
          life: 0, max: st.trail.life * (0.7 + Math.random() * 0.6), size: st.trail.size * (0.6 + Math.random() * 0.5) });
      }
    }

    this.drawLandings();

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
      this.line(p.x - p.vx * 2.5, p.y - p.vy * 2.5, p.x, p.y, p.width ?? 1.5, p.color, fade);
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
      this.circle(this.smokeG, TEX.dot, s.x, s.y, s.size * (1 + 1.8 * k) * 1.3, s.color ?? 0xb4aea6, (s.alpha ?? 0.16) * (1 - k) * Math.min(1, k * 8));
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
    this.extraG.end();
  }
}
