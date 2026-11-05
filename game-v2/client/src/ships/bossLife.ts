/**
 * Lair bosses' lives as the server decided them (bossLife; common bosses/lifecycle.ts): from the tick a boss began
 * waking it rises out of its lair, and from the tick it began sleeping it sinks back, drawn the same for everyone at a
 * tick. ShipClient's hull fade reads `bossRise`.
 */

import { lifeRise, type ServerBossLifeMessage } from '@space-game/common';

const lives = new Map<number, { state: ServerBossLifeMessage['state']; at: number }>();

export function noteBossLife(msg: ServerBossLifeMessage): void {
  if (msg.state === 'dormant') lives.delete(msg.bodyId);
  else lives.set(msg.bodyId, { state: msg.state, at: msg.at });
}

/** How far out of its lair this body is drawn at a tick (1: all the way; not a lair boss: 1) */
export function bossRise(id: number, tick: number): number {
  const l = lives.get(id);
  return l ? lifeRise(l.state, l.at, tick) : 1;
}

/** A new system (or a reconnect): forget them all */
export function clearBossLives(): void {
  lives.clear();
}
