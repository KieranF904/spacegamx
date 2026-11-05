/**
 * The pilot's input fields, listed once (refactor Stage 2: "Input fields, one merged step").
 *
 * Every field of the ECS Input component (ecs/components.ts) is either an on/off key (INPUT_BOOLS: a ui8 set from the
 * input message's boolean of the same name, `msg[k] ? 1 : 0`) or a number (INPUT_NUMBERS: each has its own coercion,
 * written out by hand in GameServer.applyInputToEntity: cursorDist clamped, targetAngle put on the replica grid,
 * sequence from the message's `seq`). inputFields.test.ts checks every Input field is listed exactly once.
 *
 * These lists drive the server's copy of a message into Input, its "let go of the keys" paths and the client's
 * "what did I last send" bookkeeping. They do NOT drive the binary input layout (protocol.ts packs the flags by bit
 * position, and its flag bytes are full): that stays hand-packed, so the wire hash does not depend on this order.
 *
 * Per-tick use: index them with a plain counted loop (`for (let i = 0; i < INPUT_BOOLS.length; i++)`), no closures.
 */

import type { ClientInputMessage } from './protocol.js';

/** The on/off keys, in the Input component's order */
export const INPUT_BOOLS = [
  'forward', 'backward', 'left', 'right', 'boost',
  'fireLeft', 'fireRight',
  'strafeLeft', 'strafeRight', 'helm',
  'jump', 'dodge',
] as const;

export type InputBool = typeof INPUT_BOOLS[number];

/** The keys a pilot lets go of when its controls are released (GameServer.releaseControls): every key but helm, a mode rather than a held key */
export const INPUT_HELD: readonly InputBool[] = INPUT_BOOLS.filter((k) => k !== 'helm');

/** The number fields (each with its own hand-written coercion: see above) */
export const INPUT_NUMBERS = ['cursorDist', 'targetAngle', 'sequence'] as const;

export type InputNumber = typeof INPUT_NUMBERS[number];

// Compile-time: every key is a boolean field of the input message
type _BoolsOnMessage = { [K in InputBool]: ClientInputMessage[K] extends boolean | undefined ? true : never };
const _boolsOnMessage: _BoolsOnMessage = {
  forward: true, backward: true, left: true, right: true, boost: true, fireLeft: true, fireRight: true,
  strafeLeft: true, strafeRight: true, helm: true, jump: true, dodge: true,
};
void _boolsOnMessage;
