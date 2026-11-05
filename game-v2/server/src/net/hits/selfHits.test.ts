/**
 * Client-detected hits (docs/design/confirmed-hits.md part D): a real GameServer, a pilot firing at a parked ship, and
 * two fake clients (fakeHitsClient.ts: the client's ShipStore, ShipReplicaSet, ConfirmedHits and SelfHits, full caps as
 * every client): the shooter finding its hits itself, and an observer finding them itself (its shells come as fire
 * events, rebuilt from the shooter's replica). After every snapshot each one's part HP must be the server's as the wire
 * carries it; by the end each was shown the damage, fires, impacts and removed shells the server's own record of the
 * fight has (serverTruth.testkit.ts); the server sent records only for what the finders couldn't find, and their reports
 * agreed.
 *
 * The forced mismatch: a finder that throws away some of its hits. Its reports disagree, the server sends a hitFix,
 * and its HP is put right (the ships' HP in full with the next snapshot).
 */
import { describe, it, expect } from 'vitest';
import { CONFIRM } from '@space-game/common';
import { runFight, expectShownAsServer, type Fight } from '../../testkits/hitsFight.testkit.js';
import { SelfHits } from '../../../../client/src/ships/hits/SelfHits.js';
import type { OwnHit } from '../../../../client/src/ships/hits/ConfirmedHits.js';

/**
 * A third of the hits, by a hash of the shell's name (its own shells are named by shot id: tick, slot and barrel, so a
 * plain shell % 3 can pick all of a steady gun's shells or none)
 */
const third = (h: OwnHit) => (Math.imul(h.shell, 0x9e3779b1) >>> 0) % 3 === 0;

/** Per 100 hits the finders were owed: found by themselves, told, corrected */
function rates(r: Fight) {
  const s = r.stats, owed = s.own + s.told;
  return { owed, own: s.own, told: s.told, fixes: s.fixes, fixHits: s.fixHits, per100: owed ? +(100 * s.fixes / owed).toFixed(2) : 0, toldWhy: s.toldWhy, journal: r.journal };
}

function expectAgree(r: Fight, found = true) {
  const { A, C } = r;
  if (process.env.HITS_DEBUG) console.log(JSON.stringify({ hits: r.stats.hits, own: (r.server.replication as any).ownStats, reasons: (r.server.replication as any).reasons, truthImpacts: r.truth.impacts, died: r.died, rates: rates(r), off: r.off.slice(0, 5), offSnapshots: r.offSnapshots, A: A.selfHits.stats, C: C.selfHits.stats, hitsA: A.hits.stats, hitsC: C.hits.stats }));
  expect(r.compared).toBeGreaterThan(0);
  expect(r.finalOff.slice(0, 5)).toEqual([]);
  // The finders found most of their hits themselves (unless the server must tell them all), and every report agreed
  if (found) expect(r.stats.own).toBeGreaterThan(r.stats.told);
  expect(r.stats.fixes).toBe(0);
  expect(r.off.slice(0, 5)).toEqual([]);
  expect(A.hits.stats.mismatches + C.hits.stats.mismatches).toBe(0);
  expect(A.reports).toBeGreaterThan(0);
  // The same damage, fires, impacts, detonations and removed shells as the server's record
  for (const f of [A, C]) expectShownAsServer(r, f);
}

describe('client-detected hits: finders see the fight the server had', () => {
  it('Pips on a freighter: parts shot away, the freighter dying', () => {
    const r = runFight({ hpScale: 0.02, ticks: 900 });
    expectAgree(r);
  }, 120_000);

  it('railgun: shells that pierce two freighters', () => {
    const r = runFight({ gun: 'railgun', ammo: 'railgun_slugs', hpScale: 0.5, behind: true });
    expectAgree(r);
  }, 120_000);

  it('magma: fire and a blast (the burning target rebuilds most snapshots: told)', () => {
    const r = runFight({ gun: 'magma_cannon' });
    expectAgree(r, false);
    expect(r.A.ignites.length).toBeGreaterThan(0);
  }, 120_000);

  it('a shielded freighter: the shield is the server\'s to tell', () => {
    const r = runFight({ shield: 400 });
    expectAgree(r, false);
    expect(r.stats.told).toBeGreaterThan(0);
  }, 120_000);

  it("a target coasting across the line of fire", () => {
    const r = runFight({ drift: 4, ticks: 600 });
    expectAgree(r);
  }, 120_000);
});

describe('client-detected hits: a forced mismatch is put right', () => {
  it('a shooter that throws away a third of its hits gets a correction, and its HP comes right', () => {
    const r = runFight({ ticks: 600, drop: (h) => third(h) });
    if (process.env.HITS_DEBUG) console.log(JSON.stringify({ rates: rates(r), dropped: r.A.dropped, A: r.A.selfHits.stats, offSnapshots: r.offSnapshots }));
    expect(r.A.dropped).toBeGreaterThan(0);
    expect(r.stats.fixes).toBeGreaterThan(0);
    expect(r.A.selfHits.stats.fixes).toBe(r.stats.fixes);
    expect(r.A.selfHits.stats.fixMissed).toBeGreaterThan(0);
    // The observer finding its own is unaffected
    expect(r.C.selfHits.stats.fixes).toBe(0);
    // Everyone's HP is the server's by the end
    expect(r.finalOff.slice(0, 5)).toEqual([]);
    // The missed hits were drawn from the correction: as many impacts as the server's shells struck
    expect(r.A.projectileHits).toBe(r.truth.impacts);
  }, 120_000);
});

describe('adaptive validation (part E, CAPS.ROUGH)', () => {
  it('a client that keeps agreeing goes ROUGH (fewer reports); a desync makes it STRICT, and it steps back down once clean', () => {
    // (it misses a third of its hits for a while, past its first clean stretch: a persistent desync)
    const t0 = 20 + 750, t1 = t0 + 150;
    const r = runFight({ ticks: 2400, hpScale: 40, drop: (h) => h.tick > t0 && h.tick < t1 && third(h) });
    const lvl = r.server.hits.levelOf(r.server.pilots.connOf(r.A.pid)! as never);
    if (process.env.HITS_DEBUG) console.log(JSON.stringify({ history: lvl.history, told: r.A.levels, rates: rates(r), dropped: r.A.dropped }));
    expect(r.A.dropped).toBeGreaterThan(0);
    const seq = lvl.history.map((h) => h[1]);
    // NORMAL -> ROUGH (clean) -> STRICT (the desync, corrected) -> NORMAL -> ROUGH (clean again)
    expect(seq).toEqual([CONFIRM.ROUGH, CONFIRM.STRICT, CONFIRM.NORMAL, CONFIRM.ROUGH]);
    // The client was told each change, and went by it
    expect(r.A.levels.slice(1).map((l) => l[1])).toEqual(seq);
    // Caught within a few seconds of the desync starting
    const strictAt = lvl.history[1][0];
    expect(strictAt - t0).toBeLessThan(240);
    // Corrected, and right in the end; the observer untouched
    expect(r.stats.fixes).toBeGreaterThan(0);
    expect(r.finalOff.slice(0, 5)).toEqual([]);
    expect(r.C.selfHits.stats.fixes).toBe(0);
    expect(r.A.projectileHits).toBe(r.truth.impacts);
    // STRICT told everything: while it lasted the shooter found nothing itself
    expect(r.stats.toldWhy.strict ?? 0).toBeGreaterThan(0);
  }, 180_000);
});

describe('client-detected hits: the layer and ids used again', () => {
  it("a spent shell's id, used again by the server, is a new shell on the layer", () => {
    const r = runFight({ ticks: 30 });
    const { A } = r;
    const me = A.store.get(A.pid)!;
    const gun = me.derived.weapons[0].part;
    const layer = new SelfHits({ store: A.store, self: () => A.pid, ships: () => [], at: () => null, side: () => 0, passes: () => 0 });
    const shells = (layer as unknown as { shells: Map<number, { spawnTick: number; dead: boolean }> }).shells;
    layer.setOn(true, 0);
    layer.addShell(77, A.pid, gun, 10, 0, 0, 5, 0);
    expect(shells.get(77)?.spawnTick).toBe(10);
    // (the same shell told again: kept as it is)
    shells.get(77)!.dead = true;
    layer.addShell(77, A.pid, gun, 10, 0, 0, 5, 0);
    expect(shells.get(77)?.dead).toBe(true);
    // (its id used again, never removed here: a new shell)
    layer.addShell(77, A.pid, gun, 50, 0, 0, 5, 0);
    expect(shells.get(77)).toMatchObject({ spawnTick: 50, dead: false });
    // Spent by a record: off the layer; a dropped one's id is free again too
    layer.spent([77]);
    expect(shells.has(77)).toBe(false);
    layer.addShell(78, A.pid, gun, 10, 0, 0, 5, 0);
    layer.drop(78);
    layer.addShell(78, A.pid, gun, 60, 0, 0, 5, 0);
    expect(shells.has(78)).toBe(false);
    layer.spent([78]);
    layer.addShell(78, A.pid, gun, 70, 0, 0, 5, 0);
    expect(shells.get(78)?.spawnTick).toBe(70);
    // Switched on again (a reconnect): shells already flying sit it out (the server tells their hits)
    layer.setOn(false, 80);
    layer.setOn(true, 80);
    expect(shells.size).toBe(0);
    layer.addShell(78, A.pid, gun, 90, 0, 0, 5, 0);
    expect(shells.has(78)).toBe(false);
  }, 120_000);
});
