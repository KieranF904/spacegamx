/**
 * An item's own actions in a right-click menu: use it, scrap a module (at a station), open an ammo crate first, put it
 * on the quick bar or take it off. Shared by the Cargo & Storage window and the HUD's cargo panel (which took over the
 * in-flight hold view when I became the Ship window's key).
 */
import type { ClientMessage } from '@space-game/common';
import type { PilotState } from '../econ/clientEcon';

export function itemUseActions(pilot: PilotState, send: (m: ClientMessage) => void, id: string): { label: string; run: () => void }[] {
  const d = pilot.econ.items.get(id);
  const out: { label: string; run: () => void }[] = [];
  if (d?.category === 'consumable' && (d.repair || id === 'boost_cell' || id === 'scanner_charge')) out.push({ label: 'Use', run: () => send({ type: 'itemUse', id }) });
  // Modules break down to salvage: most of their ore back, their components in full
  if (d?.category === 'part' && pilot.atStation) {
    const have = (pilot.cargo.find((x) => x.id === id)?.n ?? 0) + (pilot.storage.find((x) => x.id === id)?.n ?? 0);
    out.push({ label: 'Scrap one (salvage)', run: () => send({ type: 'scrapItem', id, n: 1 }) });
    if (have > 1) out.push({ label: `Scrap all ${have} (salvage)`, run: () => send({ type: 'scrapItem', id, n: have }) });
  }
  if (d?.ammoFor) {
    const first = pilot.profile?.ammoPrefer?.[d.ammoFor.weapon] === id;
    if (!first) out.push({ label: `Open first (this ship's ${d.ammoFor.weapon})`, run: () => send({ type: 'ammoPrefer', item: id }) });
  }
  if (d?.category === 'consumable') {
    const bar = pilot.profile?.quickbar ?? [];
    const free = bar.findIndex((q) => !q);
    const at = bar.indexOf(id);
    if (at >= 0) out.push({ label: `Remove from quick bar (${at + 1})`, run: () => send({ type: 'quickbarSet', slot: at, id: null }) });
    else out.push({ label: `Put on quick bar (${(free >= 0 ? free : 4) + 1})`, run: () => send({ type: 'quickbarSet', slot: free >= 0 ? free : 4, id }) });
  }
  return out;
}
