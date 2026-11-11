import { describe, it, expect } from 'vitest';
import { energyLine } from './energyLine';
import { emptyStatus, type ShipStatus } from './source';

const energy = (o: Partial<ShipStatus['energy']>): ShipStatus['energy'] => ({ ...emptyStatus().energy, gen: 768, draw: 0, ...o });

describe('the ship panel energy line', () => {
  it('full and idle: the level and the spare power', () => {
    const l = energyLine(energy({ pct: 100, draw: 18, net: 300 }));
    expect(l.head).toBe('POWER 100%');
    expect(l.rate).toBe('');
    expect(l.note).toBe('+750/s spare');
    expect(l.noteTone).toBe('dim');
  });

  it('draining: the rate down and the time to empty, amber under 5 s', () => {
    const l = energyLine(energy({ pct: 20, net: -380.4, empty: 3.2 }));
    expect(l.head).toBe('POWER 20%');
    expect(l.headTone).toBe('warn');
    expect(l.rate).toBe('−380/s');
    expect(l.note).toBe('empty in 3.2 s');
    expect(l.noteTone).toBe('warn');
  });

  it('filling: the rate up and the time to full', () => {
    const l = energyLine(energy({ pct: 41, net: 52, full: 14.2 }));
    expect(l.rate).toBe('+52/s');
    expect(l.note).toBe('full in 15 s');
  });

  it('short of power: says what is short and the share it gets (the same for all: proportional sharing), in red, over everything else', () => {
    const l = energyLine(energy({ pct: 0, net: -5, empty: 0.1, brownout: true, short: 'engines+guns', share: 0.643 }));
    expect(l.head).toBe('LOW POWER 0%');
    expect(l.note).toBe('engines, guns get 64%');
    expect(l.noteTone).toBe('bad');
    expect(l.headTone).toBe('bad');
  });
});
