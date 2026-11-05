import { describe, it, expect } from 'vitest';
import { WINDOW, openWindow, windowOpen, staggered, windowTaken, noteWindowDamage, windowFill, windowFillStep, restBeat, windowOver } from './windows.js';
import { personalCap, rollPersonal, pruneDraws, type PersonalRules, type PersonalDraw } from './personal.js';
import { LIFE, healProgress, lifeRise, lifeEngageable } from './lifecycle.js';
import { gatePieces, insideArena, nearGate, passPoint, withArenaGates, GATE, type ArenaDef } from '../world/gates.js';
import { buildTerrain, collideTerrain, rayTerrain, insideTerrain } from '../terrain.js';

describe('windows', () => {
  it('takes x2 inside, x0.35 outside, tick exact', () => {
    const w = openWindow({ ticks: 300, cap: 1000 }, 100);
    expect(windowTaken(null, 100)).toBe(WINDOW.outside);
    expect(windowTaken(w, 99)).toBe(WINDOW.outside);
    expect(windowTaken(w, 100)).toBe(WINDOW.inside);
    expect(windowTaken(w, 399)).toBe(WINDOW.inside);
    expect(windowTaken(w, 400)).toBe(WINDOW.outside);
    expect(windowOver(w, 399)).toBe(false);
    expect(windowOver(w, 400)).toBe(true);
  });

  it('counts the cap and cracks once, with a bonus of 10% of the cap', () => {
    const w = openWindow({ ticks: 300, cap: 1000 }, 0);
    expect(noteWindowDamage(w, 400, 10)).toBe(0);
    expect(windowFill(w)).toBeCloseTo(0.4);
    expect(windowFillStep(w)).toBe(12);
    expect(noteWindowDamage(w, 700, 20)).toBe(100);
    expect(w.filled).toBe(1000);
    expect(w.crackAt).toBe(20);
    // (cracked: a stagger for the rest of its time, at the outside rate, and no second crack)
    expect(windowOpen(w, 21)).toBe(false);
    expect(staggered(w, 21)).toBe(true);
    expect(windowTaken(w, 21)).toBe(WINDOW.outside);
    expect(noteWindowDamage(w, 5000, 30)).toBe(0);
    expect(staggered(w, 300)).toBe(false);
  });

  it('ignores damage outside the window', () => {
    const w = openWindow({ ticks: 60, cap: 100 }, 50);
    expect(noteWindowDamage(w, 500, 49)).toBe(0);
    expect(noteWindowDamage(w, 500, 110)).toBe(0);
    expect(w.filled).toBe(0);
  });

  it('opens with a rest beat', () => {
    const w = openWindow({ ticks: 600, cap: 100 }, 0);
    expect(restBeat(w, 0)).toBe(true);
    expect(restBeat(w, WINDOW.rest - 1)).toBe(true);
    expect(restBeat(w, WINDOW.rest)).toBe(false);
  });
});

describe('personal attacks', () => {
  const rules: PersonalRules = { beat: 120, chance: 0.2, pool: [['a', 'b'], ['c', 'd', 'e']], ticks: 240 };

  it('the loose cap: max(2, ceil(n/2)), never more than 6', () => {
    expect([0, 1, 2, 3, 4, 5, 8, 12, 20].map(personalCap)).toEqual([0, 2, 2, 2, 2, 3, 4, 6, 6]);
  });

  it('holds the cap at 1, 4 and 12 pilots over many beats', () => {
    for (const n of [1, 4, 12]) {
      const draws: PersonalDraw[] = [];
      let total = 0, maxRun = 0;
      for (let t = 0; t < 120 * 2000; t += 120) {
        const running = pruneDraws(draws, t);
        const got = rollPersonal(rules, 1, 0xabc, t, n, running, false);
        for (const d of got) { expect(d.slot).toBeGreaterThanOrEqual(0); expect(d.slot).toBeLessThan(n); expect(d.attack).toBeLessThan(2); }
        draws.push(...got);
        total += got.length;
        maxRun = Math.max(maxRun, draws.length);
      }
      expect(maxRun).toBeLessThanOrEqual(personalCap(n));
      // (luck, not a rotation: about chance x pilots a beat, until the cap bites)
      if (n === 1) expect(total / 2000).toBeGreaterThan(0.12);
      if (n === 12) expect(maxRun).toBe(personalCap(12));
    }
  });

  it('starts none while held, nor between beats', () => {
    for (let t = 0; t < 120 * 100; t += 120) expect(rollPersonal({ ...rules, chance: 1 }, 1, 1, t, 4, 0, true)).toEqual([]);
    expect(rollPersonal({ ...rules, chance: 1 }, 1, 1, 121, 4, 0, false)).toEqual([]);
  });

  it('is the same roll for the same seed, tick and slot, and draws from its stage pool', () => {
    const a = rollPersonal({ ...rules, chance: 1 }, 2, 77, 240, 6, 0, false);
    const b = rollPersonal({ ...rules, chance: 1 }, 2, 77, 240, 6, 0, false);
    expect(a).toEqual(b);
    expect(a.length).toBe(3);
    for (const d of a) expect(d.attack).toBeLessThan(3);
  });
});

describe('lifecycle', () => {
  it('heals to full LIFE.heal ticks after the heal starts', () => {
    expect(healProgress(1000, 1000)).toBe(0);
    expect(healProgress(1000, 1000 + LIFE.heal / 2)).toBeCloseTo(0.5);
    expect(healProgress(1000, 1000 + LIFE.heal)).toBe(1);
    expect(healProgress(1000, 1000 + LIFE.heal * 3)).toBe(1);
  });

  it('rises while waking and sinks while sleeping, the same at a tick for everyone', () => {
    expect(lifeRise('waking', 100, 100)).toBe(0);
    expect(lifeRise('waking', 100, 100 + LIFE.wake)).toBe(1);
    expect(lifeRise('sleeping', 0, 0)).toBe(1);
    expect(lifeRise('sleeping', 0, LIFE.sleep)).toBe(0);
    expect(lifeRise('active', 0, 5)).toBe(1);
    expect(lifeEngageable('waking')).toBe(false);
    expect(lifeEngageable('healing')).toBe(true);
  });
});

describe('arena gates', () => {
  const ring: ArenaDef = { boss: 'b', centre: { x: 0, y: 0 }, radius: 5000, outside: { x: 0, y: 6000 } };
  const seg: ArenaDef = { boss: 'b', centre: { x: 0, y: 0 }, radius: 3000, barrier: [[-500, 2000], [500, 2000]], outside: { x: 0, y: 2600 } };

  it('a ring barrier is closed and solid to ships both ways', () => {
    const t = buildTerrain(withArenaGates(undefined, ring)!);
    expect(gatePieces(ring).length).toBeGreaterThan(12);
    // (a ship flying out hard is held in; one flying in is held out)
    for (const [x, vx] of [[4900, 60], [5300, -60]] as const) {
      const body = { x, y: 0, vx, vy: 0 };
      for (let i = 0; i < 20; i++) { body.x += body.vx; body.y += body.vy; collideTerrain(body, 40, t); }
      expect(insideArena(ring, body.x, body.y)).toBe(x < 5000);
    }
  });

  it('stops rays (shots, beams) both ways, at every angle', () => {
    const t = buildTerrain(withArenaGates(undefined, ring)!);
    for (let k = 0; k < 64; k++) {
      const a = (k / 64) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
      expect(rayTerrain(t, c * 4000, s * 4000, c * 7000, s * 7000)).toBeLessThan(1);
      expect(rayTerrain(t, c * 7000, s * 7000, c * 4000, s * 4000)).toBeLessThan(1);
      expect(rayTerrain(t, 0, 0, c * 4900, s * 4900)).toBe(1);
    }
    expect(insideTerrain(t, 5040, 0)).toBe(true);
  });

  it('a segment barrier: near it to pass, and the pass point is clear on the other side', () => {
    const file = withArenaGates({ rocks: [] }, seg)!;
    const t = buildTerrain(file);
    expect(nearGate(seg, 0, 2300)).toBe(true);
    expect(nearGate(seg, 0, 3000)).toBe(false);
    const inP = passPoint(seg, 0, 2300, 50, true), outP = passPoint(seg, 0, 1700, 50, false);
    expect(inP.y).toBeLessThan(2000);
    expect(outP.y).toBeGreaterThan(2000);
    expect(insideTerrain(t, inP.x, inP.y, 50)).toBe(false);
    expect(insideTerrain(t, outP.x, outP.y, 50)).toBe(false);
    const ringIn = passPoint(ring, 5300, 0, 50, true), ringOut = passPoint(ring, 4800, 0, 50, false);
    expect(insideArena(ring, ringIn.x, ringIn.y)).toBe(true);
    expect(insideArena(ring, ringOut.x, ringOut.y)).toBe(false);
    expect(ringOut.x).toBeGreaterThan(5000 + GATE.thick);
  });
});
