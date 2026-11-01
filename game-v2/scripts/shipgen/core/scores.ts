// Taste, as numbers (0..1 each): symmetry, vitals behind the shell, engines aft facing back, guns forward or out at the
// flanks, compactness. Each reads only the catalog (functions' own fields) and the placed geometry.
import type { Blueprint, Catalog, PlacedGeom, Side } from '../../../common/src/ships/index';
import { SIDE_NORMAL, isEngine, partMount, placeGeometry } from '../../../common/src/ships/index';
import type { ShipgenContext } from './context';
import { mirrorPart, partKey } from './grid';
import { silhouetteScore } from './silhouette';

export interface DesignScores {
  /** Share of the ship (by area) that has a mirror twin across the best left-right axis */
  symmetry: number;
  /** Share of the outside edge that is shell (hull, armour, cargo) or parts meant to face out, not vitals (core, power, tools) */
  armourOutside: number;
  /** Engines facing back (S) and in the rear half, weighted by thrust; 0 with no engines */
  enginesAft: number;
  /** Guns facing forward, or out at the flank they sit on; null with no guns */
  gunsOut: number | null;
  /** Cells covered / the bounding box */
  compactness: number;
  /** Share of the exposed outer corners of hull and armour that are shaped pieces (wedges, rounds, a nose); null with no such corner */
  silhouette: number | null;
}

const SIDES4: [number, number][] = [[0, -1], [1, 0], [0, 1], [-1, 0]];

/** Parts that belong on the outside: structure (no power role) and anything that points out */
function isShell(catalog: Catalog, fnId: string): boolean {
  const fn = catalog.functions.get(fnId);
  if (!fn) return true;
  if (fnId === 'core') return false;
  const powered = (fn.produce ?? 0) > 0 || (fn.store ?? 0) > 0 || (fn.demand ?? 0) > 0 || (fn.dynamo ?? 0) > 0 || !!fn.weapon || isEngine(fn) || !!fn.strafe;
  return !powered || !!fn.weapon || isEngine(fn) || !!fn.strafe || !!fn.facing;
}

export function designScores(ctx: ShipgenContext, bp: Blueprint, geoms?: PlacedGeom[]): DesignScores {
  const { catalog } = ctx;
  const gs = geoms ?? bp.parts.map((p) => placeGeometry(catalog, p));
  const owner = new Map<string, number>();
  gs.forEach((g, i) => { for (const c of g.cells) owner.set(`${c[0]},${c[1]}`, i); });
  const cells = [...owner.keys()].map((k) => k.split(',').map(Number));
  if (!cells.length) return { symmetry: 0, armourOutside: 0, enginesAft: 0, gunsOut: null, compactness: 0, silhouette: null };
  const x0 = Math.min(...cells.map((c) => c[0])), x1 = Math.max(...cells.map((c) => c[0])) + 1;
  const y0 = Math.min(...cells.map((c) => c[1])), y1 = Math.max(...cells.map((c) => c[1])) + 1;
  const cx = cells.reduce((s, c) => s + c[0] + 0.5, 0) / cells.length, cy = cells.reduce((s, c) => s + c[1] + 0.5, 0) / cells.length;

  // Outside edges: whose are they
  let edges = 0, shell = 0;
  for (const [k, i] of owner) {
    const [x, y] = k.split(',').map(Number);
    for (const [dx, dy] of SIDES4) {
      if (owner.has(`${x + dx},${y + dy}`)) continue;
      edges++;
      if (isShell(catalog, bp.parts[i].fn)) shell++;
    }
  }

  // Engines: facing S, in the rear half, by thrust
  let eW = 0, eS = 0;
  gs.forEach((g, i) => {
    const fn = catalog.functions.get(bp.parts[i].fn);
    if (!isEngine(fn)) return;
    const w = fn!.thrust ?? 1, f = bp.parts[i].facing;
    eW += w;
    eS += w * ((f === 'S' ? 1 : f === 'E' || f === 'W' ? 0.25 : 0) * 0.7 + (g.centroid[1] >= cy - 0.5 ? 1 : 0.4) * 0.3);
  });

  // Guns: fixed ones forward; turrets (and side guns) out at their own flank
  let gN = 0, gS = 0;
  gs.forEach((g, i) => {
    const p = bp.parts[i], fn = catalog.functions.get(p.fn);
    if (!fn?.weapon || !p.facing) return;
    const n = SIDE_NORMAL[p.facing as Side];
    const out = n[0] * (g.centroid[0] - cx) + n[1] * (g.centroid[1] - cy) > 0.25;
    const fixed = partMount(catalog, p) === 'fixed';
    gN++;
    if (p.facing === 'N') gS += 1;
    else if (p.facing === 'S') gS += fixed ? 0.1 : out ? 0.6 : 0.2;
    else gS += out ? (fixed ? 0.6 : 1) : 0.2;
  });

  // Symmetry: the best axis (twice its x), by area matched
  const keys = new Map<string, number>();
  for (const p of bp.parts) { const k = partKey(ctx, p); keys.set(k, (keys.get(k) ?? 0) + 1); }
  const area = gs.reduce((s, g) => s + g.area, 0);
  let sym = 0;
  for (let a2 = 2 * x0; a2 <= 2 * x1; a2++) {
    let matched = 0;
    const left = new Map(keys);
    bp.parts.forEach((p, i) => {
      let k: string;
      try { k = partKey(ctx, mirrorPart(ctx, p, a2)); } catch { return; }
      const n = left.get(k) ?? 0;
      if (n > 0) { left.set(k, n - 1); matched += gs[i].area; }
    });
    sym = Math.max(sym, area > 0 ? matched / area : 0);
  }

  return {
    symmetry: sym,
    armourOutside: edges ? shell / edges : 0,
    enginesAft: eW ? eS / eW : 0,
    gunsOut: gN ? gS / gN : null,
    compactness: cells.length / ((x1 - x0) * (y1 - y0)),
    silhouette: silhouetteScore(ctx, bp),
  };
}
