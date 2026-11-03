// Netcode Lab: the server, with no transport of its own. server/server.js runs it under Node with real WebSockets;
// harness.js runs it in the page (offline mode) and in test.mjs over pretend links. It owns the authoritative world and
// ticks it at 60 Hz on its own clock; it never waits for a client.
//
// Two kinds of client share the one world:
//   lockstep ("server-paced deterministic lockstep", docs/design/netcode-lockstep.md) - the client runs the same
//     simulation on the part of the world it is told about. The server sends tick-stamped bundles: the inputs of the
//     players in that client's awareness, entry snapshots and exits (with slots), interaction pull-ins, rock overrides,
//     and corrections when a client's event reports or state hashes show it has gone wrong.
//   current - the game's style today: 20 Hz snapshots of what is in range, the client predicting only its own ship.
(function (NL) {
'use strict';
const { Sim, World: Wo, Proto: Pr } = NL;
const { C } = Wo;
const { R, REASON_ID, IDK, Writer } = Pr;
const TICK_MS = 1000 / Wo.RATE;
const SNAP_EVERY = 3;        // current style: 20 Hz
const HASH_EVERY = 120;      // background state hashes every 2 s
const HEARTBEAT = 4;         // a bundle at least every 4 ticks when nothing happens
const HIST = 900;            // ticks of event, hash and slot history kept (15 s)
const STICKY = 60;           // a pulled-in entity stays at least 1 s after its last interaction
const CORR_GAP = 15;         // ticks between two corrections of the same entity for one client
const rockKey = (id) => -1 - id;

class LabServer {
  constructor(opts = {}) {
    this.seed = opts.seed ?? 20261103;
    this.W = Wo.createWorld(this.seed, true);
    this.start = opts.now ?? 0;
    this.nextUid = 1; this.nextCid = 1;
    this.clients = new Map();
    this.bots = new Map();           // uid -> bot brain state (bots are players whose inputs the server makes)
    this.labShips = new Set();       // freighters made by debug commands (cleared with the bots)
    this.evlog = new Map();          // tick -> that tick's events (with report hashes)
    this.fireLog = new Map();        // tick -> shells fired that tick (current style's fire events)
    this.hashLog = new Map();        // tick -> Map uid -> 8-bit state hash (every HASH_EVERY ticks)
    this.inter = new Map();          // uid -> [{T, other}] recent interactions (what a correction also snapshots)
    this.applied = new Map();        // this tick's player inputs: uid -> { inp, changed, seq }
    this.aiChanged = new Map();      // this tick's AI brain outputs that changed: uid -> inp (relayed for puppets)
    this.perf = { ms: 0, n: 0, last: 0 };
    this.populate(opts);
  }
  uid() { return this.nextUid++; }

  // ---------------------------------------------------------------------------------------------------- the world
  populate(opts) {
    const W = this.W, r = { rng: this.seed | 0 || 1 };
    const nests = [[-1900, -1500], [1800, 1700], [1700, -1900]];
    for (const [hx, hy] of nests.slice(0, opts.nests ?? 3)) {
      for (let i = 0; i < (opts.drones ?? 3); i++) {
        const sh = Wo.makeShip(this.uid(), 'drone', hx + Wo.rngRange(r, -250, 250), hy + Wo.rngRange(r, -250, 250), Sim.rngNext(r));
        sh.hx = hx; sh.hy = hy;
        Wo.insertEntity(W, sh);
      }
    }
    for (let i = 0; i < (opts.freighters ?? 4); i++) {
      const sh = Wo.makeShip(this.uid(), 'freighter', Wo.rngRange(r, -2400, 2400), Wo.rngRange(r, -2400, 2400), Sim.rngNext(r));
      Wo.insertEntity(W, sh);
    }
  }
  spawnPlayer(x, y) {
    const sh = Wo.makeShip(this.uid(), 'player', x, y, 0);
    Wo.insertEntity(this.W, sh);
    return sh;
  }
  addBot(x, y, target) {
    const sh = this.spawnPlayer(x, y);
    this.bots.set(sh.uid, { fixed: target || 0, target: target || 0, inp: Sim.NEUTRAL, phase: sh.uid * 1.7, aimAt: 0 });
    return sh;
  }
  clearBots() {
    for (const uid of [...this.bots.keys(), ...this.labShips]) Wo.removeEntity(this.W, uid);
    this.bots.clear(); this.labShips.clear();
  }

  // ------------------------------------------------------------------------------------------------- connections
  connect(send) {
    const id = this.nextCid++;
    this.clients.set(id, { id, send, ready: false });
    return id;
  }
  disconnect(id) {
    const c = this.clients.get(id);
    if (c && c.uid) Wo.removeEntity(this.W, c.uid);
    this.clients.delete(id);
  }
  hello(c, msg, now) {
    const W = this.W, mode = msg.mode === 'current' ? 'current' : 'lockstep';
    const r = { rng: (Math.imul(c.id, 0x2545F491) ^ W.tick) | 0 || 1 };
    const sh = this.spawnPlayer(Wo.rngRange(r, -400, 400), Wo.rngRange(r, -400, 400));
    Object.assign(c, {
      ready: true, mode, name: String(msg.name || `pilot ${c.id}`).slice(0, 20), uid: sh.uid, every: !!msg.every,
      q: [], lastSeq: 0, appliedSeq: 0, rtt: 0, rttMax: 0, rttAt: 0, minLead: 127, late: 0, lateQ: [],
      set: new Map(), slots: new Map(), freeAt: new Map(), hist: [], memb: new Map(), sticky: new Map(), rocks: new Set(),
      ack: W.tick, lastSent: W.tick, corr: new Map(), corrAt: new Map(), corrected: new Map(), tokens: 30,
      det: [], counts: { mismatch: 0, missing: 0, spurious: 0, hash: 0, unseen: 0 }, expected: 0, matched: 0,
      entries: 0, exits: 0, pullIns: 0, down: {}, downWire: 0, downMsgs: 0, up: {}, upWire: 0, upMsgs: 0,
      lastSnap: W.tick, rockKnown: new Map(), joinT: now, lastInfo: 0,
    });
    this.sendJson(c, { t: 'welcome', cid: c.id, uid: sh.uid, tick: W.tick, seed: this.seed, mode, rate: Wo.RATE,
      hashEvery: HASH_EVERY, C: { VIEW: C.VIEW, AWARE: C.AWARE, AWARE_OUT: C.AWARE_OUT } });
  }
  sendJson(c, obj) { const s = JSON.stringify(obj); this.count(c, 'lab', s.length, s.length); c.send(s); }
  sendBin(c, buf, cats) {
    for (const k in cats) this.count(c, k, cats[k], 0);
    c.downWire += Pr.wireBytes(buf.length, false); c.downMsgs++;
    c.send(buf);
  }
  count(c, k, n) { c.down[k] = (c.down[k] || 0) + n; }

  recv(id, data, now) {
    const c = this.clients.get(id);
    if (!c) return;
    if (typeof data === 'string') {
      let m; try { m = JSON.parse(data); } catch { return; }
      if (m.t === 'hello' && !c.ready) this.hello(c, m, now);
      else if (m.t === 'cmd' && c.ready) this.command(c, m);
      return;
    }
    if (!c.ready || !data.length) return;
    const rd = new Pr.Reader(data), type = data[0];
    c.upMsgs++; c.upWire += Pr.wireBytes(data.length, true);
    if (type === Pr.T.PING) {
      rd.u8(); const t = rd.f64(), rtt = rd.u16();
      this.upCount(c, 'ping', data.length);
      c.rtt = rtt;
      if (rtt > c.rttMax || now - c.rttAt > 10000) { c.rttMax = rtt; c.rttAt = now; }
      const pong = Pr.encPong(t, now - this.start, this.W.tick, c.minLead === 127 ? -128 : c.minLead);
      c.minLead = 127;
      this.sendBin(c, pong, pong.cats);
    } else if (type === Pr.T.UP) {
      const u = Pr.decUp(rd, this.W.tick, c.lastSeq);
      rd.mark(null);
      this.upCountUp(c, u, data.length);
      if (u.input) this.queueInput(c, u.input);
      if (c.mode === 'lockstep') this.checkReports(c, u);
    }
  }
  upCount(c, k, n) { c.up[k] = (c.up[k] || 0) + n; }
  upCountUp(c, u, n) {
    // (the same split the encoder makes: 4 bytes header, 9 an input, the rest reports and hashes)
    let rest = n - 4;
    this.upCount(c, 'acks', 4);
    if (u.input) { this.upCount(c, 'inputs', 9); rest -= 9; }
    if (u.hashes) { const h = 2 + (u.hashes.list.length < 128 ? 1 : 2) + u.hashes.list.length; this.upCount(c, 'hashes', h); rest -= h; }
    if (rest > 0) this.upCount(c, 'reports', rest);
  }
  /** An input for tick `target`. Late (that tick is already simulated): used from the next tick, and the client is told. */
  queueInput(c, d) {
    const W = this.W;
    c.lastSeq = d.seq;
    const lead = d.target - W.tick;
    if (lead < c.minLead) c.minLead = lead;
    if (d.target <= W.tick) {
      c.late++;
      c.lateQ.push({ seq: d.seq & 255, by: W.tick - d.target + 1 });
      d.target = W.tick + 1;
    }
    let i = c.q.length; while (i > 0 && c.q[i - 1].target > d.target) i--;
    c.q.splice(i, 0, d);
  }
  command(c, m) {
    const W = this.W, me = W.byUid.get(c.uid);
    if (m.cmd === 'botfight' && me) {
      // A freighter just inside your awareness and a bot outside it attacking the freighter: the bot is pulled in
      const mx = me.x / Sim.FX, my = me.y / Sim.FX, len = Math.hypot(mx, my) || 1;
      let dx = -mx / len, dy = -my / len;   // towards the middle of the world (room on that side)
      if (len < 300) { dx = 1; dy = 0; }
      const ang = (m.side || 0) * 0.6, ux = dx * Math.cos(ang) - dy * Math.sin(ang), uy = dx * Math.sin(ang) + dy * Math.cos(ang);
      const fr = Wo.makeShip(this.uid(), 'freighter', Math.round(mx + ux * 1350), Math.round(my + uy * 1350), Math.round(Math.atan2(-ux, uy) * Sim.RAD));
      fr.wpx = Math.round(Sim.clamp(mx + ux * 1350 - uy * 2500, -2600, 2600)); fr.wpy = Math.round(Sim.clamp(my + uy * 1350 + ux * 2500, -2600, 2600));
      Wo.insertEntity(W, fr); this.labShips.add(fr.uid);
      this.addBot(Math.round(mx + ux * 1950), Math.round(my + uy * 1950), fr.uid);
    } else if (m.cmd === 'bots' && me) {
      const n = Math.max(1, Math.min(12, m.n | 0 || 4));
      for (let i = 0; i < n; i++) {
        const a = i / n * Math.PI * 2, d = 700 + (i % 3) * 150;
        this.addBot(Math.round(Sim.clamp(me.x / Sim.FX + Math.cos(a) * d, -2800, 2800)), Math.round(Sim.clamp(me.y / Sim.FX + Math.sin(a) * d, -2800, 2800)), 0);
      }
    } else if (m.cmd === 'clearbots') this.clearBots();
  }

  // -------------------------------------------------------------------------------------------------------- ticks
  /** Run every tick that is due by `now` (never more than 10 at once; further behind than a second, it skips) */
  update(now) {
    let n = 0;
    while (this.start + (this.W.tick + 1) * TICK_MS <= now && n < 10) { this.tick(now); n++; }
    const behind = (now - this.start) / TICK_MS - this.W.tick;
    if (behind > 60) this.start += (Math.floor(behind) - 2) * TICK_MS;
    return n;
  }
  tick(now) {
    const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
    const W = this.W, T = W.tick + 1;
    // 1. Inputs for this tick: each person's queued input stamped for it (the last one wins), each bot's brain
    const inputs = new Map();
    this.applied.clear();
    for (const c of this.clients.values()) {
      if (!c.ready) continue;
      const sh = W.byUid.get(c.uid);
      let e = null;
      while (c.q.length && c.q[0].target <= T) e = c.q.shift();
      if (!e || !sh) continue;
      inputs.set(c.uid, e.inp);
      c.appliedSeq = e.seq;
      this.applied.set(c.uid, { inp: e.inp, changed: !Sim.sameInput(e.inp, sh.inp), seq: e.seq });
    }
    for (const [uid, b] of this.bots) {
      const sh = W.byUid.get(uid);
      if (!sh) { this.bots.delete(uid); continue; }
      const inp = this.botInput(b, sh, T);
      if (!Sim.sameInput(inp, sh.inp)) { inputs.set(uid, inp); this.applied.set(uid, { inp, changed: true, seq: -1 }); }
    }
    // 2. Step (noting which AI brains changed their output: clients holding that AI as a puppet get it as an input)
    const before = new Map();
    for (const sh of W.ships) if (sh.kind !== 'player') before.set(sh.uid, sh.inp);
    Wo.step(W, inputs);
    this.aiChanged.clear();
    for (const sh of W.ships) if (sh.kind !== 'player' && before.has(sh.uid) && !Sim.sameInput(before.get(sh.uid), sh.inp)) this.aiChanged.set(sh.uid, sh.inp);
    // 3. Logs: events with their report hashes, shells fired, who interacted with whom
    for (const e of W.events) {
      e.h8 = Wo.eventHash8(e);
      const other = e.rock >= 0 ? rockKey(e.rock) : e.tgt;
      this.interact(e.by, other, T); this.interact(other, e.by, T);
    }
    this.evlog.set(T, W.events);
    const fired = W.shells.filter((p) => p.t0 === T).map((p) => Object.assign({}, p));
    this.fireLog.set(T, fired);
    if (T % HASH_EVERY === 0) {
      const m = new Map();
      for (const e of W.ships) m.set(e.uid, [Wo.fold8(Wo.entityHash(W, e)), Wo.fold8(Wo.entityHash(W, e, true))]);
      for (const e of W.loot) { const h = Wo.fold8(Wo.entityHash(W, e)); m.set(e.uid, [h, h]); }
      this.hashLog.set(T, m);
    }
    for (const mp of [this.evlog, this.fireLog, this.hashLog]) for (const k of mp.keys()) { if (k < T - HIST) mp.delete(k); else break; }
    // 4. Every client's view of this tick
    const adj = this.graph();
    const killed = W.events.filter((e) => e.rock >= 0 && e.kill).map((e) => e.rock);
    for (const c of this.clients.values()) {
      if (!c.ready) continue;
      if (c.mode === 'lockstep') this.bundle(c, adj, killed, T, now);
      else if ((T - c.lastSnap) >= SNAP_EVERY) this.snapshot(c, T);
      if (now - c.lastInfo >= 500) { c.lastInfo = now; this.sendJson(c, this.info(c)); }
    }
    if (t0) { const dt = performance.now() - t0; this.perf.ms += 0.05 * (dt - this.perf.ms); this.perf.last = dt; }
    this.perf.n++;
  }
  interact(a, b, T) {
    if (a < 0) return;
    let l = this.inter.get(a);
    if (!l) this.inter.set(a, (l = []));
    l.push({ T, other: b });
    while (l.length && l[0].T < T - HIST) l.shift();
    if (l.length > 64) l.splice(0, l.length - 64);
  }

  /** A server bot: picks a target (or keeps the one it was given), circles it at ~500 and shoots; aim updated at 15 Hz */
  botInput(b, sh, T) {
    const W = this.W, FX = Sim.FX, IN = Sim.IN;
    if (sh.dead) return sh.inp;
    let tg = b.target ? W.byUid.get(b.target) : null;
    if (b.fixed && (!tg || tg.dead) && W.byUid.has(b.fixed)) tg = W.byUid.get(b.fixed);
    if (!b.fixed && (!tg || tg.dead || T % 120 === sh.uid % 120)) {
      let best = null, bd = 2500 * 2500;
      for (const o of W.ships) {
        if (o === sh || o.dead) continue;
        const d = ((o.x - sh.x) / FX) ** 2 + ((o.y - sh.y) / FX) ** 2;
        if (d < bd) { bd = d; best = o; }
      }
      tg = best;
    }
    b.target = tg && !tg.dead ? tg.uid : 0;
    if (!b.target) return { b: 0, aim: sh.inp.aim, dist: 400, seq: 0 };
    const sx = sh.x / FX, sy = sh.y / FX, tx = tg.x / FX, ty = tg.y / FX;
    const th = T / 60 * 0.45 + b.phase, rad = tg.kind === 'freighter' ? 520 : 480;
    const wx = tx + rad * Math.cos(th) - sx, wy = ty + rad * Math.sin(th) - sy;
    let bits = 0;
    if (wx > 60) bits |= IN.D; else if (wx < -60) bits |= IN.A;
    if (wy > 60) bits |= IN.S; else if (wy < -60) bits |= IN.W;
    const dist = Math.hypot(tx - sx, ty - sy);
    if (T % 4 === 0 || !b.aimAt) {
      const lead = Math.min(40, dist / 34);
      b.aimAt = Pr.quantAim(Math.round(Math.atan2(ty + tg.vy / FX * lead - sy, tx + tg.vx / FX * lead - sx) * Sim.RAD) & 0xFFFF) || 8;
    }
    const aim = b.aimAt;
    if (dist < 1000 && Math.abs(Sim.wrapBA(aim - sh.a)) < 1500) bits |= IN.GUN;
    if (dist < 1100) bits |= IN.TURRET;
    if ((T / 60 + b.phase) % 9 < 0.6) bits |= IN.BOOST;
    return { b: bits, aim, dist: Pr.quantDist(Math.min(dist, 2000)), seq: 0 };
  }

  // --------------------------------------------------------------------------------------- interaction pull-in
  /** Who interacts with whom this tick (server only, so plain floats): AI targets and what an AI can see, what each live
   *  shell can still reach on its line, loot within reach of a ship. Rocks are keyed -1 - id. */
  graph() {
    const W = this.W, FX = Sim.FX, adj = new Map();
    const add = (a, b) => {
      if (a === b) return;
      (adj.get(a) || adj.set(a, new Set()).get(a)).add(b);
      (adj.get(b) || adj.set(b, new Set()).get(b)).add(a);
    };
    for (const sh of W.ships) {
      if (sh.dead) continue;
      const bt = this.bots.get(sh.uid);
      const tgt = bt ? bt.target : sh.target;
      if (tgt && W.byUid.has(tgt)) add(sh.uid, tgt);
      if (sh.kind === 'drone' || sh.kind === 'freighter') {
        const R = sh.kind === 'drone' ? C.SENSE + 200 : C.FR_SENSE + 200;
        for (const o of W.ships) {
          if (o === sh || o.dead || (sh.kind === 'drone' ? o.kind === 'drone' : o.kind !== 'drone')) continue;
          if (Wo.within(sh, o, R)) add(sh.uid, o.uid);
        }
      }
    }
    for (const p of W.shells) {
      const x0 = p.x / FX, y0 = p.y / FX, x1 = x0 + p.vx / FX * p.life, y1 = y0 + p.vy / FX * p.life;
      for (const sh of W.ships) {
        if (sh.dead || sh.uid === p.o || Wo.team(sh) === p.tm) continue;
        if (segDist(x0, y0, x1, y1, sh.x / FX, sh.y / FX) < Wo.P.kinds[sh.kind].r + 150) add(p.o, sh.uid);
      }
      for (const id of Wo.rocksIn(W, Math.min(x0, x1) - 100, Math.min(y0, y1) - 100, Math.max(x0, x1) + 100, Math.max(y0, y1) + 100)) {
        const rk = W.rocks.list[id];
        // (destroyed ones too: a client that never saw it go would still have it)
        if (segDist(x0, y0, x1, y1, rk.x, rk.y) < rk.r + 40) add(p.o, rockKey(id));
      }
    }
    for (const l of W.loot) for (const sh of W.ships) if (sh.kind === 'player' && !sh.dead && Wo.within(sh, l, 300)) add(sh.uid, l.uid);
    return adj;
  }

  // ---------------------------------------------------------------------------------------------- lockstep client
  allocSlot(c, T) {
    for (let s = 0; ; s++) if (!c.slots.has(s) && (c.freeAt.get(s) ?? 0) <= T) return s;
  }
  quarantine(c) { return Math.max(60, Math.ceil((c.rttMax + 250) / TICK_MS)); }
  member(c, uid, t) {
    const iv = c.memb.get(uid);
    if (!iv) return false;
    for (const m of iv) if (m.from < t && t <= m.to) return true;
    return false;
  }
  slotAt(c, uid, t) {
    const iv = c.memb.get(uid);
    if (iv) for (const m of iv) if (m.from < t && t <= m.to) return m.slot;
    return -1;
  }
  /** Who held `slot` for this client around ticks (from, to] (quarantine makes it one entity) */
  holder(c, slot, from, to) {
    for (let i = c.hist.length - 1; i >= 0; i--) { const h = c.hist[i]; if (h.slot === slot && h.from < to && h.to >= from) return h.uid; }
    return -1;
  }

  bundle(c, adj, killed, T, now) {
    const W = this.W, w = new Writer(64);
    w.mark('ticks'); w.u8(Pr.T.BUNDLE); w.u16(T);
    const start = w.o;
    for (const n of c.lateQ) { w.u8(R.LATE); w.u8(n.seq); w.u8(Math.min(255, n.by)); }
    c.lateQ.length = 0;
    // Inputs used this tick by players this client tracks (its own as a sequence number: it knows what it sent)
    w.mark('inputs');
    for (const [uid, a] of this.applied) {
      const m = c.set.get(uid);
      if (!m) continue;
      if (uid === c.uid) { w.u8(R.OWN); w.u8(a.seq & 255); }
      else if (a.changed) { w.u8(R.IN); w.vu(m.slot); Pr.wInp(w, a.inp); }
    }
    for (const [uid, inp] of this.aiChanged) {
      const m = c.set.get(uid);
      if (m && m.pulled) { w.u8(R.IN); w.vu(m.slot); Pr.wInp(w, inp); }
    }
    // A tracked shooter's shell hit something this client doesn't hold: name the shell (shooter slot + shot number) so
    // the client drops it too, instead of letting it fly on into something it does hold
    w.mark('shells');
    for (const e of W.events) {
      if (e.k !== 'hit') continue;
      const m = c.set.get(e.by), holds = e.rock >= 0 ? c.rocks.has(e.rock) : c.set.has(e.tgt);
      if (m && !holds) { w.u8(R.GONE); w.vu(m.slot); w.u8(e.n & 255); w.u8(e.kill); }
      // ...and the other way round: something this client holds was hit from outside its set. It can't have seen
      // that, so it is corrected now (one hop of pull-in isn't always enough: this is the cost of stopping at one)
      if (!m && holds) this.detect(c, 'unseen', e.rock >= 0 ? rockKey(e.rock) : e.tgt, T, e);
    }
    // Awareness: within AWARE of your ship (AWARE_OUT to stay), plus one hop of interactions, plus recent pull-ins
    const me = W.byUid.get(c.uid);
    if (me) c.center = { x: me.x, y: me.y };
    const ctr = c.center || { x: 0, y: 0 };
    const want = new Map(), rockPull = new Set();
    for (const list of [W.ships, W.loot]) for (const e of list) {
      const cur = c.set.get(e.uid);
      if (Wo.within(ctr, e, cur && !cur.pulled ? C.AWARE_OUT : C.AWARE)) want.set(e.uid, false);
    }
    for (const uid of [...want.keys()]) {
      const nb = adj.get(uid);
      if (!nb) continue;
      for (const o of nb) {
        if (o < 0) { rockPull.add(-1 - o); continue; }
        if (want.has(o) || !W.byUid.has(o)) continue;
        want.set(o, true); c.sticky.set(o, T + STICKY);
      }
    }
    for (const [uid, until] of c.sticky) {
      if (until < T || !W.byUid.has(uid)) c.sticky.delete(uid);
      else if (!want.has(uid)) want.set(uid, true);
    }
    // Rocks are leaves (they never act on anything), so the rocks any tracked entity's shells can reach come in too
    // (and so is loot: it only ever gets picked up)
    for (const uid of [...want.keys()]) for (const o of adj.get(uid) || []) {
      if (o < 0) rockPull.add(-1 - o);
      else if (Wo.isLoot(o) && !want.has(o) && W.byUid.has(o)) { want.set(o, true); c.sticky.set(o, T + STICKY); }
    }
    w.mark('entries');
    for (const [uid, m] of c.set) {
      if (want.has(uid)) {
        const pulled = want.get(uid);
        if (pulled === m.pulled) continue;
        // In or out of the radius: a pulled-in AI is a puppet; one that comes into the radius needs its brain state
        m.pulled = pulled;
        const e = W.byUid.get(uid);
        if (!pulled && e && e.kind && e.kind !== 'player') { w.u8(R.ENTER); w.vu(m.slot); w.u8(0); Pr.wEntity(w, W, uid); }
        else { w.u8(R.PULL); w.vu(m.slot); w.u8(pulled ? 1 : 0); }
        continue;
      }
      w.u8(R.EXIT); w.vu(m.slot);
      c.set.delete(uid); c.slots.delete(m.slot); c.freeAt.set(m.slot, T + this.quarantine(c));
      m.iv.to = T; m.h.to = T;
      c.exits++;
    }
    for (const [uid, pulled] of [...want].sort((a, b) => (b[0] === c.uid) - (a[0] === c.uid))) {   // (yours first: slot 0)
      if (c.set.has(uid)) continue;
      const slot = this.allocSlot(c, T), iv = { from: T, to: Infinity, slot }, h = { slot, uid, from: T, to: Infinity };
      c.set.set(uid, { slot, pulled, iv, h }); c.slots.set(slot, uid);
      let l = c.memb.get(uid); if (!l) c.memb.set(uid, (l = [])); l.push(iv);
      c.hist.push(h);
      w.u8(R.ENTER); w.vu(slot); w.u8(pulled ? 1 : 0); Pr.wEntity(w, W, uid);
      c.entries++; if (pulled) c.pullIns++;
    }
    // Rocks: tracked when near or pulled in; one that isn't in its default state gets its override on entry
    for (const rk of W.rocks.list) {
      const near = Wo.within(ctr, { x: rk.x * Sim.FX, y: rk.y * Sim.FX }, c.rocks.has(rk.id) ? C.ROCK_OUT : C.ROCK_AWARE);
      if (near || rockPull.has(rk.id)) {
        if (!c.rocks.has(rk.id)) { c.rocks.add(rk.id); if (W.rockOv.has(rk.id)) { w.u8(R.ROCK); Pr.wRock(w, W, rk.id); } }
      } else c.rocks.delete(rk.id);
    }
    // Destroyed rocks: everyone not already simulating that rock hears about it (id; the tick is the bundle's)
    w.mark('overrides');
    for (const id of killed) if (!c.rocks.has(id)) { w.u8(R.RDEAD); w.vu(id); }
    // Corrections due (rate limited)
    w.mark('corrections');
    c.tokens = Math.min(30, c.tokens + 0.5);
    for (const [key, k] of c.corr) {
      // A hit from outside the set ("unseen") is something this client cannot know: always corrected in the same tick's
      // bundle, never held back (held back, things inside the set react to the stale copy and the error spreads)
      const urgent = k.reason === 'unseen';
      if (!urgent && c.tokens < 1) continue;
      if (!urgent && (c.corrAt.get(key) ?? -1e9) > T - CORR_GAP) continue;
      c.corr.delete(key);
      if (key < 0) {
        const id = -1 - key;
        w.u8(R.RCORR); w.u8(REASON_ID[k.reason]); w.u16(Math.min(65535, T - k.eventT)); Pr.wRock(w, W, id);
      } else {
        const m = c.set.get(key);
        if (!m || !W.byUid.has(key)) continue;
        w.u8(R.CORR); w.vu(m.slot); w.u8(REASON_ID[k.reason]); w.u16(Math.min(65535, T - k.eventT)); Pr.wEntity(w, W, key);
      }
      if (!urgent) c.tokens--;
      c.corrAt.set(key, T); c.corrected.set(key, T);
    }
    for (const [k, t] of c.corrected) if (t < T - HIST) c.corrected.delete(k);
    // Prune slot history
    while (c.hist.length && c.hist[0].to < T - HIST) c.hist.shift();
    if (T % 300 === 0) for (const [uid, l] of c.memb) { const k = l.filter((m) => m.to >= T - HIST); if (k.length) c.memb.set(uid, k); else c.memb.delete(uid); }
    if (w.o > start || c.every || T - c.lastSent >= HEARTBEAT) {
      const buf = w.done();
      c.lastSent = T;
      this.sendBin(c, buf, w.cats);
    }
  }

  /** The window (c.ack, u.ack]: every event this client should have seen, against what it reported */
  checkReports(c, u) {
    const W = this.W, from = c.ack + 1, to = Math.min(u.ack, W.tick);
    if (u.hashes) this.checkHashes(c, u.hashes);
    if (to < from) return;
    c.ack = to;
    const expected = [];
    for (let t = from; t <= to; t++) {
      const evs = this.evlog.get(t);
      if (!evs) continue;
      for (const e of evs) {
        const byIn = this.member(c, e.by, t);
        if (e.rock >= 0) {
          if (byIn) expected.push({ e, kind: IDK.ROCK, id: e.rock, key: rockKey(e.rock) });
          // (a hit from outside this client's set: corrected in that tick's bundle, see bundle())
          continue;
        }
        const tgIn = this.member(c, e.tgt, t);
        if (tgIn && byIn) expected.push({ e, kind: IDK.SLOT, id: this.slotAt(c, e.tgt, t), key: e.tgt });
        // (likewise)
      }
    }
    const reps = u.reports.map((r) => Object.assign({ used: false }, r));
    for (const x of expected) {
      c.expected++;
      // (already corrected since that event, or a correction already on its way: nothing new)
      const sup = (c.corrected.get(x.key) ?? -1) >= x.e.T || c.corr.has(x.key);
      let m = reps.find((r) => !r.used && r.kind === x.kind && r.id === x.id && r.hash === x.e.h8);
      if (m) { m.used = true; c.matched++; continue; }
      m = reps.find((r) => !r.used && r.kind === x.kind && r.id === x.id);
      if (m) m.used = true;
      if (!sup) this.detect(c, m ? 'mismatch' : 'missing', x.key, x.e.T, x.e);
    }
    for (const r of reps) {
      if (r.used) continue;
      const key = r.kind === IDK.ROCK ? rockKey(r.id) : r.kind === IDK.SLOT ? this.holder(c, r.id, from - 1, to) : -1;
      if (key === -1) continue;
      if ((c.corrected.get(key) ?? -1) >= from || c.corr.has(key)) continue;
      this.detect(c, 'spurious', key, from, null);
    }
  }
  checkHashes(c, h) {
    const srv = this.hashLog.get(h.tick);
    if (!srv) return;
    const slots = c.hist.filter((x) => x.from <= h.tick && x.to > h.tick).sort((a, b) => a.slot - b.slot);
    if (slots.length !== h.list.length) return;
    slots.forEach((s, i) => {
      // (a puppet's hash leaves out its brain state: either version will do)
      if (!srv.has(s.uid) || srv.get(s.uid).includes(h.list[i])) return;
      if ((c.corrected.get(s.uid) ?? -1) >= h.tick || c.corr.has(s.uid)) return;
      this.detect(c, 'hash', s.uid, h.tick, null);
    });
  }
  /** A desync caught: note it, and snapshot the entity plus whatever it interacted with since */
  detect(c, reason, key, eventT, e) {
    const T = this.W.tick;
    c.counts[reason]++;
    c.det.push({ reason, key, eventT, detectT: T, ticks: T - eventT });
    if (c.det.length > 200) c.det.shift();
    const keys = [key];
    if (e && e.by !== undefined) keys.push(e.by);
    for (const it of this.inter.get(key) || []) if (it.T >= eventT) keys.push(it.other);
    for (const k of keys) {
      if (k >= 0 && !c.set.has(k)) continue;
      if (!c.corr.has(k) || reason === 'unseen') c.corr.set(k, { reason, eventT });   // (unseen: goes now)
    }
  }

  // ------------------------------------------------------------------------------------------------ current style
  snapshot(c, T) {
    const W = this.W, me = W.byUid.get(c.uid);
    if (!me) return;
    const from = c.lastSnap;
    c.lastSnap = T;
    const R2 = C.AWARE, rows = [], loot = [], fires = [], hits = [], rocks = [];
    for (const s of W.ships) if (s.uid !== c.uid && Wo.within(me, s, R2)) rows.push(s);
    for (const l of W.loot) if (Wo.within(me, l, R2)) loot.push(l);
    for (let t = from + 1; t <= T; t++) {
      for (const p of this.fireLog.get(t) || []) if (p.o !== c.uid && Wo.within(me, p, R2 + 300)) fires.push(p);
      for (const e of this.evlog.get(t) || []) if (e.k === 'hit' && Wo.within(me, e, R2 + 300)) hits.push(e);
    }
    for (const rk of W.rocks.list) {
      if (!Wo.within(me, { x: rk.x * Sim.FX, y: rk.y * Sim.FX }, C.ROCK_AWARE)) continue;
      const o = W.rockOv.get(rk.id), sig = o ? o.hp * 100000 + o.dead : -1, known = c.rockKnown.get(rk.id) ?? -1;
      if (sig !== known) { rocks.push(rk.id); c.rockKnown.set(rk.id, sig); }
    }
    const buf = Pr.encSnap(W, T, c.appliedSeq, me, rows, loot, fires.slice(0, 200), hits.slice(0, 200), rocks);
    this.sendBin(c, buf, buf.cats);
  }

  // --------------------------------------------------------------------------------------------------- lab info
  info(c) {
    const W = this.W;
    const players = [...this.clients.values()].filter((o) => o.ready).map((o) => ({ name: o.name, mode: o.mode, uid: o.uid, rtt: o.rtt }));
    const you = c.mode === 'lockstep' ? {
      slots: c.set.size, quarantined: [...c.freeAt.values()].filter((t) => t > W.tick).length, pulled: [...c.set].filter(([, m]) => m.pulled).map(([u]) => u),
      entries: c.entries, exits: c.exits, pullIns: c.pullIns, expected: c.expected, matched: c.matched, counts: c.counts,
      det: c.det.slice(-8), late: c.late, quarantineTicks: this.quarantine(c), rocks: c.rocks.size,
    } : { late: c.late };
    return { t: 'info', tick: W.tick, players, bots: this.bots.size, you,
      srv: { tickMs: +this.perf.ms.toFixed(3), ships: W.ships.length, shells: W.shells.length, loot: W.loot.length, rockOv: W.rockOv.size },
      down: c.down, downWire: c.downWire, downMsgs: c.downMsgs, up: c.up, upWire: c.upWire, upMsgs: c.upMsgs };
  }
}
function segDist(x0, y0, x1, y1, px, py) {
  const vx = x1 - x0, vy = y1 - y0, vv = vx * vx + vy * vy;
  let t = vv > 0 ? ((px - x0) * vx + (py - y0) * vy) / vv : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - x0 - vx * t, py - y0 - vy * t);
}

NL.LabServer = LabServer;
NL.LabServer.consts = { TICK_MS, SNAP_EVERY, HASH_EVERY, HEARTBEAT };
if (typeof module === 'object' && module.exports) module.exports = NL;
})(globalThis.NL = globalThis.NL || {});
