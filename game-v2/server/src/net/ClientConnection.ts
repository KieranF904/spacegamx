/**
 * One client's connection state (GameServer.connect builds it). Its own file so message handlers and modules can
 * import the type without importing GameServer.
 */
import type { ClientSocket, Blueprint, ShipState, Leg } from '@space-game/common';
import type { PackedLink } from './snapshot/PackedLink.js';
import type { FocusState } from './cells/FocusCells.js';
import type { AwayShips } from '@space-game/common';
import type { AwayShip } from './cells/AwayNet.js';

export interface ClientConnection {
  ws: ClientSocket;
  /** The player's address as the transport saw it (passed on to the lobby with a sign-in, for its attempt limits) */
  address?: string;
  playerId: number;  // Entity ID
  lastInputSeq: number;
  lastPingTime: number;
  ping: number;
  username: string;  // Player display name
  userId: number | null;  // DB user ID (null for guests)
  isAdmin: boolean;
  /** The owner rank (above admin: isAdmin is true for an owner too). Missing: not the owner */
  isOwner?: boolean;
  /** Contributor rank (ContributorNotes: the notes tools; admins have them anyway) */
  isContributor: boolean;
  authToken: string | null;
  knownEntities: Set<number>;   // Entity IDs already sent one-time to this client (asteroids, stations, portals, NPCs)
  lastSystemId: number;         // Last system ID — clear knownEntities on change
  /** Last system id for which systemInfo was sent (string id) */
  lastSystemInfoId: string | null;
  /** Per-player scheduled input buffer. Inputs held until targetTick <= currentTick. */
  scheduledInputs: Array<{ targetTick: number; msg: any }>;
  /** Sent `join` (nothing but join, ping and sign-in is handled before) */
  joined: boolean;
  /** Inputs queued this tick (a flood beyond MAX_INPUTS_PER_TICK is dropped) */
  inputsThisTick: number;
  /** The last tick its game loop was heard from (an input or a state hash) */
  liveTick: number;
  /** It sends state hashes (a real client's game loop): the input timeout applies */
  hashSeen: boolean;
  forceSnapshot: boolean;
  lastSnapshotSentTick: number;
  /** The ship this player built in the hangar (null = starter) */
  blueprint: Blueprint | null;
  /** Berthed at a station (hangar open): the ship rides along at this offset */
  /** Berthed in a station: held at its centre (ox, oy: 0), and put back out at `exit` (where it came in) when it leaves */
  docked: { station: number; ox: number; oy: number; exit?: { x: number; y: number } } | null;
  /**
   * Ship bodies this client has been synced to: entity id → the ship state and rebuild count sent, the snapshot its HP
   * was last brought up to date at (`hpAt`: skip it while the ship's HP hasn't changed since), and the tick a shipSync
   * last went (`at`: a client finding its own hits leaves a ship synced in that snapshot to the records, HitLedger);
   * `kept`: the rebuild counts whose structures it keeps by tick, oldest first (CAPS.STRUCTS: every one since went)
   */
  shipSynced: Map<number, { ship: ShipState; rebuilds: number; hpAt?: number; at?: number; kept?: number[]; dmg?: number }>;
  /** Last part HP sent to this client, per ship body */
  shipHpSent: Map<number, number[]>;
  /** Entity names this client has been sent (names go once) */
  sentNames: Map<number, string>;
  /** Ship keyframe versions this client has (replication) */
  repKnown: Map<number, number>;
  /**
   * Debris it was told to work out itself (debrisSplit) and hasn't confirmed: id → the tick it may wait till, and its
   * parts' HP as the client has them (SnapshotBuilder.holdDebris, ackDebris)
   */
  debrisHeld: Map<number, { until: number; hp: number[]; live?: boolean }>;
  /**
   * Debris it runs itself (CAPS.DEBRIS: confirmed, and told it's its to run, debrisSplit `l`): nothing of it is sent
   * but its removal, until it's told (DebrisNet.told: a shipSync then, and it's sent as any ship from there)
   */
  debrisLive?: Set<number>;
  /** Debris it confirmed: the status row it made itself counts as sent at the next snapshot */
  debrisRowOk: Set<number>;
  /** Ships in this client's view (the rest of the system's ships cost it nothing) */
  shipView: Set<number>;
  /** Ships out of view it's been told the names of, for the map (mapDots) */
  mapNamed: Set<number>;
  /** The map's dots as it has them (each one's leg as sent, from when; its route's leg count; its look), and whether the next list is a fresh one */
  mapSent?: Map<number, { leg: Leg; tick: number; seq: number; look: number }>;
  mapFresh?: boolean;
  /** Its system map is open (mapView), and it's owed a list now (just opened) */
  mapOpen?: boolean;
  mapDotsDue?: boolean;
  /** Owed every hostile population of its system (pops, full): a new system or connection */
  popsFresh?: boolean;
  /** State hashes the client sent for ticks we hadn't reached yet (it predicts ahead): tick → hash */
  aheadHashes: Map<number, number>;
  /** Ship designs (blueprint hashes) this client has been sent: another ship of one is sent by its hash */
  designs: Set<string>;
  /** The last HUD numbers sent (they only go when they change) */
  playerStateKey: string;
  /**
   * Its own ship: the client predicts it from its inputs, so it's only sent when
   * that prediction would be wrong (or as a slow safety net). An input applied
   * later than its target tick makes it wrong...
   */
  selfLate: boolean;
  /**
   * CAPS.OWN_SIM (network/ownTick.ts): the controls its last input applied says (what its client steps its own ship
   * with), and an input that wasn't applied on its target tick (late, or dropped by a flood guard): its client's own
   * ship is then off, and gets a keyframe (Replication)
   */
  ownCtl?: { bits: number; q: number };
  ownLate?: boolean;
  /** Its check found its own ship's state off (OwnChecks): an ownSync goes with the next snapshot (SnapshotBuilder) */
  ownSyncDue?: boolean;
  /** Its own shells (CAPS.SHOT_IDS) since the last snapshot it was sent: told, all of them, if that window's own ship was put right */
  ownWindow?: number[];
  /** ...as does anything that moves the ship besides its inputs (a new keyframe version), or a status change */
  selfVersion: number;
  selfKey: string;
  /**
   * Its own row went in the last snapshot only for its HP, not to correct its
   * prediction or tell it something its flight depends on: a client finding its own hits needn't have it at once
   * (PackedLink urgentFor)
   */
  selfRowQuiet?: boolean;
  /** ...the part of selfKey its flight depends on (all but its HP) */
  selfFlight?: string;
  /** Hash of its ship's state at each recent tick (the client checks its prediction against these) */
  selfHashes: Map<number, number>;
  /**
   * Its netcode's start (every client runs the full set, common network/hits.ts DEFAULT_CAPS): set at the end of its
   * first snapshot, when it's told netCaps (net/hits/HitLedger.ts endSnapshot). Its own hit finding runs from there
   */
  started?: boolean;
  /** Its bit-packed frames (net/snapshot/PackedLink.ts, made by Outbox once it has joined) */
  packed?: PackedLink;
  /** Its focus grid (CAPS.FOCUS: net/cells/FocusCells.ts): its focus cells and ring */
  focus?: FocusState;
  /** Ships out of its view that it keeps, and what it was last sent of each (CAPS.FOCUS: net/cells/AwayNet.ts) */
  away?: AwayShips<AwayShip>;
}
