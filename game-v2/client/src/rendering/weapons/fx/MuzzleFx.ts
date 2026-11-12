/**
 * @contract client.weapon-fx.muzzle
 * owns:       the muzzle flash, casings and coil rings a shell makes as it leaves its barrel (its fire, smoke and fragments are muzzleBlasts'), and a prism's split pop
 * needs:      FxField (flash, spark and shock lists), muzzleBlasts, MuzzleHost (onMuzzle, barrelTip, spinAt), weaponStyles (muzzleScale)
 * invariants: the flash and the shell are drawn from the barrel's tip, the shell easing onto its true path — client/src/rendering/weapons/visualStop.test.ts
 *             a minigun throws more brass the faster it spins — client/src/rendering/weapons/fx/fxInvariants.test.ts
 * extend:     a new muzzle part is one block in flash, driven by a field of WeaponStyle.muzzle
 */

import type { FxField } from './FxField';
import { muzzleScale } from '../weaponStyles';
import type { Shot } from './shotTypes';
import { muzzleBlast } from './muzzleBlasts';
import { modMuzzle } from './mods';

/** What a muzzle flash asks of the ship renderer (read live: the owner sets them after construction) */
export interface MuzzleHost {
  readonly onMuzzle: ((owner: number, x: number, y: number, power: number) => void) | null;
  readonly barrelTip: ((owner: number, x: number, y: number, angle: number) => { x: number; y: number } | null) | null;
  readonly spinAt: ((owner: number, x: number, y: number) => number) | null;
}

/** A flash is drawn this much longer than its style's `life` (frames) */
const FLASH_LINGER = 1.3;
export class MuzzleFx {
  constructor(private readonly f: FxField, private readonly host: MuzzleHost) {}

  /** Where a prism splits: each shard throws a ring and a few sparks in its own hue, so the five make a rainbow pop */
  split(shot: Shot): void {
    const angle = Math.atan2(shot.vy, shot.vx);
    this.f.shocks.push({ x: shot.spawnX, y: shot.spawnY, life: 0, max: 14, size: 34, width: 2.2, color: shot.glow });
    this.f.hitGlows.push({ x: shot.spawnX, y: shot.spawnY, life: 0, max: 8, size: 12, color: 0xffffff, core: true });
    for (let i = 0; i < 4; i++) {
      const a = angle + (Math.random() - 0.5) * 0.5, v = 3 + Math.random() * 3;
      this.f.sparks.push({ x: shot.spawnX, y: shot.spawnY, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0, max: 14 + Math.random() * 8, color: shot.glow });
    }
  }

  /** A shot leaving its barrel: the flash of its gun's kind, pinned to the gun, its casings and rings, and what the blast throws out */
  flash(shot: Shot, owner?: { renderX: number; renderY: number; renderAngle: number }): void {
    const m = shot.style.muzzle;
    const angle = Math.atan2(shot.vy, shot.vx);
    this.host.onMuzzle?.(shot.owner, shot.spawnX, shot.spawnY, shot.power);
    // At the drawn barrel's tip (shells spawn on the facing edge, the barrel pokes out past it), and the shell drawn from there too
    const tip = this.host.barrelTip?.(shot.owner, shot.spawnX, shot.spawnY, angle);
    if (tip) { shot.vox = tip.x - shot.spawnX; shot.voy = tip.y - shot.spawnY; }
    const x = tip?.x ?? shot.spawnX, y = tip?.y ?? shot.spawnY;
    // (in step with the shot through the usual range, never a speck, and growing slower past a heavy launch: muzzleScale)
    const size = m.size * muzzleScale(shot.size * shot.power), kind = shot.style.blast ?? 'powder';
    if (shot.style.heat) shot.hot = Math.max(0, Math.min(1, this.host.spinAt?.(shot.owner, shot.spawnX, shot.spawnY) ?? 0));
    // The barrel in the ship's frame: from the ship's pose on the fire tick (exact), else as it's drawn now (it's drawn at that tick)
    const ref = shot.pose ?? (owner ? { x: owner.renderX, y: owner.renderY, angle: owner.renderAngle } : undefined);
    const oa = ref?.angle ?? 0, c = Math.cos(-oa), sn = Math.sin(-oa);
    const dx = ref ? x - ref.x : 0, dy = ref ? y - ref.y : 0;
    this.f.flashes.push({
      x, y, angle, life: 0, max: m.life * FLASH_LINGER, size, color: m.color,
      sparks: Array.from({ length: m.sparks }, () => ({ a: (Math.random() - 0.5) * 0.7, l: size * (0.9 + Math.random() * 1.1) })),
      petals: [(1.6 + Math.random() * 0.8) * (m.tongue ?? 1), 0.6 + Math.random() * 0.3, 0.6 + Math.random() * 0.3], girth: m.girth ?? 1, kind,
      owner: owner ? shot.owner : -1, ox: dx * c - dy * sn, oy: dx * sn + dy * c, rel: angle - oa,
    });
    // Spent casings flung out to the side, tumbling away
    // (a minigun throws more brass the faster it spins)
    const brass = Math.round((shot.style.casings ?? 0) * (shot.style.heat ? 0.3 + 0.9 * shot.hot : 1));
    for (let i = 0; i < brass; i++) {
      const side = angle + (Math.random() < 0.5 ? 1 : -1) * (1.2 + Math.random() * 0.5), v = 1.4 + Math.random() * 1.8;
      this.f.sparks.push({ x, y, vx: Math.cos(side) * v, vy: Math.sin(side) * v, life: 0, max: 26 + Math.random() * 14, color: 0xe0b860, width: 2.4 });
    }
    // Shock rings off the muzzle (a rail's coil rings come one after another, each wider)
    const mr = m.ring;
    if (mr) {
      const n = mr.count ?? 1;
      for (let i = 0; i < n; i++) {
        const ahead = i * size * 0.25;
        // (a thin ring racing out, as a layered hit's shock: each later coil ring starts a beat after the last)
        this.f.shocks.push({ x: x + Math.cos(angle) * ahead, y: y + Math.sin(angle) * ahead, life: -i * 2, max: 12 + i * 2, size: size * (mr.size ?? 1) * (0.55 + 0.25 * i), width: Math.max(1.4, size * 0.05), color: mr.color });
      }
    }
    // What it throws out: fire, smoke, fragments, sparks (by its kind)
    muzzleBlast(this.f, kind, x, y, angle, size, m, shot.vx, shot.vy);
    // Its gun's modifiers, each adding its own layer (fx/mods)
    modMuzzle(this.f, shot, x, y, angle, size);
  }
}
