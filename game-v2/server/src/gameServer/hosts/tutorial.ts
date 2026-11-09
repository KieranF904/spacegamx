/**
 * @contract server.gameserver.hosts.tutorial
 * owns:       the host adapter for the training yard and its start-up (built only when the server runs a tutorial)
 * needs:      GameServer (type), game/tutorial/Tutorial, gameServer/asteroids (createTrainingBody); npm: @space-game/common
 * invariants: a server without the tutorial option (or with a dev start) builds nothing: no yard station, no bodies, no hooks — server/src/game/tutorial/tutorial.test.ts
 * extend:     a new thing the yard needs from the server is a member of TutorialHost and a line here
 */

import { Tutorial, type TutorialHost } from '../../game/tutorial/Tutorial.js';
import { createTrainingBody } from '../asteroids.js';
import type { ClientConnection } from '../../net/ClientConnection.js';
import type { GameServer } from '../../GameServer.js';
import type { GameServerOptions } from '../options.js';

export function createTutorialHost(gs: GameServer): TutorialHost {
  const data = gs.gameData.tutorialFile!;
  return {
    data,
    tick: () => gs.currentTick,
    send: (conn, msg) => gs.send((conn as ClientConnection).ws, msg),
    systemNum: (id) => (gs.gameData.getSystem(id) ? gs.gameData.getSystemNum(id) : -1),
    flying: function* () {
      for (const c of gs.clients.values()) if (gs.flying(c.playerId)) yield { conn: c, eid: c.playerId };
    },
    travel: (conn, system, x, y) => { gs.travelTo(conn as ClientConnection, system, x, y, false); },
    isJumping: (eid) => { const s = gs.ships.get(eid); return !!s && gs.ships.isJumping(s); },
    undock: (conn) => { gs.docking.undock(conn as ClientConnection); },
    createBody: (index, def, x, y) => createTrainingBody(gs, gs.gameData.getSystemNum(data.yard.system), index, def.radius, x, y),
    starterHome: () => gs.starterKit().home,
    openStarters: (conn) => gs.quests.onLogin(conn),
  };
}

/** Build the yard if this server runs one: the module, and the pilots' spawn hook */
export function setupTutorial(gs: GameServer, opts: GameServerOptions): Tutorial | undefined {
  if (!opts.tutorial || gs.devStartNum >= 0 || !gs.gameData.tutorialFile) return undefined;
  const tutorial = new Tutorial(createTutorialHost(gs), gs.pilots, gs.pods);
  gs.pilots.tutorialSpawn = (conn, resume) => tutorial.spawnFor(conn, resume);
  return tutorial;
}
