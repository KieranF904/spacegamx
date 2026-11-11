/**
 * The step engine on a real GameServer over LocalTransport: a fake client walks all seventeen steps, a pilot can leave at
 * every one of them, and the client's reports can only complete the steps that are about opening something
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { Position, Velocity, InSystem, TICK_RATE, ServerMessage, TutorialData, Blueprint, objectPos, countOf } from '@space-game/common';
import { GameServer } from '../../GameServer.js';
import { GameData } from '../../data/GameData.js';
import { LocalTransport } from '../../net/LocalTransport.js';
import { readGameDataFiles } from '../../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../../ships/loadShipConfig.js';
import { createShipBridge } from '../../ships/createShipBridge.js';
import { GRADUATE_AFTER_TICKS } from './TutorialSteps.js';
import { makeServer } from '../../testkits/world.testkit.js';

const dataDir = join(__dirname, '../../../../data');
const files = readGameDataFiles(dataDir);
const shipConfig = loadShipConfigCached(dataDir);

function yard(names = ['ann']) {
  (bitecs as unknown as { resetGlobals: () => void }).resetGlobals();
  const clock = { t: 1_000_000 };
  const server = makeServer({
    gameData: new GameData(files), tutorial: true, ships: createShipBridge(shipConfig), clock: () => clock.t,
  });
  const pilots = names.map((n) => {
    const t = new LocalTransport(server);
    const got: ServerMessage[] = [];
    t.onMessage = (m) => got.push(m);
    t.connect();
    t.send({ type: 'join', username: n } as never);
    const pid = t.getPlayerId();
    const conn = server.pilots.connOf(pid)!;
    const state = () => got.filter((m) => m.type === 'tutorialState').pop() as Extract<ServerMessage, { type: 'tutorialState' }>;
    return { t, got, pid, conn, profile: () => server.pilots.get(conn)!, state };
  });
  const step = (n = 1) => { for (let i = 0; i < n; i++) { clock.t += 1000 / TICK_RATE; server.step(); } };
  const tut = server.tutorial!;
  const data: TutorialData = server.gameData.tutorialFile!;
  const put = (pid: number, x: number, y: number) => { server.ships.teleport(pid, x, y); Position.x[pid] = x; Position.y[pid] = y; Velocity.x[pid] = 0; Velocity.y[pid] = 0; };
  const at = (id: string) => objectPos(data, tut.def(id)!);
  return { server, pilots, step, tut, data, put, at, clock };
}
type World = ReturnType<typeof yard>;
type Pilot = World['pilots'][number];

const stepOf = (p: Pilot) => p.profile().tutorial.step;
const stored = (p: Pilot, id: string) => countOf(p.profile().storage, id);

/** A hull cell (or another part) bolted onto the pilot's design wherever it joins and validates */
function withPart(w: World, p: Pilot, fn: string, piece: string, material: string, uid: number): Blueprint {
  const bp = JSON.parse(JSON.stringify(w.server.ships.get(p.pid)!.blueprint)) as Blueprint;
  const spots: [number, number, number][] = [];
  for (const base of bp.parts) for (let dx = -3; dx <= 3; dx++) for (let dy = -3; dy <= 3; dy++) if (dx || dy) spots.push([base.x + dx, base.y + dy, Math.abs(dx) + Math.abs(dy)]);
  spots.sort((m, n) => m[2] - n[2]);
  for (const [x, y] of spots) {
    const cand = { uid, piece, fn, material, x, y, rot: 0, flip: false };
    const test = { ...bp, parts: [...bp.parts, cand] } as Blueprint;
    if (w.server.ships.validate(test).ok) { bp.parts.push(cand as never); return bp; }
  }
  throw new Error('no place for the part: ' + JSON.stringify(w.server.ships.validate({ ...bp, parts: [...bp.parts, { uid, piece, fn, material, x: 0, y: 0, rot: 0, flip: false } as never] } as Blueprint).errors) + JSON.stringify(bp.parts.slice(0, 3)));
}

/** Break a drone for a pilot (their own counter) */
const smash = (w: World, p: Pilot, id: string) => w.tut.hit(w.tut.entityOf(id)!, p.pid, w.tut.def(id)!.hp!);

/** A rock of the yard's belt breaks and throws off a chunk of `bag`, which the pilot flies through (the ordinary pods: anyone could take them) */
function mineChunk(w: World, p: Pilot, bag: Record<string, number>): void {
  const sys = w.server.gameData.getSystemNum(w.data.yard.system);
  const rock = [...w.server.asteroidIdsBySystem.get(sys) ?? []].find((e) => !w.tut.isBody(e))!;
  expect(rock).toBeDefined();
  const pod = w.server.pods.spawnChunk(sys, Position.x[rock] + 120, Position.y[rock], 0, 0, bag, p.pid);
  w.put(p.pid, Position.x[pod], Position.y[pod]);
  w.step(40);
}

describe('the step engine', () => {
  it('has eighteen steps, each with a real binding name and one or two short lines', () => {
    const w = yard();
    expect(w.data.steps.map((s) => s.id)).toEqual(['welcome', 'rings', 'brake', 'drones', 'mine', 'hold', 'pickup', 'dock', 'refine', 'hangar', 'power', 'bank', 'guide', 'fieldview', 'fieldplan', 'fieldbuild', 'jump', 'graduate']);
    const actions = new Set(['forward', 'backward', 'left', 'right', 'wasd', 'powerFlow', 'fire', 'inventory', 'pickup', 'dock', 'components', 'map', 'jump', 'fieldBuild', 'fabricator']);
    for (const s of w.data.steps) {
      expect(s.lines.length).toBeGreaterThanOrEqual(1);
      expect(s.lines.length).toBeLessThanOrEqual(2);
      for (const l of s.lines.flatMap((x) => (typeof x === 'string' ? [x] : [x.screen, x.helm]))) for (const m of l.matchAll(/\{(\w+)\}/g)) expect(actions.has(m[1])).toBe(true);
    }
  });

  it('a fake client walks the whole tutorial, step by step, and ends in Sol with the starter pack', () => {
    const w = yard();
    const a = w.pilots[0];
    const p = a.profile();
    // a trainee starts with nothing in storage: each step hands out what it needs, the pack comes at the end
    expect(p.storage).toEqual([]);
    // it all happens in the Vesta yard system, and the walk ends in Sol
    expect(w.data.yard.system).toBe('vesta_yard');
    expect(InSystem.systemId[a.pid]).toBe(w.server.gameData.getSystemNum('vesta_yard'));
    const pack = w.data.starterPack;
    const seen: string[] = [stepOf(a)];
    const expectStep = (id: string) => { expect(stepOf(a)).toBe(id); seen.push(id); expect(a.state()).toMatchObject({ step: id, left: false }); };
    w.step(2);

    // 1 welcome: nothing but an acknowledgement moves it
    w.step(60);
    expect(stepOf(a)).toBe('welcome');
    // what this client was told of the yard's bodies: the three practice drones (as spawns: the yard's belt has none of them in its seed) and the belt's rocks (in the seed)
    const spawned = a.got.filter((m) => m.type === 'asteroidSpawn').flatMap((m) => (m as Extract<ServerMessage, { type: 'asteroidSpawn' }>).asteroids);
    for (const id of ['drone_1', 'drone_2', 'drone_3']) {
      const sp = spawned.find((s) => s.id === w.tut.entityOf(id));
      expect(sp, `${id} is told to the pilot in the yard`).toBeDefined();
      const at = w.at(id);
      expect(Math.round(sp!.semiMajorAxis * Math.cos(sp!.argPeriapsis))).toBe(Math.round(at.x));
      expect(Math.round(sp!.semiMajorAxis * Math.sin(sp!.argPeriapsis))).toBe(Math.round(at.y));
    }
    const seed = a.got.find((m) => m.type === 'asteroidSeed') as Extract<ServerMessage, { type: 'asteroidSeed' }> | undefined;
    expect(seed?.systemId).toBe('vesta_yard');
    expect(seed!.belt.extra?.[0].count).toBeGreaterThanOrEqual(20);
    a.t.send({ type: 'tutorialReport', kind: 'ack', step: 'welcome' } as never);
    w.step(1);
    expectStep('rings');

    // 2 rings: all three, in any order, each once
    for (const id of ['ring_3', 'ring_1']) { const r = w.at(id); w.put(a.pid, r.x, r.y); w.step(3); }
    expect(stepOf(a)).toBe('rings');
    expect(a.state().passed).toEqual(['ring_3', 'ring_1']);
    const r2 = w.at('ring_2'); w.put(a.pid, r2.x, r2.y); w.step(3);
    expectStep('brake');
    expect(a.state().passed).toEqual([]);

    // 3 brake: stop in the zone
    const z = w.at('stop_zone'); w.put(a.pid, z.x, z.y);
    w.step(w.data.yard.stopTicks + 5);
    expectStep('drones');

    // 4 drones: all three broken (for this pilot)
    smash(w, a, 'drone_1'); smash(w, a, 'drone_2');
    expect(stepOf(a)).toBe('drones');
    smash(w, a, 'drone_3');
    expectStep('mine');
    expect(a.state().broken).toEqual(['drone_1', 'drone_2', 'drone_3']);

    // 5 mine: the yard's belt, 20 of what its rocks give (silicate too: it comes off the same rock; ice and the like do not count)
    expect(w.data.steps.find((s) => s.id === 'mine')!.trigger.count).toBe(20);
    mineChunk(w, a, { ice: 6, silicate: 8, iron_ore: 8 });
    expect(stepOf(a)).toBe('mine');
    // (the card's counter: what counts of it, so far)
    expect(a.state().got).toBe(16);
    mineChunk(w, a, { nickel_ore: 4 });
    expectStep('hold');

    // 6 hold
    a.t.send({ type: 'tutorialReport', kind: 'panel', panel: 'hold' } as never);
    w.step(1);
    expectStep('pickup');
    // 6b the pickup panel (docs/design/loot-pickup-2026-11.md F)
    a.t.send({ type: 'tutorialReport', kind: 'panel', panel: 'pickup' } as never);
    w.step(1);
    expectStep('dock');

    // 7 dock at the yard station
    w.put(a.pid, w.data.yard.center.x + 700, w.data.yard.center.y);
    w.step(2);
    a.t.send({ type: 'dock' } as never);
    w.step(2);
    expect(a.conn.docked).toBeTruthy();
    expectStep('refine');
    expect(stored(a, 'iron_ore')).toBeGreaterThanOrEqual(4);

    // 8 refine: queued, then the plate comes out
    const plate0 = stored(a, 'alloy_plate');
    a.t.send({ type: 'refine', recipe: 'alloy_plate', batches: 1 } as never);
    expect(stepOf(a)).toBe('refine');
    w.step(TICK_RATE * 4);
    expect(stored(a, 'alloy_plate')).toBeGreaterThan(plate0);
    expectStep('hangar');

    // 9 hangar: one new hull cell on the ship
    a.t.send({ type: 'shipEdit', blueprint: withPart(w, a, 'hull', 'sq', 'alloy', 200) } as never);
    w.step(1);
    expect((a.got.filter((m) => m.type === 'shipEditResult').pop() as { ok: boolean }).ok).toBe(true);
    expectStep('power');
    // (the step handed out a Cell Reactor to place)
    expect(stored(a, 'part:alloy:power_cell_reactor:sq')).toBe(1);

    // 10 power: a generator built into the ship
    a.t.send({ type: 'shipEdit', blueprint: withPart(w, a, 'power_cell_reactor', 'sq', 'alloy', 201) } as never);
    w.step(1);
    expect(a.got.filter((m) => m.type === 'shipEditResult').pop()).toMatchObject({ ok: true });
    expect(stored(a, 'part:alloy:power_cell_reactor:sq')).toBe(0);
    expectStep('bank');

    // 11 the repair bank tab
    a.t.send({ type: 'tutorialReport', kind: 'panel', panel: 'bank' } as never);
    w.step(1);
    expectStep('guide');

    // 12 the field guide and the system map, both
    a.t.send({ type: 'tutorialReport', kind: 'panel', panel: 'map' } as never);
    w.step(1);
    expect(stepOf(a)).toBe('guide');
    a.t.send({ type: 'tutorialReport', kind: 'panel', panel: 'guide' } as never);
    w.step(1);
    expectStep('fieldview');

    // 13 the world build view: out of the station, opening it is the client's report
    a.t.send({ type: 'undock' } as never);
    w.step(2);
    a.t.send({ type: 'tutorialReport', kind: 'panel', panel: 'build' } as never);
    w.step(1);
    expectStep('fieldplan');
    // (the step put plate in the hold, where the fabricator looks)
    const plate = (id: string) => countOf(a.profile().cargo, id);
    expect(plate('alloy_plate')).toBeGreaterThanOrEqual(3);

    // 14 plan a part: a saved plan that adds one (the server sees the blueprint, not the client's word)
    w.tut.fieldPlanned(a.pid, 0);
    expect(stepOf(a)).toBe('fieldplan');
    a.t.send({ type: 'fieldPlan', blueprint: withPart(w, a, 'hull', 'sq', 'alloy', 202) } as never);
    w.step(1);
    expectStep('fieldbuild');

    // 15 the fabricator (off until the pilot switches it on) builds it from the hold
    w.step(TICK_RATE * 5);
    expect(stepOf(a)).toBe('fieldbuild');
    a.t.send({ type: 'machine', kind: 'fabricator', on: true } as never);
    w.step(TICK_RATE * 60);
    expectStep('jump');
    expect(w.server.ships.get(a.pid)!.blueprint.parts.some((q) => q.uid === 202)).toBe(true);

    // 16 jump: finishing a jump inside the exit marker (the jump drive itself is the flight code's; here its finish is told)
    const ex = w.at('exit_marker');
    w.tut.onEvent(a.pid, { kind: 'jumped', x: ex.x, y: ex.y, exit: 'exit_marker' });
    expectStep('graduate');

    // 17 graduate: the client acknowledges and the pilot leaves for Sol with the pack
    const storage0 = Object.fromEntries(p.storage.map((s) => [s.id, s.n]));
    const credits0 = p.credits;
    a.t.send({ type: 'tutorialReport', kind: 'ack', step: 'graduate' } as never);
    w.step(2);
    expect(p.tutorial.left).toBe(true);
    expect(p.tutorial.done).toEqual(w.data.steps.slice(0, -1).map((s) => s.id));
    expect(a.state()).toMatchObject({ step: '', left: true });
    for (const [k, n] of Object.entries(pack.items)) expect(stored(a, k)).toBe((storage0[k] ?? 0) + n);
    expect(p.credits).toBe(credits0 + pack.credits);
    expect(InSystem.systemId[a.pid]).toBe(w.server.gameData.getSystemNum('sol'));
    expect(seen).toEqual(w.data.steps.map((x) => x.id));
  });

  it('the graduate screen waits for the pilot; only a client that never answers is sent on, much later', () => {
    const w = yard();
    const a = w.pilots[0];
    w.tut.completeStep(a.conn, 'welcome');
    a.profile().tutorial.step = 'jump';
    w.tut.completeStep(a.conn, 'jump');
    expect(stepOf(a)).toBe('graduate');
    w.step(TICK_RATE * 30);
    expect(a.profile().tutorial.left).toBe(false);
    // (ten minutes on: the server's tick moved on rather than stepped through)
    (w.server as unknown as { currentTick: number }).currentTick += GRADUATE_AFTER_TICKS;
    w.step(2);
    expect(a.profile().tutorial.left).toBe(true);
  });

  it('a pilot can leave at every one of the seventeen steps and gets the pack once', () => {
    const w = yard(Array.from({ length: 17 }, (_, i) => `p${i}`));
    const ids = w.data.steps.map((s) => s.id);
    w.pilots.forEach((p, i) => { p.profile().tutorial.step = ids[i]; p.profile().tutorial.done = ids.slice(0, i); });
    w.step(2);
    const before = w.pilots.map((p) => ({ plate: stored(p, 'alloy_plate'), wire: stored(p, 'copper_wire'), credits: p.profile().credits }));
    w.pilots.forEach((p, i) => {
      p.t.send({ type: 'tutorialLeave' } as never);
      w.step(2);
      const t = p.profile().tutorial;
      expect(t.left).toBe(true);
      expect(t.done).toEqual(ids.slice(0, i));
      expect(stored(p, 'alloy_plate')).toBe(before[i].plate + w.data.starterPack.items.alloy_plate);
      expect(stored(p, 'copper_wire')).toBe(before[i].wire + w.data.starterPack.items.copper_wire);
      expect(p.profile().credits).toBe(before[i].credits + w.data.starterPack.credits);
      expect(p.state()).toMatchObject({ step: '', left: true });
      expect(InSystem.systemId[p.pid]).toBe(w.server.gameData.getSystemNum('sol'));
      p.t.send({ type: 'tutorialLeave' } as never);
      w.step(1);
      expect(stored(p, 'alloy_plate')).toBe(before[i].plate + w.data.starterPack.items.alloy_plate);
    });
  });

  it('leaving while docked at the yard station lets the pilot out into Sol', () => {
    const w = yard();
    const a = w.pilots[0];
    w.put(a.pid, w.data.yard.center.x + 700, w.data.yard.center.y);
    w.step(2);
    a.t.send({ type: 'dock' } as never);
    w.step(2);
    expect(a.conn.docked).toBeTruthy();
    a.t.send({ type: 'tutorialLeave' } as never);
    w.step(3);
    expect(a.conn.docked).toBeFalsy();
    expect(a.profile().tutorial.left).toBe(true);
    expect(InSystem.systemId[a.pid]).toBe(w.server.gameData.getSystemNum('sol'));
  });

  it('events for another step, and the client reporting the wrong thing, move nothing', () => {
    const w = yard();
    const a = w.pilots[0];
    w.tut.completeStep(a.conn, 'welcome');
    expect(stepOf(a)).toBe('rings');
    // a panel report, a wrong acknowledgement and an unknown panel cannot finish a flying step
    for (const m of [{ kind: 'panel', panel: 'hold' }, { kind: 'panel', panel: 'nonsense' }, { kind: 'ack', step: 'rings' }, { kind: 'ack' }, { kind: 'panel' }]) {
      a.t.send({ type: 'tutorialReport', ...m } as never);
      w.step(1);
      expect(stepOf(a)).toBe('rings');
    }
    // other steps' deeds do not count ahead of time
    smash(w, a, 'drone_1');
    w.tut.onEvent(a.pid, { kind: 'docked', station: w.data.yard.station });
    w.tut.onEvent(a.pid, { kind: 'partPlaced' });
    w.tut.onEvent(a.pid, { kind: 'powered' });
    w.tut.onEvent(a.pid, { kind: 'refined', item: 'iron_ore' });
    w.tut.onEvent(a.pid, { kind: 'collected', item: 'iron_ore', n: 99 });
    expect(stepOf(a)).toBe('rings');
    // a jump that does not end in the marker, a dock elsewhere
    a.profile().tutorial.step = 'jump';
    w.tut.onEvent(a.pid, { kind: 'jumped', x: 0, y: 0 });
    expect(stepOf(a)).toBe('jump');
    a.profile().tutorial.step = 'dock';
    w.tut.onEvent(a.pid, { kind: 'docked', station: 'sol_station_central' });
    expect(stepOf(a)).toBe('dock');
    // a panel report only finishes the step that asks for that panel
    a.profile().tutorial.step = 'bank';
    a.t.send({ type: 'tutorialReport', kind: 'panel', panel: 'hold' } as never);
    w.step(1);
    expect(stepOf(a)).toBe('bank');
    a.t.send({ type: 'tutorialReport', kind: 'panel', panel: 'bank' } as never);
    w.step(1);
    expect(stepOf(a)).toBe('guide');
  });

  it('a drone shot before its step (it is hidden, but still in the way) counts nothing, and is whole when the step comes', () => {
    const w = yard(['ann', 'bo']);
    const [a, b] = w.pilots;
    expect(smash(w, a, 'drone_1')).toBe(true);
    expect(a.profile().tutorial.hits?.drone_1).toBeUndefined();
    w.tut.completeStep(a.conn, 'welcome');
    w.tut.completeStep(a.conn, 'rings');
    w.tut.completeStep(a.conn, 'brake');
    expect(stepOf(a)).toBe('drones');
    expect(a.profile().tutorial.hits).toBeUndefined();
    expect(a.state().broken).toEqual([]);
    // b's progress is its own
    expect(stepOf(b)).toBe('welcome');
  });

  it('coming back to a step starts its objects over, and grants are not repeated', () => {
    const w = yard();
    const a = w.pilots[0];
    const p = a.profile();
    p.tutorial.step = 'hangar';
    p.tutorial.done = w.data.steps.slice(0, 8).map((s) => s.id);
    w.tut.completeStep(a.conn, 'hangar');
    expect(stepOf(a)).toBe('power');
    expect(stored(a, 'part:alloy:power_cell_reactor:sq')).toBe(1);
    w.tut.steps.entered(a.conn, 'power', false);
    expect(stored(a, 'part:alloy:power_cell_reactor:sq')).toBe(1);
    // a drone broken ahead of its step is whole again when the pilot comes back to it
    p.tutorial.step = 'drones';
    p.tutorial.done = ['welcome', 'rings', 'brake'];
    smash(w, a, 'drone_1');
    expect(p.tutorial.hits?.drone_1).toBeGreaterThan(0);
    w.tut.steps.entered(a.conn, 'drones', false);
    expect(p.tutorial.hits?.drone_1).toBeUndefined();
  });

  it('each pilot counts the belt ore they take themselves toward the mining step', () => {
    const w = yard(['ann', 'bo']);
    const [a, b] = w.pilots;
    for (const p of [a, b]) { p.profile().tutorial.step = 'mine'; p.profile().tutorial.done = ['welcome', 'rings', 'brake', 'drones']; }
    mineChunk(w, a, { iron_ore: 12 });
    mineChunk(w, b, { iron_ore: 5 });
    expect(stepOf(a)).toBe('mine');
    expect(stepOf(b)).toBe('mine');
    mineChunk(w, a, { copper_ore: 8 });
    expect(stepOf(a)).toBe('hold');
    expect(stepOf(b)).toBe('mine');
  });

  it('ore already in the hold counts toward the mining step (a reconnect or a fuller hold never strands it)', () => {
    const w = yard();
    const a = w.pilots[0];
    const p = a.profile();
    p.tutorial.step = 'mine';
    p.tutorial.done = ['welcome', 'rings', 'brake', 'drones'];
    // 18 ore taken before a reconnect: this visit's count starts over, the hold still has it
    p.cargo.push({ id: 'iron_ore', n: 18 });
    mineChunk(w, a, { iron_ore: 1 });
    expect(stepOf(a)).toBe('mine');
    mineChunk(w, a, { silicate: 1 });
    expect(stepOf(a)).toBe('hold');
  });

  it('the multi-panel step needs both panels, in either order, and a left pilot is ignored', () => {
    const w = yard();
    const a = w.pilots[0];
    a.profile().tutorial.step = 'guide';
    a.t.send({ type: 'tutorialReport', kind: 'panel', panel: 'guide' } as never);
    w.step(1);
    a.t.send({ type: 'tutorialReport', kind: 'panel', panel: 'guide' } as never);
    w.step(1);
    expect(stepOf(a)).toBe('guide');
    a.t.send({ type: 'tutorialReport', kind: 'panel', panel: 'map' } as never);
    w.step(1);
    expect(stepOf(a)).toBe('fieldview');
    w.tut.leave(a.conn);
    a.t.send({ type: 'tutorialReport', kind: 'panel', panel: 'map' } as never);
    w.step(1);
    expect(a.profile().tutorial).toMatchObject({ step: '', left: true });
  });
});
