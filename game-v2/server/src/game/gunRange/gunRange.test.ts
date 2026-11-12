/**
 * The gun range (game/gunRange): in from any berth, a cheat ship with the chosen weapon (each mount kind firing), a live
 * target that takes real damage and comes back, out at the door with X (or by disconnecting) docked where they came
 * from in their own ship, dying there a respawn at the door in the same cheat ship, and nothing else allowed in there.
 */

import { describe, it, expect } from 'vitest';
import * as bitecs from 'bitecs';
import { InSystem, Position, Velocity, Player, Dead, Rotation, buildCheatShip, exitDoor, insideChamber } from '@space-game/common';
import { boot, signIn, join, dock, run, lastState, fireAt, toDoor, kill, heavyOf, settle, S } from './gunRange.testkit.js';
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
    expect(s.door.reach).toBe(exitDoor(def).reach);
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

  it('dying in the range: no wreck, no loss; the respawn is back at the door in the same cheat ship and weapon', async () => {
    const { server, num, def } = boot();
    const a = await signIn(server, 'dies', 31);
    run(server, 3);
    const st = dock(server, a);
    run(server, 2);
    const own = JSON.stringify(S(server).pilots.get(a.conn).ship.blueprint);
    const p0 = S(server).pilots.get(a.conn), deaths = p0.stats.deaths ?? 0, bank = JSON.stringify(p0.bank ?? null), cargo = JSON.stringify(p0.cargo);
    a.link.receive({ type: 'gunRangeEnter' } as any);
    run(server, 2);
    const first = lastState(a).weapon;
    a.link.receive({ type: 'gunRangeWeapon', model: lastState(a).options.find((o: string) => o !== first) } as any);
    run(server, 2);
    const ship0 = JSON.stringify(S(server).ships.get(a.conn.playerId).blueprint);
    const weapon = lastState(a).weapon;
    kill(a);
    run(server, 3);
    expect(bitecs.hasComponent(S(server).world, Player, a.conn.playerId) && !bitecs.hasComponent(S(server).world, Dead, a.conn.playerId)).toBe(false);
    // (The real profile stays frozen: no wreck, no death counted, no bank spent, no cargo lost)
    expect(S(server).pilots.isFrozen(a.conn)).toBe(true);
    expect(server.gunRange.isVisitor(a.conn)).toBe(true);
    for (let i = 0; i < 3; i++) {
      a.link.receive({ type: 'respawn' } as any);
      run(server, 3);
      const eid = a.conn.playerId, at = def.spawn;
      expect(InSystem.systemId[eid]).toBe(num);
      expect(Math.hypot(Position.x[eid] - at.x, Position.y[eid] - at.y)).toBeLessThan(500);
      expect(a.conn.docked).toBeNull();
      expect(JSON.stringify(S(server).ships.get(eid).blueprint)).toBe(ship0);
      expect(S(server).ships.get(eid).blueprint.range).toBe(true);
      expect(lastState(a)).toMatchObject({ in: true, weapon });
      expect(S(server).ammo.isFree(a.conn)).toBe(true);
      expect(S(server).pilots.isFrozen(a.conn)).toBe(true);
      // Still a working gun
      const from = server.currentTick;
      for (let t = 0; t < 120; t++) { fireAt(a, def.targets[0].x, def.targets[0].y); server.step(); }
      fireAt(a, 0, 0, false);
      expect(S(server).ships.lastFiredTick(eid)).toBeGreaterThan(from);
      kill(a);
      run(server, 3);
    }
    const p1 = S(server).pilots.realProfile(a.conn);
    expect(p1.stats.deaths ?? 0).toBe(deaths);
    expect(p1.wreck).toBeUndefined();
    expect(JSON.stringify(p1.bank ?? null)).toBe(bank);
    expect(JSON.stringify(p1.cargo)).toBe(cargo);
    // Only the door takes them back: their own ship, docked where they came from
    a.link.receive({ type: 'respawn' } as any);
    run(server, 3);
    toDoor(def, a);
    a.link.receive({ type: 'interact' } as any);
    run(server, 3);
    const eid = a.conn.playerId;
    expect(InSystem.systemId[eid]).not.toBe(num);
    expect(a.conn.docked?.station).toBe(st);
    expect(JSON.stringify(S(server).ships.get(eid).blueprint)).toBe(own);
    expect(server.gunRange.isVisitor(a.conn)).toBe(false);
    expect(S(server).ammo.isFree(a.conn)).toBe(false);
  }, 120_000);

  it('dead and disconnecting in the range: the real profile is back and nothing was lost', async () => {
    const { server, store } = boot();
    const a = await signIn(server, 'dc', 32);
    run(server, 3);
    dock(server, a);
    run(server, 3);
    S(server).pilots.saveNow(a.conn);
    await settle();
    const before = JSON.stringify((await store.load(32)).ship);
    a.link.receive({ type: 'gunRangeEnter' } as any);
    run(server, 2);
    kill(a);
    run(server, 3);
    a.link.close();
    run(server, 3);
    await settle();
    expect(JSON.stringify((await store.load(32)).ship)).toBe(before);
    expect(server.gunRange.isVisitor(a.conn)).toBe(false);
    expect(S(server).pilots.isFrozen(a.conn)).toBe(false);
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
  it('picks any weapon whatever their level, refuses what is no range weapon, and each mount kind fires', async () => {
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
      for (let i = 0; i < 240; i++) { fireAt(a, heavyOf(def).x, heavyOf(def).y); server.step(); }
      fireAt(a, heavyOf(def).x, heavyOf(def).y, false);
      run(server, 2);
      expect(S(server).ships.lastFiredTick(eid), model).toBeGreaterThan(from);
    }
    // A new pilot may try a weapon far above their level; a thing that is no weapon model is refused, the ship unchanged
    S(server).pilots.realProfile(a.conn).level = 0;
    a.link.receive({ type: 'gunRangeWeapon', model: 'lance_lance' } as any);
    run(server, 1);
    expect(lastState(a).weapon).toBe('lance_lance');
    for (const model of ['power_cell_reactor', 'no_such_gun']) {
      a.link.receive({ type: 'gunRangeWeapon', model } as any);
      run(server, 1);
      expect(lastState(a).weapon).toBe('lance_lance');
    }
  }, 120_000);

  it('every target stands in the chamber, unpinned and clear of the walls, never fires, stays put, and gives nothing', async () => {
    const { server, def, num } = boot();
    const a = await signIn(server, 'shooter', 51);
    run(server, 3);
    dock(server, a);
    run(server, 2);
    a.link.receive({ type: 'gunRangeEnter' } as any);
    run(server, 3);
    const ts: { id: number; x: number; y: number; label: string }[] = lastState(a).targets;
    expect(ts).toHaveLength(def.targets.length);
    expect(ts.map((t) => t.label)).toEqual(def.targets.map((t) => t.label));
    expect(def.targets.map((t) => t.label)).toEqual(expect.arrayContaining(['Drone · weak', 'Hulk · weak hull', 'Mammoth · heavy']));
    expect(new Set(ts.map((t) => t.id)).size).toBe(ts.length);
    const p = S(server).pilots.realProfile(a.conn), xp = p.xp, credits = p.credits;
    // (A mob target is no ship: it is laid at its spot, a live mob of its kind)
    const mobs = S(server).mobs, isShip = (i: number) => !def.targets[i].mob;
    expect(def.targets.some((t) => t.mob)).toBe(true);
    ts.forEach((t, i) => {
      const d = def.targets[i];
      expect(t.id, d.label).toBeGreaterThanOrEqual(0);
      expect(InSystem.systemId[t.id]).toBe(num);
      if (d.mob) {
        expect(mobs.has(t.id), d.label).toBe(true);
        expect(Math.hypot(Position.x[t.id] - d.x, Position.y[t.id] - d.y), d.label).toBeLessThan(2);
        expect(insideChamber(def, d.x, d.y, 200), d.label).toBe(true);
        return;
      }
      expect(S(server).ships.isPinned(t.id)).toBe(false);
      expect(S(server).ships.get(t.id).blueprint.range).toBeUndefined();
      // (It fits the chamber, clear of the walls, and stands well off the door)
      const r = S(server).ships.get(t.id).derived.radius;
      expect(insideChamber(def, d.x, d.y, r + 100), d.label).toBe(true);
      expect(Math.hypot(d.x - def.spawn.x, d.y - def.spawn.y), d.label).toBeGreaterThan(r + 600);
      // (No shield: a low-level gun reaches its hull)
      expect(S(server).ships.get(t.id).blueprint.parts.some((q: any) => q.fn === 'shield'), d.label).toBe(false);
    });
    // Standing: still where they were put after a long while, and nobody has fired a shot
    run(server, 1200);
    ts.forEach((t, i) => {
      if (!isShip(i)) return;
      expect(Math.hypot(Position.x[t.id] - def.targets[i].x, Position.y[t.id] - def.targets[i].y), def.targets[i].label).toBeLessThan(def.targets[i].keepRadius + 5);
      expect(S(server).ships.lastFiredTick(t.id)).toBe(-Infinity);
    });
    // They keep clear of each other while standing
    for (let i = 0; i < ts.length; i++) for (let j = i + 1; j < ts.length; j++) {
      if (!isShip(i) || !isShip(j)) continue;
      const r = S(server).ships.get(ts[i].id).derived.radius + S(server).ships.get(ts[j].id).derived.radius;
      expect(Math.hypot(Position.x[ts[i].id] - Position.x[ts[j].id], Position.y[ts[i].id] - Position.y[ts[j].id])).toBeGreaterThan(r + 50);
    }
    // The hulk is big and soft: more parts than the drone by far, each with a fraction of the heavy's HP (its faction's scrapborn hull)
    const by = (label: string) => ts.findIndex((t) => t.label === label);
    const parts = (i: number) => S(server).ships.get(ts[i].id).blueprint.parts.length;
    const hull = (i: number) => Math.max(...S(server).ships.get(ts[i].id).maxHp);
    expect(parts(by('Hulk · weak hull'))).toBeGreaterThan(parts(by('Drone · weak')) * 5);
    expect(hull(by('Hulk · weak hull'))).toBeLessThan(hull(by('Mammoth · heavy')) / 2);
    // Destroyed (as a kill would be): nothing paid, each comes back whole after its pause, the others undisturbed
    // (A mine has timed out and been laid again meanwhile, as its kind does: the ids as they stand now)
    const up: { id: number }[] = lastState(a).targets;
    expect(up.every((t, i) => (isShip(i) ? t.id === ts[i].id : mobs.has(t.id)))).toBe(true);
    const gone = up.map((t) => t.id);
    up.forEach((t, i) => (isShip(i) ? S(server).ships.removeShip(t.id) : mobs.hurt(t.id, 1e9)));
    run(server, 2);
    expect(lastState(a).targets.map((t: any) => t.id)).toEqual(ts.map(() => -1));
    run(server, Math.max(...def.targets.map((t) => t.respawnSeconds)) * 60 + 10);
    const back: { id: number }[] = lastState(a).targets;
    expect(back.every((t) => t.id >= 0)).toBe(true);
    expect(S(server).ships.integrity(back[0].id)).toBe(1);
    expect(gone.length).toBe(back.length);
    expect(S(server).pilots.realProfile(a.conn).xp).toBe(xp);
    expect(S(server).pilots.realProfile(a.conn).credits).toBe(credits);
    // One at a time: only the one destroyed is down in the meantime
    S(server).ships.removeShip(back[0].id);
    run(server, 2);
    expect(lastState(a).targets.map((t: any) => t.id >= 0)).toEqual(back.map((_, i) => i !== 0));
    // Nobody in: all put away
    toDoor(def, a);
    a.link.receive({ type: 'interact' } as any);
    run(server, 3);
    expect(server.gunRange.busy()).toBe(false);
  }, 180_000);

  it('a Pip takes a drone down in a handful of shots, chews the weak hulk, and the Mammoth shrugs it off', async () => {
    const { server, def } = boot();
    const a = await signIn(server, 'pip', 52);
    run(server, 3);
    dock(server, a);
    run(server, 2);
    a.link.receive({ type: 'gunRangeEnter' } as any);
    run(server, 3);
    a.link.receive({ type: 'gunRangeWeapon', model: 'cannon_pip' } as any);
    run(server, 1);
    const eid = a.conn.playerId, ts: { id: number }[] = lastState(a).targets;
    const idx = (label: string) => def.targets.findIndex((t) => t.label === label);
    const burst = (i: number, ticks: number) => {
      const d = def.targets[i], id = ts[i].id;
      Position.x[eid] = d.x - 450 - d.ring; Position.y[eid] = d.y; Velocity.x[eid] = 0; Velocity.y[eid] = 0; Rotation.angle[eid] = 0;
      let n = 0;
      for (let t = 0; t < ticks && S(server).ships.has(id) && S(server).ships.integrity(id) > 0; t++) { fireAt(a, d.x, d.y); server.step(); n++; }
      fireAt(a, 0, 0, false);
      return n;
    };
    // A drone: Pip fires every 20 ticks, so ticks/20 is shots
    const d0 = ts[idx('Drone · weak')].id;
    const ticks = burst(idx('Drone · weak'), 900);
    expect(S(server).ships.has(d0) && S(server).ships.integrity(d0) > 0, 'drone still up').toBe(false);
    expect(Math.ceil(ticks / 20)).toBeLessThanOrEqual(12);
    // The hulk loses a good share of its hull in the same 10 seconds; the Mammoth hardly any
    const hulk = ts[idx('Hulk · weak hull')].id, mam = ts[idx('Mammoth · heavy')].id;
    const h0 = S(server).ships.integrity(hulk), m0 = S(server).ships.integrity(mam);
    burst(idx('Hulk · weak hull'), 600);
    const hulkLost = h0 - S(server).ships.integrity(hulk);
    burst(idx('Mammoth · heavy'), 600);
    const mamLost = m0 - S(server).ships.integrity(mam);
    expect(hulkLost).toBeGreaterThan(0);
    expect(hulkLost).toBeGreaterThan(mamLost * 3);
  }, 180_000);
});

describe('gun range: a target keeps its spot', () => {
  it('pushed off it, it is flown home and let go there', () => {
    let at = { x: 0, y: 0 }, steer: unknown = 'none', alive = true;
    const t = new RangeTarget({ spawn: () => 7, alive: () => alive, remove: () => {}, steer: (_e, to) => { steer = to; }, where: () => at }, { label: 'T', ship: 's', faction: 'f', ring: 100, x: 0, y: 0, angle: 0, respawnSeconds: 2, keepRadius: 100 });
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
    for (const t of ['shipEdit', 'slotFly', 'fieldPlan', 'itemJettison', 'tradeOffer', 'marketSell', 'devTeleport', 'admin', 'undock', 'dock', 'craft', 'questAccept', 'skillUp']) expect(passesInRange(t)).toBe(false);
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

