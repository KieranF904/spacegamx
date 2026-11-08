/**
 * @contract server.snapshot.rows
 * owns:       the row kinds' registry, in the order their rows go (players, ship bodies, mobs, projectiles, pods), and
 *             systemRows: every row of one system, built once per snapshot and shared by every client there
 * needs:      rows/keys (RowHost, RowKeys, SnapRow), rows/player, rows/bodies
 * invariants: rows go in ROW_KINDS order (the snapshot's entity order) — server/src/golden/frameHash.test.ts
 * extend:     a new row kind is one entry in ROW_KINDS below
 */
import type { RowHost, RowKeys, SnapRow } from './keys.js';
import { playerRows } from './player.js';
import { shipRows, mobRows, projectileRows, podRows } from './bodies.js';

export { playerQuery } from './player.js';
export { projectileQuery, droppedItemQuery } from './bodies.js';
export { RowKeys, type RowHost, type SnapRow } from './keys.js';

/** A row kind: pushes its rows of one system (its loop inside: one call per kind per system, never per entity) */
export type RowKind = (h: RowHost, keys: RowKeys, num: number, rows: SnapRow[]) => void;

/** The row kinds, in the order their rows go */
export const ROW_KINDS: readonly RowKind[] = [playerRows, shipRows, mobRows, projectileRows, podRows];

/**
 * What every client in a system sees moving: players, ship bodies, hostiles,
 * projectiles and loot pods. Built once per system per snapshot and shared by
 * every client there; each row's key is its serialised state, so a client is
 * only sent what changed since its last snapshot.
 *
 * Projectiles fly in straight lines, so their key leaves out the position:
 * one is sent when it's fired and again only if its course changes (missiles).
 */
export function systemRows(h: RowHost, keys: RowKeys, num: number): SnapRow[] {
  const rows: SnapRow[] = [];
  for (const kind of ROW_KINDS) kind(h, keys, num, rows);
  return rows;
}
