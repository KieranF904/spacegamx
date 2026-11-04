/**
 * Loot pods: containers floating in space (drops, jettisoned cargo, a
 * destroyed pilot's hold). A pod drifts to a stop; a ship with cargo space
 * that comes close pulls it in, and its contents go into cargo. Whatever
 * doesn't fit stays in the pod.
 *
 * Pods are DroppedItem entities. Snapshot data: [rarity index of the best
 * item inside, number of kinds of item, item count].
 */

import { addEntity, addComponent, hasComponent, entityExists, defineQuery, IWorld } from 'bitecs';
import {
  Position, Velocity, Radius, DroppedItem, Lifetime, InSystem, NetworkSync, Dead, Player,
  Bag, ItemCatalog, RARITIES, POD_DRAG, podDrift, dcos, dhypot, dsin, mulberry32,
} from '@space-game/common';

export interface PodHost {
  readonly world: IWorld;
  /** Remove an entity (and tell clients) */
  remove(eid: number): void;
  /** Ships that can collect: player entities in this system */
  collectors(systemNum: number): number[];
  /** Give items to a player's cargo; returns what didn't fit. `source` is 'mined' for ore its collector broke off. */
  give(playerEid: number, items: Bag, at: { x: number; y: number }, source: string): Bag;
  /** Cargo space left for a player */
  cargoFree(playerEid: number): number;
  /** The player ship's size (pull range scales with it) */
  shipRadius(playerEid: number): number;
  /** The server tick (drift anchors) */
  tick?(): number;
  /** Who a player is, for pods kept for one pilot (a wreck): their account, not their entity */
  keyOf?(playerEid: number): string | undefined;
  /** A kept pod was emptied */
  emptied?(eid: number, key: string): void;
}

/** Where a pod was, how fast, on which tick: from there it just drifts (podDrift) until something moves it */
export interface PodAnchor { x: number; y: number; vx: number; vy: number; t: number }

const podQuery = defineQuery([DroppedItem, Position]);

/** Seconds a pod lasts before it's gone */
const POD_LIFE_TICKS = 60 * 60 * 5;
/** Pull starts this far beyond the ship's hull; collection at the hull */
const PULL_RANGE = 380;

export class LootPods {
  private contents = new Map<number, Bag>();
  /** Server-only randomness, seeded (math/rng.ts): a scatter's way (pods go to clients as drift anchors) */
  private rng = mulberry32(0x9d5);
  /** Pods a ship just dropped don't come straight back to it */
  private ignore = new Map<number, { eid: number; until: number }>();
  /** Ore chunks: who mined them (collecting your own chunk counts as mining) */
  private minedBy = new Map<number, number>();
  private ticks = 0;
  private anchors = new Map<number, PodAnchor>();
  /** Pods only one pilot can take until a tick (their wreck) */
  private kept = new Map<number, { key: string; until: number }>();

  /** Only `key`'s pilot can collect this pod until `untilTick` */
  keep(eid: number, key: string, untilTick: number): void {
    if (this.contents.has(eid)) this.kept.set(eid, { key, until: untilTick });
  }

  /** A pod's drift anchor: clients are sent this once, not its every position (null: not settled yet) */
  anchor(eid: number): PodAnchor | null {
    return this.anchors.get(eid) ?? null;
  }

  constructor(private host: PodHost, private items: ItemCatalog) {}

  /** A new pod. `droppedBy` won't pull it back in for `ignoreTicks` (jettisoned cargo). */
  spawn(systemNum: number, x: number, y: number, vx: number, vy: number, items: Bag, droppedBy = -1, ignoreTicks = 60 * 8, lifeTicks = POD_LIFE_TICKS): number {
    const clean: Bag = {};
    for (const [id, n] of Object.entries(items)) if (n > 0 && this.items.has(id)) clean[id] = Math.floor(n);
    if (!Object.keys(clean).length) return -1;
    const w = this.host.world;
    const eid = addEntity(w);
    for (const c of [Position, Velocity, Radius, DroppedItem, Lifetime, InSystem, NetworkSync]) addComponent(w, c, eid);
    Position.x[eid] = x;
    Position.y[eid] = y;
    Velocity.x[eid] = vx;
    Velocity.y[eid] = vy;
    Radius.value[eid] = 18;
    InSystem.systemId[eid] = systemNum;
    Lifetime.remaining[eid] = lifeTicks;
    this.contents.set(eid, clean);
    if (droppedBy >= 0) this.ignore.set(eid, { eid: droppedBy, until: this.ticks + ignoreTicks });
    this.refresh(eid);
    return eid;
  }

  /** Scatter a drop as one pod per few items, thrown outwards a little */
  /** An ore chunk broken off by `miner` */
  spawnChunk(systemNum: number, x: number, y: number, vx: number, vy: number, items: Bag, miner?: number): number {
    const eid = this.spawn(systemNum, x, y, vx, vy, items);
    if (eid >= 0 && miner !== undefined) this.minedBy.set(eid, miner);
    return eid;
  }

  scatter(systemNum: number, x: number, y: number, vx: number, vy: number, items: Bag, spread = 2): void {
    const a0 = this.rng() * Math.PI * 2;
    this.spawn(systemNum, x, y, vx + dcos(a0) * spread, vy + dsin(a0) * spread, items);
  }

  get(eid: number): Bag | undefined {
    return this.contents.get(eid);
  }

  // ---- Tow Beam (ships/features/tow/Towing.ts)
  /** Pods in a system within `r` of (x, y) */
  near(systemNum: number, x: number, y: number, r: number): number[] {
    const out: number[] = [];
    for (const eid of podQuery(this.host.world)) {
      if (InSystem.systemId[eid] !== systemNum || hasComponent(this.host.world, Dead, eid) || !this.contents.has(eid)) continue;
      if (dhypot(Position.x[eid] - x, Position.y[eid] - y) <= r) out.push(eid);
    }
    return out;
  }

  /** Take a pod away whole (towed into a station): its contents, or undefined if it's gone */
  take(eid: number): Bag | undefined {
    const bag = this.contents.get(eid);
    if (!bag) return undefined;
    this.contents.delete(eid);
    this.host.remove(eid);
    return bag;
  }
  // ---- (end Tow Beam)

  /** Snapshot data for a pod entity */
  snapshotData(eid: number): number[] {
    const bag = this.contents.get(eid) ?? {};
    let best = 0, count = 0;
    for (const [id, n] of Object.entries(bag)) {
      best = Math.max(best, RARITIES.indexOf(this.items.get(id)?.rarity ?? 'common'));
      count += n;
    }
    return [best, Object.keys(bag).length, count];
  }

  private refresh(eid: number): void {
    const [best, , count] = this.snapshotData(eid);
    DroppedItem.itemId[eid] = best;
    DroppedItem.stackCount[eid] = Math.min(65535, count);
  }

  /** Remove every pod in a system (admin). Returns how many. */
  clear(systemNum: number): number {
    let n = 0;
    for (const eid of podQuery(this.host.world)) {
      if (InSystem.systemId[eid] !== systemNum || hasComponent(this.host.world, Dead, eid) || !this.contents.has(eid)) continue;
      this.contents.delete(eid);
      this.host.remove(eid);
      n++;
    }
    return n;
  }

  /** Drift, pull towards nearby ships with room, and collect */
  tick(): void {
    this.ticks++;
    const w = this.host.world;
    // Who can collect, per system, and each one's free cargo: worked out once a tick (cargo again after a pickup)
    const collectors = new Map<number, number[]>();
    const room = new Map<number, number>();
    const roomOf = (p: number) => {
      let f = room.get(p);
      if (f === undefined) room.set(p, (f = this.host.cargoFree(p)));
      return f;
    };
    for (const eid of podQuery(w)) {
      if (hasComponent(w, Dead, eid)) continue;
      const bag = this.contents.get(eid);
      if (!bag) continue;
      // Drift to a stop
      Velocity.x[eid] *= POD_DRAG;
      Velocity.y[eid] *= POD_DRAG;
      Position.x[eid] += Velocity.x[eid];
      Position.y[eid] += Velocity.y[eid];

      let target = -1, best = Infinity;
      const sys = InSystem.systemId[eid];
      let near = collectors.get(sys);
      if (!near) collectors.set(sys, (near = this.host.collectors(sys).filter((p) => hasComponent(w, Player, p) && !hasComponent(w, Dead, p))));
      for (const p of near) {
        // Distance first: the rest only matters for a ship in reach
        const d = dhypot(Position.x[p] - Position.x[eid], Position.y[p] - Position.y[eid]) - this.host.shipRadius(p);
        if (d >= PULL_RANGE || d >= best || roomOf(p) < 1) continue;
        const ig = this.ignore.get(eid);
        if (ig && ig.eid === p && this.ticks < ig.until) continue;
        const kept = this.kept.get(eid);
        if (kept && (this.host.tick?.() ?? this.ticks) < kept.until && this.host.keyOf?.(p) !== kept.key) continue;
        best = d; target = p;
      }
      if (target < 0) continue;
      if (best < 24) {
        const left = this.host.give(target, bag, { x: Position.x[eid], y: Position.y[eid] }, this.minedBy.get(eid) === target ? 'mined' : 'loot');
        room.delete(target);
        if (!Object.keys(left).length) {
          this.contents.delete(eid);
          const kept = this.kept.get(eid);
          if (kept) { this.kept.delete(eid); this.host.emptied?.(eid, kept.key); }
          this.host.remove(eid);
        } else {
          this.contents.set(eid, left);
          this.refresh(eid);
          // Bounce off: the hold is full
          Velocity.x[eid] = (Position.x[eid] - Position.x[target]) * 0.02;
          Velocity.y[eid] = (Position.y[eid] - Position.y[target]) * 0.02;
        }
        continue;
      }
      // Tractor: accelerate towards the ship, matching its velocity as it closes
      const dx = Position.x[target] - Position.x[eid], dy = Position.y[target] - Position.y[eid];
      const d = dhypot(dx, dy) || 1;
      const pull = 0.6 + 2.4 * (1 - Math.min(1, best / PULL_RANGE));
      Velocity.x[eid] += (dx / d) * pull + (Velocity.x[target] - Velocity.x[eid]) * 0.08;
      Velocity.y[eid] += (dy / d) * pull + (Velocity.y[target] - Velocity.y[eid]) * 0.08;
    }
    for (const eid of [...this.contents.keys()]) {
      if (!entityExists(w, eid) || hasComponent(w, Dead, eid)) { this.contents.delete(eid); this.ignore.delete(eid); this.minedBy.delete(eid); this.anchors.delete(eid); this.kept.delete(eid); continue; }
      // Still where its anchor's drift puts it? If anything else moved it (a pull, a bounce, a blast), anchor again
      const tick = this.host.tick?.() ?? this.ticks;
      const a = this.anchors.get(eid);
      const at = a && podDrift(a, tick - a.t);
      if (!at || Math.abs(at.x - Position.x[eid]) > 0.05 || Math.abs(at.y - Position.y[eid]) > 0.05
        || Math.abs(at.vx - Velocity.x[eid]) > 0.001 || Math.abs(at.vy - Velocity.y[eid]) > 0.001) {
        this.anchors.set(eid, { x: Position.x[eid], y: Position.y[eid], vx: Velocity.x[eid], vy: Velocity.y[eid], t: tick });
      }
    }
  }
}
