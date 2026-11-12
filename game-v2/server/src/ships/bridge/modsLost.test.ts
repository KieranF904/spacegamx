/**
 * Weapon modifiers lost in battle (docs/design/weapon-modifiers-2026-11.md): a gun's effects are a function of the
 * parts still alive, so a modifier block or its hopper destroyed changes the shots of the guns down its
 * line at once. On a real server, the dev test ship beam-ends-1 (two blocks a lane: blast, chain, burn, burn).
 */

import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { readFileSync } from 'fs';
import * as bitecs from 'bitecs';
import { parseBlueprint, shipGunFx, shipGunDef } from '@space-game/common';
import { MemoryProfileStore } from '../../profile/ProfileStore.js';
import { makeEmptyServer } from '../../testkits/world.testkit.js';

function rig() {
  (bitecs as unknown as { resetGlobals(): void }).resetGlobals();
  const server = makeEmptyServer({ profileStore: new MemoryProfileStore() });
  const ships = server.getShips()!, mt = ships.tuning.modifiers!;
  const bp = parseBlueprint(readFileSync(join(__dirname, '../../../../data/ships/blueprints/dev/beam-ends-1.json'), 'utf-8'));
  const eid = ships.spawnDummy(bp, 0, 300000, 0, 0);
  const run = (n = 5) => { for (let i = 0; i < n; i++) server.step(); };
  run(30);
  const parts = (fn: string) => bp.parts.map((p, i) => (p.fn === fn ? i : -1)).filter((i) => i >= 0);
  /** Each gun's effects by name, in the blueprint's gun order */
  const guns = () => { const s = ships.get(eid)!; return s.derived.weapons.map((w) => (shipGunFx(s, w.part) ?? []).map((f) => mt.effects[f.fx]).join(',')); };
  const kill = (...list: number[]) => { for (const p of list) ships.damagePartFraction(eid, p, 1); run(); };
  return { ships, eid, parts, guns, kill };
}

describe('a modifier destroyed in battle', () => {
  it('its lane keeps the effect while one block of two works, and loses it with the last', () => {
    const r = rig(), [a, b] = r.parts('mod_chamber');
    expect(r.guns()).toEqual(['explosive', 'chain', 'burn', 'burn']);
    r.kill(a);
    expect(r.guns()).toEqual(['explosive', 'chain', 'burn', 'burn']);
    r.kill(b);
    expect(r.guns()).toEqual(['', 'chain', 'burn', 'burn']);
  });

  it('a special with its hoppers gone treats nothing', () => {
    const r = rig();
    r.kill(...r.parts('hopper_arcsalt'));
    expect(r.guns()).toEqual(['explosive', '', 'burn', 'burn']);
  });

  it('the shot is the plain gun\'s again once its blocks are gone', () => {
    const r = rig(), s = () => r.ships.get(r.eid)!, strobe = () => s().derived.weapons[3];
    const def = () => { const fx = shipGunFx(s(), strobe().part); return shipGunDef(r.ships.tuning, s(), strobe(), undefined, fx ? (1 << fx.length) - 1 : 0); };
    // (the Strobe's bolts light fires while its Brands work)
    expect(def().ignite).toBeTruthy();
    r.kill(...r.parts('mod_brand').slice(2));
    expect(r.guns()).toEqual(['explosive', 'chain', 'burn', '']);
    expect(def().ignite).toBeFalsy();
  });
});
