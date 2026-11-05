/**
 * The client-input driver: a simulated player. It joins the real GameServer over a connection (a socket that only counts
 * the bytes it is sent: no rendering, nothing decoded), gets a real pilot, ship and replication, and then does only what a
 * player's client does: send `input` messages (the move keys, aim, fire), `dock`, `undock`, `itemStore` and `marketSellAll`.
 * No server shortcuts in the flying or the station work; its numbers are what a player could do.
 *
 * Setup uses the dev tools a developer has (not a player's moves, not timed): `devShip` to fly the library ship, `/god on` and
 * `/goto <station>`. All of them are admin or dev-only and refused in production (GameServer's own checks).
 */
import type { ClientLink, ClientMessage, ClientSocket } from '@space-game/common';
import type { GameServer } from '../../GameServer.js';
import type { ClientConnection } from '../../net/ClientConnection.js';
import { idle, type Bag, type Controls, type DepositMode, type DepositResult, type PilotDriver, type Pose } from '../core/types.js';
import { BotInputSource, keysOfInput } from '../core/controlSource.js';
import { miningFill, poseOf, radiusOf } from './shipInfo.js';

export interface ClientDriverOpts {
  name: string;
  /** A library ship id (data/ships/blueprints) */
  ship: string;
  /** A station id to start at (its players are sent there by `/goto`) */
  station: string;
  god?: boolean;
  /** Prices for valueIfSold: (ore) => credits each */
  price: (ore: string) => number;
}

export class ClientDriver implements PilotDriver {
  readonly kind = 'client' as const;
  readonly eid: number;
  /** What the server sent it: messages and bytes (the replication a client would have to read) */
  bytesIn = 0;
  messagesIn = 0;
  /** What it sent */
  inputsSent = 0;
  private readonly link: ClientLink;
  private readonly conn: ClientConnection;
  private seq = 1;
  private c: Controls = idle();
  /** Its orders as an InputSource (decided): the input message is built from it */
  readonly source = new BotInputSource(() => this.c);
  private sent: Controls | null = null;
  private sentTick = -999;

  constructor(private readonly server: GameServer, readonly name: string, private readonly o: ClientDriverOpts) {
    const socket: ClientSocket = { isOpen: () => true, send: (data) => { this.messagesIn++; this.bytesIn += (data as Uint8Array).length; } };
    this.link = server.connect(socket);
    this.link.receive({ type: 'join', username: name } as ClientMessage);
    this.eid = server.getPlayerId(socket);
    this.conn = server.pilots.connOf(this.eid) as ClientConnection;
    // Dev setup: the library ship, god mode, and a start at the station
    this.link.receive({ type: 'devShip', ship: o.ship } as ClientMessage);
    if (o.god !== false) this.link.receive({ type: 'chat', text: '/god on' } as ClientMessage);
    this.link.receive({ type: 'chat', text: `/goto ${server.gameData.getStation(o.station)?.name ?? o.station}` } as ClientMessage);
  }

  get connection(): ClientConnection { return this.conn; }
  get god(): boolean { return this.server.admin.isGod(this.eid); }

  observe(): void { /* the server tells it nothing it needs: the world is read directly (see BotWorld) */ }

  pose(): Pose { return poseOf(this.eid); }
  radius(): number { return radiusOf(this.server, this.eid); }
  docked(): boolean { return !!this.conn.docked; }

  hold(): { items: Bag; capacity: number; free: number } {
    const p = this.server.pilots.get(this.conn);
    const items: Bag = {};
    for (const s of p?.cargo ?? []) items[s.id] = (items[s.id] ?? 0) + s.n;
    return { items, capacity: this.server.pilots.cargoCapacity(this.conn), free: this.server.pilots.cargoFree(this.conn) };
  }

  brownout(): boolean { return this.c.mine && miningFill(this.server, this.eid) < 0.99; }

  set(c: Controls): void { this.c = { ...c }; }

  dock(): boolean {
    if (this.conn.docked) return true;
    this.link.receive({ type: 'dock' } as ClientMessage);
    return !!this.conn.docked;
  }

  undock(): void {
    this.link.receive({ type: 'undock' } as ClientMessage);
    this.sent = null;
  }

  deposit(mode: DepositMode): DepositResult {
    const before = this.hold().items;
    const credits0 = this.server.pilots.get(this.conn)?.credits ?? 0;
    if (mode === 'sell') {
      // Sell All takes the raw minerals; gems and volatiles are sold a stack at a time, as a player does
      this.link.receive({ type: 'marketSellAll' } as ClientMessage);
      for (const [id, n] of Object.entries(this.hold().items)) if (this.o.price(id) > 0) this.link.receive({ type: 'marketSell', id, n } as ClientMessage);
    }
    // (The quick-store control's "ores" sweep: all of it in store mode, whatever nobody buys in sell mode)
    this.link.receive({ type: 'itemStore', what: 'ores' } as ClientMessage);
    const after = this.hold().items;
    const items: Bag = {};
    for (const [id, n] of Object.entries(before)) { const k = n - (after[id] ?? 0); if (k > 0) items[id] = k; }
    return { items, credits: (this.server.pilots.get(this.conn)?.credits ?? 0) - credits0, valueIfSold: Object.entries(items).reduce((t, [id, n]) => t + this.o.price(id) * n, 0) };
  }

  /** Send the controls when they changed (or every half second: a client's heartbeat) */
  flush(): void {
    if (this.conn.docked) return;
    const c = this.c, s = this.sent, tick = this.server.getTick();
    const same = s && s.forward === c.forward && s.backward === c.backward && s.left === c.left && s.right === c.right && s.boost === c.boost
      && s.mine === c.mine && Math.abs(s.aim - c.aim) < 0.01 && Math.abs(s.aimDist - c.aimDist) < 8;
    if (same && tick - this.sentTick < 30) return;
    this.sent = { ...c };
    this.sentTick = tick;
    this.inputsSent++;
    const inp = this.source.inputAt(tick + 1), k = keysOfInput(inp);
    this.link.receive({
      type: 'input', seq: this.seq++, tick: 0, targetTick: tick + 1,
      forward: k.forward, backward: k.backward, left: k.left, right: k.right, boost: k.boost,
      fireLeft: inp.fire, fireRight: inp.fireAlt, targetAngle: c.aim, cursorDist: Math.round(c.aimDist),
    } as ClientMessage);
  }

  close(): void {
    this.link.receive({ type: 'chat', text: '/god off' } as ClientMessage);
    this.link.close();
  }
}
