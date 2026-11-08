/**
 * Drawing for shaped shields (see index.ts). All of a frame's shields go into one Graphics, cleared once a frame. A live
 * shield is a glowing line or arc with a bright edge; the quick kind is cyan and the deep kind amber (the Lab's colours);
 * its glow thins as its HP drops. A shot striking it throws a ripple that rides with the ship (kept as a place on the
 * shield, not in the world). A shield that breaks flickers, then shows as a dashed outline until it is back.
 */
import type { Graphics } from 'pixi.js';
import { localToWorldDir, shieldHp, shapedOf, type ShapedShield } from '@space-game/common';
import type { ShipDrawCtx } from '../types';

const QUICK = { col: 0x5fd8ff, hot: 0xe2f9ff };
const DEEP = { col: 0xffb04a, hot: 0xffe6bd };
/** How long a ripple lives, a break's flicker, and the dashes (ms, ms, world units at 24 a cell) */
const RIPPLE_MS = 550, FLICKER_MS = 600;
/** A strike this near (cells) to a shield is on it */
const NEAR_CELLS = 1.1;

/** One shield as drawn this frame, in the world */
interface Shape {
  key: number;
  wall: boolean;
  /** A wall's ends / an arc's centre, and its radius, middle angle and half span (world, radians) */
  ax: number; ay: number; bx: number; by: number;
  cx: number; cy: number; r: number; mid: number; half: number;
  /** Cell size, for the tolerance */
  cs: number;
  /** Not down (a strike on a down shield is not on it) */
  up: boolean;
}

interface Ripple { key: number; at: number; t0: number }
interface Mem { level: number; brokeAt: number }

const shapes: Shape[] = [];
let used = 0;
const ripples: Ripple[] = [];
const mem = new Map<number, Mem>();

export function resetShapedFrame(): void {
  used = 0;
}

const keyOf = (eid: number, i: number) => eid * 16 + i;

function shapeAt(): Shape {
  if (used === shapes.length) shapes.push({ key: 0, wall: true, ax: 0, ay: 0, bx: 0, by: 0, cx: 0, cy: 0, r: 0, mid: 0, half: 0, cs: 24, up: true });
  return shapes[used++];
}

/** A shield's geometry in the world, for a ship at its drawn pose */
function place(out: Shape, s: ShapedShield, ctx: ShipDrawCtx, key: number): void {
  const { ship, entity, cs } = ctx, com = ship.derived.com, ang = entity.renderAngle;
  const pt = (gx: number, gy: number): [number, number] => {
    const w = localToWorldDir([(gx - com[0]) * cs, (gy - com[1]) * cs], ang);
    return [entity.renderX + w[0], entity.renderY + w[1]];
  };
  out.key = key; out.cs = cs; out.wall = s.kind === 'wall';
  if (out.wall) {
    const a = pt(s.ax, s.ay), b = pt(s.bx, s.by);
    out.ax = a[0]; out.ay = a[1]; out.bx = b[0]; out.by = b[1];
  } else {
    const c = pt(s.cx, s.cy), n = localToWorldDir([s.dx, s.dy], ang);
    out.cx = c[0]; out.cy = c[1]; out.r = s.r * cs; out.mid = Math.atan2(n[1], n[0]); out.half = s.half;
  }
}

function trace(g: Graphics, s: Shape): void {
  if (s.wall) { g.moveTo(s.ax, s.ay).lineTo(s.bx, s.by); return; }
  g.moveTo(s.cx + Math.cos(s.mid - s.half) * s.r, s.cy + Math.sin(s.mid - s.half) * s.r).arc(s.cx, s.cy, s.r, s.mid - s.half, s.mid + s.half);
}

/** A dashed outline: short strokes along the shield */
function dashed(g: Graphics, s: Shape, w: number, col: number, alpha: number): void {
  const dash = s.cs * 0.22, n = s.wall ? Math.max(2, Math.round(Math.hypot(s.bx - s.ax, s.by - s.ay) / (dash * 2))) : Math.max(4, Math.round((s.r * 2 * s.half) / (dash * 2)));
  for (let i = 0; i < n; i++) {
    const u0 = i / n, u1 = (i + 0.5) / n;
    if (s.wall) g.moveTo(s.ax + (s.bx - s.ax) * u0, s.ay + (s.by - s.ay) * u0).lineTo(s.ax + (s.bx - s.ax) * u1, s.ay + (s.by - s.ay) * u1);
    else {
      const a0 = s.mid - s.half + 2 * s.half * u0, a1 = s.mid - s.half + 2 * s.half * u1;
      g.moveTo(s.cx + Math.cos(a0) * s.r, s.cy + Math.sin(a0) * s.r).arc(s.cx, s.cy, s.r, a0, a1);
    }
  }
  g.stroke({ width: w, color: col, alpha });
}

/** Draw every shield of one ship (called from the feature's drawShip, after the ship's levels were read in) */
export function drawShapedShields(g: Graphics, ctx: ShipDrawCtx, packed: number, levelOf: (v: number, i: number) => number): void {
  const list = shapedOf(ctx.ship), k = ctx.cs / 24, now = ctx.now, base = used;
  for (let i = 0; i < list.length && i < 8; i++) {
    const s = list[i], key = keyOf(ctx.eid, i), level = levelOf(packed, i), look = s.deep ? DEEP : QUICK;
    let m = mem.get(key);
    if (!m) mem.set(key, (m = { level, brokeAt: -1e9 }));
    // A shield that was up and is down: it flickers as it breaks
    if (m.level > 0 && level === 0) m.brokeAt = now;
    m.level = level;
    const sh = shapeAt();
    place(sh, s, ctx, key);
    sh.up = level > 0;
    if (level === 0) {
      const since = now - m.brokeAt;
      if (since < FLICKER_MS) {
        const a = (Math.sin(now * 0.09) > 0 ? 0.85 : 0.1) * (1 - since / FLICKER_MS);
        trace(g, sh); g.stroke({ width: 6 * k, color: look.col, alpha: a * 0.5 });
        trace(g, sh); g.stroke({ width: 2 * k, color: look.hot, alpha: a });
      } else dashed(g, sh, 1.5 * k, look.col, 0.2);
      continue;
    }
    const a = 0.4 + 0.6 * (shieldHp(ctx.ship, i) / s.cap);
    if (!sh.wall) {
      // (the arc's translucent body)
      g.moveTo(sh.cx, sh.cy).lineTo(sh.cx + Math.cos(sh.mid - sh.half) * sh.r, sh.cy + Math.sin(sh.mid - sh.half) * sh.r)
        .arc(sh.cx, sh.cy, sh.r, sh.mid - sh.half, sh.mid + sh.half).closePath().fill({ color: look.col, alpha: a * 0.07 });
    }
    trace(g, sh); g.stroke({ width: 14 * k, color: look.col, alpha: a * 0.1 });
    trace(g, sh); g.stroke({ width: 6.5 * k, color: look.col, alpha: a * 0.22 });
    trace(g, sh); g.stroke({ width: 2 * k, color: look.hot, alpha: a * 0.9 });
    if (sh.wall) {
      g.circle(sh.ax, sh.ay, 2.6 * k).fill({ color: look.hot, alpha: a });
      g.circle(sh.bx, sh.by, 2.6 * k).fill({ color: look.hot, alpha: a });
    }
  }
  // Ripples on this ship's shields
  for (let r = ripples.length - 1; r >= 0; r--) {
    const rp = ripples[r], age = now - rp.t0;
    if (age >= RIPPLE_MS) { ripples.splice(r, 1); continue; }
    if (Math.floor(rp.key / 16) !== ctx.eid) continue;
    const i = rp.key % 16, s = list[i];
    if (!s) continue;
    const sh = i < 8 ? shapes[base + i] : undefined;
    if (!sh || sh.key !== rp.key) continue;
    const q = 1 - age / RIPPLE_MS, look = s.deep ? DEEP : QUICK;
    let hx: number, hy: number;
    if (sh.wall) { hx = sh.ax + (sh.bx - sh.ax) * rp.at; hy = sh.ay + (sh.by - sh.ay) * rp.at; }
    else { hx = sh.cx + Math.cos(sh.mid + rp.at) * sh.r; hy = sh.cy + Math.sin(sh.mid + rp.at) * sh.r; }
    const rad = (10 + (age / 1000) * 260) * k;
    g.circle(hx, hy, (3 + 7 * q) * k).fill({ color: look.hot, alpha: q * 0.8 });
    g.circle(hx, hy, rad * 0.5).stroke({ width: 1.5 * k, color: look.col, alpha: q * 0.5 });
  }
}

/**
 * A shell struck at world (x, y): the live shield it is on (if any) takes a ripple there. Looks over the shields as last drawn.
 * Returns whether one was found (the bubble's own ripple is then not needed)
 */
export function noteShapedHit(x: number, y: number): boolean {
  let best = -1, bd = Infinity, bu = 0;
  for (let i = 0; i < used; i++) {
    const s = shapes[i];
    if (!s.up) continue;
    let d: number, u: number;
    if (s.wall) {
      const ex = s.bx - s.ax, ey = s.by - s.ay, l2 = ex * ex + ey * ey || 1;
      u = Math.max(0, Math.min(1, ((x - s.ax) * ex + (y - s.ay) * ey) / l2));
      d = Math.hypot(x - (s.ax + ex * u), y - (s.ay + ey * u));
    } else {
      let rel = Math.atan2(y - s.cy, x - s.cx) - s.mid;
      while (rel > Math.PI) rel -= 2 * Math.PI;
      while (rel < -Math.PI) rel += 2 * Math.PI;
      u = Math.max(-s.half, Math.min(s.half, rel));
      d = Math.hypot(x - (s.cx + Math.cos(s.mid + u) * s.r), y - (s.cy + Math.sin(s.mid + u) * s.r));
    }
    if (d < bd && d <= s.cs * NEAR_CELLS) { bd = d; best = i; bu = u; }
  }
  if (best < 0) return false;
  ripples.push({ key: shapes[best].key, at: bu, t0: performance.now() });
  if (ripples.length > 64) ripples.splice(0, ripples.length - 64);
  return true;
}
