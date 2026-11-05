import { describe, it, expect } from 'vitest';
import { NO_INPUT, InputSlots, ScriptedInputs, simAim, simAimQ, type SimInput } from './index.js';
import { HeldInputs, FnInputs, inputOfControls, controlsOfInput } from './d-sources.js';

const mk = (bits: number, q = 0): SimInput => ({ ...NO_INPUT, bits, q });

describe('HeldInputs', () => {
  it('holds the last heard input and answers any tick again (rollback safe)', () => {
    const h = new HeldInputs('assumed');
    expect(h.inputAt(10)).toBe(NO_INPUT);
    h.hear(10, mk(1, 5));
    h.hear(20, mk(2, 6));
    expect(h.inputAt(9).bits).toBe(0);
    expect(h.inputAt(10).bits).toBe(1);
    expect(h.inputAt(19).bits).toBe(1);
    expect(h.inputAt(20).bits).toBe(2);
    expect(h.inputAt(10).bits).toBe(1);
    // a late-heard earlier change slots in order
    h.hear(15, mk(4));
    expect(h.inputAt(17).bits).toBe(4);
    expect(h.inputAt(25).bits).toBe(2);
  });
  it('is assumed until confirmed through a tick', () => {
    const h = new HeldInputs('assumed');
    expect(h.confirmedThrough()).toBe(-Infinity);
    h.confirm(30);
    h.confirm(20);
    expect(h.confirmedThrough()).toBe(30);
  });
  it('prunes what is before the tick in force', () => {
    const h = new HeldInputs();
    h.hear(1, mk(1)); h.hear(5, mk(2)); h.hear(9, mk(3));
    h.prune(7);
    expect(h.inputAt(7).bits).toBe(2);
    expect(h.inputAt(9).bits).toBe(3);
  });
});

describe('FnInputs and conversions', () => {
  it('a decided source is final through the last tick it answered', () => {
    const f = new FnInputs('decided', (t) => mk(t));
    expect(f.inputAt(4, { id: 1, body: { x: 0, y: 0, angle: 0 } }).bits).toBe(4);
    expect(f.confirmedThrough()).toBe(4);
  });
  it('controls round trip through bits, the aim on the grid', () => {
    const c = { forward: true, backward: false, left: true, right: false, boost: true, targetAngle: 1.1 };
    const inp = inputOfControls(c, { jumpDist: 8 });
    const back = controlsOfInput(inp, { angle: 0 });
    expect([back.forward, back.backward, back.left, back.right, back.boost]).toEqual([true, false, true, false, true]);
    expect(inp.q).toBe(simAimQ(1.1));
    expect(Math.abs(simAim(inp.q) - 1.1)).toBeLessThan(1e-2);
  });
  it('possess/release round trip', () => {
    const slots = new InputSlots();
    const a = new HeldInputs(), b = new ScriptedInputs('known', () => NO_INPUT);
    slots.set(1, a);
    slots.possess(1, b);
    slots.possess(1, new ScriptedInputs('known', () => NO_INPUT));
    slots.release(1);
    expect(slots.get(1)).toBe(a);
  });
});
