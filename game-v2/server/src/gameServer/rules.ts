/**
 * @contract server.gameserver.rules
 * owns:       who may hurt or mend whom, PvP zones and the weekly hunt
 * needs:      GameServer (type), common hitRules; npm: bitecs
 * invariants: sides rule matches the client — server/src/golden/parity.test.ts
 * extend:      a new side bit is added in common hitRules, then read in sideOf
 */

import { hasComponent } from 'bitecs';
import { Position, Radius, Player, InSystem, sidesHurt, SIDE, dhypot } from '@space-game/common';
import { BossesFile } from '../game/Bosses.js';
import { huntedBoss } from '@space-game/common';
import { stationQuery } from '../game/Docking.js';
import type { GameServer } from '../GameServer.js';

/**
 * May `healer`'s Repair Beam mend `target` (common/src/ships/features/support/support.ts)? Friendly ships only: pilots and what they
 * defend (wards), never itself, nobody docked or a person's craft; two pilots both in a PvP zone only when they're in
 * one party. Hostiles mend nothing (no enemy carries one yet).
 */
export function canHeal(gs: GameServer, healer: number, target: number): boolean {
  if (healer === target) return false;
  if (gs.dockedShips.has(healer) || gs.dockedShips.has(target) || gs.personCraft.has(healer) || gs.personCraft.has(target)) return false;
  const aPlayer = hasComponent(gs.world, Player, healer), tPlayer = hasComponent(gs.world, Player, target);
  if (!(aPlayer || gs.wards.has(healer)) || !(tPlayer || gs.wards.has(target))) return false;
  if (aPlayer && tPlayer && gs.inPvpZone(healer) && gs.inPvpZone(target)) {
    const a = gs.pilots.connOf(healer), b = gs.pilots.connOf(target);
    const pa = a ? gs.party.partyId(a) : 0;
    return pa !== 0 && b !== undefined && gs.party.partyId(b) === pa;
  }
  return true;
}

/**
 * PvP rules: players can always hurt pilotless ships, debris and enemies,
 * but another player only in a PvP zone (both of them in it). A player who
 * owns a body (none yet) is treated like the player.
 */
export function canDamage(gs: GameServer, attacker: number, target: number): boolean {
  // Docked ships and people's craft are out of it; pilots and what they defend (wards: freighters, pylons, bastions,
  // their turrets) are on one side (common hitRules.ts sidesHurt: a client finding its own hits asks the same)
  const r = sidesHurt(gs.sideOf(attacker), gs.sideOf(target));
  return r === 2 ? gs.inPvpZone(attacker) && gs.inPvpZone(target) : r === 1;
}

/** A ship's side, for who may hurt whom (hitRules.ts SIDE bits) */
export function sideOf(gs: GameServer, eid: number): number {
  return (hasComponent(gs.world, Player, eid) ? SIDE.PILOT : 0) | (gs.wards.has(eid) ? SIDE.WARD : 0)
    | (gs.dockedShips.has(eid) ? SIDE.DOCKED : 0) | (gs.personCraft.has(eid) ? SIDE.PERSON : 0);
}

/** Inside a zone where players may fight each other */
export function inPvpZone(gs: GameServer, eid: number): boolean {
  const sys = gs.gameData.getSystemByNum(InSystem.systemId[eid]);
  const pvp = sys?.pvp;
  if (!pvp) return false;
  const safe = pvp.safeRadius ?? 3000;
  // Station rings are always safe
  for (const st of stationQuery(gs.world)) {
    if (InSystem.systemId[st] !== InSystem.systemId[eid]) continue;
    const d = dhypot(Position.x[st] - Position.x[eid], Position.y[st] - Position.y[eid]);
    if (d < (pvp.mode === 'outer' ? safe : Math.max(Radius.value[st] + 1500, 2200))) return false;
  }
  return true;
}

/** This week's hunted boss: double rewards */
export function hunted(gs: GameServer): { id: string; name: string; system: string } | null {
  const bosses = ((gs.gameData.bossesFile as BossesFile | undefined)?.bosses ?? {}) as Record<string, { name: string; system: string }>;
  // Outposts aren't hunts: they're always where they are
  const id = huntedBoss(gs.clock(), Object.keys(bosses).filter((b) => !(bosses[b] as { arena?: boolean; fixed?: boolean }).arena && !(bosses[b] as { fixed?: boolean }).fixed));
  return id ? { id, name: bosses[id].name, system: bosses[id].system } : null;
}
