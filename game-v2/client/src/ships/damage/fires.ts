/**
 * @contract client.damage.fires
 * owns:       how a spreading fire (a Burn modifier's: an `ignite` with `gen`) looks on a ship: flames licking off each
 *             burning part, its hot glow, embers and a thin smoke trailing the ship, the flare when a part catches
 *             (and the lick across from the part that lit it), and the char left smoking where one burned out
 * needs:      DamageCtx (particles, ships, clock); no textures of its own (the particle field's)
 * invariants: bounded however much burns: no more than FIRE_CAPS.fires fires and .scorch chars are kept, no more
 *             than .perShip parts a ship throw particles (the rest only glow), and no more than .perFrame particles
 *             are made a frame, flares and chars counted — client/src/ships/damage/fires.test.ts
 *             a fire ends with its time or its part, and only one that burned out leaves a char —
 *             client/src/ships/damage/fires.test.ts
 *             any other fire (an `ignite` without `gen`: magma's, the Cinder Bloom's, a vent's) is not drawn here:
 *             it looks as it always did (damage/ambient.ts) — client/src/ships/damage/fires.test.ts
 * extend:     a new part of the look is a few lines in emit or draw, inside the frame's budget
 */

import type { DamageCtx } from './context';

/** The bounds: fires and chars kept, parts a ship that throw particles, particles made a frame, seconds a char smokes */
export const FIRE_CAPS = { fires: 120, scorch: 40, perShip: 10, perFrame: 48, scorchSecs: 7 };

/** A generation's size against the shot's own fire (gen 1), the last repeating */
const GEN_SIZE = [1, 1, 0.8, 0.64, 0.52];
const SMOKE = 0x2a2522, CHAR = 0x14110f, HOT = 0xffd27a, ORANGE = 0xff8a2a;

interface Fire { body: number; part: number; start: number; until: number; gen: number; seed: number }
interface Char { body: number; part: number; start: number; until: number; size: number }

const mix = (a: number, b: number, k: number): number => {
  const r = ((a >> 16) & 255) + ((((b >> 16) & 255) - ((a >> 16) & 255)) * k), g = ((a >> 8) & 255) + ((((b >> 8) & 255) - ((a >> 8) & 255)) * k), bl = (a & 255) + (((b & 255) - (a & 255)) * k);
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(bl);
};

export class PartFires {
  private fires: Fire[] = [];
  private chars: Char[] = [];
  /** Particles made this frame (emit and the flares since the last one) */
  private made = 0;
  /** The fire's colour: the Burn effect's own (tuning.json modifiers.say.burn), read once */
  private tint = -1;

  constructor(private readonly c: DamageCtx) {}

  /** How many fires and chars are kept (tests, the debug overlay) */
  get counts(): { fires: number; chars: number } { return { fires: this.fires.length, chars: this.chars.length }; }

  private color(): number {
    if (this.tint < 0) {
      const hex = (this.c.source.tuning as { modifiers?: { say?: Record<string, { color?: string }> } }).modifiers?.say?.burn?.color;
      this.tint = hex ? parseInt(hex.slice(1), 16) : 0xff5a4a;
    }
    return this.tint;
  }

  private size(f: Fire): number {
    return GEN_SIZE[Math.min(f.gen, GEN_SIZE.length - 1)];
  }

  /** A part caught (gen 1: a shot's own fire; 2 and up: one that spread to it, or burned on) for `ticks` */
  onIgnite(body: number, part: number, ticks: number, gen: number): void {
    const now = this.c.time, until = now + ticks / 60;
    const cur = this.fires.find((f) => f.body === body && f.part === part);
    if (cur) {
      // (lit again: as long as the longer, as big as the bigger; a fire that only burns on makes no new flare)
      cur.until = Math.max(cur.until, until);
      cur.gen = Math.min(cur.gen, gen);
      return;
    }
    // (full: the one nearest its end makes way)
    if (this.fires.length >= FIRE_CAPS.fires) {
      let k = 0;
      for (let i = 1; i < this.fires.length; i++) if (this.fires[i].until < this.fires[k].until) k = i;
      this.fires.splice(k, 1);
    }
    const f: Fire = { body, part, start: now, until, gen, seed: (body * 31 + part * 17) % 97 };
    this.fires.push(f);
    this.chars = this.chars.filter((s) => s.body !== body || s.part !== part);
    this.flare(f);
  }

  /** The moment a part catches: a flash and a few sparks; one that spread, a lick of flame across from the part that lit it */
  private flare(f: Fire): void {
    if (this.made + 8 > FIRE_CAPS.perFrame) return;
    const p = this.c.partWorld(f.body, f.part);
    if (!p) return;
    const s = this.size(f), tint = this.color();
    this.c.p.glow(p.x, p.y, p.vx, p.vy, 34 * s, 12, mix(tint, HOT, 0.5), 0.85);
    this.c.p.burstSparks(p.x, p.y, p.vx, p.vy, 4, 1.5, 5, ORANGE);
    this.made += 5;
    if (f.gen < 2) return;
    // (the burning part nearest it, within a couple of cells: where it came from)
    const reach = this.c.source.tuning.cellSize * 2.6;
    let from: { x: number; y: number } | null = null, best = reach;
    for (const o of this.fires) {
      if (o === f || o.body !== f.body) continue;
      const q = this.c.partWorld(o.body, o.part);
      if (!q) continue;
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d < best) { best = d; from = q; }
    }
    if (!from) return;
    for (let i = 0; i < 3; i++) {
      const k = i / 3, life = 9 + i * 2;
      this.c.p.push({ kind: 'glow', x: from.x + (p.x - from.x) * k, y: from.y + (p.y - from.y) * k, vx: p.vx + (p.x - from.x) / 14, vy: p.vy + (p.y - from.y) / 14,
        life: 0, max: life, size: 10 * s, grow: -0.3, color: i ? tint : HOT, alpha: 0.9, drag: 0.96, rot: 0, vr: 0 });
    }
    this.made += 3;
  }

  /** The frame's particles: flames, embers and smoke off each burning part, a wisp off each char; fires and chars that are over dropped */
  emit(frames: number): void {
    const now = this.c.time, src = this.c.source;
    if (!this.fires.length && !this.chars.length) { this.made = 0; return; }
    // Over: its time up (it leaves a char), or its part or ship gone (it leaves nothing)
    for (let i = this.fires.length - 1; i >= 0; i--) {
      const f = this.fires[i], ship = src.get(f.body), there = !!ship && ship.derived.alive[f.part] !== false;
      if (there && f.until > now) continue;
      this.fires.splice(i, 1);
      if (!there) continue;
      if (this.chars.length >= FIRE_CAPS.scorch) this.chars.shift();
      this.chars.push({ body: f.body, part: f.part, start: now, until: now + FIRE_CAPS.scorchSecs, size: this.size(f) });
    }
    this.chars = this.chars.filter((s) => s.until > now && src.get(s.body)?.derived.alive[s.part] !== false);
    const budget = Math.max(0, FIRE_CAPS.perFrame - this.made);
    this.made = 0;
    // Thin by count: each fire wants about a particle a frame; past the budget, every one makes its share fewer
    const perShip = new Map<number, number>();
    let want = this.chars.length * 0.04 * frames;
    for (const f of this.fires) {
      const n = (perShip.get(f.body) ?? 0) + 1;
      perShip.set(f.body, n);
      if (n <= FIRE_CAPS.perShip) want += this.size(f) * 1.75 * frames;
    }
    const thin = want > budget ? budget / want : 1;
    let made = 0;
    const room = (): boolean => made < budget;
    perShip.clear();
    const tint = this.color(), cs = src.tuning.cellSize;
    for (const f of this.fires) {
      const n = (perShip.get(f.body) ?? 0) + 1;
      perShip.set(f.body, n);
      // (a ship with more parts alight than the cap: the later ones only glow, draw)
      if (n > FIRE_CAPS.perShip || !room()) continue;
      const p = this.c.partWorld(f.body, f.part);
      if (!p) continue;
      const left = f.until - now, s = this.size(f) * Math.min(1, (now - f.start) / 0.15 + 0.3) * Math.min(1, left / 0.6 + 0.25), k = thin * frames;
      const half = cs * 0.34;
      // Tongues of flame: born on the part, lifting and narrowing as they go (two tries a frame: a full fire is never bare)
      for (let i = 0; i < 2; i++) {
        if (Math.random() >= 0.75 * s * k || !room()) continue;
        const a = Math.random() * Math.PI * 2, r = Math.random() * half, hot = Math.random();
        this.c.p.push({ kind: 'glow', x: p.x + Math.cos(a) * r, y: p.y + Math.sin(a) * r, vx: p.vx + (Math.random() - 0.5) * 0.6, vy: p.vy - 0.5 - Math.random() * 0.8,
          life: 0, max: 18 + Math.random() * 16, size: (13 + Math.random() * 12) * s, grow: -0.3, color: hot < 0.25 ? HOT : hot < 0.6 ? ORANGE : tint, alpha: 0.9, drag: 0.965, rot: 0, vr: 0 });
        made++;
      }
      // An ember let go, rising
      if (Math.random() < 0.13 * s * k && room()) {
        const a = Math.random() * Math.PI * 2;
        this.c.p.push({ kind: 'spark', x: p.x + Math.cos(a) * half, y: p.y + Math.sin(a) * half, vx: p.vx * 0.8 + (Math.random() - 0.5) * 0.9, vy: p.vy * 0.8 - 0.5 - Math.random() * 0.8,
          life: 0, max: 30 + Math.random() * 26, size: 1.3, grow: 0, color: mix(tint, HOT, 0.4), alpha: 1, drag: 0.975, rot: 0, vr: 0 });
        made++;
      }
      // Thin smoke, left behind as the ship moves on
      if (Math.random() < 0.16 * s * k && room()) {
        this.c.p.dustPuff(p.x + (Math.random() - 0.5) * half, p.y - half * 0.5, p.vx * 0.35, p.vy * 0.35 - 0.3, 7 + 7 * s, 80 + Math.random() * 50, SMOKE, 0.32, 0.14);
        made++;
      }
    }
    // A char smokes a little while it cools
    for (const sc of this.chars) {
      if (!room()) break;
      if (Math.random() > 0.04 * thin * frames) continue;
      const p = this.c.partWorld(sc.body, sc.part);
      if (!p) continue;
      this.c.p.dustPuff(p.x, p.y, p.vx * 0.5, p.vy * 0.5 - 0.15, 6 * sc.size, 60, SMOKE, 0.2 * (1 - (now - sc.start) / FIRE_CAPS.scorchSecs), 0.1);
      made++;
    }
    this.made = 0;
    this.lastMade = made;
  }

  /** Particles the last emit made (tests) */
  lastMade = 0;

  /**
   * Drawn every frame, where the part is now (the pools are open): each fire's glow, steady under the flames and
   * flickering; each char a dark smudge on the part, fading as it cools
   */
  draw(): void {
    if (!this.fires.length && !this.chars.length) return;
    const now = this.c.time, tint = this.color(), cs = this.c.source.tuning.cellSize;
    for (const f of this.fires) {
      const p = this.c.partWorld(f.body, f.part);
      if (!p) continue;
      const s = this.size(f) * Math.min(1, (f.until - now) / 0.6 + 0.25), fl = 0.85 + 0.15 * Math.sin(now * 23 + f.seed) * Math.sin(now * 7.3 + f.seed * 2);
      this.c.p.rings.disc(p.x, p.y, cs * 1.3 * s * fl, tint, 0.2 * s);
      this.c.p.rings.disc(p.x, p.y, cs * 0.6 * s * fl, HOT, 0.36 * s);
    }
    for (const sc of this.chars) {
      const p = this.c.partWorld(sc.body, sc.part);
      if (!p) continue;
      const k = 1 - (now - sc.start) / FIRE_CAPS.scorchSecs;
      this.c.p.char(p.x, p.y, cs * 0.62 * sc.size, CHAR, 0.62 * k);
      // (the last of its heat: a dull red heart for its first second and a half)
      if (now - sc.start < 1.5) this.c.p.rings.disc(p.x, p.y, cs * 0.3 * sc.size, 0xff4a1a, 0.12 * (1 - (now - sc.start) / 1.5));
    }
  }
}
