import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { Position, Velocity, InSystem, ServerMessage, THAW, CTL, PILOT_ROW } from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../proto/createProtoServer.js';
import { MemoryProfileStore } from '../profile/ProfileStore.js';
import { makeServer } from '../testkits/world.testkit.js';

const dataDir = join(__dirname, '../../../data');
const base = readGameDataFiles(dataDir);

/** A pilot in a world where cold and heat work `faster` times as fast as the game's (so a test needn't wait minutes) */
function world(faster = 20) {
  (bitecs as unknown as { resetGlobals: () => void }).resetGlobals();
  const files = structuredClone(base);
  const w = (files.hazards as any).warmth;
  w.coldPerPoint *= faster;
  w.ambient *= faster;
  for (const src of Object.values(w.sources) as any[]) { src.rate *= faster; if (src.docked) src.docked *= faster; }
  const server = makeServer({ profileStore: new MemoryProfileStore(), gameData: new GameData(files) });
  const t = new LocalTransport(server);
  const got: ServerMessage[] = [];
  t.onMessage = (m) => got.push(m);
  t.connect();
  t.send({ type: 'join', username: 'shiver' } as any);
  const pid = t.getPlayerId();
  const ships = server.getShips();
  const gd = server.gameData;
  const rules = gd.hazardRules.warmth!;
  /** Sit still at a point in a system for a while */
  const hover = (system: string, x: number, y: number, ticks: number) => {
    InSystem.systemId[pid] = gd.getSystemNum(system);
    for (let i = 0; i < ticks; i++) { Position.x[pid] = x; Position.y[pid] = y; Velocity.x[pid] = Velocity.y[pid] = 0; server.step(); }
  };
  const warmth = () => ships.warmthOf(pid);
  return { server, got, pid, ships, gd, rules, hover, warmth };
}

// Somewhere that isn't cold (and quiet)
const WARM = ['terra_nova_surface', 0, 0] as const;
// Deep in Borealis (cryo 3): far from its star, its stations and its planets' paths
const DEEP = [64000, -24000] as const;

describe('warmth', () => {
  it('cold builds up away from heat in a cold system', () => {
    const { hover, warmth, rules } = world(60);
    hover('borealis', ...DEEP, 120);
    // About 2 s of rating-3 cold (at the test's pace), give or take a step
    const step = 3 * rules.coldPerPoint * 0.25;
    expect(warmth()).toBeLessThan(1 - 3 * rules.coldPerPoint * 2 + step + 1e-9);
    expect(warmth()).toBeGreaterThan(1 - 3 * rules.coldPerPoint * 2 - step - 1e-9);
  });

  it('not in a warm one, where it comes back by itself', () => {
    const { hover, warmth, ships, pid } = world(60);
    hover(...WARM, 60);
    expect(warmth()).toBe(1);
    ships.frostHit(pid, 0.5, 60);
    hover(...WARM, 30);
    expect(warmth()).toBeGreaterThan(0.5);
  });

  /** Chilled in the deep, then held at a spot: how much warmer it ends up */
  const warmsAt = (x: number, y: number, setup?: (w: ReturnType<typeof world>) => void) => {
    const w = world(60);
    w.hover('borealis', ...DEEP, 150);
    const cold = w.warmth();
    expect(cold).toBeLessThan(0.6);
    setup?.(w);
    w.hover('borealis', x, y, 120);
    return w.warmth() - cold;
  };

  it('heat brings it back: beside a station', () => {
    expect(warmsAt(-52000 + 400, -55400)).toBeGreaterThan(0.2);
  });

  it('heat brings it back: close by the star (its surface 14000 out), and not out past its reach', () => {
    expect(warmsAt(16000, 0)).toBeGreaterThan(0.2);
    expect(warmsAt(14000 + 9500, 0)).toBeLessThan(0);
  });

  it('heat brings it back: a ship on fire (its own: just the flames, no damage)', () => {
    expect(warmsAt(...DEEP, (w) => (w.ships as any).burns.push({ eid: w.pid, part: 0, until: w.server.getTick() + 100000, dps: 0, radius: 0, source: -1 }))).toBeGreaterThan(0.1);
  });

  it('an insulated hull builds up cold slower, but it still builds up', () => {
    const a = world(60);
    a.hover('borealis', ...DEEP, 120);
    const plain = 1 - a.warmth();
    const b = world(60);
    b.ships.get(b.pid)!.derived.makeup.insulation = 0.3;
    b.hover('borealis', ...DEEP, 120);
    const insulated = 1 - b.warmth();
    expect(insulated).toBeGreaterThan(0);
    expect(insulated).toBeLessThan(plain * 0.8);
    expect(insulated).toBeGreaterThan(plain * 0.6);
  });

  it('frozen through, the ship seizes up and comes out with a little warmth; numb, it flies slower', () => {
    const { hover, warmth, ships, pid, rules } = world();
    hover('borealis', ...DEEP, 1);
    ships.warm(pid, -0.9, rules.seizeTicks);
    expect(ships.empTicksLeft(pid)).toBe(0);
    // Numb (under a quarter): flagged for replicas (read straight after the step: a snapshot takes them)
    ships.stepMovement(pid);
    expect(ships.replicaCtl.get(pid)!.bits & CTL.numb).toBeTruthy();
    // Frozen through
    let seized = false;
    for (let i = 0; i < 300 && !seized; i++) { hover('borealis', ...DEEP, 1); seized = ships.empTicksLeft(pid) > 0; }
    expect(seized).toBe(true);
    expect(warmth()).toBeGreaterThan(0);
    expect(warmth()).toBeLessThanOrEqual(THAW);
  });

  it('frost hits (the Brood Mother\'s chill, a gemmed gun) feed the same meter, and the pilot is told it', () => {
    const { hover, warmth, ships, pid, got, rules } = world(1);
    hover('borealis', -18200, 900, 30);
    // A larva's burst (brood-mother.md: chill 0.35)
    ships.frostHit(pid, 0.35, 75);
    expect(warmth()).toBeCloseTo(0.65, 2);
    got.length = 0;
    hover('borealis', -18200, 900, 10);
    const rows = got.filter((m) => m.type === 'snapshot').flatMap((m: any) => m.entities.filter((e: any) => e.id === pid && e.data?.length > 13));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.at(-1).data[PILOT_ROW.warmth]).toBe(65);
    // Insulation keeps out some of a hit too
    ships.get(pid)!.derived.makeup.insulation = 0.2;
    ships.frostHit(pid, 0.25, 75);
    expect(warmth()).toBeCloseTo(0.65 - 0.2, 2);
    // Chilled through by hits, it seizes up as the cold would
    ships.frostHit(pid, 1, 75);
    expect(ships.empTicksLeft(pid)).toBe(75);
    expect(warmth()).toBeCloseTo(THAW, 6);
    // ...and not again straight after (it stays frozen till the window's past)
    ships.frostHit(pid, 1, 75);
    expect(warmth()).toBe(0);
    expect(ships.empTicksLeft(pid)).toBeLessThanOrEqual(75);
    // Near the outpost (inside the star's warmth too) it warms back up
    hover('borealis', -18200, 900, 600);
    expect(warmth()).toBeGreaterThan(0.1);
    expect(rules.seizeTicks).toBeGreaterThan(0);
  });

  it("a trickle of frost hits takes a ship's warmth tick by tick", () => {
    const { ships, pid, hover } = world(1);
    hover(...WARM, 2);
    // (The Frostbite beam no longer chills (it slows: features/weaponry); a beam-like trickle of frost hits still freezes through)
    const hold = 45;
    for (let i = 0; i < 10; i++) ships.frostHit(pid, 1 / hold, 40);
    expect(ships.warmthOf(pid)).toBeCloseTo(1 - 10 / hold, 6);
  });
});
