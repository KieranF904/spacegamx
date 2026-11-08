/**
 * @contract server.snapshot.rows.keys
 * owns:       the snapshot row record (SnapRow), the host the row kinds read, and the interned row keys (last snapshot's
 *             and this one's) that make each client's "changed?" test a pointer compare
 * needs:      bitecs IWorld, ShipBridge, Enemies, Mobs, LootPods, ServerFeatures, GunNet, ClientConnection
 * invariants: an unchanged key is the very string it was last snapshot — none pinned
 *             row bytes per client unchanged — server/src/golden/frameHash.test.ts
 * extend:     a new field a row kind reads is one member of RowHost below
 */
import type { IWorld } from 'bitecs';
import type { EntityState, ClientSocket } from '@space-game/common';
import type { ShipBridge } from '../../../ships/ShipBridge.js';
import type { Enemies } from '../../../game/Enemies.js';
import type { Mobs } from '../../../game/Mobs.js';
import type { LootPods } from '../../../game/LootPods.js';
import type { ServerFeatures } from '../../../ships/features/host.js';
import type { GunNet } from '../../guns/GunNet.js';
import type { ClientConnection } from '../../ClientConnection.js';

/** One entity's snapshot state, built once per system per snapshot */
export interface SnapRow {
  id: number;
  kind: 'player' | 'ship' | 'projectile' | 'pod' | 'mob';
  x: number;
  y: number;
  /** Without its name (names go separately, once) */
  state: EntityState;
  name?: string;
  /** What decides "changed since the last snapshot" */
  key: string;
  /** Players: the row other pilots get (status only: their motion is replicated) */
  other?: { state: EntityState; key: string; strip?: EntityState };
  /** Its status without where it is (a ship a client already has: one object for all of them, so it's encoded once) */
  strip?: EntityState;
}

/** What the row kinds read of the server (SnapshotBuilder builds one, once) */
export interface RowHost {
  readonly world: IWorld;
  readonly clients: ReadonlyMap<ClientSocket, ClientConnection>;
  readonly lingering: ReadonlyMap<number, { conn: ClientConnection; until: number }>;
  readonly ships: ShipBridge;
  readonly enemies: Enemies;
  readonly mobs: Mobs;
  readonly pods: LootPods;
  readonly features: ServerFeatures;
  readonly gunNet: GunNet | null;
  readonly personCraft: ReadonlyMap<number, string>;
  readonly wards: ReadonlyMap<number, string>;
  namedBody(eid: number): { name: string; kind: number } | undefined;
  /** The server itself, for its tick (read, never held) */
  readonly ticks: { readonly currentTick: number };
}

/**
 * The rows' keys by entity (status keys by -1 - id), the last snapshot's and this one's (see systemRows). A key
 * that hasn't changed since the last snapshot is made the very string it was then, so each pilot's "changed?" test
 * in sendSnapshots is a pointer comparison rather than a character-by-character one.
 */
export class RowKeys {
  private keysWere = new Map<number, { key: string; values?: readonly number[] }>();
  private keysNow = new Map<number, { key: string; values?: readonly number[] }>();
  internKey(id: number, key: string): string {
    const was = this.keysWere.get(id)?.key;
    const k = was === key ? was : key;
    this.keysNow.set(id, { key: k });
    return k;
  }
  /** A row's key from its values (joined with commas), without joining them again while they're unchanged */
  rowKey(id: number, values: readonly number[]): string {
    const was = this.keysWere.get(id);
    const same = !!was?.values && was.values.length === values.length && values.every((v, i) => v === was.values![i]);
    const key = same ? was!.key : values.join(',');
    this.keysNow.set(id, { key, values });
    return key;
  }
  /** After a snapshot round: this one's keys become the last */
  swap(): void {
    [this.keysWere, this.keysNow] = [this.keysNow, this.keysWere];
    this.keysNow.clear();
  }
}

/** A row added to this system's list (each key interned: ships and projectiles are keyed by their values, rowKey) */
export function pushRow(rows: SnapRow[], keys: RowKeys, state: EntityState, kind: SnapRow['kind'], name?: string, key?: string): SnapRow {
  const row: SnapRow = { id: state.id, kind, x: state.x, y: state.y, state, name, key: key ?? keys.internKey(state.id, JSON.stringify(state)) };
  rows.push(row);
  return row;
}
