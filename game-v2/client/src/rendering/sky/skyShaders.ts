/**
 * The sky's two shaders (see SkyRenderer):
 *   haze   the galaxy's band, nebula clouds, dust lanes, filaments, a remnant
 *          shell: smooth, so it's drawn at a third of the screen's size
 *   stars  points at true perspective depths, distant galaxies and clusters,
 *          and dust drifting near the camera: sharp, so at full size
 *
 * Both read the same fields of the sky (skyFields), so the stars thin and
 * redden behind exactly the dust lanes the haze draws, and crowd into its band.
 *
 * Every layer is placed the same way: a layer at depth D behind the playing
 * field is seen at scale z = 1 / (1/zoom + D) (screen pixels per layer unit),
 * so near layers slide and zoom with the camera and far ones hardly move.
 */

export const skyVert = `#version 300 es
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

/** Shared: where on the sky a pixel is, and what's there (band, dust, nebula) */
const FIELDS = `
uniform sampler2D uNoise;
uniform vec2 uCamera;
uniform vec2 uRes;
uniform vec4 uSky;    // x: the sky layer's scale, y: sky units per noise tile, zw: this system's offset into the noise
uniform vec4 uBand;   // xy: across the band (unit), z: its offset, w: its half-width
uniform vec4 uField;  // x: dust strength, y: nebula cover threshold
uniform vec4 uLens;   // a black hole: xy its offset from the screen centre (px), z its Einstein radius (px), w on/off
uniform vec2 uRot;    // the view's roll (cos, sin): a screen offset turned into the world's axes

vec2 turned(vec2 v) { return vec2(uRot.x * v.x - uRot.y * v.y, uRot.y * v.x + uRot.x * v.y); }

/**
 * Gravitational lensing: light passing a black hole is bent, so the pixel at
 * offset θ from it shows the sky at θ − θE²·θ/|θ|². Stars near it stretch into
 * arcs, and a ring of them forms at the Einstein radius.
 */
vec2 lensed(vec2 off) {
  if (uLens.w <= 0.0) return off;
  vec2 d = off - uLens.xy;
  return off - d * (uLens.z * uLens.z / max(dot(d, d), 1.0)) * uLens.w;
}

struct Fields { float band; float dust; float neb; vec4 a; vec4 b; vec2 uv; };

Fields skyFields(vec2 sky) {
  Fields F;
  vec2 uv = sky / uSky.y + uSky.zw;
  vec4 a = texture(uNoise, uv);
  vec4 b = texture(uNoise, uv * 2.37 + (a.rg - 0.5) * 0.3);
  // The band wanders: its centre line is pushed about by the broad noise
  float v = (dot(sky, uBand.xy) - uBand.z) / uBand.w + (a.r - 0.5) * 1.6 + (b.g - 0.5) * 0.4;
  F.band = exp(-v * v);
  F.neb = smoothstep(uField.y, uField.y + 0.28, a.g * 0.62 + b.r * 0.38);
  // Dust lies along the ridges, thickest in the band and the clouds
  F.dust = smoothstep(0.5, 0.85, b.b) * smoothstep(0.2, 0.6, a.g) * (0.3 + 0.7 * max(F.band, F.neb)) * uField.x;
  F.a = a; F.b = b; F.uv = uv;
  return F;
}
`;

export const hazeFrag = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 fragColor;
${FIELDS}
uniform vec3 uBase;
uniform vec3 uBandCore;
uniform vec3 uBandEdge;
uniform float uBandStrength;
uniform vec3 uDustTint;
uniform vec3 uNebA;
uniform vec3 uNebB;
uniform float uNebStrength;
uniform vec3 uFilColor;
uniform float uFilStrength;
uniform vec4 uShell;      // xy: centre (sky units), z: radius, w: strength
uniform vec3 uShellColor;

void main() {
  vec2 sky = uCamera + lensed(turned((vUV - 0.5) * uRes)) / uSky.x;
  Fields F = skyFields(sky);
  vec4 a = F.a, b = F.b;
  vec4 c = texture(uNoise, F.uv * 5.1 + (b.rg - 0.5) * 0.5);
  // The finest detail: wisps and grain at a few pixels' scale
  float fine = texture(uNoise, F.uv * 13.7 + (c.rg - 0.5) * 0.12).a;
  vec3 col = uBase;

  // The band: light of stars too far to see one by one, in clumps
  float clump = 0.15 + 0.9 * b.a * b.a + 0.45 * c.a + 0.4 * fine;
  col += mix(uBandEdge, uBandCore, F.band * F.band) * F.band * clump * uBandStrength;
  // Its bright spine
  col += uBandCore * pow(F.band, 6.0) * (0.4 + 0.8 * c.a) * uBandStrength * 0.8;

  // Nebula: two colours, mottled, its edges glowing brightest (ionisation fronts)
  float front = F.neb * (1.0 - F.neb) * 4.0;
  float body = F.neb * (0.4 + 0.65 * c.a + 0.45 * fine * fine) + front * (0.3 + 0.5 * fine);
  col += mix(uNebA, uNebB, smoothstep(0.3, 0.8, b.r)) * body * uNebStrength;

  // Filaments: thin threads along the ridges of a finer, warped field
  float fil = pow(smoothstep(0.55, 1.0, c.b), 3.0) * smoothstep(0.3, 0.75, a.r) * (0.6 + 0.8 * fine);
  col += uFilColor * fil * uFilStrength;

  // A supernova remnant: a ragged shell of filaments
  if (uShell.w > 0.0) {
    float dr = (length(sky - uShell.xy) - uShell.z) / (uShell.z * 0.07) + (a.g - 0.5) * 3.5;
    float shell = exp(-dr * dr);
    float threads = pow(smoothstep(0.45, 1.0, c.b), 2.0);
    col += uShellColor * shell * uShell.w * (0.3 + 2.2 * threads + 0.5 * c.a);
    // Its inside is lit faintly
    col += uFilColor * smoothstep(0.0, -2.5, dr) * uShell.w * 0.08 * (0.5 + c.a);
  }

  // Dust swallows what's behind it, with a faint warm edge
  col *= 1.0 - F.dust * 0.88;
  col += uDustTint * F.dust * (1.0 - F.dust) * 0.05;
  fragColor = vec4(col, 1.0);
}
`;

export const starsFrag = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 fragColor;
${FIELDS}
uniform float uTime;
uniform vec4 uL0;   // per layer: x scale, y cell size (layer units), z share of cells with a star, w alpha
uniform vec4 uL1;
uniform vec4 uL2;
uniform vec4 uL3;
uniform vec4 uL4;
uniform vec4 uL5;
uniform vec4 uMotes;    // x scale, y cell size, z alpha
uniform vec4 uDeep;     // x scale, y cell size, z galaxy chance, w cluster chance
uniform vec4 uStarMix;  // x temperature (-1 red .. 1 blue), y brightness, z crowding in the band, w spike share
uniform vec3 uTint;
uniform vec2 uSpike;    // diffraction spike direction
uniform vec2 uStreak;   // camera travel per 60th of a second (world units): near stars smear along it
uniform vec3 uMoteColor;

// Per layer, near to far
const float REACH[6] = float[6](26.0, 15.0, 8.0, 5.0, 3.5, 2.5);   // px a star can light
const float SIZE[6]  = float[6](1.35, 1.1, 0.9, 0.75, 0.62, 0.55); // core radius (px)
const float LUM[6]   = float[6](1.25, 1.0, 0.8, 0.62, 0.48, 0.36);
const float FAR[6]   = float[6](0.0, 0.12, 0.35, 0.65, 0.88, 1.0); // how much the sky's band and dust apply

float hash(vec2 p) {
  p = fract(p * vec2(443.8975, 397.2973));
  p += dot(p, p.yx + 19.19);
  return fract(p.x * p.y);
}
vec2 hash2(vec2 p) { return vec2(hash(p), hash(p + 127.1)); }

/** Black-body-ish: 0 red, 0.35 yellow-white, 0.6 white, 1 blue */
vec3 starColor(float t) {
  vec3 red = vec3(1.0, 0.62, 0.38), yel = vec3(1.0, 0.9, 0.74), wht = vec3(0.96, 0.97, 1.0), blu = vec3(0.66, 0.78, 1.0);
  return t < 0.35 ? mix(red, yel, t / 0.35) : t < 0.6 ? mix(yel, wht, (t - 0.35) / 0.25) : mix(wht, blu, (t - 0.6) / 0.4);
}

vec3 layer(int i, vec4 L, vec2 off, float crowd, float dust) {
  if (L.w <= 0.003) return vec3(0.0);
  float z = L.x, cellPx = L.y * z;
  vec2 g = uCamera / L.y + off / cellPx;
  vec2 cell = floor(g), f = g - cell;
  // Camera travel smears the nearer stars into streaks
  vec2 sv = vec2(0.0);
  float sl = 0.0;
  if (uStreak.x != 0.0 || uStreak.y != 0.0) {
    sv = uStreak * z;
    sl = min(max(length(sv) - 2.5, 0.0), cellPx * 0.6);
    sv = sl > 0.0 ? normalize(sv) * sl : vec2(0.0);
  }
  float far = FAR[i];
  // Far stars crowd into the band and clouds, and thin out where there's none
  float keep = L.z * mix(1.0, clamp(crowd, 0.0, 1.0), far);
  float reach = min(REACH[i] + sl, cellPx * 0.95) / cellPx;
  int x0 = f.x < reach ? -1 : 0, x1 = f.x > 1.0 - reach ? 1 : 0;
  int y0 = f.y < reach ? -1 : 0, y1 = f.y > 1.0 - reach ? 1 : 0;
  vec3 col = vec3(0.0);
  for (int dy = -1; dy <= 1; dy++) {
    if (dy < y0 || dy > y1) continue;
    for (int dx = -1; dx <= 1; dx++) {
      if (dx < x0 || dx > x1) continue;
      vec2 o = vec2(float(dx), float(dy));
      vec2 s = cell + o + float(i) * 71.37;
      float h = hash(s);
      if (h > keep) continue;
      vec2 d = (f - o - hash2(s * 1.731)) * cellPx;
      if (sl > 0.0) d -= sv * clamp(dot(d, sv) / dot(sv, sv), 0.0, 1.0);
      float d2 = dot(d, d);
      float rr = REACH[i] + sl;
      if (d2 > rr * rr) continue;
      float m = hash(s * 2.917);
      // Most stars faint, a few bright
      float lum = LUM[i] * (0.22 + 0.78 * m * m * m) * (m > 0.985 ? 1.8 : 1.0);
      float r = SIZE[i] * (0.6 + 1.2 * m * m * m * m);
      float q = d2 / (r * r);
      float I = exp(-q * 1.2) + 0.1 * lum * exp(-sqrt(q) * 0.7);
      // Diffraction spikes on the brightest near stars
      if (i < 2 && m > 1.0 - uStarMix.w * 0.08) {
        vec2 e = vec2(dot(d, uSpike), dot(d, vec2(-uSpike.y, uSpike.x)));
        float len = r * 11.0;
        I += 0.55 * (exp(-abs(e.y) * 1.4) * exp(-abs(e.x) / len) + exp(-abs(e.x) * 1.4) * exp(-abs(e.y) / len));
      }
      // A slow shimmer
      float ph = hash(s * 4.13);
      I *= 1.0 + 0.18 * sin(uTime * (0.6 + 2.0 * ph) + ph * 6.2832) * (1.0 - far);
      float t = clamp(hash(s * 5.13) * 0.85 + 0.15 + uStarMix.x * 0.45, 0.0, 1.0);
      vec3 c = starColor(t * t * (3.0 - 2.0 * t));
      // Behind dust: dimmer and redder
      float ext = dust * far;
      c *= mix(vec3(1.0), vec3(1.0, 0.7, 0.5), ext * 0.7) * (1.0 - ext * 0.85);
      // Fading in as the layer's share of cells grows (zooming), smoothly not popping
      float fade = clamp((keep - h) / (0.35 * keep + 1e-4), 0.0, 1.0);
      col += c * I * lum * fade;
    }
  }
  return col * L.w;
}

/** A distant galaxy or a globular cluster, one per cell at most, well inside it */
vec3 deepSky(vec2 off, float dust) {
  float cellPx = uDeep.y * uDeep.x;
  vec2 g = uCamera / uDeep.y + off / cellPx;
  vec2 cell = floor(g);
  vec2 s = cell + 913.7;
  float h = hash(s);
  if (h > uDeep.z + uDeep.w) return vec3(0.0);
  vec2 d = (g - cell - 0.25 - 0.5 * hash2(s * 1.37)) * cellPx;
  float R = (9.0 + 26.0 * pow(hash(s * 3.71), 2.0)) * cellPx / 700.0;
  float l = length(d);
  if (l > R * 2.4) return vec3(0.0);
  vec3 col;
  if (h < uDeep.z) {
    // Galaxy: an inclined disc, a bright core, spiral arms (or a smooth ellipse)
    float ang = hash(s * 5.3) * 6.2832, tilt = 0.22 + 0.78 * hash(s * 6.1);
    vec2 e = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * d;
    e.y /= tilt;
    float rr = length(e) / R;
    float core = exp(-rr * rr * 28.0);
    float disk = exp(-rr * 3.0);
    float arms = 0.5 + 0.5 * sin(2.0 * atan(e.y, e.x) + log(rr + 0.04) * 5.5 * (hash(s * 7.7) > 0.5 ? 1.0 : -1.0));
    float spiral = step(0.35, hash(s * 8.9));
    float body = disk * mix(0.75, 0.3 + 1.1 * arms * smoothstep(0.04, 0.25, rr), spiral);
    col = vec3(1.0, 0.86, 0.68) * core * 1.2 + mix(vec3(0.92, 0.88, 1.0), vec3(0.62, 0.74, 1.0), clamp(rr * 1.4, 0.0, 1.0)) * body * 0.55;
  } else {
    // Globular cluster: a soft glow, resolving into a swarm of tiny stars
    float k = l / R;
    col = vec3(1.0, 0.9, 0.75) * exp(-k * k * 2.2) * 0.1;
    vec2 sc = floor(d / 2.6);
    float sh = hash(sc + s);
    if (sh < exp(-k * k * 1.6) * 0.75) {
      vec2 sp = (sc + hash2(sc * 1.3 + s)) * 2.6;
      col += vec3(1.0, 0.92, 0.8) * exp(-dot(d - sp, d - sp) * 1.4) * (0.35 + 0.6 * hash(sc * 2.1 + s));
    }
  }
  return col * (1.0 - dust * 0.85);
}

/** Dust motes drifting just past the camera */
vec3 motes(vec2 off) {
  if (uMotes.z <= 0.003) return vec3(0.0);
  float z = uMotes.x, cellPx = uMotes.y * z;
  vec2 g = uCamera / uMotes.y + off / cellPx;
  vec2 cell = floor(g);
  vec2 s = cell + 333.3;
  if (hash(s) > 0.55) return vec3(0.0);
  vec2 d = (g - cell - 0.2 - 0.6 * hash2(s * 1.9)) * cellPx;
  vec2 sv = uStreak * z;
  float sl = min(length(sv), cellPx * 0.18);
  if (sl > 0.3) { sv = normalize(sv) * sl; d -= sv * clamp(dot(d, sv) / dot(sv, sv), 0.0, 1.0); }
  float I = exp(-dot(d, d) * 1.1);
  return uMoteColor * I * uMotes.z * (0.4 + 0.6 * hash(s * 3.3));
}

void main() {
  vec2 off = lensed(turned((vUV - 0.5) * uRes));
  // The sky behind this pixel (same field as the haze, so stars follow its band and dust)
  vec2 sky = uCamera + off / uSky.x;
  Fields F = skyFields(sky);
  float crowd = (0.3 + uStarMix.z * F.band + 0.7 * F.neb) * (0.55 + 0.9 * F.b.a);
  vec3 col = layer(0, uL0, off, crowd, F.dust) + layer(1, uL1, off, crowd, F.dust) + layer(2, uL2, off, crowd, F.dust)
           + layer(3, uL3, off, crowd, F.dust) + layer(4, uL4, off, crowd, F.dust) + layer(5, uL5, off, crowd, F.dust);
  col = col * uTint * uStarMix.y + deepSky(off, F.dust) + motes(off);
  fragColor = vec4(col, 0.0);
}
`;
