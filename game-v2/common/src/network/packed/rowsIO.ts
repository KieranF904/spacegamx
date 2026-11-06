/**
 * Bit-packed frames: the bodies of a snapshot's entity rows and keyframe rows, written and read by one function each
 * (PackedIO). The per-connection sections (packedCodec.ts entitiesIO, keyframesIO) and the encode-once blocks
 * (blocks.ts) both use them, each with its own base: the connection's last values of that entity, or the entity's
 * chain shared by every holder.
 */
import { PK_ENTITY, PK_ENTITY_DEFAULT, PK_DATA_CHUNK, PK_KEYFRAME, PK_KEYFRAME_TAIL, PK_GUESS_TICKS, PK_GUN } from './tables.js';
import { isId, nullish, E_X, E_Y, E_ANGLE, E_VX, E_VY, E_AV, E_HP, E_MAXHP, E_TICK, type PackedIO } from './packedIO.js';

/** The ticks since an entity's last row (for the guesses), and that row's tick noted */
export function ticksSince(pv: number[], at: number, tick: number): number {
  const dt = Math.max(0, Math.min(PK_GUESS_TICKS, tick - pv[at]));
  pv[at] = tick;
  return dt;
}

/**
 * An entity row's fields from index 2 ([id, type, x, y, angle, vx, vy, hp, maxHp, data, name, av]) into `o`: steps from
 * `pv` (E_* indices: x, y and the angle guessed on). `noName`: index 10 isn't written (a block's name goes apart) and
 * reads as null
 */
export function entityFieldsIO(io: PackedIO, row: unknown[] | undefined, len: number, type: number, pv: number[], tick: number, o: unknown[], noName = false): void {
  const spec = PK_ENTITY[type] ?? PK_ENTITY_DEFAULT;
  const dt = ticksSince(pv, E_TICK, tick);
  for (let i = 2; i < len; i++) {
    const v = row?.[i];
    switch (i) {
      case 2: io.guess(pv, E_X, E_VX, spec.xy, spec.v, dt); o.push(io.num(v, spec.xy, 6, pv, E_X)); break;
      case 3: io.guess(pv, E_Y, E_VY, spec.xy, spec.v, dt); o.push(io.num(v, spec.xy, 6, pv, E_Y)); break;
      case 4: io.guess(pv, E_ANGLE, E_AV, spec.angle, 6, dt); o.push(io.num(v, spec.angle, 6, pv, E_ANGLE)); break;
      case 5: o.push(io.num(v, spec.v, 6, pv, E_VX)); break;
      case 6: o.push(io.num(v, spec.v, 6, pv, E_VY)); break;
      case 7: o.push(io.num(v, 0, 3, pv, E_HP)); break;
      case 8: o.push(io.num(v, 0, 3, pv, E_MAXHP)); break;
      case 9: o.push(dataIO(io, v, spec.data)); break;
      case 10: o.push(noName ? null : io.any(v)); break;
      case 11: o.push(io.num(v, 6, 5, pv, E_AV)); break;
      default: o.push(io.any(v));
    }
  }
}

/** An entity row's data: '0' null, '10' a list of numbers (whole, each index its own chunk), '11' any other value */
export function dataIO(io: PackedIO, v: unknown, chunks: readonly number[]): unknown {
  if (io.reading) {
    if (io.u(0, 1) === 0) return null;
    if (io.u(0, 1) === 1) return io.any(null);
  } else {
    if (nullish(v)) { io.u(0, 1); return null; }
    if (!Array.isArray(v)) { io.u(3, 2); io.any(v); return v; }
    io.u(2, 2);
  }
  const a = v as unknown[] | null;
  const n = io.vu(a?.length ?? 0, 3);
  const out: unknown[] = [];
  for (let j = 0; j < n; j++) out.push(io.num(a?.[j], 0, chunks[j] ?? PK_DATA_CHUNK));
  return out;
}

/**
 * A keyframe row's fields from index 1 ([id, mode, x, y, vx, vy, angle, angVel, ...]) into `o`: steps from `pv`, field i
 * at pv[at + i - 1], its tick at pv[tickAt]
 */
export function keyframeFieldsIO(io: PackedIO, row: unknown[] | undefined, len: number, pv: number[], at: number, tickAt: number, tick: number, o: unknown[]): void {
  const dt = ticksSince(pv, tickAt, tick);
  for (let i = 1; i < len; i++) {
    const v = row?.[i];
    const spec = PK_KEYFRAME[i - 1];
    if (!spec) { o.push(io.num(v, PK_KEYFRAME_TAIL[0], PK_KEYFRAME_TAIL[1])); continue; }
    const [d, c, delta, by] = spec;
    if (!delta) { o.push(io.num(v, d, c)); continue; }
    if (by) io.guess(pv, at + i - 1, at + by - 1, d, PK_KEYFRAME[by - 1][0], dt);
    o.push(io.num(v, d, c, pv, at + i - 1));
  }
}

/**
 * Can a gun row go packed (sim/otherGuns.ts packGunRow: [id, tb, dd, tb, dd, ...], or a run [-1 - id, tb, dd, dd, ...];
 * tb = bits × 8 + ticksAgo, 7 and more: bits × 8 + 7, then ticksAgo): whole numbers in that shape
 */
export function gunRowOk(row: unknown): boolean {
  if (!Array.isArray(row) || row.length < 2 || !row.every((v) => Number.isSafeInteger(v) && Math.abs(v as number) < 2 ** 40)) return false;
  const r = row as number[], run = r[0] < 0;
  if (!isId(run ? -1 - r[0] : r[0])) return false;
  let i = 1;
  const tb = (): boolean => {
    const v = r[i++];
    if (v === undefined || v < 0) return false;
    if (v % 8 === 7) { const a = r[i++]; if (a === undefined || a < 0) return false; }
    return true;
  };
  if (run) return tb() && i < r.length;
  while (i < r.length) { if (!tb() || i >= r.length) return false; i++; }
  return true;
}

/**
 * A gun row's body after its id (gunRowOk's shape): the run flag, the count of events, then each event's trigger bits
 * (a varint), its ticks ago (3 bits; 7: a varint more) and the distance's step; a run row's bits and ticks ago once.
 * Returns the run flag and the row with the id slot 0
 */
export function gunRowBody(io: PackedIO, row: readonly number[] | undefined): { run: boolean; o: number[] } {
  const run = io.bit(!!row && row[0] < 0);
  // (the events, one or more: a run row's are its steps; any other's, its (tb, dd) pairs)
  let k = 0;
  if (row) {
    let j = 1;
    const skip = () => { if (row[j++] % 8 === 7) j++; };
    if (run) { skip(); k = row.length - j; } else while (j < row.length) { skip(); j++; k++; }
  }
  k = io.vu(k - 1, 1) + 1;
  const o: number[] = [0];
  let i = 1;
  const tb = () => {
    const v = row?.[i++] ?? 0;
    const bits = io.vu(Math.floor(v / 8), PK_GUN[0]), low = io.u(v % 8, 3);
    o.push(bits * 8 + low);
    if (low === 7) o.push(io.vu(row?.[i++] ?? 0, PK_GUN[1]));
  };
  const dd = () => { o.push(io.vs(row?.[i++] ?? 0, PK_GUN[2])); };
  if (run) { tb(); for (let e = 0; e < k; e++) dd(); }
  else for (let e = 0; e < k; e++) { tb(); dd(); }
  return { run, o };
}
