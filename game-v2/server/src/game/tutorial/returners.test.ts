/**
 * A pilot saved before the training yard goes in as a returner (game/pilots/returners.ts): a training ship flies the yard while their own
 * ship and state are set aside whole (and saved whole, beside the training profile); leaving at any step, or graduating, puts them back
 * exactly as they were with no starter pack, and it never happens twice. New pilots keep the usual flow (tutorial.test.ts).
 */
import { describe, it, expect } from 'vitest';
import { Position, InSystem, newProfile, cloneJson, type PlayerProfile } from '@space-game/common';
import { GameServer } from '../../GameServer.js';
import { MemoryProfileStore } from '../../profile/ProfileStore.js';
import { makeServer, resetGlobals } from '../../testkits/world.testkit.js';
import { takeKept } from '../pilots/session.js';
import { join, signIn, run, settle, S, type Pilot } from '../gunRange/gunRange.testkit.js';

const ACCOUNT = 41;

/** The saved profile of an old pilot: a hold, storage, money, a second ship, and no tutorial block at all */
function oldPilot(server: GameServer): PlayerProfile {
  const p = newProfile(server.starterKit());
  p.credits = 4321;
  p.cargo = [{ id: 'iron_ore', n: 5 }];
  p.storage = [{ id: 'copper_ore', n: 17 }];
  p.ship.blueprint.name = 'Old Faithful';
  p.hangar[1] = { blueprint: cloneJson(p.ship.blueprint), hp: {}, ghosts: [] };
  p.hangar[1]!.blueprint.name = 'Spare';
  p.position = { system: 'sol', x: 60000, y: 20000 };
  delete (p as Partial<PlayerProfile>).tutorial;
  return p;
}

function boot(): { server: GameServer; store: MemoryProfileStore } {
  resetGlobals();
  const store = new MemoryProfileStore();
  return { server: makeServer({ profileStore: store, tutorial: true, clock: () => 1_000_000 }), store };
}

/** The real profile as the document holds it: all but the training profile, the timestamp, the repair bank (made on any login) and the tutorial block */
const real = (doc: any) => { const { yard: _y, updatedAt: _u, tutorial: _t, bank: _b, ...rest } = doc; return rest; };

async function seed(): Promise<{ server: GameServer; store: MemoryProfileStore; pilot: Pilot }> {
  const { server, store } = boot();
  await store.save(ACCOUNT, oldPilot(server));
  const pilot = await signIn(server, 'vet', ACCOUNT);
  run(server, 3);
  return { server, store, pilot };
}

const profileOf = (server: GameServer, p: Pilot): PlayerProfile => S(server).pilots.get(p.conn);
const away = (server: GameServer, p: Pilot): PlayerProfile | undefined => S(server).pilots.away.get(p.conn);
const saved = async (server: GameServer, store: MemoryProfileStore, p: Pilot): Promise<any> => { S(server).pilots.saveNow(p.conn); await settle(); return store.load(ACCOUNT); };

describe('returning pilots in the training yard', () => {
  it('login: in the yard on a training ship, their own ship and state set aside untouched in the save', async () => {
    const { server, store, pilot } = await seed();
    const yardNum = server.gameData.getSystemNum(server.tutorial!.data.yard.system);
    expect(InSystem.systemId[pilot.conn.playerId]).toBe(yardNum);
    expect(server.tutorial!.active(pilot.conn)).toBe(true);
    const play = profileOf(server, pilot);
    expect(play.ship.blueprint.name).not.toBe('Old Faithful');
    expect(play.credits).not.toBe(4321);
    expect(play.tutorial.returner).toBe(true);
    // The save holds the real profile whole and the training one under it
    const doc = await saved(server, store, pilot);
    expect(doc.ship.blueprint.name).toBe('Old Faithful');
    expect(doc.credits).toBe(4321);
    expect(doc.cargo).toEqual([{ id: 'iron_ore', n: 5 }]);
    expect(doc.storage).toEqual([{ id: 'copper_ore', n: 17 }]);
    expect(doc.hangar[1].blueprint.name).toBe('Spare');
    expect(doc.position).toEqual({ system: 'sol', x: 60000, y: 20000 });
    expect(doc.yard.tutorial).toMatchObject({ left: false, returner: true });
    expect(doc.tutorial).toMatchObject({ left: true, unseen: true });
    // (what the session holds aside is that same real profile)
    expect(real(JSON.parse(JSON.stringify(away(server, pilot))))).toEqual(real(doc));
  });

  it('leave at the first step: the real ship, place, hold, storage, hangar and credits back; no starter pack; never again', async () => {
    const { server, store, pilot } = await seed();
    const before = cloneJson(away(server, pilot)!);
    expect(server.tutorial!.leave(pilot.conn)).toBe(true);
    run(server, 3);
    const now = profileOf(server, pilot);
    expect(real(JSON.parse(JSON.stringify(now)))).toEqual(real(JSON.parse(JSON.stringify(before))));
    expect(now.ship.blueprint.name).toBe('Old Faithful');
    expect(now.credits).toBe(4321);
    expect(now.storage).toEqual([{ id: 'copper_ore', n: 17 }]);
    expect(now.tutorial).toMatchObject({ left: true });
    expect(now.tutorial.unseen).toBeUndefined();
    expect(server.tutorial!.active(pilot.conn)).toBe(false);
    expect(S(server).pilots.isAway(pilot.conn)).toBe(false);
    // Back where they were
    expect(InSystem.systemId[pilot.conn.playerId]).toBe(server.gameData.getSystemNum('sol'));
    expect(Position.x[pilot.conn.playerId]).toBeCloseTo(60000, -1);
    expect(Position.y[pilot.conn.playerId]).toBeCloseTo(20000, -1);
    const doc = await saved(server, store, pilot);
    expect(doc.yard).toBeUndefined();
    expect(doc.tutorial.unseen).toBeUndefined();
    expect(doc.credits).toBe(4321);
    // Not again: a second leave does nothing, and a new login stays in Sol
    expect(server.tutorial!.leave(pilot.conn)).toBe(false);
    pilot.link.close();
    run(server, 2);
    await settle();
    const again = await signIn(server, 'vet', ACCOUNT);
    run(server, 3);
    expect(server.tutorial!.active(again.conn)).toBe(false);
    expect(profileOf(server, again).ship.blueprint.name).toBe('Old Faithful');
  });

  it('leave at a middle step (with training gear granted and the yard mined): exact restore, none of it kept', async () => {
    const { server, store, pilot } = await seed();
    const before = cloneJson(away(server, pilot)!);
    const tut = server.tutorial!;
    for (const id of tut.data.steps.slice(0, 4).map((s) => s.id)) tut.completeStep(pilot.conn, id);
    tut.grant(pilot.conn, { iron_ore: 9 });
    expect(profileOf(server, pilot).storage.length).toBeGreaterThan(0);
    expect(tut.leave(pilot.conn)).toBe(true);
    run(server, 3);
    const now = profileOf(server, pilot);
    expect(real(JSON.parse(JSON.stringify(now)))).toEqual(real(JSON.parse(JSON.stringify(before))));
    expect(now.storage).toEqual([{ id: 'copper_ore', n: 17 }]);
    expect(now.cargo).toEqual([{ id: 'iron_ore', n: 5 }]);
    const doc = await saved(server, store, pilot);
    expect(real(doc)).toEqual(real(JSON.parse(JSON.stringify(before))));
  });

  it('graduating restores the same way: no starter pack', async () => {
    const { server, pilot } = await seed();
    const tut = server.tutorial!;
    const ids = tut.data.steps.map((s) => s.id);
    for (const id of ids.slice(0, -1)) tut.completeStep(pilot.conn, id);
    expect(tut.leave(pilot.conn)).toBe(true);
    const now = profileOf(server, pilot);
    expect(now.credits).toBe(4321);
    expect(now.storage).toEqual([{ id: 'copper_ore', n: 17 }]);
    expect(now.ship.blueprint.name).toBe('Old Faithful');
  });

  it('reconnect mid-yard: the same step, the real profile still set aside and saved whole', async () => {
    const { server, store, pilot } = await seed();
    const tut = server.tutorial!;
    tut.completeStep(pilot.conn, tut.data.steps[0].id);
    const step = profileOf(server, pilot).tutorial.step;
    pilot.link.close();
    run(server, 2);
    await settle();
    const doc = await store.load(ACCOUNT) as any;
    expect(doc.ship.blueprint.name).toBe('Old Faithful');
    expect(doc.yard.tutorial.step).toBe(step);
    const again = await signIn(server, 'vet', ACCOUNT);
    run(server, 3);
    expect(tut.active(again.conn)).toBe(true);
    expect(profileOf(server, again).tutorial.step).toBe(step);
    expect(profileOf(server, again).tutorial.returner).toBe(true);
    expect(away(server, again)!.ship.blueprint.name).toBe('Old Faithful');
    expect(away(server, again)!.credits).toBe(4321);
    // (and leaving then still restores it)
    expect(tut.leave(again.conn)).toBe(true);
    expect(profileOf(server, again).credits).toBe(4321);
  });

  it('a server restart mid-yard (save, new server, load): the real profile and the visit both survive', async () => {
    const { server, store, pilot } = await seed();
    const tut = server.tutorial!;
    tut.completeStep(pilot.conn, tut.data.steps[0].id);
    tut.grant(pilot.conn, { iron_ore: 3 });
    const step = profileOf(server, pilot).tutorial.step;
    const trained = cloneJson(profileOf(server, pilot).storage);
    await S(server).pilots.saveAll();
    await settle();
    // (a second server over the same store: nothing in memory carried over)
    resetGlobals();
    const server2 = makeServer({ profileStore: store, tutorial: true, clock: () => 1_000_000 });
    const back = await signIn(server2, 'vet', ACCOUNT);
    run(server2, 3);
    expect(server2.tutorial!.active(back.conn)).toBe(true);
    expect(profileOf(server2, back).tutorial.step).toBe(step);
    expect(profileOf(server2, back).storage).toEqual(trained);
    expect(away(server2, back)!.credits).toBe(4321);
    expect(away(server2, back)!.ship.blueprint.name).toBe('Old Faithful');
    expect(server2.tutorial!.leave(back.conn)).toBe(true);
    const now = profileOf(server2, back);
    expect(now.ship.blueprint.name).toBe('Old Faithful');
    expect(now.cargo).toEqual([{ id: 'iron_ore', n: 5 }]);
    expect(now.storage).toEqual([{ id: 'copper_ore', n: 17 }]);
  });

  it('a new pilot (no save) keeps the usual flow: the yard on their own profile, the starter pack on leaving', async () => {
    const { server } = boot();
    const p = await signIn(server, 'fresh', 99);
    run(server, 3);
    expect(S(server).pilots.isAway(p.conn)).toBe(false);
    expect(server.tutorial!.active(p.conn)).toBe(true);
    expect(profileOf(server, p).storage).toEqual([]);
    expect(server.tutorial!.leave(p.conn)).toBe(true);
    const pack = server.tutorial!.data.starterPack;
    expect(profileOf(server, p).credits).toBe(300 + pack.credits);
    expect(profileOf(server, p).storage.length).toBeGreaterThan(0);
  });

  it('a pilot who already left (a saved tutorial block) is never sent in', async () => {
    const { server, store } = boot();
    const old = oldPilot(server);
    old.tutorial = { step: '', done: ['welcome'], left: true };
    await store.save(ACCOUNT, old);
    const p = await signIn(server, 'vet', ACCOUNT);
    run(server, 3);
    expect(server.tutorial!.active(p.conn)).toBe(false);
    expect(S(server).pilots.isAway(p.conn)).toBe(false);
    expect(profileOf(server, p).ship.blueprint.name).toBe('Old Faithful');
  });

  it('a server with no yard leaves an old pilot as they are, still unseen', async () => {
    resetGlobals();
    const store = new MemoryProfileStore();
    const server = makeServer({ profileStore: store, tutorial: false, clock: () => 1_000_000 });
    await store.save(ACCOUNT, oldPilot(server));
    const p = await signIn(server, 'vet', ACCOUNT);
    run(server, 3);
    expect(S(server).pilots.isAway(p.conn)).toBe(false);
    expect(profileOf(server, p).ship.blueprint.name).toBe('Old Faithful');
    expect(profileOf(server, p).tutorial.unseen).toBe(true);
  });

  it('guests with a kept pre-yard profile are sent in the same way', async () => {
    const { server } = boot();
    const g = join(server, 'wanderer');
    run(server, 2);
    const s = S(server).pilots.sessions.get(g.conn);
    const old = oldPilot(server);
    expect(takeKept(S(server).pilots, s, JSON.parse(JSON.stringify(old)))).toBe(true);
    expect(S(server).pilots.isAway(g.conn)).toBe(true);
    expect(server.tutorial!.active(g.conn)).toBe(true);
    expect(server.tutorial!.leave(g.conn)).toBe(true);
    expect(profileOf(server, g).ship.blueprint.name).toBe('Old Faithful');
  });
});
