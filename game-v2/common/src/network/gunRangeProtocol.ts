/**
 * @contract protocol.gun-range
 * owns:       the gun range's messages: going in from a station, picking the weapon, an admin's pick of a library ship,
 *             and the pilot's own range state
 * needs:      nothing (plain shapes)
 * invariants: every client-sent type here is one the server dispatches, and the set of dispatched types is pinned by
 *             name — server/src/golden/structure.test.ts
 * extend:     a new message is an interface plus a member of this area's client / server union below; then its handler
 *             (server/src/net/handlers/gunRange.ts) or its entry in client/src/app/serverMessages.ts, and the golden pins
 *
 * Leaving is no message of its own, nor is going to another room: the pilot flies to a door and presses interact (the
 * `interact` message), which the server takes as going through the door they are at (common gunRange/layout.ts
 * rangeDoorAt): the exit back to their station, any other to the room it leads to.
 */

// ============================================ client -> server

/** Go into the gun range (from the station you are docked at: the server checks you are). Your own ship is set aside, untouched */
export interface ClientGunRangeEnterMessage { type: 'gunRangeEnter' }

/**
 * In the range: fly this weapon model (one of gunRangeState.options): the cheat ship is rebuilt carrying it.
 * `mods`: with these weapon modifier effects behind the gun (names out of gunRangeState.modOptions; absent: as they were)
 */
export interface ClientGunRangeWeaponMessage { type: 'gunRangeWeapon'; model: string; mods?: string[] }

/**
 * In the range, admins only (refused from anyone else): fly this design from the ship library (one of gunRangeState.ships,
 * by id) just as it is drawn, in place of the cheat ship. A gunRangeWeapon after it goes back to the cheat ship.
 */
export interface ClientGunRangeShipMessage { type: 'gunRangeShip'; ship: string }

export type GunRangeClientMessage = ClientGunRangeEnterMessage | ClientGunRangeWeaponMessage | ClientGunRangeShipMessage;

// ============================================ server -> client

/**
 * This pilot's gun range state, to them alone: on going in, on each weapon, ship or room change, when a target of their
 * room goes down or comes back, and `in: false` once they are out (back docked at `station`, or refused going in: `error`
 * says why). `door` is the exit of the room they are in (the room's doors and where each leads are systems.json
 * `gunRange.rooms`, common rangeDoorAt the rule for being at one), `targets` each target of that room in the def's order: its entity (-1
 * while it is down), its spot and its name. Dying in the range sends
 * no `in: false`: the respawn is back at the door (a state again).
 */
export interface ServerGunRangeStateMessage {
  type: 'gunRangeState';
  in: boolean;
  /** The weapon model the cheat ship carries */
  weapon?: string;
  /** Every weapon model this pilot may pick (common gunRangeOptions) */
  options?: string[];
  /** The weapon modifier effects chosen (kept from weapon to weapon; a gun fed by ammunition alone carries none of them) */
  mods?: string[];
  /** Every weapon modifier effect this pilot may pick (common gunRangeMods) */
  modOptions?: string[];
  /** The room they are in (its id: systems.json `gunRange.rooms`) */
  room?: string;
  /** Flying a library ship instead of the cheat ship: its id (admins only) */
  ship?: string;
  /** Admins only: the library ships they may fly here (nobody else is ever sent the list) */
  ships?: { id: string; name: string; group: string }[];
  door?: { x: number; y: number; reach: number };
  targets?: { id: number; x: number; y: number; label: string }[];
  /** The station they came from and go back to (its name) */
  station?: string;
  /** Going in was refused: why */
  error?: string;
}

export type GunRangeServerMessage = ServerGunRangeStateMessage;
