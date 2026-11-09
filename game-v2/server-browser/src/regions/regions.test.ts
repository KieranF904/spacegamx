import { describe, it, expect } from 'vitest';
import { parseDefs, loadDefs } from './defs.js';
import { mergeServers, filterByProtocol, latestVersion, askedProtocol, ASLEEP_NOTE } from './merge.js';
import { parseHeartbeat, type ServerEntry } from '../servers.js';

const defs = parseDefs({ servers: [
  { id: 'vps', name: 'Main', region: 'eu', host: 'brotherk3d.com', port: 443, kind: 'always-on', protocol: 66 },
  { id: 'fly-syd', name: 'Sydney', region: 'au', host: 'syd.example.net', port: 443, kind: 'on-demand', protocol: 66, build: 'abc' },
] }).defs;

const beat = (o: Partial<ServerEntry>): ServerEntry => ({ host: 'x', port: 1, name: 'n', region: 'r', maxPlayers: 32, players: 3, secure: true, version: '2.0.0', lastSeen: 0, ...o });

describe('server definitions', () => {
  it('parses good entries and skips bad ones without failing', () => {
    const r = parseDefs([{ id: 'a', host: 'h.com' }, { id: 'A B', host: 'h.com' }, { id: 'a', host: 'h.com' }, { id: 'c', host: 'bad host!' }, { id: 'd', host: 'h', kind: 'sleepy' }]);
    expect(r.defs.map((d) => d.id)).toEqual(['a']);
    expect(r.defs[0]).toMatchObject({ kind: 'always-on', port: 443, secure: true });
    expect(r.errors).toHaveLength(4);
  });

  it('none given or unreadable means no definitions', () => {
    const logs: string[] = [];
    expect(loadDefs('/no/such/dir', {} as never, (m) => logs.push(m))).toEqual([]);
    expect(loadDefs('/no/such/dir', { LOBBY_SERVERS_JSON: '{nope' } as never, (m) => logs.push(m))).toEqual([]);
    expect(loadDefs('/no/such/dir', { LOBBY_SERVERS_JSON: '[{"id":"a","host":"h.com"}]' } as never)).toHaveLength(1);
    expect(logs).toHaveLength(1);
  });
});

describe('merging defined and live servers', () => {
  it('lists a defined server with no heartbeat as asleep (on-demand) or offline (always-on)', () => {
    const list = mergeServers(defs, [], true);
    expect(list.map((s) => [s.id, s.status])).toEqual([['vps', 'offline'], ['fly-syd', 'asleep']]);
    expect(list[1].note).toBe(ASLEEP_NOTE);
    expect(list[1].players).toBe(0);
  });

  it('a heartbeat (matched by id, or by address) makes it online with the live numbers', () => {
    const list = mergeServers(defs, [beat({ id: 'fly-syd', host: '172.1.2.3', port: 3000, players: 7, protocol: 66, build: 'abc' }), beat({ host: 'brotherk3d.com', port: 443, players: 2 })], true);
    expect(list[0]).toMatchObject({ id: 'vps', status: 'online', players: 2 });
    expect(list[1]).toMatchObject({ id: 'fly-syd', status: 'online', players: 7, host: 'syd.example.net', port: 443 });
    expect(list).toHaveLength(2);
  });

  it('with no definitions the list is the heartbeats alone (one server, as before)', () => {
    const list = mergeServers([], [beat({ host: 'a' })], true);
    expect(list).toHaveLength(1);
    expect(list[0].status).toBe('online');
    expect(mergeServers([], [], true)).toEqual([]);
  });

  it('a live server that is not defined is still listed', () => {
    expect(mergeServers(defs, [beat({ host: 'stray', port: 9 })], true)).toHaveLength(3);
  });
});

describe('version filtering', () => {
  const all = mergeServers(defs, [beat({ id: 'vps', host: 'q', protocol: 67, build: 'new' }), beat({ host: 'old', port: 5, protocol: 66 }), beat({ host: 'legacy', port: 6 })], true);

  it('offers only servers on the asked protocol; unknown protocol is kept; none asked keeps all', () => {
    const r = filterByProtocol(all, 66);
    expect(r.servers.map((s) => s.host)).toEqual(['syd.example.net', 'old', 'legacy']);
    expect(r.hidden).toBe(1);
    expect(filterByProtocol(all, undefined).servers).toHaveLength(all.length);
  });

  it('the newest protocol known is what an older client is told to reload for', () => {
    expect(latestVersion(all)).toEqual({ protocol: 67, build: 'new' });
    expect(latestVersion(mergeServers([], [beat({})], true))).toBeNull();
  });

  it('reads the protocol from the query', () => {
    expect(askedProtocol('protocol=66')).toBe(66);
    expect(askedProtocol('protocol=abc')).toBeUndefined();
    expect(askedProtocol('')).toBeUndefined();
  });

  it('a heartbeat carries id, protocol and build through the parser', () => {
    const b = parseHeartbeat({ host: 'h', serverId: 'fly-syd', protocol: 66, build: 'abc' }, '1.1.1.1');
    expect(b).toMatchObject({ id: 'fly-syd', protocol: 66, build: 'abc' });
    expect(parseHeartbeat({ host: 'h', serverId: '../x', protocol: -4 }, '1.1.1.1')).not.toHaveProperty('id');
  });
});
