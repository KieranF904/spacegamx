/**
 * Other ships' fire events as shells (FireShells.fromFire): a volley is rebuilt exactly as the server spawned it
 * (common rebuildVolley from the pose it fired at), and tell codes build no shells.
 */
import { describe, expect, it } from 'vitest';
import { join } from 'path';
import {
  createShipState, rebuildVolley, EntityType, TELL_CHARGE_START, TELL_CHARGE_CANCEL, TELL_BEAM_PIECE, TELL_MINE_PULSE, TELL_NONE, TELL_PD,
  type Blueprint, type EntityState, type PlacedPart, type Rot, type ServerSnapshotMessage,
} from '@space-game/common';
import { loadShipConfigCached } from '../../../../server/src/ships/loadShipConfig';
import { createShipBridge } from '../../../../server/src/ships/createShipBridge';
import { FireShells, type FireShellsHost } from './FireShells';

const bridge = createShipBridge(loadShipConfigCached(join(__dirname, '../../../../data')));
const { catalog, tuning } = bridge;
const p = (uid: number, piece: string, fn: string, x: number, y: number, extra: Partial<PlacedPart> = {}): PlacedPart =>
  ({ uid, piece, fn, material: catalog.functions.get(fn)?.material ?? 'alloy', x, y, rot: 0 as Rot, flip: false, ...extra });
const design: Blueprint = {
  name: 'test', catalogVersion: 1,
  parts: [
    p(0, 'rect2', 'core', 0, 0),
    p(1, 'sq', 'autocannon', 2, 0, { facing: 'N' }),
    p(2, 'sq', 'power_cell_reactor', -1, 1),
    p(3, 'sq', 'engine_ion_drive', 0, 2, { facing: 'S' }),
    p(4, 'sq', 'engine_ion_drive', 1, 2, { facing: 'S' }),
  ],
};
const OWNER = 7, ME = 1, POSE = { x: 500, y: -300, angle: 0.8, vx: 0, vy: 0 };

function setup() {
  const ship = createShipState(catalog, tuning, OWNER, design, 0);
  const calls: string[] = [];
  const beam = new Proxy({}, { get: (_t, k) => (..._a: unknown[]) => { calls.push(String(k)); } });
  const host = {
    store: { get: (id: number) => (id === OWNER ? ship : undefined) },
    state: { playerId: ME, entities: new Map([[OWNER, { type: EntityType.ShipBody, renderX: POSE.x, renderY: POSE.y, renderAngle: POSE.angle }]]) },
    tuning,
    own: { on: false, firePose: () => null },
    replicas: { preAt: () => ({ ...POSE }) },
    gunFeel: { otherCharge: () => null, otherRound: () => {} },
    otherGuns: { built: () => {} },
    beamFx: () => beam,
  } as unknown as FireShellsHost;
  return { ship, host, calls, fs: new FireShells(host) };
}
const snap = (fire: number[][]) => ({ tick: 100, fire } as unknown as ServerSnapshotMessage);

describe('a fire event\'s shells are rebuilt exactly as the server spawned them', () => {
  it('each pushed projectile row sits where rebuildVolley puts the shell, aged to the snapshot', () => {
    const { ship, fs } = setup();
    const ids = [900];
    const aimQ = 0, ago = 2, tick = 100 - ago;
    const want = rebuildVolley({ owner: OWNER, tick, part: 1, aimQ, ids, ammo: 0 }, ship, POSE, tuning)!;
    expect(want.shells.length).toBe(1);
    const out: EntityState[] = [];
    fs.fromFire(snap([[OWNER, ago, 1, aimQ, ...ids]]), out);
    expect(out.length).toBe(1);
    const s = want.shells[0], age = 100 - tick; // a pilotless ship's shell flies from the tick it was fired
    expect(out[0].id).toBe(900);
    expect(out[0].type).toBe(EntityType.Projectile);
    expect(out[0].x).toBeCloseTo(s.x + s.vx * age);
    expect(out[0].y).toBeCloseTo(s.y + s.vy * age);
    expect(out[0].vx).toBeCloseTo(s.vx);
    expect(out[0].vy).toBeCloseTo(s.vy);
    expect(fs.takeFirePose(900)).toEqual({ x: POSE.x, y: POSE.y, angle: POSE.angle });
  });
});

describe('tell codes (TELL_*) never build shells', () => {
  it('none of them pushes a row, and the tell is acted on where it has one', () => {
    for (const code of [TELL_CHARGE_START, TELL_CHARGE_CANCEL, TELL_BEAM_PIECE, TELL_MINE_PULSE, TELL_NONE, TELL_PD]) {
      const { fs, calls } = setup();
      const out: EntityState[] = [];
      fs.fromFire(snap([[OWNER, 1, 1 + code * 256, 0, 901]]), out);
      expect(out, `tell ${code}`).toEqual([]);
      if (code === TELL_BEAM_PIECE) expect(calls).toContain('startPiece');
      if (code === TELL_MINE_PULSE) expect(calls).toContain('startMinePulse');
      if (code === TELL_CHARGE_START) expect(fs.chargeTells.get(OWNER * 256 + 1)).toBe(99);
    }
  });
});
