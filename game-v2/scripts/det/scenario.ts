/**
 * The cross-engine determinism scenario (npm run det:engines, scripts/det/engines.mjs): a seeded fight flown with the
 * game's real common code, hashed every tick. The same bundle runs in Node and in each browser engine; if the hashes
 * match tick for tick, those engines compute the same bits for flight and shells.
 *
 * What it runs (all from common/src, as the server and the client call it):
 * - six ships of different builds, each with seeded inputs changing every 10-40 ticks (screen-relative keys or the helm,
 *   boost, a jump), aiming (the 13-bit quantised aim the wire carries) at the next ship: stepShipPhysics with the real
 *   energy (drainRate 1, the guns' load), so flight, thrust, steering and power;
 * - their guns: stepGuns (turret and gimbal aim, firing models), volleyShells (spawn: spread, speed, the owner's
 *   velocity), shells moved a tick at a time, every third one steered at its target (weaponry steerToward);
 * - hits: a shell's segment against each other ship's parts in its grid frame (worldToLocalDir, castParts), the
 *   confirmed-hits rule a client applies (deriveShellHit), a rebuild when a part goes; against three spinning
 *   asteroids (getAsteroidPolygon, raycastPolygon); ships repaired every 400 ticks so the fight goes on.
 *
 * Plus a primitive check: detTrig's functions over seeded inputs, hashed, and the same for native Math (which is
 * allowed to differ between engines: informational, it shows what detTrig is for).
 *
 * No fs, no Node or DOM APIs: the data comes in as an argument (engines.mjs bundles it).
 */

import {
  loadCatalog, createShipState, rebuildShip, repairShip, stepShipPhysics, stepGuns, volleyShells, steerToward, castParts,
  blueprintGeometry, deriveShellHit, gunShell, worldToLocalDir, gunLoad, FULL_CHARGE, mulberry32, getAsteroidPolygon,
  raycastPolygon, asteroidSpin, replicaAngle, quantizeReplicaAngle, ReplicaMode, parseBlueprint,
  dsin, dcos, datan2, dhypot, dexp, dlog, dpow,
  type CatalogFiles, type ShipTuning, type ShipState, type FlightBody, type FlightControls, type Charge, type PlacedGeom,
  type HitCtx, type WeaponTuning,
} from '../../common/src/index.js';

export interface DetData {
  files: CatalogFiles;
  tuning: ShipTuning;
  /** Blueprint JSON text by file name */
  blueprints: Record<string, string>;
}

export interface DetResult {
  ticks: number;
  /** FNV-1a of the whole state after each tick, hex */
  hashes: string[];
  /** Counts, for a sanity look (shots fired, hits on ships and rocks, parts lost) */
  stats: Record<string, number>;
  /** detTrig's outputs over seeded inputs, hashed per function; and native Math's (informational) */
  prims: Record<string, string>;
  natives: Record<string, string>;
  ms: number;
}

export const SHIPS = ['corsair.json', 'hammerhead.json', 'lancer.json', 'arrow.json', 'bastion.json', 'sparrow-t.json'];

// ---- hashing: FNV-1a over a double's bits (-0 as 0), no allocation per value
const F = new Float64Array(1);
const W = new Uint32Array(F.buffer);
const LE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
let h = 0x811c9dc5;
function mixWord(w: number): void {
  for (let i = 0; i < 4; i++) { h ^= (w >>> (i * 8)) & 0xff; h = Math.imul(h, 0x01000193); }
}
function mix(v: number): void {
  F[0] = v === 0 ? 0 : v;
  mixWord(W[LE ? 0 : 1]); mixWord(W[LE ? 1 : 0]);
}
const hex = (v: number) => (v >>> 0).toString(16).padStart(8, '0');

interface Shell { id: number; owner: number; target: number; x: number; y: number; vx: number; vy: number; life: number; gun: number; homing: boolean }
interface Pilot { ship: ShipState; body: FlightBody; charge: Charge; keys: Partial<FlightControls>; until: number; aimJitter: number; firing: boolean; jumpAt: number }

const ROCKS = [{ id: 101, x: 0, y: 0, size: 70 }, { id: 202, x: 520, y: -380, size: 55 }, { id: 303, x: -480, y: 300, size: 90 }];

export function runScenario(data: DetData, ticks = 1200): DetResult {
  const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
  h = 0x811c9dc5;
  const { tuning } = data;
  const catalog = loadCatalog(data.files);
  const geoms = new Map<object, PlacedGeom[]>();
  const geometry = (s: ShipState) => { let g = geoms.get(s.blueprint); if (!g) geoms.set(s.blueprint, (g = blueprintGeometry(catalog, s.blueprint))); return g; };
  const ctx: HitCtx = { catalog, tuning, geometry };
  const rng = mulberry32(0x5eed);
  const stats: Record<string, number> = { shots: 0, shells: 0, shipHits: 0, rockHits: 0, partsLost: 0, rebuilds: 0, jumps: 0 };

  const pilots: Pilot[] = SHIPS.map((file, i) => {
    const ship = createShipState(catalog, tuning, i + 1, parseBlueprint(data.blueprints[file]), 0);
    const a = (i / SHIPS.length) * 2 * Math.PI;
    return {
      ship, body: { x: dcos(a) * 700, y: dsin(a) * 700, vx: 0, vy: 0, angle: a + Math.PI, angVel: 0, jump: 0, cargo: 0 },
      charge: FULL_CHARGE, keys: {}, until: 0, aimJitter: 0, firing: false, jumpAt: i === 2 ? 300 : i === 4 ? 700 : -1,
    };
  });
  const shells: Shell[] = [];
  let nextShell = 1;
  const hashes: string[] = [];

  for (let tick = 1; tick <= ticks; tick++) {
    // ---- pilots: new seeded inputs now and then, aim at the next ship
    for (let i = 0; i < pilots.length; i++) {
      const p = pilots[i];
      if (tick >= p.until) {
        const helm = i === 1 || i === 5;
        const r = rng();
        p.keys = helm
          ? { helm: true, forward: r < 0.6, backward: r > 0.9, left: rng() < 0.3, right: rng() < 0.3, strafeLeft: rng() < 0.2, strafeRight: rng() < 0.2, boost: rng() < 0.25 }
          : { forward: r < 0.4, backward: r > 0.85, left: rng() < 0.35, right: rng() < 0.35, boost: rng() < 0.3 };
        p.aimJitter = (rng() - 0.5) * 0.6;
        p.firing = rng() < 0.7;
        p.until = tick + 10 + Math.floor(rng() * 30);
      }
      const q = pilots[(i + 1) % pilots.length];
      const dx = q.body.x - p.body.x, dy = q.body.y - p.body.y;
      const aimRaw = datan2(dy, dx) + p.aimJitter;
      const controls: FlightControls = {
        forward: false, backward: false, left: false, right: false, boost: false, ...p.keys,
        targetAngle: replicaAngle(ReplicaMode.Player, quantizeReplicaAngle(aimRaw)),
        jump: p.jumpAt >= 0 && tick >= p.jumpAt && tick < p.jumpAt + 95, jumpDist: 900,
      };
      if (controls.jump && tick === p.jumpAt) stats.jumps++;
      const res = stepShipPhysics(p.body, controls, p.ship.derived, tuning, { charge: p.charge, drainRate: 1, load: gunLoad(p.ship, tick), tick });
      p.charge = res.charge;
      // ---- guns: what fires this tick, and its shells
      const pose = { x: p.body.x, y: p.body.y, angle: p.body.angle };
      const fire = stepGuns(p.ship, pose, { firing: p.firing, aimWorld: controls.targetAngle, aimDist: dhypot(dx, dy), energy: { charge: p.charge } }, tick, tuning);
      for (const s of fire.shots) {
        stats.shots++;
        const list = volleyShells(p.ship.id, p.ship, s.w, s.shot, { ...pose, vx: p.body.vx, vy: p.body.vy }, tick, tuning);
        for (const l of list) {
          const id = nextShell++;
          shells.push({ id, owner: i, target: (i + 1) % pilots.length, x: l.x, y: l.y, vx: l.vx, vy: l.vy, life: l.life, gun: s.w.part, homing: id % 3 === 0 });
          stats.shells++;
        }
      }
    }

    // ---- shells: steer, then test the tick's segment against ships and rocks, then move
    const steer = { x: 0, y: 0 };
    for (let k = shells.length - 1; k >= 0; k--) {
      const s = shells[k];
      if (s.homing) {
        const t = pilots[s.target].body, sp = dhypot(s.vx, s.vy) || 1;
        steerToward(s.x, s.y, s.vx, s.vy, t.x, t.y, 0.04, steer);
        s.vx = steer.x * sp; s.vy = steer.y * sp;
      }
      const x1 = s.x + s.vx, y1 = s.y + s.vy;
      let best = -1, bestT = 2, bestPart = -1;
      for (let j = 0; j < pilots.length; j++) {
        if (j === s.owner) continue;
        const q = pilots[j], d = q.ship.derived;
        // (the bounding circle first, then the parts in the ship's grid frame)
        const ex = x1 - q.body.x, ey = y1 - q.body.y;
        if (dhypot(s.x - q.body.x, s.y - q.body.y) > d.radius + 80 && dhypot(ex, ey) > d.radius + 80) continue;
        const cs = tuning.cellSize;
        const a = worldToLocalDir([s.x - q.body.x, s.y - q.body.y], q.body.angle);
        const b = worldToLocalDir([ex, ey], q.body.angle);
        const hit = castParts(geometry(q.ship), (n) => d.alive[n], a[0] / cs + d.com[0], a[1] / cs + d.com[1], b[0] / cs + d.com[0], b[1] / cs + d.com[1]);
        if (hit && hit.t < bestT) { best = j; bestT = hit.t; bestPart = hit.part; }
      }
      let rockT = 2;
      for (const r of ROCKS) {
        if (dhypot(x1 - r.x, y1 - r.y) > r.size + 60) continue;
        const t = raycastPolygon(s.x, s.y, x1, y1, getAsteroidPolygon(r.id, r.x, r.y, r.size, asteroidSpin(r.id, tick)));
        if (t !== null && t < rockT) rockT = t;
      }
      if (best >= 0 && bestT <= rockT) {
        const q = pilots[best], owner = pilots[s.owner].ship;
        const gun = gunShell(tuning, owner, s.gun);
        const hx = s.x + s.vx * bestT, hy = s.y + s.vy * bestT;
        const l = worldToLocalDir([hx - q.body.x, hy - q.body.y], q.body.angle);
        const at: [number, number] = [l[0] / tuning.cellSize + q.ship.derived.com[0], l[1] / tuning.cellSize + q.ship.derived.com[1]];
        const out = deriveShellHit({ ctx, ship: q.ship, struck: bestPart, kind: gun?.kind ?? 'cannon', def: gun?.def ?? ({} as WeaponTuning), grade: gun?.grade ?? 1, strength: gun?.strength ?? 1, passes: 0, at, tick });
        stats.shipHits++;
        mix(tick); mix(s.id); mix(best); mix(out.part); mix(out.dealt); mix(out.hpAfter); mix(hx); mix(hy);
        if (out.hpAfter <= 0 && out.part >= 0) stats.partsLost++;
        if (q.ship.dirty) { rebuildShip(q.ship, catalog, tuning); stats.rebuilds++; }
        shells.splice(k, 1);
        continue;
      }
      if (rockT <= 1) { stats.rockHits++; mix(rockT); shells.splice(k, 1); continue; }
      s.x = x1; s.y = y1;
      if (--s.life <= 0) shells.splice(k, 1);
    }

    // ---- repairs, so the fight goes on
    if (tick % 400 === 0) for (const p of pilots) { repairShip(p.ship); rebuildShip(p.ship, catalog, tuning); }

    // ---- the tick's hash: every body, charge and part's HP, every shell
    for (const p of pilots) {
      const b = p.body;
      mix(b.x); mix(b.y); mix(b.vx); mix(b.vy); mix(b.angle); mix(b.angVel); mix(b.jump ?? 0);
      for (const v of Object.values(p.charge)) if (typeof v === 'number') mix(v);
      for (const v of p.ship.hp) mix(v);
      for (const v of p.ship.aim) mix(v);
      mix(p.ship.shield);
    }
    mix(shells.length);
    for (const s of shells) { mix(s.x); mix(s.y); mix(s.vx); mix(s.vy); }
    hashes.push(hex(h));
  }

  return { ticks, hashes, stats, prims: primitives(false), natives: primitives(true), ms: typeof performance !== 'undefined' ? Math.round(performance.now() - t0) : 0 };
}

/** detTrig (or native Math) over seeded inputs, one hash per function */
function primitives(native: boolean): Record<string, string> {
  const fns: Record<string, (a: number, b: number) => number> = native
    ? { sin: (a) => Math.sin(a), cos: (a) => Math.cos(a), atan2: (a, b) => Math.atan2(a, b), hypot: (a, b) => Math.hypot(a, b), exp: (a) => Math.exp(a), log: (a) => Math.log(Math.abs(a)), pow: (a, b) => Math.pow(Math.abs(a), b * 0.1) }
    : { sin: (a) => dsin(a), cos: (a) => dcos(a), atan2: (a, b) => datan2(a, b), hypot: (a, b) => dhypot(a, b), exp: (a) => dexp(a), log: (a) => dlog(Math.abs(a)), pow: (a, b) => dpow(Math.abs(a), b * 0.1) };
  const out: Record<string, string> = {};
  for (const [name, fn] of Object.entries(fns)) {
    const r = mulberry32(0xd37);
    h = 0x811c9dc5;
    for (let i = 0; i < 100000; i++) {
      const a = (r() - 0.5) * (i % 3 === 0 ? 40 : 8), b = (r() - 0.5) * 40;
      mix(fn(a, b));
    }
    out[name] = hex(h);
  }
  h = 0x811c9dc5;
  return out;
}
