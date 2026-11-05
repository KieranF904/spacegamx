import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import {
  Position, Velocity, InSystem, Rotation, ServerMessage, insideTerrain, rayTerrain, isRuined, currentStage, deciding, stageOf, partArmour,
  hitMultiplier, WINDOW,
} from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigFromDisk } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../proto/createProtoServer.js';
import type { BossesFile } from './Bosses.js';
import { PYRECLAST_EXPOSURE, PYRECLAST_LOOP, type PyreclastBrain } from './brains/pyreclast.js';

const dataDir = join(__dirname, '../../../data');
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const files = readGameDataFiles(dataDir);
const def = (files.bosses as BossesFile).bosses.boss_pyreclast;

function world() {
  resetGlobals();
  const server = new GameServer({
    gameData: new GameData(files),
    userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as any,
    scene: 'sectors',
    autoStart: false,
    ships: createShipBridge(loadShipConfigFromDisk(dataDir)),
  });
  const pilots: { pid: number; got: ServerMessage[] }[] = [];
  // (A move's looks (its tells, beams, strikes' looks) are worked out by every client running the boss's body (CAPS.MOVES,
  // every client), so none go on the wire: the server's own word for them, GameServer.moveFx, is what's watched here,
  // as every pilot in the system would have been sent it)
  (server as any).moveFx = (sys: number, _eid: number, _origin: unknown, msg: ServerMessage) => { for (const p of pilots) if (InSystem.systemId[p.pid] === sys) p.got.push(msg); };
  const join_ = (name: string) => {
    const t = new LocalTransport(server);
    const got: ServerMessage[] = [];
    t.onMessage = (m) => got.push(m);
    t.connect();
    t.send({ type: 'join', username: name } as any);
    const p = { pid: t.getPlayerId(), got };
    pilots.push(p);
    return p;
  };
  const { pid, got } = join_('slayer');
  const step = (n = 1) => { for (let i = 0; i < n; i++) server.step(); };
  const num = server['gameData'].getSystemNum(def.system);
  // (God mode: it's the boss's moves under test, not how long a pilot lasts)
  const god = () => server['admin'].god.add(server.pilots.connOf(pid) as any);
  return { server, got, pid, step, num, bridge: server.getShips(), god, join: join_ };
}

const place = (pid: number, num: number, x: number, y: number, vx = 0, vy = 0) => {
  InSystem.systemId[pid] = num; Position.x[pid] = x; Position.y[pid] = y; Velocity.x[pid] = vx; Velocity.y[pid] = vy;
};
/** Keep the pilot whole (it's the boss's moves under test, not how long a pilot lasts) */
const mend = (server: GameServer, pid: number) => server.getShips().scaleHp(pid, 1);
const brainOf = (server: GameServer, eid: number) => server.bosses.brainOf(eid) as unknown as PyreclastBrain;
/** (dev) Its fight moved on to the start of a stage: what's before it beaten, blown away, and done blowing */
const advance = (server: GameServer, eid: number, stage: number, step: (n?: number) => void) => {
  const brain = server.bosses.brainOf(eid)!, bridge = server.getShips();
  for (let n = 1; n < 400; n++) {
    const s = bridge.get(eid);
    if (!s || currentStage(bridge.catalog, s) >= stage) break;
    brain.forceShed!(n);
  }
  step(2);
  for (let i = 0; i < 60 * 15 && brain.invulnerable!(); i++) step();
};
/** Its personal attacks off (a signature move under test alone) */
const noPersonal = (server: GameServer, eid: number) => { (brainOf(server, eid).fight.tables as { personal?: unknown }).personal = undefined; };

/**
 * Run its loop with the pilot held at `dist` from it: the moves in the order they started, each window's opening (its
 * time and cap) and whether a move ever started inside a window
 */
function loop(w: ReturnType<typeof world>, eid: number, seconds: number, dist: number, onTick?: (i: number) => void) {
  const { server, got, pid, step, num } = w;
  const brain = brainOf(server, eid);
  const moves: string[] = [], windows: { after: string; ticks: number; cap: number }[] = [];
  let startedInWindow = 0, last = '';
  for (let i = 0; i < 60 * seconds; i++) {
    got.length = 0;
    const holding = brain.fight.holding(server.getTick() + 1);
    step();
    if (i % 30 === 0) { mend(server, pid); place(pid, num, Position.x[eid] + dist, Position.y[eid]); }
    const m = brain.moveName;
    if (m && m !== last) { moves.push(m); if (holding) startedInWindow++; }
    for (const g of got) if (g.type === 'bossWindow' && g.bodyId === eid && g.ticks > 0 && g.fill === 0 && !g.crack) windows.push({ after: last || m, ticks: g.ticks, cap: g.cap });
    last = m || last;
    onTick?.(i);
  }
  return { moves, windows, startedInWindow };
}

describe('the Pyreclast', () => {
  it('lives in a cavern under Ashfall: you land on the surface from orbit, and go down through the cave\'s mouth', () => {
    const { server } = world();
    const gd = server['gameData'];
    expect(def.system).toBe('ashfall_cavern');
    const cave = gd.getSystem('ashfall_cavern')!;
    expect(cave.surface?.of).toBe('cinder_reach');
    expect(cave.surface?.planet).toBe('ashfall');
    expect(cave.surface?.under?.surface).toBe('ashfall_surface');
    // (orbit lands you on the surface, never straight in the cave)
    expect(gd.getSystem('cinder_reach')!.planets!.find((p) => p.id === 'ashfall')!.surface).toBe('ashfall_surface');
    expect(def.brain).toBe('pyreclast');
  });

  it('X at the cave\'s mouth takes you down into it; flying out past its edge brings you back up beside the mouth', () => {
    const { server, got, pid, step } = world();
    const gd = server['gameData'];
    const conn = server.pilots.connOf(pid)!;
    const surface = gd.getSystem('ashfall_surface')!, cave = gd.getSystem('ashfall_cavern')!, u = cave.surface!.under!;
    (server as any).travelTo(conn, gd.getSystemNum('ashfall_surface'), u.x, u.y + u.radius * 0.5, false);
    step(5);
    expect(server.surfaces.descend(conn as any, surface, Position.x[pid], Position.y[pid])).toBe(true);
    step(5);
    expect(InSystem.systemId[pid]).toBe(gd.getSystemNum('ashfall_cavern'));
    expect(Math.hypot(Position.x[pid] - cave.surface!.landing!.x, Position.y[pid] - cave.surface!.landing!.y)).toBeLessThan(1500);
    // Out of the basin's open south side, past the edge
    place(pid, gd.getSystemNum('ashfall_cavern'), 0, cave.surface!.radius + 200);
    step(70);
    expect(InSystem.systemId[pid]).toBe(gd.getSystemNum('ashfall_surface'));
    expect(Math.hypot(Position.x[pid] - u.x, Position.y[pid] - u.y)).toBeLessThan(u.radius + 2000);
    expect(got.some((m) => m.type === 'toast' && /Back up on/.test((m as any).text ?? (m as any).message ?? ''))).toBe(true);
  });

  it('waits at the end of a long canyon: you land in a basin far from it, and the rock between is solid', () => {
    const { server, pid, step, num, bridge } = world();
    const gd = server['gameData'];
    const sys = gd.getSystem('ashfall_cavern')!;
    const t = gd.terrain('ashfall_cavern')!;
    expect(t.pieces.length).toBeGreaterThan(100);
    const land = sys.surface!.landing!;
    // Open ground where you land and where it waits, far apart (the whole canyon between)
    expect(insideTerrain(t, land.x, land.y, 600)).toBe(false);
    expect(insideTerrain(t, def.lair.x, def.lair.y, 1200)).toBe(false);
    expect(Math.hypot(land.x - def.lair.x, land.y - def.lair.y)).toBeGreaterThan(35000);
    // No straight line between them: the canyon winds
    expect(rayTerrain(t, land.x, land.y, def.lair.x, def.lair.y)).toBeLessThan(1);
    // A pilot flown at a wall stops at it
    place(pid, num, land.x, land.y);
    const east = { x: land.x + 30000, y: land.y };
    const wall = rayTerrain(t, land.x, land.y, east.x, east.y) * 30000;
    expect(wall).toBeLessThan(15000);
    // (it may slide along a slanted wall, but it's never in the rock, and never through it)
    const r = bridge.get(pid)!.derived.radius;
    let deepest = 0;
    for (let i = 0; i < 400; i++) {
      Velocity.x[pid] = 30; Velocity.y[pid] = 0; step();
      if (insideTerrain(t, Position.x[pid], Position.y[pid], r * 0.5)) deepest++;
    }
    expect(deepest).toBe(0);
    expect(Position.x[pid] - land.x).toBeLessThan(wall + 2500);
  });

  it('its vault is an arena: a barrier closes the canyon\'s mouth, and it lies dormant there until a pilot passes it', () => {
    const { server } = world();
    const a = server['gameData'].getSystem('ashfall_cavern')!.arena!;
    expect(a.boss).toBe('boss_pyreclast');
    const t = server['terrainOf'](server['gameData'].getSystemNum('ashfall_cavern'));
    // The barrier spans the canyon wall to wall: nothing flies or shoots past it from the canyon into the vault
    expect(rayTerrain(t, 0, -4200, 0, -9000)).toBeLessThan(1);
    expect(rayTerrain(t, 300, -9000, 300, -4200)).toBeLessThan(1);
    for (const [x, y] of a.barrier!) expect(insideTerrain(t, x, y, 0)).toBe(true);
    // Its lair inside, its way out outside
    expect(Math.hypot(def.lair.x - a.centre.x, def.lair.y - a.centre.y)).toBeLessThan(a.radius);
    expect(Math.hypot(a.outside.x - a.centre.x, a.outside.y - a.centre.y)).toBeGreaterThan(a.radius);
    expect(insideTerrain(t, a.outside.x, a.outside.y, 300)).toBe(false);
  });

  it('its HP: each stage\'s deciding pieces hold its stageHp (30/40/30); its limbs are extra, armour 5 against its body\'s 3, and never decide a stage', () => {
    const { server, bridge } = world();
    const eid = server.bosses.spawn('boss_pyreclast');
    const s = bridge.get(eid)!, cat = bridge.catalog;
    const sum = [0, 0, 0], limbs = [0, 0, 0];
    s.blueprint.parts.forEach((p, i) => {
      const st = stageOf(cat, s, i), pc = cat.pieces.get(p.piece)!;
      if (deciding(cat, s, i)) { sum[st - 1] += s.maxHp[i]; expect(partArmour(cat, p)).toBe(3); }
      if (pc.limb) { limbs[st - 1] += s.maxHp[i]; expect(partArmour(cat, p)).toBe(5); expect(deciding(cat, s, i)).toBe(false); }
    });
    sum.forEach((h, k) => expect(h).toBeCloseTo(def.stageHp![k], 0));
    expect(sum[0] / (sum[0] + sum[1] + sum[2])).toBeCloseTo(0.3, 2);
    // Limbs about 40% of their stage again (extra, optional work)
    limbs.forEach((h, k) => { expect(h / sum[k]).toBeGreaterThan(0.25); expect(h / sum[k]).toBeLessThan(0.45); });
    // A pen 4 gun breaks a limb several times faster than a pen 2.5 one
    const turret = s.blueprint.parts.find((p) => p.piece === 'pyreclast_scythe_gun_l')!;
    const hi = hitMultiplier(cat, bridge.tuning, turret, { type: 'kinetic', pen: 4 }), lo = hitMultiplier(cat, bridge.tuning, turret, { type: 'kinetic', pen: 2.5 });
    expect(hi / lo).toBeGreaterThan(2.5);
  });

  it('stage one, the fortress: one attack phase, barrage, broadside and scythe chained, then one short window, no move started in it; between moves and in it, only its single harassing sparks', () => {
    const w = world();
    const { server, god } = w;
    god();
    const eid = server.bosses.spawn('boss_pyreclast');
    noPersonal(server, eid);
    const brain = brainOf(server, eid);
    const weapons = server['weapons'], spawn = weapons.spawn.bind(weapons);
    const strays: string[] = [];
    let harass = 0;
    weapons.spawn = (owner: number, kind: string, ...rest: any[]) => {
      if (owner === eid && !['barrage', 'broadside'].includes(brain.moveName)) { if (kind === 'heart_spark') harass++; else strays.push(`${kind}@${brain.moveName}`); }
      return (spawn as any)(owner, kind, ...rest);
    };
    const r = loop(w, eid, 45, 2600);
    expect(r.moves.slice(0, 4)).toEqual(['barrage', 'broadside', 'scythe', 'barrage']);
    expect(r.windows[0].after).toBe('scythe');
    expect(r.windows.every((x) => x.ticks === PYRECLAST_EXPOSURE[0].ticks && x.cap === PYRECLAST_EXPOSURE[0].cap)).toBe(true);
    expect(PYRECLAST_EXPOSURE[0].ticks).toBeLessThanOrEqual(300);
    expect(r.startedInWindow).toBe(0);
    expect(strays).toEqual([]);
    // (it keeps up a light threat: a glint and a single spark now and then between its moves and in its window)
    expect(harass).toBeGreaterThan(2);
  });

  it('barrage: its wing turrets glow two at a time (clockwise, opposite sides) and throw fans of three slow balls at where you are, never ahead: moving sideways, they miss', () => {
    const w = world();
    const { server, pid, step, num, god } = w;
    god();
    const eid = server.bosses.spawn('boss_pyreclast');
    noPersonal(server, eid);
    const weapons = server['weapons'], spawn = weapons.spawn.bind(weapons);
    const balls: { speed: number; off: number }[] = [];
    weapons.spawn = (owner: number, kind: string, x: number, y: number, a: number, ...rest: any[]) => {
      const id = (spawn as any)(owner, kind, x, y, a, ...rest);
      if (owner === eid && kind === 'magma' && brainOf(server, eid).moveName === 'barrage') {
        const now = Math.atan2(Position.y[pid] - y, Position.x[pid] - x);
        balls.push({ speed: Math.hypot(Velocity.x[id], Velocity.y[id]), off: Math.abs(Math.atan2(Math.sin(a - now), Math.cos(a - now))) });
      }
      return id;
    };
    // Sideways at 20 a tick, across its line
    place(pid, num, Position.x[eid] + 2600, Position.y[eid] - 1500);
    for (let i = 0; i < 250; i++) { Velocity.x[pid] = 0; Velocity.y[pid] = 20; step(); if (Position.y[pid] > Position.y[eid] + 1500) place(pid, num, Position.x[eid] + 2600, Position.y[eid] - 1500); }
    // (its four turrets, two by two)
    expect(balls.length).toBe(12);
    // Slow (a level 30 ship outruns them), the middle of each fan straight at where you were
    expect(Math.max(...balls.map((b) => b.speed))).toBeLessThan(16.5);
    const middles = balls.filter((_, k) => k % 3 === 1);
    expect(Math.max(...middles.map((b) => b.off))).toBeLessThan(0.03);
  });

  it('broadside: it rolls side-on and draws parallel lanes straight out of one wing; its fast shells fly only down them; then it follows you round a little and fires again', () => {
    const w = world();
    const { server, got, pid, step, num, god } = w;
    god();
    const eid = server.bosses.spawn('boss_pyreclast');
    noPersonal(server, eid);
    const brain = brainOf(server, eid);
    brain.devPlay('broadside');
    place(pid, num, Position.x[eid] + 2600, Position.y[eid]);
    const lanes: any[] = [], shots: number[] = [], abeam: number[] = [];
    const weapons = server['weapons'], spawn = weapons.spawn.bind(weapons);
    weapons.spawn = (owner: number, kind: string, x: number, y: number, a: number, ...rest: any[]) => { if (owner === eid && kind === 'magma' && brain.moveName === 'broadside') shots.push(a); return (spawn as any)(owner, kind, x, y, a, ...rest); };
    for (let i = 0; i < 420; i++) {
      got.length = 0;
      step();
      for (const m of got) if (m.type === 'bossTelegraph' && m.kind === 'lane') {
        lanes.push(m);
        const toT = Math.atan2(Position.y[pid] - Position.y[eid], Position.x[pid] - Position.x[eid]);
        abeam.push(Math.abs(Math.atan2(Math.sin(toT - Rotation.angle[eid]), Math.cos(toT - Rotation.angle[eid]))));
      }
    }
    // Two salvos of four lanes
    expect(lanes.length).toBe(8);
    // One wing, all the same way (straight out of its side)
    expect(new Set(lanes.map((l) => Math.sign(l.y))).size).toBe(1);
    expect(new Set(lanes.map((l) => l.angle)).size).toBe(1);
    expect(Math.abs(Math.abs(lanes[0].angle) - Math.PI / 2)).toBeLessThan(1e-6);
    // Fired down them: every shell of a salvo the one way
    // (three down each lane, then two)
    expect(shots.length).toBe(20);
    for (const salvo of [shots.slice(0, 12), shots.slice(12)]) expect(Math.max(...salvo) - Math.min(...salvo)).toBeLessThan(1e-6);
    // Its target abeam that wing as the lanes are drawn (over its nose or its tail is out of every lane)
    expect(Math.abs(abeam[0] - Math.PI / 2)).toBeLessThan(0.15);
  });

  it('scythe: it sweeps one whole side from 900 to 3,400 off its hull: a pilot standing off is cut, one in close is not', () => {
    const hits = (dist: number) => {
      const w = world();
      const { server, pid, step, num, bridge } = w;
      const eid = server.bosses.spawn('boss_pyreclast');
      noPersonal(server, eid);
      const r = bridge.get(eid)!.derived.radius;
      brainOf(server, eid).devPlay('scythe');
      let n = 0;
      const dpb = bridge.damagePartBy.bind(bridge);
      (bridge as any).damagePartBy = (target: number, part: number, amount: number, source: number, hit?: any) => { if (target === pid && source === eid && hit?.type === 'kinetic') n++; return dpb(target, part, amount, source, hit); };
      for (let i = 0; i < 400; i++) { mend(server, pid); place(pid, num, Position.x[eid] + r + dist, Position.y[eid]); step(); }
      return n;
    };
    // (nose to tail and back: cut on each pass)
    expect(hits(2000)).toBe(2);
    expect(hits(500)).toBe(0);
  });

  it('its windows: x2 inside to the cap, x0.35 outside; filling the cap early cracks it once, with a bonus, and it stands still, harmless', () => {
    const { server, pid, step, num, bridge, god } = world();
    god();
    const eid = server.bosses.spawn('boss_pyreclast');
    noPersonal(server, eid);
    place(pid, num, Position.x[eid] + 2600, Position.y[eid]);
    step(5);
    const brain = brainOf(server, eid);
    expect(brain.windowShare()).toBeCloseTo(WINDOW.outside, 5);
    brain.devWindow('barrage');
    step(1);
    expect(brain.windowShare()).toBe(WINDOW.inside);
    const s = bridge.get(eid)!, plate = s.blueprint.parts.findIndex((p) => p.piece === 'pyreclast_wing_plate_l');
    for (let k = 0; k < 40 && !brain.fight.staggered(server.getTick()); k++) { server.bosses.onDamage(eid, bridge.hurt(eid, bridge.get(eid)!, plate, 400, pid), pid); step(); }
    expect(brain.fight.staggered(server.getTick())).toBe(true);
    expect(brain.fight.stats.cracks).toBe(1);
    expect(brain.windowShare()).toBeCloseTo(WINDOW.outside, 5);
    expect(brain.moveName).toBe('');
  });

  it('stage two, the hunter: mortar wall, dash chain, lance, mortar wall chained, then its window; its body\'s vents burn a pilot close to them, always', () => {
    const w = world();
    const { server, step, god, bridge, pid, num } = w;
    god();
    const eid = server.bosses.spawn('boss_pyreclast');
    noPersonal(server, eid);
    place(pid, num, Position.x[eid] + 2600, Position.y[eid]);
    step(5);
    advance(server, eid, 2, step);
    const ign = bridge.ignite.bind(bridge);
    let burnt = 0;
    (bridge as any).ignite = (q: number, ...rest: any[]) => { if (q === pid && rest[5] === eid) burnt++; return (ign as any)(q, ...rest); };
    const r = loop(w, eid, 40, 1700);
    expect(PYRECLAST_LOOP[1]).toEqual(['mortar', 'dash', 'lance', 'mortar']);
    // (a phase's last mortar and the next one's first run together across the window)
    expect(r.moves.slice(0, 5)).toEqual(['mortar', 'dash', 'lance', 'mortar', 'dash']);
    expect(r.windows[0].after).toBe('mortar');
    expect(r.windows[0].cap).toBe(PYRECLAST_EXPOSURE[1].cap);
    expect(r.startedInWindow).toBe(0);
    // Close to a vent, between its moves or in them: it burns
    const vent = bridge.get(eid)!.blueprint.parts.findIndex((p) => p.piece === 'pyreclast_vent_l');
    burnt = 0;
    for (let i = 0; i < 90; i++) { step(); mend(server, pid); const m = (brainOf(server, eid) as any).mount(vent); place(pid, num, m.x + 300, m.y); }
    expect(burnt).toBeGreaterThan(0);
  });

  it('dash chain: each dash streaked 0.9 s before it goes; fewer coils, fewer dashes', () => {
    const count = (coils: number) => {
      const { server, got, pid, step, num, bridge, god } = world();
      god();
      const eid = server.bosses.spawn('boss_pyreclast');
      noPersonal(server, eid);
      place(pid, num, Position.x[eid] + 2600, Position.y[eid]);
      step(5);
      advance(server, eid, 2, step);
      const s = bridge.get(eid)!;
      const off = s.blueprint.parts.flatMap((p, i) => (p.fn === 'dash_coil' ? [i] : [])).slice(0, 2 - coils);
      for (const i of off) bridge.hurt(eid, bridge.get(eid)!, i, 1e9);
      step(2);
      brainOf(server, eid).devPlay('dash');
      const streaks: number[] = [];
      for (let i = 0; i < 60 * 8; i++) { got.length = 0; step(); if (i % 30 === 0) place(pid, num, Position.x[eid] + 1700, Position.y[eid]); for (const m of got) if (m.type === 'bossTelegraph' && m.kind === 'dash' && m.bodyId === eid) streaks.push(m.ticks); }
      expect(streaks.every((t) => t >= 54)).toBe(true);
      return streaks.length;
    };
    expect(count(2)).toBe(5);
    expect(count(1)).toBe(4);
  });

  it('stage three, the heart: it darts once, then its crystal\'s seven beams in a set order; rings with their gaps always at its nose and tail; eight seekers however many pilots; then its vents open: its window', () => {
    const w = world();
    const { server, got, pid, step, num, god, join, bridge } = w;
    god();
    const eid = server.bosses.spawn('boss_pyreclast');
    noPersonal(server, eid);
    place(pid, num, Position.x[eid] + 2600, Position.y[eid]);
    step(5);
    advance(server, eid, 3, step);
    // Two more pilots present
    const others = [join('second').pid, join('third').pid];
    for (const q of others) { server['admin'].god.add(server.pilots.connOf(q) as any); }
    const weapons = server['weapons'], spawn = weapons.spawn.bind(weapons);
    const seekers: number[] = [], rings: { a: number; heading: number }[] = [];
    weapons.spawn = (owner: number, kind: string, x: number, y: number, a: number, k: number, shape: any, ...rest: any[]) => {
      if (owner === eid && kind === 'heart_seeker') seekers.push(shape?.target);
      if (owner === eid && kind === 'heart_spark' && brainOf(server, eid).moveName === 'ring') rings.push({ a, heading: Rotation.angle[eid] });
      return (spawn as any)(owner, kind, x, y, a, k, shape, ...rest);
    };
    const warned: number[] = [], beams: number[] = [];
    let darts = 0, vent: any = null;
    const r = loop(w, eid, 50, 1300, () => {
      for (const q of others) { mend(server, q); place(q, num, Position.x[eid] - 1300, Position.y[eid] + (q === others[0] ? 600 : -600)); }
      for (const m of got) {
        if (m.type === 'bossTelegraph' && m.kind === 'dash') darts++;
        if (m.type === 'bossTelegraph' && m.kind === 'crystal') warned.push(m.angle!);
        if (m.type === 'bossBeam' && m.kind === 'crystal') beams.push(m.a0);
        if (m.type === 'bossWindow' && m.ticks > 0 && !vent) vent = m;
      }
    });
    expect(r.moves.slice(0, 4)).toEqual(['crystal', 'ring', 'swarm', 'vent']);
    // (one dart a phase, before its crystal: the first may have gone before the watch began)
    const crystals = r.moves.filter((m) => m === 'crystal').length;
    expect(darts).toBeGreaterThanOrEqual(crystals - 1);
    expect(darts).toBeLessThanOrEqual(crystals);
    const rd = (a: number) => Math.round(a * 10) / 10 + 0;
    expect(warned.slice(0, 7).map(rd)).toEqual([0, -0.3, 0.3, -0.6, 0.6, -0.9, 0.9]);
    expect(beams.slice(0, 7).map(rd)).toEqual([0, -0.3, 0.3, -0.6, 0.6, -0.9, 0.9]);
    // Every ring's gaps at its nose and its tail: no spark within 15 degrees of either
    expect(rings.length).toBeGreaterThan(80);
    for (const s of rings) {
      const off = Math.abs(Math.atan2(Math.sin(s.a - s.heading), Math.cos(s.a - s.heading)));
      expect(off > 0.26 && off < Math.PI - 0.26).toBe(true);
    }
    // Eight a swarm, shared among the three of them (never more for more pilots)
    // (two waves of four: the watch may end between a swarm's waves)
    const swarms = r.moves.filter((m) => m === 'swarm').length;
    expect(seekers.length % 4).toBe(0);
    expect(seekers.length).toBeGreaterThan(8 * (swarms - 1));
    expect(seekers.length).toBeLessThanOrEqual(8 * swarms);
    expect(new Set(seekers).size).toBe(3);
    // The vent: its window, after the phase
    expect(r.windows[0].after).toBe('vent');
    expect(vent?.cap).toBe(PYRECLAST_EXPOSURE[2].cap);
    expect(vent?.ticks).toBe(PYRECLAST_EXPOSURE[2].ticks);
    void pid; void bridge;
  });

  it('its heart\'s vents burn anything near them while they\'re open, and can\'t be broken then; heat plating takes a quarter of the burn bare hull does', () => {
    const { server, pid, step, num, bridge, god } = world();
    god();
    const eid = server.bosses.spawn('boss_pyreclast');
    noPersonal(server, eid);
    place(pid, num, Position.x[eid] + 2600, Position.y[eid]);
    step(5);
    advance(server, eid, 3, step);
    const brain = brainOf(server, eid);
    brain.devPlay('vent');
    const s = bridge.get(eid)!, vent = s.blueprint.parts.findIndex((p) => p.piece === 'pyreclast_s3_aft_vent');
    const ign = bridge.ignite.bind(bridge);
    let burnt = 0;
    (bridge as any).ignite = (q: number, ...rest: any[]) => { if (q === pid && rest[5] === eid) burnt++; return (ign as any)(q, ...rest); };
    for (let i = 0; i < 120; i++) { step(); const m = (brain as any).mount(vent); place(pid, num, m.x + 300, m.y); }
    expect(burnt).toBeGreaterThan(0);
    const was = bridge.get(eid)!.hp[vent];
    bridge.hurt(eid, bridge.get(eid)!, vent, 1e9);
    step(2);
    expect(bridge.get(eid)!.derived.alive[vent]).toBe(true);
    expect(bridge.get(eid)!.hp[vent]).toBe(was);
    // (the burn is thermal at pen 3: a ceramic laminate plate takes far less of it than a plain hull)
    const cat = bridge.catalog, heat = { type: 'thermal' as const, pen: 3 };
    const ceramic = hitMultiplier(cat, bridge.tuning, { material: 'ceramic_laminate', fn: 'armor' }, heat);
    const bare = hitMultiplier(cat, bridge.tuning, { material: 'steel', fn: 'hull' }, heat);
    expect(ceramic / bare).toBeLessThan(0.35);
  });

  it('its limbs: each works an attack; broken, that attack goes and it moves on (both scythe roots: no sweep; every wing turret: no barrage, no broadside)', () => {
    const w = world();
    const { server, step, bridge, god } = w;
    god();
    const eid = server.bosses.spawn('boss_pyreclast');
    noPersonal(server, eid);
    const off = (re: RegExp) => { const s = bridge.get(eid)!; s.blueprint.parts.forEach((p, i) => { if (re.test(p.piece)) bridge.hurt(eid, bridge.get(eid)!, i, 1e9); }); step(2); };
    off(/scythe_root_[lr]$/);
    // (its stage isn't moved on by it: limbs never decide)
    expect(brainOf(server, eid).integrity()).toBeCloseTo(1, 3);
    let r = loop(w, eid, 30, 2600);
    expect(r.moves).not.toContain('scythe');
    expect(r.moves.slice(0, 3)).toEqual(['barrage', 'broadside', 'barrage']);
    off(/(scythe_gun|wing_flak)_[lr]$/);
    r = loop(w, eid, 20, 2600);
    expect(r.moves).toEqual([]);
  });

  it('personal attacks: each pilot present draws its own from its stage\'s pool, in its moves too but never in a window\'s rest beat; a broken limb takes its attack out', () => {
    const w = world();
    const { server, got, step, bridge, god } = w;
    god();
    const eid = server.bosses.spawn('boss_pyreclast');
    const brain = brainOf(server, eid);
    const kinds = new Map<string, number>();
    let bad = 0, inMoves = 0;
    loop(w, eid, 90, 2600, () => {
      const now = server.getTick(), win = brain.fight.window;
      for (const m of got) {
        if (m.type !== 'bossTelegraph' || !['lob', 'flak', 'synapse', 'spark'].includes(m.kind)) continue;
        // (a flak burst's five marks are one attack)
        kinds.set(m.kind, (kinds.get(m.kind) ?? 0) + (m.kind === 'flak' ? 0.2 : 1));
        // (each starts the tick it's drawn: in its moves too, but never in a window's first 1 s)
        if (m.kind !== 'flak' || m.ticks === 60) { if (win && now - win.at < WINDOW.rest && now < win.at + win.ticks) bad++; if (brain.fight.isSignature(brain.moveName)) inMoves++; }
      }
    });
    expect([...kinds.keys()].every((k) => ['lob', 'flak'].includes(k))).toBe(true);
    expect([...kinds.values()].reduce((a, b) => a + b, 0)).toBeGreaterThan(3);
    expect(bad).toBe(0);
    expect(inMoves).toBeGreaterThan(0);
    // Its bays and flak off: only lobs (and its turrets' lobs need its turrets)
    const s = bridge.get(eid)!;
    s.blueprint.parts.forEach((p, i) => { if (/_(bay|wing_flak)_[lr]$/.test(p.piece)) bridge.hurt(eid, bridge.get(eid)!, i, 1e9); });
    step(2);
    kinds.clear();
    loop(w, eid, 60, 2600, () => { for (const m of got) if (m.type === 'bossTelegraph' && ['lob', 'flak'].includes(m.kind)) kinds.set(m.kind, 1); });
    expect([...kinds.keys()]).toEqual(['lob']);
  });

  it('its hints: meeting it files its scan and the dodge rules of its attacks as records; a glancing hit and catching fire at its vents each get a plain toast, once', () => {
    const { server, got, pid, step, num, bridge } = world();
    const eid = server.bosses.spawn('boss_pyreclast');
    noPersonal(server, eid);
    place(pid, num, Position.x[eid] + 2600, Position.y[eid]);
    step(3);
    // (the fight starts when it's hurt: a hit that barely gets through its plating)
    server.bosses.onDamage(eid, 5, pid, true);
    server.bosses.onDamage(eid, 5, pid, true);
    step(2);
    const found = server.pilots.get(server.pilots.connOf(pid)!)!.codex.found;
    expect(found).toEqual(expect.arrayContaining(['pyreclast_scan', 'pyreclast_tactics']));
    const toasts = () => got.filter((m) => m.type === 'toast').map((m) => (m as any).text as string);
    expect(toasts().filter((t) => /^Glancing hit/.test(t)).length).toBe(1);
    // Burning at its vents (its heart's, open)
    advance(server, eid, 3, step);
    brainOf(server, eid).devPlay('vent');
    const vent = bridge.get(eid)!.blueprint.parts.findIndex((p) => p.piece === 'pyreclast_s3_aft_vent');
    for (let i = 0; i < 160; i++) { step(); mend(server, pid); const m = (brainOf(server, eid) as any).mount(vent); place(pid, num, m.x + 300, m.y); }
    expect(toasts().filter((t) => /^Burning: heat plating/.test(t)).length).toBe(1);
    // (its records say nothing of what it is: a scan and a combat log, mechanics only)
    const codex = (files.codex as any).entries.filter((e: any) => e.id.startsWith('pyreclast_'));
    expect(codex.map((e: any) => e.source)).toEqual(["Your ship's scanner", "Your ship's combat recorder"]);
  });

  it('stage one: each plate shot off bares the skeleton under it, shots pass through bones; every plate gone, it stops, can\'t be hurt, and blows its wings away piece by piece', () => {
    const { server, got, pid, step, num, bridge, god } = world();
    god();
    const eid = server.bosses.spawn('boss_pyreclast');
    place(pid, num, Position.x[eid] + 2600, Position.y[eid]);
    step(5);
    const brain = server.bosses.brainOf(eid)!;
    const s0 = bridge.get(eid)!, catalog = bridge.catalog;
    const piece = (i: number) => catalog.pieces.get(s0.blueprint.parts[i].piece)!;
    const stage = (i: number) => piece(i).stage;
    const plates = s0.blueprint.parts.flatMap((_, i) => (stage(i) === 1 && !piece(i).skeleton ? [i] : []));
    const bones = s0.blueprint.parts.flatMap((_, i) => (piece(i).skeleton ? [i] : []));
    expect(bones.length).toBe(2);
    expect(brain.integrity!()).toBeCloseTo(1, 3);
    // A body part, shot while its plates stand: the nearest plate takes it
    const body = s0.blueprint.parts.findIndex((_, i) => stage(i) === 2 && !piece(i).limb);
    const before = s0.hp.slice();
    bridge.hurt(eid, s0, body, 40);
    let s = bridge.get(eid)!;
    expect(s.hp[body]).toBe(before[body]);
    expect(stage(s.hp.findIndex((h, i) => h < before[i]))).toBe(1);
    // Every plate shot off: its bones are still there, and a shot meant for them passes through (nothing's left to hit there)
    for (const i of plates) { const q = bridge.get(eid)!; if (q.derived.alive[i]) bridge.hurt(eid, q, i, 1e9); }
    step(1);
    s = bridge.get(eid)!;
    expect(bones.every((i) => s.derived.alive[i])).toBe(true);
    expect(brain.integrity!()).toBeCloseTo(2 / 3, 2);
    for (const k of bones) {
      const [bx, by] = (bridge as any).partWorld(eid, s, k);
      const h = bridge.segmentHit(eid, s, bx, by - 3000, bx, by);
      expect(h === null || !piece(h.part).skeleton).toBe(true);
    }
    // It stops and can't be hurt while it blows its skeletons apart, then its wings go
    step(2);
    expect(brain.invulnerable!()).toBe(true);
    const was = bridge.get(eid)!.hp.slice();
    bridge.hurt(eid, bridge.get(eid)!, body, 500);
    expect(bridge.get(eid)!.hp[body]).toBe(was[body]);
    got.length = 0;
    for (let i = 0; i < 60 * 8 && brain.invulnerable!(); i++) step();
    expect(brain.invulnerable!()).toBe(false);
    const blows = got.filter((m) => m.type === 'bossBlow' && m.bodyId === eid) as { part: number }[];
    expect(blows.length).toBeGreaterThan(4);
    expect(blows.every((b) => stage(b.part) === 1 && !piece(b.part).skeleton)).toBe(true);
    s = bridge.get(eid)!;
    expect(s.blueprint.parts.some((_, i) => s.derived.alive[i] && stage(i) === 1)).toBe(false);
    // Now its body can be hurt
    const w2 = s.hp[body];
    bridge.hurt(eid, s, body, 40);
    expect(bridge.get(eid)!.hp[body]).toBeLessThan(w2);
  });

  it('stage two: its body\'s pieces are wrecked, not shot off (shots pass wrecks by); every deciding piece wrecked, it stops and its body blows apart, its core last, baring its heart', () => {
    const { server, pid, step, num, bridge, god } = world();
    god();
    const eid = server.bosses.spawn('boss_pyreclast');
    place(pid, num, Position.x[eid] + 2600, Position.y[eid]);
    step(5);
    const brain = server.bosses.brainOf(eid)!;
    advance(server, eid, 2, step);
    let s = bridge.get(eid)!;
    const catalog = bridge.catalog, piece = (i: number) => catalog.pieces.get(s.blueprint.parts[i].piece)!;
    const body = s.blueprint.parts.flatMap((_, i) => (piece(i).stage === 2 && deciding(catalog, s, i) ? [i] : []));
    expect(body.every((i) => s.derived.alive[i])).toBe(true);
    // Worn right out, a piece stays on: a wreck
    const a = body[0];
    bridge.hurt(eid, s, a, 1e9);
    step(1);
    s = bridge.get(eid)!;
    expect(s.derived.alive[a]).toBe(true);
    expect(isRuined(catalog, s, a)).toBe(true);
    // Every deciding piece wrecked: it stops, can't be hurt, and its body blows apart a piece at a time, its core last
    for (const i of body) { const q = bridge.get(eid)!; if (!isRuined(catalog, q, i)) bridge.hurt(eid, q, i, 1e9); }
    step(2);
    expect(brain.integrity!()).toBeCloseTo(1 / 3, 2);
    expect(brain.invulnerable!()).toBe(true);
    const gone: number[][] = [];
    let prev = new Set(bridge.get(eid)!.derived.alive.flatMap((x, i) => (x ? [i] : [])));
    for (let i = 0; i < 60 * 12 && brain.invulnerable!(); i++) {
      step();
      const now = new Set(bridge.get(eid)!.derived.alive.flatMap((x, k) => (x ? [k] : [])));
      const went = [...prev].filter((k) => !now.has(k));
      if (went.length) gone.push(went);
      prev = now;
    }
    expect(brain.invulnerable!()).toBe(false);
    expect(gone.length).toBeGreaterThan(15);
    expect(gone.flat().every((k) => piece(k).stage === 2)).toBe(true);
    // What's left is its heart, whole, and it can be hurt
    const left = bridge.get(eid)!;
    expect(left.blueprint.parts.every((_, i) => !left.derived.alive[i] || piece(i).stage === 3)).toBe(true);
    const c = left.blueprint.parts.findIndex((p) => p.fn === 'core'), was = left.hp[c];
    bridge.hurt(eid, left, c, 50);
    expect(bridge.get(eid)!.hp[c]).toBeLessThan(was);
  });

  it('its stages are its brain\'s, and it flies as built throughout', () => {
    const { server, pid, step, num, bridge } = world();
    const eid = server.bosses.spawn('boss_pyreclast');
    place(pid, num, Position.x[eid] + 2600, Position.y[eid]);
    step(5);
    const s = bridge.get(eid)!, catalog = bridge.catalog;
    const piece = (i: number) => catalog.pieces.get(s.blueprint.parts[i].piece)!;
    s.blueprint.parts.forEach((p, i) => {
      expect([1, 2, 3]).toContain(piece(i).stage);
      expect(!!piece(i).ruin).toBe(piece(i).stage === 2 || /s3_(inner\d|outer\d+|core)$/.test(p.piece));
      expect(!!piece(i).under).toBe(piece(i).stage === 3);
    });
    const { com, mass, maxThrust } = s.derived;
    advance(server, eid, 3, step);
    const after = bridge.get(eid)!;
    expect(after.derived.com).toEqual(com);
    expect(after.derived.mass).toBe(mass);
    expect(after.derived.maxThrust).toEqual(maxThrust);
  });

  it('its heart\'s crystal can be shot off; its round is wrecked, not shot off; all wrecked, it shudders and every piece blows apart at once', () => {
    const { server, got, pid, step, num, bridge, god } = world();
    god();
    const eid = server.bosses.spawn('boss_pyreclast');
    place(pid, num, Position.x[eid] + 1300, Position.y[eid]);
    step(5);
    const brain = server.bosses.brainOf(eid)!;
    advance(server, eid, 3, step);
    let s = bridge.get(eid)!;
    const catalog = bridge.catalog, crystal = s.blueprint.parts.findIndex((p) => p.piece === 'pyreclast_s3_mineral');
    bridge.hurt(eid, s, crystal, 1e9);
    step(1);
    s = bridge.get(eid)!;
    expect(s.derived.alive[crystal]).toBe(false);
    const round = s.blueprint.parts.flatMap((p, i) => (/s3_(inner\d|outer\d+|core)$/.test(p.piece) ? [i] : []));
    expect(round.length).toBe(25);
    for (const i of round.slice(0, -1)) bridge.hurt(eid, bridge.get(eid)!, i, 1e9);
    step(1);
    s = bridge.get(eid)!;
    expect(round.slice(0, -1).every((i) => s.derived.alive[i] && isRuined(catalog, s, i))).toBe(true);
    expect(brain.invulnerable!()).toBe(false);
    const before = new Set(bridge.bodies.keys());
    bridge.hurt(eid, s, round[round.length - 1], 1e9);
    step(2);
    expect(brain.invulnerable!()).toBe(true);
    expect(bridge.has(eid)).toBe(true);
    let gone = -1;
    for (let i = 0; i < 200 && gone < 0; i++) { step(); if (!bridge.has(eid)) gone = i; }
    expect(gone).toBeGreaterThan(40);
    const chunks = [...bridge.bodies.keys()].filter((k) => !before.has(k) && bridge.get(k)!.kind === 'debris');
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks.length).toBeLessThanOrEqual(12);
    expect(chunks.every((k) => (bridge as any).intangible.has(k))).toBe(true);
    expect(got.some((m) => m.type === 'bossDefeated' && m.bodyId === eid)).toBe(true);
  });

  it('in its cavern (its walls fixed) a shot flying straight works out where it meets the rock once, and bursts there; elsewhere, none is worked out ahead', () => {
    const { server, num } = world();
    const eid = server.bosses.spawn('boss_pyreclast');
    const weapons = server['weapons'], t = server['terrainOf'](num);
    let best = { a: 0, d: Infinity };
    for (let k = 0; k < 32; k++) {
      const a = (k / 32) * Math.PI * 2, f = rayTerrain(t, def.lair.x, def.lair.y, def.lair.x + Math.cos(a) * 12000, def.lair.y + Math.sin(a) * 12000);
      if (f < 1 && f * 12000 < best.d) best = { a, d: f * 12000 };
    }
    expect(best.d).toBeLessThan(12000);
    const ox = def.lair.x + Math.cos(best.a) * (best.d - 1500), oy = def.lair.y + Math.sin(best.a) * (best.d - 1500);
    const walls: { x: number; y: number }[] = [];
    const onWall = weapons.onWallHit.bind(weapons);
    weapons.onWallHit = (proj: number, x: number, y: number) => { walls.push({ x, y }); onWall(proj, x, y); };
    const shot = weapons.spawn(eid, 'heart_spark', ox, oy, best.a, 1, { speedScale: 1, sizeScale: 1, turret: false, noBurst: true });
    Velocity.x[shot] = Math.cos(best.a) * 12; Velocity.y[shot] = Math.sin(best.a) * 12;
    server.step();
    expect(server['shotWalls'].has(shot)).toBe(true);
    for (let i = 0; i < 400 && !walls.length; i++) server.step();
    expect(walls.length).toBe(1);
    expect(Math.hypot(walls[0].x - (ox + Math.cos(best.a) * 1500), walls[0].y - (oy + Math.sin(best.a) * 1500))).toBeLessThan(40);
    const up = server['gameData'].getSystemNum('ashfall_surface');
    expect(server['gameData'].getSystemByNum(up)?.surface?.fixedWalls).toBeFalsy();
    const other = weapons.spawn(eid, 'heart_spark', 0, 0, 0, 1, { speedScale: 1, sizeScale: 1, turret: false, noBurst: true });
    InSystem.systemId[other] = up;
    server.step();
    expect(server['shotWalls'].has(other)).toBe(false);
  });

  it('clients are sent its true part maximums, so at full health it draws (and its bar reads) as whole', () => {
    const { server, got, pid, step, num, bridge } = world();
    const eid = server.bosses.spawn('boss_pyreclast');
    place(pid, num, Position.x[eid] + 3000, Position.y[eid]);
    step(30);
    const sync = got.find((m) => m.type === 'shipSync' && m.id === eid) as any;
    expect(sync?.maxHp).toBeDefined();
    const ship = bridge.get(eid)!;
    sync.maxHp.forEach((m: number, i: number) => expect(Math.abs(m - ship.maxHp[i])).toBeLessThan(1.01));
    sync.hp.forEach((h: number, i: number) => expect(h / sync.maxHp[i]).toBeGreaterThan(0.99));
  });

  it('its drones go when it does (a reset leaves nothing behind)', () => {
    const { server, step, num, pid } = world();
    const eid = server.bosses.spawn('boss_pyreclast');
    place(pid, num, Position.x[eid] + 3000, Position.y[eid]);
    for (let k = 0; k < 4; k++) server.mobs.spawn('ember_drone', num, k * 100, 5000, 0, 0, eid);
    expect(server.mobs.count(num)).toBe(4);
    server.bosses.remove(eid);
    step();
    expect(server.mobs.count(num)).toBe(0);
  });
});
