/**
 * Planet prototypes (not in the game yet; docs/rendering/planet-prototypes.md). One fragment body for every planet,
 * moon and the brown dwarf, drop-in for PlanetRenderer's FRAGMENT: it runs on the same shaderQuad (vUV across the
 * quad, premultiplied out, GLSL_COMMON prepended) and adds one texture, the baked noise volume (planetNoise.ts).
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
 *   ridges cast light and shade), Worley craters, crack networks, dunes, canyons, polar caps; oceans with sun glint,
 *   coastal shallows, clouds with their shadows; lava that glows through its cracks and lights its own haze.
 * - Rings: a radial profile from the noise (mipmapped, so no moiré far out), transparency from optical depth, a
 *   soft-edged planet shadow with a penumbra, and faint clumping along the orbit.
 * - Every look is data (`PlanetLook`): defaults per kind from the planet's hue, overrides per planet id.
 */

import type { PlanetData, PlanetKind } from '@space-game/common';

export const PLANET_KIND_INDEX: Record<PlanetKind | 'dwarf', number> = { rocky: 0, desert: 1, ice: 2, gas: 3, lava: 4, ocean: 5, toxic: 6, dwarf: 7 };

/** The fragment body (uniforms declared by shaderQuadProgram from `planetProtoUniforms`, plus uNoise here) */
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

  // ---------------------------------------------------------------- gas giants (and the brown dwarf, and toxic decks)
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
    float h0 = hash(vec2(bi, uSeed.y)), h1 = hash(vec2(bi + 1.0, uSeed.y));
    float bv = mix(h0, h1, smoothstep(0.2, 0.8, bf));
    float zone = smoothstep(0.32, 0.68, bv);
    vec3 belt = uPal1 * (0.85 + 0.3 * hash(vec2(bi, 7.0 + uSeed.y)));
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
      float jit = (hash(vec2(k2, uSeed.y)) - 0.5) * step2 * 0.4;
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
  /** The height field a kind's relief is lit from (0..1), and its surface reads */
  float heightAt(vec3 b, out vec4 a, out vec4 d) {
    float s = uDetail.x;
    a = tn(b * s * 0.5 + vec3(uSeed * 0.011, 0.31), s * 0.5);
    d = tn(b * s * 1.3 + vec3(0.7, uSeed * 0.017) + (a.rgr - 0.5) * 0.35, s * 1.3);
    if (uKind < 0.5) {
      // rocky: rolling ground, craters (bowl and raised rim) at two sizes
      float c1 = smoothstep(0.45, 0.05, d.b) * -0.55 + smoothstep(0.32, 0.5, d.b) * smoothstep(0.7, 0.5, d.b) * 0.35;
      float c2 = smoothstep(0.42, 0.08, a.b) * -0.4 + smoothstep(0.34, 0.5, a.b) * smoothstep(0.66, 0.5, a.b) * 0.22;
      return a.r * 0.6 + c1 * 0.35 + c2 * 0.4;
    } else if (uKind < 1.5) {
      // desert: mesas and canyons along the cells' edges, dunes
      float canyon = smoothstep(0.1, 0.0, d.a) * smoothstep(0.62, 0.4, a.r);
      return a.r * 0.75 + d.g * 0.2 - canyon * 0.3;
    } else if (uKind < 2.5) {
      // ice: low swells, ridged lineae (a double ridge each side of a crack)
      float l1 = max(smoothstep(0.08, 0.0, a.a), smoothstep(0.06, 0.0, d.a) * smoothstep(0.3, 0.6, d.g));
      float l0 = max(smoothstep(0.025, 0.0, a.a), smoothstep(0.02, 0.0, d.a) * smoothstep(0.3, 0.6, d.g));
      return a.r * 0.35 + l1 * 0.25 - l0 * 0.3;
    } else if (uKind < 4.5) {
      // lava: crust plates between glowing cracks
      return a.r * 0.5 + smoothstep(0.0, 0.2, d.a) * 0.3;
    }
    // ocean: land above the sea
    return smoothstep(0.555, 0.68, tn(b * s * 0.22 + vec3(0.13, uSeed * 0.01), s * 0.22).r * 0.8 + a.r * 0.2 + 0.04);
  }

  vec3 solidSurface(vec3 b, vec3 lb, float lat, float px, vec4 a, vec4 d, out float emit, out float spec, out float cloud, out float cloudShade) {
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
      c = mix(c, uPal2, smoothstep(0.1, 0.0, d.a) * smoothstep(0.62, 0.4, a.r) * 0.55 + smoothstep(0.58, 0.75, a.r) * 0.35);
      float cap = smoothstep(0.86, 0.93, abs(b.y) + (a.g - 0.5) * 0.1);
      return mix(c, vec3(0.93, 0.9, 0.88), cap * 0.9);
    } else if (uKind < 2.5) {
      // ice: white-blue sheets, rust-tinted lineae, blue-grey old ice
      vec3 c = mix(uPal1, uPal0, smoothstep(0.3, 0.7, a.r) * 0.8 + a.g * 0.2);
      float lines = max(smoothstep(0.06, 0.0, a.a), smoothstep(0.05, 0.0, d.a) * smoothstep(0.2, 0.5, d.g) * 0.7);
      if (fineW > 0.0) lines = max(lines, smoothstep(0.035, 0.0, tn(b * uDetail.x * 4.0 + 1.7, uDetail.x * 4.0).a) * 0.6 * fineW);
      return mix(c, uPal2, lines * 0.8);
    } else if (uKind < 4.5) {
      // lava: black crust, glowing cracks and lakes, pulsing slowly
      // the rivers: a coarse crack network (its own read, warped), a glow round each, fine cracks between
      float big = tn(b * 0.6 + (a.rgr - 0.5) * 0.05 + vec3(0.21, uSeed * 0.013), 0.6).a;
      float river = smoothstep(0.12, 0.02, big) + smoothstep(0.35, 0.0, big) * 0.25;
      float crack = max(river, smoothstep(0.05, 0.0, d.a) * 0.35) * (0.7 + 0.3 * smoothstep(0.3, 0.6, a.g));
      float pulse = 0.75 + 0.25 * sin(uTime * 0.35 + a.g * 12.0);
      emit = crack * (0.65 + 0.35 * pulse);
      if (fineW > 0.0) emit = max(emit, smoothstep(0.1, 0.0, tn(b * uDetail.x * 4.5, uDetail.x * 4.5).a) * 0.5 * fineW);
      vec3 crust = uPal1 * (0.6 + 0.8 * a.g);
      return mix(crust, uPal0, emit);
    }
    // ocean: seas deepening offshore, coasts, land by latitude, ice caps, clouds with shadows, glint
    float h = tn(b * uDetail.x * 0.22 + vec3(0.13, uSeed * 0.01), uDetail.x * 0.22).r * 0.8 + a.r * 0.2 + 0.04;
    float land = smoothstep(0.555, 0.57, h);
    vec3 sea = mix(uPal1, uPal0, smoothstep(0.5, 0.555, h) * 0.8) * (0.9 + 0.2 * a.g);
    vec3 green = mix(vec3(0.16, 0.3, 0.13), vec3(0.42, 0.36, 0.22), smoothstep(0.2, 0.55, abs(lat)) * 0.6 + d.g * 0.4);
    vec3 ground = mix(green, vec3(0.52, 0.44, 0.3), smoothstep(0.62, 0.75, d.r));
    vec3 c = mix(sea, ground, land);
    float ice = smoothstep(0.8, 0.86, abs(b.y) + (a.g - 0.5) * 0.12);
    c = mix(c, vec3(0.9, 0.93, 0.96), ice);
    spec = (1.0 - land) * (1.0 - ice);
    // clouds: their own drift, swirled; read again a step toward the star for their shadow
    float cs = uSpin * 0.6 * uTime;
    vec3 cb = spinY(b, cs);
    // (swirled by the low field, stretched along the latitudes, banded a little by the circulation cells)
    vec3 cq = cb * vec3(0.9, 1.9, 0.9) + vec3(a.r - 0.5, 0.0, a.g - 0.5) * 0.12 + vec3(0.0, 0.0, 0.43);
    vec4 cl = tn(cq, 1.9);
    float cv = cl.g * 0.8 + cl.r * 0.2 + (1.0 - abs(sin(b.y * 5.0))) * 0.06;
    cloud = smoothstep(0.52, 0.78, cv) * (0.7 + 0.3 * d.g) * uDetail.z;
    vec4 cs2 = tn(cq + lb * vec3(0.015, 0.03, 0.015), 1.9);
    cloudShade = smoothstep(0.52, 0.78, cs2.g * 0.8 + cs2.r * 0.2) * uDetail.z;
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
    float soft = max(1.5 * px, uLimb.z);  // the disc edge: never under 1.5 px

    if (r > 1.0 - soft) {
      // Outside the limb: haze falling off with height, lit round past the terminator
      float a = max(r - 1.0, 0.0);
      float tau = g * exp(-a / H) * smoothstep(1.0 / uPR, 1.0 / uPR - 0.08, r);
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
        vec4 a, d;
        float h0 = heightAt(b, a, d);
        if (lite < 0.5 && uLimb.y > 0.0) {
          // relief: the height again a step toward the star (in the body's frame)
          vec3 tl = lb - b * dot(lb, b);
          float tlen = length(tl);
          float eps = 0.012 / uDetail.x;
          vec4 a1, d1;
          float h1 = heightAt(b + tl / max(tlen, 1e-4) * eps, a1, d1);
          slope = (h1 - h0) / eps * tlen;
        }
        base = solidSurface(b, lb, lat, px, a, d, emit, spec, cloud, cloudShade);
      }

      // Light: a soft knee at the terminator (wider under thicker air), relief tilting it, reddened in twilight
      float dl = d0 + slope * uLimb.y * 0.012;
      float tw = uAtmo.z * 0.5 + 0.02;
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
        c = base * (lit * sunTint + 0.035);
        // clouds over the surface, their shadow just beside
        c *= 1.0 - cloudShade * 0.45 * step(0.0, d0);
        c = mix(c, vec3(0.96) * (lit * sunTint + 0.03), cloud * 0.9);
        // sun glint on open water
        vec3 hv = normalize(l3 + vec3(0.0, 0.0, 1.0));
        c += vec3(1.0, 0.95, 0.85) * (pow(max(dot(n, hv), 0.0), 60.0) * 0.8 + pow(max(dot(n, hv), 0.0), 8.0) * 0.06) * spec * (1.0 - cloud) * uLightAmt;
        // lava's glow, strongest on the night side
        c += uEmitColor * emit * (0.55 + 0.45 * (1.0 - smoothstep(0.0, 0.3, d0)));
      }
      // Limb darkening (gas giants): the deck seen through more of itself toward the edge
      c *= mix(1.0, pow(max(z, 0.02), uLimb.y), uLimb.x);

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
  /** Solid: feature scale, contrast, cloud cover. Gas: (unused), vortex strength, (unused) */
  detail: [number, number, number];
  /** Gas: band frequency, turbulence, jet speed (rad/s) */
  bands: [number, number, number];
  /** Great storm: longitude, latitude, size (radians of latitude); colour (r < -1: none) */
  storm: [number, number, number];
  stormColor: number[];
  /** White ovals: latitude, count, size */
  storm2: [number, number, number];
  emitColor: number[];
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

/** The defaults for a kind, from its hue */
export function kindLook(kind: PlanetKind | 'dwarf', hue: number, seed: number): PlanetLook {
  const rnd = (k: number) => ((Math.sin(seed * 12.9898 + k * 78.233) * 43758.5453) % 1 + 1) % 1;
  const none: [number, number, number] = [0, 0, 0];
  const base: PlanetLook = {
    pal: [hsl(hue, 0.2, 0.6), hsl(hue, 0.15, 0.35), hsl(hue, 0.15, 0.2)],
    atmoColor: hsl(hue, 0.6, 0.65), sunsetColor: hsl(20, 0.85, 0.55),
    atmo: [0.3, 0.012, 0.12], atmo2: [0.4, 1.0, 0.8], limb: [0, 1, 0], detail: [3, 1, 0],
    bands: [7, 1, 0.004], storm: [0, 0, 0.1], stormColor: [-2, 0, 0], storm2: none, emitColor: [0, 0, 0], spin: 0.008,
    ring: none, ringCol0: [0, 0, 0], ringCol1: [0, 0, 0],
  };
  switch (kind) {
    case 'gas':
      return {
        ...base, spin: 0.02,
        pal: [hsl(hue + 22, 0.42, 0.76), hsl(hue, 0.62, 0.42), hsl(hue - 14, 0.7, 0.2)],
        atmoColor: hsl(hue + 10, 0.55, 0.66), sunsetColor: hsl(hue - 10, 0.85, 0.5),
        // thick: a deep haze, a wide twilight, limb-darkened under it
        atmo: [1.25, 0.028, 0.3], atmo2: [0.7, 0.8, 0.7], limb: [0.45, 0.55, 0.012], detail: [3, 1, 0],
        bands: [6 + Math.round(rnd(1) * 3), 1.0, 0.0035],
        storm: [rnd(2) * 6.28, -0.42 + (rnd(3) - 0.5) * 0.2, 0.12], stormColor: hsl(hue - 8, 0.72, 0.45),
        storm2: [0.55 + rnd(4) * 0.15, 5 + Math.round(rnd(5) * 3), 0.035],
      };
    case 'dwarf':
      return {
        ...base, spin: 0.035,
        pal: [hsl(hue + 14, 0.5, 0.42), hsl(hue, 0.62, 0.27), hsl(hue - 6, 0.55, 0.12)],
        atmoColor: hsl(hue, 0.85, 0.32), sunsetColor: hsl(hue + 10, 0.9, 0.45), emitColor: hsl(hue + 8, 0.95, 0.5),
        atmo: [1.2, 0.035, 0.3], atmo2: [0, 1.0, 0.55], limb: [0.55, 0.6, 0.012],
        bands: [9, 1.1, 0.003], storm: [0.7, -0.36, 0.13], stormColor: hsl(hue + 4, 0.75, 0.38), storm2: none,
      };
    case 'toxic':
      return {
        ...base, spin: 0.01,
        pal: [hsl(hue - 25, 0.62, 0.6), hsl(hue, 0.55, 0.33), hsl(hue + 10, 0.5, 0.2)],
        atmoColor: hsl(hue - 10, 0.6, 0.6), sunsetColor: hsl(hue - 45, 0.8, 0.5),
        atmo: [1.4, 0.035, 0.32], atmo2: [0.6, 0.9, 0.75], limb: [0.35, 0.6, 0.01],
        bands: [4, 1.6, 0.003], detail: [3, 0.6, 0],
      };
    case 'rocky':
      return {
        ...base,
        pal: [hsl(hue, 0.16, 0.6), hsl(hue, 0.12, 0.3), hsl(hue, 0.1, 0.2)],
        atmoColor: hsl(hue, 0.25, 0.7), atmo: [0.06, 0.006, 0.04], atmo2: [0, 0.7, 0.3], limb: [0, 1.0, 0], detail: [3.2, 1, 0],
      };
    case 'desert':
      return {
        ...base,
        pal: [hsl(hue + 8, 0.58, 0.64), hsl(hue, 0.55, 0.4), hsl(hue - 10, 0.4, 0.24)],
        atmoColor: hsl(hue + 4, 0.55, 0.68), sunsetColor: hsl(205, 0.55, 0.6),
        atmo: [0.35, 0.01, 0.1], atmo2: [0.35, 0.9, 0.6], limb: [0, 0.9, 0], detail: [3, 1, 0],
      };
    case 'ice':
      return {
        ...base,
        pal: [[0.94, 0.97, 1.0], hsl(hue, 0.35, 0.68), hsl(hue + 10, 0.7, 0.38)],
        atmoColor: hsl(hue, 0.55, 0.75), sunsetColor: hsl(hue + 30, 0.5, 0.6),
        atmo: [0.25, 0.01, 0.08], atmo2: [0.2, 0.9, 0.5], limb: [0, 0.6, 0], detail: [2.6, 1, 0],
      };
    case 'lava':
      return {
        ...base,
        pal: [hsl(hue + 18, 1.0, 0.6), hsl(hue, 0.2, 0.1), hsl(hue, 0.2, 0.05)],
        atmoColor: hsl(hue + 6, 0.7, 0.45), sunsetColor: hsl(hue + 15, 0.95, 0.5), emitColor: hsl(hue + 15, 1.0, 0.5),
        atmo: [0.45, 0.012, 0.15], atmo2: [0.5, 0.9, 0.6], limb: [0, 0.8, 0], detail: [3, 1, 0],
      };
    case 'ocean':
      return {
        ...base,
        pal: [hsl(hue - 15, 0.6, 0.4), hsl(hue, 0.75, 0.17), hsl(hue, 0.5, 0.3)],
        atmoColor: hsl(205, 0.75, 0.65), sunsetColor: hsl(22, 0.9, 0.55),
        atmo: [0.55, 0.014, 0.14], atmo2: [0.6, 1.0, 0.6], limb: [0, 0.5, 0], detail: [2.4, 1, 0.8],
      };
  }
  return base;
}

/**
 * Per-planet tuning over the kind's defaults (in the game: a `look` on the planet in systems.json). Kept small: each
 * entry is what makes that world itself.
 */
export const PLANET_TUNING: Record<string, Partial<PlanetLook>> = {
  // Jovan: the classic, a great red spot in the south, white ovals in the north-ish band
  jovan: { storm: [0.9, -0.36, 0.13], stormColor: hsl(10, 0.62, 0.46), storm2: [0.5, 6, 0.035] },
  // Cinderjack (Ashfall's giant, round the brown dwarf): sooty, hotter, wilder bands, a dark storm
  cinderjack: { bands: [9, 1.35, 0.004], stormColor: hsl(10, 0.6, 0.22), atmo: [1.8, 0.03, 0.32] },
  // Boreas Major: an ice giant, soft bands, a dark spot, no ovals
  boreas_major: { bands: [5, 0.7, 0.003], stormColor: hsl(222, 0.6, 0.25), storm2: [0, 0, 0], storm: [2.0, -0.25, 0.1] },
  // Opaline: pearly magenta, high contrast, two storms' worth of ovals
  opaline: { storm2: [-0.55, 8, 0.03] },
  // Ember Giant: deep red, a pale storm
  ember_giant: { stormColor: hsl(30, 0.6, 0.7), bands: [8, 1.2, 0.0035], pal: [hsl(24, 0.6, 0.55), hsl(12, 0.75, 0.32), hsl(4, 0.75, 0.15)], atmoColor: hsl(18, 0.6, 0.55) },
};

/** Everything that decides a body's look */
export interface BodyIn { id: string; kind: PlanetKind | 'dwarf'; hue?: number; rings?: PlanetData['rings'] }

export function lookFor(body: BodyIn, seed: number): PlanetLook {
  const hue = body.hue ?? (body.kind === 'dwarf' ? 14 : DEFAULT_HUE[body.kind]);
  const look: PlanetLook = { ...kindLook(body.kind, hue, seed), ...(PLANET_TUNING[body.id] ?? {}) };
  if (body.rings) {
    const rh = body.rings.hue ?? hue;
    look.ring = [body.rings.inner, body.rings.outer, 0.8];
    look.ringCol0 = hsl(rh - 8, 0.35, 0.5);
    look.ringCol1 = hsl(rh + 10, 0.25, 0.78);
  }
  return look;
}

/** The look as the prototype shader's uniforms (all floats and vec2/vec3: shaderQuad's UniformDef types) */
export function planetProtoUniforms(look: PlanetLook, kind: PlanetKind | 'dwarf', seed: number, extent: number): Record<string, number | number[]> {
  return {
    uTime: 0, uKind: PLANET_KIND_INDEX[kind], uSeed: [seed % 97, (seed * 7) % 89], uLight: [1, 0], uLightAmt: 1, uPR: 1 / extent,
    uSpin: look.spin,
    uPal0: look.pal[0], uPal1: look.pal[1], uPal2: look.pal[2],
    uAtmoColor: look.atmoColor, uSunsetColor: look.sunsetColor, uAtmo: look.atmo, uAtmo2: look.atmo2, uLimb: look.limb,
    uDetail: look.detail, uBands: look.bands, uStorm: look.storm, uStormCol: look.stormColor, uStorm2: look.storm2,
    uEmitColor: look.emitColor, uRing: look.ring, uRingCol0: look.ringCol0, uRingCol1: look.ringCol1,
  };
}

/** The uniform declarations for the body (as shaderQuadProgram writes them) */
export function planetProtoDecls(u: Record<string, number | number[]>): string {
  return Object.entries(u).map(([k, v]) => `uniform ${typeof v === 'number' ? 'float' : v.length === 2 ? 'vec2' : 'vec3'} ${k};`).join('\n');
}
