/**
 * A surface's rock (TerrainView), lit per pixel rather than per vertex: the
 * same light as the lit shader (ambient, sun, the ground's glow, nearby
 * lights), falling on a rock face whose normal is worked out at every pixel:
 *
 *   relief   broad swells, mid-size blocks split by fractures, grit: a height
 *            field from the sky's noise texture, its slope tilting the normal
 *   strata   on a cliff, ledges running along the wall (each a short steep
 *            drop and a shelf), wavering, stepping up into the rock
 *
 * Each vertex carries aRock: on a cliff, the way into the rock (x, as an
 * angle, unwound along the wall so it never jumps) and how far along the
 * wall (y); how far into the rock (z); and what it is (w): 0 a cliff
 * (strata; in a cavern it fades to black past the exposed face; a boulder is
 * drawn as one too, all round), 1 plain rock (relief only), 2 a shadow (no light: its colour times z, over what's under
 * it: a dark band at a wall's foot, a pit's mouth).
 */

import { GlProgram } from 'pixi.js';
import { MAX_LIGHTS } from './litShader';

const vertex = `#version 300 es
in vec2 aPosition;
in vec3 aNormal;
in vec4 aColor;
in vec4 aRock;
out vec2 vW;
out vec3 vN;
out vec4 vC;
out vec4 vR;

uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;

void main() {
  vW = aPosition;
  vN = aNormal;
  vC = aColor;
  vR = aRock;
  gl_Position = vec4((uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
}
`;

const fragment = `#version 300 es
precision highp float;
in vec2 vW;
in vec3 vN;
in vec4 vC;
in vec4 vR;
out vec4 fragColor;

uniform sampler2D uNoise;
uniform vec4 uColor;
uniform vec3 uAmbient;
uniform vec4 uSun;
uniform vec3 uSunColor;
uniform vec2 uSunElev;
uniform vec3 uGround;
uniform float uCount;
uniform vec4 uLightPos[${MAX_LIGHTS}];
uniform vec4 uLightCol[${MAX_LIGHTS}];
uniform vec4 uLightCone[${MAX_LIGHTS}];
uniform vec4 uRock;   // x exposed face ends (fading from), y black by, z how far up a wall the floor's glow reaches, w 1 in a cavern

mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
/** How much fine detail to draw (none once it's finer than the pixels: it would only shimmer) */
float fine = 1.0;

/** A boulder's relief at a point (world units of height): broad swells, blocks split by fractures, a little grit */
float relief(vec2 w) {
  float a = texture(uNoise, w / 2300.0).r;
  float b = texture(uNoise, rot(0.7) * w / 520.0 + 0.31).g;
  float c = texture(uNoise, rot(2.1) * w / 160.0 + 0.57).a;
  float crack = 1.0 - smoothstep(0.0, 0.04, abs(b - 0.52));
  return a * 520.0 + b * 150.0 + c * 22.0 - crack * 34.0;
}

/**
 * A cliff's face at \`al\` along the wall and \`s\` into the rock (world units of
 * height): strata in bands, each a short steep riser and a shelf, its
 * height and depth its own; each band broken into blocks by joints across it
 * (offset band to band), a fine grain running along them
 */
float face(float al, float s) {
  float k = s / 260.0, i = floor(k), f = k - i;
  float band = texture(uNoise, vec2(i * 0.173, al / 2600.0) + 0.41).r;
  float h = (i + smoothstep(0.0, 0.18 + 0.25 * band, f)) * (24.0 + 22.0 * band);
  // Joints across the band: blocks, each a little proud or sunk
  float j = texture(uNoise, vec2(al / (420.0 + 260.0 * band), i * 0.31 + 0.07)).g;
  float joint = 1.0 - smoothstep(0.0, 0.03, abs(j - 0.5));
  h += (j * 18.0 - joint * 16.0) * fine;
  // Grain along the band
  h += texture(uNoise, vec2(al / 900.0, s / 80.0) + 0.13).b * 9.0 * fine;
  return h;
}

void main() {
  float kind = vR.w;
  if (kind > 1.5) {
    // A shadow: no light of its own
    float a = clamp(vR.z, 0.0, 1.0) * uColor.a;
    fragColor = vec4(vC.rgb * a, a);
    return;
  }
  float d = vR.z;
  bool cliff = kind < 0.5;
  fine = 1.0 - smoothstep(2.5, 7.0, length(fwidth(vW)));
  vec2 into = vec2(cos(vR.x), sin(vR.x));
  vec3 base = vC.rgb;
  float wav = 0.0;

  // The normal: the vertex's, tilted by the relief's slope
  vec2 g;
  if (cliff) {
    // (worked out across the wall's own frame: along it, and into the rock, wavering)
    vec2 t = vec2(-into.y, into.x);
    float al = vR.y;
    wav = (texture(uNoise, rot(1.7) * vW / 1500.0 + 0.2).g - 0.5) * 360.0;
    float s = d + wav, e = 7.0;
    float ha = face(al + e, s) - face(al - e, s), hs = face(al, s + e) - face(al, s - e);
    g = (t * ha + into * hs) / (2.0 * e);
    // a broad swell over it all
    float b0 = texture(uNoise, vW / 2600.0).r;
    g += vec2(texture(uNoise, (vW + vec2(60.0, 0.0)) / 2600.0).r - b0, texture(uNoise, (vW + vec2(0.0, 60.0)) / 2600.0).r - b0) * 260.0 / 60.0;
    // Its colour: each band a shade of its own, darker in the joints
    float k = s / 260.0, i = floor(k);
    float band = texture(uNoise, vec2(i * 0.173, al / 2600.0) + 0.41).r;
    base *= 0.86 + 0.28 * band;
    float j = texture(uNoise, vec2(al / (420.0 + 260.0 * band), i * 0.31 + 0.07)).g;
    base *= 1.0 - 0.3 * fine * (1.0 - smoothstep(0.0, 0.03, abs(j - 0.5)));
    // (the riser under each shelf: in its own shadow)
    base *= 0.8 + 0.2 * smoothstep(0.0, 0.2 + 0.25 * band, k - i);
  } else {
    float e = 14.0, h0 = relief(vW);
    g = vec2(relief(vW + vec2(e, 0.0)) - h0, relief(vW + vec2(0.0, e)) - h0) / e;
    base *= 0.88 + 0.24 * texture(uNoise, vW / 3100.0 + 0.71).r;
    base *= 1.0 - 0.3 * (1.0 - smoothstep(0.0, 0.03, abs(texture(uNoise, rot(0.7) * vW / 520.0 + 0.31).g - 0.52)));
  }
  vec3 n0 = normalize(vN);
  // (on a cliff the facets are the main shape: the detail rides on them)
  vec3 n = normalize(n0 + vec3(-g * (cliff ? 0.6 : 0.4 * fine), 0.0));

  // The light on it, as the lit shader's, here at this pixel
  vec3 L = uAmbient;
  vec2 ds = uSun.xy - vW;
  float dist = length(ds);
  vec3 sl = vec3(ds / max(dist, 1.0) * uSunElev.x, uSunElev.y);
  L += uSunColor * (uSun.w / (1.0 + dist * dist / (uSun.z * uSun.z))) * max(dot(n, sl), 0.0);
  if (uRock.w > 0.5) {
    // In a cavern the floor's glow is the light: coming in low off the floor, it rakes up the walls (catching
    // every ledge and block, the sides turned from it in shadow) and fades with the height up them
    vec3 ld = cliff ? normalize(vec3(-into * 0.8, 0.42)) : normalize(vec3(0.0, 0.0, 1.0));
    float up = cliff ? exp(-max(d, 0.0) / uRock.z) : 1.0;
    // (a boulder: lit up its sides from the floor all round, its top turned away and dark)
    if (cliff) L += uGround * (0.18 + 3.2 * up * max(dot(n, ld), 0.0) + 0.5 * (1.0 - clamp(n.z, 0.0, 1.0)));
    else L += uGround * (0.08 + 3.6 * pow(1.0 - clamp(n.z, 0.0, 1.0), 1.3));
  } else L += uGround * (0.25 + 0.9 * (1.0 - clamp(n.z, 0.0, 1.0)));
  for (int i = 0; i < ${MAX_LIGHTS}; i++) {
    if (float(i) >= uCount) break;
    vec4 P = uLightPos[i];
    vec2 dl = P.xy - vW;
    float dd = length(dl);
    if (dd >= P.z) continue;
    float a = 1.0 - dd / P.z;
    a *= a;
    vec4 C = uLightCone[i];
    if (C.z > -1.5) a *= smoothstep(C.z, C.w, dot(-dl / max(dd, 1.0), C.xy));
    L += uLightCol[i].rgb * (uLightCol[i].a * a * max(dot(n, normalize(vec3(dl, P.w))), 0.0));
  }
  vec3 col = base * mix(min(L, vec3(1.6)), vec3(1.0), vC.a);
  // In a cavern, a wall past its exposed face falls away into the dark
  if (cliff && uRock.w > 0.5) col *= 1.0 - smoothstep(uRock.x, uRock.y, d + wav * 0.6);
  fragColor = vec4(col, 1.0) * uColor;
}
`;

let program: GlProgram | null = null;

export function rockProgram(): GlProgram {
  return (program ??= new GlProgram({ vertex, fragment, name: 'rock' }));
}
