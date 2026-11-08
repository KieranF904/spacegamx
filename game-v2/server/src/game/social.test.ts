import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { Position, Velocity, InSystem, Dead, ServerMessage, Station as StationComp, countOf, BOUNTY_WINDOW_MS } from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../proto/createProtoServer.js';

const dataDir = join(__dirname, '../../../data');
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const files = readGameDataFiles(dataDir);

/** A server with two pilots, Ash and Bree */
function world(clock = { t: 1_000_000 }) {
  resetGlobals();
  const server = new GameServer({
    gameData: new GameData(files),
    userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as any,
    scene: 'sectors',
    autoStart: false,
    ships: createShipBridge(loadShipConfigCached(dataDir)),
    clock: () => clock.t,
  });
  const pilot = (name: string) => {
    const t = new LocalTransport(server);
    const got: ServerMessage[] = [];
    t.onMessage = (m) => got.push(m);
    t.connect();
    t.send({ type: 'join', username: name } as any);
    const pid = () => t.getPlayerId();
    const conn = server.pilots.connOf(pid())!;
    // (What it has been sent so far: its coalesced frames go now, as they would within a few ticks, net/snapshot/PackedLink.ts)
    const last = <T extends ServerMessage['type']>(type: T) => {
      (server.pilots.connOf(pid()) as any)?.packed?.drain(server.getTick());
      return [...got].reverse().find((m) => m.type === type) as Extract<ServerMessage, { type: T }> | undefined;
    };
    return { t, got, pid, conn, profile: () => server.pilots.get(conn)!, last, send: (m: any) => t.send(m) };
  };
  const a = pilot('Ash');
  const b = pilot('Bree');
  const step = (n = 1) => { for (let i = 0; i < n; i++) server.step(); };
  return { server, a, b, step, clock };
}

const hold = (pid: number, x: number, y: number) => { Position.x[pid] = x; Position.y[pid] = y; Velocity.x[pid] = 0; Velocity.y[pid] = 0; };

function stationEid(server: GameServer, id: string): number {
  const w = server.getWorld();
  const num = server['gameData'].getStationNum(id);
  return [...Array(8000).keys()].find((e) => bitecs.entityExists(w, e) && bitecs.hasComponent(w, StationComp, e) && StationComp.stationId[e] === num)!;
}

function partyUp(w: ReturnType<typeof world>): void {
  w.a.send({ type: 'partyInvite', name: 'Bree' });
  w.b.send({ type: 'partyRespond', accept: true });
}

/** A generated job (bounty or fleet op) at a station whose first step is `kind` */
function findJob(server: GameServer, prefix: 'bounty' | 'fleet', station: string, kind: string, now: number): string {
  const w0 = Math.floor(now / BOUNTY_WINDOW_MS);
  for (let w = w0; w < w0 + 400; w++) {
    for (let i = 0; i < 4; i++) {
      const id = `${prefix}:${station}:${w}:${i}`;
      if (server.quests.def(id)?.steps[0].type === kind) return id;
    }
  }
  throw new Error(`no ${kind} job`);
}

/** Put a job straight into a pilot's log */
function give(server: GameServer, who: { profile: () => any }, id: string, now: number): void {
  who.profile().quests.active[id] = { stage: 0, progress: 0, data: { since: now } };
}

describe('parties', () => {
  it('invite by name, accept, and both pilots see the party; leaving disbands a party of two', () => {
    const w = world();
    partyUp(w);
    expect(w.a.last('party')!.members.map((m) => m.name)).toEqual(['Ash', 'Bree']);
    expect(w.b.last('party')!.leader).toBe('Ash');
    expect(w.server.party.same(w.a.conn, w.b.conn)).toBe(true);
    w.b.send({ type: 'partyLeave' });
    expect(w.server.party.size(w.a.conn)).toBe(1);
    expect(w.a.last('party')!.members).toEqual([]);
  });

  it('wingmates close together hit harder; apart, the bonus goes', () => {
    const w = world();
    partyUp(w);
    hold(w.a.pid(), 30000, 30000);
    hold(w.b.pid(), 31000, 30000);
    w.step(31);
    expect(w.server.getShips().wingBonus(w.a.pid())).toBeCloseTo(1.08);
    hold(w.b.pid(), 45000, 30000);
    w.step(31);
    expect(w.server.getShips().wingBonus(w.a.pid())).toBe(1);
  });

  it('a kill is shared with party members nearby: XP, credits, and it counts for their jobs', () => {
    const w = world();
    partyUp(w);
    const num = InSystem.systemId[w.a.pid()];
    hold(w.a.pid(), 30000, 30000);
    hold(w.b.pid(), 34000, 30000);
    // Bree holds a kill bounty for pirates
    w.b.profile().quests.active['test_kill'] = { stage: 0, progress: 0 };
    (w.server.quests as any).defs.set('test_kill', { id: 'test_kill', name: 'Test', chain: 'bounty', giver: 'sol_station_central', level: 1, intro: '', outro: '',
      steps: [{ type: 'kill', faction: 'pirates', count: 5 }], rewards: {} });
    const before = { xp: w.b.profile().xp, credits: w.b.profile().credits };
    const [foe] = w.server.enemies.spawnPack(num, { faction: 'pirates', ships: ['pirate_skiff'] }, 30000, 29000);
    const bridge = w.server.getShips();
    (bridge as any).lastHitBy.set(foe, w.a.pid());
    bridge.damagePartFraction(foe, bridge.get(foe)!.blueprint.parts.findIndex((p) => p.fn === 'core'), 1);
    w.step(3);
    expect(w.b.profile().xp).toBeGreaterThan(before.xp);
    expect(w.b.profile().credits).toBeGreaterThan(before.credits);
    expect(w.b.profile().quests.active['test_kill'].progress).toBe(1);
  });

  it('destroyed? rally beside a party member who is not in a fight', () => {
    const w = world();
    partyUp(w);
    hold(w.a.pid(), 25000, -12000);
    w.step(2);
    const bp = w.b.pid();
    bitecs.addComponent(w.server.getWorld(), Dead, bp);
    w.step(2);
    w.b.send({ type: 'respawn', rally: 'Ash' });
    w.step(2);
    const nb = w.b.pid();
    expect(nb).not.toBe(bp);
    expect(Math.hypot(Position.x[nb] - Position.x[w.a.pid()], Position.y[nb] - Position.y[w.a.pid()])).toBeLessThan(700);
  });

  it('hovering over a pilot asks for their card', () => {
    const w = world();
    w.a.send({ type: 'pilotInfo', id: w.b.pid() });
    const card = w.a.last('pilotInfo')!;
    expect(card.name).toBe('Bree');
    expect(card.ship.length).toBeGreaterThan(0);
    expect(card.parts).toBeGreaterThan(0);
  });
});

describe('trading between pilots', () => {
  it('both accept and the goods and credits change hands at once', () => {
    const w = world();
    hold(w.a.pid(), 30000, 30000);
    hold(w.b.pid(), 30800, 30000);
    w.step();
    w.a.profile().cargo.push({ id: 'iron_ore', n: 12 });
    const credits = { a: w.a.profile().credits, b: w.b.profile().credits };
    w.a.send({ type: 'tradeRequest', id: w.b.pid() });
    w.b.send({ type: 'tradeRespond', accept: true });
    expect(w.a.last('trade')!.open).toBe(true);
    w.a.send({ type: 'tradeOffer', items: { iron_ore: 5 }, credits: 50 });
    w.b.send({ type: 'tradeAccept' });
    // Changing an offer clears acceptances
    w.a.send({ type: 'tradeOffer', items: { iron_ore: 5 }, credits: 60 });
    expect(w.b.last('trade')!.myAccept).toBe(false);
    w.a.send({ type: 'tradeAccept' });
    w.b.send({ type: 'tradeAccept' });
    expect(w.a.last('trade')!.open).toBe(false);
    expect(countOf(w.a.profile().cargo, 'iron_ore')).toBe(7);
    expect(countOf(w.b.profile().storage, 'iron_ore')).toBeGreaterThanOrEqual(5);
    expect(w.a.profile().credits).toBe(credits.a - 60);
    expect(w.b.profile().credits).toBe(credits.b + 60);
  });

  it('too far apart: no trade', () => {
    const w = world();
    hold(w.a.pid(), 30000, 30000);
    hold(w.b.pid(), 40000, 30000);
    w.step();
    w.a.send({ type: 'tradeRequest', id: w.b.pid() });
    expect(w.b.last('tradeRequest')).toBeUndefined();
  });
});

describe('operations', () => {
  it('fleet ops need a party, and accepting one signs up the whole party', () => {
    const w = world();
    const id = findJob(w.server, 'fleet', 'sol_station_central', 'uplink', w.clock.t);
    w.clock.t = Number(id.split(':')[2]) * BOUNTY_WINDOW_MS + 1000;
    const st = stationEid(w.server, 'sol_station_central');
    hold(w.a.pid(), Position.x[st] + 300, Position.y[st]);
    w.step(2);
    w.a.send({ type: 'questAccept', id });
    expect(w.a.profile().quests.active[id]).toBeUndefined();
    partyUp(w);
    w.a.send({ type: 'questAccept', id });
    expect(w.a.profile().quests.active[id]).toBeDefined();
    expect(w.b.profile().quests.active[id]).toBeDefined();
  });

  it('the party leader giving up a fleet op calls it off for everyone; it can be taken again', () => {
    const w = world();
    partyUp(w);
    const id = findJob(w.server, 'fleet', 'sol_station_central', 'uplink', w.clock.t);
    w.clock.t = Number(id.split(':')[2]) * BOUNTY_WINDOW_MS + 1000;
    give(w.server, w.a, id, w.clock.t);
    give(w.server, w.b, id, w.clock.t);
    w.step(31);
    w.a.send({ type: 'questAbandon', id });
    expect(w.a.profile().quests.active[id]).toBeUndefined();
    expect(w.b.profile().quests.active[id]).toBeUndefined();
    expect(w.a.profile().quests.done).not.toContain(id);
    expect(w.b.got.some((m) => m.type === 'toast' && /Ash called off/.test((m as any).text))).toBe(true);
    // Back at the station it's on the board again
    const st = stationEid(w.server, 'sol_station_central');
    hold(w.a.pid(), Position.x[st] + 300, Position.y[st]);
    w.step(2);
    w.a.send({ type: 'questBoard' });
    expect(w.a.last('questBoard')!.offers.map((o) => o.id)).toContain(id);
    w.step(31);
    expect(w.a.last('ops')!.ops.find((o) => o.quest === id)).toBeUndefined();
  });

  it('anyone else giving up just leaves it; with too few pilots left it is called off after a while', () => {
    const w = world();
    partyUp(w);
    const id = findJob(w.server, 'fleet', 'sol_station_central', 'uplink', w.clock.t);
    w.clock.t = Number(id.split(':')[2]) * BOUNTY_WINDOW_MS + 1000;
    give(w.server, w.a, id, w.clock.t);
    give(w.server, w.b, id, w.clock.t);
    w.step(31);
    w.b.send({ type: 'questAbandon', id });
    expect(w.b.profile().quests.active[id]).toBeUndefined();
    expect(w.a.profile().quests.active[id]).toBeDefined();
    expect(w.a.got.some((m) => m.type === 'toast' && /Bree left/.test((m as any).text))).toBe(true);
    w.step(31);
    expect(w.a.got.some((m) => m.type === 'toast' && /Regroup within/.test((m as any).text))).toBe(true);
    const secs = w.server.ops.rules.awaySeconds;
    w.step(secs * 60 + 60);
    expect(w.a.profile().quests.active[id]).toBeUndefined();
    expect(w.a.profile().quests.done).not.toContain(id);
  });

  it('a fleet op whose party broke up is called off unless they regroup', () => {
    const w = world();
    partyUp(w);
    const id = findJob(w.server, 'fleet', 'sol_station_central', 'uplink', w.clock.t);
    w.clock.t = Number(id.split(':')[2]) * BOUNTY_WINDOW_MS + 1000;
    give(w.server, w.a, id, w.clock.t);
    give(w.server, w.b, id, w.clock.t);
    w.step(31);
    w.b.send({ type: 'partyLeave' });
    const secs = w.server.ops.rules.awaySeconds;
    // Back together in time: it carries on
    w.step(secs * 30);
    partyUp(w);
    w.step(secs * 60);
    expect(w.a.profile().quests.active[id]).toBeDefined();
    // Apart for good: called off for both
    w.b.send({ type: 'partyLeave' });
    w.step(secs * 60 + 60);
    expect(w.a.profile().quests.active[id]).toBeUndefined();
    expect(w.b.profile().quests.active[id]).toBeUndefined();
  });

  it('an uplink charges only while every beacon is held at once', () => {
    const w = world();
    partyUp(w);
    const id = findJob(w.server, 'fleet', 'sol_station_central', 'uplink', w.clock.t);
    w.clock.t = Number(id.split(':')[2]) * BOUNTY_WINDOW_MS + 1000;
    give(w.server, w.a, id, w.clock.t);
    give(w.server, w.b, id, w.clock.t);
    // (No passing freighters to ram the beacon holders)
    for (const f of w.server.getTrafficShips()) w.server.getShips().removeShip(f.eid);
    (w.server as any).traffic.forEach((t: any) => { t.respawnTick = Infinity; });
    hold(w.a.pid(), 20000, 20000);
    hold(w.b.pid(), 20000, 20000);
    w.step(31);
    const op = w.a.last('ops')!.ops.find((o) => o.quest === id)!;
    const [b1, b2] = op.markers;
    // One beacon held: nothing
    for (let i = 0; i < 300; i++) { hold(w.a.pid(), b1.x, b1.y); w.step(); }
    expect(w.a.last('ops')!.ops.find((o) => o.quest === id)!.progress).toBe(0);
    // Both: it charges through
    const secs = (w.server.quests.def(id)!.steps[0] as any).seconds;
    const bridge = w.server.getShips();
    let raids = 0;
    for (let i = 0; i < secs * 60 + 200 && w.a.profile().quests.active[id]; i++) {
      hold(w.a.pid(), b1.x, b1.y); hold(w.b.pid(), b2.x, b2.y);
      // The wing shoots the jammers down as they come
      for (const [eid] of bridge.bodies) if (w.server.enemies.factionOf(eid)) { raids++; bridge.removeShip(eid); }
      w.step();
    }
    expect(raids).toBeGreaterThan(0);
    expect(w.a.profile().quests.active[id]).toBeUndefined();
    expect(w.b.profile().quests.active[id]).toBeUndefined();
    expect(w.a.profile().quests.done).toContain(id);
  });

  it('an escort: the freighter waits at the station, sets off when you arrive, and pays out when it docks', () => {
    const w = world();
    const id = findJob(w.server, 'bounty', 'sol_station_central', 'escort', w.clock.t);
    w.clock.t = Number(id.split(':')[2]) * BOUNTY_WINDOW_MS + 1000;
    give(w.server, w.a, id, w.clock.t);
    const step = w.server.quests.def(id)!.steps[0] as any;
    const from = stationEid(w.server, step.from), to = stationEid(w.server, step.to);
    for (let i = 0; i < 30; i++) { hold(w.a.pid(), Position.x[from] + 1500, Position.y[from]); w.step(); }
    const ward = w.a.last('ops')?.ops[0]?.ward;
    expect(ward).toBeDefined();
    // Skip the trip: put the freighter at the far station
    const credits = w.a.profile().credits;
    for (let i = 0; i < 31; i++) { hold(ward!.eid, Position.x[to] + 400, Position.y[to]); hold(w.a.pid(), Position.x[to] + 900, Position.y[to]); w.step(); }
    expect(w.a.profile().quests.active[id]).toBeUndefined();
    expect(w.a.profile().credits).toBeGreaterThan(credits);
  });

  it('an escort fails if the freighter is destroyed', () => {
    const w = world();
    const id = findJob(w.server, 'bounty', 'sol_station_central', 'escort', w.clock.t);
    w.clock.t = Number(id.split(':')[2]) * BOUNTY_WINDOW_MS + 1000;
    give(w.server, w.a, id, w.clock.t);
    const from = stationEid(w.server, (w.server.quests.def(id)!.steps[0] as any).from);
    for (let i = 0; i < 30; i++) { hold(w.a.pid(), Position.x[from] + 1500, Position.y[from]); w.step(); }
    const ward = w.a.last('ops')!.ops[0].ward!;
    const bridge = w.server.getShips();
    bridge.damagePartFraction(ward.eid, bridge.get(ward.eid)!.blueprint.parts.findIndex((p) => p.fn === 'core'), 1);
    w.step(20);
    expect(w.a.profile().quests.active[id]).toBeUndefined();
    expect(w.a.profile().quests.done).not.toContain(id);
  });

  it('a defence: waves come at the outpost, and breaking them all pays', () => {
    const w = world();
    const id = findJob(w.server, 'bounty', 'sol_station_central', 'defend', w.clock.t);
    w.clock.t = Number(id.split(':')[2]) * BOUNTY_WINDOW_MS + 1000;
    give(w.server, w.a, id, w.clock.t);
    hold(w.a.pid(), 0, 0);
    w.step(31);
    const site = w.a.last('ops')!.ops[0].markers[0];
    const waves = (w.server.quests.def(id)!.steps[0] as any).waves;
    const bridge = w.server.getShips();
    let seen = 0;
    for (let i = 0; i < 60 * 30 * waves && w.a.profile().quests.active[id]; i++) {
      hold(w.a.pid(), site.x + 600, site.y);
      // Keep the outpost alive and shoot down each wave as it arrives
      for (const [eid] of bridge.bodies) {
        if (!w.server.enemies.factionOf(eid)) continue;
        seen++;
        bridge.damagePartFraction(eid, bridge.get(eid)!.blueprint.parts.findIndex((p) => p.fn === 'core'), 1);
      }
      w.step();
    }
    expect(seen).toBeGreaterThan(0);
    expect(w.a.profile().quests.done).toContain(id);
  });

  it('a scan counts once you hold steady beside a wreck', () => {
    const w = world();
    const id = findJob(w.server, 'bounty', 'sol_station_central', 'scan', w.clock.t);
    w.clock.t = Number(id.split(':')[2]) * BOUNTY_WINDOW_MS + 1000;
    give(w.server, w.a, id, w.clock.t);
    w.step(30);
    const wreck = [...w.server.getShips().bodies.keys()].find((e) => (w.server as any).derelicts.some((d: any) => d.eid === e))!;
    for (let i = 0; i < 200; i++) { hold(w.a.pid(), Position.x[wreck] + 300, Position.y[wreck]); w.step(); }
    expect(w.a.profile().quests.active[id]?.progress ?? 99).toBeGreaterThanOrEqual(1);
  });

  it('a courier run fails when the clock runs out', () => {
    const w = world();
    const id = findJob(w.server, 'bounty', 'sol_station_central', 'courier', w.clock.t);
    w.clock.t = Number(id.split(':')[2]) * BOUNTY_WINDOW_MS + 1000;
    give(w.server, w.a, id, w.clock.t);
    hold(w.a.pid(), 40000, 40000);
    w.step(31);
    expect(w.a.last('ops')!.ops[0].timer).toBeGreaterThan(0);
    w.clock.t += ((w.server.quests.def(id)!.steps[0] as any).seconds + 1) * 1000;
    w.step(31);
    expect(w.a.profile().quests.active[id]).toBeUndefined();
  });
});
