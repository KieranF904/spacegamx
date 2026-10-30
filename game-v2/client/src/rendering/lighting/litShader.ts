/**
 * The lit-polygon shader: lighting worked out per vertex (not per pixel) from
 * the system's ambient, its sun (or black hole, or pulsar) and up to
 * MAX_LIGHTS nearby lights, then blended across each triangle.
 *
 * Every vertex carries a normal: (0, 0, 1) faces the camera; bevels, rock
 * facets and crater walls tilt it. Lights sit a little above the playing field
 * (their height), so a light beside a panel brightens its near edge most, and
 * the sun's light comes in low from the system's centre, so things are lit on
 * the side facing it and fall into shadow on the other.
 *
 * Slots: a mesh can hold several objects (a chunk of asteroids), each with its
 * own transform in uXform (x, y, cos·scale, sin·scale). With uPlace on, that
 * transform places the vertices too; off, Pixi places the mesh as usual and
 * the slot transform only says where it is in the world, for the lighting.
 * Each slot also has its own opacity (uFade), so one of several can fade.
 */

import { GlProgram } from 'pixi.js';

export const MAX_LIGHTS = 16;

/** Ships' shadows a structure takes at once (see Lighting.shadow) */
export const MAX_SHADES = 8;

/**
 * For a structure's fragment shader: how much of the sun reaches a pixel past
 * the ships' shadows (soft discs, uShade: xy from the mesh's place in the
 * world, radius, depth), `p` the pixel's world offset from that place; and
 * shipDim, the light left there given the sun's share of it (`k.x`, 0..1) and
 * how much the surface is lit at all (`k.y`; glowing parts aren't shaded): a
 * ship overhead blocks some of the sky's light too.
 */
export const SHIP_SHADE = `uniform highp vec4 uShade[${MAX_SHADES}]; uniform float uShadeCount;
float shipShade(highp vec2 p) {
  float s = 1.0;
  for (int i = 0; i < ${MAX_SHADES}; i++) {
    if (float(i) >= uShadeCount) break;
    highp vec4 S = uShade[i];
    s *= 1.0 - S.w * (1.0 - smoothstep(0.3, 1.0, length(p - S.xy) / S.z));
  }
  return s;
}
float shipDim(highp vec2 p, vec2 k) {
  return mix(1.0, shipShade(p), (0.45 + 0.55 * k.x) * k.y);
}`;

/** vec4s holding `slots` slots' fades (two at least, as with uXform: see LitMesh) */
export const fades = (slots: number) => Math.max(2, Math.ceil(slots / 4));

const vertex = (slots: number) => `#version 300 es
in vec2 aPosition;
in vec3 aNormal;
in vec4 aColor;    // rgb base colour, a: glows by itself (0 lit, 1 unaffected by light)
in float aSlot;
out vec4 vColor;

uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;

uniform vec4 uXform[${slots}];
uniform vec4 uFade[${fades(slots)}];  // each slot's opacity, four to a vec4
uniform float uPlace;
uniform vec3 uAmbient;
uniform vec4 uSun;        // xy position, z falloff distance, w power
uniform vec3 uSunColor;
uniform vec2 uSunElev;    // cos, sin of the angle its light comes in above the plane
uniform vec3 uGround;     // light up off the ground (a lava world's glow), most on faces turned to the side
uniform float uCount;
uniform vec4 uLightPos[${MAX_LIGHTS}];   // xy, z radius, w height
uniform vec4 uLightCol[${MAX_LIGHTS}];   // rgb, power
uniform vec4 uLightCone[${MAX_LIGHTS}];  // xy facing, z cos of the outer edge (-2: all round), w inner

void main() {
  int slot = int(aSlot + 0.5);
  vec4 X = uXform[slot];
  vec2 w = X.xy + vec2(X.z * aPosition.x - X.w * aPosition.y, X.w * aPosition.x + X.z * aPosition.y);
  float s = length(X.zw);
  vec2 cs = s > 0.0 ? X.zw / s : vec2(1.0, 0.0);
  vec3 n = vec3(cs.x * aNormal.x - cs.y * aNormal.y, cs.y * aNormal.x + cs.x * aNormal.y, aNormal.z);

  vec3 L = uAmbient;
  vec2 ds = uSun.xy - w;
  float dist = length(ds);
  vec3 sl = vec3(ds / max(dist, 1.0) * uSunElev.x, uSunElev.y);
  L += uSunColor * (uSun.w / (1.0 + dist * dist / (uSun.z * uSun.z))) * max(dot(n, sl), 0.0);
  L += uGround * (0.25 + 0.9 * (1.0 - clamp(n.z, 0.0, 1.0)));
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
    L += uLightCol[i].rgb * (uLightCol[i].a * a * max(dot(n, normalize(vec3(d, P.w))), 0.0));
  }
  vColor = vec4(aColor.rgb * mix(min(L, vec3(1.6)), vec3(1.0), aColor.a), 1.0) * uFade[slot / 4][slot % 4];

  vec2 pos = uPlace > 0.5 ? w : aPosition;
  gl_Position = vec4((uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix * vec3(pos, 1.0)).xy, 0.0, 1.0);
}
`;

const fragment = `#version 300 es
precision mediump float;
in vec4 vColor;
uniform vec4 uColor;
out vec4 fragColor;
void main() {
  fragColor = vColor * uColor;
}
`;

const programs = new Map<number, GlProgram>();

/** The program for meshes holding `slots` objects */
export function litProgram(slots: number): GlProgram {
  let p = programs.get(slots);
  if (!p) {
    p = new GlProgram({ vertex: vertex(slots), fragment, name: `lit-${slots}` });
    programs.set(slots, p);
  }
  return p;
}
