/**
 * The hold at a glance, always on, just above the chat: each stack's icon,
 * count and name, and how full the hold is (all of it goes in the wreck if the
 * ship is lost: docs/design/death-rework-2026-11.md). New arrivals flash; hovering shows the item and its value;
 * right-click jettisons, whitelists it for auto-pickup, or (an ore) blacklists
 * and jettisons it. The head has mining mode's switch and an "Auto-pickup: N"
 * chip that opens the auto-pickup panel (ui/pickup); the fill bar shows the
 * space the whitelist keeps as a faint segment. Your ammunition loadout's crates are tagged LOAD and
 * utility (consumables, the quick bar) UTIL: the storage controls leave both
 * aboard. A fixed height that scrolls (drag the top edge to resize; it keeps
 * clear of the side panel and the pilot readout above: `ceiling`), or folds
 * down to just the fill bar. The side panel (ui/hub) sits on top of it and
 * shares the column: `column()` tells it the room, `relayout()` re-places it.
 * Hidden while docked (the station's storage screen has the hold then); I
 * opens the full window.
 */

import { RARITY_COLOR, cargoEffect, isOre, reservedSpace, type ClientMessage } from '@space-game/common';
import type { PilotState } from '../econ/clientEcon';
import { injectWindowStyles, itemTipHtml, showTip, hideTip, openMenu, closeMenu, sortStacks } from './windowKit';
import { itemIcon } from './itemIcons';
import { holdTag } from './storeControls';

const FOLD_KEY = 'sg.cargoPanel.collapsed';
const HEIGHT_KEY = 'sg.cargoPanel.height';
/** The list's height until the pilot drags it (about nine rows of two), and the least it shrinks to */
const DEFAULT_H = 200;
const MIN_H = 44;
/** What the load line means, in plain words */
const LOAD_TIP = '<div class="t-n">Cargo has mass</div><div class="t-d">A heavier load accelerates, turns and stops slower. '
  + 'A bigger ship feels the same load less, and strong engines help. '
  + 'Ore and metal are heavy, gems light, ammo in between. Station storage weighs nothing.</div>';

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
.sgc-head .chip { all: unset; cursor: pointer; font-size: 10px; padding: 0 7px; border-radius: 999px; border: 1px solid rgba(140, 170, 220, 0.25); color: #8394ad; line-height: 15px; }
.sgc-head .chip:hover, .sgc-head .chip:focus-visible { color: #fff; border-color: rgba(125, 211, 252, 0.6); }
.sgc-head .chip.on { color: #86efac; border-color: rgba(134, 239, 172, 0.5); background: rgba(134, 239, 172, 0.08); }
.sgc .sgw-bar { margin: 4px 0 0; height: 4px; position: relative; }
.sgc .sgw-bar .rs { position: absolute; top: 0; bottom: 0; background: rgba(125, 211, 252, 0.3); border-radius: 2px; pointer-events: none; }
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
.sgc-load { display: flex; gap: 6px; margin-top: 4px; font-size: 11px; color: #8394ad; cursor: help; }
.sgc-load b { color: #c9d4e5; font-weight: 600; }
.sgc-load .hit { color: #fbbf24; }
.sgc-load .hit.heavy { color: #fb923c; }
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
  /** The bottom of whatever sits above it in the left column (the side panel, the pilot readout), so it never grows into it */
  ceiling?: () => number;
  /** It was placed (the side panel sits on top of it) */
  onPlace?: () => void;
  /** The ship you fly (its mass: what the load is weighed against, common/src/ships/load.ts) */
  ship?: () => { mass: number; fullMass?: number } | null;
  private load: HTMLDivElement;
  private loadKey = '';
  private miningChip: HTMLButtonElement;
  private autoChip: HTMLButtonElement;
  private reserve: HTMLElement;
  /** The "Auto-pickup: N" chip was clicked (the auto-pickup panel: ui/pickup/AutoPickupPanel.ts) */
  onAutoPickup?: () => void;

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
    this.root.innerHTML = `<div class="sgc-grip" title="Drag to resize"></div><div class="sgc-head" title="Click to fold · I: full inventory"><span class="tg"></span><b>CARGO</b>`
      + `<button type="button" class="chip mine" title="Mining mode: every ore but the blacklisted comes in by itself (click to switch)">Mining</button>`
      + `<button type="button" class="chip auto" title="What this hold picks up by itself: the whitelist, the ore blacklist and templates">Auto-pickup</button><span class="f"></span></div>
      <div class="sgw-bar"><i></i><b class="rs"></b></div><div class="sgc-load" hidden></div><div class="sgc-grid"></div>`;
    const head = this.root.querySelector('.sgc-head') as HTMLElement;
    this.toggle = head.querySelector('.tg') as HTMLSpanElement;
    this.fill = head.querySelector('.f') as HTMLSpanElement;
    this.bar = this.root.querySelector('.sgw-bar') as HTMLElement;
    this.grid = this.root.querySelector('.sgc-grid') as HTMLDivElement;
    this.load = this.root.querySelector('.sgc-load') as HTMLDivElement;
    this.miningChip = head.querySelector('.mine') as HTMLButtonElement;
    this.autoChip = head.querySelector('.auto') as HTMLButtonElement;
    this.reserve = this.root.querySelector('.rs') as HTMLElement;
    this.miningChip.onclick = (e) => { e.stopPropagation(); this.send({ type: 'pickupPrefs', mining: !this.pilot.mining().on }); this.sound('ui_click'); };
    this.autoChip.onclick = (e) => { e.stopPropagation(); this.onAutoPickup?.(); };
    this.load.addEventListener('mousemove', (e) => showTip(LOAD_TIP, e.clientX, e.clientY));
    this.load.addEventListener('mouseleave', hideTip);
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

  /** Where it is on screen (the auto-pickup panel sits beside it), or null while hidden */
  rect(): DOMRect | null {
    return this.hidden ? null : this.root.getBoundingClientRect();
  }

  /** Place it again now (the side panel's room changed) */
  relayout(): void {
    this.place();
  }

  /** The left column as it is: its floor (above the chat box), its least height and its top (0 for both while hidden), and the column's left and width */
  column(): { floor: number; min: number; top: number; left: number; width: number } {
    const chat = document.getElementById('chatBox')?.getBoundingClientRect();
    const on = !!chat && chat.height > 0;
    const floor = on ? chat!.top - 6 : innerHeight - 20;
    const left = on ? chat!.left : 16, width = on ? chat!.width : 320;
    if (this.hidden) return { floor, min: 0, top: 0, left, width };
    const box = this.root.offsetHeight;
    const min = this.collapsed || !this.pilot.cargo.length ? box : box - this.grid.offsetHeight + MIN_H;
    return { floor, min, top: this.root.getBoundingClientRect().top, left, width };
  }

  private place(): void {
    this.placeIn();
    this.onPlace?.();
  }

  private placeIn(): void {
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
    if (!hidden && performance.now() - this.placedAt > 500) { this.place(); this.renderLoad(); }
  }

  /** The hold's mass, and what it costs the ship in thrust and turning (ships/load.ts) */
  private renderLoad(): void {
    const ship = this.ship?.();
    const mass = this.pilot.econ.items.massOf(this.pilot.cargo);
    const key = `${mass}|${ship?.mass}|${ship?.fullMass}`;
    if (key === this.loadKey) return;
    this.loadKey = key;
    const e = ship && mass > 0 ? cargoEffect(ship, mass) : null;
    this.load.hidden = !e;
    if (!e) return;
    const pct = (v: number) => `−${Math.round(v * 100)}%`;
    const heavy = e.thrustLoss >= 0.25 ? ' heavy' : '';
    this.load.innerHTML = `<span>Load <b>${mass.toFixed(1)}</b></span><span class="hit${heavy}">${pct(e.thrustLoss)} thrust</span><span class="hit${heavy}">${pct(e.turnLoss)} turn</span>`;
  }

  private render(): void {
    const p = this.pilot, econ = p.econ;
    const used = p.cargoUsed();
    const frac = p.cargoCapacity > 0 ? Math.min(1, used / p.cargoCapacity) : 1;
    this.fill.textContent = `${Math.round(used)} / ${p.cargoCapacity}`;
    (this.bar.firstElementChild as HTMLElement).style.width = `${frac * 100}%`;
    this.bar.classList.toggle('full', frac >= 0.999);
    // Mining mode and the whitelist in the head; the space the whitelist keeps, faint, after what's used
    const mode = p.mining();
    this.miningChip.classList.toggle('on', mode.on);
    this.miningChip.textContent = mode.on ? 'Mining on' : 'Mining off';
    this.autoChip.textContent = `Auto-pickup: ${p.ghosts.length + (mode.blacklist?.length ?? 0)}`;
    this.autoChip.classList.toggle('on', p.ghosts.length > 0);
    const kept = p.cargoCapacity > 0 ? Math.min(1 - frac, reservedSpace(p.holdView(), p.ghosts) / p.cargoCapacity) : 0;
    this.reserve.style.left = `${frac * 100}%`;
    this.reserve.style.width = `${Math.max(0, kept) * 100}%`;

    // What's arrived since last time (not on the first look at the hold)
    const fresh = new Set<string>();
    const counts = new Map(p.cargo.map((s) => [s.id, s.n]));
    if (this.seen) for (const [id, n] of counts) if (n > (this.seen.get(id) ?? 0)) fresh.add(id);
    this.seen = counts;
    const lo = p.profile?.loadout ?? {};
    const key = `${this.exposed}|${p.cargo.map((s) => `${s.id}:${s.n}`).join(',')}|${Object.keys(lo).join(',')}|${(p.profile?.quickbar ?? []).join(',')}|${p.ghosts.map((g) => g.item).join(',')}`;
    if (key === this.key && !fresh.size) return;
    this.key = key;

    this.grid.replaceChildren();
    if (!p.cargo.length) {
      const e = document.createElement('div');
      e.className = 'sgc-empty';
      e.textContent = 'Empty: shoot asteroids, then fly through the ore';
      this.grid.appendChild(e);
      this.place();
      return;
    }
    for (const s of sortStacks(econ, p.cargo)) {
      const d = econ.items.get(s.id);
      const it = document.createElement('div');
      it.className = 'sgc-it' + (fresh.has(s.id) ? ' new' : '');
      const tag = holdTag(p, s.id);
      it.innerHTML = `<img src="${itemIcon(econ, s.id)}"><span class="n">${s.n > 9999 ? `${Math.floor(s.n / 1000)}k` : s.n}</span><span class="nm"></span>${tag ? `<span class="tag ${tag.cls}">${tag.text}</span>` : ''}`;
      const nm = it.querySelector('.nm') as HTMLElement;
      nm.textContent = d?.name ?? s.id;
      if (d) nm.style.color = RARITY_COLOR[d.rarity];
      const extra = (tag ? `<div class="t-h" style="color:${tag.cls === 'load' ? '#5eead4' : '#c4b5fd'}">${tag.tip}</div>` : '')
        + '<div class="t-h" style="color:#fca5a5">Goes in your wreck if your ship is lost</div>';
      it.addEventListener('mousemove', (e) => showTip(itemTipHtml(econ, s.id, { count: s.n, extra, hint: 'Right-click: jettison, or auto-pickup' }), e.clientX, e.clientY));
      it.addEventListener('mouseleave', hideTip);
      it.addEventListener('contextmenu', (e) => { e.preventDefault(); hideTip(); this.jettisonMenu(s.id, e); });
      this.grid.appendChild(it);
    }
    // (Back from the one-line empty hold to its own height)
    if (this.grid.style.height === 'auto') this.place();
  }

  /** The inventory window's jettison choices, then auto-pickup's: whitelist it, and for an ore blacklist and jettison it */
  private jettisonMenu(id: string, e: MouseEvent): void {
    const p = this.pilot;
    const have = p.cargo.find((s) => s.id === id)?.n ?? 0;
    if (!have) return;
    const items = [{ label: have > 1 ? `Jettison all (${have})` : 'Jettison', bad: true, run: () => { this.send({ type: 'itemJettison', id, n: have }); this.sound('ui_click'); } }];
    if (have > 1) items.push({ label: 'Jettison one', bad: true, run: () => { this.send({ type: 'itemJettison', id, n: 1 }); this.sound('ui_click'); } });
    const white = p.ghosts.some((g) => g.item === id);
    items.push(white
      ? { label: 'Stop picking this up by itself', bad: false, run: () => { this.send({ type: 'ghost', item: id, remove: true }); this.sound('ui_click'); } }
      : { label: 'Auto-pickup this', bad: false, run: () => { this.send({ type: 'ghost', item: id }); this.sound('ui_click'); } });
    if (isOre(p.holdView(), id) && !p.mining().blacklist?.includes(id)) {
      items.push({ label: 'Blacklist & jettison', bad: true, run: () => { this.send({ type: 'oreBlacklist', item: id, on: true, jettison: true }); this.sound('ui_click'); } });
    }
    openMenu(e.clientX, e.clientY, items);
  }
}
