import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import type { ServerMessage } from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigFromDisk } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../proto/createProtoServer.js';
import type { AccountAdmin, AccountInfo } from '../auth/types.js';
import { JsonProfileStore } from '../profile/JsonProfileStore.js';
import { mkdtempSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';

const dataDir = join(__dirname, '../../../data');
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const files = readGameDataFiles(dataDir);

/** A lobby in memory: accounts by name, and tokens "tok:<name>" that sign in as them (refused while banned) */
function fakeLobby(names: string[]) {
  const users = new Map<string, AccountInfo>();
  names.forEach((n, i) => users.set(n.toLowerCase(), { id: i + 1, username: n, isAdmin: n === 'boss' || n === 'chief', createdAt: '', ban: null }));
  const need = (n: string) => { const u = users.get(n.toLowerCase()); if (!u) throw new Error(`No account "${n}"`); return u; };
  const admin: AccountAdmin = {
    list: async (search, offset, limit) => {
      const all = [...users.values()].filter((u) => u.username.toLowerCase().startsWith(search.toLowerCase()));
      return { users: all.slice(offset, offset + limit).map((u) => ({ ...u })), total: all.length };
    },
    get: async (n) => { const u = users.get(n.toLowerCase()); return u ? { ...u } : null; },
    setAdmin: async (n, on) => { const u = need(n); u.isAdmin = on; return { ...u }; },
    ban: async (n, until, reason, by) => { const u = need(n); u.ban = { until, reason, by }; return { ...u }; },
    unban: async (n) => { const u = need(n); u.ban = null; return { ...u }; },
  };
  const checkSession = async (t: string) => {
    const u = users.get(t.split(':')[1].toLowerCase());
    if (!u) return { user: null, error: '' };
    if (u.ban) return { user: null, error: `This account is banned: ${u.ban.reason}` };
    return { user: { id: u.id, username: u.username, email: '', is_admin: u.isAdmin, created_at: '' } };
  };
  return {
    users,
    userDB: { checkSession, validateSession: async (t: string) => (await checkSession(t)).user, cleanupExpiredSessions: async () => {}, admin },
  };
}

function world(lobby: boolean, profileStore?: JsonProfileStore) {
  resetGlobals();
  const fake = fakeLobby(['boss', 'chief', 'pilot', 'helper', 'away', 'awol']);
  const userDB = lobby ? fake.userDB : { ...fake.userDB, admin: null };
  const server = new GameServer({
    gameData: new GameData(files), userDB: userDB as any, scene: 'sectors', autoStart: false,
    ships: createShipBridge(loadShipConfigFromDisk(dataDir)), profileStore,
  });
  const flush = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0)); };
  const join = async (name: string, guest = false) => {
    const t = new LocalTransport(server);
    const got: ServerMessage[] = [];
    t.onMessage = (m) => got.push(m);
    t.connect();
    t.send({ type: 'join', username: name, ...(guest ? {} : { token: `tok:${name}` }) } as any);
    await flush();
    const pid = t.getPlayerId();
    const conn = [...(server as any).clients.values()].find((c: any) => c.playerId === pid);
    /** An admin command, answered */
    const admin = async (cmd: string, args: object = {}) => {
      t.send({ type: 'admin', cmd, args } as any);
      server.step();
      await flush();
      return (got.filter((m) => m.type === 'adminResult') as any[]).at(-1) as { ok: boolean; text: string } | undefined;
    };
    const chat = async (text: string) => {
      t.send({ type: 'chat', text } as any);
      server.step();
      await flush();
      return (got.filter((m) => m.type === 'adminResult') as any[]).at(-1) as { ok: boolean; text: string };
    };
    return { t, got, pid, conn, admin, chat };
  };
  return { server, join, lobby: fake };
}

const of = <T extends ServerMessage['type']>(got: ServerMessage[], type: T) => got.filter((m) => m.type === type) as Extract<ServerMessage, { type: T }>[];

describe('managing players (online or not)', () => {
  it('lists online players first, then the accounts that aren\'t on, with ranks and bans', async () => {
    const { join, lobby } = world(true);
    const boss = await join('boss');
    await join('pilot');
    await join('Visitor', true);
    lobby.users.get('awol')!.ban = { until: null, reason: 'cheating', by: 'boss' };
    await boss.chat('/contributor helper on');
    await boss.admin('players', { quiet: true });
    const list = of(boss.got, 'adminAccounts').at(-1)!;
    expect(list.error).toBeUndefined();
    expect(list.players.map((p) => [p.name, p.online !== null, p.rank, p.account])).toEqual([
      ['boss', true, 'admin', true], ['pilot', true, 'player', true], ['Visitor', true, 'player', false],
      ['chief', false, 'admin', true], ['helper', false, 'contributor', true], ['away', false, 'player', true], ['awol', false, 'player', true],
    ]);
    expect(list.players.find((p) => p.name === 'awol')?.ban?.reason).toBe('cheating');
    // A search by prefix; the chat form answers in text
    await boss.admin('players', { search: 'aw', quiet: true });
    expect(of(boss.got, 'adminAccounts').at(-1)!.players.map((p) => p.name)).toEqual(['away', 'awol']);
    const text = await boss.chat('/players aw');
    expect(text.text).toMatch(/awol \[banned permanently: cheating\]/);
  });

  it('bans an offline player by name (their next sign-in is refused, saying why) and unbans them', async () => {
    const { join, lobby } = world(true);
    const boss = await join('boss');
    const r = await boss.chat('/ban away 1d being rude');
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/^Banned away until .* UTC: being rude$/);
    const ban = lobby.users.get('away')!.ban!;
    expect(ban.by).toBe('boss');
    expect(ban.until! - Date.now()).toBeGreaterThan(86_400_000 - 60_000);
    const away = await join('away');
    expect(of(away.got, 'authResult').at(-1)).toMatchObject({ success: false, error: 'This account is banned: being rude' });

    expect((await boss.chat('/unban away')).ok).toBe(true);
    expect(lobby.users.get('away')!.ban).toBeNull();
    expect((await boss.chat('/unban away')).text).toBe("away isn't banned");
    const back = await join('away');
    expect(of(back.got, 'authResult').at(-1)?.success).toBe(true);
    expect((await boss.chat('/ban away soon')).ok).toBe(false);
  });

  it('banning someone online kicks them, told why', async () => {
    const { join } = world(true);
    const boss = await join('boss');
    const pilot = await join('pilot');
    const r = await boss.admin('ban', { player: 'pilot', duration: 'perm', reason: 'griefing' });
    expect(r).toMatchObject({ ok: true, text: 'Banned pilot permanently: griefing (kicked)' });
    expect(of(pilot.got, 'authResult').at(-1)).toMatchObject({ success: false, error: "You've been banned permanently: griefing" });
    // Guests have no account to ban
    await join('drifter', true);
    expect((await boss.admin('ban', { player: 'drifter', duration: '1h' })).text).toMatch(/guest/);
  });

  it('changes ranks online (live) and offline', async () => {
    const { join, lobby } = world(true);
    const boss = await join('boss');
    const pilot = await join('pilot');
    expect((await boss.chat('/rank pilot admin')).text).toBe('pilot is now an admin');
    expect(pilot.conn.isAdmin).toBe(true);
    expect(lobby.users.get('pilot')!.isAdmin).toBe(true);
    expect(of(pilot.got, 'authResult').at(-1)).toMatchObject({ success: true, isAdmin: true });
    // ...and back down to a contributor: no admin, still the notes tools
    expect((await boss.admin('rank', { player: 'pilot', rank: 'contributor' })).ok).toBe(true);
    expect([pilot.conn.isAdmin, pilot.conn.isContributor, lobby.users.get('pilot')!.isAdmin]).toEqual([false, true, false]);
    expect(of(pilot.got, 'authResult').at(-1)).toMatchObject({ isAdmin: false, isContributor: true });

    // Offline, by name
    expect((await boss.admin('rank', { player: 'away', rank: 'admin' })).text).toBe('away is now an admin (offline)');
    expect(lobby.users.get('away')!.isAdmin).toBe(true);
    expect((await boss.admin('rank', { player: 'helper', rank: 'contributor' })).ok).toBe(true);
    const helper = await join('helper');
    expect(helper.conn.isContributor).toBe(true);
    expect((await boss.admin('rank', { player: 'helper', rank: 'player' })).ok).toBe(true);
    expect(helper.conn.isContributor).toBe(false);
    expect((await boss.admin('rank', { player: 'nobody', rank: 'admin' })).text).toMatch(/No player or account/);
    expect((await boss.admin('rank', { player: 'away', rank: 'king' })).ok).toBe(false);
  });

  it('an admin can\'t demote or ban themselves, or ban another admin', async () => {
    const { join, lobby } = world(true);
    const boss = await join('boss');
    expect((await boss.chat('/rank boss player')).text).toBe("You can't demote yourself");
    expect((await boss.admin('ban', { player: 'boss', duration: '1h' })).text).toBe("You can't ban yourself");
    expect((await boss.admin('ban', { player: 'chief', duration: '1h' })).text).toMatch(/is an admin: take the rank away first/);
    expect([lobby.users.get('boss')!.isAdmin, lobby.users.get('boss')!.ban, lobby.users.get('chief')!.ban]).toEqual([true, null, null]);
    // Players can't use any of it
    const pilot = await join('pilot');
    expect((await pilot.admin('ban', { player: 'away', duration: 'perm' }))?.ok).toBe(false);
    expect(lobby.users.get('away')!.ban).toBeNull();
  });

  it('with no lobby: a clear refusal for admin rank and bans; the contributor rank still works', async () => {
    const { join } = world(false);
    const boss = await join('boss');
    const pilot = await join('pilot');
    expect((await boss.admin('ban', { player: 'pilot', duration: '1h' })).text).toMatch(/no lobby/);
    expect((await boss.admin('unban', { player: 'pilot' })).text).toMatch(/no lobby/);
    expect((await boss.admin('rank', { player: 'pilot', rank: 'admin' })).text).toMatch(/no lobby/);
    expect((await boss.admin('rank', { player: 'pilot', rank: 'contributor' })).ok).toBe(true);
    expect(pilot.conn.isContributor).toBe(true);
    expect((await boss.admin('rank', { player: 'someone', rank: 'contributor' })).text).toBe('someone is now a contributor (offline)');
    await boss.admin('players', { quiet: true });
    const list = of(boss.got, 'adminAccounts').at(-1)!;
    expect(list.error).toMatch(/no lobby/);
    expect(list.players.map((p) => p.name)).toEqual(['boss', 'pilot']);
  });
});

describe('a deleted account', () => {
  it('has its profile deleted (and rank removed), its connection ended, and nothing written back on disconnect', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'profiles-'));
    try {
      const store = new JsonProfileStore(dir);
      const { server, join: signIn, lobby } = world(true, store);
      const pilot = await signIn('pilot');
      const id = lobby.users.get('pilot')!.id;
      const file = join(dir, `${id}.json`);
      // (the profile loads from disk, so give the sign-in a moment before saving)
      await new Promise((r) => setTimeout(r, 100));
      await server.saveAll();
      expect(existsSync(file)).toBe(true);

      await server.forgetAccounts([id]);
      expect(existsSync(file)).toBe(false);
      expect(of(pilot.got, 'authResult').at(-1)).toMatchObject({ success: false, error: 'This account has been deleted.' });

      // Their socket closing, and the next autosave or shutdown, must not bring the profile back
      pilot.t.disconnect();
      await server.saveAll();
      await store.close();
      expect(existsSync(file)).toBe(false);

      // The lobby repeats the list every heartbeat: no harm, and other pilots' saves are untouched
      await server.forgetAccounts([id, id]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
