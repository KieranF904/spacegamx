/**
 * @contract ships.function-registry
 * owns:       what each part function is (weapon, needs a facing edge, joined facing), filled by loadCatalog
 * needs:      FunctionDef (ships/types) only; a leaf module so catalog.ts can register into it
 * invariants: the catalog registers every function flag it loads — common/src/ships/invariants.test.ts
 * extend:     a new function trait is a set filled in registerFunctionDefs, not a hand-kept list
 */

/**
 * What each part function is (weapon, needs a facing edge, legacy family), filled by loadCatalog. A leaf module
 * (types only) so catalog.ts can register into it without importing blueprint.ts; blueprint.ts re-exports it.
 */

import type { FunctionDef } from './types.js';

/**
 * Every weapon part function (they all fire out of a facing edge and can be
 * turret-mounted): the functions.json entries with a `weapon` kind. Filled by
 * loadCatalog (registerFunctionDefs), so it's empty until a catalog is loaded.
 */
export const WEAPON_FNS = new Set<string>();
export function isWeaponFn(fn: string): boolean {
  return WEAPON_FNS.has(fn);
}

/** Parts that point a facing edge out: weapons, engines (thrust), and any marked `facing` (mining lasers) */
const NEEDS_FACING = new Set<string>();
/** Parts whose facing edge must touch a part instead: a Diode (`oneWay`: its out side, energy-routing-impl.md §3.4) */
const JOINED_FACING = new Set<string>();

/** Every function by id, and the legacy functions of each family (licences: econ/market.ts) */
const FN_DEFS = new Map<string, FunctionDef>();
const LEGACY_OF = new Map<string, string[]>();

/** Note what each function is (called by loadCatalog) */
export function registerFunctionDefs(defs: Iterable<FunctionDef>, legacyFamily?: Map<string, string>): void {
  for (const f of defs) {
    FN_DEFS.set(f.id, f);
    if (f.weapon) WEAPON_FNS.add(f.id);
    if (f.oneWay) JOINED_FACING.add(f.id);
    else if (f.weapon || (f.thrust ?? 0) > 0 || f.facing) NEEDS_FACING.add(f.id);
  }
  if (legacyFamily) {
    LEGACY_OF.clear();
    for (const [fn, fam] of legacyFamily) LEGACY_OF.set(fam, [...(LEGACY_OF.get(fam) ?? []), fn]);
  }
}

/** Has any catalog registered its functions yet */
export function hasRegisteredFunctions(): boolean {
  return FN_DEFS.size > 0;
}

/** A function by id, from the last catalog loaded (for rules that have no catalog to hand: licences) */
export function registeredFunction(id: string): FunctionDef | undefined {
  return FN_DEFS.get(id);
}

/** What a part function looks and breaks like: a model's, the legacy function its family grew from (cannons: 'weapon'); anything else its own */
export function lookFn(fn: string): string {
  const f = FN_DEFS.get(fn);
  return f?.model && f.family ? LEGACY_OF.get(f.family)?.[0] ?? (f.family === 'plating' ? 'armor' : fn) : fn;
}

/** The legacy functions whose parts became a family's models (their licences still teach it) */
function legacyFunctionsOf(family: string): string[] {
  return LEGACY_OF.get(family) ?? [];
}

/** Does a part of this function carry a facing (whichever rule its edge keeps: partFacingRule) */
export function partNeedsFacing(fn: string): boolean {
  return NEEDS_FACING.has(fn) || JOINED_FACING.has(fn);
}

/**
 * What a part's facing edge must be: 'free' (nothing across it: guns, engines, mining lasers), 'joined' (a part
 * across it: a Diode's out side, which power leaves by), or null (it has no facing). Validation, migration and the
 * hangar's placement all ask this.
 */
export function partFacingRule(fn: string): 'free' | 'joined' | null {
  return JOINED_FACING.has(fn) ? 'joined' : NEEDS_FACING.has(fn) ? 'free' : null;
}
