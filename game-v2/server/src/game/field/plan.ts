/**
 * The field plan's diff (docs/design/field-fabrication.md 5.1): the design a pilot saves against the ship as it
 * stands. Parts standing that keep their uid and placement stay; a standing part moved gets a fresh uid (the old one
 * is recycled); standing parts left out are queued for recycling; new parts become planned parts (ghosts) appended to
 * the blueprint, or wait (`field.waiting`) while they can't be in it yet (their cells still taken by a part being
 * recycled, or nothing joins them yet).
 *
 * The invariant every function here keeps: the live blueprint always passes `validate` (validateBlueprint with
 * mounting: false). A planned part goes into the blueprint only if the blueprint with it still does. Pure: no world.
 */

import { blueprintGeometry, computeJoins, joinDepths, type Blueprint, type Catalog, type PlacedPart, type ValidationResult } from '@space-game/common';

export type Validate = (bp: Blueprint) => ValidationResult;

/** The ship as it stands, as the diff sees it */
export interface LiveShip {
  blueprint: Blueprint;
  /** Planned parts in the blueprint (uids) */
  ghosts: ReadonlySet<number>;
  /** Standing (intact and joined to the core) */
  alive: (uid: number) => boolean;
}

export interface PlanResult {
  blueprint: Blueprint;
  /** Planned parts in it, in blueprint order */
  ghosts: number[];
  /** Standing parts queued for recycling */
  recycle: number[];
  /** Planned parts that can't be in it yet */
  waiting: PlacedPart[];
}

/** The same part in the same place (what keeps a standing part standing through a plan save) */
export function samePlacement(a: PlacedPart, b: PlacedPart): boolean {
  return a.piece === b.piece && a.fn === b.fn && a.material === b.material && a.x === b.x && a.y === b.y && a.rot === b.rot
    && !!a.flip === !!b.flip && (a.facing ?? '') === (b.facing ?? '') && (a.mount ?? 'fixed') === (b.mount ?? 'fixed');
}

const withParts = (bp: Blueprint, parts: PlacedPart[]): Blueprint => ({ ...bp, parts });

/**
 * Add planned parts to a valid blueprint, each only if it stays valid (passes again while any goes in: one may join
 * another). Returns the blueprint, the uids that went in, and the rest (still waiting)
 */
export function admit(validate: Validate, bp: Blueprint, parts: readonly PlacedPart[]): { blueprint: Blueprint; added: number[]; left: PlacedPart[] } {
  let cur = bp;
  const added: number[] = [];
  let left = [...parts];
  if (!left.length) return { blueprint: cur, added, left };
  // (Most plans go in whole)
  const all = withParts(cur, [...cur.parts, ...left]);
  if (validate(all).ok) return { blueprint: all, added: left.map((p) => p.uid), left: [] };
  for (let progress = true; progress && left.length;) {
    progress = false;
    const next: PlacedPart[] = [];
    for (const p of left) {
      const cand = withParts(cur, [...cur.parts, p]);
      if (validate(cand).ok) { cur = cand; added.push(p.uid); progress = true; } else next.push(p);
    }
    left = next;
  }
  return { blueprint: cur, added, left };
}

/**
 * Take parts out of the blueprint (a recycle finished, a destroyed part dropped). Parts that aren't standing and then
 * no longer pass (cut off from the core, say) move to the returned `waiting`. Null if a standing part would be left
 * broken (the caller keeps the blueprint as it is)
 */
export function removeParts(validate: Validate, bp: Blueprint, uids: ReadonlySet<number>, alive: (uid: number) => boolean): { blueprint: Blueprint; waiting: PlacedPart[] } | null {
  let parts = bp.parts.filter((p) => !uids.has(p.uid));
  const waiting: PlacedPart[] = [];
  for (let guard = 0; guard <= bp.parts.length; guard++) {
    const v = validate(withParts(bp, parts));
    if (v.ok) return { blueprint: withParts(bp, parts), waiting };
    const bad = new Set(v.errors.flatMap((e) => e.uids));
    const movable = parts.filter((p) => bad.has(p.uid) && !alive(p.uid) && p.fn !== 'core');
    if (!movable.length) return null;
    const out = new Set(movable.map((p) => p.uid));
    waiting.push(...movable);
    parts = parts.filter((p) => !out.has(p.uid));
  }
  return null;
}

/**
 * The plan save: `target` (already parsed and validated as a design) against the live ship. Error text if it can't be
 * (the core moved, or the ship as it stands would be left broken). Saving is free: nothing here costs
 */
export function planDiff(validate: Validate, catalog: Catalog, live: LiveShip, target: Blueprint): PlanResult | { error: string } {
  const bp = live.blueprint;
  const liveBy = new Map(bp.parts.map((p) => [p.uid, p]));
  const core = bp.parts.find((p) => p.fn === 'core');
  const tcore = target.parts.find((p) => p.fn === 'core');
  if (!core || !tcore || tcore.uid !== core.uid || !samePlacement(core, tcore)) return { error: 'The core must stay where it is' };
  const used = new Set<number>([...bp.parts.map((p) => p.uid), ...target.parts.map((p) => p.uid)]);
  const fresh = (): number => {
    for (let u = 0; u <= 255; u++) if (!used.has(u)) { used.add(u); return u; }
    return -1;
  };
  const kept = new Set<number>();
  const planned: PlacedPart[] = [];
  for (const t of target.parts) {
    const l = liveBy.get(t.uid);
    if (l && !live.ghosts.has(l.uid)) {
      if (samePlacement(l, t)) { kept.add(t.uid); continue; }
      const u = fresh();
      if (u < 0) return { error: 'That plan has too many parts' };
      planned.push({ ...t, uid: u });
    } else planned.push({ ...t });
  }
  // Standing parts left out are recycled; destroyed ones simply go (nothing there to recycle)
  const recycle = bp.parts.filter((p) => p.fn !== 'core' && !live.ghosts.has(p.uid) && !kept.has(p.uid) && live.alive(p.uid)).map((p) => p.uid);
  const rc = new Set(recycle);
  const dropped = new Set(bp.parts.filter((p) => !kept.has(p.uid) && !rc.has(p.uid)).map((p) => p.uid));
  const settled = removeParts(validate, bp, dropped, live.alive);
  if (!settled) return { error: 'That plan would leave the ship in pieces' };
  // (Kept destroyed parts cut off by what was dropped plan again, as any new part)
  const cut = settled.waiting.filter((p) => kept.has(p.uid));
  const order = byDepth(catalog, target, [...cut, ...planned]);
  const { blueprint, added, left } = admit(validate, withParts({ ...bp, name: target.name || bp.name }, settled.blueprint.parts), order);
  return { blueprint, ghosts: added, recycle, waiting: left };
}

/** Planned parts nearest the target's core first (by joins in the target design), so most go in on the first pass */
function byDepth(catalog: Catalog, target: Blueprint, parts: PlacedPart[]): PlacedPart[] {
  const n = target.parts.length;
  const depth = joinDepths(n, target.parts.findIndex((p) => p.fn === 'core'), joinsOf(catalog, target));
  const at = new Map(target.parts.map((p, i) => [p.uid, i]));
  const placeOf = (p: PlacedPart) => target.parts.findIndex((t) => samePlacement(t, p));
  const rank = (p: PlacedPart) => {
    const i = at.get(p.uid) ?? placeOf(p);
    return i >= 0 && depth[i] >= 0 ? depth[i] * 1024 + i : Number.MAX_SAFE_INTEGER;
  };
  return [...parts].sort((a, b) => rank(a) - rank(b));
}

/** Planned parts that wait, into the blueprint as far as they now can (a recycle freed their cells) */
export function promoteWaiting(validate: Validate, bp: Blueprint, waiting: readonly PlacedPart[]): { blueprint: Blueprint; added: number[]; left: PlacedPart[] } {
  return admit(validate, bp, waiting);
}

const joinCache = new WeakMap<Blueprint, [number, number][]>();
/** Joins between every part of a design, built or not (where a missing part would hold on), once a blueprint */
export function joinsOf(catalog: Catalog, bp: Blueprint): [number, number][] {
  let j = joinCache.get(bp);
  if (!j) { j = computeJoins(blueprintGeometry(catalog, bp)); joinCache.set(bp, j); }
  return j;
}
