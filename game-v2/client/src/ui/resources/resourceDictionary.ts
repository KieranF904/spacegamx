/**
 * @contract client.ui.resource-dictionary
 * owns:       the field guide's Resources tab shell: the search box, the Resources / Rocks / Enemies / Systems icon grids, category chips with icons, a small preview on mouseover or focus, and a full detail page on click (history, Back, breadcrumbs, Esc) in place of the grid
 * needs:      resourceGrid, entryCards (the tiles, the preview and the page), pageNav (history, crumbs), categoryIcons, guideChips (the chips and their CSS), resourceFocus (a pending link), ../escape, DOM (wireResources only)
 * invariants: search, chips and views only hide tiles, they never re-render, so the box keeps focus while typing — client/src/ui/resources/resourceDictionary.test.ts
 *             a data-go chip on a page opens that entry, Back returns to the one before or to the grid as it was, Esc does the same — client/src/ui/resources/pageNav.test.ts
 * extend:     a new view is one grid function, one entry in VIEWS and one data-go prefix
 */

import { esc } from '../escape';
import { resourceEntries } from './resourceData';
import { takePendingResource } from './resourceFocus';
import { CATEGORY_LABEL, CATEGORY_ORDER, type ResourceCategory } from './resourceIndex';
import { categoryIcon } from './categoryIcons';
import { crumbsOf, popPage, pushPage, type Page } from './pageNav';
import { CHIPS_CSS, type ResourceDeps } from './guideChips';
import { CARDS_CSS, pageHtml, previewHtml, type View } from './entryCards';
import { enemyGridHtml, GRID_CSS, resourceGridHtml, rockGridHtml, systemGridHtml } from './resourceGrid';

export type { ResourceDeps };

const VIEWS: { id: View; label: string }[] = [
  { id: 'res', label: 'Resources' },
  { id: 'rock', label: 'Rocks' },
  { id: 'enemy', label: 'Enemies' },
  { id: 'sys', label: 'Systems' },
];

/** The last search, chip and view, kept while the guide is open (the guide re-renders on a tab switch) */
let lastDeps: ResourceDeps | undefined;
const state: { q: string; cat: ResourceCategory | 'all'; view: View } = { q: '', cat: 'all', view: 'res' };

export const RESOURCE_CSS = `
#game-menu .rd-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 10px 0 8px; position: sticky; top: -4px; z-index: 2; padding: 6px 0; background: rgba(9, 15, 28, 0.96); }
#game-menu .rd-bar input { flex: 1; min-width: 200px; padding: 7px 12px; border-radius: 8px; background: rgba(4, 8, 16, 0.7); border: 1px solid rgba(140, 170, 220, 0.3); color: #e8f0fb; font: 14px 'Segoe UI', sans-serif; user-select: text; }
#game-menu .rd-bar input:focus { outline: none; border-color: rgba(125, 211, 252, 0.7); }
#game-menu .rd-chips { display: flex; flex-wrap: wrap; gap: 5px; width: 100%; align-items: center; }
#game-menu .rd-chip { all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 5px; padding: 3px 11px; border-radius: 999px; border: 1px solid rgba(140, 170, 220, 0.22); color: #9fb3cc; font-size: 12px; }
#game-menu .rd-chip:hover, #game-menu .rd-chip:focus-visible { color: #fff; border-color: rgba(125, 211, 252, 0.6); }
#game-menu .rd-chip.on { background: rgba(125, 211, 252, 0.15); border-color: rgba(125, 211, 252, 0.55); color: #fff; }
#game-menu .rd-chip[hidden], #game-menu .rd-sep[hidden] { display: none; }
#game-menu .rd-chip.view { font-weight: 600; font-size: 13px; padding: 4px 14px; }
#game-menu .rd-ic { flex: none; opacity: 0.85; }
#game-menu .rd-sep { width: 1px; height: 16px; background: rgba(140, 170, 220, 0.25); margin: 0 4px; }
#game-menu .rd-count { color: #6f8099; font-size: 12px; }
#game-menu .rd-none { color: #6f8099; font-style: italic; padding: 14px 4px; }
#game-menu .rd [hidden] { display: none; }
#game-menu .rd-panes { min-width: 0; }
#game-menu .rd.paged .rd-bar, #game-menu .rd.paged .rd-main { display: none; }
#game-menu .rd-nav { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin: 6px 0 10px; position: sticky; top: -4px; z-index: 2; padding: 6px 0; background: rgba(9, 15, 28, 0.96); }
#game-menu .rd-nav .rd-back { all: unset; cursor: pointer; color: #7dd3fc; font-size: 13px; padding: 4px 12px; border-radius: 999px; border: 1px solid rgba(125, 211, 252, 0.4); }
#game-menu .rd-nav .rd-back:hover, #game-menu .rd-nav .rd-back:focus-visible { background: rgba(125, 211, 252, 0.14); color: #fff; }
#game-menu .rd-crumbs { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 12.5px; color: #8394ad; }
#game-menu .rd-crumbs button { all: unset; cursor: pointer; color: #9fb3cc; display: inline-flex; align-items: center; gap: 4px; }
#game-menu .rd-crumbs button:hover, #game-menu .rd-crumbs button:focus-visible { color: #fff; text-decoration: underline; }
#game-menu .rd-crumbs .cur { color: #fff; font-weight: 600; }
#game-menu .rd-crumbs .sep { color: #4a586e; }
#game-menu .rg-preview { position: fixed; z-index: 50; width: 260px; box-sizing: border-box; pointer-events: none; padding: 10px 12px 11px; border-radius: 10px; background: rgba(9, 15, 28, 0.98); border: 1px solid rgba(125, 211, 252, 0.45); box-shadow: 0 6px 20px rgba(0, 0, 0, 0.55); }` + CHIPS_CSS + GRID_CSS + CARDS_CSS;

/** The Resources tab: search box, view tabs, category chips, the four icon grids, the preview and the detail page area (wireResources makes them work) */
export function resourcesHtml(d: ResourceDeps): string {
  lastDeps = d;
  const entries = resourceEntries();
  const cats = [['all', 'All'] as const, ...CATEGORY_ORDER.filter((c) => entries.some((e) => e.category === c)).map((c) => [c, CATEGORY_LABEL[c]] as const)];
  const grids: Record<View, string> = { res: resourceGridHtml(d), rock: rockGridHtml(d), enemy: enemyGridHtml(d), sys: systemGridHtml(d) };
  return `<div class="rd" data-resources>
    <div class="rd-bar"><input type="search" placeholder="Search by name, place or use (try &quot;Void Sector&quot; or &quot;lens&quot;)" value="${esc(state.q)}" aria-label="Search the guide">
      <span class="rd-count" aria-live="polite"></span>
      <div class="rd-chips" role="group" aria-label="Views">${VIEWS.map((v) => `<button class="rd-chip view${state.view === v.id ? ' on' : ''}" data-view-tab="${v.id}">${categoryIcon(v.id, 15)}${v.label}</button>`).join('')}
        <span class="rd-sep" data-res-only></span>
        ${cats.map(([id, label]) => `<button class="rd-chip${state.cat === id ? ' on' : ''}" data-rcat="${id}" data-res-only>${categoryIcon(id)}${esc(label)}</button>`).join('')}</div></div>
    <div class="rd-main"><div class="rd-panes">${VIEWS.map((v) => `<div data-view="${v.id}"${state.view === v.id ? '' : ' hidden'}>${grids[v.id]}</div>`).join('')}
      <p class="rd-none" hidden>Nothing matches.</p></div></div>
    <div class="rd-page" hidden aria-label="Details"></div>
    <div class="rg-preview" hidden role="tooltip"></div></div>`;
}

/** Hook up search, chips, views, the preview and the detail pages: filters hide and show, never re-render the grids, so typing keeps its focus and a return finds the grid as it was */
export function wireResources(root: HTMLElement, d: ResourceDeps | undefined = lastDeps): void {
  if (!d) return;
  const box = root.querySelector<HTMLElement>('[data-resources]');
  if (!box) return;
  const input = box.querySelector<HTMLInputElement>('input')!;
  const page = box.querySelector<HTMLElement>('.rd-page')!;
  const preview = box.querySelector<HTMLElement>('.rg-preview')!;
  const tilesOf = (v: View) => [...box.querySelectorAll<HTMLElement>(`[data-view="${v}"] .rg-tile`)];
  const tileOf = (v: View, id: string) => tilesOf(v).find((t) => t.dataset.id === id);
  const stack: Page[] = [];

  const apply = () => {
    const words = state.q.toLowerCase().split(/\s+/).filter(Boolean);
    const tiles = tilesOf(state.view);
    let shown = 0;
    for (const t of tiles) {
      const ok = (state.view !== 'res' || state.cat === 'all' || t.dataset.cat === state.cat) && words.every((w) => t.dataset.q!.includes(w));
      t.hidden = !ok;
      if (ok) shown++;
    }
    for (const g of box.querySelectorAll<HTMLElement>(`[data-view="${state.view}"] .rg-group`)) g.hidden = !g.querySelector('.rg-tile:not([hidden])');
    for (const v of VIEWS) box.querySelector<HTMLElement>(`[data-view="${v.id}"]`)!.hidden = v.id !== state.view;
    for (const b of box.querySelectorAll<HTMLElement>('[data-view-tab]')) b.classList.toggle('on', b.dataset.viewTab === state.view);
    for (const b of box.querySelectorAll<HTMLElement>('[data-rcat]')) { b.classList.toggle('on', b.dataset.rcat === state.cat); b.hidden = state.view !== 'res'; }
    box.querySelector<HTMLElement>('.rd-sep')!.hidden = state.view !== 'res';
    box.querySelector('.rd-count')!.textContent = `${shown} of ${tiles.length}`;
    box.querySelector<HTMLElement>('p.rd-none')!.hidden = shown > 0;
  };

  const hidePreview = () => { preview.hidden = true; };
  const showPreview = (t: HTMLElement) => {
    const html = previewHtml(t.dataset.viewOf as View, t.dataset.id!, d);
    if (!html) return hidePreview();
    preview.innerHTML = html;
    preview.hidden = false;
    const r = t.getBoundingClientRect();
    const w = preview.offsetWidth || 260, h = preview.offsetHeight || 120;
    const vw = window.innerWidth, vh = window.innerHeight;
    let x = r.left + r.width / 2 - w / 2;
    x = Math.max(8, Math.min(x, vw - w - 8));
    let y = r.bottom + 6;
    if (y + h > vh - 8) y = Math.max(8, r.top - h - 6);
    preview.style.left = `${x}px`;
    preview.style.top = `${y}px`;
  };

  /** The element that scrolls the guide, so a return lands where you left */
  const scroller = (): HTMLElement | null => {
    for (let el: HTMLElement | null = box.parentElement; el; el = el.parentElement) if (/(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight) return el;
    return null;
  };
  let gridScroll = 0;
  const getScroll = () => scroller()?.scrollTop ?? 0;
  const setScroll = (y: number) => { const sc = scroller(); if (sc) sc.scrollTop = y; };

  const navHtml = (p: Page) => {
    const crumbs = crumbsOf(p).map((c, i) => c.to
      ? `<button type="button" data-crumb="${c.to.view}${c.to.cat ? `:${c.to.cat}` : ''}">${i === 0 ? categoryIcon(c.to.view) : c.to.cat ? categoryIcon(c.to.cat) : ''}${esc(c.label)}</button>`
      : `<span class="cur">${esc(c.label)}</span>`).join('<span class="sep">›</span>');
    const prev = stack[stack.length - 2];
    return `<div class="rd-nav"><button type="button" class="rd-back" data-back>← Back${prev ? ` to ${esc(crumbsOf(prev).slice(-1)[0].label)}` : ' to the list'}</button><nav class="rd-crumbs" aria-label="Breadcrumb">${crumbs}</nav></div>`;
  };
  const showPage = () => {
    const p = stack[stack.length - 1];
    hidePreview();
    if (!p) { page.hidden = true; page.innerHTML = ''; box.classList.remove('paged'); return; }
    page.innerHTML = navHtml(p) + pageHtml(p.view, p.id, d);
    page.hidden = false;
    box.classList.add('paged');
  };
  /** Open an entry's page on top of where you are */
  const go = (v: View, id: string) => {
    const top = stack[stack.length - 1];
    if (top && top.view === v && top.id === id) return;
    if (top) top.scroll = getScroll(); else gridScroll = getScroll();
    pushPage(stack, { view: v, id });
    showPage();
    setScroll(0);
  };
  /** Back one page, or to the grid with its filters and scroll as they were */
  const back = () => {
    if (!stack.length) return;
    const prev = popPage(stack);
    showPage();
    setScroll(prev ? prev.scroll ?? 0 : gridScroll);
  };
  /** Straight to a grid (a breadcrumb): drop the whole history */
  const toGrid = (v: View, cat?: string) => {
    stack.length = 0;
    state.view = v;
    state.cat = (cat as ResourceCategory | undefined) ?? 'all';
    state.q = '';
    input.value = '';
    showPage();
    apply();
    setScroll(0);
  };

  input.addEventListener('input', () => { state.q = input.value; apply(); });
  box.addEventListener('mouseover', (ev) => { const t = (ev.target as HTMLElement).closest<HTMLElement>('.rg-tile'); if (t) showPreview(t); });
  box.addEventListener('mouseout', (ev) => { if ((ev.target as HTMLElement).closest('.rg-tile')) hidePreview(); });
  box.addEventListener('focusin', (ev) => { const t = (ev.target as HTMLElement).closest<HTMLElement>('.rg-tile'); if (t) showPreview(t); });
  box.addEventListener('focusout', (ev) => { if ((ev.target as HTMLElement).closest('.rg-tile')) hidePreview(); });
  box.addEventListener('click', (ev) => {
    const t = (ev.target as HTMLElement).closest<HTMLElement>('[data-go],[data-rcat],[data-view-tab],[data-back],[data-crumb],.rg-tile');
    if (!t) return;
    if (t.classList.contains('rg-tile')) go(t.dataset.viewOf as View, t.dataset.id!);
    else if (t.dataset.go) {
      const at = t.dataset.go.indexOf(':');
      go(t.dataset.go.slice(0, at) as View, t.dataset.go.slice(at + 1));
    } else if (t.dataset.rcat) { state.cat = t.dataset.rcat as ResourceCategory | 'all'; apply(); }
    else if (t.dataset.viewTab) { state.view = t.dataset.viewTab as View; apply(); }
    else if (t.dataset.crumb) { const [v, c] = t.dataset.crumb.split(':'); toGrid(v as View, c); }
    else if (t.hasAttribute('data-back')) back();
  });
  // Esc goes back a page (and hides the preview); it only claims the key while there is something to leave
  const onKey = (ev: KeyboardEvent) => {
    if (!box.isConnected) { document.removeEventListener('keydown', onKey, true); return; }
    if (ev.key !== 'Escape' || (!stack.length && preview.hidden)) return;
    ev.stopPropagation();
    ev.preventDefault();
    hidePreview();
    back();
  };
  document.addEventListener('keydown', onKey, true);
  apply();
  // (Sent here by a link elsewhere: open that resource's page)
  const want = takePendingResource();
  if (want && tileOf('res', want)) go('res', want);
}
