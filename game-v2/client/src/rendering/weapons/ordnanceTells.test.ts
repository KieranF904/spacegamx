import { describe, expect, it } from 'vitest';
import { weaponStyle } from './weaponStyles';
import { WeaponType } from '@space-game/common';
import { arcFraction, edgePoint, incomingTicks, landingPoint, sonarPeriod } from './ordnanceTells';

describe('ordnance tells', () => {
  it('finds where a shell lands from its velocity and end tick', () => {
    const p = { x: 0, y: 0 };
    landingPoint(100, 50, 10, -2, 1000, 1030, p);
    expect(p).toEqual({ x: 400, y: -10 });
  });

  it('a shell ring tightens from 0 to 1 over the flight', () => {
    expect(arcFraction(1000, 1000, 1060)).toBe(0);
    expect(arcFraction(1030, 1000, 1060)).toBeCloseTo(0.5, 5);
    expect(arcFraction(1100, 1000, 1060)).toBe(1);
    expect(arcFraction(1030, 1000, 0)).toBe(0);
  });

  it('the sonar quickens as the torpedo closes', () => {
    expect(sonarPeriod(30, 2000, 800)).toBe(30);
    expect(sonarPeriod(30, 400, 800)).toBeLessThan(30);
    expect(sonarPeriod(30, 0, 800)).toBeCloseTo(9, 5);
    expect(sonarPeriod(30, 100, 0)).toBe(30);
  });

  it('warns only for a shell heading at you', () => {
    // flying along +x at 10 a tick from the origin; the pilot is 1000 ahead and 100 off the line
    expect(incomingTicks(1000, 100, 0, 0, 10, 0, 300, 900)).toBeCloseTo(100, 5);
    expect(incomingTicks(1000, 600, 0, 0, 10, 0, 300, 900)).toBe(-1); // too far off the line
    expect(incomingTicks(-500, 0, 0, 0, 10, 0, 300, 900)).toBe(-1); // already past
    expect(incomingTicks(20000, 0, 0, 0, 10, 0, 300, 900)).toBe(-1); // too far to matter yet
    expect(incomingTicks(10, 0, 0, 0, 0, 0, 300, 900)).toBe(-1); // not moving
  });

  it('puts the arrow on the screen edge toward the shell', () => {
    const o = { x: 0, y: 0 };
    expect(edgePoint(1, 0, 800, 600, 20, o)).toBe(true);
    expect(o).toEqual({ x: 780, y: 300 });
    edgePoint(0, -3, 800, 600, 20, o);
    expect(o).toEqual({ x: 400, y: 20 });
    edgePoint(1, 1, 800, 600, 0, o);
    expect(o).toEqual({ x: 700, y: 600 });
    expect(edgePoint(0, 0, 800, 600, 20, o)).toBe(false);
  });
});

describe('ordnance model styles', () => {
  it('the seven models carry the section 4 signatures', () => {
    const s = (id: string, t: number) => weaponStyle(t, 1, id);
    expect(s('mortar_lobber', WeaponType.Mortar).lob).toBeGreaterThan(0);
    expect(s('mortar_lobber', WeaponType.Mortar).landBurst).toBeDefined();
    expect(s('mortar_quake', WeaponType.Mortar).landBurst?.shake).toBeGreaterThan(0);
    expect(s('missile_swarm', WeaponType.Missile).wobble).toBeDefined();
    expect(s('missile_hammerhead', WeaponType.Missile).nose?.blink).toBe(true);
    expect(s('missile_hammerhead', WeaponType.Missile).guide).toBe(true);
    expect(s('torpedo_eel', WeaponType.Torpedo).ringPulse?.closing).toBeGreaterThan(0);
    expect(s('torpedo_leviathan', WeaponType.Torpedo).nose?.blink).toBeFalsy();
    expect(s('torpedo_leviathan', WeaponType.Torpedo).incoming?.radius).toBeGreaterThan(0);
    // the Dart keeps today's missile look
    expect(s('missile_dart', WeaponType.Missile)).toBe(weaponStyle(WeaponType.Missile));
  });
});
