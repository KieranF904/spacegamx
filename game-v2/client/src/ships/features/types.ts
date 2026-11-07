/**
 * Client half of a part feature (common/src/ships/features/README.md): its key bindings, what it reads from the pilot's
 * row, how it draws on a ship, and its HUD chip. A feature's folder `client/src/ships/features/<id>/index.ts` exports
 * `clientFeature`; the generated `index.ts` lists them.
 *
 * TYPE-ONLY imports here: the feature folders may import anything, this file must not make a cycle.
 */
import type { ClientMessage, ShipState, Catalog, PlacedGeom, Charge } from '@space-game/common';
import type { Container } from 'pixi.js';
import type { ActionDef } from '../../input/keybindings';
import type { InterpolatedEntity } from '../../state/GameState';
import type { FeatureStatusLine } from '../../ui/shipStatus/source';

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
  /** A key held, by its default code (InputManager maps the player's binding onto it) */
  readonly isKeyDown: (code: string) => boolean;
  /** The flight keys reach the ship (not typing in chat, no menu over the game) */
  readonly inputEnabled: () => boolean;
  /** Flying at the helm (Q/E strafe, A/D turn) rather than mouse-steer */
  readonly helm: () => boolean;
  /** The pilot's charge as predicted (energy.ts) */
  readonly charge: () => Charge;
  /** Every entity drawn now, by id (a Docking Clamp's prompt looks for other pilots' clamps near it) */
  readonly entities?: () => ReadonlyMap<number, InterpolatedEntity>;
  /** World units a grid unit (tuning.cellSize) */
  readonly cellSize?: number;
  /** The drawing tick: the own ship's timeline (`own`) or the other ships' (their replicas') */
  readonly tick?: (own: boolean) => number;
  /** The system the client is in */
  readonly systemId?: () => string;
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
  /**
   * Its held inputs' values for this input tick, by input name (the shared feature's `inputs`: a Burst Strafer's
   * `dodge`), sent in the input message under that name. Called once per input tick, so it may latch and buffer.
   */
  controls?: Readonly<Record<string, (host: ClientFeatureHost) => boolean>>;
  /** A bound key was pressed (default key code, as ShipClient.onKey gets it); true: used */
  onKey?(code: string, host: ClientFeatureHost): boolean;
  /** Read this feature's values from the pilot's row (`data`, from `at` = its first pilotExtra index) into `fx` */
  parsePilot?(data: number[], at: number, fx: { [name: string]: number }): void;
  /** Once a frame before any ship is drawn (clear what drawShip adds to the shared layer) */
  beginFrame?(shared: Container, host: ClientFeatureHost): void;
  drawShip?(ctx: ShipDrawCtx, host: ClientFeatureHost): void;
  indicator?: IndicatorDef;
  /** Its line on the ship status panel (ui/shipStatus: a Burst Strafer's dodge, ready or cooling); null: none now */
  status?(host: ClientFeatureHost): FeatureStatusLine | null;
}
