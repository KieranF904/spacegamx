/**
 * Which sound each weapon makes, all from data. Every weapon model is heard as its own: a model's `sfx` / `sfxTurret`
 * / `sfxLoop` (data/ships/models.json, written by scripts/econ/models.mjs MODEL_SOUND), falling back on its kind's
 * (data/ships/functions.json), and for projectile kinds no part fires (bosses' own: rivets, seekers...) data/audio.json
 * `shots`. A shell carries only its kind on the wire (WEAPON_KIND_TYPE, data[0]); the client knows the gun behind it
 * from its fire event (ShipClient.shellInfo), so the model costs no bytes. partPresentation.test checks they agree.
 */

import { WEAPON_KIND_TYPE } from '@space-game/common';
import { SHIP_FUNCTIONS } from '../ships/shipFunctionData';
import audioData from '../../../data/audio.json';

export interface ShotSound { sfx: string; turret?: string }

/** data/audio.json `shots`: weapon kind → its shot sound ('' for silent) */
export const KIND_SHOTS = (audioData as unknown as { shots: Record<string, string | ShotSound> }).shots;

/** Augmented shells' model ids carry this suffix (weaponStyles AUG) */
const AUG_SUFFIX = '+aug';

/** Weapon kind → its shot sound, plain and from a turret: the kind's own function first, else its first model's */
export const KIND_SFX = new Map<string, ShotSound>();
/** Model (or legacy function) id → its own shot sound */
export const MODEL_SFX = new Map<string, ShotSound>();
/** Held-beam weapon kind → the loop that plays while it fires (its function's, else its first model's) */
export const BEAM_LOOP = new Map<string, string>();
/** Held-beam model id → its loop */
export const MODEL_LOOP = new Map<string, string>();
// (Functions before models: the kind's sound is its function's, a model's only where the kind has no function)
const ordered = [...SHIP_FUNCTIONS.filter((f) => !f.model), ...SHIP_FUNCTIONS.filter((f) => f.model)];
for (const f of ordered) {
  if (!f.weapon) continue;
  if (f.sfx) {
    const s = { sfx: f.sfx, turret: f.sfxTurret };
    MODEL_SFX.set(f.id, s);
    if (!KIND_SFX.has(f.weapon)) KIND_SFX.set(f.weapon, s);
  }
  if (f.sfxLoop) {
    MODEL_LOOP.set(f.id, f.sfxLoop);
    if (!BEAM_LOOP.has(f.weapon)) BEAM_LOOP.set(f.weapon, f.sfxLoop);
  }
}
for (const [kind, s] of Object.entries(KIND_SHOTS)) if (!kind.startsWith('_')) KIND_SFX.set(kind, typeof s === 'string' ? { sfx: s } : s);

/** Projectile type (WEAPON_KIND_TYPE) → its kind's shot sound */
const BY_TYPE = new Map<number, ShotSound>();
for (const [kind, s] of KIND_SFX) if (WEAPON_KIND_TYPE[kind] !== undefined) BY_TYPE.set(WEAPON_KIND_TYPE[kind], s);

/** A model id as a shell's look carries it (an augmented shot's has a suffix) */
export function baseModel(model: string | undefined): string | undefined {
  return model?.endsWith(AUG_SUFFIX) ? model.slice(0, -AUG_SUFFIX.length) : model;
}

/** The sound of a shot of projectile type `type`, from a turret or not ('' for none) */
export function shotSoundForType(type: number, turret: boolean): string {
  const s = BY_TYPE.get(type);
  if (!s) return turret ? 'turret_shot' : 'shot';
  return turret && s.turret ? s.turret : s.sfx;
}

/** The sound of a shot from the gun model `model` (when the client knows it), else its projectile type's */
export function shotSoundFor(model: string | undefined, type: number, turret: boolean): string {
  const s = model ? MODEL_SFX.get(baseModel(model)!) : undefined;
  if (s) return turret && s.turret ? s.turret : s.sfx;
  return shotSoundForType(type, turret);
}

/** Does this model have a shot sound of its own (not its kind's): its kind's grade pitch nudge is then not wanted */
export function hasOwnShotSound(model: string | undefined): boolean {
  return !!model && MODEL_SFX.has(baseModel(model)!);
}

/** The sound of a weapon kind's shot (e.g. a point-defence turret's, which fires no projectile), or `fallback` */
export function shotSoundForKind(kind: string, turret: boolean, fallback: string): string {
  const s = KIND_SFX.get(kind);
  return (turret && s?.turret) || s?.sfx || fallback;
}

/** A held beam's loop: its model's, else its kind's (undefined: none) */
export function beamLoopFor(model: string | undefined, kind: string): string | undefined {
  return (model && MODEL_LOOP.get(baseModel(model)!)) || BEAM_LOOP.get(kind);
}

/** A held beam's one-shot as it lights (its model's `sfx`, e.g. the Lance's ignition), '' for none */
export function beamLightSound(model: string | undefined): string {
  return (model && MODEL_LOOP.has(baseModel(model)!) && MODEL_SFX.get(baseModel(model)!)?.sfx) || '';
}

/** Every loop a held beam can play */
export const ALL_BEAM_LOOPS = [...new Set([...BEAM_LOOP.values(), ...MODEL_LOOP.values()])];
