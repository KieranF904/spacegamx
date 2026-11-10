import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { Position, Velocity, InSystem, ServerMessage, Station as StationComp, countOf } from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../proto/createProtoServer.js';
import { MemoryProfileStore } from '../profile/ProfileStore.js';
import { makeServer } from '../testkits/world.testkit.js';

const dataDir = join(__dirname, '../../../data');
const files = readGameDataFiles(dataDir);
const quest = (id: string) => (files.quests as any).quests.find((q: any) => q.id === id);

function world() {
  (bitecs as unknown as { resetGlobals: () => void }).resetGlobals();
  const server = makeServer({ profileStore: new MemoryProfileStore() });
  const t = new LocalTransport(server);
  const got: ServerMessage[] = [];
  t.onMessage = (m) => got.push(m);
  t.connect();
  t.send({ type: 'join', username: 'rimer' } as any);
  const pid = t.getPlayerId();
  const conn = server.pilots.connOf(pid)!;
  const p = () => server.pilots.get(conn)!;
  const gd = server.gameData;
  /** Sit still at a point in a system for a while */
  const hover = (system: string, x: number, y: number, ticks = 35) => {
    InSystem.systemId[pid] = gd.getSystemNum(system);
    for (let i = 0; i < ticks; i++) { Position.x[pid] = x; Position.y[pid] = y; Velocity.x[pid] = Velocity.y[pid] = 0; server.step(); }
  };
  const goTo = (station: string) => {
    const w = server.getWorld(), num = gd.getStationNum(station);
    const st = [...Array(8000).keys()].find((e) => bitecs.entityExists(w, e) && bitecs.hasComponent(w, StationComp, e) && StationComp.stationId[e] === num)!;
    InSystem.systemId[pid] = InSystem.systemId[st];
    for (let i = 0; i < 65; i++) { Position.x[pid] = Position.x[st] + 300; Position.y[pid] = Position.y[st]; Velocity.x[pid] = Velocity.y[pid] = 0; server.step(); }
  };
  /** Hold a spot, seeing off whatever the hold sends to break it up (they're the fight, not the job) */
  const holdOff = (system: string, x: number, y: number, ticks: number) => {
    const ops = (server as any).ops;
    InSystem.systemId[pid] = gd.getSystemNum(system);
    for (let i = 0; i < ticks; i++) {
      Position.x[pid] = x; Position.y[pid] = y; Velocity.x[pid] = Velocity.y[pid] = 0;
      server.step();
      for (const task of ops.tasks.values()) for (const r of task.raiders ?? []) if (ops.host.hostileAlive(r)) ops.host.removeHostile(r);
    }
  };
  const last = () => [...got].reverse().find((m) => m.type === 'talk') as any;
  const pick = (re: RegExp) => {
    const v = last()?.view;
    expect(v, `nothing to answer (looking for ${re})`).toBeTruthy();
    const i = v.choices.findIndex((c: any) => re.test(c.text));
    expect(i, `no choice ${re} in ${v.choices.map((c: any) => c.text).join(' | ')}`).toBeGreaterThanOrEqual(0);
    t.send({ type: 'talk', n: v.n, choice: i } as any);
  };
  const hangUp = () => { const v = last()?.view; if (v) t.send({ type: 'talk', n: v.n, close: true } as any); };
  const stage = (id: string) => p().quests.active[id]?.stage ?? (p().quests.done.includes(id) ? 99 : -1);
  const take = (id: string) => expect(server.quests.acceptFrom(conn, id)).toBeNull();
  /** Kill a boss outright (its core) */
  const killBoss = (eid: number) => {
    const bridge = server.getShips();
    const ship = bridge.get(eid)!;
    Position.x[pid] = Position.x[eid] + 600; Position.y[pid] = Position.y[eid];
    bridge.hurt(eid, ship, 0, 10, pid);
    bridge.hurt(eid, ship, ship.blueprint.parts.findIndex((q) => q.fn === 'core'), 1e9, pid);
    for (let i = 0; i < 5; i++) server.step();
  };
  return { server, t, got, pid, conn, p, gd, hover, holdOff, goTo, pick, hangUp, stage, take, killBoss, ops: (server as any).ops };
}

describe('Borealis', () => {
  it('has a second station (Thawline), the Rime Shoal of aurora floes, the Aurora Knot, a way down to Glacia, and the Halvard on the ice road', () => {
    const { server, gd } = world();
    const bor = gd.getSystem('borealis')!;
    expect(bor.stations).toEqual(expect.arrayContaining(['borealis_station_outpost', 'borealis_station_thawline']));
    const num = gd.getSystemNum('borealis');
    const ids = (server as any).asteroidIdsBySystem.get(num) as number[];
    expect(ids.length).toBe(250 + 110);
    const types = ids.map((e) => (server as any).asteroidTypeById.get(e));
    expect(types.filter((t) => t === 'rock_aurora_floe').length).toBeGreaterThan(25);
    expect(bor.lodestones!.some((l) => l.name === 'Aurora Knot' && l.position)).toBe(true);
    expect(bor.planets!.find((pl) => pl.id === 'glacia')!.surface).toBe('glacia_surface');
    expect(gd.getSystem('glacia_surface')!.surface?.of).toBe('borealis');
    expect(bor.derelicts!.some((d) => d.id === 'wreck_halvard')).toBe(true);
    // Aurora rime refines into hush panes
    expect((files.recipes as any).refining.find((r: any) => r.id === 'hush_pane').inputs.aurora_rime).toBe(4);
  });

  it('a signal peak: a flock of Brood bursts out of the Curtain and scatters, shedding rime pods; it passes, and the flock is gone', () => {
    const { server, gd, hover } = world();
    const num = gd.getSystemNum('borealis');
    hover('borealis', -18200, 900, 5);
    const events = (server as any).events;
    events.rules.peak.durationSeconds = 3;
    const e = events.startPeak(num)!;
    expect(e.kind).toBe('peak');
    expect(e.ships.length).toBe(4);
    expect(Math.hypot(e.x - 30000, e.y - 42000)).toBeLessThan(1);
    expect(events.active(num).some((x: any) => x.id === e.id)).toBe(true);
    for (let i = 0; i < 60 * 4; i++) server.step();
    expect(events.active(num).some((x: any) => x.id === e.id)).toBe(false);
    expect(e.ships.every((s: number) => !(server as any).enemies.isAlive(s))).toBe(true);
    // Its rime is still floating there for the taking
    expect((server as any).pods.clear(num)).toBeGreaterThanOrEqual(8);
    // Nowhere else peaks
    expect(events.startPeak(gd.getSystemNum('sol'))).toBeNull();
  });

  it('the Ice Road chain: rime and panes for Sander, the Curtain survey, the Halvard, the Halden cache under Glacia, the listening blind, and the Hushwing', () => {
    const w = world();
    const { server, conn, p, gd, hover, holdOff, goTo, pick, hangUp, stage, take, ops } = w;
    hangUp();
    p().quests.done.push('main_01', 'main_02', 'main_03', 'clearance', 'main_04');
    p().licences.push('outer_lanes');
    p().level = 9;
    // 1. Cutting Rime
    take('ice_01');
    server.pilots.give(conn, { aurora_rime: 16 }, { source: 'mined', toStorage: true });
    expect(stage('ice_01')).toBe(1);
    server.pilots.give(conn, { hush_pane: 3 }, { source: 'refined', toStorage: true });
    expect(stage('ice_01')).toBe(2);
    goTo('borealis_station_thawline');
    expect(stage('ice_01')).toBe(99);
    // 2. The Curtain Run: the survey line, then the Knot (the Brood come for you; hold anyway)
    take('ice_02');
    const course = quest('ice_02').steps[0];
    hover('borealis', course.x, course.y, 15);
    for (const r of ops.ringsOf('ice_02', course)) hover('borealis', r.x, r.y, 15);
    expect(stage('ice_02')).toBe(1);
    const knot = quest('ice_02').steps[1];
    holdOff("borealis", knot.x, knot.y, 60 * 27);
    expect(stage('ice_02')).toBe(99);
    // 3. The Lighter Halvard: her log, to Maya
    take('ice_03');
    const wreck = quest('ice_03').steps[0];
    hover('borealis', wreck.x + 5000, wreck.y, 30);
    hover('borealis', wreck.x, wreck.y, 120);
    expect(countOf(p().cargo, 'halvard_log')).toBe(1);
    goTo('borealis_station_outpost');
    w.t.send({ type: 'talk', person: 'maya' } as any);
    pick(/Lighter Halvard/);
    expect(stage('ice_03')).toBe(99);
    expect(countOf(p().cargo, 'halvard_log')).toBe(0);
    hangUp();
    // 4. Under the Ice: down to Glacia, cut the shaft, pull up the cache, give it to Aske
    take('ice_04');
    const shaft = quest('ice_04').steps[1];
    hover('glacia_surface', shaft.x + 3000, shaft.y, 20);
    expect(stage('ice_04')).toBe(1);
    hover('glacia_surface', shaft.x, shaft.y, 60 * 22);
    hover('glacia_surface', shaft.x, shaft.y, 120);
    expect(countOf(p().cargo, 'halden_cache')).toBe(1);
    const aske = (files.people as any).people.find((x: any) => x.id === 'aske').at;
    hover('glacia_surface', aske.x, aske.y + 150, 20);
    w.t.send({ type: 'interact' } as any);
    pick(/Under the Ice/);
    expect(stage('ice_04')).toBe(99);
    expect(countOf(p().storage, 'ancient_relic')).toBeGreaterThanOrEqual(1);
    hangUp();
    // 5. A Blind in the Curtain: build it (a Constructor fitted), sit with it, back to Maya
    take('ice_05');
    ops.host.fitted = () => true;
    p().cargo.push({ id: 'hush_pane', n: 1 }, { id: 'servo_motor', n: 1 }, { id: 'power_coupling', n: 1 }, { id: 'crystal_lens', n: 1 });
    const blind = quest('ice_05').steps[0];
    hover('borealis', blind.x, blind.y, 60 * 26);
    expect(stage('ice_05')).toBe(1);
    holdOff("borealis", blind.x, blind.y, 60 * 32);
    expect(stage('ice_05')).toBe(2);
    goTo('borealis_station_outpost');
    w.t.send({ type: 'talk', person: 'maya' } as any);
    pick(/Blind in the Curtain/);
    expect(stage('ice_05')).toBe(99);
    hangUp();
    // 6. The Hushwing: it lairs north of the Curtain while pilots are in Borealis
    take('ice_06');
    const lair = (files.bosses as any).bosses.boss_hushwing.lair;
    hover('borealis', lair.x + 9000, lair.y, 130);
    const eid = (server as any).bosses.eidOf('boss_hushwing');
    expect(eid).toBeGreaterThanOrEqual(0);
    w.killBoss(eid);
    expect(stage('ice_06')).toBe(99);
    void gd;
  });
});
