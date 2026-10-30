/**
 * A planet's surface, in place of the sky while you're down on one: the
 * ground (drawn at half the screen's size: it's soft, and its many noise
 * lookups are the costly part) and a layer of clouds above the ships.
 *
 * Each kind of world has its own palette (terran seas and forests, desert
 * dunes, ice, lava, toxic swamps, bare rock); the seed moves the continents.
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
import { cloudFrag, groundFrag, surfaceVert } from './surfaceShaders';

const SCALE = 1 / 2;
/** Spare texels round the ground's picture (it slides by up to one, and a shake's roll swings its corners) */
const MARGIN = 3;

type Rgb = [number, number, number];
const hex = (h: number): Rgb => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];

interface Palette {
  sea: number; snow: number; cloud: number;
  deep: number; shallow: number; shore: number; low: number; high: number; rock: number; peak: number; haze: number; urban: number;
}

const PALETTES: Record<SurfaceData['kind'], Palette> = {
  terran: { sea: 0.47, snow: 0.8, cloud: 0.36, deep: 0x0d2c4f, shallow: 0x1f6a8f, shore: 0xcdbb8b, low: 0x5b8a3e, high: 0x2e5a2b, rock: 0x75705f, peak: 0xeef3f6, haze: 0xb9d3ea, urban: 0x8d939b },
  rocky: { sea: 0.0, snow: 0.9, cloud: 0.05, deep: 0x3a3631, shallow: 0x4a453e, shore: 0x8a8174, low: 0x8a8174, high: 0x6d665c, rock: 0x5a544c, peak: 0xb8b2a6, haze: 0xc8c2b8, urban: 0x7d8086 },
  desert: { sea: 0.0, snow: 0.95, cloud: 0.1, deep: 0x7a5a3a, shallow: 0x8a6a48, shore: 0xd8b07a, low: 0xc99a62, high: 0xb07a48, rock: 0x8a5a3a, peak: 0xe3c08f, haze: 0xe6c9a4, urban: 0x9a8f80 },
  ice: { sea: 0.36, snow: 0.55, cloud: 0.35, deep: 0x1f3f63, shallow: 0x3f78a0, shore: 0xcfe0ee, low: 0xdfe9f2, high: 0xb9cfe2, rock: 0x8aa0b6, peak: 0xffffff, haze: 0xe8f2fb, urban: 0x9aa4ae },
  lava: { sea: 0.42, snow: 0.95, cloud: 0.3, deep: 0xff4a12, shallow: 0xffa040, shore: 0x2a201d, low: 0x3a2f2c, high: 0x2d2422, rock: 0x241c1a, peak: 0x4a3a34, haze: 0x5a2a1a, urban: 0x5a5658 },
  cavern: { sea: 0.0, snow: 1.0, cloud: 0.0, deep: 0xff5a14, shallow: 0xffa040, shore: 0x1a1416, low: 0x1c1517, high: 0x1c1517, rock: 0x1c1517, peak: 0x1c1517, haze: 0x5a2416, urban: 0x1c1517 },
  toxic: { sea: 0.45, snow: 0.95, cloud: 0.6, deep: 0x2d4a14, shallow: 0x7fae2c, shore: 0x8a8a4a, low: 0x6b6a3a, high: 0x4f5a2a, rock: 0x5a5440, peak: 0xa8a87a, haze: 0xb8c27a, urban: 0x7c8270 },
};

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
  private cloudShader: Shader;
  private surface: SurfaceData | null = null;
  private time = 0;

  constructor(private app: Application) {
    const noise = skyNoiseTexture();
    this.groundShader = new Shader({
      glProgram: new GlProgram({ vertex: surfaceVert, fragment: groundFrag }),
      resources: {
        uNoise: noise.source,
        groundUniforms: {
          ...common(), uLand: v4(), uCity: v2(), uCave: f(), uPx: f(2),
          uDeep: v3(), uShallow: v3(), uShore: v3(), uLow: v3(), uHigh: v3(), uRock: v3(), uPeak: v3(), uHaze: v3(), uUrban: v3(),
        },
      },
    });
    this.cloudShader = new Shader({
      glProgram: new GlProgram({ vertex: surfaceVert, fragment: cloudFrag }),
      resources: { uNoise: noise.source, cloudUniforms: { ...common(), uFade: f(1) } },
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

  /** The surface you're on (null: you're in space) */
  setSurface(s: SurfaceData | null): void {
    if (s === this.surface) return;
    this.surface = s;
    this.ground.visible = this.clouds.visible = !!s;
    this.night = this.nightTarget = 0;
    if (!s) return;
    // (underground: no sky, no clouds; the floor drawn straight to the screen)
    if (s.kind === 'cavern') this.clouds.visible = false;
    this.full = s.kind === 'cavern';
    this.direct.visible = this.full;
    this.sprite.visible = !this.full;
    const p = PALETTES[s.kind] ?? PALETTES.rocky;
    const seed = s.seed ?? 1;
    const gu = (this.groundShader.resources.groundUniforms as any).uniforms;
    const cu = (this.cloudShader.resources.cloudUniforms as any).uniforms;
    for (const u of [gu, cu]) {
      u.uSeed.set([(seed * 0.618) % 1, (seed * 0.382) % 1]);
      u.uSun.set(SUN_DIR);
      u.uCloud.set([p.cloud, 15000, 22, 0.3]);
    }
    const city = s.city;
    gu.uLand.set([p.sea, p.snow, city ? city.radius : 0, s.radius]);
    gu.uCity.set(city ? [city.x, city.y] : [0, 0]);
    gu.uCave = s.kind === 'cavern' ? 1 : 0;
    gu.uDeep.set(hex(p.deep)); gu.uShallow.set(hex(p.shallow)); gu.uShore.set(hex(p.shore)); gu.uLow.set(hex(p.low));
    gu.uHigh.set(hex(p.high)); gu.uRock.set(hex(p.rock)); gu.uPeak.set(hex(p.peak)); gu.uHaze.set(hex(p.haze)); gu.uUrban.set(hex(p.urban));
  }

  /**
   * The surface's ambient light level and haze colour, for the lighting, and
   * the light coming up off the ground (a lava world's glow; elsewhere a faint
   * bounce of the land's own colour; a cavern's cracks), and whether there's
   * a sun at all (not underground)
   */
  light(): { ambient: number; tint: Rgb; ground: Rgb; sun: boolean } | null {
    if (!this.surface) return null;
    const p = PALETTES[this.surface.kind] ?? PALETTES.rocky;
    if (this.surface.kind === 'cavern') return { ambient: 0.13, tint: hex(p.haze), ground: hex(p.deep).map((v) => v * 0.3) as Rgb, sun: false };
    const lava = this.surface.kind === 'lava';
    const ground = (lava ? hex(p.deep).map((v) => v * 0.5) : hex(p.low).map((v) => v * 0.22)) as Rgb;
    return { ambient: lava ? 0.36 : 0.6, tint: hex(p.haze), ground, sun: true };
  }

  /** `shake`: the screen's shake this frame (x, y in pixels, its roll) */
  update(deltaMs: number, camX: number, camY: number, zoom: number, shake: { x: number; y: number; rot: number } = { x: 0, y: 0, rot: 0 }): void {
    if (!this.surface) return;
    this.time += deltaMs / 1000;
    this.night += (this.nightTarget - this.night) * Math.min(1, deltaMs / 900);
    const { width: w, height: h } = this.app.screen;
    const gu = (this.groundShader.resources.groundUniforms as any).uniforms;
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
