/**
 * @contract client.ui.resource-sources-view
 * owns:       the Rocks and Enemies views: one row per rock or enemy with its picture, where it is found, and an icon chip per resource it yields or drops (a tier on each, no numbers)
 * needs:      resourceData (the source index), guideChips (the chips), ../escape
 * invariants: a row carries data-id and its search text; every yield or drop chip opens that resource — client/src/ui/resources/resourceDictionary.test.ts
 * extend:     a new source kind is one more list function here, one more pane in resourceDictionary.ts
 */

import { esc } from '../escape';
import { sourceIndex } from './resourceData';
import { chipList, enemyChip, itemChip, itemName, rockChip, type ResourceDeps } from './guideChips';

export const PANES_CSS = `
#game-menu .sp-list { display: flex; flex-direction: column; gap: 4px; }
#game-menu .sp-row { display: grid; grid-template-columns: 54px minmax(150px, 230px) minmax(120px, 1fr) minmax(220px, 2fr); gap: 12px; align-items: center; padding: 6px 10px; border-radius: 8px; background: rgba(4, 8, 16, 0.45); border: 1px solid rgba(140, 170, 220, 0.12); }
#game-menu .sp-row[hidden] { display: none; }
#game-menu .sp-name b { display: block; color: #fff; font-size: 13px; }
#game-menu .sp-name span { color: #8394ad; font-size: 11px; }
#game-menu .sp-where { color: #a9b6c9; font-size: 11px; line-height: 1.4; }
#game-menu .sp-where::before { content: attr(data-lab); display: block; font: 700 9px 'Segoe UI', sans-serif; letter-spacing: 1.2px; text-transform: uppercase; color: #6f8099; }
#game-menu .sp-row.rd-hl { background: rgba(125, 211, 252, 0.13); border-color: rgba(125, 211, 252, 0.5); }
#game-menu .sp-legend { color: #6f8099; font-size: 11px; margin: 0 0 8px; }
@media (max-width: 760px) { #game-menu .sp-row { grid-template-columns: 54px 1fr; } #game-menu .sp-row > :nth-child(n+3) { grid-column: 1 / -1; } }`;

const LEGEND = '<p class="sp-legend">The bar on an icon is how much: one low, two medium, three high. Click any icon to open it.</p>';

function row(id: string, q: string, pic: string, name: string, sub: string, where: string, chips: string): string {
  return `<div class="sp-row" data-id="${esc(id)}" data-q="${esc(q.toLowerCase())}">${pic}
    <div class="sp-name"><b class="rd-name">${esc(name)}</b><span>${esc(sub)}</span></div>
    <div class="sp-where" data-lab="Found in">${esc(where)}</div>${chips}</div>`;
}

export function rocksHtml(d: ResourceDeps): string {
  const rows = sourceIndex().rocks.map((r) => {
    const where = r.systems.map((s) => s.name).join(' · ');
    const sub = `${r.gas ? 'Gas pocket' : 'Rock'}${r.hardness > 1 ? `, hardness ${r.hardness}` : ''}`;
    const q = [r.name, r.id, sub, ...r.systems.map((s) => s.name), ...r.yields.map((y) => itemName(y.item))].join(' ');
    return row(r.id, q, rockChip(d, r.id, undefined, true, true), r.name, sub, `${where}`, chipList(r.yields.map((y) => itemChip(d, y.item, { tier: y.tier })), (from) => `More: ${r.yields.slice(from).map((y) => itemName(y.item)).join(', ')}`, 10));
  });
  return `<div class="sp-list" data-pane="rock">${LEGEND}${rows.join('')}</div>`;
}

export function enemiesHtml(d: ResourceDeps): string {
  const rows = sourceIndex().enemies.map((e) => {
    const sub = e.kind === 'boss' ? `Boss${e.faction ? `, ${e.faction}` : ''}` : 'Any ship of the faction';
    const q = [e.name, e.id, sub, ...e.where, ...e.drops.map((x) => itemName(x.item))].join(' ');
    return row(e.id, q, enemyChip(d, e.id, undefined, true, true), e.name, sub, e.where.join(', '), chipList(e.drops.map((x) => itemChip(d, x.item, { tier: x.tier })), (from) => `More: ${e.drops.slice(from).map((x) => itemName(x.item)).join(', ')}`, 10));
  });
  return `<div class="sp-list" data-pane="enemy">${LEGEND}${rows.join('')}</div>`;
}
