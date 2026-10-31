import { describe, it, expect } from 'vitest';
import { buildFlightInputs, newFlightControls, type FlightInputSource } from './flightInputs.js';
import { controlBits, CTL } from './replica.js';

const idle = (): FlightInputSource => ({
  forward: false, backward: false, left: false, right: false, boost: false, targetAngle: 0.5,
  helm: false, strafeLeft: false, strafeRight: false, jump: false, cursorDist: 300, dodge: false,
});

describe('buildFlightInputs', () => {
  it('copies every held key', () => {
    const base = buildFlightInputs(idle(), false);
    expect(base).toEqual({
      forward: false, backward: false, left: false, right: false, boost: false, targetAngle: 0.5,
      helm: false, strafeLeft: false, strafeRight: false, jump: false, jumpDist: 300, dodge: false,
    });
    for (const k of ['forward', 'backward', 'left', 'right', 'boost', 'helm', 'strafeLeft', 'strafeRight', 'jump', 'dodge'] as const) {
      const src = idle();
      src[k] = true;
      const out = buildFlightInputs(src, false);
      expect(out[k]).toBe(true);
      expect(out).not.toEqual(base);
    }
    const aim = idle(); aim.targetAngle = -2;
    expect(buildFlightInputs(aim, false).targetAngle).toBe(-2);
    const far = idle(); far.cursorDist = 1234;
    expect(buildFlightInputs(far, false).jumpDist).toBe(1234);
  });

  it('an EMP stops a jump starting, and nothing else', () => {
    const src = idle(); src.jump = true; src.forward = true; src.dodge = true;
    const out = buildFlightInputs(src, true);
    expect(out.jump).toBe(false);
    expect(out.forward).toBe(true);
    expect(out.dodge).toBe(true);
    expect(buildFlightInputs(src, false).jump).toBe(true);
  });

  it('optional keys default off; the cursor distance passes through as given', () => {
    const out = buildFlightInputs({ forward: false, backward: false, left: false, right: false, boost: false, targetAngle: 0 }, false);
    expect(out.dodge).toBe(false);
    expect(out.jump).toBe(false);
    expect(out.helm).toBe(false);
    expect(out.strafeLeft).toBe(false);
    expect(out.strafeRight).toBe(false);
    expect(out.jumpDist).toBeUndefined();
  });

  it('fills the scratch it is given (no allocation) and feeds controlBits', () => {
    const scratch = newFlightControls();
    const src = idle(); src.jump = true; src.dodge = true; src.helm = true;
    expect(buildFlightInputs(src, false, scratch)).toBe(scratch);
    expect(controlBits(scratch)).toBe(CTL.jump | CTL.dodge | CTL.helm);
    buildFlightInputs(src, true, scratch);
    expect(controlBits(scratch)).toBe(CTL.dodge | CTL.helm);
  });
});
