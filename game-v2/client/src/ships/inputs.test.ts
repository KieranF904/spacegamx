import { describe, it, expect } from 'vitest';
import { InputSlots, type BodyDriver } from '@space-game/common';
import { OwnInputSource, ReplicaRowSource, BodyDriverSource } from './inputs.js';

const PREV = { id: 1, body: { x: 0, y: 0, angle: 0 }, ctl: { bits: 0, q: 0 } };

describe('client input sources', () => {
  it('own: known, holds between control changes', () => {
    const ctl = new Map<number, [number, number]>([[10, [3, 40]], [14, [0, 41]]]);
    const s = new OwnInputSource({ ctl: (t) => ctl.get(t) }, (t) => ({ jumpDist: t === 10 ? 200 : -1 }));
    expect(s.knowledge).toBe('known');
    expect(s.inputAt(9).bits).toBe(0);
    expect(s.inputAt(10)).toMatchObject({ bits: 3, q: 40, jumpDist: 200 });
    expect(s.inputAt(12).bits).toBe(3);
    expect(s.inputAt(14)).toMatchObject({ bits: 0, q: 41 });
    expect(s.inputAt(11).bits).toBe(3);
  });
  it('replica: assumed (held) until a row confirms', () => {
    const s = new ReplicaRowSource();
    s.hear(5, 8, 12);
    expect(s.knowledge).toBe('assumed');
    expect(s.inputAt(9)).toMatchObject({ bits: 8, q: 12 });
    expect(s.confirmedThrough()).toBeLessThan(5);
    s.confirm(7);
    expect(s.confirmedThrough()).toBe(7);
  });
  it('body driver: decided, with its push; rows fly it where the body is off', () => {
    let on = true;
    const seen: [number, number][] = [];
    const driver: BodyDriver = { step: (_t, _p, q, b) => { seen.push([q, b]); return on ? { bits: 1, q: 9, ix: 0.5, iy: -1 } : null; } };
    const rows = new ReplicaRowSource();
    rows.hear(0, 4, 2);
    const s = new BodyDriverSource(driver, rows);
    expect(s.inputAt(1, PREV)).toMatchObject({ bits: 1, q: 9, impulse: [0.5, -1] });
    on = false;
    expect(s.inputAt(2, PREV)).toMatchObject({ bits: 4, q: 2 });
    on = true;
    // (the driver reads the ship's last controls off prev.ctl: stateless, rollback safe)
    s.inputAt(3, { ...PREV, ctl: { bits: 4, q: 2 } });
    expect(seen[2]).toEqual([2, 4]);
    expect(s.knowledge).toBe('decided');
    expect(s.confirmedThrough()).toBe(3);
  });
  it('possess/release round trip', () => {
    const slots = new InputSlots();
    const own = new ReplicaRowSource(), live = new OwnInputSource({ ctl: () => undefined });
    slots.set(2, own);
    slots.possess(2, live);
    expect(slots.get(2)).toBe(live);
    slots.release(2);
    expect(slots.get(2)).toBe(own);
  });
});
