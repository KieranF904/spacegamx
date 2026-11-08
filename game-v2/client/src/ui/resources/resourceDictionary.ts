/**
 * @contract client.ui.resource-dictionary
 * owns:       the field guide's Resources tab: a searchable, filterable list of every resource item, rows that open to how to get it and what it is for
 * needs:      resourceData (the entries), ../escape (esc), DOM (wireResources only)
 * invariants: search and the category chips only hide rows, they never re-render, so the box keeps focus while typing — client/src/ui/resources/resourceDictionary.test.ts
 *             every row's text is escaped — client/src/ui/resources/resourceDictionary.test.ts
 * extend:     a new filter is one more data-attribute on a row (rowHtml) and one more check in apply()
 */

import { esc } from '../escape';
import { resourceEntries } from './resourceData';
import { CATEGORY_LABEL, CATEGORY_ORDER, SOURCE_LABEL, type ResourceCategory, type ResourceEntry } from './resourceIndex';

/** What the dictionary needs from the guide */
export interface ResourceDeps {
  /** An item's icon (a data URL; '' if there's none) */
  icon(id: string): string;
}

/** The last search and chip, kept while the guide is open (the guide re-renders on a tab switch) */
const state: { q: string; cat: ResourceCategory | 'all' } = { q: '', cat: 'all' };

export const RESOURCE_CSS = `
#game-menu .rd-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 10px 0 8px; position: sticky; top: -4px; z-index: 2; padding: 6px 0; background: rgba(9, 15, 28, 0.96); }
#game-menu .rd-bar input { flex: 1; min-width: 200px; padding: 7px 12px; border-radius: 8px; background: rgba(4, 8, 16, 0.7); border: 1px solid rgba(140, 170, 220, 0.3); color: #e8f0fb; font: 14px 'Segoe UI', sans-serif; user-select: text; }
#game-menu .rd-bar input:focus { outline: none; border-color: rgba(125, 211, 252, 0.7); }
#game-menu .rd-chips { display: flex; flex-wrap: wrap; gap: 5px; width: 100%; }
#game-menu .rd-chip { all: unset; cursor: pointer; padding: 3px 11px; border-radius: 999px; border: 1px solid rgba(140, 170, 220, 0.22); color: #9fb3cc; font-size: 12px; }
#game-menu .rd-chip:hover { color: #fff; border-color: rgba(125, 211, 252, 0.4); }
#game-menu .rd-chip.on { background: rgba(125, 211, 252, 0.15); border-color: rgba(125, 211, 252, 0.55); color: #fff; }
#game-menu .rd-count { color: #6f8099; font-size: 12px; }
#game-menu .rd-list { display: flex; flex-direction: column; gap: 4px; }
#game-menu .rd-row { border-radius: 8px; background: rgba(4, 8, 16, 0.45); border: 1px solid rgba(140, 170, 220, 0.12); }
#game-menu .rd-row[open] { border-color: rgba(125, 211, 252, 0.35); background: rgba(4, 8, 16, 0.65); }
#game-menu .rd-row[hidden] { display: none; }
#game-menu .rd-row summary { display: flex; align-items: center; gap: 10px; padding: 6px 10px; cursor: pointer; list-style: none; }
#game-menu .rd-row summary::-webkit-details-marker { display: none; }
#game-menu .rd-row summary:hover { background: rgba(125, 211, 252, 0.06); }
#game-menu .rd-ic { flex: none; width: 28px; height: 28px; border-radius: 6px; display: flex; align-items: center; justify-content: center; }
#game-menu .rd-ic img { width: 28px; height: 28px; }
#game-menu .rd-ic i { display: block; width: 14px; height: 14px; border-radius: 50%; }
#game-menu .rd-name { flex: none; width: 170px; color: #fff; font-weight: 600; font-size: 13px; }
#game-menu .rd-desc { flex: 1; min-width: 0; color: #a9b6c9; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#game-menu .rd-ways { flex: none; display: flex; gap: 4px; }
#game-menu .rd-way { padding: 1px 7px; border-radius: 999px; background: rgba(255, 255, 255, 0.07); color: #c4cfde; font-size: 10px; letter-spacing: 0.5px; text-transform: uppercase; white-space: nowrap; }
#game-menu .rd-body { padding: 4px 14px 12px 48px; font-size: 13px; color: #c4cfde; }
#game-menu .rd-body h4 { margin: 10px 0 4px; font: 700 10px 'Segoe UI', sans-serif; letter-spacing: 1.5px; text-transform: uppercase; color: #6f8099; }
#game-menu .rd-body ul { margin: 0; padding-left: 16px; }
#game-menu .rd-body li { padding: 2px 0; }
#game-menu .rd-body li b { color: #7dd3fc; font-weight: 600; }
#game-menu .rd-where { color: #8394ad; font-size: 12px; }
#game-menu .rd-hint { margin: 6px 0 0; padding: 6px 10px; border-left: 2px solid #fbbf24; background: rgba(251, 191, 36, 0.07); color: #e8dcc0; }
#game-menu .rd-meta { color: #6f8099; font-size: 12px; margin-top: 8px; }
#game-menu .rd-none { color: #6f8099; font-style: italic; padding: 14px 4px; }
@media (max-width: 760px) { #game-menu .rd-ways { display: none; } #game-menu .rd-name { width: 120px; } }`;

function rowHtml(e: ResourceEntry, d: ResourceDeps): string {
  const icon = d.icon(e.id);
  const ways = [...new Set(e.sources.map((s) => SOURCE_LABEL[s.kind]))];
  const hay = [e.name, e.id, e.description, CATEGORY_LABEL[e.category], ...e.sources.flatMap((s) => [s.text, ...(s.where ?? [])]), ...e.usedFor, e.hint ?? ''].join(' ').toLowerCase();
  const sources = e.notObtainable
    ? '<p class="rd-none">No way to get this yet.</p>'
    : `<ul>${e.sources.map((s) => `<li><b>${esc(SOURCE_LABEL[s.kind])}</b> ${esc(s.text)}${s.where ? `<div class="rd-where">${s.where.map(esc).join(' · ')}</div>` : ''}</li>`).join('')}</ul>`;
  return `<details class="rd-row" data-cat="${e.category}" data-q="${esc(hay)}">
    <summary><span class="rd-ic">${icon ? `<img src="${esc(icon)}" alt="">` : `<i style="background:${esc(e.color)}"></i>`}</span>
      <span class="rd-name">${esc(e.name)}</span><span class="rd-desc">${esc(e.description)}</span>
      <span class="rd-ways">${ways.map((w) => `<span class="rd-way">${esc(w)}</span>`).join('')}</span></summary>
    <div class="rd-body">
      <div>${esc(e.description)}</div>
      ${e.hint ? `<div class="rd-hint">${esc(e.hint)}</div>` : ''}
      <h4>How to get it</h4>${sources}
      ${e.usedFor.length ? `<h4>What it is for</h4><ul>${e.usedFor.map((u) => `<li>${esc(u)}</li>`).join('')}</ul>` : ''}
      <div class="rd-meta">${esc(CATEGORY_LABEL[e.category])} · ${esc(e.rarity)} · worth ${e.value} credits</div>
    </div></details>`;
}

/** The Resources tab: search box, category chips, one row a resource (wireResources makes them work) */
export function resourcesHtml(d: ResourceDeps): string {
  const entries = resourceEntries();
  const chips = [['all', 'All'] as const, ...CATEGORY_ORDER.filter((c) => entries.some((e) => e.category === c)).map((c) => [c, CATEGORY_LABEL[c]] as const)];
  return `<div class="rd" data-resources>
    <p class="muted">Every ore, material, part and crate you handle, where it comes from and what it goes into. Open a row for the full entry.</p>
    <div class="rd-bar"><input type="search" placeholder="Search by name, place or use (try &quot;Void Sector&quot; or &quot;lens&quot;)" value="${esc(state.q)}" aria-label="Search resources">
      <span class="rd-count"></span>
      <div class="rd-chips">${chips.map(([id, label]) => `<button class="rd-chip${state.cat === id ? ' on' : ''}" data-rcat="${id}">${esc(label)}</button>`).join('')}</div></div>
    <div class="rd-list">${entries.map((e) => rowHtml(e, d)).join('')}</div>
    <p class="rd-none" hidden>Nothing matches.</p></div>`;
}

/** Hook up search and chips: they hide rows and never re-render, so typing keeps its focus */
export function wireResources(root: HTMLElement): void {
  const box = root.querySelector<HTMLElement>('[data-resources]');
  if (!box) return;
  const input = box.querySelector<HTMLInputElement>('input')!;
  const rows = [...box.querySelectorAll<HTMLElement>('.rd-row')];
  const apply = () => {
    const words = state.q.toLowerCase().split(/\s+/).filter(Boolean);
    let shown = 0;
    for (const r of rows) {
      const ok = (state.cat === 'all' || r.dataset.cat === state.cat) && words.every((w) => r.dataset.q!.includes(w));
      r.hidden = !ok;
      if (ok) shown++;
    }
    box.querySelector('.rd-count')!.textContent = `${shown} of ${rows.length}`;
    box.querySelector<HTMLElement>('p.rd-none')!.hidden = shown > 0;
    for (const b of box.querySelectorAll<HTMLElement>('[data-rcat]')) b.classList.toggle('on', b.dataset.rcat === state.cat);
  };
  input.addEventListener('input', () => { state.q = input.value; apply(); });
  for (const b of box.querySelectorAll<HTMLElement>('[data-rcat]')) b.addEventListener('click', () => { state.cat = b.dataset.rcat as ResourceCategory | 'all'; apply(); });
  apply();
}
