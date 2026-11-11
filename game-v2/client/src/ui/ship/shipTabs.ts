/**
 * @contract client.ui.ship.tabs
 * owns:       the Ship window's tab contract (ShipTab) and what every tab may read of the game (ShipCtx)
 * needs:      common types (ShipState, PlacedGeom, Charge, ClientMessage), PilotState, the status source's StatusInput
 * invariants: tab ids are unique and kept in their order; the window names no tab (a tab is a module and one line in
 *             SHIP_TAB_ORDER) — client/src/ui/ship/shipWindow.test.ts
 * extend:     a new tab is a module in ui/ship/tabs/ giving a ShipTab, its id in ShipTabId and a line in tabs/index.ts
 */

import type { Charge, ClientMessage, PlacedGeom, ShipState } from '@space-game/common';
import type { PilotState } from '../../econ/clientEcon';
import type { StatusInput } from '../shipStatus/source';
import type { RingGroup } from '../../ships/gunHud';

export type ShipTabId = 'status' | 'power' | 'weapons' | 'pickup' | 'refiner' | 'fabricator' | 'kills';

/** What a tab reads of the game (getters: built once, read at use) */
export interface ShipCtx {
  readonly pilot: PilotState;
  send(m: ClientMessage): void;
  sound(id: string): void;
  /** The ship you fly (null: none) and its parts' outlines */
  ship(): ShipState | null;
  geometry(ship: ShipState): PlacedGeom[];
  /** The ship status source's input (ui/shipStatus/source.ts) */
  statusInput(): StatusInput | null;
  /** The predicted ports state */
  charge(): Charge;
  /** Your guns by model (ships/gunHud.ts RingModel), as the weapon ring has them */
  groups(): readonly RingGroup[];
  /** The left and right buttons' groups (0: all) */
  selection(): { left: number; right: number };
  /** A part's display name by function id */
  fnName(fn: string): string;
  /** A key binding's key name */
  keyName(action: string): string;
  /** Docked at a station */
  docked(): boolean;
  /** The station's repair bank's free and deposited stock is in the station window: open it there */
  openStation(): void;
  /** Open another tab of the window */
  openTab(id: ShipTabId): void;
}

export interface ShipTab {
  readonly id: ShipTabId;
  readonly label: string;
  readonly title: string;
  /** Redraw this often (ms) while on show (live numbers); 0: only when asked */
  readonly live: number;
  /** Draw into the body (the tab chosen, or a live redraw) */
  render(body: HTMLElement, ctx: ShipCtx): void;
  /** The tab left the screen */
  hide?(): void;
}
