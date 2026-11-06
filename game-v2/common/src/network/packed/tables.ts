/**
 * Bit-packed frames (CAPS.PACKED): the format's constants. The codec is packedCodec.ts; this file has no imports so
 * protocol.ts can hash it into wireTables() (a change here is a wire change: `npm run wire:bump`).
 *
 * A packed WebSocket message is PACKED_FRAME, then a bit stream (high bit first):
 *   reset (1 bit) [the receiver's player id: zigzag varint]   both sides forget their tables first
 *   then one or more sub-frames (each what one base-format frame would have been: a tick's messages, or a request's
 *   answer; several go together when the server coalesces), each a run of messages, each a PK code (PK_BITS) and its
 *   body, ended by PK.END (another sub-frame follows) or PK.LAST (the message ends; the last byte is zero-padded).
 * A message with no packed form is PK.LEGACY: byte-aligned, then the base binary codec's bytes (binaryCodec.ts).
 *
 * Numbers go at a fixed number of decimals per field (the precision the server already rounds them to), as a
 * zigzag varint of the mantissa in chunks of `c` bits ("chunk"), some as the step from the last value of the same
 * field ("delta"). Every value is lossless: one that isn't exact at its field's decimals takes an escape (and goes
 * as any number would), so a packed message decodes to exactly what the base format decodes to.
 */

/** First byte of a packed WebSocket message (the base format's frames start with SERVER_FRAME, 0x02) */
export const PACKED_FRAME = 0x04;

/** Message codes in the bit stream */
export const PK = {
  END: 0, LAST: 1, LEGACY: 2, SNAPSHOT: 3, HITS: 4, DAMAGE: 5, PROJECTILE_HIT: 6, SHIP_HPS: 7, HP_CHECK: 8,
  DETONATION: 9, IGNITE: 10, PART_DESTROYED: 11, CONTACT: 12, SHIP_SYNC: 13, PLAYER_STATE: 14,
  /** A snapshot in encode-once blocks (CAPS.BLOCKS: blocks.ts, blocksSnapshot.ts) */
  BLOCKS: 15,
  // (Field by field, protocol 61: the plain messages of the netcode rounds and the busiest of the rest)
  GUN_SYNC: 16, MAP_DOTS: 17, DEBRIS_SPLIT: 18, BOSS_BEAM: 19, BOSS_TELEGRAPH: 20, BOSS_BLOW: 21, PULLS: 22, PROFILE_DELTA: 23,
} as const;
export const PK_BITS = 5;

/**
 * Field kinds for the messages packed field by field (each field of the compact row, in COMPACT order):
 *   ['w']           who: null, you (the receiver's own ship: 1 bit more), or an entity slot
 *   ['s']           a shell: null, or a shell slot
 *   ['n', d, c]     a number at d decimals, chunk c
 *   ['d', d, c, k]  the same, as the step from the last value under key k
 *   ['f']           a flag: null, true, false (anything else as any value)
 *   ['p']           [part, hp] pairs: part a varint, hp at 0.1
 *   ['l', d, c]     a list of numbers at d decimals, each the step from the one before
 *   ['r', n, d, c]  a flat list in rows of n numbers (map dots: MAP_DOT_STRIDE...), each at d decimals, the step from
 *                   the same column of the row before
 *   ['a']           any value (tagged, as the base codec's values)
 */
export type PackedField = readonly ['w'] | readonly ['s'] | readonly ['f'] | readonly ['p'] | readonly ['a']
  | readonly ['n', number, number] | readonly ['d', number, number, number] | readonly ['l', number, number]
  | readonly ['r', number, number, number];

/** Delta keys of the field-by-field messages (the last mantissa under each; forgotten at a reset) */
export const PK_KEYS = { HIT_X: 0, HIT_Y: 1, DET_X: 2, DET_Y: 3, PD_X: 4, PD_Y: 5, CON_X: 6, CON_Y: 7, GUN_T: 8, MAP_T: 9, SPLIT_T: 10 } as const;
export const PK_KEY_COUNT = 11;

/** The messages packed field by field: their code and their fields */
export const PACKED_FIELDS: Record<string, { code: number; fields: readonly PackedField[] }> = {
  damage: { code: PK.DAMAGE, fields: [['w'], ['n', 1, 5], ['w'], ['f'], ['n', 1, 6], ['n', 1, 6], ['f']] },
  projectileHit: { code: PK.PROJECTILE_HIT, fields: [['s'], ['d', 1, 7, PK_KEYS.HIT_X], ['d', 1, 7, PK_KEYS.HIT_Y]] },
  hpCheck: { code: PK.HP_CHECK, fields: [['w'], ['n', 0, 8]] },
  detonation: { code: PK.DETONATION, fields: [['n', 0, 4], ['d', 0, 7, PK_KEYS.DET_X], ['d', 0, 7, PK_KEYS.DET_Y], ['n', 0, 5], ['w'], ['a']] },
  ignite: { code: PK.IGNITE, fields: [['w'], ['n', 0, 5], ['n', 0, 6]] },
  partDestroyed: {
    code: PK.PART_DESTROYED,
    fields: [['w'], ['n', 0, 5], ['a'], ['a'], ['d', 1, 8, PK_KEYS.PD_X], ['d', 1, 8, PK_KEYS.PD_Y], ['n', 1, 4], ['n', 1, 4], ['n', 1, 5]],
  },
  contact: { code: PK.CONTACT, fields: [['d', 2, 9, PK_KEYS.CON_X], ['d', 2, 9, PK_KEYS.CON_Y], ['n', 2, 5], ['n', 2, 5], ['n', 2, 5]] },
  shipSync: { code: PK.SHIP_SYNC, fields: [['w'], ['a'], ['l', 1, 5], ['l', 0, 3], ['n', 0, 3], ['a'], ['a'], ['p'], ['a'], ['a'], ['a'], ['a'], ['a'], ['l', 1, 5]] },
  playerState: { code: PK.PLAYER_STATE, fields: [['n', 0, 6], ['n', 0, 6], ['n', 0, 6], ['n', 0, 6], ['n', 0, 6], ['n', 0, 3], ['n', 0, 6], ['a']] },
  // (id, t, z, w, keep: the tick as the step from the last gunSync's, w from t; z the lane state's numbers: sim/otherGuns.ts packGunSync)
  gunSync: { code: PK.GUN_SYNC, fields: [['w'], ['d', 0, 4, PK_KEYS.GUN_T], ['l', 0, 4], ['d', 0, 3, PK_KEYS.GUN_T], ['n', 0, 1]] },
  // (tick, dots, routes, info, gone, names, full, pts: protocol.ts MAP_*_STRIDE rows)
  mapDots: { code: PK.MAP_DOTS, fields: [['d', 0, 6, PK_KEYS.MAP_T], ['r', 8, 0, 5], ['r', 13, 0, 6], ['r', 3, 0, 4], ['l', 0, 6], ['a'], ['n', 0, 1], ['r', 3, 0, 6]] },
  // (id, tick, e, p, l, g, s, c, h: SnapshotBuilder's split, common ships/debris.ts)
  debrisSplit: { code: PK.DEBRIS_SPLIT, fields: [['w'], ['d', 0, 4, PK_KEYS.SPLIT_T], ['l', 0, 4], ['l', 0, 3], ['n', 0, 1], ['a'], ['a'], ['a'], ['l', 1, 6]] },
  bossBeam: { code: PK.BOSS_BEAM, fields: [['w'], ['n', 0, 6], ['n', 0, 6], ['a'], ['a'], ['n', 0, 5], ['n', 0, 6], ['n', 0, 5], ['a']] },
  bossTelegraph: { code: PK.BOSS_TELEGRAPH, fields: [['a'], ['a'], ['n', 0, 7], ['n', 0, 7], ['n', 0, 5], ['a'], ['n', 0, 6], ['n', 0, 5], ['n', 0, 5], ['w']] },
  bossBlow: { code: PK.BOSS_BLOW, fields: [['w'], ['n', 0, 4]] },
  // (f: the fields as rows, any value; r: start afresh)
  pulls: { code: PK.PULLS, fields: [['a'], ['n', 0, 1]] },
  // (xp, level, credits, xpLevel, xpNext, skillPoints, debt, o: the other changed fields)
  profileDelta: { code: PK.PROFILE_DELTA, fields: [['n', 0, 6], ['n', 0, 3], ['n', 0, 6], ['n', 0, 6], ['n', 0, 6], ['n', 0, 3], ['n', 0, 6], ['a']] },
};

/**
 * Snapshot rows. Entity rows (`e`): per entity type, the decimals of x/y and the angle (each the step from that
 * entity's last, moved on by its last vx/vy/turn rate for the ticks since) and of vx/vy (the step from its last);
 * `data` values by index at 0 decimals in these chunks (types not listed: the default).
 */
export const PK_ENTITY: Record<number, { xy: number; angle: number; v: number; data: readonly number[] }> = {
  // Player (status rows; your own row's data: cursor/weapon state, charge, ... see docs/areas/networking.md)
  1: { xy: 2, angle: 5, v: 4, data: [11, 4, 6, 1, 1, 1, 11, 1, 8, 2, 1, 8, 1, 8, 1, 1, 1, 1, 1, 1, 5, 3, 6, 1, 5, 3, 6] },
  // Enemy (mobs)
  2: { xy: 1, angle: 3, v: 1, data: [2] },
  // ShipBody (derelicts, traffic, hostiles, debris)
  10: { xy: 2, angle: 5, v: 4, data: [2, 1, 1, 1, 1, 1, 1, 1, 2, 1, 1] },
};
export const PK_ENTITY_DEFAULT = { xy: 2, angle: 5, v: 4, data: [] as readonly number[] };
export const PK_DATA_CHUNK = 3;

/**
 * Projectile rows (`p`, packProjectile's order after the id): [decimals, chunk, delta?] per field. The owner (7, who)
 * and the gun (8, a step from the last row's gun) go first; a delta is the step from the same field of that gun's last
 * shell (a gun's shots are alike), or of the last row when there's no gun
 */
export const PK_PROJECTILE: readonly (readonly [number, number, boolean])[] = [
  [2, 5, true], [2, 5, true], [0, 2, true], [0, 2, false], [1, 6, true], [1, 6, true],
  /* 7 owner: who */ [0, 0, false],
  [0, 3, true], [0, 2, false], [1, 3, false], [0, 1, false], [0, 4, false], [1, 8, true], [1, 8, true],
];

/**
 * Keyframe rows (`k`, packKeyframe's order after the id): [decimals, chunk, delta from that ship's last keyframe?,
 * guessed by (the field whose last value, times the ticks since, is added first: x by vx, the angle by its turn rate)]
 */
export const PK_KEYFRAME: readonly (readonly [number, number, boolean, number])[] = [
  [0, 2, false, 0], [2, 6, true, 4], [2, 6, true, 5], [4, 6, true, 0], [4, 6, true, 0], [5, 4, true, 7], [6, 3, true, 0],
  [0, 1, false, 0], [0, 2, false, 0], [0, 5, false, 0], [0, 4, true, 0],
];
export const PK_KEYFRAME_TAIL: readonly [number, number] = [2, 6];
/** A guess from a velocity looks this many ticks ahead at most */
export const PK_GUESS_TICKS = 60;

/**
 * Control rows (`c`, after the id; replication.ts packControlRow): chunks of each tb (bits × 8 + ticks ago), of the ticks
 * ago past its 3-bit field (7 and more), of the first aim step, of each later step's change from the one before (a smooth
 * sweep's: mostly 0 or ±1), and (a row of anything but whole numbers in that order: every value as itself) the rest
 */
export const PK_CONTROL: readonly [number, number, number, number, number] = [4, 3, 2, 1, 3];

/**
 * Gun rows (`g`, sim/otherGuns.ts packGunRow after the id): chunks of the trigger bits, of an event's ticks ago past
 * the 3-bit field (7 and more), of the distance's steps (4-unit steps from the one before)
 */
export const PK_GUN: readonly [number, number, number] = [2, 3, 3];

/** A table (shells or other entities) this big is started afresh (a reset) */
export const PK_TABLE_MAX = 2048;
/** Shells hit (projectileHit) and not yet removed, remembered for the removed list (a removal names one by its place) */
export const PK_PENDING_MAX = 64;

/** What the packed format is defined by (protocol.ts wireTables hashes it) */
export function packedTables(): Record<string, unknown> {
  return {
    frame: PACKED_FRAME, pk: PK, bits: PK_BITS, keys: PK_KEYS, fields: PACKED_FIELDS, entity: PK_ENTITY, entityDefault: PK_ENTITY_DEFAULT,
    dataChunk: PK_DATA_CHUNK, projectile: PK_PROJECTILE, keyframe: PK_KEYFRAME, keyframeTail: PK_KEYFRAME_TAIL, guess: PK_GUESS_TICKS, control: PK_CONTROL, gun: PK_GUN,
    tableMax: PK_TABLE_MAX, pendingMax: PK_PENDING_MAX, version: 4,
  };
}
