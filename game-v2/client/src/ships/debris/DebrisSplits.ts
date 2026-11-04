/**
 * Debris this client works out itself (protocol 25; common ships/debris.ts). A ship broke apart and the server checked
 * this client has it as it was: the pieces come from its blueprint, its pose at the split's tick and the parts that
 * left (deriveSplit, the server's own steps). Each piece goes in the store and the replicas, its status row into the
 * next snapshot, and its check back on the next input; one it gets wrong (or never confirms) the server sends as before.
 * Also each piece's shape for the knocks the replicas work out (ShipReplicaSet's debrisShape).
 *
 * Shared by the game client (ShipClient) and the test and bench fakes (server net/hits/fakeHitsClient.testkit.ts).
 */
import {
  EntityType, deriveSplit, unpackIds, unpackRuns, computeJoins, DEBRIS_STATUS,
  type ShipReplicaSet, type ShipState, type ServerDebrisSplitMessage, type DebrisShape, type EntityState, type Vec2, type FlightBody,
} from '@space-game/common';
import type { ShipStore } from '../ShipStore';

export class DebrisSplits {
  /** Debris worked out here to confirm on the next input ([id, check, ...]) */
  private acks: number[] = [];
  /** ...and their status rows, made here (the server doesn't send them), for the next snapshot */
  private rows: EntityState[] = [];
  private shapes = new WeakMap<ShipState, { rebuilds: number; shape: DebrisShape }>();
  readonly stats = { splits: 0, pieces: 0 };

  /**
   * Splits waiting for their snapshot's causes (CAPS.CAUSES): the parent's pose at the split is after that tick's
   * contacts and before its rebuild (the server splits it there), which only the causes say; its structure and HP as
   * they were before its sync
   */
  private waiting: { msg: ServerDebrisSplitMessage; parent: ShipState; joins: ReturnType<typeof computeJoins>; now?: FlightBody }[] = [];

  constructor(private readonly host: {
    store: ShipStore;
    reps: () => ShipReplicaSet;
    /** With other ships' causes: the parent's pose as the server split it (ShipCauses.beforeRebuild); unset, its replica's at the tick */
    splitPose?: () => ((id: number, tick: number) => FlightBody | null) | null;
  }) {}

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

  /** A piece of debris's shape for the knocks (its alive parts' convex pieces), worked out once per rebuild */
  shape(id: number): DebrisShape | null {
    const { store } = this.host;
    const ship = store.get(id);
    if (!ship || ship.kind !== 'debris') return null;
    const had = this.shapes.get(ship);
    if (had && had.rebuilds === ship.rebuilds) return had.shape;
    const pieces: Vec2[][] = [];
    store.geometry(ship).forEach((g, i) => { if (ship.derived.alive[i]) for (const p of g.convexShrunk) pieces.push(p); });
    const shape = { mass: ship.derived.mass, radius: ship.derived.radius, com: ship.derived.com, pieces };
    this.shapes.set(ship, { rebuilds: ship.rebuilds, shape });
    return shape;
  }

  /** A debrisSplit (before the ship's own sync is taken in): its pieces worked out, stored, replicated, to confirm */
  onSplit(msg: ServerDebrisSplitMessage): void {
    const { store } = this.host;
    const parent = store.get(msg.id);
    if (!parent) return;
    const joins = computeJoins(store.geometry(parent));
    // (With causes: once the snapshot's are in, flush; the parent as it is now, its sync comes after this)
    if (this.host.splitPose?.()) {
      this.waiting.push({ msg, parent: { ...parent, hp: [...parent.hp], detached: [...parent.detached], ghost: parent.ghost && [...parent.ghost] }, joins, now: this.host.reps().at(msg.id, msg.tick)?.body });
      return;
    }
    const at = this.host.reps().at(msg.id, msg.tick);
    if (at) this.derive(msg, parent, joins, at.body);
  }

  /** The snapshot's causes are in: the splits waiting on them worked out (with the parent's pose as the server split it) */
  flush(): void {
    const pose = this.host.splitPose?.();
    for (const w of this.waiting.splice(0)) {
      // (No rebuild of it among the causes, debris splitting again: its replica's at the tick, as it was when the split came)
      const body = pose?.(w.msg.id, w.msg.tick) ?? w.now;
      if (body) this.derive(w.msg, w.parent, w.joins, body);
    }
  }

  private derive(msg: ServerDebrisSplitMessage, parent: ShipState, joins: ReturnType<typeof computeJoins>, body: FlightBody): void {
    const { store } = this.host, reps = this.host.reps();
    const parts = new Set(unpackRuns(msg.p, parent.blueprint.parts.length));
    const got = deriveSplit(store.catalog, store.tuning, parent, msg.id, msg.tick, unpackIds(msg.e), parts, joins, body, (i) => parent.hp[i]);
    if (!got) return;
    this.stats.splits++;
    for (const d of got) {
      store.bodies.set(d.id, d.ship);
      reps.spawnDebris(d.id, msg.tick, d.body);
      this.rows.push({ id: d.id, type: EntityType.ShipBody, x: d.body.x, y: d.body.y, angle: d.body.angle, data: [...DEBRIS_STATUS] });
      this.acks.push(d.id, d.hash);
      this.stats.pieces++;
    }
  }
}
