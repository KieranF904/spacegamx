/**
 * The star (plasma round 5: sun/plasmaSun.ts) drawn into a render target smaller than the screen (½ of its device
 * pixels; ⅓ on Low: settings/quality.ts `sunScale`), cleared to nothing, then stretched over the screen with the normal
 * (premultiplied) blend. Its finest detail is far bigger than a pixel at every zoom and its edge is soft, so the picture
 * barely changes while the shading cost drops with the pixel count.
 *
 * Reusable: anything drawn by the game's renderer can show a star.
 *   const sun = new SunRenderer(app);
 *   sun.setStar('sol');                      // a system's star, its look from systems.json (centralBody.plasma)
 *   scene.addChild(sun.container);           // where it goes in the draw order
 *   // each frame, before the render:
 *   sun.drawAt(dt, x, y, radiusPx);          // centred on screen point (x, y), its disc radiusPx px (container in screen space)
 *   sun.update(dt, worldToScreen, parentToScreen);  // or in a world: the camera's matrix, and the container's parent's
 * `ready` says whether it's drawing yet (its noise is made in a worker and its program compiled ahead, so a first visit's
 * first frames aren't held up); until then the container shows nothing.
 */

import { Container, GlProgram, Matrix, Mesh, MeshGeometry, RenderTexture, Shader, Sprite, State, UniformGroup, type Application, type Renderer, type TextureSource } from 'pixi.js';
import systemsData from '../../../../data/systems.json';
import { shaderReady } from '../shaderWarmup';
import { volumeTexture } from '../texture3d';
import { plasmaNoiseData } from '../procedural';
import { NOISE3_SIZE } from './plasmaNoise';
import { opaqueShare, PLASMA_SUN_FRAG, PLASMA_SUN_VERT, plasmaDetail, starLook, starRadius, type StarBody, type StarLook } from './plasmaSun';

let program: GlProgram | null = null;
/** The star's program (one for every star and every tier), for compiling ahead */
export function sunProgram(): GlProgram {
  return (program ??= new GlProgram({ vertex: PLASMA_SUN_VERT, fragment: PLASMA_SUN_FRAG, name: 'plasma-sun' }));
}

/** The noise volume, once per page (from the asset cache, or built in the worker), and its texture once per renderer */
let noiseData: Uint8Array | null = null;
let noiseAsked = false;
const noiseSources = new WeakMap<Renderer, TextureSource | null>();
function noiseFor(renderer: Renderer): TextureSource | null {
  if (!noiseData) {
    if (!noiseAsked) { noiseAsked = true; void plasmaNoiseData().then((d: Uint8Array) => { noiseData = d; }); }
    return null;
  }
  let s = noiseSources.get(renderer);
  if (s === undefined) noiseSources.set(renderer, (s = volumeTexture(renderer, noiseData, NOISE3_SIZE, 'plasma-noise')));
  return s;
}

const f32 = () => ({ value: 0, type: 'f32' as const });
const vec = (n: 2 | 3 | 4) => ({ value: new Float32Array(n), type: `vec${n}<f32>` as const });

/** Every uniform the star's shader reads (set from its look, and each frame uTime, uDetail and uPxR) */
function sunUniforms() {
  return {
    uTime: f32(), uReach: f32(), uSeed: vec(3),
    uDark: vec(3), uMid: vec(3), uBright: vec(3), uCore: vec(3), uHot: vec(3), uRim: vec(3), uCorona: vec(3),
    uSurf: vec(4), uMotion: vec(4), uCor: vec(4), uLimb: vec(2), uDetail: f32(),
    uIrid: vec(4), uTintA: vec(3), uTintB: vec(3), uTintC: vec(3),
    uLimbD: vec(4), uLimbTint: vec(4), uChromo: vec(4), uChromoCol: vec(3), uEvolve: vec(3), uPxR: f32(), uFine: vec(4),
  };
}

type Systems = { systems: { id: string; centralBody?: StarBody & { type?: string } }[] };

/** A system's star from systems.json (null for a black hole, pulsar, brown dwarf or none) */
export function starOf(systemId: string): StarBody | null {
  const cb = (systemsData as unknown as Systems).systems.find((s) => s.id === systemId)?.centralBody;
  return cb && (cb.type ?? 'sun') === 'sun' ? cb : null;
}

export class SunRenderer {
  /** The stretched picture: put it where the star goes in the draw order */
  readonly container = new Container();
  private sprite: Sprite;
  private rt: RenderTexture;
  private root = new Container();
  private mesh: Mesh<MeshGeometry, Shader> | null = null;
  private shader: Shader | null = null;
  /** (set through `.uniforms`: Pixi keeps its own copy of the plain numbers) */
  private group = new UniformGroup(sunUniforms());
  private look: StarLook | null = null;
  private body: StarBody | null = null;
  private starId = '';
  /** The target's size as a share of the screen's device pixels */
  private scale = 0.5;
  private time = 0;
  /** The last frame's camera (target pixels from world units), for redraw() */
  private toTarget = new Matrix();
  private drawn = false;

  constructor(private app: Application) {
    this.rt = RenderTexture.create({ width: 4, height: 4, resolution: 1, dynamic: true });
    this.sprite = new Sprite(this.rt);
    this.container.addChild(this.sprite);
    this.container.label = 'sun';
    this.container.visible = false;
  }

  /** Quality: the target's size as a share of the screen's device pixels (½ on High and Medium, ⅓ on Low) */
  setScale(scale: number): void {
    this.scale = Math.max(0.1, Math.min(1, scale));
  }

  /** The star to draw: a system's (its look from systems.json), or a body given here; null for none */
  setStar(id: string, body: StarBody | null = starOf(id)): void {
    if (id === this.starId && body === this.body) return;
    this.starId = id;
    this.body = body;
    this.look = body ? starLook(id, body) : null;
    if (!this.look || !body) return;
    const u = this.group.uniforms as Record<string, number | Float32Array>;
    for (const [k, v] of Object.entries(this.look.uniforms)) {
      if (!(k in u)) continue;
      if (Array.isArray(v)) (u[k] as Float32Array).set(v); else u[k] = v;
    }
    const h = starRadius(body) * this.look.reach;
    const geometry = new MeshGeometry({
      positions: new Float32Array([-h, -h, h, -h, h, h, -h, h]),
      uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    });
    if (this.mesh) {
      const old = this.mesh.geometry;
      this.mesh.geometry = geometry;
      old.destroy();
    }
  }

  /** Whether it's drawing: a star set, its noise made and its program compiled */
  get ready(): boolean {
    return !!this.look && !!this.ensureMesh() && shaderReady(sunProgram());
  }

  /** The star's radius in world units (0: none) */
  get radius(): number {
    return this.body ? starRadius(this.body) : 0;
  }

  /** The radius (world units) inside which the disc hides everything behind it, while it's drawn (0: none) */
  get opaqueRadius(): number {
    return this.drawn && this.container.visible && this.container.renderable && this.look && this.body ? starRadius(this.body) * opaqueShare(this.look) : 0;
  }

  private ensureMesh(): Mesh<MeshGeometry, Shader> | null {
    if (this.mesh) return this.mesh;
    const noise = noiseFor(this.app.renderer);
    if (!noise || !this.body || !this.look) return null;
    this.shader = new Shader({ glProgram: sunProgram(), resources: { uNoise3: noise, sunUniforms: this.group } });
    const h = starRadius(this.body) * this.look.reach;
    const geometry = new MeshGeometry({
      positions: new Float32Array([-h, -h, h, -h, h, h, -h, h]),
      uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    });
    this.mesh = new Mesh({ geometry, shader: this.shader, state: State.for2d() });
    this.root.addChild(this.mesh);
    return this.mesh;
  }

  /**
   * Draw this frame's star into its target. `worldToScreen` maps the star's world (its centre at the origin) to screen
   * CSS px; `parentToScreen` maps the container's parent to screen CSS px (identity: the container is in screen space).
   */
  update(dt: number, worldToScreen: Matrix, parentToScreen: Matrix | null = null): void {
    this.time += dt;
    this.drawn = false;
    const look = this.look, body = this.body;
    if (!look || !body || !this.ready) { this.container.visible = false; return; }
    const { width: sw, height: sh } = this.app.screen;
    // Where its quad lands on screen: nothing to draw if it's off it
    const h = starRadius(body) * look.reach, m = worldToScreen;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [cx, cy] of [[-h, -h], [h, -h], [h, h], [-h, h]]) {
      const x = m.a * cx + m.c * cy + m.tx, y = m.b * cx + m.d * cy + m.ty;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    if (x1 < 0 || y1 < 0 || x0 > sw || y0 > sh) { this.container.visible = false; return; }
    this.container.visible = true;

    // The star's size on screen sets the fine octaves and the edge's noise
    const pxR = starRadius(body) * Math.hypot(m.a, m.b);
    const u = this.group.uniforms;
    u.uTime = this.time;
    u.uDetail = plasmaDetail(pxR, look.fineOnset);
    u.uPxR = pxR;

    // The target: the screen's device pixels at this.scale
    const k = this.app.renderer.resolution * this.scale;
    const tw = Math.max(1, Math.ceil(sw * k)), th = Math.max(1, Math.ceil(sh * k));
    if (this.rt.source.pixelWidth !== tw || this.rt.source.pixelHeight !== th) this.rt.resize(tw, th);
    this.toTarget.set(k, 0, 0, k, 0, 0).append(worldToScreen);
    this.drawn = true;
    this.redraw();
    // ...and stretched back over the screen, in the container's parent's frame
    const back = (parentToScreen ? parentToScreen.clone().invert() : new Matrix()).append(new Matrix(1 / k, 0, 0, 1 / k, 0, 0));
    this.sprite.setFromMatrix(back);
  }

  /** The star centred on screen point (x, y), its disc radiusPx px across the radius (the container in screen space) */
  drawAt(dt: number, x: number, y: number, radiusPx: number): void {
    const s = this.body ? radiusPx / starRadius(this.body) : 1;
    this.update(dt, new Matrix(s, 0, 0, s, x, y));
  }

  /** Draw the target again with this frame's camera (the frame's own pass; profiling calls it to time it) */
  redraw(): void {
    if (!this.drawn || !this.mesh || !this.container.renderable) return;
    this.app.renderer.render({ container: this.root, target: this.rt, clear: true, clearColor: [0, 0, 0, 0], transform: this.toTarget });
  }

  destroy(): void {
    this.container.destroy({ children: true });
    this.root.destroy({ children: true });
    this.rt.destroy(true);
  }
}
