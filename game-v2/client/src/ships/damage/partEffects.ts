/**
 * @contract client.damage.partEffects
 * owns:       what a destroyed part looks, sounds and shakes like, by the part's kind and how it died
 * needs:      DamageCtx (particles, sound, shake, delayed actions), common lookFn
 * invariants: a crumbling part throttles its sound — none pinned
 * extend:     a new kind of part is one case in partDestroyed and a function below
 */

import { lookFn, type ServerPartDestroyedMessage } from '@space-game/common';
import type { DamageCtx } from './context';

export function partDestroyed(c: DamageCtx, m: ServerPartDestroyedMessage): void {
  const { x, y, vx, vy } = m;
  if (m.how === 'crumble') return crumble(c, x, y, vx, vy, m.size);
  switch (lookFn(m.fn)) {
    case 'core': return coreBlast(c, x, y, vx, vy, m.size);
    case 'generator': return m.how === 'blast' ? electricBlast(c, x, y, vx, vy, m.size) : hullBreak(c, x, y, vx, vy, m.size);
    case 'thruster': case 'afterburner': case 'plasma_drive': return m.how === 'blast' ? fireBurst(c, x, y, vx, vy, m.size) : hullBreak(c, x, y, vx, vy, m.size);
    case 'weapon': return m.how === 'blast' ? cookOff(c, x, y, vx, vy, m.size) : hullBreak(c, x, y, vx, vy, m.size);
    case 'armor': return armorBreak(c, x, y, vx, vy, m.size);
    case 'conduit': return shortOut(c, x, y, vx, vy, m.size);
    default: return hullBreak(c, x, y, vx, vy, m.size);
  }
}

export function coreBlast(c: DamageCtx, x: number, y: number, vx: number, vy: number, r: number): void {
  // White flash, then a fireball that swells, reddens and fades into smoke
  c.p.glow(x, y, vx, vy, r * 1.6, 8, 0xffffff, 1);
  for (let i = 0; i < 9; i++) {
    const a = Math.random() * Math.PI * 2, d = Math.random() * r * 0.5;
    c.p.glow(x + Math.cos(a) * d, y + Math.sin(a) * d, vx + Math.cos(a) * 0.6, vy + Math.sin(a) * 0.6, r * (0.5 + Math.random() * 0.6), 30 + Math.random() * 25, i % 3 ? 0xff8a2b : 0xffd27a, 0.75, r * 0.02);
  }
  c.p.ring(x, y, vx, vy, r * 0.3, r * 3.2, 26, 0xffe6c0, 0.7);
  c.p.ring(x, y, vx, vy, r * 0.2, r * 2, 18, 0xffffff, 0.5);
  c.p.burstSparks(x, y, vx, vy, 60, 4, 12, 0xffc46b);
  c.p.chunks(x, y, vx, vy, 14, 2.5, r * 0.18);
  for (let i = 0; i < 16; i++) {
    const a = Math.random() * Math.PI * 2, s = Math.random() * 1.6;
    c.p.dustPuff(x, y, vx + Math.cos(a) * s, vy + Math.sin(a) * s, r * (0.4 + Math.random() * 0.5), 120 + Math.random() * 90, 0x3a3634, 0.55, r * 0.012);
  }
  c.sound('explosion_large', { x, y });
  if (c.near(x, y, 2500)) c.state.triggerScreenShake(14, 0.6);
}

export function electricBlast(c: DamageCtx, x: number, y: number, vx: number, vy: number, r: number): void {
  c.p.glow(x, y, vx, vy, r * 1.4, 10, 0xd9f6ff, 1);
  c.p.glow(x, y, vx, vy, r * 0.9, 26, 0x4fb8ff, 0.7, r * 0.02);
  c.p.ring(x, y, vx, vy, r * 0.2, r * 2.2, 18, 0x9fe0ff, 0.7);
  for (let i = 0; i < 7; i++) c.p.arc(x, y, vx, vy, Math.random() * Math.PI * 2, r * (0.9 + Math.random() * 0.8), 14 + Math.random() * 10);
  c.p.burstSparks(x, y, vx, vy, 34, 3, 9, 0x9fe0ff);
  c.p.chunks(x, y, vx, vy, 5, 1.8, r * 0.14);
  for (let i = 0; i < 6; i++) c.p.dustPuff(x, y, vx + (Math.random() - 0.5), vy + (Math.random() - 0.5), r * 0.4, 90, 0x403f48, 0.4, r * 0.01);
  c.sound('generator_blast', { x, y });
  if (c.near(x, y, 1500)) c.state.triggerScreenShake(7, 0.35);
}

export function fireBurst(c: DamageCtx, x: number, y: number, vx: number, vy: number, r: number): void {
  // Fire with a direction to it: the fuel jets out one way
  const dir = Math.random() * Math.PI * 2;
  c.p.glow(x, y, vx, vy, r * 1.2, 8, 0xfff0c8, 1);
  for (let i = 0; i < 26; i++) {
    const a = dir + (Math.random() - 0.5) * 0.9, s = 1.5 + Math.random() * 4;
    c.p.glow(x, y, vx + Math.cos(a) * s, vy + Math.sin(a) * s, r * (0.18 + Math.random() * 0.22), 18 + Math.random() * 16, Math.random() < 0.4 ? 0xffd27a : 0xff7a2b, 0.7, r * 0.015);
  }
  c.p.burstSparks(x, y, vx, vy, 24, 3, 9, 0xffb050);
  c.p.chunks(x, y, vx, vy, 4, 2, r * 0.15);
  for (let i = 0; i < 8; i++) c.p.dustPuff(x, y, vx + Math.cos(dir) * Math.random() * 2, vy + Math.sin(dir) * Math.random() * 2, r * 0.45, 100, 0x3d3833, 0.45, r * 0.012);
  c.sound('thruster_blast', { x, y });
  if (c.near(x, y, 1200)) c.state.triggerScreenShake(5, 0.3);
}

export function cookOff(c: DamageCtx, x: number, y: number, vx: number, vy: number, r: number): void {
  // The magazine goes off round by round
  const pops = 4 + Math.floor(Math.random() * 3);
  for (let i = 0; i < pops; i++) {
    c.later(i * (0.07 + Math.random() * 0.08), () => {
      const a = Math.random() * Math.PI * 2, d = Math.random() * r * 0.5;
      const px = x + vx * 6 * i + Math.cos(a) * d, py = y + vy * 6 * i + Math.sin(a) * d;
      c.p.glow(px, py, vx, vy, r * (0.4 + Math.random() * 0.4), 7, 0xffe6a8, 0.95);
      c.p.burstSparks(px, py, vx, vy, 10, 3, 7, 0xffd28a);
    });
  }
  c.p.chunks(x, y, vx, vy, 3, 1.6, r * 0.18);
  c.sound('weapon_cookoff', { x, y });
}

export function armorBreak(c: DamageCtx, x: number, y: number, vx: number, vy: number, size: number): void {
  // Heavy plates crack off: big slow chunks, a few sparks, no fire
  c.p.glow(x, y, vx, vy, size * 0.7, 6, 0xfff2dc, 0.6);
  c.p.chunks(x, y, vx, vy, 6, 1.1, size * 0.32, 0x7a7f88);
  c.p.burstSparks(x, y, vx, vy, 12, 2, 6, 0xffd9a0);
  for (let i = 0; i < 4; i++) c.p.dustPuff(x, y, vx + (Math.random() - 0.5) * 0.8, vy + (Math.random() - 0.5) * 0.8, size * 0.5, 70, 0x8a857e, 0.35);
  c.sound('armor_break', { x, y });
}

export function hullBreak(c: DamageCtx, x: number, y: number, vx: number, vy: number, size: number): void {
  c.p.glow(x, y, vx, vy, size * 0.9, 7, 0xffe2b0, 0.75);
  c.p.chunks(x, y, vx, vy, 5, 1.8, size * 0.2);
  c.p.burstSparks(x, y, vx, vy, 18, 2.5, 8, 0xffc46b);
  for (let i = 0; i < 3; i++) c.p.dustPuff(x, y, vx + (Math.random() - 0.5), vy + (Math.random() - 0.5), size * 0.45, 60, 0x6e6a66, 0.35);
  c.sound('part_break', { x, y });
}

export function shortOut(c: DamageCtx, x: number, y: number, vx: number, vy: number, size: number): void {
  c.p.glow(x, y, vx, vy, size * 0.8, 8, 0xcff2ff, 0.8);
  for (let i = 0; i < 4; i++) c.p.arc(x, y, vx, vy, Math.random() * Math.PI * 2, size * (1 + Math.random()), 10 + Math.random() * 8);
  c.p.burstSparks(x, y, vx, vy, 16, 2.5, 7, 0xbfe8ff);
  c.p.chunks(x, y, vx, vy, 2, 1.5, size * 0.15);
  c.sound('conduit_spark', { x, y });
}

export function crumble(c: DamageCtx, x: number, y: number, vx: number, vy: number, size: number): void {
  for (let i = 0; i < 4; i++) c.p.dustPuff(x, y, vx + (Math.random() - 0.5) * 0.5, vy + (Math.random() - 0.5) * 0.5, size * 0.4, 80 + Math.random() * 40, 0x7d7873, 0.3, size * 0.006);
  c.p.chunks(x, y, vx, vy, 3, 0.5, size * 0.16);
  for (let i = 0; i < 4; i++) c.p.spark(x, y, vx + (Math.random() - 0.5) * 1.2, vy + (Math.random() - 0.5) * 1.2, 30 + Math.random() * 30, 0xff9a4a);
  if (c.time - c.lastCrumbleSound > 0.25) {
    c.lastCrumbleSound = c.time;
    c.sound('disintegrate', { x, y }, 0.45);
  }
}
