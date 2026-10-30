/**
 * The sky behind everything: a system's biome (skyBiome.ts) drawn as
 *   - haze: band, nebulae, dust, filaments, into a texture half the
 *     screen's size (it's all soft, so that's indistinguishable) and stretched
 *     over the screen: a quarter of the pixels of the old full-screen pass
 *   - stars: six layers at real depths, plus distant galaxies, clusters and
 *     drifting dust, added over the haze at full resolution
 *
 * Depth: a layer D behind the playing field shows at scale 1 / (1/zoom + D),
 * so near stars slide past and grow as you zoom in while the far sky barely
 * moves; zoom out and the near layers thin out and fade, leaving the deep sky.
 * Each layer keeps about the same number of stars on screen at any zoom (it
 * shows a share of its cells that grows with the cells' size on screen).
 */

import { Application, Container, GlProgram, Mesh, MeshGeometry, RenderTexture, Shader, Sprite, State } from 'pixi.js';
import { skyVert, hazeFrag, starsFrag } from './skyShaders';
import { skyNoiseTexture } from './noiseTexture';
import type { SkyBiome } from './skyBiome';

/** Haze texture size, as a fraction of the screen's (CSS pixels); the quality setting can shrink it */
const HAZE_SCALE = 1 / 2;
/** Depth of the sky (haze, galaxies, the farthest stars) */
const SKY_DEPTH = 80;
/** Star layers, near to far: depth, and their stars' spacing on screen at zoom 1 (px) */
const LAYERS = [
  { depth: 2, px: 240 },
  { depth: 4.5, px: 140 },
  { depth: 10, px: 82 },
  { depth: 22, px: 46 },
  { depth: 45, px: 26 },
  { depth: SKY_DEPTH, px: 15 },
];
const MOTE_DEPTH = 0.3;
/** Sky units per noise tile */
const SKY_TILE = 320000;

const scaleAt = (zoom: number, depth: number) => 1 / (1 / zoom + depth);
const smooth = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

function quad(x0: number, y0: number, x1: number, y1: number): MeshGeometry {
  return new MeshGeometry({
    positions: new Float32Array([x0, y0, x1, y0, x1, y1, x0, y1]),
    uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  });
}

const vec3 = () => ({ value: new Float32Array(3), type: 'vec3<f32>' as const });
const vec4 = () => ({ value: new Float32Array(4), type: 'vec4<f32>' as const });
const vec2 = () => ({ value: new Float32Array(2), type: 'vec2<f32>' as const });
const f32 = (v = 0) => ({ value: v, type: 'f32' as const });

/** Uniforms both shaders share */
function fieldUniforms() {
  return { uCamera: vec2(), uRes: vec2(), uSky: vec4(), uBand: vec4(), uField: vec4(), uLens: vec4(), uRot: vec2() };
}

let programs: [GlProgram, GlProgram] | null = null;
/** The haze's program and the stars' (one each for every sky), for compiling ahead too */
export function skyPrograms(): [GlProgram, GlProgram] {
  return (programs ??= [new GlProgram({ vertex: skyVert, fragment: hazeFrag, name: 'sky-haze' }), new GlProgram({ vertex: skyVert, fragment: starsFrag, name: 'sky-stars' })]);
}

export class SkyRenderer {
  /** Goes at the very back of the stage */
  readonly container = new Container();
  private hazeRT: RenderTexture;
  private hazeSprite: Sprite;
  private hazeRoot = new Container();
  private hazeMesh: Mesh<MeshGeometry, Shader>;
  private hazeShader: Shader;
  private starShader: Shader;
  private starMesh: Mesh<MeshGeometry, Shader>;
  private biome: SkyBiome | null = null;
  private time = 0;
  private lastCam: { x: number; y: number } | null = null;
  private streak = { x: 0, y: 0 };
  private hazeScale = HAZE_SCALE;
  /** Star layers drawn (a layer left out costs the shader nothing: it returns at once) */
  private layerOn: readonly boolean[] = [true, true, true, true, true, true];

  constructor(private app: Application) {
    const noise = skyNoiseTexture();
    this.hazeShader = new Shader({
      glProgram: skyPrograms()[0],
      resources: {
        uNoise: noise.source,
        hazeUniforms: {
          ...fieldUniforms(),
          uBase: vec3(), uBandCore: vec3(), uBandEdge: vec3(), uBandStrength: f32(),
          uDustTint: vec3(), uNebA: vec3(), uNebB: vec3(), uNebStrength: f32(),
          uFilColor: vec3(), uFilStrength: f32(), uShell: vec4(), uShellColor: vec3(),
        },
      },
    });
    this.starShader = new Shader({
      glProgram: skyPrograms()[1],
      resources: {
        uNoise: noise.source,
        starUniforms: {
          ...fieldUniforms(), uTime: f32(),
          uL0: vec4(), uL1: vec4(), uL2: vec4(), uL3: vec4(), uL4: vec4(), uL5: vec4(),
          uMotes: vec4(), uDeep: vec4(), uStarMix: vec4(), uTint: vec3(), uSpike: vec2(), uStreak: vec2(), uMoteColor: vec3(),
        },
      },
    });
    this.hazeRT = RenderTexture.create({ width: 4, height: 4, resolution: 1, dynamic: true });
    this.hazeMesh = new Mesh({ geometry: quad(0, 0, 4, 4), shader: this.hazeShader, state: State.for2d() });
    this.hazeRoot.addChild(this.hazeMesh);
    this.hazeSprite = new Sprite(this.hazeRT);
    this.hazeSprite.scale.set(1 / this.hazeScale);
    this.starMesh = new Mesh({ geometry: quad(-1, -1, 1, 1), shader: this.starShader, state: State.for2d() });
    this.starMesh.blendMode = 'add';
    this.container.addChild(this.hazeSprite, this.starMesh);
    this.resize();
  }

  resize(): void {
    const { width, height } = this.app.screen;
    const w = Math.max(1, Math.ceil(width * this.hazeScale)), h = Math.max(1, Math.ceil(height * this.hazeScale));
    this.hazeRT.resize(w, h);
    this.hazeMesh.geometry = quad(0, 0, w, h);
    this.hazeAt = null;
  }

  /** Quality: the haze texture's size and which star layers are drawn */
  setDetail(hazeScale: number, layers: readonly boolean[]): void {
    this.layerOn = layers;
    if (hazeScale === this.hazeScale) return;
    this.hazeScale = hazeScale;
    this.hazeSprite.scale.set(1 / hazeScale);
    this.resize();
  }

  /** Where the haze was last drawn from (it doesn't change with time: it's redrawn only when the view moves it) */
  private hazeAt: { x: number; y: number; zoom: number; lens: number; angle: number } | null = null;
  /** The diffraction spikes' angle on screen (they're the camera's, so they turn with the view's roll) */
  private spikeAngle = 0;

  setBiome(b: SkyBiome): void {
    if (b === this.biome) return;
    this.hazeAt = null;
    this.biome = b;
    const hu = (this.hazeShader.resources.hazeUniforms as any).uniforms;
    const su = (this.starShader.resources.starUniforms as any).uniforms;
    for (const u of [hu, su]) {
      u.uSky[1] = SKY_TILE; u.uSky[2] = b.seed[0]; u.uSky[3] = b.seed[1];
      u.uBand[0] = -Math.sin(b.band.angle); u.uBand[1] = Math.cos(b.band.angle); u.uBand[2] = b.band.offset; u.uBand[3] = b.band.width;
      u.uField[0] = b.dust.strength; u.uField[1] = b.nebula.cover;
    }
    hu.uBase.set(b.base); hu.uBandCore.set(b.band.core); hu.uBandEdge.set(b.band.edge); hu.uBandStrength = b.band.strength;
    hu.uDustTint.set(b.dust.tint); hu.uNebA.set(b.nebula.a); hu.uNebB.set(b.nebula.b); hu.uNebStrength = b.nebula.strength;
    hu.uFilColor.set(b.filaments.color); hu.uFilStrength = b.filaments.strength;
    hu.uShell.set([b.shell.x, b.shell.y, b.shell.radius, b.shell.strength]); hu.uShellColor.set(b.shell.color);
    su.uStarMix.set([b.stars.temperature, b.stars.brightness, b.stars.bandBoost, b.stars.spikes]);
    su.uTint.set(b.stars.tint);
    su.uMoteColor.set(b.moteColor);
    this.spikeAngle = b.stars.spikeAngle;
  }

  /** A black hole at the system's centre bends the sky around it (radius: its horizon; 0 for none) */
  private lensRadius = 0;
  setLens(horizon: number): void {
    if (horizon !== this.lensRadius) this.hazeAt = null;
    this.lensRadius = horizon;
  }

  /** Once a frame: follow the camera (`angle` its roll), then draw the haze into its texture */
  update(deltaMs: number, camX: number, camY: number, zoom: number, angle = 0): void {
    const b = this.biome;
    this.container.visible = !!b;
    if (!b) return;
    const { width: w, height: h } = this.app.screen;
    this.time += deltaMs / 1000;

    // Camera travel this frame (per 60th of a second), smoothed; a jump across the map isn't travel
    if (this.lastCam && deltaMs > 0) {
      const k = (1000 / 60) / deltaMs;
      let vx = (camX - this.lastCam.x) * k, vy = (camY - this.lastCam.y) * k;
      if (Math.hypot(vx, vy) > 4000) vx = vy = 0;
      this.streak.x += (vx - this.streak.x) * 0.35;
      this.streak.y += (vy - this.streak.y) * 0.35;
      // Slower than any layer could smear (the nearest is a third of the world's scale): none at all, so the shader skips it
      if (Math.hypot(this.streak.x, this.streak.y) * scaleAt(zoom, LAYERS[0].depth) < 2.5) this.streak.x = this.streak.y = 0;
    }
    this.lastCam = { x: camX, y: camY };

    const zSky = scaleAt(zoom, SKY_DEPTH);
    for (const u of [(this.hazeShader.resources.hazeUniforms as any).uniforms, (this.starShader.resources.starUniforms as any).uniforms]) {
      u.uCamera[0] = camX; u.uCamera[1] = camY;
      u.uRot[0] = Math.cos(angle); u.uRot[1] = Math.sin(angle);
      u.uRes[0] = w; u.uRes[1] = h;
      u.uSky[0] = zSky;
      // The hole sits at the world's origin, on the playing field
      u.uLens[0] = -camX * zoom; u.uLens[1] = -camY * zoom; u.uLens[2] = this.lensRadius * 4.5 * zoom; u.uLens[3] = this.lensRadius > 0 ? 1 : 0;
    }

    const su = (this.starShader.resources.starUniforms as any).uniforms;
    su.uTime = this.time;
    su.uSpike[0] = Math.cos(this.spikeAngle + angle); su.uSpike[1] = Math.sin(this.spikeAngle + angle);
    su.uStreak[0] = this.streak.x; su.uStreak[1] = this.streak.y;
    const dens = Math.sqrt(b.stars.density);
    LAYERS.forEach((L, i) => {
      const z = scaleAt(zoom, L.depth);
      const cell = L.px / dens / scaleAt(1, L.depth);
      // On screen the cells shrink as you zoom out: show fewer of them, then fade the layer
      const ratio = (cell * z) / (L.px / dens);
      const v = su[`uL${i}`];
      v[0] = z; v[1] = cell; v[2] = Math.min(1, ratio * ratio); v[3] = this.layerOn[i] ? smooth(0.28, 0.55, ratio) : 0;
    });
    const zm = scaleAt(zoom, MOTE_DEPTH);
    su.uMotes.set([zm, 140 / scaleAt(1, MOTE_DEPTH), 0.32 * b.motes * smooth(0.15, 0.5, zoom), 0]);
    su.uDeep.set([zSky, 700 / scaleAt(1, SKY_DEPTH), b.deep.galaxies, b.deep.clusters]);

    this.starMesh.scale.set(w / 2, h / 2);
    this.starMesh.position.set(w / 2, h / 2);
    // The haze sits deep (it barely moves): drawn again only once the view has shifted it half a pixel, or zoomed
    const at = this.hazeAt;
    const moved = !at || at.zoom !== zoom || at.lens !== this.lensRadius || Math.abs(angle - at.angle) * Math.hypot(w, h) * this.hazeScale > 0.5 || Math.hypot(camX - at.x, camY - at.y) * zSky * this.hazeScale > 0.5
      || (this.lensRadius > 0 && Math.hypot(camX - at.x, camY - at.y) * zoom * this.hazeScale > 0.5);
    if (moved) {
      this.hazeAt = { x: camX, y: camY, zoom, lens: this.lensRadius, angle };
      this.app.renderer.render({ container: this.hazeRoot, target: this.hazeRT, clear: false });
    }
  }
}
