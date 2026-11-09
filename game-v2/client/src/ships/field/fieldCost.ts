/**
 * The world build view's cost readout: what the missing parts of the working design (planned and shot off, not the
 * disconnected ones, plus the unsaved edits) need against the hold, and about how long the fabricator takes. Pure
 * computation is in build/planCost; this picks the parts and the machine.
 */
import type { PlacedPart } from '@space-game/common';
import { fieldClient } from './fieldState';
import { packModeOf } from './fieldText';
import type { WorkingDesign } from './plan';
import type { FieldDeps } from './bridge';
import { planCost, withMachine, type CostReadout } from '../build/planCost';
import { fieldReadoutHtml } from '../build/planCostView';

/** The parts the fabricator would build from this design: not standing, not being recycled, joined to the core */
export function missingParts(w: WorkingDesign, unjoined: ReadonlySet<number>): PlacedPart[] {
  return w.bp.parts.filter((p, i) => !w.standing[i] && p.fn !== 'core' && !w.marked.has(p.uid) && !unjoined.has(p.uid));
}

export function fieldCost(deps: FieldDeps, w: WorkingDesign, unjoined: ReadonlySet<number>): CostReadout {
  const m = fieldClient.machine('fabricator');
  const r = planCost(deps.econ, missingParts(w, unjoined), { tier: m?.tier ?? 0, have: (id) => deps.have(id), mode: m ? packModeOf(m) : 'off' });
  return withMachine(r, m);
}

export function fieldCostHtml(deps: FieldDeps, w: WorkingDesign, unjoined: ReadonlySet<number>): string {
  return fieldReadoutHtml(fieldCost(deps, w, unjoined), (id) => deps.econ.items.name(id));
}
