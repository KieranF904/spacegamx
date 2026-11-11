import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { Position, Velocity, InSystem, insideTerrain, ventAge, ventPhase, countOf, type DenCacheData, type DenVentsData, type ServerMessage } from '@space-game/common';
import { GameServer } from '../../GameServer.js';
import { GameData } from '../../data/GameData.js';
import { LocalTransport } from '../../net/LocalTransport.js';
import { readGameDataFiles } from '../../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../../ships/loadShipConfig.js';
import { createShipBridge } from '../../ships/createShipBridge.js';
import { crustBlueprint, rollCache } from './crustCache.js';
import { makeServer } from '../../testkits/world.testkit.js';

const dataDir = join(__dirname, '../../../../data');
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const files = readGameDataFiles(dataDir);
const CAVE = 'ashfall_cavern';
const cave = (files.systems as { systems: { id: string; den?: (DenVentsData | DenCacheData)[]; surface?: { landing?: { x: number; y: number } } }[] }).systems.find((s) => s.id === CAVE)!;
const vents = cave.den!.find((d) => d.kind === 'vents') as DenVentsData;
const cache = cave.den!.find((d) => d.kind === 'cache') as DenCacheData;
const KILN = { x: -10500, y: 9000 };

function world() {
  resetGlobals();
  const server = makeServer();
  const t = new LocalTransport(server);
  const got: ServerMessage[] = [];
  t.onMessage = (m) => got.push(m);
  t.connect();
  t.send({ type: 'join', username: 'kilnward' } as any);
  const pid = t.getPlayerId();
  const gd = server['gameData'];
  const num = gd.getSystemNum(CAVE);
  const conn = server.pilots.connOf(pid)!;
  server['admin'].god.add(conn as any);
  const step = (n = 1, hold?: { x: number; y: number }) => {
    for (let i = 0; i < n; i++) { if (hold) place(pid, num, hold.x, hold.y); server.step(); }
  };
  return { server, got, pid, step, num, gd, conn, terrain: gd.terrain(CAVE)!, bridge: server.getShips() };
}

const place = (pid: number, num: number, x: number, y: number) => {
  InSystem.systemId[pid] = num; Position.x[pid] = x; Position.y[pid] = y; Velocity.x[pid] = 0; Velocity.y[pid] = 0;
};

/** The crust's body now (-1: none) */
const crustOf = (server: GameServer) => {
  for (let e = 0; e < 20000; e++) if (server.dens.nameOf(e)) return e;
  return -1;
};

describe('the Kiln (the Pyreclast cavern\'s side chamber)', () => {
  it('is open ground joined to the canyon by its tunnel, and you can fly there from where you land', () => {
    const { terrain: t } = world();
    // Its middle, its vents and its cache are open; so is the tunnel's length
    expect(insideTerrain(t, KILN.x, KILN.y, 2500)).toBe(false);
    for (const [x, y] of vents.at) expect(insideTerrain(t, x, y, 400)).toBe(false);
    for (let k = 0; k <= 10; k++) expect(insideTerrain(t, -3500 + (KILN.x + 3500) * (k / 10), 7800 + (KILN.y - 7800) * (k / 10), 600)).toBe(false);
    // A ship's way from the landing to the Kiln (a flood over open ground, a ship's width clear)
    const land = cave.surface!.landing!, G = 400, R = 31500, n = Math.ceil((2 * R) / G);
    const cell = (x: number, y: number) => [Math.floor((x + R) / G), Math.floor((y + R) / G)];
    const seen = new Uint8Array(n * n), stack = [cell(land.x, land.y)];
    const [gi, gj] = cell(KILN.x, KILN.y);
    let reached = false;
    while (stack.length && !reached) {
      const [i, j] = stack.pop()!;
      if (i < 0 || j < 0 || i >= n || j >= n || seen[j * n + i]) continue;
      seen[j * n + i] = 1;
      if (insideTerrain(t, -R + (i + 0.5) * G, -R + (j + 0.5) * G, 150)) continue;
      if (i === gi && j === gj) reached = true;
      stack.push([i + 1, j], [i - 1, j], [i, j + 1], [i, j - 1]);
    }
    expect(reached).toBe(true);
  });

  it('its vents erupt in a fixed cycle from the tick: each glows first, then burns everything within its reach and nothing past it', () => {
    // The cycle: every vent once, each a turn apart, the same at every tick of every cycle
    const n = vents.order.length * vents.every;
    for (let i = 0; i < vents.at.length; i++) {
      expect(ventPhase(vents, i, vents.order.indexOf(i) * vents.every)).toBe('tell');
      expect(ventPhase(vents, i, vents.order.indexOf(i) * vents.every + vents.tell)).toBe('burn');
      expect(ventPhase(vents, i, vents.order.indexOf(i) * vents.every + vents.tell + vents.burn)).toBe('quiet');
      for (const t of [5, 333, 1000]) expect(ventAge(vents, i, t + 7 * n)).toBe(ventAge(vents, i, t));
    }
    const { server, got, pid, step, num } = world();
    const [vx, vy] = vents.at[0];
    // A pilot just outside vent 0's reach (and well clear of every other vent): a whole cycle, and never set alight
    const out = { x: vx + (vx - KILN.x) / 900 * (vents.radius + 120), y: vy + (vy - KILN.y) / 900 * (vents.radius + 120) };
    for (const [x, y] of vents.at.slice(1)) expect(Math.hypot(out.x - x, out.y - y)).toBeGreaterThan(vents.radius);
    step(1, out);
    got.length = 0;
    step(n + 10, out);
    expect(got.some((m) => m.type === 'ignite' && (m as any).bodyId === pid)).toBe(false);
    // ...though every vent told and erupted (each tell sent as its turn starts, a circle on its spot, its reach)
    const tells = got.filter((m) => m.type === 'bossTelegraph' && (m as any).kind === 'vent') as any[];
    for (const [x, y] of vents.at) expect(tells.some((m) => m.x === x && m.y === y && m.radius === vents.radius && m.ticks === vents.tell)).toBe(true);
    // Inside its reach: lit only once it bursts, never during its tell
    const inside = { x: vx + (vx - KILN.x) / 900 * 150, y: vy + (vy - KILN.y) / 900 * 150 };
    const k0 = vents.order.indexOf(0) * vents.every, now = server.currentTick;
    const start = now + 20 + ((((k0 - now - 20) % n) + n) % n);
    step(start - now - 10, inside);
    got.length = 0;
    let firstLit = -1, tellAt = -1;
    for (let i = 0; i < vents.tell + vents.burn + 10; i++) {
      step(1, inside);
      if (tellAt < 0 && got.some((m) => m.type === 'bossTelegraph' && (m as any).x === vx && (m as any).y === vy)) tellAt = server.currentTick;
      if (firstLit < 0 && got.some((m) => m.type === 'ignite' && (m as any).bodyId === pid)) firstLit = server.currentTick;
    }
    expect(tellAt).toBeGreaterThan(0);
    expect(firstLit).toBeGreaterThan(0);
    // (the tick each was sent on is the tick the server stepped)
    expect(firstLit - tellAt).toBe(vents.tell);
    expect(ventPhase(vents, 0, tellAt)).toBe('tell');
    expect(ventPhase(vents, 0, firstLit)).toBe('burn');
    expect(server.getShips().burning().some((b) => b.eid === pid)).toBe(true);
  }, 120_000);

  it('its crust cracks far faster at higher penetration, and pays each pilot who hurt it once per 20 minutes', () => {
    const { server, got, pid, step, conn, bridge } = world();
    const by = { x: cache.x + 900, y: cache.y - 1700 };
    step(40, by);
    /** Wear the crust at a level 30 rig's 260 raw DPS, every shot on its near face, until it cracks: the seconds it took */
    const wear = (pen: number) => {
      const eid = crustOf(server);
      expect(eid).toBeGreaterThanOrEqual(0);
      for (let tick = 1; tick < 60 * 400; tick++) {
        const ship = bridge.get(eid);
        if (!ship || server.dens.nameOf(eid) === undefined) return tick / 60;
        let part = -1, best = -Infinity;
        ship.blueprint.parts.forEach((p, i) => { if (ship.hp[i] > 0 && !ship.detached[i] && ship.derived.alive[i] && p.x - p.y * 0.5 > best) { best = p.x - p.y * 0.5; part = i; } });
        bridge.damagePartBy(eid, part, 260 / 60, pid, { type: 'kinetic', pen });
        if (tick % 4 === 0) step(1, by);
      }
      return Infinity;
    };
    const fast = wear(4);
    expect(fast).toBeGreaterThan(18);
    expect(fast).toBeLessThan(40);
    // Paid: ceramic plates (2-4) and coolant, into station storage
    const store = () => server.pilots.get(conn)!.storage;
    expect(countOf(store(), 'ceramic_plate')).toBeGreaterThanOrEqual(2);
    expect(countOf(store(), 'ceramic_plate')).toBeLessThanOrEqual(4);
    expect(countOf(store(), 'coolant')).toBeGreaterThanOrEqual(2);
    const plates = countOf(store(), 'ceramic_plate');
    // Gone a while, then grown back
    step(60, by);
    expect(crustOf(server)).toBe(-1);
    step(cache.regrowSeconds * 60, by);
    expect(crustOf(server)).toBeGreaterThanOrEqual(0);
    // At pen 2.5 it takes far longer; cracked again inside 20 minutes, it pays this pilot nothing
    got.length = 0;
    const slow = wear(2.5);
    if (process.env.KILN_DEBUG) console.log('KILN crack seconds', { fast, slow });
    expect(slow).toBeGreaterThan(70);
    expect(slow).toBeLessThan(120);
    expect(slow / fast).toBeGreaterThan(2.5);
    expect(countOf(store(), 'ceramic_plate')).toBe(plates);
    expect(got.some((m) => m.type === 'toast' && /emptied it recently/.test((m as any).text ?? (m as any).message ?? ''))).toBe(true);
    // Twenty minutes on, it pays again
    step(cache.regrowSeconds * 60 + 60, by);
    server.currentTick += cache.everyMinutes * 3600;
    step(60, by);
    wear(4);
    expect(countOf(store(), 'ceramic_plate')).toBeGreaterThan(plates);
  }, 300_000);

  it('its loot is what the den promises: ceramic plates, coolant, titanium plates, now and then a Cinder component', () => {
    let ash = 0;
    for (let s = 1; s <= 400; s++) {
      const bag = rollCache(cache, s * 7919);
      expect(bag.ceramic_plate).toBeGreaterThanOrEqual(2);
      expect(bag.ceramic_plate).toBeLessThanOrEqual(4);
      expect(bag.coolant).toBeGreaterThanOrEqual(1);
      if (bag.cinder_ash) ash++;
    }
    expect(ash).toBeGreaterThan(20);
    expect(ash).toBeLessThan(120);
    // The crust is armour 5: a grade 4 material on the armour function
    const parts = crustBlueprint(cache).parts;
    expect(parts.filter((p) => p.fn === 'core').length).toBe(1);
    expect(parts.length).toBeLessThanOrEqual(256);
  });

  it('the den\'s packs come out in open ground in the canyon and the Kiln, stay at their posts, and keep clear of the basin and the vault', () => {
    const { server, pid, step, num, terrain: t, gd } = world();
    const land = cave.surface!.landing!;
    step(1, land);
    // (its packs, not the boss in its vault)
    const foes = () => [...((server.enemies as any).enemies as Map<number, { boss?: string }>).entries()].filter(([e, f]) => !f.boss && InSystem.systemId[e] === num && server.getShips().has(e)).map(([e]) => e);
    step(60, land);
    const first = foes();
    // Six posts, a pack at each: two Clinkers in the Kiln, two Rays at its tunnel, pairs along the canyon
    expect(first.length).toBeGreaterThanOrEqual(12);
    const check = (list: number[]) => {
      for (const e of list) {
        const x = Position.x[e], y = Position.y[e], r = server.getShips().get(e)!.derived.radius;
        expect(insideTerrain(t, x, y, r * 0.5), `${e} at ${Math.round(x)}, ${Math.round(y)}`).toBe(false);
        // Clear of the vault's mouth (its barrier crosses the canyon about (0, -5800)) and of the basin
        expect(y).toBeGreaterThan(-2000);
        expect(Math.hypot(x - land.x, y - land.y)).toBeGreaterThan(6000);
      }
    };
    check(first);
    const kiln = first.filter((e) => Position.x[e] < -6000);
    expect(kiln.length).toBe(4);
    expect(kiln.filter((e) => ((server.enemies as any).enemies.get(e) as { type: string }).type === 'clinker').length).toBe(2);
    // A while later (nobody near them), still at their posts, never in the rock
    step(60 * 30, land);
    const later = foes();
    check(later);
    const posts = (gd.getSystem(CAVE)!.nests ?? []).map((nst) => ({ x: Math.cos(nst.orbit.phase) * nst.orbit.radius, y: Math.sin(nst.orbit.phase) * nst.orbit.radius }));
    for (const e of later) expect(Math.min(...posts.map((p) => Math.hypot(Position.x[e] - p.x, Position.y[e] - p.y)))).toBeLessThan(1800);
    // A pilot at the tunnel's mouth: the bend's pack and the tunnel's Rays come for it; the Kiln's Clinkers, through
    // the rock, don't; nobody ends up in the rock, and nobody strays far from its post
    const mouth = { x: -3200, y: 7500 };
    const clinkers = later.filter((e) => Position.x[e] < -11000);
    step(60 * 30, mouth);
    const engaged = foes();
    check(engaged.filter((e) => Math.hypot(Position.x[e] - land.x, Position.y[e] - land.y) > 6000));
    for (const e of clinkers) if (server.getShips().has(e)) expect(Math.hypot(Position.x[e] + 12300, Position.y[e] - 9000)).toBeLessThan(1800);
    for (const e of engaged) expect(Math.min(...posts.map((p) => Math.hypot(Position.x[e] - p.x, Position.y[e] - p.y)))).toBeLessThan(5000);
    void pid;
  }, 120_000);
});
