/**
 * Boss fight length (measurement only, changes nothing in the game: docs/boss-design.md section 6, the rework's model
 * docs/bosses/rework-2026-11.md 3.2): a staged boss fought to the death by N virtual pilots landing the model's damage
 * through the real fight: its moves, windows (x2 to the cap, the crack, x0.35 outside), stage cover, armour and
 * penetration, its stages blown away. One real pilot (god mode) is its target, held at its stage's range; the others
 * only add their damage. Each 6 ticks each pilot lands raw DPS x the share of shots that hit x the share of the time
 * spent firing (one pair of shares in its moves, another in its windows: --preset), as one hit of its penetration on a
 * standing deciding piece of the stage being fought.
 *
 * Run (in server/):
 *   npx tsx src/bench/bossLength.ts --boss boss_pyreclast --preset offMeta --pilots 1,2,4
 *   presets: offMeta (260 raw, pen 2.5, 0.45x0.45 in moves, 0.8x0.95 in windows), meta (pen 4, 0.5x0.6, 0.85x0.95x1.1),
 *            starter (112 raw, pen 0.5, 0.5x0.6, 0.85x0.95). --raw, --pen override. --cap seconds (default 1800)
 */

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as bitecs from 'bitecs';
import { Position, InSystem, currentStage, deciding, standing, windowOpen, staggered, type ServerMessage } from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigFromDisk } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../proto/createProtoServer.js';
import type { StagedBrain } from '../game/brains/staged.js';

const dataDir = join(dirname(fileURLToPath(import.meta.url)), '../../../data');
const arg = (k: string, d: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const PRESETS: Record<string, { raw: number; pen: number; move: number; win: number }> = {
  offMeta: { raw: 260, pen: 2.5, move: 0.45 * 0.45, win: 0.8 * 0.95 },
  meta: { raw: 260, pen: 4, move: 0.5 * 0.6, win: 0.85 * 0.95 * 1.1 },
  starter: { raw: 112, pen: 0.5, move: 0.5 * 0.6, win: 0.85 * 0.95 },
};

function fight(bossId: string, pilots: number, p: { raw: number; pen: number; move: number; win: number }, capSecs: number) {
  (bitecs as unknown as { resetGlobals: () => void }).resetGlobals();
  const files = readGameDataFiles(dataDir);
  const server = new GameServer({
    gameData: new GameData(files), userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as never,
    scene: 'sectors', autoStart: false, ships: createShipBridge(loadShipConfigFromDisk(dataDir)),
  });
  const t = new LocalTransport(server);
  t.onMessage = (_m: ServerMessage) => {};
  t.connect();
  t.send({ type: 'join', username: 'bench' } as never);
  const pid = t.getPlayerId();
  (server as unknown as { admin: { god: Set<unknown> } }).admin.god.add(server.pilots.connOf(pid));
  const def = (files.bosses as { bosses: Record<string, { system: string }> }).bosses[bossId];
  const num = server['gameData'].getSystemNum(def.system);
  const eid = server.bosses.spawn(bossId);
  const bridge = server.getShips(), cat = bridge.catalog;
  const brain = server.bosses.brainOf(eid) as unknown as StagedBrain & { flight: { range: number[] } };
  let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const stageAt: number[] = [];
  let lastStage = 1, windows = 0, cracks = 0, tick = 0;
  const t0 = Date.now();
  for (; tick < capSecs * 60 && bridge.has(eid); tick++) {
    const s = bridge.get(eid)!, st = brain.stageNow;
    if (st !== lastStage) { stageAt.push(tick / 60); lastStage = st; }
    if (tick % 30 === 0) {
      const r = brain.flight.range[st - 1] ?? 2000;
      InSystem.systemId[pid] = num; Position.x[pid] = Position.x[eid] + r; Position.y[pid] = Position.y[eid];
      bridge.scaleHp(pid, 1);
    }
    if (tick % 6 === 0 && !brain.invulnerable()) {
      const now = server.getTick(), w = brain.fight.window;
      const share = windowOpen(w, now) || staggered(w, now) ? p.win : p.move;
      const cur = currentStage(cat, s);
      const targets = s.blueprint.parts.flatMap((_, i) => (deciding(cat, s, i) && standing(cat, s, i) && (cur === 0 || cat.pieces.get(s.blueprint.parts[i].piece)?.stage === cur) ? [i] : []));
      if (targets.length) bridge.damagePartBy(eid, targets[Math.floor(rnd() * targets.length)], p.raw * share * pilots * (6 / 60), pid, { type: 'kinetic', pen: p.pen });
    }
    server.step();
    if (VERBOSE && tick % 1800 === 0) console.log(`  ${(tick / 60).toFixed(0)} s: stage ${st}, whole ${brain.integrity().toFixed(3)}, move ${brain.moveName || '-'}, ${Date.now() - t0} ms`);
  }
  windows = brain.fight.stats.windows; cracks = brain.fight.stats.cracks;
  return { secs: tick / 60, dead: !bridge.has(eid), stageAt, windows, cracks };
}

const VERBOSE = process.argv.includes('--verbose');
const boss = arg('--boss', 'boss_pyreclast'), preset = PRESETS[arg('--preset', 'offMeta')];
const p = { ...preset, raw: Number(arg('--raw', String(preset.raw))), pen: Number(arg('--pen', String(preset.pen))) };
for (const n of arg('--pilots', '1').split(',').map(Number)) {
  const r = fight(boss, n, p, Number(arg('--cap', '1800')));
  console.log(`${boss} ${arg('--preset', 'offMeta')} ${n} pilot(s): ${(r.secs / 60).toFixed(2)} min${r.dead ? '' : ' (not beaten: capped)'}; stages end at ${[...r.stageAt, r.secs].map((x) => (x / 60).toFixed(2)).join(' / ')} min; ${r.windows} windows, ${r.cracks} cracked`);
}
process.exit(0);
