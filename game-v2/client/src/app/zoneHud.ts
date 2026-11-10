/**
 * @contract client.app.zone-hud
 * owns:       the HUD's zone readout each frame: sector danger, PvP safety, the ring and danger band you are in, and your rating against it
 * needs:      ZoneHost (state, world queries, ship rating, RegionUI, the pilot HUD and system map), data/systems.json; npm: @space-game/common
 * invariants: safety follows the server's inPvpZone rule (the zone half of canDamage): safe in a pvp system only inside a station's ring — client/src/app/appInvariants.test.ts
 * extend:     a new zone fact on the HUD is one more argument to setZone below
 */

import { EntityType, type StarSystemData } from '@space-game/common';
import systemsData from '../../../data/systems.json';
import { boundKeyName } from '../input/keybindings';
import { settings } from '../settings/Settings';
import type { GameState } from '../state/GameState';
import type { RegionUI } from '../ui/RegionUI';
import type { ShipClient } from '../ships/ShipClient';
import type { WindowSet } from './windows';
import type { WorldQueries } from './worldQueries';

/** What the zone readout reads from the game */
export interface ZoneHost {
  readonly state: GameState;
  readonly world: WorldQueries;
  readonly shipClient: Pick<ShipClient, 'myRating'>;
  readonly regionUI: RegionUI;
  readonly w: Pick<WindowSet, 'systemMapUI' | 'pilotHud'>;
}

/** Sector danger and PvP status for the HUD (the same rules as the server's canDamage) */
export function updateZone(h: ZoneHost): void {
  const me = h.state.entities.get(h.state.playerId);
  const sys = h.world.currentSystem();
  if (!sys || !me) return;
  let safe = true;
  if (sys.pvp) {
    safe = false;
    for (const e of h.state.entities.values()) {
      if (e.type !== EntityType.Station) continue;
      const d = Math.hypot(e.renderX - me.renderX, e.renderY - me.renderY);
      const r = sys.pvp.mode === 'outer' ? sys.pvp.safeRadius ?? 3000 : Math.max((e.data?.[8] ?? 200) + 1500, 2200);
      if (d < r) { safe = true; break; }
    }
  }
  const r = Math.hypot(me.renderX, me.renderY);
  const ring = sys.zones?.find((z) => { const d = z.x !== undefined ? Math.hypot(me.renderX - z.x, me.renderY - (z.y ?? 0)) : r; return d >= z.inner && d <= z.outer; });
  const rating = h.shipClient.myRating();
  const ctx = {
    sys, x: me.renderX, y: me.renderY, rating, threats: h.state.threats, regionThreats: h.state.regionThreats,
    system: (id: string) => (systemsData as unknown as { systems: StarSystemData[] }).systems.find((s) => s.id === id),
    locked: (id: string) => h.w.systemMapUI.locked?.(id) ?? null, interactKey: boundKeyName('interact', settings.data.bindings),
  };
  const region = h.regionUI.current(ctx);
  h.regionUI.update(ctx);
  h.w.pilotHud.setZone(sys.name.replace(/ System$/, ''), sys.danger ?? 1, !!sys.pvp, safe, ring, region ?? undefined);
  // (Against the band you're in, where a system has them)
  h.w.pilotHud.setRating(rating, (region && h.state.regionThreats[sys.id]?.[region.id]) || h.state.threats[sys.id]);
}
