/**
 * The gun range's rooms and an admin's library ships (game/gunRange/GunRange.ts). A pilot comes into the first room and
 * goes to another only through the door that leads there (X at it, as at the exit), in the ship they are flying, arriving
 * inside the door that leads back: only the room they are in has its targets up, and its state is the only one they are
 * sent. X away from every door does nothing; no message changes room. The dark room's crowd stands packed but apart. Only an admin is sent the ship library or
 * may fly a ship of it, and nothing of that reaches the real profile either.
 */

import { describe, it, expect } from 'vitest';
import { InSystem, Position, Rotation, insideChamber, doorTo, rangeDoor, rangeDoorAt, type GunRangeRoomDef } from '@space-game/common';
import { boot, signIn, dock, run, settle, states, lastState, toDoor, kill, S, type Pilot } from './gunRange.testkit.js';
import type { GameServer } from '../../GameServer.js';

/** A saved profile, but for what may change: when it was saved, and where (the station they came from, as it moves) */
const strip = (p: any) => { const { updatedAt: _u, position, ...rest } = p; return { ...rest, system: position?.system }; };

async function inRange(server: GameServer, name: string, id: number, admin: boolean, level?: number): Promise<Pilot> {
  const a = await signIn(server, name, id);
  a.conn.isAdmin = admin;
  run(server, 3);
  if (level) S(server).pilots.get(a.conn).level = level;
  dock(server, a);
  run(server, 2);
  a.link.receive({ type: 'gunRangeEnter' } as any);
  run(server, 3);
  return a;
}

/** To the room's door that leads to `to`, and X */
function through(server: GameServer, room: GunRangeRoomDef, p: Pilot, to: string): void {
  toDoor(room, p, doorTo(room, to));
  p.link.receive({ type: 'interact' } as any);
  run(server, 3);
}

const blueprintOf = (server: GameServer, p: Pilot) => S(server).ships.get(p.conn.playerId).blueprint;

describe('gun range: rooms', () => {
  it('in at the first room; through the door to the next keeps the ship, weapon and modifiers, and only the room in use has targets', async () => {
    const { server, rooms, num } = boot();
    expect(rooms.map((r) => r.id)).toEqual(['targets', 'dark']);
    const [first, dark] = rooms;
    const a = await inRange(server, 'roomer', 61, false, 50);
    const eid = a.conn.playerId;
    expect(lastState(a)).toMatchObject({ in: true, room: 'targets' });
    // (In at the exit door, the one way out; the way on is across the room)
    expect(rangeDoorAt(first, Position.x[eid], Position.y[eid])).toBeUndefined();
    expect(Math.hypot(Position.x[eid] - first.spawn.x, Position.y[eid] - first.spawn.y)).toBeLessThan(400);
    expect(insideChamber(first, Position.x[eid], Position.y[eid], 50)).toBe(true);
    expect(lastState(a).targets).toHaveLength(first.targets.length);
    const firstIds: number[] = lastState(a).targets.map((t: any) => t.id);
    expect(firstIds.every((id) => id >= 0)).toBe(true);
    // (Nothing stands in the dark room while nobody is in it)
    const shipsIn = (room: typeof dark) => [...S(server).ships.bodies.keys()].filter((e: number) => e !== eid && InSystem.systemId[e] === num && insideChamber(room, Position.x[e], Position.y[e]));
    expect(shipsIn(dark)).toHaveLength(0);

    a.link.receive({ type: 'gunRangeWeapon', model: 'laser_glint', mods: ['explosive', 'burn'] } as any);
    run(server, 2);
    const weapon = lastState(a).weapon, ship = JSON.stringify(blueprintOf(server, a));
    expect(lastState(a)).toMatchObject({ weapon: 'laser_glint', mods: ['explosive', 'burn'] });

    // ---- X near neither door: nothing (still here, still in); and no message changes room (the old one is no message now)
    Position.x[eid] = first.centre.x; Position.y[eid] = first.centre.y + 2600;
    a.link.receive({ type: 'interact' } as any);
    a.link.receive({ type: 'gunRangeRoom', room: 'dark' } as any);
    run(server, 3);
    expect(lastState(a)).toMatchObject({ in: true, room: 'targets' });
    expect(Math.hypot(Position.x[eid] - first.centre.x, Position.y[eid] - first.centre.y - 2600)).toBeLessThan(60);
    expect(server.handledMessageTypes()).not.toContain('gunRangeRoom');

    // ---- through the door to the dark room: inside its door back, facing in, the same ship, its crowd up, the first room's targets put away
    through(server, first, a, 'dark');
    expect(a.conn.playerId).toBe(eid);
    expect(InSystem.systemId[eid]).toBe(num);
    expect(insideChamber(dark, Position.x[eid], Position.y[eid], 50)).toBe(true);
    const back = doorTo(dark, 'targets')!, bd = rangeDoor(dark, back);
    expect(Math.hypot(Position.x[eid] - bd.x, Position.y[eid] - bd.y)).toBeLessThan(back.reach);
    expect(rangeDoorAt(dark, Position.x[eid], Position.y[eid])).toBe(back);
    expect(Math.cos(Rotation.angle[eid]) * bd.nx + Math.sin(Rotation.angle[eid]) * bd.ny).toBeGreaterThan(0.9);
    expect(lastState(a)).toMatchObject({ in: true, room: 'dark', weapon, mods: ['explosive', 'burn'] });
    expect(JSON.stringify(blueprintOf(server, a))).toBe(ship);
    expect(S(server).pilots.isFrozen(a.conn)).toBe(true);
    const crowd: { id: number; x: number; y: number }[] = lastState(a).targets;
    expect(crowd).toHaveLength(dark.targets.length);
    expect(crowd.length).toBeGreaterThanOrEqual(12);
    expect(crowd.every((t) => t.id >= 0)).toBe(true);
    expect(firstIds.every((id) => !S(server).ships.has(id) && !S(server).mobs.has(id))).toBe(true);
    expect(shipsIn(first)).toHaveLength(0);
    // (The door in the state is this room's, and X works at it, not at the first room's)
    expect(rangeDoorAt(dark, lastState(a).door.x + 100, lastState(a).door.y)?.to).toBe('exit');

    // ---- the crowd: a dozen and more small hulls of several kinds, packed but not touching, clear of the walls
    const radius = (id: number) => S(server).ships.get(id).derived.radius as number;
    expect(new Set(dark.targets.map((t) => t.ship)).size).toBeGreaterThanOrEqual(6);
    let nearest = Infinity;
    for (let i = 0; i < crowd.length; i++) {
      expect(insideChamber(dark, crowd[i].x, crowd[i].y, radius(crowd[i].id) + 100)).toBe(true);
      expect(radius(crowd[i].id)).toBeLessThan(90);
      for (let j = i + 1; j < crowd.length; j++) {
        const d = Math.hypot(crowd[i].x - crowd[j].x, crowd[i].y - crowd[j].y), gap = d - radius(crowd[i].id) - radius(crowd[j].id);
        expect(gap, `${i} and ${j}`).toBeGreaterThan(0);
        nearest = Math.min(nearest, gap);
      }
    }
    expect(nearest).toBeLessThan(80);
    // (Standing: after a while each is still at its spot, nobody shoved out by a neighbour)
    run(server, 300);
    crowd.forEach((t, i) => expect(Math.hypot(Position.x[t.id] - t.x, Position.y[t.id] - t.y), `crowd ${i}`).toBeLessThan(dark.targets[i].keepRadius + 5));
    // (One destroyed comes back on its clock, like any target)
    S(server).ships.removeShip(crowd[0].id);
    run(server, 2);
    expect(lastState(a).targets[0].id).toBe(-1);
    run(server, dark.targets[0].respawnSeconds * 60 + 10);
    expect(lastState(a).targets[0].id).toBeGreaterThanOrEqual(0);

    // ---- dying here (at the door back, X does nothing for the dead): the respawn is at this room's exit door
    kill(a);
    run(server, 3);
    a.link.receive({ type: 'interact' } as any);
    run(server, 2);
    a.link.receive({ type: 'respawn' } as any);
    run(server, 3);
    const now = a.conn.playerId;
    expect(lastState(a)).toMatchObject({ in: true, room: 'dark', weapon });
    expect(Math.hypot(Position.x[now] - dark.spawn.x, Position.y[now] - dark.spawn.y)).toBeLessThan(400);

    // ---- back through the door to the first room: inside its door to the dark room, the same ship again, the crowd put away
    through(server, dark, a, 'targets');
    expect(lastState(a)).toMatchObject({ in: true, room: 'targets', weapon, mods: ['explosive', 'burn'] });
    expect(rangeDoorAt(first, Position.x[now], Position.y[now])).toBe(doorTo(first, 'dark'));
    expect(JSON.stringify(blueprintOf(server, a))).toBe(ship);
    expect(lastState(a).targets).toHaveLength(first.targets.length);
    expect(shipsIn(dark)).toHaveLength(0);

    // ---- out by the exit door: back docked, the range empty
    toDoor(first, a);
    a.link.receive({ type: 'interact' } as any);
    run(server, 3);
    expect(lastState(a)).toMatchObject({ in: false });
    expect(InSystem.systemId[a.conn.playerId]).not.toBe(num);
    expect(server.gunRange.busy()).toBe(false);
  }, 180_000);

  it('two pilots in two rooms: each room has its targets up, and each pilot is told of their own room only', async () => {
    const { server, rooms } = boot();
    const [first, dark] = rooms;
    const a = await inRange(server, 'near', 62, false), b = await inRange(server, 'far', 63, false);
    through(server, first, b, 'dark');
    expect(lastState(a).targets.map((t: any) => t.label)).toEqual(first.targets.map((t) => t.label));
    expect(lastState(b).targets.map((t: any) => t.label)).toEqual(dark.targets.map((t) => t.label));
    expect([...lastState(a).targets, ...lastState(b).targets].every((t: any) => t.id >= 0)).toBe(true);
    // (A target down in the dark room is news to the pilot there alone)
    const told = a.said.length;
    S(server).ships.removeShip(lastState(b).targets[3].id);
    run(server, 2);
    expect(lastState(b).targets[3].id).toBe(-1);
    expect(a.said.slice(told).some((m) => m?.type === 'gunRangeState')).toBe(false);
    // (The rooms are far apart: nobody in one is anywhere near the other)
    expect(Math.hypot(Position.x[a.conn.playerId] - Position.x[b.conn.playerId], Position.y[a.conn.playerId] - Position.y[b.conn.playerId])).toBeGreaterThan(20000);
    // (One leaves: their room is put away, the other's stays up)
    toDoor(dark, b);
    b.link.receive({ type: 'interact' } as any);
    run(server, 3);
    expect(lastState(b).in).toBe(false);
    expect(lastState(a).targets.every((t: any) => t.id >= 0)).toBe(true);
    expect(server.gunRange.busy()).toBe(true);
  }, 120_000);
});

describe('gun range: an admin\'s library ships', () => {
  it('a pilot who is no admin is never sent the list, and their gunRangeShip is refused', async () => {
    const { server, rooms } = boot();
    const a = await inRange(server, 'plain', 64, false);
    expect(lastState(a).in).toBe(true);
    expect(a.said.filter((m) => m?.type === 'gunRangeState').every((m) => m.ships === undefined && m.ship === undefined)).toBe(true);
    const ship = JSON.stringify(blueprintOf(server, a)), weapon = lastState(a).weapon;
    const id = [...S(server).ships.library.keys()][0];
    a.link.receive({ type: 'gunRangeShip', ship: id } as any);
    a.link.receive({ type: 'gunRangeShip', ship: 'mod-showcase-1' } as any);
    run(server, 3);
    expect(JSON.stringify(blueprintOf(server, a))).toBe(ship);
    through(server, rooms[0], a, 'dark');
    expect(lastState(a).room).toBe('dark');
    expect(a.said.filter((m) => m?.type === 'gunRangeState').every((m) => m.ships === undefined && m.ship === undefined)).toBe(true);
    expect(lastState(a)).toMatchObject({ in: true, weapon });
    expect(JSON.stringify(blueprintOf(server, a))).toBe(ship);
  }, 120_000);

  it('an admin is sent the library (none retired) and flies any ship of it; a weapon pick goes back to the cheat ship; the real profile is untouched', async () => {
    const { server, store, rooms, num } = boot();
    const a = await signIn(server, 'boss', 65);
    a.conn.isAdmin = true;
    run(server, 3);
    S(server).pilots.give(a.conn, { iron_ore: 5, railgun_slugs: 3 });
    S(server).pilots.addCredits(a.conn, 500);
    dock(server, a);
    run(server, 3);
    S(server).pilots.saveNow(a.conn);
    await settle();
    const before = strip(await store.load(65));
    const saved = async () => { S(server).pilots.saveNow(a.conn); await settle(); return strip(await store.load(65)); };

    a.link.receive({ type: 'gunRangeEnter' } as any);
    run(server, 3);
    // (The list comes with the states the pilot's own doings send, not with each target's coming and going)
    const list: { id: string; name: string; group: string }[] = states(a).filter((m) => m.ships).at(-1).ships;
    expect(lastState(a).ships).toBeUndefined();
    const bridge = S(server).ships;
    // (The F9 ship swap's list: the plan library, then the dev test ships and remakes, none marked retired)
    expect(list.filter((s) => s.group === 'Library').map((s) => s.id)).toEqual([...bridge.library.keys()]);
    expect(list.filter((s) => s.group === 'Dev test ships').map((s) => s.id).sort()).toEqual(Object.keys(bridge.devDesigns).filter((k) => !bridge.retiredDesigns.has(k) && !bridge.library.has(k)).sort());
    expect(new Set(list.map((s) => s.group))).toEqual(new Set(['Library', 'Dev test ships']));
    expect(bridge.retiredDesigns.size).toBeGreaterThan(0);
    for (const gone of bridge.retiredDesigns) expect(list.some((s) => s.id === gone), gone).toBe(false);
    expect(list.every((s) => s.name && (bridge.library.get(s.id) ?? bridge.devDesigns[s.id]).name === s.name)).toBe(true);
    expect(lastState(a).ship).toBeUndefined();

    // ---- a dev test ship, as it is drawn (its parts untouched: weapon groups and all), under the range's flag
    const dev = list.find((s) => s.group === 'Dev test ships')!;
    const eid = a.conn.playerId, weapon = lastState(a).weapon;
    a.link.receive({ type: 'gunRangeShip', ship: dev.id } as any);
    run(server, 3);
    expect(a.conn.playerId).toBe(eid);
    expect(lastState(a)).toMatchObject({ in: true, ship: dev.id, weapon, room: 'targets' });
    expect(blueprintOf(server, a)).toEqual({ ...bridge.devDesigns[dev.id], range: true });
    expect(InSystem.systemId[eid]).toBe(num);
    expect(S(server).pilots.isFrozen(a.conn)).toBe(true);
    expect(await saved()).toEqual(before);
    // (A retired one, or no ship at all: refused, the ship flown stays)
    for (const bad of [[...bridge.retiredDesigns][0], 'no-such-ship', 7, undefined]) a.link.receive({ type: 'gunRangeShip', ship: bad } as any);
    run(server, 2);
    expect(lastState(a).ship).toBe(dev.id);
    expect(blueprintOf(server, a).name).toBe(bridge.devDesigns[dev.id].name);

    // ---- a library ship; a change of room keeps it; dying and coming back keeps it
    const lib = list.find((s) => s.group === 'Library')!;
    a.link.receive({ type: 'gunRangeShip', ship: lib.id } as any);
    run(server, 3);
    expect(blueprintOf(server, a)).toEqual({ ...bridge.library.get(lib.id), range: true });
    through(server, rooms[0], a, 'dark');
    expect(lastState(a)).toMatchObject({ in: true, ship: lib.id, room: 'dark' });
    expect(blueprintOf(server, a)).toEqual({ ...bridge.library.get(lib.id), range: true });
    expect(insideChamber(rooms[1], Position.x[eid], Position.y[eid], 50)).toBe(true);
    kill(a);
    run(server, 3);
    expect(await saved()).toEqual(before);
    a.link.receive({ type: 'respawn' } as any);
    run(server, 3);
    expect(lastState(a)).toMatchObject({ in: true, ship: lib.id, room: 'dark' });
    expect(blueprintOf(server, a)).toEqual({ ...bridge.library.get(lib.id), range: true });
    expect(await saved()).toEqual(before);

    // ---- a weapon picked: the cheat ship again (the same weapon asked for is enough)
    a.link.receive({ type: 'gunRangeWeapon', model: weapon } as any);
    run(server, 3);
    expect(lastState(a).ship).toBeUndefined();
    expect(lastState(a).weapon).toBe(weapon);
    expect(blueprintOf(server, a).name).toMatch(/^Range ship/);

    // ---- out in a library ship: their own ship back, the saved profile as it went in, no range ship anywhere in it
    a.link.receive({ type: 'gunRangeShip', ship: dev.id } as any);
    run(server, 3);
    toDoor(rooms[1], a);
    a.link.receive({ type: 'interact' } as any);
    run(server, 3);
    expect(lastState(a).in).toBe(false);
    expect(InSystem.systemId[a.conn.playerId]).not.toBe(num);
    expect(JSON.stringify(S(server).pilots.get(a.conn).ship)).toBe(JSON.stringify(before.ship));
    expect(await saved()).toEqual(before);
    expect(JSON.stringify(await store.load(65))).not.toMatch(/"range":true|Range ship/);
    // (Outside the range the message does nothing, admin or not)
    a.link.receive({ type: 'gunRangeShip', ship: lib.id } as any);
    run(server, 2);
    expect(JSON.stringify(S(server).pilots.get(a.conn).ship)).toBe(JSON.stringify(before.ship));
    expect(await saved()).toEqual(before);
  }, 180_000);
});
