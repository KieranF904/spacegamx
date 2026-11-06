import { describe, it, expect } from 'vitest';
import { decodeServerFrame, encodeServerMessage, serverFrame, type ServerMessage } from './protocol.js';
import { applyProfileDelta, diffProfile, type ServerProfileMessage, type ServerProfileDeltaMessage } from './econProtocol.js';
import { PackedEncoder, PackedDecoder } from './packed/packedCodec.js';

const YOU = 77;
const viaBase = (m: ServerMessage): ServerMessage => decodeServerFrame(serverFrame([encodeServerMessage(m)]))[0];
const viaPacked = (enc: PackedEncoder, dec: PackedDecoder, m: ServerMessage): ServerMessage => dec.decode(enc.encode([[{ msg: m }]], YOU))[0][0];

function profile(over: Partial<ServerProfileMessage> = {}): ServerProfileMessage {
  return {
    type: 'profile', guest: false, credits: 1200, xp: 340, level: 4, xpLevel: 300, xpNext: 500, skillPoints: 1,
    skills: { guns: 2 }, plans: ['a'], recipes: ['r1', 'r2'], licences: [], home: 'sol', homeName: 'Sol Station',
    quickbar: [null, 'medkit', null, null, null], debt: 0, ammo: { crate: 40 }, ammoPrefer: {}, loadout: {}, outpost: null, now: 1000,
    ...over,
  };
}

describe('profileDelta', () => {
  it('diffs only what changed (and nothing for a copy, whatever the clock says)', () => {
    const a = profile();
    expect(diffProfile(a, profile({ now: 5000 }))).toBeNull();
    expect(diffProfile(a, profile({ xp: 360, credits: 1250 }))).toEqual({ type: 'profileDelta', xp: 360, credits: 1250 });
    expect(diffProfile(a, profile({ ammo: { crate: 39 }, outpost: { site: 'x', tracks: {} } as never }))).toEqual({
      type: 'profileDelta', o: { ammo: { crate: 39 }, outpost: { site: 'x', tracks: {} } },
    });
  });

  it('round-trips through the base format and the packed one, unchanged', () => {
    const msgs: ServerProfileDeltaMessage[] = [
      { type: 'profileDelta', xp: 360 },
      { type: 'profileDelta', xp: 520, level: 5, xpLevel: 500, xpNext: 750, skillPoints: 2, credits: 0, debt: 0 },
      { type: 'profileDelta', o: { quickbar: ['a', null, null, null, null], outpost: null, ammo: { c: 3 } } },
    ];
    for (const m of msgs) {
      expect(viaBase(m)).toEqual(m);
    }
    const enc = new PackedEncoder(), dec = new PackedDecoder();
    for (let k = 0; k < 2; k++) for (const m of msgs) expect(viaPacked(enc, dec, m)).toEqual(m);
  });

  it('a client applying deltas ends with the profile the full sends would have given', () => {
    const steps: Partial<ServerProfileMessage>[] = [
      { xp: 360 }, { xp: 400, credits: 1300 }, { xp: 520, level: 5, xpLevel: 500, xpNext: 750, skillPoints: 2 },
      { skills: { guns: 3 }, skillPoints: 1 }, { debt: 80, credits: 0 }, { debt: 0 }, { ammo: { crate: 12 } },
      { outpost: { site: 'sol_outer', tracks: { a: 1 } } as never }, { quickbar: [null, null, 'x', null, null] },
    ];
    let server = profile();
    let client = profile();
    const enc = new PackedEncoder(), dec = new PackedDecoder();
    for (const s of steps) {
      const next = { ...server, ...s, now: server.now! + 50 };
      const d = diffProfile(server, next);
      expect(d).not.toBeNull();
      client = applyProfileDelta(client, viaPacked(enc, dec, d!) as unknown as ServerProfileDeltaMessage);
      server = next;
      // (The clock is the full message's alone: the client keeps the one it was given)
      expect({ ...client, now: 0 }).toEqual({ ...server, now: 0 });
    }
    expect(client.now).toBe(1000);
  });
});
