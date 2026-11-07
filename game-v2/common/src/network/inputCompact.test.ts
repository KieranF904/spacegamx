import { describe, it, expect } from 'vitest';
import { InputEncoder, InputDecoder, planAim, aimStep, cursorDistIndex, cursorDistOnGrid, CURSOR_DIST_GRID } from './inputCompact.js';
import { CI_FLAG, CI, CI_EXTRA } from './inputCompactTables.js';
import { encodeInputBinary, decodeInputBinary, isBinaryMessage, decodeMessage, type ClientInputMessage } from './protocol.js';
import { quantizeCursorAngle, dequantizeCursorAngle } from './cursorState.js';

const base = (o: Partial<ClientInputMessage> = {}): ClientInputMessage => ({
  type: 'input', seq: 1, tick: 0, targetTick: 1000, forward: false, backward: false, left: false, right: false, boost: false,
  fireLeft: false, fireRight: false, targetAngle: dequantizeCursorAngle(100), strafeLeft: false, strafeRight: false, helm: false,
  cursorDist: 400, jump: false, dodge: false, ...o,
});

/** What the server gets: a pair of ends, every message through both */
function pair() {
  const enc = new InputEncoder(), dec = new InputDecoder();
  const send = (m: ClientInputMessage, compact = true) => {
    const data = enc.encode(m, compact);
    return { data: new Uint8Array(data), got: dec.decode(data) };
  };
  return { enc, dec, send };
}

/** The fields the server reads, as the base layout would carry them */
const asServer = (m: ClientInputMessage) => {
  const { tick: _t, ...rest } = m;
  return { ...rest, tick: 0, targetTick: m.targetTick! & 0xffff, seq: m.seq & 0xffff, targetAngle: Math.fround(dequantizeCursorAngle(quantizeCursorAngle(m.targetAngle))) };
};

describe('compact inputs: the codec', () => {
  it('the first input says everything; then only what changed (a mouse-steer tick is 2 bytes)', () => {
    const { send } = pair();
    const a = send(base());
    expect(a.data[0] & CI_FLAG).toBeTruthy();
    expect(a.got).toEqual(asServer(base()));
    // the next tick, aim one fine step on: the groups byte and the step
    const b = send(base({ seq: 2, targetTick: 1001, targetAngle: dequantizeCursorAngle(102) }));
    expect([...b.data]).toEqual([CI_FLAG | CI.AIM_FINE, 1]);
    expect(b.got.targetAngle).toBe(Math.fround(dequantizeCursorAngle(102)));
    // a key three ticks on: groups, tick step, keys
    const c = send(base({ seq: 3, targetTick: 1004, targetAngle: dequantizeCursorAngle(102), forward: true }));
    expect([...c.data]).toEqual([CI_FLAG | CI.TICK | CI.KEYS, 3, 1]);
    expect(c.got.forward).toBe(true);
    expect(c.got.cursorDist).toBe(400);
  });

  it('round trips a long seeded run exactly, whatever changes, with both layouts mixed in', () => {
    const { send, enc } = pair();
    let seed = 99, tick = 5000, seq = 65530, q = 4000, distI = 300;
    const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    const keys = ['forward', 'backward', 'left', 'right', 'boost', 'fireLeft', 'fireRight', 'strafeLeft', 'strafeRight', 'helm', 'jump', 'dodge'] as const;
    let m = base();
    for (let i = 0; i < 4000; i++) {
      tick += rnd() < 0.8 ? 1 : rnd() < 0.5 ? Math.floor(rnd() * 300) : -Math.floor(rnd() * 3);
      seq = rnd() < 0.98 ? seq + 1 : seq + 5;
      const r = rnd();
      q = r < 0.5 ? planAim(q, (q + Math.floor((rnd() - 0.5) * 600) + 8192) % 8192) : r < 0.6 ? Math.floor(rnd() * 8192) : q;
      if (rnd() < 0.2) distI = Math.max(0, Math.min(CURSOR_DIST_GRID.length - 1, distI + Math.floor((rnd() - 0.5) * 400)));
      const next: ClientInputMessage = { ...m, seq, targetTick: tick, targetAngle: dequantizeCursorAngle(q), cursorDist: rnd() < 0.05 ? Math.floor(rnd() * 50000) * 4 : CURSOR_DIST_GRID[distI] };
      for (const k of keys) if (rnd() < 0.05) next[k] = !next[k];
      if (rnd() < 0.05) next.hitReport = { hash: Math.floor(rnd() * 256), tick: Math.floor(rnd() * 16384), epoch: Math.floor(rnd() * 4) }; else delete next.hitReport;
      if (rnd() < 0.05) next.ownCheck = { body: Math.floor(rnd() * 256), hp: Math.floor(rnd() * 16), tick: Math.floor(rnd() * 4096) }; else delete next.ownCheck;
      if (rnd() < 0.05) next.acks = [Math.floor(rnd() * 100000), Math.floor(rnd() * 256), 7, 9]; else delete next.acks;
      const { got } = send(next, rnd() < 0.9);
      const want = asServer(next);
      // (the base layout carries the distance in 4-unit steps)
      if (got.cursorDist !== next.cursorDist) want.cursorDist = Math.round(next.cursorDist! / 4) * 4;
      expect(got).toEqual(want);
      m = next;
    }
    expect(enc.stats.compact).toBeGreaterThan(3000);
    expect(enc.stats.base).toBeGreaterThan(300);
  });

  it('escapes: a far tick, the same tick again and a tick back go in full; a big flick and the first aim as the aim itself', () => {
    const { send } = pair();
    send(base());
    const far = send(base({ seq: 2, targetTick: 1300 }));
    expect([...far.data]).toEqual([CI_FLAG | CI.TICK, 0, 1300 & 0xff, 1300 >> 8]);
    expect(far.got.targetTick).toBe(1300);
    expect(send(base({ seq: 3, targetTick: 1300 })).got.targetTick).toBe(1300);
    expect(send(base({ seq: 4, targetTick: 1299 })).got.targetTick).toBe(1299);
    // across the 16-bit wrap
    expect(send(base({ seq: 5, targetTick: 65535 })).got.targetTick).toBe(65535);
    const wrap = send(base({ seq: 6, targetTick: 65536 + 4 }));
    expect([...wrap.data]).toEqual([CI_FLAG | CI.TICK, 5]);
    expect(wrap.got.targetTick).toBe(4);
    // a coarse step, then a flick past it: the aim itself
    const coarse = send(base({ seq: 7, targetTick: 5, targetAngle: dequantizeCursorAngle(100 + 16 * 100) }));
    expect([...coarse.data]).toEqual([CI_FLAG | CI.AIM_COARSE, 100]);
    const flick = send(base({ seq: 8, targetTick: 6, targetAngle: dequantizeCursorAngle(5000) }));
    expect([...flick.data]).toEqual([CI_FLAG | CI.AIM_FINE | CI.AIM_COARSE, 5000 & 0xff, 5000 >> 8]);
    // an odd step isn't on the fine grid: also the aim itself (exact, whatever the client chose)
    const odd = send(base({ seq: 9, targetTick: 7, targetAngle: dequantizeCursorAngle(5001) }));
    expect(odd.data[0]).toBe(CI_FLAG | CI.AIM_FINE | CI.AIM_COARSE);
    expect(quantizeCursorAngle(odd.got.targetAngle)).toBe(5001);
    // a seq that isn't the next one rides along
    const sq = send(base({ seq: 50, targetTick: 8, targetAngle: dequantizeCursorAngle(5001) }));
    expect([...sq.data]).toEqual([CI_FLAG | CI.EXTRA, 1, 50, 0]);
    expect(sq.got.seq).toBe(50);
  });

  it('the distance: a step on its grid, the grid index after a jump of it, the base layout when off the grid', () => {
    const { send } = pair();
    send(base({ cursorDist: cursorDistOnGrid(400) }));
    const i = cursorDistIndex(400);
    const step = send(base({ seq: 2, targetTick: 1001, cursorDist: CURSOR_DIST_GRID[i + 30] }));
    expect([...step.data]).toEqual([CI_FLAG | CI.DIST, 30]);
    const jump = send(base({ seq: 3, targetTick: 1002, cursorDist: CURSOR_DIST_GRID[i + 400] }));
    expect([...jump.data]).toEqual([CI_FLAG | CI.DIST, 0x80, (i + 400) & 0xff, (i + 400) >> 8]);
    const off = send(base({ seq: 4, targetTick: 1003, cursorDist: 12345 }));
    expect(off.data[0]).toBe(0x03);
    expect(off.got.cursorDist).toBe(12344);
    // after which, a step needs the grid again: the index
    const back = send(base({ seq: 5, targetTick: 1004, cursorDist: CURSOR_DIST_GRID[i] }));
    expect([...back.data]).toEqual([CI_FLAG | CI.DIST, 0x80, i & 0xff, i >> 8]);
  });

  it('switching from the base layout mid-run: the compact one steps from the last base input', () => {
    const { send } = pair();
    send(base({ forward: true, cursorDist: 1000 }), false);
    const c = send(base({ seq: 2, targetTick: 1001, forward: true, cursorDist: 1000, targetAngle: dequantizeCursorAngle(104) }));
    expect([...c.data]).toEqual([CI_FLAG | CI.AIM_FINE, 2]);
    expect(c.got.cursorDist).toBe(1000);
    expect(c.got.forward).toBe(true);
  });

  it('riders: hit report, own check and debris acks after the groups', () => {
    const { send } = pair();
    send(base());
    const r = send(base({ seq: 2, targetTick: 1001, hitReport: { hash: 200, tick: 9000, epoch: 3 }, ownCheck: { body: 7, hp: 9, tick: 4000 }, acks: [300, 17, 5, 250] }));
    expect(r.data.length).toBe(1 + 1 + 3 + 3 + 1 + 3 + 2);
    expect(r.got.hitReport).toEqual({ hash: 200, tick: 9000, epoch: 3 });
    expect(r.got.ownCheck).toEqual({ body: 7, hp: 9, tick: 4000 });
    expect(r.got.acks).toEqual([300, 17, 5, 250]);
  });

  it('a field it does not carry (a rider added to the base layout since) sends that input in the base layout', () => {
    const { send } = pair();
    send(base());
    const m = { ...base({ seq: 2, targetTick: 1001 }), laterRider: { x: 1 } } as unknown as ClientInputMessage;
    expect(send(m).data[0]).toBe(0x03);
    expect(send(base({ seq: 3, targetTick: 1002, forward: true })).data[0] & CI_FLAG).toBeTruthy();
  });

  it('is told apart from the base layout, and refuses to decode without its last input', () => {
    const { enc } = pair();
    enc.encode(base(), true);
    const d = enc.encode(base({ seq: 2, targetTick: 1001, forward: true }), true);
    expect(isBinaryMessage(d)).toBe(true);
    expect(() => decodeMessage(d)).toThrow(/InputDecoder/);
    expect(() => new InputDecoder().decode(d)).toThrow(/no tick/);
    expect(() => new InputDecoder().decode(new Uint8Array([CI_FLAG | CI.TICK | CI.KEYS, 0, 1]))).toThrow(/ended early/);
    // the base layout is unchanged
    expect(decodeInputBinary(encodeInputBinary(base())).cursorDist).toBe(400);
  });
});

describe('compact inputs: the client\'s grids', () => {
  it('planAim: fine within 254 (off by at most 1), coarse within 2,032 (off by at most 8: the rest next tick), else the aim', () => {
    expect(planAim(-1, 1234)).toBe(1234);
    expect(planAim(100, 100)).toBe(100);
    expect(planAim(100, 140)).toBe(140);
    expect(planAim(100, 141)).toBe(140);
    expect(planAim(100, 59)).toBe(60);
    expect(planAim(8190, 4)).toBe(4); // the short way round, across 0
    for (let w = 0; w < 8192; w += 7) {
      const got = planAim(3000, w), d = Math.abs(aimStep(got, w));
      const far = Math.abs(aimStep(3000, w));
      expect(d).toBeLessThanOrEqual(far <= 255 ? 1 : far < 2040 ? 8 : 0);
      // a flick split over ticks lands in two
      expect(Math.abs(aimStep(planAim(got, w), w))).toBeLessThanOrEqual(1);
    }
  });

  it('weapon groups ride only the input that carries them, in both layouts, before the other riders', () => {
    const { send } = pair();
    send(base());
    // compact: one EXTRA byte and the selection
    const c = send(base({ seq: 2, targetTick: 1001, weaponGroups: 0x21 }));
    expect([...c.data]).toEqual([CI_FLAG | CI.EXTRA, CI_EXTRA.GROUPS, 0x21]);
    expect(c.got.weaponGroups).toBe(0x21);
    // the next input says nothing of it (the server keeps the last)
    expect(send(base({ seq: 3, targetTick: 1002 })).got.weaponGroups).toBeUndefined();
    // with a hit report and an own check after it
    const r = send(base({ seq: 4, targetTick: 1003, weaponGroups: 0, hitReport: { hash: 9, tick: 77, epoch: 1 }, ownCheck: { body: 3, hp: 2, tick: 11 } }));
    expect(r.got.weaponGroups).toBe(0);
    expect(r.got.hitReport).toEqual({ hash: 9, tick: 77, epoch: 1 });
    expect(r.got.ownCheck).toEqual({ body: 3, hp: 2, tick: 11 });
    // the base layout: type 0x04, the byte at [11], riders and acks after it
    const b = send(base({ seq: 5, targetTick: 1004, cursorDist: 12345, weaponGroups: 0x43, hitReport: { hash: 1, tick: 2, epoch: 3 }, acks: [70000, 5] }), false);
    expect(b.data[0]).toBe(0x04);
    expect(b.data[11]).toBe(0x43);
    expect(b.got.weaponGroups).toBe(0x43);
    expect(b.got.hitReport).toEqual({ hash: 1, tick: 2, epoch: 3 });
    expect(b.got.acks).toEqual([70000, 5]);
    expect(isBinaryMessage(b.data)).toBe(true);
    const plain = decodeInputBinary(encodeInputBinary(base({ weaponGroups: 0x10 })));
    expect(plain.weaponGroups).toBe(0x10);
    expect(decodeInputBinary(encodeInputBinary(base())).weaponGroups).toBeUndefined();
    expect(new Uint8Array(encodeInputBinary(base()))[0]).toBe(0x03);
    // and the compact one steps on from a base 0x04 input
    const after = send(base({ seq: 6, targetTick: 1005, cursorDist: 12344 }));
    expect(after.data[0] & CI_FLAG).toBeTruthy();
    expect(after.got.targetTick).toBe(1005);
  });

  it('the distance grid: whole units, 4-unit steps then 1/256 of the distance, up to the max; nearest index', () => {
    const g = CURSOR_DIST_GRID;
    expect(g[0]).toBe(0);
    expect(g[1]).toBe(4);
    expect(g[g.length - 1]).toBe(200000);
    expect(g.length).toBeLessThan(2048);
    for (let i = 1; i < g.length; i++) {
      expect(Number.isInteger(g[i])).toBe(true);
      expect(g[i] - g[i - 1]).toBeLessThanOrEqual(Math.max(4, g[i - 1] / 256) + 1);
    }
    expect(cursorDistIndex(-5)).toBe(0);
    expect(cursorDistIndex(1e9)).toBe(g.length - 1);
    expect(cursorDistOnGrid(401)).toBe(400);
    expect(cursorDistOnGrid(403)).toBe(404);
    expect(Math.abs(cursorDistOnGrid(54321) - 54321) / 54321).toBeLessThan(0.002);
  });
});
