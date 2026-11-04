/**
 * Crowd fallbacks on the server (CAPS.CROWD; common network/crowd.ts; docs/design/awareness-model.md section 7.5).
 *
 * Each system's tick cost is measured (what its share of the tick and of the snapshot rounds took, in ms per base
 * tick), smoothed, and held against a budget with hysteresis: over CROWD_HIGH_MS for a while and the system goes up a
 * level (a smaller focus, a wider window, then a slower clock), under CROWD_LOW_MS for longer and it comes down one. The
 * gap between the two is wider than any one level's saving, and every change holds for a dwell, so levels don't flap.
 * A dev force (F9 crowd, admin `crowd`) pins a system's level.
 *
 * Every change goes to the system's CAPS.CROWD clients as a crowd message stamped with the system tick it takes effect
 * from (a rate change CROWD_RATE_LEAD ticks ahead, so the client's clock turns where the server's does). A client
 * entering a system is told its level. Nothing here touches the simulation: the window is read by the snapshot rounds,
 * the focus radius by the focus grid, and the rate by the system clocks (sim/SystemClocks.ts).
 */
import { InSystem, CROWD_BASE_WINDOW, CROWD_LEVELS, CROWD_MAX_LEVEL, CROWD_RATE_LEAD, crowdLevel, crowdFor, TICK_RATE, type CrowdLevel, type ServerCrowdMessage } from '@space-game/common';
import type { ClientConnection } from '../ClientConnection.js';

/** A system over this (ms of server time per base tick, smoothed) goes up a level */
export const CROWD_HIGH_MS = 13;
/** ...under this, down one */
export const CROWD_LOW_MS = 6;
/**
 * Base ticks a level holds before it may go up again, and before it may come down; and how long the cost must have
 * stayed over the high mark (under the low one) all along for that
 */
const UP_DWELL = 90, DOWN_DWELL = 300, UP_HOLD = 30, DOWN_HOLD = 300;
/** The smoothing (per base tick) */
const ALPHA = 1 / 30;

export interface CrowdHost {
  /** The connected clients */
  clients(): Iterable<ClientConnection>;
  /** The system a client's ship is in (-1: none) */
  systemOf(conn: ClientConnection): number;
  send(conn: ClientConnection, msg: ServerCrowdMessage): void;
  /** A system's own tick now (its clock: behind the server's once it has been slowed) */
  tickOf(system: number): number;
  /** Set a system's rate from its tick `at` on (the system clocks); absent: no dilation, the top levels are left out */
  setRate?(system: number, rate: number, at: number): void;
  /** Does it keep a clock of its own, and its rate now */
  ownClock?(system: number): boolean;
  rateOf?(system: number): number;
}

interface SystemCrowd {
  lv: number;
  /** Forced by a dev (null: automatic) */
  forced: number | null;
  /** Smoothed cost (ms per base tick) */
  cost: number;
  /** This base tick's charges */
  now: number;
  /** Base tick of the last change */
  changed: number;
  /** The tick it was last announced from (its system tick) */
  from: number;
  /** Base ticks its cost has been over the high mark, and under the low one, without a break */
  over: number;
  under: number;
}

export class CrowdControl {
  private readonly systems = new Map<number, SystemCrowd>();
  /** The level each client was last told (absent: 0) */
  private readonly told = new WeakMap<ClientConnection, number>();
  private base = 0;
  /** Changes made (the bench, the tests) */
  readonly log: { tick: number; system: number; from: number; to: number; cost: number; forced: boolean }[] = [];
  /** Turned off: every system stays at level 0 unless forced */
  auto = true;

  constructor(private readonly host: CrowdHost) {}

  /** The highest level this server can reach (no clocks: none of the dilation levels) */
  get maxLevel(): number {
    if (this.host.setRate) return CROWD_MAX_LEVEL;
    let m = 0;
    for (let i = 0; i < CROWD_LEVELS.length; i++) if (CROWD_LEVELS[i].rate === TICK_RATE) m = i;
    return m;
  }

  private sys(system: number): SystemCrowd {
    let s = this.systems.get(system);
    if (!s) this.systems.set(system, (s = { lv: 0, forced: null, cost: 0, now: 0, changed: -Infinity, from: 0, over: 0, under: 0 }));
    return s;
  }

  levelOf(system: number): number {
    return this.systems.get(system)?.lv ?? 0;
  }

  rowOf(system: number): CrowdLevel {
    return crowdLevel(this.levelOf(system));
  }

  /** The focus radius in effect in a system */
  focusOf(system: number): number {
    return this.rowOf(system).focus;
  }

  /** System ticks between two snapshots there */
  windowOf(system: number): number {
    return this.rowOf(system).window;
  }

  /** Systems whose window is wider than the base one, with it */
  *widened(): IterableIterator<[number, number]> {
    for (const [sys, s] of this.systems) { const w = crowdLevel(s.lv).window; if (w > CROWD_BASE_WINDOW) yield [sys, w]; }
  }

  /** Its smoothed cost (ms per base tick) */
  costOf(system: number): number {
    return this.systems.get(system)?.cost ?? 0;
  }

  /** Charge a system some of this base tick's time (ms) */
  charge(system: number, ms: number): void {
    if (system < 0 || !(ms > 0)) return;
    this.sys(system).now += ms;
  }

  /** Charge time shared by several systems, split by their weights */
  share(ms: number, weights: ReadonlyMap<number, number>): void {
    let total = 0;
    for (const w of weights.values()) total += w;
    if (!(total > 0) || !(ms > 0)) return;
    for (const [s, w] of weights) if (w > 0) this.charge(s, (ms * w) / total);
  }

  /** Charge time spent on every system's ships (the tick), split by how many each has */
  private readonly counts = new Map<number, number>();
  shareByBodies(ms: number, bodies: Iterable<number>, on?: (system: number) => boolean): void {
    const c = this.counts;
    c.clear();
    for (const eid of bodies) { const s = InSystem.systemId[eid]; if (!on || on(s)) c.set(s, (c.get(s) ?? 0) + 1); }
    this.share(ms, c);
  }

  /** Pin a system's level (null: back to automatic) */
  force(system: number, lv: number | null): void {
    const s = this.sys(system);
    s.forced = lv === null ? null : Math.max(0, Math.min(this.maxLevel, lv | 0));
    if (s.forced !== null && s.forced !== s.lv) this.set(system, s, s.forced, true);
  }

  forcedOf(system: number): number | null {
    return this.systems.get(system)?.forced ?? null;
  }

  /** Once a base tick, after the tick and its snapshot rounds: costs folded in, levels decided */
  endTick(): void {
    const t = ++this.base;
    for (const [system, s] of this.systems) {
      s.cost += (s.now - s.cost) * ALPHA;
      s.now = 0;
      if (s.forced !== null) continue;
      if (!this.auto) { if (s.lv) this.set(system, s, 0, false); continue; }
      s.over = s.cost > CROWD_HIGH_MS ? s.over + 1 : 0;
      s.under = s.cost < CROWD_LOW_MS ? s.under + 1 : 0;
      if (s.over >= UP_HOLD && s.lv < this.maxLevel && t - s.changed >= UP_DWELL) this.set(system, s, s.lv + 1, false);
      else if (s.under >= DOWN_HOLD && s.lv > 0 && t - s.changed >= DOWN_DWELL) this.set(system, s, s.lv - 1, false);
      if (s.lv === 0 && s.cost < 0.01 && s.forced === null) this.systems.delete(system);
    }
  }

  private set(system: number, s: SystemCrowd, lv: number, forced: boolean): void {
    const was = crowdLevel(s.lv), next = crowdLevel(lv);
    this.log.push({ tick: this.base, system, from: s.lv, to: lv, cost: +s.cost.toFixed(2), forced });
    s.lv = lv;
    s.changed = this.base;
    const now = this.host.tickOf(system);
    // (A rate change is said ahead and takes effect there: the clocks and every client turn at the same tick)
    s.from = next.rate !== was.rate ? now + CROWD_RATE_LEAD : now;
    if (next.rate !== was.rate) this.host.setRate?.(system, next.rate, s.from);
    for (const c of this.host.clients()) if (this.host.systemOf(c) === system) this.tell(c, system, true);
  }

  /** Tell a client its system's level (`always`: even if it's what it was last told) */
  tell(conn: ClientConnection, system: number, always = false): void {
    if (!crowdFor(conn.caps)) return;
    const s = this.systems.get(system), lv = s?.lv ?? 0;
    if (!always && (this.told.get(conn) ?? 0) === lv) return;
    this.told.set(conn, lv);
    const L = crowdLevel(lv);
    this.host.send(conn, { type: 'crowd', tick: s && s.from > 0 ? s.from : this.host.tickOf(system), lv, f: L.focus, w: L.window, r: L.rate });
  }

  /**
   * A client entering a system (its first snapshot there): told the level there and its clock (its tick, its rate), unless
   * it and the last were both none on the server's clock
   */
  enter(conn: ClientConnection, system: number): void {
    const own = this.host.ownClock?.(system) ?? false;
    if (this.levelOf(system) === 0 && (this.told.get(conn) ?? 0) === 0 && !own && !this.ownTold.has(conn)) return;
    if (own) this.ownTold.add(conn); else this.ownTold.delete(conn);
    const s = this.systems.get(system), lv = s?.lv ?? 0, L = crowdLevel(lv);
    if (!crowdFor(conn.caps)) return;
    this.told.set(conn, lv);
    // (Its tick now and the rate now: a rate said ahead and not yet in effect comes with the change when it is)
    this.host.send(conn, { type: 'crowd', tick: this.host.tickOf(system), lv, f: L.focus, w: L.window, r: this.host.rateOf?.(system) ?? L.rate });
    if (s && s.from > this.host.tickOf(system) && L.rate !== (this.host.rateOf?.(system) ?? L.rate)) this.tell(conn, system, true);
  }
  /** Clients last told of a system with a clock of its own */
  private readonly ownTold = new WeakSet<ClientConnection>();

  /** The dev control (admin /crowd, F9): `to` a level to pin, 'auto' to let go, '' for the status */
  admin(system: number, to: string): { ok: boolean; text: string } {
    if (to === 'auto') { this.force(system, null); return { ok: true, text: `Crowd level automatic here (now ${this.levelOf(system)})` }; }
    if (to !== '') {
      const lv = Number(to);
      if (!Number.isInteger(lv) || lv < 0 || lv > this.maxLevel) return { ok: false, text: `Crowd level 0-${this.maxLevel} or auto` };
      this.force(system, lv);
    }
    const L = this.rowOf(system), f = this.forcedOf(system);
    return { ok: true, text: `Crowd level ${this.levelOf(system)}${f === null ? ' (auto)' : ' (forced)'}: focus ${L.focus / 1000} km, window ${L.window} ticks, ${L.rate} ticks/s · cost ${this.costOf(system).toFixed(2)} ms/tick (up over ${CROWD_HIGH_MS}, down under ${CROWD_LOW_MS})` };
  }

  /** Every system with a level or a cost, for the dev panel and the bench */
  summary(): { system: number; lv: number; cost: number; forced: number | null }[] {
    return [...this.systems].map(([system, s]) => ({ system, lv: s.lv, cost: +s.cost.toFixed(2), forced: s.forced }));
  }
}
