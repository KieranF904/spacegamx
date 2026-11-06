/**
 * The component guide (the side panel's Components tab: C, ui/hub/tabs/componentsTab.ts): every buildable component
 * by category, sorted by the level it's learned at. A row is its level, its picture, its name, what still gates it
 * for you (a level, a licence, a rare boss part) and what making it takes (red where you're short); its chevron opens
 * its full numbers, mounting, trade-off and where its rare part drops. Drawn compact for the HUD (rows 30 px: name and materials on one line, the gate under): pictures at a quarter
 * size, tight margins, one column when a row is opened.
 *
 * A view, not a window: mount(host) puts it in the panel's body, hide() takes it out (and stops drawing pictures).
 */

import {
  CORE_CARGO, markName, partStats, PIECE_NAMES,
  type Bag, type Catalog, type ShipTuning,
} from '@space-game/common';
import type { PilotState } from '../econ/clientEcon';
import { partSprite, peekSprite, type SpritePart } from './componentSprites';
import { familyLabel, mountingText, sizeText, tradeOff, keyStats } from '../ships/modelCards';
import { partTipHtml, resistText } from '../ships/partTip';
import {
  COMP_TABS, guideRows, rareParts, requirementLine, rowItemId, rowsOf, STRUCTURE_FNS,
  type BossDrop, type CompRow, type CompTab, type Gate, type GateCtx, type PilotView,
} from './componentGuide';
import { componentGates, gateCtx, PLATES, rowInputs } from './componentData';
import { costLines, isOpen, tabCounts } from './componentAvail';
import { CHECK, CHEVRON, costChipsHtml, esc, LOCK } from './componentKit';

export interface ComponentGuideDeps {
  catalog: Catalog;
  tuning: ShipTuning;
  pilot: PilotState;
  sound?(id: string, volume?: number): void;
}

const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const n0 = (v: number) => (Number.isFinite(v) ? Math.round(v).toLocaleString() : '—');

/** The pictures at this share of the size they're drawn at (the HUD panel is narrow) */
const SPRITE_SCALE = 0.25;

const RED = '#d0613f';
const STYLE = `
.cg { display: flex; flex-direction: column; min-height: 0; flex: 1; color: #c9d4e5; font: 12px 'Segoe UI', system-ui, sans-serif; }
.cg-cats { display: flex; gap: 3px; padding: 4px 6px 3px; border-bottom: 1px solid rgba(208, 97, 63, 0.55); flex-shrink: 0; overflow-x: auto; scrollbar-width: none; }
.cg-cats::-webkit-scrollbar { display: none; }
.cg-cat { all: unset; flex-shrink: 0; cursor: pointer; padding: 1px 5px; border-radius: 3px; border: 1px solid rgba(140, 170, 220, 0.2); background: rgba(30, 42, 64, 0.55);
  color: #9fb0c8; font: 700 8.5px/14px 'Segoe UI', sans-serif; letter-spacing: 0.5px; text-transform: uppercase; white-space: nowrap; }
.cg-cat:hover { color: #fff; background: rgba(44, 60, 90, 0.7); }
.cg-cat.on { background: ${RED}; border-color: ${RED}; color: #fff; }
.cg-cat .badge { margin-left: 4px; color: inherit; opacity: 0.75; font-weight: 600; letter-spacing: 0; }
.cg-cat:focus-visible { outline: 2px solid #6cc8ff; outline-offset: 1px; }
.cg-sub { color: #6f8099; font-size: 9.5px; padding: 0 1px 2px; }
.cg-list { flex: 1; min-height: 0; overflow-y: auto; padding: 3px 2px 6px 6px; scrollbar-gutter: stable; scrollbar-width: thin; scrollbar-color: rgba(125, 160, 210, 0.35) transparent; }
.cg-row { margin-bottom: 2px; border-radius: 4px; overflow: hidden; background: rgba(26, 36, 56, 0.72); border: 1px solid rgba(140, 170, 220, 0.09);
  content-visibility: auto; contain-intrinsic-size: auto 28px; }
.cg-row.open { border-color: rgba(140, 170, 220, 0.24); }
.cg-main { display: grid; grid-template-columns: 22px 28px minmax(0, 1fr) 20px; min-height: 26px; }
.cg-lv { display: flex; flex-direction: column; align-items: center; justify-content: center; background: rgba(3, 6, 14, 0.42); }
.cg-lv small { font: 700 7.5px 'Segoe UI', sans-serif; letter-spacing: 1px; color: #8394ad; }
.cg-lv b { font: 800 12px 'Segoe UI', sans-serif; color: #f0b54a; line-height: 1.05; font-variant-numeric: tabular-nums; }
.cg-lv b.none { font-size: 10px; color: #6f8099; }
.cg-gfx { display: grid; place-items: center; padding: 1px; min-width: 0; }
.cg-gfx img { max-width: 26px; max-height: 22px; width: auto; height: auto; pointer-events: none; }
.cg-det { display: flex; flex-direction: column; justify-content: center; gap: 0; padding: 1px 5px; min-width: 0; }
.cg-top { display: flex; align-items: center; gap: 6px; min-width: 0; }
.cg-name { flex: 1; min-width: 0; font: 800 10.5px/14px 'Segoe UI', sans-serif; letter-spacing: 0.5px; text-transform: uppercase; color: #f1f5fb; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cg-req { display: flex; align-items: center; gap: 3px; font: 600 9.5px/12px 'Segoe UI', sans-serif; color: #f0846a; white-space: nowrap; overflow: hidden; }
.cg-req span { overflow: hidden; text-overflow: ellipsis; }
.cg-req svg { width: 8px; height: 8px; flex-shrink: 0; }
.cg-req.met { color: #7fc79a; font-weight: 500; }
.cg-mats { display: flex; flex-shrink: 0; gap: 5px; align-items: center; font: 600 9.5px/12px 'Segoe UI', sans-serif; color: #d6deeb; }
.cg-mat { display: inline-flex; align-items: center; gap: 2px; white-space: nowrap; }
.cg-mat img { width: 11px; height: 11px; }
.cg-mat.short { color: #f87171; }
.cg-mats .per { color: #6f8099; font-weight: 400; font-size: 9px; }
.cg-x { all: unset; cursor: pointer; display: grid; place-items: center; color: #9fb0c8; border-left: 1px solid rgba(140, 170, 220, 0.07); }
.cg-x:hover { background: rgba(125, 211, 252, 0.07); color: #fff; }
.cg-x:focus-visible { outline: 2px solid #6cc8ff; outline-offset: -2px; }
.cg-x svg { width: 10px; height: 10px; transition: transform 0.15s; }
.cg-row.open .cg-x svg { transform: rotate(180deg); }
.cg-more { display: grid; grid-template-columns: minmax(0, 1fr); gap: 6px; padding: 6px 8px 8px; border-top: 1px solid rgba(140, 170, 220, 0.1); background: rgba(3, 6, 14, 0.22); font-size: 11px; }
.cg-more h5 { margin: 6px 0 3px; font: 700 9px 'Segoe UI', sans-serif; letter-spacing: 1.5px; color: #7dd3fc; text-transform: uppercase; }
.cg-more > div > h5:first-child { margin-top: 0; }
.cg-more p { margin: 0 0 4px; color: #a9b6c9; line-height: 1.4; }
.cg-more p.trade { color: #cbd5e1; font-style: italic; }
.cg-kv { display: flex; justify-content: space-between; gap: 8px; padding: 1px 0; border-bottom: 1px solid #18223a; font-size: 10.5px; }
.cg-kv span { color: #8ea0bd; flex-shrink: 0; }
.cg-kv b { color: #e5ecf7; font-weight: 600; text-align: right; }
.cg-gate { display: flex; gap: 4px; align-items: flex-start; font-size: 10.5px; padding: 1px 0; color: #f0846a; }
.cg-gate.met { color: #7fc79a; }
.cg-gate svg { width: 10px; height: 10px; flex-shrink: 0; margin-top: 2px; }
.cg-src { font-size: 10.5px; color: #a9b6c9; padding: 1px 0; }
.cg-src b { color: #e5ecf7; font-weight: 600; }
.cg-tip { font-size: 10.5px; line-height: 1.3; }
.cg-tip > div:first-child { display: none; }
.cg-t { width: 100%; border-collapse: collapse; font-size: 10.5px; }
.cg-t th { text-align: left; font: 700 8px 'Segoe UI', sans-serif; letter-spacing: 1px; color: #6f8099; text-transform: uppercase; padding: 2px 3px; border-bottom: 1px solid rgba(140, 170, 220, 0.16); }
.cg-t td { padding: 2px 3px; border-bottom: 1px solid rgba(140, 170, 220, 0.07); color: #c4cfde; }
.cg-t td.n { text-align: right; font-variant-numeric: tabular-nums; }
.cg-t .cg-mat img { width: 11px; height: 11px; }
.cg-you { display: flex; align-items: center; gap: 6px; margin: 2px 0 3px; font: 700 9px 'Segoe UI', sans-serif; letter-spacing: 1.5px; color: #f0b54a; text-transform: uppercase; }
.cg-you::before, .cg-you::after { content: ''; flex: 1; height: 1px; background: rgba(240, 181, 74, 0.35); }
@media (prefers-reduced-motion: reduce) { .cg-x svg { transition: none; } }`;

let styled = false;

export class ComponentGuideUI {
  /** The whole view (the panel puts it in its body) */
  readonly root: HTMLDivElement;
  private cats: HTMLDivElement;
  private sub: HTMLDivElement;
  private list: HTMLDivElement;
  private shown = false;
  private tab: CompTab = 'weapons';
  private rows: CompRow[];
  private open_ = new Set<string>();
  private dirty = false;
  /** What the list on show was drawn for (a change in either redraws it all), and each row's markup as last written */
  private shownKey = '';
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
    this.root = document.createElement('div');
    this.root.className = 'cg';
    this.cats = document.createElement('div');
    this.cats.className = 'cg-cats';
    this.cats.setAttribute('role', 'group');
    this.cats.setAttribute('aria-label', 'Component categories');
    this.sub = document.createElement('div');
    this.sub.className = 'cg-sub';
    // (One row of categories that scrolls sideways: the wheel scrolls it too)
    this.cats.addEventListener('wheel', (e) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      this.cats.scrollLeft += e.deltaY;
      e.preventDefault();
    }, { passive: false });
    this.list = document.createElement('div');
    this.list.className = 'cg-list';
    this.root.append(this.cats, this.list);
    this.rows = guideRows(deps.catalog, PLATES);
    this.list.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-row]');
      if (!b) return;
      const id = b.dataset.row!;
      if (this.open_.has(id)) this.open_.delete(id); else this.open_.add(id);
      this.deps.sound?.('ui_click', 0.4);
      this.renderRow(id);
    });
    // New cargo, storage or level while it's on show: redraw (once a frame at most)
    deps.pilot.onChange(() => {
      if (!this.isOpen || this.dirty) return;
      this.dirty = true;
      requestAnimationFrame(() => { this.dirty = false; if (this.isOpen) this.refresh(); });
    });
  }

  /** On show in the panel */
  get isOpen(): boolean {
    return this.shown;
  }

  /** Put it in `host` and draw it (again: a tab change or a new level since) */
  mount(host: HTMLElement, tab?: CompTab): void {
    if (tab) this.tab = tab;
    if (this.root.parentElement !== host) host.appendChild(this.root);
    this.shown = true;
    this.render();
  }

  /** Off the screen: stop drawing pictures */
  hide(): void {
    this.shown = false;
    this.spriteQueue.length = 0;
    this.root.remove();
  }

  private view(): PilotView {
    const p = this.deps.pilot;
    return { level: p.profile?.level ?? 1, learned: p.profile?.recipes ?? [], have: (id) => p.count(id) };
  }

  private inputs(row: CompRow): Bag {
    return rowInputs(this.deps.pilot.econ, row);
  }

  private ctx(row: CompRow): GateCtx {
    return gateCtx(this.deps.pilot.econ, row);
  }

  private gates(row: CompRow): Gate[] {
    return componentGates(this.deps.catalog, this.deps.pilot.econ, row, this.view());
  }

  /** Each tab's open and total counts (its badge) */
  private counts(): Map<CompTab, { open: number; total: number }> {
    return tabCounts(this.rows, COMP_TABS, (r) => isOpen(this.gates(r)));
  }

  private render(): void {
    const me = this.view();
    const counts = this.counts();
    this.cats.innerHTML = COMP_TABS.map((t) => {
      const { open, total } = counts.get(t.id)!;
      return `<button class="cg-cat${t.id === this.tab ? ' on' : ''}" data-tab="${t.id}" aria-pressed="${t.id === this.tab}" title="${open} of ${total} open to you">${t.label}<span class="badge">${open}/${total}</span></button>`;
    }).join('');
    for (const b of this.cats.querySelectorAll<HTMLElement>('[data-tab]')) {
      b.onclick = () => {
        if (this.tab === b.dataset.tab) return;
        this.tab = b.dataset.tab as CompTab;
        this.deps.sound?.('ui_click', 0.4);
        this.render();
        this.list.scrollTop = 0;
        this.cats.querySelector<HTMLElement>('.cg-cat.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      };
    }
    const list = rowsOf(this.rows, this.tab);
    this.sub.textContent = `Level ${me.level} · ${list.length} components (the badges: open to you of each)`;
    const scroll = this.list.scrollTop;
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
    this.list.innerHTML = html;
    this.cats.title = this.sub.textContent;
    this.list.scrollTop = scroll;
    this.shownKey = `${this.tab}|${me.level}`;
    for (const r of list) this.fillSprite(r);
  }

  /** Cargo, storage or level changed while it's open: only the rows whose markup changed are rewritten (the whole list if the tab or level changed) */
  private refresh(): void {
    const me = this.view();
    if (this.shownKey !== `${this.tab}|${me.level}`) { this.render(); return; }
    const counts = this.counts();
    for (const b of this.cats.querySelectorAll<HTMLElement>('[data-tab]')) {
      const c = counts.get(b.dataset.tab as CompTab)!;
      const badge = b.querySelector('.badge');
      const text = `${c.open}/${c.total}`;
      if (badge && badge.textContent !== text) badge.textContent = text;
    }
    for (const r of rowsOf(this.rows, this.tab)) {
      const inner = this.rowHtml(r);
      if (this.rowMarkup.get(r.id) === inner) continue;
      this.rowMarkup.set(r.id, inner);
      const el = this.list.querySelector<HTMLElement>(`.cg-row[data-id="${CSS.escape(r.id)}"]`);
      if (!el) continue;
      el.innerHTML = inner;
      this.fillSprite(r);
    }
  }

  private renderRow(id: string): void {
    const el = this.list.querySelector<HTMLElement>(`.cg-row[data-id="${CSS.escape(id)}"]`);
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
    return `<img data-spr="${esc(r.id)}" width="15" height="15" alt="" style="visibility:hidden">`;
  }

  /** Put a row's picture in its slot: at once if it has been drawn before, else when the browser has a moment */
  private fillSprite(r: CompRow): void {
    const el = this.list.querySelector<HTMLImageElement>(`img[data-spr="${CSS.escape(r.id)}"]`);
    if (!el) return;
    const hit = peekSprite(this.spriteParts(r));
    if (hit) { this.setSprite(el, hit); return; }
    if (!this.spriteQueue.includes(r.id)) this.spriteQueue.push(r.id);
    if (!this.spriteTimer) this.spriteTimer = this.later(() => this.drawSprites());
  }

  private setSprite(el: HTMLImageElement, s: { url: string; w: number; h: number }): void {
    el.src = s.url;
    el.width = Math.round(s.w * SPRITE_SCALE);
    el.height = Math.round(s.h * SPRITE_SCALE);
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
      const el = this.list.querySelector<HTMLImageElement>(`img[data-spr="${CSS.escape(id)}"]`);
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
    const mats = costChipsHtml(econ, costLines(bag, me.have), 'cg-mat') +(r.kind === 'structure' ? '<span class="per">a hull cell</span>' : '');
    const main = `<div class="cg-main">
      <div class="cg-lv" title="${r.level === null ? 'No level' : `Learned at level ${r.level}`}">${r.level === null ? '<b class="none">—</b>' : `<b>${r.level}</b>`}</div>
      <div class="cg-gfx">${this.sprite(r)}</div>
      <div class="cg-det">
        <div class="cg-top"><div class="cg-name" title="${esc(r.name)}">${esc(r.name)}</div><div class="cg-mats">${mats || '<span class="per">nothing to fabricate</span>'}</div></div>
        <div class="cg-req${req.met ? ' met' : ''}" title="${esc(req.text)}">${req.met ? CHECK : LOCK}<span>${esc(req.text)}</span></div>
      </div>
      <button class="cg-x" data-row="${esc(r.id)}" title="${this.open_.has(r.id) ? 'Less' : 'More details'}" aria-label="${this.open_.has(r.id) ? 'Less' : 'More details'}: ${esc(r.name)}" aria-expanded="${this.open_.has(r.id)}">${CHEVRON}</button>
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
      // (Cold builds up slower in it: ships/warmth.ts)
      if (m.insulation) left += kv('Insulation', `keeps out ${Math.round(m.insulation * 100)}% of the cold, by its share of the hull`);
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
    return costChipsHtml(this.deps.pilot.econ, costLines(bag, (id) => this.deps.pilot.count(id)), 'cg-mat');
  }
}
