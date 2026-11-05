/**
 * A pilot's own shells as fire events (CAPS.OWN_SHOTS, every client; docs/design/confirmed-hits.md, follow-ups F2 and F3). Before, a
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
import { firesStraight, gunShell, ownShotWireOf, type FireRecord } from '@space-game/common';
import type { ShipBridge } from '../../ships/ShipBridge.js';

/**
 * A client's own shells it works out itself (CAPS.SHOT_IDS; sim foundation 1B): no fire record, no row, and no
 * removal at the end of their life (it works that out too); a removal it can't derive (a rock strike, point defence)
 * and its hit records name each by its wire name (ownShotWire: its shot id without the owner). Per client, by entity
 * id, from the round's fire records till the shell is removed.
 */
export class OwnShotLog {
  private readonly byConn = new WeakMap<object, Map<number, number>>();
  /** Counters: shells worked out, fire records not sent (and their JSON bytes), removals not sent / still sent */
  readonly stats = { derived: 0, fireRowsSaved: 0, fireBytesSaved: 0, removalsSaved: 0, removalsSent: 0 };

  /** Can its client derive this record of its own (its shells straight from the muzzle, each with a shot id)? */
  static derivable(ships: ShipBridge, f: FireRecord): boolean {
    return !!f.shots && f.shots.length === f.ids.length && ownVolleyExact(ships, f);
  }

  /** A fire record of its own it builds itself: its shells are its own from here (no row, no record) */
  derive(conn: object, f: FireRecord): void {
    if (!f.shots || f.shots.length !== f.ids.length) return;
    let m = this.byConn.get(conn);
    if (!m) this.byConn.set(conn, (m = new Map()));
    for (let i = 0; i < f.ids.length; i++) m.set(f.ids[i], ownShotWireOf(f.shots[i]));
    this.stats.derived += f.ids.length;
    this.stats.fireRowsSaved++;
    // (what the record would have cost as JSON: [owner, ago, part+ammo, aimQ, ...ids])
    this.stats.fireBytesSaved += JSON.stringify([f.owner, 0, f.part + 256 * (f.ammo ?? 0) + (f.aug ? 65536 : 0), f.aimQ, ...f.ids]).length + 1;
  }

  /** Its wire name for a shell of its own it works out (undefined: not one) */
  wireOf(conn: object, id: number): number | undefined {
    return this.byConn.get(conn)?.get(id);
  }

  has(conn: object, id: number): boolean {
    return !!this.byConn.get(conn)?.has(id);
  }

  /**
   * The shell is removed: its name for the removed list if the client can't work the removal out itself (`early`: the
   * server's shell had life left: a rock, point defence), else null (expired: the client removes it at the end of its
   * life itself; `spent`: a hit record ended it). Forgotten either way
   */
  removed(conn: object, id: number, early: boolean, spent = false): number | null {
    const m = this.byConn.get(conn), wire = m?.get(id);
    if (wire === undefined) return null;
    m!.delete(id);
    if (spent) return null;
    if (early) { this.stats.removalsSent++; return wire; }
    this.stats.removalsSaved++;
    return null;
  }

  /** Spent by a hit record (the record ends it on the client): forgotten */
  forget(conn: object, id: number): void {
    this.byConn.get(conn)?.delete(id);
  }
}

/** Can the pilot's client build this volley of its own exactly? (shells, flying straight from the muzzle) */
export function ownVolleyExact(ships: ShipBridge, f: FireRecord): boolean {
  // (no shells: a charge gun's tell or a pulse, which its own gun state shows)
  if (!f.ids.length) return false;
  const ship = ships.get(f.owner);
  const sh = ship ? gunShell(ships.tuning, ship, f.part + 256 * (f.ammo ?? 0) + (f.aug ? 65536 : 0)) : null;
  return !!sh && firesStraight(sh.def) && !sh.def.lob && !sh.def.arm;
}
