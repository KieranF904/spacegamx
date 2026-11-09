/**
 * @contract client.ships.build-symmetry-turn
 * owns:       the other half of a turn, mirror or re-face in symmetry mode: which part across the axis follows, and the copy it becomes
 * needs:      build/symmetry (the mirror), build/editPlaced (partUnder, turnProblem: the rules a turned part must keep)
 * invariants: the follower is the part under the mirrored cursor, made the exact mirror of the turned part, keeping its own uid — client/src/ships/build/symmetryTurn.test.ts
 *             a different part there, or a turn the rules refuse, leaves it alone with a reason — client/src/ships/build/symmetryTurn.test.ts
 *             a part on the axis has no follower — client/src/ships/build/symmetryTurn.test.ts
 * extend:     none: an editor calls mirrorFollow() after it has applied its own turn
 */

import type { Catalog, PlacedPart, Vec2 } from '@space-game/common';
import { partUnder, turnProblem } from './editPlaced';
import { mirrorPart, mirrorPoint } from './symmetry';

export type MirrorFollow = { j: number; part: PlacedPart } | { skip: string } | null;

/**
 * After part `i` of `parts` was turned (its new state is already in `parts`) with the cursor at `at`: the part across the
 * axis that should follow. Null: nothing to do (on the axis, or already the mirror); `skip`: why it can't
 */
export function mirrorFollow(catalog: Catalog, parts: readonly PlacedPart[], i: number, at: Vec2, axis2: number): MirrorFollow {
  const j = partUnder(catalog, parts, mirrorPoint(at, axis2));
  if (j < 0) return { skip: 'nothing on the mirror side' };
  if (j === i) return null;
  const p = parts[i], q = parts[j];
  if (p.piece !== q.piece || p.fn !== q.fn || p.material !== q.material) return { skip: 'the mirror side is a different part' };
  const m = mirrorPart(catalog, p, axis2);
  if (!m) return { skip: 'mirror side blocked' };
  m.uid = q.uid;
  if (m.x === q.x && m.y === q.y && m.rot === q.rot && m.flip === q.flip && m.facing === q.facing) return null;
  const why = turnProblem(catalog, parts, j, m);
  return why ? { skip: `mirror side blocked: ${why}` } : { j, part: m };
}
