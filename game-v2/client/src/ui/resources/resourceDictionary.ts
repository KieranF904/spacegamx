/**
 * @contract client.ui.resource-dictionary
 * owns:       the field guide's Resources tab shell: the search box, the Resources / Rocks / Enemies / Systems icon grids, category chips, a small preview on mouseover or focus, and an extended-details drawer on click with a way back
 * needs:      resourceGrid, entryCards (the tiles and the two card levels), guideChips (the chips and their CSS), resourceFocus (a pending link), ../escape, DOM (wireResources only)
 * invariants: search, chips and views only hide tiles, they never re-render, so the box keeps focus while typing — client/src/ui/resources/resourceDictionary.test.ts
 *             a data-go chip in the drawer opens that entry, Back returns to the one before, Esc closes the drawer — client/src/ui/resources/resourceDictionary.test.ts
 * extend:     a new view is one grid function, one entry in VIEWS and one data-go prefix
 */

import { esc } from '../escape';
import { resourceEntries } from './resourceData';
import { takePendingResource } from './resourceFocus';
import { CATEGORY_LABEL, CATEGORY_ORDER, type ResourceCategory } from './resourceIndex';
import { CHIPS_CSS, type ResourceDeps } from './guideChips';
import { CARDS_CSS, detailHtml, entryName, previewHtml, type View } from './entryCards';
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
#game-menu .rd-chip { all: unset; cursor: pointer; padding: 3px 11px; border-radius: 999px; border: 1px solid rgba(140, 170, 220, 0.22); color: #9fb3cc; font-size: 12px; }
#game-menu .rd-chip:hover, #game-menu .rd-chip:focus-visible { color: #fff; border-color: rgba(125, 211, 252, 0.6); }
#game-menu .rd-chip.on { background: rgba(125, 211, 252, 0.15); border-color: rgba(125, 211, 252, 0.55); color: #fff; }
#game-menu .rd-chip.view { font-weight: 600; font-size: 13px; padding: 4px 14px; }
#game-menu .rd-sep { width: 1px; height: 16px; background: rgba(140, 170, 220, 0.25); margin: 0 4px; }
#game-menu .rd-count { color: #6f8099; font-size: 12px; }
#game-menu .rd-none { color: #6f8099; font-style: italic; padding: 14px 4px; }
#game-menu .rd [hidden] { display: none; }
#game-menu .rd-main { display: flex; gap: 14px; align-items: flex-start; flex-wrap: wrap; }
#game-menu .rd-panes { flex: 1 1 360px; min-width: 0; }
#game-menu .rg-drawer { flex: 0 0 330px; max-width: 100%; box-sizing: border-box; position: sticky; top: 64px; max-height: calc(100vh - 150px); overflow-y: auto; padding: 12px 14px 14px; border-radius: 12px; background: rgba(9, 15, 28, 0.98); border: 1px solid rgba(251, 191, 36, 0.4); box-shadow: 0 6px 24px rgba(0, 0, 0, 0.5); }
#game-menu .rg-drawer .dr-bar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; min-height: 18px; }
#game-menu .rg-drawer .rd-back, #game-menu .rg-drawer .dr-close { all: unset; cursor: pointer; color: #7dd3fc; font-size: 12px; padding: 2px 4px; }
#game-menu .rg-drawer .rd-back:hover, #game-menu .rg-drawer .dr-close:hover, #game-menu .rg-drawer .rd-back:focus-visible, #game-menu .rg-drawer .dr-close:focus-visible { text-decoration: underline; }
#game-menu .rg-drawer .dr-close { color: #9fb3cc; margin-left: auto; }
#game-menu .rg-preview { position: fixed; z-index: 50; width: 260px; box-sizing: border-box; pointer-events: none; padding: 10px 12px 11px; border-radius: 10px; background: rgba(9, 15, 28, 0.98); border: 1px solid rgba(125, 211, 252, 0.45); box-shadow: 0 6px 20px rgba(0, 0, 0, 0.55); }` + CHIPS_CSS + GRID_CSS + CARDS_CSS;

/** The Resources tab: search box, view tabs, category chips, the four icon grids, the preview and the details drawer (wireResources makes them work) */
export function resourcesHtml(d: ResourceDeps): string {
  lastDeps = d;
  const entries = resourceEntries();
  const cats = [['all', 'All'] as const, ...CATEGORY_ORDER.filter((c) => entries.some((e) => e.category === c)).map((c) => [c, CATEGORY_LABEL[c]] as const)];
  const grids: Record<View, string> = { res: resourceGridHtml(d), rock: rockGridHtml(d), enemy: enemyGridHtml(d), sys: systemGridHtml() };
  return `<div class="rd" data-resources>
    <div class="rd-bar"><input type="search" placeholder="Search by name, place or use (try &quot;Void Sector&quot; or &quot;lens&quot;)" value="${esc(state.q)}" aria-label="Search the guide">
      <span class="rd-count" aria-live="polite"></span>
      <div class="rd-chips" role="group" aria-label="Views">${VIEWS.map((v) => `<button class="rd-chip view${state.view === v.id ? ' on' : ''}" data-view-tab="${v.id}">${v.label}</button>`).join('')}
        <span class="rd-sep" data-res-only></span>
        ${cats.map(([id, label]) => `<button class="rd-chip${state.cat === id ? ' on' : ''}" data-rcat="${id}" data-res-only>${esc(label)}</button>`).join('')}</div></div>
    <div class="rd-main"><div class="rd-panes">${VIEWS.map((v) => `<div data-view="${v.id}"${state.view === v.id ? '' : ' hidden'}>${grids[v.id]}</div>`).join('')}
      <p class="rd-none" hidden>Nothing matches.</p></div>
      <aside class="rg-drawer" hidden aria-label="Details"></aside></div>
    <div class="rg-preview" hidden role="tooltip"></div></div>`;
}

/** Hook up search, chips, views, the preview and the drawer: they hide and show, never re-render the grids, so typing keeps its focus */
export function wireResources(root: HTMLElement, d: ResourceDeps | undefined = lastDeps): void {
  if (!d) return;
  const box = root.querySelector<HTMLElement>('[data-resources]');
  if (!box) return;
  const input = box.querySelector<HTMLInputElement>('input')!;
  const drawer = box.querySelector<HTMLElement>('.rg-drawer')!;
  const preview = box.querySelector<HTMLElement>('.rg-preview')!;
  const tilesOf = (v: View) => [...box.querySelectorAll<HTMLElement>(`[data-view="${v}"] .rg-tile`)];
  const tileOf = (v: View, id: string) => tilesOf(v).find((t) => t.dataset.id === id);
  const trail: { view: View; id: string }[] = [];
  let current: { view: View; id: string } | null = null;

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

  const mark = () => {
    for (const el of box.querySelectorAll('.rg-tile.sel')) el.classList.remove('sel');
    if (current) tileOf(current.view, current.id)?.classList.add('sel');
  };
  const drawerBar = () => {
    const prev = trail[trail.length - 1];
    return `<div class="dr-bar">${prev ? `<button class="rd-back" data-back>← Back to ${esc(entryName(prev.view, prev.id))}</button>` : ''}<button class="dr-close" data-close aria-label="Close details">✕ Close</button></div>`;
  };
  const closeDrawer = () => { current = null; trail.length = 0; drawer.hidden = true; drawer.innerHTML = ''; mark(); };
  /** Show an entry in the drawer (and its tile in the grid, clearing any search that hides it) */
  const open = (v: View, id: string) => {
    if (state.view !== v) { state.view = v; }
    const t = tileOf(v, id);
    if (t?.hidden) { state.q = ''; state.cat = 'all'; input.value = ''; }
    apply();
    current = { view: v, id };
    drawer.innerHTML = drawerBar() + detailHtml(v, id, d);
    drawer.hidden = false;
    drawer.scrollTop = 0;
    mark();
    hidePreview();
    const tile = tileOf(v, id);
    if (tile) { tile.scrollIntoView?.({ block: 'nearest' }); tile.classList.remove('rd-hl'); void tile.offsetWidth; tile.classList.add('rd-hl'); }
  };
  const go = (v: View, id: string) => {
    if (current && current.view === v && current.id === id) return;
    if (current) trail.push(current);
    open(v, id);
  };

  input.addEventListener('input', () => { state.q = input.value; apply(); });
  box.addEventListener('mouseover', (ev) => { const t = (ev.target as HTMLElement).closest<HTMLElement>('.rg-tile'); if (t) showPreview(t); });
  box.addEventListener('mouseout', (ev) => { if ((ev.target as HTMLElement).closest('.rg-tile')) hidePreview(); });
  box.addEventListener('focusin', (ev) => { const t = (ev.target as HTMLElement).closest<HTMLElement>('.rg-tile'); if (t) showPreview(t); });
  box.addEventListener('focusout', (ev) => { if ((ev.target as HTMLElement).closest('.rg-tile')) hidePreview(); });
  box.addEventListener('click', (ev) => {
    const t = (ev.target as HTMLElement).closest<HTMLElement>('[data-go],[data-rcat],[data-view-tab],[data-back],[data-close],.rg-tile');
    if (!t) return;
    if (t.classList.contains('rg-tile')) { trail.length = 0; open(t.dataset.viewOf as View, t.dataset.id!); }
    else if (t.dataset.go) {
      const at = t.dataset.go.indexOf(':');
      go(t.dataset.go.slice(0, at) as View, t.dataset.go.slice(at + 1));
    } else if (t.dataset.rcat) { state.cat = t.dataset.rcat as ResourceCategory | 'all'; apply(); }
    else if (t.dataset.viewTab) { closeDrawer(); state.view = t.dataset.viewTab as View; apply(); }
    else if (t.hasAttribute('data-back')) { const prev = trail.pop(); if (prev) open(prev.view, prev.id); }
    else if (t.hasAttribute('data-close')) closeDrawer();
  });
  // Esc closes the drawer (and the preview); it only claims the key while there is something to close
  const onKey = (ev: KeyboardEvent) => {
    if (!box.isConnected) { document.removeEventListener('keydown', onKey, true); return; }
    if (ev.key !== 'Escape' || (drawer.hidden && preview.hidden)) return;
    ev.stopPropagation();
    ev.preventDefault();
    hidePreview();
    closeDrawer();
  };
  document.addEventListener('keydown', onKey, true);
  apply();
  // (Sent here by a link elsewhere: open that resource)
  const want = takePendingResource();
  if (want && tileOf('res', want)) open('res', want);
}
