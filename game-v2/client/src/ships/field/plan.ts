/**
 * The field plan, as the build overlay edits it (docs/design/field-fabrication.md, 1 rule 5 and 5.1). Pure: no DOM, no
 * renderer, so the diff is tested on its own.
 *
 * A draft starts as the live ship's design (standing parts, then the planned ones). Placing adds a part at the end;
 * removing a planned part drops it; removing a standing part marks it for recycling (it stays in the draft, outlined
 * red, until the fabricator has broken it down). What a save sends is the TARGET: the draft without the marked parts.
 * The server keeps standing parts that match, queues the missing ones for recycling and appends new ones as ghosts.
 */
import {
  placeGeometry, overlapsAny, computeJoins, facingProblem, geomContainsPoint, floodFill, nextFreeUid, partNeedsFacing, gunFacing, hasFixedBarrel,
  mountingOf, partMountingProblems, validateBlueprint, SIDES, partItemId,
} from '@space-game/common';
import type { Blueprint, Catalog, PlacedGeom, PlacedPart, ShipTuning, Side, Vec2, BlueprintError } from '@space-game/common';
import { cloneJson as clone } from '@space-game/common';

export interface PlanDraft {
  /** The design being edited: live parts first (in their order), new parts appended */
  bp: Blueprint;
  /** Standing parts marked for recycling (uids) */
  marked: Set<number>;
  /** The uids that were live when it opened (standing and planned) */
  live: Set<number>;
  /** Which of those were planned (not built yet) */
  planned: Set<number>;
}


/**
 * A draft of the live design. `ghost[i]`: the i-th part is planned. `queued`: the uids the server already has queued
 * for recycling (they open marked)
 */
export function openDraft(live: Blueprint, ghost: readonly boolean[] | undefined, queued: Iterable<number> = []): PlanDraft {
  const bp = clone(live);
  const uids = new Set(bp.parts.map((p) => p.uid));
  return {
    bp,
    live: new Set(uids),
    planned: new Set(bp.parts.filter((_, i) => ghost?.[i]).map((p) => p.uid)),
    marked: new Set([...queued].filter((u) => uids.has(u))),
  };
}

/** The parts the draft means to keep: everything not marked */
export function targetParts(d: PlanDraft): PlacedPart[] {
  return d.bp.parts.filter((p) => !d.marked.has(p.uid));
}

/** The design a save sends */
export function planTarget(d: PlanDraft): Blueprint {
  return { ...clone(d.bp), parts: clone(targetParts(d)) };
}

export interface PlanDiff {
  /** New parts: they become planned parts (ghosts), appended in this order */
  added: PlacedPart[];
  /** Standing parts that will be queued for recycling */
  recycle: number[];
  /** Planned parts taken out of the plan (never built) */
  dropped: number[];
  /** Anything differs from the live ship */
  changed: boolean;
}

export function planDiff(d: PlanDraft): PlanDiff {
  const added = d.bp.parts.filter((p) => !d.live.has(p.uid) && !d.marked.has(p.uid));
  const recycle = [...d.marked].filter((u) => d.live.has(u) && !d.planned.has(u));
  const kept = new Set(d.bp.parts.map((p) => p.uid));
  const dropped = [...d.planned].filter((u) => !kept.has(u) || d.marked.has(u));
  return { added, recycle, dropped, changed: added.length > 0 || recycle.length > 0 || dropped.length > 0 };
}

/** Does the draft differ from the ship as it stands, or from what the server already has queued */
export function planChanged(d: PlanDraft, queued: ReadonlySet<number>): boolean {
  const diff = planDiff(d);
  if (diff.added.length || diff.dropped.length) return true;
  return diff.recycle.length !== queued.size || diff.recycle.some((u) => !queued.has(u));
}

const geomsOf = (catalog: Catalog, parts: readonly PlacedPart[]): PlacedGeom[] => parts.map((p) => placeGeometry(catalog, p));

/** The cells' geometry of the parts the draft keeps (what a new part must fit beside) */
export function targetGeoms(catalog: Catalog, d: PlanDraft): PlacedGeom[] {
  return geomsOf(catalog, targetParts(d));
}

const DEFAULT_FACING: Record<string, Side> = { thruster: 'S', weapon: 'N', miner: 'N' };

/** Explicit facing, or the first side with a free straight edge (preferring the function's usual side): as the hangar picks it */
function pickFacing(catalog: Catalog, geoms: PlacedGeom[], p: PlacedPart, want: Side | 'auto'): Side {
  if (want !== 'auto') return want;
  const g = placeGeometry(catalog, p);
  const all = [...geoms, g];
  const pref = DEFAULT_FACING[p.fn] ?? 'N';
  const order = [pref, ...SIDES.filter((s) => s !== pref)];
  const free = (side: Side) => !facingProblem(p.fn, all, all.length - 1, side);
  if (mountingOf(catalog, p.fn)?.rules) {
    for (const side of order) {
      if (!free(side)) continue;
      if (!partMountingProblems(catalog, [...geoms, placeGeometry(catalog, { ...p, facing: side })], geoms.length).length) return side;
    }
  }
  for (const side of order) if (free(side)) return side;
  return pref;
}

export interface Hand { piece: string; fn: string; material: string; rot: 0 | 1 | 2 | 3; flip: boolean; facing: Side | 'auto' }

/** The part in hand at a grid cell, with the next free uid; null: the design is full */
export function candidate(catalog: Catalog, d: PlanDraft, hand: Hand, at: Vec2): PlacedPart | null {
  const uid = nextFreeUid(d.bp);
  if (uid < 0) return null;
  const fd = catalog.functions.get(hand.fn);
  const p: PlacedPart = {
    uid, piece: hand.piece, fn: hand.fn, material: fd?.model && fd.material ? fd.material : hand.material,
    x: Math.floor(at[0]), y: Math.floor(at[1]), rot: hand.rot, flip: hand.flip,
  };
  if (partNeedsFacing(p.fn)) p.facing = gunFacing(catalog, p) ?? pickFacing(catalog, targetGeoms(catalog, d), p, hand.facing);
  return p;
}

/**
 * Why a candidate can't go here, or null if it can (the hangar's rules, against the parts the draft keeps). With
 * `tuning`, also what it would break in the design as a whole (a part walled in front of a gun): the server refuses a
 * plan that isn't a valid design, so the overlay refuses the part that makes it one
 */
export function placementProblem(catalog: Catalog, d: PlanDraft, p: PlacedPart, tuning?: ShipTuning): string | null {
  const own = ownProblem(catalog, d, p);
  if (own || !tuning) return own;
  const before = new Set(targetErrors(catalog, tuning, d).map((e) => e.message));
  const after = validateBlueprint(catalog, { ...d.bp, parts: [...targetParts(d), p] }, tuning, null, { mounting: false }).errors;
  const fresh = after.find((e) => !before.has(e.message));
  return fresh ? fresh.message.replace(/^[^:]*?\d+: /, '') : null;
}

function ownProblem(catalog: Catalog, d: PlanDraft, p: PlacedPart): string | null {
  const fn = catalog.functions.get(p.fn);
  if (!fn) return `unknown part ${p.fn}`;
  if (fn.pieces !== '*' && !fn.pieces.includes(p.piece)) return `${p.fn} can't go on ${p.piece}`;
  const geoms = targetGeoms(catalog, d);
  const g = placeGeometry(catalog, p);
  if (overlapsAny(g, geoms)) return 'overlaps another part';
  if (p.facing) {
    const why = facingProblem(p.fn, [...geoms, g], geoms.length, p.facing as Side);
    const fix = hasFixedBarrel(catalog, p.fn) ? 'turn it (R)' : 'press T for another side';
    if (why === 'noEdge') return `no straight edge facing ${p.facing}: ${fix}`;
    if (why === 'blocked') return `its ${p.facing} edge is blocked: ${fix}`;
    if (why === 'notJoined') return `its ${p.facing} edge must touch a part: ${fix}`;
  }
  if (geoms.length && computeJoins([...geoms, g]).every(([a, b]) => a !== geoms.length && b !== geoms.length)) return "doesn't join anything";
  const broken = geoms.length ? partMountingProblems(catalog, [...geoms, g], geoms.length) : [];
  if (broken.length) return broken.map((m) => m.message.replace(/^[^:]*?\d+: /, '')).join('; ');
  return null;
}

/** Place a part (the caller has checked placementProblem) */
export function addPart(d: PlanDraft, p: PlacedPart): void {
  d.bp.parts.push(p);
}

/** The draft part under a grid point (the later one wins), -1 none */
export function partAtPoint(catalog: Catalog, d: PlanDraft, at: Vec2): number {
  const parts = d.bp.parts;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (geomContainsPoint(placeGeometry(catalog, parts[i]), at[0], at[1])) return i;
  }
  return -1;
}

export type RemoveResult = { kind: 'none' } | { kind: 'dropped' | 'marked' | 'unmarked'; uids: number[] };

/**
 * Remove the part at index `i`. A new or planned part is dropped; a standing part is marked for recycling (again:
 * unmarked). Whatever the removal would cut off from the core goes with it, since the server breaks a ship down leaf
 * first and a design with stranded parts is not a ship
 */
export function removePart(catalog: Catalog, d: PlanDraft, i: number): RemoveResult {
  const p = d.bp.parts[i];
  if (!p) return { kind: 'none' };
  if (d.marked.has(p.uid)) { d.marked.delete(p.uid); return { kind: 'unmarked', uids: [p.uid] }; }
  if (p.fn === 'core') return { kind: 'none' };
  const gone = new Set<number>([p.uid]);
  // What the rest of the target can still reach from the core without it
  const parts = targetParts(d);
  const geoms = geomsOf(catalog, parts);
  const core = parts.findIndex((q) => q.fn === 'core');
  if (core >= 0) {
    const at = parts.findIndex((q) => q.uid === p.uid);
    const reached = floodFill(parts.length, computeJoins(geoms), core, (k) => k !== at);
    parts.forEach((q, k) => { if (k !== at && !reached[k]) gone.add(q.uid); });
  }
  const standing: number[] = [];
  const dropping: number[] = [];
  for (const u of gone) (d.live.has(u) && !d.planned.has(u) ? standing : dropping).push(u);
  d.bp.parts = d.bp.parts.filter((q) => !dropping.includes(q.uid));
  for (const u of standing) d.marked.add(u);
  return { kind: standing.includes(p.uid) ? 'marked' : 'dropped', uids: [...gone] };
}

/** Back to the live ship */
function resetDraft(d: PlanDraft, live: Blueprint, ghost: readonly boolean[] | undefined, queued: Iterable<number> = []): void {
  const n = openDraft(live, ghost, queued);
  d.bp = n.bp; d.live = n.live; d.planned = n.planned; d.marked = n.marked;
}

/** The target's problems (the same checks the server makes; a saved ship's mounting rules aren't re-held to a new rule) */
export function targetErrors(catalog: Catalog, tuning: ShipTuning, d: PlanDraft): BlueprintError[] {
  return validateBlueprint(catalog, planTarget(d), tuning, null, { mounting: false }).errors;
}

/** The item ids a plan's new parts will cost, counted (the overlay's footer) */
function addedItems(diff: PlanDiff): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of diff.added) { const id = partItemId(p); out[id] = (out[id] ?? 0) + 1; }
  return out;
}
