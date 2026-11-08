/**
 * A gun firing at a target dummy in a small Pixi view, for the hangar's parts lists. It uses the game's own weapon
 * drawing: rounds, muzzle flashes and hit effects are WeaponFx fed the same kind of rows a server snapshot would give
 * (a fake projectile entity per round, its model's look from weaponStyles), and beams use the model's BEAM_LOOKS colours
 * and the shared cone and strand drawing. The gun fires at its real beat (FireClock) with its real round speed.
 *
 * One instance is made on the first hover and reused (the Pixi app, the WeaponFx pools): `show(plan)` starts a gun,
 * `hide()` stops the ticker. It opens no server connection and reads nothing but the plan. The quality setting's tier
 * sets the share of small particles and the frame cap.
 */

import { Application, Container, Graphics } from 'pixi.js';
import { EntityType } from '@space-game/common';
import { WeaponFx, type ShellLook } from '../../rendering/weapons/WeaponFx';
import { beamLook, weaponStyle } from '../../rendering/weapons/weaponStyles';
import { drawCone, drawStrands } from '../beamLookFx';
import { PROFILES, type QualityTier } from '../../settings/quality';
import { settings } from '../../settings/Settings';
import type { GameState, InterpolatedEntity } from '../../state/GameState';
import { FireClock, flightTicks, segmentCircle, type GunPlan } from './gunPlan';

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
  private gun = new Graphics();
  private beamG = new Graphics();
  private fx: WeaponFx | null = null;
  private plan: GunPlan | null = null;
  private clock: FireClock | null = null;
  private rows: Row[] = [];
  private looks = new Map<number, ShellLook>();
  private nextId = 1;
  private tick = 0;
  private acc = 0;
  private dist = 600;
  private flash = 0;
  private salvo: { at: number; n: number }[] = [];
  private beamFrame = 0;
  private visible = false;
  private seed = 1;
  private readonly state = {
    entities: { ofType: (_t: EntityType) => this.rows.map((r) => r.e), get: (_id: number) => undefined },
    playerId: PLAYER, serverTick: 0, predictionEnabled: false, drawMode: null,
    timelineAt: () => ({ drawTick: () => this.tick }), triggerScreenShake: () => {},
  } as unknown as GameState;

  constructor(host: HTMLElement) {
    this.canvasHost = host;
  }

  /** Start showing a gun (replaces what was showing) */
  show(plan: GunPlan): void {
    this.plan = plan;
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
    this.fx.castHit = (x0, y0, x1, y1, _o, _s, out) => {
      const t = segmentCircle(x0, y0, x1, y1, this.dist, 0, DUMMY_R);
      if (t === null) return false;
      out.t = t; out.x = x0 + (x1 - x0) * t; out.y = y0 + (y1 - y0) * t; out.target = -1;
      return true;
    };
    this.fx.surfaceAt = (x, y, _dx, _dy, _o, out) => {
      const nx = x - this.dist, ny = y, l = Math.hypot(nx, ny) || 1;
      out.nx = nx / l; out.ny = ny / l;
      return out;
    };
    this.fx.onStruck = () => { this.flash = 1; };
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

  private layout(): void {
    const span = this.dist + DUMMY_R + 100;
    const k = PREVIEW_W / span;
    this.world.scale.set(k);
    this.world.position.set(80 * k, PREVIEW_H / 2);
    this.drawStatic();
  }

  private drawStatic(): void {
    const d = this.dummy;
    d.clear();
    const r = DUMMY_R;
    d.circle(this.dist, 0, r + 6).fill({ color: 0x1b2438, alpha: 0.9 });
    d.poly(Array.from({ length: 8 }, (_, i) => [this.dist + Math.cos((i + 0.5) * Math.PI / 4) * r, Math.sin((i + 0.5) * Math.PI / 4) * r]).flat()).fill(0x7c8aa5).stroke({ color: 0xb6c3dc, width: 3 });
    d.circle(this.dist, 0, r * 0.45).fill(0x56627c);
    const g = this.gun;
    g.clear();
    g.roundRect(-70, -26, 62, 52, 6).fill(0x3a4864).stroke({ color: 0x6f82a8, width: 3 });
    g.rect(-12, -9, 30, 18).fill(0x8fa0c4).stroke({ color: 0xd2def5, width: 2 });
  }

  private reset(): void {
    this.rows.length = 0;
    this.looks.clear();
    this.salvo.length = 0;
    this.tick = 0;
    this.acc = 0;
    this.flash = 0;
    this.beamG.clear();
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
    const ticks = p.lob || p.tracked ? flightTicks(this.dist - 4, p.speed, p.accel, p.maxSpeed) : 0;
    const v = p.lob ? (this.dist - 4) / ticks : speed0;
    const ux = Math.cos(off), uy = Math.sin(off);
    const life = p.lob || p.tracked ? ticks + 2 : p.life || Math.ceil((this.dist * 1.5) / Math.max(1, v));
    const e = {
      id, type: EntityType.Projectile, x: 4, y: 0, angle: off, vx: ux * v, vy: uy * v, renderX: 4, renderY: 0, renderAngle: off,
      hp: 1, maxHp: 1, data: [p.type, 1, 30, this.tick, 4, 0, PLAYER, p.size, 0, p.lob ? this.tick + ticks : 0], spawnX: 4, spawnY: 0, spawnTick: this.tick,
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
        else if (p.tracked) this.fx?.onHit(r.id, this.dist - DUMMY_R * 0.8, 0);
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
      if (this.clock.step()) this.fireVolley();
      for (let i = this.salvo.length - 1; i >= 0; i--) if (this.salvo[i].at <= this.tick) { this.launch(this.rnd() * (p.spread * Math.PI / 180) * 2); this.salvo.splice(i, 1); }
      this.stepRows();
    }
    if (p.beam) this.drawBeam(p, this.clock.lit(), deltaMS);
    fx.update(this.state, Math.min(4, deltaMS / 16.667), this.tick, this.tick);
    this.flash = Math.max(0, this.flash - deltaMS / 260);
    this.dummy.alpha = 1 - 0.3 * this.flash;
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
    const x0 = 6, x1 = this.dist - DUMMY_R + 4, ux = 1, uy = 0;
    if (look?.cone) drawCone(g, x0, 0, ux, uy, Math.min(x1 - x0, look.coneLen ?? x1 - x0), look.cone, mid, 0.22 * a);
    g.moveTo(x0, 0).lineTo(x1, 0).stroke({ color: outer, width: wid * 1.9, alpha: 0.28 * a });
    g.moveTo(x0, 0).lineTo(x1, 0).stroke({ color: mid, width: wid, alpha: 0.7 * a });
    g.moveTo(x0, 0).lineTo(x1, 0).stroke({ color: core, width: wid * 0.4, alpha: a });
    if (look?.braid) drawStrands(g, x0, 0, ux, uy, x1 - x0, wid, look.braid.strands, look.braid.color, a, this.beamFrame / 60, 0);
    g.circle(x1, 0, wid * 1.3).fill({ color: mid, alpha: 0.35 * a });
    g.circle(x1, 0, wid * 0.6).fill({ color: core, alpha: 0.8 * a });
    if (look?.burn && Math.floor(this.beamFrame) % look.burn.every === 0) this.fx?.beamBurn(x1, 0, 1, 0, PLAYER, look.burn);
    this.flash = Math.max(this.flash, 0.5 * a);
  }
}
