/**
 * Weapon groups in the field build overlay (ships/field/FieldOverlay.ts): the live ship's weapons, edited with the same
 * keys as the hangar (editor.ts) but sent as a `weaponGroups` message (free, no plan save; the server refits the live
 * ship with the new groups and every client that holds it gets the new design).
 */
import { partWeaponGroups } from '@space-game/common';
import type { PlacedGeom, ShipState } from '@space-game/common';
import { groupColor, groupOfKey, groupsSaid, markOffsets, toggledMask, weaponParts } from './editor';

export interface FieldGroupEdit {
  send: { type: 'weaponGroups'; groups: Record<number, number> };
  said: string;
}

/**
 * Key `code` over the part with `uid` toggles that group on it, if it is a standing weapon of `ship`. Returns the message
 * to send and what to say, why it can't be done, or null (not for this: another key, not a weapon, nothing changes)
 */
export function fieldGroupEdit(code: string, ship: ShipState, uid: number, unsavedPlan: boolean): FieldGroupEdit | { problem: string } | null {
  const g = groupOfKey(code);
  const i = ship.blueprint.parts.findIndex((p) => p.uid === uid);
  if (!g || i < 0 || ship.ghost?.[i] || !weaponParts(ship.derived).has(i)) return null;
  // (The ship is rebuilt with the new groups, and a draft under it starts again: so not over unsaved edits)
  if (unsavedPlan) return { problem: 'Save or clear your plan first, then set groups' };
  const p = ship.blueprint.parts[i];
  const next = toggledMask(partWeaponGroups(p), g);
  if (next === partWeaponGroups(p)) return null;
  return { send: { type: 'weaponGroups', groups: { [uid]: next } }, said: groupsSaid({ ...p, wg: next }) };
}

/** What the overlay draws a square with (pixi Graphics' rect then fill) */
interface RectDraw { rect(x: number, y: number, w: number, h: number): { fill(o: { color: number; alpha: number }): unknown } }

/** The overlay's marks: group squares on each standing weapon of the live ship, at its centre (`geomOf`: the draft's geometry by uid) */
export function drawFieldGroups(g: RectDraw, ship: ShipState, geomOf: (uid: number) => PlacedGeom | undefined, at: (gx: number, gy: number) => [number, number], cs: number): void {
  const size = cs * 0.12;
  for (const w of ship.derived.weapons) {
    const p = ship.blueprint.parts[w.part];
    if (!p || ship.ghost?.[w.part]) continue;
    const geom = geomOf(p.uid);
    if (!geom) continue;
    const [cx, cy] = at(geom.centroid[0], geom.centroid[1]);
    for (const m of markOffsets(partWeaponGroups(p))) {
      g.rect(cx + m.dx * size - size / 2, cy + m.dy * size - size / 2, size, size).fill({ color: Number.parseInt(groupColor(m.g).slice(1), 16), alpha: 0.95 });
    }
  }
}
