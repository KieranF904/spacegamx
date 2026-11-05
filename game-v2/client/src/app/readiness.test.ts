import { describe, it, expect } from 'vitest';
import { Readiness, SIGNALS, type ReadinessProbe } from './readiness';

const none: ReadinessProbe = { joined: false, ship: false, clock: false, view: false, built: false };
const all: ReadinessProbe = { joined: true, ship: true, clock: true, view: true, built: true };

describe('Readiness', () => {
  it('names the first signal not met, in order, with progress by signals met', () => {
    const r = new Readiness();
    r.begin(0);
    expect(r.check(none, 0)).toMatchObject({ step: 'Connecting', progress: 0, done: false });
    expect(r.check({ ...none, joined: true }, 10)).toMatchObject({ step: 'Receiving the world', progress: 0.2, done: false });
    expect(r.check({ ...all, clock: false }, 20)).toMatchObject({ step: 'Syncing with the server', progress: 0.8 });
    expect(r.check({ ...all, view: false }, 20).step).toBe('Catching up');
    expect(r.check({ ...all, built: false }, 20).step).toBe('Building the sector');
    // Out of order: still the earliest missing one
    expect(r.check({ ...none, built: true, view: true }, 30)).toMatchObject({ step: 'Connecting', progress: 0.4 });
  });

  it('is done only once every signal has held for settleChecks checks in a row', () => {
    const r = new Readiness({ settleChecks: 3 });
    r.begin(0);
    expect(r.check(all, 1).done).toBe(false);
    expect(r.check(all, 2).done).toBe(false);
    // A texture asked for this frame: pending again, the count starts over
    expect(r.check({ ...all, built: false }, 3).done).toBe(false);
    expect(r.check(all, 4).done).toBe(false);
    expect(r.check(all, 5).done).toBe(false);
    const s = r.check(all, 6);
    expect(s).toMatchObject({ done: true, timedOut: false, step: 'Ready', progress: 1, missing: [] });
  });

  it('lifts after the timeout anyway, saying what was missing', () => {
    const r = new Readiness({ timeoutMs: 10_000 });
    r.begin(1000);
    const probe = { ...all, clock: false, built: false };
    expect(r.check(probe, 10_999).done).toBe(false);
    const s = r.check(probe, 11_000);
    expect(s.done).toBe(true);
    expect(s.timedOut).toBe(true);
    expect(s.missing).toEqual(['clock', 'built']);
  });

  it('starts over on begin (a second join, an arrival)', () => {
    const r = new Readiness({ timeoutMs: 1000, settleChecks: 2 });
    r.begin(0);
    r.check(all, 1);
    r.begin(5000);
    // The settle count was reset: one check isn't enough
    expect(r.check(all, 5001).done).toBe(false);
    expect(r.check(all, 5002).done).toBe(true);
    // And the timeout counts from the new begin
    r.begin(9000);
    expect(r.check(none, 9999).done).toBe(false);
    expect(r.check(none, 10_000)).toMatchObject({ done: true, timedOut: true, missing: SIGNALS.map((s) => s.key) });
  });

  it('defaults to a 10 s timeout', () => {
    expect(new Readiness().timeoutMs).toBe(10_000);
  });
});
