/**
 * Pull fields (common sim/pullFields.ts; game-wide C3, track B): every pull on a pilot is worked out in the pilot's step
 * on every end, from a field sent once, not sent as its push tick by tick. Through a Scrap Mother's haul and intake, a
 * Scrap Crawler's magnet, a Hookboat's reel and a collapsing star, the pilot's own tick layer and each client's replica
 * of the other pilot are the server's ship bit for bit at every snapshot's tick, and pulls are told (PULL causes) only
 * where a client can't work them out: a puller it doesn't hold as the server had it (a keyframe of the puller due).
 */
import { describe, it, expect } from 'vitest';
import { Position, Velocity, Rotation, InSystem, PULL_FIELD } from '@space-game/common';
import type { GameServer } from '../../GameServer.js';
import type { FakeHitsClient } from '../hits/fakeHitsClient.testkit.js';
import { fight, type Opts } from '../../testkits/decisionFight.testkit.js';
import type { StagedBrain } from '../../game/brains/staged.js';

type State = [number, number, number, number, number, number];

/** A fight with both pilots checked at every snapshot's tick: A's own ship (its tick layer), A's replica of B, B's of A */
function pulledFight(o: Opts & { setup?: (t: number, server: GameServer, c: { A: FakeHitsClient; B: FakeHitsClient }) => void }) {
  const truth = new Map<number, Map<number, State>>();
  const seen = { A: -1, B: -1 };
  const check = { checked: 0, off: 0, offAt: [] as string[] };
  let server: GameServer | null = null;
  const real = (id: number): State => [Position.x[id], Position.y[id], Velocity.x[id], Velocity.y[id], Rotation.angle[id], server!.getShips().get(id)?.angVel ?? 0];
  const same = (a: { x: number; y: number; vx: number; vy: number; angle: number; angVel: number } | undefined, b: State | undefined) =>
    !!a && !!b && a.x === b[0] && a.y === b[1] && a.vx === b[2] && a.vy === b[3] && a.angle === b[4] && a.angVel === b[5];
  const compare = (who: 'A' | 'B', f: FakeHitsClient, ids: number[]) => {
    const T = f.snapTick;
    if (T <= seen[who]) return;
    seen[who] = T;
    const tr = truth.get(T);
    if (!tr) return;
    for (const id of ids) {
      const st = f.reps.at(id, T)?.body, r = tr.get(id);
      if (!st || !r) continue;
      check.checked++;
      if (!same(st, r)) { check.off++; if (check.offAt.length < 6) check.offAt.push(`${who} sees ${id}@${T}: ${[st.x - r[0], st.y - r[1], st.vx - r[2], st.vy - r[3]].map((v) => +v.toPrecision(3)).join(',')}`); }
    }
  };
  const r = fight({
    ...o,
    each: (t, s, foes, cl) => {
      server = s;
      o.each?.(t, s, foes, cl);
      o.setup?.(t, s, cl);
      const { A, B } = cl;
      const m = new Map<number, State>();
      for (const id of [A.pid, B.pid]) m.set(id, real(id));
      truth.set(s.getTick(), m);
      truth.delete(s.getTick() - 400);
      compare('A', A, [A.pid, B.pid]);
      compare('B', B, [A.pid, B.pid]);
    },
  });
  return { ...r, check };
}

/** The server's counts of pulls on pilots: worked out in their steps, told to the pilot about its own ship, left untold */
function counts(server: GameServer) {
  const rep = server.replication, p = server.getShips().pulls;
  return { applied: p.stats.pulls, fields: p.stats.opened, kinds: p.stats.kinds, records: p.stats.sent, ownTold: rep.ownStats.pull, ownDerived: rep.ownStats.pullDerived, ownZero: rep.ownStats.pullZero, othersDerived: rep.causeStats.pullDerived };
}

describe('pull fields: pulls on pilots worked out in their steps on every end', () => {
  it('the Scrap Mother\'s haul and intake: both pilots exact at every snapshot, the pulls not sent', () => {
    let brain: (StagedBrain & { stage: number }) | null = null;
    const r = pulledFight({
      boss: 'boss_scrap_mother', ticks: 2000,
      each: (t, server) => {
        if (t === 0) {
          const id = [...server.getShips().bodies.keys()].find((e) => server.bosses.brainOf(e));
          brain = (id !== undefined ? server.bosses.brainOf(id) : null) as never;
          if (id !== undefined) server.getShips().scaleHp(id, 40);
        }
        // (her second stage halfway: the intake)
        if (brain && t === 1000) { const st = brain.stage; for (let n = 1; n < 400 && brain.stage === st; n++) brain.forceShed(n); }
      },
    });
    const c = counts(r.server);
    if (process.env.PULL_DEBUG) console.log('MOTHER', JSON.stringify({ c, check: r.check, own: r.A.own.stats }));
    expect(c.kinds[PULL_FIELD.CONE] ?? 0).toBeGreaterThan(0);
    expect(c.kinds[PULL_FIELD.LANE] ?? 0).toBeGreaterThan(0);
    expect(c.applied).toBeGreaterThan(100);
    expect(r.check.checked).toBeGreaterThan(100);
    expect(r.check.off, r.check.offAt.join(' | ')).toBe(0);
    // (and every body the pilot runs, the pullers among them, is the server's ship at every snapshot: its body's check never fails)
    expect(r.got.A.off, r.got.A.offAt.join(' | ')).toBe(0);
    expect(r.stats.off).toBe(0);
    // (her pulls on the pilot's own ship worked out on its layer, nearly all; told only round a keyframe of her)
    expect(c.ownDerived).toBeGreaterThan(50);
    expect(c.ownTold).toBeLessThan(c.ownDerived / 4);
    expect(r.A.pullRecords).toBeGreaterThan(0);
  }, 300_000);

  it('a Hookboat\'s reel and a Scrap Crawler\'s magnet: exact at every snapshot, the pulls not sent', () => {
    const r = pulledFight({
      ticks: 1800, prey: true,
      packs: [
        { ships: ['pirate_raider', 'pirate_raider'], dx: 900, dy: 500, faction: 'pirates' },
        { ships: ['scrap_crawler', 'scrap_crawler'], dx: -800, dy: 400, faction: 'scrapborn' },
      ],
    });
    const c = counts(r.server), moves = r.server.enemies.custom.stats.moves;
    if (process.env.PULL_DEBUG) console.log('CUSTOM', JSON.stringify({ c, check: r.check, moves }));
    expect(moves['hookboat.harpoon'] ?? 0).toBeGreaterThan(0);
    expect(moves['scrap_crawler.pull'] ?? 0).toBeGreaterThan(0);
    // (a tether struck, and a magnet drawing: a field of each)
    expect(c.kinds[PULL_FIELD.REEL] ?? 0).toBeGreaterThan(0);
    expect(c.kinds[PULL_FIELD.POINT] ?? 0).toBeGreaterThan(0);
    expect(c.applied).toBeGreaterThan(50);
    expect(r.check.checked).toBeGreaterThan(100);
    expect(r.check.off, r.check.offAt.join(' | ')).toBe(0);
    // (and every body the pilot runs, the pullers among them, is the server's ship at every snapshot: its body's check never fails)
    expect(r.got.A.off, r.got.A.offAt.join(' | ')).toBe(0);
    expect(r.stats.off).toBe(0);
    expect(c.ownDerived + c.othersDerived).toBeGreaterThan(c.ownTold * 4);
  }, 300_000);

  it('a puller moved on the server alone mid-pull (its keyframe due): the pulls of those ticks told, both pilots still exact', () => {
    let moved = 0;
    const r = pulledFight({
      ticks: 1500, prey: true,
      packs: [{ ships: ['scrap_crawler', 'scrap_crawler', 'pirate_raider'], dx: -800, dy: 400, faction: 'scrapborn' }],
      each: (t, server, _foes, cl) => {
        if (t % 23 !== 0) return;
        // (every puller pulling now shoved a little where no client can see it: its shadows are off till its keyframe)
        const sys = InSystem.systemId[cl.A.pid];
        for (const f of server.getShips().pulls.activeAt(sys, server.getTick() + 1)) {
          if (!server.getShips().has(f.from)) continue;
          Position.x[f.from] += 7;
          moved++;
        }
      },
    });
    const c = counts(r.server);
    if (process.env.PULL_DEBUG) console.log('SHOVED', JSON.stringify({ c, moved, check: r.check, A: r.A.pid, B: r.B.pid, causeStats: r.server.replication.causeStats, why: r.server.replication.reasons }));
    expect(moved).toBeGreaterThan(5);
    expect(c.applied).toBeGreaterThan(50);
    // (the shoved ticks' pulls told, the rest worked out)
    expect(c.ownTold + c.ownZero).toBeGreaterThan(0);
    expect(c.ownDerived).toBeGreaterThan(c.ownTold);
    expect(r.check.off, r.check.offAt.join(' | ')).toBe(0);
    // (and every body the pilot runs, the pullers among them, is the server's ship at every snapshot: its body's check never fails)
    expect(r.got.A.off, r.got.A.offAt.join(' | ')).toBe(0);
    expect(r.stats.off).toBe(0);
  }, 300_000);

  it('a collapsing star parked by the watcher: the pilot drawn in on every end, its field one record', () => {
    const r = pulledFight({
      ticks: 600, packs: [],
      setup: (t, server, cl) => {
        const s = server as unknown as { weapons: { spawn(...a: unknown[]): number } };
        if (t !== 100) return;
        // (from beside the watcher, aimed to park 500 off the pilot)
        const a = cl.A.pid, b = cl.B.pid, x = Position.x[b], y = Position.y[b], tx = Position.x[a] + 500, ty = Position.y[a];
        s.weapons.spawn(b, 'singularity', x, y, Math.atan2(ty - y, tx - x), 1, { speedScale: 1, sizeScale: 1, turret: false, reach: Math.hypot(tx - x, ty - y) });
      },
    });
    const c = counts(r.server);
    if (process.env.PULL_DEBUG) console.log('STAR', JSON.stringify({ c, check: r.check }));
    expect(c.fields).toBe(1);
    expect(c.applied).toBeGreaterThan(50);
    expect(r.check.off, r.check.offAt.join(' | ')).toBe(0);
    // (and every body the pilot runs, the pullers among them, is the server's ship at every snapshot: its body's check never fails)
    expect(r.got.A.off, r.got.A.offAt.join(' | ')).toBe(0);
    expect(r.stats.off).toBe(0);
    // (a star reads nothing but its record: never told)
    expect(c.ownTold).toBe(0);
    expect(c.ownDerived).toBeGreaterThan(50);
  }, 300_000);
});
