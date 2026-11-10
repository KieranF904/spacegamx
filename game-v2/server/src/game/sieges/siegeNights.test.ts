import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { Position, Velocity, InSystem, ServerMessage, planetPosition, moonOffset } from '@space-game/common';
import { GameData } from '../../data/GameData.js';
import { LocalTransport } from '../../net/LocalTransport.js';
import { readGameDataFiles } from '../../data/loadGameDataFromDisk.js';
import { DEFAULT_SIEGE_RULES, SIEGE_STRINGS } from './rules.js';
import { frontCount, siegeProfile, unitSpawns } from './plan.js';
import { ROLES } from './roles/index.js';
import { OBJECTIVES } from './objectives/index.js';
import { TURRET_ORDERS, pickTarget } from './turrets.js';
import { makeServer } from '../../testkits/world.testkit.js';

const dataDir = join(__dirname, '../../../../data');
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
  const b = w.gameData.getSystemByNum(num)!.surface!.bastion!;
  const run = w.server.sieges.runOf(num)! as any;
  const siege = (m: Record<string, unknown>) => { a.t.send({ type: 'siege', ...m } as any); w.step(1); };
  /** Hold the pilot still at a point (relative to the bastion) for n ticks */
  const hold = (x: number, y: number, n: number) => {
    for (let i = 0; i < n; i++) { Position.x[pa] = b.x + x; Position.y[pa] = b.y + y; Velocity.x[pa] = 0; Velocity.y[pa] = 0; w.step(1); }
  };
  const last = () => [...a.got].reverse().find((m) => m.type === 'siegeState' && (m as any).active) as any;
  return { ...w, a, pa, num, b, run, siege, hold, last };
}

/** Bring on night n: dusk (planned), then night falls */
function toDusk(s: ReturnType<typeof onSelene>, n: number) {
  s.run.wave = n - 1;
  s.siege({ action: 'ready' });
  s.step(11);
  expect(s.run.phase).toBe('dusk');
}
function toNight(s: ReturnType<typeof onSelene>, n: number) {
  toDusk(s, n);
  s.step(60 * 7);
  expect(s.run.phase).toBe('night');
}

/** Knock a ship's every part down to `k` of what it has */
function wound(s: ReturnType<typeof onSelene>, eid: number, k: number) {
  const sh = s.server.getShips().get(eid)!;
  sh.hp.forEach((h, i) => { sh.hp[i] = h * k; });
}

/** A hostile of the run's, by hand (as a front would bring it) */
function raider(s: ReturnType<typeof onSelene>, ship: string, x: number, y: number, extra: Record<string, unknown> = {}): number {
  const [e] = (s.server as any).sieges.host.spawnHostiles(s.num, [{ ship, hp: 1, cost: 1, ...extra }], s.b.x + x, s.b.y + y, { x: s.b.x, y: s.b.y }, 1);
  s.run.raiders.push(e);
  (s.server as any).sieges.track(s.run, e, { ship, cost: (extra.cost as number) ?? 1, boss: extra.boss, front: -1, role: extra.role });
  return e;
}

describe('siege upgrades: building, orders, the night', () => {
  it('every role, objective and order the data names exists, with its text', () => {
    const rules = makeServer({
      gameData: new GameData(files), userDB: {} as any, }).sieges.rules;
    for (const R of [rules, DEFAULT_SIEGE_RULES]) {
      for (const [id, P] of Object.entries(R.profiles)) {
        for (const u of P.roster) if (u.role) expect(ROLES[u.role], `${id}: ${u.ship} role ${u.role}`).toBeDefined();
        for (const k of P.objectives.kinds) expect(OBJECTIVES[k], `${id}: objective ${k}`).toBeDefined();
      }
    }
    for (const r of Object.keys(ROLES)) {
      expect((SIEGE_STRINGS as Record<string, string>)[`sieges.role.${r}`]).toBeDefined();
      expect((SIEGE_STRINGS as Record<string, string>)[`sieges.role.${r}Note`]).toBeDefined();
    }
    for (const o of Object.keys(TURRET_ORDERS)) expect((SIEGE_STRINGS as Record<string, string>)[`sieges.orders.${o}`]).toBeDefined();
    // The data's rosters carry the roles (rules.json is what the server runs)
    expect(siegeProfile(rules, 'selene').roster.find((u) => u.ship === 'scrap_swarmer')?.role).toBe('runner');
    // A role starts on its night: Selene's crawlers sap from night 4
    const crawler = siegeProfile(rules, 'selene').roster.find((u) => u.ship === 'scrap_crawler')!;
    expect(unitSpawns(crawler, siegeProfile(rules, 'selene'), 3)[0].role).toBeUndefined();
    expect(unitSpawns(crawler, siegeProfile(rules, 'selene'), 4)[0].role).toBe('sapper');
  });

  it('builds on the pad you pick; at night only near the pad, dearer', () => {
    const s = onSelene();
    s.run.supplies = 1000;
    s.siege({ action: 'buy', item: 'turret_cannon', pad: 4 });
    expect(s.run.turrets[4]?.kind).toBe('cannon');
    expect(s.run.turrets[0]).toBeNull();
    // Taken: refused, nothing spent
    s.siege({ action: 'buy', item: 'turret_flak', pad: 4 });
    expect(s.run.turrets[4]?.kind).toBe('cannon');
    expect(s.run.supplies).toBe(900);
    // No pad: the first free one, as before
    s.siege({ action: 'buy', item: 'turret_flak' });
    expect(s.run.turrets[0]?.kind).toBe('flak');
    toNight(s, 1);
    const before = s.run.supplies;
    // Far from pad 2: refused
    s.hold(0, 3000, 1);
    s.siege({ action: 'buy', item: 'turret_cannon', pad: 2 });
    expect(s.run.turrets[2]).toBeNull();
    // Beside it: built, at 1.5x
    const pad = s.b.slots[2];
    s.hold(pad.x, pad.y + 300, 1);
    s.siege({ action: 'buy', item: 'turret_cannon', pad: 2 });
    expect(s.run.turrets[2]?.kind).toBe('cannon');
    expect(s.run.supplies).toBe(before - 150);
    // The day's other business waits
    s.siege({ action: 'upgrade', pad: 2 });
    expect(s.run.turrets[2]?.mark).toBe(0);
  });

  it('a pilot staying beside a damaged turret mends it under fire, for supplies; the bastion too', () => {
    const s = onSelene();
    s.siege({ action: 'buy', item: 'turret_cannon', pad: 1 });
    toNight(s, 1);
    const ships = s.server.getShips();
    const t = s.run.turrets[1];
    wound(s, t.eid, 0.5);
    const hull = ships.integrity(t.eid);
    expect(s.server.sieges.host.shipAt(t.eid)!.hull).toBeLessThan(0.9);
    s.run.supplies = 100;
    const pad = s.b.slots[1];
    // Two seconds: not yet (the panel shows how far it's got)
    s.hold(pad.x + 250, pad.y, 120);
    expect(s.run.supplies).toBe(100);
    expect(s.last().turrets[1].mend).toBeGreaterThan(0.4);
    s.hold(pad.x + 250, pad.y, 70);
    expect(s.run.supplies).toBe(80);
    expect(ships.integrity(t.eid)).toBeGreaterThan(hull);
    // Fly off and it starts over
    s.hold(0, 3000, 20);
    expect(s.run.mend.has(1)).toBe(false);
    // The bastion (from its far side, clear of the turret): in its last stand the first mend is free
    wound(s, s.run.bastion, 0.2);
    s.step(10);
    expect(s.run.breach).toBe(true);
    expect(s.last().breach).toBe(true);
    s.hold(0, -450, 60 * 5 + 20);
    expect(s.run.supplies).toBe(80);
    expect(s.run.freeMend).toBe(false);
    // The next one costs
    s.hold(0, -450, 60 * 5 + 20);
    expect(s.run.supplies).toBe(80 - DEFAULT_SIEGE_RULES.night.bastionMend.cost);
  });

  it('turrets fire as ordered, and on the hostile a pilot marks (focus fire, a party cooldown)', () => {
    const s = onSelene();
    s.run.supplies = 1000;
    s.siege({ action: 'buy', item: 'turret_missile', pad: 1 });
    toNight(s, 1);
    // Nothing else tonight
    for (const r of s.run.raiders) s.server.getShips().removeShip(r);
    s.run.fronts = []; s.run.stream = [{ ship: 'scrap_mite', hp: 1 }]; s.run.nextStream = Infinity; s.run.nextObjective = Infinity;
    s.step(10);
    const pad = s.b.slots[1];
    // (Built to last: the turret's firing on them all the while)
    const near = raider(s, 'scrap_mite', pad.x + 500, pad.y + 200, { cost: 1, hp: 100 });
    const tough = raider(s, 'scrap_hulk', pad.x + 1200, pad.y + 600, { cost: 6, hp: 100 });
    for (const e of [near, tough]) s.server.getShips().pin(e);
    const pick = () => pickTarget(s.server.sieges, s.run, 1, 2400, (s.server as any).currentTick);
    expect(pick()).toBe(near);
    s.siege({ action: 'orders', pad: 1, item: 'toughest' });
    expect(s.run.turrets[1].orders).toBe('toughest');
    expect(pick()).toBe(tough);
    // Orders stay with an upgrade (by day: here, straight on the run)
    s.siege({ action: 'orders', pad: 1, item: 'nearest' });
    expect(pick()).toBe(near);
    // Focus: every turret in reach on the marked one
    s.siege({ action: 'focus', target: tough });
    expect(s.run.focus.target).toBe(tough);
    expect(pick()).toBe(tough);
    expect(s.last().focus.target).toBe(tough);
    // Not again till the cooldown's done
    s.siege({ action: 'focus', target: near });
    expect(s.run.focus.target).toBe(tough);
    // Not something that isn't tonight's
    s.run.focus.readyAt = 0;
    s.siege({ action: 'focus', target: s.pa });
    expect(s.run.focus.target).toBe(tough);
    // Gone after its seconds
    s.step(60 * 9);
    expect(pick()).toBe(near);
  });

  it('dusk plans the night: fronts shown where and when they land, the title card, then the score and dawn summary', () => {
    const s = onSelene();
    s.siege({ action: 'buy', item: 'turret_cannon', pad: 0 });
    toDusk(s, 5);
    const st = s.last();
    expect(st.phase).toBe('dusk');
    expect(st.incoming.length).toBeGreaterThan(0);
    const now = (s.server as any).currentTick;
    for (const f of st.incoming) {
      expect(f.at).toBeGreaterThan(now);
      expect(f.ships).toBeGreaterThan(0);
      expect(Math.hypot(f.x - s.b.x, f.y - s.b.y)).toBeGreaterThan(3000);
    }
    expect(st.incoming.some((f: any) => f.boss)).toBe(true);
    expect(st.tonight.night).toBe(5);
    expect(st.tonight.boss).toBe('Scrap Mother');
    // Night 5 brings skiffs in (Selene's roster), and runners (swarmers) and sappers (crawlers) play their roles
    expect(st.tonight.newKinds.length).toBeGreaterThan(0);
    // The first front lands where it was shown
    const first = st.incoming[0];
    s.step(first.at - now + 2);
    const near = s.run.raiders.filter((e: number) => Math.hypot(Position.x[e] - first.x, Position.y[e] - first.y) < 1600);
    expect(near.length).toBeGreaterThan(0);
    // Kills are counted by who made them: the turret, and the pilot
    const turret = s.run.turrets[0].eid;
    const [k1, k2] = s.run.raiders;
    s.server.sieges.onDestroyed(k1, turret);
    s.server.sieges.onDestroyed(k2, s.pa);
    expect(s.run.tally.kills).toBe(2);
    expect(s.run.tally.byPad.get(0)).toBe(1);
    expect(s.run.tally.byPilot.get(s.a.conn)).toBe(1);
    // Clear the night with nothing lost: a perfect night, and the streak pays at dawn
    const supplies = s.run.supplies;
    s.server.getShips().healAll(s.run.bastion, 1);
    for (let i = 0; i < 80 && s.run.phase === 'night'; i++) {
      for (const r of s.run.raiders) s.server.getShips().removeShip(r);
      s.run.objective = null;
      s.step(30);
    }
    expect(s.run.phase).toBe('day');
    const sum = s.last().summary;
    expect(sum.night).toBe(5);
    expect(sum.kills).toBeGreaterThanOrEqual(2);
    expect(sum.yourKills).toBe(1);
    expect(sum.mvp.kills).toBe(1);
    expect(sum.perfect).toBe(true);
    expect(sum.streak).toBe(1);
    expect(sum.supplies).toBe(Math.round((DEFAULT_SIEGE_RULES.dawn.suppliesBase + DEFAULT_SIEGE_RULES.dawn.suppliesPerNight * 5) * 1.1));
    expect(s.run.supplies).toBeGreaterThanOrEqual(supplies + sum.supplies);
    expect(s.last().score.best).toBe(sum.score);
    expect(sum.score).toBeGreaterThan(0);
  });

  it('roles: sappers go for the nearest turret (then the next), runners ignore pilots for the bastion, escorts guard their front', () => {
    const s = onSelene();
    s.run.supplies = 1000;
    s.siege({ action: 'buy', item: 'turret_cannon', pad: 0 });
    s.siege({ action: 'buy', item: 'turret_cannon', pad: 2 });
    toNight(s, 1);
    for (const r of s.run.raiders) s.server.getShips().removeShip(r);
    s.run.fronts = []; s.run.stream = [{ ship: 'scrap_mite', hp: 1 }]; s.run.nextStream = Infinity; s.run.nextObjective = Infinity;
    const p0 = s.b.slots[0];
    const host = (s.server as any).sieges;
    // A sapper front out past pad 0
    host.spawnFront(s.run, [{ ship: 'scrap_crawler', hp: 1, cost: 3, role: 'sapper' }], { x: s.b.x + p0.x * 6, y: s.b.y + p0.y * 6 }, 1);
    const sap = s.run.raiders[s.run.raiders.length - 1];
    expect(s.run.info.get(sap).prey).toBe(s.run.turrets[0].eid);
    // Pad 0's turret falls: on to pad 2's
    s.server.getShips().removeShip(s.run.turrets[0].eid);
    s.step(20);
    expect(s.run.tally.turretsLost).toBe(1);
    expect(s.last().padsLost).toContain(0);
    expect(s.run.info.get(sap).prey).toBe(s.run.turrets[2].eid);
    // A runner: on the bastion, and nothing else
    host.spawnFront(s.run, [{ ship: 'scrap_swarmer', hp: 1, cost: 1, role: 'runner' }], { x: s.b.x, y: s.b.y - 4000 }, 2);
    const run = s.run.raiders[s.run.raiders.length - 1];
    const e = (s.server as any).enemies.enemies.get(run);
    expect(e.prey).toBe(s.run.bastion);
    expect(e.preyOnly).toBe(true);
    // An escort front: they follow its biggest ship
    host.spawnFront(s.run, [{ ship: 'scrap_hulk', hp: 1, cost: 6 }, { ship: 'scrap_mite', hp: 1, cost: 1, role: 'escort' }], { x: s.b.x - 4000, y: s.b.y }, 3);
    const [hulk, esc] = s.run.raiders.slice(-2);
    expect(s.run.info.get(esc).lead).toBe(hulk);
    s.server.getShips().removeShip(hulk);
    s.step(80);
    expect(s.run.info.get(esc).lead).toBeUndefined();
  });

  it("a turret's kills count for its pad (as the ship that fired them)", () => {
    const s = onSelene();
    s.siege({ action: 'buy', item: 'turret_laser', pad: 1 });
    toNight(s, 1);
    for (const r of s.run.raiders) s.server.getShips().removeShip(r);
    s.run.fronts = []; s.run.stream = [{ ship: 'scrap_mite', hp: 1 }]; s.run.nextStream = Infinity; s.run.nextObjective = Infinity;
    s.hold(0, -3000, 10);
    const pad = s.b.slots[1];
    const mite = raider(s, 'scrap_mite', pad.x + 300, pad.y + 300);
    s.server.getShips().pin(mite);
    for (let i = 0; i < 60 * 20 && s.server.getShips().has(mite); i++) s.step(1);
    expect(s.server.getShips().has(mite)).toBe(false);
    expect(s.run.tally.byPad.get(1)).toBe(1);
    expect(s.run.tally.kills).toBe(1);
  });

  it('a hostile that flees off the moon is gone: it no longer holds back the dawn', () => {
    const s = onSelene();
    toNight(s, 1);
    for (const r of s.run.raiders) s.server.getShips().removeShip(r);
    s.run.fronts = []; s.run.stream = []; s.run.nextObjective = Infinity;
    const r = s.gameData.getSystemByNum(s.num)!.surface!.radius;
    const e = raider(s, 'pirate_skiff', 0, -(r + 2000));
    s.step(20);
    expect(s.server.getShips().has(e)).toBe(false);
    expect(s.run.tally.kills).toBe(0);
    expect(s.run.phase).toBe('day');
  });

  it('bigger parties get more fronts', () => {
    const P = siegeProfile(DEFAULT_SIEGE_RULES, 'selene');
    expect(frontCount(DEFAULT_SIEGE_RULES, P, 1, 1)).toBe(1);
    expect(frontCount(DEFAULT_SIEGE_RULES, P, 1, 3)).toBe(2);
    expect(frontCount(DEFAULT_SIEGE_RULES, P, 1, 5)).toBe(3);
    expect(frontCount(DEFAULT_SIEGE_RULES, P, 13, 1)).toBe(4);
  });
});
