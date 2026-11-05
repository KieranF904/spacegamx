/**
 * Hangar slots and ghost parts, shared by the server (which decides) and the
 * hangar UI (which previews the same decision).
 *
 * A slot holds a ship design. Parts the pilot has are built in; parts they
 * can make but don't have yet are ghosts: placeholders the hangar fills as
 * parts arrive (fabricated, bought or salvaged). A part is only built in if
 * it joins the core through other built parts, so a half-built ship never has
 * pieces floating loose; anything beyond a gap waits as a ghost too.
 */

import type { Blueprint } from '../ships/types.js';
import type { Catalog } from '../ships/catalog.js';
import { placeGeometry, computeJoins } from '../ships/grid.js';
import { partItemId } from './items.js';
import type { Bag } from './stacks.js';


export interface DesignAllocation {
  /** Built parts, by uid */
  installed: Set<number>;
  /** Parts still to come, by uid, core outwards */
  ghosts: number[];
  /** Part items the built parts use, by item id */
  used: Bag;
}

function adjacency(catalog: Catalog, bp: Blueprint): number[][] {
  const geoms = bp.parts.map((p) => placeGeometry(catalog, p));
  const adj: number[][] = bp.parts.map(() => []);
  for (const [a, b] of computeJoins(geoms)) { adj[a].push(b); adj[b].push(a); }
  return adj;
}

/**
 * Build what the pool covers, from the core outwards. `take(itemId)` returns
 * true (and uses one up) if a part of that kind is available.
 */
export function allocateDesign(catalog: Catalog, bp: Blueprint, take: (itemId: string, uid: number) => boolean): DesignAllocation {
  const installed = new Set<number>();
  const used: Bag = {};
  const core = bp.parts.findIndex((p) => p.fn === 'core');
  const order: number[] = [];
  if (core >= 0) {
    const adj = adjacency(catalog, bp);
    const seen = new Set<number>([core]);
    const queue = [core];
    while (queue.length) {
      const i = queue.shift()!;
      order.push(i);
      const p = bp.parts[i];
      const id = partItemId(p);
      const ok = take(id, p.uid);
      if (ok) {
        installed.add(p.uid);
        used[id] = (used[id] ?? 0) + 1;
        for (const j of adj[i]) if (!seen.has(j)) { seen.add(j); queue.push(j); }
      }
      if (i === core && !ok) break; // no core, nothing can be built onto it
    }
  }
  // Ghosts: core outwards (reachable order first), then anything left
  const ghostSet = new Set(bp.parts.filter((p) => !installed.has(p.uid)).map((p) => p.uid));
  const ghosts: number[] = [];
  for (const i of order) if (ghostSet.has(bp.parts[i].uid)) { ghosts.push(bp.parts[i].uid); ghostSet.delete(bp.parts[i].uid); }
  ghosts.push(...ghostSet);
  return { installed, ghosts, used };
}

/** Ghost parts (uids) that join the built structure now, core outwards */
export function installableGhosts(catalog: Catalog, bp: Blueprint, ghosts: number[], structural: (index: number) => boolean): number[] {
  const g = new Set(ghosts);
  const core = bp.parts.findIndex((p) => p.fn === 'core');
  if (core < 0) return [];
  if (g.has(bp.parts[core].uid)) return [bp.parts[core].uid];
  const adj = adjacency(catalog, bp);
  const out: number[] = [];
  bp.parts.forEach((p, i) => {
    if (!g.has(p.uid)) return;
    if (adj[i].some((j) => !g.has(bp.parts[j].uid) && structural(j))) out.push(p.uid);
  });
  // Core outwards: order by join distance from the core
  const dist = new Map<number, number>([[core, 0]]);
  const queue = [core];
  while (queue.length) {
    const i = queue.shift()!;
    for (const j of adj[i]) if (!dist.has(j)) { dist.set(j, dist.get(i)! + 1); queue.push(j); }
  }
  const idx = new Map(bp.parts.map((p, i) => [p.uid, i]));
  return out.sort((a, b) => (dist.get(idx.get(a)!) ?? 999) - (dist.get(idx.get(b)!) ?? 999));
}

/** The part items a slot's ghosts still need */
export function ghostNeeds(bp: Blueprint, ghosts: number[]): Bag {
  const g = new Set(ghosts);
  const out: Bag = {};
  for (const p of bp.parts) if (g.has(p.uid)) { const id = partItemId(p); out[id] = (out[id] ?? 0) + 1; }
  return out;
}
