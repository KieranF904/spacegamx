/**
 * The server-NPC driver: the same ship flown straight through the server's own APIs, with no connection, pilot profile or
 * messages. It is a pilotless ship (ShipBridge.spawnDummy) like the AI ships, flown by a controller (ShipBridge.setController
 * returning the PilotOrders each tick), so it replicates to real players the way every AI ship does: the controls it flies
 * with ride in the replica rows only when they change, and no per-tick traffic is added by the bot. Cheap enough for many.
 *
 * What the server does for a pilot, this does itself, with the same rules: the mining laser runs through ShipBridge.stepWeapons
 * (the same laser, power and beam code a player's ship uses), the tractor pulls ore chunks in with LootPods' own numbers
 * (pull range, strength, pickup distance), the hold holds the ship's cargo capacity in the items' volumes, and the deposit
 * is the market's own sale (Market.sell) or a store into a virtual storage kept by the driver.
 *
 * Differences from the simulated player (see docs/areas/bots.md): the ship is not a Player entity (no profile, skills,
 * XP or quests; mining skill 0, as the simulated player starts), its engines are not power-limited (a pilotless ship flies
 * on a full battery), it does not berth inside the station (it holds still at the dock point), and it is not in god mode
 * (Sol is safe; no hostile hunts a pilotless ship there).
 */
import { Position, Velocity, Input, InSystem } from '@space-game/common';
import type { GameServer } from '../../GameServer.js';
import type { PilotOrders } from '../../ships/ShipBridge.js';
import { idle, type Bag, type Controls, type DepositMode, type DepositResult, type PilotDriver, type Pose } from '../core/types.js';
import { BotInputSource, keysOfInput } from '../core/controlSource.js';
import { miningFill, poseOf, radiusOf, volumeOf } from './shipInfo.js';

/** LootPods' numbers: the tractor's reach beyond the hull, and the pickup distance */
const PULL_RANGE = 380, PICKUP = 24;

export interface NpcDriverOpts {
  name: string;
  ship: string;
  station: string;
  /** Prices for valueIfSold: (ore) => credits each */
  price: (ore: string) => number;
}

export class NpcDriver implements PilotDriver {
  readonly kind = 'npc' as const;
  readonly eid: number;
  private c: Controls = idle();
  private berthed = false;
  /** Its orders as an InputSource (decided): the controller and the flush read the ship's inputs from it */
  readonly source = new BotInputSource(() => (this.berthed ? idle(this.c.aim) : this.c));
  private items: Bag = {};
  /** What it has stored at the station (virtual: the NPC has no profile) */
  readonly stored: Bag = {};
  private readonly system: number;

  constructor(private readonly server: GameServer, readonly name: string, private readonly o: NpcDriverOpts) {
    const ships = server.getShips();
    const bp = ships.library.get(o.ship);
    if (!bp) throw new Error(`no library ship called ${o.ship}`);
    const data = server.gameData.getStation(o.station);
    if (!data) throw new Error(`no station ${o.station}`);
    this.system = server.gameData.getSystemNum(data.system);
    this.eid = ships.spawnDummy(JSON.parse(JSON.stringify(bp)), 0, 0, 0, this.system);
    ships.setController(this.eid, () => this.orders());
  }

  /** Put the ship beside its station (the manager, once the world has its stations) */
  placeAt(x: number, y: number): void {
    Position.x[this.eid] = x;
    Position.y[this.eid] = y;
    Velocity.x[this.eid] = 0;
    Velocity.y[this.eid] = 0;
  }

  private orders(): PilotOrders | null {
    const inp = this.source.inputAt(this.server.getTick());
    return {
      controls: keysOfInput(inp),
      firing: false,
    };
  }

  pose(): Pose { return poseOf(this.eid); }
  radius(): number { return radiusOf(this.server, this.eid); }
  docked(): boolean { return this.berthed; }

  hold(): { items: Bag; capacity: number; free: number } {
    const capacity = this.server.getShips().get(this.eid)?.derived.cargoCapacity ?? 0;
    return { items: { ...this.items }, capacity, free: Math.max(0, capacity - volumeOf(this.server, this.items)) };
  }

  brownout(): boolean { return this.c.mine && !this.berthed && miningFill(this.server, this.eid) < 0.99; }

  set(c: Controls): void { this.c = { ...c }; }

  dock(): boolean {
    if (this.berthed) return true;
    const st = this.server.gameData.getStation(this.o.station);
    if (!st) return false;
    // (The same reach the server gives a player: stationInRange)
    const near = this.server.docking.stationInRange(this.eid);
    if (near < 0) return false;
    this.berthed = true;
    Velocity.x[this.eid] = 0;
    Velocity.y[this.eid] = 0;
    return true;
  }

  undock(): void { this.berthed = false; }

  deposit(mode: DepositMode): DepositResult {
    const items = this.items;
    this.items = {};
    const st = this.server.gameData.getStation(this.o.station)!;
    let credits = 0, value = 0;
    for (const [id, n] of Object.entries(items)) {
      value += this.o.price(id) * n;
      // (Sell: whatever the station buys, by the market's own sale, which also saturates it; the rest is stored)
      if (mode === 'sell' && this.o.price(id) > 0) credits += this.server.market.sell(st, id, n);
      else this.stored[id] = (this.stored[id] ?? 0) + n;
    }
    return { items, credits, valueIfSold: value };
  }

  /** The tractor and pickup (once a tick, before the task thinks), then the laser */
  observe(): void {
    if (this.berthed) return;
    const eid = this.eid, R = this.radius();
    const x = Position.x[eid], y = Position.y[eid];
    for (const pod of this.server.pods.near(InSystem.systemId[eid], x, y, R + PULL_RANGE)) {
      const bag = this.server.pods.get(pod);
      if (!bag) continue;
      const dx = x - Position.x[pod], dy = y - Position.y[pod], dist = Math.hypot(dx, dy) || 1, d = dist - R;
      if (d < PICKUP) {
        if (volumeOf(this.server, bag) > this.hold().free + 1e-9) {
          // (The hold is full: the chunk bounces off, as at a player's)
          Velocity.x[pod] = -dx * 0.02; Velocity.y[pod] = -dy * 0.02;
          continue;
        }
        const taken = this.server.pods.take(pod);
        if (taken) for (const [id, n] of Object.entries(taken)) this.items[id] = (this.items[id] ?? 0) + n;
        continue;
      }
      const pull = 0.6 + 2.4 * (1 - Math.min(1, d / PULL_RANGE));
      Velocity.x[pod] += (dx / dist) * pull + (Velocity.x[eid] - Velocity.x[pod]) * 0.08;
      Velocity.y[pod] += (dy / dist) * pull + (Velocity.y[eid] - Velocity.y[pod]) * 0.08;
    }
  }

  flush(): void {
    const eid = this.eid, c = this.berthed ? idle(this.c.aim) : this.c, inp = this.source.inputAt(this.server.getTick());
    Input.fireRight[eid] = inp.fireAlt ? 1 : 0;
    Input.fireLeft[eid] = inp.fire ? 1 : 0;
    Input.targetAngle[eid] = c.aim;
    Input.cursorDist[eid] = c.aimDist;
    if (this.berthed) { Velocity.x[eid] = 0; Velocity.y[eid] = 0; }
    else this.server.getShips().stepWeapons(eid);
  }

  close(): void {
    const ships = this.server.getShips();
    ships.setController(this.eid, null);
    ships.removeShip(this.eid);
  }
}
