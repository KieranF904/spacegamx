/**
 * Editing which weapon groups a weapon is in (docs/design/groups-mines-docking.md, "Weapon groups"), in the hangar (saved
 * with the design) and in the field build overlay (the live ship, a `weaponGroups` message, free). Both work the same
 * way: hover a weapon and press 1-5 to put it in, or take it out of, that group. A weapon is always in at least one
 * group. Each weapon shows its groups as small coloured squares, one per group it is in.
 *
 * Pure helpers here; HangarUI and FieldOverlay call them with one line each.
 */
import { WEAPON_GROUPS, inGroup, partWeaponGroups, cleanWeaponGroups } from '@space-game/common';
import type { Blueprint, PlacedGeom, PlacedPart, ShipState } from '@space-game/common';

/** Every group's number, in order */
export const ALL_GROUPS: readonly number[] = Array.from({ length: WEAPON_GROUPS }, (_, i) => i + 1);

/** A group's colour (1-5) */
export const GROUP_COLORS = ['#7dd3fc', '#fbbf24', '#c4b5fd', '#4ade80', '#fb7185'] as const;
export const groupColor = (g: number): string => GROUP_COLORS[g - 1] ?? '#ffffff';

/** The group a key picks (Digit1..Digit5), or 0 */
export function groupOfKey(code: string): number {
  const m = /^Digit([1-5])$/.exec(code);
  return m ? Number(m[1]) : 0;
}

/** A weapon's mask with group g toggled; never empty (the last group stays: a weapon in none would never fire) */
export function toggledMask(mask: number, g: number): number {
  if (g < 1 || g > WEAPON_GROUPS) return mask;
  const next = mask ^ (1 << (g - 1));
  return next === 0 ? mask : next;
}

/** The part indices that are weapons (the ones a group means something for) */
export function weaponParts(derived: Pick<ShipState['derived'], 'weapons'> | null | undefined): Set<number> {
  return new Set((derived?.weapons ?? []).map((w) => w.part));
}

/** The groups of a mask, as numbers: [1, 3] */
export const groupsOf = (mask: number): number[] => ALL_GROUPS.filter((g) => inGroup(mask, g));

/**
 * The hangar: key `code` over part `index` of the design toggles that group on it, in place. Returns the part when
 * it changed (the caller redraws and says it), else null
 */
export function hangarGroupKey(code: string, bp: Blueprint, derived: Pick<ShipState['derived'], 'weapons'> | null, index: number): PlacedPart | null {
  const g = groupOfKey(code);
  const p = bp.parts[index];
  if (!g || !p || !weaponParts(derived).has(index)) return null;
  const next = toggledMask(partWeaponGroups(p), g);
  if (next === partWeaponGroups(p)) return null;
  const wg = cleanWeaponGroups(next);
  if (wg === undefined) delete p.wg; else p.wg = wg;
  return p;
}

/** What a toggled weapon says, for the status line: "Weapon in groups 1, 3" */
export const groupsSaid = (p: PlacedPart): string => `Weapon in group${groupsOf(partWeaponGroups(p)).length > 1 ? 's' : ''} ${groupsOf(partWeaponGroups(p)).join(', ')}`;

/** A weapon's group squares: where each sits (offsets from the part's centre, in units of `size`), one per group it is in */
export function markOffsets(mask: number): { g: number; dx: number; dy: number }[] {
  const gs = groupsOf(mask);
  return gs.map((g, i) => ({ g, dx: (i - (gs.length - 1) / 2) * 1.25, dy: 0 }));
}

/** The hangar's marks: a weapon's group squares at its centre (2D canvas; `sx`, `sy` take grid points to pixels) */
export function drawHangarGroups(ctx: CanvasRenderingContext2D, bp: Blueprint, geoms: readonly PlacedGeom[], derived: Pick<ShipState['derived'], 'weapons'> | null, sx: (x: number) => number, sy: (y: number) => number, px: number): void {
  const weapons = weaponParts(derived);
  // (Only once some weapon is in another group than 1: with the default every weapon would carry a square)
  if (![...weapons].some((i) => bp.parts[i] && partWeaponGroups(bp.parts[i]) !== 1)) return;
  const size = Math.max(4, px * 0.12);
  for (const i of weapons) {
    const p = bp.parts[i], g = geoms[i];
    if (!p || !g) continue;
    const cx = sx(g.centroid[0]), cy = sy(g.centroid[1]);
    for (const m of markOffsets(partWeaponGroups(p))) {
      ctx.fillStyle = groupColor(m.g);
      ctx.globalAlpha = 0.95;
      ctx.fillRect(cx + m.dx * size - size / 2, cy + m.dy * size - size / 2, size, size);
    }
  }
  ctx.globalAlpha = 1;
}
