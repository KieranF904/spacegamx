/**
 * The station screen (H while in a docking ring). One window for everything a
 * station offers: an overview (repair status, the hangar, storage), the
 * market (prices that move: wanted and glutted goods, saturation, and where
 * pays more), faction quartermasters, the refinery and the fabricator with its
 * build queue.
 *
 * Ships shows what each unfinished ship still needs, at a glance and down to
 * the ore (econ/orders.ts), with its order's controls: hold, resume, first in
 * line, call off. The refinery and fabricator list their jobs (each can be
 * held, moved to the front or called off) and what orders are waiting on:
 * what can't start yet, what it's for, and what it's short of.
 *
 * Everything shown is what the server reported; every button is a request
 * the server checks and answers.
 */

import type { ClientMessage, ServerStationMessage, ServerVendorsMessage, ServerMarketScanMessage, OrderPlan } from '@space-game/common';
import { GameWindow } from './windowKit';
import {
  type Tab, type StationCtx, type StationWindowDeps, VENDOR_STATIONS, scrollsOf,
} from './station/shared';
import { renderJobs } from './station/jobs';
import { OverviewTab } from './station/overview';
import { ShipsTab } from './station/ships';
import { MarketTab } from './station/market';
import { VendorsTab } from './station/vendors';
import { RefineryTab } from './station/refinery';
import { FabricatorTab } from './station/fabricator';
import { OutpostTab } from './station/outpost';
import { BankTab } from './station/bankTab';
import { onBank } from './station/bankStore';

export type { StationWindowDeps };

/** Tabs every station has (the rest need the station's service) */
const ALWAYS_TABS = new Set<Tab>(['overview', 'contracts', 'ships', 'outpost', 'bank']);

/**
 * The shell: the tabs bar and its badges, open/close, routing and the shared state the tabs read
 * (the station message, the clock, the jobs ticker). Each tab is a module under ./station/.
 */
export class StationWindow {
  private win = new GameWindow('Station');
  private tabEls = new Map<Tab, HTMLButtonElement>();
  private tab: Tab = 'overview';
  private renderedTab: Tab | null = null;
  private st: ServerStationMessage | null = null;
  private clockSkew = 0;
  private credits: HTMLSpanElement;
  private timer: number | null = null;
  private ctx: StationCtx;
  private overview: OverviewTab;
  private ships: ShipsTab;
  private market: MarketTab;
  private vendors: VendorsTab;
  private refinery: RefineryTab;
  private fabricator: FabricatorTab;
  private outpost: OutpostTab;
  private bank: BankTab;

  constructor(private d: StationWindowDeps) {
    const self = this;
    this.ctx = {
      d,
      get st() { return self.st; },
      have: (id) => d.pilot.count(id),
      now: () => self.now(),
      orders: () => self.orders(),
      render: () => self.render(),
      renderJobs: () => renderJobs(self.ctx, self.win.body),
    };
    this.overview = new OverviewTab(this.ctx);
    this.ships = new ShipsTab(this.ctx);
    this.market = new MarketTab(this.ctx);
    this.vendors = new VendorsTab(this.ctx);
    this.refinery = new RefineryTab(this.ctx);
    this.fabricator = new FabricatorTab(this.ctx);
    this.outpost = new OutpostTab(this.ctx);
    this.bank = new BankTab(this.ctx);

    this.credits = document.createElement('span');
    this.credits.className = 'sgw-credits';
    this.win.headExtra.append(this.credits);
    this.win.tabs.style.display = 'flex';
    for (const [id, label] of [['overview', 'Overview'], ['ships', 'Ships'], ['contracts', 'Contracts'], ['market', 'Market'], ['vendors', 'Quartermasters'], ['refinery', 'Refinery'], ['fabricator', 'Fabricator'], ['bank', 'Repair bank'], ['outpost', 'Your station']] as [Tab, string][]) {
      const b = document.createElement('button');
      b.className = 'sgw-tab';
      b.dataset.tab = id;
      b.textContent = label;
      b.onclick = () => {
        this.tab = id;
        if (id === 'vendors') this.d.send({ type: 'vendorOpen' });
        if (id === 'market') this.market.scanAsked = 0;
        this.render();
        this.d.sound('ui_click', 0.4);
      };
      this.tabEls.set(id, b);
      this.win.tabs.appendChild(b);
    }
    this.win.onClose = () => {
      if (this.timer !== null) { clearInterval(this.timer); this.timer = null; }
      this.d.onClose();
    };
    d.pilot.onChange(() => { if (this.win.isOpen) this.render(); });
    onBank(() => { if (this.win.isOpen && this.tab === 'bank') this.render(); });
    d.quests.onChange(() => { if (this.win.isOpen && (this.tab === 'contracts' || this.tab === 'overview')) this.render(); else this.badges(); });
  }

  get isOpen(): boolean {
    return this.win.isOpen;
  }

  /** The tab showing (the tutorial watches for Ships) */
  get currentTab(): string {
    return this.tab;
  }

  open(): void {
    this.win.open();
    this.d.send({ type: 'stationOpen' });
    this.render();
    // Fabricator progress bars tick along
    this.timer = window.setInterval(() => { if (this.tab === 'fabricator' || this.tab === 'refinery' || this.tab === 'overview') this.ctx.renderJobs(); }, 500);
  }

  close(): void {
    this.win.close();
  }

  /** Show a tab (the Ship window's "Repair bank" while docked); open already */
  showTab(id: Tab): void {
    if (this.win.isOpen && this.tabEls.get(id)?.style.display !== 'none') this.tabEls.get(id)?.click();
  }

  /** Hide without undocking (the hangar opens over it) */
  hideForHangar(): void {
    this.win.veil.style.display = 'none';
  }

  showAgain(): void {
    if (this.win.isOpen) { this.win.veil.style.display = 'flex'; this.d.send({ type: 'stationOpen' }); }
  }

  setStation(m: ServerStationMessage): void {
    this.st = m;
    this.clockSkew = m.now - Date.now();
    this.win.root.querySelector('.sgw-title')!.textContent = m.name;
    for (const [id, el] of this.tabEls) {
      if (id === 'vendors') { el.style.display = VENDOR_STATIONS.has(m.id) ? '' : 'none'; continue; }
      const need = ALWAYS_TABS.has(id) ? null : id === 'market' ? 'market' : id;
      el.style.display = !need || m.services.includes(need) ? '' : 'none';
    }
    if (this.tab === 'vendors' ? !VENDOR_STATIONS.has(m.id) : !ALWAYS_TABS.has(this.tab) && !m.services.includes(this.tab)) this.tab = 'overview';
    if (this.win.isOpen) this.render();
  }

  /** Contracts tab: how many jobs are on offer here; and the tab the followed job wants you in glows */
  private badges(): void {
    const el = this.tabEls.get('contracts');
    const board = this.d.quests.board;
    const n = board && this.st && board.station === this.st.id ? board.offers.length : 0;
    if (el) el.innerHTML = `Contracts${n ? `<span class="badge">${n}</span>` : ''}`;
    // Someone here wants you
    const ov = this.tabEls.get('overview');
    const wanted = this.st ? this.d.quests.peopleAt(this.st.id).some((x) => x.mark) : false;
    if (ov) ov.innerHTML = `Overview${wanted ? '<span class="badge">!</span>' : ''}`;
    const hint = this.d.quests.currentHint();
    const tab = hint === 'hangar' ? 'overview' : hint;
    for (const [id, t] of this.tabEls) t.classList.toggle('hint', id === tab && id !== this.tab);
  }

  private now(): number {
    return Date.now() + this.clockSkew;
  }

  /** Orders, against the freshest jobs (the station's) */
  private orders(): OrderPlan[] {
    return this.d.pilot.orders(this.st?.jobs);
  }

  setVendors(m: ServerVendorsMessage): void {
    this.vendors.vendorsMsg = m;
    if (this.win.isOpen && this.tab === 'vendors') this.render();
  }

  setScan(m: ServerMarketScanMessage): void {
    this.market.scan = m;
    if (this.win.isOpen && this.tab === 'market') this.render();
  }

  private render(): void {
    const p = this.d.pilot;
    this.credits.textContent = `${p.credits.toLocaleString()} cr`;
    for (const [id, el] of this.tabEls) el.classList.toggle('on', id === this.tab);
    this.badges();
    this.win.sub.textContent = this.st?.note ?? '';
    const b = this.win.body;
    // A re-render (cargo, credits or the station changing) keeps each scrolling list where it was on the same tab
    const keep = this.renderedTab === this.tab ? scrollsOf(b).map((el) => el.scrollTop) : [];
    this.renderedTab = this.tab;
    b.replaceChildren();
    if (!this.st) { b.innerHTML = '<div class="sgw-empty">Contacting the station…</div>'; return; }
    if (this.tab === 'overview') this.overview.render(b);
    else if (this.tab === 'contracts') this.d.quests.renderBoard(b);
    else if (this.tab === 'ships') this.ships.render(b);
    else if (this.tab === 'market') this.market.render(b);
    else if (this.tab === 'vendors') this.vendors.render(b);
    else if (this.tab === 'refinery') this.refinery.render(b);
    else if (this.tab === 'outpost') this.outpost.render(b);
    else if (this.tab === 'bank') this.bank.render(b);
    else this.fabricator.render(b);
    scrollsOf(b).forEach((el, i) => { if (keep[i]) el.scrollTop = keep[i]; });
  }
}
