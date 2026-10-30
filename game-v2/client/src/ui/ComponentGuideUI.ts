/**
 * The component guide (C, or Escape → Component guide): every buildable
 * component by tab, sorted by the level it's learned at. A row is its level,
 * its picture, its name, what still gates it for you (a level, a licence,
 * a rare boss part) and what making it takes (red where you're short); its chevron opens its full numbers, mounting, trade-off and where
 * its rare part drops.
 *
 *   C / Esc  close
 */

import {
  CORE_CARGO, markName, partStats, PIECE_NAMES,
  type Bag, type Catalog, type ShipTuning,
} from '@space-game/common';
import bossData from '../../../data/bosses.json';
import systemsData from '../../../data/systems.json';
import questsData from '../../../data/quests.json';
import recipesData from '../../../data/recipes.json';
import type { PilotState } from '../econ/clientEcon';
import { GameWindow } from './windowKit';
import { itemIcon } from './itemIcons';
import { partSprite, peekSprite, type SpritePart } from './componentSprites';
import { familyLabel, mountingText, sizeText, tradeOff, keyStats } from '../ships/modelCards';
import { partTipHtml, resistText } from '../ships/partTip';
import {
  bossDrops, COMP_TABS, guideRows, questTeaches, rareParts, requirementLine, rowGates, rowItemId, rowsOf, STRUCTURE_FNS,
  type BossDrop, type CompRow, type CompTab, type Gate, type GateCtx, type PilotView,
} from './componentGuide';

export interface ComponentGuideDeps {
  catalog: Catalog;
  tuning: ShipTuning;
  pilot: PilotState;
  sound?(id: string, volume?: number): void;
}

const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const n0 = (v: number) => (Number.isFinite(v) ? Math.round(v).toLocaleString() : '—');

const PLATES = (recipesData as unknown as { parts: { plates: Record<string, string> } }).parts.plates;
const SYSTEM_NAME = new Map((systemsData as unknown as { systems: { id: string; name: string }[] }).systems.map((s) => [s.id, s.name]));
const DROPS = bossDrops(bossData as unknown as Parameters<typeof bossDrops>[0], (id) => SYSTEM_NAME.get(id));
const QUESTS = questTeaches(questsData as unknown as Parameters<typeof questTeaches>[0]);

const RED = '#d0613f';
const STYLE = `
.sgw.cg { width: min(940px, calc(100vw - 32px)); }
.cg .sgw-head { padding: 12px 14px 12px 18px; background: none; border-bottom: none; }
.cg .sgw-title { display: flex; align-items: center; gap: 10px; font: 800 15px 'Segoe UI', sans-serif; letter-spacing: 1.5px; color: #f1f5fb; }
.cg .sgw-title svg { width: 18px; height: 18px; }
.cg .sgw-x { width: 30px; height: 30px; border-radius: 5px; border: 1px solid rgba(140, 170, 220, 0.28); background: rgba(4, 8, 16, 0.45); font-size: 16px; }
.cg .sgw-tabs { gap: 4px; padding: 6px 14px 0; border-bottom: 2px solid ${RED}; }
.cg .sgw-tab { padding: 7px 14px 6px; margin-bottom: 0; border: 1px solid rgba(140, 170, 220, 0.2); border-bottom: none; border-radius: 4px 4px 0 0;
  background: rgba(30, 42, 64, 0.55); color: #9fb0c8; font: 700 11px 'Segoe UI', sans-serif; letter-spacing: 1px; text-transform: uppercase; }
.cg .sgw-tab:hover { color: #fff; background: rgba(44, 60, 90, 0.7); }
.cg .sgw-tab.on { background: ${RED}; border-color: ${RED}; color: #fff; }
.cg .sgw-tab .badge { background: rgba(0, 0, 0, 0.28); color: inherit; font-weight: 600; letter-spacing: 0; }
.cg-cols { display: grid; grid-template-columns: 76px 150px 1fr 46px; padding: 8px 32px 4px 18px; font: 700 9px 'Segoe UI', sans-serif; letter-spacing: 1.5px; color: #6f8099; text-transform: uppercase; }
.cg-cols span { text-align: center; }
.cg-cols span:nth-child(3) { text-align: left; padding-left: 14px; }
.cg .sgw-body { padding: 2px 14px 16px 18px; scrollbar-gutter: stable; }
.cg-row { margin-bottom: 6px; border-radius: 6px; overflow: hidden; background: rgba(26, 36, 56, 0.72); border: 1px solid rgba(140, 170, 220, 0.09);
  content-visibility: auto; contain-intrinsic-size: auto 106px; }
.cg-row.open { border-color: rgba(140, 170, 220, 0.24); }
.cg-main { display: grid; grid-template-columns: 76px 150px 1fr 46px; min-height: 104px; }
.cg-lv { display: flex; flex-direction: column; align-items: center; justify-content: center; background: rgba(3, 6, 14, 0.42); }
.cg-lv small { font: 700 10px 'Segoe UI', sans-serif; letter-spacing: 1.5px; color: #8394ad; }
.cg-lv b { font: 800 30px 'Segoe UI', sans-serif; color: #f0b54a; line-height: 1.05; font-variant-numeric: tabular-nums; }
.cg-lv b.none { font-size: 22px; color: #6f8099; }
.cg-gfx { display: grid; place-items: center; padding: 4px; min-width: 0; }
.cg-gfx img { max-width: 146px; max-height: 128px; pointer-events: none; }
.cg-det { display: flex; flex-direction: column; justify-content: center; gap: 6px; padding: 10px 14px; min-width: 0; }
.cg-name { font: 800 19px 'Segoe UI', sans-serif; letter-spacing: 1px; text-transform: uppercase; color: #f1f5fb; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cg-req { display: flex; align-items: flex-start; gap: 6px; font: 600 12.5px 'Segoe UI', sans-serif; color: #f0846a; line-height: 1.35; }
.cg-req svg { width: 13px; height: 13px; flex-shrink: 0; margin-top: 1px; }
.cg-req.met { color: #7fc79a; font-weight: 500; }
.cg-mats { display: flex; flex-wrap: wrap; gap: 4px 14px; align-items: center; font: 600 12px 'Segoe UI', sans-serif; color: #d6deeb; }
.cg-mat { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
.cg-mat img { width: 18px; height: 18px; }
.cg-mat.short { color: #f87171; }
.cg-mats .per { color: #6f8099; font-weight: 400; font-size: 11px; }
.cg-x { all: unset; cursor: pointer; display: grid; place-items: center; color: #9fb0c8; border-left: 1px solid rgba(140, 170, 220, 0.07); }
.cg-x:hover { background: rgba(125, 211, 252, 0.07); color: #fff; }
.cg-x svg { width: 16px; height: 16px; transition: transform 0.15s; }
.cg-row.open .cg-x svg { transform: rotate(180deg); }
.cg-more { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr); gap: 18px; padding: 12px 16px 16px 92px; border-top: 1px solid rgba(140, 170, 220, 0.1); background: rgba(3, 6, 14, 0.22); }
.cg-more h5 { margin: 10px 0 5px; font: 700 10px 'Segoe UI', sans-serif; letter-spacing: 1.8px; color: #7dd3fc; text-transform: uppercase; }
.cg-more h5:first-child { margin-top: 0; }
.cg-more p { margin: 0 0 6px; color: #a9b6c9; line-height: 1.5; }
.cg-more p.trade { color: #cbd5e1; font-style: italic; }
.cg-kv { display: flex; justify-content: space-between; gap: 12px; padding: 2px 0; border-bottom: 1px solid #18223a; font-size: 12px; }
.cg-kv span { color: #8ea0bd; }
.cg-kv b { color: #e5ecf7; font-weight: 600; text-align: right; }
.cg-gate { display: flex; gap: 6px; align-items: flex-start; font-size: 12px; padding: 2px 0; color: #f0846a; }
.cg-gate.met { color: #7fc79a; }
.cg-gate svg { width: 12px; height: 12px; flex-shrink: 0; margin-top: 2px; }
.cg-src { font-size: 12px; color: #a9b6c9; padding: 2px 0; }
.cg-src b { color: #e5ecf7; font-weight: 600; }
.cg-tip { font-size: 12px; line-height: 1.35; }
.cg-tip > div:first-child { display: none; }
.cg-t { width: 100%; border-collapse: collapse; font-size: 12px; }
.cg-t th { text-align: left; font: 700 9px 'Segoe UI', sans-serif; letter-spacing: 1.2px; color: #6f8099; text-transform: uppercase; padding: 3px 6px; border-bottom: 1px solid rgba(140, 170, 220, 0.16); }
.cg-t td { padding: 4px 6px; border-bottom: 1px solid rgba(140, 170, 220, 0.07); color: #c4cfde; }
.cg-t td.n { text-align: right; font-variant-numeric: tabular-nums; }
.cg-you { display: flex; align-items: center; gap: 10px; margin: 8px 0 10px; font: 700 10px 'Segoe UI', sans-serif; letter-spacing: 1.8px; color: #f0b54a; text-transform: uppercase; }
.cg-you::before, .cg-you::after { content: ''; flex: 1; height: 1px; background: rgba(240, 181, 74, 0.35); }
@media (max-width: 640px) {
  .cg-main, .cg-cols { grid-template-columns: 58px 92px 1fr 36px; }
  .cg-gfx img { max-width: 88px; max-height: 96px; }
  .cg-more { grid-template-columns: 1fr; padding-left: 16px; }
}`;

const LOCK = `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M4 7V5a4 4 0 1 1 8 0v2h.5A1.5 1.5 0 0 1 14 8.5v5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 13.5v-5A1.5 1.5 0 0 1 3.5 7H4Zm2 0h4V5a2 2 0 1 0-4 0v2Z"/></svg>`;
const CHECK = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5 6.5 12 13 4.5"/></svg>`;
const CHEVRON = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 6 8 10.5 12.5 6"/></svg>`;
const ICON = `<svg viewBox="0 0 18 18"><rect x="3" y="9" width="12" height="7" rx="1" fill="${RED}"/><rect x="7.5" y="2" width="3" height="8" fill="#e8a38f"/><rect x="5.5" y="7" width="7" height="3" rx="1" fill="#f3c4b5"/></svg>`;

let styled = false;

export class ComponentGuideUI {
  private win: GameWindow;
  private tab: CompTab = 'weapons';
  private rows: CompRow[];
  private open_ = new Set<string>();
  private dirty = false;
  /** What the list on show was drawn for (a change in either redraws it all), and each row's markup as last written */
  private shown = '';
  private rowMarkup = new Map<string, string>();
  /** Rows whose picture still has to be drawn (a few ms each: done a little at a time when the browser is idle) */
  private spriteQueue: string[] = [];
  private spriteTimer = 0;

  constructor(private deps: ComponentGuideDeps) {
    if (!styled) {
      styled = true;
      const s = document.createElement('style');
      s.textContent = STYLE;
      document.head.appendChild(s);
    }
    this.win = new GameWindow('Component guide');
    this.win.root.classList.add('cg');
    this.win.head.querySelector('.sgw-title')!.innerHTML = `${ICON}COMPONENT GUIDE`;
    this.win.tabs.style.display = '';
    const cols = document.createElement('div');
    cols.className = 'cg-cols';
    cols.innerHTML = '<span>Level</span><span>Graphic</span><span>Detail</span><span></span>';
    this.win.root.insertBefore(cols, this.win.body);
    this.win.onClose = () => this.deps.sound?.('ui_close', 0.6);
    this.rows = guideRows(deps.catalog, PLATES);
    this.win.body.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-row]');
      if (!b) return;
      const id = b.dataset.row!;
      if (this.open_.has(id)) this.open_.delete(id); else this.open_.add(id);
      this.deps.sound?.('ui_click', 0.4);
      this.renderRow(id);
    });
    // New cargo, storage or level while it's open: redraw (once a frame at most)
    deps.pilot.onChange(() => {
      if (!this.isOpen || this.dirty) return;
      this.dirty = true;
      requestAnimationFrame(() => { this.dirty = false; if (this.isOpen) this.refresh(); });
    });
  }

  get isOpen(): boolean {
    return this.win.isOpen;
  }

  open(tab?: CompTab): void {
    if (tab) this.tab = tab;
    this.deps.sound?.('ui_open', 0.6);
    this.render();
    this.win.open();
  }

  close(): void {
    this.win.close();
  }

  toggle(): void {
    if (this.isOpen) this.close(); else this.open();
  }

  private view(): PilotView {
    const p = this.deps.pilot;
    return { level: p.profile?.level ?? 1, learned: p.profile?.recipes ?? [], have: (id) => p.count(id) };
  }

  private inputs(row: CompRow): Bag {
    return this.deps.pilot.econ.recipes.recipeFor(rowItemId(row))?.inputs ?? {};
  }

  private ctx(row: CompRow): GateCtx {
    return { items: this.deps.pilot.econ.items.all(), quests: QUESTS, drops: DROPS, inputs: this.inputs(row) };
  }

  private gates(row: CompRow): Gate[] {
    return rowGates(row, this.deps.catalog.functions.get(row.fn), this.view(), this.ctx(row));
  }

  private render(): void {
    const me = this.view();
    const counts = new Map(COMP_TABS.map((t) => [t.id, rowsOf(this.rows, t.id)]));
    this.win.tabs.innerHTML = COMP_TABS.map((t) => {
      const list = counts.get(t.id)!;
      const open = list.filter((r) => requirementLine(this.gates(r)).met).length;
      return `<button class="sgw-tab${t.id === this.tab ? ' on' : ''}" data-tab="${t.id}">${t.label}<span class="badge">${open}/${list.length}</span></button>`;
    }).join('');
    for (const b of this.win.tabs.querySelectorAll<HTMLElement>('[data-tab]')) {
      b.onclick = () => {
        if (this.tab === b.dataset.tab) return;
        this.tab = b.dataset.tab as CompTab;
        this.deps.sound?.('ui_click', 0.4);
        this.render();
        this.win.body.scrollTop = 0;
      };
    }
    const list = counts.get(this.tab)!;
    this.win.sub.textContent = `Level ${me.level} · ${list.length} components`;
    const scroll = this.win.body.scrollTop;
    // (A rule where the levels pass yours)
    let html = '', marked = false;
    this.rowMarkup.clear();
    this.spriteQueue.length = 0;
    for (const r of list) {
      if (!marked && r.level !== null && r.level > me.level && list[0] !== r) { html += `<div class="cg-you">You are level ${me.level}</div>`; marked = true; }
      const inner = this.rowHtml(r);
      this.rowMarkup.set(r.id, inner);
      html += `<div class="cg-row${this.open_.has(r.id) ? ' open' : ''}" data-id="${esc(r.id)}">${inner}</div>`;
    }
    this.win.body.innerHTML = html;
    this.win.body.scrollTop = scroll;
    this.shown = `${this.tab}|${me.level}`;
    for (const r of list) this.fillSprite(r);
  }

  /** Cargo, storage or level changed while it's open: only the rows whose markup changed are rewritten (the whole list if the tab or level changed) */
  private refresh(): void {
    const me = this.view();
    if (this.shown !== `${this.tab}|${me.level}`) { this.render(); return; }
    const counts = new Map(COMP_TABS.map((t) => [t.id, rowsOf(this.rows, t.id)]));
    for (const b of this.win.tabs.querySelectorAll<HTMLElement>('[data-tab]')) {
      const list = counts.get(b.dataset.tab as CompTab)!;
      const badge = b.querySelector('.badge');
      const text = `${list.filter((r) => requirementLine(this.gates(r)).met).length}/${list.length}`;
      if (badge && badge.textContent !== text) badge.textContent = text;
    }
    for (const r of counts.get(this.tab)!) {
      const inner = this.rowHtml(r);
      if (this.rowMarkup.get(r.id) === inner) continue;
      this.rowMarkup.set(r.id, inner);
      const el = this.win.body.querySelector<HTMLElement>(`.cg-row[data-id="${CSS.escape(r.id)}"]`);
      if (!el) continue;
      el.innerHTML = inner;
      this.fillSprite(r);
    }
  }

  private renderRow(id: string): void {
    const el = this.win.body.querySelector<HTMLElement>(`.cg-row[data-id="${CSS.escape(id)}"]`);
    const r = this.rows.find((x) => x.id === id);
    if (!el || !r) return;
    el.classList.toggle('open', this.open_.has(id));
    const inner = this.rowHtml(r);
    this.rowMarkup.set(id, inner);
    el.innerHTML = inner;
    this.fillSprite(r);
  }

  private spriteParts(r: CompRow): SpritePart[] {
    // Structure: a hull, armour and cargo square side by side in its material
    return r.kind === 'structure' ? STRUCTURE_FNS.map((fn, i) => ({ fn, material: r.material, piece: 'sq', x: i * 1.15, y: 0 })) : [{ fn: r.fn, material: r.material, piece: r.piece }];
  }

  /** A row's picture slot: empty (and holding its place) until `fillSprite` puts the picture in */
  private sprite(r: CompRow): string {
    return `<img data-spr="${esc(r.id)}" width="60" height="60" alt="" style="visibility:hidden">`;
  }

  /** Put a row's picture in its slot: at once if it has been drawn before, else when the browser has a moment */
  private fillSprite(r: CompRow): void {
    const el = this.win.body.querySelector<HTMLImageElement>(`img[data-spr="${CSS.escape(r.id)}"]`);
    if (!el) return;
    const hit = peekSprite(this.spriteParts(r));
    if (hit) { this.setSprite(el, hit); return; }
    if (!this.spriteQueue.includes(r.id)) this.spriteQueue.push(r.id);
    if (!this.spriteTimer) this.spriteTimer = this.later(() => this.drawSprites());
  }

  private setSprite(el: HTMLImageElement, s: { url: string; w: number; h: number }): void {
    el.src = s.url;
    el.width = Math.round(s.w);
    el.height = Math.round(s.h);
    el.style.visibility = '';
  }

  private later(fn: (deadline?: { timeRemaining(): number }) => void): number {
    const ric = (window as unknown as { requestIdleCallback?: (f: (d: { timeRemaining(): number }) => void, o?: { timeout: number }) => number }).requestIdleCallback;
    return ric ? ric(fn, { timeout: 200 }) : window.setTimeout(fn, 16);
  }

  /** Draw queued pictures while there's idle time (always one, so it can't stall), top of the list first */
  private drawSprites(deadline?: { timeRemaining(): number }): void {
    this.spriteTimer = 0;
    const t0 = performance.now();
    while (this.spriteQueue.length && this.isOpen) {
      const id = this.spriteQueue.shift()!;
      const r = this.rows.find((x) => x.id === id);
      const el = this.win.body.querySelector<HTMLImageElement>(`img[data-spr="${CSS.escape(id)}"]`);
      if (r && el) this.setSprite(el, partSprite(this.deps.catalog, this.spriteParts(r)));
      if (deadline ? deadline.timeRemaining() < 3 : performance.now() - t0 > 8) break;
    }
    if (this.spriteQueue.length && this.isOpen) this.spriteTimer = this.later((d) => this.drawSprites(d));
  }

  private rowHtml(r: CompRow): string {
    const { econ } = this.deps.pilot;
    const me = this.view();
    const gates = this.gates(r);
    const req = requirementLine(gates);
    const bag = r.kind === 'model' ? this.inputs(r) : econ.recipes.partInputs({ material: r.material, fn: r.fn, piece: r.piece });
    const mats = Object.entries(bag).map(([id, n]) => {
      const have = me.have(id);
      return `<span class="cg-mat${have < n ? ' short' : ''}" title="${esc(econ.items.name(id))}: you have ${have}"><img src="${itemIcon(econ, id)}" alt="">x ${n}</span>`;
    }).join('') + (r.kind === 'structure' ? '<span class="per">a hull cell</span>' : '');
    const main = `<div class="cg-main">
      <div class="cg-lv"><small>LV</small>${r.level === null ? '<b class="none">—</b>' : `<b>${r.level}</b>`}</div>
      <div class="cg-gfx">${this.sprite(r)}</div>
      <div class="cg-det">
        <div class="cg-name" title="${esc(r.name)}">${esc(r.name)}</div>
        <div class="cg-req${req.met ? ' met' : ''}">${req.met ? CHECK : LOCK}<span>${esc(req.text)}</span></div>
        <div class="cg-mats">${mats || '<span class="per">Nothing to fabricate</span>'}</div>
      </div>
      <button class="cg-x" data-row="${esc(r.id)}" title="${this.open_.has(r.id) ? 'Less' : 'More details'}">${CHEVRON}</button>
    </div>`;
    return this.open_.has(r.id) ? main + `<div class="cg-more">${this.moreHtml(r, gates)}</div>` : main;
  }

  /** The expanded row: what it is and does, how it mounts, and how to get it (left); its numbers (right) */
  private moreHtml(r: CompRow, gates: Gate[]): string {
    const { catalog, tuning } = this.deps;
    const { econ } = this.deps.pilot;
    const fn = catalog.functions.get(r.fn);
    if (!fn) return '';
    const kv = (k: string, v: string) => `<div class="cg-kv"><span>${k}</span><b>${v}</b></div>`;
    let left = '', right = '';
    if (r.kind === 'structure') {
      const m = catalog.materials.get(r.material)!;
      left += `<h5>The material</h5>`;
      left += kv('Grade', `${markName(m.grade ?? 1)} · ${esc(m.name ?? m.id)}`);
      left += kv('Toughness · density', `${m.toughness} hp a cell · ${m.density}`);
      if (m.traits?.length) left += kv('Traits', esc(m.traits.join(', ').replace(/_/g, ' ')));
      const res = resistText(m.resist);
      if (res) left += kv('Takes', res);
      right += `<h5>Built in ${esc(m.name ?? m.id)} (a square)</h5><table class="cg-t"><tr><th>Part</th><th class="n">HP</th><th class="n">Armour</th><th class="n">Mass</th><th>Takes</th></tr>`;
      for (const f of [...STRUCTURE_FNS, 'core']) {
        const st = partStats(catalog, tuning, { fn: f, material: r.material, piece: 'sq' });
        if (!st) continue;
        const cost = econ.recipes.partInputs({ material: r.material, fn: f, piece: 'sq' });
        right += `<tr><td>${esc(catalog.functions.get(f)?.name ?? f)}</td><td class="n">${n0(st.hp)}</td><td class="n">${st.armour}</td><td class="n">${st.mass.toFixed(1)}</td><td>${this.bagHtml(cost)}</td></tr>`;
      }
      right += `</table><p style="margin-top:8px; font-size:11px">Structure is built from plate as it goes in: no fabricator.</p>`;
    } else {
      if (fn.description) left += `<p>${esc(fn.description)}</p>`;
      const t = tradeOff(fn);
      if (r.kind === 'model' && t && !(fn.description ?? '').toLowerCase().includes(t.toLowerCase())) left += `<p class="trade">${esc(t)}</p>`;
      left += `<h5>At a glance</h5>`;
      if (r.kind === 'model') left += kv('Family', esc(familyLabel(fn)));
      left += kv('Size', esc(r.kind === 'model' ? sizeText(catalog, fn) : `${PIECE_NAMES[r.piece] ?? r.piece}, or any piece`));
      left += kv('Grade', `${markName(catalog.materials.get(r.material)?.grade ?? 1)} · ${esc(catalog.materials.get(r.material)?.name ?? r.material)}${fn.rarity ? ` · ${esc(fn.rarity)}` : ''}`);
      const key = keyStats(catalog, tuning, fn, r.piece, r.material);
      if (key) left += kv('Key numbers', esc(key));
      const words = mountingText(catalog, { fn: fn.id });
      if (words.length) left += kv('Mounting', esc(words.join(' · ')));
      const rec = econ.recipes.recipeFor(rowItemId(r));
      if (rec) left += kv('Fabricating', rec.time > 0 ? `${n0(rec.time)} s` : 'instant');
      if (r.kind === 'core') left += kv('Cargo', n0(CORE_CARGO));
      right += `<h5>Numbers</h5><div class="cg-tip">${partTipHtml({ fn: fn.id, material: r.material, piece: r.piece }, { catalog, tuning, econ, free: true, have: (id) => this.deps.pilot.count(id), canMake: (id) => this.deps.pilot.canMake(id) })}</div>`;
    }
    left += `<h5>Getting it</h5>`;
    for (const g of gates) left += `<div class="cg-gate${g.met ? ' met' : ''}">${g.met ? CHECK : LOCK}<span>${esc(g.met ? cap(g.done) : g.text)}</span></div>`;
    // Where its rare parts drop
    for (const p of rareParts(this.ctx(r))) left += `<div class="cg-src"><b>${esc(p.name)}</b>: ${this.dropText(p.drops)} · you have ${this.deps.pilot.count(p.id)}</div>`;
    return `<div>${left}</div><div>${right}</div>`;
  }

  private dropText(drops: BossDrop[]): string {
    return drops.map((d) => `dropped by ${esc(d.boss)}${d.system ? ` (${esc(d.system)})` : ''}${d.chance < 1 ? `, ${Math.round(d.chance * 100)}% a kill` : ''}`).join('; ');
  }

  private bagHtml(bag: Bag): string {
    const { econ } = this.deps.pilot;
    return Object.entries(bag).map(([id, n]) => `<span class="cg-mat${this.deps.pilot.count(id) < n ? ' short' : ''}" title="${esc(econ.items.name(id))}"><img src="${itemIcon(econ, id)}" alt="">x ${n}</span>`).join(' ');
  }
}
