/**
 * A fake client for the confirmed-hits tests and the netcode probe: the client's own ShipStore, ShipReplicaSet,
 * ConfirmedHits and SelfHits on a real GameServer connection, handling the hit messages as ShipClient does, and
 * counting what it was shown (damage, fires, impacts, detonations, removed shells). Draws nothing. Not used by the game.
 *
 * Full caps only, as every client is (common network/hits.ts DEFAULT_CAPS): it finds its hits itself as ShipClient does
 * (afterSnapshot, then the frame's end) and reports them on an input after each step (`report`), steps its own ship, runs
 * bodies, homing shells, causes and contact pairs on its tick layer. `drop` makes it miss hits on purpose (the
 * forced-mismatch test). What a test compares it with is the server's own record (spawns, hits, state), not another client.
 */
import {
  DEFAULT_CAPS, PROTOCOL_VERSION, SIDE, EntityType, Position, Rotation, Velocity, Input, InSystem, INPUT_BOOLS, ServerFrameReader, encodeMessage, decodeMessage, rebuildVolley, ShipReplicaSet,
  type ClientMessage, type ClientSocket, type ServerMessage, type ServerSnapshotMessage, type ShipState, type ReplicaEnv,
} from '@space-game/common';
import { ShipStore } from '../../../../client/src/ships/ShipStore.js';
import { ConfirmedHits, type HitShell, type HitsOutcome, type OwnHit } from '../../../../client/src/ships/hits/ConfirmedHits.js';
import { SelfHits, toldHits } from '../../../../client/src/ships/hits/SelfHits.js';
import { OwnTick } from '../../../../client/src/ships/own/OwnTick.js';
import { BodyRunner } from '../../../../client/src/ships/bodies/BodyRunner.js';
import { GuideRunner } from '../../../../client/src/ships/guides/GuideRunner.js';
import { ShipMemory } from '../../../../client/src/ships/cells/ShipMemory.js';
import { ShipCauses } from '../../../../client/src/ships/causes/ShipCauses.js';
import { DebrisSplits } from '../../../../client/src/ships/debris/DebrisSplits.js';
import { MoveRunner } from '../../../../client/src/ships/bodies/MoveRunner.js';
import { ContactWorld, type ContactFx } from '../../../../client/src/ships/causes/ContactWorld.js';
import { ownShotWireOf, isOtherShotWire, type GuideBody, type CustomStats, type Charge, type FireRecord, type ClientInputMessage } from '@space-game/common';
import { OwnShells } from '../../../../client/src/ships/hits/OwnShells.js';
import { OtherGuns } from '../../../../client/src/ships/guns/OtherGuns.js';
import factionsFile from '../../../../data/factions.json' with { type: 'json' };
import type { GameServer } from '../../GameServer.js';

export interface FakeHitsOptions {
  name: string;
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
  /** A homing shell it runs stepped to tick t (CAPS.WAYPOINTS: compared with the server's) */
  onGuideStep?: (id: number, t: number, m: Readonly<GuideBody>) => void;
}

export class FakeHitsClient {
  pid = -1;
  readonly store: ShipStore;
  readonly reps: ShipReplicaSet;
  readonly hits: ConfirmedHits;
  readonly selfHits: SelfHits;
  /** Its own ship on its tick-aligned layer, stepped by itself (CAPS.OWN_SIM: client ships/own/OwnTick.ts) */
  readonly own: OwnTick;
  /** Bosses flown by their bodies on its tick-aligned layer (CAPS.BODIES: client ships/bodies/BodyRunner.ts) */
  readonly bodies: BodyRunner;
  /** Homing shells flown on its tick-aligned layer (CAPS.WAYPOINTS: client ships/guides/GuideRunner.ts) */
  readonly guides: GuideRunner;
  /** Its bodies' moves worked out on its tick-aligned layer (CAPS.MOVES: client ships/bodies/MoveRunner.ts) */
  readonly moves: MoveRunner;
  /**
   * Bodies' moves' looks it was sent, and those it worked out itself (CAPS.MOVES), each with the snapshot tick it was
   * handled at; the shells it made (as rows) by their spawn tick
   */
  readonly fxSent: { tick: number; msg: ServerMessage }[] = [];
  readonly fxMade: { tick: number; msg: ServerMessage }[] = [];
  readonly shellsMade: { tick: number; owner: number; x: number; y: number; vx: number; vy: number }[] = [];
  readonly shells = new Map<number, HitShell>();
  /** Ships out of view it keeps (CAPS.FOCUS: client ships/cells/ShipMemory.ts): their entity kinds here */
  readonly away: ShipMemory<{ type: number; side: number }>;
  /** Other ships' causes on its tick-aligned layer (CAPS.CAUSES: client ships/causes/ShipCauses.ts) */
  readonly causes: ShipCauses;
  /** Debris it works out itself (debrisSplit), as the game client does */
  readonly debris: DebrisSplits;
  /** Contact pairs it finds itself (CAPS.CONTACTS: client ships/causes/ContactWorld.ts) */
  readonly contacts: ContactWorld;
  /** The sparks it drew for them (the server's `contact` messages for the rest: `contactMsgs`) */
  readonly contactFx: ContactFx[] = [];
  contactMsgs = 0;
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
  /** Its own shells it built itself (CAPS.SHOT_IDS) */
  ownDerived = 0;
  /** Its confirmation levels as told (netCaps.lvl, CAPS.ROUGH): [the snapshot tick it came after, level] */
  readonly levels: [number, number][] = [];
  /** Its own shells that came as rows (ids) */
  readonly ownRowIds = new Set<number>();
  /**
   * Its own straight shells worked out here, named by shot id (CAPS.SHOT_IDS: client ships/hits/OwnShells.ts). Which of
   * its guns fired is its own tick layer's (OwnTick's whole step, guns included: the events it hands out as each
   * snapshot reaches a tick, as the game's client draws them as its prediction does); `shotPairs` its shot ids beside the
   * server's records' for the same ticks
   */
  readonly ownShells: OwnShells;
  /** Other ships' guns on its tick layer (client ships/guns/OtherGuns.ts), and the shells it built from their lanes */
  readonly otherGuns: OtherGuns;
  otherDerived = 0;
  /** Each lane-built shell: its owner, gun, spawn tick and spawn (by wire name), for the tests */
  readonly otherShells = new Map<number, { owner: number; tick: number; part: number; x: number; y: number; vx: number; vy: number }>();
  readonly shotPairs: { tick: number; client: number[]; server: number[] }[] = [];
  /** Its own shells it built, by wire name: the server's entity id (from its records), for the tests */
  readonly ownWire = new Map<number, number>();
  link: { receive(msg: ClientMessage): void } | null = null;
  /** What it sends the server (hpResync, reports), delivered after the step (a real socket is never re-entered) */
  outbox: ClientMessage[] = [];
  private handingOut = false;
  private seq = 1;

  constructor(private server: GameServer, private opts: FakeHitsOptions) {
    const ships = server.getShips();
    this.store = new ShipStore(ships.catalog, ships.tuning);
    // (Debris it works out itself, and the knocks its replicas work out: client ships/debris/DebrisSplits.ts)
    this.debris = new DebrisSplits({ store: this.store, reps: () => this.reps, splitPose: () => (id, t) => this.causes.beforeRebuild(id, t) });
    this.reps = new ShipReplicaSet(ships.tuning, (id) => this.store.get(id)?.derived, () => opts.env(this.pid), undefined, this.debris);
    this.hits = new ConfirmedHits({
        store: this.store,
        shell: (id) => this.shells.get(id) ?? null,
        pose: (id, tick) => (id === this.pid ? this.selfHist.get(tick) : this.reps.at(id, tick)?.body) ?? null,
        pilot: (id) => id === this.pid || this.kinds.get(id)?.type === EntityType.Player,
        send: (m) => this.outbox.push(m),
        self: () => this.pid,
      });
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
        passes: (shell) => this.hits.passesOf(shell),
        ownExact: () => this.own.on,
      });
    this.own = new OwnTick({ store: this.store, reps: this.reps, self: () => this.pid, tuning: ships.tuning, extraHash: (t) => (this.causes.heldByte(t) ?? 0) + this.guides.byte(t),
      contacts: () => this.contacts, otherMid: (id, t, place) => this.causes.midOf(id, t, place) });
    this.ownShells = new OwnShells({ self: () => this.pid, ship: (id) => this.store.get(id), tuning: ships.tuning, firePose: (t) => this.own.firePose(t) });
    this.watchServerShots();
    this.bodies = new BodyRunner({ reps: this.reps, radius: (id) => this.store.get(id)?.derived.radius });
    // (Other ships' guns stepped here from their inputs, as ShipClient: client ships/guns/OtherGuns.ts)
    this.otherGuns = new OtherGuns({ reps: this.reps, ship: (id) => { const s = this.store.get(id); return s && s.kind === 'ship' ? s as ShipState : undefined; }, tuning: ships.tuning, self: () => this.pid });
    this.moves = new MoveRunner({
      reps: this.reps, bodies: this.bodies, store: this.store, tuning: ships.tuning, terrain: () => opts.env(this.pid).terrain,
      custom: (factionsFile as { custom?: { designs: Record<string, CustomStats> } }).custom,
    });
    this.guides = new GuideRunner({ reps: this.reps, onStep: opts.onGuideStep });
    this.causes = new ShipCauses({ store: this.store, reps: this.reps, self: () => this.pid, ownDerived: (t) => this.own.derived(t), ownMid: (t, o) => (this.own.on ? this.own.midOf(t, o) : null), tuning: ships.tuning, contacts: () => this.contacts });
    this.contacts = new ContactWorld({
      reps: this.reps, store: this.store, self: () => this.pid, ownOn: () => this.own.on, tuning: ships.tuning,
      derivedAt: (id, t) => (id === this.pid ? this.own.derived(t) : this.causes.derived(id, t) ?? this.store.get(id)?.derived),
      mid: (id, t, place) => (id === this.pid ? this.own.midAt(t, place) ?? null : this.causes.midOf(id, t, place) ?? null),
      forget: (t) => { this.causes.cursors.forget(t); this.own.cursors.forget(t); },
    });
    this.away = new ShipMemory({ entity: (id) => this.kinds.get(id), restore: (id, e) => this.kinds.set(id, e), send: (m) => this.outbox.push(m) });
    const socket: ClientSocket = {
      isOpen: () => true,
      send: (data) => {
        const bytes = data as Uint8Array;
        // (frames go at the step's end: its ship is where this tick left it, and the controls it flew are on its layer
        // before the frame's own rows say otherwise)
        this.noteSelf();
        this.noteFlown(false);
        if (opts.defer) opts.defer(Uint8Array.from(bytes)); else this.frame(bytes);
      },
    };
    this.link = server.connect(socket);
    this.link.receive({ type: 'join', username: opts.name, protocol: PROTOCOL_VERSION, caps: DEFAULT_CAPS } as ClientMessage);
    this.pid = server.getPlayerId(socket);
    // (its pilot known: its own ship stepped on its tick layer from here, as ShipClient.onWelcome)
    this.own.start();
    // (its own ship's pose every tick, not only those a frame went on, and the controls it flew: the server's step, wrapped)
    const step = server.step.bind(server);
    server.step = () => { step(); this.noteSelf(); this.noteFlown(true); };
  }

  /** The server's own-shot ids by the tick it fired them (watchServerShots), to pair with its own layer's (shotPairs) */
  private readonly serverShots = new Map<number, number[]>();
  private pairedTo = -Infinity;

  /** The server's records of its own ship's shots, by tick, and their wire names (its fireWeapons, wrapped) */
  private watchServerShots(): void {
    const ships = this.server.getShips() as unknown as { fireWeapons: (eid: number, ship: ShipState, firing: boolean, aimWorld?: number, aimDist?: number, target?: number, energy?: { charge: Charge }, hold?: boolean) => void; fired: FireRecord[] };
    const orig = ships.fireWeapons.bind(ships);
    ships.fireWeapons = (eid, ship, firing, aimWorld, aimDist = 0, target = -1, energy, hold) => {
      if (eid !== this.pid) return orig(eid, ship, firing, aimWorld, aimDist, target, energy, hold);
      const tick = this.server.getTick(), n0 = ships.fired.length;
      orig(eid, ship, firing, aimWorld, aimDist, target, energy, hold);
      for (let i = n0; i < ships.fired.length; i++) {
        const f = ships.fired[i];
        if (f.owner !== eid || !f.shots) continue;
        const at = this.serverShots.get(tick);
        if (at) at.push(...f.shots); else this.serverShots.set(tick, [...f.shots]);
        f.shots.forEach((sh, k) => this.ownWire.set(ownShotWireOf(sh), f.ids[k]));
      }
    };
  }

  /**
   * Its own tick layer stepped to a snapshot's tick: what its guns fired on each tick since the last, handed out (its
   * own shells' volleys, ShipClient.presentOwn's), and paired with the server's records of the same ticks
   */
  private ownFires(tick: number): void {
    if (!this.own.on || this.pid < 0) return;
    this.reps.at(this.pid, tick);
    const ship = this.store.get(this.pid);
    const client = new Map<number, number[]>();
    for (const { tick: t, events } of this.own.takeConfirmed(tick)) {
      for (const e of events) {
        if (e.k !== 'fire' || !ship) continue;
        const aug = (e as { aug?: 1 }).aug;
        if (e.barrel === 0 && this.ownShells.derivable(ship, e.slot + (aug ? 65536 : 0))) this.ownShells.fired({ tick: t, part: e.slot, aimQ: e.aimQ, ammo: 0, aug });
        if (this.ownShells.derivable(ship, e.slot)) { const at = client.get(t); if (at) at.push(e.shot); else client.set(t, [e.shot]); }
      }
    }
    const from = Number.isFinite(this.pairedTo) ? this.pairedTo + 1 : Math.min(tick, ...client.keys(), ...this.serverShots.keys());
    for (let t = from; t <= tick; t++) {
      const c = client.get(t) ?? [], sv = this.serverShots.get(t) ?? [];
      this.serverShots.delete(t);
      if (c.length || sv.length) this.shotPairs.push({ tick: t, client: c, server: sv });
    }
    this.pairedTo = Math.max(this.pairedTo, tick);
  }

  /**
   * The controls its ship flew this tick, as a client that sent them has them on its tick layer (a perfect client:
   * OwnTick), and its own ship stepped there, as the game's client steps it ahead of the snapshots (its prediction)
   */
  private flownKey = '';
  private noteFlown(ahead: boolean): void {
    if (this.pid < 0) return;
    const held: Record<string, unknown> = {};
    for (const k of INPUT_BOOLS) held[k] = Input[k][this.pid] === 1;
    const msg = { type: 'input', seq: 0, tick: 0, ...held, targetAngle: Input.targetAngle[this.pid], cursorDist: Input.cursorDist[this.pid] } as Record<string, unknown>;
    const key = JSON.stringify(msg), tick = this.server.clocks?.tickOf(InSystem.systemId[this.pid]) ?? this.server.getTick();
    if (key !== this.flownKey) {
      this.flownKey = key;
      msg.targetTick = tick;
      this.own.noteInput(msg as unknown as ClientInputMessage);
    }
    if (ahead && this.own.on) this.reps.at(this.pid, tick);
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
    if (msg.type === 'input') this.own.noteInput(msg as never);
  }

  /** Bit-packed messages (one or more frames each; base-format frames before its join) */
  private reader = new ServerFrameReader();
  /** WebSocket messages it got, the frames in them (a packed message may hold several: coalescing), their bytes */
  messages = 0;
  frames = 0;
  bytes = 0;
  /** Pull field records it was sent (common sim/pullFields.ts) */
  pullRecords = 0;

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
    const rep = this.selfHits.takeReport(true);
    // (its bodies' check rides along, CAPS.BODIES)
    const bck = this.bodies.takeCheck(true, this.server.getTick());
    if (rep || bck) {
      // (It rides an input as a client's does: the controls it is flying (the server's Input, whoever set them), for its
      // system's next tick, so it lands on time: not a late input, which would mark its own ship off)
      const held: Record<string, unknown> = {};
      for (const k of INPUT_BOOLS) held[k] = Input[k][this.pid] === 1;
      const sys = InSystem.systemId[this.pid], next = (this.server.clocks?.tickOf(sys) ?? this.server.getTick()) + 1;
      const msg = { type: 'input', seq: this.seq++, tick: 0, targetTick: next, ...held, targetAngle: Input.targetAngle[this.pid], cursorDist: Input.cursorDist[this.pid], ...(rep ? { hitReport: rep } : {}), ...(bck ? { bodyCheck: bck } : {}) } as ClientMessage;
      const enc = encodeMessage(msg);
      this.upBytes += (rep ? 3 : 0) + (bck ? 3 : 0);
      if (rep) this.reports++;
      const sent = decodeMessage(enc) as ClientMessage;
      this.noteInput(sent);
      this.outbox.push(sent);
    }
    for (const m of this.outbox.splice(0)) this.link?.receive(m);
  }

  private handle(m: ServerMessage): void {
    switch (m.type) {
      case 'shipSync': this.debris.onSync(m); this.selfHits?.onSync(m.id, this.store.keepsBefore(m)); this.own?.beforeSync(m.id); this.causes?.beforeSync(m.id); this.store.onSync(m); break;
      case 'shipHps': this.findHits(); this.store.onHps(m); break;
      case 'welcome': if (this.pid >= 0) this.own.start(); break;
      case 'ownSync': this.own.onOwnSync(m); break;
      case 'gunSync': this.otherGuns.onGunSync(m); break;
      case 'gunCtl': this.otherGuns.onGunCtl(m); break;
      // (Pull fields its tick layer works out itself, as a client's ShipClient.onPulls)
      case 'pulls': this.pullRecords += m.f.length; if (m.r) this.reps.pulls.clear(); this.reps.notePulls(m.f, this.snapTick); break;
      case 'netCaps':
        // (the first after its join: finding hits here starts with the next snapshot; each says its level, ShipClient.onNetCaps)
        this.findHits();
        this.selfHits.setOn(true, this.snapTick);
        this.selfHits.setLevel(m.lvl);
        this.levels.push([this.snapTick, m.lvl ?? 1]);
        break;
      case 'snapshot': this.snapshot(m as ServerSnapshotMessage); break;
      case 'debrisSplit': this.debris.onSplit(m); break;
      case 'cells': this.away.onCells(m); break;
      case 'hits':
        this.findHits(m.h);
        if (this.selfHits.on) this.hits.told(m, this.snapTick);
        else this.handOut(this.hits.expand(m, this.snapTick));
        break;
      case 'hitFix': {
        this.findHits();
        if (!this.selfHits.on) break;
        const { missed, wrong } = this.selfHits.fix(m);
        if (process.env.HITS_DEBUG) console.log('FIX', this.opts.name, JSON.stringify({ s: m.s, t: m.t, recs: m.h, missed, wrong }));
        this.handOut(this.hits.corrected(missed, m.t, wrong));
        break;
      }
      case 'hpCheck': this.findHits(); this.hits.check(m); break;
      case 'damage': {
        const k = `${m.targetId},${m.sourceId}`;
        this.damage.set(k, (this.damage.get(k) ?? 0) + m.amount);
        break;
      }
      case 'ignite': this.ignites.push(`${m.bodyId}:${m.part}:${m.ticks}`); break;
      case 'projectileHit':
        if (this.selfHits.on && !this.handingOut) { this.hits.oldWay(m.id); this.selfHits.drop(m.id); }
        if (!this.known.has(m.id)) this.moves.struck(m.x, m.y, this.snapTick);
        this.projectileHits++;
        this.impacts.push({ id: m.id, x: m.x, y: m.y });
        break;
      case 'detonation': this.detonations++; this.fxSent.push({ tick: this.snapTick, msg: m }); break;
      case 'bossTelegraph': case 'bossBeam': case 'bossWindow': case 'effect': this.fxSent.push({ tick: this.snapTick, msg: m }); break;
      case 'contact': this.contactMsgs++; break;
    }
  }

  private snapshot(s: ServerSnapshotMessage): void {
    this.findHits();
    this.snapTick = s.tick;
    this.sawSnapshot = true;
    // (its own contact pass's window: who it leaves out, CAPS.CONTACTS; before the keyframes go in)
    this.contacts?.beginSnapshot(s);
    this.reps.apply(s.tick, s.ships, s.ctl);
    // (its own ship's causes and controls, CAPS.OWN_SIM, before its fire events are built from it)
    this.own?.onSnapshot(s);
    // (other ships' causes, CAPS.CAUSES, before their fire events are built from them)
    this.causes?.onSnapshot(s);
    // (bosses' decisions, CAPS.BODIES: their bodies fly them from here)
    this.bodies?.onSnapshot(s.tick, s.decisions);
    this.debris.flush(new Set(s.ships?.map((k) => k[0])));
    // (the status rows of debris it worked out: the game client shows them; nothing here)
    this.debris.takeRows();
    // (homing shells, CAPS.WAYPOINTS: flown from their SYNCs and waypoints)
    this.guides?.onSnapshot(s.tick, s.guides);
    // (bodies' moves through this window, CAPS.MOVES: their looks and straight shells, as ShipClient.preSnapshot)
    if (this.moves) {
      const mv = this.moves.advance(s.tick, this.pid);
      for (const r of mv.rows) { const d = r.data!; this.shellsMade.push({ tick: d[3], owner: d[6], x: d[4], y: d[5], vx: r.vx ?? 0, vy: r.vy ?? 0 }); }
      for (const msg of this.moves.take()) this.fxMade.push({ tick: s.tick, msg });
    }
    for (const e of s.entities) {
      const d = e.data;
      if (e.type === EntityType.Player || e.type === EntityType.ShipBody) this.kinds.set(e.id, { type: e.type, side: e.type === EntityType.ShipBody && d ? d[10] ?? 0 : 0 });
      if (e.type !== EntityType.Projectile) continue;
      this.known.add(e.id);
      if (d?.[6] === this.pid) { this.ownRows++; this.ownRowIds.add(e.id); }
      if (d && (d[10] ?? -1) >= 0) this.shells.set(e.id, { owner: d[6], gun: d[10], spawnTick: d[3], x: d[4], y: d[5], vx: e.vx ?? 0, vy: e.vy ?? 0 });
      // (a row's shell is rounded: it sits out, the server tells its hits, as ShipClient.afterSnapshot)
      if (this.selfHits.on) this.selfHits.row(e.id);
    }
    // (Other ships' gun lanes: their shells whose life has ended, then this window's as fire rows, as ShipClient.preSnapshot)
    this.otherGuns.expire(s.tick, s.removed);
    this.otherGuns.confirm(s);
    // Fire events: the shells rebuilt from the firing ship's replica, as ShipClient.preSnapshot does
    for (const [owner, ago, partAmmo, aimQ, ...ids] of s.fire ?? []) {
      for (const id of ids) this.known.add(id);
      if (owner === this.pid) this.ownFired += ids.length;
      const tick = s.tick - ago, part = partAmmo % 256, ammo = Math.floor(partAmmo / 256) % 256, aug = partAmmo >= 65536 ? (1 as const) : undefined;
      // (its own too, CAPS.OWN_SHOTS: from its confirmed ship, replicated to it as to everyone; never its prediction)
      // (its own, CAPS.OWN_SIM: where it was as it fired, before that tick's pulls and contacts: OwnTick.firePose)
      const ship = this.store.get(owner), body = owner === this.pid && this.own.on ? this.own.firePose(tick) : this.reps.preAt(owner, tick);
      const v = ship && body ? rebuildVolley({ owner, tick, part, aimQ, ids, ammo, aug }, ship as ShipState, body, this.server.getShips().tuning) : null;
      const spawnTick = owner === this.pid || this.kinds.get(owner)?.type === EntityType.Player ? tick - 1 : tick;
      for (const id of ids) {
        const sh = v?.shells.find((x) => x.id === id);
        this.shells.set(id, { owner, gun: partAmmo, spawnTick, x: sh?.x ?? 0, y: sh?.y ?? 0, vx: sh?.vx ?? 0, vy: sh?.vy ?? 0 });
        if (sh && isOtherShotWire(id)) { this.otherGuns.built(id, tick + sh.life - 1); this.otherDerived++; this.otherShells.set(id, { owner, tick, part, x: sh.x, y: sh.y, vx: sh.vx, vy: sh.vy }); }
        if (sh) this.selfHits?.addShell(id, owner, partAmmo, spawnTick, sh.x, sh.y, sh.vx, sh.vy, sh.size);
      }
    }
    // Its own straight shells, CAPS.SHOT_IDS: built here from its own gun step, named by shot id; those ended removed here (ShipClient.preSnapshot)
    this.ownFires(s.tick);
    {
      const keyed = !!s.ships?.some((k) => k[0] === this.pid) || this.own.syncedAt === s.tick;
      for (const e of this.ownShells.snapshot(s.tick, s.removed, keyed)) {
        const d = e.data!;
        this.known.add(e.id);
        this.ownDerived++;
        this.shells.set(e.id, { owner: d[6], gun: d[10], spawnTick: d[3], x: d[4], y: d[5], vx: e.vx ?? 0, vy: e.vy ?? 0 });
        if (this.ownShells.freshExact(e.id)) this.selfHits?.addShell(e.id, d[6], d[10], d[3], d[4], d[5], e.vx ?? 0, e.vy ?? 0, d[7]);
        else this.selfHits?.row(e.id);
      }
    }
    // (as ShipClient: the ledger sees the removed list before the shells go)
    this.hits?.forget(s.removed);
    this.away.onSnapshot(s.tick, s.removed);
    this.selfHits?.onRemoved(s.removed);
    for (const id of s.removed) { if (this.known.has(id)) this.removed.add(id); this.shells.delete(id); this.store.remove(id); this.bodies?.remove(id); this.causes?.remove(id); this.reps.remove(id, s.tick); this.guides?.remove(id, s.tick); }
    for (const id of s.out ?? []) { this.bodies?.remove(id); this.causes?.remove(id); this.reps.remove(id); }
    // (The game's client steps every replica as it draws, each frame; drawing nothing, this does it here. Left alone,
    // a replica no one asked for in 600 ticks stops short: ShipReplicaSet.at won't run that far in one go)
    for (const id of this.reps.ids()) this.reps.at(id, s.tick);
    // (the pairs it found itself through the window: their ships' hits told, their sparks drawn, CAPS.CONTACTS)
    const found = this.contacts?.endSnapshot(s.tick);
    if (found) this.contactFx.push(...found.fx);
    // (the ships it holds now, for its check: CAPS.CAUSES)
    this.causes?.noteHeld(s.tick);
    this.guides?.noteHeld(s.tick);
    // Hits found here, once the frame's told records are in (ShipClient.afterSnapshot, findHits)
    if (this.selfHits) {
      this.selfHits.onKeyframes(s.ships);
      this.selfHits.onCaused(s.causes);
      this.selfHits.onTouched(found?.touched);
      for (const id of this.bodies?.told() ?? []) this.selfHits.onSync(id);
      this.selfHits.open(s.tick);
    }
  }

  /** The snapshot's window searched (ShipClient.findHits): at its hits message, with its records, or before what reads the HP */
  private findHits(told?: number[]): void {
    if (!this.selfHits.waiting) return;
    let found = this.selfHits.detect(told ? toldHits(told, this.snapTick) : undefined);
    if (this.opts.drop && found.length) {
      const before = found.length;
      found = found.filter((h) => !this.opts.drop!(h));
      this.dropped += before - found.length;
    }
    if (found.length) this.hits.own(found);
  }

  private frameEnd(): void {
    this.findHits();
    if (!this.selfHits.on && !this.hits.hasPending) return;
    const { out, done } = this.hits.flushPending();
    this.selfHits.settle(done);
    this.handOut(out);
  }

  private handOut(r: HitsOutcome): void {
    this.handingOut = true;
    try { for (const m of r.msgs) this.handle(m); } finally { this.handingOut = false; }
    for (const id of r.gone) { this.removed.add(id); this.shells.delete(id); this.guides?.remove(id); }
    this.ownShells.gone(r.gone);
    this.otherGuns.gone(r.gone);
    this.selfHits?.spent(r.gone);
  }
}
