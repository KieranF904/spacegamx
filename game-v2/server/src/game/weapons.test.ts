import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { readFileSync } from 'fs';
import * as bitecs from 'bitecs';
import { Position, Velocity, Rotation, Input, InSystem, ServerMessage, parseBlueprint, Blueprint, shipPointToWorld, partWeaponDef, pulseProfile, effectiveRange } from '@space-game/common';
import { createProtoServer } from '../proto/createProtoServer.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigFromDisk } from '../ships/loadShipConfig.js';

const dataDir = join(__dirname, '../../../data');
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const files = readGameDataFiles(dataDir);
const ships = loadShipConfigFromDisk(dataDir);
const sparrow: Blueprint = parseBlueprint(readFileSync(join(dataDir, 'ships/blueprints/sparrow-t.json'), 'utf-8'));

function setup() {
  resetGlobals();
  const server = createProtoServer({ files, ships, autoStart: false });
  const t = new LocalTransport(server);
  const got: ServerMessage[] = [];
  t.onMessage = (m) => got.push(m);
  t.connect();
  t.send({ type: 'join', username: 'gunner' } as any);
  const pid = t.getPlayerId();
  Position.x[pid] = 0; Position.y[pid] = 0; Rotation.angle[pid] = -Math.PI / 2;
  const bridge = server.getShips()!;
  const weapons = (server as any).weapons;
  const step = (n = 1) => { for (let i = 0; i < n; i++) server.step(); };
  const damaged = (eid: number) => { const s = bridge.get(eid); return s ? s.hp.reduce((t, h, i) => t + (s.maxHp[i] - h), 0) : Infinity; };
  return { server, t, got, pid, bridge, weapons, step, damaged };
}

/** The Sparrow with its two guns (Pips) swapped for another weapon (a legacy one, as enemies fly, or a model in its own material) */
function armed(fn: string, material = 'alloy'): Blueprint {
  const bp = JSON.parse(JSON.stringify(sparrow));
  for (const p of bp.parts) if (p.fn === 'cannon_pip') Object.assign(p, { fn, material });
  bp.name = `Sparrow ${fn}`;
  return bp;
}

describe('weapons', () => {
  it("shots only hit ships in their own system: instanced copies share coordinates, but not each other's fights", () => {
    const { bridge, weapons, step, damaged, pid } = setup();
    // The same spot in another copy (a siege moon, an arena), and then in this one
    const other = bridge.spawnDummy(sparrow, 0, -600, 0, InSystem.systemId[pid] + 1);
    weapons.spawn(pid, 'cannon', 0, -150, -Math.PI / 2, 1, { speedScale: 1, sizeScale: 1, turret: false });
    step(30);
    expect(damaged(other)).toBe(0);
    const here = bridge.spawnDummy(sparrow, 0, -600, 0, InSystem.systemId[pid]);
    weapons.spawn(pid, 'cannon', 0, -150, -Math.PI / 2, 1, { speedScale: 1, sizeScale: 1, turret: false });
    step(30);
    expect(damaged(here)).toBeGreaterThan(0);
    expect(damaged(other)).toBe(0);
  });

  it('a railgun slug passes through the first ship and hits the one behind it', () => {
    const { bridge, weapons, step, damaged, pid } = setup();
    const a = bridge.spawnDummy(sparrow, 0, -600, 0);
    const b = bridge.spawnDummy(sparrow, 0, -1200, 0);
    weapons.spawn(pid, 'railgun', 0, -150, -Math.PI / 2, 1, { speedScale: 1, sizeScale: 1, turret: false });
    step(20);
    expect(damaged(a)).toBeGreaterThan(0);
    expect(damaged(b)).toBeGreaterThan(0);
  });

  it('a missile homes onto its target even when it launches the wrong way', () => {
    const { bridge, weapons, step, damaged, pid, got } = setup();
    const target = bridge.spawnDummy(sparrow, 900, -900, 0);
    weapons.spawn(pid, 'missile', 0, -150, -Math.PI / 2, 1, { speedScale: 1, sizeScale: 1, turret: false, target });
    step(200);
    expect(damaged(target)).toBeGreaterThan(0);
    expect(got.some((m) => m.type === 'detonation' && (m as any).kind === 'missile')).toBe(true);
  });

  it('flak bursts near a target without needing a direct hit', () => {
    const { bridge, weapons, step, damaged, pid, got } = setup();
    const target = bridge.spawnDummy(sparrow, 120, -700, 0);
    weapons.spawn(pid, 'flak', 0, -150, -Math.PI / 2, 1, { speedScale: 1, sizeScale: 1, turret: false });
    step(40);
    expect(got.some((m) => m.type === 'detonation' && (m as any).kind === 'flak')).toBe(true);
    expect(damaged(target)).toBeGreaterThan(0);
  });

  it('an EMP burst cripples a ship\'s engines for a while (it still flies, much slower)', () => {
    const { bridge, weapons, step, pid, t } = setup();
    const victim = bridge.spawnDummy(sparrow, 0, -600, 0);
    weapons.spawn(victim, 'emp', 0, -450, Math.PI / 2, 1, { speedScale: 1, sizeScale: 1, turret: false });
    step(12);
    expect(bridge.isEmped(pid)).toBe(true);
    expect(bridge.empTicksLeft(pid)).toBeGreaterThan(0);
    let seq = 0;
    const thrust = (n: number) => {
      Velocity.x[pid] = 0; Velocity.y[pid] = 0;
      for (let i = 0; i < n; i++) { t.send({ type: 'input', seq: ++seq, tick: 0, forward: true, backward: false, left: false, right: false, boost: false, fireLeft: false, fireRight: false, targetAngle: -Math.PI / 2 } as any); step(); }
      return Math.hypot(Velocity.x[pid], Velocity.y[pid]);
    };
    // Full throttle while EMP'd: it moves, but a good deal slower than once it's over
    const crippled = thrust(20);
    step(300);
    expect(bridge.isEmped(pid)).toBe(false);
    const healthy = thrust(20);
    expect(crippled).toBeGreaterThan(0.05);
    expect(crippled).toBeLessThan(healthy * 0.6);
  });

  it('shields soak damage first and recharge after a pause', () => {
    const { bridge, step, pid } = setup();
    const bp = JSON.parse(JSON.stringify(sparrow));
    const cap = bp.parts.find((p: any) => p.piece === 'cap');
    Object.assign(cap, { piece: 'sq', fn: 'shield' });
    bridge.respawnInPlace(pid, bp);
    const ship = bridge.get(pid)!;
    expect(ship.derived.shieldMax).toBeGreaterThan(0);
    expect(ship.shield).toBe(ship.derived.shieldMax);
    const core = ship.blueprint.parts.findIndex((p) => p.fn === 'core');
    const coreHp = ship.hp[core];
    bridge.hurt(pid, ship, core, 10, -1);
    expect(ship.hp[core]).toBe(coreHp);
    expect(ship.shield).toBeCloseTo(ship.derived.shieldMax - 10, 5);
    bridge.hurt(pid, ship, core, 70, -1);
    expect(ship.shield).toBe(0);
    expect(ship.hp[core]).toBeLessThan(coreHp);
    step(bridge.tuning.shield!.regenDelayTicks + 120);
    expect(ship.shield).toBeGreaterThan(0);
  });

  it('a beam laser fires charged pulses: each fades in, hits hardest at its peak, trails off, and it never overheats', () => {
    const { bridge, step, pid, t, damaged, server } = setup();
    // One laser (two would take turns, their pulses overlapping)
    const one = armed('laser');
    const second = one.parts.filter((q: any) => q.fn === 'laser')[1];
    second.fn = 'hull';
    delete second.facing;
    bridge.respawnInPlace(pid, one);
    const target = bridge.spawnDummy(sparrow, 0, -500, 0, InSystem.systemId[pid]);
    const ship = bridge.get(pid)!;
    const w = ship.derived.weapons[0];
    const prof = pulseProfile(partWeaponDef(bridge.tuning, w.kind, ship.blueprint.parts[w.part], w).pulse!);
    const per: number[] = [];
    let last = 0, overheated = false;
    for (let i = 0; i < 60 * 4; i++) {
      Position.x[pid] = 0; Position.y[pid] = 0; Velocity.x[pid] = 0; Velocity.y[pid] = 0; Rotation.angle[pid] = -Math.PI / 2;
      Position.x[target] = 0; Position.y[target] = -500;
      t.send({ type: 'input', seq: i + 1, tick: 0, forward: false, backward: false, left: false, right: false, boost: false, fireLeft: true, fireRight: false, targetAngle: -Math.PI / 2, helm: true, cursorDist: 500 } as any);
      step();
      const d = damaged(target);
      per.push(d - last);
      last = d;
      if (ship.overheated.some(Boolean) || ship.heat.some((h) => h > 0)) overheated = true;
    }
    expect(last).toBeGreaterThan(0);
    expect(overheated).toBe(false);
    // The first pulse: little at first, its peak tick the hardest, then less again
    const start = per.findIndex((d) => d > 0);
    const first = per.slice(start, start + prof.ticks);
    const top = first.indexOf(Math.max(...first));
    expect(Math.abs(top - prof.peak)).toBeLessThanOrEqual(1);
    expect(first[0]).toBeLessThan(first[top] / 10);
    expect(first[first.length - 1]).toBeLessThan(first[top] / 10);
    // Then it charges: nothing until the next pulse
    expect(per.slice(start + prof.ticks, start + w.interval - 1).every((d) => d === 0)).toBe(true);
    expect(per.slice(start + w.interval).some((d) => d > 0)).toBe(true);
    void Input; void server;
  });

  /** Hold the trigger for `ticks` with the ship pinned facing up, the cursor `dist` ahead */
  const hold = (s: ReturnType<typeof setup>, ticks: number, dist: number, each?: () => void) => {
    for (let i = 0; i < ticks; i++) {
      Position.x[s.pid] = 0; Position.y[s.pid] = 0; Velocity.x[s.pid] = 0; Velocity.y[s.pid] = 0; Rotation.angle[s.pid] = -Math.PI / 2;
      each?.();
      s.t.send({ type: 'input', seq: i + 1, tick: 0, forward: false, backward: false, left: false, right: false, boost: false, fireLeft: true, fireRight: false, targetAngle: -Math.PI / 2, helm: true, cursorDist: dist } as any);
      s.step();
    }
  };

  it('a laser pulse reaches a ship 3000 away (beams once stopped at 950), and its peak burns one just off its line', () => {
    const s = setup();
    s.bridge.respawnInPlace(s.pid, armed('laser'));
    const far = s.bridge.spawnDummy(sparrow, 0, -3000, 0, InSystem.systemId[s.pid]);
    hold(s, 60, 3000, () => { Position.x[far] = 0; Position.y[far] = -3000; });
    expect(s.damaged(far)).toBeGreaterThan(0);
    // A target just beside the beam's line: missed by the line itself, but inside the beam's width
    const ship = s.bridge.get(s.pid)!;
    Position.x[s.pid] = 0; Position.y[s.pid] = 0; Rotation.angle[s.pid] = -Math.PI / 2;
    const w = ship.derived.weapons.reduce((a, b) => (a.muzzle[0] < b.muzzle[0] ? a : b)); // the leftmost gun
    ship.aim[w.part] = 0;
    const [lx] = shipPointToWorld(ship, { x: 0, y: 0, angle: -Math.PI / 2 }, w.muzzle, s.bridge.tuning.cellSize);
    const side = s.bridge.spawnDummy(sparrow, 0, -600, 0, InSystem.systemId[s.pid]);
    const target = s.bridge.get(side)!;
    // Slide it left until the beam's centre line just misses it
    let d = 0;
    for (; d < 200; d += 1) {
      Position.x[side] = lx - d;
      if (!s.bridge.segmentHit(side, target, lx, -100, lx, -1100)) break;
    }
    const def = partWeaponDef(s.bridge.tuning, w.kind, ship.blueprint.parts[w.part], w);
    expect(def.width!).toBeGreaterThan(6);
    // A pulse's peak tick: its full width
    const burn = (x: number) => { Position.x[side] = x; Position.y[side] = -600; const before = s.damaged(side); (s.bridge as any).fireBeam(s.pid, ship, w, def, { damage: 10, width: def.width! }); return s.damaged(side) - before; };
    expect(burn(lx - d - def.width! / 2 + 2)).toBeGreaterThan(0);
    expect(burn(lx - d - def.width! - 10)).toBe(0);
  });

  it('a laser burns full strength to its effective range, weaker past it, and not at all past its full range', () => {
    const s = setup();
    s.bridge.respawnInPlace(s.pid, armed('laser'));
    const ship = s.bridge.get(s.pid)!;
    Position.x[s.pid] = 0; Position.y[s.pid] = 0; Rotation.angle[s.pid] = -Math.PI / 2;
    const w = ship.derived.weapons[0];
    ship.aim[w.part] = 0;
    const def = partWeaponDef(s.bridge.tuning, w.kind, ship.blueprint.parts[w.part], w);
    const [lx, ly] = shipPointToWorld(ship, { x: 0, y: 0, angle: -Math.PI / 2 }, w.muzzle, s.bridge.tuning.cellSize);
    const target = s.bridge.spawnDummy(sparrow, lx, -1000, 0, InSystem.systemId[s.pid]);
    const tgt = s.bridge.get(target)!;
    // Its hull's near edge `d` along the beam (the hits are kept from breaking parts)
    const burn = (d: number) => {
      tgt.hp = tgt.maxHp.slice();
      Position.x[target] = lx; Position.y[target] = ly - d - tgt.derived.radius * 0.5;
      const before = s.damaged(target);
      (s.bridge as any).fireBeam(s.pid, ship, w, def, { damage: 5, width: def.width! });
      return s.damaged(target) - before;
    };
    const eff = effectiveRange(def), max = def.range!;
    const near = burn(1500), edge = burn(eff - 150), past = burn(eff + (max - eff) * 0.5), beyond = burn(max + 300);
    expect(near).toBeGreaterThan(0);
    expect(edge).toBeCloseTo(near, 5);
    expect(past).toBeGreaterThan(0);
    expect(past).toBeLessThan(near * 0.5);
    expect(beyond).toBe(0);
  });

  it("a bigger flak gun's bursts are wider and hit harder than a panel's (the same shells, fired from a 2×2)", () => {
    const bulwark = parseBlueprint(readFileSync(join(dataDir, 'ships/blueprints/bulwark.json'), 'utf-8'));
    const burst = (piece: string) => {
      const s = setup();
      const bp = JSON.parse(JSON.stringify(sparrow));
      // One flak turret where the nose cap was
      bp.parts = bp.parts.filter((q: any) => q.fn !== 'cannon_pip' && q.piece !== 'cap');
      bp.parts.push({ uid: 30, piece, fn: 'flak', material: 'alloy', x: 0, y: piece === 'block2' ? -2 : -1, rot: 0, flip: false, facing: 'N', mount: 'turret' });
      s.bridge.respawnInPlace(s.pid, bp);
      expect(s.bridge.get(s.pid)!.derived.weapons.length).toBe(1);
      (s.server as any).ammo.spend = () => ({ scale: 1, dry: false });
      const target = s.bridge.spawnDummy(bulwark, 0, -700, 0, InSystem.systemId[s.pid]);
      hold(s, 60 * 4, 700, () => { Position.x[target] = 0; Position.y[target] = -700; Velocity.x[target] = 0; Velocity.y[target] = 0; });
      const radii = s.got.filter((m: any) => m.type === 'detonation' && m.kind === 'flak').map((m: any) => m.radius);
      return { damage: s.damaged(target), radius: Math.max(0, ...radii), bursts: radii.length };
    };
    const panel = burst('rect2'), big = burst('block2');
    expect(panel.bursts).toBeGreaterThan(0);
    expect(big.bursts).toBeGreaterThan(0);
    expect(big.radius).toBeGreaterThan(panel.radius * 1.15);
    expect(big.damage).toBeGreaterThan(panel.damage * 1.5);
  });
});
