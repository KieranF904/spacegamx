/**
 * @contract client.hangar.palette-subs
 * owns:       the hangar palette's filter area: a "Type" grid of icon tiles (All + each class, counts in the corner) and, for
 *             weapons, a "Needs" row of combinable icon pills (Ammo, No ammo, Fixed, Turret); its markup and its CSS
 * needs:      ships/paletteFilters (SubDef, ALL, FilterState), ./filterIcons, ui/componentKit (esc)
 * invariants: tiles keep role=radio, pills aria-pressed, and the data-sub / data-needs / data-key / data-group hooks HangarPalette's click and keys use — client/src/ships/hangar/paletteSubs.test.ts
 *             the tile grid fills the width evenly (the last tile spans any gap) — client/src/ships/hangar/paletteSubs.test.ts
 * extend:     a new toggle is one entry in NEEDS below (plus its icon in filterIcons and its handling in HangarPalette.onClick)
 */

import { esc } from '../../ui/componentKit';
import { ALL, type FilterState, type SubDef } from '../paletteFilters';
import { filterIcon } from './filterIcons';

export const SUBS_STYLE = `
.hp-subs { flex-shrink: 0; display: flex; flex-direction: column; gap: 4px; }
.hp-subs[hidden] { display: none; }
.hp-sublabel { font: 700 8.5px/1 'Segoe UI', sans-serif; letter-spacing: 1.2px; text-transform: uppercase; color: #6b7a93; margin: 1px 0 0 1px; }
.hp-tiles { display: grid; gap: 3px; }
.hp-tile { all: unset; box-sizing: border-box; cursor: pointer; position: relative; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;
  min-width: 0; padding: 5px 2px 4px; border-radius: 6px; background: #0f1626; border: 1px solid #2a3a5a; color: #8c9bb3; }
.hp-tile .l { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 600 9px/11px 'Segoe UI', sans-serif; }
.hp-tile .c { position: absolute; top: 2px; right: 4px; font-size: 8px; line-height: 9px; color: #5d6c86; }
.hp-tile:hover { border-color: #46608c; color: #e5ecf7; background: #131d33; }
.hp-tile[aria-checked="true"] { background: #24406b; border-color: #5fd4c4; color: #fff; }
.hp-tile[aria-checked="true"] .c { color: #b6c8e4; }
.hp-tile .hp-ic { width: 17px; height: 17px; }
.hp-needs { display: flex; flex-wrap: wrap; gap: 3px; padding-top: 4px; border-top: 1px dashed rgba(140, 170, 220, 0.2); }
.hp-needs .hp-sublabel { flex-basis: 100%; }
.hp-pill { all: unset; box-sizing: border-box; cursor: pointer; flex: 1 1 0; min-width: 0; display: inline-flex; align-items: center; justify-content: center; gap: 4px; padding: 2px 6px;
  border-radius: 4px; font: 600 9.5px/14px 'Segoe UI', sans-serif; white-space: nowrap; background: transparent; border: 1px solid #2a3a5a; color: #8c9bb3; }
.hp-pill .hp-ic { width: 12px; height: 12px; flex-shrink: 0; }
.hp-pill:hover { border-color: #46608c; color: #e5ecf7; }
.hp-pill[aria-pressed="true"] { background: rgba(95, 212, 196, 0.16); border-color: #5fd4c4; color: #fff; }
`;

const NEEDS: { k: string; label: string; hint: string; on: (st: FilterState) => boolean }[] = [
  { k: 'ammo', label: 'Ammo', hint: 'Only guns that fire ammunition items', on: (st) => st.ammo === 'ammo' },
  { k: 'none', label: 'No ammo', hint: 'Only guns that run on power alone', on: (st) => st.ammo === 'none' },
  { k: 'fixed', label: 'Fixed', hint: 'Only guns that fire where the ship points', on: (st) => st.mount === 'fixed' },
  { k: 'turret', label: 'Turret', hint: 'Only guns that swivel to the cursor', on: (st) => st.mount === 'turret' },
];

/** Grid columns for `n` tiles: one row up to five, else two rows */
export function tileColumns(n: number): number { return n <= 5 ? n : Math.ceil(n / 2); }

/** How many columns the last of `n` tiles spans so the final row has no gap */
export function lastSpan(n: number): number {
  const c = tileColumns(n);
  return n % c === 0 ? 1 : c - (n % c) + 1;
}

/** The filter area's markup: `subs` already holds only the classes worth showing; empty string when there is nothing to show */
export function subsHtml(tab: string, subs: readonly SubDef[], counts: ReadonlyMap<string, number>, cur: string, st: FilterState): string {
  const key = (k: string) => `data-key="sub:${k}"`;
  let html = '';
  if (subs.length > 1) {
    const tile = (id: string, label: string, n: number, hint: string | undefined, span: number) =>
      `<button class="hp-tile" role="radio" data-sub="${id}" ${key(id)} aria-checked="${cur === id}" tabindex="${cur === id ? 0 : -1}"`
      + `${hint ? ` title="${esc(hint)}"` : ''}${span > 1 ? ` style="grid-column: span ${span}"` : ''}>${filterIcon(id)}<span class="l">${esc(label)}</span><span class="c">${n}</span></button>`;
    const all = [{ id: ALL, label: 'All', hint: undefined as string | undefined }, ...subs];
    html += `<span class="hp-sublabel">Type</span><div class="hp-tiles" role="radiogroup" aria-label="Group" data-group="sub" style="grid-template-columns: repeat(${tileColumns(all.length)}, minmax(0, 1fr))">`
      + all.map((s, i) => tile(s.id, s.label, counts.get(s.id) ?? 0, s.hint, i === all.length - 1 ? lastSpan(all.length) : 1)).join('')
      + `</div>`;
  }
  if (tab === 'weapons') {
    html += `<div class="hp-needs" data-group="needs" role="group" aria-label="Needs"><span class="hp-sublabel">Needs</span>`
      + NEEDS.map((n) => `<button class="hp-pill" data-needs="${n.k}" ${key(n.k)} aria-pressed="${n.on(st)}" title="${esc(n.hint)}">${filterIcon(n.k, 12)}${esc(n.label)}</button>`).join('')
      + `</div>`;
  }
  return html;
}
