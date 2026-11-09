/**
 * @contract client.ui.resource-cards
 * owns:       the levels of detail for a guide entry (resource, rock, enemy or system): a small PREVIEW (icon, name, the short hint and the one most important source row), the EXTENDED details block and the full detail PAGE (big icon, every section, icons that open other entries), as escaped HTML
 * needs:      resourceData (entries, source index), guideChips (the chips and the icons), tiers, ../escape
 * invariants: chances and shares only ever show as tier pips and words, never a number or percentage — client/src/ui/resources/entryCards.test.ts
 *             every icon in the extended details that has an entry is a data-go button, the preview has none (it is not clickable) — client/src/ui/resources/entryCards.test.ts
 *             a system, rock, enemy and resource list each other (a rock card lists its systems, a system card its rocks) — client/src/ui/resources/entryCards.test.ts
 * extend:     a new section is one more push in the matching card function here
 */

import { esc } from '../escape';
import { levelIndex, RESOURCE_DATA, resourceEntries, sourceIndex } from './resourceData';
import { CATEGORY_LABEL, SOURCE_LABEL, type ResourceEntry } from './resourceIndex';
import { badge, chipList, enemyById, enemyChip, enemyIcon, itemChip, itemIcon, itemName, rockById, rockChip, rockIcon, systemChip, systemById, systemIcon, type ResourceDeps } from './guideChips';
import type { Tier } from './tiers';
import { isLocked, levelOf } from './levels';

export type View = 'res' | 'rock' | 'enemy' | 'sys';

export const CARDS_CSS = `
#game-menu .ec-head { display: flex; gap: 10px; align-items: center; }
#game-menu .ec-head b { display: block; color: #fff; font-size: 14px; }
#game-menu .ec-head > div > span { color: #8394ad; font-size: 11px; }
#game-menu .ec-lock { color: #f59e0b; font-size: 11.5px; margin: 5px 0 0; }
#game-menu .ec-lock.open { color: #6f8099; }
#game-menu .ec-hint { color: #fbbf24; font-size: 12px; line-height: 1.35; margin: 6px 0 2px; opacity: 0.9; }
#game-menu .ec-desc { color: #a9b6c9; font-size: 11.5px; line-height: 1.4; margin: 4px 0 2px; }
#game-menu .ec-sec { margin-top: 9px; }
#game-menu .ec-sec > h5 { margin: 0 0 4px; font: 700 9px 'Segoe UI', sans-serif; letter-spacing: 1.3px; text-transform: uppercase; color: #6f8099; }
#game-menu .ec-line { color: #c4cfde; font-size: 11.5px; line-height: 1.4; padding: 1px 0; }
#game-menu .ec-line.dim { color: #8394ad; }
#game-menu .ec-sec .gl { gap: 4px; }
#game-menu .ec-more { color: #6f8099; font-size: 10.5px; margin-top: 8px; }
#game-menu .pg-head { display: flex; gap: 16px; align-items: center; margin: 4px 0 10px; }
#game-menu .pg-head h2 { margin: 0; color: #fff; font: 700 22px 'Segoe UI', sans-serif; }
#game-menu .pg-head .pg-sub { color: #8394ad; font-size: 13px; }
#game-menu .pg-head .ec-hint { font-size: 13.5px; margin-top: 6px; max-width: 60ch; }
#game-menu .gc.huge { width: 76px; height: 76px; border-radius: 14px; }
#game-menu .gc.huge img { width: 64px; height: 64px; }
#game-menu .gc.huge i { width: 22px; height: 22px; }
#game-menu .gc.huge i.sun { width: 38px; height: 38px; box-shadow: 0 0 18px 4px rgba(255, 220, 140, 0.35); }
#game-menu .pg-desc { font-size: 13px; max-width: 70ch; margin: 0 0 6px; }
#game-menu .pg-secs { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; margin-top: 12px; }
#game-menu .pg-sec { padding: 10px 12px 12px; border-radius: 10px; background: rgba(4, 8, 16, 0.45); border: 1px solid rgba(140, 170, 220, 0.12); }
#game-menu .pg-sec > h3 { margin: 0 0 8px; font: 700 10px 'Segoe UI', sans-serif; letter-spacing: 1.4px; text-transform: uppercase; color: #8394ad; }
#game-menu .pg-sec .gl { gap: 6px; }
#game-menu .pg-sec .gc { width: 38px; height: 38px; }
#game-menu .pg-sec .gc img { width: 30px; height: 30px; }
#game-menu .pg-sec .gc.txt { width: auto; height: 32px; font-size: 12.5px; }
#game-menu .pg-sec .gc.more, #game-menu .pg-sec .gc.badge { font-size: 13px; }
#game-menu .pg-sec .ec-line { font-size: 12.5px; }`;

const ORDER: Record<Tier, number> = { high: 0, medium: 1, low: 2 };
const byTier = <T extends { tier: Tier }>(a: T[]) => [...a].sort((x, y) => ORDER[x.tier] - ORDER[y.tier]);
const sec = (label: string, body: string) => `<div class="ec-sec"><h5>${esc(label)}</h5>${body}</div>`;
const lines = (a: string[], cls = '') => a.map((t) => `<div class="ec-line ${cls}">${t}</div>`).join('');

/** Everything a card needs about one entry, whichever kind it is */
interface Card { icon: string; name: string; sub: string; hint: string; desc: string; sections: { label: string; html: string }[] }

const MAX = 40;
const OTHER = new Set(['seam', 'trace', 'cut', 'salvage', 'quest']);
const L = (x: string[]) => chipList(x, () => '', MAX);

function resCard(e: ResourceEntry, d: ResourceDeps, plain: boolean): Card {
  const c = e.cols;
  const recipe = c.madeFrom.map((r) => {
    const machine = r.kind === 'refine' ? badge('⚗', 'Refinery', r.out) : badge('⚙', 'Fabricator', r.out);
    return `<span class="gl recipe">${r.inputs.map((i) => itemChip(d, i.item, { n: i.n, plain })).join('')}<span class="arrow">→</span>${machine}</span>`;
  }).join('<br>');
  const sections: Card['sections'] = [];
  if (c.mined.length) sections.push({ label: 'Mined from', html: L(byTier(c.mined).map((m) => rockChip(d, m.rock, m.tier, false, plain))) });
  if (c.dropped.length) sections.push({ label: 'Dropped by', html: L(byTier(c.dropped).map((m) => enemyChip(d, m.enemy, m.tier, false, plain))) });
  if (c.madeFrom.length) sections.push({ label: 'Made from', html: recipe });
  if (c.soldAt.length) sections.push({ label: 'Sold at', html: lines(c.soldAt.map((s) => `${s.kind === 'station' ? '⌂' : '★'} ${esc(s.label)} <span style="color:#6f8099">${esc(s.where)}</span>`)) });
  if (c.rewards.length) sections.push({ label: 'Rewards', html: lines(c.rewards.map((r) => `✔ ${esc(r.job)}${r.n > 1 ? ` ×${r.n}` : ''}`)) });
  const notes = e.usedFor.filter((u) => !/%/.test(u));
  const other = e.sources.filter((s) => OTHER.has(s.kind));
  return {
    icon: itemIcon(d, e.id), name: e.name, sub: CATEGORY_LABEL[e.category], hint: e.hint ?? '', desc: e.description,
    sections: [
      ...sections,
      ...(c.systems.length ? [{ label: 'Found in systems', html: L(c.systems.map((s) => systemChip(s.id, plain))) }] : []),
      ...(c.usedIn.length ? [{ label: 'Used for', html: L(c.usedIn.map((id) => itemChip(d, id, { label: `Goes into ${itemName(id)}`, plain }))) }] : []),
      ...(other.length ? [{ label: 'Also', html: lines(other.map((s) => `${esc(SOURCE_LABEL[s.kind])}: ${esc(s.text)}`), 'dim') }] : []),
      ...(notes.length ? [{ label: 'Details', html: lines(notes.map(esc), 'dim') }] : []),
      ...(e.notObtainable ? [{ label: 'Source', html: lines(['No way to get this yet'], 'dim') }] : []),
    ],
  };
}

function rockCard(id: string, d: ResourceDeps, plain: boolean): Card | undefined {
  const r = rockById(id);
  if (!r) return undefined;
  return {
    icon: rockIcon(d, id), name: r.name, sub: `${r.gas ? 'Gas pocket' : 'Rock'}${r.hardness > 1 ? `, hardness ${r.hardness}` : ''}`, hint: '', desc: '',
    sections: [
      { label: 'Yields', html: L(r.yields.map((y) => itemChip(d, y.item, { tier: y.tier, plain }))) },
      { label: 'Found in systems', html: L(r.systems.map((s) => systemChip(s.id, plain))) },
    ],
  };
}

function enemyCard(id: string, d: ResourceDeps, plain: boolean): Card | undefined {
  const e = enemyById(id);
  if (!e) return undefined;
  const sys = e.systemIds.length ? L(e.systemIds.map((s) => systemChip(s, plain))) : lines(['No public system'], 'dim');
  return {
    icon: enemyIcon(d, id), name: e.name, sub: e.kind === 'boss' ? `Boss${e.faction ? `, ${e.faction}` : ''}` : 'Any ship of the faction', hint: '', desc: '',
    sections: [
      { label: 'Drops', html: L(e.drops.map((x) => itemChip(d, x.item, { tier: x.tier, plain }))) },
      { label: 'Found in systems', html: sys },
    ],
  };
}

function sysCard(id: string, d: ResourceDeps, plain: boolean): Card | undefined {
  const s = systemById(id);
  if (!s) return undefined;
  const none = lines(['None'], 'dim');
  const gateName = RESOURCE_DATA.quests.restricted?.[id]?.name;
  return {
    icon: systemIcon(id), name: s.name, sub: `Danger ${s.danger}${gateName ? ` · needs ${gateName}` : ''}`, hint: '', desc: '',
    sections: [
      { label: 'Asteroids', html: s.rocks.length ? L(s.rocks.map((r) => rockChip(d, r.rock, r.tier, false, plain))) : none },
      { label: 'Resources here', html: s.items.length ? L(s.items.map((x) => itemChip(d, x.item, { tier: x.tier, plain }))) : none },
      { label: 'Enemies', html: s.enemies.length ? L(s.enemies.map((e) => enemyChip(d, e, undefined, false, plain))) : none },
    ],
  };
}

function cardOf(view: View, id: string, d: ResourceDeps, plain: boolean): Card | undefined {
  if (view === 'res') { const e = resourceEntries().find((x) => x.id === id); return e && resCard(e, d, plain); }
  if (view === 'rock') return rockCard(id, d, plain);
  if (view === 'enemy') return enemyCard(id, d, plain);
  return sysCard(id, d, plain);
}

/** "Unlocks at level N" when the pilot is below it, a quiet "Opens at level N" when they are past it, nothing for no gate */
export function levelNote(view: View, id: string, d: ResourceDeps): string {
  const lv = levelOf(levelIndex(), view, id);
  if (lv === undefined) return '';
  return isLocked(lv, d.level?.()) ? `<div class="ec-lock">🔒 Unlocks at level ${lv}</div>` : `<div class="ec-lock open">Opens at level ${lv}</div>`;
}

const head = (c: Card, note = '') => `<div class="ec-head"><span class="gc big">${c.icon}</span><div><b>${esc(c.name)}</b><span>${esc(c.sub)}</span>${note}</div></div>`;

/** The small card on mouseover: name, icon, the short hint and the first source row (a system shows its asteroids and enemies) */
export function previewHtml(view: View, id: string, d: ResourceDeps): string {
  const c = cardOf(view, id, d, true);
  if (!c) return '';
  const rows = view === 'sys' ? c.sections.filter((s) => s.label !== 'Resources here') : c.sections.slice(0, 1);
  const short = c.hint || (view === 'res' ? c.desc : '');
  return `${head(c, levelNote(view, id, d))}${short ? `<div class="ec-hint">${esc(short)}</div>` : ''}${rows.map((s) => sec(s.label, s.html)).join('')}<div class="ec-more">Click for everything</div>`;
}

/** The extended details drawer content: every section, icons open their entries */
export function detailHtml(view: View, id: string, d: ResourceDeps): string {
  const c = cardOf(view, id, d, false);
  if (!c) return '';
  return `${head(c, levelNote(view, id, d))}${c.hint ? `<div class="ec-hint">${esc(c.hint)}</div>` : ''}${c.desc ? `<div class="ec-desc">${esc(c.desc)}</div>` : ''}${c.sections.map((s) => sec(s.label, s.html)).join('')}`;
}

/** The full detail PAGE for one entry: a big icon, name and hint, then every section laid out in a grid; icons open other pages */
export function pageHtml(view: View, id: string, d: ResourceDeps): string {
  const c = cardOf(view, id, d, false);
  if (!c) return '';
  return `<div class="pg-head"><span class="gc huge">${c.icon}</span><div><h2>${esc(c.name)}</h2><span class="pg-sub">${esc(c.sub)}</span>${levelNote(view, id, d)}${c.hint ? `<div class="ec-hint">${esc(c.hint)}</div>` : ''}</div></div>${c.desc ? `<div class="ec-desc pg-desc">${esc(c.desc)}</div>` : ''}<div class="pg-secs">${c.sections.map((s) => `<section class="pg-sec"><h3>${esc(s.label)}</h3>${s.html}</section>`).join('')}</div>`;
}

/** The name of an entry (the Back control says where it goes) */
export function entryName(view: View, id: string): string {
  if (view === 'res') return resourceEntries().find((x) => x.id === id)?.name ?? id;
  if (view === 'rock') return rockById(id)?.name ?? id;
  if (view === 'enemy') return enemyById(id)?.name ?? id;
  return systemById(id)?.name ?? id;
}

/** Every entry id of a view, in display order (the tests walk these) */
export function entryIds(view: View): string[] {
  const s = sourceIndex();
  return view === 'res' ? resourceEntries().map((e) => e.id) : view === 'rock' ? s.rocks.map((r) => r.id) : view === 'enemy' ? s.enemies.map((e) => e.id) : s.systems.map((x) => x.id);
}
