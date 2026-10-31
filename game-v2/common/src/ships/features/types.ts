/**
 * Part features (features/README.md): one object per behaviour a part can
 * give a ship (a Tow Beam's tow, a Burst Strafer's dodge, ...), in place of
 * special cases spread over rebuild.ts, energy.ts, flight.ts and the UI.
 *
 * TYPE-ONLY: this file must never import a value (only `import type`), so
 * rebuild.ts, energy.ts and flight.ts can name these types without an import
 * cycle (registry.test.ts checks it).
 */

import type { Blueprint, FunctionDef, MaterialDef } from '../types.js';
import type { Catalog } from '../catalog.js';
import type { ShipTuning, WeaponTuning } from '../tuning.js';
import type { PlacedGeom, PartMount } from '../grid.js';
import type { ShipDerived } from '../rebuild.js';
import type { PowerLayout } from '../circuits.js';
import type { GunLoadShip } from '../energy.js';
import type { FlightBody, FlightControls, FlightConstants } from '../flight.js';

/**
 * What features add to a rebuild (`derived.fx`): each feature declares its own
 * key by declaration merging from its folder,
 * `declare module '../types.js' { interface FeatureDerived { tow?: TowInfo } }`.
 */
export interface FeatureDerived {}

/** Per-feature contract options (runPartContract, CUT 10): merged in the same way */
export interface ContractSpec {}

/** A rebuild's view for a feature's derive(): everything per part, by part index */
export interface DeriveCtx {
  catalog: Catalog;
  tuning: ShipTuning;
  blueprint: Blueprint;
  fns: readonly FunctionDef[];
  mats: readonly MaterialDef[];
  area: readonly number[];
  geoms: readonly PlacedGeom[];
  /** Where each part points out (null: no facing) */
  mounts: readonly (PartMount | null)[];
  /** Connected to the root and intact */
  alive: readonly boolean[];
  /** Per part, after the power networks (rebuild.ts step 4) */
  satisfaction: readonly number[];
  /** The live parts this feature applies to, in part order */
  parts: readonly number[];
  /** Where the feature writes what it derived (`out.<its key>`) */
  out: FeatureDerived;
}

/** The ship a load() hook draws for: what energy.ts gunLoad gets */
export type LoadShip = GunLoadShip;

/**
 * Where a flight hook runs inside stepFlight (flight.ts), in tick order:
 *   preJump     before the jump drive steps (the body as last tick left it)
 *   steer       after the ship turns
 *   thrustGate  the movement keys read (`wantX/wantY`), before a spooling drive takes the engines and the power is settled:
 *               a hook may ask power for this tick in `load[feature]` (a Burst Strafer's dodge starts here)
 *   impulse     after the engines push, before gravity: `shares[feature]` is what it got (the dodge's push)
 *   damp        after gravity, before friction and the move
 * Every hook runs for every ship stepped, with the feature or not: a hook checks for itself (a ship that lost its
 * strafers mid-burst still winds the counter down).
 */
export type FlightPhase = 'preJump' | 'steer' | 'thrustGate' | 'impulse' | 'damp';

/**
 * One tick's flight, shared by every hook of a call (one module-level object in flight.ts, reset by field: never
 * allocated per tick, and not re-entrant: a hook must not step a ship). `scratch` carries what a feature's hooks hand
 * each other within the tick (a dodge's way, from thrustGate to impulse); a hook writes it every tick it runs.
 */
export interface FlightCtx {
  body: FlightBody;
  input: FlightControls;
  d: ShipDerived;
  tuning: ShipTuning;
  k: FlightConstants;
  /** The running hook's feature number (its index in `load` and `shares`) */
  feature: number;
  /** The hold's mass (body.cargo, 0 when absent) */
  cargo: number;
  /** The way the movement keys ask this tick, world space, not normalised (0, 0: none); set from thrustGate on */
  wantX: number;
  wantY: number;
  /** The jump drive is spooling (it takes the engines); set from thrustGate on */
  charging: boolean;
  /** The ship's power is accounted this tick (energy.ts powerTick runs: not for replicas and pilotless ships) */
  accounted: boolean;
  /** thrustGate: what a feature draws this tick, per feed group (per second), by feature number (energy.ts PowerUse.extra); count what you set in `loads` */
  load: (ArrayLike<number> | undefined)[];
  loads: number;
  /** impulse on: the share of that draw each feature got (undefined: none asked, or not accounted: take it as 1) */
  shares: readonly (number | undefined)[] | undefined;
  scratch: { [name: string]: number | boolean };
}

export interface FlightHook {
  phase: FlightPhase;
  /** Within a phase, lower first (ties by feature id) */
  order: number;
  step(ctx: FlightCtx): void;
}

/**
 * A pilot input a feature declares (the key binding, its control bit). A 'held' input travels as the boolean `name`:
 * in the input message (its binary flag is hand-packed in protocol.ts, whose flags are full), the server's Input
 * component (a ui8 field `name`, network/inputFields.ts INPUT_BOOLS), the controls a flight step reads (`input[name]`:
 * flightInputs.ts, replica.ts fill it from this table) and, with `ctlBit`, a replica's control bits.
 * Only 'held' is wired; the others are reserved.
 */
export interface InputDef {
  name: string;
  kind: 'held' | 'toggle' | 'signed';
  label: string;
  defaultKey: string;
  hint?: string;
  /** Its replica control bit (replica.ts CTL): must already be pinned in features.wire.json */
  ctlBit?: number;
}

/** Where a replicated value travels (features.wire.json pins its slot) */
export type ReplicaWhere = 'pilotExtra' | 'status' | 'keyframe' | 'ctl';

export interface ReplicaField {
  name: string;
  where: ReplicaWhere;
  /** 'self': only the pilot's own row; 'all': every client */
  who: 'self' | 'all';
  default: number;
}

/** One thing worth saying about a part (describePart, CUT 3) */
export interface Fact {
  feature: string;
  key: string;
  label: string;
  value: number | string;
  unit?: 'm' | 's' | '%' | 'power' | 'x';
  tier: 'headline' | 'stat' | 'detail' | 'warning';
  when?: 'always' | 'working';
  sentence?: string;
  /** Presentation variants a feature may author (UI only): a quieter closing clause after the sentence in a full tooltip, the text in a compact tooltip, the text as a card chip */
  dim?: string;
  short?: string;
  chip?: string;
  /** What this part's power draw applies to ('towing': a card says "draws 24 towing" instead of "draws 24") */
  drawWhen?: string;
}

/** A part for describe(): its function, and its material when placed */
export interface DescribeCtx {
  catalog: Catalog;
  tuning: ShipTuning;
  fn: FunctionDef;
  mat?: MaterialDef;
  /** Its cells (absent: the function on its own) */
  area?: number;
}

/**
 * A weapon kind a feature is the behaviour of (a Repair Beam's mending, a Point Defence turret's aim): picked by the
 * kind's tuning (`weapons.<kind>`), not by a function flag. The world half (server/src/ships/features/weapons.ts) hangs
 * its onFire / onTick hooks on the role's id.
 */
export interface WeaponRole {
  /** Unique within its feature */
  id: string;
  /** Does a gun with this (resolved) weapon tuning play the role? Pure, allocation-free: it runs for every gun every tick */
  applies(def: WeaponTuning | undefined): boolean;
}

export interface PartFeature {
  /** Unique, also its folder name under features/ */
  id: string;
  /** Which parts give a ship this feature (any predicate on the function: `fn => !!fn.tow`) */
  applies(fn: FunctionDef): boolean;
  /** A global feature: every ship has it, part or not (applies() then only picks the parts its derive() sees) */
  global?: boolean;
  /** Plan order: derive and load run lower first (ties by id) */
  order: number;
  /** It draws power by the tick while it works (as engines and guns do), not as a steady load at the rebuild. 'engine':
   * and Drive Cell banks touching it feed it as they do engines (circuits.ts: a Burst Strafer's) */
  burst?: boolean | 'engine';
  /**
   * Weapon-kind roles (see WeaponRole). A feature that is only this has `applies: () => false`: no function of its
   * own to give a ship, so it never enters `derived.fxMask`.
   */
  weapon?: readonly WeaponRole[];
  /** At the rebuild (rebuild.ts), after the cargo/scanner pass: write `c.out.<key>` */
  derive?(c: DeriveCtx): void;
  /** Each tick (energy.ts gunLoad): add what it draws this tick, per feed group, to `out` (allocation-free) */
  load?(ship: LoadShip, L: PowerLayout, out: number[]): void;
  /** Flight hooks (compiled per phase, called from stepFlight: FlightPhase) */
  flight?: readonly FlightHook[];
  /** What of a rebuild its flight hooks read, as text: replica.ts flightSignature folds it in, so a replica is re-keyed when it changes */
  flightKey?(d: ShipDerived): string;
  inputs?: readonly InputDef[];
  replicate?: readonly ReplicaField[];
  /** What to say about a part it applies to (UI only, may allocate) */
  describe?(c: DescribeCtx): Fact[];
  contract?: ContractSpec;
}
