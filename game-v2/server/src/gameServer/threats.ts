/**
 * @contract server.gameserver.threats
 * owns:       threat ratings of systems and regions for maps and HUD
 * needs:      GameServer (type), game/Enemies, @space-game/common
 * invariants: ratings are cached until cleared, the training yard is not rated, a band is at least as bad as the one inside it — server/src/gameServer/serverParts.test.ts
 * extend:      n/a
 */

import { isDevOnly } from '@space-game/common';
import type { GameServer } from '../GameServer.js';

/** Each system's threat (ratings.ts scale): for one with danger bands, its innermost band's, where you come in */
export function threats(gs: GameServer): Record<string, number> {
  if (gs.threatCache) return gs.threatCache;
  const out: Record<string, number> = {};
  for (const sys of gs.gameData.getAllSystems()) {
    // (The training yard has nothing to rate: not told to clients)
    if (sys.tutorial || isDevOnly(sys)) continue;
    const bands = gs.regionThreats()[sys.id];
    const r = sys.surface?.bastion ? gs.sieges.threat(sys) : bands ? bands[sys.regions![0].id] : gs.enemies.systemRating(sys.id);
    if (r > 0) out[sys.id] = Math.round(r);
  }
  return (gs.threatCache = out);
}

/** The threat in each danger band of the systems that have them (system id -> region id -> threat) */
export function regionThreats(gs: GameServer): Record<string, Record<string, number>> {
  if (gs.regionThreatCache) return gs.regionThreatCache;
  const out: Record<string, Record<string, number>> = {};
  for (const sys of gs.gameData.getAllSystems()) {
    if (!sys.regions?.length || sys.tutorial || isDevOnly(sys)) continue;
    const bands: Record<string, number> = {};
    let inner = 0, last = 0;
    for (const g of sys.regions) {
      const r = Math.round(gs.enemies.systemRating(sys.id, { inner, outer: g.outer }));
      // (A band with nothing rated of its own is at least as bad as the one inside it)
      bands[g.id] = Math.max(r, g.danger === 'safe' ? 0 : last);
      last = bands[g.id];
      inner = g.outer;
    }
    out[sys.id] = bands;
  }
  return (gs.regionThreatCache = out);
}
