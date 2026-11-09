/**
 * The world build view's edits to the ship's blueprint (docs/design/field-fabrication.md, rule 5 and 5.1). Pure: no DOM,
 * no renderer, so the rules are tested on their own.
 *
 * There is no plan apart from the blueprint. A part the blueprint has and the ship hasn't is MISSING, whether it was
 * planned or shot off, and the fabricator (or the station and the bank when docked) builds it. The view keeps only the
 * pilot's unsaved edits, laid over the live ship every frame (`working`), so a part built, lost or recycled meanwhile
 * shows as it is at once and the edits carry on:
 *
 *   added     new parts placed (missing once saved)
 *   dropped   missing parts taken out of the design
 *   mark      standing parts marked for recycling (they stay in the design, outlined red, until broken down)
 *   unmark    parts the server has queued that the pilot wants kept
 *
 * Each edit falls away by itself once the live ship shows it (`settle`), so after a save the view simply catches up.
 * A save sends the TARGET: the working design without the parts marked for recycling.
 */
import { placeGeometry, overlapsAny, computeJoins, facingProblem, geomContainsPoint, floodFill, partNeedsFacing, gunFacing, hasFixedBarrel,
  mountingOf, partMountingProblems, validateBlueprint, SIDES, nextFreeUid, coreIndex } from '@space-game/common';
import type { Blueprint, Catalog, PlacedGeom, PlacedPart, ShipTuning, Side, Vec2, BlueprintError } from '@space-game/common';
import { cloneJson as clone } from '@space-game/common';

export interface BuildEdits {
  added: PlacedPart[];
  dropped: Set<number>;
  mark: Set<number>;
  unmark: Set<number>;
}

/** The live ship as the edits see it */
export interface LiveDesign {
  bp: Blueprint;
  /** Standing, by part index (ShipDerived.alive) */
  alive: readonly boolean[];
  /** The server's recycling queue (uids) */
  queued: ReadonlySet<number>;
}

/** The design as the view shows it: the live ship with the edits on it */
export interface WorkingDesign {
  /** Live parts (in their order, less those dropped), then the added ones */
  bp: Blueprint;
  /** Each part standing now (an added part never is) */
  standing: boolean[];
  /** Standing parts that will be recycled (uids) */
  marked: Set<number>;
  /** Each part's index in the live blueprint, -1: added */
  liveIndex: number[];
}

export const noEdits = (): BuildEdits => ({ added: [], dropped: new Set(), mark: new Set(), unmark: new Set() });

export function hasEdits(e: BuildEdits): boolean {
  return e.added.length > 0 || e.dropped.size > 0 || e.mark.size > 0 || e.unmark.size > 0;
}

/** The edits laid over the live ship */
export function working(live: LiveDesign, e: BuildEdits): WorkingDesign {
  const parts: PlacedPart[] = [], standing: boolean[] = [], liveIndex: number[] = [];
  const marked = new Set<number>();
  live.bp.parts.forEach((p, i) => {
    if (e.dropped.has(p.uid)) return;
    parts.push(p); standing.push(!!live.alive[i]); liveIndex.push(i);
    if (live.alive[i] && p.fn !== 'core' && ((live.queued.has(p.uid) && !e.unmark.has(p.uid)) || e.mark.has(p.uid))) marked.add(p.uid);
  });
  for (const p of e.added) { parts.push(p); standing.push(false); liveIndex.push(-1); }
  return { bp: { ...live.bp, parts }, standing, marked, liveIndex };
}

/**
 * Drop the edits the live ship now shows (a save applied, a part gone): added parts it has, dropped parts it no longer
 * has, marks it has queued, unmarks it no longer queues. An added part whose uid the ship took for another goes too.
 * True if anything was dropped
 */
export function settle(live: LiveDesign, e: BuildEdits): boolean {
  const at = new Map(live.bp.parts.map((p, i) => [p.uid, i]));
  const before = e.added.length + e.dropped.size + e.mark.size + e.unmark.size;
  e.added = e.added.filter((p) => !at.has(p.uid));
  for (const u of e.dropped) if (!at.has(u)) e.dropped.delete(u);
  for (const u of e.mark) { const i = at.get(u); if (i === undefined || !live.alive[i] || live.queued.has(u)) e.mark.delete(u); }
  for (const u of e.unmark) if (!live.queued.has(u)) e.unmark.delete(u);
  return e.added.length + e.dropped.size + e.mark.size + e.unmark.size !== before;
}

/** The design a save sends: the working design without the parts to recycle */
export function planTarget(w: WorkingDesign): Blueprint {
  return { ...clone(w.bp), parts: clone(w.bp.parts.filter((p) => !w.marked.has(p.uid))) };
}

export interface EditSummary { added: number; recycle: number; dropped: number }

export function summary(live: LiveDesign, e: BuildEdits): EditSummary {
  const w = working(live, e);
  return { added: e.added.length, recycle: w.marked.size, dropped: e.dropped.size };
}

/**
 * Parts (uids) of the design the core doesn't hold on to: planned only. Nothing builds them (the fabricator, the station
 * and the bank pick only parts that join a standing one) until something joins them. The parts being recycled don't hold
 * anything (the target is the design without them); a part standing now is built, so never listed
 */
export function unjoinedUids(catalog: Catalog, w: WorkingDesign, geoms: readonly PlacedGeom[] = geomsOf(catalog, w.bp.parts)): Set<number> {
  const parts = w.bp.parts;
  const core = coreIndex(parts);
  const out = new Set<number>();
  if (core < 0) return out;
  const reached = floodFill(parts.length, computeJoins(geoms as PlacedGeom[]), core, (k) => !w.marked.has(parts[k].uid));
  parts.forEach((p, k) => { if (!reached[k] && !w.marked.has(p.uid) && !w.standing[k]) out.add(p.uid); });
  return out;
}

/** The footer's line about them ("2 parts not connected: they'll build once joined"), or '' */
export function unjoinedText(n: number): string {
  return n ? `${n} part${n > 1 ? 's' : ''} not connected: ${n > 1 ? "they'll" : "it'll"} build once joined.` : '';
}

/** Does saving change anything on the server */
export function planChanged(live: LiveDesign, e: BuildEdits): boolean {
  if (e.added.length || e.dropped.size) return true;
  const w = working(live, e);
  // (The server's queue as it applies to the parts standing now)
  const queued = live.bp.parts.filter((p, i) => live.alive[i] && live.queued.has(p.uid)).map((p) => p.uid);
  return w.marked.size !== queued.length || queued.some((u) => !w.marked.has(u));
}

const geomsOf = (catalog: Catalog, parts: readonly PlacedPart[]): PlacedGeom[] => parts.map((p) => placeGeometry(catalog, p));

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

/** A uid free in the working design and the live one (-1: full) */
function freeUid(w: WorkingDesign, live: Blueprint): number {
  return nextFreeUid({ ...live, parts: [...w.bp.parts, ...live.parts] });
}

/** The part in hand at a grid cell, with a free uid; null: the design is full */
export function candidate(catalog: Catalog, live: LiveDesign, w: WorkingDesign, hand: Hand, at: Vec2): PlacedPart | null {
  const uid = freeUid(w, live.bp);
  if (uid < 0) return null;
  const fd = catalog.functions.get(hand.fn);
  const p: PlacedPart = {
    uid, piece: hand.piece, fn: hand.fn, material: fd?.model && fd.material ? fd.material : hand.material,
    x: Math.floor(at[0]), y: Math.floor(at[1]), rot: hand.rot, flip: hand.flip,
  };
  if (partNeedsFacing(p.fn)) p.facing = gunFacing(catalog, p) ?? pickFacing(catalog, geomsOf(catalog, w.bp.parts), p, hand.facing);
  return p;
}

/**
 * Why a candidate can't go here, or null if it can: the hangar's rules, against every part of the working design (a part
 * marked for recycling still stands, so its cells stay taken until it is gone). With `tuning`, also what it would break
 * in the design as a whole (a part walled in front of a gun): the server refuses a save that isn't a valid design
 */
export function placementProblem(catalog: Catalog, w: WorkingDesign, p: PlacedPart, tuning?: ShipTuning): string | null {
  const own = ownProblem(catalog, w, p);
  if (own || !tuning) return own;
  const before = new Set(designErrors(catalog, tuning, w.bp).map((e) => e.message));
  const after = designErrors(catalog, tuning, { ...w.bp, parts: [...w.bp.parts, p] });
  const fresh = after.find((e) => !before.has(e.message));
  return fresh ? fresh.message.replace(/^[^:]*?\d+: /, '') : null;
}

function ownProblem(catalog: Catalog, w: WorkingDesign, p: PlacedPart): string | null {
  const fn = catalog.functions.get(p.fn);
  if (!fn) return `unknown part ${p.fn}`;
  if (fn.pieces !== '*' && !fn.pieces.includes(p.piece)) return `${p.fn} can't go on ${p.piece}`;
  const geoms = geomsOf(catalog, w.bp.parts);
  const g = placeGeometry(catalog, p);
  if (overlapsAny(g, geoms)) {
    const onMarked = w.bp.parts.some((q, i) => w.marked.has(q.uid) && overlapsAny(g, [geoms[i]]));
    return onMarked ? 'that part is still being recycled: place this once it is gone' : 'overlaps another part';
  }
  if (p.facing) {
    const why = facingProblem(p.fn, [...geoms, g], geoms.length, p.facing as Side);
    const fix = hasFixedBarrel(catalog, p.fn) ? 'turn it (R)' : 'press T for another side';
    if (why === 'noEdge') return `no straight edge facing ${p.facing}: ${fix}`;
    if (why === 'blocked') return `its ${p.facing} edge is blocked: ${fix}`;
    if (why === 'notJoined') return `its ${p.facing} edge must touch a part: ${fix}`;
  }
  // (A part that joins nothing may be planned: it is shown as not connected and builds once something joins it, `unjoinedUids`)
  const broken = geoms.length ? partMountingProblems(catalog, [...geoms, g], geoms.length) : [];
  if (broken.length) return broken.map((m) => m.message.replace(/^[^:]*?\d+: /, '')).join('; ');
  return null;
}

const designErrors = (catalog: Catalog, tuning: ShipTuning, bp: Blueprint): BlueprintError[] =>
  validateBlueprint(catalog, bp, tuning, null, { mounting: false }).errors;

/** The problems of the design as it would stand (the parts being recycled still in it: the server keeps it so) and of the target */
export function targetErrors(catalog: Catalog, tuning: ShipTuning, w: WorkingDesign): BlueprintError[] {
  const own = designErrors(catalog, tuning, planTarget(w));
  return own.length ? own : designErrors(catalog, tuning, w.bp);
}

/** Place a part (the caller has checked placementProblem) */
export function addPart(e: BuildEdits, p: PlacedPart): void {
  e.added.push(p);
}

/**
 * Swap working part `i` (not standing) for its turned copy `next`. An added part is replaced where it is; a planned one
 * (in the live blueprint, not built) is dropped and a copy added under a fresh uid, since the live ship keeps the uid
 * (false: the design is full)
 */
export function replacePart(live: LiveDesign, e: BuildEdits, w: WorkingDesign, i: number, next: PlacedPart): boolean {
  if (w.liveIndex[i] < 0) {
    const k = e.added.findIndex((q) => q.uid === next.uid);
    if (k < 0) return false;
    e.added[k] = next;
    return true;
  }
  const uid = freeUid(w, live.bp);
  if (uid < 0) return false;
  e.dropped.add(next.uid);
  e.added.push({ ...next, uid });
  return true;
}

/** The working part under a grid point (the later one wins), -1 none */
export function partAtPoint(catalog: Catalog, w: WorkingDesign, at: Vec2): number {
  const parts = w.bp.parts;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (geomContainsPoint(placeGeometry(catalog, parts[i]), at[0], at[1])) return i;
  }
  return -1;
}

export type RemoveResult = { kind: 'none' } | { kind: 'dropped' | 'marked' | 'unmarked'; uids: number[] };

/**
 * Take out the working part at index `i`. A missing part (planned, lost, or placed now) leaves the design; a standing part
 * is marked for recycling (again: kept). Whatever STANDING the removal would cut off from the core goes with it the same
 * way, since the server breaks a ship down leaf first. Missing parts it cuts off stay: planned, not connected
 */
export function removePart(catalog: Catalog, live: LiveDesign, e: BuildEdits, i: number): RemoveResult {
  const w = working(live, e);
  const p = w.bp.parts[i];
  if (!p) return { kind: 'none' };
  if (w.marked.has(p.uid)) {
    e.mark.delete(p.uid);
    if (live.queued.has(p.uid)) e.unmark.add(p.uid);
    return { kind: 'unmarked', uids: [p.uid] };
  }
  if (p.fn === 'core') return { kind: 'none' };
  const gone = new Set<number>([p.uid]);
  // What the rest of the target can still reach from the core without it
  const parts = w.bp.parts.filter((q) => !w.marked.has(q.uid));
  const core = coreIndex(parts);
  if (core >= 0) {
    const at = parts.findIndex((q) => q.uid === p.uid);
    const reached = floodFill(parts.length, computeJoins(geomsOf(catalog, parts)), core, (k) => k !== at);
    parts.forEach((q, k) => { if (k !== at && !reached[k]) gone.add(q.uid); });
  }
  const standing = new Set(w.bp.parts.filter((_, k) => w.standing[k]).map((q) => q.uid));
  for (const u of gone) if (u !== p.uid && !standing.has(u)) gone.delete(u);
  const addedUids = new Set(e.added.map((q) => q.uid));
  for (const u of gone) {
    if (standing.has(u)) { e.unmark.delete(u); if (!live.queued.has(u)) e.mark.add(u); }
    else if (addedUids.has(u)) e.added = e.added.filter((q) => q.uid !== u);
    else e.dropped.add(u);
  }
  return { kind: standing.has(p.uid) ? 'marked' : 'dropped', uids: [...gone] };
}
