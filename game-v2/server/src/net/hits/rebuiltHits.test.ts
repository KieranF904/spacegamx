/**
 * Own-shell hits on ships that rebuild in the window (Track D of the C3 rollout): a real GameServer, a pilot firing at a
 * parked freighter, a dying one and a Helios drone pack (fakeHitsClient.testkit.ts clients, hitsFight.testkit.ts).
 *
 * Before: a hit on a ship that rebuilt before the snapshot (the hit that broke a part, and every hit before it in that
 * window) went the old way (HitLedger 'rebuilt'), and every hit after it was told (the ship was synced in the window:
 * 'synced', and its REBUILD cause made it 'keyframed'); on drones that was 72 % of the pilot's own hits. Worse, an own
 * shell's old-way projectileHit went under the server's entity id (its shot-id name was let go by the snapshot's
 * removals before the hit was written), which names nothing on the client: its drawn shell never heard of its hit, and
 * its tick layer flew it on.
 *
 * Now: every hit on an own shell is told or found under the shell's shot-id name; a hit before a rebuild sync of a ship
 * the client had is worked out on the structure and HP it had before that sync (client ShipStore.asOf, HitLedger.before),
 * and found by the client itself, as is every hit after it.
 */
import { describe, it, expect } from 'vitest';
import { Projectile } from '@space-game/common';
import { runFight, expectShownAsServer, type FightScenario } from '../../testkits/hitsFight.testkit.js';

function run(sc: FightScenario) {
  // The shooter's own hits: the server's entity id and the shot-id name the shooter gave the shell (entity ids are used
  // again, so the name is looked up as it's hit)
  const own: { proj: number; name: number }[] = [];
  const r = runFight({
    ...sc,
    onServer: (server, A) => {
      const led = server.hits as unknown as { shellHit(proj: number, x: number, y: number, hit?: unknown): void };
      const shellHit = led.shellHit.bind(led);
      led.shellHit = (proj, x, y, hit) => {
        if (hit && Projectile.ownerId[proj] === A.pid) {
          let name = NaN;
          for (const [w, e] of A.ownWire) if (e === proj) name = w;
          own.push({ proj, name });
        }
        shellHit(proj, x, y, hit);
      };
    },
  });
  const told = new Set(r.A.impacts.map((i) => i.id));
  const byName = own.filter((h) => told.has(h.name)).length;
  const byEntity = own.filter((h) => told.has(h.proj)).length;
  return { r, own: own.length, byName, byEntity, found: r.A.hits.stats.own };
}

function expectAgree(x: ReturnType<typeof run>) {
  const { r } = x;
  expect(r.compared).toBeGreaterThan(0);
  expect(r.finalOff.slice(0, 5)).toEqual([]);
  expect(r.stats.fixes).toBe(0);
  expect(r.A.hits.stats.mismatches + r.C.hits.stats.mismatches).toBe(0);
  for (const f of [r.A, r.C]) expectShownAsServer(r, f);
  // (every own hit reached the shooter under its own name)
  expect(x.own).toBeGreaterThan(20);
  expect(x.byEntity).toBe(0);
  expect(x.byName).toBe(x.own);
}

describe('own-shell hits on ships rebuilt in the window', () => {
  it('a still freighter: nearly every hit found by the shooter itself', () => {
    const x = run({ ticks: 600 });
    expectAgree(x);
    expect(x.r.off).toEqual([]);
    expect(x.found).toBeGreaterThanOrEqual(0.95 * x.own);
  }, 120_000);

  it('a freighter shot apart: hits before each rebuild worked out on the structure before it', () => {
    const x = run({ hpScale: 0.1, ticks: 900 });
    expectAgree(x);
    expect(x.r.off).toEqual([]);
    expect(x.r.stats.rebuiltDerived).toBeGreaterThan(0);
    // (the rest: hits on its debris, and on it as it died, are told)
    expect(x.r.stats.why.rebuilt ?? 0).toBeLessThanOrEqual(12);
  }, 120_000);

  it('a Helios drone pack, parts shot off most windows: the shooter finds most of its hits itself', () => {
    const x = run({ pack: ['helios_drone', 'helios_drone', 'helios_drone'], ticks: 600 });
    expectAgree(x);
    expect(x.r.stats.rebuiltDerived).toBeGreaterThan(0);
    expect(x.found).toBeGreaterThanOrEqual(0.8 * x.own);
    expect(x.r.stats.toldWhy.synced ?? 0).toBe(0);
    expect(x.r.stats.toldWhy.keyframed ?? 0).toBe(0);
    // (and none told for its number: a hit's number is worked out from the HP to the wire's tenth on both ends, and
    // summed in fixed point, so the shooter's sums are the server's: hitRules.ts partHit `shown`, tuning.ts damageUnits)
    expect(x.r.stats.quiet).toBe(0);
  }, 120_000);
});
