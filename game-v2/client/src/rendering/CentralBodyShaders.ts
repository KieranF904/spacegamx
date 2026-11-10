/**
 * Central bodies that aren't ordinary suns: black holes, pulsars and brown dwarfs.
 * Drawn at the system origin in world space, like the sun.
 */

import { Container } from 'pixi.js';
import type { PlanetLookData } from '@space-game/common';
import { createShaderQuad, ShaderQuad } from './shaderQuad';
import { planetQuad } from './planetView/planetQuad';
import { planetTexturesReady } from './planetView/planetTextures';

/** Top-down black hole: event horizon, photon ring, Keplerian accretion disk, faint haze. */
const BLACK_HOLE = `
  void main() {
    vec2 p = (vUV - 0.5) * 2.0 * 6.0;     // quad spans ±6 horizon radii
    float r = length(p);
    float a = atan(p.y, p.x);
    if (r > 6.0) { fragColor = vec4(0.0); return; }

    float inner = 1.6, outer = 4.6;
    float t = clamp((r - inner) / (outer - inner), 0.0, 1.0);
    float disk = smoothstep(inner - 0.15, inner + 0.25, r) * pow(1.0 - t, 1.4) * smoothstep(outer + 0.2, outer - 0.6, r);
    // The disk's turbulence (two fbms) only where there is disk
    float turb = 0.0, lanes = 1.0;
    if (disk > 0.0) {
      // Keplerian shear: inner gas laps the outer gas
      float spin = uTime * 0.6 * pow(max(r, 0.8), -1.5);
      vec2 q = vec2(cos(a + spin), sin(a + spin)) * r;
      turb = fbm(q * 1.7) * 0.7 + fbm(q * 5.0 + 3.0) * 0.3;
      lanes = 0.6 + 0.4 * sin(r * 9.0 - turb * 6.0);
    }
    // Doppler beaming: the approaching side of the disk is brighter
    float doppler = 1.0 + 0.55 * cos(a - 0.6);
    float bright = disk * (0.45 + turb * 0.9) * lanes * doppler;

    vec3 hot = hsl2rgb(uDiskHue + 25.0, 0.6, 0.9);
    vec3 warm = hsl2rgb(uDiskHue, 0.95, 0.55);
    vec3 cool = hsl2rgb(uDiskHue - 20.0, 0.9, 0.3);
    vec3 diskCol = mix(hot, mix(warm, cool, smoothstep(0.35, 1.0, t)), smoothstep(0.0, 0.35, t));

    float photon = exp(-pow((r - 1.18) / 0.045, 2.0)) * 1.4;
    float haze = exp(-(r - 1.0) * 0.9) * 0.18 * smoothstep(1.0, 1.4, r);
    vec3 col = diskCol * bright * 1.5 + hot * photon + warm * haze;
    float alpha = clamp(bright + photon + haze, 0.0, 1.0);

    // Event horizon
    float hole = smoothstep(1.05, 0.95, r);
    col = mix(col, vec3(0.0), hole);
    alpha = max(alpha, hole);
    float edge = smoothstep(6.0, 4.8, r);
    fragColor = vec4(col * edge, alpha * edge);
  }
`;

/** Pulsar: a tiny white-hot star, a soft wind nebula and two sweeping beams. */
const PULSAR = `
  void main() {
    vec2 p = (vUV - 0.5) * 2.0;            // -1..1, beams reach the edge
    float r = length(p);
    if (r > 1.0) { fragColor = vec4(0.0); return; }
    float a = atan(p.y, p.x);

    float beamAngle = uTime * uSpin;
    float d1 = abs(mod(a - beamAngle + 3.14159, 6.28318) - 3.14159);
    float d2 = abs(mod(a - beamAngle, 6.28318) - 3.14159);
    float d = min(d1, d2);
    float width = 0.035 + r * 0.05;
    float beam = exp(-pow(d / width, 2.0)) * pow(1.0 - r, 1.3);
    beam *= 0.75 + 0.25 * noise(vec2(r * 30.0 - uTime * 4.0, 0.0));

    float core = exp(-pow(r / uCore, 2.0));
    float halo = exp(-r / (uCore * 6.0)) * 0.5;
    float windShape = exp(-pow((r - uCore * 14.0) / (uCore * 7.0), 2.0));
    float wind = windShape > 0.002 ? windShape * (0.25 + 0.35 * fbm(p * 18.0 + uTime * 0.05)) : 0.0;

    vec3 beamCol = hsl2rgb(uBeamHue, 0.8, 0.7);
    vec3 col = vec3(1.0) * core * 1.5 + beamCol * (halo + beam * 1.3) + hsl2rgb(uBeamHue + 30.0, 0.7, 0.45) * wind;
    float alpha = clamp(core + halo + beam + wind * 0.7, 0.0, 1.0);
    float edge = smoothstep(1.0, 0.9, r);
    fragColor = vec4(col * edge, alpha * edge);
  }
`;

/**
 * The brown dwarf's classic shader (until 2026-10-31; the game draws it with the planets' program now, below). Kept
 * for the sun lab's harness (scripts/sun-sky-proto reads it from this file).
 *
 * Brown dwarf: a star that never caught. A dim, banded ball turning slowly,
 * its bands dragged into eddies, a storm riding one of them, glowing dull red
 * through the cracks between the cloud decks, with a faint smoulder round it,
 * and one old scar of fractures running out from a hot point on the equator.
 */
export const BROWN_DWARF = `
  void main() {
    vec2 p = (vUV - 0.5) * 2.0 * 1.6;      // quad spans ±1.6 radii
    float r = length(p);
    float glow = exp(-max(r - 1.0, 0.0) * 5.0) * 0.32 * smoothstep(1.6, 1.0, r);
    vec3 ember = hsl2rgb(uHue, 0.85, 0.32);
    if (r > 1.0) { fragColor = vec4(ember * glow, glow); return; }
    float z = sqrt(1.0 - r * r);
    // Longitude on the turning ball, latitude straight across
    float lon = atan(p.x, z) + uTime * 0.035;
    float lat = p.y;
    float eddy = fbm(vec2(lon * 2.2, lat * 7.0) + uTime * 0.01);
    float bands = sin(lat * 15.0 + eddy * 3.2 + sin(lon * 3.0 + lat * 4.0) * 0.4);
    float fine = fbm(vec2(lon * 9.0, lat * 26.0 + eddy));
    vec3 dark = hsl2rgb(uHue - 6.0, 0.55, 0.13);
    vec3 mid = hsl2rgb(uHue, 0.62, 0.27);
    vec3 pale = hsl2rgb(uHue + 14.0, 0.5, 0.42);
    vec3 col = mix(dark, mid, smoothstep(-0.9, 0.2, bands));
    col = mix(col, pale, smoothstep(0.45, 1.0, bands) * (0.55 + fine * 0.45));
    // A storm in the southern bands
    vec2 sp = vec2(mod(lon - 0.7 + 3.14159, 6.28318) - 3.14159, lat + 0.36);
    float storm = exp(-dot(sp * vec2(2.6, 6.5), sp * vec2(2.6, 6.5)));
    col = mix(col, hsl2rgb(uHue + 4.0, 0.75, 0.38), storm * 0.8);
    // Heat glowing through the gaps between the decks
    float cracks = smoothstep(0.62, 0.8, fine) * smoothstep(0.2, -0.6, bands);
    col += hsl2rgb(uHue + 8.0, 0.95, 0.5) * cracks * 0.55;
    // An old scar: fractures running out from one point on the equator, still hot
    // at the middle (where something once tried to light it)
    vec2 ip = vec2(mod(lon - 2.2 + 3.14159, 6.28318) - 3.14159, lat - 0.12);
    float id = length(ip * vec2(1.0, 1.5));
    float rays = pow(abs(sin(atan(ip.y, ip.x) * 4.0 + fine * 1.4)), 30.0);
    float scar = rays * smoothstep(1.2, 0.12, id) * (0.55 + 0.45 * fine);
    col += hsl2rgb(uHue + 10.0, 1.0, 0.55) * (scar * 0.5 + exp(-id * id * 45.0) * 0.35);
    // Limb darkening, and a warm rim
    col *= 0.35 + 0.65 * pow(z, 0.6);
    col += ember * pow(1.0 - z, 3.0) * 0.6;
    fragColor = vec4(col, 1.0);
  }
`;

export type CentralType = 'black_hole' | 'pulsar' | 'brown_dwarf';

export class CentralBodyShaders {
  readonly container = new Container();
  private current: { type: CentralType; key: string; quad: ShaderQuad } | null = null;
  private time = 0;

  /** Show (or hide with type null) the special central body for this system (`look`: a brown dwarf's own) */
  set(type: CentralType | null, radius: number, hue: number, look?: PlanetLookData): void {
    const key = `${type}:${radius}:${hue}`;
    if (this.current?.key === key) return;
    if (this.current) {
      this.container.removeChild(this.current.quad.mesh);
      this.current.quad.mesh.destroy();
      this.current = null;
    }
    if (!type) return;
    const quad = type === 'black_hole'
      ? createShaderQuad(BLACK_HOLE, { uTime: { value: 0, type: 'f32' }, uDiskHue: { value: hue, type: 'f32' } }, radius * 6)
      : type === 'brown_dwarf'
      // (a planet that lights itself: planet-proto, kind 'dwarf', its banded deck, heat and old scar)
      ? planetQuad({ id: 'dwarf', kind: 'dwarf', hue, look }, 0, radius, 1.6)
      : createShaderQuad(PULSAR, {
          uTime: { value: 0, type: 'f32' },
          uBeamHue: { value: hue, type: 'f32' },
          uSpin: { value: 0.7, type: 'f32' },
          // Core size relative to the beam length
          uCore: { value: Math.max(0.004, radius / Math.max(24000, radius * 60)), type: 'f32' },
        }, Math.max(24000, radius * 60));
    this.container.addChild(quad.mesh);
    this.current = { type, key, quad };
  }

  update(delta: number): void {
    this.time += delta;
    if (!this.current) return;
    this.current.quad.u.uniforms.uTime = this.time;
    // (the brown dwarf waits for the planets' noise, as they do)
    if (this.current.type === 'brown_dwarf') this.current.quad.mesh.visible = planetTexturesReady();
  }
}
