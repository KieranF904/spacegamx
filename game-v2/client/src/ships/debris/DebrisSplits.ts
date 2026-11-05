/**
 * Debris this client works out itself (protocol 25; common ships/debris.ts). A ship broke apart and the server checked
 * this client has it as it was: the pieces come from its blueprint, its pose at the split's tick and the parts that
 * left (deriveSplit, the server's own steps). Each piece goes in the store and the replicas, its status row into the
 * next snapshot, and its check back on the next input; one it gets wrong (or never confirms) the server sends as before.
 * Also each piece's shape for the knocks the replicas work out (ShipReplicaSet's debrisShape).
 *
 * Pieces the server gives it to run (CAPS.DEBRIS, debrisSplit `l`) live on here after their spawn: their crumbling and
 * what it leaves (DebrisLives); the replica set's debris world asks here (common network/replication.ts DebrisWorld).
 *
 * Shared by the game client (ShipClient) and the test and bench fakes (server net/hits/fakeHitsClient.testkit.ts).
 */
import {
  EntityType, deriveSplit, debrisDecay, unpackSheds, partGroups, unpackIds, unpackRuns, computeJoins, recentreShift, quantizeShipBody, DEBRIS_STATUS, StateRing, ReplicaState, ReplicaMode,
  type ShipReplicaSet, type ServerShipSyncMessage, type ShipState, type ServerDebrisSplitMessage, type ServerPartDestroyedMessage, type DebrisShape, type DebrisWorld,
  type EntityState, type Vec2, type FlightBody, type ShipDerived,
} from '@space-game/common';
import type { ShipStore } from '../ShipStore';
import { DebrisLives } from './DebrisLives';

/** Ticks of bodies before a rebuild kept (a split is worked out within its snapshot's window) */
const PRE_TICKS = 128;

export class DebrisSplits implements DebrisWorld {
  /** The pieces it runs itself (CAPS.DEBRIS) */
  readonly lives: DebrisLives;
  /** Debris worked out here to confirm on the next input ([id, check, ...]) */
  private acks: number[] = [];
  /** ...and their status rows, made here (the server doesn't send them), for the next snapshot */
  private rows: EntityState[] = [];
  private shapes = new WeakMap<ShipDerived, { aloof: boolean; born: number; shape: DebrisShape }>();
  readonly stats = { splits: 0, pieces: 0 };

  /**
   * Splits waiting for their snapshot's causes (CAPS.CAUSES): the parent's pose at the split is after that tick's
   * contacts and before its rebuild (the server splits it there), which only the causes say; its structure and HP as
   * they were before its sync
   */
  private waiting: { msg: ServerDebrisSplitMessage; parent: ShipState; joins: ReturnType<typeof computeJoins>; now?: FlightBody; run?: boolean }[] = [];

  constructor(private readonly host: {
    store: ShipStore;
    reps: () => ShipReplicaSet;
    /** With other ships' causes: the parent's pose as the server split it (ShipCauses.beforeRebuild); unset, its replica's at the tick */
    splitPose?: () => ((id: number, tick: number) => FlightBody | null) | null;
    /** A crumble of a piece it runs, to show (as the server's partDestroyed would have) */
    crumbled?: (m: ServerPartDestroyedMessage) => void;
  }) {
    this.lives = new DebrisLives({ store: host.store, crumbled: host.crumbled });
  }

  /**
   * A shipSync for this body (before the store takes it in): one it ran, the server tells it from now on; a piece of
   * debris rebuilt (`at`, CAPS.STRUCTS) is stepped again from then, recentred there (after)
   */
  onSync(msg: ServerShipSyncMessage): void {
    this.lives.drop(msg.id);
    // (A structure it has already, one it ran told now, say: nothing to step again)
    if (msg.at !== undefined && msg.kind === 'debris' && this.host.store.get(msg.id)?.rebuilds !== msg.rebuilds) this.host.reps().rewind(msg.id, msg.at);
  }

  /**
   * Bodies before a rebuild recentred them, by id and tick (a split from it starts there): a StateRing of their replica
   * states, the ticks of a window (sim foundation 1C, common sim/ring.ts)
   */
  private readonly pre = new StateRing(PRE_TICKS);

  /**
   * A connection afresh (ShipClient.resetHits): the old server's pieces, checks and waiting splits are no part of the new
   * one's (its ids start over: an old check sent on would confirm an id it never split)
   */
  reset(): void {
    this.lives.clear();
    this.pre.clear();
    this.waiting.length = 0;
    this.acks = [];
    this.rows = [];
  }

  // ---- DebrisWorld (the replica set's debris world) ----

  gone(id: number, t: number): boolean {
    return this.lives.gone(id, t);
  }

  /** After tick t's step: one it runs, its crumbling; one it's sent, a rebuild its syncs keep by tick, recentred alike */
  after(id: number, t: number, body: FlightBody): boolean {
    if (this.lives.has(id)) return this.lives.after(id, t, body);
    const r = this.host.store.rebuildAt(id, t);
    if (!r) return true;
    this.pre.keep(t, new ReplicaState(id, ReplicaMode.Drift, { ...body }, 0, 0));
    const w =recentreShift(r.from, r.to, this.host.store.tuning.cellSize, body.angle);
    if (w) { body.x += w[0]; body.y += w[1]; quantizeShipBody(body); }
    return true;
  }

  /** Its body on tick t before a rebuild there recentred it (null: none) */
  private preAt(id: number, t: number): FlightBody | null {
    return this.lives.preAt(id, t) ?? this.pre.get(id, t)?.body ?? null;
  }

  /** The debris to confirm, taken (the input path sends them) */
  takeAcks(): number[] | undefined {
    if (!this.acks.length) return undefined;
    const a = this.acks;
    this.acks = [];
    return a;
  }

  /** The status rows of the pieces worked out since the last snapshot, taken (the snapshot's entities get them) */
  takeRows(): EntityState[] {
    return this.rows.length ? this.rows.splice(0) : [];
  }

  /**
   * A piece of debris's shape for the knocks on tick t (its alive parts' convex pieces), worked out once per structure:
   * the structure it flew on that tick (one it runs: its own; one it's sent: its syncs kept by tick, CAPS.STRUCTS)
   */
  shape(id: number, t?: number): DebrisShape | null {
    const { store } = this.host;
    const ship = (t !== undefined ? this.lives.versionAt(id, t) : null) ?? store.get(id);
    if (!ship || ship.kind !== 'debris') return null;
    const d = (t !== undefined && !this.lives.has(id) ? store.derivedAt(id, t) : undefined) ?? ship.derived;
    const had = this.shapes.get(d);
    if (had && had.aloof === store.aloof.has(id) && had.born === ship.spawnTick) return had.shape;
    const pieces: Vec2[][] = [];
    if (!store.aloof.has(id)) store.geometry(ship).forEach((g, i) => { if (d.alive[i]) for (const p of g.convexShrunk) pieces.push(p); });
    const shape = { mass: d.mass, radius: d.radius, com: d.com, pieces, born: ship.spawnTick };
    this.shapes.set(d, { aloof: store.aloof.has(id), born: ship.spawnTick, shape });
    return shape;
  }


  /** A debrisSplit (before the ship's own sync is taken in): its pieces worked out, stored, replicated, to confirm */
  onSplit(msg: ServerDebrisSplitMessage): void {
    const { store } = this.host;
    // (A piece it runs breaking up: as it was on the tick, and where it was before that tick's rebuild recentred it)
    const run = this.lives.versionAt(msg.id, msg.tick);
    const parent = run ?? store.get(msg.id);
    if (!parent) return;
    const joins = computeJoins(store.geometry(parent));
    // (A ship destroyed, its own, or one rebuilt again since its last sync: the split says where it was, and in the last
    // case the structure's centre of mass and the pieces' HP too)
    const s = msg.s;
    if (s && s.length >= 6) {
      const body = { x: s[0], y: s[1], angle: s[2], vx: s[3], vy: s[4], angVel: s[5] };
      if (msg.c && msg.h) {
        const hp = msg.h;
        this.derive(msg, { ...parent, derived: { ...parent.derived, com: [msg.c[0], msg.c[1]] } }, joins, body, (order) => new Map(order.map((part, i) => [part, hp[i] ?? 0])));
      } else this.derive(msg, parent, joins, body);
      return;
    }
    if (run) { this.waiting.push({ msg, parent: run, joins, run: true }); return; }
    // (With causes: once the snapshot's are in, flush; the parent as it is now, its sync comes after this)
    if (this.host.splitPose?.()) {
      this.waiting.push({ msg, parent: { ...parent, hp: [...parent.hp], detached: [...parent.detached], ghost: parent.ghost && [...parent.ghost] }, joins, now: this.host.reps().at(msg.id, msg.tick)?.body });
      return;
    }
    const at = this.host.reps().at(msg.id, msg.tick);
    if (at) this.derive(msg, parent, joins, at.body);
  }

  /**
   * The snapshot's causes and decisions are in: the splits waiting on them worked out (with the parent's pose as the
   * server split it); `keyed`, the ships the snapshot keyframed
   */
  flush(keyed?: ReadonlySet<number>): void {
    // (Pieces it ran that it no longer holds: removed, or out of view)
    const reps = this.host.reps();
    for (const id of [...this.lives.ids()]) if (!reps.has(id)) this.lives.drop(id);
    for (const id of [...this.pre.ids()]) if (!reps.has(id)) this.pre.remove(id);
    const pose = this.host.splitPose?.();
    for (const w of this.waiting.splice(0)) {
      // (A piece it runs: its world stepped to the tick, the snapshot's keyframes in, and its body before it was recentred)
      if (w.run) { reps.at(w.msg.id, w.msg.tick); const pre = this.preAt(w.msg.id, w.msg.tick); if (pre) this.derive(w.msg, w.parent, w.joins, pre); continue; }
      // (No rebuild of it among the causes: its replica's at the tick, now the snapshot's controls and decisions are in,
      // when its structures are kept by tick (CAPS.STRUCTS: it flew that tick as it was); else as it was when the split
      // came, before its sync)
      // (A piece recentred there: where it was before. Keyframed in this snapshot: as it was when the split came)
      const kept = !!this.host.store.derivedAt(w.msg.id, w.msg.tick) && !keyed?.has(w.msg.id);
      // (stepped there first: a piece's sync since may have it stepped again, recentred at the tick)
      if (kept) reps.at(w.msg.id, w.msg.tick);
      const body = this.preAt(w.msg.id, w.msg.tick) ?? pose?.(w.msg.id, w.msg.tick) ?? (kept ? reps.at(w.msg.id, w.msg.tick)?.body : undefined) ?? w.now;
      if (body) this.derive(w.msg, w.parent, w.joins, body);
    }
  }

  /** `hps`: the pieces' HP the split gave, by part, from its parts in piece order (else the parent's as last sent) */
  private derive(msg: ServerDebrisSplitMessage, parent: ShipState, joins: ReturnType<typeof computeJoins>, body: FlightBody, hps?: (order: number[]) => Map<number, number>): void {
    const { store } = this.host, reps = this.host.reps();
    const n = parent.blueprint.parts.length;
    const parts = new Set(unpackRuns(msg.p, n));
    const sheds = msg.g ? unpackSheds(msg.g, n) : undefined;
    const given = hps?.([...(sheds?.flatMap((x) => x.groups) ?? []), ...partGroups(n, joins, parts)].flat());
    const got = deriveSplit(store.catalog, store.tuning, parent, msg.id, msg.tick, unpackIds(msg.e), parts, joins, body, (i) => given?.get(i) ?? parent.hp[i], sheds);
    if (!got) return;
    this.stats.splits++;
    // (Its to run from now: each part's crumble time, a shed's own, else its parent's if that's one it runs, else
    // seeded by the piece)
    const decay = msg.l ? this.lives.decayOf(msg.id) : undefined;
    const aloof = store.aloof.has(msg.id);
    for (const d of got) {
      store.bodies.set(d.id, d.ship);
      // (Only to be seen: shed so, or breaking off one that is)
      if (d.aloof || (d.aloof === undefined && aloof)) store.aloof.add(d.id); else store.aloof.delete(d.id);
      if (msg.l) this.lives.add(d.id, msg.tick, d.ship, d.decay ?? (decay ? d.parts.map((i) => decay[i]) : debrisDecay(d.id, msg.tick, d.parts.length, store.tuning)));
      reps.spawnDebris(d.id, msg.tick, d.body);
      this.rows.push({ id: d.id, type: EntityType.ShipBody, x: d.body.x, y: d.body.y, angle: d.body.angle, data: [...DEBRIS_STATUS] });
      this.acks.push(d.id, d.hash);
      this.stats.pieces++;
    }
  }
}
