/**
 * @contract client.hangar.delta
 * owns:       the hangar's stat-delta preview: which change the cursor means (the part in hand here, or the part under it removed),
 *             the card at the cursor, and the +/- chips in the stats panel (build/statDelta.ts, statDeltaView.ts)
 * needs:      HangarHost (bp, mouse, candidate, placementProblem, partAt, stats, deps); build/statDelta, build/statDeltaView
 * invariants: derives only when the cell, the hand or the design changes — client/src/ships/build/statDelta.test.ts
 * extend:     a stat shown in the panel is one data-sd span in hangarStats.ts and an entry in statDelta.ts STATS
 */
import { DeltaHover, applyChips } from '../build/statDeltaView';
import { changeFor } from '../build/statDelta';
import type { HangarHost } from './host';

/** The hangar's hover: made once, kept on the host */
export function makeDeltaHover(host: HangarHost): DeltaHover {
  return new DeltaHover(() => host.deps, (d) => { host.deltaNow = d; applyChips(host.stats, d); });
}

/** Bring the preview in line with the cursor, the hand and the design. Cheap when nothing changed */
export function syncDelta(host: HangarHost): void {
  const at = host.mouse, px = host.mouseClient;
  if (!host.isOpen || !at || !px) return host.deltaHover.clear();
  const cand = host.candidate(at);
  const i = host.partAt(at);
  const change = changeFor({
    candidate: cand,
    problem: cand ? host.placementProblem(cand) : null,
    under: i >= 0 ? host.bp.parts[i] : null,
    name: (p) => host.deps.catalog.functions.get(p.fn)?.name ?? p.fn,
  });
  const budget = host.free ? undefined : host.deps.hangarState()?.budget;
  host.deltaHover.update({ rev: String(host.tipGen), bp: () => host.bp, change, budget, x: px.x, y: px.y });
}
