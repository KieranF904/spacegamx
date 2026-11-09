/**
 * @contract protocol.update
 * owns:       the server-update notice: how long until the server restarts for an update
 * needs:      nothing
 * invariants: the server types the client handles itself are exactly the pinned set — client/src/app/serverMessages.test.ts
 *             every server type is pinned by name — server/src/golden/structure.test.ts
 * extend:     a new message is an interface plus a member of UpdateServerMessage, then its entry in client/src/app/serverMessages.ts and the golden pins
 */

/**
 * The server will restart for an update in `inMs` (sent to everyone when it is scheduled, at the 15 / 5 / 1 minute
 * marks and every 30 s after, so a pilot who joins later sees it); 0 says it was cancelled. The client counts down
 * on its own clock from the moment it arrives (no clocks compared).
 */
export interface ServerUpdateMessage { type: 'serverUpdate'; inMs: number }

export type UpdateServerMessage = ServerUpdateMessage;
