/**
 * Gun shape rules (2026-11, night 2): a model gun's barrel is on a FIXED side of its piece, so turning (and mirroring)
 * the part is the only thing that changes which edge it fires out of. The part's `facing` is derived from that, never a
 * separate choice: facing = the piece's barrel side turned by `rot` and mirrored by `flip`.
 *
 * Why: a gun's power inputs sit on its back (the side opposite the barrel, in the gun's own frame: power/ports.ts
 * frameOf), counted along the barrel edge. A rectangle placed with its barrel on the long edge has two back cells, one
 * placed with its barrel on the short edge has one, so the way a builder aimed a gun used to decide whether it had one
 * or two inputs. With the barrel fixed to the piece, a model's inputs are always the ones its model lists.
 *
 * The barrel side is the piece's north edge (the rectangles' long edge) or, on a piece with no straight north edge (the
 * round piece), the first straight one of W, S, E. Only model weapons are fixed: legacy weapons (enemies', bosses') and
 * engines keep a free facing.
 *
 * Existing designs: `migrateGunFacings` turns each gun that was facing another way so its barrel points where it did
 * (moving it where it fits), and reports what it could not keep. Run on bundled designs by scripts/ships/gun-facing.ts
 * and on every player ship and design as a profile loads (econ/profile.ts).
 */

import type { Catalog } from './catalog.js';
import { transformSide } from './catalog.js';
import type { Blueprint, PlacedPart, Rot, Side } from './types.js';
import { computeJoins, facingEdges, overlapsAny, placeGeometry, type PlacedGeom } from './grid.js';
import { facingProblem, floodFill } from './facing.js';
import { partMountingProblems } from './mounting.js';

const BARREL_ORDER: readonly Side[] = ['N', 'W', 'S', 'E'];
const barrels = new WeakMap<Catalog, Map<string, Side>>();

/** The side of a piece (turned 0, not mirrored) a fixed barrel comes out of */
export function barrelSide(catalog: Catalog, piece: string): Side {
  let m = barrels.get(catalog);
  if (!m) barrels.set(catalog, (m = new Map()));
  let side = m.get(piece);
  if (side) return side;
  side = 'N';
  if (catalog.variants.has(piece)) {
    const g = placeGeometry(catalog, { uid: 0, piece, fn: 'hull', material: '', x: 0, y: 0, rot: 0, flip: false });
    side = BARREL_ORDER.find((s) => facingEdges(g, s).length > 0) ?? 'N';
  }
  m.set(piece, side);
  return side;
}

/** Is this function a gun whose barrel side is fixed to its piece (a model weapon) */
export function hasFixedBarrel(catalog: Catalog, fn: string): boolean {
  const f = catalog.functions.get(fn);
  return !!(f?.model && f.weapon);
}

/** Where a fixed-barrel gun fires out of for this turn and mirror (null: its function's barrel is free) */
export function gunFacing(catalog: Catalog, p: Pick<PlacedPart, 'fn' | 'piece' | 'rot' | 'flip'>): Side | null {
  if (!hasFixedBarrel(catalog, p.fn) || !catalog.variants.has(p.piece)) return null;
  return transformSide(barrelSide(catalog, p.piece), p.rot, !!p.flip);
}

/** The facing a part gets when it is placed or turned: a fixed barrel's own, else the one given */
export function placedFacing(catalog: Catalog, p: Pick<PlacedPart, 'fn' | 'piece' | 'rot' | 'flip'>, wanted: Side): Side {
  return gunFacing(catalog, p) ?? wanted;
}

/** A design with every fixed-barrel gun's facing set from its turn, in place (what a client's design says of it is ignored) */
export function fixGunFacing(catalog: Catalog, bp: Blueprint): Blueprint {
  for (const p of bp.parts) {
    const f = gunFacing(catalog, p);
    if (f) p.facing = f;
  }
  return bp;
}

export interface GunFacingChange {
  uid: number;
  fn: string;
  /** rotated: turned (and maybe moved) so the barrel points where it did; turned: the barrel now points the piece's way, as the part could not move; stuck: left as it was (it fails validation) */
  how: 'rotated' | 'turned' | 'stuck';
  /** Did its footprint change (the part moved or its shape is turned) */
  moved: boolean;
  /** Are its power inputs where they were (same footprint, same mirror, same barrel) */
  wiring: 'same' | 'differs';
  from: { x: number; y: number; rot: Rot; flip: boolean; facing: Side };
  to: { x: number; y: number; rot: Rot; flip: boolean; facing: Side };
}

export interface GunFacingMigration {
  blueprint: Blueprint;
  changes: GunFacingChange[];
  changed: boolean;
}

const lexLess = (a: number[], b: number[]) => { for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return a[k] < b[k]; return false; };
const ckey = (cells: readonly (readonly number[])[]) => cells.map((c) => `${c[0]},${c[1]}`).sort().join(' ');

/**
 * A design with each fixed-barrel gun's facing following its turn. A gun already so is untouched. One that faced
 * another way is turned (and, where its shape needs it, moved up to 3 cells) to the arrangement that points its barrel
 * the way it pointed, fits beside the other parts (no overlap, free barrel edge, mounting rules kept, still joined to
 * the ship) and changes least: its own footprint first, then its own mirror, then the shortest move. If nothing does,
 * it keeps its place and takes the piece's barrel side (`turned`), and if that is blocked it is left (`stuck`).
 */
function migratePass(catalog: Catalog, input: Blueprint, allowMove: boolean): GunFacingMigration {
  const parts = input.parts.map((p) => ({ ...p }));
  const changes: GunFacingChange[] = [];
  const todo = parts.map((p, i) => i).filter((i) => {
    const p = parts[i], want = gunFacing(catalog, p);
    return want !== null && p.facing !== want;
  });
  if (!todo.length) return { blueprint: input, changes, changed: false };

  const geomsOf = () => parts.map((p) => placeGeometry(catalog, p));
  const reach = (geoms: PlacedGeom[]) => {
    const core = parts.findIndex((p) => p.fn === 'core');
    return core < 0 ? 0 : floodFill(geoms.length, computeJoins(geoms), core).filter(Boolean).length;
  };

  for (const i of todo) {
    const p = parts[i];
    const was = { x: p.x, y: p.y, rot: p.rot, flip: !!p.flip, facing: p.facing as Side };
    // (No facing at all: the part's own turn gives it one)
    const aim = (p.facing as Side | undefined) ?? gunFacing(catalog, p)!;
    const before = geomsOf();
    const baseReach = reach(before);
    const clean = !partMountingProblems(catalog, before, i).length;
    const cells0 = ckey(before[i].cells);
    const others = before.filter((_, j) => j !== i);
    type Cand = { q: PlacedPart; score: number[] };
    let best: Cand | null = null;
    for (const flip of [!!p.flip, !p.flip]) {
      for (const rot of [0, 1, 2, 3] as Rot[]) {
        if (gunFacing(catalog, { ...p, rot, flip }) !== aim) continue;
        for (let dy = -3; dy <= 3; dy++) {
          for (let dx = -3; dx <= 3; dx++) {
            const q: PlacedPart = { ...p, x: p.x + dx, y: p.y + dy, rot, flip, facing: aim };
            const g = placeGeometry(catalog, q);
            if (overlapsAny(g, others)) continue;
            if (!allowMove && ckey(g.cells) !== cells0) continue;
            const geoms = before.slice();
            geoms[i] = g;
            if (facingProblem(q.fn, geoms, i, aim)) continue;
            if (clean && partMountingProblems(catalog, geoms, i).length) continue;
            if (reach(geoms) < baseReach) continue;
            const score = [ckey(g.cells) === cells0 ? 0 : 1, flip === !!p.flip ? 0 : 1, Math.abs(dx) + Math.abs(dy), (rot - p.rot + 4) % 4];
            if (!best || lexLess(score, best.score)) best = { q, score };
          }
        }
      }
    }
    let how: GunFacingChange['how'] = 'rotated';
    let q: PlacedPart | undefined = best?.q;
    if (!q && allowMove) {
      // Keep the place; the barrel takes the piece's side if that edge is free
      const turned: PlacedPart = { ...p, facing: gunFacing(catalog, p)! };
      const geoms = before.slice();
      geoms[i] = placeGeometry(catalog, turned);
      if (!facingProblem(turned.fn, geoms, i, turned.facing as Side)) { q = turned; how = 'turned'; }
      else how = 'stuck';
    }
    if (!q) {
      how = 'stuck';
      changes.push({ uid: p.uid, fn: p.fn, how, moved: false, wiring: 'same', from: was, to: was });
      continue;
    }
    parts[i] = q;
    const after = placeGeometry(catalog, q);
    const to = { x: q.x, y: q.y, rot: q.rot, flip: !!q.flip, facing: q.facing as Side };
    const sameCells = ckey(after.cells) === cells0;
    changes.push({ uid: p.uid, fn: p.fn, how, moved: !sameCells, wiring: sameCells && to.flip === was.flip && to.facing === was.facing ? 'same' : 'differs', from: was, to });
  }
  const changed = changes.some((c) => c.how !== 'stuck');
  return { blueprint: changed ? { ...input, parts } : input, changes, changed };
}

/** How much is wrong with a design's guns and shape, ignoring which way a fixed barrel faces: edges, mounting rules, overlaps, parts cut off */
function trouble(catalog: Catalog, bp: Blueprint): number {
  const geoms = bp.parts.map((p) => placeGeometry(catalog, p));
  let n = 0;
  geoms.forEach((g, i) => {
    const p = g.part;
    if (p.facing && facingProblem(p.fn, geoms, i, p.facing as Side)) n++;
    n += partMountingProblems(catalog, geoms, i).length;
  });
  const core = bp.parts.findIndex((p) => p.fn === 'core');
  if (core >= 0) n += floodFill(geoms.length, computeJoins(geoms), core).filter((r) => !r).length;
  return n;
}

/**
 * A design with each fixed-barrel gun's facing following its turn. A gun already so is untouched. One that faced
 * another way is turned (and, where its shape needs it, moved up to 3 cells) to the arrangement that points its barrel
 * the way it pointed, fits beside the other parts (no overlap, free barrel edge, mounting rules kept, still joined to
 * the ship) and changes least: its own footprint first, then its own mirror, then the shortest move. If nothing does,
 * it keeps its place and takes the piece's barrel side (`turned`), and if that is blocked it is left (`stuck`). If
 * moving guns leaves the design worse off than it was (a row of long guns stood on end cannot lie down), only the guns
 * that turn on the spot are changed and the rest are left as they were (`stuck`: still flying, flagged in the hangar).
 */
export function migrateGunFacings(catalog: Catalog, input: Blueprint): GunFacingMigration {
  const first = migratePass(catalog, input, true);
  if (!first.changed) return first;
  const was = trouble(catalog, input);
  if (trouble(catalog, first.blueprint) <= was) return first;
  return migratePass(catalog, input, false);
}

/**
 * A fixed-barrel gun drawn on the same cells with its barrel the way `p.facing` says (a text grid's facing mark: the
 * mark is the aim, the cells the place): the turn and mirror that do it, its own mirror first. Anything else, or a gun
 * no turn of which fires that way on those cells, is returned as it is (validation then says what is wrong).
 */
export function orientToFacing(catalog: Catalog, p: PlacedPart): PlacedPart {
  const aim = p.facing as Side | undefined;
  if (!aim || gunFacing(catalog, p) === null || gunFacing(catalog, p) === aim) return p;
  const cells0 = ckey(placeGeometry(catalog, p).cells);
  for (const flip of [!!p.flip, !p.flip]) {
    for (const rot of [0, 1, 2, 3] as Rot[]) {
      if (gunFacing(catalog, { ...p, rot, flip }) !== aim) continue;
      for (let dy = -3; dy <= 3; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
          const q: PlacedPart = { ...p, x: p.x + dx, y: p.y + dy, rot, flip };
          if (ckey(placeGeometry(catalog, q).cells) === cells0) return q;
        }
      }
    }
  }
  return p;
}
