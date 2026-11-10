/**
 * Real-time loop benchmark: a full server on the real clock (its own gameLoop, not step()), idle or with pilots
 * flying about and firing; then the process's CPU, how often the loop woke, and the time between ticks (mean, p50,
 * p99, worst: how accurate the loop's timing is). Run (in server/):
 *   npx tsx src/bench/loopBench.ts [--seconds N] [--pilots N]
 */

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Input, Rotation, type ClientSocket } from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigFromDisk } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../ships/createShipBridge.js';

const dataDir = join(dirname(fileURLToPath(import.meta.url)), '../../../data');
const arg = (k: string, d: number) => { const i = process.argv.indexOf(k); return i >= 0 ? Number(process.argv[i + 1]) || d : d; };
const secs = arg('--seconds', 20);
const PILOTS = arg('--pilots', 0);

const server = new GameServer({
  gameData: new GameData(readGameDataFiles(dataDir)),
  userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as never,
  scene: 'sectors', autoStart: false, ships: createShipBridge(loadShipConfigFromDisk(dataDir)),
});
const anyServer = server as any;
const pilots: number[] = [];
for (let i = 0; i < PILOTS; i++) {
  const socket = { isOpen: () => true, send: () => {} } as unknown as ClientSocket;
  server.connect(socket).receive({ type: 'join', username: `bench${i}` } as never);
  pilots.push(server.getPlayerId(socket));
}

// Count the loop's wakeups and time its ticks (once measuring starts)
let measuring = false, wakeups = 0, tickNo = 0;
const tickAt: number[] = [], tickMs: number[] = [];
const loop = anyServer.gameLoop.bind(anyServer);
anyServer.gameLoop = () => { if (measuring) wakeups++; loop(); };
const tick = anyServer.tick.bind(anyServer);
anyServer.tick = (...a: unknown[]) => {
  // Each pilot weaves about and fires in bursts
  const t = tickNo++;
  pilots.forEach((pid, i) => {
    const ph = t / 60 + i;
    Input.forward[pid] = Math.sin(ph * 0.7) > -0.3 ? 1 : 0;
    Input.left[pid] = Math.sin(ph * 1.3) > 0.6 ? 1 : 0;
    Input.right[pid] = Math.sin(ph * 1.3) < -0.6 ? 1 : 0;
    Input.fireLeft[pid] = Math.sin(ph * 0.5) > 0 ? 1 : 0;
    Input.targetAngle[pid] = ph;
    Rotation.angle[pid] = ph * 0.3;
  });
  const s = performance.now();
  try { return tick(...a); } finally { if (measuring) { tickAt.push(s); tickMs.push(performance.now() - s); } }
};

anyServer.lastTickTime = performance.now();
anyServer.gameLoop();
// (3 s to settle, then measure)
setTimeout(() => {
  measuring = true;
  const cpu0 = process.cpuUsage(), t0 = performance.now();
  setTimeout(() => {
    measuring = false;
    const cpu = process.cpuUsage(cpu0), wall = performance.now() - t0;
    const gaps = tickAt.slice(1).map((t, i) => t - tickAt[i]).sort((a, b) => a - b);
    const stat = (v: number[]) => {
      const pct = (p: number) => v[Math.min(v.length - 1, Math.floor(v.length * p))].toFixed(2);
      return `mean ${(v.reduce((a, b) => a + b, 0) / v.length).toFixed(3)} · p50 ${pct(0.5)} · p99 ${pct(0.99)} · worst ${v[v.length - 1].toFixed(2)}`;
    };
    tickMs.sort((a, b) => a - b);
    console.log(`${PILOTS} pilots, ${(wall / 1000).toFixed(1)}s wall`);
    console.log(`cpu ${((cpu.user + cpu.system) / 1000 / wall * 100).toFixed(1)}% of a core · wakeups ${(wakeups / wall * 1000).toFixed(0)}/s · ticks ${(tickAt.length / wall * 1000).toFixed(2)}/s`);
    console.log(`tick interval ms: ${stat(gaps)}`);
    console.log(`tick ms: ${stat(tickMs)}`);
    process.exit(0);
  }, secs * 1000);
}, 3000);
