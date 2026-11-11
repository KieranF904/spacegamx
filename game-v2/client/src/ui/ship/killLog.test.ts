/**
 * The Kills log: consecutive kills of one enemy collapse into one row with their loot totalled; anything else starts a
 * new row; the log is capped.
 */
import { describe, expect, it } from 'vitest';
import { KillLog, KILL_LOG_MAX, killLoot, killTitle } from './killLog';

const names: Record<string, string> = { iron_ore: 'Iron Ore', scrap: 'Scrap' };
const name = (id: string) => names[id] ?? id;

describe('KillLog', () => {
  it('collapses consecutive kills of the same enemy, totalling their loot, credits and XP', () => {
    const log = new KillLog();
    for (let k = 0; k < 5; k++) log.add({ kind: 'kill', name: 'Scrap Mother', items: { iron_ore: 2, scrap: k === 4 ? 1 : 0 }, credits: 10, xp: 30, at: k });
    expect(log.rows).toHaveLength(1);
    const r = log.rows[0];
    expect(killTitle(r)).toBe('5× Scrap Mother');
    expect(r).toMatchObject({ count: 5, items: { iron_ore: 10, scrap: 1 }, credits: 50, xp: 150, first: 0, last: 4 });
    expect(killLoot(r, name)).toBe('+10 Iron Ore · +1 Scrap · +50 cr · +150 XP');
  });

  it('another enemy, an assist, a boss or a loss starts a new row; the same enemy after that is a new row too', () => {
    const log = new KillLog();
    log.add({ kind: 'kill', name: 'Raider', at: 0 });
    log.add({ kind: 'kill', name: 'Drone', at: 1 });
    log.add({ kind: 'assist', name: 'Drone', at: 2 });
    log.add({ kind: 'assist', name: 'Drone', at: 3 });
    log.add({ kind: 'boss', name: 'Pyreclast', at: 4 });
    log.add({ kind: 'boss', name: 'Pyreclast', at: 5 });
    log.add({ kind: 'death', name: '', at: 6 });
    log.add({ kind: 'kill', name: 'Raider', at: 7 });
    expect(log.rows.map(killTitle)).toEqual(['Raider', 'Drone', '2× Drone (assist)', 'Boss beaten: Pyreclast', 'Boss beaten: Pyreclast', 'Ship lost', 'Raider']);
    expect(killLoot(log.rows[0], name)).toBe('');
  });

  it(`keeps at most ${KILL_LOG_MAX} rows, the oldest dropped; clear empties it; the version moves on every change`, () => {
    const log = new KillLog();
    for (let k = 0; k < KILL_LOG_MAX + 5; k++) log.add({ kind: 'kill', name: `E${k}`, at: k });
    expect(log.rows).toHaveLength(KILL_LOG_MAX);
    expect(log.rows[0].name).toBe('E5');
    const v = log.version;
    log.clear();
    expect(log.rows).toHaveLength(0);
    expect(log.version).toBe(v + 1);
  });
});
