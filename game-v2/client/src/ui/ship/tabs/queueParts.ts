/**
 * The fabricator queue's inputs from the live ship (fabQueue.ts is the pure model): each part's state, what its job
 * takes from the hold (common econ/field repairBill, fieldBuildInputs), whether this fabricator's grade can make it, its
 * join distance from the core, and the field lists from the last fieldState.
 */
import { blueprintGeometry, canFabricate, computeJoins, fieldBuildInputs, isStructural, joinDepths, partItemId, repairBill, type ShipState } from '@space-game/common';
import { fieldBridge } from '../../../ships/field/bridge';
import { fieldClient } from '../../../ships/field/fieldState';
import type { QueueInput, QueuePart } from '../fabQueue';

const joinCache = new WeakMap<object, [number, number][]>();

/** `hold`: what the ship's hold has of an item (the field machines pay from the hold alone, never storage) */
export function queueInput(ship: ShipState, fnName: (fn: string) => string, hold: (id: string) => number): QueueInput | null {
  const deps = fieldBridge.deps;
  if (!deps) return null;
  const fab = fieldClient.machine('fabricator');
  const tier = fab?.tier ?? 0;
  const rc = fieldClient.recycleUids();
  // (Joins over every part, built or not, as the server's field order takes them: where missing parts would join)
  let joins = joinCache.get(ship.blueprint);
  if (!joins) { joins = computeJoins(blueprintGeometry(deps.catalog, ship.blueprint)); joinCache.set(ship.blueprint, joins); }
  const parts = ship.blueprint.parts, n = parts.length;
  const depth = joinDepths(n, ship.derived.root, joins);
  const out: QueuePart[] = parts.map((p, i) => {
    const alive = !!ship.derived.alive[i];
    const missing = alive && ship.maxHp[i] > 0 ? Math.max(0, 1 - ship.hp[i] / ship.maxHp[i]) : 0;
    const core = p.fn === 'core';
    const wanted = !alive && !core && !rc.has(p.uid);
    let bill: Record<string, number> = {};
    if (alive && missing > 1e-6) bill = repairBill(deps.econ, p, missing);
    else if (wanted) bill = !isStructural(p.fn) && hold(partItemId(p)) >= 1 ? {} : fieldBuildInputs(deps.econ, p);
    return {
      uid: p.uid, name: fnName(p.fn), alive, missing, wanted, recycle: alive && rc.has(p.uid),
      makeable: core || canFabricate(deps.catalog, tier, p), depth: depth[i], bill,
    };
  });
  const busy = fab?.job && fab.job.kind !== 'refine' && fab.job.kind !== 'rearm' ? fab.job.uid : undefined;
  return {
    parts: out, first: fab?.first ?? [], paused: fab?.paused ?? [], busy,
    have: hold, itemName: (id) => deps.econ.items.name(id),
  };
}
