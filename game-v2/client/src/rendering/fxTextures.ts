/**
 * Effect textures, painted once on a 2D canvas and drawn as sprites: thruster
 * plumes, soft glow dots, tracer streaks and flash petals. Sprites cost nothing
 * to move, stretch or fade each frame, where vector shapes redrawn every frame
 * are re-triangulated every frame. Painting them also lets them be soft (a
 * little blur, smooth falloff) instead of flat-edged layers.
 */

import { CanvasSource, Texture } from 'pixi.js';

const cache = new Map<string, Texture>();

function paint(key: string, w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void): Texture {
  const hit = cache.get(key);
  if (hit) return hit;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  draw(ctx);
  // Mipmapped (every size here is a power of two): sparks and plumes don't shimmer when zoomed out
  const tex = new Texture({ source: new CanvasSource({ resource: canvas, width: w, height: h, resolution: 1, autoGenerateMipmaps: true }) });
  cache.set(key, tex);
  return tex;
}

const css = (c: number, a: number) => `rgba(${(c >> 16) & 255}, ${(c >> 8) & 255}, ${c & 255}, ${a})`;

/**
 * A plume's geometry, in units of its length (x, from the nozzle) and its
 * nozzle half-width (y): the texture spans x 0..PLUME_LEN and y ±PLUME_HALF of those.
 */
export const PLUME_LEN = 1.3;
export const PLUME_HALF = 1.7 * 1.25;
const PLUME_W = 256, PLUME_H = 128, PAD = 6;

/** Map plume units to canvas pixels */
function plumeCtx(ctx: CanvasRenderingContext2D): (x: number, y: number) => [number, number] {
  const sx = (PLUME_W - PAD * 2) / PLUME_LEN, sy = (PLUME_H / 2 - PAD) / PLUME_HALF;
  return (x, y) => [PAD + x * sx, PLUME_H / 2 + y * sy];
}

function flame(ctx: CanvasRenderingContext2D, len: number, half: number, bulge: number, color: number, alpha: number): void {
  const at = plumeCtx(ctx);
  const pts: [number, number][] = [[0, -half], [len * 0.28, -half * bulge], [len * 0.65, -half * 0.45], [len, 0], [len * 0.65, half * 0.45], [len * 0.28, half * bulge], [0, half]];
  ctx.beginPath();
  pts.forEach(([x, y], i) => { const [px, py] = at(x, y); if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); });
  ctx.closePath();
  ctx.fillStyle = css(color, alpha);
  ctx.fill();
}

/**
 * A plume's silhouettes, glow / outer / inner as [length, half-width, bulge] (units of PLUME_LEN and the nozzle half-width):
 * the ordinary flame, a long thin needle (Torch), a wide sheath round a bright core (Fusion Torch) and a short wide cone
 * (the Afterburner's boost). scripts/native-render/gl_worker.py keeps the same table.
 */
export type PlumeShape = 'plume' | 'needle' | 'sheath' | 'cone';
export const PLUME_SHAPES: Record<PlumeShape, [number, number, number][]> = {
  plume: [[1.3, 1.7, 1.25], [1, 1.02, 1.1], [0.68, 0.66, 1.0]],
  needle: [[1.3, 0.8, 1.1], [1, 0.4, 1.0], [0.82, 0.2, 1.0]],
  sheath: [[1.3, 1.5, 1.2], [1, 1.1, 1.1], [0.8, 0.45, 1.0]],
  cone: [[1.3, 1.6, 1.3], [1, 1.3, 1.2], [0.62, 0.7, 1.1]],
};
/** The texture name of a plume in colours and shape (the native renderer asks the GL worker for it by this) */
export const plumeKey = (outer: number, inner: number, glow: number, shape: PlumeShape = 'plume'): string =>
  `plume:${outer}:${inner}:${glow}${shape === 'plume' ? '' : ':' + shape}`;

/** The flame of a plume at full throttle without its white core (glow, outer and inner flames) */
export function plumeBody(outer: number, inner: number, glow: number, shape: PlumeShape = 'plume'): Texture {
  const [g, o, i] = PLUME_SHAPES[shape];
  return paint(plumeKey(outer, inner, glow, shape), PLUME_W, PLUME_H, (ctx) => {
    ctx.globalCompositeOperation = 'lighter';
    ctx.filter = 'blur(2px)';
    flame(ctx, g[0], g[1], g[2], glow, 0.1);
    flame(ctx, o[0], o[1], o[2], outer, 0.32);
    ctx.filter = 'blur(1px)';
    flame(ctx, i[0], i[1], i[2], inner, 0.5);
  });
}

/** A plume's white-hot core */
export function plumeCore(): Texture {
  return paint('plume:core', PLUME_W, PLUME_H, (ctx) => {
    ctx.filter = 'blur(1px)';
    flame(ctx, 0.34, 0.34, 0.95, 0xffffff, 0.85);
  });
}

/** Shock diamonds in a working plume */
export function plumeDiamonds(): Texture {
  return paint('plume:diamonds', PLUME_W, PLUME_H, (ctx) => {
    const at = plumeCtx(ctx);
    ctx.globalCompositeOperation = 'lighter';
    ctx.filter = 'blur(0.6px)';
    for (let i = 0; i < 3; i++) {
      const d = 0.3 + i * 0.18, s = 0.32 - i * 0.07;
      ctx.beginPath();
      const p = [at(d - s * 0.15, 0), at(d, s * 0.6), at(d + s * 0.15, 0), at(d, -s * 0.6)];
      p.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.fillStyle = `rgba(255, 255, 255, ${0.45 * (1 - i * 0.25)})`;
      ctx.fill();
    }
  });
}

/** A plume's anchor (the nozzle, middle of its base) as a fraction of the texture */
export const PLUME_ANCHOR = { x: PAD / PLUME_W, y: 0.5 };
/** Sprite scale for a plume of length L and nozzle half-width w (world units) */
export function plumeScale(L: number, w: number): { x: number; y: number } {
  return { x: L / ((PLUME_W - PAD * 2) / PLUME_LEN), y: w / ((PLUME_H / 2 - PAD) / PLUME_HALF) };
}

/**
 * A soft round glow: a bright disc to `core` of the radius, then a faint halo
 * out to the edge. 64 px across; scale it to 2 × radius / 64.
 */
export function softDot(core = 0.45, halo = 0.12): Texture {
  return paint(`dot:${core}:${halo}`, 64, 64, (ctx) => {
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(core * 0.8, 'rgba(255,255,255,0.95)');
    g.addColorStop(core, `rgba(255,255,255,${Math.max(halo * 2.5, 0.3)})`);
    g.addColorStop(Math.min(0.99, core + 0.08), `rgba(255,255,255,${halo})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
  });
}
export const DOT_SIZE = 64;

/** A plain filled disc with a smooth edge (64 px across) */
export function disc(): Texture {
  return paint('disc', 64, 64, (ctx) => {
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.9, 'rgba(255,255,255,1)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
  });
}

/**
 * A streak with round ends, white, brightest along its middle: 128 × 32 px,
 * the caps 16 px each. Anchor (0, 0.5) at its tail; see streakScale.
 */
export function streak(): Texture {
  return paint('streak', 128, 32, (ctx) => {
    const g = ctx.createLinearGradient(0, 0, 0, 32);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.3, 'rgba(255,255,255,0.85)');
    g.addColorStop(0.5, 'rgba(255,255,255,1)');
    g.addColorStop(0.7, 'rgba(255,255,255,0.85)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(16, 16, 15.5, Math.PI / 2, Math.PI * 1.5);
    ctx.lineTo(112, 0.5);
    ctx.arc(112, 16, 15.5, -Math.PI / 2, Math.PI / 2);
    ctx.closePath();
    ctx.fill();
  });
}

/** Sprite scale for a streak from tail to head `len` long and `width` thick (caps included, as a stroke's round caps) */
export function streakScale(len: number, width: number): { x: number; y: number } {
  // The texture's body is 96 px between its caps, which are each width/2 long
  return { x: (len + width) / 128, y: width / 32 };
}

/** A flash petal: a soft triangle, base (x 0, y ±1) to tip (x 1). 128 × 64 px; anchor (0, 0.5) at the base */
export function petal(): Texture {
  return paint('petal', 128, 64, (ctx) => {
    ctx.filter = 'blur(1px)';
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(2, 2);
    ctx.lineTo(126, 32);
    ctx.lineTo(2, 62);
    ctx.closePath();
    ctx.fill();
  });
}

/** Sprite scale for a petal `len` long with half-width `half` at its base */
export function petalScale(len: number, half: number): { x: number; y: number } {
  return { x: len / 124, y: half / 30 };
}

/** A thin ring (64 px across, 3 px line at radius 20 of 32: scale it like a dot of radius 32/20 × r) */
export function ring(): Texture {
  return paint('ring', 64, 64, (ctx) => {
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 4.8;
    ctx.beginPath();
    ctx.arc(32, 32, 28, 0, Math.PI * 2);
    ctx.stroke();
  });
}

/** An irregular rock chip (a few variants, picked by `i`), white to be tinted, 64 px across */
export function rock(i: number): Texture {
  const v = Math.abs(i) % 4;
  return paint(`rock:${v}`, 64, 64, (ctx) => {
    let seed = 17 + v * 101;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const sides = 4 + (v % 3);
    ctx.beginPath();
    for (let k = 0; k < sides; k++) {
      const a = (k / sides) * Math.PI * 2;
      const r = 30 * (0.7 + rnd() * 0.3);
      const x = 32 + Math.cos(a) * r, y = 32 + Math.sin(a) * r;
      if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    }
    ctx.closePath();
    ctx.fillStyle = '#ffffff';
    ctx.fill();
  });
}

/** A fireball glow: a hot bright middle falling off smoothly to nothing (64 px across) */
export function glowBall(): Texture {
  return paint('glowBall', 64, 64, (ctx) => {
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.3, 'rgba(255,255,255,0.85)');
    g.addColorStop(0.55, 'rgba(255,255,255,0.42)');
    g.addColorStop(0.8, 'rgba(255,255,255,0.14)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
  });
}

/** A smoke puff: dense in the middle, a soft ragged-free edge (64 px across) */
export function puff(): Texture {
  return paint('puff', 64, 64, (ctx) => {
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.5, 'rgba(255,255,255,0.8)');
    g.addColorStop(0.8, 'rgba(255,255,255,0.3)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
  });
}

/**
 * A shield bubble: faint inside, brightening to a crisp rim at 30 of its 32 px
 * radius (as the edge of a sphere looks). 128 px across; the rim's at 0.94 of the half-size.
 */
export function bubble(): Texture {
  return paint('bubble', 128, 128, (ctx) => {
    const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, 'rgba(255,255,255,0.12)');
    g.addColorStop(0.6, 'rgba(255,255,255,0.16)');
    g.addColorStop(0.85, 'rgba(255,255,255,0.32)');
    g.addColorStop(0.93, 'rgba(255,255,255,0.9)');
    g.addColorStop(0.95, 'rgba(255,255,255,0.9)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
  });
}
export const BUBBLE_RIM = 0.94;

/** A honeycomb of thin hex outlines faded out towards the bubble's rim (128 px across, same scale as `bubble`): the Bulwark's shield */
export function hexShield(): Texture {
  return paint('hexShield', 128, 128, (ctx) => {
    const R = 11, h = Math.sqrt(3) * R;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.4;
    for (let row = -1; row < 128 / h + 1; row++) {
      for (let col = -1; col < 128 / (R * 1.5) + 1; col++) {
        const cx = col * R * 1.5, cy = row * h + (col & 1 ? h / 2 : 0);
        ctx.beginPath();
        for (let k = 0; k < 6; k++) { const a = k * Math.PI / 3; const x = cx + R * Math.cos(a), y = cy + R * Math.sin(a); if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y); }
        ctx.closePath();
        ctx.stroke();
      }
    }
    // keep it inside the bubble, strongest nearer the rim
    ctx.globalCompositeOperation = 'destination-in';
    const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, 'rgba(255,255,255,0.15)');
    g.addColorStop(0.7, 'rgba(255,255,255,0.7)');
    g.addColorStop(0.93, 'rgba(255,255,255,0.9)');
    g.addColorStop(0.95, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
  });
}

/**
 * A headlight's beam: a cone from its apex at the left middle, fading with
 * distance and towards its sides. 256 × 128 px; the cone's edges reach the
 * texture's top and bottom at its right end. Anchor (0, 0.5).
 */
export function beam(): Texture {
  return paint('beam', 256, 128, (ctx) => {
    const img = ctx.createImageData(256, 128);
    for (let y = 0; y < 128; y++) {
      for (let x = 0; x < 256; x++) {
        const u = x / 255, v = Math.abs(y - 63.5) / 64;
        const side = v / Math.max(u, 0.01);
        if (side >= 1) continue;
        const across = 1 - Math.min(1, Math.max(0, (side - 0.45) / 0.55));
        const a = Math.pow(1 - u, 1.7) * across * across * Math.min(1, u * 25);
        const i = (y * 256 + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
        img.data[i + 3] = Math.round(a * 255);
      }
    }
    ctx.putImageData(img, 0, 0);
  });
}

/**
 * A screen vignette, white to be tinted: clear through the middle, darkening
 * towards the edges and most in the corners. 256 px square; stretch it over the screen.
 */
export function vignette(): Texture {
  return paint('vignette', 256, 256, (ctx) => {
    const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 181);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.5, 'rgba(255,255,255,0)');
    g.addColorStop(0.75, 'rgba(255,255,255,0.3)');
    g.addColorStop(1, 'rgba(255,255,255,1)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 256);
  });
}
