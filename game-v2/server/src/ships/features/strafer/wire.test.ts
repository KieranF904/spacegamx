/** The Burst Strafer's world half: its pilot-row values, and that the features write the pilot extras in features.wire.json order */
import { describe, it, expect } from 'vitest';
import { getPlan, pilotExtras, CHARGE_GROUPS_AT } from '@space-game/common';
import { ServerFeatures } from '../host.js';
import { SERVER_FEATURES } from '../index.js';
import { serverFeature } from './index.js';
import type { FeatureHost, ServerFeature } from '../types.js';

const hostWith = (ship: { dodge?: number; dodgeDir?: number } | undefined) => ({ ships: { get: () => ship } }) as unknown as FeatureHost;

describe('the strafer feature (server)', () => {
  it('writes the dodge counter and way (0 for a ship without them, or no ship)', () => {
    const f = new ServerFeatures([serverFeature], hostWith({ dodge: 5, dodgeDir: 9 }));
    const out: number[] = [];
    expect(f.wire(1, out)).toBe(2);
    expect(out).toEqual([5, 9]);
    expect(f.wire(1, out.fill(-1), 0)).toBe(2);
    expect(new ServerFeatures([serverFeature], hostWith({})).wire(1, [])).toBe(2);
    const none: number[] = [];
    new ServerFeatures([serverFeature], hostWith(undefined)).wire(1, none);
    expect(none).toEqual([0, 0]);
  });

  it('the registered features with pilot-row values run in the manifest\'s pilotExtra order, and the row reads back', () => {
    const owners = getPlan().replicate.filter((r) => r.where === 'pilotExtra').sort((a, b) => a.slot - b.slot).map((r) => r.feature);
    const ids = SERVER_FEATURES.map((s) => s.id);
    // (ServerFeatures runs them in id order: that order must be the slots')
    expect([...new Set(owners)]).toEqual(ids.filter((id) => owners.includes(id)));
    const tow: ServerFeature = { id: 'tow', create: () => ({ wire: (_e, out) => { out[0] = 7; return 1; } }) };
    const out: number[] = [];
    new ServerFeatures([tow, serverFeature], hostWith({ dodge: 3, dodgeDir: 17 })).wire(1, out);
    const row = [...new Array(CHARGE_GROUPS_AT).fill(0), ...out];
    expect(pilotExtras(row)).toEqual({ dodge: 3, dodgeDir: 17, tow: 7 });
  });
});
