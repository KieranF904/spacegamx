/**
 * @contract client.ui.resource-grid
 * owns:       the four icon-grid views (Resources by category, Rocks, Enemies, Systems): one tile per entry in the most-commonly-met-first order (commonness.ts), an icon with a small name under it, a lock badge and "Lv N" on a tile the player is too low for, no rows and no hint text
 * needs:      resourceData (entries, source index, levels, commonness), levels, commonness, guideChips (the icons), entryCards (View), ../escape
 * invariants: one tile per entry, carrying data-view-of, data-id, data-cat and the search text — client/src/ui/resources/resourceDictionary.test.ts
 *             a system tile exists only for a public system — client/src/ui/resources/sourceIndex.test.ts
 *             tiles in every group run in commonness order (commonness.ts), and a tile is locked (dimmed, lock badge) exactly when its level is above the player's — client/src/ui/resources/levels.test.ts
 * extend:     a new view is one function here returning a grid and one entry in VIEWS in resourceDictionary.ts
 */

import { esc } from '../escape';
import { commonnessIndex, levelIndex, resourceEntries, sourceIndex } from './resourceData';
import { isLocked, levelOf, type LevelView } from './levels';
import { sortByCommonness } from './commonness';
import { categoryIcon } from './categoryIcons';
import { CATEGORY_LABEL, CATEGORY_ORDER } from './resourceIndex';
import { enemyIcon, itemIcon, itemName, rockIcon, systemIcon, type ResourceDeps } from './guideChips';
import type { View } from './entryCards';

export const GRID_CSS = `
#game-menu .rg-group { margin: 0 0 12px; }
#game-menu .rg-group[hidden] { display: none; }
#game-menu .rg-group > h4 { display: flex; align-items: center; gap: 6px; margin: 8px 0 6px; font: 700 10px 'Segoe UI', sans-serif; letter-spacing: 1.5px; text-transform: uppercase; color: #6f8099; }
#game-menu .rg-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(84px, 1fr)); gap: 6px; }
#game-menu .rg-tile { all: unset; box-sizing: border-box; cursor: pointer; display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 7px 3px 6px; border-radius: 9px; border: 1px solid rgba(140, 170, 220, 0.12); background: rgba(4, 8, 16, 0.45); text-align: center; }
#game-menu .rg-tile[hidden] { display: none; }
#game-menu .rg-tile:hover, #game-menu .rg-tile:focus-visible { border-color: rgba(125, 211, 252, 0.7); background: rgba(125, 211, 252, 0.1); outline: none; }
#game-menu .rg-tile.sel { border-color: rgba(251, 191, 36, 0.75); background: rgba(251, 191, 36, 0.1); }
#game-menu .rg-tile .rg-name { color: #dbe5f3; font-size: 10.5px; line-height: 1.15; max-width: 100%; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
#game-menu .rg-tile .rg-sub { color: #6f8099; font-size: 9.5px; }
#game-menu .rg-tile i.sun, #game-menu .ec-head i.sun { width: 20px; height: 20px; box-shadow: 0 0 10px 2px rgba(255, 220, 140, 0.35); }
#game-menu .rg-tile { position: relative; }
#game-menu .rg-tile .rg-lv { position: absolute; top: 2px; right: 3px; font: 700 9px 'Segoe UI', sans-serif; color: #6f8099; }
#game-menu .rg-tile.locked > .gc, #game-menu .rg-tile.locked .rg-name { opacity: 0.42; filter: grayscale(0.6); }
#game-menu .rg-tile.locked .rg-lv { color: #f59e0b; opacity: 1; }
#game-menu .rd-hl { animation: rd-flash 2.4s ease-out; }
@keyframes rd-flash { from { background: rgba(251, 191, 36, 0.4); } to { background: rgba(251, 191, 36, 0.1); } }`;

function tile(d: ResourceDeps, view: View, id: string, icon: string, name: string, q: string, cat = '', sub = ''): string {
  const lv = levelOf(levelIndex(), view as LevelView, id);
  const locked = isLocked(lv, d.level?.());
  const badge = lv === undefined ? '' : `<span class="rg-lv">${locked ? '🔒 ' : ''}Lv ${lv}</span>`;
  const label = locked ? `${name} (unlocks at level ${lv})` : name;
  return `<button type="button" class="rg-tile${locked ? ' locked' : ''}" data-view-of="${view}" data-id="${esc(id)}" data-cat="${esc(cat)}" data-q="${esc(q.toLowerCase())}"${lv === undefined ? '' : ` data-level="${lv}"`} aria-label="${esc(label)}"><span class="gc big">${icon}</span>${badge}<span class="rg-name rd-name">${esc(name)}</span>${sub ? `<span class="rg-sub">${esc(sub)}</span>` : ''}</button>`;
}
const ordered = <T extends { id: string }>(view: LevelView, items: T[], name: (t: T) => string) => sortByCommonness(commonnessIndex(), levelIndex(), view, items, name);

/** Resources, grouped by category */
export function resourceGridHtml(d: ResourceDeps): string {
  const all = resourceEntries();
  return CATEGORY_ORDER.map((c) => {
    const es = ordered('res', all.filter((e) => e.category === c), (e) => e.name);
    if (!es.length) return '';
    const hay = (e: (typeof es)[number]) => [e.name, e.id, e.description, CATEGORY_LABEL[e.category], ...e.sources.flatMap((s) => [s.text, ...(s.where ?? [])]), ...e.usedFor, e.hint ?? ''].join(' ');
    return `<section class="rg-group" data-group="${c}"><h4>${categoryIcon(c, 15)}${esc(CATEGORY_LABEL[c])}</h4><div class="rg-grid">${es.map((e) => tile(d, 'res', e.id, itemIcon(d, e.id), e.name, hay(e), e.category)).join('')}</div></section>`;
  }).join('');
}

export function rockGridHtml(d: ResourceDeps): string {
  const tiles = ordered('rock', sourceIndex().rocks, (r) => r.name).map((r) => tile(d, 'rock', r.id, rockIcon(d, r.id), r.name, [r.name, r.id, ...r.systems.map((s) => s.name), ...r.yields.map((y) => itemName(y.item))].join(' ')));
  return `<section class="rg-group"><div class="rg-grid">${tiles.join('')}</div></section>`;
}

export function enemyGridHtml(d: ResourceDeps): string {
  const tiles = ordered('enemy', sourceIndex().enemies, (e) => e.name).map((e) => tile(d, 'enemy', e.id, enemyIcon(d, e.id), e.name, [e.name, e.id, e.faction, e.kind, ...e.where, ...e.drops.map((x) => itemName(x.item))].join(' ')));
  return `<section class="rg-group"><div class="rg-grid">${tiles.join('')}</div></section>`;
}

export function systemGridHtml(d: ResourceDeps): string {
  const ix = sourceIndex();
  const rockName = (id: string) => ix.rocks.find((r) => r.id === id)?.name ?? id;
  const enemyName = (id: string) => ix.enemies.find((e) => e.id === id)?.name ?? id;
  const tiles = ordered('sys', ix.systems, (s) => s.name).map((s) => tile(d, 'sys', s.id, systemIcon(s.id), s.name, [s.name, s.sector.replace(/_/g, ' '), ...s.rocks.map((r) => rockName(r.rock)), ...s.items.map((x) => itemName(x.item)), ...s.enemies.map(enemyName)].join(' '), '', `Danger ${s.danger}`));
  return `<section class="rg-group"><div class="rg-grid">${tiles.join('')}</div></section>`;
}
