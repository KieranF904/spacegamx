/**
 * The Mine Bay's world half (shared rules: common/src/ships/features/minebay/minebay.ts and blasts.ts;
 * docs/design/groups-mines-docking.md section 2). Every pilot's magazines, their drops and the live mines, the trigger
 * pass, blasts, expiry and the cap.
 *
 * Netcode: a drop is one decision record (`minesLaid`, a MineDrop) that every end derives the mines from: where each
 * slides to and rests, when it arms and when it fizzles out. Nothing about a mine is streamed. The server decides
 * detonations and deals the damage the usual way (ShipBridge.splashAt -> hurt). A life's end is derived on both ends and
 * never sent; the cap's and a clear's fizzles are told at once.
 *
 * Blasts (stage M2, common blasts.ts): a client searching its own windows finds the blasts set off by ships whose poses
 * it has exactly (`mineFindable` ships, the same ones its hit search uses), so the server tells it only the rest. Each
 * tick's pass keeps what any client's search could find (a `Touch`: the mine, the tick, the findable ships touching it,
 * and who really set it off, if anyone); as each pilot's snapshot window closes (`onSnapshot`) its touches are settled
 * for it, in tick order:
 *   a blast   its search finds it on that tick (a findable ship exact on its layer touched it): nothing; else `minesGone`
 *   no blast  but its search may find one (a findable ship touched it that only the server knows can't set it off:
 *             dormant, jumping, a berthed owner): `minesKept`, and from then on that mine's end is told to it (`Drop.kept`)
 * A pilot that is dead (no snapshots till it flies again) is told its blasts at once; one whose windows leave touches
 * unsettled past any window it searches (no snapshots that long) is told their blasts when they are let go.
 *
 * Who is told a drop: the owner, and every pilot in the system whose client holds the owner or who is within
 * TELL_REACH of the drop; a pilot who comes to hold it later (first sight, entering the system, joining) is told every
 * live drop then (and, quietly, which of its mines are already gone). Everything else goes to the pilots told of it.
 *
 * Magazines live in the pilot's ship record (`FieldRecord.mines`, uid -> loaded): the field fabricator's rearm job
 * (game/field/FieldShips.ts) fills them there, a drop takes from them, a bay lost empties its own. The pilot's client
 * is sent `mineBay` whenever they or the cooldown change.
 */

import { defineQuery, hasComponent } from 'bitecs';
import {
  Player, Dead, InSystem, Position, Velocity, Rotation, MINES, MineBuckets, makeDrop, mineArmed, mineExpired, mineFindable, mineId,
  minePos, mineRest, nextReady, pickBay, SEARCH_WINDOW_MAX, type MineDrop, type MineEnd, type ShipState,
} from '@space-game/common';
import type { FeatureInstance, FeatureMessageHandler, HoldCap, RulesCap, ShipsOf, SnapshotWindow, StationCap, TellCap, WorldCap } from '../types.js';

/** What the Mine Bay asks of the game: the ships it may set off and splash, who may hurt whom, telling pilots, the profile (laid mines) */
export type MineHost = WorldCap & ShipsOf<'bodies' | 'get' | 'isDormant' | 'isJumping' | 'splashAt'> & Pick<TellCap, 'send'>
  & Pick<StationCap, 'isDocked'> & Pick<HoldCap, 'profile' | 'markDirty'> & RulesCap;

const playerQuery = defineQuery([Player]);

/** A pilot this far from a drop is told it even if its client doesn't hold the owner (world units) */
export const TELL_REACH = 8000;
/** How often pilots that came to hold a drop are looked for (ticks) */
const TELL_EVERY = 15;
/** A press may be stamped this far ahead of the server's tick at most (an input's lead: net/handlers/flight.ts) */
const MAX_PRESS_LEAD = 64;
/** Presses waiting for their tick, per pilot, at most */
const MAX_PENDING = 4;
/** Touches a pilot's windows haven't settled are let go after this long (their blasts told then): past any window it searches */
const TOUCH_KEEP = SEARCH_WINDOW_MAX * 2;

interface Drop {
  d: MineDrop;
  sys: number;
  /** Where each mine rests (armed mines are always at rest: armTicks > slideTicks) */
  rest: [number, number][];
  /** Each mine's key in the pass's tables, [this drop, its index]: made once */
  refs: [Drop, number][];
  /** Mines gone (bit i: mine i) */
  gone: number;
  /** Pilots told of it */
  told: Set<number>;
  /** Mines whose ends are told to a pilot whatever it could find (a minesKept went), by pilot: bit i mine i */
  kept?: Map<number, number>;
}

/**
 * One mine on one tick's pass that a client's search could find going off, or that went off: the findable ships
 * touching it, and who really set it off (-1: no one)
 */
interface Touch { dr: Drop; i: number; tick: number; by: number; findable: number[] }

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
  /** The tick its snapshot windows have settled touches up to (-1: none yet) */
  settled: number;
}

const bitsOf = (n: number) => (n >= 31 ? -1 : (1 << n) - 1);
const NONE: number[] = [];

export class Minefield implements FeatureInstance {
  private readonly pilots = new Map<number, Pilot>();
  /** The trigger pass's armed mines, by system (common blasts.ts MineBuckets: the geometry a client's search uses) */
  private readonly grid = new Map<number, MineBuckets<[Drop, number]>>();
  private readonly spareGrids: MineBuckets<[Drop, number]>[] = [];
  /** This pass: who sets each mine off (the lowest id the rules let), and the findable ships touching it */
  private readonly passBy = new Map<[Drop, number], number>();
  private readonly passFindable = new Map<[Drop, number], number[]>();
  /** Touches not yet settled for every pilot told of them, in tick order */
  private touches: Touch[] = [];

  constructor(private readonly host: MineHost) {}

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
    if (p) { this.settleNow(p, this.host.getTick()); this.clear(p, 'clear'); }
    this.pilots.delete(eid);
    this.forget(eid);
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
        this.forget(eid);
        p.sys = sys;
      }
      this.syncMagazines(p);
      while (p.pending.length && p.pending[0] <= now) { p.pending.shift(); this.drop(p, now); }
      this.sendBay(p, false);
    }
    this.expire(now);
    this.triggers(now);
    this.letGo(now);
    if (now % TELL_EVERY === 0) this.tellAll();
  }

  /**
   * A pilot's snapshot window closes (just before its snapshot goes): the touches in it settled for that pilot, in tick
   * order. What its client finds itself goes unsaid; a blast it can't find is told, and a blast it may find that never
   * happened is taken back (minesKept)
   */
  onSnapshot(pilot: number, win: SnapshotWindow): void {
    const p = this.pilots.get(pilot);
    if (!p) return;
    // (touches up to `done` were settled already: by an earlier window, or told while it got no snapshots: deadSettle)
    const done = Math.max(p.settled, win.from);
    p.settled = Math.max(p.settled, win.to);
    for (const t of this.touches) {
      if (t.tick <= done || t.tick > win.to || !t.dr.told.has(pilot)) continue;
      const id = mineId(t.dr.d.owner, t.dr.d.tick, t.i), kept = ((t.dr.kept?.get(pilot) ?? 0) >> t.i) & 1;
      if (t.by >= 0) {
        // (its search finds it on this tick if a findable ship exact on its layer touched it then)
        const finds = win.finds && !kept && t.findable.some((s) => win.exact(s));
        if (!finds) this.host.send(pilot, { type: 'minesGone', tick: t.tick, ids: [id], how: 'blast', by: t.by });
      } else if (win.finds && !kept && t.findable.length) {
        // (Any findable ship, exact on its layer or not: one it holds only roughly may be searched all the same. From
        // now on this mine's end is told to it, and its search leaves the mine alone)
        this.host.send(pilot, { type: 'minesKept', tick: t.tick, ids: [id] });
        (t.dr.kept ??= new Map()).set(pilot, (t.dr.kept.get(pilot) ?? 0) | (1 << t.i));
      }
    }
  }

  // ===================================================================== for tests and the integrator

  /** A pilot's live mines now: [id, x, y, armed] (tests) */
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

  /** Touches not yet let go (tests) */
  get pendingTouches(): number { return this.touches.length; }

  // ===================================================================== pilots and magazines

  private pilot(eid: number): Pilot {
    let p = this.pilots.get(eid);
    if (!p) {
      p = { eid, drops: [], readyBy: {}, pending: [], rebuilds: -1, sent: -1, sys: InSystem.systemId[eid], settled: -1 };
      this.pilots.set(eid, p);
    }
    return p;
  }

  /** A pilot hears no more of the drops it was told (it left, or moved to another system) */
  private forget(eid: number): void {
    for (const q of this.pilots.values()) for (const dr of q.drops) { dr.told.delete(eid); dr.kept?.delete(eid); }
    for (const t of this.touches) t.dr.told.delete(eid);
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
    for (let i = 0; i < n; i++) rest.push(mineRest(d, i));
    const dr: Drop = { d, sys: InSystem.systemId[eid], rest, refs: [], gone: 0, told: new Set() };
    for (let i = 0; i < n; i++) dr.refs.push([dr, i]);
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
    // Armed mines into each system's buckets (none armed: nothing to do)
    for (const g of this.grid.values()) { g.clear(); this.spareGrids.push(g); }
    this.grid.clear();
    let any = false;
    for (const p of this.pilots.values()) {
      for (const dr of p.drops) {
        if (!mineArmed(dr.d, now)) continue;
        let g = this.grid.get(dr.sys);
        if (!g) this.grid.set(dr.sys, (g = this.spareGrids.pop() ?? new MineBuckets()));
        for (let i = 0; i < dr.d.n; i++) {
          if (dr.gone & (1 << i)) continue;
          g.add(dr.refs[i], dr.rest[i][0], dr.rest[i][1]);
          any = true;
        }
      }
    }
    if (!any) return;
    // Each ship against the mines it touches: who sets each off (the lowest id the rules let), and which findable ships
    // touch it (where a client's search could find it going off: common blasts.ts, the same geometry and rule)
    const ships = this.host.ships, by = this.passBy, findable = this.passFindable;
    by.clear();
    findable.clear();
    for (const [eid, ship] of ships.bodies) {
      if (ship.kind !== 'ship') continue;
      const g = this.grid.get(InSystem.systemId[eid]);
      if (!g) continue;
      const canFind = !hasComponent(this.host.world, Player, eid) && mineFindable(this.host.sideOf?.(eid) ?? 0);
      g.touching(Position.x[eid], Position.y[eid], ship.derived.radius, (ref) => {
        const owner = ref[0].d.owner;
        if (eid === owner) return;
        if (canFind) { const f = findable.get(ref); if (f) f.push(eid); else findable.set(ref, [eid]); }
        const was = by.get(ref);
        if ((was === undefined || eid < was) && this.setsOff(owner, eid, ship)) by.set(ref, eid);
      });
    }
    if (!by.size && !findable.size) return;
    // (Kept for the pilots' windows: every blast and every findable touch. Set off after the pass: a blast may break
    // ships up, and the pass walks the bodies)
    const blasts: Touch[] = [];
    for (const ref of new Set([...by.keys(), ...findable.keys()])) {
      const t: Touch = { dr: ref[0], i: ref[1], tick: now, by: by.get(ref) ?? -1, findable: findable.get(ref) ?? NONE };
      this.touches.push(t);
      if (t.by >= 0) { t.dr.gone |= 1 << t.i; blasts.push(t); }
    }
    for (const t of blasts) this.blast(t);
    for (const p of this.pilots.values()) if (p.drops.some((dr) => (dr.gone & bitsOf(dr.d.n)) === bitsOf(dr.d.n))) p.drops = p.drops.filter((dr) => (dr.gone & bitsOf(dr.d.n)) !== bitsOf(dr.d.n));
  }

  /**
   * Touches every pilot told of them has settled, or older than any window a client searches: let go. A pilot whose
   * windows never settled them (no snapshot all that while) is told their blasts now
   */
  private letGo(now: number): void {
    if (!this.touches.length) return;
    // (A pilot dead now gets no snapshots till it flies again: its blasts are told at once, the mine that killed it too)
    for (const p of this.pilots.values()) if (p.settled < now && hasComponent(this.host.world, Dead, p.eid)) this.settleNow(p, now);
    let k = 0;
    for (; k < this.touches.length; k++) {
      const t = this.touches[k];
      let open = false;
      for (const v of t.dr.told) if ((this.pilots.get(v)?.settled ?? -1) < t.tick) { open = true; break; }
      if (!open) continue;
      if (now - t.tick <= TOUCH_KEEP) break;
      if (t.by < 0) continue;
      const id = mineId(t.dr.d.owner, t.dr.d.tick, t.i);
      for (const v of t.dr.told) if ((this.pilots.get(v)?.settled ?? -1) < t.tick) this.host.send(v, { type: 'minesGone', tick: t.tick, ids: [id], how: 'blast', by: t.by });
    }
    if (k) this.touches.splice(0, k);
  }

  /** Does this ship set off the owner's mine? Never the owner or the owner's party; never a berthed or warded ship, nor one the owner may not hurt */
  private setsOff(owner: number, eid: number, ship: ShipState): boolean {
    if (eid === owner || hasComponent(this.host.world, Dead, eid)) return false;
    if (this.host.ships.isJumping(ship) || this.host.ships.isDormant(eid) || this.host.isDocked(eid)) return false;
    if (this.host.canDamage && !this.host.canDamage(owner, eid)) return false;
    return !this.host.sameParty?.(owner, eid);
  }

  /** A mine goes off (told to each pilot as its window settles: onSnapshot) */
  private blast(t: Touch): void {
    const { dr, i } = t, [x, y] = dr.rest[i];
    // (Through the normal damage funnel: falloff, shields, armour, PvP rules; the kill is the owner's)
    this.host.ships.splashAt(dr.sys, x, y, MINES.blastRadius, MINES.blastDamage, dr.d.owner);
  }

  /**
   * A pilot that will get no snapshot of its open touches (dead, or gone from the world: the mine that got it, too):
   * their blasts told now, and it is settled up to now
   */
  private settleNow(p: Pilot, now: number): void {
    for (const t of this.touches) {
      if (t.tick <= p.settled || t.by < 0 || !t.dr.told.has(p.eid)) continue;
      this.host.send(p.eid, { type: 'minesGone', tick: t.tick, ids: [mineId(t.dr.d.owner, t.dr.d.tick, t.i)], how: 'blast', by: t.by });
    }
    p.settled = Math.max(p.settled, now);
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
      // (Told late, after some of its mines went: those are gone for it too, quietly)
      if (dr.gone) {
        const ids: number[] = [];
        for (let i = 0; i < d.n; i++) if (dr.gone & (1 << i)) ids.push(mineId(d.owner, d.tick, i));
        this.host.send(v, { type: 'minesGone', tick: this.host.getTick(), ids, how: 'fizzle' });
      }
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
