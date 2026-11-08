/**
 * The weapons range's test rig (dev tool: server/src/game/WeaponsRange.ts, the F10 panel): a plain alloy bar of a ship
 * carrying two guns, with reactors to spare, built from the gun models themselves so it works for every size.
 *
 * Layout (north is up; the guns fire north):
 *   row -h..-1  the guns, side by side, each on the spine (a side-mount gun gets a hull column on its west)
 *   row 0       the spine: hull, with the core in the middle
 *   rows 1..    reactors (enough for the guns and the drives, with room to spare), then the drives facing south
 * Pure and deterministic; the result is a plain Blueprint (validate it like any other, mounting rules included).
 */

import type { Catalog } from './catalog.js';
import type { Blueprint, PlacedPart, Rot, Side } from './types.js';
import { attachSide, mountingOf, partMountingProblems } from './mounting.js';
import { facingEdges, placeGeometry } from './grid.js';
import { gunFacing } from './gunFacing.js';

const HULL = 'hull', CORE = 'core', REACTOR = 'power_overclock_reactor', DRIVE = 'engine_ion_drive';

/** One gun as the rig fits it: its piece, how it is turned so it can fire north, its size, and the side it bolts on at */
interface Fit { piece: string; rot: Rot; flip: boolean; w: number; h: number; ox: number; oy: number; attach: Side }

/** Turn (and mirror) the gun until it has a free straight edge to fire north out of and its bolt-on edge, else null */
function fit(catalog: Catalog, fn: string): Fit | null {
  const f = catalog.functions.get(fn);
  if (!f?.weapon || !Array.isArray(f.pieces) || !f.pieces.length || !catalog.pieces.get(f.pieces[0])) return null;
  const piece = f.pieces[0], m = mountingOf(catalog, fn);
  for (const flip of [false, true]) {
    for (const rot of [0, 1, 2, 3] as Rot[]) {
      // (A model gun's barrel is fixed to its piece: only the turns that put it north)
      if ((gunFacing(catalog, { fn, piece, rot, flip }) ?? 'N') !== 'N') continue;
      const probe: PlacedPart = { uid: 0, piece, fn, material: f.material ?? 'alloy', x: 0, y: 0, rot, flip, facing: 'N' };
      const g = placeGeometry(catalog, probe);
      if (!facingEdges(g, 'N').length || partMountingProblems(catalog, [g], 0).some((q) => q.rule === 'angle')) continue;
      const xs = g.cells.map((c) => c[0]), ys = g.cells.map((c) => c[1]);
      const minX = Math.min(...xs), minY = Math.min(...ys);
      return { piece, rot, flip, w: Math.max(...xs) - minX + 1, h: Math.max(...ys) - minY + 1, ox: -minX, oy: -minY, attach: attachSide('N', m?.angle ?? 'straight', flip) };
    }
  }
  return null;
}

/** Does this id name a gun the rig can carry */
export function isRigGun(catalog: Catalog, fn: string): boolean {
  return !!fit(catalog, fn);
}

/**
 * The test rig: `guns` are one or two weapon model ids (one: two of it). Returns null when an id isn't a weapon.
 * Power: reactors for 1.6x everything's demand plus a full drive set.
 */
export function buildRangeRig(catalog: Catalog, guns: string[]): Blueprint | null {
  const ids = guns.length >= 2 ? [guns[0], guns[1]] : [guns[0], guns[0]];
  const fps = ids.map((id) => (id ? fit(catalog, id) : null));
  if (fps.some((f) => !f)) return null;
  const parts: PlacedPart[] = [];
  let uid = 0;
  const add = (piece: string, fn: string, material: string, x: number, y: number, extra: Partial<PlacedPart> = {}): void => {
    parts.push({ uid: uid++, piece, fn, material, x, y, rot: 0, flip: false, ...extra });
  };
  const hullMat = catalog.functions.get(HULL)?.material ?? 'alloy';

  // Columns, left to right: each gun's slot (a side mount keeps a hull column on the side it bolts on at)
  let x = 0;
  const slots = ids.map((id, i) => {
    const fp = fps[i]!, west = fp.attach === 'W' ? 1 : 0, east = fp.attach === 'E' ? 1 : 0;
    const slot = { id, fp, west, east, x: x + west };
    x += west + fp.w + east;
    return slot;
  });
  const width = Math.max(4, x + (x % 2));

  // Guns, then their hull columns
  let demand = 0;
  for (const s of slots) {
    const f = catalog.functions.get(s.id)!;
    add(s.fp.piece, s.id, f.material ?? hullMat, s.x + s.fp.ox, -s.fp.h + s.fp.oy, { rot: s.fp.rot, flip: s.fp.flip, facing: 'N' as Side, ...(f.mount ? { mount: f.mount } : {}) });
    for (let r = 0; r < s.fp.h; r++) {
      if (s.west) add('sq', HULL, hullMat, s.x - 1, -s.fp.h + r);
      if (s.east) add('sq', HULL, hullMat, s.x + s.fp.w, -s.fp.h + r);
    }
    demand += (f.demand ?? 0) * s.fp.w * s.fp.h;
  }
  // The spine, with the core in the middle (two cells of it)
  const coreAt = Math.floor((width - 2) / 2);
  for (let c = 0; c < width; c++) {
    if (c === coreAt) { add('rect2', CORE, hullMat, c, 0); c++; continue; }
    add('sq', HULL, hullMat, c, 0);
  }
  // Reactors in rows below, full width (hull fills an odd end)
  const reactor = catalog.functions.get(REACTOR);
  const drive = catalog.functions.get(DRIVE);
  const drives = 4;
  demand += (drive?.demand ?? 9) * drives;
  const perReactor = (reactor?.produce ?? 62) * 2;
  const need = Math.max(2, Math.ceil((demand * 1.6) / perReactor));
  const perRow = Math.floor(width / 2);
  const rows = Math.ceil(need / perRow);
  let placed = 0;
  for (let r = 1; r <= rows; r++) {
    for (let c = 0; c + 1 < width; c += 2) {
      if (placed < need) { add('rect2', REACTOR, reactor?.material ?? 'titanium', c, r); placed++; }
      else { add('sq', HULL, hullMat, c, r); add('sq', HULL, hullMat, c + 1, r); }
    }
  }
  // Drives under the last row, facing south: spread along it
  const driveRow = rows + 1;
  for (let i = 0; i < drives; i++) add('sq', DRIVE, drive?.material ?? hullMat, Math.round((i * (width - 1)) / (drives - 1)), driveRow, { facing: 'S' as Side });

  const name = ids[0] === ids[1] ? `Range rig: ${catalog.functions.get(ids[0])?.name ?? ids[0]} x2` : `Range rig: ${catalog.functions.get(ids[0])?.name ?? ids[0]} + ${catalog.functions.get(ids[1])?.name ?? ids[1]}`;
  return { name, catalogVersion: catalog.version, parts };
}
