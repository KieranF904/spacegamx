/**
 * Nothing from the gun range ever reaches the real game (game/gunRange, pilots/freeze.ts). A signed-in pilot with a hold,
 * storage, money, XP and ammunition goes in, shoots, swaps weapons, tries every way to give, take or keep something,
 * dies, comes back, goes in again and disconnects, goes in once more and the server shuts down: every profile written
 * is the one they went in with, byte for byte, but for its timestamp and where it was saved (their station).
 */

import { describe, it, expect } from 'vitest';
import { InSystem, Position, Rotation, Velocity } from '@space-game/common';
import { boot, signIn, dock, run, settle, lastState, fireAt, toDoor, kill, heavyOf, S } from './gunRange.testkit.js';

/** A saved profile, but for what may change: when it was saved, and where (the station they came from, as it moves) */
const strip = (p: any) => { const { updatedAt: _u, position, ...rest } = p; return { ...rest, system: position?.system }; };

describe('gun range: nothing leaks into the real game', () => {
  it('enter, shoot, swap, try to take things, die, disconnect, shut down: the saved profile never changes', async () => {
    const { server, store, def, num } = boot();
    const a = await signIn(server, 'leaky', 77);
    run(server, 3);
    const pilots = S(server).pilots;
    // Something of everything: a hold, storage, money, XP, an open crate
    pilots.give(a.conn, { iron_ore: 5, railgun_slugs: 3 });
    pilots.give(a.conn, { copper_ore: 4 }, { toStorage: true });
    pilots.addCredits(a.conn, 1234);
    pilots.addXp(a.conn, 50);
    pilots.get(a.conn).ammo = { open: { railgun_slugs: 7 } };
    dock(server, a);
    run(server, 3);
    pilots.saveNow(a.conn);
    await settle();
    const before = strip(await store.load(77));
    expect(before.cargo.length).toBeGreaterThan(0);
    const realShip = JSON.stringify(before.ship);

    // ---- in: shoot, swap weapons
    a.link.receive({ type: 'gunRangeEnter' } as any);
    run(server, 3);
    expect(InSystem.systemId[a.conn.playerId]).toBe(num);
    const eid = a.conn.playerId;
    Position.x[eid] = heavyOf(def).x - 900; Position.y[eid] = heavyOf(def).y; Velocity.x[eid] = 0; Rotation.angle[eid] = 0;
    for (const model of ['cannon_pip', 'railgun_needle', 'missile_dart', 'laser_glint']) {
      a.link.receive({ type: 'gunRangeWeapon', model } as any);
      for (let i = 0; i < 120; i++) { fireAt(a, heavyOf(def).x, heavyOf(def).y); server.step(); }
    }
    fireAt(a, 0, 0, false);
    // The target destroyed (as a kill would): no XP, credits or loot
    const target = lastState(a).targets.at(-1).id;
    if (target >= 0) S(server).ships.removeShip(target);
    run(server, 3);

    // ---- every way to give, take or keep something, tried
    expect(pilots.give(a.conn, { nickel_ore: 9 })).toEqual({ nickel_ore: 9 });
    expect(pilots.take(a.conn, { iron_ore: 1 })).toBe(false);
    pilots.addCredits(a.conn, 999_999);
    pilots.addXp(a.conn, 999_999);
    pilots.bumpStat(a.conn, 'kills', 50);
    pilots.grant(a.conn, { plans: ['cheat'], skillPoints: 5 });
    for (const m of [
      { type: 'itemJettison', id: 'iron_ore', n: 1 }, { type: 'itemMove', id: 'copper_ore', n: 1, to: 'cargo' }, { type: 'scrapItem', id: 'iron_ore', n: 1 },
      { type: 'shipEdit', blueprint: S(server).ships.get(eid).blueprint }, { type: 'slotSave', slot: 1 }, { type: 'designSave', name: 'x' },
      { type: 'marketSellAll' }, { type: 'tradeRequest', name: 'x' }, { type: 'bankDeposit', items: { iron_ore: 1 } }, { type: 'skillUp', skill: 'cargo' },
      { type: 'quickbarSet', slot: 0, id: 'iron_ore' }, { type: 'devShip', ship: 'hauler' }, { type: 'admin', action: 'give' },
    ]) a.link.receive(m as any);
    run(server, 3);
    // (A save while inside writes the real profile, as it went in)
    pilots.saveNow(a.conn);
    await settle();
    expect(strip(await store.load(77))).toEqual(before);

    // ---- die: back in the range at the door, the same cheat ship and weapon; the saved profile unchanged
    const weapon = lastState(a).weapon, rangeShip = JSON.stringify(S(server).ships.get(a.conn.playerId).blueprint);
    kill(a);
    run(server, 3);
    pilots.saveNow(a.conn);
    await settle();
    expect(strip(await store.load(77))).toEqual(before);
    a.link.receive({ type: 'respawn' } as any);
    run(server, 3);
    expect(InSystem.systemId[a.conn.playerId]).toBe(num);
    expect(lastState(a)).toMatchObject({ in: true, weapon });
    expect(JSON.stringify(S(server).ships.get(a.conn.playerId).blueprint)).toBe(rangeShip);
    expect(pilots.isFrozen(a.conn)).toBe(true);
    expect(pilots.give(a.conn, { nickel_ore: 9 })).toEqual({ nickel_ore: 9 });
    pilots.saveNow(a.conn);
    await settle();
    expect(strip(await store.load(77))).toEqual(before);
    // ---- the door: back docked, own ship
    toDoor(def, a);
    a.link.receive({ type: 'interact' } as any);
    run(server, 3);
    expect(InSystem.systemId[a.conn.playerId]).not.toBe(num);
    pilots.saveNow(a.conn);
    await settle();
    expect(strip(await store.load(77))).toEqual(before);

    // ---- in again, and disconnect there
    a.link.receive({ type: 'gunRangeEnter' } as any);
    run(server, 3);
    expect(InSystem.systemId[a.conn.playerId]).toBe(num);
    a.link.close();
    run(server, 2);
    await settle();
    const afterDc = strip(await store.load(77));
    expect(afterDc).toEqual(before);
    expect(JSON.stringify(afterDc.ship)).toBe(realShip);
    expect(afterDc.system).not.toBe('gun_range');

    // ---- back, in once more, and the server shuts down with them inside
    const b = await signIn(server, 'leaky', 77);
    run(server, 3);
    expect(InSystem.systemId[b.conn.playerId]).not.toBe(num);
    expect(JSON.stringify(S(server).pilots.get(b.conn).ship)).toBe(realShip);
    dock(server, b);
    run(server, 3);
    // (Docking again is the real game: it counts. The baseline is the profile as it goes in this time)
    S(server).pilots.saveNow(b.conn);
    await settle();
    const again = strip(await store.load(77));
    b.link.receive({ type: 'gunRangeEnter' } as any);
    run(server, 3);
    expect(InSystem.systemId[b.conn.playerId]).toBe(num);
    await S(server).pilots.saveAll();
    await settle();
    const atShutdown = strip(await store.load(77));
    expect(atShutdown).toEqual(again);
    expect(atShutdown.system).not.toBe('gun_range');
    // (Nothing in any saved profile is a cheat ship)
    const raw = JSON.stringify(await store.load(77));
    expect(raw).not.toMatch(/"range":true|Range ship/);
  }, 180_000);

  it('the leave at the door saves nothing new either, and the session after it is the real profile', async () => {
    const { server, store, def } = boot();
    const a = await signIn(server, 'door', 78);
    run(server, 3);
    S(server).pilots.give(a.conn, { iron_ore: 2 });
    dock(server, a);
    run(server, 3);
    S(server).pilots.saveNow(a.conn);
    await settle();
    const before = strip(await store.load(78));
    a.link.receive({ type: 'gunRangeEnter' } as any);
    run(server, 3);
    toDoor(def, a);
    a.link.receive({ type: 'interact' } as any);
    run(server, 3);
    S(server).pilots.saveNow(a.conn);
    await settle();
    expect(strip(await store.load(78))).toEqual(before);
    // Back in the real game, what they do counts again
    S(server).pilots.addCredits(a.conn, 10);
    expect(S(server).pilots.get(a.conn).credits).toBe(before.credits + 10);
  }, 120_000);
});
