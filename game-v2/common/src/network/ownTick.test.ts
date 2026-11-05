/**
 * The own ship's tick-layer causes and check (network/ownTick.ts, CAPS.OWN_SIM): their wire forms (an input's own
 * check; a snapshot's own rows through the base and the bit-packed formats) and the causes' maths against the server's.
 */
import { describe, it, expect } from 'vitest';
import {
  encodeMessage, decodeMessage, encodeServerMessage, serverFrame, ServerFrameReader, PackedEncoder,
  type ClientInputMessage, type ServerSnapshotMessage,
} from '../index.js';
import { quantizePull, unwrapTick12, ownBodyHash, ownHpHash, applyOwnCauses, OWN_CAUSE, CONTACT_FLAG, type OwnShape } from './ownTick.js';
import { contactPair, contactPieces, recentreShift } from '../ships/contact.js';
import { quantizeShipBody } from '../ships/physics.js';

describe('own ship on the tick-aligned layer (CAPS.OWN_SIM)', () => {
  it("an input's own check goes in 3 bytes, beside a hit report and debris acks", () => {
    const base: ClientInputMessage = { type: 'input', seq: 7, tick: 0, targetTick: 70001, forward: true, backward: false, left: false, right: true, boost: false, fireLeft: true, fireRight: false, targetAngle: 0.5, cursorDist: 400 };
    for (const extra of [{}, { hitReport: { hash: 201, tick: 1234, epoch: 2 } }, { acks: [5, 9, 300, 255] }, { hitReport: { hash: 1, tick: 5, epoch: 0 }, acks: [77, 3] }]) {
      const msg = { ...base, ...extra, ownCheck: { body: 173, hp: 11, tick: 3071 } };
      const out = decodeMessage(encodeMessage(msg) as ArrayBuffer) as ClientInputMessage;
      expect(out.ownCheck).toEqual({ body: 173, hp: 11, tick: 3071 });
      if ('hitReport' in extra) expect(out.hitReport).toEqual(extra.hitReport);
      if ('acks' in extra) expect(out.acks).toEqual(extra.acks);
      const without = decodeMessage(encodeMessage({ ...base, ...extra }) as ArrayBuffer) as ClientInputMessage;
      expect(without.ownCheck).toBeUndefined();
      expect((encodeMessage(msg) as ArrayBuffer).byteLength - (encodeMessage({ ...base, ...extra }) as ArrayBuffer).byteLength).toBe(3);
    }
  });

  it("a snapshot's own rows come back exactly, in the base format and bit-packed", () => {
    const own = [[2, OWN_CAUSE.PULL, quantizePull(-0.0888512), quantizePull(0.4222449)], [1, OWN_CAUSE.PULL, quantizePull(-0.08624), 0.42318],
      [1, OWN_CAUSE.CONTACT, 4253, CONTACT_FLAG.STATE, 64930.31, 35327.24, -2.07751, -2.5438, 5.5633], [0, OWN_CAUSE.CONTACT, 4253, CONTACT_FLAG.STATE | CONTACT_FLAG.OTHER_BEFORE, 64927.86, 35332.7123456, -2.06002, -2.4547, 5.4585],
      [0, OWN_CAUSE.CONTACT, 17, CONTACT_FLAG.SECOND], [0, OWN_CAUSE.REBUILD]];
    const snap: ServerSnapshotMessage = { type: 'snapshot', tick: 351, lastProcessedInput: 9, entities: [], removed: [], own };
    const base = new ServerFrameReader().read(serverFrame([encodeServerMessage(snap)]));
    expect((base[0][0] as ServerSnapshotMessage).own).toEqual(own);
    const enc = new PackedEncoder(), rd = new ServerFrameReader();
    for (let i = 0; i < 3; i++) {
      const m = { ...snap, tick: 351 + i * 3 };
      const got = rd.read(enc.encode([[{ msg: m }]], 5));
      expect((got[0][0] as ServerSnapshotMessage).own).toEqual(own);
    }
  });

  it('the pull grid, the tick and the hashes', () => {
    expect(quantizePull(0.123456789)).toBe(0.12346);
    expect(Object.is(quantizePull(-0.000001), 0)).toBe(true);
    expect(unwrapTick12(4095 & 0xfff, 4096 * 3 + 5)).toBe(4096 * 3 - 1);
    expect(unwrapTick12(7, 4096 * 3 + 5)).toBe(4096 * 3 + 7);
    const b = { x: 100.25, y: -3.5, vx: 0.1234, vy: -2, angle: 1.25, angVel: 0.001, jump: 0 };
    const h = ownBodyHash(b, 5, 1000);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThan(256);
    expect(ownBodyHash({ ...b }, 5, 1000)).toBe(h);
    const others = new Set([ownBodyHash({ ...b, x: 100.26 }, 5, 1000), ownBodyHash(b, 4, 1000), ownBodyHash(b, 5, 1001), ownBodyHash({ ...b, vy: -2.0001 }, 5, 1000)]);
    expect(others.size).toBeGreaterThan(1);
    expect(ownHpHash([10, 20.5, 0])).toBe(ownHpHash([10, 20.5, 0]));
    expect(ownHpHash([10, 20.5, 0])).toBeLessThan(16);
  });

  it("a contact's push and a rebuild's recentring, worked out from the cause, are the server's to the bit", () => {
    // Two square bodies overlapping: the server's pass (contactPair on its bodies) against the cause applied to a copy
    const sq = (s: number) => [[-s, -s], [s, -s], [s, s], [-s, s]] as [number, number][];
    const geom = [{ convexShrunk: [sq(1)], bbox: { minX: -1, minY: -1, maxX: 1, maxY: 1 } }] as never;
    const shape: OwnShape = { geom, alive: [true], com: [0, 0], mass: 3, radius: 2, big: false };
    const other: OwnShape = { ...shape, mass: 7 };
    const me = { x: 10, y: 5, vx: 1.25, vy: -0.5, angle: 0.3, angVel: 0 }, it = { x: 10 + 28, y: 5.5, vx: -0.75, vy: 0.125, angle: -0.2 };
    // (the server's pass)
    const a = { ...me }, b = { ...it };
    const pa = contactPieces(geom, [true], [0, 0], 16, a), pb = contactPieces(geom, [true], [0, 0], 16, b);
    expect(contactPair(pa, pb, a, b, 1 / 3, 1 / 7, 0.3)).not.toBeNull();
    const want = { ...me, x: a.x, y: a.y, vx: a.vx, vy: a.vy };
    quantizeShipBody(want);
    // (the client, from the cause and the other as it has it)
    const body = { ...me };
    const ok = applyOwnCauses(body, [[OWN_CAUSE.CONTACT, 9, 0]], { cellSize: 16, restitution: 0.3, self: shape, other: () => ({ shape: other, body: { ...it } }), rebuilt: () => null });
    expect(ok).toBe(true);
    expect(body).toEqual(want);
    // A rebuild: the centre moves with the centre of mass
    const r = { ...me };
    applyOwnCauses(r, [[OWN_CAUSE.REBUILD]], { cellSize: 16, restitution: 0.3, self: shape, other: () => null, rebuilt: () => ({ from: [0, 0], to: [0.5, -0.25] }) });
    const w = recentreShift([0, 0], [0.5, -0.25], 16, me.angle)!;
    const rw = { ...me, x: me.x + w[0], y: me.y + w[1] };
    quantizeShipBody(rw);
    expect(r).toEqual(rw);
  });
});
