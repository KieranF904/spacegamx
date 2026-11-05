/**
 * What a boss warns you of, and its sweeping beam (server: brains/kit.ts):
 *
 *   line     a lane on the ground, brightening to the moment it lands, with
 *            chevrons running down it the way it'll go: red for a charge or a
 *            beam's start (get out of it), orange for a dash (where it's off to)
 *   circle   where a shell comes down: a faint disc, its rim, and a ring
 *            closing in on the rim as the moment comes
 *   magma    a ball of magma swelling on a turret (riding the body), embers
 *            drawn into it, until it's hurled
 *   beam     a boss's lance, burning from its prow and sweeping (or its
 *            heart's crystal: hotter, yellow-white)
 *
 * The Pyreclast's heart warns in magma's hotter colours (yellow-white, over
 * the lance's red): its crystal's beams ('crystal'), its wires' marks
 * ('synapse'), its core gathering ('ring'); its vents opening ('vent') in
 * amber, round it.
 *
 * Lines and beams ride the boss's body (its drawn pose), so they turn with it.
 */

import { Container, Graphics } from 'pixi.js';
import { rayTerrain, type ServerBossBeamMessage, type ServerBossTelegraphMessage, type ServerBossWindowMessage } from '@space-game/common';
import { terrainFor } from '../rendering/terrainData';
import type { GameState } from '../state/GameState';
import { CRANE_BEAM, CRANE_BITE, WARN_GAP_DEFAULT_MS, WARN_GAP_MS, drawCraneLash, drawTell, isTell, tellSound, warnSound } from './bossTells';
import { BossExposure } from './bossExposure';

const COLOR: Record<string, number> = { charge: 0xff2a1a, lance: 0xff2a1a, dash: 0xff9a2a, impact: 0xff6a1a, crystal: 0xffc040, synapse: 0xffd060, ring: 0xffe0a0, vent: 0xffb040,
  // (the Scrap Mother's: hazard yellow for her guns, greyseam green for what pulls, pools and burns)
  rivet: 0xffd040, claw: 0xff3a1a, intake: 0x7affd2, sludge: 0x9cff6a, weld: 0xc8fff0, gather: 0xc8fff0,
  // (the Pyreclast's rework: a broadside's lanes, a scythe drawing back, a pilot's own lob, flak and spark: each its own)
  lane: 0xff5030, scythe: 0xd84a2a, lob: 0xff8040, flak: 0xffb870, spark: 0xfff0c0, seams: 0xff9a50 };
/** A burning pool's colours: its disc, its heart, its bubbles (greyseam sludge, or ground left burning by magma) */
const POOL: Record<string, { disc: number; heart: number; bubble: number }> = {
  pool: { disc: 0x3aa048, heart: 0x9cff6a, bubble: 0xd8ffc0 }, embers: { disc: 0xa02a0a, heart: 0xff7a2a, bubble: 0xffd0a0 },
};
/** A beam's colours, outermost glow in: a molten lance, or a heart's crystal */
const BEAM: Record<string, { halo: number; glow: number; body: number; core: number; flare: number; hot: number }> = {
  lance: { halo: 0xff3a0a, glow: 0xff6a1a, body: 0xffa040, core: 0xfff4e0, flare: 0xff8a3a, hot: 0xfff0d0 },
  crystal: { halo: 0xff5a0a, glow: 0xff9a1a, body: 0xffd060, core: 0xfffbe8, flare: 0xffb040, hot: 0xfff6d8 },
  weld: { halo: 0x1aa080, glow: 0x3affc0, body: 0x9affe0, core: 0xf4fffb, flare: 0x6affd0, hot: 0xeafff8 },
  crane: CRANE_BEAM,
  // (the Pyreclast's scythe: a molten blade swept round it, drawn only over its reach)
  scythe: { halo: 0x8a1a0a, glow: 0xd8401a, body: 0xff7a3a, core: 0xffd8b0, flare: 0xff6a2a, hot: 0xffe0c0 },
};
/** A scythe's blade: the outer stretch of its beam (server brains/pyreclast.ts SCYTHE_FAR - SCYTHE_NEAR); inside it, nothing */
const SCYTHE_BLADE = 2500;
/** The lance's charge sound's length to its fire (sfx.ts boss_charge): played faster for a shorter charge */
const CHARGE_SOUND = 2.7;
/** The same for a magma ball's swelling (sfx.ts magma_charge) */
const MAGMA_SOUND = 0.85;
/** How big a magma ball grows on its turret (world units: about the size it flies at) */
const MAGMA_R = 46;
/** A lance's burn is heard (not placed: it's as long as the arena) this far from the boss, fading */
const BEAM_HEARD = 12000;
const TICK = 1 / 60;

interface Warn { m: ServerBossTelegraphMessage; age: number; life: number }
interface Beam { m: ServerBossBeamMessage; age: number; life: number; ring: number; scorch: number; shake: number; stop: (() => void) | null }
/** Sparks and molten spatter thrown from where a beam strikes */
interface Spark { x: number; y: number; vx: number; vy: number; life: number; max: number; size: number; hot: boolean }
/** A molten scar a beam leaves on rock (it cools: white, orange, a dull red glow, gone) */
interface Scorch { x: number; y: number; r: number; age: number; life: number }
/** A shock ring thrown out from the strike */
interface Ring { x: number; y: number; age: number; life: number; r: number }
const SHIPS = new Set([1, 10]);
/** A breathing zone's colours: its fill, rim, heart and the waves through it (a boss's vents amber, the Scrap Mother's iris green) */
const VENT = { fill: 0xff8a20, rim: 0xffb040, heart: 0xffd080, wave: 0xffc060 }, IRIS = { fill: 0x2ad8a0, rim: 0x7affd2, heart: 0xc8fff0, wave: 0x9affe0 };

export class BossFx {
  private g = new Graphics();
  private warns: Warn[] = [];
  private beams: Beam[] = [];
  private sparks: Spark[] = [];
  private scorches: Scorch[] = [];
  private rings: Ring[] = [];
  private t = 0;
  /** Round the Graphics: drawn again into the bloom, a layer is a render group, and a Graphics redrawn as one rebuilds the scene's draw list */
  private root = new Container();
  /** The beams and warnings (for the bloom) */
  get glowLayer(): Container { return this.root; }
  /** Where a boss's exposed pieces are drawn (ShipRenderer.exposedAt: set by ShipClient) */
  partsAt: (bodyId: number, byStage: readonly (readonly string[])[]) => { x: number; y: number }[] = () => [];
  /** Its window's look on its exposed pieces (bossExposure.ts: from the window message alone) */
  private exposure = new BossExposure({
    nameOf: (id) => this.state.entities.get(id)?.name ?? null,
    partsAt: (id, byStage) => this.partsAt(id, byStage),
    centre: (id) => { const e = this.state.entities.get(id); return e ? { x: e.renderX, y: e.renderY } : null; },
    tick: () => this.state.renderTickNow,
  });

  constructor(layer: Container, private state: GameState, private sound: (id: string, at?: { x: number; y: number }, volume?: number, pitch?: number) => (() => void) | null) {
    this.g.blendMode = 'add';
    this.root.addChild(this.g);
    layer.addChild(this.root);
  }

  onTelegraph(m: ServerBossTelegraphMessage): void {
    this.warns.push({ m, age: 0, life: m.ticks * TICK });
    const at = this.where(m);
    if (!at) return;
    // (light tells and their sounds: bossTells.ts)
    if (isTell(m.kind)) { const s = tellSound(m.kind); if (s) this.warnSound(s[0], at, s[1], s[2]); return; }
    // The lance gathering: a deep swell to the moment it fires (sped up as its charge shortens)
    if (m.kind === 'lance') this.warnSound('boss_charge', at, 1, Math.max(0.85, Math.min(2, CHARGE_SOUND / (m.ticks * TICK))));
    else if (m.kind === 'magma') this.sound('magma_charge', at, 0.8, Math.max(0.8, Math.min(1.6, MAGMA_SOUND / (m.ticks * TICK))));
    else { const s = warnSound(m.kind); if (s) this.warnSound(s[0], at, s[1], s[2]); }
  }

  /** When each warning sound last played (performance.now ms): WARN_GAP_MS apart at least */
  private warnedAt = new Map<string, number>();
  private warnSound(id: string, at: { x: number; y: number }, volume: number, pitch: number): void {
    const now = performance.now(), last = this.warnedAt.get(id);
    if (last !== undefined && now - last < (WARN_GAP_MS[id] ?? WARN_GAP_DEFAULT_MS)) return;
    this.warnedAt.set(id, now);
    this.sound(id, at, volume, pitch);
  }

  /** A weak-point window opened, filled, cracked or closed: its exposed pieces blaze while it runs */
  onWindow(m: ServerBossWindowMessage): void {
    this.exposure.onWindow(m);
  }

  onBeam(m: ServerBossBeamMessage): void {
    // Its burn, heard across the arena (not placed: it's as long as the arena), cut when the beam is
    const e = this.state.entities.get(m.bodyId), me = this.state.entities.get(this.state.playerId);
    const d = e && me ? Math.hypot(e.renderX - me.renderX, e.renderY - me.renderY) : Infinity;
    const stop = d < BEAM_HEARD ? this.sound('boss_beam', undefined, 0.9 * (1 - d / BEAM_HEARD) ** 1.5) : null;
    this.beams.push({ m, age: 0, life: m.ticks * TICK, ring: 0, scorch: 0, shake: 0, stop });
  }

  /** A body-riding warning's world origin (or the spot itself) */
  private where(m: { x: number; y: number; bodyId?: number }): { x: number; y: number; angle: number } | null {
    if (m.bodyId === undefined) return { x: m.x, y: m.y, angle: 0 };
    const e = this.state.entities.get(m.bodyId);
    if (!e) return null;
    const c = Math.cos(e.renderAngle), s = Math.sin(e.renderAngle);
    return { x: e.renderX + m.x * c - m.y * s, y: e.renderY + m.x * s + m.y * c, angle: e.renderAngle };
  }

  update(dt: number): void {
    this.t += dt;
    const g = this.g;
    g.clear();
    let w = 0;
    for (const x of this.warns) {
      x.age += dt;
      if (x.age >= x.life) continue;
      const at = this.where(x.m);
      if (at) this.drawWarn(g, x, at);
      this.warns[w++] = x;
    }
    this.warns.length = w;
    w = 0;
    for (const b of this.beams) {
      b.age += dt;
      if (b.age >= b.life) { b.stop?.(); continue; }
      const at = this.where(b.m);
      if (at) this.drawBeam(g, b, at, dt);
      this.beams[w++] = b;
    }
    this.beams.length = w;
    this.drawAfter(g, dt);
    this.exposure.draw(g, dt);
  }

  private drawWarn(g: Graphics, x: Warn, at: { x: number; y: number; angle: number }): void {
    const m = x.m, k = x.age / x.life;
    const color = COLOR[m.kind] ?? 0xff4a1a;
    // Brighter as it comes, a hard flash at the end
    const ramp = 0.35 + 0.65 * k * k;
    const blink = k > 0.82 ? 0.6 + 0.4 * Math.sin(this.t * 40) : 1;
    if (isTell(m.kind)) { drawTell(g, m, at, x.age, x.life, this.t, terrainFor(this.state.systemId)); return; }
    if (m.kind === 'magma') { this.drawMagma(g, x, at); return; }
    if (m.kind === 'vent') { this.drawVent(g, x, at); return; }
    if (m.kind === 'iris') { this.drawVent(g, x, at, IRIS); return; }
    if (m.kind === 'magnet') { this.drawMagnet(g, x, at); return; }
    if (m.kind === 'pool' || m.kind === 'embers') { this.drawPool(g, x, at); return; }
    if (m.shape === 'circle') {
      // (on the ground, or riding the body: `at`)
      const r = m.radius ?? 200, cx = at.x, cy = at.y;
      g.circle(cx, cy, r).fill({ color, alpha: 0.07 + 0.13 * ramp });
      g.circle(cx, cy, r).stroke({ color, width: 4, alpha: 0.5 * ramp * blink + 0.15 });
      // The closing ring: from twice its size down to its rim
      g.circle(cx, cy, r * (1 + (1 - k) * 1.2)).stroke({ color: 0xffd0a0, width: 2.5, alpha: 0.25 + 0.5 * k });
      g.circle(cx, cy, r * 0.12).fill({ color: 0xffe0c0, alpha: 0.3 + 0.5 * k });
      return;
    }
    const a = at.angle + (m.angle ?? 0), half = (m.width ?? 80) / 2;
    // (a lane stops where the rock does, as the beam will)
    const full = m.length ?? 1000, len = full * rayTerrain(terrainFor(this.state.systemId), at.x, at.y, at.x + Math.cos(a) * full, at.y + Math.sin(a) * full);
    const ux = Math.cos(a), uy = Math.sin(a), nx = -uy * half, ny = ux * half;
    const ex = at.x + ux * len, ey = at.y + uy * len;
    // The lane, fading out towards its far end
    g.poly([at.x + nx, at.y + ny, ex + nx * 0.7, ey + ny * 0.7, ex - nx * 0.7, ey - ny * 0.7, at.x - nx, at.y - ny]).fill({ color, alpha: (0.06 + 0.14 * ramp) * blink });
    g.moveTo(at.x + nx, at.y + ny).lineTo(ex + nx * 0.7, ey + ny * 0.7).stroke({ color, width: 3, alpha: 0.55 * ramp * blink });
    g.moveTo(at.x - nx, at.y - ny).lineTo(ex - nx * 0.7, ey - ny * 0.7).stroke({ color, width: 3, alpha: 0.55 * ramp * blink });
    // Chevrons running down it
    const gap = Math.max(120, half * 1.4), run = (this.t * (m.kind === 'dash' ? 900 : 600)) % gap;
    for (let d = run; d < len - 20; d += gap) {
      const f = d / len, wv = half * (1 - 0.3 * f) * 0.7;
      const cx = at.x + ux * d, cy = at.y + uy * d;
      g.moveTo(cx - ux * wv * 0.6 + (-uy) * wv, cy - uy * wv * 0.6 + ux * wv).lineTo(cx, cy).lineTo(cx - ux * wv * 0.6 - (-uy) * wv, cy - uy * wv * 0.6 - ux * wv)
        .stroke({ color: 0xffd8b0, width: 3, alpha: (0.25 + 0.5 * ramp) * (1 - f * 0.6) * blink });
    }
  }

  /**
   * Its vents open (a boss laid open: now's the time to hit it): a breathing amber ring as far as the heat reaches
   * (close in, you burn), heat welling up out of its middle, fading out as they close
   */
  private drawVent(g: Graphics, x: Warn, at: { x: number; y: number }, c = VENT): void {
    const r = x.m.radius ?? 600;
    const fade = Math.min(1, x.age / 0.25) * Math.min(1, (x.life - x.age) / 0.4);
    const breathe = 0.5 + 0.5 * Math.sin(this.t * 6);
    g.circle(at.x, at.y, r).fill({ color: c.fill, alpha: (0.04 + 0.04 * breathe) * fade });
    g.circle(at.x, at.y, r).stroke({ color: c.rim, width: 5, alpha: (0.3 + 0.35 * breathe) * fade });
    g.circle(at.x, at.y, r * 0.42 * (1 + 0.06 * breathe)).fill({ color: c.heart, alpha: (0.12 + 0.12 * breathe) * fade });
    // Heat welling out from its middle to the rim, over and over
    for (let i = 0; i < 3; i++) {
      const ph = (this.t * 0.8 + i / 3) % 1;
      g.circle(at.x, at.y, r * (0.3 + 0.7 * ph)).stroke({ color: c.wave, width: 3, alpha: 0.35 * (1 - ph) * fade });
    }
  }

  /** Magnets winding up and pulling (the Scrap Mother's haul): its reach's rim, and rings closing in on it, faster as it pulls */
  private drawMagnet(g: Graphics, x: Warn, at: { x: number; y: number }): void {
    const r = x.m.radius ?? 3000, k = x.age / x.life;
    const fade = Math.min(1, x.age / 0.3) * Math.min(1, (x.life - x.age) / 0.3);
    g.circle(at.x, at.y, r).stroke({ color: 0x7affd2, width: 4, alpha: 0.45 * fade });
    for (let i = 0; i < 5; i++) {
      const ph = 1 - ((this.t * (0.4 + 0.8 * k) + i / 5) % 1);
      g.circle(at.x, at.y, r * (0.15 + 0.85 * ph)).stroke({ color: 0xa8ffe4, width: 3, alpha: 0.4 * (1 - ph * 0.6) * fade });
    }
  }

  /** A pool burning a while (greyseam sludge, or ground a magma lob left alight): a bubbling disc, fading as it cools */
  private drawPool(g: Graphics, x: Warn, at: { x: number; y: number }): void {
    const r = x.m.radius ?? 230, k = x.age / x.life, fade = Math.min(1, x.age / 0.15) * (1 - k * k), c = POOL[x.m.kind] ?? POOL.pool;
    g.circle(at.x, at.y, r).fill({ color: c.disc, alpha: 0.3 * fade });
    g.circle(at.x, at.y, r * 0.7).fill({ color: c.heart, alpha: 0.18 * fade });
    for (let i = 0; i < 5; i++) {
      const a = i * 2.39996 + Math.floor(this.t * 2 + i * 0.37) * 1.3, ph = (this.t * 2 + i * 0.37) % 1, d = r * 0.6 * ((i * 0.618) % 1);
      g.circle(at.x + Math.cos(a) * d, at.y + Math.sin(a) * d, r * 0.12 * ph).stroke({ color: c.bubble, width: 2, alpha: 0.6 * (1 - ph) * fade });
    }
  }

  /** A ball of magma swelling on its turret: a dark crust cracking over a white-hot heart, embers pulled in */
  private drawMagma(g: Graphics, x: Warn, at: { x: number; y: number }): void {
    const k = x.age / x.life, r = MAGMA_R * (0.15 + 0.85 * Math.pow(k, 0.7));
    const throb = 1 + 0.08 * Math.sin(this.t * (18 + 30 * k)) + 0.05 * Math.sin(this.t * 47);
    g.circle(at.x, at.y, r * 2.6 * throb).fill({ color: 0xff3a0a, alpha: 0.1 + 0.15 * k });
    g.circle(at.x, at.y, r * 1.5 * throb).fill({ color: 0xff6a1a, alpha: 0.35 + 0.3 * k });
    g.circle(at.x, at.y, r * throb).fill({ color: 0xffa040, alpha: 0.8 });
    g.circle(at.x, at.y, r * 0.55).fill({ color: 0xfff0c8, alpha: 0.5 + 0.5 * k });
    // Embers drawn in from round it, faster and more as it fills
    const n = 6 + Math.round(10 * k);
    for (let i = 0; i < n; i++) {
      const ph = (this.t * (0.9 + 0.8 * k) + i * 0.618) % 1, a = i * 2.39996 + Math.floor(this.t * (0.9 + 0.8 * k) + i * 0.618) * 1.7;
      const d0 = r * (1.2 + 3 * (1 - ph)), d1 = d0 - r * 0.6;
      g.moveTo(at.x + Math.cos(a) * d0, at.y + Math.sin(a) * d0).lineTo(at.x + Math.cos(a) * d1, at.y + Math.sin(a) * d1)
        .stroke({ color: 0xffb060, width: 2 + 2 * k, alpha: 0.7 * ph });
    }
  }

  private drawBeam(g: Graphics, b: Beam, at: { x: number; y: number; angle: number }, dt: number): void {
    const m = b.m, k = b.age / b.life;
    // (a crane's arm swinging, not a beam: bossTells.ts)
    if (m.kind === 'crane') { drawCraneLash(g, m, at, k, Math.min(1, b.age / 0.08) * Math.min(1, (b.life - b.age) / 0.15)); return; }
    const a = at.angle + m.a0 + (m.a1 - m.a0) * k;
    const ux = Math.cos(a), uy = Math.sin(a);
    // It burns out against rock (the server stops it there too), or against the first ship in its way (a scythe's blade sweeps through)
    const rock = m.length * rayTerrain(terrainFor(this.state.systemId), at.x, at.y, at.x + ux * m.length, at.y + uy * m.length);
    const blade = m.kind === 'scythe', inner = blade ? Math.max(0, m.length - SCYTHE_BLADE) : 0;
    let len = rock, onShip = -1;
    // (a crane's lash bites from a quarter out: close in, it passes over)
    const bite = m.kind === 'crane' ? m.length * CRANE_BITE : 0;
    if (!blade) for (const e of this.state.entities.values()) {
      if (!SHIPS.has(e.type) || e.id === m.bodyId) continue;
      const along = (e.renderX - at.x) * ux + (e.renderY - at.y) * uy;
      if (along <= bite || along >= len) continue;
      const off = Math.abs((e.renderX - at.x) * -uy + (e.renderY - at.y) * ux), r = e.id === this.state.playerId ? 90 : 120;
      if (off < r + m.width / 2) { len = Math.max(0, along - Math.sqrt(Math.max(0, r * r - off * off)) * 0.6); onShip = e.id; }
    }
    const ex = at.x + ux * len, ey = at.y + uy * len;
    // Up to full in a moment, off at the end
    const on = Math.min(1, b.age / 0.08) * Math.min(1, (b.life - b.age) / 0.12);
    const flick = 0.85 + 0.15 * Math.sin(this.t * 55);
    const s0 = Math.min(len, blade ? inner : bite), sx = at.x + ux * s0, sy = at.y + uy * s0;
    const line = (width: number, color: number, alpha: number) => g.moveTo(sx, sy).lineTo(ex, ey).stroke({ color, width, alpha: alpha * on });
    const p = BEAM[m.kind ?? 'lance'] ?? BEAM.lance;
    line(m.width * 3.2, p.halo, 0.14 * flick);
    line(m.width * 1.6, p.glow, 0.4 * flick);
    line(m.width * 0.8, p.body, 0.7);
    line(m.width * 0.28, p.core, 0.95);
    if (!blade) {
      g.circle(sx, sy, m.width * (s0 ? 0.6 : 1.4)).fill({ color: p.flare, alpha: 0.5 * on });
      g.circle(sx, sy, m.width * (s0 ? 0.3 : 0.6)).fill({ color: p.hot, alpha: 0.9 * on });
    }
    const struck = len < m.length - 1;
    if (!struck) return;
    // The strike: a white-hot flare, a halo, shock rings thrown off, sparks and molten spatter sprayed back
    const hot = onShip >= 0, w = m.width * (hot ? 1.5 : 1.2), pulse = 1 + 0.25 * Math.sin(this.t * 34) + 0.15 * Math.sin(this.t * 71);
    g.circle(ex, ey, w * 3.4 * pulse).fill({ color: p.halo, alpha: 0.12 * on });
    g.circle(ex, ey, w * 2.0 * pulse).fill({ color: p.glow, alpha: 0.3 * on });
    g.circle(ex, ey, w * 1.1 * pulse).fill({ color: p.body, alpha: 0.6 * on });
    g.circle(ex, ey, w * 0.55).fill({ color: 0xffffff, alpha: 0.95 * on });
    b.ring -= dt;
    if (b.ring <= 0) { b.ring = hot ? 0.09 : 0.14; this.rings.push({ x: ex, y: ey, age: 0, life: 0.35, r: w * (hot ? 4.5 : 3.2) }); }
    const n = Math.round((hot ? 14 : 9) * dt * 60 * on);
    for (let i = 0; i < n; i++) {
      // Back along the beam and out to the sides, the odd fleck further
      const sa = Math.atan2(-uy, -ux) + (Math.random() - 0.5) * 2.4, sp = 6 + Math.random() * (hot ? 26 : 18);
      this.sparks.push({ x: ex, y: ey, vx: Math.cos(sa) * sp, vy: Math.sin(sa) * sp, life: 0, max: 0.25 + Math.random() * 0.45, size: 2 + Math.random() * (hot ? 5 : 4), hot: Math.random() < 0.5 });
    }
    if (!hot && m.kind !== 'crystal') {
      // A molten scar on the rock, every little way along the sweep
      b.scorch -= dt;
      if (b.scorch <= 0) { b.scorch = 0.03; this.scorches.push({ x: ex + ux * m.width * 0.4, y: ey + uy * m.width * 0.4, r: m.width * (0.7 + Math.random() * 0.5), age: 0, life: 4.5 }); }
    } else if (onShip === this.state.playerId) {
      // On you: the screen shakes with it
      b.shake -= dt;
      if (b.shake <= 0) { b.shake = 0.16; this.state.triggerScreenShake(5, 0.18); }
    }
  }

  /** Each frame, after the beams: scars cooling, rings spreading, sparks flying */
  private drawAfter(g: Graphics, dt: number): void {
    let w = 0;
    for (const s of this.scorches) {
      s.age += dt;
      if (s.age >= s.life) continue;
      const f = s.age / s.life, heat = Math.max(0, 1 - f * 1.6);
      const color = heat > 0.6 ? 0xffd090 : heat > 0.25 ? 0xff7a2a : 0xb02a0a;
      g.circle(s.x, s.y, s.r * (1 + 0.3 * f)).fill({ color: 0xff3a0a, alpha: 0.18 * (1 - f) });
      g.circle(s.x, s.y, s.r * 0.55).fill({ color, alpha: 0.6 * (1 - f) });
      this.scorches[w++] = s;
    }
    this.scorches.length = w;
    w = 0;
    for (const r of this.rings) {
      r.age += dt;
      if (r.age >= r.life) continue;
      const f = r.age / r.life;
      g.circle(r.x, r.y, r.r * (0.3 + f)).stroke({ color: 0xffb060, width: 6 * (1 - f) + 1, alpha: 0.7 * (1 - f) });
      this.rings[w++] = r;
    }
    this.rings.length = w;
    w = 0;
    for (const s of this.sparks) {
      s.life += dt;
      if (s.life >= s.max) continue;
      const f = s.life / s.max, k = Math.pow(0.9, dt * 60);
      s.vx *= k; s.vy *= k;
      s.x += s.vx * dt * 60; s.y += s.vy * dt * 60;
      // A streak along its flight, white-hot to orange as it cools
      g.moveTo(s.x - s.vx * 1.6, s.y - s.vy * 1.6).lineTo(s.x, s.y).stroke({ color: s.hot && f < 0.4 ? 0xfff0d0 : 0xff8a3a, width: s.size * (1 - f * 0.6), alpha: 1 - f });
      this.sparks[w++] = s;
    }
    this.sparks.length = w;
    // (never too many)
    if (this.sparks.length > 900) this.sparks.splice(0, this.sparks.length - 900);
    if (this.scorches.length > 400) this.scorches.splice(0, this.scorches.length - 400);
  }
}
