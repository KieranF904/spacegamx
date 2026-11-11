/**
 * Station queues run jobs in parallel lanes: as many as the pilot has slots (the fabricator's from unlocks, skills and
 * the station's fabSlots perk; the refinery's from unlocks), the rest wait for the first lane to free up.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { setStationTable, queueSlots, unlocks, type PlayerProfile, type StationFile } from '@space-game/common';
import { StationServices } from './StationServices.js';

const T = 10_000;
const recipe = { id: 'widget', inputs: { ore: 1 }, out: { widget: 1 }, time: 10, starter: true };

function rig(opts: { outpost?: PlayerProfile['outpost'] } = {}) {
  let t = 1_000_000;
  const p = { level: 1, skills: {}, outpost: opts.outpost, jobs: [], storage: [{ id: 'ore', n: 99 }], cargo: [], recipes: [] } as unknown as PlayerProfile;
  const conn = {} as never;
  const gave: Record<string, number> = {};
  const pilots = {
    get: () => p, markDirty() {}, toast() {}, saveNow() {}, bumpStat() {},
    give: (_c: unknown, bag: Record<string, number>) => { for (const [k, n] of Object.entries(bag)) gave[k] = (gave[k] ?? 0) + n; return {}; },
  };
  const econ = {
    items: { name: (id: string) => id },
    recipes: { recipeFor: () => recipe, refining: { get: () => ({ id: 'plate', inputs: { ore: 1 }, out: 1, time: 10 }), has: () => false } },
  };
  const host = { now: () => t, stationAt: () => null, stationName: (id: string) => id, send() {} };
  const s = new StationServices(host as never, pilots as never, econ as never);
  const fab = (n = 1, at = 'a') => s.makeFor(conn, at, 'widget', n);
  const ref = (n = 1, at = 'a') => s.refineFor(conn, at, 'plate', n);
  return { s, p, conn, gave, fab, ref, advance: (ms: number) => { t += ms; }, now: () => t };
}

const perkTable = (fabSlots: number): StationFile => ({
  charter: { level: 1, credits: 0, items: {} }, sites: [],
  tracks: { fabricator: { name: 'Fab', group: 'x', about: '', tiers: [{ name: 'T1', cost: {}, minutes: 1, fabSlots }] } },
});
const station = { site: 'x', tracks: { fabricator: 1 } } as unknown as PlayerProfile['outpost'];

afterEach(() => setStationTable(undefined));

describe('station job lanes', () => {
  it('with one slot, jobs run one after another', () => {
    const r = rig();
    r.s['slots'] = () => 1;
    r.fab(); r.fab();
    const [a, b] = r.p.jobs;
    expect(a.readyAt - a.startedAt).toBe(T);
    expect(b.startedAt).toBe(a.readyAt);
    expect(b.readyAt).toBe(a.readyAt + T);
  });

  it('with two slots, two jobs finish together and a third waits for the first free lane', () => {
    const r = rig();
    r.s['slots'] = () => 2;
    r.fab(); r.fab(); r.fab();
    const [a, b, c] = r.p.jobs;
    expect(a.startedAt).toBe(r.now());
    expect(b.startedAt).toBe(r.now());
    expect(a.readyAt).toBe(b.readyAt);
    expect(c.startedAt).toBe(a.readyAt);
    expect(c.readyAt).toBe(a.readyAt + T);
  });

  it('queues are per station and per kind', () => {
    const r = rig();
    r.s['slots'] = () => 1;
    r.fab(1, 'a'); r.fab(1, 'b'); r.ref(1, 'a');
    expect(r.p.jobs.map((j) => j.startedAt)).toEqual([r.now(), r.now(), r.now()]);
  });

  it('the slot counts are the real ones: fabricator with the station perk, refinery from unlocks', () => {
    setStationTable(perkTable(3));
    const r = rig({ outpost: station });
    const fabN = queueSlots(r.p), refN = unlocks(r.p).refinerySlots;
    setStationTable(perkTable(0));
    expect(fabN).toBe(queueSlots(rig({ outpost: station }).p) + 3);
    setStationTable(perkTable(3));
    for (let i = 0; i < fabN; i++) r.fab();
    for (let i = 0; i < refN; i++) r.ref();
    // Every job fills its own lane: all start now
    expect(r.p.jobs.length).toBe(fabN + refN);
    expect(r.p.jobs.every((j) => j.startedAt === r.now())).toBe(true);
    // The queue is full for the fabricator (makeFor refuses); one more refinery job waits for a lane
    expect(r.fab()).toBe(0);
    r.ref();
    expect(r.p.jobs.filter((j) => j.recipe.startsWith('refine:')).pop()!.startedAt).toBe(r.now() + T);
  });

  it('the speed of a job still scales its runs', () => {
    const r = rig();
    r.s['slots'] = () => 2;
    r.fab(2);
    expect(r.p.jobs[0].unitMs).toBe(T);
    expect(r.p.jobs[0].readyAt).toBe(r.now() + 2 * T);
  });

  it('cancelling or holding a job re-lays the lanes', () => {
    const r = rig();
    r.s['slots'] = () => 2;
    r.fab(); r.fab(); r.fab();
    r.advance(4000);
    const [a, b, c] = r.p.jobs;
    r.s.jobAction(r.conn, a.id, 'cancel', true);
    // b keeps its progress; c takes the lane a left, starting now
    expect(r.p.jobs.map((j) => j.id)).toEqual([b.id, c.id]);
    expect(b.readyAt).toBe(r.now() + T - 4000);
    expect(c.startedAt).toBe(r.now());
    expect(c.readyAt).toBe(r.now() + T);
    // Holding b keeps its 4s, resuming puts it back in a lane
    r.s.jobAction(r.conn, b.id, 'pause', true);
    expect(b.heldMs).toBe(4000);
    r.s.jobAction(r.conn, b.id, 'resume', true);
    expect(b.readyAt).toBe(r.now() + T - 4000);
    expect(b.startedAt).toBe(r.now() - 4000);
  });

  it('delivers parallel progress, offline included', () => {
    const r = rig();
    r.s['slots'] = () => 2;
    r.fab(3); r.fab(3); r.fab(1);
    r.advance(3 * T + 1000); // two jobs done side by side; the third's lane just freed
    expect(r.s.deliver(r.conn)).toBe(true);
    expect(r.gave.widget).toBe(6);
    expect(r.p.jobs.map((j) => j.count - j.done)).toEqual([1]);
    r.advance(T);
    r.s.deliver(r.conn);
    expect(r.gave.widget).toBe(7);
    expect(r.p.jobs).toEqual([]);
  });
});
