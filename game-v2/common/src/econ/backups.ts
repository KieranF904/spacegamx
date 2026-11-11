/**
 * Backup ships (docs/design/death-rework-2026-11.md): a death loses the ship, and the pilot comes back in a backup. The
 * starter is always one (free, as many times as it takes); a ship of their own is one if it is no more than the
 * starter's build points times `costShare` (data/rules.json death.backupCost), has no part above the starter's grade,
 * and every part is one a level 0 pilot may fit. Pure, so the server's offer and any client hint agree.
 */

import type { Blueprint } from '../ships/types.js';
import type { Catalog } from '../ships/catalog.js';
import { buildPoints, partGrade } from '../ships/grades.js';
import { partLicensed } from './market.js';
import { partItemId } from './items.js';

/** A ship's tier: its highest part grade (Mk I-V) */
export function shipTier(catalog: Catalog, bp: Blueprint): number {
  let t = 0;
  for (const q of bp.parts) t = Math.max(t, partGrade(catalog, q));
  return t;
}

/** Why a design can't be a backup (null: it can) */
export function backupRefusal(catalog: Catalog, bp: Blueprint, starter: Blueprint, costShare: number): string | null {
  const cap = buildPoints(catalog, starter) * costShare;
  if (buildPoints(catalog, bp) > cap + 1e-9) return `costs more than ${Math.floor(cap)} build points`;
  if (shipTier(catalog, bp) > shipTier(catalog, starter)) return 'has parts above the starter\'s grade';
  if (bp.parts.some((q) => q.fn !== 'core' && !partLicensed(q, [], 0))) return 'has parts a new pilot can\'t fit';
  return null;
}

/** Is this the starter design itself (the same parts in the same places): losing it loses nothing worth a plan */
export function isStarterDesign(bp: Blueprint, starter: Blueprint): boolean {
  if (bp.parts.length !== starter.parts.length) return false;
  const key = (q: Blueprint['parts'][number]) => `${partItemId(q)}@${q.x},${q.y},${q.rot},${q.flip ? 1 : 0}`;
  const want = new Map<string, number>();
  for (const q of starter.parts) want.set(key(q), (want.get(key(q)) ?? 0) + 1);
  for (const q of bp.parts) {
    const k = key(q), n = want.get(k) ?? 0;
    if (n <= 0) return false;
    want.set(k, n - 1);
  }
  return true;
}
