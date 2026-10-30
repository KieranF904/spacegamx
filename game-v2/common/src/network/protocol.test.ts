import { describe, it, expect } from 'vitest';
import { ClientInputMessage, decodeInputBinary, encodeInputBinary, unwrapTick16 } from './protocol.js';
import { quantizeCursorAngle, dequantizeCursorAngle } from './cursorState.js';

describe('binary input messages', () => {
  it('carry every control through a round trip', () => {
    const msg: ClientInputMessage = {
      type: 'input', seq: 77, tick: 123456, targetTick: 123460,
      forward: true, backward: false, left: true, right: false, boost: true, fireLeft: false, fireRight: true,
      targetAngle: 1.25, strafeLeft: true, strafeRight: false, helm: true, cursorDist: 480, jump: true,
    };
    const out = decodeInputBinary(encodeInputBinary(msg));
    // 11 bytes: the aim goes in the 13-bit cursor quantization, the target tick as its low 16 bits, no tick
    expect(encodeInputBinary(msg).byteLength).toBe(11);
    expect(out).toEqual({ ...msg, tick: 0, targetTick: 123460 & 0xFFFF, targetAngle: Math.fround(dequantizeCursorAngle(quantizeCursorAngle(1.25))) });
    expect(unwrapTick16(out.targetTick!, 123456)).toBe(123460);
    expect(unwrapTick16(65535, 65536 * 3 + 2)).toBe(65536 * 3 - 1);
    expect(decodeInputBinary(encodeInputBinary({ ...msg, jump: false })).jump).toBe(false);
    expect(decodeInputBinary(encodeInputBinary({ ...msg, targetTick: undefined })).targetTick).toBeUndefined();
  });
});

describe('snapshot frames', () => {
  it('compact snapshots and batched frames decode back to the same messages', async () => {
    const { encodeMessage, decodeServerFrame } = await import('./protocol.js');
    const snap = {
      type: 'snapshot' as const, tick: 1234, lastProcessedInput: 7, removed: [5, 6],
      entities: [
        { id: 1, type: 1, x: 10.5, y: -3, angle: 0.25, vx: 1, vy: 0, av: 0.01, hp: 100, maxHp: 120, data: [1, 2, 3], name: 'Ash' },
        { id: 2, type: 10, x: 4, y: 5, data: [3, 0] },
      ],
      out: [9],
      ships: [[2, 1, 4, 5, 0, 0, 0.5, 0, 0, 1, 16, 4000]],
      ctl: [[2, 1, 17, 4100]],
    };
    const one = encodeMessage(snap as any) as string;
    expect(one.length).toBeLessThan(JSON.stringify(snap).length);
    expect(decodeServerFrame(one)).toEqual([snap]);
    const batch = `{"type":"batch","m":[${one},${JSON.stringify({ type: 'toast', text: 'hi', kind: 'info' })}]}`;
    expect(decodeServerFrame(batch)).toEqual([snap, { type: 'toast', text: 'hi', kind: 'info' }]);
  });

  it('projectiles get rows of their own (position only off the straight line), and come back the same', async () => {
    const { encodeMessage, decodeServerFrame } = await import('./protocol.js');
    const shell = { id: 40, type: 7, vx: 8.38, vy: -31.3, data: [1, 1, (2247 * 137) % 360, 1230, 27286.2, 21513.6, 2247, 1, 0] };
    const missile = { id: 41, type: 7, x: 500.5, y: 600.25, vx: 2, vy: 3, data: [4, 2, (12 * 137) % 360, 1200, 100, 200, 12, 1.5, 1] };
    const snap = { type: 'snapshot' as const, tick: 1234, lastProcessedInput: 0, removed: [], entities: [shell, missile] };
    const wire = encodeMessage(snap as any) as string;
    expect(JSON.parse(wire).p).toEqual([[40, 8.38, -31.3, 1, 4, 27286.2, 21513.6, 2247], [41, 2, 3, 4, 34, 100, 200, 12, 2, 1.5, 1, 500.5, 600.25]]);
    expect(decodeServerFrame(wire)).toEqual([snap]);
  });

  it('frequent messages go as arrays of values; anything unexpected goes as it is', async () => {
    const { encodeMessage, decodeServerFrame } = await import('./protocol.js');
    const msgs = [
      { type: 'damage', targetId: 2242, amount: 14, sourceId: 2248 },
      { type: 'damage', targetId: 0, amount: 3, critical: true },
      { type: 'projectileHit', id: 2316, x: 27415.4, y: 21046.2 },
      { type: 'partDestroyed', bodyId: 5, part: 2, fn: 'thruster', how: 'blast', x: 1, y: 2, vx: 0, vy: 0, size: 36 },
      { type: 'shipSync', id: 3, kind: 'ship', hp: [1, 0.5], detached: [], rebuilds: 2, design: 'abc', blueprint: { name: 'X', parts: [] } },
      { type: 'playerState', hp: 1, maxHp: 2, boostFuel: 3, maxBoostFuel: 4, xp: 5, level: 6, credits: 7, systemId: 'sol' },
    ];
    for (const m of msgs) {
      const wire = encodeMessage(m as any) as string;
      expect(wire.startsWith('[')).toBe(true);
      expect(decodeServerFrame(wire)).toEqual([m]);
    }
    expect((encodeMessage({ type: 'damage', targetId: 1, amount: 2 } as any) as string).length).toBeLessThan(20);
    // A field the table doesn't know: sent as an object, so it isn't dropped
    const odd = { type: 'damage', targetId: 1, amount: 2, extra: 'x' };
    expect((encodeMessage(odd as any) as string).startsWith('{')).toBe(true);
    expect(decodeServerFrame(`{"type":"batch","m":[${encodeMessage(msgs[0] as any)},${encodeMessage(odd as any)}]}`)).toEqual([msgs[0], odd]);
  });
});

describe('control rows', () => {
  it('aims go as steps from the last one the client has; a run of them shares its ticks and buttons', async () => {
    const { packControlRow, unpackControlRow, controlRowId } = await import('./replication.js');
    const run: [number, number, number][] = [[2, 9, 5249], [1, 9, 5161], [0, 9, 5133]];
    expect(packControlRow(2250, run, 5270)).toEqual([-2251, 9 * 8 + 2, -21, -88, -28]);
    expect(controlRowId(packControlRow(2250, run, 5270))).toBe(2250);
    expect(unpackControlRow(packControlRow(2250, run, 5270), 5270)).toEqual(run);
    expect(controlRowId(packControlRow(0, run, 0))).toBe(0);
    const mixed: [number, number, number][] = [[2, 4, 6293], [1, 2, 6376]];
    expect(packControlRow(7, mixed, 6293)).toEqual([7, 4 * 8 + 2, 0, 2 * 8 + 1, 83]);
    // A change from long ago (7+ ticks) carries its ticks separately
    const old: [number, number, number][] = [[9, 1024, 5], [0, 3, 6]];
    expect(unpackControlRow(packControlRow(7, old, 0), 0)).toEqual(old);
    expect(unpackControlRow(packControlRow(7, [[12, 5, 1], [11, 5, 2]], 0), 0)).toEqual([[12, 5, 1], [11, 5, 2]]);
    expect(unpackControlRow(packControlRow(7, mixed, 100), 100)).toEqual(mixed);
    // Across the wrap: 8190 -> 3 is a step of 5
    const wrap: [number, number, number][] = [[1, 0, 8190], [0, 0, 3]];
    expect(packControlRow(1, wrap, 8188)).toEqual([-2, 1, 2, 5]);
    expect(unpackControlRow(packControlRow(1, wrap, 8188), 8188)).toEqual(wrap);
  });
});

describe('binary frames', () => {
  it('the codec gives back exactly what JSON would, for every kind of value', async () => {
    const { encodeBinary, decodeBinaryAll } = await import('./binaryCodec.js');
    const values: unknown[] = [
      0, 1, 127, 128, 300, 70000, 2 ** 31, 2 ** 40 + 7, Number.MAX_SAFE_INTEGER, -1, -32, -33, -1000, -(2 ** 35),
      0.5, -0.5, 27302.93, -31.3, 0.083678, 1.18027, 1e-7, 123456.789012, Math.PI, Math.fround(1.1), 1e300, -0,
      NaN, Infinity, null, true, false, '', 'sol', 'x'.repeat(31), 'y'.repeat(32), 'z'.repeat(200), 'Café ☄ pilot', 'thruster', 'blast', 'ship',
      [], [1, null, 'a'], new Array(40).fill(7), { a: 1, b: undefined, c: [1, { d: 'e' }] }, {},
      [0, 2242, 14, 2248], { type: 'toast', text: 'hi', kind: 'info' },
    ];
    for (const v of values) {
      expect(decodeBinaryAll(encodeBinary(v))).toEqual([JSON.parse(JSON.stringify(v) ?? 'null')]);
    }
    // Random numbers as the game makes them: rounded to a few places, or not at all
    for (let i = 0; i < 2000; i++) {
      const raw = (Math.random() - 0.5) * 10 ** (1 + Math.floor(Math.random() * 6));
      const places = Math.floor(Math.random() * 8);
      const v = places === 7 ? raw : Math.round(raw * 10 ** places) / 10 ** places;
      const [back] = decodeBinaryAll(encodeBinary(v));
      expect(back).toBe(JSON.parse(JSON.stringify(v)));
    }
    // Several values in a row decode in order
    const two = new Uint8Array([...encodeBinary([1, 2]), ...encodeBinary('x')]);
    expect(decodeBinaryAll(two)).toEqual([[1, 2], 'x']);
  });

  it('server messages go as binary frames and come back the same, smaller than JSON', async () => {
    const { encodeServerMessage, serverFrame, decodeServerFrame, encodeMessage } = await import('./protocol.js');
    const snap = {
      type: 'snapshot' as const, tick: 1234, lastProcessedInput: 7, removed: [5],
      entities: [{ id: 1, type: 1, x: 10.5, y: -3, angle: 0.25, vx: 1, vy: 0, av: 0.01, hp: 100, maxHp: 120, data: [1, 2, 3], name: 'Ash' },
        { id: 40, type: 7, vx: 8.38, vy: -31.3, data: [1, 1, (2247 * 137) % 360, 1230, 27286.2, 21513.6, 2247, 1, 0] }],
      ships: [[2, 1, 4, 5, 0, 0, 0.5, 0, 0, 1, 16, 4000]],
      ctl: [[9, 1, 17, 4100], [-2251, 2, 9, 5249, -88, -28], [3, 0, 2, 6158]],
    };
    const msgs = [snap, { type: 'damage', targetId: 2242, amount: 14, sourceId: 2248 }, { type: 'toast', text: 'hi', kind: 'info' }, { type: 'pong', clientTime: 1.5, serverTime: 1792549411511, tick: 5 }];
    const frame = serverFrame(msgs.map((m) => encodeServerMessage(m as any)));
    const back = decodeServerFrame(frame) as any[];
    // (control rows come back in id order)
    expect(back[0].ctl).toEqual([[3, 0, 2, 6158], [9, 1, 17, 4100], [-2251, 2, 9, 5249, -88, -28]]);
    expect({ ...back[0], ctl: snap.ctl }).toEqual(snap);
    expect(back.slice(1)).toEqual(msgs.slice(1));
    expect(frame.length).toBeLessThan(msgs.map((m) => (encodeMessage(m as any) as string).length).reduce((a, b) => a + b) * 0.6);
    // And as an ArrayBuffer, as a browser gets it
    expect(decodeServerFrame(frame.slice().buffer)).toEqual(back);
  });
});

describe('protocol version', () => {
  /** FNV-1a, 32 bits, as hex */
  function fnv1a(s: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }

  it('the wire format matches the one PROTOCOL_VERSION was recorded for', async () => {
    const { wireTables, encodeServerMessage, serverFrame, PROTOCOL_VERSION, PROTOCOL_WIRE_HASH } = await import('./protocol.js');
    // The tables, and a frame of the formats built on them (so a change to how they're packed counts too)
    const input: ClientInputMessage = {
      type: 'input', seq: 77, tick: 0, targetTick: 123460, forward: true, backward: false, left: true, right: false,
      boost: true, fireLeft: false, fireRight: true, targetAngle: 1.25, strafeLeft: true, strafeRight: false, helm: true, cursorDist: 480, jump: true,
    };
    const msgs = [
      {
        type: 'snapshot', tick: 1234, lastProcessedInput: 7, removed: [5],
        entities: [{ id: 1, type: 1, x: 10.5, y: -3, angle: 0.25, vx: 1, vy: 0, av: 0.01, hp: 100, maxHp: 120, data: [1, 2, 3], name: 'Ash' },
          { id: 40, type: 7, vx: 8.38, vy: -31.3, data: [1, 1, (2247 * 137) % 360, 1230, 27286.2, 21513.6, 2247, 1, 0] }],
        ships: [[2, 1, 4, 5, 0, 0, 0.5, 0, 0, 1, 16, 4000]], ctl: [[9, 1, 17, 4100], [-2251, 2, 9, 5249, -88, -28]], out: [3], fire: [[2, 1, 0, 100, 50, 51]],
      },
      { type: 'damage', targetId: 2242, amount: 14, sourceId: 2248, critical: true },
      { type: 'shipSync', id: 3, kind: 'ship', hp: [1, 0.5], detached: [], rebuilds: 2, design: 'abc', blueprint: { name: 'X', parts: [] } },
      { type: 'welcome', playerId: 1, tickRate: 60, serverTime: 5, protocol: 1 },
    ];
    const frame = serverFrame(msgs.map((m) => encodeServerMessage(m as any)));
    const bytes = [...new Uint8Array(encodeInputBinary(input)), ...frame].map((b) => b.toString(16).padStart(2, '0')).join('');
    const hash = fnv1a(JSON.stringify(wireTables()) + '|' + bytes);
    expect(hash, `The wire format changed (protocol.ts / binaryCodec.ts). Bump PROTOCOL_VERSION (now ${PROTOCOL_VERSION}) `
      + `in common/src/network/protocol.ts so old clients are told to reload, and set PROTOCOL_WIRE_HASH to '${hash}'.`).toBe(PROTOCOL_WIRE_HASH);
  });
});
