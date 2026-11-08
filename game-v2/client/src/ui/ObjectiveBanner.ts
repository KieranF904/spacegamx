/**
 * Objective banners at the top of the screen: what's happening where you are
 * (a city under siege: the wave, raiders left, the pylons still standing).
 * The server sends `objective` (shown or updated by id) and `objectiveEnd`.
 * They belong to the system they arrived in: leave it and they go.
 */

import type { ServerObjectiveMessage } from '@space-game/common';
import { esc } from './escape';


let styled = false;
function injectStyles(): void {
  if (styled) return;
  styled = true;
  const css = document.createElement('style');
  css.textContent = `
.obj-wrap { position: fixed; top: 52px; left: 50%; transform: translateX(-50%); z-index: 900; display: flex; flex-direction: column; gap: 6px; pointer-events: none; }
.obj { min-width: 300px; max-width: min(460px, calc(100vw - 32px)); padding: 8px 14px 10px; border-radius: 10px; text-align: center;
  background: linear-gradient(180deg, rgba(14, 22, 40, 0.9), rgba(7, 12, 24, 0.9)); border: 1px solid rgba(125, 211, 252, 0.35);
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.4); color: #d6deeb; font: 12px 'Segoe UI', system-ui, sans-serif; animation: objIn 0.25s ease-out; }
.obj.danger { border-color: rgba(248, 113, 113, 0.6); box-shadow: 0 8px 30px rgba(0, 0, 0, 0.4), 0 0 18px rgba(248, 113, 113, 0.18); }
.obj-t { font: 700 11px 'Segoe UI', sans-serif; letter-spacing: 3px; text-transform: uppercase; color: #7dd3fc; }
.obj.danger .obj-t { color: #fca5a5; }
.obj-x { margin-top: 3px; font-size: 13px; color: #eef3fa; }
.obj-m { margin-top: 6px; display: flex; align-items: center; gap: 8px; font-size: 11px; color: #8fa0b8; }
.obj-bar { flex: 1; height: 6px; border-radius: 3px; background: rgba(255, 255, 255, 0.08); overflow: hidden; }
.obj-bar > i { display: block; height: 100%; background: linear-gradient(90deg, #38bdf8, #7dd3fc); transition: width 0.3s; }
.obj.danger .obj-bar > i { background: linear-gradient(90deg, #f87171, #fbbf24); }
@keyframes objIn { from { opacity: 0; transform: translateY(-6px); } }
@media (prefers-reduced-motion: reduce) { .obj { animation: none; } }
`;
  document.head.appendChild(css);
}

export class ObjectiveBanner {
  private wrap = document.createElement('div');
  private items = new Map<string, { el: HTMLElement; system: string; at?: { x: number; y: number }; title: string }>();

  constructor() {
    injectStyles();
    this.wrap.className = 'obj-wrap';
    document.body.appendChild(this.wrap);
  }

  show(msg: ServerObjectiveMessage, system: string): void {
    let it = this.items.get(msg.id);
    if (!it) {
      const el = document.createElement('div');
      this.wrap.appendChild(el);
      it = { el, system, title: msg.title };
      this.items.set(msg.id, it);
    }
    it.system = system;
    it.at = msg.at;
    it.title = msg.title;
    it.el.className = 'obj' + (msg.danger ? ' danger' : '');
    const m = msg.meter;
    it.el.innerHTML = `<div class="obj-t">${esc(msg.title)}</div><div class="obj-x">${esc(msg.text)}</div>`
      + (m ? `<div class="obj-m"><span>${esc(m.label)}</span><div class="obj-bar"><i style="width:${Math.round((100 * m.value) / Math.max(1, m.max))}%"></i></div><span>${m.value}/${m.max}</span></div>` : '');
  }

  end(id: string): void {
    this.items.get(id)?.el.remove();
    this.items.delete(id);
  }

  /** Each frame: banners for other systems go */
  update(system: string): void {
    for (const [id, it] of this.items) if (it.system !== system) this.end(id);
  }

  /** Where the objectives here are (nav markers) */
  markers(system: string): { name: string; x: number; y: number; system: string }[] {
    return [...this.items.values()].filter((i) => i.system === system && i.at).map((i) => ({ name: i.title, x: i.at!.x, y: i.at!.y, system }));
  }

  clear(): void {
    for (const id of [...this.items.keys()]) this.end(id);
  }
}
