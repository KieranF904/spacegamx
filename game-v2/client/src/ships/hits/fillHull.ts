import { EntityType, coreHp, stagedIntegrity } from '@space-game/common';
import type { GameState } from '../../state/GameState';
import type { ShipStore } from '../ShipStore';

/**
 * A ship body's core and hull % (its status data [5] and [7], which the HUD,
 * health bars and boss bar read) come from its part HP, which we have, rather
 * than over the wire again.
 */
export function fillHull(store: ShipStore, entities: GameState['entities'], id: number): void {
  const e = entities.get(id);
  const ship = store.get(id);
  if (!e || !ship || e.type !== EntityType.ShipBody || !e.data || e.data.length < 8) return;
  const core = coreHp(ship);
  let hp = 0, max = 0;
  ship.maxHp.forEach((m, i) => { max += m; if (!ship.detached[i]) hp += Math.max(0, ship.hp[i]); });
  e.data[5] = Math.round((core.max > 0 ? core.hp / core.max : 0) * 100);
  // (a boss in stages: each stage its share of the bar, as its phases reckon it)
  const staged = stagedIntegrity(store.catalog, ship);
  e.data[7] = Math.round((staged ?? (max > 0 ? hp / max : 0)) * 100);
}
