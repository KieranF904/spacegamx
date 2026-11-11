/**
 * @contract client.ui.status-tray
 * owns:       the row of status icons above the jump drive bar (its left end): an icon a status on now with its seconds left, gone when
 *             it ends, a tooltip on hover (what it does, what clears it)
 * needs:      statusEffects (the model), domWrite setText, windowKit showTip / hideTip
 * invariants: it shows exactly activeStatuses() (rebuilt only when that set changes; timers rewritten through domWrite) —
 *             client/src/ui/hud/statusEffects.test.ts
 * extend:     a new status is in statusEffects.ts; nothing here names one
 */

import { setText } from '../domWrite';
import { injectWindowStyles, showTip, hideTip } from '../windowKit';
import { activeStatuses, statusTip, type ActiveStatus, type StatusSource } from './statusEffects';

const CSS = `
/* Above the jump drive bar's left end, growing left (clear of the dock prompt and the laser charge bar over its middle) */
.sgst { position: fixed; right: calc(50% + 122px); bottom: 128px; display: none; flex-direction: row-reverse; gap: 6px; z-index: 880; pointer-events: auto; }
.sgst-ic { position: relative; width: 30px; height: 30px; border-radius: 8px; background: rgba(8, 14, 26, 0.88); border: 1px solid var(--c);
  display: flex; align-items: center; justify-content: center; color: var(--c); font: 700 15px 'Segoe UI', system-ui, sans-serif; cursor: default;
  box-shadow: 0 0 8px color-mix(in srgb, var(--c) 35%, transparent); }
.sgst-ic b { position: absolute; right: -3px; bottom: -6px; min-width: 14px; padding: 0 3px; border-radius: 6px; background: #0b1220;
  border: 1px solid var(--c); color: #e5ecf7; font: 700 9px 'Segoe UI', sans-serif; line-height: 12px; text-align: center; }
`;

export class StatusTray {
  private root: HTMLDivElement | null = null;
  private list: ActiveStatus[] = [];
  private shownKey = '';
  private timers: HTMLElement[] = [];

  private make(): HTMLDivElement {
    injectWindowStyles();
    const s = document.createElement('style');
    s.textContent = CSS;
    document.head.appendChild(s);
    const root = document.createElement('div');
    root.className = 'sgst';
    root.dataset.hudAvoid = '1';
    document.body.appendChild(root);
    return (this.root = root);
  }

  /** Each frame: `src` null hides it (no ship, a window over the HUD) */
  update(src: StatusSource | null): void {
    const list = src ? activeStatuses(src, this.list) : (this.list.length = 0, this.list);
    if (!list.length && !this.root) return;
    const root = this.root ?? this.make();
    const key = list.map((a) => a.def.id).join(',');
    if (key !== this.shownKey) {
      this.shownKey = key;
      root.replaceChildren();
      this.timers = [];
      for (let i = 0; i < list.length; i++) {
        const a = list[i];
        const d = document.createElement('div');
        d.className = 'sgst-ic';
        d.style.setProperty('--c', a.def.color);
        d.textContent = a.def.glyph;
        const t = document.createElement('b');
        d.appendChild(t);
        d.addEventListener('mousemove', (e) => {
          const cur = this.list.find((x) => x.def.id === a.def.id);
          if (cur) showTip(`<div style="white-space:pre-line">${statusTip(cur)}</div>`, e.clientX, e.clientY);
        });
        d.addEventListener('mouseleave', hideTip);
        root.appendChild(d);
        this.timers.push(t);
      }
      root.style.display = list.length ? 'flex' : 'none';
      if (!list.length) hideTip();
    }
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      setText(this.timers[i], a.secs !== null ? `${a.secs}` : `${a.pct}%`);
    }
  }
}
