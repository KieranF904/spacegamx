/**
 * Map download benchmark: what one pilot idling in inner Sol is sent, by message type, with its system map shut or
 * open, alone or while a second pilot stirs up a Drift nest's packs (loaded and active, out of the first's view).
 * Run (in server/): npx tsx src/bench/mapBench.ts --map 0|1 --other 0|1 [--seconds 60] [--warm 20]
 */

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Position, Velocity, InSystem, ClientSocket, splitServerFrame, PROTOCOL_VERSION, DEFAULT_CAPS } from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigFromDisk } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../proto/createProtoServer.js';

const dataDir = join(dirname(fileURLToPath(import.meta.url)), '../../../data');
const arg = (k: string, d: number) => { const i = process.argv.indexOf(k); return i >= 0 ? Number(process.argv[i + 1]) : d; };
const mapOpen = arg('--map', 1) === 1, other = arg('--other', 0) === 1, secs = arg('--seconds', 60), warm = arg('--warm', 20);

const clock = { t: 1_000_000 };
const server = new GameServer({
  gameData: new GameData(readGameDataFiles(dataDir)),
  userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as never,
  scene: 'sectors', autoStart: false, ships: createShipBridge(loadShipConfigFromDisk(dataDir)), clock: () => clock.t,
});

let measuring = false;
/** The biggest full pops message pilot 0 got (every population of its system) */
let fullPops = 0;
const bytes: Record<string, number> = {}, msgs: Record<string, number> = {};
const pilots = (other ? 2 : 1);
const links = Array.from({ length: pilots }, (_, i) => {
  const socket: ClientSocket = {
    isOpen: () => true,
    send: (data) => {
      if (i === 0) for (const { msg, bytes: b } of splitServerFrame(data as Uint8Array)) if (msg.type === 'pops' && (msg as { full?: 1 }).full) fullPops = Math.max(fullPops, b);
      if (i !== 0 || !measuring) return;
      const len = typeof data === 'string' ? Buffer.byteLength(data) : (data as ArrayBuffer).byteLength;
      bytes['(total)'] = (bytes['(total)'] ?? 0) + len;
      for (const { msg, bytes: b } of splitServerFrame(data as Uint8Array)) { bytes[msg.type] = (bytes[msg.type] ?? 0) + b; msgs[msg.type] = (msgs[msg.type] ?? 0) + 1; }
    },
  };
  const link = server.connect(socket);
  link.receive({ type: 'join', username: `mapb${i}`, protocol: PROTOCOL_VERSION, caps: DEFAULT_CAPS } as never);
  return { link, socket };
});
const pid = (i: number) => server.getPlayerId(links[i].socket);
// Pilot 0 idles in inner Sol (out of every nest's reach); pilot 1 sits by the Drift's eastern nest
const here = { x: 26000, y: 21000 };
const sol = InSystem.systemId[pid(0)];
const nest = () => server.enemies.nest(sol, 'sol_nest_drift_east')!;
const hold = () => {
  Position.x[pid(0)] = here.x; Position.y[pid(0)] = here.y; Velocity.x[pid(0)] = 0; Velocity.y[pid(0)] = 0;
  if (other) { const n = nest(); Position.x[pid(1)] = n.x + 3000; Position.y[pid(1)] = n.y; Velocity.x[pid(1)] = 0; Velocity.y[pid(1)] = 0; }
};
// A Sol that's been flown in a while: pilot 0 tours every nest first (each woken, its packs out)
for (const id of server.gameData.getSystemByNum(sol)?.nests?.map((n) => n.id) ?? []) {
  for (let i = 0; i < 120; i++) {
    const n = server.enemies.nest(sol, id);
    if (!n) break;
    Position.x[pid(0)] = n.x + 20000; Position.y[pid(0)] = n.y; Velocity.x[pid(0)] = 0; Velocity.y[pid(0)] = 0;
    server.step(); clock.t += 1000 / 60;
  }
}
if (mapOpen) links[0].link.receive({ type: 'mapView', open: true } as never);
for (let i = 0; i < warm * 60; i++) { hold(); server.step(); clock.t += 1000 / 60; }
measuring = true;
for (let i = 0; i < secs * 60; i++) { hold(); server.step(); clock.t += 1000 / 60; }
const per = (n: number) => (n / secs).toFixed(0).padStart(7);
console.log(`map ${mapOpen ? 'open' : 'shut'}, ${other ? 'another pilot at a Drift nest' : 'alone'}: ${secs}s, ${server.enemies.count(sol)} hostiles loaded in Sol`);
for (const [k, v] of Object.entries(bytes).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(14)} ${per(v)} B/s  ${msgs[k] !== undefined ? (msgs[k] / secs).toFixed(2) + ' msg/s' : ''}`);
console.log(`  (full pops message on entering: ${fullPops} bytes)`);
process.exit(0);
