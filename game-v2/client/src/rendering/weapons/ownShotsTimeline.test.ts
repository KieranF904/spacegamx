/**
 * Your shells leave the barrels of your ship as it's drawn. Your ship is drawn on the predicted timeline, the
 * prediction's lead (leadTicks) ahead of the server's tick; your shells were drawn on the server's tick
 * (getRawServerTick), so on a moving ship each came out where the ship had been that many ticks before, behind its
 * guns (about 100 units on a starter at cruise with a lead of 5-6). Both now run on the ship's drawn tick
 * (shotTimelines: GameState.ownDrawTick).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Container } from 'pixi.js';
import { EntityType, WeaponType, type ClientInputMessage, type ServerSnapshotMessage } from '@space-game/common';
import { GameState, type InterpolatedEntity } from '../../state/GameState';
import { WeaponFx, shotTimelines } from './WeaponFx';

const ME = 1;
/** The ship's speed (units a tick, along x) and the shell's own (along -y) */
const SHIP_V = 20, SHELL_V = 50;
const LEAD = 6;
const TICK_MS = 1000 / 60;

const snap = (tick: number): ServerSnapshotMessage =>
  ({ type: 'snapshot', tick, lastProcessedInput: 0, entities: [], removed: [] } as unknown as ServerSnapshotMessage);

interface ShotView { id: number; predicted: boolean; head: { x: number; y: number } | null }

function rig() {
  let now = 50_000;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const s = new GameState();
  s.playerId = ME;
  // (the server's clock: tick 1000 at `now`)
  const st = s as unknown as { serverTickTarget: number; serverTickTargetTime: number; tickOffset: number; updateLead: () => void };
  st.serverTickTarget = 1000; st.serverTickTargetTime = now; st.tickOffset = 1000 - now / s.tickMs;
  // (a lead of LEAD ticks, as a 60-100 ms connection with some jitter has)
  st.updateLead = () => { s.leadTicks = LEAD; };
  const player = { id: ME, type: EntityType.Ship, x: 0, y: 0, vx: SHIP_V, vy: 0, angle: 0, angVel: 0, renderX: 0, renderY: 0, renderAngle: 0, data: [] } as unknown as InterpolatedEntity;
  s.entities.set(ME, player);
  // (snapshots in the buffer: interpolate draws the local ship between its last two steps)
  s.applySnapshot(snap(990));
  s.applySnapshot(snap(993));
  s.entities.set(ME, player);

  const fx = new WeaponFx(new Container());
  (fx as unknown as { draw: () => void }).draw = () => {};
  const shots = () => [...(fx as unknown as { shots: Map<number, ShotView> }).shots.values()];

  // The ship flies along x at SHIP_V; on tick `fireAt` its gun fires from its centre, straight across (-y), as
  // ShipClient.predictGuns does (spawnTick: the tick before, its shells move on the tick they're fired)
  let fireAt = -1;
  s.shipPhysics = (p) => { p.x += SHIP_V; return null; };
  s.shipGuns = (p, _input, tick) => {
    if (tick === fireAt) fx.predict({ owner: ME, type: WeaponType.Cannon, pose: { x: p.x, y: p.y, angle: p.angle }, spawnX: p.x, spawnY: p.y, spawnTick: tick - 1, vx: p.vx, vy: -SHELL_V, size: 1 });
    return null;
  };
  let seq = 0;
  /** One frame, in Game.update's order: the prediction's steps due, the world interpolated, then the shells */
  const frame = () => {
    now += TICK_MS;
    const due = Math.min(4, s.ticksDue(now));
    for (let i = 0; i < due; i++) {
      s.cachedServerTick = s.predictedTick;
      s.applyInput({ type: 'input', seq: ++seq, targetTick: s.predictedTick + 1, forward: false, backward: false, left: false, right: false, boost: false, fireLeft: true, fireRight: false, targetAngle: 0 } as unknown as ClientInputMessage);
      s.drainDelayQueue();
      s.predictedTick++;
    }
    s.cachedServerTick = s.predictedTick;
    s.interpolate(1 / 60);
    fx.update(s, 1 / 60, ...shotTimelines(s));
  };
  return { s, player, shots, frame, fire: (t: number) => { fireAt = t; } };
}

describe('your own shells against your drawn ship', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('come out of its guns as drawn, on the frame they fire, however far the prediction leads the server', () => {
    const { s, player, shots, frame, fire } = rig();
    for (let i = 0; i < 20; i++) frame();
    expect(s.leadTicks).toBe(LEAD);
    expect(s.predictedTick - s.getRawServerTick()).toBeGreaterThan(LEAD - 1);
    fire(s.predictedTick + 1);
    frame();
    let seen = 0;
    for (let i = 0; i < 12; i++) {
      const shot = shots().find((x) => x.predicted);
      expect(shot, 'the predicted shell').toBeDefined();
      // (drawn from the frame it fires: not held back until the server's tick reaches it)
      expect(shot!.head, `drawn on frame ${i} after it fired`).not.toBeNull();
      // Along the ship's flight the shell keeps up with the gun it left: a tick of the ship's travel ahead at most
      // (it moves on the tick it's fired), never the lead's worth behind
      const dx = shot!.head!.x - player.renderX;
      expect(dx).toBeGreaterThanOrEqual(-1e-6);
      expect(dx).toBeLessThanOrEqual(SHIP_V + 1e-6);
      seen++;
      frame();
    }
    expect(seen).toBe(12);
  });

  it('on the server tick instead (as before), it came out the lead behind the drawn ship', () => {
    const { s, player, shots, frame, fire } = rig();
    for (let i = 0; i < 20; i++) frame();
    fire(s.predictedTick + 1);
    let worst = 0;
    for (let i = 0; i < 20; i++) {
      frame();
      const raw = s.getRawServerTick();
      const shot = shots().find((x) => x.predicted);
      if (!shot) continue;
      // Where the shell would have been drawn on the server's tick, against the ship drawn now
      const age = raw - (shot as unknown as { spawnTick: number }).spawnTick;
      if (age < 0) continue;
      const x = (shot as unknown as { spawnX: number }).spawnX + SHIP_V * age;
      worst = Math.min(worst, x - player.renderX);
    }
    expect(worst).toBeLessThan(-SHIP_V * (LEAD - 2));
  });
});
