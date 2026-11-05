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
import {
  engineLookOf, initMote, moteAlpha, moteRadius, moteRate, moteTint, newMote, newNozzleDraw, nozzleDraw, stepMote,
  BOOST_LIGHT, PLUME_SLOT, SLOTS, SLOT_TEX, type Mote, type SlotTex,
} from '../../client/src/ships/engineLooks';
import type { Draw } from './scene';

/** One engine: its part's model (its look), its thrust direction (grid frame) and where its flames start */
export interface Engine { index: number; fn?: string; f: [number, number]; nozzles: { mx: number; my: number; n: [number, number]; t: [number, number]; edge: number }[] }

export interface FxParams { flames: number; boost: boolean; exhaust: boolean; frost?: boolean }

const DOT = 64;
/** The GL worker's texture name for each slot texture (the body's is the palette's, or the tinted flame's) */
const TEX_NAME: Record<Exclude<SlotTex, 'body'>, string> = { white: 'white', core: 'plume:core', diamonds: 'plume:diamonds', puff: 'puff', ring: 'ring' };
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
  let gx = 0, gy = 0, gp = 0, top = 0, color = flame.light, boostColor = BOOST_LIGHT;
  const sparks: { x: number; y: number; n: [number, number]; t: [number, number]; thr: number; edge: number; pulse: number; look: ReturnType<typeof engineLookOf> }[] = [];
  const d = newNozzleDraw();
  for (const e of engines) {
    const f = Math.hypot(e.f[0], e.f[1]);
    const look = engineLookOf(e.fn ?? '');
    let want = Math.max(0, (e.f[0] / f) * ux + (e.f[1] / f) * uy) * Math.min(1, mag);
    want = want > 0.12 ? want : 0;
    const thr = want, seed = seed0 + e.index * 1.7;
    for (const nz of e.nozzles) {
      const { mx, my, edge } = nz, [nx, ny] = nz.n, [tx, ty] = nz.t;
      // The nozzle's layers (engineLooks.nozzleDraw), every slot placed as ThrusterFx.plume places it
      nozzleDraw(d, look, thr, boost, edge, cs, time, seed, flame.inner, p.frost ? 1 : 0);
      const rot = Math.atan2(ny, nx);
      for (const slot of SLOTS) {
        const l = d[slot];
        if (!l.on) continue;
        const px = mx + nx * l.a + tx * l.s, py = my + ny * l.a + ty * l.s, tex = SLOT_TEX[slot];
        const name = tex === 'body' ? (d.pal ? plumeKey(d.pal.outer, d.pal.inner, d.pal.glow, d.pal.shape) : flame.body) : TEX_NAME[tex];
        if (PLUME_SLOT[slot]) {
          const sc = plumeScale(l.len, l.wid);
          q(name).sprite(px, py, 256 * sc.x, 128 * sc.y, PLUME_ANCHOR.x, PLUME_ANCHOR.y, rot + l.rot, l.tint, l.alpha);
        } else q(name).sprite(px, py, l.len, l.wid, 0.5, 0.5, rot + l.rot, l.tint, l.alpha);
      }
      const lp = thr * (edge / cs);
      if (lp > 0) {
        gx += (mx + nx * cs) * lp; gy += (my + ny * cs) * lp; gp += lp;
        if (lp > top) { top = lp; color = look.light ?? look.pal?.outer ?? flame.light; boostColor = look.boostPal?.outer ?? look.light ?? BOOST_LIGHT; }
      }
      if (thr > 0.25) sparks.push({ x: mx, y: my, n: nz.n, t: nz.t, thr, edge, pulse: d.pulse, look });
    }
  }

  // Exhaust: the game's rules (ThrusterFx.draw / beginFrame), run at 60 Hz for a second from a seeded start, the ship still
  if (p.exhaust && engines.length) {
    const rnd = mulberry32(1013 + id * 7919);
    let list: Mote[] = [];
    const dt = 1 / 60, MAX = 900;
    for (let frame = 0; frame < 90; frame++) {
      // age (beginFrame), then spawn (draw)
      list = list.filter((s) => stepMote(s, dt));
      for (const s of sparks) {
        let count = list.length < MAX ? moteRate(s.look, s.thr, boost, s.edge, cs, s.pulse) * dt : 0;
        while (count > 0 && list.length < MAX) {
          if (count < 1 && rnd() > count) break;
          count -= 1;
          list.push(initMote(newMote(), s.look, s.thr, boost, s.edge, cs, p.frost ? 1 : 0, rnd, s.x, s.y, s.n[0], s.n[1], s.t[0], s.t[1], 0, 0));
        }
      }
    }
    // (the soft dot, scaled so a particle is r × 4.4 across)
    for (const s of list) {
      const side = moteRadius(s) * 2.2 * 2;
      q('dot:0.45:0.07').sprite(s.x, s.y, side, side, 0.5, 0.5, 0, moteTint(s), moteAlpha(s));
    }
  }

  const light = gp > 0 ? { x: gx / gp, y: gy / gp, radius: 110 + 70 * Math.min(4, gp), power: Math.min(1.3, 0.35 * gp) * (1 + 0.5 * boost), color: boost > 0.5 ? boostColor : color, height: 40 } : null;
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
