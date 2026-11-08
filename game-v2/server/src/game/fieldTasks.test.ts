import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { Position, Velocity, ServerMessage, countOf, canCraft } from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../proto/createProtoServer.js';
import { MemoryProfileStore } from '../profile/ProfileStore.js';

const dataDir = join(__dirname, '../../../data');
const files = readGameDataFiles(dataDir);

function world() {
  (bitecs as unknown as { resetGlobals: () => void }).resetGlobals();
  const server = new GameServer({
    profileStore: new MemoryProfileStore(), gameData: new GameData(files), userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as any,
    scene: 'sectors', autoStart: false, ships: createShipBridge(loadShipConfigCached(dataDir)),
  });
  const t = new LocalTransport(server);
  const got: ServerMessage[] = [];
  t.onMessage = (m) => got.push(m);
  t.connect();
  t.send({ type: 'join', username: 'cadet' } as any);
  const conn = server.pilots.connOf(t.getPlayerId())!;
  const p = () => server.pilots.get(conn)!;
  const pid = () => t.getPlayerId();
  const at = (x: number, y: number, ticks = 15) => { for (let i = 0; i < ticks; i++) { Position.x[pid()] = x; Position.y[pid()] = y; Velocity.x[pid()] = Velocity.y[pid()] = 0; server.step(); } };
  const quests = server.quests as any;
  const start = (id: string) => quests.start(conn, p(), quests.def(id));
  const stage = (id: string) => p().quests.active[id]?.stage ?? (p().quests.done.includes(id) ? 99 : -1);
  return { server, conn, p, pid, at, start, stage, got, ops: (server as any).ops };
}

describe('field tasks: course, hold, recover', () => {
  it("Cleared for Departure: the buoy parts' patterns come with it, and each buoy goes up piece by piece from parts in the hold", () => {
    const w = world();
    w.start('clearance');
    // The buoy kit's recipes, on taking it (the Constructor opens at the job's own level: nothing to teach)
    for (const r of ['buoy_frame', 'buoy_mast', 'buoy_cell', 'buoy_dish']) expect(w.p().recipes).toContain(r);
    const job = (files.quests as any).quests.find((q: any) => q.id === 'clearance');
    expect(w.server.getShips().catalog.functions.get('utility_constructor')!.unlock!.level).toBeLessThanOrEqual(job.level);
    const steps = (files.quests as any).quests.find((q: any) => q.id === 'clearance').steps;
    expect(steps.map((s: any) => s.type).slice(0, 4)).toEqual(['refit', 'construct', 'construct', 'construct']);
    // (fitting the Constructor is the refit step; here it's fitted)
    w.p().quests.active.clearance.stage = 1;
    let fitted = false;
    w.ops.host.fitted = () => fitted;
    const alpha = steps[1];
    // At the site with two parts but no Constructor: nothing goes up
    w.p().cargo.push({ id: 'buoy_frame', n: 1 }, { id: 'buoy_mast', n: 1 });
    w.at(alpha.x, alpha.y, 60 * 6);
    expect(w.ops.views(w.conn)[0].text).toMatch(/Constructor/);
    expect(countOf(w.p().cargo, 'buoy_frame')).toBe(1);
    // Fitted: the frame, then the mast, five seconds each, the parts used up
    fitted = true;
    w.at(alpha.x, alpha.y, 60 * 11);
    expect(countOf(w.p().cargo, 'buoy_frame') + countOf(w.p().cargo, 'buoy_mast')).toBe(0);
    expect(w.stage('clearance')).toBe(1);
    expect(w.ops.views(w.conn)[0].text).toMatch(/Still to build: power cells, transponder dish/);
    // It's kept: only you see it, half built
    const build = (w.server.quests as any).builds(w.p()).find((b: any) => b.id === 'clearance:1');
    expect(build.pieces.filter((pc: any) => pc.built).map((pc: any) => pc.id)).toEqual(['frame', 'mast']);
    // Away and back with the rest
    w.at(alpha.x + 20000, alpha.y, 60);
    w.p().cargo.push({ id: 'buoy_cell', n: 1 }, { id: 'buoy_dish', n: 1 });
    w.at(alpha.x, alpha.y, 60 * 11);
    expect(w.stage('clearance')).toBe(2);
    // (its revision stays with it from step to step, so a relog doesn't restart it)
    expect(w.p().quests.active.clearance.data?.rev).toBe(3);
    // Alpha now stands whole for this pilot; Beta isn't there yet
    const builds = (w.server.quests as any).builds(w.p());
    expect(builds.find((b: any) => b.id === 'clearance:1').pieces.every((pc: any) => pc.built)).toBe(true);
    expect(builds.find((b: any) => b.id === 'clearance:2').pieces.some((pc: any) => pc.built)).toBe(false);
    expect(builds.some((b: any) => b.id === 'clearance:3')).toBe(false);
  });

  it("a Constructor is a real part: fabricated at its level (the clearance job's), fitted, and seen by the build site", () => {
    const w = world();
    const bridge = w.server.getShips();
    const bp = JSON.parse(JSON.stringify(bridge.playerBlueprint));
    const slot = bp.parts.find((p: any) => p.piece === 'sq' && (p.fn === 'hull' || p.fn === 'armor' || p.fn === 'cargo'));
    expect(slot).toBeTruthy();
    // (The Constructor model, in its own material)
    const model = bridge.catalog.functions.get('utility_constructor')!;
    Object.assign(slot, { fn: model.id, material: model.material });
    expect(bridge.validate(bp).ok).toBe(true);
    const econ = (w.server as any).econ;
    const r = econ.recipes.recipeFor(`part:${model.material}:utility_constructor:sq`);
    expect(r).toBeTruthy();
    // Its level, which is the job's (a licence teaches nothing early)
    const lv = model.unlock!.level;
    expect(canCraft(r, ['fn:constructor'], lv - 1)).toBe(false);
    expect(canCraft(r, [], lv)).toBe(true);
    w.start('clearance');
    expect(w.ops.host.fitted(w.conn, 'constructor')).toBe(false);
    bridge.respawnInPlace(w.pid(), bp);
    expect(w.ops.host.fitted(w.conn, 'constructor')).toBe(true);
  });

  it('a course: start at its spot, every ring in order against the clock', () => {
    const w = world();
    w.start('patrol_01');
    const course = (files.quests as any).quests.find((q: any) => q.id === 'patrol_01').steps[0];
    w.at(course.x, course.y);
    expect(w.ops.views(w.conn)[0].timer).toBeGreaterThan(80);
    const rings = w.ops.ringsOf('patrol_01', course);
    expect(rings.length).toBe(6);
    // (out of order does nothing)
    w.at(rings[2].x, rings[2].y);
    expect(w.stage('patrol_01')).toBe(0);
    for (const r of rings) w.at(r.x, r.y);
    expect(w.stage('patrol_01')).toBe(1);
  });

  it('a hold: in the ring and still until the bar fills (moving out drains it); a recover: the container is there, and you pull it aboard', () => {
    const w = world();
    w.start('drift_02');
    w.p().quests.active.drift_02.stage = 1;
    const hold = (files.quests as any).quests.find((q: any) => q.id === 'drift_02').steps[1];
    w.at(hold.x, hold.y, 60 * 8);
    w.at(hold.x + 3000, hold.y, 60 * 3);
    expect(w.stage('drift_02')).toBe(1);
    w.at(hold.x, hold.y, 60 * 15);
    expect(w.stage('drift_02')).toBe(99);
    w.start('drift_01');
    w.p().quests.active.drift_01.stage = 1;
    const rec = (files.quests as any).quests.find((q: any) => q.id === 'drift_01').steps[1];
    w.at(rec.x + 5000, rec.y, 30);
    w.at(rec.x, rec.y, 120);
    expect(countOf(w.p().cargo, 'drone_core')).toBe(1);
    expect(w.stage('drift_01')).toBe(2);
  });

  it('a job rewritten since you took it (its rev moved on) starts again from its first step', () => {
    const w = world();
    w.p().quests.active.clearance = { stage: 2, progress: 0, data: { since: 1 } };
    (w.server.quests as any).onLogin(w.conn);
    expect(w.p().quests.active.clearance).toMatchObject({ stage: 0, data: { rev: 3 } });
    (w.server.quests as any).onLogin(w.conn);
    w.p().quests.active.clearance.stage = 1;
    (w.server.quests as any).onLogin(w.conn);
    expect(w.p().quests.active.clearance.stage).toBe(1);
  });

  it('a course run out of time goes back to its start', () => {
    const w = world();
    w.start('patrol_01');
    const course = (files.quests as any).quests.find((q: any) => q.id === 'patrol_01').steps[0];
    w.at(course.x, course.y);
    const rings = w.ops.ringsOf('patrol_01', course);
    w.at(rings[0].x, rings[0].y);
    w.at(rings[0].x + 20000, rings[0].y, 60 * 92);
    expect(w.stage('patrol_01')).toBe(0);
    expect(w.got.some((m) => m.type === 'toast' && /Out of time/.test((m as any).text))).toBe(true);
    expect(w.ops.views(w.conn)[0].timer).toBeUndefined();
  });

  it('Storm Season sends you down to Terra Nova to hold by its weather masts', () => {
    const w = world();
    w.p().quests.done.push('osei_01');
    w.start('tn_storms');
    const steps = (files.quests as any).quests.find((q: any) => q.id === 'tn_storms').steps;
    (w.server as any).travelTo((w.server as any).clients.values().next().value, w.server.gameData.getSystemNum('terra_nova_surface'), steps[0].x, steps[0].y, false);
    for (let i = 0; i < 3; i++) w.at(steps[i].x, steps[i].y, 60 * 11);
    expect(w.stage('tn_storms')).toBe(3);
  });
});
