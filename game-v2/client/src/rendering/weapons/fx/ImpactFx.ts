/**
 * @contract client.weaponFx.impact
 * owns:       what a hit throws at (x, y): the throw direction, the group riding what was struck, the flat or layered
 *             (ImpactLayers) particles, a held beam's burn, and the hit's sound and screen shake
 * needs:      FxField (particle lists), ImpactHost (surfaceAt, sounds, state), weaponStyles, impactAim, impactAnchor, liquidSplash
 * invariants: a hit's throw follows the style's hitThrow, off the struck surface where one is known — client/src/rendering/weapons/impactAim.test.ts
 *             an impact's parts ride what it hit as one group — client/src/rendering/weapons/impactAnchor.test.ts
 *             layered particle lists stop growing at their caps — none pinned
 * extend:     a new layered impact part is one block in layeredHit (and its list in FxField / draw in hitDraw)
 */

import { WeaponType } from '@space-game/common';
import type { CombatSoundFeed } from '../../../audio/CombatSounds';
import type { GameState } from '../../../state/GameState';
import { weaponStyle, type WeaponStyle, type ImpactLayers } from '../weaponStyles';
import { BURST, burstLife, burstSpeed, offSurface, throwAngle, type SurfaceNormal } from '../impactAim';
import type { ImpactAnchor } from '../impactAnchor';
import type { FxField } from './FxField';
import { FRAG_CAP, HIT_CAP, impactScale, turnHue } from './particleTypes';
import type { Shot } from './shotTypes';

/** Which way a hit throws (impactAim): the angle its directional parts leave at, and the struck surface's normal if one was found */
/** `dx, dy`: the shot's (or beam's) direction, 0 0 when unknown (a liquid splash creeps the way it slid along the surface) */
export interface Aim { a: number; nx: number; ny: number; surface: boolean; dx: number; dy: number }

/** What an impact asks of WeaponFx's hooks (read live: the owner sets them after construction) */
export interface ImpactHost {
  readonly surfaceAt: ((x: number, y: number, dx: number, dy: number, owner: number, out: SurfaceNormal) => SurfaceNormal | null) | null;
  readonly sounds: CombatSoundFeed | null;
  readonly state: GameState | null;
}

export class ImpactFx {
  private readonly normalScratch: SurfaceNormal = { nx: 0, ny: 0 };
  private readonly aim: Aim = { a: 0, nx: 0, ny: 0, surface: false, dx: 0, dy: 0 };
  /** What the impact being made hit (an entity id, -1: nothing known): its group rides it */
  private hitTarget = -1;
  /** Impact styles of held beams' burns (BeamLook.burn), built once each */
  private burnStyles = new WeakMap<object, WeaponStyle>();

  constructor(private readonly f: FxField, private readonly host: ImpactHost) {}

  beamBurn(x: number, y: number, dx: number, dy: number, owner: number, burn: { color: number; hit: ImpactLayers }): void {
    let style = this.burnStyles.get(burn);
    if (!style) {
      style = { ...weaponStyle(WeaponType.Cannon), hitThrow: 'normal', impact: { sparks: 0, speed: 0, life: 0, color: burn.color, flash: 0 }, hit: burn.hit };
      this.burnStyles.set(burn, style);
    }
    const aim = this.aim;
    aim.nx = -dx; aim.ny = -dy; aim.surface = false; aim.dx = dx; aim.dy = dy;
    this.normalScratch.target = -1;
    const n = this.host.surfaceAt?.(x, y, dx, dy, owner, this.normalScratch);
    if (n) { aim.nx = n.nx; aim.ny = n.ny; aim.surface = true; }
    aim.a = throwAngle('normal', dx, dy, aim.nx, aim.ny);
    const st = style;
    this.grouped(this.normalScratch.target ?? -1, x, y, () => this.layeredHit(st, burn.hit, x, y, aim, 1, undefined));
  }



  /**
   * Which way a hit throws (the style's hitThrow, impactAim.ts): off the surface the shell struck where it's known (asked
   * of surfaceAt only when the style throws off one), else back up its line; a hit with no shell anywhere
   */
  private aimOf(style: WeaponStyle, shot: Shot | undefined, x: number, y: number): Aim {
    const aim = this.aim;
    aim.surface = false; aim.dx = 0; aim.dy = 0;
    this.normalScratch.target = -1;
    const sp = shot ? Math.hypot(shot.vx, shot.vy) : 0;
    if (!shot || sp < 1e-6) {
      aim.a = Math.random() * Math.PI * 2; aim.nx = Math.cos(aim.a); aim.ny = Math.sin(aim.a);
      // (what it hit, to ride: asked along any line through the point)
      this.host.surfaceAt?.(x, y, -aim.nx, -aim.ny, shot?.owner ?? -1, this.normalScratch);
      this.hitTarget = this.normalScratch.target ?? -1;
      return aim;
    }
    const dx = shot.vx / sp, dy = shot.vy / sp, mode = style.hitThrow ?? 'back';
    aim.nx = -dx; aim.ny = -dy; aim.dx = dx; aim.dy = dy;
    // (asked for every hit: what it struck, for its group to ride; its normal only where the style throws off it)
    const n = this.host.surfaceAt?.(x, y, dx, dy, shot.owner, this.normalScratch);
    this.hitTarget = this.normalScratch.target ?? -1;
    if (n && mode !== 'back') { aim.nx = n.nx; aim.ny = n.ny; aim.surface = true; }
    aim.a = throwAngle(mode, dx, dy, aim.nx, aim.ny);
    return aim;
  }

  /** A direction `spread` radians off the throw, kept out of the struck surface */
  private dir(aim: Aim, spread: number): number {
    const a = aim.a + spread;
    return aim.surface ? offSurface(a, aim.nx, aim.ny) : a;
  }

  /** An impact at (x, y): its shell's style (a plain cannon's if none), thrown the way the style says, riding what it hit */
  at(shot: Shot | undefined, x: number, y: number): void {
    const style = shot?.style ?? weaponStyle(WeaponType.Cannon);
    const aim = this.aimOf(style, shot, x, y);
    this.grouped(this.hitTarget, x, y, () => this.parts(style, shot, x, y, aim));
    this.host.sounds?.impact({ shell: shot?.id ?? -1, owner: shot?.owner ?? -1, x, y });
  }

  /**
   * Makes `spawn`'s impact one group riding `target` (an entity id; -1 or gone: it stays where it is): what it adds to the
   * surface-bound lists (glows, fireballs, shock rings, scorches, lights, streaks, rings) is moved with the target each
   * frame; what it adds to the free ones (sparks, sprays, embers, fragments, smoke) flies in the target's frame
   */
  private grouped(target: number, x: number, y: number, spawn: () => void): void {
    const n0 = this.f.hitGlows.length, n1 = this.f.shocks.length, n2 = this.f.scorches.length, n3 = this.f.hitLights.length, n4 = this.f.flares.length, n5 = this.f.rings.length;
    const n6 = this.f.sparks.length, n7 = this.f.smoke.length, f0 = this.f.fragsMade, l0 = this.f.liquid.n;
    spawn();
    const anc = this.f.anchors.open(this.host.state?.entities, target, x, y);
    if (!anc) return;
    this.f.liquid.bind(l0, anc);
    const bind = (arr: { anc?: ImpactAnchor; life: number; max: number }[], from: number): void => {
      for (let i = from; i < arr.length; i++) { arr[i].anc = anc; anc.hold(arr[i].max - arr[i].life + 2); }
    };
    bind(this.f.hitGlows, n0); bind(this.f.shocks, n1); bind(this.f.scorches, n2); bind(this.f.hitLights, n3); bind(this.f.flares, n4); bind(this.f.rings, n5);
    bind(this.f.sparks, n6); bind(this.f.smoke, n7); bind(this.f.frags, Math.max(0, this.f.frags.length - (this.f.fragsMade - f0)));
  }

  /** An impact's parts at (x, y): layered (ImpactLayers) or the flat flash and rings */
  private parts(style: WeaponStyle, shot: Shot | undefined, x: number, y: number, aim: Aim): void {
    // (The impact scales with the shot's damage as well as its shell's size)
    const size = (shot?.size ?? 1) * (shot?.power ?? 1);
    const normal = aim.a;
    const imp = style.impact;
    if (style.hit) { this.layeredHit(style, style.hit, x, y, aim, size, shot); return; }
    for (let i = 0; i < imp.sparks * size * this.f.particleKeep; i++) {
      const a = this.dir(aim, (Math.random() - 0.5) * 2.2);
      const s = imp.speed * (0.4 + Math.random());
      const col = Math.random() < 0.25 ? 0xffffff : style.shardHue ? turnHue(imp.color, (Math.random() - 0.5) * style.shardHue) : imp.color;
      this.f.sparks.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0, max: imp.life * (0.6 + Math.random() * 0.6), color: col });
    }
    // A cloud left where it landed (gas, dust, vapour)
    const cloud = style.smokeCloud;
    if (cloud) {
      for (let i = 0; i < 5; i++) {
        if (this.f.particleKeep < 1 && Math.random() > this.f.particleKeep) continue;
        const a = Math.random() * Math.PI * 2, v = 0.3 + Math.random() * 0.8;
        this.f.smoke.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0, max: cloud.life * (0.7 + Math.random() * 0.6), size: cloud.size * size * (0.6 + Math.random() * 0.6), color: cloud.color, alpha: 0.3 });
      }
    }
    this.f.rings.push({ x, y, life: 0, max: 10, size: imp.flash * size, color: imp.color });
    // The heavier marks ring out wider and slower
    if (imp.ring !== undefined) this.f.rings.push({ x, y, life: 0, max: 16, size: imp.flash * size * 1.8, color: imp.ring });
    // A puff of vapourised hull
    for (let i = 0; i < 2; i++) {
      if (this.f.particleKeep < 1 && Math.random() > this.f.particleKeep) continue;
      const a = (aim.surface ? Math.atan2(aim.ny, aim.nx) : normal) + (Math.random() - 0.5) * 1.2;
      this.f.smoke.push({ x, y, vx: Math.cos(a) * 0.8, vy: Math.sin(a) * 0.8, life: 0, max: 40 + Math.random() * 20, size: 6 * size });
    }
  }

  /**
   * A layered impact (ImpactLayers): a white-hot core, a glow round it, shock rings, a spray of streaks and the shell's
   * own ricochet thrown off the hit (`aim`: off the struck surface or back up the line, by the style's hitThrow), embers
   * that cool as they drift off the surface, a glow left on the hull, the impact's own light and maybe a shake. Sized by
   * impactScale, not the flat flash's full scale.
   */
  private layeredHit(style: WeaponStyle, L: ImpactLayers, x: number, y: number, aim: Aim, size: number, shot: Shot | undefined): void {
    const imp = style.impact, k = impactScale(size), nk = Math.min(1.5, k) * this.f.particleKeep;
    const room = (): boolean => this.f.sparks.length < HIT_CAP * 2;
    // A loose scatter round the throw (tight for a directional hit, wide for a burst)
    const scat = ((L.scatter ?? (style.hitThrow && style.hitThrow !== 'back' ? 40 : 69)) * Math.PI) / 180;
    for (let i = 0, n = Math.round(imp.sparks * nk); i < n && room(); i++) {
      const a = this.dir(aim, (Math.random() * 2 - 1) * scat), s = imp.speed * (0.4 + Math.random());
      const col = Math.random() < 0.25 ? 0xffffff : style.shardHue ? turnHue(imp.color, (Math.random() - 0.5) * style.shardHue) : imp.color;
      this.f.sparks.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0, max: imp.life * (0.6 + Math.random() * 0.6), color: col });
    }
    if (this.f.hitGlows.length < HIT_CAP) {
      if (L.core) this.f.hitGlows.push({ x, y, life: 0, max: L.core.life, size: L.core.size * k, color: 0xffffff, core: true });
      if (L.bloom) this.f.hitGlows.push({ x, y, life: 0, max: L.bloom.life, size: L.bloom.size * k, color: L.bloom.color ?? imp.color, core: false });
    }
    const sh = L.shock;
    if (sh) {
      for (let i = 0; i <= (sh.count ?? 0) && this.f.shocks.length < HIT_CAP; i++) {
        const f = Math.pow(0.7, i);
        this.f.shocks.push({ x, y, life: -i * (sh.gap ?? 4), max: sh.life * (1 - 0.15 * i), size: sh.size * k * f, width: sh.width * k * f, color: sh.color ?? imp.color });
      }
    }
    const sp = L.spray;
    if (sp) {
      const cone = (sp.cone * Math.PI) / 180;
      for (let i = 0, n = Math.round(sp.count * nk); i < n && room(); i++) {
        // (most of it close to the throw, a few wide)
        const u = Math.random() * 2 - 1, a = this.dir(aim, u * Math.abs(u) * cone), s = sp.speed * (0.55 + Math.random() * 0.7);
        this.f.sparks.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0, max: sp.life * (0.6 + Math.random() * 0.6), color: Math.random() < 0.35 ? 0xffffff : sp.color ?? imp.color, width: sp.width ?? 1.7, drag: 0.88 });
      }
    }
    // The rebound line: bright streaks shooting out along the throw
    const fl = L.flare;
    if (fl && this.f.flares.length < 128) {
      const n = fl.count ?? 1, fan = ((fl.fan ?? 0) * Math.PI) / 180, col = fl.color ?? L.spray?.color ?? imp.color;
      for (let i = 0; i < n; i++) {
        const off = n > 1 ? (i / (n - 1) - 0.5) * 2 * fan : 0, a = this.dir(aim, off + (Math.random() - 0.5) * 0.08);
        // (the middle one longest)
        const len = fl.size * k * (n > 1 ? 1 - 0.35 * Math.abs(i / (n - 1) - 0.5) * 2 : 1) * (0.9 + Math.random() * 0.2);
        this.f.flares.push({ x, y, a, len, width: fl.width * Math.min(1.5, k), life: 0, max: fl.life, color: col });
      }
    }
    // A heavy hit's explosion: thrown out between the surface's normal and the throw (straight out for a 'normal' hit)
    const fb = L.fireball, db = L.debris;
    if (fb || db) {
      const out = aim.surface ? Math.atan2(aim.ny + Math.sin(aim.a), aim.nx + Math.cos(aim.a)) : aim.a;
      const oc = Math.cos(out), os = Math.sin(out);
      if (fb && this.f.hitGlows.length < HIT_CAP) {
        const n = fb.count ?? 3;
        for (let i = 0; i < n; i++) {
          const d = fb.size * k * (0.15 + (0.6 * i) / Math.max(1, n - 1)), side = (Math.random() - 0.5) * fb.size * k * 0.5, v = 0.5 + Math.random() * 0.9;
          this.f.hitGlows.push({
            x: x + oc * d - os * side, y: y + os * d + oc * side, life: -i, max: fb.life * (0.8 + Math.random() * 0.4), size: fb.size * k * (1 - 0.25 * i / n) * (0.85 + Math.random() * 0.3),
            color: fb.color ?? 0xffb050, cool: fb.cool ?? 0x5a1a08, core: false, vx: oc * v, vy: os * v,
          });
        }
      }
      if (db) {
        const cone = ((db.cone ?? 50) * Math.PI) / 180;
        for (let i = 0, n = Math.round(db.count * Math.min(1.5, k) * this.f.particleKeep); i < n; i++) {
          if (this.f.frags.length >= FRAG_CAP) this.f.frags.shift();
          // (speed and life drawn apart, each mostly near its typical, a few outliers much faster or longer-lived)
          const u = Math.random() * 2 - 1, a0 = out + u * Math.abs(u) * cone, a = aim.surface ? offSurface(a0, aim.nx, aim.ny) : a0;
          const fs = burstSpeed(db.outliers ?? BURST.outliers, db.outSpeed ?? BURST.outSpeed), fl = burstLife(db.outliers ?? BURST.outliers, db.outLife ?? BURST.outLife);
          const sp = db.speed * fs, big = fs > 1.6 || fl > 1.4;
          this.f.fragsMade++;
          this.f.frags.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0, max: db.life * fl, size: db.size * Math.min(1.5, k) * (0.6 + Math.random() * 0.8),
            hot: db.hot, cool: db.cool, trail: db.trail ?? db.hot, drag: db.drag ?? 0.95, puff: Math.random() * 3, smokes: big ? 0.8 : 0.4 });
        }
      }
    }
    // The shell itself glancing off: long streaks of its own colour, tight round the throw
    const rc = L.ricochet;
    if (rc) {
      const cone = (rc.cone * Math.PI) / 180, col = shot?.glow ?? style.glowColor;
      for (let i = 0, n = Math.max(1, Math.round(rc.count * Math.min(1.5, k))); i < n && room(); i++) {
        const a = this.dir(aim, (Math.random() * 2 - 1) * cone), s = rc.speed * (0.8 + Math.random() * 0.4);
        this.f.sparks.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0, max: rc.life * (0.8 + Math.random() * 0.4), color: i === 0 ? style.coreColor : col, width: 2.6, drag: 0.93 });
      }
    }
    const em = L.embers;
    if (em) {
      // (they drift off the surface itself where it's known, not along the throw)
      const base = aim.surface ? Math.atan2(aim.ny, aim.nx) : aim.a;
      for (let i = 0, n = Math.round(em.count * nk); i < n && room(); i++) {
        const a0 = base + (Math.random() - 0.5) * 2.8, a = aim.surface ? offSurface(a0, aim.nx, aim.ny) : a0;
        const s = em.speed * burstSpeed(em.outliers ?? BURST.outliers, em.outSpeed ?? BURST.outSpeed);
        this.f.sparks.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0, max: em.life * burstLife(em.outliers ?? BURST.outliers, em.outLife ?? BURST.outLife), color: em.hot, cool: em.cool, width: 2.4 + Math.random() * 1.4, drag: 0.94 });
      }
    }
    // A liquid splash: syrupy blobs falling back to the surface and a film creeping along it (liquidSplash.ts)
    if (L.liquid) { this.f.liquid.keep = this.f.particleKeep; this.f.liquid.spawn(L.liquid, x, y, aim, k); }
    if (L.scorch && this.f.scorches.length < HIT_CAP) {
      // (on what it struck: it rides with it, its group's anchor)
      this.f.scorches.push({ x, y, life: 0, max: L.scorch.life, size: L.scorch.size * k, color: L.scorch.color });
    }
    if (this.f.hitLights.length < 64) {
      const lt = L.light, glowR = (L.bloom?.size ?? L.core?.size ?? imp.flash * 0.5) * k;
      this.f.hitLights.push({ x, y, life: 0, max: Math.max(L.bloom?.life ?? 0, L.core?.life ?? 0, 8), radius: lt ? lt.radius * k : 60 + glowR * 4, power: lt?.power ?? 1, color: L.bloom?.color ?? imp.color });
    }
    // A cloud left where it landed, and a puff of vapourised hull (at the layered scale)
    const cloud = style.smokeCloud;
    if (cloud) {
      for (let i = 0; i < 5; i++) {
        if (this.f.particleKeep < 1 && Math.random() > this.f.particleKeep) continue;
        const a = Math.random() * Math.PI * 2, v = 0.3 + Math.random() * 0.8;
        this.f.smoke.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0, max: cloud.life * (0.7 + Math.random() * 0.6), size: cloud.size * k * (0.6 + Math.random() * 0.6), color: cloud.color, alpha: 0.3 });
      }
    }
    if (Math.random() < this.f.particleKeep) {
      const a = (aim.surface ? Math.atan2(aim.ny, aim.nx) : aim.a) + (Math.random() - 0.5) * 1.2;
      this.f.smoke.push({ x, y, vx: Math.cos(a) * 0.8, vy: Math.sin(a) * 0.8, life: 0, max: 40 + Math.random() * 20, size: 5 * k });
    }
    const sk = L.shake, st = this.host.state, me = st?.entities.get(st.playerId);
    if (sk && st && me) {
      const d = Math.hypot(me.renderX - x, me.renderY - y);
      if (d < sk.radius) st.triggerScreenShake(sk.strength * (1 - d / sk.radius), sk.time ?? 0.18);
    }
  }
}
