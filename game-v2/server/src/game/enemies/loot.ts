/**
 * @contract server.enemies.loot
 * owns:       a hostile's death: pay the killer, party and helpers, roll its drop tables (data/loot.json) and salvage parts
 * needs:      Enemies (enemies, packs, host, data, econ, lootDice), ./populations, ./steering; npm: @space-game/common
 * invariants: a kill pays the killer XP and credits and drops a loot pod — server/src/game/enemies.test.ts
 *             a design's drops, then a design's in its system, override its faction's; an elite rolls its eliteDrop once more — server/src/game/enemies/drops.test.ts
 * extend:     a new payout rule is a step in onDestroyed
 */

import { Position, Velocity, InSystem, Bag, ShipState, partItemId, gradeReward, placeCost, migratePartItem, dhypot, dropSpecFor, rollDrops } from '@space-game/common';
import type { Enemies } from '../Enemies.js';
import { SHARE_RANGE } from '../Party.js';
import * as populations from './populations.js';
import * as steering from './steering.js';

/** An enemy ship was destroyed: pay the killer (and helpers), drop loot */
export function onDestroyed(self: Enemies, eid: number, killer: number | undefined, ship: ShipState | undefined): void {
  const e = self.enemies.get(eid);
  if (!e) return;
  self.enemies.delete(eid);
  self.destroyed.add(eid);
  self.packs.get(e.pack)?.members.delete(eid);
  populations.popLost(self, e, self.host.tick());
  // A range target pays nothing, drops nothing, counts for nothing
  if (e.dummy) return;
  if (e.boss) { self.bosses?.onDestroyed(eid, killer, ship); return; }
  const f = self.data.factions[e.faction];
  const base = f.ships[e.type] ?? { xp: 20, credits: 20 };
  // Better-built ships pay better: XP ×1.5 at Mk II, ×4.6 at Mk V (gradeReward); credits × rules.gradeCredits by grade
  const gk = gradeReward(self.ships.catalog, e.grade);
  const pay = { xp: base.xp * gk, credits: base.credits * (self.data.rules.gradeCredits?.[e.grade - 1] ?? gk) };
  const k = e.elite ? self.data.rules.eliteLoot : 1;
  const num = InSystem.systemId[eid];
  const x = Position.x[eid], y = Position.y[eid];
  const label = self.info(eid)?.name ?? (self.designs[e.type]?.name ?? e.type);
  if (killer !== undefined && steering.alive(self, killer)) {
    self.host.reward(killer, pay.xp * k, pay.credits * k, false, label);
    self.host.questKill(killer, e.type, e.faction);
  }
  // The killer's party nearby shares the kill (XP, some credits, and it counts for their jobs);
  // other helpers nearby get a share of the XP
  const party = new Set(killer !== undefined && steering.alive(self, killer) ? self.host.partyOf?.(killer) ?? [] : []);
  const support = new Set(killer !== undefined && steering.alive(self, killer) ? self.host.supportersOf?.(killer) ?? [] : []);
  for (const p of self.host.players(num)) {
    if (p === killer) continue;
    const d = dhypot(Position.x[p] - x, Position.y[p] - y);
    if (party.has(p) && d < SHARE_RANGE) {
      self.host.reward(p, Math.round(pay.xp * k * 0.75), Math.round(pay.credits * k * 0.4), true, label);
      self.host.questKill(p, e.type, e.faction);
      continue;
    }
    // (Support credit: whoever kept the killer flying shares the kill's pay as its party does, not its job steps)
    if (support.has(p) && d < SHARE_RANGE) {
      self.host.reward(p, Math.round(pay.xp * k * 0.75), Math.round(pay.credits * k * 0.4), true, label);
      continue;
    }
    if (d > 3000) continue;
    self.host.reward(p, Math.round(pay.xp * k * self.data.rules.assistXpShare), 0, true, label);
  }
  // Loot: its drop tables (a design in this system, else the design, else its faction: data/loot.json), an elite one
  // more roll of its eliteDrop, plus salvaged parts
  const sysId = self.host.systemId?.(num);
  const spec = dropSpecFor(sysId ? self.data.spawns[sysId]?.loot?.[e.type] : undefined, f.ships[e.type], f);
  const bag: Bag = rollDrops(self.data.lootTables ?? {}, spec, self.lootDice, e.elite ? 1 : 0);
  if (ship) {
    ship.blueprint.parts.forEach((p, i) => {
      if (p.fn === 'core' || !(ship.rebuildHp[i] > 0) || self.lootDice() >= f.partSalvage) return;
      // (The game's own ships' parts, and bespoke shapes, are never salvage)
      if (self.ships.catalog.functions.get(p.fn)?.exclusive || self.ships.catalog.pieces.get(p.piece)?.bespoke) return;
      // Modules come as their models (an enemy's are legacy parts: ships/migrate.ts); structure as the materials it's made of
      for (const [id, n] of Object.entries(self.econ ? placeCost(self.econ, p) : { [partItemId(p)]: 1 })) { const to = migratePartItem(self.ships.catalog, id); bag[to] = (bag[to] ?? 0) + n; }
    });
  }
  if (Object.keys(bag).length) self.host.dropLoot(num, x, y, Velocity.x[eid] * 0.4, Velocity.y[eid] * 0.4, bag);
}
