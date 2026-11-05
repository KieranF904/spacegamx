/** Reading a ship off the server, the same for both drivers */
import { Position, Velocity, Rotation } from '@space-game/common';
import type { GameServer } from '../../GameServer.js';
import type { Bag, Pose } from '../core/types.js';

export const poseOf = (eid: number): Pose => ({ x: Position.x[eid], y: Position.y[eid], vx: Velocity.x[eid], vy: Velocity.y[eid], angle: Rotation.angle[eid] });

export const radiusOf = (server: GameServer, eid: number): number => server.getShips().get(eid)?.derived.radius ?? 40;

/**
 * How much of its draw the mining lasers are getting (1: all of it): a ports ship's weakest laser by its fulfilment, else the
 * ship's share for its lasers. Below 1 the beam cuts that much less (a brownout).
 */
export function miningFill(server: GameServer, eid: number): number {
  const ships = server.getShips(), ship = ships.get(eid);
  if (!ship || !ship.derived.miners.length) return 1;
  const c = ships.chargeOf(eid);
  if (ship.derived.ports && c.e) {
    let f = 1;
    for (const m of ship.derived.miners) f = Math.min(f, (c.e.sat[m.part] ?? 255) / 255);
    return f;
  }
  return ship.mineShare ?? 1;
}

export function volumeOf(server: GameServer, bag: Bag): number {
  let v = 0;
  for (const [id, n] of Object.entries(bag)) v += n * server.econ.items.volume(id);
  return v;
}
