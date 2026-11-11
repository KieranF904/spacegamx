/**
 * What a client message handler may use of the server. GameServer implements it itself (`implements ServerCtx`),
 * so no adapter object is built and handlers call straight through.
 *
 * Type-only imports and nothing else: this file has no runtime, so it can never be part of an import cycle, and
 * nothing under net/ needs to import GameServer.ts. Keep it narrow: a handler that needs more than this should call
 * a module method, not widen the context (the snapshot path gets its own, wider host).
 */
import type { IWorld } from 'bitecs';
import type { ClientSocket, ServerMessage, HitReport, OwnCheck, BodyCheck } from '@space-game/common';
import type { ClientConnection } from './ClientConnection.js';
import type { MessageLimiter } from './MessageLimits.js';
import type { GameData } from '../data/GameData.js';
import type { UserStore } from '../auth/types.js';
import type { ShipBridge } from '../ships/ShipBridge.js';
import type { Pilots } from '../game/Pilots.js';
import type { LootPods } from '../game/LootPods.js';
import type { Ammo } from '../game/Ammo.js';
import type { Outpost } from '../game/Outpost.js';
import type { StationServices } from '../game/StationServices.js';
import type { Quests } from '../game/Quests.js';
import type { People } from '../game/People.js';
import type { Codex } from '../game/Codex.js';
import type { Arenas } from '../game/Arenas.js';
import type { ArenaGates } from '../game/arenas/ArenaGates.js';
import type { AdminTools } from '../game/AdminTools.js';
import type { ContributorNotes } from '../game/ContributorNotes.js';
import type { Sieges } from '../game/Sieges.js';
import type { Hangar } from '../game/Hangar.js';
import type { Party } from '../game/Party.js';
import type { Social } from '../game/social/Social.js';
import type { Trade } from '../game/Trade.js';
import type { Market } from '../game/Market.js';
import type { Achievements } from '../game/Achievements.js';
import type { Docking } from '../game/Docking.js';
import type { Enemies } from '../game/Enemies.js';
import type { Surfaces } from '../game/Surfaces.js';
import type { HomeStations } from '../game/HomeStations.js';
import type { Tutorial } from '../game/tutorial/Tutorial.js';
import type { GunRange } from '../game/gunRange/GunRange.js';
import type { SnapshotBuilder } from './SnapshotBuilder.js';
import type { ServerFeatures } from '../ships/features/host.js';

export interface ServerCtx {
  // ---- state (read only to handlers) ----
  readonly gameData: GameData;
  readonly userDB: UserStore;
  readonly scene: 'sectors' | 'empty';
  readonly currentTick: number;
  readonly clients: ReadonlyMap<ClientSocket, ClientConnection>;
  /** Per-connection message rate limits (dispatch checks them before any handler) */
  readonly limiter: MessageLimiter;
  /** Every connection is an admin (proto) / guests are admins (dev server) */
  readonly everyoneAdmin: boolean;
  readonly guestAdmin: boolean;
  /** Why no one may sign in right now (a server update is about to restart it), or null (server/src/update) */
  readonly joinGate: (() => string | null) | null;
  /** Confirmed hits: a client's HP copy put right (hpResync); a client finding its own hits reports them (input hitReport) */
  readonly hits: { resync(conn: ClientConnection, ids: readonly unknown[]): void; report(conn: ClientConnection, rep: HitReport): void };
  /** A client stepping its own ship checks it (input ownCheck, CAPS.OWN_SIM: net/own/OwnChecks.ts) */
  readonly ownChecks: { check(conn: ClientConnection, c: OwnCheck): void };
  /** Bosses' bodies its client runs: its checks of them (CAPS.BODIES, net/decisions/BodyNet.ts) */
  readonly bodies: { check(conn: ClientConnection, c: BodyCheck): void };
  /** The ECS world (handlers only read components from it) */
  readonly world: IWorld;
  /** The hangar opens anywhere (proto) */
  readonly shipEditAnywhere: boolean;
  /** Wall clock (ms); tests pass a fake one */
  readonly clock: () => number;
  /** The snapshot path, for what a client confirms of it (debris it worked out) and tells it (cells it kept: CAPS.FOCUS) */
  readonly snapshots: Pick<SnapshotBuilder, 'ackDebris'>;

  // ---- verbs ----
  send(ws: ClientSocket, msg: ServerMessage): void;
  broadcastToSystem(systemId: number, msg: ServerMessage): void;
  /** Log and count a caught error (see GameServer.guard) */
  fault(where: string, e: unknown): void;
  /** Run fn; a throw is a logged fault, not a crash */
  guard(where: string, fn: () => void): void;

  // ---- helpers ----
  /** Is this entity a live player ship */
  flying(eid: number): boolean;
  isDocked(eid: number): boolean;
  /** The connection flying this entity, if any */
  liveConn(eid: number): ClientConnection | undefined;
  /** Joined: its player entity, pilot and welcome (gameServer/session.ts enter; once) */
  enter(conn: ClientConnection): void;
  loginPilot(conn: ClientConnection, userId: number): Promise<void>;
  /** A guest joined with a guest key: their kept pilot back, any other connection on it ended (gameServer/session.ts) */
  resumeGuest(conn: ClientConnection): Promise<void>;
  /** Hangar edits cost nothing for this connection (proto, or an admin with free build on a dev server) */
  freeBuild(conn: ClientConnection): boolean;

  // ---- modules ----
  readonly ships: ShipBridge;
  readonly pilots: Pilots;
  readonly ammo: Ammo;
  readonly outpost?: Outpost;
  readonly docking: Docking;
  /** The part features' events a handler is where they happen (the jump key: flight.ts) */
  readonly features?: Pick<ServerFeatures, 'onJumpKey'>;
  readonly services: StationServices;
  readonly quests: Quests;
  readonly people: People;
  readonly codex: Codex;
  readonly arenas: Arenas;
  /** Boss arenas' barriers (interact passes them) */
  readonly arenaGates: ArenaGates;
  readonly admin: AdminTools;
  readonly contrib: ContributorNotes<ClientConnection>;
  readonly sieges: Sieges;
  readonly hangar: Hangar;
  readonly party: Party;
  readonly trade: Trade;
  readonly market: Market;
  readonly achievements: Achievements;
  readonly social: Social;

  // ---- flight messages (net/handlers/flight.ts) ----
  /** Inputs received since the last tick boundary (GameServer.drainInputQueue applies them right before the tick) */
  readonly inputQueue: Array<{ conn: ClientConnection; msg: any }>;
  readonly enemies: Enemies;
  readonly surfaces: Surfaces;
  readonly homes: HomeStations;
  /** The training yard (game/tutorial): none when the server runs without a tutorial */
  readonly tutorial?: Tutorial;
  /** The gun range (game/gunRange): going in, the weapon picker, X at its door, and the messages its visitors may send */
  readonly gunRange: GunRange;
  /** Loot pods: the pickup panel's take (docs/design/loot-pickup-2026-11.md) */
  readonly pods: Pick<LootPods, 'takeFor'>;
  /** A fresh player ship entity (respawn) */
  createPlayer(): number;
  /** Put a pilot's ship in a system at a point (respawn's rally) */
  placePlayer(conn: ClientConnection, systemNum: number, x: number, y: number): void;
  /** Move a pilot to another system (jump gates) */
  travelTo(conn: ClientConnection, systemNum: number, x: number, y: number, keepMomentum: boolean): void;
}
