/**
 * Where players' refitted ships are kept between sessions. Keyed by account
 * (guests have no account, so their refits last for the session only).
 */

import type { Blueprint } from '@space-game/common';

export interface ShipStorage {
  load(key: string): Blueprint | null;
  save(key: string, blueprint: Blueprint): void;
}

export function accountShipKey(userId: number): string {
  return `user-${userId}`;
}
