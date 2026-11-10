/**
 * The Scrap Mother's fight length, measured on the real server (docs/bosses/rework-2026-11.md 3, boss-design.md 6):
 * 1-4 pilots inside her arena (they can't be hurt: the model counts no deaths), each landing a starter's two Pips (112
 * raw a second, pen 0.5 kinetic) at the model's hit rates: 0.5 x 0.6 of it during her moves and between them, 0.85 x
 * 0.95 in her windows, on her current stage's standing deciding pieces (what a pilot shoots at), through her real
 * armour, windows, cracks, stage blow-aways and death. Her 6 s wake is added (she's spawned awake here).
 *   npx tsx src/bench/motherFight.ts [pilots...]      (default 1 2 3 4)
 */
import { join } from 'path';
import * as bitecs from 'bitecs';
import { InSystem, Position, Velocity, currentStage, deciding, standing, stageOf, windowOpen, staggered } from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigFromDisk } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../ships/createShipBridge.js';
import { devHooks } from '../game/brains/kit.js';

const dataDir = join(import.meta.dirname, '../../../data');
const files = readGameDataFiles(dataDir);
const RAW = 112 / 60, MOVES = 0.5 * 0.6, WINDOWS = 0.85 * 0.95, WAKE_S = 6;

function fight(n: number): { secs: number; stages: number[]; windows: number; cracks: number; drawn: number } {
  (bitecs as unknown as { resetGlobals: () => void }).resetGlobals();
  const server = new GameServer({
    gameData: new GameData(files), userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as any,
    scene: 'sectors', autoStart: false, ships: createShipBridge(loadShipConfigFromDisk(dataDir)),
  });
  const num = server['gameData'].getSystemNum('sol_scrap_nest');
  const pids: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = new LocalTransport(server);
    t.connect();
    t.send({ type: 'join', username: `pilot${i}` } as any);
    pids.push(t.getPlayerId());
  }
  const eid = server.bosses.spawn('boss_scrap_mother');
  const brain = server.bosses.brainOf(eid)!, hooks = devHooks(brain)!, bridge = server.getShips(), cat = bridge.catalog;
  for (const p of pids) server.bosses.unhurt.add(p);
  const place = (k: number) => {
    const p = pids[k], a = (k / n) * Math.PI * 2;
    InSystem.systemId[p] = num; Position.x[p] = Position.x[eid] + Math.cos(a) * 1700; Position.y[p] = Position.y[eid] + Math.sin(a) * 1700;
    Velocity.x[p] = 0; Velocity.y[p] = 0;
  };
  pids.forEach((_, k) => place(k));
  const owed = pids.map(() => 0), stages: number[] = [], through: number[] = [], sent: number[] = [];
  let tick = 0, stage = 1;
  for (; tick < 60 * 60 * 20 && bridge.has(eid); tick++) {
    server.step();
    if (tick % 20 === 0) pids.forEach((p, k) => { bridge.scaleHp(p, 1); place(k); });
    const ship = bridge.get(eid);
    if (!ship) break;
    const st = currentStage(cat, ship);
    if (st !== stage && st > 0) { stages.push(tick); stage = st; }
    const w = hooks.fight.window, now = server.currentTick;
    const rate = windowOpen(w, now) && !staggered(w, now) ? WINDOWS : MOVES;
    if (brain.invulnerable!()) continue;
    for (let k = 0; k < n; k++) owed[k] += RAW * rate;
    if (tick % 6) continue;
    const targets = ship.blueprint.parts.flatMap((_, i) => (stageOf(cat, ship, i) === st && deciding(cat, ship, i) && standing(cat, ship, i) ? [i] : []));
    if (!targets.length) continue;
    for (let k = 0; k < n; k++) {
      // (each pilot works on one piece at a time, the one nearest gone: as a player finishes off what's cracked)
      const part = targets.reduce((a, b) => (ship.hp[b] < ship.hp[a] ? b : a));
      const before = bridge.get(eid)!.hp.reduce((a, b) => a + b, 0), share = brain.windowShare!() * brain.taken!();
      bridge.damagePartBy(eid, targets[(k + targets.indexOf(part)) % targets.length], owed[k], pids[k], { type: 'kinetic', pen: 0.5 });
      const got = before - (bridge.get(eid)?.hp.reduce((a, b) => a + b, 0) ?? before);
      if (share > 0) { through[st] = (through[st] ?? 0) + got / share; sent[st] = (sent[st] ?? 0) + owed[k]; }
      owed[k] = 0;
    }
  }
  const s = hooks.fight.stats;
  if (process.env.DBG) console.log('armour x resist by stage', [1, 2, 3].map((k) => (through[k] / sent[k]).toFixed(3)).join(' '));
  return { secs: tick / 60 + WAKE_S, stages: stages.map((t) => Math.round(t / 60)), windows: s.windows, cracks: s.cracks, drawn: [...s.drawn.values()].reduce((a, b) => a + b, 0) };
}

const counts = process.argv.slice(2).map(Number).filter((x) => x > 0);
for (const n of counts.length ? counts : [1, 2, 3, 4]) {
  const t0 = Date.now(), r = fight(n);
  console.log(`${n} pilot${n > 1 ? 's' : ''}: ${(r.secs / 60).toFixed(1)} min (stages end at ${r.stages.join(', ')} s; ${r.windows} windows, ${r.cracks} cracked; ${r.drawn} personal attacks)  [${((Date.now() - t0) / 1000).toFixed(0)} s to run]`);
}
