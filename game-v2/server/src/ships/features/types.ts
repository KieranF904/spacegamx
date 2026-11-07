/**
 * Server half of a part feature (common/src/ships/features/README.md): the world-side behaviour a feature has beyond
 * what the shared simulation does (a Tow Beam's tether, a Warmth's cold). A feature's folder
 * `server/src/ships/features/<id>/index.ts` exports `serverFeature`; the generated `index.ts` lists them.
 *
 * TYPE-ONLY imports: GameServer builds the host, features only name types.
 */
import type { IWorld } from 'bitecs';
import type { Bag, Economy, PlayerProfile, ServerMessage, ShipTuning, ShipState, TowKind, WeaponInfo, WeaponTuning } from '@space-game/common';
import type { WeaponBridge } from '../bridge/core.js';
import type { ShipBridge } from '../ShipBridge.js';
import type { LootPods } from '../../game/LootPods.js';

// ------------------------------------------------------------------------------------------------ capabilities
// What a feature may ask of the game, in small sets. A feature names the ones it needs as its host type (ClampHost =
// WorldCap & TellCap & ...; its constructor takes that), so its whole dependency surface is one line and tsc holds it
// to it. GameServer builds one object with all of them (FeatureHost). A feature that needs more adds a member to the
// set it belongs in (or a new set), never by importing GameServer. Where a feature reads the ships, it names the
// bridge calls it uses (ShipsOf<'get' | ...>), not the whole ShipBridge.

/** The world, the tuning and the clock */
export interface WorldCap {
  readonly world: IWorld;
  readonly tuning: ShipTuning;
  getTick(): number;
}

/** The ships: the whole bridge (GameServer's side). A feature names the calls it uses instead: ShipsOf<'get' | 'has'> */
export interface ShipsCap {
  readonly ships: ShipBridge;
}
export interface ShipsOf<K extends keyof ShipBridge> {
  readonly ships: Pick<ShipBridge, K>;
}

/** Telling pilots: a toast, a message, an effect everyone near sees, and who is in a system */
export interface TellCap {
  /** A toast for one pilot */
  tell(pilot: number, text: string, color?: string): void;
  /** A message to one pilot's client */
  send(pilot: number, msg: ServerMessage): void;
  /** An effect everyone in the entity's system sees, at the entity (a Flash Screen's bloom) */
  effect(eid: number, type: number): void;
  /** The pilots in the entity's system now (whoever may hold it: Docking Clamps' link records go to them) */
  pilotsIn?(eid: number): number[];
}

/** Stations and salvage */
export interface StationCap {
  readonly pods: LootPods;
  /** The station a pilot is within reach of (-1: none) */
  stationInRange(pilot: number): number;
  /** Berthed at a station */
  isDocked(pilot: number): boolean;
  /** Towed into a station's reach: salvage it for the pilot (and take it away): the Tow Beam's */
  deliver(pilot: number, target: number, kind: TowKind): void;
}

/** The pilot's hold and profile (field machines: features/machines, docs/design/field-fabrication.md) */
export interface HoldCap {
  readonly econ: Economy;
  /** The pilot's profile (its `ship` is the live ship's record: blueprint, ghosts, field); undefined: no pilot there */
  profile(pilot: number): PlayerProfile | undefined;
  /** The profile changed: save it in time */
  markDirty(pilot: number): void;
  /**
   * The live ship's record changed what the pilot's hangar view shows (its design, its planned parts): send the pilot its
   * hangar again (the ship itself goes by its sync; the hangar and station windows read the record)
   */
  recordChanged?(pilot: number): void;
  /** How many of an item the hold has */
  holdCount(pilot: number, id: string): number;
  /** Take items from the hold, all or nothing */
  holdTake(pilot: number, items: Bag): boolean;
  /** Put items in the hold as far as there's room (by volume); returns what didn't fit */
  holdGive(pilot: number, items: Bag): Bag;
  /** Room left in the hold, in volume units */
  holdRoom(pilot: number): number;
}

/** The repair bank and free building */
export interface BankCap {
  /** Dev servers: this pilot builds without licences or build points (Hangar's freeBuild) */
  freeBuild?(pilot: number): boolean;
  /** The repair bank's free spare the pilot's repairs may use (bank.ts freeSpare), and spending from it (package B) */
  bankSpare?(pilot: number): Bag;
  spendBankSpare?(pilot: number, bill: Bag): boolean;
}

/** Who may hurt whom, parties, and what a pilot's client holds (the Mine Bay: who sets mines off, who is told) */
export interface RulesCap {
  /** May `attacker` hurt `target` (GameServer.canDamage: PvP zones; berthed ships, wards and people's craft are out of it) */
  canDamage?(attacker: number, target: number): boolean;
  /** Two pilots fly in one party */
  sameParty?(a: number, b: number): boolean;
  /** The ships this pilot's client holds (its connection's ship view); undefined: no client */
  shipView?(pilot: number): ReadonlySet<number> | undefined;
}

/** Everything a feature may be given: what GameServer builds (each feature takes only its own sets of it) */
export interface FeatureHost extends WorldCap, ShipsCap, TellCap, StationCap, HoldCap, BankCap, RulesCap {}

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
  /** A ship's shield broke: it held something and now holds nothing (a hit, a blast or an EMP took the last of it) */
  onShieldBreak?(eid: number): void;
  /** An entity left the world (every per-entity table of the feature should forget it) */
  onLeave?(eid: number): void;
  // ---- The game's events, each fired by the code that knows (no feature polls the ECS or the input arrays for them).
  // They may come at any point of a tick: a feature that acts on one in its own tick keeps a note and reads it there.
  /** A pilot's ship was destroyed: its health ran out (GameServer's player deaths) */
  onDied?(eid: number): void;
  /** A pilot berthed at a station (game/Docking.ts handleDock) */
  onBerthed?(eid: number): void;
  /** An input that holds the jump key was applied to a pilot (net/handlers/flight.ts applyInputToEntity): it asks its drive to jump */
  onJumpKey?(eid: number): void;
}

/**
 * What a weapon-kind role does inside the bridge's gun step (PartFeature.weapon, common features/types.ts WeaponRole;
 * flattened once by weapons.ts). Both hooks run for every ship that fires, every tick: allocation-free.
 */
export interface ServerWeaponHooks {
  /** onFire: a held beam whose kind plays the role fires this way instead of the damaging beam. Returns how far along it stopped (0..1) */
  onFire?(b: WeaponBridge, eid: number, ship: ShipState, w: WeaponInfo, def: WeaponTuning): number;
  /** onTick: once a tick after the guns' tick, whatever the trigger, for the whole ship (it picks its own guns out) */
  onTick?(b: WeaponBridge, eid: number, ship: ShipState, pose: { x: number; y: number; angle: number }, def: (w: WeaponInfo) => WeaponTuning): void;
}

export interface ServerFeature {
  /** Same id as the PartFeature it serves */
  id: string;
  create(host: FeatureHost): FeatureInstance;
  /** Hooks for the weapon roles of the PartFeature with this id, by role id */
  weapon?: Readonly<Record<string, ServerWeaponHooks>>;
}
