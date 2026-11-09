/**
 * @contract common.ships.dev-only
 * owns:       the dev-only flag (`exclusive: "dev"` on a material, function, model or system): what it is and who may use it
 * needs:      Catalog, Blueprint (types only)
 * invariants: dev parts ship in production data, are listed to nobody, and only an admin's design may hold one — server/src/game/devParts.test.ts
 *             a boss's exclusive ('boss') is never a dev part: no one builds it — server/src/game/devParts.test.ts
 * extend:     a new dev-only thing is `"exclusive": "dev"` in its data file; nothing here changes
 */

import type { Blueprint } from './types.js';
import type { Catalog } from './catalog.js';

/** The `exclusive` value of a dev-only thing (data/ships/materials.json `dev_singularity`, data/dev/*.json systems) */
export const DEV_EXCLUSIVE = 'dev';

/** Is this thing dev-only (hidden from every listing, usable by admins alone)? */
export function isDevOnly(x: { exclusive?: string } | undefined | null): boolean {
  return x?.exclusive === DEV_EXCLUSIVE;
}

/** Does the design place a dev-only material or function? */
export function usesDevParts(catalog: Catalog, bp: Blueprint): boolean {
  return bp.parts.some((p) => isDevOnly(catalog.materials.get(p.material)) || isDevOnly(catalog.functions.get(p.fn)));
}

/** Is this part item id (part:<material>:<fn>:<piece>) made of a dev-only material or function? */
export function isDevPartId(catalog: Catalog, id: string): boolean {
  const m = /^part:([^:]+):([^:]+):([^:]+)$/.exec(id);
  return !!m && (isDevOnly(catalog.materials.get(m[1])) || isDevOnly(catalog.functions.get(m[2])));
}
