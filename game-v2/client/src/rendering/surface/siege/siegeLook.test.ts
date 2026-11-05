import { describe, expect, it } from 'vitest';
import rules from '../../../../../data/rules.json';
import systems from '../../../../../data/systems.json';
import { ROLE_LOOKS, PLAIN_LOOK, BOSS_LOOK, TURRET_LOOKS, beaconPhase, coreGlow, dayLanes, frontLanes, hostileLook, padLamp, type Approach } from './siegeLook';

const S = (rules as unknown as { sieges: { profiles: Record<string, { approach: Approach; roster: { role?: string }[] }>; turrets: Record<string, unknown> } }).sieges;

describe('siege looks', () => {
  it('has a night mark for every role a roster uses', () => {
    for (const [id, p] of Object.entries(S.profiles)) for (const u of p.roster) if (u.role) expect(ROLE_LOOKS[u.role], `${id} ${u.role}`).toBeTruthy();
  });

  it('has a colour for every turret kind', () => {
    for (const kind of Object.keys(S.turrets)) expect(TURRET_LOOKS[kind], kind).toBeTypeOf('number');
  });

  it('names only siege profiles the bastions use, and each has its approach', () => {
    const list = (systems as { systems: { surface?: { bastion?: { profile?: string } } }[] }).systems;
    for (const s of list) {
      const id = s.surface?.bastion?.profile;
      if (id) expect(S.profiles[id]?.approach, id).toBeTruthy();
    }
  });

  it('draws lanes by day where a moon has set ones', () => {
    expect(dayLanes(S.profiles.selene.approach).map((l) => Math.round((l.angle * 180) / Math.PI))).toEqual([-90, 30, 150]);
    expect(dayLanes(S.profiles.rimeholt.approach)).toHaveLength(1);
    expect(dayLanes({ kind: 'ring', radius: 0.4 })).toEqual([]);
    expect(dayLanes({ kind: 'pincer', radius: 0.4 })).toEqual([]);
    expect(dayLanes(undefined)).toEqual([]);
  });

  it('gives fronts close together one lane at night', () => {
    const f = (a: number) => ({ x: Math.cos(a) * 7000, y: Math.sin(a) * 7000, at: 100, ships: 3 });
    expect(frontLanes([f(0), f(0.05), f(Math.PI)], 0, 0)).toHaveLength(2);
    expect(frontLanes(undefined, 0, 0)).toEqual([]);
  });

  it('lights pads and the core by hull', () => {
    expect(padLamp(100)).toBe(0x4ade80);
    expect(padLamp(50)).toBe(0xfbbf24);
    expect(padLamp(10)).toBe(0xef4444);
    expect(coreGlow(100, false)).toBe(0x7dd3fc);
    expect(coreGlow(80, true)).toBe(0xef4444);
  });

  it('marks hostiles by tonight\'s roles and boss', () => {
    const tonight = { night: 4, boss: 'Scrap Mother', newKinds: [], roles: [{ id: 'sapper', name: 'Sapper', ship: 'Scrap Crawler', note: '' }] };
    expect(hostileLook('Scrap Crawler', tonight).color).toBe(ROLE_LOOKS.sapper.color);
    expect(hostileLook('Scrap Mother', tonight)).toMatchObject({ glyph: BOSS_LOOK.glyph, boss: true });
    expect(hostileLook('Pirate Skiff', tonight).glyph).toBe(PLAIN_LOOK.glyph);
    expect(hostileLook(undefined, undefined).glyph).toBe(PLAIN_LOOK.glyph);
  });

  it('shows a front\'s beacon only in its last stretch', () => {
    expect(beaconPhase(1000, 0, 600)).toBe(-1);
    expect(beaconPhase(1000, 700, 600)).toBeCloseTo(0.5);
    expect(beaconPhase(1000, 1000, 600)).toBe(-1);
  });
});
