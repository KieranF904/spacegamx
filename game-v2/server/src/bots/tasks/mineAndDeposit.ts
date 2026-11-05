/**
 * mine-and-deposit: the first task, a miner's loop at Sol Central Station.
 *
 *   docked (waits `dockWait` s) -> undock -> fly to the nearest suitable rock -> stand off at `standoff` x the laser's range,
 *   face it and fire the mining laser -> chunks fly to the ship and the tractor pulls them in -> when the hold is full (or
 *   the rock is spent and nothing is left to collect) -> next nearest suitable rock, or back to the station -> dock ->
 *   deposit ('store': the quick-store control, the way ore goes to the refinery and fabricator; 'sell': Sell All at the
 *   market) -> repeat.
 *
 * Suitable rock: hardness at most `maxHardness` (1: the Mk I laser mines it at full yield; a harder rock it cannot work), not a
 * gas pocket, with at least `minUnits` ore units left.
 *
 * Phases for the stats: the first approach and dock is `setup` (not in a trip); each trip then runs docked, travelOut (also
 * the hops between rocks), mining (the laser on), collecting (waiting for the last chunks, laser off), travelBack.
 *
 * Assumptions that make a bot faster or slower than a person: it knows every rock's place and ore at once (no scanning,
 * no hunting for the right rock), aims exactly, flies straight lines with no detours or misclicks, never pauses to look at a
 * screen, and acts one tick after it sees. It always takes the nearest rock, not the richest. A person would be slower
 * on all of these; it is the upper edge of what the loop yields.
 */
import { flyTo, hold, speedOf } from '../core/steering.js';
import { idle, type Controls, type DepositMode, type Phase } from '../core/types.js';
import type { RockView } from '../core/world.js';
import { num, str, type BotTask, type TaskCtx, type TaskDef, type TaskOpts } from './types.js';

type State = 'toStation' | 'docked' | 'out' | 'mining' | 'collecting' | 'back';

export interface MineOpts {
  station: string;
  dockWait: number;
  maxHardness: number;
  minUnits: number;
  /** Fraction of the laser's range to stand off the rock's surface */
  standoff: number;
  /** Seconds to wait for the last chunks after the beam stops */
  collectWait: number;
  /** The hold counts as full with this much room left (the biggest chunk is 10 units) */
  fullFree: number;
  mode: DepositMode;
}

export const mineOpts = (o: TaskOpts): MineOpts => ({
  station: str(o, 'station', 'sol_station_central'),
  dockWait: num(o, 'dockWait', 10),
  maxHardness: num(o, 'maxHardness', 1),
  minUnits: num(o, 'minUnits', 8),
  standoff: num(o, 'standoff', 0.55),
  collectWait: num(o, 'collectWait', 6),
  fullFree: num(o, 'fullFree', 10),
  mode: str(o, 'mode', 'store') === 'sell' ? 'sell' : 'store',
});

export class MineAndDeposit implements BotTask {
  readonly name = 'mine-and-deposit';
  phase: Phase = 'setup';
  state: State = 'toStation';
  private since = 0;
  private rock: RockView | null = null;
  private rockVel = { x: 0, y: 0 };
  private rockAt: { x: number; y: number; tick: number } | null = null;
  private keys: Controls = idle();

  constructor(readonly o: MineOpts) {}

  status(): string { return `${this.state}${this.rock ? ` rock#${this.rock.eid} ${this.rock.type}` : ''}`; }

  private go(state: State, tick: number): void { this.state = state; this.since = tick; }

  /** The nearest rock this bot can work, to where it is */
  private pick(c: TaskCtx): RockView | null {
    const p = c.driver.pose();
    const rocks = c.world.rocksNear(c.system, p.x, p.y, (r) => r.hardness <= this.o.maxHardness && r.left >= this.o.minUnits && !c.world.server.mining.table.types[r.type]?.gas);
    const r = rocks[0] ?? null;
    this.rock = r;
    this.rockAt = null;
    this.rockVel = { x: 0, y: 0 };
    if (r) c.stats.rock();
    return r;
  }

  /** Refresh the target (its place now, its drift); null when it is gone or spent */
  private look(c: TaskCtx): RockView | null {
    if (!this.rock) return null;
    const r = c.world.rock(this.rock.eid);
    if (!r || r.left <= 0) { this.rock = null; return null; }
    if (this.rockAt && c.tick > this.rockAt.tick) {
      const dt = c.tick - this.rockAt.tick;
      this.rockVel = { x: (r.x - this.rockAt.x) / dt, y: (r.y - this.rockAt.y) / dt };
    }
    this.rockAt = { x: r.x, y: r.y, tick: c.tick };
    this.rock = r;
    return r;
  }

  /** The point to stand at: `standoff` of the laser's range off the rock's surface, on the ship's side of it */
  private standAt(c: TaskCtx, r: RockView): { x: number; y: number } {
    const p = c.driver.pose();
    const gap = r.size + c.world.laser().range * this.o.standoff;
    const dx = p.x - r.x, dy = p.y - r.y, d = Math.hypot(dx, dy) || 1;
    return { x: r.x + (dx / d) * gap, y: r.y + (dy / d) * gap };
  }

  step(c: TaskCtx): void {
    const d = c.driver, p = d.pose();
    const st = c.world.station(this.o.station);
    if (!st) { d.set(idle(p.angle)); return; }
    const secs = (c.tick - this.since) / c.tickRate;
    switch (this.state) {
      case 'toStation': {
        this.phase = 'setup';
        this.fly(c, st.x, st.y, st.interact * 0.5, 0, 0);
        if (this.inReach(p, st) && d.dock()) { c.stats.beginTrip(c.tick); this.go('docked', c.tick); }
        break;
      }
      case 'docked': {
        this.phase = 'docked';
        d.set(idle(p.angle));
        if (secs >= this.o.dockWait) { d.undock(); this.pick(c); this.go('out', c.tick); }
        break;
      }
      case 'out': {
        this.phase = 'travelOut';
        const r = this.look(c) ?? this.pick(c);
        if (!r) { d.set(hold(p, this.keys)); break; }
        const at = this.standAt(c, r);
        this.fly(c, at.x, at.y, 40, this.rockVel.x, this.rockVel.y, Math.atan2(r.y - p.y, r.x - p.x));
        const gap = Math.hypot(r.x - p.x, r.y - p.y) - r.size;
        if (gap <= c.world.laser().range * (this.o.standoff + 0.2) && speedOf(p) < 3) this.go('mining', c.tick);
        break;
      }
      case 'mining': {
        this.phase = 'mining';
        const r = this.look(c);
        if (!r) { d.set(hold(p, this.keys, this.rockVel.x, this.rockVel.y)); this.go('collecting', c.tick); break; }
        const at = this.standAt(c, r);
        const out = this.fly(c, at.x, at.y, 40, this.rockVel.x, this.rockVel.y, Math.atan2(r.y - p.y, r.x - p.x));
        const full = d.hold().free < this.o.fullFree;
        out.mine = !full;
        out.aimDist = Math.hypot(r.x - p.x, r.y - p.y);
        d.set(out);
        if (full) this.go('collecting', c.tick);
        break;
      }
      case 'collecting': {
        this.phase = 'collecting';
        // (Laser off; hold still beside the rock while the last chunks come in)
        const out = hold(p, this.keys, this.rockVel.x, this.rockVel.y);
        this.keys = out;
        d.set(out);
        const near = c.world.podsNear(c.system, p.x, p.y, 700).length;
        if (near === 0 || secs >= this.o.collectWait) {
          if (d.hold().free < this.o.fullFree) this.go('back', c.tick);
          else if (this.pick(c)) this.go('out', c.tick);
          else this.go('back', c.tick);
        }
        break;
      }
      case 'back': {
        this.phase = 'travelBack';
        this.fly(c, st.x, st.y, st.interact * 0.5, 0, 0);
        if (this.inReach(p, st) && d.dock()) {
          const dep = d.deposit(this.o.mode);
          c.stats.deposited(dep.items, dep.credits, dep.valueIfSold);
          // (The trip ends as the ship berths: the next one starts with the wait)
          c.stats.endTrip(c.tick);
          c.stats.beginTrip(c.tick);
          this.rock = null;
          this.go('docked', c.tick);
        }
        break;
      }
    }
  }

  private inReach(p: { x: number; y: number }, st: { x: number; y: number; interact: number }): boolean {
    return Math.hypot(st.x - p.x, st.y - p.y) < st.interact * 0.85;
  }

  /** Fly to a point, the nose along `aim` (default: the way it goes) */
  private fly(c: TaskCtx, x: number, y: number, arrive: number, gx: number, gy: number, aim?: number): Controls {
    const out = flyTo(c.driver.pose(), x, y, { arrive, gx, gy }, this.keys);
    if (aim !== undefined) out.aim = aim;
    this.keys = out;
    c.driver.set(out);
    return out;
  }
}

export const mineAndDeposit: TaskDef = {
  name: 'mine-and-deposit',
  description: 'Mine the nearest low-tier rock near the station, collect the chunks, fly back, dock and deposit the ore; repeat.',
  ship: 'prospector',
  station: (o) => mineOpts(o).station,
  create: (o) => new MineAndDeposit(mineOpts(o)),
};
