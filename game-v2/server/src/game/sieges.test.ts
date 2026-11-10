import { describe, it, expect } from 'vitest';
import { Position, Velocity, InSystem } from '@space-game/common';
import { waveRoster, haulBonus, SIEGE_TURRETS } from './Sieges.js';
import { makeServer, gameFiles } from '../testkits/world.testkit.js';
import { siegeWorld } from '../testkits/boss.testkit.js';


const world = siegeWorld;

describe('moon sieges (Selene)', () => {
  it('nights get bigger and tougher', () => {
    const one = waveRoster(1, 2, () => 0.5);
    const ten = waveRoster(10, 2, () => 0.5);
    expect(one.every((s) => s.startsWith('scrap_'))).toBe(true);
    // The first four nights are all slow Scrapborn
    for (let w = 1; w <= 4; w++) expect(waveRoster(w, 1).every((s) => s.startsWith('scrap_')), `night ${w}`).toBe(true);
    expect(ten.length).toBeGreaterThan(one.length);
    expect(ten.some((s) => !s.startsWith('scrap_'))).toBe(true);
  });

  it('a lone pilot gets a copy of their own; a party lands together in its own, readies up, holds the night and is paid', () => {
    const { server, gameData, join, step, overSelene } = world();
    const a = join('ava'), b = join('bo'), c = join('cy');
    const pa = a.t.getPlayerId(), pb = b.t.getPlayerId(), pc = c.t.getPlayerId();
    // Alone: a copy of their own
    overSelene(pc);
    c.t.send({ type: 'interact' } as any);
    step(2);
    expect(gameData.getSystemByNum(InSystem.systemId[pc])?.id).toBe('selene_siege');
    // A party of two
    a.t.send({ type: 'partyInvite', name: 'bo' } as any);
    b.t.send({ type: 'partyRespond', accept: true } as any);
    step(2);
    overSelene(pa); overSelene(pb);
    a.t.send({ type: 'interact' } as any);
    b.t.send({ type: 'interact' } as any);
    step(12);
    expect(gameData.getSystemByNum(InSystem.systemId[pa])?.id).toBe('selene_siege');
    expect(InSystem.systemId[pb]).toBe(InSystem.systemId[pa]);
    expect(InSystem.systemId[pc]).not.toBe(InSystem.systemId[pa]);
    const num = InSystem.systemId[pa];
    // It's a copy, not the original
    expect(gameData.getSystemInstances('selene_siege')).toContain(num);
    const run = server.sieges.runOf(num)!;
    expect(run.phase).toBe('day');
    expect(a.got.some((m) => m.type === 'siegeState' && (m as any).active)).toBe(true);
    // Build a turret with the starting supplies
    a.t.send({ type: 'siege', action: 'buy', item: 'turret_cannon' } as any);
    step(1);
    expect(run.turrets.filter((t) => t !== null).length).toBe(1);
    // Both ready: dusk, then the night
    a.t.send({ type: 'siege', action: 'ready' } as any);
    step(12);
    expect(run.phase).toBe('day');
    b.t.send({ type: 'siege', action: 'ready' } as any);
    step(12);
    expect(run.phase).toBe('dusk');
    step(60 * 7);
    expect(run.phase).toBe('night');
    // The first front is seen coming (a few seconds' warning), then arrives
    step(60 * 5);
    expect(run.raiders.length).toBeGreaterThan(0);
    // The night broken (every raider gone), dawn adds to each pilot's haul (paid when they claim it)
    const credits = server.pilots.get(a.conn)!.credits, supplies = run.supplies;
    for (let i = 0; i < 40 && run.phase === 'night'; i++) {
      for (const r of run.raiders) server.getShips().removeShip(r);
      step(30);
    }
    expect(run.phase).toBe('day');
    expect(run.wave).toBe(1);
    expect(run.supplies).toBeGreaterThan(supplies);
    expect(server.pilots.get(a.conn)!.credits).toBe(credits);
    const haul = run.haul.get(a.conn)!;
    expect(haul.nights).toBe(1);
    // Ava claims hers and leaves; Bo holds on
    a.t.send({ type: 'siege', action: 'claim' } as any);
    step(12);
    expect(server.pilots.get(a.conn)!.credits).toBe(credits + haul.credits);
    expect(gameData.getSystemByNum(InSystem.systemId[pa])?.id).toBe('sol');
    expect(server.sieges.runOf(num)).toBeDefined();
    expect(run.haul.has(a.conn)).toBe(false);
    // The last one out ends it
    b.t.send({ type: 'siege', action: 'claim' } as any);
    step(12);
    expect(server.sieges.runOf(num)).toBeUndefined();
  });

  it('claiming pays a bonus for every five nights held', () => {
    expect(haulBonus(0)).toBe(1);
    expect(haulBonus(4)).toBe(1);
    expect(haulBonus(5)).toBe(1.25);
    expect(haulBonus(9)).toBe(1.25);
    expect(haulBonus(10)).toBe(1.5);
  });

  it('every turret mark loads; turrets upgrade, scrap for half back, and fire on what comes', () => {
    const { server, gameData, join, step, overSelene } = world();
    for (const t of Object.values(SIEGE_TURRETS)) for (const m of t.marks) expect(server.getShips().enemyDesigns[m.design], m.design).toBeDefined();
    const a = join('ava');
    const pa = a.t.getPlayerId();
    overSelene(pa);
    a.t.send({ type: 'interact' } as any);
    step(12);
    const num = InSystem.systemId[pa];
    const run = server.sieges.runOf(num)!;
    (run as any).supplies = 1000;
    a.t.send({ type: 'siege', action: 'buy', item: 'turret_cannon' } as any);
    step(1);
    const first = run.turrets[0]!;
    expect(first.mark).toBe(0);
    a.t.send({ type: 'siege', action: 'upgrade', pad: 0 } as any);
    step(1);
    expect(run.turrets[0]!.mark).toBe(1);
    expect(run.turrets[0]!.eid).not.toBe(first.eid);
    expect(run.supplies).toBe(1000 - 100 - 90);
    a.t.send({ type: 'siege', action: 'scrap', pad: 0 } as any);
    step(1);
    expect(run.turrets[0]).toBeNull();
    expect(run.supplies).toBe(1000 - 190 + 95);
    // A laser on pad 0, and a scrap drone in its reach: it burns
    a.t.send({ type: 'siege', action: 'buy', item: 'turret_laser' } as any);
    step(1);
    const laser = run.turrets[0]!.eid;
    const b = gameData.getSystemByNum(num)!.surface!.bastion!, pad = b.slots[0];
    const enemies = (server as any).enemies;
    const [mite] = enemies.spawnPack(num, { faction: 'scrapborn', ships: ['scrap_mite'] }, b.x + pad.x * 2.2, b.y + pad.y * 2.2);
    const ships = server.getShips();
    const hull = ships.integrity(mite);
    step(120);
    expect(!ships.has(mite) || ships.integrity(mite) < hull).toBe(true);
    expect(ships.has(laser)).toBe(true);
  });

  it("the bastion and its turrets are built in: rams don't shove them", () => {
    const { server, join, step, overSelene } = world();
    const a = join('ava');
    const pa = a.t.getPlayerId();
    overSelene(pa);
    a.t.send({ type: 'interact' } as any);
    step(12);
    const run = server.sieges.runOf(InSystem.systemId[pa])!;
    a.t.send({ type: 'siege', action: 'buy', item: 'turret_cannon' } as any);
    step(1);
    for (const eid of [run.bastion, run.turrets[0]!.eid]) {
      const x = Position.x[eid], y = Position.y[eid];
      // Flung at it from below, fast (though not so fast its nose crosses a whole plate in a tick: past that, contacts
      // tunnel, and which way a ship deep in is pushed out turns on its build)
      Position.x[pa] = x; Position.y[pa] = y + 400; Velocity.x[pa] = 0; Velocity.y[pa] = -20;
      step(40);
      expect(Math.hypot(Position.x[eid] - x, Position.y[eid] - y)).toBeLessThan(0.01);
      // ...and the ship hit it (it never got past)
      expect(Position.y[pa]).toBeGreaterThan(y);
    }
  });

  it('two parties get two copies; losing the bastion sends everyone back to orbit', () => {
    const { server, gameData, join, step, overSelene } = world();
    const a = join('ava'), b = join('bo'), c = join('cy'), d = join('di');
    a.t.send({ type: 'partyInvite', name: 'bo' } as any); b.t.send({ type: 'partyRespond', accept: true } as any);
    c.t.send({ type: 'partyInvite', name: 'di' } as any); d.t.send({ type: 'partyRespond', accept: true } as any);
    step(2);
    const pa = a.t.getPlayerId(), pc = c.t.getPlayerId();
    overSelene(pa); overSelene(pc);
    a.t.send({ type: 'interact' } as any); c.t.send({ type: 'interact' } as any);
    step(3);
    expect(gameData.getSystemByNum(InSystem.systemId[pa])?.id).toBe('selene_siege');
    expect(gameData.getSystemByNum(InSystem.systemId[pc])?.id).toBe('selene_siege');
    expect(InSystem.systemId[pa]).not.toBe(InSystem.systemId[pc]);
    // The first party's bastion falls
    const run = server.sieges.runOf(InSystem.systemId[pa])!;
    const ships = server.getShips();
    const bastion = ships.get(run.bastion)!;
    ships.damagePartFraction(run.bastion, bastion.blueprint.parts.findIndex((p) => p.fn === 'core'), 1);
    step(20);
    expect(run.phase).toBe('lost');
    step(60 * 13);
    expect(gameData.getSystemByNum(InSystem.systemId[pa])?.id).toBe('sol');
    expect(server.sieges.runOf(InSystem.systemId[pc])?.phase).toBe('day');
  });
});
