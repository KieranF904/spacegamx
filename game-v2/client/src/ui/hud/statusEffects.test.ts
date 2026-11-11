/**
 * The status effects the HUD shows above the jump drive bar: the timed ones while their end tick is ahead, with whole
 * seconds left; the cold's stages by the warmth meter, with no timer; gone once over.
 */
import { describe, expect, it } from 'vitest';
import { activeStatuses, statusTip, STATUS_DEFS } from './statusEffects';

describe('activeStatuses', () => {
  it('nothing on: an empty list', () => {
    expect(activeStatuses({ tick: 1000, warmth: 100 })).toEqual([]);
    expect(activeStatuses({ tick: 1000, empUntil: 1000, slowUntil: 900 })).toEqual([]);
  });

  it('a timed status shows while its end is ahead, its seconds rounded up, and goes when it ends', () => {
    const at = (tick: number) => activeStatuses({ tick, empUntil: 1090, slowUntil: 1030, markUntil: 1200 });
    expect(at(1000).map((a) => [a.def.id, a.secs])).toEqual([['emp', 2], ['slowed', 1], ['marked', 4]]);
    expect(at(1031).map((a) => [a.def.id, a.secs])).toEqual([['emp', 1], ['marked', 3]]);
    expect(at(1089).map((a) => a.def.id)).toEqual(['emp', 'marked']);
    expect(at(1090).map((a) => a.def.id)).toEqual(['marked']);
    expect(at(1200)).toEqual([]);
  });

  it('the cold: chilled under 50%, numb under 25%, frozen under 1%, no timer, its warmth instead', () => {
    expect(activeStatuses({ tick: 0, warmth: 60 })).toEqual([]);
    expect(activeStatuses({ tick: 0, warmth: 49 })[0]).toMatchObject({ def: { id: 'chilled' }, secs: null, pct: 49 });
    expect(activeStatuses({ tick: 0, warmth: 20 })[0].def.id).toBe('numb');
    expect(activeStatuses({ tick: 0, warmth: 0 })[0].def.id).toBe('frozen');
  });

  it('reuses the list it is given (no allocation a frame)', () => {
    const out = [{ def: STATUS_DEFS.emp, secs: 9 }];
    const r = activeStatuses({ tick: 0, slowUntil: 60 }, out);
    expect(r).toBe(out);
    expect(r.map((a) => a.def.id)).toEqual(['slowed']);
  });

  it('every status says what it does and what clears it (the tooltip)', () => {
    for (const d of Object.values(STATUS_DEFS)) { expect(d.does.length).toBeGreaterThan(5); expect(d.clears.length).toBeGreaterThan(5); }
    const tip = statusTip(activeStatuses({ tick: 0, empUntil: 120 })[0]);
    expect(tip).toContain('EMP: 2 s left');
    expect(tip).toContain('Clears:');
  });
});
