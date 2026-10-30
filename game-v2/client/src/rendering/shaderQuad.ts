/**
 * A world-space quad drawn with a custom fragment shader (PixiJS v8). The
 * fragment shader gets vUV in 0..1 across the quad and the uniforms passed in
 * (as the `u` uniform group). Output premultiplied colour.
 */

import { Mesh, MeshGeometry, Shader, GlProgram, State } from 'pixi.js';

const VERTEX_SHADER = `#version 300 es
  in vec2 aPosition;
  in vec2 aUV;
  out vec2 vUV;
  uniform mat3 uProjectionMatrix;
  uniform mat3 uWorldTransformMatrix;
  uniform mat3 uTransformMatrix;
  void main() {
    vUV = aUV;
    mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
    gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
  }
`;

/** Shared GLSL helpers: value noise, fbm and HSL. Prepend to a fragment body. */
export const GLSL_COMMON = `
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
    return v;
  }
  vec3 hsl2rgb(float h, float s, float l) {
    vec3 k = mod(vec3(0.0, 8.0, 4.0) + h / 30.0, 12.0);
    float a = s * min(l, 1.0 - l);
    return l - a * max(min(min(k - 3.0, 9.0 - k), 1.0), -1.0);
  }
`;

export interface UniformDef { value: number | Float32Array; type: 'f32' | 'vec2<f32>' | 'vec3<f32>' }

export interface ShaderQuad {
  mesh: Mesh<MeshGeometry, Shader>;
  /** Live uniform values: assign to `u.uniforms.uTime` etc. */
  u: { uniforms: Record<string, any> };
}

/**
 * One program per source: Pixi compiles and links each GlProgram it hasn't seen (30-40 ms for these,
 * on the frame it's first drawn), and a new one per quad meant every arrival in a system with a
 * black hole, brown dwarf, planets or comets hitched again. Shaders sharing a program keep their own uniforms.
 */
const programs = new Map<string, GlProgram>();

export function createShaderQuad(fragmentBody: string, uniforms: Record<string, UniformDef>, halfSize: number): ShaderQuad {
  const decls = Object.entries(uniforms).map(([name, d]) => {
    const glsl = d.type === 'f32' ? 'float' : d.type === 'vec2<f32>' ? 'vec2' : 'vec3';
    return `uniform ${glsl} ${name};`;
  }).join('\n');
  const fragment = `#version 300 es
    precision highp float;
    in vec2 vUV;
    out vec4 fragColor;
    ${decls}
    ${GLSL_COMMON}
    ${fragmentBody}
  `;
  const h = halfSize;
  const geometry = new MeshGeometry({
    positions: new Float32Array([-h, -h, h, -h, h, h, -h, h]),
    uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  });
  let glProgram = programs.get(fragment);
  if (!glProgram) programs.set(fragment, glProgram = new GlProgram({ vertex: VERTEX_SHADER, fragment }));
  const shader = new Shader({
    glProgram,
    resources: { u: uniforms },
  });
  const state = State.for2d();
  state.blend = true;
  const mesh = new Mesh({ geometry, shader, state });
  return { mesh, u: shader.resources.u as any };
}
