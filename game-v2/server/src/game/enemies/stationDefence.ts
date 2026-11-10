/**
 * @contract server.enemies.station-defence
 * owns:       armed stations' turrets firing on hostiles in reach
 * needs:      Enemies (enemies, batteries, ships, host, data); npm: @space-game/common
 * invariants: an armed station fires on hostiles in reach a turret at a time, an unarmed one does not — server/src/game/enemies.test.ts
 * extend:     a new turret behaviour is a change in stationDefence/stationShot
 */

import { Position, InSystem, Radius, dhypot } from '@space-game/common';
import { SimPass } from '../../sim/SystemClocks.js';
import type { Enemies } from '../Enemies.js';
import type { StationGun } from './model.js';

/**
 * Armed stations' turrets fire on hostiles in reach: each stays on its
 * target while it's in reach, otherwise takes the nearest (shared out round
 * the turrets, so a battery spreads over a pack), and fires as it comes ready.
 */
export function stationDefence(self: Enemies, now: number): void {
  const bySystem = new Map<number, number[]>();
  for (const e of self.enemies.values()) {
    // (Distant ships are out of every fight: ships/SimLod.ts)
    if (self.ships.isDormant(e.eid)) continue;
    const num = InSystem.systemId[e.eid];
    if (!SimPass.on(num)) continue;
    const list = bySystem.get(num);
    if (list) list.push(e.eid);
    else bySystem.set(num, [e.eid]);
  }
  for (const [num, foes] of bySystem) {
    for (const st of self.host.stations(num)) {
      const def = self.host.stationDefence?.(st);
      const gun = def && def.turrets > 0 ? self.data.rules.stationDefence[def.weapon] : undefined;
      if (!def || !gun) continue;
      const reach = gun.range + Radius.value[st];
      const near = foes.map((eid) => ({ eid, d: dhypot(Position.x[st] - Position.x[eid], Position.y[st] - Position.y[eid]) }))
        .filter((f) => f.d <= reach && self.ships.get(f.eid))
        .sort((a, b) => a.d - b.d);
      if (!near.length) continue;
      let b = self.batteries.get(st);
      if (!b) {
        // Staggered, so a battery fires in turn rather than all at once
        b = { next: Array.from({ length: def.turrets }, (_, i) => now + Math.round((i * gun.interval) / def.turrets)), target: new Array(def.turrets).fill(-1) };
        self.batteries.set(st, b);
      }
      for (let i = 0; i < def.turrets; i++) {
        if (now < b.next[i]) continue;
        const target = near.find((f) => f.eid === b.target[i])?.eid ?? near[i % near.length].eid;
        b.target[i] = target;
        b.next[i] = now + gun.interval;
        stationShot(self, st, target, gun, foes);
        self.host.stationBeam(num, st, target, i);
      }
    }
  }
}

/** A turret's shot lands: on the part of the ship facing the station (what a shot at it from there strikes first; flak hurts those near it too) */
export function stationShot(self: Enemies, st: number, target: number, gun: StationGun, foes: number[]): void {
  const sx = Position.x[st], sy = Position.y[st];
  const hit = (eid: number, damage: number) => {
    const ship = self.ships.get(eid);
    if (!ship) return;
    const part = self.ships.partFacing(eid, sx, sy);
    if (part >= 0) self.ships.hurt(eid, ship, part, damage, -1);
  };
  const x = Position.x[target], y = Position.y[target];
  hit(target, gun.damage);
  if (!gun.splash) return;
  for (const eid of foes) {
    if (eid !== target && dhypot(Position.x[eid] - x, Position.y[eid] - y) < gun.splash) hit(eid, gun.damage * 0.5);
  }
}
