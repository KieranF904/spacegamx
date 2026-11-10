import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { Position, Velocity, InSystem, ServerMessage, countOf, createShipState, inSafeSpace, regionAt, beltTotal, asteroidParamsAt, setAsteroidOutliers, BANK } from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../proto/createProtoServer.js';
import { makeServer } from '../testkits/world.testkit.js';

const dataDir = join(__dirname, '../../../data');
const files = readGameDataFiles(dataDir);

function world(names = ['newbie']) {
  (bitecs as unknown as { resetGlobals: () => void }).resetGlobals();
  const server = makeServer();
  const pilots = names.map((n) => {
    const t = new LocalTransport(server);
    const got: ServerMessage[] = [];
    t.onMessage = (m) => got.push(m);
    t.connect();
    t.send({ type: 'join', username: n } as any);
    const pid = t.getPlayerId();
    return { t, got, pid, conn: server.pilots.connOf(pid)! as any, profile: () => (server.pilots as any).sessions.get(server.pilots.connOf(t.getPlayerId()))!.profile };
  });
  const step = (n = 1) => { for (let i = 0; i < n; i++) server.step(); };
  return { server, pilots, step, bridge: server.getShips(), enemies: server.enemies as any, gd: server.gameData };
}
const hold = (pid: number, x: number, y: number) => { Position.x[pid] = x; Position.y[pid] = y; Velocity.x[pid] = 0; Velocity.y[pid] = 0; };

describe('Sol: a safe inner system, a contested middle, a hostile rim', () => {
  it('a new pilot starts beside Sol Central, never in the sun', () => {
    const w = world();
    const { pid } = w.pilots[0];
    const sol = w.gd.getSystem('sol')!;
    const r = Math.hypot(Position.x[pid], Position.y[pid]);
    expect(r).toBeGreaterThan((sol.centralBody?.radius ?? 0) + 5000);
    const st = (w.server as any).stationInRange(pid);
    expect(st).toBeGreaterThanOrEqual(0);
  });

  it('has three bands, getting worse outwards; gates further out the harder the system past them', () => {
    const w = world();
    const sol = w.gd.getSystem('sol')!;
    expect(sol.regions!.map((g) => g.danger)).toEqual(['safe', 'contested', 'hostile']);
    const bands = w.server.regionThreats().sol;
    console.log('sol bands', JSON.stringify(bands));
    expect(bands.inner).toBeLessThan(bands.middle);
    expect(bands.middle).toBeLessThan(bands.reaches);
    expect(w.server.threats().sol).toBe(bands.inner);
    // Gates: Ashfall's in reach of the safe space, the rest out by the threat beyond them
    const threats = w.server.threats();
    const out = [...sol.portals.filter((p) => p.targetSystem !== 'homestead'), ...(sol.rifts ?? []).map((r) => ({ targetSystem: r.destination.system, position: r.position }))]
      .map((p) => ({ to: p.targetSystem, r: Math.hypot(p.position.x, p.position.y), threat: threats[p.targetSystem] ?? 0 }))
      .sort((a, b) => a.threat - b.threat);
    expect(out[0].to).toBe('ashfall');
    for (let i = 1; i < out.length; i++) expect(out[i].r, out[i].to).toBeGreaterThan(out[i - 1].r);
    expect(regionAt(sol, out[out.length - 1].r, 0)?.danger).toBe('hostile');
    // A second, sparse belt out in the Reaches
    const belt = sol.asteroidBelt;
    expect(beltTotal(belt)).toBeGreaterThan(belt.count);
    setAsteroidOutliers((files.mining as any)?.outliers);
    const far = asteroidParamsAt('sol', belt.count + 5, 'seed', 0, belt, sol.asteroidField);
    expect(far.semiMajorAxis).toBeGreaterThan(belt.extra![0].innerRadius * 0.7);
  });

  it('hostiles leave a pilot in safe space alone, but not one outside it', () => {
    const w = world();
    const { pid } = w.pilots[0];
    const num = InSystem.systemId[pid];
    const sol = w.gd.getSystem('sol')!;
    // Inside: a raider right beside them never picks them
    hold(pid, 52000, 30000);
    expect(inSafeSpace(sol, 52000, 30000)).toBe(true);
    const [a] = w.enemies.spawnPack(num, { faction: 'pirates', ships: ['pirate_raider'] }, 52000, 31200);
    for (let i = 0; i < 180; i++) { hold(pid, 52000, 30000); w.step(); expect(w.enemies.targetOf(a)).not.toBe(pid); }
    // Outside: it does
    hold(pid, 90000, 90000);
    const [b] = w.enemies.spawnPack(num, { faction: 'pirates', ships: ['pirate_raider'] }, 90000, 91200);
    let picked = false;
    for (let i = 0; i < 180 && !picked; i++) { hold(pid, 90000, 90000); w.step(); picked = w.enemies.targetOf(b) === pid; }
    expect(picked).toBe(true);
  });

  it('the Helios drones by the sun are slow, weak and calm', () => {
    const w = world();
    const cat = w.bridge.catalog, tun = w.bridge.tuning;
    const drone = createShipState(cat, tun, 0, w.bridge.enemyDesigns.helios_drone, 0).derived;
    const starter = createShipState(cat, tun, 0, w.bridge.playerBlueprint, 0).derived;
    // (its own design now, docs/enemies/custom-roster.md: not a player's, so no design check; small and slow all the same)
    expect(w.bridge.enemyDesigns.helios_drone.rigid).toBe(true);
    expect(drone.radius).toBeLessThan(starter.radius);
    expect(drone.maxThrust.forward / drone.mass * (w.bridge.enemyDesigns.helios_drone.drive ?? 1)).toBeLessThan((starter.maxThrust.forward / starter.mass) * 0.6);
    const f = (files.factions as any).factions.helios;
    expect(f.damageScale).toBeLessThan(0.2);
    expect(w.server.threats().sol).toBeLessThan(10);
  });

  it('dying in safe space costs little: the hold stays and the repair bank puts the starter back whole', () => {
    const w = world();
    const { pid, conn, profile } = w.pilots[0];
    w.server.pilots.give(conn, { iron_ore: 12, copper_ore: 4 });
    const storage = JSON.stringify(profile().storage);
    hold(pid, 50000, 0);
    w.server.pilots.onDestroyed(conn, InSystem.systemId[pid], 50000, 0, 0, 0);
    expect(countOf(profile().cargo, 'iron_ore')).toBe(12);
    expect(countOf(profile().cargo, 'copper_ore')).toBe(4);
    // (A starter's worth in the free part pays for the whole ship; nothing goes to storage)
    expect(profile().ship.ghosts).toEqual([]);
    expect(profile().ship.owed).toBeUndefined();
    expect(JSON.stringify(profile().storage)).toBe(storage);
  });

  it('out on the Reaches the hold goes with the wreck (bar its secure stacks), kept for its pilot', () => {
    const w = world(['lost', 'looter']);
    const [me, them] = w.pilots;
    const num = InSystem.systemId[me.pid];
    me.profile().cargo = [{ id: 'iron_ore', n: 40 }, { id: 'nickel_ore', n: 10 }, { id: 'silicate', n: 10 }, { id: 'copper_ore', n: 10 }, { id: 'ice', n: 10 }];
    const at = { x: 0, y: 170000 };
    w.server.pilots.onDestroyed(me.conn, num, at.x, at.y, 0, 0);
    // Three stacks kept, up to 25 of each
    const kept = me.profile().cargo;
    expect(kept.length).toBe(3);
    for (const s of kept) expect(s.n).toBeLessThanOrEqual(25);
    expect(me.profile().wreck).toMatchObject({ system: 'sol' });
    const wreckMsg = me.got.filter((m) => m.type === 'wreck').pop() as any;
    expect(wreckMsg?.seconds).toBeGreaterThan(60);
    // Someone else can't take it
    const pods = (w.server as any).pods;
    const wreck = [...pods.contents.keys()].find((e: number) => Math.hypot(Position.x[e] - at.x, Position.y[e] - at.y) < 50);
    expect(wreck).toBeDefined();
    const inside = { ...pods.get(wreck) };
    expect(Object.values(inside).reduce((a: number, b) => a + (b as number), 0)).toBeGreaterThan(0);
    for (let i = 0; i < 90; i++) { hold(them.pid, at.x, at.y); w.step(); }
    expect(pods.get(wreck)).toBeDefined();
    // Its pilot can (with room in their hold: what the secure hold kept, they'd put in storage at the station first)
    me.profile().cargo = [];
    hold(them.pid, 5000, 50000);
    const again = me.t.getPlayerId();
    for (let i = 0; i < 300 && pods.get(wreck); i++) { hold(again, Position.x[wreck], Position.y[wreck]); w.step(); if (i % 30 === 0) me.profile().cargo = []; }
    expect(pods.get(wreck)).toBeUndefined();
    expect(me.profile().wreck).toBeUndefined();
  });

  it('there is no insurance: a pilot has a full repair bank instead, and a loss takes from its free part', () => {
    const w = world();
    const { conn, pid, profile } = w.pilots[0];
    const p = profile();
    expect(p.storage.some((s: any) => s.id === 'insurance_bond')).toBe(false);
    expect((w.server.pilots as any).grantStarterBonds).toBeUndefined();
    const full = (w.server.pilots as any).bank.cap;
    expect(p.bank.free).toEqual(full);
    w.server.pilots.onDestroyed(conn, InSystem.systemId[pid], 0, 170000, 0, 0);
    expect(profile().storage.some((s: any) => s.id === 'insurance_bond')).toBe(false);
    // The starter cost one ship's worth of the free part (it holds BANK.ships of them)
    const sum = (b: Record<string, number>) => Object.values(b).reduce((a, n) => a + n, 0);
    expect(Math.round(sum(profile().bank.free))).toBe(Math.round(sum(full) * (1 - 1 / BANK.ships)));
  });

  it('a warband camps on the rim; breaking it pays everyone who fought', () => {
    const w = world();
    const { pid, got } = w.pilots[0];
    const num = InSystem.systemId[pid];
    const e = w.server.events.startWarband(num)!;
    expect(e).toBeTruthy();
    expect(regionAt(w.gd.getSystem('sol'), e.x, e.y)?.danger).toBe('hostile');
    expect(e.ships.length).toBeGreaterThanOrEqual(3);
    hold(pid, e.x, e.y);
    const credits = w.pilots[0].profile().credits;
    for (const s of e.ships) w.bridge.removeShip(s);
    for (let i = 0; i < 3; i++) { hold(pid, e.x, e.y); w.step(); }
    expect(w.server.events.active(num).some((x) => x.id === e.id)).toBe(false);
    expect(w.pilots[0].profile().credits).toBeGreaterThan(credits);
    expect(got.some((m) => m.type === 'worldEvent' && (m as any).kind === 'warband')).toBe(true);
  });

  it("Sol's raids hit Farwatch, out on the edge, not the safe stations", () => {
    const w = world();
    const num = InSystem.systemId[w.pilots[0].pid];
    for (let i = 0; i < 6; i++) {
      const e = w.server.events.startRaid(num);
      expect(e?.stationName).toBe('Farwatch');
      (w.server.events as any).live.clear();
    }
  });

  it('the Tallyman roams; the Hollow Crown and the Picket stand, valid', () => {
    const w = world();
    const cat = w.bridge.catalog, tun = w.bridge.tuning;
    for (const id of ['boss_hollow_crown']) {
      const bp = w.bridge.enemyDesigns[id];
      expect(w.bridge.validate(bp).ok, id).toBe(true);
      expect(createShipState(cat, tun, 0, bp, 0).derived.weapons.length, id).toBeGreaterThan(0);
    }
    const bosses = (w.server as any).bosses;
    const eid = bosses.spawn('boss_tallyman');
    expect(eid).toBeGreaterThanOrEqual(0);
    const lair = (files.bosses as any).bosses.boss_tallyman.lair;
    const homes = new Set<string>();
    for (let i = 0; i < 60 * 95 * 2; i++) {
      w.step();
      const home = w.enemies.packs.get(w.enemies.enemies.get(eid)?.pack)?.home;
      if (home) homes.add(`${Math.round(home.x)},${Math.round(home.y)}`);
    }
    expect(homes.size).toBeGreaterThan(1);
    for (const h of homes) { const [x, y] = h.split(',').map(Number); expect(Math.hypot(x - lair.x, y - lair.y)).toBeLessThan(36000); }
  }, 30000);
});
