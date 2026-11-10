/**
 * Test-only: what the staged-boss walk-throughs (game/pyreclast, game/scrapMother) share: standing a pilot somewhere,
 * keeping it whole, moving a boss's fight on to the start of a stage, and catching the looks of its moves.
 */
import { Position, Velocity, InSystem, currentStage, planetPosition, moonOffset, type ServerMessage } from '@space-game/common';
import type { GameServer } from '../GameServer.js';
import { makeServer, resetGlobals, joinPilot } from './world.testkit.js';

/** Put a pilot in a system at a spot, with a velocity */
export const place = (pid: number, num: number, x: number, y: number, vx = 0, vy = 0): void => {
  InSystem.systemId[pid] = num; Position.x[pid] = x; Position.y[pid] = y; Velocity.x[pid] = vx; Velocity.y[pid] = vy;
};

/** Keep the pilot whole (it's the boss's moves under test, not how long a pilot lasts) */
export const mend = (server: GameServer, pid: number): void => server.getShips().scaleHp(pid, 1);

/** (dev) A boss's fight moved on to the start of a stage: what's before it beaten, blown away, and done blowing */
export const advance = (server: GameServer, eid: number, stage: number, step: (n?: number) => void): void => {
  const brain = server.bosses.brainOf(eid)!, bridge = server.getShips();
  for (let n = 1; n < 400; n++) {
    const s = bridge.get(eid);
    if (!s || currentStage(bridge.catalog, s) >= stage) break;
    brain.forceShed!(n);
  }
  step(2);
  for (let i = 0; i < 60 * 15 && brain.invulnerable!(); i++) step();
};

/**
 * A move's looks (its tells, beams, strikes' looks) are worked out by every client running the boss's body (CAPS.MOVES,
 * every client), so none go on the wire: the server's own word for them, GameServer.moveFx, is what a test watches, as
 * every pilot in the system would have been sent it. `into(sys)` gives the message lists of the pilots in that system.
 */
export function watchMoveFx(server: GameServer, into: (sys: number) => ServerMessage[][]): void {
  (server as unknown as { moveFx: unknown }).moveFx = (sys: number, _eid: number, _origin: unknown, msg: ServerMessage) => { for (const l of into(sys)) l.push(msg); };
}

/** A fresh sectors world for the moon-siege tests: the server, its game data, `join` (a pilot with its conn), `step`, and `overSelene` (a pilot put in orbit over Selene) */
export function siegeWorld() {
  resetGlobals();
  const server = makeServer();
  const gameData = server['gameData'];
  const join = (name: string) => joinPilot(server, name);
  const step = (n = 1): void => { for (let i = 0; i < n; i++) server.step(); };
  const overSelene = (pid: number) => {
    const planet = gameData.getSystem('sol')!.planets!.find((p) => p.id === 'terra_nova')!;
    const tick = (server as any).currentTick;
    const p = planetPosition(planet, tick), o = moonOffset(planet, 0, tick);
    InSystem.systemId[pid] = gameData.getSystemNum('sol');
    Position.x[pid] = p.x + o.x + 500; Position.y[pid] = p.y + o.y; Velocity.x[pid] = 0; Velocity.y[pid] = 0;
  };
  return { server, gameData, join, step, overSelene };
}
