/**
 * @contract client.hangar.edit
 * owns:       the hangar's grid editing: the part in hand as a candidate, placement rules, place, pick up, paint-drag, remove, new design
 * needs:      HangarUI (its fields, as the first argument), hangar/hangarAids, common ship geometry and mounting; npm: @space-game/common
 * invariants: the hangar edits a copy of the blueprint until Save — none pinned
 * extend:     a new placement rule is a case in placementProblem
 */

import { DragPaint } from '../build/dragPaint';
import { SIDES, partItemId, PlacedPart, Side, Vec2, placeGeometry, overlapsAny, facingProblem, geomContainsPoint, nextFreeUid, partNeedsFacing, gunFacing, hasFixedBarrel, mountingOf, partMountingProblems, type MountingProblem } from '@space-game/common';
import { modelLock } from '../modelCards';
import { TURN_KEYS, partUnder, tryTurn } from '../build/editPlaced';
import { ruleText } from './hangarTips';
import type { HangarUI } from '../HangarUI';

const DEFAULT_FACING: Record<string, Side> = { thruster: 'S', weapon: 'N', miner: 'N' };

export function candidate(ui: HangarUI, g: Vec2): PlacedPart | null {
  if (ui.sel.empty) return null;
  const uid = nextFreeUid(ui.bp);
  if (uid < 0) return null;
  // (A model is always made of its own material)
  const fd = ui.deps.catalog.functions.get(ui.sel.fn);
  const p: PlacedPart = {
    uid, piece: ui.sel.piece, fn: ui.sel.fn, material: fd?.model && fd.material ? fd.material : ui.sel.material,
    x: Math.floor(g[0]), y: Math.floor(g[1]), rot: ui.sel.rot, flip: ui.sel.flip,
  };
  if (partNeedsFacing(p.fn)) p.facing = gunFacing(ui.deps.catalog, p) ?? pickFacing(ui, p);
  return p;
}

/** Explicit facing, or the first side with a free straight edge (preferring the function's usual side). */
export function pickFacing(ui: HangarUI, p: PlacedPart): Side {
  if (ui.sel.facing !== 'auto') return ui.sel.facing;
  const g = placeGeometry(ui.deps.catalog, p);
  const all = [...ui.geoms, g];
  const pref = DEFAULT_FACING[p.fn] ?? 'N';
  const order = [pref, ...SIDES.filter((s) => s !== pref)];
  // (Free, or for a Diode joined: partFacingRule)
  const free = (side: Side) => !facingProblem(p.fn, all, all.length - 1, side);
  // A weapon with mounting rules: the first side it fires out of that keeps them all (bolted on where it must be,
  // its barrel clear), else the first free one, so the preview shows what's wrong
  if (mountingOf(ui.deps.catalog, p.fn)?.rules) {
    for (const side of order) {
      if (!free(side)) continue;
      const q = { ...p, facing: side };
      if (!partMountingProblems(ui.deps.catalog, [...ui.geoms, placeGeometry(ui.deps.catalog, q)], all.length - 1).length) return side;
    }
  }
  for (const side of order) if (free(side)) return side;
  return pref;
}

/** Why a candidate can't go here, or null if it can. */
export function placementProblem(ui: HangarUI, p: PlacedPart): string | null {
  const fn = ui.deps.catalog.functions.get(p.fn)!;
  if (fn.pieces !== '*' && !fn.pieces.includes(p.piece)) return `${p.fn} can't go on ${p.piece}`;
  const id = partItemId(p);
  // (One you have still needs its licence to fit, as the server checks; free build needs neither)
  if (!ui.free && !ui.deps.canMake(id)) {
    const lock = fn.model ? modelLock(fn, false, ui.deps.level?.() ?? 1, ui.deps.econ.items.all()).why : '';
    return `${ui.remaining(id) > 0 ? "you aren't licensed to fit" : "you can't make"} ${ui.deps.econ.items.name(id)} yet${lock ? `: ${lock.charAt(0).toLowerCase()}${lock.slice(1)}` : ''}`;
  }
  const g = placeGeometry(ui.deps.catalog, p);
  if (overlapsAny(g, ui.geoms)) return 'overlaps another part';
  // It must point out of a free straight edge (T or the Facing buttons pick another side)
  // (A Diode's instead must touch a part: power leaves by it)
  if (p.facing) {
    const why = facingProblem(p.fn, [...ui.geoms, g], ui.geoms.length, p.facing as Side);
    const fix = hasFixedBarrel(ui.deps.catalog, p.fn) ? 'turn it (R)' : 'press T for another side';
    if (why === 'noEdge') return `no straight edge facing ${p.facing} on this piece: ${fix}`;
    if (why === 'blocked') return `its ${p.facing} edge is blocked: ${fix}`;
    if (why === 'notJoined') return `its ${p.facing} edge (where power leaves) must touch a part: ${fix}`;
  }
  // (A part that joins nothing may be planned: it shows "not connected" and builds once something joins it)
  // Its mounting rules (always: free build skips ownership, never these)
  const broken = candidateMounting(ui, p, g);
  if (broken.length) return broken.map((m) => ruleText(m)).join('; ');
  return null;
}

/** The mounting rules a part in hand would break where it is (common partMountingProblems) */
export function candidateMounting(ui: HangarUI, p: PlacedPart, g = placeGeometry(ui.deps.catalog, p)): MountingProblem[] {
  return ui.geoms.length ? partMountingProblems(ui.deps.catalog, [...ui.geoms, g], ui.geoms.length) : [];
}

export function place(ui: HangarUI, g: Vec2): void {
  // (An empty hand: a click on a placed part picks it up, as middle-click does; on an empty cell it does nothing)
  if (ui.sel.empty) return pickUp(ui, g);
  const p = candidate(ui, g);
  if (!p) return ui.status('blueprint is full (255 parts)');
  const problem = placementProblem(ui, p);
  if (problem) return ui.status(problem);
  ui.aids.edit(() => {
    ui.bp.parts.push(p);
    ui.refresh();
    ui.aids.placeMirror(p);
  });
}

export function partAt(ui: HangarUI, g: Vec2): number {
  for (let i = ui.geoms.length - 1; i >= 0; i--) if (geomContainsPoint(ui.geoms[i], g[0], g[1])) return i;
  return -1;
}

/** R / F / T with the mouse over a placed part: turn, mirror or re-face that part in place (build/editPlaced.ts). False: no part there */
export function turnPlaced(ui: HangarUI, code: string): boolean {
  const i = ui.mouse ? partUnder(ui.deps.catalog, ui.bp.parts, ui.mouse) : -1;
  if (i < 0 || !ui.mouse) return false;
  const r = tryTurn(ui.deps.catalog, ui.bp.parts, i, TURN_KEYS[code], ui.mouse);
  if ('problem' in r) { ui.status(r.problem); return true; }
  ui.aids.edit(() => {
    ui.bp.parts[i] = r.part;
    const note = ui.aids.followTurn(i, ui.mouse!);
    ui.status(r.said + note);
    ui.refresh();
  });
  return true;
}

/** Middle-click: put the part under the cursor in hand, exactly as it's placed (piece, function, material, turn, mirror, facing) */
export function pickUp(ui: HangarUI, g: Vec2): void {
  const i = partAt(ui, g);
  if (i < 0) return;
  const p = ui.bp.parts[i];
  ui.sel = { piece: p.piece, fn: p.fn, material: p.material, rot: p.rot, flip: p.flip, facing: p.facing ? (p.facing as Side) : 'auto' };
  ui.status(`picked up: ${ui.deps.econ.items.name(partItemId(p))}`);
  ui.pal.showInHand();
  ui.draw();
}

/** (the mirror of the cell pressed counts as visited too) */
export function startDrag(ui: HangarUI, button: 0 | 2, g: Vec2): void {
  const paint = new DragPaint(g), m = ui.aids.mirrorOf(g);
  if (m) paint.mark(m);
  ui.drag = { button, paint };
}

/** The held button is up: the drag's edits close as one undo step */
export function stopDrag(ui: HangarUI): void {
  ui.drag = null;
  ui.aids.endDrag();
}

export function dragTo(ui: HangarUI, e: MouseEvent, g: Vec2): void {
  const d = ui.drag;
  if (!d) return;
  if (!(e.buttons & (d.button === 0 ? 1 : 2))) { stopDrag(ui); return; }
  for (const at of d.paint.visit(g)) {
    const m = ui.aids.mirrorOf(at);
    if (m) d.paint.mark(m);
    if (d.button === 0) place(ui, at); else remove(ui, at);
  }
}

export function remove(ui: HangarUI, g: Vec2, mirrored = false): void {
  const i = partAt(ui, g);
  if (i < 0) return;
  ui.aids.edit(() => {
    // (What it held on to stays, planned and not connected, until something joins it again)
    ui.bp.parts = ui.bp.parts.filter((_, k) => k !== i);
    ui.refresh();
    // (symmetry: the part across the centre line goes too)
    const m = mirrored ? null : ui.aids.mirrorOf(g);
    if (m) remove(ui, m, true);
  });
}

export function newBlueprint(ui: HangarUI): void {
  ui.aids.edit(() => {
    ui.bp = { name: 'New ship', catalogVersion: ui.deps.catalog.version, power: 'ports', parts: [
      { uid: 0, piece: 'sq', fn: 'core', material: 'alloy', x: 0, y: 0, rot: 0, flip: false },
    ] };
  });
  ui.plan = undefined;
  ui.recenter();
  ui.refresh();
}
