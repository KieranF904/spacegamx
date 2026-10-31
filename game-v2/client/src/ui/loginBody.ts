/**
 * The sign-in screen's body (LoginUI's backdrop): each visit shows one of Sol's bodies (the sun, a planet or a moon, as
 * the game draws them) where the sun always was, at its size: centred below the screen, its top quarter showing.
 *
 * - The pick is weighted (LOGIN_WEIGHTS: the sun still about one visit in six; the showy worlds, Jovan with its rings,
 *   Terra Nova, Nereid, more often than the small rocks and moons) and never the same body twice running (the last one
 *   is kept in localStorage).
 * - A planet or moon is lit by Sol itself, drawn small, partly out of frame at a top corner (sunSpot: LoginUI draws it
 *   with the game's SunRenderer): so the cap shows a terminator and its night side, not a flat full disc, and the light
 *   comes from the star you see. The corner alternates with the pick.
 * - High in the other corner, small: one of its moons, or for a moon its planet (rings and all), lit by the same star.
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

/** A body of Sol: 'sun', a planet's id, or `<planet>.moon<i>` */
export type LoginBodyId = string;

/** How often each is shown (relative). Anything not listed: a planet 1, a moon 0.4 */
export const LOGIN_WEIGHTS: Record<string, number> = {
  sun: 3, jovan: 2.5, terra_nova: 2, nereid: 2, ares: 1.5, thule: 1.2, vesta: 1, greyback: 0.8, 'terra_nova.moon0': 0.6,
};
const weightOf = (id: string) => LOGIN_WEIGHTS[id] ?? (id.includes('.moon') ? 0.4 : 1);

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

/**
 * Where Sol is drawn while a planet or moon is shown: its centre (screen px) and disc radius, partly out of frame at a top
 * corner (side -1: left, 1: right). The planets' light is nearly edge-on (planetProto: l3 = (L, 0.22)) toward it, so
 * the lit side faces it and the terminator crosses the cap.
 */
export function sunSpot(side: number, w: number, h: number): { x: number; y: number; r: number } {
  const r = Math.max(28, Math.min(w, h * 1.6) * 0.06);
  return { x: w / 2 + side * (w / 2 - r * 0.15), y: h * 0.17, r };
}

interface Shown { quad: ShaderQuad; container: Container; spin0: number }

export class LoginBody {
  readonly container = new Container();
  private main: Shown;
  private back: Shown | null = null;
  private time: number;
  private fade = 0;
  /** -1: the star up and to the left, 1: to the right */
  readonly side: number;

  constructor(readonly id: LoginBodyId, sol: StarSystemData | undefined) {
    const [pid, moonPart] = id.split('.moon');
    const planet = (sol?.planets ?? []).find((p) => p.id === pid) as PlanetData;
    const moon = moonPart === undefined ? -1 : Number(moonPart);
    const seed = hashId(planet.id);
    this.side = hashId(id) % 2 ? 1 : -1;
    // (a moment of its turning, per visit)
    this.time = 40 + Math.random() * 600;
    if (moon < 0) {
      this.main = this.shown(planetBody(planet), seed);
      // one of its moons small in the background (the largest)
      const moons = planet.moons ?? [];
      if (moons.length) {
        const i = moons.reduce((b, m, k) => (m.radius > moons[b].radius ? k : b), 0);
        this.back = this.shown(moonBody(planet, i), seed + i * 13);
      }
    } else {
      this.main = this.shown(moonBody(planet, moon), seed + moon * 13);
      // its planet, far behind
      this.back = this.shown(planetBody(planet), seed);
    }
    this.container.alpha = 0;
  }

  private shown(body: ReturnType<typeof planetBody>, seed: number): Shown {
    const extent = Math.max(1.3, body.rings?.outer ?? 0);
    const quad = planetQuad(body, seed, 1, extent, 'fine');
    const container = new Container();
    container.addChild(quad.mesh);
    // (the background one first: under the main body)
    this.container.addChildAt(container, 0);
    const light = quad.u.uniforms.uLight as Float32Array;
    light[0] = 0;
    light[1] = -1;
    return { quad, container, spin0: 0 };
  }

  /** The programs it waits for (compiled ahead by the warm-up, which finds them under the sign-in screen) */
  programs(): GlProgram[] {
    return [planetProgram('fine')];
  }

  /** Whether it can draw without a hitch: its program compiled and the planets' noise in */
  ready(): boolean {
    return this.programs().every(shaderReady) && planetTexturesReady();
  }

  /** Each frame: centred on (cx, cy), radius r px; w, h the screen; (sx, sy) where the star is */
  update(dt: number, cx: number, cy: number, r: number, w: number, h: number, sx: number, sy: number): void {
    const ready = this.ready();
    this.container.visible = ready;
    if (!ready) return;
    this.time += dt;
    this.fade = Math.min(1, this.fade + dt / 0.8);
    this.container.alpha = this.fade * this.fade * (3 - 2 * this.fade);
    const place = (s: Shown, x: number, y: number, radius: number) => {
      s.container.position.set(x, y);
      s.container.scale.set(radius);
      const u = s.quad.u.uniforms;
      u.uTime = this.time;
      const light = u.uLight as Float32Array, d = Math.hypot(sx - x, sy - y) || 1;
      light[0] = (sx - x) / d;
      light[1] = (sy - y) / d;
    };
    place(this.main, cx, cy, r);
    if (this.back) {
      // High in the other corner, small: a moon about a twentieth of the screen across, a planet a tenth
      const small = this.id.includes('.moon') ? 0.05 : 0.026;
      const br = Math.max(10, Math.min(w, h * 1.6) * small);
      place(this.back, w / 2 - this.side * w * (this.id.includes('.moon') ? 0.4 : 0.36), h * 0.2, br);
    }
  }

  destroy(): void {
    this.container.destroy({ children: true });
  }
}
