/**
 * NebulaRenderer — Codementor-inspired procedural nebula.
 *
 * Intentionally minimal runtime controls for sandbox usage:
 * - `radius` (mesh size)
 * - `shapeScale` (noise/shape scale)
 *
 * Everything else is baked to tuned defaults from the prototype designer.
 */

import { Container, Mesh, MeshGeometry, Shader, GlProgram, State } from 'pixi.js';
import { nebulaVert, nebulaFrag } from './shaders/nebula';

export interface NebulaUpdateOpts {
  shapeScale?: number;
  intensity?: number;
  animSpeed?: number;
  lod?: number;
  parallax?: number;
  cameraX?: number;
  cameraY?: number;
}

export class NebulaRenderer {
  private container: Container;
  private mesh: Mesh<MeshGeometry, Shader> | null = null;
  private shader: Shader | null = null;
  private time: number = 0;

  constructor() {
    this.container = new Container();
  }

  initialize(seed: number = 0): void {
    const s = 2.0;
    const positions = new Float32Array([
      -s, -s, s, -s, s, s, -s, s,
    ]);
    const uvs = new Float32Array([
      0, 0, 1, 0, 1, 1, 0, 1,
    ]);
    const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);

    const geometry = new MeshGeometry({ positions, uvs, indices });

    const glProgram = new GlProgram({
      vertex: nebulaVert,
      fragment: nebulaFrag,
    });

    this.shader = new Shader({
      glProgram,
      resources: {
        nebulaUniforms: {
          uTime:            { value: 0,    type: 'f32' },
          uSeed:            { value: seed, type: 'f32' },
          uShapeScale:      { value: 3.0,  type: 'f32' },
          uIntensity:       { value: 1.0,  type: 'f32' },
          uAnimSpeed:       { value: 1.0,  type: 'f32' },
          uLod:             { value: 1.0,  type: 'f32' },
          uParallax:        { value: 0.0,  type: 'f32' },
          uCamera:          { value: new Float32Array([0.0, 0.0]), type: 'vec2<f32>' },
          uNebulaRadius:    { value: 1200.0, type: 'f32' },
        },
      },
    });

    const state = State.for2d();
    state.blend = true;

    this.mesh = new Mesh({ geometry, shader: this.shader, state });
    this.container.addChild(this.mesh);
  }

  update(delta: number, radius: number, opts?: NebulaUpdateOpts): void {
    this.time += delta;

    if (!this.shader) return;
    const u = (this.shader.resources.nebulaUniforms as any).uniforms;

    u.uTime = this.time;
    u.uShapeScale = opts?.shapeScale ?? 3.0;
    u.uIntensity = opts?.intensity ?? 1.0;
    u.uAnimSpeed = opts?.animSpeed ?? 1.0;
    u.uLod = opts?.lod ?? 1.0;
    u.uParallax = opts?.parallax ?? 0.0;
    u.uCamera[0] = opts?.cameraX ?? 0.0;
    u.uCamera[1] = opts?.cameraY ?? 0.0;
    u.uNebulaRadius = radius;

    // Scale mesh to cover the nebula radius in world space
    if (this.mesh) {
      this.mesh.scale.set(radius, radius);
    }
  }

  setSeed(seed: number): void {
    if (!this.shader) return;
    (this.shader.resources.nebulaUniforms as any).uniforms.uSeed = seed;
  }

  setPosition(x: number, y: number): void {
    this.container.position.set(x, y);
  }

  getContainer(): Container {
    return this.container;
  }

  destroy(): void {
    this.mesh?.destroy();
    this.shader = null;
  }
}
