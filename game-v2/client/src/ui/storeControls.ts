/**
 * The hold's quick storage controls (at a station), shared by the station
 * screen and the Cargo & Storage window: store ore and materials, store loot,
 * store everything but ammunition, utility and job items (the safe one),
 * store everything (asks twice), and restock the ship's ammunition loadout.
 * Each is one request; the server sorts the hold (common econ/loadout.ts
 * holdClass) and moves what it sweeps.
 */

import { holdClass, sweeps, type ClientMessage, type HoldClass, type StoreSweep } from '@space-game/common';
import type { PilotState } from '../econ/clientEcon';

/** What a stack in your hold is, as the storage controls see it */
export function holdClassOf(pilot: PilotState, id: string): HoldClass {
  return holdClass(id, pilot.econ.items.get(id), { loadout: pilot.profile?.loadout, quickbar: pilot.profile?.quickbar });
}

/** Items in the hold a control would move */
function count(pilot: PilotState, mode: StoreSweep): number {
  return pilot.cargo.reduce((t, s) => t + (sweeps(mode, holdClassOf(pilot, s.id)) ? s.n : 0), 0);
}

/** Crates the loadout wants that storage could top up */
function restockable(pilot: PilotState): number {
  let n = 0;
  for (const [id, want] of Object.entries(pilot.profile?.loadout ?? {})) {
    const short = want - (pilot.cargo.find((s) => s.id === id)?.n ?? 0);
    if (short > 0) n += Math.min(short, pilot.storage.find((s) => s.id === id)?.n ?? 0);
  }
  return n;
}

const LABELS: Record<StoreSweep, [string, string]> = {
  safe: ['Store all but ammo & utility', 'Everything except ammunition, your loadout, repair kits and other consumables, quick bar items and job items'],
  ores: ['Store ore & materials', 'Raw ore, gems, volatiles and refined plate and wire'],
  loot: ['Store loot', 'Components, artefacts, cut gems and modules'],
  all: ['Store everything', 'The whole hold, ammunition and utility too (click twice)'],
};

/** The controls as a row of buttons, for the hold as it is now (draw again when it changes) */
export function storeControls(pilot: PilotState, send: (m: ClientMessage) => void, sound: (id: string) => void): HTMLElement {
  const row = document.createElement('div');
  row.className = 'sgw-store';
  row.style.cssText = 'display:flex; gap:6px; flex-wrap:wrap; align-items:center;';
  for (const mode of ['safe', 'ores', 'loot', 'all'] as StoreSweep[]) {
    const n = count(pilot, mode);
    const b = document.createElement('button');
    b.className = `sgw-btn${mode === 'safe' ? ' primary' : ''}`;
    b.style.padding = '5px 10px';
    const [label, tip] = LABELS[mode];
    b.textContent = n ? `${label} (${n.toLocaleString()})` : label;
    b.title = tip;
    b.disabled = !pilot.atStation || n === 0;
    let armed = 0;
    b.onclick = () => {
      // Everything asks twice: it takes the ammunition and repair kits too
      if (mode === 'all' && Date.now() - armed > 3000) {
        armed = Date.now();
        b.textContent = 'Click again: everything';
        return;
      }
      send({ type: 'itemStore', what: mode });
      sound('ui_click');
    };
    row.appendChild(b);
  }
  const k = restockable(pilot);
  const re = document.createElement('button');
  re.className = 'sgw-btn';
  re.style.padding = '5px 10px';
  re.textContent = k ? `Restock loadout (${k})` : 'Restock loadout';
  re.title = 'Load the crates your ship\'s ammunition loadout asks for from storage (set it in the hangar). Docking and launching do this too';
  re.disabled = !pilot.atStation;
  re.onclick = () => { send({ type: 'restockLoadout' }); sound('ui_click'); };
  row.appendChild(re);
  return row;
}

/** A hold stack's corner tag: LOAD for the loadout's crates, UTIL for utility (both stay aboard) */
export function holdTag(pilot: PilotState, id: string): { text: string; cls: string; tip: string } | undefined {
  const c = holdClassOf(pilot, id);
  if (c === 'loadout') return { text: 'LOAD', cls: 'load', tip: 'Your ship\'s ammunition loadout: stays aboard, opened first' };
  if (c === 'utility') return { text: 'UTIL', cls: 'util', tip: 'Utility: stays aboard when you store' };
  return undefined;
}
