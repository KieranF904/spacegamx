import { describe, it, expect } from 'vitest';
import { NetSim } from './netSim';

/** A manual clock and timer, so the test steps time itself */
function rig(seed = 1) {
  let now = 0;
  const q: { at: number; fn: () => void }[] = [];
  const sim = new NetSim({ now: () => now, later: (fn, ms) => { q.push({ at: now + ms, fn }); } }, seed);
  const advance = (to: number) => {
    for (;;) {
      q.sort((a, b) => a.at - b.at);
      if (!q.length || q[0].at > to) break;
      const e = q.shift()!; now = e.at; e.fn();
    }
    now = to;
  };
  return { sim, advance, at: () => now };
}

describe('NetSim', () => {
  it('passes straight through while off', () => {
    const { sim } = rig();
    const got: number[] = [];
    sim.config.ping = 200; sim.config.loss = 50;
    for (let i = 0; i < 20; i++) sim.route('up', true, () => got.push(i));
    expect(got).toHaveLength(20);
  });

  it('delays half the ping each way', () => {
    const { sim, advance, at } = rig();
    Object.assign(sim.config, { enabled: true, ping: 100 });
    const times: number[] = [];
    sim.route('down', false, () => times.push(at()));
    advance(49); expect(times).toHaveLength(0);
    advance(50); expect(times).toEqual([50]);
  });

  it('jitter wobbles the delay and never reorders', () => {
    const { sim, advance, at } = rig(3);
    Object.assign(sim.config, { enabled: true, ping: 100, jitter: 40 });
    const order: number[] = [], when: number[] = [];
    for (let i = 0; i < 200; i++) { sim.route('down', false, () => { order.push(i); when.push(at()); }); advance(at() + 3); }
    advance(10_000);
    expect(order).toEqual([...Array(200).keys()]);
    for (let i = 1; i < when.length; i++) expect(when[i]).toBeGreaterThanOrEqual(when[i - 1]);
    // (every one lands at least ping/2 - jitter after it was sent)
    const delays = when.map((w, i) => w - i * 3);
    expect(Math.min(...delays)).toBeGreaterThanOrEqual(10 - 1e-6);
    expect(new Set(delays.map((d) => Math.round(d))).size).toBeGreaterThan(10);
  });

  it('loss drops only droppable messages, near the set rate, and repeats under a seed', () => {
    const run = (seed: number) => {
      const { sim, advance } = rig(seed);
      Object.assign(sim.config, { enabled: true, loss: 25 });
      let got = 0, kept = 0;
      for (let i = 0; i < 4000; i++) { sim.route('down', true, () => { got++; }); sim.route('down', false, () => { kept++; }); }
      advance(1);
      return { got, kept, dropped: sim.stats.dropped };
    };
    const a = run(5), b = run(5), c = run(6);
    expect(a).toEqual(b);
    expect(a.kept).toBe(4000);
    expect(a.got + a.dropped).toBe(4000);
    expect(a.dropped / 4000).toBeGreaterThan(0.2);
    expect(a.dropped / 4000).toBeLessThan(0.3);
    expect(c.dropped).not.toBe(a.dropped);
  });

  it('keeps order when switched off with deliveries in flight', () => {
    const { sim, advance } = rig();
    Object.assign(sim.config, { enabled: true, ping: 200 });
    const order: string[] = [];
    sim.route('up', false, () => order.push('late'));
    sim.config.enabled = false;
    sim.route('up', false, () => order.push('after'));
    advance(1000);
    expect(order).toEqual(['late', 'after']);
  });

  it('directions are independent', () => {
    const { sim, advance, at } = rig();
    Object.assign(sim.config, { enabled: true, ping: 200 });
    const t: Record<string, number> = {};
    sim.route('up', false, () => { t.up = at(); });
    advance(10);
    sim.route('down', false, () => { t.down = at(); });
    advance(500);
    expect(t).toEqual({ up: 100, down: 110 });
  });
});
