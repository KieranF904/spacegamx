/**
 * @contract protocol.compact
 * owns:       the COMPACT table of frequent server messages, its pack/unpack hooks and encodeMessage
 * needs:      snapshotCodec, inputBinary, fxKinds
 * invariants: COMPACT order is the wire code — common/src/network/protocol.test.ts
 * extend:     a new compact message is one row of COMPACT (bump the protocol version)
 */
import { fxKindCode, fxKindName } from '../fxKinds.js';
import type { ClientInputMessage, ClientMessage } from './clientMessages.js';
import type { ServerSnapshotMessage } from './serverCore.js';
import type { ServerMessage } from './serverMessage.js';
import { encodeInputBinary } from './inputBinary.js';
import { type PackedSnapshot, packSnapshot, unpackSnapshot } from './snapshotCodec.js';
// ============================================
// HELPERS
// ============================================

export function encodeMessage(msg: ClientMessage | ServerMessage): string | ArrayBuffer {
  // Use binary encoding for input messages (high frequency)
  if (msg.type === 'input') {
    return encodeInputBinary(msg as ClientInputMessage);
  }
  // Snapshots go as rows of values rather than keyed objects (about half the size)
  if (msg.type === 'snapshot') return JSON.stringify(packSnapshot(msg));
  // Frequent server messages go as [code, ...values] (see COMPACT)
  const row = packCompact(msg);
  if (row) return JSON.stringify(row);
  // Fall back to JSON for other messages
  return JSON.stringify(msg);
}

/**
 * The server's frequent messages, sent as arrays of their values in this field
 * order ([code, ...values], code = index here, trailing absent values dropped)
 * instead of keyed objects: a damage number is ~20 bytes instead of ~60. A
 * message with a field not listed goes as a plain object, so nothing is lost.
 */
export const COMPACT: [string, string[]][] = [
  ['damage', ['targetId', 'amount', 'sourceId', 'critical', 'hp', 'maxHp', 'glancing']],
  ['projectileHit', ['id', 'x', 'y']],
  ['partDestroyed', ['bodyId', 'part', 'fn', 'how', 'x', 'y', 'vx', 'vy', 'size']],
  ['contact', ['x', 'y', 'nx', 'ny', 'speed']],
  ['shipHps', ['ships']],
  ['debrisSplit', ['id', 'tick', 'e', 'p', 'l', 'g', 's', 'c', 'h']],
  ['shipSync', ['id', 'kind', 'hp', 'detached', 'rebuilds', 'design', 'blueprint', 'hpd', 'ghosts', 'at', 'born', 'aloof', 'dmg', 'maxHp']],
  ['effect', ['effectType', 'x', 'y', 'targetX', 'targetY', 'entityId', 'data']],
  ['death', ['entityId', 'entityType', 'killerId']],
  ['stationFire', ['station', 'target', 'turret']],
  ['playerState', ['hp', 'maxHp', 'boostFuel', 'maxBoostFuel', 'xp', 'level', 'credits', 'systemId']],
  // (Packed first: see packSnapshot)
  ['snapshot', ['t', 'lp', 'e', 'p', 'r', 'k', 'c', 'o', 'f', 'n', 'd', 'x', 'w', 'h', 'g']],
  ['mapDots', ['tick', 'dots', 'routes', 'info', 'gone', 'names', 'full', 'pts']],
  // (Appended, protocol 26: the hot plain messages. Values change on the way in and out: COMPACT_HOOKS)
  ['ignite', ['bodyId', 'part', 'ticks']],
  ['detonation', ['kind', 'x', 'y', 'radius', 'from', 'mob']],
  ['intercept', ['bodyId', 'part', 'proj', 'x', 'y', 'fx', 'fy', 'down']],
  ['bossTelegraph', ['shape', 'kind', 'x', 'y', 'ticks', 'angle', 'length', 'width', 'radius', 'bodyId']],
  ['pong', ['clientTime', 'serverTime', 'tick', 'serverProcessing']],
  ['bossBeam', ['bodyId', 'x', 'y', 'a0', 'a1', 'ticks', 'length', 'width', 'kind']],
  ['bossCharge', ['bodyId', 'kind', 'ticks']],
  ['bossBlow', ['bodyId', 'part']],
  // (Appended, protocol 27: confirmed hits, hits.ts)
  ['hits', ['h']],
  ['hpCheck', ['id', 'sum']],
  // (Appended, protocol 28: client-detected hits, hits.ts SELF_HITS)
  ['hitFix', ['s', 't', 'c', 'e', 'h']],
  // (Appended, protocol 30: the dev weapons range's readout, a row per changed dummy)
  ['rangeRow', ['i', 'dead', 'hull', 'shield', 'dmg5', 'dps', 'fight', 'total', 'ttk']],
  // (Appended, protocol 38: the focus grid's drops, offers and logs, cells.ts)
  ['cells', ['tick', 'b', 'k']],
  // (Appended, protocol 41: a system's crowd level, crowd.ts)
  ['crowd', ['tick', 'lv', 'f', 'w', 'r']],
  // (Appended, protocol 51: hostile populations, populations.ts; mapDots' pts follow its other fields)
  ['pops', ['p', 'full', 'n']],
  // (Appended, protocol 61: the netcode rounds' plain messages, so they can go bit-packed: sim/otherGuns.ts, sim/pullFields.ts)
  ['gunSync', ['id', 't', 'z', 'w', 'keep']],
  ['pulls', ['f', 'r']],
  // (The profile's changes: econProtocol.ts ServerProfileDeltaMessage)
  ['profileDelta', ['xp', 'level', 'credits', 'xpLevel', 'xpNext', 'skillPoints', 'debt', 'o']],
];

/**
 * Per-type changes to a message's values on the way into a compact row, undone on the way out (so the client sees the
 * message it always did). `pack` returns a copy, never the message itself.
 */
type Fields = Record<string, unknown>;
const COMPACT_HOOKS: Record<string, { pack(m: Fields): Fields; unpack(m: Fields): Fields }> = {
  // The kind goes by number when it is listed (fxKinds.ts)
  detonation: {
    pack: (m) => ({ ...m, kind: fxKindCode(m.kind as string) }),
    unpack: (m) => ({ ...m, kind: fxKindName(m.kind as number | string) }),
  },
  // Fractions as whole percent, seconds as tenths, the flag as 0/1 (all small whole numbers: a byte each)
  rangeRow: {
    pack: (m) => ({
      ...m, dead: m.dead ? 1 : 0, hull: Math.round((m.hull as number) * 100), shield: Math.round((m.shield as number) * 100),
      fight: Math.round((m.fight as number) * 10), ttk: m.ttk === undefined ? undefined : Math.round((m.ttk as number) * 10),
    }),
    unpack: (m) => ({
      ...m, dead: m.dead === 1 || m.dead === true, hull: (m.hull as number) / 100, shield: (m.shield as number) / 100,
      fight: (m.fight as number) / 10, ttk: m.ttk === undefined ? undefined : (m.ttk as number) / 10,
    }),
  },
  // A flag goes as 0/1
  intercept: {
    pack: (m) => ({ ...m, down: m.down ? 1 : 0 }),
    unpack: (m) => ({ ...m, down: m.down === 1 || m.down === true }),
  },
};

export const COMPACT_CODE = new Map(COMPACT.map(([type, fields], i) => [type, { code: i, fields, known: new Set(['type', ...fields]) }]));
/** Message types by compact code (for tools that count traffic) */
export const COMPACT_TYPES = COMPACT.map(([type]) => type);

export function packCompact(msg: { type: string }): unknown[] | null {
  const c = COMPACT_CODE.get(msg.type);
  if (!c) return null;
  let m = (msg.type === 'snapshot' ? packSnapshot(msg as ServerSnapshotMessage) : msg) as unknown as Record<string, unknown>;
  const hook = COMPACT_HOOKS[msg.type];
  if (hook) m = hook.pack(m);
  for (const k in m) if (m[k] !== undefined && !c.known.has(k)) return null;
  const row: unknown[] = [c.code];
  for (const f of c.fields) row.push(m[f] ?? null);
  while (row.length > 1 && row[row.length - 1] === null) row.pop();
  return row;
}

function unpackCompact(row: unknown[]): ServerMessage {
  const [type, fields] = COMPACT[row[0] as number];
  const m: Record<string, unknown> = { type };
  for (let i = 1; i < row.length; i++) if (row[i] !== null) m[fields[i - 1]] = row[i];
  if (type === 'snapshot') return unpackSnapshot(m as unknown as PackedSnapshot);
  const hook = COMPACT_HOOKS[type];
  return (hook ? hook.unpack(m) : m) as unknown as ServerMessage;
}

/** One message as it came off the wire (a packed snapshot, a compact row, or a plain object) */
export function unpackServer(x: unknown): ServerMessage {
  if (Array.isArray(x)) return unpackCompact(x);
  const m = x as { type: string; t?: number };
  return m.type === 'snapshot' && m.t !== undefined ? unpackSnapshot(m as unknown as PackedSnapshot) : (m as ServerMessage);
}
