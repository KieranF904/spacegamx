/**
 * A snapshot in encode-once blocks (CAPS.BLOCKS, PK.BLOCKS; blocks.ts): the same message as PK.SNAPSHOT, decoding to
 * the same compact row, laid out as
 *
 *   field mask (11 bits) | tick, last input (the connection's steps) | intros: count, then (wid, entity id step) each
 *   | e: count, each a bit (1: a block, then a bit and the name when it has one; 0: the client's own row, the connection's
 *   way) | p, r: the connection's way | k: count, blocks | c: count, blocks (in id order) | o: the connection's way
 *   | f: count, blocks (in owner order) | n, d: the connection's way
 *
 * after which both ends forget the chains of whatever the removed and out lists named. Blocks are copied bit for bit
 * from the store (`planBlocks`, made when the snapshot was queued); everything else is the connection's own.
 */
import { EntityType, SNAP_FIELDS, packProjectile, type ServerSnapshotMessage } from '../protocol.js';
import type { PackedIO } from './packedIO.js';
import {
  type BlockStore, type BlockRec, controlBody, entityBody, fireBody, formFor, keyframeBody, settleEntity, settleKeyframe,
} from './blocks.js';
import { SNAPSHOT_CODE, snapshotOk, entityRowIO, projectilesIO, removedIO, outIO, ownIO, decisionsIO } from './snapshotSections.js';

/** A snapshot's parts for the blocks form: shared blocks where it can, the rest the connection's way */
export interface BlocksPlan {
  m: ServerSnapshotMessage;
  mask: number;
  /** Status rows in order: a block (and its name, which goes apart), or the client's own row as the connection codes it */
  e: { rec?: BlockRec; name?: unknown; own?: unknown[] }[];
  p: unknown[][];
  k: BlockRec[];
  c: BlockRec[];
  f: BlockRec[];
}

/** The snapshot's blocks from the store (made there once for every client), or null: it goes as PK.SNAPSHOT */
export function planBlocks(store: BlockStore, m: ServerSnapshotMessage, you: number): BlocksPlan | null {
  const tick = m.tick;
  if (typeof tick !== 'number' || !Number.isInteger(tick) || tick < 0) return null;
  const plan: BlocksPlan = { m, mask: 0, e: [], p: [], k: [], c: [], f: [] };
  const own: unknown[][] = [];
  // (One wid per entity in a snapshot)
  const wids = new Map<number, number>();
  const ok = (rec: BlockRec | null): rec is BlockRec => {
    if (!rec) return false;
    const w = wids.get(rec.eid);
    if (w === undefined) { wids.set(rec.eid, rec.wid); return true; }
    return w === rec.wid;
  };
  for (const s of m.entities) {
    const pr = s.type === EntityType.Projectile ? packProjectile(s, tick) : null;
    if (pr) { plan.p.push(pr); continue; }
    if (s.id === you) {
      const fields = s as unknown as Record<string, unknown>;
      const row: unknown[] = SNAP_FIELDS.map((k) => fields[k] ?? null);
      while (row.length && row[row.length - 1] === null) row.pop();
      own.push(row);
      plan.e.push({ own: row });
      continue;
    }
    const rec = store.entity(s, tick);
    if (!ok(rec)) return null;
    plan.e.push({ rec, name: s.name ?? undefined });
  }
  for (const row of m.ships ?? []) { const rec = store.keyframe(row, tick); if (!ok(rec)) return null; plan.k.push(rec); }
  if (m.ctl?.length) {
    // (In id order, as the wire has them: protocol.ts packCtlIds)
    const ided = m.ctl.map((r) => ({ id: r[0] < 0 ? -1 - r[0] : r[0], r })).sort((a, b) => a.id - b.id);
    for (const { r } of ided) { const rec = store.control(r, tick); if (!ok(rec)) return null; plan.c.push(rec); }
  }
  if (m.fire?.length) {
    // (In owner order, the latest first: protocol.ts packFire)
    const sorted = [...m.fire].sort((a, b) => a[0] - b[0] || b[1] - a[1]);
    for (const r of sorted) { const rec = store.fire(r, tick); if (!ok(rec)) return null; plan.f.push(rec); }
  }
  // (What goes the connection's way is checked as a snapshot's is)
  const w = [SNAPSHOT_CODE, tick, m.lastProcessedInput ?? null, own.length ? own : null, plan.p.length ? plan.p : null, m.removed.length ? m.removed : null,
    null, null, m.out?.length ? m.out : null, null, m.own?.length ? m.own : null, m.decisions?.length ? m.decisions : null];
  if (!snapshotOk(w)) return null;
  const present = [true, m.lastProcessedInput != null, plan.e.length > 0, plan.p.length > 0, m.removed.length > 0, plan.k.length > 0,
    plan.c.length > 0, !!m.out?.length, plan.f.length > 0, !!m.own?.length, !!m.decisions?.length];
  for (let i = 0; i < present.length; i++) if (present[i]) plan.mask |= 1 << i;
  return plan;
}

/** A chained block for this client: its form by the generation it holds, and the one it then holds */
function copyChained(io: PackedIO, rec: BlockRec, k: boolean): void {
  const f = formFor(rec, io.blk.gen(rec.eid, k));
  io.copyBits(f.bits.b, f.bits.n);
  io.blk.setGen(rec.eid, k, f.gen);
}

/** Writes a BLOCKS snapshot (after its PK code) */
export function blocksWrite(io: PackedIO, plan: BlocksPlan): void {
  const { m, mask } = plan;
  const has = (i: number) => (mask & (1 << (i - 1))) !== 0;
  const tick = m.tick;
  const blk = io.blk;
  io.u(mask, 11);
  io.num(tick, 0, 3, io.head, 0);
  if (has(2)) io.num(m.lastProcessedInput, 0, 2, io.head, 1);
  // Intros: each wid this client doesn't know yet, once
  const intro: BlockRec[] = [];
  const note = (rec: BlockRec | undefined) => { if (rec && !blk.knows(rec.eid, rec.wid)) { blk.introduce(rec.eid, rec.wid); intro.push(rec); } };
  for (const x of plan.e) note(x.rec);
  for (const r of plan.k) note(r);
  for (const r of plan.c) note(r);
  for (const r of plan.f) note(r);
  io.vu(intro.length, 3);
  let prev = 0;
  for (const r of intro) { io.wid(r.wid); io.vs(r.eid - prev, 6); prev = r.eid; }
  if (has(3)) {
    io.vu(plan.e.length, 2);
    for (const x of plan.e) {
      if (io.bit(!!x.rec)) {
        copyChained(io, x.rec!, false);
        if (io.bit(x.name != null)) io.any(x.name);
      } else entityRowIO(io, x.own, tick);
    }
  }
  if (has(4)) projectilesIO(io, plan.p);
  if (has(5)) removedIO(io, m.removed);
  if (has(6)) { io.vu(plan.k.length, 2); for (const r of plan.k) copyChained(io, r, true); }
  if (has(7)) { io.vu(plan.c.length, 3); for (const r of plan.c) io.copyBits(r.abs.b, r.abs.n); }
  if (has(8)) outIO(io, m.out!);
  if (has(9)) { io.vu(plan.f.length, 2); for (const r of plan.f) io.copyBits(r.abs.b, r.abs.n); }
  if (has(10)) ownIO(io, m.own as unknown[][], tick);
  if (has(11)) decisionsIO(io, m.decisions as unknown[][]);
  for (const id of m.removed) blk.forget(id);
  if (m.out) for (const id of m.out) blk.forget(id);
}

/** Reads a BLOCKS snapshot back into the snapshot's compact row (what snapshotIO reads), its blocks by this client's chains */
export function blocksRead(io: PackedIO): unknown[] {
  const blk = io.blk;
  const mask = io.u(0, 11);
  const has = (i: number) => (mask & (1 << (i - 1))) !== 0;
  const out: unknown[] = [SNAPSHOT_CODE, null, null, null, null, null, null, null, null, null, null, null];
  const tick = io.num(null, 0, 3, io.head, 0) as number;
  out[1] = tick;
  if (has(2)) out[2] = io.num(null, 0, 2, io.head, 1);
  const n = io.vu(0, 3);
  let prev = 0;
  for (let i = 0; i < n; i++) { const wid = io.wid(0); prev += io.vs(0, 6); blk.wids.set(wid, prev); }
  const who = (): number => {
    const id = blk.wids.get(io.wid(0));
    if (id === undefined) throw new Error('packed: unknown wire id');
    return id;
  };
  const chained = (k: boolean): unknown[] => {
    const eid = who();
    const abs = io.bit(false);
    let c = blk.chains.get(eid);
    if (!c) { c = {}; blk.chains.set(eid, c); }
    const base = k ? c.k : c.e;
    if (!abs && !base) throw new Error('packed: a block steps from a chain this end has not got');
    const pv = abs ? new Array<number>(16).fill(0) : base!;
    const o = k ? keyframeBody(io, undefined, pv, tick) : entityBody(io, undefined, pv, tick);
    o[0] = eid;
    if (k) { settleKeyframe(pv, o, tick); c.k = pv; } else { settleEntity(pv, o, tick); c.e = pv; }
    return o;
  };
  if (has(3)) {
    const rows: unknown[][] = [];
    const ne = io.vu(0, 2);
    for (let i = 0; i < ne; i++) {
      if (io.bit(false)) {
        const o = chained(false);
        if (io.bit(false)) { while (o.length < 10) o.push(null); o[10] = io.any(null); }
        rows.push(o);
      } else rows.push(entityRowIO(io, undefined, tick));
    }
    out[3] = rows;
  }
  if (has(4)) out[4] = projectilesIO(io, null);
  if (has(5)) out[5] = removedIO(io, null);
  if (has(6)) {
    const rows: unknown[][] = [];
    const nk = io.vu(0, 2);
    for (let i = 0; i < nk; i++) rows.push(chained(true));
    out[6] = rows;
  }
  if (has(7)) {
    const rows: unknown[][] = [];
    const nc = io.vu(0, 3);
    let id = 0;
    for (let i = 0; i < nc; i++) {
      const eid = who();
      const { run, rest } = controlBody(io, undefined);
      rows.push([(eid - id) * 2 + (run ? 1 : 0), ...rest]);
      id = eid;
    }
    out[7] = rows;
  }
  if (has(8)) out[8] = outIO(io, null);
  if (has(9)) {
    const rows: unknown[][] = [];
    const nf = io.vu(0, 2);
    let owner = 0, id = 0;
    for (let i = 0; i < nf; i++) {
      const eid = who();
      const o = fireBody(io, undefined);
      const row: unknown[] = [eid - owner, o[1], o[2], o[3]];
      owner = eid;
      for (let j = 4; j < o.length; j++) { row.push((o[j] as number) - id); id = o[j] as number; }
      rows.push(row);
    }
    out[9] = rows;
  }
  if (has(10)) out[10] = ownIO(io, null, tick);
  if (has(11)) out[11] = decisionsIO(io, null);
  for (const id of (out[5] as number[] | null) ?? []) blk.forget(id);
  for (const id of (out[8] as number[] | null) ?? []) blk.forget(id);
  while (out.length > 1 && out[out.length - 1] === null) out.pop();
  return out;
}
