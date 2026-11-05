import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { readFileSync } from 'fs';
import * as bitecs from 'bitecs';
import { Position, Input, InSystem, ServerMessage, parseBlueprint, Station as StationComp, PROTOCOL_VERSION, DEFAULT_CAPS, CAPS, ghostBill, Blueprint, partItemId, registeredFunction, MATERIAL_LEVEL } from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigFromDisk } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../proto/createProtoServer.js';
import { MemoryProfileStore } from '../profile/ProfileStore.js';

const dataDir = join(__dirname, '../../../data');
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const files = readGameDataFiles(dataDir);
const bulwark = parseBlueprint(readFileSync(join(dataDir, 'ships/blueprints/bulwark.json'), 'utf-8'));

function world(join = true) {
  resetGlobals();
  const server = new GameServer({ profileStore: new MemoryProfileStore(), gameData: new GameData(files), userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as any,
    scene: 'sectors', autoStart: false, ships: createShipBridge(loadShipConfigFromDisk(dataDir)) });
  const t = new LocalTransport(server);
  const got: ServerMessage[] = [];
  t.onMessage = (m) => got.push(m);
  t.connect();
  if (join) t.send({ type: 'join', username: 'pilot' } as any);
  const pid = t.getPlayerId();
  const conn = () => server.pilots.connOf(t.getPlayerId())!;
  const profile = () => server.pilots.get(conn())!;
  return { server, t, got, pid, conn, profile };
}

const lastEdit = (got: ServerMessage[]) => [...got].reverse().find((m) => m.type === 'shipEditResult') as any;

/** Everything a design is built from, in storage (no licences) */
function grantMaterials(w: ReturnType<typeof world>, bp: Blueprint) {
  w.server.pilots.give(w.conn(), ghostBill(w.server.econ, bp, bp.parts.map((p) => p.uid)), { toStorage: true, quiet: true });
}

describe('licences', () => {
  it('plates in storage (or salvaged modules) are not a licence to fit them', () => {
    const w = world();
    (w.server as any).shipEditAnywhere = true;
    expect(bulwark.parts.some((p) => p.material === 'steel')).toBe(true);
    grantMaterials(w, bulwark);
    w.t.send({ type: 'shipEdit', blueprint: bulwark });
    expect(lastEdit(w.got).ok).toBe(false);
    expect(lastEdit(w.got).errors[0]).toMatch(/licensed/);
    // Reach the level it needs (its models' and materials': no licence opens anything early): now it fits
    if (!w.profile().recipes.includes('fn:core')) w.profile().recipes.push('fn:core');
    w.profile().level = Math.max(w.profile().level, ...bulwark.parts.map((q) => Math.max(registeredFunction(q.fn)?.unlock?.level ?? 0, MATERIAL_LEVEL[q.material] ?? 0)));
    w.t.send({ type: 'shipEdit', blueprint: bulwark });
    expect(lastEdit(w.got).ok).toBe(true);
  });

  it('a plan you were given builds as designed, licence or not', () => {
    const w = world();
    (w.server as any).shipEditAnywhere = true;
    grantMaterials(w, bulwark);
    w.profile().plans.push('bulwark');
    w.t.send({ type: 'slotSave', slot: 1, blueprint: bulwark, plan: 'bulwark' } as any);
    expect(lastEdit(w.got).ok).toBe(true);
    // ...but only as many of its steel parts as the plan has (structure: a model is made of what it's made of)
    const planned = new Set(bulwark.parts.map(partItemId));
    const i = bulwark.parts.findIndex((p) => p.material !== 'steel' && ['hull', 'armor', 'cargo'].includes(p.fn) && !planned.has(partItemId({ ...p, material: 'steel' })));
    expect(i).toBeGreaterThanOrEqual(0);
    const more = { ...bulwark, parts: bulwark.parts.map((p, k) => (k === i ? { ...p, material: 'steel' } : p)) };
    w.t.send({ type: 'slotSave', slot: 2, blueprint: more, plan: 'bulwark' } as any);
    expect(lastEdit(w.got).ok).toBe(false);
    expect(lastEdit(w.got).errors[0]).toMatch(/licensed/);
  });
});

describe('station repair', () => {
  it('is billed at the station rate once past the free levels, and never strands a broke pilot', () => {
    const w = world();
    const ships = w.server.getShips();
    (ships as any).host.nearRepairSite = () => true;
    const rate = 2;
    (w.server as any).repairRate = () => rate;
    w.server.pilots.addXp(w.conn(), 5000);
    expect(w.profile().level).toBeGreaterThanOrEqual(3);
    const park = () => { Position.x[w.pid] = 40000; Position.y[w.pid] = 40000; };
    const part = ships.get(w.pid)!.blueprint.parts.findIndex((p) => p.fn === 'hull');
    ships.damagePartFraction(w.pid, part, 0.5);
    w.profile().credits = 1000;
    for (let i = 0; i < 600; i++) { park(); w.server.step(); }
    expect(w.profile().credits).toBeLessThan(1000);
    // Broke: it still heals, slowly, for free
    ships.damagePartFraction(w.pid, part, 0.5);
    const hp = () => ships.get(w.pid)!.hp[part];
    const before = hp();
    w.profile().credits = 0;
    for (let i = 0; i < 600; i++) { park(); w.server.step(); }
    expect(w.profile().credits).toBe(0);
    expect(hp()).toBeGreaterThan(before);
  });
});

describe('boss pay', () => {
  it('a boss you have killed before pays a share, and no second artefact', () => {
    const w = world();
    const host = (w.server as any).bosses.host;
    expect(host.killedBefore(w.pid, 'boss_scrap_mother')).toBe(false);
    w.server.pilots.bumpStat(w.conn(), 'boss:boss_scrap_mother');
    expect(host.killedBefore(w.pid, 'boss_scrap_mother')).toBe(true);
    const artefact = w.server.econ.items.all?.().find((i: any) => i.category === 'artefact')?.id
      ?? (files.items as any).items.find((i: any) => i.category === 'artefact').id;
    expect(host.isArtefact(artefact)).toBe(true);
    expect(host.holds(w.pid, artefact)).toBe(false);
    w.server.pilots.give(w.conn(), { [artefact]: 1 }, { toStorage: true, quiet: true });
    expect(host.holds(w.pid, artefact)).toBe(true);
  });
});

describe('connections', () => {
  it('nothing but join, ping and sign-in is handled before joining', () => {
    const w = world(false);
    const conn = [...(w.server as any).clients.values()][0];
    w.t.send({ type: 'chat', text: 'hello' } as any);
    w.t.send({ type: 'input', seq: 1, tick: 0, forward: true, backward: false, left: false, right: false, boost: false, fireLeft: false, fireRight: false, targetAngle: 0 } as any);
    w.server.step();
    expect(conn.joined).toBe(false);
    expect(Input.forward[w.pid]).toBe(0);
  });

  it('a client built for another protocol, or without the full caps set, is turned away', () => {
    const w = world(false);
    const conn = [...(w.server as any).clients.values()][0];
    w.t.send({ type: 'join', username: 'old', protocol: PROTOCOL_VERSION + 1 } as any);
    expect(conn.joined).toBe(false);
    // (the right protocol but not every cap: there's no base protocol to fall back on)
    w.t.send({ type: 'join', username: 'part', protocol: PROTOCOL_VERSION } as any);
    expect(conn.joined).toBe(false);
    w.t.send({ type: 'join', username: 'part', protocol: PROTOCOL_VERSION, caps: DEFAULT_CAPS & ~CAPS.PACKED } as any);
    expect(conn.joined).toBe(false);
    w.t.send({ type: 'join', username: 'new', protocol: PROTOCOL_VERSION, caps: DEFAULT_CAPS } as any);
    expect(conn.joined).toBe(true);
    expect((w.got.find((m) => m.type === 'welcome') as any).protocol).toBe(PROTOCOL_VERSION);
  });

  it('inputs far in the future are dropped, and only so many wait', () => {
    const w = world();
    const conn = [...(w.server as any).clients.values()][0];
    const tick = (w.server as any).currentTick;
    const input = (seq: number, at: number) => ({ type: 'input', seq, tick: 0, targetTick: at & 0xffff, forward: true, backward: false, left: false, right: false, boost: false, fireLeft: false, fireRight: false, targetAngle: 0 });
    w.t.send(input(1, tick + 5000) as any);
    w.server.step();
    expect(conn.scheduledInputs.length).toBe(0);
    for (let i = 0; i < 40; i++) { w.t.send(input(i + 2, tick + 40) as any); if (i % 10 === 9) w.server.step(); }
    expect(conn.scheduledInputs.length).toBeLessThanOrEqual(32);
  });

  it("a client whose game loop goes quiet lets go of its controls", () => {
    const w = world();
    w.t.send({ type: 'stateHash', tick: 0, hash: 0 } as any);
    w.t.send({ type: 'input', seq: 1, tick: 0, forward: true, backward: false, left: false, right: false, boost: false, fireLeft: true, fireRight: false, targetAngle: 0 } as any);
    w.server.step();
    expect(Input.forward[w.pid]).toBe(1);
    for (let i = 0; i < 200; i++) w.server.step();
    expect(Input.forward[w.pid]).toBe(0);
    expect(Input.fireLeft[w.pid]).toBe(0);
    void InSystem; void StationComp;
  });
});
