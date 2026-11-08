/**
 * @contract client.damage.events
 * owns:       one-off effects the server or the world announces: hulls grinding, a boss dying, point defence firing, a
 *             station turret firing, a part repaired
 * needs:      DamageCtx (particles, sound, shake, delayed actions), detonations (a boss's death chains blasts)
 * invariants: a boss's death is nine blasts across its hull then one huge one — none pinned
 * extend:     a new announced effect is one function below and one forwarding method on DamageFx
 */

import type { ServerContactMessage } from '@space-game/common';
import { shotSoundForKind } from '../../audio/weaponSounds';
import type { DamageCtx } from './context';
import { detonate } from './detonations';

/** A point-defence turret's shot (its part's sfxTurret) */
const PD_SOUND = shotSoundForKind('point_defence', true, 'turret_shot');

/** Hulls grinding together: sparks thrown along the surface, a flash, some grit */
export function contact(c: DamageCtx, m: ServerContactMessage): void {
  const k = Math.min(1, m.speed / 6);
  const tx = -m.ny, ty = m.nx;
  const n = Math.round(10 + 26 * k);
  for (let i = 0; i < n; i++) {
    const side = Math.random() < 0.5 ? -1 : 1;
    const s = (2 + Math.random() * 6) * (0.5 + k);
    const spread = (Math.random() - 0.5) * 0.9;
    c.p.spark(m.x, m.y, (tx * side + m.nx * spread) * s, (ty * side + m.ny * spread) * s, 10 + Math.random() * 18, Math.random() < 0.3 ? 0xffffff : 0xffc46b);
  }
  c.p.glow(m.x, m.y, 0, 0, 10 + 22 * k, 5, 0xffe2b0, 0.8);
  for (let i = 0; i < 2 + 4 * k; i++) c.p.dustPuff(m.x, m.y, (Math.random() - 0.5) * 1.2, (Math.random() - 0.5) * 1.2, 8 + Math.random() * 10, 40, 0x9a948c, 0.35);
  c.sound('bump', { x: m.x, y: m.y }, 0.15 + 0.55 * k * k);
  if (c.near(m.x, m.y, 900)) c.state.triggerScreenShake(2 + 6 * k, 0.2);
}

/** A boss dies: a chain of blasts across its hull, then one huge one */
export function bossDefeated(c: DamageCtx, x: number, y: number): void {
  for (let i = 0; i < 9; i++) {
    c.later(i * 0.16, () => {
      const a = Math.random() * Math.PI * 2, d = 40 + Math.random() * 160;
      detonate(c, 'missile', x + Math.cos(a) * d, y + Math.sin(a) * d, 110 + Math.random() * 90);
    });
  }
  c.later(1.6, () => {
    c.p.glow(x, y, 0, 0, 520, 14, 0xffffff, 1);
    c.p.glow(x, y, 0, 0, 380, 40, 0xffb347, 0.9, 2);
    c.p.ring(x, y, 0, 0, 60, 1400, 40, 0xffe6c0, 0.8);
    c.p.ring(x, y, 0, 0, 30, 900, 30, 0xff8a2b, 0.7);
    c.p.burstSparks(x, y, 0, 0, 90, 6, 18, 0xffc46b);
    for (let i = 0; i < 16; i++) c.p.dustPuff(x, y, (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 3, 90 + Math.random() * 60, 160, 0x3a3634, 0.5, 0.6);
    c.sound('explosion_large', { x, y }, 1);
    if (c.near(x, y, 4000)) c.state.triggerScreenShake(18, 0.9);
  });
}

/**
 * A station's defence turret fired on a hostile, from `from`: a laser's red
 * bolt, flak's tracers bursting on the target, or the lance's heavy beam.
 */
/**
 * Point defence fired (common/src/ships/features/support/support.ts): a hot tracer from its muzzle to the shot, a flash where it
 * struck, and brought down, the shot pops (a puff and a ring, small: its warhead never went off)
 */
export function intercept(c: DamageCtx, m: { x: number; y: number; fx: number; fy: number; down: boolean }): void {
  const dx = m.x - m.fx, dy = m.y - m.fy;
  c.p.push({ kind: 'beam', x: m.fx, y: m.fy, vx: 0, vy: 0, life: 0, max: 8, size: 3, grow: 0, color: 0xff8a1a, alpha: 1, drag: 1, rot: 0, vr: 0, pts: [dx, dy] });
  c.p.glow(m.fx, m.fy, 0, 0, 16, 5, 0xffb060, 0.9);
  c.p.glow(m.x, m.y, 0, 0, 22, 6, 0xfff1d0, 1);
  if (m.down) {
    c.p.glow(m.x, m.y, 0, 0, 46, 12, 0xffb24a, 0.9, 0.8);
    c.p.ring(m.x, m.y, 0, 0, 8, 60, 12, 0xffd08a, 0.8);
    c.p.burstSparks(m.x, m.y, 0, 0, 10, 1.5, 6, 0xffa040);
    for (let i = 0; i < 2; i++) c.p.dustPuff(m.x, m.y, (Math.random() - 0.5) * 0.8, (Math.random() - 0.5) * 0.8, 18 + Math.random() * 10, 40, 0x3a3634, 0.45, 0.3);
    c.sound('explosion_small', { x: m.x, y: m.y }, 0.35);
  } else c.p.burstSparks(m.x, m.y, 0, 0, 4, 1, 4, 0xffd080);
  c.sound(PD_SOUND, { x: m.fx, y: m.fy }, 0.35);
}

export function stationFire(c: DamageCtx, from: { x: number; y: number; weapon: string; color: number }, target: number): void {
  const t = c.state.entities.get(target);
  if (!t) return;
  const { x, y, color } = from;
  const dx = t.renderX - x, dy = t.renderY - y, d = Math.hypot(dx, dy) || 1;
  if (from.weapon === 'flak') {
    // Tracers, then a burst of black smoke and shrapnel on the target as they arrive
    const speed = 70, frames = Math.max(4, d / speed);
    for (let i = 0; i < 2; i++) {
      const j = (Math.random() - 0.5) * 0.05;
      const cj = Math.cos(j), s = Math.sin(j);
      c.p.push({ kind: 'spark', x, y, vx: ((dx * cj - dy * s) / d) * speed, vy: ((dx * s + dy * cj) / d) * speed, life: 0, max: frames, size: 1.8, grow: 0, color, alpha: 1, drag: 1, rot: 0, vr: 0 });
    }
    c.p.glow(x, y, 0, 0, 22, 5, 0xffe0b0, 0.9);
    c.later(frames / 60, () => {
      const bx = t.renderX + (Math.random() - 0.5) * 80, by = t.renderY + (Math.random() - 0.5) * 80;
      c.p.glow(bx, by, t.vx, t.vy, 48, 8, 0xffd9a0, 0.95);
      c.p.glow(bx, by, t.vx, t.vy, 26, 20, 0xff8a2b, 0.6, 0.6);
      c.p.burstSparks(bx, by, t.vx, t.vy, 12, 2, 8, 0xffb050);
      for (let i = 0; i < 2; i++) c.p.dustPuff(bx, by, t.vx * 0.5 + (Math.random() - 0.5), t.vy * 0.5 + (Math.random() - 0.5), 26 + Math.random() * 16, 60, 0x2e2a28, 0.55, 0.3);
    });
    c.sound('flak_shot', { x, y }, 0.45);
    return;
  }
  if (from.weapon === 'lance') {
    // A thick violet beam that thins as it fades, a flare at both ends
    c.p.push({ kind: 'beam', x, y, vx: 0, vy: 0, life: 0, max: 18, size: 11, grow: 0, color, alpha: 1, drag: 1, rot: 0, vr: 0, pts: [dx, dy] });
    c.p.glow(x, y, 0, 0, 40, 10, 0xe4dcff, 1);
    c.p.glow(t.renderX, t.renderY, t.vx, t.vy, 60, 14, color, 0.95);
    c.p.ring(t.renderX, t.renderY, t.vx, t.vy, 10, 90, 16, 0xd6ccff, 0.6);
    c.p.burstSparks(t.renderX, t.renderY, t.vx, t.vy, 14, 3, 9, 0xd6ccff);
    c.sound('railgun_shot', { x, y }, 0.6);
    return;
  }
  // (Lasers are pulses: MiningBeamFx.stationPulse)
}

/** A part came back (station repair): sparkles drawing in, then a soft flash */
export function partRestored(c: DamageCtx, bodyId: number, part: number): void {
  const p = c.partWorld(bodyId, part);
  if (!p) return;
  for (let i = 0; i < 18; i++) {
    const a = Math.random() * Math.PI * 2, r = 30 + Math.random() * 30;
    const life = 24 + Math.random() * 10;
    c.p.ps.push({ kind: 'spark', x: p.x + Math.cos(a) * r, y: p.y + Math.sin(a) * r, vx: -Math.cos(a) * r / life + p.vx, vy: -Math.sin(a) * r / life + p.vy,
      life: 0, max: life, size: 1.4, grow: 0, color: 0x8ff6ff, alpha: 0.9, drag: 1, rot: 0, vr: 0 });
  }
  c.later(0.4, () => {
    c.p.glow(p.x, p.y, p.vx, p.vy, 26, 14, 0x9ffcff, 0.7);
    c.p.ring(p.x, p.y, p.vx, p.vy, 8, 36, 16, 0x9ffcff, 0.6);
  });
  c.sound('repair_part', { x: p.x, y: p.y }, 0.8);
}
