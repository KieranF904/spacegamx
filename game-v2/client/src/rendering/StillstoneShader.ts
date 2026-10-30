/**
 * How a stillstone is drawn (Scenery.ts LodestoneView): its surface map
 * (stillstoneMap.ts) on a disc of about 80 vertices, one every 32 texels. The
 * sun and the nearby lights are worked out at the vertices (the lights summed
 * into one direction and colour) and applied per pixel to the map's normal, so
 * the carving and grit take every light while costing about one light a
 * pixel. The grooves glow of their own, brightest on the night side, with a
 * pulse running round while a drive charges in the stone's field. The stone's
 * lights come from Lighting like any lit mesh's (and ships passing over shade
 * its sunlight); its own uniforms from `glow`.
 */

import { BufferImageSource, Geometry, GlProgram, Shader, Texture, UniformGroup } from 'pixi.js';
import { MAX_LIGHTS, SHIP_SHADE } from './lighting/litShader';
import { STILLSTONE_ALBEDO_MAX, STILLSTONE_MAP, STILLSTONE_MAP_SPAN } from './stillstoneMap';

const RINGS = 4, SEGS = 20;

/** The disc under a stone `R` across: rings of points out to the map's edge, each with its place on the map */
export function stillstoneDisc(R: number): Geometry {
  const M = R * STILLSTONE_MAP_SPAN, out = M / Math.cos(Math.PI / SEGS);
  const pos = [0, 0], uv = [0.5, 0.5], idx: number[] = [];
  for (let r = 1; r <= RINGS; r++) for (let i = 0; i < SEGS; i++) {
    const a = (i / SEGS) * Math.PI * 2, rr = (r / RINGS) * out, x = Math.cos(a) * rr, y = Math.sin(a) * rr;
    pos.push(x, y);
    uv.push(0.5 + (x / M) * 0.5, 0.5 + (y / M) * 0.5);
  }
  for (let i = 0; i < SEGS; i++) idx.push(0, 1 + i, 1 + ((i + 1) % SEGS));
  for (let r = 1; r < RINGS; r++) for (let i = 0; i < SEGS; i++) {
    const a = 1 + (r - 1) * SEGS + i, b = 1 + (r - 1) * SEGS + ((i + 1) % SEGS), c = a + SEGS, d = b + SEGS;
    idx.push(a, c, d, a, d, b);
  }
  return new Geometry({
    attributes: { aPosition: { buffer: new Float32Array(pos), format: 'float32x2' }, aUV: { buffer: new Float32Array(uv), format: 'float32x2' } },
    indexBuffer: new Uint32Array(idx),
  });
}

const vertex = `#version 300 es
in vec2 aPosition; in vec2 aUV;
out vec2 vUV; out vec3 vSunDir; out vec3 vSunCol; out vec3 vDir; out vec3 vCol; out float vGlow; flat out vec2 vCs; out vec2 vRel;
uniform mat3 uProjectionMatrix; uniform mat3 uWorldTransformMatrix; uniform mat3 uTransformMatrix;
uniform vec4 uXform[2];
uniform vec3 uAmbient; uniform vec4 uSun; uniform vec3 uSunColor; uniform vec2 uSunElev; uniform float uCount;
uniform vec4 uLightPos[${MAX_LIGHTS}]; uniform vec4 uLightCol[${MAX_LIGHTS}]; uniform vec4 uLightCone[${MAX_LIGHTS}];
uniform vec4 uGlow;   // the night side's angle (in the stone's frame), drive charge (0..1), time (s), 1 if its grooves glow
void main() {
  vec4 X = uXform[0];
  vec2 w = X.xy + vec2(X.z * aPosition.x - X.w * aPosition.y, X.w * aPosition.x + X.z * aPosition.y);
  float s = length(X.zw);
  vCs = s > 0.0 ? X.zw / s : vec2(1.0, 0.0);
  vec2 ds = uSun.xy - w;
  float dist = length(ds);
  vSunDir = vec3(ds / max(dist, 1.0) * uSunElev.x, uSunElev.y);
  vSunCol = uSunColor * (uSun.w / (1.0 + dist * dist / (uSun.z * uSun.z)));
  // the nearby lights, summed into one direction and colour
  vec3 dir = vec3(0.0), col = vec3(0.0);
  for (int i = 0; i < ${MAX_LIGHTS}; i++) {
    if (float(i) >= uCount) break;
    vec4 P = uLightPos[i];
    vec2 d = P.xy - w;
    float dd = length(d);
    if (dd >= P.z) continue;
    float a = 1.0 - dd / P.z;
    a *= a;
    vec4 C = uLightCone[i];
    if (C.z > -1.5) a *= smoothstep(C.z, C.w, dot(-d / max(dd, 1.0), C.xy));
    float k = uLightCol[i].a * a;
    dir += normalize(vec3(d, P.w)) * k;
    col += uLightCol[i].rgb * k;
  }
  vDir = dir; vCol = col;
  // the grooves' light: brightest on the night side, a pulse running round while a drive charges
  float an = atan(aPosition.y, aPosition.x);
  float side = 0.3 + 0.7 * pow(max(0.0, cos(an - uGlow.x)), 1.5);
  float pulse = uGlow.y * (0.5 + 0.5 * sin(uGlow.z * 3.0 - an));
  vGlow = min(1.0, side * (0.55 + 0.3 * uGlow.y) + 0.5 * pulse) * uGlow.w;
  vUV = aUV;
  vRel = w - X.xy;
  gl_Position = vec4((uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
}`;

const fragment = `#version 300 es
precision mediump float;
in vec2 vUV; in vec3 vSunDir; in vec3 vSunCol; in vec3 vDir; in vec3 vCol; in float vGlow; flat in vec2 vCs; in highp vec2 vRel;
uniform sampler2D uMap; uniform sampler2D uGlowMap;
uniform vec3 uAmbient; uniform vec3 uGlowColor;
${SHIP_SHADE}
out vec4 fragColor;
void main() {
  vec4 t = texture(uMap, vUV);
  // the outline: cut at its edge (0.5 on the ramp), a pixel's width of smoothing whatever the zoom
  float edge = clamp((t.a - 0.5) / max(fwidth(t.a), 0.0001) + 0.5, 0.0, 1.0);
  if (edge <= 0.0) discard;
  // the map's normal, turned with the stone
  vec2 q = t.rg * 2.0 - 1.0;
  vec3 nl = vec3(q, sqrt(max(0.0, 1.0 - dot(q, q))));
  vec3 n = vec3(vCs.x * nl.x - vCs.y * nl.y, vCs.y * nl.x + vCs.x * nl.y, nl.z);
  float sh = shipShade(vRel);
  vec3 L = uAmbient * mix(1.0, sh, 0.45) + vSunCol * max(dot(n, vSunDir), 0.0) * sh;
  float dl = length(vDir);
  if (dl > 0.0001) L += vCol * max(dot(n, vDir / dl), 0.0);
  // grey rock, a touch cold; its albedo is stored linear
  vec3 base = sqrt(t.b * ${STILLSTONE_ALBEDO_MAX.toFixed(3)}) * vec3(0.95, 0.98, 1.06);
  vec3 c = base * min(L, vec3(1.6)) + uGlowColor * (texture(uGlowMap, vUV).r * vGlow * 0.8);
  fragColor = vec4(c * edge, edge);
}`;

let program: GlProgram | null = null;

/** A stone's own textures and uniforms, and the shader that draws it with `litUniforms` (its LitMesh's lights) */
export function stillstoneShader(maps: { map: Uint8Array; glow: Uint8Array }, litUniforms: unknown, glowColor: number): { shader: Shader; glow: UniformGroup; textures: Texture[] } {
  program ??= new GlProgram({ vertex, fragment, name: 'stillstone' });
  const tex = (resource: Uint8Array) => new Texture({ source: new BufferImageSource({
    resource, width: STILLSTONE_MAP, height: STILLSTONE_MAP,
    // Data, not colour: alpha is the outline, never multiplied in
    alphaMode: 'no-premultiply-alpha', addressMode: 'clamp-to-edge', scaleMode: 'linear', autoGenerateMipmaps: true,
  }) });
  const map = tex(maps.map), light = tex(maps.glow);
  const glow = new UniformGroup({
    uGlow: { value: new Float32Array([0, 0, 0, 1]), type: 'vec4<f32>' },
    uGlowColor: { value: new Float32Array([((glowColor >> 16) & 255) / 255, ((glowColor >> 8) & 255) / 255, (glowColor & 255) / 255]), type: 'vec3<f32>' },
  });
  const shader = new Shader({ glProgram: program, resources: { litUniforms, stoneUniforms: glow, uMap: map.source, uGlowMap: light.source } });
  return { shader, glow, textures: [map, light] };
}
