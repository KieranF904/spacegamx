/**
 * Like SpritePool, for the many small effects drawn every frame (tracers, sparks, flashes, smoke): one ParticleContainer,
 * so a particle costs a few numbers written, not a scene-graph node (with its transform, colour parse and batching) per
 * thing drawn. One draw for the lot, in the order taken, from up to four textures.
 *
 * Pixi's particles all share one texture, so the shader here is its particle shader with a texture chosen per particle,
 * as Pixi's sprite batcher chooses one (the index rides in the particle's u coordinate: u + 4 × index).
 */

import { Color, Container, GlProgram, Matrix, Particle, ParticleContainer, Shader, Texture } from 'pixi.js';

const MAX_TEXTURES = 4;
/** Particles kept in reserve, past which those not needed are let go */
const SPARE_MAX = 4096;

const vertex = `
attribute vec2 aVertex;
attribute vec2 aUV;
attribute vec4 aColor;
attribute vec2 aPosition;
attribute float aRotation;

uniform mat3 uTranslationMatrix;
uniform float uRound;
uniform vec2 uResolution;
uniform vec4 uColor;

varying vec2 vUV;
varying vec4 vColor;
varying float vTextureId;

vec2 roundPixels(vec2 position, vec2 targetSize)
{
    return (floor(((position * 0.5 + 0.5) * targetSize) + 0.5) / targetSize) * 2.0 - 1.0;
}

void main(void){
    float cosRotation = cos(aRotation);
    float sinRotation = sin(aRotation);
    float x = aVertex.x * cosRotation - aVertex.y * sinRotation;
    float y = aVertex.x * sinRotation + aVertex.y * cosRotation;

    vec2 v = vec2(x, y);
    v = v + aPosition;

    gl_Position = vec4((uTranslationMatrix * vec3(v, 1.0)).xy, 0.0, 1.0);

    if(uRound == 1.0)
    {
        gl_Position.xy = roundPixels(gl_Position.xy, uResolution);
    }

    vTextureId = floor(aUV.x / 4.0 + 0.3);
    vUV = vec2(aUV.x - vTextureId * 4.0, aUV.y);
    vColor = vec4(aColor.rgb * aColor.a, aColor.a) * uColor;
}
`;

const fragment = `
varying vec2 vUV;
varying vec4 vColor;
varying float vTextureId;

uniform sampler2D uTexture;
uniform sampler2D uTexture1;
uniform sampler2D uTexture2;
uniform sampler2D uTexture3;

void main(void){
    vec4 color;
    if (vTextureId < 0.5) color = texture2D(uTexture, vUV);
    else if (vTextureId < 1.5) color = texture2D(uTexture1, vUV);
    else if (vTextureId < 2.5) color = texture2D(uTexture2, vUV);
    else color = texture2D(uTexture3, vUV);
    gl_FragColor = color * vColor;
}
`;

/**
 * Rings (shockwaves, charge rings, filled discs): one quad each, the band worked out per pixel, a true circle with a
 * pixel's soft edge (as the stroked circles drawn before looked under MSAA). Rings don't turn, so the particle's rotation
 * carries the band's width; its radius is what's left of the quad's half size (the quad is a ring's outer edge plus RING_PAD).
 */
const RING_PAD = 6;

const ringVertex = `
attribute vec2 aVertex;
attribute vec2 aUV;
attribute vec4 aColor;
attribute vec2 aPosition;
attribute float aRotation;

uniform mat3 uTranslationMatrix;
uniform vec2 uResolution;
uniform vec4 uColor;

varying vec2 vLocal;
varying vec4 vColor;
varying float vRadius;
varying float vHalfWidth;
varying float vPixels;

void main(void){
    gl_Position = vec4((uTranslationMatrix * vec3(aVertex + aPosition, 1.0)).xy, 0.0, 1.0);
    // Pixels a world unit (clip space is 2 across the target's pixels)
    vPixels = length(uTranslationMatrix[0].xy) * 0.5 * uResolution.x;
    // (aUV unused, but read: Pixi warns of an attribute the program doesn't have)
    vLocal = aVertex + aUV * 0.0;
    vHalfWidth = aRotation * 0.5;
    vRadius = abs(aVertex.x) - vHalfWidth - ${RING_PAD.toFixed(1)};
    vColor = vec4(aColor.rgb * aColor.a, aColor.a) * uColor;
}
`;

const ringFragment = `
varying vec2 vLocal;
varying vec4 vColor;
varying float vRadius;
varying float vHalfWidth;
varying float vPixels;

void main(void){
    // Distance outside the band, in pixels
    float e = (abs(length(vLocal) - vRadius) - vHalfWidth) * vPixels;
    gl_FragColor = vColor * clamp(0.5 - e, 0.0, 1.0);
}
`;

let program: GlProgram | null = null;
let ringProgram: GlProgram | null = null;

/** The pools' shader programs (for the shader warm-up: see rendering/gameShaders.ts) */
export function particlePrograms(): GlProgram[] {
  program ??= GlProgram.from({ vertex, fragment, name: 'particle-pool' });
  ringProgram ??= GlProgram.from({ vertex: ringVertex, fragment: ringFragment, name: 'particle-rings' });
  return [program, ringProgram];
}

export class ParticlePool {
  readonly container = new Container({ isRenderGroup: true });
  private pc: ParticleContainer | null = null;
  private shader: Shader | null = null;
  /** Each texture taken, by the copy of it whose u coordinates carry its index */
  private textures = new Map<Texture, Texture>();
  private used = 0;
  /** How many it drew last frame (a change has Pixi upload the particles' attributes afresh) */
  private drawn = 0;
  private spare: Particle[] = [];

  /** `rings`: a pool of rings and discs (`ring`, `disc`), not of textured particles */
  constructor(private blendMode: 'add' | 'normal' = 'normal', private shape: 'sprites' | 'rings' = 'sprites') {}

  begin(): void {
    this.used = 0;
  }

  /** A particle showing `texture`, anchored at (ax, ay), at (x, y), turned, scaled, tinted and faded */
  take(texture: Texture, x: number, y: number, ax: number, ay: number, tint: number, alpha: number, rotation: number, sx: number, sy: number): void {
    const pc = this.pc ?? this.make(texture);
    const kids = pc.particleChildren as Particle[];
    let p = kids[this.used];
    if (!p) {
      p = this.spare.pop() ?? new Particle(texture);
      kids.push(p);
    }
    this.used++;
    p.texture = this.textures.get(texture) ?? this.add(texture);
    p.x = x;
    p.y = y;
    p.anchorX = ax;
    p.anchorY = ay;
    p.rotation = rotation;
    p.scaleX = sx;
    p.scaleY = sy;
    // Packed as a sprite's tint and alpha are (blue-green-red, alpha clamped in the top byte), without Pixi's colour parse
    const a = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
    p.color = ((tint & 0xff) << 16) + (tint & 0xff00) + ((tint >> 16) & 0xff) + (((a * 255) | 0) << 24);
  }

  /** A ring (rings pools): centre (x, y), `r` to the middle of its band, `width` across, tinted and faded */
  ring(x: number, y: number, r: number, width: number, tint: number, alpha: number): void {
    const size = 2 * (r + width / 2 + RING_PAD);
    this.take(Texture.WHITE, x, y, 0.5, 0.5, tint, alpha, width, size, size);
  }

  /** A filled disc of radius `r` (rings pools) */
  disc(x: number, y: number, r: number, tint: number, alpha: number): void {
    this.ring(x, y, r / 2, r, tint, alpha);
  }

  end(): void {
    const pc = this.pc;
    if (!pc) return;
    const kids = pc.particleChildren as Particle[];
    while (kids.length > this.used) {
      const p = kids.pop()!;
      if (this.spare.length < SPARE_MAX) this.spare.push(p);
    }
    if (this.used !== this.drawn) pc.update();
    this.drawn = this.used;
  }

  /** The container, the first time anything's taken (its texture is the first one's) */
  private make(texture: Texture): ParticleContainer {
    const [sprites, rings] = particlePrograms();
    const white = Texture.WHITE.source;
    this.shader = new Shader({
      glProgram: this.shape === 'rings' ? rings : sprites,
      resources: {
        // (uTexture and uniforms are set by Pixi's particle pipe as it draws)
        uTexture: white,
        uTexture1: white,
        uTexture2: white,
        uTexture3: white,
        uniforms: {
          uTranslationMatrix: { value: new Matrix(), type: 'mat3x3<f32>' },
          uColor: { value: new Color(0xffffff), type: 'vec4<f32>' },
          uRound: { value: 1, type: 'f32' },
          uResolution: { value: [0, 0], type: 'vec2<f32>' },
        },
      },
    });
    this.pc = new ParticleContainer({
      texture,
      shader: this.shader,
      dynamicProperties: { vertex: true, position: true, rotation: true, uvs: true, color: true },
    });
    this.pc.blendMode = this.blendMode;
    this.container.addChild(this.pc);
    return this.pc;
  }

  /** A texture seen for the first time: its sampler, and its copy with the index in its u coordinates */
  private add(texture: Texture): Texture {
    const i = this.textures.size;
    if (i >= MAX_TEXTURES) throw new Error(`ParticlePool: more than ${MAX_TEXTURES} textures`);
    if (i > 0) this.shader!.resources[`uTexture${i}`] = texture.source;
    const copy = new Texture({ source: texture.source, frame: texture.frame.clone(), orig: texture.orig.clone() });
    const shift = (): void => {
      const uv = copy.uvs;
      uv.x0 += 4 * i;
      uv.x1 += 4 * i;
      uv.x2 += 4 * i;
      uv.x3 += 4 * i;
    };
    shift();
    // (Pixi works its u coordinates out afresh whenever the texture updates)
    copy.on('update', shift);
    this.textures.set(texture, copy);
    return copy;
  }
}
