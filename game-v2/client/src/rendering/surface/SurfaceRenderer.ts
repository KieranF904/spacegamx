/**
 * A planet's surface, in place of the sky while you're down on one: the
 * ground (drawn at half the screen's size: it's soft, and its many noise
 * lookups are the costly part) and a layer of clouds above the ships.
 *
 * Each kind of world has its own look, and some surfaces their own within
 * it (surfaceLooks.ts: palette and features; groundShader.ts draws them); the
 * seed moves the continents. In dev, `localStorage['sg.surfaceLook'] = 'classic'`
 * (or `__game.renderer.surface.setClassic(true)`) draws the ground as it was
 * before the art pass, to compare.
 *
 * The ground is drawn from a camera snapped to its texels (a few spare round
 * the edge), the picture slid back by what was snapped off, so it stays put
 * on its texels as you fly. A cavern's floor is drawn straight to the screen
 * instead, at full resolution from the exact camera: its cracks are fine lines,
 * and a half-size picture stretched over the screen at a slightly different
 * fraction of a pixel each frame (the camera never sits quite still) makes
 * them shimmer. The screen's shake goes into both shaders (the world shakes,
 * so the ground does with it).
 */

import { Application, Container, GlProgram, Mesh, MeshGeometry, RenderTexture, Shader, Sprite, State } from 'pixi.js';
import type { SurfaceData } from '@space-game/common';
import { skyNoiseTexture } from '../sky/noiseTexture';
import { cloudFrag, groundFragClassic, surfaceVert } from './surfaceShaders';
import { groundFrag } from './groundShader';
import { hexRgb, lookOf, lookUniforms } from './surfaceLooks';

const SCALE = 1 / 2;
/** Spare texels round the ground's picture (it slides by up to one, and a shake's roll swings its corners) */
const MARGIN = 3;

type Rgb = [number, number, number];

/** The way sunlight travels across the ground (from the top left) */
export const SUN_DIR: [number, number] = [0.6, 0.8];

function quad(x0: number, y0: number, x1: number, y1: number): MeshGeometry {
  return new MeshGeometry({
    positions: new Float32Array([x0, y0, x1, y0, x1, y1, x0, y1]),
    uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  });
}

const v2 = () => ({ value: new Float32Array(2), type: 'vec2<f32>' as const });
const v3 = () => ({ value: new Float32Array(3), type: 'vec3<f32>' as const });
const v4 = () => ({ value: new Float32Array(4), type: 'vec4<f32>' as const });
const f = (v = 0) => ({ value: v, type: 'f32' as const });
const common = () => ({ uCamera: v2(), uRes: v2(), uZoom: f(1), uTime: f(), uSeed: v2(), uSun: v2(), uCloud: v4(), uNight: f(), uShake: v3() });

export class SurfaceRenderer {
  /** Goes at the very back of the stage, in place of the sky */
  readonly ground = new Container();
  /** Goes above the world */
  readonly clouds: Mesh<MeshGeometry, Shader>;
  private rt: RenderTexture;
  private sprite: Sprite;
  private root = new Container();
  private mesh: Mesh<MeshGeometry, Shader>;
  /** The ground drawn straight to the screen (a cavern's floor: see above) */
  private direct: Mesh<MeshGeometry, Shader>;
  private full = false;
  private groundShader: Shader;
  /** The ground from before the art pass (dev only: setClassic) */
  private classicShader: Shader | null = null;
  private classic = false;
  private surfaceId: string | undefined;
  private cloudShader: Shader;
  private surface: SurfaceData | null = null;
  private time = 0;

  constructor(private app: Application) {
    const noise = skyNoiseTexture();
    this.groundShader = this.makeGround(groundFrag);
    if (import.meta.env.DEV) {
      this.classicShader = this.makeGround(groundFragClassic);
      try { this.classic = localStorage.getItem('sg.surfaceLook') === 'classic'; } catch { /* (no storage) */ }
    }
    this.cloudShader = new Shader({
      glProgram: new GlProgram({ vertex: surfaceVert, fragment: cloudFrag }),
      resources: { uNoise: noise.source, cloudUniforms: { ...common(), uFade: f(1), uTint: v3() } },
    });
    this.rt = RenderTexture.create({ width: 4, height: 4, resolution: 1, dynamic: true });
    this.mesh = new Mesh({ geometry: quad(0, 0, 4, 4), shader: this.groundShader, state: State.for2d() });
    this.root.addChild(this.mesh);
    this.sprite = new Sprite(this.rt);
    this.sprite.scale.set(1 / SCALE);
    this.ground.addChild(this.sprite);
    this.direct = new Mesh({ geometry: quad(-1, -1, 1, 1), shader: this.groundShader, state: State.for2d() });
    this.direct.visible = false;
    this.ground.addChild(this.direct);
    this.clouds = new Mesh({ geometry: quad(-1, -1, 1, 1), shader: this.cloudShader, state: State.for2d() });
    this.ground.visible = false;
    this.clouds.visible = false;
    this.resize();
  }

  private makeGround(fragment: string): Shader {
    return new Shader({
      glProgram: new GlProgram({ vertex: surfaceVert, fragment }),
      resources: {
        uNoise: skyNoiseTexture().source,
        groundUniforms: {
          ...common(), uLand: v4(), uCity: v2(), uCave: f(), uPx: f(2),
          uDeep: v3(), uShallow: v3(), uShore: v3(), uLow: v3(), uHigh: v3(), uRock: v3(), uPeak: v3(), uHaze: v3(), uUrban: v3(),
          uDry: v3(), uSoil: v3(), uSkylight: v3(), uSunlight: v3(), uFeat: v4(), uFeat2: v4(), uStyle: v4(),
        },
      },
    });
  }

  /** The shader the ground's drawn with now */
  private get ground_(): Shader {
    return this.classic && this.classicShader ? this.classicShader : this.groundShader;
  }

  /** Dev: draw the ground as it was before the art pass (to compare); remembered in localStorage */
  setClassic(on: boolean): void {
    if (!this.classicShader) return;
    this.classic = on;
    try { localStorage.setItem('sg.surfaceLook', on ? 'classic' : 'new'); } catch { /* (no storage) */ }
    this.mesh.shader = this.direct.shader = this.ground_;
    const s = this.surface;
    this.surface = null;
    this.setSurface(s, this.surfaceId);
  }

  /** How dark it is (0 day .. 1 night), eased towards what it's set to */
  night = 0;
  private nightTarget = 0;

  get active(): boolean {
    return !!this.surface;
  }

  setNight(k: number): void {
    this.nightTarget = Math.max(0, Math.min(1, k));
  }

  resize(): void {
    const { width, height } = this.app.screen;
    const w = Math.max(1, Math.ceil(width * SCALE)) + MARGIN * 2, h = Math.max(1, Math.ceil(height * SCALE)) + MARGIN * 2;
    this.rt.resize(w, h);
    this.mesh.geometry = quad(0, 0, w, h);
  }

  /** The surface you're on (null: you're in space), and its system's id (some surfaces have a look of their own) */
  setSurface(s: SurfaceData | null, id?: string): void {
    if (s === this.surface && id === this.surfaceId) return;
    this.surface = s;
    this.surfaceId = id;
    this.ground.visible = this.clouds.visible = !!s;
    this.night = this.nightTarget = 0;
    if (!s) return;
    // (underground: no sky, no clouds; the floor drawn straight to the screen)
    if (s.kind === 'cavern') this.clouds.visible = false;
    this.full = s.kind === 'cavern';
    this.direct.visible = this.full;
    this.sprite.visible = !this.full;
    const p = lookOf({ kind: s.kind, id }, this.classic);
    const seed = s.seed ?? 1;
    this.mesh.shader = this.direct.shader = this.ground_;
    const gu = (this.ground_.resources.groundUniforms as any).uniforms;
    const cu = (this.cloudShader.resources.cloudUniforms as any).uniforms;
    for (const u of [gu, cu]) {
      u.uSeed.set([(seed * 0.618) % 1, (seed * 0.382) % 1]);
      u.uSun.set(SUN_DIR);
      u.uCloud.set([p.cloud, 15000, 22, 0.3]);
    }
    const city = s.city;
    cu.uTint.set(hexRgb(p.cloudTint));
    gu.uLand.set([p.sea, p.snow, city ? city.radius : 0, s.radius]);
    gu.uCity.set(city ? [city.x, city.y] : [0, 0]);
    gu.uCave = s.kind === 'cavern' ? 1 : 0;
    for (const [k, v] of Object.entries(lookUniforms(p))) gu[k].set(v);
  }

  /**
   * The surface's ambient light level and haze colour, for the lighting, and
   * the light coming up off the ground (a lava world's glow; elsewhere a faint
   * bounce of the land's own colour; a cavern's cracks), and whether there's
   * a sun at all (not underground)
   */
  light(): { ambient: number; tint: Rgb; ground: Rgb; sun: boolean } | null {
    if (!this.surface) return null;
    const p = lookOf({ kind: this.surface.kind, id: this.surfaceId }, this.classic);
    if (this.surface.kind === 'cavern') return { ambient: 0.13, tint: hexRgb(p.haze), ground: hexRgb(p.deep).map((v) => v * 0.3) as Rgb, sun: false };
    const lava = this.surface.kind === 'lava';
    const ground = (lava ? hexRgb(p.deep).map((v) => v * 0.5) : hexRgb(p.low).map((v) => v * 0.22)) as Rgb;
    return { ambient: lava ? 0.36 : 0.6, tint: hexRgb(p.haze), ground, sun: true };
  }

  /** `shake`: the screen's shake this frame (x, y in pixels, its roll) */
  update(deltaMs: number, camX: number, camY: number, zoom: number, shake: { x: number; y: number; rot: number } = { x: 0, y: 0, rot: 0 }): void {
    if (!this.surface) return;
    this.time += deltaMs / 1000;
    this.night += (this.nightTarget - this.night) * Math.min(1, deltaMs / 900);
    const { width: w, height: h } = this.app.screen;
    const gu = (this.ground_.resources.groundUniforms as any).uniforms;
    const cu = (this.cloudShader.resources.cloudUniforms as any).uniforms;
    // The ground's camera snapped to its texels, its picture slid back by the difference (or, full size, just the camera)
    const texel = 1 / (SCALE * zoom), sx = this.full ? camX : Math.round(camX / texel) * texel, sy = this.full ? camY : Math.round(camY / texel) * texel;
    const rw = this.full ? w : this.rt.width / SCALE, rh = this.full ? h : this.rt.height / SCALE;
    if (this.full) {
      this.direct.scale.set(w / 2, h / 2);
      this.direct.position.set(w / 2, h / 2);
    } else {
      // (The snap is in world units: on screen it's turned with the view)
      const c = Math.cos(shake.rot), n = Math.sin(shake.rot), ox = (sx - camX) * zoom, oy = (sy - camY) * zoom;
      this.sprite.position.set(w / 2 - rw / 2 + c * ox - n * oy, h / 2 - rh / 2 + n * ox + c * oy);
    }
    gu.uPx = this.full ? 1 / zoom : texel;
    for (const u of [gu, cu]) {
      u.uZoom = zoom;
      u.uTime = this.time;
      u.uNight = this.night;
      u.uShake[0] = shake.x; u.uShake[1] = shake.y; u.uShake[2] = shake.rot;
    }
    gu.uCamera[0] = sx; gu.uCamera[1] = sy;
    gu.uRes[0] = rw; gu.uRes[1] = rh;
    cu.uCamera[0] = camX; cu.uCamera[1] = camY;
    cu.uRes[0] = w; cu.uRes[1] = h;
    // Down among the ships the clouds thin out (you're under them)
    cu.uFade = 1 - 0.78 * Math.max(0, Math.min(1, (zoom - 0.12) / 0.4));
    this.clouds.scale.set(w / 2, h / 2);
    this.clouds.position.set(w / 2, h / 2);
    if (!this.full) this.app.renderer.render({ container: this.root, target: this.rt, clear: false });
  }
}
