/**
 * Light tells (docs/bosses/rework-2026-11.md 2.4): what a boss shows on its hull before a move, and the look of its
 * window after, drawn by BossFx from `bossTelegraph` kinds. The same tell always means the same move. Shapes on the
 * ground (a lane, a landing circle) are kept thin and faint (about a third of the old warnings), only where the reach
 * can't be read from the boss itself; the tell is on the hull.
 *
 *   glow_green  a part glowing greyseam green, swelling (magnets humming, a throat, a core's pulse)
 *   glow_amber  a work lamp blinking (a crane's elbow, a brood rack)
 *   glow_white  white-hot (drives flaring, welder tips)
 *   glow_red    dull red heat (stacks or drives overheated: a window)
 *   chime       a spike's chime: a bright ring spreading off it
 *   smoke       black puffs off a stack or a vat
 *   steam       grey steam venting (breeches open, a throat choked: a window)
 *   sparks      sparks spitting (claws jammed, an arm overextended: a window)
 *   drip        white drips off cooling welders (a window)
 *   grind       rotors grinding up: a spinning ring
 *   glint       a hard white glint on a gun, a spike or a core: an aimed shot coming at where you are (any boss's
 *               light threat between its moves: sidestep)
 *   rivet, claw, intake, weld, crane, ram, sludge   the Scrap Mother's lanes and landing circle, thin and faint
 */
import type { Graphics } from 'pixi.js';
import { rayTerrain, type Terrain } from '@space-game/common';

const GLOW: Record<string, number> = { glow_green: 0x7affd2, glow_amber: 0xffa53a, glow_white: 0xeef8ff, glow_red: 0xff4a2a };
/** The lanes' colours (faint) */
const LANE: Record<string, number> = { rivet: 0xffd040, claw: 0xff3a1a, intake: 0x7affd2, weld: 0xc8fff0, crane: 0xffa53a, ram: 0xff6a2a };
/** How faint the ground shapes are, of the old warnings (2.4: about 35%) */
const FAINT = 0.35;

/** The sound a tell makes (sfx.ts ids), its volume and pitch; null: none of its own */
export function tellSound(kind: string): [string, number, number] | null {
  switch (kind) {
    case 'rivet': return ['gun_clack', 0.6, 0.8];
    case 'glow_green': return ['gun_charge', 0.6, 0.6];
    case 'glow_amber': return ['ui_click', 0.7, 0.5];
    case 'glow_white': return ['jump_charge', 0.6, 1.2];
    case 'chime': return ['laser_pulse', 0.5, 1.6];
    case 'smoke': return ['gun_vent', 0.6, 0.7];
    case 'grind': return ['gun_spin', 0.7, 0.6];
    case 'steam': case 'drip': return ['gun_vent', 0.4, 0.9];
    case 'sparks': return ['hit', 0.35, 0.7];
    case 'glint': return ['gun_clack', 0.4, 1.5];
    case 'glow_red': case 'crane': case 'ram': case 'claw': case 'intake': case 'weld': case 'sludge': return null;
  }
  return null;
}

/** Is this one of the kinds drawn here */
export function isTell(kind: string): boolean {
  return kind in GLOW || kind in LANE || ['chime', 'smoke', 'steam', 'sparks', 'drip', 'grind', 'sludge', 'glint'].includes(kind);
}

const hash = (i: number) => { const s = Math.sin(i * 127.1 + 31.7) * 43758.5453; return s - Math.floor(s); };

/**
 * Draw one: `at` its place (riding the body: the part, the body's angle), `age` and `life` seconds, `t` the clock. A
 * lane's `len` is cut at rock
 */
export function drawTell(g: Graphics, m: { kind: string; shape: string; radius?: number; angle?: number; length?: number; width?: number }, at: { x: number; y: number; angle: number },
  age: number, life: number, t: number, rock: Terrain | null): void {
  const k = Math.min(1, age / life), fadeIn = Math.min(1, age / 0.12), fadeOut = Math.min(1, (life - age) / 0.25), fade = fadeIn * fadeOut;
  const r = m.radius ?? 200, kind = m.kind;
  if (kind in GLOW) {
    const c = GLOW[kind];
    // (amber blinks; the rest swell as the moment comes)
    const pulse = kind === 'glow_amber' ? (Math.sin(t * 22) > 0 ? 1 : 0.25) : 0.55 + 0.45 * Math.sin(t * (kind === 'glow_red' ? 3 : 9));
    const swell = kind === 'glow_red' ? 1 : 0.6 + 0.4 * k;
    g.circle(at.x, at.y, r * 1.5 * swell).fill({ color: c, alpha: 0.07 * pulse * fade });
    g.circle(at.x, at.y, r * 0.8 * swell).fill({ color: c, alpha: 0.16 * pulse * fade });
    g.circle(at.x, at.y, r * 0.32).fill({ color: 0xffffff, alpha: (kind === 'glow_red' ? 0.05 : 0.3) * pulse * fade });
    return;
  }
  if (kind === 'chime') {
    // A ring spreading off the spike, twice
    for (let i = 0; i < 2; i++) {
      const ph = (k * 2 + i * 0.5) % 1;
      g.circle(at.x, at.y, r * (0.3 + 1.6 * ph)).stroke({ color: 0xc8fff0, width: 3, alpha: 0.6 * (1 - ph) * fade });
    }
    g.circle(at.x, at.y, r * 0.35).fill({ color: 0xc8fff0, alpha: 0.35 * fade });
    return;
  }
  if (kind === 'glint') {
    // A four-pointed star swelling to the moment it fires, a hard white core
    const s = r * (0.5 + 1.1 * k), a = t * 1.5;
    for (let i = 0; i < 4; i++) {
      const d = a + (i * Math.PI) / 2, ux = Math.cos(d), uy = Math.sin(d);
      g.moveTo(at.x - uy * s * 0.12, at.y + ux * s * 0.12).lineTo(at.x + ux * s, at.y + uy * s).lineTo(at.x + uy * s * 0.12, at.y - ux * s * 0.12).fill({ color: 0xffffff, alpha: (0.35 + 0.5 * k) * fade });
    }
    g.circle(at.x, at.y, r * 0.3).fill({ color: 0xffffff, alpha: (0.5 + 0.5 * k) * fade });
    return;
  }
  if (kind === 'grind') {
    // Rotors spinning up: arcs whirling faster
    const spin = t * (4 + 14 * k);
    for (let i = 0; i < 3; i++) {
      const a = spin + (i * Math.PI * 2) / 3;
      g.moveTo(at.x + Math.cos(a) * r, at.y + Math.sin(a) * r).arc(at.x, at.y, r, a, a + 1.1).stroke({ color: 0xd0d4d8, width: 4, alpha: 0.35 * fade });
    }
    return;
  }
  if (kind === 'smoke' || kind === 'steam' || kind === 'drip' || kind === 'sparks') {
    // Puffs off the part, rising and spreading (smoke black, steam grey); drips falling; sparks spitting
    const n = kind === 'sparks' ? 7 : 5;
    for (let i = 0; i < n; i++) {
      const rate = kind === 'sparks' ? 2.2 : kind === 'drip' ? 0.9 : 0.6, ph = (t * rate + hash(i)) % 1, a = hash(i + 7) * Math.PI * 2 + Math.floor(t * rate + hash(i)) * 2.1;
      const d = r * (kind === 'sparks' ? 0.2 + 1.4 * ph : 0.15 + 0.9 * ph), x = at.x + Math.cos(a) * d, y = at.y + Math.sin(a) * d;
      if (kind === 'sparks') g.moveTo(x, y).lineTo(x - Math.cos(a) * r * 0.25, y - Math.sin(a) * r * 0.25).stroke({ color: 0xffd080, width: 2.5, alpha: 0.8 * (1 - ph) * fade });
      else if (kind === 'drip') g.circle(x, y, r * 0.06).fill({ color: 0xf4fffb, alpha: 0.7 * (1 - ph) * fade });
      else g.circle(x, y, r * (0.18 + 0.32 * ph)).fill({ color: kind === 'smoke' ? 0x141210 : 0xb8bcc0, alpha: (kind === 'smoke' ? 0.5 : 0.22) * (1 - ph) * fade });
    }
    return;
  }
  if (kind === 'sludge') {
    // Where it lands: a faint disc, a thin rim, a closing ring
    const c = 0x9cff6a;
    g.circle(at.x, at.y, r).fill({ color: c, alpha: (0.04 + 0.08 * k) * fade });
    g.circle(at.x, at.y, r).stroke({ color: c, width: 2, alpha: (0.18 + 0.3 * k) * fade });
    g.circle(at.x, at.y, r * (1 + (1 - k) * 1.0)).stroke({ color: 0xd8ffc0, width: 1.5, alpha: (0.1 + 0.3 * k) * fade });
    return;
  }
  // A lane: two thin edges and a faint fill, stopping at rock, brighter as it comes; no chevrons
  const c = LANE[kind] ?? 0xffd040, a = at.angle + (m.angle ?? 0), half = (m.width ?? 80) / 2;
  const full = m.length ?? 1000, ux = Math.cos(a), uy = Math.sin(a);
  const len = full * rayTerrain(rock, at.x, at.y, at.x + ux * full, at.y + uy * full);
  const start = kind === 'crane' ? CRANE_BITE : 0, sx = at.x + ux * len * start, sy = at.y + uy * len * start;
  const ex = at.x + ux * len, ey = at.y + uy * len, nx = -uy * half, ny = ux * half;
  const ramp = (0.35 + 0.65 * k * k) * FAINT * fade;
  g.poly([sx + nx, sy + ny, ex + nx, ey + ny, ex - nx, ey - ny, sx - nx, sy - ny]).fill({ color: c, alpha: 0.18 * ramp });
  g.moveTo(sx + nx, sy + ny).lineTo(ex + nx, ey + ny).stroke({ color: c, width: 2, alpha: 0.9 * ramp });
  g.moveTo(sx - nx, sy - ny).lineTo(ex - nx, ey - ny).stroke({ color: c, width: 2, alpha: 0.9 * ramp });
}

/**
 * The crane's swing (a bossBeam 'crane', drawn instead of a beam): the arm out from her across her front, a three-fingered
 * claw at its end, the band it hits (from CRANE_BITE of its reach out) lit faint amber, and a faint trail where it has
 * swept (drawn into BossFx's additive layer: pale steel, not dark). `at` is her middle and heading; `k` how far through the swing (0..1)
 */
export function drawCraneLash(g: Graphics, m: { a0: number; a1: number; length: number; width: number }, at: { x: number; y: number; angle: number }, k: number, fade: number): void {
  const a = at.angle + m.a0 + (m.a1 - m.a0) * k, dir = Math.sign(m.a1 - m.a0) || 1, L = m.length, s0 = L * CRANE_BITE;
  const ux = Math.cos(a), uy = Math.sin(a), nx = -uy, ny = ux;
  // The trail: the last bit of the sweep, a faint amber fan over the band it hits
  const back = a - dir * 0.32, steps = 8, fan: number[] = [];
  for (let i = 0; i <= steps; i++) { const t = back + ((a - back) * i) / steps; fan.push(at.x + Math.cos(t) * L, at.y + Math.sin(t) * L); }
  for (let i = steps; i >= 0; i--) { const t = back + ((a - back) * i) / steps; fan.push(at.x + Math.cos(t) * s0, at.y + Math.sin(t) * s0); }
  g.poly(fan).fill({ color: 0xffa53a, alpha: 0.07 * fade });
  // The band it hits, lit
  g.moveTo(at.x + ux * s0, at.y + uy * s0).lineTo(at.x + ux * L, at.y + uy * L).stroke({ color: 0xffa53a, width: m.width, alpha: 0.12 * fade });
  // The arm: dark steel from her hull out, a sheen down it
  const r0 = s0 * 0.45;
  g.moveTo(at.x + ux * r0, at.y + uy * r0).lineTo(at.x + ux * (L - 120), at.y + uy * (L - 120)).stroke({ color: 0x5a5650, width: 80, alpha: 0.55 * fade });
  g.moveTo(at.x + ux * r0 + nx * 14, at.y + uy * r0 + ny * 14).lineTo(at.x + ux * (L - 120) + nx * 14, at.y + uy * (L - 120) + ny * 14).stroke({ color: 0x9a9da2, width: 14, alpha: 0.7 * fade });
  // Hazard bands near its end
  for (let s = L - 520; s < L - 160; s += 120) g.moveTo(at.x + ux * s + nx * 40, at.y + uy * s + ny * 40).lineTo(at.x + ux * (s + 50) - nx * 40, at.y + uy * (s + 50) - ny * 40).stroke({ color: 0xc9a23a, width: 26, alpha: 0.8 * fade });
  // The claw: three fingers splayed at its end
  const cx = at.x + ux * (L - 100), cy = at.y + uy * (L - 100);
  for (const f of [-0.55, 0, 0.55]) {
    const fa = a + f, fx = Math.cos(fa), fy = Math.sin(fa), w = m.width * 0.16;
    g.poly([cx - fy * w, cy + fx * w, cx + fx * m.width * 0.75, cy + fy * m.width * 0.75, cx + fy * w, cy - fx * w]).fill({ color: 0x6a6258, alpha: 0.6 * fade }).stroke({ color: 0xffb060, width: 6, alpha: 0.8 * fade });
  }
  g.circle(cx, cy, m.width * 0.22).fill({ color: 0x6a6258, alpha: 0.6 * fade });
  g.circle(cx, cy, m.width * 0.08).fill({ color: 0xffa53a, alpha: 0.9 * fade });
}

/** The crane's swing (a bossBeam 'crane'): its claw bites from this share of its reach out (server brains/scrapMother.ts the same) */
export const CRANE_BITE = 0.52;
/** Its lash's colours */
export const CRANE_BEAM = { halo: 0x8a4a1a, glow: 0xff8a2a, body: 0xffb060, core: 0xfff0d0, flare: 0xffa53a, hot: 0xffe8c0 };
