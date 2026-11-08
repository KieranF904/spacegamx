/**
 * @contract client.weapon-fx.shot-factory
 * owns:       building a Shot record from a server projectile row (shotFromRow) or from a shell your client fired ahead (shotFromPrediction)
 * needs:      weaponStyles (weaponStyle, shotScale), ordnanceTells (landingPoint), shotTypes, particleTypes (colour helpers); npm: @space-game/common
 * invariants: a predicted shell takes the server's id and keeps its flight when the server's copy arrives — client/src/rendering/weapons/adoptHit.test.ts
 * extend:     a new per-shell field is initialised in both builders below (and declared on Shot)
 */

import { WeaponType } from '@space-game/common';
import type { InterpolatedEntity } from '../../../state/GameState';
import { weaponStyle, shotScale, type WeaponStyle } from '../weaponStyles';
import { landingPoint } from '../ordnanceTells';
import { hueColor, mixColor } from './particleTypes';
import type { FirePoseXY, PredictedShell, ShellLook, Shot } from './shotTypes';

/** A stream's accent: every nth round bright, the rest dim */
export function dimOf(style: WeaponStyle, n: number): number {
  return style.accent && n % style.accent.every !== 0 ? style.accent.dim : 1;
}

/** The shell a projectile row brings (`look`: its gun's model and damage, `pose`: the firing ship's pose on the fire tick, where known) */
export function shotFromRow(e: InterpolatedEntity, look: ShellLook | undefined, pose: FirePoseXY | undefined): Shot {
  const type = e.data?.[0] ?? WeaponType.Cannon;
  // data[1]: the gun's grade
  const style = weaponStyle(type, e.data?.[1] ?? 1, look?.model);
  const hue = e.data?.[2] ?? 30;
  const shot: Shot = {
    id: e.id,
    style,
    size: e.data?.[7] || 1,
    power: shotScale(look?.damage),
    phase: (e.id * 0.618) % 1, dim: dimOf(style, e.id), hot: 0,
    type,
    owner: e.data?.[6] ?? -1,
    glow: type === WeaponType.PrismShard ? hueColor((e.id * 67) % 360) : mixColor(style.glowColor, hueColor(hue), style.ownerTint),
    spawnX: e.spawnX ?? e.x,
    spawnY: e.spawnY ?? e.y,
    spawnTick: e.spawnTick ?? 0,
    vx: e.vx,
    vy: e.vy,
    hit: null,
    flashed: false,
    model: look?.model, grade: e.data?.[1] ?? 1, turret: e.data?.[8] === 1,
    predicted: false,
    pose,
    endTick: e.data?.[9] ?? 0, landX: 0, landY: 0, splash: look?.splash ?? 0, arc: 0, t: 0, pulse: 0,
    fading: null, pierceLeft: look?.pierce ?? 0,
    endAt: look?.life ? (e.spawnTick ?? 0) + look.life : Infinity, gone: false, pending: null,
    head: null,
    tail: null, ctX: NaN, ctY: NaN,
    ended: false, endedAt: 0, passed: null, unconfirmed: 0, arm: look?.arm ?? 0,
  };
  if (shot.endTick > 0) {
    const o = { x: 0, y: 0 };
    landingPoint(shot.spawnX, shot.spawnY, shot.vx, shot.vy, shot.spawnTick, shot.endTick, o);
    shot.landX = o.x; shot.landY = o.y;
  }
  return shot;
}

/** A shell your client fired ahead of the server, under the negative id `id` */
export function shotFromPrediction(id: number, p: PredictedShell): Shot {
  const style = weaponStyle(p.type, p.grade, p.model);
  return {
    id, style, size: p.size, power: shotScale(p.damage), phase: (-id * 0.618) % 1, dim: dimOf(style, -id), hot: 0, type: p.type, owner: p.owner,
    glow: mixColor(style.glowColor, hueColor((p.owner * 137) % 360), style.ownerTint),
    spawnX: p.spawnX, spawnY: p.spawnY, spawnTick: p.spawnTick, vx: p.vx, vy: p.vy,
    hit: null, flashed: false, model: p.model, grade: p.grade ?? 1, turret: p.turret ?? false, predicted: true, pose: p.pose, endTick: 0, landX: 0, landY: 0, splash: 0, arc: 0, t: 0, pulse: 0, fading: null, pierceLeft: p.pierce ?? 0,
    endAt: p.life ? p.spawnTick + p.life : Infinity, gone: false, pending: null, head: null, tail: null, ctX: NaN, ctY: NaN,
    ended: false, endedAt: 0, passed: null, unconfirmed: 0, arm: p.arm ?? 0,
  };
}
