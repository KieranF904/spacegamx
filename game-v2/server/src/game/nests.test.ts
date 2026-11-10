import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { Position, Velocity, InSystem, EffectType, NEST_RADIUS, ServerMessage, ghostShip, LURE_RAMP, type ServerPopsMessage } from '@space-game/common';
import { Populations } from '../../../client/src/state/Populations.js';
import { GameServer } from '../GameServer.js';
import { GameData, type GameDataFiles } from '../data/GameData.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../ships/createShipBridge.js';

const dataDir = join(__dirname, '../../../data');
const files = readGameDataFiles(dataDir);

/** A server with a pilot in Ashfall (`edit`: change a copy of the data first) */
function world(edit?: (f: any) => void) {
  (bitecs as unknown as { resetGlobals: () => void }).resetGlobals();
  const f = structuredClone(files) as any;
  edit?.(f);
  const gameData = new GameData(f as GameDataFiles);
  const server = new GameServer({
    gameData, userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as any,
    scene: 'sectors', autoStart: false, ships: createShipBridge(loadShipConfigCached(dataDir)),
  });
  const step = (n = 1, each?: () => void) => { for (let i = 0; i < n; i++) { each?.(); server.step(); } };
  const t = new LocalTransport(server);
  const got: ServerMessage[] = [];
  t.onMessage = (m) => got.push(m);
  t.connect();
  t.send({ type: 'join', username: 'nester' } as any);
  const pid = t.getPlayerId();
  const num = gameData.getSystemNum('ashfall');
  (server as any).travelTo(server.pilots.connOf(pid), num, 30000, 30000, false);
  step(130);
  const enemies = server.enemies;
  const bridge = server.getShips();
  const hold = (x: number, y: number) => { Position.x[pid] = x; Position.y[pid] = y; Velocity.x[pid] = 0; Velocity.y[pid] = 0; };
  const nest = (id: string) => enemies.nest(num, id)!;
  /** Keep the pilot this far off a nest (in reach to wake it, out of its ships' sight) */
  const watch = (id: string, off = 20000) => { const n = nest(id); hold(n.x + off, n.y); };
  const kill = (eid: number) => {
    const core = bridge.get(eid)!.blueprint.parts.findIndex((p) => p.fn === 'core');
    bridge.damagePartFraction(eid, core, 1);
  };
  return { server, gameData, step, pid, num, got, enemies, bridge, hold, nest, watch, kill };
}

const DIG = 'ashfall_dig_cinderjack';
/** One nest in Ashfall, quick to rebuild: a heavy (rarely rebuilt) and a light group */
const quickNest = (f: any) => {
  const sp = f.factions.spawns.ashfall;
  sp.nests = [{
    id: DIG, packs: 1, respawnSeconds: 10, leash: 5000, roam: 2500, style: 'anchored', groups: [
      { faction: 'redtooth', ships: ['redtooth_sledge'], weight: 1000, limit: 1, respawnSeconds: 120 },
      { faction: 'redtooth', ships: ['redtooth_cutter'], weight: 1 },
    ],
  }];
};

describe('nests', () => {
  it('is there before anyone comes: its packs are ghosts, loaded exactly where their ghosts are as a pilot arrives', () => {
    const { server, step, nest, watch, enemies, num } = world();
    const def = (files.factions as any).spawns.ashfall.nests.find((q: any) => q.id === DIG);
    const pop = () => enemies.population(num, DIG)!;
    // Already out (a fresh world's are full), nothing simulated: no ships, just ghosts
    expect(nest(DIG).packs.length).toBe(0);
    expect(pop().slots.length).toBe(def.packs);
    for (const s of pop().slots) { expect(s.loaded).toBe(false); expect(s.alive).toBe((1 << def.groups[s.group].ships.length) - 1); }
    // A pilot comes near: each pack appears all at once where its ghost is, ship by ship (common ghostShip), none from the hull
    let loaded = 0;
    for (let i = 0; i < 180 && loaded < def.packs; i++) {
      const was = pop().slots.map((s) => s.loaded);
      const t = server.getTick();
      step(1, () => watch(DIG));
      pop().slots.forEach((s, slot) => {
        if (!s.loaded || was[slot]) return;
        loaded++;
        const c = enemies.ghostAt(num, DIG, slot, t)!;
        expect(s.ships.length).toBe(def.groups[s.group].ships.length);
        for (const eid of s.ships) {
          const at = ghostShip(c, (enemies as any).enemies.get(eid).pop.k);
          expect(Math.hypot(Position.x[eid] - at.x, Position.y[eid] - at.y)).toBeLessThan(60);
        }
      });
    }
    expect(loaded).toBe(def.packs);
  });

  it('lost ships come back one at a time, a pack refilling in about its spawn rate, seen launching from the nest', () => {
    const { step, got, nest, watch, kill, enemies, num } = world();
    const def = (files.factions as any).spawns.ashfall.nests.find((q: any) => q.id === DIG);
    const every = (def.respawnSeconds ?? (files.factions as any).rules.respawnSeconds) * 60;
    step(60 * 3, () => watch(DIG));
    const alive = () => enemies.population(num, DIG)!.slots.reduce((n, s) => { let c = 0; for (let a = s.alive; a; a &= a - 1) c++; return n + c; }, 0);
    const full = alive();
    expect(nest(DIG).packs.flat().length).toBe(full);
    let flashes = 0;
    const seen = () => { const at = nest(DIG); for (const m of got.splice(0)) if (m.type === 'effect' && (m as any).effectType === EffectType.WarpOut && Math.hypot((m as any).x - at.x, (m as any).y - at.y) < NEST_RADIUS + 400) flashes++; };
    got.length = 0;
    // A whole pack shot down (and another's ship): they're remembered as lost, and come back one ship an interval, not at once
    const [pack, other] = nest(DIG).packs;
    for (const eid of [...pack, other[0]]) kill(eid);
    step(30, () => { watch(DIG); seen(); });
    const lost = pack.length + 1;
    expect(alive()).toBe(full - lost);
    // One ship at a time, each respawnSeconds / its pack's size apart: the hurt pack's one first, then the wiped one's
    // (whatever group it comes back as) a ship every respawnSeconds / its size: a pack's worth in about respawnSeconds
    // (A wiped-out pack may come back as another group, of another size: full is every slot whole)
    const whole = () => enemies.population(num, DIG)!.slots.every((s) => s.group >= 0 && s.alive === (1 << def.groups[s.group].ships.length) - 1);
    let t = 0, back = full - lost;
    while (!whole() && t < every * 4) {
      step(30, () => { watch(DIG); seen(); });
      t += 30;
      expect(alive() - back).toBeLessThanOrEqual(1);
      back = alive();
      expect(nest(DIG).packs.flat().length).toBe(alive());
    }
    expect(whole()).toBe(true);
    expect(t).toBeGreaterThan(every * 0.9);
    expect(t).toBeLessThan(every * 1.6 + 120);
    // (Each one out of the hull, seen launching)
    expect(flashes).toBe(alive() - (full - lost));
  });

  it("a pack nobody's near goes back to a ghost, as it was: leaving and coming back doesn't restock it", () => {
    const { step, nest, watch, kill, enemies, num } = world();
    step(60 * 3, () => watch(DIG));
    const [pack] = nest(DIG).packs;
    kill(pack[0]);
    step(30, () => watch(DIG));
    const was = enemies.population(num, DIG)!.slots.map((s) => s.alive);
    const ships = nest(DIG).packs.flat().length;
    // Gone a long way off: nothing of it's simulated any more, but it's all still there, short as it was
    step(60 * 10, () => watch(DIG, 90000));
    expect(nest(DIG).packs.length).toBe(0);
    expect(enemies.population(num, DIG)!.slots.every((s) => !s.loaded)).toBe(true);
    expect(enemies.population(num, DIG)!.slots.map((s) => s.alive)).toEqual(was);
    // Back: the same ships, where their ghosts are, no more (the lost one isn't due for a while yet)
    step(60 * 3, () => watch(DIG));
    expect(nest(DIG).packs.flat().length).toBe(ships);
  });

  it('its ships roam within a leash of it, following it round its orbit, and come back when dragged off', () => {
    const { step, nest, watch, enemies } = world(quickNest);
    step(60 * 5, () => watch(DIG));
    const start = nest(DIG);
    const [ship] = start.packs[0];
    expect(enemies.info(ship)?.name).toMatch(/Sledge/);
    step(60 * 120, () => watch(DIG));
    const later = nest(DIG);
    // The moon has carried the nest a long way, and the ship came with it
    expect(Math.hypot(later.x - start.x, later.y - start.y)).toBeGreaterThan(4000);
    expect(Math.hypot(Position.x[ship] - later.x, Position.y[ship] - later.y)).toBeLessThan(5000 + 1500);
    // Dragged far off, it heads back
    Position.x[ship] = later.x + 12000; Position.y[ship] = later.y;
    Velocity.x[ship] = 0; Velocity.y[ship] = 0;
    const away = () => { const n = nest(DIG); return Math.hypot(Position.x[ship] - n.x, Position.y[ship] - n.y); };
    const d0 = away();
    step(60 * 30, () => watch(DIG));
    expect(away()).toBeLessThan(d0 - 3000);
  });

  it('a wiped-out pack is replaced only after the respawn time, and a heavy one takes longer to rebuild', () => {
    const { step, nest, watch, kill, enemies } = world(quickNest);
    step(60 * 5, () => watch(DIG));
    const [heavy] = nest(DIG).packs;
    expect(heavy.map((e) => enemies.info(e)?.name)).toEqual([expect.stringMatching(/Sledge/)]);
    for (const e of heavy) kill(e);
    step(60 * 6, () => watch(DIG));
    expect(nest(DIG).packs.length).toBe(0);
    step(60 * 6, () => watch(DIG));
    // Rebuilt after its ten seconds, but not the heavy (two minutes to rebuild): the light group
    const [next] = nest(DIG).packs;
    expect(next?.map((e) => enemies.info(e)?.name)).toEqual([expect.stringMatching(/Cutter/)]);
    // Two minutes on, the heavy is back
    const sledge = () => nest(DIG).packs.flat().some((e) => /Sledge/.test(enemies.info(e)?.name ?? ''));
    for (let k = 0; k < 14 && !sledge(); k++) {
      for (const p of nest(DIG).packs) for (const e of p) kill(e);
      step(60 * 11, () => watch(DIG));
    }
    expect(sledge()).toBe(true);
  });

  it('nested systems send nothing from out of nowhere: every hostile in Ashfall came from a nest (or is the Hold)', () => {
    const { step, hold, enemies, num } = world();
    step(60 * 60, () => hold(30000, 30000));
    const all = [...(enemies as any).enemies.values()].filter((e: any) => InSystem.systemId[e.eid] === num);
    expect(all.length).toBeGreaterThan(0);
    for (const e of all) {
      const pack = (enemies as any).packs.get(e.pack);
      expect(!!pack?.nest || !!pack?.boss).toBe(true);
    }
  });

  it("Sol's packs all come from nests: calm ones inside the patrols, the Graveyard's among the Tenth's wrecks", () => {
    const sp = (files.factions as any).spawns.sol;
    const sol = (files.systems as any).systems.find((s: any) => s.id === 'sol');
    expect(sp.packs).toBe(0);
    for (const z of sp.zones) expect(z.packs, z.id).toBe(0);
    const safe = sol.regions[0].outer;
    for (const place of sol.nests) {
      const n = sp.nests.find((q: any) => q.id === place.id);
      const r = place.around ? sol.planets.find((p: any) => p.id === place.around).orbit.radius : place.orbit.radius;
      // Inside the safe space only passive packs (the Helios drones, the Greyback smugglers)
      if (r < safe) for (const g of n.groups) expect(g.passive, place.id).toBe(true);
    }
    const yard = sol.nests.find((n: any) => n.id === 'sol_nest_graveyard');
    const at = { x: Math.cos(yard.orbit.phase) * yard.orbit.radius, y: Math.sin(yard.orbit.phase) * yard.orbit.radius };
    const zone = sol.zones.find((z: any) => z.id === 'graveyard');
    expect(Math.hypot(at.x - zone.x, at.y - zone.y)).toBeLessThan(zone.outer);
  });

  it('the Helios docks put out calm drones by the sun', () => {
    const { server, step, enemies, hold } = world();
    const pid = (server as any).clients.values().next().value.playerId;
    const num = server.gameData.getSystemNum('sol');
    (server as any).travelTo(server.pilots.connOf(pid), num, 40000, 0, false);
    step(130);
    const dock = () => enemies.nest(num, 'sol_dock_helios_east')!;
    step(60 * 20, () => { const d = dock(); hold(d.x + 8000, d.y); });
    const drones = dock().packs.flat();
    expect(drones.length).toBeGreaterThan(0);
    for (const e of drones) { expect(enemies.info(e)?.faction).toBe('helios'); expect(enemies.isCalm(e)).toBe(true); }
  });

  it('a loose pack wanders well past the old patrol radius, as one, and comes back towards its nest', () => {
    const BELT = 'ashfall_dig_belt';
    const { step, nest, watch, enemies } = world((f) => {
      f.factions.spawns.ashfall.nests = [{ id: BELT, packs: 1, respawnSeconds: 10, roam: 2500, groups: [{ faction: 'redtooth', ships: ['redtooth_cutter', 'redtooth_cutter'], weight: 1 }] }];
    });
    const dist: number[] = [];
    let spread = 0;
    for (let s = 0; s < 60 * 8; s++) {
      step(60, () => watch(BELT, 30000));
      const n = nest(BELT), [lead, wing] = n.packs[0] ?? [];
      if (lead === undefined) continue;
      dist.push(Math.hypot(Position.x[lead] - n.x, Position.y[lead] - n.y));
      if (wing !== undefined) spread = Math.max(spread, Math.hypot(Position.x[lead] - Position.x[wing], Position.y[lead] - Position.y[wing]));
    }
    const far = Math.max(...dist), at = dist.indexOf(far);
    // Further than anchored packs patrol (2500), never past its reach (3.5× roam) and leash
    expect(far).toBeGreaterThan(2500 * 1.5);
    expect(far).toBeLessThan(2500 * 3.5 + 2500 + 1500);
    // ...and it came back in towards the nest after its furthest point
    expect(Math.min(...dist.slice(at))).toBeLessThan(far * 0.6);
    // The pack keeps together
    expect(spread).toBeLessThan(4000);
    expect((enemies as any).packs.get((enemies as any).enemies.get(nest(BELT).packs[0][0]).pack).style).toBe('loose');
  }, 60000);

  it("nomads travel Sol's middle between places, never into the safe space, and are a ghost again once left alone", () => {
    const CAMP = 'sol_camp_lanes';
    const { server, step, enemies, hold } = world((f) => {
      f.factions.spawns.sol.nests = [{ id: CAMP, packs: 1, respawnSeconds: 10, style: 'nomad', groups: [{ faction: 'redtooth', ships: ['redtooth_cutter', 'redtooth_cutter'], weight: 1 }] }];
    });
    const pid = (server as any).clients.values().next().value.playerId;
    const sol = server.gameData.getSystemNum('sol');
    // Its ghost travels the middle band on its own (the same for every client): out of the safe space wherever it is
    const ghost = (t?: number) => enemies.ghostAt(sol, CAMP, 0, t)!;
    for (let t = 0; t < 60 * 60 * 60; t += 60 * 60) expect(Math.hypot(ghost(t).x, ghost(t).y)).toBeGreaterThan(76000);
    // A pilot near where it is now: it's loaded there
    const g = ghost(), r0 = Math.hypot(g.x, g.y);
    const near = { x: g.x * (r0 + 15000) / r0, y: g.y * (r0 + 15000) / r0 };
    (server as any).travelTo(server.pilots.connOf(pid), sol, near.x, near.y, false);
    step(130);
    step(60 * 3, () => hold(near.x, near.y));
    expect(enemies.nest(sol, CAMP)!.packs.length).toBe(1);
    const packOf = () => { const [m] = enemies.nest(sol, CAMP)!.packs[0] ?? []; return m === undefined ? undefined : (enemies as any).packs.get((enemies as any).enemies.get(m).pack); };
    // Follow it about (out of its sight) for a while: it travels on and settles, round the centre, out of the safe space
    const homes: { x: number; y: number }[] = [];
    for (let s = 0; s < 60 * 9; s++) {
      step(60, () => { const p = packOf(); if (p) { const r = Math.hypot(p.home.x, p.home.y) || 1; hold(p.home.x * (r + 15000) / r, p.home.y * (r + 15000) / r); } });
      const p = packOf();
      if (!p) continue;
      homes.push({ ...p.home });
      for (const m of p.members) expect(Math.hypot(Position.x[m], Position.y[m])).toBeGreaterThan(76000);
    }
    let travelled = 0;
    for (let i = 1; i < homes.length; i++) travelled += Math.hypot(homes[i].x - homes[i - 1].x, homes[i].y - homes[i - 1].y);
    expect(travelled).toBeGreaterThan(30000);
    for (const h of homes) expect(Math.hypot(h.x, h.y)).toBeGreaterThan(76000);
    // Left alone (the pilot back in inner Sol): a ghost again, all its ships still alive, none more sent
    step(60 * 60, () => hold(40000, 0));
    expect(enemies.nest(sol, CAMP)!.packs.length).toBe(0);
    expect(enemies.population(sol, CAMP)!.slots).toEqual([{ group: 0, alive: 3, loaded: false, ships: [] }]);
  }, 120000);

  it('a ghost loaded within sight of a pilot comes in as a warp-in looks; one loaded at the edge of its reach just appears', () => {
    const { step, got, enemies, num, hold, watch } = world();
    const slot = enemies.population(num, DIG)!.slots.findIndex((s) => !s.loaded && s.alive);
    expect(slot).toBeGreaterThanOrEqual(0);
    got.length = 0;
    // Dropped right by it (a jump, a gate): its ships fade in where they are
    step(40, () => { const g = enemies.ghostAt(num, DIG, slot)!; hold(g.x + 5000, g.y); });
    const s = enemies.population(num, DIG)!.slots[slot];
    expect(s.loaded).toBe(true);
    const warps = got.filter((m) => m.type === 'effect' && (m as any).effectType === EffectType.WarpIn);
    for (const eid of s.ships) expect(warps.some((m: any) => Math.hypot(m.x - Position.x[eid], m.y - Position.y[eid]) < 400)).toBe(true);
    // Come on from far off (the next world): loaded out past sight, nothing to see
    const w2 = world();
    w2.got.length = 0;
    w2.step(60 * 3, () => w2.watch(DIG, 30000));
    expect(w2.nest(DIG).packs.length).toBeGreaterThan(0);
    expect(w2.got.some((m) => m.type === 'effect' && (m as any).effectType === EffectType.WarpIn)).toBe(false);
    void watch;
  });

  it("a nomad's ghost drifts round towards its band's pilots, and a client told only the pops draws it the same", () => {
    const CAMP = 'sol_camp_lanes';
    const { server, step, enemies, hold, got } = world((f) => {
      f.factions.spawns.sol.nests = [{ id: CAMP, packs: 1, respawnSeconds: 10, style: 'nomad', groups: [{ faction: 'redtooth', ships: ['redtooth_cutter', 'redtooth_cutter'], weight: 1 }] }];
    });
    const pid = (server as any).clients.values().next().value.playerId;
    const sol = server.gameData.getSystemNum('sol');
    const g0 = enemies.ghostAt(sol, CAMP, 0)!, r = Math.hypot(g0.x, g0.y);
    // A pilot in its band, a third of the way round from it: far past its reach
    const a = Math.atan2(g0.y, g0.x) + 2.1, spot = { x: Math.cos(a) * r, y: Math.sin(a) * r };
    const off = () => { const g = enemies.ghostAt(sol, CAMP, 0)!; return Math.abs(Math.atan2(Math.sin(Math.atan2(g.y, g.x) - a), Math.cos(Math.atan2(g.y, g.x) - a))); };
    (server as any).travelTo(server.pilots.connOf(pid), sol, spot.x, spot.y, false);
    step(130, () => hold(spot.x, spot.y));
    const d0 = off();
    expect(d0).toBeGreaterThan(1.5);
    step(LURE_RAMP / 2, () => hold(spot.x, spot.y));
    // Half way: drawn round some, and a client with only what it was sent has it in the same place
    expect(off()).toBeLessThan(d0 - 0.5);
    expect(enemies.population(sol, CAMP)!.slots[0].loaded).toBe(false);
    const client = new Populations((enemies as any).data.spawns, Object.keys((enemies as any).data.factions));
    for (const m of got.filter((q): q is ServerPopsMessage => q.type === 'pops')) client.apply(m, 'sol');
    const g = enemies.ghostAt(sol, CAMP, 0)!;
    const drawn = client.ghosts('sol', server.gameData.getSystem('sol'), server.getTick());
    expect(drawn.map((q) => [Math.round(q.x), Math.round(q.y)])).toEqual([0, 1].map((k) => { const p = ghostShip(g, k); return [Math.round(p.x), Math.round(p.y)]; }));
    // On: it comes all the way to the pilot's part of the system (and is loaded there)
    step(LURE_RAMP / 2 + 600, () => hold(spot.x, spot.y));
    expect(off()).toBeLessThan(0.45);
  }, 120000);

  it("Ashfall's nests mix small, medium and rare heavy hostiles", () => {
    const nests = (files.factions as any).spawns.ashfall.nests as any[];
    const ships = new Set(nests.flatMap((n) => n.groups.flatMap((g: any) => g.ships)));
    for (const s of ['redtooth_cutter', 'redtooth_brawler', 'redtooth_sledge', 'scrap_mite', 'scrap_crawler', 'scrap_hulk']) expect(ships.has(s)).toBe(true);
    // The heavies: one out at a time, slow to rebuild, and the least likely pick in their nest
    for (const n of nests) {
      for (const g of n.groups.filter((q: any) => q.ships.some((s: string) => s === 'redtooth_sledge' || s === 'scrap_hulk'))) {
        expect(g.limit).toBe(1);
        expect(g.respawnSeconds).toBeGreaterThanOrEqual(180);
        expect(g.weight).toBe(Math.min(...n.groups.map((q: any) => q.weight)));
      }
    }
  });
});
