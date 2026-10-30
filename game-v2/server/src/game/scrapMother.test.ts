import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { Position, Velocity, InSystem, ServerMessage, isRuined, currentStage, createShipState, stepFlight, type FlightBody } from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigFromDisk } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../proto/createProtoServer.js';
import type { BossesFile } from './Bosses.js';

const dataDir = join(__dirname, '../../../data');
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const files = readGameDataFiles(dataDir);
const def = (files.bosses as BossesFile).bosses.boss_scrap_mother;

function world() {
  resetGlobals();
  const server = new GameServer({
    gameData: new GameData(files),
    userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as any,
    scene: 'sectors',
    autoStart: false,
    ships: createShipBridge(loadShipConfigFromDisk(dataDir)),
  });
  const t = new LocalTransport(server);
  const got: ServerMessage[] = [];
  t.onMessage = (m) => got.push(m);
  t.connect();
  t.send({ type: 'join', username: 'salvager' } as any);
  const pid = t.getPlayerId();
  const step = (n = 1) => { for (let i = 0; i < n; i++) server.step(); };
  const num = server['gameData'].getSystemNum(def.system);
  const god = () => server['admin'].god.add(server.pilots.connOf(pid) as any);
  return { server, got, pid, step, num, bridge: server.getShips(), god };
}

const place = (pid: number, num: number, x: number, y: number, vx = 0, vy = 0) => {
  InSystem.systemId[pid] = num; Position.x[pid] = x; Position.y[pid] = y; Velocity.x[pid] = vx; Velocity.y[pid] = vy;
};
const mend = (server: GameServer, pid: number) => server.getShips().scaleHp(pid, 1);
/** (dev) Her fight moved on to the start of a stage: what's before it beaten, blown away, and done blowing */
const advance = (server: GameServer, eid: number, stage: number, step: (n?: number) => void) => {
  const brain = server.bosses.brainOf(eid)!, bridge = server.getShips();
  for (let n = 1; n < 400; n++) {
    const s = bridge.get(eid);
    if (!s || currentStage(bridge.catalog, s) >= stage) break;
    brain.forceShed!(n);
  }
  step(2);
  for (let i = 0; i < 60 * 15 && brain.invulnerable!(); i++) step();
};
/** Which of her moves each message shows (her telegraphs and shots) */
const moveOf = (m: any): string => {
  if (m.type === 'bossTelegraph') return ({ rivet: 'barrage', magnet: 'haul', intake: 'intake', sludge: 'slag', weld: 'scissor', iris: 'iris' } as Record<string, string>)[m.kind] ?? '';
  return '';
};

describe('the Scrap Mother', () => {
  it('nests in the Drift, past Nereid (her nest\'s way in, out in Sol), waiting at its heart; she\'s Sol\'s toughest boss, and her quest asks for her level', () => {
    const nest = (files.systems as any).systems.find((s: any) => s.id === def.system);
    expect(nest.pocket.entrance.system).toBe('sol');
    const r = Math.hypot(nest.pocket.entrance.x, nest.pocket.entrance.y);
    expect(r).toBeGreaterThan(110000);
    expect(r).toBeLessThan(120000);
    expect(Math.hypot(def.lair.x, def.lair.y)).toBeLessThan(500);
    expect(def.level).toBe(8);
    expect(def.brain).toBe('scrap_mother');
    const quest = (files.quests as any).quests.find((q: any) => q.id === 'drift_03');
    expect(quest.level).toBe(def.level);
  });

  it('stage one, the hoard: rivet barrages down drawn lines, a haul that drags you in, her brood; between moves her guns fire', () => {
    const { server, got, pid, step, num, god } = world();
    god();
    const eid = server.bosses.spawn('boss_scrap_mother');
    place(pid, num, Position.x[eid] + 2400, Position.y[eid]);
    const seen: string[] = [];
    let pulled = false, mites = 0;
    for (let i = 0; i < 60 * 30 && seen.length < 3; i++) {
      got.length = 0;
      const before = Math.hypot(Position.x[pid] - Position.x[eid], Position.y[pid] - Position.y[eid]);
      Velocity.x[pid] = 0; Velocity.y[pid] = 0;
      step();
      if (i % 30 === 0) { mend(server, pid); place(pid, num, Position.x[eid] + 2400, Position.y[eid]); }
      for (const m of got) { const k = moveOf(m); if (k && seen[seen.length - 1] !== k) seen.push(k); }
      // (dragged towards her while her magnets pull)
      if (seen[seen.length - 1] === 'haul' && Math.hypot(Velocity.x[pid], Velocity.y[pid]) > 0.05 && Math.hypot(Position.x[pid] - Position.x[eid], Position.y[pid] - Position.y[eid]) <= before + 1) pulled = true;
      mites = Math.max(mites, server.mobs.count(num));
    }
    expect(seen.slice(0, 2)).toEqual(['barrage', 'haul']);
    expect(pulled).toBe(true);
    for (let i = 0; i < 60 * 8; i++) { step(); if (i % 30 === 0) mend(server, pid); mites = Math.max(mites, server.mobs.count(num)); }
    expect(mites).toBeGreaterThanOrEqual(4);
  });

  it('a stage-two piece shot while her nest stands hurts the nest instead; every slab gone, she stops, can\'t be hurt, and blows her scaffold away', () => {
    const { server, pid, step, num, bridge, god } = world();
    god();
    const eid = server.bosses.spawn('boss_scrap_mother');
    place(pid, num, Position.x[eid] + 2600, Position.y[eid]);
    step(5);
    const brain = server.bosses.brainOf(eid)!, s0 = bridge.get(eid)!, catalog = bridge.catalog;
    const piece = (i: number) => catalog.pieces.get(s0.blueprint.parts[i].piece)!;
    const body = s0.blueprint.parts.findIndex((_, i) => piece(i).stage === 2);
    const before = s0.hp.slice();
    bridge.hurt(eid, s0, body, 40);
    expect(bridge.get(eid)!.hp[body]).toBe(before[body]);
    for (const i of s0.blueprint.parts.map((_, k) => k)) { const q = bridge.get(eid)!; if (piece(i).stage === 1 && !piece(i).skeleton && q.derived.alive[i]) bridge.hurt(eid, q, i, 1e9); }
    step(2);
    expect(brain.invulnerable!()).toBe(true);
    for (let i = 0; i < 60 * 10 && brain.invulnerable!(); i++) step();
    const s = bridge.get(eid)!;
    expect(s.blueprint.parts.some((_, i) => s.derived.alive[i] && piece(i).stage === 1)).toBe(false);
    const w = s.hp[body];
    bridge.hurt(eid, s, body, 40);
    expect(bridge.get(eid)!.hp[body]).toBeLessThan(w);
  });

  it('stage two, the mill: an intake that sucks you towards her maw, sludge that lands and pools, rings of scrap; her body wrecks', () => {
    const { server, got, pid, step, num, bridge, god } = world();
    god();
    const eid = server.bosses.spawn('boss_scrap_mother');
    place(pid, num, Position.x[eid] + 1600, Position.y[eid]);
    step(5);
    got.length = 0;
    advance(server, eid, 2, step);
    const weapons = server['weapons'], spawn = weapons.spawn.bind(weapons);
    let chunks = 0;
    weapons.spawn = (owner: number, kind: string, ...rest: any[]) => { if (owner === eid && kind === 'scrap_chunk') chunks++; return (spawn as any)(owner, kind, ...rest); };
    const seen: string[] = [];
    let pools = 0;
    for (let i = 0; i < 60 * 40 && !(seen.length >= 2 && chunks > 0); i++) {
      if (i) { got.length = 0; step(); }
      if (i % 30 === 0) { mend(server, pid); place(pid, num, Position.x[eid] + 1600, Position.y[eid]); }
      for (const m of got) {
        const k = moveOf(m);
        if (k && seen[seen.length - 1] !== k) seen.push(k);
        if (m.type === 'bossTelegraph' && m.kind === 'pool') pools++;
      }
    }
    expect(seen.slice(0, 2)).toEqual(['intake', 'slag']);
    expect(pools).toBeGreaterThan(2);
    expect(chunks).toBeGreaterThanOrEqual(20);
    // Worn out, a body piece stays on, wrecked
    const s = bridge.get(eid)!, catalog = bridge.catalog;
    const vat = s.blueprint.parts.findIndex((p) => p.piece === 'scrapmother_vat_l');
    bridge.hurt(eid, s, vat, 1e9);
    step(1);
    expect(bridge.get(eid)!.derived.alive[vat]).toBe(true);
    expect(isRuined(catalog, bridge.get(eid)!, vat)).toBe(true);
  });

  it('stage two charges only if you keep away from her, now and then', () => {
    const charges = (d: number) => {
      const { server, got, pid, step, num, god } = world();
      god();
      const eid = server.bosses.spawn('boss_scrap_mother');
      place(pid, num, Position.x[eid] + d, Position.y[eid]);
      step(5);
      advance(server, eid, 2, step);
      const keep = () => { const a = Math.atan2(def.lair.y - Position.y[eid], def.lair.x - Position.x[eid]); place(pid, num, Position.x[eid] + Math.cos(a) * d, Position.y[eid] + Math.sin(a) * d); };
      let n = 0;
      for (let i = 0; i < 60 * 30; i++) {
        got.length = 0;
        step();
        if (i % 20 === 0) { mend(server, pid); keep(); }
        n += got.filter((m) => m.type === 'bossTelegraph' && m.kind === 'charge').length;
      }
      return n;
    };
    expect(charges(1300)).toBe(0);
    const far = charges(3600);
    expect(far).toBeGreaterThanOrEqual(1);
    expect(far).toBeLessThanOrEqual(2);
  });

  it('stage three, the seed: she darts, scissors her welders, looses seekers, spirals chunks, then opens her iris (braced, she takes less; open, more)', () => {
    const { server, got, pid, step, num, bridge, god } = world();
    god();
    const eid = server.bosses.spawn('boss_scrap_mother');
    place(pid, num, Position.x[eid] + 1300, Position.y[eid]);
    step(5);
    const brain = server.bosses.brainOf(eid)!;
    advance(server, eid, 3, step);
    const weapons = server['weapons'], spawn = weapons.spawn.bind(weapons);
    const shots: { kind: string; target?: number }[] = [];
    weapons.spawn = (owner: number, kind: string, x: number, y: number, a: number, k: number, shape: any, ...rest: any[]) => { if (owner === eid) shots.push({ kind, target: shape?.target }); return (spawn as any)(owner, kind, x, y, a, k, shape, ...rest); };
    const braced = brain.taken!();
    const seen: string[] = [];
    let darts = 0, beams = 0;
    for (let i = 0; i < 60 * 50 && !seen.includes('iris'); i++) {
      got.length = 0;
      step();
      if (i % 30 === 0) { mend(server, pid); place(pid, num, Position.x[eid] + 1300, Position.y[eid]); }
      for (const m of got) {
        const k = moveOf(m);
        if (k && seen[seen.length - 1] !== k) seen.push(k);
        if (m.type === 'bossTelegraph' && m.kind === 'dash') darts++;
        if (m.type === 'bossBeam' && (m as any).kind === 'weld') beams++;
      }
    }
    expect(seen).toEqual(['scissor', 'iris']);
    expect(beams).toBe(2);
    // (a dart before every move: the first can come as she finishes blowing her body away)
    expect(darts).toBeGreaterThanOrEqual(3);
    expect(shots.filter((s) => s.kind === 'seam_seeker').length).toBeGreaterThanOrEqual(8);
    expect(shots.filter((s) => s.kind === 'seam_seeker').every((s) => s.target === pid)).toBe(true);
    expect(shots.filter((s) => s.kind === 'scrap_chunk').length).toBeGreaterThan(30);
    step(5);
    expect(braced).toBeLessThan(0.5);
    expect(brain.taken!()).toBeGreaterThan(1);
    void bridge;
  });

  it('her seed\'s round wrecks, not shot off; all wrecked, she shudders and every piece blows apart at once', () => {
    const { server, got, pid, step, num, bridge, god } = world();
    god();
    const eid = server.bosses.spawn('boss_scrap_mother');
    place(pid, num, Position.x[eid] + 1300, Position.y[eid]);
    step(5);
    const brain = server.bosses.brainOf(eid)!;
    advance(server, eid, 3, step);
    let s = bridge.get(eid)!;
    const catalog = bridge.catalog;
    const round = s.blueprint.parts.flatMap((p, i) => (/s3_(petal\d|servo\d+|core)$/.test(p.piece) ? [i] : []));
    expect(round.length).toBe(19);
    // (its other heart pieces are still on: they hold to the round, not only to the body that was over them)
    expect(s.blueprint.parts.filter((p, i) => p.piece.includes('_s3_') && s.derived.alive[i]).length).toBe(27);
    for (const i of round.slice(0, -1)) bridge.hurt(eid, bridge.get(eid)!, i, 1e9);
    step(1);
    s = bridge.get(eid)!;
    expect(round.slice(0, -1).every((i) => s.derived.alive[i] && isRuined(catalog, s, i))).toBe(true);
    const before = new Set(bridge.bodies.keys());
    bridge.hurt(eid, s, round[round.length - 1], 1e9);
    step(2);
    expect(brain.invulnerable!()).toBe(true);
    let gone = -1;
    for (let i = 0; i < 200 && gone < 0; i++) { step(); if (!bridge.has(eid)) gone = i; }
    expect(gone).toBeGreaterThan(40);
    // Thrown out in a few great chunks (not a body for every piece), only to be seen: nothing hits them, they hit nothing
    const chunks = [...bridge.bodies.keys()].filter((k) => !before.has(k) && bridge.get(k)!.kind === 'debris');
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks.length).toBeLessThanOrEqual(12);
    expect(chunks.every((k) => (bridge as any).intangible.has(k))).toBe(true);
    expect(got.some((m) => m.type === 'bossDefeated' && (m as any).bodyId === eid)).toBe(true);
    void pid;
  });

  it('a boss turns as its hull lets it, braking onto its heading: no overshoot, no hunting back and forth (and every client steps it the same)', () => {
    const { bridge } = world();
    for (const [name, turn] of [['scrap_mother', def.turn!], ['pyreclast', (files.bosses as BossesFile).bosses.boss_pyreclast.turn!]] as const) {
      const ship = createShipState(bridge.catalog, bridge.tuning, 1, { ...(bridge as any).enemyDesigns[name], drive: 2.5, turn }, 0);
      const body: FlightBody = { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angVel: 0 } as FlightBody;
      const want = Math.PI * 0.9;
      let most = 0, settled = -1, flips = 0, last = 0;
      for (let i = 0; i < 60 * 12; i++) {
        stepFlight(body, { forward: false, backward: false, left: false, right: false, boost: false, targetAngle: want }, ship.derived, bridge.tuning, { charge: 1 as any, drainRate: 0 }, { friction: 0.99, boostFactor: 1, worldSize: 1e9 });
        most = Math.max(most, body.angle);
        // (a reversal worth seeing: faster than a tenth of a degree a second)
        const sgn = Math.abs(body.angVel) > 3e-5 ? Math.sign(body.angVel) : 0;
        if (sgn && last && sgn !== last) flips++;
        if (sgn) last = sgn;
        if (settled < 0 && Math.abs(body.angle - want) < 0.02) settled = i;
      }
      // (past its heading by under a degree, at most one reversal, and there within a few seconds)
      expect(most - want, name).toBeLessThan(0.02);
      expect(flips, name).toBeLessThanOrEqual(1);
      expect(settled, name).toBeGreaterThan(0);
      expect(settled, name).toBeLessThan(60 * 6);
    }
  });

  it('between moves she faces the way she\'s flying, not you: her flanks and back come round to be hit', () => {
    const { server, pid, step, num, god } = world();
    god();
    const eid = server.bosses.spawn('boss_scrap_mother');
    place(pid, num, Position.x[eid] + 2600, Position.y[eid]);
    const brain: any = server.bosses.brainOf(eid)!;
    let between = 0, away = 0;
    for (let i = 0; i < 60 * 40; i++) {
      step();
      if (i % 30 === 0) { mend(server, pid); place(pid, num, Position.x[eid] + 2600, Position.y[eid]); }
      if (brain.move) continue;
      const ang = (server.getShips() as any).pose(eid).angle, to = Math.atan2(Position.y[pid] - Position.y[eid], Position.x[pid] - Position.x[eid]);
      let d = Math.abs(ang - to) % (2 * Math.PI); if (d > Math.PI) d = 2 * Math.PI - d;
      between++;
      if (d > Math.PI / 4) away++;
    }
    expect(between).toBeGreaterThan(200);
    expect(away / between).toBeGreaterThan(0.4);
  });

  it('she flies as built throughout, and turns to face you in good time', () => {
    const { server, pid, step, num, bridge } = world();
    const eid = server.bosses.spawn('boss_scrap_mother');
    place(pid, num, Position.x[eid] + 2400, Position.y[eid]);
    step(5);
    const { com, mass } = bridge.get(eid)!.derived;
    // Behind her: she comes round to face you within a few seconds
    const me = () => ({ x: Position.x[eid], y: Position.y[eid] });
    let faced = -1;
    for (let i = 0; i < 60 * 6 && faced < 0; i++) {
      if (i === 0) { const p = me(); const ang = (bridge as any).pose(eid).angle; place(pid, num, p.x - Math.cos(ang) * 2400, p.y - Math.sin(ang) * 2400); }
      step();
      const p = me(), ang = (bridge as any).pose(eid).angle, want = Math.atan2(Position.y[pid] - p.y, Position.x[pid] - p.x);
      let d = want - ang; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
      if (Math.abs(d) < 0.3) faced = i;
    }
    expect(faced).toBeGreaterThanOrEqual(0);
    expect(faced).toBeLessThan(60 * 5);
    advance(server, eid, 3, step);
    expect(bridge.get(eid)!.derived.com).toEqual(com);
    expect(bridge.get(eid)!.derived.mass).toBe(mass);
  });
});
