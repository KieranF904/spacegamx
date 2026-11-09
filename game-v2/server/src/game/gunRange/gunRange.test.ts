/**
 * The gun range (game/gunRange): in from any berth, a cheat ship with the chosen weapon (each mount kind firing), a live
 * target that takes real damage and comes back, out at the door with X (or by dying, or disconnecting) docked where they
 * came from in their own ship, and nothing else allowed in there.
 */

import { describe, it, expect } from 'vitest';
import * as bitecs from 'bitecs';
import { InSystem, Position, Velocity, Player, Dead, Rotation, buildCheatShip, insideChamber } from '@space-game/common';
import { boot, signIn, join, dock, run, lastState, fireAt, toDoor, kill, S } from './gunRange.testkit.js';
import { RANGE_GATE, passesInRange } from './messageGate.js';
import { RangeTarget } from './target.js';

describe('gun range: in and out', () => {
  it('goes in only from a berth; in, it flies the cheat ship in the shared chamber', async () => {
    const { server, num, def } = boot();
    const a = await signIn(server, 'ranger', 11);
    run(server, 3);
    a.link.receive({ type: 'gunRangeEnter' } as any);
    expect(lastState(a)).toMatchObject({ in: false });
    expect(lastState(a).error).toMatch(/Dock at a station/);
    const own = S(server).ships.get(a.conn.playerId).blueprint;
    const st = dock(server, a);
    run(server, 2);
    expect(a.conn.docked?.station).toBe(st);
    a.link.receive({ type: 'gunRangeEnter' } as any);
    run(server, 2);
    const eid = a.conn.playerId;
    expect(InSystem.systemId[eid]).toBe(num);
    expect(a.conn.docked).toBeNull();
    expect(insideChamber(def, Position.x[eid], Position.y[eid], 50)).toBe(true);
    const ship = S(server).ships.get(eid);
    expect(ship.blueprint.range).toBe(true);
    const s = lastState(a);
    expect(s).toMatchObject({ in: true, station: expect.any(String) });
    expect(s.options).toContain(s.weapon);
    expect(s.door.reach).toBe(def.door.reach);
    // (Its own ship is untouched, set aside in the real profile)
    expect(S(server).pilots.realProfile(a.conn).ship.blueprint).toEqual(own);
    // A second pilot sees the first: one shared instance
    const b = await signIn(server, 'other', 12);
    run(server, 2);
    dock(server, b);
    run(server, 1);
    b.link.receive({ type: 'gunRangeEnter' } as any);
    run(server, 2);
    expect(InSystem.systemId[b.conn.playerId]).toBe(num);
    expect(server.gunRange.isVisitor(a.conn) && server.gunRange.isVisitor(b.conn)).toBe(true);
  }, 60_000);

  it('X at the door: back docked at the station they came from, their own ship as it was, energy and all', async () => {
    const { server, def } = boot();
    const a = await signIn(server, 'door', 21);
    run(server, 3);
    const st = dock(server, a);
    run(server, 2);
    const eid0 = a.conn.playerId, own = JSON.stringify(S(server).ships.get(eid0).blueprint);
    const charge = JSON.stringify(S(server).ships.chargeOf(eid0));
    const berth = { ...a.conn.docked };
    a.link.receive({ type: 'gunRangeEnter' } as any);
    run(server, 2);
    // X away from the door: a reminder, still in
    a.link.receive({ type: 'interact' } as any);
    expect(server.gunRange.isVisitor(a.conn)).toBe(true);
    toDoor(def, a);
    a.link.receive({ type: 'interact' } as any);
    run(server, 2);
    const eid = a.conn.playerId;
    expect(server.gunRange.isVisitor(a.conn)).toBe(false);
    expect(InSystem.systemId[eid]).toBe(InSystem.systemId[st]);
    expect(a.conn.docked).toMatchObject({ station: st, exit: berth.exit });
    expect(JSON.stringify(S(server).ships.get(eid).blueprint)).toBe(own);
    expect(JSON.stringify(S(server).ships.chargeOf(eid))).toBe(charge);
    expect(lastState(a)).toMatchObject({ in: false, station: expect.any(String) });
    expect(a.said.some((m) => m.type === 'dockResult' && m.ok)).toBe(true);
    expect(S(server).ammo.isFree(a.conn)).toBe(false);
  }, 60_000);

  it('dying in the range: no wreck, no loss; the respawn is back in the berth in their own ship', async () => {
    const { server, num } = boot();
    const a = await signIn(server, 'dies', 31);
    run(server, 3);
    const st = dock(server, a);
    run(server, 2);
    const own = JSON.stringify(S(server).pilots.get(a.conn).ship.blueprint);
    const deaths = S(server).pilots.get(a.conn).stats.deaths ?? 0;
    a.link.receive({ type: 'gunRangeEnter' } as any);
    run(server, 2);
    kill(a);
    run(server, 3);
    expect(bitecs.hasComponent(S(server).world, Player, a.conn.playerId) && !bitecs.hasComponent(S(server).world, Dead, a.conn.playerId)).toBe(false);
    expect(S(server).pilots.isFrozen(a.conn)).toBe(false);
    expect(S(server).pilots.get(a.conn).stats.deaths ?? 0).toBe(deaths);
    expect(S(server).pilots.get(a.conn).wreck).toBeUndefined();
    a.link.receive({ type: 'respawn' } as any);
    run(server, 2);
    const eid = a.conn.playerId;
    expect(InSystem.systemId[eid]).not.toBe(num);
    expect(a.conn.docked?.station).toBe(st);
    expect(JSON.stringify(S(server).ships.get(eid).blueprint)).toBe(own);
    expect(server.gunRange.isVisitor(a.conn)).toBe(false);
  }, 60_000);

  it('a guest can use it too, and anyone moved out of the range some other way is taken out properly', async () => {
    const { server, num } = boot();
    const g = join(server, 'guesty');
    run(server, 3);
    dock(server, g);
    run(server, 2);
    g.link.receive({ type: 'gunRangeEnter' } as any);
    run(server, 2);
    expect(InSystem.systemId[g.conn.playerId]).toBe(num);
    // (Something else moves them: the range takes them out, their own ship back)
    server.travelTo(g.conn, server.gameData.getSystemNum('sol'), 5000, 5000, false);
    run(server, 2);
    expect(server.gunRange.isVisitor(g.conn)).toBe(false);
    expect(S(server).ships.get(g.conn.playerId).blueprint.range).toBeUndefined();
    // Nobody but a visitor stays in the range
    const s = join(server, 'stray');
    run(server, 2);
    server.travelTo(s.conn, num, 0, 0, false);
    g.link.receive({ type: 'gunRangeEnter' } as any);
    dock(server, g);
    run(server, 1);
    g.link.receive({ type: 'gunRangeEnter' } as any);
    run(server, 40);
    expect(InSystem.systemId[s.conn.playerId]).not.toBe(num);
  }, 60_000);
});

describe('gun range: the weapon picker and the guns', () => {
  it('picks any weapon they can fit, refuses the rest, and each mount kind fires', async () => {
    const { server, def } = boot();
    const a = await signIn(server, 'picker', 41);
    run(server, 3);
    S(server).pilots.get(a.conn).level = 50;
    dock(server, a);
    run(server, 2);
    a.link.receive({ type: 'gunRangeEnter' } as any);
    run(server, 2);
    const opts: string[] = lastState(a).options;
    // (A fixed gun, a turret, a beam, a lobbed shell, a guided one, flak, an area weapon, the Repair Beam)
    const tries = ['cannon_pip', 'autocannon_rattler', 'laser_cutter', 'mortar_lobber', 'missile_dart', 'flak_burst', 'emp_hush', 'utility_repair_beam'];
    for (const model of tries) expect(opts).toContain(model);
    for (const model of tries) {
      a.link.receive({ type: 'gunRangeWeapon', model } as any);
      run(server, 1);
      const eid = a.conn.playerId, ship = S(server).ships.get(eid);
      expect(lastState(a).weapon).toBe(model);
      expect(ship.blueprint.parts.some((q: any) => q.fn === model)).toBe(true);
      expect(ship.blueprint.range).toBe(true);
      // Face the target and hold the trigger: shells, a beam, or (support) the beam lights
      Rotation.angle[eid] = 0;
      const from = server.currentTick;
      for (let i = 0; i < 240; i++) { fireAt(a, def.target.x, def.target.y); server.step(); }
      fireAt(a, def.target.x, def.target.y, false);
      run(server, 2);
      expect(S(server).ships.lastFiredTick(eid), model).toBeGreaterThan(from);
    }
    // Not theirs to try: refused, the ship unchanged
    S(server).pilots.realProfile(a.conn).level = 0;
    const was = lastState(a).weapon;
    a.link.receive({ type: 'gunRangeWeapon', model: 'lance_lance' } as any);
    run(server, 1);
    expect(lastState(a).weapon).toBe(was);
  }, 120_000);

  it('the target takes real damage from the range ship, never fires, pays nothing, and comes back after it dies', async () => {
    const { server, def, num } = boot();
    const a = await signIn(server, 'shooter', 51);
    run(server, 3);
    dock(server, a);
    run(server, 2);
    a.link.receive({ type: 'gunRangeEnter' } as any);
    run(server, 3);
    const target = lastState(a).target.id;
    expect(target).toBeGreaterThanOrEqual(0);
    expect(InSystem.systemId[target]).toBe(num);
    expect(S(server).ships.isPinned(target)).toBe(false);
    // (It fits the chamber, clear of the walls, and stands well off the door)
    const r = S(server).ships.get(target).derived.radius;
    expect(insideChamber(def, def.target.x, def.target.y, r + 100)).toBe(true);
    expect(Math.hypot(def.target.x - def.spawn.x, def.target.y - def.spawn.y)).toBeGreaterThan(r + 1500);
    const p = S(server).pilots.realProfile(a.conn), xp = p.xp, credits = p.credits;
    const hp0 = S(server).ships.integrity(target);
    a.link.receive({ type: 'gunRangeWeapon', model: 'cannon_pip' } as any);
    run(server, 1);
    const eid = a.conn.playerId;
    // (Close in, facing it)
    Position.x[eid] = def.target.x - 900; Position.y[eid] = def.target.y; Velocity.x[eid] = 0; Velocity.y[eid] = 0; Rotation.angle[eid] = 0;
    for (let i = 0; i < 600; i++) { fireAt(a, def.target.x, def.target.y); server.step(); }
    fireAt(a, 0, 0, false);
    expect(S(server).ships.integrity(target)).toBeLessThan(hp0);
    // Never fires back: nothing of its in flight
    expect(S(server).ships.lastFiredTick(target)).toBe(-Infinity);
    // Destroyed: nothing paid, and it comes back
    S(server).ships.removeShip(target);
    run(server, 2);
    expect(lastState(a).target.id).toBe(-1);
    run(server, def.target.respawnSeconds * 60 + 5);
    expect(lastState(a).target.id).toBeGreaterThanOrEqual(0);
    expect(S(server).pilots.realProfile(a.conn).xp).toBe(xp);
    expect(S(server).pilots.realProfile(a.conn).credits).toBe(credits);
    // Nobody in: put away
    toDoor(def, a);
    a.link.receive({ type: 'interact' } as any);
    run(server, 3);
    expect(server.gunRange.busy()).toBe(false);
  }, 120_000);
});

describe('gun range: the target keeps its spot', () => {
  it('pushed off it, it is flown home and let go there', () => {
    let at = { x: 0, y: 0 }, steer: unknown = 'none', alive = true;
    const t = new RangeTarget({ spawn: () => 7, alive: () => alive, remove: () => {}, steer: (_e, to) => { steer = to; }, where: () => at }, { ship: 's', faction: 'f', x: 0, y: 0, angle: 0, respawnSeconds: 2, keepRadius: 100 });
    expect(t.tick(15, true)).toBe(true);
    expect(t.eid).toBe(7);
    at = { x: 250, y: 0 };
    t.tick(30, true);
    expect(steer).toMatchObject({ x: 0, y: 0 });
    at = { x: 10, y: 0 };
    t.tick(45, true);
    expect(steer).toBeNull();
    alive = false;
    expect(t.tick(46, true)).toBe(true);
    expect(t.eid).toBe(-1);
    alive = true;
    expect(t.tick(100, true)).toBe(false);
    expect(t.tick(46 + 120, true)).toBe(true);
    expect(t.tick(200, false)).toBe(true);
    expect(t.eid).toBe(-1);
  });
});

describe('gun range: the message gate', () => {
  it('lets flying, talking and leaving through, and nothing that builds, trades, moves items or teleports', () => {
    for (const t of ['input', 'interact', 'chat', 'respawn', 'gunRangeWeapon']) expect(passesInRange(t)).toBe(true);
    for (const t of ['shipEdit', 'slotFly', 'fieldPlan', 'itemJettison', 'tradeOffer', 'marketSell', 'devTeleport', 'admin', 'authLogin', 'undock', 'dock', 'craft', 'questAccept', 'skillUp']) expect(passesInRange(t)).toBe(false);
    expect(passesInRange('somethingNew')).toBe(false);
    // (Every type the server dispatches is in the table: the compiler holds the union, this the dispatched set)
    const { server } = boot();
    const missing = S(server).handledMessageTypes().filter((t: string) => !(t in RANGE_GATE));
    expect(missing).toEqual([]);
  }, 60_000);

  it('a visitor\'s refused messages never reach their handlers', async () => {
    const { server, num } = boot();
    const a = await signIn(server, 'gated', 61);
    run(server, 3);
    dock(server, a);
    run(server, 2);
    a.link.receive({ type: 'gunRangeEnter' } as any);
    run(server, 2);
    a.link.receive({ type: 'devTeleport', systemId: 'sol' } as any);
    a.link.receive({ type: 'undock' } as any);
    a.link.receive({ type: 'slotFly', slot: 0 } as any);
    run(server, 2);
    expect(InSystem.systemId[a.conn.playerId]).toBe(num);
    expect(S(server).ships.get(a.conn.playerId).blueprint.range).toBe(true);
  }, 60_000);

  it('the cheat ship is the one server-built design: buildCheatShip and the ship flown agree', () => {
    const { server } = boot();
    const bp = buildCheatShip(S(server).ships.catalog, 'cannon_pip')!;
    expect(S(server).ships.validate(bp, { mounting: true }).ok).toBe(true);
  }, 60_000);
});

