/**
 * The order of a frame's hits around a snapshot (HitFlow): the window is searched once, before anything that reads HP,
 * and the hits found are worked out before the told ones.
 */
import { describe, expect, it } from 'vitest';
import type { ServerHitsMessage } from '@space-game/common';
import { HitFlow, type HitFlowHost } from './HitFlow';

function rig() {
  const log: string[] = [];
  const selfHits = {
    on: true,
    waiting: true,
    detect: () => { log.push('detect'); selfHits.waiting = false; return [{ id: 1 }]; },
    setOn: () => log.push('setOn'),
    setLevel: () => {},
    fix: () => ({ missed: [], wrong: [] }),
  };
  const hits = {
    own: () => log.push('own'),
    told: () => log.push('told'),
    check: () => log.push('check'),
    corrected: () => ({ msgs: [], ships: new Set(), gone: [] }),
  };
  const host = { selfHits, hits, store: {}, state: {} } as unknown as HitFlowHost;
  const flow = new HitFlow(host);
  return { flow, log, selfHits };
}

describe('the snapshot window is searched once, before anything that reads HP', () => {
  it('any number of readers after one snapshot search it once, and the first of them does', () => {
    const { flow, log, selfHits } = rig();
    flow.onHpCheck({} as never);
    selfHits.on = false; // (a fix with finding off only searches, then returns)
    flow.onHitFix({ t: 1 } as never, () => {});
    flow.findHits();
    expect(log.filter((l) => l === 'detect').length).toBe(1);
    expect(log[0]).toBe('detect'); // before the HP check read anything
    expect(log.indexOf('check')).toBeGreaterThan(log.indexOf('detect'));
    // a new window (the next snapshot) is searched afresh
    selfHits.waiting = true;
    flow.findHits();
    expect(log.filter((l) => l === 'detect').length).toBe(2);
  });
  it('a netCaps message searches the window as it was before it switches finding on', () => {
    const { flow, log } = rig();
    flow.onNetCaps(1);
    expect(log).toEqual(['detect', 'own', 'setOn']);
  });
});

describe('hits found here are worked out before the told ones, as the server orders them', () => {
  it('own hits are handed over before the hits message\'s told records', () => {
    const { flow, log } = rig();
    flow.onHits({ h: [] } as unknown as ServerHitsMessage, () => {});
    expect(log).toEqual(['detect', 'own', 'told']);
  });
});
