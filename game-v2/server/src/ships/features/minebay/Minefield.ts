/**
 * The Mine Bay's world half (shared rules: common/src/ships/features/minebay/minebay.ts; docs/design/groups-mines-docking.md
 * section 2). Every pilot's magazines, their drops and the live mines, the trigger pass, blasts, expiry and the cap.
 *
 * Netcode (stage M1): a drop is one decision record (`minesLaid`, a MineDrop) that every end derives the mines from:
 * where each slides to and rests, when it arms and when it fizzles out. Nothing about a mine is streamed. The server
 * decides detonations (it knows parties and true positions) and tells each as a rare event (`minesGone`); the damage
 * goes the usual way (ShipBridge.splashAt -> hurt). A life's end is derived on both ends and never sent.
 *
 * Who is told a drop: the owner, and every pilot in the system whose client holds the owner or who is within
 * TELL_REACH of the drop; a pilot who comes to hold it later (first sight, entering the system, joining) is told every
 * live drop then. `minesGone` goes to the pilots told of the drop.
 *
 * Magazines live in the pilot's ship record (`FieldRecord.mines`, uid -> loaded): the field fabricator's rearm job
 * (game/field/FieldShips.ts) fills them there, a drop takes from them, a bay lost empties its own. The pilot's client
 * is sent `mineBay` whenever they or the cooldown change.
 */

import { defineQuery, hasComponent } from 'bitecs';
import {
  Player, Dead, InSystem, Position, Velocity, Rotation, MINES, makeDrop, mineArmed, mineExpired, mineId, minePos, mineTouches,
  nextReady, pickBay, type MineDrop, type MineEnd, type ShipState,
} from '@space-game/common';
import type { FeatureHost, FeatureInstance, FeatureMessageHandler } from '../types.js';

const playerQuery = defineQuery([Player]);

/** A pilot this far from a drop is told it even if its client doesn't hold the owner (world units) */
export const TELL_REACH = 8000;
/** How often pilots that came to hold a drop are looked for (ticks) */
const TELL_EVERY = 15;
/** A press may be stamped this far ahead of the server's tick at most (an input's lead: net/handlers/flight.ts) */
const MAX_PRESS_LEAD = 64;
/** Presses waiting for their tick, per pilot, at most */
const MAX_PENDING = 4;
/** The trigger pass's buckets (world units): an armed mine is found from the ships near its cell */
const CELL = 256;

interface Drop {
  d: MineDrop;
  sys: number;
  /** Where each mine rests (armed mines are always at rest: armTicks > slideTicks) */
  rest: [number, number][];
  /** Mines gone (bit i: mine i) */
  gone: number;
  /** Pilots told of it */
  told: Set<number>;
}

interface Pilot {
  eid: number;
  /** Live drops, oldest first */
  drops: Drop[];
  /** Each bay's cooldown end (the tick it may drop again), by uid */
  readyBy: Record<number, number>;
  /** Presses waiting for their tick */
  pending: number[];
  /** The ship and rebuild the magazines were last checked against */
  ship?: ShipState;
  rebuilds: number;
  /** What the pilot's client was last sent (-1: nothing yet) */
  sent: number;
  /** The system the pilot was in last tick (a pilot that moves on hears of none of the old system's mines) */
  sys: number;
}

const bitsOf = (n: number) => (n >= 31 ? -1 : (1 << n) - 1);

export class Minefield implements FeatureInstance {
  private readonly pilots = new Map<number, Pilot>();
  /** The trigger pass's buckets, by system then cell key: [drop, mine index] pairs */
  private readonly grid = new Map<number, Map<number, [Drop, number][]>>();
  private readonly blasts: [Drop, number, number][] = [];

  constructor(private readonly host: FeatureHost) {}

  readonly messages: Readonly<Record<string, FeatureMessageHandler>> = {
    mineDrop: (eid, msg) => this.onPress(eid, msg?.tick),
  };

  // ===================================================================== hooks

  onShipRebuilt(eid: number): void {
    const p = this.pilots.get(eid);
    if (p) p.rebuilds = -1;
  }

  onLeave(eid: number): void {
    const p = this.pilots.get(eid);
    if (p) this.clear(p, 'clear');
    this.pilots.delete(eid);
    for (const q of this.pilots.values()) for (const dr of q.drops) dr.told.delete(eid);
  }

  tick(): void {
    const w = this.host.world, now = this.host.getTick();
    for (const eid of playerQuery(w)) {
      if (hasComponent(w, Dead, eid)) {
        const p = this.pilots.get(eid);
        if (p?.drops.length) this.clear(p, 'clear');
        continue;
      }
      const p = this.pilot(eid);
      const sys = InSystem.systemId[eid];
      if (p.sys !== sys) {
        // (Moved on: its own field is cleared, and it hears again of whatever the new system has)
        if (p.drops.length) this.clear(p, 'clear');
        for (const q of this.pilots.values()) for (const dr of q.drops) dr.told.delete(eid);
        p.sys = sys;
      }
      this.syncMagazines(p);
      while (p.pending.length && p.pending[0] <= now) { p.pending.shift(); this.drop(p, now); }
      this.sendBay(p, false);
    }
    this.expire(now);
    this.triggers(now);
    if (now % TELL_EVERY === 0) this.tellAll();
  }

  // ===================================================================== for tests and the integrator

  /** A pilot's live mines now: [id, x, y, armed] (tests; M2's replicas would derive the same) */
  liveMines(owner: number): { id: number; x: number; y: number; armed: boolean }[] {
    const p = this.pilots.get(owner), now = this.host.getTick(), out: { id: number; x: number; y: number; armed: boolean }[] = [];
    for (const dr of p?.drops ?? []) {
      for (let i = 0; i < dr.d.n; i++) {
        if (dr.gone & (1 << i)) continue;
        const [x, y] = minePos(dr.d, i, now);
        out.push({ id: mineId(dr.d.owner, dr.d.tick, i), x, y, armed: mineArmed(dr.d, now) });
      }
    }
    return out;
  }

  /** A pilot's live drop records (oldest first) */
  dropsOf(owner: number): readonly MineDrop[] {
    return (this.pilots.get(owner)?.drops ?? []).map((dr) => dr.d);
  }

  // ===================================================================== pilots and magazines

  private pilot(eid: number): Pilot {
    let p = this.pilots.get(eid);
    if (!p) {
      p = { eid, drops: [], readyBy: {}, pending: [], rebuilds: -1, sent: -1, sys: InSystem.systemId[eid] };
      this.pilots.set(eid, p);
    }
    return p;
  }

  private magazines(eid: number): Record<number, number> | undefined {
    return this.host.profile(eid)?.ship?.field?.mines;
  }

  /** A bay no longer standing loses what it held (a newly built bay starts empty): checked when the ship changes */
  private syncMagazines(p: Pilot): void {
    const ship = this.host.ships.get(p.eid);
    if (!ship || ship.kind !== 'ship' || ship.derived.root < 0) return;
    if (p.ship === ship && p.rebuilds === ship.rebuilds) return;
    p.ship = ship; p.rebuilds = ship.rebuilds;
    const rec = this.host.profile(p.eid)?.ship, mines = rec?.field?.mines;
    if (!rec?.field || !mines) return;
    const bays = new Set((ship.derived.fx?.minebay?.bays ?? []).map((b) => b.uid));
    let changed = false;
    for (const k of Object.keys(mines)) if (!bays.has(Number(k))) { delete mines[Number(k)]; changed = true; }
    if (!Object.keys(mines).length) { delete rec.field.mines; changed = true; }
    if (changed) this.host.markDirty(p.eid);
  }

  /** A short sum of what the pilot's client knows: its bays' loaded mines and cooldowns */
  private signature(p: Pilot): number {
    const bays = p.ship?.derived.fx?.minebay?.bays;
    if (!bays?.length) return 0;
    const mines = this.magazines(p.eid);
    let h = 7;
    for (const b of bays) {
      h = (Math.imul(h, 31) + b.uid) | 0;
      h = (Math.imul(h, 31) + (mines?.[b.uid] ?? 0)) | 0;
      h = (Math.imul(h, 31) + (p.readyBy[b.uid] ?? 0)) | 0;
    }
    return h;
  }

  /** The pilot's magazines and cooldowns to its client, when they changed since it was last told (or `refused`: always) */
  private sendBay(p: Pilot, refused: boolean): void {
    const bays = p.ship?.derived.fx?.minebay?.bays;
    const sig = this.signature(p);
    if (!refused && (sig === p.sent || (p.sent === -1 && !bays?.length))) return;
    p.sent = sig;
    const mines = this.magazines(p.eid), now = this.host.getTick();
    const loaded: Record<number, number> = {}, readyBy: Record<number, number> = {};
    for (const b of bays ?? []) {
      loaded[b.uid] = Math.max(0, Math.min(b.capacity, Math.floor(mines?.[b.uid] ?? 0)));
      if ((p.readyBy[b.uid] ?? 0) > now) readyBy[b.uid] = p.readyBy[b.uid];
    }
    const at = nextReady(p.ship?.derived.fx?.minebay, mines, p.readyBy);
    this.host.send(p.eid, {
      type: 'mineBay', loaded, readyAt: Number.isFinite(at) ? Math.max(at, now) : -1,
      ...(Object.keys(readyBy).length ? { readyBy } : {}), ...(refused ? { refused: true } : {}),
    });
  }

  // ===================================================================== drops

  /** A press: dropped on the tick it was stamped with if that is still ahead (as an input would be), else on this tick */
  private onPress(eid: number, tick: unknown): void {
    if (!hasComponent(this.host.world, Player, eid) || hasComponent(this.host.world, Dead, eid)) return;
    const p = this.pilot(eid), now = this.host.getTick();
    if (p.pending.length >= MAX_PENDING) return;
    const t = typeof tick === 'number' && Number.isInteger(tick) && tick > now && tick <= now + MAX_PRESS_LEAD ? tick : now;
    let k = p.pending.length;
    while (k > 0 && p.pending[k - 1] > t) k--;
    p.pending.splice(k, 0, t);
  }

  private drop(p: Pilot, now: number): void {
    const eid = p.eid, ship = this.host.ships.get(eid), info = ship?.derived.fx?.minebay;
    const mines = this.magazines(eid);
    const pick = !ship || this.host.isDocked(eid) ? -1 : pickBay(info, mines, p.readyBy, now);
    if (pick < 0 || !ship || !info || !mines) { this.sendBay(p, true); return; }
    const bay = info.bays[pick];
    const n = Math.min(bay.batch, Math.max(0, Math.floor(mines[bay.uid] ?? 0)));
    mines[bay.uid] -= n;
    if (mines[bay.uid] <= 0) delete mines[bay.uid];
    const rec = this.host.profile(eid)?.ship;
    if (rec?.field?.mines && !Object.keys(rec.field.mines).length) delete rec.field.mines;
    p.readyBy[bay.uid] = now + bay.cooldown;
    this.host.markDirty(eid);
    const d = makeDrop(eid, bay, now, n, ship.derived.com, this.host.tuning.cellSize, {
      x: Position.x[eid], y: Position.y[eid], angle: Rotation.angle[eid], vx: Velocity.x[eid], vy: Velocity.y[eid],
    });
    // The cap: the oldest mines fizzle first to make room
    this.makeRoom(p, n, now);
    const rest: [number, number][] = [];
    for (let i = 0; i < n; i++) rest.push(minePos(d, i, d.tick + MINES.slideTicks));
    const dr: Drop = { d, sys: InSystem.systemId[eid], rest, gone: 0, told: new Set() };
    p.drops.push(dr);
    this.tellDrop(dr, this.views());
    this.sendBay(p, false);
  }

  private liveCount(p: Pilot): number {
    let n = 0;
    for (const dr of p.drops) for (let i = 0; i < dr.d.n; i++) if (!(dr.gone & (1 << i))) n++;
    return n;
  }

  private makeRoom(p: Pilot, adding: number, now: number): void {
    let over = this.liveCount(p) + adding - MINES.capPerPilot;
    for (let k = 0; over > 0 && k < p.drops.length; k++) {
      const dr = p.drops[k], ids: number[] = [];
      for (let i = 0; i < dr.d.n && over > 0; i++) {
        if (dr.gone & (1 << i)) continue;
        dr.gone |= 1 << i;
        ids.push(mineId(dr.d.owner, dr.d.tick, i));
        over--;
      }
      if (ids.length) this.gone(dr, now, ids, 'fizzle');
    }
    p.drops = p.drops.filter((dr) => (dr.gone & bitsOf(dr.d.n)) !== bitsOf(dr.d.n));
  }

  /** Every mine of the pilot's field goes (`clear`: the owner died, left or moved on) */
  private clear(p: Pilot, how: MineEnd): void {
    const now = this.host.getTick();
    for (const dr of p.drops) {
      const ids: number[] = [];
      for (let i = 0; i < dr.d.n; i++) if (!(dr.gone & (1 << i))) ids.push(mineId(dr.d.owner, dr.d.tick, i));
      if (ids.length && !mineExpired(dr.d, now)) this.gone(dr, now, ids, how);
    }
    p.drops = [];
    p.pending.length = 0;
  }

  /** Drops whose life is over: forgotten (every end works the expiry out; nothing is sent) */
  private expire(now: number): void {
    for (const p of this.pilots.values()) {
      if (!p.drops.length) continue;
      if (p.drops.some((dr) => mineExpired(dr.d, now))) p.drops = p.drops.filter((dr) => !mineExpired(dr.d, now));
    }
  }

  // ===================================================================== the trigger pass

  private triggers(now: number): void {
    // Armed mines into buckets (none armed: nothing to do)
    this.grid.clear();
    let any = false;
    for (const p of this.pilots.values()) {
      for (const dr of p.drops) {
        if (!mineArmed(dr.d, now)) continue;
        let g = this.grid.get(dr.sys);
        if (!g) this.grid.set(dr.sys, (g = new Map()));
        for (let i = 0; i < dr.d.n; i++) {
          if (dr.gone & (1 << i)) continue;
          const key = cellKey(Math.floor(dr.rest[i][0] / CELL), Math.floor(dr.rest[i][1] / CELL));
          const b = g.get(key);
          if (b) b.push([dr, i]); else g.set(key, [[dr, i]]);
          any = true;
        }
      }
    }
    if (!any) return;
    const ships = this.host.ships;
    for (const [eid, ship] of ships.bodies) {
      if (ship.kind !== 'ship') continue;
      const g = this.grid.get(InSystem.systemId[eid]);
      if (!g) continue;
      const x = Position.x[eid], y = Position.y[eid], reach = ship.derived.radius + MINES.triggerReach;
      const c0 = Math.floor((x - reach) / CELL), c1 = Math.floor((x + reach) / CELL);
      const r0 = Math.floor((y - reach) / CELL), r1 = Math.floor((y + reach) / CELL);
      for (let cx = c0; cx <= c1; cx++) {
        for (let cy = r0; cy <= r1; cy++) {
          const b = g.get(cellKey(cx, cy));
          if (!b) continue;
          for (const [dr, i] of b) {
            if (dr.gone & (1 << i)) continue;
            const [mx, my] = dr.rest[i];
            if (!mineTouches(mx, my, x, y, ship.derived.radius) || !this.setsOff(dr.d.owner, eid, ship)) continue;
            dr.gone |= 1 << i;
            this.blasts.push([dr, i, eid]);
          }
        }
      }
    }
    // (Set off after the pass: a blast may break ships up, and the pass walks the bodies)
    for (let k = 0; k < this.blasts.length; k++) { const [dr, i, by] = this.blasts[k]; this.blast(dr, i, by, now); }
    this.blasts.length = 0;
    for (const p of this.pilots.values()) if (p.drops.some((dr) => (dr.gone & bitsOf(dr.d.n)) === bitsOf(dr.d.n))) p.drops = p.drops.filter((dr) => (dr.gone & bitsOf(dr.d.n)) !== bitsOf(dr.d.n));
  }

  /** Does this ship set off the owner's mine? Never the owner or the owner's party; never a berthed or warded ship, nor one the owner may not hurt */
  private setsOff(owner: number, eid: number, ship: ShipState): boolean {
    if (eid === owner || hasComponent(this.host.world, Dead, eid)) return false;
    if (this.host.ships.isJumping(ship) || this.host.ships.isDormant(eid) || this.host.isDocked(eid)) return false;
    if (this.host.canDamage && !this.host.canDamage(owner, eid)) return false;
    return !this.host.sameParty?.(owner, eid);
  }

  private blast(dr: Drop, i: number, by: number, now: number): void {
    const [x, y] = dr.rest[i];
    this.gone(dr, now, [mineId(dr.d.owner, dr.d.tick, i)], 'blast', by);
    // (Through the normal damage funnel: falloff, shields, armour, PvP rules; the kill is the owner's)
    this.host.ships.splashAt(dr.sys, x, y, MINES.blastRadius, MINES.blastDamage, dr.d.owner);
  }

  // ===================================================================== telling

  private gone(dr: Drop, tick: number, ids: number[], how: MineEnd, by?: number): void {
    for (const v of dr.told) this.host.send(v, { type: 'minesGone', tick, ids, how, ...(by !== undefined ? { by } : {}) });
  }

  /** Each pilot's ship view, once per pass (its client holds the ships in it) */
  private views(): Map<number, ReadonlySet<number> | undefined> {
    const out = new Map<number, ReadonlySet<number> | undefined>();
    for (const eid of playerQuery(this.host.world)) if (!hasComponent(this.host.world, Dead, eid)) out.set(eid, this.host.shipView?.(eid));
    return out;
  }

  /** Tell a drop to every pilot that holds it and hasn't been told */
  private tellDrop(dr: Drop, views: Map<number, ReadonlySet<number> | undefined>): void {
    const d = dr.d;
    for (const [v, view] of views) {
      if (dr.told.has(v) || InSystem.systemId[v] !== dr.sys) continue;
      const near = Math.abs(Position.x[v] - d.x) <= TELL_REACH && Math.abs(Position.y[v] - d.y) <= TELL_REACH;
      if (v !== d.owner && !near && !view?.has(d.owner)) continue;
      dr.told.add(v);
      this.host.send(v, { type: 'minesLaid', ...d });
    }
  }

  /** Pilots that came to hold a live drop since (first sight of the owner, came near, entered the system, joined) */
  private tellAll(): void {
    let any = false;
    for (const p of this.pilots.values()) if (p.drops.length) { any = true; break; }
    if (!any) return;
    const views = this.views();
    for (const p of this.pilots.values()) for (const dr of p.drops) this.tellDrop(dr, views);
  }
}

/** A bucket's key from its cell coordinates (each within +-2^20 cells) */
const cellKey = (cx: number, cy: number) => (cx + 0x100000) * 0x200000 + (cy + 0x100000);
