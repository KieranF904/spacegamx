/**
 * Server half of a part feature (common/src/ships/features/README.md): the world-side behaviour a feature has beyond
 * what the shared simulation does (a Tow Beam's tether, a Warmth's cold). A feature's folder
 * `server/src/ships/features/<id>/index.ts` exports `serverFeature`; the generated `index.ts` lists them.
 *
 * TYPE-ONLY imports: GameServer builds the host, features only name types.
 */
import type { IWorld } from 'bitecs';
import type { ShipTuning, TowKind } from '@space-game/common';
import type { ShipBridge } from '../ShipBridge.js';
import type { LootPods } from '../../game/LootPods.js';

/**
 * The narrow object a feature is given at construction (what Towing's constructor args were, lifted): the world, the
 * ships, and the few things it may ask of the game. A feature that needs more gets it added here, not by importing
 * GameServer.
 */
export interface FeatureHost {
  readonly world: IWorld;
  readonly ships: ShipBridge;
  readonly pods: LootPods;
  readonly tuning: ShipTuning;
  getTick(): number;
  /** A toast for one pilot */
  tell(pilot: number, text: string, color?: string): void;
  /** The station a pilot is within reach of (-1: none) */
  stationInRange(pilot: number): number;
  /** Berthed at a station */
  isDocked(pilot: number): boolean;
  /** Towed into a station's reach: salvage it for the pilot (and take it away): the Tow Beam's */
  deliver(pilot: number, target: number, kind: TowKind): void;
}

/** One message handler: the pilot's entity and the message (already past the drops and limits of net/dispatch.ts) */
export type FeatureMessageHandler = (eid: number, msg: any) => void;

/** What one feature does in the world; every member is optional and is flattened into arrays at construction */
export interface FeatureInstance {
  /** Once a tick, in the 'towing' tick entry's place (after the pilots fly, before wrecks and pods move) */
  tick?(): void;
  /** Client message types this feature handles (a type two features claim, or the game already handles, is refused at construction) */
  messages?: Readonly<Record<string, FeatureMessageHandler>>;
  /** Mass this pilot's ship carries because of it (added to the hold's: ShipBridge flight) */
  cargoMass?(eid: number): number;
  /** The pilot-row values it owns (features.wire.json pilotExtra order), written into `out` from index 0; returns how many */
  wire?(eid: number, out: number[]): number;
  /** Its value in the status row other pilots get (features.wire.json status) */
  status?(eid: number): number;
  /** A ship was rebuilt (parts lost, refit): re-check what depends on its parts */
  onShipRebuilt?(eid: number): void;
  /** An entity left the world (every per-entity table of the feature should forget it) */
  onLeave?(eid: number): void;
}

export interface ServerFeature {
  /** Same id as the PartFeature it serves */
  id: string;
  create(host: FeatureHost): FeatureInstance;
}
