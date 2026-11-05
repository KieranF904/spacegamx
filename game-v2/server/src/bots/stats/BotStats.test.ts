import { describe, it, expect } from 'vitest';
import { BotStats, summaryTable } from './BotStats.js';

describe('BotStats', () => {
  it('keeps setup out of the trips, and times each phase of a trip', () => {
    let wall = 0;
    const s = new BotStats(60, () => wall);
    for (let t = 1; t <= 30; t++) s.tick(t, 'setup', false, { x: t, y: 0 });
    expect(s.summary().trips).toBe(0);
    s.beginTrip(31);
    for (let t = 31; t < 91; t++) s.tick(t, 'docked', false, { x: 30, y: 0 });
    for (let t = 91; t < 151; t++) s.tick(t, 'travelOut', false, { x: 30 + (t - 91) * 10, y: 0 });
    for (let t = 151; t < 451; t++) s.tick(t, 'mining', t < 181, { x: 630, y: 0 });
    for (let t = 451; t < 511; t++) s.tick(t, 'travelBack', false, { x: 630 - (t - 451) * 10, y: 0 });
    wall = 2000;
    s.endTrip(511);
    const sum = s.summary();
    expect(sum.trips).toBe(1);
    expect(sum.setupSeconds).toBe(0.5);
    expect(sum.seconds.docked).toBe(1);
    expect(sum.seconds.travelOut).toBe(1);
    expect(sum.seconds.mining).toBe(5);
    expect(sum.seconds.travelBack).toBe(1);
    expect(sum.tripSeconds).toBe(8);
    expect(sum.brownoutSeconds).toBe(0.5);
    expect(sum.distance).toBeCloseTo(1190, 0);
    expect(sum.share.mining).toBeCloseTo(5 / 8);
    expect(sum.miningShare).toBeCloseTo(5 / 7);
    expect(sum.travelShare).toBeCloseTo(2 / 7);
    expect(s.trips[0].wallMs).toBe(2000);
  });

  it('counts ore mined, collected and deposited by type, chunks, credits, and the rates per hour', () => {
    const s = new BotStats(60, () => 0);
    s.beginTrip(0);
    s.mined({ iron_ore: 6, ice: 4 });
    s.mined({ iron_ore: 10 });
    s.collected({ iron_ore: 6, ice: 4 });
    s.collected({ iron_ore: 5 });
    s.rock();
    for (let t = 0; t < 1800; t++) s.tick(t, 'mining', false);
    s.deposited({ iron_ore: 11, ice: 4 }, 30, 45);
    s.endTrip(1800);
    // (A trip still going is not in the rates)
    s.beginTrip(1800);
    s.mined({ iron_ore: 99 });
    const sum = s.summary();
    expect(sum.mined).toEqual({ iron_ore: 16, ice: 4 });
    expect(sum.oreMined).toBe(20);
    expect(sum.chunksThrown).toBe(2);
    expect(sum.oreCollected).toBe(15);
    expect(sum.chunksCollected).toBe(2);
    expect(sum.oreLost).toBe(5);
    expect(sum.oreDeposited).toBe(15);
    expect(sum.credits).toBe(30);
    expect(sum.valueIfSold).toBe(45);
    expect(sum.tripSeconds).toBe(30);
    expect(sum.orePerHour).toBeCloseTo(15 * 120);
    expect(sum.creditsPerHour).toBeCloseTo(30 * 120);
    expect(sum.valuePerHour).toBeCloseTo(45 * 120);
    expect(sum.orePerTrip).toBe(15);
  });

  it('ignores teleports (an undock) in the distance, and writes JSON lines and a table', () => {
    const s = new BotStats(60, () => 0);
    s.beginTrip(0);
    s.tick(1, 'docked', false, { x: 0, y: 0 });
    s.tick(2, 'travelOut', false, { x: 5000, y: 0 });
    s.tick(3, 'travelOut', false, { x: 5010, y: 0 });
    s.endTrip(4);
    expect(s.trips[0].distance).toBe(10);
    const lines = s.jsonLines({ bot: 'x' }).trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => l.kind)).toEqual(['trip', 'summary']);
    expect(lines[0].bot).toBe('x');
    expect(lines[0].seconds.travelOut).toBeCloseTo(0.03, 2);
    expect(summaryTable(s.summary(), 'T')).toContain('ore per hour');
  });
});
