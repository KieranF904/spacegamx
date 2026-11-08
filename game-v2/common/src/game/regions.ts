/**
 * A system's danger bands (systems.json `regions`): rings by distance from
 * its centre, innermost first. Inner Sol is `safe` (hostiles keep out of it,
 * and dying there costs little), its middle `contested`, its rim `hostile`.
 * Systems without regions are one band at their own danger.
 */

import type { StarSystemData, SystemRegionData } from '../data/schemas.js';
import { dhypot } from '../math/detTrig.js';

type RegionDanger = SystemRegionData['danger'];

/** The band a point is in (past the last band's edge: the last band) */
export function regionAt(sys: Pick<StarSystemData, 'regions'> | undefined, x: number, y: number): SystemRegionData | null {
  const list = sys?.regions;
  if (!list?.length) return null;
  const r = dhypot(x, y);
  for (const g of list) if (r <= g.outer) return g;
  return list[list.length - 1];
}

/** How far out the safe space reaches (0: nowhere's safe) */
export function safeRadius(sys: Pick<StarSystemData, 'regions'> | undefined): number {
  let out = 0;
  for (const g of sys?.regions ?? []) {
    if (g.danger !== 'safe') break;
    out = g.outer;
  }
  return out;
}

/** In the system's safe space */
export function inSafeSpace(sys: Pick<StarSystemData, 'regions'> | undefined, x: number, y: number): boolean {
  const r = safeRadius(sys);
  return r > 0 && dhypot(x, y) <= r;
}

/** Where a band starts (the previous one's edge) */
function regionInner(sys: Pick<StarSystemData, 'regions'> | undefined, id: string): number {
  const list = sys?.regions ?? [];
  const i = list.findIndex((g) => g.id === id);
  return i > 0 ? list[i - 1].outer : 0;
}
