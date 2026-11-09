/**
 * @contract client.ui.resource-dictionary
 * owns:       the field guide's Resources tab shell: the search box, the Resources / Rocks / Enemies views, category chips, and the click-through between them with a way back
 * needs:      resourceTable, sourcePanes, guideChips (the pieces and their CSS), resourceFocus (a pending link), ../escape, DOM (wireResources only)
 * invariants: search, chips and views only hide things, they never re-render, so the box keeps focus while typing — client/src/ui/resources/resourceDictionary.test.ts
 *             a data-go chip opens that rock, enemy or resource, highlights it, and Back returns to where you were — client/src/ui/resources/resourceDictionary.test.ts
 * extend:     a new view is one pane html function, one entry in VIEWS and one data-go prefix
 */

import { esc } from '../escape';
import { resourceEntries } from './resourceData';
import { takePendingResource } from './resourceFocus';
import { CATEGORY_LABEL, CATEGORY_ORDER, type ResourceCategory } from './resourceIndex';
import { CHIPS_CSS, type ResourceDeps } from './guideChips';
import { resourceTableHtml, TABLE_CSS } from './resourceTable';
import { enemiesHtml, PANES_CSS, rocksHtml } from './sourcePanes';

export type { ResourceDeps };

type View = 'res' | 'rock' | 'enemy';
const VIEWS: { id: View; label: string; rows: string }[] = [
  { id: 'res', label: 'Resources', rows: 'tr.rd-row' },
  { id: 'rock', label: 'Rocks', rows: '.sp-row' },
  { id: 'enemy', label: 'Enemies', rows: '.sp-row' },
];

/** The last search, chip and view, kept while the guide is open (the guide re-renders on a tab switch) */
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
#game-menu .rd-back { all: unset; cursor: pointer; color: #7dd3fc; font-size: 12px; padding: 2px 4px; }
#game-menu .rd-back:hover, #game-menu .rd-back:focus-visible { text-decoration: underline; }
#game-menu .rd-none { color: #6f8099; font-style: italic; padding: 14px 4px; }
#game-menu .rd [hidden] { display: none; }` + CHIPS_CSS + TABLE_CSS + PANES_CSS;

/** The Resources tab: search box, view tabs, category chips, the three views (wireResources makes them work) */
export function resourcesHtml(d: ResourceDeps): string {
  const entries = resourceEntries();
  const cats = [['all', 'All'] as const, ...CATEGORY_ORDER.filter((c) => entries.some((e) => e.category === c)).map((c) => [c, CATEGORY_LABEL[c]] as const)];
  return `<div class="rd" data-resources>
    <div class="rd-bar"><input type="search" placeholder="Search by name, place or use (try &quot;Void Sector&quot; or &quot;lens&quot;)" value="${esc(state.q)}" aria-label="Search the guide">
      <span class="rd-count" aria-live="polite"></span>
      <div class="rd-chips" role="group" aria-label="Views">${VIEWS.map((v) => `<button class="rd-chip view${state.view === v.id ? ' on' : ''}" data-view-tab="${v.id}">${v.label}</button>`).join('')}
        <span class="rd-sep" data-res-only></span>
        ${cats.map(([id, label]) => `<button class="rd-chip${state.cat === id ? ' on' : ''}" data-rcat="${id}" data-res-only>${esc(label)}</button>`).join('')}</div>
      <div class="rd-crumb" hidden><button class="rd-back" data-back></button></div></div>
    <div data-view="res"${state.view === 'res' ? '' : ' hidden'}>${resourceTableHtml(d)}</div>
    <div data-view="rock"${state.view === 'rock' ? '' : ' hidden'}>${rocksHtml(d)}</div>
    <div data-view="enemy"${state.view === 'enemy' ? '' : ' hidden'}>${enemiesHtml(d)}</div>
    <p class="rd-none" hidden>Nothing matches.</p></div>`;
}

/** Hook up search, chips, views and the icon links: they hide and show, never re-render, so typing keeps its focus */
export function wireResources(root: HTMLElement): void {
  const box = root.querySelector<HTMLElement>('[data-resources]');
  if (!box) return;
  const input = box.querySelector<HTMLInputElement>('input')!;
  const rowsOf = (v: View) => [...box.querySelectorAll<HTMLElement>(`[data-view="${v}"] ${VIEWS.find((x) => x.id === v)!.rows}`)];
  const crumb = box.querySelector<HTMLElement>('.rd-crumb')!;
  const back = box.querySelector<HTMLElement>('[data-back]')!;
  const trail: { view: View; id: string | null }[] = [];
  let current: string | null = null;

  const apply = () => {
    const words = state.q.toLowerCase().split(/\s+/).filter(Boolean);
    const rows = rowsOf(state.view);
    let shown = 0;
    for (const r of rows) {
      const ok = (state.view !== 'res' || state.cat === 'all' || r.dataset.cat === state.cat) && words.every((w) => r.dataset.q!.includes(w));
      r.hidden = !ok;
      if (ok) shown++;
    }
    for (const v of VIEWS) box.querySelector<HTMLElement>(`[data-view="${v.id}"]`)!.hidden = v.id !== state.view;
    for (const b of box.querySelectorAll<HTMLElement>('[data-view-tab]')) b.classList.toggle('on', b.dataset.viewTab === state.view);
    for (const b of box.querySelectorAll<HTMLElement>('[data-rcat]')) { b.classList.toggle('on', b.dataset.rcat === state.cat); b.hidden = state.view !== 'res'; }
    box.querySelector<HTMLElement>('.rd-sep')!.hidden = state.view !== 'res';
    box.querySelector('.rd-count')!.textContent = `${shown} of ${rows.length}`;
    box.querySelector<HTMLElement>('p.rd-none')!.hidden = shown > 0;
  };

  const label = (v: View, id: string | null) => {
    const row = id ? rowsOf(v).find((r) => r.dataset.id === id) : undefined;
    return row?.querySelector('.rd-name')?.textContent ?? VIEWS.find((x) => x.id === v)!.label;
  };
  const showCrumb = () => {
    const prev = trail[trail.length - 1];
    crumb.hidden = !prev;
    if (prev) back.textContent = `← Back to ${label(prev.view, prev.id)}`;
  };
  /** Show a row: clear what hides it, mark it, bring it into view, and give it the keyboard */
  const reveal = (v: View, id: string | null) => {
    state.view = v;
    if (id) { state.q = ''; state.cat = 'all'; input.value = ''; }
    apply();
    for (const el of box.querySelectorAll('.rd-hl')) el.classList.remove('rd-hl');
    current = id;
    const row = id ? rowsOf(v).find((r) => r.dataset.id === id) : undefined;
    if (!row) return;
    void row.offsetWidth; // (so the flash restarts when the same row is opened twice)
    row.classList.add('rd-hl');
    row.tabIndex = -1;
    row.scrollIntoView?.({ block: 'center' });
    row.focus?.({ preventScroll: true });
  };
  const go = (v: View, id: string) => {
    if (v === state.view && id === current) return;
    trail.push({ view: state.view, id: current });
    reveal(v, id);
    showCrumb();
  };

  input.addEventListener('input', () => { state.q = input.value; apply(); });
  box.addEventListener('click', (ev) => {
    const t = (ev.target as HTMLElement).closest<HTMLElement>('[data-go],[data-rcat],[data-view-tab],[data-back]');
    if (!t) return;
    if (t.dataset.go) {
      const at = t.dataset.go.indexOf(':');
      go(t.dataset.go.slice(0, at) as View, t.dataset.go.slice(at + 1));
    } else if (t.dataset.rcat) { state.cat = t.dataset.rcat as ResourceCategory | 'all'; apply(); }
    else if (t.dataset.viewTab) { trail.length = 0; showCrumb(); state.view = t.dataset.viewTab as View; current = null; for (const el of box.querySelectorAll('.rd-hl')) el.classList.remove('rd-hl'); apply(); }
    else if (t.hasAttribute('data-back')) { const prev = trail.pop(); if (prev) reveal(prev.view, prev.id); showCrumb(); }
  });
  apply();
  // (Sent here by a link elsewhere: open that resource's row)
  const want = takePendingResource();
  if (want && rowsOf('res').some((r) => r.dataset.id === want)) { reveal('res', want); }
}
