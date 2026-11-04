/**
 * Each system's own clock (crowd fallbacks, stage 3: time dilation; common network/crowd.ts; docs/design/awareness-model.md
 * section 7.11).
 *
 * The server's loop runs base ticks (TICK_RATE a second). Every system steps once a base tick, and its tick IS the
 * server's tick, until it is dilated: from then on it has a clock of its own, stepping `rate` of every TICK_RATE base
 * ticks (crowdClockStep: integer, the same steps on every run), counting its own ticks. The step is the same (same dt):
 * the simulation in it is unchanged and deterministic, it just runs slower in real time, and its tick falls behind the
 * server's. Undilated, it goes on with its own clock at full rate (still behind) until nobody is in it, when it rejoins
 * the server's (its tick jumps forward to it: nothing in it is watched).
 *
 * The tick is walked in passes (SimPass): the main pass is every system on the server's clock, at the server's tick;
 * then one pass for each system with a clock of its own that is due a step, at its own tick (GameServer.currentTick is
 * that tick for the pass: everything that reads the tick reads the system's). Tick entries that touch a system's world
 * run in every pass and skip what isn't the pass's (SimPass.on); the rest (the economy, clients' bookkeeping) run in
 * the main pass only. A client's messages are handled at its system's tick (GameServer.handleMessage: clocks.as).
 */
import { TICK_RATE, crowdClockStep, type ShipState } from '@space-game/common';

export interface SystemClock {
  /** Its tick (the last stepped) */
  tick: number;
  rate: number;
  acc: number;
  /** A rate from a tick on (said ahead: CrowdControl) */
  next: { at: number; rate: number } | null;
}

/**
 * Which systems the pass now running is for: every system on the server's clock (main), or one with its own. Read by
 * the tick entries that touch a system's world (one module-level object, as bitECS's world is: one server at a time)
 */
export const SimPass = {
  /** The main pass (every system without a clock of its own) */
  main: true,
  /** The system an own-clock pass is for */
  system: -1,
  /** Systems with a clock of their own (skipped by the main pass) */
  own: new Set<number>(),
  /** Is a system's world stepped in this pass? */
  on(system: number): boolean {
    return this.main ? (this.own.size === 0 || !this.own.has(system)) : system === this.system;
  },
  /** Every system is in this pass (the common case: no clock of its own anywhere) */
  get all(): boolean {
    return this.main && this.own.size === 0;
  },
  reset(): void {
    this.main = true;
    this.system = -1;
    this.own.clear();
  },
};

/**
 * A ship moving between systems whose ticks differ (one has a clock of its own): what it keeps as ticks is moved by
 * `delta` (the new system's tick minus the old's), so a cooldown, a shield's wait or a click waits as long as it did
 */
export function rebaseShipTicks(ship: ShipState, delta: number): void {
  ship.spawnTick += delta;
  ship.shieldHitTick += delta;
  ship.clickAt += delta;
  if (ship.mineUntil !== undefined) ship.mineUntil += delta;
  if (ship.despawnTick >= 0) ship.despawnTick += delta;
}

export class SystemClocks {
  private readonly clocks = new Map<number, SystemClock>();
  /** Base ticks walked, and own-clock steps (the bench, the tests) */
  readonly stats = { base: 0, steps: 0, rejoined: 0 };

  constructor(private readonly host: {
    /** The server's tick */
    baseTick(): number;
    /** Is anyone in this system (a client's ship)? */
    occupied(system: number): boolean;
  }) {
    SimPass.reset();
  }

  /** A system's tick now */
  tickOf(system: number): number {
    return this.clocks.get(system)?.tick ?? this.host.baseTick();
  }

  rateOf(system: number): number {
    return this.clocks.get(system)?.rate ?? TICK_RATE;
  }

  /** Does this system keep a clock of its own? */
  owns(system: number): boolean {
    return this.clocks.has(system);
  }

  /** Systems with a clock of their own */
  systems(): IterableIterator<number> {
    return this.clocks.keys();
  }

  /**
   * Set a system's rate from its tick `at` on. A system on the server's clock takes its own at once (at its tick now:
   * it goes on from there); the rate itself changes at `at`
   */
  setRate(system: number, rate: number, at: number): void {
    let c = this.clocks.get(system);
    if (!c) {
      if (rate >= TICK_RATE) return;
      c = { tick: this.host.baseTick(), rate: TICK_RATE, acc: 0, next: null };
      this.clocks.set(system, c);
      SimPass.own.add(system);
    }
    c.next = { at, rate };
  }

  /**
   * Once a base tick, after the main pass: the systems with a clock of their own that step now, in system order. The
   * caller runs each one's pass (step), then the clock moves on
   */
  due(): number[] {
    this.stats.base++;
    const out: number[] = [];
    for (const [system, c] of [...this.clocks].sort((a, b) => a[0] - b[0])) {
      // (Back to full rate and nobody there: it rejoins the server's clock)
      if (c.rate >= TICK_RATE && !c.next && !this.host.occupied(system)) {
        this.clocks.delete(system);
        SimPass.own.delete(system);
        this.stats.rejoined++;
        continue;
      }
      const [acc, n] = crowdClockStep(c.acc, c.rate);
      c.acc = acc;
      if (n) out.push(system);
    }
    return out;
  }

  /** A system's pass begins: its tick moves on one (and a rate said for that tick takes effect from the next) */
  step(system: number): number {
    const c = this.clocks.get(system)!;
    c.tick++;
    this.stats.steps++;
    if (c.next && c.tick >= c.next.at) { c.rate = c.next.rate; c.next = null; }
    return c.tick;
  }
}
