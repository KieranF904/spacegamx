/**
 * Encode-once blocks (CAPS.BLOCKS: blocks.ts, blocksSnapshot.ts): snapshots built from rows shared between clients, as
 * the server builds them, decode for every client to exactly what the base format decodes to; each row is encoded
 * once whoever gets it; a client that missed rows (or came late) gets the absolute form and is back in step after;
 * wire ids are dense, reused, and moved with an entity's system; and a block a client can't resolve stops its reader.
 */
import { describe, it, expect } from 'vitest';
import { isDeepStrictEqual } from 'util';
import { decodeServerFrame, encodeServerMessage, serverFrame, type EntityState, type ServerMessage } from '../protocol.js';
import { PackedEncoder, PackedDecoder } from './packedCodec.js';
import { BlockStore, derivedRow, fireBody } from './blocks.js';
import { PackedIO } from './packedIO.js';
import { gunCode, gunCodePart, gunCodeAmmo, gunCodeAug, gunCodeFx } from '../../ships/launch.js';
import { packGunRow, GUN_FIRE, GUN_ALT } from '../../sim/otherGuns.js';

const base = (msgs: ServerMessage[]): ServerMessage[] => decodeServerFrame(serverFrame(msgs.map(encodeServerMessage)));

interface Client { you: number; enc: PackedEncoder; dec: PackedDecoder; bytes: number }

function client(store: BlockStore, you: number): Client {
  return { you, enc: new PackedEncoder(store), dec: new PackedDecoder(), bytes: 0 };
}

/** Queue (prepare) then encode one message per client, decode it, compare with the base format */
function send(c: Client, msgs: ServerMessage[]): void {
  for (const m of msgs) c.enc.prepare(m, c.you);
  const data = c.enc.encode([msgs.map((msg) => ({ msg }))], c.you);
  c.bytes += data.length;
  const got = c.dec.decode(data);
  const want = [base(msgs)];
  if (!isDeepStrictEqual(got, want)) expect(got).toEqual(want);
}

/** One snapshot's shared rows (as the server makes them once a snapshot: Replication's keyRow and ctlRow, SnapshotBuilder's rows) */
function world(tick: number, k: number) {
  const mob: EntityState = { id: 4530, type: 2, x: 69608.5 + k * 30, y: 31951 - k * 7, angle: 0.185 + k * 0.01, vx: 11.3 - k * 0.6, vy: 2.1, hp: 55 - k, maxHp: 55, data: [1] } as EntityState;
  const pilot: EntityState = { id: 4242, type: 1, hp: 300 - k, maxHp: 300, data: [0, 0, 10, 0, 0, 15, 0, 0] } as EntityState;
  const pilotFirst: EntityState = { ...pilot, x: 69000.25 + k, y: 29000.5, angle: 1.5 } as EntityState;
  const wreck: EntityState = { id: 4419, type: 10, data: [3, 0, 0, 0, 0, 0, 0, 0, 5, 0, 0] } as EntityState;
  const keys = [[4253, 1, 69746.51 + k * 20, 29807.51 + k * 3, 2.0934, 6.505, 0.20401 + k * 0.001, 0.005012, 0, 1, 6, 2592], [4242, 1, 69000.25 + k, 29000.5, 1.5, 1.25, 0, 0, 0, 1, 0, 100]];
  const ctl = [[4262, 2, 8, 8, 8], [-1 - 4263, 2, 7, 1, 0], [4265, 0, 29 + k]];
  const fire = [[4300, 1, 255 + 256 * 255, 400], [4253, 2, 153 + 256, -1200 + k, 5000 + k * 10, 5001 + k * 10]];
  // Shell rows: two from one gun (a chain), one with no gun, a missile off its line
  const shells = [0, 1].map((i) => ({ id: 6000 + k * 10 + i, type: 7, vx: 48.16 - i * 0.3, vy: 2.16 + i, data: [1, 1, 0, tick - 3, 67859.7 - i * 0.2 + k, 28042.4 + i * 48, 4253, 1, 0, 0, 143] }) as EntityState);
  shells.push({ id: 6000 + k * 10 + 5, type: 7, vx: 12.5, vy: -3, data: [2, 1, 0, tick - 1, 1000.5, 2000, 4300, 1, 0, 0, -1] } as EntityState);
  shells.push({ id: 6000 + k * 10 + 9, type: 7, vx: -28.32, vy: 19.85, x: 70100.1 + k, y: 29100.2, data: [26, 3, 0, tick - 2, 70160.2, 29128.4, 4253, 1.7, 1, tick + 40, 144] } as EntityState);
  return { tick, mob, pilot, pilotFirst, wreck, keys, ctl, fire, shells };
}

function own(you: number, k: number): EntityState {
  return { id: you, type: 1, x: 68996 + k * 3.1, y: 28910.98, angle: 1.15109, vx: 4.7484, vy: 4.219, hp: 300, maxHp: 300, data: [801110016, 100, 1737, 0, 0, 0, 1000, 0, 100, 1, 0, 100, 0, 100, 0, 0, 0, 0, 0, 0], av: 0.007143 } as EntityState;
}

describe('encode-once blocks', () => {
  it('every client decodes what the base format has, each row is encoded once, a late client steps in with absolute blocks', () => {
    const store = new BlockStore(() => 1);
    const a = client(store, 7001), b = client(store, 7002), late = client(store, 7003);
    for (let k = 0; k < 12; k++) {
      const w = world(300 + 3 * k, k);
      const snapFor = (c: Client, first: boolean) => ({
        type: 'snapshot', tick: w.tick, lastProcessedInput: 9 + k,
        entities: [own(c.you, k), first ? derivedRow(w.pilotFirst, { name: 'Ace' }) : w.pilot, w.mob, ...(first ? [derivedRow(w.wreck, { name: 'Scrap Mite' })] : k % 4 === 0 ? [w.wreck] : []),
          ...w.shells.filter((_, i) => c !== b || i !== k % 3)],
        removed: k === 6 ? [4419] : [], ships: w.keys, ctl: w.ctl, fire: w.fire,
      }) as unknown as ServerMessage;
      send(a, [snapFor(a, k === 0)]);
      // (b misses every third snapshot: absolute blocks after each gap)
      if (k % 3 !== 2) send(b, [snapFor(b, k === 0)]);
      if (k >= 5) send(late, [snapFor(late, k === 5)]);
    }
    // Encoded once each: per snapshot one mob, one or two pilot rows, the keyframes, control rows and fire events
    expect(store.stats.k).toBe(24);
    expect(store.stats.c).toBe(36);
    expect(store.stats.f).toBe(24);
    expect(store.stats.p).toBe(48);
    expect(a.enc.stats.blocks).toBe(12);
    expect(a.enc.stats.legacy).toBe(0);
  });

  it('gun rows (other pilots\' gun controls): blocks encoded once, every client decodes what the base format has', () => {
    const store = new BlockStore(() => 1);
    const a = client(store, 7001), b = client(store, 7002);
    for (let k = 0; k < 8; k++) {
      // (As GunNet makes them, once a round: a run row, events with ticks ago of 7 and more, big and negative steps, both triggers)
      const gun = [
        packGunRow(4262, [[3, GUN_FIRE, 180 + k], [2, GUN_FIRE, 181 + k], [1, GUN_FIRE, 183 + k]], 175),
        packGunRow(4263, [[9, GUN_FIRE | GUN_ALT, 40], [4, 0, 1200 - k * 300], [0, GUN_ALT, -3]], 2000),
        packGunRow(4264 + k, [[k % 3, 0, 250]], 250),
      ];
      const msg = { type: 'snapshot', tick: 600 + 3 * k, lastProcessedInput: 1, entities: [], removed: [], gun } as unknown as ServerMessage;
      send(a, [msg]);
      send(b, [msg]);
      // (the same row object in another client's snapshot of that round: the same block, not encoded again)
      send(b, [{ ...msg, gun: [gun[1]] } as unknown as ServerMessage]);
    }
    expect(store.stats.g).toBe(24);
    expect(a.enc.stats.blocks).toBe(8);
    expect(a.enc.stats.legacy + b.enc.stats.legacy).toBe(0);
    // (Rows that aren't gun rows' shape still decode as the base format has them: the snapshot goes the connection's way, or plain)
    const odd = client(store, 7004);
    send(odd, [{ type: 'snapshot', tick: 700, lastProcessedInput: 1, entities: [], removed: [], gun: [[4262, 1.5, 3], [-1 - 4263]] } as unknown as ServerMessage]);
    expect(odd.enc.stats.blocks).toBe(0);
  });

  it('fire rows with weapon modifier masks: the gun code round trips with and without a mask and an augment, and a row without a mask packs to the bits it always did', () => {
    const bits = (write: (io: PackedIO) => void) => { const io = new PackedIO(); io.startWrite(); write(io); const b = io.takeBits(); return { n: b.n, b: [...b.b.slice(0, Math.ceil(b.n / 8))] }; };
    /** The fire body as it was before a part field could carry a mask */
    const before = (io: PackedIO, row: readonly number[]) => {
      io.num(row[1], 0, 2);
      const p = row[2], aug = io.bit(p >= 65536 && p < 131072);
      io.num(aug ? p - 65536 : p, 0, 5);
      io.num(row[3], 0, 6);
      io.vu(row.length - 4, 1);
      let id = 0;
      for (let i = 4; i < row.length; i++) id = i === 4 ? io.vu(row[i], 7) : id + io.vs(row[i] - id, 3);
    };
    const guns: [part: number, ammo: number, aug: boolean][] = [[0, 0, false], [7, 0, true], [153, 1, false], [255, 255, false], [255, 255, true], [12, 3, true]];
    for (const [part, ammo, aug] of guns) {
      const plain = [4300, 2, gunCode(part, ammo, aug), -1200, 5000, 5001, 5003];
      expect(plain[2]).toBe(part + 256 * ammo + (aug ? 65536 : 0));
      expect(bits((io) => fireBody(io, plain)), `${part} ${ammo} ${aug}`).toEqual(bits((io) => before(io, plain)));
      for (const fx of [0, 1, 2, 5, 8, 15]) {
        const row = [4300, 2, gunCode(part, ammo, aug, fx), -1200, 5000, 5001, 5003];
        // (what the writer says the other side will have, and what a reader of those bits gets)
        const w = new PackedIO();
        w.startWrite();
        const said = fireBody(w, row), packed = w.takeBits();
        const r = new PackedIO();
        r.startRead(packed.b, 0);
        const got = fireBody(r, undefined) as number[];
        expect(said.slice(1)).toEqual(row.slice(1));
        expect(got.slice(1)).toEqual(row.slice(1));
        expect([gunCodePart(got[2]), gunCodeAmmo(got[2]), gunCodeAug(got[2]), gunCodeFx(got[2])]).toEqual([part, ammo, aug, fx]);
        // (a mask costs its own bits only: never fewer than the plain row, and the plain row no more than before)
        if (fx) expect(packed.n).toBeGreaterThanOrEqual(bits((io) => fireBody(io, plain)).n);
      }
    }
    // And through a whole snapshot, shared between clients as any fire row is
    const store = new BlockStore(() => 1);
    const a = client(store, 7001), b = client(store, 7002);
    for (let k = 0; k < 4; k++) {
      const fire = [[4300, 1, gunCode(9, 0, false, 1 + k), 400], [4253, 2, gunCode(153, 1, true, 15), -1200 + k, 5000 + k * 10, 5001 + k * 10, 5002 + k * 10], [4253, 0, gunCode(4, 0, true), 12, 6000 + k]];
      const msg = { type: 'snapshot', tick: 900 + 3 * k, lastProcessedInput: 1, entities: [], removed: [], fire } as unknown as ServerMessage;
      send(a, [msg]);
      send(b, [msg]);
    }
    expect(store.stats.f).toBe(12);
    expect(a.enc.stats.legacy + b.enc.stats.legacy).toBe(0);
  });

  it('a continuing holder gets the delta form (smaller), the same bits as every other continuing holder', () => {
    const store = new BlockStore(() => 1);
    const cs = [client(store, 7001), client(store, 7002), client(store, 7003)];
    const sizes: number[][] = cs.map(() => []);
    for (let k = 0; k < 6; k++) {
      const w = world(400 + 3 * k, k);
      for (const [i, c] of cs.entries()) {
        const before = c.bytes;
        send(c, [{ type: 'snapshot', tick: w.tick, lastProcessedInput: 1, entities: [w.mob], removed: [], ships: w.keys } as unknown as ServerMessage]);
        sizes[i].push(c.bytes - before);
      }
    }
    // (Same bits for every holder: the same sizes; and the deltas are smaller than the first, absolute, ones)
    expect(sizes[1]).toEqual(sizes[0]);
    expect(sizes[2]).toEqual(sizes[0]);
    expect(sizes[0][3]).toBeLessThan(sizes[0][0]);
  });

  it('wire ids: dense from 0, a removed entity gives its id back, an entity changing system gets a new one', () => {
    const sys = new Map<number, number>();
    const store = new BlockStore((e) => sys.get(e) ?? 1);
    const c = client(store, 7001);
    const row = (id: number, hp: number) => ({ id, type: 2, x: 10.5, y: 20, angle: 0, vx: 0, vy: 0, hp, maxHp: 50, data: [1] }) as EntityState;
    const msg = (tick: number, ents: EntityState[], removed: number[] = []) => ({ type: 'snapshot', tick, lastProcessedInput: 1, entities: ents, removed } as unknown as ServerMessage);
    send(c, [msg(10, [row(500, 1), row(501, 1), row(502, 1)])]);
    expect(store.size).toBe(3);
    send(c, [msg(13, [row(500, 2)], [501])]);
    store.removed([501]);
    // (503 takes 501's wid; the client is told so before the block that uses it)
    send(c, [msg(16, [row(503, 1), row(502, 2), row(500, 3)])]);
    sys.set(500, 2);
    send(c, [msg(19, [row(500, 4), row(502, 3)])]);
    send(c, [msg(22, [row(500, 5), row(502, 4)])]);
    expect(store.size).toBe(3);
  });

  it('a client never told of a removal: the wid, then the entity id, reused for others still decode right', () => {
    const store = new BlockStore(() => 1);
    const a = client(store, 7001), b = client(store, 7002);
    const row = (id: number, hp: number) => ({ id, type: 2, x: 10.5 + hp, y: 20, angle: 0, vx: 1, vy: 0, hp, maxHp: 50, data: [1] }) as EntityState;
    const msg = (tick: number, ents: EntityState[], removed: number[] = []) => ({ type: 'snapshot', tick, lastProcessedInput: 1, entities: ents, removed } as unknown as ServerMessage);
    send(a, [msg(10, [row(600, 1), row(601, 1)])]);
    send(b, [msg(10, [row(600, 1), row(601, 1)])]);
    // 600 goes; only b is told. 602 takes its wid; a sees 602 (told the wid is 602's now)
    send(b, [msg(13, [row(601, 2)], [600])]);
    store.removed([600]);
    send(a, [msg(16, [row(602, 1), row(601, 3)])]);
    send(b, [msg(16, [row(602, 1), row(601, 3)])]);
    // 602 goes too (a not told); the id 600 comes back as a new entity and gets the freed wid: a must be told again
    send(b, [msg(19, [row(601, 4)], [602])]);
    store.removed([602]);
    send(a, [msg(22, [row(600, 9), row(601, 5)])]);
    send(b, [msg(22, [row(600, 9), row(601, 5)])]);
    send(a, [msg(25, [row(600, 10), row(601, 6)])]);
  });

  it('a block whose wire id or chain the client has not got stops its reader (it asks to start afresh)', () => {
    const store = new BlockStore(() => 1);
    const a = client(store, 7001);
    const w0 = world(500, 0), w1 = world(503, 1);
    const m = (w: ReturnType<typeof world>) => ({ type: 'snapshot', tick: w.tick, lastProcessedInput: 1, entities: [w.mob], removed: [] } as unknown as ServerMessage);
    send(a, [m(w0)]);
    // A fresh reader joining mid-stream (as if it had lost its state): the delta block can't be read
    const m1 = m(w1);
    a.enc.prepare(m1, a.you);
    const data = a.enc.encode([[{ msg: m1 }]], a.you);
    const fresh = new PackedDecoder();
    // (A reader that never saw the reset ignores what follows until one comes)
    expect(fresh.decode(data)).toEqual([]);
    const other = new PackedDecoder();
    (other as unknown as { broken: boolean }).broken = false;
    expect(() => other.decode(data)).toThrow();
    expect(other.broken).toBe(true);
  });
});
