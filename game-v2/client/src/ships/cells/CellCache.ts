/**
 * The focus grid's dropped-cell cache on the client (CAPS.FOCUS; common network/cells.ts; server net/cells/FocusCells.ts).
 *
 * The `cells` message after a snapshot:
 * - `d`: cells that left its focus with that snapshot. Their ships come off the tick layer (ShipReplicaSet.detach) as
 *   they were at its tick, kept with a hash of them (cellMemberHash per ship, cellHash) for CELL_HOLD_TICKS and a little.
 *   Their entity rows go (`forget`); their structure stays in the ship store (`has`: not pruned while kept).
 * - `b`: cells it dropped that are in its focus again: it answers (cellCache) with the hash it kept, or 0 when it has
 *   nothing of that drop or it would have to fast-forward more than CELL_REPLAY_CAP ticks.
 * - `l`: the server's settling: the ships listed go back on the tick layer with the control changes they missed
 *   (ShipReplicaSet.attach: they step on from the drop's tick as they're asked for), the rest of the cell is forgotten.
 *   None listed: all forgotten, they come as new.
 *
 * Shared by the game (ShipClient) and the server's fake clients (tests, the crowd bench), so both run the same code.
 */
import {
  CELL_HOLD_TICKS, CELL_REPLAY_CAP, cellMemberHash, cellHash, unpackCellLogs,
  type ShipReplicaSet, type ReplicaHold, type ClientMessage, type ServerCellsMessage,
} from '@space-game/common';

export interface CellCacheHost {
  readonly reps: ShipReplicaSet;
  send(m: ClientMessage): void;
  /** A ship whose cell was dropped: off the world view (its entity row, bodies flown here) */
  forget(id: number): void;
}

interface Kept { T: number; h: number; ships: Map<number, ReplicaHold> }

/** Kept this long past the hold (the server offers it back up to a second before the hold ends: no race) */
const KEEP_TICKS = CELL_HOLD_TICKS + 120;

export class CellCache {
  private kept = new Map<number, Kept>();
  private ids = new Map<number, number>();
  readonly stats = { drops: 0, keptShips: 0, offers: 0, answered: 0, logs: 0, restored: 0, replayTicks: 0, forgotten: 0, missing: 0 };

  constructor(private host: CellCacheHost) {}

  /** Is this ship kept in a dropped cell (its structure stays in the store meanwhile) */
  has(id: number): boolean {
    return this.ids.has(id);
  }

  get size(): number {
    return this.kept.size;
  }

  clear(): void {
    this.kept.clear();
    this.ids.clear();
  }

  onCells(m: ServerCellsMessage): void {
    const tick = m.tick;
    this.sweep(tick);
    const d = m.d ?? [];
    for (let i = 0; i + 1 < d.length;) {
      const cell = d[i++], n = d[i++];
      this.drop(cell, tick, d.slice(i, i + n));
      i += n;
    }
    for (const lg of unpackCellLogs(m.l ?? [])) this.settle(lg.cell, lg.T, lg.ships, tick);
    const b = m.b ?? [], answer: number[] = [];
    for (let i = 0; i + 1 < b.length; i += 2) {
      const cell = b[i], T = b[i + 1], k = this.kept.get(cell);
      const ok = !!k && k.T === T && tick - T <= CELL_REPLAY_CAP;
      answer.push(cell, T, ok ? k!.h : 0);
      this.stats.offers++;
      if (ok) this.stats.answered++;
    }
    if (answer.length) this.host.send({ type: 'cellCache', c: answer });
  }

  private drop(cell: number, T: number, list: readonly number[]): void {
    this.forgetCell(cell);
    const members: [number, number][] = [], ships = new Map<number, ReplicaHold>();
    for (const id of list) {
      const st = this.host.reps.at(id, T);
      const hold = st ? this.host.reps.detach(id) : null;
      this.host.forget(id);
      // (Only what it keeps counts: one held but not kept, a piece of debris say, makes the hash miss, so it comes back as
      // new rather than as a log naming a ship it no longer has)
      if (!hold) continue;
      members.push([id, cellMemberHash(id, st!.body, st!.bits, st!.q)]);
      ships.set(id, hold);
      this.ids.set(id, cell);
    }
    // (One it didn't have: the hash says so, and the cell comes back as new)
    if (members.length < list.length) members.push([-1, 0]);
    this.kept.set(cell, { T, h: cellHash(members), ships });
    this.stats.drops++;
    this.stats.keptShips += ships.size;
  }

  private settle(cell: number, T: number, ships: readonly { id: number; events: [number, number, number][] }[], tick: number): void {
    const k = this.kept.get(cell);
    if (k && k.T === T) {
      for (const s of ships) {
        const hold = k.ships.get(s.id);
        if (!hold) { this.stats.missing++; continue; }
        k.ships.delete(s.id);
        this.ids.delete(s.id);
        if (this.host.reps.has(s.id)) continue;
        this.host.reps.attach(s.id, hold, s.events);
        this.stats.restored++;
        this.stats.replayTicks += tick - T;
      }
      if (ships.length) this.stats.logs++;
    } else if (ships.length) this.stats.missing += ships.length;
    this.forgetCell(cell);
  }

  private forgetCell(cell: number): void {
    const k = this.kept.get(cell);
    if (!k) return;
    for (const id of k.ships.keys()) if (this.ids.get(id) === cell) { this.ids.delete(id); this.stats.forgotten++; }
    this.kept.delete(cell);
  }

  /** Drops older than the hold let go */
  sweep(tick: number): void {
    for (const [cell, k] of this.kept) if (tick - k.T > KEEP_TICKS) this.forgetCell(cell);
  }
}
