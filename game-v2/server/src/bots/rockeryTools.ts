/**
 * The Rockery spawn tools (dev builds only; the client's Sim tools panel, F7, sends these as `/rockery ...` chat lines, so they
 * are admin-only like every `/` command, and a dev server makes every guest an admin). Test traffic for the netcode, spawned
 * beside whoever asks:
 *
 *   /rockery drones [n]                       a Helios drone pack (default 5, up to 12)
 *   /rockery dummy [ship]                     a still dummy ship (default halberd), parked beside you
 *   /rockery bots [n] [twitch] [shoot] [near] n bot "players" (1-4 at a time) on random flight: real connections flying through
 *                                             the input path; twitch = calm|mid|twitchy|0..1; `shoot` makes them fire at you;
 *                                             `near` keeps them within about 900 of you wherever you go (the prediction demo)
 *   /rockery clear                            the bots and dummies it made, and the hostiles near you
 *   /rockery list                             what it has made
 *
 * Nothing here is ever built on a production server: installRockeryTools throws under NODE_ENV=production (and index.ts only
 * calls it in dev mode).
 */
import { InSystem, Position } from '@space-game/common';
import type { GameServer } from '../GameServer.js';
import type { AdminConn, Result } from '../game/AdminTools.js';
import { Bot } from './core/Bot.js';
import { assertDev, type BotManager } from './core/BotManager.js';
import { ClientDriver } from './drivers/clientDriver.js';
import { flightOpts, RandomFlight } from './tasks/randomFlight.js';

const MAX_BOTS = 4, MAX_DRONES = 12, MAX_DUMMIES = 12;
const DUMMY_SHIP = 'halberd', BOT_SHIP = 'arrow';

export interface RockeryTools {
  run(c: AdminConn, words: string[]): Result;
  readonly bots: Bot[];
  readonly dummies: number[];
}

export function installRockeryTools(server: GameServer, manager: BotManager): RockeryTools {
  assertDev();
  const bots: Bot[] = [];
  const dummies: number[] = [];
  let nextId = 1000;

  const where = (c: AdminConn): { x: number; y: number; system: number } | null => {
    const eid = c.playerId;
    return Number.isFinite(Position.x[eid]) ? { x: Position.x[eid], y: Position.y[eid], system: InSystem.systemId[eid] } : null;
  };
  const live = () => { for (let i = bots.length - 1; i >= 0; i--) if (!manager.bots.includes(bots[i])) bots.splice(i, 1); };

  function run(c: AdminConn, words: string[]): Result {
    try {
      assertDev();
      const [sub, ...rest] = words;
      const w = where(c);
      switch (sub) {
        case 'drones': {
          if (!w) return { ok: false, text: 'You have no ship' };
          const n = Math.max(1, Math.min(MAX_DRONES, Math.round(Number(rest[0]) || 5)));
          const eids = server.enemies.spawnPack(w.system, { faction: 'helios', ships: Array.from({ length: n }, () => 'helios_drone') }, w.x + 1200, w.y);
          return { ok: true, text: eids.length ? `Spawned ${eids.length} Helios drone(s) 1200 units ahead` : 'No drones spawned' };
        }
        case 'dummy': {
          if (!w) return { ok: false, text: 'You have no ship' };
          live();
          const id = rest[0] || DUMMY_SHIP;
          const bp = server.getShips().library.get(id);
          if (!bp) return { ok: false, text: `No library ship "${id}"` };
          if (dummies.length >= MAX_DUMMIES) return { ok: false, text: `${MAX_DUMMIES} dummies already (/rockery clear)` };
          const a = Math.random() * Math.PI * 2;
          const eid = server.getShips().spawnDummy(JSON.parse(JSON.stringify(bp)), w.x + Math.cos(a) * 500, w.y + Math.sin(a) * 500, 0, w.system);
          dummies.push(eid);
          return { ok: true, text: `Still dummy (${id}) #${eid} beside you` };
        }
        case 'bots': {
          live();
          let n = 1, twitch = 'mid', shoot = false, near = false;
          for (const word of rest) {
            if (/^\d+$/.test(word)) n = Number(word);
            else if (word === 'shoot') shoot = true;
            else if (word === 'near') near = true;
            else twitch = word;
          }
          n = Math.max(1, Math.min(MAX_BOTS, n));
          if (bots.length + n > MAX_BOTS) return { ok: false, text: `At most ${MAX_BOTS} bot players at once (${bots.length} flying; /rockery clear)` };
          const made: string[] = [];
          for (let i = 0; i < n; i++) {
            const id = nextId++;
            const name = `rockery_bot_${id - 999}`;
            const task = new RandomFlight(flightOpts({ twitch, shoot: shoot ? '1' : '0', seed: id, ...(near ? { leash: '900' } : {}) }));
            if (near) task.homeOf = () => (Number.isFinite(Position.x[c.playerId]) ? { x: Position.x[c.playerId], y: Position.y[c.playerId] } : null);
            if (shoot) task.target = () => (Number.isFinite(Position.x[c.playerId]) ? { x: Position.x[c.playerId], y: Position.y[c.playerId] } : null);
            // (its /goto takes it beside the asker: a player's name is as good a "station" as any for the driver)
            const driver = new ClientDriver(server, name, { name, ship: BOT_SHIP, station: c.username, price: () => 0 });
            const bot = new Bot(id, server, manager.world, task, driver, w?.system ?? 0);
            manager.bots.push(bot);
            bots.push(bot);
            made.push(name);
          }
          return { ok: true, text: `${made.length} bot player(s) on random flight (twitch ${twitch}${shoot ? ', shooting at you' : ''}): ${made.join(', ')}` };
        }
        case 'clear': {
          live();
          const nb = bots.length;
          for (const b of [...bots]) manager.stop(b.id);
          bots.length = 0;
          const nd = dummies.length;
          for (const e of dummies) { try { server.getShips().removeShip(e); } catch { /* already gone */ } }
          dummies.length = 0;
          const r = server.admin.run(c, 'clear', { radius: 12000, quiet: true });
          const hostiles = r instanceof Promise ? '' : ` ${r.text}.`;
          return { ok: true, text: `Cleared ${nb} bot(s), ${nd} dummy(ies).${hostiles}` };
        }
        case 'list': {
          live();
          return { ok: true, text: `${bots.length} bot(s): ${bots.map((b) => `${b.driver.name} (${b.task.status()})`).join('; ') || 'none'}\n${dummies.length} dummy ship(s)` };
        }
        default:
          return { ok: true, text: '/rockery drones [n] · dummy [ship] · bots [n] [calm|mid|twitchy|0..1] [shoot] · clear · list' };
      }
    } catch (e) {
      return { ok: false, text: (e as Error).message };
    }
  }

  server.admin.extensions.set('rockery', (c, words) => run(c, words));
  return { run, bots, dummies };
}
