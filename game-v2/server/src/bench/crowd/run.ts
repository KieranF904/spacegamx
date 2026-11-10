/**
 * Crowd bench: one case. A seeded server, N bot pilots (a few of them full probe clients, the rest counting sockets: every
 * one joins with the full caps set, there's no other), a layout, the measured seconds. Returns the numbers (timings, bytes, messages, agreement).
 */
import { createDeflateRaw, constants as zc } from 'zlib';
import { Position, InSystem, DEFAULT_CAPS, splitServerFrame, type ClientSocket, type ClientMessage } from '@space-game/common';
import { ServerFrameReader } from '../../../../common/src/network/packed/packedCodec.js';
import { makeServer, clock, rng, Scene, controlsFor, applyDirect, type Layout } from './world.js';
import { Probe, PoseRing, classifier } from './probe.js';
import { PT_TUNING } from '../../../../client/src/predict/shipKinds.js';

export interface CaseOpts {
  layout: Layout;
  n: number;
  secs: number;
  /** Full probe clients among the n */
  probes: number;
  /** Crowd fallbacks on, automatic (CAPS.CROWD): the levels the scene's system reaches, and its cost settling */
  crowd?: boolean;
  /** The probes' latency in ticks */
  lat: number;
  warm: number;
  /** Bulk sockets whose frames are kept to be deflated (the wire figure) */
  sample: number;
  /** The probes run the game's prediction of other ships (client predict/, C3; default on) */
  pt?: boolean;
  /** Its level of detail's reach (client predict/shipKinds.ts PT_TUNING.reach; default the game's) */
  ptReach?: number;
  /** Hash every byte sent to the counting sockets, from the first (a check that a change left the frames as they were) */
  hash?: boolean;
  /** Write the first counting socket's messages, decoded, one per line, to this file (to diff two runs' frames) */
  dump?: string;
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
  // (--hash: the wall clock the server still reads (a welcome's serverTime and the like) the bench's too, so frames repeat)
  if (o.hash) Date.now = () => Math.floor(clock.t);
  const wallStart = performance.now();
  if (o.ptReach !== undefined) PT_TUNING.reach = o.ptReach;
  // (Every client runs the full caps set; crowd fallbacks only with --crowd)
  const server = makeServer(!!o.crowd);
  const ships = server.getShips() as any, srv = server as any;

  // ---- the meter: wrapped before anything else, so the probes' own wrappers sit outside it ----
  let measuring = false;
  const tickMs: number[] = [], tickCpu: number[] = [], snapCpu: number[] = [], snapMs: number[] = [], replMs: number[] = [], flushMs: number[] = [], rebuildMs: number[] = [], rebuildCount: number[] = [], rebuildRepeat: number[] = [];
  let aSnap = 0, aRepl = 0, aFlush = 0, aReb = 0, nReb = 0, nRepeat = 0;
  // (Rebuilds of a ship already rebuilt this tick: the batching's target is none)
  const rebuiltThisTick = new Set<number>();
  const timed = (obj: any, name: string, add: (ms: number) => void) => {
    const orig = obj[name].bind(obj);
    obj[name] = (...a: any[]) => { const t0 = performance.now(); try { return orig(...a); } finally { add(performance.now() - t0); } };
  };
  timed(srv.snapshots, 'sendSnapshots', (ms) => { aSnap += ms; });
  // (CPU time too, the process's: on a busy machine the wall time takes in time the bench wasn't running)
  let cSnap = 0;
  const cpuMs = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };
  { const orig = srv.snapshots.sendSnapshots; srv.snapshots.sendSnapshots = (...a: any[]) => { const c0 = cpuMs(); try { return orig(...a); } finally { cSnap += cpuMs() - c0; } }; }
  timed(srv.replication, 'forClient', (ms) => { aRepl += ms; });
  timed(srv.net, 'flushOutbox', (ms) => { aFlush += ms; });
  timed(ships, 'rebuildNow', (ms) => { aReb += ms; nReb++; });
  // (Debris: the shared drift-and-knock step's cost, and how many pieces there are)
  let aDeb = 0;
  const debrisMs: number[] = [], debrisN: number[] = [];
  timed(ships, 'stepDebrisWorld', (ms) => { aDeb += ms; });
  {
    const orig = ships.rebuildNow;
    ships.rebuildNow = (eid: number, ...a: any[]) => { if (rebuiltThisTick.has(eid)) nRepeat++; else rebuiltThisTick.add(eid); return orig(eid, ...a); };
  }
  {
    const orig = server.step.bind(server);
    server.step = () => {
      aSnap = aRepl = aFlush = aReb = aDeb = 0; cSnap = 0; nReb = 0; nRepeat = 0; rebuiltThisTick.clear();
      const t0 = performance.now(), c0 = cpuMs();
      orig();
      if (measuring) { tickMs.push(performance.now() - t0); tickCpu.push(cpuMs() - c0); snapCpu.push(cSnap); snapMs.push(aSnap); replMs.push(aRepl); flushMs.push(aFlush); rebuildMs.push(aReb); rebuildCount.push(nReb); rebuildRepeat.push(nRepeat); debrisMs.push(aDeb); debrisN.push(ships.stats.debrisCount ?? 0); }
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
  const counters = new Map<number, Counter>();
  const sampledBulk = new Set<number>();
  const probes = new Map<number, Probe>();
  const pids: number[] = [];
  // (--hash: FNV-1a over every frame every counting socket was sent, in order, its index first; --dump: the first one's, decoded)
  let frameHash = 0x811c9dc5, frameBytes = 0;
  const dumpLines: string[] = [];
  const dumpReader = new ServerFrameReader();
  const hashFrame = (idx: number, u: Uint8Array) => {
    let h = Math.imul(frameHash ^ idx, 0x01000193);
    for (let j = 0; j < u.length; j++) h = Math.imul(h ^ u[j], 0x01000193);
    frameHash = h; frameBytes += u.length;
  };
  for (let i = 0; i < o.n; i++) {
    if (probeIdx.has(i)) {
      const p = new Probe(server, `probe${i}`, o.lat, ring, klass, 0, sysTick, o.pt !== false);
      probes.set(i, p);
      pids.push(p.pid);
    } else {
      const c: Counter = { raw: 0, msgs: 0, frames: [], sub: {} };
      const idx = i;
      const socket: ClientSocket = {
        isOpen: () => true,
        send: (data) => {
          if (o.hash) hashFrame(idx, data as Uint8Array);
          if (o.dump && idx === 1) { const u = data as Uint8Array; let line: string; try { line = dumpReader.read(u).flat().map((m) => JSON.stringify(m)).join('\n'); } catch (e) { line = 'RAW ' + u.length + ' ' + String(e); } dumpLines.push(line); }
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
      // (the full caps set, owing nothing back: no hit reports or own checks, so its share may carry corrections)
      link.receive({ type: 'join', username: `bot${i}`, caps: DEFAULT_CAPS } as ClientMessage);
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
  const focus0 = snap(srv.snapshots.focus.stats), away0 = snap(srv.snapshots.away.stats), mem0 = [...probes.values()].map((p) => snap(p.fake.away.stats));
  const held: number[] = [];
  const guns0 = snap(srv.gunNet?.stats ?? {});
  const aim0 = snap(ships.stats?.aimHold ?? {});
  // (What each joined client's packed frames came to, by message type and the BLOCKS snapshot's parts: the real wire bits)
  const probePids = new Set([...probes.values()].map((p) => p.pid));
  const packedOf = (only?: Set<number>) => {
    const by: Record<string, number> = {};
    for (const c of srv.clients.values() as Iterable<any>) {
      if (only && !only.has(c.playerId)) continue;
      const e = c.packed?.enc;
      if (!e) continue;
      for (const [t, b] of Object.entries(e.bitsByType as Record<string, number>)) by[t] = (by[t] ?? 0) + b;
      for (const [t, b] of Object.entries(e.blockBits as Record<string, number>)) if (!['intros', 'delta', 'abs'].includes(t)) by['snapshot.' + t] = (by['snapshot.' + t] ?? 0) + b;
    }
    return by;
  };
  const packed0 = packedOf(), packedProbe0 = packedOf(probePids);
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
    debrisStepMsPerTick: r2(mean(debrisMs)), debrisMean: r2(mean(debrisN)), debrisMax: Math.max(0, ...debrisN),
    tickCpuMs: r2(mean(tickCpu)), snapshotsCpuMsPerTick: r2(mean(snapCpu)),
  };
  const bulk: Counter[] = [...counters.values()];
  const bulkRaw = bulk.map((c) => c.raw / secs), bulkMsgs = bulk.map((c) => c.msgs / secs);
  // (Packed frames from a CAPS.BLOCKS link go undeflated: PackedLink.emit)
  const wireOf = async (frames: Buffer[], msgs: number, raw = false) => {
    const d = raw ? frames.reduce((n, f) => n + (f[0] === 4 ? f.length : 0), 0) + (await deflated(frames.filter((f) => f[0] !== 4))) : await deflated(frames);
    return d / secs + (WS_HEADER * msgs) / secs;
  };
  const bulkSampled = [...sampledBulk].map((i) => counters.get(i)!);
  const bulkWire: number[] = [];
  // (What deflating a bulk client's frames costs the server, per message as permessage-deflate does: timed on the
  // sampled sockets, times the bulk clients, per tick. Encode-once (CAPS.BLOCKS) frames go undeflated, so it's saved)
  const d0 = performance.now();
  for (const c of bulkSampled) bulkWire.push(await wireOf(c.frames, c.msgs, true));
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
  for (const p of probeList) probeWire.push(await wireOf(p.frames, p.messages, true));
  const bytesBlock = (raw: number[], wire: number[], msgs: number[]) => ({
    clients: raw.length, rawBpsMean: Math.round(mean(raw)), rawBpsP95: Math.round(pct(raw, 0.95)), rawBpsMax: Math.round(Math.max(0, ...raw)),
    wireBpsMean: Math.round(mean(wire)), wireSampled: wire.length, msgsPerSecMean: r2(mean(msgs)),
  });
  const agree: Record<string, { checked: number; off: number; offNoKf: number }> = {};
  for (const p of probeList) for (const [kk, a] of Object.entries(p.agree)) { const e = (agree[kk] ??= { checked: 0, off: 0, offNoKf: 0 }); e.checked += a.checked; e.off += a.off; e.offNoKf += a.offNoKf; }
  const hitsDiff = numericDiff(snap(srv.hits.stats), hits0);
  const out = {
    layout: o.layout, n: o.n, secs, probes: k, caps: DEFAULT_CAPS, lat: o.lat,
    scene: { alive, hostiles: srv.enemies.count(scene.num), boss: scene.bossId >= 0 && ships.has(scene.bossId), ships: ships.bodies.size },
    timing: { ...timing, deflateMsPerTickEst: r2(deflateMsPerTick) },
    bytes: {
      legacyOrBulk: { kind: 'full', ...bytesBlock(bulkRaw, bulkWire, bulkMsgs), subTypesBps: Object.fromEntries(Object.entries(sub).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([t, b]) => [t, Math.round(b)])) },
      capable: { ...bytesBlock(probeList.map((p) => p.rawBytes / secs), probeWire, probeList.map((p) => p.messages / secs)), subTypesBps: subOf(probeList.map((p) => p.sub)),
        debrisBps: Object.fromEntries(Object.entries(subOf(probeList.map((p) => Object.fromEntries(Object.entries(p.sub).filter(([t]) => t.endsWith(':debris')))))).map(([t, b]) => [t.replace(':debris', ''), b])) },
      capableUp: { msgsPerSec: r2(mean(probeList.map((p) => p.upMsgs / secs))), bps: Math.round(mean(probeList.map((p) => p.upBytes / secs))) },
    },
    messages: { capableFramesPerSec: r2(mean(probeList.map((p) => p.fake.frames / (secs + 3)))) },
    agreement: {
      byKind: agree,
      // (the tick layer proper: own ship, other pilots, AI, the boss; `other` is wrecks, debris and the rest)
      disagreeNoKeyframe: ['self', 'player', 'ai', 'boss'].reduce((n, k) => n + (agree[k]?.offNoKf ?? 0), 0),
      checked: ['self', 'player', 'ai', 'boss'].reduce((n, k) => n + (agree[k]?.checked ?? 0), 0),
      otherDisagree: (agree.other?.offNoKf ?? 0) + (agree.debris?.offNoKf ?? 0), otherChecked: (agree.other?.checked ?? 0) + (agree.debris?.checked ?? 0),
      debrisOffAt: probeList.flatMap((p) => p.debrisOffs).slice(0, 30),
      debrisDisagree: agree.debris?.offNoKf ?? 0, debrisOff: agree.debris?.off ?? 0, debrisChecked: agree.debris?.checked ?? 0,
      keyframeCorrectionsPerSecPerProbe: r2(mean(probeList.map((p) => p.keyframesCorrect / secs))),
      correctionsByClass: probeList.reduce((acc, p) => { for (const [k, v] of Object.entries(p.corrections)) { const a = (acc[k] ??= { n: 0, same: 0 }); a.n += v!.n; a.same += v!.same; } return acc; }, {} as Record<string, { n: number; same: number }>),
      keyframeEntriesPerSecPerProbe: r2(mean(probeList.map((p) => p.keyframesEntry / secs))),
      server: { ownChecks: snap(srv.snapshots.ownChecks?.stats ?? {}), causes: snap(srv.replication.causeStats), own: snap(srv.replication.ownStats), hits: hitsDiff, reasons: numericDiff(snap(srv.replication.reasons), reasons0), bodies: numericDiff(snap({ net: srv.bodies?.stats, rep: srv.replication.bodyStats }), bodies0) },
    },
    focus: (() => {
      const d = numericDiff(snap(srv.snapshots.focus.stats), focus0), a = numericDiff(snap(srv.snapshots.away.stats), away0), c: Record<string, number> = {};
      [...probes.values()].forEach((p, i) => { for (const [kk, v] of Object.entries(numericDiff(snap(p.fake.away.stats), mem0[i]))) c[kk] = (c[kk] ?? 0) + (v as number); });
      const per = (v: number) => r2(v / secs);
      // (server: every capable client's cells and ships away; probes: what their memories did, summed)
      return { heldMean: r2(mean(held)), server: d, away: a, probes: c, cellsLeftPerSec: per(d.left ?? 0), keptPerSec: per(a.kept ?? 0), backPerSec: per(a.back ?? 0), missed: c.missed ?? 0 };
    })(),
    // (Re-entry, CAPS.FOCUS: ships back on a probe's tick layer it had held before, summed over the probes)
    reentry: (() => {
      const t: Record<string, number> = {};
      for (const p of probeList) for (const [kk, v] of Object.entries(p.reentry)) t[kk] = kk === 'maxStepMs' ? Math.max(t[kk] ?? 0, v) : (t[kk] ?? 0) + v;
      const ships = t.ships || 1;
      return { ...Object.fromEntries(Object.entries(t).map(([kk, v]) => [kk, r2(v)])), perProbeShipsPerSec: r2(t.ships / secs / Math.max(1, probeList.length)),
        bytesPerShip: r2(t.bytes / ships), bytesPerProbePerSec: r2(t.bytes / secs / Math.max(1, probeList.length)),
        firstStepUsMean: r2((t.firstStepMs / Math.max(1, t.firstSteps)) * 1000), firstStepMsPerProbePerSec: r2(t.firstStepMs / secs / Math.max(1, probeList.length)) };
    })(),
    // (Other ships' guns, server net/guns/GunNet.ts: a pilot's aim distance while no trigger is held, per pilot per
    // second: the ticks it changed (each one a gun row event before the idle rule) and the updates that went; held,
    // the ticks it changed (each one an exact update before the held-distance rule) and the exact updates that went)
    guns: (() => {
      const d = numericDiff(snap(srv.gunNet?.stats ?? {}), guns0) as Record<string, number>, per = (v: number) => r2((v ?? 0) / secs / Math.max(1, o.n));
      return { ...d, idleChangesPerPilotSec: per(d.idleChanges), idleSentPerPilotSec: per(d.idleSent), exactChangesPerPilotSec: per(d.exactChanges), exactSentPerPilotSec: per(d.exactSent) };
    })(),
    // (Pilots' aims, common sim/aimHold.ts: pilot ticks, those whose raw aim had moved off the held one, of those held
    // (nothing to send), taken for the flight or for the guns; heldShare: held / moved)
    aimHold: (() => {
      const d = numericDiff(snap(ships.stats?.aimHold ?? {}), aim0) as Record<string, number>;
      return { ...d, heldShare: r2((d.held ?? 0) / Math.max(1, d.moved ?? 0)) };
    })(),
    // (Bytes per client per second by message type, as the packed frames carry them; snapshot.* its BLOCKS parts)
    // (packedProbeBps: the probes only, which answer as a game client does: the bulk sockets owe nothing back, so they get hitFix corrections)
    ...(() => {
      const per = (now: Record<string, number>, was: Record<string, number>, nc: number) => {
        const d = numericDiff(now, was) as Record<string, number>;
        return Object.fromEntries(Object.entries(d).filter(([, b]) => b > 0).sort((a, b) => b[1] - a[1]).map(([t, b]) => [t, r2(b / 8 / secs / Math.max(1, nc))]));
      };
      return { packedBps: per(packedOf(), packed0, [...srv.clients.values()].filter((c: any) => c.packed).length), packedProbeBps: per(packedOf(probePids), packedProbe0, probePids.size) };
    })(),
    probeClientMsPerTick: r2(mean(probeList.map((p) => p.clientMs / ticks))),
    probeDebrisMsPerTick: r2(mean(probeList.map((p) => p.debrisMs / ticks))),
    // (The game's prediction of other ships, C3, per probe: client predict/ptst.ts)
    pt: (() => {
      const ls = probeList.filter((p) => p.pt && p.ptAt);
      if (!ls.length) return undefined;
      const d = (p: Probe, kk: string) => (p.pt!.stats as unknown as Record<string, number>)[kk] - (p.ptAt![kk] ?? 0);
      const per = (kk: string) => r2(mean(ls.map((p) => d(p, kk) / secs)));
      const checks = ls.reduce((n, p) => n + d(p, 'checks'), 0), misses = ls.reduce((n, p) => n + d(p, 'misses'), 0);
      return {
        msPerTick: r2(mean(ls.map((p) => p.ptMs / ticks))), ships: r2(mean(ls.map((p) => p.pt!.ids().size))), lodOut: r2(mean(ls.map((p) => p.ptWorld!.lodOut))),
        matchPct: checks ? r2((100 * (checks - misses)) / checks) : 0, missesPerSec: per('misses'), restepShipsPerSec: per('restepShips'), touchShipsPerSec: per('touchShips'),
        restepTicksPerSec: per('restepTicks'), correctionsPerSec: per('corrections'), contactsPerSec: per('contacts'),
        correctionMean: r2(ls.reduce((n, p) => n + d(p, 'correctionDist'), 0) / Math.max(1, ls.reduce((n, p) => n + d(p, 'corrections'), 0))),
        restepMsPerTick: r2(mean(ls.map((p) => d(p, 'restepMs') / ticks))), advanceMsPerTick: r2(mean(ls.map((p) => d(p, 'advanceMs') / ticks))),
        contactMsPerTick: r2(mean(ls.map((p) => d(p, 'contactMs') / ticks))), syncMsPerTick: r2(mean(ls.map((p) => d(p, 'syncMs') / ticks))),
      };
    })(),
    crowd: o.crowd ? {
      bySecond: crowdSecs,
      log: srv.crowd?.log ?? [],
      // (the last third of the measured seconds: where it settled)
      settledTickMs: r2(mean(crowdSecs.slice(-Math.max(1, Math.floor(crowdSecs.length / 3))).map((c) => c.tickMs))),
      settledLevel: crowdSecs.at(-1)?.lv ?? 0,
    } : undefined,
    frameHash: o.hash ? { hash: (frameHash >>> 0).toString(16), bytes: frameBytes } : undefined,
    wallSeconds: r2((performance.now() - wallStart) / 1000),
    ticks: server.getTick() - m0,
  };
  if (o.dump) (await import('fs')).writeFileSync(o.dump, dumpLines.join('\n'));
  void Position; void InSystem;
  return out;
}
