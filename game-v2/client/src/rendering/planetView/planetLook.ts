/**
 * The planets' look from space (docs/rendering/planet-prototypes.md; in the game since 2026-10-31: PlanetRenderer and
 * the brown dwarf draw with it). One fragment body for every planet, moon and the brown dwarf, on shaderQuad (vUV
 * across the quad, premultiplied out, GLSL_COMMON prepended) plus one texture, the baked noise volume (planetNoise.ts,
 * uploaded by planetNoiseTexture.ts). Three detail levels (planetFragment): lite, standard, fine.
 *
 * What's new against the game's shader:
 * - The edge: an atmosphere with real thickness. The haze's optical depth follows the view ray through a shell
 *   (thin over the face, thick at the limb, falling off with height outside it), so the disc's own edge fades into
 *   the same haze that carries on into space: no plain alpha fade, no ring. The haze is lit with a twilight wrap
 *   past the terminator and turns to a per-planet sunset colour there. The terminator itself is a soft knee, wider
 *   under thicker air. Gas giants are limb-darkened under the haze. All widths are in planet radii (world space)
 *   but never under 1.5 px, so the edge is soft at every zoom.
 * - Gas giants: belts and zones of their own widths and tints, jets that really flow (each latitude at its own
 *   speed, two-phase flow so it never smears), turbulence torn hardest on the shear lines, a great storm the bands
 *   bend round and the cloud spirals into, a string of small white ovals, mottled polar hoods.
 * - Solid worlds: relief lit from the star (the height is read again a step toward the light: craters, canyons and
 *   ridges cast light and shade), Worley craters, crack networks, dunes, canyons, polar caps; oceans with deep sea,
 *   shelves and shallows, land by climate with mountain ranges, sun glint, clouds banded by the climate and wound round
 *   cyclones (with their shadows), and a settled world's town lights at night; lava that glows through its cracks and
 *   lights its own haze.
 * - Rings: a radial profile from the noise (mipmapped, so no moiré far out), transparency from optical depth, a
 *   soft-edged planet shadow with a penumbra, and faint clumping along the orbit.
 * - Every look is data (`PlanetLook`): defaults per kind from the planet's hue, overrides per planet in systems.json
 *   (`look`).
 * - Cracks (ice lineae, lava rivers, desert canyons): read from the volume (standard), or on the fine level worked out
 *   exactly per pixel wherever the volume is magnified, antialiased to the pixel, so they're never pixelated.
 */

import type { PlanetData, PlanetKind, PlanetLookData } from '@space-game/common';

export const PLANET_KIND_INDEX: Record<PlanetKind | 'dwarf', number> = { rocky: 0, desert: 1, ice: 2, gas: 3, lava: 4, ocean: 5, toxic: 6, dwarf: 7 };

/** The fragment body (uniforms declared by shaderQuadProgram from `planetLookUniforms`, plus uNoise here) */
export const PLANET_PROTO_FRAG = /* glsl */ `
  uniform highp sampler3D uNoise;
  const float PI = 3.14159265;

  /**
   * The noise at p, read at an explicit mip level: s is how many tiles of the volume a planet radius spans along p's
   * steepest direction, gFoot the radii a pixel covers there. (No implicit derivatives: ANGLE's HLSL backend flattens
   * any branch holding a texture() call, so every kind's code and every optional read would run on every pixel.)
   */
  float gFoot = 1e-3;
  vec4 tn(vec3 p, float s) { return textureLod(uNoise, p, log2(max(gFoot * s * 64.0, 1e-3))); }
  /** Rotate about the planet's axis (screen y): body-fixed from view, by its spin angle */
  vec3 spinY(vec3 v, float a) { float c = cos(a), s = sin(a); return vec3(c * v.x + s * v.z, v.y, -s * v.x + c * v.z); }
  /** max(d, 0) with a soft knee of half-width k (the terminator) */
  float softLit(float d, float k) { float h = clamp(d + k, 0.0, 2.0 * k); return d > k ? d : h * h / (4.0 * k); }
  float wrapPi(float a) { return mod(a + PI, 2.0 * PI) - PI; }

  // ---------------------------------------------------------------- cracks (ice lineae, lava rivers, canyons)
#ifdef PLANET_FINE
  precision highp int;
  /** The jittered point of the bake's cell w (0..4 each way): planetNoise.ts hash3 at seeds 303, 304, 305, bit for bit */
  vec3 bakePoint(vec3 w) {
    uvec3 u = uvec3(w);
    uint b = u.x * 374761393u + u.y * 668265263u + u.z * 2147483647u + 303u * 144665u;
    uvec3 h = uvec3(b, b + 144665u, b + 2u * 144665u);
    h = (h ^ (h >> 13u)) * 1274126177u;
    h ^= h >> 16u;
    return vec3(h) * (1.0 / 4294967296.0);
  }
  /**
   * The volume's crack channel (A: Worley F2 - F1, 5 cells a tile, the bake's seed 303) worked out exactly at q (in
   * tiles) instead of read from 64 texels a tile: the same network, smooth however close (planetNoise.ts worleyEdge's
   * points). x: the value as baked (normalised) up to cap (as far as the look reads it; past it nothing changes, and it
   * is cap); yzw: its gradient per tile.
   *
   * F1 (the nearest point) is exact; F2 is a soft minimum (log-sum-exp, K cells) over all the others, kept relative to
   * F1 as it changes. The hard F2 has creases wherever the second and third nearest swap, which would light as hard
   * lines in the relief (the texture's filtering always softened them); the soft one is smooth but at the cracks.
   * Only the points that can count are visited: uCrack lists them for each eighth of a cell each way (planetNoise.ts
   * planetCrackCells; nearest first, 4 or 5 of them on average), in place of a 4x4x4 search.
   */
  uniform highp sampler3D uCrack;
  const float K = 0.025, KL = 1.442695 / K, CRACK_CAP = 0.2;
  void crackVisit(vec3 c, vec3 x, inout float f1, inout vec3 n1, inout float S, inout vec3 G) {
    // (the cell wrapped to the tile in floats: (c + 0.5) / 5 is never near a whole number, so floor can't slip)
    vec3 dv = x - c - bakePoint(c - 5.0 * floor((c + 0.5) * 0.2));
    float l = max(dot(dv, dv), 1e-10), inv = inversesqrt(l), f = l * inv;
    vec3 n = dv * inv;                     // (its gradient)
    if (f < f1) {
      float r = exp2((f - f1) * KL);
      S = S * r + r;
      G = G * r + n1 * r;
      f1 = f;
      n1 = n;
    } else {
      float e = exp2((f1 - f) * KL);
      S += e;
      G += n * e;
    }
  }
  vec4 crackAt(vec3 q, float cap) {
    vec3 x = (q - 0.5 / 64.0) * 5.0;      // (the bake's texel i is the noise at i/64; GL samples it at (i + 0.5)/64)
    vec3 cell = floor(x);
    vec3 sub = floor(x * 8.0);
    sub -= 40.0 * floor((sub + 0.5) / 40.0);
    ivec3 t = ivec3(sub) * ivec3(4, 1, 1);
    float f1 = 1e3, S = 0.0;
    vec3 n1 = vec3(0.0), G = vec3(0.0);
    for (int j = 0; j < 4; j++) {
      vec4 slots = texelFetch(uCrack, t + ivec3(j, 0, 0), 0) * 255.0 + 0.5;
      if (slots.x > 255.0) break;
      for (int k = 0; k < 4; k++) {
        float id = floor(slots[k]);
        if (id > 254.5) break;
        vec3 o = vec3(id - 5.0 * floor((id + 0.5) * 0.2), floor((id + 0.5) * 0.2) - 5.0 * floor((id + 0.5) * 0.04), floor((id + 0.5) * 0.04));
        crackVisit(cell + o - 2.0, x, f1, n1, S, G);
      }
    }
    float v = -0.6931472 * K * log2(max(S, 1e-30)) / 0.6;
    return v < cap ? vec4(max(v, 0.0), (G / S - n1) * (5.0 / 0.6)) : vec4(cap, 0.0, 0.0, 0.0);
  }
#endif
  /**
   * A read's crack channel: x the value, y how much it changes across a pixel (0 when read), z its value a step dq
   * (tiles) along (-1: read it there). Standard: the texel value. PLANET_FINE: worked out exactly wherever the volume is
   * magnified (a texel past a pixel) and near a crack, so cracks never show texel steps; the step is then free (from
   * the gradient). cap: the most the look reads (its widest line or glow; a line is also never under a pixel wide);
   * need: whether it's wanted at all here (a line's mask). Where the texel says no crack is within the cap (its value can
   * be off by a texel's worth of the field's slope) it isn't worked out.
   */
  vec3 ck(vec4 t, vec3 q, float s, vec3 dq, float cap, float need) {
#ifdef PLANET_FINE
    float w = smoothstep(1.0, 0.5, gFoot * s * 64.0);
    // (a line's antialiasing reads past its width by up to a pixel's worth of the field: 2 cells a cell, 5 cells a tile)
    float c = min(cap + (10.0 / 0.6) * gFoot * s * w, CRACK_CAP);
    float ta = min(t.a, c);
    if (w > 0.0 && need > 0.0 && t.a < c + 0.2) {
      vec4 e = crackAt(q, c);
      // (the field is a V at a crack, |sigma| with sigma smooth, its gradient flipping there: so the value a step along is
      // |v + g.dq| on either side, not v + g.dq, which would jump as the step crosses the crack)
      return vec3(mix(ta, e.x, w), length(e.yzw) * gFoot * s * w, dq == vec3(0.0) ? -1.0 : min(abs(e.x + dot(e.yzw, dq)), c));
    }
    return vec3(ta, 0.0, w > 0.0 ? c : -1.0);
#else
    return vec3(t.a, 0.0, -1.0);
#endif
  }
  /**
   * The finest cracks, in patches (PLANET_FINE). Read, only the few texels that fall near a crack show it, as scattered
   * dashes; worked out exactly the whole network shows, too busy: so it shows where the ground's own noise says.
   */
  float fineMask(vec4 d) {
#ifdef PLANET_FINE
    return smoothstep(0.42, 0.6, d.g * 0.7 + d.r * 0.3);
#else
    return 1.0;
#endif
  }
  /**
   * Ice's lineae in long patches (PLANET_FINE): read, the thin lines show only in scattered stretches (where texels
   * fall near them); worked out exactly the whole network would show, a honeycomb over the ice. These keep about the
   * density the standard level shows, each stretch fading out along its line. mA: the broad lineae, mD: the finer.
   */
  float maskA(vec4 a) {
#ifdef PLANET_FINE
    return smoothstep(0.44, 0.6, a.g);
#else
    return 1.0;
#endif
  }
  float maskD(vec4 a, vec4 d) {
#ifdef PLANET_FINE
    return smoothstep(0.42, 0.6, d.r * 0.6 + a.g * 0.4);
#else
    return 1.0;
#endif
  }
  /** A crack line, smoothstep(w, 0, c): never narrower than a pixel, fading instead (PLANET_FINE; standard: as is) */
  float line(vec3 c, float w) {
#ifdef PLANET_FINE
    float ww = max(w, c.y);
    return smoothstep(ww, 0.0, c.x) * (w / ww);
#else
    return smoothstep(w, 0.0, c.x);
#endif
  }

  // ---------------------------------------------------------------- gas giants (and the brown dwarf, and toxic decks)
  /**
   * A hash of a small number pair (a band's number and the planet's seed) for the band tints and the string of ovals. No
   * sin: the common hash's sin(dot(p, (127.1, 311.7))) is fed about 27000 here, where a float32 sin on the GPU is only
   * good to about 0.002 and times 43758 that is no longer a number: now and then a frame came out with whole bands in
   * the other tint (a band flicker, about one frame in 700 on a gas giant; measured 23 events in 16,800 frames before,
   * 1 in 14,400 after). This one (Dave Hoskins' hash12) only does fract, multiply and dot on small values.
   */
  float hashP(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
  /** Zonal jet speed at a latitude (alternating, strongest at the equator) */
  float jetAt(float lat) {
    return (sin(lat * uBands.x + uSeed.x) * 0.7 + sin(lat * uBands.x * 2.3 + 1.3) * 0.3) * (1.0 - 0.4 * abs(lat));
  }

  /**
   * The cloud deck: returns its colour; heat is how much shows through from below (the brown dwarf glows there).
   * lon is the spinning longitude, lat the latitude, b the body-fixed normal, px radii per pixel.
   */
  vec3 gasGiant(float lon, float lat, vec3 b, float px, float lite, out float heat) {
    float F = uBands.x;
    float jet = jetAt(lat);
    float shear = abs(cos(lat * F + uSeed.x));

    // The great storm, carried by its own band's jet (continuously: it never jumps)
    float sLat = uStorm.y;
    float sLon = uStorm.x + jetAt(sLat) * uBands.z * uTime;
    vec2 sd = vec2(wrapPi(lon - sLon) * cos(lat), lat - sLat) / (uStorm.z * vec2(2.1, 1.0));
    float sr = length(sd);
    // The cloud spirals into it: turn the coordinates the noise is read at, most at the centre
    float swirl = uStormCol.r > -1.0 ? exp(-sr * sr * 1.6) * 2.6 : 0.0;
    vec2 sw = sd;
    if (swirl > 0.01) {
      float ca = cos(swirl), sa = sin(swirl);
      sw = mat2(ca, -sa, sa, ca) * sd;
    }
    vec2 lonlat = vec2(lon, lat);
    if (sr < 2.5) lonlat = vec2(sLon + sw.x * uStorm.z * 2.1 / max(cos(lat), 0.2), sLat + sw.y * uStorm.z);

    // Two-phase flow along the jets: each phase drifts for a period, the two crossfaded so neither smears
    float T = uTime / 24.0;
    float p0 = fract(T), p1 = fract(T + 0.5);
    float w0 = 1.0 - abs(2.0 * p0 - 1.0);
    float span = jet * uBands.z * 24.0;
    vec3 base = vec3(uSeed * 0.013, 0.37 + uSeed.x * 0.0071);
    // (lon wraps: NX whole tiles around, NY across the latitudes; features about twice as wide as tall)
    const float NX = 3.0, NY = 3.4;
    // (tiles a radius of arc spans, across the longitudes and the latitudes)
    float sx = NX / (2.0 * PI) / max(cos(lat), 0.2), sy = NY / PI;
    vec2 acc = vec2(0.0);
    float detail = 0.0, fine = 0.0;
    float fineW = lite > 0.5 ? 0.0 : smoothstep(0.004, 0.0015, px);
    for (int k = 0; k < 2; k++) {
      if (lite > 0.5 && k == 1) break;
      float ph = k == 0 ? p0 : p1;
      float wk = lite > 0.5 ? 1.0 : (k == 0 ? w0 : 1.0 - w0);
      vec2 ll = lonlat + vec2((ph - 0.5) * span, 0.0);
      vec3 q = vec3(ll.x / (2.0 * PI) * NX, ll.y / PI * NY, 0.0) + base;
      vec4 a = tn(q, max(sx, sy));
      // turbulence torn hardest along the shear between bands (curls: the warp is mostly along the flow)
      vec2 warp = (a.rg - 0.5) * vec2(0.5 + 1.4 * shear, 0.1 + 0.18 * shear) * uBands.y;
      vec4 d = tn(vec3(q.xy * vec2(1.2, 6.5) + warp * vec2(2.6, 0.9), q.z + 0.21), max(1.2 * sx, 6.5 * sy));
      acc += (a.rg - 0.5) * wk;
      detail += (d.r * 0.65 + d.g * 0.35) * wk;
      if (fineW > 0.0) fine += (tn(vec3(q.xy * vec2(4.0, 16.0) + warp * vec2(6.0, 3.0) + (d.rg - 0.5) * vec2(0.6, 0.2), q.z + 0.53), max(4.0 * sx, 16.0 * sy)).g - 0.5) * wk;
    }

    // Belts and zones: each band its own brightness and tint, edges pushed about by the turbulence
    float bnd = lat * F * 1.15 + acc.x * uBands.y * (0.55 + 0.9 * shear) + (detail - 0.5) * 0.45;
    // the bands bow round the storm
    bnd += exp(-sr * sr * 0.7) * 0.45 * sd.y / (abs(sd.y) + 0.35);
    float bi = floor(bnd), bf = fract(bnd);
    float h0 = hashP(vec2(bi, uSeed.y)), h1 = hashP(vec2(bi + 1.0, uSeed.y));
    float bv = mix(h0, h1, smoothstep(0.2, 0.8, bf));
    float zone = smoothstep(0.32, 0.68, bv);
    vec3 belt = uPal1 * (0.85 + 0.3 * hashP(vec2(bi, 7.0 + uSeed.y)));
    vec3 c = mix(belt, uPal0, zone);
    // dark lanes where a pale zone meets a dark belt
    float lane = exp(-pow((bf - 0.5) / 0.09, 2.0)) * abs(h1 - h0);
    c = mix(c, uPal2, clamp(lane * 1.4, 0.0, 0.75) * (0.6 + 0.6 * detail));
    // the cloud's own texture: brighter tops, darker gaps
    c *= 0.72 + detail * 0.55 + fine * 0.22 * fineW;
    heat = smoothstep(0.45, 0.2, detail + fine * 0.3) * (1.0 - zone);
    // small vortices along the shear lines: pale anticyclones, dark cyclones
    float vx = detail + acc.y * 0.6;
    c = mix(c, uPal0 * 1.08, smoothstep(0.66, 0.8, vx) * shear * 0.5 * uDetail.y);
    c = mix(c, uPal2, smoothstep(0.32, 0.2, vx) * shear * 0.35 * uDetail.y);

    // A string of small white ovals in one band
    if (uStorm2.y > 0.5) {
      float n = uStorm2.y, step2 = 2.0 * PI / n;
      float oLon = lon - jetAt(uStorm2.x) * uBands.z * uTime - uSeed.x;
      float k2 = floor(oLon / step2 + 0.5);
      float jit = (hashP(vec2(k2, uSeed.y)) - 0.5) * step2 * 0.4;
      vec2 od = vec2(wrapPi(oLon - k2 * step2 - jit) * cos(lat), lat - uStorm2.x) / (uStorm2.z * vec2(1.5, 1.0));
      float orr = length(od + (vec2(detail, acc.y) - 0.5) * 0.25);
      c = mix(c, uPal0 * 1.12, smoothstep(0.85, 0.45, orr) * 0.85);
      c = mix(c, uPal2, smoothstep(0.75, 0.95, orr) * smoothstep(1.25, 0.95, orr) * 0.35);
    }

    // The great storm: an oval of its own colour, a pale collar, a spiral texture inside
    if (uStormCol.r > -1.0 && sr < 1.6) {
      float spiral = 0.5 + 0.5 * sin(atan(sw.y, sw.x) * 2.0 + sr * 9.0 + detail * 5.0 - uTime * 0.15);
      vec3 core = mix(uStormCol * 0.75, uStormCol * 1.15 + 0.05, spiral * 0.6 + detail * 0.4);
      c = mix(c, core, smoothstep(0.95, 0.55, sr) * 0.92);
      c = mix(c, uPal0 * 1.05, smoothstep(0.85, 1.0, sr) * smoothstep(1.35, 1.0, sr) * 0.55);
    }

    // Polar hoods: hazier, cooler, mottled with small cyclones (read on the sphere: no pinch at the pole)
    float pole = smoothstep(0.82, 1.25, abs(lat));
    if (pole > 0.0) {
      float m = lite > 0.5 ? 0.5 : tn(b * 1.7 + vec3(0.0, 0.0, uSeed.y * 0.01), 1.7).g;
      vec3 hood = mix(uPal2, uPal0, 0.45) * mix(0.75, 1.05, m);
      c = mix(c, hood, pole * 0.8);
    }
    return c;
  }

  // ---------------------------------------------------------------- solid worlds
  /** The two reads a solid world's ground is built from (a: broad, d: finer, warped by a), in tiles */
  vec3 qA(vec3 b) { return b * uDetail.x * 0.5 + vec3(uSeed * 0.011, 0.31); }
  vec3 qD(vec3 b, vec4 a) { return b * uDetail.x * 1.3 + vec3(0.7, uSeed * 0.017) + (a.rgr - 0.5) * 0.35; }
  // (ocean worlds)
  /**
   * The ocean world's sea-floor height (0..1, land above 0.555): the continents' own broad read, edged by a and, for a
   * finer coast, d. Read once a pixel: heightOf's first call keeps it in gSeaH, the relief's step and solidSurface reuse it.
   */
  float gSeaH = -1.0;
  /** How lit the cloud tops are (1: fully; an ocean world's clouds are shaded on their flanks away from the star) */
  float gCloudLit = 1.0;
  /** How much of a pixel is land, lit more softly (the ground scatters the light about; water doesn't) */
  float gLandLit = 0.0;
  float seaH(vec3 b, vec4 a, vec4 d) {
    float s = uDetail.x;
    // (uSea.x: how far the sea stands above the usual level: a water world's land is only its highest ground)
    return tn(b * s * 0.22 + vec3(0.13, uSeed * 0.01), s * 0.22).r * 0.8 + a.r * 0.2 + 0.04 + (d.r - 0.5) * 0.05 - uSea.x;
  }
  /** Mountain ranges (0..1): ridged along the d read's field, in some parts of the land (a.g), inland */
  float seaMountains(vec4 a, vec4 d, float h) {
    return smoothstep(0.6, 0.88, d.r) * smoothstep(0.45, 0.72, a.g) * smoothstep(0.57, 0.66, h);
  }
  /**
   * The cloud layer turned about its weather systems: cyclones in the storm tracks, each hemisphere's turning its own
   * way, a tight twist at the middle easing out (so the cloud read there winds into a spiral), drifting east. n: how
   * many (lite: fewer). boost: the cover they add (a clear eye at the middle).
   */
  vec3 seaCyclones(vec3 cb, out float boost) {
    boost = 0.0;
    // (they drift east together; their places are fixed in that frame, from the seed. They never overlap, so only the
    // nearest is worked out)
    cb = spinY(cb, -uTime * 0.0012);
#ifdef PLANET_LITE
    const int N = 2;
#else
    const int N = 4;
#endif
    float best = 1e3, hem = 1.0, size = 1.0;
    vec3 c = vec3(0.0, 1.0, 0.0);
    vec2 dir = vec2(1.0, 0.0);
    for (int k = 0; k < N; k++) {
      float fk = float(k);
      float hk = fk - 2.0 * floor(fk * 0.5) < 0.5 ? 1.0 : -1.0;
      float cy = hk * (0.5 + 0.3 * fract(fk * 0.618034 + uSeed.x * 0.0311));
      vec2 dk = normalize(vec2(fract(fk * 0.381966 + uSeed.y * 0.0173), fract(fk * 0.7071 + uSeed.x * 0.0129)) - 0.5 + 1e-3);
      vec3 ck = vec3(dk * sqrt(1.0 - cy * cy), cy).xzy;
      float sk = 0.26 + 0.1 * fract(fk * 0.7548 + uSeed.y * 0.011);
      float rk = length(cb - ck) / sk;
      if (rk < best) { best = rk; c = ck; hem = hk; size = sk; dir = dk; }
    }
    float rr = best;
    if (rr < 2.0) {
      // (its arms: a two-armed log spiral in its own tangent frame, wound the hemisphere's way)
      vec3 v = cb - c;
      vec3 e1 = vec3(-dir.y, 0.0, dir.x), e2 = cross(c, e1);
      float arm = 0.5 + 0.5 * sin(2.0 * atan(dot(v, e2), dot(v, e1)) + hem * 4.5 * log(rr + 0.08));
      float r2 = rr * rr, fall = exp(-r2 * 0.9);
      boost = (arm - 0.4) * fall * 0.45 + fall * 0.05 - exp(-r2 * 40.0) * 0.4;
      float th = hem * 1.8 * exp(-r2 * 1.6);
      float ct = cos(th), st = sin(th);
      cb = cb * ct + cross(c, cb) * st + c * dot(c, cb) * (1.0 - ct);
    }
    return cb;
  }

  /** Whether a kind's look uses the crack channel of the a read (ice), and of the d read (desert, ice, lava) */
  bool cracksA() { return uKind > 1.5 && uKind < 2.5; }
  bool cracksD() { return uKind > 0.5 && uKind < 4.5 && !(uKind > 2.5 && uKind < 3.5); }

  /** The height field a kind's relief is lit from (0..1), from its reads (ca, cd: their crack channels, ck) */
  float heightOf(vec3 b, vec4 a, vec4 d, vec3 ca, vec3 cd) {
    float s = uDetail.x;
    if (uKind < 0.5) {
      // rocky: rolling ground, craters (bowl and raised rim) at two sizes
      float c1 = smoothstep(0.45, 0.05, d.b) * -0.55 + smoothstep(0.32, 0.5, d.b) * smoothstep(0.7, 0.5, d.b) * 0.35;
      float c2 = smoothstep(0.42, 0.08, a.b) * -0.4 + smoothstep(0.34, 0.5, a.b) * smoothstep(0.66, 0.5, a.b) * 0.22;
      return a.r * 0.6 + c1 * 0.35 + c2 * 0.4;
    } else if (uKind < 1.5) {
      // desert: mesas and canyons along the cells' edges, dunes
      float canyon = line(cd, 0.1) * smoothstep(0.62, 0.4, a.r);
      return a.r * 0.75 + d.g * 0.2 - canyon * 0.3;
    } else if (uKind < 2.5) {
      // ice: low swells, ridged lineae (a double ridge each side of a crack)
      float mA = maskA(a), mD = maskD(a, d);
      float l1 = max(line(ca, 0.08) * mA, line(cd, 0.06) * smoothstep(0.3, 0.6, d.g) * mD);
      float l0 = max(line(ca, 0.025) * mA, line(cd, 0.02) * smoothstep(0.3, 0.6, d.g) * mD);
      return a.r * 0.35 + l1 * 0.25 - l0 * 0.3;
    } else if (uKind < 4.5) {
      // lava: crust plates between glowing cracks
      return a.r * 0.5 + smoothstep(0.0, 0.2, cd.x) * 0.3;
    }
    // ocean: the sea is level (the coast casts no shade), only the mountain ranges have relief
    if (gSeaH < 0.0) gSeaH = seaH(b, a, d);
    return (seaMountains(a, d, gSeaH) * 0.2 + d.g * 0.03) * smoothstep(0.56, 0.6, gSeaH);
  }

  vec3 solidSurface(vec3 b, vec3 lb, float lat, float px, vec4 a, vec4 d, vec3 ca, vec3 cd, out float emit, out float spec, out float cloud, out float cloudShade) {
    emit = 0.0; spec = 0.0; cloud = 0.0; cloudShade = 0.0;
    float fineW = smoothstep(0.004, 0.0012, px);
    if (uKind < 0.5) {
      // rocky: highlands and dark maria, crater floors, bright fresh rays from the youngest
      float maria = smoothstep(0.45, 0.62, tn(b * uDetail.x * 0.22 + 3.1, uDetail.x * 0.22).r);
      vec3 c = mix(uPal0, uPal1, maria * 0.75);
      c *= 0.82 + a.g * 0.3;
      c = mix(c, uPal2, smoothstep(0.35, 0.05, d.b) * 0.35);
      c += uPal0 * smoothstep(0.12, 0.0, d.b) * 0.25;
      return c;
    } else if (uKind < 1.5) {
      // desert: sand seas with dunes, dark rock in the canyons, frost caps
      float dune = sin(dot(b, vec3(13.0, 41.0, 7.0)) * uDetail.x * 0.35 + d.g * 9.0) * 0.5 + 0.5;
      vec3 c = mix(uPal1, uPal0, a.r * 0.7 + dune * 0.3 * fineW + 0.15);
      c = mix(c, uPal2, line(cd, 0.1) * smoothstep(0.62, 0.4, a.r) * 0.55 + smoothstep(0.58, 0.75, a.r) * 0.35);
      float cap = smoothstep(0.86, 0.93, abs(b.y) + (a.g - 0.5) * 0.1);
      return mix(c, vec3(0.93, 0.9, 0.88), cap * 0.9);
    } else if (uKind < 2.5) {
      // ice: white-blue sheets, rust-tinted lineae, blue-grey old ice
      vec3 c = mix(uPal1, uPal0, smoothstep(0.3, 0.7, a.r) * 0.8 + a.g * 0.2);
      float lines = max(line(ca, 0.06) * maskA(a), line(cd, 0.05) * smoothstep(0.2, 0.5, d.g) * 0.7 * maskD(a, d));
      if (fineW > 0.0) {
        vec3 qf = b * uDetail.x * 4.0 + 1.7;
        float fm = fineMask(d);
        lines = max(lines, line(ck(tn(qf, uDetail.x * 4.0), qf, uDetail.x * 4.0, vec3(0.0), 0.035, fm), 0.035) * 0.6 * fineW * fm);
      }
      return mix(c, uPal2, lines * 0.8);
    } else if (uKind < 4.5) {
      // lava: black crust, glowing cracks and lakes, pulsing slowly
      // the rivers: a coarse crack network (its own read, warped), a glow round each, fine cracks between
      vec3 qb = b * 0.6 + (a.rgr - 0.5) * 0.05 + vec3(0.21, uSeed * 0.013);
      vec4 tb = tn(qb, 0.6);
      // (the river's core from the crack channel, worked out on the fine level; its faint wide halo as read)
      float big = ck(tb, qb, 0.6, vec3(0.0), 0.12, 1.0).x;
      float river = smoothstep(0.12, 0.02, big) + smoothstep(0.35, 0.0, tb.a) * 0.25;
      float crack = max(river, line(cd, 0.05) * 0.35) * (0.7 + 0.3 * smoothstep(0.3, 0.6, a.g));
      float pulse = 0.75 + 0.25 * sin(uTime * 0.35 + a.g * 12.0);
      emit = crack * (0.65 + 0.35 * pulse);
      if (fineW > 0.0) {
        vec3 qf = b * uDetail.x * 4.5;
        float fm = fineMask(d);
        emit = max(emit, line(ck(tn(qf, uDetail.x * 4.5), qf, uDetail.x * 4.5, vec3(0.0), 0.1, fm), 0.1) * 0.5 * fineW * fm);
      }
      vec3 crust = uPal1 * (0.6 + 0.8 * a.g);
      return mix(crust, uPal0, emit);
    }
    // ocean: deep sea, shelves and turquoise shallows; land by climate (rainforest, temperate, arid belts, boreal,
    // tundra), mountain ranges with snow on the peaks; ice caps and sea ice; weather; a settled world's lights at night
    float h = gSeaH;
    float land = smoothstep(0.555, 0.565, h);
    float depth = smoothstep(0.555, 0.3, h);
    // (the shelves a little darker than the shallows' own colour, so the sea sits with the land; the deep a little
    // deeper or shallower in broad patches)
    depth = clamp(depth + (a.r - 0.5) * 0.25, 0.0, 1.0);
    vec3 sea = mix(uPal0 * 0.82, uPal1, smoothstep(0.0, 0.3, depth));
    sea = mix(sea, uPal1 * 0.62, smoothstep(0.45, 1.0, depth));
    sea = mix(sea, uPal0 + vec3(0.0, 0.03, 0.02), smoothstep(0.53, 0.554, h) * 0.38);
    // (faint, broad colour in the water: currents, darker and lighter swathes, green plankton blooms offshore)
    sea *= 0.92 + 0.16 * a.g;
    float bloom = smoothstep(0.6, 0.85, a.r * 0.55 + d.g * 0.45) * smoothstep(0.1, 0.5, depth);
    sea = mix(sea, sea * vec3(0.8, 1.18, 0.98) + vec3(0.0, 0.015, 0.008), bloom * 0.45);
    // (the climate: wet at the equator and on the coasts, a dry belt in the subtropics; latitude ragged by the ground)
    float al = abs(lat) + (d.g - 0.5) * 0.14;
    float coast = smoothstep(0.66, 0.56, h);
    float wet = clamp(a.g * 1.1 + coast * 0.3 + 0.3 * exp(-al * al * 25.0) - 0.4 * exp(-(al - 0.44) * (al - 0.44) * 59.0), 0.0, 1.0);
    vec3 veg = mix(vec3(0.28, 0.4, 0.16), vec3(0.15, 0.29, 0.1), smoothstep(0.42, 0.16, al));
    veg = mix(veg, vec3(0.2, 0.3, 0.16), smoothstep(0.78, 0.98, al));
    vec3 ground = mix(vec3(0.66, 0.54, 0.35), veg, smoothstep(0.22, 0.5, wet));
    ground = mix(ground, vec3(0.52, 0.49, 0.42), smoothstep(1.0, 1.12, al));
    ground *= 0.9 + 0.2 * d.g;
    // (mountains, their snow and the beaches: not on lite, which has no relief to show them)
    float mtn = 0.0;
#ifndef PLANET_LITE
    mtn = seaMountains(a, d, h);
    ground = mix(ground, vec3(0.52, 0.48, 0.41), smoothstep(0.12, 0.45, mtn) * 0.8);
    ground = mix(ground, vec3(0.86, 0.88, 0.9), smoothstep(0.75, 1.0, mtn + al * 0.15) * 0.85);
    ground = mix(vec3(0.76, 0.69, 0.52), ground, smoothstep(0.556, 0.57, h));
#endif
    // (the water's glint, broken by the waves: wind streaks and swell along the latitudes, warped so they never tile;
    // Low: the ground's finer read stands in)
    float waves = d.g;
#ifndef PLANET_LITE
    if (land < 0.99) {
      vec3 wq = b * uDetail.x * vec3(2.2, 9.0, 2.2) + vec3(a.g - 0.5, 0.0, a.r - 0.5) * 0.6 + vec3(0.37, 0.11, 0.73);
      vec4 wv = tn(wq, uDetail.x * 9.0);
      waves = wv.g * 0.65 + d.g * 0.35;
      // (a hint of it in the water's own colour too)
      sea *= 0.97 + 0.06 * wv.g;
    }
#endif
    vec3 c = mix(sea, ground, land);
    float ice = smoothstep(0.9, 0.93, abs(b.y) + (a.g - 0.5) * 0.12 + (d.r - 0.5) * 0.05);
    c = mix(c, mix(vec3(0.82, 0.88, 0.94), vec3(0.94, 0.96, 0.98), land), ice);
    gLandLit = land * (1.0 - ice);
    spec = (1.0 - land) * (1.0 - ice) * (0.35 + 1.1 * waves * waves);

    // The lights of the towns on the night side (the look's emitColor: a settled world's; none by default): along the
    // wet coasts and plains, clustered (the cells' points); dimmed under cloud below
    float night = smoothstep(0.06, -0.14, dot(b, lb)) * land * (1.0 - ice);
    if (uEmitColor.r + uEmitColor.g > 0.0 && night > 0.01) {
      float pop = smoothstep(0.45, 0.8, wet * 0.45 + coast * 0.45 + a.r * 0.3) * smoothstep(1.05, 0.8, al) * (1.0 - smoothstep(0.1, 0.4, mtn));
      float towns = smoothstep(0.36, 0.17, d.b) * (0.35 + 0.65 * d.g);
#ifndef PLANET_LITE
      if (fineW > 0.0) {
        vec4 f = tn(b * uDetail.x * 6.0 + vec3(2.3, 0.7, 1.1), uDetail.x * 6.0);
        towns = max(towns, smoothstep(0.34, 0.18, f.b) * smoothstep(0.35, 0.65, f.r) * fineW * 0.7);
      }
#endif
      emit = night * pop * (towns * 1.1 + 0.03);
    }

    // clouds: their own drift, wound round the weather systems, banded by the climate; read again a step toward the star
    // for their shadow
    float cs = uSpin * 0.6 * uTime;
    float boost;
#ifdef PLANET_LITE
    vec3 cb = spinY(b, cs); boost = 0.0;
#else
    vec3 cb = seaCyclones(spinY(b, cs), boost);
#endif
    // (stretched along the latitudes, warped by the low field)
    vec3 cq = cb * vec3(0.6, 1.3, 0.6) + vec3(a.r - 0.5, 0.0, a.g - 0.5) * 0.12 + vec3(0.0, 0.0, 0.43);
    vec4 cl = tn(cq, 1.3);
    float clat = abs(cb.y);
    float climate = 0.09 * exp(-clat * clat * 120.0) - 0.1 * exp(-(clat - 0.4) * (clat - 0.4) * 59.0) + 0.07 * exp(-(clat - 0.8) * (clat - 0.8) * 51.0) + boost;
    float cv = cl.g * 0.8 + cl.r * 0.2 + climate;
    // (close: the edges torn into wisps by a finer read)
    float fineC = 0.0;
#ifndef PLANET_LITE
    if (fineW > 0.0) fineC = (tn(cq * 4.3 + vec3(0.31, 0.0, 0.17), 1.3 * 4.3).g - 0.5) * 0.34 * fineW;
#endif
    // (crisper edges where the finer read shows)
    float cw = 0.1 - 0.04 * fineW;
    // (thin at the edges, thick and opaque in the middle)
    float cd2 = cv + fineC + uSea.z;
    cloud = smoothstep(0.61 - cw, 0.61 + cw, cd2) * (0.6 + 0.4 * smoothstep(0.66, 0.85, cd2)) * uDetail.z;
    vec4 cs2 = tn(cq + lb * vec3(0.012, 0.024, 0.012), 1.3);
    float cvL = cs2.g * 0.8 + cs2.r * 0.2 + climate + uSea.z;
    cloudShade = smoothstep(0.51, 0.71, cvL) * uDetail.z;
    // (their flanks away from the star: thicker toward it, so shaded)
    gCloudLit = 1.0 - 0.45 * clamp((cvL - cv) * 9.0, 0.0, 1.0);
    emit *= 1.0 - cloud * 0.85;

    return c;
  }

  // ---------------------------------------------------------------- rings
  vec4 rings(vec2 p, float r, vec2 L, float px) {
    float t = (r - uRing.x) / (uRing.y - uRing.x);
    if (t < -0.02 || t > 1.02) return vec4(0.0);
    float pt = px / (uRing.y - uRing.x);
    // the radial profile: broad bands and fine ringlets from the noise (its mips average the ringlets far out)
    float w = uRing.y - uRing.x;
    vec4 n1 = tn(vec3(t * 1.7 + uSeed.x * 0.01, 0.31, 0.77), 1.7 / w);
    vec4 n2 = tn(vec3(t * 9.0, 0.63 + uSeed.y * 0.01, 0.19), 9.0 / w);
    vec4 n3 = tn(vec3(t * 31.0, 0.17, 0.41 + uSeed.x * 0.01), 31.0 / w);
    float dens = mix(0.4, 1.0, smoothstep(0.05, 0.35, t)) * mix(1.0, 0.55, smoothstep(0.62, 0.95, t));
    dens *= 0.45 + 1.1 * n1.r;
    dens *= (0.55 + 0.9 * n2.g) * (0.6 + 0.8 * n3.r);
    // the gaps (where the game's are), at least a pixel soft
    float g1 = smoothstep(0.02, 0.05, abs(t - 0.62) - pt), g2 = smoothstep(0.008, 0.025, abs(t - 0.3) - pt), g3 = smoothstep(0.003, 0.01, abs(t - 0.86) - pt);
    dens *= mix(0.06, 1.0, g1) * mix(0.25, 1.0, g2) * mix(0.35, 1.0, g3);
    // faint clumping along the orbit
    float ang = atan(p.y, p.x);
    dens *= 0.9 + 0.2 * tn(vec3(ang / (2.0 * PI) * 6.0 - uTime * 0.002, t * 5.0, 0.91), max(6.0 / (2.0 * PI * r), 5.0 / w)).r;
    // soft inner and outer edges
    dens *= smoothstep(0.0, 0.04 + pt, t) * smoothstep(1.0, 0.94 - pt, t);
    float alpha = (1.0 - exp(-dens * dens * 1.1)) * uRing.z;
    // the planet's shadow, with a penumbra that widens away from it
    float along = dot(p, L);
    float perp = length(p - along * L);
    float pen = 0.02 + 0.04 * max(-along, 0.0) + px;
    float shadow = along < 0.0 ? mix(0.1, 1.0, smoothstep(1.0 - pen, 1.0 + pen, perp)) : 1.0;
    vec3 col = mix(uRingCol0, uRingCol1, smoothstep(0.1, 0.75, t)) * (0.62 + 0.3 * n2.r);
    return vec4(col * shadow * uLightAmt * alpha, alpha);
  }

  void main() {
    vec2 p = (vUV - 0.5) * 2.0 / uPR;     // 1.0 = the planet's limb (the cloud tops)
    float r = length(p);
    float px = max(fwidth(r), 1e-5);      // planet radii a pixel
    gFoot = px;
    vec2 L = normalize(uLight);
    vec3 l3 = normalize(vec3(L, 0.22));
    float self = step(6.5, uKind);        // the brown dwarf lights itself
    float lite = 0.0;
#ifdef PLANET_LITE
    lite = 1.0;
#endif

    vec4 outc = vec4(0.0);
    if (uRing.y > 0.0) outc = rings(p, r, L, px);

    // The atmosphere: limb optical depth g, scale height H (radii), twilight wrap
    float g = uAtmo.x, H = max(uAtmo.y, 1e-4), wrapW = uAtmo.z;
    // the disc edge: the look's width (an airless ball's too: uEdge.x), never under 1.5 px
    float soft = max(1.5 * px, max(uLimb.z, uEdge.x));

    if (r > 1.0 - soft) {
      // Outside the limb: haze falling off with height, lit round past the terminator; and on an airless ball a faint
      // thin glow of dust and scattered light just off its edge (uEdge2: strength, height)
      float a = max(r - 1.0, 0.0);
      float tau = (g * exp(-a / H) + uEdge2.x * exp(-a / max(uEdge2.y, 1e-4))) * smoothstep(1.0 / uPR, 1.0 / uPR - 0.08, r);
      if (tau > 0.002) {
        vec3 dir = vec3(p / max(r, 1e-4), 0.0);
        float cl = dot(dir, l3);
        float hl = self > 0.5 ? 1.0 : smoothstep(-wrapW - 0.05, 0.45, cl);
        vec3 hc = mix(uAtmoColor, uSunsetColor, exp(-cl * cl / (wrapW * wrapW + 0.01)) * uAtmo2.x);
        float s = 1.0 - exp(-tau);
        vec4 h = vec4(hc * hl * s * uAtmo2.y * (self > 0.5 ? 1.0 : uLightAmt), s * uAtmo2.z * (0.35 + 0.65 * hl));
        outc = h + outc * (1.0 - h.a);
      }
    }

    if (r < 1.0 + soft) {
      float rr = min(r, 0.99999);
      float z = sqrt(1.0 - rr * rr);
      vec3 n = vec3(p / max(r, 1e-5) * rr, z);
      gFoot = px / max(z, 0.08);           // foreshortened toward the limb
      float spinA = uTime * uSpin;
      vec3 b = spinY(n, spinA);            // body-fixed
      float lat = asin(clamp(n.y, -1.0, 1.0));
      float lon = atan(n.x, n.z) + spinA;
      float d0 = dot(n, l3);
      vec3 lb = spinY(l3, spinA);          // the star, in the body's frame
      float emit = 0.0, spec = 0.0, cloud = 0.0, cloudShade = 0.0, heat = 0.0, slope = 0.0;
      vec3 base;
      if (uKind > 2.5 && uKind < 3.5 || uKind > 5.5) {
        base = gasGiant(lon, lat, b, px, (uKind > 5.5 && uKind < 6.5) ? 1.0 : lite, heat);
      } else {
        float sc = uDetail.x;
        vec3 qa = qA(b);
        vec4 a = tn(qa, sc * 0.5);
        vec3 qd = qD(b, a);
        vec4 d = tn(qd, sc * 1.3);
        // relief: the height again a step toward the star (in the body's frame)
        bool relief = lite < 0.5 && uLimb.y > 0.0;
        vec3 tl = lb - b * dot(lb, b);
        float tlen = length(tl), eps = 0.012 / sc;
        vec3 stp = relief ? tl / max(tlen, 1e-4) * eps : vec3(0.0);
        // (ice's lineae only where their masks show them)
        bool ice = uKind > 1.5 && uKind < 2.5;
        vec3 ca = cracksA() ? ck(a, qa, sc * 0.5, stp * sc * 0.5, 0.08, maskA(a)) : vec3(a.a, 0.0, -1.0);
        vec3 cd = cracksD() ? ck(d, qd, sc * 1.3, stp * sc * 1.3, uKind > 3.5 ? 0.2 : ice ? 0.06 : 0.1, ice ? maskD(a, d) : 1.0) : vec3(d.a, 0.0, -1.0);
        float h0 = heightOf(b, a, d, ca, cd);
        if (relief) {
          vec3 b1 = b + stp;
          vec4 a1 = tn(qA(b1), sc * 0.5);
          vec4 d1 = tn(qD(b1, a1), sc * 1.3);
          float h1 = heightOf(b1, a1, d1, vec3(ca.z < -0.5 ? a1.a : ca.z, ca.y, -1.0), vec3(cd.z < -0.5 ? d1.a : cd.z, cd.y, -1.0));
          slope = (h1 - h0) / eps * tlen;
        }
        base = solidSurface(b, lb, lat, px, a, d, ca, cd, emit, spec, cloud, cloudShade);
      }

      // Light: a soft knee at the terminator (wider under thicker air), relief tilting it, reddened in twilight
      float dl = d0 + slope * uLimb.y * 0.012;
      // (rough ground widens it too: craters and ridges catch the light past the line, uEdge.y)
      float tw = uAtmo.z * 0.5 + 0.02 + uEdge.y;
      float lit = softLit(dl, tw) * uLightAmt;
      vec3 sunTint = mix(vec3(1.0), uSunsetColor * 1.6, exp(-d0 * d0 / (tw * tw * 4.0 + 0.002)) * uAtmo2.x * 0.6);
      vec3 c;
      if (self > 0.5) {
        // brown dwarf: its own dull light, strongest where the deck is thin, darkened to the limb
        c = base * (0.55 + 0.45 * z) + uEmitColor * heat * 0.6;
        // its old scar: fractures running out from one point on the equator, still hot at the middle
        vec2 ip = vec2(wrapPi(lon - 2.2), lat - 0.12);
        float id = length(ip * vec2(1.0, 1.5));
        float fine = tn(b * 3.0 + 0.4, 3.0).g;
        float rays = pow(abs(sin(atan(ip.y, ip.x) * 4.0 + fine * 1.4)), 30.0);
        float scar = rays * smoothstep(1.2, 0.12, id) * (0.55 + 0.45 * fine);
        c += uEmitColor * (scar * 0.5 + exp(-id * id * 45.0) * 0.35);
      } else {
        c = base * ((lit + gLandLit * 0.55 * lit * (1.0 - lit)) * sunTint + 0.035);
        // clouds over the surface, their shadow just beside
        c *= 1.0 - cloudShade * 0.45 * step(0.0, d0);
        c = mix(c, vec3(0.96) * gCloudLit * (lit * sunTint + 0.03), cloud * 0.9);
        // sun glint on open water
        vec3 hv = normalize(l3 + vec3(0.0, 0.0, 1.0));
        // (a tight soft highlight and a faint sheen round it; none through thick cloud or its shadow)
        float nh = max(dot(n, hv), 0.0);
        float openSea = spec * clamp(1.0 - cloud * 1.6, 0.0, 1.0) * (1.0 - cloudShade * 0.5) * uLightAmt;
        c += vec3(1.0, 0.95, 0.86) * (pow(nh, 80.0) * 0.85 + pow(nh, 14.0) * 0.035) * uSea.y * openSea;
        // (a water world's sea is most of its face: a broad sheen of the sun round the glint, and the sky mirrored
        // toward the limb, both on the lit side only)
        float glassy = max(uSea.y - 1.0, 0.0);
        c += (vec3(1.0, 0.95, 0.86) * pow(nh, 5.0) * 0.045 + uAtmoColor * pow(1.0 - z, 3.0) * 0.4) * glassy * openSea * smoothstep(0.0, 0.3, d0);
        // lava's glow, strongest on the night side
        c += uEmitColor * emit * (0.55 + 0.45 * (1.0 - smoothstep(0.0, 0.3, d0)));
      }
      // Limb darkening (gas giants): the deck seen through more of itself toward the edge
      c *= mix(1.0, pow(max(z, 0.02), uLimb.y), uLimb.x);
      // Solid worlds: a little darkening to the limb (uEdge2.z), and a thin rim of light on the lit limb (uEdge.z)
      if (self < 0.5) {
        c *= mix(1.0, sqrt(max(z, 0.02)), uEdge2.z);
        float rim = pow(1.0 - z, 4.0) * smoothstep(-0.1, 0.5, d0) * uEdge.z;
        c += (base * 0.7 + 0.12) * rim * uLightAmt;
      }

      // The haze over the face: thin face-on, thick at the limb (the same depth as just outside it)
      float k = sqrt(2.0 * H / PI);
      float tauIn = g * k / sqrt(z * z + k * k);
      float hl = self > 0.5 ? 1.0 : smoothstep(-wrapW - 0.05, 0.45, d0);
      vec3 hc = mix(uAtmoColor, uSunsetColor, exp(-d0 * d0 / (wrapW * wrapW + 0.01)) * uAtmo2.x);
      float s = 1.0 - exp(-tauIn);
      c = c * (1.0 - s) + hc * hl * s * uAtmo2.y * (self > 0.5 ? 1.0 : uLightAmt);

      // The disc's edge: the cloud tops (or ground) give way to the haze over the last stretch, never a hard line
      float edge = smoothstep(1.0 + soft * 0.5, 1.0 - soft, r);
      vec4 disc = vec4(c, 1.0) * edge;
      outc = disc + outc * (1.0 - disc.a);
    }
    fragColor = outc;
  }
`;

/** A planet's look (all of it data). Colours are 0..1 RGB. */
export interface PlanetLook {
  /** Palette: for gas giants zone, belt, lane; rocky highland, maria, crater; desert sand light, sand dark, rock;
   *  ice bright, old ice, lineae; lava (glow, crust); ocean shallow, deep */
  pal: [number[], number[], number[]];
  atmoColor: number[];
  sunsetColor: number[];
  /** Haze optical depth at the limb, scale height in radii, twilight wrap */
  atmo: [number, number, number];
  /** Sunset tint strength, haze brightness, how much the haze hides what's behind it */
  atmo2: [number, number, number];
  /** Limb darkening, gas: its power / solid: relief strength, the disc edge's width in radii */
  limb: [number, number, number];
  /** The edge (any body): the disc edge's width in radii (at least 1.5 px), the terminator's extra width (rough
   *  ground), a thin rim of light on the lit limb */
  edge: [number, number, number];
  /** An airless ball's halo of dust and scattered light just off its limb: strength, height (radii); limb darkening */
  edge2: [number, number, number];
  /** Solid: feature scale, contrast, cloud cover. Gas: (unused), vortex strength, (unused) */
  detail: [number, number, number];
  /** Gas: band frequency, turbulence, jet speed (rad/s) */
  bands: [number, number, number];
  /** Great storm: longitude, latitude, size (radians of latitude); colour (r < -1: none) */
  storm: [number, number, number];
  stormColor: number[];
  /** White ovals: latitude, count, size */
  storm2: [number, number, number];
  /** Lava's glow; an ocean world's town lights on the night side (a settled world's: none by default) */
  emitColor: number[];
  /** An ocean world's water: how far the sea stands above its usual level (0.2: land only on the highest ground),
   *  the sun glint's strength (above 1 it also gets a broad sheen and the sky mirrored toward the limb), cover added
   *  to the clouds */
  sea: [number, number, number];
  spin: number;
  /** Rings: inner, outer (radii), opacity; inner and outer colours */
  ring: [number, number, number];
  ringCol0: number[];
  ringCol1: number[];
}

export function hsl(h: number, s: number, l: number): number[] {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0), f(8), f(4)].map((v) => Math.round(v * 1000) / 1000);
}

const DEFAULT_HUE: Record<PlanetKind, number> = { rocky: 28, desert: 36, ice: 200, gas: 30, lava: 14, ocean: 210, toxic: 85 };

/** An airless ball's edge (rocky worlds, and every moon): a soft limb, a wide rough terminator, a lit rim, a dust halo */
const AIRLESS_EDGE: Pick<PlanetLook, 'edge' | 'edge2'> = { edge: [0.012, 0.07, 0.8], edge2: [0.35, 0.02, 0.3] };

/** The defaults for a kind, from its hue */
export function kindLook(kind: PlanetKind | 'dwarf', hue: number, seed: number): PlanetLook {
  const rnd = (k: number) => ((Math.sin(seed * 12.9898 + k * 78.233) * 43758.5453) % 1 + 1) % 1;
  const none: [number, number, number] = [0, 0, 0];
  const base: PlanetLook = {
    pal: [hsl(hue, 0.2, 0.6), hsl(hue, 0.15, 0.35), hsl(hue, 0.15, 0.2)],
    atmoColor: hsl(hue, 0.6, 0.65), sunsetColor: hsl(20, 0.85, 0.55),
    atmo: [0.3, 0.012, 0.12], atmo2: [0.4, 1.0, 0.8], limb: [0, 1, 0], detail: [3, 1, 0], edge: [0.003, 0.03, 0.25], edge2: [0, 0.01, 0.2],
    bands: [7, 1, 0.004], storm: [0, 0, 0.1], stormColor: [-2, 0, 0], storm2: none, emitColor: [0, 0, 0], sea: [0, 1, 0], spin: 0.008,
    ring: none, ringCol0: [0, 0, 0], ringCol1: [0, 0, 0],
  };
  switch (kind) {
    case 'gas':
      return {
        ...base, spin: 0.02,
        pal: [hsl(hue + 22, 0.42, 0.76), hsl(hue, 0.62, 0.42), hsl(hue - 14, 0.7, 0.2)],
        atmoColor: hsl(hue + 10, 0.55, 0.66), sunsetColor: hsl(hue - 10, 0.85, 0.5),
        // thick: a deep haze, a wide twilight, limb-darkened under it
        atmo: [1.25, 0.028, 0.3], atmo2: [0.7, 0.8, 0.7], limb: [0.45, 0.55, 0.012], detail: [3, 1, 0], edge: [0, 0, 0], edge2: [0, 0.01, 0],
        bands: [6 + Math.round(rnd(1) * 3), 1.0, 0.0035],
        storm: [rnd(2) * 6.28, -0.42 + (rnd(3) - 0.5) * 0.2, 0.12], stormColor: hsl(hue - 8, 0.72, 0.45),
        storm2: [0.55 + rnd(4) * 0.15, 5 + Math.round(rnd(5) * 3), 0.035],
      };
    case 'dwarf':
      return {
        ...base, spin: 0.035,
        pal: [hsl(hue + 14, 0.5, 0.42), hsl(hue, 0.62, 0.27), hsl(hue - 6, 0.55, 0.12)],
        atmoColor: hsl(hue, 0.85, 0.32), sunsetColor: hsl(hue + 10, 0.9, 0.45), emitColor: hsl(hue + 8, 0.95, 0.5),
        atmo: [1.2, 0.035, 0.3], atmo2: [0, 1.0, 0.55], limb: [0.55, 0.6, 0.012], edge: [0, 0, 0], edge2: [0, 0.01, 0],
        bands: [9, 1.1, 0.003], storm: [0.7, -0.36, 0.13], stormColor: hsl(hue + 4, 0.75, 0.38), storm2: none,
      };
    case 'toxic':
      return {
        ...base, spin: 0.01,
        pal: [hsl(hue - 25, 0.62, 0.6), hsl(hue, 0.55, 0.33), hsl(hue + 10, 0.5, 0.2)],
        atmoColor: hsl(hue - 10, 0.6, 0.6), sunsetColor: hsl(hue - 45, 0.8, 0.5),
        atmo: [1.4, 0.035, 0.32], atmo2: [0.6, 0.9, 0.75], limb: [0.35, 0.6, 0.01], edge: [0, 0, 0], edge2: [0, 0.01, 0],
        bands: [4, 1.6, 0.003], detail: [3, 0.6, 0],
      };
    case 'rocky':
      return {
        ...base,
        pal: [hsl(hue, 0.16, 0.6), hsl(hue, 0.12, 0.3), hsl(hue, 0.1, 0.2)],
        atmoColor: hsl(hue, 0.25, 0.7), atmo: [0.06, 0.006, 0.04], atmo2: [0, 0.7, 0.3], limb: [0, 1.0, 0], detail: [3.2, 1, 0],
        // airless: a soft limb, a wide rough terminator, a rim of light and a faint dust halo
        ...AIRLESS_EDGE,
      };
    case 'desert':
      return {
        ...base,
        pal: [hsl(hue + 8, 0.58, 0.64), hsl(hue, 0.55, 0.4), hsl(hue - 10, 0.4, 0.24)],
        atmoColor: hsl(hue + 4, 0.55, 0.68), sunsetColor: hsl(205, 0.55, 0.6),
        atmo: [0.35, 0.01, 0.1], atmo2: [0.35, 0.9, 0.6], limb: [0, 0.9, 0], detail: [3, 1, 0], edge: [0.003, 0.035, 0.25], edge2: [0.03, 0.01, 0.2],
      };
    case 'ice':
      return {
        ...base,
        pal: [[0.94, 0.97, 1.0], hsl(hue, 0.35, 0.68), hsl(hue + 10, 0.7, 0.38)],
        atmoColor: hsl(hue, 0.55, 0.75), sunsetColor: hsl(hue + 30, 0.5, 0.6),
        atmo: [0.25, 0.01, 0.08], atmo2: [0.2, 0.9, 0.5], limb: [0, 0.6, 0], detail: [2.6, 1, 0], edge: [0.004, 0.03, 0.35], edge2: [0.05, 0.01, 0.2],
      };
    case 'lava':
      return {
        ...base,
        pal: [hsl(hue + 18, 1.0, 0.6), hsl(hue, 0.2, 0.1), hsl(hue, 0.2, 0.05)],
        atmoColor: hsl(hue + 6, 0.7, 0.45), sunsetColor: hsl(hue + 15, 0.95, 0.5), emitColor: hsl(hue + 15, 1.0, 0.5),
        atmo: [0.45, 0.012, 0.15], atmo2: [0.5, 0.9, 0.6], limb: [0, 0.8, 0], detail: [3, 1, 0], edge: [0.003, 0.03, 0.15], edge2: [0, 0.01, 0.15],
      };
    case 'ocean':
      return {
        ...base,
        pal: [hsl(hue - 15, 0.6, 0.4), hsl(hue, 0.75, 0.17), hsl(hue, 0.5, 0.3)],
        atmoColor: hsl(205, 0.75, 0.65), sunsetColor: hsl(22, 0.9, 0.55),
        atmo: [0.72, 0.016, 0.16], atmo2: [0.7, 1.05, 0.6], limb: [0, 0.6, 0], detail: [2.4, 1, 0.8], edge: [0.002, 0, 0.2], edge2: [0, 0.01, 0.15],
      };
  }
  return base;
}

/**
 * Everything that decides a body's look. `look` is the planet's (or the brown dwarf's) own, from systems.json: what
 * makes that world itself over its kind's defaults (Jovan's red spot, Cinderjack's sooty bands...).
 */
export interface BodyIn { id: string; kind: PlanetKind | 'dwarf'; hue?: number; rings?: PlanetData['rings']; look?: PlanetLookData }

export function lookFor(body: BodyIn, seed: number): PlanetLook {
  const hue = body.hue ?? (body.kind === 'dwarf' ? 14 : DEFAULT_HUE[body.kind]);
  const look: PlanetLook = { ...kindLook(body.kind, hue, seed), ...(body.look as Partial<PlanetLook> | undefined) };
  // Moons have no air: even an icy one only a trace of haze, and an airless ball's edge
  if (body.id.includes('.moon') && !body.look) Object.assign(look, { atmo: [0.05, 0.006, 0.04], atmo2: [0, 0.7, 0.3] }, AIRLESS_EDGE);
  if (body.rings) {
    const rh = body.rings.hue ?? hue;
    look.ring = [body.rings.inner, body.rings.outer, 0.8];
    look.ringCol0 = hsl(rh - 8, 0.35, 0.5);
    look.ringCol1 = hsl(rh + 10, 0.25, 0.78);
  }
  return look;
}

/**
 * How finely a planet is drawn (the quality tier's planetDetail): lite (Low: one flow phase, no relief, no fine
 * octaves), standard (Medium), fine (High: cracks worked out exactly, never pixelated close up).
 */
export type PlanetDetail = 'lite' | 'standard' | 'fine';
export const PLANET_DETAILS: readonly PlanetDetail[] = ['lite', 'standard', 'fine'];
/** The fragment body for a detail level */
export function planetFragment(detail: PlanetDetail): string {
  return (detail === 'lite' ? '#define PLANET_LITE\n' : detail === 'fine' ? '#define PLANET_FINE\n' : '') + PLANET_PROTO_FRAG;
}

/** The look as the prototype shader's uniforms (all floats and vec2/vec3: shaderQuad's UniformDef types) */
export function planetLookUniforms(look: PlanetLook, kind: PlanetKind | 'dwarf', seed: number, extent: number): Record<string, number | number[]> {
  return {
    uTime: 0, uKind: PLANET_KIND_INDEX[kind], uSeed: [seed % 97, (seed * 7) % 89], uLight: [1, 0], uLightAmt: 1, uPR: 1 / extent,
    uSpin: look.spin,
    uPal0: look.pal[0], uPal1: look.pal[1], uPal2: look.pal[2],
    uAtmoColor: look.atmoColor, uSunsetColor: look.sunsetColor, uAtmo: look.atmo, uAtmo2: look.atmo2, uLimb: look.limb,
    uEdge: look.edge, uEdge2: look.edge2, uDetail: look.detail, uBands: look.bands, uStorm: look.storm, uStormCol: look.stormColor, uStorm2: look.storm2,
    uEmitColor: look.emitColor, uSea: look.sea, uRing: look.ring, uRingCol0: look.ringCol0, uRingCol1: look.ringCol1,
  };
}

/** The uniform declarations for the body (as shaderQuadProgram writes them) */
export function planetLookDecls(u: Record<string, number | number[]>): string {
  return Object.entries(u).map(([k, v]) => `uniform ${typeof v === 'number' ? 'float' : v.length === 2 ? 'vec2' : 'vec3'} ${k};`).join('\n');
}
