/**
 * A moon siege's night HUD (server: sieges/), at the top under the banner from
 * dusk to dawn: the bastion's hull as a big bar (it flashes when it's hit, the
 * hull just lost trailing off in white; a tick where the last stand starts;
 * red in the last stand), hostiles left, the next front's countdown and which
 * way it's coming (pulsing in its last five seconds, then "landed" a moment),
 * and whether the turrets' focus fire is ready. The screen's edges glow red a
 * moment when the bastion is hit, and throb faintly in the last stand.
 */

import type { ServerSiegeStateMessage } from '@space-game/common';
import { compass } from './compass';

let styled = false;
function injectStyles(): void {
  if (styled) return;
  styled = true;
  const css = document.createElement('style');
  css.textContent = `
.snh { position: fixed; top: 136px; left: 50%; transform: translateX(-50%); z-index: 899; width: min(420px, calc(100vw - 32px)); display: none;
  pointer-events: none; font: 12px 'Segoe UI', system-ui, sans-serif; color: #d6deeb; text-shadow: 0 1px 2px #000; }
.snh.on { display: block; }
.snh-bar { position: relative; height: 14px; border-radius: 7px; background: rgba(8, 12, 22, 0.78); border: 1px solid rgba(248, 113, 113, 0.45); overflow: hidden;
  box-shadow: 0 4px 18px rgba(0,0,0,0.45); }
.snh-bar > u { position: absolute; inset: 0 auto 0 0; background: rgba(255, 255, 255, 0.75); transition: width 0.6s ease-in 0.45s; }
.snh-bar > i { position: absolute; inset: 0 auto 0 0; background: linear-gradient(90deg, #f87171, #fbbf24); transition: width 0.25s;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.35); }
.snh-bar > s { position: absolute; top: 0; bottom: 0; left: 30%; width: 2px; background: rgba(255, 255, 255, 0.35); }
.snh-row .w.soon { animation: snhSoon 0.5s ease-in-out infinite alternate; }
.snh-row .w.landed { color: #fff; }
.snh-vig { position: fixed; inset: 0; z-index: 898; pointer-events: none; opacity: 0; will-change: opacity;
  background: radial-gradient(ellipse at center, rgba(239, 68, 68, 0) 58%, rgba(239, 68, 68, 0.22) 80%, rgba(239, 68, 68, 0.5) 100%); }
.snh-vig.hit { animation: snhVig 0.7s ease-out; }
.snh-vig.breach:not(.hit) { animation: snhVigBreach 1.6s ease-in-out infinite; }
@keyframes snhVig { 0% { opacity: 0.9; } 100% { opacity: 0; } }
@keyframes snhVigBreach { 50% { opacity: 0.35; } }
@keyframes snhSoon { to { color: #fff; text-shadow: 0 0 10px rgba(248, 113, 113, 0.9), 0 1px 2px #000; } }
.snh-bar > b { position: absolute; inset: 0; text-align: center; font: 700 10px/14px 'Segoe UI', sans-serif; letter-spacing: 2px; color: #fff; }
.snh.hit .snh-bar { animation: snhHit 0.35s ease-out; }
.snh.breach .snh-bar { border-color: #ef4444; animation: snhBreach 1s ease-in-out infinite; }
.snh.breach .snh-bar > i { background: linear-gradient(90deg, #dc2626, #f87171); }
.snh-row { display: flex; justify-content: space-between; gap: 10px; margin-top: 4px; font-size: 11.5px; color: #c8d3e3; }
.snh-row .w { color: #fca5a5; font-weight: 600; }
.snh-row .f { color: #7dd3fc; }
.snh-row .f.off { color: #8394ad; }
@keyframes snhHit { 0% { box-shadow: 0 0 0 2px rgba(248,113,113,0.9), 0 0 22px rgba(248,113,113,0.7); } 100% { box-shadow: 0 4px 18px rgba(0,0,0,0.45); } }
@keyframes snhBreach { 50% { box-shadow: 0 0 16px rgba(239, 68, 68, 0.75); } }
@media (prefers-reduced-motion: reduce) { .snh.hit .snh-bar, .snh.breach .snh-bar, .snh-row .w.soon, .snh-vig.hit, .snh-vig.breach { animation: none; } }
`;
  document.head.appendChild(css);
}

export class NightHud {
  private el = document.createElement('div');
  private bar: HTMLElement;
  private label: HTMLElement;
  private left: HTMLElement;
  private next: HTMLElement;
  private focus: HTMLElement;
  private ghost: HTMLElement;
  private vig = document.createElement('div');
  private msg: ServerSiegeStateMessage | null = null;
  private hull = -1;
  /** The last front seen landing (its tick), and until when (wall ms) to say so */
  private landed: { at: number; until: number; text: string } | null = null;
  private timer = 0;

  constructor(private tick: () => number, private bastion: () => { x: number; y: number } | null, private focusKey: () => string) {
    injectStyles();
    this.el.className = 'snh';
    this.el.innerHTML = '<div class="snh-bar"><u></u><i></i><s></s><b></b></div><div class="snh-row"><span class="l"></span><span class="w"></span><span class="f"></span></div>';
    this.bar = this.el.querySelector('.snh-bar > i')!;
    this.ghost = this.el.querySelector('.snh-bar > u')!;
    this.vig.className = 'snh-vig';
    this.vig.addEventListener('animationend', () => this.vig.classList.remove('hit'));
    document.body.appendChild(this.vig);
    this.label = this.el.querySelector('.snh-bar > b')!;
    this.left = this.el.querySelector('.l')!;
    this.next = this.el.querySelector('.w')!;
    this.focus = this.el.querySelector('.f')!;
    document.body.appendChild(this.el);
  }

  update(m: ServerSiegeStateMessage | null): void {
    const on = !!m && m.active && (m.phase === 'dusk' || m.phase === 'night');
    this.el.classList.toggle('on', on);
    if (!on) { this.msg = null; this.hull = -1; this.landed = null; this.vig.classList.remove('hit', 'breach'); clearInterval(this.timer); this.timer = 0; return; }
    this.msg = m;
    const hull = m!.bastion ?? 100;
    if (this.hull >= 0 && hull < this.hull) {
      for (const e of [this.el, this.vig]) { e.classList.remove('hit'); void e.offsetWidth; e.classList.add('hit'); }
    }
    this.hull = hull;
    this.el.classList.toggle('breach', !!m!.breach);
    this.vig.classList.toggle('breach', !!m!.breach);
    const w = `${Math.max(0, Math.min(100, hull))}%`;
    this.bar.style.width = w;
    this.ghost.style.width = w;
    this.label.textContent = m!.breach ? `LAST STAND · BASTION ${hull}%` : `BASTION ${hull}%`;
    const left = m!.left ?? 0;
    this.left.textContent = `${left} hostile${left === 1 ? '' : 's'} left`;
    if (!this.timer) this.timer = window.setInterval(() => this.countdowns(), 250);
    this.countdowns();
  }

  /** The next front's countdown and the focus fire's: every quarter second */
  private countdowns(): void {
    const m = this.msg;
    if (!m) return;
    const now = this.tick();
    const f = (m.incoming ?? []).find((x) => x.at > now);
    const b = this.bastion();
    const way = (x: { x: number; y: number }) => (b ? ` from the ${compass(x.x - b.x, x.y - b.y)}` : '');
    // A front just come down: say so a moment
    const down = [...(m.incoming ?? [])].reverse().find((x) => x.at <= now && now - x.at < 4 * 60);
    if (down && this.landed?.at !== down.at) this.landed = { at: down.at, until: performance.now() + 2500, text: `${down.boss ? 'Boss front' : 'Front'} landed${way(down)}` };
    const landed = this.landed && performance.now() < this.landed.until ? this.landed.text : '';
    this.next.classList.toggle('landed', !!landed);
    if (landed) {
      this.next.textContent = landed;
      this.next.classList.remove('soon');
    } else if (f) {
      const secs = Math.max(0, Math.ceil((f.at - now) / 60));
      this.next.textContent = `${f.boss ? 'Boss front' : 'Front'}${way(f)} in ${secs}s`;
      this.next.classList.toggle('soon', secs <= 5);
    } else {
      this.next.textContent = m.phase === 'dusk' ? 'Night is falling' : '';
      this.next.classList.remove('soon');
    }
    const fo = m.focus;
    const key = this.focusKey();
    if (!fo) this.focus.textContent = '';
    else if (fo.target !== undefined && (fo.until ?? 0) > now) this.focus.textContent = `Turrets focused · ${Math.ceil(((fo.until ?? 0) - now) / 60)}s`;
    else if (fo.readyAt > now) this.focus.textContent = `Focus fire in ${Math.ceil((fo.readyAt - now) / 60)}s`;
    else this.focus.textContent = `${key}: turrets focus your target`;
    this.focus.classList.toggle('off', !!fo && fo.readyAt > now && !(fo.target !== undefined && (fo.until ?? 0) > now));
  }
}
