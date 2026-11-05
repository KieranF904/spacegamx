/**
 * The autopilot's routes (routePlan.ts): round the star, planets and hostile
 * packs; by a lodestone only when that's quicker; jumps that never land you
 * anywhere bad; and times that match the drive (the jump bench's numbers).
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_JUMP, jumpTuning, type ShipTuning, type StarSystemData } from '@space-game/common';
import tuningJson from '../../../data/ships/tuning.json';
import systemsData from '../../../data/systems.json';
import {
  planRoute, routeTime, systemObstacles, segmentClear, insideAny, starBerth,
  type PlanShip, type XY, type Obstacle, type SeenHostile,
} from './routePlan';

const jt = jumpTuning(tuningJson as unknown as ShipTuning);
const SOL = (systemsData as { systems: StarSystemData[] }).systems.find((s) => s.id === 'sol')!;
/** Open space: nothing in it but what a test puts there */
const empty = (extra: Partial<StarSystemData> = {}) => ({ id: 'test', centralBody: { type: 'none' }, planets: [], nests: [], lodestones: [], regions: [], ...extra }) as unknown as StarSystemData;

// The starter (sparrow-t): boosted top speed 48.1, so it averages about 36; its drive (the core's coil, about right for it) reaches 51083, cools in 14.6 s
const sparrow = (cool = 0): PlanShip => ({ vFly: 36, drive: { jt, range: 51083, cooldown: 875, cool, primed: 0 } });
const flyer: PlanShip = { vFly: 36, drive: null };

const length = (from: XY, pts: XY[]) => pts.reduce((s, p, i) => s + Math.hypot(p.x - (i ? pts[i - 1] : from).x, p.y - (i ? pts[i - 1] : from).y), 0);
const clearAll = (from: XY, pts: XY[], obs: Obstacle[]) => pts.every((p, i) => segmentClear(i ? pts[i - 1] : from, p, obs));

describe('route planning', () => {
  it('goes round the sun to its far side, not through it', () => {
    const from = { x: -70000, y: 2000 }, to = { x: 70000, y: -1000 };
    const obstacles = systemObstacles(SOL, 0, [], []);
    expect(segmentClear(from, to, obstacles)).toBe(false);
    const plan = planRoute({ sys: SOL, tick: 0, from, to, ship: flyer, obstacles });
    expect(plan.points.length).toBeGreaterThan(1);
    expect(clearAll(from, plan.points, plan.obstacles)).toBe(true);
    // Never into the star's heat
    const sun = { x: 0, y: 0, r: SOL.centralBody!.radius! + 1500, kind: 'star' as const };
    expect(clearAll(from, plan.points, [sun])).toBe(true);
    // And no great detour: within a fifth of the way round it
    expect(length(from, plan.points)).toBeLessThan(Math.hypot(to.x - from.x, to.y - from.y) * 1.2);
  });

  it('gives a hostile pack a wide berth, a calm one less, and plans in a few ms', () => {
    const from = { x: 0, y: 0 }, to = { x: 40000, y: 0 };
    const pack: SeenHostile[] = [{ x: 20000, y: 300, rank: 0, calm: false }, { x: 20800, y: -400, rank: 0, calm: false }];
    const plan = planRoute({ sys: empty(), tick: 0, from, to, ship: flyer, obstacles: systemObstacles(empty(), 0, pack, []) });
    const closest = (pts: XY[], p: XY) => {
      let best = Infinity, a = from;
      for (const b of pts) {
        const dx = b.x - a.x, dy = b.y - a.y, t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
        best = Math.min(best, Math.hypot(a.x + dx * t - p.x, a.y + dy * t - p.y));
        a = b;
      }
      return best;
    };
    expect(closest(plan.points, pack[0])).toBeGreaterThan(3500);
    const calm = planRoute({ sys: empty(), tick: 0, from, to, ship: flyer, obstacles: systemObstacles(empty(), 0, pack.map((h) => ({ ...h, calm: true })), []) });
    expect(closest(calm.points, pack[0])).toBeGreaterThan(1200);
    expect(length(from, calm.points)).toBeLessThan(length(from, plan.points));
    // All of Sol, with a few packs about: cheap enough to plan every couple of seconds
    const t0 = performance.now();
    const packs: SeenHostile[] = [{ x: 100000, y: 20000, rank: 0, calm: false }, { x: -90000, y: 60000, rank: 2, calm: false }, { x: 30000, y: -130000, rank: 1, calm: false }];
    planRoute({ sys: SOL, tick: 0, from: { x: -150000, y: 30000 }, to: { x: 140000, y: -60000 }, ship: sparrow(), obstacles: systemObstacles(SOL, 0, packs, []) });
    expect(performance.now() - t0).toBeLessThan(60);
  });

  it('calls at a lodestone on the way when it makes the trip quicker, and not when it is a detour', () => {
    const from = { x: 0, y: 0 }, to = { x: 92000, y: 0 };
    const on = empty({ lodestones: [{ id: 'l', position: { x: 26000, y: 800 } }] });
    const viaOn = planRoute({ sys: on, tick: 0, from, to, ship: sparrow(), obstacles: [] });
    const direct = planRoute({ sys: on, tick: 0, from, to, ship: sparrow(), obstacles: [], noLodestones: true });
    expect(viaOn.lodestone).toBe(0);
    expect(viaOn.eta).toBeLessThan(direct.eta);
    // Out of the way: straight there
    const off = empty({ lodestones: [{ id: 'l', position: { x: 46000, y: 75000 } }] });
    expect(planRoute({ sys: off, tick: 0, from, to, ship: sparrow(), obstacles: [] }).lodestone).toBe(-1);
    // Without a drive there's nothing to gain
    expect(planRoute({ sys: on, tick: 0, from, to, ship: flyer, obstacles: [] }).lodestone).toBe(-1);
    // Camped by a nest out in a hostile band: never
    const camped = empty({
      lodestones: [{ id: 'l', position: { x: 26000, y: 800 } }],
      regions: [{ id: 'r', name: 'r', outer: 1e6, danger: 'hostile' }],
      nests: [{ id: 'n', name: 'n', faction: 'pirates', kind: 'den', orbit: { radius: 26500, phase: 0.1, period: 0 } }],
    } as Partial<StarSystemData>);
    expect(planRoute({ sys: camped, tick: 0, from, to, ship: sparrow(), obstacles: systemObstacles(camped, 0, [], []) }).lodestone).toBe(-1);
  });

  it('never calls at a dead or shattered stillstone, and values a scarred one at its weaker field', () => {
    const from = { x: 0, y: 0 }, to = { x: 92000, y: 0 };
    const at = (state?: 'scarred' | 'dead' | 'shattered') => empty({ lodestones: [{ id: 'l', position: { x: 26000, y: 800 }, ...(state ? { state } : {}) }] });
    for (const state of ['dead', 'shattered'] as const) expect(planRoute({ sys: at(state), tick: 0, from, to, ship: sparrow(), obstacles: [] }).lodestone).toBe(-1);
    // From cooling down, a whole one charges the drive faster than a scarred one
    const cooling = () => sparrow(875);
    const whole = planRoute({ sys: at(), tick: 0, from, to, ship: cooling(), obstacles: [] });
    const scarred = planRoute({ sys: at('scarred'), tick: 0, from, to, ship: cooling(), obstacles: [] });
    expect(whole.lodestone).toBe(0);
    if (scarred.lodestone >= 0) expect(scarred.eta).toBeGreaterThan(whole.eta);
    // The hold is off the stone, inside its field
    expect(whole.lodestoneHold).toBeGreaterThan(sparrow().drive!.jt.lodestoneSize);
  });

  it("calls at Sol's stillstones only when they're safe (the Wardens' is camped)", () => {
    const obstacles = systemObstacles(SOL, 0, [], []);
    const wardens = SOL.lodestones!.find((l) => l.id === 'sol_lodestone_wardens')!.position!;
    // Right past it, on the way out to the Reaches
    const plan = planRoute({ sys: SOL, tick: 0, from: { x: wardens.x + 30000, y: wardens.y + 30000 }, to: { x: wardens.x - 30000, y: wardens.y - 30000 }, ship: sparrow(), obstacles });
    for (const p of plan.lodestone >= 0 ? [plan.points[plan.lodestone]] : []) expect(Math.hypot(p.x - wardens.x, p.y - wardens.y)).toBeGreaterThan(2000);
  });

  it('never lands a jump in the star, on a planet or among hostiles', () => {
    const packs: SeenHostile[] = [{ x: 60000, y: 30000, rank: 0, calm: false }, { x: -40000, y: -70000, rank: 0, calm: false }];
    const obstacles = systemObstacles(SOL, 0, packs, []);
    const hazards = obstacles.filter((o) => o.kind !== 'station');
    let rng = 7;
    const rand = () => ((rng = (rng * 16807) % 2147483647) / 2147483647);
    let jumps = 0;
    for (let i = 0; i < 40; i++) {
      const pick = (): XY => { for (;;) { const a = rand() * Math.PI * 2, r = 25000 + rand() * 150000, p = { x: Math.cos(a) * r, y: Math.sin(a) * r }; if (!insideAny(p, obstacles)) return p; } };
      const from = pick(), to = pick();
      const plan = planRoute({ sys: SOL, tick: 0, from, to, ship: sparrow(), obstacles });
      for (const leg of plan.legs) {
        if (leg.mode !== 'jump') continue;
        jumps++;
        expect(insideAny(leg.to, hazards)).toBeNull();
        // Nor through them on the way
        expect(segmentClear(leg.from, leg.to, hazards.filter((o) => o.kind === 'star' || o.kind === 'planet'))).toBe(true);
      }
    }
    expect(jumps).toBeGreaterThan(20);
  });

  it("times trips as the jump bench measures them (the starter: fly, and jump)", () => {
    // jumpbench.mjs, sparrow-t: 50k flown 23.1 s; 20k / 50k / 100k / 150k jumping 3.8 / 3.8 / 21.4 / 27.9 s (since 2026-11-05 a
    // short jump charges longer, flight.ts jumpChargeNeed: 20k, in the taper, 7.7 s; 100k's last leg too, 25.9 s)
    const secs = (d: number, ship: PlanShip) => routeTime({ x: 0, y: 0 }, [{ x: d, y: 0 }], ship, undefined).eta / 60;
    const near = (got: number, want: number) => expect(Math.abs(got - want) / want).toBeLessThan(0.25);
    near(secs(50000, flyer), 23.1);
    near(secs(100000, flyer), 47.5);
    near(secs(20000, sparrow()), 7.7);
    near(secs(50000, sparrow()), 3.8);
    near(secs(100000, sparrow()), 25.9);
    near(secs(150000, sparrow()), 27.9);
    // Short hops aren't worth the spool
    expect(routeTime({ x: 0, y: 0 }, [{ x: 3000, y: 0 }], sparrow(), undefined).legs.map((l) => l.mode)).toEqual(['fly']);
    // ...nor a 10k one now a short jump charges about as long as flying it (flight.ts jumpChargeNeed)
    expect(routeTime({ x: 0, y: 0 }, [{ x: 10000, y: 0 }], sparrow(), undefined).legs.map((l) => l.mode)).toEqual(['fly']);
    // A drive still cooling down: fly till it's ready
    expect(routeTime({ x: 0, y: 0 }, [{ x: 50000, y: 0 }], sparrow(240), undefined).legs[0].mode).toBe('fly');
  });

  it("knows the star's berth: heat for suns, the pull for black holes", () => {
    expect(starBerth(SOL)).toBeGreaterThan(SOL.centralBody!.radius! + 1500);
    expect(starBerth({ centralBody: { type: 'none' } } as StarSystemData)).toBe(0);
    expect(DEFAULT_JUMP.minRange).toBeGreaterThan(0);
  });
});
