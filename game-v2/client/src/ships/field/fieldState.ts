/**
 * The client's copy of the ship's field state (docs/design/field-fabrication.md, 4.3): the last `fieldState` the server
 * sent (each machine, its job, the recycling queue, what the plan still needs) and the last parts it finished. The
 * client never predicts a job start, a finish or a placement: it waits for these two messages. Between them the job's
 * progress is worked out here from the machine's own clock (`jobAt`): the own-ship prediction's `machEu` for a powered
 * machine, the predicted tick for the core's own. So no progress is ever sent.
 */
import { MACHINE_FAB, MACHINE_REF, jobAt, jobFraction } from '@space-game/common';
import type { FieldJob, MachineKind, MachineView, ServerFieldDoneMessage, ServerFieldStateMessage, Charge } from '@space-game/common';

/** The own ship's clocks, as predicted now */
export interface FieldClocks {
  /** The pilot's predicted charge (its ports state carries `machEu` and `mach`) */
  charge: Charge;
  /** The predicted tick (the core's clock) */
  tick: number;
}

export const MACHINE_KINDS: readonly MachineKind[] = ['fabricator', 'refiner'];
/** The ports core's machine index of a kind */
export const machineIndex = (kind: MachineKind): number => (kind === 'fabricator' ? MACHINE_FAB : MACHINE_REF);

/**
 * A machine's clock now: a powered machine's (tier 1 and up) `machEu`; the core's own (tier 0) the tick, counted only
 * while it is switched on and not stalled (it has no draw to stop it, so the switch and the stall are what pause it).
 * `null`: its job is not moving
 */
export function machineClock(m: Readonly<MachineView>, clocks: FieldClocks): number | null {
  if (m.tier > 0) return clocks.charge.e?.machEu[machineIndex(m.kind)] ?? null;
  return m.on && !m.blocked ? clocks.tick : null;
}

/** A machine's job as it stands now (undefined: none). A job that isn't moving stays where the server left it */
export function machineJob(m: Readonly<MachineView>, clocks: FieldClocks): FieldJob | undefined {
  if (!m.job) return undefined;
  const at = m.at ?? 0;
  const now = machineClock(m, clocks);
  return jobAt(m.job, at, now === null ? at : Math.max(at, now));
}

/** A job's progress now, 0..1 (both phases) */
export function machineProgress(m: Readonly<MachineView>, clocks: FieldClocks): number {
  const j = machineJob(m, clocks);
  return j ? jobFraction(j) : 0;
}

type Listener = () => void;

export class FieldClient {
  /** The last `fieldState` (null before the first, or after a respawn into another ship) */
  state: ServerFieldStateMessage | null = null;
  /** The last part or batch a machine finished */
  lastDone: ServerFieldDoneMessage | null = null;
  private listeners = new Set<Listener>();
  /** Bumps on every message, so a drawer can tell it changed */
  version = 0;

  applyState(msg: ServerFieldStateMessage): void {
    this.state = msg;
    this.version++;
    this.emit();
  }

  /** A part or batch finished: remembered, and a short line to show (null: nothing worth saying) */
  applyDone(msg: ServerFieldDoneMessage, name: (item: string) => string): string | null {
    this.lastDone = msg;
    this.version++;
    this.emit();
    const what = name(msg.item);
    if (msg.to === 'ship') return `${what} built`;
    if (msg.to === 'cargo') return `${what} finished: in your cargo`;
    return `${what} finished: waiting for room in your cargo`;
  }

  machine(kind: MachineKind): MachineView | undefined {
    return this.state?.machines.find((m) => m.kind === kind);
  }

  private recycleSet: Set<number> | null = null;
  private recycleFor: ServerFieldStateMessage | null = null;

  /** The standing parts queued for recycling (uids), cached per message */
  recycleUids(): ReadonlySet<number> {
    if (this.recycleFor !== this.state) {
      this.recycleFor = this.state;
      this.recycleSet = new Set(this.state?.recycle ?? []);
    }
    return this.recycleSet ?? EMPTY;
  }

  /** The job building (or repairing) a part, by its blueprint uid */
  jobFor(uid: number): { m: MachineView; job: FieldJob } | undefined {
    for (const m of this.state?.machines ?? []) if (m.job && m.job.uid === uid && m.job.kind !== 'refine') return { m, job: m.job };
    return undefined;
  }

  /** Forget everything (left the game, or the ship changed under it) */
  reset(): void {
    this.state = null;
    this.lastDone = null;
    this.recycleSet = null;
    this.recycleFor = null;
    this.version++;
    this.emit();
  }

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}

const EMPTY: ReadonlySet<number> = new Set();

/** The one copy (the game has one ship of its own) */
export const fieldClient = new FieldClient();
