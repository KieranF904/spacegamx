/**
 * Confirmed hits (docs/design/confirmed-hits.md part C): a real GameServer, a pilot firing at a ship, and two fake
 * clients (fakeHitsClient.testkit.ts, full caps as every client: the shooter, and an observer beside it). Each works
 * every hit it's told out with the client's ConfirmedHits on the client's ShipStore (and finds the rest itself). After
 * every snapshot both must have the server's part HP as the wire carries it; by the end each was shown the damage
 * numbers, fires, impacts and removed shells the server's own record of the fight has (serverTruth.testkit.ts), and
 * their HP checks all agree.
 *
 * Scenarios: Pips on a Hauler (plain hits, parts shot away, the Hauler dying), railgun pierce, magma (fire and a blast),
 * Cinder Bloom (fire), the Phase Cannon (a pierce that keeps its damage: its flash), a shielded Hauler, and a staged
 * boss (its cover).
 */
import { describe, it, expect } from 'vitest';
import { runFight, expectShownAsServer, type Fight } from '../../testkits/hitsFight.testkit.js';

function expectParity(r: Fight) {
  const { A, C } = r;
  if (process.env.HITS_DEBUG) console.log(JSON.stringify({ stats: r.stats, client: A.hits.stats, compared: r.compared, died: r.died, truth: { damage: [...r.truth.damage].slice(0, 6), ignites: r.truth.ignites.length, impacts: r.truth.impacts, removed: r.truth.removed.size } }));
  expect(r.off.slice(0, 5)).toEqual([]);
  expect(r.finalOff.slice(0, 5)).toEqual([]);
  expect(r.compared).toBeGreaterThan(0);
  // Hits were recorded, and every record the clients were told they worked out
  expect(r.stats.records).toBeGreaterThan(0);
  for (const f of [A, C]) {
    expect(f.hits.stats.missed).toBe(0);
    expect(f.hits.stats.mismatches).toBe(0);
    expectShownAsServer(r, f);
  }
  // (shells were removed, and both clients saw it)
  expect(r.truth.removed.size).toBeGreaterThan(0);
}

describe('confirmed hits: each client is shown the fight the server had', () => {
  it('Pips on a Hauler: plain hits, parts shot away, the Hauler dying', () => {
    const r = runFight({ hauler: true, hpScale: 0.02, ticks: 900 });
    expectParity(r);
    expect(r.died).toBe(true);
  }, 120_000);

  it('railgun: shells that pierce', () => {
    const r = runFight({ hauler: true, gun: 'railgun', ammo: 'railgun_slugs', hpScale: 0.5, behind: true });
    expectParity(r);
  }, 120_000);

  it('railgun through a stack: a pierce whose last pass goes the old way (its removal rides the snapshot before the records)', () => {
    const r = runFight({ hauler: true, gun: 'railgun', ammo: 'railgun_slugs', stack: [{ dx: 60, hpScale: 0.01 }, { dx: 120, hpScale: 0.01 }], ticks: 400 });
    expectParity(r);
  }, 120_000);

  it('railgun out of slugs: plain rounds, told the old way (their end is not what the gun says)', () => {
    const r = runFight({ hauler: true, gun: 'railgun', hpScale: 0.5 });
    expect(r.off.slice(0, 5)).toEqual([]);
    expect(r.stats.records).toBe(0);
    expect(r.stats.why.fx).toBeGreaterThan(0);
  }, 120_000);

  it('magma: fire and a blast', () => {
    const r = runFight({ hauler: true, gun: 'magma_cannon' });
    expectParity(r);
    expect(r.A.ignites.length).toBeGreaterThan(0);
  }, 120_000);

  it('Cinder Bloom: fire', () => {
    const r = runFight({ hauler: true, gun: 'cinder_bloom' });
    expectParity(r);
    expect(r.A.ignites.length).toBeGreaterThan(0);
  }, 120_000);

  it('Phase Cannon: a pierce that keeps its damage, and its flash', () => {
    const r = runFight({ hauler: true, gun: 'phase', behind: true });
    expectParity(r);
  }, 120_000);

  it('a shielded Hauler: the shield takes it, the HP follows in shipHps', () => {
    const r = runFight({ hauler: true, shield: 400 });
    expectParity(r);
    expect(r.stats.s).toBeGreaterThan(0);
  }, 120_000);

  it('a staged boss: its cover', () => {
    const r = runFight({ boss: 'boss_scrap_mother', ticks: 600 });
    expectParity(r);
  }, 120_000);
});
