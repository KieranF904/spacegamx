/**
 * @contract server.gameserver
 * owns:       the GameServer class: its fields, the constructor that wires every module in order, and thin forwards to gameServer/*
 * needs:      ServerCtx (net/ServerCtx.ts), gameServer/* modules, game/* modules, net/* modules, ships/ShipBridge; npm: @space-game/common, bitecs
 * invariants: module construction order in the constructor decides what each host can reach — server/src/golden/frameHash.test.ts
 *             the tick table order is the one tickOrder.json pins — server/src/tickOrder.test.ts
 *             the client message table is the one clientMessages.json pins — clientMessages.json
 * extend:      a new area of server logic is a module under gameServer/ taking `gs: GameServer` (or a narrower Pick), wired in the constructor
 */

import { createWorld, addEntity, hasComponent, getAllEntities, IWorld } from 'bitecs';
import { Player, InSystem, Dead } from '@space-game/common';
import { ClientMessage, ServerMessage, ReplicaEnv, mulberry32, TrafficData } from '@space-game/common';
import { GameData } from './data/GameData.js';
import type { UserStore } from './auth/types.js';
import type { ClientSocket, ClientLink } from '@space-game/common';
import type { ShipBridge } from './ships/ShipBridge.js';
import { Economy, StarterKit, starterKit, hazardFlight, systemLandmarks, jumpTuning, type ShipDerived } from '@space-game/common';
import { Pilots } from './game/Pilots.js';
import { Ammo } from './game/Ammo.js';
import type { GunRange } from './game/gunRange/GunRange.js';
import { Hazards } from './game/Hazards.js';
import { Warmth } from './game/Warmth.js';
import { Outpost } from './game/Outpost.js';
import { HomeStations } from './game/HomeStations.js';
import type { Tutorial } from './game/tutorial/Tutorial.js';
import { LootPods } from './game/LootPods.js';
import { ServerFeatures } from './ships/features/host.js';
import { SERVER_FEATURES } from './ships/features/index.js';
import { Mining } from './game/Mining.js';
import { PayoutDice } from './game/payoutDice.js';
import { AsteroidOrbits } from './game/AsteroidOrbits.js';
import { StationServices } from './game/StationServices.js';
import { Weapons } from './game/Weapons.js';
import { Enemies, FactionsFile, withZoneSpots, withNests } from './game/Enemies.js';
import { Telemetry } from './game/Telemetry.js';
import { Quests } from './game/Quests.js';
import { People } from './game/People.js';
import { Codex } from './game/Codex.js';
import { Arenas } from './game/Arenas.js';
import { Bosses, BossesFile } from './game/Bosses.js';
import { ArenaGates } from './game/arenas/ArenaGates.js';
import { CombatClock } from './game/arenas/CombatClock.js';
import { BossDev } from './game/dev/bossDev.js';
import { EnemyRecovery } from './game/enemies/recovery.js';
import { Dens } from './game/dens/Dens.js';
import { Mobs, MobsFile } from './game/Mobs.js';
import { Events } from './game/Events.js';
import { AdminTools } from './game/AdminTools.js';
import type { FieldShips } from './game/field/FieldShips.js';
import { ContributorNotes } from './game/ContributorNotes.js';
import { AdminChat } from './game/AdminChat.js';
import { Surfaces } from './game/Surfaces.js';
import { Sieges } from './game/Sieges.js';
import { Hangar } from './game/Hangar.js';
import { Party } from './game/Party.js';
import { Social } from './game/social/Social.js';
import { MemoryFriends } from './game/social/MemoryFriends.js';
import type { Support } from './ships/features/support/Support.js';
import { Trade } from './game/Trade.js';
import { Operations } from './game/Operations.js';
import { Market } from './game/Market.js';
import { Replication } from './net/Replication.js';
import { SimLod } from './ships/SimLod.js';
import { SystemMemory } from './game/SystemMemory.js';
import { Achievements } from './game/Achievements.js';
import { RibbonsFile, type Terrain, type Landmark, type PlanetData, type LodestoneData } from '@space-game/common';
import { MemoryProfileStore } from './profile/ProfileStore.js';
import { MessageLimiter } from './net/MessageLimits.js';
import { type TickSystem } from './tickOrder.js';
import type { ClientConnection } from './net/ClientConnection.js';
import type { ServerCtx } from './net/ServerCtx.js';
import { rejectAuth } from './net/auth.js';
import { Docking } from './game/Docking.js';
import { Derelicts, type DerelictSlot } from './game/Derelicts.js';
import { type HandlerTable } from './net/dispatch.js';
import { Outbox } from './net/snapshot/Outbox.js';
import { HitLedger } from './net/hits/HitLedger.js';
import { OwnChecks } from './net/own/OwnChecks.js';
import { BodyNet } from './net/decisions/BodyNet.js';
import { GuideNet } from './net/guides/GuideNet.js';
import type { MoveOrigin } from '@space-game/common';
import { CrowdControl } from './net/crowd/CrowdControl.js';
import { SystemClocks } from './sim/SystemClocks.js';
import { GunNet } from './net/guns/GunNet.js';
import { SnapshotBuilder, type RoundSkip, projectileQuery } from './net/SnapshotBuilder.js';
import { RemovalSet } from './gameServer/shared.js';
import { SpatialGrid } from './gameServer/spatialGrid.js';
import { perfMetrics } from './gameServer/perf.js';
import { GameServerOptions } from './gameServer/options.js';
export type { GameServerOptions };
import { createPilotHost, createQuestHost, createPartyHost, createPeopleHost, createArenaHost } from './gameServer/hosts/pilots.js';
import { createOpsHost, createEventHost, createMobHost, createEnemyHost } from './gameServer/hosts/world.js';
import { createSurfaceHost, createSiegeHost, createPodHost, createMemoryHost, deathCause, namedBody } from './gameServer/hosts/places.js';
import { createBossHost, moveFx, moveShot } from './gameServer/hosts/boss.js';
import { createMiningHost, mineBeam, isGas, beamAsteroid } from './gameServer/hosts/mining.js';
import { setupTutorial, installTutorialAdmin } from './gameServer/hosts/tutorial.js';
import { setupGunRange } from './gameServer/hosts/gunRange.js';
import { createShipHost } from './gameServer/hosts/ship.js';
import { createAdminHost } from './gameServer/admin.js';
import { initializeWorld } from './gameServer/world.js';
import { joinFeatureMessages, stationAtConn, installHangarLogin, installSocialLogin, trackErrors } from './gameServer/hooks.js';
import { asteroidSpawnData, placeAsteroid } from './gameServer/asteroids.js';
import { shotWall, hurtAsteroid } from './gameServer/combat.js';
import { getTrafficShips, stationEntity } from './gameServer/traffic.js';
import { connect, enter, createPlayer, placePlayer, loginPilot, resumeGuest, forgetAccounts, saveAll } from './gameServer/session.js';
import { buildMessageHandlers, handleMessage, handleInput, applyInputToEntity } from './gameServer/messages.js';
import { canHeal, canDamage, sideOf, inPvpZone, hunted } from './gameServer/rules.js';
import { fault, faultCounts } from './gameServer/faults.js';
import { threats, regionThreats } from './gameServer/threats.js';
import { travelTo } from './gameServer/travel.js';
import { step, snapshotRound, ownPasses, gameLoop, drainInputQueue, releaseControls, buildTickSystems, tick, fileBeltsLater } from './gameServer/loop.js';
import { featuresDeps, replicationDeps, lodDeps, crowdDeps, clocksDeps, snapshotDeps, ownChecksDeps, bodiesDeps } from './gameServer/wiring/net.js';
import { dockingDeps, pilotsOpts, weaponsDeps, marketDeps, servicesDeps, hazardsDeps, warmthDeps, homesDeps, arenaGatesDeps, recoveryDeps, bossDevDeps, densDeps, contribDeps, adminChatDeps, codexDeps, achievementsDeps, socialDeps, derelictsDeps, tradeDeps } from './gameServer/wiring/game.js';

/**
 * Game Server - Main server with ECS world and systems
 */

export class GameServer implements ServerCtx {
  readonly world: IWorld;
  /** Server-only randomness, seeded (math/rng.ts): spawn spots and groups, the people's chatter */
  rng = mulberry32(0x6a3e5);
  /**
   * Payout dice (game/payoutDice.ts): every roll that decides what a pilot gets (mining, loot, salvage, pods, caches,
   * gem cuts) draws from these, keyed by a secret that never leaves the server (GameServerOptions.payoutSecret)
   */
  readonly payout: PayoutDice;
  gameData: GameData;
  clients: Map<ClientSocket, ClientConnection> = new Map();
  scene: 'sectors' | 'empty';
  everyoneAdmin: boolean;
  guestAdmin: boolean;
  /** Set by server/src/update when a restart is a minute away: the message every new sign-in is refused with */
  joinGate: (() => string | null) | null = null;
  /** Admins may build for free in the hangar (AdminTools `freebuild`) */
  freeBuildAllowed: boolean;
  /** The dev server's start system (opts.devStart), by number; -1: pilots start in Sol and come back where they left off */
  devStartNum = -1;
  paused = false;
  /** Tick until which each player ignores rifts (no instant bounce-back) */
  riftCooldown = new Map<number, number>();
  ships: ShipBridge;
  readonly shipEditAnywhere: boolean;
  /** Berths and who is inside a station (game/Docking.ts) */
  docking!: Docking;
  /** Ships inside a station: the same Set as docking.dockedShips (read on the hot path) */
  dockedShips!: Set<number>;

  devTeleport: boolean;
  clientIdCounter = 1;
  
  currentTick = 0;
  lastTickTime = 0;
  tickAccumulator = 0;
  
  
  // Input queue — messages arrive instantly between ticks, get applied at tick boundaries
  readonly inputQueue: Array<{ conn: ClientConnection; msg: any }> = [];
  
  // Tracks entities that died this tick (for snapshot removal notifications), with the system they were in
  pendingRemovedEntities = new RemovalSet();
  
  // Spatial partitioning for efficient collision detection
  spatialGrid: SpatialGrid = new SpatialGrid();

  // Deterministic asteroid ids per system (systemNum -> asteroid ids)
  asteroidIdsBySystem: Map<number, number[]> = new Map();
  asteroidSeedTickBySystem: Map<number, number> = new Map();
  asteroidIndexById: Map<number, number> = new Map();
  asteroidTypeById: Map<number, string> = new Map();
  /** Outliers: the stage each is at, and its size whole */
  asteroidStageById = new Map<number, { stage: number; wholeSize: number }>();
  /** Asteroids re-created after breaking (not described by their system's seed) */
  respawnedAsteroids = new Set<number>();
  /** Replication environments (gravity, central body) per system */
  private replicaEnvs = new Map<number, ReplicaEnv>();
  /** Each system's stations with their names (hostile AI asks every few ticks) */
  namedStations = new Map<number, { eid: number; name: string }[]>();
  /** Where every asteroid's orbit takes it, and when (shots and beams look asteroids up here) */
  asteroidOrbits = new AsteroidOrbits();
  /** The tick each asteroid's Position was last worked out for */
  asteroidPlacedAt = new Map<number, number>();
  
  // Entity state cache for delta compression
  lastEntityStates: Map<number, Map<number, string>> = new Map(); // playerId -> entityId -> serialized state
  
  // System-specific state
  /** Derelict hulks by slot: the current body (-1 while destroyed) and when it comes back */
  /** Derelict slots: the same array as derelictsMod.derelicts (game/Derelicts.ts) */
  derelicts!: DerelictSlot[];
  /** Derelicts and people's craft (game/Derelicts.ts) */
  derelictsMod!: Derelicts;
  /** Freighters: which station they're bound for, and how long they've been docked there */
  traffic: { data: TrafficData; systemNum: number; eid: number; leg: number; dwell: number; respawnTick: number }[] = [];
  
  // NPC ID mapping (npcId number -> npc string id)
  
  
  /** Items, recipes and part costs (shared with the client) */
  readonly econ: Economy;
  /** Each player's progress: profile, cargo, storage, saving */
  readonly pilots: Pilots;
  readonly pods: LootPods;
  /**
   * Run once at the end of every main tick, after the tick table (guarded): the dev-only bots (server/src/bots) think and
   * send their inputs here, as a client does between ticks. Empty on every server that has no bots.
   */
  readonly afterTick: Array<() => void> = [];
  /** Part features' world side (ships/features/host.ts): built once, ticked in the 'towing' entry's place */
  features!: ServerFeatures;
  readonly mining: Mining;
  services: StationServices;
  ammo!: Ammo;
  /** The gun range (game/gunRange): any station's pilots try any weapon they can fit, in a cheat ship, nothing kept */
  gunRange!: GunRange;
  hazards!: Hazards;
  warmth!: Warmth;
  outpost?: Outpost;
  homes!: HomeStations;
  /** The training yard for new pilots (game/tutorial); none unless the server runs one (GameServerOptions.tutorial) */
  tutorial?: Tutorial;
  weapons: Weapons;
  readonly enemies: Enemies;
  /** Story, chains and bounties */
  readonly quests: Quests;
  /** Who you can talk to, and the conversations */
  readonly people: People;
  /** Records: lore found as documents and testimony */
  readonly codex: Codex;
  /** Jobs' private battlegrounds */
  readonly arenas: Arenas;
  readonly bosses: Bosses;
  /** Who was last in combat (damage dealt or taken): leaving a boss arena, enemies' recovery */
  readonly combat = new CombatClock();
  /** Boss arenas' barriers: passing them (game/arenas/ArenaGates.ts) */
  readonly arenaGates: ArenaGates;
  /** Every enemy heals out of combat (game/enemies/recovery.ts) */
  readonly recovery: EnemyRecovery;
  /** (dev) The boss tools: dev servers and admins only (game/dev/bossDev.ts) */
  readonly bossDev: BossDev<ClientConnection>;
  /** Boss dens' features: the Kiln's vents and cache (game/dens, systems.json `den`) */
  readonly dens: Dens;
  /** Single-body enemies (data/mobs.json): what boss bays launch */
  readonly mobs: Mobs;
  readonly events: Events;
  readonly admin: AdminTools;
  /** Contributor notes and the contributor rank */
  readonly contrib: ContributorNotes<ClientConnection>;
  /** Chat with an admin on the website (the lobby link is adminChatLink.ts, started by index.ts) */
  readonly adminChat: AdminChat<ClientConnection>;
  readonly surfaces: Surfaces;
  readonly sieges: Sieges;
  readonly hangar: Hangar;
  readonly party: Party;
  /** Who's been mending whom (Repair Beams): support counts towards kills' and bosses' rewards (the support feature's ledger: ships/features/support/Support.ts) */
  support!: Support;
  readonly trade: Trade;
  readonly ops: Operations;
  readonly market: Market;
  readonly replication: Replication;
  /** Pilotless ships far from every pilot go distant: out of the pipeline, flown by routes worked out by time (ships/SimLod.ts) */
  readonly lod: SimLod;
  /** A system nobody's in is put away whole and brought back as it was, through restarts too (game/SystemMemory.ts) */
  readonly memory: SystemMemory;
  readonly achievements: Achievements;
  /** Friends, status and private messages (game/social/Social.ts) */
  readonly social: Social;
  /** Pilotless ships players protect (escorted freighters, outposts): their names */
  wards = new Map<number, string>();
  /** People's ships, parked where they live (people.json craft): untouchable, by name. The same Map as derelictsMod.personCraft */
  personCraft!: Map<number, string>;
  readonly clock: () => number;
  /** Disconnected mid-fight: the ship stays in space until this tick */
  lingering = new Map<number, { conn: ClientConnection; until: number }>();

  /** Outgoing messages: outboxes, lazy effects, broadcasts, byte counters (net/snapshot/Outbox.ts) */
  readonly net: Outbox;
  /** Confirmed hits: what clients are told of shells' hits on ships instead (net/hits/HitLedger.ts) */
  readonly hits: HitLedger;
  /** Pilots' own ships on their clients' tick-aligned layer: the checks they send of them (CAPS.OWN_SIM, net/own/OwnChecks.ts) */
  readonly ownChecks: OwnChecks;
  /** Bosses' decisions, for the clients that run their bodies, and those clients' checks (CAPS.BODIES, net/decisions/BodyNet.ts) */
  readonly bodies: BodyNet;
  /** Homing shells for the clients that run them on their tick layers (CAPS.WAYPOINTS, net/guides/GuideNet.ts) */
  readonly guides: GuideNet;
  /** Other ships' guns stepped on clients' tick layers from their controls (net/guns/GunNet.ts) */
  readonly gunNet: GunNet;
  /** The snapshot path: rows, snapshots, ship structure, map dots, entering a system (net/SnapshotBuilder.ts) */
  readonly snapshots: SnapshotBuilder;
  /** Crowd fallbacks (net/crowd/CrowdControl.ts; the crowd option): each system's level, from its measured cost */
  readonly crowd: CrowdControl | null;
  /** Systems' own clocks (crowd dilation: sim/SystemClocks.ts) */
  readonly clocks: SystemClocks | null;

  // Admin server for dev tools
  
  // User database for auth
  userDB: UserStore;
  
  // Error tracking for admin stats
  recentErrors: string[] = [];
  tickTimeHistory: number[] = [];
  totalConnectionsEver = 0;
  
  // Scheduled game loop callback (setTimeout or setImmediate handle)
  gameLoopTimer: unknown = null;

  constructor(opts: GameServerOptions) {
    this.payout = new PayoutDice(opts.payoutSecret);
    this.world = createWorld();
    this.net = new Outbox(this);
    this.hits = new HitLedger(this);
    this.ownChecks = new OwnChecks(ownChecksDeps(this));
    this.bodies = new BodyNet(bodiesDeps(this));
    // (what flies by the waypoint law: homing shells and mobs)
    this.guides = new GuideNet({ tick: () => this.currentTick, sources: () => [this.weapons, this.mobs], systemOf: (eid) => InSystem.systemId[eid] });
    this.gameData = opts.gameData;
    this.userDB = opts.userDB;
    this.scene = opts.scene ?? 'sectors';
    this.everyoneAdmin = opts.everyoneAdmin ?? false;
    // (never on a production server, whatever it was started with)
    this.guestAdmin = !!opts.guestAdmin && process.env.NODE_ENV !== 'production';
    this.freeBuildAllowed = !!opts.freeBuild && process.env.NODE_ENV !== 'production';
    if (opts.devStart && process.env.NODE_ENV !== 'production' && this.gameData.getSystem(opts.devStart)) this.devStartNum = this.gameData.getSystemNum(opts.devStart);
    this.ships = opts.ships;
    this.ships.attach(createShipHost(this));
    this.shipEditAnywhere = opts.shipEditAnywhere ?? false;
    this.econ = new Economy(this.gameData.itemsFile, this.gameData.recipesFile, this.ships.catalog, Object.fromEntries(this.ships.library));
    this.pods = new LootPods(createPodHost(this), this.econ.items);
    // ---- Part features (ships/features: the Tow Beam; the tick, cargo, wire and message seams)
    this.features = new ServerFeatures(SERVER_FEATURES, featuresDeps(this), new Set(this.handlers.keys()));
    joinFeatureMessages(this);
    this.support = this.features.get('support') as unknown as Support;
    // ---- (end part features)
    this.mining = new Mining(createMiningHost(this), this.gameData.miningTable, this.payout);
    this.weapons = new Weapons(weaponsDeps(this), this.ships, this.ships.tuning);
    const factions = withNests(withZoneSpots(this.gameData.factionsFile as FactionsFile, (id) => this.gameData.getSystem(id)), (id) => this.gameData.getSystem(id));
    // (The drop tables they roll: data/loot.json)
    factions.lootTables = this.gameData.lootFile.tables;
    this.enemies = new Enemies(createEnemyHost(this), this.ships, factions, this.ships.enemyDesigns, this.payout);
    this.enemies.econ = this.econ;
    const profileStore = opts.profileStore ?? new MemoryProfileStore();
    this.pilots = new Pilots(createPilotHost(this), this.econ, this.ships, profileStore, pilotsOpts(this, opts));
    this.pilots.telemetry = new Telemetry(opts.telemetry ?? null, opts.clock);
    this.tutorial = setupTutorial(this, opts);
    // (The field machines tell the bank which parts they hold, and a death empties them into the wreck)
    const field = this.features.get('machines') as unknown as FieldShips | undefined;
    if (field) field.hooks = { planned: (eid, n) => this.tutorial?.fieldPlanned(eid, n), built: (eid, fn) => this.tutorial?.fieldBuilt(eid, fn) };
    if (field) this.pilots.fieldHooks = { isClaimed: (eid, uid) => field.isClaimed(eid, uid), machineContents: (eid) => field.machineContents(eid, true) };
    this.market = new Market(marketDeps(this, opts, stationAtConn(this)), this.econ, this.pilots, this.gameData.questsFile.reputations);
    this.services = new StationServices(servicesDeps(this, opts), this.pilots, this.econ, this.market, this.payout);
    this.ammo = new Ammo(this.pilots, this.ships.tuning, this.ships.catalog);
    this.ammo.hangar = (conn) => this.hangar?.send(conn);
    this.hazards = new Hazards(hazardsDeps(this), this.ships, this.gameData.hazardRules);
    // Cold building up on pilots' ships, and heat bringing them back (game/Warmth.ts)
    this.warmth = new Warmth(warmthDeps(this), this.ships, this.gameData.hazardRules);
    this.services.gems = this.gameData.gemsFile;
    this.homes = new HomeStations(homesDeps(this), this.pilots);
    if (this.gameData.stationFile) this.outpost = new Outpost({
      now: () => this.clock(),
      stationAt: (conn) => this.services.stationAt(conn),
      stationName: (id) => this.gameData.getStation(id)?.name ?? id,
    }, this.pilots, this.gameData.stationFile);
    this.hangar = new Hangar({ send: (conn, msg) => this.send((conn as ClientConnection).ws, msg), now: opts.clock ?? (() => Date.now()), freeBuild: (conn) => this.freeBuild(conn as ClientConnection), placed: (conn, parts) => this.tutorial?.partsPlaced(conn as ClientConnection, parts) },
      this.pilots, this.ships, this.econ, this.ships.catalog, this.services);
    this.hangar.gems = this.gameData.gemsFile;
    installHangarLogin(this);
    this.clock = opts.clock ?? (() => Date.now());
    this.quests = new Quests(createQuestHost(this), this.pilots, this.gameData.questsFile);
    this.docking = new Docking(dockingDeps(this));
    this.dockedShips = this.docking.dockedShips;
    this.bosses = new Bosses(this.createBossHost(), this.enemies, this.ships, this.gameData.bossesFile as BossesFile, this.ships.enemyDesigns, this.payout);
    this.mobs = new Mobs(createMobHost(this), this.gameData.mobsFile as MobsFile);
    this.bosses.mobs = this.mobs;
    this.arenaGates = new ArenaGates(arenaGatesDeps(this));
    this.bosses.gates = this.arenaGates;
    this.recovery = new EnemyRecovery(recoveryDeps(this));
    this.bossDev = new BossDev<ClientConnection>(bossDevDeps(this));
    const bossHost = this.createBossHost();
    this.dens = new Dens(densDeps(this, bossHost));
    this.enemies.mobs = this.mobs;
    this.events = new Events(createEventHost(this), this.enemies, this.gameData.factionsFile as FactionsFile, this.gameData.rulesFile.events, this.gameData.stringsFile, this.payout);
    this.party = new Party(createPartyHost(this));
    this.admin = new AdminTools(createAdminHost(this));
    installTutorialAdmin(this);
    this.contrib = new ContributorNotes<ClientConnection>(contribDeps(this), opts.contributorStore ?? null, opts.clock);
    this.adminChat = new AdminChat<ClientConnection>(adminChatDeps(this));
    this.surfaces = new Surfaces(createSurfaceHost(this), this.gameData.rulesFile.surfaces, this.gameData.stringsFile);
    this.sieges = new Sieges(createSiegeHost(this), this.gameData.rulesFile.sieges, this.gameData.stringsFile);
    this.surfaces.partyEntry = (conn, surface) => this.sieges.enter(conn, surface);
    this.people = new People(createPeopleHost(this), this.pilots, this.quests, this.gameData.peopleFile, this.gameData.stringsFile);
    this.quests.people = this.people;
    this.codex = new Codex(codexDeps(this), this.pilots, this.gameData.codexFile, this.gameData.itemsFile.items, this.gameData.stringsFile);
    this.quests.codex = this.codex;
    this.people.codex = this.codex;
    this.arenas = new Arenas(createArenaHost(this));
    this.achievements = new Achievements(achievementsDeps(this), this.pilots, this.gameData.achievementsFile as RibbonsFile, profileStore, opts.rankings, opts.serverName);
    this.social = new Social(socialDeps(this), profileStore, opts.friends ?? new MemoryFriends());
    installSocialLogin(this);
    this.replication = new Replication(replicationDeps(this), this.ships);
    this.lod = new SimLod(lodDeps(this), this.ships);
    // (A distant pack sent somewhere new is flown there from where its route has it)
    this.enemies.onOrders = (eid) => this.lod.replan(eid);
    this.memory = new SystemMemory(createMemoryHost(this), this.gameData.rulesFile.memory, opts.worldStore);
    // (A population's hurt ships mend while they're ghosts as a system's do while it's put away)
    this.enemies.mendPerMinute = this.memory.rules.healPerMinute;
    this.derelictsMod = new Derelicts(derelictsDeps(this));
    this.derelicts = this.derelictsMod.derelicts;
    this.personCraft = this.derelictsMod.personCraft;
    if (this.scene === 'sectors') this.memory.load();
    this.trade = new Trade(tradeDeps(this), this.pilots);
    this.ops = new Operations(createOpsHost(this), this.quests, () => [...this.clients.values()].filter((c) => this.flying(c.playerId) || hasComponent(this.world, Player, c.playerId)), this.gameData.rulesFile.operations, this.gameData.stringsFile);
this.devTeleport = opts.devTeleport ?? false;
    this.gunRange = setupGunRange(this);
    
    // Crowd fallbacks (net/crowd/CrowdControl.ts), where the server runs them
    this.crowd = opts.crowd ? new CrowdControl(crowdDeps(this)) : null;
    // Each system's own clock once it's dilated (sim/SystemClocks.ts): with crowd fallbacks only
    this.clocks = this.crowd ? new SystemClocks(clocksDeps(this)) : null;

    // (Other ships' gun lanes: stepped as the clients holding them step them, net/guns/GunNet.ts)
    this.gunNet = new GunNet({ tick: () => this.currentTick, ships: () => this.ships, env: (eid) => this.replicaEnv(InSystem.systemId[eid]) });
    // The snapshot path (net/SnapshotBuilder.ts): built once, after every module it reads
    this.snapshots = new SnapshotBuilder(snapshotDeps(this), this);

    // Initialize world (the empty scene has no stations, NPCs, portals or asteroids)
    if (this.scene === 'sectors') {
      initializeWorld(this);
    } else {
      // The client treats playerId 0 as "no player", so never hand out entity 0
      addEntity(this.world);
    }

    // Track errors for admin stats
    trackErrors(this);

    // Clean up expired sessions periodically
    setInterval(() => this.userDB.cleanupExpiredSessions(), 60 * 60 * 1000);

    // Start game loop
    if (opts.autoStart ?? true) {
      // (Every belt filed a slice at a time from here, between the first ticks: a server started by hand, a test's, files each system's on first use)
      fileBeltsLater(this);
      this.lastTickTime = performance.now();
      this.gameLoop();
    }
  }

  step(): void { step(this); }

  snapshotRound(): void { snapshotRound(this); }

  ownPasses(): void { ownPasses(this); }

  /** Pause the real-time loop (hangar editor). Messages are still accepted. */
  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  isPaused(): boolean {
    return this.paused;
  }

  getTick(): number {
    return this.currentTick;
  }

  getWorld(): IWorld {
    return this.world;
  }

  /** Modular ships bridge. */
  getShips(): ShipBridge {
    return this.ships;
  }

  /** Player entity id for a connected socket, or 0. */
  getPlayerId(socket: ClientSocket): number {
    return this.clients.get(socket)?.playerId ?? 0;
  }

  /** The engine services modular ships use (entities, base shot, damage events). */
  /** What a brand-new pilot starts with */
  starterKit(): StarterKit {
    return starterKit(this.ships.playerBlueprint);
  }

  /** Systems someone is in, as of the last lodObservers */
  lodOccupied = new Set<number>();

  /** Is this entity a live player ship */
  flying(eid: number): boolean {
    return eid >= 0 && hasComponent(this.world, Player, eid) && !hasComponent(this.world, Dead, eid);
  }

  /** The connection flying this entity (not one that's lingering after quitting) */
  liveConn(eid: number): ClientConnection | undefined {
    for (const c of this.clients.values()) if (c.playerId === eid) return c;
    return undefined;
  }

  moveFx(num: number, eid: number, origin: MoveOrigin, msg: ServerMessage): void { moveFx(this, num, eid, origin, msg); }

  moveShot(owner: number, kind: string, x: number, y: number, angle: number, scale: number, speed: number | undefined, seed: string, origin: MoveOrigin): void { moveShot(this, owner, kind, x, y, angle, scale, speed, seed, origin); }

  private createBossHost() { return createBossHost(this); }

  mineBeam(eid: number, x: number, y: number, angle: number, range: number, damage: number, material: string, gas = false, full = range): number { return mineBeam(this, eid, x, y, angle, range, damage, material, gas, full); }

  isGas(asteroid: number): boolean { return isGas(this, asteroid); }

  cometWas = false;

  beamAsteroid(eid: number, x: number, y: number, angle: number, range: number, damage: number, kind: string): number { return beamAsteroid(this, eid, x, y, angle, range, damage, kind); }

  canHeal(healer: number, target: number): boolean { return canHeal(this, healer, target); }

  placePlayer(conn: ClientConnection, systemNum: number, x: number, y: number): void { placePlayer(this, conn, systemNum, x, y); }

  enter(conn: ClientConnection): void { enter(this, conn); }

  async loginPilot(conn: ClientConnection, userId: number): Promise<void> { return loginPilot(this, conn, userId); }

  async resumeGuest(conn: ClientConnection): Promise<void> { return resumeGuest(this, conn); }

  canDamage(attacker: number, target: number): boolean { return canDamage(this, attacker, target); }

  sideOf(eid: number): number { return sideOf(this, eid); }

  inPvpZone(eid: number): boolean { return inPvpZone(this, eid); }

  /** Accounts already dealt with (the lobby repeats the list on every heartbeat) */
  forgotten = new Set<number>();

  async forgetAccounts(ids: number[]): Promise<void> { return forgetAccounts(this, ids); }

  async saveAll(): Promise<void> { return saveAll(this); }

  hunted(): { id: string; name: string; system: string } | null { return hunted(this); }

  asteroidSpawnData(eid: number) { return asteroidSpawnData(this, eid); }

  connect(ws: ClientSocket, address?: string): ClientLink { return connect(this, ws, address); }

  createPlayer(): number { return createPlayer(this); }

  /** Per-connection rate limits for expensive or broadcast messages (net/MessageLimits.ts) */
  readonly limiter = new MessageLimiter();
  /** Client message handlers by type (built once; see buildMessageHandlers and net/dispatch.ts) */
  readonly handlers: HandlerTable = this.buildMessageHandlers();

  private buildMessageHandlers(): HandlerTable { return buildMessageHandlers(this); }

  /** Test hook: every client message type handled (golden/clientMessages.json pins them) */
  handledMessageTypes(): string[] {
    return [...this.handlers.keys()];
  }

  handleMessage(conn: ClientConnection, msg: ClientMessage): void { handleMessage(this, conn, msg); }

  /** The station this player is close enough to dock at, or -1 (game/Docking.ts) */
  stationInRange(eid: number): number {
    return this.docking.stationInRange(eid);
  }

  /** Is this player close enough to a station to use its shipyard? */
  isDocked(eid: number): boolean {
    return this.docking.isDocked(eid);
  }

  /** A wrong password, a refused registration, a replaced or deleted session: say why, then hang up (net/auth.ts) */
  rejectAuth(conn: ClientConnection, error: string | undefined): void {
    rejectAuth(this, conn, error);
  }

  /**
   * Refits that take no parts and need no licence: proto mode (everyone's an
   * admin, editing anywhere), or an admin who switched on free build where the
   * server allows it (dev only: freeBuildAllowed is never set in production)
   */
  freeBuild(conn: ClientConnection): boolean {
    return (this.everyoneAdmin && this.shipEditAnywhere) || (this.freeBuildAllowed && this.admin.freeBuild(conn));
  }

  handleInput(conn: ClientConnection, msg: any): void { handleInput(this, conn, msg); }

  applyInputToEntity(conn: ClientConnection, msg: any): void { applyInputToEntity(this, conn, msg); }

  travelTo(conn: ClientConnection, systemNum: number, x: number, y: number, keepMomentum: boolean): void { travelTo(this, conn, systemNum, x, y, keepMomentum); }

  gameLoop(): void { gameLoop(this); }
  
  drainInputQueue(): void { drainInputQueue(this); }

  releaseControls(eid: number): void { releaseControls(this, eid); }

  // ---- Crash isolation (server robustness audit, docs/audits/server-robustness.md) ----
  /** Errors by where they happened: how many, and when it was last logged */
  faults = new Map<string, { count: number; unlogged: number; loggedAt: number }>();
  /** The tick's guarded systems, in order (built once; see buildTickSystems and tickOrder.ts) */
  readonly tickSystems: readonly TickSystem[] = this.buildTickSystems();

  /**
   * Run one part of the tick (or one message, or one client's share of it): if it
   * throws, it's logged and counted and the rest of the tick still runs, so one
   * bad entity can't stop the world. The first error is logged whole, then at most
   * one line every 10 s per place, with how many there were since.
   */
  guard(where: string, fn: () => void): void {
    try {
      fn();
    } catch (e) {
      this.fault(where, e);
    }
  }

  fault(where: string, e: unknown): void { fault(this, where, e); }

  faultCounts(): Record<string, number> { return faultCounts(this); }
  // ---- end crash isolation ----

  private buildTickSystems(): readonly TickSystem[] { return buildTickSystems(this); }

  /** Test hook: the tick table's entries, in order (tickOrder.test.ts) */
  tickSystemList(): { name: string; phase: string; every?: number; scene?: string; perClient?: boolean }[] {
    return this.tickSystems.map((s) => ({ name: s.name, phase: s.phase, every: s.every, scene: s.scene, perClient: s.perClient }));
  }

  tick(own = false): void { tick(this, own); }
  
  

  placeAsteroid(eid: number): void { placeAsteroid(this, eid); }

  /**
   * Where each shot flying straight meets rock, in a place whose rock never changes (surface `fixedWalls`): worked out
   * once, along the whole of its flight, as it's first seen; `steady` false once its course changes (missiles turn and
   * speed up: they ask of each step instead). Elsewhere every shot asks of each step.
   */
  shotWalls = new Map<number, { born: number; steady: boolean; vx: number; vy: number; wx: number; wy: number }>();

  shotWall(proj: number, systemId: number, px: number, py: number, vx: number, vy: number): number { return shotWall(this, proj, systemId, px, py, vx, vy); }

  /** Shots stuck in rock (mining charges): the rock and where on it, until they blow */
  stuckShots = new Map<number, { asteroid: number; ox: number; oy: number }>();

  hurtAsteroid(proj: number, hitAsteroid: number, ownerId: number, damage: number, hitX: number, hitY: number, stuck = false): void { hurtAsteroid(this, proj, hitAsteroid, ownerId, damage, hitX, hitY, stuck); }

  getTrafficShips(): { eid: number; route: string[]; leg: number }[] { return getTrafficShips(this); }

  stationEntity(stationId: string, systemNum: number): number { return stationEntity(this, stationId, systemNum); }

  /** What each system's (and siege moon's) hostiles are rated, for the maps and the HUD (worked out once: the data doesn't change) */
  threatCache: Record<string, number> | null = null;
  regionThreatCache: Record<string, Record<string, number>> | null = null;
  threats(): Record<string, number> { return threats(this); }

  regionThreats(): Record<string, Record<string, number>> { return regionThreats(this); }

  deathCause(player: number): Record<string, unknown> { return deathCause(this, player); }

  namedBody(eid: number): { name: string; kind: number } | undefined { return namedBody(this, eid); }

  /**
   * Outgoing messages (net/snapshot/Outbox.ts): each client's outbox, the effects that can wait (lazy), the byte
   * counters and the broadcasts. These forward to it, so modules' hosts and tests call them as before.
   */
  send(ws: ClientSocket, msg: ServerMessage): void {
    this.net.send(ws, msg);
  }

  /** Send everything waiting: one frame per client (net/snapshot/Outbox.ts) */
  flushOutbox(): void {
    this.net.flushOutbox();
  }

  /** Send the effects still waiting now (tests that look at a tick's messages straight after it) */
  flushLazy(): void {
    this.net.flushLazy();
  }

  broadcastToSystem(systemId: number, msg: ServerMessage): void {
    this.net.broadcastToSystem(systemId, msg);
  }

  private broadcastProjectileHit(proj: number, x: number, y: number): void {
    this.net.broadcastProjectileHit(proj, x, y);
  }

  /** A snapshot to every client, then the map's dots (net/SnapshotBuilder.ts; netBench and tests wrap this name) */
  sendSnapshots(skip: RoundSkip | null = null): void {
    // (The damage summed since the last one is handed on: each client gets its share after its hit records, HitLedger.write)
    this.net.flushDamage();
    // (Its hits are dropped even if the snapshot fails part way: never told twice. `skip`: systems whose wider window
    // hasn't come round, crowd fallbacks: theirs wait)
    try { this.snapshots.sendSnapshots(skip); } finally { this.hits.endSnapshot(skip); }
  }

  /** Clients in a system near a point (net/snapshot/Outbox.ts) */
  broadcastNear(systemId: number, x: number, y: number, msg: ServerMessage, also?: number[]): void {
    this.net.broadcastNear(systemId, x, y, msg, also);
  }

  /** HUD numbers and the system visuals (net/SnapshotBuilder.ts) */
  sendPlayerState(conn: ClientConnection): void {
    this.snapshots.sendPlayerState(conn);
  }

  /** A system's rock (a surface's terrain), or undefined */
  terrainOf(num: number): Terrain | undefined {
    const id = this.gameData.getSystemByNum(num)?.id;
    return id ? this.gameData.terrain(id) : undefined;
  }

  /**
   * What replicas and the jump drive's fields need of a system (built once each:
   * none of it changes). The empty scene has no lodestones (systemInfo sends none), and no landmarks. The landmarks
   * (common world/landmarks.ts: a pilot's ship in a moving one's zone is carried with it) go to clients in systemInfo.
   */
  private landmarksOf(sys: { id: string; planets?: PlanetData[]; lodestones?: LodestoneData[] }): { landmarks?: Landmark[] } {
    const list = systemLandmarks(sys, this.gameData.getSystemStations(sys.id), jumpTuning(this.ships.tuning));
    return list.length ? { landmarks: list } : {};
  }

  replicaEnv(num: number): ReplicaEnv {
    let env = this.replicaEnvs.get(num);
    if (!env) {
      const sys = this.gameData.getSystemByNum(num);
      const cb = sys?.centralBody;
      this.replicaEnvs.set(num, (env = { gravity: cb?.gravity ?? null, central: cb ?? null, terrain: this.terrainOf(num) ?? null,
        ...(this.scene !== 'empty' && sys?.lodestones?.length ? { lodestones: sys.lodestones } : {}),
        ...(this.scene !== 'empty' && sys ? this.landmarksOf(sys) : {}),
        ...(sys?.hazardRatings ? { hazard: (d: ShipDerived, x: number, y: number) => hazardFlight(this.gameData.hazardRules, sys, d, x, y) } : {}) }));
    }
    return env;
  }

  
  
  
  
  
  /**
   * Get current player count (for server browser registration)
   */
  /**
   * How the game's running, for the box's resource monitor (index.ts writes it to data/status/live.json; deploy/vps/monitor
   * reads it): its ticks (the slowest since last asked), and what's in the world. Nothing about who's playing.
   */
  liveStatus(): { tickAvgMs: number; tickLastMs: number; tickMaxMs: number; players: number; ships: number; projectiles: number; entities: number } {
    const s = {
      tickAvgMs: +perfMetrics.avgTickMs.toFixed(3), tickLastMs: +perfMetrics.lastTickMs.toFixed(3), tickMaxMs: +perfMetrics.windowMaxMs.toFixed(3),
      players: this.getPlayerCount(), ships: this.ships.bodies.size, projectiles: projectileQuery(this.world).length, entities: getAllEntities(this.world).length,
    };
    perfMetrics.windowMaxMs = 0;
    return s;
  }

  getPlayerCount(): number {
    return this.clients.size;
  }
}
