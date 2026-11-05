/**
 * Lighting for the world's solid things: ships, stations, asteroids.
 *
 * Each frame the light sources (weapons, explosions, engines, headlights,
 * stations, loot, rifts) add their lights; small lights close together are
 * merged; then every lit mesh is handed the strongest few that reach it, plus
 * the system's ambient light and its sun. The lit shader (litShader.ts) does
 * the rest per vertex on the GPU, so a frame's CPU work is choosing lights,
 * not shading anything.
 *
 * Off (the Display setting), everything shows its plain colours, as before.
 */

import { Container, Geometry, GlProgram, Matrix, Mesh, Shader, State } from 'pixi.js';
import { fades, litProgram, MAX_LIGHTS, MAX_SHADES } from './litShader';

export type Rgb = [number, number, number];

interface Light { x: number; y: number; radius: number; height: number; r: number; g: number; b: number; power: number; dx: number; dy: number; cosOuter: number; cosInner: number }
/** A ship's shadow: a soft disc where it falls (cast away from the sun), and how dark at its middle */
interface Shade { x: number; y: number; r: number; depth: number }

/** How dark a ship's shadow is at its middle (of the sun's light) */
const SHADE_DEPTH = 0.7;

/** Lights closer than this are merged into one (world units) */
const MERGE_CELL = 200;
const ALL_ROUND = -2;


/** A mesh lit by the lighting (see LitGeometry for building one) */
export class LitMesh {
  readonly mesh: Mesh<Geometry, Shader>;
  readonly shader: Shader;
  /** Each held object's place in the world: x, y, cos·scale, sin·scale */
  readonly xform: Float32Array;
  /** Each held object's opacity (1 by default) */
  readonly fade: Float32Array;
  /**
   * Chunks (several objects, placed by the shader) take lights from the whole
   * screen; a single attached object takes them from round itself, `radius` across.
   */
  readonly chunk: boolean;
  radius = 0;
  /** A chunk whose objects keep together: lights are picked for this circle rather than the whole screen */
  area: { x: number; y: number; r: number } | null = null;

  /** `program`: a shader of its own in place of the lit shader (taking the same lighting uniforms), with `resources` of its own beside them */
  constructor(geometry: Geometry, opts: { slots?: number; chunk?: boolean; program?: GlProgram; resources?: Record<string, any> } = {}) {
    // At least two: Pixi caches a uniform group's upload code by names and types, not array sizes, so a
    // one-slot uXform (uploaded as a single vec4) would make every mesh upload only its first slot
    const slots = Math.max(2, opts.slots ?? 1);
    this.chunk = !!opts.chunk;
    this.xform = new Float32Array(slots * 4);
    this.xform[2] = 1;
    this.fade = new Float32Array(fades(slots) * 4).fill(1);
    this.shader = new Shader({
      glProgram: opts.program ?? litProgram(slots),
      resources: {
        ...opts.resources,
        litUniforms: {
          uXform: { value: this.xform, type: 'vec4<f32>', size: slots },
          uFade: { value: this.fade, type: 'vec4<f32>', size: fades(slots) },
          uPlace: { value: this.chunk ? 1 : 0, type: 'f32' },
          uAmbient: { value: new Float32Array([1, 1, 1]), type: 'vec3<f32>' },
          uSun: { value: new Float32Array([0, 0, 1, 0]), type: 'vec4<f32>' },
          uSunColor: { value: new Float32Array(3), type: 'vec3<f32>' },
          uSunElev: { value: new Float32Array([1, 0]), type: 'vec2<f32>' },
          uGround: { value: new Float32Array(3), type: 'vec3<f32>' },
          uCount: { value: 0, type: 'f32' },
          uLightPos: { value: new Float32Array(MAX_LIGHTS * 4), type: 'vec4<f32>', size: MAX_LIGHTS },
          uLightCol: { value: new Float32Array(MAX_LIGHTS * 4), type: 'vec4<f32>', size: MAX_LIGHTS },
          uLightCone: { value: new Float32Array(MAX_LIGHTS * 4), type: 'vec4<f32>', size: MAX_LIGHTS },
          uShade: { value: new Float32Array(MAX_SHADES * 4), type: 'vec4<f32>', size: MAX_SHADES },
          uShadeCount: { value: 0, type: 'f32' },
        },
      },
    });
    this.mesh = new Mesh<Geometry, Shader>({ geometry, shader: this.shader, state: State.for2d() });
  }

  get uniforms(): any {
    return (this.shader.resources.litUniforms as any).uniforms;
  }

  destroy(): void {
    this.mesh.destroy({ children: true });
  }
}

export class Lighting {
  enabled = true;
  ambient: Rgb = [1, 1, 1];
  sun = { x: 0, y: 0, falloff: 40000, power: 0, color: [1, 1, 1] as Rgb, elevation: 0.7 };
  /** Light coming up off the ground (a planet's surface: a lava world's glow); none in space */
  ground: Rgb = [0, 0, 0];
  private sources: ((L: Lighting) => void)[] = [];
  private meshes = new Set<LitMesh>();
  private pool: Light[] = [];
  private used = 0;
  private merged: Light[] = [];
  private cells = new Map<number, Light>();
  private m = new Matrix();
  private chain: Container[] = [];
  private pick: Light[] = [];
  private shades: Shade[] = [];
  private shadeCount = 0;
  private shadePick: Shade[] = [];

  constructor(private worldRoot: Container) {}

  addSource(fn: (L: Lighting) => void): void {
    this.sources.push(fn);
  }

  removeSource(fn: (L: Lighting) => void): void {
    this.sources = this.sources.filter((s) => s !== fn);
  }

  add(m: LitMesh): void { this.meshes.add(m); }
  remove(m: LitMesh): void { this.meshes.delete(m); }

  private light(): Light {
    let l = this.pool[this.used];
    if (!l) { l = { x: 0, y: 0, radius: 0, height: 0, r: 0, g: 0, b: 0, power: 0, dx: 0, dy: 0, cosOuter: ALL_ROUND, cosInner: ALL_ROUND }; this.pool.push(l); }
    this.used++;
    return l;
  }

  /** A light shining all round, `height` above the playing field (defaults to a third of its reach) */
  point(x: number, y: number, color: number, radius: number, power: number, height = radius * 0.3): void {
    if (power <= 0.01 || radius <= 1) return;
    const l = this.light();
    // (Fields written straight onto the pooled light: no array or object per light per frame)
    l.x = x; l.y = y; l.radius = radius; l.height = height;
    l.r = ((color >> 16) & 255) / 255; l.g = ((color >> 8) & 255) / 255; l.b = (color & 255) / 255;
    l.power = power; l.cosOuter = ALL_ROUND; l.cosInner = ALL_ROUND;
  }

  /** A beam from (x, y) along (dx, dy), `spread` its half-angle */
  cone(x: number, y: number, dx: number, dy: number, color: number, radius: number, power: number, spread: number, height = 40): void {
    if (power <= 0.01) return;
    const l = this.light();
    l.x = x; l.y = y; l.radius = radius; l.height = height;
    l.r = ((color >> 16) & 255) / 255; l.g = ((color >> 8) & 255) / 255; l.b = (color & 255) / 255;
    l.power = power; l.dx = dx; l.dy = dy; l.cosOuter = Math.cos(spread); l.cosInner = Math.cos(spread * 0.55);
  }

  /**
   * A ship `r` across at (x, y) casts a soft shadow on the structures under it
   * (stations, stillstones, nests), away from the sun: the higher the sun, the
   * nearer below it. Only the sun's light is shaded; lamps and glows aren't.
   */
  shadow(x: number, y: number, r: number): void {
    const s = this.sun;
    if (s.power <= 0.01 || r <= 1) return;
    let d = this.shades[this.shadeCount];
    if (!d) { d = { x: 0, y: 0, r: 0, depth: 0 }; this.shades.push(d); }
    this.shadeCount++;
    const dx = x - s.x, dy = y - s.y, dl = Math.hypot(dx, dy) || 1;
    const off = (r * 0.35 + 15) * Math.min(1.6, 1 / Math.tan(Math.max(0.2, s.elevation)));
    d.x = x + (dx / dl) * off; d.y = y + (dy / dl) * off;
    d.r = r * 1.1 + 12;
    d.depth = SHADE_DEPTH;
  }

  /**
   * Once a frame, after everything has moved: gather the lights, then give
   * each lit mesh its share. `view` is the screen as a circle in the world.
   */
  frame(view: { x: number; y: number; r: number }): void {
    this.used = 0;
    this.shadeCount = 0;
    if (this.enabled) for (const s of this.sources) s(this);
    this.merge();
    for (const lm of this.meshes) {
      if (!this.shown(lm.mesh)) continue;
      let cx = view.x, cy = view.y, cr = view.r;
      if (!lm.chunk) {
        const t = this.toWorld(lm.mesh);
        lm.xform[0] = t.tx; lm.xform[1] = t.ty; lm.xform[2] = t.a; lm.xform[3] = t.b;
        cx = t.tx; cy = t.ty; cr = lm.radius * Math.hypot(t.a, t.b);
      } else if (lm.area) {
        cx = lm.area.x; cy = lm.area.y; cr = lm.area.r;
      }
      this.fill(lm, cx, cy, cr);
      this.fillShades(lm, cx, cy, cr);
    }
  }

  /** How bright it is here from the ambient and the sun alone (0 dark … ~1 full day) */
  envAt(x: number, y: number): number {
    const s = this.sun;
    const d2 = (s.x - x) ** 2 + (s.y - y) ** 2;
    const k = (s.power / (1 + d2 / (s.falloff * s.falloff))) * Math.sin(s.elevation);
    return (this.ambient[0] + this.ambient[1] + this.ambient[2]) / 3 + k * (s.color[0] + s.color[1] + s.color[2]) / 3;
  }

  /** Light falling on an up-facing point (for things tinted rather than lit per vertex), 0..1.6 per channel */
  levelAt(x: number, y: number, out: Rgb = [0, 0, 0]): Rgb {
    if (!this.enabled) { out[0] = out[1] = out[2] = 1; return out; }
    const am = this.ambient, s = this.sun;
    const sx = s.x - x, sy = s.y - y;
    const k = (s.power / (1 + (sx * sx + sy * sy) / (s.falloff * s.falloff))) * Math.sin(s.elevation);
    let r = am[0] + s.color[0] * k, g = am[1] + s.color[1] * k, b = am[2] + s.color[2] * k;
    const merged = this.merged;
    for (let i = 0; i < merged.length; i++) {
      const l = merged[i];
      // (Out of reach on the square first: most lights are, and a square root per light per ship adds up)
      const lx = x - l.x, ly = y - l.y, d2 = lx * lx + ly * ly;
      if (d2 >= l.radius * l.radius) continue;
      const dd = Math.sqrt(d2);
      let a = 1 - dd / l.radius;
      a *= a * l.power * (l.height / Math.sqrt(d2 + l.height * l.height));
      if (l.cosOuter > -1.5 && dd > 1) {
        const c = (lx * l.dx + ly * l.dy) / dd;
        const t = Math.max(0, Math.min(1, (c - l.cosOuter) / (l.cosInner - l.cosOuter)));
        a *= t * t * (3 - 2 * t);
      }
      r += l.r * a; g += l.g * a; b += l.b * a;
    }
    out[0] = Math.min(1.6, r); out[1] = Math.min(1.6, g); out[2] = Math.min(1.6, b);
    return out;
  }

  // ---------------------------------------------------------------------------

  /** Close lights become one (a burst of tracers lights things as one glow, and costs one slot) */
  private merge(): void {
    this.cells.clear();
    this.merged.length = 0;
    for (let i = 0; i < this.used; i++) {
      const l = this.pool[i];
      if (l.cosOuter > -1.5) { this.merged.push(l); continue; }
      const key = Math.floor(l.x / MERGE_CELL) * 92837111 + Math.floor(l.y / MERGE_CELL);
      const m = this.cells.get(key);
      if (!m) { this.cells.set(key, l); this.merged.push(l); continue; }
      const p = m.power + l.power, wl = l.power / p, wm = m.power / p;
      m.x = m.x * wm + l.x * wl; m.y = m.y * wm + l.y * wl;
      m.r = m.r * wm + l.r * wl; m.g = m.g * wm + l.g * wl; m.b = m.b * wm + l.b * wl;
      m.height = m.height * wm + l.height * wl;
      m.radius = Math.max(m.radius, l.radius);
      m.power = Math.min(3, p);
    }
  }

  private fill(lm: LitMesh, cx: number, cy: number, cr: number): void {
    const u = lm.uniforms;
    const on = this.enabled;
    u.uAmbient[0] = on ? this.ambient[0] : 1; u.uAmbient[1] = on ? this.ambient[1] : 1; u.uAmbient[2] = on ? this.ambient[2] : 1;
    const s = this.sun;
    u.uSun[0] = s.x; u.uSun[1] = s.y; u.uSun[2] = s.falloff; u.uSun[3] = on ? s.power : 0;
    u.uSunColor[0] = s.color[0]; u.uSunColor[1] = s.color[1]; u.uSunColor[2] = s.color[2];
    u.uSunElev[0] = Math.cos(s.elevation); u.uSunElev[1] = Math.sin(s.elevation);
    u.uGround[0] = on ? this.ground[0] : 0; u.uGround[1] = on ? this.ground[1] : 0; u.uGround[2] = on ? this.ground[2] : 0;
    // The strongest lights that reach it
    const pick = this.pick;
    pick.length = 0;
    for (const l of this.merged) {
      const dx = l.x - cx, dy = l.y - cy, reach = l.radius + cr;
      if (dx * dx + dy * dy < reach * reach) pick.push(l);
    }
    if (pick.length > MAX_LIGHTS) pick.sort((a, b) => b.power * b.radius - a.power * a.radius);
    const n = Math.min(MAX_LIGHTS, pick.length);
    for (let i = 0; i < n; i++) {
      const l = pick[i], o = i * 4;
      u.uLightPos[o] = l.x; u.uLightPos[o + 1] = l.y; u.uLightPos[o + 2] = l.radius; u.uLightPos[o + 3] = l.height;
      u.uLightCol[o] = l.r; u.uLightCol[o + 1] = l.g; u.uLightCol[o + 2] = l.b; u.uLightCol[o + 3] = l.power;
      u.uLightCone[o] = l.dx; u.uLightCone[o + 1] = l.dy; u.uLightCone[o + 2] = l.cosOuter; u.uLightCone[o + 3] = l.cosInner;
    }
    u.uCount = n;
  }

  /** The ships' shadows falling on a single object (chunks take none), placed from where it is */
  private fillShades(lm: LitMesh, cx: number, cy: number, cr: number): void {
    const u = lm.uniforms, pick = this.shadePick;
    pick.length = 0;
    if (!lm.chunk) for (let i = 0; i < this.shadeCount; i++) {
      const d = this.shades[i], dx = d.x - cx, dy = d.y - cy, reach = d.r + cr;
      if (dx * dx + dy * dy < reach * reach) pick.push(d);
    }
    if (pick.length > MAX_SHADES) pick.sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - a.r - (Math.hypot(b.x - cx, b.y - cy) - b.r));
    const n = Math.min(MAX_SHADES, pick.length);
    for (let i = 0; i < n; i++) {
      const d = pick[i], o = i * 4;
      u.uShade[o] = d.x - cx; u.uShade[o + 1] = d.y - cy; u.uShade[o + 2] = d.r; u.uShade[o + 3] = d.depth;
    }
    u.uShadeCount = n;
  }

  /** Shown: it and every ancestor up to the world visible */
  private shown(c: Container): boolean {
    for (let n: Container | null = c; n; n = n.parent) {
      if (!n.visible) return false;
      if (n === this.worldRoot) return true;
    }
    return false;
  }

  /** Where a display object is in world coordinates (the world container's own space) */
  private toWorld(c: Container): Matrix {
    const chain = this.chain;
    chain.length = 0;
    for (let n: Container | null = c; n && n !== this.worldRoot; n = n.parent) chain.push(n);
    const m = this.m.identity();
    for (let i = chain.length - 1; i >= 0; i--) {
      chain[i].updateLocalTransform();
      m.append(chain[i].localTransform);
    }
    return m;
  }
}
