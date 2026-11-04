import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { Position, Velocity, InSystem, ServerMessage, EffectType } from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigFromDisk } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../proto/createProtoServer.js';

const dataDir = join(__dirname, '../../../data');
const files = readGameDataFiles(dataDir);

function world(names = ['hunter']) {
  (bitecs as unknown as { resetGlobals: () => void }).resetGlobals();
  const server = new GameServer({
    gameData: new GameData(files), userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as any,
    scene: 'sectors', autoStart: false, ships: createShipBridge(loadShipConfigFromDisk(dataDir)),
  });
  const pilots = names.map((n) => {
    const t = new LocalTransport(server);
    const got: ServerMessage[] = [];
    t.onMessage = (m) => got.push(m);
    t.connect();
    t.send({ type: 'join', username: n } as any);
    return { t, got, pid: t.getPlayerId(), conn: server.pilots.connOf(t.getPlayerId())! as any };
  });
  const step = (n = 1) => { for (let i = 0; i < n; i++) server.step(); };
  return { server, pilots, step, bridge: server.getShips(), enemies: server.enemies as any, gd: server.gameData };
}

const hold = (pid: number, x: number, y: number) => { Position.x[pid] = x; Position.y[pid] = y; Velocity.x[pid] = 0; Velocity.y[pid] = 0; };
const foes = (w: ReturnType<typeof world>) => [...w.bridge.bodies.keys()].filter((e) => w.enemies.factionOf(e) && !w.enemies.info(e)?.boss);

describe('arrivals: nothing appears out of nowhere beside you', () => {
  it('packs come in from past the radar (or launch from their outpost, or out of a gate)', () => {
    const w = world();
    const { pid, conn } = w.pilots[0];
    const num = w.gd.getSystemNum('ashfall');
    (w.server as any).travelTo(conn, num, 9000, -30000, false);
    w.step(5);
    const at = { x: 9000, y: -30000 };
    const lair = (w.gd.bossesFile as any).bosses.boss_redtooth_hold.lair;
    const gates = w.gd.getSystem('ashfall')!.portals.map((p) => p.position);
    const seen = new Set<number>();
    for (let i = 0; i < 60 * 60 && seen.size < 6; i++) {
      hold(pid, at.x, at.y);
      w.step();
      for (const e of foes(w)) {
        if (seen.has(e)) continue;
        seen.add(e);
        const near = (p: { x: number; y: number }, r: number) => Math.hypot(Position.x[e] - p.x, Position.y[e] - p.y) < r;
        const fromBase = near(lair, 2500) || gates.some((g) => near(g, 2500));
        expect(fromBase || !near(at, 9000), `enemy ${e} turned up ${Math.round(Math.hypot(Position.x[e] - at.x, Position.y[e] - at.y))} away`).toBe(true);
      }
    }
    expect(seen.size).toBeGreaterThan(0);
  });

  it('out of a gate: it spools up for all to see, then they come through', () => {
    const w = world();
    const { pid, got } = w.pilots[0];
    const num = InSystem.systemId[pid];
    w.enemies.data.rules.gateChance = 1;
    const gate = w.gd.getSystem('sol')!.portals[0].position;
    hold(pid, gate.x + 9000, gate.y);
    w.enemies.arrive(num, { faction: 'frost', ships: ['frost_shard', 'frost_shard'] }, [pid]);
    const warn = got.find((m) => m.type === 'effect' && (m as any).effectType === EffectType.WarpIn && (m as any).data?.[0] === 2) as any;
    expect(warn).toBeDefined();
    expect(foes(w).filter((e) => w.enemies.factionOf(e) === 'frost').length).toBe(0);
    for (let i = 0; i < 60 * 4; i++) { hold(pid, gate.x + 9000, gate.y); w.step(); }
    // (The system's own packs may turn up meanwhile: these are the two that came through the gate)
    const came = foes(w).filter((e) => w.enemies.factionOf(e) === 'frost');
    for (const e of came) expect(Math.hypot(Position.x[e] - warn.x, Position.y[e] - warn.y)).toBeLessThan(1500);
    expect(came.length).toBe(2);
  });

  it("an outpost launches its faction's packs, and a boss's escorts come out of its hull", () => {
    const w = world();
    const { pid, conn } = w.pilots[0];
    const num = w.gd.getSystemNum('ashfall');
    (w.server as any).travelTo(conn, num, 30000, 30000, false);
    w.step(130);
    const hold_ = (w.server as any).bosses.eidOf('boss_redtooth_hold');
    expect(hold_).toBeGreaterThanOrEqual(0);
    w.enemies.data.rules.gateChance = 0;
    let launched = 0;
    for (let k = 0; k < 12; k++) {
      const before = new Set(foes(w));
      w.enemies.arrive(num, { faction: 'redtooth', ships: ['redtooth_cutter'] }, [pid]);
      for (const e of foes(w)) if (!before.has(e) && Math.hypot(Position.x[e] - Position.x[hold_], Position.y[e] - Position.y[hold_]) < 1500) launched++;
    }
    expect(launched).toBeGreaterThan(2);
  });
});

describe('enemy tactics', () => {
  it('they fire out to their guns’ real reach when a hit is likely, not only once they’re close', () => {
    const w = world();
    const { pid } = w.pilots[0];
    const num = InSystem.systemId[pid];
    hold(pid, 90000, 90000);
    // A pirate skiff (grid: its guns are parts) prefers 700 out; its cannon reaches far further
    const [foe] = w.enemies.spawnPack(num, { faction: 'pirates', ships: ['pirate_skiff'] }, 90000, 91800);
    w.enemies.pin?.(foe);
    let shots = 0;
    const ship = w.bridge.get(pid)!;
    const full = ship.hp.reduce((a, b) => a + b, 0) + ship.shield;
    for (let i = 0; i < 60 * 6; i++) {
      hold(pid, 90000, 90000); hold(foe, 90000, 91800);
      w.step();
      shots += [...w.bridge.bodies.keys()].length ? 0 : 0;
    }
    const e = w.enemies.enemies.get(foe);
    expect(e.reach).toBeGreaterThan(1800);
    const now = ship.hp.reduce((a, b) => a + b, 0) + ship.shield;
    expect(now).toBeLessThan(full);
    void shots;
  });

  it('shot at from beyond their reach, they close in instead of sitting there', () => {
    const w = world();
    const { pid } = w.pilots[0];
    const num = InSystem.systemId[pid];
    hold(pid, 90000, 90000);
    const [foe] = w.enemies.spawnPack(num, { faction: 'pirates', ships: ['pirate_raider'] }, 90000, 93000);
    w.step(30);
    const e = w.enemies.enemies.get(foe);
    e.reach = 1200; // a short-ranged gun, for this test
    const start = Math.hypot(Position.x[foe] - 90000, Position.y[foe] - 90000);
    for (let i = 0; i < 60 * 3; i++) {
      hold(pid, 90000, 90000);
      if (i % 20 === 0) { const s = w.bridge.get(foe)!; w.bridge.hurt(foe, s, s.blueprint.parts.findIndex((p) => p.fn !== 'core'), 1, pid); }
      w.step();
    }
    const end = Math.hypot(Position.x[foe] - 90000, Position.y[foe] - 90000);
    expect(end).toBeLessThan(start - 600);
  });

  it('a pack turns on whoever is hurting it, and fans out round its target', () => {
    const w = world(['near', 'far']);
    const [a, b] = w.pilots;
    const num = InSystem.systemId[a.pid];
    InSystem.systemId[b.pid] = num;
    hold(a.pid, 90000, 90000); hold(b.pid, 90000, 92500);
    const pack = w.enemies.spawnPack(num, { faction: 'pirates', ships: ['pirate_skiff', 'pirate_skiff', 'pirate_skiff'] }, 90000, 89000);
    for (let i = 0; i < 60; i++) { hold(a.pid, 90000, 90000); hold(b.pid, 90000, 92500); w.step(); }
    // The far pilot opens up on them
    for (const f of pack) { const s = w.bridge.get(f)!; w.bridge.hurt(f, s, s.blueprint.parts.findIndex((p) => p.fn !== 'core'), 1, b.pid); }
    for (let i = 0; i < 60; i++) { hold(a.pid, 90000, 90000); hold(b.pid, 90000, 92500); w.step(); }
    const targets = pack.filter((f: number) => w.bridge.has(f)).map((f: number) => w.enemies.targetOf(f));
    expect(targets.filter((t: number) => t === b.pid).length).toBeGreaterThanOrEqual(2);
    // Flanks: each has its own place round the target
    const flanks = new Set(pack.map((f: number) => w.enemies.enemies.get(f)?.flank));
    expect(flanks.size).toBe(3);
  });

  describe('chases', () => {
    const shoot = (w: ReturnType<typeof world>, foe: number, pid: number) => {
      const s = w.bridge.get(foe)!;
      w.bridge.hurt(foe, s, s.blueprint.parts.findIndex((p) => p.fn !== 'core'), 1, pid);
    };

    it('shot at from far outside their sight, they turn and come after the shooter', () => {
      const w = world();
      const { pid } = w.pilots[0];
      const num = InSystem.systemId[pid];
      const [foe] = w.enemies.spawnPack(num, { faction: 'pirates', ships: ['pirate_raider'] }, 90000, 90000);
      // Past twice a pirate's sight (2600), well out of its patrol
      hold(pid, 90000, 97000);
      w.step(30);
      expect(w.enemies.targetOf(foe)).not.toBe(pid);
      shoot(w, foe, pid);
      const start = Math.hypot(Position.x[foe] - 90000, Position.y[foe] - 97000);
      for (let i = 0; i < 60 * 3; i++) { hold(pid, 90000, 97000); w.step(); }
      expect(w.enemies.targetOf(foe)).toBe(pid);
      expect(Math.hypot(Position.x[foe] - 90000, Position.y[foe] - 97000)).toBeLessThan(start - 300);
    });

    it('they follow past their leash while the fight goes on, and break off once dragged far out and left alone', () => {
      const w = world();
      const { pid } = w.pilots[0];
      const num = InSystem.systemId[pid];
      const [foe] = w.enemies.spawnPack(num, { faction: 'pirates', ships: ['pirate_raider'] }, 90000, 90000);
      w.step(30);
      // Three leashes (9000) from home, still being shot at: it stays on its target
      const at = { x: 90000 + 27000, y: 90000 };
      for (let i = 0; i < 60 * 6; i++) {
        hold(foe, at.x, at.y); hold(pid, at.x + 1200, at.y);
        if (i % 60 === 0) shoot(w, foe, pid);
        w.step();
      }
      expect(w.enemies.targetOf(foe)).toBe(pid);
      expect(w.enemies.enemies.get(foe)?.state).toBe('engage');
      // Nobody shoots it for a while: it gives up and heads home
      let left = false;
      for (let i = 0; i < 60 * 14 && !left; i++) {
        hold(foe, at.x, at.y); hold(pid, at.x + 1200, at.y);
        w.step();
        left = w.enemies.enemies.get(foe)?.state === 'return';
      }
      expect(left).toBe(true);
    });

    it('a little past their leash, they keep chasing even when the shooting stops', () => {
      const w = world();
      const { pid } = w.pilots[0];
      const num = InSystem.systemId[pid];
      const [foe] = w.enemies.spawnPack(num, { faction: 'pirates', ships: ['pirate_raider'] }, 90000, 90000);
      w.step(30);
      const at = { x: 90000 + 12000, y: 90000 };
      shoot(w, foe, pid);
      // (The pilot kept whole: this is about the chase, not whether a raider can kill them in the time)
      for (let i = 0; i < 60 * 15; i++) { hold(foe, at.x, at.y); hold(pid, at.x + 1200, at.y); if (i % 60 === 0) w.server.getShips().scaleHp(pid, 1); w.step(); }
      expect(w.enemies.targetOf(foe)).toBe(pid);
    });

    it('a target that gets well away loses them', () => {
      const w = world();
      const { pid } = w.pilots[0];
      const num = InSystem.systemId[pid];
      const [foe] = w.enemies.spawnPack(num, { faction: 'pirates', ships: ['pirate_raider'] }, 90000, 90000);
      for (let i = 0; i < 60; i++) { hold(pid, 90000, 91000); w.step(); }
      expect(w.enemies.targetOf(foe)).toBe(pid);
      let lost = false;
      for (let i = 0; i < 60 * 6 && !lost; i++) {
        hold(foe, 90000, 90000); hold(pid, 90000, 90000 + 9000);
        w.step();
        lost = w.enemies.targetOf(foe) !== pid;
      }
      expect(lost).toBe(true);
    });
  });

  it("when most of a pack is gone, the rest lose their nerve (factions that ever run)", () => {
    const w = world();
    const { pid } = w.pilots[0];
    const num = InSystem.systemId[pid];
    hold(pid, 90000, 90000);
    const pack = w.enemies.spawnPack(num, { faction: 'pirates', ships: ['pirate_skiff', 'pirate_skiff', 'pirate_skiff', 'pirate_skiff', 'pirate_skiff'] }, 90000, 89000);
    for (let i = 0; i < 90; i++) { hold(pid, 90000, 90000); w.step(); }
    for (const f of pack.slice(1)) w.bridge.removeShip(f);
    const last = pack[0], s = w.bridge.get(last)!;
    const core = s.blueprint.parts.findIndex((p) => p.fn === 'core');
    s.hp[core] = s.maxHp[core] * 0.5;
    for (let i = 0; i < 60; i++) { hold(pid, 90000, 90000); w.step(); }
    expect(w.enemies.enemies.get(last)?.state).toBe('flee');
  });
});
