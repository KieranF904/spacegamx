/**
 * The planets' classic look (PlanetRenderer's shader until 2026-10-31, when the prototype in planetProto.ts replaced
 * it). Not drawn by the game: kept for the labs and the native harness (scripts/planet-proto), which compare against it
 * (their "classic" look) and read it from this file's text.
 */
export const FRAGMENT = `
  /**
   * A gas giant. Zonal jets: each band of latitude drifts its own way (swaying
   * back and forth over minutes, so the bands never smear out); the cloud is
   * domain-warped turbulence, torn hardest along the shear between bands, where
   * small vortices curl; pale zones and rusty belts with dark lanes, fine
   * filaments, a great spiral storm with a dark collar, and hazy poles.
   */
  vec3 gasGiant(vec2 st, float hue) {
    float lat = st.y;
    float jet = sin(lat * 9.0) * 0.6 + sin(lat * 23.0 + 1.3) * 0.2;
    float lon = st.x + jet * sin(uTime * 0.004) * 1.2;
    vec2 c0 = vec2(lon * 1.6, lat * 5.0) + uSeed;
    float shear = abs(cos(lat * 9.0));
    vec2 w = vec2(fbm(c0 * 1.7 + uTime * 0.012), fbm(c0 * 1.7 + 5.2 - uTime * 0.01));
    vec2 c1 = c0 + (w - 0.5) * (0.5 + 1.5 * shear);
    float t1 = fbm(c1 * 2.3);
    float t2 = fbm(c1 * 7.0 + t1 * 2.0);
    float t3 = noise(c1 * 22.0 + t2 * 3.0);
    float band = lat * 7.0 + (t1 - 0.5) * 1.6 + (t2 - 0.5) * 0.35;
    float b1 = sin(band * 2.0) * 0.5 + 0.5;
    float b2 = sin(band * 5.3 + 1.7) * 0.5 + 0.5;
    vec3 zone = hsl2rgb(hue + 22.0, 0.4, 0.74);
    vec3 belt = hsl2rgb(hue, 0.62, 0.4);
    vec3 deep = hsl2rgb(hue - 14.0, 0.7, 0.2);
    vec3 c = mix(belt, zone, smoothstep(0.3, 0.75, b1));
    c = mix(c, deep, smoothstep(0.78, 0.96, b2) * 0.6);
    c *= 0.82 + t2 * 0.3 + (t3 - 0.5) * 0.08;
    // Vortices along the shear lines, pale and dark
    float v = noise(c1 * 5.0);
    c = mix(c, zone * 1.06, smoothstep(0.74, 0.9, v) * shear * 0.55);
    c = mix(c, deep, smoothstep(0.26, 0.1, v) * shear * 0.35);
    // The great storm: a spiralling oval with a dark collar
    vec2 sd = vec2(mod(lon - 0.9 + 3.14159, 6.28318) - 3.14159, lat + 0.42) * vec2(1.0, 2.4);
    float sr = length(sd);
    if (sr < 0.42) {
      float ang = atan(sd.y, sd.x) + sr * 14.0 - uTime * 0.2;
      float spiral = 0.5 + 0.5 * sin(ang * 2.0 + fbm(sd * 8.0) * 3.0);
      vec3 sc = mix(hsl2rgb(hue - 8.0, 0.8, 0.42), hsl2rgb(hue + 12.0, 0.65, 0.72), spiral);
      c = mix(c, sc, smoothstep(0.3, 0.05, sr) * 0.92);
      c = mix(c, hsl2rgb(hue - 15.0, 0.8, 0.26), smoothstep(0.24, 0.31, sr) * smoothstep(0.4, 0.32, sr) * 0.65);
    }
    // Hazy poles
    return mix(c, hsl2rgb(hue + 30.0, 0.18, 0.42), smoothstep(0.95, 1.45, abs(lat)) * 0.75);
  }

  vec3 surface(float kind, vec2 st, vec3 n, float hue, out float emit) {
    emit = 0.0;
    vec2 q = st * 2.2 + uSeed;
    float f = fbm(q);
    if (kind < 0.5) {                       // rocky: grey-brown plains, craters, dark maria
      float cr = smoothstep(0.62, 0.66, noise(q * 5.0)) - smoothstep(0.66, 0.72, noise(q * 5.0)) * 0.6;
      float maria = smoothstep(0.45, 0.6, fbm(q * 0.7 + 3.0));
      vec3 c = hsl2rgb(hue, 0.18, 0.42 + 0.22 * f);
      c = mix(c, hsl2rgb(hue, 0.12, 0.22), maria * 0.6);
      return c * (1.0 + cr * 0.5);
    } else if (kind < 1.5) {                // desert: wind-carved dunes
      float d = sin(st.y * 26.0 + fbm(q * 1.5) * 9.0) * 0.5 + 0.5;
      vec3 c = mix(hsl2rgb(hue, 0.55, 0.42), hsl2rgb(hue + 8.0, 0.6, 0.66), d * 0.6 + f * 0.4);
      return mix(c, hsl2rgb(hue - 10.0, 0.4, 0.3), smoothstep(0.55, 0.7, fbm(q * 0.6)) * 0.5);
    } else if (kind < 2.5) {                // ice: white-blue sheets cut by cracks
      float crack = 1.0 - smoothstep(0.0, 0.035, abs(noise(q * 3.0) - 0.5));
      float crack2 = 1.0 - smoothstep(0.0, 0.02, abs(noise(q * 7.0 + 9.0) - 0.5));
      vec3 c = mix(hsl2rgb(hue, 0.35, 0.72), vec3(0.95, 0.98, 1.0), f);
      return mix(c, hsl2rgb(hue + 10.0, 0.7, 0.38), max(crack, crack2 * 0.6) * 0.75);
    } else if (kind < 3.5) {                // gas giant: see gasGiant()
      return gasGiant(st, hue);
    } else if (kind < 4.5) {                // lava: black crust over glowing cracks
      float cell = abs(noise(q * 2.5) - 0.5) * 2.0;
      float glow = pow(1.0 - smoothstep(0.0, 0.18, cell), 2.0) * (0.6 + 0.4 * noise(q * 6.0 + uTime * 0.2));
      emit = glow;
      return mix(hsl2rgb(hue, 0.25, 0.08 + 0.1 * f), hsl2rgb(hue + 15.0, 1.0, 0.55), glow);
    } else if (kind < 5.5) {                // ocean: seas, continents, ice caps, cloud
      float land = smoothstep(0.52, 0.56, fbm(q * 0.9 + 7.0));
      vec3 sea = mix(hsl2rgb(hue, 0.7, 0.22), hsl2rgb(hue - 15.0, 0.6, 0.38), f);
      vec3 ground = mix(hsl2rgb(110.0, 0.35, 0.3), hsl2rgb(35.0, 0.35, 0.42), fbm(q * 2.0));
      vec3 c = mix(sea, ground, land);
      c = mix(c, vec3(0.92), smoothstep(0.72, 0.8, abs(n.y)));
      float cloud = smoothstep(0.5, 0.75, fbm(q * 1.4 + vec2(uTime * 0.012, 0.0)));
      return mix(c, vec3(0.97), cloud * 0.85);
    }
    // toxic: thick yellow-green cloud, swirling
    float sw = fbm(q + vec2(fbm(q * 1.3 + uTime * 0.01), fbm(q * 1.1 - 4.0)) * 1.6);
    return mix(hsl2rgb(hue, 0.55, 0.28), hsl2rgb(hue - 25.0, 0.7, 0.6), sw);
  }

  void main() {
    vec2 p = (vUV - 0.5) * 2.0 / uPR;      // 1.0 = the planet's limb
    float r = length(p);
    vec2 L = normalize(uLight);
    vec3 col = vec3(0.0);
    float alpha = 0.0;

    // Rings: an annulus, darker where the planet's shadow falls across it
    if (uRingOut > 0.0 && r > uRingIn && r < uRingOut) {
      float t = (r - uRingIn) / (uRingOut - uRingIn);
      float bands = 0.55 + 0.45 * sin(t * 60.0 + noise(vec2(t * 40.0, 1.0)) * 6.0);
      // Ringlets: fine grooves over the broad bands
      float fine = 0.78 + 0.22 * sin(t * 340.0 + noise(vec2(t * 160.0, 3.0)) * 4.0);
      float gaps = smoothstep(0.02, 0.06, abs(t - 0.62)) * smoothstep(0.01, 0.03, abs(t - 0.3)) * smoothstep(0.004, 0.012, abs(t - 0.86));
      float edge = smoothstep(0.0, 0.08, t) * smoothstep(1.0, 0.85, t);
      float along = dot(p, L);
      float shadow = (along < 0.0 && length(p - along * L) < 1.0) ? 0.18 : 1.0;
      // Denser (brighter) in the middle ring, thin and dusty inside
      float dense = mix(0.45, 1.0, smoothstep(0.05, 0.35, t)) * mix(1.0, 0.7, smoothstep(0.62, 0.9, t));
      float a = edge * gaps * bands * fine * dense * 0.8;
      vec3 rc = mix(hsl2rgb(uRingHue - 8.0, 0.35, 0.5), hsl2rgb(uRingHue + 10.0, 0.25, 0.78), smoothstep(0.1, 0.7, t));
      col = rc * a * shadow * uLightAmt;
      alpha = a * 0.9;
    }

    // Atmosphere glow just outside the limb, on the lit side (a gas giant's is deep: wider, and faint even on the night side)
    float gas = (uKind > 2.5 && uKind < 3.5) ? 1.0 : 0.0;
    if (r >= 1.0 && r < 1.3 && uKind != 0.0) {
      float lit = clamp(dot(normalize(p), L) * 0.7 + 0.45, 0.0, 1.0);
      if (gas > 0.5) {
        // A luminous haze in the atmosphere's own colour, thinning out (never a dark ring over the stars)
        float g = exp(-(r - 1.0) * 14.0) * uAtmo;
        vec3 hc = uAtmoColor * (0.3 + 0.9 * lit) * uLightAmt;
        float ha = g * (0.35 + 0.55 * lit);
        col = mix(col, hc, ha / max(ha + alpha, 1e-4));
        alpha = max(alpha, ha);
      } else {
        float g = exp(-(r - 1.0) * 22.0) * lit * uAtmo;
        col += uAtmoColor * g * uLightAmt;
        alpha = max(alpha, g);
      }
    }

    if (r < 1.0) {
      float z = sqrt(1.0 - r * r);
      vec3 n = vec3(p, z);
      float lon = atan(n.x, n.z) + uTime * uSpin;
      float lat = asin(clamp(n.y, -1.0, 1.0));
      float emit;
      vec3 base = surface(uKind, vec2(lon, lat), n, uHue, emit);
      // The star lies in the plane: light arrives almost edge-on, so half the disc is in night
      vec3 l3 = normalize(vec3(L, 0.22));
      float diff = max(dot(n, l3), 0.0);
      float lit = diff * uLightAmt + 0.035;
      vec3 c = base * lit;
      c += hsl2rgb(uHue + 15.0, 1.0, 0.5) * emit * (0.55 + 0.45 * (1.0 - diff));
      // Gas giants: light scattered through the upper cloud warms the twilight edge
      if (uKind > 2.5 && uKind < 3.5) {
        float tw = dot(n, l3);
        c += hsl2rgb(uHue + 6.0, 0.8, 0.5) * exp(-tw * tw * 60.0) * 0.18 * uLightAmt;
      }
      // Thin bright limb on the day side
      float rim = pow(1.0 - z, 3.0) * uAtmo;
      c += uAtmoColor * rim * smoothstep(-0.2, 0.6, dot(normalize(p + 1e-4), L)) * 0.9 * uLightAmt;
      // A gas giant has no surface: its limb thins into haze, and fades out over the last few percent
      if (gas > 0.5) {
        float haze = smoothstep(0.84, 1.0, r);
        float hl = clamp(dot(normalize(p + 1e-4), L) * 0.7 + 0.45, 0.0, 1.0);
        c = mix(c, uAtmoColor * (0.3 + 0.9 * hl) * uLightAmt, haze * haze * 0.7);
      }
      float aa = smoothstep(1.0, mix(0.985, 0.93, gas), r);
      if (gas > 0.5) {
        // Fade the cloud into the haze (the same haze that carries on past the limb), never to nothing
        float hl = clamp(dot(normalize(p + 1e-4), L) * 0.7 + 0.45, 0.0, 1.0);
        c = mix(uAtmoColor * (0.3 + 0.9 * hl) * uLightAmt, c, aa);
        aa = max(aa, uAtmo * (0.35 + 0.55 * hl));
      }
      col = mix(col, c, aa);
      alpha = max(alpha, aa);
    }
    fragColor = vec4(col * alpha, alpha);
  }
`;
