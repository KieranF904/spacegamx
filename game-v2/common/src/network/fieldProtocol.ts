/**
 * @contract protocol.field
 * owns:       the field fabrication and repair bank messages: plans saved, machines switched, jobs done, bank changed
 *             (job progress is never sent)
 * needs:      type-only import of ships/types (Blueprint); econ/field jobs for the clock
 * invariants: every client-sent type here is one the server dispatches, and the set of dispatched types is pinned by
 *             name — server/src/golden/structure.test.ts
 *             the server types the client handles itself are exactly the pinned set (a type with no entry in the
 *             client table fails) — client/src/app/serverMessages.test.ts
 * extend:     a new message is an interface plus a member of this area's client / server union below; then its
 *             handler (server/src/net/handlers) or its entry in client/src/app/serverMessages.ts, and the golden pins
 *             (UPDATE_GOLDEN=1 on structure.test.ts)
 */

/**
 * Field fabrication and the repair bank on the wire (docs/design/field-fabrication.md, "Protocol"). JSON messages, all
 * of them decisions or rare events: a plan saved, a machine switched, a job started or finished, the bank changed. A
 * job's progress is never sent: both sides step it by the machine's own clock (econ/field/jobs.ts jobAt; a powered
 * machine's clock is PortsState.machEu, which the own-ship sync already carries).
 */

import type { Blueprint } from '../ships/types.js';
import type { Bag } from '../econ/stacks.js';
import type { FieldJob } from '../econ/field/jobs.js';
import type { MachineKind } from '../econ/field/rules.js';
import type { PackMode } from '../econ/field/packs.js';

// ============================================ client -> server

/**
 * Save the build view's edit of the ship's blueprint: `blueprint` is the design the pilot wants (validated as a hangar
 * edit is). Parts that keep their uid and placement stay; standing parts left out are queued for recycling (they stand
 * until broken down); missing parts left out go; new parts come in missing, built by the same repair path as a part shot
 * off. Free: only building costs
 */
export interface ClientFieldPlanMessage { type: 'fieldPlan'; blueprint: Blueprint }

/** The ship as it stands: every missing part (planned or lost) leaves the blueprint, the recycling queue empties */
export interface ClientFieldPlanClearMessage { type: 'fieldPlanClear' }

/**
 * A machine's switches (the ship's fabricator or refiner: its part's, or the core's own when it has none): on/off (any time, mid-fight too), how the fabricator may use packs from the hold, and what the
 * refiner refines (`recipe`: a refining recipe id, or null: what the plan is short of, from the hold's ore; `refine`: its
 * auto list, recipe ids it refines in this order once the plan needs nothing it can make, [] to clear)
 */
export interface ClientMachineMessage { type: 'machine'; kind: MachineKind; on?: boolean; packs?: PackMode; recipe?: string | null; refine?: string[] }

/**
 * The fabricator's order of work (the Ship window's Fabricator tab): `top` puts a part (blueprint uid) first in its
 * priority list (FieldRecord.first: worked before the usual order whenever it can be), `hold` leaves a part alone until
 * `resume` (a job under way on it is called off, its inputs back to the hold), `clear` empties the priority list
 */
export interface ClientFieldOrderMessage { type: 'fieldOrder'; action: 'top' | 'hold' | 'resume' | 'clear'; uid?: number }

/** Call off a machine's job under way (its inputs go back to the hold, or wait in the machine while the hold is full) */
export interface ClientFieldCancelMessage { type: 'fieldCancel'; kind: MachineKind; job: number }

/** Recycle standing parts (or, `cancel`, take them off the queue): the same as leaving them out of a saved plan */
export interface ClientFieldRecycleMessage { type: 'fieldRecycle'; uids: number[]; cancel?: boolean }

/** At a station: put packs and refined materials from the hold or storage into the repair bank (never withdrawn) */
export interface ClientBankDepositMessage { type: 'bankDeposit'; items: Bag; from?: 'cargo' | 'storage' }

/** Dev servers only (never production; the server refuses it elsewhere): fill or empty the bank's free part, clear or grant deposits */
export interface ClientDevBankMessage { type: 'devBank'; action: 'fill' | 'empty' | 'clearDeposits' | 'grant'; items?: Bag }

export type FieldClientMessage = ClientFieldPlanMessage | ClientFieldPlanClearMessage | ClientMachineMessage | ClientFieldCancelMessage
  | ClientFieldRecycleMessage | ClientFieldOrderMessage | ClientBankDepositMessage | ClientDevBankMessage;

// ============================================ server -> client

/** Why a machine is idle with its switch on */
export type MachineBlock =
  /** A finished item waits inside it for room in the hold (cargo full): nothing is lost */
  | 'cargo'
  /** The next job's materials aren't in the hold */
  | 'materials'
  /** Everything left needs a better machine (grade cap) */
  | 'grade'
  /** Nothing to do */
  | 'idle';

/**
 * One of the ship's two machines. A ship without a working fabricator (refiner) part has the core's own (tier 0: slow,
 * starter grade, no power drawn) in its place, so `kind` is always one of each
 */
export interface MachineView {
  kind: MachineKind;
  /** Its tier (0: the core's own) and the part's blueprint uid (-1: the core's own) */
  tier: number;
  uid: number;
  on: boolean;
  /** Drawing power this tick (on, and a job it can run): PortsState.mach's bit */
  drawing: boolean;
  packs?: PackMode;
  /** The refiner's chosen recipe (absent: auto) */
  recipe?: string;
  /** The refiner's auto list (FieldRecord.refine) */
  refine?: string[];
  /** The fabricator's priority list and the parts it holds off (FieldRecord.first, paused: uids) */
  first?: number[];
  paused?: number[];
  job?: FieldJob;
  /** Its clock when `job` was copied: machEu (a powered machine) or the tick (the core) */
  at?: number;
  /** Finished output waiting inside it (cargo full) */
  holding?: Bag;
  blocked?: MachineBlock;
}

/**
 * The ship's field state, sent when it changes (a decision applied, a job started, finished or called off, a part
 * placed): every machine, the plan's recycling queue and what the plan still needs. `tick`: the server tick it holds at
 */
export interface ServerFieldStateMessage {
  type: 'fieldState';
  tick: number;
  machines: MachineView[];
  /** Standing parts queued for recycling (uids) */
  recycle: number[];
  /** What the planned and missing parts still need, all told (what the hold is short of: the HUD's list) */
  short?: Bag;
}

/** A part finished: placed on the ship (its uid), or put in the hold (another spot didn't want it), or kept in the machine (hold full) */
export interface ServerFieldDoneMessage { type: 'fieldDone'; kind: MachineKind; job: number; item: string; to: 'ship' | 'cargo' | 'machine'; uid?: number }

/** The repair bank: sent at login, on a change and while it refills (at most once a minute) */
export interface ServerRepairBankMessage {
  type: 'repairBank';
  /** The free part (whole units) and its cap (BANK.ships starter ships' worth) */
  free: Bag;
  cap: Bag;
  /** Seconds until the free part is full (0: full) */
  fullIn: number;
  /** What the free part may give repairs now (freeSpare: all of it, for level 0 parts) */
  spare: Bag;
  deposits: Bag;
  /** (Before the death rework: parts the deposits were rebuilding after a respawn. Never sent now) */
  rebuilding?: number;
}

export type FieldServerMessage = ServerFieldStateMessage | ServerFieldDoneMessage | ServerRepairBankMessage;
