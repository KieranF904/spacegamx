/**
 * A moon siege's night HUD (server: sieges/), at the top under the banner from
 * dusk to dawn: the bastion's hull as a big bar (it flashes when it's hit, red
 * in the last stand), hostiles left, the next front's countdown and which way
 * it's coming, and whether the turrets' focus fire is ready.
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
.snh-bar > i { position: absolute; inset: 0 auto 0 0; background: linear-gradient(90deg, #f87171, #fbbf24); transition: width 0.25s; }
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
@media (prefers-reduced-motion: reduce) { .snh.hit .snh-bar, .snh.breach .snh-bar { animation: none; } }
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
  private msg: ServerSiegeStateMessage | null = null;
  private hull = -1;
  private timer = 0;

  constructor(private tick: () => number, private bastion: () => { x: number; y: number } | null, private focusKey: () => string) {
    injectStyles();
    this.el.className = 'snh';
    this.el.innerHTML = '<div class="snh-bar"><i></i><b></b></div><div class="snh-row"><span class="l"></span><span class="w"></span><span class="f"></span></div>';
    this.bar = this.el.querySelector('.snh-bar > i')!;
    this.label = this.el.querySelector('.snh-bar > b')!;
    this.left = this.el.querySelector('.l')!;
    this.next = this.el.querySelector('.w')!;
    this.focus = this.el.querySelector('.f')!;
    document.body.appendChild(this.el);
  }

  update(m: ServerSiegeStateMessage | null): void {
    const on = !!m && m.active && (m.phase === 'dusk' || m.phase === 'night');
    this.el.classList.toggle('on', on);
    if (!on) { this.msg = null; this.hull = -1; clearInterval(this.timer); this.timer = 0; return; }
    this.msg = m;
    const hull = m!.bastion ?? 100;
    if (this.hull >= 0 && hull < this.hull) {
      this.el.classList.remove('hit');
      void this.el.offsetWidth;
      this.el.classList.add('hit');
    }
    this.hull = hull;
    this.el.classList.toggle('breach', !!m!.breach);
    this.bar.style.width = `${Math.max(0, Math.min(100, hull))}%`;
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
    if (f) {
      const secs = Math.max(0, Math.ceil((f.at - now) / 60));
      const way = b ? ` from the ${compass(f.x - b.x, f.y - b.y)}` : '';
      this.next.textContent = `${f.boss ? 'Boss front' : 'Front'}${way} in ${secs}s`;
    } else this.next.textContent = m.phase === 'dusk' ? 'Night is falling' : '';
    const fo = m.focus;
    const key = this.focusKey();
    if (!fo) this.focus.textContent = '';
    else if (fo.target !== undefined && (fo.until ?? 0) > now) this.focus.textContent = `Turrets focused · ${Math.ceil(((fo.until ?? 0) - now) / 60)}s`;
    else if (fo.readyAt > now) this.focus.textContent = `Focus fire in ${Math.ceil((fo.readyAt - now) / 60)}s`;
    else this.focus.textContent = `${key}: turrets focus your target`;
    this.focus.classList.toggle('off', !!fo && fo.readyAt > now && !(fo.target !== undefined && (fo.until ?? 0) > now));
  }
}
