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

import {
  ClientMessage, ServerStationMessage, ServerVendorsMessage, ServerMarketScanMessage, Bag, CraftRecipe, ItemCatalog, QuestsFile,
  sellPrice, buyPrice, canCraft, licenceName, partItemId, parsePartItemId, registeredFunction, materialLicensed, MATERIAL_LEVEL, materialUnlockName, isWeaponFn, PIECE_NAMES, RARITY_COLOR, Stack, unitSellPrice, saleTotal,
  FN_NAMES, isStructural, partStats, gradeOf, markName, OrderPlan, OrderLine, JobView, countOf, DOCK_FEE_LEVEL, unlocks,
  socketsFor, cutInputs, gemItemId, CATEGORY_LABEL, WIRE_ITEM, stationLearned, armouryRound, type GemsFile, type StationFile, type Blueprint, type ItemDef, type FunctionDef,
} from '@space-game/common';
import { SHIP_FUNCTIONS } from '../ships/shipFunctionData';
import { FAMILY_LABEL, familyLabel, familyRank, keyStats, modelLock, sizeText, tradeOff } from '../ships/modelCards';
import questsData from '../../../data/quests.json';
import stationsData from '../../../data/stations.json';
import gemsData from '../../../data/gems.json';
import stationData from '../../../data/station.json';

/** Outer-ring stations' docking fees (from DOCK_FEE_LEVEL) */
const DOCK_FEES = new Map((stationsData.stations as { id: string; dockingFee?: number }[]).filter((s) => s.dockingFee).map((s) => [s.id, s.dockingFee!]));

/** Stations with a faction quartermaster */
const VENDOR_STATIONS = new Set(Object.values((questsData as unknown as QuestsFile).reputations).flatMap((r) => r.vendor?.stations ?? []));
import type { PilotState } from '../econ/clientEcon';
import { GameWindow, costHtml, itemTipHtml, showTip, hideTip } from './windowKit';
import { itemIcon, shipIcon } from './itemIcons';
import { storeControls } from './storeControls';
import { shipSummary } from '../ships/shipSummary';
import type { QuestClient } from './QuestUI';
import { boundKeyName } from '../input/keybindings';
import { settings } from '../settings/Settings';

type Tab = 'overview' | 'ships' | 'contracts' | 'market' | 'vendors' | 'refinery' | 'fabricator' | 'outpost';

export interface StationWindowDeps {
  pilot: PilotState;
  send(m: ClientMessage): void;
  sound(id: string, volume?: number): void;
  openHangar(slot?: number): void;
  openInventory(): void;
  onClose(): void;
  quests: QuestClient;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export class StationWindow {
  private win = new GameWindow('Station');
  private tabEls = new Map<Tab, HTMLButtonElement>();
  private tab: Tab = 'overview';
  private renderedTab: Tab | null = null;
  private st:ServerStationMessage | null = null;
  private clockSkew = 0;
  private credits: HTMLSpanElement;
  private timer: number | null = null;
  // Fabricator: a category, what's picked in each (a module's function or a recipe), the module's grade and size, and how many
  private fabCat: FabCat = 'weapons';
  private fabSel: Partial<Record<FabCat, string>> = {};
  private fabMat = 'alloy';
  private fabPiece = '';
  private fabQty = 1;
  // Market
  private sellFilter = '';
  private vendorsMsg: ServerVendorsMessage | null = null;
  private scan: ServerMarketScanMessage | null = null;
  private scanAsked = 0;
  /** Ships cards opened to their full bill */
  private openBills = new Set<number>();

  constructor(private d: StationWindowDeps) {
    this.credits = document.createElement('span');
    this.credits.className = 'sgw-credits';
    this.win.headExtra.append(this.credits);
    this.win.tabs.style.display = 'flex';
    for (const [id, label] of [['overview', 'Overview'], ['ships', 'Ships'], ['contracts', 'Contracts'], ['market', 'Market'], ['vendors', 'Quartermasters'], ['refinery', 'Refinery'], ['fabricator', 'Fabricator'], ['outpost', 'Your station']] as [Tab, string][]) {
      const b = document.createElement('button');
      b.className = 'sgw-tab';
      b.textContent = label;
      b.onclick = () => {
        this.tab = id;
        if (id === 'vendors') this.d.send({ type: 'vendorOpen' });
        if (id === 'market') this.scanAsked = 0;
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
    this.timer = window.setInterval(() => { if (this.tab === 'fabricator' || this.tab === 'refinery' || this.tab === 'overview') this.renderJobsOnly(); }, 500);
  }

  close(): void {
    this.win.close();
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
      const need = id === 'overview' || id === 'contracts' || id === 'ships' || id === 'outpost' ? null : id === 'market' ? 'market' : id;
      el.style.display = !need || m.services.includes(need) ? '' : 'none';
    }
    if (this.tab === 'vendors' ? !VENDOR_STATIONS.has(m.id) : this.tab !== 'overview' && this.tab !== 'contracts' && this.tab !== 'ships' && this.tab !== 'outpost' && !m.services.includes(this.tab)) this.tab = 'overview';
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

  // ---------------------------------------------------------------------------
  // Ships: your hangar slots and the plans you know
  // ---------------------------------------------------------------------------

  private renderShips(b: HTMLElement): void {
    const p = this.d.pilot;
    const econ = p.econ;
    const hs = p.hangar;
    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid; grid-template-columns: 1fr 1fr; gap:14px; height: min(580px, calc(100vh - 230px));';
    const left = document.createElement('div');
    left.className = 'sgw-col';
    left.style.overflowY = 'auto';
    left.innerHTML = '<h4>Hangar <span class="r">your ships and builds</span></h4>';
    const coming = p.coming();
    const orders = this.orders();
    const firstOnOrder = orders.find((o) => o.auto)?.slot;
    (hs?.slots ?? []).forEach((rec, slot) => {
      const card = document.createElement('div');
      card.style.cssText = 'border:1px solid rgba(140,170,220,0.14); border-radius:10px; padding:8px 10px; margin-bottom:6px; background:rgba(4,8,16,0.35); flex-shrink:0;';
      if (!rec) {
        card.style.padding = '4px 6px 4px 10px';
        card.innerHTML = `<div style="display:flex; align-items:center; gap:8px"><b style="color:#56657c">Slot ${slot + 1}</b><span style="color:#56657c">empty</span><span style="flex:1"></span></div>`;
        const open = document.createElement('button');
        open.className = 'sgw-btn';
        open.style.padding = '4px 10px';
        open.textContent = 'Design a ship';
        open.onclick = () => this.d.openHangar(slot);
        card.firstElementChild!.appendChild(open);
        left.appendChild(card);
        return;
      }
      const total = rec.blueprint.parts.length, built = total - rec.ghosts.length;
      const flying = slot === hs!.active;
      const ghostIds = new Set(rec.ghosts);
      const onWay = rec.blueprint.parts.filter((q) => ghostIds.has(q.uid)).reduce((t, q) => t + ((coming[partItemId(q)] ?? 0) > 0 ? 1 : 0), 0);
      const core = rec.blueprint.parts.find((q) => q.fn === 'core');
      const coreBuilt = !!core && !ghostIds.has(core.uid);
      const orderTag = rec.auto ? (rec.paused ? ' · <span style="color:#fbbf24">⏸ on hold</span>' : slot === firstOnOrder ? ' · <span style="color:#7dd3fc">on order · first</span>' : ' · <span style="color:#7dd3fc">on order</span>') : '';
      const status = flying && !rec.ghosts.length ? `<span style="color:#4ade80">✈ flying${rec.loaner ? ' (loaner)' : ''}</span>` : !rec.ghosts.length ? '<span style="color:#4ade80">ready to fly</span>'
        : `<span style="color:${rec.lost ? '#fbbf24' : '#7dd3fc'}">${flying ? '✈ flying · ' : ''}${rec.lost ? 'rebuilding · ' : ''}${built} / ${total} parts built</span>${orderTag || (onWay ? ` · <span style="color:#fbbf24">⏳ parts on the way</span>` : '')}`;
      card.innerHTML = `<div style="display:flex; align-items:baseline; gap:8px"><b>Slot ${slot + 1} · ${esc(rec.blueprint.name)}</b><span style="flex:1"></span>${status}</div>
        <div class="sgw-bar" style="margin:6px 0 8px"><i style="width:${(built / total) * 100}%"></i></div>
        <div class="sgw-needs"></div>
        <div style="display:flex; gap:6px; flex-wrap:wrap"></div>`;
      const plan = orders.find((o) => o.slot === slot);
      if (plan) this.renderNeeds(card.querySelector('.sgw-needs')!, plan);
      const row = card.lastElementChild as HTMLElement;
      const btn = (label: string, cls: string, fn: () => void, title = '') => {
        const x = document.createElement('button');
        x.className = `sgw-btn ${cls}`;
        x.textContent = label;
        x.title = title;
        x.onclick = fn;
        row.appendChild(x);
        return x;
      };
      btn('Open in hangar', '', () => this.d.openHangar(slot));
      if (rec.ghosts.length && !rec.auto) btn('Put on order', 'primary', () => this.d.send({ type: 'slotBuild', slot }), 'Refine your ore, fabricate the modules and fit everything, as far as your materials go');
      if (rec.ghosts.length && rec.auto) {
        const order = (action: 'pause' | 'resume' | 'cancel' | 'top') => () => { this.d.send({ type: 'slotOrder', slot, action }); this.d.sound('ui_click', 0.4); };
        if (rec.paused) btn('▶ Resume', 'primary', order('resume'), 'Carry on: its jobs pick up where they left off');
        else btn('⏸ Hold', '', order('pause'), 'Start nothing new for it, and hold its jobs (others move up)');
        if (slot !== firstOnOrder) btn('⇧ Do first', '', order('top'), 'Work this order first: it takes what it needs before the others, and its jobs go to the front of their queues');
        if (!rec.lost) btn('Call off', '', order('cancel'), 'Take it off order: its queued jobs stop and their materials go back to storage (parts already fitted stay)');
      }
      if (!flying) {
        const flyable = coreBuilt && !rec.lost;
        const fly = btn('Fly', 'good', () => this.d.send({ type: 'slotFly', slot }), flyable ? 'Swap to this ship' : rec.lost ? 'Being rebuilt: fly it once it is whole' : 'Build its core first');
        if (!flyable) fly.classList.add('off');
      }
      left.appendChild(card);
    });

    const right = document.createElement('div');
    right.className = 'sgw-col';
    right.style.overflowY = 'auto';
    const empty = (hs?.slots ?? []).findIndex((s) => !s);
    const plans = (p.profile?.plans ?? []).map((f) => ({ f, bp: econ.plans[f] })).filter((x) => x.bp).sort((a, c) => a.bp.parts.length - c.bp.parts.length);
    right.innerHTML = `<h4>Your ship plans <span class="r">${empty < 0 ? 'no empty hangar slot' : `build one in slot ${empty + 1}`}</span></h4>`;
    if (!plans.length) right.innerHTML += '<div class="sgw-empty" style="padding:8px">No plans yet. Design a ship in the hangar.</div>';
    for (const { f, bp } of plans) right.appendChild(this.planRow(bp, empty, f));
    // Designs saved in the hangar's design slots
    const designs = hs?.designs ?? [];
    const saved = designs.map((bp, i) => ({ bp, i })).filter((x): x is { bp: Blueprint; i: number } => !!x.bp);
    right.insertAdjacentHTML('beforeend', `<h4 style="margin-top:12px">Your designs <span class="r">${designs.length ? `${saved.length} / ${designs.length} slots · save them in the hangar` : 'save them in the hangar'}</span></h4>`);
    if (!saved.length) right.insertAdjacentHTML('beforeend', '<div class="sgw-empty" style="padding:8px">None saved yet. In the hangar, Designs saves the ship you\'re drawing for later.</div>');
    for (const { bp, i } of saved) right.appendChild(this.planRow(bp, empty, undefined, `D${i + 1}`));
    grid.append(left, right);
    b.appendChild(grid);
  }

  /** A plan or saved design in one compact row: silhouette, what it is, what it takes, and Build */
  private planRow(bp: Blueprint, empty: number, plan: string | undefined, tag = ''): HTMLElement {
    const p = this.d.pilot, econ = p.econ;
    const count = (fn: string) => bp.parts.filter((q) => q.fn === fn).length;
    const guns = bp.parts.filter((q) => isWeaponFn(q.fn)).length;
    const n = bp.parts.length;
    const size = n <= 20 ? 'small' : n <= 60 ? 'medium' : n <= 150 ? 'large' : 'capital';
    const facts = [`${n} parts`, size, guns ? `${guns} gun${guns > 1 ? 's' : ''}` : 'unarmed',
      count('cargo') ? `${count('cargo')} cargo` : '', count('miner') ? 'mining' : '', count('armor') ? `${count('armor')} armour` : '']
      .filter(Boolean).join(' · ');
    const cost = econ.recipes.raw(Object.entries(econ.designParts(bp)).reduce((acc, [id, k]) => {
      for (const [kk, m] of Object.entries(econ.recipes.recipeFor(id)?.inputs ?? {})) acc[kk] = (acc[kk] ?? 0) + m * k;
      return acc;
    }, {} as Bag));
    for (const k of Object.keys(cost)) cost[k] = Math.ceil(cost[k]);
    // Parts you neither have nor can make yet (licences)
    const locked = [...new Set(bp.parts.map((q) => partItemId(q)).filter((id) => this.have(id) <= 0 && !p.canMake(id)))];
    const rating = this.rating(bp);
    const row = document.createElement('div');
    row.style.cssText = 'display:flex; align-items:center; gap:10px; padding:5px 8px; margin-bottom:5px; flex-shrink:0; border-radius:9px; border:1px solid rgba(140,170,220,0.12); background:rgba(4,8,16,0.35);';
    const clip = 'white-space:nowrap; overflow:hidden; text-overflow:ellipsis';
    row.innerHTML = `<img src="${shipIcon(econ, bp.parts, 38)}" style="width:38px; height:38px; flex-shrink:0">`
      + `<div style="flex:1; min-width:0"><div style="${clip}">${tag ? `<span style="color:#56657c; font-size:11px">${tag}</span> ` : ''}<b>${esc(bp.name)}</b>${rating ? ` <span style="color:#7dd3fc; font-size:11px" title="Rating">◆ ${rating.toLocaleString()}</span>` : ''}`
      + ` <span style="color:#8394ad; font-size:11px">${facts}</span></div>`
      + `<div style="font-size:11px; ${clip}">${locked.length ? `<span style="color:#fca5a5">🔒 Needs a licence: ${locked.slice(0, 2).map((id) => esc(econ.items.name(id))).join(', ')}${locked.length > 2 ? '…' : ''}</span>` : costHtml(econ, cost, (id) => this.have(id))}</div></div>`;
    row.addEventListener('mousemove', (e) => showTip(`<div class="t-n">${esc(bp.name)}</div><div class="t-c">${facts}${rating ? ` · ◆ ${rating}` : ''}</div>`
      + `<div class="t-d" style="margin-top:4px">Raw materials (have / need):</div><div style="margin-top:3px; line-height:1.9">${costHtml(econ, cost, (id) => this.have(id))}</div>`
      + (locked.length ? `<div class="t-h" style="color:#fca5a5">Needs a licence for: ${locked.map((id) => esc(econ.items.name(id))).join(', ')}</div>` : ''), e.clientX, e.clientY));
    row.addEventListener('mouseleave', hideTip);
    const go = document.createElement('button');
    go.className = 'sgw-btn primary' + (empty < 0 || locked.length ? ' off' : '');
    go.style.cssText = 'padding:5px 10px; white-space:nowrap;';
    go.textContent = empty < 0 ? 'No empty slot' : locked.length ? 'Licence needed' : `Build in slot ${empty + 1}`;
    go.onclick = () => { this.d.send({ type: 'slotSave', slot: empty, blueprint: JSON.parse(JSON.stringify(bp)), ...(plan ? { plan } : {}) }); this.d.sound('ui_click', 0.5); };
    row.appendChild(go);
    return row;
  }

  /** A design's rating (cached: it builds the ship to work it out) */
  private ratings = new WeakMap<Blueprint, number>();
  private rating(bp: Blueprint): number {
    let r = this.ratings.get(bp);
    if (r === undefined) {
      const econ = this.d.pilot.econ;
      r = econ.tuning ? Math.round(shipSummary(econ.ships, econ.tuning, econ, bp)?.rating ?? 0) : 0;
      this.ratings.set(bp, r);
    }
    return r;
  }

  private now(): number {
    return Date.now() + this.clockSkew;
  }

  /** Orders, against the freshest jobs (the station's) */
  private orders(): OrderPlan[] {
    return this.d.pilot.orders(this.st?.jobs);
  }

  /** A ship's needs: what to gather at a glance, and (opened) every item down to ore */
  private renderNeeds(el: HTMLElement, plan: OrderPlan): void {
    const econ = this.d.pilot.econ;
    const gather = Object.entries(plan.gather);
    const lines = plan.lines.filter((l) => l.need > 0);
    const parts = lines.filter((l) => l.stage === 'part');
    const ready = lines.filter((l) => l.stage !== 'ore').reduce((t, l) => t + l.ready, 0);
    const making = lines.filter((l) => l.stage !== 'ore').reduce((t, l) => t + l.coming, 0);
    const locked = parts.filter((l) => l.blocked === 'schematic');
    const inHold = gather.filter(([id]) => countOf(this.d.pilot.cargo, id) > 0);
    const open = this.openBills.has(plan.slot);
    el.innerHTML = `<div style="font-size:12px; margin:-2px 0 6px; line-height:1.7">`
      + (gather.length
        ? `<span style="color:#fca5a5">To gather:</span> ${gather.map(([id, n]) => `<span class="sgw-cost short" title="${esc(econ.items.name(id))}: ${n} more"><img src="${itemIcon(econ, id)}">${n} ${esc(shortName(econ.items.name(id)))}</span>`).join('')}`
        : locked.length ? '' : '<span style="color:#86efac">✓ Everything it needs is in storage or being made</span>')
      + (locked.length ? `<div style="color:#fca5a5">🔒 Not open yet (a level away): ${locked.map((l) => esc(econ.items.name(l.id))).join(', ')}</div>` : '')
      + (inHold.length ? `<div style="color:#fbbf24; font-size:11px">Some of that is in your hold: orders use storage, so store it (Inventory)</div>` : '')
      + `<div style="color:#8394ad; font-size:11px">${ready ? `${ready} ready in storage · ` : ''}${making ? `${making} being made · ` : ''}<a href="#" data-bill style="color:#7dd3fc">${open ? 'Hide' : 'Show'} the full bill</a></div></div>`
      + (open ? this.billHtml(lines) : '');
    el.querySelector<HTMLElement>('[data-bill]')!.onclick = (e) => {
      e.preventDefault();
      if (open) this.openBills.delete(plan.slot); else this.openBills.add(plan.slot);
      this.render();
    };
  }

  /** Every line of an order: parts, then what they're made from, then ore */
  private billHtml(lines: OrderLine[]): string {
    const econ = this.d.pilot.econ;
    const stages: [OrderLine['stage'], string][] = [['part', 'Parts'], ['material', 'Materials'], ['ore', 'Ore']];
    return `<div style="border-top:1px solid rgba(140,170,220,0.1); padding-top:6px; margin-bottom:8px; font-size:12px">`
      + stages.map(([stage, label]) => {
        const ls = lines.filter((l) => l.stage === stage);
        if (!ls.length) return '';
        return `<div style="color:#56657c; font-size:10px; letter-spacing:1.5px; text-transform:uppercase; margin:6px 0 2px">${label}</div>`
          + ls.map((l) => `<div style="display:flex; align-items:center; gap:6px; padding:2px 0">`
            + `<img src="${itemIcon(econ, l.id)}" style="width:18px; height:18px">`
            + `<span style="flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap" title="For ${esc(forText(l))}">${l.need} × ${esc(econ.items.name(l.id))}</span>`
            + `<span style="white-space:nowrap">${lineStatus(l)}</span></div>`).join('');
      }).join('') + '</div>';
  }

  /** What hangar orders want from this queue but can't start yet (refinery: materials; fabricator: modules) */
  private waitingHtml(stage: 'material' | 'part'): string {
    const econ = this.d.pilot.econ;
    const rows: string[] = [];
    for (const o of this.orders()) {
      if (!o.auto) continue;
      for (const l of o.lines) {
        if (l.stage !== stage || (!l.waiting && l.blocked !== 'schematic')) continue;
        const n = l.waiting || l.short;
        let why = '';
        if (l.blocked === 'schematic') why = '<span style="color:#fca5a5">🔒 not open yet</span>';
        else if (l.blocked === 'queue') why = `<span style="color:#8394ad">next, when a ${stage === 'material' ? 'refinery' : 'fabricator'} slot frees</span>`;
        else {
          // What it's short of: for a material, its ore; for a module, its materials
          const inputs: Record<string, number> = {};
          if (stage === 'material') {
            const r = econ.recipes.refining.get(l.id);
            for (const [id, k] of Object.entries(r?.inputs ?? {})) inputs[id] = k * Math.ceil(n / Math.max(1, r!.out));
          } else {
            const r = econ.recipes.recipeFor(l.id);
            for (const [id, k] of Object.entries(r?.inputs ?? {})) inputs[id] = k * Math.ceil(n / Math.max(1, r!.out[l.id] ?? 1));
          }
          why = `<span style="color:#fbbf24">needs</span> ${costHtml(econ, inputs, (id) => countOf(this.d.pilot.storage, id))}`;
        }
        rows.push(`<div style="margin:6px 0 9px; font-size:12px"><div style="display:flex; align-items:center; gap:6px">`
          + `<img src="${itemIcon(econ, l.id)}" style="width:20px; height:20px"><span style="flex:1">${n} × ${esc(econ.items.name(l.id))}</span>`
          + `<span style="color:${o.paused ? '#fbbf24' : '#7dd3fc'}; font-size:11px; white-space:nowrap">${esc(o.name)}${o.paused ? ' ⏸' : ''}</span></div>`
          + `<div style="color:#8394ad; font-size:11px; margin:2px 0 0 26px">for ${esc(forText(l))}</div>`
          + `<div style="font-size:11px; margin:2px 0 0 26px">${why}</div></div>`);
      }
    }
    if (!rows.length) return '';
    return `<h4 style="margin-top:14px">Waiting <span class="r">orders that can't start yet</span></h4>${rows.join('')}`;
  }

  private have(id: string): number {
    return this.d.pilot.count(id);
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
    if (this.tab === 'overview') this.renderOverview(b);
    else if (this.tab === 'contracts') this.d.quests.renderBoard(b);
    else if (this.tab === 'ships') this.renderShips(b);
    else if (this.tab === 'market') this.renderMarket(b);
    else if (this.tab === 'vendors') this.renderVendors(b);
    else if (this.tab === 'refinery') this.renderRefinery(b);
    else if (this.tab === 'outpost') this.renderOutpost(b);
    else this.renderFabricator(b);
    scrollsOf(b).forEach((el, i) => { if (keep[i]) el.scrollTop = keep[i]; });
  }

  // ---------------------------------------------------------------------------
  // Overview
  // ---------------------------------------------------------------------------

  private renderOverview(b: HTMLElement): void {
    const p = this.d.pilot;
    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid; grid-template-columns: 1.2fr 1fr; gap:14px;';

    const left = document.createElement('div');
    left.className = 'sgw-col';
    left.innerHTML = `<h4>Your ship</h4>`;
    const r = p.rebuild;
    const status = document.createElement('div');
    status.style.cssText = 'line-height:1.6; color:#a9b6c9; margin-bottom:12px;';
    if (r && r.missing > 0) {
      const free = p.profile && p.profile.level < r.freeBelowLevel;
      status.innerHTML = `<b style="color:#fbbf24">${r.missing} part${r.missing > 1 ? 's' : ''} missing.</b> The station's crews rebuild them one at a time while you're here.<br>`
        + (free ? '<span style="color:#86efac">New pilot: rebuilds are free until level ' + r.freeBelowLevel + '.</span>'
          : `Next part needs ${costHtml(p.econ, r.next, (id) => this.have(id))}`
          + (r.aid ? `<br><span style="color:#fcd34d">You can't cover the ${r.credits} cr right now, so the station lends it: a share of what you earn pays it back.</span>`
            : Object.keys(r.short).length ? `<br><span style="color:#fcd34d">You're short of minerals: the station supplies them for ${r.credits} cr a part.</span>` : ''));
    } else {
      status.innerHTML = 'Hull sound. Damaged parts are repaired for free while you\'re near a station.';
    }
    const debt = p.profile?.debt ?? 0;
    if (debt > 0) status.innerHTML += `<br><span style="color:#fca5a5">Rebuild loan: ${debt.toLocaleString()} cr owed, repaid from a quarter of everything you earn.</span>`;
    left.append(status);
    const row = document.createElement('div');
    row.style.cssText = 'display:flex; gap:8px; flex-wrap:wrap;';
    const hangar = document.createElement('button');
    hangar.className = 'sgw-btn primary';
    hangar.textContent = 'Open hangar';
    hangar.onclick = () => this.d.openHangar();
    if (this.d.quests.currentHint() === 'hangar') hangar.classList.add('hint');
    const inv = document.createElement('button');
    inv.className = 'sgw-btn';
    inv.textContent = `Cargo & storage (${boundKeyName('inventory', settings.data.bindings)})`;
    inv.onclick = () => this.d.openInventory();
    row.append(hangar, inv);
    left.append(row);

    // Quick sell: cargo full of ore? one click
    const ore = p.cargo.filter((s) => ['mineral', 'gem', 'volatile'].includes(p.econ.items.get(s.id)?.category ?? ''));
    if (ore.length && this.st!.services.includes('market')) {
      const total = ore.reduce((t, s) => t + saleTotal(p.econ.items, s.id, s.n, this.st!.demand[s.id] ?? 1, this.st!.sat?.[s.id] ?? 0), 0);
      const qs = document.createElement('div');
      qs.style.cssText = 'margin-top:14px; padding-top:12px; border-top:1px solid rgba(140,170,220,0.12); display:flex; align-items:center; gap:10px;';
      qs.innerHTML = `<span style="color:#a9b6c9">Ore in your hold: ${costHtml(p.econ, Object.fromEntries(ore.map((s) => [s.id, s.n])))}</span>`;
      const sell = document.createElement('button');
      sell.className = 'sgw-btn good';
      sell.style.marginLeft = 'auto';
      sell.textContent = `Sell all ore · ${total.toLocaleString()} cr`;
      sell.onclick = () => { for (const s of ore) this.d.send({ type: 'marketSell', id: s.id, n: s.n }); this.d.sound('sell', 0.7); };
      qs.append(sell);
      left.append(qs);
    }
    // Quick storage: ammunition, your loadout and utility stay aboard unless you say everything
    if (p.cargo.length) {
      const sc = document.createElement('div');
      sc.style.cssText = 'margin-top:12px; padding-top:12px; border-top:1px solid rgba(140,170,220,0.12);';
      sc.innerHTML = '<div style="color:#8394ad; font-size:11px; margin-bottom:6px">Your hold to storage <span style="color:#56657c">· ammunition, your loadout and utility stay aboard unless you store everything</span></div>';
      sc.append(storeControls(p, (m) => this.d.send(m), (id) => this.d.sound(id, 0.4)));
      left.append(sc);
    }

    const right = document.createElement('div');
    right.className = 'sgw-col';
    // Who's here to talk to: ! has a job for you, ▸ a job of yours needs them
    const people = this.d.quests.peopleAt(this.st!.id);
    if (people.length) {
      const ph = document.createElement('div');
      ph.innerHTML = '<h4>People here <span class="r">talk to them for work</span></h4>';
      for (const person of people) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex; align-items:center; gap:10px; padding:6px 8px; margin-bottom:6px; border-radius:9px; border:1px solid rgba(140,170,220,0.12); background:rgba(4,8,16,0.35);';
        const mark = person.mark === 'offer' ? '<b style="color:#fbbf24" title="Has work for you">!</b>' : person.mark === 'step' ? '<b style="color:#fbbf24" title="A job of yours needs them">▸</b>' : '';
        row.innerHTML = `<span style="width:10px; height:10px; border-radius:50%; background:${person.color}; box-shadow:0 0 8px ${person.color}"></span>
          <div style="flex:1; min-width:0"><b style="color:#e5ecf7">${esc(person.name)}</b> ${mark}<div style="color:#8394ad; font-size:11px">${esc(person.title)}</div></div>`;
        const talk = document.createElement('button');
        talk.className = `sgw-btn${person.mark ? ' primary' : ''}`;
        talk.textContent = 'Talk';
        talk.onclick = () => { this.d.quests.talk(person.id); this.d.sound('ui_click', 0.4); };
        row.appendChild(talk);
        ph.appendChild(row);
      }
      right.appendChild(ph);
    }
    right.insertAdjacentHTML('beforeend', `<h4>Services</h4>`);
    const list = document.createElement('div');
    list.style.cssText = 'line-height:1.9; color:#a9b6c9;';
    const sv = this.st!.services;
    const line = (on: boolean, name: string, text: string) => `<div style="opacity:${on ? 1 : 0.4}">${on ? '●' : '○'} <b style="color:#e5ecf7">${name}</b> · ${text}</div>`;
    list.innerHTML = line(sv.includes('repair'), 'Repair', 'heals and rebuilds your ship')
      + line(sv.includes('storage'), 'Storage', 'shared between all stations')
      + line(sv.includes('market'), 'Market', 'buy and sell')
      + line(sv.includes('refinery'), 'Refinery', 'ore into plate and wire')
      + line(sv.includes('fabricator'), 'Fabricator', 'build parts and equipment');
    const fee = DOCK_FEES.get(this.st!.id);
    if (fee) list.innerHTML += line((this.d.pilot.profile?.level ?? 0) >= DOCK_FEE_LEVEL, 'Docking fee', `${fee} cr a visit from level ${DOCK_FEE_LEVEL} (outer ring)`);
    right.append(list);
    const jobs = document.createElement('div');
    jobs.dataset.jobs = '1';
    right.append(jobs);
    grid.append(left, right);
    b.append(grid);
    this.renderJobsOnly();
  }

  // ---------------------------------------------------------------------------
  // Market
  // ---------------------------------------------------------------------------

  private renderMarket(b: HTMLElement): void {
    const p = this.d.pilot;
    const items = p.econ.items;
    const st = this.st!;
    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid; grid-template-columns: 1fr 1fr; gap:14px; height: min(560px, calc(100vh - 230px));';

    // Sell: everything you have
    const sellCol = document.createElement('div');
    sellCol.className = 'sgw-col';
    sellCol.innerHTML = `<h4>Sell <span class="r">from cargo, then storage</span></h4>`;
    const oreInHold = p.cargo.filter((s) => items.get(s.id)?.category === 'mineral').reduce((t, s) => t + s.n, 0);
    // This market cycle: what's wanted here, and what's glutted
    const cyc = document.createElement('div');
    cyc.style.cssText = 'grid-column: 1 / -1; display:flex; flex-wrap:wrap; gap:6px 14px; align-items:center; color:#a9b6c9; font-size:12px; padding:2px 2px 4px;';
    const mins = Math.round((st.cycleEndsIn ?? 0) / 60000);
    const chips = (ids: string[] | undefined, color: string) => (ids ?? []).map((id) => `<span style="color:${color}; border:1px solid ${color}55; border-radius:999px; padding:1px 8px">${esc(items.name(id))} ${Math.round(((st.demand[id] ?? 1) - 1) * 100) > 0 ? '+' : ''}${Math.round(((st.demand[id] ?? 1) - 1) * 100)}%</span>`).join('');
    cyc.innerHTML = `<b style="color:#86efac">WANTED HERE</b>${chips(st.wanted, '#86efac') || '<span>nothing special</span>'}<b style="color:#fca5a5; margin-left:8px">GLUTTED</b>${chips(st.glut, '#fca5a5') || '<span>nothing</span>'}`
      + `<span style="margin-left:auto; color:#8394ad">Market cycle turns in ${mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`} · selling a lot of one thing drives its price down for a while</span>`;
    grid.appendChild(cyc);
    grid.style.gridTemplateRows = 'auto 1fr';
    if (oreInHold) {
      const all = document.createElement('button');
      all.className = 'sgw-btn good';
      all.style.marginBottom = '8px';
      const worth = p.cargo.filter((s) => items.get(s.id)?.category === 'mineral').reduce((t, s) => t + saleTotal(items, s.id, s.n, st.demand[s.id] ?? 1, st.sat?.[s.id] ?? 0), 0);
      all.textContent = `Sell all ore in your hold (${oreInHold}) · ${worth.toLocaleString()} cr`;
      all.onclick = () => { this.d.send({ type: 'marketSellAll' }); this.d.sound('sell', 0.6); };
      sellCol.appendChild(all);
    }
    const search = document.createElement('input');
    search.className = 'sgw-input';
    search.placeholder = 'Filter…';
    search.value = this.sellFilter;
    search.style.marginBottom = '8px';
    search.oninput = () => { this.sellFilter = search.value; listSell(); };
    const sellList = document.createElement('div');
    sellList.style.cssText = 'overflow-y:auto; flex:1;';
    sellCol.append(search, sellList);
    const merged: Bag = {};
    for (const s of [...p.cargo, ...p.storage]) merged[s.id] = (merged[s.id] ?? 0) + s.n;
    const here = (id: string) => unitSellPrice(items, id, st.demand[id] ?? 1, st.sat?.[id] ?? 0);
    const listSell = () => {
      const q = this.sellFilter.trim().toLowerCase();
      const ids = Object.keys(merged).filter((id) => !q || items.name(id).toLowerCase().includes(q))
        .sort((a, b) => here(b) * merged[b] - here(a) * merged[a]);
      sellList.replaceChildren(...ids.map((id) => this.marketRow(id, merged[id], here(id), 'sell', st.demand[id])));
      if (!ids.length) sellList.innerHTML = '<div class="sgw-empty">Nothing to sell</div>';
    };
    listSell();
    // Where pays more (asked now and then)
    const ids = Object.keys(merged).filter((id) => (items.get(id)?.value ?? 0) > 0);
    if (ids.length && performance.now() - this.scanAsked > 20000) {
      this.scanAsked = performance.now();
      this.d.send({ type: 'marketScan', items: ids });
    }

    const buyCol = document.createElement('div');
    buyCol.className = 'sgw-col';
    buyCol.innerHTML = `<h4>Buy <span class="r">delivered to storage</span></h4>`;
    const buyList = document.createElement('div');
    buyList.style.cssText = 'overflow-y:auto; flex:1;';
    buyList.replaceChildren(...st.sells.map((id) => this.marketRow(id, this.have(id), buyPrice(items, id), 'buy')));
    if (!st.sells.length) buyList.innerHTML = '<div class="sgw-empty">This station has nothing for sale</div>';
    buyCol.append(buyList);
    grid.append(sellCol, buyCol);
    b.append(grid);
  }

  private marketRow(id: string, have: number, price: number, mode: 'sell' | 'buy', demand?: number): HTMLElement {
    const items = this.d.pilot.econ.items;
    const d = items.get(id);
    const row = document.createElement('div');
    row.style.cssText = 'display:flex; align-items:center; gap:10px; padding:6px 4px; border-bottom:1px solid rgba(140,170,220,0.07);';
    const img = document.createElement('img');
    img.src = itemIcon(this.d.pilot.econ, id);
    img.style.cssText = 'width:34px; height:34px; flex-shrink:0;';
    const name = document.createElement('div');
    name.style.cssText = 'flex:1; min-width:0;';
    const st = this.st!;
    const wanted = mode === 'sell' && st.wanted?.includes(id), glut = mode === 'sell' && st.glut?.includes(id);
    let tag = demand && demand !== 1 ? ` <small style="color:${demand > 1 ? '#86efac' : '#fca5a5'}">${wanted ? 'WANTED ' : glut ? 'GLUT ' : ''}${demand > 1 ? '+' : ''}${Math.round((demand - 1) * 100)}%</small>` : '';
    const sat = mode === 'sell' ? st.sat?.[id] ?? 0 : 0;
    const base = mode === 'sell' ? unitSellPrice(items, id, demand ?? 1, 0) : price;
    if (sat > 0 && base > 0 && price < base * 0.97) tag += ` <small style="color:#fbbf24" title="Lots sold here lately: the price recovers over the next half hour or so">saturated −${Math.round((1 - price / base) * 100)}%</small>`;
    // Better prices elsewhere
    const best = mode === 'sell' ? this.scan?.best[id]?.[0] : undefined;
    const elsewhere = best && best.price > price * 1.08 ? ` · <span style="color:#7dd3fc" title="${esc(this.scan!.best[id].map((b) => `${b.name} (${b.system}): ${b.price} cr`).join('\n'))}">pays ${best.price} at ${esc(best.name)}</span>` : '';
    name.innerHTML = `<div style="color:${d ? RARITY_COLOR[d.rarity] : '#ccc'}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis">${esc(items.name(id))}${tag}</div>`
      + `<div style="color:#8394ad; font-size:11px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis">${mode === 'sell' ? `have ${have}` : have ? `you have ${have}` : '&nbsp;'} · <span class="sgw-credits">${price.toLocaleString()} cr</span> each${elsewhere}</div>`;
    row.append(img, name);
    row.addEventListener('mousemove', (e) => showTip(itemTipHtml(this.d.pilot.econ, id, { count: have }), e.clientX, e.clientY));
    row.addEventListener('mouseleave', hideTip);
    const amounts = mode === 'sell' ? [1, 10, have] : [1, 5, 20];
    for (const n of [...new Set(amounts)].filter((n) => n > 0 && (mode === 'buy' || n <= have))) {
      const btn = document.createElement('button');
      btn.className = 'sgw-btn' + (mode === 'sell' ? '' : ' primary');
      btn.style.padding = '5px 9px';
      const all = mode === 'sell' && n === have && have > 10;
      btn.textContent = all ? `All` : `${mode === 'sell' ? 'Sell' : 'Buy'} ${n}`;
      btn.title = `${(mode === 'sell' ? saleTotal(items, id, n, demand ?? 1, this.st?.sat?.[id] ?? 0) : price * n).toLocaleString()} cr`;
      if (mode === 'buy' && this.d.pilot.credits < price * n) btn.classList.add('off');
      btn.onclick = () => {
        this.d.send(mode === 'sell' ? { type: 'marketSell', id, n } : { type: 'marketBuy', id, n });
        this.d.sound(mode === 'sell' ? 'sell' : 'credits', 0.6);
      };
      row.appendChild(btn);
    }
    return row;
  }

  setVendors(m: ServerVendorsMessage): void {
    this.vendorsMsg = m;
    if (this.win.isOpen && this.tab === 'vendors') this.render();
  }

  setScan(m: ServerMarketScanMessage): void {
    this.scan = m;
    if (this.win.isOpen && this.tab === 'market') this.render();
  }

  // ---------------------------------------------------------------------------
  // Faction quartermasters
  // ---------------------------------------------------------------------------

  private renderVendors(b: HTMLElement): void {
    const m = this.vendorsMsg;
    if (!m || m.station !== this.st?.id) { b.innerHTML = '<div class="sgw-empty">Calling the quartermasters…</div>'; return; }
    const items = this.d.pilot.econ.items;
    const wrap = document.createElement('div');
    wrap.style.cssText = `display:grid; grid-template-columns: repeat(${Math.min(2, m.vendors.length)}, 1fr); gap:14px;`;
    for (const v of m.vendors) {
      const col = document.createElement('div');
      col.className = 'sgw-col';
      const toNext = v.next !== undefined ? Math.max(0, Math.min(100, ((v.standing - [0, 5, 15, 35, 70, 120][Math.max(0, v.rank)]) / Math.max(1, v.next - [0, 5, 15, 35, 70, 120][Math.max(0, v.rank)])) * 100)) : 100;
      col.innerHTML = `<h4>${esc(v.name)}<span class="r">${esc(v.rankName)} · standing ${v.standing}${v.discount ? ` · ${Math.round(v.discount * 100)}% off` : ''}</span></h4>
        <div style="color:#8394ad; font-size:12px; margin-bottom:4px">${esc(v.description)}</div>
        <div class="sgw-bar"><i style="width:${toNext}%"></i></div>
        <div style="color:#8394ad; font-size:11px; margin:-6px 0 8px">${v.next !== undefined ? `${v.next - v.standing} more standing to ${esc(v.nextName ?? '')}: their jobs and bounties pay it` : 'The highest rank they give'}</div>`;
      for (const s of v.stock) {
        const d = items.get(s.item);
        const row = document.createElement('div');
        row.style.cssText = `display:flex; align-items:center; gap:10px; padding:6px 4px; border-bottom:1px solid rgba(140,170,220,0.07); opacity:${s.locked ? 0.55 : 1}`;
        row.innerHTML = `<img src="${itemIcon(this.d.pilot.econ, s.item)}" style="width:32px; height:32px; flex-shrink:0">
          <div style="flex:1; min-width:0"><div style="color:${d ? RARITY_COLOR[d.rarity] : '#ccc'}">${esc(items.name(s.item))}</div>
          <div style="color:#8394ad; font-size:11px">${s.locked ? `🔒 needs ${esc(s.rankName)}` : `<span class="sgw-credits">${s.price.toLocaleString()} cr</span>`}</div></div>`;
        row.addEventListener('mousemove', (e) => showTip(itemTipHtml(this.d.pilot.econ, s.item, { count: this.have(s.item) }), e.clientX, e.clientY));
        row.addEventListener('mouseleave', hideTip);
        if (!s.locked) {
          const btn = document.createElement('button');
          btn.className = 'sgw-btn primary';
          btn.style.padding = '5px 10px';
          btn.textContent = 'Buy';
          if (this.d.pilot.credits < s.price) btn.classList.add('off');
          btn.onclick = () => { this.d.send({ type: 'vendorBuy', faction: v.faction, item: s.item, n: 1 }); this.d.sound('credits', 0.6); };
          row.appendChild(btn);
        }
        col.appendChild(row);
      }
      wrap.appendChild(col);
    }
    if (!m.vendors.length) wrap.innerHTML = '<div class="sgw-empty">No quartermasters here.</div>';
    b.appendChild(wrap);
  }

  // ---------------------------------------------------------------------------
  // Refinery
  // ---------------------------------------------------------------------------

  private renderRefinery(b: HTMLElement): void {
    const econ = this.d.pilot.econ;
    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid; grid-template-columns: 1fr 300px; gap:14px; height: min(580px, calc(100vh - 230px));';
    const col = document.createElement('div');
    col.className = 'sgw-col';
    col.style.overflowY = 'auto';
    col.innerHTML = '<h4>Refinery <span class="r">ore from cargo and storage · plate to storage as each batch finishes</span></h4>';
    const level = this.d.pilot.profile?.level ?? 1;
    for (const r of econ.recipes.refining.values()) {
      const locked = !!r.level && level < r.level;
      const max = locked ? 0 : Math.min(...Object.entries(r.inputs).map(([id, n]) => Math.floor(this.have(id) / n)));
      const row = document.createElement('div');
      row.style.cssText = `display:flex; align-items:center; gap:12px; padding:9px 4px; border-bottom:1px solid rgba(140,170,220,0.07);${locked ? ' opacity:0.5;' : ''}`;
      row.innerHTML = `<div style="flex:1">${costHtml(econ, r.inputs, (id) => this.have(id))}</div><div style="color:#7dd3fc; font-size:18px">→</div>`
        + `<div style="width:200px; display:flex; align-items:center; gap:6px"><img src="${itemIcon(econ, r.id)}" style="width:30px;height:30px"><span>${r.out} × ${esc(econ.items.name(r.id))}<br><small style="color:#8394ad">${r.time ?? 2}s a batch</small></span></div>`;
      // The buttons in a fixed-width column, so every row's arrow and output line up
      const acts = document.createElement('div');
      acts.style.cssText = 'width:200px; display:flex; justify-content:flex-end; align-items:center; gap:8px;';
      row.appendChild(acts);
      for (const n of [1, 10, max]) {
        if (n <= 0 || (n === max && (max === 1 || max === 10))) continue;
        const btn = document.createElement('button');
        btn.className = 'sgw-btn' + (n === max ? ' primary' : '');
        btn.textContent = n === max ? `Max (${max})` : `×${n}`;
        if (n > max) btn.classList.add('off');
        btn.title = `${n * r.out} × ${econ.items.name(r.id)}: ${fmt((r.time ?? 2) * n)}`;
        btn.onclick = () => { this.d.send({ type: 'refine', recipe: r.id, batches: n }); this.d.sound('ui_click', 0.4); };
        acts.appendChild(btn);
      }
      if (max <= 0) {
        const no = document.createElement('span');
        no.style.cssText = 'color:#56657c; font-size:12px; width:70px; text-align:right';
        no.textContent = locked ? `level ${r.level}` : 'need ore';
        acts.appendChild(no);
      }
      col.appendChild(row);
    }
    const side = document.createElement('div');
    side.className = 'sgw-col';
    side.innerHTML = `<h4>Refining <span class="r">${this.st!.jobs.filter((j) => j.recipe.startsWith('refine:')).length} / ${unlocks({ level, skills: this.d.pilot.profile?.skills }).refinerySlots}</span></h4>`;
    side.style.overflowY = 'auto';
    const jobs = document.createElement('div');
    jobs.dataset.jobs = 'refine';
    const waiting = document.createElement('div');
    waiting.innerHTML = this.waitingHtml('material');
    side.append(jobs, waiting);
    const note = document.createElement('div');
    note.style.cssText = 'margin-top:auto; color:#56657c; font-size:11px; line-height:1.5; padding-top:10px;';
    note.textContent = 'Refining takes a while, and keeps going while you\'re away. Ships on order in the hangar queue their own refining.';
    side.append(note);
    grid.append(col, side);
    b.append(grid);
    this.renderJobsOnly();
  }

  // ---------------------------------------------------------------------------
  // Fabricator
  // ---------------------------------------------------------------------------

  /** Gems: cut them here (they take a while, and can fail), and set them into the guns of the ship you fly */
  private renderGems(main: HTMLElement): void {
    const econ = this.d.pilot.econ, p = this.d.pilot;
    const level = p.profile?.level ?? 1;
    const list = document.createElement('div');
    list.style.cssText = 'overflow-y:auto; flex:1;';
    const row = (html: string) => { const r = document.createElement('div'); r.style.cssText = 'display:flex; align-items:center; gap:10px; padding:7px 4px; border-bottom:1px solid rgba(140,170,220,0.07);'; r.innerHTML = html; return r; };
    // Sockets on the ship you fly
    const slot = p.hangar?.active ?? 0, bp = p.hangar?.slots[slot]?.blueprint;
    const held = [...new Set([...p.cargo, ...p.storage].map((s) => s.id).filter((id) => econ.items.get(id)?.socket))];
    list.insertAdjacentHTML('beforeend', '<h4 style="margin:0 0 6px">Sockets <span class="r">on the ship you fly · setting a gem is free; taking one out breaks it</span></h4>');
    const guns = (bp?.parts ?? []).filter((q) => socketsFor(GEMS, econ.ships, q, 100) > 0);
    if (!guns.length) list.insertAdjacentHTML('beforeend', `<div class="sgw-empty" style="padding:8px 0">No socketed guns: steel and better weapons have sockets (steel from level ${GEMS.sockets.levelByGrade[2] ?? '?'}, titanium from ${GEMS.sockets.levelByGrade[3] ?? '?'})</div>`);
    for (const q of guns) {
      const n = socketsFor(GEMS, econ.ships, q, level), now = q.gems ?? [];
      const r = row(`<img src="${itemIcon(econ, partItemId(q))}" style="width:26px;height:26px"><div style="flex:1">${esc(econ.items.name(partItemId(q)))}<br><small style="color:#8394ad">${n ? `${now.length} / ${n} sockets` : `sockets open at level ${(GEMS.sockets.levelByGrade[gradeOf(econ.ships.materials.get(q.material))] ?? 0) || '?'}`}</small></div>`);
      const acts = document.createElement('div');
      acts.style.cssText = 'display:flex; gap:6px; flex-wrap:wrap; justify-content:flex-end; max-width:320px;';
      now.forEach((g, i) => {
        const btn = document.createElement('button');
        btn.className = 'sgw-btn';
        btn.innerHTML = `<span style="color:${econ.items.get(g)?.color ?? '#fff'}">◆</span> ${esc(econ.items.name(g))} ✕`;
        btn.title = 'Take it out (it breaks)';
        btn.onclick = () => {
          if (btn.dataset.sure !== '1') { btn.dataset.sure = '1'; btn.innerHTML = 'Break it? Click again'; return; }
          this.d.send({ type: 'gemUnsocket', slot, uid: q.uid, index: i });
        };
        acts.appendChild(btn);
      });
      if (now.length < n) for (const g of held) {
        const btn = document.createElement('button');
        btn.className = 'sgw-btn primary';
        btn.innerHTML = `+ <span style="color:${econ.items.get(g)?.color ?? '#fff'}">◆</span> ${esc(econ.items.name(g))}`;
        btn.title = econ.items.get(g)?.description ?? '';
        btn.onclick = () => { this.d.send({ type: 'gemSocket', slot, uid: q.uid, gem: g }); this.d.sound('ui_click', 0.4); };
        acts.appendChild(btn);
      }
      r.appendChild(acts);
      list.appendChild(r);
    }
    // Cutting
    list.insertAdjacentHTML('beforeend', '<h4 style="margin:14px 0 6px">Cut a gem <span class="r">a level II cut can fail: half the stone comes back</span></h4>');
    for (const [type, t] of Object.entries(GEMS.types)) {
      for (const lv of Object.keys(t.levels)) {
        const need = cutInputs(GEMS, type, Number(lv))!, cut = GEMS.cuts[lv];
        const ok = Object.entries(need).every(([id, k]) => this.have(id) >= k);
        const r = row(`<img src="${itemIcon(econ, gemItemId(type, Number(lv)))}" style="width:26px;height:26px"><div style="flex:1"><span style="color:${t.color}">${esc(econ.items.name(gemItemId(type, Number(lv))))}</span><br><small style="color:#a7b4c8">${esc(t.levels[lv].summary)}</small></div>`
          + `<div style="width:230px">${costHtml(econ, need, (id) => this.have(id))}<br><small style="color:#8394ad">${fmt(cut.seconds)}${cut.fail ? ` · ${Math.round(cut.fail * 100)}% fail` : ''}</small></div>`);
        const btn = document.createElement('button');
        btn.className = 'sgw-btn' + (ok ? ' primary' : ' off');
        btn.textContent = 'Cut';
        btn.onclick = () => { this.d.send({ type: 'gemCut', gem: type, level: Number(lv) }); this.d.sound('ui_click', 0.4); };
        r.appendChild(btn);
        list.appendChild(r);
      }
    }
    main.append(list);
  }

  /**
   * The fabricator: what to make down the left (categories, the open one's
   * modules or items), the picked one in the middle (what it is and does, its
   * grade and size, what it takes, how many, Make), and the queue on the right.
   */
  private renderFabricator(b: HTMLElement): void {
    const econ = this.d.pilot.econ;
    // (an armoury's own rounds only once your station's armoury presses them)
    const learned = stationLearned(this.d.pilot.profile?.recipes ?? [], this.d.pilot.profile?.outpost ?? undefined, STATION);
    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid; grid-template-columns: 232px minmax(0, 1fr) 250px; gap:12px; height: min(580px, calc(100vh - 230px));';
    const nav = document.createElement('div');
    nav.className = 'sgw-col';
    nav.style.padding = '8px';
    const cats = (Object.keys(FAB_CATS) as FabCat[]).map((id) => ({ id, entries: id === 'gems' ? [] : this.fabEntries(id, learned) }))
      .filter((c) => c.id === 'gems' || c.entries.length);
    if (!cats.some((c) => c.id === this.fabCat)) this.fabCat = cats[0].id;
    // Categories, all in view
    const catGrid = document.createElement('div');
    catGrid.className = 'sgw-cats';
    for (const { id, entries } of cats) {
      const c = FAB_CATS[id];
      const open = entries.filter((e) => !e.locked).length;
      const cat = document.createElement('button');
      cat.className = this.fabCat === id ? 'on' : '';
      cat.dataset.fabcat = id;
      cat.innerHTML = `<img src="${itemIcon(econ, c.icon)}"><span>${c.label}</span>`;
      cat.title = c.title + (entries.length ? `: ${open} of ${entries.length} you can make` : '');
      cat.onclick = () => { this.fabCat = id; this.fabQty = 1; this.render(); this.d.sound('ui_click', 0.3); };
      catGrid.appendChild(cat);
    }
    nav.appendChild(catGrid);
    // The open category's modules or items
    const entries = cats.find((c) => c.id === this.fabCat)!.entries;
    const list = document.createElement('div');
    list.className = 'sgw-nav';
    if (entries.length) {
      const open = entries.filter((e) => !e.locked).length;
      list.insertAdjacentHTML('beforeend', `<div class="hd">${FAB_CATS[this.fabCat].title}<span>${open < entries.length ? `${open} of ${entries.length} unlocked` : ''}</span></div>`);
    }
    const picked = this.fabPicked(this.fabCat, entries);
    let group = '';
    for (const e of entries) {
      if (e.group && e.group !== group) { group = e.group; list.insertAdjacentHTML('beforeend', `<div class="grp">${esc(group)}</div>`); }
      const s = document.createElement('button');
      s.className = (picked === e.key ? 'on' : '') + (e.locked ? ' locked' : '');
      s.innerHTML = `<img src="${e.icon}"><span>${esc(e.name)}</span><span class="n">${e.locked ? `🔒${e.badge ? ` ${esc(e.badge)}` : ''}` : e.have ? `×${e.have}` : ''}</span>`;
      s.title = e.locked ? `${e.name}: ${e.why ?? 'it opens at a later level'}` : e.have ? `${e.name}: you have ${e.have}` : e.name;
      const cat = this.fabCat;
      s.onclick = () => { this.fabSel[cat] = e.key; this.fabQty = 1; this.render(); };
      list.appendChild(s);
    }
    if (this.fabCat === 'gems') list.insertAdjacentHTML('beforeend', '<div class="hd">Gems</div><div style="color:#8394ad; font-size:12px; line-height:1.5; padding:4px 8px">Cut raw gems into stones, and set them into the sockets of steel and better guns.</div>');
    nav.appendChild(list);
    if (FAB_CATS[this.fabCat].fns.length) {
      const note = document.createElement('div');
      note.style.cssText = 'color:#56657c; font-size:11px; line-height:1.45; padding:8px 4px 0; flex-shrink:0; border-top:1px solid rgba(140,170,220,0.08); margin-top:6px;';
      note.textContent = 'Hull, armour and cargo holds aren\'t made here: the hangar builds them from refined plate. Wire spools are under Components.';
      nav.appendChild(note);
    }

    // The picked one
    const main = document.createElement('div');
    main.className = 'sgw-col';
    main.style.padding = '0';
    const content = document.createElement('div');
    content.style.cssText = 'flex:1; min-height:0; overflow-y:auto; padding:12px; display:flex; flex-direction:column;';
    main.appendChild(content);
    if (this.fabCat === 'gems') {
      this.renderGems(content);
    } else {
      const key = picked;
      if (FAB_CATS[this.fabCat].fns.length) main.appendChild(this.fabModule(content, key, learned));
      else {
        const r = econ.recipes.craft.get(key) ?? null;
        if (r) main.appendChild(this.fabItem(content, r, learned));
      }
    }
    grid.append(nav, main, this.fabSide());
    b.append(grid);
    this.renderJobsOnly();
  }

  /** What's picked in a category (the first you can make, until you pick) */
  private fabPicked(cat: FabCat, entries: FabEntry[]): string {
    const now = this.fabSel[cat];
    if (now && entries.some((e) => e.key === now)) return now;
    return (entries.find((e) => !e.locked) ?? entries[0])?.key ?? '';
  }

  /** A category's entries: its modules (by function), or its recipes; the ones you can make first */
  private fabEntries(cat: FabCat, learned: string[]): FabEntry[] {
    const econ = this.d.pilot.econ;
    const c = FAB_CATS[cat];
    if (c.fns.length) {
      // Models (each in its own material) in their families, and the core; locked ones say what unlocks them
      const level = this.d.pilot.profile?.level ?? 1, items = econ.items.all();
      const known = (fn: string) => [...econ.ships.materials.keys()].some((m) => canCraft({ id: partItemId({ material: m, fn, piece: 'sq' }), out: {}, inputs: {}, time: 0 }, learned, level));
      return c.fns.filter((f) => econ.ships.functions.has(f)).map((f, i): FabEntry => {
        const fn = econ.ships.functions.get(f)!;
        const piece = fn.pieces === '*' ? 'sq' : fn.pieces[0];
        if (!fn.model) return { key: f, name: fn.name ?? FN_NAMES[f] ?? f, icon: itemIcon(econ, partItemId({ material: 'alloy', fn: f, piece })), locked: !known(f), order: i };
        const id = partItemId({ material: fn.material!, fn: f, piece });
        const r = econ.recipes.recipeFor(id);
        const lock = modelLock(fn, !!r && canCraft(r, learned, level), level, items);
        const group = familyLabel(fn);
        return { key: f, name: fn.name ?? f, icon: itemIcon(econ, id), locked: !lock.open, have: this.have(id), group, badge: lock.badge, why: lock.why, order: familyRank(group) * 1000 + i };
      }).sort((a, b) => a.order - b.order);
    }
    // Recipes: a job's own kit only while you're on it
    const gunName = new Map<string, { name: string; order: number }>();
    // (ammunition by the guns that fire it: their family)
    FAB_CATS.weapons.fns.forEach((f, i) => { const w = econ.ships.functions.get(f)?.weapon; if (w && !gunName.has(w)) gunName.set(w, { name: FAMILY_LABEL[w] ?? FN_NAMES[f] ?? f, order: i }); });
    for (const f of FAB_CATS.utility.fns) { const w = econ.ships.functions.get(f)?.weapon; if (w && !gunName.has(w)) gunName.set(w, { name: FAMILY_LABEL[w] ?? FN_NAMES[f] ?? f, order: 100 }); }
    return [...econ.recipes.craft.values()]
      .filter((r) => (!r.quest || this.d.quests.active.some((q) => q.id === r.quest)) && c.items!(econ.items.get(Object.keys(r.out)[0])))
      .map((r, i) => {
        const outId = Object.keys(r.out)[0], d = econ.items.get(outId);
        const gun = d?.ammoFor ? gunName.get(d.ammoFor.weapon) : undefined;
        return { key: r.id, name: econ.items.name(outId), icon: itemIcon(econ, outId), locked: !canCraft(r, learned, this.d.pilot.profile?.level ?? 1), have: this.have(outId),
          group: d?.ammoFor ? `For ${gun?.name ?? d.ammoFor.weapon}` : undefined, order: (gun?.order ?? 200) * 1000 + (d?.ammoFor?.mods ? 1 : 0) * 100 + i };
      })
      .sort((a, b) => cat === 'ammo' ? a.order - b.order : Number(a.locked) - Number(b.locked) || a.order - b.order);
  }

  /** A module: what it does, its grades (and what each gives), its sizes; returns its make bar */
  private fabModule(el: HTMLElement, fnId: string, learned: string[]): HTMLElement {
    const econ = this.d.pilot.econ;
    const fn = econ.ships.functions.get(fnId)!;
    if (fn.model) return this.fabModel(el, fn, learned);
    const area = (pc: string) => econ.ships.variants.get(pc)?.[0]?.area ?? 0;
    const pieces = (fn.pieces === '*' ? econ.ships.pieceIds : fn.pieces).filter((pc) => area(pc) >= 1 - 1e-9).sort((a, b) => area(a) - area(b));
    if (!pieces.includes(this.fabPiece)) this.fabPiece = pieces[0];
    if (!econ.ships.materials.has(this.fabMat)) this.fabMat = 'alloy';
    const pid = (material: string, piece = this.fabPiece) => partItemId({ material, fn: fnId, piece });
    const id = pid(this.fabMat);
    const r = econ.recipes.recipeFor(id);
    const stats = (material: string, piece = this.fabPiece) => partStats(econ.ships, econ.tuning, { material, fn: fnId, piece });
    const n0 = (v: number) => Math.round(v).toLocaleString();
    const key = (material: string) => {
      const st = stats(material);
      if (!st) return '';
      return st.dps !== undefined ? `<b style="color:#fca5a5">${n0(st.dps)}</b> dmg/s`
        : st.supply ? `<b style="color:#86efac">+${n0(st.supply)}</b> power`
        : st.thrust ? `<b style="color:#93c5fd">${st.thrust.toFixed(1)}</b> thrust`
        : st.shield ? `<b style="color:#7dd3fc">${n0(st.shield)}</b> shield`
        : `<b style="color:#e5ecf7">${n0(st.hp)}</b> hp`;
    };
    // What it is
    const desc = econ.items.get(pid('alloy', pieces[0]))?.description ?? '';
    const extra = fn.weapon ? 'Bigger guns hit harder for the power they draw; better grades hit harder still, and draw more.'
      : (fn.produce ?? 0) > 0 ? 'Better grades make more power: what better weapons and shields need.'
      : (fn.thrust ?? 0) > 0 ? `Bigger engines push more for their size; better grades push harder. Boosting: ×${fn.boost ?? 2.2} push, ${fn.boostDrain ?? 1}× battery drain.` : '';
    el.insertAdjacentHTML('beforeend', `<div style="display:flex; gap:12px; align-items:flex-start">
      <img src="${itemIcon(econ, id)}" style="width:52px; height:52px; flex-shrink:0; border-radius:10px; background:rgba(255,255,255,0.04)">
      <div style="min-width:0"><div style="font-size:16px; font-weight:600; color:#e5ecf7">${esc(FN_NAMES[fnId] ?? fnId)}</div>
      <div style="color:#a7b4c8; font-size:12px; line-height:1.45; margin-top:2px">${esc(desc)} ${esc(extra)}</div></div></div>`);
    // Grades: what each gives at this size, and which you can make
    const mats = [...econ.ships.materials.values()].filter((m) => !m.exclusive).sort((a, b) => gradeOf(a) - gradeOf(b));
    el.insertAdjacentHTML('beforeend', `<div class="sgw-label">Grade <span>better grades do more and take more hits · 🔒 opens at a later level</span></div>`);
    const grades = document.createElement('div');
    grades.style.cssText = 'display:grid; grid-template-columns: repeat(auto-fill, minmax(124px, 1fr)); gap:5px;';
    for (const m of mats) {
      const ok = canCraft({ id: pid(m.id), out: {}, inputs: {}, time: 0 }, learned, this.d.pilot.profile?.level ?? 1);
      const t = document.createElement('button');
      t.className = 'sgw-pick' + (this.fabMat === m.id ? ' on' : '') + (ok ? '' : ' locked');
      t.innerHTML = `<div style="display:flex; align-items:center; gap:5px; white-space:nowrap; overflow:hidden"><span style="color:${m.color}">■</span><span style="overflow:hidden; text-overflow:ellipsis">${esc(m.name ?? m.id)}</span>${ok ? '' : '<span style="margin-left:auto">🔒</span>'}</div>`
        + `<div style="font-size:11px; color:#8394ad; margin-top:2px; white-space:nowrap">${markName(gradeOf(m))} · ${key(m.id)}</div>`;
      t.title = `${m.name ?? m.id}: ${Math.round((m.output ?? 1) * 100)}% output, ${m.toughness} toughness, ${m.density} mass per cell`
        + (ok ? '' : `\nNeeds ${licenceFor({ id: pid(m.id), out: {}, inputs: {}, time: 0 }, learned, econ.items, this.d.pilot.profile?.level ?? 1)}`);
      t.onclick = () => { this.fabMat = m.id; this.fabQty = 1; this.render(); };
      grades.appendChild(t);
    }
    el.appendChild(grades);
    // Sizes (or shapes)
    el.insertAdjacentHTML('beforeend', `<div class="sgw-label">Size <span>bigger takes more cells, does more</span></div>`);
    const sizes = document.createElement('div');
    sizes.style.cssText = 'display:grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap:5px;';
    for (const pc of pieces) {
      const st = stats(this.fabMat, pc);
      const pr = econ.recipes.recipeFor(pid(this.fabMat, pc));
      const t = document.createElement('button');
      t.className = 'sgw-pick' + (this.fabPiece === pc ? ' on' : '');
      t.style.cssText = 'display:flex; align-items:center; gap:8px;';
      const what = st ? [
        st.dps !== undefined ? `${n0(st.dps)} dmg/s` : '', st.supply ? `+${n0(st.supply)} power` : '', st.draw ? `draws ${n0(st.draw)}` : '',
        st.thrust ? `thrust ${st.thrust.toFixed(1)}` : '', st.shield ? `shield ${n0(st.shield)}` : '', `${n0(st.hp)} hp`,
      ].filter(Boolean).join(' · ') : '';
      const have = this.have(pid(this.fabMat, pc));
      t.innerHTML = `<img src="${itemIcon(econ, pid(this.fabMat, pc))}" style="width:30px; height:30px; flex-shrink:0">`
        + `<div style="min-width:0; flex:1"><div style="white-space:nowrap">${esc(st?.size || PIECE_NAMES[pc] || pc)} <small style="color:#8394ad">${esc(PIECE_NAMES[pc] ?? pc)}, ${Math.round(st?.area ?? 1)} cell${(st?.area ?? 1) > 1 ? 's' : ''}</small></div>`
        + `<div style="font-size:11px; color:#a7b4c8; white-space:nowrap; overflow:hidden; text-overflow:ellipsis">${what}</div></div>`
        + `<div style="font-size:11px; color:#8394ad; text-align:right; white-space:nowrap">${have ? `<span style="color:#86efac">have ${have}</span><br>` : ''}${pr ? (pr.time > 0 ? fmt(pr.time) : 'instant') : ''}</div>`;
      t.addEventListener('mousemove', (e) => showTip(itemTipHtml(econ, pid(this.fabMat, pc), { count: have }), e.clientX, e.clientY));
      t.addEventListener('mouseleave', hideTip);
      t.onclick = () => { this.fabPiece = pc; this.fabQty = 1; this.render(); };
      sizes.appendChild(t);
    }
    el.appendChild(sizes);
    // Its ammunition, a click away
    const w = fn.weapon;
    const crates = w ? [...econ.recipes.craft.values()].filter((x) => econ.items.get(Object.keys(x.out)[0])?.ammoFor?.weapon === w) : [];
    if (crates.length) {
      el.insertAdjacentHTML('beforeend', `<div class="sgw-label">Ammunition <span>it fires from crates in your hold</span></div>`);
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; gap:5px; flex-wrap:wrap;';
      for (const x of crates) {
        const outId = Object.keys(x.out)[0];
        const c = document.createElement('button');
        c.className = 'sgw-chip';
        c.innerHTML = `<img src="${itemIcon(econ, outId)}" style="width:16px; height:16px; vertical-align:-4px"> ${esc(econ.items.name(outId))}${this.have(outId) ? ` <small style="color:#86efac">×${this.have(outId)}</small>` : ''}`;
        c.onclick = () => { this.fabCat = 'ammo'; this.fabSel.ammo = x.id; this.fabQty = 1; this.render(); };
        row.appendChild(c);
      }
      el.appendChild(row);
    }
    const locked = r && !canCraft(r, learned, this.d.pilot.profile?.level ?? 1) ? licenceFor(r, learned, econ.items, this.d.pilot.profile?.level ?? 1) : null;
    return this.makeBar(r, locked, `${markName(gradeOf(econ.ships.materials.get(this.fabMat)!))} ${econ.items.name(id)}`);
  }

  /**
   * A model (docs/parts-redesign.md §1): what it is and its trade-off, its
   * family, size and numbers, the level it's learned at (never earlier),
   * what it's made from; returns its make bar
   */
  private fabModel(el: HTMLElement, fn: FunctionDef, learned: string[]): HTMLElement {
    const econ = this.d.pilot.econ, level = this.d.pilot.profile?.level ?? 1;
    const pieces = fn.pieces === '*' ? ['sq'] : fn.pieces;
    if (!pieces.includes(this.fabPiece)) this.fabPiece = pieces[0];
    const mat = fn.material ?? 'alloy';
    const pid = (piece = this.fabPiece) => partItemId({ material: mat, fn: fn.id, piece });
    const id = pid();
    const r = econ.recipes.recipeFor(id);
    const lock = modelLock(fn, !!r && canCraft(r, learned, level), level, econ.items.all());
    const st = partStats(econ.ships, econ.tuning, { material: mat, fn: fn.id, piece: this.fabPiece });
    const n0 = (v: number) => Math.round(v).toLocaleString();
    const m = econ.ships.materials.get(mat);
    el.insertAdjacentHTML('beforeend', `<div style="display:flex; gap:12px; align-items:flex-start">
      <img src="${itemIcon(econ, id)}" style="width:52px; height:52px; flex-shrink:0; border-radius:10px; background:rgba(255,255,255,0.04)">
      <div style="min-width:0"><div style="font-size:16px; font-weight:600; color:${RARITY_COLOR[fn.rarity ?? 'common'] ?? '#e5ecf7'}">${esc(fn.name ?? fn.id)}</div>
      <div style="color:#8394ad; font-size:11px; letter-spacing:0.5px">${esc(familyLabel(fn))} · ${esc(sizeText(econ.ships, fn))} · ${markName(fn.grade ?? 1)}</div>
      <div style="color:#a7b4c8; font-size:12px; line-height:1.45; margin-top:4px">${esc(fn.description ?? '')}</div>
      <div style="color:#fbbf24; font-size:12px; font-style:italic; margin-top:2px">${esc(tradeOff(fn))}</div></div></div>`);
    const rows: [string, string][] = [];
    rows.push(['Does', esc(keyStats(econ.ships, econ.tuning, fn, this.fabPiece))]);
    if (st) rows.push(['Hull', `${n0(st.hp)} hp · ${st.mass.toFixed(1)} mass · armour ${st.armour}`]);
    rows.push(['Made of', `<span style="color:${m?.color ?? '#cfd8e6'}">■</span> ${esc(m?.name ?? mat)} <small style="color:#8394ad">(its own: its hit points, mass and resistances)</small>`]);
    if (fn.points !== undefined && st) rows.push(['Build points', `${Math.round(fn.points * st.area * 10) / 10}`]);
    rows.push(['Learned at', fn.unlock ? `level ${fn.unlock.level}${level >= fn.unlock.level ? ' <span style="color:#86efac">✓</span>' : ` <span style="color:#fca5a5">(you're ${level})</span>`}` : '<span style="color:#c4b5fd">no pilot can make it</span>']);
    rows.push(['You have', `${this.have(id)}`]);
    el.insertAdjacentHTML('beforeend', `<div style="margin-top:12px; display:grid; grid-template-columns: 90px 1fr; gap:5px 10px; font-size:12px">${rows.map(([k, v]) => `<span style="color:#8394ad">${k}</span><span>${v}</span>`).join('')}</div>`);
    // Sizes it comes in (most models one)
    if (pieces.length > 1) {
      el.insertAdjacentHTML('beforeend', `<div class="sgw-label">Size</div>`);
      const sizes = document.createElement('div');
      sizes.style.cssText = 'display:grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap:5px;';
      for (const pc of pieces) {
        const t = document.createElement('button');
        t.className = 'sgw-pick' + (this.fabPiece === pc ? ' on' : '');
        t.style.cssText = 'display:flex; align-items:center; gap:8px;';
        t.innerHTML = `<img src="${itemIcon(econ, pid(pc))}" style="width:30px; height:30px; flex-shrink:0"><div style="min-width:0; flex:1"><div>${esc(PIECE_NAMES[pc] ?? pc)}</div>`
          + `<div style="font-size:11px; color:#a7b4c8; white-space:nowrap; overflow:hidden; text-overflow:ellipsis">${esc(keyStats(econ.ships, econ.tuning, fn, pc))}</div></div>`;
        t.onclick = () => { this.fabPiece = pc; this.fabQty = 1; this.render(); };
        sizes.appendChild(t);
      }
      el.appendChild(sizes);
    }
    // Its ammunition, a click away
    const crates = fn.weapon ? [...econ.recipes.craft.values()].filter((x) => econ.items.get(Object.keys(x.out)[0])?.ammoFor?.weapon === fn.weapon) : [];
    if (crates.length) {
      el.insertAdjacentHTML('beforeend', `<div class="sgw-label">Ammunition <span>it fires from crates in your hold</span></div>`);
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; gap:5px; flex-wrap:wrap;';
      for (const x of crates) {
        const outId = Object.keys(x.out)[0];
        const c = document.createElement('button');
        c.className = 'sgw-chip';
        c.innerHTML = `<img src="${itemIcon(econ, outId)}" style="width:16px; height:16px; vertical-align:-4px"> ${esc(econ.items.name(outId))}${this.have(outId) ? ` <small style="color:#86efac">×${this.have(outId)}</small>` : ''}`;
        c.onclick = () => { this.fabCat = 'ammo'; this.fabSel.ammo = x.id; this.fabQty = 1; this.render(); };
        row.appendChild(c);
      }
      el.appendChild(row);
    }
    return this.makeBar(r, lock.open ? null : lock.why, econ.items.name(id), true);
  }

  /** An item recipe (ammunition, supplies, components): what it is and what it's for; returns its make bar */
  private fabItem(el: HTMLElement, r: CraftRecipe, learned: string[]): HTMLElement {
    const econ = this.d.pilot.econ;
    const outId = Object.keys(r.out)[0];
    const d: ItemDef | undefined = econ.items.get(outId);
    const rows: [string, string][] = [];
    if (d?.ammoFor) {
      const fns = [...econ.ships.functions.values()].filter((f) => f.weapon === d.ammoFor!.weapon && !f.legacy && !f.exclusive);
      const names = fns.map((f) => f.name ?? FN_NAMES[f.id] ?? f.id);
      const ids = new Set(fns.map((f) => f.id));
      const slot = this.d.pilot.hangar?.active ?? 0;
      const onShip = (this.d.pilot.hangar?.slots[slot]?.blueprint.parts ?? []).filter((q) => ids.has(q.fn)).length;
      rows.push(['For', esc(names.join(', ') || d.ammoFor.weapon)]);
      rows.push(['A crate', `${d.ammoFor.rounds} rounds`]);
      rows.push(['Your ship', onShip ? `<span style="color:#86efac">${onShip} gun${onShip > 1 ? 's' : ''} that fire${onShip > 1 ? '' : 's'} it</span>` : '<span style="color:#8394ad">nothing that fires it</span>']);
    }
    // A component: the models it goes into (a wire spool: wiring)
    if (outId === WIRE_ITEM) rows.push(['For', 'nothing now: ships no longer take wire (power flows between parts that touch)']);
    else if (d?.category === 'component') {
      const into = [...econ.ships.functions.values()].filter((f) => f.model && !f.exclusive && (f.pieces === '*' ? ['sq'] : f.pieces).some((pc) => (econ.recipes.recipeFor(partItemId({ material: f.material!, fn: f.id, piece: pc }))?.inputs[outId] ?? 0) > 0));
      if (into.length) rows.push(['Goes into', esc(into.map((f) => f.name ?? f.id).join(', '))]);
    }
    if (r.out[outId] > 1) rows.push(['Makes', `${r.out[outId]} a batch`]);
    rows.push(['You have', `${this.have(outId)}`]);
    el.insertAdjacentHTML('beforeend', `<div style="display:flex; gap:12px; align-items:flex-start">
      <img src="${itemIcon(econ, outId)}" style="width:52px; height:52px; flex-shrink:0; border-radius:10px; background:rgba(255,255,255,0.04)">
      <div style="min-width:0"><div style="font-size:16px; font-weight:600; color:${d ? RARITY_COLOR[d.rarity] : '#e5ecf7'}">${esc(econ.items.name(outId))}</div>
      <div style="color:#8394ad; font-size:11px; letter-spacing:0.5px">${d ? CATEGORY_LABEL[d.category] : ''}</div>
      <div style="color:#a7b4c8; font-size:12px; line-height:1.45; margin-top:4px">${esc(d?.description ?? '')}</div></div></div>
      <div style="margin-top:12px; display:grid; grid-template-columns: 90px 1fr; gap:5px 10px; font-size:12px">${rows.map(([k, v]) => `<span style="color:#8394ad">${k}</span><span>${v}</span>`).join('')}</div>`);
    // Other crates for the same guns
    if (d?.ammoFor) {
      const kin = [...econ.recipes.craft.values()].filter((x) => x.id !== r.id && econ.items.get(Object.keys(x.out)[0])?.ammoFor?.weapon === d.ammoFor!.weapon);
      if (kin.length) {
        el.insertAdjacentHTML('beforeend', `<div class="sgw-label">Other rounds for it</div>`);
        const row = document.createElement('div');
        row.style.cssText = 'display:flex; gap:5px; flex-wrap:wrap;';
        for (const x of kin) {
          const id = Object.keys(x.out)[0];
          const c = document.createElement('button');
          c.className = 'sgw-chip';
          c.innerHTML = `<img src="${itemIcon(econ, id)}" style="width:16px; height:16px; vertical-align:-4px"> ${esc(econ.items.name(id))}${canCraft(x, learned, this.d.pilot.profile?.level ?? 1) ? '' : ' 🔒'}`;
          c.title = econ.items.get(id)?.description ?? '';
          c.onclick = () => { this.fabSel.ammo = x.id; this.fabQty = 1; this.render(); };
          row.appendChild(c);
        }
        el.appendChild(row);
      }
    }
    return this.makeBar(r, canCraft(r, learned, this.d.pilot.profile?.level ?? 1) ? null : licenceFor(r, learned, econ.items, this.d.pilot.profile?.level ?? 1), econ.items.name(outId));
  }

  /** The bottom of the picked one: what it takes (have / need), how long, how many, and the one button */
  private makeBar(r: CraftRecipe | null, locked: string | null, name: string, model = false): HTMLElement {
    const econ = this.d.pilot.econ;
    const bar = document.createElement('div');
    bar.style.cssText = 'flex-shrink:0; border-top:1px solid rgba(140,170,220,0.14); padding:10px 12px; background:rgba(125,211,252,0.03); border-radius:0 0 12px 12px;';
    if (!r) { bar.innerHTML = '<span style="color:#56657c">The fabricator doesn\'t make this</span>'; return bar; }
    // (a model: learned at its level, never earlier)
    if (locked && model) {
      bar.innerHTML = `<div style="display:flex; align-items:center; gap:4px 6px; flex-wrap:wrap; font-size:12px; opacity:0.7"><span style="color:#8394ad; margin-right:2px">Takes</span>${costHtml(econ, r.inputs, (id) => this.have(id))}`
        + `<span style="margin-left:auto; color:#8394ad; white-space:nowrap">${r.time > 0 ? `⏳ ${fmt(r.time)}` : 'instant'}</span></div>`
        + `<div style="color:#fca5a5; margin-top:8px">🔒 ${esc(locked)}</div><div style="color:#8394ad; font-size:11px; margin-top:3px">Levels come from jobs, fights and mining.</div>`;
      return bar;
    }
    if (locked) {
      bar.innerHTML = `<div style="color:#fca5a5">🔒 Needs ${esc(locked)}</div><div style="color:#8394ad; font-size:11px; margin-top:3px">Everything opens at its level (a job's kit with its job too). Levels come from jobs, fights and mining.</div>`;
      return bar;
    }
    const max = Math.min(...Object.entries(r.inputs).map(([id, n]) => Math.floor(this.have(id) / n)));
    const n = Math.max(1, Math.min(99, this.fabQty));
    const outId = Object.keys(r.out)[0];
    const need: Bag = Object.fromEntries(Object.entries(r.inputs).map(([id, k]) => [id, k * n]));
    bar.innerHTML = `<div style="display:flex; align-items:center; gap:4px 6px; flex-wrap:wrap; font-size:12px"><span style="color:#8394ad; margin-right:2px">Takes</span>${costHtml(econ, need, (id) => this.have(id))}`
      + `<span style="margin-left:auto; color:#8394ad; white-space:nowrap">${r.time > 0 ? `⏳ ${fmt(r.time * n)}${n > 1 ? ` (${fmt(r.time)} each)` : ''}` : 'instant'}</span></div>`
      + `<div style="display:flex; align-items:center; gap:6px; margin-top:9px"></div>`;
    const row = bar.lastElementChild as HTMLElement;
    const small = (label: string, to: number, title = '') => {
      const x = document.createElement('button');
      x.className = 'sgw-btn';
      x.style.cssText = 'padding:5px 10px;';
      x.textContent = label;
      x.title = title;
      x.onclick = () => { this.fabQty = Math.max(1, Math.min(99, to)); this.render(); };
      return x;
    };
    const qty = document.createElement('span');
    qty.style.cssText = 'min-width:28px; text-align:center; font-size:15px; font-weight:600; color:#e5ecf7;';
    qty.textContent = String(n);
    row.append(small('−', n - 1), qty, small('+', n + 1), small('×5', 5), small(`Max${max > 0 ? ` ${Math.min(99, max)}` : ''}`, max, 'As many as your materials make'));
    if (max <= 0) (row.lastElementChild as HTMLElement).classList.add('off');
    const status = document.createElement('span');
    status.style.cssText = 'flex:1; text-align:right; font-size:11px;';
    status.innerHTML = max >= n ? `<span style="color:#8394ad">${n * r.out[outId]} × ${esc(name)}</span>`
      : `<span style="color:#fbbf24">${max > 0 ? `Enough for ${max} now` : 'Short of materials'}: order it, and it's refined and made as ore comes in</span>`;
    const go = document.createElement('button');
    go.className = 'sgw-btn primary';
    go.style.cssText = 'padding:8px 22px; font-size:13px; font-weight:600;';
    go.textContent = `${r.time > 0 ? 'Queue' : 'Make'}${n > 1 ? ` ${n}` : ''}`;
    go.title = r.time > 0 ? 'Goes into the build queue: it lands in storage when done, even if you leave' : 'Made at once, into storage';
    if (max < n) {
      // Short: an order instead, worked through as the ore comes in
      go.textContent = `Order${n > 1 ? ` ${n}` : ''}`;
      go.title = 'Refines what it\'s short of from your storage (waiting for ore if need be), then fabricates: all into storage';
      go.onclick = () => { this.d.send({ type: 'fabOrder', item: outId, n: n * r.out[outId] }); this.d.sound('ui_click', 0.5); };
    } else go.onclick = () => { this.d.send({ type: 'craft', recipe: r.id, n }); this.d.sound('ui_click', 0.5); };
    row.append(status, go);
    return bar;
  }

  /** Your station: charter it, then build its tracks up, a tier at a time (they build while you're away) */
  private renderOutpost(b: HTMLElement): void {
    const econ = this.d.pilot.econ, p = this.d.pilot.profile, file = STATION;
    const col = document.createElement('div');
    col.className = 'sgw-col';
    col.style.cssText = 'overflow-y:auto; height: min(580px, calc(100vh - 230px));';
    const o = p?.outpost;
    if (!o) {
      const c = file.charter, level = p?.level ?? 1;
      col.innerHTML = `<h4>Your own station</h4><div style="color:#a7b4c8; line-height:1.6; max-width:640px; margin-bottom:12px">A station of your own, berthed beside one of the sites below: nine tracks to build up (refinery, fabricator, armoury, gem cutter, hangar, storage, scanner array, market link, defences), each tier from your plate and ore, over real time, while you're away too. Nothing on it makes a ship stronger: it's what you can make, keep and know.</div>
        <div class="t-row" style="margin-bottom:10px">Charter: <b>level ${c.level}</b>${level < c.level ? ` <span style="color:#fbbf24">(you're ${level})</span>` : ''} · ${c.credits.toLocaleString()} cr · ${costHtml(econ, c.items, (id) => this.have(id))}</div>`;
      for (const s of file.sites) {
        const here = this.st?.id === s.station;
        const row = document.createElement('div');
        row.style.cssText = 'display:flex; align-items:center; gap:12px; padding:9px 4px; border-bottom:1px solid rgba(140,170,220,0.07);';
        row.innerHTML = `<div style="flex:1"><b>${esc(s.name)}</b><br><small style="color:#8394ad">beside ${esc(stationName(s.station))}</small></div>`;
        const btn = document.createElement('button');
        btn.className = 'sgw-btn' + (here && level >= c.level ? ' primary' : ' off');
        btn.textContent = here ? 'Charter here' : 'Charter it there';
        btn.title = here ? '' : `Dock at ${stationName(s.station)} to charter it`;
        btn.onclick = () => this.d.send({ type: 'outpostCharter', site: s.id });
        row.appendChild(btn);
        col.appendChild(row);
      }
      b.appendChild(col);
      return;
    }
    const site = file.sites.find((s) => s.id === o.site);
    const now = Date.now() + this.d.pilot.clockSkew;
    const busy = o.build;
    col.innerHTML = `<h4>Your station <span class="r">${esc(site?.name ?? o.site)}${busy ? ` · building ${esc(file.tracks[busy.track]?.name ?? busy.track)} ${busy.tier}: ${fmt(Math.max(0, Math.ceil((busy.readyAt - now) / 1000)))} left` : ' · nothing building'}</span></h4>`;
    const groups: [string, string][] = [['make', 'Make'], ['keep', 'Keep'], ['know', 'Know and sell'], ['hold', 'Hold']];
    for (const [g, label] of groups) {
      col.insertAdjacentHTML('beforeend', `<h4 style="margin:12px 0 4px; color:#7dd3fc">${label}</h4>`);
      for (const [id, t] of Object.entries(file.tracks).filter(([, t]) => t.group === g)) {
        const tier = o.tracks[id] ?? 0, next = t.tiers[tier];
        const row = document.createElement('div');
        row.style.cssText = 'display:flex; align-items:center; gap:12px; padding:8px 4px; border-bottom:1px solid rgba(140,170,220,0.07);';
        const pips = t.tiers.map((_, i) => `<span style="color:${i < tier ? '#7dd3fc' : busy?.track === id && busy.tier === i + 1 ? '#fbbf24' : '#334155'}">●</span>`).join('');
        row.innerHTML = `<div style="width:190px"><b>${esc(t.name)}</b> ${pips}<br><small style="color:#8394ad">${esc(tier ? t.tiers[tier - 1].name : t.about)}</small></div>`
          + (next ? `<div style="flex:1"><small style="color:#a7b4c8">Next: ${esc(next.name)} · ${next.minutes < 60 ? `${next.minutes} min` : `${next.minutes / 60} h`}</small><br>${costHtml(econ, next.cost, (iid) => this.have(iid))}</div>` : '<div style="flex:1; color:#86efac">Built as far as it goes</div>');
        if (next) {
          const ok = !busy && Object.entries(next.cost).every(([iid, n]) => this.have(iid) >= n);
          const btn = document.createElement('button');
          btn.className = 'sgw-btn' + (ok ? ' primary' : ' off');
          btn.textContent = `Build ${tier + 1}`;
          btn.onclick = () => this.d.send({ type: 'outpostUpgrade', track: id });
          row.appendChild(btn);
        }
        col.appendChild(row);
      }
    }
    b.appendChild(col);
  }

  /** The fabricator's queue, beside whatever it's showing */
  private fabSide(): HTMLElement {
    const side = document.createElement('div');
    side.className = 'sgw-col';
    side.innerHTML = `<h4>Build queue <span class="r">${this.st!.jobs.filter((j) => !j.recipe.startsWith('refine:')).length} / ${this.st!.queueSlots}</span></h4>`;
    side.style.overflowY = 'auto';
    const jobs = document.createElement('div');
    jobs.dataset.jobs = 'fab';
    const waiting = document.createElement('div');
    waiting.innerHTML = this.waitingHtml('part');
    side.append(jobs, waiting);
    // Orders: made as their materials come in
    const orders = this.d.pilot.hangar?.orders ?? [];
    if (orders.length) {
      const box = document.createElement('div');
      box.innerHTML = `<h4 style="margin-top:12px">Orders <span class="r">made as materials come in</span></h4>`;
      for (const o of orders) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex; align-items:center; gap:8px; padding:6px 0; border-bottom:1px solid rgba(140,170,220,0.07); font-size:12px;';
        row.innerHTML = `<img src="${itemIcon(this.d.pilot.econ, o.item)}" style="width:22px;height:22px"><div style="flex:1">${esc(this.d.pilot.econ.items.name(o.item))} <b>${o.made} / ${o.n}</b><br><small style="color:#8394ad">${esc(o.waiting || 'starting')}</small></div>`;
        const x = document.createElement('button');
        x.className = 'sgw-btn';
        x.textContent = '✕';
        x.title = 'Call it off (its refining stops and the ore comes back)';
        x.onclick = () => this.d.send({ type: 'fabOrderCancel', id: o.id });
        row.appendChild(x);
        box.appendChild(row);
      }
      side.append(box);
    }
    const note = document.createElement('div');
    note.style.cssText = 'margin-top:auto; color:#56657c; font-size:11px; line-height:1.5; padding-top:10px;';
    note.textContent = 'Small modules are made at once. Bigger builds take time and keep going while you\'re away: they go to storage, wherever you are. Short of plate? Refine it first.';
    side.append(note);
    return side;
  }

  /** Just the job lists (they tick along every half second; rows are rebuilt only when the list changes, so clicks land) */
  private renderJobsOnly(): void {
    const st = this.st;
    if (!st) return;
    const now = this.now();
    for (const el of this.win.body.querySelectorAll<HTMLElement>('[data-jobs]')) {
      const kind = el.dataset.jobs;
      const list = st.jobs.filter((j) => kind === 'refine' ? j.recipe.startsWith('refine:') : kind === 'fab' ? !j.recipe.startsWith('refine:') : true);
      if (!el.dataset.wired) {
        el.dataset.wired = '1';
        el.addEventListener('click', (e) => {
          const b = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
          if (!b) return;
          this.d.send({ type: 'job', id: Number(b.dataset.job), action: b.dataset.act as 'pause' | 'resume' | 'cancel' | 'top' });
          this.d.sound('ui_click', 0.4);
        });
      }
      const key = list.map((j) => `${j.id}:${j.done}:${j.paused ? 1 : 0}:${j.startedAt}`).join(',');
      if (el.dataset.key !== key) {
        el.dataset.key = key;
        el.innerHTML = list.length ? list.map((j) => this.jobRow(j, st.jobs, st.id)).join('')
          : `<div class="sgw-empty" style="padding:10px 0">${kind === 'refine' ? 'Nothing refining' : kind === 'fab' ? 'No fabrication in progress' : 'Nothing in progress'}</div>`;
      }
      for (const j of list) {
        const row = el.querySelector<HTMLElement>(`[data-row="${j.id}"]`);
        if (!row) continue;
        const span = j.unitMs * j.count;
        const frac = j.paused ? (j.done * j.unitMs + (j.heldMs ?? 0)) / Math.max(1, span) : Math.min(1, (now - j.startedAt) / Math.max(1, j.readyAt - j.startedAt));
        const left = Math.max(0, (j.readyAt - now) / 1000);
        row.querySelector<HTMLElement>('.sgw-bar > i')!.style.width = `${Math.max(0, frac) * 100}%`;
        const t = row.querySelector<HTMLElement>('[data-left]')!;
        t.textContent = j.paused ? '⏸ on hold' : left <= 0 ? 'done' : now < j.startedAt ? `queued · ${fmt(left)}` : fmt(left);
        t.style.color = j.paused ? '#fbbf24' : left <= 0 ? '#86efac' : '#8394ad';
      }
    }
  }

  /** One job: what it makes, what for, its progress, and its controls */
  private jobRow(j: JobView & { stationName: string }, all: JobView[], here: string): string {
    const econ = this.d.pilot.econ;
    const out = Object.entries(j.out).map(([id, n]) => `${n * j.count} × ${esc(econ.items.name(id))}`).join(', ');
    const done = j.count > 1 ? ` <span style="color:#56657c">${j.done}/${j.count}</span>` : '';
    const refine = j.recipe.startsWith('refine:');
    const first = all.find((x) => x.station === j.station && x.recipe.startsWith('refine:') === refine && !x.paused);
    const act = (a: string, label: string, title: string) => `<button class="sgw-btn" data-job="${j.id}" data-act="${a}" title="${title}" style="padding:2px 7px; font-size:11px">${label}</button>`;
    const note = [j.for ? `for the ${esc(j.for)}` : '', j.station !== here ? `at ${esc(j.stationName)}` : ''].filter(Boolean).join(' · ');
    return `<div data-row="${j.id}" style="margin:6px 0 10px; ${j.paused ? 'opacity:0.75' : ''}"><div style="display:flex; justify-content:space-between; gap:8px"><span>${out}${done}</span>`
      + `<span data-left style="white-space:nowrap"></span></div>`
      + `<div class="sgw-bar" style="margin:4px 0 0"><i></i></div>`
      + `<div style="display:flex; align-items:center; gap:4px; margin-top:3px"><span style="flex:1; color:#56657c; font-size:11px">${note}</span>`
      + (j.paused ? act('resume', '▶', 'Resume') : act('pause', '⏸', 'Hold it: the rest of the queue moves up'))
      + (first && first.id !== j.id ? act('top', '⇧', 'Move it to the front of the queue') : '')
      + act('cancel', '✕', j.for ? `Call it off (materials back to storage); the ${j.for}'s order goes on hold` : 'Call it off: its materials go back to storage')
      + '</div></div>';
  }
}

type FabCat = 'weapons' | 'power' | 'engines' | 'shields' | 'utility' | 'core' | 'ammo' | 'supplies' | 'components' | 'gems';

/** One thing to pick in a fabricator category: a module (by function) or a recipe */
interface FabEntry { key: string; name: string; icon: string; locked: boolean; have?: number; group?: string; order: number; /** A locked model: its badge ("Lv 12"), and what unlocks it */ badge?: string; why?: string }

/**
 * The fabricator's categories: modules, from each function's `category` in
 * data/ships/functions.json, in `fabOrder` (structure isn't fabricated); the
 * rest hold the item recipes, by what they make.
 */
const FAB_CATS: Record<FabCat, { label: string; title: string; icon: string; fns: string[]; items?: (d: ItemDef | undefined) => boolean }> = {
  weapons: { label: 'Weapons', title: 'Weapons', icon: 'part:alloy:cannon_pip:sq', fns: [] },
  power: { label: 'Power', title: 'Generators & batteries', icon: 'part:alloy:power_cell_reactor:sq', fns: [] },
  engines: { label: 'Engines', title: 'Engines & coils', icon: 'part:alloy:engine_ion_drive:sq', fns: [] },
  shields: { label: 'Shields', title: 'Shields & plating', icon: 'part:steel:shield_deflector:sq', fns: [] },
  utility: { label: 'Mining', title: 'Mining & scanning', icon: 'part:alloy:utility_mining_laser:sq', fns: [] },
  core: { label: 'Core', title: 'Cores', icon: 'part:alloy:core:sq', fns: [] },
  ammo: { label: 'Ammo', title: 'Ammunition', icon: 'missile_crate', fns: [], items: (d) => d?.category === 'ammo' },
  supplies: { label: 'Supplies', title: 'Repair kits & supplies', icon: 'repair_kit', fns: [], items: (d) => d?.category === 'consumable' },
  components: { label: 'Components', title: 'Components', icon: 'power_coupling', fns: [], items: (d) => d?.category !== 'ammo' && d?.category !== 'consumable' },
  gems: { label: 'Gems', title: 'Gems', icon: '', fns: [] },
};
const GEMS = gemsData as unknown as GemsFile;
FAB_CATS.gems.icon = gemItemId(Object.keys(GEMS.types)[0] ?? '', 1);
const STATION = stationData as unknown as StationFile;
const STATION_NAMES: Record<string, string> = Object.fromEntries(((stationsData as unknown as { stations: { id: string; name: string }[] }).stations ?? []).map((s) => [s.id, s.name]));
const stationName = (id: string) => STATION_NAMES[id] ?? id;
// (The models and the core: not the legacy functions models replaced, nor the game's own ships' parts)
for (const f of [...SHIP_FUNCTIONS].filter((f) => !f.legacy && !f.exclusive).sort((a, b) => (a.fabOrder ?? 0) - (b.fabOrder ?? 0))) {
  if (f.category && f.category !== 'other' && f.category in FAB_CATS) FAB_CATS[f.category as FabCat].fns.push(f.id);
}

function partOf(r: CraftRecipe): { material: string; fn: string; piece: string } {
  const m = /^part:([^:]+):([^:]+):([^:]+)$/.exec(r.id);
  return m ? { material: m[1], fn: m[2], piece: m[3] } : { material: '', fn: '', piece: '' };
}

/** What a locked recipe waits on: "pilot level 12", "pilot level 5 (Steel structure)", "Core fabrication" (nothing opens early) */
function licenceFor(r: CraftRecipe, learned: string[], items: ItemCatalog, level: number): string {
  const p = parsePartItemId(r.id);
  if (!p) {
    if (r.level !== undefined && level < r.level) return `pilot level ${r.level}`;
    if (armouryRound(r.id, STATION)) return r.quest ? "its job, and your own station's armoury" : "your own station's armoury";
    return r.quest ? 'its job' : 'the recipe';
  }
  const fn = registeredFunction(p.fn);
  if (fn?.model) return fn.unlock ? `pilot level ${fn.unlock.level}` : 'a model no pilot makes';
  if (!materialLicensed(p.material, learned, level)) {
    const at = MATERIAL_LEVEL[p.material];
    if (at === undefined) return `${materialUnlockName(p.material)}, which no pilot builds with`;
    return level < at ? `pilot level ${at} (${materialUnlockName(p.material)})` : `${licenceName(`material:${p.material}`, items)}, from its job`;
  }
  return licenceName(`fn:${p.fn}`, items);
}

/** "for the hull & armour, Pulse Laser" */
function forText(l: OrderLine): string {
  return l.for.map((f) => (f === 'structure' ? 'hull & armour' : f)).join(', ');
}

/** "Iron Ore" → "Iron" for the compact gather list */
function shortName(name: string): string {
  return name.replace(/ Ore$/, '');
}

/** A bill line's state: ready, being made, waiting, short */
function lineStatus(l: OrderLine): string {
  const bits: string[] = [];
  if (l.ready) bits.push(`<span style="color:#86efac">✓ ${l.ready}</span>`);
  if (l.coming) bits.push(`<span style="color:#7dd3fc">⏳ ${l.coming}</span>`);
  if (l.waiting) bits.push(`<span style="color:#fbbf24" title="${l.blocked === 'queue' ? 'Next, when a queue slot frees' : 'Waiting for what it is made from'}">◷ ${l.waiting}</span>`);
  if (l.short) bits.push(`<span style="color:#fca5a5" title="${l.blocked === 'schematic' ? 'It opens at a later level' : 'Gather or buy it'}">${l.blocked === 'schematic' ? '🔒' : '✕'} ${l.short}</span>`);
  return bits.join(' ');
}

/** The window's scrolling lists, in page order (a re-render builds the same ones in the same order) */
function scrollsOf(b: HTMLElement): HTMLElement[] {
  return [b, ...[...b.querySelectorAll<HTMLElement>('*')].filter((el) => /auto|scroll/.test(el.style.overflowY))];
}

function fmt(s: number): string {
  if (s < 60) return `${Math.ceil(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${Math.ceil(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export type { Stack };
