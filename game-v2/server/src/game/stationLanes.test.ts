/**
 * Station queues run jobs in parallel lanes (as many as jobLanes: one, plus one per engineering milestone), the rest
 * wait for a lane. The queue has no length limit, and an order takes its inputs when a lane starts it, not when it's
 * queued: one short of materials waits without holding up the ones behind it, and starts as the materials arrive.
 */
import { describe, it, expect } from 'vitest';
import { jobLanes, type PlayerProfile } from '@space-game/common';
import { StationServices } from './StationServices.js';

const T = 10_000;
const recipes: Record<string, { id: string; inputs: Record<string, number>; out: Record<string, number>; time: number; starter: boolean }> = {
  widget: { id: 'widget', inputs: { ore: 1 }, out: { widget: 1 }, time: 10, starter: true },
  gizmo: { id: 'gizmo', inputs: { plate: 1 }, out: { gizmo: 1 }, time: 10, starter: true },
};
const refining: Record<string, { id: string; inputs: Record<string, number>; out: number; time: number }> = {
  plate: { id: 'plate', inputs: { ore: 1 }, out: 1, time: 10 },
};

function rig(opts: { ore?: number } = {}) {
  let t = 1_000_000;
  const bag: Record<string, number> = { ore: opts.ore ?? 99 };
  const p = { level: 1, skills: {}, jobs: [], cargo: [], recipes: [] } as unknown as PlayerProfile;
  Object.defineProperty(p, 'storage', { get: () => Object.entries(bag).filter(([, n]) => n > 0).map(([id, n]) => ({ id, n })) });
  const conn = {} as never;
  const pilots = {
    get: () => p, markDirty() {}, toast() {}, saveNow() {}, bumpStat() {},
    give: (_c: unknown, items: Record<string, number>) => { for (const [k, n] of Object.entries(items)) bag[k] = (bag[k] ?? 0) + n; return {}; },
    take: (_c: unknown, need: Record<string, number>) => {
      if (Object.entries(need).some(([k, n]) => (bag[k] ?? 0) < n)) return false;
      for (const [k, n] of Object.entries(need)) bag[k] -= n;
      return true;
    },
    available: (_c: unknown, id: string) => bag[id] ?? 0,
  };
  const econ = {
    items: { name: (id: string) => id },
    recipes: { recipeFor: (id: string) => recipes[id] ?? null, refining: { get: (id: string) => refining[id], has: (id: string) => id in refining } },
  };
  const host = { now: () => t, stationAt: () => null, stationName: (id: string) => id, send() {} };
  const s = new StationServices(host as never, pilots as never, econ as never);
  return {
    s, p, conn, bag,
    fab: (n = 1, at = 'a', id = 'widget') => s.makeFor(conn, at, id, n),
    ref: (n = 1, at = 'a') => s.refineFor(conn, at, 'plate', n),
    go: () => s.deliver(conn),
    advance: (ms: number) => { t += ms; },
    now: () => t,
    state: (j: PlayerProfile['jobs'][number]) => (s as unknown as { jobState(p: unknown, j: unknown): { wait?: string; short?: string } }).jobState(p, j),
  };
}

describe('station job lanes', () => {
  it('with one lane, jobs run one after another', () => {
    const r = rig();
    r.fab(); r.fab();
    r.go();
    const [a, b] = r.p.jobs;
    expect(a.readyAt - a.startedAt).toBe(T);
    expect(b.taken).toBe(0);
    r.advance(T + 500);
    r.go();
    // b starts the moment a's lane came free, not when the second was noticed
    expect(r.p.jobs.length).toBe(1);
    expect(b.startedAt).toBe(a.readyAt);
    expect(b.readyAt).toBe(a.readyAt + T);
  });

  it('with two lanes, two jobs run together and a third waits for the first free lane', () => {
    const r = rig();
    r.s['slots'] = () => 2;
    r.fab(); r.fab(); r.fab();
    r.go();
    const [a, b, c] = r.p.jobs;
    expect(a.startedAt).toBe(r.now());
    expect(b.startedAt).toBe(r.now());
    expect(c.taken).toBe(0);
    expect(r.state(c)).toEqual({ wait: 'lane' });
    r.advance(T);
    r.go();
    expect(r.p.jobs).toEqual([c]);
    expect(c.startedAt).toBe(a.readyAt);
  });

  it('queues are per station and per kind', () => {
    const r = rig();
    r.fab(1, 'a'); r.fab(1, 'b'); r.ref(1, 'a');
    r.go();
    expect(r.p.jobs.map((j) => j.startedAt)).toEqual([r.now(), r.now(), r.now()]);
  });

  it('lanes rise with engineering ranks (2, 5, 9 points) to 4, for the refinery and the fabricator', () => {
    expect([0, 1, 2, 4, 5, 8, 9, 20].map((e) => jobLanes({ skills: { engineering: e } }))).toEqual([1, 1, 2, 2, 3, 3, 4, 4]);
    const r = rig();
    r.p.skills = { engineering: 5 };
    for (let i = 0; i < 4; i++) { r.fab(); r.ref(); }
    r.go();
    for (const refine of [false, true]) {
      const js = r.p.jobs.filter((j) => j.recipe.startsWith('refine:') === refine);
      expect(js.slice(0, 3).every((j) => j.taken === 1 && j.startedAt === r.now())).toBe(true);
      expect(js[3].taken).toBe(0);
    }
  });

  it('there is no limit on the queue: twenty orders and more all queue, whatever is in hand', () => {
    const r = rig({ ore: 3 });
    for (let i = 0; i < 25; i++) expect(r.fab()).toBe(1);
    for (let i = 0; i < 25; i++) expect(r.ref()).toBe(1);
    expect(r.p.jobs.length).toBe(50);
    r.go();
    // Only what the ore covers has started (3 ore: one lane each, the first widget and the first plate); nothing was taken when queued
    expect(r.bag.ore).toBe(1);
    expect(r.p.jobs.filter((j) => (j.taken ?? 0) > 0).length).toBe(2);
  });

  it('an order without materials waits (naming what is short) and starts when they arrive', () => {
    const r = rig({ ore: 0 });
    r.fab(3);
    r.go();
    const [j] = r.p.jobs;
    expect(j.taken).toBe(0);
    expect(r.state(j)).toEqual({ wait: 'materials', short: '1 × ore' });
    // Nothing is taken for it before it starts
    r.s.deliver(r.conn);
    expect(j.taken).toBe(0);
    r.bag.ore = 2;
    r.advance(1000);
    r.go();
    // It starts as many runs as the ore covers
    expect(j.taken).toBe(2);
    expect(j.startedAt).toBe(r.now());
    expect(r.bag.ore).toBe(0);
    expect(r.state(j)).toEqual({});
    // More ore arrives mid-run: the last run goes on the end of it
    r.bag.ore = 1;
    r.advance(1000);
    r.go();
    expect(j.taken).toBe(3);
    expect(j.readyAt).toBe(j.startedAt + 3 * T);
    r.advance(3 * T);
    r.go();
    expect(r.bag.widget).toBe(3);
    expect(r.p.jobs).toEqual([]);
  });

  it('an order waiting for materials does not block the one behind it', () => {
    const r = rig();
    r.fab(1, 'a', 'gizmo'); // needs plate: none
    r.fab(1, 'a', 'widget');
    r.go();
    const [g, w] = r.p.jobs;
    expect(g.taken).toBe(0);
    expect(r.state(g).wait).toBe('materials');
    expect(w.taken).toBe(1);
    expect(w.startedAt).toBe(r.now());
    // Plate arrives: the gizmo goes in the lane the widget frees (first come, first served among those that can start)
    r.bag.plate = 1;
    r.advance(500);
    r.go();
    expect(g.taken).toBe(0); // (the lane is busy with the widget)
    expect(r.state(g)).toEqual({ wait: 'lane' });
    r.advance(T);
    r.go();
    expect(g.taken).toBe(1);
    expect(g.startedAt).toBe(w.readyAt);
  });

  it('a refine feeds the fabrication queued behind it: the chain runs to the end', () => {
    const r = rig({ ore: 3 });
    // The fabrication is queued first, and the refining it needs after it
    r.fab(3, 'a', 'gizmo');
    r.ref(3);
    r.go();
    const [g, p] = r.p.jobs;
    expect(g.taken).toBe(0);
    expect(p.taken).toBe(3);
    // The refine finishes all three batches (30s); the gizmos start then, not before
    r.advance(3 * T + 200);
    r.go();
    expect(r.bag.plate ?? 0).toBe(0);
    expect(g.taken).toBe(3);
    expect(g.startedAt).toBe(p.readyAt);
    r.advance(3 * T);
    r.go();
    expect(r.bag.gizmo).toBe(3);
    expect(r.p.jobs).toEqual([]);
  });

  it('a chain finished while away starts the next stage when the first one ended, not when the pilot logs in', () => {
    const r = rig({ ore: 2 });
    r.fab(2, 'a', 'gizmo');
    r.ref(2);
    r.go();
    const refined = r.p.jobs[1];
    // Away for an hour: one login's deliver does both stages
    r.advance(3_600_000);
    r.go();
    expect(r.bag.gizmo).toBe(2);
    expect(r.p.jobs).toEqual([]);
    expect(refined.done).toBe(2);
  });

  it('cancelling refunds only the runs that were taken', () => {
    const r = rig({ ore: 4 });
    r.fab(10);
    r.go();
    const [j] = r.p.jobs;
    expect(j.taken).toBe(4);
    expect(r.bag.ore).toBe(0);
    r.advance(T * 1.5); // one run delivered, one under way
    r.s.jobAction(r.conn, j.id, 'cancel', true);
    // Three runs' ore back (the 3 taken and not delivered); the six never started cost nothing
    expect(r.bag.ore).toBe(3);
    expect(r.bag.widget).toBe(1);
    expect(r.p.jobs).toEqual([]);
    // Nothing was taken for an order that never started: nothing comes back
    r.bag.ore = 0;
    r.fab(5);
    r.s.jobAction(r.conn, r.p.jobs[0].id, 'cancel', true);
    expect(r.bag.ore).toBe(0);
  });

  it('a held job frees its lane for the next, and keeps its progress', () => {
    const r = rig();
    r.fab(); r.fab();
    r.go();
    const [a, b] = r.p.jobs;
    r.advance(4000);
    r.s.jobAction(r.conn, a.id, 'pause', true);
    expect(a.heldMs).toBe(4000);
    // The held one starts nothing; b takes the lane (the call-off and hold paths deliver as they go: here the tick does)
    r.go();
    expect(b.taken).toBe(1);
    expect(b.startedAt).toBe(r.now());
    r.s.jobAction(r.conn, a.id, 'resume', true);
    // a is back in its place at the front: its 4s are kept, b waits behind it
    expect(a.startedAt).toBe(r.now() - 4000);
    expect(a.readyAt).toBe(r.now() + T - 4000);
    expect(b.startedAt).toBe(a.readyAt);
  });

  it('the speed of a job still scales its runs', () => {
    const r = rig();
    r.s['slots'] = () => 2;
    r.fab(2);
    r.go();
    expect(r.p.jobs[0].unitMs).toBe(T);
    expect(r.p.jobs[0].readyAt).toBe(r.now() + 2 * T);
  });

  it('delivers parallel progress, offline included', () => {
    const r = rig();
    r.s['slots'] = () => 2;
    r.fab(3); r.fab(3); r.fab(1);
    r.go();
    r.advance(3 * T + 1000); // two jobs done side by side; the third started as their lanes freed
    expect(r.s.deliver(r.conn)).toBe(true);
    expect(r.bag.widget).toBe(6);
    expect(r.p.jobs.map((j) => j.count - j.done)).toEqual([1]);
    r.advance(T);
    r.s.deliver(r.conn);
    expect(r.bag.widget).toBe(7);
    expect(r.p.jobs).toEqual([]);
  });

  it('a saved job from before (no taken count) is all paid for', () => {
    const r = rig({ ore: 0 });
    r.p.jobs.push({ id: 1, recipe: 'widget', station: 'a', out: { widget: 1 }, count: 3, done: 0, unitMs: T, startedAt: r.now(), readyAt: r.now() + 3 * T });
    r.advance(T);
    r.go();
    expect(r.bag.widget).toBe(1);
    r.s.jobAction(r.conn, 1, 'cancel', true);
    // Two unfinished runs' ore back, as it always was
    expect(r.bag.ore).toBe(2);
  });
});
