/**
 * The wire format's fingerprint: a hash of the wire tables and of a frame of the
 * formats built on them. protocol.test.ts compares it with PROTOCOL_WIRE_HASH;
 * `npm run wire:bump "reason"` (scripts/wire/bump.mjs) uses it to re-pin. Not
 * exported from index.ts (nothing at runtime needs it).
 */

import { wireTables, encodeServerMessage, serverFrame, encodeInputBinary, type ClientInputMessage } from './protocol.js';
import { packKeyframe } from './replication.js';
import { dequantizeCursorAngle } from './cursorState.js';
import { PackedIO } from './packed/packedIO.js';
import { fireBody } from './packed/blocks.js';
import { CTL, ReplicaMode } from '../ships/replica.js';
import { CHARGE_GROUPS_AT, CHARGE_GROUPS_LAYOUT, MAX_CHARGE_GROUPS, PILOT_ROW } from '../ships/energy.js';
import { PORTS_SLOT_LAYOUT } from '../ships/power/ports.js';
import { GUN_STATE_LAYOUT, TELL_BEAM_PIECE, TELL_MINE_PULSE, TELL_CHARGE_CANCEL, TELL_CHARGE_START } from '../ships/guns.js';

/** FNV-1a, 32 bits, as hex */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function computeWireHash(): string {
  // The tables, and a frame of the formats built on them (so a change to how they're packed counts too)
  const input: ClientInputMessage = {
    type: 'input', seq: 77, tick: 0, targetTick: 123460, forward: true, backward: false, left: true, right: false,
    boost: true, fireLeft: false, fireRight: true, targetAngle: 1.25, strafeLeft: true, strafeRight: false, helm: true, cursorDist: 480, jump: true, dodge: true,
  };
  // (Layouts that are positions, not tables: the control bits, a keyframe's optional tail, where the pilot row's charge groups start and what they mean)
  const layouts = {
    ctl: CTL, chargeGroups: [CHARGE_GROUPS_AT, MAX_CHARGE_GROUPS, CHARGE_GROUPS_LAYOUT, PORTS_SLOT_LAYOUT], pilotRow: PILOT_ROW,
    gunState: GUN_STATE_LAYOUT, tells: [TELL_CHARGE_START, TELL_CHARGE_CANCEL, TELL_BEAM_PIECE, TELL_MINE_PULSE],
    keyframe: packKeyframe({ id: 2, mode: ReplicaMode.Player, body: { x: 1, y: 2, vx: 3, vy: 4, angle: 0.5, angVel: 0, jump: 0, cargo: 6, dodge: 7, dodgeDir: 8 }, ctl: { bits: 16, targetAngle: 0 }, q: 4000 }),
    // (and one charging a jump: its lock, last, flight.ts FlightBody.jumpAim/jumpTo)
    keyframeLock: packKeyframe({ id: 2, mode: ReplicaMode.Player, body: { x: 1, y: 2, vx: 3, vy: 4, angle: 0.5, angVel: 0, jump: 40, jumpAim: Math.fround(dequantizeCursorAngle(1234)), jumpTo: 4800 }, ctl: { bits: 272, targetAngle: 0 }, q: 4000 }),
  };
  const msgs = [
    {
      type: 'snapshot', tick: 1234, lastProcessedInput: 7, removed: [5],
      entities: [{ id: 1, type: 1, x: 10.5, y: -3, angle: 0.25, vx: 1, vy: 0, av: 0.01, hp: 100, maxHp: 120, data: [1, 2, 3], name: 'Ash' },
        { id: 40, type: 7, vx: 8.38, vy: -31.3, data: [1, 1, (2247 * 137) % 360, 1230, 27286.2, 21513.6, 2247, 1, 0, 0] },
        // (a shell that ends at a chosen point: its end tick, data[9])
        { id: 42, type: 7, vx: 12, vy: -5, data: [9, 1, (31 * 137) % 360, 1220, 50, 60, 31, 1.6, 1, 1290] }],
      ships: [[2, 1, 4, 5, 0, 0, 0.5, 0, 0, 1, 16, 4000]], ctl: [[9, 1, 17, 4100], [-2251, 2, 9, 5249, -88, -28]], out: [3], fire: [[2, 1, 0, 100, 50, 51]],
    },
    { type: 'damage', targetId: 2242, amount: 14, sourceId: 2248, critical: true },
    { type: 'shipSync', id: 3, kind: 'ship', hp: [1, 0.5], detached: [], rebuilds: 2, design: 'abc', blueprint: { name: 'X', parts: [] } },
    { type: 'welcome', playerId: 1, tickRate: 60, serverTime: 5, protocol: 1 },
  ];
  const frame = serverFrame(msgs.map((m) => encodeServerMessage(m as any)));
  // (and an encode-once fire block, plain and augmented: blocks.ts fireBody, which the base frame above doesn't reach)
  const io = new PackedIO();
  io.startWrite();
  fireBody(io, [2, 1, 3, 100, 50, 51]);
  fireBody(io, [2, 0, 65538, -570, 3438]);
  const bytes = [...new Uint8Array(encodeInputBinary(input)), ...frame, ...io.take()].map((b) => b.toString(16).padStart(2, '0')).join('');
  return fnv1a(JSON.stringify(wireTables()) + '|' + bytes + '|' + JSON.stringify(layouts));
}
