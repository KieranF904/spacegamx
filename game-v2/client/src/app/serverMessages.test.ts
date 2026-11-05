import { describe, it, expect } from 'vitest';
import golden from '../../../server/src/golden/serverMessages.json';
import { HANDLERS } from './serverMessages';

/** ServerMessage types the table need not handle because ShipClient.handleMessage consumes them (ships/ShipClient.ts) */
const HANDLED_BY_SHIP_CLIENT = [
  'shipSync', 'partDestroyed', 'contact', 'detonation', 'intercept', 'stationFire', 'ignite',
  'bossCharge', 'bossTelegraph', 'bossBeam', 'bossBlow', 'debrisSplit',
];

describe('server message table', () => {
  it('handles exactly the types pinned in server/src/golden/serverMessages.json', () => {
    expect(Object.keys(HANDLERS).sort()).toEqual([...(golden as string[])].sort());
  });

  it('has no entry for a type ShipClient swallows whole', () => {
    for (const t of HANDLED_BY_SHIP_CLIENT) expect(HANDLERS[t as keyof typeof HANDLERS], t).toBeUndefined();
  });

  it('ignores unknown and prototype-ish types', () => {
    for (const t of ['__proto__', 'constructor', 'toString', 'nope']) expect((HANDLERS as Record<string, unknown>)[t]).toBeUndefined();
  });
});
