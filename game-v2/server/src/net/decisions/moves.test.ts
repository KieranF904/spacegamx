/**
 * Bodies' moves on both sides (decision-inputs stage 4, CAPS.MOVES; common bodies/moves): a capable pilot (every cap)
 * works out what a boss's or a custom enemy's moves draw and shoot from their decisions, and is sent none of it; a
 * legacy observer beside it is sent all of it. What the pilot was sent and what it worked out together are exactly what
 * the observer was sent (every telegraph and beam, the same numbers), and every straight shell it made is one the
 * server spawned (the same spawn tick, place and velocity). No body check fails.
 */
import { describe, it, expect } from 'vitest';
import { CAPS, Position, Velocity, type ServerMessage } from '@space-game/common';
import { fight, ALL } from '../../testkits/decisionFight.testkit.js';
import type { StagedBrain } from '../../game/brains/staged.js';
import type { GameServer } from '../../GameServer.js';

const MOVES = ALL | CAPS.WAYPOINTS | CAPS.LAUNCHES | CAPS.MOVES;
/** Looks every client in view is sent (not by nearness: detonations and launch flashes go to those near the point) */
const SHOWN = new Set(['bossTelegraph', 'bossBeam']);

/** A message as a key (its fields sorted: a decoded one's come in the codec's order) */
const key = (m: ServerMessage) => JSON.stringify(Object.fromEntries(Object.entries(m).sort(([a], [b]) => (a < b ? -1 : 1))));

/** What's in `a` and not in `b`, as multisets */
function less(a: string[], b: string[]): string[] {
  const n = new Map<string, number>();
  for (const k of b) n.set(k, (n.get(k) ?? 0) + 1);
  const out: string[] = [];
  for (const k of a) { const c = n.get(k) ?? 0; if (c) n.set(k, c - 1); else out.push(k); }
  return out;
}

/** The server's move shells as they were spawned: [spawn tick, x, y, vx, vy, owner] by id */
function spawned(server: GameServer): Map<number, number[]> {
  const out = new Map<number, number[]>();
  const b = server.bodies as unknown as { moveShell(id: number, owner: number, o: unknown): void };
  const orig = b.moveShell.bind(server.bodies);
  b.moveShell = (id, owner, o) => { out.set(id, [server.getTick(), Position.x[id], Position.y[id], Velocity.x[id], Velocity.y[id], owner]); orig(id, owner, o); };
  return out;
}

function compare(r: ReturnType<typeof fight>, shells: Map<number, number[]>) {
  // (the last half second left out: what the observer was sent then, the pilot works out at its next snapshot, after the run)
  const cut = r.A.snapTick - 30, early = (x: { tick: number }) => x.tick <= cut;
  const shown = (l: { tick: number; msg: ServerMessage }[]) => l.filter((x) => SHOWN.has(x.msg.type));
  const legacy = shown(r.B.fxSent), sent = shown(r.A.fxSent), made = shown(r.A.fxMade), mine = [...sent, ...made];
  const keys = (l: { msg: ServerMessage }[]) => l.map((x) => key(x.msg));
  const all = new Set([...shells.values()].map((s) => s.slice(0, 5).join(',')));
  const shellsOff = r.A.shellsMade.filter((s) => !all.has([s.tick, s.x, s.y, s.vx, s.vy].join(',')));
  const out = {
    legacy: legacy.length, sent: sent.length, made: made.length,
    missing: less(keys(legacy.filter(early)), keys(mine)), extra: less(keys(mine.filter(early)), keys(legacy)),
    shellsMade: r.A.shellsMade.length, shellsOff, server: shells.size,
  };
  if (process.env.MOVES_DEBUG) console.log('MOVES', JSON.stringify({ ...out, missing: out.missing.slice(0, 3), extra: out.extra.slice(0, 3), runner: r.A.moves?.stats, stats: r.stats }));
  return out;
}

/**
 * A staged boss's fight moved on a stage at each of these ticks (the dev shed), held still a second after each (the
 * shed's recentring reaches the client with its keyframe: a move started on the very next tick reads her where she was)
 */
function stagedFight(boss: string, ticks: number, stagesAt: number[]) {
  let brain: (StagedBrain & { stage: number }) | null = null, shells = new Map<number, number[]>(), release = -1;
  const r = fight({
    boss, caps: MOVES, ticks,
    each: (t, server) => {
      if (t === 0) {
        shells = spawned(server);
        const id = [...server.getShips().bodies.keys()].find((e) => server.bosses.brainOf(e));
        brain = (id !== undefined ? server.bosses.brainOf(id) : null) as never;
        // (tough: the pilot's shots mustn't strip it)
        if (id !== undefined) server.getShips().scaleHp(id, 40);
      }
      if (!brain) return;
      if (stagesAt[0] === t) {
        stagesAt.shift();
        const st = brain.stage;
        for (let n = 1; n < 400 && brain.stage === st; n++) brain.forceShed(n);
        brain.devHold = true;
        release = t + 60;
      }
      if (t === release) brain.devHold = false;
    },
  });
  return { r, c: compare(r, shells) };
}

describe('decision-inputs stage 4: bodies\' moves worked out on the client (CAPS.MOVES)', () => {
  it('the Scrap Mother through her three stages: every tell, beam and shell the pilot works out is the server\'s', () => {
    const { r, c } = stagedFight('boss_scrap_mother', 2100, [700, 1400]);
    expect(c.missing, 'looks the observer got that the pilot neither got nor worked out').toEqual([]);
    expect(c.extra, 'looks the pilot worked out that never were').toEqual([]);
    // (most of them worked out, not sent)
    expect(c.made).toBeGreaterThan(c.sent * 2);
    expect(c.made).toBeGreaterThan(40);
    expect(c.shellsOff).toEqual([]);
    expect(c.shellsMade).toBeGreaterThan(50);
    expect(r.stats.shellsDerived).toBe(c.shellsMade);
    // (its body never put right)
    expect(r.stats.off).toBe(0);
    expect(r.got.A.off).toBe(0);
  }, 240_000);

  it('the Pyreclast through its three stages', () => {
    const { r, c } = stagedFight('boss_pyreclast', 2700, [900, 1800]);
    expect(c.missing).toEqual([]);
    expect(c.extra).toEqual([]);
    expect(c.made).toBeGreaterThan(c.sent * 2);
    expect(c.shellsOff).toEqual([]);
    expect(c.shellsMade).toBeGreaterThan(50);
    expect(r.stats.shellsDerived).toBe(c.shellsMade);
    expect(r.stats.off).toBe(0);
    expect(r.got.A.off).toBe(0);
  }, 240_000);

  it('custom enemies: their moves\' lines, rings, beams and shells', () => {
    let shells = new Map<number, number[]>();
    const r = fight({
      caps: MOVES, ticks: 1500, prey: true,
      packs: [
        { ships: ['cinder_zealot', 'maw_lurker', 'hookboat'], dx: 1300, dy: 700 },
        { ships: ['slag_ray', 'clinker', 'scrap_darter'], dx: -1300, dy: 700 },
      ],
      each: (t, server) => { if (t === 0) shells = spawned(server); },
    });
    const c = compare(r, shells);
    expect(c.missing).toEqual([]);
    expect(c.extra).toEqual([]);
    expect(c.made).toBeGreaterThan(10);
    expect(c.shellsOff).toEqual([]);
    expect(r.stats.off).toBe(0);
    expect(r.got.A.off).toBe(0);
  }, 240_000);
});
