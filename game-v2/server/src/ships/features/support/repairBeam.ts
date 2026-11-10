/** The Repair Beam's beam (a weapon role of the support feature: ./index.ts): mends a friendly hull instead of hurting. Moved from bridge/weapons.ts. */
import { rayTerrain, repairAt, InSystem, type ShipState, type WeaponInfo, type WeaponTuning, dcos, dsin } from '@space-game/common';
import type { WeaponBridge } from '../../bridge/core.js';

/**
 * One tick of a Repair Beam: along its aim it passes through every ship it may not mend and stops on the first
 * friendly hull (or rock), mending `heal` a second into the damaged parts nearest where it lands. Never its own ship,
 * never a destroyed part. Returns how far along it stopped (0..1).
 */
export function repairBeam(b: WeaponBridge, eid: number, ship: ShipState, w: WeaponInfo, def: WeaponTuning): number {
  const { x, y, angle } = b.beamFrom(eid, ship, w);
  const range = def.range ?? 500;
  const x1 = x + dcos(angle) * range, y1 = y + dsin(angle) * range;
  const half = (def.width ?? 0) / 2, sys = InSystem.systemId[eid];
  let hit: { eid: number; ship: ShipState; part: number; t: number } | null = null;
  for (const other of b.alongBeam(sys, x, y, x1, y1, half)) {
    const os = b.bodies.get(other);
    if (!os || other === eid || os.kind !== 'ship' || InSystem.systemId[other] !== sys || b.isJumping(os) || b.intangible.has(other) || b.dormant.has(other)) continue;
    if (!b.host.canHeal?.(eid, other) || !b.nearSegment(other, os, x, y, x1, y1, half)) continue;
    const h = b.castShip(other, os, x, y, x1, y1, half);
    if (h && (!hit || h.t < hit.t)) hit = { eid: other, ship: os, ...h };
  }
  const wall = rayTerrain(b.host.terrainAt?.(eid), x, y, x1, y1);
  if (!hit || hit.t > wall) return wall;
  const amount = ((def.heal ?? 0) / 60) * w.strength;
  const at = b.worldToGrid(hit.eid, hit.ship, x + (x1 - x) * hit.t, y + (y1 - y) * hit.t);
  const healed = repairAt(hit.ship, b.geometry(hit.ship), at[0], at[1], amount, b.tuning);
  if (healed > 0) b.host.onHeal?.(eid, hit.eid, healed);
  return hit.t;
}
