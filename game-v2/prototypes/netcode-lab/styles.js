// Netcode Lab: the three network styles, each a server and two clients over the pretend network.
//
//   current  - the game today: the server runs the world; your client predicts your own ship from your inputs and checks
//              it against each snapshot (replaying when it was wrong); everyone else is drawn a little in the past,
//              between snapshots; your shots appear at once (predicted).
//   lockstep - every client runs the whole world; only inputs travel (through the server, which relays them). Your input
//              sampled at tick T is used at tick T + D for everyone, you included, and a client only steps a tick once it
//              has every player's input for it. The screen shows confirmed ticks only: no prediction at all.
//   rollback - lockstep inputs, but the client runs ahead to the present guessing the other player's missing inputs (the
//              last one repeated); when a real input differs from the guess it rewinds to the last confirmed tick and
//              replays (GGPO style). Your own input applies after a small fixed delay.
//
// A World owns one style's server and clients, the links between them and the clock, and runs them in time order.
(function (NL) {
'use strict';
const { Sim, Net } = NL;
const { IN, NEUTRAL } = Sim;
const FX = Sim.FX;

// ---------------------------------------------------------------------------------------------------- ping / RTT
/** Pings every 500 ms; smoothed round trip and jitter (as the game's GameState does) */
class Pinger {
  /** (Starts from the configured round trip, as if the lobby had measured it, so the first second isn't all corrections) */
  constructor(guess = 0) { this.last = -1e9; this.srtt = guess; this.jit = 0; this.n = 0; }
  due(t) { if (t - this.last < 500) return false; this.last = t; return true; }
  sample(rtt) {
    if (!this.n++) { this.srtt = rtt; return; }
    this.jit += 0.2 * (Math.abs(rtt - this.srtt) - this.jit);
    this.srtt += 0.2 * (rtt - this.srtt);
  }
}

// --------------------------------------------------------------------------------------------- delay measurement
/**
 * Input-to-screen delay. Each sampled input that changes thrust, turning or firing is remembered with the time of the
 * key/mouse event behind it. When a frame is drawn from a simulation state that has applied that input (the state's
 * `seq` for your ship has reached it), the time from the event to that frame is the delay.
 */
class DelayMeter {
  constructor(tickMs) { this.tickMs = tickMs; this.pending = []; this.res = { thrust: [], turn: [], fire: [] }; this.confirm = []; this.pendingAck = []; }
  note(changes, seq) { for (const c of changes) { this.pending.push({ kind: c.kind, t: c.t, seq }); this.pendingAck.push({ t: c.t, seq }); } if (this.pending.length > 200) this.pending.splice(0, 100); if (this.pendingAck.length > 200) this.pendingAck.splice(0, 100); }
  /** A frame drew a state that has applied input `seq` */
  shown(seq, now) {
    while (this.pending.length && this.pending[0].seq <= seq) {
      const p = this.pending.shift(), ms = now - p.t, r = this.res[p.kind];
      r.push(ms); if (r.length > 40) r.shift();
    }
  }
  /** The server's state has applied input `seq` (current style: the snapshot that shows it arrived) */
  acked(seq, now) {
    while (this.pendingAck.length && this.pendingAck[0].seq <= seq) {
      const p = this.pendingAck.shift();
      this.confirm.push(now - p.t); if (this.confirm.length > 40) this.confirm.shift();
    }
  }
}

// ------------------------------------------------------------------------------------------------------- the bot
/** The other player: a scripted pilot that orbits you, shoots in bursts and boosts now and then, from what its own client sees */
class Bot {
  constructor(cfg) { this.cfg = cfg; this.seq = 0; }
  sample(t, client) {
    const sec = (t - client.w.t0) / 1000;
    const me = client.viewSelf(), tg = client.viewTarget();
    let b = 0, aim = 0, dist = 400;
    if (me && tg) {
      const th = sec * 0.5, wx = tg.x + 650 * Math.cos(th) - me.x, wy = tg.y + 650 * Math.sin(th) - me.y;
      if (wx > 80) b |= IN.D; else if (wx < -80) b |= IN.A;
      if (wy > 80) b |= IN.S; else if (wy < -80) b |= IN.W;
      const dx = tg.x - me.x, dy = tg.y - me.y;
      dist = Math.hypot(dx, dy);
      aim = Net.quantAim(Math.round(Math.atan2(dy, dx) * Sim.RAD) & 0xFFFF);
      if (this.cfg.botFires && dist < 1500) {
        if (sec % 3 < 1.4) b |= IN.GUN;
        if (dist < 1200) b |= IN.TURRET;
      }
      if (sec % 7 < 0.7) b |= IN.BOOST;
    }
    return { inp: { b, aim, dist: Net.quantDist(dist), seq: ++this.seq }, changes: [] };
  }
}

// =================================================================================================== current style
class AuthServer {
  constructor(w) {
    this.w = w; this.s = Sim.create(w.P, w.seed, w.cfg);
    this.q = [[], []]; this.held = [NEUTRAL, NEUTRAL]; this.lastSeq = [0, 0]; this.late = [0, 0]; this.rtt = [0, 0];
    this.pend = [{ fires: [], hits: [] }, { fires: [], hits: [] }];
    this.snapEvery = Math.max(1, Math.round(w.cfg.tickRate / w.cfg.snapRate));
  }
  recv(cid, buf, t) {
    const v = Net.view(buf), type = v.getUint8(0);
    if (type === Net.T.INPUT) {
      const d = Net.decInput(v, this.lastSeq[cid], this.s.tick);
      this.lastSeq[cid] = Math.max(this.lastSeq[cid], d.seq);
      // Late (its tick is already simulated): the server uses it from the next tick; the client finds out at the next snapshot
      if (d.target <= this.s.tick) { this.late[cid]++; d.target = this.s.tick + 1; }
      const q = this.q[cid];
      let i = q.length; while (i > 0 && q[i - 1].target > d.target) i--;
      q.splice(i, 0, d);
    } else if (type === Net.T.PING) {
      const p = Net.decPing(v); this.rtt[cid] = p.rtt;
      this.w.toClient(cid, t, Net.encPong(p.t, this.s.tick, Math.max(...this.rtt)));
    }
  }
  tick(n, t) {
    const s = this.s;
    for (let cid = 0; cid < 2; cid++) { const q = this.q[cid]; while (q.length && q[0].target <= s.tick + 1) this.held[cid] = q.shift().inp; }
    Sim.step(s, this.held, this.w.P);
    for (const e of s.events) {
      if (e.k === 'fire') {
        const p = e.shot, copy = { o: p.o, gun: p.gun, t0: p.t0, x: p.x, y: p.y, vx: p.vx, vy: p.vy, life: p.life, dmg: p.dmg };
        for (let cid = 0; cid < 2; cid++) if (p.o !== cid) this.pend[cid].fires.push(copy);   // your own shots you predicted
      } else for (let cid = 0; cid < 2; cid++) this.pend[cid].hits.push(e);
    }
    if (s.tick % this.snapEvery === 0) {
      for (let cid = 0; cid < 2; cid++) {
        const pd = this.pend[cid];
        this.w.toClient(cid, t, Net.encSnap(s.tick, s.ships[cid].seq, cid, s.ships, pd.fires.splice(0, 255), pd.hits.splice(0, 255)));
      }
    }
  }
}

const SNAP_UNITS = 260;   // the game's SNAP_THRESHOLD: a correction this big teleports instead of easing in

class PredClient {
  constructor(w, cid, src) {
    this.w = w; this.cid = cid; this.src = src; this.P = w.P;
    this.ship = Sim.cloneShip(Sim.create(w.P, w.seed, w.cfg).ships[cid]);
    this.pt = 0;                 // predicted tick
    this.hist = new Map();       // tick -> { ship, inp } as predicted
    this.queue = []; this.cur = NEUTRAL; this.seq = 0;
    this.own = new Map();        // own predicted shells by id
    this.shells = new Map();     // others' shells by id (from fire events)
    this.snaps = [];             // others' poses by snapshot, for interpolation
    this.ping = new Pinger(2 * w.cfg.lat[cid]); this.lead = 1; this.interp = 120;
    this.ox = 0; this.oy = 0;    // visual error being eased out after a correction
    this.st = { corrections: 0, snaps: 0, lastErr: 0, maxErr: 0, replayed: 0 };
    this.delay = new DelayMeter(w.tickMs); this.latest = null; this.sparks = [];
  }
  updateLead() {
    // GameState.updateLead: the trip plus a jitter margin, moved only when it is more than a tick out
    const want = (this.ping.srtt / 2 + this.ping.jit * 2) / this.w.tickMs + 0.5;
    if (want > this.lead + 0.3 || want < this.lead - 1.3) this.lead = Math.max(1, Math.min(15, Math.ceil(want)));
    // GameState: the interpolation delay for other ships
    const base = this.ping.srtt < 60 ? 80 : 110;
    const target = Math.max(80, Math.max(base, Math.min(520, this.ping.srtt * 0.7 + this.ping.jit * 4 + 90)));
    this.interp += Math.max(-1.5, Math.min(1.5, target - this.interp));   // ~90 ms a second at 60 Hz
  }
  tick(n, t) {
    if (this.ping.due(t)) this.w.toServer(this.cid, t, Net.encPing(t, this.ping.srtt));
    this.updateLead();
    const smp = this.src.sample(t, this), inp = smp.inp;
    // Sent only when it differs from the last one sent (the game's inputSend.ts); the server keeps using the last one
    if (!this.sent || !Sim.sameInput(inp, this.sent)) {
      inp.seq = ++this.seq;
      this.delay.note(smp.changes, inp.seq);
      // Stamp for the tick it will be used at: the next step plus the input delay (GameState.inputDelayTicks)
      const target = this.pt + 1 + this.w.cfg.curDelay;
      this.w.toServer(this.cid, t, Net.encInput(inp.seq, target, inp));
      this.queue.push({ target, inp });
      this.sent = inp;
    }
    const goal = n + this.lead;
    if (goal - this.pt > 30) this.pt = goal - 1;    // far adrift: jump (a correction will follow)
    while (this.pt < goal) this.stepPred();
  }
  stepPred() {
    const nt = this.pt + 1;
    while (this.queue.length && this.queue[0].target <= nt) this.cur = this.queue.shift().inp;
    const out = [];
    Sim.stepOne(this.ship, this.cur, this.P, nt, out);
    for (const p of out) this.own.set(p.id, p);
    this.pt = nt;
    this.hist.set(nt, { ship: Sim.cloneShip(this.ship), inp: this.cur });
  }
  recv(buf, t) {
    const v = Net.view(buf), type = v.getUint8(0);
    if (type === Net.T.PONG) { const p = Net.decPong(v); this.ping.sample(t - p.t); return; }
    if (type !== Net.T.SNAP) return;
    const d = Net.decSnap(v, this.seq);
    this.latest = d;
    this.delay.acked(d.ack, t);
    // --- Your ship: was the prediction for this tick right?
    const h = this.hist.get(d.tick), srv = Object.assign(Sim.cloneShip(this.ship), d.me);
    if (!h) {
      if (d.tick >= this.pt) { this.ship = srv; this.pt = d.tick; this.hist.clear(); }
    } else if (!Sim.shipEqual(h.ship, srv)) {
      const bx = this.ship.x, by = this.ship.y;
      this.ship = srv;
      for (let tt = d.tick + 1; tt <= this.pt; tt++) {
        const e = this.hist.get(tt), out = [];
        Sim.stepOne(this.ship, e.inp, this.P, tt, out);
        for (const p of out) this.own.set(p.id, p);
        e.ship = Sim.cloneShip(this.ship);
        this.st.replayed++;
      }
      const ex = (bx - this.ship.x) / FX, ey = (by - this.ship.y) / FX, err = Math.hypot(ex, ey);
      this.st.corrections++; this.st.lastErr = err; this.st.maxErr = Math.max(this.st.maxErr, err);
      if (err > SNAP_UNITS) { this.st.snaps++; this.ox = this.oy = 0; } else { this.ox += ex; this.oy += ey; }
    }
    for (const k of this.hist.keys()) if (k < d.tick) this.hist.delete(k);
    // --- Everyone else: kept for drawing between snapshots
    this.snaps.push({ tick: d.tick, ships: d.others });
    while (this.snaps.length > 2 && this.snaps[1].tick < d.tick - 120) this.snaps.shift();
    for (const p of d.fires) this.shells.set(p.id, p);
    for (const hgt of d.hits) {
      const p = this.shells.get(hgt.id) || this.own.get(hgt.id);
      if (!p) continue;
      p.end = hgt.tick;
      // (Shown when the timeline that shell is drawn on gets to the hit; your own already flashed where you saw them hit)
      const age = hgt.tick - p.t0;
      if (!p.gone) this.sparks.push({ x: (p.x + p.vx * age) / FX, y: (p.y + p.vy * age) / FX, showTick: hgt.tick, ownTimeline: p.o === this.cid, at: 0 });
    }
  }
  viewSelf() { return { x: this.ship.x / FX, y: this.ship.y / FX }; }
  viewTarget() {
    const last = this.snaps[this.snaps.length - 1];
    const o = last && last.ships.find((s) => s.id === 1 - this.cid);
    return o && !o.dead ? o : null;
  }
  /** Other ships at render tick rt, between the two snapshots around it */
  othersAt(rt) {
    const sn = this.snaps;
    if (!sn.length) return [];
    let i = sn.length - 1;
    while (i > 0 && sn[i].tick > rt) i--;
    const a = sn[i], b = sn[Math.min(i + 1, sn.length - 1)];
    const f = b.tick > a.tick ? Math.max(0, Math.min(1, (rt - a.tick) / (b.tick - a.tick))) : 0;
    return a.ships.map((s) => {
      const o = b.ships.find((q) => q.id === s.id) || s;
      if (s.dead || o.dead || Math.hypot(o.x - s.x, o.y - s.y) > 400) return f < 0.5 ? s : o;   // respawns jump
      return Object.assign({}, s, { x: s.x + (o.x - s.x) * f, y: s.y + (o.y - s.y) * f,
        a: (s.a + Sim.wrapBA(o.a - s.a) * f) & 0xFFFF, tur: s.tur + (o.tur - s.tur) * f });
    });
  }
  view(now, dt) {
    const k = Math.pow(0.82, dt / 16.7); this.ox *= k; this.oy *= k;
    const tickF = (now - this.w.t0) / this.w.tickMs, rt = tickF - this.interp / this.w.tickMs;
    this.delay.shown(this.ship.seq, now);
    const sh = this.ship, ships = [];
    ships.push({ id: sh.id, kind: sh.kind, x: sh.x / FX + this.ox, y: sh.y / FX + this.oy, a: sh.a, tur: sh.tur, hp: sh.hp, dead: sh.dead, boost: sh.boost, kills: sh.kills, deaths: sh.deaths });
    const others = this.othersAt(rt);
    for (const o of others) ships.push(Object.assign({ kind: o.id < Sim.N_PLAYERS ? 'player' : 'drone' }, o));
    const shells = [];
    // Your shells on your (predicted) timeline; a hit on what you see removes them at once (cosmetic: the server decides)
    for (const [id, p] of this.own) {
      const age = this.pt - p.t0;
      if (age >= p.life || (p.end !== undefined && this.pt >= p.end) || p.gone) { if (age > p.life + 60 || p.gone) this.own.delete(id); continue; }
      const x = (p.x + p.vx * age) / FX, y = (p.y + p.vy * age) / FX;
      for (const o of others) if (!o.dead && Math.hypot(o.x - x, o.y - y) < (o.id < Sim.N_PLAYERS ? 32 : 28)) { p.gone = true; this.sparks.push({ x, y, at: now }); }
      if (!p.gone) shells.push({ x, y, vx: p.vx / FX, vy: p.vy / FX, o: p.o });
    }
    // Everyone else's on the interpolated timeline, like their ships
    for (const [id, p] of this.shells) {
      const age = rt - p.t0;
      if (age >= p.life || (p.end !== undefined && rt >= p.end)) { if (age > p.life + 60 || (p.end !== undefined && rt >= p.end)) this.shells.delete(id); continue; }
      if (age < 0) continue;
      shells.push({ x: (p.x + p.vx * age) / FX, y: (p.y + p.vy * age) / FX, vx: p.vx / FX, vy: p.vy / FX, o: p.o });
    }
    for (const s of this.sparks) if (!s.at && (s.ownTimeline ? this.pt : rt) >= s.showTick) s.at = now;
    this.sparks = this.sparks.filter((s) => !s.at || now - s.at < 250);
    const sparks = this.sparks.filter((s) => s.at);
    return { ships, shells, sparks, me: this.cid, displayTick: this.pt, othersTick: rt };
  }
  stats(now) {
    const srv = this.w.server;
    return Object.assign({ style: 'current', rtt: this.ping.srtt, jit: this.ping.jit, lead: this.lead, interp: this.interp,
      late: srv.late[this.cid], predTick: this.pt, serverTick: srv.s.tick, delay: this.delay }, this.st);
  }
}

// ================================================================================================ lockstep / rollback
class RelayServer {
  constructor(w) {
    this.w = w; this.s = Sim.create(w.P, w.seed, w.cfg); this.D0 = w.D0;
    this.inputs = [new Map(), new Map()]; this.known = [w.D0, w.D0]; this.rtt = [0, 0]; this.hashes = new Map(); this.late = [0, 0];
  }
  recv(cid, buf, t) {
    const v = Net.view(buf), type = v.getUint8(0);
    if (type === Net.T.LOCK) {
      const d = Net.decLock(v);
      d.list.forEach((inp, i) => this.inputs[cid].set(d.first + i, inp));
      this.known[cid] = Math.max(this.known[cid], d.first + d.list.length - 1);
      for (let o = 0; o < 2; o++) if (o !== cid) this.w.toClient(o, t, Net.encRelay(cid, d.first, d.list));
      this.advance(this.w.wallTick(t));
    } else if (type === Net.T.PING) {
      const p = Net.decPing(v); this.rtt[cid] = p.rtt;
      this.w.toClient(cid, t, Net.encPong(p.t, this.s.tick, Math.max(...this.rtt)));
    }
  }
  tick(n) { this.advance(n); }
  advance(W) {
    const s = this.s;
    while (s.tick < W && this.known[0] > s.tick && this.known[1] > s.tick) {
      const tt = s.tick + 1;
      Sim.step(s, [inputAt(this, 0, tt), inputAt(this, 1, tt)], this.w.P);
      this.hashes.set(s.tick, Sim.hash(s));
      for (const m of this.inputs) m.delete(tt - 1);
    }
  }
}
function inputAt(o, p, tt) { return o.inputs[p].get(tt) || NEUTRAL; }

class LockClient {
  constructor(w, cid, src, rollback) {
    this.w = w; this.cid = cid; this.src = src; this.rb = rollback; this.P = w.P;
    this.inputs = [new Map(), new Map()]; this.known = [w.D0, w.D0]; this.lastTarget = w.D0;
    this.conf = Sim.create(w.P, w.seed, w.cfg); this.hashes = new Map();
    this.D = rollback ? w.cfg.rbDelay : w.D0;
    this.ping = new Pinger(2 * w.cfg.lat[cid]); this.maxRtt = 0; this.seq = 0;
    this.st = { stalls: 0, stallTicks: 0, stallMs: 0, stalled: false, rollbacks: 0, depthSum: 0, maxDepth: 0, lastDepth: 0, resim: 0, popErr: 0, maxPop: 0 };
    this.stallSince = 0;
    this.pred = null; this.guess = new Map(); this.dirty = Infinity;
    this.delay = new DelayMeter(w.tickMs); this.sparks = []; this.seenHits = new Set();
  }
  autoD() {
    const c = this.w.cfg;
    if (this.rb) return c.rbDelay;
    if (!c.lockAuto) return c.lockDelay;
    if (!this.ping.n) return this.D;
    // Your input must reach the other player before they get to its tick: your half of the trip plus theirs (through the
    // server), plus room for jitter, plus a tick for sampling. (The server tells everyone the worst round trip it sees.)
    const want = Math.ceil((this.ping.srtt / 2 + Math.max(this.maxRtt, this.ping.srtt) / 2 + 2 * this.ping.jit) / this.w.tickMs) + 1;
    return want > this.D || want < this.D - 1 ? want : this.D;
  }
  tick(n, t) {
    if (this.ping.due(t)) this.w.toServer(this.cid, t, Net.encPing(t, this.ping.srtt));
    this.D = this.autoD();
    const smp = this.src.sample(t, this), inp = smp.inp;
    inp.seq = ++this.seq;
    this.delay.note(smp.changes, inp.seq);
    // This input is for tick n + D. When D grows the gap is filled with it; when it shrinks, ticks already promised stay
    // promised (it comes down a tick at a time), so every player has exactly one input for every tick.
    const target = Math.max(n + this.D, this.lastTarget + 1), first = this.lastTarget + 1, list = [];
    for (let tt = first; tt <= target; tt++) { this.inputs[this.cid].set(tt, inp); list.push(inp); }
    this.lastTarget = this.known[this.cid] = target;
    this.w.toServer(this.cid, t, Net.encLock(first, list));
    this.advance(n, t);
  }
  recv(buf, t) {
    const v = Net.view(buf), type = v.getUint8(0);
    if (type === Net.T.PONG) { const p = Net.decPong(v); this.ping.sample(t - p.t); this.maxRtt = p.maxRtt; return; }
    if (type !== Net.T.RELAY) return;
    const d = Net.decRelay(v);
    d.list.forEach((inp, i) => {
      const tt = d.first + i;
      this.inputs[d.player].set(tt, inp);
      // Rollback: a guess we already played this tick with was wrong
      const g = this.rb && this.guess.get(tt);
      if (g && !Sim.sameInput(g[d.player], inp)) this.dirty = Math.min(this.dirty, tt);
    });
    this.known[d.player] = Math.max(this.known[d.player], d.first + d.list.length - 1);
    this.advance(this.w.wallTick(t), t);
  }
  have(tt) { return this.known[0] >= tt && this.known[1] >= tt; }
  advance(W, t) {
    const c = this.conf;
    while (c.tick < W && this.have(c.tick + 1)) {
      const tt = c.tick + 1;
      Sim.step(c, [inputAt(this, 0, tt), inputAt(this, 1, tt)], this.P);
      this.hashes.set(c.tick, Sim.hash(c));
      if (!this.rb) this.collectSparks(c, t);
      for (const m of this.inputs) m.delete(tt - 2);
    }
    let shownTick = c.tick;
    if (this.rb) shownTick = this.advancePred(W, t);
    // Stalled: the clock says tick W but the screen can't get there for want of inputs
    const stalled = shownTick < W;
    if (stalled && !this.st.stalled) { this.st.stalls++; this.stallSince = t; }
    if (!stalled && this.st.stalled) this.st.stallMs += t - this.stallSince;
    this.st.stalled = stalled;
    if (stalled) this.st.stallTicks = Math.max(this.st.stallTicks, W - shownTick);
  }
  /** Rollback: run the guessed world up to the present (at most maxPred ticks past the confirmed one), rewinding when a guess was wrong */
  advancePred(W, t) {
    const c = this.conf, maxPred = this.w.cfg.rbMaxPred;
    const target = Math.min(W, c.tick + maxPred);
    let before = null;
    if (!this.pred || this.pred.tick < c.tick || this.dirty <= this.pred.tick) {
      if (this.pred && this.dirty <= this.pred.tick) {
        const depth = this.pred.tick - this.dirty + 1;
        this.st.rollbacks++; this.st.depthSum += depth; this.st.lastDepth = depth; this.st.maxDepth = Math.max(this.st.maxDepth, depth);
        before = { tick: this.pred.tick, ships: this.pred.ships.map((s) => ({ x: s.x, y: s.y })) };
      }
      this.pred = Sim.clone(c);
      this.dirty = Infinity;
    }
    const p = this.pred;
    while (p.tick < target) {
      const tt = p.tick + 1;
      const ins = [0, 1].map((q) => this.known[q] >= tt ? inputAt(this, q, tt) : inputAt(this, q, this.known[q]));
      this.guess.set(tt, ins);
      Sim.step(p, ins, this.P);
      this.st.resim++;
      this.collectSparks(p, t);
      if (before && p.tick === before.tick) {
        let e = 0; p.ships.forEach((s, i) => { e = Math.max(e, Math.hypot(s.x - before.ships[i].x, s.y - before.ships[i].y) / FX); });
        this.st.popErr = e; this.st.maxPop = Math.max(this.st.maxPop, e);
      }
    }
    for (const k of this.guess.keys()) if (k <= c.tick) this.guess.delete(k);
    return p.tick;
  }
  collectSparks(s, t) {
    for (const e of s.events) if (e.k === 'hit' && !this.seenHits.has(e.id)) {
      this.seenHits.add(e.id); this.sparks.push({ x: e.x / FX, y: e.y / FX, at: t });
      if (this.seenHits.size > 500) this.seenHits = new Set([...this.seenHits].slice(-200));
    }
  }
  shown() { return this.rb && this.pred ? this.pred : this.conf; }
  viewSelf() { const s = this.shown().ships[this.cid]; return { x: s.x / FX, y: s.y / FX }; }
  viewTarget() { const s = this.shown().ships[1 - this.cid]; return s.dead ? null : { x: s.x / FX, y: s.y / FX }; }
  view(now) {
    const s = this.shown();
    this.delay.shown(s.ships[this.cid].seq, now);
    const ships = s.ships.map((sh) => ({ id: sh.id, kind: sh.kind, x: sh.x / FX, y: sh.y / FX, a: sh.a, tur: sh.tur, hp: sh.hp, dead: sh.dead, boost: sh.boost, kills: sh.kills, deaths: sh.deaths }));
    const shells = s.shots.map((p) => ({ x: p.x / FX, y: p.y / FX, vx: p.vx / FX, vy: p.vy / FX, o: p.o }));
    this.sparks = this.sparks.filter((k) => now - k.at < 250);
    return { ships, shells, sparks: this.sparks, me: this.cid, displayTick: s.tick, othersTick: s.tick };
  }
  stats() {
    const stall = this.st.stallMs + (this.st.stalled ? performance.now() - this.stallSince : 0);
    return Object.assign({ style: this.rb ? 'rollback' : 'lockstep', rtt: this.ping.srtt, jit: this.ping.jit, D: this.D, maxRtt: this.maxRtt,
      confTick: this.conf.tick, shownTick: this.shown().tick, delay: this.delay }, this.st, { stallMsTotal: stall });
  }
}

// ============================================================================================================ world
/** One style's whole setup: server, you (client 0), the other player (client 1, the bot), and the links between them */
class World {
  constructor(style, cfg, human, now) {
    this.style = style; this.cfg = cfg; this.seed = cfg.seed;
    this.P = Sim.makeParams(cfg.tickRate); this.tickMs = 1000 / cfg.tickRate; this.t0 = now;
    // Lockstep's starting input delay, from the configured connection (as if the lobby had measured ping first)
    this.D0 = style === 'rollback' ? cfg.rbDelay
      : cfg.lockAuto ? Math.ceil((cfg.lat[0] + cfg.lat[1] + 2 * cfg.jitter) / this.tickMs) + 1 : cfg.lockDelay;
    this.meters = [0, 1].map(() => ({ up: new Net.Meter(), down: new Net.Meter() }));
    this.up = this.meters.map((m) => new Net.Link(true, m.up));
    this.down = this.meters.map((m) => new Net.Link(false, m.down));
    this.applyNet();
    this.server = style === 'current' ? new AuthServer(this) : new RelayServer(this);
    const bot = new Bot(cfg);
    this.clients = [human, bot].map((src, cid) => style === 'current' ? new PredClient(this, cid, src) : new LockClient(this, cid, src, style === 'rollback'));
    this.next = 1; this.desync = 0; this.checked = 0; this.lastSync = null;
  }
  applyNet() {
    const c = this.cfg;
    for (let i = 0; i < 2; i++) { this.up[i].set(c.lat[i], c.jitter, c.loss); this.down[i].set(c.lat[i], c.jitter, c.loss); }
  }
  wallTick(t) { return Math.floor((t - this.t0) / this.tickMs); }
  toServer(cid, t, buf) { this.up[cid].send(t, buf); }
  toClient(cid, t, buf) { this.down[cid].send(t, buf); }
  /** Run everything due up to `now`, in time order: packets that have arrived, then each tick (server first, then clients) */
  advance(now) {
    if ((now - this.t0) / this.tickMs - this.next > 600) return false;   // asleep too long (hidden tab): caller rebuilds
    for (;;) {
      let best = Infinity, link = null, to = -1, toServer = false;
      for (let i = 0; i < 2; i++) {
        const u = this.up[i].next(); if (u < best) { best = u; link = this.up[i]; to = i; toServer = true; }
        const d = this.down[i].next(); if (d < best) { best = d; link = this.down[i]; to = i; toServer = false; }
      }
      const tickT = this.t0 + this.next * this.tickMs;
      if (best <= tickT && best <= now) {
        const { t, buf } = link.pop();
        if (toServer) this.server.recv(to, buf, t); else this.clients[to].recv(buf, t);
        continue;
      }
      if (tickT <= now) {
        this.server.tick(this.next, tickT);
        for (const c of this.clients) c.tick(this.next, tickT);
        this.next++;
        continue;
      }
      break;
    }
    if (this.style !== 'current') this.checkSync();
    for (const m of this.meters) { m.up.sample(now); m.down.sample(now); }
    return true;
  }
  /** Lockstep/rollback: compare every tick's state hash on both clients and the server copy */
  checkSync() {
    const a = this.clients[0].hashes, b = this.clients[1].hashes, s = this.server.hashes;
    const h = Math.min(this.clients[0].conf.tick, this.clients[1].conf.tick, this.server.s.tick);
    for (let tt = this.checked + 1; tt <= h; tt++) {
      const x = a.get(tt), y = b.get(tt), z = s.get(tt);
      if (x === undefined || y === undefined || z === undefined) continue;
      if ((x !== y || x !== z) && !this.desync) this.desync = tt;
      this.lastSync = { tick: tt, hashes: [x, y, z] };
    }
    if (h > this.checked) this.checked = h;
    for (const m of [a, b, s]) for (const k of m.keys()) { if (k < h - 60) m.delete(k); else break; }
  }
  /** Knock the other player's copy of the world out by one unit (to show the hash check catching it) */
  injectDesync() { if (this.style !== 'current') this.clients[1].conf.ships[0].x += FX; }
  ghost() {
    const s = this.server.s;
    return { tick: s.tick, ships: s.ships.map((sh) => ({ id: sh.id, kind: sh.kind, x: sh.x / FX, y: sh.y / FX, a: sh.a, dead: sh.dead })),
      shells: s.shots.map((p) => ({ x: p.x / FX, y: p.y / FX })) };
  }
}

NL.Styles = { World, PredClient, LockClient, AuthServer, RelayServer, Bot, DelayMeter };
})(typeof window !== 'undefined' ? window.NL : globalThis.NL);
