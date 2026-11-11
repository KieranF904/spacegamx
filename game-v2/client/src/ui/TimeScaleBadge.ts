/**
 * The time-scale badge (CAPS.CROWD; common network/crowd.ts): while the system is slowed (time dilation in a crowd), a
 * small "TIME ×0.50" under the top edge, the level's other fallbacks in its tooltip. Hidden otherwise.
 */
import { TICK_RATE } from '@space-game/common';

export class TimeScaleBadge {
  private el: HTMLDivElement;
  private shown = '';

  constructor(parent: HTMLElement = document.body) {
    const el = (this.el = document.createElement('div'));
    el.hidden = true;
    Object.assign(el.style, {
      position: 'fixed', top: 'calc(env(safe-area-inset-top, 0px) + 8px)', left: '50%', transform: 'translateX(-50%)',
      padding: '2px 8px', borderRadius: '4px', font: '600 11px/16px system-ui, sans-serif', letterSpacing: '0.06em',
      color: '#fde68a', background: 'rgba(30, 24, 8, 0.72)', border: '1px solid rgba(253, 230, 138, 0.35)',
      pointerEvents: 'auto', zIndex: '40', userSelect: 'none',
    } satisfies Partial<CSSStyleDeclaration>);
    parent.appendChild(el);
  }

  /** Each frame: its system's crowd level as last told */
  update(c: { lv: number; focus: number; window: number; rate: number }): void {
    const key = c.rate < TICK_RATE ? `${c.lv}:${c.rate}:${c.window}:${c.focus}` : '';
    if (key === this.shown) return;
    this.shown = key;
    this.el.hidden = !key;
    if (!key) return;
    this.el.textContent = `TIME ×${(c.rate / TICK_RATE).toFixed(2)}`;
    this.el.title = `This system is crowded, so time runs slower here. Ships are shown in full within ${c.focus / 1000} km, and updates come less often.`;
  }

  destroy(): void {
    this.el.remove();
  }
}
