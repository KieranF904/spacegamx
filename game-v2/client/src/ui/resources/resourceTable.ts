/**
 * @contract client.ui.resource-table
 * owns:       the Resources view: one table row per resource, an icon chip per source in its Mined, Dropped by, Made from, Sold at, Rewards and Used for columns
 * needs:      resourceData (entries), guideChips (the chips), ../escape
 * invariants: one row per entry, carrying data-id, data-cat and the search text — client/src/ui/resources/resourceDictionary.test.ts
 *             an empty column shows a dash, not blank — client/src/ui/resources/resourceDictionary.test.ts
 * extend:     a new column is one cell function here and one header in COLUMNS
 */

import { esc } from '../escape';
import { resourceEntries } from './resourceData';
import { CATEGORY_LABEL, type ResourceEntry } from './resourceIndex';
import { badge, chipList, enemyChip, itemChip, itemName, rockChip, type ResourceDeps } from './guideChips';
import type { Tier } from './tiers';

export const TABLE_CSS = `
#game-menu .rt-wrap { overflow-x: auto; }
#game-menu table.rt { width: 100%; border-collapse: collapse; font-size: 12px; }
#game-menu table.rt th { text-align: left; font: 700 10px 'Segoe UI', sans-serif; letter-spacing: 1.5px; text-transform: uppercase; color: #6f8099; padding: 6px 8px; border-bottom: 1px solid rgba(140, 170, 220, 0.18); white-space: nowrap; }
#game-menu table.rt td { padding: 6px 8px; border-bottom: 1px solid rgba(140, 170, 220, 0.08); vertical-align: middle; }
#game-menu table.rt tr.rd-row[hidden] { display: none; }
#game-menu table.rt td:nth-child(2) { min-width: 215px; }
#game-menu table.rt td:nth-child(3) { min-width: 120px; }
#game-menu table.rt td.rt-name { min-width: 170px; max-width: 230px; }
#game-menu .rt-id { display: flex; align-items: center; gap: 8px; }
#game-menu .rt-id b { color: #fff; font-size: 13px; }
#game-menu .rt-hint { color: #fbbf24; font-size: 11px; line-height: 1.25; margin-top: 2px; max-width: 200px; opacity: 0.85; }
#game-menu .rd-hl { animation: rd-flash 2.4s ease-out; background: rgba(125, 211, 252, 0.13); }
@keyframes rd-flash { from { background: rgba(251, 191, 36, 0.4); } to { background: rgba(125, 211, 252, 0.13); } }`;

const TIER_ORDER: Record<Tier, number> = { high: 0, medium: 1, low: 2 };

type Cell = (e: ResourceEntry, d: ResourceDeps) => string;

const mined: Cell = (e, d) => chipList([...e.cols.mined].sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier]).map((m) => rockChip(d, m.rock, m.tier)), () => 'More rocks: open the Rocks list');
const dropped: Cell = (e, d) => chipList([...e.cols.dropped].sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier]).map((m) => enemyChip(d, m.enemy, m.tier)), () => 'More enemies: open the Enemies list', 5);
const madeFrom: Cell = (e, d) => e.cols.madeFrom.length === 0 ? chipList([], () => '') : e.cols.madeFrom.slice(0, 2).map((r) => {
  const machine = r.kind === 'refine' ? badge('⚗', 'Refinery', r.out) : badge('⚙', 'Fabricator', r.out);
  return `<span class="gl recipe">${r.inputs.map((i) => itemChip(d, i.item, { n: i.n })).join('')}<span class="arrow">→</span>${machine}</span>`;
}).join('');
const soldAt: Cell = (e) => chipList(e.cols.soldAt.map((s) => s.kind === 'station' ? badge('⌂', `${s.label} (${s.where})`) : badge('★', `${s.label}, ${s.where}`)), (from) => `More: ${e.cols.soldAt.slice(from).map((s) => s.label).join(', ')}`, 4);
const rewards: Cell = (e) => chipList(e.cols.rewards.map((r) => badge('✔', `Job reward: ${r.job}`, r.n)), (from) => `More jobs: ${e.cols.rewards.slice(from).map((r) => r.job).join(', ')}`, 3);
/** The sources with no chip of their own (gem seams, refining traces, cutting, salvage): a badge whose tooltip says it */
const OTHER_GLYPH: Record<string, string> = { seam: '◆', trace: '✧', cut: '◇', salvage: '⚑' };
const other: Cell = (e) => chipList(e.sources.filter((s) => OTHER_GLYPH[s.kind]).map((s) => badge(OTHER_GLYPH[s.kind], s.text)), () => '', 3);
const usedIn: Cell = (e, d) => chipList(e.cols.usedIn.map((id) => itemChip(d, id, { label: `Goes into ${itemName(id)}` })), (from) => `More: ${e.cols.usedIn.slice(from).map(itemName).join(', ')}`, 6);

const COLUMNS: { head: string; cell: Cell }[] = [
  { head: 'Mined', cell: mined }, { head: 'Dropped by', cell: dropped }, { head: 'Made from', cell: madeFrom },
  { head: 'Sold at', cell: soldAt }, { head: 'Rewards', cell: rewards }, { head: 'Other', cell: other }, { head: 'Used for', cell: usedIn },
];

function rowHtml(e: ResourceEntry, d: ResourceDeps): string {
  const hay = [e.name, e.id, e.description, CATEGORY_LABEL[e.category], ...e.sources.flatMap((s) => [s.text, ...(s.where ?? [])]), ...e.usedFor, e.hint ?? ''].join(' ').toLowerCase();
  const none = e.notObtainable ? '<span class="rt-hint" style="color:#6f8099">No way to get this yet</span>' : '';
  return `<tr class="rd-row" data-id="${esc(e.id)}" data-cat="${e.category}" data-q="${esc(hay)}">
    <td class="rt-name"><div class="rt-id">${itemChip(d, e.id, { big: true, plain: true })}<b class="rd-name">${esc(e.name)}</b></div>${e.hint ? `<div class="rt-hint" title="${esc(e.hint)}">${esc(e.hint)}</div>` : ''}${none}</td>
    ${COLUMNS.map((c) => `<td>${c.cell(e, d)}</td>`).join('')}</tr>`;
}

/** The table of every resource (the view's search and chips hide its rows) */
export function resourceTableHtml(d: ResourceDeps): string {
  return `<div class="rt-wrap"><table class="rt"><thead><tr><th>Resource</th>${COLUMNS.map((c) => `<th>${c.head}</th>`).join('')}</tr></thead>
    <tbody>${resourceEntries().map((e) => rowHtml(e, d)).join('')}</tbody></table></div>`;
}
