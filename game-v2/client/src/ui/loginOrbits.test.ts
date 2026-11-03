import { describe, expect, it } from 'vitest';
import type { StarSystemData } from '@space-game/common';
import systemsData from '../../../data/systems.json';
import { weightOf, solBodies } from './loginBody';
import { LOGIN_ORBITS, offScreen, pathAngle, pathPoint, pathThrough, pathWindow, pickFloater, startSpots, type OrbitView } from './loginOrbits';

const sol = (systemsData as { systems: StarSystemData[] }).systems.find((s) => s.id === 'sol');
const ids = solBodies(sol);

/** The sign-in screen's view of its central body, as LoginUI lays it out */
const view = (w: number, h: number): OrbitView => {
  const R = w / (4 * Math.sqrt(0.25 * 0.75));
  return { cx: w / 2, cy: h + 0.5 * R, R, w, h };
};
const SIZES = [[1280, 800], [1920, 1080], [2560, 1000], [800, 1000], [390, 800]];

describe('the sign-in screen orbits', () => {
  it('each body runs on an ellipse through the spot it was always drawn at', () => {
    for (const [w, h] of SIZES) for (const side of [-1, 1]) for (const moon of [false, true]) {
      const v = view(w, h), spots = startSpots(side, w, h, moon);
      for (const [spot, lift] of [[spots.sun, LOGIN_ORBITS.lift.sun], [spots.body, LOGIN_ORBITS.lift.body]] as const) {
        const path = pathThrough(spot.x, spot.y, v, lift * h);
        const p = pathPoint(path, v, pathAngle(path, spot.x, spot.y, v));
        expect(p.x).toBeCloseTo(spot.x, 3);
        expect(p.y).toBeCloseTo(spot.y, 3);
        // (and its apex is above the spot, never off the top of the screen)
        expect(v.cy - path.b).toBeLessThan(spot.y);
        expect(v.cy - path.b).toBeGreaterThan(-spot.r);
      }
    }
  });

  it("their sizes are what they were: a moon is 0.026, a planet beside a moon 0.05 of min(w, 1.6 h)", () => {
    const s = startSpots(1, 1280, 800, false), m = startSpots(1, 1280, 800, true);
    expect(s.body.r).toBeCloseTo(0.026 * 1280, 5);
    expect(m.body.r).toBeCloseTo(0.05 * 1280, 5);
    expect(s.sun.r).toBeCloseTo(0.06 * 1280, 5);
  });

  it('the star moves in from its corner and across the sky; the small body goes the other way out; both enter at the star\'s side', () => {
    for (const [w, h] of SIZES) for (const side of [-1, 1]) {
      const v = view(w, h), spots = startSpots(side, w, h, false);
      for (const spot of [spots.sun, spots.body]) {
        const path = pathThrough(spot.x, spot.y, v, 0.04 * h);
        const win = pathWindow(path, v, spot.r, side);
        const a = pathPoint(path, v, win.enter), b = pathPoint(path, v, win.exit);
        // enters on the star's side, leaves on the other
        expect(Math.sign(a.x - v.cx), `${w}x${h}`).toBe(side);
        expect(Math.sign(b.x - v.cx), `${w}x${h}`).toBe(-side);
        expect(offScreen(a.x, a.y, spot.r, v)).toBe(true);
        expect(offScreen(b.x, b.y, spot.r, v)).toBe(true);
        // it moves as the angle goes by side
        const t0 = pathAngle(path, spot.x, spot.y, v);
        expect((win.enter - t0) * (win.exit - t0), 'starts between the two').toBeLessThan(0);
      }
    }
  });

  it('crossings take minutes: 5 to 30 for the star from its corner, 1 to 15 for the small body from its place', () => {
    const w = 1280, h = 800, v = view(w, h);
    const omega = (2 * Math.PI) / LOGIN_ORBITS.period;
    const spots = startSpots(-1, w, h, false);
    const secsToLeave = (spot: { x: number; y: number; r: number }, lift: number) => {
      const path = pathThrough(spot.x, spot.y, v, lift * h);
      const win = pathWindow(path, v, spot.r, -1);
      return Math.abs(win.exit - pathAngle(path, spot.x, spot.y, v)) / omega;
    };
    const sun = secsToLeave(spots.sun, LOGIN_ORBITS.lift.sun) / 60, body = secsToLeave(spots.body, LOGIN_ORBITS.lift.body) / 60;
    expect(sun).toBeGreaterThan(5);
    expect(sun).toBeLessThan(30);
    expect(body).toBeGreaterThan(1);
    expect(body).toBeLessThan(15);
  });

  it('picks a different Sol body each time: never the sun, the central one, or one just gone', () => {
    const taken = new Set(['jovan']);
    const recent = ['ares', 'vesta'];
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) {
      const id = pickFloater(ids, taken, recent, weightOf, rnd)!;
      expect(id).not.toBe('sun');
      expect(taken.has(id)).toBe(false);
      expect(recent.includes(id)).toBe(false);
      seen.add(id);
    }
    // everything else gets its turn
    expect(seen.size).toBe(ids.length - 1 - taken.size - recent.length);
  });

  it('falls back to a recent body if nothing else is free, and to null if nothing is', () => {
    const all = new Set(ids.filter((id) => id !== 'sun' && id !== 'vesta'));
    expect(pickFloater(ids, all, ['vesta'], weightOf)).toBe('vesta');
    expect(pickFloater(ids, new Set(ids), [], weightOf)).toBeNull();
  });
});
