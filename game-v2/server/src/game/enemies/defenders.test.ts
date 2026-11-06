/**
 * Freighters that keep their course but shoot back (game/enemies/defenders.ts): a Ceres Hauler on its route, hurt by a
 * pilot, turns its guns on that pilot (and only on it), keeps flying its leg as if nothing happened, and goes quiet 30 s
 * after the last hit; a new attacker takes the lock over. An escorted freighter (a ward) can't be hurt by the pilots
 * escorting it, so it never shoots at them; a hostile that hurts it gets shot back at.
 *
 * A real GameServer, pilots joined over LocalTransport; the hits are made with damagePartBy (the damage ledger is what
 * the freighter reads), the freighter's shells counted off the bridge's fire records.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { Position, Velocity, Rotation, InSystem, sidesHurt, SIDE } from '@space-game/common';
import { GameServer } from '../../GameServer.js';
import { GameData } from '../../data/GameData.js';
import { LocalTransport } from '../../net/LocalTransport.js';
import { readGameDataFiles } from '../../data/loadGameDataFromDisk.js';
import { loadShipConfigFromDisk } from '../../ships/loadShipConfig.js';
import { createShipBridge } from '../../proto/createProtoServer.js';
import { DEFEND_QUIET_TICKS } from './defenders.js';

const dataDir = join(__dirname, '../../../../data');
const files = readGameDataFiles(dataDir);
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;

function live() {
  resetGlobals();
  const server = new GameServer({
    gameData: new GameData(files), userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as never,
    scene: 'sectors', autoStart: false, ships: createShipBridge(loadShipConfigFromDisk(dataDir)),
  });
  const join = (name: string) => {
    const t = new LocalTransport(server);
    t.onMessage = () => {};
    t.connect();
    t.send({ type: 'join', username: name } as never);
    const pid = t.getPlayerId();
    const cc = server.pilots.connOf(pid)! as unknown as { isAdmin: boolean };
    cc.isAdmin = true; server.admin.run(cc as never, 'god', { on: 'on' }); cc.isAdmin = false;
    return pid;
  };
  const A = join('attacker'), B = join('bystander');
  const ships = server.getShips();
  // (each shell fired: how far off its line of flight (relative to its ship) each pilot is)
  const shots: { owner: number; tick: number; offA: number; offB: number }[] = [];
  const push = ships.fired.push.bind(ships.fired);
  const off = (id: number, o: number, p: number) => angleOff(Math.atan2(Velocity.y[id] - Velocity.y[o], Velocity.x[id] - Velocity.x[o]), Math.atan2(Position.y[p] - Position.y[o], Position.x[p] - Position.x[o]));
  ships.fired.push = (...fs) => {
    for (const f of fs) for (const id of f.ids) shots.push({ owner: f.owner, tick: f.tick, offA: off(id, f.owner, A), offB: off(id, f.owner, B) });
    return push(...fs);
  };
  return { server, ships, A, B, shots };
}

const angleOff = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

/** Keep a pilot `side` (+1 starboard, -1 port) of the freighter, `d` off (riding along with it: abeam, within its broadside turrets' windows and reach) */
function ride(pid: number, f: number, side: number, d = 650) {
  const a = Rotation.angle[f] + side * Math.PI / 2;
  InSystem.systemId[pid] = InSystem.systemId[f];
  Position.x[pid] = Position.x[f] + Math.cos(a) * d; Position.y[pid] = Position.y[f] + Math.sin(a) * d;
  Velocity.x[pid] = Velocity.x[f]; Velocity.y[pid] = Velocity.y[f];
}

/** A Sol freighter on its route with the attacker riding off one side and the bystander off the other; `hits`: ticks to hit it on, and by whom */
function haul(ticks: number, hits: (t: number, A: number, B: number) => number) {
  const r = live();
  const { server, ships, A, B } = r;
  server.step();
  const f = server.getTrafficShips()[0].eid;
  const trail: { tick: number; x: number; y: number; leg: number; attacker: number; ap: { x: number; y: number } | null }[] = [];
  for (let t = 0; t < ticks; t++) {
    ride(A, f, 1);
    ride(B, f, -1);
    const by = hits(t, A, B);
    if (by >= 0) ships.damagePartBy(f, ships.get(f)!.derived.weapons.length ? 1 : 0, 4, by);
    server.step();
    const slot = server.getTrafficShips().find((s) => s.eid === f)!;
    trail.push({ tick: server.getTick(), x: Position.x[f], y: Position.y[f], leg: slot.leg, attacker: server.enemies.defenders.attackerOf(f), ap: ships.autopilotOf(f) });
  }
  return { ...r, f, trail };
}

describe('freighters shoot back (defenders)', () => {
  it("a hauler hurt by a pilot shoots back at it, keeps its leg, and goes quiet 30 s after the last hit; the bystander's never shot at", () => {
    const HIT = 60, END = HIT + DEFEND_QUIET_TICKS + 240;
    const r = haul(END, (t, A) => (t === HIT || t === HIT + 120 ? A : -1));
    const calm = haul(END, () => -1);
    const { f, A, trail, shots } = r;
    const mine = shots.filter((s) => s.owner === f);
    // (Shooting back, at the attacker)
    expect(trail[HIT + 10].attacker).toBe(A);
    expect(mine.length).toBeGreaterThan(10);
    expect(calm.shots.filter((s) => s.owner === calm.f).length).toBe(0);
    // ...every shell towards it (abeam one side), none at the bystander (abeam the other)
    for (const s of mine) { expect(s.offA).toBeLessThan(0.8); expect(s.offB).toBeGreaterThan(1.5); }
    // (Never turning to fight: its route and course as if it had never been hit. Its body flies the autopilot's course as
    // the autopilot does (bodies/aiPilot.ts HAUL), so while it shoots back it is where it would have been to within a
    // few units (the autopilot steers by its course unrounded, the body by it on the aim grid); once quiet, the autopilot
    // takes over with its own held heading and corrects its course a few ticks sooner than it would have)
    const quiet = HIT + 120 + DEFEND_QUIET_TICKS;
    let apart = 0, after = 0;
    for (let t = 0; t < END; t++) {
      expect(trail[t].leg).toBe(calm.trail[t].leg);
      expect(trail[t].ap).toEqual(calm.trail[t].ap);
      const d = Math.hypot(trail[t].x - calm.trail[t].x, trail[t].y - calm.trail[t].y);
      if (t <= quiet) apart = Math.max(apart, d); else after = Math.max(after, d);
    }
    expect(apart).toBeLessThan(60);
    expect(after).toBeLessThan(600);
    // (Quiet 30 s after the last hit: no lock, no shells)
    const last = HIT + 120;
    expect(quiet).toBe(last + DEFEND_QUIET_TICKS);
    expect(trail[last + DEFEND_QUIET_TICKS - 5].attacker).toBe(A);
    expect(trail[last + DEFEND_QUIET_TICKS + 5].attacker).toBe(-1);
    expect(mine.filter((s) => s.tick > trail[last + DEFEND_QUIET_TICKS + 5].tick).length).toBe(0);
    // (and it was still shooting late in the window: the lock held the whole 30 s while the attacker stayed in reach)
    expect(mine.some((s) => s.tick > trail[last + DEFEND_QUIET_TICKS - 300].tick)).toBe(true);
  }, 240_000);

  it('a new attacker takes the lock over: it shoots at the bystander once the bystander hits it, not at the first attacker', () => {
    const r = haul(600, (t, A, B) => (t === 30 ? A : t === 300 ? B : -1));
    const { f, A, B, trail, shots } = r;
    expect(trail[200].attacker).toBe(A);
    expect(trail[320].attacker).toBe(B);
    const after = shots.filter((s) => s.owner === f && s.tick > trail[330].tick);
    expect(after.length).toBeGreaterThan(5);
    for (const s of after) { expect(s.offB).toBeLessThan(0.8); expect(s.offA).toBeGreaterThan(1.5); }
  }, 240_000);

  it("damage with no source (a hazard's) doesn't refresh the lock: its quiet runs from the attacker's own last hit", () => {
    const HIT = 30;
    const r = haul(300, (t, A) => (t === HIT ? A : -1));
    const d = (r.server.enemies.defenders as unknown as { list: Map<number, { attacker: number; lastHit: number }> }).list.get(r.f)!;
    expect(d.attacker).toBe(r.A);
    const hitAt = d.lastHit;
    expect(hitAt).toBeGreaterThan(0);
    // (hurt with no source: the bridge's last hitter is still A, but this wasn't A)
    const tick = r.server.getTick();
    expect(r.ships.damagePartBy(r.f, r.ships.get(r.f)!.derived.weapons.length ? 1 : 0, 4, -1)).toBeGreaterThan(0);
    expect(r.ships.lastHitter(r.f)).toBe(r.A);
    expect(r.ships.lastDamagedTick(r.f)).toBe(tick);
    for (let t = 0; t < 5; t++) r.server.step();
    expect(d.attacker).toBe(r.A);
    expect(d.lastHit).toBe(hitAt);
    // (A hitting it again does refresh it)
    r.ships.damagePartBy(r.f, r.ships.get(r.f)!.derived.weapons.length ? 1 : 0, 4, r.A);
    const again = r.server.getTick();
    r.server.step();
    expect(d.lastHit).toBe(again);
  }, 240_000);

  it('an attacker gone (another system) ends it at once', () => {
    const r = haul(300, (t, A) => (t === 30 ? A : -1));
    expect(r.trail[100].attacker).toBe(r.A);
    // (the attacker jumps out: the lock drops on the next tick)
    InSystem.systemId[r.A] = r.server.gameData.getSystemNum('borealis');
    r.server.step();
    expect(r.server.enemies.defenders.attackerOf(r.f)).toBe(-1);
  }, 240_000);

  it('an escorted freighter (a ward): its pilots can\'t hurt it, so never draw its fire; a hostile that hurts it is shot back at', () => {
    // (pilots and their wards are on one side: common hitRules.ts)
    expect(sidesHurt(SIDE.PILOT, SIDE.WARD)).toBe(0);
    expect(sidesHurt(SIDE.WARD, SIDE.PILOT)).toBe(0);
    const { server, ships, A, shots } = live();
    server.step();
    const host = (server as unknown as { ops: { host: { spawnWard(k: 'freighter', s: string, x: number, y: number, a: number, n: string): number } } }).ops.host;
    const x = Position.x[A] + 3000, y = Position.y[A];
    const w = host.spawnWard('freighter', 'sol', x, y, 0, 'Test Convoy');
    expect(server.enemies.defenders.has(w)).toBe(true);
    expect(server.canDamage(A, w)).toBe(false);
    const [pirate] = server.enemies.spawnPack(InSystem.systemId[A], { faction: 'pirates', ships: ['pirate_skiff'] }, x + 700, y);
    for (let t = 0; t < 240; t++) {
      // (the pirate held off its side, the escort riding off the other)
      ride(pirate, w, 1, 700);
      ride(A, w, -1, 700);
      if (t === 20) ships.damagePartBy(w, 1, 4, pirate);
      server.step();
    }
    expect(server.enemies.defenders.attackerOf(w)).toBe(pirate);
    const mine = shots.filter((s) => s.owner === w);
    expect(mine.length).toBeGreaterThan(5);
    for (const s of mine) expect(s.offA).toBeGreaterThan(1.5);
    // (at a hostile its body stays off: its rows fly it and its shots go as fire records, as a pack's at a ward do)
    expect(server.enemies.aiBodyOn(w)).toBe(false);
  }, 240_000);
});
