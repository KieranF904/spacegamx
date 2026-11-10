/**
 * A kept pod (a pilot's wreck, game/LootPods.ts keep): only its owner's account collects it until it runs out, then anyone can.
 * Also: the rankings reporter holds at most MAX_PLAYERS pilots (game/rankings/RankingReporter.ts).
 */
import { describe, it, expect } from 'vitest';
import { createWorld, addEntity, addComponent } from 'bitecs';
import { Position, Velocity, Radius, InSystem, Player, type Bag, type ItemCatalog } from '@space-game/common';
import { LootPods, type PodHost } from './LootPods.js';
import { RankingReporter, MAX_PLAYERS } from './rankings/RankingReporter.js';
import type { RankingsBackend } from './rankings/RankingsBackend.js';

function rig() {
  const world = createWorld();
  const mk = (x: number) => {
    const e = addEntity(world);
    for (const c of [Position, Velocity, Radius, InSystem, Player]) addComponent(world, c, e);
    Position.x[e] = x; Position.y[e] = 0; Radius.value[e] = 10; InSystem.systemId[e] = 1;
    return e;
  };
  const owner = mk(0), thief = mk(5);
  const keys = new Map<number, string>([[owner, 'acct:owner'], [thief, 'acct:thief']]);
  const given: Array<{ to: number; items: Bag }> = [];
  let tick = 0;
  const host: PodHost = {
    world, remove: () => {}, collectors: () => [owner, thief],
    give: (to, items) => { given.push({ to, items }); return {}; },
    cargoFree: () => 100, shipRadius: () => 10, tick: () => tick, keyOf: (e) => keys.get(e),
  };
  const items = { has: () => true, get: () => ({ rarity: 'common' }) } as unknown as ItemCatalog;
  const pods = new LootPods(host, items);
  return { pods, given, owner, thief, setTick: (t: number) => { tick = t; } };
}

describe('wreck keeping', () => {
  it('a kept pod goes to its owner only, even when another ship is closer', () => {
    const { pods, given, owner, thief } = rig();
    const eid = pods.spawn(1, 4, 0, 0, 0, { scrap: 3 }, -1, 0);
    pods.keep(eid, 'acct:owner', 1000);
    pods.tick();
    expect(given.length).toBe(1);
    expect(given[0].to).toBe(owner);
    expect(given.some((g) => g.to === thief)).toBe(false);
  });

  it('once the keeping runs out, anyone can take it', () => {
    const { pods, given, thief, setTick } = rig();
    const eid = pods.spawn(1, 5, 0, 0, 0, { scrap: 3 }, -1, 0);
    pods.keep(eid, 'acct:owner', 100);
    setTick(100);
    pods.tick();
    expect(given[0]?.to).toBe(thief);
  });
});

describe('ranking reporter cap', () => {
  it('never waits on more than MAX_PLAYERS pilots, though pilots already waiting still update', () => {
    const backend = { report: async () => true, importDoc: async () => {}, view: async () => null } as RankingsBackend;
    const r = new RankingReporter(backend, 'srv', () => 0);
    for (let i = 1; i <= MAX_PLAYERS + 50; i++) r.add(i, 'kills', 1, 1);
    expect(r.waiting).toBe(MAX_PLAYERS);
    r.add(1, 'kills', 1, 2);
    expect(r.waiting).toBe(MAX_PLAYERS);
  });
});
