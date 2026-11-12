/**
 * A gun firing at a wall of ship blocks in a small Pixi view, for the hangar's parts lists. The gun is the part's own art
 * (gunArt.ts: the hangar's turret base and head or fixed barrels, muzzle at the real barrel tip). It uses the game's own
 * weapon drawing: rounds, muzzle flashes and hit effects are WeaponFx fed the same kind of rows a server snapshot would
 * give (a fake projectile entity per round, its model's look from weaponStyles), wired as the live client wires it
 * (ships/wiring/rendererHooks.ts): rounds stop at the first block they touch (castHit) and throw their impact off that
 * block's edge normal (surfaceAt), riding it, and hurt it (blockTarget.ts: the catalogue's HP, the gun's real damage,
 * burst falloff, chain jumps, beam damage; a broken block goes off with the game's armour or hull break effect). The wall
 * stands at the gun's reach (framing.ts) with a faint tick where the reach ends, and is rebuilt when it is mostly gone.
 * The barrel tip and the muzzle kick are hooked; beams use the model's BEAM_LOOKS colours and the shared cone and strand
 * drawing, burning the block where they land. The gun fires at its real beat (FireClock) with its real round speed. A
 * Repair Beam mends a hurt friendly wall and a Point Defence Turret shoots down missiles flown in at it (supportFx.ts).
 *
 * One instance is made on the first hover and reused (the Pixi app, the WeaponFx pools): `show(plan, art, catalog)`
 * starts a gun, `hide()` stops the ticker. It opens no server connection and reads nothing but the plan, the art and the
 * catalogue. The quality setting's tier sets the share of small particles and the frame cap.
 */

import { Application, Container, Graphics, Sprite, Texture } from 'pixi.js';
import { EntityType, type Catalog } from '@space-game/common';
import { WeaponFx, type ShellLook } from '../../rendering/weapons/WeaponFx';
import { beamLook, weaponStyle } from '../../rendering/weapons/weaponStyles';
import { drawBeamBody, drawCone, drawEmitter, drawShaft, drawStrands, fanWidth, ignition, softGlow } from '../beamLookFx';
import { PROFILES, type QualityTier } from '../../settings/quality';
import { settings } from '../../settings/Settings';
import type { GameState, InterpolatedEntity } from '../../state/GameState';
import { RECOIL, RECOIL_RETURN } from '../render/constants';
import { DamageParticles } from '../damage/particles';
import { armorBreak, hullBreak } from '../damage/partEffects';
import type { DamageCtx } from '../damage/context';
import { FireClock, flightTicks, type GunPlan } from './gunPlan';
import type { GunArt } from './gunArt';
import { BLOCK_ID, BlockTarget, DEFAULT_SPEC, blockSpec, type HitDamage } from './blockTarget';
import { BlockArt } from './blockArt';
import { PREVIEW_H, PREVIEW_W, frame as frameFor, type Framing } from './framing';
import { SupportFx } from './supportFx';
import { modBeam, type ModFx } from '../../rendering/weapons/fx/mods';

export { PREVIEW_W, PREVIEW_H };
/** A hurt wall a Repair Beam mends starts at this share of its HP, and the least it mends a tick */
const HURT_SHARE = 0.4;
const MIN_MEND = 0.35;
const BEAM_COLORS: Record<string, [number, number, number]> = {
  red: [0xdc2626, 0xff6b6b, 0xffe4e4], green: [0x059669, 0x34d399, 0xf0fdf4], blue: [0x2563eb, 0x60a5fa, 0xeff6ff],
};
const DEFAULT_BEAM: [number, number, number] = [0xdc2626, 0xff6b6b, 0xffe4e4];
const PLAYER = 1;

function tierNow(): QualityTier {
  const q = settings.data.display.quality;
  return q === 'auto' ? 'medium' : q;
}

interface Row {
  id: number;
  e: InterpolatedEntity;
  born: number;
  end: number;
  /** Tracked rounds: speed this tick */
  v: number;
  ux: number;
  uy: number;
}

export class GunPreview {
  readonly canvasHost: HTMLElement;
  private app: Application | null = null;
  private starting = false;
  private world = new Container();
  private blocks = new BlockTarget();
  private blockArt = new BlockArt(null);
  private catalog: Catalog | null = null;
  private rangeG = new Graphics();
  private parts: DamageParticles | null = null;
  private fr: Framing | null = null;
  private poses: { renderX: number; renderY: number; renderAngle: number }[] = [];
  /** The gun's art (a sprite turned to fire along +x, muzzle at the origin), slid back by its kick */
  private gun = new Container();
  private beamG = new Graphics();
  private fx: WeaponFx | null = null;
  private plan: GunPlan | null = null;
  private art: GunArt | null = null;
  private clock: FireClock | null = null;
  private rows: Row[] = [];
  private looks = new Map<number, ShellLook>();
  /** Modifier effects the gun is shown with (each an effect id and a strength): its shells' and its beam's layers (fx/mods) */
  modFx: readonly ModFx[] | undefined;
  private support = new SupportFx();
  private pdFired = false;
  /** The view's room behind the muzzle and across */
  private leftMargin = 80;
  private halfH = 30;
  private kick = 0;
  private nextId = 1;
  private tick = 0;
  private acc = 0;
  private salvo: { at: number; n: number }[] = [];
  private beamFrame = 0;
  /** Seconds the held beam has been lit (its emitter's ignition) */
  private beamOn = 0;
  private visible = false;
  private seed = 1;
  private readonly state = {
    entities: { ofType: (_t: EntityType) => this.rows.map((r) => r.e), get: (id: number) => (id >= BLOCK_ID ? this.poses[id - BLOCK_ID] : undefined) },
    playerId: PLAYER, serverTick: 0, predictionEnabled: false, drawMode: null,
    timelineAt: () => ({ drawTick: () => this.tick }), triggerScreenShake: () => {},
  } as unknown as GameState;

  constructor(host: HTMLElement) {
    this.canvasHost = host;
  }

  /** Start showing a gun with its part art (replaces what was showing); without art it is drawn as a plain box. The catalogue gives the blocks' HP and look */
  show(plan: GunPlan, art: GunArt | null = null, catalog: Catalog | null = null): void {
    this.plan = plan;
    this.setCatalog(catalog);
    this.setArt(art);
    this.visible = true;
    this.layout();
    this.reset();
    if (!this.app && !this.starting) void this.start();
    else this.app?.ticker.start();
  }

  hide(): void {
    this.visible = false;
    this.app?.ticker.stop();
  }

  get running(): boolean {
    return this.visible && !!this.app?.ticker.started;
  }

  destroy(): void {
    this.visible = false;
    this.app?.destroy(true, { children: true });
    this.app = null;
    this.fx = null;
    this.parts = null;
  }

  private async start(): Promise<void> {
    this.starting = true;
    const app = new Application();
    await app.init({
      width: PREVIEW_W, height: PREVIEW_H, backgroundAlpha: 0, antialias: PROFILES[tierNow()].msaa, preference: 'webgl', autoStart: false,
      resolution: Math.min(PROFILES[tierNow()].maxDpr, window.devicePixelRatio || 1), autoDensity: true,
      eventFeatures: { move: false, globalMove: false, click: false, wheel: false },
    });
    this.starting = false;
    if (!this.canvasHost.isConnected && !this.visible) { app.destroy(true, { children: true }); return; }
    app.canvas.style.cssText = 'display:block; width:100%; height:100%;';
    this.canvasHost.appendChild(app.canvas);
    this.app = app;
    this.world.addChild(this.rangeG, this.blockArt.root, this.gun, this.beamG);
    app.stage.addChild(this.world);
    this.parts = new DamageParticles(this.world);
    this.parts.setQuality(PROFILES[tierNow()].particles, 500);
    const fxLayer = new Container();
    this.world.addChild(fxLayer);
    this.fx = new WeaponFx(fxLayer);
    this.fx.particleKeep = PROFILES[tierNow()].particles;
    this.fx.shellLook = (id) => this.looks.get(id);
    // (as ships/wiring/rendererHooks.ts wires the live client: every shell stops at the first drawn surface, its impact
    // throws off that surface's normal and rides what it hit, and the muzzle is the drawn barrel's tip)
    this.fx.castHit = (x0, y0, x1, y1, _o, _s, out) => {
      const c = this.blocks.cast(x0, y0, x1, y1);
      if (!c) return false;
      out.t = c.t; out.x = x0 + (x1 - x0) * c.t; out.y = y0 + (y1 - y0) * c.t; out.target = c.id;
      return true;
    };
    this.fx.surfaceAt = (x, y, dx, dy, _o, out) => this.blocks.normalAt(x, y, dx, dy, out);
    this.fx.onStruck = (_id, x, y, _type, target) => this.struck(x, y, target);
    this.fx.barrelTip = () => ({ x: 0, y: 0 });
    this.fx.onMuzzle = (_o, _x, _y, power) => { this.kick = Math.min(1.4, power); };
    const cap = tierNow() === 'low' ? 30 : 0;
    if (cap) app.ticker.maxFPS = cap;
    app.ticker.add(() => this.frame(app.ticker.deltaMS));
    this.layout();
    if (this.visible) app.ticker.start(); else app.ticker.stop();
  }

  /** The blocks' HP (the catalogue's partMaxHp for a square of hull and of armour) and the look to draw them in */
  private setCatalog(catalog: Catalog | null): void {
    if (catalog === this.catalog) return;
    this.catalog = catalog;
    this.blockArt.destroy();
    this.blockArt = new BlockArt(catalog);
    if (this.app) this.world.addChildAt(this.blockArt.root, 1);
    this.blocks = new BlockTarget(catalog ? blockSpec(catalog) : DEFAULT_SPEC);
  }

  /** The gun's art as a sprite turned to fire along +x with its muzzle at the world's origin (a plain box without art) */
  private setArt(art: GunArt | null): void {
    this.art = art;
    this.gun.removeChildren().forEach((c) => c.destroy({ texture: false }));
    if (!art) { this.leftMargin = 80; this.halfH = 30; return; }
    // (the texture is the art's, kept with it: not destroyed with the sprite)
    const sp = new Sprite(Texture.from(art.canvas));
    sp.pivot.set(art.tipX, art.tipY);
    sp.rotation = art.rotation;
    sp.scale.set(art.scale);
    this.gun.addChild(sp);
    this.leftMargin = Math.max(30, art.back) + 14;
    this.halfH = Math.max(24, art.half);
  }

  /** Where the wall stands (from the gun's reach), the view that fits it, and the wall laid out there */
  private layout(): void {
    const p = this.plan;
    if (!p) return;
    const fr = this.fr = frameFor(p, this.leftMargin, this.halfH);
    this.world.scale.set(fr.zoom);
    this.world.position.set(fr.originX, fr.originY);
    this.blocks.layout(fr.dist, fr.block, p.support === 'repair' ? HURT_SHARE : 1);
    this.poses = this.blocks.blocks.map((b) => ({ renderX: b.x, renderY: b.y, renderAngle: 0 }));
    this.blockArt.sync(this.blocks);
    this.drawStatic();
  }

  /** The faint reach line at the gun's range (chevrons at the right edge when it is off the view); a box for a gun without art */
  private drawStatic(): void {
    const fr = this.fr!, g = this.rangeG, k = 1 / fr.zoom;
    g.clear();
    const stroke = { color: 0x8fb4ff, alpha: 0.4, width: 1.3 * k };
    if (fr.tickX !== null) {
      for (let y = -fr.halfH * 1.3; y < fr.halfH * 1.3; y += 12 * k) g.moveTo(fr.tickX, y).lineTo(fr.tickX, y + 6 * k).stroke(stroke);
    } else {
      const x = (PREVIEW_W - fr.originX) * k - 12 * k, s = 4 * k;
      for (const o of [0, 5 * k]) g.moveTo(x + o, -s).lineTo(x + o + s, 0).lineTo(x + o, s).stroke(stroke);
    }
    if (!this.art) {
      const b = new Graphics();
      b.roundRect(-70, -26, 62, 52, 6).fill(0x3a4864).stroke({ color: 0x6f82a8, width: 3 });
      b.rect(-12, -9, 30, 18).fill(0x8fa0c4).stroke({ color: 0xd2def5, width: 2 });
      this.gun.removeChildren().forEach((c) => c.destroy());
      this.gun.addChild(b);
    }
  }

  private reset(): void {
    this.rows.length = 0;
    this.looks.clear();
    this.salvo.length = 0;
    this.tick = 0;
    this.acc = 0;
    this.kick = 0;
    this.pdFired = false;
    this.gun.position.set(0, 0);
    this.beamG.clear();
    this.support.reset();
    this.clock = this.plan ? new FireClock(this.plan.fire, this.plan.beam) : null;
  }

  private rnd(): number {
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    return this.seed / 4294967296 - 0.5;
  }

  private hitDamage(): HitDamage {
    const p = this.plan!;
    return { damage: p.damage, splashDamage: p.splashDamage, splashRadius: p.splash, splashFalloff: p.splashFalloff, chain: p.chain };
  }

  /** A round stopped at (x, y) on block `target` (-1: not known): it hurts the blocks it should */
  private struck(x: number, y: number, target: number): void {
    if (!this.plan) return;
    this.blocks.strike(x, y, target, this.hitDamage());
  }

  /** Blocks that broke: the game's armour or hull break at each, thrown away from the gun */
  private breakEffects(): void {
    const broken = this.blocks.takeBroken();
    if (!broken.length || !this.parts) return;
    const ctx = { p: this.parts, sound: () => {} } as unknown as DamageCtx;
    for (const b of broken) (b.armour ? armorBreak : hullBreak)(ctx, b.x, b.y, 1.2, (this.rnd()) * 0.8, b.size * 1.2);
  }

  private fireVolley(): void {
    const p = this.plan!;
    const n = p.burst;
    for (let i = 0; i < n; i++) {
      const fan = n > 1 ? ((i / (n - 1)) - 0.5) * 2 : 0;
      this.launch(p.spread * (n > 1 ? fan : this.rnd() * 2) * Math.PI / 180);
    }
    if (p.salvo) for (let i = 1; i < p.salvo.count; i++) this.salvo.push({ at: this.tick + i * p.salvo.gap, n: 1 });
  }

  private launch(spreadOff: number): void {
    const p = this.plan!, fr = this.fr!;
    // (the aim drifts slowly up and down the wall, a few degrees at most, so rounds hurt rows in turn and not just the middle one)
    const off = spreadOff + (p.lob ? 0 : Math.min(0.07, Math.atan2(fr.halfH * 0.85, fr.dist)) * Math.sin(this.tick * 0.011));
    const id = this.nextId++;
    const speed0 = p.tracked ? Math.max(1, p.speed) : p.maxSpeed || p.speed;
    // (a lobbed round lands at the aim on its own clock, a seeker flies to the wall's back; a straight one flies at its speed)
    const reach = p.lob ? fr.aimX : fr.farX;
    const ticks = p.lob || p.tracked ? flightTicks(reach, p.speed, p.accel, p.maxSpeed) : 0;
    const v = p.lob ? reach / ticks : speed0;
    const ux = Math.cos(off), uy = Math.sin(off);
    const life = p.lob || p.tracked ? ticks + 2 : p.life || Math.ceil((fr.dist * 1.5) / Math.max(1, v));
    // (from the muzzle, the drawn barrel's tip, at the world's origin)
    const e = {
      id, type: EntityType.Projectile, x: 0, y: 0, angle: off, vx: ux * v, vy: uy * v, renderX: 0, renderY: 0, renderAngle: off,
      hp: 1, maxHp: 1, data: [p.type, 1, 30, this.tick, 4, 0, PLAYER, p.size, 0, p.lob ? this.tick + ticks : 0], spawnX: 0, spawnY: 0, spawnTick: this.tick,
    } as unknown as InterpolatedEntity;
    this.looks.set(id, { model: p.model, damage: p.damage, splash: p.splash, life, fx: this.modFx });
    this.rows.push({ id, e, born: this.tick, end: this.tick + (p.lob || p.tracked ? ticks : life), v: p.tracked ? Math.max(1, p.speed) : v, ux, uy });
  }

  private stepRows(): void {
    const p = this.plan!, fr = this.fr!;
    for (let i = this.rows.length - 1; i >= 0; i--) {
      const r = this.rows[i];
      if (p.tracked && !p.lob) {
        // (a seeker's row moves as the server's would: speeding up along its line)
        r.v = Math.min(p.maxSpeed || r.v + p.accel, r.v + p.accel);
        r.e.vx = r.ux * r.v; r.e.vy = r.uy * r.v;
        r.e.x += r.e.vx; r.e.y += r.e.vy;
        r.e.renderX = r.e.x; r.e.renderY = r.e.y;
        r.e.renderAngle = Math.atan2(r.uy, r.ux);
      }
      if (this.tick >= r.end || r.e.renderX > fr.farX + fr.block * 4) {
        // A lobbed round lands where it was aimed (its row ends: WeaponFx.landed); the others fly out their flight
        // (a style that bursts on landing does it itself when its row ends; any other is told the hit)
        if (p.lob) { if (!weaponStyle(p.type, 1, p.model).landBurst) this.fx?.onHit(r.id, fr.aimX, 0); }
        else if (p.tracked) this.fx?.onHit(r.id, this.blocks.beamEnd(fr.farX) ?? fr.farX, 0);
        this.rows.splice(i, 1);
        this.looks.delete(r.id);
      }
    }
  }

  /** How strong the held or pulsed beam is this tick (0..1) */
  private beamLevel(p: GunPlan): number {
    if (!this.clock!.lit()) return 0;
    if (!p.pulse) return 1;
    // (a pulse swells to its peak and trails off, the next one a beat later)
    const period = Math.max(p.pulse.ticks, p.fire.interval);
    const u = (this.tick % period) / p.pulse.ticks;
    return u >= 1 ? 0 : u < p.pulse.peakAt ? u / p.pulse.peakAt : 1 - (u - p.pulse.peakAt) / (1 - p.pulse.peakAt);
  }

  private frame(deltaMS: number): void {
    const p = this.plan, fx = this.fx, fr = this.fr;
    if (!p || !fx || !this.clock || !fr) return;
    this.acc += Math.min(100, deltaMS) * 0.06;
    let n = 0;
    while (this.acc >= 1 && n++ < 8) {
      this.acc -= 1;
      this.tick++;
      this.state.serverTick = this.tick;
      const fired = this.clock.step();
      if (fired && p.support === 'pd') this.pdFired = true;
      else if (fired) this.fireVolley();
      for (let i = this.salvo.length - 1; i >= 0; i--) if (this.salvo[i].at <= this.tick) { this.launch(this.rnd() * (p.spread * Math.PI / 180) * 2); this.salvo.splice(i, 1); }
      // (a beam burns the first block on its line each tick; a Repair Beam mends it)
      if (p.beam && p.support !== 'pd') {
        const a = this.beamLevel(p);
        if (a > 0 && p.beamFan && !p.support) for (let r = 0; r < p.beamFan.off.length; r++) this.blocks.beam(p.perTick * a * p.beamFan.share[r], fr.farX, fr.farX * Math.tan(p.beamFan.off[r]));
        else if (a > 0) this.blocks.beam(p.support === 'repair' ? -Math.max(p.perTick, MIN_MEND) : p.perTick * a, fr.farX);
      }
      this.stepRows();
    }
    this.blocks.step(Math.min(100, deltaMS) / 1000);
    this.breakEffects();
    this.blockArt.sync(this.blocks);
    this.blockArt.root.visible = p.support !== 'pd';
    if (p.support) this.drawSupport(p, deltaMS);
    else if (p.beam) this.drawBeam(p, deltaMS);
    // (the barrel slides back on a shot and eases home, as the ship renderer's guns do)
    this.kick = Math.max(0, this.kick - (deltaMS / 16.667) * RECOIL_RETURN);
    this.gun.position.set(this.kick > 0 ? -RECOIL * (this.art?.back ?? 60) * 0.5 * this.kick * this.kick : 0, 0);
    const frames = Math.min(4, deltaMS / 16.667);
    // (WeaponFx.update takes seconds, as the Renderer gives it)
    fx.update(this.state, frames / 60, this.tick, this.tick);
    if (this.parts) { this.parts.begin(); this.parts.draw(frames); this.parts.end(); }
  }

  /** A Repair Beam held on the hurt wall, or a Point Defence Turret shooting down missiles flown in at it */
  private drawSupport(p: GunPlan, deltaMS: number): void {
    const g = this.beamG, fr = this.fr!;
    g.clear();
    const frames = Math.min(4, deltaMS / 16.667);
    if (p.support === 'repair') {
      const look = beamLook(p.model);
      this.support.repair(g, 0, this.blocks.beamEnd(fr.farX) ?? fr.dist, this.clock!.lit(), frames, look?.braid?.strands ?? 2, look?.braid?.color ?? 0x99f6e4);
    } else {
      this.support.pd(g, this.tick, this.pdFired, frames, fr.dist + fr.depth / 2, Math.min(fr.dist, p.range));
      if (this.pdFired) this.kick = 0.6;
      this.pdFired = false;
    }
  }

  /** A held or pulsed beam from the muzzle to the first block on its line, in its model's colours (BEAM_LOOKS) */
  private drawBeam(p: GunPlan, deltaMS: number): void {
    const g = this.beamG, fr = this.fr!;
    g.clear();
    this.beamFrame += deltaMS / 16.667;
    if (!this.clock!.lit()) { this.beamOn = 0; return; }
    const look = beamLook(p.model);
    const [outer, mid, core] = [look?.outer, look?.mid, look?.core].every((c) => c !== undefined)
      ? [look!.outer!, look!.mid!, look!.core!] : BEAM_COLORS[p.color ?? ''] ?? DEFAULT_BEAM;
    let a = 1;
    if (p.pulse) a = this.beamLevel(p);
    else a = 0.85 + 0.15 * Math.sin(this.beamFrame * 0.6);
    if (a < 0.02) return;
    const wid = Math.max(6, Math.min(34, p.width * (look?.width ?? 1) * (p.pulse ? a : 1)));
    this.beamOn = p.pulse ? 1 : this.beamOn + deltaMS / 1000;
    // (A split beam's fan, tuning.ts beamFan: each of its beams from the one muzzle, as wide as its share)
    const fan = p.beamFan, rays = fan ? fan.off.length : 1, midRay = (rays - 1) >> 1;
    for (let r = 0; r < rays; r++) {
      const off = fan ? fan.off[r] : 0, rk = fan ? fanWidth(fan.share, r) : 1, ux = Math.cos(off), uy = Math.sin(off), seed = r * 1.7;
      // (to the first block's face; past the wall once it is gone, to the gun's reach if that is nearer)
      const hitX = this.blocks.beamEnd(fr.farX, fr.farX * Math.tan(off));
      const x0 = 0, x1 = hitX ?? Math.min(fr.reach || fr.farX + 120, fr.farX + 120), y1 = x1 * Math.tan(off), len = Math.hypot(x1 - x0, y1);
      if (look?.cone) drawCone(g, x0, 0, ux, uy, Math.min(len, look.coneLen ?? len), look.cone, mid, 0.22 * a);
      // (the game's own body and emitter: ships/beamLookFx.ts, its width the game's measure)
      const bw = (wid / 1.5) * rk;
      if (look?.shaft) drawShaft(g, x0, 0, ux, uy, len, bw, look.shaft.spread, look.shaft.color, a, this.beamFrame / 60, seed, look.shaft.dust, hitX !== undefined && hitX !== null);
      drawBeamBody(g, x0, 0, x1, y1, bw, outer, mid, core, a);
      if (look?.braid) drawStrands(g, x0, 0, ux, uy, len, wid * rk, look.braid.strands, look.braid.color, a, this.beamFrame / 60, seed);
      if (r === midRay) drawEmitter(g, x0, 0, ux, uy, bw, mid, core, a, this.beamFrame / 60, 0, ignition(this.beamOn));
      softGlow(g, x1, y1, bw * 3, mid, 0.9 * a);
      g.circle(x1, y1, wid * rk * 0.6).fill({ color: core, alpha: 0.8 * a });
      modBeam(g, this.modFx, x0, 0, x1, y1, bw, a, this.beamFrame / 60, seed, hitX !== null);
      // (the burn throws its impact off the block it lights: WeaponFx.beamBurn asks surfaceAt for the normal and the target)
      if (hitX !== null && look?.burn && Math.floor(this.beamFrame) % look.burn.every === 0) this.fx?.beamBurn(x1, y1, ux, uy, PLAYER, look.burn);
    }
  }
}
