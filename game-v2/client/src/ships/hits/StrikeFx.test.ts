/**
 * Where a shell is seen to strike rock (StrikeFx.struck): a hit that cannot mine shows plain sparks, and only your own
 * working hits tick and add progress.
 */
import { describe, expect, it } from 'vitest';
import { EntityType, EffectType, WEAPON_KIND_TYPE } from '@space-game/common';
import { StrikeFx, type StrikeFxHost } from './StrikeFx';
import { setTrainingBody, clearTrainingBodies } from '../../state/trainingBodies';

const ME = 1, ROCK = 50;

function rig(hardness: number) {
  const log: string[] = [];
  const rock = { id: ROCK, type: EntityType.Asteroid, renderX: 0, renderY: 0, composition: { hardness } };
  const host = {
    state: { playerId: ME, systemId: 'x', entities: new Map<number, unknown>([[ROCK, rock]]) },
    store: { get: () => undefined, tuning: {} },
    scene: () => ({ miningStrike: () => log.push('strike'), showEffect: (t: number) => log.push(t === EffectType.LaserHit ? 'sparks' : 'effect') }),
    damageFx: () => null,
    shellModel: () => undefined,
    sound: (id: string) => { log.push('sound:' + id); return null; },
  } as unknown as StrikeFxHost;
  const fx = new StrikeFx(host);
  const progress: unknown[][] = [];
  fx.miningProgress = { shell: (...a: unknown[]) => { progress.push(a); }, dropped: () => {} } as never;
  return { fx, log, progress };
}

describe('a hit that cannot mine shows plain sparks', () => {
  it('a gun with no yield, a rock too hard for the gun, and a training drone all show sparks, never a mining strike', () => {
    const t = (kind: string) => WEAPON_KIND_TYPE[kind];
    const emp = rig(1);
    emp.fx.struck(1, 0, 0, t('emp'), ROCK, ME);
    expect(emp.log).toEqual(['sparks']);
    const hard = rig(3);
    hard.fx.struck(1, 0, 0, t('autocannon'), ROCK, ME);
    expect(hard.log).toEqual(['sparks']);
    const drone = rig(1);
    setTrainingBody(ROCK, 'drone');
    try { drone.fx.struck(1, 0, 0, t('autocannon'), ROCK, ME); } finally { clearTrainingBodies(); }
    expect(drone.log).toEqual(['sparks']);
    expect(emp.progress.length + hard.progress.length + drone.progress.length).toBe(0);
  });
});

describe('only your own working hits tick and add progress', () => {
  it('a mining hit of yours adds progress and ticks; another pilot\'s only strikes the rock', () => {
    const t = WEAPON_KIND_TYPE.autocannon;
    const mine = rig(1);
    mine.fx.struck(1, 0, 0, t, ROCK, ME);
    expect(mine.log).toContain('strike');
    expect(mine.log).toContain('sound:mine_tick');
    expect(mine.progress.length).toBe(1);
    const theirs = rig(1);
    theirs.fx.struck(1, 0, 0, t, ROCK, 99);
    expect(theirs.log).toEqual(['strike']);
    expect(theirs.progress.length).toBe(0);
  });
});
