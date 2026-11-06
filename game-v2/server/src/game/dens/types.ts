/**
 * A boss den's features (systems.json `den`, common DenFeatureData): what each kind is given, and what it does. The
 * kinds are a registry (registry.ts); Dens.ts holds a system's features and steps them.
 */

import type { Bag, DenFeatureData, ServerMessage, Terrain } from '@space-game/common';
import type { ShipBridge } from '../../ships/ShipBridge.js';
import type { PayoutDice } from '../payoutDice.js';

export interface DenHost {
  tick(): number;
  readonly ships: ShipBridge;
  /** Systems with a den, and its features */
  systems(): { num: number; den: readonly DenFeatureData[] }[];
  /** The pilots flying in a system (alive, undocked) */
  players(num: number): number[];
  send(num: number, msg: ServerMessage): void;
  terrain(num: number): Terrain | null | undefined;
  /** Who a pilot is across reconnects (null: not a pilot) */
  who(eid: number): string | null;
  /** Items to a pilot's station storage, and told so */
  reward(eid: number, items: Bag, text: string): void;
  toast(eid: number, text: string, kind: 'info' | 'warn' | 'good' | 'bad'): void;
  /** The server's payout dice (payoutDice.ts): what a den pays rolls from these (none: a secret of the den's own) */
  readonly payout?: PayoutDice;
}

export interface DenFeature {
  /** Every tick, with the pilots flying in its system (none: it may rest) */
  tick(now: number, players: readonly number[]): void;
  /** A body took damage (from `source`) */
  onDamage?(eid: number, amount: number, source: number): void;
  /** The name of a body that is this feature's (a cache's crust) */
  nameOf?(eid: number): string | undefined;
}

export type DenFactory<D extends DenFeatureData = DenFeatureData> = (host: DenHost, num: number, data: D) => DenFeature;
