/**
 * Gun decor that moves with the gun's state (rework-2026-11 section 4, kinetic weapons): a barrel glowing red while it
 * reloads, vents off a housing, a clip's eject, a minigun's spinning cluster, a rifle's six rail lights.
 *
 * The state is the ship's own (ship.rounds / reload / spin, exact for your guns). Another ship's guns do not step those
 * here, so theirs show the resting look: full lights, no reload glow; a spinning cluster follows how hard the gun is
 * being fired (its barrel heat).
 *
 * Pure helpers; ShipRenderer draws them.
 */

export interface GunAnimSpec {
  /** The barrel glows this colour while the gun reloads (a dull red for the Twinlink and Bastion) */
  reloadGlow?: number;
  /** Smoke or sparks off the housing while it reloads: a puff every `every` frames */
  vent?: { kind: 'smoke' | 'spark'; color: number; every: number };
  /** A spray of sparks as a clip runs dry (a spent magazine's eject) */
  eject?: number;
  /** A spinning barrel cluster drawn from the gun's spin */
  spin?: boolean;
  /** This many pips along the barrel for the rounds left; they refill one by one on a reload */
  lights?: { n: number; color: number };
}

export const GUN_ANIM: Record<string, GunAnimSpec> = {
  cannon_twinlink: { reloadGlow: 0xb8321c },
  cannon_bastion: { reloadGlow: 0xc4381c, vent: { kind: 'smoke', color: 0x8a8078, every: 11 } },
  autocannon_chainsaw: { spin: true },
  autocannon_stinger: { eject: 0xffe08a },
  railgun_rail_driver: { lights: { n: 6, color: 0x6fe4ff }, vent: { kind: 'spark', color: 0x8fe8ff, every: 7 } },
};

export const animOf = (fn: string): GunAnimSpec | undefined => GUN_ANIM[fn];

/**
 * How many rail lights are lit (fractional: the one filling is dim): the rounds in the clip, or while it reloads the
 * share of the reload done so far, one light after another.
 */
export function lightsLit(n: number, rounds: number, reloadLeft: number, reload: number): number {
  if (reloadLeft > 0 && reload > 0) return Math.max(0, Math.min(n, (1 - reloadLeft / reload) * n));
  return Math.max(0, Math.min(n, rounds));
}

/** The reload's share still to go (1 just started .. 0 done), for a glow that fades as the clip is seated */
export function reloadShare(reloadLeft: number, reload: number): number {
  return reloadLeft > 0 && reload > 0 ? Math.min(1, reloadLeft / reload) : 0;
}
