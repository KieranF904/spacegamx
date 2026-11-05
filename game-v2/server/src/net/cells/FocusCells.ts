/**
 * The focus grid on the server (CAPS.FOCUS; common network/cells.ts; docs/design/awareness-model.md section 0).
 *
 * Shared, once a snapshot round: every ship's home cell (with CELL_HOME_SLACK) and each system's cells' lists of
 * ships. Per client: its focus cells (every cell within 19 km of its ship, flat) and its ring. A client's ship view is
 * its own ship and the ships homed in its focus cells: that replaces the 40/48 km circle (SnapshotBuilder.updateShipView)
 * and costs the focus's ships, not the system's.
 *
 * - **Leaving, coming back.** A ship whose cell left the focus, or that left a focus cell, is out of view at once (the
 *   snapshot's `out`, as any ship leaving a view). What both ends remember of it while it is away, and what goes when it
 *   comes back (only what changed), is net/cells/AwayNet.ts: one path, whichever moved.
 * - **Jumps.** While its ship is in a jump's burn its focus holds as it was (a transit: no cell dropped or entered on the
 *   way); the burn's end drops the old cells and enters the new ones at once.
 * - **Ghosts.** The ring (cells within 35 km), party and target: map-dot legs (sendMapDots), not held.
 */
import { InSystem, Position, FOCUS_RANGE, focusCells, ringCells, homeCell } from '@space-game/common';
import type { ClientConnection } from '../ClientConnection.js';

/** What the focus grid needs of the server */
export interface FocusHost {
  /** Every ship body (id order as the bridge keeps them) */
  bodies(): Iterable<number>;
  has(eid: number): boolean;
  /** A client's party's ships and its target: ghosts wherever they are */
  partyOf(conn: ClientConnection): readonly number[];
  targetOf(eid: number): number;
  /** Its ship is in a jump's burn (20 km/s: a cell every 24 ticks): its focus holds still till it ends */
  transit(eid: number): boolean;
  /** The focus radius in a system (19 km; less in a crowd: net/crowd/CrowdControl.ts) */
  focusOf?(system: number): number;
}

/** One client's focus (ClientConnection.focus) */
export interface FocusState {
  /** The system it is for */
  system: number;
  /** Its focus cells as of the last round */
  cells: Set<number>;
  ring: Set<number>;
}

export class FocusCells {
  /** Every ship's home cell (kept between rounds: the slack needs the last) */
  private homes = new Map<number, number>();
  /** This round's cells, by system: cell -> ships homed there (body order) */
  private grid = new Map<number, Map<number, number[]>>();
  /** Counters (the crowd bench, the tests): cells entering and leaving clients' focus */
  readonly stats = { rounds: 0, entered: 0, left: 0 };

  constructor(private host: FocusHost) {}

  /** Once a round, before any client's view: home cells and the cells' lists, for the systems with a client */
  beginRound(systems: ReadonlySet<number>): void {
    this.stats.rounds++;
    this.grid.clear();
    for (const eid of this.homes.keys()) if (!this.host.has(eid)) this.homes.delete(eid);
    if (!systems.size) return;
    for (const eid of this.host.bodies()) {
      const sys = InSystem.systemId[eid];
      if (!systems.has(sys)) continue;
      const h = homeCell(this.homes.get(eid), Position.x[eid], Position.y[eid]);
      this.homes.set(eid, h);
      let cells = this.grid.get(sys);
      if (!cells) this.grid.set(sys, (cells = new Map()));
      const list = cells.get(h);
      if (list) list.push(eid); else cells.set(h, [eid]);
    }
  }

  /** A ship's home cell this round (undefined: not placed) */
  homeOf(eid: number): number | undefined {
    return this.homes.get(eid);
  }

  /** Forget a client's focus (a new system, its death, its caps switched): it starts afresh */
  reset(conn: ClientConnection): void {
    conn.focus = undefined;
  }

  /**
   * A client's view this round: its own ship and the ships homed in its focus
   * cells. Returns the ships that left its view (they go in the snapshot's `out`)
   */
  view(conn: ClientConnection, system: number, px: number, py: number): number[] {
    let st = conn.focus;
    if (!st || st.system !== system) st = conn.focus = { system, cells: new Set(), ring: new Set() };
    // (In a jump's burn: the focus it had holds, no cell dropped or entered on the way; the burn's end is one change)
    const transit = st.cells.size > 0 && this.host.transit(conn.playerId);
    const range = this.host.focusOf?.(system) ?? FOCUS_RANGE;
    const now = transit ? st.cells : new Set(focusCells(px, py, undefined, range));
    if (!transit) st.ring = new Set(ringCells(px, py, undefined, range));
    for (const c of st.cells) if (!now.has(c)) this.stats.left++;
    for (const c of now) if (!st.cells.has(c)) this.stats.entered++;
    st.cells = now;
    const cells = this.grid.get(system);
    const was = conn.shipView, view = new Set<number>([conn.playerId]);
    for (const c of now) for (const id of cells?.get(c) ?? []) view.add(id);
    const left: number[] = [];
    // (A ship gone to another system has left its view too: its client would keep it where it was, stepping it on)
    for (const id of was) if (!view.has(id) && this.host.has(id)) left.push(id);
    conn.shipView = view;
    return left;
  }

  /** Its ghosts (map-dot legs with its map closed): ships homed in its ring or focus it doesn't hold, its party and its target */
  ghost(conn: ClientConnection): ((eid: number) => boolean) | null {
    const st = conn.focus;
    if (!st) return null;
    const party = new Set(this.host.partyOf(conn));
    const target = this.host.targetOf(conn.playerId);
    return (eid) => {
      if (conn.shipView.has(eid)) return false;
      if (party.has(eid) || eid === target) return true;
      const h = this.homes.get(eid);
      return h !== undefined && (st.ring.has(h) || st.cells.has(h));
    };
  }
}
