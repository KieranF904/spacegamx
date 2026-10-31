/**
 * Client half of a part feature (common/src/ships/features/README.md): its key bindings, what it reads from the pilot's
 * row, how it draws on a ship, and its HUD chip. A feature's folder `client/src/ships/features/<id>/index.ts` exports
 * `clientFeature`; the generated `index.ts` lists them.
 *
 * TYPE-ONLY imports here: the feature folders may import anything, this file must not make a cycle.
 */
import type { ClientMessage, ShipState, Catalog, PlacedGeom } from '@space-game/common';
import type { Container } from 'pixi.js';
import type { ActionDef } from '../../input/keybindings';
import type { InterpolatedEntity } from '../../state/GameState';

/** What a client feature may ask of the game (ShipClient builds it once) */
export interface ClientFeatureHost {
  readonly catalog: Catalog;
  readonly playerId: () => number;
  readonly entity: (eid: number) => InterpolatedEntity | undefined;
  readonly ship: (eid: number) => ShipState | undefined;
  readonly send: (msg: ClientMessage) => void;
  readonly showMessage: (text: string, color?: string) => void;
  /** The key an action is bound to, as shown to the player */
  readonly keyName: (actionId: string) => string;
  readonly hangarOpen: () => boolean;
}

/** Per-frame drawing of one ship (ShipRenderer calls every feature's drawShip for each body, in id order) */
export interface ShipDrawCtx {
  eid: number;
  ship: ShipState;
  entity: InterpolatedEntity;
  /** The ship's own container (over the hull) */
  container: Container;
  /** Cell size, world units */
  cs: number;
  now: number;
  /** The layer over every ship's hull, shared by all ships (for effects drawn afresh each frame: add your own child once) */
  shared: Container;
  /** A ship's parts, placed (the renderer's cached geometry) */
  geometry(ship: ShipState): PlacedGeom[];
}

/** A HUD chip: updated once a frame (null state hides it) */
export interface IndicatorDef {
  update(host: ClientFeatureHost): void;
}

export interface ClientFeature {
  /** Same id as the PartFeature it serves */
  id: string;
  /** Key bindings, merged into keybindings.ts ACTIONS at module load (ids must be new) */
  actions?: readonly ActionDef[];
  /** A bound key was pressed (default key code, as ShipClient.onKey gets it); true: used */
  onKey?(code: string, host: ClientFeatureHost): boolean;
  /** Read this feature's values from the pilot's row (`data`, from `at` = its first pilotExtra index) into `fx` */
  parsePilot?(data: number[], at: number, fx: { [name: string]: number }): void;
  /** Once a frame before any ship is drawn (clear what drawShip adds to the shared layer) */
  beginFrame?(shared: Container, host: ClientFeatureHost): void;
  drawShip?(ctx: ShipDrawCtx, host: ClientFeatureHost): void;
  indicator?: IndicatorDef;
}
