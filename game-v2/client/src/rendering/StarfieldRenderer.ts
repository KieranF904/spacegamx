// StarfieldRenderer: Fullscreen procedural starfield via GPU shader
// Shared between sandbox and main game for visual consistency
// Usage: new StarfieldRenderer() → initialize() → update() each frame

import { Container, Mesh, MeshGeometry, Shader, GlProgram, State } from 'pixi.js';
import { starfieldVert, starfieldFrag } from './shaders/starfield';

export interface StarfieldLayerConfig {
    starCount: number;
    depth: number;
    seed: number;
}

export class StarfieldRenderer {
    private container: Container;
    private mesh: Mesh<MeshGeometry, Shader> | null = null;
    private shader: Shader | null = null;
    private time: number = 0;

    constructor() {
        this.container = new Container();
    }

    /** Call once after the renderer/canvas is ready */
    initialize(width: number, height: number): void {
        // Fullscreen quad (world-space size doesn't matter — we'll scale to screen)
        const s = 1.0;
        const positions = new Float32Array([
            -s, -s,
             s, -s,
             s,  s,
            -s,  s,
        ]);
        const uvs = new Float32Array([
            0, 0,
            1, 0,
            1, 1,
            0, 1,
        ]);
        const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);

        const geometry = new MeshGeometry({ positions, uvs, indices });

        const glProgram = new GlProgram({
            vertex: starfieldVert,
            fragment: starfieldFrag,
        });

        this.shader = new Shader({
            glProgram,
            resources: {
                starfieldUniforms: {
                    uTime:           { value: 0,    type: 'f32' },
                    uZoom:           { value: 1.0,  type: 'f32' },
                    uCamera:         { value: new Float32Array([0, 0]), type: 'vec2<f32>' },
                    uResolution:     { value: new Float32Array([width, height]), type: 'vec2<f32>' },
                    uStarBrightness: { value: 1.0,  type: 'f32' },
                    uTwinkleSpeed:   { value: 2.0,  type: 'f32' },
                    uTwinkleAmount:  { value: 0.3,  type: 'f32' },
                    uHueShift:       { value: 0,    type: 'f32' },
                    uDensity:          { value: 1.0,  type: 'f32' },
                    uStarSize:         { value: 1.0,  type: 'f32' },
                    uParallaxStrength: { value: 0.4,  type: 'f32' },
                    uBaseCell:         { value: 150,  type: 'f32' },
                    uLodBlendWidth:    { value: 0.65, type: 'f32' },
                },
            },
        });

        const state = State.for2d();
        state.blend = true;

        this.mesh = new Mesh({ geometry, shader: this.shader, state });
        this.container.addChild(this.mesh);
    }

    /** Call every frame before render */
    update(
        delta: number,
        cameraX: number,
        cameraY: number,
        zoom: number,
        screenW: number,
        screenH: number,
        opts?: {
            starBrightness?: number; twinkleSpeed?: number; twinkleAmount?: number; hueShift?: number;
            density?: number; starSize?: number; parallaxStrength?: number;
            baseCell?: number; lodBlendWidth?: number;
        },
    ): void {
        this.time += delta * 0.001;

        if (!this.shader) return;
        const u = (this.shader.resources.starfieldUniforms as any).uniforms;

        u.uTime = this.time;
        u.uZoom = zoom;
        u.uCamera[0] = cameraX;
        u.uCamera[1] = cameraY;
        u.uResolution[0] = screenW;
        u.uResolution[1] = screenH;
        u.uStarBrightness    = opts?.starBrightness    ?? 1.0;
        u.uTwinkleSpeed      = opts?.twinkleSpeed      ?? 2.0;
        u.uTwinkleAmount     = opts?.twinkleAmount     ?? 0.3;
        u.uHueShift          = opts?.hueShift          ?? 0;
        u.uDensity           = opts?.density           ?? 1.0;
        u.uStarSize          = opts?.starSize          ?? 1.0;
        u.uParallaxStrength  = opts?.parallaxStrength  ?? 0.4;
        u.uBaseCell          = opts?.baseCell          ?? 150;
        u.uLodBlendWidth     = opts?.lodBlendWidth     ?? 0.65;

        // Scale the quad to cover the full screen in pixel-space
        if (this.mesh) {
            this.mesh.scale.set(screenW * 0.5, screenH * 0.5);
            this.mesh.position.set(screenW * 0.5, screenH * 0.5);
        }
    }

    getContainer(): Container { return this.container; }
    setPosition(x: number, y: number): void { this.container.position.set(x, y); }
}
