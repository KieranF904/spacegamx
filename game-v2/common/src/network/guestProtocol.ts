/**
 * @contract protocol.guest
 * owns:       the guest account's lifetime rules (kept 12 h after leaving, 3 days at most, 12 h of grace to register) and the
 *             messages that tell a guest how long they have and turn them into a registered account
 * needs:      nothing
 * invariants: the server types the client handles itself are exactly the pinned set — client/src/app/serverMessages.test.ts
 *             every client-sent type here is one the server dispatches, pinned by name — server/src/golden/structure.test.ts
 * extend:     a new message is an interface plus a member of this area's client / server union below; then its handler
 *             (server/src/net/handlers) or its entry in client/src/app/serverMessages.ts, and the golden pins
 */

/** A guest left for this long (wall ms) is wiped: kept only that long after their last visit */
export const GUEST_KEEP_MS = 12 * 60 * 60_000;
/** A guest account lasts this long from its creation, however busy it is */
export const GUEST_LIFE_MS = 3 * 24 * 60 * 60_000;
/** After GUEST_LIFE_MS it is kept this much longer, only to be registered (it can't be played as a guest any more) */
export const GUEST_GRACE_MS = 12 * 60 * 60_000;

/**
 * Sent to a guest as they join: how long they have. The client counts down on its own clock from the moment it arrives
 * (no clocks compared).
 *   state       active: playing as a guest; expired: the 3 days are up and the guest can't be played, only registered
 *   keepMs      how long the guest is kept after they leave (GUEST_KEEP_MS)
 *   expiresInMs active: until the 3 days end; expired: until the guest is wiped
 */
export interface ServerGuestStatusMessage { type: 'guestStatus'; state: 'active' | 'expired'; keepMs: number; expiresInMs: number }

/** The answer to convertGuest: success (the pilot is now the registered account's, and in game as it), or why not */
export interface ServerGuestConvertedMessage { type: 'guestConverted'; success: boolean; error?: string }

/**
 * Register the guest: `token` is the session of an account the lobby has just created (POST /auth/register: the lobby
 * checks the name, email and password). The guest's whole profile moves to that account, once, and only if the account has
 * no profile yet.
 */
export interface ClientConvertGuestMessage { type: 'convertGuest'; token: string }

export type GuestClientMessage = ClientConvertGuestMessage;
export type GuestServerMessage = ServerGuestStatusMessage | ServerGuestConvertedMessage;
