/**
 * Facing-edge rules and the join flood fill (split out of blueprint.ts so gunFacing.ts and design.ts need not import it).
 * blueprint.ts re-exports both.
 */

import type { Side } from './types.js';
import { SIDE_NORMAL } from './catalog.js';
import { PlacedGeom, facingEdges, geomContainsPoint, isEdgeFree } from './grid.js';
import { partFacingRule } from './functionRegistry.js';

/**
 * What's wrong with part `self`'s facing `side` among `geoms` under its function's rule: 'noEdge' (no straight edge
 * that way), 'blocked' (a 'free' edge with a part across it), 'notJoined' (a 'joined' edge with no part across some
 * of it), or null when it keeps the rule (or the function has none).
 */
export function facingProblem(fn: string, geoms: PlacedGeom[], self: number, side: Side): 'noEdge' | 'blocked' | 'notJoined' | null {
  const rule = partFacingRule(fn);
  if (!rule) return null;
  const edges = facingEdges(geoms[self], side);
  if (!edges.length) return 'noEdge';
  if (rule === 'free') return edges.every((e) => isEdgeFree(geoms, self, e, side)) ? null : 'blocked';
  // (Joined: just past each unit edge's middle lies another part, as power/layout.ts finds a Diode's out part)
  const n = SIDE_NORMAL[side];
  const across = ([a, b]: (typeof edges)[number]) => {
    const x = (a[0] + b[0]) / 2 + n[0] * 0.05, y = (a[1] + b[1]) / 2 + n[1] * 0.05;
    return geoms.some((g, i) => i !== self && geomContainsPoint(g, x, y));
  };
  return edges.every(across) ? null : 'notJoined';
}

/** Flood fill over joins from `root`. Returns a reached flag per index. */
export function floodFill(count: number, joins: [number, number][], root: number, include?: (i: number) => boolean): boolean[] {
  const adj: number[][] = Array.from({ length: count }, () => []);
  for (const [a, b] of joins) {
    if (include && (!include(a) || !include(b))) continue;
    adj[a].push(b);
    adj[b].push(a);
  }
  const reached = new Array<boolean>(count).fill(false);
  if (root < 0 || (include && !include(root))) return reached;
  const stack = [root];
  reached[root] = true;
  while (stack.length) {
    const i = stack.pop()!;
    for (const j of adj[i]) {
      if (!reached[j]) { reached[j] = true; stack.push(j); }
    }
  }
  return reached;
}
