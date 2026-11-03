/**
 * A pilot's own shells as fire events (CAPS.OWN_SHOTS; docs/design/confirmed-hits.md, follow-ups F2). Before, a
 * client's own shells came as projectile rows: spawn to 0.1, velocity to 0.01, ~2 B a shell more than another ship's
 * (its gun), and off the server's line by a fraction of a unit after a second of flight, which made nearly every hit
 * the client found wrongly. A fire event says only which gun fired on which tick, with what aim and ammunition, and the
 * shells' ids; the client builds the shells from its own ship's pose on that tick (its prediction, which is where the
 * server had it while the prediction held: GameState.selfPoseAt) with the shared, deterministic launch maths
 * (common launch.ts rebuildVolley), as it does for every other ship's.
 *
 * Exact unless its prediction was off on that tick. The server knows when it is about to correct it (SnapshotBuilder:
 * a forced or late-input row, a new keyframe version, first sight, a change to what its flight depends on): that
 * window's shells go as rows. Shells that don't fly a straight line from the muzzle (homing, guided, lobbed, arming
 * late) go as rows too: their rows carry where they are. Whether a gun fired at all (energy, ammunition, its clip) and
 * its spread are in the event (the shells' ids, the ammunition code; spread is seeded by the shell: shellSeed), so
 * none of that needs predicting.
 */
import { CAPS, firesStraight, gunShell, type FireRecord } from '@space-game/common';
import type { ShipBridge } from '../../ships/ShipBridge.js';

/** Does this client take its own shells as fire events this snapshot? (`corrected`: its own row corrects its prediction) */
export function ownShotsFor(caps: number | undefined, corrected: boolean): boolean {
  return !!((caps ?? 0) & CAPS.OWN_SHOTS) && !corrected;
}

/** Can the pilot's client build this volley of its own exactly? (shells, flying straight from the muzzle) */
export function ownVolleyExact(ships: ShipBridge, f: FireRecord): boolean {
  // (no shells: a charge gun's tell or a pulse, which its own gun state shows)
  if (!f.ids.length) return false;
  const ship = ships.get(f.owner);
  const sh = ship ? gunShell(ships.tuning, ship, f.part + 256 * (f.ammo ?? 0) + (f.aug ? 65536 : 0)) : null;
  return !!sh && firesStraight(sh.def) && !sh.def.lob && !sh.def.arm;
}
