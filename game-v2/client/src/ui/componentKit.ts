/**
 * Markup bits the component guide and the hangar palette both draw (each styles them its own way, by `cls`): HTML
 * escaping, the lock / tick / chevron glyphs, and a cost as item chips (red where you're short).
 */

import type { Economy } from '@space-game/common';
import { itemIcon } from './itemIcons';
import type { CostLine } from './componentAvail';

export const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export const LOCK = `<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4 7V5a4 4 0 1 1 8 0v2h.5A1.5 1.5 0 0 1 14 8.5v5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 13.5v-5A1.5 1.5 0 0 1 3.5 7H4Zm2 0h4V5a2 2 0 1 0-4 0v2Z"/></svg>`;
export const CHECK = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8.5 6.5 12 13 4.5"/></svg>`;
export const CHEVRON = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 6 8 10.5 12.5 6"/></svg>`;

/**
 * A cost as chips: `<span class="{cls}[ short]"><img>x n</span>` each, titled with the item and how many you have.
 * `showHave` adds "/have" after the count.
 */
export function costChipsHtml(econ: Economy, lines: readonly CostLine[], cls: string, showHave = false): string {
  return lines.map((l) => `<span class="${cls}${l.short ? ' short' : ''}" title="${esc(econ.items.name(l.id))}: you have ${l.have}"><img src="${itemIcon(econ, l.id)}" alt="">x ${l.n}${showHave ? `<small>/${l.have}</small>` : ''}</span>`).join('');
}
