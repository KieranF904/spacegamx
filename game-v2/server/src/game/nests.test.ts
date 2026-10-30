import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { Position, Velocity, InSystem, EffectType, NEST_RADIUS, ServerMessage } from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData, type GameDataFiles } from '../data/GameData.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigFromDisk } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../proto/createProtoServer.js';

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
    scene: 'sectors', autoStart: false, ships: createShipBridge(loadShipConfigFromDisk(dataDir)),
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
  it('is found already stocked as a pilot arrives, and launches replacements visibly from the nest', () => {
    const { step, got, nest, watch, kill } = world();
    const def = (files.factions as any).spawns.ashfall.nests.find((q: any) => q.id === DIG);
    expect(nest(DIG).packs.length).toBe(0);
    step(60, () => watch(DIG));
    // Every pack out at once, on patrol round it (not at the hull, no launch seen)
    let n = nest(DIG);
    expect(n.packs.length).toBe(def.packs);
    for (const pack of n.packs) for (const eid of pack) expect(Math.hypot(Position.x[eid] - n.x, Position.y[eid] - n.y)).toBeLessThan(NEST_RADIUS + (def.roam ?? 2400) + 1500);
    // (Launch flashes at the hull's edge, wherever the nest has got to on its orbit)
    let flashes = 0;
    const seen = () => { const at = nest(DIG); for (const m of got.splice(0)) if (m.type === 'effect' && (m as any).effectType === EffectType.WarpOut && Math.hypot((m as any).x - at.x, (m as any).y - at.y) < NEST_RADIUS + 400) flashes++; };
    seen();
    expect(flashes).toBe(0);
    // A pack wiped out: its replacement comes out of the hull, seen launching, once the nest has rebuilt it
    for (const eid of n.packs[0]) kill(eid);
    step(60 * ((def.respawnSeconds ?? (files.factions as any).rules.respawnSeconds) + 20), () => { watch(DIG); seen(); });
    n = nest(DIG);
    expect(n.packs.length).toBe(def.packs);
    expect(flashes).toBeGreaterThan(0);
  });

  it('a nest sleeps while nobody is near it; once it has sent its packs out they stay out, distant, after it is left', () => {
    const { step, nest, watch, bridge } = world();
    step(60 * 5, () => watch(DIG, 60000));
    expect(nest(DIG).packs.length).toBe(0);
    step(60 * 20, () => watch(DIG));
    const out = nest(DIG).packs.length;
    expect(out).toBeGreaterThan(0);
    // (Nothing goes back in: far from pilots they cost next to nothing, and a system left empty is remembered whole)
    const idle = (files.factions as any).rules.idleDespawnSeconds;
    step(60 * (idle + 5), () => watch(DIG, 80000));
    expect(nest(DIG).packs.length).toBe(out);
    expect(nest(DIG).packs.flat().every((e) => bridge.isDormant(e))).toBe(true);
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

  it("nomads travel Sol's middle between places, never into the safe space, and stay out, distant, once left alone", () => {
    const CAMP = 'sol_camp_lanes';
    const { server, step, enemies, hold } = world((f) => {
      f.factions.spawns.sol.nests = [{ id: CAMP, packs: 1, respawnSeconds: 10, style: 'nomad', groups: [{ faction: 'redtooth', ships: ['redtooth_cutter', 'redtooth_cutter'], weight: 1 }] }];
    });
    const pid = (server as any).clients.values().next().value.playerId;
    const sol = server.gameData.getSystemNum('sol');
    const camp = enemies.nest(sol, CAMP)!;
    // A pilot in the middle band, but on the far side of Sol from the camp: the nest still sends its nomads out
    const far = { x: -camp.x / Math.hypot(camp.x, camp.y) * 110000, y: -camp.y / Math.hypot(camp.x, camp.y) * 110000 };
    (server as any).travelTo(server.pilots.connOf(pid), sol, far.x, far.y, false);
    step(130);
    step(60 * 20, () => hold(far.x, far.y));
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
    // Left alone (the pilot back in inner Sol): its pack stays out where it got to, distant, and no more come out
    const idle = (files.factions as any).rules.idleDespawnSeconds;
    step(60 * (idle + 5), () => hold(40000, 0));
    expect(enemies.nest(sol, CAMP)!.packs.length).toBe(1);
    step(60 * 60, () => hold(40000, 0));
    expect(enemies.nest(sol, CAMP)!.packs.length).toBe(1);
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
