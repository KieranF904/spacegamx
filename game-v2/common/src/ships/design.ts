/**
 * What a design fixes, worked out once per blueprint (rebuild.ts reads it on every rebuild): each part's placed
 * geometry, mount, function and material, the joins between every part, and its turrets' rays and engines' exhaust with
 * every part standing (any ship of the design has at most those parts, so a rebuild can carry on from them: rebuild.ts
 * RebuildMemo).
 *
 * Kept in a WeakMap on the blueprint object. A blueprint may be edited in place (the hangar moves, turns and adds parts
 * of the one it shows), so an entry is checked before use: the same catalog, the same parts array and part objects, and
 * each part's placement fields as they were. Anything else is worked out afresh. Nothing here changes during play.
 */

import type { Blueprint, FunctionDef, MaterialDef, PlacedPart, Side } from './types.js';
import type { Catalog } from './catalog.js';
import type { ShipTuning } from './tuning.js';
import { type PartMount, type PlacedGeom, computeJoins, mountOf, placeGeometry } from './grid.js';
import { floodFill } from './blueprint.js';
import { partMaterial } from './grades.js';
import { type PartCircles, type TurretFrame, type TurretRays, castTurret, partCircles, turretFrame } from './turret.js';
import { type CellMap, cellMap, engineExhaust } from './mounting.js';

export interface DesignInfo {
  readonly catalog: Catalog;
  readonly geoms: PlacedGeom[];
  /** Where each part points out (a facing edge, or a bespoke piece's mount) */
  readonly mounts: (PartMount | null)[];
  readonly fns: FunctionDef[];
  /** (A model is made of its own material, whatever the part says) */
  readonly mats: MaterialDef[];
  readonly area: number[];
  /** Joins between every part, intact or not */
  readonly joins: [number, number][];
  /** The first core (-1 none) */
  readonly core: number;
  /** (The check: the parts as they were placed) */
  readonly parts: PlacedPart[];
  readonly placed: PlacedPart[];
  readonly keys: (string | number | boolean | undefined)[];
  /** (Worked out when first asked) */
  wholeBuilt?: boolean[];
  circles?: PartCircles;
  /** Per turret part: its ray frame, and its rays with every part standing (for this tuning) */
  turrets?: { tuning: ShipTuning; frames: Map<number, TurretFrame>; whole: Map<number, TurretRays> };
  /** Per engine part: its exhaust share with every part standing */
  exhaust?: Map<number, number>;
  cells?: CellMap;
}

const KEYS = 8;
/** The fields a part's geometry, mount, function and material come from */
function keysOf(p: PlacedPart, out: (string | number | boolean | undefined)[], at: number): void {
  out[at] = p.piece; out[at + 1] = p.x; out[at + 2] = p.y; out[at + 3] = p.rot;
  out[at + 4] = p.flip; out[at + 5] = p.facing; out[at + 6] = p.fn; out[at + 7] = p.material;
}

const designs = new WeakMap<Blueprint, DesignInfo>();

function stillHolds(d: DesignInfo, catalog: Catalog, bp: Blueprint): boolean {
  const parts = bp.parts;
  if (d.catalog !== catalog || d.parts !== parts || parts.length !== d.placed.length) return false;
  const k = d.keys;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i], at = i * KEYS;
    if (p !== d.placed[i] || p.piece !== k[at] || p.x !== k[at + 1] || p.y !== k[at + 2] || p.rot !== k[at + 3]
      || p.flip !== k[at + 4] || p.facing !== k[at + 5] || p.fn !== k[at + 6] || p.material !== k[at + 7]) return false;
  }
  return true;
}

/** This blueprint's design info, worked out once (and again whenever the blueprint was edited in place) */
export function designOf(catalog: Catalog, bp: Blueprint): DesignInfo {
  const had = designs.get(bp);
  if (had && stillHolds(had, catalog, bp)) return had;
  const d = newDesign(catalog, bp);
  designs.set(bp, d);
  return d;
}

/** The design info worked out afresh, and not kept */
export function newDesign(catalog: Catalog, bp: Blueprint): DesignInfo {
  const parts = bp.parts;
  const geoms = parts.map((p) => placeGeometry(catalog, p));
  const keys: (string | number | boolean | undefined)[] = new Array(parts.length * KEYS);
  parts.forEach((p, i) => keysOf(p, keys, i * KEYS));
  const d: DesignInfo = {
    catalog,
    geoms,
    mounts: geoms.map((g) => mountOf(g)),
    fns: parts.map((p) => catalog.functions.get(p.fn)!),
    mats: parts.map((p) => partMaterial(catalog, p)!),
    area: geoms.map((g) => g.area),
    joins: computeJoins(geoms),
    core: parts.findIndex((p) => p.fn === 'core'),
    parts,
    placed: [...parts],
    keys,
  };
  return d;
}

/** The ship as built with no ghosts: every part held on to the core through the joins */
export function wholeBuilt(d: DesignInfo): boolean[] {
  return (d.wholeBuilt ??= floodFill(d.geoms.length, d.joins, d.core));
}

function turretsOf(d: DesignInfo, tuning: ShipTuning): NonNullable<DesignInfo['turrets']> {
  if (!d.turrets || d.turrets.tuning !== tuning) d.turrets = { tuning, frames: new Map(), whole: new Map() };
  return d.turrets;
}

/** Turret part `i`'s ray frame (turret.ts turretFrame), worked out once per design and tuning */
export function turretFrameOf(d: DesignInfo, i: number, tuning: ShipTuning): TurretFrame {
  const t = turretsOf(d, tuning);
  let f = t.frames.get(i);
  if (!f) {
    f = turretFrame(d.geoms, i, d.mounts[i]!.dir, tuning, d.fns[i].mounting?.arc, (d.circles ??= partCircles(d.geoms)));
    t.frames.set(i, f);
  }
  return f;
}

/** Turret part `i`'s rays with every part of the design standing */
export function wholeTurret(d: DesignInfo, i: number, tuning: ShipTuning): TurretRays {
  const t = turretsOf(d, tuning);
  let r = t.whole.get(i);
  if (!r) t.whole.set(i, (r = castTurret(turretFrameOf(d, i, tuning), d.geoms, d.geoms.map(() => true))));
  return r;
}

/** Engine part `i`'s exhaust share out of `side` with every part of the design standing */
export function wholeExhaust(d: DesignInfo, i: number, side: Side): number {
  const e = (d.exhaust ??= new Map());
  let s = e.get(i);
  if (s === undefined) e.set(i, (s = engineExhaust(d.geoms, i, side, (d.cells ??= cellMap(d.geoms))).share));
  return s;
}
