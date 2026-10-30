/**
 * The quick bar: five item slots along the bottom of the screen. Drag an item
 * onto a slot (or pick "Put on quick bar" from its menu), then press 1-5 or
 * click it to use it. Right-click empties a slot. Counts are what you can use
 * right now: your hold, plus storage while you're at a station.
 *
 * Above it, a repair kit at work shows how much of its budget is left.
 */

import type { ClientMessage } from '@space-game/common';
import type { PilotState } from '../econ/clientEcon';
import { itemIcon } from './itemIcons';
import { itemTipHtml, showTip, hideTip, injectWindowStyles } from './windowKit';
import { boundKeyName } from '../input/keybindings';
import { settings } from '../settings/Settings';

export class QuickBar {
  private root: HTMLDivElement;
  private slots: HTMLDivElement[] = [];
  private kit: HTMLDivElement;
  private kitFill: HTMLElement;
  private kitText: HTMLElement;
  private visible = false;

  constructor(private pilot: PilotState, private send: (m: ClientMessage) => void, private sound: (id: string, v?: number) => void) {
    injectWindowStyles();
    const css = document.createElement('style');
    css.textContent = `
.qb-bar { position: fixed; left: 50%; bottom: 40px; transform: translateX(-50%); display: none; gap: 6px; z-index: 870; }
.qb-slot { position: relative; width: 46px; height: 46px; border-radius: 9px; background: rgba(8, 14, 26, 0.8); border: 1px solid rgba(120, 150, 200, 0.28);
  display: grid; place-items: center; cursor: pointer; transition: transform .08s, border-color .15s, background .15s; }
.qb-slot:hover { border-color: rgba(125, 211, 252, 0.6); background: rgba(14, 24, 44, 0.9); }
.qb-slot.drop { border-color: #7dd3fc; box-shadow: 0 0 0 2px rgba(125, 211, 252, 0.35); }
.qb-slot.flash { transform: scale(0.92); border-color: #86efac; }
.qb-slot img { width: 34px; height: 34px; pointer-events: none; }
.qb-slot.none img { opacity: 0.3; filter: grayscale(1); }
.qb-slot.none .n { color: #f0a0a0; opacity: 0.8; }
.qb-slot .k { position: absolute; left: 4px; top: 2px; font: 700 10px 'Segoe UI', sans-serif; color: #8394ad; }
.qb-slot .n { position: absolute; right: 4px; bottom: 1px; font: 700 11px 'Segoe UI', sans-serif; color: #fff; text-shadow: 0 1px 2px #000, 0 0 4px #000; }
.qb-kit { position: fixed; left: 50%; bottom: 94px; transform: translateX(-50%); width: 230px; display: none; z-index: 870; pointer-events: none;
  font: 600 10px 'Segoe UI', sans-serif; letter-spacing: 1.5px; color: #86efac; text-align: center; }
.qb-kit .t { height: 4px; border-radius: 2px; background: rgba(134, 239, 172, 0.15); margin-top: 3px; overflow: hidden; }
.qb-kit .t i { display: block; height: 100%; background: linear-gradient(90deg, #22c55e, #bbf7d0); transition: width .4s; }`;
    document.head.appendChild(css);
    this.root = document.createElement('div');
    this.root.className = 'qb-bar';
    this.root.dataset.hudAvoid = '1';
    for (let i = 0; i < 5; i++) {
      const el = document.createElement('div');
      el.className = 'qb-slot';
      el.onclick = () => this.use(i);
      el.oncontextmenu = (e) => { e.preventDefault(); hideTip(); this.send({ type: 'quickbarSet', slot: i, id: null }); };
      el.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('application/x-sg-item')) { e.preventDefault(); el.classList.add('drop'); } });
      el.addEventListener('dragleave', () => el.classList.remove('drop'));
      el.addEventListener('drop', (e) => {
        el.classList.remove('drop');
        const id = e.dataTransfer?.getData('application/x-sg-item');
        if (!id) return;
        e.preventDefault();
        this.send({ type: 'quickbarSet', slot: i, id });
        this.sound('ui_click', 0.5);
      });
      el.addEventListener('mousemove', (e) => {
        const id = this.pilot.profile?.quickbar?.[i];
        showTip(id ? itemTipHtml(this.pilot.econ, id, { count: this.count(id), hint: `${this.keyName(i)} or click to use · right-click to clear` }) : 'Empty slot: drag an item here from your cargo (I)', e.clientX, e.clientY);
      });
      el.addEventListener('mouseleave', hideTip);
      this.root.appendChild(el);
      this.slots.push(el);
    }
    this.kit = document.createElement('div');
    this.kit.className = 'qb-kit';
    this.kit.innerHTML = '<span></span><div class="t"><i></i></div>';
    this.kitText = this.kit.querySelector('span')!;
    this.kitFill = this.kit.querySelector('i')!;
    document.body.append(this.root, this.kit);
    pilot.onChange(() => this.render());
  }

  private keyName(i: number): string {
    return boundKeyName(`quick${i + 1}`, settings.data.bindings);
  }

  /** What you can use now: the hold, plus storage at a station */
  private count(id: string): number {
    const cargo = this.pilot.cargo.find((s) => s.id === id)?.n ?? 0;
    const stored = this.pilot.atStation ? this.pilot.storage.find((s) => s.id === id)?.n ?? 0 : 0;
    return cargo + stored;
  }

  use(i: number): void {
    const id = this.pilot.profile?.quickbar?.[i];
    if (!id) return;
    if (this.count(id) <= 0) { this.sound('error', 0.4); return; }
    this.send({ type: 'itemUse', id });
    const el = this.slots[i];
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 120);
  }

  /** A repair kit's progress (left 0 = done) */
  setKit(left: number, total: number): void {
    if (left <= 0 || total <= 0) { this.kit.style.display = 'none'; return; }
    this.kit.style.display = this.visible ? 'block' : 'none';
    this.kitText.textContent = `REPAIRING · HOLD STILL · ${left.toLocaleString()} / ${total.toLocaleString()} CR LEFT`;
    this.kitFill.style.width = `${(left / total) * 100}%`;
  }

  show(): void { this.visible = true; this.root.style.display = 'flex'; this.render(); }
  hide(): void { this.visible = false; this.root.style.display = 'none'; this.kit.style.display = 'none'; }

  private render(): void {
    if (!this.visible) return;
    const bar = this.pilot.profile?.quickbar ?? [];
    this.slots.forEach((el, i) => {
      const id = bar[i];
      const n = id ? this.count(id) : 0;
      el.classList.toggle('none', !!id && n <= 0);
      el.innerHTML = `<span class="k">${this.keyName(i)}</span>${id ? `<img src="${itemIcon(this.pilot.econ, id)}"><span class="n">${n}</span>` : ''}`;
    });
  }
}
