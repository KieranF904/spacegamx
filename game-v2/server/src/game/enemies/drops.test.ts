import { describe, it, expect } from 'vitest';
import { addBag, type Bag, type LootTable } from '@space-game/common';
import { makeServer, resetGlobals } from '../../testkits/world.testkit.js';

/** Each table rolled marks itself: an always table of one item, so a pod says which tables a kill rolled and how often */
const MARKS: Record<string, LootTable> = {
  scrap_common: { kind: 'always', entries: [{ item: 'iron_ore' }] },
  scrap_rare: { kind: 'always', entries: [{ item: 'servo_motor' }] },
  nest_rare: { kind: 'always', entries: [{ item: 'coil_winding' }] },
  pirate_common: { kind: 'always', entries: [{ item: 'copper_wire' }] },
  pirate_rare: { kind: 'always', entries: [{ item: 'targeting_chip' }] },
};

function world() {
  resetGlobals();
  const server = makeServer();
  server.enemies.data.lootTables = MARKS;
  // (No salvaged parts: only the tables in the pods)
  for (const f of Object.values(server.enemies.data.factions)) f.partSalvage = 0;
  /** Kill one of `design` in `system` (an elite if asked): what its pods held */
  const kill = (system: string, faction: string, design: string, elite = false): Bag => {
    const num = server['gameData'].getSystemNum(system);
    const [foe] = server.enemies.spawnPack(num, { faction, ships: [design] }, 61000, 61000);
    if (elite) server.enemies.enemies.get(foe)!.elite = true;
    const ship = server.getShips().get(foe)!;
    server.getShips().damagePartFraction(foe, ship.blueprint.parts.findIndex((p) => p.fn === 'core'), 1);
    for (let i = 0; i < 3; i++) server.step();
    let bag: Bag = {};
    for (const pod of server.pods.near(num, 61000, 61000, 3000)) { bag = addBag(bag, server.pods.get(pod) ?? {}); server.pods.take(pod); }
    return bag;
  };
  return { server, kill };
}

describe('drop tables on a kill', () => {
  it("a design's own rolls override its faction's", () => {
    const { kill } = world();
    expect(kill('sol', 'scrapborn', 'scrap_mite')).toEqual({ iron_ore: 1 });
    expect(kill('sol', 'scrapborn', 'scrap_crawler')).toEqual({ iron_ore: 2 });
    expect(kill('sol', 'scrapborn', 'scrap_hulk')).toEqual({ iron_ore: 2, servo_motor: 1 });
    expect(kill('sol', 'pirates', 'pirate_raider')).toEqual({ copper_wire: 2, targeting_chip: 1 });
    // (A redtooth brawler rolls the pirate tables, as the brief has it)
    expect(kill('sol', 'redtooth', 'redtooth_brawler')).toEqual({ copper_wire: 2, targeting_chip: 1 });
  });

  it('the Scrap Nest den: the same design drops its own way in there', () => {
    const { kill } = world();
    expect(kill('sol_scrap_nest', 'scrapborn', 'scrap_crawler')).toEqual({ iron_ore: 1, coil_winding: 1 });
    expect(kill('sol_scrap_nest', 'scrapborn', 'scrap_darter')).toEqual({ iron_ore: 1, coil_winding: 1 });
  });

  it('an elite rolls its eliteDrop once more (the den: nest_rare)', () => {
    const { kill } = world();
    expect(kill('sol', 'scrapborn', 'scrap_mite', true)).toEqual({ iron_ore: 1, servo_motor: 1 });
    expect(kill('sol_scrap_nest', 'scrapborn', 'scrap_crawler', true)).toEqual({ iron_ore: 1, coil_winding: 2 });
  });
});
