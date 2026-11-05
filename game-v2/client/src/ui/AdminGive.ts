/**
 * The admin panel's item browser (Me → Give items, or a player's ⋯ menu):
 * every item in the catalogue as a card (icon, name in its rarity colour,
 * category, value, id), filtered as you type and by category tabs, with ship
 * parts by their fabricator tab and material. Pick who gets it (you, or anyone
 * online), how many, and Give; recent gifts sit on top for repeats.
 *
 * The list is built from the client's item catalogue when the window opens,
 * so new items (and generated parts) show up by themselves; parts whose
 * function is marked `legacy` are hidden unless asked for. Giving runs the
 * server's admin `give` command, so it's admins only exactly as before.
 */

import { CATEGORY_LABEL, RARITY_COLOR, type AdminPlayerInfo, type Economy, type ItemDef } from '@space-game/common';
import { itemIcon } from './itemIcons';
import { hideTip, itemTipHtml, showTip } from './windowKit';

export interface AdminGiveDeps {
  econ: Economy;
  /** Runs an admin command */
  cmd(cmd: string, args: Record<string, unknown>): void;
  /** Everyone online (the admin stats), and which of them is you */
  players(): AdminPlayerInfo[];
  myId(): number;
  /** Items the server knows (adminInfo): any the client's catalogue lacks still get a card */
  serverItems(): { id: string; name: string }[];
}

/** A card's item: the catalogue's def, or a bare one for a server-only id */
interface Entry { d: ItemDef; group: string; words: string[]; partCat?: string; material?: string; legacy: boolean }

const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** Cards drawn at a time (more as you scroll) */
const PAGE = 120;
const RECENT_KEY = 'sg.admin.giveRecent';
const RECENT_MAX = 12;

/** The category tabs, in list order (`other` catches categories added later) */
const GROUPS: { id: string; label: string; test(d: ItemDef): boolean }[] = [
  { id: 'mineral', label: 'Minerals', test: (d) => d.category === 'mineral' || d.category === 'volatile' },
  { id: 'refined', label: 'Refined', test: (d) => d.category === 'refined' },
  { id: 'component', label: 'Components', test: (d) => d.category === 'component' },
  { id: 'gem', label: 'Gems', test: (d) => d.category === 'gem' || d.category === 'jewel' },
  { id: 'artefact', label: 'Artefacts', test: (d) => d.category === 'artefact' },
  { id: 'consumable', label: 'Consumables', test: (d) => d.category === 'consumable' },
  { id: 'ammo', label: 'Ammo', test: (d) => d.category === 'ammo' },
  { id: 'quest', label: 'Job items', test: (d) => d.category === 'quest' },
  { id: 'part', label: 'Ship parts', test: (d) => d.category === 'part' },
];
const GROUP_ORDER = [...GROUPS.map((g) => g.id), 'other'];
/** Parts' fabricator tabs (functions.json `category`), in this order; others after */
const PART_CATS = ['weapons', 'power', 'engines', 'shields', 'utility', 'core', 'structure'];

/** Recent gifts, newest first (kept in this browser) */
export function loadGiveRecents(): { id: string; n: number }[] {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]').filter((r: { id?: unknown; n?: unknown }) => typeof r.id === 'string' && typeof r.n === 'number'); } catch { return []; }
}

let styled = false;
function injectStyles(): void {
  if (styled) return;
  styled = true;
  const css = document.createElement('style');
  css.textContent = `
.adm.agv { right: 384px; width: min(780px, calc(100vw - 408px)); height: min(680px, calc(100vh - 150px)); max-height: none; z-index: 2401; }
@media (max-width: 900px) { .adm.agv { left: 8px !important; right: 8px; top: 8px !important; width: auto; height: calc(100vh - 16px); } }
.agv-tools { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; padding: 8px 12px 0; }
.agv-tools .adm-in { padding: 6px 9px; }
.agv-chips { display: flex; gap: 4px; flex-wrap: wrap; padding: 7px 12px 0; }
.agv-chips .adm-btn { display: inline-flex; gap: 5px; align-items: center; }
.agv-chips .adm-btn i { font-style: normal; color: #8a7f86; font-size: 10px; }
.agv-chips .adm-btn.on i { color: #ffd7cc; }
.agv-chips .adm-btn.none { opacity: 0.35; }
.agv-sub { padding-top: 5px; }
.agv-sub .adm-btn { border-style: dashed; }
.agv-count { color: #8a7f86; font-size: 11px; padding: 6px 12px 2px; display: flex; gap: 8px; }
.agv-count label { margin-left: auto; display: inline-flex; gap: 4px; align-items: center; cursor: pointer; }
.agv-recent { display: flex; gap: 5px; align-items: center; padding: 6px 12px 0; overflow-x: auto; flex-shrink: 0; }
.agv-recent > span { color: #8a7f86; font-size: 10px; letter-spacing: 1px; text-transform: uppercase; margin-right: 2px; }
.agv-rec { all: unset; cursor: pointer; position: relative; width: 34px; height: 34px; flex-shrink: 0; border-radius: 8px; display: grid; place-items: center;
  border: 1px solid var(--rc, rgba(255,150,120,0.28)); background: radial-gradient(circle at 50% 35%, rgba(255,255,255,0.07), rgba(0,0,0,0.3)); }
.agv-rec:hover { background: radial-gradient(circle at 50% 35%, rgba(255,255,255,0.14), rgba(0,0,0,0.2)); }
.agv-rec img { width: 80%; height: 80%; pointer-events: none; }
.agv-rec b { position: absolute; right: 2px; bottom: 0; font: 700 9px 'Segoe UI', sans-serif; color: #fff; text-shadow: 0 1px 2px #000, 0 0 3px #000; }
.agv-grid { flex: 1; min-height: 0; overflow-y: auto; padding: 8px 12px; display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 6px; align-content: start; }
.agv-card { all: unset; box-sizing: border-box; cursor: pointer; display: grid; grid-template-columns: 46px 1fr; gap: 3px 9px; align-items: center; padding: 6px 8px 6px 6px; min-width: 0;
  border-radius: 9px; border: 1px solid rgba(255, 255, 255, 0.07); border-left: 3px solid var(--rc); background: rgba(0, 0, 0, 0.28); transition: background 0.1s, border-color 0.1s; }
.agv-card:hover { background: rgba(255, 138, 106, 0.08); border-color: rgba(255, 138, 106, 0.3); border-left-color: var(--rc); }
.agv-card.on { background: rgba(255, 138, 106, 0.16); border-color: #ff8a6a; border-left-color: var(--rc); }
.agv-card.flash { animation: agvFlash 0.7s ease-out; }
@keyframes agvFlash { from { box-shadow: 0 0 0 2px rgba(126, 224, 160, 0.9); } to { box-shadow: 0 0 0 2px transparent; } }
.agv-ic { grid-row: 1 / 4; width: 46px; height: 46px; border-radius: 8px; display: grid; place-items: center; border: 1px solid var(--rcd);
  background: radial-gradient(circle at 50% 35%, rgba(255,255,255,0.07), rgba(0,0,0,0.3)); }
.agv-ic img { width: 86%; height: 86%; pointer-events: none; }
.agv-nm { font-weight: 600; font-size: 12px; line-height: 1.25; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.agv-meta { display: flex; gap: 6px; font-size: 10.5px; color: #a99aa1; min-width: 0; }
.agv-meta span:first-child { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.agv-meta .v { margin-left: auto; color: #ffd166; white-space: nowrap; }
.agv-id { font: 10px 'Consolas', monospace; color: #6f656b; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; cursor: copy; }
.agv-id:hover { color: #cfc4c8; }
.agv-more { grid-column: 1 / -1; color: #8a7f86; text-align: center; padding: 8px; font-size: 11px; }
.agv-empty { grid-column: 1 / -1; color: #8a7f86; text-align: center; padding: 30px 8px; }
.agv-foot { border-top: 1px solid rgba(255, 140, 110, 0.18); padding: 8px 12px 10px; display: flex; flex-direction: column; gap: 6px; background: rgba(0, 0, 0, 0.2); border-radius: 0 0 12px 12px; }
.agv-sel { display: flex; gap: 8px; align-items: center; min-width: 0; }
.agv-sel .agv-ic { width: 34px; height: 34px; grid-row: auto; flex-shrink: 0; }
.agv-sel .nm { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.agv-sel .none { color: #8a7f86; }
.agv-act { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.agv-act .lbl { color: #8a7f86; }
.agv-act .adm-in.n { width: 64px; text-align: right; }
.agv-act select.adm-in { max-width: 190px; }
.agv-give { background: rgba(255, 138, 106, 0.25); border-color: #ff8a6a; color: #fff; font-weight: 600; padding: 6px 14px; margin-left: auto; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
.agv-give:hover { background: rgba(255, 138, 106, 0.4); }
.agv-give.off { opacity: 0.4; pointer-events: none; }
.agv-status { font: 11px 'Consolas', monospace; color: #8a7f86; min-height: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.agv-status.ok { color: #9fe0b5; } .agv-status.bad { color: #ff9a8a; }
`;
  document.head.appendChild(css);
}

export class AdminGive {
  private root = document.createElement('div');
  private searchIn: HTMLInputElement;
  private chips: HTMLElement;
  private sub: HTMLElement;
  private count: HTMLElement;
  private recentEl: HTMLElement;
  private grid: HTMLElement;
  private selEl: HTMLElement;
  private toSel: HTMLSelectElement;
  private qtyIn: HTMLInputElement;
  private giveBtn: HTMLElement;
  private status: HTMLElement;
  private more: IntersectionObserver;

  private entries: Entry[] = [];
  private byId = new Map<string, Entry>();
  private shown: Entry[] = [];
  private limit = PAGE;
  private search = '';
  private group = 'all';
  private partCat = '';
  private material = '';
  private showLegacy = false;
  private selected: string | null = null;
  /** Recipient: an online player's entity id (-1: you) */
  private to = -1;
  private recent: { id: string; n: number }[] = [];
  /** Gives sent and not answered yet (the next admin results are theirs) */
  private pending = 0;
  private playersKey: string | null = null;

  constructor(private deps: AdminGiveDeps) {
    injectStyles();
    this.recent = loadGiveRecents();
    this.root.className = 'adm agv';
    this.root.innerHTML = `
      <div class="adm-head"><span class="adm-title">GIVE ITEMS</span><span class="sp"></span><span class="k" data-total></span><button class="adm-x" title="Close (Esc)">×</button></div>
      <div class="agv-tools"><input class="adm-in adm-grow" data-k="q" placeholder="Search by name, id or category (e.g. alloy laser, ore, part:steel)" spellcheck="false"></div>
      <div class="agv-chips" data-chips></div>
      <div class="agv-chips agv-sub" data-sub></div>
      <div class="agv-recent" data-recent></div>
      <div class="agv-count" data-count></div>
      <div class="agv-grid" data-grid></div>
      <div class="agv-foot">
        <div class="agv-sel" data-sel></div>
        <div class="agv-act">
          <span class="lbl">To</span><select class="adm-in" data-k="to"></select>
          <span class="lbl">Qty</span><input class="adm-in n" data-k="n" value="1" inputmode="numeric">
          ${[1, 10, 100].map((n) => `<button class="adm-btn sm" data-q="${n}">${n}</button>`).join('')}
          <button class="adm-btn agv-give off" data-give>Give</button>
        </div>
        <div class="agv-status" data-status>Click an item, then Give · double-click gives at once · Enter in the search picks the top match</div>
      </div>`;
    const q = <T extends HTMLElement>(s: string) => this.root.querySelector<T>(s)!;
    this.searchIn = q('[data-k="q"]');
    this.chips = q('[data-chips]');
    this.sub = q('[data-sub]');
    this.count = q('[data-count]');
    this.recentEl = q('[data-recent]');
    this.grid = q('[data-grid]');
    this.selEl = q('[data-sel]');
    this.toSel = q('[data-k="to"]');
    this.qtyIn = q('[data-k="n"]');
    this.giveBtn = q('[data-give]');
    this.status = q('[data-status]');

    q('.adm-x').addEventListener('click', () => this.close());
    this.searchIn.addEventListener('input', () => { this.search = this.searchIn.value.trim().toLowerCase(); this.render(); });
    this.searchIn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && this.shown.length) { this.select(this.shown[0].d.id); if (e.ctrlKey) this.give(); }
    });
    this.toSel.addEventListener('change', () => { this.to = Number(this.toSel.value); this.syncFoot(); });
    this.qtyIn.addEventListener('input', () => this.syncFoot());
    this.qtyIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.give(); });
    this.root.querySelectorAll<HTMLElement>('[data-q]').forEach((b) => b.addEventListener('click', () => { this.qtyIn.value = b.dataset.q!; this.syncFoot(); }));
    this.giveBtn.addEventListener('click', () => this.give());
    // Typing in the window never flies the ship; Esc shuts it
    this.root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.close(); return; }
      if (['INPUT', 'SELECT'].includes((e.target as HTMLElement).tagName)) e.stopPropagation();
    });
    // One handler for every card: select, give, copy the id, tooltips
    this.grid.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const card = t.closest<HTMLElement>('[data-id]');
      if (!card) return;
      if (t.closest('.agv-id')) this.copy(card.dataset.id!);
      this.select(card.dataset.id!);
    });
    this.grid.addEventListener('dblclick', (e) => { const card = (e.target as HTMLElement).closest<HTMLElement>('[data-id]'); if (card) { this.select(card.dataset.id!); this.give(); } });
    this.grid.addEventListener('mousemove', (e) => {
      const card = (e.target as HTMLElement).closest<HTMLElement>('[data-id]');
      if (!card) { hideTip(); return; }
      const id = card.dataset.id!;
      if (this.deps.econ.items.has(id)) showTip(itemTipHtml(this.deps.econ, id, { hint: 'Click to pick · double-click to give' }), e.clientX, e.clientY);
    });
    this.grid.addEventListener('mouseleave', hideTip);
    this.grid.addEventListener('scroll', hideTip, { passive: true });
    // Scrolled to the end of what's drawn: draw the next lot
    this.more = new IntersectionObserver((es) => { if (es.some((x) => x.isIntersecting) && this.limit < this.shown.length) { this.limit += PAGE; this.drawCards(); } }, { root: this.grid, rootMargin: '200px' });
    this.dragging();
    document.body.appendChild(this.root);
  }

  get isOpen(): boolean {
    return this.root.classList.contains('on');
  }

  /** Open it, maybe for a player (their entity id) and with an item picked */
  open(opts: { to?: number; item?: string; n?: number } = {}): void {
    this.build();
    if (opts.to !== undefined) this.to = opts.to === this.deps.myId() ? -1 : opts.to;
    if (opts.item && this.byId.has(opts.item)) this.selected = opts.item;
    if (opts.n) this.qtyIn.value = String(opts.n);
    this.root.classList.add('on');
    this.playersKey = null;
    this.syncPlayers();
    this.render();
    this.searchIn.focus();
    this.searchIn.select();
  }

  close(): void {
    this.root.classList.remove('on');
    hideTip();
  }

  /** The admin stats came: who's online */
  onStats(): void {
    if (this.isOpen) this.syncPlayers();
  }

  /** An admin result: true if it answered one of our gives */
  onResult(ok: boolean, text: string): boolean {
    if (!this.pending) return false;
    this.pending--;
    this.status.className = `agv-status ${ok ? 'ok' : 'bad'}`;
    this.status.textContent = `${ok ? '✓' : '✗'} ${text}`;
    return true;
  }

  destroy(): void {
    this.more.disconnect();
    this.root.remove();
  }

  // ---------------------------------------------------------------------------

  /** Every item, from the catalogue as it is now */
  private build(): void {
    const { econ } = this.deps;
    const defs = econ.items.all();
    const known = new Set(defs.map((d) => d.id));
    // (Items the server has and this client's catalogue doesn't: a plain card)
    for (const s of this.deps.serverItems()) {
      if (!known.has(s.id)) defs.push({ id: s.id, name: s.name, category: 'other' as ItemDef['category'], rarity: 'common', value: 0, color: '#9aa4b2', description: '' });
    }
    this.entries = defs.map((d) => {
      const group = GROUPS.find((g) => g.test(d))?.id ?? 'other';
      let partCat: string | undefined, material: string | undefined, legacy = false, extra = '';
      if (d.part) {
        const fn = econ.ships.functions.get(d.part.fn) as ({ category?: string; legacy?: boolean; name?: string } | undefined);
        partCat = fn?.category ?? 'other';
        material = d.part.material;
        legacy = !!fn?.legacy;
        extra = `${partCat} ${econ.ships.materials.get(material)?.name ?? material} ${fn?.name ?? d.part.fn} ${d.part.piece}`;
      }
      const label = this.categoryText(d, partCat);
      const words = [...new Set(`${d.name} ${d.id} ${label} ${d.category} ${d.rarity} ${d.short ?? ''} ${extra}`.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean))];
      return { d, group, words, partCat, material, legacy };
    });
    const rank = (e: Entry) => econ.items.rank(e.d.id);
    this.entries.sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) || rank(a) - rank(b));
    this.byId = new Map(this.entries.map((e) => [e.d.id, e]));
    if (this.selected && !this.byId.has(this.selected)) this.selected = null;
    this.recent = this.recent.filter((r) => this.byId.has(r.id));
  }

  private categoryText(d: ItemDef, partCat?: string): string {
    if (d.part) return `Part · ${cap(partCat ?? 'other')}`;
    return CATEGORY_LABEL[d.category] ?? cap(String(d.category));
  }

  /** Does it match the search? Each word typed starts a word of its name, id, category, material... (or, typed with : or _, it's part of the id) */
  private matches(e: Entry, words: string[]): boolean {
    return (/[:_]/.test(this.search) && e.d.id.toLowerCase().includes(this.search)) || words.every((w) => e.words.some((x) => x.startsWith(w)));
  }

  private render(): void {
    const words = this.search.split(/[^a-z0-9]+/).filter(Boolean);
    const base = this.entries.filter((e) => (this.showLegacy || !e.legacy) && (!words.length || this.matches(e, words)));
    // Tabs, with how many of the matches are in each
    const counts = new Map<string, number>();
    for (const e of base) counts.set(e.group, (counts.get(e.group) ?? 0) + 1);
    if (this.group !== 'all' && !GROUP_ORDER.includes(this.group)) this.group = 'all';
    const tabs = [{ id: 'all', label: 'All', n: base.length }, ...GROUP_ORDER.map((id) => ({ id, label: GROUPS.find((g) => g.id === id)?.label ?? 'Other', n: counts.get(id) ?? 0 }))]
      .filter((t) => t.id !== 'other' || t.n);
    this.chips.innerHTML = tabs.map((t) => `<button class="adm-btn sm${t.id === this.group ? ' on' : ''}${t.n ? '' : ' none'}" data-g="${t.id}">${esc(t.label)}<i>${t.n.toLocaleString()}</i></button>`).join('');
    this.chips.querySelectorAll<HTMLElement>('[data-g]').forEach((b) => b.addEventListener('click', () => { this.group = b.dataset.g!; this.partCat = ''; this.material = ''; this.render(); }));

    let list = this.group === 'all' ? base : base.filter((e) => e.group === this.group);
    // Parts: by fabricator tab and material
    if (this.group === 'part') {
      const cats = new Map<string, number>(), mats = new Map<string, number>();
      for (const e of list) cats.set(e.partCat!, (cats.get(e.partCat!) ?? 0) + 1);
      const inCat = this.partCat ? list.filter((e) => e.partCat === this.partCat) : list;
      for (const e of inCat) mats.set(e.material!, (mats.get(e.material!) ?? 0) + 1);
      const catIds = [...cats.keys()].sort((a, b) => (PART_CATS.indexOf(a) + 1 || 99) - (PART_CATS.indexOf(b) + 1 || 99) || a.localeCompare(b));
      const matIds = [...this.deps.econ.ships.materials.keys()].filter((m) => mats.has(m));
      if (this.material && !mats.has(this.material)) this.material = '';
      this.sub.innerHTML = `<button class="adm-btn sm${this.partCat ? '' : ' on'}" data-pc="">Any kind</button>`
        + catIds.map((c) => `<button class="adm-btn sm${c === this.partCat ? ' on' : ''}" data-pc="${esc(c)}">${esc(cap(c))}<i>${cats.get(c)}</i></button>`).join('')
        + `<select class="adm-in" data-k="mat" style="margin-left:auto"><option value="">Any material</option>${matIds.map((m) => `<option value="${esc(m)}"${m === this.material ? ' selected' : ''}>${esc(this.deps.econ.ships.materials.get(m)?.name ?? cap(m))} (${mats.get(m)})</option>`).join('')}</select>`;
      this.sub.style.display = '';
      this.sub.querySelectorAll<HTMLElement>('[data-pc]').forEach((b) => b.addEventListener('click', () => { this.partCat = b.dataset.pc!; this.render(); }));
      this.sub.querySelector<HTMLSelectElement>('[data-k="mat"]')!.addEventListener('change', (ev) => { this.material = (ev.target as HTMLSelectElement).value; this.render(); });
      list = inCat.filter((e) => !this.material || e.material === this.material);
    } else {
      this.sub.style.display = 'none';
      this.sub.replaceChildren();
    }
    // Best matches first: the exact id or name, then names that start with what's typed
    if (words.length) {
      const q = this.search;
      const score = (e: Entry) => (e.d.id.toLowerCase() === q || e.d.name.toLowerCase() === q ? 0 : e.d.name.toLowerCase().startsWith(q) ? 1 : e.d.name.toLowerCase().includes(q) ? 2 : 3);
      list = list.map((e, i) => ({ e, i, s: score(e) })).sort((a, b) => a.s - b.s || a.i - b.i).map((x) => x.e);
    }
    this.shown = list;
    this.limit = PAGE;
    const legacyN = this.entries.filter((e) => e.legacy).length;
    this.count.innerHTML = `<span>${list.length.toLocaleString()} item${list.length === 1 ? '' : 's'}${words.length ? ` matching “${esc(this.search)}”` : ''}</span>`
      + (legacyN ? `<label title="Old material-graded parts (functions marked legacy)"><input type="checkbox" data-legacy${this.showLegacy ? ' checked' : ''}> Legacy parts (${legacyN})</label>` : '');
    this.count.querySelector('[data-legacy]')?.addEventListener('change', (ev) => { this.showLegacy = (ev.target as HTMLInputElement).checked; this.render(); });
    (this.root.querySelector('[data-total]') as HTMLElement).textContent = `${this.entries.filter((e) => this.showLegacy || !e.legacy).length.toLocaleString()} in the catalogue`;
    this.grid.scrollTop = 0;
    this.grid.replaceChildren();
    this.drawCards();
    this.drawRecent();
    this.syncFoot();
  }

  /** The cards up to `limit` (appends to what's there) */
  private drawCards(): void {
    this.grid.querySelector('.agv-more')?.remove();
    const have = this.grid.querySelectorAll('.agv-card').length;
    if (!this.shown.length) {
      this.grid.innerHTML = `<div class="agv-empty">${this.search ? `Nothing matches “${esc(this.search)}”` : 'Nothing here'}${this.group !== 'all' ? ' in this tab' : ''}</div>`;
      return;
    }
    const html = this.shown.slice(have, this.limit).map((e) => this.cardHtml(e)).join('');
    this.grid.insertAdjacentHTML('beforeend', html);
    if (this.limit < this.shown.length) {
      const m = document.createElement('div');
      m.className = 'agv-more';
      m.textContent = `${(this.shown.length - this.limit).toLocaleString()} more: scroll on, or narrow the search`;
      this.grid.appendChild(m);
      this.more.disconnect();
      this.more.observe(m);
    }
  }

  private cardHtml(e: Entry): string {
    const d = e.d;
    const rc = RARITY_COLOR[d.rarity] ?? '#c8d0dc';
    const icon = this.deps.econ.items.has(d.id) ? itemIcon(this.deps.econ, d.id) : '';
    return `<button class="agv-card${d.id === this.selected ? ' on' : ''}" data-id="${esc(d.id)}" style="--rc:${rc};--rcd:${rc}55">
      <span class="agv-ic">${icon ? `<img src="${icon}" alt="">` : ''}</span>
      <span class="agv-nm" style="color:${rc}">${esc(d.name)}</span>
      <span class="agv-meta"><span>${esc(this.categoryText(d, e.partCat))} · ${esc(d.rarity)}</span><span class="v">${d.value ? `${d.value.toLocaleString()} cr` : '—'}</span></span>
      <span class="agv-id" title="${esc(d.id)} · click to copy">${esc(d.id)}</span>
    </button>`;
  }

  private drawRecent(): void {
    const list = this.recent.filter((r) => this.byId.has(r.id));
    if (!list.length) { this.recentEl.style.display = 'none'; return; }
    this.recentEl.style.display = '';
    this.recentEl.innerHTML = '<span>Recent</span>' + list.map((r) => {
      const d = this.byId.get(r.id)!.d;
      const rc = RARITY_COLOR[d.rarity] ?? '#c8d0dc';
      return `<button class="agv-rec" data-rec="${esc(r.id)}" data-n="${r.n}" style="--rc:${rc}88" title="${esc(d.name)} ×${r.n} · click to pick, double-click to give again">${this.deps.econ.items.has(r.id) ? `<img src="${itemIcon(this.deps.econ, r.id)}" alt="">` : ''}<b>${r.n >= 1000 ? `${Math.floor(r.n / 1000)}k` : r.n}</b></button>`;
    }).join('');
    this.recentEl.querySelectorAll<HTMLElement>('[data-rec]').forEach((b) => {
      b.addEventListener('click', () => { this.qtyIn.value = b.dataset.n!; this.select(b.dataset.rec!); });
      b.addEventListener('dblclick', () => this.give());
    });
  }

  private select(id: string): void {
    this.selected = id;
    this.grid.querySelectorAll<HTMLElement>('.agv-card.on').forEach((c) => c.classList.remove('on'));
    this.grid.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`)?.classList.add('on');
    this.syncFoot();
  }

  private qty(): number {
    return Math.max(1, Math.round(Number(this.qtyIn.value) || 1));
  }

  /** Who gets it, as the server names them (undefined: you) */
  private recipient(): { player?: string; name: string } {
    if (this.to < 0) return { name: 'you' };
    const p = this.deps.players().find((x) => x.id === this.to);
    return { player: String(this.to), name: p?.name ?? `#${this.to}` };
  }

  /** The picked item and the Give button's words */
  private syncFoot(): void {
    const e = this.selected ? this.byId.get(this.selected) : undefined;
    if (!e) {
      this.selEl.innerHTML = '<span class="none">No item picked</span>';
      this.giveBtn.textContent = 'Give';
      this.giveBtn.classList.add('off');
      return;
    }
    const d = e.d;
    const rc = RARITY_COLOR[d.rarity] ?? '#c8d0dc';
    this.selEl.innerHTML = `<span class="agv-ic" style="--rcd:${rc}88">${this.deps.econ.items.has(d.id) ? `<img src="${itemIcon(this.deps.econ, d.id)}" alt="">` : ''}</span>
      <span style="min-width:0;display:flex;flex-direction:column"><span class="nm" style="color:${rc}">${esc(d.name)}</span><span class="agv-id" data-copy title="Click to copy">${esc(d.id)}</span></span>`;
    this.selEl.querySelector('[data-copy]')!.addEventListener('click', () => this.copy(d.id));
    const n = this.qty();
    this.giveBtn.textContent = `Give ${n.toLocaleString()} × ${d.name} to ${this.recipient().name}`;
    this.giveBtn.title = this.giveBtn.textContent;
    this.giveBtn.classList.remove('off');
  }

  /** The recipient list: you, then everyone else online */
  private syncPlayers(): void {
    const me = this.deps.myId();
    const others = this.deps.players().filter((p) => p.id !== me).sort((a, b) => a.name.localeCompare(b.name));
    const key = others.map((p) => `${p.id}:${p.name}`).join('|');
    if (key === this.playersKey || document.activeElement === this.toSel) return;
    this.playersKey = key;
    if (this.to >= 0 && !others.some((p) => p.id === this.to)) {
      // (They left: back to you, and say so)
      if (this.isOpen) { this.status.className = 'agv-status bad'; this.status.textContent = 'That player went offline: giving to you'; }
      this.to = -1;
    }
    const myName = this.deps.players().find((p) => p.id === me)?.name;
    this.toSel.innerHTML = `<option value="-1">You${myName ? ` (${esc(myName)})` : ''}</option>`
      + (others.length ? `<optgroup label="Online">${others.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</optgroup>` : '');
    this.toSel.value = String(this.to);
    this.syncFoot();
  }

  private give(): void {
    const id = this.selected;
    if (!id) return;
    const n = this.qty();
    const who = this.recipient();
    this.pending++;
    this.deps.cmd('give', { item: id, n, ...(who.player ? { player: who.player } : {}) });
    this.status.className = 'agv-status';
    this.status.textContent = `Giving ${n.toLocaleString()} × ${this.byId.get(id)?.d.name ?? id} to ${who.name}…`;
    this.recent = [{ id, n }, ...this.recent.filter((r) => r.id !== id)].slice(0, RECENT_MAX);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(this.recent)); } catch { /* no storage */ }
    this.drawRecent();
    const card = this.grid.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`);
    if (card) { card.classList.remove('flash'); void card.offsetWidth; card.classList.add('flash'); }
  }

  private copy(id: string): void {
    navigator.clipboard?.writeText(id).then(
      () => { this.status.className = 'agv-status'; this.status.textContent = `Copied ${id}`; },
      () => { this.status.className = 'agv-status'; this.status.textContent = id; },
    );
  }

  /** Drag the window by its header */
  private dragging(): void {
    const head = this.root.querySelector<HTMLElement>('.adm-head')!;
    head.addEventListener('mousedown', (e) => {
      if ((e.target as HTMLElement).closest('button')) return;
      const r = this.root.getBoundingClientRect();
      const ox = e.clientX - r.left, oy = e.clientY - r.top;
      const move = (m: MouseEvent) => {
        this.root.style.left = `${Math.max(0, Math.min(window.innerWidth - 80, m.clientX - ox))}px`;
        this.root.style.top = `${Math.max(0, Math.min(window.innerHeight - 40, m.clientY - oy))}px`;
        this.root.style.right = 'auto';
      };
      const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
      e.preventDefault();
    });
  }
}
