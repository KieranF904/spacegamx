/**
 * One bot: a task, a driver and the stats, stepped once a tick (the BotManager calls tick() from the server's afterTick).
 * The order each tick is the player's: see (driver.observe: pickups, power), think (the task), act (driver.flush: send).
 */
import { TICK_RATE } from '@space-game/common';
import type { GameServer } from '../../GameServer.js';
import { BotStats } from '../stats/BotStats.js';
import type { BotTask } from '../tasks/types.js';
import { BotWorld } from './world.js';
import { tapChunks } from './mineTap.js';
import type { Bag, PilotDriver } from './types.js';

export class Bot {
  readonly stats: BotStats;
  private prev: Bag = {};
  private untap: () => void;
  /** Trips already written out */
  private written = 0;

  constructor(
    readonly id: number,
    readonly server: GameServer,
    readonly world: BotWorld,
    readonly task: BotTask,
    readonly driver: PilotDriver,
    /** The system it works in (a number) */
    readonly system: number,
    wall?: () => number,
  ) {
    this.stats = new BotStats(TICK_RATE, wall);
    this.untap = tapChunks(server, driver.eid, (items) => this.stats.mined(items));
  }

  get label(): string { return `#${this.id} ${this.task.name} (${this.driver.kind}) ${this.driver.name}`; }

  tick(): void {
    const tick = this.server.getTick();
    this.driver.observe();
    // What came into the hold since last tick (not what a deposit took out)
    const h = this.driver.hold().items, got: Bag = {};
    let any = false;
    for (const [id, n] of Object.entries(h)) {
      const k = n - (this.prev[id] ?? 0);
      if (k > 0 && !this.driver.docked()) { got[id] = k; any = true; }
    }
    if (any) this.stats.collected(got);
    this.task.step({ driver: this.driver, world: this.world, stats: this.stats, tick, tickRate: TICK_RATE, system: this.system });
    this.prev = this.driver.hold().items;
    this.stats.tick(tick, this.task.phase, this.driver.brownout(), this.driver.pose());
    this.driver.flush();
  }

  /** Trips completed since this was last asked (for the file and the log) */
  takeNewTrips(): import('../stats/BotStats.js').TripStats[] {
    const out = this.stats.trips.slice(this.written);
    this.written = this.stats.trips.length;
    return out;
  }

  close(): void {
    this.untap();
    this.driver.close();
  }
}
