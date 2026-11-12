/**
 * Loot pods: containers floating in space (drops, jettisoned cargo, a
 * destroyed pilot's hold). A pod drifts to a stop; a ship that comes close
 * pulls it in if it would pick up something in it by itself (ore, or an item
 * its hold has a ghost of: common econ/holdGhosts.ts), and only that goes
 * into cargo. The rest waits for the pickup panel: each pilot is told what is
 * in reach when that changes (`lootNear`), and takes it with one `lootTake`
 * (docs/design/loot-pickup-2026-11.md).
 *
 * Pods are DroppedItem entities. Snapshot data: [rarity index of the best
 * item inside, number of kinds of item, item count].
 */

import { addEntity, addComponent, hasComponent, entityExists, defineQuery, IWorld } from 'bitecs';
import {
  Position, Velocity, Radius, DroppedItem, Lifetime, InSystem, NetworkSync, Dead, Player,
  Bag, ItemCatalog, RARITIES, POD_DRAG, podDrift, podHold, podCarry, type PodHold, type LandmarkSet, dcos, dhypot, dsin, mulberry32, type LootNearPod,
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
  /** A system's moving landmarks (common world/landmarks.ts): a pod anchored in one's zone is carried with it */
  landmarks?(systemNum: number): LandmarkSet | undefined;
  /** Who a player is, for pods kept for one pilot (a wreck): their account, not their entity */
  keyOf?(playerEid: number): string | undefined;
  /** A kept pod was emptied */
  emptied?(eid: number, key: string): void;
  /** Of a pod's contents, what this ship would pick up by itself (none given: all of it, as far as it fits) */
  autoTake?(playerEid: number, items: Bag): Bag;
  /** Tell a pilot what is in their pickup reach (only when it changed) */
  sendNear?(playerEid: number, pods: LootNearPod[]): void;
  /** A pilot's take found no room for anything */
  holdFull?(playerEid: number): void;
}

/**
 * Where a pod was, how fast, on which tick: from there it just drifts (podDrift) until something moves it. `hold`
 * (server only, never sent: clients work it out from the anchor as sent, common world/landmarks.ts podHold): the moving
 * landmark whose zone the anchor was laid in; the pod is carried with it by that weight until it is anchored again
 */
export interface PodAnchor { x: number; y: number; vx: number; vy: number; t: number; hold?: PodHold | null }

const CARRIED = { x: 0, y: 0 }, CARRIED_BEFORE = { x: 0, y: 0 };

const podQuery = defineQuery([DroppedItem, Position]);

/** Seconds a pod lasts before it's gone */
const POD_LIFE_TICKS = 60 * 60 * 5;
/** Pull starts this far beyond the ship's hull; collection at the hull. Also the pickup panel's reach */
export const PULL_RANGE = 380;
/** How often (ticks) each pilot's pickup reach is looked at again (sent only when it changed) */
const NEAR_EVERY = 10;

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
  /** Pods only one pilot can take until a tick (their wreck); `whole`: a job's container, which its pilot pulls in whole by flying into it */
  private kept = new Map<number, { key: string; until: number; whole?: boolean }>();
  /** What each pilot was last told is in their reach (a key of it), so it's sent only when it changes */
  private nearSent = new Map<number, string>();

  /**
   * Only `key`'s pilot can collect this pod until `untilTick`. `whole`: a job's container (Operations' recover, a cache):
   * its pilot pulls it all in by flying into it, as the job says, not through the pickup panel
   */
  keep(eid: number, key: string, untilTick: number, whole = false): void {
    if (this.contents.has(eid)) this.kept.set(eid, { key, until: untilTick, ...(whole ? { whole } : {}) });
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

  // ---- The pickup panel (docs/design/loot-pickup-2026-11.md C)
  /** May this ship take from this pod now (not someone else's wreck still kept for them) */
  private mayTake(eid: number, p: number): boolean {
    const kept = this.kept.get(eid);
    return !kept || (this.host.tick?.() ?? this.ticks) >= kept.until || this.host.keyOf?.(p) === kept.key;
  }

  /** Pods in a ship's pickup reach (PULL_RANGE past its hull), nearest first */
  inReach(p: number): number[] {
    const r = this.host.shipRadius(p);
    const d = (eid: number) => dhypot(Position.x[eid] - Position.x[p], Position.y[eid] - Position.y[p]);
    return this.near(InSystem.systemId[p], Position.x[p], Position.y[p], PULL_RANGE + r).sort((a, b) => d(a) - d(b) || a - b);
  }

  /**
   * The panel's one decision: take `item` (or everything) from the pods in reach into the ship's hold, nearest pod
   * first, as far as the hold has room (a manual take may use space ghosts keep). Returns what was taken
   */
  takeFor(p: number, item?: string): Bag {
    const w = this.host.world;
    if (!hasComponent(w, Player, p) || hasComponent(w, Dead, p)) return {};
    const got: Bag = {};
    let full = false;
    for (const eid of this.inReach(p)) {
      const bag = this.contents.get(eid);
      if (!bag || !this.mayTake(eid, p)) continue;
      const want: Bag = item === undefined ? { ...bag } : bag[item] ? { [item]: bag[item] } : {};
      if (!Object.keys(want).length) continue;
      const left = this.host.give(p, want, { x: Position.x[eid], y: Position.y[eid] }, 'loot');
      const rest: Bag = { ...bag };
      for (const [id, n] of Object.entries(want)) {
        const k = n - (left[id] ?? 0);
        if (k <= 0) continue;
        got[id] = (got[id] ?? 0) + k;
        rest[id] -= k;
        if (rest[id] <= 0) delete rest[id];
      }
      this.settle(eid, rest);
      if (Object.keys(left).length) { full = true; break; }
    }
    if (full && !Object.keys(got).length) this.host.holdFull?.(p);
    return got;
  }

  /** What a pilot's panel lists: each pod in reach with its contents, and a wreck's keeping */
  nearFor(p: number): LootNearPod[] {
    const now = this.host.tick?.() ?? this.ticks;
    const key = this.host.keyOf?.(p);
    const out: LootNearPod[] = [];
    for (const eid of this.inReach(p)) {
      const bag = this.contents.get(eid);
      if (!bag) continue;
      const kept = this.kept.get(eid);
      const pod: LootNearPod = { id: eid, items: { ...bag } };
      if (kept && kept.key === key) pod.mine = true;
      else if (kept && now < kept.until) pod.lock = Math.ceil((kept.until - now) / 60);
      out.push(pod);
    }
    return out;
  }

  /** Every NEAR_EVERY ticks: tell each pilot whose reach changed what is in it now */
  private sendNear(): void {
    if (!this.host.sendNear) return;
    const w = this.host.world;
    const systems = new Set<number>();
    for (const eid of podQuery(w)) if (this.contents.has(eid)) systems.add(InSystem.systemId[eid]);
    // (And wherever someone was told of pods last time: an empty list tells them they've gone)
    for (const p of this.nearSent.keys()) systems.add(InSystem.systemId[p]);
    const seen = new Set<number>();
    for (const sys of systems) {
      for (const p of this.host.collectors(sys)) {
        if (seen.has(p) || !hasComponent(w, Player, p) || hasComponent(w, Dead, p)) continue;
        seen.add(p);
        const pods = this.nearFor(p);
        // (A wreck's lock counts down on the client: its end, not the seconds left, is what changes the list)
        const k = pods.map((q) => `${q.id}:${q.mine ? 'm' : ''}${q.lock ? this.kept.get(q.id)?.until : ''}:${Object.entries(q.items).map(([i, n]) => `${i}=${n}`).join(',')}`).join('|');
        if ((this.nearSent.get(p) ?? '') === k) continue;
        if (k) this.nearSent.set(p, k); else this.nearSent.delete(p);
        this.host.sendNear(p, pods);
      }
    }
    for (const p of [...this.nearSent.keys()]) if (!seen.has(p)) this.nearSent.delete(p);
  }

  /** A pod's contents after a take: emptied (and a wreck recovered), or what's left */
  private settle(eid: number, rest: Bag): void {
    if (Object.keys(rest).length) { this.contents.set(eid, rest); this.refresh(eid); return; }
    this.contents.delete(eid);
    const kept = this.kept.get(eid);
    if (kept) { this.kept.delete(eid); this.host.emptied?.(eid, kept.key); }
    this.host.remove(eid);
  }
  // ---- (end pickup panel)

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

  /** Drift, pull towards nearby ships that would pick something in it up by themselves, and collect that */
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
    // What a ship in reach would pick up by itself from a pod (ore, its hold's ghosts; its own job container whole); without the rule, all of it
    const autoOf = (p: number, bag: Bag, eid: number) => {
      const kept = this.kept.get(eid);
      if (!this.host.autoTake || (kept?.whole && this.host.keyOf?.(p) === kept.key)) return bag;
      return this.host.autoTake(p, bag);
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

      let target = -1, best = Infinity, take: Bag = {};
      const sys = InSystem.systemId[eid];
      let near = collectors.get(sys);
      if (!near) collectors.set(sys, (near = this.host.collectors(sys).filter((p) => hasComponent(w, Player, p) && !hasComponent(w, Dead, p))));
      for (const p of near) {
        // Distance first: the rest only matters for a ship in reach
        const d = dhypot(Position.x[p] - Position.x[eid], Position.y[p] - Position.y[eid]) - this.host.shipRadius(p);
        if (d >= PULL_RANGE || d >= best || roomOf(p) < 1) continue;
        const ig = this.ignore.get(eid);
        if (ig && ig.eid === p && this.ticks < ig.until) continue;
        if (!this.mayTake(eid, p)) continue;
        // (Nothing in it this ship picks up by itself: it waits for the pickup panel)
        const auto = autoOf(p, bag, eid);
        if (!Object.keys(auto).length) continue;
        best = d; target = p; take = auto;
      }
      if (target < 0) continue;
      if (best < 24) {
        const left = this.host.give(target, take, { x: Position.x[eid], y: Position.y[eid] }, this.minedBy.get(eid) === target ? 'mined' : 'loot');
        room.delete(target);
        const rest: Bag = { ...bag };
        for (const [id, n] of Object.entries(take)) { rest[id] -= n - (left[id] ?? 0); if (rest[id] <= 0) delete rest[id]; }
        this.settle(eid, rest);
        if (Object.keys(left).length && Object.keys(rest).length) {
          // Bounce off: the hold is full
          Velocity.x[eid] = (Position.x[eid] - Position.x[target]) * 0.02;
          Velocity.y[eid] = (Position.y[eid] - Position.y[target]) * 0.02;
        } else if (Object.keys(rest).length) {
          // What it won't pick up by itself rides along beside the ship, in the panel's reach, rather than coasting off
          Velocity.x[eid] = Velocity.x[target];
          Velocity.y[eid] = Velocity.y[target];
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
      const set = this.host.landmarks?.(InSystem.systemId[eid]);
      // (Held by a moving landmark: this tick's share of its move, then where the anchor and the landmark put it now)
      if (a?.hold && at && set) {
        podCarry(set, a.hold, tick, CARRIED);
        podCarry(set, a.hold, tick - 1, CARRIED_BEFORE);
        Position.x[eid] += CARRIED.x - CARRIED_BEFORE.x;
        Position.y[eid] += CARRIED.y - CARRIED_BEFORE.y;
        at.x += CARRIED.x; at.y += CARRIED.y;
      }
      if (!at || Math.abs(at.x - Position.x[eid]) > 0.05 || Math.abs(at.y - Position.y[eid]) > 0.05
        || Math.abs(at.vx - Velocity.x[eid]) > 0.001 || Math.abs(at.vy - Velocity.y[eid]) > 0.001) {
        // (Its hold from the anchor as the snapshot row sends it, to a tenth: net/snapshot/rows/bodies.ts podRows)
        const x = Position.x[eid], y = Position.y[eid];
        this.anchors.set(eid, { x, y, vx: Velocity.x[eid], vy: Velocity.y[eid], t: tick, hold: podHold(set, Math.round(x * 10) / 10, Math.round(y * 10) / 10, tick) });
      } else if (a?.hold) {
        // (Exactly there: a long carry adds no rounding of its own)
        Position.x[eid] = at.x; Position.y[eid] = at.y;
      }
    }
    if (this.ticks % NEAR_EVERY === 0) this.sendNear();
  }
}
