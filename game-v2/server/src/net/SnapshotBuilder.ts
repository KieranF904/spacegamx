/**
 * @contract server.snapshot
 * owns:       the snapshot round: every SNAPSHOT_RATE, one snapshot per client, assembled in a fixed order from the
 *             snapshot/ modules (rows, own row, debris hold, replication, fire, structure, removals), then map dots and pops
 * needs:      SnapshotHost (GameServer builds one, once), snapshot/{rows, ownRow, shipStructure, debrisHold, frameParts,
 *             mapDots, systemEntry, rounds}, Replication, FocusCells, AwayNet; npm: bitecs
 * invariants: message order per client per round is fixed (ownSync, gunSyncs, pulls, snapshot) — server/src/golden/frameHash.test.ts
 *             bytes sent unchanged — server/src/golden/frameHash.test.ts
 *             tick order unchanged — tickOrder.json
 * extend:     a new row kind is one entry in snapshot/rows/index.ts ROW_KINDS; a new per-client message goes in clientSnapshot
 *
 * The snapshot path: what each client is sent of the world as it changes. Moved from GameServer (the host's pieces
 * are plain fields copied once at construction, so the per-tick loops read fields, not an interface).
 *
 * - `sendSnapshots`: every SNAPSHOT_RATE, a round in phases: beginRound (the per-round caches, replication's and the
 *   guns' rounds, the focus grid), clientSnapshot for each client (its motion: motionFor; its own ship: ownStateOf;
 *   fire events; its rows: rowsFor, of the rows built once per system (snapshot/rows); ship structure
 *   (snapshot/shipStructure.ts); stations and portals once (their list once a round per system); removals; the frame),
 *   then endRound (removals let go, map dots, pops).
 * - `sendMapDots`: the system map's ships past the ship view, to clients with the map open (snapshot/mapDots.ts).
 * - its view of the ships: its focus cells (net/cells/FocusCells.ts), and those away (net/cells/AwayNet.ts).
 * - `enterSystem`: a client's first snapshot in a system (briefings, the asteroid seed, a clean slate: snapshot/systemEntry.ts).
 * - `sendPlayerState` / `sendSystemInfo`: HUD numbers, and the system visuals when the system changes.
 *
 * GameServer builds it once in its constructor (after every module it reads) and keeps one-line delegates for
 * the names its own code calls. Nothing here imports GameServer.
 */
import { hasComponent, type IWorld } from 'bitecs';
import {
  Position, InSystem, Player, DEBRIS_STATUS, fartherThan, derivedRow, type BlockStore,
  CROWD_BASE_WINDOW, FOCUS_RANGE, type EntityState, type ClientSocket, type ServerMessage, type AsteroidSpawnData,
  headWord, HEAD_HASH_ROW, packOwnSync, packOwnHazards, jumpPhase, jumpTuning, SEARCH_WINDOW_MAX, type LandmarkSet,
} from '@space-game/common';
import type { GameData } from '../data/GameData.js';
import { SyncedShips, type ClientConnection } from './ClientConnection.js';
import type { ShipBridge } from '../ships/ShipBridge.js';
import { toldShips } from './hits/toldShips.js';
import type { SimLod } from '../ships/SimLod.js';
import type { Enemies } from '../game/Enemies.js';
import type { Party } from '../game/Party.js';
import type { Events } from '../game/Events.js';
import type { Surfaces } from '../game/Surfaces.js';
import type { Replication } from './Replication.js';
import type { Mobs } from '../game/Mobs.js';
import type { LootPods } from '../game/LootPods.js';
import type { ServerFeatures } from '../ships/features/host.js';
import type { SnapshotWindow } from '../ships/features/types.js';
import { SNAP_PROJECTILE_RANGE, SNAP_POD_RANGE, MAP_DOTS_TICKS, HEAD_HASH_TICKS, FX_RANGE as FX_NEAR } from './snapshot/constants.js';
import type { HitLedger } from './hits/HitLedger.js';
import { OwnShotLog } from './snapshot/ownShots.js';
import { FocusCells } from './cells/FocusCells.js';
import { AwayNet } from './cells/AwayNet.js';
import type { CrowdControl } from './crowd/CrowdControl.js';
import type { BodyNet } from './decisions/BodyNet.js';
import type { GuideNet } from './guides/GuideNet.js';
import type { OwnChecks } from './own/OwnChecks.js';
import type { GunNet, GunClient } from './guns/GunNet.js';
import { systemRows, RowKeys, type RowHost, type SnapRow } from './snapshot/rows/index.js';
import { ShipStructure } from './snapshot/shipStructure.js';
import { OwnRows, ownHazardKey } from './snapshot/ownRow.js';
import { DebrisHold } from './snapshot/debrisHold.js';
import { collectFire, staticOf, staticRows, removalsFor, type FireHost, type RemovalHost, type StaticList } from './snapshot/frameParts.js';
import { sendMapDots, sendPops, type MapHost } from './snapshot/mapDots.js';
import { enterSystem, sendPlayerState, type EntryHost } from './snapshot/systemEntry.js';
import { RoundClock, type RoundSkip } from './snapshot/rounds.js';

export type { RoundSkip } from './snapshot/rounds.js';
export { designHash } from './snapshot/shipStructure.js';
export { playerQuery, projectileQuery, droppedItemQuery } from './snapshot/rows/index.js';

/** A debris body's status row as its key (rowKey): what a client makes itself for debris it works out (common ships/debris.ts) */
const DEBRIS_ROW_KEY = DEBRIS_STATUS.join(',');

/** Its own row's state this round (OwnRows.selfRowState) */
type OwnRowState = ReturnType<OwnRows['selfRowState']>;

/** What the snapshot path needs of the server (GameServer builds one, once) */
export interface SnapshotHost {
  readonly world: IWorld;
  readonly gameData: GameData;
  readonly clients: ReadonlyMap<ClientSocket, ClientConnection>;
  readonly scene: 'sectors' | 'empty';
  readonly ships: ShipBridge;
  readonly enemies: Enemies;
  readonly lod: SimLod;
  readonly party: Party;
  readonly events: Events;
  readonly surfaces: Surfaces;
  /** Asteroids by system (the seed's), when each system's seed was laid, each one's belt index, and the ones grown back */
  readonly asteroidIdsBySystem: ReadonlyMap<number, number[]>;
  readonly asteroidSeedTickBySystem: ReadonlyMap<number, number>;
  readonly asteroidIndexById: ReadonlyMap<number, number>;
  readonly respawnedAsteroids: ReadonlySet<number>;
  send(ws: ClientSocket, msg: ServerMessage): void;
  /** Names (and kinds) of pilotless ships that have one: 1 = derelict, 2 = traffic, 3 = hostile */
  namedBody(eid: number): { name: string; kind: number } | undefined;
  flying(eid: number): boolean;
  asteroidSpawnData(eid: number): AsteroidSpawnData;
  /** A pilot's part-worked mining chunks on a system's rocks, packed (Mining.partWorked): told once, on entering it */
  mineState?(miner: number, systemNum: number): number[];
  /** A system's moving landmarks (GameServer.replicaEnv's): systemInfo carries them */
  landmarks?(systemNum: number): LandmarkSet | undefined;
  readonly replication: Replication;
  readonly mobs: Mobs;
  readonly pods: LootPods;
  readonly features: ServerFeatures;
  /** People's craft (out of every fight) and wards (on the pilots' side), by name: a ship row's side */
  readonly personCraft: ReadonlyMap<number, string>;
  readonly wards: ReadonlyMap<number, string>;
  /** Disconnected mid-fight, still in space (their names still go) */
  readonly lingering: ReadonlyMap<number, { conn: ClientConnection; until: number }>;
  /** Entities removed this tick and the system each was in (cleared once every client has been told) */
  readonly pendingRemovedEntities: Map<number, number>;
  /** Each pilot's entities as last sent (playerId -> entity id -> key) */
  readonly lastEntityStates: Map<number, Map<number, string>>;
  /** Confirmed hits (net/hits/HitLedger.ts): a client's records, after its snapshot and before its HP */
  readonly hits?: HitLedger | null;
  /** Pilots' checks of their own ships (CAPS.OWN_SIM): what each snapshot should come to (net/own/OwnChecks.ts) */
  readonly ownChecks?: OwnChecks | null;
  /** Bosses' decisions for clients that run their bodies (CAPS.BODIES: net/decisions/BodyNet.ts) */
  readonly bodies?: BodyNet | null;
  /** Homing shells on clients' tick layers (CAPS.WAYPOINTS: net/guides/GuideNet.ts) */
  readonly guides?: GuideNet | null;
  /** Encode-once blocks (CAPS.BLOCKS, Outbox.blocks): told what was removed, so wire ids go back */
  readonly blocks?: BlockStore | null;
  /** Crowd fallbacks (net/crowd/CrowdControl.ts): each system's window and focus radius, charged its rounds' time */
  readonly crowd?: CrowdControl | null;
  /** Other ships' guns stepped on clients' tick layers (net/guns/GunNet.ts) */
  readonly gunNet?: GunNet | null;
}

export class SnapshotBuilder {
  private readonly world: IWorld;
  private readonly gameData: GameData;
  private readonly clients: ReadonlyMap<ClientSocket, ClientConnection>;
  private readonly ships: ShipBridge;
  private readonly party: Party;
  private readonly send: (ws: ClientSocket, msg: ServerMessage) => void;
  private readonly replication: Replication;
  private readonly features: ServerFeatures;
  private readonly pendingRemovedEntities: Map<number, number>;
  private readonly lastEntityStates: Map<number, Map<number, string>>;
  private readonly hits: HitLedger | null;
  private readonly ownChecks: OwnChecks | null;
  private readonly bodies: BodyNet | null;
  private readonly guides: GuideNet | null;
  private readonly blocks: BlockStore | null;
  private readonly crowd: CrowdControl | null;
  private readonly gunNet: GunNet | null;
  /** Other ships' shells clients work out themselves from their gun lanes, named by shot id (net/guns/GunNet.ts) */
  readonly otherShotLog = new OwnShotLog();
  /** Pilots' own shells they work out themselves, named by shot id (CAPS.SHOT_IDS: snapshot/ownShots.ts) */
  readonly ownShotLog = new OwnShotLog();
  /** The server itself, for its tick (read, never held) */
  private readonly ticks: { readonly currentTick: number };
  /** The focus grid (CAPS.FOCUS: net/cells/FocusCells.ts): clients' views by cell */
  readonly focus: FocusCells;
  /** Ships out of clients' views that both ends keep (CAPS.FOCUS: net/cells/AwayNet.ts): back, only what changed */
  readonly away: AwayNet;
  /** The rows' interned keys, last snapshot's and this one's (snapshot/rows/keys.ts) */
  private readonly keys = new RowKeys();
  /** What the row kinds, fire events, removals, map dots and system entry read (each built once) */
  private readonly rowHost: RowHost;
  private readonly fireHost: FireHost;
  private readonly removalHost: RemovalHost;
  private readonly mapHost: MapHost;
  private readonly entryHost: EntryHost;
  /** Ship structure: syncs and HP (snapshot/shipStructure.ts) */
  private readonly structure: ShipStructure;
  /** A pilot's own row, state and check (snapshot/ownRow.ts) */
  private readonly own: OwnRows;
  /** Debris splits clients work out themselves (snapshot/debrisHold.ts) */
  private readonly debris: DebrisHold;
  /** When rounds are due (snapshot/rounds.ts) */
  private readonly rounds: RoundClock;

  constructor(host: SnapshotHost, ticks: { readonly currentTick: number }) {
    this.world = host.world;
    this.gameData = host.gameData;
    this.clients = host.clients;
    this.ships = host.ships;
    this.party = host.party;
    this.send = host.send;
    this.replication = host.replication;
    this.features = host.features;
    this.pendingRemovedEntities = host.pendingRemovedEntities;
    this.lastEntityStates = host.lastEntityStates;
    this.hits = host.hits ?? null;
    this.ownChecks = host.ownChecks ?? null;
    this.bodies = host.bodies ?? null;
    this.guides = host.guides ?? null;
    this.blocks = host.blocks ?? null;
    this.crowd = host.crowd ?? null;
    this.gunNet = host.gunNet ?? null;
    this.ticks = ticks;
    this.focus = new FocusCells({
      bodies: () => this.ships.bodies.keys(),
      has: (eid) => this.ships.has(eid),
      partyOf: (conn) => (this.party.partyId(conn) ? this.party.members(conn).map((m) => m.playerId) : []),
      targetOf: (eid) => this.ships.targetOf(eid),
      transit: (eid) => jumpPhase(this.ships.get(eid)?.jump ?? 0, jumpTuning(this.ships.tuning)).phase === 'burn',
      focusOf: (system) => this.crowd?.focusOf(system) ?? FOCUS_RANGE,
    });
    this.away = new AwayNet({
      keeps: (conn, id) => this.ships.bodies.get(id)?.kind !== 'debris' && conn.shipSynced.has(id) && !conn.debrisHeld.has(id),
      has: (id) => this.ships.has(id),
      send: (conn, msg) => this.send(conn.ws, msg),
    });
    this.rowHost = {
      world: host.world, clients: host.clients, lingering: host.lingering, ships: host.ships, enemies: host.enemies, mobs: host.mobs,
      pods: host.pods, features: host.features, gunNet: this.gunNet, personCraft: host.personCraft, wards: host.wards,
      namedBody: host.namedBody, ticks,
    };
    this.fireHost = { ships: host.ships, gunNet: this.gunNet, ownShotLog: this.ownShotLog, otherShotLog: this.otherShotLog, fireRows: new WeakMap(), ticks };
    this.removalHost = { pendingRemovedEntities: host.pendingRemovedEntities, ownShotLog: this.ownShotLog, otherShotLog: this.otherShotLog, hits: this.hits };
    this.mapHost = {
      world: host.world, gameData: host.gameData, clients: host.clients, ships: host.ships, enemies: host.enemies, lod: host.lod,
      focus: this.focus, send: host.send, namedBody: host.namedBody, flying: host.flying, ticks,
    };
    this.entryHost = {
      world: host.world, gameData: host.gameData, scene: host.scene, events: host.events, surfaces: host.surfaces, crowd: this.crowd,
      focus: this.focus, away: this.away, asteroidIdsBySystem: host.asteroidIdsBySystem, asteroidSeedTickBySystem: host.asteroidSeedTickBySystem,
      asteroidIndexById: host.asteroidIndexById, respawnedAsteroids: host.respawnedAsteroids, send: host.send,
      asteroidSpawnData: host.asteroidSpawnData, mineState: host.mineState ? (m, s) => host.mineState!(m, s) : undefined, ticks,
      landmarks: host.landmarks,
    };
    this.structure = new ShipStructure({ ships: host.ships, send: host.send, hits: this.hits, ticks });
    this.own = new OwnRows({
      world: host.world, ships: host.ships, replication: host.replication, ownChecks: this.ownChecks, bodies: this.bodies, guides: this.guides, ticks,
    });
    this.debris = new DebrisHold({ world: host.world, ships: host.ships, replication: host.replication, send: host.send, ticks });
    this.rounds = new RoundClock(this.crowd, ticks);
  }

  private get currentTick(): number {
    return this.ticks.currentTick;
  }

  /**
   * A client's snapshot window as the part features see it (onSnapshot): from its last snapshot to now, whether its
   * client searches it itself (as SelfHits.detect gates it: finding its own hits, not STRICT, a window at most
   * SEARCH_WINDOW_MAX long), and which ships' poses are exact there (held, and HitLedger.poseExact with the told ships)
   */
  private windowOf(conn: ClientConnection, told: ReadonlySet<number>): SnapshotWindow {
    const from = conn.lastSnapshotSentTick, to = this.currentTick, hits = this.hits;
    const finds = !!hits && hits.searches(conn) && from >= 0 && to > from && to - from <= SEARCH_WINDOW_MAX;
    return { from, to, finds, exact: (id) => finds && conn.shipView.has(id) && hits!.poseExact(conn, id, told) };
  }

  /** ownSyncs sent (its own ship's state put right, exact: net/own, common sim/ownStep.ts) */
  ownSyncs = 0;

  /**
   * Once a tick: is a snapshot round due (every CROWD_BASE_WINDOW ticks, as always; false: not this tick)? It is for every
   * system but the ones returned, whose wider window (crowd fallbacks) hasn't come round yet (null: none)
   */
  due(): RoundSkip | null | false {
    return this.rounds.due();
  }

  /** A system with a clock of its own, in its pass: is its round due (its window, in its ticks)? The skip if so */
  ownRound(system: number): RoundSkip | false {
    return this.rounds.ownRound(system);
  }

  /**
   * Debris confirmations: right, wrong (sent in full instead), never (sent in full when its time ran out), and rebuilt
   * (crumbled before it was confirmed, for a client not running it: sent in full), and told (touched by something else
   * before it was confirmed: sent in full)
   */
  get debrisAcks(): DebrisHold['debrisAcks'] {
    return this.debris.debrisAcks;
  }

  /** A client's confirmations of debris it worked out ([id, check, ...], on its input): right, it counts as sent */
  ackDebris(conn: ClientConnection, acks: readonly number[]): void {
    this.debris.ackDebris(conn, acks);
  }

  /** Hostile populations to the clients in their systems (snapshot/mapDots.ts) */
  sendPops(): void {
    sendPops(this.mapHost);
  }

  /** The system map's ships past the snapshot's ship view (snapshot/mapDots.ts) */
  sendMapDots(due: boolean): void {
    sendMapDots(this.mapHost, due);
  }

  /** A client's first snapshot in a system: world events, the asteroid seed, and a clean slate (snapshot/systemEntry.ts) */
  enterSystem(conn: ClientConnection, playerSystemId: number): void {
    enterSystem(this.entryHost, conn, playerSystemId);
  }

  /** HUD numbers, and the system visuals when its system changes (snapshot/systemEntry.ts) */
  sendPlayerState(conn: ClientConnection): void {
    sendPlayerState(this.entryHost, conn);
  }

  /**
   * One snapshot round, in its phases: begin (the per-round caches, the focus grid's home cells), each client's snapshot
   * (clientSnapshot), then end (removals let go, the round's caches flushed, map dots and pops)
   */
  sendSnapshots(skip: RoundSkip | null = null): void {
    // (A round for some systems only, crowd fallbacks: what's kept for a round is let go only for theirs)
    const due = skip ? (eid: number) => !skip.has(InSystem.systemId[eid]) : undefined;
    // Skip entirely when no clients are connected — avoids building
    // per-entity state objects and JSON keys for nothing.
    if (this.clients.size === 0) {
      this.flushRound(due);
      return;
    }
    this.beginRound(skip, due);
    const crowd = this.crowd;
    this.chargeAt = crowd ? performance.now() : 0;
    for (const conn of this.clients.values()) {
      // No snapshot this round: it misses the control changes, so it starts over with keyframes
      // (Nor before it has joined: a socket that never joins costs no snapshots, session.ts's join deadline)
      if (!conn.joined || !conn.ws.isOpen() || !hasComponent(this.world, Player, conn.playerId)) { conn.repKnown.clear(); if (conn.focus) this.focus.reset(conn); continue; }
      const playerSystemId = InSystem.systemId[conn.playerId];
      // (Its system's window hasn't come round: crowd fallbacks)
      if (skip?.has(playerSystemId)) continue;
      if (crowd) { const t1 = performance.now(); crowd.charge(this.chargeTo, t1 - this.chargeAt); this.chargeAt = t1; this.chargeTo = playerSystemId; }
      this.clientSnapshot(conn, playerSystemId);
    }
    if (crowd) { crowd.charge(this.chargeTo, performance.now() - this.chargeAt); this.chargeTo = -1; }
    this.endRound(due);
  }

  /** The time charged so far this round to `chargeTo` (crowd fallbacks) */
  private chargeAt = 0;
  /** This round's rows and stations and portals, by system: built for the first client there, shared by the rest */
  private readonly roundRows = new Map<number, { rows: SnapRow[]; byId: Map<number, SnapRow> }>();
  private readonly roundStatic = new Map<number, StaticList>();

  /** A round begins: the per-round caches, replication's and the guns' rounds, the focus grid's home cells */
  private beginRound(skip: RoundSkip | null, due: ((eid: number) => boolean) | undefined): void {
    this.structure.beginRound();
    this.roundRows.clear();
    this.roundStatic.clear();
    this.replication.beginSnapshot(due);
    this.gunNet?.beginRound(due);
    // (The focus grid's home cells, for the systems with a client in them)
    const focusSystems = new Set<number>();
    for (const conn of this.clients.values()) if (conn.joined && hasComponent(this.world, Player, conn.playerId) && !skip?.has(InSystem.systemId[conn.playerId])) focusSystems.add(InSystem.systemId[conn.playerId]);
    if (focusSystems.size) this.focus.beginRound(focusSystems);
  }

  /** The round's end: removals let go (and the entities they name forgotten), its caches flushed, map dots and pops */
  private endRound(due: ((eid: number) => boolean) | undefined): void {
    // Clear pending removed entities after sending to all clients
    // Also remove from knownEntities so they can be re-sent if respawned
    const goneNow: number[] = [];
    for (const [eid] of this.pendingRemovedEntities) {
      if (due && !due(eid)) continue;
      for (const conn of this.clients.values()) conn.knownEntities.delete(eid);
      goneNow.push(eid);
    }
    // (Move shells gone: forgotten, CAPS.MOVES)
    this.bodies?.shellsGone(goneNow, this.clients.values());
    // (Encode-once blocks: the removed give their wire ids back, flushRound; ones no block has named for a while too)
    this.flushRound(due, true);
    this.replication.endSnapshot(due);
    this.guides?.sweep();
    this.keys.swap();
    this.roundRows.clear();
    this.roundStatic.clear();
    const dotsDue = this.currentTick - this.lastMapDotsTick >= MAP_DOTS_TICKS;
    if (dotsDue) this.lastMapDotsTick = this.currentTick;
    this.sendMapDots(dotsDue);
    this.sendPops();
  }

  /**
   * One client's snapshot: its ship motion and what's away (motionFor), its own ship's state (ownStateOf), fire events,
   * its rows (rowsFor), structure, stations and portals, removals; then, if anything goes, the frame
   */
  private clientSnapshot(conn: ClientConnection, playerSystemId: number): void {
    if (conn.lastSystemId !== playerSystemId) this.enterSystem(conn, playerSystemId);
    let sys = this.roundRows.get(playerSystemId);
    if (!sys) {
      const rows = systemRows(this.rowHost, this.keys, playerSystemId), byId = new Map<number, SnapRow>();
      for (const r of rows) if (!byId.has(r.id)) byId.set(r.id, r);
      this.roundRows.set(playerSystemId, (sys = { rows, byId }));
    }

    const entities: EntityState[] = [];
    // (Its states as last sent, and this round's. A new Map a round: swapping two and clearing one saves nothing, as V8's
    // Map.clear gives it a new table too, and the whole map costs about 5 us a client a round of the ~400 its snapshot does)
    const prevStates = this.lastEntityStates.get(conn.playerId) || new Map<number, string>();
    const newStates = new Map<number, string>();

    const m = this.motionFor(conn, playerSystemId, prevStates);
    const { rep, keyed } = m;
    // Its own row: whether it goes, and whether to correct its prediction
    const selfRow = sys.byId.get(conn.playerId);
    const own = this.ownStateOf(conn, selfRow, prevStates);
    const { self, ownNow, fullSync, syncing } = own;
    // Shots from ships it replicates go as fire events: it builds the shells itself (launch.ts).
    // Not for a ship it's only now getting a keyframe for (it can't place it back then), nor its
    // own unless it replicates that too; those shells, and any flying in from further off, go as rows.
    const fire: number[][] = [];
    const covered = new Set<number>();
    // (Its ship keyframed in this snapshot, or its state put right (an ownSync): what its layer built its own shells of
    // the window from isn't the server's; their hits are told, as rows' are, every one since the last snapshot it got.
    // Client ShipClient.preSnapshot, OwnShells.snapshot's `keyed`)
    const ownTold = keyed.has(conn.playerId) || fullSync;
    // (its own straight shells it works out itself, CAPS.SHOT_IDS: no record, no row, named by shot id in its hits and
    // removals; other ships' it steps the guns of too: net/guns/GunNet.ts)
    if (this.hits && !this.hits.shellName) { const log = this.ownShotLog, other = this.otherShotLog; this.hits.shellName = (c, id) => log.wireOf(c, id) ?? other.wireOf(c, id) ?? id; }
    // (Other ships' guns it steps itself: what it's owed of them this round, GunNet.forClient)
    const bodies = this.bodies;
    const guns: GunClient | null = this.gunNet ? this.gunNet.forClient(conn, conn.playerId, (e) => conn.repKnown.has(e) && conn.shipView.has(e) && InSystem.systemId[e] === playerSystemId,
      (e) => !!bodies?.runs(conn, e), keyed, conn.lastSnapshotSentTick) : null;
    collectFire(this.fireHost, conn, playerSystemId, guns, keyed, rep.ownRebuild, fire, covered);
    if (ownTold && conn.ownWindow) for (const id of conn.ownWindow) this.hits?.rowShell(conn, id);
    this.rowsFor(conn, sys.rows, self, prevStates, newStates, covered, entities);
    // Ship structure: full sync on first sight and after every rebuild, HP deltas otherwise
    // (Confirmed hits: its HP after its records, below; first, what it'll make of each hit)
    const hitsOn = !!this.hits;
    this.structure.sendShipUpdates(conn, playerSystemId, true, !hitsOn);
    // (Hits on a ship its causes moved this window are told, as on one keyframed: its client leaves them, SelfHits.onCaused)
    const told = rep.caused ? toldShips(keyed, rep.causes, rep.found?.touched, (id) => hasComponent(this.world, Player, id)) : keyed;
    const gone = hitsOn ? this.hits!.plan(conn, (id) => prevStates.has(id) || newStates.has(id) || covered.has(id) || this.ownShotLog.has(conn, id) || this.otherShotLog.has(conn, id), told) : null;

    // Stations and portals: sent once per system (they never move)
    let statics = this.roundStatic.get(playerSystemId);
    if (!statics) this.roundStatic.set(playerSystemId, (statics = staticOf(this.world, playerSystemId)));
    staticRows(this.gameData, conn, statics, (state) => {
      // (hp and boost fuel ride every snapshot's own row, timed; here they are only the first values, so they are not part of
      // the key: a change in them alone sent a message that the client then wrote over its prediction with)
      const key = JSON.stringify({ ...state, hp: 0, boostFuel: 0 });
      newStates.set(state.id, key);
      if (prevStates.get(state.id) !== key) entities.push(state);
    });

    // Removals this client cares about (snapshot/frameParts.ts removalsFor)
    const removed = removalsFor(this.removalHost, conn, prevStates, gone, m.goneAway);

    // HUD numbers (fuel, XP) once a second, whether or not anything else goes (the round in each second's first window)
    const hudRound = this.currentTick % 60 < (this.crowd ? this.crowd.windowOf(playerSystemId) : CROWD_BASE_WINDOW);
    if (hudRound) this.sendPlayerState(conn);
    // (and with them, a snapshot for its head hash if it has had none lately: HEAD_HASH_TICKS)
    const headDue = hudRound && !!ownNow && this.currentTick - conn.lastSnapshotSentTick >= HEAD_HASH_TICKS;

    // (Records count from the snapshot they follow: one always goes with them)
    // (Pull fields of its system it hasn't been told as they stand, opened or ended early: its tick layer works their
    // pulls out itself, common sim/pullFields.ts; just before the snapshot, as an ownSync goes)
    const pullRows = this.ships.pulls.any || conn.pullsTold?.size ? this.ships.pulls.forClient(conn.pullsTold ??= new Map(), playerSystemId) : null;
    const pullReset = !!conn.pullsReset;
    const { decisions, guided, out } = m;
    const shouldSend = !!pullRows || pullReset || conn.forceSnapshot || m.split || !!rep.found?.count || entities.length > 0 || removed.length > 0 || rep.ships.length > 0 || rep.ctl.length > 0 || out.length > 0 || fire.length > 0 || !!rep.own?.length || !!rep.causes?.length || !!decisions?.length || !!guided?.active || !!guided?.rows.length
      || (hitsOn && this.hits!.pending(conn)) || syncing || headDue || !!guns?.syncs.length || !!guns?.rows.length;
    if (!shouldSend) {
      this.lastEntityStates.set(conn.playerId, newStates);
      if (hitsOn) this.afterHits(conn, playerSystemId);
      return;
    }

    // (The ownSync goes first: its client takes it before the snapshot's own processing, OwnTick.onOwnSync)
    if (syncing) { this.send(conn.ws, fullSync ? packOwnSync(this.currentTick, ownNow!.x) : packOwnHazards(this.currentTick, ownNow!.x.hazard)); this.ownSyncs++; }
    // (Other ships' gun lanes it starts from here: before the snapshot, as the ownSync. The pilots' gun controls it
    // steps them on ride in the snapshot, `gun`: each row made once a round, an encode-once block)
    if (guns) for (const msg of guns.syncs) this.send(conn.ws, msg);
    if (pullRows || pullReset) { this.send(conn.ws, pullReset ? { type: 'pulls', f: pullRows ?? [], r: 1 } : { type: 'pulls', f: pullRows! }); conn.pullsReset = false; }
    if (ownNow) conn.ownSyncDue = false;
    // (Its window closes: what the part features tell of it goes first, the Mine Bay's blasts it can't find itself)
    if (this.features.wantsSnapshots) this.features.onSnapshot(conn.playerId, this.windowOf(conn, told));
    this.send(conn.ws, {
      type: 'snapshot',
      tick: this.currentTick,
      lastProcessedInput: conn.lastInputSeq,
      entities,
      removed,
      ships: rep.ships.length ? rep.ships : undefined,
      ctl: rep.ctl.length ? rep.ctl : undefined,
      out: out.length ? out : undefined,
      fire: fire.length ? fire : undefined,
      own: rep.own,
      decisions: decisions?.length ? decisions : undefined,
      causes: rep.causes,
      guides: guided?.rows.length ? guided.rows : undefined,
      hh: headWord(ownNow ? ownNow.hash : null, keyed.has(conn.playerId) ? HEAD_HASH_ROW : 0),
      gun: guns?.rows.length ? guns.rows : undefined,
    });

    conn.forceSnapshot = false;
    conn.lastSnapshotSentTick = this.currentTick;
    if (conn.ownWindow) conn.ownWindow.length = 0;
    this.lastEntityStates.set(conn.playerId, newStates);
    if (hitsOn) this.afterHits(conn, playerSystemId);
    // (its window's rebuild syncs are done with: HitLedger.derive)
    conn.hpBefore?.clear();
    // What its check of its own ship should say for this snapshot (net/own/OwnChecks.ts)
    if (this.ownChecks && conn.repKnown.has(conn.playerId)) this.own.noteOwn(conn, ownNow);
    // ...and of the bodies it runs (net/decisions/BodyNet.ts)
    bodies?.note(conn, this.currentTick);
  }

  /**
   * A client's ship motion this round, and what came and went from its view: debris it works out held back, its focus
   * cells' view (and the ships away), the bodies' decisions and the guides it runs, replication's share, contact sparks
   */
  private motionFor(conn: ClientConnection, playerSystemId: number, prevStates: Map<number, string>) {
    // Interest management: what's near is sent every snapshot; distant ships every few
    // (the client dead-reckons in between); distant projectiles and loot not at all
    const px = Position.x[conn.playerId], py = Position.y[conn.playerId];
    // Debris it can work out itself: told how (first, before the ship's own sync), and held back till it confirms
    // (a split told goes with a snapshot: its client works it out once that snapshot's causes are in, DebrisSplits.flush)
    const split = this.debris.holdDebris(conn);
    // Ships that left its view: the ships homed in its focus cells (net/cells/FocusCells.ts); it keeps them while
    // they're away, and gets only what changed when they're back (net/cells/AwayNet.ts)
    const out = this.focus.view(conn, playerSystemId, px, py);
    const goneAway = this.away.round(conn, this.currentTick, conn.shipView, out, prevStates);
    // Ship motion: keyframes where needed, control changes and causes otherwise (its own ship's too: its confirmed
    // ship, stepped on its tick layer, snapshot/ownShots.ts)
    // Bosses flown by their bodies on its tick layer: their decisions, and from here no rows or drive keyframes of them
    const bodies = this.bodies;
    const decisions = bodies?.forClient(conn, conn.playerId, (e) => InSystem.systemId[e] ?? -1, playerSystemId ?? -1, conn.repKnown, this.currentTick,
      (e) => !conn.shipView || conn.shipView.has(e), (e) => this.replication.keysFor(e, conn.playerId, conn.repKnown));
    // Homing shells and mobs on its tick layer: their SYNCs and records, and from here no rows of them
    const guided = this.guides?.forClient(conn, {
      self: conn.playerId, systemId: playerSystemId,
      near: (e) => !fartherThan(Position.x[e] - px, Position.y[e] - py, SNAP_PROJECTILE_RANGE),
      holds: (e) => conn.shipView.has(e) && conn.repKnown.has(e),
      rekeyed: (e) => this.replication.keysFor(e, conn.playerId, conn.repKnown),
    }, this.currentTick);
    const rep = this.replication.forClient(playerSystemId, conn.playerId, conn.repKnown, this.currentTick, conn.shipView, conn.debrisHeld, (id) => conn.shipSynced.get(id)?.rebuilds, bodies ? (id) => bodies.runs(conn, id) : undefined, (id) => this.structure.keptAfter(conn, id, playerSystemId),
      // (A ship a body it runs reads, keyframed now: the body's ship goes again too, Replication.forClient)
      bodies ? (ships) => bodies.readersOf(conn, conn.playerId, ships) : undefined, conn.debrisLive,
      // (Contact pairs it finds itself: since its last snapshot, the window it works them out over)
      conn.lastSnapshotSentTick,
      // (Which ships it was told were pinned, on their first sync: its contact pass takes them so, contactsFor.ts)
      (id) => { const s = conn.shipSynced.get(id); return s && s.ship === this.ships.bodies.get(id) ? !!s.pinned : undefined; },
      // (...of those it was told were: the rest it takes unpinned)
      () => { const syn = conn.shipSynced; if (syn instanceof SyncedShips) return syn.pinned; const ids: number[] = []; for (const [id, s] of syn) if (s.pinned) ids.push(id); return ids; });
    // (...and their sparks it draws itself: the rest go now, Replication.contactFxFor)
    for (const msg of this.replication.contactFxFor(conn, playerSystemId, rep.found ?? null, this.currentTick)) {
      if (!fartherThan(msg.x - px, msg.y - py, FX_NEAR)) this.send(conn.ws, msg);
    }
    // (the ships keyframed in this snapshot)
    const keyed = new Set(rep.ships.map((k) => k[0]));
    return { px, py, split, out, goneAway, decisions, guided, rep, keyed };
  }

  /**
   * Its own ship this round: its own row's state (whether it goes, whether to correct its prediction), its full state now
   * (the head hash, its check's expectation), and whether an ownSync (or one of its hazards alone) goes before the snapshot
   */
  private ownStateOf(conn: ClientConnection, selfRow: SnapRow | undefined, prevStates: Map<number, string>) {
    const self = selfRow ? this.own.selfRowState(conn, selfRow, prevStates) : null;
    // (Its own ship's full state now: the head hash, its check's expectation, and an ownSync (its stores, guns, hazards
    // and priming put right, exact) when its client can't have them: its check found them off (OwnChecks), first sight,
    // a new keyframe version (a new ship, a teleport) or a late input. Its hazards changed (an EMP, a Frostbite's slowing,
    // the cold's stage: the server's decision) and nothing else: an ownSync of them alone, the rest its client's own to step.
    // Anything else off its head hash finds within a second or so, and its check brings it)
    const ownNow = this.own.ownNow(conn);
    // (its hazards as last told, run on to now as its client runs them, against the server's)
    const hazChanged = !!ownNow && (!conn.ownHazards || ownHazardKey(conn.ownHazards, this.currentTick) !== ownHazardKey(ownNow.x.hazard, this.currentTick));
    const fullSync = !!ownNow && (!!conn.ownSyncDue || (!!self && (!prevStates.has(conn.playerId) || conn.selfLate || self.version !== conn.selfVersion)));
    const hazSync = hazChanged && !fullSync, syncing = fullSync || hazSync;
    if (syncing) conn.ownHazards = { ...ownNow!.x.hazard };
    return { self, ownNow, fullSync, syncing };
  }

  /**
   * Its rows this round: the system's rows less what it holds as it was, works out itself or is too far to see; each
   * one's key set in `newStates`, the ones that changed pushed to `entities` (names once)
   */
  private rowsFor(conn: ClientConnection, rows: readonly SnapRow[], self: OwnRowState | null, prevStates: Map<number, string>, newStates: Map<number, string>,
    covered: ReadonlySet<number>, entities: EntityState[]): void {
    const px = Position.x[conn.playerId], py = Position.y[conn.playerId];
    const bodies = this.bodies, guidesOn = this.guides;
    // (its shells and other ships' it works out itself, as collectFire named them: nothing adds to them past it)
    const ownShots = this.ownShotLog.of(conn), otherShots = this.otherShotLog.of(conn);
    for (const r of rows) {
      if ((r.kind === 'player' || r.kind === 'ship') && !conn.shipView.has(r.id)) continue;
      // (Debris it's working out itself: nothing till it confirms; once it has, the status row it made itself counts as sent)
      if (conn.debrisHeld.has(r.id)) continue;
      if (conn.debrisRowOk.size && conn.debrisRowOk.delete(r.id) && r.key === DEBRIS_ROW_KEY) { newStates.set(r.id, r.key); continue; }
      if (r.kind === 'projectile' && covered.has(r.id)) { newStates.set(r.id, r.key); continue; }
      // (its own shell it works out itself, CAPS.SHOT_IDS: no row, ever; nor another ship's whose guns it steps)
      if (r.kind === 'projectile' && (!!ownShots?.has(r.id) || !!otherShots?.has(r.id))) continue;
      // (a body's move's straight shell it makes itself, CAPS.MOVES: no row, nor a removal)
      if (r.kind === 'projectile' && bodies?.shellDerived(conn, conn.playerId, r.id, prevStates.has(r.id))) continue;
      // (a homing shell it runs, its row once sent: it flies it itself)
      if (r.kind === 'projectile' && guidesOn?.runs(conn, r.id) && prevStates.has(r.id)) { newStates.set(r.id, r.key); continue; }
      // (a mob it runs: its row again only when its HP changes)
      if (r.kind === 'mob' && guidesOn?.runs(conn, r.id)) {
        const k = `hp:${r.state.hp},${r.state.maxHp}`;
        newStates.set(r.id, k);
        if (prevStates.get(r.id) !== k) entities.push(r.state);
        continue;
      }
      if ((r.kind === 'projectile' || r.kind === 'mob') && fartherThan(r.x - px, r.y - py, SNAP_PROJECTILE_RANGE)) continue;
      if (r.kind === 'pod' && fartherThan(r.x - px, r.y - py, SNAP_POD_RANGE)) continue;
      if (r.id === conn.playerId && self) {
        // Its own ship: only when its prediction needs correcting, its status changed (its warmth too), or now and then
        newStates.set(r.id, 'self');
        if (!self.need) continue;
        conn.selfRowQuiet = !self.fix;
        conn.selfLate = false;
        conn.selfVersion = self.version;
        if (conn.selfState) for (let i = 0; i < 7; i++) conn.selfState[i] = this.own.selfNow[i]; else conn.selfState = this.own.selfNow.slice();
      }
      let v = r.other && r.id !== conn.playerId ? r.other : r;
      if (r.id !== conn.playerId) {
        newStates.set(r.id, v.key);
        if (prevStates.get(r.id) === v.key) continue;
        // Another ship it already has: its motion is replicated, so the status goes without where it is
        if ((r.kind === 'player' || r.kind === 'ship') && prevStates.has(r.id)) {
          v = { ...v, state: v.strip ??= { ...v.state, x: undefined!, y: undefined!, angle: undefined } };
        }
      }
      // (A shell as a row isn't exact on its client (rounded): one finding its own hits leaves it to the server's records)
      if (r.kind === 'projectile') this.hits?.rowShell(conn, r.id);
      // Names go once (the client keeps them)
      if (r.name !== undefined && conn.sentNames.get(r.id) !== r.name) {
        conn.sentNames.set(r.id, r.name);
        entities.push(derivedRow(v.state, { name: r.name }));
      } else {
        entities.push(v.state);
      }
    }
  }

  private lastMapDotsTick = -Infinity;
  /** The system the time since the last charge goes to (crowd fallbacks; -1: none) */
  private chargeTo = -1;

  /**
   * What a round lets go of, for the systems it was for (all: due undefined): removals (encode-once wire ids back),
   * fire events, debris splits told
   */
  private flushRound(due: ((eid: number) => boolean) | undefined, sweep = false): void {
    if (!due) {
      this.blocks?.removed(this.pendingRemovedEntities.keys());
      if (sweep) this.blocks?.sweep(this.currentTick);
      this.pendingRemovedEntities.clear();
      this.ships.fired.length = 0;
      this.gunNet?.endRound();
      this.ships.debrisNet.afterSnapshot((id) => this.ships.has(id));
      return;
    }
    const gone: number[] = [];
    for (const [eid] of this.pendingRemovedEntities) if (due(eid)) gone.push(eid);
    this.blocks?.removed(gone);
    if (sweep) this.blocks?.sweep(this.currentTick);
    for (const eid of gone) this.pendingRemovedEntities.delete(eid);
    const fired = this.ships.fired;
    let n = 0;
    for (const f of fired) if (!due(f.owner)) fired[n++] = f;
    fired.length = n;
    this.gunNet?.endRound(due);
    this.ships.debrisNet.afterSnapshot((id) => this.ships.has(id), due);
  }

  /** A client taking confirmed hits, after its snapshot: its records (and what goes the old way), then its HP, then a check */
  private afterHits(conn: ClientConnection, systemId: number): void {
    this.hits!.write(conn);
    this.structure.sendShipUpdates(conn, systemId, false, true);
    this.hits!.check(conn);
  }
}
