/**
 * @contract client.damage.shields
 * owns:       shield bubbles (rim, fill, hex, recharge and re-form glow), the ripples where shells strike them, EMP crackle over
 *             knocked-out ships, and the plating hits (reactive, spaced) a shot makes on an unshielded hull
 * needs:      DamageCtx (particles, ships, sound), shieldLooks, Settings (own shield strength), impactAnchor; npm: @space-game/common
 * invariants: a shield's drop that a shell's ripple already sounded is not sounded again within RIPPLE_HEARD_MS — none pinned
 *             a ripple lives 18 frames and rides the ship's frame — none pinned
 * extend:     a new shield look is a ShieldLook field (shieldLooks.ts) drawn in drawShields
 */

import { BUBBLE_RIM, DOT_SIZE, bubble, bubbleRim, glowBall, hexShield, streak, streakScale } from '../../rendering/fxTextures';
import { shieldLookOf } from '../shieldLooks';
import { settings } from '../../settings/Settings';
import { EntityType } from '@space-game/common';
import type { DamageCtx } from './context';
import { shipFunction } from '../shipFunctionData';

/** A shield's drop this soon after a shell's strike rippled it (ms) was that strike's, heard as it was drawn */
const RIPPLE_HEARD_MS = 700;

export class ShieldFx {
  private lastShield = new Map<number, number>();
  private shieldFlash = new Map<number, number>();
  /** A Flash Screen's re-form bloom, 1 fading to 0 */
  private reform = new Map<number, number>();
  /** Recharge glow, 1 while the level climbs, fading to 0 */
  private regen = new Map<number, number>();
  /** Shield ripples: where the shot struck, about the ship's centre in its own frame (angle and distance), so it rides with it */
  private ripples: { id: number; a: number; d: number; life: number; model: number }[] = [];
  /** When a shell's strike last rippled each ship's bubble (performance.now): its drop in the next rows isn't heard again */
  private rippledAt = new Map<number, number>();

  constructor(private readonly c: DamageCtx) {}

  /** Shield bubbles (brighter when hit) and EMP crackle over knocked-out ships */
  drawShields(frames: number): void {
    for (const [id, ship] of this.c.source.bodies) {
      const e = this.c.state.entities.get(id);
      if (!e || ship.kind !== 'ship') continue;
      const isPlayer = e.type === EntityType.Player;
      const shieldPct = (isPlayer ? e.data?.[4] : e.data?.[1]) ?? 0;
      // (Your own row carries the ticks left, everyone else's a flag)
      const emp = ((isPlayer ? e.data?.[5] : e.data?.[2]) ?? 0) > 0;
      const r = ship.derived.radius * 1.12 + 10;
      const prev = this.lastShield.get(id) ?? shieldPct;
      const look = shieldLookOf(ship);
      if (shieldPct < prev - 0.5) {
        // (A shell's strike on the bubble was heard as it was drawn (shieldHit's ripple: audio/CombatSounds.ts); this is
        // for the rest that wears a shield down, beams and blasts)
        const rippled = performance.now() - (this.rippledAt.get(id) ?? -Infinity) < RIPPLE_HEARD_MS;
        if (!rippled && (this.shieldFlash.get(id) ?? 0) < 0.4) this.c.sound('shield_hit', { x: e.renderX, y: e.renderY }, 0.6);
        this.shieldFlash.set(id, 1);
      }
      // A Flash Screen coming back: a white bloom swelling out of the bubble (the server's ShieldFlash effect adds the ring)
      if (look.reform && prev <= 0.5 && shieldPct > 0.5) this.reform.set(id, 1);
      this.lastShield.set(id, shieldPct);
      const flash = Math.max(0, (this.shieldFlash.get(id) ?? 0) - frames * 0.06);
      this.shieldFlash.set(id, flash);
      const rf = Math.max(0, (this.reform.get(id) ?? 0) - frames * 0.035);
      this.reform.set(id, rf);
      // Recharging: lit while the level keeps climbing, fading ~0.7 s after it stops
      const rg = shieldPct > prev + 0.01 && shieldPct < 100 ? 1 : Math.max(0, (this.regen.get(id) ?? 0) - frames * 0.025);
      this.regen.set(id, rg);
      if (shieldPct > 0 || flash > 0) {
        const k = shieldPct / 100;
        const wob = 1 + 0.015 * Math.sin(this.c.time * 3 + id);
        const grow = 1 + 0.04 * flash + 0.12 * rf * rf;
        const b = (r * wob * grow) / (64 * BUBBLE_RIM);
        // (Flicker: the thin screen shimmers; the rest breathe slowly)
        const sh = look.shimmer ? 1 - look.shimmer * (0.5 + 0.5 * Math.sin(this.c.time * 47 + id) * Math.sin(this.c.time * 29 + id * 2)) : 1;
        // At rest only the rim shows (your own fainter, by the setting; others' with a trace of fill so they read as
        // shielded); the filled bubble over the hull comes up on a hit (short: flash²) and while it recharges
        const own = id === this.c.state.playerId;
        const rest = (look.base + look.fill * k) * sh * (own ? settings.data.display.ownShield : 1);
        const f2 = flash * flash;
        const tint = flash > 0.3 ? look.hit : rf > 0.3 ? 0xffffff : look.tint;
        const rim = rest + 0.35 * flash + 0.15 * rg + 0.8 * rf;
        const fill = (own ? 0 : 0.3 * rest) + 0.55 * f2 + 0.18 * rg + 0.3 * rf;
        this.c.p.shieldSprites.take(bubbleRim(), e.renderX, e.renderY, 0.5, 0.5, tint, rim, 0, b, b);
        if (fill > 0.01) this.c.p.shieldSprites.take(bubble(), e.renderX, e.renderY, 0.5, 0.5, tint, fill, 0, b, b);
        if (look.inner) this.c.p.shieldSprites.take(bubbleRim(), e.renderX, e.renderY, 0.5, 0.5, look.inner, rim * 0.8, 0, b * 0.9, b * 0.9);
        if (look.hex) this.c.p.shieldSprites.take(hexShield(), e.renderX, e.renderY, 0.5, 0.5, look.hex, (0.06 + 0.12 * k) * sh * (own ? settings.data.display.ownShield : 1) + 0.45 * f2 + 0.15 * rg, this.c.time * 0.05 + id, b, b);
        if (rf > 0) this.c.p.shieldSprites.take(glowBall(), e.renderX, e.renderY, 0.5, 0.5, 0xffffff, 0.7 * rf, 0, (r * (1.1 + 0.5 * (1 - rf))) / DOT_SIZE, (r * (1.1 + 0.5 * (1 - rf))) / DOT_SIZE);
      }
      if (emp && Math.random() < 0.5 * frames) {
        // (Sparks on a live part, not a random spot in the hull's disc)
        const parts = ship.derived.alive;
        let pi = (Math.random() * parts.length) | 0;
        for (let k = 0; k < parts.length && !parts[pi]; k++) pi = (pi + 1) % parts.length;
        const c = parts[pi] ? this.c.source.geometry(ship)[pi]?.centroid : undefined;
        let px = e.renderX, py = e.renderY;
        if (c) {
          const cs = this.c.source.tuning.cellSize, ang = e.renderAngle + Math.PI / 2, ca = Math.cos(ang), sa = Math.sin(ang);
          const lx = (c[0] - ship.derived.com[0]) * cs, ly = (c[1] - ship.derived.com[1]) * cs;
          px += lx * ca - ly * sa; py += lx * sa + ly * ca;
        }
        this.c.p.arc(px, py, e.vx, e.vy, Math.random() * Math.PI * 2, Math.min(r * 0.5, 30), 6);
      }
    }
  }

  /** A shot struck at (x, y): if that's on a shielded ship, its bubble lights up there */
  shieldHit(x: number, y: number, model?: string): void {
    const m = model === 'pulse_strobe' ? 1 : model === 'pulse_overpulse' ? 2 : 0;
    this.platingHit(x, y);
    for (const [id, pct] of this.lastShield) {
      if (pct <= 0) continue;
      const e = this.c.state.entities.get(id), ship = this.c.source.get(id);
      if (!e || !ship) continue;
      const r = ship.derived.radius * 1.12 + 10;
      if (Math.hypot(x - e.renderX, y - e.renderY) > r * 1.25) continue;
      this.rippledAt.set(id, performance.now());
      // (At the hull where the server's hit landed, not out on the bubble's rim: the shot met the parts, not a circle)
      if (this.ripples.length < 40) this.ripples.push({ id, a: Math.atan2(y - e.renderY, x - e.renderX) - e.renderAngle, d: Math.min(r, Math.hypot(x - e.renderX, y - e.renderY)), life: 0, model: m });
    }
  }

  /** Is a raised shield's bubble at (x, y)? A shell striking there ripples it (shieldHit): heard as shield_hit */
  bubbleAt(x: number, y: number): boolean {
    for (const [id, pct] of this.lastShield) {
      if (pct <= 0) continue;
      const e = this.c.state.entities.get(id), ship = this.c.source.get(id);
      if (!e || !ship) continue;
      if (Math.hypot(x - e.renderX, y - e.renderY) <= (ship.derived.radius * 1.12 + 10) * 1.25) return true;
    }
    return false;
  }

  /**
   * A shot struck at (x, y): on a ship's plating (no shield up), Reactive Armour throws bright sparks off and flicks a
   * ring where it deflects; Spaced Plating throws chips and a puff of dust, and the outer plate peels away a little more
   * the harder it's hurt. The part is found from where the shot landed (the wire carries no part).
   */
  private platingHit(x: number, y: number): void {
    for (const [id, ship] of this.c.source.bodies) {
      const e = this.c.state.entities.get(id);
      if (!e || ship.kind !== 'ship' || (this.lastShield.get(id) ?? 0) > 0) continue;
      const R = ship.derived.radius + 12;
      if (Math.abs(x - e.renderX) > R || Math.abs(y - e.renderY) > R) continue;
      const parts = ship.blueprint.parts;
      const cs = this.c.source.tuning.cellSize, a = e.renderAngle + Math.PI / 2, ca = Math.cos(a), sa = Math.sin(a);
      const dx = x - e.renderX, dy = y - e.renderY;
      const [cx, cy] = ship.derived.com;
      const gx = cx + (dx * ca + dy * sa) / cs, gy = cy + (-dx * sa + dy * ca) / cs;
      const geoms = this.c.source.geometry(ship);
      let hit = -1, bd = 0.9;
      for (let i = 0; i < parts.length; i++) {
        if (!ship.derived.alive[i]) continue;
        if (!shipFunction(parts[i].fn)?.platingHit) continue;
        const c = geoms[i]?.centroid;
        if (!c) continue;
        const d = Math.hypot(c[0] - gx, c[1] - gy);
        if (d < bd) { bd = d; hit = i; }
      }
      if (hit < 0) continue;
      const reactive = shipFunction(parts[hit].fn)?.platingHit === 'sparks';
      // (thrown off the plate in the ship's frame: they ride it, impactAnchor, so they don't smear behind it as it flies)
      const anc = this.c.p.anchors.open(this.c.state.entities, id, x, y), n0 = this.c.p.ps.length, bv = anc ? 0 : 1;
      if (reactive) {
        this.c.p.burstSparks(x, y, e.vx * bv, e.vy * bv, 7, 3, 9, 0xffe9a0);
        this.c.p.glow(x, y, e.vx * bv, e.vy * bv, 7, 5, 0xfff2c8, 0.7);
        this.c.p.ring(x, y, e.vx * bv, e.vy * bv, 3, 13, 8, 0xffd98a, 0.5);
      } else {
        const hurt = ship.maxHp[hit] > 0 ? 1 - ship.hp[hit] / ship.maxHp[hit] : 0;
        this.c.p.chunks(x, y, e.vx * bv, e.vy * bv, 2 + Math.round(3 * hurt), 1.3, 3, 0x8a929e);
        this.c.p.dustPuff(x, y, e.vx * bv, e.vy * bv, 6, 40, 0x8a857e, 0.3);
        this.c.p.burstSparks(x, y, e.vx * bv, e.vy * bv, 3, 1.5, 4, 0xc9d0da);
      }
      if (anc) for (let i = n0; i < this.c.p.ps.length; i++) { this.c.p.ps[i].anc = anc; anc.hold(this.c.p.ps[i].max + 2); }
      return;
    }
  }

  /** A Flash Screen came back at (x, y) (the server's ShieldFlash effect, seen even when the shield never showed as empty): bloom the nearest bubble */
  shieldReform(x: number, y: number): void {
    let best = -1, bd = Infinity;
    for (const [id, ship] of this.c.source.bodies) {
      const e = this.c.state.entities.get(id);
      if (!e || ship.kind !== 'ship') continue;
      const d = Math.hypot(e.renderX - x, e.renderY - y);
      if (d < bd) { bd = d; best = id; }
    }
    if (best >= 0 && bd < 300) this.reform.set(best, 1);
  }

  drawRipples(frames: number): void {
    for (let i = this.ripples.length - 1; i >= 0; i--) {
      const rp = this.ripples[i];
      rp.life += frames;
      const e = this.c.state.entities.get(rp.id), ship = this.c.source.get(rp.id);
      if (rp.life >= 18 || !e || !ship) { this.ripples.splice(i, 1); continue; }
      const k = rp.life / 18, r = ship.derived.radius * 1.12 + 10, a = rp.a + e.renderAngle;
      // A patch of shield over the struck spot, spreading as it fades
      // (Sized to the strike, capped: a boss's bubble is huge, and its whole rim lighting up read as the shot meeting a circle)
      const rr = Math.min(r, 90);
      const px = e.renderX + Math.cos(a) * rp.d, py = e.renderY + Math.sin(a) * rp.d, fade = Math.pow(1 - k, 1.5);
      // Strobe flares the rim pink; Overpulse cracks the bubble; every other gun is the pale ripple
      const tint = rp.model === 1 ? 0xff4fb0 : rp.model === 2 ? 0xff6ee8 : 0xe0faff;
      this.c.p.addSprites.take(glowBall(), px, py, 0.5, 0.5, tint, fade, a, (rr * 0.3) / DOT_SIZE, (rr * (0.6 + 1.0 * k)) / DOT_SIZE);
      if (rp.model === 1) {
        // The rim itself: a bright arc across the struck spot, tangent to the bubble
        this.c.p.addSprites.take(streak(), px, py, 0.5, 0.5, 0xff8fd0, fade, a + Math.PI / 2, streakScale(rr * 0.9, 5).x, streakScale(rr * 0.9, 5).y);
      } else if (rp.model === 2) {
        // Cracks: jagged radial lines from the strike, fixed per ripple, lengthening then fading
        const len = rr * (0.45 + 0.4 * Math.min(1, k * 3));
        for (let c = 0; c < 6; c++) {
          const ca = a + c * (Math.PI / 3) + Math.sin(rp.a * 7 + c * 2.1) * 0.35;
          const sc = streakScale(len * (0.6 + 0.4 * ((c * 5) % 3) / 2), 2.5);
          this.c.p.addSprites.take(streak(), px, py, 0, 0.5, 0xfff0fb, fade, ca, sc.x, sc.y);
        }
      }
    }
  }
}
