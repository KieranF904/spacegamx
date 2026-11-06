/**
 * Friends, status and private messages (game/social/Social.ts) through a real server, with MemoryFriends as the stand-in
 * lobby: requests, friends following the account to another server, the lobby being down, moving an old per-server
 * document, private routing, offline and Appear offline, rate limits, what friends see, and a party invite from the list.
 */
import { describe, it, expect, vi } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import type { ServerMessage } from '@space-game/common';
import { GameServer } from '../../GameServer.js';
import { GameData } from '../../data/GameData.js';
import { LocalTransport } from '../../net/LocalTransport.js';
import { readGameDataFiles } from '../../data/loadGameDataFromDisk.js';
import { loadShipConfigFromDisk } from '../../ships/loadShipConfig.js';
import { createShipBridge } from '../../proto/createProtoServer.js';
import { MemoryProfileStore } from '../../profile/ProfileStore.js';
import { SOCIAL_DOC, emptyDoc, touch, request, respond, unfriend, forget, parseDoc, findByName, MAX_PENDING } from './friendsDoc.js';
import { WHISPER_BURST, WHISPER_WINDOW, REQUEST_BURST, UNAVAILABLE, LIST_UNAVAILABLE, STATUS_UNSAVED } from './Social.js';
import { MemoryFriends } from './MemoryFriends.js';
import { migrateFriends } from './friendsMigration.js';
import { LobbyFriends } from './LobbyFriends.js';
import { FriendsUnavailable } from './FriendsBackend.js';

const dataDir = join(__dirname, '../../../../data');
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const files = readGameDataFiles(dataDir);
const shipConfig = loadShipConfigFromDisk(dataDir);

// (Each test builds one or two whole servers)
vi.setConfig({ testTimeout: 60_000 });

const ACCOUNTS = ['Ash', 'Bree', 'Cole', 'Dax'];

/** A server whose lobby signs in "tok:<name>" as that account (ids 1..) */
function world(store = new MemoryProfileStore(), clock = { t: 1_000_000 }, friends = new MemoryFriends()) {
  resetGlobals();
  const user = (t: string) => {
    const i = ACCOUNTS.findIndex((n) => n.toLowerCase() === t.split(':')[1]?.toLowerCase());
    return i < 0 ? null : { id: i + 1, username: ACCOUNTS[i], email: '', is_admin: false, created_at: '' };
  };
  const server = new GameServer({
    gameData: new GameData(files),
    userDB: { checkSession: async (t: string) => ({ user: user(t) }), validateSession: async (t: string) => user(t), cleanupExpiredSessions: async () => {}, admin: null } as any,
    scene: 'sectors', autoStart: false, ships: createShipBridge(shipConfig), profileStore: store, clock: () => clock.t, friends,
  });
  const flush = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0)); };
  const join = async (name: string, guest = false) => {
    const t = new LocalTransport(server);
    const got: ServerMessage[] = [];
    t.onMessage = (m) => got.push(m);
    t.connect();
    t.send({ type: 'join', username: name, ...(guest ? {} : { token: `tok:${name}` }) } as any);
    await flush();
    const conn = () => [...(server as any).clients.values()].find((c: any) => c.playerId === t.getPlayerId());
    const drain = () => conn()?.packed?.drain(server.getTick());
    const all = <T extends ServerMessage['type']>(type: T) => { drain(); return got.filter((m) => m.type === type) as Extract<ServerMessage, { type: T }>[]; };
    const last = <T extends ServerMessage['type']>(type: T) => all(type).at(-1);
    const send = async (m: object) => { t.send(m as any); await flush(); };
    const toasts = () => all('toast').map((m) => m.text);
    const notes = () => all('systemMessage').map((m) => m.text);
    return { t, got, conn, send, all, last, toasts, notes, close: async () => { t.disconnect(); await flush(); } };
  };
  return { server, join, flush, store, clock, friends };
}

const friendNames = (m: Extract<ServerMessage, { type: 'friends' }> | undefined) => m?.friends.map((f) => `${f.name}:${f.presence}`);

async function befriend(a: Awaited<ReturnType<ReturnType<typeof world>['join']>>, b: typeof a, bName: string, aName: string) {
  await a.send({ type: 'friendRequest', name: bName });
  await b.send({ type: 'friendRespond', name: aName, accept: true });
}

describe('the friends document (pure)', () => {
  it('requests, a crossed request accepting itself, refusals, removal and a deleted account', () => {
    const d = emptyDoc();
    touch(d, 1, 'Ash'); touch(d, 2, 'Bree'); touch(d, 3, 'Cole');
    expect(request(d, 1, 1)).toBe('self');
    expect(request(d, 1, 9)).toBe('unknown');
    expect(request(d, 1, 2)).toBe('sent');
    expect(request(d, 1, 2)).toBe('pending');
    // Bree asking back is a yes
    expect(request(d, 2, 1)).toBe('accepted');
    expect(d.accounts[1].friends).toEqual([2]);
    expect(d.accounts[2].friends).toEqual([1]);
    expect(d.accounts[1].out).toEqual([]);
    expect(request(d, 1, 2)).toBe('already');
    expect(request(d, 3, 1)).toBe('sent');
    expect(respond(d, 1, 3, false)).toBe(false);
    expect(d.accounts[3].out).toEqual([]);
    expect(unfriend(d, 2, 1)).toBe(true);
    expect(d.accounts[1].friends).toEqual([]);
    expect(findByName(d, 'bREE')).toBe(2);
    expect(forget(d, 2)).toBe(true);
    expect(d.accounts[2]).toBeUndefined();
  });

  it('caps waiting requests, and a stored document is checked field by field', () => {
    const d = emptyDoc();
    touch(d, 1, 'Ash');
    for (let i = 0; i < MAX_PENDING; i++) { touch(d, 100 + i, `p${i}`); expect(request(d, 100 + i, 1)).toBe('sent'); }
    touch(d, 999, 'late');
    expect(request(d, 999, 1)).toBe('busy');
    const parsed = parseDoc({ accounts: { 5: { name: 'Eve', status: 'nope', friends: [5, 6, 6, 'x', -1], in: null }, bad: { name: 'x' }, 7: { status: 'away' } } });
    expect(parsed.accounts).toEqual({ 5: { name: 'Eve', status: 'online', friends: [6], in: [], out: [] } });
  });
});

describe('friends (server)', () => {
  it('request by name, the prompt, accept: both lists show the other online; decline and remove', async () => {
    const w = world();
    const ash = await w.join('Ash'), bree = await w.join('Bree'), cole = await w.join('Cole');
    expect(ash.last('friends')).toMatchObject({ account: true, friends: [], status: 'online' });
    await ash.send({ type: 'friendRequest', name: 'bree' });
    expect(bree.last('friendRequest')).toEqual({ type: 'friendRequest', from: 'Ash' });
    expect(bree.last('friends')!.incoming).toEqual(['Ash']);
    expect(ash.last('friends')!.outgoing).toEqual(['Bree']);
    await bree.send({ type: 'friendRespond', name: 'Ash', accept: true });
    expect(friendNames(ash.last('friends'))).toEqual(['Bree:online']);
    expect(friendNames(bree.last('friends'))).toEqual(['Ash:online']);
    expect(ash.toasts()).toContain('You and Bree are friends now');
    // Cole asks, Ash declines
    await cole.send({ type: 'friendRequest', name: 'Ash' });
    await ash.send({ type: 'friendRespond', name: 'Cole', accept: false });
    expect(cole.last('friends')!.outgoing).toEqual([]);
    expect(friendNames(cole.last('friends'))).toEqual([]);
    // Bree removes Ash: both lists empty
    await bree.send({ type: 'friendRemove', name: 'Ash' });
    expect(friendNames(ash.last('friends'))).toEqual([]);
    expect(friendNames(bree.last('friends'))).toEqual([]);
  });

  it('refuses yourself, guests, unknown names, and guests asking', async () => {
    const w = world();
    const ash = await w.join('Ash');
    const guest = await w.join('Guest_12', true);
    await ash.send({ type: 'friendRequest', name: 'ASH' });
    await ash.send({ type: 'friendRequest', name: 'Guest_12' });
    await ash.send({ type: 'friendRequest', name: 'Nobody' });
    await ash.send({ type: 'friendRequest', name: 42 });
    expect(ash.toasts()).toEqual(expect.arrayContaining(["You can't add yourself", "Guests can't be added as friends", 'No pilot called Nobody']));
    await guest.send({ type: 'friendRequest', name: 'Ash' });
    expect(guest.toasts()).toContain('Sign in to add friends');
    expect(guest.last('friends')).toMatchObject({ account: false, friends: [] });
    expect(ash.last('friends')!.incoming).toEqual([]);
  });

  it('a request reaches an account that is offline, and friends follow the account to another server (the lobby)', async () => {
    const w = world();
    const ash = await w.join('Ash'), bree = await w.join('Bree');
    await bree.close();
    await ash.send({ type: 'friendRequest', name: 'Bree' });
    expect(ash.last('friends')!.outgoing).toEqual(['Bree']);
    expect(w.friends.doc.accounts[2].in).toEqual([1]);

    // Another server on the same lobby (and a store of its own): Bree signs in there, sees the request, accepts
    const w2 = world(new MemoryProfileStore(), undefined, w.friends);
    await w2.server.social.ready;
    const bree2 = await w2.join('Bree');
    expect(bree2.last('friends')!.incoming).toEqual(['Ash']);
    await bree2.send({ type: 'friendRespond', name: 'Ash', accept: true });
    // (Ash is online on the first server: only this server's pilots count as online for now)
    expect(friendNames(bree2.last('friends'))).toEqual(['Ash:offline']);
    // Ash's list on the first server catches up at its next refresh
    w.server.social.refresh();
    await w.flush();
    expect(friendNames(ash.last('friends'))).toEqual(['Bree:offline']);
    await ash.close();
    const ash2 = await w2.join('Ash');
    expect(friendNames(ash2.last('friends'))).toEqual(['Bree:online']);
    // ...and Bree heard Ash come on
    expect(friendNames(bree2.last('friends'))).toEqual(['Ash:online']);
    await ash2.close();
    expect(friendNames(bree2.last('friends'))).toEqual(['Ash:offline']);
  });

  it('status: friends see Away and Busy; Appear offline shows offline; a status is kept per account', async () => {
    const store = new MemoryProfileStore();
    const w = world(store);
    const ash = await w.join('Ash'), bree = await w.join('Bree');
    await befriend(ash, bree, 'Bree', 'Ash');
    await bree.send({ type: 'setStatus', status: 'away' });
    expect(friendNames(ash.last('friends'))).toEqual(['Bree:away']);
    expect(bree.last('friends')!.status).toBe('away');
    await bree.send({ type: 'setStatus', status: 'busy' });
    expect(friendNames(ash.last('friends'))).toEqual(['Bree:busy']);
    await bree.send({ type: 'setStatus', status: 'invisible' });
    expect(friendNames(ash.last('friends'))).toEqual(['Bree:offline']);
    await bree.send({ type: 'setStatus', status: 'gone fishing' });
    expect(bree.last('friends')!.status).toBe('invisible');
    await w.server.social.save();
    expect(w.friends.doc.accounts[2].status).toBe('invisible');
    // Next session (another server, the same lobby), Bree still appears offline
    await ash.close(); await bree.close();
    const w2 = world(store, undefined, w.friends);
    await w2.server.social.ready;
    const ash2 = await w2.join('Ash');
    const bree2 = await w2.join('Bree');
    expect(bree2.last('friends')!.status).toBe('invisible');
    expect(friendNames(ash2.last('friends'))).toEqual(['Bree:offline']);
  });
});

describe('the lobby being down', () => {
  it('a list that cannot load says so and loads once the lobby is back; changes say friends are unavailable; a status waits to be saved', async () => {
    const w = world();
    const ash = await w.join('Ash'), bree = await w.join('Bree');
    await befriend(ash, bree, 'Bree', 'Ash');
    await ash.close(); await bree.close();
    w.friends.down = true;
    const ash2 = await w.join('Ash');
    expect(ash2.notes()).toContain(LIST_UNAVAILABLE);
    expect(ash2.last('friends')).toMatchObject({ account: true, friends: [] });
    await ash2.send({ type: 'friendRequest', name: 'Cole' });
    expect(ash2.toasts().at(-1)).toBe(UNAVAILABLE);
    await ash2.send({ type: 'setStatus', status: 'busy' });
    expect(ash2.toasts().at(-1)).toBe(STATUS_UNSAVED);
    expect(ash2.last('friends')!.status).toBe('busy');
    // Whispers don't need the lobby
    const cole = await w.join('Guest_3', true);
    await cole.send({ type: 'whisper', to: 'Ash', text: 'still here?' });
    expect(ash2.last('whisper')).toMatchObject({ from: 'Guest_3', text: 'still here?' });
    w.friends.down = false;
    await w.server.social.retry();
    await w.flush();
    expect(friendNames(ash2.last('friends'))).toEqual(['Bree:offline']);
    expect(ash2.last('friends')!.status).toBe('busy');
    expect(w.friends.doc.accounts[1].status).toBe('busy');
  });
});

describe('moving the old per-server friends document', () => {
  const oldDoc = { v: 1, accounts: { 1: { name: 'Ash', status: 'away', friends: [2], in: [], out: [] }, 2: { name: 'Bree', status: 'online', friends: [1], in: [], out: [] } } };

  it('goes to the lobby at start, is marked moved, and is never sent again', async () => {
    const store = new MemoryProfileStore();
    await store.saveDoc(SOCIAL_DOC, oldDoc);
    const w = world(store);
    await w.server.social.ready;
    expect(w.friends.doc.accounts[1]).toMatchObject({ status: 'away', friends: [2] });
    expect((await store.loadDoc(SOCIAL_DOC) as any).movedToLobby).toBeGreaterThan(0);
    const ash = await w.join('Ash');
    expect(friendNames(ash.last('friends'))).toEqual(['Bree:offline']);
    expect(ash.last('friends')!.status).toBe('away');
    // A second start on the same store sends nothing
    const calls: unknown[] = [];
    const spy = new MemoryFriends();
    spy.importDoc = async (a) => { calls.push(a); return { friends: 0, requests: 0, skipped: 0 }; };
    expect(await migrateFriends(store, spy)).toBe('already');
    expect(calls).toEqual([]);
  });

  it('waits for the lobby when it is down (nothing marked), then moves it', async () => {
    const store = new MemoryProfileStore();
    await store.saveDoc(SOCIAL_DOC, oldDoc);
    const friends = new MemoryFriends();
    friends.down = true;
    const w = world(store, undefined, friends);
    await w.server.social.ready;
    expect((await store.loadDoc(SOCIAL_DOC) as any).movedToLobby).toBeUndefined();
    friends.down = false;
    await w.server.social.retry();
    expect(friends.doc.accounts[2]).toMatchObject({ friends: [1] });
    expect((await store.loadDoc(SOCIAL_DOC) as any).movedToLobby).toBeGreaterThan(0);
    // No document: nothing to do
    expect(await migrateFriends(new MemoryProfileStore(), friends)).toBe('none');
  });
});

describe('private messages', () => {
  it('reach only the named pilot (any case), with a copy back to the sender; guests too', async () => {
    const w = world();
    const ash = await w.join('Ash'), bree = await w.join('Bree'), cole = await w.join('Cole');
    const guest = await w.join('Guest_7', true);
    await ash.send({ type: 'whisper', to: 'bREE', text: '  hello there  ' });
    expect(bree.last('whisper')).toEqual({ type: 'whisper', from: 'Ash', to: 'Bree', text: 'hello there' });
    expect(ash.last('whisper')).toEqual({ type: 'whisper', from: 'Ash', to: 'Bree', text: 'hello there', out: true });
    expect(cole.all('whisper')).toEqual([]);
    expect(cole.all('chat')).toEqual([]);
    // Nor do they go out as public chat
    expect(bree.all('chat')).toEqual([]);
    // /w in chat does the same; a guest can send and get them
    await guest.send({ type: 'chat', text: '/w Cole hi from a guest' });
    expect(cole.last('whisper')).toMatchObject({ from: 'Guest_7', text: 'hi from a guest' });
    await cole.send({ type: 'whisper', to: 'Guest_7', text: 'hi back' });
    expect(guest.last('whisper')).toMatchObject({ from: 'Cole', text: 'hi back' });
    // Checked: no text, too long, not a string, yourself
    await ash.send({ type: 'whisper', to: 'Bree', text: '   ' });
    await ash.send({ type: 'whisper', to: { x: 1 }, text: 'x' });
    await ash.send({ type: 'whisper', to: 'Bree', text: 'y'.repeat(500) });
    expect(bree.all('whisper').length).toBe(2);
    expect(bree.last('whisper')!.text.length).toBe(200);
    await ash.send({ type: 'whisper', to: 'Ash', text: 'me' });
    expect(ash.notes()).toContain("You can't send a private message to yourself");
  });

  it('offline and Appear offline pilots are not sent them, and the sender is told alike; Busy and Away are', async () => {
    const w = world();
    const ash = await w.join('Ash'), bree = await w.join('Bree'), cole = await w.join('Cole');
    await cole.close();
    await ash.send({ type: 'whisper', to: 'cole', text: 'you there?' });
    expect(ash.notes().at(-1)).toBe('cole is offline. Private messages only reach pilots who are online.');
    await ash.send({ type: 'whisper', to: 'Zed', text: 'hm' });
    expect(ash.notes().at(-1)).toBe('Zed is offline. Private messages only reach pilots who are online.');
    await bree.send({ type: 'setStatus', status: 'invisible' });
    await ash.send({ type: 'whisper', to: 'Bree', text: 'hidden?' });
    expect(ash.notes().at(-1)).toBe('Bree is offline. Private messages only reach pilots who are online.');
    expect(bree.all('whisper')).toEqual([]);
    // An invisible pilot can still send
    await bree.send({ type: 'whisper', to: 'Ash', text: 'only me' });
    expect(ash.last('whisper')).toMatchObject({ from: 'Bree', text: 'only me' });
    await bree.send({ type: 'setStatus', status: 'busy' });
    await ash.send({ type: 'whisper', to: 'Bree', text: 'busy?' });
    expect(bree.last('whisper')).toMatchObject({ text: 'busy?' });
    expect(ash.notes().at(-1)).toBe('Bree is busy and may not answer right away.');
  });

  it('are rate limited per pilot (admins too), and friend requests are', async () => {
    const clock = { t: 1_000_000 };
    const w = world(new MemoryProfileStore(), clock);
    const ash = await w.join('Ash'), bree = await w.join('Bree');
    for (let i = 0; i < WHISPER_BURST + 3; i++) await ash.send({ type: 'whisper', to: 'Bree', text: `m${i}` });
    expect(bree.all('whisper').length).toBe(WHISPER_BURST);
    expect(ash.notes()).toContain('Slow down: too many private messages at once.');
    clock.t += WHISPER_WINDOW;
    await ash.send({ type: 'whisper', to: 'Bree', text: 'later' });
    expect(bree.last('whisper')!.text).toBe('later');
    // Requests: each try counts (names probed too). (Straight to the module: dispatch's own flood limit runs on the wall clock)
    for (let i = 0; i < REQUEST_BURST; i++) { w.server.social.request(ash.conn(), `nobody${i}`); clock.t += 20_000; }
    await ash.send({ type: 'friendRequest', name: 'Bree' });
    expect(ash.toasts()).toContain('Too many friend requests: try again later');
    expect(bree.all('friendRequest')).toEqual([]);
  });
});

describe('the friends list and the party', () => {
  it('a friend can be invited to a party by name (the list\'s right-click)', async () => {
    const w = world();
    const ash = await w.join('Ash'), bree = await w.join('Bree');
    await befriend(ash, bree, 'Bree', 'Ash');
    await ash.send({ type: 'partyInvite', name: 'Bree' });
    expect(bree.last('partyInvite')).toMatchObject({ from: 'Ash' });
    await bree.send({ type: 'partyRespond', accept: true });
    expect(ash.last('party')!.members.map((m) => m.name).sort()).toEqual(['Ash', 'Bree']);
  });

  it('a deleted account leaves every list', async () => {
    const w = world();
    const ash = await w.join('Ash'), bree = await w.join('Bree');
    await befriend(ash, bree, 'Bree', 'Ash');
    await bree.close();
    await w.server.forgetAccounts([2]);
    await w.flush();
    expect(friendNames(ash.last('friends'))).toEqual([]);
  });
});

describe('LobbyFriends (the lobby client)', () => {
  it('sends the admin secret, and a lobby that is down, refuses or says slow down is FriendsUnavailable', async () => {
    const seen: { url: string; auth: string; body: any }[] = [];
    let answer: () => Response = () => new Response(JSON.stringify({ success: true, status: 'away', friends: [{ id: 2, name: 'Bree' }], incoming: [], outgoing: [] }));
    vi.stubGlobal('fetch', async (url: string, init: any) => {
      seen.push({ url, auth: init.headers.Authorization, body: JSON.parse(init.body) });
      return answer();
    });
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const lobby = new LobbyFriends('http://lobby', 'sssh');
      expect(await lobby.get(1)).toEqual({ status: 'away', friends: [{ id: 2, name: 'Bree' }], incoming: [], outgoing: [] });
      expect(seen[0]).toEqual({ url: 'http://lobby/admin/friends/get', auth: 'Bearer sssh', body: { userId: 1 } });
      answer = () => new Response(JSON.stringify({ success: false, limited: true }), { status: 429 });
      await expect(lobby.request(1, 'Bree')).rejects.toMatchObject({ limited: true });
      answer = () => new Response('{}', { status: 403 });
      await expect(lobby.setStatus(1, 'busy')).rejects.toBeInstanceOf(FriendsUnavailable);
      answer = () => { throw new Error('ECONNREFUSED'); };
      await expect(lobby.remove(1, 'Bree')).rejects.toMatchObject({ limited: false });
    } finally {
      vi.unstubAllGlobals();
      quiet.mockRestore();
    }
  });
});
