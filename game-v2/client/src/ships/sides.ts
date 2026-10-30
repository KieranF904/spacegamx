/**
 * Who may hurt whom, as the server has it (GameServer.canDamage): a beam the
 * server lets pass through a ship must be drawn passing through it too.
 *
 *   - people's craft are out of every fight (snapshot data[10] = 2)
 *   - pilots and what they defend (wards: data[10] = 1) are on one side
 *   - two pilots only in a PvP sector, both out of a station's ring
 *   - everything else, yes
 */

import { EntityType, type StarSystemData } from '@space-game/common';
import systemsData from '../../../data/systems.json';
import type { GameState } from '../state/GameState';

const SYSTEMS = new Map((systemsData as unknown as { systems: StarSystemData[] }).systems.map((s) => [s.id, s]));

/** A pilotless ship's side flag (data[10] of its snapshot row) */
export const SIDE_WARD = 1, SIDE_OUT = 2;

type Side = 'pilot' | 'ward' | 'out' | 'other';

function sideOf(state: GameState, id: number): Side {
  const e = state.entities.get(id);
  if (!e) return 'other';
  if (e.type === EntityType.Player) return 'pilot';
  if (e.type === EntityType.ShipBody) {
    const f = e.data?.[10];
    if (f === SIDE_OUT) return 'out';
    if (f === SIDE_WARD) return 'ward';
  }
  return 'other';
}

/** Is this pilot in its system's PvP space (out of every station's ring) */
function inPvp(state: GameState, id: number): boolean {
  const sys = SYSTEMS.get(state.systemId);
  const e = state.entities.get(id);
  if (!sys?.pvp || !e) return false;
  for (const st of state.entities.values()) {
    if (st.type !== EntityType.Station) continue;
    const r = sys.pvp.mode === 'outer' ? sys.pvp.safeRadius ?? 3000 : Math.max((st.data?.[8] ?? 200) + 1500, 2200);
    if (Math.hypot(st.renderX - e.renderX, st.renderY - e.renderY) < r) return false;
  }
  return true;
}

export function canHurt(state: GameState, attacker: number, target: number): boolean {
  const a = sideOf(state, attacker), t = sideOf(state, target);
  if (a === 'out' || t === 'out') return false;
  const friendA = a === 'pilot' || a === 'ward', friendT = t === 'pilot' || t === 'ward';
  if (friendA && friendT && !(a === 'pilot' && t === 'pilot')) return false;
  if (a !== 'pilot' || t !== 'pilot') return true;
  return inPvp(state, attacker) && inPvp(state, target);
}
