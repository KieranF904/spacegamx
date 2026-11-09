/**
 * Docking: berthing at a station (the hangar opening), the ships riding inside their station, and who is within reach
 * of one. Moved verbatim from GameServer (the bodies are unchanged; the host's pieces are held as plain fields).
 *
 * - `stationInRange(eid)`: the station a player is close enough to dock at, or -1 (enemies ask it of every pilot they
 *   might go for, so it stays a plain loop with no allocation).
 * - `dockedShips`: ships inside a station: invulnerable, untouchable, unseen by hostiles. A plain Set, rebuilt each
 *   tick by `dockingSystem`; GameServer keeps a field alias to the same Set for its hot-path reads.
 * - `handleDock` / `undock`: the dock and undock messages (net/handlers/shipEdit.ts).
 */
import { hasComponent, entityExists, defineQuery, type IWorld } from 'bitecs';
import {
  Position, Velocity, InSystem, Radius, Station, Player, Dead,
  fartherThan, stationReachMax, stationInteractRadius,
  type ClientSocket, type ServerMessage, dhypot,
} from '@space-game/common';
import type { GameData } from '../data/GameData.js';
import type { ClientConnection } from '../net/ClientConnection.js';
import type { Pilots } from './Pilots.js';
import type { Ammo } from './Ammo.js';
import type { Quests } from './Quests.js';
import { SimPass } from '../sim/SystemClocks.js';
import { activity } from '../activity/index.js';

/** Every station (GameServer reads the same query) */
export const stationQuery = defineQuery([Station, Position]);

export interface DockingHost {
  readonly world: IWorld;
  readonly gameData: GameData;
  readonly clients: ReadonlyMap<ClientSocket, ClientConnection>;
  /** Hangar opens anywhere (proto) */
  readonly shipEditAnywhere: boolean;
  readonly pilots: Pilots;
  readonly ammo: Ammo;
  readonly quests: Quests;
  send(ws: ClientSocket, msg: ServerMessage): void;
  /** Wall clock (ms) */
  clock(): number;
  /** Let go of every key (GameServer.releaseControls) */
  releaseControls(eid: number): void;
  /** A pilot berthed (the part features' onBerthed) */
  berthed?(eid: number): void;
  /** A pilot berthed at a station, by data id (the training yard's lesson) */
  docked?(conn: ClientConnection, station: string): void;
}

export class Docking {
  private readonly world: IWorld;
  private readonly gameData: GameData;
  private readonly clients: ReadonlyMap<ClientSocket, ClientConnection>;
  private readonly shipEditAnywhere: boolean;
  private readonly pilots: Pilots;
  private readonly ammo: Ammo;
  private readonly quests: Quests;
  private readonly send: (ws: ClientSocket, msg: ServerMessage) => void;
  private readonly clock: () => number;
  private readonly releaseControls: (eid: number) => void;
  private readonly berthed: (eid: number) => void;
  private readonly docked: (conn: ClientConnection, station: string) => void;

  /** Docked ships (inside a station): invulnerable, untouchable, unseen by hostiles */
  readonly dockedShips = new Set<number>();

  constructor(host: DockingHost) {
    this.world = host.world;
    this.gameData = host.gameData;
    this.clients = host.clients;
    this.shipEditAnywhere = host.shipEditAnywhere;
    this.pilots = host.pilots;
    this.ammo = host.ammo;
    this.quests = host.quests;
    this.send = host.send;
    this.clock = host.clock;
    this.releaseControls = host.releaseControls;
    this.berthed = host.berthed ?? (() => {});
    this.docked = host.docked ?? (() => {});
  }

  /** The station this player is close enough to dock at, or -1. */
  stationInRange(eid: number): number {
    for (const st of stationQuery(this.world)) {
      if (InSystem.systemId[st] !== InSystem.systemId[eid]) continue;
      const dx = Position.x[st] - Position.x[eid], dy = Position.y[st] - Position.y[eid];
      // (Further than any station of its size reaches: no need to look up its design. Enemies ask this of every pilot they might go for)
      if (fartherThan(dx, dy, stationReachMax(Radius.value[st]))) continue;
      if (dhypot(dx, dy) < stationInteractRadius(Radius.value[st], this.gameData.getStationByNum(Station.stationId[st])?.design)) return st;
    }
    return -1;
  }

  /** Is this player close enough to a station to use its shipyard? */
  isDocked(eid: number): boolean {
    return this.stationInRange(eid) >= 0;
  }

  /** Berth at the nearest station (hangar opening): the ship then rides along with it. */
  handleDock(conn: ClientConnection): void {
    const eid = conn.playerId;
    const reply = (ok: boolean, station?: string, error?: string) => this.send(conn.ws, { type: 'dockResult', ok, station, error });
    if (!hasComponent(this.world, Player, eid) || hasComponent(this.world, Dead, eid)) return reply(false, undefined, 'no ship');
    if (this.shipEditAnywhere) return reply(true, 'Hangar');
    const st = this.stationInRange(eid);
    if (st < 0) return reply(false, undefined, 'too far from a station');
    // Inside: at the station's centre, out of reach; back out where it came in
    conn.docked = { station: st, ox: 0, oy: 0, exit: { x: Position.x[eid] - Position.x[st], y: Position.y[eid] - Position.y[st] } };
    this.dockedShips.add(eid);
    this.releaseControls(eid);
    this.berthed(eid);
    // (Berthed, the controls stay neutral: inputs still waiting for their tick are dropped, as are any that come before
    // the client knows: net/handlers/flight.ts handleInput)
    conn.scheduledInputs.length = 0;
    const sd = this.gameData.getStationByNum(Station.stationId[st]);
    if (sd?.dockingFee) this.pilots.payDockFee(conn, sd.id, sd.dockingFee);
    // (Quiet when there was nothing to load: every dock shouldn't say so)
    this.ammo.restock(conn, { report: true, quiet: true });
    if (sd) this.pilots.bumpStat(conn, `dock:${sd.id}`);
    if (sd) activity.dock(conn, sd.name);
    if (sd) this.docked(conn, sd.id);
    if (sd) this.quests.rumourAt(conn, sd.id, sd.system, Math.floor(this.clock() / 86_400_000));
    reply(true, sd?.name ?? 'Station');
  }

  /** Leave the berth: back out where the ship came in, at rest */
  undock(conn: ClientConnection): void {
    const d = conn.docked;
    // Launching: the loadout tops up one last time (still in the berth), and says what's short
    if (d) this.ammo.restock(conn, { report: true, quiet: true });
    conn.docked = null;
    this.dockedShips.delete(conn.playerId);
    const eid = conn.playerId;
    if (!d?.exit || !entityExists(this.world, d.station) || !hasComponent(this.world, Player, eid)) return;
    Position.x[eid] = Position.x[d.station] + d.exit.x;
    Position.y[eid] = Position.y[d.station] + d.exit.y;
    Velocity.x[eid] = 0;
    Velocity.y[eid] = 0;
  }

  /** Berthed ships ride along inside their station, holding still. */
  dockingSystem(): void {
    // (Its system's pass only, crowd dilation: sim/SystemClocks.ts; the rest keep theirs)
    if (SimPass.all) this.dockedShips.clear();
    else for (const eid of [...this.dockedShips]) if (SimPass.on(InSystem.systemId[eid])) this.dockedShips.delete(eid);
    for (const conn of this.clients.values()) {
      const d = conn.docked;
      if (!d) continue;
      const eid = conn.playerId;
      if (!SimPass.all && hasComponent(this.world, Player, eid) && !SimPass.on(InSystem.systemId[eid])) continue;
      if (!hasComponent(this.world, Player, eid) || hasComponent(this.world, Dead, eid) || !entityExists(this.world, d.station)) {
        conn.docked = null;
        continue;
      }
      this.dockedShips.add(eid);
      const x = Position.x[d.station] + d.ox, y = Position.y[d.station] + d.oy;
      Velocity.x[eid] = x - Position.x[eid];
      Velocity.y[eid] = y - Position.y[eid];
      Position.x[eid] = x;
      Position.y[eid] = y;
    }
  }
}
