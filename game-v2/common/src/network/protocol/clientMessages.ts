/**
 * @contract protocol.client
 * owns:       every client-to-server message type and the ClientMessage union
 * needs:      the per-feature *Protocol.ts client unions, ships/types (Blueprint), hits, ownTick
 * invariants: client message shapes and union order are the wire contract — golden clientMessages.json
 * extend:     a new client message is an interface here and one line in the ClientMessage union (or its own *Protocol.ts)
 */
import type { EconClientMessage } from '../econProtocol.js';
import type { SocialClientMessage } from '../socialProtocol.js';
import type { ClientContribMessage } from '../contributorProtocol.js';
import type { ClientBossDevMessage } from '../bossProtocol.js';
import type { FieldClientMessage } from '../fieldProtocol.js';
import type { WeaponGroupsClientMessage } from '../weaponGroupsProtocol.js';
import type { MinesClientMessage } from '../minesProtocol.js';
import type { ClampClientMessage } from '../clampProtocol.js';
import type { HitReport } from '../hits.js';
import type { OwnCheck } from '../ownTick.js';
import type { Blueprint } from '../../ships/types.js';
import type { ClientShipNeedMessage } from './shipProtocol.js';
// ============================================
// CLIENT -> SERVER MESSAGES
// ============================================

export interface ClientInputMessage {
  type: 'input';
  seq: number;
  tick: number;
  targetTick?: number; // Server tick when this input should be applied (input-delay buffer)
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
  boost: boolean;
  fireLeft: boolean;
  fireRight: boolean;
  targetAngle: number;
  /** Modular ships, helm controls: strafe relative to the ship (Q/E) */
  strafeLeft?: boolean;
  strafeRight?: boolean;
  /** Modular ships: helm controls (left/right turn the ship) instead of mouse-steer */
  helm?: boolean;
  /** Distance from the ship to the cursor, world units (turrets converge on the cursor point) */
  cursorDist?: number;
  /** Jump drive: true while spooling up (the client latches it from a J press) */
  jump?: boolean;
  /** Burst Strafer: held to dodge, the way the movement keys ask (ships/features/strafer) */
  dodge?: boolean;
  /** Debris it worked out (debrisSplit), each piece's id and 8-bit check (ships/debris.ts debrisHash): [id, hash, id, hash, ...] */
  acks?: number[];
  /** Client-detected hits (hits.ts CAPS.SELF_HITS): its hit chain's low byte as of a snapshot's tick (14 bits on the wire) */
  hitReport?: HitReport;
  /** Its own ship on its tick-aligned layer (hits.ts CAPS.OWN_SIM): a hash of its state as of a snapshot's tick (network/ownTick.ts) */
  ownCheck?: OwnCheck;
  /** The bosses' bodies it runs (CAPS.BODIES, common bodies/hash.ts): their hashes' sum's low byte as of a snapshot's tick (12 bits) */
  bodyCheck?: BodyCheck;
  /**
   * Weapon groups (ships/weaponGroups.ts packGroupSel): the group the left button fires (low nibble) and the right
   * button (high nibble), 0 = all. Sent only on the input whose tick it changes on (and the first after a join or a
   * respawn); absent: as it was. Rides both layouts (the base layout's type 0x04, the compact one's EXTRA GROUPS)
   */
  weaponGroups?: number;
}

/** A body check as it rides an input (CAPS.BODIES) */
export interface BodyCheck { hash: number; tick: number }

import { CURSOR_DIST_STEP, CURSOR_DIST_MAX, quantizeCursorDist } from '../cursorDist.js';
export { CURSOR_DIST_STEP, CURSOR_DIST_MAX, quantizeCursorDist };

export interface ClientPingMessage {
  type: 'ping';
  clientTime: number;
}

/** The system map opened or closed: while it's open the server sends the system's far ships (mapDots) */
export interface ClientMapViewMessage {
  type: 'mapView';
  open: boolean;
}

export interface ClientChatMessage {
  type: 'chat';
  text: string;
}

export interface ClientInteractMessage {
  type: 'interact';
  targetId?: number;  // Entity ID of NPC/station (optional - server finds nearest)
}

export interface ClientDropItemMessage {
  type: 'dropItem';
  inventorySlot: number;
  count: number;
}

export interface ClientPickupMessage {
  type: 'pickup';
  itemEntityId: number;
}

export interface ClientBuyMessage {
  type: 'buy';
  stationId: string;
  itemId: string;
  count: number;
}

export interface ClientSellMessage {
  type: 'sell';
  stationId: string;
  inventorySlot: number;
  count: number;
}

export interface ClientRepairMessage {
  type: 'repair';
  stationId: string;
}

export interface ClientRefuelMessage {
  type: 'refuel';
  stationId: string;
}


export interface ClientWarpMessage {
  type: 'warp';
  portalId: string;
}

export interface ClientRespawnMessage {
  type: 'respawn';
  /** Rally beside this party member instead of at home */
  rally?: string;
}

/** The tutorial's combat lesson: a training drone in front of you (inner Sol only, one at a time) */
export interface ClientTrainingDroneMessage {
  type: 'trainingDrone';
}

export interface ClientJoinMessage {
  type: 'join';
  token?: string;      // Auth session token (for registered users)
  username: string;    // Display name (for guests)
  /** The client's PROTOCOL_VERSION (absent: a client from before the handshake) */
  protocol?: number;
  /** What it can do beyond the base protocol (hits.ts CAPS): the server takes the bits it allows */
  caps?: number;
}

/**
 * Confirmed hits (hits.ts): the client's copy of these ships' part HP disagrees with an hpCheck, or it could not work
 * out a hit on them. The server sends every part's HP with the next snapshot.
 */
export interface ClientHpResyncMessage {
  type: 'hpResync';
  ids: number[];
}

/** Bit-packed frames (packed/packedCodec.ts): a packed message didn't decode, so the server starts afresh (a reset) */
export interface ClientPackedResyncMessage {
  type: 'packedResync';
}

export interface ClientAuthLoginMessage {
  type: 'authLogin';
  username: string;
  password: string;
}

export interface ClientAuthRegisterMessage {
  type: 'authRegister';
  username: string;
  email: string;
  password: string;
}

export interface ClientStateHashMessage {
  type: 'stateHash';
  tick: number;
  hash: number;
}

export type ClientMessage =
  | ClientInputMessage
  | ClientTrainingDroneMessage
  | ClientShipNeedMessage
  | ClientPingMessage
  | ClientMapViewMessage
  | ClientChatMessage
  | ClientInteractMessage
| ClientDropItemMessage
  | ClientPickupMessage
  | ClientBuyMessage
  | ClientSellMessage
  | ClientRepairMessage
  | ClientRefuelMessage
  | ClientWarpMessage
  | ClientRespawnMessage
  | ClientJoinMessage
  | ClientAuthLoginMessage
  | ClientAuthRegisterMessage
  | ClientStateHashMessage
  | ClientHpResyncMessage
  | ClientPackedResyncMessage
  | ClientShipEditMessage
  | ClientDockMessage
  | ClientUndockMessage
  | ClientTowMessage
  | ClientFeedSwitchMessage
  | ClientDevTeleportMessage
  | ClientDevSpawnMessage
  | ClientDevShipMessage
  | ClientDevBossMessage
  | ClientDevRangeMessage
  | ClientAdminMessage
  | ClientSiegeMessage
  | EconClientMessage
  | SocialClientMessage
  | ClientContribMessage
  | ClientBossDevMessage
  | FieldClientMessage
  | WeaponGroupsClientMessage
  | MinesClientMessage
  | ClampClientMessage;

/**
 * Dev tool (map click): jump to a system, optionally to a spot in it. Only
 * honoured on dev/proto servers or for admins.
 */
export interface ClientDevTeleportMessage {
  type: 'devTeleport';
  systemId: string;
  x?: number;
  y?: number;
}

/** Dev tool: a hostile pack of the system's own (or `ships` of `faction`) at a spot. Dev servers or admins only. */
export interface ClientDevSpawnMessage {
  type: 'devSpawn';
  x: number;
  y: number;
  faction?: string;
  ships?: string[];
}

/**
 * Dev tool: fly a ship from the plan library (data/ships/blueprints) right now, wherever you are, nothing
 * spent; without `ship`, your own ship back. It's never saved. Dev servers or admins only.
 */
export interface ClientDevShipMessage {
  type: 'devShip';
  ship?: string;
}

/**
 * Dev tool: the nearest boss in your system worn down to `wear` of its hull (into its later phases), or
 * with `reset`, taken away to come back fresh. Dev servers or admins only.
 */
export interface ClientDevBossMessage {
  type: 'devBoss';
  wear?: number;
  reset?: boolean;
  /** Its first this many shedding steps done at once (a boss that sheds: its stages, to look at) */
  shed?: number;
}

/**
 * Dev tool, the weapons range (WeaponsRange.ts; dev servers only, refused anywhere else): `go` to the range, `arm` the
 * test rig with one or two weapon models (`guns`), `ideal` ammo on or off, `moving` targets on or off, `reset` the dummies.
 */
export interface ClientDevRangeMessage {
  type: 'devRange';
  action: 'go' | 'arm' | 'ideal' | 'moving' | 'reset';
  guns?: string[];
  on?: boolean;
}

/**
 * A moon siege: by day ready up (or not), refit, buy from the shop, upgrade or scrap; any time give a pad's turret its
 * orders (`item`: its target priority); at night build on a pad you're near (dearer), or mark a hostile for every
 * turret in reach to focus on (`target`)
 */
export interface ClientSiegeMessage {
  type: 'siege';
  action: 'ready' | 'unready' | 'refit' | 'buy' | 'upgrade' | 'scrap' | 'claim' | 'orders' | 'focus';
  /** buy: the shop item; orders: the priority */
  item?: string;
  /** The turret pad: to build on (none: the first free one, by day), upgrade, scrap, or give orders */
  pad?: number;
  /** focus: the hostile */
  target?: number;
}

/** An admin command (server/src/game/AdminTools.ts lists them); refused for non-admins */
export interface ClientAdminMessage {
  type: 'admin';
  cmd: string;
  args?: Record<string, unknown>;
}

/** Hangar opening: berth at the station in range (the ship rides along with it until undock) */
export interface ClientDockMessage {
  type: 'dock';
}

export interface ClientUndockMessage {
  type: 'undock';
}

/**
 * Tow Beam (common/src/ships/features/tow/tow.ts): `on` takes hold of the wreck, debris or pod nearest the cursor within reach
 * (the input's aim and cursor distance say where), off lets go. The server answers with a toast and the snapshot
 */
export interface ClientTowMessage {
  type: 'tow';
  on: boolean;
}

/** A ports ship (common/src/ships/power/ports.ts): flip every Selector to its other feed (the old material runs out first) */
export interface ClientFeedSwitchMessage {
  type: 'feedSwitch';
}

/** Hangar: replace my ship with this blueprint (validated by the server; must be docked) */
export interface ClientShipEditMessage {
  type: 'shipEdit';
  blueprint: Blueprint;
}

