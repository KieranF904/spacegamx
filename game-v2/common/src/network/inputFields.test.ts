/**
 * The input field lists (inputFields.ts) name every field of the ECS Input component exactly once, so a new control
 * added to Input fails here until it is listed (and so copied from the message, released, and tracked by the client).
 */
import { describe, it, expect } from 'vitest';
import { Input } from '../ecs/components.js';
import { decodeInputBinary, encodeInputBinary, type ClientInputMessage } from './protocol.js';
import { INPUT_BOOLS, INPUT_HELD, INPUT_NUMBERS } from './inputFields.js';

describe('input fields', () => {
  it('lists every Input field exactly once', () => {
    const listed = [...INPUT_BOOLS, ...INPUT_NUMBERS] as string[];
    expect(new Set(listed).size).toBe(listed.length);
    expect([...listed].sort()).toEqual(Object.keys(Input).sort());
  });

  it('every key is a ui8 on Input; the held keys are every key but helm', () => {
    for (const k of INPUT_BOOLS) expect(Input[k]).toBeInstanceOf(Uint8Array);
    expect([...INPUT_HELD]).toEqual(INPUT_BOOLS.filter((k) => k !== 'helm'));
  });

  it('every key goes over the wire and comes back as itself', () => {
    for (const k of INPUT_BOOLS) {
      const msg: ClientInputMessage = {
        type: 'input', seq: 1, tick: 2, targetTick: 3,
        forward: false, backward: false, left: false, right: false, boost: false, fireLeft: false, fireRight: false,
        targetAngle: 0, strafeLeft: false, strafeRight: false, helm: false, cursorDist: 0, jump: false, dodge: false,
      };
      msg[k] = true;
      const back = decodeInputBinary(encodeInputBinary(msg));
      for (const j of INPUT_BOOLS) expect(!!back[j], `${k} -> ${j}`).toBe(j === k);
    }
  });
});
