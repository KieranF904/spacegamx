/**
 * A pilot's own shells as fire events (CAPS.OWN_SHOTS; docs/design/confirmed-hits.md, follow-ups F2 and F3). Before, a
 * client's own shells came as projectile rows: spawn to 0.1, velocity to 0.01, ~2 B a shell more than another ship's
 * (its gun), and off the server's line by a fraction of a unit after a second of flight, which made nearly every hit
 * the client found wrongly. A fire event says only which gun fired on which tick, with what aim and ammunition, and the
 * shells' ids; the client builds the shells with the shared, deterministic launch maths (common launch.ts
 * rebuildVolley), as it does for every other ship's.
 *
 * From the pilot's confirmed ship, not its prediction: such a client is sent its own ship's replication too (the same
 * keyframes and control rows everyone else gets of it: Replication.forClient `own`), so it has its ship as the server's
 * shadow has it on every tick, knocks and all (a knock is a keyframe), beside its prediction. Its tick-aligned layer
 * (its own shells, the hits on them, the hash) counts from that; its prediction draws. So its own shells are exact by
 * construction, whatever its prediction did, under the rule every other ship's go by: a window its ship is keyframed
 * in goes as rows (where it was before the keyframe's tick isn't known), and those rows' shells are told, not found
 * (HitLedger 'row'). Shells that don't fly a straight line from the muzzle (homing, guided, lobbed, arming late) go as
 * rows too: their rows carry where they are. Whether a gun fired at all (energy, ammunition, its clip) and its spread
 * are in the event (the shells' ids, the ammunition code; spread is seeded by the shell: shellSeed).
 */
import { CAPS, firesStraight, gunShell, type FireRecord } from '@space-game/common';
import type { ShipBridge } from '../../ships/ShipBridge.js';

/** Does this client take its own shells as fire events (and its own ship's replication, to build them from)? */
export function ownShotsFor(caps: number | undefined): boolean {
  return !!((caps ?? 0) & CAPS.OWN_SHOTS);
}

/** Can the pilot's client build this volley of its own exactly? (shells, flying straight from the muzzle) */
export function ownVolleyExact(ships: ShipBridge, f: FireRecord): boolean {
  // (no shells: a charge gun's tell or a pulse, which its own gun state shows)
  if (!f.ids.length) return false;
  const ship = ships.get(f.owner);
  const sh = ship ? gunShell(ships.tuning, ship, f.part + 256 * (f.ammo ?? 0) + (f.aug ? 65536 : 0)) : null;
  return !!sh && firesStraight(sh.def) && !sh.def.lob && !sh.def.arm;
}

/**
 * Does this client step its own ship itself (CAPS.OWN_SIM, with OWN_SHOTS: common network/ownTick.ts)? Then it isn't
 * sent its own ship's control rows or keyframes but the causes of what moved it, and checks it (net/own/OwnChecks.ts)
 */
export function ownSimFor(caps: number | undefined): boolean {
  return ((caps ?? 0) & (CAPS.OWN_SHOTS | CAPS.OWN_SIM)) === (CAPS.OWN_SHOTS | CAPS.OWN_SIM);
}
