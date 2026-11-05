/**
 * A boss laid open (docs/bosses/rework-2026-11.md section 15): while its window runs, its exposed pieces (bosses.json
 * `exposed`, the list for the stage it's fighting) blaze so it reads at a glance: a pulsing white-hot light on each, a
 * beacon ring thrown off it over and over, a halo venting, and sparks spraying out. In its last second it blinks; filled
 * early it cracks: a flash, a burst of shards and a shock ring, then a dim stutter while it's staggered.
 *
 * Drawn from the window message alone (`bossWindow`: its tick, length and crack), which every client is sent anyway:
 * nothing more on the wire. Drawn into BossFx's additive layer (so the bloom takes it).
 */

import type { Graphics } from 'pixi.js';
import type { ServerBossWindowMessage } from '@space-game/common';
import bossData from '../../../data/bosses.json';

const DEFS = (bossData as unknown as { bosses: Record<string, { name: string; exposed?: string[][] }> }).bosses;
/** A boss's exposed pieces by stage, by its name (as its entity carries it) */
const EXPOSED = new Map(Object.values(DEFS).filter((b) => b.exposed?.length).map((b) => [b.name, b.exposed!]));
/** Its colour (greyseam green for the Mother's; molten amber for the Pyreclast's; pale gold for anyone else's) */
const TINT: Record<string, number> = { 'Scrap Mother': 0x7affd2, 'The Pyreclast': 0xffa040 };
const TICK = 1 / 60;

interface Spark { x: number; y: number; vx: number; vy: number; life: number; max: number; size: number; tint: number }
interface Ring { x: number; y: number; age: number; life: number; r: number; tint: number }

export interface ExposureHost {
  /** The boss's entity's name (null: gone) */
  nameOf(bodyId: number): string | null;
  /** Where its exposed pieces are drawn now (ShipRenderer.exposedAt); none: its middle */
  partsAt(bodyId: number, byStage: readonly (readonly string[])[]): { x: number; y: number }[];
  centre(bodyId: number): { x: number; y: number } | null;
  /** The tick the world is drawn at */
  tick(): number;
}

export class BossExposure {
  private open = new Map<number, ServerBossWindowMessage>();
  private cracked = new Set<number>();
  private sparks: Spark[] = [];
  private rings: Ring[] = [];
  private emit = 0;
  private t = 0;

  constructor(private host: ExposureHost) {}

  /** A window opened, filled, cracked or closed (its boss's latest message is all that's kept) */
  onWindow(m: ServerBossWindowMessage): void {
    if (m.ticks <= 0) { this.open.delete(m.bodyId); this.cracked.delete(m.bodyId); return; }
    const was = this.open.get(m.bodyId);
    if (!was || was.at !== m.at) this.cracked.delete(m.bodyId);
    this.open.set(m.bodyId, m);
  }

  /** Each frame */
  draw(g: Graphics, dt: number): void {
    this.t += dt;
    const now = this.host.tick();
    this.emit += dt;
    const puff = this.emit >= 1 / 40;
    if (puff) this.emit = 0;
    for (const [id, m] of this.open) {
      const left = (m.at + m.ticks - now) * TICK, age = (now - m.at) * TICK;
      const name = this.host.nameOf(id);
      if (left <= 0 || !name) { this.open.delete(id); this.cracked.delete(id); continue; }
      const byStage = EXPOSED.get(name);
      let at = byStage ? this.host.partsAt(id, byStage) : [];
      if (!at.length) { const c = this.host.centre(id); at = c ? [c] : []; }
      const tint = TINT[name] ?? 0xffe6a0;
      if (m.crack && !this.cracked.has(id)) { this.cracked.add(id); for (const p of at) this.crack(p, tint); }
      const fadeIn = Math.min(1, age / 0.2), fadeOut = Math.min(1, left / 0.3);
      // (its last second: it blinks; staggered: a dim stutter)
      const blink = left < 1 ? 0.55 + 0.45 * Math.sign(Math.sin(this.t * 26)) : 1;
      const stutter = m.crack ? 0.35 + 0.25 * Math.sin(this.t * 41) * Math.sin(this.t * 7) : 1;
      const k = fadeIn * fadeOut * blink * stutter;
      for (const p of at) this.glow(g, p, tint, k, puff && !m.crack, at.length);
    }
    this.particles(g, dt);
  }

  /** One exposed piece blazing */
  private glow(g: Graphics, p: { x: number; y: number }, tint: number, k: number, puff: boolean, n: number): void {
    const beat = 0.6 + 0.4 * Math.sin(this.t * 9), r = 120;
    g.circle(p.x, p.y, r * 3.2).fill({ color: tint, alpha: 0.07 * k });
    g.circle(p.x, p.y, r * 1.7 * (0.9 + 0.1 * beat)).fill({ color: tint, alpha: 0.22 * beat * k });
    g.circle(p.x, p.y, r * 0.75).fill({ color: 0xffffff, alpha: 0.55 * beat * k });
    g.circle(p.x, p.y, r * 0.32).fill({ color: 0xffffff, alpha: 0.95 * k });
    // A crosshair glint on it: it's the place to shoot
    const L = r * (1.6 + 0.4 * beat);
    g.moveTo(p.x - L, p.y).lineTo(p.x + L, p.y).stroke({ color: 0xffffff, width: 3, alpha: 0.5 * k });
    g.moveTo(p.x, p.y - L).lineTo(p.x, p.y + L).stroke({ color: 0xffffff, width: 3, alpha: 0.5 * k });
    // A beacon ring thrown off it twice a second
    const ph = (this.t * 1.8) % 1;
    g.circle(p.x, p.y, r * (0.8 + 2.8 * ph)).stroke({ color: tint, width: 6 * (1 - ph) + 1.5, alpha: 0.7 * (1 - ph) * k });
    // Sparks spraying out of it (fewer a piece when many are open)
    if (puff && k > 0.2) for (let i = 0, m = Math.max(1, Math.round(4 / Math.sqrt(n))); i < m; i++) {
      const a = Math.random() * Math.PI * 2, sp = 5 + Math.random() * 12;
      this.sparks.push({ x: p.x + Math.cos(a) * r * 0.3, y: p.y + Math.sin(a) * r * 0.3, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0, max: 0.35 + Math.random() * 0.5, size: 2 + Math.random() * 3.5, tint });
    }
  }

  /** It cracked: a flash, a burst of shards, a shock ring */
  private crack(p: { x: number; y: number }, tint: number): void {
    this.rings.push({ x: p.x, y: p.y, age: 0, life: 0.6, r: 900, tint: 0xffffff }, { x: p.x, y: p.y, age: 0, life: 0.9, r: 1400, tint });
    for (let i = 0; i < 70; i++) {
      const a = Math.random() * Math.PI * 2, sp = 10 + Math.random() * 34;
      this.sparks.push({ x: p.x, y: p.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0, max: 0.4 + Math.random() * 0.8, size: 3 + Math.random() * 6, tint: Math.random() < 0.5 ? 0xffffff : tint });
    }
  }

  private particles(g: Graphics, dt: number): void {
    let w = 0;
    for (const r of this.rings) {
      r.age += dt;
      if (r.age >= r.life) continue;
      const f = r.age / r.life;
      if (f < 0.2) g.circle(r.x, r.y, r.r * 0.35 * (1 - f * 4)).fill({ color: 0xffffff, alpha: 0.5 * (1 - f * 5) });
      g.circle(r.x, r.y, r.r * (0.15 + 0.85 * f)).stroke({ color: r.tint, width: 14 * (1 - f) + 2, alpha: 0.8 * (1 - f) });
      this.rings[w++] = r;
    }
    this.rings.length = w;
    w = 0;
    for (const s of this.sparks) {
      s.life += dt;
      if (s.life >= s.max) continue;
      const f = s.life / s.max, damp = Math.pow(0.92, dt * 60);
      s.vx *= damp; s.vy *= damp;
      s.x += s.vx * dt * 60; s.y += s.vy * dt * 60;
      g.moveTo(s.x - s.vx * 1.8, s.y - s.vy * 1.8).lineTo(s.x, s.y).stroke({ color: f < 0.35 ? 0xffffff : s.tint, width: s.size * (1 - f * 0.6), alpha: 1 - f });
      this.sparks[w++] = s;
    }
    this.sparks.length = w;
    if (this.sparks.length > 600) this.sparks.splice(0, this.sparks.length - 600);
  }
}
