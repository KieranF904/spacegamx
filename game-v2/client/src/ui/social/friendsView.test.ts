import { describe, it, expect } from 'vitest';
import { groupFriends, friendMenu, onlineCount, emptyFriends } from './friendsView';

describe('friends view', () => {
  it('groups online (Away and Busy too) before offline, each by name', () => {
    const g = groupFriends([
      { name: 'zed', presence: 'online' }, { name: 'Amy', presence: 'offline' }, { name: 'bo', presence: 'busy' },
      { name: 'Cy', presence: 'away' }, { name: 'al', presence: 'offline' },
    ]);
    expect(g.online.map((f) => f.name)).toEqual(['bo', 'Cy', 'zed']);
    expect(g.offline.map((f) => f.name)).toEqual(['al', 'Amy']);
    expect(onlineCount({ ...emptyFriends(), friends: [...g.online, ...g.offline] })).toBe(3);
  });

  it("a friend's menu: message and invite while on, invite only with room to lead, remove always", () => {
    const opts = { inParty: (n: string) => n === 'Bo', canInvite: true };
    expect(friendMenu({ name: 'Al', presence: 'online' }, opts).map((i) => i.id)).toEqual(['message', 'invite', 'remove']);
    expect(friendMenu({ name: 'Al', presence: 'busy' }, opts).map((i) => i.id)).toEqual(['message', 'invite', 'remove']);
    expect(friendMenu({ name: 'Bo', presence: 'online' }, opts).map((i) => i.id)).toEqual(['message', 'remove']);
    expect(friendMenu({ name: 'Al', presence: 'online' }, { ...opts, canInvite: false }).map((i) => i.id)).toEqual(['message', 'remove']);
    expect(friendMenu({ name: 'Al', presence: 'offline' }, opts).map((i) => i.id)).toEqual(['remove']);
    expect(friendMenu({ name: 'Al', presence: 'online' }, opts).find((i) => i.id === 'invite')?.label).toBe('Invite to party');
  });
});
