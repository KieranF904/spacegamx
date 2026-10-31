import { describe, expect, it } from 'vitest';
import type { StarSystemData } from '@space-game/common';
import systemsData from '../../../data/systems.json';
import { LOGIN_WEIGHTS, pickLoginBody, solBodies } from './loginBody';

const sol = (systemsData as { systems: StarSystemData[] }).systems.find((s) => s.id === 'sol');

describe('the sign-in screen body', () => {
  it("lists Sol's sun, planets and moons", () => {
    const ids = solBodies(sol);
    expect(ids[0]).toBe('sun');
    expect(ids).toContain('jovan');
    expect(ids).toContain('terra_nova.moon0');
    for (const id of Object.keys(LOGIN_WEIGHTS)) expect(ids, id).toContain(id);
  });

  it('never shows the same body twice running, and still shows the sun now and then', () => {
    const ids = solBodies(sol);
    let seed = 1;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    let last: string | null = null, suns = 0;
    const N = 6000;
    for (let i = 0; i < N; i++) {
      const id = pickLoginBody(ids, last, rnd);
      expect(id).not.toBe(last);
      if (id === 'sun') suns++;
      last = id;
    }
    expect(suns / N).toBeGreaterThan(0.1);
    expect(suns / N).toBeLessThan(0.3);
  });
});
