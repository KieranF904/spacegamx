/**
 * A planet surface's shaders (see SurfaceRenderer). The ground the game draws
 * is groundShader.ts (the art pass), built on GROUND_HEAD here; the one below
 * (groundFragClassic) is the ground from before it, kept for the dev toggle:
 *   ground  terrain from a height field: sea, shore, lowland, forest, rock and
 *           snow, shaded by its slopes against the sun; a city's street grid;
 *           cloud shadows; haze thickening towards the edge of the map
 *   clouds  a layer above the ships (nearer the camera, so it slides faster
 *           than the ground as you move: you're flying between them)
 *
 * A cavern's floor (uCave) is its own thing: dark rock in broad plates,
 * split by a network of fine glowing cracks (finer ones again in patches),
 * lit only by them; no sun, sky or cloud.
 *
 * Both read the sky's tiling noise texture (sky/noiseTexture.ts), sampled at
 * a few rotated scales so its tiling never shows.
 */

export { skyVert as surfaceVert } from '../sky/skyShaders';

export const COMMON = `
uniform sampler2D uNoise;
uniform vec2 uCamera;
uniform vec2 uRes;
uniform float uZoom;
uniform float uTime;
uniform vec2 uSeed;
uniform vec2 uSun;      // the way sunlight travels across the ground (unit)
uniform vec4 uCloud;    // x cover (0 none .. 1 overcast), y world units per tile, z wind, w shadow strength
uniform float uNight;   // 0 day .. 1 night
uniform vec3 uShake;    // the screen's shake: offset (pixels), roll

/** The world point under a place on the screen (\`s\` pixels from its middle), \`k\` the layer's nearness (clouds slide faster) */
vec2 worldAt(vec2 s, float k) {
  vec2 p = s - uShake.xy;
  float c = cos(-uShake.z), n = sin(-uShake.z);
  return uCamera + vec2(c * p.x - n * p.y, n * p.x + c * p.y) / (uZoom * k);
}

/** Night: dark, and moonlit blue */
vec3 night(vec3 c) { return mix(c, c * vec3(0.16, 0.2, 0.32), uNight); }

mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }

/** Cloud density at a world point (0..1) */
float clouds(vec2 w) {
  vec2 wind = vec2(1.0, 0.35) * uTime * uCloud.z;
  vec2 p = (w + wind) / uCloud.y + uSeed * 3.1;
  float v = texture(uNoise, p).r * 0.6 + texture(uNoise, rot(1.3) * p * 2.7 + 0.2).g * 0.3 + texture(uNoise, rot(2.1) * p * 7.3).a * 0.1;
  float t = 0.72 - uCloud.x * 0.42;
  return smoothstep(t, t + 0.16, v);
}
`;

/** The ground's uniforms and shared pieces (a cavern's floor, the terrain's height): both ground shaders start with it */
export const GROUND_HEAD = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 fragColor;
${COMMON}
uniform vec4 uLand;     // x sea level, y snow line, z city radius, w the map's edge (radius)
uniform vec2 uCity;
uniform vec3 uDeep;
uniform vec3 uShallow;
uniform vec3 uShore;
uniform vec3 uLow;
uniform vec3 uHigh;
uniform vec3 uRock;
uniform vec3 uPeak;
uniform vec3 uHaze;
uniform vec3 uUrban;
uniform float uCave;    // 1: a cavern's floor
uniform float uPx;      // world units across one of the pixels it's drawn in

vec2 hash2(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453);
}

/** How far (in cells) from the nearest edge between plates, cells one unit across */
float plateEdge(vec2 x) {
  vec2 n = floor(x), f = fract(x), mg, mr;
  float md = 8.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 g = vec2(float(i), float(j)), o = hash2(n + g + uSeed * 31.0) * 0.8 + 0.1, r = g + o - f;
    float d = dot(r, r);
    if (d < md) { md = d; mr = r; mg = g; }
  }
  md = 8.0;
  for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++) {
    vec2 g = mg + vec2(float(i), float(j)), o = hash2(n + g + uSeed * 31.0) * 0.8 + 0.1, r = g + o - f;
    if (dot(mr - r, mr - r) > 0.00001) md = min(md, dot(0.5 * (mr + r), normalize(r - mr)));
  }
  return md;
}

/** A cavern's floor at a world point: dark plates, glowing cracks between them */
vec3 caveFloor(vec2 w) {
  // The plates' edges wander (warped), so they never read as cells
  vec2 q = vec2(texture(uNoise, w / 9000.0 + uSeed).g, texture(uNoise, w / 9000.0 + uSeed + 0.37).g) - 0.5;
  vec2 pw = w + q * 1500.0;
  float big = plateEdge(pw / 1700.0) * 1700.0;
  float small = plateEdge((pw + q.yx * 600.0) / 460.0 + 7.3) * 460.0;
  float tone = texture(uNoise, w / 2800.0 + uSeed).r;
  float grit = texture(uNoise, rot(1.1) * w / 160.0 + uSeed).a;
  // The rock: dark, a little warmer in places, gently domed plates (darker at their rims)
  vec3 col = mix(vec3(0.062, 0.05, 0.054), vec3(0.12, 0.088, 0.082), tone) * (0.82 + 0.36 * grit);
  col *= 0.62 + 0.38 * smoothstep(0.0, 420.0, big);
  // The cracks: never thinner than a pixel or so; the fine ones only in patches
  float px = uPx;
  float hb = max(7.0, px * 0.55), hs = 3.5;
  float zone = smoothstep(0.42, 0.62, texture(uNoise, rot(0.5) * w / 5200.0 + uSeed + 0.5).b);
  float cb = 1.0 - smoothstep(hb - px * 0.6, hb + px * 0.6, big);
  float cs = (1.0 - smoothstep(hs - px * 0.6, hs + px * 0.6, small)) * zone * min(1.0, hs * 2.0 / px);
  // Breathing slowly, each stretch in its own time
  float heat = 0.78 + 0.22 * sin(uTime * 0.7 + tone * 23.0);
  float halo = exp(-big / 170.0) * 0.55 + exp(-small / 60.0) * 0.18 * zone;
  col += vec3(0.75, 0.16, 0.03) * halo * heat * 0.5;
  vec3 lava = mix(vec3(0.95, 0.3, 0.05), vec3(1.0, 0.74, 0.36), cb * 0.8);
  col = mix(col, lava * heat, max(cb, cs * 0.75));
  // Past the map's edge: dark
  col *= 1.0 - smoothstep(0.92, 1.0, length(w) / uLand.w);
  return col;
}

/** Terrain height (0..1): continents, warped, with finer hills on top; raised round the city */
float height(vec2 w) {
  vec2 p = w / 26000.0 + uSeed;
  vec2 q = vec2(texture(uNoise, p * 0.7).g, texture(uNoise, p * 0.7 + 0.37).g) - 0.5;
  p += q * 0.45;
  // (Smooth octaves only: slopes are shaded from this, and fine 8-bit noise would band)
  float h = texture(uNoise, p).r * 0.7 + texture(uNoise, rot(0.9) * p * 2.3 + 0.13).r * 0.3;
  float dc = length(w - uCity);
  h += 0.22 * (1.0 - smoothstep(uLand.z * 0.6, uLand.z * 2.4, dc));
  return h;
}

`;

/** The ground as it was before the art pass (dev toggle: SurfaceRenderer.setClassic, localStorage sg.surfaceLook = classic) */
export const groundFragClassic = `${GROUND_HEAD}
void main() {
  vec2 w = worldAt((vUV - 0.5) * uRes, 1.0);
  if (uCave > 0.5) { fragColor = vec4(caveFloor(w), 1.0); return; }
  float h = height(w);
  // Slopes against the sun, measured over a few hundred units (smooth, never banded)
  float e = 320.0;
  vec2 g = vec2(height(w + vec2(e, 0.0)) - height(w - vec2(e, 0.0)), height(w + vec2(0.0, e)) - height(w - vec2(0.0, e))) / (2.0 * e);
  vec3 n = normalize(vec3(-g * 2400.0, 1.0));
  float sun = clamp(dot(n, normalize(vec3(-uSun, 0.9))), 0.0, 1.0);
  float shade = 0.5 + 0.62 * sun;

  float sea = uLand.x;
  vec3 col;
  if (h < sea) {
    float d = sea - h;
    col = mix(uShallow, uDeep, smoothstep(0.0, 0.14, d));
    // Light catching the swell
    float sw = texture(uNoise, w / 2200.0 + vec2(uTime * 0.004, uTime * 0.002)).a;
    col += vec3(0.05, 0.07, 0.08) * smoothstep(0.62, 0.8, sw) * (1.0 - smoothstep(0.0, 0.1, d));
    // Surf on the shore
    col = mix(col, vec3(0.85, 0.9, 0.92), (1.0 - smoothstep(0.0, 0.006, d)) * 0.5);
    shade = 0.85 + 0.15 * sun;
  } else {
    float a = (h - sea) / max(0.001, 1.0 - sea);
    float detail = texture(uNoise, rot(0.4) * w / 1700.0 + uSeed).a;
    col = mix(uShore, uLow, smoothstep(0.0, 0.035, a));
    col = mix(col, uHigh, smoothstep(0.12, 0.35, a) * smoothstep(0.35, 0.6, detail + a * 0.3));
    col = mix(col, uRock, smoothstep(0.42, 0.6, a));
    col = mix(col, uPeak, smoothstep(uLand.y, uLand.y + 0.06, a));
    col *= 0.9 + 0.2 * detail;
    // The city: grey blocks between streets, fading out at its edge
    if (uLand.z > 0.0) {
      float dc = length(w - uCity);
      float u = 1.0 - smoothstep(uLand.z * 0.75, uLand.z * 1.15, dc);
      if (u > 0.0) {
        vec2 c = abs(mod(w - uCity, 640.0) - 320.0);
        float street = smoothstep(284.0, 292.0, max(c.x, c.y));
        vec3 urban = uUrban * (0.9 + 0.2 * texture(uNoise, floor((w - uCity) / 640.0) * 0.137).a);
        col = mix(col, urban, u * 0.9);
        col = mix(col, uUrban * 0.45, street * u);
        // Built flat: no hillsides under the streets
        shade = mix(shade, 0.95, u);
      }
    }
  }
  col *= shade;
  // Cloud shadows, cast along the sunlight
  col *= 1.0 - clouds(w - uSun * 900.0) * uCloud.w;
  // High-altitude haze towards the edge of the map
  float r = length(w) / uLand.w;
  col = mix(col, uHaze, smoothstep(0.8, 1.02, r) * 0.8);
  fragColor = vec4(night(col), 1.0);
}
`;

export const cloudFrag = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 fragColor;
${COMMON}
uniform float uFade;    // fewer clouds as you zoom in (you're down among the ships)
uniform vec3 uTint;     // the clouds' colour (white; a lava world's are ash and smoke)

void main() {
  // Nearer the camera than the ground: bigger on screen, and they slide faster
  float k = 1.4;
  vec2 w = worldAt((vUV - 0.5) * uRes, k);
  float c = clouds(w);
  if (c < 0.01) discard;
  // Lit on the sun's side, grey underneath
  float lit = clouds(w + uSun * 260.0);
  vec3 col = mix(vec3(0.97, 0.98, 1.0), vec3(0.72, 0.76, 0.82), clamp(lit - c + 0.5, 0.0, 1.0) * 0.6) * uTint;
  float a = c * 0.62 * uFade * (1.0 - 0.5 * uNight);
  fragColor = vec4(night(col) * a, a);
}
`;
