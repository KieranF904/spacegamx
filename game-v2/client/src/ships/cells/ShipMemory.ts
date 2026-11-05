/**
 * Ships away (CAPS.FOCUS; common network/cells.ts AwayShips; server net/cells/AwayNet.ts): what the client keeps of a
 * ship that left its view, so that when it comes back the server sends only what changed.
 *
 * The `cells` message just before a snapshot, applied in order:
 * - `b`: ships back in view with that snapshot. Their status row (entity) goes back where it was; their structure never
 *   left the ship store; the snapshot brings their keyframe (they start from it: nothing replayed), a row only if it
 *   changed, and syncs only of what changed. One it has nothing of (cleared at a moment the server didn't) asks for its
 *   structure again (`shipNeed`; the server sends its row afresh too).
 * - `k`: ships leaving its view with that snapshot (its `out`): their status row is kept here and their structure stays
 *   in the store (`has`: not pruned while kept). Their replicas go with the snapshot's `out`, as any ship's leaving view.
 * The snapshot's removals take a kept ship out as well (destroyed or gone while away: told by id). Both ends keep the
 * same list by the same rule (age, count: AwayShips), so nothing about letting go goes over the wire: whenever it applies
 * a change it has swept to that tick first, as the server had. A ship let go leaves its structure to the store's prune
 * (it may be back in view by then, synced afresh: the store keeps what's in view).
 *
 * Shared by the game (ShipClient) and the server's fake clients (tests, the crowd bench), so both run the same code.
 */
import { AwayShips, type ClientMessage, type ServerCellsMessage } from '@space-game/common';

export interface ShipMemoryHost<E> {
  /** The ship's status row as the client has it now (its world entity), to keep (undefined: none) */
  entity(id: number): E | undefined;
  /** ...put back */
  restore(id: number, e: E): void;
  send(m: ClientMessage): void;
}

export class ShipMemory<E = unknown> {
  private away = new AwayShips<E | null>();
  readonly stats = { kept: 0, back: 0, missed: 0, letGo: 0, removed: 0 };

  constructor(private host: ShipMemoryHost<E>) {}

  /** Is this ship kept while away (its structure stays in the store meanwhile) */
  has(id: number): boolean {
    return this.away.has(id);
  }

  get size(): number {
    return this.away.size;
  }

  /** The ids kept (the tests: the same list as the server's) */
  ids(): number[] {
    return [...this.away.ids()];
  }

  /** A new system, a new connection: nothing kept (the server lets go at the same moments) */
  clear(): void {
    this.away.clear();
  }

  private letGo = (): void => { this.stats.letGo++; };

  onCells(m: ServerCellsMessage): void {
    const letGo = this.letGo;
    this.away.sweep(m.tick, letGo);
    for (const id of m.b ?? []) {
      const e = this.away.take(id);
      if (e) { this.host.restore(id, e); this.stats.back++; continue; }
      this.stats.missed++;
      this.host.send({ type: 'shipNeed', id });
    }
    for (const id of m.k ?? []) {
      this.away.leave(id, m.tick, this.host.entity(id) ?? null, letGo);
      this.stats.kept++;
    }
  }

  /** A snapshot: let go of what's too old by its tick; kept ships among its removals are gone */
  onSnapshot(tick: number, removed: readonly number[]): void {
    if (!this.away.size) return;
    this.away.sweep(tick, this.letGo);
    for (const id of removed) if (this.away.take(id) !== undefined) this.stats.removed++;
  }
}
