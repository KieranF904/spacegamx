/**
 * Which sound each weapon makes, all from data: a part's `sfx` / `sfxTurret` / `sfxLoop` (data/ships/functions.json and
 * models.json, by its weapon kind), and for projectile kinds no part fires (bosses' own: rivets, seekers...)
 * data/audio.json `shots`. A projectile carries only its kind (WEAPON_KIND_TYPE, the wire's data[0]), so every part
 * of one kind shares that kind's sound (partPresentation.test checks they agree).
 */

import { WEAPON_KIND_TYPE } from '@space-game/common';
import { SHIP_FUNCTIONS } from '../ships/shipFunctionData';
import audioData from '../../../data/audio.json';

export interface ShotSound { sfx: string; turret?: string }

/** data/audio.json `shots`: weapon kind → its shot sound ('' for silent) */
export const KIND_SHOTS = (audioData as unknown as { shots: Record<string, string | ShotSound> }).shots;

/** Weapon kind → its shot sound, plain and from a turret */
export const KIND_SFX = new Map<string, ShotSound>();
for (const f of SHIP_FUNCTIONS) if (f.weapon && f.sfx !== undefined) KIND_SFX.set(f.weapon, { sfx: f.sfx, turret: f.sfxTurret });
for (const [kind, s] of Object.entries(KIND_SHOTS)) if (!kind.startsWith('_')) KIND_SFX.set(kind, typeof s === 'string' ? { sfx: s } : s);

/** Projectile type (WEAPON_KIND_TYPE) → its shot sound */
const BY_TYPE = new Map<number, ShotSound>();
for (const [kind, s] of KIND_SFX) if (WEAPON_KIND_TYPE[kind] !== undefined) BY_TYPE.set(WEAPON_KIND_TYPE[kind], s);

/** Held-beam weapon kind → the loop that plays while it fires */
export const BEAM_LOOP = new Map<string, string>(SHIP_FUNCTIONS.filter((f) => f.weapon && f.sfxLoop).map((f) => [f.weapon!, f.sfxLoop!]));

/** The sound of a shot of projectile type `type`, from a turret or not ('' for none) */
export function shotSoundForType(type: number, turret: boolean): string {
  const s = BY_TYPE.get(type);
  if (!s) return turret ? 'turret_shot' : 'shot';
  return turret && s.turret ? s.turret : s.sfx;
}

/** The sound of a weapon kind's shot (e.g. a point-defence turret's, which fires no projectile), or `fallback` */
export function shotSoundForKind(kind: string, turret: boolean, fallback: string): string {
  const s = KIND_SFX.get(kind);
  return (turret && s?.turret) || s?.sfx || fallback;
}
