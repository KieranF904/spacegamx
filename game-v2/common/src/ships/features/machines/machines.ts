/**
 * Field machines (a part: functions `machine`): the fabricator and the refiner (docs/design/field-fabrication.md). Their
 * rules (speed, grade caps, work and costs) are econ/field/rules.ts, the one place they live; this is what a rebuild
 * derives for a ship that has one, and the words a part's card shows. The draw itself is the ports core's
 * (power/ports.ts: a tool that draws only while PortsState.mach has its bit), the jobs the server's.
 */

import type { FunctionDef } from '../../types.js';
import { FAB_TIERS, REFINE_TIERS, tierRule, type MachineKind } from '../../../econ/field/rules.js';

/** What a rebuild derives for a ship with a working field machine (`derived.fx.machines`): -1 none */
export interface MachinesInfo {
  /** The fabricator's part index and tier */
  fab: number;
  fabTier: number;
  /** The refiner's part index and tier */
  ref: number;
  refTier: number;
}

declare module '../types.js' {
  interface FeatureDerived { machines?: MachinesInfo }
}

export function machineOf(fn: FunctionDef): { kind: MachineKind; tier: number } | null {
  const m = fn.machine;
  return m && (m.kind === 'fabricator' || m.kind === 'refiner') ? { kind: m.kind, tier: Math.max(1, Math.min(3, Math.floor(m.tier))) } : null;
}

const MARK = ['', 'I', 'II', 'III', 'IV', 'V'];
export const markOf = (grade: number): string => `Mk ${MARK[Math.max(1, Math.min(5, grade))]}`;

/** The card's words for a machine of this kind and tier: speed against a Field Fabricator's (or a station's refining pace), its grade cap */
export function machineWords(kind: MachineKind, tier: number): { speed: number; cap: number; speedText: string; capText: string } {
  const r = tierRule(kind, tier);
  const speed = kind === 'fabricator' ? r.speed / FAB_TIERS[1].speed : r.speed / REFINE_TIERS[3].speed;
  const capText = r.gradeCap >= 5 ? 'any grade' : `up to ${markOf(r.gradeCap)}`;
  const speedText = kind === 'fabricator'
    ? (speed === 1 ? "a Field Fabricator's pace" : `${speed} times a Field Fabricator's pace`)
    : (speed === 1 ? "a station's pace" : `${speed} of a station's pace`);
  return { speed, cap: r.gradeCap, speedText, capText };
}
