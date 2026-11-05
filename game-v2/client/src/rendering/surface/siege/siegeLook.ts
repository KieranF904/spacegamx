/**
 * How a moon siege looks on the ground (pure: no Pixi, tested in
 * siegeLook.test.ts): each enemy role's marker colour and glyph, each turret
 * kind's colour, a pad's lamps by its turret's hull, the bastion core's glow,
 * and the approach lanes a moon's nights come down (its profile's `approach`
 * in data/rules.json). A new role or turret kind is an entry here.
 */

import type { ServerSiegeStateMessage } from '@space-game/common';

/** The glyph drawn in a hostile's night marker (SiegeMarks draws each) */
export type Glyph = 'dot' | 'diamond' | 'chevron' | 'cross' | 'shield' | 'crown';

/** Each enemy role's marker: sappers go for turrets, runners dive the bastion, artillery shells from range, escorts guard the big ones */
export const ROLE_LOOKS: Record<string, { color: number; glyph: Glyph }> = {
  sapper: { color: 0xfb923c, glyph: 'diamond' },
  runner: { color: 0xfacc15, glyph: 'chevron' },
  artillery: { color: 0xe879f9, glyph: 'cross' },
  escort: { color: 0x60a5fa, glyph: 'shield' },
};
/** A hostile with no role, and the night's boss */
export const PLAIN_LOOK = { color: 0xf87171, glyph: 'dot' as Glyph };
export const BOSS_LOOK = { color: 0xff3b3b, glyph: 'crown' as Glyph };

/** Each turret kind's colour (its emplacement's stripe, its reach ring) */
export const TURRET_LOOKS: Record<string, number> = {
  cannon: 0xfbbf24,
  flak: 0xfb923c,
  laser: 0x67e8f9,
  missile: 0xc084fc,
};
export const TURRET_DEFAULT = 0x7dd3fc;

export const PAD_EMPTY = 0x7dd3fc;
/** A pad's lamps by its turret's hull (%): green, amber under two thirds, red under a third */
export function padLamp(hull: number): number {
  return hull >= 66 ? 0x4ade80 : hull >= 33 ? 0xfbbf24 : 0xef4444;
}

/** The bastion core's glow by its hull (%), red in the last stand */
export function coreGlow(hull: number, breach: boolean): number {
  if (breach || hull < 30) return 0xef4444;
  return hull >= 66 ? 0x7dd3fc : 0xfbbf24;
}

/** A hostile's look: the boss's, its role's (tonight's roles name the ships that play each), or plain */
export function hostileLook(name: string | undefined, tonight: ServerSiegeStateMessage['tonight'] | undefined): { color: number; glyph: Glyph; boss: boolean } {
  if (name && tonight?.boss && name === tonight.boss) return { ...BOSS_LOOK, boss: true };
  const role = name ? tonight?.roles.find((r) => r.ship === name)?.id : undefined;
  const look = (role && ROLE_LOOKS[role]) || PLAIN_LOOK;
  return { ...look, boss: false };
}

export interface Approach { kind: string; angles?: number[]; spread?: number; radius: number }

/**
 * The lanes to draw on the ground by day: the bearings (radians, from the
 * bastion) the moon's nights come down, each with its spread. A ring or a
 * pincer comes from a side picked each night, so it has none by day.
 */
export function dayLanes(a: Approach | undefined): { angle: number; spread: number }[] {
  if (!a) return [];
  const D = Math.PI / 180;
  if (a.kind === 'lanes') return (a.angles?.length ? a.angles : [0]).map((d) => ({ angle: d * D, spread: (a.spread ?? 10) * D }));
  if (a.kind === 'arc' && a.angles?.length) return [{ angle: a.angles[0] * D, spread: (a.spread ?? 40) * D }];
  return [];
}

/** At night: a lane down each front's bearing (fronts close together share one), nearest first */
export function frontLanes(incoming: ServerSiegeStateMessage['incoming'], bx: number, by: number): { angle: number; spread: number }[] {
  const out: { angle: number; spread: number }[] = [];
  for (const f of incoming ?? []) {
    const a = Math.atan2(f.y - by, f.x - bx);
    if (out.some((o) => Math.abs(Math.atan2(Math.sin(a - o.angle), Math.cos(a - o.angle))) < 0.12)) continue;
    out.push({ angle: a, spread: 0.06 });
  }
  return out;
}

/** How far a front's beacon has come (0 just planned .. 1 landing), over its last `warn` ticks; -1 not showing yet or landed */
export function beaconPhase(at: number, now: number, warn: number): number {
  if (now >= at || at - now > warn) return -1;
  return 1 - (at - now) / warn;
}
