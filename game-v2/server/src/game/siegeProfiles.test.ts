import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { Position, Velocity, InSystem, ServerMessage, planetPosition, moonOffset } from '@space-game/common';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { wavePlan, waveRoster, siegeBoss, siegeProfile, DEFAULT_SIEGE_RULES } from './Sieges.js';
import { makeServer } from '../testkits/world.testkit.js';

const dataDir = join(__dirname, '../../../data');
const files = readGameDataFiles(dataDir);

function world() {
  (bitecs as unknown as { resetGlobals: () => void }).resetGlobals();
  const gameData = new GameData(files);
  const server = makeServer({
    gameData, });
  const join = (name: string) => {
    const t = new LocalTransport(server);
    const got: ServerMessage[] = [];
    t.onMessage = (m) => got.push(m);
    t.connect();
    t.send({ type: 'join', username: name } as any);
    return { t, got, conn: server.pilots.connOf(t.getPlayerId())! };
  };
  const step = (n = 1) => { for (let i = 0; i < n; i++) server.step(); };
  const overSelene = (pid: number) => {
    const sol = gameData.getSystem('sol')!;
    const planet = sol.planets!.find((p) => p.id === 'terra_nova')!;
    const tick = (server as any).currentTick;
    const p = planetPosition(planet, tick), o = moonOffset(planet, 0, tick);
    InSystem.systemId[pid] = gameData.getSystemNum('sol');
    Position.x[pid] = p.x + o.x + 500; Position.y[pid] = p.y + o.y; Velocity.x[pid] = 0; Velocity.y[pid] = 0;
  };
  return { server, gameData, join, step, overSelene };
}

/** Down on Selene, alone, by day */
function onSelene() {
  const w = world();
  const a = w.join('ava');
  const pa = a.t.getPlayerId();
  w.overSelene(pa);
  a.t.send({ type: 'interact' } as any);
  w.step(12);
  const num = InSystem.systemId[pa];
  return { ...w, a, pa, num, run: w.server.sieges.runOf(num)! as any };
}

/** Bring on a night (`night`: which, by setting the nights held) */
function night(s: ReturnType<typeof onSelene>, n: number) {
  s.run.wave = n - 1;
  s.a.t.send({ type: 'siege', action: 'ready' } as any);
  s.step(12 + 60 * 7);
  expect(s.run.phase).toBe('night');
  // (The first front is seen coming a few seconds before it arrives)
  s.step(60 * 5);
}

describe('siege profiles', () => {
  it('every moon has its own siege, and everything they send exists and pays', () => {
    const { server, gameData } = world();
    const designs = server.getShips().enemyDesigns;
    const factions = (gameData.factionsFile as any).factions;
    const rules = server.sieges.rules;
    const used = new Set<string>();
    for (const sys of gameData.getAllSystems?.() ?? (files.systems as any).systems) {
      const b = sys.surface?.bastion;
      if (!b) continue;
      expect(rules.profiles[b.profile], `${sys.id}'s profile`).toBeDefined();
      used.add(b.profile);
      // Pads clear of each other and of the bastion
      for (const [i, p] of b.slots.entries()) {
        expect(Math.hypot(p.x, p.y), `${sys.id} pad ${i}`).toBeGreaterThan(350);
        for (const q of b.slots.slice(i + 1)) expect(Math.hypot(p.x - q.x, p.y - q.y), `${sys.id} pads`).toBeGreaterThan(260);
      }
    }
    expect(used.size).toBe(5);
    for (const [id, P] of Object.entries(rules.profiles)) {
      for (const u of [...P.roster, ...P.bosses.ships, { ship: P.objectives.nest.design, faction: P.objectives.nest.faction }]) {
        expect(designs[u.ship], `${id}: ${u.ship}`).toBeDefined();
        const f = (u as any).faction ?? Object.keys(factions).find((k) => u.ship in factions[k].ships);
        expect(f && factions[f].ships[u.ship], `${id}: ${u.ship} pays`).toBeDefined();
      }
    }
  });

  it('nights grow faster than they used to, get tougher kinds, and bosses come on their nights', () => {
    const P = siegeProfile(DEFAULT_SIEGE_RULES, 'selene');
    const cost = (n: number) => wavePlan(n, 1, () => 0.5, DEFAULT_SIEGE_RULES, P).reduce((a, u) => a + u.cost, 0);
    // The old night 15 (solo) was a budget of 36
    expect(cost(15)).toBeGreaterThan(70);
    expect(cost(15) / cost(5)).toBeGreaterThan(2.5);
    // Hulks and lobbers turn up before night 10
    const early = new Set(Array.from({ length: 30 }, () => waveRoster(8, 1, Math.random, DEFAULT_SIEGE_RULES, P)).flat());
    expect(early.has('scrap_hulk')).toBe(true);
    expect(early.has('scrap_lobber')).toBe(true);
    expect(siegeBoss(P, 4)).toBeNull();
    expect(siegeBoss(P, 5)?.ship).toBe('boss_scrap_mother');
    expect(siegeBoss(P, 10)?.ship).toBe('boss_rustjaw');
    // The moons differ: Gloam is harder than Selene from the start
    const gloam = siegeProfile(DEFAULT_SIEGE_RULES, 'gloam');
    expect(gloam.difficulty).toBeGreaterThan(P.difficulty);
    expect(new Set(Object.values(DEFAULT_SIEGE_RULES.profiles).map((p) => p.approach.kind)).size).toBeGreaterThanOrEqual(4);
  });

  it('a night comes in fronts down the lanes, streams in between, and a boss comes on its night, tougher by the night', () => {
    const s = onSelene();
    const b = s.gameData.getSystemByNum(s.num)!.surface!.bastion!;
    night(s, 5);
    expect(s.run.boss).toBe('Scrap Mother');
    // The first front is out; more are coming and some stream in
    const first = [...s.run.raiders];
    expect(first.length).toBeGreaterThanOrEqual(2);
    expect(s.run.fronts.length + s.run.stream.length).toBeGreaterThan(0);
    // Down Selene's lanes (north, and two below either side): never from just anywhere
    const lanes = [-90, 30, 150];
    for (const e of first) {
      const a = Math.atan2(Position.y[e] - b.y, Position.x[e] - b.x) * 180 / Math.PI;
      const off = Math.min(...lanes.map((l) => Math.abs(((a - l + 540) % 360) - 180)));
      expect(off, `raider at ${a.toFixed(0)}°`).toBeLessThan(35);
    }
    // The boss is the Mother, at her siege hull
    const ships = s.server.getShips();
    const mother = first.find((e: number) => ships.get(e)?.blueprint.name === 'Scrap Mother');
    expect(mother).toBeDefined();
    // Everything comes, in time
    const total = () => s.run.raiders.length + s.run.stream.length + s.run.fronts.reduce((n: number, f: any) => n + f.ships.length, 0);
    const before = total();
    s.step(60 * 40);
    expect(s.run.stream.length).toBeLessThan(before);
    expect(s.run.fronts.length).toBe(0);
  });

  it('objectives come up out on the moon: hold a supply drop, or burn out a nest, for supplies and haul', () => {
    const s = onSelene();
    s.run.profile = { ...s.run.profile, objectives: { ...s.run.profile.objectives, kinds: ['cache'] } };
    night(s, 3);
    // Nothing shooting at us (one held back, far off, so the night goes on)
    for (const r of s.run.raiders) s.server.getShips().removeShip(r);
    s.run.fronts = [];
    s.run.stream = [{ ship: 'scrap_mite', hp: 1 }];
    s.run.nextStream = Infinity;
    s.run.nextObjective = 0;
    s.step(11);
    const o = s.run.objective;
    expect(o?.kind).toBe('cache');
    expect(s.a.got.some((m) => m.type === 'objective' && (m as any).id === `moonobj:${s.num}`)).toBe(true);
    const supplies = s.run.supplies;
    // Sit on it
    for (let i = 0; i < 60 * 10 && s.run.objective; i++) {
      Position.x[s.pa] = o.x; Position.y[s.pa] = o.y; Velocity.x[s.pa] = 0; Velocity.y[s.pa] = 0;
      s.step(1);
    }
    expect(s.run.objective).toBeNull();
    expect(s.run.supplies).toBeGreaterThan(supplies + 40);
    expect(s.run.haul.get(s.a.conn).credits).toBeGreaterThan(0);
    // A nest: it sends raiders until it's burned out
    s.run.profile = { ...s.run.profile, objectives: { ...s.run.profile.objectives, kinds: ['nest'] } };
    s.run.nextObjective = 0;
    s.step(11);
    const nest = s.run.objective;
    expect(nest?.kind).toBe('nest');
    const ships = s.server.getShips();
    expect(ships.has(nest.eid)).toBe(true);
    const at = { x: Position.x[nest.eid], y: Position.y[nest.eid] };
    s.step(60 * 8);
    expect(s.run.extras.length).toBeGreaterThan(0);
    // Pinned where it burrowed
    expect(Math.hypot(Position.x[nest.eid] - at.x, Position.y[nest.eid] - at.y)).toBeLessThan(1);
    const before = s.run.supplies;
    ships.damagePartFraction(nest.eid, ships.get(nest.eid)!.blueprint.parts.findIndex((p) => p.fn === 'core'), 1);
    s.step(20);
    expect(s.run.objective).toBeNull();
    expect(s.run.supplies).toBeGreaterThan(before + 60);
  });
});
