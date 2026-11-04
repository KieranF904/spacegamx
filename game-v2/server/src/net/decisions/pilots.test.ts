/**
 * The enemy AI's pilots as shared bodies (CAPS.PILOTS; common bodies/aiPilot.ts, server game/brains/aiPilot.ts,
 * docs/design/decision-inputs.md 6.5): Enemies' commander decides on the server (state, target, waypoint, strafe side,
 * aim error), the pilot flies each ship on both sides. A capable client's tick-aligned replica of every hostile it runs
 * is the server's ship bit for bit at every snapshot's tick (patrolling, closing in, strafing round it as a pack,
 * breaking off), with no control rows of it; a legacy observer gets them the old way; a lost decision is caught by the
 * check and put right; a client without CAPS.PILOTS runs none.
 *
 * A real GameServer; the pilot (a fake client with every cap) flies by input messages, on time, firing at the nearest.
 */
import { describe, it, expect } from 'vitest';
import { fight, BODIES } from '../../testkits/decisionFight.testkit.js';

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
    // (keyframes of them: the first, and what their bodies don't model)
    expect(r.got.A.keyframes).toBeLessThan(r.got.B.keyframes / 2 + 10);
    // The legacy observer: them the old way, no decisions
    expect(r.got.B.decisions).toBe(0);
    expect(r.got.B.running).toBe(0);
  }, 240_000);

  it('a decision lost: its check catches it, SYNCs put it right', () => {
    const r = fight({ ticks: 800, dropAt: 400 });
    expect(r.stats.off).toBeGreaterThan(0);
    expect(r.got.A.off).toBeLessThan(60);
  }, 240_000);

  it('a client with bodies but not CAPS.PILOTS runs none of them: their rows the old way', () => {
    const r = fight({ ticks: 500, caps: BODIES });
    expect(r.got.A.ran.size).toBe(0);
    expect(r.got.A.decisions).toBe(0);
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
