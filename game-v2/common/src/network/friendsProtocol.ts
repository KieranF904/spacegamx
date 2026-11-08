/**
 * @contract protocol.friends
 * owns:       friends, presence status and private-message JSON messages (plain JSON: no protocol bump to add one)
 * needs:      nothing imported; handled by server/src/game/social/Social.ts
 * invariants: every client-sent type here is one the server dispatches, and the set of dispatched types is pinned by
 *             name — server/src/golden/structure.test.ts
 *             the server types the client handles itself are exactly the pinned set (a type with no entry in the
 *             client table fails) — client/src/app/serverMessages.test.ts
 * extend:     a new message is an interface plus a member of this area's client / server union below; then its
 *             handler (server/src/net/handlers) or its entry in client/src/app/serverMessages.ts, and the golden pins
 *             (UPDATE_GOLDEN=1 on structure.test.ts)
 */

/**
 * Messages for friends, your status and private messages (server/src/game/social/Social.ts).
 * Plain JSON messages (not in the wire tables): adding to them needs no protocol bump.
 */

/** What you set: Online, Away, Busy, or Appear offline ('invisible': friends see you offline) */
export type SocialStatus = 'online' | 'away' | 'busy' | 'invisible';
/** What others see of a pilot */
export type FriendPresence = 'online' | 'away' | 'busy' | 'offline';

export const SOCIAL_STATUSES: readonly { id: SocialStatus; label: string }[] = [
  { id: 'online', label: 'Online' },
  { id: 'away', label: 'Away' },
  { id: 'busy', label: 'Busy' },
  { id: 'invisible', label: 'Appear offline' },
];

export function isSocialStatus(v: unknown): v is SocialStatus {
  return v === 'online' || v === 'away' || v === 'busy' || v === 'invisible';
}

export interface FriendView { name: string; presence: FriendPresence }

/** Your friends list, requests and status (sent on join and whenever any of it changes) */
export interface ServerFriendsMessage {
  type: 'friends';
  status: SocialStatus;
  /** Signed in (guests have no friends list) */
  account: boolean;
  friends: FriendView[];
  /** Requests to you, waiting for an answer */
  incoming: string[];
  /** Requests you sent */
  outgoing: string[];
}

/** Someone asked to be your friend (the prompt) */
export interface ServerFriendRequestMessage { type: 'friendRequest'; from: string }

/** A private message: to you (from someone), or the copy of one you sent (out) */
export interface ServerWhisperMessage { type: 'whisper'; from: string; to: string; text: string; out?: boolean }

export interface ClientWhisperMessage { type: 'whisper'; to: string; text: string }
export interface ClientFriendRequestMessage { type: 'friendRequest'; name: string }
export interface ClientFriendRespondMessage { type: 'friendRespond'; name: string; accept: boolean }
/** Remove a friend, or take back a request you sent */
export interface ClientFriendRemoveMessage { type: 'friendRemove'; name: string }
export interface ClientSetStatusMessage { type: 'setStatus'; status: SocialStatus }

export type FriendsServerMessage = ServerFriendsMessage | ServerFriendRequestMessage | ServerWhisperMessage;
export type FriendsClientMessage = ClientWhisperMessage | ClientFriendRequestMessage | ClientFriendRespondMessage | ClientFriendRemoveMessage | ClientSetStatusMessage;
