/**
 * The sky behind everything: a system's biome (skyBiome.ts) drawn as
 *   - haze: band, nebulae, dust, filaments, into a texture half the
 *     screen's size (it's all soft, so that's indistinguishable) and stretched
 *     over the screen: a quarter of the pixels of the old full-screen pass
 *   - stars: six layers at real depths as sprites, all in one instanced draw
 *     (skySprites.ts: the same stars the old per-pixel pass drew, at a tenth
 *     of its cost), then distant galaxies, clusters and drifting dust in one more
 *
 * Depth: a layer D behind the playing field shows at scale 1 / (1/zoom + D),
 * so near stars slide past and grow as you zoom in while the far sky barely
 * moves; zoom out and the near layers thin out and fade, leaving the deep sky.
 * Each layer keeps about the same number of stars on screen at any zoom (it
 * shows a share of its cells that grows with the cells' size on screen).
 *
 * The star: no sprite wholly behind its opaque disc is drawn, and when the disc
 * covers the whole screen the sky isn't drawn at all. A black hole: inside its
 * Einstein ring every pixel shows a second image from anywhere in the sky,
 * which sprites can't reach, so there the old per-pixel shader still draws (on
 * a quad round the ring only).
 */

import { Application, Container, GlProgram, Mesh, MeshGeometry, RenderTexture, Shader, Sprite, State } from 'pixi.js';
import { skyVert, hazeFrag, starsFrag } from './skyShaders';
import { skyNoiseTexture } from './noiseTexture';
import { SKY_SPRITE_VERT, SKY_SPRITE_FRAG, SKY_DEEP_VERT, SKY_DEEP_FRAG, insideRingOnly, oneDrawGrid, ringBox, spriteGrid, sunCovers, sunHole, type SkyView } from './skySprites';
import type { SkyBiome } from './skyBiome';
import { smoothstep as smooth } from '@space-game/common';

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
const vec4s = (n: number) => ({ value: new Float32Array(4 * n), type: 'vec4<f32>' as const, size: n });

/** Uniforms every sky shader shares */
function fieldUniforms() {
  return { uCamera: vec2(), uRes: vec2(), uSky: vec4(), uBand: vec4(), uField: vec4(), uLens: vec4(), uRot: vec2() };
}

const ONE_DRAW = (s: string) => s.replace('#version 300 es', '#version 300 es\n#define SKY_ONE_DRAW 1');

let programs: GlProgram[] | null = null;
let ringProgram: GlProgram | null = null;
/** The haze's program, the stars' (one draw) and the deep sky's: every sky's, for compiling ahead */
export function skyPrograms(): GlProgram[] {
  return (programs ??= [
    new GlProgram({ vertex: skyVert, fragment: hazeFrag, name: 'sky-haze' }),
    new GlProgram({ vertex: ONE_DRAW(SKY_SPRITE_VERT), fragment: SKY_SPRITE_FRAG, name: 'sky-stars' }),
    new GlProgram({ vertex: SKY_DEEP_VERT, fragment: SKY_DEEP_FRAG, name: 'sky-deep' }),
  ]);
}
/** The old star shader inside a black hole's Einstein ring (only black-hole systems need it: compile it last) */
export function skyRingProgram(): GlProgram {
  return (ringProgram ??= new GlProgram({ vertex: skyVert, fragment: insideRingOnly(starsFrag), name: 'sky-ring' }));
}

type Uniforms = Record<string, number | Float32Array>;
/** Copy a uniform record into a group's uniforms (numbers, vectors, arrays of vectors) */
function put(u: Uniforms, from: Record<string, number | number[] | number[][]>): void {
  for (const [k, v] of Object.entries(from)) {
    if (!(k in u)) continue;
    if (typeof v === 'number') u[k] = v;
    else if (Array.isArray(v[0])) { const out = u[k] as Float32Array; (v as number[][]).forEach((row, i) => out.set(row, i * 4)); }
    else (u[k] as Float32Array).set(v as number[]);
  }
}

export class SkyRenderer {
  /** Goes at the very back of the stage */
  readonly container = new Container();
  private hazeRT: RenderTexture;
  private hazeSprite: Sprite;
  private hazeRoot = new Container();
  private hazeMesh: Mesh<MeshGeometry, Shader>;
  private hazeShader: Shader;
  /** The six star layers, one instanced draw */
  private starShader: Shader;
  private starMesh: Mesh<MeshGeometry, Shader>;
  /** Galaxies, clusters and motes, one more */
  private deepShader: Shader;
  private deepMesh: Mesh<MeshGeometry, Shader>;
  /** Inside a black hole's ring: the old per-pixel stars (made when a system has one) */
  private ring: { shader: Shader; mesh: Mesh<MeshGeometry, Shader> } | null = null;
  private biome: SkyBiome | null = null;
  private time = 0;
  private lastCam: { x: number; y: number } | null = null;
  private streak = { x: 0, y: 0 };
  private hazeScale = HAZE_SCALE;
  /** Star layers drawn */
  private layerOn: readonly boolean[] = [true, true, true, true, true, true];

  constructor(private app: Application) {
    const noise = skyNoiseTexture();
    const [hazeProgram, starProgram, deepProgram] = skyPrograms();
    this.hazeShader = new Shader({
      glProgram: hazeProgram,
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
      glProgram: starProgram,
      resources: {
        uNoise: noise.source,
        starUniforms: {
          ...fieldUniforms(), uSunHole: vec3(), uTime: f32(),
          uLs: vec4s(6), uLooks: vec4s(6), uGrids: vec4s(6), uStarts: vec4s(2),
          uStarMix: vec4(), uTint: vec3(), uStreak: vec2(), uSpike: vec2(),
        },
      },
    });
    this.deepShader = new Shader({
      glProgram: deepProgram,
      resources: {
        uNoise: noise.source,
        deepUniforms: {
          ...fieldUniforms(), uSunHole: vec3(),
          uDeep: vec4(), uMotes: vec4(), uGridDeep: vec4(), uGridMote: vec4(), uCounts: vec2(), uStreak: vec2(), uMoteColor: vec3(),
        },
      },
    });
    this.hazeRT = RenderTexture.create({ width: 4, height: 4, resolution: 1, dynamic: true });
    this.hazeMesh = new Mesh({ geometry: quad(0, 0, 4, 4), shader: this.hazeShader, state: State.for2d() });
    this.hazeRoot.addChild(this.hazeMesh);
    this.hazeSprite = new Sprite(this.hazeRT);
    this.hazeSprite.scale.set(1 / this.hazeScale);
    // (The sprites place themselves in clip space: the quad only gives each instance its corners)
    this.starMesh = new Mesh({ geometry: quad(0, 0, 1, 1), shader: this.starShader, state: State.for2d() });
    this.starMesh.blendMode = 'add';
    this.deepMesh = new Mesh({ geometry: quad(0, 0, 1, 1), shader: this.deepShader, state: State.for2d() });
    this.deepMesh.blendMode = 'add';
    this.container.addChild(this.hazeSprite, this.starMesh, this.deepMesh);
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

  private groups(): Uniforms[] {
    const out = [this.hazeShader.resources.hazeUniforms, this.starShader.resources.starUniforms, this.deepShader.resources.deepUniforms];
    if (this.ring) out.push(this.ring.shader.resources.ringUniforms);
    return out.map((g) => (g as { uniforms: Uniforms }).uniforms);
  }

  setBiome(b: SkyBiome): void {
    if (b === this.biome) return;
    this.hazeAt = null;
    this.biome = b;
    this.applyBiome();
  }

  private applyBiome(): void {
    const b = this.biome;
    if (!b) return;
    for (const u of this.groups()) {
      const sky = u.uSky as Float32Array, band = u.uBand as Float32Array, field = u.uField as Float32Array;
      sky[1] = SKY_TILE; sky[2] = b.seed[0]; sky[3] = b.seed[1];
      band[0] = -Math.sin(b.band.angle); band[1] = Math.cos(b.band.angle); band[2] = b.band.offset; band[3] = b.band.width;
      field[0] = b.dust.strength; field[1] = b.nebula.cover;
    }
    const hu = (this.hazeShader.resources.hazeUniforms as { uniforms: Uniforms }).uniforms;
    put(hu, {
      uBase: b.base, uBandCore: b.band.core, uBandEdge: b.band.edge, uBandStrength: b.band.strength, uDustTint: b.dust.tint,
      uNebA: b.nebula.a, uNebB: b.nebula.b, uNebStrength: b.nebula.strength, uFilColor: b.filaments.color, uFilStrength: b.filaments.strength,
      uShell: [b.shell.x, b.shell.y, b.shell.radius, b.shell.strength], uShellColor: b.shell.color,
    });
    const stars = { uStarMix: [b.stars.temperature, b.stars.brightness, b.stars.bandBoost, b.stars.spikes], uTint: b.stars.tint, uMoteColor: b.moteColor };
    put((this.starShader.resources.starUniforms as { uniforms: Uniforms }).uniforms, stars);
    put((this.deepShader.resources.deepUniforms as { uniforms: Uniforms }).uniforms, stars);
    if (this.ring) put((this.ring.shader.resources.ringUniforms as { uniforms: Uniforms }).uniforms, stars);
    this.spikeAngle = b.stars.spikeAngle;
  }

  /** A black hole at the system's centre bends the sky around it (radius: its horizon; 0 for none) */
  private lensRadius = 0;
  setLens(horizon: number): void {
    if (horizon !== this.lensRadius) this.hazeAt = null;
    this.lensRadius = horizon;
    if (horizon > 0 && !this.ring) this.makeRing();
  }

  /** The old star shader, for inside a black hole's ring */
  private makeRing(): void {
    const shader = new Shader({
      glProgram: skyRingProgram(),
      resources: {
        uNoise: skyNoiseTexture().source,
        ringUniforms: {
          ...fieldUniforms(), uTime: f32(),
          uL0: vec4(), uL1: vec4(), uL2: vec4(), uL3: vec4(), uL4: vec4(), uL5: vec4(),
          uMotes: vec4(), uDeep: vec4(), uStarMix: vec4(), uTint: vec3(), uSpike: vec2(), uStreak: vec2(), uMoteColor: vec3(),
        },
      },
    });
    const mesh = new Mesh({ geometry: quad(0, 0, 1, 1), shader, state: State.for2d() });
    mesh.blendMode = 'add';
    mesh.visible = false;
    this.container.addChildAt(mesh, this.container.getChildIndex(this.starMesh));
    this.ring = { shader, mesh };
    this.applyBiome();
  }

  /**
   * Once a frame: follow the camera (`angle` its roll), then draw the haze into its texture. `sunOpaque`: the radius
   * (world units) of the star's opaque disc at the world's origin while it's drawn (0: none), which hides the sky behind it.
   */
  update(deltaMs: number, camX: number, camY: number, zoom: number, angle = 0, sunOpaque = 0): void {
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

    // The star's disc over the whole screen: nothing of the sky shows
    const view: SkyView = { w, h, cam: [camX, camY], zoom, t: this.time, angle, streak: [this.streak.x, this.streak.y] };
    if (sunOpaque > 0 && sunCovers(view, sunOpaque)) { this.container.visible = false; return; }
    const hole = sunOpaque > 0 ? sunHole(view, sunOpaque) : [0, 0, 0];

    const zSky = scaleAt(zoom, SKY_DEPTH);
    const groups = this.groups();
    for (const u of groups) {
      const cam = u.uCamera as Float32Array, rot = u.uRot as Float32Array, res = u.uRes as Float32Array, lens = u.uLens as Float32Array;
      cam[0] = camX; cam[1] = camY;
      rot[0] = Math.cos(angle); rot[1] = Math.sin(angle);
      res[0] = w; res[1] = h;
      (u.uSky as Float32Array)[0] = zSky;
      // The hole sits at the world's origin, on the playing field
      lens[0] = -camX * zoom; lens[1] = -camY * zoom; lens[2] = this.lensRadius * 4.5 * zoom; lens[3] = this.lensRadius > 0 ? 1 : 0;
      if (u.uSunHole) (u.uSunHole as Float32Array).set(hole);
      if (u.uStreak) (u.uStreak as Float32Array).set([this.streak.x, this.streak.y]);
      if (u.uSpike) (u.uSpike as Float32Array).set([Math.cos(this.spikeAngle + angle), Math.sin(this.spikeAngle + angle)]);
      if ('uTime' in u) u.uTime = this.time;
    }

    // The stars: every layer's cells that could light the screen, in one draw
    const stars = oneDrawGrid(b, view, this.lensRadius, this.layerOn);
    this.starMesh.visible = !!stars;
    if (stars) {
      put((this.starShader.resources.starUniforms as { uniforms: Uniforms }).uniforms, stars.uniforms);
      this.starMesh.geometry.instanceCount = stars.count;
    }
    const deep = spriteGrid(b, view, 'deep', this.lensRadius);
    this.deepMesh.visible = !!deep && deep.count > 0;
    if (deep && deep.count > 0) {
      put((this.deepShader.resources.deepUniforms as { uniforms: Uniforms }).uniforms, deep.uniforms);
      this.deepMesh.geometry.instanceCount = deep.count;
    }
    this.updateRing(view, b);

    // The haze sits deep (it barely moves): drawn again only once the view has shifted it half a pixel, or zoomed
    const at = this.hazeAt;
    const moved = !at || at.zoom !== zoom || at.lens !== this.lensRadius || Math.abs(angle - at.angle) * Math.hypot(w, h) * this.hazeScale > 0.5 || Math.hypot(camX - at.x, camY - at.y) * zSky * this.hazeScale > 0.5
      || (this.lensRadius > 0 && Math.hypot(camX - at.x, camY - at.y) * zoom * this.hazeScale > 0.5);
    if (moved) {
      this.hazeAt = { x: camX, y: camY, zoom, lens: this.lensRadius, angle };
      this.app.renderer.render({ container: this.hazeRoot, target: this.hazeRT, clear: false });
    }
  }

  /** Inside a black hole's ring (when it's on screen): the old shader, on a quad round the ring */
  private updateRing(v: SkyView, b: SkyBiome): void {
    const ring = this.ring;
    if (!ring) return;
    const box = this.lensRadius > 0 ? ringBox(v, this.lensRadius) : null;
    ring.mesh.visible = !!box;
    if (!box) return;
    const u = (ring.shader.resources.ringUniforms as { uniforms: Uniforms }).uniforms;
    const dens = Math.sqrt(b.stars.density);
    LAYERS.forEach((L, i) => {
      const z = scaleAt(v.zoom, L.depth);
      const cell = L.px / dens / scaleAt(1, L.depth);
      const ratio = (cell * z) / (L.px / dens);
      (u[`uL${i}`] as Float32Array).set([z, cell, Math.min(1, ratio * ratio), this.layerOn[i] ? smooth(0.28, 0.55, ratio) : 0]);
    });
    const zSky = scaleAt(v.zoom, SKY_DEPTH), zm = scaleAt(v.zoom, MOTE_DEPTH);
    (u.uMotes as Float32Array).set([zm, 140 / scaleAt(1, MOTE_DEPTH), 0.32 * b.motes * smooth(0.15, 0.5, v.zoom), 0]);
    (u.uDeep as Float32Array).set([zSky, 700 / scaleAt(1, SKY_DEPTH), b.deep.galaxies, b.deep.clusters]);
    // The quad round the ring (px from the screen's middle), its uv the screen's, as the shader expects
    const [x0, y0, x1, y1] = box, w = v.w, h = v.h;
    const pos = ring.mesh.geometry.getBuffer('aPosition'), uv = ring.mesh.geometry.getBuffer('aUV');
    (pos.data as Float32Array).set([x0 + w / 2, y0 + h / 2, x1 + w / 2, y0 + h / 2, x1 + w / 2, y1 + h / 2, x0 + w / 2, y1 + h / 2]);
    (uv.data as Float32Array).set([x0 / w + 0.5, y0 / h + 0.5, x1 / w + 0.5, y0 / h + 0.5, x1 / w + 0.5, y1 / h + 0.5, x0 / w + 0.5, y1 / h + 0.5]);
    pos.update();
    uv.update();
  }
}
