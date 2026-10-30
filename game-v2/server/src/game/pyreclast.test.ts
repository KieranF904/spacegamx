import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { Position, Velocity, InSystem, Rotation, ServerMessage, insideTerrain, rayTerrain, isRuined, currentStage } from '@space-game/common';
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
const def = (files.bosses as BossesFile).bosses.boss_pyreclast;

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
  t.send({ type: 'join', username: 'slayer' } as any);
  const pid = t.getPlayerId();
  const step = (n = 1) => { for (let i = 0; i < n; i++) server.step(); };
  const num = server['gameData'].getSystemNum(def.system);
  // (God mode: it's the boss's moves under test, not how long a pilot lasts against six turrets)
  const god = () => server['admin'].god.add(server.pilots.connOf(pid) as any);
  return { server, got, pid, step, num, bridge: server.getShips(), god };
}

const place = (pid: number, num: number, x: number, y: number, vx = 0, vy = 0) => {
  InSystem.systemId[pid] = num; Position.x[pid] = x; Position.y[pid] = y; Velocity.x[pid] = vx; Velocity.y[pid] = vy;
};
/** Keep the pilot whole (it's the boss's moves under test, not how long a pilot lasts) */
const mend = (server: GameServer, pid: number) => server.getShips().scaleHp(pid, 1);
/** (dev) Its fight moved on to the start of a stage: what's before it beaten, blown away, and done blowing */
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

describe('the Pyreclast', () => {
  it('lives in a cavern under Ashfall: you land on the surface from orbit, and go down through the cave\'s mouth', () => {
    const { server } = world();
    const gd = server['gameData'];
    expect(def.system).toBe('ashfall_cavern');
    const cave = gd.getSystem('ashfall_cavern')!;
    expect(cave.surface?.of).toBe('cinder_reach');
    expect(cave.surface?.planet).toBe('ashfall');
    expect(cave.surface?.under?.surface).toBe('ashfall_surface');
    // (orbit lands you on the surface, never straight in the cave)
    expect(gd.getSystem('cinder_reach')!.planets!.find((p) => p.id === 'ashfall')!.surface).toBe('ashfall_surface');
    expect(def.brain).toBe('pyreclast');
  });

  it('X at the cave\'s mouth takes you down into it; flying out past its edge brings you back up beside the mouth', () => {
    const { server, got, pid, step } = world();
    const gd = server['gameData'];
    const conn = server.pilots.connOf(pid)!;
    const surface = gd.getSystem('ashfall_surface')!, cave = gd.getSystem('ashfall_cavern')!, u = cave.surface!.under!;
    (server as any).travelTo(conn, gd.getSystemNum('ashfall_surface'), u.x, u.y + u.radius * 0.5, false);
    step(5);
    expect(server.surfaces.descend(conn as any, surface, Position.x[pid], Position.y[pid])).toBe(true);
    step(5);
    expect(InSystem.systemId[pid]).toBe(gd.getSystemNum('ashfall_cavern'));
    expect(Math.hypot(Position.x[pid] - cave.surface!.landing!.x, Position.y[pid] - cave.surface!.landing!.y)).toBeLessThan(1500);
    // Out of the basin's open south side, past the edge
    place(pid, gd.getSystemNum('ashfall_cavern'), 0, cave.surface!.radius + 200);
    step(70);
    expect(InSystem.systemId[pid]).toBe(gd.getSystemNum('ashfall_surface'));
    expect(Math.hypot(Position.x[pid] - u.x, Position.y[pid] - u.y)).toBeLessThan(u.radius + 2000);
    expect(got.some((m) => m.type === 'toast' && /Back up on/.test((m as any).text ?? (m as any).message ?? ''))).toBe(true);
  });

  it('waits at the end of a long canyon: you land in a basin far from it, and the rock between is solid', () => {
    const { server, pid, step, num, bridge } = world();
    const gd = server['gameData'];
    const sys = gd.getSystem('ashfall_cavern')!;
    const t = gd.terrain('ashfall_cavern')!;
    expect(t.pieces.length).toBeGreaterThan(100);
    const land = sys.surface!.landing!;
    // Open ground where you land and where it waits, far apart (the whole canyon between)
    expect(insideTerrain(t, land.x, land.y, 600)).toBe(false);
    expect(insideTerrain(t, def.lair.x, def.lair.y, 1200)).toBe(false);
    expect(Math.hypot(land.x - def.lair.x, land.y - def.lair.y)).toBeGreaterThan(35000);
    // No straight line between them: the canyon winds
    expect(rayTerrain(t, land.x, land.y, def.lair.x, def.lair.y)).toBeLessThan(1);
    // A pilot flown at a wall stops at it
    place(pid, num, land.x, land.y);
    const east = { x: land.x + 30000, y: land.y };
    const wall = rayTerrain(t, land.x, land.y, east.x, east.y) * 30000;
    expect(wall).toBeLessThan(15000);
    // (it may slide along a slanted wall, but it's never in the rock, and never through it)
    const r = bridge.get(pid)!.derived.radius;
    let deepest = 0;
    for (let i = 0; i < 400; i++) {
      Velocity.x[pid] = 30; Velocity.y[pid] = 0; step();
      if (insideTerrain(t, Position.x[pid], Position.y[pid], r * 0.5)) deepest++;
    }
    expect(deepest).toBe(0);
    expect(Position.x[pid] - land.x).toBeLessThan(wall + 2500);
  });

  it('opens its brood bays in its second phase: drones hunt you down and burst, and your shots kill them', () => {
    const { server, got, pid, step, num, bridge } = world();
    const eid = server.bosses.spawn('boss_pyreclast');
    place(pid, num, Position.x[eid] + 2800, Position.y[eid]);
    // Wear it into its second phase
    const ship = bridge.get(eid)!;
    const brain = server.bosses.brainOf(eid)!, pc = (i: number) => bridge.catalog.pieces.get(ship.blueprint.parts[i].piece);
    for (let i = 0; i < ship.hp.length && brain.integrity!() >= 0.84; i++) {
      const fn = ship.blueprint.parts[i].fn;
      if (pc(i)?.stage !== 1 || pc(i)?.skeleton || fn === 'brood_bay' || ship.hp[i] <= 0) continue;
      server.bosses.onDamage(eid, bridge.hurt(eid, ship, i, ship.hp[i] * 0.95, pid), pid);
    }
    step(60);
    expect(server.bosses.phaseOf('boss_pyreclast')).toBeGreaterThanOrEqual(1);
    let most = 0;
    for (let i = 0; i < 60 * 8; i++) {
      step();
      if (i % 30 === 0) mend(server, pid);
      most = Math.max(most, server.mobs.count(num));
    }
    expect(most).toBeGreaterThanOrEqual(4);
    // They burst on the pilot
    expect(got.some((m) => m.type === 'detonation' && m.kind === 'mob_burst')).toBe(true);
    // A drone in the open dies to a pilot's shots
    const d = server.mobs.spawn('ember_drone', num, Position.x[pid] + 400, Position.y[pid], 0, 0, eid);
    expect(server.mobs.has(d)).toBe(true);
    expect(server.mobs.hurt(d, 1000)).toBe(true);
    expect(server.mobs.has(d)).toBe(false);
  });

  it('stage one, the fortress: its first move is a barrage, its turrets clockwise round its wings, each a fan of three; between moves they fire one at a time', () => {
    const { server, got, pid, step, num, bridge, god } = world();
    god();
    const eid = server.bosses.spawn('boss_pyreclast');
    place(pid, num, Position.x[eid] + 2600, Position.y[eid]);
    const weapons = server['weapons'], spawn = weapons.spawn.bind(weapons);
    const fired: number[] = [];
    weapons.spawn = (owner: number, kind: string, ...rest: any[]) => { if (owner === eid && kind === 'magma') fired.push(server['currentTick']); return (spawn as any)(owner, kind, ...rest); };
    const swells: { at: number; x: number; y: number }[] = [];
    for (let i = 0; i < 60 * 4; i++) {
      got.length = 0;
      step();
      for (const m of got) if (m.type === 'bossTelegraph' && m.kind === 'magma') swells.push({ at: i, x: m.x, y: m.y });
    }
    const guns = bridge.get(eid)!.derived.weapons.filter((w) => w.kind === 'magma');
    expect(guns.length).toBe(6);
    // The barrage: every turret twice round, quick, each a fan of three
    const n = guns.length * 2, barrage = swells.slice(0, n);
    for (let k = 1; k < barrage.length; k++) expect(barrage[k].at - barrage[k - 1].at).toBeLessThan(16);
    expect(fired.length).toBeGreaterThanOrEqual(3 * n);
    // Clockwise (as seen, y down) round its middle from its nose, in its own frame (nose along +x), once round
    const turn = barrage.slice(0, guns.length).map((s) => (Math.atan2(s.y, s.x) + 2 * Math.PI) % (2 * Math.PI));
    for (let k = 1; k < turn.length; k++) expect(turn[k]).toBeGreaterThan(turn[k - 1]);
    expect(barrage.slice(guns.length).map((s) => [s.x, s.y])).toEqual(barrage.slice(0, guns.length).map((s) => [s.x, s.y]));
    // Afterwards, resting between moves: one turret at a time, spaced out
    const rest = swells.filter((s) => s.at > barrage[n - 1].at + 60);
    for (let k = 1; k < rest.length; k++) expect(rest[k].at - rest[k - 1].at).toBeGreaterThanOrEqual(12);
  });

  it('stage one\'s broadside: side-on, its near wing\'s turrets draw red lines at you, then fire down them together', () => {
    const { server, got, pid, step, num, god } = world();
    god();
    const eid = server.bosses.spawn('boss_pyreclast');
    place(pid, num, Position.x[eid] + 2600, Position.y[eid]);
    // (barrage, then brood, which it skips before its first phase: its third move is next)
    let lines: any[] = [];
    for (let i = 0; i < 60 * 20 && !lines.length; i++) {
      got.length = 0;
      step();
      if (i % 30 === 0) place(pid, num, Position.x[eid] + 2600, Position.y[eid]);
      lines = got.filter((m) => m.type === 'bossTelegraph' && m.kind === 'lance' && m.length === 3200);
    }
    expect(lines.length).toBeGreaterThanOrEqual(1);
    // All from the one side of it, together
    expect(new Set(lines.map((l) => Math.sign(l.y))).size).toBe(1);
  });

  it('stage two, the hunter: mortar walls, dash chains, the lance and synapse lock, in that order; lighter, it drives harder', () => {
    const { server, got, pid, step, num, god } = world();
    god();
    const eid = server.bosses.spawn('boss_pyreclast');
    place(pid, num, Position.x[eid] + 1800, Position.y[eid]);
    step(5);
    // (its first move comes the moment its wings are gone: kept)
    got.length = 0;
    advance(server, eid, 2, step);
    const seen: string[] = [];
    let fastest = 0, lanceWarn = -1, beam = -1, strikes = 0;
    for (let i = 0; i < 60 * 40 && seen.length < 4; i++) {
      if (i) { got.length = 0; step(); }
      if (i % 30 === 0) { mend(server, pid); place(pid, num, Position.x[eid] + 1800, Position.y[eid]); }
      fastest = Math.max(fastest, Math.hypot(Velocity.x[eid], Velocity.y[eid]));
      for (const m of got) {
        const k = m.type === 'bossTelegraph' ? (m.kind === 'impact' ? 'mortar' : m.kind === 'lance' && m.length === 14000 ? 'lance' : m.kind === 'dash' ? 'dash' : m.kind === 'synapse' ? 'synapse' : '') : '';
        if (k && seen[seen.length - 1] !== k) seen.push(k);
        if (k === 'lance' && lanceWarn < 0) lanceWarn = i;
        if (m.type === 'bossBeam' && beam < 0) beam = i;
        if (m.type === 'detonation' && m.kind === 'synapse') strikes++;
      }
    }
    expect(seen).toEqual(['mortar', 'dash', 'lance', 'synapse']);
    // A dash is far quicker than it flies
    expect(fastest).toBeGreaterThan(14);
    // The lance draws its line first
    expect(beam).toBeGreaterThan(lanceWarn + 40);
    for (let i = 0; i < 150; i++) { got.length = 0; step(); strikes += got.filter((m) => m.type === 'detonation' && m.kind === 'synapse').length; }
    expect(strikes).toBeGreaterThanOrEqual(5);
  });

  it('stage two\'s mortar wall runs the way you fly, capped where you\'d be; its synapse marks land where you\'d be flying straight on', () => {
    const { server, got, pid, step, num, god } = world();
    god();
    const eid = server.bosses.spawn('boss_pyreclast');
    place(pid, num, Position.x[eid] + 1800, Position.y[eid]);
    step(5);
    got.length = 0;
    advance(server, eid, 2, step);
    // Flying straight along +y, past it (moved by its own velocity, as a pilot flies)
    const walls: { x: number; y: number }[] = [], marks: { x: number; y: number }[] = [];
    for (let i = 0; i < 60 * 40 && !(walls.length && marks.length); i++) {
      if (i % 90 === 0) place(pid, num, Position.x[eid] + 1800, Position.y[eid] - 1500, 0, 18);
      Velocity.x[pid] = 0; Velocity.y[pid] = 18;
      got.length = 0;
      step();
      const px = Position.x[pid], py = Position.y[pid];
      const impacts = got.filter((q) => q.type === 'bossTelegraph' && q.kind === 'impact') as any[];
      if (impacts.length && !walls.length) walls.push(...impacts.map((q) => ({ x: q.x - px, y: q.y - py })));
      const mark = got.find((q) => q.type === 'bossTelegraph' && q.kind === 'synapse') as any;
      if (mark && !marks.length) marks.push({ x: mark.x - px, y: mark.y - py });
    }
    expect(walls.length).toBeGreaterThan(8);
    // Either side of its way (x off by the lane), and a cap across it well ahead (y on)
    expect(walls.some((w) => Math.abs(w.x) < 250 && w.y > 1000)).toBe(true);
    expect(walls.filter((w) => Math.abs(w.x) > 250 && Math.abs(w.x) < 600).length).toBeGreaterThan(6);
    // The mark: ahead of it, the way it's flying
    expect(marks[0].y).toBeGreaterThan(400);
    expect(Math.abs(marks[0].x)).toBeLessThan(100);
  });

  it('stage two charges only if you keep away from it, and then only now and then; spent, it drifts', () => {
    const charges = (d: number) => {
      const { server, got, pid, step, num, god } = world();
      god();
      const eid = server.bosses.spawn('boss_pyreclast');
      place(pid, num, Position.x[eid] + d, Position.y[eid]);
      step(5);
      advance(server, eid, 2, step);
      let n = 0;
      // (kept `d` from it, towards the middle of its ground: it won't charge off it)
      const keep = () => { const a = Math.atan2(def.lair.y - Position.y[eid], def.lair.x - Position.x[eid]); place(pid, num, Position.x[eid] + Math.cos(a) * d, Position.y[eid] + Math.sin(a) * d); };
      for (let i = 0; i < 60 * 30; i++) {
        got.length = 0;
        step();
        if (i % 20 === 0) { mend(server, pid); keep(); }
        n += got.filter((m) => m.type === 'bossTelegraph' && m.kind === 'charge').length;
      }
      return n;
    };
    expect(charges(1500)).toBe(0);
    const far = charges(3400);
    expect(far).toBeGreaterThanOrEqual(1);
    expect(far).toBeLessThanOrEqual(2);
  });

  it('stage one: each plate shot off bares the skeleton under it, shots pass through bones; every plate gone, it stops, can\'t be hurt, and blows its wings away piece by piece', () => {
    const { server, got, pid, step, num, bridge, god } = world();
    god();
    const eid = server.bosses.spawn('boss_pyreclast');
    place(pid, num, Position.x[eid] + 2600, Position.y[eid]);
    step(5);
    const brain = server.bosses.brainOf(eid)!;
    const s0 = bridge.get(eid)!, catalog = bridge.catalog;
    const piece = (i: number) => catalog.pieces.get(s0.blueprint.parts[i].piece)!;
    const stage = (i: number) => piece(i).stage;
    const plates = s0.blueprint.parts.flatMap((_, i) => (stage(i) === 1 && !piece(i).skeleton ? [i] : []));
    const bones = s0.blueprint.parts.flatMap((_, i) => (piece(i).skeleton ? [i] : []));
    expect(bones.length).toBe(2);
    expect(brain.integrity!()).toBeCloseTo(1, 3);
    // A body part, shot while its plates stand: the nearest plate takes it
    const body = s0.blueprint.parts.findIndex((_, i) => stage(i) === 2);
    const before = s0.hp.slice();
    bridge.hurt(eid, s0, body, 40);
    let s = bridge.get(eid)!;
    expect(s.hp[body]).toBe(before[body]);
    expect(stage(s.hp.findIndex((h, i) => h < before[i]))).toBe(1);
    // Every plate shot off: its bones are still there, and a shot meant for them passes through (nothing's left to hit there)
    for (const i of plates) { const q = bridge.get(eid)!; if (q.derived.alive[i]) bridge.hurt(eid, q, i, 1e9); }
    step(1);
    s = bridge.get(eid)!;
    expect(bones.every((i) => s.derived.alive[i])).toBe(true);
    expect(brain.integrity!()).toBeCloseTo(2 / 3, 2);
    // A shot across a wing's bones hits nothing of them
    for (const k of bones) {
      const [bx, by] = (bridge as any).partWorld(eid, s, k);
      const h = bridge.segmentHit(eid, s, bx, by - 3000, bx, by);
      expect(h === null || !piece(h.part).skeleton).toBe(true);
    }
    // It stops and can't be hurt while it blows its skeletons apart, plate by plate (where each was), then its wings go
    step(2);
    expect(brain.invulnerable!()).toBe(true);
    const was = bridge.get(eid)!.hp.slice();
    bridge.hurt(eid, bridge.get(eid)!, body, 500);
    expect(bridge.get(eid)!.hp[body]).toBe(was[body]);
    got.length = 0;
    for (let i = 0; i < 60 * 8 && brain.invulnerable!(); i++) step();
    expect(brain.invulnerable!()).toBe(false);
    const blows = got.filter((m) => m.type === 'bossBlow' && m.bodyId === eid) as { part: number }[];
    expect(blows.length).toBeGreaterThan(10);
    expect(blows.every((b) => stage(b.part) === 1 && !piece(b.part).skeleton)).toBe(true);
    s = bridge.get(eid)!;
    expect(s.blueprint.parts.some((_, i) => s.derived.alive[i] && stage(i) === 1)).toBe(false);
    // Now its body can be hurt
    const w2 = s.hp[body];
    bridge.hurt(eid, s, body, 40);
    expect(bridge.get(eid)!.hp[body]).toBeLessThan(w2);
  });

  it('stage two: its body\'s pieces are wrecked, not shot off (shots pass wrecks by); every piece wrecked, it stops and its body blows apart, outermost first, its core last, baring its heart', () => {
    const { server, got, pid, step, num, bridge, god } = world();
    god();
    const eid = server.bosses.spawn('boss_pyreclast');
    place(pid, num, Position.x[eid] + 2600, Position.y[eid]);
    step(5);
    const brain = server.bosses.brainOf(eid)!;
    // (its wings shot off and blown away: dev)
    brain.forceShed!(45);
    for (let i = 0; i < 60 * 3; i++) step();
    let s = bridge.get(eid)!;
    const catalog = bridge.catalog, piece = (i: number) => catalog.pieces.get(s.blueprint.parts[i].piece)!;
    const body = s.blueprint.parts.flatMap((_, i) => (piece(i).stage === 2 ? [i] : []));
    expect(body.every((i) => s.derived.alive[i])).toBe(true);
    // Worn right out, a piece stays on: a wreck
    const a = body[0];
    bridge.hurt(eid, s, a, 1e9);
    step(1);
    s = bridge.get(eid)!;
    expect(s.derived.alive[a]).toBe(true);
    expect(isRuined(catalog, s, a)).toBe(true);
    // A hit meant for the wreck goes to the nearest piece still whole
    const before = s.hp.slice();
    bridge.hurt(eid, s, a, 40);
    s = bridge.get(eid)!;
    const hit = s.hp.findIndex((h, i) => h < before[i]);
    expect(hit).not.toBe(a);
    expect(piece(hit).stage).toBe(2);
    // Every piece wrecked: it stops, can't be hurt, and its body blows apart a piece at a time, its core last
    for (const i of body) { const q = bridge.get(eid)!; if (!isRuined(catalog, q, i)) bridge.hurt(eid, q, i, 1e9); }
    step(2);
    expect(brain.integrity!()).toBeCloseTo(1 / 3, 2);
    expect(brain.invulnerable!()).toBe(true);
    const gone: number[][] = [];
    let prev = new Set(bridge.get(eid)!.derived.alive.flatMap((x, i) => (x ? [i] : [])));
    for (let i = 0; i < 60 * 12 && brain.invulnerable!(); i++) {
      step();
      const now = new Set(bridge.get(eid)!.derived.alive.flatMap((x, k) => (x ? [k] : [])));
      const went = [...prev].filter((k) => !now.has(k));
      if (went.length) gone.push(went);
      prev = now;
    }
    expect(brain.invulnerable!()).toBe(false);
    expect(gone.length).toBeGreaterThan(15);
    const names = (g: number[]) => g.map((k) => s.blueprint.parts[k].piece.replace('pyreclast_', ''));
    expect(names(gone[gone.length - 1])).toContain('core');
    expect(gone.flat().every((k) => piece(k).stage === 2)).toBe(true);
    // What's left is its heart, whole, and it can be hurt
    const left = bridge.get(eid)!;
    expect(left.blueprint.parts.every((_, i) => !left.derived.alive[i] || piece(i).stage === 3)).toBe(true);
    const c = left.blueprint.parts.findIndex((p) => p.fn === 'core'), was = left.hp[c];
    bridge.hurt(eid, left, c, 50);
    expect(bridge.get(eid)!.hp[c]).toBeLessThan(was);
    void got;
  });

  it('its stages are its brain\'s, and it flies as built throughout', () => {
    const { server, pid, step, num, bridge } = world();
    const eid = server.bosses.spawn('boss_pyreclast');
    place(pid, num, Position.x[eid] + 2600, Position.y[eid]);
    step(5);
    const s = bridge.get(eid)!, catalog = bridge.catalog;
    const piece = (i: number) => catalog.pieces.get(s.blueprint.parts[i].piece)!;
    // (its body's pieces wreck, and its heart's round; its heart, beneath, is its last stage)
    s.blueprint.parts.forEach((p, i) => {
      expect([1, 2, 3]).toContain(piece(i).stage);
      expect(!!piece(i).ruin).toBe(piece(i).stage === 2 || /s3_(inner\d|outer\d+|core)$/.test(p.piece));
      expect(!!piece(i).under).toBe(piece(i).stage === 3);
    });
    const { com, mass, maxThrust } = s.derived;
    advance(server, eid, 3, step);
    const after = bridge.get(eid)!;
    expect(after.derived.com).toEqual(com);
    expect(after.derived.mass).toBe(mass);
    expect(after.derived.maxThrust).toEqual(maxThrust);
  });

  it('stage three, the heart: it darts, then beams from its crystal in a set order, rings and spirals of sparks and seekers from its core, then opens its vents', () => {
    const { server, got, pid, step, num, bridge, god } = world();
    god();
    const eid = server.bosses.spawn('boss_pyreclast');
    place(pid, num, Position.x[eid] + 1300, Position.y[eid]);
    step(5);
    const brain = server.bosses.brainOf(eid)!;
    advance(server, eid, 3, step);
    const weapons = server['weapons'], spawn = weapons.spawn.bind(weapons);
    const shots: { kind: string; target?: number }[] = [];
    weapons.spawn = (owner: number, kind: string, x: number, y: number, a: number, k: number, shape: any, ...rest: any[]) => { if (owner === eid) shots.push({ kind, target: shape?.target }); return (spawn as any)(owner, kind, x, y, a, k, shape, ...rest); };
    const beams: number[] = [], warned: number[] = [];
    let darts = 0, vent = false;
    const braced = brain.taken!();
    // (braced, a hit glances: wait for its opening)
    { const s0 = bridge.get(eid)!; bridge.hurt(eid, s0, s0.blueprint.parts.findIndex((p) => p.fn === 'core'), 10); expect((bridge as any).lastThrough).toBeLessThan(0.6); }
    for (let i = 0; i < 60 * 45 && !vent; i++) {
      got.length = 0;
      step();
      if (i % 30 === 0) { mend(server, pid); place(pid, num, Position.x[eid] + 1300, Position.y[eid]); }
      for (const m of got) {
        if (m.type === 'bossTelegraph' && m.kind === 'dash') darts++;
        if (m.type === 'bossTelegraph' && m.kind === 'crystal') warned.push(m.angle!);
        if (m.type === 'bossBeam' && m.kind === 'crystal') beams.push(m.a0);
        if (m.type === 'bossTelegraph' && m.kind === 'vent') vent = true;
      }
    }
    // Five beams, each warned of first, in their set order: middle, left, right, far left, far right
    const r = (a: number) => Math.round(a * 10) / 10 + 0;
    expect(warned.map(r)).toEqual([0, -0.3, 0.3, -0.6, 0.6]);
    expect(beams.map(r)).toEqual([0, -0.3, 0.3, -0.6, 0.6]);
    expect(darts).toBeGreaterThanOrEqual(4);
    // Rings and spirals of sparks, and seekers sent hunting
    expect(shots.filter((s) => s.kind === 'heart_spark').length).toBeGreaterThan(100);
    const seekers = shots.filter((s) => s.kind === 'heart_seeker');
    expect(seekers.length).toBeGreaterThanOrEqual(8);
    expect(seekers.every((s) => s.target === pid)).toBe(true);
    // Braced it takes far less; its vents open, more than all of it
    expect(vent).toBe(true);
    step(5);
    expect(braced).toBeLessThan(0.5);
    expect(brain.taken!()).toBeGreaterThan(1);
    const s = bridge.get(eid)!, core = s.blueprint.parts.findIndex((p) => p.fn === 'core'), was = s.hp[core];
    bridge.hurt(eid, s, core, 100);
    expect(was - bridge.get(eid)!.hp[core]).toBeGreaterThan(100);
  });

  it('its heart\'s crystal can be shot off; its round is wrecked, not shot off; all wrecked, it shudders and every piece blows apart at once', () => {
    const { server, got, pid, step, num, bridge, god } = world();
    god();
    const eid = server.bosses.spawn('boss_pyreclast');
    place(pid, num, Position.x[eid] + 1300, Position.y[eid]);
    step(5);
    const brain = server.bosses.brainOf(eid)!;
    advance(server, eid, 3, step);
    let s = bridge.get(eid)!;
    const catalog = bridge.catalog, crystal = s.blueprint.parts.findIndex((p) => p.piece === 'pyreclast_s3_mineral');
    // The crystal: off
    bridge.hurt(eid, s, crystal, 1e9);
    step(1);
    s = bridge.get(eid)!;
    expect(s.derived.alive[crystal]).toBe(false);
    // The round: each piece stays on, wrecked
    const round = s.blueprint.parts.flatMap((p, i) => (/s3_(inner\d|outer\d+|core)$/.test(p.piece) ? [i] : []));
    expect(round.length).toBe(25);
    for (const i of round.slice(0, -1)) bridge.hurt(eid, bridge.get(eid)!, i, 1e9);
    step(1);
    s = bridge.get(eid)!;
    expect(round.slice(0, -1).every((i) => s.derived.alive[i] && isRuined(catalog, s, i))).toBe(true);
    expect(brain.invulnerable!()).toBe(false);
    // The last: it shudders (nothing hurts it), then it's gone, every piece thrown off at once, and it's beaten
    const before = new Set(bridge.bodies.keys());
    bridge.hurt(eid, s, round[round.length - 1], 1e9);
    step(2);
    expect(brain.invulnerable!()).toBe(true);
    expect(bridge.has(eid)).toBe(true);
    let gone = -1;
    for (let i = 0; i < 200 && gone < 0; i++) { step(); if (!bridge.has(eid)) gone = i; }
    expect(gone).toBeGreaterThan(40);
    // Thrown out in a few great chunks (not a body for every piece), only to be seen: nothing hits them, they hit nothing
    const chunks = [...bridge.bodies.keys()].filter((k) => !before.has(k) && bridge.get(k)!.kind === 'debris');
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks.length).toBeLessThanOrEqual(12);
    expect(chunks.every((k) => (bridge as any).intangible.has(k))).toBe(true);
    expect(got.some((m) => m.type === 'bossDefeated' && m.bodyId === eid)).toBe(true);
    void pid;
  });

  it('in its cavern (its walls fixed) a shot flying straight works out where it meets the rock once, and bursts there; elsewhere, none is worked out ahead', () => {
    const { server, num } = world();
    const eid = server.bosses.spawn('boss_pyreclast');
    const weapons = server['weapons'], t = server['terrainOf'](num);
    // Out from its lair, the way the rock is nearest
    let best = { a: 0, d: Infinity };
    for (let k = 0; k < 32; k++) {
      const a = (k / 32) * Math.PI * 2, f = rayTerrain(t, def.lair.x, def.lair.y, def.lair.x + Math.cos(a) * 12000, def.lair.y + Math.sin(a) * 12000);
      if (f < 1 && f * 12000 < best.d) best = { a, d: f * 12000 };
    }
    expect(best.d).toBeLessThan(12000);
    // (fired from a way short of it: within a spark's reach)
    const ox = def.lair.x + Math.cos(best.a) * (best.d - 1500), oy = def.lair.y + Math.sin(best.a) * (best.d - 1500);
    const walls: { x: number; y: number }[] = [];
    const onWall = weapons.onWallHit.bind(weapons);
    weapons.onWallHit = (proj: number, x: number, y: number) => { walls.push({ x, y }); onWall(proj, x, y); };
    const shot = weapons.spawn(eid, 'heart_spark', ox, oy, best.a, 1, { speedScale: 1, sizeScale: 1, turret: false, noBurst: true });
    Velocity.x[shot] = Math.cos(best.a) * 12; Velocity.y[shot] = Math.sin(best.a) * 12;
    server.step();
    expect(server['shotWalls'].has(shot)).toBe(true);
    for (let i = 0; i < 400 && !walls.length; i++) server.step();
    expect(walls.length).toBe(1);
    expect(Math.hypot(walls[0].x - (ox + Math.cos(best.a) * 1500), walls[0].y - (oy + Math.sin(best.a) * 1500))).toBeLessThan(40);
    // Its surface above (walls not fixed): asked of each step, nothing worked out ahead
    const up = server['gameData'].getSystemNum('ashfall_surface');
    expect(server['gameData'].getSystemByNum(up)?.surface?.fixedWalls).toBeFalsy();
    const other = weapons.spawn(eid, 'heart_spark', 0, 0, 0, 1, { speedScale: 1, sizeScale: 1, turret: false, noBurst: true });
    InSystem.systemId[other] = up;
    server.step();
    expect(server['shotWalls'].has(other)).toBe(false);
  });

  it('clients are sent its true part maximums, so at full health it draws (and its bar reads) as whole', () => {
    const { server, got, pid, step, num, bridge } = world();
    const eid = server.bosses.spawn('boss_pyreclast');
    place(pid, num, Position.x[eid] + 3000, Position.y[eid]);
    step(30);
    const sync = got.find((m) => m.type === 'shipSync' && m.id === eid) as any;
    expect(sync?.maxHp).toBeDefined();
    const ship = bridge.get(eid)!;
    sync.maxHp.forEach((m: number, i: number) => expect(Math.abs(m - ship.maxHp[i])).toBeLessThan(1.01));
    // Whole: every part's HP is its maximum
    sync.hp.forEach((h: number, i: number) => expect(h / sync.maxHp[i]).toBeGreaterThan(0.99));
  });

  it('its drones go when it does (a reset leaves nothing behind)', () => {
    const { server, step, num, pid } = world();
    const eid = server.bosses.spawn('boss_pyreclast');
    place(pid, num, Position.x[eid] + 3000, Position.y[eid]);
    for (let k = 0; k < 4; k++) server.mobs.spawn('ember_drone', num, k * 100, 5000, 0, 0, eid);
    expect(server.mobs.count(num)).toBe(4);
    server.bosses.remove(eid);
    step();
    expect(server.mobs.count(num)).toBe(0);
  });
});
