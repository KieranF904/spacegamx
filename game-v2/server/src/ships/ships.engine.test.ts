import { describe, it, expect, beforeEach } from 'vitest';
import { join } from 'path';
import { readFileSync } from 'fs';
import * as bitecs from 'bitecs';
import { hasComponent } from 'bitecs';
import {
  Position, Velocity, Rotation, Health, Dead, Projectile, ServerMessage, Radius, Lifetime, ShipState,
  BULLET_SPEED, BLASTER_LIFE_TICKS, BANK,
  parseBlueprint, ShipTuning, CatalogFiles, Blueprint,
} from '@space-game/common';
import { createLocalServer } from '../createLocalServer.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { recordInputs, runReplay, RecordedInput } from './replay.js';

const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const dataDir = join(__dirname, '../../../data');
const files = readGameDataFiles(dataDir);
const json = (p: string) => JSON.parse(readFileSync(join(dataDir, 'ships', p), 'utf-8'));
const tuning: ShipTuning = json('tuning.json');
const catalog: CatalogFiles = { pieces: json('pieces.json'), functions: json('functions.json'), materials: json('materials.json'), models: json('models.json') };
const sparrow: Blueprint = parseBlueprint(readFileSync(join(dataDir, 'ships/blueprints/sparrow-t.json'), 'utf-8'));
const ships = { catalog, tuning, starter: sparrow, inventory: json('inventory.json') };
/** The starter with legacy cannons where its Pips are (fixed: a part's own mount): how enemies' guns fire */
const legacySparrow: Blueprint = { ...sparrow, parts: sparrow.parts.map((p) => (p.fn === 'cannon_pip' ? { ...p, fn: 'weapon', material: 'alloy' } : p)) };

const idle: RecordedInput = { forward: false, backward: false, left: false, right: false, boost: false, fireLeft: false, fireRight: false, targetAngle: -Math.PI / 2 };

function setup() {
  resetGlobals();
  const server = createLocalServer({ files, ships, autoStart: false });
  const transport = new LocalTransport(server);
  const received: ServerMessage[] = [];
  transport.onMessage = (m) => received.push(m);
  transport.connect();
  transport.send({ type: 'join', username: 't' } as any);
  const pid = transport.getPlayerId();
  Position.x[pid] = 0; Position.y[pid] = 0; Rotation.angle[pid] = -Math.PI / 2;
  let seq = 1;
  const input = (i: Partial<RecordedInput>) => transport.send({ type: 'input', seq: seq++, tick: 0, ...idle, ...i });
  // Component arrays outlive a test: start every test with hands off the controls
  input({});
  // (Effects wait a tick or two for the next frame: take them as they happen here)
  const run = (n: number) => { for (let k = 0; k < n; k++) { server.step(); server.flushLazy(); } };
  return { server, bridge: server.getShips(), transport, received, pid, input, run };
}

beforeEach(() => resetGlobals());

/** Distances below were laid out for 8-unit cells; they scale with the ship size */
const CELL = tuning.cellSize / 8;

/** Projectiles owned by `owner` that exist in this world (component arrays are globals, so check membership). */
function liveShots(world: any, owner: number): number[] {
  return [...Array(5000).keys()].filter((e) => bitecs.entityExists(world, e) && hasComponent(world, Projectile, e)
    && !hasComponent(world, Dead, e) && Projectile.ownerId[e] === owner);
}

describe('modular ship in the engine (M2/M3)', () => {
  it('the player spawns as Sparrow T, with core HP as health', () => {
    const { bridge, pid } = setup();
    const ship = bridge!.get(pid)!;
    expect(ship.blueprint.name).toBe('Sparrow T');
    expect(Health.max[pid]).toBe(ship.maxHp[0]);
    expect(Health.current[pid]).toBe(ship.maxHp[0]);
  });

  it('flies forward twice as far as the old triangle did (within 5% over 5 seconds)', () => {
    // Measured from the removed triangle ship (stepPlayerPhysics, full forward
    // thrust from rest, 300 ticks); ships were then made to move twice as fast
    const legacy = 2574 * 2;
    const { pid, input, run } = setup();
    input({ forward: true });
    run(300);
    const modular = -Position.y[pid];
    expect(legacy).toBeGreaterThan(500);
    expect(Math.abs(modular - legacy) / legacy).toBeLessThan(0.05);
  });

  it('turns towards the cursor', () => {
    const { pid, input, run } = setup();
    input({ targetAngle: 0 });
    run(120);
    expect(Math.abs(Rotation.angle[pid])).toBeLessThan(0.02);
  });
});

describe('weapons, part hits and debris (M5)', () => {
  it('weapons fire the base shot from both muzzles at the derived interval', () => {
    const { server, bridge, pid, input, run } = setup();
    // The starter's Pips are fixed guns, at their own interval (a model's: every 20 ticks, heavier-shots-2026-11; its legacy fixed guns fired every 15)
    const interval = bridge!.get(pid)!.derived.weapons[0].interval;
    expect(bridge!.get(pid)!.derived.weapons.map((w) => w.mount)).toEqual(['fixed', 'fixed']);
    expect(interval).toBeCloseTo(20, 2);
    input({ fireLeft: true });
    run(1);
    const shots = () => liveShots(server.getWorld(), pid);
    expect(shots().length).toBe(2);
    run(Math.ceil(interval) - 1);
    expect(shots().length).toBe(2);
    run(1);
    expect(shots().length).toBe(4);
  });

  it("a Pip's shells are the base shot at its model's speed", () => {
    const { server, pid, input, run } = setup();
    input({ fireLeft: true });
    run(1);
    const [shot] = liveShots(server.getWorld(), pid);
    const speed = Math.hypot(Velocity.x[shot] - Velocity.x[pid] * 0.3, Velocity.y[shot] - Velocity.y[pid] * 0.3);
    // (The Pip's own 54, heavier-shots-2026-11: the base shot's 48 x 54 / 48)
    expect(speed / (BULLET_SPEED * 54 / 48)).toBeGreaterThan(0.98);
    expect(speed / (BULLET_SPEED * 54 / 48)).toBeLessThan(1.02);
    expect(Radius.value[shot]).toBeCloseTo(5, 5);
  });

  it('legacy fixed cannons fire a third slower than the base rate', () => {
    const { server, bridge, pid, input, run } = setup();
    bridge!.respawnInPlace(pid, legacySparrow);
    const interval = bridge!.get(pid)!.derived.weapons[0].interval;
    expect(interval).toBeCloseTo(10 * bridge!.tuning.fixedGun!.intervalScale!, 2);
    expect(interval).toBeCloseTo(15, 2);
    input({ fireLeft: true });
    run(1);
    const shots = () => liveShots(server.getWorld(), pid);
    expect(shots().length).toBe(2);
    run(Math.ceil(interval) - 1);
    expect(shots().length).toBe(2);
    run(1);
    expect(shots().length).toBe(4);
  });

  it('legacy fixed-cannon shells fly 30% slower than the base shot, 50% bigger, with the same range', () => {
    const { server, bridge, pid, input, run } = setup();
    bridge!.respawnInPlace(pid, legacySparrow);
    input({ fireLeft: true });
    run(1);
    const [shot] = liveShots(server.getWorld(), pid);
    const speed = Math.hypot(Velocity.x[shot] - Velocity.x[pid] * 0.3, Velocity.y[shot] - Velocity.y[pid] * 0.3);
    expect(speed / BULLET_SPEED).toBeGreaterThan(0.7 * 0.98);
    expect(speed / BULLET_SPEED).toBeLessThan(0.7 * 1.02);
    expect(Radius.value[shot]).toBeCloseTo(7.5, 5);
    expect(Lifetime.remaining[shot] * speed).toBeGreaterThan(BLASTER_LIFE_TICKS * BULLET_SPEED * 0.95);
  });

  it('a dummy can be shot apart into drifting debris', () => {
    const { bridge, pid, input, run } = setup();
    const dummy = bridge!.spawnDummy(sparrow, Position.x[pid], -240 * CELL, Math.PI / 2);
    input({ fireLeft: true });
    // Loose parts crumble away over time, so watch for debris as it happens
    let debris: ShipState[] = [];
    for (let t = 0; t < 3000 && !debris.length; t += 10) {
      run(10);
      debris = [...bridge!.bodies.values()].filter((s) => s.kind === 'debris');
    }
    expect(debris.length).toBeGreaterThan(0);
    // Debris inherits parts (with their uids) and drifts
    for (const d of debris) {
      expect(d.blueprint.parts.length).toBeGreaterThan(0);
      for (const part of d.blueprint.parts) expect(sparrow.parts.some((q) => q.uid === part.uid)).toBe(true);
    }
    // Either the dummy lost parts or its core went and it's gone entirely
    const left = bridge!.get(dummy);
    expect(!left || left.detached.some(Boolean) || left.hp.some((h) => h <= 0)).toBe(true);
  });

  it('cutting a part off the structure turns its group into debris with its HP', () => {
    const { bridge, pid, run } = setup();
    const ship = bridge!.get(pid)!;
    // Weapon 2 and hull 7 hang off the left; hull 7 also touches tri 9 and tri 10.
    // Kill hull 7: tri 9 (left wing) is then only connected through it → orphaned.
    const idx = (uid: number) => ship.blueprint.parts.findIndex((p) => p.uid === uid);
    ship.hp[idx(9)] = ship.maxHp[idx(9)] * 0.6;
    bridge!.damagePartFraction(pid, idx(7), 1);
    run(1);
    expect(ship.detached[idx(9)]).toBe(true);
    const debris = [...bridge!.bodies.values()].find((s) => s.kind === 'debris' && s.blueprint.parts.some((p) => p.uid === 9))!;
    expect(debris).toBeDefined();
    expect(debris.hp[debris.blueprint.parts.findIndex((p) => p.uid === 9)]).toBeCloseTo(ship.maxHp[idx(9)] * 0.6, 9);
  });

  it('core loss: the whole ship becomes debris and the respawn flow runs', () => {
    const { bridge, pid, received, transport, run } = setup();
    bridge!.damagePartFraction(pid, 0, 1);
    run(2);
    expect(received.some((m) => m.type === 'death' && (m as any).entityId === pid)).toBe(true);
    expect([...bridge!.bodies.values()].filter((s) => s.kind === 'debris').length).toBeGreaterThan(0);
    transport.send({ type: 'respawn' } as any);
    const newId = transport.getPlayerId();
    expect(bridge!.get(newId)?.kind).toBe('ship');
    expect(Health.current[newId]).toBeGreaterThan(0);
  });

  it('debris despawns after its lifetime', () => {
    const { bridge, pid, run } = setup();
    bridge!.damagePartFraction(pid, 0, 1);
    run(2);
    expect([...bridge!.bodies.values()].some((s) => s.kind === 'debris')).toBe(true);
    run(tuning.debris.lifetimeTicks + 1);
    expect([...bridge!.bodies.values()].some((s) => s.kind === 'debris')).toBe(false);
  });
});

describe('destroyed parts, decay and station repair', () => {
  const partsOf = (bp: Blueprint, fn: string) => bp.parts.map((p, i) => (p.fn === fn ? i : -1)).filter((i) => i >= 0);
  const destroyed = (received: ServerMessage[]) => received.filter((m) => m.type === 'partDestroyed') as Extract<ServerMessage, { type: 'partDestroyed' }>[];

  it('a destroyed core blows up: neighbours are scorched, and what survives drifts off as debris', () => {
    const { bridge, run, received } = setup();
    const dummy = bridge!.spawnDummy(sparrow, 3000, 3000, 0);
    const core = partsOf(sparrow, 'core')[0];
    bridge!.damagePartFraction(dummy, core, 1);
    run(2);
    expect(bridge!.get(dummy)).toBeUndefined();
    const coreFx = destroyed(received).find((m) => m.bodyId === dummy && m.part === core)!;
    expect(coreFx.how).toBe('blast');
    expect(coreFx.size).toBeCloseTo(2.5 * tuning.cellSize, 5);
    const debris = [...bridge!.bodies.values()].filter((s) => s.kind === 'debris');
    expect(debris.length).toBeGreaterThan(0);
    // The blast hurt what was left
    expect(debris.some((d) => d.hp.some((h, i) => h > 0 && h < d.maxHp[i]))).toBe(true);
  });

  it('with no core, loose parts crumble away one by one until nothing is left', () => {
    const { bridge, run, received } = setup();
    const dummy = bridge!.spawnDummy(sparrow, 3000, 3000, 0);
    bridge!.damagePartFraction(dummy, partsOf(sparrow, 'core')[0], 1);
    run(2);
    const parts = () => [...bridge!.bodies.values()].filter((s) => s.kind === 'debris').reduce((n, d) => n + d.derived.alive.filter(Boolean).length, 0);
    const start = parts();
    expect(start).toBeGreaterThan(0);
    const life = tuning.debris.decayTicks!;
    run(Math.round(life * 0.7));
    // Some gone, some still there
    expect(parts()).toBeLessThan(start);
    expect(destroyed(received).some((m) => m.how === 'crumble')).toBe(true);
    run(Math.round(life * 0.6) + 10);
    expect(parts()).toBe(0);
    // Crumbling parts don't blow up
    expect(destroyed(received).filter((m) => m.how === 'crumble').every((m) => m.size < 2 * tuning.cellSize)).toBe(true);
  });

  it('a destroyed generator blows up a few ticks later, damaging the parts around it', () => {
    const { bridge, run, received } = setup();
    const dummy = bridge!.spawnDummy(sparrow, 3000, 3000, 0);
    const ship = bridge!.get(dummy)!;
    // (The starter's Cell Reactors blow up as generators did)
    const gen = partsOf(sparrow, 'power_cell_reactor')[0];
    bridge!.damagePartFraction(dummy, gen, 1);
    run(1);
    expect(destroyed(received).find((m) => m.part === gen)?.how).toBe('blast');
    const core = partsOf(sparrow, 'core')[0];
    const before = ship.hp[core];
    run(tuning.partBlast!.generator.delayTicks[1] + 1);
    expect(ship.hp[core]).toBeLessThan(before);
  });

  it('a shot-off hull plate just breaks', () => {
    const { bridge, run, received } = setup();
    const dummy = bridge!.spawnDummy(sparrow, 3000, 3000, 0);
    const hull = partsOf(sparrow, 'hull')[0];
    bridge!.damagePartFraction(dummy, hull, 1);
    run(1);
    expect(destroyed(received).find((m) => m.part === hull)?.how).toBe('break');
  });

  it('near a station a ship is mended from the repair bank (never free), regrowing lost parts from the core outwards', () => {
    const { server, bridge, pid, run } = setup();
    const host = (bridge as unknown as { host: { nearRepairSite?: (eid: number) => boolean; payBankRepair?: () => boolean; payBankRebuild?: () => boolean } }).host;
    let near = false, bankPays = false, paid = 0;
    host.nearRepairSite = () => near;
    host.payBankRepair = () => { if (bankPays) paid++; return bankPays; };
    host.payBankRebuild = () => { if (bankPays) paid++; return bankPays; };
    const ship = bridge!.get(pid)!;
    // Shoot off the left weapon (part 2): hull 7 and the tris behind it may fall away with it
    bridge!.damagePartFraction(pid, 2, 1);
    bridge!.damagePartFraction(pid, 4, 0.5); // and dent the generator
    run(2);
    const missing = () => ship.blueprint.parts.filter((_, i) => !ship.derived.alive[i]).length;
    expect(missing()).toBeGreaterThan(0);
    // Away from a station nothing happens
    run(300);
    expect(missing()).toBeGreaterThan(0);
    expect(ship.hp[4]).toBeLessThan(ship.maxHp[4]);
    // Near one with nothing in the bank: nothing is mended (no free station repair)
    near = true;
    const hurt = missing();
    run(600);
    expect(missing()).toBe(hurt);
    expect(ship.hp[4]).toBeLessThan(ship.maxHp[4]);
    expect(paid).toBe(0);
    // With the bank paying, everything comes back and heals to full
    bankPays = true;
    run(BANK.stationPartSeconds * 60 * (missing() + 1) + Math.ceil(60 / BANK.stationHealPerSecond) + 120);
    expect(missing()).toBe(0);
    expect(ship.hp.every((h, i) => h >= ship.maxHp[i] - 1e-9)).toBe(true);
    expect(paid).toBeGreaterThan(0);
    void server;
  });

  it('repairs wait a while after taking damage', () => {
    const { bridge, pid, run } = setup();
    const host = (bridge as unknown as { host: { nearRepairSite?: (eid: number) => boolean; payBankRepair?: () => boolean; payBankRebuild?: () => boolean } }).host;
    host.nearRepairSite = () => true;
    host.payBankRepair = () => true;
    host.payBankRebuild = () => true;
    const ship = bridge!.get(pid)!;
    // Ram damage counts as being in combat
    const dummy = bridge!.spawnDummy(sparrow, 0, -3 * tuning.cellSize * 3, Math.PI / 2);
    Velocity.y[dummy] = 8;
    let ticks = 0;
    while (ship.hp.every((h, i) => h >= ship.maxHp[i]) && ticks++ < 120) run(1);
    const dented = ship.hp.findIndex((h, i) => h > 0 && h < ship.maxHp[i]);
    expect(dented).toBeGreaterThanOrEqual(0);
    const hp = ship.hp[dented];
    run(Math.floor(tuning.repair!.combatPauseTicks * 0.8));
    expect(ship.hp[dented]).toBeLessThanOrEqual(hp);
  });
});

describe('turrets and helm in the engine', () => {
  // (The Hauler: two turrets down each side, no fixed gun; the Drum: a turret at each front corner, its bow before them)
  const corsair: Blueprint = parseBlueprint(readFileSync(join(dataDir, 'ships/blueprints/hauler.json'), 'utf-8'));
  const drum: Blueprint = parseBlueprint(readFileSync(join(dataDir, 'ships/blueprints/drum.json'), 'utf-8'));

  function broadside(targetAngle: number, bp = corsair) {
    const { server, bridge, pid, input, run } = setup();
    bridge!.respawnInPlace(pid, bp);
    Rotation.angle[pid] = -Math.PI / 2; // nose up: port is -x, starboard +x
    input({ helm: true, fireLeft: true, targetAngle });
    run(90);
    const shots = liveShots(server.getWorld(), pid);
    return { shots, px: Position.x[pid], pid };
  }

  it('with the cursor to port, only the port battery fires', () => {
    const { shots, px } = broadside(Math.PI);
    expect(shots.length).toBeGreaterThan(8);
    for (const e of shots) expect(Projectile.spawnX[e]).toBeLessThan(px);
  });

  it('with the cursor to starboard, only the starboard battery fires', () => {
    const { shots, px } = broadside(0);
    expect(shots.length).toBeGreaterThan(8);
    for (const e of shots) expect(Projectile.spawnX[e]).toBeGreaterThan(px);
  });

  it('nothing fires dead ahead: no turret can see through the bow', () => {
    const { shots } = broadside(-Math.PI / 2, drum);
    expect(shots.length).toBe(0);
  });

  it('turrets converge on the cursor point when its distance is known', () => {
    const { bridge, pid, input, run } = setup();
    bridge!.respawnInPlace(pid, corsair);
    Rotation.angle[pid] = -Math.PI / 2;
    const portAims = () => {
      const s = bridge!.get(pid)!;
      return s.derived.weapons.filter((w) => w.window && s.blueprint.parts[w.part].x < 0)
        .sort((a, b) => s.blueprint.parts[a.part].y - s.blueprint.parts[b.part].y)
        .map((w) => s.aim[w.part]);
    };
    input({ helm: true, targetAngle: Math.PI, cursorDist: 0 });
    run(40);
    const parallel = portAims();
    input({ helm: true, targetAngle: Math.PI, cursorDist: 120 });
    run(40);
    const converged = portAims();
    // Parallel: every port turret points the same way
    expect(Math.max(...parallel) - Math.min(...parallel)).toBeLessThan(1e-6);
    // Converged: the bow gun swings aft and the stern gun forward, towards the point
    expect(converged[converged.length - 1] - converged[0]).toBeGreaterThan(0.2);
  });

  it('helm mode holds heading while the cursor moves', () => {
    const { pid, input, run } = setup();
    input({ helm: true, targetAngle: 1.0 });
    run(60);
    expect(Rotation.angle[pid]).toBeCloseTo(-Math.PI / 2, 4); // headings are rounded to 5 decimals
  });
});

describe('ship collisions (M5)', () => {
  // Two dummies nose to nose 80 units apart, closing at `speed` each
  function ram(speed: number) {
    const { server, bridge, run } = setup();
    // (A contact's sparks: every client finds the pairs it holds itself and draws theirs, the rest come with its snapshot
    // (Replication.contactFxFor); the server's own note of each is what's counted here)
    const received: ServerMessage[] = [];
    const rep = (server as any).replication, note = rep.noteContactFx.bind(rep);
    rep.noteContactFx = (tick: number, sys: number, a: number, b: number, msg: ServerMessage) => { received.push(msg); note(tick, sys, a, b, msg); };
    const a = bridge!.spawnDummy(sparrow, 0, 1000, -Math.PI / 2);  // faces up
    // Nose to nose, 50 units apart whatever the cell size (the nose is the cap at grid y = -1)
    const nose = (bridge!.get(a)!.derived.com[1] + 1) * tuning.cellSize;
    const b = bridge!.spawnDummy(sparrow, 0, 1000 - 2 * nose - 50, Math.PI / 2);  // faces down
    Velocity.y[a] = -speed;
    Velocity.y[b] = speed;
    let ticks = 0;
    while (Velocity.y[a] < 0 && ticks++ < 120) run(1);
    return { A: bridge!.get(a)!, B: bridge!.get(b)!, a, b, received };
  }
  const damaged = (s: { hp: number[]; maxHp: number[] }) => s.hp.map((h, i) => i).filter((i) => s.hp[i] < s.maxHp[i]);

  it('a fast ram bounces both ships and damages the parts on the contact side', () => {
    const { A, B, a, b } = ram(6);
    expect(Velocity.y[a]).toBeGreaterThan(0);
    expect(Velocity.y[b]).toBeLessThan(0);
    for (const s of [A, B]) {
      const hit = damaged(s).map((i) => s.blueprint.parts[i].uid);
      expect(hit.length).toBeGreaterThan(0);
      // Only nose-side parts (cap = uid 1, front weapons 2/3) touch first
      for (const uid of hit) expect([1, 2, 3, 0]).toContain(uid);
    }
  });

  it('a ram sends one contact effect where the hulls meet', () => {
    const { received } = ram(6);
    const contacts = received.filter((m) => m.type === 'contact') as Extract<ServerMessage, { type: 'contact' }>[];
    expect(contacts.length).toBe(1);
    expect(contacts[0].speed).toBeGreaterThan(6);
    expect(Math.abs(contacts[0].ny)).toBeCloseTo(1, 1);
  });

  it('a gentle bump bounces without damage', () => {
    const { A, B, a } = ram(0.5);
    expect(Velocity.y[a]).toBeGreaterThanOrEqual(0);
    expect(damaged(A)).toEqual([]);
    expect(damaged(B)).toEqual([]);
  });
});

describe('determinism (M6)', () => {
  it(`a ${tuning.debug.replayTicks}-tick replay hash matches on ${tuning.debug.replayRuns} runs`, () => {
    const inputs = recordInputs(1234, tuning.debug.replayTicks);
    const runs = Array.from({ length: tuning.debug.replayRuns }, () => runReplay({ files, ships, inputs, dummy: sparrow }));
    expect(runs[0].ticks).toBe(tuning.debug.replayTicks);
    expect(runs[0].bodies).toBeGreaterThan(1);
    expect(new Set(runs.map((r) => r.hash)).size).toBe(1);
    // and the hash actually depends on the inputs
    const other = runReplay({ files, ships, inputs: recordInputs(99, tuning.debug.replayTicks), dummy: sparrow });
    expect(other.hash).not.toBe(runs[0].hash);
  });
});

describe('fixed guns', () => {
  const DEG = Math.PI / 180;
  // (Two fixed guns forward: legacy cannons, as the starter's Pips once were)
  const fixedSetup = () => {
    const t = setup();
    t.bridge!.respawnInPlace(t.pid, legacySparrow);
    return t;
  };
  const fireAt = (offsetDeg: number) => {
    const { server, pid, input, run } = fixedSetup();
    // Helm mode: the ship holds its heading (straight up) instead of turning to the cursor
    input({ helm: true, fireLeft: true, targetAngle: -Math.PI / 2 + offsetDeg * DEG, cursorDist: 0 });
    run(40);
    return liveShots(server.getWorld(), pid).map((e) => Math.atan2(Velocity.y[e], Velocity.x[e]));
  };

  it('hold fire while the target is off the barrel, beyond their 2° gimbal', () => {
    expect(fireAt(10)).toEqual([]);
    expect(fireAt(-4)).toEqual([]);
  });

  it('fire when the target is within the gimbal, swivelled towards it', () => {
    const angles = fireAt(1.5);
    expect(angles.length).toBeGreaterThan(0);
    // Each round leaves along the gimballed barrel, give or take the base shot's ±1.8° scatter...
    const offsets = angles.map((a) => (a + Math.PI / 2) / DEG);
    for (const o of offsets) expect(Math.abs(o - 1.5)).toBeLessThan(1.9);
    // ...so on average they lean towards the target, not straight ahead
    expect(offsets.reduce((a, b) => a + b, 0) / offsets.length).toBeGreaterThan(0.5);
  });

  it('fire at a close target the ship is pointed at, even when it sits well off the barrels', () => {
    const { server, bridge, pid, input, run } = fixedSetup();
    const ship = bridge!.get(pid)!;
    // Just past the nose: from a gun out to the side, the target is far beyond its 2° gimbal
    const dist = ship.derived.radius * 1.3;
    const offAxis = ship.derived.weapons.filter((w) => !w.window).map((w) => {
      const lateral = Math.abs(w.muzzle[0] - ship.derived.com[0]) * tuning.cellSize;
      const ahead = dist + (w.muzzle[1] - ship.derived.com[1]) * tuning.cellSize;
      return Math.atan2(lateral, ahead) / DEG;
    });
    expect(Math.max(...offAxis)).toBeGreaterThan(3);
    input({ helm: true, fireLeft: true, targetAngle: -Math.PI / 2, cursorDist: dist });
    run(40);
    const offsets = liveShots(server.getWorld(), pid).map((e) => (Math.atan2(Velocity.y[e], Velocity.x[e]) + Math.PI / 2) / DEG);
    expect(offsets.length).toBeGreaterThan(0);
    // Swivelled as far as they go (2°), plus the base shot's scatter
    for (const o of offsets) expect(Math.abs(o)).toBeLessThan(2 + 1.9);
  });
});
