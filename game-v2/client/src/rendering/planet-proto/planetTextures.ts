/**
 * The planets' textures in Pixi (docs/rendering/planet-prototypes.md, "How to adopt"): the noise volume (planetNoise.ts,
 * 64³ RGBA8, trilinear with mipmaps, repeating) and, for the fine level, the crack candidates (planetCrackCells,
 * 160 x 40 x 40, nearest). Both are 3D textures, uploaded by texture3d.ts's `volume3d` (shared with the sun's plasma).
 *
 * Baked in the procedural worker through the asset cache (made once per browser). Until they come the sources hold
 * flat placeholders (no cracks, mid noise) and `planetTexturesReady()` is false: the renderer keeps planets hidden
 * till then (a first visit: about half a second; after: a few milliseconds).
 */
import { TextureSource, type Renderer } from 'pixi.js';
import { installVolumeUpload } from '../texture3d';
import { planetNoiseData as bake } from '../procedural';
import { PLANET_NOISE_SIZE } from './planetNoise';

/** A 3D RGBA8 texture's data, its depth beside Pixi's width and height */
class VolumeSource extends TextureSource<Uint8Array> {
  readonly depth: number;
  constructor(data: Uint8Array, w: number, h: number, d: number, mip: boolean) {
    super({
      resource: data, width: w, height: h, viewDimension: '3d', format: 'rgba8unorm', autoGenerateMipmaps: mip,
      addressMode: 'repeat', scaleMode: mip ? 'linear' : 'nearest', mipmapFilter: mip ? 'linear' : 'nearest',
      alphaMode: 'no-premultiply-alpha', label: 'planetVolume',
    } as ConstructorParameters<typeof TextureSource<Uint8Array>>[0]);
    this.depth = d;
    this.uploadMethodId = 'volume3d';
  }
}

const N = PLANET_NOISE_SIZE;
let noise: VolumeSource | null = null;
let crack: VolumeSource | null = null;
let ready = false;

/** Lets the renderer upload 3D sources (once per renderer; WebGL2 only: false elsewhere) */
export function attachVolumeUploads(renderer: Renderer): boolean {
  return installVolumeUpload(renderer);
}

/** The planets' two textures (made at once with placeholders; the bake is asked for on the first call) */
export function planetTextures(): { noise: TextureSource; crack: TextureSource } {
  if (!noise || !crack) {
    // (placeholder noise: every channel mid, cracks far (A 1); no crack candidates)
    noise = new VolumeSource(new Uint8Array(N * N * N * 4).fill(128).map((v, i) => ((i & 3) === 3 ? 255 : v)), N, N, N, true);
    crack = new VolumeSource(new Uint8Array(160 * 40 * 40 * 4).fill(255), 160, 40, 40, false);
    void bake().then((d) => {
      noise!.resource.set(d.noise);
      crack!.resource.set(d.cells);
      noise!.update();
      crack!.update();
      ready = true;
    });
  }
  return { noise, crack };
}

/** Whether the real textures are in (asking for them if they haven't been) */
export function planetTexturesReady(): boolean {
  planetTextures();
  return ready;
}
