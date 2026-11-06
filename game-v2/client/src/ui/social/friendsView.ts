/**
 * The friends list with no DOM: who goes in which group, what each presence reads as, and what a friend's
 * right-click menu offers. ui/social/FriendsPanel.ts draws it.
 */
import type { FriendPresence, FriendView, ServerFriendsMessage } from '@space-game/common';

export const PRESENCE: Record<FriendPresence, { label: string; color: string }> = {
  online: { label: 'Online', color: '#7dff9a' },
  away: { label: 'Away', color: '#ffbe55' },
  busy: { label: 'Busy', color: '#ff8a7a' },
  offline: { label: 'Offline', color: '#5b6b82' },
};

export function emptyFriends(): ServerFriendsMessage {
  return { type: 'friends', status: 'online', account: false, friends: [], incoming: [], outgoing: [] };
}

/** Online (Away and Busy count as on) first, then offline; each by name */
export function groupFriends(list: readonly FriendView[]): { online: FriendView[]; offline: FriendView[] } {
  const by = (a: FriendView, b: FriendView) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  return {
    online: list.filter((f) => f.presence !== 'offline').sort(by),
    offline: list.filter((f) => f.presence === 'offline').sort(by),
  };
}

export function onlineCount(m: ServerFriendsMessage): number {
  return m.friends.filter((f) => f.presence !== 'offline').length;
}

export type FriendAction = 'message' | 'invite' | 'remove';

/** A friend's right-click menu: message and invite only while they show online; inviting needs room to lead */
export function friendMenu(f: FriendView, o: { inParty: (name: string) => boolean; canInvite: boolean }): { id: FriendAction; label: string; bad?: boolean }[] {
  const out: { id: FriendAction; label: string; bad?: boolean }[] = [];
  if (f.presence !== 'offline') {
    out.push({ id: 'message', label: 'Message' });
    if (o.canInvite && !o.inParty(f.name)) out.push({ id: 'invite', label: 'Invite to party' });
  }
  out.push({ id: 'remove', label: 'Remove friend', bad: true });
  return out;
}
