/**
 * Bit-packed frames (packedCodec.ts): every message decodes to exactly what the base format decodes to, the two sides'
 * state stays in step over many frames (slots reused, entities forgotten and back, resets), sub-frames come back as
 * they went, and a frame that doesn't decode stops the reader until the server starts afresh.
 */
import { describe, it, expect } from 'vitest';
import { isDeepStrictEqual } from 'util';
import { decodeServerFrame, encodeServerMessage, serverFrame, type ServerMessage } from '../protocol.js';
import { packHits, type ShellHitRecord } from '../hits.js';
import { PackedEncoder, PackedDecoder, ServerFrameReader } from './packedCodec.js';
import { PACKED_FRAME, PK_TABLE_MAX } from './tables.js';
import { packGunRow, GUN_FIRE, GUN_ALT } from '../../sim/otherGuns.js';

const YOU = 4241;

/** What the base format makes of these messages (one frame) */
const base = (msgs: ServerMessage[]): ServerMessage[] => decodeServerFrame(serverFrame(msgs.map(encodeServerMessage)));

/** Encode sub-frames packed, decode them, and compare with the base format, frame by frame */
function roundTrip(enc: PackedEncoder, dec: PackedDecoder, subs: ServerMessage[][], you = YOU): Uint8Array {
  const data = enc.encode(subs.map((s) => s.map((msg) => ({ msg }))), you);
  const got = dec.decode(data);
  const want = subs.map(base);
  if (!isDeepStrictEqual(got, want)) expect(got).toEqual(want);
  expect(isDeepStrictEqual(got, want)).toBe(true);
  return data;
}

function snap(tick: number, extra: Partial<Record<string, unknown>> = {}): ServerMessage {
  return { type: 'snapshot', tick, lastProcessedInput: 7, entities: [], removed: [], ...extra } as unknown as ServerMessage;
}

/** A pilot's own row, another pilot's status row, a mob, a derelict, an asteroid, own shells, a missile */
function busySnapshot(tick: number, shell0: number, k = 0): ServerMessage {
  return snap(tick, {
    entities: [
      { id: YOU, type: 1, x: 68996 + k * 3.1, y: 28910.98, angle: 1.15109, vx: 4.7484, vy: 4.219, hp: 300, maxHp: 300, data: [801110016, 100, 1737, 0, 0, 0, 1000, 0, 100, 1, 0, 100, 0, 100, 0, 0, 0, 0, 0, 0], av: 0.007143 },
      { id: 4242, type: 1, hp: 300, maxHp: 300, data: [0, 0, 10, 0, 0, 15, 0, 0] },
      { id: 4530, type: 2, x: 69608.5 + k * 30, y: 31951, angle: 0.185, vx: 11.3 - k * 0.6, vy: 2.1, hp: 55, maxHp: 55, data: [1] },
      { id: 4419, type: 10, x: 106279.68, y: 23231.01, angle: 0.44444, data: [3, 0, 0, 0, 0, 0, 0, 0, 5, 0, 0], name: 'Scrap Mite' },
      { id: 900, type: 4, x: 1200.5, y: -300, data: [2, 'iron'] },
    ],
    removed: [],
    ships: [[4253, 1, 69746.51 + k * 20, 29807.51, 2.0934, 6.505, 0.20401 + k * 0.001, 0.005012, 0, 1, 6, 2592]],
    ctl: [[4262, 2, 8, 8, 8], [-1 - 4263, 2, 7, 1, 0], [4265, 0, 29]],
    fire: [[4253, 2, 153 + 256, -1200, shell0 + 50, shell0 + 51], [4300, 1, 255 + 256 * 255, 400]],
  } as never);
}

function ownShells(tick: number, shell0: number): ServerMessage {
  const entities = [];
  for (let i = 0; i < 4; i++) {
    entities.push({ id: shell0 + i, type: 7, vx: 48.16 - i * 0.3, vy: 2.16 + i, data: [1, 1, 0, tick - 3, 67859.7 - i * 0.2, 28042.4 + i * 48, YOU, 1, 0, 0, 143 + i] });
  }
  // A missile: off its line (x, y), a size, a turret, an end tick, tier 3
  entities.push({ id: shell0 + 9, type: 7, vx: -28.32, vy: 19.85, x: 70100.1, y: 29100.2, data: [26, 3, 0, tick - 2, 70160.2, 29128.4, 4253, 1.7, 1, tick + 40, -1] });
  return snap(tick, { entities } as never);
}

describe('packed frames: each message as the base format has it', () => {
  it('snapshots in every part: rows of each kind, shells, removals, keyframes, control rows, out of view, fire events', () => {
    const enc = new PackedEncoder(), dec = new PackedDecoder();
    roundTrip(enc, dec, [[busySnapshot(213, 5000)], [ownShells(216, 5100)]]);
    roundTrip(enc, dec, [[busySnapshot(219, 5200, 1), snap(219, { removed: [5100, 5101, 4530, 77777, 5150], out: [4419] } as never)]]);
    // The rows again: steps from their last, the gone ones as new
    roundTrip(enc, dec, [[busySnapshot(222, 5300, 2), ownShells(222, 5400)]]);
    expect(enc.stats.legacy).toBe(0);
  });

  it('gun rows in a snapshot (each pilot by its slot, then the row): as the base format has them', () => {
    const enc = new PackedEncoder(), dec = new PackedDecoder();
    for (let k = 0; k < 6; k++) {
      const gun = [
        packGunRow(4262, [[3, GUN_FIRE, 180 + k], [2, GUN_FIRE, 181 + k], [1, GUN_FIRE, 183 + k]], 175),
        packGunRow(4263, [[12, GUN_FIRE | GUN_ALT, 40], [4, 0, 1200 - k * 300], [0, GUN_ALT, -3]], 2000),
        packGunRow(YOU + 1 + k, [[k, 0, 250]], 250),
      ];
      roundTrip(enc, dec, [[busySnapshot(300 + 3 * k, 7000 + 10 * k, k), snap(300 + 3 * k, { gun } as never)]]);
    }
    expect(enc.stats.legacy).toBe(0);
    // (Not a gun row's shape: the snapshot goes as the base format's bytes)
    roundTrip(enc, dec, [[snap(330, { gun: [[4262, 1.5, 3]] } as never)]]);
    expect(enc.stats.legacy).toBe(1);
  });

  it('the netcode rounds\' messages field by field (gun lanes, pull fields) and the map, debris splits, boss effects, fresh syncs', () => {
    const enc = new PackedEncoder(), dec = new PackedDecoder();
    for (let k = 0; k < 4; k++) {
      const t = 9000 + 3 * k;
      const msgs = [
        // (a lane as packGunSync cuts it: sparse arrays, absent scalars as null, then the controls and the held distance)
        { type: 'gunSync', id: 4262, t, z: [812, 2, 100, 0, -1, 3, 1, 5, 2, 0, 0, 1, 1, 2, 1, 0, 3, 1, 0, 2, 0, 0.75, 1, 1, t - 40, null, null, null, 4263, 3, 210 + k, 840] },
        { type: 'gunSync', id: 4263, t, z: [], w: t - 2, keep: 1 },
        { type: 'gunSync', id: 4264, t, z: [], ...(k % 2 ? { w: t - 1 } : {}) },
        { type: 'pulls', f: [[17, 4262, 1, t - 30, -1, 4300, 0, 1800, 2.5], [18, 4419, 0, t - 90, t - 4, 0, 1]], ...(k === 2 ? { r: 1 } : {}) },
        { type: 'mapDots', tick: t, dots: [4262, 6899 + k, 2891, 474, 421, 0, 0, 120, 4263, 7100, -2010, -33, 12, 0, 0, -1], info: [4262, 1, 0, 4263, 3, 7], gone: k ? [4100 + k] : undefined, names: [4263, 'Brood Mother'], ...(k === 0 ? { full: 1 } : {}), routes: [4300, 12, 7000.5, 2900, 1.25, -0.5, 7100, 2950, 7000, 2900, 800, 3.5, 991] , pts: [4301, 700, 290] },
        { type: 'debrisSplit', id: 4419, tick: t - 1, e: [5000, 1, 1, 2], p: [0, 4, 7, 2], l: 1, s: [106279.68, 23231.01, 0.44444, 1.25, -0.5, 0.0012], h: [12.5, 30, 4.1] },
        { type: 'bossBeam', bodyId: 4530, x: 120, y: -40, a0: 0.7853981633974483, a1: 0.7853981633974483, ticks: 90, length: 3600, width: 200 },
        { type: 'bossBeam', bodyId: 4530, x: 0, y: 0, a0: 1, a1: 1.5, ticks: 30, length: 900, width: 40, kind: 'crystal' },
        { type: 'bossTelegraph', shape: 'line', kind: 'lane', bodyId: 4530, x: 30, y: -10, angle: 0.333, length: 3600, width: 200, ticks: 60 },
        { type: 'bossTelegraph', shape: 'circle', kind: 'vent', x: 69000, y: 29000, radius: 400, ticks: 600 },
        { type: 'bossBlow', bodyId: 4530, part: 7 + k },
        { type: 'shipSync', id: 4253, kind: 'ship', hp: [100, 80.5, 3], maxHp: [100, 90, 3], detached: [], rebuilds: 2, at: t - 1 },
      ] as unknown as ServerMessage[];
      roundTrip(enc, dec, [msgs]);
    }
    expect(enc.stats.legacy).toBe(0);
  });

  it('the field-by-field messages, hits, part HP; the rest as the base format has them', () => {
    const enc = new PackedEncoder(), dec = new PackedDecoder();
    const recs: ShellHitRecord[] = [
      { shell: 5000, ago: 2, target: 4253, part: 45, gone: true, glancing: false },
      { shell: 5001, ago: 7, target: 4253, part: 12, gone: false, glancing: true, d10: 112, ignite: 3 },
      { shell: 5003, ago: 0, target: YOU, part: 0, gone: true, glancing: false, shield: true, d10: -2 },
      { shell: 4999, ago: 1, target: 4253, part: 300, gone: false, glancing: false, ignite: -1 },
    ];
    const msgs: ServerMessage[] = [
      { type: 'damage', targetId: 4253, amount: 22, sourceId: YOU, glancing: true },
      { type: 'damage', targetId: YOU, amount: 4.6, sourceId: 4242, critical: false, hp: 120.5, maxHp: 300 },
      { type: 'projectileHit', id: 5000, x: 68088.3, y: 28097 },
      { type: 'projectileHit', id: 5002, x: 68136.3, y: 28054.8 },
      { type: 'hits', h: packHits(recs) },
      { type: 'shipHps', ships: [[4253, [[7, 70.6], [42, 20.1]]], [YOU, [[8, 56.6]]]] },
      { type: 'shipHps', ships: [[4253, [[7, 70.1], [42, 0]]]] },
      { type: 'hpCheck', id: 4253, sum: 65327 },
      { type: 'detonation', kind: 'flak', x: 69678, y: 30334, radius: 260 },
      { type: 'detonation', kind: 'not-a-listed-kind', x: 69678.5, y: -30334, radius: 40, from: YOU },
      { type: 'ignite', bodyId: 4253, part: 32, ticks: 180 },
      { type: 'partDestroyed', bodyId: 4253, part: 45, fn: 'engine_plasma_drive', how: 'blast', x: 68148.3, y: 28247.9, vx: 0, vy: 0, size: 52.8 },
      { type: 'contact', x: 77732.44, y: 54035.37, nx: -0.76, ny: -0.65, speed: 0.75 },
      { type: 'shipSync', id: 4253, kind: 'ship', detached: [], rebuilds: 7, hpd: [[32, 421.8], [34, 422.8], [42, 11.9], [45, 0]] },
      { type: 'playerState', hp: 300, maxHp: 300, boostFuel: 100, maxBoostFuel: 100, xp: 0, level: 1, credits: 300, systemId: 'sol' },
      { type: 'toast', text: 'The comet is passing Sol System — ünïcode', kind: 'good' },
      { type: 'pong', clientTime: 1730000000123, serverTime: 1730000000456, tick: 99999, serverProcessing: 0.25 },
      { type: 'hitFix', s: 1356, t: 1365, c: 2693506514, e: 3, h: [5180, 125, 4253, 65, 1, 77, 4, 112, 41, 1, 8] },
      { type: 'items', cargo: [], storage: [{ id: 'iron_ore', n: 40 }], cargoCapacity: 30, credits: 300, atStation: false },
    ] as unknown as ServerMessage[];
    roundTrip(enc, dec, [msgs]);
    // (Snapshots with the shells the hits named: the spent ones forgotten, the others still known)
    roundTrip(enc, dec, [[snap(300, { removed: [5002, 5001, 4999] } as never)]]);
    expect(enc.stats.packed).toBeGreaterThan(enc.stats.legacy);
  });

  it('odd values: NaN, infinities, -0, tiny and huge numbers, strings and objects where numbers go, nulls mid-row', () => {
    const enc = new PackedEncoder(), dec = new PackedDecoder();
    const odd: ServerMessage[] = [
      { type: 'damage', targetId: 4253, amount: NaN, sourceId: -5, hp: -0, maxHp: Infinity, glancing: 'yes' },
      { type: 'damage', targetId: 1.5, amount: 1e-9, sourceId: 2 ** 52 + 2, critical: true },
      { type: 'contact', x: 0.1 + 0.2, y: -1e21, nx: 1 / 3, ny: Math.PI, speed: 3.4028234663852886e38 },
      { type: 'hpCheck', id: 'ship', sum: { nested: [1, 'two', null, [3.25]] } },
      { type: 'detonation', kind: 12, x: 1, y: 2, radius: 3, from: null, mob: 'boss_scrap_mother' },
      { type: 'shipHps', ships: [[4253, [[7, NaN], [5000, 1]]]] },
      { type: 'shipSync', id: 4253, kind: 'ship', hpd: [[1, 2, 3]], ghosts: [{ a: 1 }] },
      snap(400, {
        entities: [
          { id: 4530, type: 2, x: -0, y: 1e-7, angle: NaN, vx: 'fast', data: [1, 'x', null, 2.5, -7, 1e15] },
          { id: 4531, type: 31, x: 1, data: { odd: true } as never, name: 'Ω' },
          { id: 4532, type: 0 },
        ],
        ships: [[4253, 1, 1.23456789, null, 'x', 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17.5]],
        ctl: [[4262, 2.5, 'x', null]],
        fire: [[4253, -1, 0.5, NaN]],
      } as never),
    ] as unknown as ServerMessage[];
    roundTrip(enc, dec, [odd]);
  });

  it('shapes it does not pack go as the base format has them (and the stream goes on)', () => {
    const enc = new PackedEncoder(), dec = new PackedDecoder();
    const weird: ServerMessage[] = [
      // (Negative and fractional ids, a bad entity type, a hits list that isn't canonical, part HP that isn't pairs)
      snap(10, { removed: [-1, 2.5] } as never),
      snap(10, { entities: [{ id: 5, type: 99 }] } as never),
      snap(10, { ships: [[-4, 1]] } as never),
      { type: 'hits', h: [5000, 8, 4253, 3, 9] },
      { type: 'shipHps', ships: [['a', []]] },
      { type: 'shipSync', id: 4253, kind: 'ship', blueprint: { name: 'Scrap Spitter', parts: [{ uid: 0, piece: 'sq', fn: 'laser' }] } },
    ] as unknown as ServerMessage[];
    roundTrip(enc, dec, [weird]);
    expect(enc.stats.legacy).toBeGreaterThanOrEqual(5);
    roundTrip(enc, dec, [[busySnapshot(13, 5000)]]);
  });
});

describe('packed frames: both sides keep the same state', () => {
  it('a long seeded run: entities and shells come and go, slots are reused, steps are taken from the last values', () => {
    let seed = 12345;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const enc = new PackedEncoder(), dec = new PackedDecoder();
    const live = new Set<number>(), shells = new Set<number>();
    let nextShell = 10000, tick = 1000;
    for (let f = 0; f < 400; f++) {
      tick += rnd() < 0.8 ? 3 : 1 + Math.floor(rnd() * 9);
      const entities: unknown[] = [];
      for (let i = 0; i < 1 + rnd() * 6; i++) {
        const id = 4000 + Math.floor(rnd() * 60);
        live.add(id);
        entities.push({ id, type: [1, 2, 10][Math.floor(rnd() * 3)], x: Math.round(rnd() * 1e7) / 100, y: Math.round(rnd() * 1e6) / 10, angle: Math.round(rnd() * 6e5) / 1e5, vx: Math.round(rnd() * 1e5) / 1e4, hp: 300, maxHp: 300, data: [Math.floor(rnd() * 100)] });
      }
      for (let i = 0; i < rnd() * 4; i++) {
        const id = nextShell++;
        shells.add(id);
        entities.push({ id, type: 7, vx: Math.round(rnd() * 1e4) / 100, vy: -2.5, data: [1, 1, 0, tick - 1, Math.round(rnd() * 1e6) / 10, 5.5, rnd() < 0.5 ? YOU : 4000 + Math.floor(rnd() * 60), 1, 0, 0, Math.floor(rnd() * 200)] });
      }
      const removed: number[] = [];
      const msgs: ServerMessage[] = [];
      for (const id of [...shells]) if (rnd() < 0.3) {
        if (rnd() < 0.5) msgs.push({ type: 'projectileHit', id, x: 1.5, y: 2.5 } as ServerMessage);
        removed.push(id);
        shells.delete(id);
      }
      for (const id of [...live]) if (rnd() < 0.05) { removed.push(id); live.delete(id); }
      const ships = [...live].filter(() => rnd() < 0.2).map((id) => [id, 1, Math.round(rnd() * 1e7) / 100, 3, 0.5, 0.25, 0.1, 0, 0, 1, 6, Math.floor(rnd() * 8000)]);
      const ctl = [...live].filter(() => rnd() < 0.3).map((id) => [rnd() < 0.2 ? -1 - id : id, Math.floor(rnd() * 3), Math.floor(rnd() * 99)]);
      const fire = rnd() < 0.3 ? [[4000 + Math.floor(rnd() * 60), 1, 153, Math.floor(rnd() * 8000) - 4000, nextShell++, nextShell++]] : [];
      msgs.push(snap(tick, { entities, removed, ships, ctl, fire, out: rnd() < 0.05 && live.size ? [[...live][0]] : [] } as never));
      for (const id of (msgs[msgs.length - 1] as unknown as { out: number[] }).out) live.delete(id);
      // (Sometimes two frames in one message, as coalescing sends them)
      if (rnd() < 0.3) roundTrip(enc, dec, [msgs.slice(0, 1), msgs.slice(1)].filter((s) => s.length));
      else roundTrip(enc, dec, [msgs]);
    }
    expect(enc.stats.resets).toBe(1);
  });

  it('starts afresh when the pilot changes ship, and when a table fills up', () => {
    const enc = new PackedEncoder(), dec = new PackedDecoder();
    roundTrip(enc, dec, [[busySnapshot(10, 5000)]]);
    roundTrip(enc, dec, [[busySnapshot(13, 5100)]], 4999);
    expect(enc.stats.resets).toBe(2);
    // Out of view one at a time never frees what the removed list didn't name: a full table starts again
    const many = Array.from({ length: PK_TABLE_MAX + 10 }, (_, i) => ({ id: 100000 + i, type: 1, hp: 1 }));
    roundTrip(enc, dec, [[snap(20, { entities: many } as never)]], 4999);
    roundTrip(enc, dec, [[snap(23, { entities: many.slice(0, 5) } as never)]], 4999);
    expect(enc.stats.resets).toBe(3);
  });

  it('a packed snapshot is far smaller than the base format', () => {
    const enc = new PackedEncoder(), dec = new PackedDecoder();
    let packed = 0, plain = 0;
    for (let k = 0; k < 20; k++) {
      const msgs = [busySnapshot(100 + 3 * k, 5000 + 100 * k, k), ownShells(100 + 3 * k, 5050 + 100 * k)];
      packed += roundTrip(enc, dec, [msgs]).length;
      plain += serverFrame(msgs.map(encodeServerMessage)).length;
    }
    expect(packed).toBeLessThan(plain * 0.6);
  });
});

describe('packed frames: the reader', () => {
  it('reads base-format frames and packed messages alike, a packed one as its sub-frames', () => {
    const reader = new ServerFrameReader();
    const enc = new PackedEncoder();
    const a = busySnapshot(10, 5000), b = ownShells(13, 5100);
    expect(reader.read(serverFrame([encodeServerMessage(a)]))).toEqual([base([a])]);
    const data = enc.encode([[{ msg: a }], [{ msg: b }]], YOU);
    expect(data[0]).toBe(PACKED_FRAME);
    expect(reader.read(data)).toEqual([base([a]), base([b])]);
    // (An ArrayBuffer as the browser gives it; this message starts afresh, so it reads again)
    expect(reader.read(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength))).toEqual([base([a]), base([b])]);
  });

  it('a message that does not decode stops it until the server starts afresh (packedResync)', () => {
    const reader = new ServerFrameReader();
    const enc = new PackedEncoder();
    reader.read(enc.encode([[{ msg: busySnapshot(10, 5000) }]], YOU));
    const next = enc.encode([[{ msg: busySnapshot(13, 5100) }]], YOU);
    expect(() => reader.read(next.slice(0, 6))).toThrow();
    expect(reader.needsResync).toBe(true);
    // (Nothing more is read: its state is gone)
    expect(reader.read(enc.encode([[{ msg: busySnapshot(16, 5200) }]], YOU))).toEqual([]);
    enc.reset();
    const msg = busySnapshot(19, 5300);
    expect(reader.read(enc.encode([[{ msg }]], YOU))).toEqual([base([msg])]);
    expect(reader.needsResync).toBe(false);
  });
});
