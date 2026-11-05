/**
 * The schematics, retired (Kieran, 2026-10-30): everything a pilot can make
 * opens at its level and nothing opens earlier, so no item teaches anything
 * and the schematic items are gone from the catalogue. A save is cleaned as it
 * loads (econ/profile.ts migrateProfile), so nothing points at a missing item:
 *
 * - a held boss-legendary schematic becomes that boss's artefact, the part the
 *   legendary is now made from (a schematic was the rarer prize, so it's kept
 *   as one);
 * - any other schematic is dropped;
 * - licences that no longer mean anything are dropped: every fn: licence but
 *   the core's (First Light teaches it) and every material: licence but a
 *   job's material's (leestone, the Ark's). Learned item recipes stay (a
 *   job's kit still needs its job).
 */

import { addTo, type Stack } from './stacks.js';
import { JOB_MATERIALS } from './market.js';

/** The legendary schematics and the artefact each became */
export const LEGENDARY_SCHEMATICS: Readonly<Record<string, string>> = {
  schematic_hive: 'rustjaw_cog',
  schematic_frostbite: 'frost_heart',
  schematic_prism: 'prism_shard',
  schematic_cinder_bloom: 'cinder_ember',
  schematic_phase: 'void_pearl',
  schematic_singularity: 'maw_fragment',
};

/** Licences still taught (by a job), and so still worth keeping */
const KEPT_LICENCES = new Set(['fn:core', ...JOB_MATERIALS.map((m) => `material:${m}`)]);

const isSchematic = (id: string) => id.startsWith('schematic_');

/** A list of stacks with its schematics gone (the legendary ones as their artefacts); the same list if it holds none */
export function retireStacks(list: Stack[]): Stack[] {
  if (!list.some((s) => isSchematic(s.id))) return list;
  const out: Stack[] = [];
  for (const s of list) {
    const to = isSchematic(s.id) ? LEGENDARY_SCHEMATICS[s.id] : s.id;
    if (to) addTo(out, to, s.n);
  }
  return out;
}

/** Does a learned licence or recipe still mean anything */
export function licenceKept(id: string): boolean {
  return !(id.startsWith('fn:') || id.startsWith('material:')) || KEPT_LICENCES.has(id);
}

/** Clean a profile of the schematics: its hold, storage and quickbar, and the licences they taught */
export function retireSchematics(p: { cargo: Stack[]; storage: Stack[]; recipes: string[]; quickbar: (string | null)[] }): void {
  p.cargo = retireStacks(p.cargo);
  p.storage = retireStacks(p.storage);
  p.quickbar = p.quickbar.map((id) => (id && isSchematic(id) ? null : id));
  p.recipes = p.recipes.filter(licenceKept);
}
