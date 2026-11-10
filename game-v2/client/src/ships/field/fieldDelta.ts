/**
 * @contract client.field.delta
 * owns:       the world build view's stat-delta card: which change the cursor means on the working design (the hand's part here, or the
 *             part under the cursor taken out), measured on the design the fabricator would build (planTarget)
 * needs:      npm: @space-game/common; plan.ts (planTarget, partAtPoint, WorkingDesign), build/statDelta, build/statDeltaView, FieldDeps' catalog / tuning / econ
 * invariants: derives only when the cell, the hand or the working design changes — client/src/ships/build/statDelta.test.ts
 * extend:     none: the stats it lists are build/statDelta.ts STATS
 */
import type { Blueprint, Catalog, Economy, PlacedPart, ShipTuning, Vec2 } from '@space-game/common';
import { DeltaHover } from '../build/statDeltaView';
import { changeFor } from '../build/statDelta';
import { partAtPoint, planTarget, type WorkingDesign } from './plan';

export interface FieldDeltaIn {
  catalog: Catalog;
  w: WorkingDesign;
  /** Names the design's revision (changes when the working design object does) */
  rev: string;
  /** Grid point under the cursor, or null when it is off the ship / over a panel */
  at: Vec2 | null;
  client: { x: number; y: number } | null;
  /** The hand's part there and why it can't go (null part: empty hand) */
  hand: { part: PlacedPart; problem: string | null } | null;
}

export function makeFieldDelta(ctx: () => { catalog: Catalog; tuning: ShipTuning; econ: Economy }): DeltaHover {
  return new DeltaHover(ctx);
}

export function syncFieldDelta(h: DeltaHover, i: FieldDeltaIn | null): void {
  if (!i || !i.at || !i.client) return h.clear();
  const k = partAtPoint(i.catalog, i.w, i.at);
  const under = k >= 0 && !i.w.marked.has(i.w.bp.parts[k].uid) ? i.w.bp.parts[k] : null;
  const change = changeFor({
    candidate: i.hand?.part ?? null,
    problem: i.hand?.problem ?? null,
    under,
    name: (p) => i.catalog.functions.get(p.fn)?.name ?? p.fn,
  });
  h.update({ rev: i.rev, bp: (): Blueprint => planTarget(i.w), change, x: i.client.x, y: i.client.y });
}
