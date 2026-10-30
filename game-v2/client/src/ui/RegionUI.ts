/**
 * Where you are and where a gate goes, in flight:
 *   banner  crossing into another danger band of a system (Inner Sol is safe,
 *           the Reaches hostile): its name, what that means, and its threat
 *           against your ship
 *   gate    near a jump gate or rift: where it takes you, what it's like
 *           there against your ship, what it needs (a licence), and how to
 *           use it. The first time you'd jump somewhere that outclasses your
 *           ship, the interact key asks twice.
 */

import { regionAt, threatLevel, type StarSystemData, type SystemRegionData } from '@space-game/common';
import { threatTag } from './threat';

const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export const REGION_COLOR: Record<SystemRegionData['danger'], string> = { safe: '#5eead4', contested: '#fbbf24', hostile: '#f87171' };
const REGION_WORD: Record<SystemRegionData['danger'], string> = { safe: 'Safe space', contested: 'Contested', hostile: 'Hostile' };

/** A gate (or rift) within this of you shows its card */
const GATE_CARD_RANGE = 3200;
/** Systems you've said yes to jumping into although they outclass your ship */
const CONFIRMED_KEY = 'sg.gateConfirmed';

export interface RegionContext {
  sys: StarSystemData;
  x: number;
  y: number;
  /** Your ship's rating (0: none) */
  rating: number;
  threats: Record<string, number>;
  regionThreats: Record<string, Record<string, number>>;
  system(id: string): StarSystemData | undefined;
  /** Why you can't go there yet (a licence), or null */
  locked(id: string): { name: string; hint: string } | null;
  interactKey: string;
}

let styled = false;
function injectStyles(): void {
  if (styled) return;
  styled = true;
  const css = document.createElement('style');
  css.textContent = `
.rg-banner { position: fixed; top: 118px; left: 50%; transform: translateX(-50%); z-index: 880; pointer-events: none; text-align: center;
  font: 12px 'Segoe UI', system-ui, sans-serif; color: #d6deeb; opacity: 0; transition: opacity 0.6s; max-width: calc(100vw - 32px); }
.rg-banner.on { opacity: 1; }
.rg-banner .rg-k { font: 600 10px 'Segoe UI', sans-serif; letter-spacing: 4px; text-transform: uppercase; }
.rg-banner .rg-n { margin-top: 2px; font: 300 20px 'Segoe UI', sans-serif; letter-spacing: 6px; text-transform: uppercase; color: #eef3fa; text-shadow: 0 2px 18px rgba(0,0,0,0.8); }
.rg-banner .rg-d { margin-top: 6px; color: #aeb9cc; text-shadow: 0 1px 8px rgba(0,0,0,0.9); }
.rg-banner .rg-t { margin-top: 4px; font-size: 11px; }
.rg-gate { position: fixed; left: 50%; bottom: 170px; transform: translateX(-50%); z-index: 890; pointer-events: none; display: none;
  width: min(380px, calc(100vw - 32px)); padding: 9px 13px 10px; border-radius: 10px;
  background: linear-gradient(180deg, rgba(14, 22, 40, 0.92), rgba(7, 12, 24, 0.92)); border: 1px solid rgba(125, 211, 252, 0.35);
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.45); color: #c9d4e5; font: 12px 'Segoe UI', system-ui, sans-serif; line-height: 1.45; }
.rg-gate.warn { border-color: rgba(248, 113, 113, 0.6); }
.rg-gate .rg-k { font: 600 10px 'Segoe UI', sans-serif; letter-spacing: 3px; text-transform: uppercase; color: #7dd3fc; }
.rg-gate.warn .rg-k { color: #fca5a5; }
.rg-gate .rg-n { font: 600 15px 'Segoe UI', sans-serif; color: #eef3fa; margin: 2px 0 3px; }
.rg-gate .rg-d { color: #9fadc2; }
.rg-gate .rg-r { margin-top: 5px; }
.rg-gate .rg-u { margin-top: 6px; padding-top: 6px; border-top: 1px solid rgba(140, 170, 220, 0.15); color: #e2e8f0; }
.rg-gate kbd { padding: 0 5px; border: 1px solid rgba(160, 190, 230, 0.5); border-radius: 3px; font: 600 11px 'Segoe UI', sans-serif; }
@media (prefers-reduced-motion: reduce) { .rg-banner { transition: none; } }
`;
  document.head.appendChild(css);
}

export class RegionUI {
  private banner = document.createElement('div');
  private gate = document.createElement('div');
  private region: string | null = null;
  private system: string | null = null;
  private bannerTimer = 0;
  private gateKey = '';
  /** The gate the card is about (for the interact key) */
  private near: { target: string; rift: boolean; risky: boolean } | null = null;
  /** Asked once already: the next press goes through */
  private asked: string | null = null;
  private hidden = false;

  constructor() {
    injectStyles();
    this.banner.className = 'rg-banner';
    this.gate.className = 'rg-gate';
    document.body.append(this.banner, this.gate);
  }

  setHidden(h: boolean): void {
    this.hidden = h;
    if (h) { this.gate.style.display = 'none'; this.banner.classList.remove('on'); }
  }

  /** The band you're in (null: the system has none) */
  current(ctx: RegionContext): SystemRegionData | null {
    return regionAt(ctx.sys, ctx.x, ctx.y);
  }

  update(ctx: RegionContext): void {
    if (this.hidden) return;
    this.updateBanner(ctx);
    this.updateGate(ctx);
  }

  /**
   * The interact key was pressed: false holds it back (the first time you'd
   * jump into a system that outclasses you, it asks first).
   */
  allowInteract(): boolean {
    const n = this.near;
    if (!n || n.rift || !n.risky || this.confirmed().includes(n.target)) return true;
    if (this.asked === n.target) {
      this.asked = null;
      try { localStorage.setItem(CONFIRMED_KEY, JSON.stringify([...this.confirmed(), n.target])); } catch { /* (private window: it asks again next time) */ }
      return true;
    }
    this.asked = n.target;
    this.gateKey = '';
    return false;
  }

  private confirmed(): string[] {
    try { return JSON.parse(localStorage.getItem(CONFIRMED_KEY) ?? '[]') as string[]; } catch { return []; }
  }

  private updateBanner(ctx: RegionContext): void {
    const g = this.current(ctx);
    const id = g?.id ?? null;
    const sysChanged = ctx.sys.id !== this.system;
    if (sysChanged) { this.system = ctx.sys.id; this.region = id; }
    if (id !== this.region || (sysChanged && g)) {
      this.region = id;
      if (g) this.showBanner(ctx, g);
    }
    if (this.bannerTimer && performance.now() > this.bannerTimer) { this.banner.classList.remove('on'); this.bannerTimer = 0; }
  }

  private showBanner(ctx: RegionContext, g: SystemRegionData): void {
    const col = REGION_COLOR[g.danger];
    const threat = ctx.regionThreats[ctx.sys.id]?.[g.id];
    this.banner.innerHTML = `<div class="rg-k" style="color:${col}">${g.danger === 'safe' ? '◈' : g.danger === 'hostile' ? '⚠' : '◆'} ${REGION_WORD[g.danger]}</div>`
      + `<div class="rg-n">${esc(g.name)}</div>`
      + (g.description ? `<div class="rg-d">${esc(g.description)}</div>` : '')
      + (threat ? `<div class="rg-t">${threatTag(ctx.rating, threat)}${ctx.rating ? ` <span style="color:#56657c">vs your</span> <span style="color:#7dd3fc">◆ ${Math.round(ctx.rating)}</span>` : ''}</div>` : '');
    this.banner.classList.add('on');
    this.bannerTimer = performance.now() + 4000;
  }

  private updateGate(ctx: RegionContext): void {
    let best: { target: string; x: number; y: number; rift: boolean; d: number } | null = null;
    for (const p of ctx.sys.portals ?? []) {
      const d = Math.hypot(p.position.x - ctx.x, p.position.y - ctx.y);
      if (d < GATE_CARD_RANGE && (!best || d < best.d)) best = { target: p.targetSystem, x: p.position.x, y: p.position.y, rift: false, d };
    }
    for (const r of ctx.sys.rifts ?? []) {
      const d = Math.hypot(r.position.x - ctx.x, r.position.y - ctx.y);
      if (d < GATE_CARD_RANGE && (!best || d < best.d)) best = { target: r.destination.system, x: r.position.x, y: r.position.y, rift: true, d };
    }
    const to = best && ctx.system(best.target);
    if (!best || !to || to.private) {
      this.near = null;
      this.asked = null;
      if (this.gateKey) { this.gate.style.display = 'none'; this.gateKey = ''; }
      return;
    }
    const threat = ctx.threats[to.id];
    const level = threat && ctx.rating ? threatLevel(ctx.rating, threat) : null;
    // (Asked about first: a system that would be deadly; shown in red: a hard one too)
    const risky = level === 'deadly';
    const lock = ctx.locked(to.id);
    this.near = { target: to.id, rift: best.rift, risky: risky && !lock };
    if (this.asked && this.asked !== to.id) this.asked = null;
    const key = `${to.id}|${Math.round(ctx.rating)}|${threat}|${!!lock}|${this.asked}|${ctx.interactKey}`;
    if (key === this.gateKey) return;
    this.gateKey = key;
    const bands = to.regions?.length ? to.regions.map((g) => `<span style="color:${REGION_COLOR[g.danger]}">${esc(g.name)}</span>`).join(' · ') : '';
    const how = best.rift
      ? 'A rift: fly into it and it pulls you through. There is no way to stop halfway.'
      : lock ? `<span style="color:#fca5a5">🔒 ${esc(lock.name)}</span>: ${esc(lock.hint)}`
      : this.asked === to.id ? `<span style="color:#fca5a5">This system outclasses your ship.</span> Press <kbd>${esc(ctx.interactKey)}</kbd> again to jump anyway.`
      : `Fly into the gate and press <kbd>${esc(ctx.interactKey)}</kbd> to jump.`;
    this.gate.className = 'rg-gate' + (level === 'deadly' || level === 'hard' || this.asked === to.id ? ' warn' : '');
    this.gate.innerHTML = `<div class="rg-k">${best.rift ? 'Rift' : 'Jump gate'} to</div>`
      + `<div class="rg-n">${esc(to.name.replace(/ System$/, ''))}</div>`
      + `<div class="rg-d">${esc(to.description ?? '')}</div>`
      + (bands ? `<div class="rg-r" style="font-size:11px">${bands}</div>` : '')
      + `<div class="rg-r">${threat ? threatTag(ctx.rating, threat) : '<span style="color:#8394ad">No hostiles rated</span>'}${ctx.rating ? ` <span style="color:#56657c">vs your</span> <span style="color:#7dd3fc">◆ ${Math.round(ctx.rating)}</span>` : ''}</div>`
      + `<div class="rg-u">${how}</div>`;
    this.gate.style.display = 'block';
  }
}
