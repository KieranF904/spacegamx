/**
 * Crowd bench: a probe pilot. A FakeHitsClient (the client's real tick layer: replicas, hits, own ship, bodies) on a real
 * connection, flown by input messages `lat` ticks ahead of their tick, its frames handed in `lat` ticks late, what it owes
 * the server (hit reports, own-state and body checks) riding on its inputs. After each snapshot it compares every ship it
 * holds on the tick layer with the server's ship at that tick (the agreement count), and counts the corrections it was given.
 */
import { Position, Velocity, Rotation, InSystem, EntityType, encodeMessage, decodeMessage, type ClientMessage, type ReplicaEnv } from '@space-game/common';
import { FakeHitsClient } from '../../net/hits/fakeHitsClient.testkit.js';
import type { GameServer } from '../../GameServer.js';
import { controlsFor, inputKey, type Ctl } from './world.js';

export type Pose = Float64Array;
/** The server's ship poses, every tick of the last 32, shared by all probes */
export class PoseRing {
  private ticks = new Map<number, Map<number, Pose>>();
  /** `tick`: the scene's system's tick (its own clock once dilated: --crowd) */
  constructor(private server: GameServer, private tick: () => number = () => server.getTick()) {}
  record(): void {
    const ships = this.server.getShips(), t = this.tick(), m = new Map<number, Pose>();
    for (const [eid] of ships.bodies) m.set(eid, Float64Array.of(Position.x[eid], Position.y[eid], Velocity.x[eid], Velocity.y[eid], Rotation.angle[eid], ships.get(eid)?.angVel ?? 0));
    this.ticks.set(t, m);
    this.ticks.delete(t - 32);
  }
  at(tick: number, id: number): Pose | undefined { return this.ticks.get(tick)?.get(id); }
}

export interface Agreement { checked: number; off: number; offNoKf: number }
const klass = ['self', 'player', 'ai', 'boss', 'debris', 'other'] as const;
export type Klass = typeof klass[number];

export class Probe {
  readonly fake: FakeHitsClient;
  pid: number;
  private down: { at: number; data: Uint8Array }[] = [];
  private up: { at: number; msg: ClientMessage }[] = [];
  private repQ: { at: number; v: unknown }[] = [];
  private chkQ: { at: number; v: unknown }[] = [];
  private bckQ: { at: number; v: unknown }[] = [];
  private lastKey = '';
  private sentAt = -9;
  private seq = 1;
  measuring = false;
  frames: Buffer[] = [];
  rawBytes = 0;
  /** Bytes by message type, each message as the plain codec encodes it (blocks frames pack them: a guide to the share, not the wire) */
  readonly sub: Record<string, number> = {};
  messages = 0;
  upMsgs = 0;
  upBytes = 0;
  /** Agreement by what the ship is: checked / differing / differing without a keyframe on that snapshot */
  readonly agree: Record<Klass, Agreement> = Object.fromEntries(klass.map((k) => [k, { checked: 0, off: 0, offNoKf: 0 }])) as never;
  /** Ships it was given a keyframe for that it already held (a correction), and new ones (an entry) */
  keyframesCorrect = 0;
  keyframesEntry = 0;
  /** The corrections by what the ship is: how many, and how many found it already where the server had it */
  readonly corrections: Partial<Record<Klass, { n: number; same: number }>> = {};
  snapshots = 0;
  clientMs = 0;
  /** Of which its debris world (ShipReplicaSet.stepDebrisTo) */
  debrisMs = 0;

  constructor(private server: GameServer, readonly name: string, caps: number, lat: number, private ring: PoseRing, private classOf: (id: number) => Klass, private onTick = 0,
    /** Its system's tick (its own clock once dilated, --crowd: latency is counted in its ticks too) */
    private tick: () => number = () => server.getTick()) {
    const env = (id: number) => (server.replication as unknown as { host: { env(eid: number): ReplicaEnv } }).host.env(id);
    this.fake = new FakeHitsClient(server, {
      name, caps, env,
      defer: (data) => {
        if (this.measuring) {
          this.frames.push(Buffer.from(data)); this.rawBytes += data.length; this.messages++;
        }
        this.down.push({ at: this.tick() + lat, data });
      },
    });
    this.pid = this.fake.pid;
    this.lat = lat;
    const f = this.fake as any, oSnap = f.snapshot.bind(f), oHandle = f.handle.bind(f);
    f.handle = (m: any) => {
      if (this.measuring) {
        const id = m.id ?? m.bodyId, t = m.type === 'debrisSplit' || (id !== undefined && (m.kind === 'debris' || server.getShips().get(id)?.kind === 'debris')) ? (m.type === 'shipSync' ? (m.blueprint ? 'shipSync+bp' : m.hp ? 'shipSync+new' : 'shipSync+re') : m.type) + ':debris' : m.type;
        this.sub[t] = (this.sub[t] ?? 0) + encodeMessage(m).length;
      }
      return oHandle(m);
    };
    // (The client's debris world: drift and knocks stepped, and stepped again from a keyframe or new piece)
    const reps = f.reps, oDeb = reps.stepDebrisTo.bind(reps);
    reps.stepDebrisTo = (to: number) => { const t0 = performance.now(); try { return oDeb(to); } finally { if (this.measuring) this.debrisMs += performance.now() - t0; } };
    f.snapshot = (s: any) => {
      const held = new Set<number>(f.reps.ids());
      const kf = new Set<number>((s.ships ?? []).map((k: number[]) => k[0]));
      if (this.measuring) {
        for (const id of kf) {
          if (!held.has(id)) { this.keyframesEntry++; continue; }
          this.keyframesCorrect++;
          // (By what it is, and whether what it had at that tick was already the server's: a keyframe that changed nothing)
          const c = (this.corrections[id === this.pid ? 'self' : this.classOf(id)] ??= { n: 0, same: 0 });
          c.n++;
          const r = ring.at(s.tick, id), st = f.reps.at(id, s.tick)?.body;
          if (r && st && st.x === r[0] && st.y === r[1] && st.vx === r[2] && st.vy === r[3] && st.angle === r[4] && st.angVel === r[5]) c.same++;
        }
      }
      oSnap(s);
      if (!this.measuring) return;
      this.snapshots++;
      for (const id of held) {
        const r = ring.at(s.tick, id), st = f.reps.at(id, s.tick)?.body;
        if (!r || !st) continue;
        const a = this.agree[id === this.pid ? 'self' : this.classOf(id)];
        a.checked++;
        if (st.x !== r[0] || st.y !== r[1] || st.vx !== r[2] || st.vy !== r[3] || st.angle !== r[4] || st.angVel !== r[5]) { a.off++; if (!kf.has(id)) a.offNoKf++; }
      }
    };
  }
  private lat: number;

  /** Before the server's step: send this tick's input (when it changed or something rides on it) */
  fly(target: number, now: number, ctl?: Ctl): void {
    const f = this.fake as any;
    const c: Ctl = ctl ?? controlsFor(this.pid, target, (t) => this.server.getShips().has(t));
    const key = inputKey(c);
    let rep: unknown, chk: unknown, bck: unknown;
    while (this.bckQ.length && this.bckQ[0].at <= now) bck = this.bckQ.shift()!.v;
    while (this.repQ.length && this.repQ[0].at <= now) rep = this.repQ.shift()!.v;
    while (this.chkQ.length && this.chkQ[0].at <= now) chk = this.chkQ.shift()!.v;
    const acks = f.debris?.takeAcks();
    if (key === this.lastKey && !rep && !chk && !bck && !acks) return;
    this.lastKey = key;
    this.sentAt = now;
    const msg = { type: 'input', seq: this.seq++, tick: 0, targetTick: now + 1, ...c, ...(rep ? { hitReport: rep } : {}), ...(chk ? { ownCheck: chk } : {}), ...(bck ? { bodyCheck: bck } : {}), ...(acks ? { acks } : {}) } as unknown as ClientMessage;
    const enc = encodeMessage(msg) as ArrayBuffer;
    if (this.measuring) { this.upMsgs++; this.upBytes += enc.byteLength; }
    const dec = decodeMessage(enc) as ClientMessage;
    f.noteInput?.(dec);
    f.link!.receive(dec);
  }

  /** After the server's step: frames that have arrived, what it owes, its messages on their way up */
  afterStep(): void {
    const t0 = performance.now(), now = this.tick(), f = this.fake as any;
    while (this.down.length && this.down[0].at <= now) f.frame(this.down.shift()!.data);
    const rep = f.selfHits?.on ? f.selfHits.takeReport(true) : undefined;
    if (rep) this.repQ.push({ at: now + this.lat, v: rep });
    const chk = f.own?.takeCheck?.(this.sentAt === now - 1, now);
    if (chk) this.chkQ.push({ at: now + this.lat, v: chk });
    const bck = f.bodies?.takeCheck?.(this.sentAt === now - 1, now);
    if (bck) this.bckQ.push({ at: now + this.lat, v: bck });
    for (const m of f.outbox.splice(0)) this.up.push({ at: now + this.lat, msg: m });
    while (this.up.length && this.up[0].at <= now) f.link?.receive(this.up.shift()!.msg);
    if (this.measuring) this.clientMs += performance.now() - t0;
  }
}

export function classifier(server: GameServer, bossId: () => number): (id: number) => Klass {
  return (id) => {
    if (id === bossId()) return 'boss';
    if (server.enemies.factionOf(id)) return 'ai';
    if (server.getShips().get(id)?.kind === 'debris') return 'debris';
    return server.getShips().has(id) && InSystem.systemId[id] !== undefined && server.pilots.connOf(id) ? 'player' : 'other';
  };
}
void EntityType;
