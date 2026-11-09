/**
 * @contract server.gameserver.hosts.tutorial
 * owns:       the host adapter for the training yard and its start-up (built only when the server runs a tutorial), a trainee's starting kit
 *             (empty storage: the pack comes on leaving), and the admin /tutorial command
 * needs:      GameServer (type), game/tutorial/Tutorial, gameServer/asteroids (createTrainingBody); npm: @space-game/common
 * invariants: a server without the tutorial option (or with a dev start) builds nothing: no yard station, no bodies, no hooks — server/src/game/tutorial/tutorial.test.ts
 * extend:     a new thing the yard needs from the server is a member of TutorialHost and a line here
 */

import { Tutorial, type TutorialHost } from '../../game/tutorial/Tutorial.js';
import { createTrainingBody } from '../asteroids.js';
import type { StarterKit } from '@space-game/common';
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

/** Does this server run the yard (the tutorial option, no dev start, the data there)? */
export function runsTutorial(gs: GameServer, opts: GameServerOptions): boolean {
  return !!opts.tutorial && gs.devStartNum < 0 && !!gs.gameData.tutorialFile;
}

/**
 * What a new pilot starts with on a server that runs the yard: the usual kit with nothing in storage (every new pilot is a
 * trainee there: the steps hand out what each needs, and the starter pack comes when they leave). Elsewhere, the usual kit
 */
export function starterFor(gs: GameServer, opts: GameServerOptions): StarterKit {
  const kit = gs.starterKit();
  return runsTutorial(gs, opts) ? { ...kit, storage: {} } : kit;
}

/** Build the yard if this server runs one: the module, and the pilots' spawn hook */
export function setupTutorial(gs: GameServer, opts: GameServerOptions): Tutorial | undefined {
  if (!runsTutorial(gs, opts)) return undefined;
  const tutorial = new Tutorial(createTutorialHost(gs), gs.pilots);
  gs.pilots.tutorialSpawn = (conn, resume) => tutorial.spawnFor(conn, resume);
  return tutorial;
}

/**
 * The admin `/tutorial` chat command (admins only: on the dev server every guest is one), for re-testing the yard:
 * `reset` (back to the first step, in the yard), `step <id>` (start at that step, the ones before it done),
 * `leave` (skip out with the starter pack), and no word: where you are and the step ids
 */
export function installTutorialAdmin(gs: GameServer): void {
  const t = gs.tutorial;
  if (!t) return;
  const ids = () => t.data.steps.map((s) => s.id).join(', ');
  gs.admin.extensions.set('tutorial', (c, words) => {
    const conn = c as unknown as ClientConnection;
    const sub = (words[0] ?? '').toLowerCase();
    if (sub === 'reset' || sub === 'restart') return t.restart(conn) ? { ok: true, text: 'Training reset: back to the first step at the yard' } : { ok: false, text: 'No pilot to reset' };
    if (sub === 'step') return t.restart(conn, words[1]) ? { ok: true, text: `Training at step "${words[1]}"` } : { ok: false, text: `Usage: /tutorial step <id> (${ids()})` };
    if (sub === 'leave') return t.leave(conn) ? { ok: true, text: 'Left training' } : { ok: false, text: 'Not in training' };
    const s = t.stateOf(conn);
    return { ok: true, text: `Training: ${!s ? 'no profile' : s.left ? 'left' : `at "${s.step}", done ${s.done.length}/${t.data.steps.length}`}\n/tutorial reset · /tutorial step <id> · /tutorial leave\nSteps: ${ids()}` };
  });
}
