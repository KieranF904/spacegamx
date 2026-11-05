/**
 * PackedLink on its own (a fake connection): an encode that throws never reaches the tick, the frames it held go in
 * the base format, in order, and the next packed message starts afresh, so the client's reader stays in step.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { BlockStore, PackedEncoder, ServerFrameReader, type ServerMessage } from '@space-game/common';
import type { ClientConnection } from '../ClientConnection.js';
import { PackedLink } from './PackedLink.js';

afterEach(() => { vi.restoreAllMocks(); });

const snap = (tick: number, x: number): ServerMessage =>
  ({ type: 'snapshot', tick, lastProcessedInput: 0, entities: [{ id: 5, type: 2, x, y: 10, angle: 0, vx: 1, vy: 0 }], removed: [] }) as unknown as ServerMessage;

describe('PackedLink', () => {
  it("an encode that throws: the held frames go as base frames, in order, and the next packed message resets", () => {
    const sent: Uint8Array[] = [];
    const conn = { playerId: 9, ws: { isOpen: () => true, send: (d: Uint8Array) => { sent.push(Uint8Array.from(d)); } } } as unknown as ClientConnection;
    const link = new PackedLink(conn);
    const reader = new ServerFrameReader();
    const ticks: number[] = [];
    const read = () => { for (const d of sent.splice(0)) for (const f of reader.read(d)) for (const m of f) if (m.type === 'snapshot') ticks.push(m.tick); };

    link.add({ msg: snap(3, 100) }, false, 3);
    link.flush(3, 0);
    read();
    // The codec throws half way through the next message (its tables written in part)
    const orig = PackedEncoder.prototype.encode;
    const spy = vi.spyOn(PackedEncoder.prototype, 'encode').mockImplementationOnce(function (this: PackedEncoder, subs, you) {
      orig.call(this, subs, you);
      throw new Error('boom');
    });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    link.add({ msg: snap(6, 103) }, false, 6);
    link.flush(6, 3);
    link.add({ msg: snap(9, 106) }, false, 9);
    expect(() => link.flush(9, 0)).not.toThrow();
    expect(link.stats.failed).toBe(1);
    expect(err).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    read();
    // Then packed again, from a reset: the reader decodes it
    link.add({ msg: snap(12, 109) }, false, 12);
    link.flush(12, 0);
    expect(sent[0][0]).toBe(0x04);
    read();
    expect(ticks).toEqual([3, 6, 9, 12]);
    expect(reader.needsResync).toBe(false);
    expect(link.waiting).toBe(false);
  });

  it('encode-once blocks (every link): snapshots go as blocks, undeflated; a failed encode resets the blocks too', () => {
    const sent: { d: Uint8Array; raw: boolean }[] = [];
    const conn = {
      playerId: 9,
      ws: { isOpen: () => true, send: (d: Uint8Array, o?: { raw?: boolean }) => { sent.push({ d: Uint8Array.from(d), raw: !!o?.raw }); } },
    } as unknown as ClientConnection;
    const link = new PackedLink(conn, new BlockStore(() => 1));
    const reader = new ServerFrameReader();
    const xs: number[] = [];
    const read = () => { for (const { d } of sent.splice(0)) for (const f of reader.read(d)) for (const m of f) if (m.type === 'snapshot') xs.push(m.entities[0].x!); };
    link.add({ msg: snap(3, 100) }, false, 3);
    link.flush(3, 0);
    expect(sent[0].raw).toBe(true);
    expect(link.enc.stats.blocks).toBe(1);
    read();
    const orig = PackedEncoder.prototype.encode;
    const spy = vi.spyOn(PackedEncoder.prototype, 'encode').mockImplementationOnce(function (this: PackedEncoder, subs, you) {
      orig.call(this, subs, you);
      throw new Error('boom');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    link.add({ msg: snap(6, 103) }, false, 6);
    link.flush(6, 0);
    spy.mockRestore();
    read();
    // (The chains the failed message moved on are forgotten at both ends: the next block is absolute, and reads)
    link.add({ msg: snap(9, 106) }, false, 9);
    link.add({ msg: snap(12, 109) }, false, 12);
    link.flush(12, 0);
    read();
    expect(xs).toEqual([100, 103, 106, 109]);
    expect(reader.needsResync).toBe(false);
  });
});
