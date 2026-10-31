/**
 * Planets and moons: scenery on slow orbits (positions from the shared planetPosition(), driven by the server tick, so
 * everyone sees them in the same place). Each is one shader quad (planet-proto/planetQuad.ts: a lit sphere with each
 * kind's surface or cloud deck, an atmosphere with real thickness, rings with the planet's shadow; the look is data,
 * planet-proto/planetProto.ts, with a planet's own `look` from systems.json). The light comes from the system centre.
 * Drawn at the quality tier's detail (planetDetail); hidden until the planets' noise is in (planetTexturesReady).
 */

import { Container, Text, TextStyle } from 'pixi.js';
import { PlanetData, PlanetKind, planetPosition, moonOffset } from '@space-game/common';
import type { ShaderQuad } from './shaderQuad';
import { cameraView } from './cameraView';
import { planetQuad } from './planet-proto/planetQuad';
import { planetTexturesReady } from './planet-proto/planetTextures';
import type { BodyIn } from './planet-proto/planetProto';

const DEFAULT_HUE: Record<PlanetKind, number> = { rocky: 28, desert: 36, ice: 200, gas: 30, lava: 14, ocean: 210, toxic: 85 };

interface Body {
  quad: ShaderQuad;
  container: Container;
  radius: number;
}

function makeBody(body: BodyIn, radius: number, seed: number): Body {
  const extent = Math.max(1.3, body.rings?.outer ?? 0);
  const quad = planetQuad(body, seed, radius, extent);
  const container = new Container();
  container.addChild(quad.mesh);
  return { quad, container, radius: radius * extent };
}

/** A planet's body, and its moons' (rocky and ice in turn), as the game draws them: also the sign-in screen's */
export function planetBody(p: PlanetData): BodyIn {
  return { id: p.id, kind: p.kind, hue: p.hue ?? DEFAULT_HUE[p.kind], rings: p.rings, look: p.look };
}
export function moonBody(p: PlanetData, i: number): BodyIn {
  return { id: `${p.id}.moon${i}`, kind: i % 2 ? 'ice' : 'rocky', hue: 30 + i * 140 };
}

export function hashId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h;
}

interface PlanetView {
  data: PlanetData;
  body: Body;
  moons: Body[];
  label: Text;
}

const LABEL = new TextStyle({ fontFamily: 'Segoe UI, sans-serif', fontSize: 64, fill: 0xb8c4d6, letterSpacing: 6 });

export class PlanetRenderer {
  readonly container = new Container();
  private views: PlanetView[] = [];
  private systemId = '';
  private time = 0;
  /** Light strength from the central body (dim around black holes) */
  private lightAmt = 1;

  /** Show this system's planets (rebuilds only when the system changes). */
  setSystem(systemId: string, planets: PlanetData[], centralType?: string): void {
    if (systemId === this.systemId) return;
    this.systemId = systemId;
    for (const v of this.views) v.body.container.destroy({ children: true });
    this.container.removeChildren();
    this.lightAmt = centralType === 'black_hole' ? 0.55 : centralType === 'pulsar' ? 0.75 : 1;
    this.views = planets.map((p) => {
      const seed = hashId(p.id);
      const body = makeBody(planetBody(p), p.radius, seed);
      const moons = (p.moons ?? []).map((m, i) => makeBody(moonBody(p, i), m.radius, seed + i * 13));
      const label = new Text({ text: p.name.toUpperCase(), style: LABEL });
      label.anchor.set(0.5, 0);
      label.alpha = 0.55;
      label.scale.set(Math.min(8, Math.max(1, p.radius / 900)));
      for (const m of moons) this.container.addChild(m.container);
      this.container.addChild(body.container, label);
      return { data: p, body, moons, label };
    });
  }

  /** @param view visible world rect (for culling) */
  update(delta: number, tick: number, view: { x0: number; y0: number; x1: number; y1: number }): void {
    this.time += delta;
    // (not till the noise is in: a flat ball for the moment it takes)
    const ready = planetTexturesReady();
    const place = (b: Body, x: number, y: number) => {
      b.container.x = x;
      b.container.y = y;
      const on = ready && x + b.radius > view.x0 && x - b.radius < view.x1 && y + b.radius > view.y0 && y - b.radius < view.y1;
      b.container.visible = on;
      if (!on) return;
      const d = Math.hypot(x, y) || 1;
      const u = b.quad.u.uniforms;
      u.uTime = this.time;
      const light = u.uLight as Float32Array; // towards the system centre
      light[0] = -x / d;
      light[1] = -y / d;
      u.uLightAmt = this.lightAmt;
    };
    for (const v of this.views) {
      const { x, y } = planetPosition(v.data, tick);
      place(v.body, x, y);
      v.moons.forEach((m, i) => {
        const o = moonOffset(v.data, i, tick);
        place(m, x + o.x, y + o.y);
      });
      // Under it along the screen, upright, however the view is turned
      const below = v.data.radius * Math.max(1.12, (v.data.rings?.outer ?? 0) + 0.05), a = cameraView.angle;
      v.label.x = x - Math.sin(a) * below;
      v.label.y = y + Math.cos(a) * below;
      v.label.rotation = a;
      v.label.visible = v.body.container.visible;
    }
  }
}
