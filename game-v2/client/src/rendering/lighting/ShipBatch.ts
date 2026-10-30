/**
 * Ships' hulls, lit, drawn in chunks like the asteroids (AsteroidBatch): up to
 * PER_CHUNK hulls share one mesh and one draw, each in its own slot placed by
 * the shader. A chunk takes its lights from round the ships in it.
 *
 * How a hull looks (ships/hullLook.ts): today's lighting per vertex, with each
 * light scaled by how open the vertex is towards it (exposure), the normal
 * leaned towards open space (volume, so a hull reads rounded), panel detail
 * from the hull atlas (first-order normal mapping), a linearised highlight,
 * metal reflecting dark space and the star's glint, a cool rim, part tones,
 * each hull material's own surface and each grade's glow colour.
 *
 * A hull's geometry is its structure at full health (ShipGeometry: each vertex
 * knows its part and its look). Damage is data: each chunk has a small texture, a row per
 * slot and a texel per part (its HP fraction), and the shader darkens a hurt
 * part towards ember and dims its glow, so taking damage rebuilds nothing.
 * The hit flash is a per-slot value too. Damage has character: soot spreads
 * over a hurt part in patches, dark cracks spread across it, and glowing ones
 * open on a badly hurt one (procedural, a little arithmetic a pixel). Its own
 * lights (emissive details) stay lit whatever its damage.
 *
 * Ships near each other share a chunk: a ship joins the nearest chunk with
 * room, and now and then one that has drifted far from its chunk moves to a
 * nearer one, so a chunk with nothing on screen is skipped whole and its
 * lights are picked for a small area. A hull also has a light version (flat
 * parts, no bevels or small hardware); a chunk draws it while its biggest
 * shown ship is small on screen (FAR_BELOW). A chunk's geometry is rebuilt only
 * when a hull's structure changes or a ship joins or leaves, at most
 * REBUILDS_PER_FRAME a frame; until its chunk is rebuilt, a slot whose hull
 * changed keeps drawing what it had, and a new ship isn't drawn. The far
 * version is merged only once the chunk is drawn far off. A big hull (a
 * boss's: SOLO_VERTS) has a chunk to itself, so ships coming and going beside
 * it never copy it again. An emptied chunk is destroyed (one shared one kept).
 */

import { BufferImageSource, Container, Geometry, GlProgram, Shader, Texture, UniformGroup } from 'pixi.js';
import { LitGeometry } from './LitGeometry';
import { Lighting, LitMesh } from './Lighting';
import { MAX_LIGHTS, fades } from './litShader';
import { GLOW_COOL, GLOW_WARM, HULL_WEAR, KIND_GLOW, KIND_LOOK, hullAtlas } from '../../ships/hullLook';
import { HULL_ROWS } from '../../ships/hullTextures';

const PER_CHUNK = 32;
/** Parts a ship can have (data/ships/tuning.json maxParts), the damage texture's width */
export const SHIP_MAX_PARTS = 256;
/** Chunk rebuilds per frame at most (more wait a frame) */
const REBUILDS_PER_FRAME = 2;
/** A ship this far from its chunk's middle looks for a nearer chunk (world units), checked every REGROUP_EVERY frames, a few at a time */
const REGROUP_FAR = 6000;
const REGROUP_EVERY = 30;
const REGROUP_MOVES = 3;
/** A chunk draws its hulls' light versions while its biggest shown ship's radius on screen is under this (pixels) */
export const FAR_BELOW = 22;

/** A part's look, shared by its vertices: what it does (kind), tone, hull material (tile, metal, own light, highlight boost), grade and its material's colour */
export interface PartLook { kind: number; tone: number; hull: readonly number[]; grade: readonly number[]; /** its hardware's (decor) hull values */ decor: readonly number[] }
/** A vertex's hull values and grade with no look */
const NO_HULL = [-1, 0.55, 0, 0] as const, NO_GRADE = [1, 0.5, 0.5, 0.5] as const;

/**
 * Lit geometry whose vertices also carry their part (its damage texel) and its
 * look (PartLook), whether they're an engine's glowing disc, and the baked
 * exposure and volume (bakeHull; zero until baked).
 */
export class ShipGeometry extends LitGeometry {
  part: number[] = [];
  kind: number[] = [];
  tone: number[] = [];
  hullMat: number[] = [];
  grade: number[] = [];
  engine: number[] = [];
  expo: number[] = [];
  bend: number[] = [];
  /**
   * What each vertex needs besides its own part (-1: nothing), so a hull built whole (a boss's) shows only what's
   * there: a part that must still stand (what a detail reaching off its part lies on), and one that must be gone (the
   * part that covers it: a next stage beneath)
   */
  dep: number[] = [];

  /**
   * Every vertex added since `from` is part `p`, with its look; `engine`: glowing engine discs among them (a test per
   * vertex, or the vertex ranges [from, to) they span)
   */
  markPart(from: number, p: number, look?: PartLook, decorFrom = this.vertexCount, engine?: ((k: number) => boolean) | readonly (readonly [number, number])[]): void {
    const hullA = look ? look.hull : NO_HULL, decorA = look ? look.decor : NO_HULL, gr = look ? look.grade : NO_GRADE;
    const ranges = typeof engine === 'function' ? null : engine, test = typeof engine === 'function' ? engine : null;
    for (let k = this.part.length; k < this.vertexCount; k++) {
      const mine = k >= from, decor = k >= decorFrom;
      this.part.push(mine ? p : 0);
      this.kind.push(look ? (decor ? 4 : look.kind) : 4);
      this.tone.push(look && !decor ? look.tone : 1);
      // (pushed by element: a spread per vertex was most of a big hull's marking)
      const h = decor ? decorA : hullA;
      this.hullMat.push(h[0], h[1], h[2], h[3]);
      this.grade.push(gr[0], gr[1], gr[2], gr[3]);
      let glow = 0;
      if (test) glow = test(k) ? 1 : 0;
      else if (ranges) for (let r = 0; r < ranges.length; r++) if (k >= ranges[r][0] && k < ranges[r][1]) { glow = 1; break; }
      this.engine.push(glow);
      this.expo.push(0.5, 0, 0);
      this.bend.push(0, 0, 0);
      this.dep.push(-1, -1);
    }
  }

  override append(o: LitGeometry, slot: number): void {
    super.append(o, slot);
    const g = o instanceof ShipGeometry ? o : null, n = o.vertexCount;
    const copy = (to: number[], from: number[] | undefined, per: number, dflt: number[]) => {
      for (let k = 0; k < n; k++) for (let c = 0; c < per; c++) to.push(from?.[k * per + c] ?? dflt[c]);
    };
    copy(this.part, g?.part, 1, [0]);
    copy(this.kind, g?.kind, 1, [4]);
    copy(this.tone, g?.tone, 1, [1]);
    copy(this.hullMat, g?.hullMat, 4, [-1, 0.55, 0, 0]);
    copy(this.grade, g?.grade, 4, [1, 0.5, 0.5, 0.5]);
    copy(this.engine, g?.engine, 1, [0]);
    copy(this.expo, g?.expo, 3, [0.5, 0, 0]);
    copy(this.bend, g?.bend, 3, [0, 0, 0]);
    copy(this.dep, g?.dep, 2, [-1, -1]);
  }

  toShipGeometry(into?: Geometry): Geometry {
    const g = this.toGeometry(into);
    const attrs: [string, number[], string][] = [
      ['aPart', this.part, 'float32'], ['aKind', this.kind, 'float32'], ['aTone', this.tone, 'float32'], ['aHull', this.hullMat, 'float32x4'],
      ['aGrade', this.grade, 'float32x4'], ['aGlow', this.engine, 'float32'], ['aExpo', this.expo, 'float32x3'], ['aBend', this.bend, 'float32x3'], ['aDep', this.dep, 'float32x2'],
    ];
    for (const [name, data, format] of attrs) {
      const buf = new Float32Array(data);
      if (into) g.getBuffer(name).data = buf;
      else g.addAttribute(name, { buffer: buf, format: format as 'float32' });
    }
    return g;
  }
}

/** The hull shader: the look (ships/hullLook.ts) plus each part's damage (from the chunk's texture) and each slot's hit flash */
const vertex = (slots: number) => `#version 300 es
in vec2 aPosition; in vec3 aNormal; in vec4 aColor; in float aSlot; in float aPart;
in float aKind; in float aTone; in vec4 aHull; in vec4 aGrade; in float aGlow; in vec3 aExpo; in vec3 aBend; in vec2 aDep;
out vec3 vColor; out vec3 vCx; out vec3 vCy; out vec2 vUV; out vec3 vEmis; out float vCav; flat out vec2 vTile;
out vec2 vLocal; out float vHurt; out float vSeed; out float vLit; flat out vec4 vWear; flat out vec3 vSeam;
uniform mat3 uProjectionMatrix; uniform mat3 uWorldTransformMatrix; uniform mat3 uTransformMatrix;
uniform vec4 uXform[${slots}]; uniform vec4 uFade[${fades(slots)}]; uniform float uPlace;
uniform vec4 uFlash[${fades(slots)}]; uniform highp float uTime; uniform float uCell;
uniform vec4 uKindLook[7]; uniform vec4 uKindGlow[7]; uniform vec3 uGlowCool[5]; uniform vec3 uGlowWarm[5]; uniform vec4 uWear[8];
uniform sampler2D uDamage;
uniform vec3 uAmbient; uniform vec4 uSun; uniform vec3 uSunColor; uniform vec2 uSunElev; uniform float uCount; uniform vec3 uGround;
uniform vec4 uLightPos[${MAX_LIGHTS}]; uniform vec4 uLightCol[${MAX_LIGHTS}]; uniform vec4 uLightCone[${MAX_LIGHTS}];
const vec3 EMBER = vec3(0.227, 0.051, 0.031);
const float FLOOR = 0.42, LEAN = 1.5;
vec2 cs;
// a light's share reaching here: by the vertex's exposure towards it, in the ship's own frame (straight down: all of it);
// never all the way dark (light scattered off the hull round it)
float expo(vec3 ld) {
  vec2 l = ld.xy; float hz = length(l);
  if (hz < 0.0001) return 1.0;
  vec2 ll = vec2(cs.x * l.x + cs.y * l.y, -cs.y * l.x + cs.x * l.y) / hz;
  return mix(1.0, mix(FLOOR, 1.0, clamp(aExpo.x + aExpo.y * ll.x + aExpo.z * ll.y, 0.0, 1.0)), hz);
}
void main() {
  int slot = int(aSlot + 0.5), mk = int(aKind + 0.5);
  vec4 X = uXform[slot], MA = uKindLook[mk];
  vec2 w = X.xy + vec2(X.z * aPosition.x - X.w * aPosition.y, X.w * aPosition.x + X.z * aPosition.y);
  float s = length(X.zw);
  if (s == 0.0) { vColor = vec3(0.0); gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  // what's there (the damage texture's green: its part standing): its part, what it lies on, and nothing over it
  float here = texelFetch(uDamage, ivec2(int(aPart + 0.5), slot), 0).g;
  float held = aDep.x < -0.5 ? 1.0 : texelFetch(uDamage, ivec2(int(aDep.x + 0.5), slot), 0).g;
  float over = aDep.y < -0.5 ? 0.0 : texelFetch(uDamage, ivec2(int(aDep.y + 0.5), slot), 0).g;
  if (here < 0.5 || held < 0.5 || over > 0.5) { vColor = vec3(0.0); gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  cs = X.zw / s;
  vec3 n = vec3(cs.x * aNormal.x - cs.y * aNormal.y, cs.y * aNormal.x + cs.x * aNormal.y, aNormal.z);
  // volume: the normal leans towards the open space its part faces (the hull reads rounded)
  vec2 bw = vec2(cs.x * aBend.x - cs.y * aBend.y, cs.y * aBend.x + cs.x * aBend.y);
  n = normalize(n + vec3(bw * LEAN, 0.0));
  // the part's health: hurt plating darkens towards ember (its own lights stay as they are)
  float f = texelFetch(uDamage, ivec2(int(aPart + 0.5), slot), 0).r;
  float m = aHull.y, boost = aHull.w;
  vec3 col = aColor.rgb * aTone;
  col = mix(mix(EMBER, col, 0.35 + 0.65 * f), col, step(0.01, aColor.a));
  vec3 body = col * mix(1.0, 0.55, m);
  vec3 L = uAmbient * (0.7 + 0.3 * clamp(aExpo.x * 1.4, 0.0, 1.0));
  vec2 ds = uSun.xy - w;
  float dist = length(ds);
  vec3 sl = vec3(ds / max(dist, 1.0) * uSunElev.x, uSunElev.y);
  float sunK = uSun.w / (1.0 + dist * dist / (uSun.z * uSun.z)) * expo(sl);
  // wrapped a little round the far side, so the shading stays gentle
  L += uSunColor * sunK * max(dot(n, sl) * 0.75 + 0.25, 0.0);
  // light up off the ground (a lava world's glow): mostly on faces turned away from straight up (bevels, sides), a little on tops
  L += uGround * (0.3 + 0.9 * (1.0 - clamp(n.z, 0.0, 1.0))) * (0.6 + 0.4 * clamp(aExpo.x * 1.4, 0.0, 1.0));
  vec3 dsum = sl * sunK, csum = uSunColor * sunK;
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
    vec3 ld = normalize(vec3(d, P.w));
    float k = uLightCol[i].a * a * expo(ld);
    L += uLightCol[i].rgb * (k * max(dot(n, ld), 0.0));
    dsum += ld * k; csum += uLightCol[i].rgb * k;
  }
  float fade = uFade[slot / 4][slot % 4];
  vec3 Lc = min(L, vec3(1.6)), cl = min(csum, vec3(1.6));
  vColor = body * mix(Lc, vec3(1.0), aColor.a) * fade;
  // metal reflects space: near black, a faint haze of the system's own light, and the star's glint
  vec3 R = vec3(2.0 * n.z * n.xy, 2.0 * n.z * n.z - 1.0), Rn = normalize(R);
  float star = max(dot(Rn, sl), 0.0);
  vec3 env = vec3(0.006, 0.007, 0.011) + uAmbient * 0.12 * (0.6 + 0.4 * Rn.z) + uSunColor * (pow(star, 10.0) * 1.1 + pow(star, 3.0) * 0.12)
    // (and what's round it: on a surface, the glowing ground, most at grazing angles)
    + uGround * (0.5 + 0.9 * (1.0 - Rn.z));
  vColor += env * mix(vec3(1.0), col * 1.5, 0.6) * m * 0.5 * fade;
  // a cool rim where a bevel turns away, on the outside of the hull
  float rim = 1.0 - clamp(n.z, 0.0, 1.0);
  // (space's cool rim; on a surface, the ground's colour)
  float gm = max(max(uGround.r, uGround.g), uGround.b);
  vec3 rimTint = gm > 0.001 ? mix(vec3(0.55, 0.65, 0.85), uGround / gm, 0.8) : vec3(0.55, 0.65, 0.85);
  vColor += col * rimTint * rim * rim * 1.0 * (1.0 + 0.4 * m) * clamp(aExpo.x * 1.5, 0.0, 1.0) * fade;
  // the panels' frame: the ship's own axes, and the light's direction in it
  vec3 T = vec3(cs, 0.0), B = vec3(-cs.y, cs.x, 0.0);
  float dl = length(dsum);
  vec3 Ld = dl > 0.0001 ? dsum / dl : vec3(0.0, 0.0, 1.0);
  vec2 Lt = vec2(dot(Ld, T), dot(Ld, B));
  vec3 D = body * cl * (1.0 - aColor.a) * fade;
  // the panel detail fades out as cells get small on screen (no shimmer on a far ship)
  float kx = MA.w * clamp((s * uCell - 7.0) / 10.0, 0.0, 1.0);
  // the highlight, with how fast it grows as the panels tilt the surface (metal: tighter, stronger, tinted)
  vec3 Hv = normalize(Ld + vec3(0.0, 0.0, 1.0));
  vec2 Ht = vec2(dot(Hv, T), dot(Hv, B));
  float shin = MA.y * (1.0 + m) * (1.0 + boost), nh = clamp(dot(n, Hv), 0.0, 1.0), sp = pow(nh, shin), dsp = min(shin * sp / max(nh, 0.05), 4.0) * kx;
  vec3 S = mix(vec3(1.0), col * 1.5, mix(0.5, 0.85, m)) * cl * MA.x * mix(1.0, 2.2, m) * (1.0 + boost) * (1.0 - aColor.a) * fade;
  vColor += S * sp;
  vCx = D * (0.7 * kx * Lt.x) + S * (dsp * Ht.x);
  vCy = D * (0.7 * kx * Lt.y) + S * (dsp * Ht.y);
  vCav = 0.9 * kx;
  // own light (cores, energy parts' vents, engines): its grade's colour, pulsing along the ship
  float gk = (aGrade.x - 1.0) / 4.0;
  int gi = clamp(int(aGrade.x + 0.5) - 1, 0, 4);
  vec4 E = uKindGlow[mk];
  float warm = step(E.g * 1.4, E.r), gl = 1.5 + 0.3 * gk;
  if (mk == 6) E.rgb = mix(E.rgb, uGlowCool[gi], 0.15) * (1.0 + 0.15 * gk);
  else if (E.r + E.g + E.b > 0.01) E.rgb = mix(uGlowCool[gi], uGlowWarm[gi], warm) * gl;
  float pulse = 0.7 + 0.3 * sin(uTime * E.w - dot(aPosition, vec2(0.045, 0.02)));
  float small = clamp((s * uCell - 9.0) / 10.0, 0.0, 1.0);
  vEmis = E.rgb * MA.z * pulse * fade * (mk >= 5 ? small : 1.0);
  // the higher grades' hull materials' own light (cobalt's hex edges, neutronium's seams, conductive bus lines)
  // (the game's own ships' materials give their glow's colour outright: aHull.z < 0, the colour in aGrade.yzw)
  vec3 ec = aHull.z < 0.0 ? aGrade.yzw : col / max(max(col.r, col.g), max(col.b, 0.05));
  vEmis += ec * abs(aHull.z) * (0.75 + 0.25 * sin(uTime * 1.7 - dot(aPosition, vec2(0.03, 0.05)))) * small * fade;
  if (mk == 3) vColor += E.rgb * 0.1 * pulse * fade;
  // engine discs take their grade's glow, flickering; glowing hardware brighter the higher the grade
  float flick = 0.82 + 0.18 * sin(uTime * 9.0 + aPosition.x * 0.3) * sin(uTime * 5.3 + aPosition.y * 0.2);
  vColor = mix(vColor, uGlowCool[gi] * min(gl, 1.35) * 1.05 * flick * fade, aGlow);
  vColor += uGlowCool[gi] * aColor.a * 0.14 * fade + col * aColor.a * gk * 0.4 * fade;
  // a hit flashes it white
  vColor += vec3(uFlash[slot / 4][slot % 4]) * fade;
  vUV = aPosition / (uCell * 2.0);
  int tl = aHull.x > -0.5 ? int(aHull.x + 0.5) : (mk >= 5 ? 2 : min(mk, 3));
  vTile = vec2(float(tl % 4), float(tl / 4));
  // (the game's own ships' materials are huge hulls: their surface is drawn six times larger)
  if (tl >= 16) vUV *= 0.16;
  float seed = fract(sin(aPart * 12.9898 + float(slot) * 78.233) * 43758.5453);
  // (the Scrap Mother's salvage: each part its own patch of its surface, turned its own way, as salvage is; the panel
  // detail's slopes turned back with it. Its tile's own light is where it's worn through: towards uWear's colour)
  vWear = tl >= 16 ? uWear[tl - 16] : vec4(1.0, 1.0, 1.0, 0.0);
  // a wreck's seams glow its material's own colour (the game's own ships': the Scrap Mother's green, the Brood Mother's
  // violet, the Pyreclast's molten orange); anything else's are molten orange
  // (as bright to the eye as the molten orange: a green seam would otherwise outshine it)
  vSeam = aHull.z < 0.0 ? aGrade.yzw * (0.52 / max(dot(aGrade.yzw, vec3(0.299, 0.587, 0.114)), 0.05)) : vec3(1.0, 0.36, 0.08);
  vWear.w *= (1.0 - aColor.a) * (1.0 - aGlow);
  if (tl >= 18) {
    float ra = floor(seed * 4.0) * 1.5708 + (fract(seed * 13.7) - 0.5) * 0.5, rc = cos(ra), rs = sin(ra);
    vUV = vec2(rc * vUV.x - rs * vUV.y, rs * vUV.x + rc * vUV.y) + vec2(fract(seed * 3.1), fract(seed * 5.7));
    vec3 cx = vCx;
    vCx = rc * cx - rs * vCy; vCy = rs * cx + rc * vCy;
  }
  vLocal = aPosition; vHurt = ((1.0 - f) + 0.5 * step(f, 0.003)) * (1.0 - aColor.a) * (1.0 - aGlow); vSeed = seed * 37.0; vLit = fade;
  vec2 pos = uPlace > 0.5 ? w : aPosition;
  gl_Position = vec4((uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix * vec3(pos, 1.0)).xy, 0.0, 1.0);
}`;
const fragment = `#version 300 es
precision mediump float;
in vec3 vColor; in vec3 vCx; in vec3 vCy; in vec2 vUV; in vec3 vEmis; in float vCav; flat in vec2 vTile;
in vec2 vLocal; in float vHurt; in float vSeed; in float vLit; flat in vec4 vWear; flat in vec3 vSeam;
uniform sampler2D uDetail;
uniform vec4 uColor; uniform highp float uTime;
out vec4 fragColor;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), u = fract(p); u = u * u * (3.0 - 2.0 * u);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
void main() {
  // the part's tile of the hull atlas (gradients from the unwrapped coordinates, so no seams in the mip choice)
  vec2 g = vec2(0.25, 1.0 / ${HULL_ROWS}.0);
  vec4 t = textureGrad(uDetail, (vTile + fract(vUV)) * g, dFdx(vUV) * g, dFdy(vUV) * g);
  vec2 sl = t.rg * 2.0 - 1.0;
  vec3 c = (vColor * (1.0 + (t.b - 0.5) * vCav) + vCx * sl.x + vCy * sl.y) * mix(vec3(1.0), vWear.rgb, t.a * vWear.w);
  if (vHurt > 0.02) {
    vec2 p = vLocal * 0.09 + vSeed;
    // soot: patches that spread over the part as it's hurt
    float n = noise(p) * 0.65 + noise(p * 2.7) * 0.35;
    float soot = smoothstep(1.0 - vHurt * 0.75, 1.18 - vHurt * 0.75, n);
    c *= 1.0 - 0.55 * soot;
    // dark cracks: fine black fractures from early on, spreading and widening as it's hurt
    float rd = 1.0 - abs(noise(p * 2.3 + 19.0) * 2.0 - 1.0), rd2 = 1.0 - abs(noise(p * 4.1 + 3.0) * 2.0 - 1.0);
    float dark = max(smoothstep(0.985 - vHurt * 0.07, 0.997, rd) * smoothstep(0.12, 0.4, vHurt),
                     smoothstep(0.99 - vHurt * 0.05, 0.998, rd2) * smoothstep(0.3, 0.7, vHurt));
    c *= 1.0 - 0.92 * dark;
    // glowing cracks: thin lines where a ridge of the noise peaks, opening on a badly hurt part
    float r = 1.0 - abs(noise(p * 1.6 + 7.0) * 2.0 - 1.0);
    float crack = smoothstep(0.975 - (vHurt - 0.5) * 0.05, 0.995, r) * smoothstep(0.5, 0.85, vHurt) * smoothstep(0.35, 0.6, n);
    float ember = 0.75 + 0.25 * sin(uTime * 3.0 + vSeed * 4.0 + n * 6.0);
    // a wreck (vHurt past 1: a ruined piece, still on): charred through, split by wide seams that throb in its own glow
    float ru = clamp((vHurt - 1.0) * 2.0, 0.0, 1.0);
    if (ru > 0.0) {
      c *= 1.0 - 0.45 * ru;
      // (seams on a broad scale: a few long splits across the plate, not a fine glitter)
      vec2 q = vLocal * 0.028 + vSeed;
      float rs = 1.0 - abs(noise(q) * 2.0 - 1.0), rs2 = 1.0 - abs(noise(q * 1.9 + 11.0) * 2.0 - 1.0);
      float seam = max(smoothstep(0.955, 0.99, rs), smoothstep(0.965, 0.993, rs2) * 0.8);
      crack = max(crack, seam * ru);
      ember *= 1.0 + 0.5 * ru * (0.5 + 0.5 * sin(uTime * 4.0 + vSeed + q.x * 3.0));
    }
    c = mix(c, vSeam * 1.4 * ember * vLit, crack);
  }
  // own light last (damage doesn't touch it)
  c += vEmis * t.a * (1.0 - vWear.w);
  fragColor = vec4(max(c, 0.0), vLit) * uColor;
}`;

let program: GlProgram | null = null;
/** The hulls' program (one for every chunk) */
export function shipHullProgram(): GlProgram {
  return (program ??= new GlProgram({ vertex: vertex(PER_CHUNK), fragment, name: `ship-hull-${PER_CHUNK}` }));
}

/** A ship's hull: as built close in, and its light version for far off */
export interface ShipHull { full: ShipGeometry; far: ShipGeometry }

/** A hull's attributes as the shader takes them: name, its field on ShipGeometry, per vertex, and its value if missing */
const ATTRS: [string, string, number, number[]][] = [
  ['aPosition', 'pos', 2, [0, 0]], ['aNormal', 'nrm', 3, [0, 0, 1]], ['aColor', 'col', 4, [1, 1, 1, 1]], ['aPart', 'part', 1, [0]],
  ['aKind', 'kind', 1, [4]], ['aTone', 'tone', 1, [1]], ['aHull', 'hullMat', 4, [-1, 0.55, 0, 0]], ['aGrade', 'grade', 4, [1, 0.5, 0.5, 0.5]],
  ['aGlow', 'engine', 1, [0]], ['aExpo', 'expo', 3, [0.5, 0, 0]], ['aBend', 'bend', 3, [0, 0, 0]], ['aDep', 'dep', 2, [-1, -1]],
];
/** A hull packed for merging into a chunk (each attribute a typed array): made once and kept with it */
interface Packed { n: number; attrs: Float32Array[]; idx: Uint32Array }
const PACKED = new WeakMap<ShipGeometry, Packed>();
function packed(g: ShipGeometry): Packed {
  let p = PACKED.get(g);
  if (p) return p;
  const n = g.vertexCount, src = g as unknown as Record<string, ArrayLike<number>>;
  const attrs = ATTRS.map(([, field, w, dflt]) => {
    const from = src[field];
    if (from instanceof Float32Array && from.length === n * w) return from;
    const out = new Float32Array(n * w);
    for (let k = 0; k < n * w; k++) out[k] = from?.[k] ?? dflt[k % w];
    return out;
  });
  p = { n, attrs, idx: g.idx instanceof Uint32Array ? g.idx : new Uint32Array(g.idx) };
  PACKED.set(g, p);
  return p;
}
/** Arrays a chunk's geometry is merged into, kept with it and grown as needed (not made anew each rebuild) */
export interface MergeScratch { attrs: Float32Array[]; slots: Float32Array; idx: Uint32Array }
const newScratch = (): MergeScratch => ({ attrs: [], slots: new Float32Array(0), idx: new Uint32Array(0) });
const grownF = (a: Float32Array | undefined, n: number) => (a && a.length >= n ? a : new Float32Array(Math.ceil(n * 1.25)));
/**
 * Hulls merged into a chunk's geometry (each in its slot), by block copies of their packed attributes; into `scratch`'s
 * arrays if given (views of them: grown, never shrunk). Returns how many vertices it copied.
 */
export function mergeInto(into: Geometry, hulls: [ShipGeometry, number][], scratch?: MergeScratch): number {
  const ps = hulls.map(([g, slot]) => [packed(g), slot] as const);
  const n = ps.reduce((a, [p]) => a + p.n, 0), ni = ps.reduce((a, [p]) => a + p.idx.length, 0);
  let attrs: Float32Array[], slots: Float32Array, idx: Uint32Array;
  if (scratch) {
    scratch.attrs = ATTRS.map(([, , w], k) => grownF(scratch.attrs[k], n * w));
    scratch.slots = grownF(scratch.slots, n);
    if (scratch.idx.length < ni) scratch.idx = new Uint32Array(Math.ceil(ni * 1.25));
    attrs = scratch.attrs.map((a, k) => a.subarray(0, n * ATTRS[k][2]));
    slots = scratch.slots.subarray(0, n);
    idx = scratch.idx.subarray(0, ni);
  } else {
    attrs = ATTRS.map(([, , w]) => new Float32Array(n * w)); slots = new Float32Array(n); idx = new Uint32Array(ni);
  }
  let v = 0, i = 0;
  for (const [p, slot] of ps) {
    ATTRS.forEach(([, , w], k) => attrs[k].set(p.attrs[k], v * w));
    slots.fill(slot, v, v + p.n);
    for (let j = 0; j < p.idx.length; j++) idx[i + j] = p.idx[j] + v;
    v += p.n; i += p.idx.length;
  }
  ATTRS.forEach(([name], k) => { into.getBuffer(name).data = attrs[k]; });
  into.getBuffer('aSlot').data = slots;
  into.indexBuffer.data = idx;
  return n;
}

/** A hull this big (vertices, close in) gets a chunk to itself (a boss's: never copied again when a ship beside it comes or goes) */
export const SOLO_VERTS = 8000;
/** A damage texture's row (a slot's), in bytes */
const ROW = SHIP_MAX_PARTS * 4;

interface Chunk {
  lit: LitMesh;
  /** Its geometries as last built: close in, and far off (merged only once it's drawn far off: `farDirty` until then) */
  geoFull: Geometry;
  geoFar: Geometry;
  farDirty: boolean;
  scratchFull: MergeScratch;
  scratchFar: MergeScratch;
  /** One big hull alone (SOLO_VERTS): no other ship joins it */
  solo: boolean;
  /** Each slot's ship (-1: free) */
  ids: number[];
  /** The ship each slot's geometry was last built for (-1: none), and with which hull */
  built: number[];
  builtHull: (ShipHull | null)[];
  hulls: Map<number, ShipHull>;
  radius: Map<number, number>;
  dirty: boolean;
  /** Each slot's parts' HP (0..255), a row per slot */
  damage: Uint8Array;
  damageTex: Texture;
  damageDirty: boolean;
  flash: Float32Array;
  shipUniforms: UniformGroup;
  /** The hull atlas it was given (swapped for the real one when that's built) */
  detail: Texture;
}

export class ShipBatch {
  readonly container = new Container();
  private chunks: Chunk[] = [];
  private where = new Map<number, Chunk>();
  /** Every ship's last known place (for grouping) */
  private pos = new Map<number, { x: number; y: number }>();
  /** Where to start looking for chunks to rebuild (so they take turns) */
  private next = 0;
  private frame = 0;
  /** What it's done (for measuring): chunk rebuilds, vertices copied into chunk geometry (close and far) */
  readonly stats = { rebuilds: 0, copied: 0, farMerges: 0 };
  /** Its ships while released (release(): no GPU geometry kept), to be set again on restore() */
  private parked: { id: number; hull: ShipHull; radius: number; row: Uint8Array }[] | null = null;

  /** `cellSize`: pixels a ship's grid cell (the panel detail's scale) */
  constructor(private lighting: Lighting, private cellSize = 24) {}

  /** How many chunks (draws, at most) it has */
  get chunkCount(): number {
    return this.chunks.length;
  }

  private newChunk(solo = false): Chunk {
    const geoFull = new ShipGeometry().toShipGeometry(), geoFar = new ShipGeometry().toShipGeometry();
    const lit = new LitMesh(geoFull, { slots: PER_CHUNK, chunk: true });
    lit.area = { x: 0, y: 0, r: 0 };
    const damage = new Uint8Array(SHIP_MAX_PARTS * PER_CHUNK * 4).fill(255);
    const damageTex = new Texture({ source: new BufferImageSource({
      resource: damage, width: SHIP_MAX_PARTS, height: PER_CHUNK, alphaMode: 'no-premultiply-alpha', scaleMode: 'nearest', addressMode: 'clamp-to-edge',
    }) });
    const flash = new Float32Array(fades(PER_CHUNK) * 4);
    const shipUniforms = new UniformGroup({
      uFlash: { value: flash, type: 'vec4<f32>', size: fades(PER_CHUNK) }, uTime: { value: 0, type: 'f32' }, uCell: { value: this.cellSize, type: 'f32' },
      uKindLook: { value: KIND_LOOK, type: 'vec4<f32>', size: 7 }, uKindGlow: { value: KIND_GLOW, type: 'vec4<f32>', size: 7 },
      uGlowCool: { value: GLOW_COOL, type: 'vec3<f32>', size: 5 }, uGlowWarm: { value: GLOW_WARM, type: 'vec3<f32>', size: 5 },
      uWear: { value: HULL_WEAR, type: 'vec4<f32>', size: 8 },
    });
    const detail = hullAtlas();
    lit.mesh.shader = new Shader({
      glProgram: shipHullProgram(),
      resources: { litUniforms: (lit.shader.resources as Record<string, unknown>).litUniforms, shipUniforms, uDamage: damageTex.source, uDetail: detail.source },
    });
    const chunk: Chunk = {
      lit, geoFull, geoFar, farDirty: false, scratchFull: newScratch(), scratchFar: newScratch(), solo,
      ids: [], built: [], builtHull: [], hulls: new Map(), radius: new Map(), dirty: false,
      damage, damageTex, damageDirty: false, flash, shipUniforms, detail,
    };
    this.container.addChild(lit.mesh);
    this.lighting.add(lit);
    this.chunks.push(chunk);
    return chunk;
  }

  /** A chunk gone: off the GPU (its geometries, damage texture and shader), out of the lighting */
  private destroyChunk(chunk: Chunk): void {
    const k = this.chunks.indexOf(chunk);
    if (k >= 0) this.chunks.splice(k, 1);
    if (this.chunks.length) this.next %= this.chunks.length; else this.next = 0;
    this.lighting.remove(chunk.lit);
    this.container.removeChild(chunk.lit.mesh);
    const shader = chunk.lit.mesh.shader;
    chunk.lit.destroy();
    shader?.destroy();
    chunk.lit.shader.destroy();
    chunk.geoFull.destroy(true);
    chunk.geoFar.destroy(true);
    chunk.damageTex.destroy(true);
  }

  private empty(chunk: Chunk): boolean {
    for (const id of chunk.ids) if (id >= 0) return false;
    return true;
  }

  /** Where a chunk's ships are, on the whole (null: none) */
  private middle(chunk: Chunk, except = -1): { x: number; y: number } | null {
    let x = 0, y = 0, n = 0;
    for (const id of chunk.ids) {
      if (id < 0 || id === except) continue;
      const p = this.pos.get(id);
      if (p) { x += p.x; y += p.y; n++; }
    }
    return n ? { x: x / n, y: y / n } : null;
  }

  /** The shared chunk with room whose ships are nearest (x, y); an empty one if none is near; a new one if all are full */
  private pick(x: number, y: number): Chunk {
    let best: Chunk | null = null, bestD = Infinity, empty: Chunk | null = null;
    for (const c of this.chunks) {
      if (c.solo) continue;
      const room = c.ids.length < PER_CHUNK || c.ids.includes(-1);
      if (!room) continue;
      const m = this.middle(c);
      if (!m) { empty ??= c; continue; }
      const d = Math.hypot(m.x - x, m.y - y);
      if (d < bestD) { bestD = d; best = c; }
    }
    if (best && bestD < REGROUP_FAR) return best;
    return empty ?? best ?? this.newChunk();
  }

  /** A ship given a slot: in a chunk of its own (`solo`), or the nearest shared one with room; whole, until told otherwise */
  private join(id: number, solo: boolean): Chunk {
    let chunk: Chunk;
    if (solo) chunk = this.chunks.find((c) => c.solo && this.empty(c)) ?? this.newChunk(true);
    else {
      const p = this.pos.get(id);
      chunk = p ? this.pick(p.x, p.y) : this.chunks.find((c) => !c.solo && (c.ids.length < PER_CHUNK || c.ids.includes(-1))) ?? this.newChunk();
    }
    const free = chunk.ids.indexOf(-1);
    if (free >= 0) chunk.ids[free] = id;
    else { chunk.ids.push(id); chunk.built.push(-1); chunk.builtHull.push(null); }
    this.where.set(id, chunk);
    const slot = chunk.ids.indexOf(id);
    chunk.damage.fill(255, slot * ROW, (slot + 1) * ROW);
    chunk.damageDirty = true;
    return chunk;
  }

  /** A ship moved to another chunk, its damage with it */
  private move(id: number, from: Chunk, solo: boolean): Chunk {
    const hull = from.hulls.get(id), r = from.radius.get(id);
    const slot = from.ids.indexOf(id), row = from.damage.slice(slot * ROW, (slot + 1) * ROW);
    this.remove(id, false);
    const to = this.join(id, solo);
    to.damage.set(row, to.ids.indexOf(id) * ROW);
    to.damageDirty = true;
    if (hull) { to.hulls.set(id, hull); to.radius.set(id, r ?? 0); to.dirty = true; }
    return to;
  }

  /** A ship's place this frame, on screen or not (for grouping it with its neighbours) */
  track(id: number, x: number, y: number): void {
    const p = this.pos.get(id);
    if (p) { p.x = x; p.y = y; } else this.pos.set(id, { x, y });
  }

  /** A ship's hull (new, or changed structure): `radius` is how far it reaches from its centre */
  set(id: number, hull: ShipHull, radius: number): void {
    if (this.parked) { this.parked = this.parked.filter((p) => p.id !== id); this.parked.push({ id, hull, radius, row: new Uint8Array(ROW).fill(255) }); return; }
    const verts = hull.full.vertexCount, solo = verts >= SOLO_VERTS;
    let chunk = this.where.get(id);
    // (a big hull that's lost much of itself goes back to sharing, a small one grown big gets its own: not back and forth)
    if (chunk && chunk.solo !== solo && !(chunk.solo && verts >= SOLO_VERTS / 2)) chunk = this.move(id, chunk, solo);
    chunk ??= this.join(id, solo);
    if (chunk.hulls.get(id) === hull) return;
    chunk.hulls.set(id, hull);
    chunk.radius.set(id, radius);
    chunk.dirty = true;
  }

  remove(id: number, forget = true): void {
    if (forget) this.pos.delete(id);
    if (this.parked) this.parked = this.parked.filter((p) => p.id !== id);
    const chunk = this.where.get(id);
    if (!chunk) return;
    this.where.delete(id);
    // Its slot is freed, not closed up (the others keep their places, and their geometry stays valid)
    chunk.ids[chunk.ids.indexOf(id)] = -1;
    chunk.hulls.delete(id);
    chunk.radius.delete(id);
    chunk.dirty = true;
  }

  /** Each frame, before placing: every ship hidden until placed */
  begin(): void {
    for (const c of this.chunks) c.lit.xform.fill(0);
  }

  /** Where a ship's hull is this frame, how faded in, and how brightly it flashes (a hit) */
  place(id: number, x: number, y: number, rotation: number, fade: number, flash = 0): void {
    const chunk = this.where.get(id);
    if (!chunk) return;
    const slot = chunk.ids.indexOf(id);
    // Not drawn until its chunk's geometry has it
    if (chunk.built[slot] !== id) return;
    const o = slot * 4, X = chunk.lit.xform;
    X[o] = x; X[o + 1] = y; X[o + 2] = Math.cos(rotation); X[o + 3] = Math.sin(rotation);
    chunk.lit.fade[slot] = fade;
    chunk.flash[slot] = flash;
  }

  /** A ship's parts' health (each 0..1; a detached part 0) and which stand (`alive`: green, 0 gone; a hull built whole
   * draws only those): written to its damage row, uploaded once a frame if it changed */
  setDamage(id: number, hp: readonly number[], maxHp: readonly number[], detached: readonly boolean[], alive?: readonly boolean[]): void {
    const chunk = this.where.get(id);
    if (!chunk) return;
    const row = chunk.ids.indexOf(id) * ROW, d = chunk.damage, n = Math.min(hp.length, SHIP_MAX_PARTS);
    for (let i = 0; i < n; i++) {
      const v = detached[i] ? 0 : Math.max(0, Math.min(255, Math.round((hp[i] / (maxHp[i] || 1)) * 255)));
      if (d[row + i * 4] !== v) { d[row + i * 4] = v; chunk.damageDirty = true; }
      const up = !alive || alive[i] ? 255 : 0;
      if (d[row + i * 4 + 1] !== up) { d[row + i * 4 + 1] = up; chunk.damageDirty = true; }
    }
  }

  /** Now and then: a few ships far from their chunk's middle move to a shared chunk nearer them (if there is one) */
  private regroup(): void {
    let moves = 0;
    for (const chunk of this.chunks) {
      if (chunk.solo) continue;
      for (const id of chunk.ids) {
        if (id < 0 || moves >= REGROUP_MOVES) continue;
        const p = this.pos.get(id), m = this.middle(chunk, id);
        if (!p || !m || Math.hypot(p.x - m.x, p.y - m.y) < REGROUP_FAR) continue;
        const to = this.pick(p.x, p.y);
        if (to === chunk) continue;
        this.move(id, chunk, false);
        moves++;
      }
    }
  }

  /** After placing: regroup now and then, rebuild changed chunks (a few a frame), upload changed damage, size each chunk's
   *  lighting circle, and pick close or far hulls by how big its ships are on screen (`zoom`) */
  end(zoom = 1): void {
    if (++this.frame % REGROUP_EVERY === 0) this.regroup();
    let rebuilds = 0;
    const n = this.chunks.length, emptied: Chunk[] = [];
    for (let k = 0; k < n && rebuilds < REBUILDS_PER_FRAME; k++) {
      const chunk = this.chunks[(this.next + k) % n];
      if (!chunk.dirty) continue;
      rebuilds++;
      chunk.dirty = false;
      const full: [ShipGeometry, number][] = [];
      chunk.ids.forEach((id, slot) => {
        const hull = id >= 0 ? chunk.hulls.get(id) : undefined;
        chunk.built[slot] = hull ? id : -1;
        chunk.builtHull[slot] = hull ?? null;
        if (hull) full.push([hull.full, slot]);
      });
      // (each hull packed once, then copied in whole: a boss's hundred thousand vertices cost a copy, not a rebuild;
      // and alone in its chunk, only when its own hull changes. The far version waits until it's drawn)
      this.stats.copied += mergeInto(chunk.geoFull, full, chunk.scratchFull);
      this.stats.rebuilds++;
      chunk.farDirty = true;
      if (!full.length && this.empty(chunk)) emptied.push(chunk);
    }
    if (n) this.next = (this.next + 1) % n;
    // An emptied chunk goes (one shared one kept spare)
    for (const c of emptied) if (c.solo || this.chunks.some((o) => o !== c && !o.solo && this.empty(o))) this.destroyChunk(c);
    const t = (performance.now() / 1000) % 1000;
    const atlas = hullAtlas();
    for (const chunk of this.chunks) {
      chunk.shipUniforms.uniforms.uTime = t;
      if (chunk.detail !== atlas) { chunk.detail = atlas; (chunk.lit.mesh.shader!.resources as Record<string, unknown>).uDetail = atlas.source; }
      if (chunk.damageDirty) { chunk.damageDirty = false; chunk.damageTex.source.update(); }
      const X = chunk.lit.xform, area = chunk.lit.area!;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, shown = 0, biggest = 0;
      for (let slot = 0; slot < chunk.ids.length; slot++) {
        const o = slot * 4, id = chunk.ids[slot];
        if (id < 0 || (X[o + 2] === 0 && X[o + 3] === 0)) continue;
        const r = chunk.radius.get(id) ?? 0;
        biggest = Math.max(biggest, r);
        x0 = Math.min(x0, X[o] - r); x1 = Math.max(x1, X[o] + r);
        y0 = Math.min(y0, X[o + 1] - r); y1 = Math.max(y1, X[o + 1] + r);
        shown++;
      }
      chunk.lit.mesh.visible = shown > 0;
      if (!shown) continue;
      const far = biggest * zoom < FAR_BELOW;
      if (far && chunk.farDirty) {
        // (from what the close-in geometry was built from, so the two agree slot for slot)
        chunk.farDirty = false;
        const hulls: [ShipGeometry, number][] = [];
        chunk.builtHull.forEach((h, slot) => { if (h) hulls.push([h.far, slot]); });
        this.stats.copied += mergeInto(chunk.geoFar, hulls, chunk.scratchFar);
        this.stats.farMerges++;
      }
      const geo = far ? chunk.geoFar : chunk.geoFull;
      if (chunk.lit.mesh.geometry !== geo) chunk.lit.mesh.geometry = geo;
      area.x = (x0 + x1) / 2; area.y = (y0 + y1) / 2; area.r = Math.hypot(x1 - x0, y1 - y0) / 2;
    }
  }

  /**
   * Its GPU geometry let go (the hangar closed): every chunk destroyed, its ships kept aside (hull, size, damage) until
   * restore() sets them again
   */
  release(): void {
    if (this.parked) return;
    const parked: NonNullable<ShipBatch['parked']> = [];
    for (const c of this.chunks) c.ids.forEach((id, slot) => {
      const hull = id >= 0 ? c.hulls.get(id) : undefined;
      if (hull) parked.push({ id, hull, radius: c.radius.get(id) ?? 0, row: c.damage.slice(slot * ROW, (slot + 1) * ROW) });
    });
    for (const c of [...this.chunks]) this.destroyChunk(c);
    this.where.clear();
    this.parked = parked;
  }

  /** Its ships set again after release() */
  restore(): void {
    const parked = this.parked;
    if (!parked) return;
    this.parked = null;
    for (const p of parked) {
      this.set(p.id, p.hull, p.radius);
      const c = this.where.get(p.id)!;
      c.damage.set(p.row, c.ids.indexOf(p.id) * ROW);
      c.damageDirty = true;
    }
  }

  /** All of it gone, for good */
  destroy(): void {
    for (const c of [...this.chunks]) this.destroyChunk(c);
    this.where.clear();
    this.pos.clear();
    this.parked = null;
    this.container.destroy();
  }
}
