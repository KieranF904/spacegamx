/**
 * The drive has the engines while charging or burning: no key reaches the thrusters then (thrustCommand.ts).
 */
import { describe, expect, it } from 'vitest';
import { localThrustCommand, type ThrustHost } from './thrustCommand';

const host = (phase: string, keys: string[]): ThrustHost => ({
  state: { playerId: 1, entities: new Map([[1, { renderAngle: 0, angVel: 0 }]]) } as unknown as ThrustHost['state'],
  hangarOpen: () => false,
  jumpPhase: () => phase,
  helm: () => false,
  isKeyDown: (c) => keys.includes(c),
});

describe('the drive has the engines while charging or burning', () => {
  it('forward and boost keys are an idle command in charge and burn', () => {
    for (const phase of ['charging', 'burning']) {
      expect(localThrustCommand(host(phase, ['KeyW', 'ShiftLeft']))).toEqual({ dir: [0, 0], turn: 0, boost: false });
    }
  });
  it('the same keys thrust when ready or cooling down', () => {
    for (const phase of ['ready', 'cooldown']) {
      const c = localThrustCommand(host(phase, ['KeyW', 'ShiftLeft']));
      expect(c.dir[1]).toBeLessThan(0);
      expect(c.boost).toBe(true);
    }
  });
});
