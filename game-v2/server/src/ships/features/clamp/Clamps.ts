/**
 * Docking Clamps' world half (docs/design/groups-mines-docking.md 3; shared rules: common ships/features/clamp/clamp.ts;
 * the joined flight: common sim/clampPair.ts, on the server's ships ships/bridge/clamp.ts). The decisions, all taken
 * here in the features' tick or a message, each effective from the next tick:
 *
 *   lock    both pilots pressed the dock key (`clampDock`) on each other's clamps within CLAMP.pressWindow, and the
 *           server finds them lined up now (clampLinedUp, no slack). The first to press steers (the leader)
 *   swap    docked, both pressed the swap key (`clampSwap`) within the window: the same pair, the other one steers
 *   undock  docked, either pilot alone (`clampUndock`): they let go, pushed apart along the clamps' line
 *   breaks  either ship destroyed (death), gone from the world or the system (gone), a jump key held (jump: the drive
 *           works only solo; the charge starts the tick after), berthed at a station (station), either clamp lost (part)
 *
 * Told as rare events: `clampAsk` to the other pilot while a press waits, `clampLink` (lock, swap, a rebuild's fresh
 * offset) and `clampBreak` to every pilot in the pair's system, and each open link again to a pilot that comes there.
 */

import { hasComponent } from 'bitecs';
import {
  Position, Velocity, Rotation, InSystem, Dead, Player, Input, CLAMP, clampWorld, clampFit, clampLinedUp, clampOffset, pairKey,
  type ClampInfo, type ClampBody, type ShipState, type ClampBreak,
} from '@space-game/common';
import type { FeatureHost, FeatureInstance, FeatureMessageHandler } from '../types.js';
import type { ServerClampLink } from '../../bridge/clamp.js';

type Clamp = ClampInfo['clamps'][number];

/** A pilot's last press: dock (on whom, which clamps) or swap, and its tick */
interface Press { what: 'dock' | 'swap'; with: number; mine: number; theirs: number; tick: number }

/** How often an open link is offered to pilots who came to the pair's system (ticks) */
const RETELL_TICKS = 30;

export class Clamps implements FeatureInstance {
  private readonly presses = new Map<number, Press>();
  /** Pairs that let go lately: no lock again until this tick */
  private readonly relock = new Map<string, number>();
  /** The pilots each open link was told to (by its leader and follower) */
  private readonly told = new Map<ServerClampLink, Set<number>>();
  readonly messages: Readonly<Record<string, FeatureMessageHandler>>;

  constructor(private readonly host: FeatureHost) {
    this.messages = {
      clampDock: (eid, msg) => this.dock(eid, msg),
      clampSwap: (eid) => this.swap(eid),
      clampUndock: (eid) => this.undock(eid),
    };
  }

  private get table() { return this.host.ships.clamps; }
  private now(): number { return this.host.getTick(); }

  // ------------------------------------------------------------------------------------------------ the presses

  private clampOf(eid: number, uid: number): { ship: ShipState; c: Clamp } | null {
    const ship = this.host.ships.get(eid);
    if (!ship || ship.kind !== 'ship') return null;
    const c = ship.derived.fx?.clamp?.clamps.find((x) => x.uid === uid);
    return c ? { ship, c } : null;
  }

  private flying(eid: number): boolean {
    return hasComponent(this.host.world, Player, eid) && !hasComponent(this.host.world, Dead, eid) && this.host.ships.has(eid) && !this.host.isDocked(eid);
  }

  private body(eid: number, ship: ShipState): ClampBody {
    return { x: Position.x[eid], y: Position.y[eid], vx: Velocity.x[eid], vy: Velocity.y[eid], angle: Rotation.angle[eid], angVel: ship.angVel };
  }

  /** Are these two clamps lined up now, at `slack` (1: the lock's tolerances) */
  linedUp(a: number, ca: number, b: number, cb: number, slack = 1): boolean {
    const A = this.clampOf(a, ca), B = this.clampOf(b, cb);
    if (!A || !B || A.c.size !== B.c.size) return false;
    const cs = this.host.tuning.cellSize;
    const ba = this.body(a, A.ship), bb = this.body(b, B.ship);
    const fit = clampFit(clampWorld(A.c, A.ship.derived.com, cs, ba), clampWorld(B.c, B.ship.derived.com, cs, bb));
    return clampLinedUp(fit, ba, bb, slack);
  }

  private dock(eid: number, msg: { with?: unknown; clamp?: unknown; theirs?: unknown }): void {
    const other = Number(msg.with), mine = Number(msg.clamp), theirs = Number(msg.theirs);
    if (!Number.isInteger(other) || !Number.isInteger(mine) || !Number.isInteger(theirs) || other === eid) return;
    if (this.table.open(eid) || this.table.open(other)) return;
    if (!this.flying(eid) || !this.flying(other) || InSystem.systemId[eid] !== InSystem.systemId[other]) return;
    const A = this.clampOf(eid, mine), B = this.clampOf(other, theirs);
    if (!A || !B || A.c.size !== B.c.size) return;
    const now = this.now();
    if ((this.relock.get(pairKey(eid, other)) ?? -Infinity) > now) return;
    this.presses.set(eid, { what: 'dock', with: other, mine, theirs, tick: now });
    const p = this.presses.get(other);
    if (p && p.what === 'dock' && p.with === eid && p.mine === theirs && p.theirs === mine && now - p.tick <= CLAMP.pressWindow) {
      // Both pressed: lined up now, the first to press steers
      if (!this.linedUp(eid, mine, other, theirs)) {
        this.host.tell(eid, 'Not lined up: line the clamps up and press again');
        this.host.tell(other, 'Not lined up: line the clamps up and press again');
        this.presses.delete(eid); this.presses.delete(other);
        return;
      }
      this.presses.delete(eid); this.presses.delete(other);
      this.lock(other, theirs, eid, mine, now + 1);
      return;
    }
    this.host.send(other, { type: 'clampAsk', from: eid, what: 'dock', until: now + CLAMP.pressWindow });
  }

  private swap(eid: number): void {
    const k = this.table.open(eid);
    const now = this.now();
    if (!k || k.from > now + 1) return;
    const other = k.leader === eid ? k.follower : k.leader;
    this.presses.set(eid, { what: 'swap', with: other, mine: 0, theirs: 0, tick: now });
    const p = this.presses.get(other);
    if (p && p.what === 'swap' && p.with === eid && now - p.tick <= CLAMP.pressWindow) {
      this.presses.delete(eid); this.presses.delete(other);
      // (The same pair from the next tick, the other one steering: its clamp the leader's)
      this.lock(k.follower, k.fc, k.leader, k.lc, now + 1);
      return;
    }
    this.host.send(other, { type: 'clampAsk', from: eid, what: 'swap', until: now + CLAMP.pressWindow });
  }

  private undock(eid: number): void {
    const k = this.table.open(eid);
    if (k) this.breakLink(k, 'undock');
  }

  // ------------------------------------------------------------------------------------------------ the records

  /** Lock (or relock: a swap, a fresh offset) leader on clamp lc to follower on fc, from tick `from` */
  private lock(leader: number, lc: number, follower: number, fc: number, from: number): void {
    const L = this.clampOf(leader, lc), F = this.clampOf(follower, fc);
    if (!L || !F) return;
    const old = this.table.open(leader) ?? this.table.open(follower);
    if (old) this.told.delete(old);
    const offset = clampOffset(L.c, L.ship.derived.com, F.c, F.ship.derived.com, this.host.tuning.cellSize);
    const k = this.table.lock(leader, follower, lc, fc, offset, from);
    this.tellLink(k, true);
  }

  private linkMsg(k: ServerClampLink) {
    return { type: 'clampLink' as const, tick: k.from, leader: k.leader, follower: k.follower, lc: k.lc, fc: k.fc, offset: { ...k.offset } };
  }

  /** The link to every pilot in the pair's system (all: a new record; else only those not told it yet) */
  private tellLink(k: ServerClampLink, all: boolean): void {
    let told = this.told.get(k);
    if (!told) this.told.set(k, (told = new Set()));
    const here = this.host.pilotsIn?.(k.leader) ?? [k.leader, k.follower];
    const now = new Set(here);
    // (Gone from the system since: told again when it comes back, its replicas having forgotten it)
    for (const p of told) if (!now.has(p)) told.delete(p);
    const msg = this.linkMsg(k);
    for (const p of here) {
      if (!all && told.has(p)) continue;
      told.add(p);
      this.host.send(p, msg);
    }
  }

  /** Let go from the next tick, and tell every pilot in the pair's system */
  private breakLink(k: ServerClampLink, why: ClampBreak): void {
    const now = this.now(), until = now + 1;
    let push: [number, number] | undefined;
    if (why === 'undock') {
      // (Apart along the clamps' line: the leader away from the follower, the follower the other way)
      const L = this.clampOf(k.leader, k.lc);
      if (L) {
        const w = clampWorld(L.c, L.ship.derived.com, this.host.tuning.cellSize, this.body(k.leader, L.ship));
        push = [Math.round(-w.nx * CLAMP.undockPush * 1e4) / 1e4, Math.round(-w.ny * CLAMP.undockPush * 1e4) / 1e4];
      }
    }
    this.table.end(k, until, push);
    this.told.delete(k);
    this.relock.set(pairKey(k.leader, k.follower), now + CLAMP.relockTicks);
    const msg = { type: 'clampBreak' as const, tick: until, a: k.leader, b: k.follower, why, ...(push ? { push } : {}) };
    const sent = new Set<number>();
    for (const p of [...(this.host.pilotsIn?.(k.leader) ?? []), ...(this.host.pilotsIn?.(k.follower) ?? []), k.leader, k.follower]) {
      if (sent.has(p)) continue;
      sent.add(p);
      this.host.send(p, msg);
    }
  }

  // ------------------------------------------------------------------------------------------------ each tick

  tick(): void {
    const now = this.now(), T = this.table;
    T.prune(now);
    for (const [eid, p] of this.presses) if (now - p.tick > CLAMP.pressWindow) this.presses.delete(eid);
    for (const [key, t] of this.relock) if (t <= now) this.relock.delete(key);
    for (const k of [...T.links]) {
      if (k.until !== Infinity) continue;
      const why = this.broken(k);
      if (why) { this.breakLink(k, why); continue; }
      if (now % RETELL_TICKS === 0) this.tellLink(k, false);
    }
  }

  /** Why this link must let go now (null: it holds) */
  private broken(k: ServerClampLink): ClampBreak | null {
    const w = this.host.world;
    for (const eid of [k.leader, k.follower]) if (!this.host.ships.has(eid) || !hasComponent(w, Player, eid)) return 'gone';
    if (InSystem.systemId[k.leader] !== InSystem.systemId[k.follower]) return 'gone';
    // (A pilot whose connection went: its ship may linger a while, but nobody flies it)
    const here = this.host.pilotsIn?.(k.leader);
    if (here && (!here.includes(k.leader) || !here.includes(k.follower))) return 'gone';
    if (hasComponent(w, Dead, k.leader) || hasComponent(w, Dead, k.follower)) return 'death';
    if (this.host.isDocked(k.leader) || this.host.isDocked(k.follower)) return 'station';
    if (Input.jump[k.leader] || Input.jump[k.follower]) return 'jump';
    if (!this.clampOf(k.leader, k.lc) || !this.clampOf(k.follower, k.fc)) return 'part';
    return null;
  }

  onShipRebuilt(eid: number): void {
    const k = this.table.open(eid);
    if (!k) return;
    const L = this.clampOf(k.leader, k.lc), F = this.clampOf(k.follower, k.fc);
    if (!L || !F) { this.breakLink(k, 'part'); return; }
    // (A centre of mass moved: the same clamps at a fresh offset, from the next tick)
    const o = clampOffset(L.c, L.ship.derived.com, F.c, F.ship.derived.com, this.host.tuning.cellSize);
    if (o.ox !== k.offset.ox || o.oy !== k.offset.oy || o.oa !== k.offset.oa) this.lock(k.leader, k.lc, k.follower, k.fc, Math.max(k.from, this.now() + 1));
  }

  onLeave(eid: number): void {
    this.presses.delete(eid);
    const k = this.table.open(eid);
    if (k) this.breakLink(k, 'gone');
  }

  /** The link a pilot is in now (tests, the HUD's server side) */
  linkOf(eid: number): ServerClampLink | undefined {
    return this.table.open(eid);
  }
}
