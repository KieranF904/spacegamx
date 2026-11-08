/**
 * @contract client.ships.build.edit-placed
 * owns:       turning, mirroring or re-facing a part already on the ship in the hangar and the world build view: which part is
 *             under the cursor, the turned copy (anchored so the cell under the cursor stays put) and the rules it must pass;
 *             also the Escape step shared by both editors (clear the hand first, close second)
 * needs:      common placeGeometry / overlapsAny / facingProblem / computeJoins / partMountingProblems / gunFacing / getVariant
 *             (the game's own placement rules); no DOM, no editor state
 * invariants: the turned part keeps its uid and the cell of it under the cursor where the new shape has that cell — client/src/ships/build/editPlaced.test.ts
 *             a turn that overlaps, blocks a facing edge, breaks a mounting rule or cuts a part off from what it joined is refused with a reason — client/src/ships/build/editPlaced.test.ts
 *             a fixed-barrel gun's facing is its barrel's, never chosen — client/src/ships/build/editPlaced.test.ts
 *             Escape puts a part in hand away, and closes only with an empty hand — client/src/ships/build/editPlaced.test.ts
 * extend:     a new kind of edit on a placed part is one more TurnOp and one case in turnedCopy()
 */

import {
  placeGeometry, overlapsAny, facingProblem, computeJoins, partMountingProblems, gunFacing, hasFixedBarrel, partNeedsFacing, getVariant,
  geomContainsPoint, transformDir, sideFromNormal, SIDES, SIDE_NORMAL,
} from '@space-game/common';
import type { Catalog, PlacedPart, Rot, Side, Vec2 } from '@space-game/common';

/** R turns a quarter, F mirrors, T moves a free facing to the next side */
export type TurnOp = 'rot' | 'flip' | 'face';

export const TURN_KEYS: Record<string, TurnOp> = { KeyR: 'rot', KeyF: 'flip', KeyT: 'face' };

/** The part under a grid point (the later one wins), -1 none */
export function partUnder(catalog: Catalog, parts: readonly PlacedPart[], at: Vec2): number {
  for (let i = parts.length - 1; i >= 0; i--) if (geomContainsPoint(placeGeometry(catalog, parts[i]), at[0], at[1])) return i;
  return -1;
}

export type TurnResult = { part: PlacedPart; said: string } | { problem: string };

/** A facing carried through a turn or a mirror of the part as it stands (the world direction it points, turned or mirrored) */
function carriedFacing(side: Side, p: PlacedPart, op: 'rot' | 'flip'): Side {
  const d = SIDE_NORMAL[side];
  if (op === 'rot') return sideFromNormal(transformDir(d, 1, false));
  // (The flip toggles the part's own mirror before its turn: undo the turn, mirror, redo it)
  const back = transformDir(d, ((4 - p.rot) % 4) as Rot, false);
  return sideFromNormal(transformDir(transformDir(back, 0, true), p.rot, false));
}

/** The copy of part `p` after `op`, keeping the cell of it under `at` where it is (`why`: nothing to change) */
function turnedCopy(catalog: Catalog, p: PlacedPart, op: TurnOp, at: Vec2): { part: PlacedPart } | { why: string } {
  if (op === 'face') {
    if (!partNeedsFacing(p.fn)) return { why: 'this part has no facing to change' };
    if (hasFixedBarrel(catalog, p.fn)) return { why: 'a gun fires out of one side of its piece: turn it with R' };
    const at0 = SIDES.indexOf((p.facing ?? 'N') as Side);
    return { part: { ...p, facing: SIDES[(at0 + 1) % SIDES.length] } };
  }
  const rot = (op === 'rot' ? (p.rot + 1) % 4 : p.rot) as Rot;
  const flip = op === 'flip' ? !p.flip : p.flip;
  const part: PlacedPart = { ...p, rot, flip };
  // The piece's cell under the cursor: the same cell of the new shape goes back under it (cells keep their order across turns)
  const from = getVariant(catalog, p.piece, p.rot, p.flip).cells;
  const to = getVariant(catalog, p.piece, rot, flip).cells;
  const cx = Math.floor(at[0]), cy = Math.floor(at[1]);
  const k = from.findIndex((c) => c[0] + p.x === cx && c[1] + p.y === cy);
  if (k >= 0 && to[k]) { part.x = cx - to[k][0]; part.y = cy - to[k][1]; }
  if (p.facing && partNeedsFacing(p.fn)) part.facing = gunFacing(catalog, part) ?? carriedFacing(p.facing as Side, p, op);
  return { part };
}

const bare = (m: string) => m.replace(/^[^:]*?\d+: /, '');

/** Why `next` can't stand where part `i` of `parts` is, or null: the rules a placed part must keep (not the licence: it is already there) */
export function turnProblem(catalog: Catalog, parts: readonly PlacedPart[], i: number, next: PlacedPart): string | null {
  const all = parts.map((p) => placeGeometry(catalog, p));
  const others = all.filter((_, k) => k !== i);
  const g = placeGeometry(catalog, next);
  if (overlapsAny(g, others)) return 'overlaps another part';
  const now = [...others, g], self = others.length;
  if (next.facing) {
    const why = facingProblem(next.fn, now, self, next.facing as Side);
    const fix = hasFixedBarrel(catalog, next.fn) ? 'turn it another way (R)' : 'press T for another side';
    if (why === 'noEdge') return `no straight edge facing ${next.facing} on this piece: ${fix}`;
    if (why === 'blocked') return `its ${next.facing} edge is blocked: ${fix}`;
    if (why === 'notJoined') return `its ${next.facing} edge (where power leaves) must touch a part: ${fix}`;
  }
  const joins = (gs: typeof all, k: number) => computeJoins(gs).some(([a, b]) => a === k || b === k);
  if (joins(all, i) && !joins(now, self)) return 'it would no longer join the ship';
  // Mounting rules: anything now broken that wasn't before (the part's own, and a gun whose lane it now blocks)
  const was = new Set<string>();
  all.forEach((_, k) => partMountingProblems(catalog, all, k).forEach((m) => was.add(m.message)));
  const fresh: string[] = [];
  now.forEach((_, k) => partMountingProblems(catalog, now, k).forEach((m) => { if (!was.has(m.message)) fresh.push(bare(m.message)); }));
  return fresh.length ? fresh.join('; ') : null;
}

const SAID: Record<TurnOp, string> = { rot: 'Turned', flip: 'Mirrored', face: 'Facing' };
const CANT: Record<TurnOp, string> = { rot: "can't turn", flip: "can't mirror", face: "can't change its facing" };

/**
 * Do `op` to part `i` of `parts` with the cursor at `at`. T tries the following sides in turn until one passes (so it
 * skips a blocked side while another is free); the reason given is the first side's
 */
export function tryTurn(catalog: Catalog, parts: readonly PlacedPart[], i: number, op: TurnOp, at: Vec2): TurnResult {
  let p = parts[i], first: string | null = null;
  const tries = op === 'face' ? SIDES.length - 1 : 1;
  for (let n = 0; n < tries; n++) {
    const r = turnedCopy(catalog, p, op, at);
    if ('why' in r) return { problem: r.why };
    const why = turnProblem(catalog, parts, i, r.part);
    if (!why) return { part: r.part, said: op === 'face' ? `${SAID[op]}: ${r.part.facing}` : SAID[op] };
    first ??= why;
    p = r.part;
  }
  return { problem: `${CANT[op]} there: ${first}` };
}

/** What Escape does: a part in hand is put away first; with an empty hand the editor closes */
export function escapeStep(handEmpty: boolean): 'empty-hand' | 'close' {
  return handEmpty ? 'close' : 'empty-hand';
}
