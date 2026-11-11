// The live sim preview: boots the game's own GameServer (empty scene, the same one the server tests drive), puts a pilot
// in a ship carrying the weapon, holds the trigger at a few test targets and records every tick. The shells, beams,
// fuses, splash and damage are the game's own code (common stepGuns/launchShot, server Weapons/ShipBridge): the lab only
// places things and reads positions. Frames are plain data the page replays on a canvas. A draft is injected into the
// ship config in memory (validate.ts configWith); nothing is written.
import { Position, Velocity, Rotation, Input, InSystem, Projectile, replicaAngle, quantizeReplicaAngle, ReplicaMode, isWeaponFn, type Blueprint } from '@space-game/common';
import { buildCheatShip } from '../../common/src/gunRange/cheatShip';
import { placeGeometry } from '../../common/src/ships/grid';
import { makeEmptyServer, resetGlobals } from '../../server/src/testkits/world.testkit';
import { createShipBridge } from '../../server/src/ships/createShipBridge';
import { MemoryProfileStore } from '../../server/src/profile/ProfileStore';
import { projectileQuery } from '../../server/src/net/snapshot/rows/bodies';
import { LocalTransport } from '../../server/src/net/LocalTransport';
import type { ShipState } from '../../common/src/ships/state';
import { loadShipConfigFromDisk } from '../../server/src/ships/loadShipConfig';
import { configWith } from './validate';
import { DATA_DIR } from './paths';
import { loadSources } from './catalogue';

export type Scenario = 'dummy' | 'moving' | 'wall';
export interface SimRequest {
  /** A models.json model id, a legacy function id, or `kind:<kind>` */
  weapon: string;
  /** A draft's model row: the sim uses it in place of (or beside) the game's models */
  draft?: Record<string, any>;
  scenario: Scenario;
  /** Ticks to run (60 a second; default 480) */
  ticks?: number;
}

export interface Shape { polys: [number, number][][]; com: [number, number] }
/** One tick: pilot [x, y, angle, firing], targets [x, y, angle, damage so far] (hit: struck this tick), shells [x, y, vx, vy, type], blasts [x, y, radius] */
export interface Frame { t: number; p: [number, number, number, 0 | 1]; tg: [number, number, number, number][]; hit: number[]; sh: [number, number, number, number, number][]; bl: [number, number, number][] }
export interface SimResult { weapon: string; kind: string; beam: boolean; cellSize: number; pilot: Shape; target: Shape; ticks: number; frames: Frame[]; dealt: number[]; note?: string }

const RANGE = 700;
const r1 = (v: number) => Math.round(v * 10) / 10;

/** Part outlines in grid space, for the page to draw (the same transform as shipPointToWorld) */
function shapeOf(bridge: any, ship: ShipState): Shape {
  return { polys: ship.blueprint.parts.map((q) => placeGeometry(bridge.catalog, q).polygon.map((p: number[]) => [r1(p[0]), r1(p[1])] as [number, number])), com: [r1(ship.derived.com[0]), r1(ship.derived.com[1])] };
}

/** The pilot's ship: the cheat ship for a mountable model, else the starter with its guns swapped for the function */
function pilotShip(bridge: any, id: string, starter: Blueprint): Blueprint {
  const cheat = buildCheatShip(bridge.catalog, id);
  if (cheat) return cheat;
  let n = 0;
  return { ...starter, range: true as const, parts: starter.parts.map((q) => ((q.fn === 'cannon_pip' || isWeaponFn(q.fn)) && n++ < 2 ? { ...q, fn: id } : q)) };
}

export function runSim(req: SimRequest, dir = DATA_DIR): SimResult {
  const ticks = Math.max(60, Math.min(900, req.ticks ?? 480));
  const isKind = req.weapon.startsWith('kind:');
  const cfg = req.draft ? configWith(req.draft, dir) : loadShipConfigFromDisk(dir);
  const ships = createShipBridge(cfg);
  resetGlobals();
  // (The server starts an hourly session sweep per instance: caught here and cleared at the end, so runs do not pile up)
  const sweeps: ReturnType<typeof setInterval>[] = [], realInterval = globalThis.setInterval;
  globalThis.setInterval = ((...a: Parameters<typeof setInterval>) => { const h = realInterval(...a); sweeps.push(h); return h; }) as typeof setInterval;
  const server = makeEmptyServer({ profileStore: new MemoryProfileStore(), ships });
  globalThis.setInterval = realInterval;
  const net = new LocalTransport(server);
  const blasts: [number, number, number][] = [];
  net.onMessage = (m: any) => { if (m.type === 'detonation') blasts.push([m.x, m.y, m.radius]); };
  net.connect();
  net.send({ type: 'join', username: 'lab' } as never);
  const pid = net.getPlayerId();
  const bridge = server.getShips()!;
  // The gun range's own switch: the standard ammo crate, unlimited (a flak or mortar fires its full rounds, never dry)
  server.ammo.setFree(server.pilots.connOf(pid)!, true);
  const sys = InSystem.systemId[pid];
  const X = 25000, Y = 20000;
  const kind = isKind ? req.weapon.slice(5) : (req.draft?.weapon ?? loadSources(dir).models.concat(loadSources(dir).functions).find((r) => r.id === req.weapon)?.weapon ?? 'cannon');
  if (!isKind) bridge.respawnInPlace(pid, pilotShip(bridge, req.weapon, bridge.get(pid)!.blueprint));

  // Targets: the starter hull (a stationary dummy), one that crosses the line of fire, or a line of five
  const dummyBp = cfg.starter;
  const spawn = (x: number, y: number) => bridge.spawnDummy(dummyBp, x, y, Math.PI, sys);
  const targets = req.scenario === 'wall' ? [-240, -120, 0, 120, 240].map((dy) => spawn(X + RANGE, Y + dy)) : [spawn(X + RANGE, Y)];
  const dealt = targets.map(() => 0);
  const hurt = (bridge as any).hurt.bind(bridge);
  (bridge as any).hurt = (eid: number, ship: unknown, part: number, amount: number, ...rest: unknown[]) => {
    const d = hurt(eid, ship, part, amount, ...rest), i = targets.indexOf(eid);
    if (i >= 0) { dealt[i] += typeof d === 'number' ? d : amount; hits.add(i); }
    return d;
  };
  const hits = new Set<number>();
  const kindDef = (ships as any).tuning.weapons?.[kind];
  const beam = kindDef?.type === 'beam';
  const frames: Frame[] = [];
  const hold = () => { Position.x[pid] = X; Position.y[pid] = Y; Velocity.x[pid] = 0; Velocity.y[pid] = 0; };

  for (let t = 0; t < ticks; t++) {
    hold();
    // The moving target sweeps across the line of fire (a sine, 300 units either way, one pass every 6 seconds)
    if (req.scenario === 'moving') { Position.x[targets[0]] = X + RANGE; Position.y[targets[0]] = Y + 300 * Math.sin(t / 57); Velocity.x[targets[0]] = 0; Velocity.y[targets[0]] = 0; }
    for (const e of targets) { Rotation.angle[e] = Math.PI; const s = bridge.get(e)!; s.shield = 0; for (let i = 0; i < s.hp.length; i++) s.hp[i] = s.maxHp[i]; }
    // The pilot aims at the middle target as it stands; the trigger is held 3 seconds, released 1
    const mid = targets[Math.floor(targets.length / 2)], dx = Position.x[mid] - X, dy = Position.y[mid] - Y, ang = Math.atan2(dy, dx);
    Rotation.angle[pid] = ang;
    const firing = t % 240 < 180;
    Input.fireLeft[pid] = firing && !isKind ? 1 : 0;
    Input.cursorDist[pid] = Math.hypot(dx, dy);
    Input.targetAngle[pid] = replicaAngle(ReplicaMode.Player, quantizeReplicaAngle(ang));
    // A bare kind has no gun: shoot it from the pilot, a round every half second
    if (isKind && firing && t % 30 === 0) server.weapons.spawn(pid, kind, X + 30 * Math.cos(ang), Y + 30 * Math.sin(ang), ang, 1, { speedScale: 1, sizeScale: 1, turret: false });
    hits.clear(); blasts.length = 0;
    server.step();
    const shells: Frame['sh'] = [];
    for (const e of projectileQuery((server as any).world)) if (InSystem.systemId[e] === sys) shells.push([r1(Position.x[e] - X), r1(Position.y[e] - Y), r1(Velocity.x[e]), r1(Velocity.y[e]), Projectile.weaponType[e]]);
    frames.push({
      t, p: [0, 0, r1(Rotation.angle[pid]), (firing ? 1 : 0)],
      tg: targets.map((e, i) => [r1(Position.x[e] - X), r1(Position.y[e] - Y), r1(Rotation.angle[e]), r1(dealt[i])]),
      hit: [...hits], sh: shells, bl: blasts.map(([x, y, r]) => [r1(x - X), r1(y - Y), r1(r)]),
    });
  }
  const cellSize = (ships as any).tuning.cellSize as number;
  const pilot = shapeOf(bridge, bridge.get(pid)!), target = shapeOf(bridge, bridge.get(targets[0])!);
  for (const h of sweeps) clearInterval(h);
  return { weapon: req.weapon, kind, beam, cellSize, pilot, target, ticks, frames, dealt: dealt.map(r1), ...(isKind ? { note: 'A bare kind has no gun: the sim launches its shell from the ship every half second.' } : {}) };
}
