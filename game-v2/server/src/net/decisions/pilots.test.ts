/**
 * The enemy AI's pilots as shared bodies (CAPS.PILOTS; common bodies/aiPilot.ts, server game/brains/aiPilot.ts,
 * docs/design/decision-inputs.md 6.5): Enemies' commander decides on the server (state, target, waypoint, strafe side,
 * aim error), the pilot flies each ship on both sides. A client's tick-aligned replica of every hostile it runs is the
 * server's ship bit for bit at every snapshot's tick (patrolling, closing in, strafing round it as a pack, breaking
 * off), with no control rows of it, for the pilot and for a second client watching; a lost decision is caught by the
 * check and put right.
 *
 * A real GameServer; the pilot (a fake client, full caps as every client) flies by input messages, on time, firing at
 * the nearest. The ground truth is the server's own ships, tick by tick.
 */
import { describe, it, expect } from 'vitest';
import { DECISION } from '@space-game/common';
import { fight } from '../../testkits/decisionFight.testkit.js';

describe('decision inputs: the enemy AI flown by its pilot\'s body on both sides (CAPS.PILOTS)', () => {
  it('a pirate fight: every hostile the client runs is the server\'s ship at every snapshot, no control rows of them, checks agreeing', () => {
    const r = fight({ ticks: 1200 });
    if (process.env.BODY_DEBUG) console.log('PILOTS', JSON.stringify({ got: { ...r.got.A, ran: [...r.got.A.ran] }, B: { ...r.got.B, ran: r.got.B.ran.size }, stats: r.stats, rep: r.rep, runner: r.A.bodies?.stats }));
    expect(r.got.A.ran.size).toBeGreaterThanOrEqual(3);
    expect(r.got.A.checked).toBeGreaterThan(500);
    expect(r.got.A.off).toBe(0);
    expect(r.got.A.ctlRows).toBe(0);
    expect(r.got.A.decisions).toBeGreaterThan(10);
    expect(r.stats.checks).toBeGreaterThan(10);
    expect(r.stats.off).toBe(0);
    // (keyframes of them: each one's first sight (its SYNC), and what their bodies don't model: the server's own count of
    // its bodied shadows leaving the ship, Replication.bodyStats, bounds the rest)
    expect(r.got.A.keyframes).toBeLessThanOrEqual(r.got.A.syncs + Object.values(r.rep.why).reduce((a, b) => a + b, 0) + 5);
    // The client watching from nearby: the same hostiles run, the server's ships too at every snapshot, no control rows
    expect(r.got.B.ran.size).toBeGreaterThanOrEqual(3);
    expect(r.got.B.checked).toBeGreaterThan(500);
    expect(r.got.B.off).toBe(0);
    expect(r.got.B.ctlRows).toBe(0);
  }, 240_000);

  it("EMP'd and slowed mid-fight (struck, then struck again before it wore off): a STATUS each, its body flies it crippled, no keyframe of it", () => {
    let foe = -1;
    const r = fight({
      ticks: 900,
      each: (t, server, foes) => {
        const ships = server.getShips();
        if (t === 300) { foe = foes[0]; ships.emp(foe, 90); }
        if (t === 350) ships.emp(foe, 120);
        if (t === 420 && foes[1] !== undefined) ships.slow(foes[1], 100);
      },
    });
    if (process.env.BODY_DEBUG) console.log('STATUS', JSON.stringify({ got: { ...r.got.A, ran: [...r.got.A.ran] }, stats: r.stats, rep: r.rep }));
    expect(r.got.A.ops[DECISION.STATUS] ?? 0).toBeGreaterThanOrEqual(3);
    expect(r.got.A.checked).toBeGreaterThan(300);
    expect(r.got.A.off).toBe(0);
    expect(r.stats.off).toBe(0);
    // (its shadow, as the clients running it fly it, never left the ship: no keyframe for what it was struck by, only
    // each one's first sight; nor of its pack's, whose bodies read it)
    expect(Object.values(r.rep.why).reduce((a, b) => a + b, 0)).toBe(0);
    // (the server's bodied keyframes, to both clients: each one's first sight of each, nothing else)
    expect(r.rep.keyframes).toBe(r.got.A.syncs + r.got.B.syncs);
    expect(r.stats.targetKeyed).toBe(0);
  }, 240_000);

  it('a decision lost: its check catches it, SYNCs put it right', () => {
    // (Lost where a check of its will see it off: dropped from 400, the one snapshot it put off was keyframed right again
    // (its target keyed) before a check came round, once the late-input quirk of the fake clients' reports stopped
    // sending a snapshot after every report: Stage 3b)
    const r = fight({ ticks: 800, dropAt: 450 });
    expect(r.stats.off).toBeGreaterThan(0);
    expect(r.got.A.off).toBeLessThan(60);
  }, 240_000);

  it("a boss the enemy AI flies (Rustjaw): it and the escorts its phases bring are the server's ships at every snapshot, no control rows", () => {
    const r = fight({ ticks: 1200, boss: 'boss_rustjaw', hurtAt: 300, hurt: 0.3 });
    if (process.env.BODY_DEBUG) console.log('RUSTJAW', JSON.stringify({ got: { ...r.got.A, ran: [...r.got.A.ran] }, stats: r.stats, rep: r.rep, runner: r.A.bodies?.stats, phase: r.server.bosses.of(r.boss)?.phase }));
    expect(r.got.A.ran.has(r.boss)).toBe(true);
    expect(r.got.A.ran.size).toBeGreaterThan(1);
    expect(r.got.A.checked).toBeGreaterThan(300);
    expect(r.got.A.off).toBe(0);
    expect(r.got.A.ctlRows).toBe(0);
    expect(r.stats.off).toBe(0);
  }, 240_000);

  it("a blinking boss (Hushwing): its blinks keyframe it, its flight between is its body's", () => {
    const r = fight({ ticks: 1200, boss: 'boss_hushwing', hurtAt: 200, hurt: 0.4 });
    if (process.env.BODY_DEBUG) console.log('HUSHWING', JSON.stringify({ got: { ...r.got.A, ran: [...r.got.A.ran] }, stats: r.stats, rep: r.rep, runner: r.A.bodies?.stats, phase: r.server.bosses.of(r.boss)?.phase }));
    expect(r.got.A.ran.has(r.boss)).toBe(true);
    expect(r.got.A.checked).toBeGreaterThan(300);
    expect(r.got.A.off).toBe(0);
    expect(r.got.A.ctlRows).toBe(0);
    expect(r.stats.off).toBe(0);
  }, 240_000);
});
