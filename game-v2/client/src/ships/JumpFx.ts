/**
 * Jump drive visuals, for every ship (from its jump counter):
 *   charging  rings collapse onto the hull, light gathers at the nose, the
 *             local screen darkens at the edges
 *   launch    a flash and a shockwave left hanging where the ship was
 *   burn      a long blue-white wake, a bow shock, and (for the local
 *             pilot) stars streaking past the screen
 *   arrival   a smaller flash where the burn ends
 * plus the local pilot's drive gauge (ready / spooling / cooling), and while
 * they line a jump up: the drive's reach as a ring round the ship, where it
 * will drop them (red, with a warning, if that's into a star or among
 * hostiles), and what it's locked on to.
 */

import { clearIfDrawn } from '../rendering/gfx';
import { Container, Graphics } from 'pixi.js';
import { EntityType, JumpPhase, JumpTuning, jumpPhase } from '@space-game/common';
import type { GameState, InterpolatedEntity } from '../state/GameState';
import type { ShipSource } from './ShipStore';
import { settings } from '../settings/Settings';
import { boundKeyName } from '../input/keybindings';

const CORE = 0xe8f6ff;
const BLUE = 0x7dd3fc;
const DEEP = 0x3b82f6;
const WARN = 0xf87171;
/** A stillstone's priming (the reach ring takes its colour: greyseam) */
const LODE = 0xa3c2cf;

/** What the gauge says about charging fields (ShipClient.gaugeField) */
export interface GaugeField {
  ring: boolean;
  lodestone: boolean;
  /** Extra cooldown ticks counted per tick (jumpFields.ts fieldCharge) */
  charge: number;
  /** Seconds the drive stays primed */
  primeSecs: number;
  /** The priming's range multiplier (1: not primed) */
  boost: number;
  /** Stillstones' short name (tuning.json jump.lodestoneShort) */
  short: string;
}

interface Flash { x: number; y: number; r: number; age: number; life: number; big: boolean; angle: number }

export class JumpFx {
  private g = new Graphics();
  private flashes: Flash[] = [];
  private lastPhase = new Map<number, JumpPhase>();
  private time = 0;
  /** Star streaks and the spooling vignette (a display setting) */
  screenEffects = true;
  /** A ship's drive changed phase (for sound) */
  onPhase: ((id: number, prev: JumpPhase, next: JumpPhase, x: number, y: number) => void) | null = null;

  private screen: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private streaks: { x: number; y: number; len: number; speed: number; w: number }[] = [];
  private screenBurn = 0;
  private screenCharge = 0;
  /** The screen canvas has something on it */
  private screenDrawn = false;
  private hud: HTMLDivElement;
  private hudFill: HTMLDivElement;
  private hudText: HTMLSpanElement;
  private hudShown = false;
  /** What the gauge shows now (so unchanged frames touch nothing) */
  private hudKey = { text: '', color: '', width: '', opacity: '' };

  constructor(layer: Container, private ships: ShipSource, private state: GameState, private tuning: JumpTuning) {
    this.g.blendMode = 'add';
    layer.addChild(this.g);

    this.screen = document.createElement('canvas');
    this.screen.style.cssText = 'position: fixed; inset: 0; width: 100%; height: 100%; pointer-events: none; z-index: 86;';
    document.body.appendChild(this.screen);
    this.ctx = this.screen.getContext('2d')!;
    const resize = () => { this.screen.width = window.innerWidth; this.screen.height = window.innerHeight; };
    resize();
    window.addEventListener('resize', resize);

    this.hud = document.createElement('div');
    this.hud.style.cssText = `position: fixed; left: 50%; bottom: 118px; transform: translateX(-50%); width: 360px; display: none;
      font: 600 10px 'Segoe UI', system-ui, sans-serif; letter-spacing: 1.5px; color: #9fd8ff; text-align: center; pointer-events: none; z-index: 900;`;
    this.hudText = document.createElement('span');
    const track = document.createElement('div');
    track.style.cssText = 'margin-top: 4px; height: 4px; border-radius: 2px; background: rgba(125, 211, 252, 0.15); overflow: hidden;';
    this.hudFill = document.createElement('div');
    this.hudFill.style.cssText = 'height: 100%; width: 0; background: linear-gradient(90deg, #3b82f6, #e8f6ff); box-shadow: 0 0 8px #7dd3fc;';
    track.appendChild(this.hudFill);
    this.hud.append(this.hudText, track);
    document.body.appendChild(this.hud);
  }

  /** Jump counter for an entity: predicted for the local player, from snapshots for everyone else */
  static counter(e: InterpolatedEntity, local: boolean): number {
    // (Only pilots' ships carry one, in data[3]: a pilotless ship's data[3] is its faction, and it never jumps)
    if (e.type !== EntityType.Player) return 0;
    return (local ? e.jump : undefined) ?? e.data?.[3] ?? 0;
  }

  update(dt: number, opts: { hidden: boolean; latched: boolean; aiming?: boolean; aimDist?: number; aimLabel?: string | null; reach?: number; landing?: { x: number; y: number } | null; field?: GaugeField; danger?: string | null }): void {
    this.time += dt;
    const g = this.g;
    clearIfDrawn(g);
    const t = this.tuning;
    const me = this.state.playerId;
    let localPhase: { phase: JumpPhase; progress: number } | null = null;
    let localAngle = 0;

    for (const [id, ship] of this.ships.bodies) {
      if (ship.kind !== 'ship') continue;
      const e = this.state.entities.get(id);
      if (!e) continue;
      const local = id === me;
      const tt = ship.derived.jumpCooldown ? { ...t, cooldownTicks: ship.derived.jumpCooldown } : t;
      const ph = jumpPhase(JumpFx.counter(e, local), tt);
      if (local) this.localCooldown = tt.cooldownTicks;
      // Where this jump will land (ShipClient.jumpLanding: the spool's slide, then along the aim), inside the drive's reach (a ring round the ship)
      if (local && opts.aiming && !opts.hidden && opts.reach && opts.landing) {
        const lx = opts.landing.x, ly = opts.landing.y;
        const pulse = 0.6 + 0.4 * Math.sin(this.time * 6);
        const col = opts.danger ? WARN : opts.aimLabel ? 0xfbbf24 : BLUE;
        // The reach: dashes round the ship, drifting slowly
        const segs = 96;
        for (let k = 0; k < segs; k += 2) {
          const a0 = (k / segs) * Math.PI * 2 + this.time * 0.05, a1 = a0 + Math.PI * 2 / segs;
          g.moveTo(e.renderX + Math.cos(a0) * opts.reach, e.renderY + Math.sin(a0) * opts.reach)
            .arc(e.renderX, e.renderY, opts.reach, a0, a1).stroke({ color: (opts.field?.boost ?? 1) > 1 ? LODE : BLUE, width: 6, alpha: 0.22 });
        }
        const la = Math.atan2(ly - e.renderY, lx - e.renderX), lr = Math.max(12, ship.derived.radius) * 1.5;
        g.moveTo(e.renderX + Math.cos(la) * lr, e.renderY + Math.sin(la) * lr)
          .lineTo(lx, ly).stroke({ color: col, width: 2, alpha: opts.danger ? 0.35 : 0.18 });
        g.circle(lx, ly, 160).stroke({ color: col, width: 4, alpha: 0.5 * pulse });
        g.circle(lx, ly, 60).stroke({ color: opts.danger ? WARN : CORE, width: 3, alpha: 0.6 });
        // Locked on: corner brackets round the reticle
        if (opts.aimLabel) {
          for (let k = 0; k < 4; k++) {
            const a = Math.PI / 4 + (k * Math.PI) / 2 + this.time * 0.6;
            g.moveTo(lx + Math.cos(a - 0.3) * 230, ly + Math.sin(a - 0.3) * 230).arc(lx, ly, 230, a - 0.3, a + 0.3).stroke({ color: col, width: 5, alpha: 0.7 });
          }
        }
      }
      if (local) { localPhase = ph; localAngle = e.renderAngle; }
      const R = Math.max(12, ship.derived.radius);
      const x = e.renderX, y = e.renderY, a = e.renderAngle;
      const cx = Math.cos(a), cy = Math.sin(a);

      const prev = this.lastPhase.get(id);
      if (prev !== ph.phase) {
        if (ph.phase === 'burn' && prev === 'charging') this.flashes.push({ x, y, r: R, age: 0, life: 0.9, big: true, angle: a });
        if (prev === 'burn' && ph.phase !== 'burn') this.flashes.push({ x, y, r: R, age: 0, life: 0.6, big: false, angle: a });
        if (prev !== undefined) this.onPhase?.(id, prev, ph.phase, x, y);
        this.lastPhase.set(id, ph.phase);
      }

      if (ph.phase === 'charging') {
        const p = ph.progress;
        // Rings collapsing onto the hull, faster as the charge builds
        for (let k = 0; k < 3; k++) {
          const f = (this.time * (0.8 + p * 1.6) + k / 3) % 1;
          const rr = R * (1.1 + 2.6 * (1 - f));
          g.circle(x, y, rr).stroke({ color: BLUE, width: 2 + 3 * p, alpha: (0.15 + 0.55 * p) * f });
        }
        g.circle(x, y, R * 1.08).stroke({ color: CORE, width: 1.5, alpha: 0.25 + 0.5 * p });
        // Motes drawn in towards the ship
        for (let k = 0; k < 18; k++) {
          const seed = k * 2.399;
          const f = (this.time * (0.6 + p) + k / 18) % 1;
          const ang = seed + Math.floor(this.time * (0.6 + p) + k / 18) * 1.7;
          const d0 = R * (1.3 + 3 * (1 - f)), d1 = d0 + R * 0.35 * (0.4 + p);
          g.moveTo(x + Math.cos(ang) * d0, y + Math.sin(ang) * d0).lineTo(x + Math.cos(ang) * d1, y + Math.sin(ang) * d1)
            .stroke({ color: BLUE, width: 2, alpha: f * (0.2 + 0.6 * p) });
        }
        // Light gathering at the nose
        const nx = x + cx * R * 1.05, ny = y + cy * R * 1.05;
        const pulse = 1 + 0.15 * Math.sin(this.time * 30 * (0.4 + p));
        g.circle(nx, ny, R * (0.15 + 0.6 * p) * pulse).fill({ color: DEEP, alpha: 0.25 * p });
        g.circle(nx, ny, R * (0.06 + 0.25 * p) * pulse).fill({ color: BLUE, alpha: 0.5 * p });
        g.circle(nx, ny, R * (0.02 + 0.1 * p)).fill({ color: CORE, alpha: 0.9 });
      } else if (ph.phase === 'burn') {
        // Wake: from the ship back along its path, wide and faint to thin and bright
        const speed = Math.hypot(e.vx, e.vy);
        const fade = 1 - Math.max(0, (ph.progress - 0.75) / 0.25);
        const len = Math.min(9000, Math.max(R * 4, speed * 18)) * fade;
        const tx = x - cx * len, ty = y - cy * len;
        g.moveTo(x, y).lineTo(tx, ty).stroke({ color: DEEP, width: R * 1.6, alpha: 0.12 * fade });
        g.moveTo(x, y).lineTo(x - cx * len * 0.7, y - cy * len * 0.7).stroke({ color: BLUE, width: R * 0.7, alpha: 0.3 * fade });
        g.moveTo(x, y).lineTo(x - cx * len * 0.45, y - cy * len * 0.45).stroke({ color: CORE, width: R * 0.22, alpha: 0.8 * fade });
        // Bow shock ahead of the nose
        const bx = x + cx * R * 1.1, by = y + cy * R * 1.1;
        g.moveTo(bx + Math.cos(a + 2.2) * R * 1.4, by + Math.sin(a + 2.2) * R * 1.4)
          .arc(bx, by, R * 1.4, a + 2.2, a + Math.PI * 2 - 2.2, true)
          .stroke({ color: BLUE, width: 3, alpha: 0.5 * fade });
        g.circle(x, y, R * 1.2).fill({ color: BLUE, alpha: 0.12 * fade });
      }
    }

    // Launch / arrival flashes, left in the world where they happened
    this.flashes = this.flashes.filter((f) => (f.age += dt) < f.life);
    for (const f of this.flashes) {
      const k = f.age / f.life;
      const ease = 1 - (1 - k) ** 3;
      const ring = f.r * (f.big ? 2 + 14 * ease : 1.5 + 6 * ease);
      g.circle(f.x, f.y, ring).stroke({ color: BLUE, width: (f.big ? 10 : 5) * (1 - k), alpha: 0.8 * (1 - k) });
      g.circle(f.x, f.y, f.r * (f.big ? 3 : 1.6) * (1 - k * 0.5)).fill({ color: CORE, alpha: (f.big ? 0.7 : 0.4) * (1 - k) ** 2 });
      if (f.big) {
        // A streak pointing where the ship went
        const L = f.r * 30 * (1 - k);
        g.moveTo(f.x, f.y).lineTo(f.x + Math.cos(f.angle) * L, f.y + Math.sin(f.angle) * L)
          .stroke({ color: CORE, width: f.r * 0.5 * (1 - k), alpha: 0.6 * (1 - k) });
      }
    }

    for (const id of this.lastPhase.keys()) if (!this.ships.bodies.has(id)) this.lastPhase.delete(id);

    this.drawScreen(dt, localPhase, localAngle);
    this.drawHud(localPhase, opts);
  }

  /** The local pilot is mid-jump */
  localBurning(): boolean {
    return this.lastPhase.get(this.state.playerId) === 'burn';
  }

  private drawScreen(dt: number, ph: { phase: JumpPhase; progress: number } | null, angle: number): void {
    const on = this.screenEffects;
    const burn = on && ph?.phase === 'burn' ? 1 - Math.max(0, (ph.progress - 0.8) / 0.2) : 0;
    const charge = on && ph?.phase === 'charging' ? ph.progress : 0;
    this.screenBurn += (burn - this.screenBurn) * Math.min(1, dt * (burn > this.screenBurn ? 20 : 4));
    this.screenCharge += (charge - this.screenCharge) * Math.min(1, dt * 10);
    const ctx = this.ctx;
    const W = this.screen.width, H = this.screen.height;
    const idle = this.screenBurn < 0.01 && this.screenCharge < 0.01;
    // Idle and already blank: leave the canvas alone
    if (idle && !this.screenDrawn) return;
    ctx.clearRect(0, 0, W, H);
    this.screenDrawn = !idle;
    if (idle) { this.streaks = []; return; }

    // Spooling: the edges close in, tinted blue
    if (this.screenCharge > 0.01) {
      const grad = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * (0.5 - 0.2 * this.screenCharge), W / 2, H / 2, Math.max(W, H) * 0.75);
      grad.addColorStop(0, 'rgba(20, 50, 110, 0)');
      grad.addColorStop(1, `rgba(20, 60, 140, ${0.45 * this.screenCharge})`);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);
    }

    // Burn: stars streaking past, against the direction of travel
    if (this.screenBurn > 0.01) {
      const dx = -Math.cos(angle), dy = -Math.sin(angle);
      const target = Math.floor(140 * this.screenBurn);
      while (this.streaks.length < target) {
        this.streaks.push({ x: Math.random() * W, y: Math.random() * H, len: 80 + Math.random() * 320, speed: 2500 + Math.random() * 4000, w: 0.5 + Math.random() * 1.8 });
      }
      if (this.streaks.length > target) this.streaks.length = target;
      ctx.lineCap = 'round';
      for (const s of this.streaks) {
        s.x += dx * s.speed * dt;
        s.y += dy * s.speed * dt;
        if (s.x < -400 || s.x > W + 400 || s.y < -400 || s.y > H + 400) {
          // Re-enter from the side the ship is heading towards
          s.x = W / 2 - dx * (Math.max(W, H) * 0.6) + (Math.random() - 0.5) * W * 1.2 * Math.abs(dy) ;
          s.y = H / 2 - dy * (Math.max(W, H) * 0.6) + (Math.random() - 0.5) * H * 1.2 * Math.abs(dx);
          if (Math.abs(dx) > 0.3 && Math.abs(dy) > 0.3) { s.x += (Math.random() - 0.5) * W; s.y += (Math.random() - 0.5) * H; }
        }
        ctx.strokeStyle = `rgba(200, 230, 255, ${0.55 * this.screenBurn})`;
        ctx.lineWidth = s.w;
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(s.x - dx * s.len * this.screenBurn, s.y - dy * s.len * this.screenBurn);
        ctx.stroke();
      }
      // Blue-white rim
      const grad = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75);
      grad.addColorStop(0, 'rgba(120, 190, 255, 0)');
      grad.addColorStop(1, `rgba(120, 190, 255, ${0.25 * this.screenBurn})`);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);
    }
  }

  /** The local ship's cooldown (ticks), for the HUD */
  private localCooldown = 0;

  private drawHud(ph: { phase: JumpPhase; progress: number } | null, opts: { hidden: boolean; latched: boolean; aiming?: boolean; aimDist?: number; aimLabel?: string | null; reach?: number; field?: GaugeField; danger?: string | null }): void {
    if (!ph || opts.hidden) { if (this.hudShown) { this.hud.style.display = 'none'; this.hudShown = false; } return; }
    if (!this.hudShown) { this.hud.style.display = 'block'; this.hudShown = true; }
    const key = boundKeyName('jump', settings.data.bindings);
    const need = this.tuning.chargeTicks;
    let text: string, fill: number, color = '#9fd8ff';
    switch (ph.phase) {
      case 'ready':
        text = opts.latched ? 'JUMP DRIVE · ENGAGING' : `JUMP DRIVE READY · <kbd>${key}</kbd> · ${fmtK(opts.reach ?? 0)} range`;
        if (opts.aiming && opts.aimLabel) text += ` · ◎ ${opts.aimLabel}`;
        fill = 1;
        break;
      case 'charging':
        text = settings.data.gameplay.jumpMode === 'hold' ? 'SPOOLING · RELEASE TO ABORT' : `SPOOLING · <kbd>${key}</kbd> ABORT`;
        // (Charged, waiting for the nose to come round to the aim: flight.ts jumpAimed)
        if (ph.progress >= (need - 1) / need) text = text.replace('SPOOLING', 'CHARGED · ALIGNING');
        // (The time it has left: every jump charges the same, flight.ts jumpChargeNeed)
        else text = text.replace('SPOOLING', `SPOOLING · ${chargeSecs((1 - ph.progress) * need)}`);
        {
          const reach = opts.reach ?? 0, want = opts.aimDist || reach;
          const go = fmtK(Math.max(this.tuning.minRange, Math.min(reach, want)));
          text += opts.aimLabel
            ? (want > reach ? ` · ${go} towards ${opts.aimLabel} <span style="color:#fca5a5">(${fmtK(want)}: out of reach)</span>` : ` · → ${opts.aimLabel}`)
            : ` · ${go}`;
        }
        fill = ph.progress;
        color = '#e8f6ff';
        break;
      case 'burn':
        text = 'JUMPING';
        fill = 1 - ph.progress;
        color = '#ffffff';
        break;
      default: {
        const secs = Math.ceil(((1 - ph.progress) * (this.localCooldown || this.tuning.cooldownTicks)) / 60 / (1 + (opts.field?.charge ?? 0)));
        text = `JUMP DRIVE COOLING · ${secs}s · ${fmtK(opts.reach ?? 0)} range`;
        fill = ph.progress;
        color = '#6b7f99';
      }
    }
    const f = opts.field;
    if (f?.ring) text += ' · <span style="color:#fcd34d">☀ SOLAR CHARGE</span>';
    if (f?.lodestone) text += ` · <span style="color:#a3c2cf">◈ ${f.short.toUpperCase()} CHARGE</span>`;
    else if (f && f.primeSecs > 0 && ph.phase !== 'burn') text += ` · <span style="color:#a3c2cf">◈ PRIMED +${Math.round((f.boost - 1) * 100)}% · ${f.primeSecs}s</span>`;
    if (opts.aiming && opts.danger && (ph.phase === 'ready' || ph.phase === 'charging')) text += `<div style="color:#fca5a5; margin-top:3px">⚠ ${opts.danger}</div>`;
    // (Only what changed goes to the DOM: this runs every frame)
    if (text !== this.hudKey.text) { this.hudText.innerHTML = text; this.hudKey.text = text; }
    if (color !== this.hudKey.color) { this.hud.style.color = color; this.hudKey.color = color; }
    const width = `${(fill * 100).toFixed(1)}%`;
    if (width !== this.hudKey.width) { this.hudFill.style.width = width; this.hudKey.width = width; }
    const opacity = ph.phase === 'cooldown' ? '0.45' : '1';
    if (opacity !== this.hudKey.opacity) { this.hudFill.style.opacity = opacity; this.hudKey.opacity = opacity; }
  }
}

/** A distance with its unit, as the action menu writes it (input/contextClick.ts km) */
function fmtK(d: number): string {
  return d >= 1000 ? `${(d / 1000).toFixed(d >= 10000 ? 0 : 1)} km` : `${Math.round(d)} m`;
}

/** A charge time (ticks) as the HUD writes it: whole seconds, rounded up */
export function chargeSecs(ticks: number): string {
  return `${Math.max(1, Math.ceil(ticks / 60))}s`;
}
