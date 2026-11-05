/**
 * ShipBridge debris on the wire: what the snapshot path and replication need to know about debris that clients work
 * out for themselves (common/src/ships/debris.ts): the splits since the last snapshot a client may derive, what each
 * piece was spawned as (its check), and which pieces something other than the shared drift-and-knock step moved this
 * tick (they need a keyframe). The step itself is flight.ts stepDebrisWorld.
 */
import { InSystem, Position, stepDebrisWorld as stepWorld, debrisYoung, quantizeShipBody, type ShedSpec, type DebrisBody, type FlightBody, type ShipState, type Vec2 } from '@space-game/common';
import { K, type BridgeCtx } from './core.js';

/**
 * A split a client may work out itself: the ship, the tick, its centre of mass then (grid), the pieces and their parts
 * (what it shed whole first, `sheds`, then the orphaned groups, whose parts are `parts`)
 */
export interface DebrisSplit { ship: ShipState; tick: number; com: Vec2; ids: number[]; groups: number[][]; parts: number[]; sheds?: ShedSpec[]; /** Where it was (splitPose), and whether nothing is left of it */ pose?: FlightBody; gone?: boolean; /** Each piece's parts' HP as spawned, to a tenth */ hp?: number[][] }

/** How far past touching a piece near an off one counts as within its reach (touchNear): more than an off piece strays before its keyframe */
const NEAR_SLACK = 8;

const same = (a: FlightBody, b: FlightBody) => a.x === b.x && a.y === b.y && a.vx === b.vx && a.vy === b.vy && a.angle === b.angle && a.angVel === b.angVel;
const copy = (b: FlightBody): FlightBody => ({ x: b.x, y: b.y, vx: b.vx, vy: b.vy, angle: b.angle, angVel: b.angVel });

export class DebrisNet {
  /** Bodies only to be seen (ShipBridge.intangible: the same set): a piece's sync says so */
  readonly intangible = new Set<number>();
  /** Splits since the last snapshot that clients may derive (SnapshotBuilder takes them; cleared after each snapshot) */
  readonly splits = new Map<number, DebrisSplit[]>();
  /** Each derivable piece as spawned: its check (debrisHash) and rebuild count */
  readonly spawns = new Map<number, { hash: number; rebuilds: number }>();
  /**
   * Pieces moved since the last snapshot by something besides the shared step (a blast, a rebuild's shift, a tow), and
   * every piece that knocked into one since (clients have it where it was till its keyframe, so they knock it otherwise):
   * Replication keyframes them all at the snapshot, which clears it (clearTouched)
   */
  readonly touched = new Set<number>();
  /**
   * Pieces something besides their drift, knocks and crumbling changed (a shot, a blast, fire, a tow): a client running
   * one (CAPS.DEBRIS) is told it from then on (a shipSync), and its rebuilds go as any ship's
   */
  readonly told = new Set<number>();
  /** What ships shed this tick, to leave at the rebuild point (bridge/rebuild.ts shed, rebuildNow) */
  readonly sheds = new Map<number, ShedSpec[]>();
  /** Pairs that knocked this tick (Replication: a client with one but not the other gets a keyframe) */
  pairs: [number, number][] = [];
  /** Each piece as the shared step left it this tick, and as the tick left it (both rounded) */
  private readonly expect = new Map<number, FlightBody>();
  private readonly last = new Map<number, FlightBody>();
  /** Each design's convex pieces (grid units), by the ship state and its rebuild count */
  private readonly shapes = new WeakMap<ShipState, { rebuilds: number; pieces: Vec2[][] }>();

  /** Each ship's centre of mass after its last few rebuilds (rebuild count → com): a client's copy is good for a split if it matches */
  private readonly coms = new Map<number, [number, Vec2][]>();

  noteCom(eid: number, rebuilds: number, com: Vec2): void {
    let list = this.coms.get(eid);
    if (!list) this.coms.set(eid, (list = []));
    list.push([rebuilds, com]);
    if (list.length > 12) list.shift();
  }

  /** Its centre of mass as of a rebuild count (undefined: too long ago, or never seen) */
  comAt(eid: number, rebuilds: number): Vec2 | undefined {
    const list = this.coms.get(eid);
    if (list) for (let i = list.length - 1; i >= 0; i--) if (list[i][0] === rebuilds) return list[i][1];
    return undefined;
  }

  noteSplit(parent: number, split: DebrisSplit): void {
    const list = this.splits.get(parent);
    if (list) list.push(split); else this.splits.set(parent, [split]);
  }

  forget(eid: number): void {
    this.spawns.delete(eid);
    this.told.delete(eid);
    this.sheds.delete(eid);
    this.expect.delete(eid);
    this.last.delete(eid);
    // (Not its splits nor its centre of mass yet: a ship blown apart is gone before the snapshot tells its pieces: afterSnapshot)
  }

  /** The snapshot told this round's splits: they go, and what's kept of ships that are gone */
  afterSnapshot(alive: (eid: number) => boolean, due?: (eid: number) => boolean): void {
    // (Only the systems whose round it was, crowd fallbacks: the rest are told at theirs)
    if (due) { for (const p of [...this.splits.keys()]) if (due(p)) this.splits.delete(p); }
    else this.splits.clear();
    for (const eid of this.coms.keys()) if (!alive(eid)) this.coms.delete(eid);
  }

  piecesOf(b: BridgeCtx, ship: ShipState): Vec2[][] {
    const s = this.shapes.get(ship);
    if (s && s.rebuilds === ship.rebuilds) return s.pieces;
    const pieces: Vec2[][] = [];
    b.geometry(ship).forEach((g, i) => { if (ship.derived.alive[i]) for (const p of g.convexShrunk) pieces.push(p); });
    this.shapes.set(ship, { rebuilds: ship.rebuilds, pieces });
    return pieces;
  }

  /**
   * Every live piece of debris, one tick: by system, in id order, the shared step (drift, then push-only knocks). A
   * piece found moved since the last tick ended (by something else) is marked touched. Intangible pieces only drift.
   */
  step(b: BridgeCtx, ids: readonly number[]): void {
    this.pairs = [];
    const bySys = new Map<number, { eid: number; ship: ShipState; d: DebrisBody }[]>();
    for (const eid of ids) {
      const ship = b.bodies.get(eid);
      if (!ship) continue;
      const body = b.readBody(eid, ship);
      const was = this.last.get(eid);
      if (was && !same(was, body)) this.touched.add(eid);
      const sys = InSystem.systemId[eid];
      const d: DebrisBody = { id: eid, body, mass: ship.derived.mass, radius: ship.derived.radius, com: ship.derived.com, pieces: b.intangible.has(eid) ? [] : this.piecesOf(b, ship), born: ship.spawnTick };
      let list = bySys.get(sys);
      if (!list) bySys.set(sys, (list = []));
      list.push({ eid, ship, d });
    }
    const restitution = b.tuning.collision.restitution, tick = b.host.getTick();
    for (const list of bySys.values()) {
      list.sort((p, q) => p.eid - q.eid);
      const gravity = b.host.gravityAt(list[0].eid);
      const k = gravity ? b.withGravity(gravity) : K;
      for (const pair of stepWorld(list.map((e) => e.d), k, b.tuning.cellSize, restitution, tick)) this.pairs.push(pair);
      for (const e of list) {
        b.writeBody(e.eid, e.ship, e.d.body);
        this.expect.set(e.eid, copy(e.d.body));
      }
    }
  }

  /**
   * A piece's crumble rebuilt it and recentred what's left (common ships/debrisLife.ts): clients running it work that
   * out, so it's where the shared rules leave it, not moved by something else
   */
  shifted(eid: number, body: FlightBody): void {
    if (!this.expect.has(eid)) return;
    const q = copy(body);
    quantizeShipBody(q);
    this.expect.set(eid, q);
  }

  /** The tick's end (bodies rounded): a piece that isn't where the shared step left it was moved by something else */
  endTick(b: BridgeCtx): void {
    for (const [eid, want] of this.expect) {
      const ship = b.bodies.get(eid);
      if (!ship) { this.expect.delete(eid); this.last.delete(eid); continue; }
      const body = b.readBody(eid, ship);
      if (!same(want, body)) this.touched.add(eid);
      this.last.set(eid, copy(body));
    }
    this.expect.clear();
    // (Clients have a piece that's off where it was: one near it may knock it there and not here, or here and not
    // there. Every piece within reach of an off one is off too, and so is what knocks into one: its keyframe goes with
    // the other's)
    if (this.touched.size) this.spread(b, this.touched);
  }

  /** Debris within reach of a piece in `set` (their circles closer than NEAR_SLACK), and what knocked into one, join it */
  private spread(b: BridgeCtx, set: Set<number>): void {
    const off: { eid: number; x: number; y: number; r: number; sys: number }[] = [];
    for (const eid of set) {
      const ship = b.bodies.get(eid);
      if (ship?.kind === 'debris' && !b.intangible.has(eid)) off.push({ eid, x: Position.x[eid], y: Position.y[eid], r: ship.derived.radius, sys: InSystem.systemId[eid] });
    }
    const tick = b.host.getTick();
    if (off.length) for (const eid of this.last.keys()) {
      if (set.has(eid) || b.intangible.has(eid)) continue;
      const ship = b.bodies.get(eid);
      // (In its grace: nothing knocks it)
      if (!ship || this.young(ship, tick + 1)) continue;
      const x = Position.x[eid], y = Position.y[eid], r = ship.derived.radius, sys = InSystem.systemId[eid];
      for (const o of off) {
        const reach = o.r + r + NEAR_SLACK, dx = o.x - x, dy = o.y - y;
        if (o.sys === sys && dx * dx + dy * dy < reach * reach) { set.add(eid); break; }
      }
    }
    // (A knock with an off piece is off too: round the pairs till nothing more joins)
    for (let more = set.size > 0, n = 0; more && n < 8; n++) {
      more = false;
      for (const [a, c] of this.pairs) {
        const ta = set.has(a), tc = set.has(c);
        if (ta !== tc) { set.add(ta ? c : a); more = true; }
      }
    }
  }

  /** A piece still in its grace (common DEBRIS_GRACE_TICKS): nothing touches it but its own drift */
  young(ship: ShipState | undefined, tick: number): boolean {
    return ship?.kind === 'debris' && debrisYoung(ship.spawnTick, tick);
  }

  /** The snapshot took them (keyframes) */
  clearTouched(due?: (eid: number) => boolean): void {
    if (due) { for (const id of [...this.touched]) if (due(id)) this.touched.delete(id); return; }
    this.touched.clear();
  }
}
