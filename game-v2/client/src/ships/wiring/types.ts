import type { Catalog, ClientMessage, ShipTuning } from '@space-game/common';
import type { GameState } from '../../state/GameState';
import type { PilotState } from '../../econ/clientEcon';

/** The slice of ShipClientOptions the feature and field wiring reads */
export interface ShipClientWiringOpts {
  catalog: Catalog;
  tuning: ShipTuning;
  pilot: PilotState;
  state: GameState;
  send(msg: ClientMessage): void;
  showMessage(text: string, color?: string): void;
  toast?(text: string, kind: 'info' | 'good' | 'warn' | 'bad'): void;
  inputEnabled?(): boolean;
  isKeyDown(code: string): boolean;
  zoom?: { get(): number; set(z: number): void };
}
