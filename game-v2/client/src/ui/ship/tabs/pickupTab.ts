/**
 * The Ship window's Pickup tab: the auto-pickup lists (ui/pickup/AutoPickupPanel.ts: mining mode, search, the whitelist
 * and blacklist as icon grids, templates), moved here from their own floating panel. The cargo panel's "Auto-pickup: N"
 * chip opens this tab.
 */
import type { AutoPickupPanel } from '../../pickup/AutoPickupPanel';
import type { ShipTab } from '../shipTabs';

export function pickupTab(lists: () => AutoPickupPanel): ShipTab {
  return {
    id: 'pickup', label: 'Pickup', title: 'Auto-pickup: what your hold picks up by itself, and mining mode', live: 0,
    render(body) { lists().mountIn(body); },
    hide() { lists().unmount(); },
  };
}
