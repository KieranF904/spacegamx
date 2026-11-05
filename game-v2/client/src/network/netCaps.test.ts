import { describe, it, expect, afterEach, vi } from 'vitest';
import { CAPS, DEFAULT_CAPS } from '@space-game/common';
import { netCaps } from './netCaps';

/** The page's address and storage, as a browser has them */
function page(search: string) {
  const store = new Map<string, string>();
  vi.stubGlobal('location', { search });
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('netCaps', () => {
  it('offers the shared default with no switches, in any build (dev or production)', () => {
    page('');
    expect(netCaps()).toBe(DEFAULT_CAPS);
    // (the netcode the dev stage runs: every cap so far)
    expect(DEFAULT_CAPS).toBe(Object.values(CAPS).reduce((m, b) => m | b, 0));
  });

  it('still takes the per-flag switches, with what depends on them', () => {
    page('?ownsim=0');
    const c = netCaps();
    expect(c & CAPS.OWN_SIM).toBe(0);
    // (bodies, causes, waypoints, pilots and cargo ride on its own ship being stepped by itself)
    expect(c & (CAPS.BODIES | CAPS.CAUSES | CAPS.WAYPOINTS | CAPS.PILOTS | CAPS.CARGO)).toBe(0);
    expect(c & CAPS.PACKED).toBe(CAPS.PACKED);

    page('?hits=0&packed=0');
    const d = netCaps();
    expect(d & (CAPS.HITS | CAPS.SELF_HITS | CAPS.ROUGH | CAPS.PACKED | CAPS.COALESCE | CAPS.BLOCKS)).toBe(0);
    expect(d & CAPS.FOCUS).toBe(CAPS.FOCUS);
  });
});
