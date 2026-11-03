// Netcode Lab: the two clients of the lab server, with no transport of their own (lab.js gives them a WebSocket, or the
// in-page server; test.mjs gives them pretend links). Each takes send(buf | string), recv(data, now) and frame(now), and
// hands the page a view() to draw and stats() to show.
//
//   LsClient  - server-paced deterministic lockstep (docs/design/netcode-lockstep.md). Runs the shared world (world.js)
//               on the entities the server says it is aware of. Confirmed state = every tick the server has sent a
//               bundle for; the screen shows that state run forward to "now" (your own inputs applied at once when own
//               prediction is on), re-simulated from the confirmed tick whenever new confirmed ticks arrive.
//   CurClient - the game's style today: your ship predicted and reconciled against 20 Hz snapshots, everyone else drawn
//               between snapshots a little in the past.
(function (NL) {
'use strict';
const { Sim, World: Wo, Proto: Pr } = NL;
const { R, REASON, IDK } = Pr;
const TICK_MS = 1000 / Wo.RATE;
const FX = Sim.FX;
const CATCHUP = 30;         // most confirmed ticks simulated in one frame when behind
const MAXPRED = 120;        // most ticks the screen runs past the confirmed tick (2 s)
const HEARTBEAT_UP = 6;     // ack at least every 6 confirmed ticks even with nothing to report
const AIM_TICKS = 2;        // an input whose buttons didn't change (aim, cursor distance) goes out at most every 2 ticks

// ----------------------------------------------------------------------------------------------------- shared bits
/** Server clock from pongs: offset from the lowest-RTT recent sample (least queueing), slewed a few ms at a time */
class Clock {
  constructor() { this.samples = []; this.off = null; this.srtt = 0; this.jit = 0; this.n = 0; this.last = -1e9; }
  due(now) { if (now - this.last < 500) return false; this.last = now; return true; }
  sample(sent, recv, serverMs) {
    const rtt = recv - sent;
    if (!this.n++) this.srtt = rtt;
    else { this.jit += 0.2 * (Math.abs(rtt - this.srtt) - this.jit); this.srtt += 0.2 * (rtt - this.srtt); }
    this.samples.push({ rtt, off: serverMs + rtt / 2 - recv });
    if (this.samples.length > 12) this.samples.shift();
    const best = this.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
    if (this.off === null || Math.abs(best.off - this.off) > 60) this.off = best.off;
    else this.off += Math.max(-3, Math.min(3, best.off - this.off));
  }
  ready() { return this.off !== null; }
  /** Fractional server tick now */
  tick(now) { return (now + (this.off || 0)) / TICK_MS; }
}

/** Input-to-screen delay: from the key/mouse event to the first frame drawn from a state that used that input */
class DelayMeter {
  constructor() { this.pending = []; this.res = { thrust: [], turn: [], fire: [] }; this.confirm = []; this.pendingAck = []; }
  note(changes, seq) {
    for (const c of changes) { this.pending.push({ kind: c.kind, t: c.t, seq }); this.pendingAck.push({ t: c.t, seq }); }
    if (this.pending.length > 200) this.pending.splice(0, 100);
    if (this.pendingAck.length > 200) this.pendingAck.splice(0, 100);
  }
  shown(seq, now) {
    while (this.pending.length && this.pending[0].seq <= seq) {
      const p = this.pending.shift(), r = this.res[p.kind];
      r.push(now - p.t); if (r.length > 40) r.shift();
    }
  }
  acked(seq, now) {
    while (this.pendingAck.length && this.pendingAck[0].seq <= seq) {
      const p = this.pendingAck.shift();
      this.confirm.push(now - p.t); if (this.confirm.length > 40) this.confirm.shift();
    }
  }
}

/** Bytes per category over the last second, plus totals, payload and wire (headers) */
class CatMeter {
  constructor() { this.win = []; this.tot = {}; this.wire = 0; this.msgs = 0; this.t0 = null; }
  add(now, cats, wire) {
    if (this.t0 === null) this.t0 = now;
    this.win.push({ t: now, cats, wire });
    for (const k in cats) this.tot[k] = (this.tot[k] || 0) + cats[k];
    this.wire += wire; this.msgs++;
  }
  rate(now) {
    while (this.win.length && this.win[0].t < now - 1000) this.win.shift();
    const out = {}; let wire = 0, payload = 0;
    for (const e of this.win) { for (const k in e.cats) { out[k] = (out[k] || 0) + e.cats[k]; payload += e.cats[k]; } wire += e.wire; }
    return { cats: out, payload, wire, msgs: this.win.length };
  }
  totals() { let p = 0; for (const k in this.tot) p += this.tot[k]; return { cats: Object.assign({}, this.tot), payload: p, wire: this.wire, msgs: this.msgs }; }
}
const toBytes = (d) => (typeof d === 'string' ? d : d instanceof Uint8Array ? d : new Uint8Array(d));

class BaseClient {
  constructor(opts) {
    this.send0 = opts.send; this.src = opts.src; this.name = opts.name || 'pilot';
    this.clock = new Clock(); this.down = new CatMeter(); this.up = new CatMeter();
    this.uid = 0; this.ready = false; this.info = null; this.lastSample = -1e9; this.seq = 0; this.sent = null;
    this.sentAt = -1e9; this.carry = []; this.upBase = { target: 0, inp: Sim.NEUTRAL };
    this.held = []; this.holdUntil = 0; this.dropNext = false; this.dropped = 0;
  }
  send(buf, now) {
    // (the lab's own JSON chatter isn't metered)
    if (typeof buf !== 'string') this.up.add(now, buf.cats || { other: buf.length }, Pr.wireBytes(buf.length, true));
    this.send0(buf);
  }
  /** Raw arrival: debug "delay" holds everything for a while (in order); then handle() */
  recv(data, now) {
    data = toBytes(data);
    if (this.held.length || now < this.holdUntil) { this.held.push(data); return; }
    this.handle(data, now);
  }
  flushHeld(now) {
    if (!this.held.length || now < this.holdUntil) return;
    const q = this.held; this.held = [];
    for (const d of q) this.handle(d, now);
  }
  handle(data, now) {
    if (typeof data === 'string') {
      const m = JSON.parse(data);
      if (m.t === 'welcome') this.welcome(m, now);
      else if (m.t === 'info') this.info = m;
      return;
    }
    if (data[0] === Pr.T.PONG) {
      const r = new Pr.Reader(data); r.u8();
      const t = r.f64(), serverMs = r.f64(), tick = r.u32(), minLead = r.i8();
      this.down.add(now, { ping: data.length }, Pr.wireBytes(data.length, false));
      this.clock.sample(t, now, serverMs);
      this.pong(tick, minLead, now);
      return;
    }
    this.binary(data, now);
  }
  hello(mode, extra) { this.mode = mode; this.send(JSON.stringify(Object.assign({ t: 'hello', name: this.name, mode }, extra || {})), 0); }
  command(cmd, extra) { this.send(JSON.stringify(Object.assign({ t: 'cmd', cmd }, extra || {})), this.nowRef || 0); }
  ping(now) { if (this.ready && this.clock.due(now)) this.send(Pr.encPing(now, this.clock.srtt), now); }
  pong() {}
  /** One input sample a tick of local time; true when it changed (and then it carries a new seq) */
  sampleInput(now) {
    if (now - this.lastSample < TICK_MS * 0.9) return null;
    this.lastSample = now;
    const smp = this.src.sample(now);
    if (this.sent && Sim.sameInput(smp.inp, this.sent)) return null;
    // Aim and cursor distance alone at most every AIM_TICKS (buttons at once): the ship steers towards the aim and
    // brakes on the way, so 30 Hz flies the same as 60. A held-back change still counts for the delay meter.
    if (this.sent && smp.inp.b === this.sent.b && now - this.sentAt < TICK_MS * (AIM_TICKS - 0.1)) { this.carry.push(...smp.changes); return null; }
    if (this.carry.length) { smp.changes = this.carry.concat(smp.changes); this.carry = []; }
    smp.inp.seq = ++this.seq;
    this.sent = smp.inp; this.sentAt = now;
    return smp;
  }
  /** The one up message, its input relative to the last one sent (the server counts inputs, so no sequence number) */
  encUp(ack, input, reports, hashes) {
    const buf = Pr.encUp({ ack, input, base: this.upBase, reports, hashes });
    if (input) this.upBase = { target: input.target, inp: input.inp };
    return buf;
  }
}

// ==================================================================================================== lockstep client
class LsClient extends BaseClient {
  constructor(opts) {
    super(opts);
    this.predOn = opts.pred ?? true; this.every = !!opts.every;
    this.conf = null; this.pending = []; this.lastBundleTick = 0; this.version = 0; this.pred = null; this.predVer = -1;
    this.slots = new Map(); this.slotOf = new Map(); this.pulled = new Map();
    this.stream = [];           // own inputs sent and not yet used in the confirmed world: { seq, target, inp }
    this.rcv = 0;               // how many of them the server had by the newest bundle (RCV)
    this.margin = opts.margin ?? 2; this.lastTarget = 0; this.slack = 0; this.lastLate = -1e9;
    this.reports = []; this.hashes = null; this.lastAckSent = 0;
    this.delays = { on: new DelayMeter(), off: new DelayMeter() };
    this.st = { late: 0, entries: 0, exits: 0, pullIns: 0, corrections: 0, resim: 0, resimLast: 0, catchup: 0, maxBehind: 0,
      reported: 0, hashSent: 0, steps: 0, injected: [], caught: [], counts: { mismatch: 0, missing: 0, spurious: 0, hash: 0, unseen: 0 } };
    this.sparks = []; this.seenFx = new Set(); this.recent = new Map();   // uid -> tick of its last event (for the silent pick)
  }
  start() { this.hello('lockstep', { every: this.every }); }
  welcome(m) {
    this.uid = m.uid; this.cid = m.cid; this.hashEvery = m.hashEvery; this.C = m.C;
    this.conf = Wo.createWorld(m.seed, false); this.conf.tick = m.tick;
    this.lastBundleTick = m.tick; this.lastAckSent = m.tick; this.ready = true;
  }
  pong(tick, minLead) {
    // The server reports the smallest lead (target - its tick on arrival) since the last pong: 1 = just in time
    if (minLead === -128) return;
    if (minLead >= 3) this.slack++; else this.slack = 0;
    if (this.slack >= 6 && this.margin > 0) { this.margin--; this.slack = 0; }
  }
  // --- bundles ---------------------------------------------------------------------------------------------------
  binary(buf, now) {
    if (buf[0] !== Pr.T.BUNDLE || !this.conf) return;
    const r = new Pr.Reader(buf);
    r.mark('ticks'); r.u8();
    const tick = Pr.widen(r.u16(), this.lastBundleTick);
    const b = { tick, gone: [], ins: [], rcv: null, exits: [], enters: [], ords: [], corrs: [], rocks: [], rcorrs: [], rdead: [], late: [] };
    const CAT = { [R.IN]: 'inputs', [R.RCV]: 'inputs', [R.ENTER]: 'entries', [R.EXIT]: 'entries', [R.ROCK]: 'entries',
      [R.CORR]: 'corrections', [R.RCORR]: 'corrections', [R.RDEAD]: 'overrides', [R.LATE]: 'ticks', [R.PULL]: 'entries', [R.GONE]: 'shells', [R.ORD]: 'orders' };
    while (r.more()) {
      const k = r.u[r.o];
      r.mark(CAT[k] || 'other'); r.u8();
      if (k === R.IN) { const v = r.vu(); b.ins.push(Object.assign({ slot: Math.floor(v / 8) }, Pr.rInpDelta(r, v % 8))); }
      else if (k === R.RCV) b.rcv = r.u8();
      else if (k === R.EXIT) b.exits.push(r.vu());
      else if (k === R.ENTER) { const slot = r.vu(), pulled = r.u8(); b.enters.push(Object.assign({ slot, pulled: !!pulled }, Pr.rEntity(r, tick))); }
      else if (k === R.CORR) { const slot = r.vu(), reason = REASON[r.u8()], ago = r.u16(); b.corrs.push(Object.assign({ slot, reason, ago }, Pr.rEntity(r, tick))); }
      else if (k === R.ROCK) b.rocks.push(Pr.rRock(r, tick));
      else if (k === R.RCORR) { const reason = REASON[r.u8()], ago = r.u16(); b.rcorrs.push(Object.assign({ reason, ago }, Pr.rRock(r, tick))); }
      else if (k === R.RDEAD) b.rdead.push(r.vu());
      else if (k === R.LATE) b.late.push({ seq: r.u8(), by: r.u8() });
      else if (k === R.PULL) b.enters.push({ slot: r.vu(), pulled: !!r.u8(), flagOnly: true });
      else if (k === R.GONE) b.gone.push({ slot: r.vu(), n: r.u8(), kill: r.u8() });
      else if (k === R.ORD) b.ords.push({ slot: r.vu(), tgt: r.vu() });
      else break;
    }
    this.down.add(now, r.end(), Pr.wireBytes(buf.length, false));
    if (this.dropNext && (b.ins.length || b.ords.length) && !b.enters.length && !b.exits.length && !b.late.length && b.rcv === null) { this.dropNext = false; this.dropped++; return; }
    // Late inputs: the server used one later than stamped (from the tick after it arrived); it is used then here too,
    // and the margin gets room straight away
    for (const l of b.late) {
      const e = this.stream.find((x) => (x.seq & 255) === l.seq);
      if (e) e.target += l.by;
      this.st.late++; this.margin = Math.min(30, this.margin + Math.min(3, l.by)); this.slack = 0; this.lastLate = now;
    }
    // (taken now, not when this bundle's ticks are stepped: every late notice up to here has been applied above, so
    // for any tick up to this bundle's, an input the server had was used at its target and one it hadn't comes later)
    if (b.rcv !== null) this.rcv = Pr.widen8(b.rcv, this.rcv);
    this.lastBundleTick = tick;
    this.pending.push(b);
  }
  /** Your input the server used at tick t, if a new one: the newest it had (seq <= rcv) stamped for t or before */
  ownAt(t) {
    let s = null;
    for (const e of this.stream) { if (e.seq > this.rcv || e.target > t) break; s = e; }
    return s;
  }
  /** Step the confirmed world one tick: with bundle b's inputs (b null: a tick nothing changed in), then its records */
  stepConf(b, now) {
    const W = this.conf, inputs = new Map();
    if (b) for (const x of b.ins) {
      const uid = this.slots.get(x.slot), sh = uid !== undefined && W.byUid.get(uid);
      if (sh) inputs.set(uid, Pr.applyInp(sh.inp, x));
    }
    const own = this.ownAt(W.tick + 1);
    if (own) { inputs.set(this.uid, own.inp); this.stream = this.stream.filter((e) => e.seq > own.seq); }
    Wo.step(W, inputs);
    this.st.steps++;
    for (const e of W.events) {
      this.recent.set(e.tgt, W.tick); this.recent.set(e.by, W.tick);
      if (e.rock >= 0) this.reports.push({ kind: IDK.ROCK, id: e.rock, hash: Wo.eventHash8(e) });
      else { const s = this.slotOf.get(e.tgt); if (s !== undefined) this.reports.push({ kind: IDK.SLOT, id: s, hash: Wo.eventHash8(e) }); }
    }
    if (b) this.apply(b, now);
    if (W.tick % this.hashEvery === 0) {
      const list = [...this.slots.keys()].sort((a, c) => a - c).map((s) => { const e = W.byUid.get(this.slots.get(s)); return e ? Wo.fold8(Wo.entityHash(W, e)) : 0; });
      this.hashes = { tick: W.tick, list };
    }
    this.version++;
  }
  install(e, shells) {
    const W = this.conf;
    Wo.insertEntity(W, e);
    if (shells) Wo.setShellsOf(W, e.uid, shells);
  }
  apply(b, now) {
    const W = this.conf;
    for (const slot of b.exits) {
      const uid = this.slots.get(slot);
      if (uid === undefined) continue;
      Wo.removeEntity(W, uid); W.shells = W.shells.filter((p) => p.o !== uid);
      this.slots.delete(slot); this.slotOf.delete(uid); this.pulled.delete(uid); this.st.exits++;
    }
    for (const x of b.enters) {
      if (x.flagOnly) {
        // Pulled in / back in the radius, same slot
        const uid = this.slots.get(x.slot), e = uid !== undefined && W.byUid.get(uid);
        if (!e) continue;
        this.pulled.set(uid, x.pulled);
        continue;
      }
      const again = this.slots.get(x.slot) === x.ent.uid;
      this.install(x.ent, x.shells);
      this.slots.set(x.slot, x.ent.uid); this.slotOf.set(x.ent.uid, x.slot); this.pulled.set(x.ent.uid, x.pulled);
      if (!again) { this.st.entries++; if (x.pulled) this.st.pullIns++; }
    }
    // Orders: an AI's new target from the end of this tick (after the entries: the target may have just come in)
    for (const o of b.ords) {
      const sh = W.byUid.get(this.slots.get(o.slot));
      if (sh) sh.target = o.tgt ? this.slots.get(o.tgt - 1) ?? 0 : 0;
    }
    const setRock = (x) => {
      const R0 = W.rocks.list[x.id];
      if (!R0) return;
      if (x.hp === R0.hp && !x.dead) W.rockOv.delete(x.id); else W.rockOv.set(x.id, { hp: x.hp, dead: x.dead });
    };
    for (const x of b.rocks) setRock(x);
    for (const id of b.rdead) W.rockOv.set(id, { hp: 0, dead: b.tick });
    // Shells that hit something this client doesn't hold (named by shooter slot + shot number): gone here too
    for (const g of b.gone) {
      const uid = this.slots.get(g.slot);
      if (uid === undefined) continue;
      W.shells = W.shells.filter((p) => p.o !== uid || (p.n & 255) !== g.n);
      if (g.kill) { const s = W.byUid.get(uid); if (s) s.kills++; }
    }
    for (const x of b.corrs) {
      this.install(x.ent, x.shells);
      if (this.slots.get(x.slot) !== x.ent.uid) { this.slots.set(x.slot, x.ent.uid); this.slotOf.set(x.ent.uid, x.slot); }
      this.caught(x.reason, x.ent.uid, x.ago, now);
    }
    for (const x of b.rcorrs) { setRock(x); this.caught(x.reason, -1 - x.id, x.ago, now); }
  }
  caught(reason, key, ago, now) {
    this.st.corrections++; this.st.counts[reason] = (this.st.counts[reason] || 0) + 1;
    const inj = this.st.injected.find((i) => !i.done && i.key !== null && (i.key === key || i.related === key))
      || (reason !== 'unseen' && this.st.injected.find((i) => !i.done && i.kind === 'drop'));
    if (inj) inj.done = true;
    this.st.caught.push({ reason, key, ticks: ago, at: now, inj: inj ? inj.kind : null, fixMs: inj ? now - inj.t : null });
    if (this.st.caught.length > 40) this.st.caught.shift();
  }
  // --- every frame -----------------------------------------------------------------------------------------------
  frame(now) {
    this.nowRef = now;
    if (!this.ready) return;
    this.flushHeld(now);
    this.ping(now);
    // 1. Confirmed ticks: as many as have arrived, at most CATCHUP a frame (a client that fell behind runs faster)
    let n = 0;
    while (this.pending.length && n < CATCHUP) {
      const b = this.pending[0];
      if (this.conf.tick >= b.tick) { this.pending.shift(); continue; }
      if (this.conf.tick < b.tick - 1) this.stepConf(null, now);
      else { this.stepConf(b, now); this.pending.shift(); }
      n++;
    }
    if (n > 1) this.st.catchup = Math.max(this.st.catchup, n);
    // 2. Input: stamped for the tick it will reach the server at (its tick now + the trip + the margin)
    let smp = null;
    if (this.clock.ready()) smp = this.sampleInput(now);
    let input = null;
    if (smp) {
      let target = this.stampTick(now);
      if (target < this.lastTarget) target = this.lastTarget;
      this.lastTarget = target;
      this.stream.push({ seq: smp.inp.seq, target, inp: smp.inp });
      this.delays[this.predOn ? 'on' : 'off'].note(smp.changes, smp.inp.seq);
      input = { target, inp: smp.inp };
    }
    // 3. One message up: the input, what this client saw happen (reports), state hashes, and how far it has got (ack)
    const ack = this.conf.tick;
    if (input || this.reports.length || this.hashes || ack - this.lastAckSent >= HEARTBEAT_UP) {
      const buf = this.encUp(ack & 0xFFFF, input, this.reports.slice(0, 200), this.hashes);
      this.st.reported += Math.min(200, this.reports.length);
      if (this.hashes) this.st.hashSent++;
      this.reports = this.reports.slice(200); this.hashes = null; this.lastAckSent = ack;
      this.send(buf, now);
    }
    // 4. The screen
    this.display(now);
  }
  stampTick(now) { return Math.floor(this.clock.tick(now) + this.clock.srtt / 2 / TICK_MS) + 1 + this.margin; }
  /** The tick the screen shows, and the world at it (the confirmed world, run forward) */
  display(now) {
    const C = this.conf.tick, est = this.clock.tick(now);
    // (a toggle strands inputs waiting in the other meter: drop them rather than count them seconds later)
    if (this.predOn !== this.lastPred) { this.delays.on.pending = []; this.delays.off.pending = []; this.lastPred = this.predOn; }
    // (with prediction on, never behind your newest stamped input, even while the clock estimate settles)
    let Dt = this.predOn ? Math.max(this.stampTick(now), this.lastTarget) : Math.floor(est - this.clock.srtt / 2 / TICK_MS);
    this.behind = Math.max(0, Math.floor(est - this.clock.srtt / 2 / TICK_MS) - C);
    this.st.maxBehind = Math.max(this.st.maxBehind, this.behind);
    Dt = Math.max(C, Math.min(Dt, C + MAXPRED));
    if (!this.pred || this.predVer !== this.version || this.pred.tick > Dt) {
      this.pred = Wo.cloneWorld(this.conf); this.predVer = this.version; this.st.resimLast = 0;
    }
    while (this.pred.tick < Dt) {
      const t = this.pred.tick + 1, inputs = new Map();
      // Your inputs at the ticks they are stamped for (where the server uses them, unless one arrives late). With own
      // prediction on the screen runs ahead to your newest stamp; off, it stays at the newest tick that should have
      // arrived, so an input shows when its tick does
      let mine = null;
      for (const e of this.stream) if (e.target <= t) mine = e; else break;
      if (mine) inputs.set(this.uid, mine.inp);
      Wo.step(this.pred, inputs);
      this.st.resim++; this.st.resimLast++;
      for (const e of this.pred.events) {
        const k = `${e.T}:${e.tgt}:${e.rock}:${e.by}`;
        if (this.seenFx.has(k)) continue;
        this.seenFx.add(k); this.sparks.push({ x: e.x / FX, y: e.y / FX, at: now, kill: e.kill });
      }
    }
    if (this.seenFx.size > 600) this.seenFx = new Set([...this.seenFx].slice(-300));
    this.dispTick = this.pred.tick;
    const me = this.pred.byUid.get(this.uid);
    if (me) this.delays[this.predOn ? 'on' : 'off'].shown(me.seq, now);
  }
  // --- debug: knock this client's copy of the world off the server's ----------------------------------------------
  inject(kind, now) {
    const W = this.conf;
    if (!W) return null;
    const me = W.byUid.get(this.uid), others = W.ships.filter((s) => s.uid !== this.uid && !s.dead);
    const near = (list) => list.sort((a, b) => Math.hypot(a.x - me.x, a.y - me.y) - Math.hypot(b.x - me.x, b.y - me.y))[0];
    let tgt = null, related = null;
    if (kind === 'hp' || kind === 'away') {
      // The ship most recently hit (it will be hit again), else the nearest
      tgt = others.slice().sort((a, b) => (this.recent.get(b.uid) || 0) - (this.recent.get(a.uid) || 0))[0];
      if (!tgt) return null;
      if (kind === 'hp') tgt.hp = Math.max(1, tgt.hp - 7);
      else { const d = Math.hypot(tgt.x - me.x, tgt.y - me.y) || 1; tgt.x += Math.round((tgt.x - me.x) / d * 400 * FX); tgt.y += Math.round((tgt.y - me.y) / d * 400 * FX); }
    } else if (kind === 'into') {
      // Put a ship in front of a live shell that isn't its own: this copy sees a hit the server never had
      for (const p of W.shells) {
        const s = others.find((o) => o.uid !== p.o && Wo.team(o) !== p.tm && p.life > 6);
        if (!s) continue;
        s.x = p.x + p.vx * 3; s.y = p.y + p.vy * 3; s.vx = p.vx >> 4; s.vy = p.vy >> 4;
        tgt = s; related = p.o; break;
      }
      if (!tgt) return null;
    } else if (kind === 'silent') {
      // Something nothing is happening to: only the background hash can catch this one
      const quiet = [...W.ships, ...W.loot].filter((e) => e.uid !== this.uid && W.tick - (this.recent.get(e.uid) || -1e9) > 240
        && !W.shells.some((p) => Math.hypot(p.x - e.x, p.y - e.y) < 600 * FX));
      tgt = quiet.length ? near(quiet) : null;
      if (!tgt) return null;
      tgt.x += FX;
    } else if (kind === 'drop') { this.dropNext = true; this.st.injected.push({ kind, key: null, t: now, tick: W.tick }); return { kind }; }
    else if (kind === 'delay') { this.holdUntil = now + 500; this.st.injected.push({ kind, key: null, t: now, tick: W.tick, done: true }); return { kind }; }
    this.version++;
    const rec = { kind, key: tgt.uid, related, slot: this.slotOf.get(tgt.uid), t: now, tick: W.tick };
    this.st.injected.push(rec);
    return rec;
  }
  // --- for the page ----------------------------------------------------------------------------------------------
  view(now) {
    const W = this.pred || this.conf;
    if (!W) return null;
    const ships = W.ships.map((s) => ({ uid: s.uid, kind: s.kind, x: s.x / FX, y: s.y / FX, a: s.a, tur: s.tur, hp: s.hp, dead: s.dead,
      kills: s.kills, deaths: s.deaths, cargo: s.cargo, boost: s.boost, slot: this.slotOf.get(s.uid), pulled: this.pulled.get(s.uid) }));
    const shells = W.shells.map((p) => ({ x: p.x / FX, y: p.y / FX, vx: p.vx / FX, vy: p.vy / FX, o: p.o, mine: p.o === this.uid }));
    const loot = W.loot.map((l) => ({ uid: l.uid, x: l.x / FX, y: l.y / FX, slot: this.slotOf.get(l.uid), pulled: this.pulled.get(l.uid) }));
    this.sparks = this.sparks.filter((k) => now - k.at < 300);
    const ghost = this.conf && this.conf !== W ? this.conf.ships.map((s) => ({ uid: s.uid, kind: s.kind, x: s.x / FX, y: s.y / FX, a: s.a, dead: s.dead })) : null;
    return { me: this.uid, ships, shells, loot, rockOv: W.rockOv, sparks: this.sparks, ghost, rocks: W.rocks, aware: this.C };
  }
  stats(now) {
    return { mode: 'lockstep', rtt: this.clock.srtt, jit: this.clock.jit, serverTick: this.clock.tick(now), confTick: this.conf ? this.conf.tick : 0,
      dispTick: this.dispTick, stampTick: this.clock.ready() ? this.stampTick(now) : 0, margin: this.margin, predOn: this.predOn,
      behind: this.behind, queued: this.pending.length, slots: this.slots.size, delays: this.delays, down: this.down.rate(now), up: this.up.rate(now),
      downTot: this.down.totals(), upTot: this.up.totals(), dropped: this.dropped, holding: this.held.length, st: this.st, info: this.info };
  }
}

// ===================================================================================================== current style
const SNAP_UNITS = 260;
class CurClient extends BaseClient {
  constructor(opts) {
    super(opts);
    this.curDelay = opts.curDelay ?? 2;
    this.ship = null; this.pt = 0; this.hist = new Map(); this.queue = []; this.cur = Sim.NEUTRAL;
    this.own = new Map(); this.shells = new Map(); this.snaps = []; this.rockOv = new Map(); this.lead = 1; this.interp = 120;
    this.ox = 0; this.oy = 0; this.delay = new DelayMeter(); this.sparks = [];
    this.st = { corrections: 0, snaps: 0, lastErr: 0, maxErr: 0, replayed: 0, snapsIn: 0 };
  }
  start() { this.hello('current'); }
  welcome(m) { this.uid = m.uid; this.seed = m.seed; this.rocks = Wo.rocksFor(m.seed); this.C = m.C; this.ready = true; this.t0tick = m.tick; }
  updateLead() {
    const want = (this.clock.srtt / 2 + this.clock.jit * 2) / TICK_MS + 0.5;
    if (want > this.lead + 0.3 || want < this.lead - 1.3) this.lead = Math.max(1, Math.min(15, Math.ceil(want)));
    const base = this.clock.srtt < 60 ? 80 : 110;
    const target = Math.max(80, Math.max(base, Math.min(520, this.clock.srtt * 0.7 + this.clock.jit * 4 + 90)));
    this.interp += Math.max(-1.5, Math.min(1.5, target - this.interp));
  }
  frame(now) {
    this.nowRef = now;
    if (!this.ready) return;
    this.flushHeld(now);
    this.ping(now);
    if (!this.clock.ready() || !this.ship) return;
    this.updateLead();
    const smp = this.sampleInput(now);
    if (smp) {
      const target = this.pt + 1 + this.curDelay;
      this.delay.note(smp.changes, smp.inp.seq);
      this.queue.push({ target, inp: smp.inp });
      this.send(this.encUp(0, { target, inp: smp.inp }), now);
    }
    const goal = Math.floor(this.clock.tick(now)) + this.lead;
    if (goal - this.pt > 30) this.pt = goal - 1;
    while (this.pt < goal) this.stepPred();
    this.dispTick = this.pt;
  }
  stepPred() {
    const nt = this.pt + 1;
    while (this.queue.length && this.queue[0].target <= nt) this.cur = this.queue.shift().inp;
    const out = [];
    Wo.stepAlone(this.ship, this.cur, nt, out);
    for (const p of out) this.own.set(p.id, p);
    this.pt = nt;
    this.hist.set(nt, { ship: Object.assign({}, this.ship), inp: this.cur });
  }
  binary(buf, now) {
    if (buf[0] !== Pr.T.SNAP) return;
    const r = new Pr.Reader(buf), d = Pr.decSnap(r);
    this.down.add(now, r.cats, Pr.wireBytes(buf.length, false));
    this.st.snapsIn++;
    this.delay.acked(Pr.widen(d.ack, this.seq), now);
    const srv = d.me;
    if (!this.ship) { this.ship = srv; this.pt = d.tick; this.hist.clear(); }
    else {
      const h = this.hist.get(d.tick);
      if (!h) { if (d.tick >= this.pt) { this.ship = srv; this.pt = d.tick; this.hist.clear(); } }
      else if (!sameFlight(h.ship, srv)) {
        const bx = this.ship.x, by = this.ship.y;
        this.ship = srv;
        for (let tt = d.tick + 1; tt <= this.pt; tt++) {
          const e = this.hist.get(tt), out = [];
          if (!e) break;
          Wo.stepAlone(this.ship, e.inp, tt, out);
          for (const p of out) this.own.set(p.id, p);
          e.ship = Object.assign({}, this.ship);
          this.st.replayed++;
        }
        const ex = (bx - this.ship.x) / FX, ey = (by - this.ship.y) / FX, err = Math.hypot(ex, ey);
        this.st.corrections++; this.st.lastErr = err; this.st.maxErr = Math.max(this.st.maxErr, err);
        if (err > SNAP_UNITS) { this.st.snaps++; this.ox = this.oy = 0; } else { this.ox += ex; this.oy += ey; }
      }
    }
    for (const k of this.hist.keys()) { if (k < d.tick) this.hist.delete(k); else break; }
    this.snaps.push({ tick: d.tick, rows: new Map(d.rows.map((s) => [s.uid, s])), loot: d.loot });
    while (this.snaps.length > 2 && this.snaps[1].tick < d.tick - 120) this.snaps.shift();
    for (const p of d.fires) this.shells.set(p.id, p);
    for (const h of d.hits) {
      const p = [...this.shells.values(), ...this.own.values()].find((s) => Math.abs((s.x + s.vx * (h.T - s.t0)) / FX - h.x) < 40 && Math.abs((s.y + s.vy * (h.T - s.t0)) / FX - h.y) < 40 && s.o === h.by);
      if (p) p.end = h.T;
      this.sparks.push({ x: h.x, y: h.y, showTick: h.T, own: h.by === this.uid, at: 0, kill: h.kill });
    }
    for (const x of d.rocks) {
      const R0 = this.rocks.list[x.id];
      if (x.hp === R0.hp && !x.dead) this.rockOv.delete(x.id); else this.rockOv.set(x.id, { hp: x.hp, dead: x.dead });
    }
  }
  othersAt(rt) {
    const sn = this.snaps;
    if (!sn.length) return { ships: [], loot: [] };
    let i = sn.length - 1;
    while (i > 0 && sn[i].tick > rt) i--;
    const a = sn[i], b = sn[Math.min(i + 1, sn.length - 1)];
    const f = b.tick > a.tick ? Math.max(0, Math.min(1, (rt - a.tick) / (b.tick - a.tick))) : 0;
    const ships = [];
    for (const [uid, s] of a.rows) {
      const o = b.rows.get(uid) || s;
      if (s.dead || o.dead || Math.hypot(o.x - s.x, o.y - s.y) > 400) { ships.push(f < 0.5 ? s : o); continue; }
      ships.push(Object.assign({}, s, { x: s.x + (o.x - s.x) * f, y: s.y + (o.y - s.y) * f, a: (s.a + Sim.wrapBA(o.a - s.a) * f) & 0xFFFF, tur: s.tur + (o.tur - s.tur) * f }));
    }
    return { ships, loot: (f < 0.5 ? a : b).loot };
  }
  view(now, dt = 16.7) {
    if (!this.ship) return null;
    const k = Math.pow(0.82, dt / 16.7); this.ox *= k; this.oy *= k;
    const rt = this.clock.tick(now) - this.interp / TICK_MS;
    this.delay.shown(this.ship.seq, now);
    const sh = this.ship, o = this.othersAt(rt);
    const ships = [{ uid: sh.uid, kind: 'player', x: sh.x / FX + this.ox, y: sh.y / FX + this.oy, a: sh.a, tur: sh.tur, hp: sh.hp, dead: sh.dead, kills: sh.kills, deaths: sh.deaths, cargo: sh.cargo, boost: sh.boost }];
    for (const s of o.ships) ships.push(s);
    const shells = [];
    for (const [id, p] of this.own) {
      const age = this.pt - p.t0;
      if (age >= p.life || (p.end !== undefined && this.pt >= p.end)) { if (age > p.life + 60 || p.end !== undefined) this.own.delete(id); continue; }
      shells.push({ x: (p.x + p.vx * age) / FX, y: (p.y + p.vy * age) / FX, vx: p.vx / FX, vy: p.vy / FX, o: p.o, mine: true });
    }
    for (const [id, p] of this.shells) {
      const age = rt - p.t0;
      if (age >= p.life || (p.end !== undefined && rt >= p.end)) { if (age > p.life + 60 || (p.end !== undefined && rt >= p.end)) this.shells.delete(id); continue; }
      if (age < 0) continue;
      shells.push({ x: (p.x + p.vx * age) / FX, y: (p.y + p.vy * age) / FX, vx: p.vx / FX, vy: p.vy / FX, o: p.o });
    }
    for (const s of this.sparks) if (!s.at && (s.own ? this.pt : rt) >= s.showTick) s.at = now;
    this.sparks = this.sparks.filter((s) => !s.at || now - s.at < 300);
    return { me: this.uid, ships, shells, loot: o.loot, rockOv: this.rockOv, sparks: this.sparks.filter((s) => s.at), ghost: null, rocks: this.rocks, aware: this.C };
  }
  stats(now) {
    return { mode: 'current', rtt: this.clock.srtt, jit: this.clock.jit, serverTick: this.clock.tick(now), dispTick: this.pt, lead: this.lead,
      interp: this.interp, delay: this.delay, down: this.down.rate(now), up: this.up.rate(now), downTot: this.down.totals(), upTot: this.up.totals(),
      st: this.st, info: this.info };
  }
}
function sameFlight(a, b) {
  return a.x === b.x && a.y === b.y && a.vx === b.vx && a.vy === b.vy && a.a === b.a && a.av === b.av && a.tur === b.tur &&
    a.gcd === b.gcd && a.tcd === b.tcd && a.hp === b.hp && a.dead === b.dead && a.boost === b.boost;
}

NL.LabClient = { LsClient, CurClient, Clock, DelayMeter, CatMeter, TICK_MS };
if (typeof module === 'object' && module.exports) module.exports = NL;
})(globalThis.NL = globalThis.NL || {});
