/**
 * A gun firing at a target dummy in a small Pixi view, for the hangar's parts lists. The gun is the part's own art
 * (gunArt.ts: the hangar's turret base and head or fixed barrels, muzzle at the real barrel tip). It uses the game's own
 * weapon drawing: rounds, muzzle flashes and hit effects are WeaponFx fed the same kind of rows a server snapshot would
 * give (a fake projectile entity per round, its model's look from weaponStyles), wired as the live client wires it
 * (ships/wiring/rendererHooks.ts): rounds stop at the dummy's real edge (castHit) and throw their impact off that edge's
 * normal (surfaceAt), riding the dummy; the barrel tip and the muzzle kick are hooked; beams use the model's BEAM_LOOKS
 * colours and the shared cone and strand drawing, burning the plate where they land. The gun fires at its real beat
 * (FireClock) with its real round speed. A Repair Beam mends a hurt friendly plate and a Point Defence Turret shoots
 * down missiles flown in at it (supportFx.ts).
 *
 * One instance is made on the first hover and reused (the Pixi app, the WeaponFx pools): `show(plan, art)` starts a
 * gun, `hide()` stops the ticker. It opens no server connection and reads nothing but the plan and the art. The quality
 * setting's tier sets the share of small particles and the frame cap.
 */

import { Application, Container, Graphics, Sprite, Texture } from 'pixi.js';
import { EntityType } from '@space-game/common';
import { WeaponFx, type ShellLook } from '../../rendering/weapons/WeaponFx';
import { beamLook, weaponStyle } from '../../rendering/weapons/weaponStyles';
import { drawCone, drawStrands } from '../beamLookFx';
import { PROFILES, type QualityTier } from '../../settings/quality';
import { settings } from '../../settings/Settings';
import type { GameState, InterpolatedEntity } from '../../state/GameState';
import { RECOIL, RECOIL_RETURN } from '../render/constants';
import { FireClock, flightTicks, type GunPlan } from './gunPlan';
import type { GunArt } from './gunArt';
import { DUMMY_ID, castPoly, dummyPoly, normalAt } from './dummy';
import { SupportFx } from './supportFx';

export const PREVIEW_W = 300;
export const PREVIEW_H = 150;
/** The dummy's size and how far it stands (world units) */
const DUMMY_R = 46;
const MAX_DIST = 380;
const MIN_DIST = 240;
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
  private dummy = new Graphics();
  /** The gun's art (a sprite turned to fire along +x, muzzle at the origin), slid back by its kick */
  private gun = new Container();
  private beamG = new Graphics();
  private fx: WeaponFx | null = null;
  private plan: GunPlan | null = null;
  private art: GunArt | null = null;
  private clock: FireClock | null = null;
  private rows: Row[] = [];
  private looks = new Map<number, ShellLook>();
  private support = new SupportFx();
  private pdFired = false;
  /** The dummy's corners (x, y pairs), where a beam first meets it, and the view's room behind the muzzle and across */
  private poly: number[] = [];
  private beamEnd = 0;
  private leftMargin = 80;
  private halfH = 30;
  private kick = 0;
  private nextId = 1;
  private tick = 0;
  private acc = 0;
  private dist = 600;
  private flash = 0;
  private salvo: { at: number; n: number }[] = [];
  private beamFrame = 0;
  private visible = false;
  private seed = 1;
  /** The dummy as the anchors of impacts on it look it up (it stands still) */
  private readonly dummyPose = { renderX: 0, renderY: 0, renderAngle: 0 };
  private readonly state = {
    entities: { ofType: (_t: EntityType) => this.rows.map((r) => r.e), get: (id: number) => (id === DUMMY_ID ? this.dummyPose : undefined) },
    playerId: PLAYER, serverTick: 0, predictionEnabled: false, drawMode: null,
    timelineAt: () => ({ drawTick: () => this.tick }), triggerScreenShake: () => {},
  } as unknown as GameState;

  constructor(host: HTMLElement) {
    this.canvasHost = host;
  }

  /** Start showing a gun with its part art (replaces what was showing); without art it is drawn as a plain box */
  show(plan: GunPlan, art: GunArt | null = null): void {
    this.plan = plan;
    this.setArt(art);
    this.visible = true;
    this.retarget();
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
    this.world.addChild(this.dummy, this.gun, this.beamG);
    app.stage.addChild(this.world);
    const fxLayer = new Container();
    this.world.addChild(fxLayer);
    this.fx = new WeaponFx(fxLayer);
    this.fx.particleKeep = PROFILES[tierNow()].particles;
    this.fx.shellLook = (id) => this.looks.get(id);
    // (as ships/wiring/rendererHooks.ts wires the live client: every shell stops at the first drawn surface, its impact
    // throws off that surface's normal and rides what it hit, and the muzzle is the drawn barrel's tip)
    this.fx.castHit = (x0, y0, x1, y1, _o, _s, out) => {
      const t = castPoly(this.poly, x0, y0, x1, y1);
      if (t === null) return false;
      out.t = t; out.x = x0 + (x1 - x0) * t; out.y = y0 + (y1 - y0) * t; out.target = DUMMY_ID;
      return true;
    };
    this.fx.surfaceAt = (x, y, dx, dy, _o, out) => normalAt(this.poly, x, y, dx, dy, out);
    this.fx.onStruck = () => { this.flash = 1; };
    this.fx.barrelTip = () => ({ x: 0, y: 0 });
    this.fx.onMuzzle = (_o, _x, _y, power) => { this.kick = Math.min(1.4, power); };
    const cap = tierNow() === 'low' ? 30 : 0;
    if (cap) app.ticker.maxFPS = cap;
    app.ticker.add(() => this.frame(app.ticker.deltaMS));
    this.layout();
    if (this.visible) app.ticker.start(); else app.ticker.stop();
  }

  /** Where the dummy stands, from the gun's reach, and the view that fits it */
  private retarget(): void {
    const p = this.plan;
    if (!p) return;
    this.dist = Math.max(MIN_DIST, Math.min(MAX_DIST, p.range * 0.6 || MIN_DIST));
    this.layout();
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

  private layout(): void {
    const span = this.leftMargin + this.dist + DUMMY_R + 40;
    const k = Math.min(PREVIEW_W / span, PREVIEW_H / 2 / (Math.max(this.halfH, DUMMY_R + 8) * 1.15));
    this.world.scale.set(k);
    this.world.position.set(this.leftMargin * k + (PREVIEW_W - span * k) / 2, PREVIEW_H / 2);
    this.drawStatic();
  }

  private drawStatic(): void {
    const d = this.dummy;
    d.clear();
    const r = DUMMY_R, repair = this.plan?.support === 'repair';
    // (the plate's edges are the ones rounds hit: dummy.ts)
    this.poly = dummyPoly(this.dist, r);
    this.dummyPose.renderX = this.dist;
    const t = castPoly(this.poly, 0, 0, this.dist + r * 2, 0);
    this.beamEnd = t === null ? this.dist - r : t * (this.dist + r * 2);
    d.circle(this.dist, 0, r + 6).fill({ color: 0x1b2438, alpha: 0.9 });
    d.poly(this.poly).fill(repair ? 0x5f8f86 : 0x7c8aa5).stroke({ color: repair ? 0x9fd8c8 : 0xb6c3dc, width: 3 });
    d.circle(this.dist, 0, r * 0.45).fill(repair ? 0x3e6a62 : 0x56627c);
    // (a hurt friendly plate for the Repair Beam to mend)
    if (repair) for (const [a, b] of [[0.2, 0.5], [2.4, 0.7], [4.1, 0.6]]) d.moveTo(this.dist + Math.cos(a) * r * 0.2, Math.sin(a) * r * 0.2).lineTo(this.dist + Math.cos(a + 0.3) * r * b, Math.sin(a + 0.3) * r * b).stroke({ color: 0x1a2a28, width: 2.5 });
    if (!this.art) {
      const g = new Graphics();
      g.roundRect(-70, -26, 62, 52, 6).fill(0x3a4864).stroke({ color: 0x6f82a8, width: 3 });
      g.rect(-12, -9, 30, 18).fill(0x8fa0c4).stroke({ color: 0xd2def5, width: 2 });
      this.gun.removeChildren().forEach((c) => c.destroy());
      this.gun.addChild(g);
    }
  }

  private reset(): void {
    this.rows.length = 0;
    this.looks.clear();
    this.salvo.length = 0;
    this.tick = 0;
    this.acc = 0;
    this.flash = 0;
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

  private fireVolley(): void {
    const p = this.plan!;
    const n = p.burst;
    for (let i = 0; i < n; i++) {
      const fan = n > 1 ? ((i / (n - 1)) - 0.5) * 2 : 0;
      this.launch(p.spread * (n > 1 ? fan : this.rnd() * 2) * Math.PI / 180);
    }
    if (p.salvo) for (let i = 1; i < p.salvo.count; i++) this.salvo.push({ at: this.tick + i * p.salvo.gap, n: 1 });
  }

  private launch(off: number): void {
    const p = this.plan!;
    const id = this.nextId++;
    const speed0 = p.tracked ? Math.max(1, p.speed) : p.maxSpeed || p.speed;
    // (a lobbed or tracked round reaches the dummy on its own clock; a straight one flies at its speed)
    const ticks = p.lob || p.tracked ? flightTicks(this.dist, p.speed, p.accel, p.maxSpeed) : 0;
    const v = p.lob ? this.dist / ticks : speed0;
    const ux = Math.cos(off), uy = Math.sin(off);
    const life = p.lob || p.tracked ? ticks + 2 : p.life || Math.ceil((this.dist * 1.5) / Math.max(1, v));
    // (from the muzzle, the drawn barrel's tip, at the world's origin)
    const e = {
      id, type: EntityType.Projectile, x: 0, y: 0, angle: off, vx: ux * v, vy: uy * v, renderX: 0, renderY: 0, renderAngle: off,
      hp: 1, maxHp: 1, data: [p.type, 1, 30, this.tick, 4, 0, PLAYER, p.size, 0, p.lob ? this.tick + ticks : 0], spawnX: 0, spawnY: 0, spawnTick: this.tick,
    } as unknown as InterpolatedEntity;
    this.looks.set(id, { model: p.model, damage: p.damage, splash: p.splash, life });
    this.rows.push({ id, e, born: this.tick, end: this.tick + (p.lob || p.tracked ? ticks : life), v: p.tracked ? Math.max(1, p.speed) : v, ux, uy });
  }

  private stepRows(): void {
    const p = this.plan!;
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
      if (this.tick >= r.end || r.e.renderX > this.dist + DUMMY_R * 3) {
        // A lobbed round lands where it was aimed (its row ends: WeaponFx.landed); the others fly out their flight
        // (a style that bursts on landing does it itself when its row ends; any other is told the hit)
        if (p.lob) { if (!weaponStyle(p.type, 1, p.model).landBurst) this.fx?.onHit(r.id, this.dist, 0); }
        else if (p.tracked) this.fx?.onHit(r.id, this.beamEnd, 0);
        this.rows.splice(i, 1);
        this.looks.delete(r.id);
      }
    }
  }

  private frame(deltaMS: number): void {
    const p = this.plan, fx = this.fx;
    if (!p || !fx || !this.clock) return;
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
      this.stepRows();
    }
    if (p.support) this.drawSupport(p, deltaMS);
    else if (p.beam) this.drawBeam(p, this.clock.lit(), deltaMS);
    // (the barrel slides back on a shot and eases home, as the ship renderer's guns do)
    this.kick = Math.max(0, this.kick - (deltaMS / 16.667) * RECOIL_RETURN);
    this.gun.position.set(this.kick > 0 ? -RECOIL * (this.art?.back ?? 60) * 0.5 * this.kick * this.kick : 0, 0);
    fx.update(this.state, Math.min(4, deltaMS / 16.667), this.tick, this.tick);
    this.flash = Math.max(0, this.flash - deltaMS / 260);
    this.dummy.alpha = 1 - 0.3 * this.flash;
    this.dummy.visible = p.support !== 'pd';
  }

  /** A Repair Beam held on the hurt plate, or a Point Defence Turret shooting down missiles flown in at it */
  private drawSupport(p: GunPlan, deltaMS: number): void {
    const g = this.beamG;
    g.clear();
    const frames = Math.min(4, deltaMS / 16.667);
    if (p.support === 'repair') {
      const look = beamLook(p.model);
      this.support.repair(g, 0, this.beamEnd, this.clock!.lit(), frames, look?.braid?.strands ?? 2, look?.braid?.color ?? 0x99f6e4);
    } else {
      this.support.pd(g, this.tick, this.pdFired, frames, this.dist + DUMMY_R, Math.min(this.dist, p.range));
      if (this.pdFired) this.kick = 0.6;
      this.pdFired = false;
    }
  }

  /** A held or pulsed beam from the muzzle to the dummy, in its model's colours (BEAM_LOOKS) */
  private drawBeam(p: GunPlan, lit: boolean, deltaMS: number): void {
    const g = this.beamG;
    g.clear();
    this.beamFrame += deltaMS / 16.667;
    if (!lit) return;
    const look = beamLook(p.model);
    const [outer, mid, core] = [look?.outer, look?.mid, look?.core].every((c) => c !== undefined)
      ? [look!.outer!, look!.mid!, look!.core!] : BEAM_COLORS[p.color ?? ''] ?? DEFAULT_BEAM;
    let a = 1;
    if (p.pulse) {
      // (a pulse swells to its peak and trails off, the next one a beat later)
      const period = Math.max(p.pulse.ticks, p.fire.interval);
      const u = (this.tick % period) / p.pulse.ticks;
      a = u >= 1 ? 0 : u < p.pulse.peakAt ? u / p.pulse.peakAt : 1 - (u - p.pulse.peakAt) / (1 - p.pulse.peakAt);
    } else a = 0.85 + 0.15 * Math.sin(this.beamFrame * 0.6);
    if (a < 0.02) return;
    const wid = Math.max(6, Math.min(34, p.width * (look?.width ?? 1) * (p.pulse ? a : 1)));
    // (from the muzzle to where the line first meets the dummy's edge)
    const x0 = 0, x1 = this.beamEnd, ux = 1, uy = 0;
    if (look?.cone) drawCone(g, x0, 0, ux, uy, Math.min(x1 - x0, look.coneLen ?? x1 - x0), look.cone, mid, 0.22 * a);
    g.moveTo(x0, 0).lineTo(x1, 0).stroke({ color: outer, width: wid * 1.9, alpha: 0.28 * a });
    g.moveTo(x0, 0).lineTo(x1, 0).stroke({ color: mid, width: wid, alpha: 0.7 * a });
    g.moveTo(x0, 0).lineTo(x1, 0).stroke({ color: core, width: wid * 0.4, alpha: a });
    if (look?.braid) drawStrands(g, x0, 0, ux, uy, x1 - x0, wid, look.braid.strands, look.braid.color, a, this.beamFrame / 60, 0);
    g.circle(x1, 0, wid * 1.3).fill({ color: mid, alpha: 0.35 * a });
    g.circle(x1, 0, wid * 0.6).fill({ color: core, alpha: 0.8 * a });
    // (the burn throws its impact off the edge it lights: WeaponFx.beamBurn asks surfaceAt for the normal and the target)
    if (look?.burn && Math.floor(this.beamFrame) % look.burn.every === 0) this.fx?.beamBurn(x1, 0, 1, 0, PLAYER, look.burn);
    this.flash = Math.max(this.flash, 0.5 * a);
  }
}
