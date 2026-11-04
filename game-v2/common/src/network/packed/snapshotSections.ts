/**
 * Bit-packed frames: a snapshot's sections (packedCodec.ts snapshotIO, and the encode-once form blocksSnapshot.ts),
 * each written and read by one function on the connection's PackedIO: its slots and last values.
 */
import { COMPACT_TYPES } from '../protocol.js';
import { decisionRowOk } from '../../bodies/decisions.js';
import { guideRowOk } from '../../guidance/records.js';
import { PAIR } from '../causes.js';
import { PK_PROJECTILE, PK_CONTROL } from './tables.js';
import { PackedIO, isId, bitsFor, K, K_TICK } from './packedIO.js';
import { entityFieldsIO, keyframeFieldsIO, ticksSince } from './rowsIO.js';

export const SNAPSHOT_CODE = COMPACT_TYPES.indexOf('snapshot');
const isArr = Array.isArray;

/** Can the snapshot's row go packed (ids where ids go, rows the shapes the packing expects)? */
export function snapshotOk(w: unknown[]): boolean {
  if (w.length > 14) return false;
  const [, , , e, p, r, k, c, o, f, n, d, x, g] = w as unknown[][];
  // (Homing shells' guide records: rows of whole numbers as the decisions', decisionsIO packs them)
  if (g != null && !(isArr(g) && g.every((row) => guideRowOk(row) && isId(row[0]) && row[1] > -4096 && row.every((v, i) => i < 3 || (v >= -(2 ** 30) && v < 2 ** 30))))) return false;
  // (Decisions: rows of whole numbers, a boss's id first, an op the packing knows: decisionsIO)
  if (d != null && !(isArr(d) && d.every((row) => decisionRowOk(row) && isId(row[0]) && row[1] <= 0 && row[1] > -4096 && row.every((v, i) => i < 3 || (v >= -(2 ** 30) && v < 2 ** 30))))) return false;
  // (Own-ship causes: rows of numbers, a kind the packing knows: ownIO)
  if (n != null && !(isArr(n) && n.every(ownRowOk))) return false;
  // (Other ships' causes: records in tick order, the ships ids, a contact's flags and states as causesIO packs them)
  if (x != null && !(isArr(x) && x.every((row, i) => causeRowOk(row) && (i === 0 || (row as number[])[0] <= (x[i - 1] as number[])[0])))) return false;
  if (e != null && !(isArr(e) && e.every((row) => isArr(row) && row.length >= 2 && row.length <= 15 && isId(row[0]) && Number.isInteger(row[1]) && (row[1] as number) >= 0 && (row[1] as number) < 32))) return false;
  if (p != null && !(isArr(p) && p.every((row) => isArr(row) && row.length >= 8 && row.length <= 15 && isId(row[0]) && isId(row[7])))) return false;
  if (r != null && !(isArr(r) && r.every(isId))) return false;
  if (k != null && !(isArr(k) && k.every((row) => isArr(row) && row.length >= 1 && row.length <= 31 && isId(row[0])))) return false;
  if (c != null) {
    if (!isArr(c)) return false;
    let id = 0;
    for (const row of c) {
      if (!isArr(row) || !row.length || !isId(row[0])) return false;
      id += Math.floor((row[0] as number) / 2);
      if (!isId(id)) return false;
    }
  }
  if (o != null && !(isArr(o) && o.every(isId))) return false;
  if (f != null) {
    if (!isArr(f)) return false;
    let owner = 0, id = 0;
    for (const row of f) {
      if (!isArr(row) || row.length < 4 || !Number.isInteger(row[0])) return false;
      owner += row[0] as number;
      if (!isId(owner)) return false;
      for (let i = 4; i < row.length; i++) { if (!Number.isInteger(row[i])) return false; id += row[i] as number; if (!isId(id)) return false; }
    }
  }
  return true;
}

function causeRowOk(row: unknown): boolean {
  if (!isArr(row) || row.length < 3 || row.length > 15 || !row.every((v) => typeof v === 'number')) return false;
  const [ago, kind, a] = row as number[];
  if (!Number.isInteger(ago) || ago < 0 || !isId(a)) return false;
  if (kind === 0) return row.length === 5;
  if (kind === 2) return row.length === 3;
  if (kind !== 1 || !isId(row[3]) || !Number.isInteger(row[4]) || row[4] < 0 || row[4] >= 64) return false;
  const f = row[4] as number;
  return row.length === 5 + (f & PAIR.A_STATE ? 5 : 0) + (f & PAIR.B_STATE ? 5 : 0);
}

function ownRowOk(row: unknown): boolean {
  return isArr(row) && row.length >= 2 && row.length <= 15 && row.every((v) => typeof v === 'number') && Number.isInteger(row[0]) && (row[0] as number) >= 0 && Number.isInteger(row[1]) && (row[1] as number) >= 0 && (row[1] as number) < 4;
}

/** Out of view: forgotten here, as removals are */
export function outIO(io: PackedIO, o: number[] | null): number[] {
  const n = io.vu(o?.length ?? 0, 2);
  const ids: number[] = [];
  for (let i = 0; i < n; i++) { const id = io.thing(o?.[i] ?? 0); ids.push(id); io.forget(id); }
  return ids;
}

/** Entity rows [id, type, x, y, angle, vx, vy, hp, maxHp, data, name, av]: steps from that entity's last (x, y and the angle guessed on) */
export function entitiesIO(io: PackedIO, rows: unknown[][] | null, tick: number): unknown[][] {
  const n = io.vu(rows?.length ?? 0, 2);
  const out: unknown[][] = [];
  for (let r = 0; r < n; r++) out.push(entityRowIO(io, rows?.[r], tick));
  return out;
}

/** One entity row, by the connection's slots and last values */
export function entityRowIO(io: PackedIO, row: unknown[] | undefined, tick: number): unknown[] {
  const len = io.u(row?.length ?? 0, 4);
  const type = io.u((row?.[1] as number) ?? 0, 5);
  const id = io.thing((row?.[0] as number) ?? 0);
  const o: unknown[] = [id, type];
  entityFieldsIO(io, row, len, type, io.prevOf(id), tick, o);
  return o;
}

/**
 * Projectile rows [id, vx, vy, weaponType, ticks since fired, spawnX, spawnY, owner, gun?, tier?, size?, turret?, end?,
 * x?, y?]: the owner and gun first (the gun as the step from the last row's), then the rest, steps from that gun's last
 */
export function projectilesIO(io: PackedIO, rows: unknown[][] | null): unknown[][] {
  const n = io.vu(rows?.length ?? 0, 3);
  const out: unknown[][] = [];
  for (let r = 0; r < n; r++) {
    const row = rows?.[r];
    const len = io.u((row?.length ?? 8) - 8, 3) + 8;
    const o: unknown[] = new Array(len);
    o[0] = io.shell((row?.[0] as number) ?? 0);
    const owner = io.youOr((row?.[7] as number) ?? 0);
    o[7] = owner;
    if (len > 8) o[8] = io.num(row?.[8], 0, PK_PROJECTILE[7][1], io.proj, 7);
    const pv = io.gunPrev(owner, o[8]);
    for (let i = 1; i < len; i++) {
      if (i === 7 || i === 8) continue;
      const [d, c, delta] = PK_PROJECTILE[i - 1];
      o[i] = delta ? io.num(row?.[i], d, c, pv, i - 1) : io.num(row?.[i], d, c);
    }
    out.push(o);
  }
  return out;
}

/** Removed ids: a shell hit lately by its place in the pending list, else a shell's slot or another entity's */
export function removedIO(io: PackedIO, ids: number[] | null): number[] {
  const n = io.vu(ids?.length ?? 0, 2);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const id0 = ids?.[i] ?? 0;
    let id: number;
    const pend = io.pending;
    const at = io.reading ? -1 : pend.indexOf(id0);
    if (pend.length && io.bit(at >= 0)) id = pend[io.u(at, bitsFor(pend.length - 1))];
    else if (io.bit(!io.reading && io.shells.has(id0))) id = io.shell(id0);
    else id = io.thing(id0);
    if (id === undefined) throw new Error('packed: bad removal');
    out.push(id);
    io.forget(id);
  }
  return out;
}

/** Keyframe rows [id, mode, x, y, vx, vy, angle, angVel, jump, jumpScale, ctlBits, q, ...tail]: steps from that ship's last */
export function keyframesIO(io: PackedIO, rows: unknown[][] | null, tick: number): unknown[][] {
  const n = io.vu(rows?.length ?? 0, 2);
  const out: unknown[][] = [];
  for (let r = 0; r < n; r++) {
    const row = rows?.[r];
    const id = io.thing((row?.[0] as number) ?? 0);
    const len = io.u(row?.length ?? 1, 5);
    const o: unknown[] = [id];
    keyframeFieldsIO(io, row, len, io.prevOf(id), K, K_TICK, tick, o);
    out.push(o);
  }
  return out;
}

/**
 * A pilot's own-ship causes (network/ownTick.ts: [ago, kind, ...]): ago and kind, then each value at its field's
 * decimals (a pull's push at PULL_PLACES; a contact's other by its slot, its flags, and the other's pose and velocity
 * as steps from that ship's last keyframe or contact values, its place guessed on by its velocity: the slots and guesses
 * keyframesIO keeps)
 */
const OWN_STATE: readonly [number, number, number, number][] = [[2, 6, K + 1, K + 3], [2, 6, K + 2, K + 4], [5, 6, K + 5, K + 6], [4, 6, K + 3, -1], [4, 6, K + 4, -1]];
export function ownIO(io: PackedIO, rows: unknown[][] | null, tick: number): unknown[][] {
  const n = io.vu(rows?.length ?? 0, 1);
  const out: unknown[][] = [];
  for (let r = 0; r < n; r++) out.push(ownRowIO(io, rows?.[r], tick));
  return out;
}

/**
 * Other ships' causes (network/causes.ts: [ago, kind, id, ...], in tick order): the first's ago, then each as the drop
 * from the one before (mostly none), the kind, the ships by their slots, a pull's push as an own row's, a contact's
 * flags (6 bits) and any states as an own row's contact state (steps from that ship's last values)
 */
export function causesIO(io: PackedIO, rows: unknown[][] | null, tick: number): unknown[][] {
  const n = io.vu(rows?.length ?? 0, 2);
  const out: unknown[][] = [];
  // (A ship named before in the section goes by its place among those: grinding pairs come tick after tick)
  const named: number[] = [];
  const ship = (id: number | undefined): number => {
    const at = id === undefined ? -1 : named.indexOf(id);
    if (named.length && io.bit(at >= 0)) return named[io.u(at, bitsFor(named.length - 1))];
    const v = io.thing(id ?? 0);
    named.push(v);
    return v;
  };
  let ago = 0;
  for (let r = 0; r < n; r++) {
    const row = rows?.[r] as number[] | undefined;
    ago = r === 0 ? io.vu(row?.[0] ?? 0, 2) : ago - io.vu(ago - (row?.[0] ?? 0), 1);
    const kind = io.u(row?.[1] ?? 0, 2);
    const a = ship(row?.[2]);
    const o: number[] = [ago, kind, a];
    if (kind === 0) for (let i = 0; i < 2; i++) o.push(io.num(row?.[3 + i], 5, 5, io.prevOf(-1), i) as number);
    else if (kind === 1) {
      const b = ship(row?.[3]), f = io.bit((row?.[4] ?? 0) !== 0) ? io.u(row?.[4] ?? 0, 6) : 0;
      o.push(b, f);
      let at = 5;
      for (const [on, id] of [[f & PAIR.A_STATE, a], [f & PAIR.B_STATE, b]] as const) {
        if (!on) continue;
        stateIO(io, row, at, io.prevOf(id), tick - ago, o);
        at += 5;
      }
    }
    out.push(o);
  }
  return out;
}

/** A body's pose and velocity (x, y, angle, vx, vy) as an own row's contact state: steps from that ship's last values */
function stateIO(io: PackedIO, row: readonly unknown[] | undefined, at: number, pv: number[], tick: number, out: unknown[]): void {
  const dt = ticksSince(pv, K_TICK, tick);
  for (let i = 0; i < 5; i++) {
    const [d, c, k, by] = OWN_STATE[i];
    if (by >= 0) io.guess(pv, k, by, d, by === K + 6 ? 6 : 4, dt);
    out.push(io.num(row?.[at + i], d, c, pv, k));
  }
}

function ownRowIO(io: PackedIO, row: unknown[] | undefined, tick: number): unknown[] {
  {
    const len = io.u(row?.length ?? 2, 4);
    const ago = io.vu((row?.[0] as number) ?? 0, 2), kind = io.u((row?.[1] as number) ?? 0, 2);
    const o: unknown[] = [ago, kind];
    let pv: number[] | null = null, dt = 0;
    for (let i = 2; i < len; i++) {
      const v = row?.[i];
      // (a pull's push: the step from the last one, a pull lasting many ticks pushes much alike each)
      if (kind === 0) o.push(io.num(v, 5, 5, io.prevOf(-1), i - 2));
      else if (kind === 1 && i === 2) { const id = io.thing((v as number) ?? 0); o.push(id); pv = io.prevOf(id); }
      else if (kind === 1 && i === 3) o.push(io.u((v as number) ?? 0, 5));
      else if (kind === 1 && pv && i <= 8) {
        if (i === 4) dt = ticksSince(pv, K_TICK, tick - ago);
        const [d, c, k, by] = OWN_STATE[i - 4];
        if (by >= 0) io.guess(pv, k, by, d, by === K + 6 ? 6 : 4, dt);
        o.push(io.num(v, d, c, pv, k));
      }
      else if (kind === 1) o.push(io.num(v, 0, 3));
      else o.push(io.num(v, 0, 3));
    }
    return o;
  }
}

/**
 * Bosses' decisions (common bodies/decisions.ts: [id, dt, op, ...args]): the boss by its slot, how many ticks before the
 * snapshot's (dt, 0 or less), the op (4 bits), the count of args, each a signed varint (most are a byte or less)
 */
export function decisionsIO(io: PackedIO, rows: unknown[][] | null): unknown[][] {
  const n = io.vu(rows?.length ?? 0, 2);
  const out: unknown[][] = [];
  for (let r = 0; r < n; r++) {
    const row = rows?.[r] as number[] | undefined;
    const id = io.thing(row?.[0] ?? 0);
    const ago = io.vu(-(row?.[1] ?? 0), 2);
    const op = io.u(row?.[2] ?? 0, 4);
    const len = io.vu(row ? row.length - 3 : 0, 2);
    const o: number[] = [id, ago ? -ago : 0, op];
    for (let i = 0; i < len; i++) o.push(io.vs(row?.[3 + i] ?? 0, 3));
    out.push(o);
  }
  return out;
}

/** Control rows as on the wire ([idStep * 2 + run, ...]): each id goes by its slot, the run flag as a bit */
export function controlsIO(io: PackedIO, rows: unknown[][] | null): unknown[][] {
  const n = io.vu(rows?.length ?? 0, 3);
  const out: unknown[][] = [];
  let prev = 0;
  for (let r = 0; r < n; r++) {
    const row = rows?.[r];
    const r0 = (row?.[0] as number) ?? 0;
    const id = io.thing(prev + Math.floor(r0 / 2));
    const run = io.bit(r0 % 2 === 1);
    const len = io.vu(row?.length ?? 1, 2);
    const o: unknown[] = [(id - prev) * 2 + (run ? 1 : 0)];
    for (let i = 1; i < len; i++) o.push(io.num(row?.[i], 0, PK_CONTROL[Math.min(i, PK_CONTROL.length) - 1]));
    prev = id;
    out.push(o);
  }
  return out;
}

/** Fire events as on the wire ([ownerStep, ticksAgo, part, aimQ, ...idSteps]): owners by slot (or you), shells new */
export function fireIO(io: PackedIO, rows: unknown[][] | null): unknown[][] {
  const n = io.vu(rows?.length ?? 0, 2);
  const out: unknown[][] = [];
  let owner = 0, id = 0, wOwner = 0, wId = 0;
  for (let r = 0; r < n; r++) {
    const row = rows?.[r];
    if (row) wOwner += row[0] as number;
    const who = io.youOr(wOwner);
    const fp = io.firerPrev(who);
    const o: unknown[] = [who - owner, io.num(row?.[1], 0, 2), io.num(row?.[2], 0, 5, fp, 0), io.num(row?.[3], 0, 6, fp, 1)];
    owner = who;
    const k = io.vu(row ? row.length - 4 : 0, 1);
    for (let i = 0; i < k; i++) {
      if (row) wId += row[4 + i] as number;
      const s = io.newShell(wId);
      o.push(s - id);
      id = s;
    }
    out.push(o);
  }
  return out;
}

