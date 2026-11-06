/**
 * Each ship's structures after its last few rebuild ticks (CAPS.STRUCTS): what a sync would have said of it then (the
 * HP it rebuilt from, its detached and ghost parts) and its centre of mass, stamped with the tick. A ship rebuilt twice
 * in one snapshot window flew the structure between for a few ticks; a client keeping each structure by its tick
 * (client ShipStore.derivedAt) is sent every one in order (SnapshotBuilder), so it works the window's causes out
 * itself instead of being sent a keyframe of the ship.
 *
 * At most one entry a tick: a ship that breaks apart rebuilds twice on its tick (rebuildNow), and only how that tick
 * left it was ever flown.
 */
import type { ShipDerived, ShipState, Vec2 } from '@space-game/common';

export interface StructEntry {
  tick: number;
  rebuilds: number;
  /** The ship state it was (a refit or respawn makes a new one: entries of another aren't its) */
  ship: ShipState;
  com: Vec2;
  /** The structure itself (a hit on it before the next rebuild is worked out on it: HitLedger.derive) */
  derived: ShipDerived;
  hp: readonly number[];
  detached: readonly number[];
  ghosts?: readonly number[];
}

/** Entries kept a ship (a snapshot window holds at most a few) */
const KEEP = 8;

export class StructLog {
  private readonly log = new Map<number, StructEntry[]>();

  /** The ship as this tick's rebuild left it (again on the same tick: that replaces it) */
  note(eid: number, ship: ShipState, tick: number): void {
    let list = this.log.get(eid);
    if (!list) this.log.set(eid, (list = []));
    // (Another ship state, or a tick before the last one's (a clock it moved off: travel): it starts over)
    if (list.length && (list[list.length - 1].ship !== ship || list[list.length - 1].tick > tick)) list.length = 0;
    const e: StructEntry = {
      tick, rebuilds: ship.rebuilds, ship, com: ship.derived.com, derived: ship.derived, hp: [...ship.rebuildHp],
      detached: ship.detached.flatMap((d, i) => (d ? [i] : [])),
      ghosts: ship.ghost.some(Boolean) ? ship.ghost.flatMap((g, i) => (g ? [i] : [])) : undefined,
    };
    if (list.length && list[list.length - 1].tick === tick) list[list.length - 1] = e;
    else { list.push(e); if (list.length > KEEP) list.shift(); }
  }

  /** Its entry for this rebuild count (undefined: too long ago, or not this ship state) */
  at(eid: number, ship: ShipState, rebuilds: number): StructEntry | undefined {
    const list = this.log.get(eid);
    if (list) for (let i = list.length - 1; i >= 0; i--) if (list[i].rebuilds === rebuilds && list[i].ship === ship) return list[i];
    return undefined;
  }

  /**
   * Its structures after `from` (a rebuild count a client has) up to its current one, oldest first; null when one is
   * missing (too long ago: the client gets the current one alone)
   */
  since(eid: number, ship: ShipState, from: number): StructEntry[] | null {
    const list = this.log.get(eid);
    if (!list) return null;
    let i = list.length - 1;
    if (i < 0 || list[i].ship !== ship || list[i].rebuilds !== ship.rebuilds) return null;
    while (i >= 0 && list[i].ship === ship && list[i].rebuilds > from) i--;
    if (i < 0 || list[i].ship !== ship || list[i].rebuilds !== from) return null;
    return list.slice(i + 1);
  }

  /** Its entry for the rebuild on this tick and the one before it (undefined: not kept) */
  around(eid: number, tick: number): [StructEntry, StructEntry] | undefined {
    const list = this.log.get(eid);
    if (list) for (let i = list.length - 1; i > 0; i--) if (list[i].tick === tick) return list[i - 1].ship === list[i].ship ? [list[i - 1], list[i]] : undefined;
    return undefined;
  }

  forget(eid: number): void {
    this.log.delete(eid);
  }
}

/**
 * A client's next sync of a ship (CAPS.STRUCTS): the structures between to send first, in order, then the current one
 * stamped `at`, and the rebuild counts it keeps after (oldest first). No `at`: one is missing (too long ago), so it
 * starts over from the current one, keeping none
 */
export function nextSync(log: StructLog, id: number, ship: ShipState, synced?: { ship: ShipState; rebuilds: number; kept?: number[] }): { between: StructEntry[]; kept: number[]; at?: number } {
  const fresh = !synced || synced.ship !== ship;
  const since = fresh ? [] : log.since(id, ship, synced!.rebuilds);
  const at = log.at(id, ship, ship.rebuilds)?.tick;
  if (!since || at === undefined) return { between: [], kept: [] };
  const between = since.slice(0, -1);
  return { between, kept: [...(fresh ? [] : (synced!.kept ?? []).slice(-7)), ...between.map((e) => e.rebuilds), ship.rebuilds], at };
}
