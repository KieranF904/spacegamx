/**
 * Material packs at the station (docs/design/field-fabrication.md, 2.3): the list of packs you can make, what each holds
 * and what it is for. A pack is an ordinary `craft` recipe (20 s at a station, into storage), so making one is the same
 * message as any other item. The contents come from the item's own `pack` field and the recipe, never from a copy here.
 */

import { canCraft, countOf, FIELD, type ClientMessage, type Economy, type Stack } from '@space-game/common';
import { esc } from '../escape';


export interface PackRow {
  /** The pack's item id, which is also its craft recipe's id */
  id: string;
  name: string;
  /** What it holds: one unit of each of these in the field, all of them in the bank */
  contents: Record<string, number>;
  /** What making one takes */
  inputs: Record<string, number>;
  seconds: number;
  /** You can make it (learned, level) */
  open: boolean;
  /** Storage holds the inputs for one */
  afford: boolean;
  /** Needs this level (when locked by level) */
  level?: number;
}

/** Every pack that has a craft recipe, in recipe order */
export function packRows(econ: Economy, learned: string[], level: number, storage: Stack[]): PackRow[] {
  const out: PackRow[] = [];
  for (const r of econ.recipes.craft.values()) {
    const id = Object.keys(r.out)[0];
    const def = econ.items.get(id);
    if (!def?.pack) continue;
    out.push({
      id, name: econ.items.name(id), contents: { ...def.pack }, inputs: { ...r.inputs }, seconds: r.time,
      open: canCraft(r, learned, level), afford: Object.entries(r.inputs).every(([i, n]) => countOf(storage, i) >= n), level: r.level,
    });
  }
  return out;
}

/** The note under the list: how a pack pays, with its numbers from the rules */
export const PACK_NOTE = `In the field a pack gives 1 unit of one of its materials, and that work goes ${Math.round(FIELD.packSpeed * 100)}% faster. In your repair bank it gives everything in it.`;

const units = (econ: Economy, icon: (id: string) => string, bag: Record<string, number>) =>
  Object.entries(bag).map(([id, n]) => `<span class="sgw-cost" title="${esc(econ.items.name(id))}"><img src="${icon(id)}">${n}</span>`).join('');

export function packsHtml(econ: Economy, icon: (id: string) => string, rows: readonly PackRow[]): string {
  if (!rows.length) return '';
  return `<h4 style="margin-top:14px">Material packs <span class="r">made from your storage, ${rows[0].seconds} s each</span></h4>
    <p class="bank-note">${PACK_NOTE}</p>
    ${rows.map((p) => `<div class="bank-row" data-pack="${esc(p.id)}">
      <img src="${icon(p.id)}" alt=""><span class="nm"><b>${esc(p.name)}</b><br><small style="color:#8394ad">Holds ${units(econ, icon, p.contents)}</small></span>
      <span style="font-size:11px; color:#8394ad">${units(econ, icon, p.inputs)}</span>
      ${p.open ? `<button class="sgw-btn${p.afford ? ' primary' : ' off'}" data-make="1" title="${p.afford ? 'Into storage in a few seconds' : 'Short of materials in storage'}">Make</button>`
        : `<span style="color:#fca5a5; font-size:11px">${p.level !== undefined ? `Level ${p.level}` : 'Not learned'}</span>`}
    </div>`).join('')}`;
}

/** Make a pack when its Make button is clicked (event delegation on the tab) */
export function wirePacks(root: HTMLElement, send: (m: ClientMessage) => void, sound: (id: string, volume?: number) => void): void {
  root.addEventListener('click', (e) => {
    const make = (e.target as HTMLElement).closest<HTMLElement>('[data-make]');
    const id = make?.closest<HTMLElement>('[data-pack]')?.dataset.pack;
    if (!id) return;
    send({ type: 'craft', recipe: id, n: 1 });
    sound('ui_click', 0.5);
  });
}
