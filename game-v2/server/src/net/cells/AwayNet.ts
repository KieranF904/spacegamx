/**
 * Ships away, the server side (CAPS.FOCUS; common network/cells.ts AwayShips; client ships/cells/ShipMemory.ts).
 *
 * A ship leaving a client's view (its cell left the focus, or it left a focus cell: one path) is remembered at
 * both ends for minutes. The server keeps, per client, the tick it left and its status row's key as last sent; what it
 * last sent of the ship's structure and part HP stays where it always is (ClientConnection.shipSynced, shipHpSent) and
 * its name in sentNames. When it comes back the client is sent only what changed since it left:
 * - its movement always: its keyframe (full precision), as every ship new to a client's tick layer gets (repKnown
 *   forgot it on leaving). Nothing is replayed, so the client does no catching up.
 * - its status row only if its key changed (and then without its place, as for a ship the client holds);
 * - its part HP only as the changes (shipHps), a rebuild as a light sync, its blueprint only if it was replaced by
 *   one of a design the client hasn't seen (SnapshotBuilder.sendShipUpdates, from what it has);
 * - a ship destroyed or gone while away: its id in the snapshot's removals.
 * Debris isn't kept (its pieces are run as a world: they come back as new), nor a ship the client was never synced.
 * The `cells` message before the snapshot says which ships come back (`b`) and which are kept (`k`); both ends let go
 * by the same rule (AWAY_TICKS, AWAY_CAP), so letting go goes unsaid.
 */
import { AwayShips, type ServerCellsMessage } from '@space-game/common';
import type { ClientConnection } from '../ClientConnection.js';

/** What the server keeps of a ship away from one client (the rest is in what it was sent: shipSynced, shipHpSent, sentNames) */
export interface AwayShip {
  /** Its status row's key as last sent (SnapshotBuilder's lastEntityStates) */
  row?: string;
}

export interface AwayHost {
  /** Is this ship kept while away from this client (a ship, not debris, that it has a sync of) */
  keeps(conn: ClientConnection, id: number): boolean;
  /** Is it still in the world */
  has(id: number): boolean;
  send(conn: ClientConnection, msg: ServerCellsMessage): void;
}

export class AwayNet {
  /** Counters (the crowd bench, the tests) */
  readonly stats = { kept: 0, forgotten: 0, back: 0, letGo: 0, removed: 0 };

  constructor(private host: AwayHost) {}

  /** Let go of all of it (a new system, a new connection, its caps switched off): the client clears at those moments too */
  reset(conn: ClientConnection): void {
    conn.away?.clear((id) => this.forget(conn, id));
    conn.away = undefined;
  }

  /**
   * After its view this round, before its snapshot: ships back in view get their row key as last sent back in `rows`
   * (its last snapshot's keys: the row goes again only if it changed); ships leaving it (`out`) are kept, or forgotten
   * (forgotten: its structure and name go again when it comes back). Sends the `cells` message (before the snapshot) when anything came or went.
   * Returns the ships away that are gone from the world (destroyed, or gone while it had no snapshots): they go in the
   * snapshot's removals
   */
  round(conn: ClientConnection, tick: number, view: ReadonlySet<number>, out: readonly number[], rows: Map<number, string>): number[] {
    const away = (conn.away ??= new AwayShips<AwayShip>());
    const letGo = (id: number) => { this.stats.letGo++; this.forget(conn, id); };
    away.sweep(tick, letGo);
    const b: number[] = [], k: number[] = [], gone: number[] = [];
    if (away.size) {
      for (const id of away.ids()) if (!this.host.has(id)) gone.push(id);
      for (const id of gone) { away.take(id); this.forget(conn, id); }
      this.stats.removed += gone.length;
      for (const id of view) {
        const v = away.take(id);
        if (!v) continue;
        if (v.row !== undefined) rows.set(id, v.row);
        b.push(id);
      }
    }
    for (const id of out) {
      if (!this.host.keeps(conn, id)) { this.forget(conn, id); this.stats.forgotten++; continue; }
      away.leave(id, tick, { row: rows.get(id) }, letGo);
      k.push(id);
    }
    this.stats.back += b.length;
    this.stats.kept += k.length;
    if (b.length || k.length) this.host.send(conn, { type: 'cells', tick, ...(b.length ? { b } : {}), ...(k.length ? { k } : {}) });
    return gone;
  }

  /** What it was sent of a ship it no longer has: it gets it afresh when it comes back */
  private forget(conn: ClientConnection, id: number): void {
    conn.sentNames.delete(id);
    conn.shipSynced.delete(id);
    conn.shipHpSent.delete(id);
  }
}
