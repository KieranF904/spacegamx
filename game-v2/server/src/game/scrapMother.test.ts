import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { Position, Velocity, InSystem, ServerMessage, isRuined, currentStage, createShipState, stepFlight, deciding, stageOf, type FlightBody } from '@space-game/common';
import { devHooks } from './brains/kit.js';
import { MOTHER_SIGNATURE, MOTHER_EXPOSURE, MOTHER_LOOP } from './brains/scrapMother.js';
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
/**
 * Her fight watched from a pilot held `d` from her (mended, never dying), until `w` windows have opened: the signature
 * moves in the order she starts them, the windows told (their caps), the order of both (`order`: a move's name, or
 * 'window'), her tells' kinds in order (with the tick each came), sweeping beams and darts
 */
function watch(server: GameServer, got: ServerMessage[], eid: number, pid: number, num: number, d: number, ticks: number, w: number) {
  const hooks = devHooks(server.bosses.brainOf(eid))!;
  const moves: string[] = [], windows: { cap: number; at: number }[] = [], tells: string[] = [], told: { kind: string; at: number; ticks: number }[] = [], order: string[] = [];
  let beams = 0, darts = 0, last = '';
  for (let i = 0; i < ticks && windows.length < w; i++) {
    got.length = 0;
    server.step();
    if (i % 30 === 0) { mend(server, pid); place(pid, num, Position.x[eid] + d, Position.y[eid]); }
    const name = hooks.moveName;
    if (name && name !== last && MOTHER_SIGNATURE[name]) { moves.push(name); order.push(name); }
    last = name;
    for (const m of got as any[]) {
      if (m.type === 'bossWindow' && m.bodyId === eid && m.ticks > 0 && m.fill === 0 && !m.crack) { windows.push({ cap: m.cap, at: server.getTick() }); order.push('window'); }
      if (m.type === 'bossTelegraph') { tells.push(m.kind); told.push({ kind: m.kind, at: server.getTick(), ticks: m.ticks }); if (m.kind === 'dash') darts++; }
      if (m.type === 'bossBeam' && m.kind === 'weld') beams++;
    }
  }
  return { moves, windows, tells, told, order, beams, darts };
}

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

  it('stage one, the hoard: one attack phase, barrage, crane and haul chained, each told first on her hull, then one short window; her guns keep firing in it', () => {
    const { server, got, pid, num, god } = world();
    god();
    const eid = server.bosses.spawn('boss_scrap_mother');
    place(pid, num, Position.x[eid] + 2400, Position.y[eid]);
    const { order, windows, tells, told } = watch(server, got, eid, pid, num, 2400, 60 * 50, 2);
    // (her three moves back to back, then her one window, then the phase again)
    expect(order.slice(0, 5)).toEqual(['barrage', 'crane', 'haul', 'window', 'barrage']);
    expect(windows[0].cap).toBe(MOTHER_EXPOSURE[0].cap);
    expect(MOTHER_EXPOSURE[0].ticks).toBeLessThanOrEqual(300);
    // (the phase is quick: barrage to window in under 15 s)
    expect(windows[1].at - windows[0].at).toBeLessThan(60 * 20);
    // (the tells: a gun's faint line, the crane's amber lamp, her magnets' green glow: each before its move's first hurt)
    expect(tells.indexOf('rivet')).toBeGreaterThanOrEqual(0);
    expect(tells.indexOf('glow_amber')).toBeGreaterThan(tells.indexOf('rivet'));
    expect(tells.indexOf('glow_green')).toBeGreaterThan(tells.indexOf('glow_amber'));
    // (in her window, after its 1 s rest beat, a gun still draws a line at you: never just sitting there)
    const w0 = windows[0].at, inWindow = told.filter((t) => t.kind === 'rivet' && t.at > w0 && t.at < w0 + MOTHER_EXPOSURE[0].ticks);
    expect(inWindow.length).toBeGreaterThanOrEqual(2);
    expect(inWindow.every((t) => t.at >= w0 + 60)).toBe(true);
  });

  it('she keeps up the pressure: from her first tell on, never more than 2 s without a tell live or a move under way, outside a stagger', () => {
    for (const stage of [1, 2, 3]) {
      const { server, got, pid, step, num, god } = world();
      god();
      const eid = server.bosses.spawn('boss_scrap_mother');
      place(pid, num, Position.x[eid] + 2000, Position.y[eid]);
      step(5);
      if (stage > 1) advance(server, eid, stage, step);
      const hooks = devHooks(server.bosses.brainOf(eid))!;
      let live = -1, quiet = 0, longest = 0, started = false;
      for (let i = 0; i < 60 * 40; i++) {
        got.length = 0;
        step();
        if (i % 30 === 0) { mend(server, pid); place(pid, num, Position.x[eid] + 2000, Position.y[eid]); }
        for (const m of got as any[]) if (m.type === 'bossTelegraph' || m.type === 'bossBeam') { live = Math.max(live, server.getTick() + m.ticks); started = true; }
        if (!started) continue;
        const busy = live > server.getTick() || (!!hooks.moveName && MOTHER_SIGNATURE[hooks.moveName] !== undefined) || hooks.fight.staggered(server.getTick());
        quiet = busy ? 0 : quiet + 1;
        longest = Math.max(longest, quiet);
      }
      expect(longest, `stage ${stage}`).toBeLessThanOrEqual(120);
    }
  }, 60_000);

  it('her haul pulls only what is in front of her, and her crane misses what is close in', () => {
    const pulled = (side: number) => {
      const { server, pid, step, num, god } = world();
      god();
      const eid = server.bosses.spawn('boss_scrap_mother');
      place(pid, num, Position.x[eid] + 2400, Position.y[eid]);
      step(5);
      const hooks = devHooks(server.bosses.brainOf(eid))!;
      hooks.devPlay('haul');
      let moved = 0;
      for (let i = 0; i < 200; i++) {
        const a = (server.getShips() as any).pose(eid).angle + side;
        place(pid, num, Position.x[eid] + Math.cos(a) * 2000, Position.y[eid] + Math.sin(a) * 2000);
        step();
        if (hooks.moveName === 'haul') moved = Math.max(moved, Math.hypot(Velocity.x[pid], Velocity.y[pid]));
        mend(server, pid);
      }
      return moved;
    };
    expect(pulled(0)).toBeGreaterThan(0.05);
    expect(pulled(Math.PI)).toBeLessThan(0.01);
    expect(pulled(Math.PI / 2 + 0.3)).toBeLessThan(0.01);
    const struck = (d: number) => {
      const { server, pid, step, num, bridge } = world();
      const eid = server.bosses.spawn('boss_scrap_mother');
      step(5);
      const hooks = devHooks(server.bosses.brainOf(eid))!;
      hooks.devPlay('crane');
      const hp0 = bridge.integrity(pid);
      for (let i = 0; i < 280; i++) {
        const a = (bridge as any).pose(eid).angle;
        place(pid, num, Position.x[eid] + Math.cos(a) * d, Position.y[eid] + Math.sin(a) * d);
        step();
      }
      return hp0 - bridge.integrity(pid);
    };
    expect(struck(2900)).toBeGreaterThan(0);
    expect(struck(1750)).toBe(0);
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

  it('stage two, the mill: shrapnel, charge, intake, charge chained, then her window; her rings always open at her flanks; her body wrecks', () => {
    const { server, got, pid, step, num, bridge, god } = world();
    god();
    const eid = server.bosses.spawn('boss_scrap_mother');
    place(pid, num, Position.x[eid] + 1600, Position.y[eid]);
    step(5);
    advance(server, eid, 2, step);
    got.length = 0;
    const weapons = server['weapons'], spawn = weapons.spawn.bind(weapons);
    const chunks: number[] = [];
    weapons.spawn = (owner: number, kind: string, x: number, y: number, a: number, ...rest: any[]) => { if (owner === eid && kind === 'scrap_chunk') chunks.push(a - (bridge as any).pose(eid).angle); return (spawn as any)(owner, kind, x, y, a, ...rest); };
    const { order, windows } = watch(server, got, eid, pid, num, 1600, 60 * 50, 1);
    expect(order.slice(0, 5)).toEqual([...MOTHER_LOOP[1], 'window']);
    expect(MOTHER_LOOP[1]).toEqual(['shrapnel', 'charge', 'intake', 'charge']);
    expect(windows[0].cap).toBe(MOTHER_EXPOSURE[1].cap);
    expect(chunks.length).toBeGreaterThanOrEqual(60);
    // (no chunk flies out of her flanks: the gap is there every ring)
    for (const a of chunks) {
      const off = Math.abs(Math.atan2(Math.sin(a), Math.cos(a)));
      expect(Math.abs(off - Math.PI / 2)).toBeGreaterThan(0.2);
    }
    // Worn out, a body piece stays on, wrecked
    const s = bridge.get(eid)!, catalog = bridge.catalog;
    const vat = s.blueprint.parts.findIndex((p) => p.piece === 'scrapmother_vat_l');
    bridge.hurt(eid, s, vat, 1e9);
    step(1);
    expect(bridge.get(eid)!.derived.alive[vat]).toBe(true);
    expect(isRuined(catalog, bridge.get(eid)!, vat)).toBe(true);
  });

  it('a move whose part is shot off goes out of her phase: she goes straight on to the next, and her window opens as ever', () => {
    const { server, got, pid, step, num, bridge, god } = world();
    god();
    const eid = server.bosses.spawn('boss_scrap_mother');
    place(pid, num, Position.x[eid] + 2400, Position.y[eid]);
    step(5);
    const s = bridge.get(eid)!;
    for (const name of ['magnet_l', 'magnet_r']) bridge.hurt(eid, bridge.get(eid)!, s.blueprint.parts.findIndex((p) => p.piece === `scrapmother_${name}`), 1e9);
    step(2);
    got.length = 0;
    const { order } = watch(server, got, eid, pid, num, 2400, 60 * 40, 2);
    expect(order.slice(0, 6)).toEqual(['barrage', 'crane', 'window', 'barrage', 'crane', 'window']);
    expect(got.some((m) => m.type === 'bossTelegraph' && (m as any).kind === 'glow_green')).toBe(false);
  });

  it('stage three, the seed: spiral, scissor, seekers, scissor chained, then her window; she repositions once (in the spiral\'s tell), looses eight seekers in all', () => {
    const { server, got, pid, step, num, god } = world();
    god();
    const eid = server.bosses.spawn('boss_scrap_mother');
    place(pid, num, Position.x[eid] + 1300, Position.y[eid]);
    step(5);
    advance(server, eid, 3, step);
    got.length = 0;
    const weapons = server['weapons'], spawn = weapons.spawn.bind(weapons);
    const shots: { kind: string; target?: number }[] = [];
    weapons.spawn = (owner: number, kind: string, x: number, y: number, a: number, k: number, shape: any, ...rest: any[]) => { if (owner === eid) shots.push({ kind, target: shape?.target }); return (spawn as any)(owner, kind, x, y, a, k, shape, ...rest); };
    const { order, windows, beams, told } = watch(server, got, eid, pid, num, 1300, 60 * 60, 2);
    expect(order.slice(0, 5)).toEqual(['spiral', 'scissor', 'seekers', 'scissor', 'window']);
    expect(windows[0].cap).toBe(MOTHER_EXPOSURE[2].cap);
    // (each scissor: both welders in, then back out; two phases watched)
    expect(beams).toBe(16);
    // (one dart a phase: in the spiral's tell)
    expect(told.filter((t) => t.kind === 'dash' && t.at > windows[0].at && t.at <= windows[1].at).length).toBe(1);
    // (eight a phase: two phases, and the odd lone seeker a pilot drew)
    const seekers = shots.filter((s) => s.kind === 'seam_seeker');
    expect(seekers.length).toBeGreaterThanOrEqual(16);
    expect(seekers.length).toBeLessThanOrEqual(19);
    expect(seekers.every((s) => s.target === pid)).toBe(true);
    expect(shots.filter((s) => s.kind === 'scrap_chunk').length).toBeGreaterThan(30);
  });

  it('her radial chunks are fast and reach the nest\'s walls: there is no safe distance to sit at', () => {
    const chunk = (world().bridge.tuning as any).weapons.scrap_chunk;
    const arena = (files.systems as any).systems.find((s: any) => s.id === def.system).arena;
    expect(chunk.speed).toBeGreaterThanOrEqual(15);
    // (from anywhere she flies (her home's reach) to the far wall)
    expect(chunk.speed * chunk.life).toBeGreaterThanOrEqual(arena.radius + 3500);
  });

  it('her windows: x2 up to the cap; filled early, it cracks once; outside them she takes x0.25', () => {
    const { server, pid, step, num, bridge, god } = world();
    god();
    const eid = server.bosses.spawn('boss_scrap_mother');
    place(pid, num, Position.x[eid] + 2400, Position.y[eid]);
    step(5);
    const brain = server.bosses.brainOf(eid)!, hooks = devHooks(brain)!;
    expect(server.bosses.taken(eid)).toBeCloseTo(0.25);
    hooks.devWindow('barrage');
    expect(server.bosses.taken(eid)).toBe(2);
    expect(hooks.fight.window!.cap).toBe(MOTHER_EXPOSURE[0].cap);
    const s = bridge.get(eid)!;
    for (let i = 0; i < s.hp.length && hooks.fight.window!.crackAt < 0; i++) if (s.derived.alive[i] && s.hp[i] > 30) bridge.damagePartBy(eid, i, 200, pid);
    expect(hooks.fight.stats.cracks).toBe(1);
    const q = bridge.get(eid)!;
    bridge.damagePartBy(eid, q.hp.findIndex((h, i) => h > 30 && q.derived.alive[i]), 200, pid);
    expect(hooks.fight.stats.cracks).toBe(1);
  });

  it('her stages hold the HP bosses.json gives them (about 30/40/30), counted on what decides each', () => {
    const { server, bridge } = world();
    const eid = server.bosses.spawn('boss_scrap_mother');
    const s = bridge.get(eid)!, cat = bridge.catalog, sum = [0, 0, 0, 0];
    s.blueprint.parts.forEach((_, i) => { if (deciding(cat, s, i)) sum[stageOf(cat, s, i)] += s.maxHp[i]; });
    expect(sum.slice(1).map(Math.round)).toEqual(def.stageHp);
    const total = def.stageHp!.reduce((a, b) => a + b, 0);
    expect(def.stageHp![0] / total).toBeLessThan(0.34);
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
    // (her windows and the beats between her chained moves are flying too; her moves hold a heading)
    expect(away / between).toBeGreaterThan(0.2);
  });

  it('she flies as built throughout', () => {
    const { server, pid, step, num, bridge } = world();
    const eid = server.bosses.spawn('boss_scrap_mother');
    place(pid, num, Position.x[eid] + 2400, Position.y[eid]);
    step(5);
    const { com, mass } = bridge.get(eid)!.derived;
    advance(server, eid, 3, step);
    expect(bridge.get(eid)!.derived.com).toEqual(com);
    expect(bridge.get(eid)!.derived.mass).toBe(mass);
  });
});
