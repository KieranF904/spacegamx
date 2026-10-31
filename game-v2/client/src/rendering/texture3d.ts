/**
 * 3D textures in Pixi v8 (WebGL2): Pixi binds a source whose viewDimension is '3d' to TEXTURE_3D, sets its wrap (R too)
 * and filters, and makes its mipmaps, but has no uploader for one. `volumeTexture` adds that uploader to the renderer
 * (once) and makes a source for an RGBA8 volume; bind it like any texture (`resources: { uNoise3: source }`) to a
 * `sampler3D`. Used by the sun's plasma (sun/SunRenderer.ts); the planets can share it.
 */

import { TextureSource, type Renderer } from 'pixi.js';

const UPLOAD = 'volume3d';

interface Uploads { _uploads?: Record<string, { id: string; upload(source: TextureSource, gl: unknown, ctx: WebGL2RenderingContext): void }> }

/** Make sure `renderer` can upload volumes (WebGL2 only: false elsewhere) */
export function installVolumeUpload(renderer: Renderer): boolean {
  const ts = (renderer as unknown as { texture?: Uploads }).texture;
  const gl = (renderer as unknown as { gl?: WebGL2RenderingContext }).gl;
  if (!ts?._uploads || !gl || typeof gl.texImage3D !== 'function') return false;
  ts._uploads[UPLOAD] ??= {
    id: UPLOAD,
    upload(source, _glTexture, ctx) {
      const s = source as TextureSource & { depth?: number; resource: Uint8Array };
      ctx.pixelStorei(ctx.UNPACK_ALIGNMENT, 1);
      ctx.texImage3D(ctx.TEXTURE_3D, 0, ctx.RGBA8, s.pixelWidth, s.pixelHeight, s.depth ?? s.pixelWidth, 0, ctx.RGBA, ctx.UNSIGNED_BYTE, s.resource);
      ctx.pixelStorei(ctx.UNPACK_ALIGNMENT, 4);
    },
  };
  return true;
}

/**
 * An RGBA8 volume of size³ texels (x fastest, then y, then z) as a texture source: repeat on every axis, trilinear with
 * mipmaps, no premultiplying (its channels are data). Null where the renderer can't take one.
 */
export function volumeTexture(renderer: Renderer, data: Uint8Array, size: number, label = 'volume'): TextureSource | null {
  if (!installVolumeUpload(renderer)) return null;
  const source = new TextureSource({
    resource: data, width: size, height: size, label,
    format: 'rgba8unorm', dimensions: '3d', viewDimension: '3d',
    addressMode: 'repeat', scaleMode: 'linear', autoGenerateMipmaps: true, alphaMode: 'no-premultiply-alpha',
  } as ConstructorParameters<typeof TextureSource>[0]);
  source.uploadMethodId = UPLOAD;
  (source as TextureSource & { depth: number }).depth = size;
  return source;
}
