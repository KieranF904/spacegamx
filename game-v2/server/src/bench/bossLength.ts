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
 *
 * Pressure (rework 2026-11 section 15): the share of the fight's time with a threat on the real pilot: a live tell or
 * beam (a ground mark only within PRESSURE_NEAR of it; a window's look is not one), a move under way, a personal
 * attack running, its mobs out, or a hostile shot within PRESSURE_NEAR. Its stagger and its stages being blown away
 * (it can't be hurt, nor hurt you) are left out. Also reported: the longest quiet gap, and how many run over 2 s, and
 * each stage's mean window fill (1: cracked).
 */

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as bitecs from 'bitecs';
import { Position, InSystem, Projectile, currentStage, deciding, standing, windowOpen, staggered, windowFill, dhypot, type WindowState, type ServerMessage } from '@space-game/common';
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

/** A hostile shot (or a ground mark) this near the pilot is a threat on them */
const PRESSURE_NEAR = 1500;
/** Tells that are a window's look (the boss laid open), not a threat */
const NOT_THREATS = new Set(['steam', 'sparks', 'drip', 'glow_red', 'iris', 'vent']);
const projectiles = bitecs.defineQuery([Projectile]);

function fight(bossId: string, pilots: number, p: { raw: number; pen: number; move: number; win: number }, capSecs: number) {
  (bitecs as unknown as { resetGlobals: () => void }).resetGlobals();
  const files = readGameDataFiles(dataDir);
  const server = new GameServer({
    gameData: new GameData(files), userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as never,
    scene: 'sectors', autoStart: false, ships: createShipBridge(loadShipConfigFromDisk(dataDir)),
  });
  const t = new LocalTransport(server);
  // (live tells: until when; ground marks kept with where they are)
  let tellUntil = -1;
  const marks: { x: number; y: number; r: number; until: number }[] = [];
  t.onMessage = (m: ServerMessage) => {
    if (m.type !== 'bossTelegraph' && m.type !== 'bossBeam') return;
    if (m.type === 'bossTelegraph' && NOT_THREATS.has(m.kind)) return;
    const until = server.getTick() + m.ticks;
    if (m.bodyId === undefined) marks.push({ x: m.x, y: m.y, r: (m as { radius?: number }).radius ?? 200, until });
    else tellUntil = Math.max(tellUntil, until);
  };
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
  // Pressure: ticks counted, ticks under threat, the quiet gap running, the longest, and how many ran past 2 s
  let counted = 0, pressed = 0, gap = 0, longest = 0, over2 = 0;
  // Each window's fill when it closed (or was cracked), by stage
  const fills: number[][] = [[], [], []];
  let lastW: WindowState | null = null, lastWStage = 1;
  // Each stage's loop (a window's opening to the next's, in the same stage), in ticks
  const loops: number[][] = [[], [], []];
  let prevAt = -1, prevStage = 0;
  const endGap = () => { longest = Math.max(longest, gap); if (gap > 120) over2++; gap = 0; };
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
    {
      const now = server.getTick(), w = brain.fight.window;
      if (lastW && w !== lastW) fills[lastWStage - 1]?.push(windowFill(lastW));
      if (w !== lastW) { lastW = w; lastWStage = brain.stageNow; }
      if (w && w.at !== prevAt) {
        if (prevStage === brain.stageNow) loops[brain.stageNow - 1]?.push(w.at - prevAt);
        prevAt = w.at; prevStage = brain.stageNow;
      }
      if (brain.invulnerable() || staggered(w, now) || !bridge.has(eid)) endGap();
      else {
        const px = Position.x[pid], py = Position.y[pid];
        for (let k = marks.length - 1; k >= 0; k--) if (marks[k].until <= now) marks.splice(k, 1);
        let threat = tellUntil > now || (!!brain.moveName && brain.moveName !== 'rest') || brain.fight.running > 0
          || server.mobs.ownedBy(num, eid) > 0
          || marks.some((k) => dhypot(k.x - px, k.y - py) < k.r + PRESSURE_NEAR);
        if (!threat) for (const p of projectiles(server.world)) {
          if (Projectile.ownerId[p] === pid || dhypot(Position.x[p] - px, Position.y[p] - py) > PRESSURE_NEAR) continue;
          threat = true;
          break;
        }
        counted++;
        if (threat) { pressed++; endGap(); } else gap++;
      }
    }
    if (VERBOSE && tick % 1800 === 0) console.log(`  ${(tick / 60).toFixed(0)} s: stage ${st}, whole ${brain.integrity().toFixed(3)}, move ${brain.moveName || '-'}, ${Date.now() - t0} ms`);
  }
  windows = brain.fight.stats.windows; cracks = brain.fight.stats.cracks;
  endGap();
  const mean = (l: number[]) => (l.length ? l.reduce((a, b) => a + b, 0) / l.length : 0);
  return { secs: tick / 60, dead: !bridge.has(eid), stageAt, windows, cracks, pressure: counted ? pressed / counted : 0, longest: longest / 60, over2, fills: fills.map(mean), loops: loops.map(mean) };
}

const VERBOSE = process.argv.includes('--verbose');
const boss = arg('--boss', 'boss_pyreclast'), preset = PRESETS[arg('--preset', 'offMeta')];
const p = { ...preset, raw: Number(arg('--raw', String(preset.raw))), pen: Number(arg('--pen', String(preset.pen))) };
for (const n of arg('--pilots', '1').split(',').map(Number)) {
  const r = fight(boss, n, p, Number(arg('--cap', '1800')));
  console.log(`${boss} ${arg('--preset', 'offMeta')} ${n} pilot(s): ${(r.secs / 60).toFixed(2)} min${r.dead ? '' : ' (not beaten: capped)'}; stages end at ${[...r.stageAt, r.secs].map((x) => (x / 60).toFixed(2)).join(' / ')} min; ${r.windows} windows, ${r.cracks} cracked; window fill by stage ${r.fills.map((f) => f.toFixed(2)).join(' / ')}; loop (window to window) ${r.loops.map((l) => (l / 60).toFixed(1)).join(' / ')} s; pressure ${(r.pressure * 100).toFixed(1)}%, longest gap ${r.longest.toFixed(1)} s, ${r.over2} gaps over 2 s`);
}
process.exit(0);
