// Netcode Lab: the pretend network (latency, jitter, loss on a WebSocket-like link), byte meters, and the binary
// message codec. Every message really is encoded to a Uint8Array and decoded on the other side, so the byte counts
// are what these messages would cost; nothing crosses as an object.
(function (NL) {
'use strict';
const { IN } = NL.Sim;

// ------------------------------------------------------------------------------------------------------------ meter
/** Bytes per second over the last second, plus a history the graphs read (one point every 250 ms) */
class Meter {
  constructor() { this.win = []; this.total = 0; this.totalWire = 0; this.packets = 0; this.hist = []; this.lastHist = 0; }
  add(now, bytes, wire) { this.win.push(now, bytes, wire); this.total += bytes; this.totalWire += wire; this.packets++; }
  trim(now) { let i = 0; while (i < this.win.length && this.win[i] < now - 1000) i += 3; if (i) this.win.splice(0, i); }
  rate(now) {
    this.trim(now);
    let b = 0, w = 0, n = 0;
    for (let i = 0; i < this.win.length; i += 3) { b += this.win[i + 1]; w += this.win[i + 2]; n++; }
    return { bytes: b, wire: w, packets: n };
  }
  sample(now) {
    if (now - this.lastHist < 250) return;
    this.lastHist = now;
    this.hist.push(this.rate(now).bytes);
    if (this.hist.length > 120) this.hist.shift();
  }
}

// ------------------------------------------------------------------------------------------------------------- link
// One direction of one client's connection. It behaves like the game's WebSocket (TCP): nothing is reordered, and a
// lost packet is not gone, it is resent after about a round trip, and everything sent after it waits behind it
// (head-of-line blocking). Jitter adds 0..jitter ms to each packet (but can't reorder them).
// Wire bytes add the headers a WebSocket message pays on the way: IPv4 20 + TCP 20 + WebSocket 2 (server to client)
// or 6 (client to server, masked). TCP acks the other way and TLS are left out.
const IP_TCP = 40;
class Link {
  constructor(up, meter) {
    this.up = up; this.meter = meter;
    this.lat = 0; this.jit = 0; this.loss = 0;
    this.q = []; this.last = 0; this.lost = 0; this.sent = 0;
  }
  set(lat, jit, loss) { this.lat = lat; this.jit = jit; this.loss = loss; }
  send(now, buf) {
    const n = buf.length, ws = (this.up ? 4 : 0) + (n < 126 ? 2 : n < 65536 ? 4 : 10);
    this.meter.add(now, n, n + ws + IP_TCP);
    this.sent++;
    // Retransmit after about a round trip (fast retransmit: duplicate acks come back from the packets behind it)
    const rto = Math.max(40, 2 * this.lat + 2 * this.jit + 20);
    let t = now + this.lat + Math.random() * this.jit;
    while (this.loss > 0 && Math.random() < this.loss) { t += rto; this.lost++; }
    t = Math.max(t, this.last);          // in order: waits behind anything sent before it
    this.last = t;
    this.q.push(t, buf);
  }
  next() { return this.q.length ? this.q[0] : Infinity; }
  pop() { const t = this.q.shift(), buf = this.q.shift(); return { t, buf }; }
}

// ------------------------------------------------------------------------------------------------------------ codec
const T = { INPUT: 1, LOCK: 2, PING: 3, SNAP: 10, RELAY: 11, PONG: 12 };

// Input bits <-> the game's binary input flags (common/src/network/protocol.ts encodeInputBinary): byte 5 =
// fwd 1, back 2, left 4, right 8, boost 0x10, fireL 0x20, fireR 0x40; byte 10 = strafeL 1, strafeR 2, helm 4.
function flagsOf(b) {
  const f1 = ((b & IN.W) ? 1 : 0) | ((b & IN.S) ? 2 : 0) | ((b & IN.A) ? 4 : 0) | ((b & IN.D) ? 8 : 0) |
    ((b & IN.BOOST) ? 0x10 : 0) | ((b & IN.GUN) ? 0x20 : 0) | ((b & IN.TURRET) ? 0x40 : 0);
  const f2 = ((b & IN.Q) ? 1 : 0) | ((b & IN.E) ? 2 : 0) | ((b & IN.HELM) ? 4 : 0);
  return [f1, f2];
}
function bitsOf(f1, f2) {
  return ((f1 & 1) ? IN.W : 0) | ((f1 & 2) ? IN.S : 0) | ((f1 & 4) ? IN.A : 0) | ((f1 & 8) ? IN.D : 0) |
    ((f1 & 0x10) ? IN.BOOST : 0) | ((f1 & 0x20) ? IN.GUN : 0) | ((f1 & 0x40) ? IN.TURRET : 0) |
    ((f2 & 1) ? IN.Q : 0) | ((f2 & 2) ? IN.E : 0) | ((f2 & 4) ? IN.HELM : 0);
}
/** Inputs are sampled already on the wire's grid (aim 13 bits, distance in steps of 4) so a prediction uses what the server gets */
const quantAim = (ba) => ((ba >> 3) << 3) & 0xFFFF;
const quantDist = (d) => Math.min(65535 * 4, Math.max(0, Math.round(d / 4) * 4));

/** Current style input, the game's 11-byte layout: type, seq, target tick (low 16), flags, aim q13, dist/4, flags2 */
function encInput(seq, target, inp) {
  const u = new Uint8Array(11), v = new DataView(u.buffer), [f1, f2] = flagsOf(inp.b);
  v.setUint8(0, T.INPUT); v.setUint16(1, seq & 0xFFFF, true); v.setUint16(3, target & 0xFFFF, true);
  v.setUint8(5, f1); v.setUint16(6, inp.aim >> 3, true); v.setUint16(8, inp.dist >> 2, true); v.setUint8(10, f2 | 0x10);
  return u;
}
/** (The 16-bit seq and tick are widened against what the receiver already knows: nearest value to `near`) */
const widen = (low, near) => near + ((((low - near) & 0xFFFF) + 32768) & 0xFFFF) - 32768;
function decInput(v, nearSeq, nearTick) {
  const seq = widen(v.getUint16(1, true), nearSeq), target = widen(v.getUint16(3, true), nearTick);
  return { seq, target, inp: { b: bitsOf(v.getUint8(5), v.getUint8(10)), aim: v.getUint16(6, true) << 3, dist: v.getUint16(8, true) << 2, seq } };
}

/** Lockstep input: type, first tick u32, count, then 6 bytes an input (flags, flags2, aim q13, dist/4). No seq: peers don't need it. */
function encLock(first, list) {
  const u = new Uint8Array(6 + 6 * list.length), v = new DataView(u.buffer);
  v.setUint8(0, T.LOCK); v.setUint32(1, first, true); v.setUint8(5, list.length);
  list.forEach((inp, i) => putInp(v, 6 + 6 * i, inp));
  return u;
}
function putInp(v, o, inp) { const [f1, f2] = flagsOf(inp.b); v.setUint8(o, f1); v.setUint8(o + 1, f2); v.setUint16(o + 2, inp.aim >> 3, true); v.setUint16(o + 4, inp.dist >> 2, true); }
function getInp(v, o) { return { b: bitsOf(v.getUint8(o), v.getUint8(o + 1)), aim: v.getUint16(o + 2, true) << 3, dist: v.getUint16(o + 4, true) << 2, seq: 0 }; }
function decLock(v) {
  const first = v.getUint32(1, true), n = v.getUint8(5), list = [];
  for (let i = 0; i < n; i++) list.push(getInp(v, 6 + 6 * i));
  return { first, list };
}
/** Relay (server to the other peers): type, player, first tick u32, count, inputs */
function encRelay(player, first, list) {
  const u = new Uint8Array(7 + 6 * list.length), v = new DataView(u.buffer);
  v.setUint8(0, T.RELAY); v.setUint8(1, player); v.setUint32(2, first, true); v.setUint8(6, list.length);
  list.forEach((inp, i) => putInp(v, 7 + 6 * i, inp));
  return u;
}
function decRelay(v) {
  const player = v.getUint8(1), first = v.getUint32(2, true), n = v.getUint8(6), list = [];
  for (let i = 0; i < n; i++) list.push(getInp(v, 7 + 6 * i));
  return { player, first, list };
}

function encPing(t, rtt) { const u = new Uint8Array(11), v = new DataView(u.buffer); v.setUint8(0, T.PING); v.setFloat64(1, t, true); v.setUint16(9, Math.min(65535, Math.round(rtt)), true); return u; }
function decPing(v) { return { t: v.getFloat64(1, true), rtt: v.getUint16(9, true) }; }
function encPong(t, tick, maxRtt) { const u = new Uint8Array(15), v = new DataView(u.buffer); v.setUint8(0, T.PONG); v.setFloat64(1, t, true); v.setUint32(9, tick, true); v.setUint16(13, Math.min(65535, Math.round(maxRtt)), true); return u; }
function decPong(v) { return { t: v.getFloat64(1, true), tick: v.getUint32(9, true), maxRtt: v.getUint16(13, true) }; }

/**
 * Snapshot (current style), one per client:
 *   type, tick u32, ack seq u16, ship count, fire count, hit count
 *   your ship, exact (it is what your prediction is checked against): id, x y vx vy i32 (Q16), angle u16, spin i16,
 *     turret i16, gun cd, turret cd, hp, dead, boost u16, kills, deaths  (33 bytes)
 *   each other ship, for drawing only: id, x y i32 (Q8), angle u16, turret i16, hp, dead, kills, deaths  (17 bytes)
 *   each new shell from someone else: owner, gun, ticks since fired, x y vx vy i32, life, damage  (21 bytes)
 *   each hit: shell id u32, target, ticks ago  (6 bytes)
 */
function encSnap(tick, ack, you, ships, fires, hits) {
  const others = ships.filter((s) => s.id !== you), me = ships.find((s) => s.id === you);
  const n = 10 + 33 + 17 * others.length + 21 * fires.length + 6 * hits.length;
  const u = new Uint8Array(n), v = new DataView(u.buffer);
  let o = 0;
  v.setUint8(o++, T.SNAP); v.setUint32(o, tick, true); o += 4; v.setUint16(o, ack & 0xFFFF, true); o += 2;
  v.setUint8(o++, others.length + 1); v.setUint8(o++, fires.length); v.setUint8(o++, hits.length);
  v.setUint8(o++, me.id);
  for (const k of ['x', 'y', 'vx', 'vy']) { v.setInt32(o, me[k], true); o += 4; }
  v.setUint16(o, me.a, true); o += 2; v.setInt16(o, me.av, true); o += 2; v.setInt16(o, me.tur, true); o += 2;
  v.setUint8(o++, me.gcd); v.setUint8(o++, me.tcd); v.setUint8(o++, me.hp); v.setUint8(o++, me.dead);
  v.setUint16(o, me.boost, true); o += 2; v.setUint8(o++, me.kills & 255); v.setUint8(o++, me.deaths & 255);
  for (const s of others) {
    v.setUint8(o++, s.id); v.setInt32(o, s.x >> 8, true); o += 4; v.setInt32(o, s.y >> 8, true); o += 4;
    v.setUint16(o, s.a, true); o += 2; v.setInt16(o, s.tur, true); o += 2;
    v.setUint8(o++, s.hp); v.setUint8(o++, s.dead); v.setUint8(o++, s.kills & 255); v.setUint8(o++, s.deaths & 255);
  }
  for (const p of fires) {
    v.setUint8(o++, p.o); v.setUint8(o++, p.gun); v.setUint8(o++, Math.min(255, tick - p.t0));
    for (const k of ['x', 'y', 'vx', 'vy']) { v.setInt32(o, p[k], true); o += 4; }
    v.setUint8(o++, Math.min(255, p.life)); v.setUint8(o++, p.dmg);
  }
  for (const h of hits) { v.setUint32(o, h.id, true); o += 4; v.setUint8(o++, h.target); v.setUint8(o++, Math.min(255, tick - h.tick)); }
  return u;
}
function decSnap(v, nearSeq) {
  let o = 1;
  const tick = v.getUint32(o, true); o += 4;
  const ack = widen(v.getUint16(o, true), nearSeq); o += 2;
  const ns = v.getUint8(o++), nf = v.getUint8(o++), nh = v.getUint8(o++);
  const me = { id: v.getUint8(o++) };
  for (const k of ['x', 'y', 'vx', 'vy']) { me[k] = v.getInt32(o, true); o += 4; }
  me.a = v.getUint16(o, true); o += 2; me.av = v.getInt16(o, true); o += 2; me.tur = v.getInt16(o, true); o += 2;
  me.gcd = v.getUint8(o++); me.tcd = v.getUint8(o++); me.hp = v.getUint8(o++); me.dead = v.getUint8(o++);
  me.boost = v.getUint16(o, true); o += 2; me.kills = v.getUint8(o++); me.deaths = v.getUint8(o++);
  const others = [];
  for (let i = 1; i < ns; i++) {
    const s = { id: v.getUint8(o++) };
    s.x = v.getInt32(o, true) / 256; o += 4; s.y = v.getInt32(o, true) / 256; o += 4;
    s.a = v.getUint16(o, true); o += 2; s.tur = v.getInt16(o, true); o += 2;
    s.hp = v.getUint8(o++); s.dead = v.getUint8(o++); s.kills = v.getUint8(o++); s.deaths = v.getUint8(o++);
    others.push(s);
  }
  const fires = [];
  for (let i = 0; i < nf; i++) {
    const p = { o: v.getUint8(o++), gun: v.getUint8(o++) };
    p.t0 = tick - v.getUint8(o++);
    for (const k of ['x', 'y', 'vx', 'vy']) { p[k] = v.getInt32(o, true); o += 4; }
    p.life = v.getUint8(o++); p.dmg = v.getUint8(o++);
    p.id = p.t0 * 16 + p.o * 2 + p.gun;
    fires.push(p);
  }
  const hits = [];
  for (let i = 0; i < nh; i++) { const id = v.getUint32(o, true); o += 4; hits.push({ id, target: v.getUint8(o++), tick: tick - v.getUint8(o++) }); }
  return { tick, ack, me, others, fires, hits };
}

const view = (buf) => new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

NL.Net = { Meter, Link, T, quantAim, quantDist, encInput, decInput, encLock, decLock, encRelay, decRelay, encPing, decPing,
  encPong, decPong, encSnap, decSnap, view, widen };
if (typeof module === 'object' && module.exports) module.exports = NL;
})(globalThis.NL);
