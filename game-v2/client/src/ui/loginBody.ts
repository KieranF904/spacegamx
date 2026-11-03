/**
 * The sign-in screen's body (LoginUI's backdrop): each visit shows one of Sol's bodies (the sun, a planet or a moon, as
 * the game draws them) where the sun always was, at its size: centred below the screen, its top quarter showing.
 *
 * - The pick is weighted (LOGIN_WEIGHTS: the sun still about one visit in six; the showy worlds, Jovan with its rings,
 *   Terra Nova, Nereid, more often than the small rocks and moons) and never the same body twice running (the last one
 *   is kept in localStorage).
 * - A planet or moon is lit by Sol itself, drawn small, partly out of frame at a top corner (LoginUI draws it with the
 *   game's SunRenderer, where `update` says): so the cap shows a terminator and its night side, not a flat full disc, and
 *   the light comes from the star you see. The corner alternates with the pick.
 * - High in the other corner, small: one of its moons, or for a moon its planet (rings and all), lit by the same star.
 * - Those two, the star and the small body, orbit the central one together (loginOrbits.ts: the tuning and the
 *   geometry): the same angular speed, very slowly, each on its own ellipse through its old place. The central body's
 *   light follows the star (eased, so it never jumps). The small body, when it has left at the far edge, is replaced
 *   after a few seconds by another of Sol's coming in at the star's side, at the same size (never the central body, the
 *   sun, or any other on screen); the star itself, when it has crossed, comes back where it began. With reduced motion
 *   asked for they stand still, as they always did.
 * - Always at full detail (the fine level, whatever the quality tier: one body on an idle screen).
 * - It turns as the game turns it (its own spin, a gas giant's jets), from a moment picked per visit.
 * - Nothing shows until its program is compiled (shaderWarmup) and the planets' noise is in; then it fades in.
 */
import { Container, type GlProgram } from 'pixi.js';
import type { PlanetData, StarSystemData } from '@space-game/common';
import { planetBody, moonBody, hashId } from '../rendering/PlanetRenderer';
import { planetQuad, planetProgram } from '../rendering/planet-proto/planetQuad';
import { planetTexturesReady } from '../rendering/planet-proto/planetTextures';
import type { ShaderQuad } from '../rendering/shaderQuad';
import { shaderReady } from '../rendering/shaderWarmup';
import { LOGIN_ORBITS, offScreen, pathAngle, pathPoint, pathThrough, pathWindow, pickFloater, startSpots, type OrbitView } from './loginOrbits';

/** A body of Sol: 'sun', a planet's id, or `<planet>.moon<i>` */
export type LoginBodyId = string;

/** How often each is shown (relative). Anything not listed: a planet 1, a moon 0.4 */
export const LOGIN_WEIGHTS: Record<string, number> = {
  sun: 3, jovan: 2.5, terra_nova: 2, nereid: 2, ares: 1.5, thule: 1.2, vesta: 1, greyback: 0.8, 'terra_nova.moon0': 0.6,
};
export const weightOf = (id: string) => LOGIN_WEIGHTS[id] ?? (id.includes('.moon') ? 0.4 : 1);

/** Every body Sol has, sun first */
export function solBodies(sol: StarSystemData | undefined): LoginBodyId[] {
  const out = ['sun'];
  for (const p of sol?.planets ?? []) {
    out.push(p.id);
    (p.moons ?? []).forEach((_, i) => out.push(`${p.id}.moon${i}`));
  }
  return out;
}

/** A weighted pick, never `last` (unless it's all there is) */
export function pickLoginBody(ids: LoginBodyId[], last: LoginBodyId | null, rnd: () => number = Math.random): LoginBodyId {
  const pool = ids.length > 1 ? ids.filter((id) => id !== last) : ids;
  const total = pool.reduce((s, id) => s + weightOf(id), 0);
  let r = rnd() * total;
  for (const id of pool) if ((r -= weightOf(id)) < 0) return id;
  return pool[pool.length - 1];
}

const LAST_KEY = 'sg.loginBody';
/** This visit's body (and remembered as the last, so the next visit shows another) */
export function loginBodyForVisit(sol: StarSystemData | undefined): LoginBodyId {
  // (dev: ?loginBody=<id> shows that one)
  if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV && typeof location !== 'undefined') {
    const asked = new URLSearchParams(location.search).get('loginBody');
    if (asked && solBodies(sol).includes(asked)) return asked;
  }
  let last: string | null = null;
  try { last = localStorage.getItem(LAST_KEY); } catch { /* (no storage: any pick) */ }
  const id = pickLoginBody(solBodies(sol), last);
  try { localStorage.setItem(LAST_KEY, id); } catch { /* ignore */ }
  return id;
}

interface Shown { quad: ShaderQuad; container: Container }

/** The star as the sign-in screen draws it: a spot and radius in screen px (the game's SunRenderer draws it there) */
export interface SunSpot { x: number; y: number; r: number }

/** Dev only: ?orbitSpeed=<n> runs the orbits n times faster (to watch a swap without waiting an hour) */
function orbitSpeed(): number {
  if (!(import.meta as { env?: { DEV?: boolean } }).env?.DEV || typeof location === 'undefined') return 1;
  const n = Number(new URLSearchParams(location.search).get('orbitSpeed'));
  return n > 0 && n <= 200 ? n : 1;
}

const reducedMotion = (): boolean => {
  try { return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
};

export class LoginBody {
  readonly container = new Container();
  private main: Shown;
  /** The small body: what's on it (built a frame after it was chosen, parked off screen till its turn: no hitch when it
   *  comes in), where it is on its ellipse (NaN: not placed yet) and whether it is on screen or waiting off it */
  private small: { id: string | null; shown: Shown | null; ringed: boolean; theta: number; active: boolean; wait: number; x: number; y: number; r: number } | null = null;
  /** The star's angle on its ellipse (NaN: not placed yet) and place */
  private sun = { theta: NaN, x: 0, y: 0, r: 0 };
  /** Where the central body and the small one are lit from: eased toward the star, so a star coming back at its corner
   *  swings the light round gently */
  private light: { x: number; y: number } | null = null;
  /** The ones that left lately (not brought straight back) */
  private recent: string[] = [];
  private time: number;
  private fade = 0;
  private readonly still = reducedMotion();
  private readonly speed = orbitSpeed();
  /** Whether the central body is a moon (its small companion is then a planet, and bigger) */
  private readonly aroundMoon: boolean;
  /** -1: the star up and to the left, 1: to the right */
  readonly side: number;

  constructor(readonly id: LoginBodyId, private sol: StarSystemData | undefined) {
    const { planet, moon } = this.parse(id);
    this.side = hashId(id) % 2 ? 1 : -1;
    this.aroundMoon = moon >= 0;
    // (a moment of its turning, per visit)
    this.time = 40 + Math.random() * 600;
    this.main = this.shown(id, this.container);
    // The small body to begin with, as ever: one of the planet's moons (the largest) or, for a moon, its planet
    const moons = planet.moons ?? [];
    const first = moon >= 0 ? planet.id
      : moons.length ? `${planet.id}.moon${moons.reduce((b, m, k) => (m.radius > moons[b].radius ? k : b), 0)}`
      : LOGIN_ORBITS.floaterWithoutMoon ? pickFloater(solBodies(sol), new Set([id]), [], weightOf) : null;
    if (first) {
      this.small = { id: first, shown: null, ringed: false, theta: NaN, active: true, wait: 0, x: 0, y: 0, r: 0 };
      this.build();
    }
    this.container.alpha = 0;
  }

  private parse(id: LoginBodyId): { planet: PlanetData; moon: number } {
    const [pid, moonPart] = id.split('.moon');
    const planet = (this.sol?.planets ?? []).find((p) => p.id === pid) as PlanetData;
    return { planet, moon: moonPart === undefined ? -1 : Number(moonPart) };
  }

  /** A body's quad, in `parent` (parked off screen) */
  private shown(id: LoginBodyId, parent: Container): Shown {
    const { planet, moon } = this.parse(id);
    const seed = hashId(planet.id) + (moon < 0 ? 0 : moon * 13);
    const body = moon < 0 ? planetBody(planet) : moonBody(planet, moon);
    const extent = Math.max(1.3, body.rings?.outer ?? 0);
    const quad = planetQuad(body, seed, 1, extent, 'fine');
    const container = new Container();
    container.addChild(quad.mesh);
    parent.addChild(container);
    const light = quad.u.uniforms.uLight as Float32Array;
    light[0] = 0;
    light[1] = -1;
    // (drawn from the start, parked: its buffers are up before its turn)
    container.position.set(-1e5, -1e5);
    return { quad, container };
  }

  /** Make the small body's quad (over the central body, under the star's own drawing) */
  private build(): void {
    const s = this.small;
    if (!s?.id) return;
    const { planet, moon } = this.parse(s.id);
    s.ringed = moon < 0 && !!planet.rings;
    s.shown = this.shown(s.id, this.container);
  }

  /** The programs it waits for (compiled ahead by the warm-up, which finds them under the sign-in screen) */
  programs(): GlProgram[] {
    return [planetProgram('fine')];
  }

  /** Whether it can draw without a hitch: its program compiled and the planets' noise in */
  ready(): boolean {
    return this.programs().every(shaderReady) && planetTexturesReady();
  }

  /** The small body now on screen (for tests and the dev console) */
  floating(): string | null {
    return this.small?.active ? this.small.id : null;
  }

  /** The small body has left: its body is freed, and another of Sol's is picked to come in at the star's side after a pause */
  private retire(): void {
    const s = this.small!;
    if (s.id) {
      this.recent.push(s.id);
      if (this.recent.length > LOGIN_ORBITS.recent) this.recent.shift();
    }
    s.shown?.container.destroy({ children: true });
    s.shown = null;
    s.id = pickFloater(solBodies(this.sol), new Set([this.id]), this.recent, weightOf);
    s.active = false;
    s.theta = NaN;
    const [lo, hi] = LOGIN_ORBITS.gap;
    s.wait = lo + Math.random() * (hi - lo);
  }

  /**
   * Each frame: the central body centred on (cx, cy), radius r px; w, h the screen. Returns where the star is to be drawn
   * (also before the body shows itself).
   *
   * Positions are left at their exact sub-pixel values on purpose: the bodies' shaders draw fine detail (a gas giant's
   * band edges and ringlets, the star's plasma) that is evaluated per pixel, so the picture glides smoothly at the orbit's
   * ~4 px a second; snapping to whole pixels made it slide a pixel at a time, about every quarter second (measured).
   */
  update(dt: number, cx: number, cy: number, r: number, w: number, h: number): SunSpot {
    const view: OrbitView = { cx, cy, R: r, w, h };
    const spots = startSpots(this.side, w, h, this.aroundMoon);
    // Each on its own ellipse through its old place (so a resize carries them along)
    const sunPath = pathThrough(spots.sun.x, spots.sun.y, view, LOGIN_ORBITS.lift.sun * h);
    const bodyPath = pathThrough(spots.body.x, spots.body.y, view, LOGIN_ORBITS.lift.body * h);
    const sun = this.sun;
    sun.r = spots.sun.r;
    if (Number.isNaN(sun.theta)) sun.theta = pathAngle(sunPath, spots.sun.x, spots.sun.y, view);
    let p = pathPoint(sunPath, view, sun.theta);
    sun.x = p.x;
    sun.y = p.y;
    if (!this.light) this.light = { x: sun.x, y: sun.y };
    const spot = (): SunSpot => ({ x: sun.x, y: sun.y, r: sun.r });

    const ready = this.ready();
    this.container.visible = ready;
    if (!ready) return spot();
    // (a mark for measuring: ms since the page opened, in performance.getEntriesByName('login-body-ready'))
    if (this.fade === 0) try { performance.mark('login-body-ready'); } catch { /* ignore */ }
    this.time += dt;
    this.fade = Math.min(1, this.fade + dt / 0.8);
    this.container.alpha = this.fade * this.fade * (3 - 2 * this.fade);

    // The orbit: the same angle a second for both, the star moving in from its corner and the small body away from it
    const step = Math.min(dt, LOGIN_ORBITS.maxDt) * this.speed;
    const dTheta = this.side * (2 * Math.PI / LOGIN_ORBITS.period) * step;
    const leaving = (x: number, y: number, rr: number) => offScreen(x, y, rr, view) && Math.sign(x - cx) === -this.side;
    if (!this.still) {
      sun.theta += dTheta;
      p = pathPoint(sunPath, view, sun.theta);
      sun.x = p.x;
      sun.y = p.y;
      // Across and gone: it comes back where it began (the star stays the star, the one light)
      if (leaving(sun.x, sun.y, sun.r)) {
        sun.theta = pathWindow(sunPath, view, sun.r, this.side).enter;
        p = pathPoint(sunPath, view, sun.theta);
        sun.x = p.x;
        sun.y = p.y;
      }
    }
    const L = this.light!;
    const k = 1 - Math.exp(-3 * step / LOGIN_ORBITS.lightGlide);
    L.x += (sun.x - L.x) * k;
    L.y += (sun.y - L.y) * k;

    const place = (s: Shown, x: number, y: number, radius: number) => {
      s.container.position.set(x, y);
      s.container.scale.set(radius);
      const u = s.quad.u.uniforms;
      u.uTime = this.time;
      const light = u.uLight as Float32Array, d = Math.hypot(L.x - x, L.y - y) || 1;
      light[0] = (L.x - x) / d;
      light[1] = (L.y - y) / d;
    };
    place(this.main, cx, cy, r);

    const s = this.small;
    if (!s?.id) return spot();
    if (!s.shown) { this.build(); if (!s.shown) return spot(); }
    s.r = spots.body.r * (s.ringed ? LOGIN_ORBITS.ringedScale : 1);
    if (!s.active) {
      // Parked off screen, so its buffers are up; it comes in when its pause is over and the star is clear of its way in
      place(s.shown, -1e5, -1e5, s.r);
      s.wait -= step;
      if (s.wait > 0) return spot();
      const win = pathWindow(bodyPath, view, s.r, this.side);
      const q = pathPoint(bodyPath, view, win.enter);
      if (Math.hypot(sun.x - q.x, sun.y - q.y) < (s.r + sun.r) * LOGIN_ORBITS.entryClear) { s.wait = 1; return spot(); }
      s.theta = win.enter;
      s.active = true;
    } else if (Number.isNaN(s.theta)) {
      s.theta = pathAngle(bodyPath, spots.body.x, spots.body.y, view);
    } else if (!this.still) {
      s.theta += dTheta;
    }
    p = pathPoint(bodyPath, view, s.theta);
    s.x = p.x;
    s.y = p.y;
    place(s.shown, p.x, p.y, s.r);
    if (!this.still && leaving(p.x, p.y, s.r)) this.retire();
    return spot();
  }

  destroy(): void {
    this.container.destroy({ children: true });
  }
}
