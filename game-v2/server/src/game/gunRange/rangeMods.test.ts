/**
 * The gun range's weapon modifiers (GunRange.pick): the cheat ship carries the effects picked, each at full strength
 * and live on its shots; only effects the pilot's own level opens; they are kept from weapon to weapon; a gun fed by
 * ammunition alone carries none.
 */

import { describe, it, expect } from 'vitest';
import { FX_STEPS, Rotation, shipGunFx } from '@space-game/common';
import { boot, signIn, dock, run, lastState, fireAt, heavyOf, S } from './gunRange.testkit.js';

async function inRange(level: number) {
  const { server, def } = boot();
  const a = await signIn(server, 'modder', 43);
  run(server, 3);
  S(server).pilots.get(a.conn).level = level;
  dock(server, a);
  run(server, 2);
  a.link.receive({ type: 'gunRangeEnter' } as any);
  run(server, 2);
  const mt = S(server).ships.tuning.modifiers;
  const ship = () => S(server).ships.get(a.conn.playerId);
  /** The flown gun's effects by name, and their strength steps */
  const fx = () => { const s = ship(), w = s.derived.weapons.find((q: any) => q.uid >= 0); return (shipGunFx(s, w.part) ?? []).map((f) => [mt.effects[f.fx], f.q]); };
  const pick = (model: string, mods?: unknown) => { a.link.receive({ type: 'gunRangeWeapon', model, ...(mods === undefined ? {} : { mods }) } as any); run(server, 1); };
  return { server, def, a, mt, ship, fx, pick };
}

describe('gun range: weapon modifiers', () => {
  it('the effects picked are on the gun at full strength, kept from weapon to weapon, and gone when cleared', async () => {
    const r = await inRange(50);
    expect(lastState(r.a).mods).toEqual([]);
    expect(lastState(r.a).modOptions).toEqual(r.mt.effects);
    r.pick('cannon_pip', ['explosive', 'burn']);
    expect(lastState(r.a).mods).toEqual(['explosive', 'burn']);
    expect(r.fx()).toEqual(expect.arrayContaining([['explosive', FX_STEPS], ['burn', FX_STEPS]]));
    expect(r.ship().blueprint.range).toBe(true);
    // (another weapon, nothing said of modifiers: the same ones behind it)
    r.pick('laser_glint');
    expect(lastState(r.a).weapon).toBe('laser_glint');
    expect(lastState(r.a).mods).toEqual(['explosive', 'burn']);
    expect(r.fx().map((f: any) => f[0]).sort()).toEqual(['burn', 'explosive']);
    // (a gun fed by ammunition alone: the choice stays, the ship carries none)
    r.pick('missile_dart');
    expect(lastState(r.a).mods).toEqual(['explosive', 'burn']);
    expect(r.fx()).toEqual([]);
    r.pick('missile_dart', []);
    r.pick('cannon_pip');
    expect(lastState(r.a).mods).toEqual([]);
    expect(r.fx()).toEqual([]);
    expect(r.ship().blueprint.parts.some((q: any) => q.fn.startsWith('mod_'))).toBe(false);
  }, 60_000);

  it('a gun carrying them still fires (the effect mask of a shot: common gunRange/mods.test.ts)', async () => {
    const r = await inRange(50);
    r.pick('cannon_pip', ['explosive']);
    const eid = r.a.conn.playerId, t = heavyOf(r.def);
    Rotation.angle[eid] = 0;
    const from = r.server.currentTick;
    for (let i = 0; i < 120; i++) { fireAt(r.a, t.x, t.y); r.server.step(); }
    fireAt(r.a, t.x, t.y, false);
    expect(S(r.server).ships.lastFiredTick(eid)).toBeGreaterThan(from);
  }, 60_000);

  it('only what their own level opens, never more than a gun carries, and junk is nothing', async () => {
    const r = await inRange(50);
    S(r.server).pilots.realProfile(r.a.conn).level = 5;
    r.pick('cannon_pip', ['chain', 'pierce', 'split']);
    expect(lastState(r.a).mods).toEqual(['split']);
    expect(lastState(r.a).modOptions).not.toContain('chain');
    S(r.server).pilots.realProfile(r.a.conn).level = 50;
    r.pick('cannon_pip', [...r.mt.effects]);
    expect(lastState(r.a).mods).toHaveLength(4);
    expect(r.fx()).toHaveLength(4);
    r.pick('cannon_pip', 'explosive');
    expect(lastState(r.a).mods).toEqual([]);
    r.pick('cannon_pip', [{}, 7, null]);
    expect(lastState(r.a).mods).toEqual([]);
  }, 60_000);
});
