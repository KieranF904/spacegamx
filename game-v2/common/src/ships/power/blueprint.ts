/**
 * A blueprint's energy layout input, built from its rebuild as P2's rebuild will (tools and tests that run a design on
 * the power core use this instead of copying it). Additive: nothing in the game calls it yet.
 */

import type { Blueprint } from '../types.js';
import type { Catalog } from '../catalog.js';
import type { ShipTuning } from '../tuning.js';
import { blueprintGeometry } from '../blueprint.js';
import { partMaterial } from '../grades.js';
import { createShipState } from '../state.js';
import type { EnergyLayoutInput } from './layout.js';

/** The layout input of a blueprint (also its rebuilt `derived`, for callers that want both) */
export function blueprintEnergyInput(catalog: Catalog, tuning: ShipTuning, bp: Blueprint): EnergyLayoutInput {
  const d = createShipState(catalog, tuning, 1, bp, 0).derived;
  const geoms = blueprintGeometry(catalog, bp);
  return {
    fns: bp.parts.map((p) => catalog.functions.get(p.fn)!), area: geoms.map((g) => g.area), mats: bp.parts.map((p) => partMaterial(catalog, p)),
    alive: d.alive, joins: d.joins, core: d.root >= 0 && bp.parts[d.root].fn === 'core' ? d.root : -1, tuning,
    // (today's interval divides by the old flow's satisfaction: undone here, as P2.1 drops it: EnergyWeaponInput.interval)
    weapons: d.weapons.map((w) => ({ part: w.part, fire: w.fire, interval: w.interval * Math.max(w.satisfaction, tuning.flow.minWeaponSatisfaction) })), geoms,
  };
}
