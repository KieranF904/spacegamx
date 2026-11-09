/**
 * @contract protocol.combat
 * owns:       the combat lock told to a signed-in pilot: how long quitting would still leave their ship in space (JSON),
 *             and the lock's numbers (COMBAT_RULES), which the server enforces and the field guide quotes
 * needs:      nothing; re-exported through protocol.ts (ServerMessage)
 * invariants: the server types the client handles itself are exactly the pinned set — client/src/app/serverMessages.test.ts
 * extend:     a new message is an interface plus a member of CombatServerMessage; then its entry in
 *             client/src/app/serverMessages.ts and the golden pin (server/src/golden/serverMessages.json)
 */

/** Tunable: seconds a pilot stays locked after their last hit dealt or taken, and how long past that lock their ship lingers */
export const COMBAT_RULES = {
  lockSeconds: 15,
  lingerSeconds: 20,
  /** The HUD is re-told at most this often while a fight keeps renewing the lock */
  tellEverySeconds: 1,
};

/**
 * `combatLock`: the pilot is in combat (dealt or took damage lately), so quitting now leaves their ship in space for a
 * while (server gameServer/combatLock.ts). `left`: milliseconds until the lock ends if nothing else happens (0: free to
 * leave). Sent when it starts or ends and at most once a second while a fight keeps renewing it; the client counts down.
 */
export interface ServerCombatLockMessage {
  type: 'combatLock';
  left: number;
}

export type CombatServerMessage = ServerCombatLockMessage;
