/**
 * @contract server.gameserver.hosts.boss
 * owns:       host adapter for bosses and the hostile shot helpers
 * needs:      GameServer (type)
 * invariants: behaviour is unchanged from the class it was split from — none pinned
 * extend:      a new host member is added to createBossHost
 */

import { hasComponent } from 'bitecs';
import { Position, Player, InSystem, Dead } from '@space-game/common';
import { ServerMessage, EffectType, countOf } from '@space-game/common';
import { Bag, blueprintGrade } from '@space-game/common';
import type { ClientConnection } from '../../net/ClientConnection.js';
import type { BodyState, MoveOrigin } from '@space-game/common';
import { arrivalEffect } from './mining.js';
import type { GameServer } from '../../GameServer.js';

export function createBossHost(gs: GameServer) {
  const effect = (num: number, x: number, y: number, kind: 'warning' | 'warpIn' | 'launch') => arrivalEffect(gs, num, x, y, kind);
  const alivePlayers = (num: number) => {
    const out: number[] = [];
    for (const c of gs.clients.values()) {
      const p = c.playerId;
      if (hasComponent(gs.world, Player, p) && !hasComponent(gs.world, Dead, p) && InSystem.systemId[p] === num && !gs.admin.isHidden(p) && !gs.dockedShips.has(p)) out.push(p);
    }
    return out;
  };
  return {
    effect,
    world: gs.world,
    tick: () => gs.currentTick,
    systemNum: (id: string) => (gs.gameData.getSystem(id) ? gs.gameData.getSystemNum(id) : -1),
    players: alivePlayers,
    terrain: (num: number) => gs.terrainOf(num),
    send: (num: number, msg: ServerMessage) => gs.broadcastToSystem(num, msg),
    arenaOf: (num: number) => gs.gameData.getSystemByNum(num)?.arena,
    announce: (num: number, text: string, kind: 'info' | 'warn' | 'good' | 'bad') => {
      for (const c of gs.clients.values()) if (InSystem.systemId[c.playerId] === num) gs.pilots.toast(c, text, kind);
    },
    // (Support credit: ships/features/support/Support.ts)
    supportersOf: (player: number) => gs.support.supporters(player, gs.currentTick),
    // (Decision inputs, CAPS.BODIES: net/decisions/BodyNet.ts)
    decide: (eid: number, op: number, args: readonly number[], state: BodyState) => gs.bodies.decide(eid, op, args, state),
    fire: (owner: number, kind: string, x: number, y: number, angle: number, scale: number, opts?: { target?: number; speed?: number; intercept?: boolean; seed?: string }) => { hostileShot(gs, owner, kind, x, y, angle, scale, opts); },
    // (Its moves on its clients' tick layers, CAPS.MOVES: what they work out isn't sent them)
    moveFx: (num: number, eid: number, origin: MoveOrigin, msg: ServerMessage) => gs.moveFx(num, eid, origin, msg),
    moveShot: (owner: number, kind: string, x: number, y: number, angle: number, scale: number, speed: number | undefined, seed: string, origin: MoveOrigin) => gs.moveShot(owner, kind, x, y, angle, scale, speed, seed, origin),
    warpFx: (num: number, x: number, y: number, out: boolean) => {
      gs.broadcastToSystem(num, { type: 'effect', effectType: out ? EffectType.WarpOut : EffectType.WarpIn, x, y });
    },
    reward: (player: number, boss: string, def: { name: string; faction: string; system: string }, xp: number, credits: number, loot: Bag) => {
      const pc = gs.pilots.connOf(player);
      if (!pc) return;
      // This week's hunted boss pays double
      if (gs.hunted()?.id === boss) { xp *= 2; credits *= 2; }
      gs.pilots.addXp(pc, xp);
      gs.pilots.addCredits(pc, credits);
      gs.pilots.bumpStat(pc, 'bosses');
      gs.pilots.bumpStat(pc, `boss:${boss}`);
      gs.send((pc as ClientConnection).ws, { type: 'gained', items: {}, xp, credits, x: Position.x[player], y: Position.y[player], source: `kill:${def.name}` });
      if (Object.keys(loot).length) {
        gs.pilots.give(pc, loot, { toStorage: true, source: 'boss' });
        gs.pilots.toast(pc, `${def.name}'s spoils are waiting in your station storage`, 'good');
      }
      gs.quests.onKill(pc, boss, def.faction, def.system);
      gs.pilots.saveNow(pc);
    },
    killedBefore: (player: number, boss: string) => {
      const pc = gs.pilots.connOf(player);
      return !!pc && (gs.pilots.get(pc)?.stats[`boss:${boss}`] ?? 0) > 0;
    },
    holds: (player: number, item: string) => {
      const pc = gs.pilots.connOf(player);
      const p = pc && gs.pilots.get(pc);
      return !!p && countOf(p.storage, item) + countOf(p.cargo, item) > 0;
    },
    isArtefact: (item: string) => gs.econ.items.get(item)?.category === 'artefact',
    defeated: (boss: string, def: { name: string }, players: number[]) => {
      const names = players.map((p) => gs.pilots.connOf(p)?.username).filter((n): n is string => !!n);
      const who = names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0] ?? 'someone';
      gs.achievements.post(`${def.name} has fallen to ${who}${gs.hunted()?.id === boss ? ' (the hunted boss!)' : ''}`, 'boss');
    },
    encountered: (def: { codex?: string[] }, players: number[]) => {
      for (const p of players) { const c = gs.pilots.connOf(p); if (c && def.codex) gs.codex.unlock(c, def.codex); }
    },
    toast: (player: number, text: string, kind: 'info' | 'warn' | 'good' | 'bad') => { const c = gs.pilots.connOf(player); if (c) gs.pilots.toast(c, text, kind); },
  };
}

/** A shot a boss's or a custom enemy's move fires (not from a part gun) */
export function hostileShot(gs: GameServer, owner: number, kind: string, x: number, y: number, angle: number, scale: number, opts?: { target?: number; speed?: number; intercept?: boolean; seed?: string }): number {
  // (A boss's nova punches through as its own grade does; `intercept: false`, point defence can't touch it: support.ts)
  const ship = gs.ships.get(owner);
  return gs.weapons.spawn(owner, kind, x, y, angle, scale, { speedScale: opts?.speed ?? 1, sizeScale: 1, turret: false, noBurst: true, target: opts?.target, grade: ship ? blueprintGrade(gs.ships.catalog, ship.blueprint) : 1, intercept: opts?.intercept, seed: opts?.seed });
}

/**
 * A body's move's look (a telegraph, a beam, a strike's look, a launch flash; decision-inputs stage 4): to every
 * client in the system but those working it out themselves (net/decisions/BodyNet.ts derives)
 */
export function moveFx(gs: GameServer, num: number, eid: number, origin: MoveOrigin, msg: ServerMessage): void {
  gs.net.broadcastToSystem(num, msg, (c) => gs.bodies.derives(c, c.playerId, eid, origin));
}

/** A body's move's straight shell (seeded, so its clients make the same one): its row not to those working it out */
export function moveShot(gs: GameServer, owner: number, kind: string, x: number, y: number, angle: number, scale: number, speed: number | undefined, seed: string, origin: MoveOrigin): void {
  const id = hostileShot(gs, owner, kind, x, y, angle, scale, { speed, seed });
  if (id >= 0) gs.bodies.moveShell(id, owner, origin);
}
