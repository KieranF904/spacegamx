/**
 * @contract client.ui.pickup-panel
 * owns:       the pickup panel: everything in pickup reach grouped by item with amounts, wrecks with their keeping, click to take one item, Take all (and Enter while it is open); F opens and closes it, Esc closes it; it never stops the ship flying
 * needs:      PilotState (near, cargo, the whitelist), pickupModel (the rows), windowKit (tips), itemIcons; the server's lootTake; npm: @space-game/common
 * invariants: a take is one lootTake message (the server checks reach, keeping and room); rows that won't fit are greyed "Hold full" — client/src/ui/pickup/pickupModel.test.ts
 * extend:     a new row action is a button in renderRow sending one message
 */

import { RARITY_COLOR, type ClientMessage } from '@space-game/common';
import type { PilotState } from '../../econ/clientEcon';
import { injectWindowStyles, itemTipHtml, showTip, hideTip } from '../windowKit';
import { itemIcon } from '../itemIcons';
import { esc } from '../escape';
import { pickupRows } from './pickupModel';

let styled = false;
function injectStyles(): void {
  if (styled) return;
  styled = true;
  const css = document.createElement('style');
  css.textContent = `
.sgp { position: fixed; right: 18px; top: max(34%, 330px); width: 290px; z-index: 860; box-sizing: border-box; padding: 8px 10px 9px; display: none;
  background: rgba(8, 14, 26, 0.86); border: 1px solid rgba(134, 239, 172, 0.3); border-radius: 10px; color: #c9d4e5; font: 12px 'Segoe UI', system-ui, sans-serif; user-select: none; }
.sgp-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.sgp-head b { font: 700 10px 'Segoe UI', sans-serif; letter-spacing: 2px; color: #86efac; }
.sgp-head .k { margin-left: auto; color: #56657c; font-size: 10px; }
.sgp-list { display: flex; flex-direction: column; gap: 2px; max-height: 300px; overflow-y: auto; scrollbar-width: thin; }
.sgp-row { all: unset; box-sizing: border-box; display: flex; align-items: center; gap: 6px; padding: 3px 5px; border-radius: 6px; cursor: pointer; }
.sgp-row:hover, .sgp-row:focus-visible { background: rgba(134, 239, 172, 0.12); }
.sgp-row img { width: 20px; height: 20px; flex-shrink: 0; }
.sgp-row .n { color: #e5ecf7; font-weight: 600; min-width: 22px; }
.sgp-row .nm { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sgp-row .note { font-size: 10px; color: #fbbf24; }
.sgp-row.full { cursor: default; opacity: 0.45; }
.sgp-row.full .note { color: #fca5a5; }
.sgp-wreck { display: flex; gap: 6px; padding: 3px 5px; font-size: 11px; color: #9fb3cc; }
.sgp-wreck.mine { color: #86efac; }
.sgp-wreck.lock { color: #fca5a5; }
.sgp-empty { color: #56657c; padding: 4px; }
.sgp-foot { display: flex; gap: 6px; margin-top: 7px; }
.sgp-foot button { all: unset; cursor: pointer; padding: 4px 12px; border-radius: 999px; border: 1px solid rgba(134, 239, 172, 0.45); color: #bbf7d0; font-size: 12px; }
.sgp-foot button:hover, .sgp-foot button:focus-visible { background: rgba(134, 239, 172, 0.16); color: #fff; }
.sgp-foot button[disabled] { opacity: 0.4; cursor: default; }
`;
  document.head.appendChild(css);
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

export class PickupPanelUI {
  private root: HTMLDivElement;
  private list: HTMLDivElement;
  private takeAll: HTMLButtonElement;
  private shown = false;
  private blocked = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private pilot: PilotState, private send: (m: ClientMessage) => void, private sound: (id: string) => void) {
    injectWindowStyles();
    injectStyles();
    this.root = document.createElement('div');
    this.root.className = 'sgp';
    this.root.dataset.hudAvoid = '1';
    this.root.innerHTML = `<div class="sgp-head"><b>LOOT IN REACH</b><span class="k">F: close · Enter: take all</span></div><div class="sgp-list"></div>
      <div class="sgp-foot"><button type="button" class="all">Take all</button></div>`;
    this.list = this.root.querySelector('.sgp-list') as HTMLDivElement;
    this.takeAll = this.root.querySelector('.all') as HTMLButtonElement;
    this.takeAll.onclick = () => this.take();
    document.body.appendChild(this.root);
    pilot.onNear(() => this.render());
    pilot.onChange(() => this.render());
    // Enter takes everything while it's open (the chat box doesn't take Enter then: Game's chat canFocus)
    window.addEventListener('keydown', (e) => {
      if (!this.isOpen || (e.key !== 'Enter' && e.code !== 'NumpadEnter') || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      e.preventDefault();
      this.take();
    });
  }

  get isOpen(): boolean { return this.shown && !this.blocked; }

  toggle(): void { this.setShown(!this.shown); }
  close(): void { this.setShown(false); }

  private setShown(on: boolean): void {
    this.shown = on;
    this.apply();
    this.sound(on ? 'ui_open' : 'ui_close');
  }

  /** Each frame: hidden while docked, in a menu or the hangar (it comes back as it was) */
  update(blocked: boolean): void {
    if (blocked === this.blocked) return;
    this.blocked = blocked;
    this.apply();
  }

  private apply(): void {
    const on = this.isOpen;
    this.root.style.display = on ? 'block' : 'none';
    if (!on) hideTip();
    if (on && !this.timer) this.timer = setInterval(() => this.render(), 1000);
    if (!on && this.timer) { clearInterval(this.timer); this.timer = null; }
    if (on) this.render();
  }

  /** One decision: this item (all of it that fits), or everything */
  private take(item?: string): void {
    this.send({ type: 'lootTake', ...(item ? { item } : {}) });
    this.sound('ui_click');
  }

  private render(): void {
    if (!this.isOpen) return;
    const p = this.pilot, econ = p.econ;
    const { rows, wrecks } = pickupRows(p.near, p.holdView(), p.ghosts, Date.now() - p.nearAt);
    this.list.replaceChildren();
    for (const w of wrecks) {
      const d = document.createElement('div');
      d.className = `sgp-wreck${w.mine ? ' mine' : w.lock > 0 ? ' lock' : ''}`;
      d.textContent = w.mine ? `Your wreck · ${w.count} items` : w.lock > 0 ? `A pilot's wreck · theirs for ${clock(w.lock)}` : `A wreck · ${w.count} items, open to all`;
      this.list.appendChild(d);
    }
    for (const r of rows) {
      const def = econ.items.get(r.item);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `sgp-row${r.fit === 0 ? ' full' : ''}`;
      const note = r.fit === 0 ? 'Hold full' : r.fit < r.n ? `${r.fit} fit` : r.reserved ? 'uses kept space' : '';
      b.innerHTML = `<img src="${itemIcon(econ, r.item)}" alt=""><span class="n">${r.n}</span><span class="nm"></span>${note ? `<span class="note">${esc(note)}</span>` : ''}`;
      const nm = b.querySelector('.nm') as HTMLElement;
      nm.textContent = def?.name ?? r.item;
      if (def) nm.style.color = RARITY_COLOR[def.rarity];
      const hint = r.fit === 0 ? 'Your hold is full' : r.reserved ? 'Click to take it. It uses hold space your auto-pickup list keeps free' : 'Click to take it';
      b.addEventListener('mousemove', (e) => showTip(itemTipHtml(econ, r.item, { count: r.n, hint }), e.clientX, e.clientY));
      b.addEventListener('mouseleave', hideTip);
      if (r.fit > 0) b.onclick = () => this.take(r.item);
      this.list.appendChild(b);
    }
    if (!rows.length && !wrecks.length) {
      const e = document.createElement('div');
      e.className = 'sgp-empty';
      e.textContent = 'Nothing in reach. Fly close to loot to see it here.';
      this.list.appendChild(e);
    }
    this.takeAll.disabled = !rows.some((r) => r.fit > 0);
  }
}
