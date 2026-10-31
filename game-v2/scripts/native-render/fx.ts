/**
 * Engine flames, exhaust and headlight beams as textured quads (the native counterpart of ThrusterFx.draw / plume and
 * ShipRenderer.updateLamps), for one ship at rest: engines settled at the throttle the viewer's params ask for, the exhaust a
 * seeded run of the game's particle rules, left to reach its steady state. All in the ship's own frame (pixels, about its
 * centre of mass), drawn under the hull. The textures themselves are painted by the GL worker (gl_worker.py) from the
 * names used here.
 */

import { mulberry32 } from '@space-game/common';
import { PAL, hsl, hueOf } from '../../client/src/ships/ThrusterFx';
import { PLUME_ANCHOR, plumeKey, plumeScale } from '../../client/src/rendering/fxTextures';
import { engineLookOf, plumeSpec, puffFlicker, sailRing } from '../../client/src/ships/engineLooks';
import type { Draw } from './scene';

/** One engine: its part's model (its look), its thrust direction (grid frame) and where its flames start */
export interface Engine { index: number; fn?: string; f: [number, number]; nozzles: { mx: number; my: number; n: [number, number]; t: [number, number]; edge: number }[] }

export interface FxParams { flames: number; boost: boolean; exhaust: boolean }

const DOT = 64;
/** A flame in one hue (ThrusterFx.flameFor): the textures' names, the inner colour (the idle glow), the engines' light */
function flameFor(tint: number | undefined): { body: string; inner: number; light: number } {
  const h = tint === undefined ? null : hueOf(tint);
  if (h === null) return { body: `plume:${PAL.outer}:${PAL.inner}:${PAL.glow}`, inner: PAL.inner, light: 0x5a9bff };
  const k = (Math.round(h / 10) * 10) % 360;
  const outer = hsl(k, 0.95, 0.6), inner = hsl(k, 0.9, 0.85), glow = hsl(k, 1, 0.45);
  return { body: `plume:${outer}:${inner}:${glow}`, inner, light: hsl(k, 0.9, 0.65) };
}

const rgb = (c: number): [number, number, number] => [((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255];

/** Quads of one texture and blend */
class Quads {
  pos: number[] = []; uv: number[] = []; col: number[] = []; idx: number[] = [];
  /** A w × h sprite anchored at (ax, ay) (fractions), at (px, py), turned by r; its colour × alpha as Pixi premultiplies a tint */
  sprite(px: number, py: number, w: number, h: number, ax: number, ay: number, r: number, tint: number, alpha: number): void {
    const c = Math.cos(r), s = Math.sin(r), base = this.pos.length / 2, [tr, tg, tb] = rgb(tint);
    const corners: [number, number][] = [[-ax * w, -ay * h], [w - ax * w, -ay * h], [w - ax * w, h - ay * h], [-ax * w, h - ay * h]];
    const uvs = [0, 0, 1, 0, 1, 1, 0, 1];
    corners.forEach(([x, y], i) => {
      this.pos.push(px + c * x - s * y, py + s * x + c * y);
      this.uv.push(uvs[i * 2], uvs[i * 2 + 1]);
      this.col.push(tr * alpha, tg * alpha, tb * alpha, alpha);
    });
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  draw(tex: string, blend: 'add' | 'normal'): Draw {
    return {
      kind: 'sprite', tex, blend, glow: true, idx: new Uint32Array(this.idx),
      attrs: { aPosition: { data: new Float32Array(this.pos), size: 2 }, aUV: { data: new Float32Array(this.uv), size: 2 }, aColor: { data: new Float32Array(this.col), size: 4 } },
    };
  }
}

export interface Fx { draws: Draw[]; /** The engines' light on the hull and what's near: ship frame, as Lighting.point takes it */ light: { x: number; y: number; radius: number; power: number; color: number; height: number } | null }

/**
 * `id`: the ship's number in the viewer (seeds its flicker, as ThrusterFx does); `time`: seconds the engines have run (the
 * flicker's phase); `thrust`: the way the viewer drives it (grid frame, unit)
 */
export function flames(engines: Engine[], thrust: [number, number], cs: number, tint: number | undefined, p: FxParams, id: number, time = 1.5): Fx {
  const quads = new Map<string, Quads>();
  const q = (tex: string, blend: 'add' | 'normal' = 'add') => {
    const k = `${tex}|${blend}`;
    let v = quads.get(k);
    if (!v) quads.set(k, (v = new Quads()));
    return v;
  };
  const flame = flameFor(tint);
  const boost = p.boost ? 1 : 0;
  // The command the viewer gives: its thrust direction × flames
  const mag = p.flames, ux = thrust[0], uy = thrust[1], seed0 = (id * 7.31) % 100;
  let gx = 0, gy = 0, gp = 0;
  const sparks: { x: number; y: number; n: [number, number]; thr: number; edge: number; look: ReturnType<typeof engineLookOf> }[] = [];
  for (const e of engines) {
    const f = Math.hypot(e.f[0], e.f[1]);
    const look = engineLookOf(e.fn ?? '');
    let want = Math.max(0, (e.f[0] / f) * ux + (e.f[1] / f) * uy) * Math.min(1, mag);
    want = want > 0.12 ? want : 0;
    const thr = want, seed = seed0 + e.index * 1.7;
    for (const nz of e.nozzles) {
      const { mx, my, edge } = nz, [nx, ny] = nz.n, [tx, ty] = nz.t;
      const w = edge * 0.42;
      // Idle: a faint glow in the nozzle
      if (look.kind === 'plume') q('white').sprite(mx, my, w * 2, Math.max(1.5, cs * 0.18), 0.5, 0.5, Math.atan2(ty, tx), look.pal ? look.pal.inner : flame.inner, 0.18 + 0.6 * thr);
      if (look.kind === 'puff' && thr >= 0.03) {
        // Cold gas: blinking white puffs (ThrusterFx.plume)
        const f = puffFlicker(time, seed) * Math.min(1, thr * 1.5);
        if (f > 0) {
          const d = (edge * 1.1);
          q('puff').sprite(mx + nx * cs * 0.3, my + ny * cs * 0.3, d * (0.8 + 0.4 * f), d * (0.8 + 0.4 * f), 0.5, 0.5, 0, 0xf2f7ff, 0.85 * f);
          q('puff').sprite(mx + nx * cs * 0.85, my + ny * cs * 0.85, d * (1.3 + 0.5 * f), d * (1.3 + 0.5 * f), 0.5, 0.5, 0, 0xc9d6e6, 0.4 * f);
        }
      } else if (look.kind === 'sail') {
        const r = sailRing(time, seed, thr), k = edge / 28, ring = (cx: number, cy: number, s: number, tint: number, a: number) => q('ring').sprite(cx, cy, 64 * s, 64 * s, 0.5, 0.5, 0, tint, a);
        ring(mx + nx * cs * 0.6, my + ny * cs * 0.6, k * r.r * 0.9, 0x9fd4ff, r.a);
        ring(mx + nx * cs * 1.0, my + ny * cs * 1.0, k * r.r2 * 1.3, 0xc8e6ff, r.a2);
        const g = edge * 2.4;
        q('puff').sprite(mx + nx * cs * 0.8, my + ny * cs * 0.8, g, g, 0.5, 0.5, 0, 0x6aa8ff, 0.16 + 0.3 * thr);
      } else if (thr >= 0.03) {
        const sp = plumeSpec(look, thr, boost, edge, cs, time, seed), rot = Math.atan2(ny, nx), sc = plumeScale(sp.L, sp.w);
        const sw = 256 * sc.x, sh = 128 * sc.y;
        q(sp.pal ? plumeKey(sp.pal.outer, sp.pal.inner, sp.pal.glow, sp.pal.shape) : flame.body).sprite(mx, my, sw, sh, PLUME_ANCHOR.x, PLUME_ANCHOR.y, rot, 0xffffff, thr);
        q('plume:core').sprite(mx, my, sw * sp.coreLen, sh * sp.coreWidth, PLUME_ANCHOR.x, PLUME_ANCHOR.y, rot, 0xffffff, Math.min(1, thr * 1.4));
        if (sp.diamonds > 0) q('plume:diamonds').sprite(mx, my, sw, sh, PLUME_ANCHOR.x, PLUME_ANCHOR.y, rot, 0xffffff, sp.diamonds);
      }
      const lp = thr * (edge / cs);
      if (lp > 0) { gx += (mx + nx * cs) * lp; gy += (my + ny * cs) * lp; gp += lp; sparks.push({ x: mx, y: my, n: nz.n, thr, edge, look }); }
      else if (thr > 0.25) sparks.push({ x: mx, y: my, n: nz.n, thr, edge, look });
    }
  }

  // Exhaust: the game's rules (ThrusterFx.draw / beginFrame), run at 60 Hz for a second from a seeded start, the ship still
  if (p.exhaust && engines.length) {
    const rnd = mulberry32(1013 + id * 7919);
    interface Spark { x: number; y: number; vx: number; vy: number; life: number; max: number; size: number; hot: boolean; tint: [number, number, number] }
    let list: Spark[] = [];
    const dt = 1 / 60, MAX = 900;
    for (let frame = 0; frame < 90; frame++) {
      // age (beginFrame), then spawn (draw)
      list = list.filter((s) => {
        s.life -= dt;
        if (s.life <= 0) return false;
        s.x += s.vx * dt; s.y += s.vy * dt; s.vx *= 0.97; s.vy *= 0.97;
        return true;
      });
      for (const s of sparks) {
        if (s.thr <= 0.25 || list.length >= MAX) continue;
        const [nx, ny] = s.n, tx = -ny, ty = nx;
        const bg = s.look.boostGain > 0 ? 1 : 0;
        let count = s.thr * (s.edge / cs) * (1 + boost * bg) * 38 * s.look.motes * dt;
        while (count > 0) {
          if (count < 1 && rnd() > count) break;
          count -= 1;
          const off = (rnd() - 0.5) * s.edge * 0.7;
          const speed = (220 + rnd() * 180) * (1 + boost * 0.6 * bg) * (0.6 + 0.4 * s.thr) * s.look.moteSpeed, life = 0.25 + rnd() * 0.45;
          list.push({
            x: s.x + tx * off + nx * cs * 0.3, y: s.y + ty * off + ny * cs * 0.3,
            vx: nx * speed + (rnd() - 0.5) * 40, vy: ny * speed + (rnd() - 0.5) * 40,
            life, max: life, size: (s.edge * 0.11 + 1.2) * (0.7 + rnd() * 0.6), hot: rnd() < 0.35, tint: s.look.moteTint,
          });
        }
      }
    }
    // (the soft dot, scaled so a particle is r × 4.4 across; hot sparks cool from white-blue to deep blue as they age)
    for (const s of list) {
      const k = s.life / s.max, r = s.size * (0.6 + 0.9 * (1 - k)), side = r * 2.2 * 2;
      q('dot:0.45:0.07').sprite(s.x, s.y, side, side, 0.5, 0.5, 0, k > 0.6 ? s.tint[0] : k > 0.3 ? s.tint[1] : s.tint[2], (s.hot ? 0.75 : 0.5) * k);
    }
  }

  const light = gp > 0 ? { x: gx / gp, y: gy / gp, radius: 110 + 70 * Math.min(4, gp), power: Math.min(1.3, 0.35 * gp) * (1 + 0.5 * boost), color: boost > 0.5 ? 0x9a7bff : flame.light, height: 40 } : null;
  // (exhaust first, as the game layers it, then the nozzles)
  const order = [...quads.entries()].sort((a, b) => Number(b[0].startsWith('dot')) - Number(a[0].startsWith('dot')));
  return { draws: order.map(([k, v]) => v.draw(k.split('|')[0], k.split('|')[1] as 'add' | 'normal')), light };
}

/** A headlight's beam (ShipRenderer.updateLamps, fully on): forward is -y in the ship's frame */
export function beam(radius: number, env: number): Draw {
  const len = 1500 + radius * 4, q = new Quads();
  q.sprite(0, -radius * 0.9, len, len * Math.tan(0.4) * 2, 0, 0.5, -Math.PI / 2, 0xfff0d6, 0.1 * Math.max(0.3, 1 - env / 0.5));
  return q.draw('beam', 'normal');
}

export const DOT_PX = DOT;
