/**
 * A fake client for the confirmed-hits tests and the netcode probe: the client's own ShipStore, ShipReplicaSet,
 * ConfirmedHits and SelfHits on a real GameServer connection, handling the hit messages as ShipClient does, and
 * counting what it was shown (damage, fires, impacts, detonations, removed shells). Draws nothing. Not used by the game.
 *
 * With CAPS.SELF_HITS it finds its hits itself as ShipClient does (afterSnapshot, then the frame's end) and reports them
 * on an input after each step (`report`). `drop` makes it miss hits on purpose (the forced-mismatch test).
 */
import {
  CAPS, SIDE, EntityType, Position, Rotation, Velocity, ServerFrameReader, encodeMessage, decodeMessage, rebuildVolley, ShipReplicaSet,
  type ClientMessage, type ClientSocket, type ServerMessage, type ServerSnapshotMessage, type ShipState, type ReplicaEnv,
} from '@space-game/common';
import { ShipStore } from '../../../../client/src/ships/ShipStore.js';
import { ConfirmedHits, type HitShell, type HitsOutcome, type OwnHit } from '../../../../client/src/ships/hits/ConfirmedHits.js';
import { SelfHits, toldHits } from '../../../../client/src/ships/hits/SelfHits.js';
import { OwnTick } from '../../../../client/src/ships/own/OwnTick.js';
import { BodyRunner } from '../../../../client/src/ships/bodies/BodyRunner.js';
import { bodiesFor } from '@space-game/common';
import { ownSimFor } from '../snapshot/ownShots.js';
import type { GameServer } from '../../GameServer.js';

export interface FakeHitsOptions {
  name: string;
  caps: number;
  /** The replicas' world (gravity and the rest) for a ship: the server's own (Replication's host.env) */
  env: (id: number) => ReplicaEnv;
  /** Hits it found that it throws away (it "missed" them) */
  drop?: (h: OwnHit) => boolean;
  /** Hand frames in later (the probe's latency): the frame goes to `deliver` instead of being handled at once */
  defer?: (data: Uint8Array) => void;
  /**
   * Its prediction off by this much on a tick (x, y, angle): the cosmetic layer only (where told hits on its own ship
   * are drawn). Nothing on its tick-aligned layer may depend on it (the tests and the probe check that)
   */
  predictionError?: (tick: number) => { dx: number; dy: number; da: number } | null;
}

export class FakeHitsClient {
  pid = -1;
  readonly store: ShipStore;
  readonly reps: ShipReplicaSet;
  readonly hits: ConfirmedHits | null = null;
  readonly selfHits: SelfHits | null = null;
  /** Its own ship on its tick-aligned layer, stepped by itself (CAPS.OWN_SIM: client ships/own/OwnTick.ts) */
  readonly own: OwnTick | null = null;
  /** Bosses flown by their bodies on its tick-aligned layer (CAPS.BODIES: client ships/bodies/BodyRunner.ts) */
  readonly bodies: BodyRunner | null = null;
  readonly shells = new Map<number, HitShell>();
  /** Entity types and ship-body status data, as the snapshots said */
  private kinds = new Map<number, { type: number; side: number }>();
  snapTick = 0;
  damage = new Map<string, number>();
  ignites: string[] = [];
  removed = new Set<number>();
  known = new Set<number>();
  projectileHits = 0;
  /** Where each impact it was shown went (shell id and point: the server's projectileHit, or its own worked out) */
  impacts: { id: number; x: number; y: number }[] = [];
  detonations = 0;
  sawSnapshot = false;
  /** Bytes it sent up (its hit reports' inputs) and how many */
  upBytes = 0;
  reports = 0;
  /** Hits it threw away (drop) */
  dropped = 0;
  /** Its own shells as projectile rows, and as fire events (CAPS.OWN_SHOTS: built from its own pose) */
  ownRows = 0;
  ownFired = 0;
  /** Its confirmation levels as told (netCaps.lvl, CAPS.ROUGH): [the snapshot tick it came after, level] */
  readonly levels: [number, number][] = [];
  /** Its own shells that came as rows (ids) */
  readonly ownRowIds = new Set<number>();
  link: { receive(msg: ClientMessage): void } | null = null;
  /** What it sends the server (hpResync, reports), delivered after the step (a real socket is never re-entered) */
  outbox: ClientMessage[] = [];
  private handingOut = false;
  private seq = 1;

  constructor(private server: GameServer, private opts: FakeHitsOptions) {
    const ships = server.getShips();
    this.store = new ShipStore(ships.catalog, ships.tuning);
    this.reps = new ShipReplicaSet(ships.tuning, (id) => this.store.get(id)?.derived, () => opts.env(this.pid));
    if (opts.caps & CAPS.HITS) {
      this.hits = new ConfirmedHits({
        store: this.store,
        shell: (id) => this.shells.get(id) ?? null,
        pose: (id, tick) => (id === this.pid ? this.selfHist.get(tick) : this.reps.at(id, tick)?.body) ?? null,
        pilot: (id) => id === this.pid || this.kinds.get(id)?.type === EntityType.Player,
        send: (m) => this.outbox.push(m),
      });
    }
    if (opts.caps & CAPS.SELF_HITS) {
      this.selfHits = new SelfHits({
        store: this.store,
        self: () => this.pid,
        ships: () => this.reps.ids(),
        at: (id, tick) => this.reps.at(id, tick)?.body ?? null,
        side: (id) => {
          const k = this.kinds.get(id);
          const pilot = id === this.pid || k?.type === EntityType.Player;
          return (pilot ? SIDE.PILOT : 0) | (k?.side === 1 ? SIDE.WARD : 0) | (k?.side === 2 ? SIDE.PERSON : 0) | (this.reps.isDocked(id) ? SIDE.DOCKED : 0);
        },
        passes: (shell) => this.hits!.passesOf(shell),
      });
    }
    if (ownSimFor(opts.caps)) this.own = new OwnTick({ store: this.store, reps: this.reps, self: () => this.pid, tuning: ships.tuning });
    if (bodiesFor(opts.caps)) this.bodies = new BodyRunner({ reps: this.reps });
    const socket: ClientSocket = {
      isOpen: () => true,
      send: (data) => {
        const bytes = data as Uint8Array;
        // (frames go at the step's end: its ship is where this tick left it)
        this.noteSelf();
        if (opts.defer) opts.defer(Uint8Array.from(bytes)); else this.frame(bytes);
      },
    };
    this.link = server.connect(socket);
    this.link.receive({ type: 'join', username: opts.name, ...(opts.caps ? { caps: opts.caps } : {}) } as ClientMessage);
    this.pid = server.getPlayerId(socket);
    // (its own ship's pose every tick, not only those a frame went on: the server's step, wrapped)
    const step = server.step.bind(server);
    server.step = () => { step(); this.noteSelf(); };
  }

  /**
   * Its own ship's pose at the end of each tick, as a client's prediction has it while it holds (GameState.selfPoseAt):
   * here the server's, noted after each step (the server's step is wrapped) and as each frame goes
   */
  private selfHist = new Map<number, { x: number; y: number; angle: number; vx: number; vy: number }>();

  /** Its own ship's pose this tick (what its prediction would say) */
  private noteSelf(): void {
    if (this.pid < 0) return;
    const t = this.server.getTick();
    const e = this.opts.predictionError?.(t);
    this.selfHist.set(t, { x: Position.x[this.pid] + (e?.dx ?? 0), y: Position.y[this.pid] + (e?.dy ?? 0), angle: Rotation.angle[this.pid] + (e?.da ?? 0), vx: Velocity.x[this.pid], vy: Velocity.y[this.pid] });
    this.selfHist.delete(t - 240);
  }

  /** An input it sent (the probe and tests fly it by inputs): its own ship's controls on the tick-aligned layer (OwnTick) */
  noteInput(msg: ClientMessage): void {
    if (msg.type === 'input') this.own?.noteInput(msg as never);
  }

  /** Base-format frames and bit-packed messages (CAPS.PACKED: one or more frames each) */
  private reader = new ServerFrameReader();
  /** WebSocket messages it got, the frames in them (a packed message may hold several: coalescing), their bytes */
  messages = 0;
  frames = 0;
  bytes = 0;

  /** One WebSocket message from the server: each frame's messages, then the frame's end */
  frame(data: Uint8Array): void {
    this.messages++;
    this.bytes += data.length;
    for (const msgs of this.reader.read(data)) {
      this.frames++;
      for (const m of msgs) this.handle(m);
      this.frameEnd();
    }
  }

  /** After a step: what it owes the server (resyncs; a hit report on an input, as one goes every tick in a fight) */
  flushUp(): void {
    const rep = this.selfHits?.takeReport(true);
    // (its bodies' check rides along, CAPS.BODIES)
    const bck = this.bodies?.takeCheck(true, this.server.getTick());
    if (rep || bck) {
      const msg = { type: 'input', seq: this.seq++, tick: 0, forward: false, backward: false, left: false, right: false, boost: false, fireLeft: false, fireRight: false, targetAngle: 0, ...(rep ? { hitReport: rep } : {}), ...(bck ? { bodyCheck: bck } : {}) } as ClientMessage;
      const enc = encodeMessage(msg);
      this.upBytes += (rep ? 3 : 0) + (bck ? 3 : 0);
      if (rep) this.reports++;
      this.outbox.push(decodeMessage(enc) as ClientMessage);
    }
    for (const m of this.outbox.splice(0)) this.link?.receive(m);
  }

  private handle(m: ServerMessage): void {
    switch (m.type) {
      case 'shipSync': this.selfHits?.onSync(m.id); this.own?.beforeSync(m.id); this.store.onSync(m); break;
      case 'shipHps': this.findHits(); this.store.onHps(m); break;
      case 'netCaps':
        this.findHits();
        this.selfHits?.setOn((m.caps & (CAPS.HITS | CAPS.SELF_HITS)) === (CAPS.HITS | CAPS.SELF_HITS), this.snapTick);
        this.selfHits?.setLevel(m.caps & CAPS.ROUGH ? m.lvl : undefined);
        this.own?.setOn(ownSimFor(m.caps));
        this.bodies?.setOn(bodiesFor(m.caps));
        this.levels.push([this.snapTick, m.caps & CAPS.ROUGH ? m.lvl ?? 1 : 1]);
        break;
      case 'snapshot': this.snapshot(m as ServerSnapshotMessage); break;
      case 'hits':
        this.findHits(m.h);
        if (this.selfHits?.on) this.hits!.told(m, this.snapTick);
        else this.handOut(this.hits!.expand(m, this.snapTick));
        break;
      case 'hitFix': {
        this.findHits();
        if (!this.selfHits?.on) break;
        const { missed, wrong } = this.selfHits.fix(m);
        if (process.env.HITS_DEBUG) console.log('FIX', this.opts.name, JSON.stringify({ s: m.s, t: m.t, recs: m.h, missed, wrong }));
        this.handOut(this.hits!.corrected(missed, m.t, wrong));
        break;
      }
      case 'hpCheck': this.findHits(); this.hits!.check(m); break;
      case 'damage': {
        const k = `${m.targetId},${m.sourceId}`;
        this.damage.set(k, (this.damage.get(k) ?? 0) + m.amount);
        break;
      }
      case 'ignite': this.ignites.push(`${m.bodyId}:${m.part}:${m.ticks}`); break;
      case 'projectileHit':
        if (this.selfHits?.on && !this.handingOut) { this.hits!.oldWay(m.id); this.selfHits.drop(m.id); }
        this.projectileHits++;
        this.impacts.push({ id: m.id, x: m.x, y: m.y });
        break;
      case 'detonation': this.detonations++; break;
    }
  }

  private snapshot(s: ServerSnapshotMessage): void {
    this.findHits();
    this.snapTick = s.tick;
    this.sawSnapshot = true;
    this.reps.apply(s.tick, s.ships, s.ctl);
    // (its own ship's causes and controls, CAPS.OWN_SIM, before its fire events are built from it)
    this.own?.onSnapshot(s);
    // (bosses' decisions, CAPS.BODIES: their bodies fly them from here)
    this.bodies?.onSnapshot(s.tick, s.decisions);
    for (const e of s.entities) {
      const d = e.data;
      if (e.type === EntityType.Player || e.type === EntityType.ShipBody) this.kinds.set(e.id, { type: e.type, side: e.type === EntityType.ShipBody && d ? d[10] ?? 0 : 0 });
      if (e.type !== EntityType.Projectile) continue;
      this.known.add(e.id);
      if (d?.[6] === this.pid) { this.ownRows++; this.ownRowIds.add(e.id); }
      if (d && (d[10] ?? -1) >= 0) this.shells.set(e.id, { owner: d[6], gun: d[10], spawnTick: d[3], x: d[4], y: d[5], vx: e.vx ?? 0, vy: e.vy ?? 0 });
      // (a row's shell is rounded: it sits out, the server tells its hits, as ShipClient.afterSnapshot)
      if (this.selfHits?.on) this.selfHits.row(e.id);
    }
    // Fire events: the shells rebuilt from the firing ship's replica, as ShipClient.preSnapshot does
    for (const [owner, ago, partAmmo, aimQ, ...ids] of s.fire ?? []) {
      for (const id of ids) this.known.add(id);
      if (owner === this.pid) this.ownFired += ids.length;
      const tick = s.tick - ago, part = partAmmo % 256, ammo = Math.floor(partAmmo / 256) % 256, aug = partAmmo >= 65536 ? (1 as const) : undefined;
      // (its own too, CAPS.OWN_SHOTS: from its confirmed ship, replicated to it as to everyone; never its prediction)
      // (its own, CAPS.OWN_SIM: where it was as it fired, before that tick's pulls and contacts: OwnTick.firePose)
      const ship = this.store.get(owner), body = owner === this.pid && this.own?.on ? this.own.firePose(tick) : this.reps.at(owner, tick)?.body;
      const v = ship && body ? rebuildVolley({ owner, tick, part, aimQ, ids, ammo, aug }, ship as ShipState, body, this.server.getShips().tuning) : null;
      const spawnTick = owner === this.pid || this.kinds.get(owner)?.type === EntityType.Player ? tick - 1 : tick;
      for (const id of ids) {
        const sh = v?.shells.find((x) => x.id === id);
        this.shells.set(id, { owner, gun: partAmmo, spawnTick, x: sh?.x ?? 0, y: sh?.y ?? 0, vx: sh?.vx ?? 0, vy: sh?.vy ?? 0 });
        if (sh) this.selfHits?.addShell(id, owner, partAmmo, spawnTick, sh.x, sh.y, sh.vx, sh.vy, sh.size);
      }
    }
    // (as ShipClient: the ledger sees the removed list before the shells go)
    this.hits?.forget(s.removed);
    this.selfHits?.onRemoved(s.removed);
    for (const id of s.removed) { if (this.known.has(id)) this.removed.add(id); this.shells.delete(id); this.store.remove(id); this.bodies?.remove(id); this.reps.remove(id); }
    for (const id of s.out ?? []) { this.bodies?.remove(id); this.reps.remove(id); }
    // (The game's client steps every replica as it draws, each frame; drawing nothing, this does it here. Left alone,
    // a replica no one asked for in 600 ticks stops short: ShipReplicaSet.at won't run that far in one go)
    for (const id of this.reps.ids()) this.reps.at(id, s.tick);
    // Hits found here, once the frame's told records are in (ShipClient.afterSnapshot, findHits)
    if (this.selfHits) {
      this.selfHits.onKeyframes(s.ships);
      this.selfHits.open(s.tick);
    }
  }

  /** The snapshot's window searched (ShipClient.findHits): at its hits message, with its records, or before what reads the HP */
  private findHits(told?: number[]): void {
    if (!this.selfHits?.waiting) return;
    let found = this.selfHits.detect(told ? toldHits(told, this.snapTick) : undefined);
    if (this.opts.drop && found.length) {
      const before = found.length;
      found = found.filter((h) => !this.opts.drop!(h));
      this.dropped += before - found.length;
    }
    if (found.length) this.hits!.own(found);
  }

  private frameEnd(): void {
    this.findHits();
    if (!this.selfHits || (!this.selfHits.on && !this.hits!.hasPending)) return;
    const { out, done } = this.hits!.flushPending();
    this.selfHits.settle(done);
    this.handOut(out);
  }

  private handOut(r: HitsOutcome): void {
    this.handingOut = true;
    try { for (const m of r.msgs) this.handle(m); } finally { this.handingOut = false; }
    for (const id of r.gone) { this.removed.add(id); this.shells.delete(id); }
    this.selfHits?.spent(r.gone);
  }
}
