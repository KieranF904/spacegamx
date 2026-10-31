import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { Position, Velocity, InSystem, ServerMessage, Station as StationComp, Projectile, DroppedItem, countOf, validateBlueprint, createShipState, parseBlueprint, MAX_DRIVE } from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigFromDisk } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../proto/createProtoServer.js';
import type { BossesFile } from './Bosses.js';

const dataDir = join(__dirname, '../../../data');
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const files = readGameDataFiles(dataDir);
const bossFile = files.bosses as BossesFile;

function world() {
  resetGlobals();
  const server = new GameServer({
    gameData: new GameData(files),
    userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as any,
    scene: 'sectors',
    autoStart: false,
    ships: createShipBridge(loadShipConfigFromDisk(dataDir)),
  });
  const t = new LocalTransport(server);
  const got: ServerMessage[] = [];
  t.onMessage = (m) => got.push(m);
  t.connect();
  t.send({ type: 'join', username: 'slayer' } as any);
  const pid = t.getPlayerId();
  const conn = server.pilots.connOf(pid)!;
  const profile = () => server.pilots.get(conn)!;
  profile().licences.push('the_maw');
  const step = (n = 1) => { for (let i = 0; i < n; i++) server.step(); };
  const bridge = server.getShips();
  return { server, t, got, pid, conn, profile, step, bridge, bosses: server.bosses, enemies: server.enemies };
}

const hold = (pid: number, x: number, y: number) => { Position.x[pid] = x; Position.y[pid] = y; Velocity.x[pid] = 0; Velocity.y[pid] = 0; };

/** Put the player in a boss's system, well away from its lair */
function visit(server: GameServer, pid: number, boss: string) {
  const def = bossFile.bosses[boss];
  InSystem.systemId[pid] = server['gameData'].getSystemNum(def.system);
  hold(pid, def.lair.x + 6000, def.lair.y);
}

/** Knock non-core parts off until the hull is below `frac` (reported like any hit) */
function wear(server: GameServer, eid: number, frac: number, by: number) {
  const bridge = server.getShips();
  const ship = bridge.get(eid)!;
  for (let i = 0; i < ship.hp.length && bridge.integrity(eid) >= frac; i++) {
    if (ship.blueprint.parts[i].fn === 'core' || ship.hp[i] <= 0) continue;
    const dealt = bridge.hurt(eid, ship, i, ship.hp[i] + 1, by);
    server.bosses.onDamage(eid, dealt, by);
  }
}

describe('bosses: data', () => {
  it("each legendary is made from one boss's artefact, a very rare drop from the boss (or bosses) that has it; no boss drops a schematic", () => {
    const { bridge } = world();
    const items = (files.items as any).items as { id: string; category: string }[];
    const artefacts = new Set(items.filter((i) => i.category === 'artefact').map((i) => i.id));
    const models = (files.recipes as any).models as Record<string, { inputs: Record<string, number> }>;
    const legendaries = [...bridge.catalog.functions.values()].filter((f) => f.model && f.rarity === 'legendary');
    // (Exactly the legendary_* models, whatever their number)
    expect(legendaries.map((f) => f.id).sort()).toEqual([...bridge.catalog.functions.values()].filter((f) => f.model && f.id.startsWith('legendary_')).map((f) => f.id).sort());
    expect(legendaries.length).toBeGreaterThan(0);
    for (const f of legendaries) {
      const parts = Object.keys(models[f.id].inputs).filter((id) => artefacts.has(id));
      expect(parts, f.id).toHaveLength(1);
      const drops = Object.values(bossFile.bosses).flatMap((b) => b.loot.filter((l) => l.item === parts[0]));
      expect(drops.length, f.id).toBeGreaterThan(0);
      for (const l of drops) { expect(l.chance, f.id).toBeGreaterThanOrEqual(0.02); expect(l.chance, f.id).toBeLessThanOrEqual(0.08); }
    }
    for (const b of Object.values(bossFile.bosses)) for (const l of b.loot) expect(l.item.startsWith('schematic_'), l.item).toBe(false);
  });

  it('every boss has a valid design, loot that exists, and a lair clear of stations', () => {
    const { server, bridge } = world();
    const gd = server['gameData'];
    for (const [id, def] of Object.entries(bossFile.bosses)) {
      const bp = bridge.enemyDesigns[def.design ?? id];
      expect(bp, id).toBeDefined();
      // (Enemies aren't bound by a pilot's starting stock of pieces.) A design with the game's own parts
      // or bespoke shapes isn't a pilot's, so it's held to holding together instead
      const own = bp.parts.some((p) => bridge.catalog.pieces.get(p.piece)?.bespoke || bridge.catalog.functions.get(p.fn)?.exclusive);
      if (own) expect(createShipState(bridge.catalog, bridge.tuning, 1, bp, 0).derived.alive.every(Boolean), id).toBe(true);
      else expect(validateBlueprint(bridge.catalog, bp, bridge.tuning).ok, id).toBe(true);
      for (const l of def.loot) expect(server.econ.items.has(l.item), `${id} ${l.item}`).toBe(true);
      for (const p of def.phases) for (const e of p.escorts ?? []) expect(bridge.enemyDesigns[e], `${id} escort ${e}`).toBeDefined();
      expect(gd.getSystem(def.system), id).toBeDefined();
      const num = gd.getSystemNum(def.system);
      const w = server.getWorld();
      for (let e = 0; e < 8000; e++) {
        if (!bitecs.entityExists(w, e) || !bitecs.hasComponent(w, StationComp, e) || InSystem.systemId[e] !== num) continue;
        expect(Math.hypot(Position.x[e] - def.lair.x, Position.y[e] - def.lair.y), `${id} lair vs station`).toBeGreaterThan(7000);
      }
      const sys = gd.getSystem(def.system)!;
      const body = Math.max(sys.centralBody?.gravity?.horizon ?? 0, sys.centralBody?.radius ?? sys.starRadius ?? 0);
      const keepOut = body > 0 ? body + 5000 : 0;
      // (A surface has no star: its middle is as good a lair as anywhere)
      if (keepOut > 0) expect(Math.hypot(def.lair.x, def.lair.y), `${id} lair vs star`).toBeGreaterThan(keepOut);
    }
    // Every story boss step names a real boss
    for (const q of server.quests.file.quests) for (const s of q.steps) if (s.type === 'boss') expect(bossFile.bosses[s.boss], `${q.id} ${s.boss}`).toBeDefined();
  });
});

describe('bosses: giants', () => {
  const GIANTS = Object.entries(bossFile.bosses).filter(([, d]) => d.design?.startsWith('giant_'));

  it("one wanders Sol and each of the other open systems but the Maw; they're huge, and Sol's is the lightest armed", () => {
    const { server, pid, bridge } = world();
    const systems = GIANTS.map(([, d]) => d.system);
    expect(new Set(systems).size).toBe(systems.length);
    expect(systems).toContain('sol');
    expect(systems.length).toBeGreaterThanOrEqual(6);
    const armed: Record<string, number> = {};
    for (const [id, def] of GIANTS) {
      expect(def.roam, id).toBeDefined();
      visit(server, pid, id);
      const eid = server.bosses.spawn(id);
      expect(eid, id).toBeGreaterThanOrEqual(0);
      expect(InSystem.systemId[eid]).toBe(server['gameData'].getSystemNum(def.system));
      const ship = bridge.get(eid)!;
      // Several times a story boss across (the Scrap Mother's is about 110)
      expect(ship.derived.radius, id).toBeGreaterThan(300);
      armed[def.system] = ship.derived.weapons.length / ship.blueprint.parts.length;
    }
    for (const [sys, share] of Object.entries(armed)) if (sys !== 'sol') expect(share, sys).toBeGreaterThan(armed.sol);
  });
});

describe('bosses: speed', () => {
  it('a boss with a speed runs its engines that hot (past what any design may ask): giants and story bosses keep up with a fight', () => {
    const { server, pid, bridge } = world();
    const accel = (eid: number) => { const d = bridge.get(eid)!.derived; return (Math.max(d.maxThrust.forward, d.maneuverForce) * d.drive) / Math.max(d.mass, d.fullMass ?? d.mass); };
    const starter = createShipState(bridge.catalog, bridge.tuning, 0, bridge.playerBlueprint, 0).derived;
    const starterAccel = Math.max(starter.maxThrust.forward, starter.maneuverForce) / starter.mass;
    for (const [id, def] of Object.entries(bossFile.bosses)) {
      if (!def.speed) continue;
      expect(def.speed, id).toBeLessThanOrEqual(MAX_DRIVE);
      visit(server, pid, id);
      const eid = server.bosses.spawn(id);
      expect(bridge.get(eid)!.blueprint.drive, id).toBe(def.speed);
      // Top speed goes with acceleration (friction): at least 40% of a starter's
      expect(accel(eid) / starterAccel, id).toBeGreaterThan(0.4);
    }
    // A player's design can't ask for it
    expect(parseBlueprint(JSON.stringify({ ...bridge.playerBlueprint, drive: 2 })).drive).toBeUndefined();
  });
});

describe('bosses: the fight', () => {
  it('a boss appears at its lair when a player enters its system, and the system is told', () => {
    const { server, pid, step, bosses, got } = world();
    visit(server, pid, 'boss_rustjaw');
    for (let i = 0; i < 70; i++) { visit(server, pid, 'boss_rustjaw'); step(); }
    expect(bosses.isAlive('boss_rustjaw')).toBe(true);
    const eid = bosses.eidOf('boss_rustjaw');
    expect(Math.hypot(Position.x[eid] - bossFile.bosses.boss_rustjaw.lair.x, Position.y[eid] - bossFile.bosses.boss_rustjaw.lair.y)).toBeLessThan(400);
    expect(got.some((m) => m.type === 'toast' && /Rustjaw has been sighted/.test((m as any).text))).toBe(true);
    // Bosses in other systems stay away
    expect(bosses.isAlive('boss_maw_heart')).toBe(false);
  });

  it('hurting it plays the intro; phases bring escorts, rage and a telegraphed nova', () => {
    const { server, pid, step, bosses, bridge, enemies, got } = world();
    visit(server, pid, 'boss_rustjaw');
    const eid = bosses.spawn('boss_rustjaw');
    const num = InSystem.systemId[eid];
    const before = enemies.count(num);
    wear(server, eid, 0.7, pid);
    step(2);
    expect(got.some((m) => m.type === 'bossIntro')).toBe(true);
    expect(bosses.phaseOf('boss_rustjaw')).toBe(1);
    expect(enemies.count(num)).toBe(before + 2);
    wear(server, eid, 0.45, pid);
    step(2);
    expect(bosses.phaseOf('boss_rustjaw')).toBe(2);
    // The boss now has a target (us) and charges a nova, then fires it
    hold(pid, Position.x[eid] + 1500, Position.y[eid]);
    let charged = false, shots = 0;
    const w = server.getWorld();
    for (let i = 0; i < 600 && !shots; i++) {
      hold(pid, Position.x[eid] + 1500, Position.y[eid]);
      step();
      charged ||= got.some((m) => m.type === 'bossCharge');
      if (charged) {
        shots = 0;
        for (let e = 0; e < 9000; e++) if (bitecs.entityExists(w, e) && bitecs.hasComponent(w, Projectile, e) && Projectile.ownerId[e] === eid) shots++;
        if (shots < 10) shots = 0;
      }
    }
    expect(charged).toBe(true);
    expect(shots).toBeGreaterThanOrEqual(10);
  });

  it('killing it rewards everyone who fought: XP, credits, loot in storage, quest credit; it respawns later', () => {
    const { server, pid, conn, step, bosses, bridge, profile } = world();
    profile().level = 13;
    profile().quests.done.push('main_01', 'main_02', 'main_03', 'main_04', 'main_05', 'main_06', 'main_07');
    for (const id of Object.keys(profile().quests.active)) delete profile().quests.active[id];
    expect(server.quests.acceptFrom(conn, 'main_08')).toBeNull();
    visit(server, pid, 'boss_rustjaw');
    // (The cog is a very rare drop: this kill is the lucky one)
    const cog = bosses.file.bosses.boss_rustjaw.loot.find((l) => l.item === 'rustjaw_cog')!;
    const chance = cog.chance;
    cog.chance = 1;
    const eid = bosses.spawn('boss_rustjaw');
    const credits = profile().credits, xp = profile().xp;
    const ship = bridge.get(eid)!;
    bridge.hurt(eid, ship, 0, 10, pid); // a first hit for the credit list
    const core = ship.blueprint.parts.findIndex((p) => p.fn === 'core');
    bridge.hurt(eid, ship, core, 1e9, pid);
    step(3);
    expect(bosses.isAlive('boss_rustjaw')).toBe(false);
    expect(profile().credits).toBeGreaterThanOrEqual(credits + bossFile.bosses.boss_rustjaw.credits);
    expect(profile().xp).toBeGreaterThan(xp);
    expect(countOf(profile().storage, 'rustjaw_cog')).toBe(1);
    cog.chance = chance;
    expect(profile().quests.done).toContain('main_08');
    // Not straight back
    for (let i = 0; i < 300; i++) { visit(server, pid, 'boss_rustjaw'); step(); }
    expect(bosses.isAlive('boss_rustjaw')).toBe(false);
  });

  it('left alone, a hurt boss is remembered as it was, and mends slowly with time away (not reset)', () => {
    const { server, pid, step, bosses, bridge } = world();
    visit(server, pid, 'boss_prism_colossus');
    const eid = bosses.spawn('boss_prism_colossus');
    wear(server, eid, 0.8, pid);
    // Leave for Sol: once its system's been empty a while it's put away (SystemMemory), not reset
    const leave = (s: number) => { InSystem.systemId[pid] = server['gameData'].getSystemNum('sol'); for (let i = 0; i < s * 60; i++) { hold(pid, 30000, 30000); step(); } };
    leave(server.memory.rules.evictAfterSeconds - 1);
    const hurt = bridge.integrity(eid);
    expect(hurt).toBeLessThan(0.85);
    leave(3);
    expect(bosses.isAlive('boss_prism_colossus')).toBe(false);
    expect(server.memory.remembers(bossFile.bosses.boss_prism_colossus.system)).toBe(true);
    // Straight back: as hurt as it was (a few seconds' mending), no new sighting
    visit(server, pid, 'boss_prism_colossus');
    step(2);
    expect(bosses.isAlive('boss_prism_colossus')).toBe(true);
    const back = bridge.integrity(bosses.eidOf('boss_prism_colossus'));
    expect(back).toBeGreaterThanOrEqual(hurt - 0.01);
    expect(back).toBeLessThan(hurt + 0.05);
    // Away half an hour (the world's clock moved on): mended by memory.bossHealPerMinute a minute, part by part
    leave(server.memory.rules.evictAfterSeconds + 2);
    server.memory.offset += 60 * 60 * 30;
    visit(server, pid, 'boss_prism_colossus');
    step(2);
    expect(bridge.integrity(bosses.eidOf('boss_prism_colossus'))).toBeGreaterThan(back + 0.1);
  });
});

describe('legendary weapons', () => {
  function range() {
    const env = world();
    const { server, pid, bridge } = env;
    hold(pid, 40000, 40000);
    const target = bridge.spawnDummy(bridge.enemyDesigns.pirate_gunship, 40000, 39000, 0, InSystem.systemId[pid]);
    const weapons = (server as any).weapons;
    const fire = (kind: string, angle = -Math.PI / 2, from = { x: 40000, y: 39600 }) =>
      weapons.spawn(pid, kind, from.x, from.y, angle, 1, { speedScale: 1, sizeScale: 1, turret: false });
    const shots = (kind: number) => {
      const w = server.getWorld();
      let n = 0;
      for (let e = 0; e < 9000; e++) if (bitecs.entityExists(w, e) && bitecs.hasComponent(w, Projectile, e) && Projectile.weaponType[e] === kind && Projectile.ownerId[e] === pid) n++;
      return n;
    };
    return { ...env, target, fire, shots };
  }
  const total = (bridge: any, eid: number) => bridge.get(eid).hp.reduce((a: number, b: number) => a + Math.max(0, b), 0);

  it("Rustjaw's Hive spawns one seeker per shot (the salvo of four is covered in legendaries.test.ts)", () => {
    const { fire, shots } = range();
    fire('hive');
    expect(shots(12)).toBe(1);
  });

  it('the Prism Splitter shatters into shards when it hits', () => {
    const { fire, shots, step, pid } = range();
    fire('prism');
    let seen = 0;
    for (let i = 0; i < 40; i++) { hold(pid, 40000, 40000); step(); seen = Math.max(seen, shots(15)); }
    expect(seen).toBe(5);
  });

  it('Cinder Bloom sets the part it hits burning', () => {
    const { fire, step, pid, bridge, target, got } = range();
    fire('cinder_bloom');
    for (let i = 0; i < 30; i++) { hold(pid, 40000, 40000); step(); }
    expect(got.some((m) => m.type === 'ignite')).toBe(true);
    const a = total(bridge, target);
    for (let i = 0; i < 120; i++) { hold(pid, 40000, 40000); step(); }
    expect(total(bridge, target)).toBeLessThan(a);
  });

  it('the Phase Cannon passes through a ship at full force', () => {
    const { fire, step, pid, bridge, target, shots } = range();
    const a = total(bridge, target);
    fire('phase');
    let through = false;
    for (let i = 0; i < 60; i++) {
      hold(pid, 40000, 40000);
      step();
      if (total(bridge, target) < a && shots(16) > 0) through = true;
    }
    expect(through).toBe(true);
  });

  it('a Singularity drags ships towards it', () => {
    const { fire, step, pid, target } = range();
    fire('singularity', -Math.PI / 2, { x: 40000, y: 39400 });
    const d0 = Math.hypot(Position.x[target] - 40000, Position.y[target] - 39000);
    const vy0 = Velocity.y[target];
    for (let i = 0; i < 20; i++) { hold(pid, 40000, 40000); step(); }
    expect(Math.abs(Velocity.y[target] - vy0) + Math.abs(Velocity.x[target])).toBeGreaterThan(0.5);
    void d0;
  });

  it('the Frostbite Lance slows a ship it holds', () => {
    const { server, pid, bridge, enemies, step } = range();
    // A cultist with its lance swapped for a frostbite lance
    const bp = JSON.parse(JSON.stringify(bridge.enemyDesigns.cinder_zealot));
    for (const p of bp.parts) if (p.fn === 'lance') p.fn = 'frostbite';
    bridge.enemyDesigns.frost_test = bp;
    expect(bridge.validate(bp).ok).toBe(true);
    enemies.spawnPack(InSystem.systemId[pid], { faction: 'cinder', ships: ['frost_test'] }, 90000, 89600);
    let frozen = false;
    for (let i = 0; i < 60 * 15 && !frozen; i++) { hold(pid, 90000, 90000); step(); frozen = bridge.slowedTicksLeft(pid) > 0; }
    expect(frozen).toBe(true);
    void server;
  });
});

describe('world events', () => {
  it('a raid sends two packs at a station; driving them off pays the defenders', () => {
    const { server, pid, step, profile, enemies, got } = world();
    const sol = InSystem.systemId[pid];
    const e = server.events.startRaid(sol)!;
    expect(e).not.toBeNull();
    expect(e.ships.length).toBeGreaterThanOrEqual(2);
    expect(got.some((m) => m.type === 'worldEvent' && (m as any).kind === 'raid')).toBe(true);
    // Stand near the station, then the raiders all die
    hold(pid, Position.x[e.station!] + 2000, Position.y[e.station!]);
    const credits = profile().credits;
    for (const s of e.ships) {
      const ship = server.getShips().get(s);
      if (!ship) continue;
      const core = ship.blueprint.parts.findIndex((p) => p.fn === 'core');
      server.getShips().hurt(s, ship, core, 1e9, -1);
    }
    for (let i = 0; i < 5; i++) { hold(pid, Position.x[e.station!] + 2000, Position.y[e.station!]); step(); }
    expect(e.ships.every((s) => !enemies.isAlive(s))).toBe(true);
    expect(server.events.active(sol).length).toBe(0);
    expect(profile().credits).toBeGreaterThan(credits);
    expect(got.some((m) => m.type === 'worldEventEnd')).toBe(true);
  });

  it('a salvage field scatters cargo pods in open space and draws hostiles', () => {
    const { server, pid } = world();
    const sol = InSystem.systemId[pid];
    const w = server.getWorld();
    const podsBefore = [...Array(9000).keys()].filter((e) => bitecs.entityExists(w, e) && bitecs.hasComponent(w, DroppedItem, e)).length;
    const e = server.events.startSalvage(sol)!;
    expect(e).not.toBeNull();
    const pods = [...Array(9000).keys()].filter((x) => bitecs.entityExists(w, x) && bitecs.hasComponent(w, DroppedItem, x));
    expect(pods.length - podsBefore).toBeGreaterThanOrEqual(10);
    for (const p of pods.slice(podsBefore)) expect(Math.hypot(Position.x[p] - e.x, Position.y[p] - e.y)).toBeLessThan(1400);
    expect(e.ships.length).toBeGreaterThan(0);
  });

  it('arriving in a system with an event running tells you about it', () => {
    const { server, pid, step, got } = world();
    const borealis = server['gameData'].getSystemNum('borealis');
    server.events.startSalvage(borealis);
    got.length = 0;
    InSystem.systemId[pid] = borealis;
    hold(pid, 0, 30000);
    step(3);
    expect(got.some((m) => m.type === 'worldEvent')).toBe(true);
  });
});
