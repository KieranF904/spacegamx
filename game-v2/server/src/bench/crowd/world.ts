/**
 * Crowd bench: the world. A real GameServer (seeded, with an injected clock), the ship pool, the layouts and the bot
 * pilots. Nothing here measures; meter.ts does. Run through ../crowdBench.ts.
 */
import { join, dirname } from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { Position, Velocity, Input, InSystem, ReplicaMode, replicaAngle, quantizeReplicaAngle, quantizeCursorAngle } from '@space-game/common';
import { GameServer } from '../../GameServer.js';
import { GameData } from '../../data/GameData.js';
import { readGameDataFiles } from '../../data/loadGameDataFromDisk.js';
import { loadShipConfigFromDisk } from '../../ships/loadShipConfig.js';
import { createShipBridge } from '../../proto/createProtoServer.js';

export const dataDir = join(dirname(fileURLToPath(import.meta.url)), '../../../../data');

/** mulberry32: the bench's own stream (and Math.random replaced by one, so a run repeats) */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export const clock = { t: 1_000_000 };
/** `crowd`: crowd fallbacks on (GameServerOptions.crowd; every client takes them, the full caps set) */
export function makeServer(crowd = false): GameServer {
  return new GameServer({
    gameData: new GameData(readGameDataFiles(dataDir)),
    userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as never,
    scene: 'sectors', autoStart: false,
    ships: createShipBridge(loadShipConfigFromDisk(dataDir)),
    clock: () => clock.t,
    crowd,
  } as never);
}

/** Real ships, a mix of light and heavy (blueprint names under data/ships) */
export const SHIP_POOL = ['sparrow-t', 'sunspear', 'wisp', 'ports-gale', 'ports-heron', 'ports-wasp', 'ports-brawler', 'halberd'];

export function blueprint(server: GameServer, name: string): any {
  const hit = server.getShips().library.get(name);
  if (hit) return hit;
  for (const f of [`blueprints/${name}.json`, `blueprints/dev/${name}.json`]) {
    try { return JSON.parse(readFileSync(join(dataDir, 'ships', f), 'utf8')); } catch { /* next */ }
  }
  throw new Error(`no blueprint ${name}`);
}

/**
 * spread: a 10 km grid, each pilot fighting near home; ball: everyone within 5 km; boss: round a boss; cruise: a 12 km
 * grid, each pilot flying out and back along a 24 km leg (the focus grid's churn: cells dropped behind, entered ahead,
 * dropped ones met again on the way back)
 */
export type Layout = 'spread' | 'ball' | 'boss' | 'cruise';
export const LAYOUTS: Layout[] = ['spread', 'ball', 'boss'];

export interface Ctl { forward: boolean; backward: boolean; left: boolean; right: boolean; boost: boolean; fireLeft: boolean; fireRight: boolean; targetAngle: number; cursorDist: number }
const NEAR = 1300, FAR = 1700;

/** A pilot's controls against a target: hold 1.3-1.7 km off it, face it, fire inside 1.8 km */
export function controlsFor(p: number, t: number, has: (t: number) => boolean): Ctl {
  const c: Ctl = { forward: false, backward: false, left: false, right: false, boost: false, fireLeft: false, fireRight: false, targetAngle: Input.targetAngle[p], cursorDist: Input.cursorDist[p] };
  if (t < 0 || !has(t)) return c;
  const dx = Position.x[t] - Position.x[p], dy = Position.y[t] - Position.y[p], d = Math.hypot(dx, dy) || 1;
  c.targetAngle = Math.atan2(dy, dx);
  c.cursorDist = Math.min(65000, d);
  const want = d > FAR ? 1 : d < NEAR ? -1 : 0;
  if (want) {
    const ux = (dx / d) * want, uy = (dy / d) * want;
    if (uy < -0.38) c.forward = true;
    if (uy > 0.38) c.backward = true;
    if (ux < -0.38) c.left = true;
    if (ux > 0.38) c.right = true;
  }
  if (d < 1800) { c.fireLeft = true; c.fireRight = true; }
  return c;
}

/** Straight onto the ECS inputs (what a legacy client's input message ends up as) */
export function applyDirect(p: number, c: Ctl): void {
  for (const k of ['forward', 'backward', 'left', 'right', 'fireLeft', 'fireRight', 'boost'] as const) Input[k][p] = c[k] ? 1 : 0;
  Input.targetAngle[p] = replicaAngle(ReplicaMode.Player, quantizeReplicaAngle(c.targetAngle));
  Input.cursorDist[p] = c.cursorDist;
}
export const inputKey = (c: Ctl) => JSON.stringify([c.forward, c.backward, c.left, c.right, c.boost, c.fireLeft, c.fireRight, quantizeCursorAngle(c.targetAngle), Math.round(c.cursorDist / 4)]);

export interface Bot { index: number; pid: number; ship: string; home: { x: number; y: number }; target: number; probe: boolean; leg?: { x: number; y: number; out: boolean } }

/** Cruising to a point: full ahead (boosting while far), nothing fired */
export function cruiseControls(p: number, x: number, y: number): Ctl {
  const c: Ctl = { forward: false, backward: false, left: false, right: false, boost: false, fireLeft: false, fireRight: false, targetAngle: Input.targetAngle[p], cursorDist: Input.cursorDist[p] };
  const dx = x - Position.x[p], dy = y - Position.y[p], d = Math.hypot(dx, dy) || 1;
  c.targetAngle = Math.atan2(dy, dx);
  c.cursorDist = 2000;
  const ux = dx / d, uy = dy / d;
  if (uy < -0.38) c.forward = true;
  if (uy > 0.38) c.backward = true;
  if (ux < -0.38) c.left = true;
  if (ux > 0.38) c.right = true;
  c.boost = d > 4000;
  return c;
}

/** The scene: where every pilot starts, the AI around them, and what keeps the fight going */
export class Scene {
  readonly bots: Bot[] = [];
  num = 0;
  bossId = -1;
  private hostiles: number[] = [];
  private anchors: { x: number; y: number }[] = [];
  private r = rng(0xc0ffee);
  constructor(readonly server: GameServer, readonly layout: Layout, readonly n: number) {}

  /** `pids` are the connected pilots in order; `probeIdx` marks which of them are full fake clients */
  setup(pids: number[], probeIdx: Set<number>): void {
    const s = this.server, ships = s.getShips(), r = this.r;
    this.num = InSystem.systemId[pids[0]];
    const base = { x: Position.x[pids[0]], y: Position.y[pids[0]] };
    pids.forEach((pid, i) => {
      const ship = SHIP_POOL[Math.floor(r() * SHIP_POOL.length)];
      ships.respawnInPlace(pid, blueprint(s, ship));
      let x: number, y: number;
      if (this.layout === 'cruise') {
        const side = Math.ceil(Math.sqrt(this.n));
        x = base.x + ((i % side) - side / 2) * 12000 + (r() - 0.5) * 3000;
        y = base.y + (Math.floor(i / side) - side / 2) * 12000 + (r() - 0.5) * 3000;
      } else if (this.layout === 'spread') {
        // a square grid, 10 km apart, jittered
        const side = Math.ceil(Math.sqrt(this.n));
        x = base.x + ((i % side) - side / 2) * 10000 + (r() - 0.5) * 3000;
        y = base.y + (Math.floor(i / side) - side / 2) * 10000 + (r() - 0.5) * 3000;
      } else if (this.layout === 'ball') {
        const a = r() * Math.PI * 2, d = Math.sqrt(r()) * 5000;
        x = base.x + Math.cos(a) * d; y = base.y + Math.sin(a) * d;
      } else {
        const a = (i / this.n) * Math.PI * 2, d = 1500 + r() * 400;
        x = base.x + Math.cos(a) * d; y = base.y + Math.sin(a) * d;
      }
      Position.x[pid] = x; Position.y[pid] = y; Velocity.x[pid] = 0; Velocity.y[pid] = 0;
      const la = r() * Math.PI * 2;
      this.bots.push({ index: i, pid, ship, home: { x, y }, target: -1, probe: probeIdx.has(i), ...(this.layout === 'cruise' ? { leg: { x: x + Math.cos(la) * 24000, y: y + Math.sin(la) * 24000, out: true } } : {}) });
    });
    if (this.layout === 'boss') {
      this.bossId = s.bosses.spawnAt('boss_scrap_mother', this.num, base.x, base.y);
    } else {
      // an AI pack for every few pilots (spread: beside a pilot; ball: around the ball)
      const packs = this.layout === 'cruise' ? 2 : Math.max(2, Math.min(40, Math.round(this.n / 4)));
      for (let k = 0; k < packs; k++) {
        const b = this.bots[Math.floor((k / packs) * this.n)];
        const a = r() * Math.PI * 2;
        this.anchors.push(this.layout !== 'ball' ? { x: b.home.x + Math.cos(a) * 1800, y: b.home.y + Math.sin(a) * 1800 } : { x: base.x + Math.cos(a) * 3500, y: base.y + Math.sin(a) * 3500 });
      }
      for (const a of this.anchors) this.spawn(a);
    }
    void ships;
  }

  private spawn(at: { x: number; y: number }): void {
    const kinds = this.r() < 0.5 ? ['pirate_raider', 'pirate_skiff', 'pirate_skiff'] : ['pirate_raider', 'pirate_skiff'];
    this.server.enemies.spawnPack(this.num, { faction: 'pirates', ships: kinds } as never, at.x, at.y);
  }

  /** Once a tick: keep the fight going, refresh the hostiles list, pick targets, let `fly` give each bot its controls */
  tick(now: number, fly: (b: Bot) => void): void {
    const s = this.server, ships = s.getShips();
    if (now % 30 === 0) {
      this.hostiles = [];
      for (const [eid] of ships.bodies) if (InSystem.systemId[eid] === this.num && (s.enemies.factionOf(eid) || eid === this.bossId)) this.hostiles.push(eid);
    }
    if (this.layout !== 'boss' && now % 120 === 0 && this.anchors.length) {
      // (topped up to two ships an anchor, at most two packs at a time)
      const want = this.anchors.length * 2;
      for (let k = 0, have = s.enemies.count(this.num); k < 2 && have < want; k++, have += 2.5) this.spawn(this.anchors[Math.floor(this.r() * this.anchors.length)]);
    }
    for (const b of this.bots) {
      if ((now + b.index) % 10 === 0 || !ships.has(b.target)) b.target = this.nearest(b.pid);
      fly(b);
    }
  }

  /** A bot's controls this tick (fighting its target, or cruising its leg) */
  controls(b: Bot): Ctl {
    const l = b.leg;
    if (!l) return controlsFor(b.pid, b.target, (t) => this.server.getShips().has(t));
    const tx = l.out ? l.x : b.home.x, ty = l.out ? l.y : b.home.y;
    if (Math.hypot(tx - Position.x[b.pid], ty - Position.y[b.pid]) < 1500) l.out = !l.out;
    return cruiseControls(b.pid, l.out ? l.x : b.home.x, l.out ? l.y : b.home.y);
  }

  private nearest(p: number): number {
    let best = -1, bd = 6000 * 6000;
    for (const h of this.hostiles) {
      const dx = Position.x[h] - Position.x[p], dy = Position.y[h] - Position.y[p], d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = h; }
    }
    return best;
  }
}
