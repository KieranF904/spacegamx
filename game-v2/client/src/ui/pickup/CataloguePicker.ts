/**
 * @contract client.ui.pickup-picker
 * owns:       the item catalogue window the auto-pickup panel opens: a search box, section chips (Mining, Enemy drops, Components, Refined materials, Salvage, Templates), icon tiles saying where each item comes from, locked tiles above the pilot's level; a click whitelists an item for this hold or (+ Blacklist) toggles an ore on the blacklist
 * needs:      catalogue.ts (the contents), PilotState (level, the whitelist, mining mode, templates), itemIcons, the field guide's category icons and lock rule (resources/categoryIcons, resources/levels); npm: @space-game/common
 * invariants: search and chips only hide tiles (no re-render while typing); a click is one message (ghost or oreBlacklist) — client/src/ui/pickup/catalogue.test.ts
 * extend:     a new section is one in catalogue.ts SECTIONS (its chip and tiles follow)
 */

import type { ClientMessage } from '@space-game/common';
import type { PilotState } from '../../econ/clientEcon';
import { itemIcon } from '../itemIcons';
import { esc } from '../escape';
import { categoryIcon } from '../resources/categoryIcons';
import { isLocked } from '../resources/levels';
import { TIER_LABEL } from '../resources/tiers';
import { catalogue, matches, type CatalogueItem, type SectionId } from './catalogue';

export type PickMode = 'whitelist' | 'blacklist';

const SECTION_ICON: Record<SectionId | 'templates', string> = { mining: 'ore', drops: 'drop', component: 'component', refined: 'refined', salvage: 'pack', templates: 'all' };

let styled = false;
function injectStyles(): void {
  if (styled) return;
  styled = true;
  const css = document.createElement('style');
  css.textContent = `
.sgk { position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(760px, calc(100vw - 40px)); height: min(560px, calc(100vh - 60px)); z-index: 2700;
  display: none; flex-direction: column; box-sizing: border-box; padding: 12px 14px; border-radius: 12px; background: rgba(9, 15, 28, 0.97);
  border: 1px solid rgba(125, 211, 252, 0.35); box-shadow: 0 10px 40px rgba(0, 0, 0, 0.6); color: #c9d4e5; font: 12px 'Segoe UI', system-ui, sans-serif; }
.sgk.on { display: flex; }
.sgk-top { display: flex; gap: 10px; align-items: center; }
.sgk-top b { font: 700 11px 'Segoe UI', sans-serif; letter-spacing: 2px; color: #7dd3fc; }
.sgk-top input { flex: 1; padding: 6px 10px; border-radius: 8px; background: rgba(4, 8, 16, 0.7); border: 1px solid rgba(140, 170, 220, 0.3); color: #e8f0fb; font: 13px 'Segoe UI', sans-serif; }
.sgk-top .x { all: unset; cursor: pointer; color: #8394ad; font-size: 16px; padding: 0 4px; }
.sgk-chips { display: flex; flex-wrap: wrap; gap: 5px; margin: 8px 0; }
.sgk-chip { all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 5px; padding: 3px 11px; border-radius: 999px; border: 1px solid rgba(140, 170, 220, 0.22); color: #9fb3cc; }
.sgk-chip.on { background: rgba(125, 211, 252, 0.15); border-color: rgba(125, 211, 252, 0.55); color: #fff; }
.sgk-body { flex: 1; overflow-y: auto; scrollbar-width: thin; }
.sgk-sec[hidden], .sgk-grp[hidden], .sgk-tile[hidden] { display: none; }
.sgk-grp h4 { margin: 8px 0 5px; font: 700 10px 'Segoe UI', sans-serif; letter-spacing: 1.5px; text-transform: uppercase; color: #6f8099; }
.sgk-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(118px, 1fr)); gap: 6px; }
.sgk-tile { all: unset; box-sizing: border-box; position: relative; cursor: pointer; display: flex; flex-direction: column; align-items: center; gap: 3px; padding: 7px 4px 6px;
  border-radius: 9px; border: 1px solid rgba(140, 170, 220, 0.12); background: rgba(4, 8, 16, 0.45); text-align: center; }
.sgk-tile:hover, .sgk-tile:focus-visible { border-color: rgba(125, 211, 252, 0.7); background: rgba(125, 211, 252, 0.1); }
.sgk-tile img { width: 34px; height: 34px; }
.sgk-tile .nm { color: #dbe5f3; font-size: 11px; }
.sgk-tile .fr { color: #6f8099; font-size: 9.5px; line-height: 1.2; }
.sgk-tile .lv { position: absolute; top: 2px; right: 4px; font: 700 9px 'Segoe UI', sans-serif; color: #f59e0b; }
.sgk-tile.locked img, .sgk-tile.locked .nm { opacity: 0.45; filter: grayscale(0.6); }
.sgk-tile.picked { border-color: rgba(134, 239, 172, 0.7); background: rgba(134, 239, 172, 0.1); }
.sgk-tile.black { border-color: rgba(248, 113, 113, 0.7); background: rgba(248, 113, 113, 0.1); }
.sgk-tile.black .nm { text-decoration: line-through; }
.sgk-tile.off { opacity: 0.35; cursor: default; }
.sgk-tpl { display: flex; gap: 8px; align-items: center; padding: 4px 2px; }
.sgk-tpl span { flex: 1; }
.sgk-tpl button { all: unset; cursor: pointer; padding: 2px 10px; border-radius: 999px; border: 1px solid rgba(125, 211, 252, 0.4); color: #bae6fd; }
.sgk-hint { color: #6f8099; margin-top: 6px; }
`;
  document.head.appendChild(css);
}

export class CataloguePicker {
  private root: HTMLDivElement;
  private search: HTMLInputElement;
  private title: HTMLElement;
  private body: HTMLDivElement;
  private hint: HTMLDivElement;
  private mode: PickMode = 'whitelist';
  private section: SectionId | 'templates' | 'all' = 'all';
  private built = false;

  constructor(private pilot: PilotState, private send: (m: ClientMessage) => void, private sound: (id: string) => void) {
    injectStyles();
    this.root = document.createElement('div');
    this.root.className = 'sgk';
    this.root.innerHTML = `<div class="sgk-top"><b></b><input type="search" placeholder="Search items, enemies, places"><button type="button" class="x" aria-label="Close">×</button></div>
      <div class="sgk-chips"></div><div class="sgk-body"></div><div class="sgk-hint"></div>`;
    this.title = this.root.querySelector('b')!;
    this.search = this.root.querySelector('input')!;
    this.body = this.root.querySelector('.sgk-body') as HTMLDivElement;
    this.hint = this.root.querySelector('.sgk-hint') as HTMLDivElement;
    (this.root.querySelector('.x') as HTMLElement).onclick = () => this.close();
    this.search.addEventListener('input', () => this.filter());
    // (Typing here is not flying: the game's keys stay off while the box has focus)
    this.search.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') this.close(); });
    document.body.appendChild(this.root);
    pilot.onChange(() => { if (this.isOpen) this.marks(); });
  }

  get isOpen(): boolean { return this.root.classList.contains('on'); }

  open(mode: PickMode, section: SectionId | 'templates' | 'all' = mode === 'blacklist' ? 'mining' : 'all'): void {
    this.mode = mode;
    if (!this.built) this.build();
    this.root.classList.add('on');
    this.title.textContent = mode === 'blacklist' ? 'BLACKLIST AN ORE' : 'AUTO-PICKUP: ADD ITEMS';
    this.hint.textContent = mode === 'blacklist'
      ? 'Click an ore: mining mode leaves it (click again to collect it again). A whitelisted ore is still collected.'
      : 'Click an item: this hold picks it up by itself, keeping 5 units of space for it. Right-click it in the auto-pickup panel to set a target.';
    this.setSection(section);
    this.marks();
    this.search.value = '';
    this.filter();
    this.search.focus();
    this.sound('ui_open');
  }

  close(): void {
    if (!this.isOpen) return;
    this.root.classList.remove('on');
    this.sound('ui_close');
  }

  private build(): void {
    this.built = true;
    const chips = this.root.querySelector('.sgk-chips') as HTMLDivElement;
    const chip = (id: SectionId | 'templates' | 'all', label: string) => `<button type="button" class="sgk-chip" data-sec="${id}">${categoryIcon(id === 'all' ? 'all' : SECTION_ICON[id], 13)}${esc(label)}</button>`;
    chips.innerHTML = chip('all', 'All') + catalogue().map((s) => chip(s.id, s.label)).join('') + chip('templates', 'Templates');
    chips.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('[data-sec]') as HTMLElement | null;
      if (b) this.setSection(b.dataset.sec as SectionId);
    });
    const econ = this.pilot.econ;
    const tile = (t: CatalogueItem) => `<button type="button" class="sgk-tile" data-id="${esc(t.id)}" data-q="${esc(t.q)}" data-ore="${t.ore ? 1 : 0}"${t.level ? ` data-level="${t.level}"` : ''}>`
      + `<img src="${itemIcon(econ, t.id)}" alt="">${t.level ? `<span class="lv">Lv ${t.level}</span>` : ''}<span class="nm">${esc(t.name)}</span><span class="fr">${esc(t.tier ? `${TIER_LABEL[t.tier]} chance a kill` : t.from)}</span></button>`;
    this.body.innerHTML = catalogue().map((s) => `<section class="sgk-sec" data-sec="${s.id}">${s.groups.map((g) => `<div class="sgk-grp">${g.title ? `<h4>${esc(g.title)}</h4>` : ''}<div class="sgk-grid">${g.items.map(tile).join('')}</div></div>`).join('')}</section>`)
      + '<section class="sgk-sec" data-sec="templates"><div class="sgk-tpls"></div></section>';
    this.body.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('.sgk-tile') as HTMLElement | null;
      if (t && !t.classList.contains('off')) this.pick(t.dataset.id!);
      const b = (e.target as HTMLElement).closest('[data-tpl]') as HTMLElement | null;
      if (b) {
        const [act, name] = [b.dataset.act!, b.dataset.tpl!];
        this.send({ type: 'ghostTemplate', ...(act === 'load' ? { load: name } : { remove: name }) });
        this.sound('ui_click');
      }
    });
  }

  private setSection(id: SectionId | 'templates' | 'all'): void {
    this.section = id;
    for (const c of this.root.querySelectorAll<HTMLElement>('.sgk-chip')) c.classList.toggle('on', c.dataset.sec === id);
    this.filter();
  }

  /** A click: whitelist it for this hold, or toggle it on the blacklist */
  private pick(id: string): void {
    const p = this.pilot;
    if (this.mode === 'blacklist') {
      const on = !p.mining().blacklist?.includes(id);
      this.send({ type: 'oreBlacklist', item: id, on });
    } else if (p.ghosts.some((g) => g.item === id)) this.send({ type: 'ghost', item: id, remove: true });
    else this.send({ type: 'ghost', item: id });
    this.sound('ui_click');
  }

  /** What's whitelisted, blacklisted, locked and not pickable in this mode (no re-render) */
  private marks(): void {
    const p = this.pilot, level = p.profile?.level;
    const white = new Set(p.ghosts.map((g) => g.item)), black = new Set(p.mining().blacklist ?? []);
    for (const t of this.body.querySelectorAll<HTMLElement>('.sgk-tile')) {
      const id = t.dataset.id!;
      t.classList.toggle('picked', white.has(id));
      t.classList.toggle('black', black.has(id));
      t.classList.toggle('locked', isLocked(t.dataset.level ? Number(t.dataset.level) : undefined, level));
      t.classList.toggle('off', this.mode === 'blacklist' && t.dataset.ore !== '1');
    }
    const tpls = this.body.querySelector('.sgk-tpls') as HTMLElement;
    const list = p.profile?.pickup?.templates ?? [];
    tpls.innerHTML = list.length
      ? list.map((t) => `<div class="sgk-tpl"><span>${esc(t.name)} · ${t.ghosts.length} items</span><button type="button" data-tpl="${esc(t.name)}" data-act="load">Load</button><button type="button" data-tpl="${esc(t.name)}" data-act="remove">Delete</button></div>`).join('')
      : '<div class="sgk-hint">No templates yet: save this hold\'s list from the auto-pickup panel.</div>';
  }

  /** Search and the section chip only hide tiles */
  private filter(): void {
    const q = this.search.value;
    for (const sec of this.body.querySelectorAll<HTMLElement>('.sgk-sec')) {
      const showSec = this.section === 'all' ? sec.dataset.sec !== 'templates' : sec.dataset.sec === this.section;
      sec.hidden = !showSec;
      if (!showSec) continue;
      for (const g of sec.querySelectorAll<HTMLElement>('.sgk-grp')) {
        let any = false;
        for (const t of g.querySelectorAll<HTMLElement>('.sgk-tile')) {
          const hit = matches({ q: t.dataset.q ?? '' } as CatalogueItem, q);
          t.hidden = !hit;
          any ||= hit;
        }
        g.hidden = !any;
      }
    }
  }
}
