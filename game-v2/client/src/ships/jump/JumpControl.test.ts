/**
 * The local jump drive (JumpControl.jumpLocked): a charge under way keeps the aim it was locked with, however the
 * cursor aim moves after.
 */
import { describe, expect, it } from 'vitest';
import { join } from 'path';
import { loadShipConfigCached } from '../../../../server/src/ships/loadShipConfig';
import { JumpControl, type JumpControlHost } from './JumpControl';

const tuning = loadShipConfigCached(join(__dirname, '../../../../data')).tuning;

describe('a charge under way keeps the aim it was locked with', () => {
  it('the label the aim had as the lock first showed stays while the cursor aim changes; none once the charge ends', () => {
    const me = { id: 1, jumpAim: 1.25, jumpTo: 700 } as { id: number; jumpAim?: number; jumpTo?: number };
    const host = { state: { playerId: 1, entities: new Map([[1, me]]) }, store: { get: () => undefined } } as unknown as JumpControlHost;
    const jc = new JumpControl(host, tuning);
    let phase = 'charging';
    jc.localJump = () => ({ phase }) as ReturnType<JumpControl['localJump']>;
    jc.setJumpAim(500, 'Mira');
    expect(jc.jumpLocked()).toEqual({ angle: 1.25, dist: 700, label: 'Mira' });
    // the cursor moves on to another destination: the locked charge does not follow
    jc.setJumpAim(900, 'Orlo');
    expect(jc.jumpLocked()).toEqual({ angle: 1.25, dist: 700, label: 'Mira' });
    // the charge ends: no lock, and the next one locks what is aimed then
    phase = 'ready';
    expect(jc.jumpLocked()).toBeNull();
    phase = 'charging';
    expect(jc.jumpLocked()?.label).toBe('Orlo');
  });
});
