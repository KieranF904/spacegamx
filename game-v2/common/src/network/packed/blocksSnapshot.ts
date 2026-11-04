/**
 * A snapshot in encode-once blocks (CAPS.BLOCKS, PK.BLOCKS; blocks.ts): the same message as PK.SNAPSHOT, decoding to
 * the same compact row, laid out as
 *
 *   field mask (11 bits) | tick, last input (the connection's steps) | intros: a bit (any?), count - 1, then (wid,
 *   entity id step) each | e: count, the client's own row's place (a bit, then it), the names (count, then place step
 *   and name each), then each row: a block, or at its place the own row the connection's way | p: count, blocks (shell
 *   rows, each from its gun's chain) | r: the connection's way | k: count, blocks | c: count, blocks (in id order) | o: the connection's way
 *   | f: count, blocks (in owner order) | n, d: the connection's way
 *
 * after which both ends forget the chains of whatever the removed and out lists named. Blocks are copied bit for bit
 * from the store (`planBlocks`, made when the snapshot was queued); everything else is the connection's own.
 */
import { EntityType, SNAP_FIELDS, type ServerSnapshotMessage } from '../protocol.js';
import type { PackedIO } from './packedIO.js';
import {
  type BlockStore, type BlockRec, controlBody, entityBody, fireBody, formFor, keyframeBody, settleEntity, settleKeyframe,
  projectileBody, settleProjectile, gunKey, P_ID,
} from './blocks.js';
import { SNAPSHOT_CODE, snapshotOk, entityRowIO, removedIO, outIO, ownIO, decisionsIO } from './snapshotSections.js';

/** A snapshot's parts for the blocks form: shared blocks where it can, the rest the connection's way */
export interface BlocksPlan {
  m: ServerSnapshotMessage;
  mask: number;
  /** Status rows in order: a block (and its name, which goes apart), or the client's own row as the connection codes it */
  e: { rec?: BlockRec; name?: unknown; own?: unknown[] }[];
  p: BlockRec[];
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
    if (s.type === EntityType.Projectile) {
      const rec = store.projectile(s, tick);
      if (rec === null || (rec && !ok(rec))) return null;
      if (rec) { plan.p.push(rec); continue; }
    }
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
  const w = [SNAPSHOT_CODE, tick, m.lastProcessedInput ?? null, own.length ? own : null, null, m.removed.length ? m.removed : null,
    null, null, m.out?.length ? m.out : null, null, m.own?.length ? m.own : null, m.decisions?.length ? m.decisions : null];
  if (!snapshotOk(w)) return null;
  const present = [true, m.lastProcessedInput != null, plan.e.length > 0, plan.p.length > 0, m.removed.length > 0, plan.k.length > 0,
    plan.c.length > 0, !!m.out?.length, plan.f.length > 0, !!m.own?.length, !!m.decisions?.length];
  for (let i = 0; i < present.length; i++) if (present[i]) plan.mask |= 1 << i;
  return plan;
}

/** What a client's BLOCKS snapshots came to: bits by part, intros, and the chained blocks it got in each form */
export interface BlockBits { head: number; intro: number; e: number; p: number; r: number; k: number; c: number; o: number; f: number; nd: number; intros: number; delta: number; abs: number }
export const blockBits = (): BlockBits => ({ head: 0, intro: 0, e: 0, p: 0, r: 0, k: 0, c: 0, o: 0, f: 0, nd: 0, intros: 0, delta: 0, abs: 0 });

/** A shell row's block: by its gun chain's generation (no chain: the one form) */
function copyShell(io: PackedIO, rec: BlockRec, st: BlockBits): void {
  const key = rec.gun ?? -1;
  if (key < 0) { io.copyBits(rec.abs.b, rec.abs.n); return; }
  const f = formFor(rec, io.blk.gunGens.get(key) ?? -1);
  io.copyBits(f.bits.b, f.bits.n);
  io.blk.gunGens.set(key, f.gen);
  if (f.bits === rec.abs) st.abs++; else st.delta++;
}

/** A chained block for this client: its form by the generation it holds, and the one it then holds */
function copyChained(io: PackedIO, rec: BlockRec, k: boolean, st: BlockBits): void {
  const f = formFor(rec, io.blk.gen(rec.eid, k));
  io.copyBits(f.bits.b, f.bits.n);
  io.blk.setGen(rec.eid, k, f.gen);
  if (f.bits === rec.abs) st.abs++; else st.delta++;
}

/** Writes a BLOCKS snapshot (after its PK code); `st` adds up what each part came to */
export function blocksWrite(io: PackedIO, plan: BlocksPlan, st: BlockBits = blockBits()): void {
  const { m, mask } = plan;
  const has = (i: number) => (mask & (1 << (i - 1))) !== 0;
  const tick = m.tick;
  const blk = io.blk;
  let at = io.bitLength;
  const part = (k: keyof BlockBits) => { const now = io.bitLength; st[k] += now - at; at = now; };
  io.u(mask, 11);
  io.num(tick, 0, 3, io.head, 0);
  if (has(2)) io.num(m.lastProcessedInput, 0, 2, io.head, 1);
  // Intros: each wid this client doesn't know yet, once
  const intro: BlockRec[] = [];
  const note = (rec: BlockRec | undefined) => { if (rec && !blk.knows(rec.eid, rec.wid)) { blk.introduce(rec.eid, rec.wid); intro.push(rec); } };
  for (const x of plan.e) note(x.rec);
  for (const r of plan.p) note(r);
  for (const r of plan.k) note(r);
  for (const r of plan.c) note(r);
  for (const r of plan.f) note(r);
  part('head');
  if (io.bit(intro.length > 0)) io.vu(intro.length - 1, 3);
  let prev = 0;
  for (const r of intro) { io.wid(r.wid); io.vs(r.eid - prev, 6); prev = r.eid; }
  st.intros += intro.length;
  part('intro');
  if (has(3)) {
    const e = plan.e;
    io.vu(e.length, 2);
    // (Its own row's place, if it's there; then the names, by place: both are rare, so no bit on every row)
    const ownAt = e.findIndex((x) => !x.rec);
    if (io.bit(ownAt >= 0)) io.vu(ownAt, 3);
    let names = 0;
    for (const x of e) if (x.rec && x.name != null) names++;
    io.vu(names, 1);
    let last = 0;
    for (let i = 0; i < e.length; i++) if (e[i].rec && e[i].name != null) { io.vu(i - last, 3); io.any(e[i].name); last = i; }
    for (const x of e) {
      if (x.rec) copyChained(io, x.rec, false, st);
      else entityRowIO(io, x.own, tick);
    }
    part('e');
  }
  if (has(4)) { io.vu(plan.p.length, 3); for (const r of plan.p) copyShell(io, r, st); part('p'); }
  if (has(5)) { removedIO(io, m.removed); part('r'); }
  if (has(6)) { io.vu(plan.k.length, 2); for (const r of plan.k) copyChained(io, r, true, st); part('k'); }
  if (has(7)) { io.vu(plan.c.length, 3); for (const r of plan.c) io.copyBits(r.abs.b, r.abs.n); part('c'); }
  if (has(8)) { outIO(io, m.out!); part('o'); }
  if (has(9)) { io.vu(plan.f.length, 2); for (const r of plan.f) io.copyBits(r.abs.b, r.abs.n); part('f'); }
  if (has(10)) ownIO(io, m.own as unknown[][], tick);
  if (has(11)) decisionsIO(io, m.decisions as unknown[][]);
  part('nd');
  for (const id of m.removed) blk.forget(id);
  if (m.out) for (const id of m.out) blk.forget(id);
  blk.trimGuns();
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
  const n = io.bit(false) ? io.vu(0, 3) + 1 : 0;
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
    const ownAt = io.bit(false) ? io.vu(0, 3) : -1;
    const named = new Map<number, unknown>();
    const nn = io.vu(0, 1);
    let last = 0;
    for (let j = 0; j < nn; j++) { last += io.vu(0, 3); named.set(last, io.any(null)); }
    for (let i = 0; i < ne; i++) {
      if (i === ownAt) { rows.push(entityRowIO(io, undefined, tick)); continue; }
      const o = chained(false);
      if (named.has(i)) { while (o.length < 10) o.push(null); o[10] = named.get(i); }
      rows.push(o);
    }
    out[3] = rows;
  }
  if (has(4)) {
    const rows: unknown[][] = [];
    const np = io.vu(0, 3);
    for (let i = 0; i < np; i++) {
      const owner = who();
      let key = -1, abs = false;
      const o = projectileBody(io, undefined, false, (gun) => {
        // (the absolute bit was read first: it's the block's first bit after the wid)
        key = gunKey(owner, gun);
        const c = key >= 0 ? blk.guns.get(key) : undefined;
        if (abs) return new Array<number>(P_ID + 1).fill(0);
        if (!c) throw new Error('packed: a shell row steps from a gun chain this end has not got');
        return c;
      }, (a) => { abs = a; });
      o[7] = owner;
      if (key >= 0) {
        const pv = abs ? new Array<number>(P_ID + 1).fill(0) : blk.guns.get(key)!;
        settleProjectile(pv, o);
        blk.guns.set(key, pv);
      }
      rows.push(o);
    }
    out[4] = rows;
  }
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
  blk.trimGuns();
  while (out.length > 1 && out[out.length - 1] === null) out.pop();
  return out;
}
