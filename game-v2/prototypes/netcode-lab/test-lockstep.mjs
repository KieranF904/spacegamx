// Netcode Lab checks, part 3: the lab server (labserver.js) and its clients (labclient.js), in one process over pretend
// links (harness.js) on a fake clock. Run by test.mjs (`node test.mjs --server` for this part alone).
//   a. determinism: two servers fed the same inputs stay equal; every client's copy of every entity equals the server's,
//      tick by tick (a puppet's brain state aside), except entities a hit from outside the set was just corrected on
//   b. identities: each client's slot -> entity map equals the server's slot history at every tick; freed slots sit out
//      their quarantine; a bot fighting just outside the awareness radius is pulled in
//   c. drift: each injected drift is caught for the reason it should be (mismatch, missing, spurious, hash), and
//      corrected (the entity matches the server again)
//   d. timing: a laggy, jittery client doesn't stall anyone; its margin grows until its inputs stop being late; a client
//      whose messages are held back catches up without the screen stopping
//   e. bandwidth: a 2-player fight and an 8-bot fight, lockstep vs the current style, by category
export async function run(NL) {
  const { Sim, World: Wo, Proto: Pr, LabClient, Harness, LabServer } = NL;
  const FX = Sim.FX, TICK = 1000 / 60;
  let fails = 0;
  const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fails++; };
  const f0 = (x) => (isNaN(x) ? '-' : Math.round(x).toString());
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
  console.log('\n--- the lab server (lockstep design) ---');

  /** A scripted pilot: thrust flips, aim sweeps, fire bursts. Reports each change at the sample time. */
  class Script {
    constructor(k) { this.k = k; this.prev = null; }
    sample(t) {
      const ph = Math.floor(t / 450) + this.k;
      let b = [Sim.IN.W, Sim.IN.D, Sim.IN.S, Sim.IN.A][ph % 4];
      if (Math.floor(t / 900 + this.k) % 3 === 0) b |= Sim.IN.GUN | Sim.IN.TURRET;
      const aim = Pr.quantAim((Math.floor(t / 150) * 2600 + this.k * 9000) & 0xFFFF);
      const changes = [];
      if (this.prev) {
        if ((b & 0x1F) !== (this.prev.b & 0x1F)) changes.push({ kind: 'thrust', t });
        if (Math.abs(Sim.wrapBA(aim - this.prev.aim)) > 1092) changes.push({ kind: 'turn', t });
        if ((b & Sim.IN.GUN) && !(this.prev.b & Sim.IN.GUN)) changes.push({ kind: 'fire', t });
      }
      this.prev = { b, aim };
      return { inp: { b, aim, dist: 600, seq: 0 }, changes };
    }
  }
  /** A pilot that fights: circles the nearest other ship it can see at ~500 and shoots at it (aim updated at 15 Hz) */
  class Fighter {
    constructor(get) { this.get = get; this.aim = 0; this.n = 0; }
    sample(t) {
      const c = this.get(), v = c && c.ready ? c.view(t, 16.7) : null;
      const me = v && v.ships.find((s) => s.uid === v.me);
      if (!me) return { inp: { b: 0, aim: 0, dist: 400, seq: 0 }, changes: [] };
      let tg = null, bd = Infinity;
      for (const s of v.ships) { if (s.uid === me.uid || s.dead) continue; const d = Math.hypot(s.x - me.x, s.y - me.y); if (d < bd) { bd = d; tg = s; } }
      let b = 0;
      if (tg) {
        const th = t / 1000 * 0.5 + this.n, wx = tg.x + 500 * Math.cos(th) - me.x, wy = tg.y + 500 * Math.sin(th) - me.y;
        if (wx > 60) b |= Sim.IN.D; else if (wx < -60) b |= Sim.IN.A;
        if (wy > 60) b |= Sim.IN.S; else if (wy < -60) b |= Sim.IN.W;
        if (Math.floor(t / 66) % 1 === 0 && t - (this.at || 0) > 66) { this.at = t; this.aim = Pr.quantAim(Math.round(Math.atan2(tg.y - me.y, tg.x - me.x) * Sim.RAD) & 0xFFFF); }
        if (bd < 1000) b |= Sim.IN.GUN | Sim.IN.TURRET;
      }
      return { inp: { b, aim: this.aim, dist: 600, seq: 0 }, changes: [] };
    }
  }
  /** A harness plus a per-tick copy of the server's world (for comparing a client's copy at the same tick) */
  function setup(opts = {}) {
    const h = new Harness({ now: 0, server: opts.server });
    const hist = new Map();
    if (opts.history) {
      const tick0 = h.server.tick.bind(h.server);
      h.server.tick = (now) => { tick0(now); hist.set(h.server.W.tick, Wo.cloneWorld(h.server.W)); hist.delete(h.server.W.tick - 400); };
    }
    return { h, hist };
  }
  const addLs = (h, src, lat, jit, opts = {}) => { const p = h.add((send) => new LabClient.LsClient(Object.assign({ send, src, name: 'ls' }, opts)), lat, jit); p.client.start(); return p; };
  const addCur = (h, src, lat, jit) => { const p = h.add((send) => new LabClient.CurClient({ send, src, name: 'cur' }), lat, jit); p.client.start(); return p; };
  /** Run frames at 60 fps from t0 for `ms`, calling each(t, frame) after every frame */
  function play(h, t0, ms, each) {
    let t = t0;
    for (let f = 0; t < t0 + ms; f++) {
      t = t0 + f * TICK; h.advance(t);
      for (const p of h.peers) { p.client.frame(t); if (p.client.view) p.client.view(t, TICK); }
      if (each) each(t, f);
    }
    return t;
  }
  const srvClient = (h, peer) => h.server.clients.get(peer.cid);

  // ---------------------------------------------------------------------------------------------- a. determinism
  {
    const a = new LabServer({ seed: 7 }), b = new LabServer({ seed: 7 });
    const pa = [a.spawnPlayer(0, 0), a.spawnPlayer(300, 0)], pb = [b.spawnPlayer(0, 0), b.spawnPlayer(300, 0)];
    let rng = 99, same = true, tick = 0;
    const rand = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng; };
    for (let t = 0; t < 3000 && same; t++) {
      const ins = new Map(), inb = new Map();
      pa.forEach((s, i) => { if (rand() % 5 === 0) { const x = { b: rand() & 0x3FF, aim: rand() & 0xFFF8, dist: (rand() % 500) * 4, seq: 0 }; ins.set(s.uid, x); inb.set(pb[i].uid, Object.assign({}, x)); } });
      Wo.step(a.W, ins); Wo.step(b.W, inb);
      if (Wo.worldHash(a.W) !== Wo.worldHash(b.W)) { same = false; tick = a.W.tick; }
    }
    const kills = a.W.ships.reduce((s, x) => s + x.kills, 0);
    check(same, `world: two servers, 3000 ticks of random player inputs, AI, rocks and loot: identical (${a.W.shells.length} shells live, ${kills} kills, ${a.W.rockOv.size} rocks touched${same ? '' : `, split at tick ${tick}`})`);
  }
  {
    // Server copy vs client copies: two players fighting, a 4-bot brawl next to them, one client far off at 250 ms with jitter
    const { h, hist } = setup({ history: true });
    let A, B, C;
    A = addLs(h, new Fighter(() => A.client), 40, 0);
    B = addLs(h, new Fighter(() => B.client), 80, 10);
    C = addLs(h, new Script(3), 250, 40);
    let diverged = 0, checked = 0, bad = [];
    const watch = (peer) => {
      const cl = peer.client, step0 = cl.stepConf.bind(cl);
      cl.stepConf = (b, now) => {
        step0(b, now);
        const S = hist.get(cl.conf.tick);
        if (!S) return;
        for (const e of [...cl.conf.ships, ...cl.conf.loot]) {
          const s = S.byUid.get(e.uid);
          checked++;
          if (!s || Wo.entityHash(cl.conf, e, e.puppet) !== Wo.entityHash(S, s, e.puppet)) { diverged++; bad.push({ peer, uid: e.uid, T: cl.conf.tick }); }
        }
      };
    };
    for (const p of [A, B, C]) watch(p);
    play(h, 0, 30000, (t, f) => { if (f === 120) A.client.command('bots', { n: 4 }); });
    // Every divergence must be one the server knew about and was correcting: a hit from outside that client's set
    const unexplained = bad.filter((d) => !srvClient(h, d.peer).det.some((x) => x.key === d.uid && x.reason === 'unseen' && d.T >= x.eventT - 1 && d.T <= x.eventT + 20));
    const counts = [A, B, C].map((p) => srvClient(h, p).counts);
    const other = counts.reduce((s, c) => s + c.mismatch + c.missing + c.spurious + c.hash, 0);
    check(checked > 20000 && unexplained.length === 0,
      `server vs 3 client copies (40 ms, 80 ms ±10, 250 ms ±40), 30 s, 2 players + 4 bots fighting: ${checked} entity-ticks compared, ${diverged} differ, all of them hit from outside that client's set and corrected (${unexplained.length} unexplained)`);
    check(other <= 2, `  desyncs that weren't hits from outside the set: ${other} (${counts.map((c) => JSON.stringify(c)).join(' ')})`);
  }

  {
    // A late joiner in a well-used world: half the rocks already destroyed and a third damaged before it arrives. Its
    // shells must never hit a rock that isn't there (rocks on a shell's line are pulled in, with their override)
    const { h } = setup();
    for (const R of h.server.W.rocks.list) if (R.id % 2 === 0) h.server.W.rockOv.set(R.id, { hp: 0, dead: 1 }); else if (R.id % 3 === 0) h.server.W.rockOv.set(R.id, { hp: 5, dead: 0 });
    const A = addLs(h, new Script(0), 70, 3);
    play(h, 0, 30000, (t, f) => { if (f === 120) { A.client.command('botfight', { side: 0 }); A.client.command('bots', { n: 4 }); } });
    const c = srvClient(h, A).counts;
    check(c.mismatch + c.missing + c.spurious + c.hash === 0, `late joiner, half the rocks gone and a third damaged, 70 ms, bot fight + 4 bots, 30 s: no desyncs but hits from outside the set (${JSON.stringify(c)})`);
  }

  // ------------------------------------------------------------------------------------------------ b. identities
  {
    const { h } = setup();
    let A;
    A = addLs(h, new Script(0), 60, 0);
    const cl = A.client;
    let wrong = 0, compared = 0, botPulledOutside = 0, quarantineBroken = 0;
    const step0 = cl.stepConf.bind(cl);
    cl.stepConf = (b, now) => {
      step0(b, now);
      const c = srvClient(h, A), T = cl.conf.tick;
      // The server's view of this client's slots after tick T's bundle: entered at or before T, not yet exited
      const srv = new Map(c.hist.filter((x) => x.from <= T && x.to > T).map((x) => [x.slot, x.uid]));
      compared++;
      if (srv.size !== cl.slots.size || [...cl.slots].some(([s, u]) => srv.get(s) !== u)) wrong++;
      const me = cl.conf.byUid.get(cl.uid);
      for (const [uid, pulled] of cl.pulled) {
        const e = cl.conf.byUid.get(uid);
        if (pulled && e && me && h.server.bots.has(uid) && Math.hypot(e.x - me.x, e.y - me.y) / FX > Wo.C.AWARE) botPulledOutside++;
      }
    };
    play(h, 0, 25000, (t, f) => { if (f === 90) cl.command('botfight', { side: 0 }); if (f === 600) cl.command('botfight', { side: 1 }); if (f === 1100) cl.command('clearbots'); });
    const c = srvClient(h, A), bySlot = new Map();
    for (const x of c.hist) { const l = bySlot.get(x.slot) || []; l.push(x); bySlot.set(x.slot, l); }
    for (const l of bySlot.values()) for (let i = 1; i < l.length; i++) if (l[i].from - l[i - 1].to < 60) quarantineBroken++;
    check(compared > 1000 && wrong === 0, `slots: the client's slot -> entity map matched the server's slot history on all ${compared} confirmed ticks (${c.entries} entries, ${c.exits} exits, ${bySlot.size} slots used, highest ${Math.max(...bySlot.keys())})`);
    check(quarantineBroken === 0 && [...bySlot.values()].some((l) => l.length > 1), `slots: freed slots reused only after their quarantine (${[...bySlot.values()].filter((l) => l.length > 1).length} slots reused, none early)`);
    check(botPulledOutside > 0 && c.pullIns > 0, `pull-in: a bot attacking a freighter at the edge was tracked while ${f0(Wo.C.AWARE)}+ units away (${botPulledOutside} ticks; ${c.pullIns} pull-ins in all)`);
    const varint = (n) => { const w = new Pr.Writer(); w.vu(n); return w.done().length; };
    check(varint(127) === 1 && varint(128) === 2 && varint(16383) === 2 && varint(16384) === 3 && varint(31 * 4 + 3) === 1, 'varints: 1 byte to 127, 2 to 16,383; a report id (kind in the low 2 bits) under 32 is one byte');
  }

  // ------------------------------------------------------------------------------------------------------ c. drift
  {
    const want = { hp: ['mismatch'], away: ['missing'], into: ['spurious'], silent: ['hash'], drop: ['mismatch', 'missing', 'spurious', 'hash'] };
    const results = [];
    for (const kind of Object.keys(want)) {
      let got = null;
      for (let attempt = 0; attempt < 6 && !got; attempt++) {
        const { h, hist } = setup({ history: true, server: { seed: 100 + attempt } });
        let A;
        A = addLs(h, new Fighter(() => A.client), 50, 0);
        let t = play(h, 0, 2000);
        A.client.command('bots', { n: 5 });
        // (half a second clear of a hash tick, so the reports get the first chance; the silent one has to wait for a hash)
        t = play(h, t, 6500 + attempt * 300);
        const r = A.client.inject(kind, t);
        if (!r) continue;
        const t0 = t;
        t = play(h, t, kind === 'silent' ? 3500 : 2500);
        const caught = A.client.st.caught.find((x) => x.inj === kind);
        if (!caught) continue;
        // Corrected: the entity matches the server again
        const cl = A.client, S = hist.get(cl.conf.tick), key = caught.key;
        const e = key >= 0 ? cl.conf.byUid.get(key) : null, s = key >= 0 && S ? S.byUid.get(key) : null;
        const fixed = key < 0 ? true : !e || !s || Wo.entityHash(cl.conf, e, e.puppet) === Wo.entityHash(S, s, e.puppet);
        got = { kind, reason: caught.reason, ticks: caught.ticks, fixMs: caught.fixMs, fixed, attempt, key };
        void t0;
      }
      results.push(got || { kind, reason: null });
      if (got) check(want[kind].includes(got.reason) && got.fixed,
        `drift "${kind}": caught as ${got.reason} ${got.ticks} ticks (${f0(got.ticks * TICK)} ms) after the event, corrected on screen ${f0(got.fixMs)} ms after the injection, matches the server again: ${got.fixed}${got.attempt ? ` (attempt ${got.attempt + 1})` : ''}`);
      else check(false, `drift "${kind}": not caught`);
    }
  }

  // ----------------------------------------------------------------------------------------------------- d. timing
  {
    const { h } = setup();
    const A = addLs(h, new Script(0), 30, 0), B = addLs(h, new Script(1), 250, 60);
    let aFroze = 0, aLast = 0, worstLagA = 0;
    play(h, 0, 25000, (t) => {
      const st = A.client.stats(t);
      if (st.dispTick !== undefined && st.dispTick <= aLast && t > 3000) aFroze++;
      aLast = st.dispTick;
      if (t > 3000) worstLagA = Math.max(worstLagA, h.server.W.tick - A.client.conf.tick);
    });
    const sa = A.client.stats(25000), sb = B.client.stats(25000);
    const lateB = srvClient(h, B).late;
    // B's late inputs after it settled (first 5 s excluded)
    check(h.server.W.tick >= 1495 && aFroze < 40 && worstLagA <= 6,
      `laggy client: the server kept its 60 Hz (${h.server.W.tick} ticks in 25 s); the 30 ms client never waited on the 250 ms ±60 one (its confirmed tick at most ${worstLagA} behind the server; screen held still on ${aFroze} of 1,500 frames, i.e. frames shorter than a tick)`);
    check(sb.margin >= 2 && lateB < 40, `laggy client: its margin settled at ${sb.margin} ticks (A's: ${sa.margin}); ${lateB} of its inputs were late in 25 s (each used a tick later and the margin raised)`);
    // Held back 500 ms: queues, then catches up at up to 30 ticks a frame; the screen keeps moving meanwhile
    const { h: h2 } = setup();
    const C = addLs(h2, new Script(0), 40, 0);
    let t = play(h2, 0, 4000), stops = 0, prev = 0, maxBehind = 0, caughtUpAt = null;
    C.client.inject('delay', t);
    const t1 = t;
    t = play(h2, t, 2500, (tt) => {
      const st = C.client.stats(tt);
      if (st.dispTick <= prev) stops++;
      prev = st.dispTick; maxBehind = Math.max(maxBehind, st.behind);
      if (caughtUpAt === null && tt > t1 + 500 && st.behind <= 1) caughtUpAt = tt - t1 - 500;
    });
    check(maxBehind >= 25 && caughtUpAt !== null && caughtUpAt < 200 && stops < 45,
      `catch-up: held back 500 ms, the client fell ${maxBehind} ticks behind, then caught up ${f0(caughtUpAt)} ms after the messages arrived (up to ${Math.max(C.client.st.catchup, 0)} ticks in one frame); own prediction kept the screen moving (still on ${stops} of 150 frames)`);
  }

  // ------------------------------------------------------------------------------------------------- e. bandwidth
  const table = [];
  function measure(name, make, secs = 30) {
    const { h } = setup();
    const peers = make(h);
    let t = play(h, 0, 5000);
    const before = peers.map((p) => ({ d: p.client.down.totals(), u: p.client.up.totals() }));
    t = play(h, t, secs * 1000);
    const p = peers[0], b = before[0], d = p.client.down.totals(), u = p.client.up.totals();
    const rate = (x, y) => { const o = {}; let s = 0; for (const k in x.cats) { if (k === 'lab') continue; o[k] = (x.cats[k] - (y.cats[k] || 0)) / secs; s += o[k]; } return { cats: o, sum: s, wire: (x.wire - y.wire) / secs, msgs: (x.msgs - y.msgs) / secs }; };
    const st = p.client.stats(t);
    table.push({ name, down: rate(d, b.d), up: rate(u, b.u), delay: st.delays ? st.delays.on : st.delay, info: st.info });
  }
  const pair = (Cls) => (h) => {
    let A, B;
    A = h.add((send) => new Cls({ send, src: new Fighter(() => A.client), name: 'A' }), 40, 0); A.client.start();
    B = h.add((send) => new Cls({ send, src: new Fighter(() => B.client), name: 'B' }), 40, 0); B.client.start();
    return [A, B];
  };
  const brawl = (Cls) => (h) => {
    const A = h.add((send) => new Cls({ send, src: new Script(0), name: 'watcher' }), 40, 0); A.client.start();
    h.advance(1000); A.client.frame(1000);
    A.client.command('bots', { n: 8 });
    return [A];
  };
  measure('2 players, lockstep', pair(LabClient.LsClient));
  measure('2 players, current', pair(LabClient.CurClient));
  measure('8-bot fight, lockstep', brawl(LabClient.LsClient));
  measure('8-bot fight, current', brawl(LabClient.CurClient));
  console.log('\nbandwidth per client, B/s of payload (wire = with IP/TCP/TLS/WebSocket headers), 30 s after a 5 s warm-up:');
  for (const r of table) {
    const cats = (x) => Object.entries(x.cats).filter(([, v]) => v >= 0.5).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${f0(v)}`).join(', ');
    console.log(`  ${r.name.padEnd(22)} down ${f0(r.down.sum).padStart(5)} (wire ${f0(r.down.wire).padStart(5)}, ${f0(r.down.msgs)} msg/s): ${cats(r.down)}`);
    console.log(`  ${''.padEnd(22)} up   ${f0(r.up.sum).padStart(5)} (wire ${f0(r.up.wire).padStart(5)}, ${f0(r.up.msgs)} msg/s): ${cats(r.up)}`);
  }
  const ls2 = table[0], cur2 = table[1], ls8 = table[2], cur8 = table[3];
  check(ls2.down.sum < cur2.down.sum && ls8.down.sum < cur8.down.sum, `bandwidth: lockstep's payload is below the current style's in both fights (2 players: ${f0(ls2.down.sum)} vs ${f0(cur2.down.sum)} B/s down; 8 bots: ${f0(ls8.down.sum)} vs ${f0(cur8.down.sum)})`);
  return fails;
}
