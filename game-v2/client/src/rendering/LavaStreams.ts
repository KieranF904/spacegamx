/**
 * Lava running over a surface's floor (terrain files' `streams`): each a
 * ribbon along its line, drawn by itself (it glows: no light needed), with
 * a soft halo on the ground either side.
 *
 * The flow: a dark crust in plates drifting down the stream (the noise slid
 * along its length over time), molten orange between them, hottest and
 * brightest down its middle; dark cooled banks at its edges. Each stream
 * also lights what's near it (ships, rock), a light every so often along it.
 */

import { Container, Geometry, GlProgram, Mesh, Shader, State } from 'pixi.js';
import type { Vec2 } from '@space-game/common';
import { skyNoiseTexture } from './sky/noiseTexture';
import type { Lighting } from './lighting/Lighting';

/** The halo: this many times the stream's own half-width either side */
const HALO = 2.8;
/** A light every this far along a stream */
const LIGHT_EVERY = 800;

const vertex = `#version 300 es
in vec2 aPosition;
in vec4 aFlow;   // x how far along (world units), y across (-1..1 of the halo's width), z half-width, w along (0..1 of the stream)
out vec4 vFlow;
out vec2 vW;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
void main() {
  vFlow = aFlow;
  vW = aPosition;
  gl_Position = vec4((uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
}
`;

const fragment = `#version 300 es
precision highp float;
in vec4 vFlow;
in vec2 vW;
out vec4 fragColor;
uniform sampler2D uNoise;
uniform float uTime;
uniform vec4 uColor;

mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }

void main() {
  float hw = vFlow.z;
  float r = abs(vFlow.y) * ${HALO.toFixed(1)};      // 1 at the stream's bank
  float ends = smoothstep(0.0, 0.06, vFlow.w) * (1.0 - smoothstep(0.82, 1.0, vFlow.w));
  // The halo on the floor either side
  float halo = exp(-max(r - 0.85, 0.0) * 2.2) * 0.42;
  // The crust: plates drifting down the stream, slower at its banks than its middle
  float speed = 46.0 * (1.0 - 0.6 * min(r, 1.0) * min(r, 1.0));
  vec2 p = vec2(vFlow.x - uTime * speed, vFlow.y * ${HALO.toFixed(1)} * hw);
  float n = texture(uNoise, p / 520.0).r * 0.6 + texture(uNoise, rot(0.6) * p / 190.0 + 0.3).g * 0.4;
  float crust = smoothstep(0.5, 0.6, n + 0.22 * r);
  float core = 1.0 - smoothstep(0.0, 0.85, r);
  vec3 molten = mix(vec3(0.95, 0.28, 0.05), vec3(1.0, 0.78, 0.36), core * (1.0 - crust));
  molten += vec3(0.25, 0.18, 0.1) * pow(core, 4.0) * (1.0 - crust);
  vec3 crustCol = mix(vec3(0.16, 0.06, 0.04), vec3(0.42, 0.11, 0.03), 0.5 + 0.5 * sin(uTime * 1.3 + vFlow.x * 0.01));
  vec3 lava = mix(molten, crustCol, crust * 0.85);
  // Its banks: cooled, dark, a thin rim
  float bank = smoothstep(0.78, 1.0, r);
  lava = mix(lava, vec3(0.09, 0.04, 0.035), bank * 0.8);
  float inside = 1.0 - smoothstep(0.96, 1.04, r);
  vec3 col = lava * inside + vec3(1.0, 0.36, 0.08) * halo * (1.0 - inside);
  float a = max(inside, halo) * ends;
  fragColor = vec4(col * a, a) * uColor;
}
`;

let program: GlProgram | null = null;

export class LavaStreams {
  readonly mesh: Mesh<Geometry, Shader>;
  private shader: Shader;
  private time = 0;
  /** Where its lights go (along each stream) */
  private lights: { x: number; y: number; w: number }[] = [];
  private source = (L: Lighting) => {
    const flick = 0.9 + 0.1 * Math.sin(this.time * 2.3);
    for (const l of this.lights) L.point(l.x, l.y, 0xff6a1a, 700 + l.w * 3, 0.55 * flick, 140);
  };

  constructor(streams: { pts: Vec2[]; w: number[] }[], private lighting: Lighting) {
    const pos: number[] = [], flow: number[] = [], idx: number[] = [];
    for (const s of streams) {
      const n = s.pts.length;
      if (n < 2) continue;
      let run = 0;
      const lens = [0];
      for (let i = 1; i < n; i++) lens.push((run += Math.hypot(s.pts[i][0] - s.pts[i - 1][0], s.pts[i][1] - s.pts[i - 1][1])));
      const first = pos.length / 2;
      let lightAt = LIGHT_EVERY * 0.4;
      for (let i = 0; i < n; i++) {
        const a = s.pts[Math.max(0, i - 1)], b = s.pts[Math.min(n - 1, i + 1)];
        const ex = b[0] - a[0], ey = b[1] - a[1], l = Math.hypot(ex, ey) || 1, nx = -ey / l, ny = ex / l;
        const hw = Math.max(20, s.w[i] / 2), out = hw * HALO;
        const [x, y] = s.pts[i];
        pos.push(x + nx * out, y + ny * out, x - nx * out, y - ny * out);
        flow.push(lens[i], 1, hw, lens[i] / run, lens[i], -1, hw, lens[i] / run);
        if (i < n - 1) idx.push(first + i * 2, first + i * 2 + 1, first + i * 2 + 3, first + i * 2, first + i * 2 + 3, first + i * 2 + 2);
        if (lens[i] >= lightAt && lens[i] < run * 0.9) { this.lights.push({ x, y, w: hw }); lightAt += LIGHT_EVERY; }
      }
    }
    const geometry = new Geometry({
      attributes: {
        aPosition: { buffer: new Float32Array(pos), format: 'float32x2' },
        aFlow: { buffer: new Float32Array(flow), format: 'float32x4' },
      },
      indexBuffer: new Uint32Array(idx),
    });
    this.shader = new Shader({
      glProgram: (program ??= new GlProgram({ vertex, fragment, name: 'lava-stream' })),
      resources: { uNoise: skyNoiseTexture().source, streamUniforms: { uTime: { value: 0, type: 'f32' } } },
    });
    this.mesh = new Mesh<Geometry, Shader>({ geometry, shader: this.shader, state: State.for2d() });
    lighting.addSource(this.source);
  }

  update(dt: number): void {
    this.time += dt;
    (this.shader.resources.streamUniforms as any).uniforms.uTime = this.time % 10000;
  }

  destroy(): void {
    this.lighting.removeSource(this.source);
    this.mesh.destroy({ children: true });
  }
}
