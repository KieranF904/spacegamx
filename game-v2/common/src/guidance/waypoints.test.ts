/**
 * The waypoint law (waypoints.ts) and its records (records.ts): a shell flown from the server's records ("sent") is
 * the shell the planner flies ("derived"), tick for tick, whichever way it switches between them; a SYNC carries it
 * exactly; it hits a weaving target as the old per-tick law did.
 */
import { describe, it, expect } from 'vitest';
import {
  guideKind, newGuide, guideTick, guideAdvance, guidePlan, guideSteer, guideLost, cloneGuide, qGuide, spacing,
  PLAN_NONE, PLAN_WP, type Guide, type GuideBody,
} from './waypoints.js';
import { GUIDE, applyGuideRec, guideOfSync, guideSyncArgs, wpArgs } from './records.js';
import { dcos, dsin } from '../math/detTrig.js';

const KIND = guideKind(0.07, 0.9, 44);
const ID = 37;

/** A target weaving across, as it is at tick t */
const target = (t: number): GuideBody => ({ x: 4000 + t * 6, y: 600 * dsin(t / 40), vx: 6, vy: (600 / 40) * dcos(t / 40) });

/** The server's flight: its states by tick and the records its planner made */
function serverFlight(ticks: number, lostAt = Infinity) {
  const g = newGuide(5, KIND), m = { x: qGuide(10.3), y: qGuide(-4.7), vx: qGuide(14), vy: qGuide(2.2) };
  const states = new Map<number, GuideBody>(), recs = new Map<number, number[][]>(), guides = new Map<number, Guide>();
  for (let t = 1; t <= ticks; t++) {
    const r: number[][] = [];
    if (t === lostAt) { guideLost(g); r.push([GUIDE.LOST]); }
    const did = guideTick(g, ID, m, g.target >= 0 ? target(t) : null, t);
    if (did !== PLAN_NONE) r.push([did === PLAN_WP ? GUIDE.WP : GUIDE.NEXT, ...wpArgs(did === PLAN_WP ? g.w! : g.n!, m)]);
    if (r.length) recs.set(t, r);
    m.x += m.vx; m.y += m.vy;
    states.set(t, { ...m });
    guides.set(t, cloneGuide(g));
  }
  return { states, recs, guides };
}

/** A client's flight from tick `from` (a SYNC of the server's as `from` ended), in `mode(t)`: sent records or derived */
function clientFlight(s: ReturnType<typeof serverFlight>, from: number, ticks: number, mode: (t: number) => 'sent' | 'derived') {
  const sync = guideOfSync(guideSyncArgs(s.states.get(from)!, s.guides.get(from)!, false, from), from);
  const { m, g } = sync;
  let off = 0;
  for (let t = from + 1; t <= ticks; t++) {
    const r = s.recs.get(t) ?? [];
    for (const x of r) if (x[0] === GUIDE.LOST) applyGuideRec(g, x[0], x.slice(1), m, t);
    guideAdvance(g, t);
    if (mode(t) === 'sent') { for (const x of r) if (x[0] !== GUIDE.LOST) applyGuideRec(g, x[0], x.slice(1), m, t); }
    else guidePlan(g, ID, m, g.target >= 0 ? target(t) : null, t);
    guideSteer(g, m);
    m.x += m.vx; m.y += m.vy;
    const want = s.states.get(t)!;
    if (m.x !== want.x || m.y !== want.y || m.vx !== want.vx || m.vy !== want.vy) off++;
  }
  return off;
}

describe('the waypoint law', () => {
  it('sent and derived fly the same shell, and a switch between them changes nothing', () => {
    const s = serverFlight(400);
    expect(clientFlight(s, 0 + 1, 400, () => 'derived')).toBe(0);
    expect(clientFlight(s, 1, 400, () => 'sent')).toBe(0);
    // (switching every 7 ticks, and from a SYNC in the middle of a waypoint)
    expect(clientFlight(s, 1, 400, (t) => (Math.floor(t / 7) % 2 ? 'sent' : 'derived'))).toBe(0);
    expect(clientFlight(s, 133, 400, (t) => (t < 250 ? 'sent' : 'derived'))).toBe(0);
  });

  it('a lost target: it flies straight on, the same both ways', () => {
    const s = serverFlight(300, 150);
    expect(clientFlight(s, 1, 300, () => 'derived')).toBe(0);
    expect(clientFlight(s, 1, 300, () => 'sent')).toBe(0);
    const a = s.states.get(200)!, b = s.states.get(201)!;
    expect(Math.atan2(b.vy, b.vx)).toBeCloseTo(Math.atan2(a.vy, a.vx), 3);
  });

  it('its state stays on the 1/256 grid, so a SYNC carries it exactly', () => {
    const s = serverFlight(200);
    for (const m of s.states.values()) for (const v of [m.x, m.y, m.vx, m.vy]) expect(Number.isInteger(v * 256)).toBe(true);
  });

  it('few records: a waypoint every 4 to 48 ticks by the time to the target, a swerve now and then', () => {
    const s = serverFlight(300);
    const n = [...s.recs.values()].reduce((a, r) => a + r.length, 0);
    expect(n).toBeGreaterThan(5);
    expect(n).toBeLessThan(300 / 4);
    expect([spacing(500), spacing(150), spacing(60), spacing(30), spacing(5)]).toEqual([48, 32, 16, 8, 4]);
  });

  it('it closes on a weaving target', () => {
    const s = serverFlight(400);
    let best = Infinity;
    for (const [t, m] of s.states) { const tg = target(t); best = Math.min(best, Math.hypot(tg.x - m.x, tg.y - m.y)); }
    expect(best).toBeLessThan(40);
  });
});
