/**
 * @contract common.gun-range.cheat-ship
 * owns:       the gun range's cheat ship: a plain alloy bar of a ship carrying one chosen weapon model, fitted by its own
 *             mounting rules, with reactors to spare and the range flag (Blueprint.range: its guns never want for power: a beam still burns in pieces and rests,
 *             no jump drive)
 * needs:      ships/{catalog, types, mounting, grid, gunFacing}, ./mods (the deck of weapon modifiers behind the gun)
 * invariants: every weapon model makes a valid ship (mounting rules kept) whose one gun never wants for power, with
 *             any of the weapon modifiers or none; one with none is the ship it always was —
 *             common/src/gunRange/cheatShip.test.ts
 * extend:     a new kind of mount is a case in fit() (the turn that puts its barrel north, the side it bolts on at)
 *
 * Layout (north is up; the gun fires north):
 *   row -h..-1  the gun, on the spine's middle (a side-mount gun gets a hull column on the side it bolts on at)
 *               (with weapon modifiers: the gun lifted, and their deck between it and the spine, hull around it: mods.ts)
 *   row 0       the spine: hull, with the core in the middle
 *   rows 1..    reactors (enough for the gun and the drives, with room to spare), then the drives facing south
 * A fixed gun points out of the nose; a turret sits on the nose and turns within its arc; a right-angle (side) mount
 * bolts on at its side. Pure and deterministic; the result is a plain Blueprint (it validates like any other).
 */

import type { Catalog } from '../ships/catalog.js';
import type { Blueprint, PlacedPart, Rot, Side } from '../ships/types.js';
import { attachSide, mountingOf, partMountingProblems } from '../ships/mounting.js';
import { facingEdges, placeGeometry } from '../ships/grid.js';
import { gunFacing } from '../ships/gunFacing.js';
import { buildModDeck, type RangeMods } from './mods.js';

const HULL = 'hull', CORE = 'core', REACTOR = 'power_overclock_reactor', DRIVE = 'engine_ion_drive';
/** The name every cheat ship goes by, before its gun's */
export const CHEAT_SHIP_PREFIX = 'Range ship';

/** The gun as the ship fits it: its piece, how it is turned so it fires north, its size, and the side it bolts on at */
interface Fit { piece: string; rot: Rot; flip: boolean; w: number; h: number; ox: number; oy: number; attach: Side }

/** Turn (and mirror) the gun until it has a free straight edge to fire north out of and its bolt-on edge, else null */
function fit(catalog: Catalog, fn: string): Fit | null {
  const f = catalog.functions.get(fn);
  if (!f?.weapon || !f.model || !Array.isArray(f.pieces) || !f.pieces.length || !catalog.pieces.get(f.pieces[0])) return null;
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

/** Is this a weapon model the cheat ship can carry */
export function isRangeWeapon(catalog: Catalog, fn: string): boolean {
  return !!fit(catalog, fn);
}

/**
 * The cheat ship for one weapon model (null: not a weapon model it can carry). Reactors for 1.6x everything's demand plus
 * a full drive set, so it flies at full power too; its guns never want for power anyway (Blueprint.range).
 * `mods`: the weapon modifiers to carry behind the gun (each at full strength on a range ship); none, or a gun that
 * can't take them, is the plain ship.
 */
export function buildCheatShip(catalog: Catalog, model: string, mods?: RangeMods): Blueprint | null {
  const fp = fit(catalog, model);
  if (!fp) return null;
  const f = catalog.functions.get(model)!;
  const parts: PlacedPart[] = [];
  let uid = 0;
  const add = (piece: string, fn: string, material: string, x: number, y: number, extra: Partial<PlacedPart> = {}): void => {
    parts.push({ uid: uid++, piece, fn, material, x, y, rot: 0, flip: false, ...extra });
  };
  const hullMat = catalog.functions.get(HULL)?.material ?? 'alloy';

  // The gun's columns (a side mount keeps a hull column on the side it bolts on at), centred on the spine
  let west = fp.attach === 'W' ? 1 : 0, east = fp.attach === 'E' ? 1 : 0;
  // The modifier deck, worked out with the gun's corner at the origin: it widens the ship and lifts the gun off the spine
  const gun: PlacedPart = { uid: 0, piece: fp.piece, fn: model, material: f.material ?? hullMat, x: fp.ox, y: fp.oy, rot: fp.rot, flip: fp.flip, facing: 'N' as Side, ...(f.mount ? { mount: f.mount } : {}) };
  const deck = mods?.effects.length ? buildModDeck(catalog, gun, mods) ?? [] : [];
  const taken = new Set<string>();
  let lift = 0;
  const hullW = west, hullE = east;
  for (const q of deck) for (const c of placeGeometry(catalog, q).cells) {
    taken.add(`${c[0]},${c[1]}`);
    west = Math.max(west, -c[0]); east = Math.max(east, c[0] - fp.w + 1); lift = Math.max(lift, c[1] - fp.h + 1);
  }
  const span = west + fp.w + east;
  const width = Math.max(4, span + (span % 2));
  const gx = Math.floor((width - span) / 2) + west, gy = -fp.h - lift;

  add(gun.piece, model, gun.material, gx + gun.x, gy + gun.y, { rot: gun.rot, flip: gun.flip, facing: gun.facing, ...(gun.mount ? { mount: gun.mount } : {}) });
  for (let r = 0; r < fp.h; r++) {
    if (hullW && !taken.has(`-1,${r}`)) add('sq', HULL, hullMat, gx - 1, gy + r);
    if (hullE && !taken.has(`${fp.w},${r}`)) add('sq', HULL, hullMat, gx + fp.w, gy + r);
  }
  for (const q of deck) { const { uid: _u, piece, fn, material, x, y, ...rest } = q; add(piece, fn, material, gx + x, gy + y, rest); }
  // (hull around the deck, down to the spine)
  for (let r = fp.h; r < fp.h + lift; r++) for (let c = -west; c < fp.w + east; c++) if (!taken.has(`${c},${r}`)) add('sq', HULL, hullMat, gx + c, gy + r);
  let demand = (f.demand ?? 0) * fp.w * fp.h;
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

  return { name: `${CHEAT_SHIP_PREFIX}: ${f.name ?? model}`, catalogVersion: catalog.version, parts, range: true };
}
