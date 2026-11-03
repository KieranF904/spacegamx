// Netcode Lab: the wire format between the lab server and its clients (both ends load this file). Binary, little-endian,
// varints (LEB128: 1 byte for 0-127, 2 up to 16,383). Each writer and reader keeps a byte count per category, so both
// ends can show where the bandwidth goes. JSON text frames carry only the lab's own chatter (hello, debug commands,
// the info panel), not metered: they are not part of either design.
(function (NL) {
'use strict';
const W = NL.World;
const { FX } = NL.Sim;

const T = {
  // client -> server (binary). UP is 64 + its flags (one byte for both), so any first byte 64-127 is an up message
  UP: 64, PING: 3,
  // server -> client (binary)
  BUNDLE: 21, PONG: 22, SNAP: 24,
};
const isUp = (b) => (b & 0xC0) === 0x40;
/** Records inside a bundle (one bundle per tick that has something in it, plus heartbeats). RCV: how many of your
 *  inputs the server had by this tick (low byte), sent only when it moved and only on a bundle going out anyway. ORD: an
 *  AI's order decided this tick, switched to ORDER_LEAD ticks later (its slot, its next target's slot + 1, 0 for none).
 *  TICK: the records after it are for a later tick (a step from the one before), so one message can carry several */
const R = { IN: 1, RCV: 2, ENTER: 3, EXIT: 4, CORR: 5, ROCK: 6, RCORR: 7, RDEAD: 8, LATE: 9, PULL: 10, GONE: 11, ORD: 12, TICK: 13 };
const REASON = { 1: 'mismatch', 2: 'missing', 3: 'spurious', 4: 'hash', 5: 'unseen' };
const REASON_ID = { mismatch: 1, missing: 2, spurious: 3, hash: 4, unseen: 5 };
/** Report ids: kind in the low 2 bits of the varint (so ids under 32 are one byte) */
const IDK = { SLOT: 0, ROCK: 1, SHELL: 2, STATIC: 3 };

// --------------------------------------------------------------------------------------------------- writer/reader
class Writer {
  constructor(n = 128) { this.u = new Uint8Array(n); this.v = new DataView(this.u.buffer); this.o = 0; this.cats = {}; this.cat = null; this.c0 = 0; }
  need(n) {
    if (this.o + n <= this.u.length) return;
    const u = new Uint8Array(Math.max(this.u.length * 2, this.o + n)); u.set(this.u); this.u = u; this.v = new DataView(u.buffer);
  }
  /** Bytes from here on count towards category c */
  mark(c) { if (this.cat) this.cats[this.cat] = (this.cats[this.cat] || 0) + this.o - this.c0; this.cat = c; this.c0 = this.o; }
  u8(x) { this.need(1); this.v.setUint8(this.o++, x & 255); }
  i8(x) { this.need(1); this.v.setInt8(this.o++, Math.max(-128, Math.min(127, x))); }
  u16(x) { this.need(2); this.v.setUint16(this.o, x & 0xFFFF, true); this.o += 2; }
  i16(x) { this.need(2); this.v.setInt16(this.o, x, true); this.o += 2; }
  u32(x) { this.need(4); this.v.setUint32(this.o, x >>> 0, true); this.o += 4; }
  i32(x) { this.need(4); this.v.setInt32(this.o, x | 0, true); this.o += 4; }
  f64(x) { this.need(8); this.v.setFloat64(this.o, x, true); this.o += 8; }
  vu(x) { do { let b = x % 128; x = Math.floor(x / 128); if (x) b |= 128; this.u8(b); } while (x); }
  zv(x) { this.vu(zz(x)); }
  /** Another writer's bytes, and its byte counts per category */
  append(o) {
    o.mark(null); this.mark(null); this.need(o.o);
    this.u.set(o.u.subarray(0, o.o), this.o); this.o += o.o; this.c0 = this.o;
    for (const k in o.cats) this.cats[k] = (this.cats[k] || 0) + o.cats[k];
  }
  done() { this.mark(null); return this.u.slice(0, this.o); }
}
class Reader {
  constructor(buf) { this.u = buf; this.v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength); this.o = 0; this.cats = {}; this.cat = null; this.c0 = 0; }
  mark(c) { if (this.cat) this.cats[this.cat] = (this.cats[this.cat] || 0) + this.o - this.c0; this.cat = c; this.c0 = this.o; }
  end() { this.mark(null); return this.cats; }
  more() { return this.o < this.u.length; }
  u8() { return this.v.getUint8(this.o++); }
  i8() { return this.v.getInt8(this.o++); }
  u16() { const x = this.v.getUint16(this.o, true); this.o += 2; return x; }
  i16() { const x = this.v.getInt16(this.o, true); this.o += 2; return x; }
  u32() { const x = this.v.getUint32(this.o, true); this.o += 4; return x; }
  i32() { const x = this.v.getInt32(this.o, true); this.o += 4; return x; }
  f64() { const x = this.v.getFloat64(this.o, true); this.o += 8; return x; }
  vu() { let x = 0, m = 1, b; do { b = this.u8(); x += (b & 127) * m; m *= 128; } while (b & 128); return x; }
  zv() { return unzz(this.vu()); }
}
/** A 16-bit tick widened against one the reader already knows (nearest) */
const widen = (low, near) => near + ((((low - near) & 0xFFFF) + 32768) & 0xFFFF) - 32768;
const widen8 = (low, near) => near + ((((low - near) & 0xFF) + 128) & 0xFF) - 128;

// ----------------------------------------------------------------------------------------------------------- inputs
// Inputs: button bits (10 used), aim on a 13-bit grid, cursor distance / 4 (as the game's binary input). The input
// streams send what changed since the last one (wInpDelta); snapshots carry the held one whole (wInpS).
const quantAim = (ba) => ((ba >> 3) << 3) & 0xFFFF;
const quantDist = (d, step = 4) => Math.min(65535 * 4, Math.max(0, Math.round(d / step) * step));
const zz = (x) => (x >= 0 ? x * 2 : -x * 2 - 1);
const unzz = (v) => (v % 2 ? -(v + 1) / 2 : v / 2);
/** Which fields differ from prev: 1 buttons, 2 aim, 4 distance */
const inpDiff = (inp, prev) => (inp.b !== prev.b ? 1 : 0) | (inp.aim !== prev.aim ? 2 : 0) | (inp.dist !== prev.dist ? 4 : 0);
/** The fields in f: buttons as a varint, aim and distance as signed steps from prev (a mouse nudge is one byte) */
function wInpDelta(w, inp, prev, f) {
  if (f & 1) w.vu(inp.b);
  if (f & 2) w.vu(zz(((((inp.aim - prev.aim) >> 3) + 4096) & 8191) - 4096));
  if (f & 4) w.vu(zz((inp.dist - prev.dist) >> 2));
}
/** Read the fields in f without a base (the base can be the receiver's copy of the ship at a later moment) */
function rInpDelta(r, f) { return { f, b: f & 1 ? r.vu() : 0, da: f & 2 ? unzz(r.vu()) : 0, dd: f & 4 ? unzz(r.vu()) : 0 }; }
function applyInp(prev, d) {
  return { b: d.f & 1 ? d.b : prev.b, aim: (prev.aim + d.da * 8) & 0xFFFF, dist: prev.dist + d.dd * 4, seq: 0 };
}

// ------------------------------------------------------------------------------------------------------- entities
/** Full state of a ship (entry or correction snapshot), its live shells included. Kind byte: + 4 for a bot. A flags byte
 *  says which fields are there (the rest are at their defaults); a drone's home and aim flip, a freighter's waypoint, only
 *  for that kind. A shell's life and damage follow from its age and gun, so they go only if they don't. */
const SF = { DEAD: 1, BOOST: 2, SCORE: 4, CARGO: 8, ORDER: 16, TARGET: 32, GUNS: 64, SHELLS: 128 };
function wShip(w, sh, shells, T) {
  const K = W.P.kinds[sh.kind];
  const f = (sh.dead ? SF.DEAD : 0) | (sh.boost !== W.P.boostMax ? SF.BOOST : 0) | (sh.kills || sh.deaths ? SF.SCORE : 0)
    | (sh.cargo ? SF.CARGO : 0) | (sh.nat ? SF.ORDER : 0) | (sh.target ? SF.TARGET : 0)
    | (sh.av || sh.tur || sh.gcd || sh.tcd ? SF.GUNS : 0) | (shells.length ? SF.SHELLS : 0);
  w.u8(W.KIND_ID[sh.kind] + (sh.bot ? 4 : 0)); w.vu(sh.uid); w.u8(f);
  w.i32(sh.x); w.i32(sh.y); w.zv(sh.vx); w.zv(sh.vy); w.u16(sh.a);
  if (f & SF.GUNS) { w.zv(sh.av); w.zv(sh.tur); w.u8(sh.gcd); w.u8(sh.tcd); }
  w.vu(sh.hp); w.vu(sh.shots); w.i32(sh.rng);
  if (f & SF.DEAD) w.vu(sh.dead);
  if (f & SF.BOOST) w.vu(sh.boost);
  if (f & SF.SCORE) { w.vu(sh.kills); w.vu(sh.deaths); }
  if (f & SF.CARGO) w.vu(sh.cargo);
  if (f & SF.TARGET) w.vu(sh.target);
  if (f & SF.ORDER) { w.vu(sh.nt); w.u8(sh.nat - T); }
  if (sh.kind === 'drone') { w.u8(sh.aiFlip); w.i16(sh.hx); w.i16(sh.hy); }
  else if (sh.kind === 'freighter') { w.i16(sh.wpx); w.i16(sh.wpy); }
  wInpS(w, sh.inp);
  if (!shells.length) return;
  w.vu(shells.length);
  for (const p of shells) {
    const g = p.gun ? K.tur : K.gun, age = T - p.t0, exact = g && p.life === g.life - age && p.dmg === g.dmg;
    w.vu((((sh.shots - p.n) & 0xFFFF) * 2 + (p.gun ? 1 : 0)) * 2 + (exact ? 1 : 0)); w.u8(age);
    w.i32(p.x); w.i32(p.y); w.i32(p.vx); w.i32(p.vy);
    if (!exact) { w.u8(p.life); w.u8(p.dmg); }
  }
}
/** A held input in a snapshot: buttons as a varint, aim on its 13-bit grid, distance / 4 as a varint */
function wInpS(w, inp) { w.vu(inp.b); w.u16(inp.aim >> 3); w.vu(inp.dist >> 2); }
function rInpS(r) { return { b: r.vu(), aim: r.u16() << 3, dist: r.vu() << 2, seq: 0 }; }
function wLoot(w, l) { w.u8(3); w.vu(l.uid - W.C.LOOT_BASE); w.i32(l.x); w.i32(l.y); w.zv(l.vx); w.zv(l.vy); w.vu(l.life); }
function wEntity(w, Wd, uid) {
  const e = Wd.byUid.get(uid);
  if (W.isLoot(uid)) wLoot(w, e); else wShip(w, e, Wd.shells.filter((p) => p.o === uid), Wd.tick);
}
/** -> { ent, shells } (shells null for loot) */
function rEntity(r, T) {
  const k = r.u8();
  if (k === 3) {
    const uid = r.vu() + W.C.LOOT_BASE;
    return { ent: { uid, x: r.i32(), y: r.i32(), vx: r.zv(), vy: r.zv(), life: r.vu() }, shells: null };
  }
  const kind = W.KIND_NAME[k & 3], uid = r.vu(), f = r.u8(), K = W.P.kinds[kind];
  const sh = W.makeShip(uid, kind, 0, 0, 0);
  sh.bot = k >> 2;
  sh.x = r.i32(); sh.y = r.i32(); sh.vx = r.zv(); sh.vy = r.zv(); sh.a = r.u16();
  if (f & SF.GUNS) { sh.av = r.zv(); sh.tur = r.zv(); sh.gcd = r.u8(); sh.tcd = r.u8(); }
  sh.hp = r.vu(); sh.shots = r.vu(); sh.rng = r.i32();
  if (f & SF.DEAD) sh.dead = r.vu();
  if (f & SF.BOOST) sh.boost = r.vu();
  if (f & SF.SCORE) { sh.kills = r.vu(); sh.deaths = r.vu(); }
  if (f & SF.CARGO) sh.cargo = r.vu();
  if (f & SF.TARGET) sh.target = r.vu();
  if (f & SF.ORDER) { sh.nt = r.vu(); sh.nat = T + r.u8(); }
  if (kind === 'drone') { sh.aiFlip = r.u8(); sh.hx = r.i16(); sh.hy = r.i16(); }
  else if (kind === 'freighter') { sh.wpx = r.i16(); sh.wpy = r.i16(); }
  sh.inp = rInpS(r);
  const n = f & SF.SHELLS ? r.vu() : 0, shells = [], tm = W.team(sh);
  for (let i = 0; i < n; i++) {
    const v = r.vu(), exact = v & 1, gun = (v >> 1) & 1, age = r.u8();
    const p = { o: uid, gun, n: (sh.shots - Math.floor(v / 4)) & 0xFFFF, t0: T - age };
    p.x = r.i32(); p.y = r.i32(); p.vx = r.i32(); p.vy = r.i32();
    if (exact) { const g = gun ? K.tur : K.gun; p.life = g.life - age; p.dmg = g.dmg; } else { p.life = r.u8(); p.dmg = r.u8(); }
    p.id = uid * 65536 + p.n; p.tm = tm;
    shells.push(p);
  }
  return { ent: sh, shells };
}
/** A rock that is not in its default state: hp, and how long ago it was destroyed (hp 0) */
function wRock(w, Wd, id) {
  const o = Wd.rockOv.get(id), R0 = Wd.rocks.list[id];
  w.vu(id); w.u16(o ? o.hp : R0.hp);
  if (o && o.dead) w.u16(Wd.tick - o.dead);
}
function rRock(r, T) {
  const id = r.vu(), hp = r.u16();
  return { id, hp, dead: hp === 0 ? T - r.u16() : 0 };
}

// ------------------------------------------------------------------------------------------------------ messages
/** Client -> server, the one message of the new design: ack (my confirmed tick), maybe an input, event reports, hashes.
 *  First byte: 64 + flags (input 1, reports 2, hashes 4, which input fields changed << 3). The ack is a step from the
 *  last one sent (lastAck). The input is relative to the one before it (base: { target, inp }); its sequence number is
 *  implied (inputs arrive in order, so the server counts them). */
function encUp({ ack, lastAck, input, base, reports, hashes }) {
  const w = new Writer(32);
  const f = input ? inpDiff(input.inp, base.inp) : 0;
  w.mark('acks'); w.u8(T.UP | (input ? 1 : 0) | (reports && reports.length ? 2 : 0) | (hashes ? 4 : 0) | (f << 3)); w.vu(ack - lastAck);
  if (input) { w.mark('inputs'); w.zv(input.target - base.target); wInpDelta(w, input.inp, base.inp, f); }
  if (reports && reports.length) {
    w.mark('reports'); w.vu(reports.length);
    for (const rp of reports) { w.vu(rp.id * 4 + rp.kind); w.u8(rp.hash); }
  }
  if (hashes) { w.mark('hashes'); w.vu(ack - hashes.tick); w.vu(hashes.list.length); for (const h of hashes.list) w.u8(h); }
  const buf = w.done(); buf.cats = w.cats; return buf;
}
/** -> { ack, input: { target, inp } | null, reports, hashes }; the reader's categories match encUp's */
function decUp(r, lastAck, base) {
  r.mark('acks');
  const f = r.u8() & 63, ack = lastAck + r.vu(), out = { ack, input: null, reports: [], hashes: null };
  if (f & 1) {
    r.mark('inputs');
    const target = base.target + r.zv();
    out.input = { target, inp: applyInp(base.inp, rInpDelta(r, f >> 3)) };
  }
  if (f & 2) { r.mark('reports'); const n = r.vu(); for (let i = 0; i < n; i++) { const v = r.vu(); out.reports.push({ kind: v & 3, id: Math.floor(v / 4), hash: r.u8() }); } }
  if (f & 4) { r.mark('hashes'); const tick = ack - r.vu(), n = r.vu(), list = []; for (let i = 0; i < n; i++) list.push(r.u8()); out.hashes = { tick, list }; }
  r.end();
  return out;
}
/** Ping: the low 16 bits of the client's clock in ms (the pong echoes them), its round trip. Pong: those 16 bits, the
 *  server's clock in ms, its tick, the smallest input lead since the last pong */
function encPing(t, rtt) { const w = new Writer(6); w.mark('ping'); w.u8(T.PING); w.u16(Math.round(t)); w.u16(Math.min(65535, Math.round(rtt))); const b = w.done(); b.cats = w.cats; return b; }
function encPong(t16, serverMs, tick, minLead) {
  const w = new Writer(12); w.mark('ping'); w.u8(T.PONG); w.u16(t16); w.u32(Math.round(serverMs)); w.vu(tick); w.i8(minLead);
  const b = w.done(); b.cats = w.cats; return b;
}

/**
 * Current style snapshot (20 Hz): your ship in full; ships and loot in range, quantised (drawn between snapshots);
 * shells others fired; hits; rocks that changed. Categories: header, own, others, shells, hits, rocks.
 */
function encSnap(Wd, tick, ack, me, rows, loot, fires, hits, rocks) {
  const w = new Writer(256);
  w.mark('header'); w.u8(T.SNAP); w.u32(tick); w.u16(ack);
  w.mark('own'); wShip(w, me, [], tick);
  w.mark('others'); w.vu(rows.length);
  for (const s of rows) { w.u8(W.KIND_ID[s.kind]); w.vu(s.uid); w.i32(s.x >> 8); w.i32(s.y >> 8); w.u16(s.a); w.i16(s.tur); w.u16(s.hp); w.u8(s.dead ? 1 : 0); w.vu(s.cargo); }
  w.vu(loot.length);
  for (const l of loot) { w.vu(l.uid - W.C.LOOT_BASE); w.i32(l.x >> 8); w.i32(l.y >> 8); }
  w.mark('shells'); w.vu(fires.length);
  for (const p of fires) { w.vu(p.o); w.u8(p.gun); w.u16(p.n); w.u8(tick - p.t0); w.i32(p.x); w.i32(p.y); w.i32(p.vx); w.i32(p.vy); w.u8(p.life); w.u8(p.dmg); }
  w.mark('hits'); w.vu(hits.length);
  for (const h of hits) { w.vu(h.rock >= 0 ? h.rock * 2 + 1 : h.tgt * 2); w.vu(h.by); w.u8(tick - h.T); w.u8(h.kill); w.i32(h.x >> 8); w.i32(h.y >> 8); }
  w.mark('rocks'); w.vu(rocks.length);
  for (const id of rocks) wRock(w, Wd, id);
  const b = w.done(); b.cats = w.cats; return b;
}
function decSnap(r) {
  r.mark('header'); r.u8();
  const tick = r.u32(), ack = r.u16();
  r.mark('own'); const me = rEntity(r, tick).ent;
  r.mark('others'); const n = r.vu(), rows = [];
  for (let i = 0; i < n; i++) {
    const kind = W.KIND_NAME[r.u8()], uid = r.vu();
    rows.push({ kind, uid, x: r.i32() / 256, y: r.i32() / 256, a: r.u16(), tur: r.i16(), hp: r.u16(), dead: r.u8(), cargo: r.vu() });
  }
  const nl = r.vu(), loot = [];
  for (let i = 0; i < nl; i++) loot.push({ uid: r.vu() + W.C.LOOT_BASE, x: r.i32() / 256, y: r.i32() / 256 });
  r.mark('shells'); const nf = r.vu(), fires = [];
  for (let i = 0; i < nf; i++) {
    const p = { o: r.vu(), gun: r.u8(), n: r.u16() }; p.t0 = tick - r.u8();
    p.x = r.i32(); p.y = r.i32(); p.vx = r.i32(); p.vy = r.i32(); p.life = r.u8(); p.dmg = r.u8(); p.id = p.o * 65536 + p.n;
    fires.push(p);
  }
  r.mark('hits'); const nh = r.vu(), hits = [];
  for (let i = 0; i < nh; i++) {
    const v = r.vu(), by = r.vu(), T0 = tick - r.u8(), kill = r.u8();
    hits.push({ rock: v & 1 ? (v - 1) / 2 : -1, tgt: v & 1 ? -1 : v / 2, by, T: T0, kill, x: r.i32() / 256, y: r.i32() / 256 });
  }
  r.mark('rocks'); const nr = r.vu(), rocks = [];
  for (let i = 0; i < nr; i++) rocks.push(rRock(r, tick));
  r.end();
  return { tick, ack, me, rows, loot, fires, hits, rocks };
}

const view = (buf) => new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
/** Bytes a message costs on the wire beyond its payload: IPv4 20 + TCP 20, WebSocket 2-4 (+4 mask from the client),
 *  TLS 1.3 record 22 (5 header + 16 tag + 1 type). TCP acks the other way are left out. */
function wireBytes(n, fromClient) { return n + 40 + 22 + (n < 126 ? 2 : n < 65536 ? 4 : 10) + (fromClient ? 4 : 0); }

NL.Proto = { T, isUp, R, REASON, REASON_ID, IDK, Writer, Reader, widen, widen8, quantAim, quantDist, inpDiff, wInpDelta, rInpDelta, applyInp, wShip, wLoot,
  wEntity, rEntity, wRock, rRock, encUp, decUp, encPing, encPong, encSnap, decSnap, view, wireBytes };
if (typeof module === 'object' && module.exports) module.exports = NL;
})(globalThis.NL = globalThis.NL || {});
