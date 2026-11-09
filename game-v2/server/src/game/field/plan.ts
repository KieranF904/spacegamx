/**
 * The build view's save against the ship as it stands (docs/design/field-fabrication.md 5.1). The world build view and
 * the hangar both edit the ship's blueprint; this is the world's half. One rule for every part the blueprint has and the
 * ship hasn't: it is MISSING, whether it was planned or shot off, and the same repair path builds it (the fabricator in
 * the field, the station and the repair bank when docked). So a save:
 *
 *   - keeps every part of the live design that has the same uid and placement in the target, whatever its state;
 *   - queues the standing parts left out for recycling (they stay in the blueprint, standing, until broken down);
 *   - drops the missing parts left out (nothing there to break down);
 *   - appends the target's new parts as missing parts (a part moved is a new part: a fresh uid, the old one recycled).
 *
 * A new part that joins nothing is kept too: planned ahead, unreachable (ValidationResult.unreachable). Nothing builds
 * it (the fabricator and the bank pick only parts that join a standing one, and `byDepth` puts it last) until something
 * joins it to the core's structure.
 *
 * The invariant: the live blueprint always passes `validate` (validateBlueprint with mounting: false). The parts being
 * recycled still stand, so a new part can't take their cells (or block their way) until they are gone: such a save is
 * refused with the reason, as the build view refuses the placement. Pure: no world.
 */

import { blueprintGeometry, computeJoins, joinDepths, type Blueprint, type Catalog, type PlacedPart, type ValidationResult, coreIndex, coreOf } from '@space-game/common';

export type Validate = (bp: Blueprint) => ValidationResult;

/** The ship as it stands, as the save sees it */
export interface LiveShip {
  blueprint: Blueprint;
  /** Hangar and bank placeholder parts in it (ShipState.ghost; uids): missing too, kept as they are */
  ghosts: ReadonlySet<number>;
  /** Standing (intact and joined to the core) */
  alive: (uid: number) => boolean;
}

export interface PlanResult {
  blueprint: Blueprint;
  /** Standing parts queued for recycling (still in the blueprint) */
  recycle: number[];
  /** New parts appended, missing (uids, blueprint order) */
  added: number[];
}

/** The same part in the same place (what keeps a part through a save) */
export function samePlacement(a: PlacedPart, b: PlacedPart): boolean {
  return a.piece === b.piece && a.fn === b.fn && a.material === b.material && a.x === b.x && a.y === b.y && a.rot === b.rot
    && !!a.flip === !!b.flip && (a.facing ?? '') === (b.facing ?? '') && (a.mount ?? 'fixed') === (b.mount ?? 'fixed');
}

const withParts = (bp: Blueprint, parts: PlacedPart[]): Blueprint => ({ ...bp, parts });

/**
 * Take parts out of the blueprint (a recycle finished, a queued part lost). Missing parts that then no longer pass go with
 * them, listed in `dropped`. (A missing part cut off from the core is not one: it stays, planned and unreachable.)
 * Null if a standing part would be left broken (the caller keeps the blueprint as it is)
 */
export function removeParts(validate: Validate, bp: Blueprint, uids: ReadonlySet<number>, alive: (uid: number) => boolean): { blueprint: Blueprint; dropped: number[] } | null {
  let parts = bp.parts.filter((p) => !uids.has(p.uid));
  const dropped: number[] = [];
  for (let guard = 0; guard <= bp.parts.length; guard++) {
    const v = validate(withParts(bp, parts));
    if (v.ok) return { blueprint: withParts(bp, parts), dropped };
    const bad = new Set(v.errors.flatMap((e) => e.uids));
    const movable = parts.filter((p) => bad.has(p.uid) && !alive(p.uid) && p.fn !== 'core');
    if (!movable.length) return null;
    const out = new Set(movable.map((p) => p.uid));
    dropped.push(...out);
    parts = parts.filter((p) => !out.has(p.uid));
  }
  return null;
}

/**
 * The save: `target` (already parsed and validated as a design) against the live ship. Error text if it can't be (the
 * core moved, a new part on cells a part being recycled still holds). Saving is free: nothing here costs
 */
export function planDiff(validate: Validate, catalog: Catalog, live: LiveShip, target: Blueprint): PlanResult | { error: string } {
  const bp = live.blueprint;
  const liveBy = new Map(bp.parts.map((p) => [p.uid, p]));
  const core = coreOf(bp.parts);
  const tcore = coreOf(target.parts);
  if (!core || !tcore || tcore.uid !== core.uid || !samePlacement(core, tcore)) return { error: 'The core must stay where it is' };
  const used = new Set<number>([...bp.parts.map((p) => p.uid), ...target.parts.map((p) => p.uid)]);
  const fresh = (): number => {
    for (let u = 0; u <= 255; u++) if (!used.has(u)) { used.add(u); return u; }
    return -1;
  };
  const kept = new Set<number>();
  const added: PlacedPart[] = [];
  for (const t of target.parts) {
    const l = liveBy.get(t.uid);
    if (l && samePlacement(l, t)) { kept.add(t.uid); continue; }
    if (!l) { added.push({ ...t }); continue; }
    // (The same uid somewhere else: a new part, the old one recycled or dropped)
    const u = fresh();
    if (u < 0) return { error: 'That plan has too many parts' };
    added.push({ ...t, uid: u });
  }
  const recycle = bp.parts.filter((p) => p.fn !== 'core' && !kept.has(p.uid) && !live.ghosts.has(p.uid) && live.alive(p.uid)).map((p) => p.uid);
  const rc = new Set(recycle);
  // Kept and recycling parts stay in their order; missing parts left out go; new parts follow, nearest the core first
  const stay = bp.parts.filter((p) => kept.has(p.uid) || rc.has(p.uid));
  const out = withParts({ ...bp, name: target.name || bp.name }, [...stay, ...byDepth(catalog, target, added)]);
  const v = validate(out);
  if (!v.ok) {
    // (Fine once the parts being recycled are gone: they are what's in the way)
    const without = withParts(out, out.parts.filter((p) => !rc.has(p.uid)));
    return { error: rc.size && validate(without).ok
      ? 'A new part needs the room of a part still being recycled: place it once that part is gone'
      : `That plan has problems: ${v.errors[0].message}` };
  }
  return { blueprint: out, recycle, added: out.parts.filter((p) => added.some((a) => a.uid === p.uid)).map((p) => p.uid) };
}

/** New parts nearest the target's core first (by joins in the target design), so the fabricator's order reads the same */
function byDepth(catalog: Catalog, target: Blueprint, parts: PlacedPart[]): PlacedPart[] {
  const n = target.parts.length;
  const depth = joinDepths(n, coreIndex(target.parts), joinsOf(catalog, target));
  const at = new Map(target.parts.map((p, i) => [p.uid, i]));
  const placeOf = (p: PlacedPart) => target.parts.findIndex((t) => samePlacement(t, p));
  const rank = (p: PlacedPart) => {
    const i = at.get(p.uid) ?? placeOf(p);
    return i >= 0 && depth[i] >= 0 ? depth[i] * 1024 + i : Number.MAX_SAFE_INTEGER;
  };
  return [...parts].sort((a, b) => rank(a) - rank(b));
}

/**
 * (Old saves) planned parts a field plan once kept outside the blueprint (`field.waiting`): into it as missing parts as
 * far as it stays valid; the rest are dropped. Returns the blueprint and the uids that went in
 */
export function admitLegacy(validate: Validate, bp: Blueprint, parts: readonly PlacedPart[]): { blueprint: Blueprint; added: number[] } {
  let cur = bp;
  const added: number[] = [];
  const used = new Set(bp.parts.map((p) => p.uid));
  let left = parts.filter((p) => !used.has(p.uid));
  for (let progress = true; progress && left.length;) {
    progress = false;
    const next: PlacedPart[] = [];
    for (const p of left) {
      const cand = withParts(cur, [...cur.parts, p]);
      if (validate(cand).ok) { cur = cand; added.push(p.uid); progress = true; } else next.push(p);
    }
    left = next;
  }
  return { blueprint: cur, added };
}

const joinCache = new WeakMap<Blueprint, [number, number][]>();
/** Joins between every part of a design, built or not (where a missing part would hold on), once a blueprint */
export function joinsOf(catalog: Catalog, bp: Blueprint): [number, number][] {
  let j = joinCache.get(bp);
  if (!j) { j = computeJoins(blueprintGeometry(catalog, bp)); joinCache.set(bp, j); }
  return j;
}
