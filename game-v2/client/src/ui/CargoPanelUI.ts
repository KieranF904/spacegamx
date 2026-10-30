/**
 * The hold at a glance, always on, just above the chat: each stack's icon,
 * count and name, and how full the hold is. Outside safe space the secure
 * hold's stacks (what a death there keeps: common econ/stacks.ts secureHold)
 * carry a lock. New arrivals flash; hovering shows the item and its value;
 * right-click jettisons. Your ammunition loadout's crates are tagged LOAD and
 * utility (consumables, the quick bar) UTIL: the storage controls leave both
 * aboard. A fixed height that scrolls (drag the top edge to resize; it keeps
 * clear of the pilot readout above), or folds down to just the fill bar.
 * Hidden while docked (the station's storage screen has the hold then); I
 * opens the full window.
 */

import { RARITY_COLOR, secureHold, type ClientMessage, type Stack } from '@space-game/common';
import type { PilotState } from '../econ/clientEcon';
import { injectWindowStyles, itemTipHtml, showTip, hideTip, openMenu, closeMenu, sortStacks } from './windowKit';
import { itemIcon } from './itemIcons';
import { holdTag } from './storeControls';

const FOLD_KEY = 'sg.cargoPanel.collapsed';
const HEIGHT_KEY = 'sg.cargoPanel.height';
/** The list's height until the pilot drags it (about nine rows of two), and the least it shrinks to */
const DEFAULT_H = 200;
const MIN_H = 44;
const LOCK = '<svg viewBox="0 0 10 12" width="9" height="11"><rect x="1" y="5" width="8" height="6.5" rx="1.2" fill="#fcd34d"/><path d="M2.9 5V3.6a2.1 2.1 0 0 1 4.2 0V5" fill="none" stroke="#fcd34d" stroke-width="1.4"/></svg>';

let styled = false;
function injectStyles(): void {
  if (styled) return;
  styled = true;
  const css = document.createElement('style');
  css.textContent = `
.sgc { position: fixed; left: 16px; width: 320px; z-index: 850; box-sizing: border-box; padding: 6px 8px 7px; display: none;
  background: rgba(8, 14, 26, 0.78); border: 1px solid rgba(120, 150, 200, 0.22); border-radius: 10px;
  color: #c9d4e5; font: 12px 'Segoe UI', system-ui, sans-serif; user-select: none; }
.sgc-head { display: flex; align-items: baseline; gap: 8px; cursor: pointer; }
.sgc-head b { font: 700 10px 'Segoe UI', sans-serif; letter-spacing: 2px; color: #7dd3fc; }
.sgc-head .f { margin-left: auto; color: #8394ad; }
.sgc-head .tg { color: #56657c; font-size: 10px; width: 10px; }
.sgc .sgw-bar { margin: 4px 0 0; height: 4px; }
.sgc-grip { position: absolute; left: 10px; right: 10px; top: -4px; height: 8px; cursor: ns-resize; }
.sgc-grip::after { content: ''; position: absolute; left: 50%; top: 3px; width: 34px; margin-left: -17px; height: 2px; border-radius: 1px; background: rgba(125, 160, 210, 0); transition: background .15s; }
.sgc:hover .sgc-grip::after, .sgc-grip.drag::after { background: rgba(125, 160, 210, 0.45); }
.sgc.folded .sgc-grip { display: none; }
.sgc-grid { display: grid; grid-template-columns: 1fr 1fr; grid-auto-rows: 22px; align-content: start; gap: 2px 8px; margin-top: 6px; height: ${DEFAULT_H}px; overflow-y: auto;
  padding-right: 2px; scrollbar-width: thin; scrollbar-color: rgba(125, 160, 210, 0.35) transparent; }
.sgc-grid::-webkit-scrollbar { width: 6px; }
.sgc-grid::-webkit-scrollbar-thumb { background: rgba(125, 160, 210, 0.35); border-radius: 3px; }
.sgc-grid::-webkit-scrollbar-thumb:hover { background: rgba(125, 211, 252, 0.55); }
.sgc-grid::-webkit-scrollbar-track { background: transparent; }
.sgc-it .tag { flex-shrink: 0; font: 700 8.5px 'Segoe UI', sans-serif; letter-spacing: .5px; padding: 1px 3px; border-radius: 3px; }
.sgc-it .tag.load { color: #5eead4; background: rgba(94, 234, 212, 0.12); }
.sgc-it .tag.util { color: #c4b5fd; background: rgba(196, 181, 253, 0.12); }
.sgc.folded .sgc-grid { display: none; }
.sgc-it { display: flex; align-items: center; gap: 5px; padding: 1px 4px; border-radius: 5px; min-width: 0; cursor: default; }
.sgc-it:hover { background: rgba(125, 211, 252, 0.09); }
.sgc-it img { width: 18px; height: 18px; flex-shrink: 0; }
.sgc-it .nm { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0; }
.sgc-it .n { color: #e5ecf7; font-weight: 600; }
.sgc-it svg { flex-shrink: 0; }
.sgc-it.new { animation: sgcNew 1.4s ease-out; }
@keyframes sgcNew { 0%, 25% { background: rgba(134, 239, 172, 0.32); box-shadow: inset 0 0 0 1px rgba(134, 239, 172, 0.6); } }
@media (prefers-reduced-motion: reduce) { .sgc-it.new { animation: none; background: rgba(134, 239, 172, 0.15); } }
.sgc-empty { grid-column: 1 / -1; color: #56657c; padding: 2px 4px; }
`;
  document.head.appendChild(css);
}

export class CargoPanelUI {
  private root: HTMLDivElement;
  private fill: HTMLSpanElement;
  private bar: HTMLElement;
  private toggle: HTMLSpanElement;
  private grid: HTMLDivElement;
  private collapsed = false;
  private hidden = true;
  /** Outside safe space (the locks show) */
  private exposed = false;
  /** Counts as last drawn, to flash what's new (null: nothing drawn yet) */
  private seen: Map<string, number> | null = null;
  private key = '';
  /** The list's height as the pilot left it (px), and when its fit was last checked */
  private want = DEFAULT_H;
  private placedAt = 0;
  /** The bottom of whatever sits above it in the left column (the pilot readout), so it never grows into it */
  ceiling?: () => number;

  constructor(private pilot: PilotState, private send: (m: ClientMessage) => void, private sound: (id: string) => void) {
    injectWindowStyles();
    injectStyles();
    try {
      this.collapsed = localStorage.getItem(FOLD_KEY) === '1';
      const h = Number(localStorage.getItem(HEIGHT_KEY));
      if (h >= MIN_H) this.want = h;
    } catch { /* no storage */ }
    this.root = document.createElement('div');
    this.root.className = 'sgc';
    this.root.dataset.hudAvoid = '1';
    this.root.innerHTML = `<div class="sgc-grip" title="Drag to resize"></div><div class="sgc-head" title="Click to fold · I: full inventory"><span class="tg"></span><b>CARGO</b><span class="f"></span></div>
      <div class="sgw-bar"><i></i></div><div class="sgc-grid"></div>`;
    const head = this.root.querySelector('.sgc-head') as HTMLElement;
    this.toggle = head.querySelector('.tg') as HTMLSpanElement;
    this.fill = head.querySelector('.f') as HTMLSpanElement;
    this.bar = this.root.querySelector('.sgw-bar') as HTMLElement;
    this.grid = this.root.querySelector('.sgc-grid') as HTMLDivElement;
    head.onclick = () => this.setCollapsed(!this.collapsed);
    this.grip(this.root.querySelector('.sgc-grip') as HTMLElement);
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
    document.body.appendChild(this.root);
    this.setCollapsed(this.collapsed, false);
    pilot.onChange(() => this.render());

    // Sit just above the chat, following it as its messages grow and shrink
    const chat = document.getElementById('chatBox');
    if (chat && typeof ResizeObserver !== 'undefined') new ResizeObserver(() => this.place()).observe(chat);
    window.addEventListener('resize', () => this.place());
  }

  private place(): void {
    this.placedAt = performance.now();
    const chat = document.getElementById('chatBox')?.getBoundingClientRect();
    let floor = innerHeight - 20;
    if (!chat || !chat.height) this.root.style.bottom = '20px';
    else {
      this.root.style.left = `${chat.left}px`;
      this.root.style.width = `${chat.width}px`;
      this.root.style.bottom = `${Math.round(innerHeight - chat.top + 6)}px`;
      floor = chat.top - 6;
    }
    // The list's height: as the pilot left it, but no taller than the room between the chat and the readout above
    if (this.hidden || this.collapsed) return;
    // An empty hold is one line, not a tall blank box
    if (!this.pilot.cargo.length) { this.grid.style.height = 'auto'; return; }
    const chrome = this.root.offsetHeight - this.grid.offsetHeight;
    const room = floor - (this.ceiling?.() ?? 0) - 8 - chrome;
    this.grid.style.height = `${Math.round(Math.max(MIN_H, Math.min(this.want, room)))}px`;
  }

  /** Drag the top edge: taller upwards (kept for next time) */
  private grip(el: HTMLElement): void {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      el.classList.add('drag');
      const y0 = e.clientY, h0 = this.grid.offsetHeight;
      const move = (ev: PointerEvent) => { this.want = Math.max(MIN_H, Math.round(h0 + (y0 - ev.clientY))); this.place(); };
      const up = () => {
        el.classList.remove('drag');
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
        // What it could actually have: dragging past the room keeps the most that fits
        this.want = Math.max(MIN_H, Math.min(this.want, this.grid.offsetHeight));
        try { localStorage.setItem(HEIGHT_KEY, String(this.want)); } catch { /* no storage */ }
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });
  }

  private setCollapsed(on: boolean, save = true): void {
    this.collapsed = on;
    this.root.classList.toggle('folded', on);
    this.toggle.textContent = on ? '▸' : '▾';
    if (save) try { localStorage.setItem(FOLD_KEY, on ? '1' : '0'); } catch { /* no storage */ }
    if (save) this.place();
  }

  /** Each frame: hidden (docked, a menu, the hangar), and whether a death here would cost the hold */
  update(hidden: boolean, exposed: boolean): void {
    if (hidden !== this.hidden) {
      this.hidden = hidden;
      this.root.style.display = hidden ? 'none' : 'block';
      if (hidden) { hideTip(); closeMenu(); } else { this.place(); this.render(); }
    }
    if (exposed !== this.exposed) { this.exposed = exposed; this.render(); }
    // The readout above grows and shrinks (a rebuild note, ammunition): keep clear of it, now and then
    if (!hidden && performance.now() - this.placedAt > 500) this.place();
  }

  private render(): void {
    const p = this.pilot, econ = p.econ;
    const used = p.cargoUsed();
    const frac = p.cargoCapacity > 0 ? Math.min(1, used / p.cargoCapacity) : 1;
    this.fill.textContent = `${Math.round(used)} / ${p.cargoCapacity}`;
    (this.bar.firstElementChild as HTMLElement).style.width = `${frac * 100}%`;
    this.bar.classList.toggle('full', frac >= 0.999);

    // What's arrived since last time (not on the first look at the hold)
    const fresh = new Set<string>();
    const counts = new Map(p.cargo.map((s) => [s.id, s.n]));
    if (this.seen) for (const [id, n] of counts) if (n > (this.seen.get(id) ?? 0)) fresh.add(id);
    this.seen = counts;
    const lo = p.profile?.loadout ?? {};
    const key = `${this.exposed}|${p.cargo.map((s) => `${s.id}:${s.n}`).join(',')}|${Object.keys(lo).join(',')}|${(p.profile?.quickbar ?? []).join(',')}`;
    if (key === this.key && !fresh.size) return;
    this.key = key;

    const secure = this.exposed ? secureHold(p.cargo, (id) => econ.items.get(id)?.value ?? 0) : new Map<Stack, number>();
    this.grid.replaceChildren();
    if (!p.cargo.length) {
      const e = document.createElement('div');
      e.className = 'sgc-empty';
      e.textContent = 'Empty: shoot asteroids, then fly through the ore';
      this.grid.appendChild(e);
      this.place();
      return;
    }
    // (sortStacks keeps the stacks themselves, so they key secureHold's map)
    for (const s of sortStacks(econ, p.cargo)) {
      const d = econ.items.get(s.id);
      const kept = secure.get(s);
      const it = document.createElement('div');
      it.className = 'sgc-it' + (fresh.has(s.id) ? ' new' : '');
      const tag = holdTag(p, s.id);
      it.innerHTML = `<img src="${itemIcon(econ, s.id)}"><span class="n">${s.n > 9999 ? `${Math.floor(s.n / 1000)}k` : s.n}</span><span class="nm"></span>${tag ? `<span class="tag ${tag.cls}">${tag.text}</span>` : ''}${kept ? LOCK : ''}`;
      const nm = it.querySelector('.nm') as HTMLElement;
      nm.textContent = d?.name ?? s.id;
      if (d) nm.style.color = RARITY_COLOR[d.rarity];
      const extra = (tag ? `<div class="t-h" style="color:${tag.cls === 'load' ? '#5eead4' : '#c4b5fd'}">${tag.tip}</div>` : '') + (kept
        ? `<div class="t-h" style="color:#fcd34d">🔒 Secure hold: ${kept < s.n ? `${kept} of these stay` : 'these stay'} if you're lost outside safe space</div>`
        : this.exposed ? '<div class="t-h" style="color:#fca5a5">Lost with the wreck if you die out here</div>' : '');
      it.addEventListener('mousemove', (e) => showTip(itemTipHtml(econ, s.id, { count: s.n, extra, hint: 'Right-click to jettison' }), e.clientX, e.clientY));
      it.addEventListener('mouseleave', hideTip);
      it.addEventListener('contextmenu', (e) => { e.preventDefault(); hideTip(); this.jettisonMenu(s.id, e); });
      this.grid.appendChild(it);
    }
    // (Back from the one-line empty hold to its own height)
    if (this.grid.style.height === 'auto') this.place();
  }

  /** The same choices as the inventory window's */
  private jettisonMenu(id: string, e: MouseEvent): void {
    const have = this.pilot.cargo.find((s) => s.id === id)?.n ?? 0;
    if (!have) return;
    const items = [{ label: have > 1 ? `Jettison all (${have})` : 'Jettison', bad: true, run: () => { this.send({ type: 'itemJettison', id, n: have }); this.sound('ui_click'); } }];
    if (have > 1) items.push({ label: 'Jettison one', bad: true, run: () => { this.send({ type: 'itemJettison', id, n: 1 }); this.sound('ui_click'); } });
    openMenu(e.clientX, e.clientY, items);
  }
}
