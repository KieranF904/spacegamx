/**
 * @contract client.ui.resource-chips
 * owns:       the guide's icon chips (item, rock, enemy, system; tier pips; "+n" overflow) as escaped HTML, and the CSS they share
 * needs:      ../escape, resourceData (names, colours), sourceIndex, tiers, thumbnails; ResourceDeps from the host
 * invariants: a chip that opens an entry is a real button carrying data-go="res|rock|enemy|sys:<id>" with an aria-label, so it works by keyboard — client/src/ui/resources/resourceDictionary.test.ts
 *             a chip shows a tier by pips and a word in its tooltip, never a number — client/src/ui/resources/resourceDictionary.test.ts
 * extend:     a new chip kind is one function here that returns chipHtml(...)
 */

import { esc } from '../escape';
import { RESOURCE_DATA, resourceEntries, sourceIndex } from './resourceData';
import { TIER_LABEL, TIER_PIPS, type Tier } from './tiers';
import { enemyThumb, rockThumb } from './thumbnails';
import type { EnemyEntry, RockEntry, SystemEntry } from './sourceIndex';

/** What the guide needs from the game */
export interface ResourceDeps {
  /** An item's icon (a data URL; '' if there's none) */
  icon(id: string): string;
  /** A ship design's silhouette (a data URL), for enemy thumbnails; absent in tests */
  shipIcon?(parts: { piece: string; rot: number; flip: boolean; x: number; y: number }[], size?: number): string;
}

const ITEM = new Map(RESOURCE_DATA.items.map((i) => [i.id, i]));
let entryIds: Set<string> | undefined;
const hasEntry = (id: string) => (entryIds ??= new Set(resourceEntries().map((e) => e.id))).has(id);
const ROCKS = () => new Map(sourceIndex().rocks.map((r) => [r.id, r]));
const ENEMIES = () => new Map(sourceIndex().enemies.map((e) => [e.id, e]));
let rockMap: Map<string, RockEntry> | undefined, enemyMap: Map<string, EnemyEntry> | undefined;
export const rockById = (id: string) => (rockMap ??= ROCKS()).get(id);
export const enemyById = (id: string) => (enemyMap ??= ENEMIES()).get(id);
let sysMap: Map<string, SystemEntry> | undefined;
export const systemById = (id: string) => (sysMap ??= new Map(sourceIndex().systems.map((s) => [s.id, s]))).get(id);
export const itemName = (id: string) => ITEM.get(id)?.name ?? id.replace(/_/g, ' ');

export const CHIPS_CSS = `
#game-menu .gc { all: unset; box-sizing: border-box; position: relative; display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; border-radius: 7px; background: rgba(4, 8, 16, 0.55); border: 1px solid rgba(140, 170, 220, 0.18); flex: none; }
#game-menu button.gc { cursor: pointer; }
#game-menu button.gc:hover, #game-menu button.gc:focus-visible { border-color: rgba(125, 211, 252, 0.8); background: rgba(125, 211, 252, 0.12); outline: none; }
#game-menu .gc img { width: 24px; height: 24px; image-rendering: auto; }
#game-menu .gc.big { width: 44px; height: 44px; border-radius: 9px; }
#game-menu .gc.big img { width: 38px; height: 38px; }
#game-menu .gc i { display: block; width: 12px; height: 12px; border-radius: 50%; }
#game-menu .gc .pips { position: absolute; left: 3px; right: 3px; bottom: 1px; display: flex; gap: 1px; height: 3px; }
#game-menu .gc .pips b { flex: 1; border-radius: 1px; background: rgba(255, 255, 255, 0.14); }
#game-menu .gc.t-low .pips b:nth-child(-n+1), #game-menu .gc.t-medium .pips b:nth-child(-n+2), #game-menu .gc.t-high .pips b { background: #7dd3fc; }
#game-menu .gc.t-low .pips b:nth-child(-n+1) { background: #7e8da6; }
#game-menu .gc.t-high .pips b { background: #fbbf24; }
#game-menu .gc .n { position: absolute; right: 1px; top: -1px; font: 700 9px 'Segoe UI', sans-serif; color: #fbbf24; text-shadow: 0 0 2px #000; }
#game-menu .gc.txt { width: auto; min-width: 30px; padding: 0 7px; font-size: 11px; color: #c4cfde; white-space: nowrap; }
#game-menu .gc.sys { gap: 5px; }
#game-menu .gc.sys span { overflow: hidden; text-overflow: ellipsis; }
#game-menu .gc i.sun { width: 10px; height: 10px; box-shadow: 0 0 6px currentColor; }
#game-menu .gc.badge { font-size: 14px; color: #9fb3cc; }
#game-menu .gc.more { color: #8394ad; font-size: 11px; }
#game-menu .gl { display: inline-flex; flex-wrap: wrap; gap: 3px; align-items: center; }
#game-menu .gl .arrow { color: #6f8099; font-size: 12px; padding: 0 2px; }
#game-menu .gl .dash { color: #3d4a5e; }
#game-menu .gl.recipe + .gl.recipe { margin-top: 3px; }`;

/** "x" in a swatch or the picture, with the shared wrapper; `go` makes it a button that opens that entry */
function chip(o: { inner: string; label: string; go?: string; tier?: Tier; n?: number; cls?: string }): string {
  const pips = o.tier ? `<span class="pips">${'<b></b>'.repeat(TIER_PIPS.high)}</span>` : '';
  const n = o.n && o.n > 1 ? `<span class="n">×${o.n}</span>` : '';
  const cls = `gc${o.tier ? ` t-${o.tier}` : ''}${o.cls ? ` ${o.cls}` : ''}`;
  const title = o.tier ? `${o.label}: ${TIER_LABEL[o.tier]}` : o.label;
  return o.go
    ? `<button type="button" class="${cls}" data-go="${esc(o.go)}" title="${esc(title)}" aria-label="${esc(title)}">${o.inner}${pips}${n}</button>`
    : `<span class="${cls}" title="${esc(title)}" role="img" aria-label="${esc(title)}">${o.inner}${pips}${n}</span>`;
}

const swatch = (color: string) => `<i style="background:${esc(color)}"></i>`;
const img = (url: string, color: string) => (url ? `<img src="${esc(url)}" alt="" loading="lazy">` : swatch(color));

/** The picture inside an icon (no wrapper, no tooltip): used by the grid tiles */
export const itemIcon = (d: ResourceDeps, id: string) => img(d.icon(id), ITEM.get(id)?.color ?? '#9aa4b2');
export const rockIcon = (d: ResourceDeps, id: string) => { const r = rockById(id); return r ? img(rockThumb(r, ITEM.get(r.main)?.color ?? '#8a8a8a'), '#8a8a8a') : ''; };
export const enemyIcon = (d: ResourceDeps, id: string) => { const e = enemyById(id); return e ? img(enemyThumb(e, d.shipIcon), e.color) : ''; };
/** A system's picture: its sun */
export const systemIcon = (id: string) => `<i class="sun" style="background:${esc(systemById(id)?.color ?? '#fbbf24')}"></i>`;

/** An item's chip; opens its row when it has one */
export function itemChip(d: ResourceDeps, id: string, o: { n?: number; tier?: Tier; label?: string; big?: boolean; plain?: boolean } = {}): string {
  return chip({ inner: img(d.icon(id), ITEM.get(id)?.color ?? '#9aa4b2'), label: o.label ?? itemName(id), go: hasEntry(id) && !o.plain ? `res:${id}` : undefined, tier: o.tier, n: o.n, cls: o.big ? 'big' : '' });
}

export function rockChip(d: ResourceDeps, id: string, tier?: Tier, big = false, plain = false): string {
  const r = rockById(id);
  if (!r) return '';
  const where = r.systems.slice(0, 4).map((s) => `${s.name} (danger ${s.danger})`).join(', ') + (r.systems.length > 4 ? ` and ${r.systems.length - 4} more` : '');
  const label = `${r.name} · ${where}`;
  return chip({ inner: img(rockThumb(r, ITEM.get(r.main)?.color ?? '#8a8a8a'), '#8a8a8a'), label: tier ? `${r.name} (${where})` : label, go: plain ? undefined : `rock:${id}`, tier, cls: big ? 'big' : '' });
}

export function enemyChip(d: ResourceDeps, id: string, tier?: Tier, big = false, plain = false): string {
  const e = enemyById(id);
  if (!e) return '';
  return chip({ inner: img(enemyThumb(e, d.shipIcon), e.color), label: `${e.name}${e.faction && e.kind === 'boss' ? ` (${e.faction})` : ''}`, go: plain ? undefined : `enemy:${id}`, tier, cls: big ? 'big' : '' });
}

/** A system as a small text chip with its sun; opens the system */
export function systemChip(id: string, plain = false): string {
  const s = systemById(id);
  if (!s) return '';
  return chip({ inner: `${systemIcon(id)}<span>${esc(s.name)}</span>`, label: `${s.name} (danger ${s.danger})`, go: plain ? undefined : `sys:${id}`, cls: 'txt sys' });
}

/** A plain badge: a glyph with a tooltip (stations, jobs, machines) */
export function badge(glyph: string, label: string, n?: number): string {
  return chip({ inner: esc(glyph), label, n, cls: 'badge' });
}

export const dash = '<span class="dash" aria-label="none">–</span>';

/** At most `max` chips, then one "+n" chip whose tooltip names the rest */
export function chipList(items: string[], rest: (from: number) => string, max = 6): string {
  if (!items.length) return `<span class="gl">${dash}</span>`;
  const shown = items.slice(0, max).join('');
  const more = items.length > max ? chip({ inner: `+${items.length - max}`, label: rest(max), cls: 'more' }) : '';
  return `<span class="gl">${shown}${more}</span>`;
}
