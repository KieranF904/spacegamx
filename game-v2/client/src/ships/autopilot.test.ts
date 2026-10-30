/**
 * The autopilot boosts on long legs while the batteries are over half full,
 * stops at half, and waits for them to recharge a little before boosting again.
 */
import { describe, it, expect } from 'vitest';
import { EntityType, type ShipTuning } from '@space-game/common';
import tuning from '../../../data/ships/tuning.json';

// The HUD pill is a plain div: enough of a DOM for it
(globalThis as any).document ??= { createElement: () => ({ style: {}, textContent: '' }), body: { appendChild: () => {} } };

const { Autopilot } = await import('./Autopilot');

function rig() {
  const me = { id: 1, type: EntityType.Player, x: 0, y: 0, vx: 0, vy: 0, angle: 0, renderX: 0, renderY: 0 };
  const state = { systemId: 'sol', playerId: 1, entities: new Map([[1, me]]), getRawServerTick: () => 0 } as any;
  const host = { energy: 100 };
  const ap = new Autopilot({
    state, tuning: tuning as unknown as ShipTuning, accel: () => 0.2, boostFactor: () => 2.2, energy: () => host.energy,
    // The drive is cooling down: no jumps, just flying
    jumpPhase: () => 'cooldown', jumpReach: () => 0, objective: () => null, interact: () => {}, arrived: () => {}, message: () => {},
  });
  ap.engage({ kind: 'point', system: 'sol', x: 60000, y: 0, name: 'far away' });
  return { ap, host, me };
}

describe('autopilot boost', () => {
  it('boosts on a long leg down to half the batteries, then waits for them to come back over 60%', () => {
    const { ap, host } = rig();
    host.energy = 90;
    expect(ap.tick()!.boost).toBe(true);
    host.energy = 51;
    expect(ap.tick()!.boost).toBe(true);
    host.energy = 50;
    expect(ap.tick()!.boost).toBe(false);
    // Recharging: not yet...
    host.energy = 57;
    expect(ap.tick()!.boost).toBe(false);
    // ...now
    host.energy = 61;
    expect(ap.tick()!.boost).toBe(true);
  });

  it("doesn't boost on the last stretch, where it couldn't stop from boosted speed", () => {
    const { ap, host, me } = rig();
    host.energy = 100;
    me.x = 60000 - 2500;
    expect(ap.tick()!.boost).toBe(false);
  });
});
