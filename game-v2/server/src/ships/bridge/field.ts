/**
 * ShipBridge field refit: a pilot's ship takes a new design while it flies (docs/design/field-fabrication.md 5.1: a
 * field plan saved, a recycled part taken off). Unlike a hangar save (rebuild.ts respawnInPlace) nothing is reset:
 * each part that stays (same uid) keeps its HP, its guns' state and what its ports held (power/ports.ts
 * remapPortsByIndex: never a free refill), the ship keeps its motion, shield and jump, and new parts come in as ghosts
 * (planned, not built). The body is a new ShipState, so every client gets the new design in a fresh sync.
 */

import { Position, remapCharge, recentreShift, remapPortsByIndex, type Blueprint, type ShipState } from '@space-game/common';
import type { BridgeCtx } from './core.js';

/** Fields a new body has of its own (made from the design), never copied from the old one */
const OWN = new Set(['id', 'kind', 'blueprint', 'hp', 'maxHp', 'rebuildHp', 'detached', 'ghost', 'dirty', 'derived', 'rebuilds', 'spawnTick', 'despawnTick', 'scaledHp', 'dmg', 'shield']);

/**
 * The ship at `eid` flies `bp` from now on. `ghosts`: the uids not built yet (planned parts). Parts of `bp` whose uid
 * the old design had keep their state; parts new to it start as ghosts (or, not listed, destroyed: wanted back).
 * Returns false (nothing changed) if it isn't a ship's
 */
export function refitInFlight(b: BridgeCtx, eid: number, bp: Blueprint, ghosts: readonly number[]): boolean {
  const was = b.bodies.get(eid);
  if (!was || was.kind !== 'ship') return false;
  const oldIdx = new Map<number, number>();
  was.blueprint.parts.forEach((p, i) => oldIdx.set(p.uid, i));
  const keep = bp.parts.map((p) => oldIdx.get(p.uid) ?? -1);
  const ghost = new Set(ghosts);
  const hp = bp.parts.map((p, i) => {
    const o = keep[i];
    if (o < 0 || ghost.has(p.uid) || was.detached[o]) return 0;
    return Math.max(0, was.hp[o]);
  });
  const held = b.charge.get(eid);
  const pose = b.pose(eid), oldCom = was.derived.com, before = was.derived;
  const ship = b.spawnOn(eid, bp, 'ship', hp, was.angVel);
  copyKept(was, ship, keep);
  ship.shield = Math.min(was.shield, ship.derived.shieldMax);
  // (What each kept part held stays; a new part starts empty)
  if (held) {
    if (ship.derived.ports && held.e) b.setCharge(eid, { g: 100, b: [], e: remapPortsByIndex(held.e, ship.derived.ports, keep) });
    else b.setCharge(eid, remapCharge(before, ship.derived, held));
  }
  // (Keep the standing parts where they were: a part taken away moves the centre of mass)
  const w = recentreShift(oldCom, ship.derived.com, b.tuning.cellSize, pose.angle);
  if (w) { Position.x[eid] += w[0]; Position.y[eid] += w[1]; }
  b.setGhosts(eid, bp.parts.filter((p) => ghost.has(p.uid)).map((p) => p.uid));
  b.syncHealth(eid, ship);
  b.host.shipRebuilt?.(eid);
  return true;
}

/** The old body's motion and gun state onto the new one: plain values as they are, per-part arrays by `keep` */
function copyKept(was: ShipState, ship: ShipState, keep: readonly number[]): void {
  const n = was.blueprint.parts.length;
  const from = was as unknown as Record<string, unknown>, to = ship as unknown as Record<string, unknown>;
  for (const k of Object.keys(from)) {
    if (OWN.has(k)) continue;
    const v = from[k];
    if (Array.isArray(v)) {
      const cur = to[k];
      if (v.length !== n || !Array.isArray(cur)) continue;
      to[k] = keep.map((o, i) => (o >= 0 ? v[o] : cur[i]));
    } else if (v === undefined || typeof v === 'number' || typeof v === 'boolean') to[k] = v;
  }
}
