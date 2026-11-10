import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { Position, Velocity, InSystem, ServerMessage, Station as StationComp, migrateProfile } from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData, type GameDataFiles } from '../data/GameData.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { validateGameData } from '../data/validateGameData.js';
import { loadShipConfigCached } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../ships/createShipBridge.js';
import { MemoryProfileStore } from '../profile/ProfileStore.js';

const dataDir = join(__dirname, '../../../data');
const files = readGameDataFiles(dataDir);

function world(data: GameDataFiles = files, store = new MemoryProfileStore()) {
  (bitecs as unknown as { resetGlobals: () => void }).resetGlobals();
  const server = new GameServer({
    profileStore: store, gameData: new GameData(data), userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as any,
    scene: 'sectors', autoStart: false, ships: createShipBridge(loadShipConfigCached(dataDir)),
  });
  const join = () => {
    const t = new LocalTransport(server);
    const got: ServerMessage[] = [];
    t.onMessage = (m) => got.push(m);
    t.connect();
    t.send({ type: 'join', username: 'reader' } as any);
    const pid = t.getPlayerId();
    return { t, got, pid, conn: server.pilots.connOf(pid)! };
  };
  const me = join();
  const p = () => server.pilots.get(me.conn)!;
  const steps = (n: number) => { for (let i = 0; i < n; i++) server.step(); };
  const codexMsgs = (got = me.got) => got.filter((m) => m.type === 'codex') as Extract<ServerMessage, { type: 'codex' }>[];
  const toasts = () => me.got.filter((m) => m.type === 'toast').map((m) => (m as any).text as string);
  return { server, ...me, p, steps, codexMsgs, toasts, join, store };
}

describe('records (codex)', () => {
  it('a record whose condition holds is found on the next check, toasted, sent and marked new', () => {
    const w = world();
    expect(w.p().codex.found).not.toContain('hollow_crown_ledger');
    // Login sent the (empty) list
    expect(w.codexMsgs()[0]).toMatchObject({ all: true, entries: [] });
    w.p().quests.done.push('far_05');
    w.p().stats['sys:ashfall'] = 1;
    w.steps(31);
    expect(w.p().codex.found).toEqual(expect.arrayContaining(['hollow_crown_ledger', 'halden_ring']));
    expect(w.p().codex.fresh).toEqual(expect.arrayContaining(['hollow_crown_ledger', 'halden_ring']));
    const sent = w.codexMsgs().at(-1)!;
    expect(sent.all).toBeFalsy();
    expect(sent.entries.map((e) => e.id).sort()).toEqual(['halden_ring', 'hollow_crown_ledger']);
    // The client gets the words, never the condition
    expect(sent.entries[0]).not.toHaveProperty('unlock');
    expect(w.toasts().some((t) => /2 new records/.test(t))).toBe(true);
    // Found once: no second toast
    const n = w.codexMsgs().length;
    w.steps(31);
    expect(w.codexMsgs().length).toBe(n);
    // Opened: no longer new
    w.t.send({ type: 'codexRead', id: 'halden_ring' } as any);
    expect(w.p().codex.fresh).toEqual(['hollow_crown_ledger']);
    expect(w.codexMsgs().at(-1)!.fresh).toEqual(['hollow_crown_ledger']);
  });

  it('someone can hand a record over in conversation', () => {
    const w = world();
    const gd = w.server.gameData, sw = w.server.getWorld(), num = gd.getStationNum('nebula_research_station');
    const st = [...Array(8000).keys()].find((e) => bitecs.entityExists(sw, e) && bitecs.hasComponent(sw, StationComp, e) && StationComp.stationId[e] === num)!;
    InSystem.systemId[w.pid] = InSystem.systemId[st];
    for (let i = 0; i < 65; i++) { Position.x[w.pid] = Position.x[st] + 300; Position.y[w.pid] = Position.y[st]; Velocity.x[w.pid] = Velocity.y[w.pid] = 0; w.server.step(); }
    w.t.send({ type: 'talk', person: 'quinn' } as any);
    const v = ([...w.got].reverse().find((m) => m.type === 'talk') as any).view;
    const i = v.choices.findIndex((c: any) => /theory/i.test(c.text));
    expect(i).toBeGreaterThanOrEqual(0);
    w.t.send({ type: 'talk', n: v.n, choice: i } as any);
    expect(w.p().codex.found).toContain('quinn_theory');
    expect(w.toasts().some((t) => /New record: A natural effect/.test(t))).toBe(true);
  });

  it('a job can pay a record, and an item can carry one (however it was got)', () => {
    const data = structuredClone(files) as any;
    data.quests.quests.find((q: any) => q.id === 'main_01').rewards.codex = ['maw_records'];
    const w = world(data);
    expect(w.server.quests.acceptFrom(w.conn, 'main_01')).toBeNull();
    w.server.quests['pay'](w.conn, w.p(), w.server.quests.def('main_01')!);
    expect(w.p().codex.found).toContain('maw_records');
    w.server.pilots.give(w.conn, { vigil_log: 1 }, { source: 'loot' });
    expect(w.p().codex.found).toContain('vigil_log');
    expect(w.codexMsgs().at(-1)!.entries.map((e) => e.id)).toEqual(['vigil_log']);
    // Into storage counts too
    w.server.pilots.give(w.conn, { halden_cache: 1 }, { toStorage: true, source: 'quest' });
    expect(w.p().codex.found).toContain('halden_caches');
  });

  it("a wreck's log is read by flying close to it (systems.json derelicts[].log)", () => {
    const w = world();
    const sol = w.server.gameData.getSystemNum('sol');
    const wreck = (files as any).systems.systems.find((s: any) => s.id === 'sol').derelicts.find((d: any) => d.log?.codex === 'grey_hour_log');
    expect(wreck).toBeTruthy();
    const sit = (dx: number) => {
      for (let i = 0; i < 31; i++) {
        InSystem.systemId[w.pid] = sol;
        Position.x[w.pid] = wreck.position.x + dx; Position.y[w.pid] = wreck.position.y; Velocity.x[w.pid] = Velocity.y[w.pid] = 0;
        w.server.step();
      }
    };
    sit(3000);
    expect(w.p().codex.found).not.toContain('grey_hour_log');
    sit(500);
    expect(w.p().codex.found).toContain('grey_hour_log');
    expect(w.toasts().some((t) => /New record: The Grey Hour's log/.test(t))).toBe(true);
  });

  it('found records are saved and come back on login; old saves start with none', async () => {
    const store = new MemoryProfileStore();
    const w = world(files, store);
    (w.conn as any).userId = 7;
    await w.server.pilots.login(w.conn, 7);
    w.server.pilots.give(w.conn, { vigil_log: 1 }, { source: 'loot' });
    w.t.send({ type: 'codexRead', id: 'vigil_log' } as any);
    w.server.pilots.give(w.conn, { halden_cache: 1 }, { source: 'loot' });
    await w.server.pilots.detach(w.conn);
    expect(((await store.load(7)) as any).codex).toEqual({ found: ['vigil_log', 'halden_caches'], fresh: ['halden_caches'] });
    const b = w.join();
    (b.conn as any).userId = 7;
    await w.server.pilots.login(b.conn, 7);
    expect(w.server.pilots.get(b.conn)!.codex.found).toEqual(['vigil_log', 'halden_caches']);
    const all = w.codexMsgs(b.got).filter((m) => m.all).at(-1)!;
    expect(all.entries.map((e) => e.id)).toEqual(['vigil_log', 'halden_caches']);
    expect(all.fresh).toEqual(['halden_caches']);
    // Migration: missing → none; junk and fresh-but-not-found dropped
    const kit = (w.server as any).pilots.opts.starter;
    expect(migrateProfile({ credits: 5 }, kit).codex).toEqual({ found: [], fresh: [] });
    expect(migrateProfile({ codex: { found: ['a', 'a', 3, 'b'], fresh: ['b', 'c'] } }, kit).codex).toEqual({ found: ['a', 'b'], fresh: ['b'] });
  });

  it('admins can hand records out and take them back (/codex)', () => {
    const w = world();
    (w.conn as any).isAdmin = true;
    w.server.admin.chat(w.conn as any, '/codex reader all');
    expect(w.p().codex.found.length).toBe((files as any).codex.entries.length);
    w.server.admin.chat(w.conn as any, '/codex clear');
    expect(w.p().codex.found).toEqual([]);
  });

  it('validation rejects a record whose condition, line or reward names something that does not exist', () => {
    const f = structuredClone(files) as any;
    f.codex.entries[0].unlock = { done: 'far_55' };
    f.codex.entries[1].unlock = { any: [{ boss: 'boss_maw_hart' }] };
    f.codex.entries.push({ id: 'x', tab: 'gossip', title: 'X', source: 'Y', body: 'Z' });
    f.items.items.find((i: any) => i.id === 'vigil_log').codex = 'vigil_logg';
    f.quests.quests[0].rewards.codex = ['nope'];
    f.systems.systems.find((s: any) => s.id === 'sol').derelicts[0].log = { codex: 'nope' };
    const errors = validateGameData(f).filter((p) => p.level === 'error');
    const at = (file: string, path: RegExp) => errors.some((p) => p.file === file && path.test(p.path));
    expect(at('codex.json', /^entries\[0\]\.unlock\.done$/)).toBe(true);
    expect(at('codex.json', /^entries\[1\]\.unlock\.any\[0\]\.boss$/)).toBe(true);
    expect(at('codex.json', /\.tab$/)).toBe(true);
    expect(errors.some((p) => p.file === 'items.json' && /did you mean "vigil_log"/.test(p.message))).toBe(true);
    expect(at('quests.json', /^quests\[0\]\.rewards\.codex\[0\]$/)).toBe(true);
    expect(errors.some((p) => p.file === 'systems.json' && /derelicts\[0\]\.log\.codex$/.test(p.path))).toBe(true);
    expect(validateGameData(files).filter((p) => p.level === 'error' && p.file === 'codex.json')).toEqual([]);
  });
});
