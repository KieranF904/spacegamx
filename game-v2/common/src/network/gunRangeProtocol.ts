/**
 * @contract protocol.gun-range
 * owns:       the gun range's messages: going in from a station, picking the weapon, and the pilot's own range state
 * needs:      nothing (plain shapes)
 * invariants: every client-sent type here is one the server dispatches, and the set of dispatched types is pinned by
 *             name — server/src/golden/structure.test.ts
 * extend:     a new message is an interface plus a member of this area's client / server union below; then its handler
 *             (server/src/net/handlers/gunRange.ts) or its entry in client/src/app/serverMessages.ts, and the golden pins
 *
 * Leaving is no message of its own: the pilot flies to the door and presses interact (the `interact` message), which the
 * server takes as leaving only there (common gunRange/layout.ts atRangeDoor).
 */

// ============================================ client -> server

/** Go into the gun range (from the station you are docked at: the server checks you are). Your own ship is set aside, untouched */
export interface ClientGunRangeEnterMessage { type: 'gunRangeEnter' }

/** In the range: fly this weapon model (one of gunRangeState.options): the cheat ship is rebuilt carrying it */
export interface ClientGunRangeWeaponMessage { type: 'gunRangeWeapon'; model: string }

export type GunRangeClientMessage = ClientGunRangeEnterMessage | ClientGunRangeWeaponMessage;

// ============================================ server -> client

/**
 * This pilot's gun range state, to them alone: on going in, on each weapon change, when the target goes down or comes
 * back, and `in: false` once they are out (back docked at `station`, or refused going in: `error` says why).
 * `door` is where X takes you out (common atRangeDoor has the same rule; the chamber itself is systems.json `gunRange`),
 * `targets` each target in the def's order: its entity (-1 while it is down), its spot and its name. Dying in the range sends
 * no `in: false`: the respawn is back at the door (a state again).
 */
export interface ServerGunRangeStateMessage {
  type: 'gunRangeState';
  in: boolean;
  /** The weapon model the cheat ship carries */
  weapon?: string;
  /** Every weapon model this pilot may pick (common gunRangeOptions) */
  options?: string[];
  door?: { x: number; y: number; reach: number };
  targets?: { id: number; x: number; y: number; label: string }[];
  /** The station they came from and go back to (its name) */
  station?: string;
  /** Going in was refused: why */
  error?: string;
}

export type GunRangeServerMessage = ServerGunRangeStateMessage;
