/**
 * A new connection (OwnTick.reset, ShipClient.resetSession): the own tick layer keeps nothing of the last session. A
 * restarted server hands the same ship id out again and starts its ticks over: before reset, start() saw the same id and
 * kept everything, its inputs, snapshot tick and checks all far ahead of the new ticks, so no check was ever due and
 * the layer flew on stale controls (the endless corrections after a reconnect).
 */
import { describe, it, expect } from 'vitest';
import { ShipReplicaSet, type ShipTuning, type ShipDerived, type ReplicaEnv, type ClientInputMessage, type ServerSnapshotMessage } from '@space-game/common';
import { OwnTick } from './OwnTick';

const ID = 7;

function own() {
  const reps = new ShipReplicaSet({} as ShipTuning, () => ({}) as ShipDerived, () => ({}) as ReplicaEnv);
  const o = new OwnTick({ store: { get: () => undefined } as never, reps, self: () => ID, tuning: {} as ShipTuning });
  return o;
}

const input = (targetTick: number, forward: boolean): ClientInputMessage =>
  ({ type: 'input', seq: 1, targetTick, forward, backward: false, left: false, right: false, boost: false, fireLeft: forward, fireRight: false, targetAngle: 0 }) as unknown as ClientInputMessage;
const snap = (tick: number): ServerSnapshotMessage => ({ type: 'snapshot', tick, lastProcessedInput: 0, entities: [], removed: [] }) as unknown as ServerSnapshotMessage;

describe('the own tick layer on a new connection', () => {
  it('forgets the last session: its inputs, its snapshot tick, its fire; the same id starts again from nothing', () => {
    const o = own();
    o.start();
    o.noteInput(input(90_000, true));
    o.onSnapshot(snap(90_010));
    expect(o.ctl(90_000)).toBeDefined();
    expect(o.inputAt(90_005).fire).toBe(true);

    // (The server restarted: same ship id, ticks from the start)
    o.reset();
    expect(o.on).toBe(false);
    o.start();
    expect(o.on).toBe(true);
    expect(o.ctl(90_000)).toBeUndefined();
    o.noteInput(input(120, false));
    expect(o.ctl(120)).toBeDefined();
    expect(o.inputAt(200).fire).toBe(false);
    // (Without the reset the old input's fire would stand for every tick past 90 000, and the old one's aim beside it)
    expect(o.inputAt(95_000).fire).toBe(false);
  });

  it('without a reset, a welcome for the same id keeps what it has (one connection: the inputs sent ahead of it are needed)', () => {
    const o = own();
    o.start();
    o.noteInput(input(500, true));
    o.start();
    expect(o.ctl(500)).toBeDefined();
  });
});
