/**
 * Decision inputs (bodies/): the decision records and the body check through every wire format they go in, the
 * decisions folded into a body's state, and the staged flight pure of its inputs.
 */
import { describe, it, expect } from 'vitest';
import { isDeepStrictEqual } from 'util';
import { decodeServerFrame, encodeServerMessage, serverFrame, encodeInputBinary, decodeInputBinary, type ServerMessage, type ClientInputMessage } from '../network/protocol.js';
import { PackedEncoder, PackedDecoder } from '../network/packed/packedCodec.js';
import { InputEncoder, InputDecoder } from '../network/inputCompact.js';
import {
  DECISION, WANT, applyDecision, bodyStateOfSync, syncArgs, sameWant, wantDrive, wantFace, wantFly, wantLead, decisionRowOk,
} from './decisions.js';
import { stagedFlight } from './stagedFlight.js';
import { BODY_KINDS, bodyKindOf } from './registry.js';
import { bodyHash } from './hash.js';
import { AI_ORDER, aiAimError, aiPilot, aiReads, orderEngage, orderPack, orderPatrol, packCentroid } from './aiPilot.js';

const rows = [
  [4253, 0, DECISION.SYNC, 0, 64840, 32349, 1, 1, 4242, WANT.FLY],
  [4253, -2, DECISION.TARGET, 4243],
  [4253, -1, DECISION.WANT, ...wantDrive(-2.5, 1.2, 20)],
  [4253, 0, DECISION.SIDE, 0],
  [4253, 0, DECISION.STAGE, 3],
  [4253, -7, DECISION.OFF],
  [5001, 0, DECISION.WANT, ...wantLead(25)],
];
const snap = (tick: number, decisions?: number[][]): ServerMessage =>
  ({ type: 'snapshot', tick, lastProcessedInput: 7, entities: [], removed: [], ...(decisions ? { decisions } : {}) }) as unknown as ServerMessage;

describe('decision records on the wire', () => {
  it('a snapshot\'s decisions come back as they went: base format and bit-packed', () => {
    const base = decodeServerFrame(serverFrame([encodeServerMessage(snap(900, rows))]));
    expect((base[0] as { decisions?: number[][] }).decisions).toEqual(rows);
    const enc = new PackedEncoder(), dec = new PackedDecoder();
    for (let t = 900; t < 905; t++) {
      const msgs = [snap(t, t % 2 ? rows.slice(1, 4) : rows)];
      const got = dec.decode(enc.encode([msgs.map((msg) => ({ msg }))], 4241));
      const want = [decodeServerFrame(serverFrame(msgs.map(encodeServerMessage)))];
      expect(isDeepStrictEqual(got, want)).toBe(true);
    }
    // (a record a few bytes: the boss's slot, its tick, op and args)
    const one = enc.encode([[{ msg: snap(906, [rows[3]]) }]], 4241).length, none = enc.encode([[{ msg: snap(907) }]], 4241).length;
    expect(one - none).toBeLessThanOrEqual(3);
  });

  it('the rows the packing can\'t take go the base way (a decision for a tick after the snapshot\'s, an op it doesn\'t know)', () => {
    expect(decisionRowOk([1, 0, 99])).toBe(false);
    expect(decisionRowOk([1, 0, DECISION.SIDE, 1.5])).toBe(false);
    const enc = new PackedEncoder(), dec = new PackedDecoder();
    const odd = [[4253, 3, DECISION.SIDE, 1]];
    const got = dec.decode(enc.encode([[{ msg: snap(900, odd) }]], 4241));
    expect((got[0][0] as { decisions?: number[][] }).decisions).toEqual(odd);
  });

  it('a body check rides an input: the base layout and the compact one, with the other checks', () => {
    const msg = {
      type: 'input', seq: 41, tick: 0, targetTick: 1234, forward: true, backward: false, left: false, right: true, boost: false, fireLeft: true, fireRight: false,
      targetAngle: 1.25, cursorDist: 800, ownCheck: { body: 0x9c, hp: 5, tick: 0x3e7 }, hitReport: { hash: 7, tick: 1230, epoch: 1 }, bodyCheck: { hash: 0xa5, tick: 0x4d2 }, acks: [9001, 17],
    } as ClientInputMessage;
    const b = decodeInputBinary(encodeInputBinary(msg));
    expect(b.bodyCheck).toEqual({ hash: 0xa5, tick: 0x4d2 });
    expect(b.ownCheck).toEqual(msg.ownCheck);
    expect(b.acks).toEqual(msg.acks);
    expect(b.fireLeft && b.right && !b.fireRight).toBe(true);
    const e = new InputEncoder(), d = new InputDecoder();
    d.decode(e.encode({ ...msg, bodyCheck: undefined, seq: 40, targetTick: 1233 }, true));
    const c = d.decode(e.encode(msg, true));
    expect(c.bodyCheck).toEqual(msg.bodyCheck);
    expect(c.ownCheck).toEqual(msg.ownCheck);
    expect(c.acks).toEqual(msg.acks);
  });
});

describe('a body\'s state and flight', () => {
  it('decisions fold in at their tick; a SYNC is the whole state', () => {
    const s = bodyStateOfSync(syncArgs({ kind: 0, homeX: 10, homeY: -20, stage: 2, side: -1, target: 77, want: wantFace(1), wantAt: 0, on: true }), 500);
    expect(s).toMatchObject({ kind: 0, homeX: 10, homeY: -20, stage: 2, side: -1, target: 77, wantAt: 500, on: true });
    applyDecision(s, DECISION.WANT, wantDrive(0.5, undefined, 20), 512);
    expect(s.wantAt).toBe(512);
    applyDecision(s, DECISION.TARGET, [0], 513);
    expect(s.target).toBe(-1);
    applyDecision(s, DECISION.OFF, [], 514);
    expect(s.on).toBe(false);
    // (a DRIVE carried on the same way is no new want: its kick was its first tick's)
    expect(sameWant(wantDrive(0.5, undefined, 20), wantDrive(0.5))).toBe(true);
    expect(sameWant(wantDrive(0.5), wantDrive(0.5, undefined, 20))).toBe(false);
    expect(sameWant(wantFly(), wantFace(0))).toBe(false);
  });

  it('the staged flight is a pure function of its inputs, on the wire\'s grids', () => {
    const T = BODY_KINDS[bodyKindOf('scrap_mother')].flight!;
    const s = bodyStateOfSync([0, 64840, 32349, 2, 1, 4243, WANT.FLY], 100);
    const me = { x: 63003.59, y: 35798.18, angle: -2.45234, vx: -17.4099, vy: -4.3344 }, tg = { x: 62341.91, y: 35535.17, angle: -0.39507, vx: -13.8178, vy: -6.3139 };
    const a = stagedFlight(T, s, me, tg, 101), b = stagedFlight(T, { ...s }, { ...me }, { ...tg }, 101);
    expect(a).toEqual(b);
    expect(a.q).toBeGreaterThanOrEqual(0);
    expect(a.q).toBeLessThan(8191);
    for (const v of [a.ix, a.iy]) expect(v * 1024).toBe(Math.round(v * 1024));
    // (a dart's kick on its first tick only)
    applyDecision(s, DECISION.WANT, wantDrive(1, undefined, 20), 110);
    const k0 = stagedFlight(T, s, me, tg, 110), k1 = stagedFlight(T, s, me, tg, 111);
    expect(Math.hypot(k0.ix, k0.iy)).toBeGreaterThan(19);
    expect(Math.hypot(k1.ix, k1.iy)).toBeLessThan(1);
    // (holding: no drive)
    applyDecision(s, DECISION.WANT, wantLead(25), 120);
    const h = stagedFlight(T, s, me, tg, 121);
    expect(h.ix).toBe(0);
    expect(h.iy).toBe(0);
    expect(bodyHash(1, { ...me, angVel: 0 }, s)).toBe(bodyHash(1, { ...me, angVel: 0 }, { ...s }));
  });

  it('the enemy AI pilot: its orders whole numbers through a SYNC, pure of its inputs, its pack read in id order', () => {
    const want = orderEngage(4250, 700, 1800.4, true, 0.0675, 201, 0.55, -0.6, [4252, 4249]);
    for (const v of want) expect(Number.isInteger(v)).toBe(true);
    expect(want[0]).toBe(AI_ORDER.ENGAGE);
    expect(orderPack(4250, want)).toEqual([4249, 4250, 4252]);
    const kind = bodyKindOf('ai');
    const s = bodyStateOfSync(syncArgs({ kind, homeX: 0, homeY: 0, stage: 1, side: -1, target: 4243, want, wantAt: 300, on: true }), 300);
    expect(s.want).toEqual(want);
    expect(aiReads(4250, s)).toEqual([4243, 4249, 4252]);
    expect(decisionRowOk([4250, 0, DECISION.SYNC, ...syncArgs(s)])).toBe(true);
    // (its aim error: within its bound, the same for the same tick, re-rolled every 12 + id % 7 ticks)
    const errs = new Set<number>();
    for (let t = 0; t < 600; t++) { const e = aiAimError(want, 4250, t); expect(Math.abs(e)).toBeLessThanOrEqual(0.0675 + 1e-9); errs.add(e); }
    expect(errs.size).toBeGreaterThan(20);
    expect(aiAimError(want, 4250, 333)).toBe(aiAimError([...want], 4250, 333));
    const me = { x: 1000.25, y: -40.5, angle: 1.2, vx: 2.5, vy: -1.25 }, tg = { x: 1800, y: 300, angle: 0, vx: -3, vy: 1 };
    const c = packCentroid([4249, 4250, 4252], (id) => ({ x: id * 3.3, y: -id * 1.1 }));
    const a = aiPilot(s, me, tg, c, 301, 4250, 1234), b = aiPilot({ ...s }, { ...me }, { ...tg }, c && [c[0], c[1]], 301, 4250, 1234);
    expect(a).toEqual(b);
    expect(a.q).toBeGreaterThanOrEqual(0);
    expect(a.q).toBeLessThan(8191);
    expect(a.ix).toBe(0);
    // (its heading held: a hair off the aim it flew with is no change)
    const p = bodyStateOfSync(syncArgs({ ...s, want: orderPatrol(1000.25, -40.5, 0.5, 0) }), 300);
    expect(aiPilot(p, me, null, null, 301, 4250, 1566).q).toBe(1566);
    expect(aiPilot(p, me, null, null, 301, 4250, 1234).q).toBe(1564);
    expect(BODY_KINDS[kind].toldHits).toBe(false);
  });
});
