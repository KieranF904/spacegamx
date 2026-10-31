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
import type { ShipTuning } from '../tuning.js';
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

/** Where a flight hook runs inside stepFlight (CUT 5 wires these; until then they are compiled, not called) */
export type FlightPhase = 'preJump' | 'steer' | 'thrustGate' | 'impulse' | 'damp';

/**
 * One tick's flight, shared by every hook of a call (one object per call site,
 * reset by field: never allocated per tick). `scratch` carries the named
 * multipliers features write and stepFlight composes in a fixed order.
 */
export interface FlightCtx {
  body: FlightBody;
  input: FlightControls;
  d: ShipDerived;
  k: FlightConstants;
  scratch: { [name: string]: number | boolean };
}

export interface FlightHook {
  phase: FlightPhase;
  /** Within a phase, lower first (ties by feature id) */
  order: number;
  step(ctx: FlightCtx): void;
}

/** A pilot input a feature declares (the key binding, its control bit) */
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

export interface PartFeature {
  /** Unique, also its folder name under features/ */
  id: string;
  /** Which parts give a ship this feature (any predicate on the function: `fn => !!fn.tow`) */
  applies(fn: FunctionDef): boolean;
  /** A global feature: every ship has it, part or not (applies() then only picks the parts its derive() sees) */
  global?: boolean;
  /** Plan order: derive and load run lower first (ties by id) */
  order: number;
  /** It draws power by the tick while it works (as engines and guns do), not as a steady load at the rebuild */
  burst?: boolean;
  /** At the rebuild (rebuild.ts), after the cargo/scanner pass: write `c.out.<key>` */
  derive?(c: DeriveCtx): void;
  /** Each tick (energy.ts gunLoad): add what it draws this tick, per feed group, to `out` (allocation-free) */
  load?(ship: LoadShip, L: PowerLayout, out: number[]): void;
  /** Flight hooks (compiled per phase; called from stepFlight from CUT 5 on) */
  flight?: readonly FlightHook[];
  inputs?: readonly InputDef[];
  replicate?: readonly ReplicaField[];
  /** What to say about a part it applies to (UI only, may allocate) */
  describe?(c: DescribeCtx): Fact[];
  contract?: ContractSpec;
}
