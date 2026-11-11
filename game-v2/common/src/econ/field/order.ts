/**
 * Which part field work goes to next, and where a finished part goes (docs/design/field-fabrication.md, "Job order" and
 * "Orphaned builds"). Works on part indices of one blueprint and its joins (ships/grid.ts computeJoins over every part,
 * built or not: where missing parts would reattach). Pure and deterministic: ties go to the lower part index.
 */

import type { Bag } from '../stacks.js';

/** Join distance of every part from the root (the core), over all joins; -1: not joined to it at all */
export function joinDepths(n: number, root: number, joins: readonly (readonly [number, number])[]): Int32Array {
  return depthsFromAdjacency(adjacency(n, joins), root);
}

/** The same over a ready adjacency list (an index pointer walks the queue, no shift) */
export function depthsFromAdjacency(adj: readonly (readonly number[])[], root: number): Int32Array {
  const n = adj.length;
  const depth = new Int32Array(n).fill(-1);
  if (root < 0 || root >= n) return depth;
  depth[root] = 0;
  const queue = [root];
  for (let h = 0; h < queue.length; h++) {
    const u = queue[h];
    for (const v of adj[u]) if (depth[v] < 0) { depth[v] = depth[u] + 1; queue.push(v); }
  }
  return depth;
}

/** Part uids ordered core outwards (nearest join distance first; stable; parts not joined to the core go last) */
export function coreOutwards(uids: readonly number[], parts: readonly { uid: number }[], adj: readonly (readonly number[])[], core: number): number[] {
  const depth = depthsFromAdjacency(adj, core);
  const idx = new Map(parts.map((p, i) => [p.uid, i]));
  const d = (u: number) => { const k = depth[idx.get(u)!]; return k < 0 ? 999 : k; };
  return [...uids].sort((a, b) => d(a) - d(b));
}

export function adjacency(n: number, joins: readonly (readonly [number, number])[]): number[][] {
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (const [a, b] of joins) { if (a < n && b < n) { adj[a].push(b); adj[b].push(a); } }
  return adj;
}

/** Parts connected to the root through parts that are `on` (the root counts as on) */
export function connected(n: number, root: number, joins: readonly (readonly [number, number])[], on: (i: number) => boolean): boolean[] {
  const out = new Array<boolean>(n).fill(false);
  if (root < 0 || root >= n) return out;
  const adj = adjacency(n, joins);
  out[root] = true;
  const queue = [root];
  for (let h = 0; h < queue.length; h++) for (const v of adj[queue[h]]) if (!out[v] && on(v)) { out[v] = true; queue.push(v); }
  return out;
}

/** What the next-job pick sees of each part */
export interface FieldPartView {
  /** Standing and joined to the core */
  alive: boolean;
  /** HP share missing (0..1) of a standing part */
  missing: number;
  /** Planned or lost: wanted on the ship but not standing (a ghost, or destroyed) */
  wanted: boolean;
  /** Queued for recycling */
  recycle: boolean;
  /** Its cells are still taken by a standing part that is queued for recycling (it waits for that one) */
  blocked: boolean;
  /** This machine can make it (rules.ts canFabricate) */
  makeable: boolean;
}

export type FieldTarget = { kind: 'repair' | 'build' | 'recycle'; part: number } | null;

/**
 * The fabricator's next job, as repair kits chose: damaged parts first (nearest the core first), then recycling (a part
 * whose removal strands nothing: recycleCandidates, deepest first), then missing and planned parts that join the standing
 * structure (nearest the core first). `skip`: parts to pass over this time (waiting on materials, say)
 */
export function nextFieldTarget(n: number, root: number, joins: readonly (readonly [number, number])[], view: readonly FieldPartView[], skip?: (i: number) => boolean): FieldTarget {
  const depth = joinDepths(n, root, joins);
  const better = (i: number, best: number) => best < 0 || depth[i] < depth[best] || (depth[i] === depth[best] && i < best);
  const skipped = (i: number) => !!skip?.(i);
  let pick = -1;
  for (let i = 0; i < n; i++) if (view[i].alive && !view[i].recycle && view[i].missing > 1e-6 && view[i].makeable && !skipped(i) && better(i, pick)) pick = i;
  if (pick >= 0) return { kind: 'repair', part: pick };
  const rc = recycleCandidates(n, root, joins, view.map((v) => v.alive), view.map((v) => v.recycle)).filter((i) => !skipped(i));
  if (rc.length) return { kind: 'recycle', part: rc[0] };
  const adj = adjacency(n, joins);
  for (let i = 0; i < n; i++) {
    const v = view[i];
    if (v.alive || !v.wanted || v.blocked || !v.makeable || skipped(i) || depth[i] < 0) continue;
    if (!adj[i].some((j) => view[j].alive)) continue;
    if (better(i, pick)) pick = i;
  }
  return pick >= 0 ? { kind: 'build', part: pick } : null;
}

/**
 * The job part `i` would be now, by the same rules as nextFieldTarget, or null when there is nothing the machine can do
 * with it yet (whole, not makeable, waiting on a recycle, joined to nothing standing, or holding others on). The pilot's
 * priority list (FieldRecord.first) asks this of each of its parts, in order, before the usual pick
 */
export function fieldTargetOf(i: number, n: number, root: number, joins: readonly (readonly [number, number])[], view: readonly FieldPartView[]): FieldTarget {
  const v = view[i];
  if (!v || !v.makeable) return null;
  if (v.alive && !v.recycle && v.missing > 1e-6) return { kind: 'repair', part: i };
  if (v.alive && v.recycle) {
    const rc = recycleCandidates(n, root, joins, view.map((x) => x.alive), view.map((x) => x.recycle));
    return rc.includes(i) ? { kind: 'recycle', part: i } : null;
  }
  if (v.alive || !v.wanted || v.blocked) return null;
  if (joinDepths(n, root, joins)[i] < 0) return null;
  return adjacency(n, joins)[i].some((j) => view[j].alive) ? { kind: 'build', part: i } : null;
}

/**
 * Rearming (docs/design/groups-mines-docking.md, "Field fabrication hook"): what the fabricator does once no repair,
 * recycle or build is left for it to start. The Mine Bay that lacks the most mines (ties: the first in part order) gets
 * a job of up to `perJob` mines (rules.ts REARM.perJob). `bays`: the ship's working bays (fx.minebay.bays), `loaded`
 * their magazines by uid (FieldRecord.mines). Null: every magazine is full
 */
export function nextRearm(
  bays: readonly { uid: number; capacity: number }[], loaded: Readonly<Record<number, number>> | undefined, perJob: number,
): { uid: number; count: number } | null {
  let pick: { uid: number; count: number } | null = null, most = 0;
  for (const b of bays) {
    const v = loaded?.[b.uid] ?? 0, have = Math.max(0, Math.min(b.capacity, Number.isFinite(v) ? Math.floor(v) : 0));
    const lack = b.capacity - have;
    if (lack > most) { most = lack; pick = { uid: b.uid, count: lack }; }
  }
  if (pick) pick.count = Math.max(1, Math.min(pick.count, Math.floor(perJob)));
  return pick;
}

/**
 * Parts queued for recycling that can go now: removing one leaves every standing part that isn't queued still joined to
 * the core. Deepest first (leaves go before what they hang on), ties by index. The core never goes
 */
export function recycleCandidates(n: number, root: number, joins: readonly (readonly [number, number])[], alive: readonly boolean[], queued: readonly boolean[]): number[] {
  const depth = joinDepths(n, root, joins);
  const out: number[] = [];
  const before = connected(n, root, joins, (i) => alive[i]);
  for (let r = 0; r < n; r++) {
    if (r === root || !queued[r] || !alive[r]) continue;
    const after = connected(n, root, joins, (i) => alive[i] && i !== r);
    let strands = false;
    for (let i = 0; i < n && !strands; i++) if (i !== r && !queued[i] && alive[i] && before[i] && !after[i]) strands = true;
    if (!strands) out.push(r);
  }
  return out.sort((a, b) => depth[b] - depth[a] || a - b);
}

/** A planned spot a finished part might go to */
export interface PlanSpot {
  part: number;
  /** The item it wants (items.ts partItemId) */
  item: string;
  /** Not standing, not taken by another job, and its cells free */
  open: boolean;
  /** Joins a standing part that is joined to the core (so a part placed there holds on) */
  joined: boolean;
}

export type Placement = { to: 'spot'; part: number } | { to: 'cargo' };

/**
 * Where a finished part goes (the orphan rule): its own planned spot if that is open and joined again; else another open,
 * joined planned spot wanting the same item (nearest the core first: pass `spots` in that order, or by index); else the
 * hold (and if the hold is full it waits inside the machine: the caller's)
 */
export function placeFinished(item: string, planned: number, spots: readonly PlanSpot[]): Placement {
  const own = spots.find((s) => s.part === planned);
  if (own && own.open && own.joined && own.item === item) return { to: 'spot', part: planned };
  for (const s of spots) if (s.part !== planned && s.open && s.joined && s.item === item) return { to: 'spot', part: s.part };
  return { to: 'cargo' };
}

/**
 * Pay for parts from a purse, core outward (the free bank at a respawn): repeatedly the wanted, unbuilt part nearest the
 * core that joins a built one; paid if the purse covers its bill (it is built), else passed over (a part beyond it may
 * still be reached another way). Returns the parts paid in order and what was spent; `purse` is not changed
 */
export function payCoreOutward(
  n: number, root: number, joins: readonly (readonly [number, number])[], built: readonly boolean[], want: (i: number) => boolean,
  bill: (i: number) => Bag, purse: Bag,
): { paid: number[]; spent: Bag } {
  const depth = joinDepths(n, root, joins), adj = adjacency(n, joins);
  const on = built.slice(0, n);
  if (root >= 0 && root < n) on[root] = true;
  const tried = new Array<boolean>(n).fill(false);
  const left: Bag = { ...purse }, spent: Bag = {}, paid: number[] = [];
  for (;;) {
    let pick = -1;
    for (let i = 0; i < n; i++) {
      if (on[i] || tried[i] || depth[i] < 0 || !want(i) || !adj[i].some((j) => on[j])) continue;
      if (pick < 0 || depth[i] < depth[pick] || (depth[i] === depth[pick] && i < pick)) pick = i;
    }
    if (pick < 0) break;
    tried[pick] = true;
    const b = bill(pick);
    if (Object.entries(b).some(([id, k]) => (left[id] ?? 0) < k)) continue;
    for (const [id, k] of Object.entries(b)) { left[id] -= k; spent[id] = (spent[id] ?? 0) + k; }
    on[pick] = true;
    paid.push(pick);
  }
  return { paid, spent };
}
