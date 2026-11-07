/**
 * What the field-fabrication client needs from the game, and where its parts meet (the `machines` client feature, the
 * HUD, the build overlay). ShipClient mounts it once (mount.ts); the feature reads it each frame. A module-level
 * object, as viewMode and cameraView are: the feature hooks get only the ClientFeatureHost.
 */
import type { Catalog, ShipTuning, Economy, ClientMessage, ShipState } from '@space-game/common';
import type { InterpolatedEntity } from '../../state/GameState';
import type { FieldClocks } from './fieldState';
import type { FieldHud } from './FieldHud';
import type { FieldOverlay } from './FieldOverlay';

/** The camera, as the overlay moves it: the zoom, the helm view, and where a screen point is in the world */
export interface FieldView {
  zoom(): number;
  setZoom(z: number): void;
  helm(): boolean;
  setHelm(on: boolean): void;
  screenToWorld(x: number, y: number): { x: number; y: number };
}

export interface FieldDeps {
  catalog: Catalog;
  tuning: ShipTuning;
  econ: Economy;
  send(msg: ClientMessage): void;
  /** A line at the top of the screen */
  toast(text: string, kind?: 'info' | 'good' | 'warn' | 'bad'): void;
  /** The pilot's own ship and its entity (undefined: none, docked or dead) */
  ship(): ShipState | undefined;
  entity(): InterpolatedEntity | undefined;
  /** The own ship's clocks as predicted now */
  clocks(): FieldClocks;
  level(): number;
  learned(): string[];
  have(id: string): number;
  canMake(id: string): boolean;
  /** The flight keys reach the ship (no menu or hangar over the game) */
  flying(): boolean;
  view: FieldView;
}

export const fieldBridge: { deps: FieldDeps | null; hud: FieldHud | null; overlay: FieldOverlay | null } = {
  deps: null,
  hud: null,
  overlay: null,
};
