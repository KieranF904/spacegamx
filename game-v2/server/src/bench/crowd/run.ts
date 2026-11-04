/**
 * Crowd bench: one case. A seeded server, N bot pilots (a few of them full probe clients, the rest counting sockets, legacy
 * or bit-packed), a layout, the measured seconds. Returns the numbers (timings, bytes, messages, agreement).
 */
import { createDeflateRaw, constants as zc } from 'zlib';
import { Position, InSystem, splitServerFrame, type ClientSocket, type ClientMessage } from '@space-game/common';
import { makeServer, clock, rng, Scene, controlsFor, applyDirect, type Layout } from './world.js';
import { Probe, PoseRing, classifier } from './probe.js';

export interface CaseOpts {
  layout: Layout;
  n: number;
  secs: number;
  /** The counting sockets: 'legacy' (no caps), 'packed' (PACKED | COALESCE, nothing they owe), 'blocks' (and BLOCKS) or 'focus' (and FOCUS: they never answer an offer back) */
  bulk: 'legacy' | 'packed' | 'blocks' | 'focus';
  /** Full probe clients among the n */
  probes: number;
  /** Crowd fallbacks on, automatic (CAPS.CROWD): the levels the scene's system reaches, and its cost settling */
  crowd?: boolean;
  /** The probes' caps (default everything) and latency in ticks */
  caps: number;
  lat: number;
  warm: number;
  /** Bulk sockets whose frames are kept to be deflated (the wire figure) */
  sample: number;
}

const WS_HEADER = 66; // TCP/IP + WebSocket framing per message, as the earlier probes counted it
const pct = (a: number[], q: number) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const r2 = (v: number) => +v.toFixed(3);

async function deflated(frames: Buffer[]): Promise<number> {
  const z = createDeflateRaw({ level: 4, windowBits: 13, memLevel: 6 });
  let n = 0, k = 0;
  z.on('data', (d: Buffer) => { n += d.length; });
  for (const fr of frames) {
    if (fr.length < 96) { n += fr.length; continue; }
    z.write(fr); k++;
    await new Promise<void>((r) => z.flush(zc.Z_SYNC_FLUSH, () => r()));
  }
  return n - 4 * k;
}

interface Counter { raw: number; msgs: number; frames: Buffer[]; sub: Record<string, number> }

function numericDiff(a: any, b: any): any {
  const o: any = {};
  for (const k of Object.keys(a ?? {})) {
    if (typeof a[k] === 'number') o[k] = a[k] - (b?.[k] ?? 0);
    else if (a[k] && typeof a[k] === 'object' && !Array.isArray(a[k])) o[k] = numericDiff(a[k], b?.[k]);
  }
  return o;
}
const snap = (v: unknown) => JSON.parse(JSON.stringify(v ?? {}));

export async function runCase(o: CaseOpts): Promise<any> {
  const seed = rng(0x2545f491);
  Math.random = seed;
  clock.t = 1_000_000;
  const wallStart = performance.now();
  const server = makeServer(o.crowd ? 131071 : 16383);
  const ships = server.getShips() as any, srv = server as any;

  // ---- the meter: wrapped before anything else, so the probes' own wrappers sit outside it ----
  let measuring = false;
  const tickMs: number[] = [], snapMs: number[] = [], replMs: number[] = [], flushMs: number[] = [], rebuildMs: number[] = [], rebuildCount: number[] = [], rebuildRepeat: number[] = [];
  let aSnap = 0, aRepl = 0, aFlush = 0, aReb = 0, nReb = 0, nRepeat = 0;
  // (Rebuilds of a ship already rebuilt this tick: the batching's target is none)
  const rebuiltThisTick = new Set<number>();
  const timed = (obj: any, name: string, add: (ms: number) => void) => {
    const orig = obj[name].bind(obj);
    obj[name] = (...a: any[]) => { const t0 = performance.now(); try { return orig(...a); } finally { add(performance.now() - t0); } };
  };
  timed(srv.snapshots, 'sendSnapshots', (ms) => { aSnap += ms; });
  timed(srv.replication, 'forClient', (ms) => { aRepl += ms; });
  timed(srv.net, 'flushOutbox', (ms) => { aFlush += ms; });
  timed(ships, 'rebuildNow', (ms) => { aReb += ms; nReb++; });
  {
    const orig = ships.rebuildNow;
    ships.rebuildNow = (eid: number, ...a: any[]) => { if (rebuiltThisTick.has(eid)) nRepeat++; else rebuiltThisTick.add(eid); return orig(eid, ...a); };
  }
  {
    const orig = server.step.bind(server);
    server.step = () => {
      aSnap = aRepl = aFlush = aReb = 0; nReb = 0; nRepeat = 0; rebuiltThisTick.clear();
      const t0 = performance.now();
      orig();
      if (measuring) { tickMs.push(performance.now() - t0); snapMs.push(aSnap); replMs.push(aRepl); flushMs.push(aFlush); rebuildMs.push(aReb); rebuildCount.push(nReb); rebuildRepeat.push(nRepeat); }
    };
  }

  // ---- the pilots: probes spread through the list, the rest counting sockets ----
  const k = Math.min(o.probes, o.n);
  const probeIdx = new Set<number>();
  for (let i = 0; i < k; i++) probeIdx.add(Math.floor((i * o.n) / k));
  let scene!: Scene;
  // (The scene's system's tick: its own clock once dilated, --crowd)
  let sysNum = -1;
  const sysTick = () => (sysNum >= 0 && server.clocks ? server.clocks.tickOf(sysNum) : server.getTick());
  const ring = new PoseRing(server, sysTick);
  const klass = classifier(server, () => scene?.bossId ?? -1);
  const bulkCaps = o.bulk === 'packed' ? 4 | 8 : o.bulk === 'blocks' ? 4 | 8 | 512 : o.bulk === 'focus' ? 4 | 8 | 512 | 1024 : 0;
  const counters = new Map<number, Counter>();
  const sampledBulk = new Set<number>();
  const probes = new Map<number, Probe>();
  const pids: number[] = [];
  for (let i = 0; i < o.n; i++) {
    if (probeIdx.has(i)) {
      const p = new Probe(server, `probe${i}`, o.caps, o.lat, ring, klass, 0, sysTick);
      probes.set(i, p);
      pids.push(p.pid);
    } else {
      const c: Counter = { raw: 0, msgs: 0, frames: [], sub: {} };
      const idx = i;
      const socket: ClientSocket = {
        isOpen: () => true,
        send: (data) => {
          if (!measuring) return;
          const u = data as Uint8Array;
          c.raw += u.length; c.msgs++;
          if (sampledBulk.has(idx)) {
            c.frames.push(Buffer.from(u));
            if (u[0] !== 4) for (const { msg, bytes } of splitServerFrame(u)) c.sub[msg.type] = (c.sub[msg.type] ?? 0) + bytes;
          }
        },
      };
      const link = server.connect(socket);
      link.receive({ type: 'join', username: `bot${i}`, ...(bulkCaps ? { caps: bulkCaps } : {}) } as ClientMessage);
      counters.set(i, c);
      pids.push(server.getPlayerId(socket));
    }
  }
  const bulkIdx = [...counters.keys()];
  for (let s = 0; s < Math.min(o.sample, bulkIdx.length); s++) sampledBulk.add(bulkIdx[Math.floor((s * bulkIdx.length) / Math.min(o.sample, bulkIdx.length))]);
  for (let i = 0; i < 20; i++) { server.step(); clock.t += 1000 / 60; }
  scene = new Scene(server, o.layout, o.n);
  scene.setup(pids, probeIdx);
  sysNum = scene.num;

  const stepOnce = () => {
    const now = sysTick();
    scene.tick(now, (b) => {
      const p = probes.get(b.index);
      const c = scene.controls(b);
      if (p) p.fly(b.target, now, c);
      else applyDirect(b.pid, c);
    });
    server.step();
    clock.t += 1000 / 60;
    ring.record();
    for (const p of probes.values()) p.afterStep();
  };
  for (let i = 0; i < o.warm; i++) stepOnce();

  // ---- measure ----
  measuring = true;
  for (const p of probes.values()) p.measuring = true;
  const focus0 = snap(srv.snapshots.focus.stats), cells0 = [...probes.values()].map((p) => snap(p.fake.cells.stats));
  const held: number[] = [];
  const hits0 = snap(srv.hits.stats), reasons0 = snap(srv.replication.reasons), bodies0 = snap({ net: srv.bodies?.stats, rep: srv.replication.bodyStats });
  const m0 = server.getTick();
  const ticks = o.secs * 60;
  // (--crowd: the base ticks' times, and the scene's system's level, by second)
  const crowdSecs: { lv: number; cost: number; tickMs: number; steps: number }[] = [];
  let secStart = tickMs.length, secSys = sysTick();
  for (let i = 0; i < ticks; i++) {
    stepOnce();
    if (o.crowd && i % 60 === 59) {
      const ms = tickMs.slice(secStart);
      crowdSecs.push({ lv: srv.crowd?.levelOf(sysNum) ?? 0, cost: r2(srv.crowd?.costOf(sysNum) ?? 0), tickMs: r2(mean(ms)), steps: sysTick() - secSys });
      secStart = tickMs.length; secSys = sysTick();
    }
    // (what each probe holds on its tick layer: the focus grid's view, or the 40 km circle)
    if (i % 30 === 0) for (const p of probes.values()) held.push([...p.fake.reps.ids()].length);
  }
  measuring = false;
  const secs = o.secs;
  const alive = [...pids].filter((p) => ships.has(p)).length;

  // ---- numbers ----
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
  const timing = {
    tickMeanMs: r2(mean(tickMs)), tickP95Ms: r2(pct(tickMs, 0.95)), tickMaxMs: r2(Math.max(...tickMs)),
    budgetPct: r2((mean(tickMs) / (1000 / 60)) * 100),
    snapshotsMsPerTick: r2(mean(snapMs)), replicationMsPerTick: r2(mean(replMs)), encodeSendMsPerTick: r2(mean(flushMs)),
    rebuildMsPerTick: r2(mean(rebuildMs)), rebuildsPerSec: r2(sum(rebuildCount) / secs), rebuildRepeats: sum(rebuildRepeat),
  };
  const bulk: Counter[] = [...counters.values()];
  const bulkRaw = bulk.map((c) => c.raw / secs), bulkMsgs = bulk.map((c) => c.msgs / secs);
  // (Packed frames from a CAPS.BLOCKS link go undeflated: PackedLink.emit)
  const wireOf = async (frames: Buffer[], msgs: number, raw = false) => {
    const d = raw ? frames.reduce((n, f) => n + (f[0] === 4 ? f.length : 0), 0) + (await deflated(frames.filter((f) => f[0] !== 4))) : await deflated(frames);
    return d / secs + (WS_HEADER * msgs) / secs;
  };
  const blocksOn = (caps: number) => (caps & (4 | 512)) === (4 | 512);
  const bulkSampled = [...sampledBulk].map((i) => counters.get(i)!);
  const bulkWire: number[] = [];
  // (What deflating a bulk client's frames costs the server, per message as permessage-deflate does: timed on the
  // sampled sockets, times the bulk clients, per tick. CAPS.BLOCKS frames go undeflated, so for those it's saved)
  const d0 = performance.now();
  for (const c of bulkSampled) bulkWire.push(await wireOf(c.frames, c.msgs, blocksOn(bulkCaps)));
  const deflateMsPerTick = bulkSampled.length ? ((performance.now() - d0) / bulkSampled.length) * counters.size / (secs * 60) : 0;
  const subOf = (subs: Record<string, number>[]) => {
    const t: Record<string, number> = {};
    for (const s of subs) for (const [k, b] of Object.entries(s)) t[k] = (t[k] ?? 0) + b / secs / Math.max(1, subs.length);
    return Object.fromEntries(Object.entries(t).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, b]) => [k, Math.round(b)]));
  };
  const sub: Record<string, number> = {};
  for (const c of bulkSampled) for (const [t, b] of Object.entries(c.sub)) sub[t] = (sub[t] ?? 0) + b / secs / Math.max(1, bulkSampled.length);
  const probeList = [...probes.values()];
  const probeWire: number[] = [];
  for (const p of probeList) probeWire.push(await wireOf(p.frames, p.messages, blocksOn(o.caps)));
  const bytesBlock = (raw: number[], wire: number[], msgs: number[]) => ({
    clients: raw.length, rawBpsMean: Math.round(mean(raw)), rawBpsP95: Math.round(pct(raw, 0.95)), rawBpsMax: Math.round(Math.max(0, ...raw)),
    wireBpsMean: Math.round(mean(wire)), wireSampled: wire.length, msgsPerSecMean: r2(mean(msgs)),
  });
  const agree: Record<string, { checked: number; off: number; offNoKf: number }> = {};
  for (const p of probeList) for (const [kk, a] of Object.entries(p.agree)) { const e = (agree[kk] ??= { checked: 0, off: 0, offNoKf: 0 }); e.checked += a.checked; e.off += a.off; e.offNoKf += a.offNoKf; }
  const hitsDiff = numericDiff(snap(srv.hits.stats), hits0);
  const out = {
    layout: o.layout, n: o.n, secs, bulk: o.bulk, probes: k, caps: o.caps, lat: o.lat,
    scene: { alive, hostiles: srv.enemies.count(scene.num), boss: scene.bossId >= 0 && ships.has(scene.bossId), ships: ships.bodies.size },
    timing: { ...timing, deflateMsPerTickEst: r2(deflateMsPerTick) },
    bytes: {
      legacyOrBulk: { kind: o.bulk, ...bytesBlock(bulkRaw, bulkWire, bulkMsgs), subTypesBps: Object.fromEntries(Object.entries(sub).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([t, b]) => [t, Math.round(b)])) },
      capable: { ...bytesBlock(probeList.map((p) => p.rawBytes / secs), probeWire, probeList.map((p) => p.messages / secs)), subTypesBps: subOf(probeList.map((p) => p.sub)) },
      capableUp: { msgsPerSec: r2(mean(probeList.map((p) => p.upMsgs / secs))), bps: Math.round(mean(probeList.map((p) => p.upBytes / secs))) },
    },
    messages: { capableFramesPerSec: r2(mean(probeList.map((p) => p.fake.frames / (secs + 3)))) },
    agreement: {
      byKind: agree,
      // (the tick layer proper: own ship, other pilots, AI, the boss; `other` is wrecks, debris and the rest)
      disagreeNoKeyframe: ['self', 'player', 'ai', 'boss'].reduce((n, k) => n + (agree[k]?.offNoKf ?? 0), 0),
      checked: ['self', 'player', 'ai', 'boss'].reduce((n, k) => n + (agree[k]?.checked ?? 0), 0),
      otherDisagree: agree.other?.offNoKf ?? 0, otherChecked: agree.other?.checked ?? 0,
      keyframeCorrectionsPerSecPerProbe: r2(mean(probeList.map((p) => p.keyframesCorrect / secs))),
      correctionsByClass: probeList.reduce((acc, p) => { for (const [k, v] of Object.entries(p.corrections)) { const a = (acc[k] ??= { n: 0, same: 0 }); a.n += v!.n; a.same += v!.same; } return acc; }, {} as Record<string, { n: number; same: number }>),
      keyframeEntriesPerSecPerProbe: r2(mean(probeList.map((p) => p.keyframesEntry / secs))),
      server: { causes: snap(srv.replication.causeStats), own: snap(srv.replication.ownStats), hits: hitsDiff, reasons: numericDiff(snap(srv.replication.reasons), reasons0), bodies: numericDiff(snap({ net: srv.bodies?.stats, rep: srv.replication.bodyStats }), bodies0) },
    },
    focus: (() => {
      const d = numericDiff(snap(srv.snapshots.focus.stats), focus0), c: Record<string, number> = {};
      [...probes.values()].forEach((p, i) => { for (const [kk, v] of Object.entries(numericDiff(snap(p.fake.cells.stats), cells0[i]))) c[kk] = (c[kk] ?? 0) + (v as number); });
      const per = (v: number) => r2(v / secs);
      return { heldMean: r2(mean(held)), server: d, probes: c, dropsPerSec: per(d.drops ?? 0), entriesPerSec: per(d.entries ?? 0), offersPerSec: per(d.offers ?? 0), logsPerSec: per(d.logs ?? 0),
        logShipsPerSec: per(d.logShips ?? 0), refused: (d.refusedHash ?? 0) + (d.refusedSize ?? 0) + (d.refusedLate ?? 0) + (d.refusedNone ?? 0) };
    })(),
    probeClientMsPerTick: r2(mean(probeList.map((p) => p.clientMs / ticks))),
    crowd: o.crowd ? {
      bySecond: crowdSecs,
      log: srv.crowd?.log ?? [],
      // (the last third of the measured seconds: where it settled)
      settledTickMs: r2(mean(crowdSecs.slice(-Math.max(1, Math.floor(crowdSecs.length / 3))).map((c) => c.tickMs))),
      settledLevel: crowdSecs.at(-1)?.lv ?? 0,
    } : undefined,
    wallSeconds: r2((performance.now() - wallStart) / 1000),
    ticks: server.getTick() - m0,
  };
  void Position; void InSystem;
  return out;
}
