/**
 * Client half of a part feature (common/src/ships/features/README.md): its key bindings, what it reads from the pilot's
 * row, how it draws on a ship, and its HUD chip. A feature's folder `client/src/ships/features/<id>/index.ts` exports
 * `clientFeature`; the generated `index.ts` lists them.
 *
 * TYPE-ONLY imports here: the feature folders may import anything, this file must not make a cycle.
 */
import type { ClientMessage, ShipState, Catalog, PlacedGeom, Charge, SearchShips } from '@space-game/common';
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
  /** A ship's side as this client knows it (hitRules.ts SIDE bits) */
  readonly side?: (id: number) => number;
  /** A ship's exact pose at the end of a tick on the tick-faithful layer (its replica); null: none */
  readonly exactAt?: (id: number, tick: number) => { x: number; y: number } | null;
  /** A ship's structure as it was on a tick (ShipStore.asOf: before a rebuild in the window, the one before) */
  readonly shipAt?: (id: number, tick: number) => ShipState | undefined;
}

/**
 * A snapshot window as it is searched on the tick-faithful layer (ships/hits/SelfHits.detect): the ticks after
 * `from` up to `to`, and the ships whose poses are exact in it (null: not searched here; the server tells all of it)
 */
export interface TickWindow { from: number; to: number; ships: SearchShips | null }

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
  /** A snapshot window searched (once its told records are in): what this feature works out on the tick layer */
  onWindow?(win: TickWindow, host: ClientFeatureHost): void;
  /** Its line on the ship status panel (ui/shipStatus: a Burst Strafer's dodge, ready or cooling); null: none now */
  status?(host: ClientFeatureHost): FeatureStatusLine | null;
}
