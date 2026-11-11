/**
 * @contract client.ui.ship.tab-list
 * owns:       the Ship window's tabs in their order (SHIP_TAB_ORDER) and building them
 * needs:      each tab module in this folder; the auto-pickup lists (the Pickup tab draws them)
 * invariants: one tab per ShipTabId, in SHIP_TAB_ORDER — client/src/ui/ship/shipWindow.test.ts
 * extend:     a new tab is its module here, its id in shipTabs.ts ShipTabId and SHIP_TAB_ORDER, and a line in shipTabs()
 */
import type { AutoPickupPanel } from '../../pickup/AutoPickupPanel';
import type { ShipTab, ShipTabId } from '../shipTabs';
import { statusTab } from './statusTab';
import { powerTab } from './powerTab';
import { weaponsTab } from './weaponsTab';
import { pickupTab } from './pickupTab';
import { refinerTab } from './refinerTab';
import { fabricatorTab } from './fabricatorTab';
import { killsTab } from './killsTab';

export const SHIP_TAB_ORDER: readonly ShipTabId[] = ['status', 'power', 'weapons', 'pickup', 'refiner', 'fabricator', 'kills'];

export function shipTabs(lists: () => AutoPickupPanel): ShipTab[] {
  const all: Record<ShipTabId, ShipTab> = {
    status: statusTab(), power: powerTab(), weapons: weaponsTab(), pickup: pickupTab(lists),
    refiner: refinerTab(), fabricator: fabricatorTab(), kills: killsTab(),
  };
  return SHIP_TAB_ORDER.map((id) => all[id]);
}
