import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import {
  Position, Velocity, Asteroid, Portal, InSystem, ServerMessage, Station as StationComp, countOf, bountyIds, bountyDef,
  xpToReach, repRank, REP_MAX, REP_RANKS, materialLicensed, MATERIAL_LEVEL,
} from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigFromDisk } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../proto/createProtoServer.js';
import { MemoryProfileStore } from '../profile/ProfileStore.js';

const dataDir = join(__dirname, '../../../data');
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const files = readGameDataFiles(dataDir);

function world(clock = { t: 1_000_000 }, store = new MemoryProfileStore()) {
  resetGlobals();
  const server = new GameServer({
    profileStore: store,
    gameData: new GameData(files),
    userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as any,
    scene: 'sectors',
    autoStart: false,
    ships: createShipBridge(loadShipConfigFromDisk(dataDir)),
    clock: () => clock.t,
  });
  const t = new LocalTransport(server);
  const got: ServerMessage[] = [];
  t.onMessage = (m) => got.push(m);
  t.connect();
  t.send({ type: 'join', username: 'pilot' } as any);
  const pid = t.getPlayerId();
  const conn = server.pilots.connOf(pid)!;
  const profile = () => server.pilots.get(conn)!;
  const last = <T extends ServerMessage['type']>(type: T) => [...got].reverse().find((m) => m.type === type) as Extract<ServerMessage, { type: T }> | undefined;
  return { server, t, got, pid, conn, profile, clock, last, w: server.getWorld(), store };
}

function stationEid(server: GameServer, id: string): number {
  const w = server.getWorld();
  const num = server['gameData'].getStationNum(id);
  return [...Array(8000).keys()].find((e) => bitecs.entityExists(w, e) && bitecs.hasComponent(w, StationComp, e) && StationComp.stationId[e] === num)!;
}

/** Fly (teleport) to a station and let the quest checks run */
function goTo(server: GameServer, pid: number, id: string): void {
  const st = stationEid(server, id);
  InSystem.systemId[pid] = InSystem.systemId[st];
  Position.x[pid] = Position.x[st] + 300;
  Position.y[pid] = Position.y[st];
  Velocity.x[pid] = 0; Velocity.y[pid] = 0;
  for (let i = 0; i < 65; i++) {
    Position.x[pid] = Position.x[st] + 300;
    Position.y[pid] = Position.y[st];
    server.step();
  }
}

/** Away from every station (so deliver/dock steps don't fire) */
function away(server: GameServer, pid: number): void {
  Position.x[pid] = 40000; Position.y[pid] = 40000;
  Velocity.x[pid] = 0; Velocity.y[pid] = 0;
  server.step();
}

describe('quests: saved progress', () => {
  it('each step reached, and each quest finished, is in the save straight away and comes back on login', async () => {
    const { server, conn, pid, profile, store } = world();
    (conn as any).userId = 7;
    expect(server.quests.acceptFrom(conn, 'main_01')).toBeNull();
    away(server, pid);
    server.pilots.give(conn, { iron_ore: 10 }, { source: 'mined' });
    // A step reached: saved without waiting for the autosave
    let saved = (await store.load(7)) as any;
    expect(saved.quests.active.main_01.stage).toBe(1);
    goTo(server, pid, 'sol_station_central');
    saved = (await store.load(7)) as any;
    expect(saved.quests.done).toContain('main_01');
    expect(saved.quests.known).toContain('main_02');
    // A fresh connection on the same account picks it all up
    const before = JSON.parse(JSON.stringify(profile().quests));
    await server.pilots.detach(conn);
    const t2 = new LocalTransport(server);
    t2.connect();
    t2.send({ type: 'join', username: 'pilot' } as any);
    const c2 = server.pilots.connOf(t2.getPlayerId())!;
    (c2 as any).userId = 7;
    await server.pilots.login(c2, 7);
    expect(server.pilots.get(c2)!.quests.done).toEqual(before.done);
    expect(Object.keys(server.pilots.get(c2)!.quests.active).sort()).toEqual(Object.keys(before.active).sort());
  });

  it('one account flies in one place: signing in again saves and signs out the other session', async () => {
    const { server, conn, got, store } = world();
    (conn as any).userId = 7;
    await server['loginPilot'](conn, 7);
    server.pilots.addCredits(conn, 1234);
    const credits = server.pilots.get(conn)!.credits;
    const t2 = new LocalTransport(server);
    t2.connect();
    t2.send({ type: 'join', username: 'pilot' } as any);
    const c2 = server.pilots.connOf(t2.getPlayerId())!;
    (c2 as any).userId = 7;
    await server['loginPilot'](c2, 7);
    // The first is told why, and is no longer that pilot
    expect(got.some((m) => m.type === ('authResult' as any) && (m as any).success === false && /somewhere else/.test((m as any).error))).toBe(true);
    expect(server.pilots.get(conn)).toBeUndefined();
    expect((conn as any).userId).toBeNull();
    // The second has everything the first had
    expect(server.pilots.get(c2)!.credits).toBe(credits);
    expect(((await store.load(7)) as any).credits).toBe(credits);
  });

  it('the profile in hand while a save loads is never written over it', async () => {
    const store = new MemoryProfileStore();
    await store.save(9, { credits: 4321, quests: { active: {}, done: ['main_01', 'main_02'] } });
    let release!: () => void;
    const slow = Object.assign(Object.create(store), {
      load: async (id: number) => { await new Promise<void>((r) => { release = r; }); return store.load(id); },
    });
    const { server, conn, clock } = world(undefined, slow);
    (conn as any).userId = 9;
    const loading = server.pilots.login(conn, 9);
    // Autosave time passes, and the pilot leaves, while it loads: nothing is saved
    server.pilots.markDirty(conn);
    clock.t += 120_000;
    server.step();
    await server.pilots.detach(conn);
    release();
    await loading;
    const saved = (await store.load(9)) as any;
    expect(saved.credits).toBe(4321);
    expect(saved.quests.done).toEqual(['main_01', 'main_02']);
  });
});

/** What the conversation shows now (the last talk message) */
function view(last: ReturnType<typeof world>['last']) {
  return last('talk')?.view ?? null;
}

/** Answer the conversation: the choice whose text matches */
function pick(w: ReturnType<typeof world>, re: RegExp): void {
  const v = view(w.last);
  expect(v, `nothing to answer (looking for ${re})`).toBeTruthy();
  const i = v!.choices.findIndex((c) => re.test(c.text));
  expect(i, `no choice ${re} in ${v!.choices.map((c) => c.text).join(' | ')}`).toBeGreaterThanOrEqual(0);
  w.t.send({ type: 'talk', n: v!.n, choice: i } as any);
}

function talk(w: ReturnType<typeof world>, person: string): void {
  w.t.send({ type: 'talk', person } as any);
}

/** Walk away from whatever conversation is showing */
function hangUp(w: ReturnType<typeof world>): void {
  const v = view(w.last);
  if (v) w.t.send({ type: 'talk', n: v.n, close: true } as any);
}

/** Take a job without the conversation */
function take(w: ReturnType<typeof world>, id: string): void {
  expect(w.server.quests.acceptFrom(w.conn, id)).toBeNull();
}

describe('quests: nothing is forced', () => {
  it('a new pilot gets no call: a few beginner jobs wait in the log as new leads, none taken', () => {
    const w = world();
    const { profile, last, t } = w;
    expect(Object.keys(profile().quests.active)).toEqual([]);
    expect(view(last)).toBeNull();
    const log = last('quests')!;
    const lead = log.leads.find((l) => l.id === 'main_01')!;
    expect(lead.state).toBe('available');
    expect(lead.who).toBe('Commander Vance');
    expect(lead.target?.station).toBe('Sol Central Station');
    expect(lead.fresh).toBe(true);
    for (const id of ['guild_01', 'drift_01']) expect(log.leads.some((l) => l.id === id), id).toBe(true);
    // Looking at the log clears the badge
    t.send({ type: 'questSeen' } as any);
    expect(last('quests')!.leads.some((l) => l.fresh)).toBe(false);
    expect(profile().quests.fresh).toBeUndefined();
  });

  it('talking to Commander Vance at Sol Central offers the first job: Not now leaves it, Accept takes it', () => {
    const w = world();
    const { server, pid, profile, last } = w;
    hangUp(w);
    // Not docked: he can't hear you
    away(server, pid);
    talk(w, 'vance');
    expect(view(last)).toBeNull();
    goTo(server, pid, 'sol_station_central');
    talk(w, 'vance');
    expect(view(last)!.who.name).toBe('Commander Vance');
    pick(w, /First Light/);
    expect(view(last)!.offer?.id).toBe('main_01');
    pick(w, /Not now/);
    expect(profile().quests.active.main_01).toBeUndefined();
    pick(w, /First Light/);
    pick(w, /Accept/);
    expect(profile().quests.active.main_01).toBeDefined();
    pick(w, /Goodbye/);
    expect(view(last)).toBeNull();
    const log = last('quests')!;
    expect(log.active[0].id).toBe('main_01');
    expect(log.active[0].steps[0].need).toBe(10);
    expect(log.leads.some((l) => l.id === 'main_01')).toBe(false);
  });

  it('only ore you mined counts as mining; loot does not', () => {
    const w = world();
    const { server, conn, profile } = w;
    take(w, 'main_01');
    away(server, conn.playerId);
    server.pilots.give(conn, { iron_ore: 6 }, { source: 'loot' });
    expect(profile().quests.active.main_01.progress).toBe(0);
    server.pilots.give(conn, { iron_ore: 4 }, { source: 'mined' });
    expect(profile().quests.active.main_01.progress).toBe(4);
  });

  it('chunks you break off yourself are tagged as mined when you collect them', () => {
    const w = world();
    const { server, pid, profile } = w;
    take(w, 'main_01');
    away(server, pid);
    const mining = (server as any).mining;
    mining.table = { ...files.mining, damagePerUnit: 12 }; // (the pace is mining.test.ts's business)
    const wd = server.getWorld();
    const rock = [...Array(8000).keys()].find((e) => bitecs.entityExists(wd, e) && bitecs.hasComponent(wd, Asteroid, e) && mining.get(e)?.hardness === 1 && mining.remaining(e) >= 15)!;
    for (let i = 0; i < 160; i++) mining.extract(rock, pid, 14, files.mining.tools.fixed, Position.x[pid] + 40, Position.y[pid], -1, 0);
    for (let i = 0; i < 240; i++) { Position.x[pid] = 40000; Position.y[pid] = 40000; Velocity.x[pid] = 0; Velocity.y[pid] = 0; server.step(); }
    const q = profile().quests.active.main_01;
    expect(q.stage > 0 || q.progress > 0).toBe(true);
  });

  it('finishing a job pays out and saves; nobody calls, the next job joins the log marked new', () => {
    const w = world();
    const { server, conn, pid, profile, last, t, got } = w;
    t.send({ type: 'questSeen' } as any);
    take(w, 'main_01');
    away(server, pid);
    const credits = profile().credits;
    server.pilots.give(conn, { iron_ore: 10 }, { source: 'mined' });
    expect(profile().quests.active.main_01.stage).toBe(1);
    goTo(server, pid, 'sol_station_central');
    expect(profile().quests.done).toContain('main_01');
    expect(profile().credits).toBe(credits + 30);
    expect(countOf(profile().storage, 'repair_kit')).toBeGreaterThanOrEqual(4);
    // A toast, not a conversation; the Prospector job is a new lead, and Vance offers it when you talk to him
    expect(view(last)).toBeNull();
    expect(got.some((m) => m.type === 'toast' && /Job complete: .*\+30 cr.*New work in your log/.test(m.text))).toBe(true);
    const lead = last('quests')!.leads.find((l) => l.id === 'main_02')!;
    expect(lead.fresh).toBe(true);
    expect(last('quests')!.finished.find((f) => f.id === 'main_01')?.outro).toBeTruthy();
    expect(profile().quests.active.main_02).toBeUndefined();
    talk(w, 'vance');
    pick(w, /Prospector/);
    expect(view(last)!.offer?.id).toBe('main_02');
    pick(w, /Accept/);
    expect(profile().quests.active.main_02).toBeDefined();
    expect(profile().quests.fresh ?? []).not.toContain('main_02');
  });

  it('the first job gives the Prospector plan; building it part by part and flying it is the second', () => {
    const w = world();
    const { server, conn, pid, profile, t, clock } = w;
    take(w, 'main_01');
    away(server, pid);
    server.pilots.give(conn, { iron_ore: 10 }, { source: 'mined', toStorage: true });
    goTo(server, pid, 'sol_station_central');
    expect(profile().plans).toContain('prospector');
    expect(profile().recipes).toContain('fn:core');
    take(w, 'main_02');
    const bp = server.getShips().library.get('prospector')!;
    t.send({ type: 'slotSave', slot: 1, blueprint: bp, plan: 'prospector' } as any);
    goTo(server, pid, 'sol_station_central');
    expect(profile().quests.active.main_02.stage).toBe(1);
    // Mine some more, then build everything
    server.pilots.give(conn, { iron_ore: 80, nickel_ore: 40, copper_ore: 20 }, { toStorage: true, quiet: true });
    t.send({ type: 'slotBuild', slot: 1 } as any);
    // Refined, fabricated and fitted, a step at a time
    for (let k = 0; k < 12 && profile().hangar[1]!.ghosts!.length; k++) {
      clock.t += 10 * 60 * 1000;
      for (let i = 0; i < 130; i++) server.step();
    }
    goTo(server, pid, 'sol_station_central');
    expect(profile().hangar[1]!.ghosts).toEqual([]);
    expect(profile().quests.active.main_02.stage).toBe(2);
    t.send({ type: 'slotFly', slot: 1 } as any);
    goTo(server, pid, 'sol_station_central');
    expect(profile().quests.done).toContain('main_02');
    // (Ships are not rewards: the Prospector is the one design a job hands out)
    expect(profile().plans).toEqual(['sparrow-t', 'prospector']);
  });

  it('any job can be abandoned: its own items go back, and its person offers it again', () => {
    const w = world();
    const { server, conn, t, profile, last } = w;
    profile().quests.done.push('main_01', 'main_02');
    profile().level = 3;
    take(w, 'osei_01');
    server.pilots.give(conn, { fractured_plating: 1 }, { source: 'quest' });
    t.send({ type: 'questAbandon', id: 'osei_01' } as any);
    expect(profile().quests.active.osei_01).toBeUndefined();
    expect(server.pilots.available(conn, 'fractured_plating')).toBe(0);
    expect(last('quests')!.leads.find((l) => l.id === 'osei_01')?.state).toBe('available');
  });
});

describe('quests: people and boards', () => {
  it('a station board posts bounties; the Guild foreman offers his own jobs, and deliver steps hand goods over at his station', () => {
    const w = world();
    const { server, pid, conn, profile, t, last } = w;
    hangUp(w);
    profile().quests.done.push('main_01');
    goTo(server, pid, 'sol_station_mining');
    t.send({ type: 'questBoard' } as any);
    const board = last('questBoard')!;
    expect(board.offers.map((o) => o.id)).not.toContain('guild_01');
    expect(board.offers.filter((o) => o.chain === 'bounty').length).toBeGreaterThan(0);
    // A person's job can't be taken off the board
    t.send({ type: 'questAccept', id: 'guild_01' } as any);
    expect(profile().quests.active.guild_01).toBeUndefined();

    talk(w, 'brannoch');
    pick(w, /Guild Dues/);
    pick(w, /Accept/);
    expect(profile().quests.active.guild_01).toBeDefined();
    pick(w, /Goodbye/);
    away(server, pid);
    server.pilots.give(conn, { iron_ore: 25, nickel_ore: 15 }, { source: 'mined', toStorage: true });
    expect(profile().quests.active.guild_01.stage).toBe(1);
    const iron = countOf(profile().cargo, 'iron_ore') + countOf(profile().storage, 'iron_ore');
    goTo(server, pid, 'sol_station_mining');
    expect(profile().quests.done).toContain('guild_01');
    expect(countOf(profile().cargo, 'iron_ore') + countOf(profile().storage, 'iron_ore')).toBe(iron - 20);
    expect(profile().reputation.miners).toBe(8);
  });

  it('jobs need the level: talking tells you about them anyway (a locked lead)', () => {
    const w = world();
    const { server, pid, profile, last, conn } = w;
    hangUp(w);
    profile().quests.done.push('main_01', 'guild_01', 'guild_02', 'guild_03');
    // (a lead shows once you're within a few levels of it)
    profile().level = 2;
    goTo(server, pid, 'sol_station_mining');
    talk(w, 'brannoch');
    expect(view(last)!.choices.some((c) => /Deep Seam/.test(c.text))).toBe(false);
    expect(view(last)!.lines.some((l) => /level 5/.test(l.text))).toBe(true);
    const lead = last('quests')!.leads.find((l) => l.id === 'guild_04')!;
    expect(lead.state).toBe('locked');
    expect(lead.needs).toContain('pilot level 5');
    expect(server.quests.acceptFrom(conn, 'guild_04')).toMatch(/level 5/);
    profile().level = 5;
    pick(w, /Goodbye/);
    talk(w, 'brannoch');
    pick(w, /Deep Seam/);
    pick(w, /Accept/);
    expect(profile().quests.active.guild_04).toBeDefined();
  });

  it('rumours: Merchant Joe tells you about a hermit, and she joins your log as a lead', () => {
    const w = world();
    const { server, pid, last, profile } = w;
    hangUp(w);
    goTo(server, pid, 'sol_station_trade');
    expect(profile().quests.known).not.toContain('kerr_01');
    talk(w, 'joe');
    pick(w, /rumours/);
    expect(profile().quests.known).toContain('kerr_01');
    const lead = last('quests')!.leads.find((l) => l.id === 'kerr_01')!;
    expect(lead.who).toBe('Sabine Kerr');
    expect(lead.target?.system).toBe('sol');
    expect(lead.target?.x).toBeDefined();
  });

  it('milestones: jobs another person has for you once one is finished join the log as new leads, with no call', () => {
    const w = world();
    const { server, conn, profile, last, t } = w;
    t.send({ type: 'questSeen' } as any);
    profile().quests.done.push('main_01');
    take(w, 'main_02');
    for (let i = 0; i < 8 && profile().quests.active.main_02; i++) server.quests.advanceStep(conn, 'main_02');
    expect(profile().quests.done).toContain('main_02');
    for (const id of ['osei_01', 'sw_01']) {
      expect(profile().quests.known, id).toContain(id);
      expect(last('quests')!.leads.find((l) => l.id === id)?.fresh, id).toBe(true);
    }
    // Levelling up rings nobody either
    server.pilots.addXp(conn, 5000);
    expect(view(last)).toBeNull();
    // Nor does a returning pilot whose save predates this: the follow-ups are put in the log on login
    profile().quests.known = profile().quests.known.filter((id) => id !== 'osei_01');
    server.quests.onLogin(conn);
    expect(profile().quests.known).toContain('osei_01');
    expect(view(last)).toBeNull();
  });

  it('refit steps check the ship you fly', () => {
    const w = world();
    const { server, pid, profile } = w;
    profile().quests.done.push('main_01', 'main_02');
    profile().level = 2;
    take(w, 'main_03');
    expect(profile().quests.active.main_03.stage).toBe(0);
    // The Sparrow has 13 parts: not enough
    for (let i = 0; i < 40; i++) server.step();
    expect(profile().quests.active.main_03.stage).toBe(0);
    const big = server.getShips().library.get('arrow')!;
    server.getShips().respawnInPlace(pid, big);
    for (let i = 0; i < 40; i++) server.step();
    expect(profile().quests.active.main_03.stage).toBe(1);
  });

  it('a refit step with a material counts only parts made of it (Ark-Heavy: leestone armour)', () => {
    const w = world();
    const { server, pid, profile } = w;
    profile().quests.done.push('main_01', 'ark_01', 'ark_02', 'ark_03', 'ark_04', 'ark_05');
    profile().level = 12;
    take(w, 'ark_06');
    // The job hands over the fitting licence and plate
    expect(profile().recipes).toContain('material:leestone');
    // Ten steel armour plates: armour enough, but not leestone
    const bulwark = server.getShips().library.get('bulwark')!;
    server.getShips().respawnInPlace(pid, bulwark);
    for (let i = 0; i < 40; i++) server.step();
    expect(profile().quests.active.ark_06.stage).toBe(0);
    const tender = server.getShips().library.get('ark-tender')!;
    server.getShips().respawnInPlace(pid, tender);
    for (let i = 0; i < 40; i++) server.step();
    expect(profile().quests.active.ark_06.stage).toBe(1);
  });
});

/** Sit at a point in a system for a moment (visit steps are checked twice a second) */
function hover(server: GameServer, pid: number, system: string, x: number, y: number): void {
  InSystem.systemId[pid] = server['gameData'].getSystemNum(system);
  for (let i = 0; i < 35; i++) { Position.x[pid] = x; Position.y[pid] = y; Velocity.x[pid] = 0; Velocity.y[pid] = 0; server.step(); }
}

describe('quests: lane clearance', () => {
  it("Sol's way out (the Cyan Rift) is closed until you have lane clearance", () => {
    const { server, pid, profile } = world();
    const gd = server['gameData'];
    const rift = files.systems.systems.find((s) => s.id === 'sol')!.rifts!.find((r) => r.destination.system === 'glasswater')!;
    const sol = gd.getSystemNum('sol');
    InSystem.systemId[pid] = sol;
    Position.x[pid] = rift.position.x; Position.y[pid] = rift.position.y;
    server.step();
    expect(InSystem.systemId[pid]).toBe(sol);
    profile().licences.push('outer_lanes');
    // Thrown out, it won't take you again until you've left it a while (rifts.test.ts): clear off, then fly back in
    Position.x[pid] = rift.position.x + 5000;
    for (let i = 0; i < 240; i++) server.step();
    for (let i = 0; i < 200 && InSystem.systemId[pid] === sol; i++) { Position.x[pid] = rift.position.x; Position.y[pid] = rift.position.y; server.step(); }
    expect(InSystem.systemId[pid]).toBe(gd.getSystemNum('glasswater'));
  });

  it("Cleared for Departure: the buoys (fieldTasks.test.ts), Lieutenant Achebe's questions (a wrong answer ends it), then Okafor", () => {
    const w = world();
    const { server, pid, profile, last } = w;
    hangUp(w);
    profile().quests.done.push('main_01', 'main_02', 'main_03');
    profile().level = 2;
    take(w, 'clearance');
    // The Constructor and the three buoys (fieldTasks.test.ts): past them
    profile().quests.active.clearance.stage = 4;
    hangUp(w);
    goTo(server, pid, 'sol_station_sentinel');
    talk(w, 'achebe');
    pick(w, /Cleared for Departure/);
    pick(w, /Turn and fight/);
    expect(view(last)!.choices.map((c) => c.text)).toEqual(['Goodbye.']);
    pick(w, /Goodbye/);
    expect(profile().quests.active.clearance.stage).toBe(4);
    talk(w, 'achebe');
    pick(w, /Cleared for Departure/);
    pick(w, /nearest station/);
    pick(w, /engines take/);
    pick(w, /Repair kits/);
    expect(profile().quests.active.clearance.stage).toBe(5);
    pick(w, /Goodbye/);
    goTo(server, pid, 'sol_station_central');
    talk(w, 'okafor');
    pick(w, /Cleared for Departure/);
    expect(profile().quests.done).toContain('clearance');
    expect(profile().licences).toContain('outer_lanes');
  });
});

describe('quests: Dr. Osei and steel', () => {
  it('steel opens at its level, Trial by Fire or not (no job or schematic teaches it early)', () => {
    const { profile } = world();
    expect(materialLicensed('steel', [], MATERIAL_LEVEL.steel - 1)).toBe(false);
    profile().quests.done.push('osei_03');
    expect(materialLicensed('steel', profile().recipes, MATERIAL_LEVEL.steel - 1)).toBe(false);
    expect(materialLicensed('steel', [], MATERIAL_LEVEL.steel)).toBe(true);
  });

  it("Dr. Osei is down on Terra Nova: fly close and press X to talk; she won't take what's left in storage", () => {
    const w = world();
    const { server, conn, pid, profile, last, t } = w;
    hangUp(w);
    profile().quests.done.push('main_01', 'main_02');
    profile().level = 3;
    take(w, 'osei_01');
    // The Kestrel's hull, then nickel
    const kestrel = server.gameData.getSystem('sol')!.derelicts!.find((d) => d.id === 'wreck_kestrel')!.position;
    hover(server, pid, 'sol', kestrel.x, kestrel.y);
    expect(profile().quests.active.osei_01.stage).toBe(1);
    expect(countOf(profile().cargo, 'fractured_plating')).toBe(1);
    hangUp(w);
    server.pilots.give(conn, { nickel_ore: 12 }, { source: 'mined', toStorage: true });
    expect(profile().quests.active.osei_01.stage).toBe(2);
    // Down to New Meridian
    hover(server, pid, 'terra_nova_surface', 1500, -1300);
    hangUp(w);
    t.send({ type: 'interact' } as any);
    expect(view(last)!.who.name).toBe('Dr. Imani Osei');
    pick(w, /Brittle Alloys/);
    // The nickel is in station storage: no use down here
    expect(view(last)!.lines.some((l) => /hold/.test(l.text))).toBe(true);
    expect(profile().quests.active.osei_01.stage).toBe(2);
    pick(w, /Goodbye/);
    // Carry it down
    goTo(server, pid, 'sol_station_central');
    t.send({ type: 'itemMove', id: 'nickel_ore', n: 12, to: 'cargo' } as any);
    hover(server, pid, 'terra_nova_surface', 1500, -1300);
    t.send({ type: 'interact' } as any);
    pick(w, /Brittle Alloys/);
    expect(profile().quests.done).toContain('osei_01');
    expect(countOf(profile().cargo, 'fractured_plating')).toBe(0);
  });

  it("Old Pell has to be won over; the job's crucible is only in your fabricator while you need it", () => {
    const w = world();
    const { server, pid, profile, last } = w;
    hangUp(w);
    profile().quests.done.push('main_01', 'main_02', 'main_03', 'clearance', 'osei_01');
    profile().licences.push('outer_lanes');
    profile().level = 4;
    take(w, 'osei_02');
    profile().quests.active.osei_02.stage = 3;
    goTo(server, pid, 'glasswater_station_relay');
    talk(w, 'pell');
    pick(w, /Crucible Pattern/);
    pick(w, /Nobody/);
    pick(w, /Goodbye/);
    expect(profile().quests.active.osei_02.stage).toBe(3);
    talk(w, 'pell');
    pick(w, /Crucible Pattern/);
    pick(w, /Dr\. Osei/);
    pick(w, /pay you/);
    pick(w, /Goodbye/);
    expect(profile().quests.active.osei_02.stage).toBe(3);
    talk(w, 'pell');
    pick(w, /Crucible Pattern/);
    pick(w, /Dr\. Osei/);
    pick(w, /Kestrel/);
    expect(profile().quests.active.osei_02.stage).toBe(4);
    expect(server.pilots.available(w.conn, 'crucible_pattern')).toBe(1);
    expect(profile().recipes).toContain('field_crucible');
    void last;
  });

  it("Trial by Fire: telling her you're ready sends you to your own copy of the Deep Foundry, and the Warden's death is the job's", () => {
    const w = world();
    const { server, pid, conn, profile, last } = w;
    hangUp(w);
    profile().quests.done.push('main_01', 'main_02', 'main_03', 'clearance', 'osei_01', 'osei_02');
    profile().licences.push('outer_lanes');
    profile().level = 5;
    take(w, 'osei_03');
    profile().quests.active.osei_03.stage = 1;
    // She's at Shardfall now
    goTo(server, pid, 'glasswater_station_depot');
    talk(w, 'osei');
    pick(w, /Trial by Fire/);
    pick(w, /ready/i);
    const gd = server['gameData'];
    const copies = gd.getSystemInstances('halcyon_foundry');
    expect(copies).toContain(InSystem.systemId[pid]);
    const num = InSystem.systemId[pid];
    const boss = server.bosses.inSystem(num)[0];
    expect(boss).toBeDefined();
    expect(server.bosses.of(boss)?.id).toBe('boss_foundry_warden');
    // Nobody else's fight
    expect(server.bosses.isAlive('boss_foundry_warden')).toBe(false);
    const bridge = server.getShips();
    const ship = bridge.get(boss)!;
    Position.x[pid] = Position.x[boss] + 600; Position.y[pid] = Position.y[boss];
    bridge.hurt(boss, ship, 0, 10, pid);
    const core = ship.blueprint.parts.findIndex((q) => q.fn === 'core');
    bridge.hurt(boss, ship, core, 1e9, pid);
    for (let i = 0; i < 5; i++) server.step();
    expect(profile().quests.active.osei_03.stage).toBe(2);
    // Lifted back to orbit over Halcyon a few seconds later
    for (let i = 0; i < 9 * 60; i++) { Position.x[pid] = 0; Position.y[pid] = 3000; server.step(); }
    expect(InSystem.systemId[pid]).toBe(gd.getSystemNum('glasswater'));
    hangUp(w);
    goTo(server, pid, 'glasswater_station_depot');
    talk(w, 'osei');
    pick(w, /Trial by Fire/);
    expect(profile().quests.done).toContain('osei_03');
    // (Her reward is plate and standing now: steel opens at its level for everyone)
    expect(profile().recipes).not.toContain('material:steel');
    void conn; void last;
  });
});

describe('quests: Cold Iron (Forgemaster Hale)', () => {
  it('Hale presses test crates of Quench Slugs from your cryogen and steel; after six Cult ships, the pattern is yours', () => {
    const w = world();
    const { server, conn, pid, profile, last } = w;
    hangUp(w);
    profile().quests.done.push('main_10');
    profile().level = 25;
    goTo(server, pid, 'cinder_station_forge');
    talk(w, 'hale');
    pick(w, /Cold Iron/);
    pick(w, /accept|take|I'll|yes/i);
    hangUp(w);
    expect(profile().quests.active.cinder_quench).toBeDefined();
    server.pilots.give(conn, { cryogen: 4, steel_plate: 8 });
    talk(w, 'hale');
    pick(w, /Cold Iron/);
    hangUp(w);
    expect(profile().quests.active.cinder_quench.stage).toBe(1);
    expect(server.pilots.available(conn, 'railgun_quench')).toBe(2);
    expect(server.pilots.available(conn, 'cryogen')).toBe(0);
    // Not taught yet: only the job's own crates
    expect(profile().recipes).not.toContain('railgun_quench');
    profile().quests.active.cinder_quench.stage = 2;
    talk(w, 'hale');
    pick(w, /Cold Iron/);
    expect(profile().quests.done).toContain('cinder_quench');
    expect(profile().recipes).toContain('railgun_quench');
    void last;
  });

  it("the job's kill step wants the Cult, in Cinder Reach", () => {
    const q = files.quests.quests.find((x: any) => x.id === 'cinder_quench')! as any;
    expect(q.person).toBe('hale');
    expect(q.requires).toEqual(['main_10']);
    expect(q.steps.find((s: any) => s.type === 'kill')).toMatchObject({ faction: 'cinder', system: 'cinder_reach' });
    // (and the recipe it teaches is the job's: nobody else teaches it)
    const r = files.recipes.craft.find((x: any) => x.id === 'railgun_quench')! as any;
    expect(r.quest).toBe('cinder_quench');
    expect(files.quests.quests.filter((x: any) => x.rewards?.recipes?.includes('railgun_quench')).map((x: any) => x.id)).toEqual(['cinder_quench']);
  });
});

describe('quests: bounties', () => {
  it('bounties are the same for everyone in a window and rebuild from their id', () => {
    const ctx = { station: { id: 'sol_station_central', name: 'Sol Central', system: 'sol' }, danger: 1, factions: ['pirates'], ores: ['iron_ore'] };
    const a = bountyIds('sol_station_central', 5_000_000);
    expect(bountyIds('sol_station_central', 5_000_001)).toEqual(a);
    expect(bountyDef(a[0], ctx)).toEqual(bountyDef(a[0], ctx));
    expect(bountyIds('sol_station_central', 5_000_000 + 31 * 60_000)).not.toEqual(a);
  });

  it('every bounty and quest only asks for and gives things that exist', () => {
    const { server } = world();
    const items = server.econ.items;
    const check = (q: ReturnType<typeof bountyDef>) => {
      for (const st of q!.steps) {
        if ('item' in st && st.item) expect(items.has(st.item), `${q!.id} ${st.item}`).toBe(true);
        if (st.type === 'deliver') for (const id of Object.keys(st.items)) expect(items.has(id), `${q!.id} ${id}`).toBe(true);
      }
      for (const id of Object.keys(q!.rewards.items ?? {})) expect(items.has(id), `${q!.id} reward ${id}`).toBe(true);
      for (const f of q!.rewards.plans ?? []) expect(server.getShips().library.has(f), `${q!.id} plan ${f}`).toBe(true);
      // Ships are not rewards: only the first job hands out a design (the Prospector, for the build tutorial)
      expect(q!.rewards.plans ?? [], `${q!.id} plans`).toEqual(q!.id === 'main_01' ? ['prospector'] : []);
    };
    for (const q of server.quests.file.quests) check(q);
    const kinds = new Set<string>();
    for (const st of files.stations.stations) {
      for (let w = 0; w < 30; w++) {
        const ids = bountyIds(st.id, w * 30 * 60_000 + 5);
        const defs = ids.map((id) => server.quests.def(id)!);
        expect(new Set(defs.map((q) => q.name)).size, 'a board never repeats a kind').toBe(defs.length);
        defs.forEach((q) => { check(q); kinds.add(q.name); });
      }
    }
    expect(kinds.size).toBeGreaterThanOrEqual(5);
  });

  it('kill bounties count kills of their faction in their system', () => {
    const { server, pid, conn, profile, t, last, clock } = world();
    goTo(server, pid, 'sol_station_central');
    // Find a window whose board has a kill bounty
    let id: string | undefined;
    for (let k = 0; k < 40 && !id; k++) {
      clock.t += 30 * 60_000;
      t.send({ type: 'questBoard' } as any);
      id = last('questBoard')!.offers.find((o) => o.chain === 'bounty' && /Destroy/.test(o.steps[0].text))?.id;
    }
    expect(id).toBeDefined();
    t.send({ type: 'questAccept', id } as any);
    const def = server.quests.def(id!)!;
    const step = def.steps[0] as { faction: string; count: number };
    server.quests.onKill(conn, 'x', 'not_them', 'sol');
    expect(profile().quests.active[id!].progress).toBe(0);
    const credits = profile().credits;
    for (let i = 0; i < step.count; i++) server.quests.onKill(conn, 'x', step.faction, 'sol');
    expect(profile().quests.active[id!]).toBeUndefined();
    expect(profile().credits).toBeGreaterThan(credits);
  });
});

describe('licences and skills', () => {
  it('the Maw is sealed until the story licenses you: its rift throws you back', () => {
    const { server, pid, profile } = world();
    const w = server.getWorld();
    const mawNum = server['gameData'].getSystemNum('the_maw');
    // Its rift is in the Void Sector
    InSystem.systemId[pid] = server['gameData'].getSystemNum('void_sector');
    const rift = [...Array(8000).keys()].find((e) => bitecs.entityExists(w, e) && bitecs.hasComponent(w, Portal, e) && Portal.kind[e] === 1 && Portal.targetSystem[e] === mawNum && InSystem.systemId[e] === InSystem.systemId[pid])!;
    expect(rift).toBeDefined();
    const sol = InSystem.systemId[pid];
    Position.x[pid] = Position.x[rift]; Position.y[pid] = Position.y[rift];
    server.step();
    expect(InSystem.systemId[pid]).toBe(sol);
    profile().licences.push('the_maw');
    // Clear of the rift a while, then back in (it won't take you while you sit in it after a throw)
    Position.x[pid] = Position.x[rift] + 5000;
    for (let i = 0; i < 240; i++) server.step();
    for (let i = 0; i < 200 && InSystem.systemId[pid] === sol; i++) { Position.x[pid] = Position.x[rift]; Position.y[pid] = Position.y[rift]; server.step(); }
    expect(InSystem.systemId[pid]).toBe(mawNum);
  });

  it('skill points buy skills: navigation adds cargo space', () => {
    const { server, conn, profile, t } = world();
    const before = server.pilots.cargoCapacity(conn);
    t.send({ type: 'skillUp', skill: 'navigation' } as any);
    expect(profile().skills.navigation).toBeUndefined(); // no points yet
    profile().skillPoints = 2;
    t.send({ type: 'skillUp', skill: 'navigation' } as any);
    t.send({ type: 'skillUp', skill: 'navigation' } as any);
    expect(profile().skills.navigation).toBe(2);
    expect(profile().skillPoints).toBe(0);
    expect(server.pilots.cargoCapacity(conn)).toBeGreaterThan(before);
  });

  it('a level-up names what it unlocked (models, materials, room) and what comes next, in a toast and the chat', () => {
    const { server, conn, profile, got } = world();
    server.pilots.addXp(conn, xpToReach(12) - profile().xp);
    expect(profile().level).toBe(12);
    expect(profile().skillPoints).toBe(11);
    const toast = [...got].reverse().find((m) => m.type === 'toast' && /^Level 12!/.test((m as any).text)) as any;
    expect(toast.text).toMatch(/\+11 skill points/);
    for (const name of ['Twinlink', 'Reactive Armour', 'Titanium structure', 'Steel structure', 'Hammer', 'Build points']) expect(toast.text).toContain(name);
    expect(toast.text).toMatch(/Next: Needle and Flash Screen at Lv 13$/);
    const line = [...got].reverse().find((m) => m.type === 'systemMessage' && /^Level 12/.test((m as any).text)) as any;
    expect(line.text).toContain('Unlocked: ');
    expect(line.text).toContain('Next: Needle and Flash Screen at Lv 13.');
  });

  it('levels give skill points only until every skill could be full (60)', () => {
    const { server, conn, profile, got } = world();
    profile().skills = { mining: 20, engineering: 20, navigation: 18 };
    profile().skillPoints = 1;
    server.pilots.addXp(conn, xpToReach(5) - profile().xp);
    expect(profile().level).toBe(5);
    expect(profile().skillPoints).toBe(2);
    const toast = [...got].reverse().find((m) => m.type === 'toast' && /^Level 5!/.test((m as any).text)) as any;
    expect(toast.text).toMatch(/\+1 skill point \(/);
    server.pilots.addXp(conn, xpToReach(7) - profile().xp);
    expect(profile().skillPoints).toBe(2);
    expect(([...got].reverse().find((m) => m.type === 'toast' && /^Level 7!/.test((m as any).text)) as any).text).not.toMatch(/skill point/);
    // Jobs' points stop there too
    server.pilots.grant(conn, { skillPoints: 3 });
    expect(profile().skillPoints).toBe(2);
  });

  it('standing tops out at the top rank: Exalted is reachable', () => {
    const { server, conn, profile } = world();
    server.pilots.grant(conn, { reputation: { traders: 80 } });
    server.pilots.grant(conn, { reputation: { traders: 80 } });
    expect(profile().reputation.traders).toBe(REP_MAX);
    expect(repRank(profile().reputation.traders).name).toBe(REP_RANKS[REP_RANKS.length - 1].name);
  });
});

describe('reveals', () => {
  it('a job with a reveal stays out of the log until its condition holds, then joins it quietly as a new lead', () => {
    const base = files.quests.quests.find((q: any) => q.person && !q.starter)!;
    const hidden = { ...base, id: 'test_hidden_cache', name: 'A Hidden Cache', level: 1, requires: [], reveal: { all: [{ level: 3 }, { has: { iron_ore: 5 } }] } };
    const quests = { ...files.quests, quests: [...files.quests.quests, hidden] };
    resetGlobals();
    const server = new GameServer({
      profileStore: new MemoryProfileStore(), gameData: new GameData({ ...files, quests } as any),
      userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as any,
      scene: 'sectors', autoStart: false, ships: createShipBridge(loadShipConfigFromDisk(dataDir)),
    });
    const t = new LocalTransport(server);
    t.connect();
    t.send({ type: 'join', username: 'pilot' } as any);
    const conn = server.pilots.connOf(t.getPlayerId())!;
    const p = () => server.pilots.get(conn)!;
    // Out in space, away from the station (its storage counts as to hand there)
    Position.x[t.getPlayerId()] = 52000; Position.y[t.getPlayerId()] = 30000;
    server.step();
    expect(p().quests.known).not.toContain('test_hidden_cache');
    server.pilots.addXp(conn, 2000);
    expect(p().level).toBeGreaterThanOrEqual(3);
    expect(p().quests.known).not.toContain('test_hidden_cache');
    server.pilots.give(conn, { iron_ore: 5 }, { source: 'mined' });
    expect(p().quests.known).toContain('test_hidden_cache');
    expect(p().quests.fresh).toContain('test_hidden_cache');
  });
});

describe('rumours', () => {
  it('a station has a rumour of a hidden job nearby; doing the thing finds it', () => {
    const { server, conn, profile } = world();
    const p = profile();
    p.quests.done.push('main_01', 'drift_01', 'drift_02');
    expect(p.quests.known).not.toContain('drift_03');
    server.quests.rumourAt(conn, 'sol_station_sentinel', 'sol', 1);
    expect(p.quests.rumours).toContain('drift_03');
    // One a day
    server.quests.rumourAt(conn, 'sol_station_sentinel', 'sol', 1);
    expect(p.quests.rumours!.length).toBe(1);
    for (let i = 0; i < 20; i++) server.pilots.bumpStat(conn, 'kills:scrapborn');
    expect(p.quests.known).toContain('drift_03');
    expect(p.quests.rumours ?? []).not.toContain('drift_03');
  });
});

describe('quests: the v5 ship wipe', () => {
  /** A v4 save on account 9: Sparrow in slot 1, a built Prospector in slot 2 (flown when `flyProspector`), these jobs in progress */
  async function wiped(active: Record<string, { stage: number; progress: number }>, flyProspector = false) {
    const store = new MemoryProfileStore();
    const w = world(undefined, store);
    const base = JSON.parse(JSON.stringify(w.profile()));
    const prospector = { blueprint: JSON.parse(JSON.stringify(w.server.getShips().library.get('prospector'))), hp: {}, ghosts: [], plan: 'prospector' };
    const hangar = [base.ship, prospector, null, null, null];
    await store.save(9, {
      ...base, version: 4, xp: 2000, hangar, ship: hangar[flyProspector ? 1 : 0], activeSlot: flyProspector ? 1 : 0, plans: ['sparrow-t', 'prospector'],
      quests: { active, done: ['main_01', ...(active.main_03 ? ['main_02'] : [])], known: ['main_01', 'main_02', 'main_03'], flags: ['starter_bonds'] },
    });
    (w.conn as any).userId = 9;
    await w.server.pilots.login(w.conn, 9);
    return w;
  }

  it('main_02 part-way (its Prospector wiped) goes back to starting the Prospector, and can be finished from there', async () => {
    for (const stage of [1, 2]) {
      const w = await wiped({ main_02: { stage, progress: 0 } }, stage === 2);
      const { profile, t, server, pid, got } = w;
      expect(profile().version).toBe(5);
      expect(profile().hangar[1]).toBeNull();
      expect(profile().ship.plan).toBe('sparrow-t');
      expect(profile().quests.active.main_02.stage).toBe(0);
      expect(profile().plans).toContain('prospector');
      // The refund notice, once, and gone from the save
      expect(got.some((m) => m.type === 'toast' && /new power core/.test((m as any).text))).toBe(true);
      expect(profile().notices).toBeUndefined();
      // Start it again: on to the build step
      t.send({ type: 'slotSave', slot: 1, blueprint: server.getShips().library.get('prospector')!, plan: 'prospector' } as any);
      goTo(server, pid, 'sol_station_central');
      expect(profile().quests.active.main_02.stage).toBe(1);
    }
  });

  it('main_03 keeps its place: the refit step checks the ship flown now, the kills keep their count', async () => {
    let w = await wiped({ main_03: { stage: 0, progress: 0 } });
    expect(w.profile().quests.active.main_03).toEqual(expect.objectContaining({ stage: 0 }));
    w = await wiped({ main_03: { stage: 1, progress: 2 } });
    expect(w.profile().quests.active.main_03).toEqual(expect.objectContaining({ stage: 1, progress: 2 }));
  });
});
