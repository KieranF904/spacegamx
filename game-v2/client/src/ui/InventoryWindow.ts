/**
 * Cargo & Storage (I): the ship's hold beside the shared station storage.
 * Click moves a whole stack across (Shift: one, Ctrl: ten), drag works too,
 * right-click for more (use, learn a plan, jettison). Storage is only
 * reachable at a station; away from one it's shown dimmed.
 */

import type { ClientMessage } from '@space-game/common';
import type { PilotState } from '../econ/clientEcon';
import { GameWindow, ItemGrid, ItemFilter, FILTERS, openMenu } from './windowKit';
import { storeControls, holdClassOf, holdTag } from './storeControls';

export class InventoryWindow {
  private win = new GameWindow('Cargo & Storage');
  private cargo: ItemGrid;
  private storage: ItemGrid;
  private filter: ItemFilter = 'all';
  private search = '';
  private cargoHead: HTMLHeadingElement;
  private cargoBar: HTMLDivElement;
  private storageHead: HTMLHeadingElement;
  private storageNote: HTMLDivElement;
  private foot: HTMLDivElement;
  private credits: HTMLSpanElement;
  /** The quick storage controls (at a station) */
  private storeRow: HTMLDivElement;

  constructor(private pilot: PilotState, private send: (m: ClientMessage) => void, private sound: (id: string) => void) {
    const econ = pilot.econ;
    this.credits = document.createElement('span');
    this.credits.className = 'sgw-credits';
    this.win.headExtra.append(this.credits);

    // Filters and search
    const tools = document.createElement('div');
    tools.style.cssText = 'display:flex; gap:6px; align-items:center; flex-wrap:wrap; margin-bottom:12px;';
    const chips: HTMLButtonElement[] = [];
    for (const f of FILTERS) {
      const c = document.createElement('button');
      c.className = 'sgw-chip' + (f.id === this.filter ? ' on' : '');
      c.textContent = f.label;
      c.onclick = () => { this.filter = f.id; chips.forEach((x) => x.classList.toggle('on', x === c)); this.render(); };
      chips.push(c);
      tools.appendChild(c);
    }
    const search = document.createElement('input');
    search.className = 'sgw-input';
    search.placeholder = 'Search…';
    search.style.marginLeft = 'auto';
    search.oninput = () => { this.search = search.value; this.render(); };
    tools.appendChild(search);

    const cols = document.createElement('div');
    cols.style.cssText = 'display:grid; grid-template-columns: 1fr 1fr; gap:14px; height: min(560px, calc(100vh - 220px));';

    const cargoCol = document.createElement('div');
    cargoCol.className = 'sgw-col';
    this.cargoHead = document.createElement('h4');
    this.cargoBar = document.createElement('div');
    this.cargoBar.className = 'sgw-bar';
    this.cargoBar.innerHTML = '<i></i>';
    this.cargo = new ItemGrid({
      econ, zone: 'cargo', empty: 'Your hold is empty. Mine asteroids and pick up loot to fill it.',
      onClick: (id, e) => this.move(id, 'storage', e),
      onContext: (id, e) => (this.pilot.atStation && !e.shiftKey ? this.moveOne(id, 'storage') : this.cargoMenu(id, e)),
      onDrop: (id, _from, e) => this.move(id, 'cargo', e),
      hint: (id) => this.hint(id, 'cargo'),
      tag: (id) => holdTag(this.pilot, id),
    });
    this.storeRow = document.createElement('div');
    this.storeRow.style.cssText = 'margin:0 0 8px;';
    cargoCol.append(this.cargoHead, this.cargoBar, this.storeRow, this.cargo.el);

    const storeCol = document.createElement('div');
    storeCol.className = 'sgw-col';
    this.storageHead = document.createElement('h4');
    this.storageNote = document.createElement('div');
    this.storageNote.style.cssText = 'color:#8394ad; font-size:12px; margin:0 0 10px;';
    this.storage = new ItemGrid({
      econ, zone: 'storage', empty: 'Nothing in storage yet.',
      onClick: (id, e) => this.move(id, 'cargo', e),
      onContext: (id, e) => (this.pilot.atStation && !e.shiftKey ? this.moveOne(id, 'cargo') : this.storageMenu(id, e)),
      onDrop: (id, _from, e) => this.move(id, 'storage', e),
      hint: (id) => this.hint(id, 'storage'),
    });
    storeCol.append(this.storageHead, this.storageNote, this.storage.el);
    cols.append(cargoCol, storeCol);

    this.foot = document.createElement('div');
    this.foot.style.cssText = 'margin-top:10px; color:#56657c; font-size:11px;';
    this.win.body.append(tools, cols, this.foot);

    pilot.onChange(() => { if (this.win.isOpen) this.render(); });
    // Above the station screen when opened from it
    this.win.veil.style.zIndex = '2600';
  }

  get isOpen(): boolean {
    return this.win.isOpen;
  }

  toggle(): void {
    if (this.win.isOpen) this.close();
    else this.open();
  }

  open(): void {
    this.win.open();
    this.render();
    this.sound('ui_open');
  }

  close(): void {
    if (!this.win.isOpen) return;
    this.win.close();
    this.sound('ui_close');
  }

  private amount(id: string, from: 'cargo' | 'storage', e: MouseEvent | DragEvent): number {
    const have = (from === 'cargo' ? this.pilot.cargo : this.pilot.storage).find((s) => s.id === id)?.n ?? 0;
    if (e.shiftKey) return 1;
    if (e.ctrlKey || e.metaKey) return Math.min(10, have);
    return have;
  }

  private move(id: string, to: 'cargo' | 'storage', e: MouseEvent | DragEvent): void {
    if (!this.pilot.atStation) return;
    const n = this.amount(id, to === 'cargo' ? 'storage' : 'cargo', e);
    if (n > 0) {
      this.send({ type: 'itemMove', id, n, to });
      this.sound('ui_click');
    }
  }

  private moveOne(id: string, to: 'cargo' | 'storage'): void {
    this.send({ type: 'itemMove', id, n: 1, to });
    this.sound('ui_click');
  }

  private hint(id: string, where: 'cargo' | 'storage'): string | undefined {
    const d = this.pilot.econ.items.get(id);
    const menu = this.pilot.atStation ? 'Shift-right-click' : 'Right-click';
    if (d?.category === 'plan') return this.pilot.knowsPlan(d.plan!) ? 'You already know this plan' : `${menu} → Learn plan`;
    if (d?.category === 'consumable') return `${menu} → Use or put on the quick bar · drag onto the bar`;
    const cls = where === 'cargo' ? holdClassOf(this.pilot, id) : null;
    const keep = cls === 'loadout' ? "Your ship's ammunition loadout: the storage controls leave it aboard, and its guns open it first. "
      : cls === 'utility' ? 'Utility: the storage controls leave it aboard. ' : '';
    if (!this.pilot.atStation) return keep + (where === 'cargo' ? 'Dock at a station to move items to storage' : '');
    if (keep) return `${keep}Click to store it anyway`;
    return where === 'cargo' ? 'Click to store' : 'Click to load into cargo';
  }

  private useItems(id: string): { label: string; run: () => void }[] {
    const d = this.pilot.econ.items.get(id);
    const out: { label: string; run: () => void }[] = [];
    if (d?.category === 'plan' && d.plan && !this.pilot.knowsPlan(d.plan)) out.push({ label: 'Learn plan', run: () => this.send({ type: 'itemUse', id }) });
    if (d?.category === 'consumable' && (d.repair || id === 'boost_cell' || id === 'scanner_charge')) out.push({ label: 'Use', run: () => this.send({ type: 'itemUse', id }) });
    // Modules break down to salvage: most of their ore back, their components in full
    if (d?.category === 'part' && this.pilot.atStation) {
      const have = (this.pilot.cargo.find((x) => x.id === id)?.n ?? 0) + (this.pilot.storage.find((x) => x.id === id)?.n ?? 0);
      out.push({ label: 'Scrap one (salvage)', run: () => this.send({ type: 'scrapItem', id, n: 1 }) });
      if (have > 1) out.push({ label: `Scrap all ${have} (salvage)`, run: () => this.send({ type: 'scrapItem', id, n: have }) });
    }
    if (d?.ammoFor) {
      const first = this.pilot.profile?.ammoPrefer?.[d.ammoFor.weapon] === id;
      if (!first) out.push({ label: `Open first (this ship's ${d.ammoFor.weapon})`, run: () => this.send({ type: 'ammoPrefer', item: id }) });
    }
    if (d?.category === 'consumable') {
      const bar = this.pilot.profile?.quickbar ?? [];
      const free = bar.findIndex((q) => !q);
      const at = bar.indexOf(id);
      if (at >= 0) out.push({ label: `Remove from quick bar (${at + 1})`, run: () => this.send({ type: 'quickbarSet', slot: at, id: null }) });
      else out.push({ label: `Put on quick bar (${(free >= 0 ? free : 4) + 1})`, run: () => this.send({ type: 'quickbarSet', slot: free >= 0 ? free : 4, id }) });
    }
    return out;
  }

  private cargoMenu(id: string, e: MouseEvent): void {
    const have = this.pilot.cargo.find((s) => s.id === id)?.n ?? 0;
    const items = this.useItems(id);
    if (this.pilot.atStation) {
      items.push({ label: 'Store all', run: () => this.send({ type: 'itemMove', id, n: have, to: 'storage' }) });
      if (have > 1) items.push({ label: 'Store one', run: () => this.send({ type: 'itemMove', id, n: 1, to: 'storage' }) });
    }
    items.push({ label: have > 1 ? `Jettison all (${have})` : 'Jettison', run: () => this.send({ type: 'itemJettison', id, n: have }) });
    if (have > 1) items.push({ label: 'Jettison one', run: () => this.send({ type: 'itemJettison', id, n: 1 }) });
    openMenu(e.clientX, e.clientY, items.map((it) => ({ ...it, bad: it.label.startsWith('Jettison') })));
  }

  private storageMenu(id: string, e: MouseEvent): void {
    const have = this.pilot.storage.find((s) => s.id === id)?.n ?? 0;
    const items = this.useItems(id);
    if (this.pilot.atStation) {
      items.push({ label: 'Load all', run: () => this.send({ type: 'itemMove', id, n: have, to: 'cargo' }) });
      if (have > 1) items.push({ label: 'Load one', run: () => this.send({ type: 'itemMove', id, n: 1, to: 'cargo' }) });
    }
    openMenu(e.clientX, e.clientY, items);
  }

  private render(): void {
    const p = this.pilot;
    this.credits.textContent = `${p.credits.toLocaleString()} cr`;
    const used = p.cargoUsed();
    this.cargoHead.innerHTML = `Cargo hold <span class="r">${Math.round(used)} / ${p.cargoCapacity}</span>`;
    const frac = p.cargoCapacity > 0 ? Math.min(1, used / p.cargoCapacity) : 1;
    this.cargoBar.classList.toggle('full', frac >= 0.999);
    (this.cargoBar.firstElementChild as HTMLElement).style.width = `${frac * 100}%`;
    const stored = p.storage.reduce((t, s) => t + s.n, 0);
    this.storageHead.innerHTML = `Storage <span class="r">${stored.toLocaleString()} items</span>`;
    this.storageNote.textContent = p.atStation
      ? 'Shared between every station. Ship parts here can be fitted in the hangar.'
      : 'Storage is shared between stations, but only reachable while docked.';
    this.win.sub.textContent = p.atStation ? 'At a station' : 'In flight';
    // The controls as they are here (docked, clicks move things; in flight, only the item menu does anything)
    this.foot.textContent = p.atStation
      ? 'Click: move stack · Ctrl-click: move ten · Right-click: move one · Shift-right-click: use, quick bar, jettison · Drag onto the quick bar to bind 1-5'
      : 'Right-click an item: use, quick bar, jettison · Drag onto the quick bar to bind 1-5 · Dock to move things between cargo and storage';
    this.storeRow.replaceChildren(...(p.atStation && p.cargo.length ? [storeControls(p, this.send, this.sound)] : []));
    this.storage.setDimmed(!p.atStation);
    this.cargo.render(p.cargo, this.filter, this.search);
    this.storage.render(p.storage, this.filter, this.search);
  }
}
