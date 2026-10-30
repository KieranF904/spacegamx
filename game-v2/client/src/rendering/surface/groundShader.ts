/**
 * A surface's ground (the art pass; SurfaceRenderer, surfaceLooks.ts). The
 * same continents, seas and city as before (the height field is unchanged:
 * look only, nothing collides with it), drawn in layers:
 *
 *   macro   the land's height: sea, shore, lowland, highland, rock, snow,
 *           and a moisture field across it (wet forest, dry scrub)
 *   mid     each kind of world's own features: Terra Nova's forests, rivers
 *           and farmland round the city; a moon's craters and dark maria;
 *           ice floes, crevasses and glacier ice; lava under a cracked
 *           crust, ash plains, vents
 *   fine    trees (each a lit crown with its shadow), furrows, wind ripples,
 *           grit; faded out where they'd be smaller than a pixel or two
 *   light   the sun warm on slopes facing it, the shade taking the sky's
 *           colour (cool blue on Terra Nova, near black on an airless moon),
 *           creases darkened (ambient occlusion from the height's
 *           curvature), cloud shadows drifting over, haze thickening with
 *           altitude and at the map's edge; lava glows on its own (unlit,
 *           not darkened by night or shadow)
 *
 * A cavern's floor is the head's caveFloor, as before.
 */

import { GROUND_HEAD } from './surfaceShaders';

export const groundFrag = `${GROUND_HEAD}
uniform vec3 uDry;
uniform vec3 uSoil;
uniform vec3 uSkylight;
uniform vec3 uSunlight;
uniform vec4 uFeat;     // forest, rivers, farmland, craters
uniform vec4 uFeat2;    // relief, fine detail, cracks, moisture bias
uniform vec4 uStyle;    // x 0 terran 1 rocky 2 ice 3 lava 4 desert 5 toxic, y atmosphere, z ripples

float hash1(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

/** Cells (jittered, a 3 × 3 search): x roughly how far to the nearest edge (in cells), y the cell's own random value */
vec2 cells(vec2 x, float k) {
  vec2 n = floor(x), f = fract(x);
  float f1 = 8.0, f2 = 8.0, id = 0.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 g = vec2(float(i), float(j)), r = g + hash2(n + g + k) * 0.8 + 0.1 - f;
    float d = dot(r, r);
    if (d < f1) { f2 = f1; f1 = d; id = hash1(n + g + k * 1.7); } else if (d < f2) f2 = d;
  }
  return vec2(0.5 * (sqrt(f2) - sqrt(f1)), id);
}

/** How much of a feature \`s\` world units across to show at this pixel size (fades out before it aliases) */
float resolves(float s) { return 1.0 - smoothstep(0.12, 0.3, uPx / s); }

/** The land's warp (slow: taken once per pixel, shared by its neighbours' heights) */
vec2 warpAt(vec2 w) {
  vec2 p = (w / 26000.0 + uSeed) * 0.7;
  return vec2(texture(uNoise, p).g, texture(uNoise, p + 0.37).g) - 0.5;
}

/** height() (surfaceShaders.ts) with the warp given (the same land, seas and coasts) */
float heightQ(vec2 w, vec2 q) {
  vec2 p = w / 26000.0 + uSeed + q * 0.45;
  float h = texture(uNoise, p).r * 0.7 + texture(uNoise, rot(0.9) * p * 2.3 + 0.13).r * 0.3;
  float dc = length(w - uCity);
  h += 0.22 * (1.0 - smoothstep(uLand.z * 0.6, uLand.z * 2.4, dc));
  return h;
}

/**
 * A crater in each of a grid's cells (some cells empty): adds its slope to \`grad\`; gives its rim's brightness,
 * how far down its bowl and its ejecta. Kept inside its own cell (no neighbours to look at)
 */
vec3 crater(vec2 w, float S, float k, float dens, inout vec2 grad) {
  vec2 p = rot(k) * w / S + k * vec2(17.3, 9.1);
  vec2 c = floor(p), f = fract(p);
  vec2 hh = hash2(c + k * 3.7 + uSeed * 13.0);
  if (hh.x > dens) return vec3(0.0);
  float r = 0.09 + 0.13 * fract(hh.y * 7.13);
  vec2 ctr = 0.5 + (hash2(c + k * 5.1) - 0.5) * 0.3;
  vec2 rel = f - ctr;
  float dist = length(rel), d = dist / r;
  if (d > 1.55) return vec3(0.0);
  // The bowl, a parabola; the rim a raised ring just outside it (slopes as dh/dd)
  float bowl = d < 1.0 ? 1.1 * d : 0.0;
  float rr = (d - 1.0) / 0.2, rim = exp(-rr * rr);
  float slope = bowl - rim * 2.0 * rr / 0.2 * 0.16;
  float fade = resolves(S * r * 0.5);
  // (its slope turned back out of the grid's rotation into the world's)
  grad += (rot(-k) * (rel / max(dist, 1e-4))) * slope * 0.42 * fade;
  float eject = (1.0 - smoothstep(1.0, 1.55, d)) * step(1.0, d);
  return vec3(rim, d < 1.0 ? 1.0 - d * d : 0.0, eject) * fade;
}

/** Trees in a grid of cells \`S\` across (one at most to a cell, if the forest's dense enough): x crown, y its light, z its shadow, w its own hue */
vec4 trees(vec2 w, float S, float k, float dens) {
  mat2 R = rot(k * 2.1 + 0.3);
  vec2 sunG = R * uSun;
  vec2 p = R * w / S + k;
  // (rows staggered, so the grid never lines up)
  p.x += floor(p.y) * 0.5;
  vec2 c = floor(p), f = fract(p);
  vec2 hh = hash2(c + k * 7.7);
  // (thinning out: a tree shrinks away rather than being cut off where the forest ends)
  float grow = smoothstep(hh.x, hh.x + 0.35, dens);
  if (grow <= 0.0) return vec4(0.0);
  vec2 ctr = 0.5 + (hash2(c + k * 2.3) - 0.5) * 0.4;
  float rad = (0.19 + 0.1 * hh.y) * (0.45 + 0.55 * grow);
  vec2 rel = (f - ctr) / rad;
  float d = length(rel);
  float crown = 1.0 - smoothstep(0.82, 1.0, d);
  vec3 n = normalize(vec3(rel * 0.8, sqrt(max(0.0, 1.0 - d * d)) + 0.6));
  float lit = clamp(dot(n, normalize(vec3(-sunG, 0.9))), 0.0, 1.0);
  float sd = length(f - ctr + sunG * 0.08) / rad;
  float shadow = (1.0 - smoothstep(0.75, 1.0, sd)) * (1.0 - crown);
  return vec4(crown, lit, shadow, fract(hh.y * 13.7));
}

/** Farmland: fields in a grid turned its own way in each block (roads between blocks) */
vec3 farmland(vec2 w, out float edge, out float road) {
  vec2 B = vec2(3800.0);
  vec2 bc = floor((w - uCity) / B);
  float ang = (hash1(bc + 3.1) - 0.5) * 1.2;
  vec2 bf = fract((w - uCity) / B);
  vec2 be = min(bf, 1.0 - bf) * B;
  road = (1.0 - smoothstep(9.0, 9.0 + uPx * 1.1, min(be.x, be.y))) * resolves(40.0);
  vec2 lp = rot(ang) * (w - uCity);
  vec2 size = vec2(720.0, 470.0) * (0.8 + 0.4 * hash1(bc));
  vec2 fc = floor(lp / size), ff = fract(lp / size);
  vec2 fe = min(ff, 1.0 - ff) * size;
  edge = (1.0 - smoothstep(4.0, 4.0 + uPx * 1.1, min(fe.x, fe.y))) * resolves(60.0);
  float pick = hash1(fc + bc * 13.7);
  // Crops in rows (one way or the other, field by field)
  float along = hash1(fc + 4.4) < 0.5 ? lp.x : lp.y;
  float rows = 0.5 + 0.5 * sin(along / 34.0 * 6.2832);
  rows = mix(0.5, rows, resolves(34.0));
  vec3 green = uLow * vec3(1.02, 1.06, 0.9), ripe = mix(uDry, uLow, 0.15), plough = mix(uSoil, uDry, 0.25), pasture = mix(uLow, uDry, 0.3) * 0.95;
  vec3 col = pick < 0.3 ? green : pick < 0.52 ? ripe : pick < 0.72 ? plough : pasture;
  float rowAmt = pick < 0.72 ? 0.16 : 0.04;
  col *= 1.0 - rowAmt + rowAmt * 2.0 * rows;
  col *= 0.94 + 0.12 * hash1(fc + 9.9);
  return col;
}

void main() {
  vec2 w = worldAt((vUV - 0.5) * uRes, 1.0);
  if (uCave > 0.5) { fragColor = vec4(caveFloor(w), 1.0); return; }
  float style = uStyle.x;
  bool terran = style < 0.5 || style > 3.5;
  vec2 q = warpAt(w);
  float h = heightQ(w, q);
  // Slopes against the sun, and how the ground curves (creases dark): over a few hundred units, smooth
  float e = 320.0;
  float hx1 = heightQ(w + vec2(e, 0.0), q), hx0 = heightQ(w - vec2(e, 0.0), q);
  float hy1 = heightQ(w + vec2(0.0, e), q), hy0 = heightQ(w - vec2(0.0, e), q);
  vec2 g = vec2(hx1 - hx0, hy1 - hy0) / (2.0 * e) * 2400.0 * uFeat2.x;
  float curve = (hx1 + hx0 + hy1 + hy0 - 4.0 * h) * 60.0;
  float slope = length(g);

  float sea = uLand.x, a = (h - sea) / max(0.001, 1.0 - sea);
  float detail = texture(uNoise, rot(0.4) * w / 1700.0 + uSeed).a;
  float grit = texture(uNoise, rot(1.9) * w / 260.0 + uSeed * 2.0).a;
  float big = texture(uNoise, rot(2.3) * w / 21000.0 + uSeed * 1.7).g;
  float dc = length(w - uCity);
  float city = uLand.z > 0.0 ? 1.0 - smoothstep(uLand.z * 0.75, uLand.z * 1.15, dc) : 0.0;

  vec3 col;
  vec3 emis = vec3(0.0);
  vec2 fineGrad = vec2(0.0);
  float ao = 1.0;
  bool water = false;
  float glint = 0.0;

  if (style > 2.5 && style < 3.5) {
    // ---- Lava: a crust over the low ground, cracked, molten in its seams and open where it runs hottest ----
    vec2 flow = vec2(uTime * 5.0, uTime * 1.6);
    if (h < sea) {
      float d = sea - h;
      // Plates of crust (big ones, some split again), drifting slowly; seams between them in world units
      vec2 cp = (w + flow + q * 2400.0) / 1250.0;
      vec2 c = cells(cp, 3.0);
      vec2 c2 = cells(cp * 2.6 + 5.1, 4.0);
      float edgeD = min(c.x * 1250.0, c2.y > 0.55 ? c2.x * 1250.0 / 2.6 + 6.0 : 1e4);
      // Where it runs hot: winding channels of open lava, and the deep middle of the flows
      float chan = texture(uNoise, rot(0.8) * (w + q * 3000.0) / 9000.0 + uSeed * 1.3).b;
      float hot = clamp(smoothstep(0.72, 0.9, chan) + smoothstep(0.08, 0.24, d) * 0.45, 0.0, 1.0) * (1.0 - uFeat2.z * 0.45);
      float sw = 7.0 + 120.0 * hot * hot;
      float crust = smoothstep(sw, sw + 20.0 + uPx, edgeD) * (1.0 - smoothstep(0.82, 1.0, hot));
      float pulse = 0.85 + 0.15 * sin(uTime * 0.9 + c.y * 31.0);
      float core = 1.0 - smoothstep(0.0, sw + 30.0, edgeD);
      vec3 molten = mix(uDeep, uShallow, clamp(core * 0.8 + hot * 0.5, 0.0, 1.0));
      emis = molten * (1.0 - crust) * pulse * 0.88;
      // The crust: dark, cooled, a dull glow through it beside the seams
      col = mix(uRock, uDry * 0.8, c.y * 0.7) * (0.8 + 0.35 * grit) * (0.9 + 0.2 * c2.y);
      emis += uSoil * crust * 0.3 * exp(-(edgeD - sw) / 70.0) * pulse;
      col *= crust;
      // Plates a little raised (their rims catch the light)
      fineGrad += (vec2(dFdx(edgeD), dFdy(edgeD)) / max(uPx, 1.0)) * 0.6 * crust * (1.0 - smoothstep(30.0, 120.0, edgeD)) * resolves(300.0);
    } else {
      // Basalt and ash: ash on the flats, bare dark rock on slopes, ridged old flows
      float flows = smoothstep(0.35, 0.65, texture(uNoise, rot(1.2) * (w + q * 3000.0) / 5200.0 + uSeed).b);
      float ash = smoothstep(0.9, 0.3, slope) * smoothstep(0.35, 0.65, big + (detail - 0.5) * 0.6);
      col = mix(uLow, uHigh, flows);
      col = mix(col, uDry, ash * 0.75);
      col = mix(col, uRock, smoothstep(0.4, 0.62, a));
      col = mix(col, uPeak, smoothstep(0.62, 0.85, a) * 0.6);
      col *= 0.82 + 0.3 * grit;
      // Ash dunes: ripples running across the wind, warped
      vec2 rd = normalize(vec2(0.8, 0.35));
      float rip = sin((dot(w, rd) + detail * 900.0) / 95.0 * 6.2832);
      fineGrad += rd * rip * 0.35 * ash * uStyle.z * resolves(95.0);
      // Fissures on land, faintly glowing; molten vents here and there
      vec2 fc = cells((w + q * 1800.0) / 2600.0, 9.0);
      float fd = fc.x * 2600.0;
      float wide = texture(uNoise, rot(0.3) * w / 5200.0 + uSeed * 4.0).r;
      // (every seam a dark crack; only some stretches open enough to glow, the rest cooled)
      float glow = smoothstep(0.45, 0.72, wide) * uFeat2.z;
      float fw = 3.0 + 14.0 * glow;
      float fis = 1.0 - smoothstep(fw, fw + uPx * 1.2, fd);
      float halo = exp(-fd / (40.0 + fw * 4.0)) * glow;
      emis += mix(uDeep, uShallow, 0.35) * fis * glow * 0.95 + uDeep * halo * 0.35;
      col *= 1.0 - max(fis * 0.75, halo * 0.35);
      vec2 vp = w / 1500.0 + 2.7, vc = floor(vp), vf = fract(vp) - 0.5 - (hash2(vc + 1.3) - 0.5) * 0.4;
      float vent = step(hash1(vc + 7.0), 0.07) * exp(-dot(vf, vf) * 220.0);
      emis += mix(uDeep, uShallow, 0.5) * vent * (0.7 + 0.3 * sin(uTime * 1.7 + vc.x * 3.0));
      // The shore glows with the lava beside it
      float near = exp(-(h - sea) / 0.018);
      emis += uDeep * near * 0.45;
      col *= 1.0 - near * 0.5;
    }
  } else if (style > 1.5 && style < 2.5) {
    // ---- Ice: pack ice on the sea, snowfields, glacier ice in the valleys, crevasses on the slopes ----
    if (h < sea) {
      float d = sea - h;
      vec2 fc = cells((w + q * 2000.0) / 1500.0, 5.0);
      vec2 fc2 = cells((w + q * 1200.0) / 520.0 + 3.3, 6.0);
      float open = smoothstep(0.02, 0.14, d) * 0.12 + smoothstep(0.55, 0.85, big) * 0.08;
      float lead = 0.03 + open;
      float floe = smoothstep(lead, lead + 0.02 + uPx / 1500.0, fc.x);
      float crack = 1.0 - smoothstep(0.015, 0.015 + uPx / 520.0 * 1.2, fc2.x);
      vec3 ice = mix(uLow, uHigh, fc.y * 0.8) * (0.94 + 0.08 * grit);
      ice = mix(ice, uDry, smoothstep(0.75, 0.95, fc.y) * 0.6);
      ice *= 1.0 - crack * 0.18 * uFeat2.z;
      // Pressure ridges along each floe's edge
      ice *= 1.0 + 0.1 * (1.0 - smoothstep(0.0, 0.08, fc.x - lead));
      vec3 sw = mix(uShallow, uDeep, smoothstep(0.0, 0.1, d));
      col = mix(sw, ice, floe);
      water = floe < 0.5;
      glint = (1.0 - floe) * 0.5;
    } else {
      float patchI = texture(uNoise, rot(0.7) * (w + q * 1500.0) / 6200.0 + uSeed * 2.9).g;
      col = mix(uLow, uHigh, smoothstep(0.3, 0.7, patchI) * 0.6 + (detail - 0.5) * 0.15);
      // Drifts: the snow streaked along the wind
      vec2 wd = normalize(vec2(0.9, -0.42));
      float drift = texture(uNoise, vec2(dot(w, wd) / 5200.0, dot(w, vec2(-wd.y, wd.x)) / 700.0) + uSeed * 1.9).r;
      col *= 0.93 + 0.12 * drift;
      // Glacier ice: blue, streaked along the way it flows (downhill), where the snow's blown off
      vec2 fd = slope > 0.001 ? g / slope : wd;
      float streak = texture(uNoise, vec2(dot(w, fd) / 2600.0, dot(w, vec2(-fd.y, fd.x)) / 260.0) + uSeed).r;
      float gl = big * 0.6 + patchI * 0.4 + (streak - 0.5) * 0.1;
      float glacier = smoothstep(0.54, 0.66, gl) * (1.0 - smoothstep(0.45, 0.7, a));
      col = mix(col, uDry * (0.85 + 0.25 * streak), glacier * 0.6);
      // Crevasses: fields of thin cuts across the flow, along the glaciers' edges
      float margin = smoothstep(0.47, 0.54, gl) * (1.0 - smoothstep(0.58, 0.64, gl)) * (1.0 - smoothstep(0.45, 0.7, a));
      float cr = texture(uNoise, vec2(dot(w, fd) / 210.0, dot(w, vec2(-fd.y, fd.x)) / 1500.0) + uSeed * 3.3).b;
      float crev = smoothstep(0.78, 0.92, cr) * margin * uFeat2.z * resolves(90.0);
      col = mix(col, uSoil * 0.55, crev * 0.8);
      // Rock showing through: dark outcrops on the heights and the steeps
      float crag = texture(uNoise, rot(1.1) * w / 2600.0 + uSeed).b;
      float out_ = smoothstep(0.7, 0.86, crag * 0.7 + a * 0.5 + (detail - 0.5) * 0.2) + smoothstep(1.6, 2.6, slope) * 0.8;
      out_ = clamp(out_, 0.0, 1.0);
      col = mix(col, uRock * (0.7 + 0.4 * crag) * (0.9 + 0.2 * grit), out_);
      fineGrad += (vec2(dFdx(crag), dFdy(crag)) / max(uPx, 1.0)) * 120.0 * out_ * resolves(200.0);
      // Snow caps above the snow line (not on the rock)
      col = mix(col, uPeak, smoothstep(0.35, 0.9, a) * 0.4 * (1.0 - out_));
      // Wind-cut ripples in the snow (sastrugi)
      vec2 rd = normalize(vec2(0.9, -0.42));
      float rip = sin((dot(w, rd) + detail * 700.0 + grit * 90.0) / 70.0 * 6.2832);
      fineGrad += rd * rip * 0.22 * uStyle.z * (1.0 - glacier) * resolves(70.0);
      col *= 0.96 + 0.06 * grit;
    }
  } else if (style > 0.5 && style < 1.5) {
    // ---- Rocky (a moon): grey regolith, dark maria on the low ground, craters at three sizes ----
    float mare = smoothstep(0.46, 0.3, big + (h - 0.5) * 0.08 + (detail - 0.5) * 0.04) * (1.0 - city);
    col = mix(uLow, uHigh, smoothstep(0.2, 0.8, detail));
    col = mix(col, uPeak, smoothstep(0.35, 1.0, a) * 0.35 * (0.6 + 0.4 * grit));
    col = mix(col, uDry, mare * 0.85);
    col *= 0.9 + 0.18 * grit;
    float dens = uFeat.w * (1.0 - mare * 0.55);
    vec3 c1 = crater(w, 6200.0, 0.0, dens * 0.55, fineGrad);
    vec3 c2 = crater(w, 1900.0, 1.3, dens * 0.7, fineGrad);
    vec3 c3 = crater(w, 560.0, 2.6, dens * 0.8, fineGrad);
    vec3 c4 = crater(w, 190.0, 3.9, dens * 0.6, fineGrad);
    // Fresh rims and ejecta bright, the bowls' floors a shade darker
    float bright = c1.x * 0.35 + c2.x * 0.3 + c3.x * 0.25 + c4.x * 0.15 + (c1.z + c2.z) * 0.18;
    col = mix(col, uSoil, clamp(bright, 0.0, 1.0) * 0.55);
    col *= 1.0 - (c1.y + c2.y) * 0.08;
    // Fissures (a fractured world)
    vec2 fc = cells((w + q * 2600.0) / 3400.0, 4.0);
    float fd = fc.x * 3400.0;
    float open = smoothstep(0.35, 0.7, texture(uNoise, rot(0.3) * w / 6000.0 + uSeed * 4.0).r) * uFeat2.z;
    float fw = 2.0 + 13.0 * open;
    float fis = (1.0 - smoothstep(fw, fw + uPx * 1.2, fd)) * step(0.05, uFeat2.z);
    col *= 1.0 - fis * (0.4 + 0.5 * open);
    // (the lip on each side catches the light)
    col = mix(col, uSoil, (1.0 - smoothstep(fw, fw * 2.5 + uPx, fd)) * (1.0 - fis) * open * 0.3);
  } else {
    // ---- Terran (and desert, toxic): sea, beaches, meadows and scrub, forests, rivers, farmland, rock, snow ----
    // Where things grow: broad wet and dry country, patches within it (not the height's contours, which would ring every hill)
    float patchN = texture(uNoise, rot(0.7) * (w + q * 1500.0) / 7600.0 + uSeed * 2.9).g;
    float moist = big * 0.55 + patchN * 0.45 + uFeat2.w + (detail - 0.5) * 0.18;
    if (h < sea) {
      float d = sea - h;
      col = mix(uShallow, uDeep, smoothstep(0.0, 0.13, d));
      // The sandy floor showing through the shallows
      col = mix(col, mix(uShore, uShallow, 0.55), (1.0 - smoothstep(0.0, 0.03, d)) * 0.5);
      // Light catching the swell
      float sw = texture(uNoise, w / 2200.0 + vec2(uTime * 0.004, uTime * 0.002)).a;
      col += vec3(0.04, 0.06, 0.07) * smoothstep(0.6, 0.8, sw) * (1.0 - smoothstep(0.0, 0.1, d));
      // Surf: a line of foam on the shore and a fainter one coming in
      float foam = 1.0 - smoothstep(0.0, 0.005, d);
      foam += (1.0 - smoothstep(0.0, 0.003, abs(d - 0.012 - 0.003 * sin(uTime * 0.5 + grit * 6.0)))) * 0.35;
      col = mix(col, vec3(0.86, 0.91, 0.93), clamp(foam, 0.0, 1.0) * 0.55);
      water = true;
      glint = 1.0;
      fineGrad += (vec2(texture(uNoise, w / 900.0 + 0.3).a, texture(uNoise, w / 900.0 + 0.6).a) - 0.5) * 0.25;
    } else {
      // Grass: lush, drier in patches on the low ground; mottled
      float dry = smoothstep(0.44, 0.26, moist) * (1.0 - smoothstep(0.15, 0.35, a)) * 0.6;
      col = mix(uLow, uDry, dry);
      float mott = texture(uNoise, rot(2.9) * w / 640.0 + uSeed * 3.0).r;
      col *= (0.86 + 0.2 * detail) * (0.86 + 0.26 * mott) * (0.95 + 0.1 * grit);
      col = mix(col, col * vec3(1.06, 1.0, 0.8), smoothstep(0.55, 0.75, mott) * 0.5);
      // Rivers: winding down the lowland, narrowing uphill, none in the city
      float rv = texture(uNoise, rot(1.7) * (w / 15000.0 + q * 0.35) + uSeed * 2.3).r;
      float rw = max(0.0, 0.006 - a * 0.016) * uFeat.y * (1.0 - city);
      float fw = fwidth(rv);
      float river = (1.0 - smoothstep(rw, rw + fw, abs(rv - 0.5))) * step(0.0001, rw);
      float bank = (1.0 - smoothstep(rw, rw * 4.0 + fw * 2.0, abs(rv - 0.5))) * step(0.0001, rw);
      col = mix(col, uLow * vec3(0.8, 1.0, 0.8), bank * 0.45);
      // Farmland round the city: on flat low ground, giving way to the wild further out
      float farm = uFeat.z * smoothstep(uLand.z * 1.02, uLand.z * 1.2, dc)
        * (1.0 - smoothstep(uLand.z * 2.2, uLand.z * 3.4, dc + (big - 0.5) * 5000.0))
        * (1.0 - smoothstep(0.35, 0.8, slope)) * (1.0 - smoothstep(0.18, 0.3, a)) * (1.0 - bank);
      if (farm > 0.01) {
        float edge, road;
        vec3 fcol = farmland(w, edge, road);
        fcol = mix(fcol, uHigh * 0.8, edge * 0.6);
        fcol = mix(fcol, mix(uUrban, uShore, 0.5) * 0.9, road * 0.8);
        col = mix(col, mix(fcol, col, 0.2), farm);
      }
      // Forest: on the wetter ground, the hills, along rivers; thinning out ragged at its edges
      float wood = smoothstep(0.47, 0.6, moist + a * 0.35 + (grit - 0.5) * 0.12 + bank * 0.3) * (1.0 - smoothstep(0.4, 0.52, a));
      wood *= uFeat.x * (1.0 - city) * (1.0 - farm * 0.92) * smoothstep(0.0, 0.04, a);
      if (wood > 0.01) {
        vec3 leaf = mix(uHigh, uHigh * vec3(0.8, 1.05, 1.15), smoothstep(0.4, 0.7, detail));
        leaf = mix(leaf, uHigh * vec3(1.2, 1.1, 0.75), smoothstep(0.6, 0.8, big) * 0.6);
        float dens = smoothstep(0.0, 0.45, wood);
        vec4 t1 = trees(w, 92.0, 0.0, dens * 1.3);
        vec4 t2 = trees(w, 66.0, 0.5, dens * 1.2 - 0.05);
        float res = resolves(92.0);
        float crown = max(t1.x, t2.x), lit = t1.x > t2.x ? t1.y : t2.y, tint = t1.x > t2.x ? t1.w : t2.w;
        leaf *= mix(vec3(0.92, 1.0, 1.08), vec3(1.12, 1.06, 0.82), tint) * (0.9 + 0.2 * fract(tint * 7.0));
        float shadow = max(t1.z, t2.z) * (1.0 - crown);
        // Close: crowns, each lit on its sunny side, over the dark of the forest floor (or the grass, where it's thin)
        float floorAmt = smoothstep(0.35, 0.75, wood);
        vec3 under = mix(col * 0.7, uHigh * 0.5, floorAmt);
        vec3 near = mix(under * (1.0 - shadow * 0.45), leaf * (0.78 + 0.5 * lit) * (0.92 + 0.16 * grit), crown);
        float nearCover = max(crown, max(floorAmt, shadow * 0.6));
        // Far: the canopy as one, mottled
        vec3 far = leaf * (0.8 + 0.24 * grit) * (0.92 + 0.16 * mott);
        float farCover = smoothstep(0.05, 0.55, wood);
        vec3 forest = mix(far, near, res);
        col = mix(col, forest, clamp(mix(farCover, nearCover, res), 0.0, 1.0));
        ao *= 1.0 - 0.12 * smoothstep(0.2, 0.8, wood) * (1.0 - res);
      }
      // The shore: sand, wet near the water
      float beach = 1.0 - smoothstep(0.0, 0.03 + 0.02 * detail, a);
      col = mix(col, uShore * (0.85 + 0.15 * smoothstep(0.0, 0.012, a)), beach);
      // Rock on the steeps and heights; snow over it
      float rk = smoothstep(0.4, 0.6, a + (detail - 0.5) * 0.14) + smoothstep(1.6, 2.6, slope) * 0.5;
      // (craggy: ridged noise at two scales, its crests catching the light)
      float crag = texture(uNoise, rot(1.1) * w / 2600.0 + uSeed).b * 0.6 + texture(uNoise, rot(2.4) * w / 700.0 + uSeed).b * 0.4;
      vec3 rock = uRock * (0.84 + 0.26 * crag) * (0.92 + 0.14 * grit);
      fineGrad += (vec2(dFdx(crag), dFdy(crag)) / max(uPx, 1.0)) * 110.0 * clamp(rk, 0.0, 1.0) * resolves(200.0) * (1.0 - city);
      col = mix(col, rock, clamp(rk, 0.0, 1.0));
      col = mix(col, uPeak, smoothstep(uLand.y, uLand.y + 0.06, a + grit * 0.04) * (1.0 - smoothstep(1.2, 1.8, slope) * 0.7));
      // Ripples (dunes) on dry ground
      if (uStyle.z > 0.0) {
        vec2 rd = normalize(vec2(0.7, 0.5));
        float rip = sin((dot(w, rd) + detail * 1400.0) / 160.0 * 6.2832);
        fineGrad += rd * rip * 0.45 * uStyle.z * resolves(160.0) * smoothstep(0.4, 0.2, moist);
      }
      // The river itself, over all of it
      col = mix(col, mix(uShallow, uDeep, 0.25), river);
      if (river > 0.5) { water = true; glint = 0.6; }
      // The city: grey blocks between streets, fading out at its edge
      if (city > 0.0) {
        vec2 cc = abs(mod(w - uCity, 640.0) - 320.0);
        float street = smoothstep(284.0, 292.0, max(cc.x, cc.y));
        vec3 urban = uUrban * (0.9 + 0.2 * texture(uNoise, floor((w - uCity) / 640.0) * 0.137).a);
        col = mix(col, urban, city);
        col = mix(col, uUrban * 0.45, street * city);
      }
    }
  }

  // ---- Light ----
  vec3 L = normalize(vec3(-uSun, 0.9));
  vec2 tilt = water ? vec2(0.0) : g;
  tilt *= 1.0 - city;
  fineGrad *= 1.0 - city;
  vec3 n = normalize(vec3(-(tilt + fineGrad * uFeat2.y), 1.0));
  // (wrapped a little: the land's long slopes shade gently, the fine relief and craters crisply)
  float sun = clamp((dot(n, L) + 0.2) / 1.2, 0.0, 1.0);
  // Creases darker, crests a touch brighter
  // (curve runs about ±7: kept well inside its range, so it shades softly rather than in plateaus)
  ao *= 1.0 - clamp(curve * 0.011, -0.05, 0.1);
  vec3 sky = uSkylight * (0.55 + 0.45 * n.z);
  // (the light's level kept where flat open ground was before: about 0.92)
  vec3 light = (uSunlight * sun * 0.95 + sky * 0.8) * ao;
  if (water) light = mix(uSunlight * 0.62, light, 0.35) + uSkylight * 0.25;
  col *= light;
  // The sun's glint on water (rippled)
  vec3 hv = normalize(L + vec3(0.0, 0.0, 1.0));
  col += uSunlight * pow(clamp(dot(n, hv), 0.0, 1.0), 90.0) * 0.35 * glint;
  // Cloud shadows, cast along the sunlight: the shade takes the sky's colour
  float cs = clouds(w - uSun * 900.0) * uCloud.w;
  col *= mix(vec3(1.0), uSkylight * 1.2 + 0.35, cs * 1.6);
  emis *= 1.0 - cs * 0.3;
  // Haze: thicker the higher you are (zoomed out) and towards the edge of the map
  float alt = uStyle.y * 0.13 * (1.0 - smoothstep(0.04, 0.25, uZoom));
  float r = length(w) / uLand.w;
  col = mix(col, uHaze, clamp(alt + smoothstep(0.8, 1.02, r) * 0.8, 0.0, 0.9));
  vec3 outc = night(col) + emis * (1.0 - smoothstep(0.8, 1.02, r) * 0.6);
  fragColor = vec4(outc, 1.0);
}
`;
