/**
 * The words the field HUD shows, apart from the DOM so they are tested on their own. Plain and short.
 */
import { jobFraction, PACK_MODES } from '@space-game/common';
import type { FieldJob, FieldJobKind, MachineBlock, MachineKind, MachineView, PackMode } from '@space-game/common';

/** Why a machine that is switched on isn't working (the server's `blocked`) */
export function blockText(block: MachineBlock, kind: MachineKind = 'fabricator'): string {
  switch (block) {
    case 'cargo': return 'Output blocked: cargo full';
    case 'materials': return 'Short of materials';
    case 'grade': return kind === 'refiner' ? 'Needs a better refiner' : 'Needs a better fabricator';
    case 'idle': return 'Idle';
  }
}

const KIND_WORD: Record<MachineKind, string> = { fabricator: 'Fabricator', refiner: 'Refiner' };

/** "Fabricator T2", or "Core fabricator" for the core's own (tier 0) */
export function machineName(m: Pick<MachineView, 'kind' | 'tier'>): string {
  return m.tier > 0 ? `${KIND_WORD[m.kind]} T${m.tier}` : `Core ${m.kind}`;
}

const JOB_VERB: Record<FieldJobKind, string> = { build: 'Building', repair: 'Repairing', recycle: 'Recycling', refine: 'Refining', rearm: 'Making mines' };

/** "Building Pip 45%" */
export function jobText(job: Readonly<FieldJob>, name: (item: string) => string): string {
  const what = job.item ? name(job.item) : job.recipe ? name(job.recipe) : '';
  const pct = Math.floor(jobFraction(job) * 100);
  const phase = job.kind === 'build' && job.phase === 'attach' ? ' (attaching)' : '';
  return `${JOB_VERB[job.kind]}${what ? ` ${what}` : ''} ${pct}%${phase}`;
}

/**
 * One machine's status line. `job` is the job as it stands now (machineJob), not the copy the server sent. Off wins,
 * then a job, then why it is idle
 */
export function machineStatus(m: Readonly<MachineView>, job: Readonly<FieldJob> | undefined, name: (item: string) => string): string {
  if (!m.on) return job ? `Off · ${jobText(job, name)}` : 'Off';
  if (m.blocked && m.blocked !== 'idle') return blockText(m.blocked, m.kind);
  if (job) return jobText(job, name);
  return blockText(m.blocked ?? 'idle', m.kind);
}

export const PACK_MODE_TEXT: Record<PackMode, string> = { off: 'Packs: off', fill: 'Packs: fill gaps', prefer: 'Packs: first' };
export const PACK_MODE_LIST: readonly PackMode[] = PACK_MODES;

/** The pack mode a machine has (the server omits the default) */
export const packModeOf = (m: Pick<MachineView, 'packs'>): PackMode => m.packs ?? 'off';
